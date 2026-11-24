"""Masking and gated reveal of sensitive identifiers (see api/fields.py for the
encryption at rest).

* ``mask(value, kind)`` — the only representation an API returns by default.
  Masking happens here on the server; the full value never reaches the browser
  unless it is explicitly revealed.
* ``is_masked_input(value)`` — a form that shows the mask and saves it back must
  not overwrite the stored value with the mask; such values are ignored.
* ``MaskedFieldsMixin`` — serializer mixin doing both for model serializers.
* ``scrub(dict)`` — masks identifiers in audit ``changes`` (also applied when
  old audit rows are read back).
* ``reveal`` — POST /api/sensitive/<entity>/<pk>/reveal {"field": ...}: one value
  of one record, for a caller holding the entity's permission AND a fresh
  sign-in token; every reveal writes a PayrollAuditLog row (never the value).
"""
import re

from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .fields import LOCKED_MASK, is_locked, plain
from .secret_box import PREFIX, SecretsNotConfigured

MASK_CHARS = ('•', '*', '●', '∙', '…')


def _compact(value):
    return re.sub(r'\s+', '', str(value or ''))


def mask(value, kind='tail'):
    """Masked representation. Blank stays blank; an undecryptable value is
    ``LOCKED_MASK``."""
    if value is None or value == '':
        return ''
    if is_locked(value):
        return LOCKED_MASK
    s = _compact(value)
    if not s:
        return ''
    if kind == 'pan':
        s = s.upper()
        return (s[:2] + '•••••' + s[-3:]) if len(s) == 10 else _tail(s, 3)
    if kind == 'aadhaar':
        return 'XXXX XXXX ' + s[-4:] if len(s) > 4 else '•' * len(s)
    if kind == 'ssn':
        d = re.sub(r'\D', '', s)
        return '***-**-' + d[-4:] if len(d) > 4 else '•' * len(s)
    if kind == 'passport':
        return _tail(s.upper(), 3)
    return _tail(s, 4)          # account / uan / pf / tail


def _tail(s, keep):
    if len(s) <= keep + 2:
        return '•' * len(s)
    return '••••' + s[-keep:]


def is_masked_input(value):
    """True when a submitted value is (or contains) a mask, e.g. the edit form
    sent back what it was shown."""
    if not isinstance(value, str):
        return False
    s = value.strip()
    return bool(s) and (any(c in s for c in MASK_CHARS) or s == LOCKED_MASK or s.upper().startswith('XXXX'))


def check_input(value, max_len, label):
    """Validate a new plain value; raises serializers.ValidationError."""
    s = str(value or '').strip()
    if s.startswith(PREFIX):
        raise serializers.ValidationError(f'{label}: invalid value.')
    if len(s) > max_len:
        raise serializers.ValidationError(f'{label} must be at most {max_len} characters.')
    return s


# field name -> (mask kind, max plain length, label)
FIELD_SPECS = {
    'pan_number': ('pan', 20, 'PAN'),
    'uan_number': ('uan', 20, 'UAN'),
    'pf_account_number': ('pf', 60, 'PF account number'),
    'bank_account_number': ('account', 40, 'Bank account number'),
    'account_number': ('account', 64, 'Account number'),
    'passport_no': ('passport', 40, 'Passport number'),
}

# camelCase / alternative keys that may appear in request bodies or audit rows
_ALIASES = {
    'panNumber': 'pan_number', 'pan': 'pan_number', 'uanNumber': 'uan_number', 'uan': 'uan_number',
    'pfAccountNumber': 'pf_account_number', 'bankAccountNumber': 'bank_account_number',
    'accountNumber': 'account_number', 'account_no': 'account_number', 'bank_account_no': 'bank_account_number',
    'passportNo': 'passport_no', 'passport_number': 'passport_no',
}


def spec_for_key(key):
    k = _ALIASES.get(key, key)
    return FIELD_SPECS.get(k)


def scrub(data):
    """A copy of ``data`` (dict/list, nested) with identifier values masked."""
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            spec = spec_for_key(str(k))
            if spec and isinstance(v, (str, int)) and not isinstance(v, bool):
                out[k] = mask(str(v), spec[0])
            else:
                out[k] = scrub(v)
        return out
    if isinstance(data, (list, tuple)):
        return [scrub(v) for v in data]
    return data


class MaskedFieldsMixin:
    """For ModelSerializers over models with encrypted identifier fields.

    ``masked_fields`` = model field names. On output they are masked (and a
    ``has_<field>`` flag is added); on input a masked value is ignored (the
    stored value is kept), and new values are length-checked against the
    original column widths.
    """
    masked_fields = ()

    def to_representation(self, instance):
        data = super().to_representation(instance)
        for f in self.masked_fields:
            if f in data:
                raw = getattr(instance, f, '')
                data[f] = mask(raw, FIELD_SPECS[f][0])
                data['has_' + f] = bool(raw)
        return data

    def validate(self, attrs):
        attrs = super().validate(attrs)
        for f in self.masked_fields:
            if f not in attrs:
                continue
            v = attrs[f]
            if is_masked_input(v):
                attrs.pop(f)
                continue
            kind, max_len, label = FIELD_SPECS[f]
            attrs[f] = check_input(v, max_len, label)
        return attrs


def clean_incoming(value, current, field):
    """For hand-written views: the value to store for ``field`` given what the
    client sent (``None`` = not sent). A masked value keeps ``current``."""
    if value is None or is_masked_input(value):
        return current
    kind, max_len, label = FIELD_SPECS[field]
    return check_input(value, max_len, label)


# ── reveal ───────────────────────────────────────────────────────────────
def _registry():
    from .models import (BenchSalesProfile, EmployeeCompensation, PayrollInformation, PayrollPayment, Payslip)
    payroll_ids = ('pan_number', 'uan_number', 'pf_account_number', 'bank_account_number')
    return {
        'compensation': (EmployeeCompensation, payroll_ids, 'payroll.manage'),
        'payslip': (Payslip, payroll_ids, 'payroll.manage'),
        'payment': (PayrollPayment, ('account_number',), 'payroll.manage'),
        'onboarding-payroll': (PayrollInformation, ('account_number',), 'onboarding.payroll'),
        'bench-sales': (BenchSalesProfile, ('passport_no',), 'recruitment.edit'),
    }


@api_view(['POST'])
def reveal(request, entity, pk):
    """Return one full identifier. Permission + fresh sign-in + audit."""
    from .payroll_ext import security
    reg = _registry()
    if entity not in reg:
        return Response({'message': 'Unknown record type.', 'code': 'NOT_FOUND'}, status=404)
    model, allowed, perm = reg[entity]
    email, user, denied = security.require(request, perm, fresh=True)
    if denied:
        return denied
    field = str((request.data or {}).get('field') or '').strip()
    field = _ALIASES.get(field, field)
    if field not in allowed:
        return Response({'message': f'Field must be one of: {", ".join(allowed)}.', 'code': 'BAD_FIELD'}, status=400)
    row = model.objects.only('pk', field).filter(pk=pk).first()
    if row is None:
        return Response({'message': 'Record not found.', 'code': 'NOT_FOUND'}, status=404)
    try:
        value = plain(getattr(row, field))
    except SecretsNotConfigured as e:
        return Response({'message': str(e), 'code': 'SECRETS_NOT_CONFIGURED'}, status=503)
    security.audit('sensitive_value_revealed', model.__name__, pk, request=request, email=email,
                   name=security.display_name(user, email),
                   changes={'field': field, 'entity': entity}, notes='Full value revealed (value not logged).')
    resp = Response({'entity': entity, 'id': pk, 'field': field, 'value': value or ''})
    resp['Cache-Control'] = 'no-store'
    resp['Pragma'] = 'no-cache'
    return resp
