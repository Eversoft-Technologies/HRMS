/**
 * hrms-timesheets.js — the Timesheets page (/timesheets, /timesheets/approvals,
 * /timesheets/history). Hand-written overlay, mounted through HRMSSidecar
 * (hrms-sidecar.js must load first). Everything renders inside the sidecar's
 * own root; React-owned DOM is never touched.
 *
 * Backend: api/timesheets.py
 *   GET  /api/timesheets/week?week=YYYY-MM-DD[&email=]
 *   POST /api/timesheets/entries            PUT/DELETE /api/timesheets/entries/<id>
 *   POST /api/timesheets/week/submit        GET /api/timesheets/approvals[?status=]
 *   POST /api/timesheets/week/<id>/decide   GET /api/attendance/audit?email=&from=&to=
 */
(function () {
  'use strict';
  if (window.__hrmsTimesheetsLoaded) return;
  window.__hrmsTimesheetsLoaded = true;

  var SC = window.HRMSSidecar;
  if (!SC) { if (window.console) console.warn('hrms-timesheets: HRMSSidecar missing'); return; }
  var esc = SC.esc;
  var api = SC.api;

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FIELD_LABELS = {
    check_in: 'Check-in', check_out: 'Check-out', worked_minutes: 'Worked time',
    break_minutes: 'Break time', overtime_minutes: 'Overtime', status: 'Status', note: 'Note',
    is_wfh: 'Work from home', auto_checkout_at: 'Auto check-out at'
  };
  var SOURCE_LABELS = {
    edit: 'Manual edit', correction: 'Correction', auto_checkout: 'Auto check-out',
    recalc: 'Recalculation', punch_ticket: 'Punch ticket'
  };

  /* ── state ─────────────────────────────────────────────────────────────── */
  var S = {
    root: null, sub: '', week: null, data: null, me: null,
    approverTab: null,                  // null = unknown, true / false
    apprFilter: 'Submitted', apprOpen: {}, apprData: null,
    hist: null, seq: 0
  };

  /* ── dates ─────────────────────────────────────────────────────────────── */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function monday(d) { var w = (d.getDay() + 6) % 7; return addDays(d, -w); }
  function fmtDate(v) {
    if (!v) return '';
    try { if (window.HRMSCompany && HRMSCompany.date) return HRMSCompany.date(v, { time: false }); } catch (_) {}
    return String(v);
  }
  function fmtDT(v) {
    if (!v) return '';
    try { if (window.HRMSCompany && HRMSCompany.date) return HRMSCompany.date(v, { time: true }); } catch (_) {}
    return String(v);
  }
  function rangeLabel(ws, we) {
    var a = parseIso(ws), b = parseIso(we);
    if (!a || !b) return ws + ' – ' + we;
    return MONTHS[a.getMonth()] + ' ' + a.getDate() + ' – ' +
      (a.getMonth() === b.getMonth() ? '' : MONTHS[b.getMonth()] + ' ') + b.getDate() + ', ' + b.getFullYear();
  }
  function hrs(n) {
    n = Math.round((+n || 0) * 100) / 100;
    return (n % 1 === 0 ? String(n) : n.toFixed(2).replace(/0$/, '')) + 'h';
  }
  function mins(m) {
    m = +m || 0;
    if (!m) return '0h';
    var h = Math.floor(m / 60), r = m % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '');
  }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById('hrms-ts-style')) return;
    var css = [
      '.ts-page{max-width:1180px;margin:0 auto;color:var(--text);font-family:var(--font)}',
      '.ts-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}',
      '.ts-h1{font-family:var(--font-d,var(--font));font-size:22px;font-weight:700;margin:0;color:var(--text)}',
      '.ts-sub{font-size:13px;color:var(--text2);margin-top:4px}',
      '.ts-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:18px;overflow-x:auto}',
      '.ts-tab{padding:10px 14px;font-size:13px;font-weight:500;color:var(--text2);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;margin-bottom:-1px}',
      '.ts-tab:hover{color:var(--text)}',
      '.ts-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.ts-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
      '.ts-bar .ts-grow{flex:1}',
      '.ts-nav{display:inline-flex;align-items:center;gap:6px}',
      '.ts-range{font-weight:600;font-size:15px;min-width:170px;text-align:center}',
      '.ts-badge{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;white-space:nowrap;border:1px solid transparent}',
      '.ts-b-draft{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.ts-b-submitted{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}',
      '.ts-b-approved{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}',
      '.ts-b-rejected{color:var(--danger);background:color-mix(in srgb,var(--danger) 14%,transparent)}',
      '.ts-b-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}',
      '.ts-b-muted{color:var(--text2);background:var(--bg3)}',
      '.ts-note{border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px;border:1px solid var(--border2);background:var(--bg3);color:var(--text)}',
      '.ts-note.danger{border-color:color-mix(in srgb,var(--danger) 45%,transparent);background:color-mix(in srgb,var(--danger) 9%,var(--bg2))}',
      '.ts-note.ok{border-color:color-mix(in srgb,var(--success) 45%,transparent);background:color-mix(in srgb,var(--success) 9%,var(--bg2))}',
      '.ts-note.info{border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:color-mix(in srgb,var(--accent) 8%,var(--bg2))}',
      '.ts-note b{font-weight:600}',
      '.ts-gridwrap{overflow-x:auto;margin-bottom:16px}',
      '.ts-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:14px;min-width:680px}',
      '.ts-day{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius);padding:18px;cursor:pointer;text-align:left;font-family:var(--font);color:var(--text);position:relative;overflow:hidden;box-sizing:border-box;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,border-color .2s ease}',
      '.ts-day:before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--border2)}',
      '.ts-day:hover{border-color:color-mix(in srgb, var(--accent) 26%, var(--border2));transform:translateY(-3px);box-shadow:0 10px 26px rgba(0,0,0,.28)}',
      '@media (hover:none){.ts-day:hover{transform:none;box-shadow:none}}',
      '@media (prefers-reduced-motion: reduce){.ts-day{transition:none}}',
      '.ts-day.locked{cursor:default}.ts-day.locked:hover{border-color:var(--border2);transform:none;box-shadow:none}',
      '.ts-day.today{border-color:color-mix(in srgb,var(--accent) 55%,transparent)}',
      '.ts-day.today:before{background:var(--accent)}',
      '.ts-day .ts-dn{font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);margin-bottom:8px}',
      '.ts-day .ts-dd{font-size:12px;color:var(--text2);margin-top:2px}',
      '.ts-day .ts-dh{font-family:var(--font-d);font-size:28px;font-weight:800;line-height:1;color:var(--text);margin-top:8px}',
      '.ts-day .ts-dw{font-size:11px;color:var(--text3);margin-top:6px}',
      '.ts-day .ts-dw.over{color:var(--warn)}',
      '.ts-bar2{height:4px;border-radius:3px;background:var(--bg3);margin-top:8px;overflow:hidden}',
      '.ts-bar2 i{display:block;height:100%;background:var(--accent);border-radius:3px}',
      '.ts-group{margin-bottom:14px}',
      '.ts-ghead{display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text2);padding:0 2px 6px;border-bottom:1px solid var(--border2);margin-bottom:6px}',
      '.ts-row{display:flex;align-items:flex-start;gap:12px;padding:9px 4px;border-bottom:1px solid var(--border2)}',
      '.ts-row:last-child{border-bottom:none}',
      '.ts-row .ts-main{flex:1;min-width:0}',
      '.ts-proj{font-weight:600;font-size:13px}',
      '.ts-task{font-size:12px;color:var(--accent);margin-left:6px}',
      '.ts-desc{font-size:12px;color:var(--text2);margin-top:3px;white-space:pre-wrap;word-break:break-word}',
      '.ts-h{font-weight:700;font-size:14px;min-width:54px;text-align:right}',
      '.ts-acts{display:flex;gap:6px}',
      '.ts-link{background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;padding:4px 6px;border-radius:6px;font-family:var(--font)}',
      '.ts-link:hover{color:var(--text);background:var(--bg3)}',
      '.ts-link.danger:hover{color:var(--danger)}',
      '.ts-empty{text-align:center;color:var(--text3);font-size:13px;padding:28px 10px}',
      '.ts-total{font-size:13px;color:var(--text2)}.ts-total b{color:var(--text);font-size:16px}',
      '.ts-err{color:var(--danger);font-size:12px;margin-top:8px;min-height:1em}',
      '.ts-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.ts-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:14px;padding:22px;width:100%;max-width:480px;max-height:92vh;overflow:auto;color:var(--text);box-shadow:0 20px 60px rgba(0,0,0,.35)}',
      '.ts-modal h3{margin:0 0 16px;font-size:17px;font-weight:700}',
      '.ts-f{margin-bottom:12px}.ts-f label{display:block;font-size:12px;font-weight:600;color:var(--text2);margin-bottom:5px}',
      '.ts-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.ts-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text)}',
      '.ts-mfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.ts-btn-danger{background:var(--danger);color:#fff;border:none;border-radius:7px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)}',
      '.ts-btn-ok{background:var(--success);color:#06261d;border:none;border-radius:7px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)}',
      '.ts-page button:disabled{opacity:.5;cursor:not-allowed}',
      '.ts-card{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius,12px);margin-bottom:10px;overflow:hidden}',
      '.ts-chead{display:flex;align-items:center;gap:14px;padding:14px 16px;cursor:pointer;flex-wrap:wrap}',
      '.ts-chead:hover{background:var(--bg3)}',
      '.ts-who{font-weight:600;font-size:14px}.ts-who small{display:block;font-weight:400;color:var(--text3);font-size:12px}',
      '.ts-meta{font-size:12px;color:var(--text2)}',
      '.ts-cbody{border-top:1px solid var(--border2);padding:12px 16px 16px}',
      '.ts-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.ts-table th{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text3);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.ts-table td{padding:9px 10px;border-bottom:1px solid var(--border2);vertical-align:top;color:var(--text)}',
      '.ts-table tr:last-child td{border-bottom:none}',
      '.ts-tablewrap{overflow-x:auto}',
      '.ts-old{color:var(--text3);text-decoration:line-through;word-break:break-word}',
      '.ts-new{color:var(--text);font-weight:500;word-break:break-word}',
      '.ts-arrow{color:var(--text3);margin:0 6px}',
      '.ts-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}',
      '.ts-filters .ts-f{margin:0;min-width:150px}',
      '.ts-filters .input-field{padding:7px 10px}',
      '.ts-src-edit{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}',
      '.ts-src-correction{color:var(--accent2,var(--accent));background:color-mix(in srgb,var(--accent2,var(--accent)) 14%,transparent)}',
      '.ts-src-auto_checkout{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}',
      '.ts-src-recalc{color:var(--text2);background:var(--bg3)}',
      '.ts-src-punch_ticket{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}',
      '@media (max-width:640px){.ts-two{grid-template-columns:1fr}.ts-range{min-width:0}.ts-h1{font-size:19px}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'hrms-ts-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function badge(status) {
    var k = String(status || 'Draft').toLowerCase();
    return '<span class="ts-badge ts-b-' + esc(k) + '">' + esc(status || 'Draft') + '</span>';
  }

  /* ── shell ─────────────────────────────────────────────────────────────── */
  function shell() {
    var r = S.root;
    var tab = S.sub === '/approvals' ? 'appr' : (S.sub === '/history' ? 'hist' : 'mine');
    r.innerHTML =
      '<div class="ts-page">' +
        '<div class="ts-head"><div><h1 class="ts-h1">Timesheets</h1>' +
        '<div class="ts-sub">Log hours by project and task, submit each week for approval, and review attendance changes.</div></div></div>' +
        '<nav class="ts-tabs">' +
          '<a href="/timesheets" class="ts-tab' + (tab === 'mine' ? ' on' : '') + '">My timesheet</a>' +
          '<a href="/timesheets/approvals" class="ts-tab' + (tab === 'appr' ? ' on' : '') + '" data-ts-appr' +
            (S.approverTab === true || tab === 'appr' ? '' : ' style="display:none"') + '>Approvals</a>' +
          '<a href="/timesheets/history" class="ts-tab' + (tab === 'hist' ? ' on' : '') + '">Attendance history</a>' +
        '</nav>' +
        '<div class="ts-body"></div>' +
      '</div>';
    return r.querySelector('.ts-body');
  }

  function render() {
    if (!S.root) return;
    var body = shell();
    S.seq++;
    if (S.sub === '/approvals') renderApprovals(body);
    else if (S.sub === '/history') renderHistory(body);
    else renderMine(body);
  }

  function probeApprover() {
    api('/api/timesheets/approvals').then(function (d) {
      S.approverTab = true;
      S.apprData = d;
      var a = S.root && S.root.querySelector('[data-ts-appr]');
      if (a) a.style.display = '';
    }, function () {
      S.approverTab = false;
      var a = S.root && S.root.querySelector('[data-ts-appr]');
      if (a && S.sub !== '/approvals') a.style.display = 'none';
    });
  }

  function loading(el) { el.innerHTML = '<div class="ts-empty">Loading…</div>'; }
  function failed(el, e) {
    el.innerHTML = '<div class="ts-note danger">' + esc((e && e.message) || 'Something went wrong.') + '</div>';
  }

  /* ── My timesheet ──────────────────────────────────────────────────────── */
  function renderMine(body) {
    if (!S.week) S.week = iso(monday(new Date()));
    var my = S.seq;
    loading(body);
    api('/api/timesheets/week?week=' + encodeURIComponent(S.week)).then(function (d) {
      if (my !== S.seq) return;
      S.data = d;
      S.me = d.me || S.me;
      drawMine(body, d);
    }, function (e) { if (my === S.seq) failed(body, e); });
  }

  function drawMine(body, d) {
    var locked = !!d.locked;
    var todayIso = iso(new Date());
    var html = '';
    html += '<div class="ts-bar">' +
      '<div class="ts-nav"><button class="btn-sm" data-act="prev" title="Previous week">‹</button>' +
      '<span class="ts-range">' + esc(rangeLabel(d.weekStart, d.weekEnd)) + '</span>' +
      '<button class="btn-sm" data-act="next" title="Next week">›</button>' +
      '<button class="btn-sm" data-act="this">This week</button></div>' +
      badge(d.status) +
      '<span class="ts-grow"></span>' +
      '<span class="ts-total">Total <b>' + esc(hrs(d.totalHours)) + '</b></span>' +
      '<button class="btn-sm" data-act="add"' + (locked ? ' disabled' : '') + '>+ Add entry</button>' +
      '<button class="btn-primary" data-act="submit"' + (locked || !d.entries.length ? ' disabled' : '') + '>' +
        (d.status === 'Rejected' ? 'Resubmit week' : 'Submit week') + '</button>' +
      '</div>';

    if (d.status === 'Rejected') {
      html += '<div class="ts-note danger"><b>Rejected</b>' + (d.decidedBy ? ' by ' + esc(d.decidedBy) : '') +
        (d.decidedAt ? ' on ' + esc(fmtDT(d.decidedAt)) : '') + '.' +
        (d.decisionNote ? '<div style="margin-top:6px">' + esc(d.decisionNote) + '</div>' : '') +
        '<div class="ts-sub">Edit your entries and submit the week again.</div></div>';
    } else if (d.status === 'Submitted') {
      html += '<div class="ts-note info">Submitted' + (d.submittedAt ? ' on ' + esc(fmtDT(d.submittedAt)) : '') +
        ' — waiting for ' + (d.approver ? '<b>' + esc(d.approver.name || d.approver.email) + '</b>' : 'an approver') +
        '. Entries are locked until it is decided.</div>';
    } else if (d.status === 'Approved') {
      html += '<div class="ts-note ok"><b>Approved</b>' + (d.decidedBy ? ' by ' + esc(d.decidedBy) : '') +
        (d.decidedAt ? ' on ' + esc(fmtDT(d.decidedAt)) : '') + '.' +
        (d.decisionNote ? ' ' + esc(d.decisionNote) : '') + '</div>';
    } else if (d.approver) {
      html += '<div class="ts-sub" style="margin:-4px 0 12px">Submitted weeks go to <b>' +
        esc(d.approver.name || d.approver.email) + '</b> for approval.</div>';
    }

    var DAY_COLORS = ['blue', 'purple', 'green', 'orange'];
    html += '<div class="ts-gridwrap"><div class="ts-grid">';
    d.days.forEach(function (day, i) {
      var worked = day.attendanceMinutes || 0;
      var over = worked > 0 && day.hours * 60 > worked + 30;
      var pct = worked ? Math.min(100, Math.round(day.hours * 60 / worked * 100)) : (day.hours ? 100 : 0);
      html += '<button type="button" class="ts-day ' + DAY_COLORS[i % 4] + (locked ? ' locked' : '') + (day.date === todayIso ? ' today' : '') +
        '" data-day="' + esc(day.date) + '"' + (locked ? ' tabindex="-1"' : ' title="Add hours for this day"') + '>' +
        '<div class="ts-dn">' + DAYS[i] + '</div>' +
        '<div class="ts-dd">' + esc(fmtDate(day.date)) + '</div>' +
        '<div class="ts-dh">' + esc(hrs(day.hours)) + '</div>' +
        '<div class="ts-dw' + (over ? ' over' : '') + '">' + (worked ? 'Worked ' + esc(mins(worked)) : 'No attendance') + '</div>' +
        '<div class="ts-bar2"><i style="width:' + pct + '%"></i></div>' +
        '</button>';
    });
    html += '</div></div>';

    html += '<div class="card"><div class="card-title">Entries</div>';
    if (!d.entries.length) {
      html += '<div class="ts-empty">No hours logged this week.' + (locked ? '' : ' Click a day or “Add entry” to start.') + '</div>';
    } else {
      d.days.forEach(function (day, i) {
        var list = d.entries.filter(function (e) { return e.date === day.date; });
        if (!list.length) return;
        html += '<div class="ts-group"><div class="ts-ghead"><span>' + DAYS[i] + ' · ' + esc(fmtDate(day.date)) +
          '</span><span>' + esc(hrs(day.hours)) + '</span></div>';
        list.forEach(function (e) {
          html += '<div class="ts-row"><div class="ts-main"><span class="ts-proj">' + esc(e.project) + '</span>' +
            (e.taskTitle ? '<span class="ts-task">' + esc(e.taskTitle) + '</span>' : '') +
            ' <span class="ts-badge ' + (e.billable ? 'ts-b-approved' : 'ts-b-muted') + '" style="margin-left:6px">' +
              (e.billable ? 'Billable' : 'Non-billable') + '</span>' +
            (e.description ? '<div class="ts-desc">' + esc(e.description) + '</div>' : '') +
            '</div><div class="ts-h">' + esc(hrs(e.hours)) + '</div>' +
            (locked ? '' : '<div class="ts-acts"><button class="ts-link" data-edit="' + e.id + '">Edit</button>' +
              '<button class="ts-link danger" data-del="' + e.id + '">Delete</button></div>') +
            '</div>';
        });
        html += '</div>';
      });
    }
    html += '</div><div class="ts-err" data-ts-msg></div>';
    body.innerHTML = html;

    body.onclick = function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act],[data-day],[data-edit],[data-del]') : null;
      if (!t || t.disabled) return;
      var act = t.getAttribute('data-act');
      if (act === 'prev' || act === 'next') { S.week = iso(addDays(parseIso(S.week), act === 'prev' ? -7 : 7)); render(); return; }
      if (act === 'this') { S.week = iso(monday(new Date())); render(); return; }
      if (act === 'add') { openEntry(null, d.weekStart); return; }
      if (act === 'submit') { submitWeek(body, d); return; }
      if (t.hasAttribute('data-day')) { if (!locked) openEntry(null, t.getAttribute('data-day')); return; }
      var id = +(t.getAttribute('data-edit') || t.getAttribute('data-del'));
      var entry = d.entries.filter(function (e) { return e.id === id; })[0];
      if (!entry) return;
      if (t.hasAttribute('data-edit')) openEntry(entry);
      else if (window.confirm('Delete ' + hrs(entry.hours) + ' on ' + entry.project + '?')) {
        api('/api/timesheets/entries/' + id, { method: 'DELETE' }).then(render, function (e) { msg(body, e.message); });
      }
    };
  }

  function msg(body, text) { var m = body.querySelector('[data-ts-msg]'); if (m) m.textContent = text || ''; }

  function submitWeek(body, d) {
    if (!window.confirm('Submit ' + hrs(d.totalHours) + ' for ' + rangeLabel(d.weekStart, d.weekEnd) +
        '? Entries are locked until the week is approved or rejected.')) return;
    api('/api/timesheets/week/submit', { method: 'POST', body: { week: d.weekStart } })
      .then(render, function (e) { msg(body, e.message); });
  }

  function openEntry(entry, dayIso) {
    var d = S.data || { projects: [], tasks: [] };
    var e = entry || { date: dayIso, project: '', taskId: null, hours: '', billable: true, description: '' };
    var taskOpts = '<option value="">— No task —</option>';
    var haveTask = false;
    (d.tasks || []).forEach(function (t) {
      if (t.id === e.taskId) haveTask = true;
      taskOpts += '<option value="' + t.id + '"' + (t.id === e.taskId ? ' selected' : '') + '>' + esc(t.title) + '</option>';
    });
    if (e.taskId && !haveTask) taskOpts += '<option value="' + e.taskId + '" selected>' + esc(e.taskTitle || ('Task #' + e.taskId)) + '</option>';
    var dl = (d.projects || []).map(function (p) { return '<option value="' + esc(p) + '"></option>'; }).join('');

    var bg = document.createElement('div');
    bg.className = 'ts-modal-bg';
    bg.innerHTML =
      '<form class="ts-modal" autocomplete="off">' +
        '<h3>' + (entry ? 'Edit entry' : 'Log hours') + '</h3>' +
        '<div class="ts-two">' +
          '<div class="ts-f"><label>Date</label><input class="input-field" type="date" name="date" required value="' + esc(e.date) + '"></div>' +
          '<div class="ts-f"><label>Hours</label><input class="input-field" type="number" name="hours" required min="0.25" max="24" step="0.25" placeholder="e.g. 2.5" value="' + esc(e.hours) + '"></div>' +
        '</div>' +
        '<div class="ts-f"><label>Project</label><input class="input-field" name="project" required maxlength="255" list="ts-projects" placeholder="Project or client" value="' + esc(e.project) + '"><datalist id="ts-projects">' + dl + '</datalist></div>' +
        '<div class="ts-f"><label>Task (optional)</label><select class="input-field" name="taskId">' + taskOpts + '</select></div>' +
        '<div class="ts-f"><label>Description</label><textarea class="input-field" name="description" rows="3" placeholder="What did you work on?">' + esc(e.description) + '</textarea></div>' +
        '<label class="ts-check"><input type="checkbox" name="billable"' + (e.billable ? ' checked' : '') + '> Billable</label>' +
        '<div class="ts-err" data-err></div>' +
        '<div class="ts-mfoot"><button type="button" class="btn-sm" data-cancel>Cancel</button><button type="submit" class="btn-primary">' + (entry ? 'Save' : 'Add') + '</button></div>' +
      '</form>';
    S.root.appendChild(bg);
    var form = bg.querySelector('form');
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener('keydown', onKey); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', function (ev) { if (ev.target === bg) close(); });
    bg.querySelector('[data-cancel]').onclick = close;
    setTimeout(function () { var f = form.querySelector(entry ? '[name=hours]' : (e.date ? '[name=hours]' : '[name=date]')); if (f) f.focus(); }, 30);
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var err = form.querySelector('[data-err]');
      var h = parseFloat(form.hours.value);
      if (!(h > 0 && h <= 24)) { err.textContent = 'Hours must be more than 0 and at most 24.'; return; }
      if (Math.round(h * 4) !== h * 4) { err.textContent = 'Use quarter-hour steps (0.25, 0.5, 0.75…).'; return; }
      if (!form.project.value.trim()) { err.textContent = 'Enter a project.'; return; }
      var payload = {
        date: form.date.value, hours: h, project: form.project.value.trim(),
        taskId: form.taskId.value ? +form.taskId.value : null,
        description: form.description.value, billable: form.billable.checked
      };
      var btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      api(entry ? '/api/timesheets/entries/' + entry.id : '/api/timesheets/entries',
          { method: entry ? 'PUT' : 'POST', body: payload })
        .then(function () {
          close();
          var w = parseIso(payload.date);
          if (w) S.week = iso(monday(w));
          render();
        }, function (x) { btn.disabled = false; err.textContent = x.message; });
    };
  }

  /* ── Approvals ─────────────────────────────────────────────────────────── */
  function renderApprovals(body) {
    var my = S.seq;
    loading(body);
    var q = S.apprFilter === 'Submitted' ? '' : '?status=' + encodeURIComponent(S.apprFilter);
    api('/api/timesheets/approvals' + q).then(function (d) {
      if (my !== S.seq) return;
      S.approverTab = true;
      S.apprData = d;
      drawApprovals(body, d);
    }, function (e) {
      if (my !== S.seq) return;
      if (e.status === 403) {
        S.approverTab = false;
        body.innerHTML = '<div class="ts-empty">You have no team timesheets to approve. Timesheets of people who report to you appear here when they submit them.</div>';
      } else failed(body, e);
    });
  }

  function drawApprovals(body, d) {
    var opts = ['Submitted', 'Approved', 'Rejected', 'all'].map(function (s) {
      return '<option value="' + s + '"' + (S.apprFilter === s ? ' selected' : '') + '>' + (s === 'all' ? 'All decided & pending' : s) + '</option>';
    }).join('');
    var html = '<div class="ts-bar"><select class="input-field" style="width:auto" data-filter>' + opts + '</select>' +
      '<span class="ts-grow"></span><span class="ts-meta">' + d.weeks.length + ' week' + (d.weeks.length === 1 ? '' : 's') +
      (d.canApproveAll ? ' · you can approve everyone' : ' · your team') + '</span></div>';
    if (!d.weeks.length) {
      html += '<div class="card"><div class="ts-empty">' + (S.apprFilter === 'Submitted' ? 'Nothing waiting for approval.' : 'No timesheets.') + '</div></div>';
    }
    d.weeks.forEach(function (w) {
      var open = !!S.apprOpen[w.id];
      html += '<div class="ts-card"><div class="ts-chead" data-toggle="' + w.id + '">' +
        '<div class="ts-who" style="flex:1;min-width:160px">' + esc(w.employeeName || w.email) + '<small>' + esc(w.email) + '</small></div>' +
        '<div class="ts-meta">Week of <b style="color:var(--text)">' + esc(rangeLabel(w.weekStart, w.weekEnd)) + '</b></div>' +
        '<div class="ts-meta"><b style="color:var(--text);font-size:15px">' + esc(hrs(w.totalHours)) + '</b></div>' +
        '<div class="ts-meta">' + (w.submittedAt ? 'Submitted ' + esc(fmtDT(w.submittedAt)) : '') + '</div>' +
        badge(w.status) + '<span class="ts-meta">' + (open ? '▾' : '▸') + '</span></div>';
      if (open) {
        html += '<div class="ts-cbody">';
        if (w.entries && w.entries.length) {
          html += '<div class="ts-tablewrap"><table class="ts-table"><thead><tr><th>Day</th><th>Project</th><th>Task</th><th>Description</th><th>Billable</th><th style="text-align:right">Hours</th></tr></thead><tbody>';
          w.entries.forEach(function (e) {
            var dd = parseIso(e.date);
            html += '<tr><td style="white-space:nowrap">' + (dd ? DAYS[(dd.getDay() + 6) % 7] + ' ' : '') + esc(fmtDate(e.date)) + '</td>' +
              '<td>' + esc(e.project) + '</td><td>' + esc(e.taskTitle || '—') + '</td>' +
              '<td style="color:var(--text2)">' + esc(e.description || '') + '</td>' +
              '<td>' + (e.billable ? 'Yes' : 'No') + '</td><td style="text-align:right;font-weight:600">' + esc(hrs(e.hours)) + '</td></tr>';
          });
          html += '</tbody></table></div>';
        } else html += '<div class="ts-empty">No entries.</div>';
        if (w.status === 'Submitted') {
          html += '<div class="ts-f" style="margin-top:12px"><label>Note (required to reject)</label>' +
            '<textarea class="input-field" rows="2" data-note="' + w.id + '" placeholder="Feedback for ' + esc(w.employeeName || w.email) + '"></textarea></div>' +
            '<div class="ts-err" data-werr="' + w.id + '"></div>' +
            '<div class="ts-mfoot" style="margin-top:6px"><button class="ts-btn-danger" data-decide="reject" data-id="' + w.id + '">Reject</button>' +
            '<button class="ts-btn-ok" data-decide="approve" data-id="' + w.id + '">Approve</button></div>';
        } else if (w.decidedBy) {
          html += '<div class="ts-meta" style="margin-top:10px">' + esc(w.status) + ' by ' + esc(w.decidedBy) +
            (w.decidedAt ? ' on ' + esc(fmtDT(w.decidedAt)) : '') + (w.decisionNote ? ' — ' + esc(w.decisionNote) : '') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
    body.querySelector('[data-filter]').onchange = function () { S.apprFilter = this.value; render(); };
    body.onclick = function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-toggle],[data-decide]') : null;
      if (!t || t.disabled) return;
      if (t.hasAttribute('data-toggle')) {
        var id = t.getAttribute('data-toggle');
        S.apprOpen[id] = !S.apprOpen[id];
        drawApprovals(body, d);
        return;
      }
      var wid = t.getAttribute('data-id'), action = t.getAttribute('data-decide');
      var noteEl = body.querySelector('[data-note="' + wid + '"]');
      var errEl = body.querySelector('[data-werr="' + wid + '"]');
      var note = noteEl ? noteEl.value.trim() : '';
      if (action === 'reject' && !note) { errEl.textContent = 'Write a note explaining what to fix.'; if (noteEl) noteEl.focus(); return; }
      t.disabled = true;
      api('/api/timesheets/week/' + wid + '/decide', { method: 'POST', body: { action: action, note: note } })
        .then(function () { delete S.apprOpen[wid]; render(); }, function (e) { t.disabled = false; errEl.textContent = e.message; });
    };
  }

  /* ── Attendance history ────────────────────────────────────────────────── */
  function histValue(field, v) {
    if (v === '' || v == null) return '<span style="color:var(--text3)">empty</span>';
    if (/_minutes$/.test(field) && /^-?\d+$/.test(v)) return esc(mins(+v));
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return esc(fmtDT(v));
    return esc(v);
  }

  function renderHistory(body) {
    var my = S.seq;
    function go(me) {
      if (my !== S.seq) return;
      S.me = me || S.me || {};
      if (!S.hist) {
        var t = new Date();
        S.hist = { from: iso(addDays(t, -30)), to: iso(t), email: '' };
      }
      drawHistory(body);
    }
    if (S.me) go(S.me);
    else {
      loading(body);
      api('/api/timesheets/week').then(function (d) { go(d.me); }, function () { go({}); });
    }
  }

  function drawHistory(body) {
    var me = S.me || {};
    var canPick = !!(me.canAudit || me.hasReports || me.superAdmin);
    var people = {};
    if (S.apprData && S.apprData.weeks) S.apprData.weeks.forEach(function (w) { people[w.email] = w.employeeName || w.email; });
    var dl = Object.keys(people).map(function (e) { return '<option value="' + esc(e) + '">' + esc(people[e]) + '</option>'; }).join('');
    body.innerHTML =
      '<div class="ts-filters">' +
        '<div class="ts-f"><label>From</label><input class="input-field" type="date" data-h="from" value="' + esc(S.hist.from) + '"></div>' +
        '<div class="ts-f"><label>To</label><input class="input-field" type="date" data-h="to" value="' + esc(S.hist.to) + '"></div>' +
        (canPick ? '<div class="ts-f" style="min-width:240px;flex:1;max-width:340px"><label>Employee email</label>' +
          '<input class="input-field" type="email" data-h="email" list="ts-people" placeholder="Leave empty for your own" value="' + esc(S.hist.email) + '">' +
          '<datalist id="ts-people">' + dl + '</datalist></div>' : '') +
        '<button class="btn-primary" data-h-go>Show</button>' +
      '</div>' +
      '<div class="card" style="padding:0"><div data-h-out><div class="ts-empty">Loading…</div></div></div>';
    function load() {
      var q = '?from=' + encodeURIComponent(S.hist.from) + '&to=' + encodeURIComponent(S.hist.to) +
        (S.hist.email ? '&email=' + encodeURIComponent(S.hist.email) : '');
      var out = body.querySelector('[data-h-out]');
      out.innerHTML = '<div class="ts-empty">Loading…</div>';
      var my = S.seq;
      var who = S.hist.email || (SC.me().email || '');
      /* Never spin forever: a dropped connection becomes a message + Retry. */
      function timed(p) {
        return Promise.race([p, new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('The server did not answer in time.')); }, 20000);
        })]);
      }
      // The attendance days themselves (existing data) …
      var daysP = timed(api('/api/attendance?email=' + encodeURIComponent(who) + '&from=' + encodeURIComponent(S.hist.from) +
                            '&to=' + encodeURIComponent(S.hist.to))).then(function (r) { return Array.isArray(r) ? r : []; });
      // … and the field-by-field change log (recorded from this release on).
      var auditP = timed(api('/api/attendance/audit' + q));
      Promise.all([daysP, auditP]).then(function (res) {
        if (my !== S.seq) return;
        var days = res[0], rows = res[1] || [];
        var changes = {};
        rows.forEach(function (r) { changes[r.date] = (changes[r.date] || 0) + 1; });
        var mins = function (m) { m = Number(m) || 0; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
        var tm = function (v) { return v ? esc(fmtDT(v)) : '—'; };
        var dh = '<div class="ts-tablewrap"><div class="ts-sub" style="padding:12px 14px 4px;font-weight:700">Attendance days</div>' +
          '<table class="ts-table"><thead><tr><th>Date</th><th>Check-in</th><th>Check-out</th><th>Worked</th><th>Break</th><th>Status</th><th>Changes</th></tr></thead><tbody>';
        days.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).forEach(function (d) {
          dh += '<tr><td style="white-space:nowrap">' + esc(fmtDate(d.date)) + '</td><td>' + tm(d.checkIn || d.check_in) + '</td><td>' + tm(d.checkOut || d.check_out) +
            '</td><td>' + mins(d.workedMinutes != null ? d.workedMinutes : d.worked_minutes) + '</td><td>' + mins(d.breakMinutes != null ? d.breakMinutes : d.break_minutes) +
            '</td><td>' + esc(d.status || '') + (d.autoCheckedOut ? ' <span class="ts-badge ts-src-auto_checkout">auto</span>' : '') +
            '</td><td>' + (changes[d.date] ? changes[d.date] + ' change' + (changes[d.date] > 1 ? 's' : '') : '—') + '</td></tr>';
        });
        dh += '</tbody></table></div>';
        if (!days.length) dh = '<div class="ts-empty">No attendance days in this period.</div>';
        if (!rows.length) {
          out.innerHTML = dh + '<div class="ts-empty" style="border-top:1px solid var(--border2)">No changes recorded in this period. Edits, approved corrections, punch tickets, automatic check-outs and recalculations are recorded from now on.</div>';
          return;
        }
        var h = dh + '<div class="ts-tablewrap" style="border-top:1px solid var(--border2)"><div class="ts-sub" style="padding:12px 14px 4px;font-weight:700">Changes</div><table class="ts-table"><thead><tr><th>When</th><th>Day</th><th>Source</th><th>Field</th><th>Change</th><th>By</th><th>Reason</th></tr></thead><tbody>';
        rows.forEach(function (r) {
          h += '<tr><td style="white-space:nowrap">' + esc(fmtDT(r.at)) + '</td>' +
            '<td style="white-space:nowrap">' + esc(fmtDate(r.date)) + '</td>' +
            '<td><span class="ts-badge ts-src-' + esc(r.source) + '">' + esc(SOURCE_LABELS[r.source] || r.source) + '</span></td>' +
            '<td style="white-space:nowrap">' + esc(FIELD_LABELS[r.field] || r.field) + '</td>' +
            '<td><span class="ts-old">' + histValue(r.field, r.oldValue) + '</span><span class="ts-arrow">→</span>' +
              '<span class="ts-new">' + histValue(r.field, r.newValue) + '</span></td>' +
            '<td>' + esc(r.actor || '—') + '</td>' +
            '<td style="color:var(--text2);max-width:280px">' + esc(r.reason || '') + '</td></tr>';
        });
        out.innerHTML = h + '</tbody></table></div>';
      }).catch(function (e) {
        if (my !== S.seq) return;
        out.innerHTML = '<div class="ts-note danger" style="margin:14px">' + esc(e.status === 403 ? 'You can only see your own attendance history or your team\'s.' : (e.message || 'Could not load.')) +
          ' <button class="btn-sm" data-h-retry style="margin-left:8px">Retry</button></div>';
        var rb = out.querySelector('[data-h-retry]'); if (rb) rb.onclick = load;
      });
    }
    body.querySelector('[data-h-go]').onclick = function () {
      body.querySelectorAll('[data-h]').forEach(function (i) { S.hist[i.getAttribute('data-h')] = i.value.trim().toLowerCase(); });
      load();
    };
    load();
  }

  /* ── register ──────────────────────────────────────────────────────────── */
  SC.register({
    base: '/timesheets',
    title: 'Timesheets',
    mount: function (root, sub) {
      injectStyle();
      S.root = root;
      S.sub = sub || '';
      S.me = null;
      S.approverTab = null;
      render();
      probeApprover();
    },
    update: function (root, sub) {
      S.root = root;
      S.sub = sub || '';
      render();
    },
    unmount: function () {
      S.root = null;
      S.seq++;
    }
  });
})();
