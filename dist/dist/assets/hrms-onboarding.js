/**
 * hrms-onboarding.js  v1
 * Work Authorization & Employee Onboarding module.
 *
 * Same no-rebuild injection pattern as hrms-jobs-table.js / hrms-attendance.js:
 * the React bundle cannot be rebuilt, so this renders its own DOM into `.main`
 * (hiding React's `.content`, which would otherwise show a blank/404 view for
 * these routes) and is kept mounted by a MutationObserver.
 *
 * The sidebar entries live in hrms-perms.js (NAV_INJECT + ROUTE_PERMS) so that
 * per-role hiding and the access guard are driven by the same single source of
 * truth as every other module.
 *
 * Pages, all under /onboarding:
 *   /                Dashboard — cards, donut charts, alerts, recent activity
 *   /candidates      The data grid: search, filter, sort, paginate, export
 *   /work-auth       Candidates scoped to the work-authorization stage
 *   /documents       ...to documents
 *   /verification    ...to HR verification
 *   /assets          ...to IT asset allocation
 *   /payroll         ...to payroll
 *   /settings        Module configuration (read-only)
 *
 * Every stage page reuses ONE grid and ONE detail drawer, opened on the tab for
 * that stage — the alternative was seven near-identical page implementations.
 *
 * Theme-aware via the app's CSS custom properties (--bg/--text/--border/...),
 * so dark mode works with no extra code.
 */
(function () {
  'use strict';

  var BASE = '/onboarding';
  var ID = {
    root: 'hrms-ob-root', style: 'hrms-ob-style', drawer: 'hrms-ob-drawer',
    modal: 'hrms-ob-modal', menu: 'hrms-ob-exportmenu',
  };

  /* Mirrors the server's ONBOARDING_STAGES / AUTH_TYPES / AUTH_STATUSES. Kept
     in sync by hand: the server rejects anything it does not recognise, so a
     drift here surfaces as a 400 rather than as bad data. (The work-auth FIELDS
     used to be mirrored too; they are admin-built and fetched now.) */
  var STAGES = [
    ['candidate_created', 'Candidate Created'],
    ['work_authorization', 'Work Authorization'],
    ['documents', 'Documents'],
    ['hr_verification', 'HR Verification'],
    ['manager_approval', 'Manager Approval'],
    ['it_assets', 'IT Assets'],
    ['payroll', 'Payroll'],
    ['activated', 'Employee Activated'],
  ];

  /* The per-visa-type fields used to live here as a constant mirroring the
     server's. They are now admin-built and served by
     /onboarding/work-auth-type-field-config, so there is nothing to keep in
     sync — the tab renders whatever the schema says.

     WA_CORE_FALLBACK is only used if the schema call fails: the tab still needs
     a type dropdown to be usable at all. It mirrors WORK_AUTH_CORE_FIELDS. */
  var WA_CORE_FALLBACK = [
    { key: 'authType', label: 'Work Authorization Type', type: 'select', required: true, width: 'half', core: true },
    { key: 'status', label: 'Status', type: 'select', width: 'half', core: true },
    { key: 'expiryDate', label: 'Expiry Date', type: 'date', width: 'half', core: true },
    { key: 'receiptNumber', label: 'Receipt / Case Number', type: 'text', width: 'half', core: true },
    { key: 'sponsorshipRequired', label: 'Sponsorship required', type: 'checkbox', width: 'full', core: true },
  ];
  var AUTH_TYPES = ['F1', 'H1B', 'GC EAD', 'US Citizen', 'H4 EAD', 'Other'];
  var AUTH_STATUSES = ['Active', 'Pending', 'Expired', 'Extension Filed', 'Transferred', 'Rejected'];
  var CAND_STATUSES = ['Draft', 'Pending Verification', 'Pending Approval', 'Approved', 'Rejected', 'Onboarded'];
  var DOC_TYPES = [['ssn', 'SSN', 1], ['driver_license', 'Driver License', 0],
                   ['state_id', 'State ID', 0], ['visa', 'Visa (Work Authorization)', 0],
                   ['i94', 'I-94', 0]];
  /* Sentinel for the doc-type dropdown: not a real docType, it tells the upload
     handler to send {isCustom, label} and let the server derive the type. */
  var CUSTOM_DOC_VALUE = '__custom__';
  var MAX_DOC_LABEL = 120;   // mirrors MAX_CUSTOM_DOC_LABEL server-side
  var EVERSOFT_ASSETS = ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'Dock', 'Bag', 'Headset','Office365','Email_ID','Software License','ID_Card','Desktop','Mobile'];
  var ASSET_STATUSES = ['Assigned', 'Returned', 'Lost', 'Damaged','pending', 'Delivered'];
  var MAX_MB = 10;
  var ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];
  var PAGE_SIZES = [10, 25, 50, 100];

  /* Which drawer tab each sidebar page lands on. */
  var PAGE_TAB = {
    '/candidates': 'overview', '/work-auth': 'workauth', '/documents': 'documents',
    '/verification': 'verification', '/assets': 'assets', '/payroll': 'payroll',
  };

  var state = {
    page: '', rows: [], total: 0, pg: 1, pageSize: 25, search: '', loading: false,
    filters: { status: '', authType: '' }, sortKey: 'createdAt', sortDir: -1,
    dash: null, alerts: [], detail: null, tab: 'overview',
    list: [], stageErr: '',   // stage pages (work-auth, documents, …)
    fieldDefs: null,          // cached custom-field schema (labels for display)
  };

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sessionEmail() {
    try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email) || ''; }
    catch (_) { return ''; }
  }
  function can(code) { return window.__hrmsCan ? window.__hrmsCan(code) : true; }

  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    var hdrs = { 'Content-Type': 'application/json' };
    var em = sessionEmail();
    if (em) hdrs['X-User-Email'] = em;   // the server's only identity signal
    opts.headers = Object.assign(hdrs, opts.headers || {});
    return fetch('/api' + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  function toast(msg, type) {
    var el = document.getElementById('hrms-ob-toast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'hrms-ob-toast';
    el.className = 'ob-toast ' + (type === 'error' ? 'err' : type === 'warn' ? 'warn' : 'ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; }, 3200);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3700);
  }

  function fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; }
  function fmtDateTime(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : '—'; }
  function stageLabel(k) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i][0] === k) return STAGES[i][1];
    return k;
  }
  function badge(text, kind) {
    return '<span class="ob-badge ' + (kind || 'neutral') + '">' + esc(text) + '</span>';
  }
  function statusKind(s) {
    s = String(s || '').toLowerCase();
    if (s === 'completed' || s === 'approved' || s === 'onboarded' || s === 'active') return 'ok';
    if (s === 'rejected' || s === 'expired' || s === 'lost' || s === 'damaged') return 'err';
    if (s === 'in progress' || s.indexOf('pending') === 0 || s === 'extension filed') return 'warn';
    return 'neutral';
  }

  /* Days until a work authorization expires; null when there is no expiry. */
  function daysTo(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + 'T00:00:00'), now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((d - now) / 86400000);
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var st = document.createElement('style');
    st.id = ID.style;
    st.textContent = [
      '#' + ID.root + '{padding:24px;flex:1;overflow-y:auto;color:var(--text,#e6edf7);font-size:14px}',
      '.ob-h{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}',
      '.ob-h h2{margin:0;font-size:20px;font-weight:700;flex:1}',
      '.ob-sub{color:var(--muted,#8a9bb8);font-size:13px;margin:-10px 0 18px}',
      '.ob-btn{background:var(--bg3,#1c2433);color:var(--text,#e6edf7);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.ob-btn:hover{border-color:var(--accent,#4f8ef7)}',
      '.ob-btn.primary{background:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);color:#fff}',
      '.ob-btn.danger{background:#ef4444;border-color:#ef4444;color:#fff}',
      '.ob-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.ob-in,.ob-sel,.ob-ta{background:var(--bg2,#141b26);color:var(--text,#e6edf7);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;width:100%;box-sizing:border-box}',
      '.ob-in:focus,.ob-sel:focus,.ob-ta:focus{outline:none;border-color:var(--accent,#4f8ef7)}',
      '.ob-ta{min-height:70px;resize:vertical}',
      '.ob-search{max-width:280px}',
      /* cards */
      '.ob-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin-bottom:22px}',
      '.ob-card{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:12px;padding:16px}',
      '.ob-card .n{font-size:26px;font-weight:800;line-height:1.1}',
      '.ob-card .l{color:var(--muted,#8a9bb8);font-size:12px;margin-top:6px}',
      '.ob-card.alert .n{color:#f59e0b}',
      '.ob-card.bad .n{color:#ef4444}',
      /* panels */
      '.ob-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:22px}',
      '.ob-panel{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:12px;padding:16px}',
      '.ob-panel h3{margin:0 0 14px;font-size:14px;font-weight:700}',
      '.ob-legend{display:flex;flex-direction:column;gap:6px;font-size:12px}',
      '.ob-legend div{display:flex;align-items:center;gap:7px}',
      '.ob-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}',
      '.ob-legend .v{margin-left:auto;font-weight:700}',
      '.ob-chart{display:flex;align-items:center;gap:18px}',
      /* table */
      '.ob-wrap{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:12px;overflow:auto}',
      '.ob-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.ob-table th{text-align:left;padding:11px 14px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--muted,#8a9bb8);border-bottom:1px solid var(--border,#2a3446);white-space:nowrap;cursor:pointer;user-select:none}',
      '.ob-table td{padding:11px 14px;border-bottom:1px solid var(--border2,#1d2634);white-space:nowrap}',
      '.ob-table tbody tr{cursor:pointer}',
      '.ob-table tbody tr:hover{background:var(--bg3,#1c2433)}',
      '.ob-table tbody tr:last-child td{border-bottom:none}',
      '.ob-empty{padding:44px;text-align:center;color:var(--muted,#8a9bb8)}',
      '.ob-empty .big{font-size:32px;margin-bottom:10px;opacity:.5}',
      '.ob-skel{height:14px;border-radius:5px;background:linear-gradient(90deg,var(--bg3,#1c2433) 25%,var(--border,#2a3446) 50%,var(--bg3,#1c2433) 75%);',
      'background-size:200% 100%;animation:obsk 1.2s infinite}',
      '@keyframes obsk{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      /* badges */
      '.ob-badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}',
      '.ob-badge.ok{background:rgba(34,197,94,.15);color:#22c55e}',
      '.ob-badge.warn{background:rgba(245,158,11,.15);color:#f59e0b}',
      '.ob-badge.err{background:rgba(239,68,68,.15);color:#ef4444}',
      '.ob-badge.neutral{background:var(--bg3,#1c2433);color:var(--muted,#8a9bb8)}',
      /* pagination */
      '.ob-pg{display:flex;align-items:center;gap:10px;padding:12px 2px;font-size:12px;color:var(--muted,#8a9bb8)}',
      '.ob-pg .sp{flex:1}',
      /* drawer */
      '.ob-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;justify-content:flex-end}',
      '.ob-dw{width:min(760px,100%);background:var(--bg,#0d131c);border-left:1px solid var(--border,#2a3446);',
      'display:flex;flex-direction:column;height:100%;box-shadow:-8px 0 32px rgba(0,0,0,.4)}',
      '.ob-dw-h{padding:18px 22px;border-bottom:1px solid var(--border,#2a3446);display:flex;align-items:center;gap:12px}',
      '.ob-dw-h h3{margin:0;font-size:17px;font-weight:700;flex:1}',
      '.ob-x{background:none;border:none;color:var(--muted,#8a9bb8);font-size:24px;cursor:pointer;line-height:1;padding:0 4px}',
      '.ob-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--border,#2a3446);overflow-x:auto}',
      '.ob-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--muted,#8a9bb8);',
      'padding:11px 12px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit}',
      '.ob-tab.on{color:var(--accent,#4f8ef7);border-bottom-color:var(--accent,#4f8ef7)}',
      '.ob-dw-b{padding:22px;overflow-y:auto;flex:1}',
      /* forms */
      '.ob-f{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '.ob-f .full{grid-column:1/-1}',
      '.ob-lb{display:block;font-size:12px;color:var(--muted,#8a9bb8);margin-bottom:5px;font-weight:600}',
      '.ob-lb .req{color:#ef4444}',
      '.ob-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border2,#1d2634);gap:12px}',
      '.ob-row:last-child{border-bottom:none}',
      '.ob-row .k{color:var(--muted,#8a9bb8);font-size:12px}',
      '.ob-row .v{font-weight:600;text-align:right;word-break:break-word}',
      '.ob-act{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}',
      '.ob-chk{display:flex;align-items:center;gap:9px;padding:9px 0;font-size:13px;cursor:pointer}',
      '.ob-chk input{width:16px;height:16px;accent-color:var(--accent,#4f8ef7);cursor:pointer}',
      '.ob-err{color:#ef4444;font-size:12px;margin-top:10px;min-height:16px}',
      /* stage rail */
      '.ob-rail{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:20px}',
      /* dropzone */
      '.ob-dz{border:2px dashed var(--border,#2a3446);border-radius:12px;padding:28px;text-align:center;',
      'color:var(--muted,#8a9bb8);cursor:pointer;transition:.15s;margin-bottom:8px}',
      '.ob-dz:hover,.ob-dz.over{border-color:var(--accent,#4f8ef7);background:var(--bg2,#141b26)}',
      '.ob-dz .big{font-size:28px;margin-bottom:8px}',
      '.ob-bar{height:4px;border-radius:3px;background:var(--bg3,#1c2433);overflow:hidden;margin-top:10px}',
      '.ob-bar i{display:block;height:100%;background:var(--accent,#4f8ef7);width:0;transition:width .2s}',
      /* timeline */
      '.ob-tl{position:relative;padding-left:22px}',
      '.ob-tl:before{content:"";position:absolute;left:5px;top:5px;bottom:5px;width:2px;background:var(--border,#2a3446)}',
      '.ob-tl-i{position:relative;padding-bottom:18px}',
      '.ob-tl-i:before{content:"";position:absolute;left:-21px;top:4px;width:10px;height:10px;border-radius:50%;',
      'background:var(--accent,#4f8ef7);border:2px solid var(--bg,#0d131c)}',
      '.ob-tl-i .e{font-weight:700;font-size:13px}',
      '.ob-tl-i .m{color:var(--muted,#8a9bb8);font-size:12px;margin-top:3px}',
      /* alerts */
      '.ob-al{display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid var(--border2,#1d2634);font-size:13px}',
      '.ob-al:last-child{border-bottom:none}',
      '.ob-al .ic{font-size:15px}',
      '.ob-al .who{font-weight:600}',
      '.ob-al .when{margin-left:auto;color:var(--muted,#8a9bb8);font-size:12px;white-space:nowrap}',
      /* toast + menu */
      '.ob-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;padding:12px 22px;',
      'border-radius:10px;font-size:14px;font-weight:600;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.25);transition:opacity .4s}',
      '.ob-toast.ok{background:#22c55e}.ob-toast.err{background:#ef4444}.ob-toast.warn{background:#f59e0b}',
      '.ob-menu{position:absolute;top:calc(100% + 5px);right:0;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:9px;overflow:hidden;z-index:60;min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
      '.ob-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text,#e6edf7);',
      'padding:10px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.ob-menu button:hover{background:var(--bg3,#1c2433)}',
      '@media print{.sidebar,.topbar,.ob-h,.ob-pg{display:none!important}',
      '#' + ID.root + '{overflow:visible!important;padding:0!important;color:#000!important}',
      '.ob-wrap,.ob-panel,.ob-card{border-color:#ccc!important;background:#fff!important;color:#000!important}',
      '.ob-table td,.ob-table th{color:#000!important}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ── charts: hand-rolled SVG (no chart library is reachable without a bundler) */
  var PALETTE = ['#4f8ef7', '#a855f7', '#22c55e', '#f59e0b', '#ef4444', '#14b8a6', '#8a9bb8'];

  function donut(data) {
    var total = data.reduce(function (a, d) { return a + d.count; }, 0);
    if (!total) return '<div class="ob-empty" style="padding:26px">No data yet</div>';
    var R = 52, r = 32, cx = 60, cy = 60, a0 = -Math.PI / 2, segs = '';
    data.forEach(function (d, i) {
      var frac = d.count / total, a1 = a0 + frac * Math.PI * 2;
      // A single 100% slice cannot be drawn as an arc (start == end), so render
      // it as two rings instead of a degenerate path.
      if (frac >= 0.9999) {
        segs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' +
                PALETTE[i % PALETTE.length] + '" stroke-width="' + (R - r) + '"/>';
        return;
      }
      var big = frac > 0.5 ? 1 : 0;
      var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      var x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      var xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1);
      var xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
      segs += '<path d="M' + x0 + ' ' + y0 + ' A' + R + ' ' + R + ' 0 ' + big + ' 1 ' + x1 + ' ' + y1 +
              ' L' + xi1 + ' ' + yi1 + ' A' + r + ' ' + r + ' 0 ' + big + ' 0 ' + xi0 + ' ' + yi0 + ' Z" fill="' +
              PALETTE[i % PALETTE.length] + '"/>';
      a0 = a1;
    });
    var legend = data.map(function (d, i) {
      return '<div><span class="ob-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
             esc(d.label) + '<span class="v">' + d.count + '</span></div>';
    }).join('');
    return '<div class="ob-chart"><svg width="120" height="120" viewBox="0 0 120 120">' + segs +
           '<text x="60" y="58" text-anchor="middle" font-size="19" font-weight="700" fill="currentColor">' + total + '</text>' +
           '<text x="60" y="74" text-anchor="middle" font-size="9" fill="#8a9bb8">total</text></svg>' +
           '<div class="ob-legend" style="flex:1">' + legend + '</div></div>';
  }

  function bars(data) {
    var max = Math.max.apply(null, data.map(function (d) { return d.count; }).concat([1]));
    return '<div style="display:flex;align-items:flex-end;gap:10px;height:130px">' + data.map(function (d) {
      var h = Math.round((d.count / max) * 96);
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px">' +
             '<div style="font-size:11px;font-weight:700">' + d.count + '</div>' +
             '<div style="width:100%;height:' + Math.max(h, 2) + 'px;background:var(--accent,#4f8ef7);border-radius:5px 5px 0 0"></div>' +
             '<div style="font-size:10px;color:var(--muted,#8a9bb8)">' + esc(d.month.slice(5)) + '</div></div>';
    }).join('') + '</div>';
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function loadCandidates() {
    state.loading = true;
    render();
    var q = ['page=' + state.pg, 'pageSize=' + state.pageSize];
    if (state.search) q.push('search=' + encodeURIComponent(state.search));
    if (state.filters.status) q.push('status=' + encodeURIComponent(state.filters.status));
    if (state.filters.authType) q.push('authType=' + encodeURIComponent(state.filters.authType));
    api('/onboarding/candidates?' + q.join('&')).then(function (d) {
      state.rows = (d && d.items) || [];
      state.total = (d && d.total) || 0;
      state.loading = false;
      render();
    }).catch(function (e) {
      state.rows = []; state.loading = false; render();
      toast(e.message, 'error');
    });
  }

  function loadDashboard() {
    state.loading = true;
    render();
    Promise.all([api('/onboarding/dashboard'), api('/onboarding/alerts')])
      .then(function (r) {
        state.dash = r[0]; state.alerts = r[1] || []; state.loading = false; render();
      })
      .catch(function (e) { state.loading = false; render(); toast(e.message, 'error'); });
  }

  /* ── sorting (client-side, over the current page) ─────────────────────── */
  function sorted(rows) {
    var k = state.sortKey, dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (x == null) x = ''; if (y == null) y = '';
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }

  /* ── page: dashboard ──────────────────────────────────────────────────── */
  var CARDS = [
    ['totalCandidates', 'Total Candidates', ''],
    ['pendingVerification', 'Pending Verification', 'alert'],
    ['pendingApproval', 'Pending Approval', 'alert'],
    ['completedOnboarding', 'Completed Onboarding', ''],
    ['missingDocuments', 'Missing Documents', 'bad'],
    ['expiringWorkAuth', 'Expiring Work Auth', 'bad'],
    ['itAssetsPending', 'IT Assets Pending', 'alert'],
    ['payrollPending', 'Payroll Pending', 'alert'],
  ];

  function viewDashboard() {
    if (state.loading || !state.dash) {
      return '<div class="ob-cards">' + CARDS.map(function () {
        return '<div class="ob-card"><div class="ob-skel" style="width:44px;height:26px"></div>' +
               '<div class="ob-skel" style="width:80%;margin-top:10px"></div></div>';
      }).join('') + '</div>';
    }
    var d = state.dash;
    var cards = CARDS.map(function (c) {
      var n = d.cards[c[0]] || 0;
      return '<div class="ob-card ' + (n && c[2] ? c[2] : '') + '"><div class="n">' + n + '</div>' +
             '<div class="l">' + c[1] + '</div></div>';
    }).join('');

    var alerts = state.alerts.length
      ? state.alerts.slice(0, 8).map(function (a) {
          var ic = a.severity === 'error' ? '🔴' : '⚠️';
          return '<div class="ob-al" data-cid="' + a.candidateId + '" style="cursor:pointer">' +
                 '<span class="ic">' + ic + '</span><span class="who">' + esc(a.candidate || '—') + '</span>' +
                 '<span>' + esc(a.message) + '</span>' +
                 '<span class="when">' + (a.date ? fmtDate(a.date) : '') + '</span></div>';
        }).join('')
      : '<div class="ob-empty" style="padding:26px">Nothing needs attention 🎉</div>';

    return '<div class="ob-cards">' + cards + '</div>' +
      '<div class="ob-grid2">' +
        '<div class="ob-panel"><h3>Work Authorization Distribution</h3>' + donut(d.charts.workAuthDistribution) + '</div>' +
        '<div class="ob-panel"><h3>Candidate Status</h3>' + donut(d.charts.candidateStatus) + '</div>' +
        '<div class="ob-panel"><h3>Onboarding Progress</h3>' + donut(d.charts.onboardingProgress) + '</div>' +
      '</div>' +
      '<div class="ob-grid2">' +
        '<div class="ob-panel"><h3>Monthly Onboarded Employees</h3>' + bars(d.charts.monthlyOnboarded) + '</div>' +
        '<div class="ob-panel"><h3>Alerts &amp; Notifications</h3>' + alerts + '</div>' +
      '</div>' +
      '<div class="ob-grid2">' +
        '<div class="ob-panel"><h3>Recently Added Candidates</h3>' + miniList(d.recent.candidates, function (c) {
          return [esc(c.name || c.email), badge(c.status, statusKind(c.status))];
        }) + '</div>' +
        '<div class="ob-panel"><h3>Recently Uploaded Documents</h3>' + miniList(d.recent.documents, function (x) {
          return [esc(x.fileName || x.docType), '<span style="color:var(--muted,#8a9bb8);font-size:12px">v' + x.version + '</span>'];
        }) + '</div>' +
        '<div class="ob-panel"><h3>Recently Approved</h3>' + miniList(d.recent.approvals, function (x) {
          return [esc(x.approver || '—'), '<span style="color:var(--muted,#8a9bb8);font-size:12px">' + fmtDateTime(x.actedAt) + '</span>'];
        }) + '</div>' +
      '</div>';
  }

  function miniList(rows, fn) {
    if (!rows || !rows.length) return '<div class="ob-empty" style="padding:22px">Nothing yet</div>';
    return rows.map(function (r) {
      var p = fn(r);
      return '<div class="ob-al">' + p[0] + '<span class="when">' + p[1] + '</span></div>';
    }).join('');
  }

  /* ── page: candidate grid ─────────────────────────────────────────────── */
  var COLS = [
    ['name', 'Candidate'], ['email', 'Email'], ['jobTitle', 'Job Title'],
    ['department', 'Department'], ['client', 'Client'], ['authType', 'Work Auth'],
    ['authExpiryDate', 'Expiry'], ['status', 'Status'], ['joiningDate', 'Joining'],
  ];

  function cell(row, key) {
    if (key === 'status') return badge(row.status, statusKind(row.status));
    if (key === 'authType') return row.authType ? badge(row.authType, 'neutral') : '—';
    if (key === 'authExpiryDate') {
      if (!row.authExpiryDate) return '—';
      var d = daysTo(row.authExpiryDate);
      // Surface an imminent expiry right in the grid — this is the number the
      // whole module exists to keep an eye on.
      var kind = d < 0 ? 'err' : d <= 60 ? 'warn' : 'neutral';
      var suffix = d < 0 ? ' (expired)' : d <= 60 ? ' (' + d + 'd)' : '';
      return badge(fmtDate(row.authExpiryDate) + suffix, kind);
    }
    if (key === 'joiningDate') return fmtDate(row.joiningDate);
    return esc(row[key] || '—');
  }

  function viewGrid() {
    var rows = sorted(state.rows);
    var body;
    if (state.loading) {
      body = new Array(6).join('x').split('x').map(function () {
        return '<tr>' + COLS.map(function () { return '<td><div class="ob-skel"></div></td>'; }).join('') + '</tr>';
      }).join('');
    } else if (!rows.length) {
      body = '<tr><td colspan="' + COLS.length + '"><div class="ob-empty"><div class="big">📋</div>' +
             (state.search || state.filters.status || state.filters.authType
               ? 'No candidates match these filters.'
               : 'No candidates yet. Add the first one to get started.') +
             '</div></td></tr>';
    } else {
      body = rows.map(function (r) {
        return '<tr data-id="' + r.id + '">' + COLS.map(function (c) {
          return '<td>' + cell(r, c[0]) + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }

    var head = COLS.map(function (c) {
      var arrow = state.sortKey === c[0] ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
    }).join('');

    var pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    var from = state.total ? (state.pg - 1) * state.pageSize + 1 : 0;
    var to = Math.min(state.pg * state.pageSize, state.total);

    return '<div class="ob-h">' +
        '<input class="ob-in ob-search" id="ob-search" placeholder="Search name, email, job title…" value="' + esc(state.search) + '">' +
        '<select class="ob-sel" id="ob-fstatus" style="width:auto">' +
          '<option value="">All statuses</option>' +
          CAND_STATUSES.map(function (s) {
            return '<option' + (state.filters.status === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select>' +
        '<select class="ob-sel" id="ob-fauth" style="width:auto">' +
          '<option value="">All work auth</option>' +
          AUTH_TYPES.map(function (s) {
            return '<option' + (state.filters.authType === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select>' +
        '<div style="position:relative"><button class="ob-btn" id="ob-export">⭳ Export ▾</button></div>' +
        (can('onboarding.create') ? '<button class="ob-btn primary" id="ob-new">+ New Candidate</button>' : '') +
      '</div>' +
      '<div class="ob-wrap"><table class="ob-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="ob-pg">' +
        '<span>' + from + '–' + to + ' of ' + state.total + '</span>' +
        '<select class="ob-sel" id="ob-psize" style="width:auto;padding:4px 8px">' +
          PAGE_SIZES.map(function (n) {
            return '<option' + (state.pageSize === n ? ' selected' : '') + '>' + n + '</option>';
          }).join('') + '</select>' +
        '<span class="sp"></span>' +
        '<button class="ob-btn" id="ob-prev"' + (state.pg <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
        '<span>Page ' + state.pg + ' / ' + pages + '</span>' +
        '<button class="ob-btn" id="ob-next"' + (state.pg >= pages ? ' disabled' : '') + '>Next ›</button>' +
      '</div>';
  }

  /* ── stage pages ──────────────────────────────────────────────────────────
     Each sidebar page shows the data IT is about — the documents page shows
     document coverage, the payroll page shows bank/tax status — rather than
     repeating the candidate roster with a different heading. Every row still
     opens the same detail drawer, on the tab for that stage.

     Each is one call to its own endpoint; search and sort run client-side over
     the returned rows.
  */
  function chip(on, label) {
    if (on) {
      return badge('✔ ' + label, 'ok');
    }
    return badge('⚠ —', 'err');
  }

  function getDocCell(row, type) {
    var doc = row.docs[type] || row.docs['custom_' + type];
    if (!doc) {
      // Find in row.docs by matching label case-insensitively
      var reqs = row.requestedDocs || [];
      var item = reqs.find(function (it) { return it.type === type; });
      if (item) {
        var labelLower = (item.label || '').toLowerCase();
        for (var k in row.docs) {
          if (row.docs[k] && row.docs[k].label && row.docs[k].label.toLowerCase() === labelLower) {
            doc = row.docs[k];
            break;
          }
        }
      }
    }
    if (doc) {
      var label = (type === 'ssn') ? 'v' + doc.version : 'Uploaded';
      return chip(doc, label);
    }
    var reqs = row.requestedDocs || [];
    var found = reqs.find(function(item) { return item.type === type; });
    if (found) {
      if (!found.sendToCandidate) {
        return badge('—', 'neutral');
      }
      return badge('⚠ —', 'err');
    }
    return badge('—', 'neutral');
  }


  var STAGE_PAGES = {
    '/work-auth': {
      url: '/onboarding/work-authorizations',
      tab: 'workauth',
      empty: 'No candidates yet.',
      cols: [
        ['candidate', 'Candidate'],
        ['email', 'Email'],
        ['authType', 'Type', function (r) {
          return r.authType ? badge(r.authType, 'neutral') : badge('Not set', 'warn');
        }],
        ['status', 'Status', function (r) {
          return r.status ? badge(r.status, statusKind(r.status)) : '—';
        }],
        ['expiryDate', 'Expiry', function (r) {
          if (!r.expiryDate) return '—';
          var d = r.daysToExpiry;
          var kind = d < 0 ? 'err' : d <= 60 ? 'warn' : 'ok';
          var sfx = d < 0 ? ' (expired)' : d <= 60 ? ' (' + d + 'd)' : '';
          return badge(r.expiryDate + sfx, kind);
        }],
        ['receiptNumber', 'Receipt / Case #'],
        ['sponsorshipRequired', 'Sponsorship', function (r) {
          return r.sponsorshipRequired ? badge('Required', 'warn') : badge('No', 'neutral');
        }],
      ],
    },
    '/documents': {
      url: '/onboarding/documents',
      tab: 'documents',
      empty: 'No candidates yet.',
      cols: [
        ['candidate', 'Candidate'],
        ['ssn', 'SSN', function (r) { return getDocCell(r, 'ssn'); }],
        ['driver_license', 'Driver License', function (r) { return getDocCell(r, 'driver_license'); }],
        ['state_id', 'State ID', function (r) { return getDocCell(r, 'state_id'); }],
        ['visa', 'Visa', function (r) { return getDocCell(r, 'visa'); }],
        ['i94', 'I-94', function (r) { return getDocCell(r, 'i94'); }],
        ['uploaded', 'Uploaded', function (r) { return (r.uploaded || 0) + ' / ' + (r.totalRequested || 5); }],
        ['missing', 'Missing', function (r) {
          return r.missing.length ? badge('⚠ ' + r.missing.join(', '), 'err') : badge('✔ Complete', 'ok');
        }],
      ],
    },
    '/verification': {
      url: '/onboarding/verifications',
      tab: 'verification',
      empty: 'Nothing awaiting verification.',
      cols: [
        ['candidate', 'Candidate'],
        ['status', 'Verification', function (r) { return badge(r.status, statusKind(r.status)); }],
        ['checked', 'Checklist', function (r) { return r.checked + ' / 5 checked'; }],
        ['missing', 'Blocking', function (r) {
          return r.missing.length ? badge('Missing: ' + r.missing.join(', '), 'err') : badge('Ready', 'ok');
        }],
        ['verifiedBy', 'Verified By'],
        ['verifiedAt', 'Verified At', function (r) { return fmtDateTime(r.verifiedAt); }],
      ],
    },
    '/assets': {
      url: '/onboarding/asset-allocations',
      tab: 'assets',
      empty: 'No allocations yet.',
      cols: [
        ['candidate', 'Candidate'],
        ['assetSource', 'Source', function (r) {
          return r.assetSource ? badge(r.assetSource, 'neutral') : '—';
        }],
        ['clientName', 'Client'],
        ['assets', 'Assets', function (r) { return esc((r.assets || []).join(', ') || '—'); }],
        ['assetId', 'Asset ID'],
        ['issuedDate', 'Issued', function (r) { return fmtDate(r.issuedDate); }],
        ['status', 'Status', function (r) {
          return badge(r.status, r.status === 'Not allocated' ? 'warn' : statusKind(r.status));
        }],
      ],
    },
    '/payroll': {
      url: '/onboarding/payroll',
      tab: 'payroll',
      empty: 'No candidates yet.',
      cols: [
        ['candidate', 'Candidate'],
        ['bankName', 'Bank'],
        ['accountNumberMasked', 'Account', function (r) {
          // Masked server-side; the raw number never reaches the browser.
          return r.accountNumberMasked ? '<code>' + esc(r.accountNumberMasked) + '</code>' : '—';
        }],
        ['routingNumber', 'Routing'],
        ['taxState', 'Tax State'],
        ['directDeposit', 'Direct Deposit', function (r) {
          return r.directDeposit ? badge('Yes', 'ok') : badge('No', 'neutral');
        }],
        ['status', 'Status', function (r) { return badge(r.status, statusKind(r.status)); }],
      ],
    },
  };

  function loadStage() {
    var spec = STAGE_PAGES[state.page];
    if (!spec) return;
    state.loading = true;
    state.stageErr = '';
    render();
    api(spec.url).then(function (rows) {
      state.list = rows || [];
      state.loading = false;

      if (state.page === '/documents') {
        var cols = [
          ['candidate', 'Candidate']
        ];
        var seenTypes = {};
        
        // Define standard columns
        var standard = [
          { type: 'ssn', label: 'SSN' },
          { type: 'driver_license', label: 'Driver License' },
          { type: 'state_id', label: 'State ID' },
          { type: 'visa', label: 'Visa' },
          { type: 'i94', label: 'I-94' }
        ];
        standard.forEach(function (std) {
          seenTypes[std.type] = true;
          cols.push([std.type, std.label, function (r) { return getDocCell(r, std.type); }]);
        });

        // Scan candidate rows for any custom/other document slots that were configured
        state.list.forEach(function (r) {
          var reqs = r.requestedDocs || [];
          reqs.forEach(function (item) {
            if (!seenTypes[item.type]) {
              seenTypes[item.type] = true;
              cols.push([item.type, item.label, function (row) { return getDocCell(row, item.type); }]);
            }
          });
        });

        // Append final aggregate columns
        cols.push(['uploaded', 'Uploaded', function (r) {
          return (r.uploaded || 0) + ' / ' + (r.totalRequested || 5);
        }]);
        cols.push(['missing', 'Missing', function (r) {
          return r.missing.length ? badge('⚠ ' + r.missing.join(', '), 'err') : badge('✔ Complete', 'ok');
        }]);

        spec.cols = cols;
      }

      render();
    }).catch(function (e) {
      state.list = [];
      state.loading = false;
      // A 403 here is the point of the payroll page, not a failure to hide.
      state.stageErr = e.message;
      render();
    });
  }

  function stageRows(spec) {
    var q = state.search.toLowerCase();
    var rows = state.list.filter(function (r) {
      if (!q) return true;
      return JSON.stringify(r).toLowerCase().indexOf(q) !== -1;
    });
    var k = state.sortKey, dir = state.sortDir;
    if (k && rows.length && (k in rows[0])) {
      rows = rows.slice().sort(function (a, b) {
        var x = a[k], y = b[k];
        if (x == null) x = ''; if (y == null) y = '';
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
      });
    }
    return rows;
  }

  function viewStage() {
    var spec = STAGE_PAGES[state.page];
    var rows = stageRows(spec);

    if (state.stageErr) {
      return '<div class="ob-wrap"><div class="ob-empty"><div class="big">🔒</div>' +
             esc(state.stageErr) + '</div></div>';
    }

    var head = spec.cols.map(function (c) {
      var arrow = state.sortKey === c[0] ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
    }).join('');

    var body;
    if (state.loading) {
      body = new Array(6).join('x').split('x').map(function () {
        return '<tr>' + spec.cols.map(function () { return '<td><div class="ob-skel"></div></td>'; }).join('') + '</tr>';
      }).join('');
    } else if (!rows.length) {
      body = '<tr><td colspan="' + spec.cols.length + '"><div class="ob-empty">' +
             '<div class="big">📋</div>' + (state.search ? 'Nothing matches your search.' : spec.empty) +
             '</div></td></tr>';
    } else {
      body = rows.map(function (r) {
        return '<tr data-id="' + r.candidateId + '">' + spec.cols.map(function (c) {
          return '<td>' + (c[2] ? c[2](r) : esc(r[c[0]] || '—')) + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }

    return '<div class="ob-h">' +
        '<input class="ob-in ob-search" id="ob-search" placeholder="Search…" value="' + esc(state.search) + '">' +
        '<div style="position:relative"><button class="ob-btn" id="ob-export">⭳ Export ▾</button></div>' +
      '</div>' +
      '<div class="ob-wrap"><table class="ob-table"><thead><tr>' + head + '</tr></thead><tbody>' +
      body + '</tbody></table></div>' +
      '<div class="ob-pg"><span>' + rows.length + ' row(s)</span></div>';
  }

  /* ── page: settings ───────────────────────────────────────────────────── */
  function viewSettings() {
    function rows(list) {
      return list.map(function (r) {
        return '<div class="ob-row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
      }).join('');
    }

    // Candidate-form panel — its own async load, rendered into a placeholder.
    if (can('onboarding.settings')) {
      api('/onboarding/field-config').then(function (cfg) {
        var box = document.getElementById('ob-cf-panel');
        if (!box) return;
        var sections = (cfg && cfg.sections) || [];
        var count = flattenSections(sections).length;
        box.innerHTML =
          '<h3>New Candidate Form <button class="ob-btn" id="ob-cf-edit" style="float:right;padding:4px 10px">⚙ Open Builder</button></h3>' +
          (count
            ? sections.map(function (s) {
                return '<div class="ob-row"><span class="k" style="font-weight:600">' + esc(s.title || 'Section') + '</span>' +
                  '<span class="v">' + (s.fields || []).length + ' field(s)</span></div>' +
                  (s.fields || []).map(function (f) {
                    return '<div class="ob-row" style="padding-left:12px"><span class="k">' + esc(f.label) +
                      (f.required ? ' <span style="color:#ef4444">*</span>' : '') + '</span>' +
                      '<span class="v">' + badge(f.type, 'neutral') + '</span></div>';
                  }).join('');
              }).join('')
            : '<div class="ob-sub" style="margin:6px 0 0">No custom fields yet. Build the sections shown on the New Candidate form.</div>');
        var eb = document.getElementById('ob-cf-edit');
        if (eb) eb.addEventListener('click', onbOpenBuilder);
      }).catch(function () {});

      // Work-auth extra fields — same shape, its own schema. The full builder
      // engine only knows the candidate form, so this always uses the local one.
      api('/onboarding/work-auth-field-config').then(function (cfg) {
        var box = document.getElementById('ob-wa-panel');
        if (!box) return;
        var sections = (cfg && cfg.sections) || [];
        box.innerHTML =
          '<h3>Work Authorization Fields <button class="ob-btn" id="ob-wa-edit" style="float:right;padding:4px 10px">⚙ Open Builder</button></h3>' +
          (flattenSections(sections).length
            ? sections.map(function (s) {
                return '<div class="ob-row"><span class="k" style="font-weight:600">' + esc(s.title || 'Section') + '</span>' +
                  '<span class="v">' + (s.fields || []).length + ' field(s)</span></div>' +
                  (s.fields || []).map(function (f) {
                    return '<div class="ob-row" style="padding-left:12px"><span class="k">' + esc(f.label) +
                      (f.required ? ' <span style="color:#ef4444">*</span>' : '') + '</span>' +
                      '<span class="v">' + badge(f.type, 'neutral') + '</span></div>';
                  }).join('');
              }).join('')
            : '<div class="ob-sub" style="margin:6px 0 0">No extra fields yet. These are added to the ' +
              'Work Authorization tab for every candidate, on top of the per-visa-type fields below.</div>');
        var wb = document.getElementById('ob-wa-edit');
        if (wb) wb.addEventListener('click', function () { openFormBuilder('workAuth'); });
      }).catch(function () {});
    }

    // The per-visa-type field counts. Readable by anyone who can view
    // onboarding — only the builder button is settings-gated.
    api('/onboarding/work-auth-type-field-config').then(function (cfg) {
      var box = document.getElementById('ob-wat-panel');
      if (!box) return;
      var sections = (cfg && cfg.sections) || [];
      box.innerHTML =
        '<h3>Work Authorization Types' +
          (can('onboarding.settings')
            ? ' <button class="ob-btn" id="ob-wat-edit" style="float:right;padding:4px 10px">⚙ Open Builder</button>'
            : '') +
        '</h3>' +
        rows(sections.map(function (s) {
          var n = (s.fields || []).length;
          return [esc(s.id), n ? n + ' field(s)' : 'no extra fields'];
        }));
      var tb = document.getElementById('ob-wat-edit');
      if (tb) tb.addEventListener('click', function () { openFormBuilder('workAuthTypes'); });
    }).catch(function () {});

    var cfPanel = can('onboarding.settings')
      ? '<div class="ob-panel" id="ob-cf-panel"><h3>New Candidate Form</h3><div class="ob-skel" style="height:40px"></div></div>' +
        '<div class="ob-panel" id="ob-wa-panel"><h3>Work Authorization Fields</h3><div class="ob-skel" style="height:40px"></div></div>'
      : '';

    return '<div class="ob-grid2">' + cfPanel + '</div>' +
      '<div class="ob-grid2">' +
      '<div class="ob-panel"><h3>Workflow Stages</h3>' + rows(STAGES.map(function (s, i) {
        return [(i + 1) + '. ' + s[1], badge(s[0], 'neutral')];
      })) + '</div>' +
      '<div class="ob-panel"><h3>Document Rules</h3>' + rows([
        ['Mandatory', badge('SSN', 'err') + ' ' + badge('Driver License OR State ID', 'err')],
        ['Optional', badge('Visa', 'neutral') + ' ' + badge('I-94', 'neutral')],
        ['Allowed types', 'PDF, PNG, JPG'],
        ['Maximum size', MAX_MB + ' MB'],
        ['Versioning', 'Re-upload supersedes; history kept'],
      ]) + '</div>' +
      '<div class="ob-panel" id="ob-wat-panel"><h3>Work Authorization Types</h3>' +
        '<div class="ob-skel" style="height:40px"></div></div>' +
      '<div class="ob-panel"><h3>Your Permissions</h3>' + rows([
        ['View', can('onboarding.view') ? badge('Yes', 'ok') : badge('No', 'err')],
        ['Create / Edit', can('onboarding.create') ? badge('Yes', 'ok') : badge('No', 'err')],
        ['Verify documents', can('onboarding.verify') ? badge('Yes', 'ok') : badge('No', 'err')],
        ['Approve', can('onboarding.approve') ? badge('Yes', 'ok') : badge('No', 'err')],
        ['Allocate assets', can('onboarding.assets') ? badge('Yes', 'ok') : badge('No', 'err')],
        ['Payroll', can('onboarding.payroll') ? badge('Yes', 'ok') : badge('No', 'err')],
      ]) + '</div>' +
    '</div>' +
    '<div class="ob-sub" style="margin-top:6px">Permissions are managed in Settings → Access Control. ' +
    'Expiring work authorizations are flagged 60 days ahead.</div>';
  }

  /* ── detail drawer ────────────────────────────────────────────────────── */
  var TABS = [
    ['overview', 'Overview'], ['workauth', 'Work Auth'], ['documents', 'Documents'],
    ['verification', 'Verification'], ['approval', 'Approval'], ['assets', 'IT Assets'],
    ['payroll', 'Payroll'], ['forms', 'Paper Forms'], ['timeline', 'Timeline'],
  ];


  function openDetail(id, tab) {
    state.tab = tab || 'overview';
    api('/onboarding/candidates/' + id).then(function (c) {
      state.detail = c;
      renderDrawer();
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function closeDrawer() {
    var ov = document.getElementById(ID.drawer);
    if (ov) ov.remove();
    state.detail = null;
  }

  function renderDrawer() {
    var c = state.detail;
    if (!c) return;
    var ov = document.getElementById(ID.drawer);
    if (!ov) {
      ov = document.createElement('div');
      ov.id = ID.drawer;
      ov.className = 'ob-ov';
      ov.addEventListener('click', function (e) { if (e.target === ov) closeDrawer(); });
      document.body.appendChild(ov);
    }
    var rail = STAGES.map(function (s) {
      var st = (c.stages || []).filter(function (x) { return x.stage === s[0]; })[0];
      return badge(s[1], statusKind(st && st.status));
    }).join('');

    ov.innerHTML =
      '<div class="ob-dw">' +
        '<div class="ob-dw-h"><h3>' + esc(c.name || c.email) + '</h3>' +
          badge(c.status, statusKind(c.status)) +
          '<button class="ob-x" id="ob-close">×</button></div>' +
        '<div class="ob-tabs">' + TABS.map(function (t) {
        return '<button class="ob-tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '" id="ob-tab-' + t[0] + '">' + t[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="ob-dw-b"><div class="ob-rail">' + rail + '</div><div id="ob-tabbody"></div></div>' +
      '</div>';

    ov.querySelector('#ob-close').addEventListener('click', closeDrawer);
    ov.querySelectorAll('.ob-tab').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.dataset.tab; renderDrawer(); });
    });
    renderTab();
  }

  function tabBody() { return document.getElementById('ob-tabbody'); }

  function renderTab() {
    var c = state.detail, el = tabBody();
    if (!c || !el) return;
    var t = state.tab;
    if (t === 'overview') return tabOverview(el, c);
    if (t === 'workauth') return tabWorkAuth(el, c);
    if (t === 'documents') return tabDocuments(el, c);
    if (t === 'verification') return tabVerification(el, c);
    if (t === 'approval') return tabApproval(el, c);
    if (t === 'assets') return tabAssets(el, c);
    if (t === 'payroll') return tabPayroll(el, c);
    if (t === 'forms') return tabForms(el, c);
    if (t === 'timeline') return tabTimeline(el, c);
  }


  function refreshDetail() {
    api('/onboarding/candidates/' + state.detail.id).then(function (c) {
      state.detail = c;
      renderDrawer();
      if (state.page === '') loadDashboard(); else loadCandidates();
    });
  }

  /* -- overview -- */
  function tabOverview(el, c) {
    var done = (c.stages || []).filter(function (s) { return s.status === 'Completed'; }).length;
    var canActivate = done >= 7 && c.status !== 'Onboarded';

    // Custom fields, labelled from the cached schema (fetched lazily once).
    var cf = c.customFields || {};
    var customRows = '';
    if (Object.keys(cf).length) {
      var defs = state.fieldDefs || [];
      var byKey = {};
      defs.forEach(function (f) { byKey[f.key] = f; });
      customRows = Object.keys(cf).map(function (k) {
        var f = byKey[k] || { label: k, type: 'text' };
        var raw = cf[k];
        var val = Array.isArray(raw) ? raw.join(', ')
          : f.type === 'checkbox' ? (raw ? 'Yes' : 'No') : raw;
        return '<div class="ob-row"><span class="k">' + esc(f.label) + '</span><span class="v">' + esc(val) + '</span></div>';
      }).join('');
      if (!state.fieldDefs) {
        // First time: fetch labels, then re-render this tab.
        api('/onboarding/field-config').then(function (r) {
          state.fieldDefs = (r && r.fields) || [];
          if (state.tab === 'overview') renderTab();
        }).catch(function () { state.fieldDefs = []; });
      }
    }

    el.innerHTML =
      '<div class="ob-row"><span class="k">Email</span><span class="v">' + esc(c.email) + '</span></div>' +
      '<div class="ob-row"><span class="k">Phone</span><span class="v">' + esc(c.phone || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Job Title</span><span class="v">' + esc(c.jobTitle || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Department</span><span class="v">' + esc(c.department || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Client</span><span class="v">' + esc(c.client || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Vendor</span><span class="v">' + esc(c.vendor || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Recruiter</span><span class="v">' + esc(c.recruiter || '—') + '</span></div>' +
      '<div class="ob-row"><span class="k">Joining Date</span><span class="v">' + fmtDate(c.joiningDate) + '</span></div>' +
      customRows +
      '<div class="ob-row"><span class="k">Progress</span><span class="v">' + done + ' / ' + STAGES.length + ' stages</span></div>' +
      '<div class="ob-act">' +
        (canActivate && can('onboarding.edit')
          ? '<button class="ob-btn primary" id="ob-activate">✓ Activate Employee</button>' : '') +
        (can('onboarding.delete')
          ? '<button class="ob-btn danger" id="ob-del">Delete Candidate</button>' : '') +
      '</div><div class="ob-err" id="ob-e"></div>';

    var act = el.querySelector('#ob-activate');
    if (act) act.addEventListener('click', function () {
      act.disabled = true;
      api('/onboarding/candidates/' + c.id + '/activate', { method: 'POST', body: {} })
        .then(function () { toast('Employee activated — login account created'); refreshDetail(); })
        .catch(function (e) { act.disabled = false; el.querySelector('#ob-e').textContent = e.message; });
    });
    var del = el.querySelector('#ob-del');
    if (del) del.addEventListener('click', function () {
      if (!confirm('Delete ' + (c.name || c.email) + '? The audit trail is kept.')) return;
      api('/onboarding/candidates/' + c.id, { method: 'DELETE' })
        .then(function () { toast('Candidate deleted'); closeDrawer(); loadCandidates(); })
        .catch(function (e) { toast(e.message, 'error'); });
    });
  }

  /* One core work-auth field. These map to WorkAuthorization columns and need
     bespoke inputs — the type dropdown drives the rest of the form — so they
     are rendered here rather than by customFieldInput. Everything cosmetic
     (label, order, width, required) still comes from the admin's schema. */
  function waCoreInput(f, a, ro) {
    var dis = ro ? ' disabled' : '';
    var lab = '<label class="ob-lb">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>';
    var wrap = f.width === 'half' ? '<div>' : '<div class="full">';
    if (f.key === 'authType') {
      return wrap + lab + '<select class="ob-sel" id="wa-type"' + dis + '><option value="">Select…</option>' +
        AUTH_TYPES.map(function (t) {
          return '<option' + (a.authType === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') + '</select></div>';
    }
    if (f.key === 'status') {
      return wrap + lab + '<select class="ob-sel" id="wa-status"' + dis + '>' +
        AUTH_STATUSES.map(function (t) {
          return '<option' + (a.status === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') + '</select></div>';
    }
    if (f.key === 'expiryDate') {
      return wrap + lab + '<input type="date" class="ob-in" id="wa-expiry" value="' +
        esc(a.expiryDate || '') + '"' + dis + '></div>';
    }
    if (f.key === 'receiptNumber') {
      return wrap + lab + '<input class="ob-in" id="wa-receipt" value="' +
        esc(a.receiptNumber || '') + '"' + dis + '></div>';
    }
    if (f.key === 'sponsorshipRequired') {
      return '<div class="full"><label class="ob-chk"><input type="checkbox" id="wa-spons"' +
        (a.sponsorshipRequired ? ' checked' : '') + dis + '> ' + esc(f.label) + '</label></div>';
    }
    return '';
  }

  /* -- work authorization (the dynamic form) --
     Three sets of fields land here, all admin-configurable:
       core       — the five built-in fields, rendered from the schema's ``core``
                    entries by waCoreInput; they map to columns.
       #wa-dyn    — the fields the selected visa type asks for, swapped whenever
                    the type dropdown changes.
       #wa-custom — extra fields that apply to every candidate and every type.
     Core renders first, then per-type, then extras — the schema orders within
     each group, not across them. */
  function tabWorkAuth(el, c) {
    Promise.all([
      api('/onboarding/candidates/' + c.id + '/work-authorization'),
      // Falling back to the built-in core fields keeps the tab usable if the
      // config call fails, rather than rendering an empty form.
      api('/onboarding/work-auth-field-config').catch(function () { return null; }),
      api('/onboarding/work-auth-type-field-config').catch(function () { return null; }),
    ]).then(function (res) {
      var a = res[0] || {};
      var cfgSections = (res[1] && res[1].sections) || [{ fields: WA_CORE_FALLBACK }];
      var typeSections = (res[2] && res[2].sections) || [];
      var typeFields = {};
      typeSections.forEach(function (s) { typeFields[s.id] = s.fields || []; });

      var coreFields = [];
      cfgSections.forEach(function (s) {
        (s.fields || []).forEach(function (f) { if (f.core) coreFields.push(f); });
      });

      var ro = !can('onboarding.edit');
      // Adding a field edits the shared schema for every candidate, so the
      // button is a settings action even though it lives on this tab.
      var canFields = can('onboarding.settings');
      el.innerHTML =
        '<div class="ob-f">' +
          coreFields.map(function (f) { return waCoreInput(f, a, ro); }).join('') +
          '<div class="full" id="wa-dyn"></div>' +
          '<div class="full" id="wa-custom">' +
            '<div class="ob-f">' + renderCustomSections(cfgSections, a.customFields) + '</div>' +
          '</div>' +
        '</div>' +
        (ro && !canFields ? '' :
          '<div class="ob-act">' +
            (ro ? '' : '<button class="ob-btn primary" id="wa-save">Save Work Authorization</button>') +
            (canFields
              ? '<button class="ob-btn" id="wa-fields" style="margin-left:auto" ' +
                'title="Add fields to this tab for every candidate">⚙ Add / Edit Fields</button>'
              : '') +
          '</div>') +
        '<div class="ob-err" id="wa-e"></div>';

      // renderCustomSections() has no read-only mode — it is shared with the
      // New Candidate modal, which is always editable. Radio groups carry
      // data-ck on a wrapping div, so disable the controls themselves.
      if (ro) {
        el.querySelectorAll('#wa-custom input, #wa-custom select, #wa-custom textarea')
          .forEach(function (i) { i.disabled = true; });
      }

      function renderDyn() {
        var type = el.querySelector('#wa-type').value;
        var box = el.querySelector('#wa-dyn');
        var fields = typeFields[type] || [];
        if (!type) { box.innerHTML = '<div class="ob-sub">Select a type to see its fields.</div>'; return; }
        if (!fields.length) {
          box.innerHTML = '<div class="ob-sub">A ' + esc(type) + ' needs no additional work-authorization fields.</div>';
          return;
        }
        // Rendered by the shared field renderer, so a per-type field supports
        // the whole palette (select, date, textarea…) rather than text/date.
        box.innerHTML = '<div class="ob-f">' +
          renderCustomSections([{ fields: fields }], a.details) + '</div>';
        if (ro) {
          box.querySelectorAll('input, select, textarea').forEach(function (i) { i.disabled = true; });
        }
      }
      el.querySelector('#wa-type').addEventListener('change', renderDyn);
      renderDyn();

      var fieldsBtn = el.querySelector('#wa-fields');
      if (fieldsBtn) fieldsBtn.addEventListener('click', function () { openFormBuilder('workAuth'); });

      var save = el.querySelector('#wa-save');
      if (save) save.addEventListener('click', function () {
        var e = el.querySelector('#wa-e');
        var type = el.querySelector('#wa-type').value;
        if (!type) { e.textContent = 'Select a work authorization type.'; return; }
        save.disabled = true;
        e.textContent = '';
        var body = {
          authType: type,
          details: collectCustom(el.querySelector('#wa-dyn')),
          customFields: collectCustom(el.querySelector('#wa-custom')),
        };
        // Each core field is only sent if the schema actually rendered it, so a
        // reordered or relabelled form never posts a null over a live column.
        var st = el.querySelector('#wa-status'); if (st) body.status = st.value;
        var ex = el.querySelector('#wa-expiry'); if (ex) body.expiryDate = ex.value || null;
        var rc = el.querySelector('#wa-receipt'); if (rc) body.receiptNumber = rc.value;
        var sp = el.querySelector('#wa-spons'); if (sp) body.sponsorshipRequired = sp.checked;
        api('/onboarding/candidates/' + c.id + '/work-authorization', { method: 'PUT', body: body })
          .then(function () { toast('Work authorization saved'); refreshDetail(); })
          .catch(function (err) { save.disabled = false; e.textContent = err.message; });
      });
    }).catch(function (e) { el.innerHTML = '<div class="ob-err">' + esc(e.message) + '</div>'; });
  }

  /* -- custom modal for adding document requirement slots -- */
  function openAddDocumentModal(c, requestedDocsList, onSaved) {
    var ov = document.createElement('div');
    ov.id = 'ob-add-doc-modal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
    
    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg2,#111827);border:1px solid var(--border,#2a3446);border-radius:14px;width:min(460px,92vw);padding:24px;box-shadow:0 20px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;color:var(--text,#e6edf7);font-family:inherit;';
    
    modal.innerHTML = 
      '<h3 style="margin:0;font-size:16px;font-weight:700;font-family:var(--font-d);">Add Document Requirement</h3>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
        '<label class="ob-lb" style="margin:0">Document Name / Label</label>' +
        '<input type="text" class="ob-in" id="adm-name" placeholder="e.g. NDA, Degree Certificate" autofocus>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;">' +
        '<label class="ob-chk" style="padding:0;margin:0"><input type="checkbox" id="adm-send" checked> Send to Candidate</label>' +
        '<label class="ob-chk" style="padding:0;margin:0;margin-top:8px"><input type="checkbox" id="adm-req"> Required (Mandatory)</label>' +
      '</div>' +
      '<div class="ob-err" id="adm-err" style="margin:0;min-height:0;font-size:12px;color:#ef4444;"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">' +
        '<button class="ob-btn" id="adm-cancel" style="padding:6px 14px;">Cancel</button>' +
        '<button class="ob-btn primary" id="adm-save" style="padding:6px 16px;">Add Slot</button>' +
      '</div>';
      
    ov.appendChild(modal);
    document.body.appendChild(ov);
    
    var nameInp = modal.querySelector('#adm-name');
    var sendChk = modal.querySelector('#adm-send');
    var reqChk = modal.querySelector('#adm-req');
    var errDiv = modal.querySelector('#adm-err');
    var cancelBtn = modal.querySelector('#adm-cancel');
    var saveBtn = modal.querySelector('#adm-save');
    
    function close() {
      ov.remove();
    }
    
    cancelBtn.addEventListener('click', close);
    ov.addEventListener('click', function(e) { if (e.target === ov) close(); });
    
    nameInp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key === 'Escape') {
        close();
      }
    });
    
    saveBtn.addEventListener('click', function() {
      var name = (nameInp.value || '').trim();
      if (!name) {
        errDiv.textContent = 'Document name is required.';
        return;
      }
      var typeKey = 'custom_' + name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (requestedDocsList.some(function (item) { return item.type === typeKey || item.label.toLowerCase() === name.toLowerCase(); })) {
        errDiv.textContent = 'A document slot with this name already exists.';
        return;
      }
      
      var newDocSlot = {
        type: typeKey,
        label: name,
        required: reqChk.checked,
        sendToCandidate: sendChk.checked
      };
      
      saveBtn.disabled = true;
      saveBtn.textContent = 'Adding...';
      
      api('/onboarding/candidates/' + c.id, {
        method: 'PATCH',
        body: { requestedDocs: requestedDocsList.concat(newDocSlot) }
      }).then(function (updatedCandidate) {
        toast('Document slot "' + name + '" added to checklist');
        onSaved(updatedCandidate.requestedDocs, newDocSlot);
        close();
      }).catch(function(err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add Slot';
        errDiv.textContent = err.message || 'Failed to add document slot.';
      });
    });
  }

  /* -- documents (drag & drop, multi-upload, versions) -- */
  function tabDocuments(el, c) {
    var ro = !can('onboarding.edit');
    api('/onboarding/candidates/' + c.id + '/documents').then(function (docs) {
      docs = docs || [];
      var have = {};
      docs.forEach(function (d) { have[d.docType] = d; });

      var circleCheck = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#22c55e;color:#fff;text-align:center;line-height:14px;font-size:9px;margin-right:6px;font-weight:bold">✓</span>';
      var circleWarning = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ef4444;color:#fff;text-align:center;line-height:14px;font-size:9px;margin-right:6px;font-weight:bold">!</span>';
      var circleInfo = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#64748b;color:#fff;text-align:center;line-height:14px;font-size:9px;margin-right:6px;font-weight:bold">-</span>';


      // Update the Documents tab badge with current upload count
      function updateTabBadge(count) {
        var tabBtn = document.getElementById('ob-tab-documents');
        if (tabBtn) {
          tabBtn.innerHTML = 'Documents' +
            (count > 0
              ? ' <span style="font-size:10px;background:#22c55e33;color:#4ade80;border:1px solid #22c55e66;border-radius:10px;padding:1px 6px;margin-left:3px;font-weight:600">' + count + '</span>'
              : '');
        }
      }
      updateTabBadge(docs.length);

      // Ensure requestedDocs array is initialized in candidate object
      var requestedDocsList = (c.requestedDocs && Array.isArray(c.requestedDocs) && c.requestedDocs.length > 0) ? c.requestedDocs : [
        {type: 'ssn', label: 'SSN', required: true, sendToCandidate: true},
        {type: 'driver_license', label: 'Driver License', required: false, sendToCandidate: true},
        {type: 'state_id', label: 'State ID', required: false, sendToCandidate: false},
        {type: 'visa', label: 'Visa (Work Authorization)', required: false, sendToCandidate: true},
        {type: 'i94', label: 'I-94', required: false, sendToCandidate: true}
      ];

      /* The action buttons are identical for fixed and custom documents. */
      function docActions(d) {
        var label = d.label || d.docType;
        if (label === 'ssn') label = 'SSN';
        else if (label === 'driver_license') label = 'Driver License';
        else if (label === 'state_id') label = 'State ID';
        else if (label === 'visa') label = 'Visa (Work Authorization)';
        else if (label === 'i94') label = 'I-94';
        return badge('v' + d.version + ' · ' + label, 'ok') +
          ' <button class="ob-btn" style="padding:3px 9px" data-dl="' + d.id + '">View</button>' +
          ' <button class="ob-btn" style="padding:3px 9px" data-hist="' + esc(d.docType) + '">History</button>' +
          (ro ? '' : ' <button class="ob-btn danger" style="padding:3px 9px" data-rm="' + d.id + '">Delete</button>');
      }

      // Render the checklist table
      var checklistRows = requestedDocsList.map(function (item, index) {
        var d = have[item.type] || have['custom_' + item.type] || have[item.type.toLowerCase().replace(/\s+/g, '_')];
        // If not found, check by label matching (case insensitive)
        if (!d) {
          d = docs.find(function (x) {
            return (x.label || '').toLowerCase() === (item.label || '').toLowerCase() ||
                   (x.docType || '').toLowerCase() === (item.type || '').toLowerCase();
          });
        }

        var chkRequired = '<input type="checkbox" class="chk-required" data-index="' + index + '"' + (item.required ? ' checked' : '') + (ro ? ' disabled' : '') + '>';
        var chkSend = '<input type="checkbox" class="chk-send" data-index="' + index + '"' + (item.sendToCandidate ? ' checked' : '') + (ro ? ' disabled' : '') + '>';

        var isSystem = ['ssn', 'driver_license', 'state_id', 'visa', 'i94'].indexOf(item.type) !== -1;
        var delBtn = (isSystem || ro) ? '' : ' <button class="ob-btn danger" style="padding:2px 6px;margin-left:4px" data-del-checklist-idx="' + index + '">×</button>';

        // STATUS column — show circular tick symbol on upload, circular warning symbol when not uploaded
        var statusCell;
        if (d) {
          statusCell = circleCheck + badge('v' + d.version + ' · ' + esc(item.label), 'ok');
        } else if (!item.sendToCandidate) {
          statusCell = circleInfo + badge('Not requested', 'neutral');
        } else if (item.required) {
          statusCell = circleWarning + badge('Mandatory — not uploaded', 'err');
        } else {
          statusCell = circleWarning + badge('Optional — not uploaded', 'neutral');
        }

        // ACTION column — view/history/delete when uploaded, else nothing
        var actionCell = d
          ? ('<button class="ob-btn" style="padding:3px 9px" data-dl="' + d.id + '">View</button>' +
             ' <button class="ob-btn" style="padding:3px 9px" data-hist="' + esc(d.docType) + '">History</button>' +
             (ro ? '' : ' <button class="ob-btn danger" style="padding:3px 9px" data-rm="' + d.id + '">Delete</button>'))
          : '—';

        return '<tr>' +
          '<td style="vertical-align:middle">' +
            '<strong>' + esc(item.label) + '</strong>' +
            (item.required ? ' <span style="color:#ef4444;font-weight:700">*</span>' : '') +
            delBtn +
          '</td>' +
          '<td style="text-align:center;vertical-align:middle">' + chkSend + '</td>' +
          '<td style="text-align:center;vertical-align:middle">' + chkRequired + '</td>' +
          '<td style="vertical-align:middle;white-space:nowrap">' + statusCell + '</td>' +
          '<td style="vertical-align:middle;white-space:nowrap">' + actionCell + '</td>' +
          '</tr>';
      }).join('');

      var checklistTable = [
        '<div style="margin-bottom:20px;padding:16px;background:var(--bg3,#1c2433);border:1px solid var(--border,#2a3446);border-radius:12px">',
        '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">',
        '    <h4 style="margin:0;font-size:15px">Onboarding Checklist &amp; Candidate Portal Uploads</h4>',
        (ro ? '' : '    <button class="ob-btn primary" id="btn-add-doc-name" style="padding:4px 12px">+ Add Document Name</button>'),
        '  </div>',
        '  <div style="overflow-x:auto;max-height:280px;overflow-y:auto;width:100%;max-width:100%;box-sizing:border-box">',
        '  <table class="ob-table" style="width:100%;margin-top:10px;border-collapse:collapse">',
        '    <thead>',
        '      <tr>',
        '        <th style="text-align:left;padding:8px 10px;width:auto">Document Type / Label</th>',
        '        <th style="text-align:center;width:110px;padding:8px 10px">Send to Candidate</th>',
        '        <th style="text-align:center;width:70px;padding:8px 10px">Required</th>',
        '        <th style="text-align:left;width:160px;padding:8px 10px">Status</th>',
        '        <th style="text-align:left;width:120px;padding:8px 10px">Action</th>',
        '      </tr>',
        '    </thead>',
        '    <tbody>',
        '       ' + (checklistRows || '<tr><td colspan="5" class="ob-empty">No documents configured.</td></tr>'),
        '    </tbody>',
        '  </table>',
        '  </div>',
        '</div>'
      ].join('\n');

      el.innerHTML =
        checklistTable +
        (ro ? '' :
          '<div class="ob-dz" id="ob-dz"><div class="big">⬆</div>' +
          '<div><b>Drag &amp; drop</b> files here, or click to choose</div>' +
          '<div class="ob-sub" style="margin:6px 0 0">PDF, PNG or JPG · max ' + MAX_MB + ' MB each</div></div>' +
          '<div style="display:flex;gap:8px;margin-bottom:10px">' +
            '<select class="ob-sel" id="ob-dtype" style="flex:1;margin:0">' +
              requestedDocsList.filter(function(t){ return t.sendToCandidate; }).map(function (t) {
                return '<option value="' + t.type + '">Upload as: ' + t.label + (t.required ? ' (required)' : ' (optional)') + '</option>';
              }).join('') +
              '<option value="' + CUSTOM_DOC_VALUE + '">Upload as: Custom document…</option>' +
            '</select>' +
          '</div>' +
          '<input class="ob-in" id="ob-dlabel" style="margin-bottom:10px;display:none" maxlength="' +
            MAX_DOC_LABEL + '" placeholder="Name this document (e.g. Work Permit), then choose the file above">' +
          '<input type="file" id="ob-file" accept=".pdf,.png,.jpg,.jpeg" multiple hidden>' +
          '<div class="ob-bar" id="ob-bar" style="display:none"><i></i></div>') +
        '<div class="ob-err" id="ob-de"></div>';

      // Event listener for adding custom doc type
      var addBtn = el.querySelector('#btn-add-doc-name');
      if (addBtn) {
        addBtn.addEventListener('click', function () {
          openAddDocumentModal(c, requestedDocsList, function(updatedDocs, newItem) {
            requestedDocsList = updatedDocs;
            c.requestedDocs = updatedDocs;
            renderTab();
          });
        });
      }

      // Event listener for deleting custom doc index
      el.querySelectorAll('[data-del-checklist-idx]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.delChecklistIdx);
          if (!confirm('Remove this document slot from the checklist? Any already uploaded file will remain in custom uploads.')) return;
          requestedDocsList.splice(idx, 1);

          api('/onboarding/candidates/' + c.id, {
            method: 'PATCH',
            body: { requestedDocs: requestedDocsList }
          }).then(function (updatedCandidate) {
            toast('Document slot removed');
            c.requestedDocs = updatedCandidate.requestedDocs;
            renderTab();
          }).catch(function (err) { alert(err.message); });
        });
      });

      // Event listener for checkbox checklist saves
      function saveChecklist() {
        api('/onboarding/candidates/' + c.id, {
          method: 'PATCH',
          body: { requestedDocs: requestedDocsList }
        }).then(function (updatedCandidate) {
          c.requestedDocs = updatedCandidate.requestedDocs;
          toast('Checklist configurations updated');
        }).catch(function (err) { alert(err.message); });
      }

      el.querySelectorAll('.chk-send').forEach(function (chk) {
        chk.addEventListener('change', function () {
          var idx = parseInt(chk.dataset.index);
          requestedDocsList[idx].sendToCandidate = chk.checked;
          // Update status cell live
          var row = chk.closest('tr');
          var statusTd = row ? row.cells[3] : null;
          if (statusTd) {
            var item = requestedDocsList[idx];
            var have2 = {}; docs.forEach(function(dd){ have2[dd.docType]=dd; });
            var doc2 = have2[item.type] || have2['custom_'+item.type];
            if (!doc2) statusTd.innerHTML = chk.checked
              ? (item.required ? circleWarning + badge('Mandatory — not uploaded','err') : circleWarning + badge('Optional — not uploaded','neutral'))
              : circleInfo + badge('Not requested','neutral');
          }
          // Rebuild upload dropdown
          var sel = el.querySelector('#ob-dtype');
          if (sel) {
            var prev = sel.value;
            sel.innerHTML = requestedDocsList.filter(function(t){ return t.sendToCandidate; }).map(function(t){
              return '<option value="'+t.type+'">Upload as: '+t.label+(t.required?' (required)':' (optional)')+'</option>';
            }).join('') + '<option value="'+CUSTOM_DOC_VALUE+'">Upload as: Custom document…</option>';
            sel.value = prev;
          }
          saveChecklist();
        });
      });

      el.querySelectorAll('.chk-required').forEach(function (chk) {
        chk.addEventListener('change', function () {
          var idx = parseInt(chk.dataset.index);
          requestedDocsList[idx].required = chk.checked;
          var item = requestedDocsList[idx];
          // Update label badge live
          var row = chk.closest('tr');
          if (row) {
            var labelTd = row.cells[0];
            var strong = labelTd ? labelTd.querySelector('strong') : null;
            if (strong) {
              // Remove any existing span/star elements after strong
              var next = strong.nextSibling;
              while (next) {
                var current = next;
                next = next.nextSibling;
                if (current.tagName === 'SPAN') {
                  current.remove();
                }
              }
              if (chk.checked) {
                var star = document.createElement('span');
                star.style.cssText = 'color:#ef4444;font-weight:700';
                star.textContent = ' *';
                strong.parentNode.insertBefore(star, strong.nextSibling);
              }
            }
            // Update status cell
            var statusTd = row.cells[3];
            var have2 = {}; docs.forEach(function(dd){ have2[dd.docType]=dd; });
            var doc2 = have2[item.type] || have2['custom_'+item.type];
            if (statusTd && !doc2 && item.sendToCandidate) {
              statusTd.innerHTML = chk.checked
                ? circleWarning + badge('Mandatory — not uploaded','err')
                : circleWarning + badge('Optional — not uploaded','neutral');
            }
          }
          // Update dropdown label
          var sel = el.querySelector('#ob-dtype');
          if (sel) {
            var opt = sel.querySelector('option[value="'+item.type+'"]');
            if (opt) opt.textContent = 'Upload as: '+item.label+(chk.checked?' (required)':' (optional)');
          }
          saveChecklist();
        });
      });

      el.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/documents/' + b.dataset.dl).then(function (d) {
            var w = window.open('');
            if (!w) { toast('Popup blocked — allow popups to preview', 'warn'); return; }
            var src = 'data:' + d.fileMime + ';base64,' + d.fileData;
            w.document.write(d.fileMime === 'application/pdf'
              ? '<iframe src="' + src + '" style="border:0;width:100%;height:100vh"></iframe>'
              : '<img src="' + src + '" style="max-width:100%">');
          }).catch(function (e) { toast(e.message, 'error'); });
        });
      });

      el.querySelectorAll('[data-hist]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/document-versions/' + b.dataset.hist).then(function (vs) {
            alert((vs || []).map(function (v) {
              return 'v' + v.version + ' · ' + (v.fileName || '—') + ' · ' +
                     (v.isActive ? 'current' : 'superseded') + ' · ' + fmtDateTime(v.uploadedAt) +
                     ' · ' + v.uploadedBy;
            }).join('\n') || 'No versions.');
          });
        });
      });

      el.querySelectorAll('[data-rm]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Delete this document? The previous version is restored if there is one.')) return;
          api('/onboarding/candidates/' + c.id + '/documents/' + b.dataset.rm, { method: 'DELETE' })
            .then(function () { toast('Document deleted'); renderTab(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
      });

      if (ro) return;
      var dz = el.querySelector('#ob-dz'), inp = el.querySelector('#ob-file');
      var dtype = el.querySelector('#ob-dtype'), dlabel = el.querySelector('#ob-dlabel');
      var dcustom = el.querySelector('#ob-dcustom');

      // The dropdown is the single source of truth for which mode we are in;
      // the button is a shortcut that selects (or clears) the custom option.
      function syncLabelBox() {
        var custom = dtype.value === CUSTOM_DOC_VALUE;
        dlabel.style.display = custom ? '' : 'none';
        inp.multiple = !custom;
        if (dcustom) {
          dcustom.textContent = custom ? '✕ Cancel custom' : '+ Add Custom Document';
          dcustom.classList.toggle('primary', custom);
        }
      }
      dtype.addEventListener('change', syncLabelBox);
      if (dcustom) {
        dcustom.addEventListener('click', function () {
          var wasCustom = dtype.value === CUSTOM_DOC_VALUE;
          dtype.value = wasCustom ? requestedDocsList[0].type : CUSTOM_DOC_VALUE;
          if (wasCustom) dlabel.value = '';
          syncLabelBox();
          if (!wasCustom) dlabel.focus();
        });
      }
      syncLabelBox();

      dz.addEventListener('click', function () { inp.click(); });
      dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
      dz.addEventListener('drop', function (e) {
        e.preventDefault(); dz.classList.remove('over');
        upload(Array.prototype.slice.call(e.dataTransfer.files));
      });
      inp.addEventListener('change', function () {
        upload(Array.prototype.slice.call(inp.files));
      });

      function upload(files) {
        var errEl = el.querySelector('#ob-de');
        var docType = dtype.value;
        var isCustom = docType === CUSTOM_DOC_VALUE;
        var label = dlabel.value.trim();
        var bar = el.querySelector('#ob-bar'), fill = bar.querySelector('i');
        errEl.textContent = '';

        if (isCustom) {
          if (!label) { errEl.textContent = 'Name the document before uploading it.'; return; }
          if (files.length > 1) {
            errEl.textContent = 'Upload one file at a time when naming a custom document — ' +
              'a single drop of multiple files represents distinct categories.';
            return;
          }
        }
        var invalid = files.filter(function (f) { return ALLOWED_MIME.indexOf(f.type) === -1; });
        if (invalid.length) {
          errEl.textContent = 'Only PDF, PNG or JPG files are allowed.';
          return;
        }
        var big = files.filter(function (f) { return f.size > MAX_MB * 1024 * 1024; });
        if (big.length) {
          errEl.textContent = 'Files must be smaller than ' + MAX_MB + ' MB.';
          return;
        }

        bar.style.display = '';
        fill.style.width = '0';
        var idx = 0;

        function nextFile() {
          if (idx >= files.length) {
            bar.style.display = 'none';
            toast('Uploaded ' + files.length + ' file(s)');
            renderTab();
            return;
          }
          var f = files[idx];
          var reader = new FileReader();
          reader.onload = function (e) {
            var base64 = e.target.result.split(',')[1];
            api('/onboarding/candidates/' + c.id + '/documents', {
              method: 'POST',
              body: {
                docType: docType,
                isCustom: isCustom,
                label: label,
                fileName: f.name,
                fileMime: f.type,
                fileData: base64,
              },
            }).then(function () {
              fill.style.width = Math.round(((idx + 1) / files.length) * 100) + '%';
              idx++;
              nextFile();
            }).catch(function (err) {
              bar.style.display = 'none';
              errEl.textContent = 'Failed to upload ' + f.name + ': ' + err.message;
            });
          };
          reader.readAsDataURL(f);
        }
        nextFile();
      }
    }).catch(function (e) { el.innerHTML = '<div class="ob-err">' + esc(e.message) + '</div>'; });
  }

  function readFile(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(new Error('Could not read ' + f.name)); };
      r.readAsDataURL(f);
    });
  }

  /* -- HR verification -- */
  var CHECKS = [
    ['ssnVerified', 'SSN Verified'], ['driverLicenseVerified', 'Driver License Verified'],
    ['stateIdVerified', 'State ID Verified'], ['visaVerified', 'Visa Verified'],
    ['i94Verified', 'I-94 Verified'],
  ];

  function tabVerification(el, c) {
    if (!can('onboarding.verify')) {
      el.innerHTML = '<div class="ob-empty">You do not have permission to verify documents.</div>';
      return;
    }
    api('/onboarding/candidates/' + c.id + '/verify').then(function (v) {
      v = v || {};
      var missing = v.missingDocuments || [];
      el.innerHTML =
        (missing.length
          ? '<div class="ob-panel" style="border-color:#ef4444;margin-bottom:16px">' +
            '<b style="color:#ef4444">Cannot approve yet</b><div class="ob-sub" style="margin:6px 0 0">Missing: ' +
            esc(missing.join(', ')) + '</div></div>'
          : '') +
        CHECKS.map(function (k) {
          return '<label class="ob-chk"><input type="checkbox" data-v="' + k[0] + '"' +
                 (v[k[0]] ? ' checked' : '') + '> ' + k[1] + '</label>';
        }).join('') +
        // Custom documents get a tick-box each, keyed by docType. The list is
        // per-candidate, so unlike CHECKS it comes from the server.
        ((v.customDocuments || []).length
          ? '<div class="ob-sub" style="margin:12px 0 4px">Custom documents</div>' +
            v.customDocuments.map(function (d) {
              return '<label class="ob-chk"><input type="checkbox" data-cv="' + esc(d.docType) + '"' +
                     ((v.customVerified || {})[d.docType] ? ' checked' : '') + '> ' +
                     esc(d.label) + ' Verified</label>';
            }).join('')
          : '') +
        '<div style="margin-top:14px"><label class="ob-lb">Remarks</label>' +
        '<textarea class="ob-ta" id="hv-remarks">' + esc(v.remarks || '') + '</textarea></div>' +
        '<div class="ob-act">' +
          '<button class="ob-btn primary" id="hv-ok"' + (missing.length ? ' disabled title="Documents are missing"' : '') + '>Approve</button>' +
          '<button class="ob-btn danger" id="hv-no">Reject</button>' +
          '<button class="ob-btn" id="hv-save">Save Progress</button>' +
        '</div>' +
        '<div class="ob-err" id="hv-e"></div>' +
        (v.verifiedBy ? '<div class="ob-sub" style="margin-top:12px">Last updated by ' + esc(v.verifiedBy) +
          ' · ' + fmtDateTime(v.verifiedAt) + '</div>' : '');

      function submit(status) {
        var body = { status: status, remarks: el.querySelector('#hv-remarks').value };
        el.querySelectorAll('[data-v]').forEach(function (i) { body[i.dataset.v] = i.checked; });
        var cv = {};
        el.querySelectorAll('[data-cv]').forEach(function (i) { cv[i.dataset.cv] = i.checked; });
        body.customVerified = cv;
        api('/onboarding/candidates/' + c.id + '/verify', { method: 'POST', body: body })
          .then(function () { toast('Verification ' + status.toLowerCase()); refreshDetail(); })
          .catch(function (e) { el.querySelector('#hv-e').textContent = e.message; });
      }
      el.querySelector('#hv-ok').addEventListener('click', function () { submit('Approved'); });
      el.querySelector('#hv-no').addEventListener('click', function () { submit('Rejected'); });
      el.querySelector('#hv-save').addEventListener('click', function () { submit('Pending'); });
    });
  }

  /* -- manager approval -- */
  function tabApproval(el, c) {
    api('/onboarding/candidates/' + c.id + '/approve').then(function (hist) {
      hist = hist || [];
      var history = hist.length
        ? '<div class="ob-tl" style="margin-top:18px">' + hist.map(function (h) {
            return '<div class="ob-tl-i"><div class="e">' + esc(h.action) + '</div>' +
                   '<div class="m">' + esc(h.approver) + ' · ' + fmtDateTime(h.actedAt) +
                   (h.comments ? '<br>' + esc(h.comments) : '') + '</div></div>';
          }).join('') + '</div>'
        : '<div class="ob-sub" style="margin-top:16px">No decisions yet.</div>';

      if (!can('onboarding.approve')) {
        el.innerHTML = '<div class="ob-empty" style="padding:26px">You do not have permission to approve.</div>' + history;
        return;
      }
      el.innerHTML =
        '<label class="ob-lb">Comments <span class="ob-sub" style="display:inline">(required to reject or return)</span></label>' +
        '<textarea class="ob-ta" id="ma-c"></textarea>' +
        '<div class="ob-act">' +
          '<button class="ob-btn primary" id="ma-ok">✓ Approve</button>' +
          '<button class="ob-btn danger" id="ma-no">✕ Reject</button>' +
          '<button class="ob-btn" id="ma-ret">↩ Return for Correction</button>' +
        '</div><div class="ob-err" id="ma-e"></div>' + history;

      function act(action) {
        api('/onboarding/candidates/' + c.id + '/approve', {
          method: 'POST',
          body: { action: action, comments: el.querySelector('#ma-c').value },
        }).then(function () { toast('Candidate ' + action.toLowerCase()); refreshDetail(); })
          .catch(function (e) { el.querySelector('#ma-e').textContent = e.message; });
      }
      el.querySelector('#ma-ok').addEventListener('click', function () { act('Approved'); });
      el.querySelector('#ma-no').addEventListener('click', function () { act('Rejected'); });
      el.querySelector('#ma-ret').addEventListener('click', function () { act('Returned'); });
    });
  }

  /* -- IT assets -- */
  function tabAssets(el, c) {
    api('/onboarding/candidates/' + c.id + '/assets').then(function (list) {
      list = list || [];
      var ro = !can('onboarding.assets');
      var existing = list.length
        ? list.map(function (a) {
            return '<div class="ob-row"><span class="k">' +
              badge(a.assetSource, 'neutral') + ' ' + esc((a.assets || []).join(', ') || a.assetId || '—') +
              (a.clientName ? '<br><span style="font-size:11px">' + esc(a.clientName) + '</span>' : '') +
              '</span><span class="v">' + badge(a.status, statusKind(a.status)) +
              (ro ? '' : ' <button class="ob-btn danger" style="padding:3px 9px" data-rma="' + a.id + '">Remove</button>') +
              '</span></div>';
          }).join('')
        : '<div class="ob-sub">No assets allocated yet.</div>';

      if (ro) {
        el.innerHTML = existing +
          '<div class="ob-empty" style="padding:26px">You do not have permission to allocate assets.</div>';
        return;
      }

      el.innerHTML = existing +
        '<h3 style="margin:22px 0 12px;font-size:14px">Allocate Assets</h3>' +
        '<div class="ob-f">' +
          '<div><label class="ob-lb">Asset Source</label><select class="ob-sel" id="as-src">' +
            '<option>Eversoft</option><option>Client</option></select></div>' +
          '<div><label class="ob-lb">Status</label><select class="ob-sel" id="as-status">' +
            ASSET_STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></div>' +
          '<div id="as-clientwrap" style="display:none"><label class="ob-lb">Client Name <span class="req">*</span></label>' +
            '<input class="ob-in" id="as-client"></div>' +
          '<div><label class="ob-lb">Asset ID</label><input class="ob-in" id="as-id" placeholder="EVS-1042"></div>' +
          '<div><label class="ob-lb">Issued Date</label><input type="date" class="ob-in" id="as-date"></div>' +
          '<div class="full" id="as-items"><label class="ob-lb">Assets</label>' +
            EVERSOFT_ASSETS.map(function (a) {
              return '<label class="ob-chk" style="display:inline-flex;margin-right:16px">' +
                     '<input type="checkbox" data-a="' + a + '"> ' + a + '</label>';
            }).join('') + '</div>' +
        '</div>' +
        '<div class="ob-act"><button class="ob-btn primary" id="as-save">Allocate</button></div>' +
        '<div class="ob-err" id="as-e"></div>';

      var src = el.querySelector('#as-src');
      src.addEventListener('change', function () {
        // Client-owned kit is tracked by client + asset ID, not by our checklist
        // — the server rejects unknown asset names for Eversoft sources anyway.
        var isClient = src.value === 'Client';
        el.querySelector('#as-clientwrap').style.display = isClient ? '' : 'none';
        el.querySelector('#as-items').style.display = isClient ? 'none' : '';
      });

      el.querySelectorAll('[data-rma]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/assets/' + b.dataset.rma, { method: 'DELETE' })
            .then(function () { toast('Allocation removed'); refreshDetail(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
      });

      el.querySelector('#as-save').addEventListener('click', function () {
        var assets = [];
        el.querySelectorAll('[data-a]').forEach(function (i) { if (i.checked) assets.push(i.dataset.a); });
        api('/onboarding/candidates/' + c.id + '/assets', {
          method: 'POST',
          body: {
            assetSource: src.value,
            clientName: el.querySelector('#as-client').value,
            assets: src.value === 'Client' ? [] : assets,
            assetId: el.querySelector('#as-id').value,
            issuedDate: el.querySelector('#as-date').value || null,
            status: el.querySelector('#as-status').value,
          },
        }).then(function () { toast('Assets allocated'); refreshDetail(); })
          .catch(function (e) { el.querySelector('#as-e').textContent = e.message; });
      });
    });
  }

  /* -- payroll -- */
  function tabPayroll(el, c) {
    if (!can('onboarding.payroll')) {
      // Not just a hidden button: the server returns 403 on GET too, because
      // bank details are the one thing a Manager or IT Admin must never read.
      el.innerHTML = '<div class="ob-empty"><div class="big">🔒</div>' +
        'Bank details are restricted to Payroll Admins.</div>';
      return;
    }
    api('/onboarding/candidates/' + c.id + '/payroll').then(function (p) {
      p = p || {};
      el.innerHTML =
        '<div class="ob-f">' +
          '<div><label class="ob-lb">Bank Name <span class="req">*</span></label>' +
            '<input class="ob-in" id="pr-bank" value="' + esc(p.bankName || '') + '"></div>' +
          '<div><label class="ob-lb">Account Number <span class="req">*</span></label>' +
            '<input class="ob-in" id="pr-acct" placeholder="' +
            (p.hasAccountNumber ? esc(p.accountNumberMasked) + ' (enter to replace)' : 'Account number') + '"></div>' +
          '<div><label class="ob-lb">Routing Number <span class="req">*</span></label>' +
            '<input class="ob-in" id="pr-rout" value="' + esc(p.routingNumber || '') + '"></div>' +
          '<div><label class="ob-lb">Tax State <span class="req">*</span></label>' +
            '<input class="ob-in" id="pr-state" value="' + esc(p.taxState || '') + '"></div>' +
          '<div class="full"><label class="ob-chk"><input type="checkbox" id="pr-dd"' +
            (p.directDeposit ? ' checked' : '') + '> Direct deposit</label></div>' +
        '</div>' +
        '<div class="ob-act">' +
          '<button class="ob-btn primary" id="pr-done">Mark Completed</button>' +
          '<button class="ob-btn" id="pr-save">Save Progress</button>' +
        '</div><div class="ob-err" id="pr-e"></div>' +
        (p.status ? '<div class="ob-sub" style="margin-top:12px">Status: ' + esc(p.status) +
          (p.completedBy ? ' · ' + esc(p.completedBy) : '') + '</div>' : '');

      function submit(status) {
        var acct = el.querySelector('#pr-acct').value;
        var body = {
          status: status,
          bankName: el.querySelector('#pr-bank').value,
          routingNumber: el.querySelector('#pr-rout').value,
          taxState: el.querySelector('#pr-state').value,
          directDeposit: el.querySelector('#pr-dd').checked,
        };
        // The stored number never comes back from the API (it is masked), so an
        // empty box means "unchanged" — sending '' would wipe it.
        if (acct) body.accountNumber = acct;
        else if (p.hasAccountNumber) body.accountNumber = undefined;
        if (status === 'Completed' && !acct && !p.hasAccountNumber) {
          el.querySelector('#pr-e').textContent = 'accountNumber is required to complete payroll';
          return;
        }
        if (status === 'Completed' && !acct && p.hasAccountNumber) {
          el.querySelector('#pr-e').textContent =
            'Re-enter the account number to confirm completion.';
          return;
        }
        api('/onboarding/candidates/' + c.id + '/payroll', { method: 'PUT', body: body })
          .then(function () { toast('Payroll ' + status.toLowerCase()); refreshDetail(); })
          .catch(function (e) { el.querySelector('#pr-e').textContent = e.message; });
      }
      el.querySelector('#pr-done').addEventListener('click', function () { submit('Completed'); });
      el.querySelector('#pr-save').addEventListener('click', function () { submit('Pending'); });
    }).catch(function (e) {
      el.innerHTML = '<div class="ob-empty"><div class="big">🔒</div>' + esc(e.message) + '</div>';
    });
  }

  /* -- paper forms & candidate signatures (admin-side) -- */
  function tabForms(el, c) {
    if (!can('onboarding.edit')) {
      el.innerHTML = '<div class="ob-empty">You do not have permission to manage onboarding forms.</div>';
      return;
    }

    function isAdmin() {
      try {
        var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}');
        var role = (sess.role || '').toLowerCase();
        return role === 'admin' || role.indexOf('admin') !== -1;
      } catch (_) {
        return false;
      }
    }

    var portalLink = c.portalToken
      ? (window.location.protocol + '//' + window.location.host + '/onboarding/fill?token=' + c.portalToken)
      : '';

    // Fetch template forms, candidate submissions, and candidate uploaded docs
    Promise.all([
      api('/onboarding/forms'),
      api('/onboarding/candidates/' + c.id + '/submissions'),
      api('/onboarding/candidates/' + c.id + '/documents')
    ]).then(function (results) {
      var templates = results[0] || [];
      var submissions = results[1] || [];
      var docs = results[2] || [];
      
      var subsMap = {};
      submissions.forEach(function (s) { subsMap[s.formId] = s; });

      // Which candidate-facing documents were requested (sendToCandidate), and
      // which of them have actually arrived — one matcher reused for both the
      // counter and the rows so the two can never disagree.
      var activeChecklistDocs = (c.requestedDocs || []).filter(function (item) { return item.sendToCandidate; });
      function docMatch(item) {
        return docs.find(function (d) {
          return d.docType === item.type ||
                 d.docType === 'custom_' + item.type ||
                 (d.label || '').toLowerCase() === (item.label || '').toLowerCase();
        });
      }

      var formsDone = templates.filter(function (f) { return subsMap[f.id]; }).length;
      var formsTotal = templates.length;
      var docsDone = activeChecklistDocs.filter(docMatch).length;
      var docsTotal = activeChecklistDocs.length;
      var doneItems = formsDone + docsDone;
      var totalItems = formsTotal + docsTotal;
      var pct = totalItems ? Math.round(doneItems / totalItems * 100) : 0;

      // A count pill for a section header — green once everything is in.
      function countPill(done, total) {
        if (!total) return badge('none', 'neutral');
        return badge(done + ' / ' + total + (done >= total ? ' ✓' : ''), done >= total ? 'ok' : 'warn');
      }

      var submissionsList = templates.map(function (f) {
        var sub = subsMap[f.id];
        var actionBtns = '';
        if (sub) {
          actionBtns =
            ' <button class="ob-btn" style="padding:3px 9px" data-view-pdf="' + sub.id + '">View Signed PDF</button>' +
            (sub.mode === 'digital' ? ' <button class="ob-btn" style="padding:3px 9px" data-view-data="' + sub.id + '">View Data</button>' : '');
        }
        return '<div class="ob-row">' +
          '<span class="k">' + esc(f.name) + '</span>' +
          '<span class="v">' +
            (sub ? badge('Completed (' + sub.mode + ')', 'ok') + actionBtns : badge('Pending', 'warn')) +
          '</span></div>';
      }).join('');

      var checklistDocsHtml = activeChecklistDocs.map(function (item) {
        var match = docMatch(item);
        var actionBtns = match
          ? ' <button class="ob-btn" style="padding:3px 9px" data-dl="' + match.id + '">View</button>' : '';
        return '<div class="ob-row">' +
          '<span class="k">' + esc(item.label) + (item.required ? ' <span style="color:#ef4444">*</span>' : '') + '</span>' +
          '<span class="v">' +
            (match ? badge('Uploaded', 'ok') + actionBtns : badge('Awaiting upload', 'warn')) +
          '</span></div>';
      }).join('');

      var templatesList = templates.map(function (f) {
        return '<div class="ob-row">' +
          '<span class="k">' + esc(f.name) + ' (' + esc(f.fileName) + ')</span>' +
          '<span class="v">' +
            (f.isActive ? badge('Active', 'ok') : badge('Inactive', 'neutral')) +
            (isAdmin() ? ' <button class="ob-btn danger" style="padding:3px 9px" data-del-tmpl="' + f.id + '">Delete</button>' : '') +
          '</span></div>';
      }).join('');

      // Portal link state: how long the link lasts, in friendly terms.
      function expiryLabel(s) {
        if (!s) return '';
        var d = new Date(s.slice(0, 10) + 'T00:00:00');
        if (isNaN(d.getTime())) return '';
        var days = Math.ceil((d.getTime() - Date.now()) / 86400000);
        var nice = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        if (days < 0) return 'link expired ' + nice;
        if (days === 0) return 'link expires today';
        return 'expires in ' + days + ' day' + (days === 1 ? '' : 's') + ' · ' + nice;
      }
      var expInfo = expiryLabel(c.portalTokenExpiresAt);

      // Collapsible section — native <details> so it needs no JS. Open by
      // default keeps operational content visible; the admin drawer ships
      // closed so setup controls stay out of the daily flow.
      function section(title, pill, body, opts) {
        opts = opts || {};
        return '<details class="ob-sec"' + (opts.closed ? '' : ' open') +
          ' style="margin-bottom:14px;border:1px solid var(--border,#2a3446);border-radius:12px;overflow:hidden">' +
          '<summary style="cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:10px;' +
            'font-weight:600;background:var(--bg3,#1c2433)">' +
            '<span style="flex:1">' + esc(title) + '</span>' + (pill || '') +
          '</summary>' +
          '<div style="padding:8px 16px 14px">' + body + '</div>' +
        '</details>';
      }

      el.innerHTML =
        // ── Header: portal link fused with live progress ──
        '<div style="margin-bottom:16px;padding:16px 18px;background:var(--bg3,#1c2433);' +
          'border:1px solid var(--border,#2a3446);border-radius:14px">' +
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
            '<h4 style="margin:0;flex:1">Onboarding Portal</h4>' +
            (portalLink ? badge('Link active', 'ok') : badge('Not sent yet', 'neutral')) +
          '</div>' +
          '<div style="margin:12px 0 4px;display:flex;align-items:center;gap:10px">' +
            '<div style="flex:1;height:8px;border-radius:99px;background:var(--border,#2a3446);overflow:hidden">' +
              '<div style="height:100%;width:' + pct + '%;background:#0f9d58;transition:width .3s"></div>' +
            '</div>' +
            '<span class="ob-sub" style="white-space:nowrap;font-weight:600">' + doneItems + ' / ' + totalItems + ' complete</span>' +
          '</div>' +
          '<div class="ob-sub" style="margin-bottom:12px">' +
            docsDone + '/' + docsTotal + ' documents uploaded · ' + formsDone + '/' + formsTotal + ' forms signed' +
            (expInfo ? ' · ' + esc(expInfo) : '') +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="ob-btn primary" id="btn-send-portal">' +
              (portalLink ? 'Resend invite' : 'Send portal link') + '</button>' +
            (portalLink ? '<button class="ob-btn" id="btn-copy-link">Copy link</button>' : '') +
          '</div>' +
          (portalLink
            ? '<input class="ob-in" id="portal-url" style="margin-top:10px;font-family:monospace;font-size:11px" ' +
              'value="' + esc(portalLink) + '" readonly onClick="this.select()">'
            : '') +
        '</div>' +

        // ── Documents requested ──
        section('Documents requested', countPill(docsDone, docsTotal),
          checklistDocsHtml ||
            '<div class="ob-empty" style="padding:10px">No documents are set to be requested from the candidate. ' +
            'Configure the checklist under Manage below.</div>') +

        // ── Forms to sign ──
        section('Forms to sign', countPill(formsDone, formsTotal),
          submissionsList ||
            '<div class="ob-empty" style="padding:10px">No forms assigned yet. Upload a template under Manage below.</div>') +

        // ── Admin: templates & management (collapsed) ──
        (isAdmin()
          ? section('⚙ Manage form templates', badge('Admin', 'neutral'),
              '<div class="ob-sub" style="margin:0 0 8px">Blank PDF templates assigned to every candidate.</div>' +
              (templatesList || '<div class="ob-empty" style="padding:10px">No blank form templates uploaded yet.</div>') +
              '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#2a3446)">' +
                '<div class="ob-lb" style="margin-bottom:8px">Upload a new blank form template (PDF)</div>' +
                '<div class="ob-f">' +
                  '<div class="full"><label class="ob-lb">Form name (e.g. W-4, Direct Deposit)</label>' +
                    '<input class="ob-in" id="new-tmpl-name" placeholder="Enter form name"></div>' +
                  '<div class="full"><label class="ob-lb">Form PDF file</label>' +
                    '<input type="file" class="ob-in" id="new-tmpl-file" accept=".pdf"></div>' +
                '</div>' +
                '<button class="ob-btn primary" style="margin-top:12px" id="btn-upload-tmpl">Upload template</button>' +
                '<div class="ob-err" id="tmpl-err"></div>' +
              '</div>',
              { closed: true })
          : '');

      // Event handlers for templates list
      if (isAdmin()) {
        el.querySelectorAll('[data-del-tmpl]').forEach(function (b) {
          b.addEventListener('click', function () {
            if (!confirm('Delete this form template? Active candidates will no longer be assigned this form.')) return;
            api('/onboarding/forms/' + b.dataset.delTmpl, { method: 'DELETE' })
              .then(function () { toast('Template deleted'); renderTab(); })
              .catch(function (err) { alert(err.message); });
          });
        });
      }

      // Event handlers to view uploaded checklist documents
      el.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/documents/' + b.dataset.dl).then(function (d) {
            var w = window.open('');
            if (!w) { toast('Popup blocked — allow popups to preview', 'warn'); return; }
            var src = 'data:' + d.fileMime + ';base64,' + d.fileData;
            w.document.write(d.fileMime === 'application/pdf'
              ? '<iframe src="' + src + '" style="border:0;width:100%;height:100vh"></iframe>'
              : '<img src="' + src + '" style="max-width:100%">');
          }).catch(function (e) { toast(e.message, 'error'); });
        });
      });

      // Event handlers for viewing signed PDF
      el.querySelectorAll('[data-view-pdf]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/submissions/' + b.dataset.viewPdf + '/pdf')
            .then(function (sub) {
              var w = window.open('');
              if (!w) { toast('Popup blocked — allow popups to preview', 'warn'); return; }
              var src = 'data:' + sub.fileMime + ';base64,' + sub.fileData;
              w.document.write('<iframe src="' + src + '" style="border:0;width:100%;height:100vh"></iframe>');
            }).catch(function (err) { toast(err.message, 'error'); });
        });
      });

      // Event handlers for viewing filled data
      el.querySelectorAll('[data-view-data]').forEach(function (b) {
        b.addEventListener('click', function () {
          var sub = subsMap[b.dataset.viewData];
          if (sub) {
            alert('Submitted Answers:\n' + JSON.stringify(sub.filledData, null, 2));
          }
        });
      });

      // Copy the portal URL to the clipboard, with a select-and-copy fallback
      // for browsers that block the async clipboard API.
      var copyBtn = el.querySelector('#btn-copy-link');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var url = (el.querySelector('#portal-url') || {}).value || portalLink;
        function done() { toast('Portal link copied'); }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () {
            var i = el.querySelector('#portal-url'); if (i) { i.select(); document.execCommand('copy'); done(); }
          });
        } else {
          var i = el.querySelector('#portal-url'); if (i) { i.select(); document.execCommand('copy'); done(); }
        }
      });

      // Send Link
      el.querySelector('#btn-send-portal').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = 'Sending email invite…';
        api('/onboarding/candidates/' + c.id + '/send-portal-link', { method: 'POST' })
          .then(function () {
            toast('Portal invitation link emailed to candidate!');
            refreshDetail();
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = portalLink ? 'Resend invite' : 'Send portal link';
            alert('Email failed (but token generated): ' + err.message);
            refreshDetail();
          });
      });

      // Upload template
      if (isAdmin()) {
        el.querySelector('#btn-upload-tmpl').addEventListener('click', function () {
          var name = el.querySelector('#new-tmpl-name').value.trim();
          var fileInp = el.querySelector('#new-tmpl-file');
          var errEl = el.querySelector('#tmpl-err');
          errEl.textContent = '';

          if (!name) { errEl.textContent = 'Form name is required.'; return; }
          var file = fileInp.files[0];
          if (!file) { errEl.textContent = 'Please choose a PDF file template.'; return; }

          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Uploading template…';

          var reader = new FileReader();
          reader.onload = function (e) {
            var base64 = e.target.result.split(',')[1];
            api('/onboarding/forms', {
              method: 'POST',
              body: {
                name: name,
                fileData: base64,
                fileName: file.name,
                fileMime: file.type,
                schema: []
              }
            }).then(function () {
              toast('Template uploaded successfully!');
              renderTab();
            }).catch(function (err) {
              btn.disabled = false;
              btn.textContent = 'Upload Template Form';
              errEl.textContent = err.message;
            });
          };
          reader.readAsDataURL(file);
        });
      }

    }).catch(function (err) {
      el.innerHTML = '<div class="ob-empty">' + esc(err.message) + '</div>';
    });
  }

  /* -- timeline -- */
  function tabTimeline(el, c) {

    el.innerHTML = '<div class="ob-skel" style="height:80px"></div>';
    api('/onboarding/candidates/' + c.id + '/timeline').then(function (logs) {
      logs = logs || [];
      if (!logs.length) { el.innerHTML = '<div class="ob-empty">No activity yet.</div>'; return; }
      el.innerHTML = '<div class="ob-tl">' + logs.map(function (l) {
        return '<div class="ob-tl-i">' +
          '<div class="e">' + esc(l.event) + '</div>' +
          '<div class="m">' + fmtDateTime(l.createdAt) + ' · ' + esc(l.actorName || l.actorEmail || 'system') +
          (l.comments ? '<br>' + esc(l.comments) : '') + '</div></div>';
      }).join('') + '</div>';
    });
  }

  /* ── custom field rendering (shared by the New Candidate form & preview) ── */
  var FIELD_TYPES = [
    ['text', 'Text'], ['textarea', 'Text Area'], ['number', 'Number'],
    ['date', 'Date'], ['email', 'Email'], ['phone', 'Phone'], ['url', 'URL'],
    ['select', 'Dropdown'], ['multiselect', 'Multi Select'], ['radio', 'Radio'],
    ['checkbox', 'Checkbox'],
  ];
  var OPTION_TYPES = { select: 1, multiselect: 1, radio: 1 };

  function slug(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /* One custom field's input. Carries data-ck (key) + data-ct (type) so
     collectCustom() can gather values by key. Used live in the New Candidate
     modal and, read-only, in the builder preview. */
  function customFieldInput(f, value) {
    var id = 'ncf-' + f.key;
    var req = f.required ? ' <span class="req">*</span>' : '';
    var help = f.help ? '<div class="ob-sub" style="margin:4px 0 0">' + esc(f.help) + '</div>' : '';
    var ph = esc(f.placeholder || '');
    var da = ' data-ck="' + esc(f.key) + '" data-ct="' + f.type + '"';
    var input;

    if (f.type === 'textarea') {
      input = '<textarea class="ob-ta" id="' + id + '"' + da + ' placeholder="' + ph + '">' + esc(value || '') + '</textarea>';
    } else if (f.type === 'select') {
      input = '<select class="ob-sel" id="' + id + '"' + da + '><option value="">Select…</option>' +
        (f.options || []).map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (value === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
    } else if (f.type === 'multiselect') {
      var vals = Array.isArray(value) ? value : [];
      input = '<select class="ob-sel" id="' + id + '"' + da + ' multiple size="' +
        Math.min(Math.max((f.options || []).length, 2), 5) + '">' +
        (f.options || []).map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (vals.indexOf(o.value) !== -1 ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>' +
        '<div class="ob-sub" style="margin:3px 0 0">Ctrl/Cmd-click for multiple</div>';
    } else if (f.type === 'radio') {
      input = '<div' + da + ' id="' + id + '">' + (f.options || []).map(function (o) {
        return '<label class="ob-chk" style="display:inline-flex;margin-right:14px">' +
          '<input type="radio" name="' + id + '" value="' + esc(o.value) + '"' + (value === o.value ? ' checked' : '') + '> ' + esc(o.label) + '</label>';
      }).join('') + '</div>';
    } else if (f.type === 'checkbox') {
      return '<div class="' + (f.width === 'half' ? '' : 'full') + '"><label class="ob-chk">' +
        '<input type="checkbox" id="' + id + '"' + da + (value ? ' checked' : '') + '> ' + esc(f.label) + '</label>' + help + '</div>';
    } else {
      var t = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' :
        f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text';
      input = '<input class="ob-in" id="' + id + '"' + da + ' type="' + t + '" placeholder="' + ph + '" value="' + esc(value == null ? '' : value) + '">';
    }
    return '<div class="' + (f.width === 'half' ? '' : 'full') + '">' +
      '<label class="ob-lb">' + esc(f.label) + req + '</label>' + input + help + '</div>';
  }

  /* Render the admin-built sections (headers + fields) as one form body.

     Core fields are skipped: they map to real columns and each form renders
     them with its own bespoke input (the work-auth type dropdown drives the
     rest of the tab, for instance), so emitting them here would duplicate
     them. Mirrors the server's form_fields(include_core=False). */
  function renderCustomSections(sections, values) {
    values = values || {};
    return (sections || []).map(function (s) {
      var fields = (s.fields || []).filter(function (f) { return !f.core; }).map(function (f) {
        return customFieldInput(f, values[f.key]);
      }).join('');
      if (!fields) return '';
      var head = s.title
        ? '<div class="full" style="border-top:1px solid var(--border,#2a3446);margin-top:6px;padding-top:14px">' +
          '<div class="ob-lb" style="font-size:13px;color:var(--text,#e6edf7)">' + esc(s.title) + '</div></div>'
        : '';
      return head + fields;
    }).join('');
  }

  function collectCustom(scope) {
    var out = {};
    scope.querySelectorAll('[data-ck]').forEach(function (i) {
      var key = i.getAttribute('data-ck'), t = i.getAttribute('data-ct');
      if (t === 'checkbox') { out[key] = i.checked; return; }
      if (t === 'multiselect') {
        var vals = Array.prototype.slice.call(i.selectedOptions || []).map(function (o) { return o.value; });
        if (vals.length) out[key] = vals;
        return;
      }
      if (t === 'radio') {
        var picked = i.querySelector('input[type=radio]:checked');
        if (picked) out[key] = picked.value;
        return;
      }
      if (i.value !== '') out[key] = i.value;
    });
    return out;
  }

  function flattenSections(sections) {
    var out = [];
    (sections || []).forEach(function (s) { (s.fields || []).forEach(function (f) { out.push(f); }); });
    return out;
  }

  /* The full Candidate Form Builder engine (hrms-onboarding-form-builder.js)
     owns the New Candidate form and the builder — exactly like the Job Post
     builder owns Post-a-Job. These wrappers prefer the engine and fall back to
     the lightweight modal/builder below if it failed to load. */
  function onbOpenForm() {
    if (window.__hrmsOnbForm) return window.__hrmsOnbForm.openForm();
    openNewModal();
  }
  function onbOpenBuilder() {
    if (window.__hrmsOnbForm) return window.__hrmsOnbForm.openBuilder();
    openFormBuilder();
  }

  /* ── new candidate modal (fallback if the engine is unavailable) ────────── */
  function openNewModal() {
    // Fetch the admin-built form first, so it reflects the current schema.
    api('/onboarding/field-config').then(function (cfg) {
      renderNewModal((cfg && cfg.sections) || []);
    }).catch(function () { renderNewModal([]); });
  }

  function renderNewModal(sections) {
    var fields = flattenSections(sections);
    var ov = document.createElement('div');
    ov.id = ID.modal;
    ov.className = 'ob-ov';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';

    ov.innerHTML =
      '<div class="ob-dw" style="width:min(640px,100%);height:auto;max-height:90vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="ob-dw-h"><h3>New Candidate</h3><button class="ob-x" id="nc-x">×</button></div>' +
        '<div class="ob-dw-b"><div class="ob-f">' +
          '<div><label class="ob-lb">First Name <span class="req">*</span></label><input class="ob-in" id="nc-first"></div>' +
          '<div><label class="ob-lb">Last Name</label><input class="ob-in" id="nc-last"></div>' +
          '<div><label class="ob-lb">Email <span class="req">*</span></label><input class="ob-in" id="nc-email" type="email"></div>' +
          '<div><label class="ob-lb">Phone</label><input class="ob-in" id="nc-phone"></div>' +
          '<div><label class="ob-lb">Client</label><input class="ob-in" id="nc-client"></div>' +
          '<div><label class="ob-lb">Vendor</label><input class="ob-in" id="nc-vendor"></div>' +
          '<div><label class="ob-lb">Recruiter</label><input class="ob-in" id="nc-recruiter" value="' + esc(sessionEmail()) + '"></div>' +
          '<div><label class="ob-lb">Job Title</label><input class="ob-in" id="nc-title"></div>' +
          '<div><label class="ob-lb">Department</label><input class="ob-in" id="nc-dept"></div>' +
          '<div><label class="ob-lb">Joining Date</label><input class="ob-in" id="nc-join" type="date"></div>' +
          renderCustomSections(sections, {}) +
        '</div>' +
        '<div class="ob-act"><button class="ob-btn primary" id="nc-save">Create Candidate</button>' +
        '<button class="ob-btn" id="nc-cancel">Cancel</button>' +
        (can('onboarding.settings')
          ? '<button class="ob-btn" id="nc-fields" style="margin-left:auto">⚙ Edit Form</button>' : '') +
        '</div>' +
        '<div class="ob-err" id="nc-e"></div></div>' +
      '</div>';
    document.body.appendChild(ov);

    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#nc-x').addEventListener('click', close);
    ov.querySelector('#nc-cancel').addEventListener('click', close);
    var fbtn = ov.querySelector('#nc-fields');
    if (fbtn) fbtn.addEventListener('click', function () { close(); openFormBuilder(); });

    ov.querySelector('#nc-save').addEventListener('click', function () {
      var e = ov.querySelector('#nc-e');
      var v = function (id) { return ov.querySelector('#nc-' + id).value.trim(); };
      if (!v('first')) { e.textContent = 'First name is required.'; return; }
      if (!v('email')) { e.textContent = 'Email is required.'; return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) { e.textContent = 'Enter a valid email address.'; return; }
      var custom = collectCustom(ov);
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.required && (custom[f.key] === undefined || custom[f.key] === '' ||
            (Array.isArray(custom[f.key]) && !custom[f.key].length))) {
          e.textContent = f.label + ' is required.'; return;
        }
      }
      var btn = ov.querySelector('#nc-save');
      btn.disabled = true;
      e.textContent = '';
      api('/onboarding/candidates', {
        method: 'POST',
        body: {
          firstName: v('first'), lastName: v('last'), email: v('email'), phone: v('phone'),
          client: v('client'), vendor: v('vendor'), recruiter: v('recruiter'),
          jobTitle: v('title'), department: v('dept'), joiningDate: v('join') || null,
          customFields: custom,
        },
      }).then(function (c) {
        close();
        toast('Candidate created');
        loadCandidates();
        openDetail(c.id, 'workauth');
      }).catch(function (err) {
        btn.disabled = false;
        e.textContent = err.message;
      });
    });
  }

  /* ── form builder (admin) ─────────────────────────────────────────────────
     A job-builder-style two-pane editor: sections of fields on the left, a live
     preview of the New Candidate form on the right. `bstate.sections` is the
     single source of truth; text edits mutate it in place and refresh only the
     preview (to preserve focus), while structural changes re-render the left
     pane too. Fields reorder within a section by drag or with ▲▼, and move
     between sections via the per-field section dropdown. */
  var bstate = null;

  /* The builder edits one of two schemas. Everything that differs between them
     lives here, so the editor itself stays target-agnostic. */
  var BUILDER_TARGETS = {
    candidate: {
      endpoint: '/onboarding/field-config',
      title: 'Candidate Form Builder',
      intro: 'Build the extra sections of the New Candidate form. Core fields (name, email, …) always appear first.',
      previewTitle: 'Live Preview — New Candidate',
      previewHead:
        '<div><label class="ob-lb">First Name <span class="req">*</span></label><input class="ob-in"></div>' +
        '<div><label class="ob-lb">Email <span class="req">*</span></label><input class="ob-in"></div>',
      emptySection: 'Additional Information',
    },
    workAuth: {
      key: 'workAuth',
      group: 'workAuth',
      switchLabel: 'General fields (all candidates)',
      endpoint: '/onboarding/work-auth-field-config',
      title: 'Work Authorization Field Builder',
      intro: 'The Work Authorization tab\'s own fields. The five built-in ones are marked ' +
             '"core" — you can relabel, reorder and require them, but not delete or retype ' +
             'them, since they map to real columns. Anything you add here shows for every ' +
             'candidate, whatever their visa type.',
      previewTitle: 'Live Preview — Work Authorization',
      previewHead:
        '<div><label class="ob-lb">Work Authorization Type <span class="req">*</span></label><select class="ob-sel"></select></div>' +
        '<div><label class="ob-lb">Status</label><select class="ob-sel"></select></div>',
      emptySection: 'Additional Work Authorization Details',
    },
    workAuthTypes: {
      key: 'workAuthTypes',
      group: 'workAuth',
      switchLabel: 'Fields by visa type',
      endpoint: '/onboarding/work-auth-type-field-config',
      title: 'Work Authorization — Fields by Visa Type',
      intro: 'One section per visa type: its fields are what that type asks for. The list of ' +
             'types is fixed (a candidate\'s type is stored as its name), so sections cannot ' +
             'be added, renamed or removed — only their fields. Removing a field hides it; ' +
             'values already saved against it are kept.',
      previewTitle: 'Live Preview — fields by type',
      previewHead: '',
      // Sections here ARE the visa types: fixed set, and keys are unique within
      // a type rather than across the form.
      fixedSections: true,
      uniquePerSection: true,
      emptySection: '',
    },
  };

  function openFormBuilder(targetKey) {
    var target = BUILDER_TARGETS[targetKey] || BUILDER_TARGETS.candidate;
    api(target.endpoint).then(function (cfg) {
      bstate = { sections: normaliseSections((cfg && cfg.sections) || []), target: target };
      // A fixed-section target always ships its sections (one per visa type),
      // so an empty result there means a failure, not a blank slate to seed.
      if (!bstate.sections.length && !target.fixedSections) {
        bstate.sections = [{ id: uid(), title: target.emptySection, fields: [] }];
      }
      renderFormBuilder();
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function uid() { return 's_' + Math.random().toString(36).slice(2, 9); }

  function normaliseSections(sections) {
    return sections.map(function (s) {
      return {
        id: s.id || uid(),
        title: s.title || '',
        fields: (s.fields || []).map(function (f) {
          return {
            key: f.key || '', label: f.label || '', type: f.type || 'text',
            required: !!f.required, width: f.width === 'half' ? 'half' : 'full',
            placeholder: f.placeholder || '', help: f.help || '',
            // Preserved deliberately: builderSchema() sends it back, and losing
            // it would turn a core field into a custom one on save.
            core: !!f.core,
            options: (f.options || []).map(function (o) {
              return typeof o === 'string' ? o : o.value;
            }),
          };
        }),
      };
    });
  }

  function renderFormBuilder() {
    var ov = document.getElementById('hrms-ob-builder');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'hrms-ob-builder';
      ov.className = 'ob-ov';
      ov.style.alignItems = 'center';
      ov.style.justifyContent = 'center';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) closeBuilder(); });
    }
    ov.innerHTML =
      '<div class="ob-dw" style="width:min(1100px,100%);height:auto;max-height:92vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="ob-dw-h"><h3>' + esc(bstate.target.title) + '</h3>' +
          // Work Auth is split across two schemas (general vs per-visa-type);
          // this switches between them without leaving the builder.
          (bstate.target.group
            ? '<select class="ob-sel" id="fb-target" style="width:auto;margin:0 8px 0 auto">' +
                Object.keys(BUILDER_TARGETS).filter(function (k) {
                  return BUILDER_TARGETS[k].group === bstate.target.group;
                }).map(function (k) {
                  return '<option value="' + k + '"' + (k === bstate.target.key ? ' selected' : '') +
                         '>' + esc(BUILDER_TARGETS[k].switchLabel) + '</option>';
                }).join('') +
              '</select>'
            : '') +
          '<button class="ob-btn primary" id="fb-save">Save Form</button>' +
          '<button class="ob-x" id="fb-x">×</button></div>' +
        '<div style="display:grid;grid-template-columns:1.15fr 1fr;gap:0;overflow:hidden;flex:1;min-height:0">' +
          '<div class="ob-dw-b" id="fb-build" style="border-right:1px solid var(--border,#2a3446)"></div>' +
          '<div class="ob-dw-b" id="fb-preview" style="background:var(--bg2,#141b26)"></div>' +
        '</div>' +
        '<div class="ob-err" id="fb-e" style="padding:0 22px 14px"></div>' +
      '</div>';
    ov.querySelector('#fb-x').addEventListener('click', closeBuilder);
    ov.querySelector('#fb-save').addEventListener('click', saveBuilder);
    var tsel = ov.querySelector('#fb-target');
    if (tsel) tsel.addEventListener('change', function () {
      // Switching reloads from the server, so anything unsaved is lost.
      openFormBuilder(tsel.value);
    });
    // Delegated listeners attach ONCE to the persistent #fb-build element.
    // (Re-attaching them on every renderBuilderList would stack duplicates, so
    // one click would fire the handler N times — fields would land in the wrong
    // section and counts would double.)
    wireBuilderList(ov.querySelector('#fb-build'));
    renderBuilderList();
    renderBuilderPreview();
  }

  function closeBuilder() {
    var ov = document.getElementById('hrms-ob-builder');
    if (ov) ov.remove();
    bstate = null;
  }

  function renderBuilderList() {
    var host = document.getElementById('fb-build');
    if (!host) return;
    host.innerHTML =
      '<div class="ob-sub" style="margin-top:0">' + esc(bstate.target.intro) + '</div>' +
      bstate.sections.map(sectionHtml).join('') +
      (bstate.target.fixedSections ? '' : '<button class="ob-btn" id="fb-addsec">+ Add Section</button>');
    // Wiring is delegated + attached once in renderFormBuilder — nothing to bind
    // here, so re-rendering never duplicates handlers.
  }

  function sectionHtml(s, si) {
    // For a fixed-section target the section IS a visa type — its name is
    // identity (candidates store it), so it is shown, not edited.
    var head = bstate.target.fixedSections
      ? '<div class="ob-lb" style="font-size:13px;margin:0 0 10px">' + esc(s.title || s.id) + '</div>'
      : '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">' +
          '<input class="ob-in" data-sec="title" placeholder="Section title" value="' + esc(s.title || '') + '" style="font-weight:600">' +
          '<button class="ob-btn" data-sec="up" title="Move up" style="padding:6px 9px">▲</button>' +
          '<button class="ob-btn" data-sec="down" title="Move down" style="padding:6px 9px">▼</button>' +
          '<button class="ob-btn danger" data-sec="del" title="Delete section" style="padding:6px 9px">✕</button>' +
        '</div>';
    return '<div class="fb-sec" data-si="' + si + '" style="border:1px solid var(--border,#2a3446);border-radius:10px;padding:12px;margin:12px 0">' +
      head +
      (s.fields || []).map(function (f, fi) { return fieldRowHtml(f, si, fi); }).join('') +
      '<button class="ob-btn" data-sec="addfield" style="margin-top:6px">+ Add Field</button>' +
    '</div>';
  }

  function fieldRowHtml(f, si, fi) {
    var isOpt = !!OPTION_TYPES[f.type];
    // A core field maps to a real column: its key and type are the contract, so
    // only the label, order, width and required flag are editable. Deleting one
    // would break the tab, and the server re-injects it anyway.
    var core = !!f.core;
    return '<div class="fb-fld" draggable="true" data-si="' + si + '" data-fi="' + fi + '" ' +
      'style="border:1px solid var(--border2,#1d2634);border-radius:8px;padding:9px;margin-bottom:8px;background:var(--bg,#0d131c)">' +
      '<div style="display:grid;grid-template-columns:1.3fr 1.2fr auto;gap:7px;align-items:center">' +
        '<input class="ob-in" data-f="label" placeholder="Label" value="' + esc(f.label || '') + '">' +
        '<select class="ob-sel" data-f="type"' + (core ? ' disabled title="A built-in field\'s type is fixed"' : '') + '>' +
          FIELD_TYPES.map(function (t) {
            return '<option value="' + t[0] + '"' + (f.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
          }).join('') +
          // The core types (select for authType/status) are not all in the
          // palette, so keep the current one selectable to avoid a blank box.
          (FIELD_TYPES.some(function (t) { return t[0] === f.type; })
            ? '' : '<option value="' + esc(f.type) + '" selected>' + esc(f.type) + '</option>') +
        '</select>' +
        '<span style="white-space:nowrap">' +
          '<button class="ob-btn" data-f="up" style="padding:5px 8px">▲</button>' +
          '<button class="ob-btn" data-f="down" style="padding:5px 8px">▼</button>' +
          (core
            ? '<span class="ob-sub" style="padding:0 4px" title="Built-in field — maps to a database column">core</span>'
            : '<button class="ob-btn danger" data-f="del" style="padding:5px 8px">✕</button>') +
        '</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:7px;align-items:center;margin-top:7px">' +
        '<input class="ob-in" data-f="key" placeholder="key (auto from label)" value="' + esc(f.key || '') + '"' +
          (core ? ' disabled title="A built-in field\'s key is fixed"' : '') + '>' +
        '<select class="ob-sel" data-f="width"><option value="full"' + (f.width !== 'half' ? ' selected' : '') + '>Full width</option>' +
          '<option value="half"' + (f.width === 'half' ? ' selected' : '') + '>Half width</option></select>' +
        '<label class="ob-chk" style="white-space:nowrap"><input type="checkbox" data-f="required"' + (f.required ? ' checked' : '') + '> Required</label>' +
      '</div>' +
      '<input class="ob-in" data-f="placeholder" placeholder="Placeholder (optional)" value="' + esc(f.placeholder || '') + '" style="margin-top:7px">' +
      // A core select (authType, status) draws its options from the app, not
      // the schema, so the options box would be misleading there.
      '<input class="ob-in" data-f="options" placeholder="Options, comma-separated" value="' + esc((f.options || []).join(', ')) +
        '" style="margin-top:7px;display:' + (isOpt && !core ? 'block' : 'none') + '">' +
    '</div>';
  }

  function wireBuilderList(host) {
    // Text inputs: update the model in place, refresh only the preview.
    host.addEventListener('input', function (e) {
      var f = e.target.getAttribute('data-f'), sc = e.target.getAttribute('data-sec');
      if (sc === 'title') {
        bstate.sections[+e.target.closest('.fb-sec').dataset.si].title = e.target.value;
        renderBuilderPreview(); return;
      }
      if (!f) return;
      var fld = fieldOf(e.target);
      if (!fld) return;
      if (f === 'options') fld.options = e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      else fld[f] = e.target.value;
      renderBuilderPreview();
    });
    // Selects / checkboxes.
    host.addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f');
      if (!f) return;
      var fld = fieldOf(e.target);
      if (!fld) return;
      if (f === 'required') fld.required = e.target.checked;
      else fld[f] = e.target.value;
      if (f === 'type') { renderBuilderList(); }   // show/hide options box
      renderBuilderPreview();
    });
    // Buttons: structural changes.
    host.addEventListener('click', function (e) {
      if (e.target.id === 'fb-addsec') {
        bstate.sections.push({ id: uid(), title: 'New Section', fields: [] });
        renderBuilderList(); renderBuilderPreview();
        return;
      }
      var secBtn = e.target.getAttribute('data-sec');
      var fBtn = e.target.getAttribute('data-f');
      if (secBtn && secBtn !== 'title') {
        var si = +e.target.closest('.fb-sec').dataset.si;
        if (secBtn === 'del') bstate.sections.splice(si, 1);
        else if (secBtn === 'up' && si > 0) swap(bstate.sections, si, si - 1);
        else if (secBtn === 'down' && si < bstate.sections.length - 1) swap(bstate.sections, si, si + 1);
        else if (secBtn === 'addfield') bstate.sections[si].fields.push({ label: '', key: '', type: 'text', required: false, width: 'full', options: [] });
        else return;
        renderBuilderList(); renderBuilderPreview();
      } else if (fBtn && ['up', 'down', 'del'].indexOf(fBtn) !== -1) {
        var row = e.target.closest('.fb-fld');
        var s = bstate.sections[+row.dataset.si].fields, fi = +row.dataset.fi;
        if (fBtn === 'del') s.splice(fi, 1);
        else if (fBtn === 'up' && fi > 0) swap(s, fi, fi - 1);
        else if (fBtn === 'down' && fi < s.length - 1) swap(s, fi, fi + 1);
        else return;
        renderBuilderList(); renderBuilderPreview();
      }
    });
    // Drag to reorder fields (within or across sections).
    var drag = null;
    host.addEventListener('dragstart', function (e) {
      var row = e.target.closest && e.target.closest('.fb-fld');
      if (!row) return;
      drag = { si: +row.dataset.si, fi: +row.dataset.fi };
      row.classList.add('drag');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'f'); } catch (_) {}
    });
    host.addEventListener('dragover', function (e) {
      if (drag) e.preventDefault();
    });
    host.addEventListener('drop', function (e) {
      if (!drag) return;
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.fb-fld');
      var sec = e.target.closest && e.target.closest('.fb-sec');
      if (!sec) { drag = null; return; }
      var from = bstate.sections[drag.si].fields;
      var moved = from.splice(drag.fi, 1)[0];
      var tsi = +sec.dataset.si;
      var to = bstate.sections[tsi].fields;
      var tfi = row ? +row.dataset.fi : to.length;
      if (drag.si === tsi && drag.fi < tfi) tfi--;   // account for the removal
      to.splice(tfi, 0, moved);
      drag = null;
      renderBuilderList(); renderBuilderPreview();
    });
    host.addEventListener('dragend', function () {
      drag = null;
      host.querySelectorAll('.drag').forEach(function (el) { el.classList.remove('drag'); });
    });
  }

  function fieldOf(node) {
    var row = node.closest('.fb-fld');
    if (!row) return null;
    return bstate.sections[+row.dataset.si].fields[+row.dataset.fi];
  }
  function swap(arr, a, b) { var t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

  /* Normalise the working model into the schema the API expects, filling in
     keys from labels and dropping blank fields. */
  function builderSchema() {
    // Per-visa-type schemas scope keys to their section: each type has its own
    // details blob, and the defaults genuinely reuse keys across types
    // (eadNumber in both GC EAD and H4 EAD). Deduping globally would silently
    // drop the second one.
    var perSection = !!bstate.target.uniquePerSection;
    var seen = {};
    var sections = bstate.sections.map(function (s) {
      if (perSection) seen = {};
      var fields = [];
      (s.fields || []).forEach(function (f) {
        if (!f.label && !f.key) return;   // blank row
        var key = (f.key || '').trim() || slug(f.label);
        if (!key || seen[key.toLowerCase()]) return;   // skip blank/dup keys
        seen[key.toLowerCase()] = 1;
        var out = {
          key: key, label: f.label || key, type: f.type || 'text',
          required: !!f.required, width: f.width === 'half' ? 'half' : 'full',
          placeholder: f.placeholder || '', help: f.help || '',
        };
        // Core fields map to real columns; the server rejects the key as
        // reserved unless it is flagged, so this must survive the round-trip.
        if (f.core) out.core = true;
        if (OPTION_TYPES[out.type] && !f.core) out.options = (f.options || []).filter(Boolean);
        fields.push(out);
      });
      return { id: s.id, title: (s.title || '').trim(), fields: fields };
    });
    // A fixed-section target's sections ARE the visa types — an emptied one is
    // a real state, not a stray heading to prune.
    if (!bstate.target.fixedSections) {
      sections = sections.filter(function (s) { return s.fields.length; });
    }
    return { sections: sections };
  }

  function renderBuilderPreview() {
    var host = document.getElementById('fb-preview');
    if (!host) return;
    var schema = builderSchema();
    host.innerHTML =
      '<div class="ob-lb" style="font-size:13px;margin-bottom:12px">' + esc(bstate.target.previewTitle) + '</div>' +
      '<div class="ob-f" style="pointer-events:none;opacity:.95">' +
        bstate.target.previewHead +
        renderCustomSections(schema.sections, {}) +
      '</div>';
  }

  function saveBuilder() {
    var e = document.getElementById('fb-e');
    e.textContent = '';
    var target = bstate.target;
    api(target.endpoint, { method: 'PUT', body: builderSchema() })
      .then(function () {
        toast('Form saved');
        // Only the candidate form feeds the overview tab's label cache.
        if (target === BUILDER_TARGETS.candidate) state.fieldDefs = null;
        closeBuilder();
        if (state.page === '/settings') render();
        // The builder can be opened from the Work Auth tab, which is still
        // behind it — re-render so the new fields show without reopening.
        else if (state.detail) renderTab();
      })
      .catch(function (err) { e.textContent = err.message; });
  }

  /* ── export (CSV / Excel / PDF-via-print) ─────────────────────────────── */
  /* Export whatever table is on screen, not always the candidate roster. */
  function exportRows() {
    var spec = STAGE_PAGES[state.page];
    if (spec) {
      return {
        head: spec.cols.map(function (c) { return c[1]; }),
        body: stageRows(spec).map(function (r) {
          return spec.cols.map(function (c) {
            var v = r[c[0]];
            if (Array.isArray(v)) return v.join(', ');
            if (typeof v === 'boolean') return v ? 'Yes' : 'No';
            if (v && typeof v === 'object') return '';
            return String(v == null ? '' : v);
          });
        }),
      };
    }
    return {
      head: COLS.map(function (c) { return c[1]; }),
      body: sorted(state.rows).map(function (r) {
        return COLS.map(function (c) {
          var v = r[c[0]];
          if (c[0] === 'authExpiryDate' || c[0] === 'joiningDate') return fmtDate(v) === '—' ? '' : fmtDate(v);
          return String(v == null ? '' : v);
        });
      }),
    };
  }
  function exportName() {
    return 'onboarding-' + (state.page ? state.page.replace('/', '') : 'dashboard');
  }
  function download(bytes, name, type) {
    var b = new Blob([bytes], { type: type }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100);
  }
  function exportCsv() {
    var d = exportRows();
    var q = function (v) {
      v = String(v == null ? '' : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    download('﻿' + [d.head].concat(d.body).map(function (r) { return r.map(q).join(','); }).join('\r\n'),
             exportName() + '.csv', 'text/csv;charset=utf-8;');
  }
  function exportXlsx() {
    var d = exportRows();
    download(buildXlsx([d.head].concat(d.body)), exportName() + '.xlsx',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  /* Hand-rolled OOXML + ZIP, same as hrms-jobs-table.js — there is no bundler,
     so a spreadsheet library cannot be added. */
  function buildXlsx(rows) {
    function cl(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 | 0; } return s; }
    function xe(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var sr = rows.map(function (row, ri) {
      return '<row r="' + (ri + 1) + '">' + row.map(function (val, ci) {
        var ref = cl(ci) + (ri + 1);
        return (typeof val === 'number' && isFinite(val))
          ? '<c r="' + ref + '"><v>' + val + '</v></c>'
          : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xe(val) + '</t></is></c>';
      }).join('') + '</row>';
    }).join('');
    var files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Onboarding" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sr + '</sheetData></worksheet>' },
    ];
    return zipStore(files);
  }
  var CRCT = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
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
    var all = parts.concat(central, [end]), total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; });
    return out;
  }

  function toggleExportMenu(anchor) {
    var old = document.getElementById(ID.menu);
    if (old) { old.remove(); return; }
    var m = document.createElement('div');
    m.id = ID.menu;
    m.className = 'ob-menu';
    m.innerHTML = '<button data-x="csv">Export CSV</button>' +
                  '<button data-x="xlsx">Export Excel (.xlsx)</button>' +
                  '<button data-x="pdf">Export PDF (print)</button>';
    anchor.parentElement.appendChild(m);
    m.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        m.remove();
        if (b.dataset.x === 'csv') exportCsv();
        else if (b.dataset.x === 'xlsx') exportXlsx();
        else window.print();   // the browser's "Save as PDF" — see the @media print rules
      });
    });
    setTimeout(function () {
      document.addEventListener('click', function h() {
        var mm = document.getElementById(ID.menu);
        if (mm) mm.remove();
        document.removeEventListener('click', h);
      });
    }, 0);
  }

  /* ── render + routing ─────────────────────────────────────────────────── */
  var TITLES = {
    '': ['Onboarding Dashboard', 'Work authorization, documents and employee onboarding at a glance.'],
    '/candidates': ['Candidates', 'Every person currently being onboarded.'],
    '/work-auth': ['Work Authorization', 'Visa status and expiry across all candidates.'],
    '/documents': ['Documents', 'Open a candidate to upload, preview or replace their documents.'],
    '/verification': ['HR Verification', 'Check documents and clear candidates for approval.'],
    '/assets': ['IT Asset Allocation', 'Hand over and track hardware.'],
    '/payroll': ['Payroll Information', 'Bank and tax details. Restricted to Payroll Admins.'],
    '/settings': ['Onboarding Settings', 'How this module is configured.'],
  };

  function render() {
    var root = document.getElementById(ID.root);
    if (!root) return;
    var t = TITLES[state.page] || TITLES[''];
    var body;
    if (state.page === '') body = viewDashboard();
    else if (state.page === '/settings') body = viewSettings();
    else if (state.page === '/candidates') body = viewGrid();
    else if (STAGE_PAGES[state.page]) body = viewStage();
    else body = viewGrid();

    root.innerHTML = '<div class="ob-h" style="margin-bottom:6px"><h2>' + t[0] + '</h2></div>' +
                     '<div class="ob-sub">' + t[1] + '</div>' + body;

    // React still owns the topbar and would otherwise keep showing the title of
    // whatever route it thinks we are on ("Settings").
    var tt = document.querySelector('.topbar-title');
    if (tt) tt.textContent = t[0];

    wire(root);
  }

  function wire(root) {
    var onStage = !!STAGE_PAGES[state.page];
    var s = root.querySelector('#ob-search');
    if (s) {
      s.addEventListener('input', function () {
        state.search = s.value;
        state.pg = 1;
        if (onStage) {
          // Stage lists are already in memory — filter locally, no round-trip.
          var pos = s.selectionStart;
          render();
          var s2 = document.getElementById('ob-search');
          if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
          return;
        }
        clearTimeout(s._t);
        s._t = setTimeout(loadCandidates, 280);   // debounce: one request per pause, not per keystroke
      });
    }
    var fs = root.querySelector('#ob-fstatus');
    if (fs) fs.addEventListener('change', function () { state.filters.status = fs.value; state.pg = 1; loadCandidates(); });
    var fa = root.querySelector('#ob-fauth');
    if (fa) fa.addEventListener('change', function () { state.filters.authType = fa.value; state.pg = 1; loadCandidates(); });
    var ps = root.querySelector('#ob-psize');
    if (ps) ps.addEventListener('change', function () { state.pageSize = +ps.value; state.pg = 1; loadCandidates(); });
    var pv = root.querySelector('#ob-prev');
    if (pv) pv.addEventListener('click', function () { if (state.pg > 1) { state.pg--; loadCandidates(); } });
    var nx = root.querySelector('#ob-next');
    if (nx) nx.addEventListener('click', function () { state.pg++; loadCandidates(); });
    var nw = root.querySelector('#ob-new');
    if (nw) nw.addEventListener('click', onbOpenForm);
    var ex = root.querySelector('#ob-export');
    if (ex) ex.addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(ex); });

    root.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = 1; }
        render();
      });
    });
    root.querySelectorAll('tbody tr[data-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openDetail(+tr.dataset.id, PAGE_TAB[state.page] || 'overview');
      });
    });
    root.querySelectorAll('.ob-al[data-cid]').forEach(function (a) {
      a.addEventListener('click', function () { openDetail(+a.dataset.cid, 'workauth'); });
    });
  }

  /* ── routing ──────────────────────────────────────────────────────────────
     The React bundle has NO /onboarding route, and its catch-all redirects
     unknown paths to '/' for non-admin roles. Two consequences we must handle,
     or the module is simply unreachable for Manager / IT Admin / Payroll Admin:

       1. Never hand an /onboarding URL to React Router. Our sidebar links are
          intercepted below and navigated with history.pushState, which React
          Router does not observe — so it cannot redirect us.
       2. A deep link or an F5 still boots React at /onboarding, which bounces
          to '/'. We re-assert the URL when that happens (`armed` below).

     `armed` holds the onboarding path we intend to be on. It is cleared the
     moment the user genuinely navigates elsewhere, so we never fight a real
     navigation — we only undo React's bounce, which always lands on '/'.
  */
  function pageFor(pathname) {
    var p = String(pathname || '').replace(/\/+$/, '');
    if (p === BASE) return '';
    if (p.indexOf(BASE + '/') === 0) return p.slice(BASE.length);
    return null;   // not one of ours
  }
  function currentPage() { return pageFor(location.pathname); }

  /* The URL the browser was ORIGINALLY asked for.
     We cannot read it from location: this script tag sits after the React
     module tag, so the bundle has already booted and rewritten location by the
     time we evaluate — location.pathname would just read '/' and we would have
     nothing to restore. The Navigation Timing entry records the requested URL
     and is unaffected by client-side redirects. */
  function requestedPath() {
    try {
      var nav = (performance.getEntriesByType('navigation') || [])[0];
      if (nav && nav.name) return new URL(nav.name, location.origin).pathname;
    } catch (_) {}
    return location.pathname;
  }

  var armed = pageFor(requestedPath());

  function navigate(page) {
    armed = page;
    history.pushState({}, '', BASE + page);
    ensureLayout();
    // No popstate is fired (that would wake React Router and re-trigger the
    // redirect), so nudge the access guard by hand.
    if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
  }

  function onNavClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('a.nav-item') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href === BASE || href.indexOf(BASE + '/') === 0) {
      // Ours: bypass React Router entirely. Capture phase + stopPropagation so
      // the generic NAV_INJECT handler in hrms-perms.js (which would call
      // __reactRouterNavigate) never sees the click.
      e.preventDefault();
      e.stopPropagation();
      navigate(href === BASE ? '' : href.slice(BASE.length));
    } else {
      armed = null;   // a real navigation away — stop re-asserting our URL
    }
  }

  function ensureLayout() {
    var page = currentPage();

    // React bounced our deep link. Its catch-all always lands on '/', so that
    // is the only case we undo — anywhere else is a genuine navigation and we
    // must not fight it.
    if (page === null && armed !== null && location.pathname === '/') {
      history.replaceState({}, '', BASE + armed);
      page = armed;
      if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
    }

    if (page === null) {
      var old = document.getElementById(ID.root);
      if (old) { old.remove(); closeDrawer(); }
      // Give React's own page back when we navigate away.
      var c = document.querySelector('.content');
      if (c && c.dataset.obHidden) { c.style.display = ''; delete c.dataset.obHidden; }
      return;
    }
    armed = page;
    var main = document.querySelector('.main');
    var content = document.querySelector('.content');
    if (!main) return;

    ensureStyle();

    // React renders nothing meaningful for /onboarding/* (it has no such route),
    // so hide its content pane rather than letting a blank view show through.
    if (content && content.style.display !== 'none') {
      content.style.display = 'none';
      content.dataset.obHidden = '1';
    }

    var root = document.getElementById(ID.root);
    var changed = page !== state.page;
    if (!root) {
      root = document.createElement('div');
      root.id = ID.root;
      main.appendChild(root);
      changed = true;
    }
    if (root.parentElement !== main) main.appendChild(root);
    if (!changed) return;

    state.page = page;
    state.pg = 1;
    state.search = '';
    state.sortKey = null;
    state.sortDir = 1;
    state.list = [];
    state.stageErr = '';
    if (page === '') { state.dash = null; loadDashboard(); }
    else if (page === '/settings') render();
    else if (page === '/candidates') { state.sortKey = 'createdAt'; state.sortDir = -1; loadCandidates(); }
    else if (STAGE_PAGES[page]) loadStage();
    else render();
  }

  function start() {
    // Capture phase: must run before the nav-item's own click handler.
    document.addEventListener('click', onNavClick, true);
    // The form-builder engine creates candidates; when it does, open the new
    // candidate's drawer at the next stage and refresh whatever list is showing.
    window.addEventListener('hrmsOnbCandidateCreated', function (e) {
      state.fieldDefs = null;   // schema/labels may have changed
      if (state.page === '') loadDashboard(); else if (STAGE_PAGES[state.page]) loadStage(); else loadCandidates();
      var id = e && e.detail && e.detail.id;
      if (id) openDetail(id, 'workauth');
    });
    // Republish from the builder → refresh cached labels + settings view.
    window.addEventListener('hrmsOnbFormPublished', function () {
      state.fieldDefs = null;
      if (state.page === '/settings') render();
    });
    ensureLayout();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; ensureLayout(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () {
      // Back/forward is a real navigation: trust the URL it lands on.
      armed = currentPage();
      setTimeout(ensureLayout, 60);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
