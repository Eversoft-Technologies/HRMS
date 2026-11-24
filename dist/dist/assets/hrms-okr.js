/**
 * hrms-okr.js  v1
 * Goals & OKRs — /goals (also mounted on HR Management > Perform, /hr/perform,
 * which in the React bundle is a static mock with hard-coded numbers).
 *
 * Views: Company tree · My goals · My team · Check-ins, plus an objective
 * drawer (KRs, check-in history sparkline, alignment breadcrumb) and
 * create/edit modals with an alignment picker.
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): renders into the sidecar's
 * own root; drawer / modals / toast are our own nodes on <body>. React-owned
 * DOM is never touched.
 *
 * Backend: hrms_plus/okr_views.py (routes hrms_plus/urls_okr.py, /api/okr/...)
 */
(function () {
  'use strict';
  if (window.__hrmsOkrLoaded) return;
  window.__hrmsOkrLoaded = true;

  var STYLE_ID = 'hrms-okr-style';
  var SC = null;
  var LEVEL_LABEL = { company: 'Company', department: 'Department', team: 'Team', individual: 'Individual' };
  var NEXT_LEVEL = { company: 'department', department: 'team', team: 'individual', individual: 'individual' };
  var METRIC_LABEL = { percent: 'Percent', number: 'Number', currency: 'Currency', boolean: 'Done / not done', milestone: 'Milestones / tasks' };
  var VIEWS = [['', 'Company tree'], ['/mine', 'My goals'], ['/team', 'My team'], ['/check-ins', 'Check-ins']];

  var state = {
    root: null, base: '/goals', sub: '', meta: null, period: '', token: 0,
    collapsed: {}, filters: { level: '', department: '', q: '' }, searchTimer: null,
    drawerId: null, openTeamMember: null
  };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function enc(v) { return encodeURIComponent(v == null ? '' : v); }
  function fmtDate(v, time) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: !!time }); } catch (_) {}
    return String(v);
  }
  function round(n) { return Math.round(Number(n) || 0); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtNum(v) {
    var n = num(v);
    return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
  }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.okr-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.okr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.okr-h1{font-size:20px;font-weight:700;margin:0}',
      '.okr-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.okr-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.okr-actions .input-field{width:auto;padding:7px 10px}',
      '.okr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}',
      '.okr-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 16px}',
      '.okr-kpi span{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.8px}',
      '.okr-kpi b{display:block;font-size:22px;font-weight:700;margin-top:4px}',
      '.okr-kpi.okr-k-warn b{color:var(--warn)}.okr-kpi.okr-k-danger b{color:var(--danger)}',
      '.okr-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.okr-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap;text-decoration:none}',
      '.okr-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.okr-count{display:inline-block;min-width:18px;padding:0 6px;margin-left:6px;border-radius:999px;font-size:11px;line-height:18px;text-align:center;background:var(--danger);color:#fff}',
      '.okr-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.okr-filters .input-field{width:auto;min-width:140px;padding:7px 10px}',
      '.okr-filters .okr-search{flex:1;min-width:180px}',
      '.okr-tree{display:flex;flex-direction:column;gap:6px}',
      '.okr-kids{margin-left:22px;padding-left:12px;border-left:2px solid var(--border2);display:flex;flex-direction:column;gap:6px;margin-top:6px}',
      '.okr-node{display:grid;grid-template-columns:22px minmax(0,1fr) 190px;gap:10px;align-items:center;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s}',
      '.okr-node:hover{border-color:var(--accent)}',
      '.okr-caret{background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;width:22px;height:22px;border-radius:5px;padding:0;font-family:inherit}',
      '.okr-caret:hover{background:var(--bg3);color:var(--text)}',
      '.okr-title{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.okr-meta{font-size:11.5px;color:var(--text3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.okr-prog{display:flex;align-items:center;gap:8px}',
      '.okr-bar{flex:1;height:8px;border-radius:999px;background:var(--bg3);overflow:hidden;position:relative;border:1px solid var(--border)}',
      '.okr-bar i{display:block;height:100%;border-radius:999px;background:var(--accent);transition:width .3s}',
      '.okr-bar.ok i{background:var(--success)}.okr-bar.risk i{background:var(--warn)}.okr-bar.bad i{background:var(--danger)}',
      '.okr-bar em{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--text3);opacity:.6}',
      '.okr-pct{font-size:12px;font-weight:700;min-width:38px;text-align:right}',
      '.okr-dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;background:var(--text3)}',
      '.okr-dot.c-hi{background:var(--success)}.okr-dot.c-mid{background:var(--warn)}.okr-dot.c-lo{background:var(--danger)}',
      '.okr-chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap}',
      '.okr-l-company{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}',
      '.okr-l-department{color:#8b5cf6;background:color-mix(in srgb,#8b5cf6 14%,transparent)}',
      '.okr-l-team{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.okr-l-individual{color:var(--text2);background:var(--bg3);border:1px solid var(--border2)}',
      '.okr-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}',
      '.okr-b-ok{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.okr-b-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.okr-b-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.okr-b-muted{color:var(--text2);background:var(--bg3)}',
      '.okr-empty{padding:36px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.okr-err{padding:10px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin:8px 0}',
      '.okr-section{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin:16px 0 8px}',
      '.okr-table-wrap{overflow-x:auto}',
      '.okr-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.okr-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.okr-table td{padding:10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.okr-table tbody tr.okr-row{cursor:pointer}',
      '.okr-table tbody tr.okr-row:hover td{background:var(--bg3)}',
      '.okr-sublist{display:flex;flex-direction:column;gap:6px;padding:4px 0 6px}',
      '.okr-mini{display:flex;align-items:center;gap:10px;font-size:12.5px;padding:6px 10px;border-radius:8px;background:var(--bg3);cursor:pointer}',
      '.okr-mini:hover{outline:1px solid var(--accent)}',
      '.okr-mini .okr-bar{max-width:140px}',
      '.okr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}',
      '.okr-ci{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:14px 16px}',
      '.okr-ci h4{margin:4px 0 2px;font-size:14px}',
      '.okr-ci .okr-meta{margin-bottom:10px}',
      '.okr-form-row{display:flex;align-items:center;gap:10px;margin:8px 0}',
      '.okr-form-row label{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;min-width:84px}',
      '.okr-form-row input[type=range]{flex:1;accent-color:var(--accent);min-width:0}',
      '.okr-form-row .input-field{padding:6px 9px}',
      '.okr-val{width:96px!important;flex:none}',
      '.okr-conf-v{font-weight:700;min-width:28px;text-align:right}',
      '.okr-conf-v.c-hi{color:var(--success)}.okr-conf-v.c-mid{color:var(--warn)}.okr-conf-v.c-lo{color:var(--danger)}',
      '.okr-ci textarea{min-height:56px;resize:vertical}',
      '.okr-ci-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '.okr-preview{font-size:12px;color:var(--text2)}',
      '.okr-done-list{display:flex;flex-direction:column;gap:6px}',
      /* drawer */
      '.okr-shade{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:990}',
      '.okr-drawer{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;background:var(--bg2);border-left:1px solid var(--border2);z-index:991;overflow-y:auto;color:var(--text);box-shadow:-12px 0 32px rgba(0,0,0,.35);padding:18px 20px 40px}',
      'html[data-theme="light"] .okr-drawer{box-shadow:-12px 0 32px rgba(15,23,42,.12)}',
      'html[data-theme="light"] .okr-shade{background:rgba(15,23,42,.25)}',
      '.okr-dh{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}',
      '.okr-x{background:none;border:none;color:var(--text3);font-size:22px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px}',
      '.okr-x:hover{background:var(--bg3);color:var(--text)}',
      '.okr-crumb{font-size:12px;color:var(--text3);display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px}',
      '.okr-crumb a{color:var(--text2);text-decoration:none;cursor:pointer}',
      '.okr-crumb a:hover{color:var(--accent)}',
      '.okr-dtitle{font-size:18px;font-weight:700;margin:4px 0 6px;word-break:break-word}',
      '.okr-desc{white-space:pre-wrap;font-size:13px;line-height:1.55;color:var(--text2);margin:10px 0}',
      '.okr-big{display:flex;align-items:center;gap:12px;margin:12px 0}',
      '.okr-big .okr-bar{height:12px}',
      '.okr-big .okr-pct{font-size:18px;min-width:52px}',
      '.okr-kr{border:1px solid var(--border2);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--bg3)}',
      '.okr-kr-h{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}',
      '.okr-kr-t{font-weight:600;font-size:13.5px;word-break:break-word}',
      '.okr-kr .okr-ci{background:var(--bg2);margin-top:10px}',
      '.okr-spark{display:block}',
      '.okr-spark polyline{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
      '.okr-spark circle{fill:var(--accent)}',
      '.okr-spark line{stroke:var(--border2);stroke-dasharray:3 3}',
      '.okr-note{font-size:12px;color:var(--text2);margin-top:6px;font-style:italic;word-break:break-word}',
      '.okr-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.okr-link{background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;padding:0;font-family:inherit}',
      '.okr-link.danger{color:var(--danger)}',
      /* modal */
      '.okr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      'html[data-theme="light"] .okr-overlay{background:rgba(15,23,42,.3)}',
      '.okr-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:560px;padding:20px 22px;color:var(--text);max-height:92vh;overflow:auto}',
      '.okr-modal h3{margin:0 0 14px;font-size:16px}',
      '.okr-field{margin-bottom:12px}',
      '.okr-field>label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.okr-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.okr-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}',
      '.okr-hint{font-size:11.5px;color:var(--text3);margin-top:4px}',
      '.okr-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.okr-tasks{max-height:320px;overflow:auto;border:1px solid var(--border2);border-radius:8px}',
      '.okr-task{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;cursor:pointer}',
      '.okr-task:last-child{border-bottom:none}',
      '.okr-busy{opacity:.6;pointer-events:none}',
      '.okr-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:10px;padding:10px 16px;font-size:13px;z-index:1100;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
      '@media (max-width:720px){',
      '.okr-node{grid-template-columns:22px minmax(0,1fr);}',
      '.okr-node .okr-prog{grid-column:2}',
      '.okr-kids{margin-left:8px;padding-left:8px}',
      '.okr-row2,.okr-row3{grid-template-columns:1fr}',
      '.okr-cards{grid-template-columns:1fr}',
      '.okr-drawer{width:100vw;padding:14px 14px 40px}',
      '.okr-form-row label{min-width:70px}',
      '.okr-hide-sm{display:none}',
      '}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── small renderers ───────────────────────────────────────────────────── */
  function confCls(c) { c = Number(c); if (!c) return ''; return c >= 7 ? 'c-hi' : (c >= 5 ? 'c-mid' : 'c-lo'); }
  function dot(c, title) {
    return '<span class="okr-dot ' + confCls(c) + '" title="' + esc(title || (c ? 'Confidence ' + c + '/10' : 'No key results yet')) + '"></span>';
  }
  function levelChip(l) { return '<span class="okr-chip okr-l-' + esc(l) + '">' + esc(LEVEL_LABEL[l] || l) + '</span>'; }
  function statusBadge(s) {
    if (s === 'active') return '';
    var cls = { completed: 'okr-b-ok', cancelled: 'okr-b-muted', draft: 'okr-b-muted' }[s] || 'okr-b-muted';
    return '<span class="okr-badge ' + cls + '">' + esc(s.charAt(0).toUpperCase() + s.slice(1)) + '</span>';
  }
  function bar(p, opts) {
    opts = opts || {};
    var cls = opts.cls || (p >= 100 ? 'ok' : (opts.risk ? 'risk' : ''));
    var mark = opts.expected != null && opts.expected > 0 && opts.expected < 100
      ? '<em style="left:' + opts.expected + '%" title="Time elapsed: ' + round(opts.expected) + '%"></em>' : '';
    return '<div class="okr-prog"><div class="okr-bar ' + cls + '"><i style="width:' + Math.max(0, Math.min(100, num(p))) + '%"></i>' + mark +
      '</div><span class="okr-pct">' + round(p) + '%</span></div>';
  }
  function options(list, selected, blank) {
    var out = blank != null ? '<option value="">' + esc(blank) + '</option>' : '';
    for (var i = 0; i < list.length; i++) {
      var v = typeof list[i] === 'object' ? list[i].value : list[i];
      var l = typeof list[i] === 'object' ? list[i].label : list[i];
      out += '<option value="' + esc(v) + '"' + (String(v) === String(selected == null ? '' : selected) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }
    return out;
  }
  function sparkline(checkIns) {
    var pts = (checkIns || []).slice().reverse();
    if (pts.length < 1) return '<span class="okr-hint">No check-ins yet</span>';
    var w = 140, h = 30, n = pts.length;
    var coords = pts.map(function (c, i) {
      var x = n === 1 ? w / 2 : 3 + i * (w - 6) / (n - 1);
      var y = h - 3 - (Math.max(0, Math.min(100, num(c.progress))) / 100) * (h - 6);
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    });
    var last = coords[coords.length - 1];
    return '<svg class="okr-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Progress over ' + n + ' check-ins">' +
      '<line x1="0" y1="3" x2="' + w + '" y2="3"></line>' +
      '<polyline points="' + coords.map(function (c) { return c.join(','); }).join(' ') + '"></polyline>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3"></circle></svg>';
  }
  function valueText(kr) {
    if (kr.metric === 'boolean') return num(kr.currentValue) >= 1 ? 'Done' : 'Not done';
    if (kr.metric === 'milestone') {
      var t = kr.taskIds && kr.taskIds.length ? ' tasks' : ' steps';
      return fmtNum(kr.currentValue) + ' / ' + fmtNum(kr.targetValue) + t;
    }
    var u = kr.unit ? ' ' + kr.unit : (kr.metric === 'percent' ? '%' : '');
    return fmtNum(kr.currentValue) + u + ' (' + fmtNum(kr.startValue) + ' → ' + fmtNum(kr.targetValue) + u + ')';
  }
  function krProgress(kr, value) {
    var s = num(kr.startValue), t = num(kr.targetValue), c = num(value);
    if (kr.metric === 'boolean') return c >= 1 ? 100 : 0;
    if (t === s) return c >= t ? 100 : 0;
    return Math.max(0, Math.min(100, (c - s) / (t - s) * 100));
  }
  function toast(msg) {
    var old = document.querySelector('.okr-toast');
    if (old) old.parentNode.removeChild(old);
    var t = document.createElement('div');
    t.className = 'okr-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }
  function errHtml(e) { return '<div class="okr-err">' + esc((e && e.message) || 'Something went wrong.') + '</div>'; }

  /* ── data ──────────────────────────────────────────────────────────────── */
  function loadMeta(force) {
    if (state.meta && !force) return Promise.resolve(state.meta);
    return api('/api/okr/meta').then(function (m) {
      state.meta = m;
      if (!state.period) state.period = m.currentPeriod;
      return m;
    });
  }
  function path(sub) { return state.base + (sub || ''); }

  /* ── page shell ────────────────────────────────────────────────────────── */
  function renderPage() {
    var root = state.root;
    if (!root) return;
    var tok = ++state.token;
    root.innerHTML = '<div class="okr-page"><div class="okr-empty">Loading goals…</div></div>';
    loadMeta(false).then(function (meta) {
      return Promise.all([api('/api/okr/summary?period=' + enc(state.period)), api('/api/okr/check-ins/due')]).then(function (r) {
        if (tok !== state.token) return;
        paintShell(meta, r[0], r[1]);
      });
    }).catch(function (e) {
      if (tok !== state.token) return;
      root.innerHTML = '<div class="okr-page">' + errHtml(e) + '</div>';
    });
  }

  function paintShell(meta, mine, due) {
    var root = state.root;
    var sub = state.sub;
    var dueCount = (due && due.due || []).length;
    var periods = (meta.periods || []).map(function (p) { return { value: p, label: p + (p === meta.currentPeriod ? ' (current)' : '') }; });
    var tabs = VIEWS.filter(function (v) { return v[0] !== '/team' || meta.isManager || meta.canManage; });
    var risk = (mine.atRisk || []).length;
    root.innerHTML =
      '<div class="okr-page">' +
        '<div class="okr-head"><div><h1 class="okr-h1">Goals &amp; OKRs</h1>' +
          '<div class="okr-sub">Company → Department → Team → Individual · week ' + esc(meta.week) + '</div></div>' +
          '<div class="okr-actions">' +
            '<select class="input-field" data-okr="period" aria-label="Period">' + options(periods, state.period) + '</select>' +
            '<button class="btn-sm" data-okr="copy" title="Copy objectives under 100% that you can edit into the next quarter">Copy unfinished → next quarter</button>' +
            '<button class="btn-primary" data-okr="new">+ New objective</button>' +
          '</div></div>' +
        '<div class="okr-kpis">' +
          '<div class="okr-kpi"><span>My objectives</span><b>' + (mine.objectiveCount || 0) + '</b></div>' +
          '<div class="okr-kpi"><span>My average progress</span><b>' + (mine.avgProgress == null ? '—' : round(mine.avgProgress) + '%') + '</b></div>' +
          '<div class="okr-kpi ' + (risk ? 'okr-k-warn' : '') + '"><span>My at-risk key results</span><b>' + risk + '</b></div>' +
          '<div class="okr-kpi ' + (dueCount ? 'okr-k-danger' : '') + '"><span>Check-ins due this week</span><b>' + dueCount + '</b></div>' +
        '</div>' +
        '<div class="okr-tabs" role="tablist">' + tabs.map(function (t) {
          return '<a class="okr-tab' + (sub === t[0] ? ' on' : '') + '" href="' + esc(path(t[0])) + '" role="tab">' + esc(t[1]) +
            (t[0] === '/check-ins' && dueCount ? '<span class="okr-count">' + dueCount + '</span>' : '') + '</a>';
        }).join('') + '</div>' +
        '<div data-okr="body"></div>' +
      '</div>';
    root.querySelector('[data-okr="period"]').addEventListener('change', function (e) { state.period = e.target.value; renderPage(); });
    root.querySelector('[data-okr="new"]').addEventListener('click', function () { openObjectiveModal(null, {}); });
    root.querySelector('[data-okr="copy"]').addEventListener('click', copyForward);
    var body = root.querySelector('[data-okr="body"]');
    if (sub === '/mine') renderMine(body);
    else if (sub === '/team') renderTeam(body);
    else if (sub === '/check-ins') renderCheckins(body, due);
    else renderTree(body);
  }

  function copyForward() {
    var p = state.period;
    if (!window.confirm('Copy every objective in ' + p + ' that is not finished (and that you can edit) into the next quarter? Unfinished key results come along with their current values.')) return;
    api('/api/okr/copy-forward', { method: 'POST', body: { period: p } }).then(function (r) {
      toast(r.message || 'Copied.');
      state.period = r.period;
      loadMeta(true).then(renderPage);
    }).catch(function (e) { toast(e.message || 'Could not copy.'); });
  }

  /* ── tree ──────────────────────────────────────────────────────────────── */
  function nodeHtml(o) {
    var kids = o.children || [];
    var open = !state.collapsed[o.id];
    var meta = [levelChip(o.level), '<span>' + esc(o.ownerName || o.ownerEmail) + '</span>'];
    if (o.teamName) meta.push('<span>· ' + esc(o.teamName) + '</span>');
    else if (o.department && o.level !== 'company') meta.push('<span>· ' + esc(o.department) + '</span>');
    meta.push('<span>· ' + o.krCount + ' KR' + (o.krCount === 1 ? '' : 's') + '</span>');
    if (o.visibility !== 'public') meta.push('<span class="okr-badge okr-b-muted">' + esc(o.visibility) + '</span>');
    if (o.atRisk) meta.push('<span class="okr-badge okr-b-warn">' + o.atRisk + ' at risk</span>');
    var sb = statusBadge(o.status);
    if (sb) meta.push(sb);
    return '<div class="okr-branch">' +
      '<div class="okr-node" data-open="' + o.id + '">' +
        (kids.length ? '<button class="okr-caret" data-toggle="' + o.id + '" aria-label="' + (open ? 'Collapse' : 'Expand') + '">' + (open ? '▾' : '▸') + '</button>' : '<span></span>') +
        '<div style="min-width:0"><div class="okr-title">' + dot(o.minConfidence) + ' ' + esc(o.title) + '</div><div class="okr-meta">' + meta.join('') + '</div></div>' +
        bar(o.progress, { risk: o.atRisk > 0, cls: o.status === 'completed' ? 'ok' : '' }) +
      '</div>' +
      (kids.length && open ? '<div class="okr-kids">' + kids.map(nodeHtml).join('') + '</div>' : '') +
    '</div>';
  }

  function bindNodes(el, rerender) {
    Array.prototype.forEach.call(el.querySelectorAll('[data-toggle]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-toggle');
        state.collapsed[id] = !state.collapsed[id];
        rerender();
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-open]'), function (n) {
      n.addEventListener('click', function () { openDrawer(Number(n.getAttribute('data-open'))); });
    });
  }

  function renderTree(body) {
    var meta = state.meta, f = state.filters, tok = state.token;
    body.innerHTML =
      '<div class="okr-filters">' +
        '<select class="input-field" data-f="level">' + options(meta.levels.map(function (l) { return { value: l, label: LEVEL_LABEL[l] }; }), f.level, 'All levels') + '</select>' +
        '<select class="input-field" data-f="department">' + options(meta.departments || [], f.department, 'All departments') + '</select>' +
        '<input class="input-field okr-search" data-f="q" placeholder="Search objectives…" value="' + esc(f.q) + '">' +
        '<button class="btn-sm" data-okr="expand">Expand all</button><button class="btn-sm" data-okr="collapse">Collapse all</button>' +
      '</div><div data-okr="tree"><div class="okr-empty">Loading…</div></div>';
    var holder = body.querySelector('[data-okr="tree"]');
    var data = null;
    function paint() {
      if (!data) return;
      if (!data.tree.length) {
        // An empty tree used to show only text, which read as "the tab does
        // nothing". Offer the next step as a real button.
        var filtered = !!(f.level || f.department || f.q);
        holder.innerHTML = filtered
          ? '<div class="okr-empty">No objectives match these filters in ' + esc(state.period) + '.' +
            '<br><br><button class="btn-sm" data-okr="clear-filters">Clear filters</button></div>'
          : '<div class="okr-empty">No objectives for ' + esc(state.period) + ' yet.' +
            (meta.canManage ? ' Start with a company objective — department, team and personal goals can then align under it.'
                            : ' Add your own and align it under a company or team goal.') +
            '<br><br><button class="btn-primary" data-okr="new-empty">' +
            (meta.canManage ? '+ Create company objective' : '+ Add my objective') + '</button></div>';
        var nb = holder.querySelector('[data-okr="new-empty"]');
        if (nb) nb.addEventListener('click', function () { openObjectiveModal(null, { level: meta.canManage ? 'company' : 'individual' }); });
        var cb = holder.querySelector('[data-okr="clear-filters"]');
        if (cb) cb.addEventListener('click', function () {
          f.level = ''; f.department = ''; f.q = '';
          Array.prototype.forEach.call(body.querySelectorAll('select, input'), function (el) { if (el.closest('[data-okr="tree"]')) return; if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = ''; });
          load();
        });
        return;
      }
      holder.innerHTML = '<div class="okr-tree">' + data.tree.map(nodeHtml).join('') + '</div>';
      bindNodes(holder, paint);
    }
    function load() {
      var q = '/api/okr/objectives?tree=1&period=' + enc(state.period) + '&level=' + enc(f.level) +
        '&department=' + enc(f.department) + '&q=' + enc(f.q);
      api(q).then(function (d) { if (tok !== state.token) return; data = d; paint(); })
        .catch(function (e) { if (tok === state.token) holder.innerHTML = errHtml(e); });
    }
    Array.prototype.forEach.call(body.querySelectorAll('[data-f]'), function (el) {
      var ev = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(ev, function () {
        f[el.getAttribute('data-f')] = el.value;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(load, ev === 'input' ? 300 : 0);
      });
    });
    body.querySelector('[data-okr="expand"]').addEventListener('click', function () { state.collapsed = {}; paint(); });
    body.querySelector('[data-okr="collapse"]').addEventListener('click', function () {
      (function walk(ns) { ns.forEach(function (n) { if ((n.children || []).length) { state.collapsed[n.id] = true; walk(n.children); } }); })(data ? data.tree : []);
      paint();
    });
    load();
  }

  /* ── my goals ──────────────────────────────────────────────────────────── */
  function renderMine(body) {
    var tok = state.token;
    body.innerHTML = '<div class="okr-empty">Loading…</div>';
    api('/api/okr/objectives?scope=mine&period=' + enc(state.period)).then(function (d) {
      if (tok !== state.token) return;
      var rows = d.results || [];
      if (!rows.length) {
        body.innerHTML = '<div class="okr-empty">You have no objectives in ' + esc(state.period) +
          '.<br><br><button class="btn-primary" data-okr="new2">+ Add my first objective</button></div>';
        body.querySelector('[data-okr="new2"]').addEventListener('click', function () { openObjectiveModal(null, { level: 'individual' }); });
        return;
      }
      var html = '';
      state.meta.levels.forEach(function (l) {
        var part = rows.filter(function (o) { return o.level === l; });
        if (!part.length) return;
        html += '<div class="okr-section">' + esc(LEVEL_LABEL[l]) + '</div><div class="okr-tree">' +
          part.map(function (o) { return nodeHtml({ id: o.id, title: o.title, level: o.level, ownerName: o.ownerName, ownerEmail: o.ownerEmail,
            teamName: o.teamName, department: o.department, krCount: o.krCount, visibility: o.visibility, atRisk: o.atRisk,
            status: o.status, minConfidence: o.minConfidence, progress: o.progress, children: [] }); }).join('') + '</div>';
      });
      body.innerHTML = html;
      bindNodes(body, function () {});
    }).catch(function (e) { if (tok === state.token) body.innerHTML = errHtml(e); });
  }

  /* ── my team ───────────────────────────────────────────────────────────── */
  function renderTeam(body) {
    var tok = state.token;
    body.innerHTML = '<div class="okr-empty">Loading…</div>';
    api('/api/okr/my-team?period=' + enc(state.period)).then(function (d) {
      if (tok !== state.token) return;
      var html = '';
      if ((d.teamObjectives || []).length) {
        html += '<div class="okr-section">Team objectives</div><div class="okr-tree">' +
          d.teamObjectives.map(function (o) { o.children = []; return nodeHtml(o); }).join('') + '</div>';
      }
      var members = d.members || [];
      html += '<div class="okr-section">People (' + members.length + ')</div>';
      if (!members.length) html += '<div class="okr-empty">Nobody reports to you and you lead no team.</div>';
      else {
        html += '<div class="card okr-table-wrap" style="padding:0"><table class="okr-table"><thead><tr>' +
          '<th>Person</th><th>Objectives</th><th style="min-width:150px">Average</th><th>At risk</th><th class="okr-hide-sm">Due</th><th class="okr-hide-sm">Last check-in</th></tr></thead><tbody>';
        members.forEach(function (m) {
          var open = state.openTeamMember === m.email;
          html += '<tr class="okr-row" data-member="' + esc(m.email) + '"><td><b>' + esc(m.name) + '</b><div class="okr-hint">' + esc(m.email) + '</div></td>' +
            '<td>' + m.objectiveCount + '</td>' +
            '<td>' + (m.avgProgress == null ? '<span class="okr-hint">No goals</span>' : bar(m.avgProgress)) + '</td>' +
            '<td>' + (m.atRisk.length ? '<span class="okr-badge okr-b-warn">' + m.atRisk.length + '</span>' : '0') + '</td>' +
            '<td class="okr-hide-sm">' + (m.checkInsDue ? '<span class="okr-badge okr-b-danger">' + m.checkInsDue + '</span>' : '0') + '</td>' +
            '<td class="okr-hide-sm">' + (m.lastCheckIn ? esc(fmtDate(m.lastCheckIn)) : '—') + '</td></tr>';
          if (open) {
            html += '<tr><td colspan="6"><div class="okr-sublist">' +
              (m.objectives.length ? m.objectives.map(function (o) {
                return '<div class="okr-mini" data-open="' + o.id + '">' + levelChip(o.level) + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(o.title) + '</span>' + bar(o.progress) + '</div>';
              }).join('') : '<span class="okr-hint">No objectives this period.</span>') +
              (m.atRisk.length ? '<div class="okr-hint" style="margin-top:4px">At risk: ' + m.atRisk.map(function (r) { return esc(r.title) + ' (' + esc(r.reason) + ')'; }).join('; ') + '</div>' : '') +
              '<div><button class="btn-sm" data-add-for="' + esc(m.email) + '">+ Objective for ' + esc(m.name) + '</button></div>' +
              '</div></td></tr>';
          }
        });
        html += '</tbody></table></div>';
      }
      body.innerHTML = html;
      bindNodes(body, function () {});
      Array.prototype.forEach.call(body.querySelectorAll('[data-member]'), function (tr) {
        tr.addEventListener('click', function () {
          var e = tr.getAttribute('data-member');
          state.openTeamMember = state.openTeamMember === e ? null : e;
          renderTeam(body);
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-add-for]'), function (b) {
        b.addEventListener('click', function () { openObjectiveModal(null, { level: 'individual', ownerEmail: b.getAttribute('data-add-for') }); });
      });
    }).catch(function (e) { if (tok === state.token) body.innerHTML = errHtml(e); });
  }

  /* ── check-ins ─────────────────────────────────────────────────────────── */
  function checkinForm(kr) {
    var linked = kr.metric === 'milestone' && kr.taskIds && kr.taskIds.length;
    var s = num(kr.startValue), t = num(kr.targetValue), c = num(kr.currentValue);
    var lo = Math.min(s, t, c), hi = Math.max(s, t, c);
    var step = (hi - lo) <= 20 && Math.round(hi) === hi && Math.round(lo) === lo ? 1 : Math.max((hi - lo) / 100, 0.01);
    var valueRow;
    if (linked) {
      valueRow = '<div class="okr-form-row"><label>Value</label><span class="okr-preview">' + fmtNum(c) + ' of ' + fmtNum(t) + ' linked tasks done (follows the task board)</span></div>';
    } else if (kr.metric === 'boolean') {
      valueRow = '<div class="okr-form-row"><label>Done?</label><label style="min-width:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text)"><input type="checkbox" data-ci="bool"' + (c >= 1 ? ' checked' : '') + '> Achieved</label></div>';
    } else {
      valueRow = '<div class="okr-form-row"><label>' + (kr.metric === 'milestone' ? 'Steps done' : 'Value') + '</label>' +
        '<input type="range" data-ci="range" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + c + '" aria-label="Value slider">' +
        '<input class="input-field okr-val" type="number" data-ci="value" step="any" value="' + fmtNum(c) + '" aria-label="Value"></div>';
    }
    return '<div class="okr-ci-form" data-kr="' + kr.id + '">' + valueRow +
      '<div class="okr-form-row"><label>Confidence</label><input type="range" data-ci="conf" min="1" max="10" step="1" value="' + (kr.confidence || 7) + '" aria-label="Confidence">' +
      '<span class="okr-conf-v ' + confCls(kr.confidence || 7) + '" data-ci="confv">' + (kr.confidence || 7) + '</span></div>' +
      '<textarea class="input-field" data-ci="note" placeholder="What moved this week? Any blockers?"></textarea>' +
      '<div class="okr-ci-foot"><span class="okr-preview" data-ci="preview">Progress ' + round(kr.progress) + '%</span>' +
      '<button class="btn-primary" data-ci="save">' + (kr.checkedInThisWeek ? 'Update check-in' : 'Check in') + '</button></div>' +
      '<div data-ci="err"></div></div>';
  }

  function bindCheckin(el, kr, done) {
    var form = el.querySelector('.okr-ci-form[data-kr="' + kr.id + '"]');
    if (!form) return;
    var range = form.querySelector('[data-ci="range"]'), val = form.querySelector('[data-ci="value"]');
    var bool = form.querySelector('[data-ci="bool"]'), conf = form.querySelector('[data-ci="conf"]');
    var confv = form.querySelector('[data-ci="confv"]'), prev = form.querySelector('[data-ci="preview"]');
    function current() { return bool ? (bool.checked ? 1 : 0) : (val ? val.value : kr.currentValue); }
    function upd() {
      if (val || bool) prev.textContent = 'Progress ' + round(krProgress(kr, current())) + '%';
    }
    if (range) range.addEventListener('input', function () { val.value = fmtNum(range.value); upd(); });
    if (val) val.addEventListener('input', function () { if (val.value !== '' && isFinite(Number(val.value))) range.value = val.value; upd(); });
    if (bool) bool.addEventListener('change', upd);
    conf.addEventListener('input', function () { confv.textContent = conf.value; confv.className = 'okr-conf-v ' + confCls(conf.value); });
    form.querySelector('[data-ci="save"]').addEventListener('click', function () {
      var btn = this, err = form.querySelector('[data-ci="err"]');
      var body = { confidence: Number(conf.value), note: form.querySelector('[data-ci="note"]').value };
      if (val || bool) body.value = current();
      if (val && (val.value === '' || !isFinite(Number(val.value)))) { val.focus(); return; }
      btn.disabled = true; btn.textContent = 'Saving…'; err.innerHTML = '';
      api('/api/okr/key-results/' + kr.id + '/check-ins', { method: 'POST', body: body }).then(function (r) {
        toast('Checked in: ' + kr.title + ' → ' + round(r.keyResult.progress) + '% (objective ' + round(r.objective.progress) + '%)');
        done(r);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Check in';
        err.innerHTML = errHtml(e);
      });
    });
  }

  function renderCheckins(body, due) {
    var list = (due && due.due) || [], doneList = (due && due.done) || [];
    var html = '<div class="okr-sub" style="margin-bottom:12px">One check-in per key result per week (' + esc(due.week) + ', ' + esc(due.period) +
      '). Checking in again this week updates it.</div>';
    if (!list.length) html += '<div class="okr-empty">All caught up — nothing left to check in this week.</div>';
    else {
      html += '<div class="okr-cards">' + list.map(function (kr) {
        return '<div class="okr-ci" data-card="' + kr.id + '">' +
          '<div class="okr-meta" style="margin:0">' + levelChip(kr.objectiveLevel) + '<a class="okr-link" data-open-obj="' + kr.objectiveId + '">' + esc(kr.objectiveTitle) + '</a></div>' +
          '<h4>' + dot(kr.confidence) + ' ' + esc(kr.title) + '</h4>' +
          '<div class="okr-meta">' + esc(valueText(kr)) + (kr.risk ? ' <span class="okr-badge okr-b-warn">' + esc(kr.risk) + '</span>' : '') + '</div>' +
          bar(kr.progress, { expected: kr.expected, risk: !!kr.risk }) +
          checkinForm(kr) + '</div>';
      }).join('') + '</div>';
    }
    if (doneList.length) {
      html += '<div class="okr-section">Checked in this week</div><div class="okr-done-list">' + doneList.map(function (kr) {
        return '<div class="okr-mini" data-open="' + kr.objectiveId + '">' + dot(kr.confidence) + '<span style="flex:1;min-width:0">' + esc(kr.title) +
          ' <span class="okr-hint">· ' + esc(kr.objectiveTitle) + '</span></span>' + bar(kr.progress) + '</div>';
      }).join('') + '</div>';
    }
    body.innerHTML = html;
    list.forEach(function (kr) { bindCheckin(body, kr, function () { renderPage(); }); });
    bindNodes(body, function () {});
    Array.prototype.forEach.call(body.querySelectorAll('[data-open-obj]'), function (a) {
      a.addEventListener('click', function () { openDrawer(Number(a.getAttribute('data-open-obj'))); });
    });
  }

  /* ── drawer ────────────────────────────────────────────────────────────── */
  function closeDrawer() {
    state.drawerId = null;
    ['.okr-shade', '.okr-drawer'].forEach(function (s) { var n = document.querySelector(s); if (n) n.parentNode.removeChild(n); });
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.okr-overlay')) closeDrawer(); }

  function openDrawer(id) {
    state.drawerId = id;
    var shade = document.querySelector('.okr-shade'), dr = document.querySelector('.okr-drawer');
    if (!shade) {
      shade = document.createElement('div'); shade.className = 'okr-shade';
      shade.addEventListener('click', closeDrawer);
      document.body.appendChild(shade);
      document.addEventListener('keydown', onKey);
    }
    if (!dr) {
      dr = document.createElement('aside'); dr.className = 'okr-drawer';
      dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Objective');
      document.body.appendChild(dr);
    }
    dr.innerHTML = '<div class="okr-empty">Loading…</div>';
    api('/api/okr/objectives/' + id).then(function (o) {
      if (state.drawerId !== id) return;
      paintDrawer(dr, o);
    }).catch(function (e) { dr.innerHTML = '<div class="okr-dh"><span></span><button class="okr-x" data-x>×</button></div>' + errHtml(e); dr.querySelector('[data-x]').addEventListener('click', closeDrawer); });
  }

  function refreshAfterChange() {
    if (state.drawerId) openDrawer(state.drawerId);
    renderPage();
  }

  function paintDrawer(dr, o) {
    var crumb = (o.breadcrumb || []).map(function (b) {
      return '<a data-crumb="' + b.id + '">' + esc(b.title) + '</a><span>›</span>';
    }).join('');
    var meta = [levelChip(o.level), '<span>' + esc(o.period) + '</span>', '<span>· ' + esc(o.ownerName) + '</span>'];
    if (o.teamName) meta.push('<span>· ' + esc(o.teamName) + '</span>');
    else if (o.department) meta.push('<span>· ' + esc(o.department) + '</span>');
    meta.push('<span class="okr-badge okr-b-muted">' + esc(o.visibility) + '</span>');
    var sb = statusBadge(o.status); if (sb) meta.push(sb);
    var krs = o.keyResults || [];
    var html =
      '<div class="okr-dh"><div style="min-width:0">' +
        (crumb ? '<div class="okr-crumb" title="Aligned under">' + crumb + '<span>this</span></div>' : '<div class="okr-crumb">Not aligned</div>') +
        '<div class="okr-dtitle">' + esc(o.title) + '</div><div class="okr-meta">' + meta.join('') + '</div></div>' +
        '<button class="okr-x" data-x aria-label="Close">×</button></div>' +
      '<div class="okr-big">' + bar(o.progress, { expected: o.expected, risk: o.atRisk > 0, cls: o.status === 'completed' ? 'ok' : '' }).replace('okr-prog', 'okr-prog" style="flex:1') + '</div>' +
      '<div class="okr-hint">Time elapsed in ' + esc(o.period) + ': ' + round(o.expected) + '%' + (krs.length ? ' · progress is the weighted average of the key results' : (o.children.length ? ' · progress is the average of aligned objectives' : '')) + '</div>' +
      (o.description ? '<div class="okr-desc">' + esc(o.description) + '</div>' : '') +
      (o.canEdit ? '<div class="okr-btns"><button class="btn-sm" data-act="edit">Edit</button><button class="btn-sm" data-act="add-kr">+ Key result</button>' +
        '<button class="btn-sm" data-act="add-child">+ Aligned objective</button>' +
        (o.status === 'completed' ? '<button class="btn-sm" data-act="reopen">Reopen</button>' : '') +
        '<button class="btn-sm" data-act="delete" style="color:var(--danger)">Delete</button></div>'
        : '<div class="okr-btns"><button class="btn-sm" data-act="add-child">+ Align my objective here</button></div>') +
      '<div class="okr-section">Key results (' + krs.length + ')</div>' +
      (krs.length ? krs.map(function (k) { return krHtml(k, o); }).join('') : '<div class="okr-empty" style="padding:14px">No key results yet.' + (o.canEdit ? ' Add 2–5 measurable ones.' : '') + '</div>') +
      '<div class="okr-section">Aligned objectives (' + o.children.length + ')</div>' +
      (o.children.length ? '<div class="okr-sublist">' + o.children.map(function (c) {
        return '<div class="okr-mini" data-child="' + c.id + '">' + levelChip(c.level) + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.title) + ' <span class="okr-hint">· ' + esc(c.ownerName) + '</span></span>' + bar(c.progress) + '</div>';
      }).join('') + '</div>' : '<div class="okr-hint">Nothing aligned under this objective yet.</div>');
    dr.innerHTML = html;
    dr.scrollTop = 0;
    dr.querySelector('[data-x]').addEventListener('click', closeDrawer);
    Array.prototype.forEach.call(dr.querySelectorAll('[data-crumb]'), function (a) { a.addEventListener('click', function () { openDrawer(Number(a.getAttribute('data-crumb'))); }); });
    Array.prototype.forEach.call(dr.querySelectorAll('[data-child]'), function (a) { a.addEventListener('click', function () { openDrawer(Number(a.getAttribute('data-child'))); }); });
    function on(act, fn) { var b = dr.querySelector('[data-act="' + act + '"]'); if (b) b.addEventListener('click', fn); }
    on('edit', function () { openObjectiveModal(o, {}); });
    on('add-kr', function () { openKrModal(o, null); });
    on('add-child', function () {
      var lvl = NEXT_LEVEL[o.level];
      openObjectiveModal(null, { level: lvl, parentId: o.id, period: o.period,
        department: o.level === 'department' ? o.department : '', teamId: o.level === 'team' ? o.teamId : '' });
    });
    on('reopen', function () {
      api('/api/okr/objectives/' + o.id, { method: 'PATCH', body: { status: 'active' } }).then(refreshAfterChange).catch(function (e) { toast(e.message); });
    });
    on('delete', function () {
      if (!window.confirm('Delete "' + o.title + '" and its key results? Aligned objectives stay, unaligned.')) return;
      api('/api/okr/objectives/' + o.id, { method: 'DELETE' }).then(function () { closeDrawer(); renderPage(); toast('Objective deleted.'); })
        .catch(function (e) { toast(e.message); });
    });
    krs.forEach(function (k) {
      var box = dr.querySelector('[data-krbox="' + k.id + '"]');
      function onK(act, fn) { var b = box.querySelector('[data-k="' + act + '"]'); if (b) b.addEventListener('click', fn); }
      onK('ci', function () {
        var slot = box.querySelector('[data-k-slot]');
        if (slot.innerHTML) { slot.innerHTML = ''; return; }
        slot.innerHTML = '<div class="okr-ci">' + checkinForm(k) + '</div>';
        bindCheckin(slot, k, function () { refreshAfterChange(); });
      });
      onK('edit', function () { openKrModal(o, k); });
      onK('tasks', function () { openTasksModal(k); });
      onK('del', function () {
        if (!window.confirm('Delete key result "' + k.title + '" and its check-ins?')) return;
        api('/api/okr/key-results/' + k.id, { method: 'DELETE' }).then(refreshAfterChange).catch(function (e) { toast(e.message); });
      });
    });
  }

  function krHtml(k, o) {
    var last = (k.checkIns || [])[0];
    return '<div class="okr-kr" data-krbox="' + k.id + '">' +
      '<div class="okr-kr-h"><div style="min-width:0"><div class="okr-kr-t">' + dot(k.confidence) + ' ' + esc(k.title) + '</div>' +
        '<div class="okr-meta">' + esc(METRIC_LABEL[k.metric] || k.metric) + ' · ' + esc(valueText(k)) +
        (k.responsibleName ? ' · ' + esc(k.responsibleName) : '') + (k.dueDate ? ' · due ' + esc(fmtDate(k.dueDate)) : '') +
        (k.weight !== 1 ? ' · weight ' + fmtNum(k.weight) : '') + '</div></div>' +
        '<div class="okr-hide-sm">' + sparkline(k.checkIns) + '</div></div>' +
      bar(k.progress, { expected: k.expected, risk: !!k.risk }) +
      (k.risk ? '<div class="okr-hint" style="color:var(--warn)">At risk: ' + esc(k.risk) + '</div>' : '') +
      (last ? '<div class="okr-note">' + esc(last.week) + ' · ' + esc(last.authorName) + ': ' + round(last.progress) + '%, confidence ' + last.confidence + (last.note ? ' — “' + esc(last.note) + '”' : '') + '</div>' : '') +
      '<div class="okr-btns">' +
        (k.canCheckIn ? '<button class="btn-sm" data-k="ci">' + (k.checkedInThisWeek ? 'Update this week' : 'Check in') + '</button>' : '') +
        (k.metric === 'milestone' && k.canCheckIn ? '<button class="btn-sm" data-k="tasks">Linked tasks (' + (k.taskIds || []).length + ')</button>' : '') +
        (o.canEdit ? '<button class="btn-sm" data-k="edit">Edit</button><button class="btn-sm" data-k="del" style="color:var(--danger)">Delete</button>' : '') +
      '</div><div data-k-slot></div></div>';
  }

  /* ── modals ────────────────────────────────────────────────────────────── */
  function modal(html, wide) {
    var ov = document.createElement('div');
    ov.className = 'okr-overlay';
    ov.innerHTML = '<div class="okr-modal" role="dialog" aria-modal="true"' + (wide ? ' style="max-width:640px"' : '') + '>' + html + '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', key); }
    function key(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', key);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    Array.prototype.forEach.call(ov.querySelectorAll('[data-m="cancel"]'), function (b) { b.addEventListener('click', close); });
    var first = ov.querySelector('input,select,textarea'); if (first) setTimeout(function () { first.focus(); }, 30);
    return { el: ov, close: close };
  }

  function allowedLevels(meta) {
    var out = [];
    if (meta.canManage) out.push('company', 'department');
    if (meta.canManage || (meta.teams || []).some(function (t) { return t.canLead; })) out.push('team');
    out.push('individual');
    return out;
  }

  function openObjectiveModal(o, preset) {
    var meta = state.meta, editing = !!o;
    var v = o || {};
    var level = v.level || preset.level || 'individual';
    var levels = allowedLevels(meta);
    if (levels.indexOf(level) < 0) levels.push(level);
    var people = meta.people || [];
    var ownerSel = v.ownerEmail || preset.ownerEmail || meta.me;
    if (!people.some(function (p) { return p.email === ownerSel; })) people = people.concat([{ email: ownerSel, name: ownerSel }]);
    var teams = (meta.teams || []).filter(function (t) { return meta.canManage || t.canLead || t.id === v.teamId; });
    var periods = meta.periods || [];
    var m = modal(
      '<h3>' + (editing ? 'Edit objective' : 'New objective') + '</h3>' +
      '<div class="okr-field"><label>Objective</label><input class="input-field" data-o="title" maxlength="255" placeholder="Qualitative and inspiring, e.g. Delight every new customer" value="' + esc(v.title || '') + '"></div>' +
      '<div class="okr-field"><label>Description</label><textarea class="input-field" data-o="description" rows="2" placeholder="Why it matters (optional)">' + esc(v.description || '') + '</textarea></div>' +
      '<div class="okr-row3">' +
        '<div class="okr-field"><label>Level</label><select class="input-field" data-o="level">' + options(levels.map(function (l) { return { value: l, label: LEVEL_LABEL[l] }; }), level) + '</select></div>' +
        '<div class="okr-field"><label>Period</label><select class="input-field" data-o="period">' + options(periods, v.period || preset.period || state.period) + '</select></div>' +
        '<div class="okr-field"><label>Visibility</label><select class="input-field" data-o="visibility">' + options([{ value: 'public', label: 'Public' }, { value: 'team', label: 'Team' }, { value: 'private', label: 'Private' }], v.visibility || 'public') + '</select></div>' +
      '</div>' +
      '<div class="okr-row2">' +
        '<div class="okr-field"><label>Owner</label><select class="input-field" data-o="ownerEmail"' + (people.length < 2 ? ' disabled' : '') + '>' + options(people.map(function (p) { return { value: p.email, label: p.name + (p.email === meta.me ? ' (me)' : '') }; }), ownerSel) + '</select></div>' +
        '<div class="okr-field" data-wrap="department"><label>Department</label><input class="input-field" data-o="department" list="okr-depts" value="' + esc(v.department || preset.department || '') + '" placeholder="Defaults to the owner\'s"><datalist id="okr-depts">' + (meta.departments || []).map(function (d) { return '<option value="' + esc(d) + '">'; }).join('') + '</datalist></div>' +
      '</div>' +
      '<div class="okr-field" data-wrap="team"><label>Team</label><select class="input-field" data-o="teamId">' + options(teams.map(function (t) { return { value: t.id, label: t.name + (t.department ? ' · ' + t.department : '') }; }), v.teamId || preset.teamId || '', '— choose a team —') + '</select>' +
        (teams.length ? '' : '<div class="okr-hint">You lead no team.</div>') + '</div>' +
      '<div class="okr-field"><label>Aligned under</label><select class="input-field" data-o="parentId"><option value="">Loading…</option></select>' +
        '<div class="okr-hint">Any visible objective of a higher level in the same period. Progress rolls up into it.</div></div>' +
      (editing ? '<div class="okr-field"><label>Status</label><select class="input-field" data-o="status">' + options(meta.statuses.map(function (s) { return { value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }; }), v.status) + '</select></div>' : '') +
      '<div data-o="err"></div>' +
      '<div class="okr-foot"><button class="btn-sm" data-m="cancel">Cancel</button><button class="btn-primary" data-o="save">' + (editing ? 'Save' : 'Create') + '</button></div>', true);
    var el = m.el;
    function f(k) { return el.querySelector('[data-o="' + k + '"]'); }
    var parentWanted = v.parentId || preset.parentId || '';
    function syncLevel() {
      var l = f('level').value;
      el.querySelector('[data-wrap="team"]').style.display = l === 'team' ? '' : 'none';
      el.querySelector('[data-wrap="department"]').style.display = l === 'company' ? 'none' : '';
      loadParents();
    }
    function loadParents() {
      var sel = f('parentId'), l = f('level').value, p = f('period').value;
      if (sel.value) parentWanted = sel.value;
      if (l === 'company') { sel.innerHTML = '<option value="">— top level —</option>'; sel.disabled = true; return; }
      sel.disabled = false;
      api('/api/okr/alignment-options?level=' + enc(l) + '&period=' + enc(p) + (editing ? '&exclude=' + v.id : '')).then(function (d) {
        var groups = {};
        (d.results || []).forEach(function (r) { (groups[r.level] = groups[r.level] || []).push(r); });
        var html = '<option value="">— not aligned —</option>';
        meta.levels.forEach(function (lv) {
          if (!groups[lv]) return;
          html += '<optgroup label="' + esc(LEVEL_LABEL[lv]) + '">' + groups[lv].map(function (r) {
            return '<option value="' + r.id + '"' + (String(r.id) === String(parentWanted) ? ' selected' : '') + '>' + esc(r.title) + ' — ' + esc(r.ownerName) + ' (' + round(r.progress) + '%)</option>';
          }).join('') + '</optgroup>';
        });
        sel.innerHTML = html;
      }).catch(function () { sel.innerHTML = '<option value="">— not aligned —</option>'; });
    }
    f('level').addEventListener('change', syncLevel);
    f('period').addEventListener('change', function () { parentWanted = ''; loadParents(); });
    syncLevel();
    f('save').addEventListener('click', function () {
      var btn = this;
      var body = {
        title: f('title').value.trim(), description: f('description').value, level: f('level').value,
        period: f('period').value, visibility: f('visibility').value, ownerEmail: f('ownerEmail').value,
        department: f('level').value === 'company' ? '' : f('department').value.trim(),
        teamId: f('level').value === 'team' ? f('teamId').value : '', parentId: f('parentId').value
      };
      if (editing) body.status = f('status').value;
      if (!body.title) { f('title').focus(); return; }
      btn.disabled = true;
      api(editing ? '/api/okr/objectives/' + v.id : '/api/okr/objectives', { method: editing ? 'PATCH' : 'POST', body: body }).then(function (d) {
        m.close();
        if (body.period !== state.period) { state.period = body.period; }
        toast(editing ? 'Objective saved.' : 'Objective created — now add key results.');
        renderPage();
        openDrawer(d.id);
        if (!editing) {
          setTimeout(function () { if (state.drawerId === d.id && d.canEdit && !(d.keyResults || []).length) openKrModal(d, null); }, 350);
        }
      }).catch(function (e) { btn.disabled = false; f('err').innerHTML = errHtml(e); });
    });
  }

  function openKrModal(o, k) {
    var meta = state.meta, editing = !!k, v = k || { metric: 'percent', startValue: 0, targetValue: 100, currentValue: 0, weight: 1, confidence: 7 };
    var people = (meta.people || []).slice();
    if (!people.some(function (p) { return p.email === meta.me; })) people.unshift({ email: meta.me, name: meta.myName || meta.me });
    if (v.ownerEmail && !people.some(function (p) { return p.email === v.ownerEmail; })) people.push({ email: v.ownerEmail, name: v.ownerName || v.ownerEmail });
    var m = modal(
      '<h3>' + (editing ? 'Edit key result' : 'New key result') + '</h3><div class="okr-hint" style="margin:-8px 0 12px">' + esc(o.title) + '</div>' +
      '<div class="okr-field"><label>Key result</label><input class="input-field" data-k="title" maxlength="255" placeholder="Measurable, e.g. Raise NPS from 32 to 45" value="' + esc(v.title || '') + '"></div>' +
      '<div class="okr-row2">' +
        '<div class="okr-field"><label>Metric</label><select class="input-field" data-k="metric">' + options(meta.metrics.map(function (x) { return { value: x, label: METRIC_LABEL[x] }; }), v.metric) + '</select></div>' +
        '<div class="okr-field" data-wrap="unit"><label>Unit</label><input class="input-field" data-k="unit" maxlength="20" placeholder="e.g. users, INR, %" value="' + esc(v.unit || '') + '"></div>' +
      '</div>' +
      '<div class="okr-row3" data-wrap="values">' +
        '<div class="okr-field"><label data-lbl="start">Start</label><input class="input-field" type="number" step="any" data-k="startValue" value="' + fmtNum(v.startValue) + '"></div>' +
        '<div class="okr-field"><label data-lbl="target">Target</label><input class="input-field" type="number" step="any" data-k="targetValue" value="' + fmtNum(v.targetValue) + '"></div>' +
        '<div class="okr-field"><label data-lbl="current">Current</label><input class="input-field" type="number" step="any" data-k="currentValue" value="' + fmtNum(v.currentValue) + '"></div>' +
      '</div>' +
      '<div class="okr-hint" data-k="metric-hint" style="margin:-6px 0 10px"></div>' +
      '<div class="okr-row2">' +
        '<div class="okr-field"><label>Owner</label><select class="input-field" data-k="ownerEmail">' + options(people.map(function (p) { return { value: p.email, label: p.name }; }), v.ownerEmail || '', 'Objective owner (' + (o.ownerName || '') + ')') + '</select></div>' +
        '<div class="okr-field"><label>Due date</label><input class="input-field" type="date" data-k="dueDate" value="' + esc(v.dueDate || '') + '"></div>' +
      '</div>' +
      '<div class="okr-row2">' +
        '<div class="okr-field"><label>Weight</label><input class="input-field" type="number" min="0" max="100" step="any" data-k="weight" value="' + fmtNum(v.weight) + '"><div class="okr-hint">Relative share in the objective\'s progress.</div></div>' +
        '<div class="okr-field"><label>Confidence (1–10)</label><input class="input-field" type="number" min="1" max="10" step="1" data-k="confidence" value="' + (v.confidence || 7) + '"></div>' +
      '</div>' +
      '<div data-k="err"></div>' +
      '<div class="okr-foot"><button class="btn-sm" data-m="cancel">Cancel</button><button class="btn-primary" data-k="save">' + (editing ? 'Save' : 'Add key result') + '</button></div>');
    var el = m.el;
    function f(x) { return el.querySelector('[data-k="' + x + '"]'); }
    var HINT = {
      percent: 'Progress = (current − start) ÷ (target − start). A target below the start (e.g. 8 → 3) is a decrease goal.',
      number: 'Progress = (current − start) ÷ (target − start). Works for decreasing targets too.',
      currency: 'Progress = (current − start) ÷ (target − start), in the unit you choose.',
      boolean: 'Either done (100%) or not (0%).',
      milestone: 'Target = number of steps, current = steps done. Or link tasks from the task board afterwards and it follows them.'
    };
    function sync() {
      var mt = f('metric').value;
      el.querySelector('[data-wrap="values"]').style.display = mt === 'boolean' ? 'none' : '';
      el.querySelector('[data-wrap="unit"]').style.visibility = (mt === 'boolean' || mt === 'milestone') ? 'hidden' : '';
      el.querySelector('[data-lbl="target"]').textContent = mt === 'milestone' ? 'Steps' : 'Target';
      el.querySelector('[data-lbl="current"]').textContent = mt === 'milestone' ? 'Done' : 'Current';
      f('metric-hint').textContent = HINT[mt] || '';
      if (!editing && mt === 'milestone' && f('targetValue').value === '100') { f('targetValue').value = '3'; f('startValue').value = '0'; }
      if (!editing && mt === 'percent' && f('targetValue').value === '3') f('targetValue').value = '100';
    }
    f('metric').addEventListener('change', sync);
    sync();
    f('save').addEventListener('click', function () {
      var btn = this, mt = f('metric').value;
      var body = { title: f('title').value.trim(), metric: mt, unit: f('unit').value, ownerEmail: f('ownerEmail').value,
        dueDate: f('dueDate').value, weight: f('weight').value, confidence: f('confidence').value };
      if (mt !== 'boolean') { body.startValue = f('startValue').value; body.targetValue = f('targetValue').value; body.currentValue = f('currentValue').value; }
      if (!body.title) { f('title').focus(); return; }
      btn.disabled = true;
      api(editing ? '/api/okr/key-results/' + k.id : '/api/okr/objectives/' + o.id + '/key-results', { method: editing ? 'PATCH' : 'POST', body: body })
        .then(function () { m.close(); toast(editing ? 'Key result saved.' : 'Key result added.'); refreshAfterChange(); })
        .catch(function (e) { btn.disabled = false; f('err').innerHTML = errHtml(e); });
    });
  }

  function openTasksModal(k) {
    var chosen = {};
    (k.taskIds || []).forEach(function (id) { chosen[id] = true; });
    var m = modal('<h3>Linked tasks</h3><div class="okr-hint" style="margin:-8px 0 12px">' + esc(k.title) +
      ' — progress follows the share of linked tasks marked Done on the task board.</div>' +
      '<input class="input-field" data-t="q" placeholder="Search tasks…" style="margin-bottom:10px">' +
      '<div class="okr-tasks" data-t="list"><div class="okr-empty">Loading…</div></div>' +
      '<div data-t="err"></div>' +
      '<div class="okr-foot"><button class="btn-sm" data-m="cancel">Cancel</button><button class="btn-primary" data-t="save">Save links</button></div>');
    var el = m.el, list = el.querySelector('[data-t="list"]'), timer = null, linked = {};
    function paint(rows) {
      if (!rows.length) { list.innerHTML = '<div class="okr-empty">No tasks found.</div>'; return; }
      list.innerHTML = rows.map(function (t) {
        var st = { done: 'okr-b-ok', inprogress: 'okr-b-warn' }[t.stage] || 'okr-b-muted';
        return '<label class="okr-task"><input type="checkbox" data-tid="' + t.id + '"' + (chosen[t.id] ? ' checked' : '') + '>' +
          '<span style="flex:1;min-width:0">' + esc(t.title) + ' <span class="okr-hint">' + esc(t.code || '') + (t.assignee ? ' · ' + esc(t.assignee) : '') + '</span></span>' +
          '<span class="okr-badge ' + st + '">' + esc(t.stage) + '</span></label>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('[data-tid]'), function (c) {
        c.addEventListener('change', function () { chosen[c.getAttribute('data-tid')] = c.checked; });
      });
    }
    function load() {
      var q = el.querySelector('[data-t="q"]').value;
      Promise.all([api('/api/okr/tasks?kr=' + k.id + '&q=' + enc(q)), api('/api/okr/key-results/' + k.id + '/tasks')]).then(function (r) {
        var rows = r[1].tasks.concat(r[0].results.filter(function (t) { return !r[1].tasks.some(function (x) { return x.id === t.id; }); }));
        r[1].tasks.forEach(function (t) { linked[t.id] = true; });
        paint(rows);
      }).catch(function (e) { list.innerHTML = errHtml(e); });
    }
    el.querySelector('[data-t="q"]').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 300); });
    load();
    el.querySelector('[data-t="save"]').addEventListener('click', function () {
      var btn = this, ids = Object.keys(chosen).filter(function (id) { return chosen[id]; }).map(Number);
      btn.disabled = true;
      api('/api/okr/key-results/' + k.id + '/tasks', { method: 'PUT', body: { taskIds: ids } }).then(function (r) {
        m.close();
        toast(ids.length ? 'Linked ' + ids.length + ' task(s): ' + round(r.keyResult.progress) + '% done.' : 'Task links removed.');
        refreshAfterChange();
      }).catch(function (e) { btn.disabled = false; el.querySelector('[data-t="err"]').innerHTML = errHtml(e); });
    });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function makePage(base, title) {
    function render(root, sub) {
      injectStyle();
      state.root = root;
      state.base = base;
      var mObj = /^\/o\/(\d+)$/.exec(sub || '');
      state.sub = mObj ? '' : (VIEWS.some(function (v) { return v[0] === sub; }) ? sub : '');
      renderPage();
      if (mObj) openDrawer(Number(mObj[1]));
    }
    return {
      base: base, title: title, mount: render, update: render,
      unmount: function () {
        state.token++;
        clearTimeout(state.searchTimer);
        closeDrawer();
        Array.prototype.forEach.call(document.querySelectorAll('.okr-overlay'), function (n) { n.parentNode.removeChild(n); });
        state.root = null;
      }
    };
  }

  function register() {
    SC = window.HRMSSidecar;
    /* One page: HR Management > Perform ("Performance · Goals & OKRs").
       The old /goals address (bookmarks, e-mails, notifications) forwards to
       it with the same sub-path, e.g. /goals/team -> /hr/perform/team. */
    SC.register(makePage('/hr/perform', 'Performance · Goals & OKRs'));
    SC.register({
      base: '/goals', title: 'Performance · Goals & OKRs',
      mount: forward, update: forward
    });
  }
  function forward(root, sub) {
    root.innerHTML = '';
    var to = '/hr/perform' + (sub || '') + location.search + location.hash;
    setTimeout(function () {
      history.replaceState(history.state, '', to);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, 0);
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
