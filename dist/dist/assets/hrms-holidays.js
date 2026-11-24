/**
 * hrms-holidays.js  v1
 * Holiday Calendars admin page — /settings/holidays (Attendance Phase 1 / H).
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): renders into the sidecar's
 * own root; React-owned DOM is never touched, moved or removed.
 *
 * Backend: api/attendance_ext/holiday_views.py
 *   GET/POST          /api/holiday-calendars
 *   GET/PATCH/DELETE  /api/holiday-calendars/<id>
 *   GET/POST          /api/holiday-calendars/<id>/days?year=
 *   PATCH/DELETE      /api/holiday-calendars/<id>/days/<dayId>
 *   POST              /api/holiday-calendars/<id>/import   {csv, replace, dryRun}
 *   GET/POST          /api/holiday-calendars/assignments   {calendarId|null, emails | location}
 *
 * settings.manage edits; settings.view reads everything; anyone else sees
 * only their own calendar, read-only. The employee-side Leave page reads
 * GET /api/holidays, which now returns the caller's own calendar.
 */
(function () {
  'use strict';
  if (window.__hrmsHolidaysLoaded) return;
  window.__hrmsHolidaysLoaded = true;

  var BASE = '/settings/holidays';
  var STYLE_ID = 'hrms-hc-style';
  var SC = null;
  var COUNTRIES = { IN: 'India', US: 'USA' };
  var S = {
    root: null, token: 0, cals: [], canManage: false, canRead: false, configured: false, unassigned: 0,
    sel: null, year: new Date().getFullYear(), tab: 'days', days: null, assign: null,
    q: '', fcal: '', picked: {}, msg: null
  };

  function esc(s) { return SC.esc(s); }
  function api(u, o) { return SC.api(u, o); }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v); } catch (_) {}
    return String(v);
  }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function wday(iso) { var p = String(iso).split('-'); return WD[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]; }
  function isWeekend(iso) { var w = wday(iso); return w === 'Sat' || w === 'Sun'; }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.hc-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.hc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.hc-h1{font-size:20px;font-weight:700;margin:0}',
      '.hc-sub{font-size:13px;color:var(--text2);margin-top:4px;max-width:760px;line-height:1.5}',
      '.hc-grid{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;align-items:start}',
      '@media (max-width:900px){.hc-grid{grid-template-columns:1fr}}',
      '.hc-list{display:flex;flex-direction:column;gap:8px}',
      '.hc-cal{display:block;width:100%;text-align:left;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;color:var(--text);font-family:inherit}',
      '.hc-cal:hover{border-color:var(--accent)}',
      '.hc-cal.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}',
      '.hc-cal.off{opacity:.6}',
      '.hc-cal b{display:block;font-size:14px;margin-bottom:6px}',
      '.hc-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--text2)}',
      '.hc-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.hc-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.hc-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}',
      '.hc-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}',
      '.hc-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.hc-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border)}',
      '.hc-panel{padding:18px}',
      '.hc-ptitle{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px}',
      '.hc-ptitle h2{margin:0;font-size:17px}',
      '.hc-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:6px 0 14px;flex-wrap:wrap}',
      '.hc-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;font-family:inherit;margin-bottom:-1px}',
      '.hc-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.hc-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
      '.hc-bar .input-field{width:auto;min-width:120px;padding:7px 10px}',
      '.hc-bar .hc-grow{flex:1;min-width:180px}',
      '.hc-yr{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:14px}',
      '.hc-nav{width:28px;height:28px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);color:var(--text);cursor:pointer;font-size:16px;line-height:1;font-family:inherit}',
      '.hc-wrap{overflow-x:auto}',
      '.hc-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.hc-table th{text-align:left;font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.7px;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}',
      '.hc-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.hc-table tr.hc-x td{opacity:.55}',
      '.hc-table tr.hc-x .hc-name{text-decoration:line-through}',
      '.hc-name{font-weight:600}',
      '.hc-muted{color:var(--text2)}',
      '.hc-nowrap{white-space:nowrap}',
      '.hc-act{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}',
      '.hc-link{background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.hc-link:hover{border-color:var(--accent);color:var(--accent)}',
      '.hc-link.hc-danger:hover{border-color:var(--danger);color:var(--danger)}',
      '.hc-add{display:grid;grid-template-columns:150px minmax(0,1fr) auto auto;gap:8px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px dashed var(--border)}',
      '@media (max-width:640px){.hc-add{grid-template-columns:1fr 1fr}.hc-add .hc-grow{grid-column:1 / -1}}',
      '.hc-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text);cursor:pointer;user-select:none;white-space:nowrap}',
      '.hc-empty{padding:28px 10px;text-align:center;color:var(--text2);font-size:13px}',
      '.hc-err{padding:10px 12px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px;white-space:pre-wrap}',
      '.hc-ok{padding:10px 12px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 11%,transparent);font-size:13px;margin-bottom:12px}',
      '.hc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}',
      '.hc-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--bg3);border:1px solid var(--border);font-size:12px;color:var(--text);cursor:pointer;font-family:inherit}',
      '.hc-chip.on{border-color:var(--accent);color:var(--accent)}',
      '.hc-chip b{font-weight:700}',
      '.hc-chip button{background:none;border:none;color:var(--text2);cursor:pointer;font-size:14px;line-height:1;padding:0}',
      '.hc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.hc-modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:100%;max-width:560px;padding:22px;color:var(--text);max-height:90vh;overflow:auto}',
      '.hc-modal h3{margin:0 0 16px;font-size:16px}',
      '.hc-field{margin-bottom:12px}',
      '.hc-field>label{display:block;font-size:11px;font-weight:700;color:var(--text2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.hc-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '@media (max-width:520px){.hc-row2{grid-template-columns:1fr}}',
      '.hc-hint{font-size:11.5px;color:var(--text2);margin-top:4px;line-height:1.45}',
      '.hc-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:16px}',
      '.hc-ghost{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.hc-ghost:hover{border-color:var(--accent)}',
      '.hc-busy{opacity:.6;pointer-events:none}',
      '.hc-modal textarea{min-height:160px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;resize:vertical}',
      '.hc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}',
      '.hc-kpi{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 12px}',
      '.hc-kpi span{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px}',
      '.hc-kpi b{display:block;font-size:20px;margin-top:2px}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function badge(t, cls) { return '<span class="hc-badge ' + (cls || 'hc-c-muted') + '">' + esc(t) + '</span>'; }
  function selCal() { for (var i = 0; i < S.cals.length; i++) if (S.cals[i].id === S.sel) return S.cals[i]; return null; }
  function flash(kind, text) { S.msg = { kind: kind, text: text }; }

  /* ── data ──────────────────────────────────────────────────────────────── */
  function load(keepSel) {
    var tok = ++S.token;
    return api('/api/holiday-calendars').then(function (d) {
      if (tok !== S.token || !S.root) return;
      S.cals = d.calendars || [];
      S.canManage = !!d.canManage;
      S.canRead = d.mine === undefined;      // settings readers get the full list
      S.configured = !!d.configured;
      S.unassigned = d.unassigned || 0;
      if (!keepSel || !selCal()) S.sel = S.cals.length ? (d.mine || S.cals[0].id) : null;
      if (!S.canRead && S.tab === 'assign') S.tab = 'days';
      if (!S.cals.length && S.canRead) S.tab = 'assign';
      paint();
      return loadTab();
    }).catch(function (e) {
      if (tok !== S.token || !S.root) return;
      S.root.innerHTML = '<div class="hc-page"><div class="hc-err">' + esc(e.message || 'Could not load holiday calendars.') + '</div></div>';
    });
  }
  function loadTab() {
    var tok = S.token;
    if (S.tab === 'assign') {
      S.assign = null; paintBody();
      return api('/api/holiday-calendars/assignments').then(function (d) {
        if (tok !== S.token || !S.root) return; S.assign = d; paintBody();
      }).catch(function (e) { if (tok === S.token) { S.assign = { error: e.message }; paintBody(); } });
    }
    if (!S.sel) { S.days = null; paintBody(); return Promise.resolve(); }
    S.days = null; paintBody();
    return api('/api/holiday-calendars/' + S.sel + '/days?year=' + S.year).then(function (d) {
      if (tok !== S.token || !S.root) return; S.days = d; paintBody();
    }).catch(function (e) { if (tok === S.token) { S.days = { error: e.message }; paintBody(); } });
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  function paint() {
    var r = S.root; if (!r) return;
    var h = '<div class="hc-page">';
    h += '<div class="hc-head"><div><h1 class="hc-h1">Holiday Calendars</h1>' +
      '<div class="hc-sub">Each employee follows one calendar — by explicit assignment, else by their profile location, else the default. ' +
      'A holiday on an employee’s own calendar is a paid day off: it never counts as absent or Loss of Pay. Optional holidays are listed but are not days off.' +
      (S.canRead && !S.configured ? '<br><b>No calendar is active yet</b> — everyone sees the India + US national list and holidays do not affect attendance or payroll until you create one.' : '') +
      '</div></div>';
    if (S.canManage) h += '<button type="button" class="btn-primary btn-sm" data-act="new">+ New calendar</button>';
    h += '</div>';
    h += '<div data-hc="msg"></div>';
    if (!S.cals.length) {
      h += '<div class="card hc-panel"><div class="hc-empty">' + (S.canRead ? 'No holiday calendars yet.' + (S.canManage ? ' Create one to start (e.g. “India”, country IN, default).' : '') : 'You are not on a holiday calendar; the Leave page shows the national holidays.') + '</div></div>';
      if (S.canRead) h += '<div style="margin-top:16px" data-hc="body"></div>';
      h += '</div>';
      r.innerHTML = h;
      paintMsg();
      if (S.canRead && S.tab === 'assign') paintBody();
      return;
    }
    h += '<div class="hc-grid"><div class="hc-list">';
    S.cals.forEach(function (c) {
      h += '<button type="button" class="hc-cal' + (c.id === S.sel ? ' on' : '') + (c.isActive ? '' : ' off') + '" data-act="pick" data-id="' + c.id + '">' +
        '<b>' + esc(c.name) + '</b><div class="hc-meta">' +
        badge(COUNTRIES[c.country] || c.country, c.country === 'US' ? 'hc-c-accent' : 'hc-c-warn') +
        (c.isDefault ? badge('Default', 'hc-c-success') : '') + (c.isActive ? '' : badge('Inactive', 'hc-c-muted')) +
        (S.canRead ? '<span>' + c.employeeCount + ' employee' + (c.employeeCount === 1 ? '' : 's') + '</span>' : '') +
        '<span>· ' + c.dayCount + ' own day' + (c.dayCount === 1 ? '' : 's') + '</span></div>' +
        (c.region ? '<div class="hc-meta" style="margin-top:4px">' + esc(c.region) + '</div>' : '') + '</button>';
    });
    if (S.canRead && S.unassigned) h += '<div class="hc-meta" style="padding:4px 2px">' + S.unassigned + ' employee' + (S.unassigned === 1 ? '' : 's') + ' on no calendar (national list, no days off)</div>';
    h += '</div><div class="card hc-panel" data-hc="panel"></div></div></div>';
    r.innerHTML = h;
    paintMsg();
    paintPanel();
  }
  function paintMsg() {
    var m = S.root && S.root.querySelector('[data-hc="msg"]');
    if (!m) return;
    m.innerHTML = S.msg ? '<div class="' + (S.msg.kind === 'ok' ? 'hc-ok' : 'hc-err') + '">' + esc(S.msg.text) + '</div>' : '';
  }
  function paintPanel() {
    var p = S.root && S.root.querySelector('[data-hc="panel"]');
    if (!p) return;
    var c = selCal();
    var h = '';
    if (c) {
      h += '<div class="hc-ptitle"><div><h2>' + esc(c.name) + '</h2><div class="hc-meta" style="margin-top:6px">' +
        badge(COUNTRIES[c.country] || c.country, c.country === 'US' ? 'hc-c-accent' : 'hc-c-warn') +
        (c.includeNational ? badge('National holidays included', 'hc-c-muted') : badge('Own days only', 'hc-c-muted')) +
        (c.isDefault ? badge('Default', 'hc-c-success') : '') + (c.isActive ? '' : badge('Inactive', 'hc-c-muted')) +
        (c.locations && c.locations.length ? '<span>Locations: ' + c.locations.map(esc).join(', ') + '</span>' : '') +
        '</div></div>';
      if (S.canManage) h += '<div class="hc-act"><button type="button" class="hc-link" data-act="edit">Edit</button>' +
        '<button type="button" class="hc-link" data-act="import">Import CSV</button>' +
        '<button type="button" class="hc-link hc-danger" data-act="delcal">Delete</button></div>';
      h += '</div>';
    }
    h += '<div class="hc-tabs">' +
      (c ? '<button type="button" class="hc-tab' + (S.tab === 'days' ? ' on' : '') + '" data-act="tab" data-tab="days">Holidays</button>' : '') +
      (S.canRead ? '<button type="button" class="hc-tab' + (S.tab === 'assign' ? ' on' : '') + '" data-act="tab" data-tab="assign">Employees &amp; assignments</button>' : '') +
      '</div><div data-hc="body"></div>';
    p.innerHTML = h;
    paintBody();
  }
  function paintBody() {
    var b = S.root && S.root.querySelector('[data-hc="body"]');
    if (!b) return;
    b.innerHTML = S.tab === 'assign' ? assignHtml() : daysHtml();
  }

  function daysHtml() {
    var h = '<div class="hc-bar"><span class="hc-yr"><button type="button" class="hc-nav" data-act="yr" data-d="-1" aria-label="Previous year">‹</button>' +
      S.year + '<button type="button" class="hc-nav" data-act="yr" data-d="1" aria-label="Next year">›</button></span></div>';
    var d = S.days;
    if (!d) return h + '<div class="hc-empty">Loading…</div>';
    if (d.error) return h + '<div class="hc-err">' + esc(d.error) + '</div>';
    var rows = [];
    (d.national || []).forEach(function (n) { rows.push({ kind: 'nat', date: n.date, name: n.name, type: n.type, excluded: !!n.excluded, inactive: !!n.inactive }); });
    (d.days || []).forEach(function (x) {
      if (x.exclude) return;      // shown as the struck-through national row
      rows.push({ kind: 'own', id: x.id, date: x.date, name: x.name, optional: x.optional });
    });
    var exRows = (d.days || []).filter(function (x) { return x.exclude; });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === 'nat' ? -1 : 1); });
    h += '<div class="hc-wrap"><table class="hc-table"><thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Kind</th><th></th></tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="5"><div class="hc-empty">No holidays in ' + S.year + '.</div></td></tr>';
    rows.forEach(function (r) {
      var kind, act = '';
      if (r.kind === 'nat') {
        kind = r.inactive ? badge('National (not applied)', 'hc-c-muted') : r.excluded ? badge('National — excluded', 'hc-c-danger') : badge('National', 'hc-c-warn');
        if (S.canManage && !r.inactive) {
          if (r.excluded) {
            var ex = exRows.filter(function (x) { return x.date === r.date; })[0];
            if (ex) act = '<button type="button" class="hc-link" data-act="unexclude" data-id="' + ex.id + '">Include again</button>';
          } else {
            act = '<button type="button" class="hc-link" data-act="exclude" data-date="' + esc(r.date) + '" data-name="' + esc(r.name) + '">Exclude</button>';
          }
        }
      } else {
        kind = r.optional ? badge('Optional', 'hc-c-accent') : badge('Company holiday', 'hc-c-success');
        if (S.canManage) act = '<button type="button" class="hc-link" data-act="editday" data-id="' + r.id + '">Edit</button>' +
          '<button type="button" class="hc-link hc-danger" data-act="delday" data-id="' + r.id + '">Delete</button>';
      }
      h += '<tr class="' + (r.excluded || r.inactive ? 'hc-x' : '') + '"><td class="hc-nowrap">' + esc(fmtDate(r.date)) + '</td>' +
        '<td class="hc-muted hc-nowrap">' + wday(r.date) + (isWeekend(r.date) ? ' · weekend' : '') + '</td>' +
        '<td class="hc-name">' + esc(r.name) + '</td><td>' + kind + '</td><td><div class="hc-act">' + act + '</div></td></tr>';
    });
    h += '</tbody></table></div>';
    if (S.canManage) {
      h += '<form class="hc-add" data-hc="addday"><input class="input-field" type="date" name="date" required min="' + S.year + '-01-01" max="' + S.year + '-12-31">' +
        '<input class="input-field hc-grow" name="name" maxlength="160" placeholder="Holiday name (e.g. Bonalu)" required>' +
        '<label class="hc-check"><input type="checkbox" name="optional"> Optional</label>' +
        '<button type="submit" class="btn-primary btn-sm">Add holiday</button></form>';
    }
    return h;
  }

  function assignHtml() {
    var a = S.assign;
    if (!a) return '<div class="hc-empty">Loading…</div>';
    if (a.error) return '<div class="hc-err">' + esc(a.error) + '</div>';
    var h = '<div class="hc-kpis">';
    (a.perCalendar || []).forEach(function (p) {
      h += '<div class="hc-kpi"><span>' + esc(p.calendar || 'No calendar') + '</span><b>' + p.employees + '</b>' +
        '<div class="hc-hint">' + (p.calendarId ? p.assigned + ' assigned explicitly' + (p.isActive ? '' : ' · inactive') : 'national list, no days off') + '</div></div>';
    });
    h += '</div>';
    var emps = (a.employees || []).filter(function (e) {
      if (S.fcal === 'none' && e.calendarId) return false;
      if (S.fcal && S.fcal !== 'none' && String(e.calendarId) !== S.fcal) return false;
      if (!S.q) return true;
      var q = S.q.toLowerCase();
      return (e.name + ' ' + e.email + ' ' + e.location + ' ' + (e.department || '')).toLowerCase().indexOf(q) !== -1;
    });
    var opts = S.cals.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + (c.isActive ? '' : ' (inactive)') + '</option>'; }).join('');
    h += '<div class="hc-bar"><input class="input-field hc-grow" data-hc="q" placeholder="Search name, email, location…" value="' + esc(S.q) + '">' +
      '<select class="input-field" data-hc="fcal"><option value="">All calendars</option>' +
      S.cals.map(function (c) { return '<option value="' + c.id + '"' + (String(c.id) === S.fcal ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
      '<option value="none"' + (S.fcal === 'none' ? ' selected' : '') + '>No calendar</option></select></div>';
    if (S.canManage) {
      var n = Object.keys(S.picked).length;
      h += '<div class="hc-bar"><select class="input-field" data-hc="tocal"><option value="">— Remove assignment —</option>' + opts + '</select>' +
        '<button type="button" class="btn-primary btn-sm" data-act="assignsel"' + (n ? '' : ' disabled') + '>Assign ' + n + ' selected</button>' +
        '<select class="input-field" data-hc="loc"><option value="">By location…</option>' +
        (a.locations || []).map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="hc-ghost" data-act="assignloc">Assign location</button></div>' +
        '<div class="hc-hint" style="margin:-4px 0 10px">Explicit assignments win over location matches. “Remove assignment” returns people to their location / default calendar.</div>';
    }
    h += '<div class="hc-wrap"><table class="hc-table"><thead><tr>' +
      (S.canManage ? '<th><input type="checkbox" data-hc="all" aria-label="Select all shown"></th>' : '') +
      '<th>Employee</th><th>Location</th><th>Calendar</th><th>Via</th></tr></thead><tbody>';
    if (!emps.length) h += '<tr><td colspan="5"><div class="hc-empty">No employees match.</div></td></tr>';
    var VIA = { assignment: ['Assigned', 'hc-c-accent'], location: ['Location', 'hc-c-warn'], 'default': ['Default', 'hc-c-success'], none: ['—', 'hc-c-muted'] };
    emps.forEach(function (e) {
      var v = VIA[e.via] || VIA.none;
      h += '<tr>' + (S.canManage ? '<td><input type="checkbox" data-hc="pick" data-email="' + esc(e.email) + '"' + (S.picked[e.email] ? ' checked' : '') + ' aria-label="Select ' + esc(e.name) + '"></td>' : '') +
        '<td><div class="hc-name">' + esc(e.name) + '</div><div class="hc-muted" style="font-size:12px">' + esc(e.email) + '</div></td>' +
        '<td>' + (e.location ? esc(e.location) : '<span class="hc-muted">—</span>') + '</td>' +
        '<td>' + (e.calendar ? esc(e.calendar) : '<span class="hc-muted">None</span>') + '</td>' +
        '<td>' + badge(v[0], v[1]) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  /* ── modals ────────────────────────────────────────────────────────────── */
  function modal(html, onReady) {
    var ov = document.createElement('div');
    ov.className = 'hc-overlay';
    ov.innerHTML = '<div class="hc-modal" role="dialog" aria-modal="true">' + html + '</div>';
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov || (e.target.getAttribute && e.target.getAttribute('data-close') !== null)) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);     // our own node on <body>, never inside React's tree
    onReady(ov.querySelector('.hc-modal'), close);
  }

  function calModal(c) {
    var locs = (c && c.locations ? c.locations.slice() : []);
    var known = (S.assign && S.assign.locations) || [];
    var country = c ? c.country : 'IN';
    var other = country !== 'IN' && country !== 'US';
    var h = '<h3>' + (c ? 'Edit calendar' : 'New holiday calendar') + '</h3><form data-hc="calform">' +
      '<div class="hc-field"><label>Name</label><input class="input-field" name="name" maxlength="120" required value="' + esc(c ? c.name : '') + '" placeholder="e.g. Hyderabad Tech Hub"></div>' +
      '<div class="hc-row2"><div class="hc-field"><label>Country</label><select class="input-field" name="country">' +
      '<option value="IN"' + (country === 'IN' ? ' selected' : '') + '>India (IN)</option><option value="US"' + (country === 'US' ? ' selected' : '') + '>United States (US)</option>' +
      '<option value="OTHER"' + (other ? ' selected' : '') + '>Other…</option></select>' +
      '<input class="input-field" name="countryOther" maxlength="2" placeholder="2-letter code" style="margin-top:6px;' + (other ? '' : 'display:none') + '" value="' + esc(other ? country : '') + '"></div>' +
      '<div class="hc-field"><label>Region</label><input class="input-field" name="region" maxlength="120" value="' + esc(c ? c.region : '') + '" placeholder="e.g. Telangana"></div></div>' +
      '<div class="hc-field"><label>Locations</label><div class="hc-chips" data-hc="chips"></div>' +
      '<input class="input-field" data-hc="locin" list="hc-loc-list" placeholder="Type a profile location and press Enter">' +
      '<datalist id="hc-loc-list">' + known.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>' +
      '<div class="hc-hint">Employees whose profile location matches (case-insensitive) follow this calendar unless assigned elsewhere.</div></div>' +
      '<div class="hc-field"><label class="hc-check"><input type="checkbox" name="includeNational"' + (!c || c.includeNational ? ' checked' : '') + '> Include national holidays of the country</label>' +
      '<div class="hc-hint">India: national + gazetted festivals. USA: federal holidays. Individual ones can be excluded later.</div></div>' +
      '<div class="hc-field"><label class="hc-check"><input type="checkbox" name="isDefault"' + (c && c.isDefault ? ' checked' : '') + '> Default calendar (everyone not matched otherwise)</label></div>' +
      (c ? '<div class="hc-field"><label class="hc-check"><input type="checkbox" name="isActive"' + (c.isActive ? ' checked' : '') + '> Active</label></div>' : '') +
      '<div data-hc="merr"></div><div class="hc-btns"><button type="button" class="hc-ghost" data-close>Cancel</button><button type="submit" class="btn-primary btn-sm">' + (c ? 'Save' : 'Create') + '</button></div></form>';
    modal(h, function (m, close) {
      var form = m.querySelector('form');
      function chips() {
        m.querySelector('[data-hc="chips"]').innerHTML = locs.length ? locs.map(function (l, i) {
          return '<span class="hc-chip">' + esc(l) + '<button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(l) + '">×</button></span>';
        }).join('') : '<span class="hc-hint">No locations.</span>';
      }
      function addLoc(v) {
        String(v || '').split(',').forEach(function (x) {
          x = x.trim();
          if (x && !locs.some(function (l) { return l.toLowerCase() === x.toLowerCase(); })) locs.push(x);
        });
        chips();
      }
      chips();
      var inp = m.querySelector('[data-hc="locin"]');
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLoc(inp.value); inp.value = ''; } });
      inp.addEventListener('change', function () { if (inp.value) { addLoc(inp.value); inp.value = ''; } });
      m.querySelector('[data-hc="chips"]').addEventListener('click', function (e) {
        var i = e.target.getAttribute && e.target.getAttribute('data-rm');
        if (i !== null && i !== undefined) { locs.splice(+i, 1); chips(); }
      });
      form.country.addEventListener('change', function () { form.countryOther.style.display = form.country.value === 'OTHER' ? '' : 'none'; });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (inp.value) { addLoc(inp.value); inp.value = ''; }
        var body = {
          name: form.elements['name'].value.trim(), region: form.region.value.trim(),
          country: form.country.value === 'OTHER' ? form.countryOther.value.trim().toUpperCase() : form.country.value,
          includeNational: form.includeNational.checked, isDefault: form.isDefault.checked, locations: locs
        };
        if (form.isActive) body.isActive = form.isActive.checked;
        m.classList.add('hc-busy');
        api(c ? '/api/holiday-calendars/' + c.id : '/api/holiday-calendars', { method: c ? 'PATCH' : 'POST', body: body }).then(function (d) {
          close();
          S.sel = d.id;
          flash('ok', c ? 'Calendar saved.' : 'Calendar created.');
          load(true);
        }).catch(function (err) {
          m.classList.remove('hc-busy');
          m.querySelector('[data-hc="merr"]').innerHTML = '<div class="hc-err">' + esc(err.message) + '</div>';
        });
      });
    });
  }

  function dayModal(day) {
    var h = '<h3>Edit holiday</h3><form><div class="hc-row2"><div class="hc-field"><label>Date</label><input class="input-field" type="date" name="date" required value="' + esc(day.date) + '"></div>' +
      '<div class="hc-field"><label>Name</label><input class="input-field" name="name" maxlength="160" required value="' + esc(day.name) + '"></div></div>' +
      '<div class="hc-field"><label class="hc-check"><input type="checkbox" name="optional"' + (day.optional ? ' checked' : '') + '> Optional (listed, not a day off)</label></div>' +
      '<div data-hc="merr"></div><div class="hc-btns"><button type="button" class="hc-ghost" data-close>Cancel</button><button type="submit" class="btn-primary btn-sm">Save</button></div></form>';
    modal(h, function (m, close) {
      var f = m.querySelector('form');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        m.classList.add('hc-busy');
        api('/api/holiday-calendars/' + S.sel + '/days/' + day.id, { method: 'PATCH', body: { date: f.date.value, name: f.elements['name'].value.trim(), optional: f.optional.checked } })
          .then(function () { close(); refreshDays(); })
          .catch(function (err) { m.classList.remove('hc-busy'); m.querySelector('[data-hc="merr"]').innerHTML = '<div class="hc-err">' + esc(err.message) + '</div>'; });
      });
    });
  }

  function importModal() {
    var c = selCal(); if (!c) return;
    var h = '<h3>Import holidays into “' + esc(c.name) + '”</h3>' +
      '<div class="hc-hint" style="margin-bottom:10px">One holiday per line: <code>date,name,optional</code>. Date as YYYY-MM-DD (or DD/MM/YYYY); optional is yes/no and may be left out. A header line, blank lines and # comments are ignored. Any bad line rejects the whole file.</div>' +
      '<form><div class="hc-field"><textarea class="input-field" name="csv" placeholder="date,name,optional&#10;' + S.year + '-01-14,Sankranti,no&#10;' + S.year + '-07-20,Bonalu,yes"></textarea></div>' +
      '<div class="hc-field"><input type="file" accept=".csv,text/csv,text/plain" data-hc="file" class="input-field"></div>' +
      '<label class="hc-check"><input type="checkbox" name="replace"> Replace this calendar’s own holidays in the years the file covers</label>' +
      '<div data-hc="merr" style="margin-top:10px"></div><div class="hc-btns"><button type="button" class="hc-ghost" data-close>Cancel</button>' +
      '<button type="button" class="hc-ghost" data-hc="check">Validate</button><button type="submit" class="btn-primary btn-sm">Import</button></div></form>';
    modal(h, function (m, close) {
      var f = m.querySelector('form'), out = m.querySelector('[data-hc="merr"]');
      m.querySelector('[data-hc="file"]').addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0]; if (!file) return;
        var rd = new FileReader();
        rd.onload = function () { f.csv.value = String(rd.result || ''); };
        rd.readAsText(file);
      });
      function send(dry) {
        m.classList.add('hc-busy');
        out.innerHTML = '';
        api('/api/holiday-calendars/' + c.id + '/import', { method: 'POST', body: { csv: f.csv.value, replace: f.replace.checked, dryRun: dry } }).then(function (d) {
          m.classList.remove('hc-busy');
          if (dry) { out.innerHTML = '<div class="hc-ok">' + d.valid + ' line' + (d.valid === 1 ? '' : 's') + ' look good.</div>'; return; }
          close();
          flash('ok', 'Imported: ' + d.created + ' added, ' + d.updated + ' updated' + (d.removed ? ', ' + d.removed + ' replaced' : '') + '.');
          load(true);
        }).catch(function (err) {
          m.classList.remove('hc-busy');
          var lines = (err.data && err.data.errors || []).map(function (x) { return (x.line ? 'Line ' + x.line + ': ' : '') + x.error; });
          out.innerHTML = '<div class="hc-err">' + esc(err.message + (lines.length ? '\n' + lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n…' : '') : '')) + '</div>';
        });
      }
      m.querySelector('[data-hc="check"]').addEventListener('click', function () { send(true); });
      f.addEventListener('submit', function (e) { e.preventDefault(); send(false); });
    });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  function refreshDays() { load(true); }
  function fail(e) { flash('err', e.message || 'Something went wrong.'); paintMsg(); }

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !S.root || !S.root.contains(t)) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (act !== 'tab' && act !== 'pick' && act !== 'yr') { S.msg = null; paintMsg(); }
    if (act === 'new') calModal(null);
    else if (act === 'edit') calModal(selCal());
    else if (act === 'import') importModal();
    else if (act === 'pick') { S.sel = +id; if (S.tab !== 'assign') S.tab = 'days'; paint(); loadTab(); }
    else if (act === 'tab') { S.tab = t.getAttribute('data-tab'); paintPanel(); if (!S.root.querySelector('[data-hc="panel"]')) paintBody(); loadTab(); }
    else if (act === 'yr') { S.year += +t.getAttribute('data-d'); loadTab(); }
    else if (act === 'delcal') {
      var c = selCal();
      if (!c || !window.confirm('Delete “' + c.name + '” with its holidays and assignments? Employees fall back to their location / default calendar.')) return;
      api('/api/holiday-calendars/' + c.id, { method: 'DELETE' }).then(function () { S.sel = null; flash('ok', 'Calendar deleted.'); load(false); }).catch(fail);
    } else if (act === 'exclude') {
      api('/api/holiday-calendars/' + S.sel + '/days', { method: 'POST', body: { date: t.getAttribute('data-date'), name: t.getAttribute('data-name'), exclude: true } }).then(refreshDays).catch(fail);
    } else if (act === 'unexclude' || act === 'delday') {
      if (act === 'delday' && !window.confirm('Delete this holiday?')) return;
      api('/api/holiday-calendars/' + S.sel + '/days/' + id, { method: 'DELETE' }).then(refreshDays).catch(fail);
    } else if (act === 'editday') {
      var day = ((S.days && S.days.days) || []).filter(function (x) { return String(x.id) === id; })[0];
      if (day) dayModal(day);
    } else if (act === 'assignsel' || act === 'assignloc') {
      var to = S.root.querySelector('[data-hc="tocal"]').value;
      var body = { calendarId: to ? +to : null };
      if (act === 'assignsel') body.emails = Object.keys(S.picked);
      else {
        body.location = S.root.querySelector('[data-hc="loc"]').value;
        if (!body.location) { flash('err', 'Pick a location first.'); paintMsg(); return; }
      }
      api('/api/holiday-calendars/assignments', { method: 'POST', body: body }).then(function (d) {
        S.picked = {};
        flash('ok', (to ? 'Assigned ' : 'Cleared assignment for ') + d.emails.length + ' employee' + (d.emails.length === 1 ? '' : 's') +
          (d.unknown && d.unknown.length ? ' (unknown: ' + d.unknown.join(', ') + ')' : '') + '.');
        load(true);
      }).catch(fail);
    }
  }
  function onChange(e) {
    var t = e.target; if (!t || !S.root || !S.root.contains(t)) return;
    var k = t.getAttribute && t.getAttribute('data-hc');
    if (k === 'pick') { if (t.checked) S.picked[t.getAttribute('data-email')] = 1; else delete S.picked[t.getAttribute('data-email')]; paintBodyKeep(); }
    else if (k === 'all') {
      S.root.querySelectorAll('[data-hc="pick"]').forEach(function (cb) { if (t.checked) S.picked[cb.getAttribute('data-email')] = 1; else delete S.picked[cb.getAttribute('data-email')]; });
      paintBodyKeep();
    } else if (k === 'fcal') { S.fcal = t.value; paintBodyKeep(); }
  }
  /* Re-render the assignments body but keep the bulk-action selects. */
  function paintBodyKeep() {
    var to = S.root.querySelector('[data-hc="tocal"]'), loc = S.root.querySelector('[data-hc="loc"]');
    var tv = to ? to.value : '', lv = loc ? loc.value : '';
    paintBody();
    to = S.root.querySelector('[data-hc="tocal"]'); loc = S.root.querySelector('[data-hc="loc"]');
    if (to) to.value = tv; if (loc) loc.value = lv;
  }
  var qTimer = null;
  function onInput(e) {
    var t = e.target; if (!t || !S.root || !S.root.contains(t)) return;
    if (t.getAttribute && t.getAttribute('data-hc') === 'q') {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () {
        S.q = t.value; paintBodyKeep();
        var q = S.root && S.root.querySelector('[data-hc="q"]');
        if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }, 200);
    }
  }
  function onSubmit(e) {
    var f = e.target; if (!f || !S.root || !S.root.contains(f) || f.getAttribute('data-hc') !== 'addday') return;
    e.preventDefault();
    S.msg = null; paintMsg();
    f.classList.add('hc-busy');
    api('/api/holiday-calendars/' + S.sel + '/days', { method: 'POST', body: { date: f.date.value, name: f.elements['name'].value.trim(), optional: f.optional.checked } })
      .then(function () { flash('ok', 'Holiday added.'); refreshDays(); })
      .catch(function (err) { f.classList.remove('hc-busy'); fail(err); });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function mount(root) {
    S.root = root;
    S.msg = null; S.picked = {}; S.days = null; S.assign = null;
    injectStyle();
    root.innerHTML = '<div class="hc-page"><div class="hc-empty">Loading holiday calendars…</div></div>';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', onSubmit);
    load(false);
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE,
      title: 'Holiday Calendars',
      mount: mount,
      update: function () {},
      unmount: function () { S.token++; S.root = null; clearTimeout(qTimer); }
    });
  }

  if (window.HRMSSidecar) register();
  else {
    var tries = 0;
    var iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); }
      else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
