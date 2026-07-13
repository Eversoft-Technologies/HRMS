/**
 * hrms-recruit-kpi.js  v3
 * Recruitment KPI Dashboard — a full-screen analytics overlay.
 *
 * Injects a "📊 KPI Dashboard" button into the Recruitment page and opens a
 * rich analytics modal wired to GET /api/recruitment/kpis.
 *
 * Same no-rebuild injection pattern as hrms-rbac.js / hrms-attendance.js.
 */
(function () {
  'use strict';

  var OVERLAY_ID  = 'hrms-kpi-overlay';
  var BTN_ID      = 'hrms-kpi-btn';
  var REFRESH_MS  = 60000;

  var state = {
    tab:             'overview',
    scope:           'me',
    range:           'all',
    role:            '',
    interviewer:     '',
    dept:            '',
    
    // Tab-specific interactive filters
    interview_type:  '',
    status:          '',
    outcome:         '',
    source:          '',
    verdict:         '',
    job_type:        '',

    data:            null,
    loading:         false,
    timer:           null,
    charts:          [], // Keep track of active Chart.js instances
    lastRenderedTab: null // Tracks the active tab to prevent unnecessary HTML rebuilds
  };

  /* ── session helpers ──────────────────────────────────────────────────── */
  function session() {
    try { return JSON.parse(localStorage.getItem('hrms_session') || '{}'); }
    catch (_) { return {}; }
  }
  function actorEmail() { return (session().email || '').trim(); }

  /* Scope access is permission-driven, not role-name-driven. __hrmsCan (from
     hrms-perms.js) fails OPEN until /api/me/permissions has answered, so the
     toggle never flickers off for someone who does have the grant; the server
     is the real gate either way. */
  function can(code) {
    return window.__hrmsCan ? window.__hrmsCan(code) : true;
  }
  function canOrg() { return can('recruitment.kpi.view_org'); }
  function canOwn() { return can('recruitment.kpi.view_own') || canOrg(); }

  /* ── API helper ───────────────────────────────────────────────────────── */
  function api(path, opts) {
    opts = opts || {};
    var hdrs = { 'Content-Type': 'application/json' };
    var em = actorEmail();
    if (em) hdrs['X-User-Email'] = em;
    opts.headers = Object.assign(hdrs, opts.headers || {});
    return fetch('/api' + path, opts)
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          return { ok: r.ok, status: r.status, data: d };
        });
      })
      .catch(function () { return { ok: false, status: 0, data: null }; });
  }

  function fetchKpis() {
    var scope = canOrg() ? state.scope : 'me';
    var url = '/recruitment/kpis?scope=' + scope + '&range=' + state.range;
    if (state.role) url += '&role=' + encodeURIComponent(state.role);
    if (scope === 'all') {
      if (state.interviewer) url += '&interviewer=' + encodeURIComponent(state.interviewer);
      if (state.dept) url += '&dept=' + encodeURIComponent(state.dept);
    }
    
    // Pass dynamic tab filters if set
    if (state.interview_type) url += '&interview_type=' + encodeURIComponent(state.interview_type);
    if (state.status) url += '&status=' + encodeURIComponent(state.status);
    if (state.outcome) url += '&outcome=' + encodeURIComponent(state.outcome);
    if (state.source) url += '&source=' + encodeURIComponent(state.source);
    if (state.verdict) url += '&verdict=' + encodeURIComponent(state.verdict);
    if (state.job_type) url += '&job_type=' + encodeURIComponent(state.job_type);

    return api(url);
  }

  /* ── escape ───────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── number helpers ───────────────────────────────────────────────────── */
  function pct(v) { return (v == null ? '—' : v.toFixed(1) + '%'); }
  function num(v) { return (v == null ? '—' : v); }
  function score(v) { return (v == null || v === 0 ? '—' : v.toFixed(1)); }

  function kpiCard(label, val, sub, color, id) {
    var idAttr = id ? ' id="' + id + '-val"' : '';
    var subIdAttr = id ? ' id="' + id + '-sub"' : '';
    return '<div class="kpi-card c-' + color + '">' +
      '<div class="kpi-card-lbl">' + esc(label) + '</div>' +
      '<div class="kpi-card-val"' + idAttr + '>' + esc(String(val == null ? '—' : val)) + '</div>' +
      (sub ? '<div class="kpi-card-sub"' + subIdAttr + '>' + esc(sub) + '</div>' : '<div class="kpi-card-sub"' + subIdAttr + ' style="display:none"></div>') +
    '</div>';
  }

  /* ── Chart.js Loader ───────────────────────────────────────────────────── */
  function loadChartJs(callback) {
    if (window.Chart) {
      callback();
      return;
    }
    var existing = document.querySelector('script[src*="chart.js"]');
    if (existing) {
      var interval = setInterval(function () {
        if (window.Chart) {
          clearInterval(interval);
          callback();
        }
      }, 50);
      return;
    }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    s.onload = callback;
    document.head.appendChild(s);
  }

  /* ── inject styles ────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById('hrms-kpi-style')) return;
    var s = document.createElement('style');
    s.id = 'hrms-kpi-style';
    s.textContent = [
      /* overlay backdrop */
      /* overlay backdrop + full-page. Map the app's theme vars onto the ones this
         dashboard uses (--card/--text1/--hover were undefined → light-mode fallbacks,
         which made the panel white in dark mode). */
      '#hrms-kpi-overlay{position:fixed;inset:0;background:rgba(10,14,26,0.6);z-index:9900;display:flex;align-items:stretch;justify-content:stretch;padding:0;backdrop-filter:blur(4px);--card:var(--bg2,#fff);--text1:var(--text,#111);--hover:var(--bg3,#f3f4f6)}',
      /* modal — full page */
      '.kpi-modal{background:var(--card,#fff);border-radius:0;width:100%;height:100%;max-width:none;max-height:none;display:flex;flex-direction:column;overflow:hidden;box-shadow:none;border:none}',
      '#hrms-kpi-overlay .kpi-card{background:var(--bg,#f8fafc)}',
      /* per-chart filter */
      '#hrms-kpi-overlay .chart-wrapper{position:relative}',
      '.kpi-cf-btn{position:absolute;top:0;right:0;display:inline-flex;align-items:center;gap:5px;background:var(--bg3,#f3f4f6);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:4px 9px;font-size:11px;font-weight:600;color:var(--text2,#666);cursor:pointer}',
      '.kpi-cf-btn:hover{border-color:var(--accent,#6366f1);color:var(--text1,#111)}',
      '.kpi-cf-btn.on{color:var(--accent,#6366f1);border-color:var(--accent,#6366f1)}',
      '.kpi-cf-pop{position:fixed;z-index:9950;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 14px 38px rgba(0,0,0,.35);padding:6px;min-width:170px;max-height:260px;overflow-y:auto}',
      '.kpi-cf-pop label{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:12.5px;color:var(--text1,#111);cursor:pointer;border-radius:6px}',
      '.kpi-cf-pop label:hover{background:var(--hover,#f3f4f6)}',
      '.kpi-cf-pop input{accent-color:var(--accent,#6366f1)}',
      /* Overall "Edit Filters" — Job Board–style right drawer */
      '.kpi-editfilters{display:inline-flex;align-items:center;gap:7px;background:var(--bg3,#f3f4f6);border:1px solid var(--border,#e5e7eb);border-radius:9px;padding:8px 14px;font-size:12.5px;font-weight:600;color:var(--text1,#111);cursor:pointer}',
      '.kpi-editfilters:hover{border-color:var(--accent,#6366f1);color:var(--accent,#6366f1)}',
      '.kpi-filter-summary{font-size:12px;color:var(--text3,#888);font-weight:500}',
      '.kpi-fd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9960;display:flex;justify-content:flex-end;animation:kpi-fd-fade .15s ease;--card:var(--bg2,#fff);--text1:var(--text,#111);--hover:var(--bg3,#f3f4f6)}',
      '.kpi-fd{width:380px;max-width:94vw;height:100vh;background:var(--card,#fff);border-left:1px solid var(--border,#e5e7eb);box-shadow:-24px 0 70px rgba(0,0,0,.5);display:flex;flex-direction:column;animation:kpi-fd-slide .28s cubic-bezier(.2,.9,.3,1)}',
      '.kpi-fd-h{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border,#e5e7eb)}',
      '.kpi-fd-h h3{margin:0;font-size:17px;font-weight:700;color:var(--text1,#111)}',
      '.kpi-fd-x{width:30px;height:30px;border:none;border-radius:50%;background:var(--bg3,#f3f4f6);color:var(--text3,#888);font-size:17px;cursor:pointer}',
      '.kpi-fd-body{flex:1;overflow-y:auto;padding:14px 22px 16px}',
      '.kpi-fd-sec{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3,#888);margin:16px 0 8px}',
      '.kpi-fd-pd{display:grid;gap:8px}',
      '.kpi-fd-pd label{display:flex;align-items:center;gap:10px;background:var(--bg2,#f8fafc);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text1,#111);cursor:pointer}',
      '.kpi-fd-pd label:hover{border-color:var(--accent,#6366f1)}',
      '.kpi-fd-pd input{accent-color:var(--accent,#6366f1);width:15px;height:15px}',
      '.kpi-fd-fl{font-size:12px;font-weight:600;color:var(--text2,#666);margin:10px 0 5px}',
      '.kpi-fd-sel{width:100%;background:var(--bg2,#f8fafc);border:1px solid var(--border,#e5e7eb);border-radius:8px;color:var(--text1,#111);font:inherit;font-size:13px;padding:9px 11px}',
      '.kpi-fd-f{display:flex;gap:10px;padding:16px 22px;border-top:1px solid var(--border,#e5e7eb)}',
      '.kpi-fd-btn{flex:1;text-align:center;border-radius:9px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid var(--border,#e5e7eb);background:var(--bg2,#f8fafc);color:var(--text1,#111)}',
      '.kpi-fd-btn.primary{background:var(--accent,#6366f1);color:#fff;border-color:var(--accent,#6366f1)}',
      '.kpi-fd-btn.ghost{background:transparent;color:var(--text2,#666)}',
      '@keyframes kpi-fd-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes kpi-fd-slide{from{transform:translateX(100%)}to{transform:translateX(0)}}',
      /* header */
      '.kpi-head{display:flex;align-items:center;justify-content:space-between;padding:20px 24px 0;flex-shrink:0}',
      '.kpi-title{font-size:18px;font-weight:700;color:var(--text1,#111)}',
      '.kpi-sub{font-size:12px;color:var(--text3,#888);margin-top:2px}',
      '.kpi-x{background:none;border:none;font-size:24px;cursor:pointer;color:var(--text3,#888);line-height:1;padding:4px 8px;border-radius:6px;transition:.15s}',
      '.kpi-x:hover{background:var(--hover,#f3f4f6);color:var(--text1,#111)}',
      /* toolbar */
      '.kpi-toolbar{display:flex;align-items:center;gap:12px;padding:14px 24px 10px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border,#e5e7eb)}',
      '.kpi-scope-btn{padding:6px 14px;border-radius:20px;border:1.5px solid var(--border,#e5e7eb);font-size:12px;cursor:pointer;background:transparent;color:var(--text2,#555);font-weight:600;transition:.15s}',
      '.kpi-scope-btn.active{background:var(--accent,#6366f1);color:#fff;border-color:var(--accent,#6366f1)}',
      '.kpi-filter-select{border:1.5px solid var(--border,#e5e7eb);border-radius:8px;padding:6px 12px;font-size:12px;background:var(--card,#fff);color:var(--text1,#111);cursor:pointer;outline:none;font-weight:500;transition:.15s}',
      '.kpi-filter-select:hover{border-color:var(--accent,#6366f1)}',
      '.kpi-filter-select:focus{border-color:var(--accent,#6366f1);box-shadow:0 0 0 3px rgba(99,102,241,0.15)}',
      '.kpi-refresh{margin-left:auto;font-size:11px;color:var(--text3,#888);font-weight:500;display:inline-flex;align-items:center;gap:6px}',
      /* loading spinner */
      '.kpi-spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,0.1);border-radius:50%;border-top-color:var(--accent,#6366f1);animation:kpi-spin 0.8s linear infinite;vertical-align:middle}',
      '@keyframes kpi-spin{to{transform:rotate(360deg)}}',
      /* tabs */
      '.kpi-tabs{display:flex;gap:6px;padding:10px 24px 0;background:var(--bg2,#f8fafc);border-bottom:1.5px solid var(--border,#e5e7eb);flex-shrink:0;overflow-x:auto}',
      '.kpi-tab{padding:8px 16px;border-radius:8px 8px 0 0;border:none;background:transparent;font-size:12.5px;cursor:pointer;color:var(--text2,#666);font-weight:600;border-bottom:2.5px solid transparent;white-space:nowrap;transition:.15s}',
      '.kpi-tab.active{color:var(--accent,#6366f1);border-bottom-color:var(--accent,#6366f1);background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-bottom-color:transparent;margin-bottom:-1.5px}',
      /* body */
      '.kpi-body{flex:1;overflow-y:auto;padding:24px;background:var(--card,#fff);transition:opacity 0.25s ease}',
      /* cards grid */
      '.kpi-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:24px}',
      '.kpi-card{background:var(--bg2,#f8fafc);border:1.5px solid var(--border,#e5e7eb);border-radius:12px;padding:16px;position:relative;overflow:hidden;transition:transform .2s, box-shadow .2s;box-sizing:border-box}',
      '.kpi-card:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(14, 13, 13, 0.92)}',
      '.kpi-card::before{content:"";position:absolute;top:0;left:0;right:0;height:4px}',
      '.kpi-card.c-green::before{background:linear-gradient(90deg,#10b981,#34d399)}',
      '.kpi-card.c-blue::before{background:linear-gradient(90deg,#6366f1,#818cf8)}',
      '.kpi-card.c-amber::before{background:linear-gradient(90deg,#f59e0b,#fbbf24)}',
      '.kpi-card.c-red::before{background:linear-gradient(90deg,#ef4444,#f87171)}',
      '.kpi-card.c-purple::before{background:linear-gradient(90deg,#a855f7,#c084fc)}',
      '.kpi-card.c-cyan::before{background:linear-gradient(90deg,#06b6d4,#22d3ee)}',
      '.kpi-card.c-indigo::before{background:linear-gradient(90deg,#4f46e5,#6366f1)}',
      '.kpi-card.c-pink::before{background:linear-gradient(90deg,#ec4899,#f472b6)}',
      '.kpi-card-val{font-size:28px;font-weight:800;color:var(--text1,#111);line-height:1.1;margin-top:6px;font-family:\'Syne\',sans-serif}',
      '.kpi-card-lbl{font-size:11px;font-weight:700;color:var(--text3,#888);text-transform:uppercase;letter-spacing:.5px}',
      '.kpi-card-sub{font-size:11px;color:var(--text3,#888);margin-top:4px}',
      /* section */
      '.kpi-section{margin-bottom:24px}',
      '.kpi-section-title{font-size:14px;font-weight:700;color:var(--text1,#111);margin-bottom:16px;display:flex;align-items:center;gap:10px}',
      '.kpi-section-title::after{content:"";flex:1;height:1px;background:var(--border,#e5e7eb)}',
      /* table */
      '.kpi-tbl{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.kpi-tbl th{text-align:left;padding:10px 12px;font-weight:700;color:var(--text3,#888);font-size:11px;text-transform:uppercase;border-bottom:1.5px solid var(--border,#e5e7eb)}',
      '.kpi-tbl td{padding:10px 12px;border-bottom:1px solid var(--border,#e5e7eb);color:var(--text1,#111)}',
      '.kpi-tbl tr:last-child td{border-bottom:none}',
      '.kpi-tbl tr:hover td{background:var(--hover,#f8fafc)}',
      /* loading */
      '.kpi-loading{display:flex;align-items:center;justify-content:center;height:240px;color:var(--text3,#888);font-size:14px;font-weight:500}',
      /* empty */
      '.kpi-empty{text-align:center;color:var(--text3,#888);font-size:14px;padding:48px 0}',
      /* layout and grid wrappers */
      '.kpi-two{display:grid;grid-template-columns:1fr 1fr;gap:20px}',
      '@media(max-width:768px){.kpi-two{grid-template-columns:1fr}.kpi-cards{grid-template-columns:repeat(2,1fr)}}',
      '.chart-wrapper{background:var(--bg2,#f8fafc);border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:16px;box-sizing:border-box}',
      /* trigger button */
      '#hrms-kpi-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;border:1.5px solid var(--border,#e5e7eb);background:var(--card,#fff);color:var(--text1,#111);font-size:13px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap}',
      '#hrms-kpi-btn:hover{background:var(--accent,#6366f1);color:#fff;border-color:var(--accent,#6366f1)}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── open / close ─────────────────────────────────────────────────────── */
  function open() {
    if (document.getElementById(OVERLAY_ID)) return;
    injectStyle();
    var o = document.createElement('div');
    o.id = OVERLAY_ID;
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.body.appendChild(o);
    document.addEventListener('keydown', onKey);
    buildShell();
    
    loadChartJs(function () {
      loadAndRender();
    });

    state.timer = setInterval(function () {
      if (document.getElementById(OVERLAY_ID)) loadAndRender();
      else clearInterval(state.timer);
    }, REFRESH_MS);
  }

  function close() {
    clearInterval(state.timer);
    if (state.charts && state.charts.length) {
      state.charts.forEach(function (c) {
        try { c.destroy(); } catch (_) {}
      });
      state.charts = [];
    }
    var o = document.getElementById(OVERLAY_ID);
    if (o) o.parentNode.removeChild(o);
    document.removeEventListener('keydown', onKey);
    state.data = null;
    state.lastRenderedTab = null;
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  /* ── tabs definition ──────────────────────────────────────────────────── */
  function tabs() {
    var t = [
      ['overview',  '📊 Overview'],
      ['pipeline',  '🔄 Pipeline'],
      ['resumes',   '📄 Resume Scoring'],
      ['recordings','🎥 Recordings'],
      ['trends',    '📈 Trends'],
    ];
    if (canOrg() && state.scope === 'all') {
      t.push(['jobs',    '💼 Jobs']);
      t.push(['team',    '👥 Team Performance']);
    }
    return t;
  }

  /* ── overall "Edit Filters" drawer (matches the Job Board's) ──────────── */
  var RANGE_LABELS = { all: 'All Time', week: 'This Week', month: 'This Month', quarter: 'Last 90 Days' };
  var FILTER_KEYS = ['scope', 'range', 'role', 'dept', 'interviewer', 'interview_type', 'status', 'outcome', 'source', 'verdict', 'job_type'];
  function filterSummary() {
    var parts = [];
    if (canOrg()) parts.push(state.scope === 'all' ? 'Org View' : 'My View');
    parts.push(RANGE_LABELS[state.range] || 'All Time');
    var extra = ['role', 'dept', 'interviewer', 'interview_type', 'status', 'outcome', 'source', 'verdict', 'job_type'].filter(function (k) { return state[k]; }).length;
    if (extra) parts.push(extra + ' filter' + (extra > 1 ? 's' : ''));
    return parts.join('  ·  ');
  }
  function activeFilterDefs() {
    var f = (state.data && state.data.filters) || {};
    var defs = [];
    if (state.tab !== 'jobs') defs.push({ key: 'role', label: 'Role', all: 'All Roles', opts: f.roles || [] });
    if (canOrg() && state.scope === 'all') {
      defs.push({ key: 'dept', label: 'Department', all: 'All Departments', opts: f.departments || [] });
      if (state.tab !== 'jobs') defs.push({ key: 'interviewer', label: 'Recruiter', all: 'All Recruiters', opts: f.interviewers || [] });
    }
    if (state.tab === 'pipeline') {
      defs.push({ key: 'interview_type', label: 'Interview Type', all: 'All Interview Types', opts: f.interview_types || [] });
      defs.push({ key: 'status', label: 'Status', all: 'All Statuses', opts: f.statuses || [] });
      defs.push({ key: 'outcome', label: 'Outcome', all: 'All Outcomes', opts: f.outcomes || [] });
    } else if (state.tab === 'resumes') defs.push({ key: 'source', label: 'Source', all: 'All Sources', opts: f.sources || [] });
    else if (state.tab === 'recordings') defs.push({ key: 'verdict', label: 'Verdict', all: 'All Verdicts', opts: f.verdicts || [] });
    else if (state.tab === 'jobs') defs.push({ key: 'job_type', label: 'Job Type', all: 'All Job Types', opts: f.job_types || [] });
    return defs;
  }
  function closeKpiFilters() { var o = document.getElementById('kpi-fd-overlay'); if (o) o.remove(); }
  function openKpiFilters() {
    closeKpiFilters();
    var work = {}; FILTER_KEYS.forEach(function (k) { work[k] = state[k] || ''; });
    var ranges = [['all', 'All Time'], ['week', 'This Week'], ['month', 'This Month'], ['quarter', 'Last 90 Days']];
    var scopeSec = canOrg()
      ? '<div class="kpi-fd-sec" style="margin-top:0">View</div><div class="kpi-fd-pd">' +
          '<label><input type="radio" name="kpi-fd-scope" value="me"' + (work.scope === 'me' ? ' checked' : '') + '>My View</label>' +
          '<label><input type="radio" name="kpi-fd-scope" value="all"' + (work.scope === 'all' ? ' checked' : '') + '>Org View</label></div>'
      : '';
    var rangeSec = '<div class="kpi-fd-sec"' + (canOrg() ? '' : ' style="margin-top:0"') + '>Time Range</div><div class="kpi-fd-pd">' +
      ranges.map(function (r) { return '<label><input type="radio" name="kpi-fd-range" value="' + r[0] + '"' + (work.range === r[0] ? ' checked' : '') + '>' + r[1] + '</label>'; }).join('') + '</div>';
    var defs = activeFilterDefs();
    var filtSec = defs.length ? ('<div class="kpi-fd-sec">Filters</div>' + defs.map(function (d) {
      return '<div class="kpi-fd-fl">' + d.label + '</div><select class="kpi-fd-sel" data-fk="' + d.key + '"><option value="">' + d.all + '</option>' +
        d.opts.map(function (o) { return '<option value="' + esc(o) + '"' + (work[d.key] === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    }).join('')) : '';
    var ov = document.createElement('div'); ov.id = 'kpi-fd-overlay'; ov.className = 'kpi-fd-overlay';
    var dr = document.createElement('div'); dr.className = 'kpi-fd';
    dr.innerHTML =
      '<div class="kpi-fd-h"><h3>Edit Filters</h3><button class="kpi-fd-x" id="kpi-fd-x">&times;</button></div>' +
      '<div class="kpi-fd-body">' + scopeSec + rangeSec + filtSec + '</div>' +
      '<div class="kpi-fd-f"><button class="kpi-fd-btn primary" id="kpi-fd-apply">Apply</button><button class="kpi-fd-btn ghost" id="kpi-fd-cancel">Cancel</button></div>';
    ov.appendChild(dr); document.body.appendChild(ov);
    dr.querySelectorAll('input[name="kpi-fd-scope"]').forEach(function (r) { r.addEventListener('change', function () { work.scope = r.value; }); });
    dr.querySelectorAll('input[name="kpi-fd-range"]').forEach(function (r) { r.addEventListener('change', function () { work.range = r.value; }); });
    dr.querySelectorAll('select[data-fk]').forEach(function (s) { s.addEventListener('change', function () { work[s.getAttribute('data-fk')] = s.value; }); });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeKpiFilters(); });
    dr.querySelector('#kpi-fd-x').addEventListener('click', closeKpiFilters);
    dr.querySelector('#kpi-fd-cancel').addEventListener('click', closeKpiFilters);
    dr.querySelector('#kpi-fd-apply').addEventListener('click', function () {
      FILTER_KEYS.forEach(function (k) { state[k] = work[k]; });
      if (state.scope === 'me') { state.interviewer = ''; state.dept = ''; }
      if (state.scope === 'me' && (state.tab === 'jobs' || state.tab === 'team')) state.tab = 'overview';
      closeKpiFilters(); buildShell(); loadAndRender();
    });
  }

  /* ── shell ────────────────────────────────────────────────────────────── */
  function buildShell() {
    var o = document.getElementById(OVERLAY_ID);
    if (!o) return;
    var ICON_SLIDERS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-3px"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" fill="var(--card,#fff)"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4" fill="var(--card,#fff)"/></svg>';
    o.innerHTML =
      '<div class="kpi-modal">' +
        '<div class="kpi-head">' +
          '<div>' +
            '<div class="kpi-title">📊 Recruitment KPI Dashboard</div>' +
            '<div class="kpi-sub">Analytics across interviews, resumes & recordings</div>' +
          '</div>' +
          '<button class="kpi-x" data-kact="close">&times;</button>' +
        '</div>' +
        '<div class="kpi-toolbar">' +
          '<button class="kpi-editfilters" data-kact="editfilters">' + ICON_SLIDERS + ' Edit Filters</button>' +
          '<span class="kpi-filter-summary" id="kpi-filter-summary">' + esc(filterSummary()) + '</span>' +
          '<span class="kpi-refresh" id="kpi-refresh-lbl"></span>' +
        '</div>' +
        '<div class="kpi-tabs" id="kpi-tabs-bar">' +
          tabs().map(function (t) {
            return '<button class="kpi-tab' + (state.tab === t[0] ? ' active' : '') + '" data-kact="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
          }).join('') +
        '</div>' +
        '<div class="kpi-body" id="kpi-body"></div>' +
      '</div>';
    wire();
  }

  function wire() {
    var o = document.getElementById(OVERLAY_ID);
    if (!o) return;
    
    o.onclick = function (e) {
      var el = e.target.closest('[data-kact]');
      if (!el) return;
      var act = el.getAttribute('data-kact');
      if (act === 'close') { close(); return; }
      if (act === 'editfilters') { openKpiFilters(); return; }
      if (act === 'tab') {
        state.tab = el.getAttribute('data-tab');
        
        // Reset tab-specific filters to keep switching clean
        state.interview_type = '';
        state.status = '';
        state.outcome = '';
        state.source = '';
        state.verdict = '';
        state.job_type = '';

        updateTabs();
        buildShell();
        loadAndRender();
        return;
      }
      if (act === 'scope') {
        state.scope = el.getAttribute('data-val');
        if (state.scope === 'me') {
          state.interviewer = '';
          state.dept = '';
        }
        if (state.scope === 'me' && (state.tab === 'jobs' || state.tab === 'team')) state.tab = 'overview';
        buildShell();
        loadAndRender();
        return;
      }
    };

    o.onchange = function (e) {
      var act = e.target.getAttribute('data-kact');
      if (!act) return;
      if (act === 'range') {
        state.range = e.target.value;
      } else if (act === 'filter-role') {
        state.role = e.target.value;
      } else if (act === 'filter-dept') {
        state.dept = e.target.value;
      } else if (act === 'filter-interviewer') {
        state.interviewer = e.target.value;
      } else if (act === 'filter-type') {
        state.interview_type = e.target.value;
      } else if (act === 'filter-status') {
        state.status = e.target.value;
      } else if (act === 'filter-outcome') {
        state.outcome = e.target.value;
      } else if (act === 'filter-source') {
        state.source = e.target.value;
      } else if (act === 'filter-verdict') {
        state.verdict = e.target.value;
      } else if (act === 'filter-jobtype') {
        state.job_type = e.target.value;
      }
      loadAndRender();
    };
  }

  function updateTabs() {
    var bar = document.getElementById('kpi-tabs-bar');
    if (!bar) return;
    bar.innerHTML = tabs().map(function (t) {
      return '<button class="kpi-tab' + (state.tab === t[0] ? ' active' : '') + '" data-kact="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
  }

  function setBody(html) {
    if (state.charts && state.charts.length) {
      state.charts.forEach(function (c) {
        try { c.destroy(); } catch (_) {}
      });
      state.charts = [];
    }
    var b = document.getElementById('kpi-body');
    if (b) b.innerHTML = html;
  }

  function populateFilters() {
    var container = document.getElementById('kpi-dynamic-filters');
    if (!container || !state.data || !state.data.filters) return;
    
    var filters = state.data.filters;
    var html = '';
    
    // 1. Role filter (Show on all tabs except Jobs)
    if (state.tab !== 'jobs') {
      html += '<select class="kpi-filter-select" data-kact="filter-role" id="kpi-role-sel">';
      html += '<option value="">All Roles</option>';
      (filters.roles || []).forEach(function (role) {
        html += '<option value="' + esc(role) + '"' + (state.role === role ? ' selected' : '') + '>' + esc(role) + '</option>';
      });
      html += '</select>';
    }

    // 2. Department & Recruiter filters
    if (canOrg() && state.scope === 'all') {
      html += '<select class="kpi-filter-select" data-kact="filter-dept" id="kpi-dept-sel">';
      html += '<option value="">All Departments</option>';
      (filters.departments || []).forEach(function (dept) {
        html += '<option value="' + esc(dept) + '"' + (state.dept === dept ? ' selected' : '') + '>' + esc(dept) + '</option>';
      });
      html += '</select>';
      
      if (state.tab !== 'jobs') {
        html += '<select class="kpi-filter-select" data-kact="filter-interviewer" id="kpi-interviewer-sel">';
        html += '<option value="">All Recruiters</option>';
        (filters.interviewers || []).forEach(function (intv) {
          html += '<option value="' + esc(intv) + '"' + (state.interviewer === intv ? ' selected' : '') + '>' + esc(intv) + '</option>';
        });
        html += '</select>';
      }
    }

    // 3. Tab-Specific Filters
    if (state.tab === 'pipeline') {
      html += '<select class="kpi-filter-select" data-kact="filter-type" id="kpi-type-sel">';
      html += '<option value="">All Interview Types</option>';
      (filters.interview_types || []).forEach(function (t) {
        html += '<option value="' + esc(t) + '"' + (state.interview_type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
      });
      html += '</select>';

      html += '<select class="kpi-filter-select" data-kact="filter-status" id="kpi-status-sel">';
      html += '<option value="">All Statuses</option>';
      (filters.statuses || []).forEach(function (s) {
        html += '<option value="' + esc(s) + '"' + (state.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
      });
      html += '</select>';

      html += '<select class="kpi-filter-select" data-kact="filter-outcome" id="kpi-outcome-sel">';
      html += '<option value="">All Outcomes</option>';
      (filters.outcomes || []).forEach(function (o) {
        html += '<option value="' + esc(o) + '"' + (state.outcome === o ? ' selected' : '') + '>' + esc(o) + '</option>';
      });
      html += '</select>';
    } else if (state.tab === 'resumes') {
      html += '<select class="kpi-filter-select" data-kact="filter-source" id="kpi-source-sel">';
      html += '<option value="">All Sources</option>';
      (filters.sources || []).forEach(function (src) {
        html += '<option value="' + esc(src) + '"' + (state.source === src ? ' selected' : '') + '>' + esc(src) + '</option>';
      });
      html += '</select>';
    } else if (state.tab === 'recordings') {
      html += '<select class="kpi-filter-select" data-kact="filter-verdict" id="kpi-verdict-sel">';
      html += '<option value="">All Verdicts</option>';
      (filters.verdicts || []).forEach(function (v) {
        html += '<option value="' + esc(v) + '"' + (state.verdict === v ? ' selected' : '') + '>' + esc(v) + '</option>';
      });
      html += '</select>';
    } else if (state.tab === 'jobs') {
      html += '<select class="kpi-filter-select" data-kact="filter-jobtype" id="kpi-jobtype-sel">';
      html += '<option value="">All Job Types</option>';
      (filters.job_types || []).forEach(function (jt) {
        html += '<option value="' + esc(jt) + '"' + (state.job_type === jt ? ' selected' : '') + '>' + esc(jt) + '</option>';
      });
      html += '</select>';
    }
    
    container.innerHTML = html;
  }

  function loadAndRender() {
    var refreshLbl = document.getElementById('kpi-refresh-lbl');
    if (refreshLbl) {
      refreshLbl.innerHTML = '<span class="kpi-spinner"></span> Updating…';
    }
    var bodyEl = document.getElementById('kpi-body');
    if (bodyEl) {
      bodyEl.style.opacity = '0.65';
      bodyEl.style.transition = 'opacity 0.2s ease';
    }

    fetchKpis().then(function (r) {
      if (bodyEl) bodyEl.style.opacity = '1';
      if (!r.ok || !r.data) {
        setBody('<div class="kpi-empty">Failed to load KPIs. Check the server is running.</div>');
        return;
      }
      state.data = r.data;
      populateFilters();
      var lbl = document.getElementById('kpi-refresh-lbl');
      if (lbl) lbl.textContent = 'Updated ' + new Date().toLocaleTimeString();
      renderBody();
    });
  }

  function renderBody() {
    var d = state.data;
    if (!d) { setBody('<div class="kpi-loading">Loading…</div>'); return; }
    
    var b = document.getElementById('kpi-body');
    var needsRebuild = !b || b.innerHTML === '' || state.lastRenderedTab !== state.tab;
    state.lastRenderedTab = state.tab;

    if (state.tab === 'overview') {
      if (needsRebuild) setBody(renderOverview(d));
      else updateOverviewCards(d);
      initOverviewCharts(d);
    } else if (state.tab === 'pipeline') {
      if (needsRebuild) setBody(renderPipeline(d));
      else updatePipelineCards(d);
      initPipelineCharts(d);
    } else if (state.tab === 'resumes') {
      if (needsRebuild) setBody(renderResumes(d));
      else updateResumesCards(d);
      initResumesCharts(d);
    } else if (state.tab === 'recordings') {
      if (needsRebuild) setBody(renderRecordings(d));
      else updateRecordingsCards(d);
      initRecordingsCharts(d);
    } else if (state.tab === 'trends') {
      if (needsRebuild) setBody(renderTrends(d));
      initTrendsCharts(d);
    } else if (state.tab === 'jobs') {
      if (needsRebuild) setBody(renderJobs(d));
      else updateJobsCards(d);
      initJobsCharts(d);
    } else if (state.tab === 'team') {
      if (needsRebuild) setBody(renderTeam(d));
      initTeamCharts(d);
    }
    addChartFilters();
  }

  /* ── per-chart filters: each chart gets its own show/hide-categories control ── */
  function addChartFilters() {
    var wraps = document.querySelectorAll('#hrms-kpi-overlay .chart-wrapper');
    for (var w = 0; w < wraps.length; w++) {
      (function (wrap) {
        var canvas = wrap.querySelector('canvas');
        var title = wrap.querySelector('.kpi-section-title');
        if (!canvas || !title || wrap.querySelector('.kpi-cf-btn')) return;
        var chart = state.charts.find(function (c) { return c.canvas && c.canvas.id === canvas.id; });
        if (!chart || !chart.data || !(chart.data.labels || []).length) return;
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'kpi-cf-btn'; btn.innerHTML = '&#9662; Filter';
        wrap.appendChild(btn);
        btn.addEventListener('click', function (e) { e.stopPropagation(); openChartFilter(btn, chart); });
      })(wraps[w]);
    }
  }
  function closeChartFilter() { var p = document.getElementById('kpi-cf-pop'); if (p) p.remove(); }
  function toggleChartLabel(chart, i, show) {
    if (!chart._origData) chart._origData = chart.data.datasets.map(function (ds) { return ds.data.slice(); });
    if (!chart._hidden) chart._hidden = {};
    chart._hidden[i] = !show;
    chart.data.datasets.forEach(function (ds, di) { ds.data = chart._origData[di].map(function (v, idx) { return chart._hidden[idx] ? null : v; }); });
    chart.update();
  }
  function openChartFilter(btn, chart) {
    if (document.getElementById('kpi-cf-pop')) { closeChartFilter(); return; }
    var labels = (chart.data && chart.data.labels) || [];
    var pop = document.createElement('div'); pop.id = 'kpi-cf-pop'; pop.className = 'kpi-cf-pop';
    pop.innerHTML = labels.map(function (lb, i) {
      var vis = !(chart._hidden && chart._hidden[i]);
      return '<label><input type="checkbox" data-i="' + i + '"' + (vis ? ' checked' : '') + '> ' + esc(String(lb)) + '</label>';
    }).join('');
    document.body.appendChild(pop);
    var r = btn.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 270) + 'px';
    pop.style.left = Math.min(r.left, window.innerWidth - 190) + 'px';
    pop.querySelectorAll('input').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleChartLabel(chart, +cb.getAttribute('data-i'), cb.checked);
        var anyHidden = chart._hidden && Object.keys(chart._hidden).some(function (k) { return chart._hidden[k]; });
        btn.classList.toggle('on', !!anyHidden);
      });
    });
    setTimeout(function () { document.addEventListener('mousedown', function h(e) { var p = document.getElementById('kpi-cf-pop'); if (p && !p.contains(e.target) && e.target !== btn) { p.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
  }

  /* ── helper: update values without destroying canvas elements ───────── */
  function updateVal(id, val, sub) {
    var valEl = document.getElementById(id + '-val');
    if (valEl) valEl.textContent = val;
    var subEl = document.getElementById(id + '-sub');
    if (subEl) {
      if (sub) {
        subEl.textContent = sub;
        subEl.style.display = '';
      } else {
        subEl.style.display = 'none';
      }
    }
  }

  /* ── Chart configuration helpers ───────────────────────────────────────── */
  function getThemeColors() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
      textColor: isDark ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.6)',
      accent: '#6366f1',
      success: '#10b981',
      warning: '#f59e0b',
      danger: '#ef4444',
      info: '#06b6d4',
      neutral: isDark ? '#475569' : '#94a3b8',
      cardBg: isDark ? '#1e293b' : '#ffffff'
    };
  }

  function doughnutOptions(colors) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: colors.textColor,
            font: { family: "'DM Sans', sans-serif", size: 11, weight: '500' }
          }
        },
        tooltip: {
          backgroundColor: colors.cardBg,
          titleColor: colors.textColor,
          bodyColor: colors.textColor,
          borderColor: colors.gridColor,
          borderWidth: 1
        }
      }
    };
  }

  function barOptions(colors, displayLegend, horizontal) {
    return {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: !!displayLegend,
          labels: {
            color: colors.textColor,
            font: { family: "'DM Sans', sans-serif", size: 11, weight: '500' }
          }
        },
        tooltip: {
          backgroundColor: colors.cardBg,
          titleColor: colors.textColor,
          bodyColor: colors.textColor,
          borderColor: colors.gridColor,
          borderWidth: 1
        }
      },
      scales: {
        x: {
          grid: { color: colors.gridColor },
          ticks: { color: colors.textColor, font: { family: "'DM Sans', sans-serif", size: 10 } }
        },
        y: {
          grid: { color: colors.gridColor },
          ticks: { color: colors.textColor, font: { family: "'DM Sans', sans-serif", size: 10 } }
        }
      }
    };
  }

  /* ── Overview ─────────────────────────────────────────────────────────── */
  function renderOverview(d) {
    var p = d.pipeline || {};
    var rs = d.resumeScoring || {};
    var rc = d.recordings || {};

    var cards = [
      { id: 'kpi-ov-total', label: 'Total Interviews', val: num(p.total), sub: '', color: 'blue' },
      { id: 'kpi-ov-shortlist', label: 'Shortlist Rate',   val: pct(p.shortlistRate), sub: num(p.byOutcome && p.byOutcome.find && (p.byOutcome.find(function(x){return x.outcome==='Selected';}) || {}).count || 0) + ' selected', color: 'green' },
      { id: 'kpi-ov-rejection', label: 'Rejection Rate',   val: pct(p.rejectionRate), sub: num((p.byOutcome && p.byOutcome.find && (p.byOutcome.find(function(x){return x.outcome==='Rejected';}) || {}).count) || 0) + ' rejected', color: 'red' },
      { id: 'kpi-ov-avg-score', label: 'Avg Candidate Score', val: score(p.avgCandidateScore), sub: 'out of 100', color: 'indigo' },
      { id: 'kpi-ov-resumes', label: 'Resumes Screened',  val: num(rs.total), sub: '', color: 'cyan' },
      { id: 'kpi-ov-high-match', label: 'High-Match Resumes', val: num(rs.highMatch), sub: 'score ≥ 75', color: 'green' },
      { id: 'kpi-ov-avg-resume', label: 'Avg Resume Score',   val: score(rs.avgScore), sub: 'out of 100', color: 'purple' },
      { id: 'kpi-ov-recordings', label: 'Recorded Interviews',val: num(rc.total), sub: '', color: 'amber' },
    ];
    if (d.jobs) {
      cards.push({ id: 'kpi-ov-jobs', label: 'Open Positions', val: num(d.jobs.totalOpenings), sub: num(d.jobs.totalJobs) + ' job posts', color: 'pink' });
    }

    var html = '<div class="kpi-cards">' +
      cards.map(function (c) {
        return kpiCard(c.label, c.val, c.sub, c.color, c.id);
      }).join('') +
    '</div>';

    html += '<div class="kpi-two">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Outcome Distribution</div>' +
        '<div style="position:relative;height:220px;"><canvas id="chart-overview-outcome"></canvas></div>' +
      '</div>' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Email Delivery Status</div>' +
        '<div style="position:relative;height:220px;"><canvas id="chart-overview-emails"></canvas></div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function updateOverviewCards(d) {
    var p = d.pipeline || {};
    var rs = d.resumeScoring || {};
    var rc = d.recordings || {};

    updateVal('kpi-ov-total', num(p.total));
    updateVal('kpi-ov-shortlist', pct(p.shortlistRate), num(p.byOutcome && p.byOutcome.find && (p.byOutcome.find(function(x){return x.outcome==='Selected';}) || {}).count || 0) + ' selected');
    updateVal('kpi-ov-rejection', pct(p.rejectionRate), num((p.byOutcome && p.byOutcome.find && (p.byOutcome.find(function(x){return x.outcome==='Rejected';}) || {}).count) || 0) + ' rejected');
    updateVal('kpi-ov-avg-score', score(p.avgCandidateScore));
    updateVal('kpi-ov-resumes', num(rs.total));
    updateVal('kpi-ov-high-match', num(rs.highMatch));
    updateVal('kpi-ov-avg-resume', score(rs.avgScore));
    updateVal('kpi-ov-recordings', num(rc.total));
    if (d.jobs) {
      updateVal('kpi-ov-jobs', num(d.jobs.totalOpenings), num(d.jobs.totalJobs) + ' job posts');
    }
  }

  function initOverviewCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var p = d.pipeline || {};

    var outcomes = p.byOutcome || [];
    var labels = outcomes.map(function(x) { return x.outcome; });
    var data = outcomes.map(function(x) { return x.count; });
    var bg = outcomes.map(function(x) {
      if (x.outcome === 'Selected') return colors.success;
      if (x.outcome === 'Rejected') return colors.danger;
      if (x.outcome === 'Waitlisted') return colors.warning;
      return colors.neutral;
    });

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-overview-outcome'; });
    if (c1) {
      c1.data.labels = labels.length ? labels : ['No Data'];
      c1.data.datasets[0].data = data.length ? data : [0];
      c1.data.datasets[0].backgroundColor = bg.length ? bg : [colors.neutral];
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-overview-outcome');
      if (ctx1) {
        var chart1 = new Chart(ctx1, {
          type: 'doughnut',
          data: {
            labels: labels.length ? labels : ['No Data'],
            datasets: [{
              data: data.length ? data : [0],
              backgroundColor: bg.length ? bg : [colors.neutral],
              borderWidth: 1,
              borderColor: colors.cardBg
            }]
          },
          options: doughnutOptions(colors)
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-overview-emails'; });
    if (c2) {
      c2.data.datasets[0].data = [p.emailsSent || 0, p.emailsPending || 0, p.pendingOutcome || 0];
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-overview-emails');
      if (ctx2) {
        var chart2 = new Chart(ctx2, {
          type: 'bar',
          data: {
            labels: ['Sent', 'Pending', 'Awaiting Decision'],
            datasets: [{
              label: 'Emails',
              data: [p.emailsSent || 0, p.emailsPending || 0, p.pendingOutcome || 0],
              backgroundColor: [colors.success, colors.warning, colors.danger],
              borderWidth: 0,
              borderRadius: 6
            }]
          },
          options: barOptions(colors, false, false)
        });
        state.charts.push(chart2);
      }
    }
  }

  /* ── Pipeline ─────────────────────────────────────────────────────────── */
  function renderPipeline(d) {
    var p = d.pipeline || {};
    var html = '';

    html += '<div class="kpi-cards">' +
      kpiCard('Total Interviews', p.total, '', 'blue', 'kpi-pl-total') +
      kpiCard('Shortlist Rate', pct(p.shortlistRate), '', 'green', 'kpi-pl-shortlist') +
      kpiCard('Rejection Rate', pct(p.rejectionRate), '', 'red', 'kpi-pl-rejection') +
      kpiCard('Waitlist Rate', pct(p.waitlistRate), '', 'amber', 'kpi-pl-waitlist') +
      kpiCard('Avg Score', score(p.avgCandidateScore), 'out of 100', 'indigo', 'kpi-pl-avg-score') +
      kpiCard('Emails Sent', p.emailsSent, '', 'green', 'kpi-pl-emails') +
      kpiCard('Pending', p.emailsPending, 'not sent', 'amber', 'kpi-pl-pending') +
      kpiCard('Awaiting Outcome', p.pendingOutcome, 'no decision', 'red', 'kpi-pl-awaiting') +
    '</div>';

    html += '<div class="kpi-two">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Interview Status Breakdown</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-pipeline-status"></canvas></div>' +
      '</div>' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Interview Outcomes</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-pipeline-outcome"></canvas></div>' +
      '</div>' +
    '</div>';

    html += '<div class="kpi-section" style="margin-top:20px;">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">By Interview Type</div>' +
        '<div style="position:relative;height:200px;"><canvas id="chart-pipeline-type"></canvas></div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function updatePipelineCards(d) {
    var p = d.pipeline || {};
    updateVal('kpi-pl-total', num(p.total));
    updateVal('kpi-pl-shortlist', pct(p.shortlistRate));
    updateVal('kpi-pl-rejection', pct(p.rejectionRate));
    updateVal('kpi-pl-waitlist', pct(p.waitlistRate));
    updateVal('kpi-pl-avg-score', score(p.avgCandidateScore));
    updateVal('kpi-pl-emails', num(p.emailsSent));
    updateVal('kpi-pl-pending', num(p.emailsPending));
    updateVal('kpi-pl-awaiting', num(p.pendingOutcome));
  }

  function initPipelineCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var p = d.pipeline || {};
    var byStatus = p.byStatus || [];
    var outcomes = p.byOutcome || [];
    var byType = p.byInterviewType || [];

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-pipeline-status'; });
    if (c1) {
      c1.data.labels = byStatus.map(function(x){return x.status || 'Unknown';});
      c1.data.datasets[0].data = byStatus.map(function(x){return x.count;});
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-pipeline-status');
      if (ctx1) {
        var chart1 = new Chart(ctx1, {
          type: 'bar',
          data: {
            labels: byStatus.map(function(x){return x.status || 'Unknown';}),
            datasets: [{
              label: 'Interviews',
              data: byStatus.map(function(x){return x.count;}),
              backgroundColor: colors.accent,
              borderRadius: 4
            }]
          },
          options: barOptions(colors, false, true)
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-pipeline-outcome'; });
    if (c2) {
      var bg = outcomes.map(function(x) {
        if (x.outcome === 'Selected') return colors.success;
        if (x.outcome === 'Rejected') return colors.danger;
        if (x.outcome === 'Waitlisted') return colors.warning;
        return colors.neutral;
      });
      c2.data.labels = outcomes.map(function(x){return x.outcome;});
      c2.data.datasets[0].data = outcomes.map(function(x){return x.count;});
      c2.data.datasets[0].backgroundColor = bg;
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-pipeline-outcome');
      if (ctx2) {
        var bg = outcomes.map(function(x) {
          if (x.outcome === 'Selected') return colors.success;
          if (x.outcome === 'Rejected') return colors.danger;
          if (x.outcome === 'Waitlisted') return colors.warning;
          return colors.neutral;
        });
        var chart2 = new Chart(ctx2, {
          type: 'doughnut',
          data: {
            labels: outcomes.map(function(x){return x.outcome;}),
            datasets: [{
              data: outcomes.map(function(x){return x.count;}),
              backgroundColor: bg,
              borderWidth: 1,
              borderColor: colors.cardBg
            }]
          },
          options: doughnutOptions(colors)
        });
        state.charts.push(chart2);
      }
    }

    var c3 = state.charts.find(function(c) { return c.canvas.id === 'chart-pipeline-type'; });
    if (c3) {
      c3.data.labels = byType.map(function(x){return x.type;});
      c3.data.datasets[0].data = byType.map(function(x){return x.count;});
      c3.update();
    } else {
      var ctx3 = document.getElementById('chart-pipeline-type');
      if (ctx3) {
        var chart3 = new Chart(ctx3, {
          type: 'bar',
          data: {
            labels: byType.map(function(x){return x.type;}),
            datasets: [{
              label: 'Interviews',
              data: byType.map(function(x){return x.count;}),
              backgroundColor: colors.info,
              borderRadius: 6
            }]
          },
          options: barOptions(colors, false, false)
        });
        state.charts.push(chart3);
      }
    }
  }

  /* ── Resume Scoring ───────────────────────────────────────────────────── */
  function renderResumes(d) {
    var rs = d.resumeScoring || {};
    var html = '';

    html += '<div class="kpi-cards">' +
      kpiCard('Total Screened', rs.total, '', 'blue', 'kpi-res-total') +
      kpiCard('High-Match ≥75', rs.highMatch, '', 'green', 'kpi-res-high') +
      kpiCard('High-Match Rate', pct(rs.highMatchRate), '', 'green', 'kpi-res-rate') +
      kpiCard('Avg Overall Score', score(rs.avgScore), 'out of 100', 'indigo', 'kpi-res-avg') +
    '</div>';

    html += '<div class="kpi-two">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Average Resume Scores</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-resumes-scores"></canvas></div>' +
      '</div>' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Resumes by Source</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-resumes-sources"></canvas></div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function updateResumesCards(d) {
    var rs = d.resumeScoring || {};
    updateVal('kpi-res-total', num(rs.total));
    updateVal('kpi-res-high', num(rs.highMatch));
    updateVal('kpi-res-rate', pct(rs.highMatchRate));
    updateVal('kpi-res-avg', score(rs.avgScore));
  }

  function initResumesCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var rs = d.resumeScoring || {};

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-resumes-scores'; });
    if (c1) {
      c1.data.datasets[0].data = [rs.avgScore || 0, rs.avgTechnical || 0, rs.avgExperience || 0, rs.avgDomain || 0];
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-resumes-scores');
      if (ctx1) {
        var chart1 = new Chart(ctx1, {
          type: 'radar',
          data: {
            labels: ['Overall', 'Technical', 'Experience', 'Domain'],
            datasets: [{
              label: 'Average Score',
              data: [rs.avgScore || 0, rs.avgTechnical || 0, rs.avgExperience || 0, rs.avgDomain || 0],
              backgroundColor: 'rgba(99, 102, 241, 0.2)',
              borderColor: colors.accent,
              pointBackgroundColor: colors.accent,
              pointBorderColor: '#fff',
              pointHoverBackgroundColor: '#fff',
              pointHoverBorderColor: colors.accent,
              borderWidth: 2
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { backgroundColor: colors.cardBg, titleColor: colors.textColor, bodyColor: colors.textColor }
            },
            scales: {
              r: {
                angleLines: { color: colors.gridColor },
                grid: { color: colors.gridColor },
                pointLabels: { color: colors.textColor, font: { family: "'DM Sans', sans-serif", size: 10 } },
                ticks: { backdropColor: 'transparent', color: colors.textColor, min: 0, max: 100, stepSize: 20 }
              }
            }
          }
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-resumes-sources'; });
    if (c2) {
      var sources = rs.bySource || [];
      var bgColors = [colors.accent, colors.success, colors.warning, colors.info, colors.danger];
      c2.data.labels = sources.map(function(x){return x.source;});
      c2.data.datasets[0].data = sources.map(function(x){return x.count;});
      c2.data.datasets[0].backgroundColor = bgColors.slice(0, sources.length);
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-resumes-sources');
      if (ctx2) {
        var sources = rs.bySource || [];
        var bgColors = [colors.accent, colors.success, colors.warning, colors.info, colors.danger];
        var chart2 = new Chart(ctx2, {
          type: 'pie',
          data: {
            labels: sources.map(function(x){return x.source;}),
            datasets: [{
              data: sources.map(function(x){return x.count;}),
              backgroundColor: bgColors.slice(0, sources.length),
              borderWidth: 1,
              borderColor: colors.cardBg
            }]
          },
          options: doughnutOptions(colors)
        });
        state.charts.push(chart2);
      }
    }
  }

  /* ── Recordings ───────────────────────────────────────────────────────── */
  function renderRecordings(d) {
    var rc = d.recordings || {};
    var html = '';

    html += '<div class="kpi-cards">' +
      kpiCard('Total Recordings', rc.total, '', 'blue', 'kpi-rec-total') +
      kpiCard('Avg Total Score', score(rc.avgTotalScore), 'out of 100', 'indigo', 'kpi-rec-avg-total') +
      kpiCard('Avg Tech Score', score(rc.avgTechScore), 'out of 100', 'cyan', 'kpi-rec-avg-tech') +
      kpiCard('Avg Comm Score', score(rc.avgCommScore), 'out of 100', 'green', 'kpi-rec-avg-comm') +
      kpiCard('Avg Integrity', score(rc.avgIntegrityScore), 'out of 100', 'purple', 'kpi-rec-avg-integ') +
      kpiCard('Avg Duration', rc.avgDuration || '—', '', 'amber', 'kpi-rec-avg-dur') +
    '</div>';

    html += '<div class="kpi-two">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">A.I. Verdict Distribution</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-recordings-verdict"></canvas></div>' +
      '</div>' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">A.I. Performance Breakdown</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-recordings-scores"></canvas></div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function updateRecordingsCards(d) {
    var rc = d.recordings || {};
    updateVal('kpi-rec-total', num(rc.total));
    updateVal('kpi-rec-avg-total', score(rc.avgTotalScore));
    updateVal('kpi-rec-avg-tech', score(rc.avgTechScore));
    updateVal('kpi-rec-avg-comm', score(rc.avgCommScore));
    updateVal('kpi-rec-avg-integ', score(rc.avgIntegrityScore));
    updateVal('kpi-rec-avg-dur', rc.avgDuration || '—');
  }

  function initRecordingsCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var rc = d.recordings || {};
    var verdicts = rc.byVerdict || [];

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-recordings-verdict'; });
    if (c1) {
      var bg = verdicts.map(function(x) {
        if (x.verdict === 'PASS') return colors.success;
        if (x.verdict === 'FAIL') return colors.danger;
        return colors.warning;
      });
      c1.data.labels = verdicts.map(function(x){return x.verdict;});
      c1.data.datasets[0].data = verdicts.map(function(x){return x.count;});
      c1.data.datasets[0].backgroundColor = bg;
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-recordings-verdict');
      if (ctx1) {
        var bg = verdicts.map(function(x) {
          if (x.verdict === 'PASS') return colors.success;
          if (x.verdict === 'FAIL') return colors.danger;
          return colors.warning;
        });
        var chart1 = new Chart(ctx1, {
          type: 'doughnut',
          data: {
            labels: verdicts.map(function(x){return x.verdict;}),
            datasets: [{
              data: verdicts.map(function(x){return x.count;}),
              backgroundColor: bg,
              borderWidth: 1,
              borderColor: colors.cardBg
            }]
          },
          options: doughnutOptions(colors)
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-recordings-scores'; });
    if (c2) {
      c2.data.datasets[0].data = [rc.avgTechScore || 0, rc.avgCommScore || 0, rc.avgIntegrityScore || 0, rc.avgTotalScore || 0];
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-recordings-scores');
      if (ctx2) {
        var chart2 = new Chart(ctx2, {
          type: 'bar',
          data: {
            labels: ['Technical', 'Communication', 'Integrity', 'Total Score'],
            datasets: [{
              label: 'Average Score',
              data: [rc.avgTechScore || 0, rc.avgCommScore || 0, rc.avgIntegrityScore || 0, rc.avgTotalScore || 0],
              backgroundColor: [colors.info, colors.success, colors.purple, colors.accent],
              borderRadius: 6
            }]
          },
          options: barOptions(colors, false, false)
        });
        state.charts.push(chart2);
      }
    }
  }

  /* ── Trends ───────────────────────────────────────────────────────────── */
  function renderTrends(d) {
    var tr = d.trends || {};
    var monthly = tr.monthly || [];
    var weekly  = tr.weekly  || [];
    var html = '';

    html += '<div class="kpi-section">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Monthly Recruitment Activity (Last 12 Months)</div>' +
        '<div style="position:relative;height:260px;"><canvas id="chart-trends-monthly"></canvas></div>' +
      '</div>' +
    '</div>';

    if (weekly.length > 0) {
      html += '<div class="kpi-section" style="margin-top:20px;">' +
        '<div class="chart-wrapper">' +
          '<div class="kpi-section-title">Weekly Activity (Last 12 Weeks)</div>' +
          '<div style="position:relative;height:240px;"><canvas id="chart-trends-weekly"></canvas></div>' +
        '</div>' +
      '</div>';
    }

    if (monthly.length > 0) {
      html += '<div class="kpi-section" style="margin-top:20px;"><div class="kpi-section-title">Monthly Breakdown</div>' +
        '<div style="overflow-x:auto"><table class="kpi-tbl">' +
        '<thead><tr><th>Month</th><th>Total</th><th>Selected</th><th>Shortlist Rate</th></tr></thead><tbody>';
      monthly.slice().reverse().forEach(function (m) {
        html += '<tr><td>' + esc(m.month || '—') + '</td><td>' + m.total + '</td><td>' + (m.selected || 0) + '</td>' +
          '<td><span style="color:#10b981;font-weight:700">' + pct(m.shortlistRate) + '</span></td></tr>';
      });
      html += '</tbody></table></div></div>';
    }

    return html;
  }

  function initTrendsCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var tr = d.trends || {};
    var monthly = tr.monthly || [];
    var weekly = tr.weekly || [];

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-trends-monthly'; });
    if (c1 && monthly.length > 0) {
      c1.data.labels = monthly.map(function(m){ return m.month ? m.month.replace(/^\d{4}-/, '') : ''; });
      c1.data.datasets[0].data = monthly.map(function(m){return m.selected || 0;});
      c1.data.datasets[1].data = monthly.map(function(m){return m.total || 0;});
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-trends-monthly');
      if (ctx1 && monthly.length > 0) {
        var chart1 = new Chart(ctx1, {
          type: 'bar',
          data: {
            labels: monthly.map(function(m){
              return m.month ? m.month.replace(/^\d{4}-/, '') : '';
            }),
            datasets: [
              {
                type: 'line',
                label: 'Selected Candidates',
                data: monthly.map(function(m){return m.selected || 0;}),
                borderColor: colors.success,
                borderWidth: 2,
                tension: 0.3,
                fill: false,
                pointBackgroundColor: colors.success
              },
              {
                type: 'bar',
                label: 'Total Interviews',
                data: monthly.map(function(m){return m.total || 0;}),
                backgroundColor: 'rgba(99, 102, 241, 0.4)',
                borderColor: colors.accent,
                borderWidth: 1,
                borderRadius: 4
              }
            ]
          },
          options: barOptions(colors, true, false)
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-trends-weekly'; });
    if (c2 && weekly.length > 0) {
      c2.data.labels = weekly.map(function(w){return w.week || '';});
      c2.data.datasets[0].data = weekly.map(function(w){return w.total || 0;});
      c2.data.datasets[1].data = weekly.map(function(w){return w.selected || 0;});
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-trends-weekly');
      if (ctx2 && weekly.length > 0) {
        var chart2 = new Chart(ctx2, {
          type: 'line',
          data: {
            labels: weekly.map(function(w){return w.week || '';}),
            datasets: [
              {
                label: 'Total Interviews',
                data: weekly.map(function(w){return w.total || 0;}),
                borderColor: colors.accent,
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                fill: true,
                tension: 0.3
              },
              {
                label: 'Selected',
                data: weekly.map(function(w){return w.selected || 0;}),
                borderColor: colors.success,
                fill: false,
                tension: 0.3
              }
            ]
          },
          options: barOptions(colors, true, false)
        });
        state.charts.push(chart2);
      }
    }
  }

  /* ── Jobs ─────────────────────────────────────────────────────────────── */
  function renderJobs(d) {
    var j = d.jobs;
    if (!j) return '<div class="kpi-empty">Jobs data not available. Switch to Org View.</div>';
    var html = '';

    html += '<div class="kpi-cards">' +
      kpiCard('Total Job Posts', j.totalJobs, '', 'blue', 'kpi-jb-total') +
      kpiCard('Total Openings', j.totalOpenings, 'positions', 'green', 'kpi-jb-openings') +
      kpiCard('Remote', j.remote, 'jobs', 'cyan', 'kpi-jb-remote') +
      kpiCard('On-Site', j.onsite, 'jobs', 'amber', 'kpi-jb-onsite') +
    '</div>';

    html += '<div class="kpi-two">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Jobs by Department</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-jobs-dept"></canvas></div>' +
      '</div>' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Jobs by Type</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-jobs-type"></canvas></div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function updateJobsCards(d) {
    var j = d.jobs || {};
    updateVal('kpi-jb-total', num(j.totalJobs));
    updateVal('kpi-jb-openings', num(j.totalOpenings));
    updateVal('kpi-jb-remote', num(j.remote));
    updateVal('kpi-jb-onsite', num(j.onsite));
  }

  function initJobsCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var j = d.jobs || {};
    var depts = j.byDepartment || [];
    var types = j.byType || [];

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-jobs-dept'; });
    if (c1) {
      var bgColors = [colors.accent, colors.success, colors.warning, colors.info, colors.danger, colors.neutral, '#ec4899', '#a855f7'];
      c1.data.labels = depts.map(function(x){return x.dept;});
      c1.data.datasets[0].data = depts.map(function(x){return x.count;});
      c1.data.datasets[0].backgroundColor = bgColors.slice(0, depts.length);
      c1.update();
    } else {
      var ctx1 = document.getElementById('chart-jobs-dept');
      if (ctx1 && j.byDepartment) {
        var bgColors = [colors.accent, colors.success, colors.warning, colors.info, colors.danger, colors.neutral, '#ec4899', '#a855f7'];
        var chart1 = new Chart(ctx1, {
          type: 'doughnut',
          data: {
            labels: depts.map(function(x){return x.dept;}),
            datasets: [{
              data: depts.map(function(x){return x.count;}),
              backgroundColor: bgColors.slice(0, depts.length),
              borderWidth: 1,
              borderColor: colors.cardBg
            }]
          },
          options: doughnutOptions(colors)
        });
        state.charts.push(chart1);
      }
    }

    var c2 = state.charts.find(function(c) { return c.canvas.id === 'chart-jobs-type'; });
    if (c2) {
      c2.data.labels = types.map(function(x){return x.type;});
      c2.data.datasets[0].data = types.map(function(x){return x.count;});
      c2.update();
    } else {
      var ctx2 = document.getElementById('chart-jobs-type');
      if (ctx2 && j.byType) {
        var chart2 = new Chart(ctx2, {
          type: 'bar',
          data: {
            labels: types.map(function(x){return x.type;}),
            datasets: [{
              label: 'Jobs',
              data: types.map(function(x){return x.count;}),
              backgroundColor: colors.info,
              borderRadius: 6
            }]
          },
          options: barOptions(colors, false, false)
        });
        state.charts.push(chart2);
      }
    }
  }

  /* ── Team Performance ─────────────────────────────────────────────────── */
  function renderTeam(d) {
    var stats = d.recruiterStats;
    if (!stats) return '<div class="kpi-empty">Team data not available. Switch to Org View.</div>';
    if (stats.length === 0) return '<div class="kpi-empty">No recruiter data found.</div>';

    var html = '<div class="kpi-section"><div class="kpi-section-title">Recruiter Leaderboard (Top 20)</div>' +
      '<div style="overflow-x:auto"><table class="kpi-tbl">' +
      '<thead><tr><th>#</th><th>Recruiter</th><th>Total</th><th>Selected</th><th>Rejected</th><th>Shortlist Rate</th><th>Avg Score</th></tr></thead><tbody>';

    stats.forEach(function (r, i) {
      var rate = r.shortlistRate || 0;
      var barColor = rate >= 50 ? '#10b981' : rate >= 25 ? '#f59e0b' : '#ef4444';
      html += '<tr>' +
        '<td style="color:var(--text3,#888);font-weight:700">' + (i+1) + '</td>' +
        '<td><div style="font-weight:600">' + esc(r.interviewer) + '</div></td>' +
        '<td>' + r.total + '</td>' +
        '<td><span style="color:#10b981;font-weight:700">' + r.selected + '</span></td>' +
        '<td><span style="color:#ef4444">' + r.rejected + '</span></td>' +
        '<td>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<div style="width:60px;background:var(--border,#e5e7eb);border-radius:4px;height:5px"><div style="width:' + Math.min(100, rate) + '%;background:' + barColor + ';border-radius:4px;height:5px"></div></div>' +
            '<span style="font-weight:700;color:' + barColor + '">' + pct(rate) + '</span>' +
          '</div>' +
        '</td>' +
        '<td>' + score(r.avgScore) + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div></div>';

    html += '<div class="kpi-section" style="margin-top:24px;">' +
      '<div class="chart-wrapper">' +
        '<div class="kpi-section-title">Recruiter Activity Comparison</div>' +
        '<div style="position:relative;height:240px;"><canvas id="chart-team-activity"></canvas></div>' +
      '</div>' +
    '</div>';

    var totalInterviews = stats.reduce(function (s, r) { return s + r.total; }, 0);
    var totalSelected   = stats.reduce(function (s, r) { return s + r.selected; }, 0);
    var orgRate = totalInterviews > 0 ? (totalSelected / totalInterviews * 100).toFixed(1) : '0.0';
    html += '<div class="kpi-cards" style="margin-top:20px">' +
      kpiCard('Recruiters Active', stats.length, '', 'blue') +
      kpiCard('Org Shortlist Rate', orgRate + '%', '', 'green') +
      kpiCard('Total by Team', totalInterviews, '', 'indigo') +
      kpiCard('Total Selected', totalSelected, 'across team', 'green') +
    '</div>';

    return html;
  }

  function initTeamCharts(d) {
    if (!window.Chart) return;
    var colors = getThemeColors();
    var stats = d.recruiterStats || [];

    var c1 = state.charts.find(function(c) { return c.canvas.id === 'chart-team-activity'; });
    if (c1 && stats.length > 0) {
      c1.data.labels = stats.map(function(x){ return x.interviewer.split('@')[0]; });
      c1.data.datasets[0].data = stats.map(function(x){return x.total;});
      c1.data.datasets[1].data = stats.map(function(x){return x.selected;});
      c1.update();
    } else {
      var ctx = document.getElementById('chart-team-activity');
      if (ctx && stats.length > 0) {
        var chart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: stats.map(function(x){
              return x.interviewer.split('@')[0];
            }),
            datasets: [
              {
                label: 'Total Interviews',
                data: stats.map(function(x){return x.total;}),
                backgroundColor: 'rgba(99, 102, 241, 0.5)',
                borderRadius: 4
              },
              {
                label: 'Selected',
                data: stats.map(function(x){return x.selected;}),
                backgroundColor: colors.success,
                borderRadius: 4
              }
            ]
          },
          options: barOptions(colors, true, false)
        });
        state.charts.push(chart);
      }
    }
  }

  /* ── inject trigger button ─────────────────────────────────────────────── */
  function injectButton() {
    var existing = document.getElementById(BTN_ID);
    // Neither KPI scope granted → no dashboard at all. Re-checked on every pass
    // because permissions arrive asynchronously (and can change on re-login).
    if (!canOwn()) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      if (document.getElementById(OVERLAY_ID)) close();
      return;
    }
    if (existing) return;
    var selectors = [
      '[data-route*="recruit"] .page-header',
      '[class*="recruit"] .page-actions',
      '[class*="recruit"] .topbar-actions',
      '.page-header .page-actions',
      '.page-header',
      '.topbar',
    ];
    var target = null;
    for (var i = 0; i < selectors.length; i++) {
      target = document.querySelector(selectors[i]);
      if (target) break;
    }
    if (!target) return;

    injectStyle();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M5 10V8M8 10V6M11 10V7" stroke-linecap="round"/></svg>KPI Dashboard';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.getElementById(OVERLAY_ID)) close(); else open();
    });
    target.appendChild(btn);
  }

  window.__hrmsOpenRecruitKPI = open;

  function tryMount() {
    var path = window.location.pathname + window.location.hash;
    var onRecruit = /recruit|job|interview/i.test(path);
    if (onRecruit) {
      injectButton();
    } else {
      var btn = document.getElementById(BTN_ID);
      if (btn) btn.parentNode.removeChild(btn);
    }
  }

  function boot() {
    tryMount();
    // __hrmsCan fails open until /api/me/permissions answers, so re-evaluate the
    // moment the real grants land — otherwise the button lingers for a user who
    // turns out to have neither KPI scope.
    window.addEventListener('hrmsPermsLoaded', function () {
      tryMount();
      if (!document.getElementById(OVERLAY_ID)) return;
      // Overlay is open: if Org View turns out not to be granted, drop back to
      // My View and redraw rather than leaving a scope the server will 403.
      if (!canOrg() && state.scope === 'all') {
        state.scope = 'me';
        state.interviewer = '';
        state.dept = '';
        if (state.tab === 'jobs' || state.tab === 'team') state.tab = 'overview';
      }
      buildShell();
      loadAndRender();
    });
    var lastPath = window.location.pathname + window.location.hash;
    setInterval(function () {
      var current = window.location.pathname + window.location.hash;
      if (current !== lastPath) {
        lastPath = current;
        setTimeout(tryMount, 300);
      }
    }, 500);
    var obs = new MutationObserver(function () {
      if (!document.getElementById(BTN_ID)) tryMount();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
