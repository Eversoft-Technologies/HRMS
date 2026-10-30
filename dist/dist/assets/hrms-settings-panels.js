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
      '<div class="hsp-msg" data-n="msg" aria-live="polite"></div>';
    var msg = root.querySelector('[data-n="msg"]');
    root.querySelectorAll('.hsp-tg').forEach(function (b) {
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
      warn += '<div class="hsp-warn">Saving a key here is disabled until <b>HRMS_SECRETS_KEY</b> is set on the server. You can still set <b>ANTHROPIC_API_KEY</b> in the server environment.</div>';

    var html = '<div class="card-title">AI Provider Key</div>' + warn +
      '<dl class="hsp-kv">' +
      '<dt>Status</dt><dd><span class="hsp-dot" style="background:' + (ok ? 'var(--green,#22c55e)' : 'var(--text3)') + '"></span>' + (ok ? 'Configured' : 'Not configured — AI features are off') + '</dd>' +
      '<dt>Provider</dt><dd>' + esc(m.providerLabel || m.provider) + '</dd>' +
      '<dt>Model</dt><dd>' + esc(m.model) + (m.validationModel ? ' <span class="hsp-s">(checks: ' + esc(m.validationModel) + ')</span>' : '') + '</dd>' +
      '<dt>Key source</dt><dd>' + esc(m.sourceLabel) + '</dd>' +
      (m.keyFingerprint ? '<dt>Active key ID</dt><dd><code>' + esc(m.keyFingerprint) + '</code> <span class="hsp-s">(fingerprint, not the key)</span></dd>' : '') +
      (managed.present ? '<dt>Saved key</dt><dd>by ' + esc(managed.updatedBy || '—') + ' · ' + esc(fmtTime(managed.updatedAt)) + '</dd>' : '') +
      '</dl>';

    if (m.canManage) {
      html += '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<input class="input-field" data-a="key" type="password" autocomplete="off" spellcheck="false" placeholder="' + (managed.present ? 'New key to rotate to (sk-ant-…)' : 'sk-ant-api03-…') + '" style="flex:1;min-width:220px"' + (m.encryptionReady ? '' : ' disabled') + '>' +
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

  setInterval(tick, 300);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();

  window.__hrmsSettingsPanels = { tick: tick };
})();
