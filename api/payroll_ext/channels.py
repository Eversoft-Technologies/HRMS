"""Multi-channel payroll alerts: Twilio SMS / WhatsApp and Slack approvals.

Public functions other modules may call
---------------------------------------
* ``send_salary_credit_alert(payroll_payment, utr)`` → list[ChannelDelivery]
      "Dear {first_name}, your salary of ₹{amount} for {Month YYYY} has been
      processed. Reference: UTR{utr}." on every channel listed in Twilio's
      public config ``salary_channels`` (default: sms). Idempotent per payment
      and channel. Never raises.
* ``notify_payrun_submitted(run, force=False)`` → list[ChannelDelivery]
      Interactive Slack card (Review & Approve / Reject) DM'd to every active
      user holding payroll approval rights (``PAYRUN_APPROVE_PERMS`` or Super
      Admin) whose email matches a Slack account (``users.lookupByEmail``).
      Never raises. Hook point: ``api/payroll_views.py`` →
      ``PayrollRunViewSet.submit_approval`` right after
      ``PayrollService.step_submit_approval(...)`` should later call
      ``from api.payroll_ext.channels import notify_payrun_submitted; notify_payrun_submitted(run)``.
      Until then the UI calls ``POST /api/payroll/alerts/payrun/<id>/notify``
      or ``POST /api/payroll/alerts/payrun/sweep`` (notifies every run that is
      pending approval and was not announced yet).
* ``send_sms(to, body, …)`` / ``send_whatsapp(to, body, …)`` — low level.
* ``dispatch(fn, *args)`` — run after the current DB transaction commits, in a
  background thread (never blocks a payroll request), failures logged.

Opt-out (documented settings, PayrollSetting key/value)
-------------------------------------------------------
* ``alerts_salary_enabled`` = ``false`` turns salary-credit alerts off.
* ``alerts_salary_optout`` = comma separated (or JSON list) of employee
  emails who must not receive SMS / WhatsApp salary alerts.

Modes: when a provider is not configured, not enabled or in ``test`` mode, a
ChannelDelivery with status ``simulated`` is written instead of calling it.
Every outbound call has a ≤10 s timeout; phone numbers are masked in logs.
"""
import hashlib
import hmac
import json
import logging
import re
import threading
import time
from decimal import Decimal
from urllib.parse import parse_qs

import requests
from django.db import close_old_connections, transaction
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from . import security as sec

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 8
RUN_ASYNC = True                      # tests switch this off to run inline
TWILIO_API = 'https://api.twilio.com/2010-04-01'
SLACK_API = 'https://slack.com/api/'
PAYRUN_APPROVE_PERMS = ('payroll.manage',)   # + Super Admin (always)
SLACK_TOLERANCE_S = 300

PERM_VIEW_ALERTS = ('payroll.integrations', 'payroll.payout.prepare', 'payroll.payout.release')


# ── dispatch ──────────────────────────────────────────────────────────────
def _run_safely(fn, *args):
    try:
        fn(*args)
    except Exception:
        logger.exception('payroll alert %s failed', getattr(fn, '__name__', fn))
    finally:
        if RUN_ASYNC:
            close_old_connections()


def dispatch(fn, *args):
    """Run ``fn(*args)`` after commit; in a daemon thread unless RUN_ASYNC is off."""
    def go():
        if RUN_ASYNC:
            threading.Thread(target=_run_safely, args=(fn,) + args, daemon=True).start()
        else:
            _run_safely(fn, *args)
    transaction.on_commit(go)


# ── phone helpers ─────────────────────────────────────────────────────────
def normalise_phone(raw, default_cc='+91'):
    """E.164 or '' (India default: 10-digit mobile → +91XXXXXXXXXX)."""
    s = str(raw or '').strip()
    if not s:
        return ''
    plus = s.startswith('+') or s.startswith('00')
    digits = re.sub(r'\D', '', s)
    if s.startswith('00'):
        digits = digits[2:]
    cc = re.sub(r'\D', '', default_cc or '+91') or '91'
    if not plus:
        if len(digits) == 11 and digits.startswith('0'):
            digits = digits[1:]
        if len(digits) == 10:
            digits = cc + digits
        elif not (cc == '91' and len(digits) == 12 and digits.startswith('91')):
            return ''
    if not (8 <= len(digits) <= 15) or digits.startswith('0'):
        return ''
    if digits.startswith('91') and len(digits) == 12 and digits[2] not in '6789':
        return ''
    return '+' + digits


def mask_phone(e164):
    s = str(e164 or '')
    if len(s) < 6:
        return '•' * len(s)
    cc = s[:3] if s.startswith('+91') else s[:2]
    return cc + '•' * (len(s) - len(cc) - 4) + s[-4:]


def inr(amount):
    """₹ amount in Indian digit grouping: 1,23,456.00"""
    d = Decimal(str(amount or 0)).quantize(Decimal('0.01'))
    neg = d < 0
    whole, frac = f'{abs(d):.2f}'.split('.')
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ','.join(groups + [tail])
    return ('-' if neg else '') + whole + '.' + frac


def _scrub(text, cfg=None):
    from .banking import scrub
    return scrub(text, [v for v in (cfg or {}).values() if isinstance(v, str)])


def _delivery(channel, recipient, email, purpose, ref, status, provider_ref='', error=''):
    from ..models import ChannelDelivery
    return ChannelDelivery.objects.create(channel=channel, recipient=str(recipient)[:255], email=(email or '')[:255],
                                          purpose=purpose[:40], ref=str(ref)[:60], status=status,
                                          provider_ref=str(provider_ref or '')[:100], error=str(error or '')[:255],
                                          created_at=timezone.now())


# ── Twilio ────────────────────────────────────────────────────────────────
def _twilio():
    """(cfg, public, live)"""
    cfg, row = sec.get_secret('twilio')
    public = (row.public_config if row else {}) or {}
    live = bool(row and row.enabled and row.mode == 'live' and cfg.get('account_sid') and cfg.get('auth_token'))
    return cfg, public, live


def _twilio_send(channel, to, body, email='', purpose='', ref='', content_sid='', variables=None):
    cfg, public, live = _twilio()
    masked = mask_phone(to)
    if not to:
        return _delivery(channel, '', email, purpose, ref, 'failed', error='No valid phone number')
    if not live:
        return _delivery(channel, masked, email, purpose, ref, 'simulated',
                         provider_ref='SIM' + hashlib.sha256(f'{channel}{to}{ref}'.encode()).hexdigest()[:12])
    sid = cfg['account_sid']
    data = {'To': to if channel == 'sms' else 'whatsapp:' + to}
    if channel == 'whatsapp':
        sender = public.get('whatsapp_from') or ''
        if not sender:
            return _delivery(channel, masked, email, purpose, ref, 'failed', error='WhatsApp sender not configured')
        data['From'] = 'whatsapp:' + sender
        if content_sid:
            data['ContentSid'] = content_sid
            data['ContentVariables'] = json.dumps(variables or {})
        else:
            data['Body'] = body
    else:
        if public.get('messaging_service_sid'):
            data['MessagingServiceSid'] = public['messaging_service_sid']
        elif public.get('sms_from'):
            data['From'] = public['sms_from']
        else:
            return _delivery(channel, masked, email, purpose, ref, 'failed', error='SMS sender not configured')
        data['Body'] = body
    try:
        resp = requests.post(f'{TWILIO_API}/Accounts/{sid}/Messages.json', data=data,
                             auth=(sid, cfg['auth_token']), timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        return _delivery(channel, masked, email, purpose, ref, 'failed', error=f'Twilio not reachable ({type(exc).__name__})')
    try:
        j = resp.json()
    except ValueError:
        j = {}
    if resp.status_code in (200, 201):
        return _delivery(channel, masked, email, purpose, ref, 'sent', provider_ref=j.get('sid', ''))
    return _delivery(channel, masked, email, purpose, ref, 'failed',
                     error=_scrub(f"Twilio {j.get('code', resp.status_code)}: {j.get('message', '')}", cfg))


def send_sms(to, body, email='', purpose='', ref=''):
    return _twilio_send('sms', to, body, email, purpose, ref)


def send_whatsapp(to, body, email='', purpose='', ref='', content_sid='', variables=None):
    return _twilio_send('whatsapp', to, body, email, purpose, ref, content_sid, variables)


def _opted_out(email):
    from .banking import _setting, _setting_bool
    if not _setting_bool('alerts_salary_enabled', True):
        return True
    raw = _setting('alerts_salary_optout', '')
    try:
        items = json.loads(raw) if raw.strip().startswith('[') else raw.split(',')
    except ValueError:
        items = raw.split(',')
    return (email or '').strip().lower() in {str(i).strip().lower() for i in items if str(i).strip()}


def salary_message(first_name, amount, month_label, utr):
    return (f'Dear {first_name}, your salary of ₹{inr(amount)} for {month_label} has been processed. '
            f'Reference: UTR{utr}.')


def send_salary_credit_alert(payroll_payment, utr):
    """Salary-credit SMS / WhatsApp for one PayrollPayment. Never raises."""
    from ..models import ChannelDelivery, UserProfile
    out = []
    try:
        pm = payroll_payment
        email = (pm.email or '').lower()
        ref = f'pay{pm.id}'
        if _opted_out(email):
            return [_delivery('sms', '', email, 'salary_credit', ref, 'skipped', error='Opted out')]
        prof = UserProfile.objects.filter(email__iexact=email).first()
        first = (prof.first_name if prof and prof.first_name else (pm.employee_name or email.split('@')[0]).split(' ')[0])
        run = pm.run
        month = run.period_start.strftime('%B %Y') if run and run.period_start else ''
        cfg, public, _ = _twilio()
        phone = normalise_phone(prof.phone if prof else '', public.get('default_country_code') or '+91')
        body = salary_message(first, pm.amount, month, utr)
        chans = public.get('salary_channels') or ['sms']
        for ch in chans:
            if ch not in ('sms', 'whatsapp'):
                continue
            if ChannelDelivery.objects.filter(channel=ch, purpose='salary_credit', ref=ref,
                                              status__in=('sent', 'simulated')).exists():
                continue
            if ch == 'sms':
                out.append(send_sms(phone, body, email, 'salary_credit', ref))
            else:
                out.append(send_whatsapp(phone, body, email, 'salary_credit', ref,
                                         public.get('whatsapp_content_sid') or '',
                                         {'1': first, '2': inr(pm.amount), '3': month, '4': utr}))
    except Exception:
        logger.exception('salary credit alert failed')
    return out


def send_salary_credit_alert_by_id(payment_id, utr):
    from ..models import PayrollPayment
    pm = PayrollPayment.objects.filter(id=payment_id).select_related('run').first()
    return send_salary_credit_alert(pm, utr) if pm else []


# ── Slack ─────────────────────────────────────────────────────────────────
def _slack():
    cfg, row = sec.get_secret('slack')
    public = (row.public_config if row else {}) or {}
    live = bool(row and row.enabled and row.mode == 'live' and cfg.get('bot_token'))
    return cfg, public, live, row


def slack_call(method, token, params=None, payload=None):
    """GET (params) or POST JSON (payload) to the Slack Web API. Returns dict
    (``ok`` False on any error, without secrets)."""
    headers = {'Authorization': 'Bearer ' + token}
    try:
        if payload is not None:
            headers['Content-Type'] = 'application/json; charset=utf-8'
            r = requests.post(SLACK_API + method, data=json.dumps(payload), headers=headers, timeout=HTTP_TIMEOUT)
        else:
            r = requests.get(SLACK_API + method, params=params or {}, headers=headers, timeout=HTTP_TIMEOUT)
        j = r.json()
        return j if isinstance(j, dict) else {'ok': False, 'error': 'bad_response'}
    except (requests.RequestException, ValueError) as exc:
        return {'ok': False, 'error': type(exc).__name__}


def verify_slack_signature(signing_secret, timestamp, body, signature, now=None):
    """Slack v0 request signing, 5-minute window, constant-time compare."""
    if not signing_secret or not timestamp or not signature:
        return False
    try:
        ts = int(str(timestamp))
    except ValueError:
        return False
    if abs(int(now if now is not None else time.time()) - ts) > SLACK_TOLERANCE_S:
        return False
    if isinstance(body, str):
        body = body.encode('utf-8')
    base = b'v0:' + str(ts).encode() + b':' + body
    expected = 'v0=' + hmac.new(signing_secret.encode('utf-8'), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature))


def approvers():
    from ..models import AppUser
    return [u for u in AppUser.objects.filter(status='active').select_related('role_ref').order_by('id')
            if sec.has_perm(u, PAYRUN_APPROVE_PERMS)]


def approval_level(user):
    if sec.is_super(user):
        return 'super_admin'
    name = (getattr(getattr(user, 'role_ref', None), 'name', '') or '').strip().lower().replace(' ', '_')
    return name if name in ('payroll_executive', 'hr_manager', 'finance_manager') else 'hr_manager'


def payrun_blocks(run, note=''):
    _, public, _, _ = _slack()
    fields = [
        {'type': 'mrkdwn', 'text': f'*Period*\n{run.period_label}'},
        {'type': 'mrkdwn', 'text': f'*Employees*\n{run.employee_count}'},
        {'type': 'mrkdwn', 'text': f'*Gross*\n₹{inr(run.total_gross)}'},
        {'type': 'mrkdwn', 'text': f'*Net pay*\n₹{inr(run.total_net)}'},
    ]
    blocks = [
        {'type': 'header', 'text': {'type': 'plain_text', 'text': f'Pay run {run.period_label} needs approval'[:150]}},
        {'type': 'section', 'fields': fields},
    ]
    if note:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': note[:300]}]})
    elements = [
        {'type': 'button', 'action_id': 'payrun_approve', 'style': 'primary', 'value': str(run.id),
         'text': {'type': 'plain_text', 'text': 'Review & Approve'},
         'confirm': {'title': {'type': 'plain_text', 'text': 'Approve pay run?'},
                     'text': {'type': 'mrkdwn', 'text': f'Approve *{run.period_label}* — net pay ₹{inr(run.total_net)}?'},
                     'confirm': {'type': 'plain_text', 'text': 'Approve'},
                     'deny': {'type': 'plain_text', 'text': 'Cancel'}}},
        {'type': 'button', 'action_id': 'payrun_reject', 'style': 'danger', 'value': str(run.id),
         'text': {'type': 'plain_text', 'text': 'Reject'},
         'confirm': {'title': {'type': 'plain_text', 'text': 'Reject pay run?'},
                     'text': {'type': 'mrkdwn', 'text': f'Reject *{run.period_label}*? It goes back to payroll.'},
                     'confirm': {'type': 'plain_text', 'text': 'Reject'},
                     'deny': {'type': 'plain_text', 'text': 'Cancel'}}},
    ]
    if public.get('app_url'):
        elements.append({'type': 'button', 'action_id': 'payrun_open', 'text': {'type': 'plain_text', 'text': 'Open in HRMS'},
                         'url': public['app_url'].rstrip('/') + '/payroll'})
    blocks.append({'type': 'actions', 'block_id': f'payrun_{run.id}', 'elements': elements})
    return blocks


def notify_payrun_submitted(run, force=False):
    """Slack approval cards for a run pending approval. Never raises."""
    from ..models import ChannelDelivery
    out = []
    try:
        ref = f'run{run.id}'
        if not force and ChannelDelivery.objects.filter(channel='slack', purpose='payrun_approval', ref=ref,
                                                        status__in=('sent', 'simulated')).exists():
            return out
        cfg, public, live, _ = _slack()
        blocks = payrun_blocks(run, note=(run.notes or '')[:200])
        text = f'Pay run {run.period_label} needs approval (net ₹{inr(run.total_net)})'
        for u in approvers():
            email = u.email.lower()
            if not live:
                out.append(_delivery('slack', 'simulated', email, 'payrun_approval', ref, 'simulated'))
                continue
            look = slack_call('users.lookupByEmail', cfg['bot_token'], params={'email': email})
            if not look.get('ok'):
                if look.get('error') != 'users_not_found':
                    out.append(_delivery('slack', '', email, 'payrun_approval', ref, 'failed',
                                         error=f"lookupByEmail: {look.get('error', 'error')}"))
                continue
            uid = (look.get('user') or {}).get('id', '')
            res = slack_call('chat.postMessage', cfg['bot_token'], payload={'channel': uid, 'text': text,
                                                                           'blocks': blocks})
            if res.get('ok'):
                out.append(_delivery('slack', uid, email, 'payrun_approval', ref, 'sent',
                                     provider_ref=f"{res.get('channel', '')}:{res.get('ts', '')}"))
            else:
                out.append(_delivery('slack', uid, email, 'payrun_approval', ref, 'failed',
                                     error=f"chat.postMessage: {res.get('error', 'error')}"))
        if not out and live and public.get('fallback_channel'):
            res = slack_call('chat.postMessage', cfg['bot_token'],
                             payload={'channel': public['fallback_channel'], 'text': text, 'blocks': blocks})
            out.append(_delivery('slack', public['fallback_channel'], '', 'payrun_approval', ref,
                                 'sent' if res.get('ok') else 'failed',
                                 error='' if res.get('ok') else f"chat.postMessage: {res.get('error', 'error')}"))
    except Exception:
        logger.exception('slack pay run notification failed')
    return out


def _respond_to_slack(response_url, payload):
    if not str(response_url or '').startswith('https://hooks.slack.com/'):
        return        # never post to arbitrary URLs (SSRF)
    try:
        requests.post(response_url, data=json.dumps(payload), headers={'Content-Type': 'application/json'},
                      timeout=HTTP_TIMEOUT)
    except requests.RequestException:
        logger.warning('slack response_url update failed')


def test_connection(provider, cfg, row):
    """(ok, message) for Twilio / Slack — never sends a message."""
    live = bool(row and row.mode == 'live')
    if provider == 'twilio':
        sid, tok = cfg.get('account_sid', ''), cfg.get('auth_token', '')
        if not re.match(r'^AC[0-9a-fA-F]{32}$', sid) or len(tok) < 16:
            return False, 'Account SID / auth token look wrong.'
        if not live:
            return True, 'Credentials look valid (test mode — Twilio was not called; messages are simulated).'
        try:
            r = requests.get(f'{TWILIO_API}/Accounts/{sid}.json', auth=(sid, tok), timeout=HTTP_TIMEOUT)
        except requests.RequestException as exc:
            return False, f'Twilio not reachable ({type(exc).__name__}).'
        return (True, 'Twilio accepted the credentials.') if r.status_code == 200 else \
            (False, f'Twilio refused the credentials (HTTP {r.status_code}).')
    if provider == 'slack':
        tok, ss = cfg.get('bot_token', ''), cfg.get('signing_secret', '')
        if not tok.startswith('xoxb-') or len(ss) < 16:
            return False, 'Bot token must start with xoxb- and the signing secret must be set.'
        if not live:
            return True, 'Credentials look valid (test mode — Slack was not called; cards are simulated).'
        j = slack_call('auth.test', tok, payload={})
        return (True, f"Connected to Slack workspace {j.get('team', '')}.") if j.get('ok') else \
            (False, f"Slack refused the token ({j.get('error', 'error')}).")
    return False, 'Unknown provider.'


# ── HTTP views ────────────────────────────────────────────────────────────
def _body(request):
    try:
        d = request.data
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


@csrf_exempt
@api_view(['POST'])
def notify_payrun_view(request, run_id):
    from ..models import PayrollRun
    email, user, err = sec.require(request, ('payroll.payout.prepare', 'payroll.integrations') + PAYRUN_APPROVE_PERMS)
    if err:
        return err
    run = PayrollRun.objects.filter(id=run_id).first()
    if not run:
        return sec._msg('Pay run not found.', 404, 'NOT_FOUND')
    if run.status != 'pending_approval':
        return sec._msg('Only a pay run pending approval can be announced.', 409, 'NOT_PENDING')
    out = notify_payrun_submitted(run, force=bool(_body(request).get('force')))
    sec.audit('payrun_slack_notified', 'PayrollRun', run.id, request, email, sec.display_name(user, email),
              changes={'deliveries': len(out)})
    return Response({'deliveries': [delivery_json(d) for d in out]})


@csrf_exempt
@api_view(['POST'])
def sweep_view(request):
    """Polling alternative to the submit hook: announce every run pending
    approval that has not been announced yet."""
    from ..models import PayrollRun
    email, user, err = sec.require(request, ('payroll.payout.prepare', 'payroll.integrations') + PAYRUN_APPROVE_PERMS)
    if err:
        return err
    count = 0
    for run in PayrollRun.objects.filter(status='pending_approval').order_by('-id')[:10]:
        if notify_payrun_submitted(run):
            count += 1
    return Response({'announced': count})


def delivery_json(d):
    return {'id': d.id, 'channel': d.channel, 'recipient': d.recipient, 'email': d.email, 'purpose': d.purpose,
            'ref': d.ref, 'status': d.status, 'providerRef': d.provider_ref, 'error': d.error,
            'createdAt': d.created_at.isoformat() if d.created_at else None}


@api_view(['GET'])
def deliveries_view(request):
    from ..models import ChannelDelivery
    email, user, err = sec.require(request, PERM_VIEW_ALERTS)
    if err:
        return err
    qs = ChannelDelivery.objects.all()
    ch = request.query_params.get('channel', '')
    if ch in ('sms', 'whatsapp', 'slack'):
        qs = qs.filter(channel=ch)
    st = request.query_params.get('status', '')
    if st in ('queued', 'sent', 'failed', 'simulated', 'skipped'):
        qs = qs.filter(status=st)
    return Response({'deliveries': [delivery_json(d) for d in qs.order_by('-id')[:200]]})


@csrf_exempt
@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
def slack_interact_view(request):
    """Slack interactivity endpoint (Request URL in the Slack app config)."""
    from ..models import AppUser, PayrollRun
    raw = request.body or b''
    if len(raw) > 256 * 1024:
        return Response({'ok': False}, status=413)
    cfg, public, live, row = _slack()
    secret = cfg.get('signing_secret', '')
    if not secret:
        return Response({'ok': False, 'message': 'Slack is not configured.'}, status=503)
    ts = request.META.get('HTTP_X_SLACK_REQUEST_TIMESTAMP', '')
    sig = request.META.get('HTTP_X_SLACK_SIGNATURE', '')
    if not verify_slack_signature(secret, ts, raw, sig):
        sec.record_webhook('slack', f'badsig-{hashlib.sha256(raw + ts.encode()).hexdigest()[:24]}-{int(time.time())}',
                           {'size': len(raw)}, False, error='Invalid or stale Slack signature')
        return Response({'ok': False, 'message': 'Invalid signature.'}, status=401)
    try:
        payload = json.loads(parse_qs(raw.decode('utf-8')).get('payload', ['{}'])[0])
    except (ValueError, UnicodeDecodeError):
        return Response({'ok': False}, status=400)
    _, replay = sec.record_webhook('slack', f'{ts}-{hashlib.sha256(raw).hexdigest()[:40]}',
                                   {'type': payload.get('type', ''), 'user': (payload.get('user') or {}).get('id', '')},
                                   True)
    if replay:
        return Response({'ok': True, 'replay': True})
    if public.get('team_id') and (payload.get('team') or {}).get('id') != public['team_id']:
        return Response({'ok': False, 'message': 'Unknown workspace.'}, status=403)
    actions = payload.get('actions') or []
    if payload.get('type') != 'block_actions' or not actions:
        return Response({'ok': True})
    act = actions[0]
    action_id = act.get('action_id')
    if action_id not in ('payrun_approve', 'payrun_reject'):
        return Response({'ok': True})
    response_url = payload.get('response_url', '')

    def reply(text, final=False, run=None):
        blocks = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}}]
        if not final and run is not None:
            blocks = payrun_blocks(run) + [{'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': text}]}]
        _respond_to_slack(response_url, {'replace_original': True, 'text': text, 'blocks': blocks})
        return Response({'ok': True})

    try:
        run_id = int(act.get('value'))
    except (TypeError, ValueError):
        return Response({'ok': False}, status=400)
    slack_uid = (payload.get('user') or {}).get('id', '')
    info = slack_call('users.info', cfg.get('bot_token', ''), params={'user': slack_uid}) if slack_uid else {}
    slack_email = (((info.get('user') or {}).get('profile') or {}).get('email') or '').strip().lower()
    user = AppUser.objects.select_related('role_ref').filter(email__iexact=slack_email, status='active').first() \
        if slack_email else None
    from ..permissions import _CACHE
    _CACHE.clear()
    run = PayrollRun.objects.filter(id=run_id).first()
    if user is None or not sec.has_perm(user, PAYRUN_APPROVE_PERMS):
        sec.audit('payrun_slack_action_refused', 'PayrollRun', run_id, request, slack_email or f'slack:{slack_uid}',
                  notes='No matching HRMS user with payroll approval rights')
        return reply(':no_entry: You do not have payroll approval rights in HRMS (or your Slack email '
                     'does not match an HRMS account).', run=run)
    if not run:
        return reply('This pay run no longer exists.', final=True)
    if run.status != 'pending_approval':
        return reply(f'Pay run *{run.period_label}* is already *{run.status.replace("_", " ")}*.', final=True)
    from ..services.payroll_service import PayrollService
    name = sec.display_name(user, user.email)
    verb = 'approve' if action_id == 'payrun_approve' else 'reject'
    try:
        run = PayrollService.step_process_approval(run.id, approval_level(user), verb, user.email.lower(), name,
                                                   comments=f'{verb.title()}d from Slack')
    except Exception:
        logger.exception('slack approval failed for run %s', run_id)
        return reply('HRMS could not record that decision. Please use the web app.', run=run)
    sec.audit(f'payrun_slack_{verb}', 'PayrollRun', run.id, request, user.email.lower(), name,
              changes={'status': run.status, 'level': approval_level(user)})
    icon = ':white_check_mark:' if verb == 'approve' else ':x:'
    return reply(f'{icon} *{run.period_label}* {verb}d by {name} — status now *{run.status.replace("_", " ")}*.',
                 final=True)
