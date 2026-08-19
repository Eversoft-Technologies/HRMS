/**
 * hrms-status.js  v1
 * Adds a presence / STATUS picker to the Settings -> My Profile page,
 * styled after the Zoho-Cliq status selector:
 *   Available · Away · Busy · Invisible · Do not disturb
 *
 * Presence is tied to Check-In (hrms-checkin.js):
 *   - checked out  -> status is forced to "Offline" and the picker is disabled
 *   - on check-in  -> status defaults to "Available"
 *
 * The chosen status is persisted in localStorage and shown as a colored dot
 * on the topbar avatar so it is visible across the whole app.
 *
 * Same no-rebuild injection pattern as hrms-checkin.js / hrms-live.js.
 */
(function () {
  'use strict';

  /* ── storage keys ────────────────────────────────────────────────────── */
  var STORAGE_STATUS  = 'hrms_presence_status';   // available|away|busy|invisible|dnd
  var STORAGE_CHECKIN = 'hrms_checked_in';        // shared with hrms-checkin.js
  var BLOCK_ID        = 'hrms-ps-block';

  /* ── status catalogue ────────────────────────────────────────────────── */
  var STATUSES = [
    { key: 'available', label: 'Available',      color: '#22c55e' },
    { key: 'away',      label: 'Away',           color: '#f59e0b', arrow: true },
    { key: 'busy',      label: 'Busy',           color: '#ef4444' },
    { key: 'invisible', label: 'Invisible',      color: '#9ca3af' },
    { key: 'dnd',       label: 'Do not disturb', color: '#ef4444', bell: true }
  ];
  var CUSTOM = [
    { key: 'travelling', label: 'Travelling',   color: '#06b6d4', custom: true },
    { key: 'meeting',    label: 'In a Meeting', color: '#8b5cf6', custom: true },
    { key: 'coffee',     label: 'Coffee break', color: '#b45309', custom: true }
  ];
  var OFFLINE = { key: 'offline', label: 'Offline', color: '#9ca3af',
                  desc: 'Check in to set your status.' };

  /* panel open/closed is module-level so it survives re-renders */
  var panelOpen = false;

  /* ── backend presence sync (drives the Team Status Now panel) ─────────── */
  function actorEmail() {
    try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email) || ''; }
    catch (_) { return ''; }
  }
  function actorName() {
    try {
      var s = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return (s && (s.name || s.fullName)) || '';
    } catch (_) { return ''; }
  }

  /* Persist the chosen presence to the attendance API so every other employee
     sees it in "Team Status Now". Only meaningful while checked in (the API
     rejects presence changes otherwise). Fires 'hrmsAttendanceSynced' so an
     open Check-In page refreshes its team table immediately. */
  var lastPosted = null;
  function postPresence(key) {
    var em = actorEmail();
    if (!em) return;
    var st = findStatus(key);
    var label = (st && st.label) || 'Available';
    lastPosted = key;
    // Show it on my own avatar at once. The next poll replaces this with the
    // server's version, which is what everybody else is seeing.
    if (st) PRESENCE[String(em).trim().toLowerCase()] = { label: st.label, color: st.color };
    fetch('/api/attendance/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: em, employee: actorName(), key: key, label: label })
    })
      .then(function () {
        window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced', { detail: {} }));
      })
      .catch(function () {});
  }

  /* ── SVG icons ───────────────────────────────────────────────────────── */
  var CHEVRON =
    '<svg class="hrms-ps-chevron" viewBox="0 0 16 16" fill="none">' +
    '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5"' +
    ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var BELL =
    '<svg class="hrms-ps-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
    '<path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  var ARROW =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"' +
    ' stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';

  var CHECK =
    '<svg class="hrms-ps-check" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.4 3.4L13 5"/></svg>';

  function iconHtml(s) {
    if (s.bell)   return '<span class="hrms-ps-ic" style="color:' + s.color + '">' + BELL + '</span>';
    if (s.arrow)  return '<span class="hrms-ps-ic" style="color:' + s.color + '">' + ARROW + '</span>';
    return '<span class="hrms-ps-ic"><span class="hrms-ps-dot" style="background:' + s.color + '"></span></span>';
  }

  function optRow(s, curKey) {
    return '<button type="button" class="hrms-ps-option' + (s.key === curKey ? ' is-active' : '') +
           '" data-key="' + s.key + '">' + iconHtml(s) +
           '<span class="hrms-ps-opt-title">' + s.label + '</span>' +
           (s.key === curKey ? CHECK : '') + '</button>';
  }

  /* ── state helpers ───────────────────────────────────────────────────── */

  /* Am I checked in?
   *
   * This used to read localStorage[hrms_checked_in] === 'true'. hrms-checkin.js
   * stopped writing a bare 'true' some time ago — the cached hint is now
   * {email, date, checkedIn}, stamped so it cannot leak between users or days —
   * so the comparison was false for everybody, permanently. Every consequence
   * followed from that one line: the topbar dot was always grey, the status
   * picker was always disabled with "Check in to set your status", and no
   * presence was ever posted for the Team Status panel.
   *
   * The live value on the check-in module is the authority (it is synced from
   * the server); the cache is only a fallback for the moment before that module
   * has booted, and is read in the shape it is actually written. */
  function isCheckedIn() {
    var api = window.__hrmsCheckinAPI;
    if (api && typeof api.isCheckedIn === 'function') {
      try { return !!api.isCheckedIn(); } catch (_) {}
    }
    try {
      var raw = localStorage.getItem(STORAGE_CHECKIN);
      if (raw === 'true') return true;            // legacy shape, still honoured
      var c = JSON.parse(raw || 'null');
      if (!c || typeof c !== 'object') return false;
      if (c.email && c.email !== actorEmail()) return false;
      if (c.date && c.date !== todayStamp()) return false;
      return !!c.checkedIn;
    } catch (_) { return false; }
  }

  function todayStamp() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') +
           '-' + String(n.getDate()).padStart(2, '0');
  }

  function findStatus(key) {
    if (key === 'offline') return OFFLINE;
    var all = STATUSES.concat(CUSTOM);
    for (var i = 0; i < all.length; i++) {
      if (all[i].key === key) return all[i];
    }
    return null;
  }

  /* effective status: offline whenever checked out */
  function getStatusKey() {
    if (!isCheckedIn()) return 'offline';
    var k = localStorage.getItem(STORAGE_STATUS);
    return findStatus(k) && k !== 'offline' ? k : 'available';
  }

  function setStatus(key) {
    if (!isCheckedIn()) return;            // cannot change presence while offline
    if (!findStatus(key) || key === 'offline') return;
    localStorage.setItem(STORAGE_STATUS, key);
    panelOpen = false;
    render();
    paintAvatarDots();
    postPresence(key);            // reflect in Team Status Now (cross-user)
    window.dispatchEvent(new CustomEvent('hrmsStatusChange', { detail: { status: key } }));
    console.log('[hrms-status] status →', key);
  }

  /* ── find the "My Profile" card on the Settings page ─────────────────── */
  function findProfileCard() {
    var titles = document.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      if (titles[i].textContent.trim() === 'My Profile') {
        return titles[i].closest('.card') || titles[i].parentNode;
      }
    }
    return null;
  }

  /* ── render the picker contents into the block ───────────────────────── */
  function render() {
    var block = document.getElementById(BLOCK_ID);
    if (!block) return;

    var checked = isCheckedIn();
    var curKey  = getStatusKey();
    var cur     = findStatus(curKey);

    var panel =
      '<div class="hrms-ps-section">Default Status</div>' +
      STATUSES.map(function (s) { return optRow(s, curKey); }).join('') +
      '<div class="hrms-ps-section hrms-ps-section-sep">Custom Status</div>' +
      CUSTOM.map(function (s) { return optRow(s, curKey); }).join('');

    block.innerHTML =
      '<div class="hrms-ps-head"><span class="hrms-ps-title">STATUS</span></div>' +
      '<div class="hrms-ps-field">' +
        '<button type="button" class="hrms-ps-control' +
          (checked ? '' : ' is-disabled') + (panelOpen ? ' is-open' : '') + '"' +
          (checked ? '' : ' aria-disabled="true"') + '>' +
          iconHtml(cur) +
          '<span class="hrms-ps-current">' + cur.label + '</span>' +
          CHEVRON +
        '</button>' +
        '<div class="hrms-ps-panel"' + (panelOpen && checked ? '' : ' hidden') + '>' + panel + '</div>' +
      '</div>' +
      (checked ? '' : '<div class="hrms-ps-hint">' + OFFLINE.desc + '</div>');

    /* wire control */
    var ctrl = block.querySelector('.hrms-ps-control');
    ctrl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!isCheckedIn()) return;
      panelOpen = !panelOpen;
      render();
    });

    block.querySelectorAll('.hrms-ps-option').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setStatus(btn.getAttribute('data-key'));
      });
    });
  }

  /* ── inject the block (prefer the #hrms-ps-slot anchor) ──────────────── */
  function ensureBlock() {
    /* already injected? leave it (avoid re-render loops with the observer) */
    if (document.getElementById(BLOCK_ID)) return;

    /* 1. Preferred: the explicit slot rendered inside the My Profile card */
    var slot = document.getElementById('hrms-ps-slot');
    if (slot) {
      var b1 = document.createElement('div');
      b1.id = BLOCK_ID;
      b1.className = 'hrms-ps-block';
      slot.appendChild(b1);
      render();
      return;
    }

    /* 2. Fallback: insert after the My Profile card title */
    var card = findProfileCard();
    if (!card) return;

    var block = document.createElement('div');
    block.id        = BLOCK_ID;
    block.className = 'hrms-ps-block';

    var title = card.querySelector('.card-title');
    if (title && title.nextSibling)      card.insertBefore(block, title.nextSibling);
    else if (title)                      card.appendChild(block);
    else                                 card.insertBefore(block, card.firstChild);

    render();
  }

  /* ── team presence ────────────────────────────────────────────────────
   *
   * Everything above is about MY status. Chat rooms, message avatars and the
   * team panel show other people, and their presence only exists server-side —
   * /api/attendance/team already computes it for the Check In/Out page, so it
   * is reused here rather than inventing a second source that could disagree
   * with the one an employee is looking at.
   *
   * The snapshot is shared through window.__hrmsPresence so a sidecar only has
   * to tag an avatar with data-hrms-presence="<email>"; the observer below
   * paints and repaints it. That keeps every other module free of polling,
   * colour tables and refresh logic. */
  var PRESENCE = {};          // email -> { label, color }
  var presenceFetchedAt = 0;
  var presenceInFlight = false;
  var PRESENCE_TTL = 45000;

  /* The API answers with a label, not a key: In Office / Remote / In Break /
     Absent, or whatever presence the person picked (Busy, Travelling, …). */
  function colorForLabel(label) {
    var t = String(label || '').toLowerCase().replace(/[\s._-]+/g, '');
    if (/inoffice|available|online|active/.test(t)) return '#22c55e';
    if (/remote|wfh|home/.test(t)) return '#4f8ef7';
    if (/break|away|coffee/.test(t)) return '#f59e0b';
    if (/donotdisturb|dnd|busy/.test(t)) return '#ef4444';
    if (/meeting/.test(t)) return '#8b5cf6';
    if (/travel/.test(t)) return '#06b6d4';
    return '#9ca3af';         // absent, offline, invisible, or unknown
  }

  function refreshPresence(force) {
    var now = Date.now();
    if (presenceInFlight) return;
    if (!force && now - presenceFetchedAt < PRESENCE_TTL) return;
    presenceInFlight = true;
    fetch('/api/attendance/team')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var map = {};
        (Array.isArray(rows) ? rows : []).forEach(function (r) {
          var em = String(r.email || '').trim().toLowerCase();
          if (!em) return;
          map[em] = { label: r.status || 'Absent', color: colorForLabel(r.status), since: r.since || '' };
        });
        PRESENCE = map;
        presenceFetchedAt = Date.now();
        reconcileLocalStatus();
        paintTagged();
      })
      .catch(function () { /* offline: keep the last snapshot */ })
      .then(function () { presenceInFlight = false; });
  }

  /* What my own avatar shows.
   *
   * The server's view wins, because it is the one everyone else sees and it
   * knows two things the picker cannot say: that I am on a break (started from
   * the check-in card, not the status menu) and that I have switched to Remote
   * — there is no "Remote" in the status list to choose. Picking a status
   * writes an optimistic entry into the same map, so the dot still flips the
   * instant I choose, and the next poll confirms or corrects it.
   *
   * The picker only speaks for me before the first poll answers. */
  function presenceFor(email) {
    var em = String(email || '').trim().toLowerCase();
    if (!em) return null;
    var snap = PRESENCE[em];
    if (em === String(actorEmail()).trim().toLowerCase()) {
      if (snap) return snap;
      var st = findStatus(getStatusKey()) || OFFLINE;
      return { label: st.label, color: st.color };
    }
    return snap || null;
  }

  /* Keep the picker honest about a break somebody started elsewhere.
     The team feed collapses every break label to "In Break", so which break it
     was is not recoverable — any break key is truthful, and the one already
     chosen is kept when it is one. */
  function reconcileLocalStatus() {
    if (!isCheckedIn()) return;
    var mine = PRESENCE[String(actorEmail()).trim().toLowerCase()];
    if (!mine) return;
    var onBreak = /break|away|coffee/.test(String(mine.label || '').toLowerCase());
    var key = localStorage.getItem(STORAGE_STATUS);
    var keyIsBreak = /away|coffee/.test(String(key || ''));
    if (onBreak && !keyIsBreak) {
      localStorage.setItem(STORAGE_STATUS, 'away');
      render();
    }
  }

  function setDot(host, info) {
    if (!host) return;
    var dot = host.querySelector('.hrms-presence-dot');
    if (!info) {                       // nobody we can speak for — no dot at all
      if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      return;
    }
    if (host.style.position !== 'relative' && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'hrms-presence-dot';
      host.appendChild(dot);
    }
    if (dot.style.background !== info.color) dot.style.background = info.color;
    if (dot.title !== info.label) dot.title = info.label;
  }

  /* Any element that names whose presence it wants: a dot on the avatar, and
     the label in words wherever a dot alone is too terse to be useful. */
  function paintTagged() {
    var hosts = document.querySelectorAll('[data-hrms-presence]');
    Array.prototype.forEach.call(hosts, function (el) {
      setDot(el, presenceFor(el.getAttribute('data-hrms-presence')));
    });
    var labels = document.querySelectorAll('[data-hrms-presence-label]');
    Array.prototype.forEach.call(labels, function (el) {
      var info = presenceFor(el.getAttribute('data-hrms-presence-label'));
      // Nothing known about them: leave the element empty rather than assert
      // "Offline" about somebody the server has not spoken for.
      var text = info ? info.label : '';
      var col = info ? info.color : '';
      if (el.textContent !== text) el.textContent = text;
      if (el.style.color !== col) el.style.color = col;
    });
  }

  /* ── presence dot on my own avatars ──────────────────────────────────── */
  function paintAvatarDots() {
    var st = findStatus(getStatusKey()) || OFFLINE;
    var mine = { label: st.label, color: st.color };
    // The topbar avatar, and the right-hand profile drawer that opens from it.
    var avs = document.querySelectorAll('.topbar .av, .hrms-drawer-av');
    Array.prototype.forEach.call(avs, function (av) { setDot(av, mine); });
    paintTagged();
  }

  /* ── react to check-in changes (from topbar OR employee module) ──────── */
  function onCheckinChange() {
    if (isCheckedIn()) {
      var k = localStorage.getItem(STORAGE_STATUS);
      if (!findStatus(k) || k === 'offline') localStorage.setItem(STORAGE_STATUS, 'available');
    } else {
      panelOpen = false;
    }
    render();
    paintAvatarDots();
  }

  /* A break or a location switch rewrites presence server-side, so the local
     view is stale the moment either happens. Both already announce themselves
     here: the check-in card's Break and Switch-to-Remote buttons post the
     event and then fire hrmsAttendanceSynced, as does the sidecar's own
     "Switch to WFH". This is the only channel they use — there is no separate
     break event to listen for. */
  window.addEventListener('hrmsAttendanceSynced', function () { refreshPresence(true); });
  window.addEventListener('hrmsCheckinToggle', onCheckinChange);
  window.addEventListener('hrmsContextUpdate', onCheckinChange);
  /* status changed elsewhere (e.g. the avatar drawer's selector) → resync.
   *
   * The drawer's <select> lives in the React bundle: it writes the key to
   * localStorage and fires this event, and that is all it does. Nothing was
   * listening on the way OUT, so a status chosen there never reached
   * /api/attendance/presence — the dot changed on the one screen that set it
   * and no colleague ever saw it, nor did the break bookkeeping that endpoint
   * performs. Posting here covers every source; lastPosted stops the picker's
   * own change (which already posted) from being sent twice. */
  window.addEventListener('hrmsStatusChange', function (e) {
    var key = (e && e.detail && e.detail.status) || getStatusKey();
    if (key && key !== lastPosted && findStatus(key) && key !== 'offline' && isCheckedIn()) {
      postPresence(key);
    }
    render();
    paintAvatarDots();
  });
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_CHECKIN || e.key === STORAGE_STATUS) {
      render();
      paintAvatarDots();
    }
  });

  /* close the panel on outside click */
  document.addEventListener('click', function (e) {
    if (!panelOpen) return;
    var block = document.getElementById(BLOCK_ID);
    if (block && !block.contains(e.target)) {
      panelOpen = false;
      render();
    }
  });

  /* close the right-side profile drawer on cross button or backdrop click */
  document.addEventListener('click', function (e) {
    var closeBtn = e.target.closest && e.target.closest('.hrms-drawer-x');
    var isBackdrop = e.target.classList && e.target.classList.contains('hrms-drawer-backdrop');
    if (closeBtn || isBackdrop) {
      var d = document.querySelector('.hrms-drawer');
      var b = document.querySelector('.hrms-drawer-backdrop');
      if (d) { d.style.display = 'none'; try { d.remove(); } catch (_) {} }
      if (b) { b.style.display = 'none'; try { b.remove(); } catch (_) {} }
    }
  });

  /* ── boot + observe React re-renders ─────────────────────────────────── */
  var _obsTimer = null;
  var _isPainting = false;

  function watch() {
    ensureBlock();
    paintAvatarDots();

    var obs = new MutationObserver(function () {
      if (_isPainting) return;
      if (_obsTimer) return;
      _obsTimer = setTimeout(function () {
        _obsTimer = null;
        _isPainting = true;
        try {
          ensureBlock();       // re-inject if React re-rendered the profile page
          paintAvatarDots();   // keep the avatar dot present after topbar re-renders
        } finally {
          _isPainting = false;
        }
      }, 60);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    refreshPresence(true);
    // Only while the tab is in front: a background tab polling every minute
    // for presence nobody is looking at is just load.
    setInterval(function () { if (!document.hidden) refreshPresence(false); }, PRESENCE_TTL);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshPresence(true);
    });
  }

  /* Shared with hrms-chat.js and hrms-attendance-actions.js: tag an avatar
     with data-hrms-presence="<email>" and it gets a live dot. */
  window.__hrmsPresence = {
    get: presenceFor,
    color: function (email) { var p = presenceFor(email); return p ? p.color : '#9ca3af'; },
    label: function (email) { var p = presenceFor(email); return p ? p.label : ''; },
    refresh: function () { refreshPresence(true); },
    paint: paintTagged
  };

  /* external API (parity with hrms-checkin.js) */
  window.__hrmsStatusAPI = {
    get:  function () { return getStatusKey(); },
    set:  function (key) { setStatus(key); },
    list: function () { return STATUSES.slice(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  console.log('[hrms-status v1] loaded — status:', getStatusKey());
})();
