"""The IT asset register working as one unit with onboarding and Full & Final.

Onboarding (api.ItAssetAllocation, the "IT Asset Allocation" step)
------------------------------------------------------------------
* An allocation's ``asset_id`` holds the asset tag(s) HR picked from stock
  (comma separated; the onboarding screen fills it from the in-stock picker)
  or typed by hand. Each tag / serial is matched to an Asset; unknown ones are
  added to the register. Item types ticked on the allocation ("Laptop",
  "Monitor"…) that no tagged asset covers get a placeholder asset
  ``ONB<allocation id>-<TYPE>`` so nothing handed over is untracked.
  Accounts (Email_ID, Office365, Software License) are not hardware and are
  not mirrored.
* Each one becomes an AssetAssignment for the candidate's email with
  ``allocation_id``. Activation turns that same email into the employee login
  (onboarding_views.candidate_activate), so custody carries over unchanged.
* Allocation status Returned / Lost / Damaged closes the assignments; closing
  every assignment in the register sets the allocation status back.

Full & Final (api.Separation / api.ClearanceItem, api/payroll_ext/fnf.py)
------------------------------------------------------------------------
* Initiating a separation adds one IT clearance item per active assignment
  ("Return MacBook Pro 14 — tag EV-LAP-0042, S/N C02X…") and stamps the
  assignment's ``separation_id``. The pairing is recorded in an AssetEvent
  (kind ``separation_linked``, data.clearanceId) — no schema change needed.
* Recording the return clears that item; lost / damaged puts the recovery
  amount on it, which the F&F computation already sums.
* Clearing the item from the F&F checklist records the return in the register.
* Cancelling the separation unlinks the assignments.
"""
import logging
import re
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from . import assets as svc
from .models import Asset, AssetAssignment, AssetEvent

logger = logging.getLogger(__name__)

ITEM_CATEGORY = {
    'laptop': 'laptop', 'desktop': 'desktop', 'monitor': 'monitor', 'mobile': 'phone', 'phone': 'phone',
    'id_card': 'access_card', 'access card': 'access_card', 'mouse': 'peripheral', 'keyboard': 'peripheral',
    'dock': 'peripheral', 'bag': 'peripheral', 'headset': 'peripheral', 'tablet': 'tablet',
}
NOT_HARDWARE = {'office365', 'email_id', 'software license'}
LOCKED_SEPARATION = ('approved', 'paid', 'cancelled')


# ── onboarding ────────────────────────────────────────────────────────────
def split_tags(text):
    return [t for t in (x.strip() for x in re.split(r'[,;\n]+', str(text or ''))) if t][:20]


def find_asset(token):
    token = str(token or '').strip()
    if not token:
        return None
    a = Asset.objects.filter(asset_tag__iexact=token).first()
    if a:
        return a
    by_serial = list(Asset.objects.filter(serial_number__iexact=token)[:2])
    return by_serial[0] if len(by_serial) == 1 else None


def precheck_allocation(tags, email):
    """Message when a picked asset cannot go to this person, else None."""
    email = svc.norm_email(email)
    for tag in tags or []:
        a = find_asset(tag)
        if not a:
            continue                                     # unknown tags are added to the register
        if svc.is_license(a):
            if a.assignments.filter(status='active', email=email).exists():
                continue
            if svc.seats_used(a) >= (a.license_seats or 1):
                return f'All seats of {a.asset_tag} are in use.'
            continue
        holder = a.assignments.filter(status='active').first()
        if holder and svc.norm_email(holder.email) != email:
            return f'{a.asset_tag} is already assigned to {holder.email}.'
        if not holder and a.status != 'in_stock':
            return f'{a.asset_tag} is {a.status.replace("_", " ")} and cannot be allocated.'
    return None


def _category_for(item):
    return ITEM_CATEGORY.get(str(item or '').strip().lower(), 'other')


def _allocation_email(allocation):
    return svc.norm_email(getattr(allocation.candidate, 'email', ''))


def sync_allocation(allocation, actor, tags=None):
    """Create / link register assets and assignments for an onboarding
    allocation. Idempotent. Returns {'linked': [...tags], 'created': [...tags], 'skipped': [msg]}."""
    email = _allocation_email(allocation)
    out = {'linked': [], 'created': [], 'skipped': []}
    if not email:
        return out
    tokens = list(tags) if tags else split_tags(allocation.asset_id)
    client = (allocation.asset_source or '').lower() == 'client'
    linked = list(AssetAssignment.objects.filter(allocation_id=allocation.id).select_related('asset'))
    linked_ids = {x.asset_id for x in linked}
    covered = [x.asset.category for x in linked]
    issued = None
    if allocation.issued_date:
        from datetime import datetime, time
        issued = datetime.combine(allocation.issued_date, time(9, 0))
    items = [i for i in (allocation.assets or []) if str(i).strip().lower() not in NOT_HARDWARE]

    def take(asset, created):
        if asset.id in linked_ids:
            return
        holder = asset.assignments.filter(status='active').first() if not svc.is_license(asset) else None
        if holder and svc.norm_email(holder.email) != email:
            out['skipped'].append(f'{asset.asset_tag} is held by {holder.email}')
            return
        if holder:                                        # already with this person: adopt it
            holder.allocation_id = allocation.id
            holder.save(update_fields=['allocation_id'])
        elif svc.is_license(asset) and asset.assignments.filter(status='active', email=email).exists():
            asset.assignments.filter(status='active', email=email).update(allocation_id=allocation.id)
        else:
            if asset.status != 'in_stock' and not svc.is_license(asset):
                out['skipped'].append(f'{asset.asset_tag} is {asset.status}')
                return
            try:
                svc.assign(asset, email, actor, allocation_id=allocation.id, assigned_at=issued,
                           note=f'Onboarding allocation #{allocation.id}', notify=False)
            except svc.AssetError as e:
                out['skipped'].append(f'{asset.asset_tag}: {e}')
                return
        linked_ids.add(asset.id)
        covered.append(asset.category)
        (out['created'] if created else out['linked']).append(asset.asset_tag)

    for tok in tokens:
        a = find_asset(tok)
        created = False
        if not a:
            if not svc.TAG_RE.match(tok):
                out['skipped'].append(f'"{tok}" is not a valid asset tag')
                continue
            # A typed tag most likely belongs to the main device ticked (laptop
            # before mouse); the item it stands for then needs no placeholder.
            free = [i for i in items if _category_for(i) not in covered]
            main = [i for i in free if _category_for(i) not in ('peripheral', 'other')] or free
            item = main[0] if main else ''
            cat = _category_for(item) if item else 'other'
            a = Asset.objects.create(asset_tag=tok[:60], category=cat, name=str(item)[:200],
                                     ownership='client' if client else 'company',
                                     client_name=(allocation.client_name or '')[:200] if client else '',
                                     created_by=svc.norm_email(actor), status='in_stock',
                                     notes=f'Added from onboarding allocation #{allocation.id}')
            svc.event(a, 'created', actor, note='Added from onboarding allocation', allocationId=allocation.id)
            created = True
        take(a, created)

    # Ticked item types that no tagged asset covers → placeholders.
    remaining = list(covered)
    for item in items:
        cat = _category_for(item)
        if cat in remaining:
            remaining.remove(cat)
            continue
        tag = f'ONB{allocation.id}-{re.sub(r"[^A-Za-z0-9]+", "", str(item)).upper()[:20] or "ITEM"}'
        a = Asset.objects.filter(asset_tag__iexact=tag).first()
        created = False
        if not a:
            a = Asset.objects.create(asset_tag=tag, category=cat, name=str(item)[:200],
                                     ownership='client' if client else 'company',
                                     client_name=(allocation.client_name or '')[:200] if client else '',
                                     created_by=svc.norm_email(actor), status='in_stock',
                                     notes=f'Placeholder from onboarding allocation #{allocation.id}: '
                                           f'add the real tag / serial when known.')
            svc.event(a, 'created', actor, note='Placeholder from onboarding allocation', allocationId=allocation.id)
            created = True
        take(a, created)
    apply_allocation_status(allocation, actor)
    return out


def apply_allocation_status(allocation, actor):
    """Mirror an onboarding status (Returned / Lost / Damaged) onto the register."""
    st = (allocation.status or '').strip().lower()
    if st not in ('returned', 'lost', 'damaged'):
        return 0
    n = 0
    for asg in AssetAssignment.objects.filter(allocation_id=allocation.id, status='active').select_related('asset'):
        try:
            if st == 'lost' and not svc.is_license(asg.asset):
                svc.mark_lost(asg, actor, note='Marked lost in onboarding')
            else:
                svc.return_asset(asg, actor, condition='damaged' if st == 'damaged' else 'good',
                                 note=f'Marked {st} in onboarding')
            n += 1
        except svc.AssetError:
            continue
    return n


def on_allocation_deleted(allocation, actor):
    """The allocation was removed (entered by mistake): undo its custody."""
    for asg in AssetAssignment.objects.filter(allocation_id=allocation.id, status='active').select_related('asset'):
        try:
            svc.return_asset(asg, actor, condition=asg.asset.condition or 'good',
                             note='Onboarding allocation removed')
        except svc.AssetError:
            continue
    AssetAssignment.objects.filter(allocation_id=allocation.id).update(allocation_id=None)


def sync_allocation_status(asg):
    """When every assignment of an allocation is closed, set the allocation's
    own status so the onboarding screen tells the same story."""
    if not asg.allocation_id:
        return
    from api.models import ItAssetAllocation
    rows = list(AssetAssignment.objects.filter(allocation_id=asg.allocation_id))
    if not rows or any(r.status == 'active' for r in rows):
        return
    if any(r.status in ('lost', 'written_off') for r in rows):
        new = 'Lost'
    elif any(r.return_condition == 'damaged' for r in rows):
        new = 'Damaged'
    else:
        new = 'Returned'
    ItAssetAllocation.objects.filter(id=asg.allocation_id).exclude(status=new).update(status=new)


def backfill(actor='system', dry_run=True):
    """Mirror every existing onboarding allocation into the register."""
    from api.models import ItAssetAllocation
    report = []
    with transaction.atomic():
        for al in ItAssetAllocation.objects.select_related('candidate').order_by('id'):
            if getattr(al.candidate, 'is_deleted', False):
                continue
            r = sync_allocation(al, actor)
            report.append({'allocationId': al.id, 'email': _allocation_email(al), 'status': al.status, **r})
        if dry_run:
            transaction.set_rollback(True)          # preview only
    return report


# ── Full & Final ──────────────────────────────────────────────────────────
def clearance_text(asset):
    verb = 'Revoke licence seat:' if svc.is_license(asset) else 'Return'
    txt = f'{verb} {svc.label_of(asset)} — tag {asset.asset_tag}'
    if asset.serial_number:
        txt += f', S/N {asset.serial_number}'
    return txt[:255]


def _link_event(asg):
    for e in AssetEvent.objects.filter(asset_id=asg.asset_id, kind='separation_linked').order_by('-at', '-id'):
        if e.data.get('assignmentId') == asg.id and e.data.get('separationId') == asg.separation_id:
            return e
    return None


def clearance_for(asg):
    from api.models import ClearanceItem
    e = _link_event(asg) if asg.separation_id else None
    if not e:
        return None
    return ClearanceItem.objects.filter(id=e.data.get('clearanceId'), separation_id=asg.separation_id).first()


def link_separation(sep, actor='system'):
    """Add an IT clearance item for every active assignment of the leaver.
    Safe to call repeatedly. Returns the number of items created."""
    from api.models import ClearanceItem
    if sep.status in LOCKED_SEPARATION:
        return 0
    n = 0
    for asg in AssetAssignment.objects.filter(email__iexact=sep.email, status='active').select_related('asset'):
        if asg.separation_id == sep.id and clearance_for(asg):
            continue
        item = ClearanceItem.objects.create(separation=sep, department='IT', item=clearance_text(asg.asset),
                                            note=f'IT asset {asg.asset.asset_tag}')
        asg.separation_id = sep.id
        asg.save(update_fields=['separation_id'])
        svc.event(asg.asset, 'separation_linked', actor, email=asg.email, separationId=sep.id,
                  clearanceId=item.id, assignmentId=asg.id)
        n += 1
    if n and sep.status == 'computed':
        sep.status = 'clearance'                        # the computation is stale now
        sep.save(update_fields=['status'])
    return n


def on_separation_initiated(sep, actor):
    return link_separation(sep, actor)


def on_separation_cancelled(sep, actor):
    for asg in AssetAssignment.objects.filter(separation_id=sep.id).select_related('asset'):
        asg.separation_id = None
        asg.save(update_fields=['separation_id'])
        svc.event(asg.asset, 'separation_unlinked', actor, email=asg.email, separationId=sep.id)


def on_assignment_closed(asg, actor):
    """Returned / lost / written off → clear the paired F&F item (with the recovery)."""
    if not asg.separation_id:
        return
    from api.models import Separation
    c = clearance_for(asg)
    if not c:
        return
    sep = Separation.objects.filter(id=asg.separation_id).first()
    if not sep or sep.status in LOCKED_SEPARATION:
        return
    rec = asg.recovery_amount or Decimal('0')
    what = {'returned': f'Returned ({asg.return_condition or "good"})', 'lost': 'Lost',
            'written_off': 'Written off'}.get(asg.status, asg.status)
    c.status = 'cleared'
    c.recovery_amount = rec
    c.cleared_by = svc.norm_email(actor)
    c.cleared_at = timezone.now()
    c.note = (f'{what} in IT Assets' + (f'; recovery {rec}' if rec else ''))[:255]
    c.save()
    if sep.status in ('initiated', 'computed'):
        sep.status = 'clearance'
        sep.save(update_fields=['status'])
    try:
        from api.payroll_ext import security
        security.audit('fnf_clearance_cleared', 'Separation', sep.id, None, svc.norm_email(actor),
                       changes={'item': c.item, 'recovery': str(rec), 'source': 'it_assets'})
    except Exception:
        pass


def _assignment_for_item(item):
    for e in AssetEvent.objects.filter(kind='separation_linked').order_by('-at', '-id'):
        if e.data.get('clearanceId') == item.id:
            return AssetAssignment.objects.filter(id=e.data.get('assignmentId')).select_related('asset').first()
    return None


def on_clearance_changed(sep, item, actor):
    """HR cleared an asset item from the F&F checklist → record the return."""
    if item.department != 'IT' or not (str(item.note or '').startswith('IT asset') or ' — tag ' in item.item):
        return None
    asg = _assignment_for_item(item)
    if not asg:
        return None
    rec = item.recovery_amount or Decimal('0')
    if asg.status == 'active' and item.status == 'cleared':
        svc.return_asset(asg, actor, condition='damaged' if rec > 0 else 'good', received_by=actor,
                         note='Cleared in the F&F checklist', recovery=rec if rec > 0 else None,
                         sync_clearance=False)
    elif asg.status != 'active' and (asg.recovery_amount or Decimal('0')) != rec:
        asg.recovery_amount = rec
        asg.save(update_fields=['recovery_amount'])
    return asg


def separation_assets(sep):
    """Asset rows for the F&F screen (links any missing ones first)."""
    created = link_separation(sep) if sep.status not in LOCKED_SEPARATION else 0
    rows = []
    qs = AssetAssignment.objects.filter(separation_id=sep.id).select_related('asset').order_by('id')
    names = svc.names_for([sep.email])
    for asg in qs:
        c = clearance_for(asg)
        d = svc.assignment_dict(asg, names)
        d['asset'] = {'id': asg.asset.id, 'assetTag': asg.asset.asset_tag, 'label': svc.label_of(asg.asset),
                      'category': asg.asset.category, 'serialNumber': asg.asset.serial_number,
                      'status': asg.asset.status, 'condition': asg.asset.condition,
                      'purchaseCost': svc._money(asg.asset.purchase_cost), 'currency': asg.asset.currency}
        d['clearance'] = ({'id': c.id, 'status': c.status, 'recoveryAmount': svc._money(c.recovery_amount),
                           'item': c.item} if c else None)
        rows.append(d)
    return {'separationId': sep.id, 'status': sep.status, 'locked': sep.status in LOCKED_SEPARATION,
            'created': created, 'assets': rows}
