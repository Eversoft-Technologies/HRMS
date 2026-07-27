/**
 * hrms-linkedin.js
 * Per-user "Connect LinkedIn" button for Settings -> Email Configuration ->
 * Social Media Accounts. Each recruiter links their OWN LinkedIn account via
 * OAuth; the token is stored server-side in user_email_config.social.linkedin
 * and used to auto-post new jobs to that recruiter's profile.
 *
 * Backend endpoints (see api/linkedin_oauth.py):
 *   GET  /api/auth/linkedin/connect?userEmail=...   (popup -> LinkedIn)
 *   GET  /api/auth/linkedin/status?userEmail=...
 *   POST /api/auth/linkedin/disconnect  {userEmail}
 *
 * Also tags POST /api/jobs with the logged-in userEmail so a job posts under
 * its creator's account (never a fallback to someone else's).
 *
 * Same injection approach as google-auth.js — no React bundle rebuild needed.
 */
(function () {
  'use strict';

  var API = '/api';
  var ROW_ID = 'hrms-li-row';
  var POLL_MS = 800;
  var configured = null; // unknown until /api/config resolves

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  // The signed-in user's email. `hrms_session` is the app's primary session key
  // (the one hrms-actor.js reads to attach X-User-Email); `hrms_user` is an
  // extra stash google-auth.js writes on Google sign-in. Check both.
  function currentEmail() {
    var keys = ['hrms_session', 'hrms_user'];
    for (var i = 0; i < keys.length; i++) {
      try {
        var o = JSON.parse(localStorage.getItem(keys[i]) || 'null');
        var em = o && (o.email || o.userEmail || o.mail);
        if (em) return em;
      } catch (e) {}
    }
    return '';
  }

  function apiGet(path) {
    return fetch(API + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); });
  }

  function apiPost(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function showToast(msg, type) {
    var existing = document.getElementById('hrms-li-toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.id = 'hrms-li-toast';
    el.style.cssText = [
      'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:99999', 'padding:12px 22px', 'border-radius:10px',
      'font-family:inherit', 'font-size:14px', 'font-weight:600',
      'box-shadow:0 4px 20px rgba(0,0,0,0.18)', 'color:#fff',
      'background:' + (type === 'error' ? '#ef4444' : '#0a66c2'),
      'pointer-events:none', 'transition:opacity 0.4s',
    ].join(';');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; }, 3000);
    setTimeout(function () { el.remove(); }, 3500);
  }

  var LI_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="flex:none">' +
    '<path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>';

  // -------------------------------------------------------------------------
  // find the LinkedIn URL input inside the Social Media Accounts section
  // -------------------------------------------------------------------------
  function findLinkedInInput() {
    var inputs = document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])');
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].placeholder || '').toLowerCase();
      if (ph.indexOf('linkedin.com') >= 0) return inputs[i];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // render the status row (button + label) under the LinkedIn input
  // -------------------------------------------------------------------------
  function makeButton(label, bg) {
    var b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:8px',
      'padding:8px 14px', 'border-radius:8px', 'border:none',
      'background:' + bg, 'color:#fff', 'font-size:13px', 'font-weight:600',
      'cursor:pointer', 'font-family:inherit', 'transition:opacity 0.2s',
    ].join(';');
    b.onmouseover = function () { b.style.opacity = '0.88'; };
    b.onmouseout = function () { b.style.opacity = '1'; };
    b.innerHTML = label;
    return b;
  }

  function renderRow(row, state) {
    row.innerHTML = '';
    row.style.cssText = 'display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap';
    var email = currentEmail();

    if (configured === false) {
      var note = document.createElement('span');
      note.style.cssText = 'font-size:12.5px;color:var(--text-muted,#94a3b8)';
      note.textContent = 'LinkedIn auto-posting isn’t set up yet — ask your administrator to configure it.';
      row.appendChild(note);
      return;
    }
    if (!email) {
      var n2 = document.createElement('span');
      n2.style.cssText = 'font-size:12.5px;color:var(--text-muted,#94a3b8)';
      n2.textContent = 'Sign in to connect your LinkedIn account.';
      row.appendChild(n2);
      return;
    }

    // Connections are per-user, so every state names the account it describes —
    // otherwise "Connect LinkedIn" looks broken to someone who linked a
    // different login.
    if (state && state.connected && !state.expired) {
      row.appendChild(statusChip('Connected as ' + (state.name || email), '#16a34a'));
      var dis = document.createElement('button');
      dis.type = 'button';
      dis.textContent = 'Disconnect';
      dis.style.cssText = 'background:none;border:none;color:#ef4444;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0';
      dis.onclick = function () { doDisconnect(row); };
      row.appendChild(dis);
      row.appendChild(subNote('New jobs you create will be posted to this profile.'));
      return;
    }

    if (state && state.expired) {
      var re = makeButton(LI_ICON + ' Reconnect LinkedIn', '#0a66c2');
      re.onclick = function () { doConnect(row); };
      row.appendChild(re);
      row.appendChild(statusChip('Connection expired', '#d97706'));
      row.appendChild(subNote('Signed in as ' + email + '. Reconnect to keep auto-posting.'));
      return;
    }

    var btn = makeButton(LI_ICON + ' Connect LinkedIn', '#0a66c2');
    btn.onclick = function () { doConnect(row); };
    row.appendChild(btn);
    row.appendChild(statusChip('Not connected', '#94a3b8'));
    row.appendChild(subNote('Signed in as ' + email + '. Required to auto-post new jobs to your profile.'));
  }

  // A coloured dot + label, shown beside the button so the state is readable
  // at a glance rather than inferred from which button is present.
  function statusChip(text, color) {
    var el = document.createElement('span');
    el.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12.5px;' +
      'font-weight:600;color:' + color;
    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;background:' + color;
    el.appendChild(dot);
    el.appendChild(document.createTextNode(text));
    return el;
  }

  // Full-width line under the button/chip pair (the row is flex-wrap).
  function subNote(text) {
    var el = document.createElement('span');
    el.style.cssText = 'flex-basis:100%;font-size:12px;color:var(--text-muted,#94a3b8)';
    el.textContent = text;
    return el;
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------
  function refreshStatus(row) {
    var email = currentEmail();
    if (!email) { renderRow(row, null); return; }
    apiGet('/auth/linkedin/status?userEmail=' + encodeURIComponent(email))
      .then(function (s) {
        if (typeof s.configured === 'boolean') configured = s.configured;
        renderRow(row, s);
      })
      .catch(function () { renderRow(row, null); });
  }

  function doConnect(row) {
    var email = currentEmail();
    if (!email) { showToast('Please sign in first.', 'error'); return; }
    var w = 600, h = 720;
    var y = window.top.outerHeight / 2 + window.top.screenY - h / 2;
    var x = window.top.outerWidth / 2 + window.top.screenX - w / 2;
    var url = API + '/auth/linkedin/connect?userEmail=' + encodeURIComponent(email);
    var popup = window.open(url, 'hrms-linkedin-connect',
      'width=' + w + ',height=' + h + ',top=' + y + ',left=' + x);
    if (!popup) { showToast('Allow popups to connect LinkedIn.', 'error'); return; }
    // Poll for the popup closing as a fallback to postMessage.
    var iv = setInterval(function () {
      if (popup.closed) { clearInterval(iv); setTimeout(function () { refreshStatus(row); }, 400); }
    }, 700);
  }

  function doDisconnect(row) {
    var email = currentEmail();
    if (!email) return;
    apiPost('/auth/linkedin/disconnect', { userEmail: email })
      .then(function () { showToast('LinkedIn disconnected.'); refreshStatus(row); })
      .catch(function () { showToast('Could not disconnect. Try again.', 'error'); });
  }

  // postMessage from the OAuth popup (api/linkedin_oauth._popup_result)
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.source !== 'hrms-linkedin') return;
    showToast(d.message || (d.ok ? 'LinkedIn connected.' : 'LinkedIn connection failed.'),
      d.ok ? 'success' : 'error');
    var row = document.getElementById(ROW_ID);
    if (row) setTimeout(function () { refreshStatus(row); }, 300);
  });

  // -------------------------------------------------------------------------
  // injection sync — keep the row present whenever the LinkedIn input shows
  // -------------------------------------------------------------------------
  function sync() {
    var input = findLinkedInInput();
    var existing = document.getElementById(ROW_ID);
    if (!input) { if (existing) existing.remove(); return; }
    if (existing) {
      // Make sure it still sits right after the input's field wrapper.
      return;
    }
    var row = document.createElement('div');
    row.id = ROW_ID;
    // Insert after the input's immediate wrapper (label/field group).
    var anchor = input;
    if (input.parentElement && input.parentElement.parentElement) {
      anchor = input.parentElement; // the field wrapper
    }
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
    renderRow(row, null);
    refreshStatus(row);
  }

  // -------------------------------------------------------------------------
  // job-create interceptor — attach the logged-in userEmail to POST /api/jobs
  // so the backend posts under the creator's own LinkedIn (not a fallback).
  // -------------------------------------------------------------------------
  function isJobsPost(url, method) {
    if (!url) return false;
    var m = (method || 'GET').toUpperCase();
    if (m !== 'POST') return false;
    return /\/api\/jobs(\?|$)/.test(String(url));
  }

  function withUserEmail(bodyStr) {
    try {
      var obj = JSON.parse(bodyStr);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        if (!obj.userEmail) {
          var em = currentEmail();
          if (em) obj.userEmail = em;
        }
        return JSON.stringify(obj);
      }
    } catch (e) {}
    return bodyStr;
  }

  // Wrap fetch
  var _fetch = window.fetch;
  if (_fetch && !_fetch.__hrmsLiWrapped) {
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var method = (init && init.method) || (input && input.method) || 'GET';
        if (isJobsPost(url, method) && init && typeof init.body === 'string') {
          init = Object.assign({}, init, { body: withUserEmail(init.body) });
        }
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
    window.fetch.__hrmsLiWrapped = true;
  }

  // Wrap XMLHttpRequest (covers axios and other XHR-based clients)
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  if (!_open.__hrmsLiWrapped) {
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__hrmsLi = { method: method, url: url };
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        var meta = this.__hrmsLi;
        if (meta && isJobsPost(meta.url, meta.method) && typeof body === 'string') {
          body = withUserEmail(body);
        }
      } catch (e) {}
      return _send.call(this, body);
    };
    XMLHttpRequest.prototype.open.__hrmsLiWrapped = true;
  }

  // -------------------------------------------------------------------------
  // shared API — hrms-jobs-table.js uses this for the "post to my LinkedIn"
  // checkbox so the status call lives in exactly one place.
  // -------------------------------------------------------------------------
  // Insert-only toolbar for the post box. Deliberately has no bold/italic/font
  // controls: LinkedIn renders posts as plain text, so those would silently be
  // lost. Emoji and symbols survive verbatim, so those are what we offer.
  function buildPlainToolbar(bar, ta) {
    if (!bar || !window.HRMSEditor) return;
    var ED = window.HRMSEditor;
    function mk(label, title, onClick) {
      var b = document.createElement('button');
      b.type = 'button'; b.title = title; b.textContent = label;
      b.style.cssText = 'background:var(--bg3,#0b1220);border:1px solid var(--border2,#1e293b);' +
        'color:inherit;border-radius:6px;min-width:30px;height:28px;padding:0 8px;' +
        'font:14px/1 inherit;cursor:pointer';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); onClick(b); });
      bar.appendChild(b);
      return b;
    }
    mk('😊', 'Insert emoji', function (b) { ED.emoji(b, function (ch) { ED.insertAtCursor(ta, ch); }); });
    ['✔', '◆', '•', '📍', '💼', '🎓', '💰', '📧', '📞'].forEach(function (ch) {
      mk(ch, 'Insert ' + ch, function () { ED.insertAtCursor(ta, ch + ' '); });
    });
    mk('—', 'Insert divider line', function () { ED.insertAtCursor(ta, '\n————————————\n'); });
    var hint = document.createElement('span');
    hint.style.cssText = 'font-size:11.5px;color:var(--text3,#94a3b8);margin-left:4px';
    hint.textContent = 'Plain text only — LinkedIn ignores bold, colour and fonts.';
    bar.appendChild(hint);
  }

  // Review-before-post dialog. Resolves with the approved text, or null if the
  // user backed out. Self-styled so both job forms can share it regardless of
  // which stylesheet they own.
  function review(job, email) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.id = 'hrms-li-review';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.62);' +
        'display:flex;align-items:center;justify-content:center;padding:20px';
      ov.innerHTML =
        '<div style="background:var(--bg2,#0f172a);color:var(--text,#e2e8f0);border:1px solid var(--border2,#1e293b);' +
          'border-radius:14px;width:min(680px,100%);max-height:92vh;display:flex;flex-direction:column;' +
          'box-shadow:0 20px 60px rgba(0,0,0,.45);font-family:inherit">' +
          '<div style="display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border2,#1e293b)">' +
            '<span style="color:#0a66c2">' + LI_ICON + '</span>' +
            '<h3 style="margin:0;font-size:15px;font-weight:700;flex:1">Review your LinkedIn post</h3>' +
            '<button type="button" id="lir-x" style="background:none;border:none;color:inherit;font-size:22px;line-height:1;cursor:pointer;opacity:.6">×</button>' +
          '</div>' +
          '<div style="padding:14px 20px;overflow:auto;flex:1">' +
            '<p style="margin:0 0 10px;font-size:12.5px;color:var(--text3,#94a3b8)">' +
              'This is what will appear on your profile. Edit it freely — the job is only created once you confirm.<br>' +
              'LinkedIn posts are plain text, so emoji and symbols carry over exactly as you see them here.</p>' +
            '<div id="lir-tb" style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:6px"></div>' +
            '<textarea id="lir-text" spellcheck="true" style="width:100%;min-height:320px;resize:vertical;box-sizing:border-box;' +
              'background:var(--bg3,#0b1220);border:1px solid var(--border2,#1e293b);border-radius:8px;color:inherit;' +
              'font:13px/1.6 inherit;padding:12px"></textarea>' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;font-size:12px;color:var(--text3,#94a3b8)">' +
              '<span id="lir-count"></span>' +
              '<button type="button" id="lir-reset" style="background:none;border:none;color:#0a66c2;font:inherit;font-weight:600;cursor:pointer;padding:0">Reset to suggested text</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--border2,#1e293b)">' +
            '<span id="lir-msg" style="font-size:12px;font-weight:600;color:#ef4444;margin-right:auto"></span>' +
            '<button type="button" id="lir-back" style="padding:9px 16px;border-radius:8px;border:1px solid var(--border2,#1e293b);background:none;color:inherit;font:600 13px inherit;cursor:pointer">Back</button>' +
            '<button type="button" id="lir-post" style="padding:9px 16px;border-radius:8px;border:none;background:#0a66c2;color:#fff;font:600 13px inherit;cursor:pointer">Post job &amp; share</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);

      var ta = ov.querySelector('#lir-text');
      var msg = ov.querySelector('#lir-msg');
      var suggested = '';
      function count() {
        var n = ta.value.length;
        // LinkedIn hides anything past ~3,000 chars behind "…see more".
        ov.querySelector('#lir-count').textContent = n + ' characters' +
          (n > 3000 ? ' — over LinkedIn’s ~3,000 limit, it may be cut off' : '');
      }
      ta.addEventListener('input', count);
      ta.value = 'Building preview…';
      ta.disabled = true;
      buildPlainToolbar(ov.querySelector('#lir-tb'), ta);

      apiPost('/auth/linkedin/preview', { job: job, userEmail: email || currentEmail() })
        .then(function (r) {
          suggested = (r && r.text) || '';
          ta.disabled = false; ta.value = suggested; count(); ta.focus();
        })
        .catch(function () {
          // Let them write it by hand rather than blocking the post entirely.
          ta.disabled = false; ta.value = '';
          msg.textContent = 'Could not build a draft — write your post below.';
          count();
        });

      var done = false;
      function finish(val) { if (done) return; done = true; ov.remove(); resolve(val); }
      ov.querySelector('#lir-x').onclick = function () { finish(null); };
      ov.querySelector('#lir-back').onclick = function () { finish(null); };
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) finish(null); });
      ov.querySelector('#lir-reset').onclick = function () { ta.value = suggested; count(); };
      ov.querySelector('#lir-post').onclick = function () {
        var text = ta.value.trim();
        if (!text) { msg.textContent = 'Write something to post, or go Back and untick the option.'; return; }
        finish(text);
      };
    });
  }

  window.HRMSLinkedIn = {
    currentEmail: currentEmail,
    review: review,
    // -> Promise<{configured, connected, expired, name}>; never rejects, so
    // callers can treat an unreachable backend as simply "not connected".
    status: function () {
      var email = currentEmail();
      if (!email) {
        return Promise.resolve({ configured: configured !== false, connected: false, expired: false, name: '' });
      }
      return apiGet('/auth/linkedin/status?userEmail=' + encodeURIComponent(email))
        .then(function (s) {
          if (s && typeof s.configured === 'boolean') configured = s.configured;
          return s || {};
        })
        .catch(function () {
          return { configured: false, connected: false, expired: false, name: '' };
        });
    },
  };

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  function boot() {
    apiGet('/config')
      .then(function (cfg) {
        if (cfg && typeof cfg.linkedinConfigured === 'boolean') configured = cfg.linkedinConfigured;
      })
      .catch(function () {})
      .then(function () {
        setInterval(sync, POLL_MS);
        setTimeout(sync, 600);
        setTimeout(sync, 1500);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
