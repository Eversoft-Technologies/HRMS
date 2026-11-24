/**
 * hrms-myteam.js  v1
 * My Team command center — /my-team (Team Management Phase 1).
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): the page renders into the
 * sidecar's own root; React-owned DOM is never touched.
 *
 * Backend: api/team_hub.py
 *   GET  /api/my-team/summary            {isManager, show, pending, byType}   (sidebar badge)
 *   GET  /api/my-team/members            scope, members, picker options
 *   GET  /api/my-team/inbox              pending approvals the caller may decide
 *   POST /api/my-team/inbox/decide       {type, id, action, note}
 *   POST /api/my-team/inbox/batch        {action, note, items:[{type,id}]}  -> per-item results
 *   GET  /api/my-team/presence           today's radar (auto-refresh 60 s)
 *   GET  /api/my-team/calendar?month=    leave / WFH / holidays / anniversaries / deadlines (+ birthdays opt-in)
 *   GET  /api/my-team/workload?week=     open tasks, hours, overtime, overloaded / under-utilized flags
 * Every scope request carries the same query (indirect, teamId, manager, department, scope).
 * scope=project: the caller's project team (matrix ReportingLine, hrms_plus/org.py) — a
 * "Direct reports | Project team" switch shows when the caller leads any project line.
 * That scope has no Approvals tab: project leads approve nothing (line managers do).
 * Workload shows each person's time split ("60% Project Alpha, 40% line team").
 * Goals tab: GET /api/okr/my-team (+ /api/okr/summary?email= for people it does not
 * cover) — objectives, average progress, at-risk key results, check-ins due.
 *
 * Decisions go through each feature's own endpoint on the server, so this page
 * never applies an approval rule itself — it shows what the server said.
 */
(function () {
  'use strict';
  if (window.__hrmsMyTeamLoaded) return;
  window.__hrmsMyTeamLoaded = true;

  var BASE = '/my-team';
  var STYLE_ID = 'hrms-myteam-style';
  var LS_SCOPE = 'hrms_myteam_scope';
  var LS_TAB = 'hrms_myteam_tab';
  var LS_TH = 'hrms_myteam_thresholds';
  var SC = null;

  var TYPE_CLS = { leave: 'mt-c-accent', wfh: 'mt-c-success', regularization: 'mt-c-warn', timesheet: 'mt-c-muted',
    expense: 'mt-c-violet', loan: 'mt-c-danger', offsite: 'mt-c-warn', overtime: 'mt-c-accent', short_leave: 'mt-c-teal', recheckin: 'mt-c-danger' };
  var BUCKET_CLS = { office: 'success', remote: 'accent', 'break': 'warn', leave: 'violet', notin: 'danger',
    out: 'muted', holiday: 'teal', off: 'muted' };
  var ALLOC_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2'];
  var KIND_LABEL = { leave: 'Leave', wfh: 'WFH', holiday: 'Holiday', deadline: 'Deadline', anniversary: 'Anniversary', birthday: 'Birthday' };
  var KIND_CLS = { leave: 'violet', wfh: 'accent', holiday: 'teal', deadline: 'danger', anniversary: 'success', birthday: 'warn' };
  var TH_FIELDS = [
    ['maxHighTasks', 'Overloaded: open high-priority tasks above', 6],
    ['maxWeekHours', 'Overloaded: hours in the week above', 50],
    ['longDayHours', 'Long day: hours above', 10],
    ['longDayRun', 'Overloaded: long days in a row', 3],
    ['underPct', 'Under-utilized: below % of expected hours', 50],
    ['underMaxTasks', '… and at most this many open tasks', 1]
  ];

  var state = null;
  function fresh() {
    return {
      root: null, token: 0, tab: lsGet(LS_TAB) || 'approvals', scope: readScope(),
      members: null, inbox: null, presence: null, workload: null, calendar: null,
      filter: 'all', selected: {}, busy: false, result: null,
      bucket: '', month: '', week: '', day: '', birthdays: false,
      kinds: { leave: true, wfh: true, holiday: true, deadline: true, anniversary: true, birthday: true },
      timer: null, showTh: false, errors: {}
    };
  }

  /* ── utils ─────────────────────────────────────────────────────────────── */
  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function readScope() { try { var s = JSON.parse(lsGet(LS_SCOPE) || '{}'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; } }
  function readTh() { try { var t = JSON.parse(lsGet(LS_TH) || '{}'); return t && typeof t === 'object' ? t : {}; } catch (_) { return {}; } }
  function qs(obj) {
    var out = [];
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== '' && obj[k] != null && obj[k] !== false) {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] === true ? '1' : obj[k]));
    }
    return out.length ? '?' + out.join('&') : '';
  }
  function scopeQuery(extra) {
    var s = state.scope, q = {};
    if (s.teamId) q.teamId = s.teamId;
    else if (s.manager) q.manager = s.manager;
    else if (s.department) q.department = s.department;
    else if (s.scope) q.scope = s.scope;
    if (s.indirect) q.indirect = 1;
    for (var k in (extra || {})) q[k] = extra[k];
    return qs(q);
  }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: false }); } catch (_) {}
    return String(v).slice(0, 10);
  }
  function fmtDT(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: true }); } catch (_) {}
    return String(v);
  }
  function clock(v) {
    var m = /(\d{2}):(\d{2})/.exec(String(v || '').slice(10));
    if (!m) m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    var h = +m[1], ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  }
  function range(a, b) { return (!b || a === b) ? fmtDate(a) : fmtDate(a) + ' – ' + fmtDate(b); }
  function money(v, cur) {
    if (v == null) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 2 }).format(v); }
    catch (_) { return (cur || '') + ' ' + v; }
  }
  function ago(v) {
    var d = null;
    try { d = window.HRMSCompany && window.HRMSCompany.parseDate ? window.HRMSCompany.parseDate(v) : new Date(String(v).replace(' ', 'T')); } catch (_) {}
    if (!d || isNaN(d.getTime())) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    var days = Math.round(m / 1440);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function parseIso(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function badge(text, cls) { return '<span class="mt-badge mt-c-' + (cls || 'muted') + '">' + esc(text) + '</span>'; }
  function avatar(p) { return '<span class="mt-av" aria-hidden="true">' + esc(p.initials || (p.name || '?').slice(0, 2).toUpperCase()) + '</span>'; }
  function navTo(href) {
    var path = href.split('?')[0];
    if (SC.has && (SC.has(path) || SC.has('/' + path.split('/')[1]))) { SC.go(href); return; }
    if (window.__reactRouterNavigate) { window.__reactRouterNavigate(href); return; }
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  function q(sel) { return state.root ? state.root.querySelector(sel) : null; }
  function qa(sel) { return state.root ? Array.prototype.slice.call(state.root.querySelectorAll(sel)) : []; }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.mt-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.mt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap}',
      '.mt-h1{font-size:20px;font-weight:700;margin:0}',
      '.mt-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.mt-scope{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.mt-scope .input-field{width:auto;min-width:150px;max-width:240px;padding:7px 10px}',
      '.mt-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2);cursor:pointer;user-select:none}',
      '.mt-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}',
      '.mt-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:13px 15px;cursor:pointer;text-align:left;font-family:inherit;color:var(--text);transition:border-color .15s}',
      '.mt-kpi:hover,.mt-kpi:focus-visible{border-color:var(--accent);outline:none}',
      '.mt-kpi span{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}',
      '.mt-kpi b{display:block;font-size:24px;font-weight:700;margin-top:4px}',
      '.mt-kpi.mt-k-warn b{color:var(--warn)}.mt-kpi.mt-k-danger b{color:var(--danger)}.mt-kpi.mt-k-ok b{color:var(--success)}',
      '.mt-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.mt-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.mt-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.mt-tab .mt-n{display:inline-block;min-width:18px;padding:0 6px;margin-left:6px;border-radius:999px;font-size:11px;line-height:18px;background:var(--accent);color:#fff;text-align:center}',
      '.mt-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
      '.mt-chip{border:1px solid var(--border2);background:var(--bg2);color:var(--text2);border-radius:999px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px}',
      '.mt-chip.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--bg2))}',
      '.mt-chip i{font-style:normal;color:var(--text3);font-weight:500}',
      '.mt-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}',
      '.mt-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 12px;margin-bottom:10px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2)}',
      '.mt-bar .mt-btns{display:flex;gap:8px;flex-wrap:wrap}',
      '.mt-list{display:flex;flex-direction:column;gap:8px}',
      '.mt-row{display:grid;grid-template-columns:22px 34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2)}',
      '.mt-row.sel{border-color:color-mix(in srgb,var(--accent) 55%,var(--border2));background:color-mix(in srgb,var(--accent) 6%,var(--bg2))}',
      '.mt-row.gone{opacity:.55}',
      '.mt-av{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,var(--bg3));flex:none}',
      '.mt-main{min-width:0}',
      '.mt-line1{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13.5px}',
      '.mt-line1 b{font-weight:650}',
      '.mt-line2{font-size:12.5px;color:var(--text2);margin-top:3px;display:flex;gap:6px 14px;flex-wrap:wrap}',
      '.mt-reason{font-size:12px;color:var(--text3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:720px}',
      '.mt-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}',
      '.mt-acts .btn-sm,.mt-acts .btn-primary{padding:6px 12px;font-size:12px}',
      '.mt-link{font-size:12px;color:var(--text2);text-decoration:none;white-space:nowrap}',
      '.mt-link:hover{color:var(--accent)}',
      '.mt-msg{font-size:12px;margin-top:4px}',
      '.mt-msg.ok{color:var(--success)}.mt-msg.bad{color:var(--danger)}',
      '.mt-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.mt-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.mt-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.mt-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.mt-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.mt-c-violet{color:#8b5cf6;background:color-mix(in srgb,#8b5cf6 14%,transparent)}',
      '.mt-c-teal{color:#0d9488;background:color-mix(in srgb,#14b8a6 15%,transparent)}',
      'html:not([data-theme="light"]) .mt-c-violet{color:#a78bfa}html:not([data-theme="light"]) .mt-c-teal{color:#2dd4bf}',
      '.mt-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.mt-bg-success{background:var(--success)}.mt-bg-accent{background:var(--accent)}.mt-bg-warn{background:var(--warn)}.mt-bg-danger{background:var(--danger)}',
      '.mt-bg-violet{background:#8b5cf6}.mt-bg-teal{background:#14b8a6}.mt-bg-muted{background:var(--text3)}',
      '.mt-empty{padding:44px 16px;text-align:center;color:var(--text3);font-size:13px}',
      '.mt-empty b{display:block;font-size:16px;color:var(--text);margin:8px 0 4px}',
      '.mt-empty .mt-big{font-size:34px;line-height:1}',
      '.mt-err{padding:11px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px}',
      '.mt-note{padding:10px 14px;border-radius:8px;color:var(--text2);background:var(--bg3);font-size:12.5px;margin-bottom:12px}',
      '.mt-result{border:1px solid var(--border2);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13px;background:var(--bg2)}',
      '.mt-result ul{margin:6px 0 0;padding-left:18px;color:var(--text2);font-size:12.5px}',
      '.mt-people{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}',
      '.mt-person{display:flex;gap:10px;align-items:center;padding:11px 12px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2);min-width:0}',
      '.mt-person .mt-pname,.mt-person .mt-pmeta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mt-pname{font-size:13.5px;font-weight:650}',
      '.mt-pmeta{font-size:12px;color:var(--text3)}',
      '.mt-pstat{font-size:12.5px;margin-top:2px;display:flex;align-items:center;gap:4px 6px;flex-wrap:wrap}',
      '.mt-updated{font-size:11.5px;color:var(--text3)}',
      '.mt-cal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.mt-cal-head h3{margin:0 8px;font-size:15px;min-width:130px}',
      '.mt-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--border2);border-radius:10px;overflow:hidden;background:var(--bg2)}',
      '.mt-dow{font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;padding:7px 8px;border-bottom:1px solid var(--border2);background:var(--bg3)}',
      '.mt-cell{min-height:96px;padding:5px 6px;border:0;border-radius:0;border-right:1px solid var(--border);border-bottom:1px solid var(--border);cursor:pointer;min-width:0;background:none;text-align:left;font-family:inherit;color:inherit;display:block}',
      '.mt-cell:nth-child(7n){border-right:none}',
      '.mt-cell.out{background:var(--bg3);opacity:.55;cursor:default}',
      '.mt-cell.today .mt-dnum{background:var(--accent);color:#fff}',
      '.mt-cell.pick{box-shadow:inset 0 0 0 2px var(--accent)}',
      '.mt-dnum{display:inline-block;font-size:11.5px;font-weight:700;min-width:20px;height:20px;line-height:20px;text-align:center;border-radius:10px;color:var(--text2)}',
      '.mt-ev{display:block;font-size:11px;line-height:1.35;padding:1px 6px;border-radius:5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mt-ev.pending{border:1px dashed currentColor;background:transparent}',
      '.mt-more{font-size:11px;color:var(--text3);margin-top:3px}',
      '.mt-dayp{margin-top:14px}',
      '.mt-dayp h4{margin:0 0 8px;font-size:14px}',
      '.mt-dayp li{font-size:13px;margin:4px 0;list-style:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.mt-dayp ul{padding:0;margin:0}',
      '.mt-table-wrap{overflow-x:auto;border:1px solid var(--border2);border-radius:10px;background:var(--bg2)}',
      '.mt-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.mt-table th{text-align:left;font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;padding:9px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.mt-table td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top}',
      '.mt-table tr:last-child td{border-bottom:none}',
      '.mt-heat{width:150px;height:10px;border-radius:5px;background:var(--bg3);overflow:hidden;border:1px solid var(--border2)}',
      '.mt-heat i{display:block;height:100%;border-radius:5px}',
      '.mt-heat-l{font-size:11.5px;color:var(--text3);margin-top:4px}',
      '.mt-flags{margin:0;padding:0;list-style:none;font-size:12px}',
      '.mt-flags li{margin:2px 0}',
      '.mt-flags .o{color:var(--danger)}.mt-flags .u{color:var(--text2)}',
      '.mt-th{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;padding:12px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2);margin-bottom:12px}',
      '.mt-th label{display:block;font-size:11.5px;color:var(--text3);margin-bottom:4px}',
      '.mt-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.mt-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:480px;padding:20px;color:var(--text)}',
      '.mt-modal h3{margin:0 0 6px;font-size:16px}',
      '.mt-modal textarea{width:100%;min-height:90px;resize:vertical;box-sizing:border-box;margin-top:10px}',
      '.mt-mfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
      '.mt-btn-danger{background:var(--danger);color:#fff;border:none;border-radius:7px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.mt-btn-danger:disabled{opacity:.5;cursor:not-allowed}',
      '.mt-busy{opacity:.6;pointer-events:none}',
      '.mt-seg{display:inline-flex;border:1px solid var(--border2);border-radius:8px;overflow:hidden;background:var(--bg2)}',
      '.mt-seg button{background:none;border:none;padding:7px 12px;font-size:12.5px;font-weight:600;color:var(--text2);cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.mt-seg button+button{border-left:1px solid var(--border2)}',
      '.mt-seg button.on{background:color-mix(in srgb,var(--accent) 14%,var(--bg2));color:var(--accent)}',
      '.mt-seg i{font-style:normal;font-size:11px;margin-left:4px;padding:0 6px;border-radius:999px;background:var(--bg3);color:var(--text2)}',
      '.mt-split{display:flex;width:150px;height:10px;border-radius:5px;overflow:hidden;background:var(--bg3);border:1px solid var(--border2)}',
      '.mt-split i{display:block;height:100%}',
      '.mt-split-line{background:var(--text3);opacity:.45}',
      '@media (max-width:720px){',
      '  .mt-row{grid-template-columns:22px minmax(0,1fr);}',
      '  .mt-row .mt-av{display:none}',
      '  .mt-row .mt-acts{grid-column:1 / -1;justify-content:flex-start}',
      '  .mt-cell{min-height:52px;padding:3px}',
      '  .mt-ev{font-size:0;height:6px;padding:0;margin-top:2px}',
      '  .mt-more{font-size:10px}',
      '  .mt-scope .input-field{min-width:0;max-width:none;flex:1}',
      '}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── loading ───────────────────────────────────────────────────────────── */
  function loadAll() {
    var tok = ++state.token;
    var root = state.root;
    root.innerHTML = '<div class="mt-page"><div class="mt-empty">Loading your team…</div></div>';
    return api('/api/my-team/members' + scopeQuery()).then(function (m) {
      if (tok !== state.token) return;
      // A project lead with no direct reports (and no saved choice) starts on their project team.
      if (m && m.leadsProjects && m.scope && m.scope.kind === 'reports' && !(m.members || []).length &&
          !state.scope.scope && !state.scope.teamId && !state.scope.manager && !state.scope.department) {
        state.scope = { scope: 'project' };
        return loadAll();
      }
      state.members = m;
      return Promise.all([
        loadInbox(true), loadPresence(true),
        api('/api/my-team/workload' + scopeQuery(thParams())).then(function (w) { state.workload = w; }).catch(function (e) { state.errors.workload = e.message; })
      ]).then(function () { if (tok === state.token) render(); });
    }).catch(function (e) {
      if (tok !== state.token) return;
      if (e.status === 403 || e.status === 404) {          // a saved scope that is no longer allowed
        state.scope = {}; lsSet(LS_SCOPE, '{}');
        return loadAll();
      }
      root.innerHTML = '<div class="mt-page"><div class="mt-err">' + esc(e.message || 'Could not load your team.') + '</div>' +
        '<button class="btn-sm" data-mt="retry">Retry</button></div>';
      var b = root.querySelector('[data-mt="retry"]');
      if (b) b.addEventListener('click', loadAll);
    });
  }
  function loadInbox(silent) {
    return api('/api/my-team/inbox' + scopeQuery()).then(function (d) {
      state.inbox = d; delete state.errors.inbox;
      var keep = {};
      (d.items || []).forEach(function (i) { if (state.selected[i.key]) keep[i.key] = true; });
      state.selected = keep;
      if (!silent) render();
    }).catch(function (e) { state.errors.inbox = e.message; if (!silent) render(); });
  }
  function loadPresence(silent) {
    return api('/api/my-team/presence' + scopeQuery()).then(function (d) {
      state.presence = d; state.presenceAt = new Date(); delete state.errors.presence;
      if (!silent) render();
    }).catch(function (e) { state.errors.presence = e.message; if (!silent) render(); });
  }
  function thParams() {
    var t = readTh(), out = {};
    TH_FIELDS.forEach(function (f) { if (t[f[0]] !== undefined && t[f[0]] !== '') out[f[0]] = t[f[0]]; });
    if (state.week) out.week = state.week;
    return out;
  }
  function loadWorkload() {
    var tok = state.token;
    api('/api/my-team/workload' + scopeQuery(thParams())).then(function (w) {
      if (tok !== state.token) return;
      state.workload = w; delete state.errors.workload; render();
    }).catch(function (e) { state.errors.workload = e.message; render(); });
  }
  function loadCalendar() {
    var tok = state.token;
    if (!state.month) { var n = new Date(); state.month = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2); }
    state.calendar = null;
    render();
    api('/api/my-team/calendar' + scopeQuery({ month: state.month, birthdays: state.birthdays ? 1 : '' })).then(function (c) {
      if (tok !== state.token) return;
      state.calendar = c; delete state.errors.calendar; render();
    }).catch(function (e) { state.errors.calendar = e.message; state.calendar = { items: [] }; render(); });
  }

  function startTimer() {
    stopTimer();
    state.timer = setInterval(function () {
      if (!state || !state.root || document.hidden) return;
      loadPresence(state.tab !== 'today').then(function () { if (state.tab !== 'today') renderKpis(); });
    }, 60000);
  }
  function stopTimer() { if (state && state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* ── page ──────────────────────────────────────────────────────────────── */
  function render() {
    if (!state.root) return;
    var m = state.members || {};
    var scrollTop = state.root.scrollTop;
    var noTeam = (m.members || []).length === 0;
    var html = '<div class="mt-page">' +
      '<div class="mt-head"><div><h1 class="mt-h1">My Team</h1><div class="mt-sub">' + esc((m.scope && m.scope.label) || '') +
      (m.scope && m.scope.count != null ? ' · ' + m.scope.count + ' ' + (m.scope.count === 1 ? 'person' : 'people') : '') + '</div></div>' +
      scopeControls(m) + '</div>' +
      '<div class="mt-kpis" data-mt-kpis>' + kpisHtml() + '</div>';
    var pend = state.inbox ? state.inbox.count : 0;
    var tabs = [['approvals', 'Approvals', pend], ['today', 'Team today'], ['calendar', 'Calendar'], ['workload', 'Workload'], ['goals', 'Goals']];
    if (isProject()) {                 // project leads approve nothing: approvals stay with line managers
      tabs = tabs.slice(1);
      if (state.tab === 'approvals') state.tab = 'today';
    }
    html += '<div class="mt-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" role="tab" aria-selected="' + (state.tab === t[0]) + '" class="mt-tab' + (state.tab === t[0] ? ' on' : '') +
        '" data-mt-tab="' + t[0] + '">' + esc(t[1]) + (t[2] ? '<span class="mt-n">' + t[2] + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    if (isProject()) html += '<div class="mt-note">' + esc((state.inbox && state.inbox.note) ||
      'Project leads do not approve requests: leave, WFH, timesheets and the rest stay with each person’s line manager.') + '</div>';
    if (noTeam && state.tab !== 'approvals') html += emptyTeam(m);
    else if (state.tab === 'approvals') html += approvalsHtml(noTeam, m);
    else if (state.tab === 'today') html += todayHtml();
    else if (state.tab === 'calendar') html += calendarHtml();
    else if (state.tab === 'goals') html += goalsHtml();
    else html += workloadHtml();
    html += '</div>';
    state.root.innerHTML = html;
    state.root.scrollTop = scrollTop;
    bind();
  }

  function scopeControls(m) {
    var o = m.options || {}, s = state.scope, h = '<div class="mt-scope">';
    var cur = s.teamId ? 'team:' + s.teamId : s.manager ? 'mgr:' + s.manager : s.department ? 'dept:' + s.department : s.scope === 'all' ? 'all' : s.scope === 'project' ? 'project' : (m.scope && m.scope.kind === 'all' ? 'all' : 'mine');
    var leads = (m.leadsProjects || 0) > 0 || cur === 'project';
    if (leads) {
      // Direct reports (line manager) vs project team (project / scrum lead: no approvals)
      h += '<div class="mt-seg" role="group" aria-label="Which team">' +
        '<button type="button" class="' + (cur !== 'project' ? 'on' : '') + '" data-mt-seg="mine" aria-pressed="' + (cur !== 'project') + '">Direct reports</button>' +
        '<button type="button" class="' + (cur === 'project' ? 'on' : '') + '" data-mt-seg="project" aria-pressed="' + (cur === 'project') + '">Project team' + (m.leadsProjects ? ' <i>' + m.leadsProjects + '</i>' : '') + '</button></div>';
    }
    var opts = '<option value="mine"' + (cur === 'mine' ? ' selected' : '') + '>My reports</option>';
    if (leads) opts += '<option value="project"' + (cur === 'project' ? ' selected' : '') + '>My project team</option>';
    if (m.canViewAll) opts += '<option value="all"' + (cur === 'all' ? ' selected' : '') + '>Everyone</option>';
    if ((o.teams || []).length) {
      opts += '<optgroup label="Teams">' + o.teams.map(function (t) { var v = 'team:' + t.id; return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</optgroup>';
    }
    if ((o.managers || []).length) {
      opts += '<optgroup label="Manager\u2019s team">' + o.managers.map(function (p) { var v = 'mgr:' + p.email; return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</optgroup>';
    }
    if ((o.departments || []).length) {
      opts += '<optgroup label="Department">' + o.departments.map(function (d) { var v = 'dept:' + d; return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('') + '</optgroup>';
    }
    var many = (o.teams || []).length || m.canViewAll;
    if (many) h += '<select class="input-field" data-mt="scope" aria-label="Whose team">' + opts + '</select>';
    if (!s.teamId && !s.department && cur !== 'all' && cur !== 'project') {
      h += '<label class="mt-check"><input type="checkbox" data-mt="indirect"' + (s.indirect ? ' checked' : '') + '> Include indirect reports</label>';
    }
    h += '<button type="button" class="btn-sm" data-mt="refresh" title="Refresh">&#8635; Refresh</button></div>';
    return h;
  }

  function kpisHtml() {
    var c = (state.presence && state.presence.counts) || {};
    var pend = state.inbox ? state.inbox.count : 0;
    var over = state.workload && state.workload.counts ? state.workload.counts.overloaded : 0;
    var k = [
      ['approvals', '', 'Pending approvals', pend, pend ? 'mt-k-warn' : 'mt-k-ok'],
      ['today', 'office', 'In office', c.office || 0, ''],
      ['today', 'remote', 'WFH / remote', c.remote || 0, ''],
      ['today', 'leave', 'On leave', c.leave || 0, ''],
      ['workload', '', 'Overloaded', over, over ? 'mt-k-danger' : '']
    ];
    if (isProject()) k = k.slice(1);
    return k.map(function (x) {
      return '<button type="button" class="mt-kpi ' + x[4] + '" data-mt-go="' + x[0] + '" data-mt-bucket="' + x[1] + '"><span>' + esc(x[2]) + '</span><b>' + x[3] + '</b></button>';
    }).join('');
  }
  function renderKpis() { var el = q('[data-mt-kpis]'); if (el) el.innerHTML = kpisHtml(); bindKpis(); }

  function isProject() { var m = state.members; return !!(m && m.scope && m.scope.kind === 'project'); }
  function allocHtml(a) {
    if (!a) return '<span class="mt-pmeta">—</span>';
    var h = '<div class="mt-split" role="img" aria-label="' + esc(a.label) + '">';
    (a.projects || []).forEach(function (p, i) {
      if (p.pct) h += '<i style="width:' + p.pct + '%;background:' + ALLOC_COLORS[i % ALLOC_COLORS.length] + '" title="' + esc(p.pct + '% ' + p.project) + '"></i>';
    });
    if (a.lineTeamPct) h += '<i class="mt-split-line" style="width:' + a.lineTeamPct + '%" title="' + esc(a.lineTeamPct + '% line team') + '"></i>';
    return h + '</div><div class="mt-heat-l">' + esc(a.label) + '</div>';
  }

  function emptyTeam(m) {
    if (m.scope && m.scope.kind === 'project') {
      return '<div class="card mt-empty"><div class="mt-big">&#128101;</div><b>No project team yet</b>' +
        'Nobody has a current project line to you. HR adds project / scrum leads on the Org Chart.</div>';
    }
    return '<div class="card mt-empty"><div class="mt-big">&#128101;</div><b>No one on this team yet</b>' +
      (m.scope && m.scope.kind === 'reports'
        ? 'Nobody is linked to you as their manager. When HR sets you as someone\u2019s manager (Org Chart or the employee profile), they appear here.'
        : 'This selection has no active members.') + '</div>';
  }

  /* ── approvals ─────────────────────────────────────────────────────────── */
  function visibleItems() {
    var items = (state.inbox && state.inbox.items) || [];
    return state.filter === 'all' ? items : items.filter(function (i) { return i.type === state.filter; });
  }
  function approvalsHtml(noTeam) {
    if (state.errors.inbox) return '<div class="mt-err">' + esc(state.errors.inbox) + '</div>';
    var d = state.inbox || { items: [], byType: {}, types: [] };
    var h = '';
    if (state.result) h += resultHtml(state.result);
    var all = d.items || [];
    if (!all.length) {
      return h + '<div class="card mt-empty"><div class="mt-big">&#10003;</div><b>You\u2019re all caught up</b>' +
        (noTeam ? 'Nothing is waiting for your decision.' : 'No leave, WFH, regularization, timesheet, expense or other request from your team is waiting for you.') + '</div>';
    }
    h += '<div class="mt-chips" role="group" aria-label="Filter by type"><button type="button" class="mt-chip' + (state.filter === 'all' ? ' on' : '') + '" data-mt-filter="all">All <i>' + all.length + '</i></button>';
    (d.types || []).forEach(function (t) {
      var n = (d.byType || {})[t.value] || 0;
      if (n) h += '<button type="button" class="mt-chip' + (state.filter === t.value ? ' on' : '') + '" data-mt-filter="' + esc(t.value) + '">' + esc(t.label) + ' <i>' + n + '</i></button>';
    });
    h += '</div>';
    var vis = visibleItems();
    var nSel = vis.filter(function (i) { return state.selected[i.key]; }).length;
    var allOn = vis.length && nSel === vis.length;
    h += '<div class="mt-bar' + (state.busy ? ' mt-busy' : '') + '"><label class="mt-check"><input type="checkbox" data-mt="all"' + (allOn ? ' checked' : '') +
      ' aria-label="Select all"> Select all ' + (state.filter === 'all' ? '' : esc(((d.types || []).filter(function (t) { return t.value === state.filter; })[0] || {}).label || '')) + ' (' + vis.length + ')</label>' +
      '<div class="mt-btns"><button type="button" class="btn-primary btn-sm" data-mt="bapprove"' + (nSel ? '' : ' disabled') + '>Approve ' + (nSel ? (nSel === vis.length && nSel > 1 ? 'all ' : '') + nSel + ' selected' : 'selected') + '</button>' +
      '<button type="button" class="btn-sm" data-mt="breject"' + (nSel ? '' : ' disabled') + '>Reject ' + (nSel ? nSel + ' selected' : 'selected') + '</button></div></div>';
    h += '<div class="mt-list">' + vis.map(rowHtml).join('') + '</div>';
    return h;
  }
  function rowHtml(i) {
    var sel = !!state.selected[i.key];
    var bits = [];
    if (i.fromDate) bits.push(esc(range(i.fromDate, i.toDate)));
    if (i.detail) bits.push(esc(i.detail));
    if (i.amount != null) bits.push('<b>' + esc(money(i.amount, i.currency)) + '</b>');
    else if (i.type === 'expense') bits.push('<span title="Amounts are shown to holders of the expense approval permission">amount on the claim page</span>');
    if (i.submittedAt) bits.push('<span title="' + esc(fmtDT(i.submittedAt)) + '">submitted ' + esc(ago(i.submittedAt)) + '</span>');
    var st = i._msg ? '<div class="mt-msg ' + (i._ok ? 'ok' : 'bad') + '">' + esc(i._msg) + '</div>' : '';
    return '<div class="mt-row' + (sel ? ' sel' : '') + '" data-key="' + esc(i.key) + '">' +
      '<input type="checkbox" data-mt-sel="' + esc(i.key) + '"' + (sel ? ' checked' : '') + ' aria-label="Select ' + esc(i.typeLabel + ' from ' + i.name) + '">' +
      avatar(i) +
      '<div class="mt-main"><div class="mt-line1"><b>' + esc(i.name) + '</b>' + '<span class="mt-badge ' + (TYPE_CLS[i.type] || 'mt-c-muted') + '">' + esc(i.typeLabel) + '</span>' +
      '<span>' + esc(i.title || '') + '</span>' + (i.late ? badge('Filed late', 'warn') : '') + '</div>' +
      '<div class="mt-line2">' + bits.join('<span aria-hidden="true">·</span>') + '</div>' +
      (i.reason ? '<div class="mt-reason" title="' + esc(i.reason) + '">' + esc(i.reason) + '</div>' : '') + st + '</div>' +
      '<div class="mt-acts"><button type="button" class="btn-primary btn-sm" data-mt-one="approve" data-key="' + esc(i.key) + '">Approve</button>' +
      '<button type="button" class="btn-sm" data-mt-one="reject" data-key="' + esc(i.key) + '">Reject</button>' +
      '<a class="mt-link" href="' + esc(i.link) + '" data-mt-open="' + esc(i.link) + '" title="Open the ' + esc(i.typeLabel.toLowerCase()) + ' page">Details &#8599;</a></div></div>';
  }
  function resultHtml(r) {
    var bad = r.results.filter(function (x) { return !x.ok; });
    var verb = r.action === 'approve' ? 'approved' : 'rejected';
    var byKey = {};
    ((state.lastItems) || []).forEach(function (i) { byKey[i.key] = i; });
    var h = '<div class="mt-result" role="status"><b>' + r.ok + ' ' + verb + '</b>' + (bad.length ? ', <span style="color:var(--danger)">' + bad.length + ' could not be ' + verb + '</span>' : '') +
      ' <button type="button" class="btn-sm" data-mt="dismiss" style="margin-left:8px;padding:3px 9px;font-size:11.5px">Dismiss</button>';
    if (bad.length) {
      h += '<ul>' + bad.map(function (x) {
        var it = byKey[x.key] || {};
        return '<li>' + esc((it.typeLabel || x.type) + (it.name ? ' — ' + it.name : '')) + ': ' + esc(x.message || 'Failed') + '</li>';
      }).join('') + '</ul>';
    }
    return h + '</div>';
  }
  function itemByKey(k) { var it = ((state.inbox && state.inbox.items) || []).filter(function (i) { return i.key === k; }); return it[0] || null; }

  function askNote(items, done) {
    var required = items.some(function (i) { return i.noteRequired; });
    var unstored = items.filter(function (i) { return !i.noteStored; }).length;
    var ov = document.createElement('div');
    ov.className = 'mt-overlay';
    ov.innerHTML = '<div class="mt-modal" role="dialog" aria-modal="true" aria-labelledby="mt-rj-h"><h3 id="mt-rj-h">Reject ' + (items.length === 1 ? 'this request' : items.length + ' requests') + '</h3>' +
      '<div class="mt-sub">' + (required ? 'A reason is required' + (items.length > 1 ? ' (some of these requests need one)' : '') + ' — the employee sees it.' : 'Add an optional note for the employee.') +
      (unstored ? ' Leave and WFH requests don\u2019t keep a note; they will just show Rejected.' : '') + '</div>' +
      '<textarea class="input-field" maxlength="255" placeholder="Reason" aria-label="Reason"></textarea>' +
      '<div class="mt-mfoot"><button type="button" class="btn-sm" data-x="cancel">Cancel</button><button type="button" class="mt-btn-danger" data-x="ok"' + (required ? ' disabled' : '') + '>Reject</button></div></div>';
    document.body.appendChild(ov);
    var ta = ov.querySelector('textarea'), ok = ov.querySelector('[data-x="ok"]');
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ta.addEventListener('input', function () { ok.disabled = required && !ta.value.trim(); });
    ov.querySelector('[data-x="cancel"]').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ok.addEventListener('click', function () { var v = ta.value.trim(); close(); done(v); });
    setTimeout(function () { ta.focus(); }, 30);
  }

  function decideOne(key, action) {
    var it = itemByKey(key);
    if (!it) return;
    var go = function (note) {
      var row = q('.mt-row[data-key="' + cssEsc(key) + '"]');
      if (row) row.classList.add('mt-busy');
      api('/api/my-team/inbox/decide', { method: 'POST', body: { type: it.type, id: it.id, action: action, note: note || '' } })
        .then(function (r) { state.result = null; flash(it, true, r.message); })
        .catch(function (e) { if (row) row.classList.remove('mt-busy'); it._ok = false; it._msg = e.message; render(); });
    };
    if (action === 'reject') askNote([it], go); else go('');
  }
  function flash(it, ok, msg) {
    it._ok = ok; it._msg = msg;
    render();
    setTimeout(function () { loadInbox(false); }, 900);
  }
  function decideBatch(action) {
    var items = visibleItems().filter(function (i) { return state.selected[i.key]; });
    if (!items.length) return;
    var go = function (note) {
      state.busy = true; render();
      state.lastItems = items.slice();
      api('/api/my-team/inbox/batch', { method: 'POST', body: { action: action, note: note || '', items: items.map(function (i) { return { type: i.type, id: i.id }; }) } })
        .then(function (r) {
          state.busy = false; state.result = r; state.selected = {};
          return loadInbox(false);
        })
        .catch(function (e) { state.busy = false; state.result = { action: action, ok: 0, results: items.map(function (i) { return { key: i.key, type: i.type, ok: false, message: e.message }; }) }; render(); });
    };
    if (action === 'reject') askNote(items, go); else go('');
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  /* ── team today ────────────────────────────────────────────────────────── */
  function statusLine(p) {
    switch (p.bucket) {
      case 'office': return 'In office' + (p.checkIn ? ' · in at ' + clock(p.checkIn) : '') + (p.presence && p.presence !== 'Available' && p.presence !== p.status ? ' · ' + p.presence : '') + (p.status !== 'In Office' ? ' · ' + p.status : '');
      case 'remote': return 'Working remotely' + (p.checkIn ? ' · in at ' + clock(p.checkIn) : '') + (p.status !== 'Remote' ? ' · ' + p.status : '');
      case 'break': return 'On break' + (p.since && p.since !== '—' ? ' since ' + p.since : '');
      case 'leave': return 'On leave' + (p.leaveType ? ' · ' + p.leaveType : '');
      case 'out': return 'Checked out' + (p.checkOut ? ' at ' + clock(p.checkOut) : '');
      case 'holiday': return 'Holiday · ' + (p.holiday || '');
      case 'off': return 'Non-working day';
      default:
        return 'Not checked in yet' + (p.shiftStart ? ' · shift ' + clock(p.shiftStart) : '') + (p.wfhApproved ? ' · WFH approved' : '') +
          (p.leaveStatus === 'Pending' ? ' · leave pending' : '');
    }
  }
  function todayHtml() {
    if (state.errors.presence) return '<div class="mt-err">' + esc(state.errors.presence) + '</div>';
    var d = state.presence;
    if (!d) return '<div class="mt-empty">Loading…</div>';
    var h = '<div class="mt-chips" role="group" aria-label="Filter by status"><button type="button" class="mt-chip' + (!state.bucket ? ' on' : '') + '" data-mt-bucket-f="">Everyone <i>' + d.members.length + '</i></button>';
    d.buckets.forEach(function (b) {
      var n = d.counts[b.key] || 0;
      h += '<button type="button" class="mt-chip' + (state.bucket === b.key ? ' on' : '') + '" data-mt-bucket-f="' + b.key + '"' + (n ? '' : ' style="opacity:.6"') + '><span class="mt-dot mt-bg-' + BUCKET_CLS[b.key] + '"></span>' + esc(b.label) + ' <i>' + n + '</i></button>';
    });
    h += '</div>';
    var list = d.members.filter(function (p) { return !state.bucket || p.bucket === state.bucket; });
    h += '<div class="mt-updated" style="margin-bottom:8px">' + esc(fmtDate(d.date)) + ' · updated ' + (state.presenceAt ? esc(clock(('0' + state.presenceAt.getHours()).slice(-2) + ':' + ('0' + state.presenceAt.getMinutes()).slice(-2))) : '') + ' · refreshes every minute</div>';
    if (!list.length) return h + '<div class="card mt-empty">Nobody in this group right now.</div>';
    h += '<div class="mt-people">' + list.map(function (p) {
      var late = p.late ? ' ' + badge('Late', 'danger') : '';
      return '<div class="mt-person">' + avatar(p) + '<div class="mt-main"><div class="mt-pname">' + esc(p.name) + '</div>' +
        '<div class="mt-pmeta">' + esc(p.designation || p.department || p.email) + '</div>' +
        '<div class="mt-pstat"><span><span class="mt-dot mt-bg-' + BUCKET_CLS[p.bucket] + '" style="margin-right:6px"></span>' + esc(statusLine(p)) + '</span>' + late + '</div></div></div>';
    }).join('') + '</div>';
    return h;
  }

  /* ── calendar ──────────────────────────────────────────────────────────── */
  function calendarHtml() {
    var c = state.calendar;
    if (!state.month) { var n0 = new Date(); state.month = n0.getFullYear() + '-' + ('0' + (n0.getMonth() + 1)).slice(-2); }
    var y = +state.month.slice(0, 4), mo = +state.month.slice(5, 7) - 1;
    var title = new Date(y, mo, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var h = '<div class="mt-cal-head"><button type="button" class="btn-sm" data-mt="mprev" aria-label="Previous month">&#8249;</button><h3>' + esc(title) + '</h3>' +
      '<button type="button" class="btn-sm" data-mt="mnext" aria-label="Next month">&#8250;</button><button type="button" class="btn-sm" data-mt="mtoday">Today</button>' +
      '<span style="flex:1"></span>';
    ['leave', 'wfh', 'holiday', 'deadline', 'anniversary'].forEach(function (k) {
      h += '<label class="mt-check"><input type="checkbox" data-mt-kind="' + k + '"' + (state.kinds[k] ? ' checked' : '') + '><span class="mt-dot mt-bg-' + KIND_CLS[k] + '"></span>' + KIND_LABEL[k] + '</label>';
    });
    h += '<label class="mt-check" title="Dates of birth come from onboarding forms. Off by default for privacy."><input type="checkbox" data-mt="bday"' + (state.birthdays ? ' checked' : '') + '><span class="mt-dot mt-bg-warn"></span>Birthdays</label></div>';
    if (state.errors.calendar) h += '<div class="mt-err">' + esc(state.errors.calendar) + '</div>';
    if (state.birthdays && c && !c.birthdaysAvailable) h += '<div class="mt-note">No dates of birth on record for this team (they come from onboarding forms only).</div>';
    if (!c) return h + '<div class="mt-empty">Loading calendar…</div>';
    // expand multi-day items per day
    var byDay = {};
    (c.items || []).forEach(function (it) {
      if (!state.kinds[it.kind] && it.kind !== 'birthday') return;
      var a = parseIso(it.date), b = parseIso(it.end || it.date);
      if (!a) return;
      if (!b || b < a) b = a;
      for (var d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
        var k = iso(d);
        (byDay[k] = byDay[k] || []).push(it);
      }
    });
    state.byDay = byDay;
    var first = new Date(y, mo, 1), startOff = (first.getDay() + 6) % 7;
    var gridStart = new Date(y, mo, 1 - startOff);
    var todayIso = iso(new Date());
    if (!state.day || state.day.slice(0, 7) !== state.month) state.day = todayIso.slice(0, 7) === state.month ? todayIso : iso(first);
    h += '<div class="mt-cal" role="grid">';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (d) { h += '<div class="mt-dow" role="columnheader">' + d + '</div>'; });
    for (var i = 0; i < 42; i++) {
      var day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      if (i >= 35 && day.getMonth() !== mo) break;
      var k2 = iso(day), inMonth = day.getMonth() === mo, evs = byDay[k2] || [];
      var cls = 'mt-cell' + (inMonth ? '' : ' out') + (k2 === todayIso ? ' today' : '') + (inMonth && k2 === state.day ? ' pick' : '');
      h += '<button type="button" class="' + cls + '" data-mt-day="' + (inMonth ? k2 : '') + '" aria-label="' + esc(fmtDate(k2) + ': ' + evs.length + ' item' + (evs.length === 1 ? '' : 's')) + '"' + (inMonth ? '' : ' tabindex="-1"') + '>' +
        '<span class="mt-dnum">' + day.getDate() + '</span>';
      if (inMonth) {
        evs.slice(0, 3).forEach(function (e) { h += '<span class="mt-ev mt-c-' + KIND_CLS[e.kind] + (e.status === 'Pending' ? ' pending' : '') + '">' + esc(evLabel(e, true)) + '</span>'; });
        if (evs.length > 3) h += '<div class="mt-more">+' + (evs.length - 3) + ' more</div>';
      }
      h += '</button>';
    }
    h += '</div>';
    var sel = byDay[state.day] || [];
    h += '<div class="card mt-dayp"><h4>' + esc(fmtDate(state.day)) + '</h4>' + (sel.length ? '<ul>' + sel.map(function (e) {
      return '<li>' + badge(KIND_LABEL[e.kind] || e.kind, KIND_CLS[e.kind]) + '<span>' + esc(evLabel(e, false)) + '</span>' +
        (e.status === 'Pending' ? badge('Pending', 'warn') : '') + (e.overdue ? badge('Overdue', 'danger') : '') + '</li>';
    }).join('') + '</ul>' : '<div class="mt-pmeta">Nothing on this day.</div>') + '</div>';
    return h;
  }
  function evLabel(e, short) {
    if (e.kind === 'holiday') return e.title + (e.count ? (short ? ' (' + e.count + ')' : ' — ' + (e.people || []).join(', ') + (e.count > (e.people || []).length ? '…' : '')) : '') + (e.optional && !short ? ' (optional)' : '');
    if (e.kind === 'leave') return (e.name || '') + (short ? '' : ' — ' + e.title + (e.end && e.end !== e.date ? ' (' + range(e.date, e.end) + ')' : ''));
    if (e.kind === 'wfh') return (e.name || '') + (short ? ' · WFH' : ' — work from home');
    if (e.kind === 'deadline') return (short ? '' : (e.name || '') + ' — ') + e.title + (short ? '' : ' (' + (e.priority || 'medium') + ' priority)');
    if (e.kind === 'anniversary') return (e.name || '') + (short ? '' : ' — ' + e.title);
    if (e.kind === 'birthday') return (e.name || '') + (short ? '' : '\u2019s birthday');
    return e.title || '';
  }

  /* ── goals (OKRs, hrms_plus/okr_views.py) ──────────────────────────────── */
  // One GET /api/okr/my-team (direct reports + teams led); people of the
  // current scope it does not cover (project team, HR scopes) are asked one by
  // one through /api/okr/summary?email= (capped; a 403 just leaves them blank).
  var GOALS_MAX_EXTRA = 30;
  function loadGoals() {
    var tok = state.token;
    state.goals = { loading: true, by: {}, period: '' };
    render();
    var emails = ((state.members && state.members.members) || []).map(function (m) { return m.email; });
    var by = {}, period = '', ok = false;
    api('/api/okr/my-team').then(function (d) {
      ok = true;
      period = (d && d.period) || '';
      ((d && d.members) || []).forEach(function (r) { by[String(r.email || '').toLowerCase()] = r; });
    }).catch(function () {}).then(function () {
      var missing = emails.filter(function (e) { return !by[e]; }).slice(0, GOALS_MAX_EXTRA);
      return Promise.all(missing.map(function (e) {
        return api('/api/okr/summary?email=' + encodeURIComponent(e) + (period ? '&period=' + encodeURIComponent(period) : ''))
          .then(function (r) { if (r) { ok = true; by[e] = r; period = period || r.period || ''; } }).catch(function () {});
      }));
    }).then(function () {
      if (!state || tok !== state.token) return;
      state.goals = { by: by, period: period, none: !ok };
      if (state.tab === 'goals') render();
    });
  }
  function goalsHtml() {
    var g = state.goals;
    if (!g || g.loading) return '<div class="mt-empty">Loading goals…</div>';
    var h = '<div class="mt-cal-head"><h3 style="margin-left:0">Goals' + (g.period ? ' · ' + esc(g.period) : '') + '</h3><span style="flex:1"></span>' +
      '<a class="btn-sm" href="/hr/perform/team" data-mt-goal style="text-decoration:none">Open team goals &#8599;</a></div>';
    var list = ((state.members && state.members.members) || []);
    if (g.none) return h + '<div class="card mt-empty">Goals are not available for this team right now.</div>';
    if (!list.length) return h + '<div class="card mt-empty">No team members.</div>';
    h += '<div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Member</th><th>Progress</th><th>Status</th><th>Last check-in</th><th>Objectives</th></tr></thead><tbody>';
    list.forEach(function (m) {
      var r = g.by[m.email];
      h += '<tr><td><div style="display:flex;gap:8px;align-items:center">' + avatar(m) + '<div><div class="mt-pname">' + esc(m.name) + '</div><div class="mt-pmeta">' + esc(m.designation || '') + '</div></div></div></td>';
      if (!r) { h += '<td colspan="4"><span class="mt-pmeta">Not visible to you</span></td></tr>'; return; }
      var avg = r.avgProgress || 0, risks = r.atRisk || [];
      h += '<td style="white-space:nowrap">' + (r.objectiveCount ? '<div class="mt-heat" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + avg + '" aria-label="Average progress ' + avg + '%"><i class="mt-bg-' + (avg >= 70 ? 'success' : avg >= 35 ? 'accent' : 'warn') + '" style="width:' + Math.min(100, avg) + '%"></i></div>' +
        '<div class="mt-heat-l">' + avg + '% · ' + r.objectiveCount + ' objective' + (r.objectiveCount === 1 ? '' : 's') + '</div>' : '<span class="mt-pmeta">No objectives</span>') + '</td>';
      h += '<td>' + (risks.length ? '<div title="' + esc(risks.map(function (x) { return x.title + ': ' + (x.reason || 'at risk'); }).join('\n')) + '">' + badge(risks.length + ' at risk', 'danger') + '</div>' +
          '<ul class="mt-flags">' + risks.slice(0, 3).map(function (x) { return '<li class="o">' + esc(x.title) + ' — ' + esc(x.reason || 'at risk') + '</li>'; }).join('') + (risks.length > 3 ? '<li class="u">+' + (risks.length - 3) + ' more</li>' : '') + '</ul>' : '') +
        (r.checkInsDue ? '<div style="margin-top:4px">' + badge(r.checkInsDue + ' check-in' + (r.checkInsDue === 1 ? '' : 's') + ' due', 'warn') + '</div>' : '') +
        (!risks.length && !r.checkInsDue ? '<span class="mt-pmeta">On track</span>' : '') + '</td>';
      h += '<td style="white-space:nowrap">' + (r.lastCheckIn ? esc(fmtDate(r.lastCheckIn)) + '<div class="mt-pmeta">' + esc(ago(r.lastCheckIn)) + '</div>' : '<span class="mt-pmeta">Never</span>') + '</td>';
      h += '<td>' + ((r.objectives || []).length ? '<ul class="mt-flags">' + r.objectives.slice(0, 4).map(function (o) {
        return '<li><a class="mt-link" href="/hr/perform/o/' + encodeURIComponent(o.id) + '" data-mt-goal>' + esc(o.title) + '</a> <span class="mt-pmeta">' + esc(o.level || '') + ' · ' + Math.round(o.progress || 0) + '%</span></li>';
      }).join('') + (r.objectives.length > 4 ? '<li class="u">+' + (r.objectives.length - 4) + ' more</li>' : '') + '</ul>' : '<span class="mt-pmeta">—</span>') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ── workload ──────────────────────────────────────────────────────────── */
  function workloadHtml() {
    if (state.errors.workload) return '<div class="mt-err">' + esc(state.errors.workload) + '</div>';
    var w = state.workload;
    if (!w) return '<div class="mt-empty">Loading…</div>';
    var h = '<div class="mt-cal-head"><button type="button" class="btn-sm" data-mt="wprev" aria-label="Previous week">&#8249;</button>' +
      '<h3>Week of ' + esc(fmtDate(w.weekStart)) + '</h3><button type="button" class="btn-sm" data-mt="wnext" aria-label="Next week">&#8250;</button>' +
      '<button type="button" class="btn-sm" data-mt="wthis">This week</button><span style="flex:1"></span>' +
      '<button type="button" class="btn-sm" data-mt="th" aria-expanded="' + state.showTh + '">Thresholds</button></div>';
    if (state.showTh) {
      var t = w.thresholds || {};
      h += '<div class="mt-th">' + TH_FIELDS.map(function (f) {
        return '<div><label for="mt-th-' + f[0] + '">' + esc(f[1]) + '</label><input class="input-field" type="number" min="0" step="1" id="mt-th-' + f[0] + '" data-th="' + f[0] + '" value="' + esc(t[f[0]] != null ? t[f[0]] : f[2]) + '"></div>';
      }).join('') + '<div style="display:flex;gap:8px;align-items:flex-end"><button type="button" class="btn-primary btn-sm" data-mt="thsave">Apply</button><button type="button" class="btn-sm" data-mt="threset">Defaults</button></div></div>';
    }
    var c = w.counts || {};
    h += '<div class="mt-note">Expected hours count the company work days' + (w.expectedThrough ? ' up to ' + esc(fmtDate(w.expectedThrough)) : '') + ', minus holidays and approved leave. Hours = attendance worked time or timesheet hours, whichever is higher. ' +
      '<b>' + (c.overloaded || 0) + '</b> overloaded · <b>' + (c.underutilized || 0) + '</b> under-utilized.</div>';
    if (!w.members.length) return h + '<div class="card mt-empty">No team members.</div>';
    h += '<div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Member</th><th>Load</th><th>Hours</th><th>Open tasks</th><th>Overtime</th><th>Timesheet</th>' + (w.showAllocation ? '<th>Time split</th>' : '') + '<th>Why flagged</th></tr></thead><tbody>';
    w.members.forEach(function (m) {
      var pct = Math.min(m.load, 150) / 150 * 100;
      var col = m.state === 'overloaded' ? 'danger' : m.state === 'underutilized' ? 'muted' : (m.load >= 90 ? 'warn' : 'success');
      var t = m.tasks || {};
      h += '<tr><td><div style="display:flex;gap:8px;align-items:center">' + avatar(m) + '<div><div class="mt-pname">' + esc(m.name) + '</div><div class="mt-pmeta">' + esc(m.designation || '') + '</div></div></div></td>' +
        '<td><div class="mt-heat" role="meter" aria-valuemin="0" aria-valuemax="150" aria-valuenow="' + m.load + '" aria-label="Load ' + m.load + '%"><i class="mt-bg-' + col + '" style="width:' + pct.toFixed(0) + '%"></i></div>' +
        '<div class="mt-heat-l">' + m.load + '% · ' + (m.state === 'overloaded' ? badge('Overloaded', 'danger') : m.state === 'underutilized' ? badge('Under-utilized', 'muted') : badge('OK', 'success')) + '</div></td>' +
        '<td style="white-space:nowrap">' + m.hours + ' h' + (m.expectedHours ? ' / ' + m.expectedHours + ' h' : '') + (m.utilization != null ? '<div class="mt-pmeta">' + m.utilization + '% of expected</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + (t.open || 0) + ' <span class="mt-pmeta">(' + (t.high || 0) + ' high · ' + (t.medium || 0) + ' med · ' + (t.low || 0) + ' low)</span>' + (t.overdue ? '<div>' + badge(t.overdue + ' overdue', 'danger') + '</div>' : '') + '</td>' +
        '<td>' + (m.overtimeDays ? m.overtimeDays + ' day' + (m.overtimeDays === 1 ? '' : 's') : '—') + '</td>' +
        '<td>' + esc(m.timesheetStatus || '') + '</td>' +
        (w.showAllocation ? '<td style="min-width:170px">' + allocHtml(m.allocation) + '</td>' : '') +
        '<td>' + (m.flags.length ? '<ul class="mt-flags">' + m.flags.map(function (f) { return '<li class="' + (f.kind === 'overloaded' ? 'o' : 'u') + '">' + esc(f.reason) + '</li>'; }).join('') + '</ul>' : '<span class="mt-pmeta">—</span>') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ── events ────────────────────────────────────────────────────────────── */
  function setScope(s) {
    state.scope = s; lsSet(LS_SCOPE, JSON.stringify(s));
    state.selected = {}; state.result = null; state.calendar = null; state.goals = null;
    loadAll().then(function () { if (state.tab === 'calendar') loadCalendar(); else if (state.tab === 'goals') loadGoals(); });
  }
  function switchTab(t, bucket) {
    state.tab = t; lsSet(LS_TAB, t);
    if (bucket !== undefined) state.bucket = bucket;
    if (t === 'calendar' && !state.calendar) { loadCalendar(); return; }
    if (t === 'goals' && !state.goals) { loadGoals(); return; }
    render();
  }
  function bindKpis() {
    qa('[data-mt-go]').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-mt-go'), b.getAttribute('data-mt-go') === 'today' ? b.getAttribute('data-mt-bucket') : undefined); });
    });
  }
  function bind() {
    bindKpis();
    qa('[data-mt-tab]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.getAttribute('data-mt-tab')); }); });
    var sc = q('[data-mt="scope"]');
    if (sc) sc.addEventListener('change', function () {
      var v = sc.value, s = { indirect: state.scope.indirect };
      if (v === 'all') s = { scope: 'all' };
      else if (v.indexOf('team:') === 0) s = { teamId: v.slice(5) };
      else if (v.indexOf('mgr:') === 0) s.manager = v.slice(4);
      else if (v.indexOf('dept:') === 0) s = { department: v.slice(5) };
      else if (v === 'project') s = { scope: 'project' };
      else s.scope = 'reports';
      setScope(s);
    });
    qa('[data-mt-seg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-mt-seg');
        setScope(v === 'project' ? { scope: 'project' } : { scope: 'reports', indirect: state.scope.indirect });
      });
    });
    var ind = q('[data-mt="indirect"]');
    if (ind) ind.addEventListener('change', function () { var s = JSON.parse(JSON.stringify(state.scope)); s.indirect = ind.checked; setScope(s); });
    var rf = q('[data-mt="refresh"]');
    if (rf) rf.addEventListener('click', function () { state.result = null; state.goals = null; loadAll().then(function () { if (state.tab === 'calendar') loadCalendar(); else if (state.tab === 'goals') loadGoals(); }); });
    qa('[data-mt-goal]').forEach(function (a) { a.addEventListener('click', function (e) { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navTo(a.getAttribute('href')); }); });
    // approvals
    qa('[data-mt-filter]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-mt-filter'); render(); }); });
    var all = q('[data-mt="all"]');
    if (all) all.addEventListener('change', function () { visibleItems().forEach(function (i) { if (all.checked) state.selected[i.key] = true; else delete state.selected[i.key]; }); render(); });
    qa('[data-mt-sel]').forEach(function (cb) { cb.addEventListener('change', function () { var k = cb.getAttribute('data-mt-sel'); if (cb.checked) state.selected[k] = true; else delete state.selected[k]; render(); }); });
    qa('[data-mt-one]').forEach(function (b) { b.addEventListener('click', function () { decideOne(b.getAttribute('data-key'), b.getAttribute('data-mt-one')); }); });
    var ba = q('[data-mt="bapprove"]'); if (ba) ba.addEventListener('click', function () { decideBatch('approve'); });
    var br = q('[data-mt="breject"]'); if (br) br.addEventListener('click', function () { decideBatch('reject'); });
    var dm = q('[data-mt="dismiss"]'); if (dm) dm.addEventListener('click', function () { state.result = null; render(); });
    qa('[data-mt-open]').forEach(function (a) { a.addEventListener('click', function (e) { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); e.stopPropagation(); navTo(a.getAttribute('data-mt-open')); }); });
    // today
    qa('[data-mt-bucket-f]').forEach(function (b) { b.addEventListener('click', function () { state.bucket = b.getAttribute('data-mt-bucket-f'); render(); }); });
    // calendar
    function shiftMonth(n) { var y = +state.month.slice(0, 4), m = +state.month.slice(5, 7) - 1 + n; var d = new Date(y, m, 1); state.month = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); loadCalendar(); }
    var mp = q('[data-mt="mprev"]'); if (mp) mp.addEventListener('click', function () { shiftMonth(-1); });
    var mn = q('[data-mt="mnext"]'); if (mn) mn.addEventListener('click', function () { shiftMonth(1); });
    var mt = q('[data-mt="mtoday"]'); if (mt) mt.addEventListener('click', function () { state.month = ''; state.day = ''; loadCalendar(); });
    var bd = q('[data-mt="bday"]'); if (bd) bd.addEventListener('change', function () { state.birthdays = bd.checked; loadCalendar(); });
    qa('[data-mt-kind]').forEach(function (cb) { cb.addEventListener('change', function () { state.kinds[cb.getAttribute('data-mt-kind')] = cb.checked; render(); }); });
    qa('[data-mt-day]').forEach(function (b) { b.addEventListener('click', function () { var d = b.getAttribute('data-mt-day'); if (d) { state.day = d; render(); } }); });
    // workload
    function shiftWeek(n) {
      var base = parseIso(state.week || (state.workload && state.workload.weekStart)) || new Date();
      base.setDate(base.getDate() + 7 * n); state.week = iso(base); loadWorkload();
    }
    var wp = q('[data-mt="wprev"]'); if (wp) wp.addEventListener('click', function () { shiftWeek(-1); });
    var wn = q('[data-mt="wnext"]'); if (wn) wn.addEventListener('click', function () { shiftWeek(1); });
    var wt = q('[data-mt="wthis"]'); if (wt) wt.addEventListener('click', function () { state.week = ''; loadWorkload(); });
    var th = q('[data-mt="th"]'); if (th) th.addEventListener('click', function () { state.showTh = !state.showTh; render(); });
    var ts = q('[data-mt="thsave"]');
    if (ts) ts.addEventListener('click', function () {
      var t = {};
      qa('[data-th]').forEach(function (inp) { if (inp.value !== '') t[inp.getAttribute('data-th')] = inp.value; });
      lsSet(LS_TH, JSON.stringify(t)); loadWorkload();
    });
    var tr = q('[data-mt="threset"]'); if (tr) tr.addEventListener('click', function () { lsSet(LS_TH, '{}'); loadWorkload(); });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function mount(root) {
    if (!state || state.root !== root) {
      var keepScope = state ? state.scope : null;
      stopTimer();
      state = fresh();
      if (keepScope) state.scope = keepScope;
    }
    state.root = root;
    injectStyle();
    loadAll().then(function () { if (state && state.tab === 'calendar') loadCalendar(); else if (state && state.tab === 'goals') loadGoals(); });
    startTimer();
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE,
      title: 'My Team',
      mount: mount,
      update: function () {},
      unmount: function () {
        stopTimer();
        if (state) { state.token++; state.root = null; }
        var ov = document.querySelector('.mt-overlay');
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      }
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
