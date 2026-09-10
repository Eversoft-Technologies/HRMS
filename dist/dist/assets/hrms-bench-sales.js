/**
 * hrms-bench-sales.js  v3
 * Recruit > Bench Sales and Recruit > Bench Submissions — two independent
 * modules (siblings, not one nested under the other).
 *
 * Same no-rebuild injection pattern as hrms-onboarding.js / hrms-jobs-table.js:
 * the React bundle has neither route, so this renders its own DOM into
 * `.main` (hiding React's `.content`, which would otherwise show a blank/404
 * view for these routes) and keeps itself mounted via a MutationObserver,
 * exactly like Onboarding does for its own routes that React does not know
 * about.
 *
 * Two nav entries are injected into the Recruit section, right after
 * "Job Board", as flat siblings (same indentation level, same nav-item look):
 *   /recruit/bench-sales         Bench Sales — the marketable roster of bench
 *                                 consultants (Name, Tech Stack, Experience,
 *                                 Certificates, Mail Id, Contact No, Resume,
 *                                 Work Authorization, DL (Optional)/State ID,
 *                                 I-94), styled after the Bench Submissions
 *                                 grid below (search + Filters/Manage
 *                                 Columns/Export toolbar + table + a "New
 *                                 Profile" form, row click opens a detail
 *                                 drawer with a "Submission Format" popup
 *                                 that formats the profile as copy/paste-
 *                                 ready text for a vendor). Backed by
 *                                 /api/recruit/bench-sales. Resume/DL/I-94 are
 *                                 stored base64-in-row (house style) and
 *                                 served through a dedicated file endpoint.
 *   /recruit/bench-submissions   Bench Submissions — a candidate-submission
 *                                 tracker: consultant profiles submitted to a
 *                                 client through a vendor, styled after the
 *                                 Onboarding candidates grid (search + status
 *                                 filter + Filters/Manage Columns/Export
 *                                 toolbar + table + a "New Submission" form,
 *                                 row click opens a detail drawer). Backed by
 *                                 /api/recruit/bench-submissions.
 *
 * Permission gating needs no new entry in hrms-perms.js: ROUTE_PERMS already
 * matches any '/recruit/...' path (prefix match) to 'recruitment.view', and
 * applyNav() hides/shows ALL '.nav-item' elements generically — including the
 * two we inject here — so both new links behave exactly like every other
 * Recruit nav item for every role. Bench Submissions' own create/edit/delete
 * actions are gated the same way the rest of Recruit is: recruitment.create /
 * recruitment.edit / recruitment.delete (see hrms-rbac.js).
 *
 * Theme-aware via the app's CSS custom properties, so dark mode works with no
 * extra code.
 */
(function () {
  'use strict';

  var ROUTES = { '/recruit/bench-sales': 'sales', '/recruit/bench-submissions': 'submissions' };
  var ID = {
    root: 'hrms-bs-root', style: 'hrms-bs-style', modal: 'hrms-bs-modal', drawer: 'hrms-bs-drawer',
    coldrawer: 'hrms-bs-coldrawer', fdrawer: 'hrms-bs-fdrawer', menu: 'hrms-bs-menu',
  };

  var SUBMISSION_STATUSES = ['Submitted', 'Interview Scheduled', 'Offered', 'Placed', 'Rejected', 'On Hold'];

  // Bench Sales file uploads: Resume/DL/I-94 are one file each, Certificates
  // allows up to this many — all PDF-only (mirrors api/views.py's
  // MAX_CERTIFICATES_PER_PROFILE and _is_pdf).
  var MAX_CERTIFICATES_PER_PROFILE = 10;
  // Per-file upload cap (resume / DL / I-94 / each certificate). Mirrors
  // MAX_BENCH_SALES_FILE_MB in api/views.py — keep the two in sync.
  var MAX_UPLOAD_MB = 34;
  var MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
  function isTooLarge(file) { return !!file && file.size > MAX_UPLOAD_BYTES; }
  function tooLargeMsg(file) {
    return file.name + ' is ' + (file.size / (1024 * 1024)).toFixed(1) + ' MB — each file must be ' + MAX_UPLOAD_MB + ' MB or smaller.';
  }
  function isPdfFile(file) {
    var type = (file.type || '').toLowerCase();
    var name = (file.name || '').toLowerCase();
    return type === 'application/pdf' || name.slice(-4) === '.pdf';
  }

  /* Column catalog for "Manage Columns" — mirrors Onboarding's candidate grid
     (hrms-onboarding.js's DEFAULT_COLS/OPTIONAL_COLS pattern): an ordered,
     show/hide column set persisted to localStorage under its own key so the
     two modules' column preferences never collide. */
  var DEFAULT_SUB_COLS = [
    ['name', 'Name'], ['clientName', 'Client Name'], ['vendorPrimeVendor', 'Vendor / Prime Vendor'],
    ['rate', 'Rate'], ['status', 'Submission Status'], ['followUpVendor', 'Follow up — Vendor'],
    ['interviewSchedule', 'Interview Schedule'],
  ];
  var OPTIONAL_SUB_COLS = [
    ['vendorPersonName', 'Vendor person Name/Client'], ['vendorEmail', 'Vendor Email'],
    ['vendorContact', 'Vendor Contact'], ['implementationPartner', 'Implementation Partner'],
    ['roleResponsibilities', 'Role & Responsibilities'], ['createdBy', 'Created By'],
  ];
  var ALL_SUB_COLS = DEFAULT_SUB_COLS.concat(OPTIONAL_SUB_COLS);
  var LS_SUB_COLS = 'hrms_bss_submission_columns_v1';

  // Pre-defined quick filters offered in the Edit Filters drawer.
  var SUB_PREDEF = [
    ['all', 'All Submissions'], ['active', 'Active (not Placed/Rejected)'],
    ['placed', 'Placed'], ['rejected', 'Rejected'],
    ['interviewSoon', 'Interview in next 7 days'], ['followupOverdue', 'Follow-up Overdue'],
  ];

  /* Bench Sales — same Manage-Columns/Filters/Export pattern as Bench
     Submissions above, its own column catalog and localStorage key so the
     two never collide. */
  var DEFAULT_SALES_COLS = [
    ['name', 'Name'], ['techStack', 'Tech Stack'], ['experience', 'Experience'],
    ['workAuthorization', 'Work Authorization'], ['resume', 'Resume'],
    ['email', 'Mail Id'], ['contactNo', 'Contact No'],
  ];
  var OPTIONAL_SALES_COLS = [
    ['certificates', 'Certificates'], ['dlStateId', 'DL (Optional)/State ID'],
    ['i94', 'I-94'], ['createdBy', 'Created By'],
  ];
  var ALL_SALES_COLS = DEFAULT_SALES_COLS.concat(OPTIONAL_SALES_COLS);
  var LS_SALES_COLS = 'hrms_bss_sales_columns_v1';

  // Reuses the Onboarding candidate grid's work-authorization vocabulary
  // (hrms-onboarding.js's AUTH_TYPES) so the two modules agree on values.
  var WORK_AUTH_TYPES = ['F1', 'H1B', 'GC EAD', 'US Citizen', 'H4 EAD', 'Other'];

  var SALES_PREDEF = [
    ['all', 'All Consultants'], ['hasResume', 'Has Resume'], ['missingResume', 'Missing Resume'],
    ['hasWorkAuth', 'Has Work Authorization'], ['noWorkAuth', 'No Work Authorization'],
    ['hasI94', 'Has I-94'], ['missingI94', 'Missing I-94'],
  ];

  // Frontend slug -> backend file-field slug (api/views.py's
  // _BENCH_SALES_FILE_FIELDS), and which row keys carry that field's
  // fileName/hasFile flags.
  var SALES_FILE_FIELDS = {
    resume: { slug: 'resume', nameKey: 'resumeFileName', hasKey: 'resumeHasFile' },
    dlStateId: { slug: 'dl-state-id', nameKey: 'dlStateIdFileName', hasKey: 'dlStateIdHasFile' },
    i94: { slug: 'i94', nameKey: 'i94FileName', hasKey: 'i94HasFile' },
  };

  /* React owns .topbar-title and only refreshes it on a route change ITS OWN
     router drove. Our pushState-based navigation bypasses that router (see
     hrms-onboarding.js's identical comment), so once we've set the topbar to
     "Bench Sales" it is left stuck there when the user clicks away to a real,
     React-owned Recruit page — React never gets a chance to react to it.
     Restoring the correct title ourselves for Recruit's other known pages is
     the only fix that does not require touching those other modules. */
  var SIBLING_TITLES = {
    '/recruit': 'Recruit',
    '/recruit/job-board': 'Job Board',
    '/recruit/resume-scoring': 'Resume Scoring',
    '/recruit/interview': 'F2F Interview',
    '/recruit/ats': 'ATS'
  };

  var state = {
    page: null,
    sub: {
      rows: [], loaded: false, loading: false, error: '', search: '', status: '', drawerId: null,
      cols: null,                 // Manage Columns — {key,on}[] in display order, lazy-loaded
      clientFilter: null,         // Edit Filters -> Client Name selection (null = all)
      predef: 'all',              // Edit Filters -> pre-defined quick filter
      customFilters: [],          // Edit Filters -> custom "contains" rules: [{key,val}]
    },
    sales: {
      rows: [], loaded: false, loading: false, error: '', search: '', drawerId: null,
      cols: null,                 // Manage Columns — {key,on}[] in display order, lazy-loaded
      authFilter: null,           // Edit Filters -> Work Authorization selection (null = all)
      predef: 'all',              // Edit Filters -> pre-defined quick filter
      customFilters: [],          // Edit Filters -> custom "contains" rules: [{key,val}]
    },
  };

  /* ── shared helpers (each injected module keeps its own copy — see
     hrms-onboarding.js for the identical pattern) ────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* Mirrors Django's EmailValidator closely enough for the UI: something before
     the @, a dotted domain after it, no whitespace (name@example.com). */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z0-9-]{2,}$/;
  function isValidEmail(s) { return EMAIL_RE.test(String(s || '').trim()); }
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
    if (em) hdrs['X-User-Email'] = em;
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
    var el = document.getElementById('hrms-bs-toast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'hrms-bs-toast';
    el.className = 'bss-toast ' + (type === 'error' ? 'err' : 'ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; }, 3200);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3700);
  }

  function badge(text, kind) {
    return '<span class="bss-badge ' + (kind || 'neutral') + '">' + esc(text) + '</span>';
  }
  function statusKind(s) {
    s = String(s || '').toLowerCase();
    if (s === 'placed' || s === 'offered') return 'ok';
    if (s === 'rejected') return 'err';
    if (s === 'interview scheduled') return 'warn';
    return 'neutral';
  }
  function fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; }
  function fmtDateTime(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : '—'; }

  /* Reads a File (from a <input type=file>) as base64, for Bench Sales'
     Resume/DL/State ID/I-94 uploads — sent as plain JSON (name/mime/base64
     data) rather than multipart, since the rest of this API already speaks
     JSON and there is no bundler here to pull in a multipart/form helper. */
  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve({ name: file.name, mime: file.type || 'application/octet-stream', data: comma !== -1 ? result.slice(comma + 1) : result });
      };
      reader.onerror = function () { reject(reader.error || new Error('Failed to read ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  /* Downloads a Bench Sales document (resume/DL/I-94) via fetch rather than a
     plain <a href> link: this API authenticates same-origin /api/ requests by
     an X-Actor-Email header that hrms-actor.js's global fetch patch attaches
     automatically — a browser-driven navigation from a bare link never goes
     through fetch(), so it would 401. Routing it through fetch() + the
     existing download() blob helper (defined below, in the export section)
     keeps it authenticated and gives it a proper Save dialog either way. */
  function downloadSalesFile(id, slug, fallbackName) {
    fetch('/api/recruit/bench-sales/' + id + '/file/' + slug).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="([^"]*)"/.exec(cd);
      var name = (m && m[1]) || fallbackName || 'file';
      return r.blob().then(function (blob) { download(blob, name, blob.type || 'application/octet-stream'); });
    }).catch(function (e) { toast('Failed to download file: ' + e.message, 'error'); });
  }
  function downloadCertificateFile(profileId, certId, fallbackName) {
    fetch('/api/recruit/bench-sales/' + profileId + '/certificates/' + certId + '/file').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="([^"]*)"/.exec(cd);
      var name = (m && m[1]) || fallbackName || 'certificate.pdf';
      return r.blob().then(function (blob) { download(blob, name, blob.type || 'application/octet-stream'); });
    }).catch(function (e) { toast('Failed to download certificate: ' + e.message, 'error'); });
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var st = document.createElement('style');
    st.id = ID.style;
    st.textContent = [
      '#' + ID.root + '{padding:24px;flex:1;overflow-y:auto;color:var(--text,#e6edf7);font-size:14px}',
      '.bs-h{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}',
      '.bs-h h2{margin:0;font-size:20px;font-weight:700;flex:1}',
      '.bs-sub{color:var(--muted,#8a9bb8);font-size:13px;margin:-10px 0 18px}',
      '.bs-empty{padding:44px;text-align:center;color:var(--muted,#8a9bb8)}',
      '.bs-empty .big{font-size:32px;margin-bottom:10px;opacity:.5}',
      /* Bench Submissions — same visual language as the Onboarding candidate
         grid (hrms-onboarding.js's .ob-* classes), scoped as .bss-* here so
         the two injected modules never collide. */
      '.bss-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}',
      '.bss-btn{background:var(--bg3,#1c2433);color:var(--text,#e6edf7);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.bss-btn:hover{border-color:var(--accent,#4f8ef7)}',
      '.bss-btn.primary{background:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);color:#fff}',
      '.bss-btn.danger{background:#ef4444;border-color:#ef4444;color:#fff}',
      '.bss-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.bss-in,.bss-sel,.bss-ta{background:var(--bg2,#141b26);color:var(--text,#e6edf7);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;width:100%;box-sizing:border-box}',
      '.bss-in:focus,.bss-sel:focus,.bss-ta:focus{outline:none;border-color:var(--accent,#4f8ef7)}',
      '.bss-ta{min-height:70px;resize:vertical}',
      '.bss-search{max-width:280px}',
      /* Same treatment as the attendance history table: the grid scrolls
         inside a fixed-height box (vertical scrollbar on the right, horizontal
         at the bottom) so a long roster never stretches the page; the header
         row stays pinned while the rows scroll underneath it. */
      '.bss-wrap{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:12px;',
      'overflow-x:auto;overflow-y:auto;max-height:480px;-webkit-overflow-scrolling:touch}',
      '.bss-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}',
      '.bss-table th{text-align:left;padding:11px 14px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--muted,#8a9bb8);border-bottom:1px solid var(--border,#2a3446);white-space:nowrap;',
      'position:sticky;top:0;z-index:2;background:var(--bg2,#141b26)}',
      '.bss-table td{padding:11px 14px;border-bottom:1px solid var(--border2,#1d2634);white-space:nowrap}',
      '.bss-table tbody tr{cursor:pointer}',
      '.bss-table tbody tr:hover{background:var(--bg3,#1c2433)}',
      '.bss-table tbody tr:last-child td{border-bottom:none}',
      '.bss-empty2{padding:44px;text-align:center;color:var(--muted,#8a9bb8)}',
      '.bss-empty2 .big{font-size:32px;margin-bottom:10px;opacity:.5}',
      '.bss-badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}',
      '.bss-badge.ok{background:rgba(34,197,94,.15);color:#22c55e}',
      '.bss-badge.warn{background:rgba(245,158,11,.15);color:#f59e0b}',
      '.bss-badge.err{background:rgba(239,68,68,.15);color:#ef4444}',
      '.bss-badge.neutral{background:var(--bg3,#1c2433);color:var(--muted,#8a9bb8)}',
      '.bss-count{color:var(--muted,#8a9bb8);font-size:12px}',
      /* overlay + drawer/modal, mirrors .ob-ov / .ob-dw */
      '.bss-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;justify-content:flex-end}',
      '.bss-dw{width:min(560px,100%);background:var(--bg,#0d131c);border-left:1px solid var(--border,#2a3446);',
      'display:flex;flex-direction:column;height:100%;box-shadow:-8px 0 32px rgba(0,0,0,.4)}',
      '.bss-dw-h{padding:18px 22px;border-bottom:1px solid var(--border,#2a3446);display:flex;align-items:center;gap:12px}',
      '.bss-dw-h h3{margin:0;font-size:17px;font-weight:700;flex:1}',
      '.bss-x{background:none;border:none;color:var(--muted,#8a9bb8);font-size:24px;cursor:pointer;line-height:1;padding:0 4px}',
      '.bss-dw-b{padding:22px;overflow-y:auto;flex:1}',
      '.bss-f{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '.bss-f .full{grid-column:1/-1}',
      '.bss-lb{display:block;font-size:12px;color:var(--muted,#8a9bb8);margin-bottom:5px;font-weight:600}',
      '.bss-lb .req{color:#ef4444}',
      '.bss-row2{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border2,#1d2634);gap:12px}',
      '.bss-row2:last-child{border-bottom:none}',
      '.bss-row2 .k{color:var(--muted,#8a9bb8);font-size:12px}',
      '.bss-row2 .v{font-weight:600;text-align:right;word-break:break-word}',
      '.bss-act{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}',
      '.bss-err{color:#ef4444;font-size:12px;margin-top:10px;min-height:16px}',
      '.bss-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;padding:12px 22px;',
      'border-radius:10px;font-size:14px;font-weight:600;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.25);transition:opacity .4s}',
      '.bss-toast.ok{background:#22c55e}.bss-toast.err{background:#ef4444}',
      /* Filters / Manage Columns / Export toolbar — same visual language as
         the Onboarding candidate grid's toolbar (hrms-onboarding.js's .ob-*
         classes), scoped as .bss-* here. */
      '.bss-btn.active{border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7)}',
      '.bss-fbadge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;',
      'border-radius:9px;background:var(--accent,#4f8ef7);color:#fff;font-size:10px;font-weight:700;margin-left:4px}',
      '.bss-menu{position:absolute;top:calc(100% + 5px);right:0;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:9px;overflow:hidden;z-index:60;min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
      '.bss-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text,#e6edf7);',
      'padding:10px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.bss-menu button:hover{background:var(--bg3,#1c2433)}',
      /* Manage Columns drawer (reuses .bss-ov / .bss-dw / .bss-dw-h / .bss-x) */
      '.bss-cd{width:min(400px,100%)}',
      '.bss-cd-sub{padding:15px 22px 6px;font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--muted,#8a9bb8)}',
      '.bss-cd-list{flex:1;overflow-y:auto;padding:10px 16px 16px}',
      '.bss-cd-i{display:flex;align-items:center;gap:10px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:9px;padding:10px 12px;margin-bottom:7px;cursor:grab}',
      '.bss-cd-i.drag{opacity:.4}',
      '.bss-cd-i.over{border-color:var(--accent,#4f8ef7)}',
      '.bss-cd-grip{color:var(--muted,#8a9bb8);font-size:14px;letter-spacing:-2px;cursor:grab;user-select:none}',
      '.bss-cd-i label{flex:1;display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text,#e6edf7);cursor:pointer;margin:0}',
      '.bss-cd-i input{width:16px;height:16px;accent-color:var(--accent,#4f8ef7);cursor:pointer;flex-shrink:0}',
      '.bss-cd-f{display:flex;gap:10px;padding:16px 22px;border-top:1px solid var(--border,#2a3446)}',
      '.bss-cd-f .bss-btn{flex:1;text-align:center}',
      /* Edit Filters drawer */
      '.bss-fd-body{flex:1;overflow-y:auto;padding:6px 22px 16px}',
      '.bss-fd-sec{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#8a9bb8);margin:16px 0 8px}',
      '.bss-fd-bu{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:9px;padding:6px 10px;max-height:190px;overflow-y:auto}',
      '.bss-fd-bu label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text,#e6edf7);padding:5px 2px;cursor:pointer}',
      '.bss-fd-bu input,.bss-fd-pd input{width:15px;height:15px;accent-color:var(--accent,#4f8ef7);cursor:pointer;flex-shrink:0}',
      '.bss-fd-empty{color:var(--muted,#8a9bb8);font-size:12px;padding:6px 2px}',
      '.bss-fd-pd{display:grid;gap:8px}',
      '.bss-fd-pd label{display:flex;align-items:center;gap:10px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text,#e6edf7);cursor:pointer}',
      '.bss-fd-pd label:hover{border-color:var(--accent,#4f8ef7)}',
      '.bss-fd-add{color:var(--accent,#4f8ef7);font-size:12.5px;font-weight:700;cursor:pointer;background:none;border:none;padding:12px 0 4px}',
      '.bss-fd-cf{display:flex;gap:6px;margin-bottom:6px}',
      '.bss-fd-cf select,.bss-fd-cf input{flex:1;min-width:0;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);',
      'border-radius:7px;color:var(--text,#e6edf7);font:inherit;font-size:12px;padding:7px 8px}',
      '.bss-fd-cfx{flex:0 0 auto;width:30px;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:7px;color:#ef4444;cursor:pointer}',
      /* Bench Sales — file-download badge (table cell + detail drawer) and
         the "Submission Format" popup's preformatted text block. */
      '.bss-filebtn{border:none;display:inline-block;font-family:inherit}',
      '.bss-filebtn.bss-badge{cursor:pointer}',
      '.bss-filebtn.bss-badge:hover{filter:brightness(1.15)}',
      '.bss-subfmt-pre{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:9px;',
      'padding:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;',
      'line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text,#e6edf7);max-height:50vh;overflow-y:auto}',
      /* Mobile: match responsive.css's .content padding so the page fills the
         viewport like every other screen instead of sitting in a 24px inset;
         toolbar controls stretch edge-to-edge. */
      '@media (max-width:768px){#' + ID.root + '{padding:16px 14px}',
      '.bss-search{max-width:none}',
      '.bss-toolbar>.bss-btn,.bss-toolbar>div>.bss-btn{flex:1 1 auto;width:100%;text-align:center}',
      '.bss-toolbar>div{flex:1 1 auto}}',
      '@media (max-width:420px){#' + ID.root + '{padding:12px 10px}}',
      '@media (max-width:768px){.bss-wrap{max-height:calc(100vh - 340px)}}',
      '@media print{.sidebar,.topbar,.bss-toolbar{display:none!important}',
      '#' + ID.root + '{overflow:visible!important;padding:0!important;color:#000!important}',
      '.bss-wrap{border-color:#ccc!important;background:#fff!important;color:#000!important;max-height:none!important;overflow:visible!important}',
      '.bss-table td,.bss-table th{color:#000!important}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ── Bench Sales — Manage Columns (show/hide + drag-reorder) ─────────────
     Same pattern as Bench Submissions' column manager below, its own state
     and localStorage key. */
  function salesColByKey(key) {
    for (var i = 0; i < ALL_SALES_COLS.length; i++) if (ALL_SALES_COLS[i][0] === key) return ALL_SALES_COLS[i];
    return [key, key];
  }
  function salesColLabel(key) { return salesColByKey(key)[1]; }
  function defaultSalesColState() {
    return DEFAULT_SALES_COLS.map(function (c) { return { key: c[0], on: true }; })
      .concat(OPTIONAL_SALES_COLS.map(function (c) { return { key: c[0], on: false }; }));
  }
  function loadSalesColPrefs() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_SALES_COLS) || 'null'); } catch (_) {}
    var known = {}; ALL_SALES_COLS.forEach(function (c) { known[c[0]] = 1; });
    var cols;
    if (Array.isArray(saved) && saved.length) {
      var seen = {};
      cols = saved
        .filter(function (c) { return c && c.key && known[c.key] && !seen[c.key] && (seen[c.key] = 1); })
        .map(function (c) { return { key: c.key, on: c.on !== false }; });
      defaultSalesColState().forEach(function (dc) {
        if (!cols.some(function (c) { return c.key === dc.key; })) cols.push(dc);
      });
    } else {
      cols = defaultSalesColState();
    }
    state.sales.cols = cols;
  }
  function saveSalesColPrefs() { try { localStorage.setItem(LS_SALES_COLS, JSON.stringify(state.sales.cols)); } catch (_) {} }
  function ensureSalesCols() { if (!state.sales.cols || !state.sales.cols.length) loadSalesColPrefs(); }
  function shownSalesCols() { ensureSalesCols(); return state.sales.cols.filter(function (c) { return c.on; }); }

  /* ── Bench Sales — filtering helpers (Edit Filters drawer: Work
     Authorization + pre-defined + custom "contains", combined with the
     inline Search control) ─────────────────────────────────────────────── */
  function distinctSalesVals(key) {
    var seen = {}, out = [];
    state.sales.rows.forEach(function (r) {
      var v = String(r[key] == null ? '' : r[key]);
      if (!(v in seen)) { seen[v] = 1; out.push(v); }
    });
    return out.sort();
  }
  function certNames(row) { return (row.certificates || []).map(function (c) { return c.fileName; }); }
  function salesCellRaw(row, key) {
    if (key === 'resume') return row.resumeHasFile ? 'Uploaded' : '';
    if (key === 'dlStateId') return row.dlStateIdHasFile ? 'Uploaded' : '';
    if (key === 'i94') return row.i94HasFile ? 'Uploaded' : '';
    if (key === 'certificates') return certNames(row).join(', ');
    var v = row[key];
    return v == null ? '' : String(v);
  }
  function matchSalesPredef(r) {
    switch (state.sales.predef) {
      case 'hasResume': return !!r.resumeHasFile;
      case 'missingResume': return !r.resumeHasFile;
      case 'hasWorkAuth': return !!r.workAuthorization;
      case 'noWorkAuth': return !r.workAuthorization;
      case 'hasI94': return !!r.i94HasFile;
      case 'missingI94': return !r.i94HasFile;
      default: return true;
    }
  }
  function activeSalesFilterCount() {
    var n = 0;
    if (state.sales.authFilter) n++;
    if (state.sales.predef && state.sales.predef !== 'all') n++;
    n += state.sales.customFilters.filter(function (c) { return c.val; }).length;
    return n;
  }

  /* ── Bench Sales ───────────────────────────────────────────────────────── */
  function loadSalesProfiles() {
    state.sales.loading = true;
    state.sales.error = '';
    renderSales();
    api('/recruit/bench-sales').then(function (rows) {
      state.sales.rows = rows || [];
      state.sales.loaded = true;
      state.sales.loading = false;
      renderSales();
    }).catch(function (err) {
      state.sales.error = err.message || 'Failed to load consultant profiles.';
      state.sales.loaded = true;
      state.sales.loading = false;
      renderSales();
    });
  }

  function filteredSalesRows() {
    var q = state.sales.search.trim().toLowerCase();
    return state.sales.rows.filter(function (r) {
      if (q && ![r.name, r.techStack, r.email, r.contactNo].concat(certNames(r))
        .some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; })) return false;
      if (state.sales.authFilter && state.sales.authFilter.indexOf(String(r.workAuthorization || '')) === -1) return false;
      if (state.sales.predef !== 'all' && !matchSalesPredef(r)) return false;
      for (var i = 0; i < state.sales.customFilters.length; i++) {
        var cf = state.sales.customFilters[i];
        if (cf.val && salesCellRaw(r, cf.key).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  function fileCell(row, fieldKey) {
    var f = SALES_FILE_FIELDS[fieldKey];
    if (!row[f.hasKey]) return badge('—', 'neutral');
    return '<button type="button" class="bss-filebtn bss-badge ok" data-dlid="' + row.id + '" data-dlslug="' + f.slug +
      '" data-dlname="' + esc(row[f.nameKey] || '') + '" title="Download ' + esc(row[f.nameKey] || fieldKey) + '">⬇ Uploaded</button>';
  }
  function certsCell(row) {
    var certs = row.certificates || [];
    if (!certs.length) return badge('—', 'neutral');
    return certs.map(function (c) {
      return '<button type="button" class="bss-filebtn bss-badge ok" data-dlcertid="' + row.id + '" data-certid="' + c.id +
        '" data-dlname="' + esc(c.fileName || '') + '" title="Download ' + esc(c.fileName || 'certificate') + '">⬇ ' + esc(c.fileName || 'certificate') + '</button>';
    }).join(' ');
  }
  function salesCell(row, key) {
    if (key === 'resume' || key === 'dlStateId' || key === 'i94') return fileCell(row, key);
    if (key === 'certificates') return certsCell(row);
    if (key === 'workAuthorization') return row.workAuthorization ? badge(row.workAuthorization, 'neutral') : '—';
    return esc(row[key] || '—');
  }

  function buildSalesTableHtml() {
    if (state.sales.loading) return '<div class="bss-empty2"><div class="big">⏳</div>Loading consultant profiles…</div>';
    if (state.sales.error) return '<div class="bss-empty2"><div class="big">⚠</div>' + esc(state.sales.error) + '</div>';
    var cols = shownSalesCols();
    var rows = filteredSalesRows();
    if (!rows.length) {
      return '<div class="bss-empty2"><div class="big">🪑</div>' +
        (state.sales.rows.length ? 'No consultants match your filters.' : 'No consultants yet. Click "New Profile" to add one.') +
        '</div>';
    }
    if (!cols.length) {
      return '<div class="bss-empty2"><div class="big">📋</div>Select at least one column in Manage Columns.</div>';
    }
    var head = cols.map(function (c) { return '<th>' + esc(salesColLabel(c.key)) + '</th>'; }).join('');
    var body = rows.map(function (r) {
      return '<tr class="bss-tr" data-id="' + r.id + '">' +
        cols.map(function (c) { return '<td>' + salesCell(r, c.key) + '</td>'; }).join('') +
      '</tr>';
    }).join('');
    return '<div class="bss-wrap"><table class="bss-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderSales() {
    var root = document.getElementById(ID.root);
    if (!root) return;
    if (!state.sales.loaded && !state.sales.loading) { loadSalesProfiles(); return; }

    var afc = activeSalesFilterCount();
    root.innerHTML =
      '<div class="bs-h"><h2>Bench Sales</h2></div>' +
      '<div class="bs-sub">The marketable roster of bench consultants — tech stack, experience, certifications, work authorization and documents, ready to submit to a client through a vendor.</div>' +
      '<div class="bss-toolbar">' +
        '<input class="bss-in bss-search" id="bs-search" placeholder="Search name, tech stack, email…" value="' + esc(state.sales.search) + '">' +
        '<button class="bss-btn' + (afc ? ' active' : '') + '" id="bs-filters" title="Edit Filters">' + ICON_FILTERS + FILTERS_LABEL +
          (afc ? '<span class="bss-fbadge">' + afc + '</span>' : '') + '</button>' +
        '<button class="bss-btn" id="bs-columns" title="Show, hide and reorder columns">' + ICON_COLUMNS + 'Manage Columns</button>' +
        '<div style="position:relative"><button class="bss-btn" id="bs-export">⭳ Export ▾</button></div>' +
        (can('recruitment.create') ? '<button class="bss-btn primary" id="bs-new">+ New Profile</button>' : '') +
        '<span class="bss-count">' + filteredSalesRows().length + ' of ' + state.sales.rows.length + ' consultants</span>' +
      '</div>' +
      '<div id="bs-table-wrap">' + buildSalesTableHtml() + '</div>';

    var tt = document.querySelector('.topbar-title');
    if (tt) tt.textContent = 'Bench Sales';

    var searchEl = root.querySelector('#bs-search');
    if (searchEl) searchEl.addEventListener('input', function (e) {
      state.sales.search = e.target.value;
      updateSalesTable();
    });
    var filtersBtn = root.querySelector('#bs-filters');
    if (filtersBtn) filtersBtn.addEventListener('click', function (e) { e.stopPropagation(); openSalesFiltersDrawer(); });
    var columnsBtn = root.querySelector('#bs-columns');
    if (columnsBtn) columnsBtn.addEventListener('click', function (e) { e.stopPropagation(); openSalesColumnsDrawer(); });
    var exportBtn = root.querySelector('#bs-export');
    if (exportBtn) exportBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleSalesExportMenu(exportBtn); });
    var newBtn = root.querySelector('#bs-new');
    if (newBtn) newBtn.addEventListener('click', function () { openSalesProfileModal(null); });

    // Delegated on root, which persists across updateSalesTable()'s partial
    // refresh. File-download buttons stop propagation so a click on one
    // downloads the file instead of also opening the row's detail drawer.
    root.addEventListener('click', function (e) {
      var dc = e.target && e.target.closest ? e.target.closest('[data-dlcertid]') : null;
      if (dc) { e.stopPropagation(); downloadCertificateFile(Number(dc.getAttribute('data-dlcertid')), Number(dc.getAttribute('data-certid')), dc.getAttribute('data-dlname')); return; }
      var dl = e.target && e.target.closest ? e.target.closest('[data-dlslug]') : null;
      if (dl) { e.stopPropagation(); downloadSalesFile(Number(dl.getAttribute('data-dlid')), dl.getAttribute('data-dlslug'), dl.getAttribute('data-dlname')); return; }
      var tr = e.target && e.target.closest ? e.target.closest('.bss-tr') : null;
      if (!tr) return;
      openSalesDrawer(Number(tr.getAttribute('data-id')));
    });
  }

  function updateSalesTable() {
    var wrap = document.getElementById('bs-table-wrap');
    if (wrap) wrap.innerHTML = buildSalesTableHtml();
    var countEl = document.querySelector('.bss-count');
    if (countEl) countEl.textContent = filteredSalesRows().length + ' of ' + state.sales.rows.length + ' consultants';
  }

  /* ── Bench Sales — Manage Columns drawer ──────────────────────────────── */
  var salesColDrawerKey = null;
  function closeSalesColumnsDrawer() {
    var ov = document.getElementById(ID.coldrawer);
    if (ov) ov.remove();
    if (salesColDrawerKey) { document.removeEventListener('keydown', salesColDrawerKey); salesColDrawerKey = null; }
  }
  function openSalesColumnsDrawer() {
    ensureSalesCols();
    closeSalesColumnsDrawer();
    // Work on a copy — nothing is committed until the user hits Save.
    var working = state.sales.cols.map(function (c) { return { key: c.key, on: c.on }; });

    var ov = document.createElement('div');
    ov.id = ID.coldrawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw bss-cd" role="dialog" aria-label="Manage Columns">' +
        '<div class="bss-dw-h"><h3>Manage Columns</h3><button class="bss-x" id="bs-cd-x" title="Close">×</button></div>' +
        '<div class="bss-cd-sub"><span id="bs-cd-count"></span> OF ' + working.length + ' SELECTED</div>' +
        '<div class="bss-cd-list" id="bs-cd-list"></div>' +
        '<div class="bss-cd-f">' +
          '<button class="bss-btn primary" id="bs-cd-save">Save</button>' +
          '<button class="bss-btn" id="bs-cd-reset">Reset to Default</button>' +
          '<button class="bss-btn" id="bs-cd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    function updateCount() {
      var el = ov.querySelector('#bs-cd-count');
      if (el) el.textContent = working.filter(function (c) { return c.on; }).length;
    }
    function renderList() {
      var list = ov.querySelector('#bs-cd-list');
      list.innerHTML = working.map(function (c, i) {
        return '<div class="bss-cd-i" draggable="true" data-i="' + i + '">' +
          '<span class="bss-cd-grip" title="Drag to reorder">⋮⋮</span>' +
          '<label><input type="checkbox"' + (c.on ? ' checked' : '') + '>' + esc(salesColLabel(c.key)) + '</label>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.bss-cd-i').forEach(function (el) {
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

    ov.addEventListener('click', function (e) { if (e.target === ov) closeSalesColumnsDrawer(); });
    ov.querySelector('#bs-cd-x').addEventListener('click', closeSalesColumnsDrawer);
    ov.querySelector('#bs-cd-cancel').addEventListener('click', closeSalesColumnsDrawer);
    ov.querySelector('#bs-cd-reset').addEventListener('click', function () { working = defaultSalesColState(); renderList(); });
    ov.querySelector('#bs-cd-save').addEventListener('click', function () {
      if (!working.some(function (c) { return c.on; })) { toast('Select at least one column to display.', 'error'); return; }
      state.sales.cols = working;
      saveSalesColPrefs();
      closeSalesColumnsDrawer();
      renderSales();
    });
    salesColDrawerKey = function (e) { if (e.key === 'Escape') closeSalesColumnsDrawer(); };
    document.addEventListener('keydown', salesColDrawerKey);
  }

  /* ── Bench Sales — Edit Filters drawer (Work Authorization + pre-defined +
     custom "contains") ─────────────────────────────────────────────────── */
  var salesFilterDrawerKey = null;
  function closeSalesFiltersDrawer() {
    var ov = document.getElementById(ID.fdrawer);
    if (ov) ov.remove();
    if (salesFilterDrawerKey) { document.removeEventListener('keydown', salesFilterDrawerKey); salesFilterDrawerKey = null; }
  }
  function openSalesFiltersDrawer() {
    closeSalesFiltersDrawer();
    var auths = distinctSalesVals('workAuthorization');
    var af = state.sales.authFilter ? state.sales.authFilter.slice() : auths.slice();   // default: all selected
    var predef = state.sales.predef;
    var customs = state.sales.customFilters.map(function (c) { return { key: c.key, val: c.val }; });

    var ov = document.createElement('div');
    ov.id = ID.fdrawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw bss-cd" role="dialog" aria-label="Edit Filters">' +
        '<div class="bss-dw-h"><h3>Edit Filters</h3><button class="bss-x" id="bs-fd-x" title="Close">×</button></div>' +
        '<div class="bss-fd-body">' +
          '<div class="bss-fd-sec" style="margin-top:0">Work Authorization</div>' +
          '<div class="bss-fd-bu" id="bs-fd-bu"></div>' +
          '<div class="bss-fd-sec">Pre-Defined Filters</div>' +
          '<div class="bss-fd-pd">' + SALES_PREDEF.map(function (p) {
            return '<label><input type="radio" name="bs-fd-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '>' + esc(p[1]) + '</label>';
          }).join('') + '</div>' +
          '<div class="bss-fd-sec">Custom Filters</div>' +
          '<div id="bs-fd-cf"></div>' +
          '<button class="bss-fd-add" id="bs-fd-add">+ Add Filter</button>' +
        '</div>' +
        '<div class="bss-cd-f">' +
          '<button class="bss-btn primary" id="bs-fd-apply">Apply</button>' +
          '<button class="bss-btn" id="bs-fd-reset">Reset</button>' +
          '<button class="bss-btn" id="bs-fd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var buBox = ov.querySelector('#bs-fd-bu');
    function drawBu() {
      if (!auths.length) { buBox.innerHTML = '<div class="bss-fd-empty">No work authorizations to filter yet.</div>'; return; }
      buBox.innerHTML =
        '<label><input type="checkbox" id="bs-fd-buall"' + (af.length === auths.length ? ' checked' : '') + '> <b>(All selected)</b></label>' +
        auths.map(function (d) {
          return '<label><input type="checkbox" value="' + esc(d) + '"' + (af.indexOf(d) !== -1 ? ' checked' : '') + '> ' + (d === '' ? '(blank)' : esc(d)) + '</label>';
        }).join('');
      buBox.querySelector('#bs-fd-buall').addEventListener('change', function (e) { af = e.target.checked ? auths.slice() : []; drawBu(); });
      buBox.querySelectorAll('input[value]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var v = cb.value;
          if (cb.checked) { if (af.indexOf(v) === -1) af.push(v); }
          else { var i = af.indexOf(v); if (i !== -1) af.splice(i, 1); }
          var a = buBox.querySelector('#bs-fd-buall'); if (a) a.checked = af.length === auths.length;
        });
      });
    }
    drawBu();

    ov.querySelectorAll('input[name="bs-fd-predef"]').forEach(function (r) { r.addEventListener('change', function () { predef = r.value; }); });

    var cfList = ov.querySelector('#bs-fd-cf');
    function drawCf() {
      cfList.innerHTML = customs.map(function (c, i) {
        return '<div class="bss-fd-cf"><select data-cfk="' + i + '">' + ALL_SALES_COLS.map(function (cc) {
          return '<option value="' + cc[0] + '"' + (cc[0] === c.key ? ' selected' : '') + '>' + esc(cc[1]) + '</option>';
        }).join('') + '</select>' +
        '<input data-cfv="' + i + '" placeholder="contains…" value="' + esc(c.val) + '">' +
        '<button class="bss-fd-cfx" data-cfd="' + i + '" title="Remove">×</button></div>';
      }).join('');
      cfList.querySelectorAll('[data-cfk]').forEach(function (sel) { sel.addEventListener('change', function () { customs[+sel.getAttribute('data-cfk')].key = sel.value; }); });
      cfList.querySelectorAll('[data-cfv]').forEach(function (inp) { inp.addEventListener('input', function () { customs[+inp.getAttribute('data-cfv')].val = inp.value; }); });
      cfList.querySelectorAll('[data-cfd]').forEach(function (b) { b.addEventListener('click', function () { customs.splice(+b.getAttribute('data-cfd'), 1); drawCf(); }); });
    }
    drawCf();
    ov.querySelector('#bs-fd-add').addEventListener('click', function () { customs.push({ key: 'name', val: '' }); drawCf(); });

    ov.addEventListener('click', function (e) { if (e.target === ov) closeSalesFiltersDrawer(); });
    ov.querySelector('#bs-fd-x').addEventListener('click', closeSalesFiltersDrawer);
    ov.querySelector('#bs-fd-cancel').addEventListener('click', closeSalesFiltersDrawer);
    ov.querySelector('#bs-fd-reset').addEventListener('click', function () {
      af = auths.slice(); predef = 'all'; customs = [];
      drawBu(); drawCf();
      ov.querySelectorAll('input[name="bs-fd-predef"]').forEach(function (r) { r.checked = r.value === 'all'; });
    });
    ov.querySelector('#bs-fd-apply').addEventListener('click', function () {
      state.sales.authFilter = (af.length === auths.length) ? null : af;   // null = no restriction
      state.sales.predef = predef;
      state.sales.customFilters = customs.filter(function (c) { return c.val; });
      closeSalesFiltersDrawer();
      renderSales();
    });
    salesFilterDrawerKey = function (e) { if (e.key === 'Escape') closeSalesFiltersDrawer(); };
    document.addEventListener('keydown', salesFilterDrawerKey);
  }

  /* ── Bench Sales — export (CSV / Excel / PDF-via-print) ───────────────────
     Reuses download()/buildXlsx()/zipStore() defined below, in the Bench
     Submissions export section — generic byte-level helpers with no
     Submissions-specific logic in them. */
  function exportSalesRows() {
    var cols = shownSalesCols();
    return {
      head: cols.map(function (c) { return salesColLabel(c.key); }),
      body: filteredSalesRows().map(function (r) {
        return cols.map(function (c) { return salesCellRaw(r, c.key); });
      }),
    };
  }
  function exportSalesCsv() {
    var d = exportSalesRows();
    var q = function (v) {
      v = String(v == null ? '' : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    download('﻿' + [d.head].concat(d.body).map(function (r) { return r.map(q).join(','); }).join('\r\n'),
             'bench-sales.csv', 'text/csv;charset=utf-8;');
  }
  function exportSalesXlsx() {
    var d = exportSalesRows();
    download(buildXlsx([d.head].concat(d.body)), 'bench-sales.xlsx',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  function toggleSalesExportMenu(anchor) {
    var old = document.getElementById(ID.menu);
    if (old) { old.remove(); return; }
    var m = document.createElement('div');
    m.id = ID.menu;
    m.className = 'bss-menu';
    m.innerHTML = '<button data-x="csv">Export CSV</button>' +
                  '<button data-x="xlsx">Export Excel (.xlsx)</button>' +
                  '<button data-x="pdf">Export PDF (print)</button>';
    anchor.parentElement.appendChild(m);
    m.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        m.remove();
        if (b.dataset.x === 'csv') exportSalesCsv();
        else if (b.dataset.x === 'xlsx') exportSalesXlsx();
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

  /* ── Bench Sales — "Submission Format" popup ──────────────────────────────
     Formats a consultant's profile as plain, copy/paste-ready text for
     sending to a vendor/client — the piece the field list calls out
     explicitly ("Submission Format (Should Popup)"). */
  function buildSubmissionFormatText(row) {
    function line(label, val) { return label + ': ' + (val && String(val).trim() ? val : 'N/A'); }
    return [
      'CONSULTANT PROFILE — SUBMISSION FORMAT',
      '========================================',
      line('Name', row.name),
      line('Tech Stack', row.techStack),
      line('Total Experience', row.experience),
      line('Certifications', certNames(row).join(', ')),
      line('Work Authorization', row.workAuthorization),
      line('Email', row.email),
      line('Contact No', row.contactNo),
      line('Resume', row.resumeHasFile ? 'Attached' : 'Not attached'),
      line('DL / State ID', row.dlStateIdHasFile ? 'Attached' : 'Not attached'),
      line('I-94', row.i94HasFile ? 'Attached' : 'Not attached'),
      '========================================',
    ].join('\n');
  }
  function closeSubmissionFormat() {
    var ov = document.getElementById('hrms-bs-subfmt');
    if (ov) ov.remove();
  }
  function openSubmissionFormat(row) {
    closeSubmissionFormat();
    var text = buildSubmissionFormatText(row);
    var ov = document.createElement('div');
    ov.id = 'hrms-bs-subfmt';
    ov.className = 'bss-ov';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';
    ov.innerHTML =
      '<div class="bss-dw" style="width:min(560px,100%);height:auto;max-height:85vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="bss-dw-h"><h3>Submission Format</h3><button class="bss-x" id="bsf-x">×</button></div>' +
        '<div class="bss-dw-b">' +
          '<pre class="bss-subfmt-pre" id="bsf-text">' + esc(text) + '</pre>' +
          '<div class="bss-act">' +
            '<button class="bss-btn primary" id="bsf-copy">Copy to Clipboard</button>' +
            '<button class="bss-btn" id="bsf-download">Download .txt</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSubmissionFormat(); });
    ov.querySelector('#bsf-x').addEventListener('click', closeSubmissionFormat);
    ov.querySelector('#bsf-copy').addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(function () { toast('Copied to clipboard'); })
        .catch(function () { toast('Could not copy — select the text and copy manually.', 'error'); });
    });
    ov.querySelector('#bsf-download').addEventListener('click', function () {
      download(text, (row.name || 'consultant').replace(/\s+/g, '_') + '_submission_format.txt', 'text/plain;charset=utf-8;');
    });
  }

  /* ── Bench Sales — detail drawer ──────────────────────────────────────── */
  function salesFileRow2(row, label, fieldKey) {
    var f = SALES_FILE_FIELDS[fieldKey];
    var v = row[f.hasKey]
      ? '<button type="button" class="bss-filebtn" style="color:var(--accent,#4f8ef7);text-decoration:underline;font-size:13px;font-weight:600;background:none;cursor:pointer" ' +
        'data-dlid="' + row.id + '" data-dlslug="' + f.slug + '" data-dlname="' + esc(row[f.nameKey] || '') + '">⬇ ' + esc(row[f.nameKey] || 'Download') + '</button>'
      : '<span>—</span>';
    return '<div class="bss-row2"><span class="k">' + esc(label) + '</span><span class="v">' + v + '</span></div>';
  }
  function salesCertsRow2(row) {
    var certs = row.certificates || [];
    var v = certs.length
      ? certs.map(function (c) {
          return '<button type="button" class="bss-filebtn" style="display:block;color:var(--accent,#4f8ef7);text-decoration:underline;font-size:13px;font-weight:600;background:none;cursor:pointer;padding:2px 0" ' +
            'data-dlcertid="' + row.id + '" data-certid="' + c.id + '" data-dlname="' + esc(c.fileName || '') + '">⬇ ' + esc(c.fileName || 'certificate') + '</button>';
        }).join('')
      : '<span>—</span>';
    return '<div class="bss-row2"><span class="k">Certificates</span><span class="v">' + v + '</span></div>';
  }
  function openSalesDrawer(id) {
    var row = state.sales.rows.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    closeOverlay();
    var ov = document.createElement('div');
    ov.id = ID.drawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw">' +
        '<div class="bss-dw-h"><h3>' + esc(row.name) + '</h3>' +
          (row.workAuthorization ? badge(row.workAuthorization, 'neutral') : '') +
          '<button class="bss-x" id="bsd-x">×</button></div>' +
        '<div class="bss-dw-b">' +
          row2('Tech Stack', row.techStack) +
          row2('Experience', row.experience) +
          salesCertsRow2(row) +
          row2('Mail Id', row.email) +
          row2('Contact No', row.contactNo) +
          row2('Work Authorization', row.workAuthorization) +
          salesFileRow2(row, 'Resume', 'resume') +
          salesFileRow2(row, 'DL (Optional)/State ID', 'dlStateId') +
          salesFileRow2(row, 'I-94', 'i94') +
          row2('Created By', row.createdBy) +
          '<div class="bss-act">' +
            '<button class="bss-btn" id="bsd-subfmt">📄 Submission Format</button>' +
            (can('recruitment.edit') ? '<button class="bss-btn primary" id="bsd-edit">Edit</button>' : '') +
            (can('recruitment.delete') ? '<button class="bss-btn danger" id="bsd-del">Delete</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov) { closeOverlay(); return; }
      var dc = e.target && e.target.closest ? e.target.closest('[data-dlcertid]') : null;
      if (dc) { e.stopPropagation(); downloadCertificateFile(Number(dc.getAttribute('data-dlcertid')), Number(dc.getAttribute('data-certid')), dc.getAttribute('data-dlname')); return; }
      var dl = e.target && e.target.closest ? e.target.closest('[data-dlslug]') : null;
      if (dl) { e.stopPropagation(); downloadSalesFile(Number(dl.getAttribute('data-dlid')), dl.getAttribute('data-dlslug'), dl.getAttribute('data-dlname')); }
    });
    ov.querySelector('#bsd-x').addEventListener('click', closeOverlay);
    ov.querySelector('#bsd-subfmt').addEventListener('click', function () { openSubmissionFormat(row); });
    var editBtn = ov.querySelector('#bsd-edit');
    if (editBtn) editBtn.addEventListener('click', function () { openSalesProfileModal(row); });
    var delBtn = ov.querySelector('#bsd-del');
    if (delBtn) delBtn.addEventListener('click', function () { deleteSalesProfile(row); });
  }

  function deleteSalesProfile(row) {
    if (!window.confirm('Delete the consultant profile for "' + row.name + '"? This cannot be undone.')) return;
    api('/recruit/bench-sales/' + row.id, { method: 'DELETE' }).then(function () {
      closeOverlay();
      toast('Profile deleted');
      loadSalesProfiles();
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /* ── Bench Sales — New / Edit Profile form ────────────────────────────────
     Same two-column grid + Save/Cancel footer as the Bench Submissions form
     below, plus three file inputs (Resume, DL (Optional)/State ID, I-94)
     read client-side as base64 (readFileAsBase64) and sent as plain JSON —
     leaving a file input empty on Edit keeps whatever is already stored,
     since the PUT is applied server-side as a partial update. */
  function openSalesProfileModal(row) {
    closeOverlay();
    var isEdit = !!row;
    row = row || {};
    var ov = document.createElement('div');
    ov.id = ID.modal;
    ov.className = 'bss-ov';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';

    function field(id, label, type, value, required, full) {
      var val = value == null ? '' : value;
      return '<div' + (full ? ' class="full"' : '') + '>' +
        '<label class="bss-lb">' + esc(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
        (type === 'textarea'
          ? '<textarea class="bss-ta" id="' + id + '">' + esc(val) + '</textarea>'
          : '<input class="bss-in" id="' + id + '" type="' + type + '" value="' + esc(val) + '">') +
        '</div>';
    }
    function fileField(id, label, currentName, required) {
      return '<div>' +
        '<label class="bss-lb">' + esc(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
        '<input class="bss-in" id="' + id + '" type="file" accept="application/pdf,.pdf">' +
        (currentName ? '<div style="font-size:11px;color:var(--muted,#8a9bb8);margin-top:4px">Current: ' + esc(currentName) + ' — choose a PDF to replace it</div>' : '') +
        '<div style="font-size:11px;color:var(--muted,#8a9bb8);margin-top:4px">PDF only, up to ' + MAX_UPLOAD_MB + ' MB.</div>' +
      '</div>';
    }
    // New certificate files picked this session, accumulated across repeated
    // uses of the (native, non-cumulative) file input — each pick replaces
    // input.files, so without this array a second "Choose Files" would
    // discard the first. Removed via the × next to its name, same as an
    // already-uploaded certificate.
    var pendingCertFiles = [];
    function certListItemHtml(name, removeAttr) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg3,#1c2433);border:1px solid var(--border,#2a3446);border-radius:6px;padding:4px 8px;font-size:12px">' +
        '<span>' + esc(name || 'certificate') + '</span>' +
        '<button type="button" ' + removeAttr + ' title="Remove" style="border:none;background:none;cursor:pointer;font-size:14px;line-height:1;color:var(--muted,#8a9bb8)">×</button>' +
      '</div>';
    }
    function renderCertList() {
      var wrap = ov.querySelector('#bsam-certlist-wrap');
      if (!wrap) return;
      var existing = row.certificates || [];
      var items = existing.map(function (c) {
        return certListItemHtml(c.fileName, 'data-certremove="' + c.id + '"');
      }).concat(pendingCertFiles.map(function (f, i) {
        return certListItemHtml(f.name, 'data-pendingremove="' + i + '"');
      }));
      wrap.innerHTML = items.length ? '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px">' + items.join('') + '</div>' : '';
      var countEl = ov.querySelector('#bsam-certcount');
      if (countEl) countEl.textContent = (existing.length + pendingCertFiles.length) + ' of ' + MAX_CERTIFICATES_PER_PROFILE + ' used';
    }
    function certsField() {
      return '<div class="full">' +
        '<label class="bss-lb">Certificates <span class="req">*</span></label>' +
        '<div id="bsam-certlist-wrap"></div>' +
        '<input class="bss-in" id="bsam-certs" type="file" accept="application/pdf,.pdf" multiple>' +
        '<div style="font-size:11px;color:var(--muted,#8a9bb8);margin-top:4px">PDF only, up to ' + MAX_UPLOAD_MB + ' MB each — <span id="bsam-certcount">0 of ' + MAX_CERTIFICATES_PER_PROFILE + ' used</span>.</div>' +
      '</div>';
    }

    ov.innerHTML =
      '<div class="bss-dw" style="width:min(680px,100%);height:auto;max-height:90vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="bss-dw-h"><h3>' + (isEdit ? 'Edit Profile' : 'New Profile') + '</h3><button class="bss-x" id="bsam-x">×</button></div>' +
        '<div class="bss-dw-b"><div class="bss-f">' +
          field('bsam-name', 'Name', 'text', row.name, true) +
          field('bsam-tech', 'Tech Stack', 'text', row.techStack, true) +
          field('bsam-exp', 'Experience', 'text', row.experience, true) +
          '<div><label class="bss-lb">Work Authorization <span class="req">*</span></label><select class="bss-sel" id="bsam-auth"><option value="">Select…</option>' +
            WORK_AUTH_TYPES.map(function (a) {
              return '<option' + (row.workAuthorization === a ? ' selected' : '') + '>' + a + '</option>';
            }).join('') + '</select></div>' +
          field('bsam-email', 'Mail Id', 'email', row.email, true) +
          field('bsam-contact', 'Contact No', 'text', row.contactNo, true) +
          fileField('bsam-resume', 'Resume', row.resumeFileName, true) +
          fileField('bsam-dl', 'DL (Optional)/State ID', row.dlStateIdFileName) +
          fileField('bsam-i94', 'I-94', row.i94FileName, true) +
          certsField() +
        '</div>' +
        '<div class="bss-act"><button class="bss-btn primary" id="bsam-save">' + (isEdit ? 'Save Changes' : 'Create Profile') + '</button>' +
        '<button class="bss-btn" id="bsam-cancel">Cancel</button></div>' +
        '<div class="bss-err" id="bsam-e"></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    renderCertList();

    ov.addEventListener('click', function (e) {
      if (e.target === ov) { closeOverlay(); return; }
      var pr = e.target && e.target.closest ? e.target.closest('[data-pendingremove]') : null;
      if (pr) {
        e.stopPropagation();
        pendingCertFiles.splice(Number(pr.getAttribute('data-pendingremove')), 1);
        renderCertList();
        return;
      }
      var rm = e.target && e.target.closest ? e.target.closest('[data-certremove]') : null;
      if (rm) {
        e.stopPropagation();
        if (!isEdit || !row.id) return;
        var certId = Number(rm.getAttribute('data-certremove'));
        if (!window.confirm('Remove this certificate?')) return;
        api('/recruit/bench-sales/' + row.id + '/certificates/' + certId, { method: 'DELETE' }).then(function () {
          row.certificates = (row.certificates || []).filter(function (c) { return c.id !== certId; });
          renderCertList();
        }).catch(function (err) { toast(err.message || 'Failed to remove certificate', 'error'); });
      }
    });
    ov.querySelector('#bsam-certs').addEventListener('change', function () {
      var picked = this.files ? Array.prototype.slice.call(this.files) : [];
      this.value = '';
      if (!picked.length) return;
      var e = ov.querySelector('#bsam-e');
      for (var i = 0; i < picked.length; i++) {
        if (!isPdfFile(picked[i])) { e.textContent = picked[i].name + ' is not a PDF — only PDF uploads are allowed.'; return; }
        if (isTooLarge(picked[i])) { e.textContent = tooLargeMsg(picked[i]); return; }
      }
      var existingCount = (row.certificates || []).length;
      if (existingCount + pendingCertFiles.length + picked.length > MAX_CERTIFICATES_PER_PROFILE) {
        e.textContent = 'You can upload up to ' + MAX_CERTIFICATES_PER_PROFILE + ' certificates total (' + (existingCount + pendingCertFiles.length) + ' already selected).';
        return;
      }
      e.textContent = '';
      pendingCertFiles = pendingCertFiles.concat(picked);
      renderCertList();
    });
    ov.querySelector('#bsam-x').addEventListener('click', closeOverlay);
    ov.querySelector('#bsam-cancel').addEventListener('click', closeOverlay);

    ov.querySelector('#bsam-save').addEventListener('click', function () {
      var e = ov.querySelector('#bsam-e');
      var v = function (id) { return ov.querySelector('#' + id).value.trim(); };
      var required = [
        ['bsam-name', 'Name'], ['bsam-tech', 'Tech Stack'], ['bsam-exp', 'Experience'],
        ['bsam-auth', 'Work Authorization'], ['bsam-email', 'Mail Id'], ['bsam-contact', 'Contact No'],
      ];
      for (var r = 0; r < required.length; r++) {
        if (!v(required[r][0])) { e.textContent = required[r][1] + ' is required.'; return; }
      }
      if (!isValidEmail(v('bsam-email'))) {
        e.textContent = 'Mail Id must be a valid email address (e.g. name@example.com).'; return;
      }

      var fileInputs = [
        { id: 'bsam-resume', prefix: 'resume', label: 'Resume', required: true },
        { id: 'bsam-dl', prefix: 'dlStateId', label: 'DL (Optional)/State ID', required: false },
        { id: 'bsam-i94', prefix: 'i94', label: 'I-94', required: true },
      ];
      for (var i = 0; i < fileInputs.length; i++) {
        var inp = ov.querySelector('#' + fileInputs[i].id);
        var f = inp && inp.files && inp.files[0];
        if (f && !isPdfFile(f)) { e.textContent = fileInputs[i].label + ' must be a PDF file.'; return; }
        if (f && isTooLarge(f)) { e.textContent = fileInputs[i].label + ': ' + tooLargeMsg(f); return; }
        if (fileInputs[i].required && !f && !(isEdit && row[fileInputs[i].prefix + 'FileName'])) {
          e.textContent = fileInputs[i].label + ' is required.'; return;
        }
      }

      var newCertFiles = pendingCertFiles;
      var existingCertCount = (row.certificates || []).length;
      if (existingCertCount + newCertFiles.length === 0) {
        e.textContent = 'At least one certificate is required.'; return;
      }
      if (existingCertCount + newCertFiles.length > MAX_CERTIFICATES_PER_PROFILE) {
        e.textContent = 'You can upload up to ' + MAX_CERTIFICATES_PER_PROFILE + ' certificates total (' + existingCertCount + ' already uploaded).';
        return;
      }

      var btn = ov.querySelector('#bsam-save');
      btn.disabled = true;
      e.textContent = '';

      var payload = {
        name: v('bsam-name'), techStack: v('bsam-tech'), experience: v('bsam-exp'),
        workAuthorization: v('bsam-auth'), email: v('bsam-email'), contactNo: v('bsam-contact'),
      };
      var reads = fileInputs.map(function (f) {
        var inp2 = ov.querySelector('#' + f.id);
        var file = inp2 && inp2.files && inp2.files[0];
        if (!file) return Promise.resolve();
        return readFileAsBase64(file).then(function (r) {
          payload[f.prefix + 'FileName'] = r.name;
          payload[f.prefix + 'FileMime'] = r.mime;
          payload[f.prefix + 'FileData'] = r.data;
        });
      });
      var certReads = newCertFiles.map(function (file) {
        return readFileAsBase64(file).then(function (r) {
          return { fileName: r.name, fileMime: r.mime, fileData: r.data };
        });
      });

      Promise.all(reads).then(function () {
        return Promise.all(certReads);
      }).then(function (certs) {
        payload.certificates = certs;
        return isEdit
          ? api('/recruit/bench-sales/' + row.id, { method: 'PUT', body: payload })
          : api('/recruit/bench-sales', { method: 'POST', body: payload });
      }).then(function () {
        closeOverlay();
        toast(isEdit ? 'Profile updated' : 'Profile created');
        loadSalesProfiles();
      }).catch(function (err) {
        btn.disabled = false;
        e.textContent = err.message || 'Failed to save — check the selected files and try again.';
      });
    });
  }

  /* ── Manage Columns (show/hide + drag-reorder, saved to localStorage) ────
     Mirrors the Onboarding candidate grid's column manager. */
  function subColByKey(key) {
    for (var i = 0; i < ALL_SUB_COLS.length; i++) if (ALL_SUB_COLS[i][0] === key) return ALL_SUB_COLS[i];
    return [key, key];
  }
  function subColLabel(key) { return subColByKey(key)[1]; }
  function defaultSubColState() {
    return DEFAULT_SUB_COLS.map(function (c) { return { key: c[0], on: true }; })
      .concat(OPTIONAL_SUB_COLS.map(function (c) { return { key: c[0], on: false }; }));
  }
  function loadSubColPrefs() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_SUB_COLS) || 'null'); } catch (_) {}
    var known = {}; ALL_SUB_COLS.forEach(function (c) { known[c[0]] = 1; });
    var cols;
    if (Array.isArray(saved) && saved.length) {
      var seen = {};
      cols = saved
        .filter(function (c) { return c && c.key && known[c.key] && !seen[c.key] && (seen[c.key] = 1); })
        .map(function (c) { return { key: c.key, on: c.on !== false }; });
      defaultSubColState().forEach(function (dc) {
        if (!cols.some(function (c) { return c.key === dc.key; })) cols.push(dc);
      });
    } else {
      cols = defaultSubColState();
    }
    state.sub.cols = cols;
  }
  function saveSubColPrefs() { try { localStorage.setItem(LS_SUB_COLS, JSON.stringify(state.sub.cols)); } catch (_) {} }
  function ensureSubCols() { if (!state.sub.cols || !state.sub.cols.length) loadSubColPrefs(); }
  function shownSubCols() { ensureSubCols(); return state.sub.cols.filter(function (c) { return c.on; }); }

  var ICON_COLUMNS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="4" width="5.5" height="16" rx="1"/>' +
    '<rect x="9.5" y="4" width="5.5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/></svg>';
  var ICON_FILTERS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:6px"><line x1="4" y1="7" x2="20" y2="7"/>' +
    '<circle cx="9" cy="7" r="2.4" fill="var(--bg2,#141b26)"/><line x1="4" y1="17" x2="20" y2="17"/>' +
    '<circle cx="15" cy="17" r="2.4" fill="var(--bg2,#141b26)"/></svg>';
  /* hrms-recruit-kpi.js auto-injects a "KPI Dashboard" button into ANY
     toolbar on a /recruit/* path that has a button whose exact text is
     "Filters" (see its findFiltersButton()/isFiltersButton()) — and a global
     rule in theme-overrides.css (div:has(> #hrms-kpi-btn) button) then flattens
     every button in that same toolbar to a plain white style, which is why
     Manage Columns / Export / New Submission would lose their styling too.
     Bench Submissions doesn't want that dashboard, so the label carries a
     trailing zero-width space: renders identically as "Filters" but its
     textContent no longer matches theirs exactly, so their button never
     attaches here. Do not "clean up" this character. */
  var FILTERS_LABEL = 'Filters​';

  /* ── filtering helpers (Edit Filters drawer: Client Name + pre-defined +
     custom "contains", combined with the inline Search + Status controls) ── */
  function daysTo(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + (String(dateStr).indexOf('T') === -1 ? 'T00:00:00' : ''));
    var now = new Date();
    return Math.round((d - now) / 86400000);
  }
  function distinctSubVals(key) {
    var seen = {}, out = [];
    state.sub.rows.forEach(function (r) {
      var v = String(r[key] == null ? '' : r[key]);
      if (!(v in seen)) { seen[v] = 1; out.push(v); }
    });
    return out.sort();
  }
  function subCellRaw(row, key) {
    if (key === 'followUpVendor') return fmtDate(row.followUpVendor);
    if (key === 'interviewSchedule') return fmtDateTime(row.interviewSchedule);
    var v = row[key];
    return v == null ? '' : String(v);
  }
  function matchSubPredef(r) {
    var s = String(r.status || '').toLowerCase();
    switch (state.sub.predef) {
      case 'active': return s !== 'placed' && s !== 'rejected';
      case 'placed': return s === 'placed';
      case 'rejected': return s === 'rejected';
      case 'interviewSoon': {
        var d = daysTo(r.interviewSchedule);
        return d != null && d >= 0 && d <= 7;
      }
      case 'followupOverdue': {
        var d2 = daysTo(r.followUpVendor);
        return d2 != null && d2 < 0;
      }
      default: return true;
    }
  }
  function activeSubFilterCount() {
    var n = 0;
    if (state.sub.clientFilter) n++;
    if (state.sub.predef && state.sub.predef !== 'all') n++;
    n += state.sub.customFilters.filter(function (c) { return c.val; }).length;
    return n;
  }

  /* ── Bench Submissions ────────────────────────────────────────────────── */
  function loadSubmissions() {
    state.sub.loading = true;
    state.sub.error = '';
    renderSubmissions();
    api('/recruit/bench-submissions').then(function (rows) {
      state.sub.rows = rows || [];
      state.sub.loaded = true;
      state.sub.loading = false;
      renderSubmissions();
    }).catch(function (err) {
      state.sub.error = err.message || 'Failed to load submissions.';
      state.sub.loaded = true;
      state.sub.loading = false;
      renderSubmissions();
    });
  }

  function filteredRows() {
    var q = state.sub.search.trim().toLowerCase();
    var st = state.sub.status;
    return state.sub.rows.filter(function (r) {
      if (st && r.status !== st) return false;
      if (q && ![r.name, r.clientName, r.vendorPrimeVendor, r.vendorPersonName, r.implementationPartner]
        .some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; })) return false;
      if (state.sub.clientFilter && state.sub.clientFilter.indexOf(String(r.clientName || '')) === -1) return false;
      if (state.sub.predef !== 'all' && !matchSubPredef(r)) return false;
      for (var i = 0; i < state.sub.customFilters.length; i++) {
        var cf = state.sub.customFilters[i];
        if (cf.val && subCellRaw(r, cf.key).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  function subCell(row, key) {
    if (key === 'status') return badge(row.status, statusKind(row.status));
    if (key === 'followUpVendor') return fmtDate(row.followUpVendor);
    if (key === 'interviewSchedule') return fmtDateTime(row.interviewSchedule);
    return esc(row[key] || '—');
  }

  function buildTableHtml() {
    if (state.sub.loading) return '<div class="bss-empty2"><div class="big">⏳</div>Loading submissions…</div>';
    if (state.sub.error) return '<div class="bss-empty2"><div class="big">⚠</div>' + esc(state.sub.error) + '</div>';
    var cols = shownSubCols();
    var rows = filteredRows();
    if (!rows.length) {
      return '<div class="bss-empty2"><div class="big">🪑</div>' +
        (state.sub.rows.length ? 'No submissions match your filters.' : 'No submissions yet. Click "New Submission" to add one.') +
        '</div>';
    }
    if (!cols.length) {
      return '<div class="bss-empty2"><div class="big">📋</div>Select at least one column in Manage Columns.</div>';
    }
    var head = cols.map(function (c) { return '<th>' + esc(subColLabel(c.key)) + '</th>'; }).join('');
    var body = rows.map(function (r) {
      return '<tr class="bss-tr" data-id="' + r.id + '">' +
        cols.map(function (c) { return '<td>' + subCell(r, c.key) + '</td>'; }).join('') +
      '</tr>';
    }).join('');
    return '<div class="bss-wrap"><table class="bss-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderSubmissions() {
    var root = document.getElementById(ID.root);
    if (!root) return;
    if (!state.sub.loaded && !state.sub.loading) { loadSubmissions(); return; }

    var afc = activeSubFilterCount();
    root.innerHTML =
      '<div class="bs-h"><h2>Bench Work Submissions</h2></div>' +
      '<div class="bs-sub">Consultant profiles submitted to clients through a vendor, tracked through to interview and placement.</div>' +
      '<div class="bss-toolbar">' +
        '<input class="bss-in bss-search" id="bss-search" placeholder="Search name, client, vendor…" value="' + esc(state.sub.search) + '">' +
        '<select class="bss-sel" id="bss-status" style="width:auto">' +
          '<option value="">All statuses</option>' +
          SUBMISSION_STATUSES.map(function (s) {
            return '<option' + (state.sub.status === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select>' +
        '<button class="bss-btn' + (afc ? ' active' : '') + '" id="bss-filters" title="Edit Filters">' + ICON_FILTERS + FILTERS_LABEL +
          (afc ? '<span class="bss-fbadge">' + afc + '</span>' : '') + '</button>' +
        '<button class="bss-btn" id="bss-columns" title="Show, hide and reorder columns">' + ICON_COLUMNS + 'Manage Columns</button>' +
        '<div style="position:relative"><button class="bss-btn" id="bss-export">⭳ Export ▾</button></div>' +
        (can('recruitment.create') ? '<button class="bss-btn primary" id="bss-new">+ New Submission</button>' : '') +
        '<span class="bss-count">' + filteredRows().length + ' of ' + state.sub.rows.length + ' submissions</span>' +
      '</div>' +
      '<div id="bss-table-wrap">' + buildTableHtml() + '</div>';

    var tt = document.querySelector('.topbar-title');
    if (tt) tt.textContent = 'Bench Work Submissions';

    var searchEl = root.querySelector('#bss-search');
    if (searchEl) searchEl.addEventListener('input', function (e) {
      state.sub.search = e.target.value;
      updateTable();
    });
    var statusEl = root.querySelector('#bss-status');
    if (statusEl) statusEl.addEventListener('change', function (e) {
      state.sub.status = e.target.value;
      updateTable();
    });
    var filtersBtn = root.querySelector('#bss-filters');
    if (filtersBtn) filtersBtn.addEventListener('click', function (e) { e.stopPropagation(); openFiltersDrawer(); });
    var columnsBtn = root.querySelector('#bss-columns');
    if (columnsBtn) columnsBtn.addEventListener('click', function (e) { e.stopPropagation(); openColumnsDrawer(); });
    var exportBtn = root.querySelector('#bss-export');
    if (exportBtn) exportBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(exportBtn); });
    var newBtn = root.querySelector('#bss-new');
    if (newBtn) newBtn.addEventListener('click', function () { openSubmissionModal(null); });

    // Delegated on root, which persists across updateTable()'s partial refresh.
    root.addEventListener('click', function (e) {
      var tr = e.target && e.target.closest ? e.target.closest('.bss-tr') : null;
      if (!tr) return;
      openDrawer(Number(tr.getAttribute('data-id')));
    });
  }

  function updateTable() {
    var wrap = document.getElementById('bss-table-wrap');
    if (wrap) wrap.innerHTML = buildTableHtml();
    var countEl = document.querySelector('.bss-count');
    if (countEl) countEl.textContent = filteredRows().length + ' of ' + state.sub.rows.length + ' submissions';
    var filtersBtn = document.getElementById('bss-filters');
    if (filtersBtn) {
      var afc = activeSubFilterCount();
      filtersBtn.classList.toggle('active', !!afc);
      var badgeEl = filtersBtn.querySelector('.bss-fbadge');
      if (afc && !badgeEl) filtersBtn.insertAdjacentHTML('beforeend', '<span class="bss-fbadge">' + afc + '</span>');
      else if (afc && badgeEl) badgeEl.textContent = afc;
      else if (!afc && badgeEl) badgeEl.remove();
    }
  }

  /* ── Manage Columns drawer ────────────────────────────────────────────── */
  var colDrawerKey = null;
  function closeColumnsDrawer() {
    var ov = document.getElementById(ID.coldrawer);
    if (ov) ov.remove();
    if (colDrawerKey) { document.removeEventListener('keydown', colDrawerKey); colDrawerKey = null; }
  }
  function openColumnsDrawer() {
    ensureSubCols();
    closeColumnsDrawer();
    // Work on a copy — nothing is committed until the user hits Save.
    var working = state.sub.cols.map(function (c) { return { key: c.key, on: c.on }; });

    var ov = document.createElement('div');
    ov.id = ID.coldrawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw bss-cd" role="dialog" aria-label="Manage Columns">' +
        '<div class="bss-dw-h"><h3>Manage Columns</h3><button class="bss-x" id="bss-cd-x" title="Close">×</button></div>' +
        '<div class="bss-cd-sub"><span id="bss-cd-count"></span> OF ' + working.length + ' SELECTED</div>' +
        '<div class="bss-cd-list" id="bss-cd-list"></div>' +
        '<div class="bss-cd-f">' +
          '<button class="bss-btn primary" id="bss-cd-save">Save</button>' +
          '<button class="bss-btn" id="bss-cd-reset">Reset to Default</button>' +
          '<button class="bss-btn" id="bss-cd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    function updateCount() {
      var el = ov.querySelector('#bss-cd-count');
      if (el) el.textContent = working.filter(function (c) { return c.on; }).length;
    }
    function renderList() {
      var list = ov.querySelector('#bss-cd-list');
      list.innerHTML = working.map(function (c, i) {
        return '<div class="bss-cd-i" draggable="true" data-i="' + i + '">' +
          '<span class="bss-cd-grip" title="Drag to reorder">⋮⋮</span>' +
          '<label><input type="checkbox"' + (c.on ? ' checked' : '') + '>' + esc(subColLabel(c.key)) + '</label>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.bss-cd-i').forEach(function (el) {
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
    ov.querySelector('#bss-cd-x').addEventListener('click', closeColumnsDrawer);
    ov.querySelector('#bss-cd-cancel').addEventListener('click', closeColumnsDrawer);
    ov.querySelector('#bss-cd-reset').addEventListener('click', function () { working = defaultSubColState(); renderList(); });
    ov.querySelector('#bss-cd-save').addEventListener('click', function () {
      if (!working.some(function (c) { return c.on; })) { toast('Select at least one column to display.', 'error'); return; }
      state.sub.cols = working;
      saveSubColPrefs();
      closeColumnsDrawer();
      renderSubmissions();
    });
    colDrawerKey = function (e) { if (e.key === 'Escape') closeColumnsDrawer(); };
    document.addEventListener('keydown', colDrawerKey);
  }

  /* ── Edit Filters drawer (Client Name + pre-defined + custom "contains") ── */
  var filterDrawerKey = null;
  function closeFiltersDrawer() {
    var ov = document.getElementById(ID.fdrawer);
    if (ov) ov.remove();
    if (filterDrawerKey) { document.removeEventListener('keydown', filterDrawerKey); filterDrawerKey = null; }
  }
  function openFiltersDrawer() {
    closeFiltersDrawer();
    var clients = distinctSubVals('clientName');
    var cf = state.sub.clientFilter ? state.sub.clientFilter.slice() : clients.slice();   // default: all selected
    var predef = state.sub.predef;
    var customs = state.sub.customFilters.map(function (c) { return { key: c.key, val: c.val }; });

    var ov = document.createElement('div');
    ov.id = ID.fdrawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw bss-cd" role="dialog" aria-label="Edit Filters">' +
        '<div class="bss-dw-h"><h3>Edit Filters</h3><button class="bss-x" id="bss-fd-x" title="Close">×</button></div>' +
        '<div class="bss-fd-body">' +
          '<div class="bss-fd-sec" style="margin-top:0">Client Name</div>' +
          '<div class="bss-fd-bu" id="bss-fd-bu"></div>' +
          '<div class="bss-fd-sec">Pre-Defined Filters</div>' +
          '<div class="bss-fd-pd">' + SUB_PREDEF.map(function (p) {
            return '<label><input type="radio" name="bss-fd-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '>' + esc(p[1]) + '</label>';
          }).join('') + '</div>' +
          '<div class="bss-fd-sec">Custom Filters</div>' +
          '<div id="bss-fd-cf"></div>' +
          '<button class="bss-fd-add" id="bss-fd-add">+ Add Filter</button>' +
        '</div>' +
        '<div class="bss-cd-f">' +
          '<button class="bss-btn primary" id="bss-fd-apply">Apply</button>' +
          '<button class="bss-btn" id="bss-fd-reset">Reset</button>' +
          '<button class="bss-btn" id="bss-fd-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var buBox = ov.querySelector('#bss-fd-bu');
    function drawBu() {
      if (!clients.length) { buBox.innerHTML = '<div class="bss-fd-empty">No clients to filter yet.</div>'; return; }
      buBox.innerHTML =
        '<label><input type="checkbox" id="bss-fd-buall"' + (cf.length === clients.length ? ' checked' : '') + '> <b>(All selected)</b></label>' +
        clients.map(function (d) {
          return '<label><input type="checkbox" value="' + esc(d) + '"' + (cf.indexOf(d) !== -1 ? ' checked' : '') + '> ' + (d === '' ? '(blank)' : esc(d)) + '</label>';
        }).join('');
      buBox.querySelector('#bss-fd-buall').addEventListener('change', function (e) { cf = e.target.checked ? clients.slice() : []; drawBu(); });
      buBox.querySelectorAll('input[value]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var v = cb.value;
          if (cb.checked) { if (cf.indexOf(v) === -1) cf.push(v); }
          else { var i = cf.indexOf(v); if (i !== -1) cf.splice(i, 1); }
          var a = buBox.querySelector('#bss-fd-buall'); if (a) a.checked = cf.length === clients.length;
        });
      });
    }
    drawBu();

    ov.querySelectorAll('input[name="bss-fd-predef"]').forEach(function (r) { r.addEventListener('change', function () { predef = r.value; }); });

    var cfList = ov.querySelector('#bss-fd-cf');
    function drawCf() {
      cfList.innerHTML = customs.map(function (c, i) {
        return '<div class="bss-fd-cf"><select data-cfk="' + i + '">' + ALL_SUB_COLS.map(function (cc) {
          return '<option value="' + cc[0] + '"' + (cc[0] === c.key ? ' selected' : '') + '>' + esc(cc[1]) + '</option>';
        }).join('') + '</select>' +
        '<input data-cfv="' + i + '" placeholder="contains…" value="' + esc(c.val) + '">' +
        '<button class="bss-fd-cfx" data-cfd="' + i + '" title="Remove">×</button></div>';
      }).join('');
      cfList.querySelectorAll('[data-cfk]').forEach(function (sel) { sel.addEventListener('change', function () { customs[+sel.getAttribute('data-cfk')].key = sel.value; }); });
      cfList.querySelectorAll('[data-cfv]').forEach(function (inp) { inp.addEventListener('input', function () { customs[+inp.getAttribute('data-cfv')].val = inp.value; }); });
      cfList.querySelectorAll('[data-cfd]').forEach(function (b) { b.addEventListener('click', function () { customs.splice(+b.getAttribute('data-cfd'), 1); drawCf(); }); });
    }
    drawCf();
    ov.querySelector('#bss-fd-add').addEventListener('click', function () { customs.push({ key: 'clientName', val: '' }); drawCf(); });

    ov.addEventListener('click', function (e) { if (e.target === ov) closeFiltersDrawer(); });
    ov.querySelector('#bss-fd-x').addEventListener('click', closeFiltersDrawer);
    ov.querySelector('#bss-fd-cancel').addEventListener('click', closeFiltersDrawer);
    ov.querySelector('#bss-fd-reset').addEventListener('click', function () {
      cf = clients.slice(); predef = 'all'; customs = [];
      drawBu(); drawCf();
      ov.querySelectorAll('input[name="bss-fd-predef"]').forEach(function (r) { r.checked = r.value === 'all'; });
    });
    ov.querySelector('#bss-fd-apply').addEventListener('click', function () {
      state.sub.clientFilter = (cf.length === clients.length) ? null : cf;   // null = no restriction
      state.sub.predef = predef;
      state.sub.customFilters = customs.filter(function (c) { return c.val; });
      closeFiltersDrawer();
      renderSubmissions();
    });
    filterDrawerKey = function (e) { if (e.key === 'Escape') closeFiltersDrawer(); };
    document.addEventListener('keydown', filterDrawerKey);
  }

  /* ── export (CSV / Excel / PDF-via-print) ─────────────────────────────── */
  function exportSubRows() {
    var cols = shownSubCols();
    return {
      head: cols.map(function (c) { return subColLabel(c.key); }),
      body: filteredRows().map(function (r) {
        return cols.map(function (c) { return subCellRaw(r, c.key); });
      }),
    };
  }
  function download(bytes, name, type) {
    var b = new Blob([bytes], { type: type }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100);
  }
  function exportCsv() {
    var d = exportSubRows();
    var q = function (v) {
      v = String(v == null ? '' : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    download('﻿' + [d.head].concat(d.body).map(function (r) { return r.map(q).join(','); }).join('\r\n'),
             'bench-submissions.csv', 'text/csv;charset=utf-8;');
  }
  function exportXlsx() {
    var d = exportSubRows();
    download(buildXlsx([d.head].concat(d.body)), 'bench-submissions.xlsx',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  /* Hand-rolled OOXML + ZIP, same as hrms-onboarding.js / hrms-jobs-table.js —
     there is no bundler, so a spreadsheet library cannot be added. */
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
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Bench Work Submissions" sheetId="1" r:id="rId1"/></sheets></workbook>' },
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
    m.className = 'bss-menu';
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

  /* ── detail drawer ────────────────────────────────────────────────────── */
  function openDrawer(id) {
    var row = state.sub.rows.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    closeOverlay();
    var ov = document.createElement('div');
    ov.id = ID.drawer;
    ov.className = 'bss-ov';
    ov.innerHTML =
      '<div class="bss-dw">' +
        '<div class="bss-dw-h"><h3>' + esc(row.name) + '</h3>' + badge(row.status, statusKind(row.status)) +
          '<button class="bss-x" id="bsd-x">×</button></div>' +
        '<div class="bss-dw-b">' +
          row2('Client Name', row.clientName) +
          row2('Vendor / Prime Vendor', row.vendorPrimeVendor) +
          row2('Vendor person Name/Client', row.vendorPersonName) +
          row2('Vendor Email', row.vendorEmail) +
          row2('Vendor Contact', row.vendorContact) +
          row2('Implementation Partner', row.implementationPartner) +
          row2('Rate', row.rate) +
          row2('Role & Responsibilities', row.roleResponsibilities) +
          row2('Follow up — Vendor', fmtDate(row.followUpVendor)) +
          row2('Interview Schedule (Follow up to candidate)', fmtDateTime(row.interviewSchedule)) +
          row2('Created By', row.createdBy) +
          '<div class="bss-act">' +
            (can('recruitment.edit') ? '<button class="bss-btn primary" id="bsd-edit">Edit</button>' : '') +
            (can('recruitment.delete') ? '<button class="bss-btn danger" id="bsd-del">Delete</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
    ov.querySelector('#bsd-x').addEventListener('click', closeOverlay);
    var editBtn = ov.querySelector('#bsd-edit');
    if (editBtn) editBtn.addEventListener('click', function () { openSubmissionModal(row); });
    var delBtn = ov.querySelector('#bsd-del');
    if (delBtn) delBtn.addEventListener('click', function () { deleteSubmission(row); });
  }
  function row2(k, v) {
    return '<div class="bss-row2"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v || '—') + '</span></div>';
  }
  function closeOverlay() {
    var d = document.getElementById(ID.drawer);
    if (d) d.remove();
    var m = document.getElementById(ID.modal);
    if (m) m.remove();
  }

  function deleteSubmission(row) {
    if (!window.confirm('Delete the submission for "' + row.name + '"? This cannot be undone.')) return;
    api('/recruit/bench-submissions/' + row.id, { method: 'DELETE' }).then(function () {
      closeOverlay();
      toast('Submission deleted');
      loadSubmissions();
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /* ── New / Edit Submission form ──────────────────────────────────────────
     Field set mirrors the Onboarding "New Candidate" form (hrms-onboarding.js
     renderNewModal): a two-column grid of plain labeled inputs, required
     fields marked with a red asterisk, Save/Cancel footer. */
  function openSubmissionModal(row) {
    closeOverlay();
    var isEdit = !!row;
    row = row || {};
    var ov = document.createElement('div');
    ov.id = ID.modal;
    ov.className = 'bss-ov';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';

    function field(id, label, type, value, required, full) {
      var val = value == null ? '' : value;
      return '<div' + (full ? ' class="full"' : '') + '>' +
        '<label class="bss-lb">' + esc(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
        (type === 'textarea'
          ? '<textarea class="bss-ta" id="' + id + '">' + esc(val) + '</textarea>'
          : '<input class="bss-in" id="' + id + '" type="' + type + '" value="' + esc(val) + '">') +
        '</div>';
    }

    ov.innerHTML =
      '<div class="bss-dw" style="width:min(680px,100%);height:auto;max-height:90vh;border-radius:14px;border:1px solid var(--border,#2a3446)">' +
        '<div class="bss-dw-h"><h3>' + (isEdit ? 'Edit Submission' : 'New Submission') + '</h3><button class="bss-x" id="bsm-x">×</button></div>' +
        '<div class="bss-dw-b"><div class="bss-f">' +
          field('bsm-name', 'Name', 'text', row.name, true) +
          field('bsm-client', 'Client Name', 'text', row.clientName, true) +
          field('bsm-vendor', 'Vendor / Prime Vendor', 'text', row.vendorPrimeVendor, true) +
          field('bsm-vperson', 'Vendor person Name/Client', 'text', row.vendorPersonName, true) +
          field('bsm-vemail', 'Vendor Email', 'email', row.vendorEmail, true) +
          field('bsm-vcontact', 'Vendor contact', 'text', row.vendorContact, true) +
          field('bsm-impl', 'Implementation Partner', 'text', row.implementationPartner, true) +
          field('bsm-rate', 'Rate', 'text', row.rate, true) +
          '<div><label class="bss-lb">Submission Status <span class="req">*</span></label><select class="bss-sel" id="bsm-status">' +
            SUBMISSION_STATUSES.map(function (s) {
              return '<option' + ((row.status || 'Submitted') === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('') + '</select></div>' +
          field('bsm-followup', 'Follow up - Vendor', 'date', row.followUpVendor) +
          field('bsm-interview', 'Interview Schedule (Follow up to candidate)', 'datetime-local', row.interviewSchedule) +
          field('bsm-role', 'Role & Responsibilities', 'textarea', row.roleResponsibilities, false, true) +
        '</div>' +
        '<div class="bss-act"><button class="bss-btn primary" id="bsm-save">' + (isEdit ? 'Save Changes' : 'Create Submission') + '</button>' +
        '<button class="bss-btn" id="bsm-cancel">Cancel</button></div>' +
        '<div class="bss-err" id="bsm-e"></div></div>' +
      '</div>';
    document.body.appendChild(ov);

    ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
    ov.querySelector('#bsm-x').addEventListener('click', closeOverlay);
    ov.querySelector('#bsm-cancel').addEventListener('click', closeOverlay);

    ov.querySelector('#bsm-save').addEventListener('click', function () {
      var e = ov.querySelector('#bsm-e');
      var v = function (id) { return ov.querySelector('#' + id).value.trim(); };
      var required = [
        ['bsm-name', 'Name'], ['bsm-client', 'Client Name'], ['bsm-vendor', 'Vendor / Prime Vendor'],
        ['bsm-vperson', 'Vendor person Name/Client'], ['bsm-vemail', 'Vendor Email'],
        ['bsm-vcontact', 'Vendor contact'], ['bsm-impl', 'Implementation Partner'], ['bsm-rate', 'Rate'],
      ];
      for (var i = 0; i < required.length; i++) {
        if (!v(required[i][0])) { e.textContent = required[i][1] + ' is required.'; return; }
      }
      if (!isValidEmail(v('bsm-vemail'))) {
        e.textContent = 'Vendor Email must be a valid email address (e.g. name@example.com).'; return;
      }
      var btn = ov.querySelector('#bsm-save');
      btn.disabled = true;
      e.textContent = '';
      var payload = {
        name: v('bsm-name'), clientName: v('bsm-client'), vendorPrimeVendor: v('bsm-vendor'),
        vendorPersonName: v('bsm-vperson'), vendorEmail: v('bsm-vemail'), vendorContact: v('bsm-vcontact'),
        implementationPartner: v('bsm-impl'), rate: v('bsm-rate'), status: v('bsm-status'),
        followUpVendor: v('bsm-followup') || null, interviewSchedule: v('bsm-interview') || null,
        roleResponsibilities: v('bsm-role'),
      };
      var req = isEdit
        ? api('/recruit/bench-submissions/' + row.id, { method: 'PUT', body: payload })
        : api('/recruit/bench-submissions', { method: 'POST', body: payload });
      req.then(function () {
        closeOverlay();
        toast(isEdit ? 'Submission updated' : 'Submission created');
        loadSubmissions();
      }).catch(function (err) {
        btn.disabled = false;
        e.textContent = err.message;
      });
    });
  }

  /* ── sidebar entries ──────────────────────────────────────────────────
     Inserted right after the native "Job Board" link inside the existing
     Recruit section (Recruit is a real React route, unlike Onboarding, so
     there is no whole-section NAV_INJECT hook to reuse here — see
     hrms-perms.js for that pattern; this inserts single items into an
     already-rendered section instead). Bench Sales and Bench Submissions are
     independent sibling items — same indentation, same nav-item styling. */
  function svg(body) {
    return '<svg viewBox="0 0 16 16" fill="none" width="16" stroke="currentColor" ' +
           'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }
  var ICON_BENCH = svg('<rect x="2" y="6.6" width="12" height="2.2" rx="1"/><path d="M3.4 8.8V13M12.6 8.8V13"/><path d="M4.6 6.6V4.8a1.6 1.6 0 011.6-1.6h3.6a1.6 1.6 0 011.6 1.6v1.8"/>');
  var ICON_SUBMIT = svg('<path d="M4 1.8h4.6L12 5.2v9H4z"/><path d="M8.4 1.9v3.4H12"/><path d="M5.8 9.6l1.6 1.6 2.8-3.1"/>');

  function injectNav() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (document.getElementById('hrms-bench-sales-link')) return;
    var jobBoard = sidebar.querySelector('a.nav-item[href="/recruit/job-board"]');
    if (!jobBoard) return;

    var submissions = document.createElement('a');
    submissions.className = 'nav-item';
    submissions.id = 'hrms-bench-submissions-link';
    submissions.href = '/recruit/bench-submissions';
    submissions.innerHTML = '<span class="nav-icon">' + ICON_SUBMIT + '</span>Bench Work Submissions';
    jobBoard.parentNode.insertBefore(submissions, jobBoard.nextSibling);

    var sales = document.createElement('a');
    sales.className = 'nav-item';
    sales.id = 'hrms-bench-sales-link';
    sales.href = '/recruit/bench-sales';
    sales.innerHTML = '<span class="nav-icon">' + ICON_BENCH + '</span>Bench Sales';
    jobBoard.parentNode.insertBefore(sales, jobBoard.nextSibling);

    updateActiveNav();
  }
  function updateActiveNav() {
    var sales = document.getElementById('hrms-bench-sales-link');
    var subs = document.getElementById('hrms-bench-submissions-link');
    if (sales) sales.className = 'nav-item' + (state.page === 'sales' ? ' active' : '');
    if (subs) subs.className = 'nav-item' + (state.page === 'submissions' ? ' active' : '');

    // React marks a nav-item "active" based on ITS OWN idea of the current
    // route, which our pushState-based navigation never updates (see the
    // routing comment below) — so other Recruit links (commonly "Recruit"
    // and/or "Job Board") are left showing a stale "active" highlight
    // alongside ours. When one of our pages really is the active one, strip
    // that stray class from everything else so only one item is ever lit up.
    if (state.page) {
      var sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        var stray = sidebar.querySelectorAll('a.nav-item.active');
        for (var i = 0; i < stray.length; i++) {
          if (stray[i] !== sales && stray[i] !== subs) stray[i].classList.remove('active');
        }
      }
    }
  }

  /* ── routing ──────────────────────────────────────────────────────────
     Mirrors hrms-onboarding.js's approach: the React bundle has no route for
     either of our paths, so a deep link or an F5 gets bounced by its
     catch-all (which lands on '/'). `armed` holds the path we intend to be
     on and is used to undo exactly that bounce — see onboarding's own
     routing comment for the full rationale. */
  function currentPage() {
    var p = String(location.pathname || '').replace(/\/+$/, '');
    return ROUTES[p] || null;
  }
  function pathForPage(page) {
    for (var p in ROUTES) if (ROUTES[p] === page) return p;
    return '/recruit/bench-sales';
  }
  function requestedPath() {
    try {
      var nav = (performance.getEntriesByType('navigation') || [])[0];
      if (nav && nav.name) return new URL(nav.name, location.origin).pathname;
    } catch (_) {}
    return location.pathname;
  }
  var armed = ROUTES[String(requestedPath() || '').replace(/\/+$/, '')] || null;

  function navigate(page) {
    armed = page;
    history.pushState({}, '', pathForPage(page));
    ensureLayout();
    if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
  }

  function onNavClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('a.nav-item') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (ROUTES[href]) {
      e.preventDefault();
      e.stopPropagation();
      navigate(ROUTES[href]);
    } else {
      armed = null;   // a real navigation away — stop re-asserting our URL
    }
  }

  function render() {
    if (state.page === 'submissions') renderSubmissions();
    else renderSales();
  }

  function ensureLayout() {
    var page = currentPage();

    if (page === null && armed !== null && location.pathname === '/') {
      history.replaceState({}, '', pathForPage(armed));
      page = armed;
      if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
    }

    if (page === null) {
      var old = document.getElementById(ID.root);
      if (old) old.remove();
      closeOverlay();
      var c = document.querySelector('.content');
      if (c && c.dataset.bsHidden) { c.style.display = ''; delete c.dataset.bsHidden; }
      // Keep the Recruit section's topbar title honest. React only reliably
      // refreshes .topbar-title on a route transition ITS OWN router drove;
      // once any script (this one included) has written to that node
      // directly, later transitions between OTHER Recruit pages (e.g.
      // Resume Scoring -> ATS, with no Bench Sales page involved at all) can
      // be left showing a stale title too, not just transitions out of our
      // own pages — so this corrects it on every check, for as long as it is
      // wrong, rather than only once on the way out.
      var sibling = SIBLING_TITLES[String(location.pathname || '').replace(/\/+$/, '')];
      if (sibling) {
        var ttOut = document.querySelector('.topbar-title');
        if (ttOut && ttOut.textContent !== sibling) ttOut.textContent = sibling;
      }
      injectNav();
      state.page = null;
      updateActiveNav();
      return;
    }
    armed = page;
    var main = document.querySelector('.main');
    var content = document.querySelector('.content');
    injectNav();
    if (!main) return;

    ensureStyle();

    if (content && content.style.display !== 'none') {
      content.style.display = 'none';
      content.dataset.bsHidden = '1';
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
    if (!changed) { updateActiveNav(); return; }

    state.page = page;
    updateActiveNav();
    render();
  }

  function start() {
    // Capture phase: must run before the sidebar's own click handling.
    document.addEventListener('click', onNavClick, true);
    ensureLayout();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; ensureLayout(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () {
      armed = currentPage();
      setTimeout(ensureLayout, 60);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
