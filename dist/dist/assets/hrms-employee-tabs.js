/**
 * hrms-employee-tabs.js
 * ---------------------------------------------------------------------------
 * Shared per-employee module tabs — Attendance, Check In / Out, Tasks, Work
 * Submissions and Leave — rendered for ONE email from the existing list APIs:
 *
 *   GET /api/attendance/summary/?email=&fromDate=&toDate=
 *   GET /api/attendance/day-detail?email=&date=
 *   GET /api/attendance/location-punch?email=&date=
 *   GET /api/tasks?assigneeEmail=
 *   GET /api/submissions?email=
 *   GET /api/leave?email=            GET /api/leave/balance?email=
 *
 * First consumer: the Employee Profile page (hrms-hris.js). The F2F interview
 * popup (hrms-f2f-employee-detail.js) still carries its own copy of these
 * renderers and can be switched over to this module in a later pass.
 *
 * Usage
 *   HRMSEmployeeTabs.render('attendance', containerEl, ctx)
 * where ctx = { email: 'a@b.com', state: {} }. The renderers keep their
 * filters and loaded rows in ctx.state, so pass the same ctx for every tab of
 * one employee. HRMSEmployeeTabs.reset(ctx) drops the cached rows (e.g. after
 * a live update) while keeping the user's filters.
 *
 * Every query is scoped to the container (no document-wide ids), so two
 * consumers can be on screen at once without clashing. No bundle rebuild.
 */
(function () {
  'use strict';
  if (window.HRMSEmployeeTabs) return;

  var STYLE_ID = 'hrms-employee-tabs-style';

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(p) {
    return fetch(p, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }
  function initials(n) {
    var s = String(n || '').trim();
    if (!s) return '?';
    var p = s.split(/[\s._-]+/).filter(Boolean);
    return ((p[0] || '')[0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '');
  }
  function fmtMins(m) { m = Math.max(0, m || 0); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  // Date format from Settings > General (hrms-company.js); raw when it is not loaded.
  function fmtDate(v) { return (v && window.HRMSCompany) ? window.HRMSCompany.date(v) : (v || ''); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return isoDate(new Date()); }
  function rangeFor(key, cfrom, cto) {
    if (key === 'custom') { return { from: cfrom || todayIso(), to: cto || todayIso() }; }
    var to = new Date(), from = new Date();
    if (key === 'month') { from = new Date(to.getFullYear(), to.getMonth(), 1); }
    else { var n = ({ '7': 7, '30': 30, '60': 60, '90': 90 })[key] || parseInt(key, 10) || 30; from.setDate(from.getDate() - (n - 1)); }
    return { from: isoDate(from), to: isoDate(to) };
  }
  var RANGE_LABEL = { '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 2 months', '90': 'Last 3 months', 'month': 'This month' };

  /* Attendance % the way the F2F popup and the profile strip both compute it:
     present and late count as a day, half-day as half, absent as nothing. */
  function attendancePct(sum) {
    if (!sum) return null;
    var denom = (sum.present || 0) + (sum.late || 0) + (sum.absent || 0) + (sum.half_day || 0);
    if (!denom) return null;
    var got = (sum.present || 0) + (sum.late || 0) + 0.5 * (sum.half_day || 0);
    return Math.round(got / denom * 100);
  }

  function selOpts(name, val, opts) {
    return '<select class="het-filter" data-het="' + esc(name) + '">' + opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function rangeControls(prefix, val, cfrom, cto, withAll) {
    var opts = [];
    if (withAll) opts.push(['all', 'All time']);
    opts.push(['7', 'Last 7 days'], ['30', 'Last 30 days'], ['60', 'Last 2 months'], ['90', 'Last 3 months'], ['month', 'This month'], ['custom', 'Custom']);
    var html = selOpts(prefix + '-range', val, opts);
    if (val === 'custom') {
      html += '<input type="date" class="het-filter" data-het="' + prefix + '-from" value="' + esc(cfrom || '') + '" max="' + todayIso() + '">' +
              '<input type="date" class="het-filter" data-het="' + prefix + '-to" value="' + esc(cto || todayIso()) + '" max="' + todayIso() + '">';
    }
    return html;
  }
  function filterBar(inner) { return '<div class="het-filters">' + inner + '</div>'; }
  function loading(what) { return '<div class="het-loading">Loading ' + esc(what) + '…</div>'; }
  function empty(msg) { return '<div class="het-empty">' + esc(msg) + '</div>'; }
  function denied(err, what) {
    if (err && err.status === 403) return '<div class="het-empty">You do not have access to this employee\'s ' + esc(what) + '.</div>';
    return '<div class="het-empty">' + esc((err && err.message) || ('Could not load ' + what + '.')) + '</div>';
  }
  function q(box, name) { return box.querySelector('[data-het="' + name + '"]'); }
  function on(box, name, handler) { var el = q(box, name); if (el) el.onchange = handler; }
  function cls(st) { return String(st || '').toLowerCase().replace(/\s+/g, ''); }

  /* Re-render only if the container is still showing this tab (the user may
     have switched tabs while a request was in flight). */
  function settle(box, ctx, tab) {
    if (box.getAttribute('data-het-tab') === tab) render(tab, box, ctx);
  }

  /* ── styles (theme variables with light fallbacks) ─────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.het{color:var(--text,#0f172a);font-size:13px;}',
      '.het-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}',
      '.het-filter{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:8px;color:var(--text,#0f172a);font:inherit;font-size:12px;font-weight:600;padding:6px 9px;cursor:pointer;}',
      '.het-filter:focus{border-color:var(--accent,#4f8ef7);outline:none;}',
      '.het-loading,.het-empty{color:var(--text3,#64748b);font-size:13px;text-align:center;padding:28px 10px;}',
      '.het-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);margin:14px 0 8px;display:flex;align-items:center;gap:8px;}',
      '.het-sec:first-child{margin-top:0;}',
      '.het-pctwrap{display:flex;align-items:center;gap:16px;margin-bottom:14px;}',
      '.het-ring{width:92px;height:92px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;}',
      '.het-ring>div{width:70px;height:70px;border-radius:50%;background:var(--bg2,#fff);display:flex;align-items:center;justify-content:center;}',
      '.het-ring span{font-size:20px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-ringlbl{font-size:12px;color:var(--text3,#64748b);}',
      '.het-cv{font-size:17px;font-weight:800;color:var(--text,#0f172a);margin-top:2px;}',
      '.het-cl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);}',
      '.het-break{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:6px 0 4px;}',
      '.het-bk{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:10px 8px;text-align:center;}',
      '.het-bk b{display:block;font-size:18px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-bk small{font-size:10.5px;color:var(--text3,#64748b);text-transform:uppercase;letter-spacing:.3px;}',
      '.het-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}',
      '.het-tile{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.het-hrs{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--text3,#64748b);margin-bottom:12px;align-items:center;}',
      '.het-hrs b{color:var(--text,#0f172a);}',
      '.het-pill{display:inline-block;font-size:10.5px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:capitalize;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.het-pill.present,.het-pill.online,.het-pill.approved,.het-pill.completed,.het-pill.done,.het-pill.paid{background:rgba(34,197,94,.16);color:var(--success,#16a34a);}',
      '.het-pill.late,.het-pill.pending,.het-pill.inprogress{background:rgba(247,201,79,.18);color:var(--warn,#b7791f);}',
      '.het-pill.absent,.het-pill.offline,.het-pill.rejected{background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-pill.inreview,.het-pill.review{background:rgba(79,142,247,.16);color:var(--accent,#2563eb);}',
      '.het-log{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:8px 2px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.het-log:last-child{border-bottom:none;}',
      '.het-lt{font-weight:700;color:var(--text,#0f172a);white-space:nowrap;}',
      '.het-le{color:var(--text2,#475569);}',
      '.het-ll{color:var(--text3,#64748b);font-size:11px;text-align:right;}',
      '.het-ll a{color:var(--accent,#4f8ef7);text-decoration:none;font-weight:600;}',
      '.het-pipe{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;align-items:start;}',
      '.het-col{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:8px;}',
      '.het-colh{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:2px 4px;}',
      '.het-colh span{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:999px;padding:0 7px;font-size:10.5px;color:var(--text2,#475569);}',
      '.het-card{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:9px 10px;margin-bottom:8px;}',
      '.het-ct{font-size:12.5px;font-weight:700;color:var(--text,#0f172a);line-height:1.3;}',
      '.het-cmeta{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap;font-size:10.5px;color:var(--text3,#64748b);}',
      '.het-prio{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:999px;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.het-prio.high{background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-prio.medium{background:rgba(247,201,79,.18);color:var(--warn,#b7791f);}',
      '.het-prio.low{background:rgba(34,197,94,.16);color:var(--success,#16a34a);}',
      '.het-rej{font-size:9.5px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-bar{height:6px;border-radius:999px;background:var(--bg3,#e5e7eb);overflow:hidden;}',
      '.het-bar i{display:block;height:100%;background:var(--accent,#4f8ef7);}',
      '.het-cprog{font-size:10px;color:var(--text3,#64748b);margin-top:3px;text-align:right;}',
      '.het-colempty{color:var(--text3,#94a3b8);font-size:11px;text-align:center;padding:8px;}',
      '.het-list{display:flex;flex-direction:column;gap:10px;}',
      '.het-item{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.het-itop{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.het-it{font-size:13px;font-weight:700;color:var(--text,#0f172a);}',
      '.het-imeta{font-size:11.5px;color:var(--text3,#64748b);margin-top:4px;}',
      '.het-score{font-weight:700;color:var(--accent,#4f8ef7);}',
      '.het-note{font-size:12px;color:var(--text2,#475569);margin-top:8px;background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-left:3px solid var(--accent,#4f8ef7);border-radius:8px;padding:8px 10px;}',
      '.het-bal{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;}',
      '.het-bal .het-tile b{display:block;font-size:20px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-bal .het-tile small{font-size:11px;color:var(--text3,#64748b);}',
      '@media(max-width:720px){.het-pipe{grid-template-columns:1fr 1fr;}.het-break{grid-template-columns:1fr 1fr;}}',
      '@media(max-width:480px){.het-pipe{grid-template-columns:1fr;}.het-two{grid-template-columns:1fr;}}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── Attendance ─────────────────────────────────────────────────────────── */
  function wireAtt(box, ctx) {
    var s = ctx.state;
    on(box, 'att-range', function () { s.attRange = this.value; s.attSummary = null; render('attendance', box, ctx); });
    on(box, 'att-from', function () { s.attFrom = this.value; s.attSummary = null; render('attendance', box, ctx); });
    on(box, 'att-to', function () { s.attTo = this.value; s.attSummary = null; render('attendance', box, ctx); });
  }
  function renderAttendance(box, ctx) {
    var s = ctx.state;
    var bar = filterBar(rangeControls('att', s.attRange || '30', s.attFrom, s.attTo, false));
    if (!s.attSummary) {
      box.innerHTML = bar + loading('attendance');
      wireAtt(box, ctx);
      var r = rangeFor(s.attRange || '30', s.attFrom, s.attTo);
      api('/api/attendance/summary/?email=' + encodeURIComponent(ctx.email) + '&fromDate=' + r.from + '&toDate=' + r.to)
        .then(function (sum) { s.attSummary = sum || {}; s.attError = null; settle(box, ctx, 'attendance'); })
        .catch(function (e) { s.attSummary = {}; s.attError = e; settle(box, ctx, 'attendance'); });
      return;
    }
    if (s.attError) { box.innerHTML = bar + denied(s.attError, 'attendance'); wireAtt(box, ctx); return; }
    var sum = s.attSummary;
    var pct = attendancePct(sum);
    var deg = pct == null ? 0 : Math.round(pct * 3.6);
    var label = (s.attRange === 'custom') ? ((s.attFrom || '?') + ' to ' + (s.attTo || todayIso())) : (RANGE_LABEL[s.attRange || '30'] || '');
    box.innerHTML = bar +
      '<div class="het-pctwrap">' +
        '<div class="het-ring" style="background:conic-gradient(var(--accent,#4f8ef7) ' + deg + 'deg, var(--bg3,#e5e7eb) 0deg);"><div><span>' + (pct == null ? '--' : pct + '%') + '</span></div></div>' +
        '<div><div class="het-cv">' + (pct == null ? 'No records' : 'Attendance') + '</div><div class="het-ringlbl">' + esc(label) + '</div></div>' +
      '</div>' +
      '<div class="het-break">' +
        bk(sum.present || 0, 'Present') + bk(sum.late || 0, 'Late') + bk(sum.absent || 0, 'Absent') + bk(sum.half_day || 0, 'Half-day') +
      '</div>' +
      '<div class="het-hrs"><span>Worked <b>' + fmtMins(sum.total_worked_minutes) + '</b></span>' +
        '<span>Breaks <b>' + fmtMins(sum.total_break_minutes) + '</b></span>' +
        '<span>Overtime <b>' + fmtMins(sum.total_overtime_minutes) + '</b></span></div>';
    wireAtt(box, ctx);
  }
  function bk(v, l) { return '<div class="het-bk"><b>' + v + '</b><small>' + esc(l) + '</small></div>'; }

  /* ── Check In / Out ─────────────────────────────────────────────────────── */
  function loadDay(box, ctx) {
    var s = ctx.state, d0 = s.cioDate || todayIso();
    return api('/api/attendance/day-detail?email=' + encodeURIComponent(ctx.email) + '&date=' + d0)
      .then(function (d) {
        s.day = d || {};
        s.dayError = null;
        if (Array.isArray(d && d.punches)) { s.punches = d.punches; return; }
        return api('/api/attendance/location-punch?email=' + encodeURIComponent(ctx.email) + '&date=' + d0)
          .then(function (rows) { s.punches = Array.isArray(rows) ? rows : []; })
          .catch(function () { s.punches = []; });
      })
      .catch(function (e) { s.day = {}; s.dayError = e; s.punches = []; })
      .then(function () { settle(box, ctx, 'checkin'); });
  }
  function renderCheckin(box, ctx) {
    var s = ctx.state, d0 = s.cioDate || todayIso();
    var bar = filterBar('<input type="date" class="het-filter" data-het="cio-date" value="' + esc(d0) + '" max="' + todayIso() + '">');
    function wire() {
      on(box, 'cio-date', function () { s.cioDate = this.value; s.day = null; s.punches = null; render('checkin', box, ctx); });
    }
    if (!s.day) { box.innerHTML = bar + loading('check-in'); wire(); loadDay(box, ctx); return; }
    if (s.dayError) { box.innerHTML = bar + denied(s.dayError, 'check-in records'); wire(); return; }
    var d = s.day;
    var status = String(d.status || '').toLowerCase();
    var badge = d.onTime ? '<span class="het-pill present">On time</span>' : (status ? '<span class="het-pill ' + esc(status) + '">' + esc(d.status) + '</span>' : '');
    var logs = (d.events || []).filter(function (e) { return /check/i.test(e.event || e.label || ''); }).map(function (e) {
      return '<div class="het-log"><span class="het-lt">' + esc(e.time || '') + '</span><span class="het-le">' + esc(e.label || e.event || '') + '</span><span class="het-ll">' + esc(e.location || '') + '</span></div>';
    }).join('') || empty('No check-in events on this day.');
    var punches = s.punches || [];
    var punchHtml = punches.length ? punches.map(function (p) {
      var lat = parseFloat(p.latitude), lng = parseFloat(p.longitude);
      var link = (isFinite(lat) && isFinite(lng))
        ? '<a href="https://www.google.com/maps?q=' + lat + ',' + lng + '" target="_blank" rel="noopener">Map ↗</a>' : '';
      return '<div class="het-log"><span class="het-lt">' + esc(p.time || '') + '</span><span class="het-le">' + esc(p.label || 'Location recorded') + '</span><span class="het-ll">' + link + '</span></div>';
    }).join('') : empty('No location punches recorded on this day.');
    box.innerHTML = bar +
      '<div class="het-two">' +
        '<div class="het-tile"><div class="het-cl">Check In</div><div class="het-cv">' + esc(d.checkIn || '--') + '</div></div>' +
        '<div class="het-tile"><div class="het-cl">Check Out</div><div class="het-cv">' + esc(d.checkOut || '--') + '</div></div>' +
      '</div>' +
      '<div class="het-hrs"><span>Effective <b>' + fmtMins(d.effectiveMinutes) + '</b></span>' +
        '<span>Gross <b>' + fmtMins(d.grossMinutes) + '</b></span>' + (badge ? '<span>' + badge + '</span>' : '') +
        (d.shift && (d.shift.name || d.shift.label) ? '<span>Shift <b>' + esc(d.shift.name || d.shift.label) + '</b></span>' : '') + '</div>' +
      '<div class="het-sec">Activity</div>' + logs +
      '<div class="het-sec">Location punches</div>' + punchHtml;
    wire();
  }

  /* ── Tasks ──────────────────────────────────────────────────────────────── */
  function stageOf(t) {
    var st = String(t.stage || t.status || '').toLowerCase();
    if (/done|complete/.test(st)) return 'done';
    if (/review|qa/.test(st)) return 'review';
    if (/progress|doing/.test(st)) return 'inprogress';
    return 'todo';
  }
  function renderTasks(box, ctx) {
    var s = ctx.state;
    function wire() {
      on(box, 'task-stage', function () { s.taskStage = this.value; render('tasks', box, ctx); });
      on(box, 'task-prio', function () { s.taskPriority = this.value; render('tasks', box, ctx); });
    }
    var bar = filterBar(
      selOpts('task-stage', s.taskStage || 'all', [['all', 'All stages'], ['todo', 'To Do'], ['inprogress', 'In Progress'], ['review', 'Review'], ['done', 'Done']]) +
      selOpts('task-prio', s.taskPriority || 'all', [['all', 'All priority'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]));
    if (!s.tasks) {
      box.innerHTML = bar + loading('tasks');
      wire();
      api('/api/tasks?assigneeEmail=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.tasks = Array.isArray(rows) ? rows : []; s.tasksError = null; settle(box, ctx, 'tasks'); })
        .catch(function (e) { s.tasks = []; s.tasksError = e; settle(box, ctx, 'tasks'); });
      return;
    }
    if (s.tasksError) { box.innerHTML = bar + denied(s.tasksError, 'tasks'); wire(); return; }
    var all = s.tasks;
    if (!all.length) { box.innerHTML = bar + empty('No tasks assigned.'); wire(); return; }
    var rows = all.filter(function (t) { return !(s.taskPriority && s.taskPriority !== 'all') || String(t.priority || 'medium').toLowerCase() === s.taskPriority; });
    var cols = [{ k: 'todo', l: 'To Do' }, { k: 'inprogress', l: 'In Progress' }, { k: 'review', l: 'Review' }, { k: 'done', l: 'Done' }]
      .filter(function (c) { return !s.taskStage || s.taskStage === 'all' || s.taskStage === c.k; });
    var html = '<div class="het-pipe">';
    cols.forEach(function (c) {
      var items = rows.filter(function (t) { return stageOf(t) === c.k; });
      html += '<div class="het-col"><div class="het-colh">' + esc(c.l) + ' <span>' + items.length + '</span></div>';
      html += items.length ? items.map(function (t) {
        var pr = String(t.priority || 'medium').toLowerCase();
        var prog = Math.max(0, Math.min(100, t.progress || 0));
        var rej = (t.rejectReason || t.reject_reason) ? '<span class="het-rej">Rejected</span>' : '';
        return '<div class="het-card"><div class="het-ct">' + esc(t.title || 'Untitled') + '</div>' +
          '<div class="het-cmeta"><span class="het-prio ' + esc(pr) + '">' + esc(pr) + '</span>' + rej +
          (t.due ? '<span>Due ' + esc(t.due) + '</span>' : '') + (t.taskCode ? '<span>' + esc(t.taskCode) + '</span>' : '') + '</div>' +
          '<div class="het-bar"><i style="width:' + prog + '%"></i></div>' +
          '<div class="het-cprog">' + prog + '%</div></div>';
      }).join('') : '<div class="het-colempty">—</div>';
      html += '</div>';
    });
    html += '</div>';
    box.innerHTML = bar + html;
    wire();
  }

  /* ── Work submissions ───────────────────────────────────────────────────── */
  function renderSubmissions(box, ctx) {
    var s = ctx.state;
    function wire() { on(box, 'sub-status', function () { s.subStatus = this.value; render('submissions', box, ctx); }); }
    var bar = filterBar(selOpts('sub-status', s.subStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['In Review', 'In Review'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]));
    if (!s.subs) {
      box.innerHTML = bar + loading('submissions');
      wire();
      api('/api/submissions?email=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.subs = Array.isArray(rows) ? rows : []; s.subsError = null; settle(box, ctx, 'submissions'); })
        .catch(function (e) { s.subs = []; s.subsError = e; settle(box, ctx, 'submissions'); });
      return;
    }
    if (s.subsError) { box.innerHTML = bar + denied(s.subsError, 'work submissions'); wire(); return; }
    var rows = s.subs.filter(function (w) { return !s.subStatus || s.subStatus === 'all' || String(w.status || 'Pending') === s.subStatus; });
    if (!rows.length) { box.innerHTML = bar + empty('No matching submissions.'); wire(); return; }
    box.innerHTML = bar + '<div class="het-list">' + rows.map(function (w) {
      var st = w.status || 'Pending';
      var note = w.reviewerNote ? '<div class="het-note">' + esc(w.reviewerNote) + '</div>' : '';
      var score = w.aiScore ? ' &middot; <span class="het-score">AI ' + esc(w.aiScore) + '</span>' : '';
      return '<div class="het-item"><div class="het-itop"><div class="het-it">' + esc(w.title || 'Untitled') + '</div>' +
        '<span class="het-pill ' + cls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="het-imeta">' + esc(w.type || 'Document') + (w.date ? ' &middot; ' + esc(fmtDate(w.date)) : '') + score + '</div>' + note + '</div>';
    }).join('') + '</div>';
    wire();
  }

  /* ── Leave ──────────────────────────────────────────────────────────────── */
  function renderLeave(box, ctx) {
    var s = ctx.state;
    function wire() {
      on(box, 'leave-status', function () { s.leaveStatus = this.value; render('leave', box, ctx); });
      on(box, 'leave-range', function () { s.leaveRange = this.value; render('leave', box, ctx); });
      on(box, 'leave-from', function () { s.leaveFrom = this.value; render('leave', box, ctx); });
      on(box, 'leave-to', function () { s.leaveTo = this.value; render('leave', box, ctx); });
    }
    var bar = filterBar(
      selOpts('leave-status', s.leaveStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]) +
      rangeControls('leave', s.leaveRange || 'all', s.leaveFrom, s.leaveTo, true));
    if (!s.leave) {
      box.innerHTML = bar + loading('leave');
      wire();
      var list = api('/api/leave?email=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.leave = Array.isArray(rows) ? rows : []; s.leaveError = null; })
        .catch(function (e) { s.leave = []; s.leaveError = e; });
      var bal = api('/api/leave/balance?email=' + encodeURIComponent(ctx.email))
        .then(function (b) { s.leaveBalance = (b && b.balances) || []; })
        .catch(function () { s.leaveBalance = []; });
      Promise.all([list, bal]).then(function () { settle(box, ctx, 'leave'); });
      return;
    }
    if (s.leaveError) { box.innerHTML = bar + denied(s.leaveError, 'leave'); wire(); return; }
    var balHtml = '';
    if (s.leaveBalance && s.leaveBalance.length) {
      balHtml = '<div class="het-bal">' + s.leaveBalance.map(function (b) {
        return '<div class="het-tile"><div class="het-cl">' + esc(b.type) + '</div><b>' + esc(b.remaining) + '</b><small>of ' + esc(b.allowance) + ' remaining &middot; ' + esc(b.used) + ' used</small></div>';
      }).join('') + '</div>';
    }
    var lrng = (s.leaveRange && s.leaveRange !== 'all') ? rangeFor(s.leaveRange, s.leaveFrom, s.leaveTo) : null;
    var rows = s.leave.filter(function (l) {
      if (s.leaveStatus && s.leaveStatus !== 'all' && String(l.status || 'Pending') !== s.leaveStatus) return false;
      if (lrng) { var d = String(l.fromDate || ''); if (d && (d < lrng.from || d > lrng.to)) return false; }
      return true;
    });
    var listHtml = rows.length ? '<div class="het-list">' + rows.map(function (l) {
      var st = l.status || 'Pending';
      return '<div class="het-item"><div class="het-itop"><div class="het-it">' + esc(l.type || 'Leave') + '</div>' +
        '<span class="het-pill ' + cls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="het-imeta">' + esc(fmtDate(l.fromDate)) + ' &rarr; ' + esc(fmtDate(l.toDate)) + ' &middot; ' + esc(l.days || 1) + 'd' + (l.approver ? ' &middot; ' + esc(l.approver) : '') + '</div>' +
        (l.reason ? '<div class="het-note">' + esc(l.reason) + '</div>' : '') + '</div>';
    }).join('') + '</div>' : empty('No matching leave requests.');
    box.innerHTML = bar + balHtml + '<div class="het-sec">Requests</div>' + listHtml;
    wire();
  }

  /* ── public API ─────────────────────────────────────────────────────────── */
  var RENDERERS = {
    attendance: renderAttendance,
    checkin: renderCheckin,
    tasks: renderTasks,
    submissions: renderSubmissions,
    leave: renderLeave
  };

  function render(tab, box, ctx) {
    var fn = RENDERERS[tab];
    if (!fn || !box || !ctx || !ctx.email) return false;
    ensureStyle();
    ctx.state = ctx.state || {};
    box.classList.add('het');
    box.setAttribute('data-het-tab', tab);
    fn(box, ctx);
    return true;
  }

  /* Drop cached rows (keep filters) so the next render refetches. */
  function reset(ctx, tab) {
    var s = (ctx && ctx.state) || {};
    var keys = {
      attendance: ['attSummary', 'attError'],
      checkin: ['day', 'dayError', 'punches'],
      tasks: ['tasks', 'tasksError'],
      submissions: ['subs', 'subsError'],
      leave: ['leave', 'leaveError', 'leaveBalance']
    };
    (tab ? [tab] : Object.keys(keys)).forEach(function (t) {
      (keys[t] || []).forEach(function (k) { delete s[k]; });
    });
  }

  window.HRMSEmployeeTabs = {
    render: render,
    reset: reset,
    tabs: Object.keys(RENDERERS),
    esc: esc,
    api: api,
    initials: initials,
    fmtMins: fmtMins,
    isoDate: isoDate,
    todayIso: todayIso,
    rangeFor: rangeFor,
    attendancePct: attendancePct
  };
})();
