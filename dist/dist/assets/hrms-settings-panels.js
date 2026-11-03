/* Settings › Notifications and Settings › AI Settings, backed by the server.
 *
 * The React bundle renders both as static mock-ups: the notification toggles
 * saved nothing, and the "Anthropic API Key" card kept the key in the
 * browser's localStorage and sent it with every AI request. This overlay
 * replaces both cards:
 *
 *   Notifications → GET/PUT /api/user-settings/<me>/notification-preferences
 *   AI Settings   → GET /api/ai/settings (safe metadata only), POST
 *                   /api/ai/settings/validate, PUT/DELETE /api/ai/settings/key,
 *                   GET /api/ai/settings/audit. The key is sent once over the
 *                   API to be validated and stored encrypted on the server; it
 *                   is never kept in the page or in browser storage.
 *
 * React owns its cards, so they are only HIDDEN (never removed or moved —
 * removing a React node crashes the app when React later unmounts it). Our
 * card sits next to the hidden one and is dropped when React unmounts it.
 */
(function () {
  'use strict';

  /* Any key an older build stored in the browser is removed for good. */
  try { localStorage.removeItem('hrms_ai_key'); } catch (_) {}
  /* Older builds cached every login *with its password* in localStorage
     (hrms_users), including a hard-coded default admin. Passwords now live
     only on the server, hashed — strip any copies left in this browser. */
  try {
    var cached = JSON.parse(localStorage.getItem('hrms_users') || 'null');
    if (Array.isArray(cached) && cached.some(function (u) { return u && 'password' in u; })) {
      localStorage.setItem('hrms_users', JSON.stringify(cached.filter(function (u) {
        return u && String(u.email || '').toLowerCase() !== 'admin@eversoftit.com';
      }).map(function (u) { var c = {}; for (var k in u) if (k !== 'password') c[k] = u[k]; return c; })));
    }
  } catch (_) {}

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function me() {
    try { return String((JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}).email || '').trim().toLowerCase(); }
    catch (_) { return ''; }
  }
  function onSettings() { return (location.pathname || '').replace(/\/+$/, '') === '/settings'; }
  function api(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var e = new Error((d && (d.message || d.detail)) || ('Request failed (' + r.status + ')'));
          e.status = r.status; e.code = d && d.code;
          throw e;
        }
        return d;
      });
    });
  }
  function jsonOpts(method, body) {
    return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function ensureStyle() {
    if (document.getElementById('hrms-sp-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-sp-style';
    st.textContent =
      '.hsp-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border2)}' +
      '.hsp-row:last-child{border-bottom:0}' +
      '.hsp-l{flex:1;min-width:0}.hsp-t{font-size:12px;font-weight:500}.hsp-s{font-size:11px;color:var(--text3)}' +
      '.hsp-idle{font-size:10.5px;color:var(--text3);font-style:italic;margin-left:6px}' +
      '.hsp-tg{width:38px;height:22px;border-radius:11px;background:var(--bg3);border:1px solid var(--border2);position:relative;cursor:pointer;flex-shrink:0;transition:background .2s;padding:0}' +
      '.hsp-tg[aria-checked="true"]{background:var(--accent)}' +
      '.hsp-tg::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .2s}' +
      '.hsp-tg[aria-checked="true"]::after{left:18px}.hsp-tg:disabled{opacity:.6;cursor:wait}' +
      '.hsp-tg:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
      '.hsp-msg{font-size:11.5px;margin-top:8px;min-height:15px}.hsp-msg.err{color:var(--red,#ef4444)}.hsp-msg.ok{color:var(--green,#22c55e)}' +
      '.hsp-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;font-size:12px;margin-bottom:12px}' +
      '.hsp-kv dt{color:var(--text3)}.hsp-kv dd{margin:0;word-break:break-word}' +
      '.hsp-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
      '.hsp-warn{font-size:11.5px;line-height:1.5;padding:8px 10px;border-radius:8px;margin-bottom:10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3)}' +
      '.hsp-note{font-size:11px;color:var(--text3);line-height:1.6;margin-top:8px}' +
      '.hsp-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
      '.hsp-audit{font-size:11.5px;margin:0;padding:0;list-style:none}.hsp-audit li{padding:6px 0;border-bottom:1px solid var(--border2);display:flex;gap:10px;flex-wrap:wrap}' +
      '.hsp-audit li:last-child{border-bottom:0}.hsp-audit .w{color:var(--text3);min-width:150px}' +
      '@media(max-width:600px){.hsp-kv{grid-template-columns:1fr}.hsp-kv dt{margin-top:4px}}';
    document.head.appendChild(st);
  }

  /* ── generic "replace a React card in place" mount ─────────────────────── */
  function reactCard(title) {
    var titles = document.querySelectorAll('.content .card > .card-title');
    for (var i = 0; i < titles.length; i++) {
      var card = titles[i].parentNode;
      if (card.hasAttribute('data-hsp-hidden') || card.hasAttribute('data-hsp-own')) continue;
      if ((titles[i].textContent || '').trim() === title) return card;
    }
    return null;
  }
  function cardTitle(card) {
    var t = card && card.querySelector(':scope > .card-title');
    return t ? (t.textContent || '').trim() : '';
  }

  var panels = [];
  function panel(spec) { spec.hidden = null; spec.root = null; panels.push(spec); }

  function tick() {
    panels.forEach(function (p) {
      // Drop ours once React unmounted (or reused) the card we stand in for.
      if (p.root && (!onSettings() || !p.hidden || !p.hidden.isConnected || cardTitle(p.hidden) !== p.title)) {
        if (p.hidden && p.hidden.isConnected) { p.hidden.style.display = ''; p.hidden.removeAttribute('data-hsp-hidden'); }
        if (p.root.parentNode) p.root.parentNode.removeChild(p.root);
        p.root = null; p.hidden = null;
      }
      if (p.root || !onSettings()) return;
      var card = reactCard(p.title);
      if (!card || !card.parentNode) return;
      ensureStyle();
      var root = document.createElement('div');
      root.className = 'card';
      root.setAttribute('data-hsp-own', p.key);
      if (card.getAttribute('style')) root.setAttribute('style', card.getAttribute('style'));
      card.parentNode.insertBefore(root, card);
      card.style.display = 'none';
      card.setAttribute('data-hsp-hidden', p.key);
      p.root = root; p.hidden = card;
      p.build(root);
    });
  }

  /* ── Notifications ────────────────────────────────────────────────────── */
  panel({
    key: 'notif',
    title: 'Notification Preferences',
    build: function (root) {
      var email = me();
      root.innerHTML = '<div class="card-title">Notification Preferences</div><div class="hsp-s" data-n="body">Loading…</div>';
      if (!email) { root.querySelector('[data-n="body"]').textContent = 'Sign in to manage your notifications.'; return; }
      var url = '/api/user-settings/' + encodeURIComponent(email) + '/notification-preferences';
      api(url).then(function (d) { renderNotif(root, url, d); })
        .catch(function (e) { root.querySelector('[data-n="body"]').textContent = 'Could not load your preferences: ' + e.message; });
    }
  });

  function renderNotif(root, url, d) {
    var rows = (d.categories || []).map(function (c) {
      return '<div class="hsp-row">' +
        '<div class="hsp-l"><div class="hsp-t">' + esc(c.label) + '</div>' +
        '<div class="hsp-s">' + esc(c.channels) +
        (c.active ? '' : '<span class="hsp-idle" title="The app does not send this kind of notification yet; your choice will apply once it does.">· not sent yet</span>') +
        '</div></div>' +
        '<button type="button" class="hsp-tg" role="switch" aria-label="' + esc(c.label) + '" aria-checked="' + (c.enabled ? 'true' : 'false') + '" data-cat="' + esc(c.key) + '"></button>' +
        '</div>';
    }).join('');
    root.innerHTML = '<div class="card-title">Notification Preferences</div>' + rows +
      '<div class="hsp-msg" data-n="msg" aria-live="polite"></div>' + soundHtml(d.sound || {});
    var msg = root.querySelector('[data-n="msg"]');
    wireSound(root, url, d.sound || {});
    root.querySelectorAll('.hsp-tg[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-cat');
        var next = b.getAttribute('aria-checked') !== 'true';
        b.setAttribute('aria-checked', next ? 'true' : 'false');
        b.disabled = true;
        var body = { prefs: {} }; body.prefs[key] = next;
        api(url, jsonOpts('PUT', body)).then(function () {
          msg.className = 'hsp-msg ok'; msg.textContent = 'Saved.';
          setTimeout(function () { if (msg.textContent === 'Saved.') msg.textContent = ''; }, 1800);
        }).catch(function (e) {
          b.setAttribute('aria-checked', next ? 'false' : 'true');   // revert
          msg.className = 'hsp-msg err'; msg.textContent = 'Not saved: ' + e.message;
        }).then(function () { b.disabled = false; });
      });
    });
  }

  /* ── Sounds & desktop pop-ups (played by hrms-sounds.js) ─────────────── */
  function popupState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;   // default | granted | denied
  }
  function soundRow(key, label, sub, on, test) {
    return '<div class="hsp-row"><div class="hsp-l"><div class="hsp-t">' + esc(label) + '</div>' +
      '<div class="hsp-s" data-snd-sub="' + key + '">' + sub + '</div></div>' +
      (test ? '<button type="button" class="btn-sm" data-snd-test="' + test + '" style="font-size:11.5px;padding:4px 10px">▶ Test</button>' : '') +
      '<button type="button" class="hsp-tg" role="switch" aria-label="' + esc(label) + '" aria-checked="' + (on ? 'true' : 'false') + '" data-snd="' + key + '"></button></div>';
  }
  function popupSub(on) {
    var st = popupState();
    if (st === 'unsupported') return 'This browser cannot show desktop pop-ups.';
    if (st === 'denied') return '<span style="color:var(--red,#ef4444)">Blocked by the browser.</span> Click the lock icon in the address bar → Notifications → Allow, then turn this on again.';
    return on && st === 'granted' ? 'Shown in the corner of your screen when HRMS is in the background.'
                                   : 'Show new notifications and messages as a pop-up when HRMS is in the background.';
  }
  var TONE_FALLBACK = {
    notify: [['chime', 'Chime'], ['bell', 'Bell'], ['marimba', 'Marimba'], ['glass', 'Glass'], ['alert', 'Alert']],
    message: [['pop', 'Pop'], ['blip', 'Blip'], ['bubble', 'Bubble'], ['drop', 'Drop'], ['click', 'Click']]
  };
  function toneOptions(kind, current) {
    var list = (window.__hrmsAlerts && window.__hrmsAlerts.tones ? window.__hrmsAlerts.tones() : TONE_FALLBACK)[kind];
    return '<select class="haa-in" data-snd-tone="' + (kind === 'message' ? 'messageTone' : 'notificationTone') + '" data-kind="' + kind + '"' +
      ' aria-label="' + (kind === 'message' ? 'Chat message' : 'Notification') + ' sound" style="background:var(--bg3,#f8fafc);border:1px solid var(--border2,#e5e7eb);color:var(--text,#0f172a);border-radius:7px;padding:4px 8px;font:inherit;font-size:12.5px;margin-right:6px">' +
      list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === current ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  function soundHtml(s) {
    var vol = typeof s.volume === 'number' ? s.volume : 70;
    return '<div style="margin-top:18px"><div class="card-title">Sounds &amp; pop-ups</div>' +
      soundRow('notificationSound', 'Notification sound', 'Pick one of 5 sounds for new notifications.', s.notificationSound !== false, 'notify')
        .replace('<button type="button" class="btn-sm" data-snd-test', toneOptions('notify', s.notificationTone || 'chime') + '<button type="button" class="btn-sm" data-snd-test') +
      soundRow('messageSound', 'Chat message sound', 'Pick one of 5 sounds for new chat messages.', s.messageSound !== false, 'message')
        .replace('<button type="button" class="btn-sm" data-snd-test', toneOptions('message', s.messageTone || 'pop') + '<button type="button" class="btn-sm" data-snd-test') +
      soundRow('inAppPopups', 'Pop-ups in HRMS', 'A card in the top-right corner for each new notification or message while you use HRMS.', s.inAppPopups !== false, '') +
      '<div class="hsp-row"><div class="hsp-l"><div class="hsp-t">Volume</div><div class="hsp-s">Applies to both sounds.</div></div>' +
      '<input type="range" min="0" max="100" step="5" value="' + vol + '" data-snd-vol aria-label="Alert volume" style="width:160px">' +
      '<span class="hsp-s" data-snd-volv style="min-width:36px;text-align:right">' + vol + '%</span></div>' +
      soundRow('desktopPopups', 'Desktop pop-ups', popupSub(!!s.desktopPopups), !!s.desktopPopups && popupState() === 'granted', '') +
      soundRow('muteInDnd', 'Silence while "Do not disturb"', 'No sounds or pop-ups while your status is Do not disturb.', s.muteInDnd !== false, '') +
      '<div class="hsp-row"><div class="hsp-l"><div class="hsp-t">Check pop-ups</div><div class="hsp-s">Shows a test pop-up and tells you if anything is blocking it.</div></div>' +
      '<button type="button" class="btn-sm" data-snd-testpop style="font-size:11.5px;padding:4px 10px">Test pop-up</button></div>' +
      '<div class="hsp-msg" data-snd-msg aria-live="polite"></div></div>';
  }
  function wireSound(root, url, s) {
    var msg = root.querySelector('[data-snd-msg]');
    function say(text, kind) { msg.className = 'hsp-msg ' + (kind || ''); msg.textContent = text; if (kind === 'ok') setTimeout(function () { if (msg.textContent === text) msg.textContent = ''; }, 1800); }
    function save(patch) {
      return api(url, jsonOpts('PUT', { sound: patch })).then(function (d) {
        window.dispatchEvent(new CustomEvent('hrmsAlertSettings', { detail: d.sound }));   // hrms-sounds.js applies it now
        say('Saved.', 'ok');
        return d.sound;
      });
    }
    root.querySelectorAll('.hsp-tg[data-snd]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-snd');
        var next = b.getAttribute('aria-checked') !== 'true';
        var ask = Promise.resolve('granted');
        if (key === 'desktopPopups' && next) {
          var st = popupState();
          if (st === 'unsupported') { say('This browser cannot show desktop pop-ups.', 'err'); return; }
          ask = st === 'default' ? Notification.requestPermission() : Promise.resolve(st);
        }
        b.disabled = true;
        ask.then(function (perm) {
          if (key === 'desktopPopups' && next && perm !== 'granted') {
            var sub = root.querySelector('[data-snd-sub="desktopPopups"]');
            if (sub) sub.innerHTML = popupSub(false);
            throw new Error('Pop-ups are blocked for this site. Allow notifications for this site in the browser, then try again.');
          }
          b.setAttribute('aria-checked', next ? 'true' : 'false');
          var patch = {}; patch[key] = next;
          return save(patch).then(function () {
            if (key === 'desktopPopups') {
              var sub2 = root.querySelector('[data-snd-sub="desktopPopups"]');
              if (sub2) sub2.innerHTML = popupSub(next);
            }
          });
        }).catch(function (e) {
          b.setAttribute('aria-checked', next ? 'false' : 'true');
          say(e.message, 'err');
        }).then(function () { b.disabled = false; });
      });
    });
    var vol = root.querySelector('[data-snd-vol]'), volv = root.querySelector('[data-snd-volv]');
    if (vol) {
      vol.addEventListener('input', function () { volv.textContent = vol.value + '%'; });
      vol.addEventListener('change', function () {
        save({ volume: Number(vol.value) }).then(function () {
          if (window.__hrmsAlerts) window.__hrmsAlerts.test('notify');   // hear the new level
        }).catch(function (e) { say('Not saved: ' + e.message, 'err'); });
      });
    }
    root.querySelectorAll('[data-snd-test]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.__hrmsAlerts) { say('Sounds are still loading — try again in a moment.', 'err'); return; }
        var kind = b.getAttribute('data-snd-test');
        var sel = root.querySelector('[data-snd-tone][data-kind="' + kind + '"]');
        if (!window.__hrmsAlerts.test(kind, sel && sel.value)) say('Your browser blocked the sound, or the volume is 0.', 'err');
      });
    });
    root.querySelectorAll('[data-snd-tone]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (window.__hrmsAlerts) window.__hrmsAlerts.test(sel.getAttribute('data-kind'), sel.value);   // hear it now
        var patch = {}; patch[sel.getAttribute('data-snd-tone')] = sel.value;
        save(patch).catch(function (e) { say('Not saved: ' + e.message, 'err'); });
      });
    });
    var tp = root.querySelector('[data-snd-testpop]');
    if (tp) tp.addEventListener('click', function () {
      if (!window.__hrmsAlerts || !window.__hrmsAlerts.testPopup) { say('Pop-ups are still loading — try again in a moment.', 'err'); return; }
      var r = window.__hrmsAlerts.testPopup();
      say(r.desktop === 'shown'
        ? 'Shown inside HRMS and as a desktop pop-up. If no desktop pop-up appeared, allow notifications for your browser in Windows Settings › System › Notifications and switch off Focus assist.'
        : r.desktop === 'denied' ? 'Shown inside HRMS. Desktop pop-ups are blocked for this site: lock icon in the address bar › Notifications › Allow.'
        : r.desktop === 'default' ? 'Shown inside HRMS. Turn on Desktop pop-ups to also get them when HRMS is in the background.'
        : 'Shown inside HRMS. This browser cannot show desktop pop-ups here (they need https or localhost).', '');
    });
  }

  /* ── AI Settings ──────────────────────────────────────────────────────── */
  panel({
    key: 'ai',
    title: 'Anthropic API Key',
    build: function (root) { loadAi(root, ''); }
  });

  function loadAi(root, flash) {
    root.innerHTML = '<div class="card-title">AI Provider Key</div><div class="hsp-s">Loading…</div>';
    api('/api/ai/settings').then(function (m) {
      renderAi(root, m, flash);
      api('/api/ai/settings/audit').then(function (a) { renderAudit(root, a.events || []); }).catch(function () {});
    }).catch(function (e) {
      root.innerHTML = '<div class="card-title">AI Provider Key</div><div class="hsp-s">' +
        (e.status === 403 ? 'AI settings are restricted to approved administrators.' : 'Could not load the AI settings: ' + esc(e.message)) + '</div>';
    });
  }

  function renderAi(root, m, flash) {
    var ok = m.configured;
    var managed = m.managed || {};
    var warn = '';
    if (m.source === 'legacy_environment' || m.legacyViteKeyPresent)
      warn += '<div class="hsp-warn">The server still has <b>VITE_ANTHROPIC_API_KEY</b>. VITE_ values can end up in browser code. Move the key to <b>ANTHROPIC_API_KEY</b> (or save it here) and delete the VITE_ variable.</div>';
    if (managed.present && !managed.readable)
      warn += '<div class="hsp-warn">A key is saved but the server cannot decrypt it (HRMS_SECRETS_KEY changed or missing). AI is using the fallback. Save the key again to fix this.</div>';
    if (m.canManage && !m.encryptionReady)
      warn += '<div class="hsp-warn">Saving a key here is disabled: the server has no usable encryption key (<b>HRMS_SECRETS_KEY</b> is invalid, or the automatic key file is switched off). You can still set <b>ANTHROPIC_API_KEY</b> in the server environment.</div>';

    var html = '<div class="card-title">AI Provider Key</div>' + warn +
      '<dl class="hsp-kv">' +
      (m.canManage && m.encryptionKeySource ? '<dt>Encryption key</dt><dd>' + ({ environment: 'Set in the server environment (HRMS_SECRETS_KEY)', file: 'Kept in a key file on the server (outside the database)', auto: 'Created automatically on the server when you first save' }[m.encryptionKeySource] || '') + '</dd>' : '') +
      '<dt>Status</dt><dd><span class="hsp-dot" style="background:' + (ok ? 'var(--green,#22c55e)' : 'var(--text3)') + '"></span>' + (ok ? 'Configured' : 'Not configured — AI features are off') + '</dd>' +
      '<dt>Provider</dt><dd>' + esc(m.providerLabel || m.provider) + '</dd>' +
      '<dt>Model</dt><dd>' + esc(m.model) + (m.validationModel ? ' <span class="hsp-s">(checks: ' + esc(m.validationModel) + ')</span>' : '') + '</dd>' +
      '<dt>Key source</dt><dd>' + esc(m.sourceLabel) + '</dd>' +
      (m.keyFingerprint ? '<dt>Active key ID</dt><dd><code>' + esc(m.keyFingerprint) + '</code> <span class="hsp-s">(fingerprint, not the key)</span></dd>' : '') +
      (managed.present ? '<dt>Saved key</dt><dd>by ' + esc(managed.updatedBy || '—') + ' · ' + esc(fmtTime(managed.updatedAt)) + '</dd>' : '') +
      '</dl>';

    if (m.canManage) {
      html += '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<input class="input-field" data-a="key" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (managed.present ? 'New key to rotate to (sk-ant-…)' : 'sk-ant-api03-…') + '" style="flex:1;min-width:220px"' + (m.encryptionReady ? '' : ' disabled') + '>' +
        '</div>' +
        '<div class="hsp-btns">' +
        '<button type="button" class="btn-sm" data-a="test">Test key</button>' +
        '<button type="button" class="btn-primary" data-a="save"' + (m.encryptionReady ? '' : ' disabled') + ' style="padding:7px 16px">' + (managed.present ? 'Rotate key' : 'Save &amp; activate') + '</button>' +
        (managed.present ? '<button type="button" class="btn-sm" data-a="remove" style="color:var(--red,#ef4444)">Remove saved key</button>' : '') +
        '</div>' +
        '<div class="hsp-msg" data-a="msg" aria-live="polite"></div>' +
        '<div class="hsp-note">The key is checked with a minimal request before it is activated, stored encrypted on the server, and never shown again. ' + esc(m.fallbackPolicy || '') + '</div>';
    } else {
      html += '<div class="hsp-note">Only administrators with the “Manage AI Settings” permission can change the key.</div>';
    }
    html += '<div style="margin-top:16px"><div class="card-title" style="font-size:11px">Change history</div><ul class="hsp-audit" data-a="audit"><li class="hsp-s">Loading…</li></ul></div>';
    root.innerHTML = html;

    var msg = root.querySelector('[data-a="msg"]');
    function say(text, kind) { if (msg) { msg.className = 'hsp-msg ' + (kind || ''); msg.textContent = text; } }
    if (flash) say(flash, 'ok');
    var input = root.querySelector('[data-a="key"]');
    function keyValue() { return input ? input.value.trim() : ''; }
    function busy(on) { root.querySelectorAll('[data-a="test"],[data-a="save"],[data-a="remove"]').forEach(function (b) { b.disabled = on || (b.getAttribute('data-a') === 'save' && !m.encryptionReady); }); }
    function failed(e) {
      busy(false);
      say(e.code === 'REAUTH_REQUIRED' ? e.message : (e.message || 'Something went wrong.'), 'err');
      api('/api/ai/settings/audit').then(function (a) { renderAudit(root, a.events || []); }).catch(function () {});
    }

    var t = root.querySelector('[data-a="test"]');
    if (t) t.addEventListener('click', function () {
      if (!keyValue()) { say('Paste the key to test first.', 'err'); return; }
      busy(true); say('Testing…');
      api('/api/ai/settings/validate', jsonOpts('POST', { apiKey: keyValue() })).then(function (r) {
        busy(false); say(r.message, r.valid ? 'ok' : 'err');
        api('/api/ai/settings/audit').then(function (a) { renderAudit(root, a.events || []); }).catch(function () {});
      }).catch(failed);
    });
    var s = root.querySelector('[data-a="save"]');
    if (s) s.addEventListener('click', function () {
      if (!keyValue()) { say('Paste the key first.', 'err'); return; }
      busy(true); say('Checking the key with Anthropic…');
      api('/api/ai/settings/key', jsonOpts('PUT', { apiKey: keyValue() })).then(function () {
        if (input) input.value = '';
        loadAi(root, managed.present ? 'Key rotated. AI now uses the new key.' : 'Key saved and active.');
      }).catch(function (e) { if (input) input.focus(); failed(e); });
    });
    var rm = root.querySelector('[data-a="remove"]');
    if (rm) rm.addEventListener('click', function () {
      var fallback = m.environmentKeyPresent ? 'AI will fall back to the key in the server environment.'
                                             : 'No other key is configured, so AI features will be switched off.';
      if (!window.confirm('Remove the saved AI key? ' + fallback)) return;
      busy(true); say('Removing…');
      api('/api/ai/settings/key', { method: 'DELETE' }).then(function () {
        loadAi(root, 'Saved key removed. ' + fallback);
      }).catch(failed);
    });
  }

  var ACTIONS = {
    key_saved: 'saved a key', key_rotated: 'rotated the key', key_removed: 'removed the saved key',
    key_tested: 'tested a key (valid)', key_test_failed: 'tested a key (rejected)', key_rejected: 'tried to save a key that was rejected'
  };
  function renderAudit(root, events) {
    var ul = root.querySelector('[data-a="audit"]');
    if (!ul) return;
    if (!events.length) { ul.innerHTML = '<li class="hsp-s">No changes yet.</li>'; return; }
    ul.innerHTML = events.slice(0, 10).map(function (e) {
      return '<li><span class="w">' + esc(fmtTime(e.at)) + '</span><span><b>' + esc(e.actor) + '</b> ' + esc(ACTIONS[e.action] || e.action) +
        (e.keyFingerprint ? ' <code class="hsp-s">' + esc(e.keyFingerprint) + '</code>' : '') +
        (e.detail ? ' <span class="hsp-s">— ' + esc(e.detail) + '</span>' : '') + '</span></li>';
    }).join('');
  }

  /* ── Browser password autofill must not hit the topbar search ────────────
     A page with a password field (SMTP password, AI key) looks like a login
     form to the browser's password manager, which then fills the saved login
     email into the nearest text box: the topbar "Search anything" input. That
     autofill fires an input event, so the search dropdown popped open with the
     user's email in it every time Settings was opened.
       1. Every password field is marked autocomplete="new-password", which
          tells the browser not to offer saved logins on this page.
       2. Belt and braces: input reaching the search box while it is NOT
          focused (only autofill does that) is discarded before React sees it. */
  function isTopSearch(el) {
    return !!(el && el.tagName === 'INPUT' && el.closest && el.closest('.topbar') &&
              /search/i.test(el.getAttribute('placeholder') || ''));
  }
  function hardenAutofill() {
    document.querySelectorAll('input[type="password"]').forEach(function (i) {
      if (i.getAttribute('autocomplete') !== 'new-password') i.setAttribute('autocomplete', 'new-password');
      // The saved SMTP password is encrypted on the server and never sent back,
      // so the field is always empty: say what an empty field means.
      if (i.getAttribute('placeholder') === '••••••••' && i.closest('.content') && !i.hasAttribute('data-hsp-smtp')) {
        i.setAttribute('data-hsp-smtp', '1');
        i.setAttribute('placeholder', 'Leave blank to keep the saved password');
        i.title = 'Stored encrypted on the server and never shown. Type a new password only to change it.';
      }
    });
    document.querySelectorAll('.topbar input').forEach(function (i) {
      if (isTopSearch(i) && i.getAttribute('autocomplete') !== 'off') {
        i.setAttribute('autocomplete', 'off');
        i.setAttribute('name', 'hrms-global-search');
        i.setAttribute('data-lpignore', 'true');      // password-manager extensions
        i.setAttribute('data-1p-ignore', 'true');
      }
    });
  }
  ['input', 'change'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      var el = e.target;
      if (!isTopSearch(el) || el === document.activeElement) return;
      e.stopImmediatePropagation();
      el.value = '';
    }, true);
  });
  var hardenQueued = false;
  new MutationObserver(function () {
    if (hardenQueued) return;
    hardenQueued = true;
    setTimeout(function () { hardenQueued = false; hardenAutofill(); }, 0);
  }).observe(document.documentElement, { childList: true, subtree: true });
  hardenAutofill();

  setInterval(tick, 300);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();

  window.__hrmsSettingsPanels = { tick: tick };
})();
