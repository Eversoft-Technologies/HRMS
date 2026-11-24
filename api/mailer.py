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
from datetime import datetime
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
        'password': _stored_smtp_password(cfg.smtp_password),
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


def _stored_smtp_password(value):
    """The usable SMTP password from the encrypted column (legacy plain text
    is still accepted until the config is saved again)."""
    from .secret_box import decrypt
    return decrypt(value or '')


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

        # Daily / monthly quota used up, or rate-limited (429): the email is
        # fine, Resend just won't take more right now — the SMTP account can.
        if resp.status_code == 429:
            name = parsed.get('name') if isinstance(parsed, dict) else ''
            msg = parsed.get('message') if isinstance(parsed, dict) else resp.text
            return {'ok': False, 'error': f'Resend API {name or "rate_limited"}: {msg}', 'resend_validation_error': True,
                    'resend_quota_error': True}

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
                fb = _send_via_smtp(smtp_settings, to, subject, html=html, text=text)
                if not fb.get('ok'):
                    # Keep both reasons: why Resend refused, and why SMTP failed.
                    fb = dict(fb, error=f"{resp.get('error')} — SMTP fallback also failed: {fb.get('error')}")
                return fb
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
            server = smtplib.SMTP_SSL(smtp_settings['host'], smtp_settings['port'], timeout=8, context=context)
        else:
            server = smtplib.SMTP(smtp_settings['host'], smtp_settings['port'], timeout=8)
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
BRAND_COMPANY = 'EverSoft Technologies LLC'
BRAND_SHORT = 'EverSoft Technologies'
BRAND_GREEN = '#0f9d58'


def brand_logo_url(origin=''):
    """Absolute URL of the EverSoft mark shipped at ``dist/dist/logo.jpg``.

    Mail clients cannot resolve a relative path, so the logo needs the public
    origin. Callers that know the request host pass it; everything else falls
    back to the configured public URL. Returns '' when neither is available,
    and render_branded() then draws a text badge instead of a broken image.
    """
    base = (origin or '').strip()
    if not base:
        try:
            from django.conf import settings
            base = (getattr(settings, 'HRMS_PUBLIC_URL', '') or '').strip()
        except Exception:
            base = ''
    if not base:
        base = os.environ.get('PUBLIC_BASE_URL', '').strip()
    base = base.rstrip('/')
    return f'{base}/logo.jpg' if base else ''


def render_details_card(heading, rows, accent=BRAND_GREEN):
    """A bordered detail block — the "INTERVIEW DETAILS" card in the mock.

    ``rows`` is a sequence of (label, value) pairs; empty values are skipped so
    a card never shows a blank line for data the record does not carry.
    """
    body = ''.join(
        f'<tr>'
        f'<td style="padding:7px 0;color:{accent};font-size:12px;font-weight:600;'
        f'width:38%;vertical-align:top;">{label}</td>'
        f'<td style="padding:7px 0;color:#1e293b;font-size:13px;font-weight:600;">{value}</td>'
        f'</tr>'
        for label, value in rows if value not in (None, '')
    )
    if not body:
        return ''
    return (
        f'<table width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid {accent};'
        f'border-radius:8px;margin:0 0 24px;">'
        f'<tr><td style="padding:14px 18px 6px;">'
        f'<div style="font-size:11px;font-weight:800;letter-spacing:0.8px;color:{accent};'
        f'text-transform:uppercase;margin-bottom:6px;">{heading}</div>'
        f'</td></tr>'
        f'<tr><td style="padding:0 18px 14px;">'
        f'<table width="100%" cellpadding="0" cellspacing="0">{body}</table>'
        f'</td></tr></table>'
    )


def render_cta(url, label, accent=BRAND_GREEN):
    """Centred call-to-action button plus the raw link for clients that strip it."""
    if not url:
        return ''
    return (
        f'<div style="text-align:center;margin:0 0 22px;">'
        f'<a href="{url}" target="_blank" rel="noreferrer noopener" '
        f'style="display:inline-block;background:{accent};color:#ffffff;font-size:14px;'
        f'font-weight:700;text-decoration:none;padding:12px 34px;border-radius:8px;">'
        f'{label}</a></div>'
        f'<div style="text-align:center;margin:0 0 18px;">'
        f'<a href="{url}" style="color:#94a3b8;font-size:11px;word-break:break-all;">{url}</a>'
        f'</div>'
    )


NAVY = '#14213d'
_PILL = {
    'green': ('#dcfce7', '#15803d'), 'red': ('#fee2e2', '#b91c1c'), 'amber': ('#fef3c7', '#b45309'),
    'blue': ('#dbeafe', '#1d4ed8'), 'sky': ('#e0f2fe', '#0369a1'), 'purple': ('#ede9fe', '#6d28d9'),
    'gray': ('#f1f5f9', '#475569'),
}


def render_pill(text, tone='gray'):
    """A small rounded tag (e.g. a project, status or priority) for e-mail."""
    bg, fg = _PILL.get(tone, _PILL['gray'])
    return (f'<span style="display:inline-block;background:{bg};color:{fg};font-size:13px;font-weight:600;'
            f'line-height:20px;padding:2px 10px;border-radius:6px;white-space:nowrap;">{text}</span>')


def render_notification(*, eyebrow='HRMS NOTIFICATION', title, subtitle='', badge='&#10003;', badge_color='#22c55e',
                        greeting='', lead_html='', details_title='', details=(), extra_html='',
                        cta_url='', cta_label='', reason_html='', base_url='', company=BRAND_COMPANY,
                        logo_url=''):
    """The "HRMS NOTIFICATION" e-mail: a white card with the brand header, a
    navy banner (eyebrow, title, subtitle and a round badge), a greeting, one
    lead sentence, a details table with an icon column, an optional extra
    block, a navy call-to-action, and a footer with links.

    ``details`` is a sequence of (icon, label, value_html); empty values are
    skipped. Every value must already be HTML-escaped by the caller. Built from
    tables and inline styles so it renders in Gmail, Outlook and phones.
    """
    if not logo_url:
        logo_url = brand_logo_url(base_url)
    base = (base_url or '').rstrip('/')
    logo = (f'<img src="{logo_url}" alt="" width="34" height="34" style="width:34px;height:34px;border-radius:7px;'
            f'object-fit:contain;display:block;border:0;">' if logo_url else
            '<div style="width:34px;height:34px;border-radius:7px;background:#e7f6ee;color:#0f9d58;font-size:18px;'
            'font-weight:800;line-height:34px;text-align:center;">E</div>')
    rows = [(i, l, v) for i, l, v in details if v not in (None, '')]
    table = ''
    if rows:
        body = ''.join(
            f'<tr>'
            f'<td width="46" align="center" style="width:46px;border-top:1px solid #e2e8f0;border-right:1px solid #e2e8f0;'
            f'padding:11px 0;color:#64748b;font-size:15px;line-height:20px;">{icon}</td>'
            f'<td style="width:34%;border-top:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:11px 14px;'
            f'color:#334155;font-size:14px;line-height:20px;">{label}</td>'
            f'<td style="border-top:1px solid #e2e8f0;padding:11px 14px;color:#0f172a;font-size:14px;line-height:20px;'
            f'word-break:break-word;">{value}</td></tr>'
            for icon, label, value in rows)
        table = (
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;'
            f'border-radius:10px;border-collapse:separate;overflow:hidden;margin:0 0 24px;">'
            f'<tr><td colspan="3" style="background:#eef3f9;padding:14px 16px;font-size:16px;font-weight:700;color:#0f172a;">'
            f'<span style="color:#64748b;font-weight:400;margin-right:8px;">&#9636;</span>{details_title or "Details"}</td></tr>'
            f'{body}</table>')
    cta = (f'<div style="text-align:center;margin:0 0 8px;">'
           f'<a href="{cta_url}" target="_blank" rel="noreferrer noopener" style="display:inline-block;background:{NAVY};'
           f'color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:8px;">'
           f'{cta_label} &#8599;</a></div>' if cta_url and cta_label else '')
    links = [('Open HRMS', base + '/' if base else ''), ('Notification Settings', base + '/settings' if base else ''),
             ('Help & Support', base + '/tickets' if base else '')]
    link_html = ' <span style="color:#cbd5e1;">|</span> '.join(
        (f'<a href="{u}" style="color:#334155;text-decoration:none;">{t.replace("&", "&amp;")}</a>' if u
         else f'<span style="color:#334155;">{t.replace("&", "&amp;")}</span>') for t, u in links)
    year = datetime.now().year
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<style>@media (max-width:520px){{.hn-dept{{display:none!important}}.hn-title{{font-size:23px!important}}.hn-pad{{padding-left:18px!important;padding-right:18px!important}}.hn-badge{{width:52px!important;height:52px!important;line-height:52px!important;font-size:26px!important}}}}</style></head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <tr><td class="hn-pad" style="padding:18px 28px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;padding-bottom:14px;"><tr>
            <td style="padding-bottom:12px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="padding-right:10px;">{logo}</td>
              <td style="font-size:19px;font-weight:700;color:{NAVY};">{company}</td></tr></table></td>
            <td class="hn-dept" align="right" style="padding-bottom:12px;padding-left:12px;font-size:13px;color:#334155;white-space:nowrap;">Human Resources Department
              <span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:#64748b;color:#ffffff;font-size:10px;font-weight:700;line-height:26px;text-align:center;vertical-align:middle;margin-left:8px;">HR</span></td>
          </tr></table>
        </td></tr>
        <tr><td class="hn-pad" style="background:{NAVY};padding:30px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.2px;color:#94a3b8;text-transform:uppercase;margin:0 0 8px;">{eyebrow}</div>
              <div class="hn-title" style="font-size:28px;font-weight:800;color:#ffffff;line-height:1.2;margin:0 0 8px;">{title}</div>
              <div style="font-size:15px;color:#e2e8f0;line-height:1.5;">{subtitle}</div>
            </td>
            <td width="84" align="right" style="vertical-align:middle;">
              <div class="hn-badge" style="width:64px;height:64px;border-radius:50%;border:3px solid {badge_color};color:{badge_color};font-size:32px;font-weight:700;line-height:64px;text-align:center;">{badge}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td class="hn-pad" style="padding:28px 28px 26px;">
          {f'<p style="font-size:16px;margin:0 0 16px;color:#0f172a;">{greeting}</p>' if greeting else ''}
          {f'<p style="font-size:16px;line-height:1.6;margin:0 0 22px;color:#0f172a;">{lead_html}</p>' if lead_html else ''}
          {table}{extra_html}{cta}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
        <tr><td style="padding:18px 28px 0;text-align:center;font-size:13px;line-height:1.6;color:#475569;">{reason_html}</td></tr>
        <tr><td style="padding:14px 28px 0;"><div style="border-top:1px solid #e2e8f0;height:1px;line-height:1px;">&nbsp;</div></td></tr>
        <tr><td style="padding:14px 28px 4px;text-align:center;font-size:13px;">{link_html}</td></tr>
        <tr><td style="padding:4px 28px 8px;text-align:center;font-size:12px;color:#64748b;">Copyright {year}, {company}.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def render_branded(title, intro, highlight_html='', footer='', company=BRAND_COMPANY,
                   greeting='', logo_url='', signoff=True):
    """The one HTML shell every outbound HRMS email uses.

    Header (logo + company + "Human Resources Department") and footer (social
    badges + system-generated notice) are fixed so every message looks like it
    came from the same organisation; callers vary only the content. ``title``
    is rendered as the leading heading, ``intro`` as body copy, and
    ``highlight_html`` is where a details card and/or CTA goes.
    """
    today_str = datetime.now().strftime('%B %d, %Y')

    # Every message carries the brand mark; callers only override it when they
    # know a better origin than the configured public URL.
    if not logo_url:
        logo_url = brand_logo_url()

    logo = (
        f'<img src="{logo_url}" alt="" width="44" height="44" '
        f'style="width:44px;height:44px;border-radius:8px;object-fit:contain;'
        f'background:#ffffff;border:1.5px solid #e2e8f0;display:block;">'
        if logo_url else
        '<div style="width:44px;height:44px;border-radius:8px;background:#ffffff;'
        'color:#0f9d58;font-size:22px;font-weight:800;line-height:44px;'
        'text-align:center;">E</div>'
    )

    salutation = (
        f'<p style="font-size:15px;margin:0 0 16px;line-height:1.5;">Dear '
        f'<strong style="color:{BRAND_GREEN};">{greeting}</strong>,</p>'
        if greeting else ''
    )
    heading = (
        f'<h1 style="font-size:19px;font-weight:700;margin:0 0 14px;color:#1e293b;">{title}</h1>'
        if title else ''
    )
    sign = (
        f'<p style="font-size:14px;line-height:1.6;color:#475569;margin:24px 0 0;">'
        f'Warm regards,<br><strong>EverSoft HR Team</strong>'
        f'<br><span style="color:#94a3b8;">{BRAND_SHORT}</span></p>'
        if signoff else ''
    )
    note = (
        f'<p style="font-size:13px;line-height:1.6;color:#94a3b8;margin:18px 0 0;">{footer}</p>'
        if footer else ''
    )

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">
        <tr>
          <td style="background:linear-gradient(135deg,#007f56 0%,{BRAND_GREEN} 100%);padding:20px 30px;vertical-align:middle;">
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="54" style="vertical-align:middle;">{logo}</td>
              <td style="vertical-align:middle;padding-left:12px;color:#ffffff;">
                <div style="font-size:18px;font-weight:800;letter-spacing:0.5px;line-height:1.2;">{company}</div>
                <div style="font-size:12px;opacity:0.85;margin-top:2px;font-weight:500;">Human Resources Department</div>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 30px;color:#1e293b;">
            <div style="font-size:13px;color:#94a3b8;margin-bottom:18px;font-weight:600;">{today_str}</div>
            {salutation}
            {heading}
            <div style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 24px;">{intro}</div>
            {highlight_html}
            {note}
            {sign}
            <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">
              <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:{BRAND_GREEN};color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">W</span>
              <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#0077b5;color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">in</span>
              <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#1877f2;color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">f</span>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 30px;text-align:center;color:#94a3b8;font-size:11px;line-height:1.6;border-top:1px solid #e2e8f0;">
            This is a system-generated email from {company}. Please do not reply directly to this message.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
