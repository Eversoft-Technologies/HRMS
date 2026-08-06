/*
 * HRMS Attendance Administration — geofences, shifts and off-site reviews.
 *
 * The Django API for all three has existed for a while but nothing in the React
 * bundle ever called it: there was no way to define an office location, no way
 * to give anyone a shift other than the hard-coded "General Shift", and no way
 * to action an out-of-office check-in. This adds that surface as a sidecar, the
 * same pattern hrms-rbac.js and hrms-onboarding.js use, because the bundle's
 * source is not in this repository.
 *
 * Endpoints used (all already permission-gated server side):
 *   GET/POST         /api/attendance/geofences         + /<id> PUT|DELETE
 *   GET/POST         /api/shifts                       + /<id> PUT|DELETE
 *   GET/POST         /api/shift-assignments            + /<id> DELETE
 *   GET/POST         /api/attendance/location-reviews
 *
 * Mounted from a button on the attendance screens; hidden entirely from users
 * without attendance.edit, which is also what the server enforces.
 */
(function () {
  if (window.__hrmsAttendanceAdmin) return;
  window.__hrmsAttendanceAdmin = true;

  var BTN_ID = 'hrms-att-admin-btn';
  var OVERLAY_ID = 'hrms-att-admin-overlay';
  var state = { tab: 'fences', fences: [], shifts: [], assignments: [], reviews: [], busy: false };

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function can(code) {
    try { return !window.__hrmsCan || window.__hrmsCan(code); } catch (_) { return true; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + r.status));
          return d;
        });
      });
  }
  function toast(msg, bad) {
    var t = document.createElement('div');
    t.setAttribute('style',
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100002;' +
      'background:' + (bad ? '#dc2626' : '#0f9d58') + ';color:#fff;padding:11px 20px;' +
      "border-radius:9px;font:600 13px 'Segoe UI',Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 3200);
  }

  function injectStyle() {
    if (document.getElementById('hrms-att-admin-css')) return;
    var s = document.createElement('style');
    s.id = 'hrms-att-admin-css';
    s.textContent = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;',
      'border:1.5px solid var(--border,#e5e7eb);background:var(--card,#fff);color:var(--text1,#111);',
      'font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '#' + BTN_ID + ':hover{background:#0f9d58;color:#fff;border-color:#0f9d58}',
      '.haa-back{position:fixed;inset:0;z-index:100001;background:rgba(15,23,42,.55);display:flex;',
      "align-items:center;justify-content:center;padding:24px;font-family:'Segoe UI',Arial,sans-serif}",
      '.haa-panel{background:#fff;border-radius:14px;width:100%;max-width:940px;max-height:88vh;',
      'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.3)}',
      '.haa-head{padding:18px 24px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:14px}',
      '.haa-title{font-size:17px;font-weight:800;color:#0f172a;flex:1}',
      '.haa-tabs{display:flex;gap:6px;padding:12px 24px 0}',
      '.haa-tab{padding:7px 15px;border-radius:8px 8px 0 0;border:1px solid transparent;background:none;',
      'font-size:13px;font-weight:600;color:#64748b;cursor:pointer}',
      '.haa-tab.on{background:#f1f5f9;color:#0f172a;border-color:#e2e8f0;border-bottom-color:#f1f5f9}',
      '.haa-body{padding:18px 24px 24px;overflow:auto;flex:1;background:#f8fafc}',
      '.haa-tbl{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;',
      'border:1px solid #e2e8f0}',
      '.haa-tbl th{background:#f1f5f9;font-size:11px;text-transform:uppercase;letter-spacing:.5px;',
      'color:#64748b;text-align:left;padding:9px 12px}',
      '.haa-tbl td{padding:9px 12px;border-top:1px solid #f1f5f9;font-size:13px;color:#1e293b}',
      '.haa-in{padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;',
      'font-family:inherit;box-sizing:border-box;width:100%}',
      '.haa-btn{padding:8px 16px;border-radius:8px;border:none;background:#0f9d58;color:#fff;',
      'font-size:13px;font-weight:700;cursor:pointer}',
      '.haa-btn.sec{background:#fff;color:#334155;border:1px solid #e2e8f0}',
      '.haa-btn.dgr{background:#fee2e2;color:#b91c1c}',
      '.haa-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.haa-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px}',
      '.haa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.haa-lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;',
      'letter-spacing:.4px;display:block;margin-bottom:4px}',
      '.haa-empty{text-align:center;color:#94a3b8;padding:28px;font-size:13px}',
      '.haa-pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  function loadAll() {
    state.busy = true; render();
    return Promise.all([
      api('/api/attendance/geofences').catch(function () { return []; }),
      api('/api/shifts').catch(function () { return []; }),
      api('/api/shift-assignments').catch(function () { return []; }),
      api('/api/attendance/location-reviews?status=Pending').catch(function () { return []; })
    ]).then(function (r) {
      state.fences = Array.isArray(r[0]) ? r[0] : [];
      state.shifts = Array.isArray(r[1]) ? r[1] : [];
      state.assignments = Array.isArray(r[2]) ? r[2] : [];
      state.reviews = Array.isArray(r[3]) ? r[3] : [];
      state.busy = false; render();
    });
  }

  /* ── tab: geofences ──────────────────────────────────────────────────── */
  function fencesHtml() {
    var rows = state.fences.map(function (f) {
      return '<tr><td>' + esc(f.name) + '</td>' +
        '<td>' + esc(f.latitude) + ', ' + esc(f.longitude) + '</td>' +
        '<td>' + esc(f.radiusMeters || f.radius_meters || 0) + ' m</td>' +
        '<td><span class="haa-pill" style="background:' +
        ((f.isActive === false) ? '#fee2e2;color:#b91c1c' : '#dcfce7;color:#166534') + '">' +
        ((f.isActive === false) ? 'Inactive' : 'Active') + '</span></td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-fence="' + f.id + '">Delete</button></td></tr>';
    }).join('');
    return '' +
      '<div class="haa-card"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Add an office location</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">Name</label><input class="haa-in" id="haa-f-name" placeholder="Head Office"></div>' +
      '<div><label class="haa-lbl">Latitude</label><input class="haa-in" id="haa-f-lat" placeholder="17.4485"></div>' +
      '<div><label class="haa-lbl">Longitude</label><input class="haa-in" id="haa-f-lng" placeholder="78.3908"></div>' +
      '<div><label class="haa-lbl">Radius (m)</label><input class="haa-in" id="haa-f-rad" value="200"></div>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;">' +
      '<button class="haa-btn" id="haa-f-add">Add location</button>' +
      '<button class="haa-btn sec" id="haa-f-here">Use my current position</button>' +
      '<span style="font-size:12px;color:#64748b;">Employees outside every active location must give a reason.</span>' +
      '</div></div>' +
      (state.fences.length
        ? '<table class="haa-tbl"><thead><tr><th>Name</th><th>Centre</th><th>Radius</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="haa-empty">No office locations yet — geofencing stays off until you add one.</div>');
  }

  /* ── tab: shifts ─────────────────────────────────────────────────────── */
  function shiftsHtml() {
    var rows = state.shifts.map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td>' +
        '<td>' + esc(s.startTime || s.start_time || '') + ' – ' + esc(s.endTime || s.end_time || '') + '</td>' +
        '<td>' + esc(s.graceMinutes != null ? s.graceMinutes : s.grace_minutes) + ' min</td>' +
        '<td>' + Math.round((s.overtimeAfterMinutes != null ? s.overtimeAfterMinutes : s.overtime_after_minutes || 540) / 60) + ' h</td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-shift="' + s.id + '">Delete</button></td></tr>';
    }).join('');
    var opts = state.shifts.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
    var asg = state.assignments.map(function (a) {
      var sh = state.shifts.filter(function (s) { return s.id === (a.shiftId || a.shift); })[0];
      return '<tr><td>' + esc(a.email) + '</td><td>' + esc(sh ? sh.name : (a.shiftName || '—')) + '</td>' +
        '<td>' + esc(a.effectiveFrom || a.effective_from || '') + '</td>' +
        '<td>' + esc(a.effectiveTo || a.effective_to || 'open-ended') + '</td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-asg="' + a.id + '">Remove</button></td></tr>';
    }).join('');
    return '' +
      '<div class="haa-card"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Create a shift</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">Name</label><input class="haa-in" id="haa-s-name" placeholder="Morning Shift"></div>' +
      '<div><label class="haa-lbl">Start</label><input class="haa-in" id="haa-s-start" type="time" value="09:00"></div>' +
      '<div><label class="haa-lbl">End</label><input class="haa-in" id="haa-s-end" type="time" value="18:00"></div>' +
      '<div><label class="haa-lbl">Grace (min)</label><input class="haa-in" id="haa-s-grace" value="15"></div>' +
      '<div><label class="haa-lbl">Overtime after (h)</label><input class="haa-in" id="haa-s-ot" value="9"></div>' +
      '</div><div style="margin-top:12px"><button class="haa-btn" id="haa-s-add">Create shift</button></div></div>' +
      (state.shifts.length
        ? '<table class="haa-tbl"><thead><tr><th>Shift</th><th>Timing</th><th>Grace</th><th>OT after</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="haa-empty">No shifts defined — everyone falls back to General Shift (09:00–18:00).</div>') +
      '<div class="haa-card" style="margin-top:18px"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Assign a shift</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">Employee email</label><input class="haa-in" id="haa-a-email" placeholder="person@eversoftit.com"></div>' +
      '<div><label class="haa-lbl">Shift</label><select class="haa-in" id="haa-a-shift">' + opts + '</select></div>' +
      '<div><label class="haa-lbl">Effective from</label><input class="haa-in" id="haa-a-from" type="date"></div>' +
      '<div><label class="haa-lbl">Until (optional)</label><input class="haa-in" id="haa-a-to" type="date"></div>' +
      '</div><div style="margin-top:12px"><button class="haa-btn" id="haa-a-add"' +
      (state.shifts.length ? '' : ' disabled') + '>Assign</button></div></div>' +
      (state.assignments.length
        ? '<table class="haa-tbl"><thead><tr><th>Employee</th><th>Shift</th><th>From</th><th>Until</th><th></th></tr></thead><tbody>' + asg + '</tbody></table>'
        : '<div class="haa-empty">No individual assignments — everyone is on the default shift.</div>');
  }

  /* ── tab: off-site reviews ───────────────────────────────────────────── */
  function reviewsHtml() {
    if (!state.reviews.length) {
      return '<div class="haa-empty">Nothing waiting. Off-site check-ins appear here for approval.</div>';
    }
    var rows = state.reviews.map(function (r) {
      var map = (r.latitude != null && r.longitude != null)
        ? '<a href="https://maps.google.com/?q=' + r.latitude + ',' + r.longitude +
          '" target="_blank" rel="noopener" style="color:#2563eb;font-size:12px;">view map</a>'
        : '<span style="color:#94a3b8;font-size:12px;">no position</span>';
      return '<tr><td>' + esc(r.employee || r.email) + '<div style="font-size:11px;color:#64748b">' +
        esc(r.email) + '</div></td>' +
        '<td>' + esc(r.date || '') + '<div style="font-size:11px;color:#64748b">' +
        esc((r.checkIn || '').slice(11, 16)) + '</div></td>' +
        '<td style="max-width:260px">' + esc(r.reason || '') + '</td>' +
        '<td>' + map + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="haa-btn" data-ok="' + r.id + '">Approve</button> ' +
        '<button class="haa-btn dgr" data-no="' + r.id + '">Reject</button></td></tr>';
    }).join('');
    return '<table class="haa-tbl"><thead><tr><th>Employee</th><th>When</th><th>Reason</th><th>Location</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  function render() {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    var body = el.querySelector('.haa-body');
    var tabs = el.querySelectorAll('.haa-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = 'haa-tab' + (tabs[i].getAttribute('data-tab') === state.tab ? ' on' : '');
    }
    if (state.busy) { body.innerHTML = '<div class="haa-empty">Loading…</div>'; return; }
    body.innerHTML = state.tab === 'fences' ? fencesHtml()
      : state.tab === 'shifts' ? shiftsHtml() : reviewsHtml();
    wire(body);
  }

  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  function wire(body) {
    var add = body.querySelector('#haa-f-add');
    if (add) add.onclick = function () {
      var name = val('haa-f-name'), lat = parseFloat(val('haa-f-lat')), lng = parseFloat(val('haa-f-lng'));
      var rad = parseInt(val('haa-f-rad'), 10) || 200;
      if (!name || isNaN(lat) || isNaN(lng)) return toast('Name, latitude and longitude are required', true);
      api('/api/attendance/geofences', {
        method: 'POST',
        body: JSON.stringify({ name: name, latitude: lat, longitude: lng, radiusMeters: rad, radius_meters: rad })
      }).then(function () { toast('Location added'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    var here = body.querySelector('#haa-f-here');
    if (here) here.onclick = function () {
      if (!navigator.geolocation) return toast('This browser has no geolocation', true);
      here.disabled = true; here.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(function (p) {
        document.getElementById('haa-f-lat').value = p.coords.latitude.toFixed(6);
        document.getElementById('haa-f-lng').value = p.coords.longitude.toFixed(6);
        here.disabled = false; here.textContent = 'Use my current position';
      }, function () {
        here.disabled = false; here.textContent = 'Use my current position';
        toast('Could not read your position', true);
      }, { enableHighAccuracy: true, timeout: 8000 });
    };

    var sAdd = body.querySelector('#haa-s-add');
    if (sAdd) sAdd.onclick = function () {
      var name = val('haa-s-name');
      if (!name) return toast('Shift name is required', true);
      var otH = parseFloat(val('haa-s-ot')); if (isNaN(otH)) otH = 9;
      api('/api/shifts', {
        method: 'POST',
        body: JSON.stringify({
          name: name,
          startTime: val('haa-s-start') || '09:00', start_time: val('haa-s-start') || '09:00',
          endTime: val('haa-s-end') || '18:00', end_time: val('haa-s-end') || '18:00',
          graceMinutes: parseInt(val('haa-s-grace'), 10) || 15,
          grace_minutes: parseInt(val('haa-s-grace'), 10) || 15,
          overtimeAfterMinutes: Math.round(otH * 60), overtime_after_minutes: Math.round(otH * 60)
        })
      }).then(function () { toast('Shift created'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    var aAdd = body.querySelector('#haa-a-add');
    if (aAdd) aAdd.onclick = function () {
      var email = val('haa-a-email'), from = val('haa-a-from'), to = val('haa-a-to');
      var shiftId = parseInt(val('haa-a-shift'), 10);
      if (!email || !from || !shiftId) return toast('Employee, shift and start date are required', true);
      api('/api/shift-assignments', {
        method: 'POST',
        body: JSON.stringify({
          email: email, shift: shiftId, shiftId: shiftId,
          effectiveFrom: from, effective_from: from,
          effectiveTo: to || null, effective_to: to || null
        })
      }).then(function () { toast('Shift assigned'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    function bindDelete(attr, url, label) {
      var els = body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.onclick = function () {
            if (!window.confirm('Delete this ' + label + '?')) return;
            api(url + el.getAttribute(attr), { method: 'DELETE' })
              .then(function () { toast(label + ' deleted'); loadAll(); })
              .catch(function (e) { toast(e.message, true); });
          };
        })(els[i]);
      }
    }
    bindDelete('data-del-fence', '/api/attendance/geofences/', 'location');
    bindDelete('data-del-shift', '/api/shifts/', 'shift');
    bindDelete('data-del-asg', '/api/shift-assignments/', 'assignment');

    function decide(attr, decision) {
      var els = body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.onclick = function () {
            el.disabled = true;
            api('/api/attendance/location-reviews', {
              method: 'POST',
              body: JSON.stringify({ id: parseInt(el.getAttribute(attr), 10), decision: decision })
            }).then(function () { toast('Check-in ' + decision.toLowerCase()); loadAll(); })
              .catch(function (e) { el.disabled = false; toast(e.message, true); });
          };
        })(els[i]);
      }
    }
    decide('data-ok', 'Approved');
    decide('data-no', 'Rejected');
  }

  /* ── open / close ────────────────────────────────────────────────────── */
  function open() {
    if (document.getElementById(OVERLAY_ID)) return;
    injectStyle();
    var back = document.createElement('div');
    back.id = OVERLAY_ID;
    back.className = 'haa-back';
    back.innerHTML =
      '<div class="haa-panel">' +
      '<div class="haa-head"><div class="haa-title">Attendance Settings</div>' +
      '<button class="haa-btn sec" id="haa-close">Close</button></div>' +
      '<div class="haa-tabs">' +
      '<button class="haa-tab on" data-tab="fences">Office Locations</button>' +
      '<button class="haa-tab" data-tab="shifts">Shifts</button>' +
      '<button class="haa-tab" data-tab="reviews">Off-site Approvals</button>' +
      '</div><div class="haa-body"></div></div>';
    document.body.appendChild(back);

    back.querySelector('#haa-close').onclick = close;
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    var tabs = back.querySelectorAll('.haa-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.onclick = function () { state.tab = t.getAttribute('data-tab'); render(); };
      })(tabs[i]);
    }
    loadAll();
  }
  function close() {
    var el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  window.__hrmsOpenAttendanceAdmin = open;

  /* ── mount ───────────────────────────────────────────────────────────── */
  function onAttendancePage() {
    return /attendance|check-?in|employees/i.test(location.pathname + location.hash);
  }

  function mount() {
    var existing = document.getElementById(BTN_ID);
    if (!onAttendancePage() || !can('attendance.edit')) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) {
      if (existing.getAttribute('data-home') === 'anchored') return;
      var home = findAnchor();
      if (home && home.parentNode) {
        home.parentNode.insertBefore(existing, home.nextSibling);
        existing.setAttribute('data-home', 'anchored');
      }
      return;
    }
    injectStyle();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="8" cy="7" r="2.2"/><path d="M8 1.5c2.5 0 4.5 2 4.5 4.5 0 3.2-4.5 8.5-4.5 8.5S3.5 9.2 3.5 6c0-2.5 2-4.5 4.5-4.5z"/>' +
      '</svg>Attendance Settings';
    btn.onclick = function (e) { e.stopPropagation(); open(); };

    var anchor = findAnchor();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      btn.setAttribute('data-home', 'anchored');
      return;
    }
    var card = document.querySelector('.page-header, .card');
    if (card) card.appendChild(btn);
  }

  /* Sit next to the page's own Filters control when there is one — same idea
     as the KPI button on the recruitment screens. */
  function findAnchor() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (buttons[i].id !== BTN_ID && label === 'Filters') return buttons[i];
    }
    return null;
  }

  function boot() {
    mount();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; mount(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', mount);
    window.addEventListener('hrmsPermsLoaded', mount);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
