"""Office Wi-Fi / IP network whitelist for attendance.

Why: indoors (high-rise offices) GPS drifts 50-150 m, so a genuine check-in
can read as "outside the office" and the geofence watcher could warn — or
auto check out — someone sitting at their desk. A request that arrives from
the office's own network is strong evidence the person is in the office.

Rules
  * Each COMPANY location (GeoFence with blank owner_email) may list networks:
    ``office_networks = [{"cidr": "203.0.113.10/32", "label": "Main Wi-Fi"}]``.
    Home fences never carry or use networks: an office IP proves nothing about
    someone's living room.
  * The server sees the office's PUBLIC address (the router's / ISP's), never
    a 192.168.x.x LAN address — unless the server itself sits on that LAN.
    Private ranges are therefore accepted with a warning, not refused.
  * A range broader than /16 (IPv4) or /48 (IPv6) is refused: it would cover
    an ISP's whole customer base, i.e. everybody's home connection.
  * A matching request counts as INSIDE that location: check-in is verified
    (no off-site approval), the departure watcher's outside run is cleared,
    and an automatic check-out sent from the office network is refused.

Client IP (``client_ip``)
  REMOTE_ADDR — the address of whoever opened the TCP connection to the web
  server — is the only value the client cannot choose. X-Forwarded-For is an
  ordinary request header: any browser or script can send
  ``X-Forwarded-For: 203.0.113.10`` and, if it were trusted, check in "from the
  office" while at home. It is therefore ignored unless the admin says the app
  runs behind a reverse proxy they control (``trustForwardedFor``). Even then
  only the entry that proxy appended counts: each proxy appends the address it
  received the connection from to the RIGHT of the list, so with
  ``proxyCount`` trusted proxies the real client is ``parts[-proxyCount]``.
  Everything to its left was written by the client and is never read.
  On cPanel / Passenger (Apache) REMOTE_ADDR is already the visitor's address:
  leave ``trustForwardedFor`` off unless a CDN such as Cloudflare sits in front.

Settings: MasterDataSet ``attendance_network_policy`` =
  ``{"enabled": true, "trustForwardedFor": false, "proxyCount": 1}``.
Audit: every change is logged (logger ``api.attendance_ext.networks``) and kept
in MasterDataSet ``attendance_network_audit`` (newest first, capped).

Endpoints
  GET /api/attendance/networks   policy, per-location networks, ``yourIp``
                                 (attendance.edit / settings.manage / settings.view)
  PUT /api/attendance/networks   {policy?, fences?: [{id, networks: [...]}]}
                                 (attendance.edit / settings.manage); all or nothing
"""
import ipaddress
import logging

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api import permissions as perms
from api.models import GeoFence, MasterDataSet
from api.timeutil import local_now

logger = logging.getLogger(__name__)

POLICY_KEY = 'attendance_network_policy'
AUDIT_KEY = 'attendance_network_audit'
AUDIT_KEEP = 200
POLICY_DEFAULTS = {'enabled': True, 'trustForwardedFor': False, 'proxyCount': 1}
PROXY_COUNT_RANGE = (1, 5)
MAX_NETWORKS_PER_FENCE = 25
LABEL_MAX = 60
#: Narrowest prefix length allowed; anything broader is an ISP, not an office.
MIN_PREFIX = {4: 16, 6: 48}

# The office IP ranges are not for every employee (settings.view is held by
# all roles), so reading needs the same code as editing.
READ_CODES = ['attendance.network.manage']
WRITE_CODES = ['attendance.network.manage']

#: Addresses that never appear as a public client address on the internet.
#: (ipaddress' own is_private also flags the documentation ranges such as
#: 203.0.113.0/24, which is why the list is explicit.)
_PRIVATE = [ipaddress.ip_network(n) for n in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10',
    '::1/128', 'fc00::/7', 'fe80::/10')]

PRIVATE_WARNING = ('{cidr} is a private (local-network) address. The server only sees it if it runs inside the '
                   'office network itself; a hosted server sees the office\'s public IP instead. Add the public '
                   'IP your ISP gave the office.')


# ---------------------------------------------------------------------------
# policy
# ---------------------------------------------------------------------------
def _bool(v, default):
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ('true', '1', 'yes', 'on'):
        return True
    if isinstance(v, str) and v.strip().lower() in ('false', '0', 'no', 'off'):
        return False
    if isinstance(v, (int, float)):
        return bool(v)
    return default


def clean_policy(raw, strict=False):
    """(policy, errors). Non-strict silently falls back to defaults."""
    raw = raw if isinstance(raw, dict) else {}
    out, errors = dict(POLICY_DEFAULTS), {}
    for k in ('enabled', 'trustForwardedFor'):
        if k in raw:
            v = _bool(raw[k], None)
            if v is None:
                errors[k] = 'must be true or false'
            else:
                out[k] = v
    if 'proxyCount' in raw:
        try:
            n = int(raw['proxyCount'])
            if isinstance(raw['proxyCount'], float) and raw['proxyCount'] != n:
                raise ValueError
            if not PROXY_COUNT_RANGE[0] <= n <= PROXY_COUNT_RANGE[1]:
                raise ValueError
            out['proxyCount'] = n
        except (TypeError, ValueError):
            errors['proxyCount'] = 'must be a whole number from %d to %d' % PROXY_COUNT_RANGE
    if errors and not strict:
        return clean_policy({k: v for k, v in raw.items() if k not in errors}), {}
    return out, errors


def network_policy():
    row = MasterDataSet.objects.filter(key=POLICY_KEY).first()
    return clean_policy(row.options if row else {})[0]


# ---------------------------------------------------------------------------
# addresses
# ---------------------------------------------------------------------------
def _parse_ip(value):
    """An ipaddress object from a header/META value, or None. Accepts a port
    ('1.2.3.4:5678', '[2001:db8::1]:443') and unwraps IPv4-mapped IPv6."""
    s = str(value or '').strip().strip('"')
    if not s:
        return None
    if s.startswith('['):
        s = s[1:].split(']', 1)[0]
    elif s.count(':') == 1:                     # IPv4 with a port
        s = s.split(':', 1)[0]
    s = s.split('%', 1)[0]                      # IPv6 zone id
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    mapped = getattr(ip, 'ipv4_mapped', None)
    return mapped or ip


def client_ip(request, policy=None):
    """The caller's IP address as a string ('' when unknown). See the module
    docstring for why X-Forwarded-For is ignored unless trusted."""
    pol = policy or network_policy()
    meta = getattr(request, 'META', {}) or {}
    if pol.get('trustForwardedFor'):
        parts = [p.strip() for p in str(meta.get('HTTP_X_FORWARDED_FOR') or '').split(',') if p.strip()]
        n = int(pol.get('proxyCount') or 1)
        if len(parts) >= n:
            ip = _parse_ip(parts[-n])
            if ip is not None:
                return str(ip)
    ip = _parse_ip(meta.get('REMOTE_ADDR'))
    return str(ip) if ip is not None else ''


def is_private(net_or_ip):
    obj = net_or_ip
    if isinstance(obj, str):
        try:
            obj = ipaddress.ip_network(obj, strict=False)
        except ValueError:
            return False
    if not isinstance(obj, (ipaddress.IPv4Network, ipaddress.IPv6Network)):
        obj = ipaddress.ip_network(obj)
    return any(obj.version == p.version and obj.overlaps(p) for p in _PRIVATE)


def validate_cidr(value):
    """('203.0.113.0/28', warning-or-None) for a valid entry; ValueError with a
    message an admin can act on otherwise. A bare address becomes /32 (/128)."""
    s = str(value or '').strip()
    if not s:
        raise ValueError('Enter an IP address or a CIDR range, e.g. 203.0.113.10 or 203.0.113.0/28.')
    if len(s) > 64:
        raise ValueError('That address is too long.')
    try:
        net = ipaddress.ip_network(s, strict=False)
    except ValueError:
        raise ValueError(f'"{s}" is not a valid IP address or CIDR range '
                         f'(e.g. 203.0.113.10 or 203.0.113.0/28).')
    if net.prefixlen == 0 or net.network_address.is_unspecified:
        raise ValueError(f'{net} matches every address on the internet, so it would verify anyone, anywhere.')
    if net.is_multicast:
        raise ValueError(f'{net} is a multicast range, not a network a device connects from.')
    need = MIN_PREFIX[net.version]
    if net.prefixlen < need:
        raise ValueError(f'{net} is too broad: it covers {net.num_addresses:,} addresses (an ISP\'s customers, '
                         f'not one office). Use /{need} or narrower — usually the single static IP (/'
                         f'{32 if net.version == 4 else 128}).')
    warning = PRIVATE_WARNING.format(cidr=str(net)) if is_private(net) else None
    return str(net), warning


def clean_networks(raw):
    """(entries, warnings, errors) for one location's list."""
    entries, warnings, errors, seen = [], [], [], set()
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        return [], [], ['networks must be a list']
    if len(raw) > MAX_NETWORKS_PER_FENCE:
        return [], [], [f'At most {MAX_NETWORKS_PER_FENCE} networks per location.']
    for item in raw:
        if isinstance(item, str):
            item = {'cidr': item}
        if not isinstance(item, dict):
            errors.append('Each network is {"cidr": ..., "label": ...}.')
            continue
        try:
            cidr, warn = validate_cidr(item.get('cidr'))
        except ValueError as e:
            errors.append(str(e))
            continue
        if cidr in seen:
            continue
        seen.add(cidr)
        label = str(item.get('label') or '').strip()[:LABEL_MAX]
        entries.append({'cidr': cidr, 'label': label})
        if warn:
            warnings.append(warn)
    return entries, warnings, errors


# ---------------------------------------------------------------------------
# matching
# ---------------------------------------------------------------------------
def _fence_networks(fence):
    out = []
    for e in (fence.office_networks or []):
        try:
            cidr = e.get('cidr') if isinstance(e, dict) else e
            out.append((ipaddress.ip_network(str(cidr), strict=False), (e.get('label') if isinstance(e, dict) else '') or ''))
        except (ValueError, AttributeError, TypeError):
            continue                            # a hand-edited bad row never breaks a check-in
    return out


def match_ip(ip, fences=None):
    """{'fence', 'cidr', 'label'} for the first ACTIVE COMPANY location whose
    networks contain ``ip``, else None."""
    addr = _parse_ip(ip)
    if addr is None:
        return None
    qs = fences if fences is not None else GeoFence.objects.filter(is_active=True, owner_email='').order_by('name', 'id')
    for fence in qs:
        if getattr(fence, 'owner_email', ''):
            continue                            # never a home
        for net, label in _fence_networks(fence):
            if net.version == addr.version and addr in net:
                return {'fence': fence, 'cidr': str(net), 'label': label}
    return None


def office_network_match(request):
    """The office network this request comes from, or None (also when the
    feature is switched off). Never raises — a failure here must not block a
    check-in, it just means GPS decides as before."""
    try:
        pol = network_policy()
        if not pol['enabled']:
            return None
        ip = client_ip(request, pol)
        m = match_ip(ip)
        if m is not None:
            m['ip'] = ip
        return m
    except Exception:
        logger.exception('office network match failed')
        return None


def match_json(m):
    if not m:
        return {'matched': False}
    return {'matched': True, 'fence': m['fence'].name, 'fenceId': m['fence'].id,
            'label': m['label'] or '', 'cidr': m['cidr']}


def describe(m):
    """'Verified by office network (Main Wi-Fi)'."""
    return 'Verified by office network' + (f' ({m["label"]})' if m.get('label') else '')


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
def _err(message, status=400, **extra):
    body = {'message': message}
    body.update(extra)
    return Response(body, status=status)


def _has(request, codes):
    allowed, _e, user = perms.check_perm(request, list(codes))
    return bool(allowed and user)


def _guard(request, codes):
    email, user = perms._get_caller(request)
    if not email or not user or getattr(user, 'status', 'active') != 'active':
        return perms._auth_required(request)
    if not _has(request, codes):
        return _err("You don't have permission to perform this action. Required: " + ' or '.join(codes), 403,
                    code='PERMISSION_DENIED', required=codes[0])
    return None


def _audit(actor, action, detail, fence=None):
    entry = {'at': local_now().strftime('%Y-%m-%d %H:%M:%S'), 'by': actor or '', 'action': action,
             'fence': fence.name if fence is not None else '', 'fenceId': fence.id if fence is not None else None,
             'detail': detail}
    logger.info('attendance networks: %s by %s%s: %s', action, actor or '?',
                f' on {fence.name} (#{fence.id})' if fence is not None else '', detail)
    row, _ = MasterDataSet.objects.get_or_create(key=AUDIT_KEY, defaults={'label': 'Attendance Network Audit',
                                                                          'options': []})
    log = row.options if isinstance(row.options, list) else []
    row.options = ([entry] + log)[:AUDIT_KEEP]
    row.save()


def _state(request):
    pol = network_policy()
    ip = client_ip(request, pol)
    m = match_ip(ip) if ip else None
    fences = GeoFence.objects.filter(owner_email='').order_by('name', 'id')
    audit = MasterDataSet.objects.filter(key=AUDIT_KEY).first()
    return {
        'policy': pol,
        'yourIp': ip,
        'yourIpPrivate': bool(ip) and is_private(ip),
        'remoteAddr': str(_parse_ip(request.META.get('REMOTE_ADDR')) or ''),
        # Shown so an admin can tell a proxy is in front (and what it says);
        # it is NOT used unless trustForwardedFor is on.
        'forwardedFor': str(request.META.get('HTTP_X_FORWARDED_FOR') or '')[:300],
        'yourMatch': ({'fenceId': m['fence'].id, 'fence': m['fence'].name, 'label': m['label'], 'cidr': m['cidr']}
                      if m else None),
        'fences': [{
            'id': f.id, 'name': f.name, 'isActive': bool(f.is_active),
            'networks': [{'cidr': n.get('cidr', ''), 'label': n.get('label', ''),
                          'private': is_private(n.get('cidr', ''))}
                         for n in (f.office_networks or []) if isinstance(n, dict)],
        } for f in fences],
        'canManage': _has(request, WRITE_CODES),
        'limits': {'minPrefixV4': MIN_PREFIX[4], 'minPrefixV6': MIN_PREFIX[6],
                   'maxPerLocation': MAX_NETWORKS_PER_FENCE, 'proxyCount': list(PROXY_COUNT_RANGE)},
        'audit': (audit.options if audit and isinstance(audit.options, list) else [])[:20],
    }


@api_view(['GET', 'PUT'])
def attendance_networks(request):
    if request.method == 'GET':
        denied = _guard(request, READ_CODES)
        if denied:
            return denied
        return Response(_state(request))

    denied = _guard(request, WRITE_CODES)
    if denied:
        return denied
    actor = perms._get_caller(request)[0]
    body = request.data if isinstance(request.data, dict) else {}
    errors, warnings = [], []

    new_policy = None
    if 'policy' in body:
        current = network_policy()
        raw = body.get('policy') if isinstance(body.get('policy'), dict) else {}
        merged = {**current, **{k: v for k, v in raw.items() if k in POLICY_DEFAULTS}}
        new_policy, perr = clean_policy(merged, strict=True)
        for k, msg in perr.items():
            errors.append(f'{k}: {msg}')

    updates = []
    fences_in = body.get('fences')
    if fences_in is not None:
        if not isinstance(fences_in, list):
            errors.append('fences must be a list')
            fences_in = []
        for item in fences_in:
            if not isinstance(item, dict):
                errors.append('Each fence is {"id": ..., "networks": [...]}.')
                continue
            fence = GeoFence.objects.filter(pk=item.get('id'), owner_email='').first()
            if fence is None:
                errors.append(f'Office location {item.get("id")!r} not found (home locations cannot have networks).')
                continue
            entries, warn, errs = clean_networks(item.get('networks'))
            errors.extend(f'{fence.name}: {e}' for e in errs)
            warnings.extend(f'{fence.name}: {w}' for w in warn)
            updates.append((fence, entries))

    if errors:
        return _err(errors[0], 400, errors=errors, code='INVALID_NETWORK')

    # The same network on two locations: allowed (a shared building), but the
    # first location by name wins a match, so say so.
    owner = {}
    planned = {f.id: entries for f, entries in updates}
    for f in GeoFence.objects.filter(owner_email='').order_by('name', 'id'):
        for e in planned.get(f.id, f.office_networks or []):
            c = e.get('cidr') if isinstance(e, dict) else None
            if c and c in owner and owner[c] != f.name:
                warnings.append(f'{c} is listed on both {owner[c]} and {f.name}; check-ins on it are recorded '
                                f'at {owner[c]}.')
            elif c:
                owner.setdefault(c, f.name)

    with transaction.atomic():
        if new_policy is not None:
            before = network_policy()
            if new_policy != before:
                MasterDataSet.objects.update_or_create(
                    key=POLICY_KEY, defaults={'label': 'Attendance Network Policy', 'options': new_policy})
                changed = {k: [before.get(k), new_policy[k]] for k in new_policy if before.get(k) != new_policy[k]}
                _audit(actor, 'policy', ', '.join(f'{k}: {a} → {b}' for k, (a, b) in changed.items()))
        for fence, entries in updates:
            old = {e.get('cidr') for e in (fence.office_networks or []) if isinstance(e, dict)}
            new = {e['cidr'] for e in entries}
            old_labels = {e.get('cidr'): e.get('label', '') for e in (fence.office_networks or []) if isinstance(e, dict)}
            relabelled = [e['cidr'] for e in entries if e['cidr'] in old and old_labels.get(e['cidr'], '') != e['label']]
            if old == new and not relabelled:
                continue
            fence.office_networks = entries
            fence.save(update_fields=['office_networks'])
            parts = []
            if new - old:
                parts.append('added ' + ', '.join(sorted(new - old)))
            if old - new:
                parts.append('removed ' + ', '.join(sorted(old - new)))
            if relabelled:
                parts.append('relabelled ' + ', '.join(sorted(relabelled)))
            _audit(actor, 'networks', '; '.join(parts), fence)

    out = _state(request)
    out['warnings'] = warnings
    return Response(out)
