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

  /* Mirrors the server's ONBOARDING_STAGES / WORK_AUTH_FIELDS. Kept in sync by
     hand: the server rejects anything it does not recognise, so a drift here
     surfaces as a 400 rather than as bad data. */
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

  var WORK_AUTH_FIELDS = {
    'H1B': [['petitionNumber', 'Petition Number'], ['uscisReceipt', 'USCIS Receipt'],
            ['lcaNumber', 'LCA Number'], ['visaExpiry', 'Visa Expiry', 'date']],
    'F1': [['university', 'University'], ['sevisNumber', 'SEVIS Number'],
           ['optStart', 'OPT Start', 'date'], ['optEnd', 'OPT End', 'date'],
           ['cptDetails', 'CPT Details']],
    'GC EAD': [['eadNumber', 'EAD Number'], ['issueDate', 'Issue Date', 'date'],
               ['expiryDate', 'Expiry Date', 'date']],
    'H4 EAD': [['h4ReceiptNumber', 'H4 Receipt Number'], ['eadNumber', 'EAD Number'],
               ['expiry', 'Expiry', 'date']],
    'US Citizen': [],
    'Other': [['visaType', 'Visa Type'], ['visaNumber', 'Visa Number'],
              ['issueDate', 'Issue Date', 'date'], ['expiryDate', 'Expiry Date', 'date'],
              ['notes', 'Notes']],
  };
  var AUTH_TYPES = ['F1', 'H1B', 'GC EAD', 'US Citizen', 'H4 EAD', 'Other'];
  var AUTH_STATUSES = ['Active', 'Pending', 'Expired', 'Extension Filed', 'Transferred', 'Rejected'];
  var CAND_STATUSES = [
    'New', 'Offer Released', 'Accepted', 'Documents Pending', 'Work Authorization Pending',
    'Verification Pending', 'Payroll Pending', 'IT Asset Pending', 'Onboarding Completed', 'Rejected',
  ];
  var DOC_TYPES = [['ssn', 'SSN', 1], ['driver_license', 'Driver License', 0],
                   ['state_id', 'State ID', 0], ['visa', 'Visa (Work Authorization)', 0],
                   ['i94', 'I-94', 0]];
  var EVERSOFT_ASSETS = ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'Dock', 'Bag', 'Headset'];
  var ASSET_STATUSES = ['Assigned', 'Returned', 'Lost', 'Damaged'];
  var MAX_MB = 10;
  var ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];
  var PAGE_SIZES = [10, 15, 25, 50, 100];

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
    cols: null,               // candidate-grid column config; see loadColPrefs()
    loaded: false,            // candidate roster fully loaded (client-side model)
    buFilter: null,           // Edit Filters → Business Unit (department) selection
    predef: 'all',            // Edit Filters → pre-defined quick filter
    customFilters: [],        // Edit Filters → custom "contains" rules: [{key,val}]
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
    // 'completed' matches both the stage status and 'Onboarding Completed'.
    if (s.indexOf('completed') !== -1 || s === 'approved' || s === 'onboarded' || s === 'active') return 'ok';
    if (s === 'rejected' || s === 'expired' || s === 'lost' || s === 'damaged') return 'err';
    // Any '… Pending' status, plus in-progress stages, read as warn.
    if (s.indexOf('in progress') !== -1 || s.indexOf('pending') !== -1 || s === 'extension filed') return 'warn';
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
      /* Edit Columns drawer (reuses .ob-ov / .ob-dw / .ob-dw-h / .ob-x) */
      '.ob-cd{width:min(400px,100%)}',
      '.ob-cd-sub{padding:15px 22px 6px;font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--muted,#8a9bb8)}',
      '.ob-cd-list{flex:1;overflow-y:auto;padding:10px 16px 16px}',
      '.ob-cd-i{display:flex;align-items:center;gap:10px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:9px;padding:10px 12px;margin-bottom:7px;cursor:grab}',
      '.ob-cd-i.drag{opacity:.4}',
      '.ob-cd-i.over{border-color:var(--accent,#4f8ef7)}',
      '.ob-cd-grip{color:var(--muted,#8a9bb8);font-size:14px;letter-spacing:-2px;cursor:grab;user-select:none}',
      '.ob-cd-i label{flex:1;display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text,#e6edf7);cursor:pointer;margin:0}',
      '.ob-cd-i input{width:16px;height:16px;accent-color:var(--accent,#4f8ef7);cursor:pointer;flex-shrink:0}',
      '.ob-cd-f{display:flex;gap:10px;padding:16px 22px;border-top:1px solid var(--border,#2a3446)}',
      '.ob-cd-f .ob-btn{flex:1;text-align:center}',
      /* Progress column cell */
      '.ob-prog{display:flex;align-items:center;gap:8px;min-width:120px}',
      '.ob-prog-bar{flex:1;height:6px;border-radius:4px;background:var(--bg3,#1c2433);overflow:hidden}',
      '.ob-prog-bar i{display:block;height:100%;background:var(--accent,#4f8ef7)}',
      '.ob-prog span{font-size:11px;color:var(--muted,#8a9bb8);font-weight:600;min-width:30px;text-align:right}',
      /* Edit Filters drawer + active-filter button */
      '.ob-btn.active{border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7)}',
      '.ob-fbadge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;',
      'border-radius:9px;background:var(--accent,#4f8ef7);color:#fff;font-size:10px;font-weight:700;margin-left:4px}',
      '.ob-fd-body{flex:1;overflow-y:auto;padding:6px 22px 16px}',
      '.ob-fd-sec{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#8a9bb8);margin:16px 0 8px}',
      '.ob-fd-bu{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:9px;padding:6px 10px;max-height:190px;overflow-y:auto}',
      '.ob-fd-bu label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text,#e6edf7);padding:5px 2px;cursor:pointer}',
      '.ob-fd-bu input,.ob-fd-pd input{width:15px;height:15px;accent-color:var(--accent,#4f8ef7);cursor:pointer;flex-shrink:0}',
      '.ob-fd-empty{color:var(--muted,#8a9bb8);font-size:12px;padding:6px 2px}',
      '.ob-fd-pd{display:grid;gap:8px}',
      '.ob-fd-pd label{display:flex;align-items:center;gap:10px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text,#e6edf7);cursor:pointer}',
      '.ob-fd-pd label:hover{border-color:var(--accent,#4f8ef7)}',
      '.ob-fd-add{color:var(--accent,#4f8ef7);font-size:12.5px;font-weight:700;cursor:pointer;background:none;border:none;padding:12px 0 4px}',
      '.ob-fd-cf{display:flex;gap:6px;margin-bottom:6px}',
      '.ob-fd-cf select,.ob-fd-cf input{flex:1;min-width:0;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:7px;color:var(--text,#e6edf7);font:inherit;font-size:12px;padding:7px 8px}',
      '.ob-fd-cfx{flex:0 0 auto;width:30px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:7px;color:#ef4444;cursor:pointer}',
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

  /* ── data ─────────────────────────────────────────────────────────────────
     Load the FULL candidate roster into memory, then search / filter / sort /
     paginate entirely client-side — the same model as the Job Board grid. This
     is what lets the Edit Filters drawer (Business Unit, pre-defined, custom
     "contains") and sorting work across every record rather than one page.

     The server caps pageSize at 200, so page through until the whole roster is
     collected (bounded by a safety cap so a huge table can't spin forever). */
  var LOAD_PS = 200, LOAD_MAX_PAGES = 100;
  function loadCandidates() {
    state.loading = true;
    state.loaded = false;
    render();
    function finish(items) {
      state.rows = items;
      state.total = items.length;   // full loaded count (viewGrid shows the filtered count)
      state.loaded = true;
      state.loading = false;
      render();
    }
    api('/onboarding/candidates?page=1&pageSize=' + LOAD_PS).then(function (d) {
      var items = (d && d.items) || [];
      var total = (d && d.total) || items.length;
      var pages = Math.min(Math.ceil(total / LOAD_PS), LOAD_MAX_PAGES);
      if (pages <= 1) { finish(items); return; }
      var reqs = [];
      for (var p = 2; p <= pages; p++) reqs.push(api('/onboarding/candidates?page=' + p + '&pageSize=' + LOAD_PS));
      Promise.all(reqs).then(function (rest) {
        rest.forEach(function (r) { items = items.concat((r && r.items) || []); });
        finish(items);
      }).catch(function () { finish(items); });   // a partial roster beats none
    }).catch(function (e) {
      state.rows = []; state.loaded = true; state.loading = false; render();
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

  /* ── sorting (client-side, across the whole loaded roster) ────────────── */
  function sortVal(row, k) { return k === 'progress' ? progressPct(row) : row[k]; }
  function sorted(rows) {
    var k = state.sortKey, dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var x = sortVal(a, k), y = sortVal(b, k);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      if (x == null) x = ''; if (y == null) y = '';
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }

  /* ── filtering (client-side) ──────────────────────────────────────────────
     Combines the inline Search + Status + Work Auth controls with the Edit
     Filters drawer (Business Unit, pre-defined, custom "contains"). */
  function cellRaw(row, key) {
    if (key === 'progress') return progressPct(row) + '%';
    var v = row[key];
    return v == null ? '' : String(v);
  }
  function distinctVals(key) {
    var seen = {}, out = [];
    state.rows.forEach(function (r) {
      var v = String(r[key] == null ? '' : r[key]);
      if (!(v in seen)) { seen[v] = 1; out.push(v); }
    });
    return out.sort();
  }
  // Pre-defined quick filters offered in the Edit Filters drawer.
  var CAND_PREDEF = [
    ['all', 'All Candidates'], ['inprogress', 'In Progress'],
    ['completed', 'Onboarding Completed'], ['rejected', 'Rejected'],
    ['expiringAuth', 'Work Auth Expiring (≤60d)'], ['expiredAuth', 'Work Auth Expired'],
    ['noAuth', 'No Work Authorization'],
  ];
  function matchPredef(r) {
    var s = String(r.status || '').toLowerCase();
    var d = daysTo(r.authExpiryDate);
    switch (state.predef) {
      case 'inprogress': return s.indexOf('completed') === -1 && s.indexOf('activated') === -1 && s !== 'rejected';
      case 'completed': return s.indexOf('completed') !== -1 || s.indexOf('activated') !== -1;
      case 'rejected': return s === 'rejected';
      case 'expiringAuth': return d != null && d >= 0 && d <= 60;
      case 'expiredAuth': return d != null && d < 0;
      case 'noAuth': return !r.authType;
      default: return true;
    }
  }
  function filteredRows() {
    var q = (state.search || '').toLowerCase();
    return state.rows.filter(function (r) {
      if (q) {
        var hay = ((r.name || '') + ' ' + (r.email || '') + ' ' + (r.jobTitle || '') + ' ' +
                   (r.candidateCode || '') + ' ' + (r.phone || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      if (state.filters.status && r.status !== state.filters.status) return false;
      if (state.filters.authType && r.authType !== state.filters.authType) return false;
      if (state.buFilter && state.buFilter.indexOf(String(r.department || '')) === -1) return false;
      if (state.predef !== 'all' && !matchPredef(r)) return false;
      for (var i = 0; i < state.customFilters.length; i++) {
        var cf = state.customFilters[i];
        if (cf.val && cellRaw(r, cf.key).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }
  function activeFilterCount() {
    var n = 0;
    if (state.buFilter) n++;
    if (state.predef && state.predef !== 'all') n++;
    n += state.customFilters.filter(function (c) { return c.val; }).length;
    return n;
  }

  /* ── page: dashboard ──────────────────────────────────────────────────── */
  var CARDS = [
    // The four headline cards from the spec.
    ['totalCandidates', 'Total Candidates', ''],
    ['pendingCandidates', 'Pending Candidates', 'alert'],
    ['completedCandidates', 'Completed Candidates', ''],
    ['rejectedCandidates', 'Rejected Candidates', 'bad'],
    // Supplementary operational counters.
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

  /* ── page: candidate grid ─────────────────────────────────────────────────
     Salesforce / HubSpot-style column management. The grid renders from a
     user-customisable, ordered, show/hide column set (state.cols) that is
     persisted to localStorage and restored on load — the same idea as the Job
     Board module's "Edit Column" drawer, adapted to this module's styling. */

  // Default columns — shown out of the box, in this order.
  var DEFAULT_COLS = [
    ['candidateCode', 'Candidate Code'], ['name', 'Candidate Name'], ['email', 'Email'],
    ['phone', 'Phone'], ['department', 'Department'], ['jobTitle', 'Designation'],
    ['manager', 'Manager'], ['workLocation', 'Location'], ['authType', 'Work Authorization'],
    ['authExpiryDate', 'Work Authorization Expiry'], ['status', 'Status'], ['joiningDate', 'Joining Date'],
    ['createdAt', 'Created Date'],
  ];
  // Optional columns — hidden by default, offered in the Edit Columns drawer.
  // (The spec's "Work Location" and "Current Status" read the same underlying
  //  fields as the default Location and Status columns, so they aren't duplicated.)
  var OPTIONAL_COLS = [
    ['dob', 'Date of Birth'], ['gender', 'Gender'], ['address', 'Address'],
    ['client', 'Client'], ['vendor', 'Vendor'], ['recruiter', 'Recruiter'],
    ['progress', 'Progress'],
  ];
  var ALL_COLS = DEFAULT_COLS.concat(OPTIONAL_COLS);
  var COLS = DEFAULT_COLS;                        // legacy alias (kept inert)
  var LS_COLS = 'hrms_ob_candidate_columns_v1';   // {key,on}[] in display order

  function colByKey(key) {
    for (var i = 0; i < ALL_COLS.length; i++) if (ALL_COLS[i][0] === key) return ALL_COLS[i];
    return [key, key];
  }
  function colLabel(key) { return colByKey(key)[1]; }

  // Out-of-the-box configuration: defaults visible, optionals hidden.
  function defaultColState() {
    return DEFAULT_COLS.map(function (c) { return { key: c[0], on: true }; })
      .concat(OPTIONAL_COLS.map(function (c) { return { key: c[0], on: false }; }));
  }
  // Restore saved visibility + order, reconciled against the current catalog:
  // unknown keys are dropped and newly-added columns are appended at their
  // default visibility, so an upgrade never loses or orphans a column.
  function loadColPrefs() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_COLS) || 'null'); } catch (_) {}
    var known = {}; ALL_COLS.forEach(function (c) { known[c[0]] = 1; });
    var cols;
    if (Array.isArray(saved) && saved.length) {
      var seen = {};
      cols = saved
        .filter(function (c) { return c && c.key && known[c.key] && !seen[c.key] && (seen[c.key] = 1); })
        .map(function (c) { return { key: c.key, on: c.on !== false }; });
      defaultColState().forEach(function (dc) {
        if (!cols.some(function (c) { return c.key === dc.key; })) cols.push(dc);
      });
    } else {
      cols = defaultColState();
    }
    state.cols = cols;
  }
  function saveColPrefs() { try { localStorage.setItem(LS_COLS, JSON.stringify(state.cols)); } catch (_) {} }
  function ensureCols() { if (!state.cols || !state.cols.length) loadColPrefs(); }
  function shownCols() { ensureCols(); return state.cols.filter(function (c) { return c.on; }); }

  // Onboarding progress as a % of completed stages — powers the optional
  // Progress column and its sort value.
  function progressPct(row) {
    var stages = row && row.stages;
    if (stages && stages.length) {
      var done = 0;
      stages.forEach(function (s) {
        var st = String(s.status || '').toLowerCase();
        if (s.completedAt || st.indexOf('complete') !== -1 || st === 'approved' || st === 'done' || st === 'active') done++;
      });
      return Math.min(100, Math.round(done / STAGES.length * 100));
    }
    var ss = String(row && row.status || '').toLowerCase();
    if (ss.indexOf('completed') !== -1 || ss === 'activated' || ss === 'active') return 100;
    return 0;
  }

  /* Small inline action buttons for the grid's Actions column. Gated by the
     same RBAC codes the drawer uses. */
  function rowActions(r) {
    var mini = 'style="padding:3px 8px;font-size:11px"';
    var b = '<button class="ob-btn" ' + mini + ' data-act="view" data-id="' + r.id + '">View</button>';
    if (can('onboarding.edit')) b += ' <button class="ob-btn" ' + mini + ' data-act="edit" data-id="' + r.id + '">Edit</button>';
    if (can('onboarding.delete')) b += ' <button class="ob-btn danger" ' + mini + ' data-act="del" data-id="' + r.id + '">Delete</button>';
    return b;
  }

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
    if (key === 'createdAt') return fmtDate(row.createdAt);
    if (key === 'dob') return fmtDate(row.dob);
    if (key === 'progress') {
      var pp = progressPct(row);
      return '<div class="ob-prog" title="' + pp + '% complete">' +
             '<div class="ob-prog-bar"><i style="width:' + pp + '%"></i></div><span>' + pp + '%</span></div>';
    }
    return esc(row[key] || '—');
  }

  var ICON_COLUMNS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="4" width="5.5" height="16" rx="1"/>' +
    '<rect x="9.5" y="4" width="5.5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/></svg>';
  var ICON_FILTERS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:6px"><line x1="4" y1="7" x2="20" y2="7"/>' +
    '<circle cx="9" cy="7" r="2.4" fill="var(--bg2,#141b26)"/><line x1="4" y1="17" x2="20" y2="17"/>' +
    '<circle cx="15" cy="17" r="2.4" fill="var(--bg2,#141b26)"/></svg>';

  function viewGrid() {
    var cols = shownCols();
    var span = cols.length + 1;   // + Actions column
    // Filter → sort → paginate, all client-side over the full loaded roster.
    var all = sorted(filteredRows());
    var total = all.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.pg > pages) state.pg = pages;
    var start = (state.pg - 1) * state.pageSize;
    var pageRows = all.slice(start, start + state.pageSize);
    var from = total ? start + 1 : 0;
    var to = Math.min(start + state.pageSize, total);
    var afc = activeFilterCount();

    var body;
    if (state.loading) {
      body = new Array(6).join('x').split('x').map(function () {
        return '<tr>' + cols.map(function () { return '<td><div class="ob-skel"></div></td>'; }).join('') +
               '<td><div class="ob-skel"></div></td></tr>';
      }).join('');
    } else if (!total) {
      body = '<tr><td colspan="' + span + '"><div class="ob-empty"><div class="big">📋</div>' +
             (state.search || state.filters.status || state.filters.authType || afc
               ? 'No candidates match these filters.'
               : 'No candidates yet. Add the first one to get started.') +
             '</div></td></tr>';
    } else {
      body = pageRows.map(function (r) {
        return '<tr data-id="' + r.id + '">' + cols.map(function (c) {
          return '<td>' + cell(r, c.key) + '</td>';
        }).join('') +
        '<td class="ob-actions">' + rowActions(r) + '</td></tr>';
      }).join('');
    }

    var head = cols.map(function (c) {
      var arrow = state.sortKey === c.key ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-sort="' + c.key + '">' + esc(colLabel(c.key)) + arrow + '</th>';
    }).join('') + '<th>Actions</th>';

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
        '<button class="ob-btn' + (afc ? ' active' : '') + '" id="ob-filters" title="Edit Filters">' + ICON_FILTERS + 'Filters' +
          (afc ? '<span class="ob-fbadge">' + afc + '</span>' : '') + '</button>' +
        '<button class="ob-btn" id="ob-columns" title="Show, hide and reorder columns">' + ICON_COLUMNS + 'Manage Columns</button>' +
        '<div style="position:relative"><button class="ob-btn" id="ob-export">⭳ Export ▾</button></div>' +
        (can('onboarding.create') ? '<button class="ob-btn primary" id="ob-new">+ New Candidate</button>' : '') +
      '</div>' +
      '<div class="ob-wrap"><table class="ob-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="ob-pg">' +
        '<span>Showing ' + from + '–' + to + ' of ' + total + ' records</span>' +
        '<select class="ob-sel" id="ob-psize" style="width:auto;padding:4px 8px">' +
          PAGE_SIZES.map(function (n) {
            return '<option' + (state.pageSize === n ? ' selected' : '') + '>' + n + '</option>';
          }).join('') + '</select>' +
        '<span>rows per page</span>' +
        '<span class="sp"></span>' +
        '<button class="ob-btn" id="ob-prev"' + (state.pg <= 1 ? ' disabled' : '') + '>‹ Previous</button>' +
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
    return on ? badge(label, 'ok') : badge('—', 'neutral');
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
        ['ssn', 'SSN', function (r) { return chip(r.docs.ssn, 'v' + (r.docs.ssn ? r.docs.ssn.version : '')); }],
        ['driver_license', 'Driver License', function (r) { return chip(r.docs.driver_license, 'Uploaded'); }],
        ['state_id', 'State ID', function (r) { return chip(r.docs.state_id, 'Uploaded'); }],
        ['visa', 'Visa', function (r) { return chip(r.docs.visa, 'Uploaded'); }],
        ['i94', 'I-94', function (r) { return chip(r.docs.i94, 'Uploaded'); }],
        ['uploaded', 'Uploaded', function (r) { return r.uploaded + ' / 5'; }],
        ['missing', 'Missing', function (r) {
          return r.missing.length ? badge(r.missing.join(', '), 'err') : badge('Complete', 'ok');
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

  /* ── page: settings (read-only module config) ─────────────────────────── */
  function viewSettings() {
    function rows(list) {
      return list.map(function (r) {
        return '<div class="ob-row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
      }).join('');
    }
    return '<div class="ob-grid2">' +
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
      '<div class="ob-panel"><h3>Work Authorization Types</h3>' + rows(AUTH_TYPES.map(function (t) {
        var f = WORK_AUTH_FIELDS[t];
        return [t, f.length ? f.length + ' field(s)' : 'no extra fields'];
      })) + '</div>' +
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
    ['payroll', 'Payroll'], ['timeline', 'Timeline'],
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
          return '<button class="ob-tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
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
    var canEdit = can('onboarding.edit');
    function row(k, v) {
      return '<div class="ob-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    }
    function heading(t) {
      return '<div class="ob-lb" style="font-size:13px;margin:18px 0 4px;color:var(--text,#e6edf7)">' + t + '</div>';
    }
    el.innerHTML =
      heading('Personal Information').replace('margin:18px', 'margin:2px') +
      row('Candidate Code', esc(c.candidateCode || '—')) +
      row('Name', esc(c.name || '—')) +
      row('Email', esc(c.email)) +
      row('Phone', esc(c.phone || '—')) +
      row('Date of Birth', fmtDate(c.dob)) +
      row('Gender', esc(c.gender || '—')) +
      row('Address', esc(c.address || '—')) +
      heading('Professional Information') +
      row('Designation', esc(c.jobTitle || '—')) +
      row('Department', esc(c.department || '—')) +
      row('Manager', esc(c.manager || '—')) +
      row('Work Location', esc(c.workLocation || '—')) +
      row('Client', esc(c.client || '—')) +
      row('Vendor', esc(c.vendor || '—')) +
      row('Recruiter', esc(c.recruiter || '—')) +
      row('Joining Date', fmtDate(c.joiningDate)) +
      heading('Onboarding') +
      row('Current Status', badge(c.status, statusKind(c.status))) +
      row('Progress', done + ' / ' + STAGES.length + ' stages') +
      (canEdit
        ? '<div style="margin-top:12px"><label class="ob-lb">Change Status</label>' +
          '<div style="display:flex;gap:8px">' +
            '<select class="ob-sel" id="ov-status" style="flex:1">' +
              CAND_STATUSES.map(function (s) {
                return '<option' + (c.status === s ? ' selected' : '') + '>' + s + '</option>';
              }).join('') +
            '</select>' +
            '<button class="ob-btn" id="ov-status-btn" style="white-space:nowrap">Change Status</button>' +
          '</div></div>'
        : '') +
      '<div class="ob-act">' +
        (canEdit ? '<button class="ob-btn" id="ob-edit">✎ Edit Candidate</button>' : '') +
        (canActivate && canEdit
          ? '<button class="ob-btn primary" id="ob-activate">✓ Activate Employee</button>' : '') +
        (can('onboarding.delete')
          ? '<button class="ob-btn danger" id="ob-del">Delete Candidate</button>' : '') +
      '</div><div class="ob-err" id="ob-e"></div>';

    var editBtn = el.querySelector('#ob-edit');
    if (editBtn) editBtn.addEventListener('click', function () { openCandidateModal(c); });

    var sBtn = el.querySelector('#ov-status-btn');
    if (sBtn) sBtn.addEventListener('click', function () {
      var ns = el.querySelector('#ov-status').value;
      var errEl = el.querySelector('#ob-e');
      if (ns === c.status) { errEl.textContent = 'That is already the current status.'; return; }
      // Confirmation dialog before a manual status change, per the workflow spec.
      if (!confirm('Change status of ' + (c.name || c.email) + ' to "' + ns + '"?')) return;
      sBtn.disabled = true; errEl.textContent = '';
      api('/onboarding/candidates/' + c.id, { method: 'PATCH', body: { status: ns } })
        .then(function () { toast('Status changed to ' + ns); refreshDetail(); })
        .catch(function (e) { sBtn.disabled = false; errEl.textContent = e.message; });
    });

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

  /* -- work authorization (the dynamic form) -- */
  function tabWorkAuth(el, c) {
    api('/onboarding/candidates/' + c.id + '/work-authorization').then(function (a) {
      a = a || {};
      var ro = !can('onboarding.edit');
      el.innerHTML =
        '<div class="ob-f">' +
          '<div><label class="ob-lb">Work Authorization Type <span class="req">*</span></label>' +
            '<select class="ob-sel" id="wa-type"' + (ro ? ' disabled' : '') + '>' +
              '<option value="">Select…</option>' +
              AUTH_TYPES.map(function (t) {
                return '<option' + (a.authType === t ? ' selected' : '') + '>' + t + '</option>';
              }).join('') + '</select></div>' +
          '<div><label class="ob-lb">Status</label><select class="ob-sel" id="wa-status"' + (ro ? ' disabled' : '') + '>' +
            AUTH_STATUSES.map(function (t) {
              return '<option' + (a.status === t ? ' selected' : '') + '>' + t + '</option>';
            }).join('') + '</select></div>' +
          '<div><label class="ob-lb">Expiry Date</label><input type="date" class="ob-in" id="wa-expiry" value="' +
            esc(a.expiryDate || '') + '"' + (ro ? ' disabled' : '') + '></div>' +
          '<div><label class="ob-lb">Receipt / Case Number</label><input class="ob-in" id="wa-receipt" value="' +
            esc(a.receiptNumber || '') + '"' + (ro ? ' disabled' : '') + '></div>' +
          '<div class="full"><label class="ob-chk"><input type="checkbox" id="wa-spons"' +
            (a.sponsorshipRequired ? ' checked' : '') + (ro ? ' disabled' : '') + '> Sponsorship required</label></div>' +
          '<div class="full" id="wa-dyn"></div>' +
        '</div>' +
        (ro ? '' : '<div class="ob-act"><button class="ob-btn primary" id="wa-save">Save Work Authorization</button></div>') +
        '<div class="ob-err" id="wa-e"></div>';

      function renderDyn() {
        var type = el.querySelector('#wa-type').value;
        var box = el.querySelector('#wa-dyn');
        var fields = WORK_AUTH_FIELDS[type] || [];
        if (!type) { box.innerHTML = '<div class="ob-sub">Select a type to see its fields.</div>'; return; }
        if (!fields.length) {
          box.innerHTML = '<div class="ob-sub">A ' + esc(type) + ' needs no additional work-authorization fields.</div>';
          return;
        }
        var d = a.details || {};
        box.innerHTML = '<div class="ob-f">' + fields.map(function (f) {
          return '<div><label class="ob-lb">' + f[1] + '</label>' +
                 '<input class="ob-in" data-k="' + f[0] + '" type="' + (f[2] === 'date' ? 'date' : 'text') + '" value="' +
                 esc(d[f[0]] || '') + '"' + (ro ? ' disabled' : '') + '></div>';
        }).join('') + '</div>';
      }
      el.querySelector('#wa-type').addEventListener('change', renderDyn);
      renderDyn();

      var save = el.querySelector('#wa-save');
      if (save) save.addEventListener('click', function () {
        var e = el.querySelector('#wa-e');
        var type = el.querySelector('#wa-type').value;
        if (!type) { e.textContent = 'Select a work authorization type.'; return; }
        var details = {};
        el.querySelectorAll('#wa-dyn [data-k]').forEach(function (i) {
          if (i.value) details[i.dataset.k] = i.value;
        });
        save.disabled = true;
        e.textContent = '';
        api('/onboarding/candidates/' + c.id + '/work-authorization', {
          method: 'PUT',
          body: {
            authType: type,
            status: el.querySelector('#wa-status').value,
            expiryDate: el.querySelector('#wa-expiry').value || null,
            receiptNumber: el.querySelector('#wa-receipt').value,
            sponsorshipRequired: el.querySelector('#wa-spons').checked,
            details: details,
          },
        }).then(function () { toast('Work authorization saved'); refreshDetail(); })
          .catch(function (err) { save.disabled = false; e.textContent = err.message; });
      });
    }).catch(function (e) { el.innerHTML = '<div class="ob-err">' + esc(e.message) + '</div>'; });
  }

  /* -- documents (drag & drop, multi-upload, versions) -- */
  function tabDocuments(el, c) {
    var ro = !can('onboarding.edit');
    api('/onboarding/candidates/' + c.id + '/documents').then(function (docs) {
      docs = docs || [];
      var have = {};
      docs.forEach(function (d) { have[d.docType] = d; });

      var list = DOC_TYPES.map(function (t) {
        var d = have[t[0]];
        return '<div class="ob-row">' +
          '<span class="k">' + t[1] + (t[2] ? ' <span class="req" style="color:#ef4444">*</span>' : '') + '</span>' +
          '<span class="v">' + (d
            ? badge('v' + d.version + ' · ' + (d.fileName || 'file'), 'ok') +
              ' <button class="ob-btn" style="padding:3px 9px" data-dl="' + d.id + '">View</button>' +
              ' <button class="ob-btn" style="padding:3px 9px" data-hist="' + d.docType + '">History</button>' +
              (ro ? '' : ' <button class="ob-btn danger" style="padding:3px 9px" data-rm="' + d.id + '">Delete</button>')
            : badge('Not uploaded', t[2] ? 'err' : 'neutral')) +
          '</span></div>';
      }).join('');

      el.innerHTML =
        (ro ? '' :
          '<div class="ob-dz" id="ob-dz"><div class="big">⬆</div>' +
          '<div><b>Drag &amp; drop</b> files here, or click to choose</div>' +
          '<div class="ob-sub" style="margin:6px 0 0">PDF, PNG or JPG · max ' + MAX_MB + ' MB each</div></div>' +
          '<select class="ob-sel" id="ob-dtype" style="margin-bottom:10px">' +
            DOC_TYPES.map(function (t) {
              return '<option value="' + t[0] + '">Upload as: ' + t[1] + (t[2] ? ' (required)' : '') + '</option>';
            }).join('') + '</select>' +
          '<input type="file" id="ob-file" accept=".pdf,.png,.jpg,.jpeg" multiple hidden>' +
          '<div class="ob-bar" id="ob-bar" style="display:none"><i></i></div>') +
        '<div style="margin-top:16px">' + list + '</div>' +
        '<div class="ob-err" id="ob-de"></div>';

      el.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/onboarding/candidates/' + c.id + '/documents/' + b.dataset.dl).then(function (d) {
            // The API only ships the base64 blob on a single-document read, so
            // the preview happens here rather than from the list payload.
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
        var docType = el.querySelector('#ob-dtype').value;
        var bar = el.querySelector('#ob-bar'), fill = bar.querySelector('i');
        errEl.textContent = '';

        // Validate client-side for instant feedback; the server re-validates
        // regardless, so this is convenience, not security.
        for (var i = 0; i < files.length; i++) {
          if (ALLOWED_MIME.indexOf(files[i].type) === -1) {
            errEl.textContent = files[i].name + ': only PDF, PNG and JPG are allowed.';
            return;
          }
          if (files[i].size > MAX_MB * 1024 * 1024) {
            errEl.textContent = files[i].name + ' is ' +
              (files[i].size / 1048576).toFixed(1) + ' MB — the maximum is ' + MAX_MB + ' MB.';
            return;
          }
        }

        bar.style.display = 'block';
        var done = 0;
        var chain = files.reduce(function (p, f) {
          return p.then(function () {
            return readFile(f).then(function (b64) {
              return api('/onboarding/candidates/' + c.id + '/documents', {
                method: 'POST',
                body: { docType: docType, fileName: f.name, fileMime: f.type, fileData: b64 },
              });
            }).then(function () {
              done++;
              fill.style.width = Math.round((done / files.length) * 100) + '%';
            });
          });
        }, Promise.resolve());

        chain.then(function () {
          toast(done + ' document(s) uploaded');
          bar.style.display = 'none';
          fill.style.width = '0';
          refreshDetail();
        }).catch(function (e) {
          bar.style.display = 'none';
          fill.style.width = '0';
          errEl.textContent = e.message;
        });
      }
    });
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

  /* ── candidate modal (create + edit) ──────────────────────────────────────
     One form serves both flows. With no argument it creates (Create Candidate,
     with an initial Status); passed a candidate object it edits (Save Changes, PATCH).
  */
  var GENDERS = ['', 'Male', 'Female', 'Other', 'Prefer not to say'];

  function openCandidateModal(existing) {
    var isEdit = !!existing;
    var d = existing || {};
    var ov = document.createElement('div');
    ov.id = ID.modal;
    ov.className = 'ob-ov';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';

    function field(id, label, req, type, val) {
      return '<div><label class="ob-lb">' + label + (req ? ' <span class="req">*</span>' : '') + '</label>' +
             '<input class="ob-in" id="nc-' + id + '"' + (type ? ' type="' + type + '"' : '') +
             ' value="' + esc(val || '') + '"></div>';
    }
    function heading(t) {
      return '<div class="ob-lb full" style="font-size:13px;margin:6px 0 2px;color:var(--text,#e6edf7)">' + t + '</div>';
    }

    ov.innerHTML =
      '<div class="ob-dw" style="width:min(680px,100%);height:auto;max-height:90vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="ob-dw-h"><h3>' + (isEdit ? 'Edit Candidate' : 'New Candidate') + '</h3>' +
          '<button class="ob-x" id="nc-x">×</button></div>' +
        '<div class="ob-dw-b">' +
        (isEdit && d.candidateCode
          ? '<div class="ob-sub" style="margin-top:0">Candidate Code: <b>' + esc(d.candidateCode) + '</b></div>' : '') +
        '<div class="ob-f">' +
          heading('Personal Information') +
          field('first', 'First Name', 1, '', d.firstName) +
          field('last', 'Last Name', 0, '', d.lastName) +
          field('email', 'Email', 1, 'email', d.email) +
          field('phone', 'Phone', 0, '', d.phone) +
          field('dob', 'Date of Birth', 0, 'date', d.dob) +
          '<div><label class="ob-lb">Gender</label><select class="ob-sel" id="nc-gender">' +
            GENDERS.map(function (g) {
              return '<option value="' + g + '"' + (d.gender === g ? ' selected' : '') + '>' + (g || 'Select…') + '</option>';
            }).join('') + '</select></div>' +
          '<div class="full"><label class="ob-lb">Address</label>' +
            '<textarea class="ob-ta" id="nc-address">' + esc(d.address || '') + '</textarea></div>' +
          heading('Professional Information') +
          field('title', 'Designation', 0, '', d.jobTitle) +
          field('dept', 'Department', 0, '', d.department) +
          field('manager', 'Manager', 0, '', d.manager) +
          field('location', 'Work Location', 0, '', d.workLocation) +
          field('client', 'Client', 0, '', d.client) +
          field('vendor', 'Vendor', 0, '', d.vendor) +
          field('recruiter', 'Recruiter', 0, '', d.recruiter || (isEdit ? '' : sessionEmail())) +
          field('join', 'Joining Date', 0, 'date', d.joiningDate) +
          '<div><label class="ob-lb">Status</label><select class="ob-sel" id="nc-status">' +
            CAND_STATUSES.map(function (s) {
              return '<option' + ((d.status || 'New') === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('') + '</select></div>' +
        '</div>' +
        '<div class="ob-act">' +
          (isEdit
            ? '<button class="ob-btn primary" id="nc-savechanges">Save Changes</button>'
            : '<button class="ob-btn primary" id="nc-save">Create Candidate</button>') +
          '<button class="ob-btn" id="nc-cancel">Cancel</button>' +
        '</div>' +
        '<div class="ob-err" id="nc-e"></div></div>' +
      '</div>';
    document.body.appendChild(ov);

    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#nc-x').addEventListener('click', close);
    ov.querySelector('#nc-cancel').addEventListener('click', close);

    var e = ov.querySelector('#nc-e');
    var v = function (id) { return ov.querySelector('#nc-' + id).value.trim(); };

    function collect() {
      return {
        firstName: v('first'), lastName: v('last'), email: v('email'), phone: v('phone'),
        dob: v('dob') || null, gender: ov.querySelector('#nc-gender').value, address: v('address'),
        jobTitle: v('title'), department: v('dept'), manager: v('manager'),
        workLocation: v('location'), client: v('client'), vendor: v('vendor'),
        recruiter: v('recruiter'), joiningDate: v('join') || null,
        status: ov.querySelector('#nc-status').value,
      };
    }
    function valid() {
      if (!v('first')) { e.textContent = 'First name is required.'; return false; }
      if (!v('email')) { e.textContent = 'Email is required.'; return false; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) { e.textContent = 'Enter a valid email address.'; return false; }
      if (v('dob') && v('dob') > new Date().toISOString().slice(0, 10)) {
        e.textContent = 'Date of birth cannot be in the future.'; return false;
      }
      return true;
    }

    if (isEdit) {
      var save = ov.querySelector('#nc-savechanges');
      save.addEventListener('click', function () {
        if (!valid()) return;
        save.disabled = true; e.textContent = '';
        api('/onboarding/candidates/' + existing.id, { method: 'PATCH', body: collect() })
          .then(function () {
            close();
            toast('Candidate updated');
            if (state.detail && state.detail.id === existing.id) refreshDetail();
            else loadCandidates();
          })
          .catch(function (err) { save.disabled = false; e.textContent = err.message; });
      });
    } else {
      var saveBtn = ov.querySelector('#nc-save');
      saveBtn.addEventListener('click', function () {
        if (!valid()) return;
        saveBtn.disabled = true; e.textContent = '';
        api('/onboarding/candidates', { method: 'POST', body: collect() })
          .then(function (c) {
            close();
            toast('Candidate created');
            loadCandidates();
            openDetail(c.id, 'overview');   // open the new candidate's profile
          })
          .catch(function (err) { saveBtn.disabled = false; e.textContent = err.message; });
      });
    }
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
    var cols = shownCols();   // export matches the columns the user has chosen to see
    return {
      head: cols.map(function (c) { return colLabel(c.key); }),
      body: sorted(filteredRows()).map(function (r) {   // and respects the active filters
        return cols.map(function (c) {
          var k = c.key;
          if (k === 'authExpiryDate' || k === 'joiningDate' || k === 'dob' || k === 'createdAt') {
            var fd = fmtDate(r[k]); return fd === '—' ? '' : fd;
          }
          if (k === 'progress') return progressPct(r) + '%';
          var v = r[k];
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

  /* ── Edit Filters drawer (Business Unit + pre-defined + custom "contains") ──
     The job-board-style side panel. Business Unit is the distinct department
     set; pre-defined filters are candidate-specific quick filters; custom rows
     match "contains" against any column. Everything applies client-side. */
  var filterDrawerKey = null;
  function closeFiltersDrawer() {
    var ov = document.getElementById('hrms-ob-fdrawer');
    if (ov) ov.remove();
    if (filterDrawerKey) { document.removeEventListener('keydown', filterDrawerKey); filterDrawerKey = null; }
  }
  function openFiltersDrawer() {
    closeFiltersDrawer();
    ensureStyle();
    var depts = distinctVals('department');
    var bu = state.buFilter ? state.buFilter.slice() : depts.slice();   // default: all selected
    var predef = state.predef;
    var customs = state.customFilters.map(function (c) { return { key: c.key, val: c.val }; });

    var ov = document.createElement('div');
    ov.id = 'hrms-ob-fdrawer';
    ov.className = 'ob-ov';
    ov.innerHTML =
      '<div class="ob-dw ob-cd" role="dialog" aria-label="Edit Filters">' +
        '<div class="ob-dw-h"><h3>Edit Filters</h3><button class="ob-x" id="ob-fd-x" title="Close">×</button></div>' +
        '<div class="ob-fd-body">' +
          '<div class="ob-fd-sec" style="margin-top:0">Business Unit</div>' +
          '<div class="ob-fd-bu" id="ob-fd-bu"></div>' +
          '<div class="ob-fd-sec">Pre-Defined Filters</div>' +
          '<div class="ob-fd-pd">' + CAND_PREDEF.map(function (p) {
            return '<label><input type="radio" name="ob-fd-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '>' + esc(p[1]) + '</label>';
          }).join('') + '</div>' +
          '<div class="ob-fd-sec">Custom Filters</div>' +
          '<div id="ob-fd-cf"></div>' +
          '<button class="ob-fd-add" id="ob-fd-add">+ Add Filter</button>' +
        '</div>' +
        '<div class="ob-cd-f">' +
          '<button class="ob-btn primary" id="ob-fd-apply">Apply</button>' +
          '<button class="ob-btn" id="ob-fd-reset">Reset</button>' +
          '<button class="ob-btn" id="ob-fd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var buBox = ov.querySelector('#ob-fd-bu');
    function drawBu() {
      if (!depts.length) { buBox.innerHTML = '<div class="ob-fd-empty">No departments to filter yet.</div>'; return; }
      buBox.innerHTML =
        '<label><input type="checkbox" id="ob-fd-buall"' + (bu.length === depts.length ? ' checked' : '') + '> <b>(All selected)</b></label>' +
        depts.map(function (d) {
          return '<label><input type="checkbox" value="' + esc(d) + '"' + (bu.indexOf(d) !== -1 ? ' checked' : '') + '> ' + (d === '' ? '(blank)' : esc(d)) + '</label>';
        }).join('');
      buBox.querySelector('#ob-fd-buall').addEventListener('change', function (e) { bu = e.target.checked ? depts.slice() : []; drawBu(); });
      buBox.querySelectorAll('input[value]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var v = cb.value;
          if (cb.checked) { if (bu.indexOf(v) === -1) bu.push(v); }
          else { var i = bu.indexOf(v); if (i !== -1) bu.splice(i, 1); }
          var a = buBox.querySelector('#ob-fd-buall'); if (a) a.checked = bu.length === depts.length;
        });
      });
    }
    drawBu();

    ov.querySelectorAll('input[name="ob-fd-predef"]').forEach(function (r) { r.addEventListener('change', function () { predef = r.value; }); });

    var cfList = ov.querySelector('#ob-fd-cf');
    function drawCf() {
      cfList.innerHTML = customs.map(function (c, i) {
        return '<div class="ob-fd-cf"><select data-cfk="' + i + '">' + ALL_COLS.map(function (cc) {
          return '<option value="' + cc[0] + '"' + (cc[0] === c.key ? ' selected' : '') + '>' + esc(cc[1]) + '</option>';
        }).join('') + '</select>' +
        '<input data-cfv="' + i + '" placeholder="contains…" value="' + esc(c.val) + '">' +
        '<button class="ob-fd-cfx" data-cfd="' + i + '" title="Remove">×</button></div>';
      }).join('');
      cfList.querySelectorAll('[data-cfk]').forEach(function (sel) { sel.addEventListener('change', function () { customs[+sel.getAttribute('data-cfk')].key = sel.value; }); });
      cfList.querySelectorAll('[data-cfv]').forEach(function (inp) { inp.addEventListener('input', function () { customs[+inp.getAttribute('data-cfv')].val = inp.value; }); });
      cfList.querySelectorAll('[data-cfd]').forEach(function (b) { b.addEventListener('click', function () { customs.splice(+b.getAttribute('data-cfd'), 1); drawCf(); }); });
    }
    drawCf();
    ov.querySelector('#ob-fd-add').addEventListener('click', function () { customs.push({ key: 'name', val: '' }); drawCf(); });

    ov.addEventListener('click', function (e) { if (e.target === ov) closeFiltersDrawer(); });
    ov.querySelector('#ob-fd-x').addEventListener('click', closeFiltersDrawer);
    ov.querySelector('#ob-fd-cancel').addEventListener('click', closeFiltersDrawer);
    ov.querySelector('#ob-fd-reset').addEventListener('click', function () {
      bu = depts.slice(); predef = 'all'; customs = [];
      drawBu(); drawCf();
      ov.querySelectorAll('input[name="ob-fd-predef"]').forEach(function (r) { r.checked = r.value === 'all'; });
    });
    ov.querySelector('#ob-fd-apply').addEventListener('click', function () {
      state.buFilter = (bu.length === depts.length) ? null : bu;   // null = no restriction
      state.predef = predef;
      state.customFilters = customs.filter(function (c) { return c.val; });
      state.pg = 1;
      closeFiltersDrawer();
      render();
    });
    filterDrawerKey = function (e) { if (e.key === 'Escape') closeFiltersDrawer(); };
    document.addEventListener('keydown', filterDrawerKey);
  }

  /* ── Edit Columns drawer (show/hide + drag-reorder, saved to localStorage) ──
     Mirrors the Job Board module's column manager, reusing this module's overlay
     and drawer styles. Uses native HTML5 drag-and-drop — this frontend has no
     bundler, so a React DnD library (react-beautiful-dnd / @hello-pangea/dnd)
     cannot be loaded here; native DnD is exactly what the Job Board grid uses. */
  var colDrawerKey = null;
  function closeColumnsDrawer() {
    var ov = document.getElementById('hrms-ob-coldrawer');
    if (ov) ov.remove();
    if (colDrawerKey) { document.removeEventListener('keydown', colDrawerKey); colDrawerKey = null; }
  }
  function openColumnsDrawer() {
    ensureCols();
    closeColumnsDrawer();
    ensureStyle();
    // Work on a copy — nothing is committed until the user hits Save.
    var working = state.cols.map(function (c) { return { key: c.key, on: c.on }; });

    var ov = document.createElement('div');
    ov.id = 'hrms-ob-coldrawer';
    ov.className = 'ob-ov';
    ov.innerHTML =
      '<div class="ob-dw ob-cd" role="dialog" aria-label="Edit Columns">' +
        '<div class="ob-dw-h"><h3>Edit Columns</h3><button class="ob-x" id="ob-cd-x" title="Close">×</button></div>' +
        '<div class="ob-cd-sub"><span id="ob-cd-count"></span> OF ' + working.length + ' SELECTED</div>' +
        '<div class="ob-cd-list" id="ob-cd-list"></div>' +
        '<div class="ob-cd-f">' +
          '<button class="ob-btn primary" id="ob-cd-save">Save</button>' +
          '<button class="ob-btn" id="ob-cd-reset">Reset to Default</button>' +
          '<button class="ob-btn" id="ob-cd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    function updateCount() {
      var el = ov.querySelector('#ob-cd-count');
      if (el) el.textContent = working.filter(function (c) { return c.on; }).length;
    }
    function renderList() {
      var list = ov.querySelector('#ob-cd-list');
      list.innerHTML = working.map(function (c, i) {
        return '<div class="ob-cd-i" draggable="true" data-i="' + i + '">' +
          '<span class="ob-cd-grip" title="Drag to reorder">⋮⋮</span>' +
          '<label><input type="checkbox"' + (c.on ? ' checked' : '') + '>' + esc(colLabel(c.key)) + '</label>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.ob-cd-i').forEach(function (el) {
        var i = +el.getAttribute('data-i');
        el.querySelector('input').addEventListener('change', function (e) { working[i].on = e.target.checked; updateCount(); });
        el.addEventListener('dragstart', function (e) { el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
        el.addEventListener('dragend', function () { el.classList.remove('drag'); });
        el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('over'); });
        el.addEventListener('dragleave', function () { el.classList.remove('over'); });
        el.addEventListener('drop', function (e) {
          e.preventDefault(); el.classList.remove('over');
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10), to = i;
          if (isNaN(from) || from === to) return;
          var moved = working.splice(from, 1)[0];
          working.splice(to, 0, moved);
          renderList();
        });
      });
      updateCount();
    }
    renderList();

    ov.addEventListener('click', function (e) { if (e.target === ov) closeColumnsDrawer(); });
    ov.querySelector('#ob-cd-x').addEventListener('click', closeColumnsDrawer);
    ov.querySelector('#ob-cd-cancel').addEventListener('click', closeColumnsDrawer);
    ov.querySelector('#ob-cd-reset').addEventListener('click', function () { working = defaultColState(); renderList(); });
    ov.querySelector('#ob-cd-save').addEventListener('click', function () {
      if (!working.some(function (c) { return c.on; })) { toast('Select at least one column to display.', 'warn'); return; }
      state.cols = working;
      saveColPrefs();
      closeColumnsDrawer();
      render();
    });
    colDrawerKey = function (e) { if (e.key === 'Escape') closeColumnsDrawer(); };
    document.addEventListener('keydown', colDrawerKey);
  }

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
        // The candidate roster and stage lists are both in memory, so filter
        // locally with no round-trip; keep the caret across the re-render.
        var pos = s.selectionStart;
        render();
        var s2 = document.getElementById('ob-search');
        if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (_) {} }
      });
    }
    var fs = root.querySelector('#ob-fstatus');
    if (fs) fs.addEventListener('change', function () { state.filters.status = fs.value; state.pg = 1; render(); });
    var fa = root.querySelector('#ob-fauth');
    if (fa) fa.addEventListener('change', function () { state.filters.authType = fa.value; state.pg = 1; render(); });
    var ps = root.querySelector('#ob-psize');
    if (ps) ps.addEventListener('change', function () { state.pageSize = +ps.value; state.pg = 1; render(); });
    var pv = root.querySelector('#ob-prev');
    if (pv) pv.addEventListener('click', function () { if (state.pg > 1) { state.pg--; render(); } });
    var nx = root.querySelector('#ob-next');
    if (nx) nx.addEventListener('click', function () { state.pg++; render(); });
    var nw = root.querySelector('#ob-new');
    if (nw) nw.addEventListener('click', function () { openCandidateModal(); });
    var ex = root.querySelector('#ob-export');
    if (ex) ex.addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(ex); });
    var ff = root.querySelector('#ob-filters');
    if (ff) ff.addEventListener('click', function (e) { e.stopPropagation(); openFiltersDrawer(); });
    var mc = root.querySelector('#ob-columns');
    if (mc) mc.addEventListener('click', function (e) { e.stopPropagation(); openColumnsDrawer(); });

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
    // Row action buttons (candidate grid only). stopPropagation so the row's
    // own click (which opens the drawer) does not also fire.
    root.querySelectorAll('td.ob-actions button[data-act]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var id = +b.dataset.id, act = b.dataset.act;
        if (act === 'view') { openDetail(id, 'overview'); return; }
        if (act === 'edit') {
          api('/onboarding/candidates/' + id)
            .then(function (c) { openCandidateModal(c); })
            .catch(function (e) { toast(e.message, 'error'); });
          return;
        }
        if (act === 'del') {
          var r = state.rows.filter(function (x) { return x.id === id; })[0] || {};
          if (!confirm('Delete ' + (r.name || r.email || 'this candidate') + '? The audit trail is kept.')) return;
          api('/onboarding/candidates/' + id, { method: 'DELETE' })
            .then(function () { toast('Candidate deleted'); loadCandidates(); })
            .catch(function (e) { toast(e.message, 'error'); });
        }
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
    loadColPrefs();   // restore the saved candidate-grid column configuration
    // Capture phase: must run before the nav-item's own click handler.
    document.addEventListener('click', onNavClick, true);
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
