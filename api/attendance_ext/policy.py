"""Which attendance rules apply to an employee.

    resolve(email) -> Policy      (attribute access, plus .as_dict(), .source)

Resolution, most specific first:
    1. an individual AttendancePolicyAssignment
    2. an active profile whose `departments` contains UserProfile.department
    3. an active profile whose `locations` contains UserProfile.location
    4. the active `is_default` profile
    5. BUILTIN — the defaults below (so an install with no profiles keeps
       working, and the engine has one place to read every rule from)
Several matching profiles at one level: higher `priority`, then lower id.
Matching is case-insensitive and trims whitespace.

Read-only; cheap enough per request. Use `Resolver` to resolve many people
in one batch (loads profiles and assignments once).
"""
from api.models import AttendancePolicyAssignment, AttendancePolicyProfile, UserProfile

FIELDS = (
    'use_shift_hours', 'full_day_minutes', 'half_day_minutes',
    'grace_checkin_minutes', 'grace_early_out_minutes', 'late_half_day_after_minutes',
    'free_lates_per_month', 'count_early_outs', 'penalty_action', 'penalty_leave_types',
    'short_leaves_per_month', 'short_leave_max_minutes', 'regularize_within_days',
    'overtime_after_minutes', 'overtime_daily_cap_minutes', 'overtime_weekly_cap_minutes',
    'overtime_requires_approval', 'comp_off_enabled', 'comp_off_half_day_minutes',
    'comp_off_full_day_minutes', 'comp_off_leave_type', 'comp_off_expiry_days',
)
# Built-in defaults = the model field defaults (one source of truth).
BUILTIN = {f: AttendancePolicyProfile._meta.get_field(f).get_default() for f in FIELDS}
BUILTIN['penalty_leave_types'] = ['Casual Leave']
PENALTY_ACTIONS = ('half_day_leave', 'lop_half_day', 'warning')


class Policy:
    def __init__(self, values, profile=None, source='builtin'):
        self._v = dict(values)
        self.profile = profile
        self.profile_id = profile.id if profile else None
        self.name = profile.name if profile else 'Built-in defaults'
        self.source = source              # assignment | department | location | default | builtin

    def __getattr__(self, k):
        try:
            return self.__dict__['_v'][k]
        except KeyError:
            raise AttributeError(k)

    def as_dict(self):
        return dict(self._v, profileId=self.profile_id, profileName=self.name, source=self.source)


def _norm(s):
    return str(s or '').strip().lower()


def _values(profile):
    v = {f: getattr(profile, f) for f in FIELDS}
    if not v['penalty_leave_types']:
        v['penalty_leave_types'] = list(BUILTIN['penalty_leave_types'])
    if v['penalty_action'] not in PENALTY_ACTIONS:
        v['penalty_action'] = BUILTIN['penalty_action']
    return v


class Resolver:
    def __init__(self):
        self._profiles = list(AttendancePolicyProfile.objects.filter(is_active=True).order_by('-priority', 'id'))
        self._by_id = {p.id: p for p in self._profiles}
        self._assign = {_norm(a.email): a.profile_id for a in AttendancePolicyAssignment.objects.all()}
        self._cache = {}

    def _pick(self, attr, value):
        value = _norm(value)
        if not value:
            return None
        for p in self._profiles:
            if value in {_norm(x) for x in (getattr(p, attr) or [])}:
                return p
        return None

    def resolve(self, email, profile_row=None):
        key = _norm(email)
        if key in self._cache:
            return self._cache[key]
        pol = None
        pid = self._assign.get(key)
        if pid and pid in self._by_id:
            pol = Policy(_values(self._by_id[pid]), self._by_id[pid], 'assignment')
        if pol is None:
            prof = profile_row or UserProfile.objects.filter(email__iexact=key).only('department', 'location').first()
            if prof is not None:
                p = self._pick('departments', prof.department)
                if p:
                    pol = Policy(_values(p), p, 'department')
                else:
                    p = self._pick('locations', prof.location)
                    if p:
                        pol = Policy(_values(p), p, 'location')
        if pol is None:
            d = next((p for p in self._profiles if p.is_default), None)
            pol = Policy(_values(d), d, 'default') if d else Policy(BUILTIN, None, 'builtin')
        self._cache[key] = pol
        return pol


def resolve(email):
    return Resolver().resolve(email)


# ---------------------------------------------------------------------------
# "Who gets which profile" (settings preview) — additive, read-only
# ---------------------------------------------------------------------------
DRAFT_ID = -1          # profileId of an unsaved draft in preview() results


def employees():
    """{email: UserProfile} of every employee whose account is not disabled."""
    from api.models import AppUser
    inactive = {_norm(e) for e in AppUser.objects.exclude(status='active').values_list('email', flat=True)}
    return {_norm(p.email): p for p in UserProfile.objects.all().only(
        'email', 'first_name', 'last_name', 'department', 'location', 'employee_id')
        if _norm(p.email) and _norm(p.email) not in inactive}


def preview(draft=None, people=None):
    """[(email, UserProfile, Policy)] for every employee, as the rules stand —
    or as they WOULD stand with ``draft`` (a profile being edited, not saved:
    {id?, name, departments, locations, is_default, priority, is_active})
    in place of its stored version. Nothing is written."""
    r = Resolver()
    if draft:
        did = draft.get('id')
        try:
            did = int(did) if did not in (None, '') else None
        except (TypeError, ValueError):
            did = None
        base = r._by_id.get(did) if did else None
        p = AttendancePolicyProfile(**{f: getattr(base, f) for f in FIELDS}) if base else AttendancePolicyProfile()
        p.id = did if base else DRAFT_ID
        p.name = str(draft.get('name') or (base.name if base else 'New profile'))
        for k in ('departments', 'locations'):
            v = draft.get(k)
            setattr(p, k, [str(x) for x in v] if isinstance(v, list) else (getattr(base, k) if base else []))
        p.is_default = bool(draft.get('is_default', base.is_default if base else False))
        p.is_active = bool(draft.get('is_active', base.is_active if base else True))
        try:
            p.priority = int(draft.get('priority', base.priority if base else 0) or 0)
        except (TypeError, ValueError):
            p.priority = 0
        profiles = [x for x in r._profiles if x.id != p.id]
        if p.is_default:
            for x in profiles:
                x.is_default = False
        if p.is_active:
            profiles.append(p)
        profiles.sort(key=lambda x: (-x.priority, x.id if x.id and x.id > 0 else 10 ** 9))
        r._profiles = profiles
        r._by_id = {x.id: x for x in profiles}
    people = people if people is not None else employees()
    return [(e, prof, r.resolve(e, prof)) for e, prof in sorted(people.items())]
