"""Connected banking for salary payouts: ICICI / HDFC corporate API adapters,
a simulated test bank, maker-checker payout batches with OTP release, real-time
reconciliation from signed bank webhooks and re-queueing of failed transfers.

IMPORTANT — what is and is not verified
---------------------------------------
``IciciCibProvider`` and ``HdfcProvider`` follow the banks' published
API-banking *patterns* (hybrid RSA + AES payload encryption, mTLS with the
corporate's client certificate, API-key / OAuth headers, unique request ids,
status inquiry by our reference). The exact field names, transaction-type
codes, padding modes and URLs differ per bank programme and per corporate
onboarding. They MUST be validated in the bank's UAT sandbox with the
bank-issued certificates, IP whitelisting and field mappings before a
provider is switched to ``live``. In ``test`` mode a bank adapter never opens
a network connection: transfers are answered by the simulated bank.

Security model (see api/payroll_ext/security.py)
------------------------------------------------
* every user endpoint calls ``security.require`` — money / credential
  operations with ``fresh=True`` (a valid sign-in token for the same person);
* maker-checker: the preparer of a batch can never release it (a single
  Super Admin may, only when they are the ONLY Super Admin and the payroll
  setting ``payout_allow_single_admin_self_release`` is ``true``);
* release, re-queue and bank-detail changes need an emailed one-time code;
* account numbers are stored sealed (Fernet) with last-4 only in clear and
  are masked in every response, audit entry and log;
* webhooks: HMAC-SHA256 over ``"{timestamp}.{raw body}"`` with a 5-minute
  window, optional IP allow-list, replayed event ids are ignored;
* idempotency: a transaction is "claimed" (queued → sent) with a conditional
  UPDATE before it is submitted, so it can never be sent twice; prepare and
  re-queue use unique idempotency keys.
"""
import base64
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import tempfile
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation

import requests
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from . import security as sec

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 10                      # seconds — every outbound bank call
BANK_PROVIDERS = ('icici', 'hdfc')
PAYOUT_PROVIDERS = ('icici', 'hdfc', 'simulated')
ALL_INTEGRATIONS = ('icici', 'hdfc', 'twilio', 'slack')

PERM_PREPARE = 'payroll.payout.prepare'
PERM_RELEASE = 'payroll.payout.release'
PERM_INTEGRATIONS = 'payroll.integrations'
PERM_ANY_BANKING = (PERM_PREPARE, PERM_RELEASE, PERM_INTEGRATIONS)

FAILURE_CODES = {
    'ACCOUNT_FROZEN': 'Beneficiary account is frozen',
    'INVALID_IFSC': 'Invalid IFSC code',
    'ACCOUNT_CLOSED': 'Beneficiary account is closed',
    'INVALID_ACCOUNT': 'Invalid beneficiary account number',
    'NAME_MISMATCH': 'Beneficiary name does not match the account',
    'LIMIT_EXCEEDED': 'Transfer limit exceeded for this mode',
    'NOT_FOUND': 'The bank has no record of this transfer',
    'BANK_REJECTED': 'The bank rejected the transfer',
}

_ACCOUNT_RE = re.compile(r'^\d{9,18}$')
_CODE_RE = re.compile(r'^\d{6}$')
_IDEM_RE = re.compile(r'^[A-Za-z0-9_\-]{8,64}$')
_REF_RE = re.compile(r'^[A-Za-z0-9_\-:.]{1,64}$')


# ══════════════════════════════════════════════════════════════════════════
# helpers
# ══════════════════════════════════════════════════════════════════════════
def _money(v):
    try:
        return Decimal(str(v)).quantize(Decimal('0.01'))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _setting(key, default=''):
    from ..models import PayrollSetting
    v = PayrollSetting.objects.filter(key=key).values_list('value', flat=True).first()
    return default if v in (None, '') else v


def _setting_bool(key, default=False):
    v = _setting(key, '')
    if v == '':
        return default
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


def _setting_money(key, default):
    m = _money(_setting(key, ''))
    return m if m is not None and m > 0 else Decimal(str(default))


_LONG_DIGITS = re.compile(r'\d{9,}')


def scrub(text, extra_secrets=()):
    """Remove anything that looks like an account number and any known secret
    value from text that will be stored, logged or returned."""
    s = str(text or '')
    for val in extra_secrets:
        if val and isinstance(val, str) and len(val) >= 6:
            s = s.replace(val, '[redacted]')
    s = _LONG_DIGITS.sub(lambda m: sec.mask_account(m.group(0)), s)
    return s[:255]


def _data(request):
    try:
        d = request.data
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _err(message, status, code=None, **extra):
    return sec._msg(message, status, code, **extra)


class ProviderError(Exception):
    """A bank refused / could not take a request. ``definitive`` means the
    bank has certainly NOT executed the transfer (safe to mark failed)."""

    def __init__(self, code, reason, definitive=True):
        super().__init__(f'{code}: {reason}')
        self.code = str(code or 'BANK_REJECTED')[:40]
        self.reason = scrub(reason)
        self.definitive = definitive


class ConfigError(Exception):
    pass


# ══════════════════════════════════════════════════════════════════════════
# hybrid encryption (RSA session key + AES-CBC payload)
# ══════════════════════════════════════════════════════════════════════════
def _load_public_key(pem_text):
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    data = pem_text.encode() if isinstance(pem_text, str) else pem_text
    if b'BEGIN CERTIFICATE' in data:
        return x509.load_pem_x509_certificate(data).public_key()
    return serialization.load_pem_public_key(data)


def _load_private_key(pem_text, passphrase=None):
    from cryptography.hazmat.primitives import serialization
    data = pem_text.encode() if isinstance(pem_text, str) else pem_text
    pw = passphrase.encode() if passphrase else None
    return serialization.load_pem_private_key(data, password=pw)


def _rsa_padding(name):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    if str(name or '').upper() in ('OAEP', 'OAEP-SHA1'):
        return padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA1()), algorithm=hashes.SHA1(), label=None)
    if str(name or '').upper() == 'OAEP-SHA256':
        return padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    return padding.PKCS1v15()


def hybrid_encrypt(payload, recipient_public_pem, rsa_padding='PKCS1v15', key_bytes=32, request_id=None):
    """Encrypt ``payload`` (dict) for the recipient. A fresh random AES session
    key (``key_bytes``: 16 or 32) encrypts the JSON with AES-CBC/PKCS7 and a
    random IV prepended to the ciphertext; the session key is RSA-encrypted
    with the recipient's public key / certificate. Returns the envelope used
    by API-banking gateways (base64 fields)."""
    from cryptography.hazmat.primitives import padding as sym_padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    if int(key_bytes) not in (16, 24, 32):
        raise ConfigError('AES key size must be 16, 24 or 32 bytes.')
    session_key = os.urandom(int(key_bytes))
    iv = os.urandom(16)
    raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    padder = sym_padding.PKCS7(128).padder()
    padded = padder.update(raw) + padder.finalize()
    enc = Cipher(algorithms.AES(session_key), modes.CBC(iv)).encryptor()
    ciphertext = enc.update(padded) + enc.finalize()
    pub = _load_public_key(recipient_public_pem)
    enc_key = pub.encrypt(session_key, _rsa_padding(rsa_padding))
    return {
        'requestId': request_id or secrets.token_hex(12),
        'service': 'PaymentApi',
        'encryptedKey': base64.b64encode(enc_key).decode(),
        'oaepHashingAlgorithm': 'NONE' if str(rsa_padding).upper() == 'PKCS1V15' else str(rsa_padding).upper(),
        'iv': '',
        'encryptedData': base64.b64encode(iv + ciphertext).decode(),
        'clientInfo': '',
        'optionalParam': '',
    }


def hybrid_decrypt(envelope, private_pem, rsa_padding='PKCS1v15', passphrase=None):
    """Inverse of ``hybrid_encrypt`` with OUR private key. Accepts the IV in
    a separate ``iv`` field or prepended to ``encryptedData``."""
    from cryptography.hazmat.primitives import padding as sym_padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    try:
        priv = _load_private_key(private_pem, passphrase)
        session_key = priv.decrypt(base64.b64decode(envelope['encryptedKey']), _rsa_padding(rsa_padding))
        blob = base64.b64decode(envelope['encryptedData'])
        iv_field = envelope.get('iv') or ''
        if iv_field:
            iv, ciphertext = base64.b64decode(iv_field), blob
        else:
            iv, ciphertext = blob[:16], blob[16:]
        dec = Cipher(algorithms.AES(session_key), modes.CBC(iv)).decryptor()
        padded = dec.update(ciphertext) + dec.finalize()
        unpadder = sym_padding.PKCS7(128).unpadder()
        raw = unpadder.update(padded) + unpadder.finalize()
        return json.loads(raw.decode('utf-8'))
    except Exception:
        # Never echo key material or ciphertext in the error.
        raise ProviderError('DECRYPT_FAILED', 'Could not decrypt the bank response', definitive=False)


# ══════════════════════════════════════════════════════════════════════════
# certificates on disk (optional alternative to PEM text)
# ══════════════════════════════════════════════════════════════════════════
def cert_dir():
    return os.path.realpath(os.environ.get('HRMS_BANK_CERT_DIR') or os.path.join(os.path.expanduser('~'), '.hrms', 'certs'))


def _read_cert_path(path):
    """Read a PEM file, only from inside HRMS_BANK_CERT_DIR (default
    ~/.hrms/certs) and only .pem/.crt/.cer/.key files."""
    if not path:
        return ''
    base = cert_dir()
    full = os.path.realpath(os.path.join(base, path))
    if not (full == base or full.startswith(base + os.sep)):
        raise ConfigError('Certificate paths must be inside the bank certificate folder.')
    if os.path.splitext(full)[1].lower() not in ('.pem', '.crt', '.cer', '.key'):
        raise ConfigError('Certificate files must be .pem, .crt, .cer or .key.')
    if not os.path.isfile(full):
        raise ConfigError('A configured certificate file was not found.')
    with open(full, 'r', encoding='utf-8') as fh:
        return fh.read()


@contextmanager
def _mtls_files(cert_pem, key_pem, passphrase=None):
    """requests needs file paths for client certificates: write owner-only
    temp files and always delete them."""
    if not cert_pem or not key_pem:
        yield None
        return
    from cryptography.hazmat.primitives import serialization
    key = _load_private_key(key_pem, passphrase)
    key_bytes = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption())
    paths = []
    try:
        for content in (cert_pem.encode() if isinstance(cert_pem, str) else cert_pem, key_bytes):
            fd, p = tempfile.mkstemp(suffix='.pem')
            paths.append(p)
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
            with os.fdopen(fd, 'wb') as fh:
                fh.write(content)
        yield (paths[0], paths[1])
    finally:
        for p in paths:
            try:
                os.remove(p)
            except OSError:
                pass


# ══════════════════════════════════════════════════════════════════════════
# providers
# ══════════════════════════════════════════════════════════════════════════
_STATUS_MAP = {
    'SUCCESS': 'success', 'S': 'success', 'COMPLETED': 'success', 'CREDITED': 'success', 'PAID': 'success',
    'PROCESSED': 'success',
    'FAILED': 'failed', 'FAILURE': 'failed', 'F': 'failed', 'REJECTED': 'failed', 'RETURNED': 'failed',
    'REVERSED': 'failed', 'CANCELLED': 'failed',
}


def norm_status(v):
    return _STATUS_MAP.get(str(v or '').strip().upper(), 'sent')


def _first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ''):
            return d.get(k)
    return ''


def normalise_event(d):
    """Map a bank callback / status record onto our fields (aliases cover the
    usual API-banking names; extend ``field_map`` in public config if needed)."""
    status = norm_status(_first(d, 'status', 'STATUS', 'txnStatus', 'TXNSTATUS', 'transactionStatus'))
    code = str(_first(d, 'failure_code', 'failureCode', 'ERRORCODE', 'errorCode', 'responseCode') or '')
    if status == 'success':
        code = ''
    reason = str(_first(d, 'failure_reason', 'failureReason', 'MESSAGE', 'message', 'errorMessage', 'reason') or '')
    if status == 'failed' and not code:
        code = 'BANK_REJECTED'
    if status == 'failed' and not reason:
        reason = FAILURE_CODES.get(code.upper(), 'The bank rejected the transfer')
    return {
        'client_ref': str(_first(d, 'client_ref', 'clientRef', 'UNIQUEID', 'uniqueId', 'UNIQUE_ID', 'referenceId',
                                 'customerRefNo', 'CUSTREFNO') or '')[:64],
        'provider_ref': str(_first(d, 'provider_ref', 'providerRef', 'REQID', 'reqId', 'bankRef', 'BANKREFNO') or '')[:100],
        'status': status,
        'utr': re.sub(r'[^A-Za-z0-9]', '', str(_first(d, 'utr', 'UTR', 'UTRNUMBER', 'utrNumber', 'utrNo') or ''))[:40],
        'failure_code': re.sub(r'[^A-Za-z0-9_]', '', code.upper())[:40],
        'failure_reason': scrub(reason) if status == 'failed' else '',
        'debited_at': str(_first(d, 'debited_at', 'debitedAt', 'TXNDATE', 'txnDate', 'valueDate') or ''),
    }


class BankProvider:
    """Interface every payout provider implements."""
    name = 'base'

    def __init__(self, config=None, public=None, mode='test', enabled=False):
        self.config = config or {}
        self.public = public or {}
        self.mode = 'live' if mode == 'live' else 'test'
        self.enabled = bool(enabled)

    @property
    def live(self):
        return self.mode == 'live'

    def secret_values(self):
        return [v for v in self.config.values() if isinstance(v, str)]

    def initiate_transfer(self, txn):          # -> {'provider_ref', 'status'}
        raise NotImplementedError

    def fetch_status(self, txn):               # -> {'status','utr','failure_code','failure_reason','debited_at'}
        raise NotImplementedError

    def parse_webhook(self, request, raw_body):   # -> list[event dict]
        try:
            data = json.loads(raw_body.decode('utf-8') or '{}')
        except (ValueError, UnicodeDecodeError):
            raise ProviderError('BAD_PAYLOAD', 'Webhook body is not JSON')
        return self._events_from(data)

    def _events_from(self, data):
        if isinstance(data, dict) and isinstance(data.get('events'), list):
            items = data['events']
        elif isinstance(data, list):
            items = data
        else:
            items = [data]
        return [normalise_event(i) for i in items[:500] if isinstance(i, dict)]

    def validate_config(self):
        """Raise ConfigError for an unusable configuration. Never moves money."""
        return []

    # -- test mode never touches the network --------------------------------
    def _guard_network(self):
        if not self.live:
            raise ConfigError('Test mode: real bank endpoints are never called.')


class SimulatedProvider(BankProvider):
    """Deterministic in-house test bank: accepts every well-formed transfer
    and leaves it 'sent' until ``settle_batch`` marks it success (fake UTR) or
    failed with a realistic code."""
    name = 'simulated'

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.mode = 'test'

    @staticmethod
    def provider_ref(txn):
        return 'SIM' + hashlib.sha256(f'ref:{txn.client_ref}'.encode()).hexdigest()[:13].upper()

    @staticmethod
    def fake_utr(txn):
        digits = str(int(hashlib.sha256(f'utr:{txn.client_ref}'.encode()).hexdigest(), 16))[:12]
        return 'SIMU' + digits.rjust(12, '0')

    def initiate_transfer(self, txn):
        if not sec.is_valid_ifsc(txn.ifsc):
            raise ProviderError('INVALID_IFSC', FAILURE_CODES['INVALID_IFSC'])
        return {'provider_ref': self.provider_ref(txn), 'status': 'sent'}

    def fetch_status(self, txn):
        # The simulator only changes state through settle_batch.
        return {'status': txn.status if txn.status in ('success', 'failed') else 'sent', 'utr': txn.utr,
                'failure_code': txn.failure_code, 'failure_reason': txn.failure_reason, 'debited_at': ''}


class _EncryptedBankProvider(BankProvider):
    """Shared plumbing of the ICICI / HDFC adapters."""
    SECRET_FIELDS = ()
    REQUIRED_SECRET = ()
    REQUIRED_PUBLIC = ()
    default_paths = {}

    def _pem(self, secret_key, path_key):
        return self.config.get(secret_key) or _read_cert_path(self.public.get(path_key, ''))

    def bank_public_pem(self):
        return self._pem('bank_public_cert_pem', 'bank_cert_path')

    def our_private_pem(self):
        return self._pem('client_private_key_pem', 'client_key_path')

    def our_cert_pem(self):
        return self._pem('client_cert_pem', 'client_cert_path')

    def padding_name(self):
        return self.public.get('rsa_padding') or 'PKCS1v15'

    def key_bytes(self):
        try:
            return int(self.public.get('aes_key_bytes') or 32)
        except ValueError:
            return 32

    def url(self, which):
        base = str(self.public.get('base_url') or '').rstrip('/')
        path = str(self.public.get(f'{which}_path') or self.default_paths.get(which, ''))
        if not base.startswith('https://'):
            raise ConfigError('The bank base URL must start with https://')
        return base + '/' + path.lstrip('/')

    def txn_type(self, mode):
        mp = self.public.get('txn_type_map') if isinstance(self.public.get('txn_type_map'), dict) else {}
        return str(mp.get(mode) or {'NEFT': 'NFT', 'RTGS': 'RGS', 'IMPS': 'IFS'}.get(mode, mode))

    def validate_config(self):
        missing = [k for k in self.REQUIRED_SECRET if not self.config.get(k)]
        missing += [k for k in self.REQUIRED_PUBLIC if not self.public.get(k)]
        if not (self.config.get('bank_public_cert_pem') or self.public.get('bank_cert_path')):
            missing.append('bank_public_cert_pem')
        if not (self.config.get('client_private_key_pem') or self.public.get('client_key_path')):
            missing.append('client_private_key_pem')
        if missing:
            raise ConfigError('Missing: ' + ', '.join(sorted(set(missing))))
        try:
            _load_public_key(self.bank_public_pem())
        except ConfigError:
            raise
        except Exception:
            raise ConfigError('The bank public certificate could not be parsed (expected PEM).')
        try:
            _load_private_key(self.our_private_pem(), self.config.get('client_key_passphrase') or None)
        except ConfigError:
            raise
        except Exception:
            raise ConfigError('Our private key could not be parsed (PEM, correct passphrase?).')
        cert = self.our_cert_pem()
        if cert:
            try:
                from cryptography import x509
                x509.load_pem_x509_certificate(cert.encode())
            except Exception:
                raise ConfigError('The client (mTLS) certificate could not be parsed (expected PEM).')
        base = str(self.public.get('base_url') or '')
        if base and not base.startswith('https://'):
            raise ConfigError('The bank base URL must start with https://')
        # Round-trip self-check of the encryption parameters (no network).
        hybrid_encrypt({'ping': 1}, self.bank_public_pem(), self.padding_name(), self.key_bytes())
        return []

    def transfer_payload(self, txn, dry=False):
        raise NotImplementedError

    def status_payload(self, txn):
        raise NotImplementedError

    def headers(self):
        return {'Content-Type': 'application/json', 'Accept': 'application/json',
                'apikey': self.config.get('api_key', ''), 'x-priority': '0100'}

    def _call(self, which, payload, extra_headers=None):
        """Encrypt → POST over mTLS → decrypt. Only ever reached in live mode."""
        self._guard_network()
        env = hybrid_encrypt(payload, self.bank_public_pem(), self.padding_name(), self.key_bytes())
        headers = self.headers()
        headers.update(extra_headers or {})
        try:
            with _mtls_files(self.our_cert_pem(), self.our_private_pem(),
                             self.config.get('client_key_passphrase') or None) as cert:
                resp = requests.post(self.url(which), data=json.dumps(env), headers=headers,
                                     cert=cert, timeout=HTTP_TIMEOUT, verify=True)
        except requests.RequestException as exc:
            raise ProviderError('NETWORK', f'Bank not reachable ({type(exc).__name__})', definitive=False)
        if resp.status_code >= 500:
            raise ProviderError('BANK_UNAVAILABLE', f'Bank returned HTTP {resp.status_code}', definitive=False)
        try:
            body = resp.json()
        except ValueError:
            raise ProviderError('BAD_RESPONSE', f'Bank returned a non-JSON response (HTTP {resp.status_code})',
                                definitive=False)
        if isinstance(body, dict) and body.get('encryptedKey') and body.get('encryptedData'):
            body = hybrid_decrypt(body, self.our_private_pem(), self.padding_name(),
                                  self.config.get('client_key_passphrase') or None)
        if resp.status_code >= 400:
            ev = normalise_event(body if isinstance(body, dict) else {})
            raise ProviderError(ev['failure_code'] or 'BANK_REJECTED',
                                scrub(ev['failure_reason'] or f'HTTP {resp.status_code}', self.secret_values()))
        return body if isinstance(body, dict) else {}

    def initiate_transfer(self, txn):
        if not self.live:
            # Test mode: exercise the payload encryption if keys are present,
            # then answer like the simulator — NEVER a network call.
            if self.config.get('bank_public_cert_pem'):
                try:
                    hybrid_encrypt(self.transfer_payload(txn, dry=True), self.bank_public_pem(),
                                   self.padding_name(), self.key_bytes())
                except Exception:
                    logger.warning('%s test-mode payload encryption failed (check keys)', self.name)
            return SimulatedProvider().initiate_transfer(txn)
        body = self._call('transfer', self.transfer_payload(txn))
        ev = normalise_event(body)
        if ev['status'] == 'failed':
            raise ProviderError(ev['failure_code'], ev['failure_reason'])
        return {'provider_ref': ev['provider_ref'] or txn.client_ref, 'status': ev['status'],
                'utr': ev['utr'], 'debited_at': ev['debited_at']}

    def fetch_status(self, txn):
        if not self.live:
            return SimulatedProvider().fetch_status(txn)
        body = self._call('status', self.status_payload(txn))
        ev = normalise_event(body)
        if str(_first(body, 'RESPONSE', 'response')).upper() == 'FAILURE' and \
                str(_first(body, 'ERRORCODE', 'errorCode')).upper() in ('NOT_FOUND', '404', 'E404'):
            ev.update(status='failed', failure_code='NOT_FOUND', failure_reason=FAILURE_CODES['NOT_FOUND'])
        return ev

    def parse_webhook(self, request, raw_body):
        try:
            data = json.loads(raw_body.decode('utf-8') or '{}')
        except (ValueError, UnicodeDecodeError):
            raise ProviderError('BAD_PAYLOAD', 'Webhook body is not JSON')
        if isinstance(data, dict) and data.get('encryptedKey') and data.get('encryptedData'):
            data = hybrid_decrypt(data, self.our_private_pem(), self.padding_name(),
                                  self.config.get('client_key_passphrase') or None)
        return self._events_from(data)


class IciciCibProvider(_EncryptedBankProvider):
    """ICICI Corporate Internet Banking / Composite Payment API style adapter.

    Request: hybrid-encrypted JSON (random AES session key, AES-CBC/PKCS7 with
    IV prepended, session key RSA-encrypted with ICICI's public certificate —
    PKCS#1 v1.5 by default, OAEP configurable), mTLS with our client
    certificate, ``apikey`` header. Body fields AGGRID / AGGRNAME / CORPID /
    USERID / URN / UNIQUEID / DEBITACC / CREDITACC / IFSC / AMOUNT / TXNTYPE.
    Responses are decrypted with our private key.
    """
    name = 'icici'
    REQUIRED_SECRET = ('api_key', 'debit_account')
    REQUIRED_PUBLIC = ('base_url', 'aggr_id', 'corp_id', 'user_id', 'urn')
    default_paths = {'transfer': '/api/Corporate/CIB/v1/Transaction',
                     'status': '/api/Corporate/CIB/v1/TransactionInquiry'}

    def transfer_payload(self, txn, dry=False):
        p = self.public
        credit = '000000000000' if dry else sec.unseal(txn.account_enc)
        return {
            'AGGRID': p.get('aggr_id', ''), 'AGGRNAME': p.get('aggr_name', ''), 'CORPID': p.get('corp_id', ''),
            'USERID': p.get('user_id', ''), 'URN': p.get('urn', ''), 'UNIQUEID': txn.client_ref,
            'DEBITACC': '' if dry else self.config.get('debit_account', ''), 'CREDITACC': credit,
            'IFSC': txn.ifsc, 'AMOUNT': f'{txn.amount:.2f}', 'CURRENCY': 'INR',
            'TXNTYPE': self.txn_type(txn.mode), 'PAYEENAME': (txn.employee_name or '')[:40],
            'REMARKS': 'Salary', 'WORKFLOW_REQD': 'N',
        }

    def status_payload(self, txn):
        p = self.public
        return {'AGGRID': p.get('aggr_id', ''), 'CORPID': p.get('corp_id', ''), 'USERID': p.get('user_id', ''),
                'URN': p.get('urn', ''), 'UNIQUEID': txn.client_ref}


class HdfcProvider(_EncryptedBankProvider):
    """HDFC API-banking (SmartHub / Enet style) adapter: OAuth2
    client-credentials token over mTLS, then the same hybrid-encrypted payload
    with ``Authorization: Bearer`` + ``apikey`` headers."""
    name = 'hdfc'
    REQUIRED_SECRET = ('client_id', 'client_secret', 'debit_account')
    REQUIRED_PUBLIC = ('base_url', 'corp_id')
    default_paths = {'token': '/oauth/token', 'transfer': '/api/payments/v1/transfer',
                     'status': '/api/payments/v1/status'}

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._token = None

    def access_token(self):
        self._guard_network()
        if self._token:
            return self._token
        try:
            with _mtls_files(self.our_cert_pem(), self.our_private_pem(),
                             self.config.get('client_key_passphrase') or None) as cert:
                resp = requests.post(self.url('token'), data={'grant_type': 'client_credentials',
                                                              'scope': self.public.get('scope', '')},
                                     auth=(self.config.get('client_id', ''), self.config.get('client_secret', '')),
                                     cert=cert, timeout=HTTP_TIMEOUT, verify=True)
        except requests.RequestException as exc:
            raise ProviderError('NETWORK', f'Bank token endpoint not reachable ({type(exc).__name__})',
                                definitive=False)
        if resp.status_code != 200:
            raise ProviderError('AUTH_FAILED', f'Token request refused (HTTP {resp.status_code})', definitive=True)
        try:
            self._token = resp.json().get('access_token') or ''
        except ValueError:
            self._token = ''
        if not self._token:
            raise ProviderError('AUTH_FAILED', 'Token response had no access_token', definitive=True)
        return self._token

    def _call(self, which, payload, extra_headers=None):
        self._guard_network()
        hdr = {'Authorization': 'Bearer ' + self.access_token()}
        hdr.update(extra_headers or {})
        return super()._call(which, payload, hdr)

    def transfer_payload(self, txn, dry=False):
        return {
            'corpId': self.public.get('corp_id', ''), 'customerRefNo': txn.client_ref,
            'debitAccount': '' if dry else self.config.get('debit_account', ''),
            'beneficiaryAccount': '000000000000' if dry else sec.unseal(txn.account_enc),
            'beneficiaryIfsc': txn.ifsc, 'beneficiaryName': (txn.employee_name or '')[:40],
            'amount': f'{txn.amount:.2f}', 'currency': 'INR', 'paymentMode': txn.mode, 'narration': 'Salary',
        }

    def status_payload(self, txn):
        return {'corpId': self.public.get('corp_id', ''), 'customerRefNo': txn.client_ref}


PROVIDER_CLASSES = {'icici': IciciCibProvider, 'hdfc': HdfcProvider, 'simulated': SimulatedProvider}


def get_provider(name):
    if name not in PROVIDER_CLASSES:
        raise ConfigError('Unknown provider.')
    if name == 'simulated':
        return SimulatedProvider()
    cfg, row = sec.get_secret(name)
    return PROVIDER_CLASSES[name](cfg, (row.public_config if row else {}) or {},
                                  row.mode if row else 'test', bool(row and row.enabled))


# ══════════════════════════════════════════════════════════════════════════
# serialisation
# ══════════════════════════════════════════════════════════════════════════
def _iso(v):
    return v.isoformat() if v else None


def txn_json(t):
    return {
        'id': t.id, 'paymentId': t.payment_id, 'email': t.email, 'employeeName': t.employee_name,
        'amount': f'{t.amount:.2f}', 'account': ('••••' + t.account_last4) if t.account_last4 else '',
        'ifsc': t.ifsc, 'mode': t.mode, 'clientRef': t.client_ref, 'providerRef': t.provider_ref, 'utr': t.utr,
        'status': t.status, 'failureCode': t.failure_code, 'failureReason': t.failure_reason, 'attempt': t.attempt,
        'debitedAt': _iso(t.debited_at), 'createdAt': _iso(t.created_at), 'updatedAt': _iso(t.updated_at),
    }


def _counts(batch):
    out = {'queued': 0, 'sent': 0, 'success': 0, 'failed': 0, 'requeued': 0, 'cancelled': 0}
    for s in batch.transactions.values_list('status', flat=True):
        out[s] = out.get(s, 0) + 1
    return out


def batch_json(b, user=None, email='', with_txns=False):
    from ..models import PayrollRun
    run = PayrollRun.objects.filter(id=b.run_id).only('period_label', 'status').first()
    can_release, why = (False, '')
    if user is not None:
        can_release, why = release_allowed(b, user, email)
    out = {
        'id': b.id, 'runId': b.run_id, 'runLabel': run.period_label if run else '', 'runStatus': run.status if run else '',
        'provider': b.provider, 'mode': b.mode, 'status': b.status, 'totalAmount': f'{b.total_amount:.2f}',
        'itemCount': b.item_count, 'createdBy': b.created_by, 'releasedBy': b.released_by,
        'releasedAt': _iso(b.released_at), 'providerBatchRef': b.provider_batch_ref, 'createdAt': _iso(b.created_at),
        'updatedAt': _iso(b.updated_at), 'isFollowUp': b.idempotency_key.startswith('rq-'), 'counts': _counts(b),
        'canRelease': can_release, 'releaseBlockedReason': why,
    }
    if with_txns:
        out['transactions'] = [txn_json(t) for t in b.transactions.all().order_by('id')]
    return out


# ══════════════════════════════════════════════════════════════════════════
# maker-checker
# ══════════════════════════════════════════════════════════════════════════
def _super_admin_count():
    from ..models import AppUser
    return AppUser.objects.filter(status='active').filter(
        Q(role_ref__name='Super Admin') | Q(role_ref__isnull=True, role__iexact='admin')).count()


def release_allowed(batch, user, email):
    """(allowed, reason). Server-side maker-checker."""
    if not sec.has_perm(user, PERM_RELEASE):
        return False, 'You do not have the right to release payouts.'
    if batch.status != 'awaiting_release':
        return False, f'This batch is {batch.status.replace("_", " ")}.'
    if (batch.created_by or '').lower() == (email or '').lower():
        if sec.is_super(user) and _setting_bool('payout_allow_single_admin_self_release') \
                and _super_admin_count() == 1:
            return True, ''
        return False, 'Maker-checker: the person who prepared this batch cannot release it.'
    return True, ''


# ══════════════════════════════════════════════════════════════════════════
# prepare
# ══════════════════════════════════════════════════════════════════════════
def choose_mode(amount, requested=''):
    rtgs_min = _setting_money('payout_rtgs_min', 200000)
    imps_max = _setting_money('payout_imps_max', 500000)
    default = (_setting('payout_default_mode', 'NEFT') or 'NEFT').upper()
    req = str(requested or '').upper()
    if req in ('NEFT', 'RTGS', 'IMPS'):
        if req == 'RTGS' and amount < rtgs_min:
            return 'NEFT'
        if req == 'IMPS' and amount > imps_max:
            return 'RTGS' if amount >= rtgs_min else 'NEFT'
        return req
    if amount >= rtgs_min:
        return 'RTGS'
    if default == 'IMPS' and amount <= imps_max:
        return 'IMPS'
    return 'NEFT'


def _active_payment_ids(run_id):
    from ..models import PayoutTransaction
    return set(PayoutTransaction.objects.filter(batch__run_id=run_id, status__in=('queued', 'sent', 'success'))
               .exclude(batch__status='cancelled').exclude(payment_id=None).values_list('payment_id', flat=True))


from ..fields import is_locked  # noqa: E402


def _clean_account(v):
    return re.sub(r'[\s\-]', '', str(v or ''))


def analyse_run(run):
    """(eligible PayrollPayment list, problems list) for an approved run."""
    from ..models import PayrollPayment
    taken = _active_payment_ids(run.id)
    eligible, problems = [], []
    for p in PayrollPayment.objects.filter(run=run).order_by('employee_name', 'id'):
        if p.id in taken or p.status in ('successful', 'processing'):
            continue
        if p.status not in ('pending', 'failed'):
            continue
        acc = _clean_account(p.account_number)
        issues = []
        if p.amount is None or p.amount <= 0:
            issues.append('Amount is zero or negative')
        if (p.currency or 'INR').upper() != 'INR':
            issues.append(f'Currency {p.currency} cannot be paid through an Indian bank transfer')
        if not acc:
            issues.append('Bank account number missing')
        elif is_locked(p.account_number):
            # Encrypted at rest and the key is missing/changed: never pay to ciphertext.
            issues.append('Bank account number cannot be read (encryption key missing)')
            acc = ''
        elif not _ACCOUNT_RE.match(acc):
            issues.append('Bank account number must be 9–18 digits')
        if not sec.is_valid_ifsc(p.ifsc_or_routing):
            issues.append('IFSC missing or invalid' if p.ifsc_or_routing else 'IFSC missing')
        if issues:
            problems.append({'paymentId': p.id, 'email': p.email, 'employeeName': p.employee_name,
                             'amount': f'{p.amount:.2f}', 'account': sec.mask_account(acc)[-8:] if acc else '',
                             'ifsc': (p.ifsc_or_routing or '')[:20], 'issues': issues})
        else:
            eligible.append(p)
    return eligible, problems


def _ensure_payments(run):
    """Approved run without payment rows → let the existing service create them."""
    from ..models import PayrollPayment
    if not PayrollPayment.objects.filter(run=run).exists():
        from ..services.payroll_service import PayrollService
        PayrollService.create_payment_batch(run.id)


def prepare_batch(run_id, provider_name, email, transfer_mode='', idem_key=''):
    """Returns (batch, problems, replayed). Raises ValueError(message, code)."""
    from ..models import PayoutBatch, PayoutTransaction, PayrollRun
    if provider_name not in PAYOUT_PROVIDERS:
        raise ValueError('Choose a provider: icici, hdfc or simulated.', 'BAD_PROVIDER')
    if idem_key:
        existing = PayoutBatch.objects.filter(idempotency_key=idem_key).first()
        if existing:
            if existing.run_id != run_id:
                raise ValueError('This idempotency key was used for a different run.', 'IDEMPOTENCY_CONFLICT')
            return existing, [], True
    provider = get_provider(provider_name)
    if provider_name in BANK_PROVIDERS and not provider.enabled:
        raise ValueError(f'{provider_name.upper()} is not enabled. Configure it under Integrations first.',
                         'PROVIDER_DISABLED')
    with transaction.atomic():
        run = PayrollRun.objects.select_for_update().filter(id=run_id).first()
        if not run:
            raise ValueError('Pay run not found.', 'NOT_FOUND')
        if run.status != 'approved':
            raise ValueError('Only an APPROVED pay run can be paid out.', 'RUN_NOT_APPROVED')
        _ensure_payments(run)
        eligible, problems = analyse_run(run)
        if not eligible:
            if problems and not _active_payment_ids(run.id):
                raise ValueError('No payment can be prepared — fix the bank details listed.', 'ALL_INVALID')
            raise ValueError('Every payable payment of this run is already in a payout batch or paid'
                             + (' (the rest have bank data problems).' if problems else '.'), 'ALREADY_PREPARED')
        digest = hashlib.sha256(','.join(str(p.id) for p in sorted(eligible, key=lambda x: x.id)).encode()).hexdigest()
        key = idem_key or f'run{run.id}-{digest[:40]}'
        now = timezone.now()
        try:
            with transaction.atomic():
                batch = PayoutBatch.objects.create(
                    run_id=run.id, provider=provider_name, mode=provider.mode, status='awaiting_release',
                    total_amount=sum((p.amount for p in eligible), Decimal('0')), item_count=len(eligible),
                    idempotency_key=key, created_by=email, created_at=now, updated_at=now)
        except IntegrityError:
            raise ValueError('A payout batch for exactly these payments already exists.', 'DUPLICATE_BATCH')
        for p in eligible:
            acc = _clean_account(p.account_number)
            PayoutTransaction.objects.create(
                batch=batch, payment_id=p.id, email=p.email, employee_name=p.employee_name, amount=p.amount,
                account_enc=sec.seal(acc), account_last4=acc[-4:], ifsc=p.ifsc_or_routing.strip().upper(),
                mode=choose_mode(p.amount, transfer_mode), client_ref=new_client_ref(), attempt=1,
                created_at=now, updated_at=now)
    return batch, problems, False


def new_client_ref():
    return 'HRP' + secrets.token_hex(8).upper()


# ══════════════════════════════════════════════════════════════════════════
# release / submission
# ══════════════════════════════════════════════════════════════════════════
def tamper_check(batch):
    """Re-verify the batch against the run before money moves. [] = clean."""
    from ..models import PayrollPayment, PayrollRun
    problems = []
    run = PayrollRun.objects.filter(id=batch.run_id).first()
    if not run or run.status != 'approved':
        problems.append('The pay run is no longer approved.')
    txns = list(batch.transactions.exclude(status='cancelled'))
    total = sum((t.amount for t in txns), Decimal('0'))
    if total != batch.total_amount or len(txns) != batch.item_count:
        problems.append('Batch totals do not match its transactions.')
    if run is not None and batch.idempotency_key.startswith('run') and total > (run.total_net or Decimal('0')) \
            and run.total_net:
        problems.append('Batch total exceeds the approved run net pay.')
    for t in txns:
        pm = PayrollPayment.objects.filter(id=t.payment_id).select_related('entry').first()
        if not pm or pm.run_id != batch.run_id:
            problems.append(f'Transaction {t.id}: payment record missing or belongs to another run.')
            continue
        if pm.amount != t.amount:
            problems.append(f'Transaction {t.id}: amount differs from the payment record.')
        if pm.entry is not None and pm.entry.net_pay != t.amount:
            problems.append(f'Transaction {t.id}: amount differs from the approved net pay.')
        if pm.status == 'successful':
            problems.append(f'Transaction {t.id}: this employee is already paid.')
        try:
            acc = sec.unseal(t.account_enc)
        except Exception:
            acc = ''
        if not acc or acc[-4:] != t.account_last4 or not _ACCOUNT_RE.match(acc):
            problems.append(f'Transaction {t.id}: stored account details failed integrity check.')
        if not sec.is_valid_ifsc(t.ifsc):
            problems.append(f'Transaction {t.id}: invalid IFSC.')
    return problems


def _mark_processing(txn):
    from ..models import PayrollPayment
    pm = PayrollPayment.objects.filter(id=txn.payment_id).select_related('entry').first()
    if pm:
        pm.status = 'processing'
        pm.failure_reason = ''
        pm.save(update_fields=['status', 'failure_reason', 'updated_at'])
        if pm.entry:
            pm.entry.payment_status = 'processing'
            pm.entry.save(update_fields=['payment_status', 'updated_at'])


def submit_batch(batch, provider=None):
    """Send every still-queued transaction exactly once."""
    from ..models import PayoutTransaction
    provider = provider or get_provider(batch.provider)
    summary = {'sent': 0, 'success': 0, 'failed': 0, 'skipped': 0, 'unknown': 0}
    for t in list(batch.transactions.filter(status='queued').order_by('id')):
        now = timezone.now()
        claimed = PayoutTransaction.objects.filter(id=t.id, status='queued').update(status='sent', updated_at=now)
        if not claimed:
            summary['skipped'] += 1
            continue
        t.refresh_from_db()
        _mark_processing(t)
        try:
            res = provider.initiate_transfer(t)
        except ProviderError as exc:
            if exc.definitive:
                apply_event(batch.provider, {'client_ref': t.client_ref, 'status': 'failed', 'utr': '',
                                             'failure_code': exc.code, 'failure_reason': exc.reason,
                                             'provider_ref': '', 'debited_at': ''}, source='submit')
                summary['failed'] += 1
            else:
                PayoutTransaction.objects.filter(id=t.id).update(
                    failure_reason='Submission outcome unknown — use "Poll status" to confirm with the bank.',
                    updated_at=timezone.now())
                summary['unknown'] += 1
            continue
        except Exception as exc:     # never leak details; keep 'sent' so it is never re-sent blindly
            logger.error('payout submit failed for txn %s (%s)', t.id, type(exc).__name__)
            PayoutTransaction.objects.filter(id=t.id).update(
                failure_reason='Submission outcome unknown — use "Poll status" to confirm with the bank.',
                updated_at=timezone.now())
            summary['unknown'] += 1
            continue
        PayoutTransaction.objects.filter(id=t.id).update(provider_ref=str(res.get('provider_ref') or '')[:100],
                                                         updated_at=timezone.now())
        st = res.get('status') or 'sent'
        if st in ('success', 'failed'):
            apply_event(batch.provider, {'client_ref': t.client_ref, 'status': st, 'utr': res.get('utr', ''),
                                         'failure_code': res.get('failure_code', ''),
                                         'failure_reason': res.get('failure_reason', ''),
                                         'provider_ref': res.get('provider_ref', ''),
                                         'debited_at': res.get('debited_at', '')}, source='submit')
            summary[st] += 1
        else:
            summary['sent'] += 1
    batch.refresh_from_db()
    rollup(batch)
    return summary


# ══════════════════════════════════════════════════════════════════════════
# reconciliation
# ══════════════════════════════════════════════════════════════════════════
def _parse_dt(v):
    if not v:
        return None
    dt = parse_datetime(str(v).replace('Z', '+00:00')) if isinstance(v, str) else v
    if dt is None:
        return None
    if settings.USE_TZ and timezone.is_naive(dt):
        dt = timezone.make_aware(dt)
    if not settings.USE_TZ and timezone.is_aware(dt):
        dt = timezone.make_naive(dt)
    return dt


def rollup(batch):
    from ..models import PayoutBatch
    if batch.status in ('draft', 'awaiting_release', 'cancelled'):
        return batch.status
    c = _counts(batch)
    active = sum(v for k, v in c.items() if k != 'cancelled')
    if not active:
        return batch.status
    pending = c['queued'] + c['sent']
    bad = c['failed'] + c['requeued']
    if pending:
        new = 'submitted' if not c['success'] and not bad else 'partially_paid'
    elif c['success'] == active:
        new = 'paid'
    elif not c['success']:
        new = 'failed'
    else:
        new = 'partially_paid'
    if new != batch.status:
        PayoutBatch.objects.filter(id=batch.id).update(status=new, updated_at=timezone.now())
        batch.status = new
    return new


def _maybe_mark_run_paid(run_id):
    from ..models import PayrollPayment, PayrollRun
    run = PayrollRun.objects.filter(id=run_id).first()
    if not run or run.status != 'approved':
        return
    qs = PayrollPayment.objects.filter(run=run)
    if qs.exists() and not qs.exclude(status='successful').exists():
        run.status = 'paid'
        run.save(update_fields=['status', 'updated_at'])
        if run.period_id:
            run.period.status = 'completed'
            run.period.save()


def apply_event(provider_name, ev, source='webhook'):
    """Apply one normalised status event. Returns a short outcome string."""
    from ..models import PayoutTransaction, PayrollPayment
    status = ev.get('status')
    if status not in ('success', 'failed', 'sent'):
        return 'ignored'
    with transaction.atomic():
        q = PayoutTransaction.objects.select_for_update().select_related('batch')
        t = None
        if ev.get('client_ref'):
            t = q.filter(client_ref=ev['client_ref']).first()
        if t is None and ev.get('provider_ref'):
            t = q.filter(provider_ref=ev['provider_ref']).first()
        if t is None:
            return 'unknown_transaction'
        if t.batch.provider != provider_name and source != 'settle':
            return 'provider_mismatch'
        if status == 'sent':
            return 'pending'
        if t.status in ('success', 'requeued', 'cancelled'):
            return 'already_final'        # success is terminal; never double-apply
        if t.status == 'failed' and status == 'failed':
            return 'already_final'
        if t.status not in ('sent', 'queued', 'failed'):
            return 'ignored'
        now = timezone.now()
        if status == 'success':
            utr = ev.get('utr') or ''
            t.status, t.utr = 'success', utr[:40]
            t.failure_code, t.failure_reason = '', ''
            t.debited_at = _parse_dt(ev.get('debited_at')) or now
        else:
            code = (ev.get('failure_code') or 'BANK_REJECTED')[:40]
            t.status = 'failed'
            t.failure_code = code
            t.failure_reason = scrub(ev.get('failure_reason') or FAILURE_CODES.get(code, 'Transfer failed'))
        if ev.get('provider_ref') and not t.provider_ref:
            t.provider_ref = str(ev['provider_ref'])[:100]
        t.updated_at = now
        t.save()
        pm = PayrollPayment.objects.filter(id=t.payment_id).select_related('entry', 'run').first()
        if pm:
            if t.status == 'success':
                pm.status, pm.reference_number, pm.failure_reason = 'successful', t.utr, ''
                pm.disbursed_at = t.debited_at
                pm.disbursed_by = f'{provider_name.upper()} bank API'
            else:
                pm.status = 'failed'
                pm.failure_reason = f'{t.failure_code}: {t.failure_reason}'
            pm.save()
            if pm.entry:
                pm.entry.payment_status = 'paid' if t.status == 'success' else 'failed'
                if t.status == 'success':
                    pm.entry.payment_reference = t.utr[:100]
                pm.entry.save(update_fields=['payment_status', 'payment_reference', 'updated_at'])
        rollup(t.batch)
        if t.status == 'success' and pm:
            _maybe_mark_run_paid(pm.run_id)
            from . import channels
            channels.dispatch(channels.send_salary_credit_alert_by_id, pm.id, t.utr)
        sec.audit('payout_txn_' + t.status, 'PayoutTransaction', t.id, email=f'{source}:{provider_name}',
                  changes={'status': t.status, 'utr': t.utr, 'failureCode': t.failure_code, 'batch': t.batch_id,
                           'account': '••••' + t.account_last4})
        return t.status


def poll_batch(batch):
    from ..models import PayoutTransaction
    provider = get_provider(batch.provider)
    out = {'checked': 0, 'success': 0, 'failed': 0, 'pending': 0, 'errors': 0}
    for t in list(batch.transactions.filter(status='sent').order_by('id')):
        out['checked'] += 1
        try:
            st = provider.fetch_status(t)
        except ProviderError:
            out['errors'] += 1
            continue
        except Exception as exc:
            logger.error('payout poll failed for txn %s (%s)', t.id, type(exc).__name__)
            out['errors'] += 1
            continue
        ev = {'client_ref': t.client_ref, 'provider_ref': t.provider_ref, 'status': st.get('status', 'sent'),
              'utr': st.get('utr', ''), 'failure_code': st.get('failure_code', ''),
              'failure_reason': st.get('failure_reason', ''), 'debited_at': st.get('debited_at', '')}
        res = apply_event(batch.provider, ev, source='poll')
        if res in ('success', 'failed'):
            out[res] += 1
        else:
            out['pending'] += 1
            if t.failure_reason.startswith('Submission outcome unknown'):
                PayoutTransaction.objects.filter(id=t.id).update(failure_reason='')
    batch.refresh_from_db()
    rollup(batch)
    return out


def settle_batch(batch, failures=None):
    """Simulated bank only: settle every 'sent' transaction — success with a
    fake UTR, or failure with the chosen code for listed transaction ids."""
    failures = failures or {}
    events = []
    for t in batch.transactions.filter(status='sent').order_by('id'):
        code = failures.get(t.id)
        if code:
            events.append({'client_ref': t.client_ref, 'provider_ref': t.provider_ref, 'status': 'failed',
                           'utr': '', 'failure_code': code, 'failure_reason': FAILURE_CODES.get(code, ''),
                           'debited_at': ''})
        else:
            events.append({'client_ref': t.client_ref, 'provider_ref': t.provider_ref, 'status': 'success',
                           'utr': SimulatedProvider.fake_utr(t), 'failure_code': '', 'failure_reason': '',
                           'debited_at': timezone.now().isoformat()})
    ev_row, _ = sec.record_webhook('simulated', f'settle-{batch.id}-{secrets.token_hex(6)}',
                                   {'batch': batch.id, 'events': [_safe_event(e) for e in events]}, True)
    results = [apply_event(batch.provider, e, source='settle') for e in events]
    if ev_row:
        ev_row.processed = True
        ev_row.save(update_fields=['processed'])
    batch.refresh_from_db()
    rollup(batch)
    return results


def _safe_event(e):
    return {k: e.get(k, '') for k in ('client_ref', 'provider_ref', 'status', 'utr', 'failure_code', 'failure_reason')}


# ══════════════════════════════════════════════════════════════════════════
# re-queue / bank detail changes
# ══════════════════════════════════════════════════════════════════════════
def _validate_bank_details(d):
    acc = _clean_account(d.get('accountNumber'))
    ifsc = str(d.get('ifsc') or '').strip().upper()
    bank = str(d.get('bankName') or '').strip()[:100]
    errors = {}
    if not _ACCOUNT_RE.match(acc):
        errors['accountNumber'] = 'Account number must be 9–18 digits.'
    if not sec.is_valid_ifsc(ifsc):
        errors['ifsc'] = 'IFSC must look like ABCD0123456.'
    if bank and not re.match(r"^[A-Za-z0-9 &.,()'\-]{2,100}$", bank):
        errors['bankName'] = 'Bank name has unsupported characters.'
    return acc, ifsc, bank, errors


def _update_bank_records(pm, acc, ifsc, bank):
    """Keep the existing payroll records in step (EmployeeCompensation drives
    next month's payment rows; PayrollPayment is this run's row)."""
    from ..models import EmployeeCompensation
    pm.account_number, pm.ifsc_or_routing = acc, ifsc
    if bank:
        pm.bank_name = bank
    pm.save()
    comp = EmployeeCompensation.objects.filter(email__iexact=pm.email).order_by('-id').first()
    if comp:
        comp.bank_account_number, comp.ifsc_code = acc, ifsc
        if bank:
            comp.bank_name = bank
        comp.save()


def requeue_txn(txn, acc, ifsc, bank, email):
    """Failed txn → new attempt in a small follow-up batch awaiting release."""
    from ..models import PayoutBatch, PayoutTransaction, PayrollPayment
    with transaction.atomic():
        t = PayoutTransaction.objects.select_for_update().select_related('batch').get(id=txn.id)
        if t.status != 'failed':
            raise ValueError('Only a failed transfer can be re-queued.', 'NOT_FAILED')
        pm = PayrollPayment.objects.filter(id=t.payment_id).first()
        if not pm or pm.status == 'successful':
            raise ValueError('The payment record is missing or already paid.', 'PAYMENT_STATE')
        now = timezone.now()
        try:
            with transaction.atomic():
                batch = PayoutBatch.objects.create(
                    run_id=t.batch.run_id, provider=t.batch.provider, mode=t.batch.mode, status='awaiting_release',
                    total_amount=t.amount, item_count=1, idempotency_key=f'rq-{t.id}-{t.attempt + 1}',
                    created_by=email, created_at=now, updated_at=now)
        except IntegrityError:
            raise ValueError('This transfer was already re-queued.', 'DUPLICATE_REQUEUE')
        _update_bank_records(pm, acc, ifsc, bank)
        pm.status, pm.failure_reason = 'pending', ''
        pm.save(update_fields=['status', 'failure_reason', 'updated_at'])
        new = PayoutTransaction.objects.create(
            batch=batch, payment_id=t.payment_id, email=t.email, employee_name=t.employee_name, amount=t.amount,
            account_enc=sec.seal(acc), account_last4=acc[-4:], ifsc=ifsc, mode=choose_mode(t.amount, t.mode),
            client_ref=new_client_ref(), attempt=t.attempt + 1, created_at=now, updated_at=now)
        t.status, t.updated_at = 'requeued', now
        t.save(update_fields=['status', 'updated_at'])
        rollup(t.batch)
    return batch, new


# ══════════════════════════════════════════════════════════════════════════
# HTTP views — payouts
# ══════════════════════════════════════════════════════════════════════════
def _meta_payload(user, email):
    providers = {}
    for p in BANK_PROVIDERS:
        m = sec.secret_meta(p)
        providers[p] = {'configured': m['configured'], 'enabled': m['enabled'], 'mode': m['mode']}
    providers['simulated'] = {'configured': True, 'enabled': True, 'mode': 'test'}
    return {
        'me': email,
        'canPrepare': sec.has_perm(user, PERM_PREPARE),
        'canRelease': sec.has_perm(user, PERM_RELEASE),
        'canIntegrations': sec.has_perm(user, PERM_INTEGRATIONS),
        'providers': providers,
        'failureCodes': FAILURE_CODES,
        'settings': {
            'rtgsMin': f"{_setting_money('payout_rtgs_min', 200000):.2f}",
            'impsMax': f"{_setting_money('payout_imps_max', 500000):.2f}",
            'defaultMode': (_setting('payout_default_mode', 'NEFT') or 'NEFT').upper(),
        },
    }


@api_view(['GET'])
def meta_view(request):
    email, user, err = sec.require(request, PERM_ANY_BANKING)
    if err:
        return err
    return Response(_meta_payload(user, email))


@api_view(['GET'])
def runs_view(request):
    from ..models import PayoutBatch, PayrollPayment, PayrollRun
    email, user, err = sec.require(request, PERM_ANY_BANKING)
    if err:
        return err
    out = []
    for r in PayrollRun.objects.filter(status__in=('approved', 'paid')).order_by('-period_start')[:24]:
        pays = PayrollPayment.objects.filter(run=r)
        out.append({'id': r.id, 'label': r.period_label, 'status': r.status, 'totalNet': f'{r.total_net:.2f}',
                    'employees': r.employee_count, 'payments': pays.count(),
                    'paid': pays.filter(status='successful').count(),
                    'batches': PayoutBatch.objects.filter(run_id=r.id).count(),
                    'periodStart': _iso(r.period_start), 'payDate': _iso(r.pay_date)})
    return Response({'runs': out})


def _int(v):
    try:
        i = int(v)
        return i if i > 0 else None
    except (TypeError, ValueError):
        return None


@api_view(['GET'])
def run_preview_view(request, run_id):
    from ..models import PayrollRun
    email, user, err = sec.require(request, PERM_PREPARE)
    if err:
        return err
    run = PayrollRun.objects.filter(id=run_id).first()
    if not run:
        return _err('Pay run not found.', 404, 'NOT_FOUND')
    from ..models import PayrollPayment
    exists = PayrollPayment.objects.filter(run=run).exists()
    eligible, problems = analyse_run(run) if exists else ([], [])
    mode = request.query_params.get('mode', '')
    return Response({
        'run': {'id': run.id, 'label': run.period_label, 'status': run.status, 'totalNet': f'{run.total_net:.2f}'},
        'paymentsCreated': exists,
        'eligible': [{'paymentId': p.id, 'email': p.email, 'employeeName': p.employee_name,
                      'amount': f'{p.amount:.2f}', 'account': '••••' + _clean_account(p.account_number)[-4:],
                      'ifsc': p.ifsc_or_routing.upper(), 'mode': choose_mode(p.amount, mode)} for p in eligible],
        'eligibleTotal': f"{sum((p.amount for p in eligible), Decimal('0')):.2f}",
        'problems': problems,
    })


@csrf_exempt
@api_view(['POST'])
def prepare_view(request, run_id):
    email, user, err = sec.require(request, PERM_PREPARE, fresh=True)
    if err:
        return err
    d = _data(request)
    provider = str(d.get('provider') or 'simulated').strip().lower()
    mode = str(d.get('transferMode') or '').strip().upper()
    if mode and mode not in ('AUTO', 'NEFT', 'RTGS', 'IMPS'):
        return _err('Transfer mode must be AUTO, NEFT, RTGS or IMPS.', 400, 'BAD_MODE')
    idem = str(request.META.get('HTTP_IDEMPOTENCY_KEY') or d.get('idempotencyKey') or '').strip()
    if idem and not _IDEM_RE.match(idem):
        return _err('Idempotency key must be 8–64 letters, digits, - or _.', 400, 'BAD_IDEMPOTENCY_KEY')
    try:
        batch, problems, replayed = prepare_batch(run_id, provider, email, '' if mode == 'AUTO' else mode, idem)
    except ValueError as exc:
        msg, code = exc.args if len(exc.args) == 2 else (str(exc), 'INVALID')
        status = 404 if code == 'NOT_FOUND' else 409 if code in ('ALREADY_PREPARED', 'DUPLICATE_BATCH',
                                                                    'IDEMPOTENCY_CONFLICT') else 400
        extra = {}
        if code in ('ALL_INVALID', 'ALREADY_PREPARED'):
            from ..models import PayrollRun
            extra['problems'] = analyse_run(PayrollRun.objects.get(id=run_id))[1]
        return _err(msg, status, code, **extra)
    except ConfigError as exc:
        return _err(str(exc), 400, 'PROVIDER_CONFIG')
    if not replayed:
        sec.audit('payout_batch_prepared', 'PayoutBatch', batch.id, request, email, sec.display_name(user, email),
                  changes={'run': batch.run_id, 'provider': batch.provider, 'mode': batch.mode,
                           'items': batch.item_count, 'total': f'{batch.total_amount:.2f}',
                           'problems': len(problems)})
    body = {'batch': batch_json(batch, user, email, with_txns=True), 'problems': problems, 'replayed': replayed}
    return Response(body, status=200 if replayed else 201)


@api_view(['GET'])
def batches_view(request):
    from ..models import PayoutBatch
    email, user, err = sec.require(request, PERM_ANY_BANKING)
    if err:
        return err
    qs = PayoutBatch.objects.all()
    run = _int(request.query_params.get('run'))
    if run:
        qs = qs.filter(run_id=run)
    st = request.query_params.get('status', '')
    if st and re.match(r'^[a-z_]{2,20}$', st):
        qs = qs.filter(status=st)
    return Response({'batches': [batch_json(b, user, email) for b in qs.order_by('-id')[:100]]})


@api_view(['GET'])
def batch_detail_view(request, batch_id):
    from ..models import PayoutBatch
    email, user, err = sec.require(request, PERM_ANY_BANKING)
    if err:
        return err
    b = PayoutBatch.objects.filter(id=batch_id).first()
    if not b:
        return _err('Batch not found.', 404, 'NOT_FOUND')
    return Response({'batch': batch_json(b, user, email, with_txns=True)})


OTP_PURPOSES = {
    # purpose key → (ActionOtp purpose, permission, subject, what)
    'release': ('payout_release', PERM_RELEASE, 'Confirm salary payout release', 'release a salary payout batch'),
    'requeue': ('payout_requeue', PERM_PREPARE, 'Confirm bank detail change & re-queue',
                're-queue a failed salary transfer with new bank details'),
    'bank_update': ('payout_bank_update', PERM_PREPARE, 'Confirm bank detail change',
                    "change an employee's bank details for a payout"),
}


@csrf_exempt
@api_view(['POST'])
def otp_view(request):
    """Step 1 of release / re-queue / bank change: email a one-time code."""
    from ..models import PayoutBatch, PayoutTransaction, PayrollPayment
    d = _data(request)
    purpose = str(d.get('purpose') or '')
    if purpose not in OTP_PURPOSES:
        return _err('Unknown confirmation purpose.', 400, 'BAD_PURPOSE')
    otp_purpose, perm, subject, what = OTP_PURPOSES[purpose]
    email, user, err = sec.require(request, perm, fresh=True)
    if err:
        return err
    ref = _int(d.get('id'))
    if not ref:
        return _err('Missing id.', 400, 'BAD_ID')
    if purpose == 'release':
        b = PayoutBatch.objects.filter(id=ref).first()
        if not b:
            return _err('Batch not found.', 404, 'NOT_FOUND')
        ok, why = release_allowed(b, user, email)
        if not ok:
            return _err(why, 403 if 'Maker-checker' in why or 'right' in why else 409, 'RELEASE_BLOCKED')
        what = f'release payout batch #{b.id} ({b.item_count} transfers, ₹{b.total_amount:,.2f})'
    elif purpose == 'requeue':
        t = PayoutTransaction.objects.filter(id=ref).first()
        if not t:
            return _err('Transaction not found.', 404, 'NOT_FOUND')
        if t.status != 'failed':
            return _err('Only a failed transfer can be re-queued.', 409, 'NOT_FAILED')
    else:
        if not PayrollPayment.objects.filter(id=ref).exists():
            return _err('Payment not found.', 404, 'NOT_FOUND')
    res = sec.issue_action_otp(user, otp_purpose, ref, subject=subject, what=what)
    if res.get('code') == 'OTP_RATE_LIMIT':
        return _err(res['message'], 429, 'OTP_RATE_LIMIT')
    sec.audit('payout_otp_requested', 'ActionOtp', f'{otp_purpose}:{ref}', request, email,
              sec.display_name(user, email), changes={'purpose': otp_purpose, 'ref': ref, 'sent': bool(res.get('ok'))})
    if not res.get('ok'):
        return _err(res.get('message') or 'Could not send the code.', 502, 'OTP_SEND_FAILED')
    return Response({'ok': True, 'message': res.get('message'), 'devEcho': bool(res.get('devEcho'))})


def _check_code(d):
    code = str(d.get('code') or '').strip()
    if not _CODE_RE.match(code):
        return None
    return code


@csrf_exempt
@api_view(['POST'])
def release_view(request, batch_id):
    from ..models import PayoutBatch
    email, user, err = sec.require(request, PERM_RELEASE, fresh=True)
    if err:
        return err
    d = _data(request)
    batch = PayoutBatch.objects.filter(id=batch_id).first()
    if not batch:
        return _err('Batch not found.', 404, 'NOT_FOUND')
    ok, why = release_allowed(batch, user, email)
    if not ok:
        sec.audit('payout_release_refused', 'PayoutBatch', batch.id, request, email, sec.display_name(user, email),
                  notes=why)
        return _err(why, 403 if 'Maker-checker' in why or 'right' in why else 409, 'RELEASE_BLOCKED')
    code = _check_code(d)
    if not code:
        return _err('Enter the 6-digit code sent to your email.', 400, 'OTP_REQUIRED')
    provider = get_provider(batch.provider)
    if batch.provider in BANK_PROVIDERS:
        if not provider.enabled:
            return _err(f'{batch.provider.upper()} is disabled.', 409, 'PROVIDER_DISABLED')
        if provider.mode != batch.mode:
            return _err('The provider mode changed since this batch was prepared. Cancel it and prepare again.',
                        409, 'MODE_CHANGED')
    problems = tamper_check(batch)
    if problems:
        sec.audit('payout_tamper_detected', 'PayoutBatch', batch.id, request, email, sec.display_name(user, email),
                  changes={'problems': problems[:20]})
        return _err('Release blocked: the batch no longer matches the approved pay run.', 409, 'TAMPER_CHECK_FAILED',
                    problems=problems[:20])
    good, reason = sec.verify_action_otp(email, 'payout_release', batch.id, code)
    if not good:
        sec.audit('payout_release_otp_failed', 'PayoutBatch', batch.id, request, email, sec.display_name(user, email),
                  notes=reason)
        return _err(reason, 400, 'OTP_INVALID')
    now = timezone.now()
    claimed = PayoutBatch.objects.filter(id=batch.id, status='awaiting_release').update(
        status='submitted', released_by=email, released_at=now, updated_at=now)
    if not claimed:
        return _err('This batch was already released.', 409, 'ALREADY_RELEASED')
    batch.refresh_from_db()
    sec.audit('payout_batch_released', 'PayoutBatch', batch.id, request, email, sec.display_name(user, email),
              changes={'provider': batch.provider, 'mode': batch.mode, 'items': batch.item_count,
                       'total': f'{batch.total_amount:.2f}', 'maker': batch.created_by})
    summary = submit_batch(batch, provider)
    batch.refresh_from_db()
    return Response({'batch': batch_json(batch, user, email, with_txns=True), 'summary': summary})


@csrf_exempt
@api_view(['POST'])
def cancel_view(request, batch_id):
    from ..models import PayoutBatch
    email, user, err = sec.require(request, (PERM_PREPARE, PERM_RELEASE), fresh=True)
    if err:
        return err
    now = timezone.now()
    with transaction.atomic():
        claimed = PayoutBatch.objects.filter(id=batch_id, status='awaiting_release').update(
            status='cancelled', updated_at=now)
        if not claimed:
            return _err('Only a batch awaiting release can be cancelled.', 409, 'NOT_CANCELLABLE')
        b = PayoutBatch.objects.get(id=batch_id)
        b.transactions.filter(status='queued').update(status='cancelled', updated_at=now)
    sec.audit('payout_batch_cancelled', 'PayoutBatch', b.id, request, email, sec.display_name(user, email),
              notes=str(_data(request).get('reason') or '')[:300])
    return Response({'batch': batch_json(b, user, email, with_txns=True)})


@csrf_exempt
@api_view(['POST'])
def poll_view(request, batch_id):
    from ..models import PayoutBatch
    email, user, err = sec.require(request, (PERM_PREPARE, PERM_RELEASE))
    if err:
        return err
    b = PayoutBatch.objects.filter(id=batch_id).first()
    if not b:
        return _err('Batch not found.', 404, 'NOT_FOUND')
    summary = poll_batch(b)
    sec.audit('payout_batch_polled', 'PayoutBatch', b.id, request, email, sec.display_name(user, email),
              changes=summary)
    b.refresh_from_db()
    return Response({'batch': batch_json(b, user, email, with_txns=True), 'summary': summary})


@csrf_exempt
@api_view(['POST'])
def settle_view(request, batch_id):
    """Simulated bank / test mode only."""
    from ..models import PayoutBatch
    email, user, err = sec.require(request, PERM_INTEGRATIONS, fresh=True)
    if err:
        return err
    b = PayoutBatch.objects.filter(id=batch_id).first()
    if not b:
        return _err('Batch not found.', 404, 'NOT_FOUND')
    if b.mode != 'test':
        return _err('Settlement simulation is only available for test-mode batches.', 403, 'LIVE_BATCH')
    raw = _data(request).get('failures') or {}
    if not isinstance(raw, dict):
        return _err('failures must be an object {transactionId: CODE}.', 400, 'BAD_FAILURES')
    failures = {}
    for k, v in list(raw.items())[:500]:
        tid, code = _int(k), str(v or '').upper()
        if not tid or code not in FAILURE_CODES:
            return _err(f'Unknown failure code. Use one of: {", ".join(FAILURE_CODES)}.', 400, 'BAD_FAILURES')
        failures[tid] = code
    results = settle_batch(b, failures)
    sec.audit('payout_batch_simulated_settle', 'PayoutBatch', b.id, request, email, sec.display_name(user, email),
              changes={'settled': len(results), 'failures': {str(k): v for k, v in failures.items()}})
    b.refresh_from_db()
    return Response({'batch': batch_json(b, user, email, with_txns=True), 'results': results})


@csrf_exempt
@api_view(['POST'])
def requeue_view(request, txn_id):
    from ..models import PayoutTransaction
    email, user, err = sec.require(request, PERM_PREPARE, fresh=True)
    if err:
        return err
    d = _data(request)
    t = PayoutTransaction.objects.filter(id=txn_id).select_related('batch').first()
    if not t:
        return _err('Transaction not found.', 404, 'NOT_FOUND')
    if t.status != 'failed':
        return _err('Only a failed transfer can be re-queued.', 409, 'NOT_FAILED')
    acc, ifsc, bank, errors = _validate_bank_details(d)
    if errors:
        return _err('Check the bank details.', 400, 'INVALID_BANK_DETAILS', errors=errors)
    code = _check_code(d)
    if not code:
        return _err('Enter the 6-digit code sent to your email.', 400, 'OTP_REQUIRED')
    good, reason = sec.verify_action_otp(email, 'payout_requeue', t.id, code)
    if not good:
        sec.audit('payout_requeue_otp_failed', 'PayoutTransaction', t.id, request, email,
                  sec.display_name(user, email), notes=reason)
        return _err(reason, 400, 'OTP_INVALID')
    try:
        batch, new = requeue_txn(t, acc, ifsc, bank, email)
    except ValueError as exc:
        msg, code = exc.args if len(exc.args) == 2 else (str(exc), 'INVALID')
        return _err(msg, 409, code)
    sec.audit('payout_txn_requeued', 'PayoutTransaction', t.id, request, email, sec.display_name(user, email),
              changes={'newTransaction': new.id, 'newBatch': batch.id, 'attempt': new.attempt,
                       'account': '••••' + acc[-4:], 'ifsc': ifsc, 'previousFailure': t.failure_code})
    return Response({'batch': batch_json(batch, user, email, with_txns=True), 'transaction': txn_json(new)},
                    status=201)


@csrf_exempt
@api_view(['POST'])
def payment_bank_view(request, payment_id):
    """Fix the bank details of a payment that could not be prepared."""
    from ..models import PayrollPayment
    email, user, err = sec.require(request, PERM_PREPARE, fresh=True)
    if err:
        return err
    d = _data(request)
    pm = PayrollPayment.objects.filter(id=payment_id).first()
    if not pm:
        return _err('Payment not found.', 404, 'NOT_FOUND')
    if pm.status not in ('pending', 'failed') or pm.id in _active_payment_ids(pm.run_id):
        return _err('This payment is already in a payout batch or paid; use re-queue for failed transfers.',
                    409, 'PAYMENT_LOCKED')
    acc, ifsc, bank, errors = _validate_bank_details(d)
    if errors:
        return _err('Check the bank details.', 400, 'INVALID_BANK_DETAILS', errors=errors)
    code = _check_code(d)
    if not code:
        return _err('Enter the 6-digit code sent to your email.', 400, 'OTP_REQUIRED')
    good, reason = sec.verify_action_otp(email, 'payout_bank_update', pm.id, code)
    if not good:
        return _err(reason, 400, 'OTP_INVALID')
    _update_bank_records(pm, acc, ifsc, bank)
    sec.audit('payout_bank_details_changed', 'PayrollPayment', pm.id, request, email, sec.display_name(user, email),
              changes={'employee': pm.email, 'account': '••••' + acc[-4:], 'ifsc': ifsc})
    return Response({'ok': True, 'paymentId': pm.id, 'account': '••••' + acc[-4:], 'ifsc': ifsc})


@api_view(['GET'])
def reconciliation_view(request):
    from ..models import PayoutTransaction, WebhookEvent
    email, user, err = sec.require(request, PERM_ANY_BANKING)
    if err:
        return err
    events = []
    for e in WebhookEvent.objects.filter(provider__in=PAYOUT_PROVIDERS).order_by('-id')[:100]:
        p = e.payload if isinstance(e.payload, dict) else {}
        evs = p.get('events') if isinstance(p.get('events'), list) else []
        events.append({'id': e.id, 'provider': e.provider, 'eventId': e.event_id, 'signatureOk': e.signature_ok,
                       'processed': e.processed, 'error': e.error, 'receivedAt': _iso(e.received_at),
                       'events': [_safe_event(x) for x in evs[:50] if isinstance(x, dict)]})
    failed = [dict(txn_json(t), batchId=t.batch_id)
              for t in PayoutTransaction.objects.filter(status='failed').select_related('batch').order_by('-updated_at')[:100]]
    return Response({'webhooks': events, 'failures': failed})


# ══════════════════════════════════════════════════════════════════════════
# webhook (server-to-server; no session, HMAC-signed)
# ══════════════════════════════════════════════════════════════════════════
def _ip_allowed(request, public):
    allow = public.get('webhook_ip_allowlist') or []
    if isinstance(allow, str):
        allow = [a.strip() for a in allow.split(',') if a.strip()]
    if not allow:
        return True
    ip = request.META.get('REMOTE_ADDR', '')
    if public.get('trust_forwarded_for') and request.META.get('HTTP_X_FORWARDED_FOR'):
        ip = request.META['HTTP_X_FORWARDED_FOR'].split(',')[0].strip()
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for net in allow:
        try:
            if addr in ipaddress.ip_network(str(net), strict=False):
                return True
        except ValueError:
            continue
    return False


def _header(request, name):
    return request.META.get('HTTP_' + str(name).upper().replace('-', '_'), '')


@csrf_exempt
@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
def webhook_view(request, provider):
    if provider not in BANK_PROVIDERS:
        return Response({'ok': False}, status=404)
    raw = request.body or b''
    if len(raw) > 512 * 1024:
        return Response({'ok': False, 'message': 'Payload too large.'}, status=413)
    cfg, row = sec.get_secret(provider)
    public = (row.public_config if row else {}) or {}
    secret = cfg.get('webhook_secret') or ''
    if not row or not secret:
        return Response({'ok': False, 'message': 'Webhook not configured.'}, status=503)
    if not _ip_allowed(request, public):
        sec.audit('payout_webhook_ip_refused', 'WebhookEvent', provider, request, f'webhook:{provider}')
        return Response({'ok': False, 'message': 'Forbidden.'}, status=403)
    sig = _header(request, public.get('webhook_signature_header') or 'X-Signature')
    ts = _header(request, public.get('webhook_timestamp_header') or 'X-Timestamp')
    if not ts or not sec.verify_hmac(secret, raw, sig, ts, 300):
        # Logged under a random id so a forged request can never "burn" a real event id.
        sec.record_webhook(provider, f'badsig-{secrets.token_hex(8)}', {'size': len(raw)}, False,
                           error='Invalid or stale signature')
        return Response({'ok': False, 'message': 'Invalid signature.'}, status=401)
    try:
        body = json.loads(raw.decode('utf-8') or '{}')
    except (ValueError, UnicodeDecodeError):
        body = {}
    event_id = str(_first(body, 'event_id', 'eventId', 'id') if isinstance(body, dict) else '') \
        or 'sha-' + hashlib.sha256(raw).hexdigest()[:40]
    if not _REF_RE.match(event_id[:64]):
        event_id = 'sha-' + hashlib.sha256(raw).hexdigest()[:40]
    prov = get_provider(provider)
    try:
        events = prov.parse_webhook(request, raw)
    except ProviderError as exc:
        sec.record_webhook(provider, f'bad-{secrets.token_hex(8)}', {'size': len(raw)}, True, error=exc.reason)
        return Response({'ok': False, 'message': 'Unreadable payload.'}, status=400)
    ev_row, replay = sec.record_webhook(provider, event_id, {'events': [_safe_event(e) for e in events]}, True)
    if replay:
        return Response({'ok': True, 'replay': True})
    results = []
    for e in events:
        try:
            results.append(apply_event(provider, e, source='webhook'))
        except Exception as exc:
            logger.error('webhook event apply failed (%s)', type(exc).__name__)
            results.append('error')
    if ev_row:
        ev_row.processed = True
        bad = [r for r in results if r in ('unknown_transaction', 'provider_mismatch', 'error')]
        ev_row.error = (f'{len(bad)} event(s) not applied: ' + ', '.join(sorted(set(bad))))[:255] if bad else ''
        ev_row.save(update_fields=['processed', 'error'])
    return Response({'ok': True, 'results': results})


# ══════════════════════════════════════════════════════════════════════════
# integrations (icici, hdfc, twilio, slack)
# ══════════════════════════════════════════════════════════════════════════
INTEGRATION_SPECS = {
    'icici': {
        'label': 'ICICI Bank — Corporate API Banking (CIB / Composite Payment)', 'kind': 'bank',
        'secrets': [('api_key', 'API key'), ('debit_account', 'Debit (corporate) account number'),
                    ('client_private_key_pem', 'Our private key (PEM)'),
                    ('client_key_passphrase', 'Private key passphrase (if encrypted)'),
                    ('client_cert_pem', 'Our client certificate for mTLS (PEM)'),
                    ('bank_public_cert_pem', "ICICI's public certificate (PEM)"),
                    ('webhook_secret', 'Webhook HMAC secret')],
        'public': [('base_url', 'API base URL (https://…)'), ('transfer_path', 'Transfer path'),
                   ('status_path', 'Status inquiry path'), ('aggr_id', 'AGGRID'), ('aggr_name', 'AGGRNAME'),
                   ('corp_id', 'CORPID'), ('user_id', 'USERID'), ('urn', 'URN'),
                   ('rsa_padding', 'RSA padding (PKCS1v15 | OAEP | OAEP-SHA256)'),
                   ('aes_key_bytes', 'AES session key bytes (16 or 32)'),
                   ('client_cert_path', 'Client cert file (in HRMS_BANK_CERT_DIR)'),
                   ('client_key_path', 'Private key file (in HRMS_BANK_CERT_DIR)'),
                   ('bank_cert_path', 'Bank cert file (in HRMS_BANK_CERT_DIR)'),
                   ('webhook_signature_header', 'Webhook signature header'),
                   ('webhook_timestamp_header', 'Webhook timestamp header'),
                   ('webhook_ip_allowlist', 'Webhook IP allow-list (comma separated, CIDR ok)')],
    },
    'hdfc': {
        'label': 'HDFC Bank — API Banking (SmartHub / Enet)', 'kind': 'bank',
        'secrets': [('client_id', 'OAuth client id'), ('client_secret', 'OAuth client secret'),
                    ('api_key', 'API key'), ('debit_account', 'Debit (corporate) account number'),
                    ('client_private_key_pem', 'Our private key (PEM)'),
                    ('client_key_passphrase', 'Private key passphrase (if encrypted)'),
                    ('client_cert_pem', 'Our client certificate for mTLS (PEM)'),
                    ('bank_public_cert_pem', "HDFC's public certificate (PEM)"),
                    ('webhook_secret', 'Webhook HMAC secret')],
        'public': [('base_url', 'API base URL (https://…)'), ('token_path', 'OAuth token path'),
                   ('transfer_path', 'Transfer path'), ('status_path', 'Status path'), ('scope', 'OAuth scope'),
                   ('corp_id', 'Corporate id'), ('rsa_padding', 'RSA padding (PKCS1v15 | OAEP | OAEP-SHA256)'),
                   ('aes_key_bytes', 'AES session key bytes (16 or 32)'),
                   ('client_cert_path', 'Client cert file (in HRMS_BANK_CERT_DIR)'),
                   ('client_key_path', 'Private key file (in HRMS_BANK_CERT_DIR)'),
                   ('bank_cert_path', 'Bank cert file (in HRMS_BANK_CERT_DIR)'),
                   ('webhook_signature_header', 'Webhook signature header'),
                   ('webhook_timestamp_header', 'Webhook timestamp header'),
                   ('webhook_ip_allowlist', 'Webhook IP allow-list (comma separated, CIDR ok)')],
    },
    'twilio': {
        'label': 'Twilio — SMS & WhatsApp', 'kind': 'messaging',
        'secrets': [('account_sid', 'Account SID'), ('auth_token', 'Auth token')],
        'public': [('sms_from', 'SMS From number (E.164)'), ('messaging_service_sid', 'Messaging Service SID (optional)'),
                   ('whatsapp_from', 'WhatsApp sender (E.164)'),
                   ('whatsapp_content_sid', 'WhatsApp approved template Content SID (HX…)'),
                   ('salary_channels', 'Salary alert channels (sms, whatsapp)'),
                   ('default_country_code', 'Default country code (+91)')],
    },
    'slack': {
        'label': 'Slack — pay run approvals', 'kind': 'messaging',
        'secrets': [('bot_token', 'Bot token (xoxb-…)'), ('signing_secret', 'Signing secret')],
        'public': [('team_id', 'Workspace (team) id — optional, enforced if set'),
                   ('fallback_channel', 'Fallback channel id (optional)'), ('app_url', 'HRMS URL for links')],
    },
}

_PUBLIC_MAX = 500
_SECRET_MAX = 16000


def _clean_public(provider, raw, existing):
    keys = {k for k, _ in INTEGRATION_SPECS[provider]['public']}
    out = dict(existing or {})
    for k, v in (raw or {}).items():
        if k not in keys:
            continue
        if k == 'webhook_ip_allowlist':
            items = v if isinstance(v, list) else [a.strip() for a in str(v or '').split(',') if a.strip()]
            for a in items:
                try:
                    ipaddress.ip_network(str(a), strict=False)
                except ValueError:
                    raise ConfigError(f'"{str(a)[:40]}" is not an IP address or CIDR range.')
            out[k] = [str(a) for a in items][:50]
            continue
        if k == 'salary_channels':
            items = v if isinstance(v, list) else [a.strip().lower() for a in str(v or '').split(',') if a.strip()]
            if any(a not in ('sms', 'whatsapp') for a in items):
                raise ConfigError('Salary alert channels must be sms and/or whatsapp.')
            out[k] = items
            continue
        s = str(v if v is not None else '').strip()
        if len(s) > _PUBLIC_MAX:
            raise ConfigError(f'{k} is too long.')
        if k in ('base_url', 'app_url') and s and not s.startswith('https://'):
            raise ConfigError(f'{k} must start with https://')
        if k.endswith('_path') and '..' in s:
            raise ConfigError(f'{k} must not contain "..".')
        if s:
            out[k] = s
        else:
            out.pop(k, None)
    return out


def _clean_secrets(provider, raw, existing, clear):
    keys = {k for k, _ in INTEGRATION_SPECS[provider]['secrets']}
    out = dict(existing or {})
    changed = False
    for k, v in (raw or {}).items():
        if k not in keys or v in (None, ''):
            continue          # blank = keep the stored value (write-only fields)
        s = str(v).strip()
        if len(s) > _SECRET_MAX:
            raise ConfigError(f'{k} is too long.')
        out[k] = s
        changed = True
    for k in clear or []:
        if k in out:
            out.pop(k)
            changed = True
    if provider in BANK_PROVIDERS and out.get('debit_account') and not _ACCOUNT_RE.match(_clean_account(out['debit_account'])):
        raise ConfigError('The debit account number must be 9–18 digits.')
    if provider == 'twilio':
        if out.get('account_sid') and not re.match(r'^AC[0-9a-fA-F]{32}$', out['account_sid']):
            raise ConfigError('Twilio Account SID must look like AC followed by 32 hex characters.')
    if provider == 'slack':
        if out.get('bot_token') and not out['bot_token'].startswith('xoxb-'):
            raise ConfigError('Slack bot token must start with xoxb-.')
    return out, changed


def _integration_json(provider):
    m = sec.secret_meta(provider)
    from ..models import IntegrationSecret
    row = IntegrationSecret.objects.filter(provider=provider).first()
    spec = INTEGRATION_SPECS[provider]
    return {
        'provider': provider, 'label': spec['label'], 'kind': spec['kind'],
        'configured': m['configured'], 'enabled': m['enabled'], 'mode': m['mode'], 'fingerprint': m['fingerprint'],
        'secretFields': [{'key': k, 'label': lbl, 'set': k in m['fields']} for k, lbl in spec['secrets']],
        'publicFields': [{'key': k, 'label': lbl} for k, lbl in spec['public']],
        'public': m['public'], 'updatedBy': m['updatedBy'], 'updatedAt': m['updatedAt'],
        'validatedAt': _iso(row.validated_at) if row else None,
        'webhookUrl': f'/api/payroll/banking/webhook/{provider}' if provider in BANK_PROVIDERS else (
            '/api/payroll/alerts/slack/interact' if provider == 'slack' else ''),
    }


@api_view(['GET'])
def integrations_view(request):
    email, user, err = sec.require(request, PERM_INTEGRATIONS)
    if err:
        return err
    return Response({'integrations': [_integration_json(p) for p in ALL_INTEGRATIONS], 'certDirConfigured':
                     bool(os.environ.get('HRMS_BANK_CERT_DIR'))})


def _test_integration(provider):
    """(ok, message). Banks: config/key validation only — never moves money."""
    cfg, row = sec.get_secret(provider)
    if not cfg:
        return False, 'Not configured.'
    if provider in BANK_PROVIDERS:
        try:
            get_provider(provider).validate_config()
        except ConfigError as exc:
            return False, str(exc)
        except Exception:
            return False, 'The configuration could not be validated.'
        note = ' (test mode — no bank call made)' if row.mode != 'live' else \
            ' (configuration only — validate end-to-end in the bank UAT sandbox)'
        return True, 'Keys and certificates parsed; encryption self-check passed' + note + '.'
    from . import channels
    return channels.test_connection(provider, cfg, row)


@csrf_exempt
@api_view(['PUT', 'DELETE'])
def integration_view(request, provider):
    from ..models import IntegrationSecret
    email, user, err = sec.require(request, PERM_INTEGRATIONS, fresh=True)
    if err:
        return err
    if provider not in ALL_INTEGRATIONS:
        return _err('Unknown integration.', 404, 'NOT_FOUND')
    if request.method == 'DELETE':
        IntegrationSecret.objects.filter(provider=provider).delete()
        sec.audit('integration_removed', 'IntegrationSecret', provider, request, email, sec.display_name(user, email))
        return Response({'integration': _integration_json(provider)})
    d = _data(request)
    existing, row = sec.get_secret(provider)
    try:
        creds, changed = _clean_secrets(provider, d.get('credentials') or {}, existing,
                                        d.get('clear') if isinstance(d.get('clear'), list) else [])
        public = _clean_public(provider, d.get('public') or {}, (row.public_config if row else {}) or {})
    except ConfigError as exc:
        return _err(str(exc), 400, 'INVALID_CONFIG')
    mode = d.get('mode', row.mode if row else 'test')
    if mode not in ('test', 'live'):
        return _err('Mode must be test or live.', 400, 'BAD_MODE')
    enabled = bool(d.get('enabled', row.enabled if row else False))
    if enabled and not creds:
        return _err('Enter the credentials before enabling.', 400, 'NOT_CONFIGURED')
    if mode == 'live' and provider in BANK_PROVIDERS:
        try:
            PROVIDER_CLASSES[provider](creds, public, 'live', enabled).validate_config()
        except ConfigError as exc:
            return _err('Live mode needs a complete, valid configuration: ' + str(exc), 400, 'INVALID_CONFIG')
    prev_mode = row.mode if row else 'test'
    row = sec.set_secret(provider, creds if (changed or not existing) else None, mode, enabled, public, email)
    if changed:
        row.validated_at = None
        row.save(update_fields=['validated_at'])
    sec.audit('integration_saved', 'IntegrationSecret', provider, request, email, sec.display_name(user, email),
              changes={'mode': mode, 'previousMode': prev_mode, 'enabled': enabled, 'credentialsChanged': changed,
                       'fields': sorted(creds.keys()), 'publicKeys': sorted(public.keys()),
                       'fingerprint': row.fingerprint})
    return Response({'integration': _integration_json(provider)})


@csrf_exempt
@api_view(['POST'])
def integration_test_view(request, provider):
    from ..models import IntegrationSecret
    email, user, err = sec.require(request, PERM_INTEGRATIONS, fresh=True)
    if err:
        return err
    if provider not in ALL_INTEGRATIONS:
        return _err('Unknown integration.', 404, 'NOT_FOUND')
    ok, message = _test_integration(provider)
    cfg, _ = sec.get_secret(provider)
    message = scrub(message, [v for v in cfg.values() if isinstance(v, str)])
    if ok:
        IntegrationSecret.objects.filter(provider=provider).update(validated_at=timezone.now())
    sec.audit('integration_tested', 'IntegrationSecret', provider, request, email, sec.display_name(user, email),
              changes={'ok': ok}, notes=message)
    return Response({'ok': ok, 'message': message, 'integration': _integration_json(provider)})
