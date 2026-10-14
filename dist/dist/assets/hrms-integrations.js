/*
 * hrms-integrations.js — Settings → Integrations.
 *
 * This tab used to be a hardcoded list (Slack, Jira, Razorpay, …) with fixed
 * "Connected" badges and buttons that did nothing; none of those services
 * exist in the backend. It now shows the integrations the server really has,
 * each with its true status:
 *
 *   Email delivery   GET /api/integrations/status  (Resend or SMTP)
 *   LinkedIn         per user: window.HRMSLinkedIn (hrms-linkedin.js) for
 *                    status / connect / disconnect
 *   Google Sign-In, AI (Anthropic Claude), Maps
 *                    GET /api/integrations/status
 *
 * The bundle renders an empty <div id="hrms-integrations" class="card"> for
 * the tab; this file fills it, and re-fills it whenever React mounts a new one.
 * The status endpoint returns booleans and non-secret details only.
 */
(function () {
  'use strict';
  if (window.__hrmsIntegrations) return;
  window.__hrmsIntegrations = true;

  var MOUNT_ID = 'hrms-integrations';
  var STYLE_ID = 'hrms-integrations-style';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(path) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  var ICON = {
    mail: icon('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>'),
    linkedin: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>'),
    google: icon('<path d="M20.5 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.5z"/><path d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.6c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21z"/><path d="M7 13.8a5.4 5.4 0 0 1 0-3.5V8H4a9 9 0 0 0 0 8.1z"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3L18 5.3A9 9 0 0 0 4 8l3 2.3c.7-2.1 2.7-3.7 5-3.7z"/>'),
    ai: icon('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
    map: icon('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>'),
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#' + MOUNT_ID + ' .hi-sub{font-size:12px;color:var(--text3);margin:-8px 0 8px;}',
      '#' + MOUNT_ID + ' .hi-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--border2);}',
      '#' + MOUNT_ID + ' .hi-row:last-child{border-bottom:none;}',
      '#' + MOUNT_ID + ' .hi-ic{width:38px;height:38px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg3);border:1px solid var(--border2);color:var(--text2);}',
      '#' + MOUNT_ID + ' .hi-main{flex:1;min-width:0;}',
      '#' + MOUNT_ID + ' .hi-name{font-size:13px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '#' + MOUNT_ID + ' .hi-desc{font-size:11.5px;color:var(--text3);margin-top:2px;}',
      '#' + MOUNT_ID + ' .hi-detail{font-size:11.5px;color:var(--text2);margin-top:4px;overflow-wrap:anywhere;}',
      '#' + MOUNT_ID + ' .hi-detail code{font-size:11px;padding:1px 5px;border-radius:4px;background:var(--bg3);}',
      '#' + MOUNT_ID + ' .hi-badge{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;}',
      '#' + MOUNT_ID + ' .hi-badge.ok{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent);}',
      '#' + MOUNT_ID + ' .hi-badge.off{color:var(--text3);background:var(--bg3);}',
      '#' + MOUNT_ID + ' .hi-badge.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent);}',
      '#' + MOUNT_ID + ' .hi-act{flex-shrink:0;}',
      '#' + MOUNT_ID + ' .hi-act .btn-sm{font-size:11.5px;padding:5px 12px;}',
      '#' + MOUNT_ID + ' .hi-act .btn-sm.primary{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent);}',
      '#' + MOUNT_ID + ' .hi-empty{padding:18px 0;font-size:12.5px;color:var(--text3);}',
      '@media (max-width:560px){#' + MOUNT_ID + ' .hi-row{flex-wrap:wrap;}#' + MOUNT_ID + ' .hi-act{width:100%;padding-left:50px;}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function badge(state, text) {
    return '<span class="hi-badge ' + state + '">' + esc(text) + '</span>';
  }

  function row(o) {
    return '<div class="hi-row" data-int="' + o.key + '">' +
      '<div class="hi-ic">' + o.icon + '</div>' +
      '<div class="hi-main"><div class="hi-name">' + esc(o.name) + ' ' + o.badge + '</div>' +
      '<div class="hi-desc">' + esc(o.desc) + '</div>' +
      (o.detail ? '<div class="hi-detail">' + o.detail + '</div>' : '') + '</div>' +
      '<div class="hi-act">' + (o.action || '') + '</div></div>';
  }

  var state = { status: null, linkedin: null, error: '' };

  function headers() {
    var h = { Accept: 'application/json' };
    try {
      var s = JSON.parse(localStorage.getItem('hrms_session') || 'null');
      if (s && s.email) h['X-User-Email'] = s.email;
    } catch (e) {}
    return h;
  }

  function load() {
    state.error = '';
    var a = fetch('/api/integrations/status', { headers: headers() })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('You don’t have access to integration settings.');
        if (!r.ok) throw new Error('Couldn’t load integration status.');
        return r.json();
      })
      .then(function (d) { state.status = d; })
      .catch(function (e) { state.status = null; state.error = e.message; });
    var b = (window.HRMSLinkedIn ? window.HRMSLinkedIn.status() : Promise.resolve(null))
      .then(function (s) { state.linkedin = s; });
    return Promise.all([a, b]).then(render, render);
  }

  function render() {
    var el = document.getElementById(MOUNT_ID);
    if (!el) return;
    var head = '<div class="card-title">Integrations</div>' +
      '<div class="hi-sub">Services this HRMS is connected to. Server-side ones are set in the server’s <code>.env</code> file.</div>';
    if (state.error) { el.innerHTML = head + '<div class="hi-empty">' + esc(state.error) + '</div>'; return; }
    var s = state.status;
    if (!s) { el.innerHTML = head + '<div class="hi-empty">Loading…</div>'; return; }

    var rows = [];
    var em = s.email || {};
    rows.push(row({
      key: 'email', icon: ICON.mail, name: 'Email delivery',
      desc: 'Sign-in codes, notifications and interview emails',
      badge: em.configured ? badge('ok', 'Configured') : badge('off', 'Not configured'),
      detail: em.configured
        ? 'Sending via ' + esc(em.provider) + (em.fromEmail ? ' as ' + esc(em.fromEmail) : '')
        : 'Set <code>RESEND_API_KEY</code> and <code>RESEND_FROM_EMAIL</code>, or add SMTP details in Email Configuration.',
      action: '<button type="button" class="btn-sm" data-act="email-settings">Email settings</button>',
    }));

    var li = state.linkedin || {};
    var liBadge, liDetail = '', liAction = '';
    if (!(s.linkedin && s.linkedin.configured)) {
      liBadge = badge('off', 'Not set up');
      liDetail = 'Set <code>LINKEDIN_CLIENT_ID</code> and <code>LINKEDIN_CLIENT_SECRET</code> on the server to let users connect.';
    } else if (li.connected && !li.expired) {
      liBadge = badge('ok', 'Connected');
      liDetail = li.name ? 'Posting as ' + esc(li.name) : '';
      liAction = '<button type="button" class="btn-sm" data-act="li-disconnect">Disconnect</button>';
    } else if (li.expired) {
      liBadge = badge('warn', 'Expired');
      liDetail = 'Your LinkedIn access expired. Reconnect to keep posting jobs.';
      liAction = '<button type="button" class="btn-sm primary" data-act="li-connect">Reconnect</button>';
    } else {
      liBadge = badge('off', 'Not connected');
      liAction = '<button type="button" class="btn-sm primary" data-act="li-connect">Connect</button>';
    }
    rows.push(row({ key: 'linkedin', icon: ICON.linkedin, name: 'LinkedIn',
      desc: 'Post new job openings to your LinkedIn profile', badge: liBadge, detail: liDetail, action: liAction }));

    rows.push(row({
      key: 'google', icon: ICON.google, name: 'Google Sign-In',
      desc: '“Continue with Google” on the login page',
      badge: s.googleSignIn && s.googleSignIn.configured ? badge('ok', 'Configured') : badge('off', 'Not configured'),
      detail: s.googleSignIn && s.googleSignIn.configured ? '' : 'Set <code>GOOGLE_CLIENT_ID</code> on the server.',
    }));

    var ai = s.ai || {};
    rows.push(row({
      key: 'ai', icon: ICON.ai, name: 'AI (Anthropic Claude)',
      desc: 'Resume scoring, job descriptions and AI analytics',
      badge: ai.configured ? badge('ok', 'Configured') : badge('off', 'Not configured'),
      detail: ai.configured ? 'Model: ' + esc(ai.model) : 'Set <code>ANTHROPIC_API_KEY</code> on the server.',
    }));

    var mp = s.maps || {};
    rows.push(row({
      key: 'maps', icon: ICON.map, name: 'Maps',
      desc: 'Live attendance map and office locations',
      badge: mp.configured ? badge('ok', 'Configured') : badge('off', 'Not configured'),
      detail: mp.host ? 'Map tiles from ' + esc(mp.host) : '',
    }));

    el.innerHTML = head + rows.join('');
  }

  function openEmailSettings() {
    // The Settings page listens for this (same event the profile drawer uses).
    window.__hrmsSettingsTab = 'Email Configuration';
    window.dispatchEvent(new CustomEvent('hrmsSettingsTab', { detail: 'Email Configuration' }));
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#' + MOUNT_ID + ' [data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'email-settings') openEmailSettings();
    else if (act === 'li-connect' && window.HRMSLinkedIn && window.HRMSLinkedIn.connect) window.HRMSLinkedIn.connect();
    else if (act === 'li-disconnect' && window.HRMSLinkedIn && window.HRMSLinkedIn.disconnect) {
      t.disabled = true;
      window.HRMSLinkedIn.disconnect();
    }
  });
  window.addEventListener('hrmsLinkedInChanged', function () {
    if (document.getElementById(MOUNT_ID)) load();
  });

  // React mounts a fresh empty card each time the tab opens.
  var filled = null;
  function sync() {
    var el = document.getElementById(MOUNT_ID);
    if (el && el !== filled) {
      filled = el;
      injectStyle();
      render();
      load();
    }
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; sync(); }, 30);
  }
  function start() {
    sync();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
