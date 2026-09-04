/*
 * hrms-candidate-compare.js
 * ---------------------------------------------------------------------------
 * Replaces the "Candidate Comparison" card on the Resume Scoring page
 * (/recruit/resume-scoring) with a job-board-style data grid — WITHOUT a bundle
 * rebuild. Same house pattern as hrms-jobs-table.js.
 *
 *   • Own grid from /api/resume-scores (the React card is hidden while mounted).
 *   • Free-text search (name / role).
 *   • Per-column Excel-style filter popups (sort + value search + checklist).
 *   • "Edit Filters" drawer: predefined quick filters + custom "contains" rules.
 *   • Pagination (page size + first/prev/pages/next/last).
 *   • Row click → candidate detail modal (score rings, skills, gaps).
 *   • Export CSV.
 *
 * Only the Candidate Comparison card is taken over; the JD input, resume
 * upload, and "Match Score" detail card on the same page are left untouched.
 * Kept mounted by a MutationObserver. Theme-aware.
 */
(function () {
  'use strict';

  var PATH = '/recruit/resume-scoring';
  var CARD_TITLE = 'Candidate Comparison';
  var ID = {
    root: 'hrms-cc-root', style: 'hrms-cc-style', pop: 'hrms-cc-colpop',
    drawer: 'hrms-cc-drawer', modal: 'hrms-cc-modal', menu: 'hrms-cc-exportmenu',
  };

  // Grid columns. num → sorts/filters numerically and renders a score bar.
  var COLS = [
    { key: 'name', label: 'Candidate' },
    { key: 'role', label: 'Role' },
    { key: 'score', label: 'Overall', num: true, score: true },
    { key: 'technical', label: 'Technical', num: true, bar: true },
    { key: 'experience', label: 'Experience', num: true, bar: true },
    { key: 'domain', label: 'Domain', num: true, bar: true },
    { key: 'source', label: 'Source' },
    { key: 'formatted', label: 'Format', fmt: function (v) { return v ? 'Done' : 'Pending'; } },
  ];
  var PAGE_SIZES = [10, 25, 50, 100];
  var PREDEF = [
    ['all', 'All Candidates'], ['s90', 'Score ≥ 90'], ['s80', 'Score ≥ 80'],
    ['s70', 'Score ≥ 70'], ['done', 'Format: Done'], ['pending', 'Format: Pending'],
    ['new', 'Newly Uploaded'],
  ];

  var state = {
    rows: [], loaded: false,
    search: '', colFilters: {},         // key -> array of allowed display values
    predef: 'all', customFilters: [],   // [{key, val}] "contains"
    sortKey: null, sortDir: 1,
    page: 1, pageSize: 25,
    reactCount: -1,                     // last seen row count in the hidden React table
  };

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function onPage() { return location.pathname.replace(/\/+$/, '') === PATH; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function col(key) { for (var i = 0; i < COLS.length; i++) if (COLS[i].key === key) return COLS[i]; return { key: key, label: key }; }
  function cellVal(row, key) { var c = col(key); var v = row[key]; return c.fmt ? c.fmt(v, row) : (v == null ? '' : v); }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) throw new Error((d && (d.error || d.message || d.detail)) || ('HTTP ' + r.status));
        return d;
      });
    });
  }
  function loadData() {
    api('/api/resume-scores').then(function (rows) {
      state.rows = Array.isArray(rows) ? rows : [];
      state.loaded = true; renderTable();
    }).catch(function () { state.loaded = true; renderTable(); });
  }
  function initials(row) {
    if (row.initials) return String(row.initials).slice(0, 2).toUpperCase();
    var p = String(row.name || '').trim().split(/\s+/);
    var s = ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
    return (s || '?').toUpperCase();
  }
  function scoreColor(n) { n = num(n); return n >= 85 ? '#22c55e' : n >= 70 ? '#f59e0b' : n >= 50 ? '#eab308' : '#ef4444'; }

  function distinct(key) {
    var seen = {}, out = [];
    state.rows.forEach(function (r) { var v = String(cellVal(r, key)); if (!(v in seen)) { seen[v] = 1; out.push(v); } });
    out.sort(function (a, b) { return col(key).num ? num(a) - num(b) : a.localeCompare(b); });
    return out;
  }

  function matchPredef(r) {
    switch (state.predef) {
      case 's90': return num(r.score) >= 90;
      case 's80': return num(r.score) >= 80;
      case 's70': return num(r.score) >= 70;
      case 'done': return !!r.formatted;
      case 'pending': return !r.formatted;
      case 'new': return !!r.uploaded;
      default: return true;
    }
  }

  // Single choke point: search + column checklists + predefined + custom, then sort.
  function filtered() {
    var q = state.search.trim().toLowerCase();
    var rows = state.rows.filter(function (r) {
      if (q && !((String(r.name || '')).toLowerCase().indexOf(q) !== -1 || (String(r.role || '')).toLowerCase().indexOf(q) !== -1)) return false;
      for (var k in state.colFilters) { if (state.colFilters[k] && state.colFilters[k].indexOf(String(cellVal(r, k))) === -1) return false; }
      if (state.predef !== 'all' && !matchPredef(r)) return false;
      for (var i = 0; i < state.customFilters.length; i++) {
        var cf = state.customFilters[i];
        if (cf.val && String(cellVal(r, cf.key)).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false;
      }
      return true;
    });
    if (state.sortKey) {
      var k = state.sortKey, dir = state.sortDir, numeric = col(k).num;
      rows = rows.slice().sort(function (a, b) {
        var va = cellVal(a, k), vb = cellVal(b, k);
        if (numeric) return (num(va) - num(vb)) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    return rows;
  }

  function activeFilterCount() {
    var n = 0;
    for (var k in state.colFilters) if (state.colFilters[k]) n++;
    if (state.predef !== 'all') n++;
    n += state.customFilters.filter(function (c) { return c.val; }).length;
    return n;
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var R = '#' + ID.root;
    var css =
      R + '{margin-top:4px;}' +
      R + ' .cc-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px;}' +
      R + ' .cc-search{flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font:inherit;font-size:12px;}' +
      R + ' .cc-title{font-size:15px;font-weight:700;color:var(--text);margin-right:auto;}' +
      R + ' .cc-count{font-size:12px;color:var(--text3);margin-left:8px;font-weight:600;}' +
      R + ' table{width:100%;border-collapse:collapse;font-size:12.5px;}' +
      R + ' thead th{text-align:left;padding:9px 10px;color:var(--text3);font-weight:600;border-bottom:1px solid var(--border2);white-space:nowrap;}' +
      R + ' thead th .cc-th{display:flex;align-items:center;gap:6px;}' +
      R + ' tbody td{padding:9px 10px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:middle;}' +
      R + ' tbody tr{cursor:pointer;}' +
      R + ' tbody tr:hover{background:var(--bg3);}' +
      R + ' .cc-av{display:inline-flex;align-items:center;gap:7px;}' +
      // Global (not root-scoped) so the detail/resume modal avatar styles too.
      '.cc-avc{width:28px;height:28px;border-radius:50%;background:var(--accent,#4f8ef7);color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}' +
      R + ' .cc-nm{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      R + ' .cc-ic{background:transparent;border:0;cursor:pointer;font-size:13px;opacity:.5;padding:0 2px;line-height:1;color:var(--text2);}' +
      R + ' .cc-ic:hover{opacity:1;color:var(--accent,#4f8ef7);}' +
      R + ' .cc-badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--bg3);border:1px solid var(--border2);color:var(--text2);}' +
      R + ' .cc-bar-t{height:7px;border-radius:99px;background:var(--border2);overflow:hidden;min-width:52px;display:inline-block;width:70px;vertical-align:middle;}' +
      // display:block — an inline <span> ignores height/width, so the fill was invisible.
      R + ' .cc-bar-f{display:block;height:100%;border-radius:99px;}' +
      R + ' .cc-barn{font-size:11px;color:var(--text2);margin-left:6px;}' +
      R + ' .cc-view{padding:3px 10px;border:1px solid var(--border2);background:var(--bg3);border-radius:7px;color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;}' +
      R + ' .cc-funnel{cursor:pointer;color:var(--text3);font-size:11px;opacity:.55;}' +
      R + ' .cc-funnel.on{opacity:1;color:var(--accent,#4f8ef7);}' +
      R + ' .cc-empty{padding:26px;text-align:center;color:var(--text3);}' +
      R + ' .cc-pg{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:14px;font-size:12.5px;color:var(--text3);}' +
      R + ' .cc-pg .cc-pgspacer{flex:1;}' +
      R + ' .cc-pg button{min-width:30px;height:30px;padding:0 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;}' +
      R + ' .cc-pg button:hover:not(:disabled){border-color:var(--accent,#4f8ef7);}' +
      R + ' .cc-pg button:disabled{opacity:.4;cursor:not-allowed;}' +
      R + ' .cc-pg button.cur{background:var(--accent,#4f8ef7);color:#fff;border-color:var(--accent,#4f8ef7);}' +
      R + ' .cc-pg select{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:12px;padding:5px 6px;}' +
      // global (body-appended) controls
      '.cc-btn{padding:8px 12px;border:1px solid var(--border2);background:var(--bg3);border-radius:8px;color:var(--text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}' +
      '.cc-btn.primary{background:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);color:#fff;}' +
      '.cc-btn.ghost{background:transparent;}' +
      '.cc-pill{font-size:10px;font-weight:700;background:var(--accent,#4f8ef7);color:#fff;border-radius:99px;padding:1px 6px;}' +
      '#' + ID.pop + '{position:absolute;z-index:10000;background:var(--bg2,#161b26);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.4);padding:10px;width:250px;font-size:12px;color:var(--text);}' +
      '#' + ID.pop + ' .cc-psort{display:flex;gap:6px;margin-bottom:8px;}' +
      '#' + ID.pop + ' .cc-psort button{flex:1;padding:6px;border:1px solid var(--border2);background:var(--bg3);border-radius:7px;color:var(--text2);font-size:11px;cursor:pointer;}' +
      '#' + ID.pop + ' .cc-psearch{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--border2);border-radius:7px;background:var(--bg3);color:var(--text);font-size:12px;margin-bottom:8px;}' +
      '#' + ID.pop + ' .cc-pvals{max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:7px;padding:6px;margin-bottom:8px;}' +
      '#' + ID.pop + ' .cc-pv{display:flex;align-items:center;gap:7px;padding:3px 2px;cursor:pointer;}' +
      '#' + ID.pop + ' .cc-pf{display:flex;gap:6px;}' +
      '#' + ID.pop + ' .cc-pf button{flex:1;padding:6px;border-radius:7px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);font-size:11px;font-weight:600;cursor:pointer;}' +
      '#' + ID.pop + ' .cc-pf button.primary{background:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);color:#fff;}' +
      '.cc-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;}' +
      '.cc-dr{margin-left:auto;width:360px;max-width:92vw;height:100%;background:var(--bg2,#161b26);border-left:1px solid var(--border2);display:flex;flex-direction:column;}' +
      '.cc-dr-h{display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border2);font-weight:700;color:var(--text);}' +
      '.cc-dr-b{padding:14px 16px;overflow:auto;flex:1;}' +
      '.cc-dr-f{padding:12px 16px;border-top:1px solid var(--border2);display:flex;gap:8px;}' +
      '.cc-fsec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin:14px 0 8px;}' +
      '.cc-pd label{display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:12.5px;color:var(--text);cursor:pointer;}' +
      '.cc-cf{display:flex;gap:6px;margin-bottom:6px;}' +
      '.cc-cf select,.cc-cf input{padding:6px 8px;border:1px solid var(--border2);border-radius:7px;background:var(--bg3);color:var(--text);font-size:12px;}' +
      '.cc-cf select{flex:0 0 120px;}.cc-cf input{flex:1;min-width:0;}' +
      '.cc-cfx{flex:0 0 auto;width:30px;border:1px solid var(--border2);border-radius:7px;background:var(--bg3);color:var(--text2);cursor:pointer;}' +
      '.cc-addf{margin-top:4px;padding:6px 10px;border:1px dashed var(--border2);border-radius:7px;background:transparent;color:var(--text2);font-size:12px;cursor:pointer;}' +
      '.cc-modal{margin:auto;width:560px;max-width:94vw;max-height:90vh;overflow:auto;background:var(--bg2,#161b26);border:1px solid var(--border2);border-radius:14px;}' +
      '.cc-modal-h{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border2);}' +
      '.cc-modal-b{padding:18px;}' +
      '.cc-x{margin-left:auto;background:transparent;border:0;color:var(--text3);font-size:20px;cursor:pointer;line-height:1;}' +
      '.cc-ring{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 16px;}' +
      '.cc-ring .cc-rc{flex:1;min-width:130px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;}' +
      '.cc-rc .cc-rv{font-size:26px;font-weight:800;}' +
      '.cc-rc .cc-rl{font-size:11px;color:var(--text3);margin-top:2px;}' +
      '.cc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 14px;}' +
      '.cc-chip{font-size:11.5px;padding:4px 11px;border-radius:99px;font-weight:500;display:inline-flex;align-items:center;gap:4px;line-height:1.45;}' +
      '.cc-chip b{font-weight:700;}' +
      '.cc-chip.miss{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.38);color:#b91c1c;}' +
      '[data-theme="dark"] .cc-chip.miss, .dark .cc-chip.miss{background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.45);color:#fca5a5;}' +
      '.cc-chip.str{background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.38);color:#15803d;}' +
      '[data-theme="dark"] .cc-chip.str, .dark .cc-chip.str{background:rgba(34,197,94,0.18);border-color:rgba(34,197,94,0.45);color:#86efac;}' +
      '.cc-brief-card{background:var(--bg3);border:1px solid var(--border2);border-left:4px solid #6366f1;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.65;color:var(--text);}' +
      '.cc-brief-card b{font-weight:700;color:var(--text);}' +
      '.cc-ai-pulse{display:inline-block;animation:ccPulse 1.4s infinite ease-in-out;color:var(--accent,#4f8ef7);}' +
      '@keyframes ccPulse{0%,100%{opacity:.4;transform:scale(.98)}50%{opacity:1;transform:scale(1.02)}}' +
      '.cc-toggle-wrap{display:inline-flex;align-items:center;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:3px;gap:3px;vertical-align:middle;}' +
      '.cc-toggle-tab{border:none;background:transparent;color:var(--text2);font-size:12px;font-weight:600;padding:6px 14px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .2s ease;}' +
      '.cc-toggle-tab:hover{color:var(--text);}' +
      '.cc-toggle-tab.active.std{background:var(--accent,#4f8ef7);color:#fff;box-shadow:0 2px 8px rgba(79,142,247,0.35);}' +
      '.cc-toggle-tab.active.ai{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 2px 8px rgba(99,102,241,0.38);}' +
      '#hrms-ai-card-overlay{max-height:510px;overflow-y:auto;overflow-x:hidden;padding-right:4px;box-sizing:border-box;}' +
      '#hrms-ai-card-overlay::-webkit-scrollbar{width:5px;}' +
      '#hrms-ai-card-overlay::-webkit-scrollbar-track{background:transparent;}' +
      '#hrms-ai-card-overlay::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px;}' +
      '#hrms-ai-card-overlay::-webkit-scrollbar-thumb:hover{background:var(--accent,#4f8ef7);}' +
      '#' + ID.menu + '{position:absolute;z-index:10000;background:var(--bg2,#161b26);border:1px solid var(--border2);border-radius:8px;box-shadow:0 10px 26px rgba(0,0,0,.4);overflow:hidden;}' +
      '#' + ID.menu + ' button{display:block;width:100%;text-align:left;padding:9px 14px;background:transparent;border:0;color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap;}' +
      '#' + ID.menu + ' button:hover{background:var(--bg3);}';
    var st = document.createElement('style'); st.id = ID.style; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  function buildRoot() {
    var root = document.createElement('div'); root.id = ID.root;
    root.innerHTML =
      '<div class="cc-bar">' +
        '<span class="cc-title">' + CARD_TITLE + '<span class="cc-count" id="cc-count"></span></span>' +
        '<input class="cc-search" id="cc-search" placeholder="Search name or role…">' +
        '<button class="cc-btn" id="cc-filters">☰ Edit Filters</button>' +
        '<button class="cc-btn ghost" id="cc-export">↓ Export</button>' +
      '</div>' +
      '<div id="cc-tablewrap" style="overflow-x:auto"></div>' +
      '<div class="cc-pg" id="cc-pg"></div>';
    root.querySelector('#cc-search').addEventListener('input', function (e) { state.search = e.target.value; state.page = 1; renderTable(); });
    root.querySelector('#cc-filters').addEventListener('click', openFiltersDrawer);
    root.querySelector('#cc-export').addEventListener('click', function () { toggleExportMenu(this); });
    return root;
  }

  function renderTable() {
    var root = document.getElementById(ID.root); if (!root) return;
    var wrap = root.querySelector('#cc-tablewrap'); if (!wrap) return;

    if (!state.loaded) { wrap.innerHTML = '<div class="cc-empty">Loading candidates…</div>'; renderPg(0); setCount(); return; }
    var all = filtered(), total = all.length;
    if (!total) {
      wrap.innerHTML = '<div class="cc-empty">' + (state.rows.length ? 'No candidates match the current filters.' : 'No candidates scored yet.') + '</div>';
      renderPg(0); setCount(); return;
    }
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * state.pageSize, rows = all.slice(start, start + state.pageSize);

    var head = COLS.map(function (c) {
      var on = (state.sortKey === c.key) || state.colFilters[c.key];
      return '<th><span class="cc-th">' + esc(c.label) +
        '<span class="cc-funnel' + (on ? ' on' : '') + '" data-f="' + c.key + '" title="Sort &amp; filter">▾</span></span></th>';
    }).join('') + '<th></th>';

    var body = rows.map(function (r) {
      return '<tr data-id="' + esc(r.id) + '">' +
        COLS.map(function (c) { return '<td>' + cell(r, c) + '</td>'; }).join('') +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="cc-btn primary" data-ai="' + esc(r.id) + '" style="padding:2px 8px;font-size:11px;margin-right:6px">✦ AI</button>' +
          '<button class="cc-view" data-view="' + esc(r.id) + '">View</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';

    wrap.querySelectorAll('.cc-funnel').forEach(function (f) {
      f.addEventListener('click', function (e) { e.stopPropagation(); openColPopup(f.getAttribute('data-f'), f); });
    });
    wrap.querySelectorAll('tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function () { syncToCandidate(byId(tr.getAttribute('data-id'))); });
    });
    wrap.querySelectorAll('[data-ai]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); showAIModal(byId(b.getAttribute('data-ai'))); });
    });
    wrap.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); syncToCandidate(byId(b.getAttribute('data-view'))); });
    });
    wrap.querySelectorAll('[data-eye]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); viewResume(byId(b.getAttribute('data-eye'))); });
    });
    wrap.querySelectorAll('[data-dl2]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); downloadResume(byId(b.getAttribute('data-dl2'))); });
    });
    renderPg(total, start, rows.length, pages);
    setCount(total);
  }

  function cell(r, c) {
    var v = cellVal(r, c.key);
    if (c.key === 'name') {
      return '<span class="cc-av"><span class="cc-avc">' + esc(initials(r)) + '</span>' +
        '<span class="cc-nm">' + esc(r.name || '—') + '</span>' +
        '<button class="cc-ic" data-eye="' + esc(r.id) + '" title="View resume">👁</button>' +
        '<button class="cc-ic" data-dl2="' + esc(r.id) + '" title="Download resume">⭳</button>' +
      '</span>';
    }
    if (c.score) { return '<b style="color:' + scoreColor(v) + '">' + num(v) + '</b>'; }
    if (c.bar) {
      var n = num(v);
      return '<span class="cc-bar-t"><span class="cc-bar-f" style="width:' + Math.max(0, Math.min(100, n)) + '%;background:' + scoreColor(n) + '"></span></span><span class="cc-barn">' + n + '</span>';
    }
    if (c.key === 'source') { return '<span class="cc-badge">' + esc(v || 'Upload') + '</span>'; }
    if (c.key === 'formatted') { return r.formatted ? '<span style="color:#22c55e">✓ Done</span>' : '<span style="color:var(--text3)">Pending</span>'; }
    return esc(v || '—');
  }

  function setCount(total) {
    var el = document.getElementById('cc-count'); if (!el) return;
    if (!state.loaded) { el.textContent = ''; return; }
    var t = total == null ? filtered().length : total;
    el.textContent = '· ' + t + ' / ' + state.rows.length + ' shown';
  }

  function renderPg(total, start, shown, pages) {
    var pg = document.getElementById('cc-pg'); if (!pg) return;
    if (!total) { pg.innerHTML = ''; return; }
    var from = start + 1, to = start + shown, p = state.page;
    var lo = Math.max(1, p - 2), hi = Math.min(pages, lo + 4); lo = Math.max(1, hi - 4);
    var nums = []; for (var i = lo; i <= hi; i++) nums.push(i);
    pg.innerHTML =
      '<span>' + from + '–' + to + ' of ' + total + '</span>' +
      '<span class="cc-pgspacer"></span>' +
      '<button data-pg="first"' + (p <= 1 ? ' disabled' : '') + '>«</button>' +
      '<button data-pg="prev"' + (p <= 1 ? ' disabled' : '') + '>‹</button>' +
      nums.map(function (n) { return '<button data-pg="' + n + '"' + (n === p ? ' class="cur"' : '') + '>' + n + '</button>'; }).join('') +
      '<button data-pg="next"' + (p >= pages ? ' disabled' : '') + '>›</button>' +
      '<button data-pg="last"' + (p >= pages ? ' disabled' : '') + '>»</button>' +
      '<select id="cc-psize">' + PAGE_SIZES.map(function (s) { return '<option' + (s === state.pageSize ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
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
    var sz = pg.querySelector('#cc-psize'); if (sz) sz.addEventListener('change', function (e) { state.pageSize = +e.target.value; state.page = 1; renderTable(); });
  }

  function byId(id) { for (var i = 0; i < state.rows.length; i++) if (String(state.rows[i].id) === String(id)) return state.rows[i]; return null; }

  /* ── per-column filter popup ──────────────────────────────────────────── */
  function openColPopup(key, anchor) {
    closePopups();
    var values = distinct(key);
    var sel = state.colFilters[key] ? state.colFilters[key].slice() : values.slice();
    var pop = document.createElement('div'); pop.id = ID.pop;
    pop.innerHTML =
      '<div class="cc-psort"><button data-s="1">↑ Sort A→Z</button><button data-s="-1">↓ Sort Z→A</button></div>' +
      '<input class="cc-psearch" placeholder="Search values…">' +
      '<div class="cc-pvals"><label class="cc-pv"><input type="checkbox" id="cc-pall"> <b>(Select all)</b></label><div id="cc-pvlist"></div></div>' +
      '<div class="cc-pf"><button class="primary" data-a="apply">Apply</button><button data-a="clear">Clear</button></div>';
    document.body.appendChild(pop);
    var rect = anchor.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left + window.scrollX - 120, window.innerWidth - 270)) + 'px';

    function drawList(f) {
      var list = pop.querySelector('#cc-pvlist');
      var shown = values.filter(function (v) { return !f || v.toLowerCase().indexOf(f.toLowerCase()) !== -1; });
      list.innerHTML = shown.map(function (v) {
        return '<label class="cc-pv"><input type="checkbox" value="' + esc(v) + '"' + (sel.indexOf(v) !== -1 ? ' checked' : '') + '> ' + (esc(v) || '<i>(blank)</i>') + '</label>';
      }).join('');
      list.querySelectorAll('input').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var val = cb.value;
          if (cb.checked) { if (sel.indexOf(val) === -1) sel.push(val); }
          else { var i = sel.indexOf(val); if (i !== -1) sel.splice(i, 1); }
          pop.querySelector('#cc-pall').checked = sel.length === values.length;
        });
      });
      pop.querySelector('#cc-pall').checked = sel.length === values.length;
    }
    drawList('');
    pop.querySelector('.cc-psearch').addEventListener('input', function (e) { drawList(e.target.value); });
    pop.querySelector('#cc-pall').addEventListener('change', function (e) { sel = e.target.checked ? values.slice() : []; drawList(pop.querySelector('.cc-psearch').value); });
    pop.querySelectorAll('.cc-psort button').forEach(function (b) {
      b.addEventListener('click', function () { state.sortKey = key; state.sortDir = +b.getAttribute('data-s'); closePopups(); renderTable(); });
    });
    pop.querySelector('[data-a="apply"]').addEventListener('click', function () {
      state.colFilters[key] = (sel.length === values.length) ? null : sel.slice();
      if (!state.colFilters[key]) delete state.colFilters[key];
      state.page = 1; closePopups(); renderTable();
    });
    pop.querySelector('[data-a="clear"]').addEventListener('click', function () { delete state.colFilters[key]; state.page = 1; closePopups(); renderTable(); });
    setTimeout(function () {
      document.addEventListener('mousedown', function h(e) { if (!pop.contains(e.target)) { closePopups(); document.removeEventListener('mousedown', h); } });
    }, 0);
  }
  function closePopups() { var p = document.getElementById(ID.pop); if (p) p.remove(); }

  /* ── Edit Filters drawer ──────────────────────────────────────────────── */
  function openFiltersDrawer() {
    closeDrawer();
    var predef = state.predef, custom = state.customFilters.map(function (c) { return { key: c.key, val: c.val }; });
    var ov = document.createElement('div'); ov.className = 'cc-ov'; ov.id = ID.drawer;
    ov.innerHTML =
      '<div class="cc-dr">' +
        '<div class="cc-dr-h">Edit Filters<button class="cc-x" id="cc-dr-x" style="margin-left:auto">×</button></div>' +
        '<div class="cc-dr-b">' +
          '<div class="cc-fsec" style="margin-top:0">Pre-Defined Filters</div>' +
          '<div class="cc-pd" id="cc-pd">' + PREDEF.map(function (p) {
            return '<label><input type="radio" name="cc-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '> ' + esc(p[1]) + '</label>';
          }).join('') + '</div>' +
          '<div class="cc-fsec">Custom Filters (contains)</div>' +
          '<div id="cc-cflist"></div>' +
          '<button class="cc-addf" id="cc-addf">+ Add Filter</button>' +
        '</div>' +
        '<div class="cc-dr-f"><button class="cc-btn primary" id="cc-dr-apply" style="flex:1">Apply</button><button class="cc-btn" id="cc-dr-reset">Reset</button></div>' +
      '</div>';
    document.body.appendChild(ov);

    function drawCustom() {
      var host = ov.querySelector('#cc-cflist');
      host.innerHTML = custom.map(function (cf, i) {
        return '<div class="cc-cf">' +
          '<select data-i="' + i + '" data-k="key">' + COLS.map(function (c) { return '<option value="' + c.key + '"' + (c.key === cf.key ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('') + '</select>' +
          '<input data-i="' + i + '" data-k="val" placeholder="contains…" value="' + esc(cf.val || '') + '">' +
          '<button class="cc-cfx" data-x="' + i + '">×</button>' +
        '</div>';
      }).join('');
      host.querySelectorAll('select,input').forEach(function (el) {
        el.addEventListener('input', function () { custom[+el.getAttribute('data-i')][el.getAttribute('data-k')] = el.value; });
      });
      host.querySelectorAll('[data-x]').forEach(function (b) {
        b.addEventListener('click', function () { custom.splice(+b.getAttribute('data-x'), 1); drawCustom(); });
      });
    }
    drawCustom();

    ov.addEventListener('click', function (e) { if (e.target === ov) closeDrawer(); });
    ov.querySelector('#cc-dr-x').addEventListener('click', closeDrawer);
    ov.querySelector('#cc-addf').addEventListener('click', function () { custom.push({ key: COLS[0].key, val: '' }); drawCustom(); });
    ov.querySelector('#cc-dr-apply').addEventListener('click', function () {
      var r = ov.querySelector('input[name="cc-predef"]:checked'); state.predef = r ? r.value : 'all';
      state.customFilters = custom.filter(function (c) { return c.val && c.val.trim(); });
      state.page = 1; closeDrawer(); renderTable();
    });
    ov.querySelector('#cc-dr-reset').addEventListener('click', function () {
      state.predef = 'all'; state.customFilters = []; state.colFilters = {}; state.sortKey = null; state.search = '';
      var si = document.getElementById('cc-search'); if (si) si.value = '';
      state.page = 1; closeDrawer(); renderTable();
    });
  }
  function closeDrawer() { var d = document.getElementById(ID.drawer); if (d) d.remove(); }

  /* ── view / download the stored resume text ───────────────────────────── */
  // Only the extracted resume TEXT is stored server-side (the original PDF is
  // parsed client-side and never uploaded), so "view/download resume" operates
  // on resumeText, which the list endpoint already returns.
  var detailCache = {};
  function fetchDetail(id) {
    if (detailCache[id]) return Promise.resolve(detailCache[id]);
    return api('/api/resume-scores/' + id).then(function (d) { detailCache[id] = d || {}; return detailCache[id]; });
  }
  function b64ToBlob(b64, mime) {
    try {
      var bin = atob(b64 || ''), n = bin.length, a = new Uint8Array(n);
      for (var i = 0; i < n; i++) a[i] = bin.charCodeAt(i);
      return new Blob([a], { type: mime || 'application/octet-stream' });
    } catch (_) { return null; }
  }
  function previewable(mime) { return /pdf|image\//i.test(mime || ''); }
  function triggerDownload(blob, name) {
    var u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100);
  }

  // View the stored resume: render the real PDF/image in a new tab; fall back to
  // the extracted text (with a Download for non-previewable types like .docx).
  function viewResume(r) {
    if (!r) return;
    fetchDetail(r.id).then(function (d) {
      d = d || {};
      if (d.fileData && previewable(d.fileMime)) {
        var blob = b64ToBlob(d.fileData, d.fileMime);
        if (blob) { var u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(function () { URL.revokeObjectURL(u); }, 60000); return; }
      }
      showTextModal(r, d.resumeText || r.resumeText || '', !!d.fileData);
    }).catch(function () { showTextModal(r, r.resumeText || '', false); });
  }
  function showTextModal(r, txt, hasFile) {
    closeModal();
    txt = (txt || '').trim();
    var ov = document.createElement('div'); ov.className = 'cc-ov'; ov.id = ID.modal;
    ov.innerHTML =
      '<div class="cc-modal">' +
        '<div class="cc-modal-h">' +
          '<span class="cc-avc" style="width:34px;height:34px;font-size:13px">' + esc(initials(r)) + '</span>' +
          '<div style="flex:1;min-width:0"><div style="font-weight:700;color:var(--text)">' + esc(r.name || '—') + '</div>' +
            '<div style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.fileName || 'Resume text') + '</div></div>' +
          ((hasFile || txt) ? '<button class="cc-btn" id="cc-m-dl">⭳ Download</button>' : '') +
          '<button class="cc-x" id="cc-m-x">×</button>' +
        '</div>' +
        '<div class="cc-modal-b">' +
          (txt
            ? '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;color:var(--text);margin:0;font-family:var(--font)">' + esc(txt) + '</pre>'
            : '<div style="padding:26px;text-align:center;color:var(--text3)">' +
              (hasFile ? 'This file type can’t be previewed in the browser. Use Download to open it.' : 'No resume is stored for this candidate.') + '</div>') +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    ov.querySelector('#cc-m-x').addEventListener('click', closeModal);
    var dl = ov.querySelector('#cc-m-dl'); if (dl) dl.addEventListener('click', function () { downloadResume(r); });
  }

  function findMatchScoreCard() {
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.querySelector('textarea') || c.id === ID.root || c.getAttribute('data-cc-hidden')) continue;
      var text = (c.textContent || '');
      if (text.indexOf('MATCH SCORE') !== -1 || text.indexOf('Match Score') !== -1 || text.indexOf('AI DEEP ANALYSIS') !== -1 || text.indexOf('Upload a PDF') !== -1 || text.indexOf('Overall Match') !== -1) {
        return c;
      }
    }
    for (var j = cards.length - 1; j >= 0; j--) {
      if (!cards[j].querySelector('textarea') && cards[j].id !== ID.root) return cards[j];
    }
    return null;
  }

  function resolveCandidateAndResume(r, targetCard) {
    var textareas = document.querySelectorAll('textarea');
    var jdText = textareas.length >= 2 ? (textareas[0].value || '').trim() : '';
    var taResume = textareas.length >= 2 ? (textareas[1].value || '').trim() : (textareas.length === 1 ? (textareas[0].value || '').trim() : '');

    if (r && r.resumeText && r.resumeText.trim()) {
      return Promise.resolve({
        resumeText: r.resumeText,
        name: r.name || 'Candidate',
        role: r.role || 'Senior Frontend Engineer',
        jdText: r.jdText || jdText,
        id: r.id
      });
    }

    if (taResume) {
      var extractedName = (r && r.name) || '';
      if (!extractedName) {
        var firstLine = (taResume.split('\n')[0] || '').trim();
        extractedName = firstLine.split(/[-–—|,]/)[0].trim();
      }
      return Promise.resolve({
        resumeText: taResume,
        name: extractedName || 'Candidate',
        role: (r && r.role) || 'Senior Frontend Engineer',
        jdText: (r && r.jdText) || jdText,
        id: r && r.id
      });
    }

    var targetText = targetCard ? (targetCard.textContent || '') : '';
    var fetchRows = (state.rows && state.rows.length) ? Promise.resolve(state.rows) : api('/api/resume-scores').then(function (d) {
      state.rows = Array.isArray(d) ? d : [];
      return state.rows;
    }).catch(function () { return []; });

    return fetchRows.then(function (rows) {
      var matched = null;
      if (rows && rows.length) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].name && targetText.indexOf(rows[i].name) !== -1) {
            matched = rows[i];
            break;
          }
        }
        if (!matched) matched = rows[0];
      }

      if (matched) {
        if (matched.resumeText && matched.resumeText.trim()) {
          return {
            resumeText: matched.resumeText,
            name: matched.name,
            role: matched.role || 'Senior Frontend Engineer',
            jdText: (r && r.jdText) || jdText,
            id: matched.id
          };
        }
        return fetchDetail(matched.id).then(function (detail) {
          return {
            resumeText: (detail && detail.resumeText) || '',
            name: matched.name,
            role: matched.role || 'Senior Frontend Engineer',
            jdText: (r && r.jdText) || jdText,
            id: matched.id
          };
        }).catch(function () {
          return {
            resumeText: '',
            name: matched.name,
            role: matched.role || 'Senior Frontend Engineer',
            jdText: (r && r.jdText) || jdText,
            id: matched.id
          };
        });
      }

      return {
        resumeText: '',
        name: (r && r.name) || 'Candidate',
        role: (r && r.role) || 'Senior Frontend Engineer',
        jdText: (r && r.jdText) || jdText
      };
    });
  }

  function showAIModal(r) {
    var targetCard = findMatchScoreCard();
    if (!targetCard) return;

    var overlay = document.getElementById('hrms-ai-card-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hrms-ai-card-overlay';
      targetCard.appendChild(overlay);
    }
    overlay.style.display = 'block';
    overlay.style.width = '100%';
    overlay.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;width:100%;text-align:center;margin:auto" class="cc-ai-pulse">' +
        '<div style="font-size:42px;margin-bottom:14px;color:#8b5cf6">✦</div>' +
        '<div style="font-weight:700;font-size:16px;color:var(--text)">Running Rapid AI Semantic Analysis…</div>' +
        '<div style="font-size:12px;color:var(--text3);margin-top:6px">Evaluating production depth &amp; domain fit via Claude</div>' +
      '</div>';

    var children = targetCard.children;
    for (var k = 0; k < children.length; k++) {
      if (children[k] !== overlay) children[k].style.display = 'none';
    }

    resolveCandidateAndResume(r, targetCard).then(function (cand) {
      var resumeText = cand.resumeText || '';
      var jdText = cand.jdText || '';
      var name = cand.name || 'Candidate';
      var role = cand.role || 'Senior Frontend Engineer';

      if (!resumeText) throw new Error('No resume text found for candidate "' + name + '". Please upload or paste a resume.');

      return api('/api/ai/score-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText: resumeText,
          jdText: jdText || '',
          name: name,
          role: role,
          saveToDb: true
        })
      }).then(function (res) {
        renderAIResult(res, { name: name, role: role, id: cand.id }, targetCard);
        loadData();
      });
    }).catch(function (err) {
      var msg = err.message || 'Could not connect to AI service.';
      if (msg.indexOf('404') !== -1) {
        msg = 'Endpoint <code>/api/ai/score-resume</code> returned 404.<br><br><b>Action required:</b> Please restart your running Django / Daphne development server so the new AI routes take effect.';
      }
      overlay.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;width:100%;text-align:center;padding:24px;box-sizing:border-box">' +
          '<div style="color:var(--danger,#ef4444);font-weight:700;font-size:15px;margin-bottom:8px">AI Analysis Unavailable</div>' +
          '<div style="font-size:12px;color:var(--text3);line-height:1.6">' + msg + '</div>' +
        '</div>';
    });
  }

  function drawRingSvg(percent, color) {
    var radius = 24;
    var circ = 2 * Math.PI * radius;
    var offset = circ - (Math.max(0, Math.min(100, percent)) / 100) * circ;
    return '<svg width="60" height="60" viewBox="0 0 60 60" style="display:block;margin:0 auto 4px">' +
      '<circle cx="30" cy="30" r="' + radius + '" stroke="var(--border2)" stroke-width="4.5" fill="none" />' +
      '<circle cx="30" cy="30" r="' + radius + '" stroke="' + color + '" stroke-width="4.5" fill="none" stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" transform="rotate(-90 30 30)" />' +
      '<text x="30" y="34.5" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="800" fill="var(--text)" font-family="inherit">' + percent + '%</text>' +
    '</svg>';
  }

  function highlightBold(text) {
    if (!text) return '';
    var s = esc(text);
    // Bold numbers + years/experience: e.g. "6 years", "5+ years", "2024"
    s = s.replace(/(\b\d+\+?\s*(?:years?|yrs?|months?|internship|graduate|production)\b)/gi, '<b>$1</b>');
    // Bold critical lead keywords
    s = s.replace(/(\b(?:Zero|No|Lack of|Strong|Excellent|Tier-1|High-risk|Fast-track|Proven)\s+[A-Za-z0-9\+\#\-\/ ]{3,30}?\b)/gi, function (m) {
      if (m.indexOf('<b>') !== -1) return m;
      return '<b>' + m + '</b>';
    });
    return s;
  }

  function renderAIResult(res, r, targetCard) {
    if (!targetCard) targetCard = findMatchScoreCard();
    if (!targetCard) return;

    var overlay = document.getElementById('hrms-ai-card-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hrms-ai-card-overlay';
      targetCard.appendChild(overlay);
    }
    overlay.style.display = 'block';
    overlay.style.width = '100%';

    var children = targetCard.children;
    for (var k = 0; k < children.length; k++) {
      if (children[k] !== overlay) children[k].style.display = 'none';
    }

    var sc = num(res.score), tc = num(res.technical), exp = num(res.experience), dom = num(res.domain);
    var str = res.strengths || [], red = res.redFlags || [], skills = res.skills || [], missing = res.missing || [];
    var name = res.candidateName || r.name || 'Candidate';
    var role = res.role || r.role || 'Software Professional';

    overlay.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">' +
        '<div>' +
          '<div class="card-title" style="margin-bottom:6px">AI DEEP ANALYSIS</div>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span class="cc-avc" style="width:34px;height:34px;font-size:12px;background:linear-gradient(135deg,var(--accent2,#8b5cf6),var(--accent,#4f8ef7))">' + esc(initials({ name: name })) + '</span>' +
            '<div>' +
              '<div style="font-weight:700;font-size:13px;color:var(--text)">' + esc(name) + ' <span class="cc-badge" style="margin-left:6px;font-size:10px;color:#8b5cf6;border-color:rgba(139,92,246,0.3);background:rgba(139,92,246,0.08)">✦ Claude AI</span></div>' +
              '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + esc(role) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<div style="font-size:36px;font-weight:800;color:' + scoreColor(sc) + ';line-height:1">' + sc + '<span style="font-size:13px;color:var(--text3);font-weight:500"> / 100</span></div>' +
        '</div>' +
      '</div>' +

      '<div style="display:flex;gap:10px;margin:12px 0 16px;justify-content:space-between">' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:10px 6px;text-align:center">' +
          drawRingSvg(tc, scoreColor(tc)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text3);letter-spacing:0.5px">TECHNICAL</div>' +
        '</div>' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:10px 6px;text-align:center">' +
          drawRingSvg(exp, scoreColor(exp)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text3);letter-spacing:0.5px">EXPERIENCE</div>' +
        '</div>' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:10px 6px;text-align:center">' +
          drawRingSvg(dom, scoreColor(dom)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text3);letter-spacing:0.5px">DOMAIN</div>' +
        '</div>' +
      '</div>' +

      (skills.length ? '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">MATCHED SKILLS (' + skills.length + ')</div><div class="cc-chips" style="margin-bottom:12px">' + skills.map(function (s) { return '<span class="cc-chip str">✓ ' + esc(s) + '</span>'; }).join('') + '</div>' : '') +

      (missing.length ? '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">MISSING SKILLS (' + missing.length + ')</div><div class="cc-chips" style="margin-bottom:12px">' + missing.map(function (s) { return '<span class="cc-chip miss">✕ ' + esc(s) + '</span>'; }).join('') + '</div>' : '') +

      (res.executiveSummary ? '<div class="cc-brief-card"><b style="color:var(--accent,#4f8ef7)">✦ Hiring Brief:</b> ' + highlightBold(res.executiveSummary) + '</div>' : '') +

      (str.length ? '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">KEY STRENGTHS</div><div class="cc-chips" style="margin-bottom:12px">' + str.map(function (s) { return '<span class="cc-chip str">✓ ' + highlightBold(s) + '</span>'; }).join('') + '</div>' : '') +

      (red.length ? '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">GAPS &amp; RISKS</div><div class="cc-chips" style="margin-bottom:12px">' + red.map(function (s) { return '<span class="cc-chip miss">⚠ ' + highlightBold(s) + '</span>'; }).join('') + '</div>' : '');
  }

  function downloadResume(r) {
    if (!r) return;
    fetchDetail(r.id).then(function (d) {
      d = d || {};
      var name = String(d.fileName || r.fileName || r.name || 'resume').replace(/^.*[\\/]/, '');
      if (d.fileData) {
        var blob = b64ToBlob(d.fileData, d.fileMime);
        if (blob) { triggerDownload(blob, name || 'resume'); return; }
      }
      var txt = d.resumeText || r.resumeText || '';
      if (!txt.trim()) { alert('No resume file or text is stored for this candidate.'); return; }
      var base = (name.replace(/\.[a-z0-9]+$/i, '') || 'resume').replace(/[^\w.-]+/g, '_');
      triggerDownload(new Blob([txt], { type: 'text/plain;charset=utf-8' }), base + '.txt');
    }).catch(function () { alert('Could not load the resume.'); });
  }
  function closeModal() { var m = document.getElementById(ID.modal); if (m) m.remove(); }

  /* ── select a candidate into the page's React panels ──────────────────────
     The Match Score card and Resume Input are React-owned. Rather than reaching
     into React state, we reproduce the user's own actions: dispatch a click on
     the matching (hidden) React comparison row — which the app handles to set
     the selected candidate — and drive the resume textarea through its native
     value setter so React's onChange fires. Then scroll the panels into view. */
  function proxyClickReact(r) {
    var card = document.querySelector('[data-cc-hidden]') || reactCard();
    if (!card) return false;
    var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    var want = norm(r.name), rows = card.querySelectorAll('tbody tr'), byName = null, byBoth = null;
    for (var i = 0; i < rows.length; i++) {
      var tds = rows[i].querySelectorAll('td'); if (tds.length < 3) continue;
      if (norm(tds[0].textContent).indexOf(want) === -1) continue;
      if (!byName) byName = rows[i];
      // The 3rd column is Overall; match it too so duplicate names resolve.
      if ((tds[2].textContent || '').replace(/\D/g, '') === String(r.score)) { byBoth = rows[i]; break; }
    }
    var target = byBoth || byName;
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }
  function setResumeInput(text) {
    var ta = document.querySelector('textarea[placeholder^="Paste resume text"]');
    if (!ta) return false;
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text || '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (_) { return false; }
  }
  function syncToCandidate(r) {
    if (!r) return;
    var curMode = localStorage.getItem('hrms_scoring_mode') || 'ai';
    proxyClickReact(r);
    setResumeInput(r.resumeText || '');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0, 0); }

    if (curMode === 'ai') {
      setTimeout(function () { showAIModal(r); }, 150);
    } else {
      var overlay = document.getElementById('hrms-ai-card-overlay');
      if (overlay) overlay.style.display = 'none';
      var targetCard = findMatchScoreCard();
      if (targetCard) {
        var children = targetCard.children;
        for (var k = 0; k < children.length; k++) {
          if (children[k] !== overlay) children[k].style.display = '';
        }
      }
    }
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  function toggleExportMenu(btn) {
    var ex = document.getElementById(ID.menu); if (ex) { ex.remove(); return; }
    var menu = document.createElement('div'); menu.id = ID.menu;
    menu.innerHTML = '<button data-x="csv">⭳ Download CSV (.csv)</button>';
    document.body.appendChild(menu);
    var rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.querySelector('[data-x="csv"]').addEventListener('click', function () { exportCsv(); menu.remove(); });
    setTimeout(function () { document.addEventListener('click', function h() { var m = document.getElementById(ID.menu); if (m) m.remove(); document.removeEventListener('click', h); }); }, 0);
  }
  function exportCsv() {
    var head = COLS.map(function (c) { return c.label; }).concat(['Skills', 'Missing']);
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var body = filtered().map(function (r) {
      return COLS.map(function (c) { return String(cellVal(r, c.key)); })
        .concat([(r.skills || []).join('; '), (r.missing || []).join('; ')]).map(q).join(',');
    });
    var csv = '﻿' + [head.map(q).join(',')].concat(body).join('\r\n');
    var b = new Blob([csv], { type: 'text/csv;charset=utf-8;' }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = 'candidate-comparison.csv'; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100);
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  function reactCard() {
    var titles = document.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || '').trim() === CARD_TITLE) {
        // Our own root also carries a .cc-title (not .card-title), so this only
        // ever matches the React card.
        return titles[i].closest('.card');
      }
    }
    return null;
  }

  function unmount() {
    var root = document.getElementById(ID.root); if (root) root.remove();
    closePopups(); closeDrawer(); closeModal();
    var optWrap = document.getElementById('hrms-scoring-options'); if (optWrap) optWrap.remove();
    // Restore any hidden buttons or cards
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || '').indexOf('Score Resume') !== -1) buttons[i].style.display = '';
    }
    var targetCard = findMatchScoreCard();
    if (targetCard) {
      var overlay = document.getElementById('hrms-ai-card-overlay');
      if (overlay) overlay.remove();
      var children = targetCard.children;
      for (var k = 0; k < children.length; k++) children[k].style.display = '';
    }
    document.querySelectorAll('[data-cc-hidden]').forEach(function (c) { c.style.display = ''; c.removeAttribute('data-cc-hidden'); });
  }

  function ensureAIButtons() {
    if (!onPage()) return;
    var existing = document.getElementById('hrms-scoring-options');
    if (existing) return;

    var buttons = document.querySelectorAll('button');
    var scoreBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      var t = (buttons[i].textContent || '').trim();
      if (t.indexOf('Score Resume') !== -1 || t.indexOf('Scoring…') !== -1) {
        scoreBtn = buttons[i];
        break;
      }
    }
    if (!scoreBtn || !scoreBtn.parentNode) return;

    scoreBtn.style.display = 'none';

    var curMode = localStorage.getItem('hrms_scoring_mode') || 'ai';

    var optWrap = document.createElement('div');
    optWrap.id = 'hrms-scoring-options';
    optWrap.className = 'cc-toggle-wrap';
    optWrap.innerHTML =
      '<button id="hrms-toggle-std" class="cc-toggle-tab std ' + (curMode === 'std' ? 'active' : '') + '" title="Standard keyword and rule-based matching">' +
        '✦ Score Resume' +
      '</button>' +
      '<button id="hrms-toggle-ai" class="cc-toggle-tab ai ' + (curMode === 'ai' ? 'active' : '') + '" title="Deep semantic evaluation with Claude AI">' +
        '✦ AI Deep Score' +
      '</button>';

    var stdBtn = optWrap.querySelector('#hrms-toggle-std');
    var aiBtn = optWrap.querySelector('#hrms-toggle-ai');

    function setMode(mode) {
      curMode = mode;
      localStorage.setItem('hrms_scoring_mode', mode);
      if (mode === 'std') {
        stdBtn.classList.add('active');
        aiBtn.classList.remove('active');
      } else {
        aiBtn.classList.add('active');
        stdBtn.classList.remove('active');
      }
    }

    stdBtn.addEventListener('click', function (e) {
      e.preventDefault();
      setMode('std');
      var targetCard = findMatchScoreCard();
      if (targetCard) {
        var overlay = document.getElementById('hrms-ai-card-overlay');
        if (overlay) overlay.style.display = 'none';
        var children = targetCard.children;
        for (var k = 0; k < children.length; k++) {
          if (children[k] !== overlay) children[k].style.display = '';
        }
      }
      scoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    aiBtn.addEventListener('click', function (e) {
      e.preventDefault();
      setMode('ai');
      showAIModal();
    });

    // Handle file upload and textarea changes while preserving user's chosen mode
    function extractAndScoreFile(file) {
      if (!file) return;
      var fileName = file.name || 'resume.pdf';

      // Handle Bulk ZIP archives
      if (/\.zip$/i.test(fileName) || (file.type && file.type.indexOf('zip') !== -1)) {
        var mode = localStorage.getItem('hrms_scoring_mode') || 'ai';
        if (mode === 'ai') {
          // Poll until bulk upload finishes parsing the first candidate and trigger AI evaluation
          var zipAttempts = 0;
          var zipInterval = setInterval(function () {
            zipAttempts++;
            var tc = findMatchScoreCard();
            var targetText = tc ? (tc.textContent || '') : '';
            if (targetText && (targetText.indexOf('Uploaded') !== -1 || targetText.indexOf('/ 100') !== -1 || targetText.indexOf('/100') !== -1 || zipAttempts >= 20)) {
              clearInterval(zipInterval);
              showAIModal();
            }
          }, 350);
        } else {
          var ov = document.getElementById('hrms-ai-card-overlay');
          if (ov) ov.style.display = 'none';
          var tc = findMatchScoreCard();
          if (tc) {
            var ch = tc.children;
            for (var k = 0; k < ch.length; k++) {
              if (ch[k] !== ov) ch[k].style.display = '';
            }
          }
        }
        return;
      }

      var jdEl = document.querySelector('textarea[placeholder*="Job Description"], textarea[placeholder*="job description"]') || document.querySelectorAll('textarea')[0];
      var jdText = jdEl ? jdEl.value : '';

      // Show loading pulse on right card and hide all other elements
      var targetCard = findMatchScoreCard();
      if (targetCard) {
        var overlay = document.getElementById('hrms-ai-card-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'hrms-ai-card-overlay';
          targetCard.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        overlay.style.width = '100%';
        overlay.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:360px;width:100%;text-align:center;margin:auto" class="cc-ai-pulse">' +
            '<div style="font-size:42px;margin-bottom:14px;color:#8b5cf6">✦</div>' +
            '<div style="font-weight:700;font-size:16px;color:var(--text)">Analyzing Uploaded Resume…</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:6px">Evaluating candidate profile with Claude AI</div>' +
          '</div>';

        var children = targetCard.children;
        for (var k = 0; k < children.length; k++) {
          if (children[k] !== overlay) children[k].style.display = 'none';
        }
      }

      // If text file
      if (/\.(txt|md|json|csv|rtf)$/i.test(fileName)) {
        var reader = new FileReader();
        reader.onload = function (e) {
          var txt = e.target.result || '';
          if (txt) {
            setResumeInput(txt);
            showAIModal({ resumeText: txt, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, '') });
          }
        };
        reader.readAsText(file);
        return;
      }

      // If PDF and pdfjs is on page
      if (/\.pdf$/i.test(fileName) && window.pdfjsLib) {
        var pdfReader = new FileReader();
        pdfReader.onload = function (e) {
          var typedarray = new Uint8Array(e.target.result);
          window.pdfjsLib.getDocument(typedarray).promise.then(function (pdf) {
            var maxPages = Math.min(pdf.numPages, 10);
            var pages = [];
            var done = 0;
            for (var p = 1; p <= maxPages; p++) {
              (function (pageNo) {
                pdf.getPage(pageNo).then(function (page) {
                  page.getTextContent().then(function (tc) {
                    pages[pageNo - 1] = tc.items.map(function (item) { return item.str; }).join(' ');
                    done++;
                    if (done === maxPages) {
                      var fullText = pages.join('\n\n').trim();
                      if (fullText) {
                        setResumeInput(fullText);
                        showAIModal({ resumeText: fullText, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, '') });
                      }
                    }
                  });
                });
              })(p);
            }
          }).catch(function () { /* fallback to polling */ });
        };
        pdfReader.readAsArrayBuffer(file);
      }

      // Poll textarea for React's own parser output
      var attempts = 0;
      var checkInterval = setInterval(function () {
        attempts++;
        var textareas = document.querySelectorAll('textarea');
        var resumeText = textareas.length >= 2 ? (textareas[1].value || '').trim() : (textareas.length === 1 ? (textareas[0].value || '').trim() : '');
        if (resumeText) {
          clearInterval(checkInterval);
          showAIModal({ resumeText: resumeText, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, '') });
        } else if (attempts >= 25) {
          clearInterval(checkInterval);
        }
      }, 250);
    }

    var allFileInputs = document.querySelectorAll('input[type="file"]');
    for (var f = 0; f < allFileInputs.length; f++) {
      if (!allFileInputs[f].__aiResetBound) {
        allFileInputs[f].__aiResetBound = true;
        (function (inp) {
          inp.addEventListener('change', function () {
            var mode = localStorage.getItem('hrms_scoring_mode') || 'ai';
            if (inp.files && inp.files[0]) {
              var isZip = /\.zip$/i.test(inp.files[0].name || '') || (inp.files[0].type && inp.files[0].type.indexOf('zip') !== -1);
              if (isZip) {
                var ov = document.getElementById('hrms-ai-card-overlay');
                if (ov) ov.style.display = 'none';
                var tc = findMatchScoreCard();
                if (tc) {
                  var ch = tc.children;
                  for (var k = 0; k < ch.length; k++) {
                    if (ch[k] !== ov) ch[k].style.display = '';
                  }
                }
                return;
              }
              if (mode === 'ai') {
                extractAndScoreFile(inp.files[0]);
              }
            } else if (mode === 'std') {
              var ov = document.getElementById('hrms-ai-card-overlay');
              if (ov) ov.style.display = 'none';
              var tc = findMatchScoreCard();
              if (tc) {
                var ch = tc.children;
                for (var k = 0; k < ch.length; k++) {
                  if (ch[k] !== ov) ch[k].style.display = '';
                }
              }
            }
          });
        })(allFileInputs[f]);
      }
    }

    if (scoreBtn.nextSibling) {
      scoreBtn.parentNode.insertBefore(optWrap, scoreBtn.nextSibling);
    } else {
      scoreBtn.parentNode.appendChild(optWrap);
    }
  }

  function ensureLayout() {
    if (!onPage()) { if (document.getElementById(ID.root)) unmount(); return; }
    ensureAIButtons();
    var card = reactCard(); if (!card) return;             // no candidates yet → leave page as-is
    ensureStyle();

    // Hide the React card and, if the candidate set changed, refresh our data.
    var count = card.querySelectorAll('tbody tr').length;
    card.style.display = 'none'; card.setAttribute('data-cc-hidden', '1');

    var root = document.getElementById(ID.root), fresh = false;
    if (!root) { root = buildRoot(); fresh = true; }
    if (root.previousElementSibling !== card && card.parentNode) card.parentNode.insertBefore(root, card.nextSibling);

    if (fresh) { renderTable(); loadData(); state.reactCount = count; }
    else if (count !== state.reactCount) { state.reactCount = count; loadData(); }
  }

  /* ── capture the uploaded file & attach it to the save request ────────────
     The React scorer extracts text and never keeps the file bytes, so the
     save request carries only fileName. We read the file the moment it is
     selected, keep it keyed by name, and splice its base64 into the matching
     POST /api/resume-scores body — so the real PDF/DOCX reaches the server. */
  // name -> Promise<{data, mime}|null>. Storing the PROMISE (not the resolved
  // value) lets the POST interceptor AWAIT an in-flight read, so a fast upload
  // that fires the save before the file finishes reading still gets its bytes —
  // the earlier version stored only the resolved value and lost that race.
  var fileStash = {};
  function readFileB64(file) {
    return new Promise(function (res) {
      var rd = new FileReader();
      rd.onload = function () { var s = String(rd.result || ''); var i = s.indexOf(','); res(i >= 0 ? s.slice(i + 1) : s); };
      rd.onerror = function () { res(''); };
      rd.readAsDataURL(file);
    });
  }
  function onFileChange(e) {
    if (!onPage()) return;                       // only the resume-scoring page uploads here
    var inp = e.target;
    if (!inp || inp.type !== 'file' || !inp.files || !inp.files.length) return;
    Array.prototype.forEach.call(inp.files, function (file) {
      var mime = file.type || 'application/octet-stream';
      fileStash[file.name] = readFileB64(file).then(function (b64) { return b64 ? { data: b64, mime: mime } : null; });
    });
  }
  // Inject fileData/fileMime for any item whose fileName matches a captured
  // file, AWAITING the read if it is still in flight. Matching strictly by name
  // means a pasted resume (no fileName) is never given a stale file. Handles
  // both single and bulk (array) payloads. Returns a Promise<bodyString>.
  function injectFileData(bodyStr) {
    var data; try { data = JSON.parse(bodyStr); } catch (_) { return Promise.resolve(bodyStr); }
    var items = Array.isArray(data) ? data : [data], touched = false;
    var waits = items.map(function (o) {
      if (!o || typeof o !== 'object' || o.fileData || !o.fileName) return null;
      var p = fileStash[o.fileName];
      if (!p) return null;
      return p.then(function (f) { if (f) { o.fileData = f.data; o.fileMime = f.mime; touched = true; } });
    }).filter(Boolean);
    return Promise.all(waits).then(function () { return touched ? JSON.stringify(data) : bodyStr; });
  }
  function initInterceptors() {
    document.addEventListener('change', onFileChange, true);   // capture phase, before React's handler
    if (window.__ccFetchPatched || !window.fetch) return;
    window.__ccFetchPatched = true;
    var orig = window.fetch;                                    // already auth-patched by hrms-actor.js
    window.fetch = function (input, init) {
      var url = '', method = 'GET';
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
        method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (_) {}
      if (method === 'POST' && /\/api\/resume-scores(?:\?|$)/.test(url.split('#')[0]) && init && typeof init.body === 'string') {
        return injectFileData(init.body).then(function (nb) {
          var ni = init;
          if (nb !== init.body) { ni = {}; for (var k in init) ni[k] = init[k]; ni.body = nb; }
          return orig.call(window, input, ni);
        });
      }
      return orig.call(this, input, init);
    };
  }

  function start() {
    initInterceptors();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; ensureLayout(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { setTimeout(ensureLayout, 60); });
    ensureLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
