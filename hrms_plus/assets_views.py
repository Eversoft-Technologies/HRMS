"""HTTP API of the IT asset register (routes: hrms_plus/urls_assets.py, under /api/).

Permissions
    assets.view     register, detail, licences, expiring, CSV export
    assets.manage   create / edit / delete, assign, return, lost, repair, retire, write-off, import
    onboarding.assets   may also use the in-stock picker (GET assets/stock)
    payroll.fnf.manage  sees a leaver's assets on the separation and may record
                        their return / loss (those clear F&F items, so they need a
                        fresh sign-in like every other F&F change)
    any signed-in user  their own assets: list, acknowledge, report an issue
"""
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.payroll_ext import security

from . import assets as svc
from . import assets_links as links
from .models import Asset, AssetAssignment

VIEW, MANAGE, FNF, ONB = 'assets.view', 'assets.manage', 'payroll.fnf.manage', 'onboarding.assets'


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _fail(e):
    return _err(str(e), getattr(e, 'status', 400), getattr(e, 'code', None))


def _asset(pk):
    return Asset.objects.filter(id=pk).first()


# ── register ──────────────────────────────────────────────────────────────
@api_view(['GET'])
def meta(request):
    email, user, denied = security.require(request, (VIEW, MANAGE))
    if denied:
        return denied
    svc.lazy_alerts()
    return Response({
        'categories': [{'value': c, 'label': svc.CATEGORY_LABELS.get(c, c)} for c in svc.CATEGORIES],
        'statuses': svc.STATUSES, 'conditions': svc.CONDITIONS, 'ownership': svc.OWNERSHIP,
        'transitions': {k: sorted(v) for k, v in svc.TRANSITIONS.items()},
        'canManage': security.has_perm(user, MANAGE), 'kpis': svc.kpis(), 'alertDays': svc.ALERT_DAYS,
    })


def _filtered(request):
    p = request.GET
    qs = Asset.objects.all()
    if p.get('category'):
        qs = qs.filter(category=p['category'])
    st = (p.get('status') or '').strip()
    if st == 'active':
        qs = qs.exclude(status='retired')
    elif st:
        qs = qs.filter(status=st)
    if p.get('ownership'):
        qs = qs.filter(ownership=p['ownership'])
    q = (p.get('q') or '').strip()
    if q:
        held = AssetAssignment.objects.filter(status='active', email__icontains=q).values_list('asset_id', flat=True)
        qs = qs.filter(Q(asset_tag__icontains=q) | Q(name__icontains=q) | Q(serial_number__icontains=q) |
                       Q(make__icontains=q) | Q(model__icontains=q) | Q(vendor__icontains=q) |
                       Q(location__icontains=q) | Q(id__in=list(held)))
    if p.get('holder'):
        qs = qs.filter(id__in=AssetAssignment.objects.filter(status='active', email__iexact=p['holder'])
                       .values_list('asset_id', flat=True))
    if str(p.get('unacknowledged') or '') in ('1', 'true'):
        qs = qs.filter(id__in=AssetAssignment.objects.filter(status='active', acknowledged_at__isnull=True)
                       .values_list('asset_id', flat=True))
    return qs.order_by('asset_tag')


@api_view(['GET', 'POST'])
def assets(request):
    if request.method == 'GET':
        email, user, denied = security.require(request, (VIEW, MANAGE))
        if denied:
            return denied
        qs = _filtered(request)
        total = qs.count()
        return Response({'assets': svc.serialize_many(qs[:1000]), 'total': total})
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    try:
        with transaction.atomic():
            a, warnings = svc.create_asset(request.data or {}, email)
    except svc.AssetError as e:
        return _fail(e)
    out = svc.asset_dict(a, full=True)
    out['warnings'] = warnings
    return Response(out, status=201)


@api_view(['GET', 'PATCH', 'DELETE'])
def asset_detail(request, pk):
    if request.method == 'GET':
        email, user, denied = security.require(request, (VIEW, MANAGE))
        if denied:
            return denied
        a = _asset(pk)
        return Response(svc.asset_dict(a, full=True)) if a else _err('Not found', 404)
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    a = _asset(pk)
    if not a:
        return _err('Not found', 404)
    try:
        with transaction.atomic():
            if request.method == 'DELETE':
                svc.delete_asset(a, email)
                return Response({'ok': True})
            a, warnings = svc.update_asset(a, request.data or {}, email)
    except svc.AssetError as e:
        return _fail(e)
    out = svc.asset_dict(a, full=True)
    out['warnings'] = warnings
    return Response(out)


@api_view(['POST'])
def asset_assign(request, pk):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    a = _asset(pk)
    if not a:
        return _err('Not found', 404)
    b = request.data or {}
    target = svc.norm_email(b.get('email'))
    from api.models import AppUser
    if not AppUser.objects.filter(email__iexact=target, status='active').exists():
        return _err('Choose an active employee.')
    try:
        asg = svc.assign(a, target, email, expected_return=b.get('expectedReturn'), note=b.get('note'))
        # A leaver who is handed something mid-exit gets it on their checklist too.
        from api.models import Separation
        sep = Separation.objects.filter(email__iexact=target).exclude(status__in=links.LOCKED_SEPARATION).first()
        if sep:
            with transaction.atomic():
                links.link_separation(sep, email)
    except svc.AssetError as e:
        return _fail(e)
    return Response({'assignment': svc.assignment_dict(asg), 'asset': svc.asset_dict(_asset(pk), full=True)},
                    status=201)


@api_view(['POST'])
def asset_status(request, pk):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    a = _asset(pk)
    if not a:
        return _err('Not found', 404)
    b = request.data or {}
    try:
        with transaction.atomic():
            svc.change_status(a, b.get('status'), email, note=svc.clean(b.get('note'), 1000))
    except svc.AssetError as e:
        return _fail(e)
    return Response(svc.asset_dict(_asset(pk), full=True))


@api_view(['POST'])
def asset_write_off(request, pk):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    a = _asset(pk)
    if not a:
        return _err('Not found', 404)
    b = request.data or {}
    if a.assignments.filter(status__in=('active', 'lost'), separation_id__isnull=False).exists():
        email, user, denied = security.require(request, MANAGE, fresh=True)
        if denied:
            return denied
    try:
        with transaction.atomic():
            svc.write_off(a, email, recovery=b.get('recoveryAmount'), note=svc.clean(b.get('note'), 1000))
    except svc.AssetError as e:
        return _fail(e)
    return Response(svc.asset_dict(_asset(pk), full=True))


def _assignment_guard(request, pk):
    """(email, assignment, error). assets.manage, or payroll.fnf.manage for an
    assignment that is on a separation; F&F-linked changes need a fresh sign-in."""
    asg = AssetAssignment.objects.filter(id=pk).select_related('asset').first()
    email, user, denied = security.require(request, (MANAGE, FNF))
    if denied:
        return None, None, denied
    if not asg:
        return None, None, _err('Not found', 404)
    if not security.has_perm(user, MANAGE) and not asg.separation_id:
        return None, None, _err("You don't have permission to do this. Required: " + MANAGE, 403, 'PERMISSION_DENIED')
    if asg.separation_id:
        if svc.norm_email(asg.email) == email:
            return None, None, _err('You cannot clear your own exit items.', 403, 'SELF_APPROVAL')
        email, user, denied = security.require(request, (MANAGE, FNF), fresh=True)
        if denied:
            return None, None, denied
    return email, asg, None


@api_view(['POST'])
def assignment_return(request, pk):
    email, asg, denied = _assignment_guard(request, pk)
    if denied:
        return denied
    b = request.data or {}
    try:
        asg = svc.return_asset(asg, email, condition=b.get('condition') or 'good',
                               received_by=svc.norm_email(b.get('receivedBy')) or email,
                               note=svc.clean(b.get('note'), 1000), to_repair=bool(b.get('toRepair')),
                               recovery=b.get('recoveryAmount'))
    except svc.AssetError as e:
        return _fail(e)
    return Response({'assignment': svc.assignment_dict(asg), 'asset': svc.asset_dict(_asset(asg.asset_id), full=True)})


@api_view(['POST'])
def assignment_lost(request, pk):
    email, asg, denied = _assignment_guard(request, pk)
    if denied:
        return denied
    b = request.data or {}
    try:
        asg = svc.mark_lost(asg, email, recovery=b.get('recoveryAmount'), note=svc.clean(b.get('note'), 1000))
    except svc.AssetError as e:
        return _fail(e)
    return Response({'assignment': svc.assignment_dict(asg), 'asset': svc.asset_dict(_asset(asg.asset_id), full=True)})


# ── lists ─────────────────────────────────────────────────────────────────
@api_view(['GET'])
def licenses(request):
    email, user, denied = security.require(request, (VIEW, MANAGE))
    if denied:
        return denied
    return Response({'licenses': svc.license_usage()})


@api_view(['GET'])
def expiring(request):
    email, user, denied = security.require(request, (VIEW, MANAGE))
    if denied:
        return denied
    try:
        days = max(1, min(365, int(request.GET.get('days') or svc.ALERT_DAYS)))
    except ValueError:
        days = svc.ALERT_DAYS
    return Response({'items': svc.expiring(days), 'days': days})


@api_view(['GET'])
def stock(request):
    """In-stock picker (onboarding allocation, assign modal)."""
    email, user, denied = security.require(request, (MANAGE, ONB))
    if denied:
        return denied
    q = (request.GET.get('q') or '').strip()
    qs = Asset.objects.filter(Q(status='in_stock') | Q(category='license', status='assigned'))
    if request.GET.get('category'):
        qs = qs.filter(category=request.GET['category'])
    if q:
        qs = qs.filter(Q(asset_tag__icontains=q) | Q(name__icontains=q) | Q(serial_number__icontains=q) |
                       Q(make__icontains=q) | Q(model__icontains=q))
    rows = []
    for a in qs.order_by('category', 'asset_tag')[:200]:
        if svc.is_license(a) and svc.seats_used(a) >= (a.license_seats or 1):
            continue
        rows.append({'id': a.id, 'assetTag': a.asset_tag, 'label': svc.label_of(a), 'category': a.category,
                     'serialNumber': a.serial_number, 'ownership': a.ownership, 'clientName': a.client_name,
                     'condition': a.condition})
    return Response({'assets': rows[:50]})


@api_view(['GET'])
def people(request):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    from api.models import AppUser
    q = (request.GET.get('q') or '').strip()
    qs = AppUser.objects.filter(status='active')
    if q:
        qs = qs.filter(Q(email__icontains=q) | Q(full_name__icontains=q))
    return Response({'people': [{'email': svc.norm_email(u.email), 'name': u.full_name or u.email}
                                for u in qs.order_by('full_name', 'email')[:30]]})


# ── CSV ───────────────────────────────────────────────────────────────────
@api_view(['GET'])
def export_csv(request):
    email, user, denied = security.require(request, (VIEW, MANAGE))
    if denied:
        return denied
    body = svc.export_csv(_filtered(request))
    resp = HttpResponse(body, content_type='text/csv; charset=utf-8')
    resp['Content-Disposition'] = f'attachment; filename="it-assets-{svc.today():%Y%m%d}.csv"'
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


@api_view(['POST'])
def import_csv(request):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    b = request.data or {}
    text = b.get('csv') or ''
    if len(text) > 2 * 1024 * 1024:
        return _err('The file is larger than 2 MB.')
    try:
        return Response(svc.import_csv(text, email, dry_run=bool(b.get('dryRun', True))))
    except svc.AssetError as e:
        return _fail(e)


@api_view(['POST'])
def run_alerts(request):
    email, user, denied = security.require(request, MANAGE)
    if denied:
        return denied
    with transaction.atomic():
        return Response(svc.run_alerts())


# ── the employee's own assets ─────────────────────────────────────────────
@api_view(['GET'])
def my_assets(request):
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    rows = []
    qs = AssetAssignment.objects.filter(email__iexact=email).select_related('asset').order_by('-assigned_at')
    for asg in qs[:100]:
        if asg.status != 'active' and asg.returned_at and asg.returned_at < svc.local_now() - timedelta(days=365):
            continue
        a = asg.asset
        d = svc.assignment_dict(asg)
        d['asset'] = {'id': a.id, 'assetTag': a.asset_tag, 'label': svc.label_of(a), 'category': a.category,
                      'make': a.make, 'model': a.model, 'serialNumber': a.serial_number,
                      'warrantyUntil': svc._iso(a.warranty_until), 'licenseExpiry': svc._iso(a.license_expiry),
                      'condition': a.condition}
        rows.append(d)
    return Response({'assignments': rows})


@api_view(['POST'])
def my_acknowledge(request, pk):
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    asg = AssetAssignment.objects.filter(id=pk).select_related('asset').first()
    if not asg:
        return _err('Not found', 404)
    try:
        svc.acknowledge(asg, email)
    except svc.AssetError as e:
        return _fail(e)
    return Response(svc.assignment_dict(asg))


@api_view(['POST'])
def my_report(request, pk):
    """Report a problem with an asset you hold → an IT help-desk ticket."""
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    asg = AssetAssignment.objects.filter(id=pk, status='active').select_related('asset').first()
    if not asg or svc.norm_email(asg.email) != email:
        return _err('Not found', 404)
    b = request.data or {}
    desc = svc.clean(b.get('description'), 4000)
    if len(desc) < 5:
        return _err('Describe the problem.')
    a = asg.asset
    priority = b.get('priority') if b.get('priority') in ('Low', 'Medium', 'High', 'Urgent') else 'Medium'
    subject = svc.clean(b.get('subject'), 120) or 'Problem with my ' + svc.label_of(a)
    details = (f'{desc}\n\nAsset: {svc.label_of(a)} — tag {a.asset_tag}'
               + (f', S/N {a.serial_number}' if a.serial_number else '') + f' (IT Assets #{a.id})')
    from types import SimpleNamespace
    from api import tickets
    resp = tickets._create(SimpleNamespace(data={'category': 'IT', 'priority': priority,
                                                 'subject': f'[{a.asset_tag}] {subject}'[:255],
                                                 'description': details}), email, user, False)
    if resp.status_code >= 400:
        return resp
    t = resp.data
    svc.event(a, 'issue_reported', email, email=email, note=desc[:500], ticketId=t.get('id'), ticketCode=t.get('code'))
    return Response({'ticket': {'id': t.get('id'), 'code': t.get('code'), 'status': t.get('status')}}, status=201)


# ── Full & Final ──────────────────────────────────────────────────────────
@api_view(['GET'])
def separation_assets(request, sid):
    email, user, denied = security.require(request, (FNF, VIEW, MANAGE))
    if denied:
        return denied
    from api.models import Separation
    sep = Separation.objects.filter(id=sid).first()
    if not sep:
        return _err('Not found', 404)
    with transaction.atomic():
        out = links.separation_assets(sep)
    out['canAct'] = security.has_perm(user, (MANAGE, FNF)) and svc.norm_email(sep.email) != email
    return Response(out)
