/**
 * hrms-overtime.js  v1
 * Overtime & Comp-off — /attendance/overtime (Workstream O).
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): renders into the sidecar's
 * own root; React-owned DOM is never touched.
 *
 * Tabs
 *   My overtime  own records for the month, status, comp-off credits + expiry
 *   Approvals    pending records the caller may decide (manager / attendance.edit):
 *                approve in full, approve part of the minutes, reject with a note, batch
 *   All          everyone (attendance.view / .edit): filters, CSV export, recompute
 *
 * Backend: api/attendance_ext/overtime_views.py
 *   GET  /api/attendance/overtime-records?scope=mine|team|all&status&dayType&month&email
 *   POST /api/attendance/overtime-records/<id>/decide   {action, minutes?, note?}
 *   POST /api/attendance/overtime-records/batch         {action, ids, note?}
 *   GET  /api/attendance/overtime-summary?email&month
 *   POST /api/attendance/overtime-evaluate              {from, to, email?}
 */
(function () {
  'use strict';
  if (window.__hrmsOvertimeLoaded) return;
  window.__hrmsOvertimeLoaded = true;

  var BASE = '/attendance/overtime';
  var STYLE_ID = 'hrms-ot-style';
  var SC = null;
  var S = {
    root: null, token: 0, tab: 'mine', month: '', summary: null, mine: null, team: null, all: null,
    canEdit: false, canViewAll: false, isManager: false, sel: {}, msg: '', msgKind: '',
    f: { status: '', dayType: '', q: '' }
  };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v); } catch (_) {}
    return String(v);
  }
  function hm(m) {
    m = Math.max(0, Math.round(+m || 0));
    var h = Math.floor(m / 60), r = m % 60;
    return h ? h + 'h ' + pad(r) + 'm' : r + 'm';
  }
  function days(n) { n = +n || 0; return n + (n === 1 ? ' day' : ' days'); }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.ot-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.ot-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.ot-h1{font-size:20px;font-weight:700;margin:0}',
      '.ot-sub{font-size:13px;color:var(--text3);margin-top:4px;max-width:760px;line-height:1.5}',
      '.ot-head .input-field{width:auto;padding:7px 10px}',
      '.ot-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}',
      '.ot-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:14px 16px}',
      '.ot-kpi span{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.8px}',
      '.ot-kpi b{display:block;font-size:22px;font-weight:700;margin-top:4px}',
      '.ot-kpi small{display:block;font-size:11.5px;color:var(--text3);margin-top:2px}',
      '.ot-kpi.ot-warn b{color:var(--warn)}.ot-kpi.ot-ok b{color:var(--success)}',
      '.ot-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.ot-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.ot-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.ot-count{display:inline-block;min-width:18px;padding:0 6px;margin-left:6px;border-radius:999px;font-size:11px;line-height:18px;text-align:center;color:#fff;background:var(--accent)}',
      '.ot-panel{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:16px;margin-bottom:16px}',
      '.ot-panel h3{margin:0 0 12px;font-size:14px;font-weight:700}',
      '.ot-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
      '.ot-bar .input-field{width:auto;min-width:130px;padding:7px 10px}',
      '.ot-grow{flex:1;min-width:180px}',
      '.ot-wrap{overflow-x:auto}',
      '.ot-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.ot-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.ot-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.ot-table tr:hover td{background:var(--bg3)}',
      '.ot-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.ot-muted{color:var(--text3)}.ot-small{font-size:11.5px}',
      '.ot-name{font-weight:600}',
      '.ot-nowrap{white-space:nowrap}',
      '.ot-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.ot-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.ot-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.ot-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.ot-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.ot-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.ot-btns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.ot-empty{padding:30px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.ot-msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px}',
      '.ot-msg.err{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}',
      '.ot-msg.ok{color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent)}',
      '.ot-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.ot-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:440px;padding:20px;color:var(--text)}',
      '.ot-modal h3{margin:0 0 6px;font-size:16px}',
      '.ot-modal label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin:12px 0 5px;text-transform:uppercase;letter-spacing:.6px}',
      '.ot-modal textarea{min-height:70px;resize:vertical}',
      '.ot-modal .ot-btns{margin-top:16px}',
      '.ot-busy{opacity:.6;pointer-events:none}',
      '@media (max-width:640px){.ot-kpis{grid-template-columns:1fr 1fr;gap:8px}.ot-kpi{padding:10px 12px}.ot-kpi b{font-size:18px}.ot-table{font-size:12px}.ot-table th,.ot-table td{padding:7px 6px}.ot-hide-sm{display:none}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── renderers ─────────────────────────────────────────────────────────── */
  var STA_CLS = { Pending: 'ot-c-warn', Approved: 'ot-c-success', Auto: 'ot-c-accent', Rejected: 'ot-c-danger' };
  var CO_CLS = { active: 'ot-c-success', expiring: 'ot-c-warn', expired: 'ot-c-danger', used: 'ot-c-muted' };
  var DT_LABEL = { working: 'Working day', weekend: 'Weekly off', holiday: 'Holiday' };
  function badge(t, cls) { return '<span class="ot-badge ' + (cls || 'ot-c-muted') + '">' + esc(t) + '</span>'; }
  function statusBadge(r) {
    var b = badge(r.status === 'Auto' ? 'Auto-approved' : r.status, STA_CLS[r.status]);
    if (r.reopened) b += ' ' + badge('Re-approval', 'ot-c-warn');
    return b;
  }
  function dayBadge(t) { return t === 'working' ? '<span class="ot-muted">Working day</span>' : badge(DT_LABEL[t] || t, 'ot-c-accent'); }

  function policyLine(p) {
    if (!p) return '';
    var parts = [];
    parts.push('Overtime after ' + (p.overtimeAfterMinutes == null ? 'your shift hours' : hm(p.overtimeAfterMinutes)) + ' of work');
    parts.push('daily cap ' + (p.dailyCapMinutes ? hm(p.dailyCapMinutes) : 'none') + ', weekly cap ' + (p.weeklyCapMinutes ? hm(p.weeklyCapMinutes) : 'none'));
    parts.push(p.requiresApproval ? 'needs manager approval' : 'approved automatically');
    if (p.compOffEnabled) {
      parts.push('weekly-off / holiday work earns comp-off (' + hm(p.compOffHalfDayMinutes) + ' = ½ day, ' + hm(p.compOffFullDayMinutes) + ' = 1 day' +
        (p.compOffExpiryDays ? ', valid ' + p.compOffExpiryDays + ' days' : '') + ')');
    }
    return 'Policy “' + esc(p.profileName) + '”: ' + esc(parts.join('; ')) + '.';
  }

  function kpis() {
    var s = S.summary;
    if (!s) return '';
    var co = s.compOff || {};
    return '<div class="ot-kpis">' +
      '<div class="ot-kpi ot-ok"><span>Approved overtime</span><b>' + esc(hm(s.approvedMinutes)) + '</b><small>' + esc(hm(s.payableMinutes)) + ' paid as overtime</small></div>' +
      '<div class="ot-kpi' + (s.pendingCount ? ' ot-warn' : '') + '"><span>Pending approval</span><b>' + esc(hm(s.pendingMinutes)) + '</b><small>' + s.pendingCount + ' day' + (s.pendingCount === 1 ? '' : 's') + '</small></div>' +
      '<div class="ot-kpi"><span>Comp-off balance</span><b>' + esc(days(co.balance)) + '</b><small>' + esc(days(co.earned)) + ' earned this month</small></div>' +
      '<div class="ot-kpi' + (co.expiringSoon ? ' ot-warn' : '') + '"><span>Expiring in 14 days</span><b>' + esc(days(co.expiringSoon)) + '</b><small>' + esc(days(co.used)) + ' used, ' + esc(days(co.lapsed)) + ' lapsed</small></div>' +
      '</div>';
  }

  function recordRows(items, opts) {
    opts = opts || {};
    if (!items.length) return '<div class="ot-empty">' + esc(opts.empty || 'No overtime for this month.') + '</div>';
    var h = '<div class="ot-wrap"><table class="ot-table"><thead><tr>';
    if (opts.select) h += '<th><input type="checkbox" data-ot="selall" aria-label="Select all"></th>';
    if (opts.who) h += '<th>Employee</th>';
    h += '<th>Date</th><th class="ot-hide-sm">Day</th><th class="ot-num">Worked</th><th class="ot-num">Overtime</th><th class="ot-num ot-hide-sm">Capped</th><th>Status</th><th class="ot-num">Approved</th><th class="ot-num">Comp-off</th>';
    if (opts.actions) h += '<th></th>';
    h += '</tr></thead><tbody>';
    items.forEach(function (r) {
      h += '<tr data-id="' + r.id + '">';
      if (opts.select) h += '<td>' + (r.canDecide ? '<input type="checkbox" data-ot="sel" value="' + r.id + '"' + (S.sel[r.id] ? ' checked' : '') + ' aria-label="Select">' : '') + '</td>';
      if (opts.who) h += '<td><div class="ot-name">' + esc(r.employeeName) + '</div><div class="ot-muted ot-small">' + esc(r.email) + '</div></td>';
      h += '<td class="ot-nowrap">' + esc(fmtDate(r.date)) + '</td>' +
        '<td class="ot-hide-sm">' + dayBadge(r.dayType) + '</td>' +
        '<td class="ot-num">' + esc(hm(r.workedMinutes)) + '</td>' +
        '<td class="ot-num"><b>' + esc(hm(r.overtimeMinutes)) + '</b></td>' +
        '<td class="ot-num ot-hide-sm">' + (r.cappedMinutes ? '<span class="ot-muted" title="Cut by the daily / weekly cap">' + esc(hm(r.cappedMinutes)) + '</span>' : '<span class="ot-muted">—</span>') + '</td>' +
        '<td>' + statusBadge(r) + (r.note ? '<div class="ot-muted ot-small" title="' + esc(r.note) + '">' + esc(r.note.length > 60 ? r.note.slice(0, 57) + '…' : r.note) + '</div>' : '') + '</td>' +
        '<td class="ot-num">' + (r.status === 'Approved' || r.status === 'Auto' ? esc(hm(r.approvedMinutes)) : '<span class="ot-muted">—</span>') + '</td>' +
        '<td class="ot-num">' + (r.compOffDays ? esc(days(r.compOffDays)) + (r.compOffExpires ? '<div class="ot-muted ot-small">until ' + esc(fmtDate(r.compOffExpires)) + '</div>' : '') : '<span class="ot-muted">—</span>') + '</td>';
      if (opts.actions) {
        h += '<td>' + (r.canDecide ? '<div class="ot-btns">' +
          '<button type="button" class="btn-primary btn-sm" data-ot="approve" data-id="' + r.id + '">Approve</button>' +
          '<button type="button" class="btn-sm" data-ot="partial" data-id="' + r.id + '">Part…</button>' +
          '<button type="button" class="btn-sm" data-ot="reject" data-id="' + r.id + '">Reject</button></div>' : '') + '</td>';
      }
      h += '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function creditRows(rows) {
    if (!rows || !rows.length) return '<div class="ot-empty">No comp-off yet. Work on a weekly off or a holiday earns comp-off once approved.</div>';
    var h = '<div class="ot-wrap"><table class="ot-table"><thead><tr><th>Worked on</th><th class="ot-num">Earned</th><th class="ot-num">Used</th><th class="ot-num">Left</th><th>Expires</th><th>State</th></tr></thead><tbody>';
    rows.forEach(function (c) {
      h += '<tr><td>' + esc(fmtDate(c.date)) + ' <span class="ot-muted ot-small">' + esc(DT_LABEL[c.dayType] || '') + '</span></td>' +
        '<td class="ot-num">' + esc(days(c.days)) + '</td><td class="ot-num">' + esc(c.used) + '</td>' +
        '<td class="ot-num"><b>' + esc(c.remaining) + '</b></td><td>' + esc(c.expires ? fmtDate(c.expires) : 'Never') + '</td>' +
        '<td>' + badge(c.state.charAt(0).toUpperCase() + c.state.slice(1), CO_CLS[c.state]) + '</td></tr>';
    });
    return h + '</tbody></table></div>' +
      '<div class="ot-muted ot-small" style="margin-top:8px">Apply for comp-off from Leave with the leave type “' + esc((S.summary && S.summary.policy && S.summary.policy.compOffLeaveType) || 'Comp Off') + '”. The oldest credit is used first.</div>';
  }

  function paint() {
    var root = S.root;
    if (!root) return;
    var pend = (S.team && S.team.items || []).filter(function (r) { return r.status === 'Pending' && r.canDecide; });
    var showApprovals = S.isManager || S.canEdit || pend.length > 0;
    var h = '<div class="ot-page"><div class="ot-head"><div><h1 class="ot-h1">Overtime &amp; Comp-off</h1>' +
      '<div class="ot-sub">' + policyLine(S.summary && S.summary.policy) + '</div></div>' +
      '<input class="input-field" type="month" data-ot="month" value="' + esc(S.month) + '" aria-label="Month"></div>';
    if (S.msg) h += '<div class="ot-msg ' + (S.msgKind || 'ok') + '">' + esc(S.msg) + '</div>';
    h += kpis();
    h += '<div class="ot-tabs" role="tablist"><button type="button" class="ot-tab' + (S.tab === 'mine' ? ' on' : '') + '" data-tab="mine">My overtime</button>';
    if (showApprovals) h += '<button type="button" class="ot-tab' + (S.tab === 'approvals' ? ' on' : '') + '" data-tab="approvals">Approvals' + (pend.length ? '<span class="ot-count">' + pend.length + '</span>' : '') + '</button>';
    if (S.canViewAll) h += '<button type="button" class="ot-tab' + (S.tab === 'all' ? ' on' : '') + '" data-tab="all">All</button>';
    h += '</div>';
    if (S.tab === 'approvals' && showApprovals) {
      h += '<div class="ot-panel"><div class="ot-bar"><span class="ot-muted ot-grow">Overtime waiting for your decision. Approving a weekly-off / holiday day credits its comp-off.</span>' +
        '<button type="button" class="btn-primary btn-sm" data-ot="batch-approve"' + (pend.length ? '' : ' disabled') + '>Approve selected</button>' +
        '<button type="button" class="btn-sm" data-ot="batch-reject"' + (pend.length ? '' : ' disabled') + '>Reject selected</button></div>' +
        recordRows(pend, { who: true, select: true, actions: true, empty: 'Nothing is waiting for your decision.' }) + '</div>';
    } else if (S.tab === 'all' && S.canViewAll) {
      var items = filtered();
      h += '<div class="ot-panel"><div class="ot-bar">' +
        '<input class="input-field ot-grow" data-ot="q" placeholder="Search name or email…" value="' + esc(S.f.q) + '">' +
        '<select class="input-field" data-ot="fstatus">' + opt('', 'Any status', S.f.status) + opt('Pending', 'Pending', S.f.status) + opt('Approved', 'Approved', S.f.status) + opt('Auto', 'Auto-approved', S.f.status) + opt('Rejected', 'Rejected', S.f.status) + '</select>' +
        '<select class="input-field" data-ot="fday">' + opt('', 'Any day', S.f.dayType) + opt('working', 'Working day', S.f.dayType) + opt('weekend', 'Weekly off', S.f.dayType) + opt('holiday', 'Holiday', S.f.dayType) + '</select>' +
        '<button type="button" class="btn-sm" data-ot="csv"' + (items.length ? '' : ' disabled') + '>Export CSV</button>' +
        (S.canEdit ? '<button type="button" class="btn-sm" data-ot="recompute" title="Re-evaluate every closed day of this month with the current policy">Recompute month</button>' : '') +
        '</div>' + recordRows(items, { who: true, actions: true, empty: 'No overtime matches.' }) + '</div>';
    } else {
      S.tab = 'mine';
      h += '<div class="ot-panel"><h3>My overtime</h3>' + recordRows((S.mine && S.mine.items) || []) + '</div>' +
        '<div class="ot-panel"><h3>Comp-off</h3>' + creditRows(S.summary && S.summary.compOff && S.summary.compOff.credits) + '</div>';
    }
    h += '</div>';
    root.innerHTML = h;
  }

  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  function filtered() {
    var q = S.f.q.trim().toLowerCase();
    return ((S.all && S.all.items) || []).filter(function (r) {
      if (S.f.status && r.status !== S.f.status) return false;
      if (S.f.dayType && r.dayType !== S.f.dayType) return false;
      if (q && (r.employeeName + ' ' + r.email).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /* ── data ──────────────────────────────────────────────────────────────── */
  function load() {
    var tok = ++S.token;
    var m = encodeURIComponent(S.month);
    var jobs = [
      api('/api/attendance/overtime-summary?month=' + m),
      api('/api/attendance/overtime-records?scope=mine&month=' + m),
      api('/api/attendance/overtime-records?scope=team&status=Pending').catch(function () { return { items: [] }; })
    ];
    return Promise.all(jobs).then(function (res) {
      if (tok !== S.token) return;
      S.summary = res[0]; S.mine = res[1]; S.team = res[2];
      S.canEdit = !!res[1].canEdit; S.canViewAll = !!res[1].canViewAll; S.isManager = !!res[1].isManager;
      if (S.canViewAll) {
        return api('/api/attendance/overtime-records?scope=all&month=' + m).then(function (d) {
          if (tok === S.token) { S.all = d; paint(); }
        }).catch(function () { if (tok === S.token) paint(); });
      }
      paint();
    }).catch(function (e) {
      if (tok !== S.token) return;
      S.msg = e.message || 'Could not load overtime.'; S.msgKind = 'err';
      paint();
    });
  }

  function say(text, kind) { S.msg = text; S.msgKind = kind || 'ok'; }

  function decideOne(id, action, minutes, note) {
    var body = { action: action };
    if (minutes != null) body.minutes = minutes;
    if (note) body.note = note;
    return api('/api/attendance/overtime-records/' + id + '/decide', { method: 'POST', body: body }).then(function (d) {
      say(((d && d.message) || 'Done.') + (d && d.emailed === false ? ' (The e-mail to the employee could not be sent.)' : ''));
      S.sel = {};
      return load();
    }).catch(function (e) { say(e.message || 'Could not save the decision.', 'err'); paint(); });
  }

  function findRec(id) {
    var lists = [S.team, S.all, S.mine];
    for (var i = 0; i < lists.length; i++) {
      var it = (lists[i] && lists[i].items) || [];
      for (var j = 0; j < it.length; j++) if (String(it[j].id) === String(id)) return it[j];
    }
    return null;
  }

  function modal(rec, mode) {
    var ov = document.createElement('div');
    ov.className = 'ot-overlay';
    var partial = mode === 'partial';
    ov.innerHTML = '<div class="ot-modal" role="dialog" aria-modal="true"><h3>' + (partial ? 'Approve part of the overtime' : 'Reject overtime') + '</h3>' +
      '<div class="ot-muted ot-small">' + esc(rec.employeeName) + ' · ' + esc(fmtDate(rec.date)) + ' · worked ' + esc(hm(rec.workedMinutes)) + ', overtime ' + esc(hm(rec.overtimeMinutes)) + '</div>' +
      (partial ? '<label for="ot-min">Minutes to approve (0–' + rec.overtimeMinutes + ')</label><input id="ot-min" class="input-field" type="number" min="0" max="' + rec.overtimeMinutes + '" step="1" value="' + rec.overtimeMinutes + '">' : '') +
      '<label for="ot-note">Note to the employee' + (partial ? ' (optional)' : '') + '</label><textarea id="ot-note" class="input-field" maxlength="1000"></textarea>' +
      '<div class="ot-msg err" data-ot="merr" style="display:none;margin:10px 0 0"></div>' +
      '<div class="ot-btns"><button type="button" class="btn-sm" data-ot="cancel">Cancel</button>' +
      '<button type="button" class="' + (partial ? 'btn-primary' : 'btn-danger') + ' btn-sm" data-ot="ok">' + (partial ? 'Approve' : 'Reject') + '</button></div></div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.getAttribute('data-ot') === 'cancel') { close(); return; }
      if (e.target.getAttribute('data-ot') !== 'ok') return;
      var note = ov.querySelector('#ot-note').value.trim();
      var err = ov.querySelector('[data-ot="merr"]');
      var minutes = null;
      if (partial) {
        minutes = parseInt(ov.querySelector('#ot-min').value, 10);
        if (isNaN(minutes) || minutes < 0 || minutes > rec.overtimeMinutes) {
          err.style.display = ''; err.textContent = 'Enter minutes from 0 to ' + rec.overtimeMinutes + '.'; return;
        }
      }
      close();
      decideOne(rec.id, partial ? 'approve' : 'reject', minutes, note);
    });
    var first = ov.querySelector(partial ? '#ot-min' : '#ot-note');
    if (first) first.focus();
  }

  function batch(action) {
    var ids = Object.keys(S.sel).filter(function (k) { return S.sel[k]; }).map(Number);
    if (!ids.length) { say('Select at least one record.', 'err'); paint(); return; }
    var note = '';
    if (action === 'reject') {
      note = window.prompt('Reason for rejecting ' + ids.length + ' record(s) (sent to each employee):', '') ;
      if (note === null) return;
    }
    api('/api/attendance/overtime-records/batch', { method: 'POST', body: { action: action, ids: ids, note: note } }).then(function (d) {
      say(d.ok + ' ' + (action === 'approve' ? 'approved' : 'rejected') + (d.failed ? ', ' + d.failed + ' failed: ' +
        d.results.filter(function (r) { return !r.ok; }).map(function (r) { return r.message; }).join('; ') : '') + '.', d.failed ? 'err' : 'ok');
      S.sel = {};
      return load();
    }).catch(function (e) { say(e.message || 'Could not save.', 'err'); paint(); });
  }

  function csv() {
    var rows = [['Employee', 'Email', 'Date', 'Day type', 'Worked (min)', 'Overtime (min)', 'Capped (min)', 'Status', 'Approved (min)', 'Paid OT (min)', 'Comp-off (days)', 'Comp-off expires', 'Decided by', 'Note']];
    filtered().forEach(function (r) {
      rows.push([r.employeeName, r.email, r.date, r.dayType, r.workedMinutes, r.overtimeMinutes, r.cappedMinutes, r.status,
        r.approvedMinutes, r.payableMinutes, r.compOffDays, r.compOffExpires || '', r.decidedBy || '', r.note || '']);
    });
    var text = rows.map(function (r) {
      return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
    var blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'overtime-' + S.month + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 500);
  }

  function recompute(btn) {
    var p = S.month.split('-'), y = +p[0], m = +p[1];
    var last = new Date(y, m, 0).getDate();
    btn.disabled = true; btn.textContent = 'Recomputing…';
    api('/api/attendance/overtime-evaluate', { method: 'POST', body: { from: S.month + '-01', to: S.month + '-' + pad(last) } }).then(function (d) {
      say('Recomputed ' + d.days + ' closed day(s): ' + d.records + ' with overtime (' + d.pending + ' pending).');
      return load();
    }).catch(function (e) { say(e.message || 'Could not recompute.', 'err'); paint(); });
  }

  /* ── events ────────────────────────────────────────────────────────────── */
  function bind(root) {
    root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tab],[data-ot]') : null;
      if (!t || !root.contains(t)) return;
      var tab = t.getAttribute('data-tab');
      if (tab) { S.tab = tab; S.msg = ''; paint(); return; }
      var act = t.getAttribute('data-ot'), id = t.getAttribute('data-id');
      if (act === 'approve') { t.disabled = true; decideOne(id, 'approve'); }
      else if (act === 'partial' || act === 'reject') { var r = findRec(id); if (r) modal(r, act); }
      else if (act === 'batch-approve') batch('approve');
      else if (act === 'batch-reject') batch('reject');
      else if (act === 'csv') csv();
      else if (act === 'recompute') recompute(t);
    });
    root.addEventListener('change', function (e) {
      var act = e.target.getAttribute('data-ot');
      if (act === 'month' && e.target.value) { S.month = e.target.value; S.msg = ''; load(); }
      else if (act === 'fstatus') { S.f.status = e.target.value; paint(); }
      else if (act === 'fday') { S.f.dayType = e.target.value; paint(); }
      else if (act === 'sel') { S.sel[e.target.value] = e.target.checked; }
      else if (act === 'selall') {
        root.querySelectorAll('[data-ot="sel"]').forEach(function (c) { c.checked = e.target.checked; S.sel[c.value] = e.target.checked; });
      }
    });
    var qTimer = null;
    root.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-ot') !== 'q') return;
      var v = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(function () {
        S.f.q = v; paint();
        var q = S.root && S.root.querySelector('[data-ot="q"]');
        if (q) { q.focus(); try { q.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 250);
    });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function mount(root, sub) {
    injectStyle();
    S.root = root; S.msg = ''; S.sel = {};
    if (!S.month) S.month = thisMonth();
    var m = /[?&]tab=(mine|approvals|all)/.exec(location.search || '');
    if (m) S.tab = m[1];
    root.innerHTML = '<div class="ot-page"><div class="ot-empty">Loading overtime…</div></div>';
    bind(root);
    load();
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE,
      title: 'Overtime & Comp-off',
      mount: mount,
      update: function () { if (S.root) load(); },
      unmount: function () { S.token++; S.root = null; }
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
