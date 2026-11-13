/* HRMS alerts — notification + chat-message sounds and desktop pop-ups.
 *
 * The one place that makes noise. Other scripts report what they already know:
 *   hrms-notifications.js  → __hrmsAlerts.notify(unreadItems)       (bell poll)
 *   hrms-chat.js / -dock   → __hrmsAlerts.chatUnread(total, source)  (unread totals)
 *                          → __hrmsAlerts.chatMessage(msg, room)     (open conversation)
 * and this script also polls on its own (chat unread every 10 s; unread
 * notifications every 30 s while the tab is hidden, because the bell pauses
 * then) so alerts work on every page.
 *
 * Sounds are synthesised with Web Audio (no audio files): "notify" is a soft
 * two-note chime, "message" a short pop. Browsers only allow audio after a user
 * gesture, so the audio context is unlocked on the first click / key press.
 *
 * Desktop pop-ups (Notification API) only when the HRMS tab is not visible and
 * the user turned them on in Settings › Notifications (permission is requested
 * from that toggle, never on page load).
 *
 * Settings are per user on the server: GET/PUT
 * /api/user-settings/<me>/notification-preferences → { sound: {...} }.
 *
 * Quiet rules: nothing on page load (first report only sets the baseline);
 * muted while the status is "Do not disturb" (if muteInDnd); one alert per
 * event across several open tabs; at most one sound per kind every 2 s.
 */
(function () {
  'use strict';
  if (window.__hrmsAlerts) return;

  var DEFAULTS = { notificationSound: true, messageSound: true, notificationTone: 'chime', messageTone: 'pop',
                   volume: 70, inAppPopups: true, desktopPopups: false, muteInDnd: true };
  // Five sounds for each kind (keep in step with api/notification_prefs.py).
  var TONES = {
    notify: [['chime', 'Chime'], ['bell', 'Bell'], ['marimba', 'Marimba'], ['glass', 'Glass'], ['alert', 'Alert']],
    message: [['pop', 'Pop'], ['blip', 'Blip'], ['bubble', 'Bubble'], ['drop', 'Drop'], ['click', 'Click']]
  };
  var S = {
    settings: Object.assign({}, DEFAULTS),
    seenNotif: null,          // Set of notification ids already known
    chatTotal: null,          // last known chat unread total
    chatRoseAt: 0,
    popSeen: {},              // roomId -> last_time already popped
    roomSnap: null,           // roomId -> unread at the last pop-up check
    lastPlay: {},             // kind -> ms
    ctx: null
  };

  function session() { try { return JSON.parse(localStorage.getItem('hrms_session') || 'null'); } catch (_) { return null; } }
  function me() { var s = session(); return s && s.email ? String(s.email).trim().toLowerCase() : ''; }

  // ── audio ──────────────────────────────────────────────────────────────
  function audio() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { S.ctx = new AC(); } catch (_) { return null; }
    }
    if (S.ctx.state === 'suspended') { try { S.ctx.resume(); } catch (_) {} }
    return S.ctx;
  }
  function unlock() { audio(); }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  function tone(ac, freq, start, dur, peak, type, freqEnd) {
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  var SOUNDS = {
    // ── notification sounds ──
    chime: function (ac, v, t) {            // soft two-note chime (E5 → B5)
      tone(ac, 659.25, t, 0.32, 0.30 * v, 'sine');
      tone(ac, 987.77, t + 0.14, 0.42, 0.26 * v, 'sine');
    },
    bell: function (ac, v, t) {             // single bell strike with overtones
      tone(ac, 880, t, 0.9, 0.28 * v, 'sine');
      tone(ac, 1760, t, 0.5, 0.10 * v, 'sine');
      tone(ac, 2640, t, 0.3, 0.05 * v, 'sine');
    },
    marimba: function (ac, v, t) {          // three quick wooden notes (C5 E5 G5)
      tone(ac, 523.25, t, 0.18, 0.32 * v, 'triangle');
      tone(ac, 659.25, t + 0.11, 0.18, 0.30 * v, 'triangle');
      tone(ac, 783.99, t + 0.22, 0.26, 0.30 * v, 'triangle');
    },
    glass: function (ac, v, t) {            // bright, ringing glass tap
      tone(ac, 1567.98, t, 0.7, 0.20 * v, 'sine');
      tone(ac, 2093.0, t + 0.05, 0.6, 0.14 * v, 'sine');
    },
    alert: function (ac, v, t) {            // two urgent beeps
      tone(ac, 988, t, 0.12, 0.22 * v, 'square');
      tone(ac, 988, t + 0.18, 0.12, 0.22 * v, 'square');
    },
    // ── chat message sounds ──
    pop: function (ac, v, t) {              // short pop
      tone(ac, 520, t, 0.09, 0.35 * v, 'triangle', 880);
      tone(ac, 880, t + 0.07, 0.08, 0.18 * v, 'sine', 1040);
    },
    blip: function (ac, v, t) {             // single soft blip
      tone(ac, 1175, t, 0.12, 0.28 * v, 'sine');
    },
    bubble: function (ac, v, t) {           // rising bubble
      tone(ac, 300, t, 0.16, 0.34 * v, 'sine', 950);
    },
    drop: function (ac, v, t) {             // falling water drop
      tone(ac, 1400, t, 0.18, 0.30 * v, 'sine', 420);
    },
    click: function (ac, v, t) {            // two crisp ticks
      tone(ac, 2200, t, 0.03, 0.22 * v, 'square');
      tone(ac, 1800, t + 0.06, 0.03, 0.18 * v, 'square');
    }
  };

  /* kind: 'notify' | 'message'. tone: one of TONES[kind] (defaults to the
     user's choice). force: skip the 2 s burst limit (Test buttons). */
  function play(kind, force, toneName) {
    kind = kind === 'message' ? 'message' : 'notify';
    var chosen = toneName || (kind === 'message' ? S.settings.messageTone : S.settings.notificationTone);
    var fn = SOUNDS[chosen] || SOUNDS[kind === 'message' ? 'pop' : 'chime'];
    var now = Date.now();
    if (!force && now - (S.lastPlay[kind] || 0) < 2000) return false;   // burst limit
    var ac = audio();
    if (!ac) return false;
    S.lastPlay[kind] = now;
    var v = Math.max(0, Math.min(100, Number(S.settings.volume) || 0)) / 100;
    if (!v) return false;
    try { fn(ac, v, ac.currentTime + 0.01); } catch (_) { return false; }
    window.dispatchEvent(new CustomEvent('hrmsAlertPlayed', { detail: { kind: kind, tone: chosen } }));
    return true;
  }

  function muted() {
    if (!S.settings.muteInDnd) return false;
    try { return !!(window.__hrmsStatusAPI && window.__hrmsStatusAPI.get() === 'dnd'); } catch (_) { return false; }
  }
  function backgrounded() { return document.visibilityState !== 'visible' || !document.hasFocus(); }

  // ── one alert per event across tabs ────────────────────────────────────
  var CLAIM_PREFIX = 'hrms_alert_';
  function claim(key) {
    try {
      var k = CLAIM_PREFIX + key, now = Date.now();
      var prev = Number(localStorage.getItem(k) || 0);
      if (now - prev < 20000) return false;
      localStorage.setItem(k, String(now));
      return true;
    } catch (_) { return true; }
  }
  function pruneClaims() {
    try {
      var now = Date.now();
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CLAIM_PREFIX) === 0 && now - Number(localStorage.getItem(k) || 0) > 120000) localStorage.removeItem(k);
      }
    } catch (_) {}
  }

  // ── desktop pop-ups ────────────────────────────────────────────────────
  function canPopup() {
    return !!(S.settings.desktopPopups && 'Notification' in window && Notification.permission === 'granted');
  }
  function go(url) {
    if (!url) return;
    if (/^\/employees\/chat(\?|$)/.test(url)) {
      if ((location.pathname || '').replace(/\/+$/, '') === '/employees/chat') { location.assign(url); return; }
      history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    if (window.__hrmsOpenNotificationLink) { window.__hrmsOpenNotificationLink(url); return; }
    location.assign(url);
  }
  function popup(title, body, url, tag) {
    if (!canPopup()) return;
    try {
      var n = new Notification(title, { body: body || '', tag: tag || undefined, renotify: !!tag, silent: true });
      n.onclick = function () { try { window.focus(); } catch (_) {} go(url); n.close(); };
      setTimeout(function () { try { n.close(); } catch (_) {} }, 15000);
      window.dispatchEvent(new CustomEvent('hrmsAlertPopup', { detail: { title: title, body: body, url: url } }));
    } catch (_) {}
  }

  // ── pop-up cards inside HRMS (while you are using it) ──────────────────
  var TOAST_ID = 'hrms-alert-toasts';
  var TOAST_ICON = {
    notify: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    message: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H8l-4 4z"/></svg>'
  };
  function toastBox() {
    var box = document.getElementById(TOAST_ID);
    if (box) return box;
    if (!document.getElementById(TOAST_ID + '-style')) {
      var st = document.createElement('style');
      st.id = TOAST_ID + '-style';
      st.textContent =
        '#' + TOAST_ID + '{position:fixed;top:64px;right:16px;z-index:100050;display:flex;flex-direction:column;gap:8px;width:340px;max-width:calc(100vw - 32px);pointer-events:none;}' +
        '#' + TOAST_ID + ' .hat{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;padding:11px 12px;border-radius:12px;cursor:pointer;' +
        'background:var(--bg2,var(--surface,#fff));color:var(--text,#0f172a);border:1px solid var(--border2,#e5e7eb);box-shadow:0 10px 30px rgba(0,0,0,.22);' +
        'font-family:inherit;animation:hatIn .22s ease;}' +
        '#' + TOAST_ID + ' .hat:hover{border-color:var(--accent,#2f6fe0);}' +
        '#' + TOAST_ID + ' .hat .ic{width:32px;height:32px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;' +
        'background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#7c5cfc));}' +
        '#' + TOAST_ID + ' .hat.message .ic{background:linear-gradient(135deg,#10b981,#0ea5e9);}' +
        '#' + TOAST_ID + ' .hat .tx{flex:1;min-width:0;}' +
        '#' + TOAST_ID + ' .hat b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#' + TOAST_ID + ' .hat span{display:block;font-size:12.5px;color:var(--text3,#64748b);margin-top:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}' +
        '#' + TOAST_ID + ' .hat .x{border:none;background:transparent;color:var(--text3,#64748b);font-size:16px;line-height:1;cursor:pointer;padding:0 2px;}' +
        '@keyframes hatIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}';
      document.head.appendChild(st);
    }
    box = document.createElement('div');
    box.id = TOAST_ID;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
    return box;
  }
  function escT(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(kind, title, body, url) {
    var box = toastBox();
    while (box.children.length >= 3) box.removeChild(box.firstChild);   // ours only
    var el = document.createElement('div');
    el.className = 'hat ' + (kind === 'message' ? 'message' : 'notify');
    el.innerHTML = '<span class="ic">' + TOAST_ICON[kind === 'message' ? 'message' : 'notify'] + '</span>' +
      '<div class="tx"><b>' + escT(title) + '</b><span>' + escT(body || '') + '</span></div>' +
      '<button type="button" class="x" aria-label="Dismiss">×</button>';
    var timer = null;
    function close() { if (el.parentNode) el.parentNode.removeChild(el); }
    function arm() { timer = setTimeout(close, 7000); }
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    el.addEventListener('mouseleave', arm);
    el.addEventListener('click', function (e) {
      close();
      if (e.target.closest && e.target.closest('.x')) return;
      go(url);
    });
    box.appendChild(el);
    arm();
    window.dispatchEvent(new CustomEvent('hrmsAlertToast', { detail: { kind: kind, title: title, body: body, url: url } }));
  }
  /* Where an alert goes: a desktop pop-up while HRMS is in the background (if
     allowed), a pop-up card inside HRMS while you are using it. */
  function show(kind, title, body, url, tag) {
    if (backgrounded()) { popup(title, body, url, tag); return; }
    if (S.settings.inAppPopups !== false) toast(kind, title, body, url);
  }
  function wantsPopups() { return backgrounded() ? canPopup() : S.settings.inAppPopups !== false; }

  /* Test from the settings: always shows the card; also the desktop pop-up
     when the browser allows it. Returns what happened, for the UI to explain. */
  function testPopup() {
    toast('notify', 'Test pop-up', 'This is how new notifications and messages appear inside HRMS.', '');
    var st = 'Notification' in window ? Notification.permission : 'unsupported';
    if (st !== 'granted') return { inApp: true, desktop: st };
    try {
      var n = new Notification('HRMS test pop-up', { body: 'Desktop pop-ups are working.', silent: true });
      n.onclick = function () { try { window.focus(); } catch (_) {} n.close(); };
      setTimeout(function () { try { n.close(); } catch (_) {} }, 8000);
      return { inApp: true, desktop: 'shown' };
    } catch (_) {
      return { inApp: true, desktop: 'error' };
    }
  }

  // ── notifications ──────────────────────────────────────────────────────
  function notify(items) {
    if (!Array.isArray(items)) return;
    var ids = items.map(function (i) { return i && i.id; }).filter(function (x) { return x != null; });
    if (S.seenNotif === null) { S.seenNotif = new Set(ids); return; }   // baseline: no sound on load
    var fresh = items.filter(function (i) { return i && i.id != null && !S.seenNotif.has(i.id); });
    ids.forEach(function (id) { S.seenNotif.add(id); });
    if (!fresh.length || muted()) return;
    if (!claim('n:' + fresh.map(function (i) { return i.id; }).sort().join(','))) return;
    if (S.settings.notificationSound) play('notify');
    fresh.slice(0, 3).forEach(function (i) {
      show('notify', i.title || 'HRMS notification', i.message || '', i.link || '', 'hrms-n-' + i.id);
    });
  }

  // ── chat ───────────────────────────────────────────────────────────────
  function chatUnread(total) {
    total = Math.max(0, Number(total) || 0);
    if (S.chatTotal === null) { S.chatTotal = total; return; }        // baseline
    if (total > S.chatTotal) {
      var prev = S.chatTotal;
      S.chatTotal = total;
      S.chatRoseAt = Date.now();
      onNewChat(prev, total);
    } else if (total < S.chatTotal) {
      // Sources refresh at different moments; ignore a dip right after a rise
      // so the same message is not "new" twice when they disagree briefly.
      if (Date.now() - S.chatRoseAt > 4000) {
        S.chatTotal = total;
        S.roomSnap = null;   // something was read: per-room counts are stale
      }
    }
  }

  // Several tabs see the same rise: the first to announce a total wins; others
  // stay quiet unless their total is higher (a newer message) or it is stale.
  function claimChat(total) {
    try {
      var k = CLAIM_PREFIX + 'chat', now = Date.now();
      var prev = JSON.parse(localStorage.getItem(k) || 'null');
      if (prev && now - prev.at < 6000 && total <= prev.total) return false;
      localStorage.setItem(k, JSON.stringify({ at: now, total: total }));
      return true;
    } catch (_) { return true; }
  }

  function onNewChat(prev, total) {
    if (muted()) return;
    if (!claimChat(total)) return;
    if (S.settings.messageSound) play('message');
    if (wantsPopups()) popupForRooms();
  }

  function popupForRooms() {
    var email = me();
    if (!email) return;
    fetch('/api/chat/rooms?email=' + encodeURIComponent(email), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rooms) {
        rooms = rooms || [];
        // Only conversations whose unread count went up since the last look —
        // never older unread chats. Without a reference yet, just the newest.
        var snap = S.roomSnap;
        var fresh = rooms.filter(function (r) {
          return r.unread > 0 && r.last_sender && r.last_sender !== email && S.popSeen[r.id] !== r.last_time &&
                 (!snap || (r.unread || 0) > (snap[r.id] || 0));
        }).sort(function (a, b) { return String(b.last_time).localeCompare(String(a.last_time)); });
        if (!snap) fresh = fresh.slice(0, 1);
        S.roomSnap = {};
        rooms.forEach(function (r) { S.roomSnap[r.id] = r.unread || 0; });
        fresh.slice(0, 3).forEach(function (r) {
            S.popSeen[r.id] = r.last_time;
            var sender = senderName(r);
            var title = r.is_group ? sender + ' in #' + (r.name || 'channel') : (r.display_name || sender);
            show('message', title, (r.last_message || 'New message') + (r.unread > 1 ? '  (' + r.unread + ' unread)' : ''),
                 '/employees/chat?room=' + r.id, 'hrms-c-' + r.id);
          });
      })
      .catch(function () {});
  }
  function senderName(r) {
    var m = (r.members || []).filter(function (x) { return x.email === r.last_sender; })[0];
    return (m && m.name) || String(r.last_sender || '').split('@')[0];
  }

  function chatMessage(m, room) {
    if (!m || m.id == null) return;
    if (String(m.sender_email || '').toLowerCase() === me()) return;
    if (!backgrounded() || muted()) return;                 // watching it: no alert
    if (!claim('m:' + m.id)) return;
    if (S.settings.messageSound) play('message');
    var name = m.sender_name || String(m.sender_email || '').split('@')[0];
    var isCh = room && room.is_group;
    popup(isCh ? name + ' in #' + (room.name || 'channel') : name,
          m.message || (m.attachment_name ? '📎 ' + m.attachment_name : 'New message'),
          room ? '/employees/chat?room=' + room.id : '/employees/chat', room ? 'hrms-c-' + room.id : undefined);
  }

  // ── own polling ────────────────────────────────────────────────────────
  function netFetch(key, url) {
    var N = window.HRMSNet;
    if (N) {
      if (!N.ready(key, { background: false })) return null;
      return N.fetch(key, url, { headers: { Accept: 'application/json' } });
    }
    return fetch(url, { headers: { Accept: 'application/json' } });
  }
  function pollChat() {
    if (!me()) return;
    var req = netFetch('alerts-chat', '/api/chat/unread');
    if (!req) return;
    req.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.total === 'number') chatUnread(d.total); })
      .catch(function () {});
  }
  function pollNotificationsWhileHidden() {
    if (!me() || !document.hidden) return;   // visible: the bell's own poll reports
    var req = netFetch('alerts-notif', '/api/notifications?unreadOnly=true');
    if (!req) return;
    req.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (items) { if (Array.isArray(items)) notify(items); })
      .catch(function () {});
  }

  // ── settings ───────────────────────────────────────────────────────────
  function prefsUrl() { return '/api/user-settings/' + encodeURIComponent(me()) + '/notification-preferences'; }
  function applySettings(snd) {
    if (snd && typeof snd === 'object') S.settings = Object.assign({}, DEFAULTS, snd);
    syncDrawer();
  }
  function loadSettings() {
    if (!me()) return;
    fetch(prefsUrl(), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.sound) applySettings(d.sound); })
      .catch(function () {});
  }
  function saveSettings(patch) {
    return fetch(prefsUrl(), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sound: patch })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.message) || ('HTTP ' + r.status));
        applySettings(d.sound);
        window.dispatchEvent(new CustomEvent('hrmsAlertSettings', { detail: S.settings }));
        return S.settings;
      });
    });
  }
  window.addEventListener('hrmsAlertSettings', function (e) { if (e && e.detail) applySettings(e.detail); });

  window.__hrmsAlerts = {
    notify: notify,
    chatUnread: chatUnread,
    chatMessage: chatMessage,
    test: function (kind, toneName) { return play(kind === 'message' ? 'message' : 'notify', true, toneName); },
    testPopup: testPopup,
    tones: function () { return JSON.parse(JSON.stringify(TONES)); },
    settings: function () { return Object.assign({}, S.settings); },
    saveSettings: saveSettings,
    reloadSettings: loadSettings,
    popupSupported: function () { return 'Notification' in window; },
    popupPermission: function () { return 'Notification' in window ? Notification.permission : 'unsupported'; }
  };

  // ── "Sounds & alerts" in the right-hand profile drawer ─────────────────
  // Every sound setting, managed in place (same server-side settings as
  // Settings › Notifications; the two stay in step via 'hrmsAlertSettings').
  // The drawer is React's: we only add our own section after its Status
  // block and never move or remove React nodes.
  var DRAWER_SEC = 'hsa-drawer';
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function drawerStyle() {
    if (document.getElementById(DRAWER_SEC + '-style')) return;
    var st = document.createElement('style');
    st.id = DRAWER_SEC + '-style';
    var R = '.' + DRAWER_SEC;
    st.textContent =
      R + ' .hsa-row{display:flex;align-items:center;gap:8px;padding:7px 2px;}' +
      R + ' .hsa-l{flex:1;min-width:0;}' +
      R + ' .hsa-t{font-size:13px;font-weight:500;color:var(--text,#0f172a);}' +
      R + ' .hsa-s{font-size:11px;color:var(--text3,#64748b);line-height:1.35;}' +
      R + ' .hsa-test{border:1px solid var(--border2,#e5e7eb);background:transparent;color:var(--text3,#64748b);border-radius:6px;font-size:11px;padding:3px 7px;cursor:pointer;font-family:inherit;}' +
      R + ' .hsa-test:hover{color:var(--text,#0f172a);border-color:var(--accent,#2f6fe0);}' +
      R + ' .hsa-tg{width:34px;height:20px;border-radius:10px;border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#e5e7eb);position:relative;cursor:pointer;flex-shrink:0;padding:0;transition:background .2s;}' +
      R + ' .hsa-tg::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 2px rgba(0,0,0,.25);}' +
      R + ' .hsa-tg[aria-checked="true"]{background:var(--accent,#2f6fe0);border-color:var(--accent,#2f6fe0);}' +
      R + ' .hsa-tg[aria-checked="true"]::after{left:16px;}' +
      R + ' .hsa-tg:disabled{opacity:.6;cursor:wait;}' +
      R + ' .hsa-tg:focus-visible,' + R + ' .hsa-test:focus-visible{outline:2px solid var(--accent,#2f6fe0);outline-offset:2px;}' +
      R + ' input[type=range]{width:110px;accent-color:var(--accent,#2f6fe0);}' +
      R + ' .hsa-vol{font-size:11px;color:var(--text3,#64748b);min-width:32px;text-align:right;}' +
      R + ' .hsa-msg{font-size:11px;min-height:14px;margin-top:2px;}' +
      R + ' .hsa-msg.err{color:var(--red,#ef4444);}' + R + ' .hsa-msg.ok{color:var(--green,#22c55e);}' +
      R + ' .hsa-more{display:inline-block;margin-top:4px;font-size:12px;color:var(--accent,#2f6fe0);cursor:pointer;background:none;border:none;padding:0;font-family:inherit;}' +
      R + ' select.hsa-sel{border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f8fafc);color:var(--text,#0f172a);border-radius:6px;font:12px inherit;font-family:inherit;padding:3px 6px;max-width:96px;}' +
      R + ' .hsa-btn{border:1px solid var(--border2,#e5e7eb);background:transparent;color:var(--text,#0f172a);border-radius:7px;font-size:12px;padding:5px 10px;cursor:pointer;font-family:inherit;}' +
      R + ' .hsa-btn:hover{border-color:var(--accent,#2f6fe0);color:var(--accent,#2f6fe0);}' +
      // collapsible header
      R + ' .hsa-head{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;padding:0;cursor:pointer;text-align:left;font-family:inherit;color:inherit;}' +
      R + ' .hsa-head .hrms-drawer-section-lbl{margin:0;flex-shrink:0;}' +
      R + ' .hsa-sum{flex:1;min-width:0;font-size:11px;color:var(--text3,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;}' +
      R + ' .hsa-chev{font-size:12px;color:var(--text3,#64748b);width:14px;text-align:center;}' +
      R + ' .hsa-head:hover .hsa-chev,' + R + ' .hsa-head:hover .hrms-drawer-section-lbl{color:var(--accent,#2f6fe0);}' +
      R + ' .hsa-head:focus-visible{outline:2px solid var(--accent,#2f6fe0);outline-offset:3px;border-radius:4px;}' +
      R + ' .hsa-body{margin-top:8px;}' +
      // Drawer order — profile, Status (always on top), Settings, Sounds &
      // alerts, Employees. Done with CSS 'order' on a flex column: React's
      // nodes are tagged, never moved.
      '.hrms-drawer.hsa-ordered{display:flex;flex-direction:column;}' +
      '.hrms-drawer.hsa-ordered>*{flex-shrink:0;}' +
      '.hrms-drawer.hsa-ordered>.hrms-drawer-head{order:1;}' +
      '.hrms-drawer.hsa-ordered>[data-hsa-slot="status"]{order:2;}' +
      '.hrms-drawer.hsa-ordered>[data-hsa-slot="settings"]{order:3;}' +
      '.hrms-drawer.hsa-ordered>.' + DRAWER_SEC + '{order:4;}' +
      '.hrms-drawer.hsa-ordered>[data-hsa-slot="other"]{order:5;}';
    document.head.appendChild(st);
  }
  function popupNote(on) {
    var st = 'Notification' in window ? Notification.permission : 'unsupported';
    if (st === 'unsupported') return 'Not supported by this browser';
    if (st === 'denied') return 'Blocked — allow notifications for this site in the browser';
    return on && st === 'granted' ? 'On when HRMS is in the background' : 'Corner pop-ups when HRMS is in the background';
  }
  function drawerRow(key, label, sub, on, test) {
    return '<div class="hsa-row"><div class="hsa-l"><div class="hsa-t">' + esc(label) + '</div>' +
      '<div class="hsa-s" data-hsa-sub="' + key + '">' + esc(sub) + '</div></div>' +
      (test ? '<button type="button" class="hsa-test" data-hsa-test="' + test + '" aria-label="Play ' + esc(label) + '">▶</button>' : '') +
      '<button type="button" class="hsa-tg" role="switch" aria-label="' + esc(label) + '" aria-checked="' + (on ? 'true' : 'false') + '" data-hsa="' + key + '"></button></div>';
  }
  function toneSelect(kind, key, current) {
    return '<select class="hsa-sel" data-hsa-tone="' + key + '" data-kind="' + kind + '" aria-label="' + (kind === 'message' ? 'Message' : 'Notification') + ' sound">' +
      TONES[kind].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === current ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
      '</select>';
  }
  // Open/closed state of the drawer section — a per-browser convenience.
  var OPEN_KEY = 'hrms_hsa_open';
  function drawerOpen() { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch (_) { return false; } }
  function setDrawerOpen(on) { try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch (_) {} }
  function toneLabel(kind, key) {
    var t = TONES[kind].filter(function (o) { return o[0] === key; })[0];
    return t ? t[1] : '';
  }
  /* One-line summary shown on the collapsed header. */
  function drawerSummary() {
    var s = S.settings;
    if (s.notificationSound === false && s.messageSound === false) return 'Sounds off';
    var parts = [];
    parts.push(s.notificationSound === false ? 'No chime' : toneLabel('notify', s.notificationTone));
    parts.push(s.messageSound === false ? 'No message sound' : toneLabel('message', s.messageTone));
    parts.push((Number(s.volume) || 0) + '%');
    return parts.join(' · ');
  }
  function drawerHtml() {
    var s = S.settings;
    var popOn = !!s.desktopPopups && ('Notification' in window) && Notification.permission === 'granted';
    var open = drawerOpen();
    return '<button type="button" class="hsa-head" data-hsa-toggle aria-expanded="' + open + '" aria-controls="hsa-body">' +
      '<span class="hrms-drawer-section-lbl">Sounds &amp; alerts</span>' +
      '<span class="hsa-sum" data-hsa-sum>' + esc(drawerSummary()) + '</span>' +
      '<span class="hsa-chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span></button>' +
      '<div class="hsa-body" id="hsa-body"' + (open ? '' : ' hidden') + '>' +
      drawerRow('notificationSound', 'Notification sound', 'Choose from 5 sounds', s.notificationSound !== false, 'notify')
        .replace('<button type="button" class="hsa-test"', toneSelect('notify', 'notificationTone', s.notificationTone) + '<button type="button" class="hsa-test"') +
      drawerRow('messageSound', 'Message sound', 'Choose from 5 sounds', s.messageSound !== false, 'message')
        .replace('<button type="button" class="hsa-test"', toneSelect('message', 'messageTone', s.messageTone) + '<button type="button" class="hsa-test"') +
      drawerRow('inAppPopups', 'Pop-ups in HRMS', 'Cards in the corner while you use HRMS', s.inAppPopups !== false, '') +
      '<div class="hsa-row"><div class="hsa-l"><div class="hsa-t">Volume</div></div>' +
      '<input type="range" min="0" max="100" step="5" value="' + (Number(s.volume) || 0) + '" data-hsa-vol aria-label="Alert volume">' +
      '<span class="hsa-vol" data-hsa-volv>' + (Number(s.volume) || 0) + '%</span></div>' +
      drawerRow('desktopPopups', 'Desktop pop-ups', popupNote(popOn), popOn, '') +
      drawerRow('muteInDnd', 'Silent in Do not disturb', 'No sounds or pop-ups while DND', s.muteInDnd !== false, '') +
      '<div class="hsa-row"><button type="button" class="hsa-btn" data-hsa-testpop>Test pop-up</button></div>' +
      '<div class="hsa-msg" data-hsa-msg aria-live="polite"></div>' +
      '<button type="button" class="hsa-more" data-hsa-more>More notification settings →</button></div>';
  }
  /* Explain the result of a pop-up test (shared by the drawer and Settings). */
  function popupTestText(res) {
    if (res.desktop === 'shown') return 'Shown inside HRMS and as a desktop pop-up. If no desktop pop-up appeared, turn on notifications for your browser in Windows Settings › System › Notifications (and switch off Focus assist / Do not disturb).';
    if (res.desktop === 'denied') return 'Shown inside HRMS. Desktop pop-ups are blocked for this site: click the lock icon in the address bar › Notifications › Allow.';
    if (res.desktop === 'default') return 'Shown inside HRMS. Turn on "Desktop pop-ups" to also get them when HRMS is in the background.';
    if (res.desktop === 'unsupported') return 'Shown inside HRMS. This browser cannot show desktop pop-ups (they need https, or localhost).';
    return 'Shown inside HRMS. The browser refused the desktop pop-up.';
  }
  function drawerSay(sec, text, kind) {
    var m = sec.querySelector('[data-hsa-msg]');
    if (!m) return;
    m.className = 'hsa-msg ' + (kind || '');
    m.textContent = text;
    if (kind === 'ok') setTimeout(function () { if (m.textContent === text) m.textContent = ''; }, 1600);
  }
  function wireDrawer(sec) {
    sec.addEventListener('click', function (e) {
      var t = e.target;
      var head = t.closest && t.closest('[data-hsa-toggle]');
      if (head) {
        e.stopPropagation();
        var body = sec.querySelector('.hsa-body');
        var open = body.hasAttribute('hidden');
        if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
        head.setAttribute('aria-expanded', String(open));
        head.querySelector('.hsa-chev').textContent = open ? '▾' : '▸';
        setDrawerOpen(open);
        return;
      }
      var test = t.closest && t.closest('[data-hsa-test]');
      if (test) {
        e.stopPropagation();
        var kind = test.getAttribute('data-hsa-test') === 'message' ? 'message' : 'notify';
        var sel = sec.querySelector('[data-hsa-tone][data-kind="' + kind + '"]');
        if (!play(kind, true, sel && sel.value)) drawerSay(sec, 'Sound blocked by the browser, or volume is 0.', 'err');
        return;
      }
      if (t.closest && t.closest('[data-hsa-testpop]')) {
        e.stopPropagation();
        drawerSay(sec, popupTestText(testPopup()), '');
        return;
      }
      if (t.closest && t.closest('[data-hsa-more]')) {
        e.stopPropagation();
        var item = Array.prototype.filter.call(document.querySelectorAll('.hrms-drawer-litem'), function (x) { return x.textContent.trim() === 'Notifications'; })[0];
        if (item) item.click();
        return;
      }
      var sw = t.closest && t.closest('.hsa-tg[data-hsa]');
      if (!sw) return;
      e.stopPropagation();
      var key = sw.getAttribute('data-hsa');
      var next = sw.getAttribute('aria-checked') !== 'true';
      var ask = Promise.resolve('granted');
      if (key === 'desktopPopups' && next) {
        if (!('Notification' in window)) { drawerSay(sec, 'This browser cannot show desktop pop-ups.', 'err'); return; }
        ask = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
      }
      sw.disabled = true;
      ask.then(function (perm) {
        if (key === 'desktopPopups' && next && perm !== 'granted') {
          var sub = sec.querySelector('[data-hsa-sub="desktopPopups"]');
          if (sub) sub.textContent = popupNote(false);
          throw new Error('Pop-ups are blocked for this site in the browser.');
        }
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        var patch = {}; patch[key] = next;
        return saveSettings(patch).then(function () { drawerSay(sec, 'Saved.', 'ok'); });
      }).catch(function (err) {
        sw.setAttribute('aria-checked', next ? 'false' : 'true');
        drawerSay(sec, err.message, 'err');
      }).then(function () { sw.disabled = false; });
    });
    sec.querySelectorAll('[data-hsa-tone]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var kind = sel.getAttribute('data-kind');
        play(kind, true, sel.value);                               // hear it right away
        var patch = {}; patch[sel.getAttribute('data-hsa-tone')] = sel.value;
        saveSettings(patch).then(function () { drawerSay(sec, 'Saved.', 'ok'); })
          .catch(function (err) { drawerSay(sec, 'Not saved: ' + err.message, 'err'); });
      });
    });
    var vol = sec.querySelector('[data-hsa-vol]'), volv = sec.querySelector('[data-hsa-volv]');
    vol.addEventListener('input', function () { volv.textContent = vol.value + '%'; });
    vol.addEventListener('change', function () {
      saveSettings({ volume: Number(vol.value) }).then(function () { drawerSay(sec, 'Saved.', 'ok'); play('notify', true); })
        .catch(function (err) { drawerSay(sec, 'Not saved: ' + err.message, 'err'); });
    });
  }
  function syncDrawer() {
    var sec = document.querySelector('.' + DRAWER_SEC);
    if (!sec) return;
    var s = S.settings;
    var popOn = !!s.desktopPopups && ('Notification' in window) && Notification.permission === 'granted';
    var want = { notificationSound: s.notificationSound !== false, messageSound: s.messageSound !== false,
                 inAppPopups: s.inAppPopups !== false, desktopPopups: popOn, muteInDnd: s.muteInDnd !== false };
    Object.keys(want).forEach(function (k) {
      var b = sec.querySelector('[data-hsa="' + k + '"]');
      if (b && !b.disabled && b.getAttribute('aria-checked') !== String(want[k])) b.setAttribute('aria-checked', String(want[k]));
    });
    ['notificationTone', 'messageTone'].forEach(function (k) {
      var sel = sec.querySelector('[data-hsa-tone="' + k + '"]');
      if (sel && document.activeElement !== sel && s[k] && sel.value !== s[k]) sel.value = s[k];
    });
    var sub = sec.querySelector('[data-hsa-sub="desktopPopups"]');
    if (sub && sub.textContent !== popupNote(popOn)) sub.textContent = popupNote(popOn);
    var sum = sec.querySelector('[data-hsa-sum]');
    if (sum && sum.textContent !== drawerSummary()) sum.textContent = drawerSummary();
    var vol = sec.querySelector('[data-hsa-vol]');
    if (vol && document.activeElement !== vol && Number(vol.value) !== Number(s.volume)) {
      vol.value = s.volume;
      sec.querySelector('[data-hsa-volv]').textContent = s.volume + '%';
    }
  }
  /* Tag React's sections so CSS can order them (attributes only — React never
     set these, so it leaves them alone; re-applied if it re-creates a node). */
  function tagDrawer(drawer) {
    Array.prototype.forEach.call(drawer.children, function (el) {
      if (!el.classList.contains('hrms-drawer-sec') || el.classList.contains(DRAWER_SEC)) return;
      var l = el.querySelector('.hrms-drawer-section-lbl');
      var name = l ? l.textContent.trim().toLowerCase() : '';
      var slot = name === 'settings' ? 'settings' : (name === 'status' ? 'status' : 'other');
      if (el.getAttribute('data-hsa-slot') !== slot) el.setAttribute('data-hsa-slot', slot);
    });
    if (!drawer.classList.contains('hsa-ordered')) drawer.classList.add('hsa-ordered');
  }
  function ensureDrawer() {
    var drawer = document.querySelector('.hrms-drawer');
    if (!drawer || !me()) return;
    if (drawer.querySelector('.' + DRAWER_SEC)) { tagDrawer(drawer); return; }
    drawerStyle();
    var sec = document.createElement('div');
    sec.className = 'hrms-drawer-sec ' + DRAWER_SEC;
    sec.innerHTML = drawerHtml();
    wireDrawer(sec);
    // After the Status block if we can find it; otherwise at the end.
    var status = Array.prototype.filter.call(drawer.querySelectorAll('.hrms-drawer-sec'), function (x) {
      var l = x.querySelector('.hrms-drawer-section-lbl');
      return l && /^status$/i.test(l.textContent.trim());
    })[0];
    if (status && status.parentNode) status.parentNode.insertBefore(sec, status.nextSibling);
    else drawer.appendChild(sec);
    tagDrawer(drawer);
  }
  window.addEventListener('hrmsAlertSettings', function () { setTimeout(syncDrawer, 0); });

  function boot() {
    var dq = false;
    new MutationObserver(function () {
      if (dq) return;
      dq = true;
      setTimeout(function () { dq = false; ensureDrawer(); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
    pruneClaims();
    loadSettings();
    setTimeout(pollChat, 1500);
    setInterval(pollChat, 10000);
    setInterval(pollNotificationsWhileHidden, 30000);
    setInterval(loadSettings, 600000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pollChat(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
