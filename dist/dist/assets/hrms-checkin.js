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
      var c = JSON.parse(localStorage.getItem(STORAGE_STATE) || 'null');
      if (!c || typeof c !== 'object') return false;   // legacy 'true'/'false': distrust
      if (c.email !== sessionEmail()) return false;
      if (c.date !== todayStamp()) return false;
      return !!c.checkedIn;
    } catch (_) { return false; }
  }

  function rememberState(v) {
    try {
      localStorage.setItem(STORAGE_STATE, JSON.stringify({
        email: sessionEmail(), date: todayStamp(), checkedIn: !!v
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

  function getPosition(budgetMs, onProgress) {
    var budget = budgetMs || GEO_WAIT_CHECKIN_MS;
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var best = null, id = null, timer = null, done = false;

      function finish() {
        if (done) return;
        done = true;
        try { if (id !== null) navigator.geolocation.clearWatch(id); } catch (_) {}
        if (timer) clearTimeout(timer);
        resolve(best);
      }

      // Also covers Safari leaving the callbacks pending indefinitely when the
      // permission prompt is dismissed rather than answered.
      timer = setTimeout(finish, budget + 1000);

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
   * Samples the position on a timer and checks out when the employee has
   * clearly left the geofence.
   *
   * What this genuinely cannot do, so nobody plans around it: browsers only
   * run timers while the page is open, and throttle or suspend them when the
   * tab is hidden or the machine sleeps. Closing the laptop does not trigger a
   * checkout — the tab is gone. So treat this as a convenience for people who
   * leave with the tab open, not as an authoritative record of departure. The
   * shift-end sweep is what actually catches forgotten sessions.
   *
   * Safeguards, because a wrong auto-checkout silently costs someone hours:
   *   - two consecutive out-of-fence samples, never a single reading
   *   - the fix's own accuracy widens the fence, exactly as check-in does
   *   - a poor fix (worse than the tolerance) is discarded, not acted on
   *   - never for someone working from home
   *   - the employee is warned on the first miss, before anything happens
   */
  var GEO_WATCH_MS = 5 * 60 * 1000;      // sample every 5 minutes
  var GEO_STRIKES = 2;                   // consecutive misses before acting
  var geoWatch = { timer: null, strikes: 0, warned: false };

  function stopGeoWatch() {
    if (geoWatch.timer) clearInterval(geoWatch.timer);
    geoWatch.timer = null; geoWatch.strikes = 0; geoWatch.warned = false;
  }

  function startGeoWatch() {
    stopGeoWatch();
    if (!navigator.geolocation) return;
    geoWatch.timer = setInterval(sampleGeo, GEO_WATCH_MS);
  }

  function sampleGeo() {
    if (!isCheckedIn) { stopGeoWatch(); return; }
    if (document.hidden) return;                    // timers are throttled anyway
    var actor = getActor();
    if (!actor.email) return;

    getPosition(GEO_WAIT_SAMPLE_MS).then(function (pos) {
      if (!pos) return;                             // no fix: say nothing, do nothing
      fetch('/api/attendance/geofence-check?latitude=' + pos.latitude +
            '&longitude=' + pos.longitude +
            (pos.accuracy ? '&accuracy=' + pos.accuracy : ''), {
        headers: { 'Content-Type': 'application/json' }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || d.enforced === false || d.wfh) { stopGeoWatch(); return; }
          if (d.inside || d.uncertain) { geoWatch.strikes = 0; geoWatch.warned = false; return; }

          geoWatch.strikes++;
          if (geoWatch.strikes === 1) {
            geoWatch.warned = true;
            notice('You have left the office area',
              'You are about ' + Math.round(d.distance || 0) + ' m from ' +
              (d.fence || 'the office') + '. If you stay away you will be checked out ' +
              'automatically at the next check.');
            return;
          }
          if (geoWatch.strikes >= GEO_STRIKES) autoCheckOut(d);
        })
        .catch(function () { /* a failed check must never close someone's day */ });
    });
  }

  function autoCheckOut(d) {
    stopGeoWatch();
    var actor = getActor();
    fetch('/api/attendance/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: actor.email, auto: 'geofence' })
    })
      .then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
      .then(function (record) {
        if (!record) return;
        isCheckedIn = false;
        rememberState(false);
        var w = document.getElementById(WRAPPER_ID), t = document.getElementById(TOGGLE_ID);
        if (w && t) refreshUI(w, t, w.querySelector('.hrms-ci-icon'), getCheckinDevice());
        window.dispatchEvent(new CustomEvent('hrmsCheckinToggle',
          { detail: { checkedIn: false, device: getCheckinDevice() } }));
        window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced',
          { detail: { checkedIn: false, record: record } }));
        notice('Checked out automatically',
          'You left ' + (d.fence || 'the office') + '. Check in again when you return.');
      })
      .catch(function () {});
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
    setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
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

  /* Records the check-in / check-out against the Django attendance API.
     Auth + actor headers are attached automatically by hrms-actor.js. Fires
     'hrmsAttendanceSynced' with the saved record so the check-in page can
     display real times. No-op when logged out. */
  function syncAttendance(checkedIn, device) {
    var actor = getActor();
    if (!actor.email) return;
    var path = checkedIn ? '/api/attendance/check-in' : '/api/attendance/check-out';

    function post(extra) {
      var body = checkedIn
        ? { email: actor.email, device: device || detectDevice(), employee: actor.name }
        : { email: actor.email };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          // Checked in from home with no home address on file. Offered after
          // the check-in has already succeeded, so declining costs nothing.
          if (record && record.homeLocationMissing) {
            setTimeout(offerHomeRegistration, 400);   // let the toggle settle first
          }
          return true;
        });
    }

    // Only a check-in is location-checked; checking out never is.
    return (checkedIn ? getPosition() : Promise.resolve(null))
      .then(function (pos) {
        return post(pos || {}).then(function (r) {
          if (r.ok) return settle(r);
          return r.json().catch(function () { return {}; }).then(function (d) {
            d = d || {};

            // Already waiting on HR from an earlier attempt today.
            // The toggle and the server disagreed about whether a session was
            // open. Whatever caused the drift — a stale tab, a reload during
            // the reason dialog, a second device — arguing with the user about
            // it is useless; re-ask the server and show the truth.
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
      .catch(function (e) { console.warn('[hrms-checkin] attendance sync failed', e); });
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

  /* ── build the toggle widget ─────────────────────────────────────────── */
  function buildWrapper() {
    var device  = getCheckinDevice();

    /* outer wrapper — flex row: [device-icon] [switch] */
    var wrap = document.createElement('div');
    wrap.id        = WRAPPER_ID;
    wrap.className = 'hrms-ci-wrap' + (isCheckedIn ? ' ci-active' : '');
    wrap.title     = isCheckedIn ? 'Checked In — click to Check Out' : 'Click to Check In';

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

    /* click handler */
    wrap.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      handleToggle(wrap, toggle, iconEl);
    });

    wrap.appendChild(iconEl);
    wrap.appendChild(toggle);

    return wrap;
  }

  function handleToggle(wrap, toggle, iconEl) {
    isCheckedIn = !isCheckedIn;

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
    if (isCheckedIn) startGeoWatch(); else stopGeoWatch();
    syncAttendance(isCheckedIn, device).then(function (ok) {
      if (ok || isCheckedIn !== attempted) return;      // accepted, or toggled again meanwhile
      isCheckedIn = !attempted;
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
      wrap.title = 'Checked In — click to Check Out';
    } else {
      wrap.classList.remove('ci-active');
      toggle.classList.remove('ci-on');
      toggle.setAttribute('aria-pressed', 'false');
      wrap.title = 'Click to Check In';
    }

    iconEl.innerHTML = deviceIcon(device);
  }

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
      // Remembered, so someone who works from home daily is not asked daily.
      // Clearing site data resets it, which is the intended escape hatch.
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
    if (!actor.email) return Promise.reject(new Error('You are not signed in'));
    if (!navigator.geolocation) return Promise.reject(new Error('This browser has no geolocation'));

    return getPosition(GEO_WAIT_CHECKIN_MS, onProgress).then(function (pos) {
      if (!pos) throw new Error('Could not read your position. Allow location ' +
                                'access and try again from your home.');
      if (pos.accuracy > HOME_TARGET_ACCURACY_M * 4) {
        // Refuse here rather than let the server do it, so the message can say
        // what to change instead of just reporting a number back.
        throw new Error('Your position is only accurate to ±' +
          Math.round(pos.accuracy) + ' m — too vague to register as a home ' +
          'address. Try near a window or outside, ideally on a phone with GPS.');
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
    /* The live, server-synced answer to "am I checked in?".
       Published because the cache under hrms_checked_in is a first-paint hint
       in a shape only this module knows, and readers were parsing it wrong. */
    isCheckedIn: function () { return !!isCheckedIn; },
    /* Exposed so the attendance screen can offer "Set my home location".
       Resolves with the saved (Pending) record. */
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
      if (device) localStorage.setItem(STORAGE_DEVICE, device);
      var wrap   = document.getElementById(WRAPPER_ID);
      var toggle = document.getElementById(TOGGLE_ID);
      if (wrap && toggle) {
        var iconEl = wrap.querySelector('.hrms-ci-icon');
        refreshUI(wrap, toggle, iconEl, device);
      }
    },
    getState: function () {
      return { checkedIn: isCheckedIn, device: getCheckinDevice() };
    }
  };

  /* ── reconcile with the server ────────────────────────────────────────
   *
   * The widget had no idea what the server thought. It rendered whatever
   * localStorage said and only ever found out it was wrong by attempting an
   * impossible transition and being refused — which is what "No check-in
   * found for today" was: the toggle offering a check-out for a session that
   * did not exist.
   *
   * Asks once per session change. Cheap, and it is the only thing that makes
   * the toggle trustworthy on a shared browser or the morning after.
   */
  var lastSyncedFor = null;

  function syncFromServer(force) {
    var email = sessionEmail();
    if (!email) {
      // Signed out: never keep showing the previous person's state.
      if (isCheckedIn) { isCheckedIn = false; paintState(); }
      lastSyncedFor = null;
      return Promise.resolve(false);
    }
    var key = email + '|' + todayStamp();
    if (!force && lastSyncedFor === key) return Promise.resolve(isCheckedIn);
    lastSyncedFor = key;

    return fetch('/api/attendance/today?email=' + encodeURIComponent(email), {
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return isCheckedIn;
        var truth = !!d.checkedIn;
        if (truth !== isCheckedIn) {
          console.log('[hrms-checkin] state corrected from server:',
                      isCheckedIn, '->', truth);
          isCheckedIn = truth;
          paintState();
        }
        rememberState(truth);
        if (truth) startGeoWatch(); else stopGeoWatch();
        return truth;
      })
      .catch(function () {
        // Offline or the endpoint is down. Leave the cached hint in place
        // rather than guessing — but allow a retry on the next trigger.
        lastSyncedFor = null;
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

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

  console.log('[hrms-checkin v3] loaded — state:', isCheckedIn, '| device:', getCheckinDevice());
})();
