"""
Email sending via Resend API or SMTP fallback.

Prefers Resend API when `RESEND_API_KEY` is configured. If Resend is not
configured, falls back to per-user SMTP settings or global SMTP environment
variables.

    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE,
    SMTP_FROM_NAME, SMTP_FROM_EMAIL

Used by the OTP login, password-reset, follow-up and job-post features so all
outbound mail leaves from the server (never the browser).
"""
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

import requests

from .models import UserEmailConfig


def _env(name, default=''):
    return os.environ.get(name, default)


def _env_bool(name, default=False):
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ('1', 'true', 'yes', 'on')


def _cfg_to_settings(cfg):
    if not cfg or not cfg.smtp_host or not cfg.smtp_user:
        return None
    try:
        port = int(cfg.smtp_port or 587)
    except (TypeError, ValueError):
        port = 587
    return {
        'host': cfg.smtp_host.strip(),
        'port': port,
        'user': cfg.smtp_user.strip(),
        'password': cfg.smtp_password or '',
        'secure': bool(cfg.smtp_secure),
        'from_name': (cfg.from_name or 'HRMS').strip(),
        'from_email': (cfg.from_email or cfg.smtp_user).strip(),
    }


def _get_resend_settings(sender_email=None):
    key = _env('RESEND_API_KEY').strip()
    if not key:
        return None
    from_email = str(sender_email or '').strip()
    if not from_email:
        from_email = (_env('RESEND_FROM_EMAIL') or _env('SMTP_FROM_EMAIL') or _env('SMTP_USER')).strip()
    if not from_email:
        return None
    return {
        'type': 'resend',
        'api_key': key,
        'from_name': _env('RESEND_FROM_NAME', 'HRMS').strip() or 'HRMS',
        'from_email': from_email,
    }


def _normalize_smtp_password(password):
    if password is None:
        return ''
    return ''.join(str(password).split())


def get_smtp_settings(sender_email=None):
    """Resolve which SMTP account to send from.

    Order of preference:
      1. The given user's saved Email Configuration.
      2. Any other user's complete Email Configuration (e.g. the admin's).
      3. A global SMTP account from environment variables.
    Returns a settings dict, or None if nothing is configured.
    """
    cfg = None
    if sender_email:
        cfg = UserEmailConfig.objects.filter(pk=str(sender_email).strip().lower()).first()
    resolved = _cfg_to_settings(cfg)
    if resolved:
        return resolved

    other = (
        UserEmailConfig.objects
        .exclude(smtp_host='')
        .exclude(smtp_user='')
        .order_by('user_email')
        .first()
    )
    resolved = _cfg_to_settings(other)
    if resolved:
        return resolved

    host = _env('SMTP_HOST').strip()
    user = _env('SMTP_USER').strip()
    if host and user:
        try:
            port = int(_env('SMTP_PORT', '587') or 587)
        except ValueError:
            port = 587
        return {
            'type': 'smtp',
            'host': host,
            'port': port,
            'user': user,
            'password': _normalize_smtp_password(_env('SMTP_PASSWORD')),
            'secure': _env_bool('SMTP_SECURE', port == 465),
            'from_name': _env('SMTP_FROM_NAME', 'HRMS').strip() or 'HRMS',
            'from_email': (_env('SMTP_FROM_EMAIL') or user).strip(),
        }
    return None


def get_email_settings(sender_email=None):
    """Resolve the email sending configuration.

    Prefers Resend API if RESEND_API_KEY is configured, otherwise falls back
    to SMTP settings from the database or environment.
    """
    resend = _get_resend_settings(sender_email)
    if resend:
        return resend
    return get_smtp_settings(sender_email)


def _send_via_resend(settings, to, subject, html=None, text=None):
    payload = {
        'from': formataddr((settings['from_name'], settings['from_email'])),
        'to': to,
        'subject': subject,
        'html': html or text or '',
        'text': text or html or '',
    }
    headers = {
        'Authorization': f"Bearer {settings['api_key']}",
        'Content-Type': 'application/json',
    }
    try:
        resp = requests.post('https://api.resend.com/emails', json=payload, headers=headers, timeout=20)
        if resp.ok:
            return {'ok': True}
        # Try to extract a structured error if present
        parsed = None
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None

        # If Resend rejects the From address (unverified domain), allow SMTP fallback.
        if resp.status_code == 403:
            name = parsed.get('name') if isinstance(parsed, dict) else None
            msg = parsed.get('message') if isinstance(parsed, dict) else None
            if name == 'validation_error' or (isinstance(msg, str) and 'domain is not verified' in msg.lower()):
                # Indicate the special resend validation error to caller so higher
                # layers can decide to fallback to SMTP if desired.
                return {'ok': False, 'error': f'Resend API validation_error: {msg or resp.text}', 'resend_validation_error': True}

        try:
            error = parsed.get('error') or parsed or resp.text
        except Exception:
            error = resp.text
        return {'ok': False, 'error': f'Resend API error: {error}'}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


def send_email(to, subject, html=None, text=None, sender_email=None):
    """Send one email. Returns {'ok': True} or {'ok': False, 'error': str}."""
    to = str(to or '').strip()
    if not to:
        return {'ok': False, 'error': 'Recipient email is missing'}

    s = get_email_settings(sender_email)
    if not s:
        return {
            'ok': False,
            'error': 'No email configuration found. Set RESEND_API_KEY/RESEND_FROM_EMAIL in the server .env, or configure SMTP settings.',
        }

    if s.get('type') == 'resend':
        resp = _send_via_resend(s, to, subject, html=html, text=text)
        if resp.get('ok'):
            return resp
        if resp.get('resend_validation_error'):
            smtp_settings = get_smtp_settings(sender_email)
            if smtp_settings:
                return _send_via_smtp(smtp_settings, to, subject, html=html, text=text)
        return resp

    return _send_via_smtp(s, to, subject, html=html, text=text)


def _send_via_smtp(smtp_settings, to, subject, html=None, text=None):
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = formataddr((smtp_settings['from_name'], smtp_settings['from_email']))
    msg['To'] = to
    if text:
        msg.attach(MIMEText(text, 'plain', 'utf-8'))
    msg.attach(MIMEText(html or (text or ''), 'html', 'utf-8'))

    try:
        context = ssl.create_default_context()
        if smtp_settings.get('secure') or smtp_settings.get('port') == 465:
            server = smtplib.SMTP_SSL(smtp_settings['host'], smtp_settings['port'], timeout=25, context=context)
        else:
            server = smtplib.SMTP(smtp_settings['host'], smtp_settings['port'], timeout=25)
            server.ehlo()
            try:
                server.starttls(context=context)
                server.ehlo()
            except smtplib.SMTPException:
                pass
        if smtp_settings.get('password'):
            server.login(smtp_settings['user'], smtp_settings['password'])
        server.sendmail(smtp_settings['from_email'], [to], msg.as_string())
        server.quit()
        return {'ok': True}
    except Exception as e:  # noqa: BLE001 - surface any SMTP error to the caller
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


# ---------------------------------------------------------------------------
# Branded HTML wrapper shared by system emails (OTP, reset, notifications)
# ---------------------------------------------------------------------------
def render_branded(title, intro, highlight_html='', footer='', company='Eversoft'):
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#4f8ef7 0%,#a855f7 100%);padding:28px 40px;text-align:center;">
    <div style="color:#fff;font-size:22px;font-weight:800;">{company} HRMS</div>
  </td></tr>
  <tr><td style="padding:32px 40px;color:#1e293b;">
    <h1 style="font-size:20px;margin:0 0 16px;">{title}</h1>
    <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 18px;">{intro}</p>
    {highlight_html}
    <p style="font-size:13px;line-height:1.6;color:#94a3b8;margin:18px 0 0;">{footer}</p>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:18px 40px;text-align:center;color:#94a3b8;font-size:12px;">
    &copy; {company}. This is an automated message — please do not reply.
  </td></tr>
</table></td></tr></table></body></html>"""
