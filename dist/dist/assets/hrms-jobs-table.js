/*
 * hrms-jobs-table.js
 * ---------------------------------------------------------------------------
 * Replaces the Job Board (/recruit/job-board) built-in table with a
 * Ceipal-style data grid (no bundle rebuild):
 *   • Own table from /api/jobs (shown by default; the app's table is hidden).
 *   • Edit Column drawer (show/hide + drag reorder), persisted to localStorage.
 *   • Per-column Excel-style filter popups (sort + search + value checklist).
 *   • Per-row Job Status editor (modal) → PATCH /api/jobs/:id.
 *   • Pagination (page size + first/prev/pages/next/last).
 *   • Export CSV / Excel (.xlsx).
 *
 * All our own DOM, kept mounted by a MutationObserver. Theme-aware.
 */
(function () {
  'use strict';

  var JOBS_PATH = '/recruit/job-board';
  var LS_KEY = 'hrms_jobs_columns_v1';
  var ID = { root: 'hrms-jobs-root', drawer: 'hrms-jobs-drawer', style: 'hrms-jobs-style', menu: 'hrms-jobs-exportmenu', pop: 'hrms-jobs-colpop', modal: 'hrms-jobs-modal', pripop: 'hrms-jobs-pripop' };
  var PRIORITIES = [
    { v: 'Critical', c: '#ef4444' }, { v: 'High', c: '#f59e0b' },
    { v: 'Medium', c: '#3b82f6' }, { v: 'Low', c: '#22c55e' }, { v: 'Normal', c: '#8a9bb8' }
  ];
  function priColor(v) { for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].v === v) return PRIORITIES[i].c; return '#8a9bb8'; }

  var COLS = [
    { key: 'title', label: 'Job Title' }, { key: 'dept', label: 'Department' },
    { key: 'location', label: 'Location' }, { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status', def: 'Active' }, { key: 'priority', label: 'Priority', def: 'Normal' },
    { key: 'salary', label: 'Salary' }, { key: 'applicants', label: 'Applicants', num: true },
    { key: 'openings', label: 'Openings', num: true },
    { key: 'remote', label: 'Remote', fmt: function (v) { return v ? 'Yes' : 'No'; } },
    { key: 'createdAt', label: 'Created' }, { key: 'description', label: 'Description' },
    { key: 'customFields', label: 'Custom Fields', fmt: function (v, job) { return summarizeCustom(job); } }
  ];
  var DEFAULT_HIDDEN = { description: 1, customFields: 1 };
  // JobPost's built-in columns — every other Form-Builder field is a custom column.
  var CORE_FIELD = { title: 1, dept: 1, location: 1, type: 1, salary: 1, openings: 1, priority: 1, status: 1, remote: 1, description: 1 };
  var STATUS_OPTIONS = ['Active', 'Cancelled', 'Closed', 'Filled', 'Hold by Client', 'On Hold'];
  var PAGE_SIZES = [25, 50, 100, 200];
  var TECH = ['engineering', 'data & analytics', 'data', 'design'];

  var PREDEF = [
    ['all', 'All Jobs'], ['active', 'Active Jobs'], ['closed', 'Closed Jobs'], ['onhold', 'On Hold Jobs'],
    ['cancelled', 'Cancelled Jobs'], ['filled', 'Filled Jobs'], ['remote', 'Remote Jobs'], ['onsite', 'On-site Jobs'],
    ['tech', 'Tech Jobs'], ['nontech', 'Non-Tech Jobs'], ['high', 'High Priority']
  ];

  var state = {
    jobs: [], loaded: false, cols: null, customLabels: {}, customCols: [],
    search: '', colFilters: {},         // key -> array of allowed display values (absent = all)
    predef: 'all', buFilter: null,      // pre-defined quick filter + business-unit (dept) filter
    customFilters: [],                  // [{key, val}] "contains" filters from Edit Filters → Add Filter
    showFunnels: true,                  // toggle per-column funnel icons
    sortKey: null, sortDir: 1,
    page: 1, pageSize: 25
  };

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function onJobsPage() { return location.pathname.replace(/\/+$/, '') === JOBS_PATH; }
  function allCols() { return COLS.concat(state.customCols); }
  function col(key) { var a = allCols(); for (var i = 0; i < a.length; i++) if (a[i].key === key) return a[i]; return { key: key, label: key }; }
  function cellVal(job, key) {
    var c = col(key), v;
    if (c.cf) { var cf = job.customFields || {}; v = cf[c.cf]; if (Array.isArray(v)) v = v.join(', '); }
    else v = job[key];
    if (c.def != null && (v == null || v === '')) v = c.def;
    return c.fmt ? c.fmt(v, job) : (v == null ? '' : v);
  }
  function isTech(dp) { return TECH.indexOf(String(dp || '').toLowerCase()) !== -1; }
  function api(path, opts) { return fetch(path, opts).then(function (r) { return r.text().then(function (t) { var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } } if (!r.ok) throw new Error((d && (d.error || d.message || d.detail)) || ('HTTP ' + r.status)); return d; }); }); }
  function loadJobs() { api('/api/jobs').then(function (rows) { state.jobs = Array.isArray(rows) ? rows : []; state.loaded = true; renderTable(); }).catch(function () { state.loaded = true; renderTable(); }); }
  // Field key → human label, from the active Job Form Builder schema, so custom
  // fields show friendly names instead of raw keys.
  // Build the label map + one toggleable column per custom (non-core) field in
  // the active Form Builder schema. Each appears in Edit Columns, hidden until
  // the user selects it.
  function loadCustomLabels() {
    api('/api/job-form/config').then(function (cfg) {
      var m = {}, cols = [];
      function addField(f) {
        if (!f || !f.key || f.type === 'heading') return;
        m[f.key] = f.label;
        if (!CORE_FIELD[f.key]) cols.push({ key: 'cf:' + f.key, label: f.label, cf: f.key });
      }
      ((cfg && cfg.schema) || []).forEach(function (item) {
        if (item && Array.isArray(item.fields)) item.fields.forEach(addField); else addField(item);
      });
      state.customLabels = m; state.customCols = cols;
      reconcileCols();
      if (state.loaded) renderTable();
    }).catch(function () {});
  }
  // Merge custom columns into the saved column set: add newly-defined ones
  // (hidden), drop ones no longer in the schema.
  function reconcileCols() {
    if (!state.cols) return;
    var known = {}; state.cols.forEach(function (c) { known[c.key] = 1; });
    state.customCols.forEach(function (c) { if (!known[c.key]) state.cols.push({ key: c.key, on: false }); });
    var valid = {}; state.customCols.forEach(function (c) { valid[c.key] = 1; });
    state.cols = state.cols.filter(function (c) { return c.key.indexOf('cf:') !== 0 || valid[c.key]; });
  }
  function customEntries(job) {
    var cf = job && job.customFields; if (!cf || typeof cf !== 'object') return [];
    return Object.keys(cf).map(function (k) {
      var val = cf[k]; if (Array.isArray(val)) val = val.join(', ');
      return { key: k, label: state.customLabels[k] || k, value: (val == null ? '' : String(val)) };
    }).filter(function (e) { return e.value !== ''; });
  }
  function summarizeCustom(job) { return customEntries(job).map(function (e) { return e.label + ': ' + e.value; }).join(' · '); }
  function customFieldsChips(job) {
    var e = customEntries(job); if (!e.length) return '<span class="jt-cf-empty">—</span>';
    return e.map(function (x) { return '<span class="jt-cf-chip"><b>' + esc(x.label) + ':</b> ' + esc(x.value) + '</span>'; }).join('');
  }

  function loadColPrefs() {
    var saved = null; try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) {}
    var byKey = {}; if (Array.isArray(saved)) saved.forEach(function (c, i) { if (c && c.key) byKey[c.key] = { on: c.on !== false, ord: i }; });
    var cols = COLS.map(function (c) { return { key: c.key, on: byKey[c.key] ? byKey[c.key].on : !DEFAULT_HIDDEN[c.key] }; });
    // Carry over previously-saved custom-field columns (schema-reconciled later).
    if (Array.isArray(saved)) saved.forEach(function (c) { if (c && c.key && c.key.indexOf('cf:') === 0 && !cols.some(function (x) { return x.key === c.key; })) cols.push({ key: c.key, on: c.on !== false }); });
    if (Array.isArray(saved) && saved.length) cols.sort(function (a, b) { var ao = byKey[a.key] ? byKey[a.key].ord : 999, bo = byKey[b.key] ? byKey[b.key].ord : 999; return ao - bo; });
    state.cols = cols;
  }
  function saveColPrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(state.cols)); } catch (_) {} }
  function shownCols() { return state.cols.filter(function (c) { return c.on; }); }
  function distinct(key) { var seen = {}, out = []; state.jobs.forEach(function (j) { var v = String(cellVal(j, key)); if (!(v in seen)) { seen[v] = 1; out.push(v); } }); return out.sort(); }

  function matchPredef(x) {
    switch (state.predef) {
      case 'active': return (x.status || 'Active') === 'Active';
      case 'closed': return x.status === 'Closed';
      case 'onhold': return x.status === 'On Hold';
      case 'cancelled': return x.status === 'Cancelled';
      case 'filled': return x.status === 'Filled';
      case 'remote': return !!x.remote;
      case 'onsite': return !x.remote;
      case 'tech': return isTech(x.dept);
      case 'nontech': return !isTech(x.dept);
      case 'high': return (x.priority || 'Normal') === 'High';
      default: return true;
    }
  }
  function filteredJobs() {
    var q = state.search.toLowerCase();
    var rows = state.jobs.filter(function (x) {
      if (q && !(('' + (x.title || '')).toLowerCase().indexOf(q) !== -1 || ('' + (x.dept || '')).toLowerCase().indexOf(q) !== -1 || ('' + (x.location || '')).toLowerCase().indexOf(q) !== -1)) return false;
      for (var k in state.colFilters) { if (state.colFilters[k] && state.colFilters[k].indexOf(String(cellVal(x, k))) === -1) return false; }
      if (state.predef !== 'all' && !matchPredef(x)) return false;
      if (state.buFilter && state.buFilter.indexOf(String(x.dept || '')) === -1) return false;
      for (var i = 0; i < state.customFilters.length; i++) { var cf = state.customFilters[i]; if (cf.val && String(cellVal(x, cf.key)).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false; }
      return true;
    });
    if (state.sortKey) {
      var c = col(state.sortKey);
      rows = rows.slice().sort(function (a, b) {
        var av = a[state.sortKey], bv = b[state.sortKey];
        if (c.num) return ((+av || 0) - (+bv || 0)) * state.sortDir;
        return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv)) * state.sortDir;
      });
    }
    return rows;
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var R = '#' + ID.root, D = '.jt-dr', M = '#' + ID.menu, P = '#' + ID.pop, MD = '.jt-md';
    var css = [
      R + '{margin:0;}',
      R + ' .jt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px;}',
      R + ' .jt-search{flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:9px 12px;color:var(--text);font:inherit;font-size:13px;}',
      R + ' .jt-search:focus{border-color:var(--accent);outline:none;}',
      /* Controls are GLOBAL (not root-scoped) so drawers/modals mounted on <body> get them too. */
      '.jt-btn{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:8px 14px;color:var(--text);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;}',
      '.jt-btn:hover{border-color:var(--accent);}',
      '.jt-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent);}',
      '.jt-btn.primary:hover{filter:brightness(1.08);border-color:var(--accent);}',
      '.jt-btn.ghost{background:transparent;color:var(--text2);}',
      '.jt-btn.ghost:hover{border-color:var(--accent);color:var(--text);}',
      '.jt-icon{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;color:var(--text2);cursor:pointer;}',
      '.jt-icon:hover{border-color:var(--accent);color:var(--accent);}',
      '.jt-x{width:30px;height:30px;border:none;border-radius:50%;background:var(--bg3);color:var(--text2);font-size:17px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1;}',
      '.jt-x:hover{background:var(--border2);color:var(--text);}',
      R + ' .jt-wrap{overflow:auto;border:1px solid var(--border2);border-radius:12px;}',
      R + ' table.jt-table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      R + ' .jt-table th{position:sticky;top:0;background:var(--bg2);color:var(--text3);text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;border-bottom:1px solid var(--border2);white-space:nowrap;z-index:1;}',
      R + ' .jt-th{display:flex;align-items:center;gap:6px;}',
      R + ' .jt-th .jt-lbl{cursor:pointer;user-select:none;}',
      R + ' .jt-th .jt-arrow{font-size:9px;opacity:.7;}',
      R + ' .jt-funnel{margin-left:auto;cursor:pointer;font-size:11px;color:var(--text3);padding:2px 3px;border-radius:4px;line-height:1;}',
      R + ' .jt-funnel:hover{background:var(--bg3);color:var(--text);}',
      R + ' .jt-funnel.on{color:var(--accent);}',
      R + ' .jt-table td{padding:10px 12px;border-bottom:1px solid var(--border2);color:var(--text2);white-space:nowrap;}',
      R + ' .jt-table td.jt-title{color:var(--text);font-weight:600;}',
      R + ' .jt-table td.jt-cf{white-space:normal;max-width:340px;}',
      R + ' .jt-cf-chip{display:inline-block;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:1px 7px;margin:2px 4px 2px 0;font-size:11px;color:var(--text2);}',
      R + ' .jt-cf-chip b{color:var(--text);font-weight:600;}',
      R + ' .jt-cf-empty{color:var(--text3);}',
      R + ' .jt-md .jt-cf-chip{margin:2px 4px 2px 0;}',
      R + ' .jt-table tr:hover td{background:rgba(125,125,125,.08);}',
      R + ' .jt-status{display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:1px dashed transparent;border-radius:999px;padding:1px 4px;}',
      R + ' .jt-status:hover{border-color:var(--border2);}',
      R + ' .jt-status .jt-edit{opacity:0;font-size:11px;color:var(--accent);}',
      R + ' .jt-status:hover .jt-edit{opacity:1;}',
      /* editable priority cell (colored) */
      R + ' .jt-pri{display:inline-flex;align-items:center;gap:7px;cursor:pointer;border:1px dashed transparent;border-radius:6px;padding:2px 6px;}',
      R + ' .jt-pri:hover{border-color:var(--border2);}',
      R + ' .jt-pdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}',
      R + ' .jt-caret{font-size:9px;color:var(--text3);opacity:0;}',
      R + ' .jt-pri:hover .jt-caret{opacity:1;}',
      '#' + ID.pripop + '{position:fixed;z-index:650;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 14px 38px rgba(0,0,0,.42);padding:6px;min-width:158px;}',
      '#' + ID.pripop + ' button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;color:var(--text);font:inherit;font-size:12.5px;font-weight:600;padding:9px 11px;border-radius:7px;cursor:pointer;}',
      '#' + ID.pripop + ' button:hover{background:var(--bg3);}',
      '#' + ID.pripop + ' button.cur{background:var(--bg3);}',
      R + ' .jt-pill{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;text-transform:capitalize;}',
      R + ' .jt-pill.active,' + R + ' .jt-pill.filled{background:rgba(34,211,165,.16);color:var(--success,#22d3a5);}',
      R + ' .jt-pill.closed,' + R + ' .jt-pill.cancelled{background:rgba(247,95,79,.16);color:var(--danger,#f75f4f);}',
      R + ' .jt-pill.onhold,' + R + ' .jt-pill.holdbyclient{background:rgba(247,201,79,.16);color:var(--warn,#f7c94f);}',
      R + ' .jt-pill.high{background:rgba(247,95,79,.16);color:var(--danger,#f75f4f);}',
      R + ' .jt-pill.normal{background:rgba(79,142,247,.16);color:var(--accent,#4f8ef7);}',
      R + ' .jt-empty{padding:40px;text-align:center;color:var(--text3);font-size:13px;}',
      /* pagination */
      R + ' .jt-pg{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:14px;font-size:12.5px;color:var(--text3);}',
      R + ' .jt-pg .jt-pgspacer{flex:1;}',
      R + ' .jt-pg button{min-width:30px;height:30px;padding:0 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;}',
      R + ' .jt-pg button:hover:not(:disabled){border-color:var(--accent);}',
      R + ' .jt-pg button:disabled{opacity:.4;cursor:not-allowed;}',
      R + ' .jt-pg button.cur{background:var(--accent);color:#fff;border-color:var(--accent);}',
      R + ' .jt-pg select{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:12px;padding:5px 6px;}',
      /* export menu */
      M + '{position:absolute;z-index:400;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.4);padding:6px;min-width:180px;}',
      M + ' button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font:inherit;font-size:12.5px;padding:9px 12px;border-radius:7px;cursor:pointer;}',
      M + ' button:hover{background:var(--bg3);}',
      /* per-column filter popup */
      P + '{position:fixed;z-index:600;width:240px;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;}',
      P + ' .jt-psort{display:flex;border-bottom:1px solid var(--border2);}',
      P + ' .jt-psort button{flex:1;background:none;border:none;color:var(--text2);font:inherit;font-size:11.5px;font-weight:600;padding:9px;cursor:pointer;}',
      P + ' .jt-psort button:hover{background:var(--bg3);color:var(--text);}',
      P + ' .jt-psearch{margin:8px;padding:7px 9px;background:var(--bg3);border:1px solid var(--border2);border-radius:7px;color:var(--text);font:inherit;font-size:12px;}',
      P + ' .jt-pvals{max-height:200px;overflow-y:auto;padding:0 8px;}',
      P + ' .jt-pv{display:flex;align-items:center;gap:8px;padding:5px 4px;font-size:12px;color:var(--text);cursor:pointer;}',
      P + ' .jt-pv input{accent-color:var(--accent);}',
      P + ' .jt-pf{display:flex;gap:8px;padding:8px;border-top:1px solid var(--border2);}',
      P + ' .jt-pf button{flex:1;border-radius:7px;padding:7px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border2);background:var(--bg3);color:var(--text);}',
      P + ' .jt-pf button.primary{background:var(--accent);color:#fff;border-color:var(--accent);}',
      /* Edit Column drawer */
      D + '-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;display:flex;justify-content:flex-end;animation:jt-fade .15s ease;}',
      D + '{width:380px;max-width:94vw;height:100vh;background:var(--bg2);border-left:1px solid var(--border2);box-shadow:-24px 0 70px rgba(0,0,0,.5);display:flex;flex-direction:column;animation:jt-slide .28s cubic-bezier(.2,.9,.3,1);}',
      D + ' .jt-dh{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border2);}',
      D + ' .jt-dh h3{margin:0;font-family:var(--font-d,inherit);font-size:17px;font-weight:700;color:var(--text);}',
      D + ' .jt-dsub{padding:14px 22px 6px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);}',
      D + ' .jt-dlist{flex:1;overflow-y:auto;padding:4px 16px 16px;}',
      D + ' .jt-ci{display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:10px 12px;margin-bottom:7px;cursor:grab;}',
      D + ' .jt-ci.drag{opacity:.4;}' , D + ' .jt-ci.over{border-color:var(--accent);}',
      D + ' .jt-grip{color:var(--text3);font-size:14px;letter-spacing:-2px;}',
      D + ' .jt-ci label{flex:1;display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text);cursor:pointer;}',
      D + ' .jt-ci input{accent-color:var(--accent);width:16px;height:16px;}',
      D + ' .jt-cihead{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);margin:12px 0 8px;padding-top:10px;border-top:1px solid var(--border2);}',
      D + ' .jt-df{display:flex;gap:10px;padding:16px 22px;border-top:1px solid var(--border2);}',
      D + ' .jt-df .jt-btn{flex:1;justify-content:center;padding:11px;font-size:13px;font-weight:700;}',
      /* Edit Filters drawer content */
      D + ' .jt-fsec{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);margin:14px 0 8px;}',
      D + ' .jt-fbody{flex:1;overflow-y:auto;padding:14px 22px 16px;}',
      D + ' .jt-bu{background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:6px 10px;max-height:150px;overflow-y:auto;}',
      D + ' .jt-bu label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);padding:5px 2px;cursor:pointer;}',
      D + ' .jt-bu input,' + D + ' .jt-pd input{accent-color:var(--accent);width:15px;height:15px;}',
      D + ' .jt-pd{display:grid;gap:8px;}',
      D + ' .jt-pd label{display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text);cursor:pointer;}',
      D + ' .jt-pd label:hover{border-color:var(--accent);}',
      D + ' .jt-addf{color:var(--accent);font-size:12.5px;font-weight:700;cursor:pointer;background:none;border:none;padding:12px 0 4px;}',
      D + ' .jt-cf{display:flex;gap:6px;margin-bottom:6px;}',
      D + ' .jt-cf select,' + D + ' .jt-cf input{flex:1;min-width:0;background:var(--bg3);border:1px solid var(--border2);border-radius:7px;color:var(--text);font:inherit;font-size:12px;padding:7px 8px;}',
      D + ' .jt-cf .jt-cfx{flex:0 0 auto;width:30px;background:var(--bg3);border:1px solid var(--border2);border-radius:7px;color:var(--danger,#f75f4f);cursor:pointer;}',
      /* status modal */
      MD + '-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:700;display:flex;align-items:center;justify-content:center;animation:jt-fade .15s ease;padding:20px;}',
      MD + '{width:460px;max-width:96vw;background:var(--bg2);border:1px solid var(--border2);border-radius:14px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5);}',
      MD + ' .jt-mh{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--border2);}',
      MD + ' .jt-mh h3{margin:0;font-family:var(--font-d,inherit);font-size:17px;font-weight:700;color:var(--text);}',
      MD + ' .jt-mb{padding:20px 22px;display:flex;flex-direction:column;gap:14px;}',
      MD + ' .jt-mrow{display:grid;grid-template-columns:120px 1fr;align-items:center;gap:12px;}',
      MD + ' .jt-mrow.top{align-items:flex-start;}',
      MD + ' .jt-mrow label{font-size:12.5px;color:var(--text2);font-weight:600;}',
      MD + ' .jt-mrow input,' + MD + ' .jt-mrow select,' + MD + ' .jt-mrow textarea{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:13px;padding:9px 11px;width:100%;}',
      MD + ' .jt-mrow input:focus,' + MD + ' .jt-mrow select:focus,' + MD + ' .jt-mrow textarea:focus{border-color:var(--accent);outline:none;}',
      MD + ' .jt-mrow input::placeholder,' + MD + ' .jt-mrow textarea::placeholder{color:var(--text3);}',
      MD + ' .jt-mrow textarea{min-height:70px;resize:vertical;}',
      MD + ' .jt-mf{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--border2);}',
      '@keyframes jt-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes jt-slide{from{transform:translateX(100%)}to{transform:translateX(0)}}'
    ].join('');
    var st = document.createElement('style'); st.id = ID.style; st.textContent = css; document.head.appendChild(st);
  }

  /* ── locate the app's job board content ───────────────────────────────── */
  function findAppTable() {
    var row = document.querySelector('tr.jb-row');
    var table = row ? row.closest('table') : null;
    if (!table) { var tbs = document.querySelectorAll('table'); for (var i = 0; i < tbs.length; i++) { var t = tbs[i].textContent || ''; if (/Applicants/i.test(t) && /Job Title/i.test(t)) { table = tbs[i]; break; } } }
    return table;
  }
  function appContent() {
    var table = findAppTable(); if (!table) return null;
    var el = table.parentElement;
    while (el && el !== document.body) { if (el.querySelector('table') && el.querySelector('input')) return el; el = el.parentElement; }
    return table.parentElement;
  }

  /* ── build ────────────────────────────────────────────────────────────── */
  function buildRoot() {
    var root = document.createElement('div'); root.id = ID.root;
    var ICON_SLIDERS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" fill="var(--bg3)"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4" fill="var(--bg3)"/></svg>';
    var ICON_COLUMNS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="5.5" height="16" rx="1"/><rect x="9.5" y="4" width="5.5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/></svg>';
    root.innerHTML =
      '<div class="jt-bar">' +
        '<input class="jt-search" id="jt-search" placeholder="Search jobs, department, location…">' +
        '<div style="position:relative"><button class="jt-btn" id="jt-export">⭳ Export ▾</button></div>' +
        '<button class="jt-icon" id="jt-editfilters" title="Edit Filters">' + ICON_SLIDERS + '</button>' +
        '<button class="jt-icon" id="jt-editcolumns" title="Edit Column">' + ICON_COLUMNS + '</button>' +
        '<button class="jt-btn primary" id="jt-postjob">+ Post Job</button>' +
      '</div>' +
      '<div class="jt-wrap"><table class="jt-table"><thead id="jt-thead"></thead><tbody id="jt-tbody"></tbody></table></div>' +
      '<div class="jt-pg" id="jt-pg"></div>';
    root.querySelector('#jt-search').addEventListener('input', function (e) { state.search = e.target.value; state.page = 1; renderTable(); });
    root.querySelector('#jt-export').addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(e.currentTarget); });
    root.querySelector('#jt-editfilters').addEventListener('click', openFiltersDrawer);
    root.querySelector('#jt-editcolumns').addEventListener('click', openDrawer);
    root.querySelector('#jt-postjob').addEventListener('click', openPostJobModal);
    return root;
  }

  function renderTable() {
    var thead = document.getElementById('jt-thead'), tbody = document.getElementById('jt-tbody');
    if (!thead || !tbody) return;
    var cols = shownCols();
    thead.innerHTML = '<tr>' + cols.map(function (c) {
      var arrow = state.sortKey === c.key ? '<span class="jt-arrow">' + (state.sortDir > 0 ? '▲' : '▼') + '</span>' : '';
      var on = state.colFilters[c.key] ? ' on' : '';
      var funnel = state.showFunnels ? '<span class="jt-funnel' + on + '" data-flt="' + c.key + '" title="Filter">▼</span>' : '';
      return '<th><div class="jt-th"><span class="jt-lbl" data-sort="' + c.key + '">' + esc(col(c.key).label) + arrow + '</span>' + funnel + '</div></th>';
    }).join('') + '</tr>';
    thead.querySelectorAll('[data-sort]').forEach(function (el) { el.addEventListener('click', function () { var k = el.getAttribute('data-sort'); if (state.sortKey === k) state.sortDir = -state.sortDir; else { state.sortKey = k; state.sortDir = 1; } renderTable(); }); });
    thead.querySelectorAll('[data-flt]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); openColPopup(el, el.getAttribute('data-flt')); }); });

    if (!state.loaded) { tbody.innerHTML = '<tr><td class="jt-empty" colspan="' + cols.length + '">Loading jobs…</td></tr>'; renderPg(0); return; }
    var all = filteredJobs(), total = all.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * state.pageSize, rows = all.slice(start, start + state.pageSize);
    if (!rows.length) { tbody.innerHTML = '<tr><td class="jt-empty" colspan="' + cols.length + '">No jobs match your filters.</td></tr>'; renderPg(0); return; }
    tbody.innerHTML = rows.map(function (job) {
      return '<tr>' + cols.map(function (c) {
        var v = cellVal(job, c.key);
        if (c.key === 'title') return '<td class="jt-title">' + esc(v) + '</td>';
        if (c.key === 'status') return '<td><span class="jt-status" data-edit="' + job.id + '"><span class="jt-pill ' + esc(String(v).toLowerCase().replace(/\s+/g, '')) + '">' + esc(v) + '</span><span class="jt-edit">✎</span></span></td>';
        if (c.key === 'priority') return '<td><span class="jt-pri" data-pri="' + job.id + '" title="Set priority"><span class="jt-pdot" style="background:' + priColor(v) + '"></span>' + esc(v) + '<span class="jt-caret">▾</span></span></td>';
        if (c.key === 'customFields') return '<td class="jt-cf">' + customFieldsChips(job) + '</td>';
        return '<td>' + esc(v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-edit]').forEach(function (el) { el.addEventListener('click', function () { openStatusModal(+el.getAttribute('data-edit')); }); });
    tbody.querySelectorAll('[data-pri]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); openPriorityPopup(el, +el.getAttribute('data-pri')); }); });
    renderPg(total, start, rows.length, pages);
  }

  function renderPg(total, start, shown, pages) {
    var pg = document.getElementById('jt-pg'); if (!pg) return;
    if (!total) { pg.innerHTML = '<span>' + (state.loaded ? '0 jobs' : '') + '</span>'; return; }
    var from = start + 1, to = start + shown;
    var nums = [], p = state.page;
    var lo = Math.max(1, p - 2), hi = Math.min(pages, lo + 4); lo = Math.max(1, hi - 4);
    for (var i = lo; i <= hi; i++) nums.push(i);
    pg.innerHTML =
      '<span>' + from + '–' + to + ' of ' + total + '</span>' +
      '<span class="jt-pgspacer"></span>' +
      '<button data-pg="first"' + (p <= 1 ? ' disabled' : '') + '>«</button>' +
      '<button data-pg="prev"' + (p <= 1 ? ' disabled' : '') + '>‹</button>' +
      nums.map(function (n) { return '<button data-pg="' + n + '"' + (n === p ? ' class="cur"' : '') + '>' + n + '</button>'; }).join('') +
      '<button data-pg="next"' + (p >= pages ? ' disabled' : '') + '>›</button>' +
      '<button data-pg="last"' + (p >= pages ? ' disabled' : '') + '>»</button>' +
      '<select id="jt-psize">' + PAGE_SIZES.map(function (s) { return '<option' + (s === state.pageSize ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<span>per page</span>';
    pg.querySelectorAll('[data-pg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-pg');
        if (v === 'first') state.page = 1; else if (v === 'prev') state.page = Math.max(1, p - 1);
        else if (v === 'next') state.page = Math.min(pages, p + 1); else if (v === 'last') state.page = pages;
        else state.page = +v;
        renderTable();
      });
    });
    var sz = pg.querySelector('#jt-psize'); if (sz) sz.addEventListener('change', function (e) { state.pageSize = +e.target.value; state.page = 1; renderTable(); });
  }

  /* ── per-column filter popup ──────────────────────────────────────────── */
  function closeColPopup() { var p = document.getElementById(ID.pop); if (p) p.remove(); }
  function openColPopup(anchor, key) {
    if (document.getElementById(ID.pop)) { closeColPopup(); return; }
    var vals = distinct(key);
    var sel = state.colFilters[key] ? state.colFilters[key].slice() : vals.slice(); // default: all checked
    var pop = document.createElement('div'); pop.id = ID.pop;
    pop.innerHTML =
      '<div class="jt-psort"><button data-s="1">↑ Sort A→Z</button><button data-s="-1">↓ Sort Z→A</button></div>' +
      '<input class="jt-psearch" placeholder="Search values…">' +
      '<div class="jt-pvals"><label class="jt-pv"><input type="checkbox" id="jt-pall"> <b>(Select all)</b></label><div id="jt-pvlist"></div></div>' +
      '<div class="jt-pf"><button class="primary" data-a="apply">Apply</button><button data-a="clear">Clear</button></div>';
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 340) + 'px';
    pop.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
    function drawVals(filter) {
      var list = pop.querySelector('#jt-pvlist');
      var shown = vals.filter(function (v) { return !filter || v.toLowerCase().indexOf(filter) !== -1; });
      list.innerHTML = shown.map(function (v) { return '<label class="jt-pv"><input type="checkbox" value="' + esc(v) + '"' + (sel.indexOf(v) !== -1 ? ' checked' : '') + '> ' + (v === '' ? '(blank)' : esc(v)) + '</label>'; }).join('');
      list.querySelectorAll('input').forEach(function (cb) { cb.addEventListener('change', function () { var val = cb.value; if (cb.checked) { if (sel.indexOf(val) === -1) sel.push(val); } else { var i = sel.indexOf(val); if (i !== -1) sel.splice(i, 1); } syncAll(); }); });
      syncAll();
    }
    function syncAll() { var all = pop.querySelector('#jt-pall'); if (all) all.checked = vals.length && sel.length === vals.length; }
    drawVals('');
    pop.querySelector('.jt-psearch').addEventListener('input', function (e) { drawVals(e.target.value.toLowerCase()); });
    pop.querySelector('#jt-pall').addEventListener('change', function (e) { sel = e.target.checked ? vals.slice() : []; drawVals(pop.querySelector('.jt-psearch').value.toLowerCase()); });
    pop.querySelectorAll('[data-s]').forEach(function (b) { b.addEventListener('click', function () { state.sortKey = key; state.sortDir = +b.getAttribute('data-s'); closeColPopup(); renderTable(); }); });
    pop.querySelector('[data-a="apply"]').addEventListener('click', function () {
      if (sel.length === vals.length) delete state.colFilters[key]; else state.colFilters[key] = sel;
      state.page = 1; closeColPopup(); renderTable();
    });
    pop.querySelector('[data-a="clear"]').addEventListener('click', function () { delete state.colFilters[key]; state.page = 1; closeColPopup(); renderTable(); });
    setTimeout(function () { document.addEventListener('mousedown', function h(e) { var p = document.getElementById(ID.pop); if (p && !p.contains(e.target)) { p.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
  }

  /* ── row status editor ────────────────────────────────────────────────── */
  function openStatusModal(id) {
    var job = state.jobs.filter(function (j) { return j.id === id; })[0]; if (!job) return;
    var ov = document.createElement('div'); ov.id = ID.modal + '-overlay'; ov.className = 'jt-md-overlay';
    ov.innerHTML =
      '<div class="jt-md"><div class="jt-mh"><h3>Job Status</h3><button class="jt-x" id="jt-mx">×</button></div>' +
      '<div class="jt-mb">' +
        '<div class="jt-mrow"><label>Job Status</label><select id="jt-mstatus">' +
          '<option value="">Select Status</option>' +
          STATUS_OPTIONS.map(function (s) { return '<option' + (s === job.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="jt-mrow top"><label>Comment</label><textarea id="jt-mcomment" placeholder="Optional note about this change">' + esc(job.statusComment || '') + '</textarea></div>' +
        (customEntries(job).length ? '<div class="jt-mrow top"><label>Custom Fields</label><div style="flex:1">' + customFieldsChips(job) + '</div></div>' : '') +
        '<div class="jt-mrow"><label></label><span id="jt-mmsg" style="font-size:12px;font-weight:600;color:var(--danger,#f75f4f)"></span></div>' +
      '</div>' +
      '<div class="jt-mf"><button class="jt-btn" id="jt-mcancel">Cancel</button><button class="jt-btn primary" id="jt-msave">Save</button></div></div>';
    document.body.appendChild(ov);
    ensureStyle();
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#jt-mx').addEventListener('click', close);
    ov.querySelector('#jt-mcancel').addEventListener('click', close);
    ov.querySelector('#jt-msave').addEventListener('click', function () {
      var status = ov.querySelector('#jt-mstatus').value, comment = ov.querySelector('#jt-mcomment').value, msg = ov.querySelector('#jt-mmsg');
      if (!status) { msg.textContent = 'Please select a status.'; return; }
      var btn = ov.querySelector('#jt-msave'); btn.disabled = true; btn.textContent = 'Saving…';
      api('/api/jobs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status, statusComment: comment }) })
        .then(function (updated) { job.status = updated.status; job.statusComment = updated.statusComment; renderTable(); close(); })
        .catch(function (e) { msg.textContent = e.message || 'Could not save.'; btn.disabled = false; btn.textContent = 'Save'; });
    });
  }

  /* ── row priority picker (colored dropdown) ───────────────────────────── */
  function closePriPopup() { var p = document.getElementById(ID.pripop); if (p) p.remove(); }
  function openPriorityPopup(anchor, id) {
    if (document.getElementById(ID.pripop)) { closePriPopup(); return; }
    var job = state.jobs.filter(function (j) { return j.id === id; })[0]; if (!job) return;
    var pop = document.createElement('div'); pop.id = ID.pripop;
    pop.innerHTML = PRIORITIES.map(function (p) { return '<button data-p="' + esc(p.v) + '"' + (p.v === (job.priority || 'Normal') ? ' class="cur"' : '') + '><span class="jt-pdot" style="background:' + p.c + '"></span>' + p.v + '</button>'; }).join('');
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 220) + 'px';
    pop.style.left = Math.min(r.left, window.innerWidth - 170) + 'px';
    pop.querySelectorAll('[data-p]').forEach(function (b) {
      b.addEventListener('click', function () {
        var val = b.getAttribute('data-p');
        api('/api/jobs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: val }) })
          .then(function (u) { job.priority = u.priority; closePriPopup(); renderTable(); })
          .catch(function () { closePriPopup(); });
      });
    });
    setTimeout(function () { document.addEventListener('mousedown', function h(e) { var p = document.getElementById(ID.pripop); if (p && !p.contains(e.target)) { p.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
  }

  /* ── Edit Column drawer ───────────────────────────────────────────────── */
  function openDrawer() {
    closeDrawer(); closeFDrawer();
    var ov = document.createElement('div'); ov.id = ID.drawer + '-overlay'; ov.className = 'jt-dr-overlay';
    var dr = document.createElement('div'); dr.id = ID.drawer; dr.className = 'jt-dr';
    var onCount = state.cols.filter(function (c) { return c.on; }).length;
    dr.innerHTML =
      '<div class="jt-dh"><h3>Edit Column</h3><button class="jt-x" id="jt-dx">×</button></div>' +
      '<div class="jt-dsub"><span id="jt-dcount">' + onCount + '</span> of ' + state.cols.length + ' selected</div>' +
      '<div class="jt-dlist" id="jt-dlist"></div>' +
      '<div class="jt-df"><button class="jt-btn primary" id="jt-apply">Apply</button><button class="jt-btn ghost" id="jt-cancel">Cancel</button></div>';
    ov.appendChild(dr); document.body.appendChild(ov);
    var working = state.cols.map(function (c) { return { key: c.key, on: c.on }; });
    renderDrawerList(working);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDrawer(); });
    dr.querySelector('#jt-dx').addEventListener('click', closeDrawer);
    dr.querySelector('#jt-cancel').addEventListener('click', closeDrawer);
    dr.querySelector('#jt-apply').addEventListener('click', function () { state.cols = working; saveColPrefs(); renderTable(); closeDrawer(); });
  }
  function renderDrawerList(working) {
    var list = document.getElementById('jt-dlist'); if (!list) return;
    var seenCustom = false;
    list.innerHTML = working.map(function (c, i) {
      var isCustom = c.key.indexOf('cf:') === 0;
      var head = '';
      if (isCustom && !seenCustom) { seenCustom = true; head = '<div class="jt-cihead">Custom Fields</div>'; }
      return head + '<div class="jt-ci" draggable="true" data-i="' + i + '"><span class="jt-grip">⋮⋮</span><label><input type="checkbox"' + (c.on ? ' checked' : '') + '>' + esc(col(c.key).label) + '</label></div>';
    }).join('');
    list.querySelectorAll('.jt-ci').forEach(function (el) {
      var i = +el.getAttribute('data-i');
      el.querySelector('input').addEventListener('change', function (e) { working[i].on = e.target.checked; var dc = document.getElementById('jt-dcount'); if (dc) dc.textContent = working.filter(function (c) { return c.on; }).length; });
      el.addEventListener('dragstart', function (e) { el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i); });
      el.addEventListener('dragend', function () { el.classList.remove('drag'); });
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('over'); });
      el.addEventListener('dragleave', function () { el.classList.remove('over'); });
      el.addEventListener('drop', function (e) { e.preventDefault(); el.classList.remove('over'); var from = +e.dataTransfer.getData('text/plain'), to = i; if (from === to || isNaN(from)) return; var m = working.splice(from, 1)[0]; working.splice(to, 0, m); renderDrawerList(working); });
    });
  }
  function closeDrawer() { var ov = document.getElementById(ID.drawer + '-overlay'); if (ov) ov.remove(); }

  /* ── Edit Filters drawer (Business Unit + pre-defined + custom) ────────── */
  function closeFDrawer() { var ov = document.getElementById('hrms-jobs-fdrawer-overlay'); if (ov) ov.remove(); }
  function openFiltersDrawer() {
    closeDrawer(); closeFDrawer();
    var depts = distinct('dept');
    var bu = state.buFilter ? state.buFilter.slice() : depts.slice();
    var predef = state.predef;
    var customs = state.customFilters.map(function (c) { return { key: c.key, val: c.val }; });
    var ov = document.createElement('div'); ov.id = 'hrms-jobs-fdrawer-overlay'; ov.className = 'jt-dr-overlay';
    var dr = document.createElement('div'); dr.className = 'jt-dr';
    dr.innerHTML =
      '<div class="jt-dh"><h3>Edit Filters</h3><button class="jt-x" id="jt-fx">×</button></div>' +
      '<div class="jt-fbody">' +
        '<div class="jt-fsec" style="margin-top:0">Business Unit</div>' +
        '<div class="jt-bu" id="jt-bu"></div>' +
        '<div class="jt-fsec">Pre-Defined Filters</div>' +
        '<div class="jt-pd">' + PREDEF.map(function (p) { return '<label><input type="radio" name="jt-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '>' + p[1] + '</label>'; }).join('') + '</div>' +
        '<div id="jt-cflist"></div><button class="jt-addf" id="jt-addf">+ Add Filter</button>' +
      '</div>' +
      '<div class="jt-df"><button class="jt-btn primary" id="jt-fapply">Apply</button><button class="jt-btn ghost" id="jt-fcancel">Cancel</button></div>';
    ov.appendChild(dr); document.body.appendChild(ov); ensureStyle();
    var buBox = dr.querySelector('#jt-bu');
    function drawBu() {
      buBox.innerHTML = '<label><input type="checkbox" id="jt-buall"' + (bu.length === depts.length ? ' checked' : '') + '> <b>(All selected)</b></label>' +
        depts.map(function (d) { return '<label><input type="checkbox" value="' + esc(d) + '"' + (bu.indexOf(d) !== -1 ? ' checked' : '') + '> ' + (d === '' ? '(blank)' : esc(d)) + '</label>'; }).join('');
      buBox.querySelector('#jt-buall').addEventListener('change', function (e) { bu = e.target.checked ? depts.slice() : []; drawBu(); });
      buBox.querySelectorAll('input[value]').forEach(function (cb) { cb.addEventListener('change', function () { var v = cb.value; if (cb.checked) { if (bu.indexOf(v) === -1) bu.push(v); } else { var i = bu.indexOf(v); if (i !== -1) bu.splice(i, 1); } var a = buBox.querySelector('#jt-buall'); if (a) a.checked = bu.length === depts.length; }); });
    }
    drawBu();
    dr.querySelectorAll('input[name="jt-predef"]').forEach(function (r) { r.addEventListener('change', function () { predef = r.value; }); });
    var cfList = dr.querySelector('#jt-cflist');
    function drawCf() {
      cfList.innerHTML = customs.map(function (c, i) {
        return '<div class="jt-cf"><select data-cfk="' + i + '">' + COLS.map(function (cc) { return '<option value="' + cc.key + '"' + (cc.key === c.key ? ' selected' : '') + '>' + esc(cc.label) + '</option>'; }).join('') + '</select>' +
          '<input data-cfv="' + i + '" placeholder="contains…" value="' + esc(c.val) + '"><button class="jt-cfx" data-cfd="' + i + '">×</button></div>';
      }).join('');
      cfList.querySelectorAll('[data-cfk]').forEach(function (s) { s.addEventListener('change', function () { customs[+s.getAttribute('data-cfk')].key = s.value; }); });
      cfList.querySelectorAll('[data-cfv]').forEach(function (inp) { inp.addEventListener('input', function () { customs[+inp.getAttribute('data-cfv')].val = inp.value; }); });
      cfList.querySelectorAll('[data-cfd]').forEach(function (b) { b.addEventListener('click', function () { customs.splice(+b.getAttribute('data-cfd'), 1); drawCf(); }); });
    }
    drawCf();
    dr.querySelector('#jt-addf').addEventListener('click', function () { customs.push({ key: 'title', val: '' }); drawCf(); });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeFDrawer(); });
    dr.querySelector('#jt-fx').addEventListener('click', closeFDrawer);
    dr.querySelector('#jt-fcancel').addEventListener('click', closeFDrawer);
    dr.querySelector('#jt-fapply').addEventListener('click', function () {
      state.buFilter = (bu.length === depts.length) ? null : bu;
      state.predef = predef;
      state.customFilters = customs.filter(function (c) { return c.val; });
      state.page = 1; closeFDrawer(); renderTable();
    });
  }

  /* ── Post a Job modal ─────────────────────────────────────────────────── */
  function openPostJobModal() {
    function row(label, field) { return '<div class="jt-mrow"><label>' + label + '</label>' + field + '</div>'; }
    var ov = document.createElement('div'); ov.id = 'hrms-jobs-postjob-overlay'; ov.className = 'jt-md-overlay';
    ov.innerHTML =
      '<div class="jt-md" style="width:540px"><div class="jt-mh"><h3>Post a Job</h3><button class="jt-x" id="pj-x">×</button></div>' +
      '<div class="jt-mb" style="max-height:70vh;overflow-y:auto">' +
        row('Title', '<input id="pj-title" placeholder="e.g. Data Analyst">') +
        row('Department', '<input id="pj-dept" placeholder="e.g. Engineering">') +
        row('Location', '<input id="pj-location" placeholder="e.g. Hyderabad">') +
        row('Type', '<select id="pj-type"><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option></select>') +
        row('Salary', '<input id="pj-salary" placeholder="e.g. 10-12 LPA">') +
        row('Openings', '<input id="pj-openings" type="number" min="1" value="1">') +
        row('Priority', '<select id="pj-priority"><option>Normal</option><option>High</option><option>Low</option></select>') +
        row('Status', '<select id="pj-status">' + STATUS_OPTIONS.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select>') +
        row('Remote', '<select id="pj-remote"><option value="false">No</option><option value="true">Yes</option></select>') +
        '<div class="jt-mrow top"><label>Description</label><textarea id="pj-desc" placeholder="Role summary…"></textarea></div>' +
        '<div class="jt-mrow"><label></label><span id="pj-msg" style="font-size:12px;font-weight:600;color:var(--danger,#f75f4f)"></span></div>' +
      '</div>' +
      '<div class="jt-mf"><button class="jt-btn ghost" id="pj-cancel">Cancel</button><button class="jt-btn primary" id="pj-save">Post Job</button></div></div>';
    document.body.appendChild(ov); ensureStyle();
    function val(id) { var el = ov.querySelector('#' + id); return el ? (el.value || '').trim() : ''; }
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#pj-x').addEventListener('click', close);
    ov.querySelector('#pj-cancel').addEventListener('click', close);
    ov.querySelector('#pj-save').addEventListener('click', function () {
      var title = val('pj-title'), dept = val('pj-dept'), msg = ov.querySelector('#pj-msg');
      if (!title || !dept) { msg.textContent = 'Title and Department are required.'; return; }
      var btn = ov.querySelector('#pj-save'); btn.disabled = true; btn.textContent = 'Posting…';
      var body = { title: title, dept: dept, location: val('pj-location'), type: val('pj-type'), salary: val('pj-salary'), openings: parseInt(val('pj-openings'), 10) || 1, priority: val('pj-priority'), status: val('pj-status'), remote: ov.querySelector('#pj-remote').value === 'true', description: val('pj-desc'), autoPost: false };
      api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (job) { state.jobs.unshift(job); state.page = 1; renderTable(); close(); })
        .catch(function (e) { msg.textContent = e.message || 'Could not post the job.'; btn.disabled = false; btn.textContent = 'Post Job'; });
    });
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  function toggleExportMenu(btn) {
    var ex = document.getElementById(ID.menu); if (ex) { ex.remove(); return; }
    var menu = document.createElement('div'); menu.id = ID.menu;
    menu.innerHTML = '<button data-x="csv">⭳ Download CSV (.csv)</button><button data-x="xlsx">⭳ Download Excel (.xlsx)</button>';
    btn.parentNode.appendChild(menu); menu.style.top = (btn.offsetTop + btn.offsetHeight + 6) + 'px'; menu.style.left = btn.offsetLeft + 'px';
    menu.querySelector('[data-x="csv"]').addEventListener('click', function () { exportCsv(); menu.remove(); });
    menu.querySelector('[data-x="xlsx"]').addEventListener('click', function () { exportXlsx(); menu.remove(); });
    setTimeout(function () { document.addEventListener('click', function h() { var m = document.getElementById(ID.menu); if (m) m.remove(); document.removeEventListener('click', h); }); }, 0);
  }
  function exportRows() { var cols = shownCols(); return { head: cols.map(function (c) { return col(c.key).label; }), body: filteredJobs().map(function (job) { return cols.map(function (c) { var v = cellVal(job, c.key); return c.num ? (+job[c.key] || 0) : String(v); }); }) }; }
  function download(bytes, name, type) { var b = new Blob([bytes], { type: type }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100); }
  function exportCsv() { var d = exportRows(); var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; download('﻿' + [d.head].concat(d.body).map(function (r) { return r.map(q).join(','); }).join('\r\n'), 'jobs.csv', 'text/csv;charset=utf-8;'); }
  function exportXlsx() { var d = exportRows(); download(buildXlsx([d.head].concat(d.body)), 'jobs.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  function buildXlsx(rows) {
    function cl(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 | 0; } return s; }
    function xe(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var sr = rows.map(function (row, ri) { return '<row r="' + (ri + 1) + '">' + row.map(function (val, ci) { var ref = cl(ci) + (ri + 1); return (typeof val === 'number' && isFinite(val)) ? '<c r="' + ref + '"><v>' + val + '</v></c>' : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xe(val) + '</t></is></c>'; }).join('') + '</row>'; }).join('');
    var files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sr + '</sheetData></worksheet>' }
    ];
    return zipStore(files);
  }
  var CRCT = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var crc = -1; for (var i = 0; i < b.length; i++) crc = (crc >>> 8) ^ CRCT[(crc ^ b[i]) & 0xff]; return (crc ^ -1) >>> 0; }
  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data), sz = data.length;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + data.length;
    });
    var cd = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd), u32(offset), u16(0)));
    var all = parts.concat(central, [end]), total = all.reduce(function (a, b) { return a + b.length; }, 0), out = new Uint8Array(total), p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; }); return out;
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  function ensureLayout() {
    if (!onJobsPage()) { var r0 = document.getElementById(ID.root); if (r0) r0.remove(); closeDrawer(); closeFDrawer(); return; }
    var content = appContent(); if (!content) return;
    var parent = content.parentElement; if (!parent) return;
    ensureStyle();
    content.style.display = 'none';
    var root = document.getElementById(ID.root), fresh = false;
    if (!root) { root = buildRoot(); fresh = true; }
    root.style.display = '';
    if (root.parentElement !== parent) parent.appendChild(root);
    if (fresh) { renderTable(); if (!state.loaded) loadJobs(); }
  }

  function start() {
    loadColPrefs(); loadCustomLabels(); ensureLayout();
    // A job just posted via the Form Builder → refresh the grid + labels.
    window.addEventListener('hrmsJobPosted', function () { loadCustomLabels(); loadJobs(); });
    // Form schema was re-published → refresh the available custom columns.
    window.addEventListener('hrmsJobFormPublished', function () { loadCustomLabels(); });
    var scheduled = false;
    new MutationObserver(function () { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; ensureLayout(); }); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { setTimeout(ensureLayout, 60); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
