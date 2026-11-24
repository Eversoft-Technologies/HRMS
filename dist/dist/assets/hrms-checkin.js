/**
 * hrms-checkin.js  v4
 * Removes the Settings icon from the topbar and replaces it with a
 * Check-In / Check-Out toggle switch.  Shows a mobile icon when checked-in
 * from mobile, a desktop/PC icon when checked-in from a PC.
 * toggle switch.  Shows a mobile icon when checked-in from mobile,
 * a desktop/PC icon when checked-in from a PC.
 *
 * The device icon appears BOTH on the toggle and in the topbar (next to
 * the toggle) so every other employee viewing the topbar can see whether
 * the currently-checked-in user came from mobile or desktop.
 *
 * Same no-rebuild injection pattern as hrms-live.js / hrms-mobile.js.
 */
(function () {
  'use strict';

  /* ── storage keys ────────────────────────────────────────────────────── */
  var STORAGE_DEVICE   = 'hrms_checkin_device';
  var STORAGE_STATE    = 'hrms_checked_in';
  var TOGGLE_ID        = 'hrms-checkin-toggle';
  var WRAPPER_ID       = 'hrms-checkin-wrapper';
  var checkInAt        = null;   // ms epoch of today's check-in, drives the hover tooltip

  /* ── initial state ────────────────────────────────────────────────────
   *
   * The cached value is a first-paint hint ONLY. The server is the authority
   * and syncFromServer() overrules this the moment it answers.
   *
   * It used to be a bare 'true'/'false' under one global key, with nothing
   * ever reconciling it, which meant the toggle lied in two everyday ways:
   *
   *   - sign out, sign in as someone else on the same browser, and you
   *     inherited THEIR checked-in state;
   *   - check in on Monday, come back Tuesday, and it still read "checked in".
   *
   * Either way the toggle offered "check out", and pressing it asked the
   * server to close a session that was never open — "No check-in found for
   * today". So the cache is now stamped with whose it is and which day it is
   * for, and is ignored when either fails to match.
   */
  function cachedState() {
    try {
      var raw = localStorage.getItem(STORAGE_STATE);
      if (!raw) return false;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      var c = JSON.parse(raw);
      if (!c || typeof c !== 'object') return false;
      var curEmail = sessionEmail();
      if (c.email && curEmail && c.email.toLowerCase() !== curEmail.toLowerCase()) return false;
      if (c.date && c.date !== todayStamp()) return false;
      return !!c.checkedIn;
    } catch (_) { return false; }
  }

  function rememberState(v) {
    try {
      var boolVal = !!v;
      localStorage.setItem(STORAGE_STATE, JSON.stringify({
        email: sessionEmail(), date: todayStamp(), checkedIn: boolVal
      }));
    } catch (_) {}
  }

  function todayStamp() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') +
           '-' + String(n.getDate()).padStart(2, '0');
  }

  function sessionEmail() {
    try {
      var s = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return (s && s.email) || '';
    } catch (_) { return ''; }
  }

  var isCheckedIn = false;   // set by cachedState() once the helpers exist

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function detectDevice() {
    return /mobile|android|iphone|ipad|phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  }

  function getCheckinDevice() {
    return localStorage.getItem(STORAGE_DEVICE) || detectDevice();
  }

  /* ── backend attendance sync ─────────────────────────────────────────── */
  function getActor() {
    try {
      var s = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return { email: (s && s.email) || '', name: (s && (s.name || s.fullName)) || '' };
    } catch (_) {
      return { email: '', name: '' };
    }
  }

  /* ── geolocation ──────────────────────────────────────────────────────
   *
   * Resolves to {latitude, longitude, accuracy} or null. Never rejects: a
   * denied prompt, a device without GPS and a timeout all mean "we cannot
   * prove where you are", which the server treats the same as being outside
   * the fence.
   *
   * Why a watch and not getCurrentPosition: the one-shot call resolves with
   * the FIRST fix available, and the cheap sources answer first. WiFi/cell
   * trilateration replies in milliseconds; the GPS radio needs seconds to lock
   * and only ever reports through watchPosition. enableHighAccuracy requests
   * the good fix, it does not wait for it. So we watch, keep the tightest
   * reading, and stop early once it is good enough for a geofence decision.
   *
   * maximumAge is 0 deliberately. A cached fix is shared across every tab and
   * every signed-in account on this browser, so accepting one meant a person
   * who hit an IP-level reading got that identical reading back on every retry
   * for the next minute — the "try again" the error message asks for could not
   * possibly have worked. Each attempt now re-measures.
   *
   * None of this manufactures a GPS radio. Where the OS location service is
   * off the readings stay IP-level however long we wait, which is precisely
   * why accuracy is sent to the server: it widens the fence by the reading's
   * own error, and refuses to quote a distance from a fix too coarse to
   * support one.
   */
  var GEO_GOOD_ENOUGH_M = 50;        // tight enough to settle a geofence; stop
  var GEO_WAIT_CHECKIN_MS = 15000;   // a person is watching a toggle: bounded
  var GEO_WAIT_SAMPLE_MS = 6000;     // background sweep, every 5 min: cheap

  /* Fast path for the moments a person is staring at the screen (the
   * check-in toggle, switching office/remote). Waiting for a fix better than
   * 50 m is right for the background sweep, but a desktop browser typically
   * reports 60-150 m from WiFi and never gets better, so that rule always ran
   * the full 15 s before the "outside the office" box could appear. Here the
   * wait is relaxed with time instead:
   *     <= 50 m   at once
   *     <= 150 m  after 1 s
   *     anything  after 3.5 s     (the server widens the fence by the fix's
   *                                own error and says how accurate it was)
   * and the clock is credited with the time a background warm-up (below) has
   * already spent, so a person who has been on the page for a few seconds gets
   * an answer with no wait at all. */
  var GEO_FAST_GOOD_M = 150;
  var GEO_FAST_GOOD_AFTER_MS = 1000;
  var GEO_FAST_ANY_AFTER_MS = 3500;
  function fastAcceptable(acc, waitedMs) {
    if (acc <= GEO_GOOD_ENOUGH_M) return true;
    if (acc <= GEO_FAST_GOOD_M && waitedMs >= GEO_FAST_GOOD_AFTER_MS) return true;
    return waitedMs >= GEO_FAST_ANY_AFTER_MS;
  }

  /* Warm-up: while the employee is on the page and not yet checked in, and has
   * ALREADY allowed location for this site (we never trigger the permission
   * prompt on our own), measure in the background so the fix is waiting when
   * they click. It runs for a short burst, not continuously, and is started by
   * opening the page, hovering/touching the toggle, or returning to the tab.
   * This is this page's own measurement for this signed-in person, kept for
   * 90 s; it is not the browser's shared cache that maximumAge 0 below exists
   * to avoid. */
  var GEO_WARM_MAX_AGE_MS = 90000;
  var GEO_WARM_RUN_MS = 25000;
  var geoWarm = { fix: null, fixAt: 0, since: 0, id: null, stopTimer: null, email: '' };

  function warmFix() {
    var w = geoWarm;
    if (!w.fix || Date.now() - w.fixAt > GEO_WARM_MAX_AGE_MS) return null;
    var actor = getActor();
    if (w.email !== (actor && actor.email || '')) return null;
    return { fix: w.fix, since: w.since };
  }

  function stopWarm() {
    try { if (geoWarm.id !== null) navigator.geolocation.clearWatch(geoWarm.id); } catch (_) {}
    if (geoWarm.stopTimer) clearTimeout(geoWarm.stopTimer);
    geoWarm.id = null; geoWarm.stopTimer = null;
  }

  function warmGeo() {
    if (!navigator.geolocation || isCheckedIn || geoWarm.id !== null) return;
    var actor = getActor();
    if (!actor || !actor.email) return;
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
      if (st.state !== 'granted' || geoWarm.id !== null || isCheckedIn) return;
      geoWarm.email = actor.email;
      geoWarm.since = Date.now();
      try {
        geoWarm.id = navigator.geolocation.watchPosition(function (p) {
          var acc = p.coords.accuracy, held = geoWarm.fix;
          // Keep the tightest fix of the last 90 s; a worse one only replaces
          // it once it has gone stale.
          if (held && Date.now() - geoWarm.fixAt < GEO_WARM_MAX_AGE_MS && !(acc < held.accuracy)) return;
          geoWarm.fix = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: acc };
          geoWarm.fixAt = Date.now();
          if (acc <= GEO_GOOD_ENOUGH_M) stopWarm();
        }, function () { stopWarm(); }, { enableHighAccuracy: true, timeout: GEO_WARM_RUN_MS, maximumAge: 0 });
        geoWarm.stopTimer = setTimeout(stopWarm, GEO_WARM_RUN_MS);
      } catch (_) { stopWarm(); }
    }).catch(function () {});
  }

  function getPosition(budgetMs, onProgress, opts) {
    var budget = budgetMs || GEO_WAIT_CHECKIN_MS;
    var fast = !!(opts && opts.fast);
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var best = null, id = null, timer = null, tick = null, done = false;
      var t0 = Date.now();

      if (fast) {
        var warm = warmFix();
        if (warm) {
          best = warm.fix;
          t0 = Math.min(t0, warm.since);            // credit the warm-up time
          stopWarm();
          if (fastAcceptable(best.accuracy, Date.now() - t0)) return resolve(best);
        }
      }

      function finish() {
        if (done) return;
        done = true;
        try { if (id !== null) navigator.geolocation.clearWatch(id); } catch (_) {}
        if (timer) clearTimeout(timer);
        if (tick) clearTimeout(tick);
        resolve(best);
      }

      // Re-check on a timer as well as on each sample: the relaxed thresholds
      // are reached by waiting, and no further sample may arrive to trigger them.
      function checkFast() {
        if (done) return;
        if (best && fastAcceptable(best.accuracy, Date.now() - t0)) return finish();
        tick = setTimeout(checkFast, 200);
      }

      // Also covers Safari leaving the callbacks pending indefinitely when the
      // permission prompt is dismissed rather than answered.
      timer = setTimeout(finish, budget + 1000);
      if (fast) checkFast();

      try {
        id = navigator.geolocation.watchPosition(
          function (p) {
            var acc = p.coords.accuracy;
            // Samples arrive out of order and a later one is often worse (a
            // network fix landing after a GPS reading). Only ever tighten.
            if (best && !(acc < best.accuracy)) return;
            best = {
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: acc
            };
            // Callers that keep someone waiting (registering a home) show the
            // fix tightening; the silent check-in path passes nothing.
            if (onProgress) { try { onProgress(best); } catch (_) {} }
            if (acc <= GEO_GOOD_ENOUGH_M) finish();
            else if (fast && fastAcceptable(acc, Date.now() - t0)) finish();
          },
          function () {
            // A momentary failure mid-watch must not discard a fix in hand.
            if (!best) finish();
          },
          { enableHighAccuracy: true, timeout: budget, maximumAge: 0 }
        );
      } catch (_) { finish(); }
    });
  }

  /* ── leaving the office while checked in ──────────────────────────────
   *
   * The employee's rule:
   *   1. outside the office fence continuously for the policy timeout
   *      (default 10 min) → a prominent warning for warning_seconds (default
   *      10 s) with a sound;
   *   2. still outside when it ends (one more fresh, precise reading) →
   *      automatic check-out;
   *   3. checking in again that day needs the manager's approval (server);
   *   4. a forgotten check-out is never closed here — nothing happens unless
   *      the server has seen an unbroken outside run.
   *
   * The SERVER decides: geofence-check keeps the run of precise outside
   * readings on the session and answers departureDue only once it is long
   * enough and fresh; the check-out re-checks the same run. This script only
   * samples, warns and asks.
   *
   * Limits, so nobody plans around them: browsers run this only while the
   * page is open and visible. A hidden, throttled or sleeping tab does not
   * sample or act (and the server restarts the run after a 12-minute gap).
   * Audio can only play after one click / key press on the page (browser
   * autoplay rules); without it the warning vibrates (phones), flashes and
   * raises a system notification when that permission was granted.
   *
   * Safeguards:
   *   - only precise readings (≤ 100 m) count, on the server;
   *   - one tab watches (leader lock per signed-in email);
   *   - never for an off-site or work-from-home session (server: offsite/wfh);
   *   - the final reading after the countdown must still be outside.
   */
  /* ── GPS watch & auto check-out on geofence departure ───────────────── */
  var GEO_WATCH_MS = 5 * 60 * 1000;      // normal sampling
  var GEO_WATCH_OUT_MS = 60 * 1000;      // while an outside run is building: every minute
  var GEO_FIRST_SAMPLE_MS = 20 * 1000;   // soon after check-in / page load
  var departurePolicy = { enabled: true, timeout_minutes: 10, warning_seconds: 10, warning_sound: true,
                          recheckin_requires_approval: true };
  var geoWatch = { timer: null, beat: null, warning: null };
  var GEO_PRECISE_M = 100;               // a fix vaguer than this never confirms "still outside"
  /* One tab watches: several open tabs used to count (and act) separately. */
  var TAB_ID = Math.random().toString(36).slice(2);
  var LEADER_STALE_MS = 150 * 1000;
  function leaderKey() { return 'hrms_geo_leader_' + (sessionEmail() || ''); }
  function isGeoLeader() {
    try {
      var now = Date.now(), cur = JSON.parse(localStorage.getItem(leaderKey()) || 'null');
      if (!cur || cur.id === TAB_ID || now - (cur.ts || 0) > LEADER_STALE_MS) {
        localStorage.setItem(leaderKey(), JSON.stringify({ id: TAB_ID, ts: now }));
        return true;
      }
      return false;
    } catch (_) { return true; }
  }
  // A tab that goes to the background stops warning (it cannot be seen, and
  // its timers are throttled); the next visible sample starts again.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && geoWatch.warning) { cancelWarning(); scheduleSample(GEO_WATCH_OUT_MS); }
  });
  window.addEventListener('pagehide', function () {
    try { var cur = JSON.parse(localStorage.getItem(leaderKey()) || 'null'); if (cur && cur.id === TAB_ID) localStorage.removeItem(leaderKey()); } catch (_) {}
  });

  function fetchDeparturePolicy() {
    return fetch('/api/attendance/departure-policy')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.enabled === 'boolean') {
          for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) departurePolicy[k] = d[k];
        }
        return departurePolicy;
      })
      .catch(function () { return departurePolicy; });
  }

  function stopGeoWatch() {
    if (geoWatch.timer) clearTimeout(geoWatch.timer);
    if (geoWatch.beat) clearInterval(geoWatch.beat);
    geoWatch.timer = null; geoWatch.beat = null;
    cancelWarning();
  }

  function scheduleSample(ms) {
    if (geoWatch.timer) clearTimeout(geoWatch.timer);
    geoWatch.timer = setTimeout(sampleGeo, ms);
  }

  function startGeoWatch() {
    stopGeoWatch();
    if (!navigator.geolocation) return;
    fetchDeparturePolicy().then(function (pol) {
      if (pol.enabled === false || !isCheckedIn) return;
      scheduleSample(GEO_FIRST_SAMPLE_MS);
      geoWatch.beat = setInterval(function () { if (!document.hidden) isGeoLeader(); }, 60 * 1000);
    });
  }
  /* Keep a running watch as it is (re-syncs must not restart its clock). */
  function ensureGeoWatch() {
    if (geoWatch.timer || geoWatch.warning) return;
    startGeoWatch();
  }

  /* One fresh position + the server's verdict on it: {d, pos} or null. */
  function readGeofence() {
    return getPosition(GEO_WAIT_SAMPLE_MS).then(function (pos) {
      if (!pos) return null;
      return fetch('/api/attendance/geofence-check?latitude=' + pos.latitude +
            '&longitude=' + pos.longitude +
            (pos.accuracy ? '&accuracy=' + pos.accuracy : ''), {
        headers: { 'Content-Type': 'application/json' }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d ? { d: d, pos: pos } : null; });
    }).catch(function () { return null; });
  }

  function sampleGeo() {
    geoWatch.timer = null;
    if (!isCheckedIn) { stopGeoWatch(); return; }
    if (departurePolicy && departurePolicy.enabled === false) { stopGeoWatch(); return; }
    if (geoWatch.warning) return;                               // the warning owns the next step
    if (document.hidden || !getActor().email || !isGeoLeader()) { scheduleSample(GEO_WATCH_MS); return; }

    readGeofence().then(function (res) {
      if (!isCheckedIn) { stopGeoWatch(); return; }
      if (!res) { scheduleSample(GEO_WATCH_MS); return; }
      var d = res.d;
      // Off-site / WFH sessions have no office to leave; policy switched off.
      if (d.enforced === false || d.wfh || d.offsite || d.autoCheckout === false) { stopGeoWatch(); return; }
      // On the office's own network (Wi-Fi / IP whitelist): inside, whatever
      // indoor GPS says — never warn, and drop any warning already showing.
      if (d.network && d.network.matched) { cancelWarning(); scheduleSample(GEO_WATCH_MS); return; }
      if (d.departureDue && !document.hidden) { showDepartureWarning(d); return; }
      // Outside (precisely): sample every minute so the warning comes on time.
      scheduleSample(!d.inside && !d.uncertain ? GEO_WATCH_OUT_MS : GEO_WATCH_MS);
    });
  }

  /* ── warning sound ─────────────────────────────────────────────────────
     Web Audio, no file. Browsers keep audio locked until the person has
     interacted with the page, so the context is created / resumed on the
     first click, tap or key press and is ready when the warning needs it. */
  var alarm = { ctx: null, nodes: [] };
  function unlockAudio() {
    try {
      if (!alarm.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        alarm.ctx = new AC();
      }
      if (alarm.ctx.state === 'suspended' && alarm.ctx.resume) alarm.ctx.resume().catch(function () {});
      // A silent one-sample buffer completes the unlock on iOS Safari.
      var b = alarm.ctx.createBuffer(1, 1, 22050), s = alarm.ctx.createBufferSource();
      s.buffer = b; s.connect(alarm.ctx.destination); s.start(0);
    } catch (_) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (!alarm.ctx || alarm.ctx.state !== 'running') unlockAudio();
    }, { capture: true, passive: true });
  });
  /* Beep-beep-beep every 2 s for ``secs``. True when sound was scheduled. */
  function playAlarm(secs) {
    var c = alarm.ctx;
    window.__hrmsGeoAlarm = { attempted: true, at: Date.now(), state: c ? c.state : 'none' };
    if (!c || c.state !== 'running') return false;
    try {
      var t0 = c.currentTime + 0.05;
      for (var k = 0; k < Math.max(1, Math.ceil(secs / 2)); k++) {
        for (var j = 0; j < 3; j++) {
          var start = t0 + k * 2 + j * 0.25;
          var osc = c.createOscillator(), g = c.createGain();
          osc.type = 'square';
          osc.frequency.value = j === 2 ? 1175 : 880;
          g.gain.setValueAtTime(0.0001, start);
          g.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
          osc.connect(g); g.connect(c.destination);
          osc.start(start); osc.stop(start + 0.2);
          alarm.nodes.push(osc);
        }
      }
      window.__hrmsGeoAlarm.played = true;
      return true;
    } catch (_) { return false; }
  }
  function stopAlarm() {
    alarm.nodes.forEach(function (o) { try { o.stop(); } catch (_) {} });
    alarm.nodes = [];
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (_) {}
  }

  /* ── the warning ──────────────────────────────────────────────────────── */
  function ensureWarnStyle() {
    if (document.getElementById('hrms-geo-warn-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-geo-warn-style';
    st.textContent =
      '#hrms-geo-warn{position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;' +
      "padding:16px;background:rgba(127,29,29,.55);font-family:'Segoe UI',Arial,sans-serif;}" +
      '#hrms-geo-warn.hgw-flash{animation:hgwFlash 1s steps(2,start) infinite;}' +
      '@keyframes hgwFlash{0%{background:rgba(220,38,38,.65)}100%{background:rgba(127,29,29,.45)}}' +
      '#hrms-geo-warn .hgw-card{background:var(--bg2,#fff);color:var(--text,#0f172a);border-radius:16px;max-width:440px;' +
      'width:100%;box-shadow:0 24px 70px rgba(0,0,0,.45);border-top:6px solid #dc2626;padding:22px 22px 18px;box-sizing:border-box;}' +
      '#hrms-geo-warn .hgw-top{display:flex;align-items:center;gap:14px;}' +
      '#hrms-geo-warn .hgw-count{flex:0 0 auto;width:64px;height:64px;border-radius:50%;background:#dc2626;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;}' +
      '#hrms-geo-warn h2{margin:0 0 4px;font-size:18px;font-weight:800;line-height:1.3;color:var(--text,#0f172a);}' +
      '#hrms-geo-warn p{margin:0;font-size:14px;line-height:1.55;color:var(--text2,#475569);}' +
      '#hrms-geo-warn .hgw-msg{margin-top:12px;min-height:18px;font-size:13px;font-weight:600;color:#b91c1c;}' +
      '#hrms-geo-warn .hgw-acts{display:flex;justify-content:flex-end;margin-top:14px;}' +
      '#hrms-geo-warn button{padding:11px 18px;border-radius:9px;border:none;background:#0f9d58;color:#fff;font-size:14px;' +
      'font-weight:700;cursor:pointer;min-height:44px;}' +
      '#hrms-geo-warn button[disabled]{opacity:.6;cursor:default;}' +
      '@media (max-width:420px){#hrms-geo-warn .hgw-top{flex-direction:column;align-items:flex-start;}' +
      '#hrms-geo-warn button{width:100%;}}';
    document.head.appendChild(st);
  }

  function showDepartureWarning(d) {
    if (geoWatch.warning || !isCheckedIn) return;
    ensureWarnStyle();
    var secs = Math.max(5, Math.min(120, parseInt(d.warningSeconds || departurePolicy.warning_seconds, 10) || 10));
    var mins = d.timeoutMinutes || departurePolicy.timeout_minutes || 10;
    var el = document.createElement('div');
    el.id = 'hrms-geo-warn';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'hgw-title');
    el.setAttribute('aria-describedby', 'hgw-body');
    el.innerHTML =
      '<div class="hgw-card">' +
      '<div class="hgw-top"><div class="hgw-count" aria-hidden="true">' + secs + '</div>' +
      '<div><h2 id="hgw-title">You\'ve left the office</h2>' +
      '<p id="hgw-body">You\'ve been outside the office for ' + mins + ' minute' + (mins === 1 ? '' : 's') +
      '. You\'ll be checked out in <b class="hgw-secs">' + secs + '</b>&nbsp;s unless you\'re back inside.</p></div></div>' +
      '<div class="hgw-msg" aria-live="polite"></div>' +
      '<div class="hgw-acts"><button type="button" class="hgw-back">I\'m back — re-check location</button></div>' +
      '</div>';
    document.body.appendChild(el);
    var w = { el: el, deadline: Date.now() + secs * 1000, checking: false, done: false, tick: null, d: d };
    geoWatch.warning = w;
    var btn = el.querySelector('.hgw-back'), msg = el.querySelector('.hgw-msg');
    try { btn.focus(); } catch (_) {}

    var sound = departurePolicy.warning_sound !== false && d.warningSound !== false;
    var played = sound && playAlarm(secs);
    if (!played) {
      // Audio blocked (no click on the page yet) or switched off: make the
      // warning impossible to miss another way.
      el.classList.add('hgw-flash');
      try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400, 200, 400]); } catch (_) {}
      try {
        if (window.Notification && Notification.permission === 'granted') {
          var n = new Notification('You\'ve left the office', {
            body: 'You\'ll be checked out in ' + secs + ' s unless you\'re back inside.',
            tag: 'hrms-geo-departure', requireInteraction: true
          });
          w.notification = n;
          n.onclick = function () { try { window.focus(); } catch (_) {} n.close(); };
        }
      } catch (_) {}
    }

    btn.onclick = function () {
      if (w.checking || w.done) return;
      unlockAudio();
      w.checking = true;
      btn.disabled = true;
      msg.textContent = 'Checking your location…';
      readGeofence().then(function (res) {
        if (w.done) return;
        w.checking = false;
        btn.disabled = false;
        if (res && res.d && (res.d.inside || (res.d.network && res.d.network.matched))) { backInside(); return; }
        msg.textContent = res && res.d && !res.d.uncertain
          ? 'Still outside' + (res.d.fence ? ' ' + res.d.fence : ' the office') +
            (res.d.distance != null ? ' (about ' + Math.round(res.d.distance) + ' m from its centre)' : '') + '.'
          : 'Could not get a precise location. Move near a window or turn on precise location.';
      });
    };

    function paint() {
      var left = Math.max(0, Math.ceil((w.deadline - Date.now()) / 1000));
      el.querySelector('.hgw-count').textContent = left;
      el.querySelector('.hgw-secs').textContent = left;
      if (left <= 0 && !w.checking && !w.done) finalCheck();
    }
    w.tick = setInterval(paint, 250);
  }

  function cancelWarning() {
    var w = geoWatch.warning;
    if (!w) return;
    w.done = true;
    if (w.tick) clearInterval(w.tick);
    stopAlarm();
    try { if (w.notification) w.notification.close(); } catch (_) {}
    if (w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
    geoWatch.warning = null;
  }

  function backInside() {
    cancelWarning();
    notice('Welcome back', 'You are inside the office — you stay checked in.');
    scheduleSample(GEO_WATCH_MS);
  }

  /* The countdown ended: one more fresh reading decides. */
  function finalCheck() {
    var w = geoWatch.warning;
    if (!w || w.checking || w.done) return;
    w.checking = true;
    var btn = w.el.querySelector('.hgw-back'), msg = w.el.querySelector('.hgw-msg');
    btn.disabled = true;
    msg.textContent = 'Checking your location one more time…';
    readGeofence().then(function (res) {
      if (w.done) return;
      if (document.hidden || !isCheckedIn) { cancelWarning(); scheduleSample(GEO_WATCH_OUT_MS); return; }
      var d = res && res.d;
      if (d && (d.inside || (d.network && d.network.matched))) { backInside(); return; }
      if (d && d.departureDue && !d.uncertain && res.pos && res.pos.accuracy <= GEO_PRECISE_M) {
        msg.textContent = 'Checking you out…';
        autoCheckOut(d, res.pos);
        return;
      }
      // Not proven still outside (vague fix, no fix): do nothing now.
      cancelWarning();
      scheduleSample(GEO_WATCH_OUT_MS);
    });
  }

  function hhmm(s) {
    var m = /(\d{1,2}):(\d{2})/.exec(String(s || '').split(' ').pop() || '');
    return m ? m[1] + ':' + m[2] : '';
  }

  function autoCheckOut(d, pos) {
    var actor = getActor();
    fetch('/api/attendance/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: actor.email,
        auto: 'geofence_departure',
        outside_minutes: d && d.outsideMinutes,
        // where they were, so the employee, HR and the timeline can see why
        distance: d && d.distance != null ? d.distance : undefined,
        fence: d && d.fence ? d.fence : undefined,
        latitude: pos ? pos.latitude : undefined,
        longitude: pos ? pos.longitude : undefined
      })
    })
      .then(function (r) {
        if (r.ok) return r.json().catch(function () { return {}; });
        // The server did not see an unbroken outside run long enough (the tab
        // slept, the network dropped, readings were vague): keep watching.
        return r.json().catch(function () { return {}; }).then(function (e) {
          cancelWarning();
          if (e && (e.code === 'NO_OPEN_SESSION' || e.code === 'SESSION_EXPIRED')) { syncFromServer(true); return null; }
          if (e && e.code === 'NOT_AN_OFFICE_SESSION') { stopGeoWatch(); return null; }
          scheduleSample(GEO_WATCH_OUT_MS);
          return null;
        });
      })
      .then(function (record) {
        if (!record) return;
        stopGeoWatch();
        isCheckedIn = false;
        checkInAt = null;
        rememberState(false);
        var w = document.getElementById(WRAPPER_ID), t = document.getElementById(TOGGLE_ID);
        if (w && t) refreshUI(w, t, w.querySelector('.hrms-ci-icon'), getCheckinDevice());
        window.dispatchEvent(new CustomEvent('hrmsCheckinToggle',
          { detail: { checkedIn: false, device: getCheckinDevice() } }));
        window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced',
          { detail: { checkedIn: false, record: record } }));
        var at = hhmm(record.autoCheckoutAt), left = record.checkOutTime || '';
        notice('Checked out automatically',
          'You were outside ' + (d.fence || 'the office') + ' for ' + (d.outsideMinutes || d.timeoutMinutes || 10) +
          ' minutes, so you were checked out' + (at ? ' at ' + at : '') + '.' +
          (left ? ' Your hours count until you left, at ' + left + '.' : '') +
          (departurePolicy.recheckin_requires_approval !== false
            ? ' Checking in again today needs your manager\'s approval.' : ''));
      })
      .catch(function () { cancelWarning(); scheduleSample(GEO_WATCH_OUT_MS); });
  }

  /* ── checking in again after an automatic check-out ─────────────────── */
  var recheckinStatus = '';             // '' | Pending | Approved | Rejected (today's row)
  var recheckinPoll = null;
  function setRecheckinStatus(st, quiet) {
    st = st || '';
    var prev = recheckinStatus;
    recheckinStatus = st;
    if (!quiet && prev === 'Pending' && st === 'Approved') {
      notice('Check-in approved', 'Your manager approved your check-in after the automatic check-out. Your time counts.');
    } else if (!quiet && prev === 'Pending' && st === 'Rejected') {
      notice('Check-in not approved', 'Your manager did not approve your check-in after the automatic check-out. ' +
        'That time is not counted. Check the bell for details.');
    }
    if (st === 'Pending' && !recheckinPoll) {
      recheckinPoll = setInterval(function () { syncFromServer(true); }, 60 * 1000);
    } else if (st !== 'Pending' && recheckinPoll) {
      clearInterval(recheckinPoll); recheckinPoll = null;
    }
    paintPendingBadge();
  }
  function paintPendingBadge() {
    var wrap = document.getElementById(WRAPPER_ID);
    if (!wrap) return;
    var b = wrap.querySelector('.hrms-ci-pending');
    var show = recheckinStatus === 'Pending';
    if (show && !b) {
      b = document.createElement('span');
      b.className = 'hrms-ci-pending';
      b.setAttribute('style', 'margin-left:6px;padding:2px 8px;border-radius:999px;font:700 11px/1.6 \'Segoe UI\',Arial,' +
        'sans-serif;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;white-space:nowrap;');
      b.textContent = 'Awaiting manager approval';
      b.title = 'You checked in again after an automatic check-out. The time counts once your manager approves it.';
      wrap.appendChild(b);
    } else if (!show && b) {
      b.parentNode.removeChild(b);
    }
  }

  function askRecheckinReason(info) {
    info = info || {};
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.id = 'hrms-recheckin-modal';
      back.setAttribute('role', 'dialog');
      back.setAttribute('aria-modal', 'true');
      back.setAttribute('aria-labelledby', 'hrms-rc-title');
      back.setAttribute('style',
        'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.55);' +
        'display:flex;align-items:center;justify-content:center;padding:16px;' +
        "font-family:'Segoe UI',Arial,sans-serif;");
      var when = info.autoCheckoutTime || hhmm(info.autoCheckoutAt);
      var explain = 'You were checked out automatically' + (when ? ' at ' + when : '') +
        ' for leaving the office. Checking in again needs your manager\'s approval.';
      back.innerHTML =
        '<div style="background:var(--bg2,#fff);color:var(--text,#0f172a);border-radius:14px;max-width:460px;width:100%;' +
        'box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden;">' +
        '<div style="padding:20px 22px 0;">' +
        '<div id="hrms-rc-title" style="font-size:17px;font-weight:800;margin-bottom:8px;">Check in again?</div>' +
        '<div style="font-size:13px;color:var(--text2,#475569);line-height:1.6;">' + explain.replace(/</g, '&lt;') +
        '<br><br><strong>You will be checked in now; the time counts once your manager approves it.</strong></div>' +
        '<label for="hrms-rc-reason" style="display:block;margin-top:14px;font-size:12px;font-weight:700;">Reason</label>' +
        '<textarea id="hrms-rc-reason" rows="3" placeholder="e.g. Went to the bank on a work errand" ' +
        'style="width:100%;margin-top:4px;padding:10px 12px;border:1px solid var(--border2,#cbd5e1);' +
        'background:var(--bg3,#fff);color:var(--text,#0f172a);border-radius:8px;font-size:13px;font-family:inherit;' +
        'resize:vertical;box-sizing:border-box;"></textarea>' +
        '<div id="hrms-rc-err" style="color:#dc2626;font-size:12px;min-height:16px;margin-top:4px;"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding:8px 22px 20px;">' +
        '<button id="hrms-rc-cancel" type="button" style="padding:9px 18px;min-height:40px;border-radius:8px;' +
        'border:1px solid var(--border2,#e2e8f0);background:var(--bg3,#fff);color:var(--text,#334155);font-size:13px;' +
        'font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button id="hrms-rc-ok" type="button" style="padding:9px 18px;min-height:40px;border-radius:8px;border:none;' +
        'background:#0f9d58;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">Send to manager &amp; check in</button>' +
        '</div></div>';
      document.body.appendChild(back);
      var box = back.querySelector('#hrms-rc-reason'), errEl = back.querySelector('#hrms-rc-err');
      if (box) box.focus();
      function close(v) { if (back.parentNode) back.parentNode.removeChild(back); resolve(v); }
      back.querySelector('#hrms-rc-cancel').onclick = function () { close(null); };
      back.querySelector('#hrms-rc-ok').onclick = function () {
        var v = (box && box.value || '').trim();
        if (v.length < 3) { errEl.textContent = 'Please give a brief reason.'; if (box) box.focus(); return; }
        close(v);
      };
      back.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(null); });
      back.addEventListener('click', function (e) { if (e.target === back) close(null); });
    });
  }

  /* A short banner for outcomes the employee must actually notice — the
     toggle rolling back on its own looks like the click never registered. */
  function notice(title, body) {
    var el = document.createElement('div');
    el.setAttribute('style',
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100003;' +
      'background:#0f172a;color:#fff;padding:13px 20px;border-radius:10px;max-width:420px;' +
      "font-family:'Segoe UI',Arial,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.35);");
    el.innerHTML = '<div style="font-weight:700;font-size:13px;margin-bottom:3px;">' +
      String(title).replace(/</g, '&lt;') + '</div>' +
      '<div style="font-size:12px;opacity:.85;line-height:1.5;">' +
      String(body).replace(/</g, '&lt;') + '</div>';
    document.body.appendChild(el);
    // Long enough to read; click to dismiss. The bell keeps a copy.
    el.style.cursor = 'pointer';
    el.addEventListener('click', function () { el.remove(); });
    setTimeout(function () { if (el.parentNode) el.remove(); }, 20000);
  }

  /* ── "why are you off-site?" prompt ───────────────────────────────────
     The server answers 422 LOCATION_REASON_REQUIRED when someone who is not
     working from home checks in outside every active geofence. It lets them
     in once a reason is supplied, and holds the day for HR approval. */
  function askReason(info) {
    info = info || {};
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.id = 'hrms-geo-modal';
      back.setAttribute('style',
        'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.55);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;' +
        "font-family:'Segoe UI',Arial,sans-serif;");
      // The server explains itself — distance, radius and GPS accuracy — so the
      // employee can tell "you are 600 m away" from "we never got a fix".
      var explain = info.message ||
        'We could not confirm your location. Add a reason and HR will review it.';
      // Plotting an IP-level fix would draw a confident pin 110 km away, so the
      // map is offered only when the position is precise enough to mean something.
      var mapBtn = (info.hasPosition && info.distance != null && info.fenceLat != null)
        ? '<button id="hrms-geo-map" style="margin-top:12px;padding:7px 14px;border-radius:7px;' +
          'border:1px solid var(--border2,#cbd5e1);background:var(--bg3,#fff);color:var(--text,#334155);font-size:12px;font-weight:600;' +
          'cursor:pointer;">View on map</button>'
        : '';
      // The same dialog serves both refusals, and the difference matters: a
      // working-from-home employee told they are "outside the office" reads it
      // as the wrong problem and cannot act on it. The server's message below
      // is already home-aware; the heading has to agree with it.
      var atHomeCase = !!info.isWfh;
      var heading = !info.hasPosition ? 'We could not confirm your location'
        : atHomeCase ? 'You are not at your registered home'
        : 'You are outside the office location';
      var hint = atHomeCase ? 'e.g. Working from my parents this week'
                            : 'e.g. Client visit in Bengaluru';

      back.innerHTML =
        '<div style="background:var(--bg2,#fff);color:var(--text,#0f172a);border-radius:14px;max-width:460px;width:100%;' +
        'box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden;">' +
        '<div style="padding:20px 24px 0;">' +
        '<div style="font-size:17px;font-weight:800;color:var(--text,#0f172a);margin-bottom:8px;">' +
        heading + '</div>' +
        '<div style="font-size:13px;color:var(--text2,#475569);line-height:1.6;">' + explain +
        '<br><br><strong>Your check-in will start once HR approves it.</strong>' +
        '</div>' + mapBtn +
        '<textarea id="hrms-geo-reason" rows="3" placeholder="' + hint + '" ' +
        'style="width:100%;margin-top:14px;padding:10px 12px;border:1px solid var(--border2,#cbd5e1);' +
        'background:var(--bg3,#fff);color:var(--text,#0f172a);' +
        'border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box;">' +
        '</textarea>' +
        '<div id="hrms-geo-err" style="color:#dc2626;font-size:12px;min-height:16px;margin-top:4px;"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;padding:8px 24px 20px;">' +
        '<button id="hrms-geo-cancel" style="padding:9px 18px;border-radius:8px;border:1px solid var(--border2,#e2e8f0);' +
        'background:var(--bg3,#fff);color:var(--text,#334155);font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button id="hrms-geo-ok" style="padding:9px 20px;border-radius:8px;border:none;' +
        'background:#0f9d58;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">' +
        'Submit for approval</button>' +
        '</div></div>';
      document.body.appendChild(back);

      var box = back.querySelector('#hrms-geo-reason');
      var err = back.querySelector('#hrms-geo-err');
      if (box) box.focus();

      function close(value) {
        if (back.parentNode) back.parentNode.removeChild(back);
        resolve(value);
      }
      var mapEl = back.querySelector('#hrms-geo-map');
      if (mapEl) mapEl.onclick = function () {
        // OSM's own viewer: both markers, a real scale bar, and pan/zoom —
        // everything the little preview in the admin screen cannot give.
        var a = info.fenceLat + ',' + info.fenceLng;
        var b = info.pointLat + ',' + info.pointLng;
        window.open(
          'https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=' +
          encodeURIComponent(a) + ';' + encodeURIComponent(b),
          '_blank', 'noopener'
        );
      };
      back.querySelector('#hrms-geo-cancel').onclick = function () { close(null); };
      back.querySelector('#hrms-geo-ok').onclick = function () {
        var v = (box && box.value || '').trim();
        if (v.length < 3) {
          err.textContent = 'Please give a brief reason.';
          if (box) box.focus();
          return;
        }
        close(v);
      };
      back.addEventListener('click', function (e) { if (e.target === back) close(null); });
    });
  }

  /* A small pill that appears the instant the toggle is clicked, so the person
     sees something is happening while the position is measured and the server
     is asked, instead of a toggle that seems to do nothing. */
  var LOCATING_ID = 'hrms-ci-locating';
  function showLocating(text) {
    try {
      var el = document.getElementById(LOCATING_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = LOCATING_ID;
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100000;' +
          'display:flex;align-items:center;gap:8px;padding:9px 18px;border-radius:999px;font-size:13px;font-weight:600;' +
          'background:var(--bg3,#1e293b);color:var(--text,#f1f5f9);border:1px solid var(--border2,#334155);' +
          'box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none';
        document.body.appendChild(el);
      }
      el.textContent = '📍 ' + text;
      el.style.display = 'flex';
    } catch (_) {}
  }
  function hideLocating() {
    var el = document.getElementById(LOCATING_ID);
    if (el) el.style.display = 'none';
  }

  /* Records the check-in / check-out against the Django attendance API.
     Auth + actor headers are attached automatically by hrms-actor.js. Fires
     'hrmsAttendanceSynced' with the saved record so the check-in page can
     display real times. No-op when logged out. */
  function syncAttendance(checkedIn, device) {
    var actor = getActor();
    if (!actor.email) return;
    var path = checkedIn ? '/api/attendance/check-in' : '/api/attendance/check-out';

    var recheckinReason = '';
    function post(extra) {
      var bypass = !isGeofenceEnabled();
      var body = checkedIn
        ? {
            email: actor.email,
            device: device || detectDevice(),
            employee: actor.name,
            bypassGeofence: bypass
          }
        : { email: actor.email };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
      if (checkedIn && recheckinReason) body.recheckinReason = recheckinReason;
      return fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bypass-Geofence': bypass ? '1' : '0'
        },
        body: JSON.stringify(body)
      });
    }

    function settle(resp) {
      return (resp ? resp.json().catch(function () { return null; }) : Promise.resolve(null))
        .then(function (record) {
          window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced', {
            detail: { checkedIn: checkedIn, record: record }
          }));
          console.log('[hrms-checkin] attendance', checkedIn ? 'check-in' : 'check-out', record);
          if (record && typeof record.recheckinStatus === 'string') {
            setRecheckinStatus(record.recheckinStatus, true);
            if (checkedIn && record.recheckinStatus === 'Pending') {
              notice('Waiting for manager approval', record.message ||
                'You are checked in. Because you were checked out automatically today, this time counts once your manager approves it.');
            }
          }
          // Checked in from home with no home address on file. Offered after
          // the check-in has already succeeded, so declining costs nothing.
          // GPS drifted (or was unavailable) but the request came from the
          // office's own network: say how the check-in was verified.
          if (checkedIn && record && record.verifiedBy === 'office_network') {
            notice('Checked in — verified by office Wi-Fi', record.locationMessage ||
              'You are on the office network, so your check-in was verified without GPS.');
          }
          if (record && record.homeLocationMissing) {
            var hs = record.homeLocationStatus || 'Not set up';
            if (hs === 'Not set up' || hs === 'Rejected') {
              setTimeout(offerHomeRegistration, 400);   // let the toggle settle first
            } else {
              // Already registered and waiting for HR: re-registering would only
              // replace the request, so explain instead of offering it again.
              setTimeout(function () {
                notice('Location not verified', record.locationMessage ||
                  'Your home location is ' + hs.toLowerCase() + '. Work-from-home check-ins are verified once HR approves it.');
              }, 400);
            }
          }
          return true;
        });
    }

    // Every check-in is location-checked, whatever the mode; checking out is not.
    if (checkedIn) showLocating('Checking your location\u2026');
    return (checkedIn ? getPosition(undefined, undefined, { fast: true }) : Promise.resolve(null))
      .then(function (pos) {
        if (checkedIn) showLocating('Verifying with the office\u2026');
        return post(pos || {}).then(function handle(r) {
          hideLocating();
          if (r.ok) return settle(r);
          if (!isGeofenceEnabled()) return settle(r);
          return r.json().catch(function () { return {}; }).then(function (d) {
            d = d || {};

            // If geofence is disabled, do not show any location reason dialogs
            if (!isGeofenceEnabled()) {
              return settle(r);
            }

            if (d.code === 'LOCATION_REQUIRED') {
              notice('Location needed',
                d.message || 'Allow location access for this site and try again.');
              return false;
            }

            // Already waiting on HR from an earlier attempt today.
            // The toggle and the server disagreed about whether a session was
            // open. Whatever caused the drift — a stale tab, a reload during
            // the reason dialog, a second device — arguing with the user about
            // it is useless; re-ask the server and show the truth.
            // A session from an earlier day was never checked out and its
            // shift is over: it cannot be closed "now" (that would record a
            // day and a half). Open the regularization form for that day.
            if (d.code === 'SESSION_EXPIRED') {
              syncFromServer(true);
              notice('Check-out missed on ' + (d.date || 'an earlier day'),
                d.message || 'Please submit a Missed punch / Regularize request for that day.');
              try { if (window.HRMSRegularize && d.date) window.HRMSRegularize.open({ date: d.date }); } catch (_) {}
              return false;
            }

            // Checked out automatically today for leaving the office: coming
            // back needs the manager. Ask for a reason, then check in pending.
            if (d.code === 'RECHECKIN_APPROVAL_REQUIRED') {
              return askRecheckinReason(d).then(function (why) {
                if (!why) return false;                  // cancelled → stay checked out
                recheckinReason = why;
                return post(pos ? { latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy } : {})
                  .then(handle);
              });
            }

            if (d.code === 'RECHECKIN_REJECTED') {
              notice('Check-in not approved',
                d.message || 'Your manager did not approve checking in again today.');
              return false;
            }

            if (d.code === 'NO_OPEN_SESSION') {
              syncFromServer(true);
              notice('You were not checked in',
                d.message || 'The toggle was out of date and has been corrected.');
              return false;
            }

            // Matched on the code, not on the bare status: NO_OPEN_SESSION is
            // also a 409, and announcing it as "waiting for HR approval" would
            // send someone chasing an approval that does not exist.
            if (d.code === 'LOCATION_APPROVAL_PENDING') {
              notice('Waiting for HR approval',
                d.message || 'Your off-site check-in is still awaiting approval.');
              return false;
            }

            // A decision has already been made and it was no. Say so plainly
            // rather than offering the reason box again — re-asking is exactly
            // what the server now refuses, and a form that cannot succeed is
            // worse than a clear refusal.
            if (d.code === 'LOCATION_APPROVAL_REJECTED') {
              notice('Off-site check-in rejected',
                d.message || 'Your off-site check-in for today was rejected. ' +
                'You can check in from the office.');
              return false;
            }

            // Claimed to be working from home without an approved request.
            if (d.code === 'WFH_APPROVAL_REQUIRED') {
              notice('Work-from-home needs approval',
                d.message || 'You need an approved work-from-home request for ' +
                'today before checking in from home.');
              return false;
            }

            if (r.status !== 422 || d.code !== 'LOCATION_REASON_REQUIRED') {
              console.warn('[hrms-checkin] attendance rejected', r.status, d);
              notice(checkedIn ? 'Could not check in' : 'Could not check out',
                d.message || ('Server returned ' + r.status));
              // Any refusal we did not specifically model may have left the
              // toggle disagreeing with the server. Rolling back locally only
              // restores what the client believed, which is what was wrong in
              // the first place — so re-read the truth instead.
              syncFromServer(true);
              return false;
            }

            // Outside the fence: collect a reason, then submit for approval.
            // The employee is NOT checked in until HR approves, so this always
            // resolves false and the toggle rolls back.
            if (pos) { d.pointLat = pos.latitude; d.pointLng = pos.longitude; }
            return askReason(d).then(function (reason) {
              if (!reason) return false;                 // cancelled → stay checked out
              var retry = pos
                ? { latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy }
                : {};
              retry.locationReason = reason;
              return post(retry).then(function (r2) {
                if (r2.ok) return settle(r2);            // e.g. HR pre-approved
                return r2.json().catch(function () { return {}; }).then(function (d2) {
                  notice(
                    r2.status === 202 ? 'Sent to HR' : 'Could not check in',
                    (d2 && d2.message) ||
                    'Your request has been sent to HR. You can check in once it is approved.'
                  );
                  return false;
                });
              });
            });
          });
        });
      })
      .catch(function (e) { hideLocating(); console.warn('[hrms-checkin] attendance sync failed', e); });
  }

  /* ── SVG icons ───────────────────────────────────────────────────────── */
  var MOBILE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"' +
    ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15">' +
    '<rect x="5" y="2" width="14" height="20" rx="2"/>' +
    '<line x1="12" y1="18" x2="12.01" y2="18"/>' +
    '</svg>';

  var DESKTOP_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"' +
    ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15">' +
    '<rect x="2" y="3" width="20" height="14" rx="2"/>' +
    '<polyline points="8 21 12 17 16 21"/>' +
    '</svg>';

  function deviceIcon(device) {
    return device === 'mobile' ? MOBILE_ICON : DESKTOP_ICON;
  }

  /* ── hover tooltip: live time since check-in ("In 02:18:37 Hrs") ──────────
     The native title= attribute is gone; the wrapper keeps the hint text in
     data-hint and the tooltip shows it as a second line. While the tooltip
     is open it re-renders every second from checkInAt, which is learnt from
     /api/attendance/today, from the check-in response, or optimistically
     from the click itself. */
  var TIP_CLASS = 'hrms-ci-tip';
  var tipTimer  = null;
  function parseLocal(s) {
    if (!s) return null;
    var t = Date.parse(String(s).replace(' ', 'T'));
    return isNaN(t) ? null : t;
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function ensureTipStyle() {
    if (document.getElementById('hrms-ci-tip-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-ci-tip-style';
    st.textContent =
      '.hrms-ci-wrap{position:relative;}' +
      '.' + TIP_CLASS + '{position:absolute!important;top:calc(100% + 9px);right:0;left:auto;width:auto;max-width:none;overflow:visible;background:#0b1220;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 12px;font-size:12.5px;line-height:1.3;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:10000;opacity:0;visibility:hidden;transform:translateY(-4px);transition:opacity .15s,transform .15s;pointer-events:none;display:inline-flex!important;align-items:baseline;gap:5px;font-family:var(--font,"DM Sans",sans-serif);}' +
      '.' + TIP_CLASS + '::before{content:"";position:absolute;top:-5px;right:16px;width:8px;height:8px;background:#0b1220;border-left:1px solid rgba(255,255,255,.12);border-top:1px solid rgba(255,255,255,.12);transform:rotate(45deg);}' +
      '.hrms-ci-wrap.ci-tip-open .' + TIP_CLASS + '{opacity:1;visibility:visible;transform:none;}' +
      '.' + TIP_CLASS + ' b{font-weight:700;color:#fff;}' +
      '.' + TIP_CLASS + ' .hrms-ci-tip-time{color:#22c55e;font-weight:700;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,Consolas,monospace;}' +
      '.' + TIP_CLASS + '{background:#000!important;font-size:14px!important;padding:8px 14px!important;gap:8px!important;}' +
      '.' + TIP_CLASS + '::before{background:#000!important;}' +
      '.' + TIP_CLASS + ' .hrms-ci-tip-time{color:#4ade80;font-size:14px;}' +
      '.' + TIP_CLASS + '.ci-tip2{display:block!important;padding:8px 12px;}' +
      '.' + TIP_CLASS + ' .ci-tip-row{display:flex;align-items:baseline;gap:6px;}' +
      '.' + TIP_CLASS + ' .ci-tip-lbl{color:#cbd5e1;}' +
      '.' + TIP_CLASS + ' .ci-tip-in{color:#22c55e;font-weight:700;font-size:14px;font-variant-numeric:tabular-nums;}' +
      '.' + TIP_CLASS + ' .ci-tip-sub{display:block;margin-top:3px;color:#94a3b8;font-size:11.5px;}' +
      '.hrms-ci-wrap{cursor:pointer;}' +
      '.hrms-ci-wrap .hrms-ci-switch{transition:box-shadow .15s ease,transform .15s ease,filter .15s ease;}' +
      '.hrms-ci-wrap:hover .hrms-ci-switch,.hrms-ci-wrap .hrms-ci-switch:focus-visible{box-shadow:0 0 0 4px rgba(148,163,184,.28);transform:scale(1.04);}' +
      '.hrms-ci-wrap:hover .hrms-ci-switch.ci-on,.hrms-ci-wrap .hrms-ci-switch.ci-on:focus-visible{box-shadow:0 0 0 4px rgba(34,197,94,.30);filter:brightness(1.06);}' +
      '@media (prefers-reduced-motion:reduce){.hrms-ci-wrap .hrms-ci-switch{transition:none;}.hrms-ci-wrap:hover .hrms-ci-switch{transform:none;}}' +
      '.topbar .hrms-ci-wrap{overflow:visible!important;max-width:none!important;}';
    document.head.appendChild(st);
  }
  function paintTip(wrap) {
    wrap = wrap || document.getElementById(WRAPPER_ID);
    if (!wrap) return;
    var tip = wrap.querySelector('.' + TIP_CLASS);
    if (!tip) return;
    // Only the live time while checked in ("In 02:18:37 Hrs"). Checked out
    // shows nothing custom: the native title ("Click to Check In") does.
    if (!isCheckedIn) {
      if (tip.innerHTML) tip.innerHTML = '';
      wrap.classList.remove('ci-tip-open');
      return;
    }
    // "In 01:47:26 Hrs": time since check-in, ticking every second.
    tip.classList.remove('ci-tip2');
    var since = checkInAt ? hms(Date.now() - checkInAt) : '--:--:--';
    var html = '<b>In</b><span class="hrms-ci-tip-time">' + since + '</span><b>Hrs</b>';
    if (tip.innerHTML !== html) tip.innerHTML = html;
  }
  function showTip(wrap) {
    if (!isCheckedIn) return;
    ensureTipStyle();
    wrap.classList.add('ci-tip-open');
    paintTip(wrap);
    clearInterval(tipTimer);
    tipTimer = setInterval(function () { paintTip(wrap); }, 1000);
  }
  function hideTip(wrap) {
    wrap.classList.remove('ci-tip-open');
    clearInterval(tipTimer);
    tipTimer = null;
  }

  /* ── build the toggle widget ─────────────────────────────────────────── */
  function buildWrapper() {
    var device  = getCheckinDevice();

    /* outer wrapper — flex row: [device-icon] [switch] */
    var wrap = document.createElement('div');
    wrap.id        = WRAPPER_ID;
    wrap.className = 'hrms-ci-wrap' + (isCheckedIn ? ' ci-active' : '');
    /* Gate the whole control — device icon and switch together — on the
       permission that governs check-in. hrms-perms.js hides any [data-perm]
       element the signed-in role lacks. Text-based gating cannot reach this
       control: it is a role="switch" whose label lives in aria-label, so its
       textContent is empty and the label matcher never fires. Fails open: if
       permissions cannot be loaded, nothing is hidden. */
    wrap.setAttribute('data-perm', 'attendance.checkinout');
    wrap.title = isCheckedIn ? '' : 'Click to Check In';

    /* device icon badge */
    var iconEl = document.createElement('span');
    iconEl.className = 'hrms-ci-icon';
    iconEl.innerHTML = deviceIcon(device);

    /* toggle pill */
    var toggle = document.createElement('button');
    toggle.id        = TOGGLE_ID;
    toggle.type      = 'button';
    toggle.className = 'hrms-ci-switch' + (isCheckedIn ? ' ci-on' : '');
    toggle.setAttribute('aria-label',   'Toggle Check In / Check Out');
    toggle.setAttribute('aria-pressed', isCheckedIn ? 'true' : 'false');
    toggle.setAttribute('role',         'switch');

    /* toggle knob */
    var knob = document.createElement('span');
    knob.className = 'hrms-ci-knob';
    toggle.appendChild(knob);

    /* Start measuring the moment someone approaches the toggle (hover, focus,
       touch), so the position is ready by the time they click. */
    ['pointerenter', 'focusin', 'touchstart'].forEach(function (ev) {
      wrap.addEventListener(ev, warmGeo, { passive: true });
    });

    /* click handler */
    wrap.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      handleToggle(wrap, toggle, iconEl);
    });

    wrap.appendChild(iconEl);
    wrap.appendChild(toggle);

    /* Hover / keyboard focus: when checked in, show the check-in time. */
    var tip = document.createElement('span');
    tip.className = TIP_CLASS;
    tip.setAttribute('role', 'tooltip');
    tip.id = 'hrms-ci-tip';
    wrap.appendChild(tip);
    toggle.setAttribute('aria-describedby', 'hrms-ci-tip');
    wrap.addEventListener('mouseenter', function () { showTip(wrap); });
    wrap.addEventListener('mouseleave', function () { hideTip(wrap); });
    toggle.addEventListener('focus', function () { showTip(wrap); });
    toggle.addEventListener('blur', function () { hideTip(wrap); });
    ensureTipStyle();

    return wrap;
  }

  // Geofencing is mandatory for every mode of work; the per-browser switch is
  // gone (the server ignores any bypass flag too).
  function isGeofenceEnabled() {
    return true;
  }

  function handleToggle(wrap, toggle, iconEl) {
    isCheckedIn = !isCheckedIn;
    var prevCheckInAt = checkInAt;
    checkInAt = isCheckedIn ? Date.now() : null;

    /* update device on check-in (re-detect each time so switching browsers
       is picked up on next check-in) */
    var device = detectDevice();
    if (isCheckedIn) {
      localStorage.setItem(STORAGE_DEVICE, device);
    }
    rememberState(isCheckedIn);

    refreshUI(wrap, toggle, iconEl, device);

    /* notify React / other scripts */
    window.dispatchEvent(new CustomEvent('hrmsCheckinToggle', {
      detail: { checkedIn: isCheckedIn, device: device }
    }));

    /* persist to the attendance backend. The toggle above is optimistic, so
       an off-site check-in the employee cancels — or any server refusal — has
       to be put back, otherwise the widget claims they are working when the
       server has no record of it. */
    var attempted = isCheckedIn;
    if (isCheckedIn && isGeofenceEnabled()) startGeoWatch(); else stopGeoWatch();
    syncAttendance(isCheckedIn, device).then(function (ok) {
      if (ok || isCheckedIn !== attempted) return;      // accepted, or toggled again meanwhile
      isCheckedIn = !attempted;
      checkInAt = isCheckedIn ? prevCheckInAt : null;
      rememberState(isCheckedIn);
      refreshUI(wrap, toggle, iconEl, device);
      window.dispatchEvent(new CustomEvent('hrmsCheckinToggle', {
        detail: { checkedIn: isCheckedIn, device: device }
      }));
      console.warn('[hrms-checkin] server refused — rolled back to', isCheckedIn);
    });

    console.log('[hrms-checkin] toggled →', { checkedIn: isCheckedIn, device: device });
  }

  function refreshUI(wrap, toggle, iconEl, device) {
    device = device || getCheckinDevice();

    if (isCheckedIn) {
      wrap.classList.add('ci-active');
      toggle.classList.add('ci-on');
      toggle.setAttribute('aria-pressed', 'true');
      wrap.title = '';                       // the hover card says it (with the check-in time)
    } else {
      wrap.classList.remove('ci-active');
      toggle.classList.remove('ci-on');
      toggle.setAttribute('aria-pressed', 'false');
      wrap.title = 'Click to Check In';
    }

    iconEl.innerHTML = deviceIcon(device);
    paintTip(wrap);
    if (isCheckedIn && wrap.matches && wrap.matches(':hover')) showTip(wrap);
    paintPendingBadge();
  }

  window.addEventListener('hrmsGeofenceSettingChange', function () {
    if (!isGeofenceEnabled()) stopGeoWatch();
    else if (isCheckedIn) startGeoWatch();
  });

  /* ── find insertion point (replace Settings gear OR insert after theme) ─ */
  function findSettingsBtn(topbar) {
    /* 1. Look for an <a> or <button> linking to /settings */
    var links = topbar.querySelectorAll('a[href*="settings"], button[data-route*="settings"]');
    if (links.length) return { el: links[0], mode: 'replace' };

    /* 2. Look for a gear / settings svg icon inside the topbar */
    var svgs = topbar.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      var parent = svgs[i].closest('a, button');
      if (parent) {
        var html = parent.innerHTML.toLowerCase();
        if (html.indexOf('settings') !== -1 || html.indexOf('gear') !== -1) {
          return { el: parent, mode: 'replace' };
        }
      }
    }

    /* 3. Fallback: insert after theme-toggle */
    var theme = document.getElementById('theme-toggle');
    if (theme) return { el: theme, mode: 'after' };

    /* 4. Last resort: before the avatar */
    var av = topbar.querySelector('.av, [class*="avatar"]');
    if (av) return { el: av, mode: 'before' };

    return null;
  }

  /* ── hide/remove Settings from topbar ───────────────────────────────── */
  function openSettingsRoute() {
    try {
      if (window.location.pathname === '/settings') {
        window.history.replaceState(null, '', '/settings');
        window.dispatchEvent(new CustomEvent('hrmsNavigate', { detail: { path: '/settings' } }));
        return;
      }
      window.history.pushState(null, '', '/settings');
      window.dispatchEvent(new CustomEvent('hrmsNavigate', { detail: { path: '/settings' } }));
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (_) {}
  }

  function wireSettingsFallback() {
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      // Never hijack clicks inside a form-builder or dialog overlay. A per-field
      // "Settings" (⚙) button there opens the field editor — it is NOT the app's
      // Settings navigation. Without this guard the greedy title-match below
      // swallowed the ⚙ click in BOTH the job and onboarding form builders.
      if (target.closest('.obf-ovl, .ocf-ovl, .obf-ed-ovl, .jfb-ovl, .pjf-ovl, .jfb-ed-ovl, [role="dialog"]')) return;
      var el = target.closest('a, button, div');
      if (!el) return;
      var text = (el.textContent || '').trim().toLowerCase();
      var title = (el.getAttribute && (el.getAttribute('title') || '').toLowerCase()) || '';
      var aria = (el.getAttribute && (el.getAttribute('aria-label') || '').toLowerCase()) || '';
      var href = (el.getAttribute && (el.getAttribute('href') || '').toLowerCase()) || '';
      var dataRoute = (el.getAttribute && (el.getAttribute('data-route') || '').toLowerCase()) || '';
      var isSettings = text === 'settings' || title.indexOf('setting') !== -1 || aria.indexOf('setting') !== -1 || href.indexOf('/settings') !== -1 || dataRoute.indexOf('/settings') !== -1 || href.indexOf('settings') !== -1;
      if (!isSettings) return;
      // A link to a page of its own under /settings/ (e.g. /settings/holidays,
      // served by hrms-sidecar.js) is real navigation, not the Settings button.
      var sc = window.HRMSSidecar;
      if (href.indexOf('/settings/') === 0 && sc && sc.has && sc.has(href.split('?')[0].split('#')[0])) return;
      e.preventDefault();
      e.stopPropagation();
      openSettingsRoute();
    }, true);
  }

  function hideSettings() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;

    /* 1. href-based: <a href="/settings"> */
    topbar.querySelectorAll('a[href*="settings"]').forEach(function (el) {
      el.style.display = 'none';
    });

    /* 2. title / aria-label containing "settings" (case-insensitive) */
    topbar.querySelectorAll('[title], [aria-label]').forEach(function (el) {
      var title = (el.getAttribute('title') || '').toLowerCase();
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (title.indexOf('setting') !== -1 || label.indexOf('setting') !== -1) {
        el.style.display = 'none';
      }
    });

    /* 3. SVG gear / cog icon detection inside topbar buttons/links */
    topbar.querySelectorAll('button, a').forEach(function (el) {
      var svgs = el.querySelectorAll('svg');
      svgs.forEach(function (svg) {
        var d = svg.innerHTML;
        /* Gear/cog paths typically contain many arcs; look for common gear
           path signatures (M12 or circle + multiple teeth patterns) */
        if (
          /M12[, ]2[ac]/i.test(d) ||
          /gear|cog|settings/i.test(d) ||
          (d.indexOf('rotate') !== -1 && d.indexOf('circle') !== -1)
        ) {
          el.style.display = 'none';
        }
      });
    });

    /* 4. Text-content check: button/link whose visible text is "Settings" */
    topbar.querySelectorAll('button, a, span').forEach(function (el) {
      if (el.children.length === 0 &&
          el.textContent.trim().toLowerCase() === 'settings') {
        var parent = el.closest('button, a') || el;
        parent.style.display = 'none';
      }
    });
  }

  /* ── main injection ──────────────────────────────────────────────────── */
  function ensureWidget() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;

    /* Always hide settings first */
    hideSettings();

    /* already injected? → just refresh state */
    var existingWrap   = document.getElementById(WRAPPER_ID);
    var existingToggle = document.getElementById(TOGGLE_ID);
    if (existingWrap && existingToggle) {
      var iconEl = existingWrap.querySelector('.hrms-ci-icon');
      refreshUI(existingWrap, existingToggle, iconEl);
      return;
    }

    var wrap = buildWrapper();

    var target = findSettingsBtn(topbar);
    if (!target) {
      /* Insert before avatar or append at end */
      var av = topbar.querySelector('.av, [class*="avatar"]');
      if (av) { topbar.insertBefore(wrap, av); }
      else     { topbar.appendChild(wrap); }
      return;
    }

    if (target.mode === 'replace') {
      /* hide the original settings element; insert our widget in its place */
      target.el.style.display = 'none';
      target.el.parentNode.insertBefore(wrap, target.el);
    } else if (target.mode === 'after') {
      var next = target.el.nextSibling;
      if (next) {
        target.el.parentNode.insertBefore(wrap, next);
      } else {
        target.el.parentNode.appendChild(wrap);
      }
    } else {
      target.el.parentNode.insertBefore(wrap, target.el);
    }
  }

  /* ── observe topbar for React re-renders ────────────────────────────── */
  function watchTopbar() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) {
      setTimeout(watchTopbar, 500);
      return;
    }

    ensureWidget();

    var obs = new MutationObserver(function () {
      /* Re-hide settings every time React re-renders the topbar */
      hideSettings();
      if (!document.getElementById(WRAPPER_ID)) {
        ensureWidget();
      }
    });
    obs.observe(topbar, { childList: true, subtree: true });
  }

  /* ── external API (for React context sync) ───────────────────────────── */
  window.addEventListener('hrmsContextUpdate', function (e) {
    if (e.detail && e.detail.checkedIn !== undefined) {
      isCheckedIn = !!e.detail.checkedIn;
      var wrap   = document.getElementById(WRAPPER_ID);
      var toggle = document.getElementById(TOGGLE_ID);
      if (wrap && toggle) {
        var iconEl = wrap.querySelector('.hrms-ci-icon');
        refreshUI(wrap, toggle, iconEl, e.detail.device);
      }
      /* React-origin toggle (employee Check-In/Out page) → persist attendance.
         Topbar toggles go through handleToggle instead, so this never double-fires. */
      if (!e.detail.fromTopbar) {
        var attempted = isCheckedIn;
        var dev = e.detail.device;
        if (isCheckedIn) startGeoWatch(); else stopGeoWatch();
        syncAttendance(isCheckedIn, dev).then(function (ok) {
          if (ok || isCheckedIn !== attempted) return;
          // Same rollback as the topbar toggle: the page has already painted
          // "Checked In", so put it back when the server would not take it.
          isCheckedIn = !attempted;
          rememberState(isCheckedIn);
          var w = document.getElementById(WRAPPER_ID);
          var t = document.getElementById(TOGGLE_ID);
          if (w && t) refreshUI(w, t, w.querySelector('.hrms-ci-icon'), dev);
          window.dispatchEvent(new CustomEvent('hrmsCheckinToggle', {
            detail: { checkedIn: isCheckedIn, device: dev }
          }));
          window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced', {
            detail: { checkedIn: isCheckedIn, record: null }
          }));
        });
      }
    }
  });

  /* ── registering a home address ───────────────────────────────────────
   *
   * The employee captures this themselves, standing in their own home — HR
   * cannot obtain an accurate position for everybody, and a rounded postal
   * address is hundreds of metres wide.
   *
   * It is inert until confirmed. The server only ever verifies against an
   * Approved row, so capturing the cafe you happen to be sitting in buys
   * nothing; it just gives a reviewer something obviously wrong to reject.
   *
   * Uses the same refining watch as check-in, and holds out for a genuinely
   * good fix: this pin is the basis for every future work-from-home check-in,
   * so a lazy ±800 m reading here would either wave through half the
   * neighbourhood or flag the person at their own desk every morning.
   */
  var HOME_TARGET_ACCURACY_M = 60;
  var STORAGE_HOME_ASKED = 'hrms_home_prompt_declined';

  /* Offer to register a home address, on the first work-from-home check-in
   * where none is on file.
   *
   * This moment is chosen because it is the only one where the employee is
   * provably standing in the place being registered — an HR screen weeks later
   * would capture wherever they happen to be sitting.
   *
   * It runs AFTER the check-in has succeeded and never blocks it. A prompt
   * that gated attendance on answering a question about your home address
   * would be coercive; this is an offer, and "Not now" is remembered so it is
   * not asked again on this device.
   */
  function offerHomeRegistration() {
    if (localStorage.getItem(STORAGE_HOME_ASKED) === '1') return;
    if (!navigator.geolocation) return;

    var back = document.createElement('div');
    back.setAttribute('style',
      'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.55);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;' +
      "font-family:'Segoe UI',Arial,sans-serif;");
    back.innerHTML =
      '<div style="background:var(--bg2,#fff);color:var(--text,#0f172a);border-radius:14px;max-width:440px;width:100%;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.25);padding:22px 24px;">' +
      '<div style="font-size:17px;font-weight:800;color:var(--text,#0f172a);margin-bottom:8px;">' +
      'Register your home address?</div>' +
      '<div style="font-size:13px;color:var(--text2,#475569);line-height:1.6;">' +
      'Your work-from-home days are recorded but cannot be confirmed, because we ' +
      'do not know where home is. Registering it once means future days confirm ' +
      'themselves.' +
      '<br><br><strong>Only do this while you are at home.</strong> Your manager ' +
      'confirms the location before it is used, and it is checked when you check ' +
      'in — not tracked during the day.' +
      '</div>' +
      '<div id="hrms-home-status" style="font-size:12px;color:var(--text3,#64748b);min-height:18px;' +
      'margin-top:12px;"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">' +
      '<button id="hrms-home-no" style="padding:9px 16px;border-radius:8px;' +
      'border:1px solid var(--border2,#cbd5e1);background:var(--bg3,#fff);color:var(--text,#334155);font-size:13px;' +
      'font-weight:600;cursor:pointer;">Not now</button>' +
      '<button id="hrms-home-go" style="padding:9px 16px;border-radius:8px;border:none;' +
      'background:#0f9d58;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">' +
      'Use my current position</button>' +
      '</div></div>';
    document.body.appendChild(back);

    var status = back.querySelector('#hrms-home-status');
    var go = back.querySelector('#hrms-home-go');
    function shut() { if (back.parentNode) back.parentNode.removeChild(back); }

    back.querySelector('#hrms-home-no').onclick = function () {
      localStorage.setItem(STORAGE_HOME_ASKED, '1');
      shut();
    };

    go.onclick = function () {
      go.disabled = true;
      status.textContent = 'Locating…';
      registerHome(function (fix) {
        status.textContent = 'Locating… ±' + Math.round(fix.accuracy) + ' m';
      }).then(function () {
        shut();
        notice('Home address registered',
          'Your manager will confirm it. Once confirmed, your work-from-home ' +
          'check-ins are verified automatically.');
      }).catch(function (e) {
        go.disabled = false;
        status.textContent = e.message || 'Could not read your position.';
      });
    };
  }

  function registerHome(onProgress) {
    var actor = getActor();
    if (!actor.email) return Promise.reject(new Error('Sign in first'));

    return getPosition(GEO_WAIT_CHECKIN_MS, onProgress).then(function (pos) {
      if (!pos) throw new Error('Could not read your position. Allow location ' +
                                'access and try again from your home.');
      if (pos.accuracy > HOME_TARGET_ACCURACY_M * 4) {
        throw new Error('Your position is only accurate to ±' +
          Math.round(pos.accuracy) + ' m — too vague to register as a home ' +
          'address. Try near a window or outside, ideally on a phone with GPS — or enter your ' +
          'latitude and longitude on My Profile › Work Setup.');
      }
      return fetch('/api/attendance/home-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: actor.email,
          latitude: pos.latitude,
          longitude: pos.longitude,
          accuracy: pos.accuracy
        })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + r.status));
          return d;
        });
      });
    });
  }

  window.__hrmsCheckinAPI = {
    isCheckedIn: function () { return !!isCheckedIn; },
    registerHome: registerHome,
    toggle: function (device) {
      if (device) localStorage.setItem(STORAGE_DEVICE, device);
      var wrap   = document.getElementById(WRAPPER_ID);
      var toggle = document.getElementById(TOGGLE_ID);
      if (wrap && toggle) {
        var iconEl = wrap.querySelector('.hrms-ci-icon');
        handleToggle(wrap, toggle, iconEl);
      }
    },
    setState: function (state, device) {
      isCheckedIn = !!state;
      rememberState(isCheckedIn);
      if (device) localStorage.setItem(STORAGE_DEVICE, device);
      var wrap   = document.getElementById(WRAPPER_ID);
      var toggle = document.getElementById(TOGGLE_ID);
      if (wrap && toggle) {
        var iconEl = wrap.querySelector('.hrms-ci-icon');
        refreshUI(wrap, toggle, iconEl, device);
      }
      paintState();
    },
    getState: function () {
      return { checkedIn: isCheckedIn, device: getCheckinDevice() };
    }
  };

  /* ── reconcile with the server ──────────────────────────────────────── */
  var lastSyncedFor = null;

  var missingEmailOnce = false;
  function syncFromServer(force) {
    var email = sessionEmail();
    if (!email) {
      if (!missingEmailOnce) { missingEmailOnce = true; return Promise.resolve(isCheckedIn); }
      if (isCheckedIn) { isCheckedIn = false; paintState(); }
      lastSyncedFor = null;
      return Promise.resolve(false);
    }
    missingEmailOnce = false;
    var key = email + '|' + todayStamp();
    if (!force && lastSyncedFor === key) {
      paintState();
      return Promise.resolve(isCheckedIn);
    }
    lastSyncedFor = key;

    return fetch('/api/attendance/today?email=' + encodeURIComponent(email), {
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return isCheckedIn;
        var truth = !!d.checkedIn;
        isCheckedIn = truth;
        checkInAt = (truth && d.checkIn) ? parseLocal(d.checkIn) : null;
        rememberState(truth);
        setRecheckinStatus(d.recheckinStatus || '');
        paintState();
        if (truth) ensureGeoWatch(); else stopGeoWatch();
        return truth;
      })
      .catch(function () {
        lastSyncedFor = null;
        paintState();
        return isCheckedIn;
      });
  }

  function paintState() {
    var wrap = document.getElementById(WRAPPER_ID);
    var toggle = document.getElementById(TOGGLE_ID);
    if (wrap && toggle) {
      refreshUI(wrap, toggle, wrap.querySelector('.hrms-ci-icon'), getCheckinDevice());
    }
    window.dispatchEvent(new CustomEvent('hrmsCheckinToggle', {
      detail: { checkedIn: isCheckedIn, device: getCheckinDevice() }
    }));
  }

  /* ── boot ────────────────────────────────────────────────────────────── */
  isCheckedIn = cachedState();

  function boot() {
    wireSettingsFallback();
    watchTopbar();
    syncFromServer(true);
    // Measure in the background (only if location is already allowed) so a
    // position is waiting when the employee reaches for the toggle.
    setTimeout(warmGeo, 1500);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) warmGeo(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Handle in-app route changes so newly mounted pages get the current attendance state
  window.addEventListener('popstate', function () {
    paintState();
    syncFromServer(false);
    warmGeo();
  });
  window.addEventListener('hrmsNavigate', function () {
    paintState();
    syncFromServer(false);
    warmGeo();
  });

  // Signing in or out happens without a reload in this app, so the session key
  // changing is the signal to re-ask. 'storage' covers other tabs; the poll
  // covers this one, where localStorage writes fire no event.
  window.addEventListener('storage', function (e) {
    if (e.key === 'hrms_session') syncFromServer(true);
  });
  var lastSeenEmail = sessionEmail();
  setInterval(function () {
    var now = sessionEmail();
    if (now !== lastSeenEmail) {
      lastSeenEmail = now;
      syncFromServer(true);
    }
  }, 2000);

  /* Switching between office and remote work mid-day is verified on the
     server against the right fence, so it needs a position too. The app's own
     Switch to Remote / Office buttons send only a label; attach the fix here. */
  (function () {
    var nf = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String((init && init.method) || 'GET').toUpperCase();
        if (method === 'POST' && /\/api\/attendance\/events(\?|$)/.test(url.replace(location.origin, '')) &&
            init && typeof init.body === 'string') {
          var body = JSON.parse(init.body || '{}');
          if ((body.event === 'remote-switch' || body.event === 'office-switch') && body.latitude == null) {
            return getPosition(undefined, undefined, { fast: true }).then(function (pos) {
              if (pos) { body.latitude = pos.latitude; body.longitude = pos.longitude; body.accuracy = pos.accuracy; }
              return nf(input, Object.assign({}, init, { body: JSON.stringify(body) }));
            }).then(function (resp) {
              if (!resp.ok) {
                resp.clone().json().then(function (d) {
                  if (d && d.message) notice(body.event === 'remote-switch' ? 'Cannot switch to remote' : 'Cannot switch to office', d.message);
                }).catch(function () {});
              }
              return resp;
            });
          }
        }
      } catch (_) { /* never break the app's own request */ }
      return nf(input, init);
    };
  })();

  // The check-in / check-out response carries the server-stamped time.
  window.addEventListener('hrmsAttendanceSynced', function (e) {
    var d = e && e.detail ? e.detail : {};
    var rec = d.record || {};
    if (d.checkedIn && rec.checkIn) checkInAt = parseLocal(rec.checkIn) || checkInAt;
    else if (d.checkedIn === false) checkInAt = null;
    paintTip();
  });

  console.log('[hrms-checkin v4] loaded — state:', isCheckedIn, '| device:', getCheckinDevice());
})();
