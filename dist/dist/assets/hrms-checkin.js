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

  /* ── initial state (restored from localStorage) ──────────────────────── */
  var isCheckedIn = localStorage.getItem(STORAGE_STATE) === 'true';

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
     Resolves to {latitude, longitude} or null. Never rejects: a denied prompt,
     a device without GPS and a timeout all mean "we cannot prove where you
     are", which the server treats the same as being outside the fence. */
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      try {
        navigator.geolocation.getCurrentPosition(
          function (p) {
            // accuracy travels with the fix: a WiFi/IP position can be a
            // kilometre out, and the server widens the fence by it rather than
            // calling someone at their desk off-site.
            finish({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy
            });
          },
          function () { finish(null); },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
        );
      } catch (_) { finish(null); }
      // Safari can leave the callback pending indefinitely when the permission
      // prompt is dismissed rather than answered.
      setTimeout(function () { finish(null); }, 9000);
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

    getPosition().then(function (pos) {
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
        localStorage.setItem(STORAGE_STATE, 'false');
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
      var mapBtn = (info.hasPosition && info.fenceLat != null)
        ? '<button id="hrms-geo-map" style="margin-top:12px;padding:7px 14px;border-radius:7px;' +
          'border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:12px;font-weight:600;' +
          'cursor:pointer;">View on map</button>'
        : '';
      back.innerHTML =
        '<div style="background:#fff;border-radius:14px;max-width:460px;width:100%;' +
        'box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden;">' +
        '<div style="padding:20px 24px 0;">' +
        '<div style="font-size:17px;font-weight:800;color:#0f172a;margin-bottom:8px;">' +
        (info.hasPosition ? 'You are outside the office location'
                          : 'We could not confirm your location') + '</div>' +
        '<div style="font-size:13px;color:#475569;line-height:1.6;">' + explain +
        '<br><br><strong>Your check-in will start once HR approves it.</strong>' +
        '</div>' + mapBtn +
        '<textarea id="hrms-geo-reason" rows="3" placeholder="e.g. Client visit in Bengaluru" ' +
        'style="width:100%;margin-top:14px;padding:10px 12px;border:1px solid #cbd5e1;' +
        'border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box;">' +
        '</textarea>' +
        '<div id="hrms-geo-err" style="color:#dc2626;font-size:12px;min-height:16px;margin-top:4px;"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;padding:8px 24px 20px;">' +
        '<button id="hrms-geo-cancel" style="padding:9px 18px;border-radius:8px;border:1px solid #e2e8f0;' +
        'background:#fff;color:#334155;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
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
     display real times. No-op when logged out.

     Resolves true when the server accepted it, false otherwise — the caller
     flips the toggle optimistically and needs to put it back on refusal. */
  function syncAttendance(checkedIn, device) {
    var actor = getActor();
    if (!actor.email) return Promise.resolve(false);
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
            if (r.status === 409 || d.code === 'LOCATION_APPROVAL_PENDING') {
              notice('Waiting for HR approval',
                d.message || 'Your off-site check-in is still awaiting approval.');
              return false;
            }

            if (r.status !== 422 || d.code !== 'LOCATION_REASON_REQUIRED') {
              console.warn('[hrms-checkin] attendance rejected', r.status, d);
              notice('Could not check in', d.message || ('Server returned ' + r.status));
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
      .catch(function (e) {
        console.warn('[hrms-checkin] attendance sync failed', e);
        return false;
      });
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
    localStorage.setItem(STORAGE_STATE, isCheckedIn ? 'true' : 'false');

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
      localStorage.setItem(STORAGE_STATE, isCheckedIn ? 'true' : 'false');
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
          localStorage.setItem(STORAGE_STATE, isCheckedIn ? 'true' : 'false');
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

  window.__hrmsCheckinAPI = {
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

  /* ── boot ────────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireSettingsFallback();
      watchTopbar();
    });
  } else {
    wireSettingsFallback();
    watchTopbar();
  }

  console.log('[hrms-checkin v3] loaded — state:', isCheckedIn, '| device:', getCheckinDevice());
})();
