"""IT asset life-cycle: the register, custody (assignments), history, alerts.

Models live in hrms_plus/models.py (Asset, AssetAssignment, AssetEvent). The
HTTP layer is hrms_plus/assets_views.py; the onboarding and Full & Final
integration is hrms_plus/assets_links.py.

Life-cycle rules
----------------
Asset status (``Asset.status``):

    in_stock  --assign-->            assigned
    assigned  --return-->            in_stock   (or repair when returned damaged / "to repair")
    assigned  --holder lost it-->    lost       (recovery amount may be charged)
    in_stock  --send to repair-->    repair  --back-->  in_stock
    in_stock / repair / lost  --retire-->  retired   (terminal)
    lost      --found-->             in_stock
    any non-retired --write off-->   retired    (ends custody as written_off, optional recovery)

``assigned`` is only ever entered through an assignment and left through a
return / lost / write-off, so custody and status cannot drift apart.

Custody: a non-licence asset has at most one active assignment. A licence
(category ``license``) is a pool of ``license_seats`` seats; it can be held
by up to that many people at once and its status is ``assigned`` while any
seat is in use. Seats can never be reduced below the seats in use.

Acknowledgement: the holder confirms "I received it" (acknowledged_at). An
unacknowledged assignment older than ACK_REMINDER_DAYS gets an in-app
reminder (at most every ACK_REMINDER_DAYS days).

Every change is written to AssetEvent (append-only).
"""
import csv
import io
import logging
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, Q

from api.timeutil import local_now

from .models import Asset, AssetAssignment, AssetEvent

logger = logging.getLogger(__name__)

CATEGORIES = list(Asset.CATEGORIES)
STATUSES = list(Asset.STATUSES)
CONDITIONS = ['new', 'good', 'fair', 'damaged']
OWNERSHIP = ['company', 'client', 'byod']
CURRENCIES_RE = re.compile(r'^[A-Z]{3}$')
TAG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/#-]{0,59}$')

# Manual status moves (assign / return / lost / write-off have their own calls).
TRANSITIONS = {
    'in_stock': {'repair', 'retired', 'lost'},
    'assigned': set(),
    'repair': {'in_stock', 'retired', 'lost'},
    'lost': {'in_stock', 'retired'},
    'retired': set(),
}
ALERT_DAYS = 30
ACK_REMINDER_DAYS = 3
LICENSE_NEAR_LIMIT = 0.9          # seats used / total that counts as "near the limit"
CATEGORY_LABELS = {
    'laptop': 'Laptop', 'desktop': 'Desktop', 'monitor': 'Monitor', 'phone': 'Phone', 'tablet': 'Tablet',
    'peripheral': 'Peripheral', 'access_card': 'Access card', 'license': 'Software licence', 'other': 'Other',
}


class AssetError(ValueError):
    """A rule was broken; ``status`` is the HTTP status to answer with."""

    def __init__(self, message, status=400, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


# ── small helpers ─────────────────────────────────────────────────────────
def norm_email(v):
    return str(v or '').strip().lower()


def today():
    return local_now().date()


def _iso(v):
    if not v:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    return v.isoformat()


def _money(v):
    return None if v is None else str(Decimal(v).quantize(Decimal('0.01')))


def clean(v, n=255):
    s = str(v if v is not None else '').replace('\x00', '').strip()
    return s[:n]


def parse_date(v, label):
    if v in (None, ''):
        return None
    if isinstance(v, date):
        return v
    s = str(v).strip()[:10]
    for fmt in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise AssetError(f'{label} is not a valid date (use YYYY-MM-DD).')


def parse_amount(v, label='Amount'):
    if v in (None, ''):
        return None
    try:
        d = Decimal(str(v).replace(',', '').strip())
    except (InvalidOperation, ValueError):
        raise AssetError(f'{label} must be a number.')
    if d < 0 or d > Decimal('9999999999'):
        raise AssetError(f'{label} must be between 0 and 9,999,999,999.')
    return d.quantize(Decimal('0.01'))


def parse_seats(v):
    if v in (None, ''):
        return None
    try:
        n = int(str(v).strip())
    except ValueError:
        raise AssetError('Licence seats must be a whole number.')
    if n < 1 or n > 100000:
        raise AssetError('Licence seats must be between 1 and 100000.')
    return n


def is_license(asset):
    return asset.category == 'license'


def label_of(asset):
    return asset.name or ' '.join(x for x in (asset.make, asset.model) if x) or CATEGORY_LABELS.get(asset.category, 'Asset')


def names_for(emails):
    from api.models import AppUser, UserProfile
    emails = {norm_email(e) for e in emails if e}
    out = {}
    if not emails:
        return out
    for u in AppUser.objects.filter(email__in=emails).only('email', 'full_name'):
        if u.full_name:
            out[norm_email(u.email)] = u.full_name.strip()
    for p in UserProfile.objects.filter(email__in=emails).only('email', 'first_name', 'last_name'):
        n = f'{(p.first_name or "").strip()} {(p.last_name or "").strip()}'.strip()
        if n and norm_email(p.email) not in out:
            out[norm_email(p.email)] = n
    return out


def event(asset, kind, actor='', email='', note='', **data):
    return AssetEvent.objects.create(asset=asset, kind=kind, actor=norm_email(actor), email=norm_email(email),
                                     note=clean(note, 2000), data=data)


def active_assignments(asset):
    return asset.assignments.filter(status='active')


def seats_used(asset):
    return asset.assignments.filter(status='active').count()


def _refresh_license_status(asset):
    if asset.status in ('retired', 'lost', 'repair'):
        return
    asset.status = 'assigned' if seats_used(asset) else 'in_stock'


# ── serialisation ─────────────────────────────────────────────────────────
def assignment_dict(a, names=None):
    names = names or {}
    return {
        'id': a.id, 'assetId': a.asset_id, 'email': a.email, 'name': names.get(norm_email(a.email), ''),
        'assignedAt': _iso(a.assigned_at), 'assignedBy': a.assigned_by, 'expectedReturn': _iso(a.expected_return),
        'acknowledgedAt': _iso(a.acknowledged_at), 'returnedAt': _iso(a.returned_at),
        'returnCondition': a.return_condition, 'receivedBy': a.received_by, 'status': a.status,
        'recoveryAmount': _money(a.recovery_amount), 'separationId': a.separation_id,
        'allocationId': a.allocation_id, 'note': a.note,
    }


def asset_dict(asset, holders=None, names=None, full=False):
    """``holders``: the active assignments of this asset (prefetched)."""
    if holders is None:
        holders = list(active_assignments(asset))
    names = names if names is not None else names_for(h.email for h in holders)
    t = today()
    out = {
        'id': asset.id, 'assetTag': asset.asset_tag, 'category': asset.category, 'name': asset.name,
        'label': label_of(asset), 'make': asset.make, 'model': asset.model, 'serialNumber': asset.serial_number,
        'purchaseDate': _iso(asset.purchase_date), 'purchaseCost': _money(asset.purchase_cost),
        'currency': asset.currency, 'vendor': asset.vendor, 'warrantyUntil': _iso(asset.warranty_until),
        'licenseSeats': asset.license_seats, 'licenseExpiry': _iso(asset.license_expiry),
        'ownership': asset.ownership, 'clientName': asset.client_name, 'location': asset.location,
        'status': asset.status, 'condition': asset.condition, 'notes': asset.notes, 'custom': asset.custom or {},
        'createdBy': asset.created_by, 'createdAt': _iso(asset.created_at), 'updatedAt': _iso(asset.updated_at),
        'holders': [assignment_dict(h, names) for h in holders],
        'seatsUsed': len(holders) if is_license(asset) else None,
        'warrantyDays': (asset.warranty_until - t).days if asset.warranty_until else None,
        'licenseDays': (asset.license_expiry - t).days if asset.license_expiry else None,
    }
    if full:
        hist = list(asset.assignments.all().order_by('-assigned_at', '-id')[:200])
        ev = list(asset.events.all()[:300])
        nm = names_for([h.email for h in hist] + [e.email for e in ev] + [e.actor for e in ev])
        out['assignments'] = [assignment_dict(h, nm) for h in hist]
        out['events'] = [{'id': e.id, 'kind': e.kind, 'actor': e.actor, 'actorName': nm.get(e.actor, ''),
                          'email': e.email, 'name': nm.get(e.email, ''), 'note': e.note, 'data': e.data,
                          'at': _iso(e.at)} for e in ev]
        out['allowedStatus'] = sorted(TRANSITIONS.get(asset.status, ()))
    return out


def serialize_many(assets):
    assets = list(assets)
    ids = [a.id for a in assets]
    by_asset = {}
    for h in AssetAssignment.objects.filter(asset_id__in=ids, status='active').order_by('assigned_at', 'id'):
        by_asset.setdefault(h.asset_id, []).append(h)
    names = names_for(h.email for hs in by_asset.values() for h in hs)
    return [asset_dict(a, by_asset.get(a.id, []), names) for a in assets]


# ── create / update ───────────────────────────────────────────────────────
FIELD_MAP = {
    'assetTag': 'asset_tag', 'category': 'category', 'name': 'name', 'make': 'make', 'model': 'model',
    'serialNumber': 'serial_number', 'purchaseDate': 'purchase_date', 'purchaseCost': 'purchase_cost',
    'currency': 'currency', 'vendor': 'vendor', 'warrantyUntil': 'warranty_until',
    'licenseSeats': 'license_seats', 'licenseExpiry': 'license_expiry', 'ownership': 'ownership',
    'clientName': 'client_name', 'location': 'location', 'condition': 'condition', 'notes': 'notes',
}
TEXT_LIMITS = {'name': 200, 'make': 100, 'model': 120, 'serial_number': 120, 'vendor': 160,
               'client_name': 200, 'location': 160, 'notes': 4000}


def _apply_fields(asset, body, creating):
    """Validate ``body`` (camelCase) onto ``asset``. Returns a list of changed field names."""
    changed = []
    for key, field in FIELD_MAP.items():
        if key not in body:
            continue
        v = body.get(key)
        if field == 'asset_tag':
            v = clean(v, 60)
            if not TAG_RE.match(v):
                raise AssetError('Asset tag is required: letters, digits and . _ / # - (max 60).')
        elif field == 'category':
            v = clean(v, 20).lower()
            if v not in CATEGORIES:
                raise AssetError('Category must be one of: ' + ', '.join(CATEGORIES) + '.')
        elif field in ('purchase_date', 'warranty_until', 'license_expiry'):
            v = parse_date(v, {'purchase_date': 'Purchase date', 'warranty_until': 'Warranty end',
                               'license_expiry': 'Licence expiry'}[field])
        elif field == 'purchase_cost':
            v = parse_amount(v, 'Purchase cost')
        elif field == 'license_seats':
            v = parse_seats(v)
        elif field == 'currency':
            v = clean(v, 3).upper() or 'INR'
            if not CURRENCIES_RE.match(v):
                raise AssetError('Currency must be a 3-letter code such as INR or USD.')
        elif field == 'ownership':
            v = clean(v, 20).lower() or 'company'
            if v not in OWNERSHIP:
                raise AssetError('Ownership must be company, client or byod.')
        elif field == 'condition':
            v = clean(v, 20).lower() or 'good'
            if v not in CONDITIONS:
                raise AssetError('Condition must be one of: ' + ', '.join(CONDITIONS) + '.')
        else:
            v = clean(v, TEXT_LIMITS.get(field, 255))
        if getattr(asset, field) != v:
            setattr(asset, field, v)
            changed.append(field)
    if 'custom' in body:
        c = body.get('custom') or {}
        if not isinstance(c, dict) or len(c) > 30:
            raise AssetError('custom must be an object with at most 30 keys.')
        c = {clean(k, 40): clean(val, 500) for k, val in c.items() if clean(k, 40)}
        if c != (asset.custom or {}):
            asset.custom = c
            changed.append('custom')
    _validate(asset, creating)
    return changed


def _validate(asset, creating):
    if not asset.asset_tag:
        raise AssetError('Asset tag is required.')
    t = today()
    if asset.purchase_date:
        if asset.purchase_date > t:
            raise AssetError('The purchase date cannot be in the future.')
        if asset.purchase_date < date(1990, 1, 1):
            raise AssetError('Check the purchase date.')
    for field, label in (('warranty_until', 'warranty end'), ('license_expiry', 'licence expiry')):
        v = getattr(asset, field)
        if v and asset.purchase_date and v < asset.purchase_date:
            raise AssetError(f'The {label} cannot be before the purchase date.')
        if v and v > date(2100, 1, 1):
            raise AssetError(f'Check the {label}.')
    if asset.ownership == 'client' and not asset.client_name:
        raise AssetError('Name the client for a client-owned asset.')
    if is_license(asset):
        if not asset.license_seats:
            raise AssetError('A licence needs the number of seats.')
        if not creating:
            used = seats_used(asset)
            if asset.license_seats < used:
                raise AssetError(f'{used} seat(s) are in use; release some before reducing seats to '
                                 f'{asset.license_seats}.', 409, 'SEATS_IN_USE')
    elif not creating and asset.license_seats and asset.category != 'license':
        asset.license_seats = None


def serial_warnings(asset):
    if not asset.serial_number:
        return []
    dup = Asset.objects.filter(category=asset.category, serial_number__iexact=asset.serial_number).exclude(id=asset.id)
    return [f'Serial number {asset.serial_number} is also on {d.asset_tag} ({CATEGORY_LABELS.get(d.category, d.category)}).'
            for d in dup[:5]]


def create_asset(body, actor):
    asset = Asset(created_by=norm_email(actor), status='in_stock')
    if not body.get('assetTag'):
        raise AssetError('Asset tag is required.')
    _apply_fields(asset, body, creating=True)
    if Asset.objects.filter(asset_tag__iexact=asset.asset_tag).exists():
        raise AssetError(f'Asset tag {asset.asset_tag} is already in the register.', 409, 'DUPLICATE_TAG')
    try:
        with transaction.atomic():
            asset.save()
    except IntegrityError:
        raise AssetError(f'Asset tag {asset.asset_tag} is already in the register.', 409, 'DUPLICATE_TAG')
    event(asset, 'created', actor, note=body.get('eventNote') or '',
          tag=asset.asset_tag, category=asset.category)
    return asset, serial_warnings(asset)


def update_asset(asset, body, actor):
    body = dict(body or {})
    body.pop('status', None)                     # status moves have their own call
    if 'assetTag' in body and clean(body['assetTag'], 60).lower() != asset.asset_tag.lower():
        if Asset.objects.filter(asset_tag__iexact=clean(body['assetTag'], 60)).exclude(id=asset.id).exists():
            raise AssetError('That asset tag is already in the register.', 409, 'DUPLICATE_TAG')
    if 'category' in body and clean(body['category']).lower() != asset.category and active_assignments(asset).exists():
        if 'license' in (asset.category, clean(body['category']).lower()):
            raise AssetError('Release every holder before changing to or from a licence.', 409)
    before = {f: str(getattr(asset, f)) for f in FIELD_MAP.values()}
    changed = _apply_fields(asset, body, creating=False)
    if is_license(asset):
        _refresh_license_status(asset)
    asset.save()
    if changed:
        event(asset, 'updated', actor, changes={f: [before.get(f, ''), str(getattr(asset, f))] for f in changed
                                                 if f != 'custom'})
    return asset, serial_warnings(asset)


def delete_asset(asset, actor):
    if asset.assignments.exists():
        raise AssetError('This asset has custody history; retire it instead of deleting it.', 409, 'HAS_HISTORY')
    asset.delete()


# ── status moves ──────────────────────────────────────────────────────────
STATUS_EVENT = {'repair': 'sent_to_repair', 'in_stock': 'back_in_stock', 'retired': 'retired', 'lost': 'marked_lost'}


def change_status(asset, new, actor, note=''):
    new = clean(new, 12).lower()
    if new not in STATUSES:
        raise AssetError('Unknown status.')
    if new == asset.status:
        return asset
    if new == 'assigned':
        raise AssetError('Assign the asset to someone to mark it assigned.')
    if asset.status == 'assigned':
        raise AssetError('This asset is held by someone. Record the return (or mark it lost) first.', 409, 'HELD')
    if new not in TRANSITIONS.get(asset.status, set()):
        raise AssetError(f'An asset that is {asset.status.replace("_", " ")} cannot move to {new.replace("_", " ")}.',
                         409, 'BAD_TRANSITION')
    old = asset.status
    asset.status = new
    if is_license(asset) and new == 'in_stock':
        _refresh_license_status(asset)
    asset.save(update_fields=['status', 'updated_at'])
    kind = 'found' if (old == 'lost' and new == 'in_stock') else ('back_from_repair' if old == 'repair' and new == 'in_stock'
                                                                 else STATUS_EVENT[new])
    event(asset, kind, actor, note=note, before=old, after=new)
    return asset


# ── custody ───────────────────────────────────────────────────────────────
def assign(asset, email, actor, expected_return=None, note='', allocation_id=None, assigned_at=None,
           notify=True):
    """Hand ``asset`` to ``email``. Returns the new AssetAssignment."""
    email = norm_email(email)
    if not email or '@' not in email:
        raise AssetError('Choose who receives the asset.')
    expected_return = parse_date(expected_return, 'Expected return') if not isinstance(expected_return, date) \
        else expected_return
    if expected_return and expected_return < today():
        raise AssetError('The expected return date is in the past.')
    with transaction.atomic():
        a = Asset.objects.select_for_update().get(id=asset.id)
        if is_license(a):
            if a.status not in ('in_stock', 'assigned'):
                raise AssetError(f'This licence is {a.status.replace("_", " ")} and cannot be assigned.', 409)
            if a.license_expiry and a.license_expiry < today():
                raise AssetError('This licence has expired.', 409, 'EXPIRED')
            used = seats_used(a)
            if used >= (a.license_seats or 1):
                raise AssetError(f'All {a.license_seats or 1} seat(s) of this licence are in use.', 409, 'NO_SEATS')
            if a.assignments.filter(status='active', email=email).exists():
                raise AssetError('This person already holds a seat of this licence.', 409)
        else:
            if a.status != 'in_stock' or a.assignments.filter(status='active').exists():
                raise AssetError(f'{a.asset_tag} is {a.status.replace("_", " ")}; only an in-stock asset can be '
                                 f'assigned.', 409, 'NOT_AVAILABLE')
        asg = AssetAssignment.objects.create(asset=a, email=email, assigned_by=norm_email(actor),
                                             assigned_at=assigned_at or local_now(), expected_return=expected_return,
                                             note=clean(note, 2000), allocation_id=allocation_id)
        a.status = 'assigned'
        a.save(update_fields=['status', 'updated_at'])
        event(a, 'assigned', actor, email=email, note=note, assignmentId=asg.id,
              **({'allocationId': allocation_id} if allocation_id else {}))
    asset.status = a.status
    if notify:
        _notify(email, 'Asset assigned to you',
                f'{label_of(a)} ({a.asset_tag}) has been assigned to you. Please confirm you received it.',
                '/my-assets')
    return asg


def acknowledge(asg, email):
    if norm_email(asg.email) != norm_email(email):
        raise AssetError('Not found', 404)
    if asg.status != 'active':
        raise AssetError('This asset is no longer with you.', 409)
    if asg.acknowledged_at:
        return asg
    asg.acknowledged_at = local_now()
    asg.save(update_fields=['acknowledged_at'])
    event(asg.asset, 'acknowledged', email, email=email, assignmentId=asg.id)
    return asg


def _end(asg, status, actor, condition='', received_by='', recovery=None, note='', asset_status=None, kind='returned',
         sync_clearance=True):
    """Close an active assignment and move the asset. Returns the assignment."""
    from . import assets_links
    with transaction.atomic():
        a = Asset.objects.select_for_update().get(id=asg.asset_id)
        asg = AssetAssignment.objects.select_for_update().get(id=asg.id)
        if asg.status != 'active' and not (status == 'written_off' and asg.status == 'lost'):
            raise AssetError('This assignment is already closed.', 409, 'CLOSED')
        asg.status = status
        if status != 'written_off' or not asg.returned_at:
            asg.returned_at = local_now()
        if condition:
            asg.return_condition = condition
        if received_by:
            asg.received_by = norm_email(received_by)
        if recovery is not None:
            asg.recovery_amount = recovery
        if note:
            asg.note = (asg.note + '\n' if asg.note else '') + clean(note, 1000)
        asg.save()
        if condition:
            a.condition = condition
        if is_license(a):
            _refresh_license_status(a)
        elif asset_status:
            a.status = asset_status
        a.save()
        event(a, kind, actor, email=asg.email, note=note, assignmentId=asg.id,
              **({'condition': condition} if condition else {}),
              **({'recoveryAmount': _money(recovery)} if recovery else {}))
        if sync_clearance:
            assets_links.on_assignment_closed(asg, actor)
        assets_links.sync_allocation_status(asg)
    return asg


def return_asset(asg, actor, condition='good', received_by='', note='', to_repair=False, recovery=None,
                 sync_clearance=True):
    condition = clean(condition, 20).lower() or 'good'
    if condition not in CONDITIONS:
        raise AssetError('Condition must be one of: ' + ', '.join(CONDITIONS) + '.')
    if condition == 'damaged' and not is_license(asg.asset):
        to_repair = True
    recovery = parse_amount(recovery, 'Recovery amount') if not isinstance(recovery, Decimal) else recovery
    return _end(asg, 'returned', actor, condition=condition, received_by=received_by or actor, note=note,
                recovery=recovery if recovery else None, asset_status='repair' if to_repair else 'in_stock',
                kind='returned', sync_clearance=sync_clearance)


def mark_lost(asg, actor, recovery=None, note=''):
    if is_license(asg.asset):
        raise AssetError('A licence seat cannot be lost; revoke it with a return instead.')
    recovery = parse_amount(recovery, 'Recovery amount') if not isinstance(recovery, Decimal) else recovery
    return _end(asg, 'lost', actor, recovery=recovery, note=note, asset_status='lost', kind='lost')


def write_off(asset, actor, recovery=None, note=''):
    """Retire an asset for good; any open custody becomes written_off."""
    recovery = parse_amount(recovery, 'Recovery amount') if not isinstance(recovery, Decimal) else recovery
    if asset.status == 'retired':
        raise AssetError('This asset is already retired.', 409)
    open_ = list(asset.assignments.filter(status__in=('active', 'lost')).order_by('-assigned_at'))
    if is_license(asset) and len(open_) > 1:
        raise AssetError('Release the licence seats before writing it off.', 409)
    if open_:
        _end(open_[0], 'written_off', actor, recovery=recovery, note=note, asset_status='retired', kind='written_off')
        asset.refresh_from_db()
    else:
        asset.status = 'retired'
        asset.save(update_fields=['status', 'updated_at'])
        event(asset, 'written_off', actor, note=note, **({'recoveryAmount': _money(recovery)} if recovery else {}))
    if asset.status != 'retired':
        asset.status = 'retired'
        asset.save(update_fields=['status', 'updated_at'])
    return asset


# ── notifications ─────────────────────────────────────────────────────────
def _notify(email, title, message, link=''):
    try:
        from api.views import create_notification
        create_notification(email, title, message, 'info', link)
    except Exception:
        logger.exception('asset notification failed')


def managers():
    """Active users holding assets.manage (Super Admins included)."""
    from api.models import AppUser
    from api.payroll_ext.security import has_perm
    out = []
    for u in AppUser.objects.select_related('role_ref').filter(status='active'):
        try:
            if has_perm(u, 'assets.manage'):
                out.append(norm_email(u.email))
        except Exception:
            continue
    return out


# ── KPIs / expiry ─────────────────────────────────────────────────────────
def license_usage():
    rows = []
    qs = Asset.objects.filter(category='license').exclude(status='retired').annotate(
        used=Count('assignments', filter=Q(assignments__status='active'))).order_by('license_expiry', 'asset_tag')
    t = today()
    for a in qs:
        seats = a.license_seats or 0
        rows.append({'id': a.id, 'assetTag': a.asset_tag, 'label': label_of(a), 'vendor': a.vendor,
                     'seats': seats, 'used': a.used, 'free': max(0, seats - a.used),
                     'licenseExpiry': _iso(a.license_expiry),
                     'licenseDays': (a.license_expiry - t).days if a.license_expiry else None,
                     'nearLimit': bool(seats) and a.used / seats >= LICENSE_NEAR_LIMIT, 'status': a.status})
    return rows


def expiring(days=ALERT_DAYS):
    """Warranties and licences ending within ``days`` (already expired licences included)."""
    t = today()
    horizon = t + timedelta(days=days)
    out = []
    for a in Asset.objects.exclude(status='retired').filter(warranty_until__isnull=False,
                                                            warranty_until__gte=t, warranty_until__lte=horizon):
        out.append({'kind': 'warranty', 'id': a.id, 'assetTag': a.asset_tag, 'label': label_of(a),
                    'category': a.category, 'date': _iso(a.warranty_until), 'days': (a.warranty_until - t).days,
                    'status': a.status})
    for a in Asset.objects.exclude(status='retired').filter(license_expiry__isnull=False, license_expiry__lte=horizon):
        out.append({'kind': 'license', 'id': a.id, 'assetTag': a.asset_tag, 'label': label_of(a),
                    'category': a.category, 'date': _iso(a.license_expiry), 'days': (a.license_expiry - t).days,
                    'status': a.status})
    out.sort(key=lambda r: (r['days'], r['assetTag']))
    return out


def kpis():
    counts = dict(Asset.objects.values_list('status').annotate(n=Count('id')).values_list('status', 'n'))
    lic = license_usage()
    exp = expiring()
    return {
        'total': sum(v for k, v in counts.items() if k != 'retired'),
        'assigned': counts.get('assigned', 0), 'inStock': counts.get('in_stock', 0),
        'inRepair': counts.get('repair', 0), 'lost': counts.get('lost', 0), 'retired': counts.get('retired', 0),
        'warrantyExpiring': sum(1 for r in exp if r['kind'] == 'warranty'),
        'licenseExpiring': sum(1 for r in exp if r['kind'] == 'license'),
        'licensesNearLimit': sum(1 for r in lic if r['nearLimit']),
        'unacknowledged': AssetAssignment.objects.filter(status='active', acknowledged_at__isnull=True).count(),
    }


# ── alerts (cron: manage.py asset_alerts; also triggered lazily) ──────────
def run_alerts(send_mail=True, now=None):
    """Raise each expiry alert once (per asset and end date) and remind holders
    who have not acknowledged. Returns a summary dict."""
    now = now or local_now()
    t = now.date()
    new_alerts = []
    for row in expiring():
        a = Asset.objects.get(id=row['id'])
        kind = 'alert_' + row['kind']
        if any(e.data.get('date') == row['date'] for e in a.events.filter(kind=kind)):
            continue
        event(a, kind, 'system', date=row['date'], days=row['days'])
        new_alerts.append(row)
    reminded = 0
    cutoff = now - timedelta(days=ACK_REMINDER_DAYS)
    from api.models import AppUser
    for asg in AssetAssignment.objects.filter(status='active', acknowledged_at__isnull=True,
                                              assigned_at__lte=cutoff).select_related('asset'):
        if not AppUser.objects.filter(email__iexact=asg.email, status='active').exists():
            continue                                 # not an employee yet (onboarding) — nothing to remind
        last = asg.asset.events.filter(kind='ack_reminder', email=norm_email(asg.email)).order_by('-at').first()
        if last and last.at > cutoff:
            continue
        _notify(asg.email, 'Please confirm your asset',
                f'You were given {label_of(asg.asset)} ({asg.asset.asset_tag}) on {asg.assigned_at:%d %b %Y}. '
                f'Open My assets and confirm you received it.', '/my-assets')
        event(asg.asset, 'ack_reminder', 'system', email=asg.email, assignmentId=asg.id)
        reminded += 1
    mailed = 0
    if new_alerts:
        lines = '; '.join(f'{r["assetTag"]} {r["kind"]} {"expired" if r["days"] < 0 else "ends"} {r["date"]}'
                          for r in new_alerts[:5])
        more = f' (+{len(new_alerts) - 5} more)' if len(new_alerts) > 5 else ''
        recipients = managers()
        for m in recipients:
            _notify(m, f'{len(new_alerts)} IT asset expiry alert(s)', lines + more, '/it-assets/expiring')
        if send_mail:
            mailed = _mail_digest(recipients, new_alerts)
    return {'alerts': len(new_alerts), 'reminders': reminded, 'emailed': mailed}


def _mail_digest(recipients, rows):
    from django.utils.html import escape
    try:
        from api.mailer import render_branded, send_email
    except Exception:
        return 0
    trs = ''.join(
        f'<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">{escape(r["assetTag"])}</td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">{escape(r["label"])}</td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">{"Licence" if r["kind"] == "license" else "Warranty"}</td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">{escape(r["date"])} '
        f'({"expired" if r["days"] < 0 else str(r["days"]) + " days"})</td></tr>' for r in rows[:50])
    table = ('<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #e2e8f0;'
             'border-radius:8px;margin:0 0 20px"><tr style="background:#f8fafc"><th align="left" style="padding:6px 8px">Tag</th>'
             '<th align="left" style="padding:6px 8px">Asset</th><th align="left" style="padding:6px 8px">What</th>'
             f'<th align="left" style="padding:6px 8px">Ends</th></tr>{trs}</table>')
    html = render_branded('IT assets: warranties and licences ending soon',
                          f'{len(rows)} warranty or licence end date(s) fall within the next {ALERT_DAYS} days. '
                          'Renew or plan replacements from the IT Assets page.', highlight_html=table)
    sent = 0
    for m in recipients:
        try:
            if send_email(m, f'IT asset expiry alerts ({len(rows)})', html=html).get('ok'):
                sent += 1
        except Exception:
            logger.exception('asset digest email failed')
    return sent


_LAZY = {'day': None}


def lazy_alerts():
    """Run the alerts at most once per process per day from a page load
    (the cron command is the primary trigger)."""
    t = today()
    if _LAZY['day'] == t:
        return
    _LAZY['day'] = t
    try:
        with transaction.atomic():
            run_alerts()
    except Exception:
        logger.exception('lazy asset alerts failed')


# ── CSV ───────────────────────────────────────────────────────────────────
CSV_COLUMNS = [
    ('asset_tag', 'assetTag'), ('category', 'category'), ('name', 'name'), ('make', 'make'), ('model', 'model'),
    ('serial_number', 'serialNumber'), ('purchase_date', 'purchaseDate'), ('purchase_cost', 'purchaseCost'),
    ('currency', 'currency'), ('vendor', 'vendor'), ('warranty_until', 'warrantyUntil'),
    ('license_seats', 'licenseSeats'), ('license_expiry', 'licenseExpiry'), ('ownership', 'ownership'),
    ('client_name', 'clientName'), ('location', 'location'), ('condition', 'condition'), ('notes', 'notes'),
]
EXPORT_EXTRA = ['status', 'holder_email', 'holder_name', 'assigned_at', 'acknowledged']
_FORMULA_START = ('=', '+', '-', '@', '\t', '\r')


def csv_safe(v):
    """Neutralise spreadsheet formula injection (=, +, -, @, tab, CR)."""
    s = '' if v is None else str(v)
    if s and s[0] in _FORMULA_START:
        if s[0] == '-' and re.fullmatch(r'-\d+(\.\d+)?', s):
            return s                      # a plain negative number is data
        return "'" + s
    return s


def _csv_unescape(s):
    s = (s or '').strip()
    if len(s) > 1 and s[0] == "'" and s[1] in _FORMULA_START:
        return s[1:]
    return s


def export_csv(qs):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([c for c, _ in CSV_COLUMNS] + EXPORT_EXTRA)
    rows = serialize_many(qs)
    for r in rows:
        h = r['holders'][0] if r['holders'] else None
        vals = [r[k] for _, k in CSV_COLUMNS]
        holders = r['holders']
        vals += [r['status'], '; '.join(x['email'] for x in holders), '; '.join(x['name'] for x in holders),
                 h['assignedAt'] if h else '', ('yes' if h and h['acknowledgedAt'] else ('no' if h else ''))]
        w.writerow([csv_safe('' if v is None else v) for v in vals])
    return '﻿' + buf.getvalue()


def import_csv(text, actor, dry_run=True, max_rows=5000):
    """Create new assets / update existing ones (matched by tag) from CSV text.
    Returns {'created', 'updated', 'errors': [{row, message}], 'warnings', 'rows'}."""
    text = (text or '').lstrip('﻿')
    if not text.strip():
        raise AssetError('The file is empty.')
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip().lower().replace(' ', '_') for h in (reader.fieldnames or [])]
    alias = {'tag': 'asset_tag', 'serial': 'serial_number', 'seats': 'license_seats', 'warranty': 'warranty_until'}
    headers = [alias.get(h, h) for h in headers]
    known = {c for c, _ in CSV_COLUMNS}
    if 'asset_tag' not in headers:
        raise AssetError('The CSV needs an asset_tag column. Columns: ' + ', '.join(c for c, _ in CSV_COLUMNS))
    out = {'created': 0, 'updated': 0, 'errors': [], 'warnings': [], 'rows': 0, 'dryRun': bool(dry_run)}
    to_camel = dict(CSV_COLUMNS)
    seen = set()
    with transaction.atomic():
        for i, raw in enumerate(reader, start=2):
            if i - 1 > max_rows:
                out['errors'].append({'row': i, 'message': f'Only {max_rows} rows are imported at a time.'})
                break
            row = {}
            for k, v in zip(headers, [raw.get(h) for h in (reader.fieldnames or [])]):
                if k in known and v is not None:
                    row[k] = _csv_unescape(v)
            if not any(row.values()):
                continue
            out['rows'] += 1
            tag = row.get('asset_tag', '')
            if tag.lower() in seen:
                out['errors'].append({'row': i, 'message': f'{tag} appears twice in the file.'})
                continue
            seen.add(tag.lower())
            body = {to_camel[k]: v for k, v in row.items() if v != '' or k == 'asset_tag'}
            try:
                with transaction.atomic():
                    existing = Asset.objects.filter(asset_tag__iexact=tag).first() if tag else None
                    if existing:
                        body.pop('assetTag', None)
                        a, warn = update_asset(existing, body, actor)
                        out['updated'] += 1
                    else:
                        body.setdefault('category', 'other')
                        body['eventNote'] = 'Imported from CSV'
                        a, warn = create_asset(body, actor)
                        out['created'] += 1
                    out['warnings'] += [f'Row {i}: {w}' for w in warn]
            except AssetError as e:
                out['errors'].append({'row': i, 'message': str(e)})
        if dry_run:
            transaction.set_rollback(True)       # preview only: nothing is kept
    return out
