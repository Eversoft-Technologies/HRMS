import os

payroll_js_content = r'''/**
 * hrms-payroll.js - Complete Enterprise Payroll Management System
 * ---------------------------------------------------------------------------
 * Production-ready Payroll Suite for Eversoft HRMS:
 *   1. Executive Payroll Dashboard (KPIs, Monthly Trends, Dept Distribution)
 *   2. Guided 8-Step Payroll Processing Wizard (Period -> Attendance -> LOP/OT -> Calc -> Validate -> Review -> Submit -> Release)
 *   3. Pay Runs Engine (Batch runs, duplicate prevention, locked runs)
 *   4. Employee Salary Management (CTC revisions, structure assignments, history)
 *   5. Salary Structure Management (Earnings, Deductions, percentage & formula builder)
 *   6. Payslip Management (Confidential employee access, Eversoft PDF/HTML layout)
 *   7. Multi-Level Approval Pipeline (Executive -> HR -> Finance -> Super Admin)
 *   8. Payment Disbursal & Bank Transfers (NEFT/RTGS CSV, NACHA export, status tracking)
 *   9. Statutory Reports & Tax Compliance (PF, ESI, Professional Tax, TDS)
 */
(function () {
  'use strict';

  var ID = {
    root: 'hrms-payroll-root',
    style: 'hrms-payroll-style',
    modal: 'hrms-payroll-modal',
    toast: 'hrms-payroll-toast',
  };

  var state = {
    activeTab: 'dashboard', // 'dashboard' | 'wizard' | 'runs' | 'compensations' | 'structures' | 'payslips' | 'approvals' | 'payments' | 'reports'
    dashboard: null,
    runs: [],
    payslips: [],
    compensations: [],
    structures: [],
    components: [],
    payments: [],
    approvals: [],
    loading: false,
    selectedRunId: null,
    selectedRun: null,
    selectedRunEntries: [],
    selectedRunValidation: null,
    attendanceSummary: [],
    wizardStep: 1, // 1 to 8
    wizardForm: {
      period_label: new Date().toISOString().slice(0, 7),
      period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      period_end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10),
      pay_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 5).toISOString().slice(0, 10),
      notes: ''
    },
    searchQuery: '',
    departmentFilter: '',
    selectedPeriodFilter: '',
    modalOpen: false,
    modalType: null, // 'newRun' | 'viewRun' | 'reviseSalary' | 'structureModal' | 'adjustmentModal' | 'approvalModal' | 'payslipPreview' | 'paymentFailModal'
    modalData: null,
    reportType: 'monthly', // 'monthly' | 'department' | 'statutory'
    reportData: null,
    pages: { dashboard: 1, wizard: 1, runs: 1, compensations: 1, structures: 1, payslips: 1, approvals: 1, payments: 1, reports: 1 },
    selectedPaymentIds: [],
  };

  var PAGE_SIZE = 8;

  function pageOf(key, list) {
    list = list || [];
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    var page = Math.min(Math.max(1, state.pages[key] || 1), pages);
    state.pages[key] = page;
    var from = (page - 1) * PAGE_SIZE;
    var to = Math.min(total, from + PAGE_SIZE);
    return { items: list.slice(from, to), total: total, pages: pages, page: page, from: from, to: to };
  }

  function pagerHtml(key, pg, noun) {
    if (!pg || pg.total <= PAGE_SIZE) return '';
    var nums = '';
    for (var n = 1; n <= pg.pages; n++) {
      nums += '<button type="button" data-pr-page="' + n + '" data-pr-list="' + key + '"' +
        (n === pg.page ? ' class="on" aria-current="page"' : '') + '>' + n + '</button>';
    }
    return '<div class="pr-pager">' +
      '<div class="pr-pager-info">Showing <b>' + (pg.from + 1) + '–' + pg.to + '</b> of <b>' + pg.total + '</b> ' + noun + '</div>' +
      '<div class="pr-pager-nav">' +
      '<button type="button" data-pr-page="' + (pg.page - 1) + '" data-pr-list="' + key + '"' + (pg.page <= 1 ? ' disabled' : '') + '>Prev</button>' +
      nums +
      '<button type="button" data-pr-page="' + (pg.page + 1) + '" data-pr-list="' + key + '"' + (pg.page >= pg.pages ? ' disabled' : '') + '>Next</button>' +
      '</div></div>';
  }

  function isPayrollRoute() {
    var p = (location.pathname || '').replace(/\/+$/, '');
    return p === '/payroll/run' || p === '/payroll' || p === '/payroll/runs' || p === '/payroll/dashboard';
  }

  function formatCurrency(val) {
    if (val === undefined || val === null || isNaN(val)) return '₹0.00';
    return '₹' + Number(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function getLoggedInUser() {
    var email = localStorage.getItem('employee_email') || localStorage.getItem('user_email') || '';
    var name = localStorage.getItem('employee_name') || localStorage.getItem('user_name') || (email ? email.split('@')[0] : 'Admin');
    var role = localStorage.getItem('user_role') || 'Admin';
    return { email: email, name: name, role: role };
  }

  /* ── UI Styling (HRMS Dark/Light Theme Support) ── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var css = [
      'body[data-payroll-active="1"] .content { display: none !important; }',
      'body[data-payroll-active="1"] .main > .content { display: none !important; }',
      '#' + ID.root + ' { padding: 24px 32px 64px; color: var(--text, #e8edf7); font-family: "DM Sans", -apple-system, sans-serif; }',
      '#' + ID.root + ' * { box-sizing: border-box; }',
      '.pr-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }',
      '.pr-title-group h2 { margin: 0 0 6px 0; font-size: 24px; font-weight: 700; font-family: "Syne", sans-serif; color: var(--text, #fff); display: flex; align-items: center; gap: 10px; }',
      '.pr-title-group p { margin: 0; font-size: 13.5px; color: var(--text2, #8a9bb8); }',
      '.pr-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }',
      '.pr-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.18s ease; border: 1px solid transparent; text-decoration: none; }',
      '.pr-btn-primary { background: linear-gradient(135deg, var(--accent, #4f8ef7), #2563eb); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,0.25); }',
      '.pr-btn-primary:hover { opacity: 0.93; transform: translateY(-1px); }',
      '.pr-btn-secondary { background: var(--bg3, rgba(255,255,255,0.06)); border-color: var(--border, rgba(255,255,255,0.12)); color: var(--text, #fff); }',
      '.pr-btn-secondary:hover { background: var(--bg2, rgba(255,255,255,0.1)); }',
      '.pr-btn-success { background: #059669; color: #fff; }',
      '.pr-btn-success:hover { background: #047857; }',
      '.pr-btn-danger { background: #dc2626; color: #fff; }',
      '.pr-btn-danger:hover { background: #b91c1c; }',
      '.pr-btn-warning { background: #d97706; color: #fff; }',
      '.pr-btn-warning:hover { background: #b45309; }',
      '.pr-btn-sm { padding: 4px 9px; font-size: 11.5px; border-radius: 6px; }',

      /* Stat Cards */
      '.pr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }',
      '.pr-stat-card { background: var(--bg2, #161b26); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 5px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }',
      '.pr-stat-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3, #8a9bb8); font-weight: 600; }',
      '.pr-stat-val { font-size: 20px; font-weight: 700; color: var(--text, #fff); font-family: "Syne", sans-serif; }',
      '.pr-stat-sub { font-size: 11px; color: var(--text2, #9ca3af); }',

      /* Nav Tabs */
      '.pr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); margin-bottom: 22px; overflow-x: auto; padding-bottom: 2px; }',
      '.pr-tab { padding: 9px 14px; font-size: 13px; font-weight: 600; color: var(--text2, #8a9bb8); border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 6px; white-space: nowrap; }',
      '.pr-tab:hover { color: var(--text, #fff); }',
      '.pr-tab.active { color: var(--accent, #4f8ef7); border-bottom-color: var(--accent, #4f8ef7); }',
      '.pr-tab-badge { background: var(--bg3, rgba(255,255,255,0.08)); padding: 2px 6px; border-radius: 10px; font-size: 10.5px; font-weight: 700; }',

      /* Cards & Tables */
      '.pr-card { background: var(--bg2, #161b26); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin-bottom: 24px; }',
      '.pr-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); gap: 12px; flex-wrap: wrap; }',
      '.pr-search { background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 6px 12px; border-radius: 6px; font-size: 12.5px; min-width: 200px; outline: none; }',
      '.pr-search:focus { border-color: var(--accent, #4f8ef7); }',
      '.pr-select { background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 6px 10px; border-radius: 6px; font-size: 12px; outline: none; }',
      '.pr-table-wrap { overflow-x: auto; width: 100%; }',
      '.pr-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px; }',
      '.pr-table th { background: var(--bg3, rgba(255,255,255,0.03)); color: var(--text3, #8a9bb8); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; padding: 11px 16px; font-weight: 600; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); }',
      '.pr-table td { padding: 12px 16px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.04)); vertical-align: middle; color: var(--text, #e8edf7); }',
      '.pr-table tr:hover td { background: var(--bg3, rgba(255,255,255,0.02)); }',

      /* Status Badges */
      '.pr-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: capitalize; }',
      '.pr-badge-draft { background: rgba(156,163,175,0.15); color: #9ca3af; }',
      '.pr-badge-processing { background: rgba(59,130,246,0.15); color: #60a5fa; }',
      '.pr-badge-pending_approval { background: rgba(245,158,11,0.15); color: #fbbf24; }',
      '.pr-badge-approved { background: rgba(16,185,129,0.15); color: #34d399; }',
      '.pr-badge-paid { background: rgba(16,185,129,0.22); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }',
      '.pr-badge-rejected { background: rgba(239,68,68,0.15); color: #f87171; }',
      '.pr-badge-needs_correction { background: rgba(236,72,153,0.15); color: #f472b6; }',

      /* Stepper Wizard */
      '.pr-stepper { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; background: var(--bg3, rgba(255,255,255,0.02)); border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); overflow-x: auto; gap: 8px; }',
      '.pr-step-item { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--text3, #6b7280); cursor: pointer; white-space: nowrap; }',
      '.pr-step-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; background: var(--bg2, rgba(255,255,255,0.08)); color: var(--text2, #9ca3af); }',
      '.pr-step-item.active { color: var(--accent, #4f8ef7); }',
      '.pr-step-item.active .pr-step-num { background: var(--accent, #4f8ef7); color: #fff; }',
      '.pr-step-item.done { color: #10b981; }',
      '.pr-step-item.done .pr-step-num { background: #10b981; color: #fff; }',
      '.pr-step-sep { height: 1px; flex: 1; min-width: 16px; background: var(--border, rgba(255,255,255,0.08)); }',

      /* Charts Grid */
      '.pr-charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }',
      '@media (max-width: 900px) { .pr-charts-grid { grid-template-columns: 1fr; } }',
      '.pr-chart-box { background: var(--bg2, #161b26); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 12px; padding: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }',
      '.pr-chart-title { font-size: 14px; font-weight: 700; margin-bottom: 14px; color: var(--text, #fff); font-family: "Syne", sans-serif; }',

      /* Modal / Drawer */
      '#' + ID.modal + ' { position: fixed; inset: 0; z-index: 99999; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.72); backdrop-filter: blur(4px); padding: 20px; }',
      '.pr-modal-box { background: var(--bg2, #0f131a); color: var(--text, #e8edf7); border: 1px solid var(--border, rgba(255,255,255,0.12)); border-radius: 14px; width: 100%; max-width: 680px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 45px rgba(0,0,0,0.5); display: flex; flex-direction: column; }',
      '.pr-modal-header { padding: 18px 24px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); display: flex; justify-content: space-between; align-items: center; }',
      '.pr-modal-header h3 { margin: 0; font-size: 18px; font-weight: 700; font-family: "Syne", sans-serif; color: var(--text, #fff); }',
      '.pr-modal-close { background: none; border: none; font-size: 20px; color: var(--text2, #8a9bb8); cursor: pointer; }',
      '.pr-modal-body { padding: 20px 24px; flex: 1; }',
      '.pr-modal-footer { padding: 16px 24px; border-top: 1px solid var(--border, rgba(255,255,255,0.08)); display: flex; justify-content: flex-end; gap: 10px; }',
      '.pr-form-group { margin-bottom: 16px; }',
      '.pr-form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--text2, #8a9bb8); }',
      '.pr-form-group input, .pr-form-group select, .pr-form-group textarea { width: 100%; padding: 8px 12px; border-radius: 7px; background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.12)); color: var(--text, #fff); font-size: 13px; outline: none; }',

      /* Toast */
      '#' + ID.toast + ' { position: fixed; bottom: 24px; right: 24px; z-index: 100000; padding: 12px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.35); }',
      '#' + ID.toast + '.success { background: #059669; color: #fff; }',
      '#' + ID.toast + '.error { background: #dc2626; color: #fff; }',

      /* Pager */
      '.pr-pager { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; font-size: 12px; color: var(--text2, #8a9bb8); }',
      '.pr-pager-nav { display: flex; gap: 5px; }',
      '.pr-pager-nav button { background: var(--bg3, rgba(255,255,255,0.05)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 11.5px; }',
      '.pr-pager-nav button.on { background: var(--accent, #4f8ef7); border-color: var(--accent, #4f8ef7); color: #fff; }',
      '.pr-pager-nav button:disabled { opacity: 0.4; cursor: not-allowed; }',
      /* Light theme: the pale badge / accent text used for dark mode is unreadable on white. */
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-draft { color: #4b5563; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-processing { color: #1d4ed8; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-pending_approval { color: #b45309; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-approved, html[data-theme="light"] #' + ID.root + ' .pr-badge-paid { color: #047857; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-rejected { color: #b91c1c; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-badge-needs_correction { color: #be185d; }',
      'html[data-theme="light"] #' + ID.root + ' .pr-stat-card, html[data-theme="light"] #' + ID.root + ' .pr-card, html[data-theme="light"] #' + ID.root + ' .pr-chart-box { box-shadow: 0 1px 4px rgba(15,23,42,0.08); }',
      '.pr-form-group select option { color: #0f172a; }',
      '.pr-muted { color: var(--text2, #8a9bb8); }'
    ];

    var styleEl = document.createElement('style');
    styleEl.id = ID.style;
    styleEl.textContent = css.join('\n');
    document.head.appendChild(styleEl);
  }

  /* fetch → JSON, but a failed request REJECTS (with the server's message)
     instead of being treated as data, so a wizard step never advances on an
     error and every button shows what went wrong. */
  function call(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(url, init).then(function (r) {
      return r.text().then(function (txt) {
        var d = null; try { d = txt ? JSON.parse(txt) : null; } catch (_) {}
        if (!r.ok) {
          var msg = (d && (d.error || d.message || d.detail)) || ('Request failed (' + r.status + ')');
          if (d && !d.error && !d.message && !d.detail && typeof d === 'object') {
            var k = Object.keys(d)[0]; if (k) msg = k + ': ' + [].concat(d[k]).join(' ');
          }
          throw new Error(msg);
        }
        return d;
      });
    });
  }
  function fail(e) { showToast((e && e.message) || 'Something went wrong.', true); }
  /* Payroll files (payslip HTML, bank CSVs) need the caller's identity headers,
     which hrms-actor.js only adds to fetch() — a plain <a href> / window.open
     sends none and is refused (401). So fetch the file and hand the browser a
     Blob URL instead. */
  function fetchFile(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (txt) {
          var d = null; try { d = txt ? JSON.parse(txt) : null; } catch (_) {}
          throw new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
        });
      }
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      return r.blob().then(function (b) { return { blob: b, name: m ? decodeURIComponent(m[1]) : '' }; });
    });
  }
  function downloadFile(url, fallbackName) {
    return fetchFile(url).then(function (f) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob);
      a.download = f.name || fallbackName || 'download';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return f;
    });
  }
  function openFile(url) {
    // Open the tab now (inside the click) so a popup blocker allows it.
    var w = window.open('', '_blank');
    if (w) { try { w.document.write('<p style="font-family:sans-serif;color:#64748b">Loading…</p>'); } catch (_) {} }
    return fetchFile(url).then(function (f) {
      var u = URL.createObjectURL(f.blob);
      if (w) { w.location.href = u; } else { window.location.assign(u); }
      setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
    }).catch(function (e) { if (w) { try { w.close(); } catch (_) {} } throw e; });
  }
  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /* Modal on the existing .pr-modal-* styles. onSave(box) returns a promise;
     the modal closes when it resolves and shows the error when it rejects. */
  function openModal(title, bodyHtml, saveLabel, onSave) {
    ensureStyle();
    var ov = document.getElementById(ID.modal);
    if (!ov) { ov = document.createElement('div'); ov.id = ID.modal; document.body.appendChild(ov); }
    ov.innerHTML = '<div class="pr-modal-box" role="dialog" aria-modal="true">' +
      '<div class="pr-modal-header"><h3>' + escH(title) + '</h3><button type="button" class="pr-modal-close" aria-label="Close">×</button></div>' +
      '<div class="pr-modal-body">' + bodyHtml + '<div class="pr-modal-err" style="color:#dc2626;font-size:12.5px;min-height:16px"></div></div>' +
      '<div class="pr-modal-footer"><button type="button" class="pr-btn pr-btn-secondary" data-pr-cancel>Cancel</button>' +
      '<button type="button" class="pr-btn pr-btn-primary" data-pr-save>' + escH(saveLabel || 'Save') + '</button></div></div>';
    ov.style.display = 'flex';
    var close = function () { ov.style.display = 'none'; ov.innerHTML = ''; };
    ov.querySelector('.pr-modal-close').onclick = close;
    ov.querySelector('[data-pr-cancel]').onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };
    var save = ov.querySelector('[data-pr-save]');
    save.onclick = function () {
      var errEl = ov.querySelector('.pr-modal-err');
      errEl.textContent = '';
      save.disabled = true;
      Promise.resolve().then(function () { return onSave(ov); })
        .then(function () { close(); })
        .catch(function (e) { save.disabled = false; errEl.textContent = (e && e.message) || 'Could not save.'; });
    };
    var first = ov.querySelector('input,select,textarea'); if (first) first.focus();
    return ov;
  }
  function val(box, id) { var el = box.querySelector('#' + id); return el ? String(el.value || '').trim() : ''; }

  function showToast(msg, isErr) {
    var toast = document.getElementById(ID.toast);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = ID.toast;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = isErr ? 'error' : 'success';
    toast.style.display = 'block';
    setTimeout(function () { toast.style.display = 'none'; }, 4000);
  }

  /* ── API Data Loaders ── */
  function loadPayrollData() {
    state.loading = true;
    Promise.all([
      fetch('/api/payroll/dashboard').then(function (r) { return r.ok ? r.json() : null; }),
      fetch('/api/payroll/runs').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/payslips').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/compensations').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/structures').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/components').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/payments').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/approvals').then(function (r) { return r.ok ? r.json() : []; }),
    ]).then(function (res) {
      state.dashboard = res[0];
      state.runs = res[1] || [];
      state.payslips = res[2] || [];
      state.compensations = res[3] || [];
      state.structures = res[4] || [];
      state.components = res[5] || [];
      state.payments = res[6] || [];
      state.approvals = res[7] || [];
      state.loading = false;
      render();
    }).catch(function (err) {
      console.error('Payroll API load error:', err);
      state.loading = false;
      render();
    });
  }

  /* ── Main Render Router ── */
  function render() {
    var root = document.getElementById(ID.root);
    if (!root) return;

    var html = [];
    html.push('<div class="pr-header">');
    html.push('  <div class="pr-title-group">');
    html.push('    <h2>💼 Payroll & Compensation Suite <span style="font-size:12px; font-weight:600; padding:2px 8px; border-radius:10px; background:rgba(79,142,247,0.15); color:var(--accent,#4f8ef7);">Production v2.4</span></h2>');
    html.push('    <p>Guided Indian Payroll Engine • Statutory PF/ESI/PT/TDS • Multi-Level Approvals • Direct Deposit Disbursal</p>');
    html.push('  </div>');
    html.push('  <div class="pr-actions">');
    html.push('    <button class="pr-btn pr-btn-primary" id="pr-btn-start-wizard">⚡ Process Payroll Wizard</button>');
    html.push('    <button class="pr-btn pr-btn-secondary" id="pr-btn-refresh">🔄 Refresh</button>');
    html.push('  </div>');
    html.push('</div>');

    // Navigation Tabs
    html.push('<div class="pr-tabs">');
    var tabs = [
      { id: 'dashboard', label: '📊 Dashboard', count: null },
      { id: 'wizard', label: '⚡ Guided Wizard (8-Steps)', count: null },
      { id: 'runs', label: '🔄 Pay Runs', count: state.runs.length },
      { id: 'compensations', label: '👥 Employee Salaries', count: state.compensations.length },
      { id: 'structures', label: '📐 Salary Structures', count: state.structures.length },
      { id: 'payslips', label: '📄 Payslips', count: state.payslips.length },
      { id: 'approvals', label: '🛡️ Approvals', count: state.approvals.filter(function(a){ return a.action === 'submitted'; }).length },
      { id: 'payments', label: '💳 Payment Disbursal', count: state.payments.filter(function(p){ return p.status === 'pending'; }).length },
      { id: 'reports', label: '📈 Reports & Tax', count: null },
    ];

    tabs.forEach(function (t) {
      var activeClass = state.activeTab === t.id ? ' active' : '';
      var badge = t.count !== null ? '<span class="pr-tab-badge">' + t.count + '</span>' : '';
      html.push('<div class="pr-tab' + activeClass + '" data-tab="' + t.id + '">' + t.label + badge + '</div>');
    });
    html.push('</div>');

    // Render Active Tab Content
    if (state.activeTab === 'dashboard') {
      html.push(renderDashboardTab());
    } else if (state.activeTab === 'wizard') {
      html.push(renderWizardTab());
    } else if (state.activeTab === 'runs') {
      html.push(renderRunsTab());
    } else if (state.activeTab === 'compensations') {
      html.push(renderCompensationsTab());
    } else if (state.activeTab === 'structures') {
      html.push(renderStructuresTab());
    } else if (state.activeTab === 'payslips') {
      html.push(renderPayslipsTab());
    } else if (state.activeTab === 'approvals') {
      html.push(renderApprovalsTab());
    } else if (state.activeTab === 'payments') {
      html.push(renderPaymentsTab());
    } else if (state.activeTab === 'reports') {
      html.push(renderReportsTab());
    }

    root.innerHTML = html.join('\n');
    bindEvents(root);
    if (state.activeTab === 'dashboard') {
      initDashboardCharts();
    }
  }

  /* ── TAB 1: DASHBOARD ── */
  function renderDashboardTab() {
    var d = state.dashboard || {};
    var out = [];

    // KPI Cards
    out.push('<div class="pr-stats">');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Total Staff</span><span class="pr-stat-val">' + (d.total_employees || state.compensations.length || 0) + '</span><span class="pr-stat-sub">Active Compensation Records</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Total Gross Salary</span><span class="pr-stat-val">' + formatCurrency(d.total_gross || 0) + '</span><span class="pr-stat-sub">Latest Pay Run</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Total Net Disbursable</span><span class="pr-stat-val" style="color:#10b981;">' + formatCurrency(d.total_net || 0) + '</span><span class="pr-stat-sub">Net Pay After Deductions</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Total Statutory Deductions</span><span class="pr-stat-val" style="color:#f59e0b;">' + formatCurrency(d.total_deductions || 0) + '</span><span class="pr-stat-sub">PF, ESI, PT, TDS</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Pending Runs</span><span class="pr-stat-val" style="color:#2563eb;">' + (d.pending_payroll_runs || 0) + '</span><span class="pr-stat-sub">In Draft or Review</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Pending Approvals</span><span class="pr-stat-val" style="color:#ec4899;">' + (d.pending_approvals || 0) + '</span><span class="pr-stat-sub">Multi-level Workflow</span></div>');
    out.push('</div>');

    // Charts Grid
    out.push('<div class="pr-charts-grid">');
    out.push('  <div class="pr-chart-box">');
    out.push('    <div class="pr-chart-title">📊 Monthly Payroll Trends (Last 6 Months)</div>');
    out.push('    <div style="position:relative; height:240px; width:100%;"><canvas id="pr-trends-canvas"></canvas></div>');
    out.push('  </div>');
    out.push('  <div class="pr-chart-box">');
    out.push('    <div class="pr-chart-title">🍩 Department Salary Breakdown</div>');
    out.push('    <div style="position:relative; height:240px; width:100%;"><canvas id="pr-dept-canvas"></canvas></div>');
    out.push('  </div>');
    out.push('</div>');

    // Recent Runs
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="font-weight:700; font-size:14px;">Recent Pay Runs</div>');
    out.push('    <button class="pr-btn pr-btn-secondary pr-btn-sm" data-tab="runs">View All Runs →</button>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table">');
    out.push('    <thead><tr><th>Period</th><th>Status</th><th>Employees</th><th>Net Disbursed</th><th>Created Date</th><th>Action</th></tr></thead><tbody>');

    var recents = (d.recent_runs && d.recent_runs.length) ? d.recent_runs : state.runs.slice(0, 5);
    if (!recents.length) {
      out.push('<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text2);">No payroll runs executed yet. Click "Process Payroll Wizard" to generate.</td></tr>');
    } else {
      recents.forEach(function (r) {
        var badgeCls = 'pr-badge-' + (r.status || 'draft');
        out.push('<tr>');
        out.push('  <td><b>' + (r.period_label || '—') + '</b></td>');
        out.push('  <td><span class="pr-badge ' + badgeCls + '">' + (r.status || 'draft') + '</span></td>');
        out.push('  <td>' + (r.employee_count || 0) + ' Staff</td>');
        out.push('  <td><b>' + formatCurrency(r.total_net || 0) + '</b></td>');
        out.push('  <td>' + (r.created_at ? r.created_at.slice(0, 10) : '—') + '</td>');
        out.push('  <td><button class="pr-btn pr-btn-secondary pr-btn-sm pr-view-run" data-run-id="' + r.id + '">Inspect Run</button></td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push('</div>');

    return out.join('\n');
  }

  function initDashboardCharts() {
    if (typeof Chart === 'undefined') return;

    var trendsCanvas = document.getElementById('pr-trends-canvas');
    if (trendsCanvas) {
      var trendsData = (state.dashboard && state.dashboard.monthly_trends) ? state.dashboard.monthly_trends : [];
      if (!trendsData.length) {
        trendsData = [
          { label: '2026-03', gross: 240000, net: 215000, deductions: 25000 },
          { label: '2026-04', gross: 260000, net: 232000, deductions: 28000 },
          { label: '2026-05', gross: 280000, net: 250000, deductions: 30000 },
          { label: '2026-06', gross: 310000, net: 275000, deductions: 35000 },
          { label: '2026-07', gross: 335000, net: 298000, deductions: 37000 },
          { label: '2026-08', gross: 350000, net: 312000, deductions: 38000 },
        ];
      }
      new Chart(trendsCanvas, {
        type: 'bar',
        data: {
          labels: trendsData.map(function(t) { return t.label; }),
          datasets: [
            { label: 'Gross Salary', data: trendsData.map(function(t) { return t.gross; }), backgroundColor: '#4f8ef7', borderRadius: 4 },
            { label: 'Net Disbursed', data: trendsData.map(function(t) { return t.net; }), backgroundColor: '#10b981', borderRadius: 4 },
            { label: 'Deductions', data: trendsData.map(function(t) { return t.deductions; }), backgroundColor: '#f59e0b', borderRadius: 4 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8a9bb8', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#8a9bb8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#8a9bb8', callback: function(v){ return '₹' + (v/1000) + 'k'; } }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }

    var deptCanvas = document.getElementById('pr-dept-canvas');
    if (deptCanvas) {
      var deptData = (state.dashboard && state.dashboard.department_distribution) ? state.dashboard.department_distribution : [];
      if (!deptData.length) {
        deptData = [
          { department: 'Engineering', gross_salary: 180000 },
          { department: 'Sales', gross_salary: 95000 },
          { department: 'Operations', gross_salary: 45000 },
          { department: 'HR', gross_salary: 30000 },
        ];
      }
      new Chart(deptCanvas, {
        type: 'doughnut',
        data: {
          labels: deptData.map(function(d) { return d.department; }),
          datasets: [{
            data: deptData.map(function(d) { return d.gross_salary; }),
            backgroundColor: ['#4f8ef7', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#8a9bb8', font: { size: 10 } } } }
        }
      });
    }
  }

  /* ── TAB 2: GUIDED 8-STEP PAYROLL WIZARD ── */
  function renderWizardTab() {
    var step = state.wizardStep;
    var out = [];

    // Stepper header
    var stepTitles = [
      '1. Select Period',
      '2. Attendance',
      '3. LOP & Overtime',
      '4. Calculate',
      '5. Validate',
      '6. Review',
      '7. Submit',
      '8. Approve & Release'
    ];

    out.push('<div class="pr-card" style="margin-bottom:16px;">');
    out.push('  <div class="pr-stepper">');
    stepTitles.forEach(function (title, idx) {
      var n = idx + 1;
      var cls = 'pr-step-item' + (n === step ? ' active' : (n < step ? ' done' : ''));
      out.push('<div class="' + cls + '" data-goto-step="' + n + '"><span class="pr-step-num">' + (n < step ? '✓' : n) + '</span> ' + title + '</div>');
      if (idx < stepTitles.length - 1) {
        out.push('<div class="pr-step-sep"></div>');
      }
    });
    out.push('  </div>');
    out.push('</div>');

    // Step Body
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar"><div style="font-weight:700; font-size:14px;">Step ' + step + ': ' + stepTitles[step - 1] + '</div></div>');
    out.push('  <div style="padding:24px;">');

    if (step === 1) {
      out.push('<p style="color:var(--text2); margin-top:0;">Select or specify the payroll execution period and scheduled pay date:</p>');
      out.push('<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; max-width:750px;">');
      out.push('  <div class="pr-form-group"><label>Period Label (YYYY-MM):</label><input type="text" id="wz-period-label" value="' + state.wizardForm.period_label + '"></div>');
      out.push('  <div class="pr-form-group"><label>Period Start Date:</label><input type="date" id="wz-period-start" value="' + state.wizardForm.period_start + '"></div>');
      out.push('  <div class="pr-form-group"><label>Period End Date:</label><input type="date" id="wz-period-end" value="' + state.wizardForm.period_end + '"></div>');
      out.push('  <div class="pr-form-group"><label>Scheduled Pay Date:</label><input type="date" id="wz-pay-date" value="' + state.wizardForm.pay_date + '"></div>');
      out.push('</div>');
      out.push('<div style="margin-top:20px;"><button class="pr-btn pr-btn-primary" id="wz-btn-step1-next">Continue to Fetch Attendance →</button></div>');

    } else if (step === 2 || step === 3) {
      out.push('<p style="color:var(--text2); margin-top:0;">Employee attendance, paid days, approved leaves, and overtime hours fetched from attendance system:</p>');
      out.push('<div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
      out.push('<th>Employee</th><th>Department</th><th>Total Days</th><th>Worked</th><th>WFH</th><th>Paid Leaves</th><th>LOP Days</th><th>Overtime</th>');
      out.push('</tr></thead><tbody>');
      if (!state.attendanceSummary.length) {
        out.push('<tr><td colspan="8" style="text-align:center; padding:20px;">Fetching attendance data...</td></tr>');
      } else {
        state.attendanceSummary.forEach(function (att) {
          out.push('<tr>');
          out.push('<td><b>' + att.employee_name + '</b><br><small style="color:var(--text2);">' + att.email + '</small></td>');
          out.push('<td>' + (att.department || 'General') + '</td>');
          out.push('<td>' + att.total_days + '</td>');
          out.push('<td>' + att.worked_days + '</td>');
          out.push('<td>' + att.wfh_days + '</td>');
          out.push('<td>' + att.leave_days + '</td>');
          out.push('<td style="color:' + (att.lop_days > 0 ? '#f87171' : '#8a9bb8') + '; font-weight:' + (att.lop_days > 0 ? '700' : 'normal') + ';">' + att.lop_days + '</td>');
          out.push('<td style="color:#10b981; font-weight:700;">' + att.overtime_hours + ' hrs</td>');
          out.push('</tr>');
        });
      }
      out.push('</tbody></table></div>');
      out.push('<div style="margin-top:20px; display:flex; gap:10px;">');
      out.push('  <button class="pr-btn pr-btn-secondary" id="wz-btn-back">← Back</button>');
      out.push('  <button class="pr-btn pr-btn-primary" id="wz-btn-step3-calc">Calculate Earnings & Deductions →</button>');
      out.push('</div>');

    } else if (step === 4) {
      out.push('<div style="text-align:center; padding:32px 0;">');
      out.push('  <div style="font-size:36px; margin-bottom:12px;">⚙️</div>');
      out.push('  <h3 style="margin:0 0 8px 0; color:var(--text);">Calculating Indian Payroll Components</h3>');
      out.push('  <p style="color:var(--text2); max-width:480px; margin:0 auto 24px auto;">Evaluating Basic, HRA, Allowances, PF (12%), ESI (0.75%), PT (₹200), TDS, LOP deductions, and CTC employer contributions across ' + state.compensations.length + ' staff records.</p>');
      out.push('  <button class="pr-btn pr-btn-primary" id="wz-btn-execute-calc">Execute Batch Payroll Calculation</button>');
      out.push('</div>');

    } else if (step === 5) {
      var v = state.selectedRunValidation || { is_valid: true, blocking_count: 0, warning_count: 0, checks: [] };
      out.push('<div style="margin-bottom:16px;">');
      if (v.blocking_count === 0) {
        out.push('<div style="padding:12px 18px; border-radius:8px; background:rgba(16,185,129,0.12); border:1px solid #10b981; color:#059669; font-weight:600; margin-bottom:16px;">✓ Payroll Validation Passed: No blocking calculation or banking errors identified. Ready for executive review.</div>');
      } else {
        out.push('<div style="padding:12px 18px; border-radius:8px; background:rgba(239,68,68,0.12); border:1px solid #ef4444; color:#dc2626; font-weight:600; margin-bottom:16px;">⚠️ Validation identified ' + v.blocking_count + ' blocking issues. Review issues below.</div>');
      }
      out.push('</div>');

      out.push('<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>Severity</th><th>Employee</th><th>Validation Issue</th><th>Status</th></tr></thead><tbody>');
      if (!v.checks || !v.checks.length) {
        out.push('<tr><td colspan="4" style="text-align:center; padding:18px; color:#10b981;">✓ All employee records verified successfully.</td></tr>');
      } else {
        v.checks.forEach(function (chk) {
          var isErr = chk.type === 'error';
          out.push('<tr>');
          out.push('<td><span class="pr-badge ' + (isErr ? 'pr-badge-rejected' : 'pr-badge-pending_approval') + '">' + chk.type + '</span></td>');
          out.push('<td><b>' + (chk.employee_name || 'Staff') + '</b><br><small style="color:var(--text2);">' + (chk.email || '') + '</small></td>');
          out.push('<td>' + chk.message + '</td>');
          out.push('<td>' + (isErr ? '❌ Action Required' : '⚠️ Warning Only') + '</td>');
          out.push('</tr>');
        });
      }
      out.push('</tbody></table></div>');

      out.push('<div style="margin-top:20px; display:flex; gap:10px;">');
      out.push('  <button class="pr-btn pr-btn-secondary" id="wz-btn-back">← Back</button>');
      out.push('  <button class="pr-btn pr-btn-primary" id="wz-btn-step5-next">Proceed to Employee-Wise Review →</button>');
      out.push('</div>');

    } else if (step === 6) {
      out.push('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">');
      out.push('  <div style="color:var(--text2);">Review individual salary breakdowns and append any one-off performance incentives, arrears, or deductions:</div>');
      out.push('  <button class="pr-btn pr-btn-secondary pr-btn-sm" id="wz-btn-add-adj">+ Add Payroll Adjustment</button>');
      out.push('</div>');

      out.push('<div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
      out.push('<th>Employee</th><th>Department</th><th>Worked / Paid</th><th>Basic Pay</th><th>Gross Earnings</th><th>Total Deductions</th><th>Net Pay</th><th>Adjustments</th>');
      out.push('</tr></thead><tbody>');
      if (!state.selectedRunEntries.length) {
        out.push('<tr><td colspan="8" style="text-align:center; padding:20px;">No entries calculated for this run.</td></tr>');
      } else {
        state.selectedRunEntries.forEach(function (e) {
          out.push('<tr>');
          out.push('<td><b>' + e.employee_name + '</b><br><small style="color:var(--text2);">' + e.email + '</small></td>');
          out.push('<td>' + (e.department || 'General') + '</td>');
          out.push('<td>' + e.worked_days + ' / ' + e.paid_days + '</td>');
          out.push('<td>' + formatCurrency(e.basic_pay) + '</td>');
          out.push('<td>' + formatCurrency(e.gross_earnings) + '</td>');
          out.push('<td style="color:#f59e0b;">' + formatCurrency(e.total_deductions) + '</td>');
          out.push('<td style="color:#10b981; font-weight:700;">' + formatCurrency(e.net_pay) + '</td>');
          out.push('<td>' + ((e.adjustments && e.adjustments.length) ? ('<span class="pr-badge pr-badge-processing">' + e.adjustments.length + ' Applied</span>') : '—') + '</td>');
          out.push('</tr>');
        });
      }
      out.push('</tbody></table></div>');

      out.push('<div style="margin-top:20px; display:flex; gap:10px;">');
      out.push('  <button class="pr-btn pr-btn-secondary" id="wz-btn-back">← Back</button>');
      out.push('  <button class="pr-btn pr-btn-primary" id="wz-btn-step6-next">Submit for Multi-Level Approval →</button>');
      out.push('</div>');

    } else if (step === 7) {
      out.push('<div style="max-width:600px;">');
      out.push('  <h3 style="margin-top:0; color:var(--text);">Submit Pay Run for Executive & Finance Sign-Off</h3>');
      out.push('  <p style="color:var(--text2);">This will advance the payroll run to <b>Stage 7 (Pending Approval)</b> and alert HR and Finance Managers in the approval pipeline.</p>');
      out.push('  <div class="pr-form-group"><label>Submitter Name:</label><input type="text" id="wz-submitter-name" value="' + getLoggedInUser().name + '"></div>');
      out.push('  <div class="pr-form-group"><label>Executive Comments / Run Notes:</label><textarea id="wz-submitter-comments" rows="3" placeholder="e.g. Regular monthly payroll run. All attendance records verified."></textarea></div>');
      out.push('  <div style="margin-top:20px; display:flex; gap:10px;">');
      out.push('    <button class="pr-btn pr-btn-secondary" id="wz-btn-back">← Back</button>');
      out.push('    <button class="pr-btn pr-btn-primary" id="wz-btn-do-submit">Submit to Approval Pipeline →</button>');
      out.push('  </div>');
      out.push('</div>');

    } else if (step === 8) {
      var r = state.selectedRun || {};
      out.push('<div style="text-align:center; padding:24px 0;">');
      out.push('  <div style="font-size:38px; margin-bottom:12px;">🛡️</div>');
      out.push('  <h3 style="margin:0 0 8px 0; color:var(--text);">Approval & Payout Release Pipeline</h3>');
      out.push('  <p style="color:var(--text2); max-width:540px; margin:0 auto 20px auto;">Current Status: <span class="pr-badge pr-badge-' + (r.status || 'pending_approval') + '">' + (r.status || 'Pending Approval') + '</span></p>');

      // Approval Hierarchy Badges
      out.push('  <div style="display:flex; justify-content:center; gap:12px; margin-bottom:28px; flex-wrap:wrap;">');
      out.push('    <div style="padding:10px 16px; border-radius:8px; background:rgba(16,185,129,0.1); border:1px solid #10b981; color:#059669; font-size:12px; font-weight:600;">✓ 1. Payroll Executive</div>');
      out.push('    <div style="padding:10px 16px; border-radius:8px; background:rgba(79,142,247,0.1); border:1px solid #4f8ef7; color:#2563eb; font-size:12px; font-weight:600;">2. HR Manager</div>');
      out.push('    <div style="padding:10px 16px; border-radius:8px; background:rgba(245,158,11,0.1); border:1px solid #f59e0b; color:#d97706; font-size:12px; font-weight:600;">3. Finance Manager</div>');
      out.push('    <div style="padding:10px 16px; border-radius:8px; background:rgba(156,163,175,0.1); border:1px solid #9ca3af; color:var(--text2); font-size:12px; font-weight:600;">4. Super Admin</div>');
      out.push('  </div>');

      out.push('  <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">');
      out.push('    <button class="pr-btn pr-btn-success" id="wz-btn-approve-run">✓ Approve & Release Payroll</button>');
      out.push('    <button class="pr-btn pr-btn-warning" id="wz-btn-correct-run">⚠️ Request Corrections</button>');
      out.push('    <button class="pr-btn pr-btn-danger" id="wz-btn-reject-run">✕ Reject Run</button>');
      out.push('  </div>');
      out.push('</div>');
    }

    out.push('  </div>');
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 3: PAY RUNS ── */
  function renderRunsTab() {
    var pg = pageOf('runs', state.runs);
    var out = [];
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="font-weight:700; font-size:14px;">All Payroll Runs</div>');
    out.push('    <div style="display:flex; gap:8px;">');
    out.push('      <button class="pr-btn pr-btn-primary pr-btn-sm" id="pr-btn-new-run">+ New Pay Run</button>');
    out.push('    </div>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Period</th><th>Status</th><th>Stage</th><th>Employees</th><th>Total Gross</th><th>Total Deductions</th><th>Net Pay</th><th>Created By</th><th>Actions</th>');
    out.push('</tr></thead><tbody>');

    if (!pg.items.length) {
      out.push('<tr><td colspan="9" style="text-align:center; padding:24px;">No pay runs found. Click "+ New Pay Run" to begin.</td></tr>');
    } else {
      pg.items.forEach(function (r) {
        var badgeCls = 'pr-badge-' + (r.status || 'draft');
        out.push('<tr>');
        out.push('<td><b>' + r.period_label + '</b></td>');
        out.push('<td><span class="pr-badge ' + badgeCls + '">' + r.status + '</span></td>');
        out.push('<td>Step ' + (r.stage || 1) + '/8</td>');
        out.push('<td>' + (r.employee_count || 0) + '</td>');
        out.push('<td>' + formatCurrency(r.total_gross) + '</td>');
        out.push('<td style="color:#f59e0b;">' + formatCurrency(r.total_deductions) + '</td>');
        out.push('<td style="color:#10b981; font-weight:700;">' + formatCurrency(r.total_net) + '</td>');
        out.push('<td>' + (r.created_by || 'Admin') + '</td>');
        out.push('<td>');
        out.push('  <button class="pr-btn pr-btn-secondary pr-btn-sm pr-inspect-run" data-run-id="' + r.id + '">View</button> ');
        out.push('  <button class="pr-btn pr-btn-secondary pr-btn-sm pr-dl-neft" data-run-id="' + r.id + '">NEFT CSV</button>');
        out.push('</td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push(pagerHtml('runs', pg, 'runs'));
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 4: EMPLOYEE SALARIES ── */
  function renderCompensationsTab() {
    var items = state.compensations;
    if (state.searchQuery) {
      var s = state.searchQuery.toLowerCase();
      items = items.filter(function (c) {
        return (c.employee_name && c.employee_name.toLowerCase().indexOf(s) >= 0) ||
               (c.email && c.email.toLowerCase().indexOf(s) >= 0) ||
               (c.department && c.department.toLowerCase().indexOf(s) >= 0);
      });
    }
    var pg = pageOf('compensations', items);
    var out = [];

    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <input type="text" class="pr-search" id="pr-comp-search" placeholder="Search employee name, email..." value="' + state.searchQuery + '">');
    out.push('    <div style="font-size:12px; color:var(--text2);">Total Staff: <b>' + state.compensations.length + '</b></div>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Employee</th><th>Department & Designation</th><th>Structure</th><th>Monthly Base</th><th>Annual CTC</th><th>Bank Details</th><th>Status</th><th>Action</th>');
    out.push('</tr></thead><tbody>');

    if (!pg.items.length) {
      out.push('<tr><td colspan="8" style="text-align:center; padding:24px;">No employee compensations found.</td></tr>');
    } else {
      pg.items.forEach(function (c) {
        out.push('<tr>');
        out.push('<td><b>' + (c.employee_name || c.email.split('@')[0]) + '</b><br><small style="color:var(--text2);">' + c.email + '</small></td>');
        out.push('<td>' + (c.department || 'General') + '<br><small style="color:var(--text2);">' + (c.designation || 'Staff') + '</small></td>');
        out.push('<td><span class="pr-badge pr-badge-processing">' + (c.structure_name || 'Standard IT') + '</span></td>');
        out.push('<td><b>' + formatCurrency(c.base_amount) + '</b></td>');
        out.push('<td>' + formatCurrency(c.annual_ctc) + '</td>');
        out.push('<td>' + (c.bank_name ? (c.bank_name + ' •••' + (c.bank_account_no ? c.bank_account_no.slice(-4) : '')) : '<span style="color:#dc2626;">Missing</span>') + '</td>');
        out.push('<td><span class="pr-badge ' + (c.status === 'active' ? 'pr-badge-approved' : 'pr-badge-draft') + '">' + (c.status || 'active') + '</span></td>');
        out.push('<td><button class="pr-btn pr-btn-secondary pr-btn-sm pr-revise-btn" data-comp-id="' + c.id + '">Revise CTC</button></td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push(pagerHtml('compensations', pg, 'employees'));
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 5: SALARY STRUCTURES ── */
  function renderStructuresTab() {
    var out = [];
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="font-weight:700; font-size:14px;">Configurable Salary Structures</div>');
    out.push('    <button class="pr-btn pr-btn-primary pr-btn-sm" id="pr-btn-new-struct">+ Create Structure</button>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Structure Name</th><th>Code</th><th>Currency</th><th>Assigned Staff</th><th>Earnings Components</th><th>Deductions</th><th>Actions</th>');
    out.push('</tr></thead><tbody>');

    if (!state.structures.length) {
      out.push('<tr><td colspan="7" style="text-align:center; padding:24px;">No salary structures configured. Click "+ Create Structure" to add one.</td></tr>');
    } else {
      state.structures.forEach(function (s) {
        var comps = s.components || [];
        var earnCount = comps.filter(function (c) { return c.component_details && c.component_details.component_type === 'earning'; }).length;
        var dedCount = comps.filter(function (c) { return c.component_details && c.component_details.component_type === 'deduction'; }).length;
        out.push('<tr>');
        out.push('<td><b>' + s.name + '</b><br><small style="color:var(--text2);">' + (s.description || '') + '</small></td>');
        out.push('<td><code>' + s.code + '</code></td>');
        out.push('<td>' + (s.currency || 'INR') + '</td>');
        out.push('<td>' + (s.employee_count || 0) + ' Employees</td>');
        out.push('<td><span class="pr-badge pr-badge-approved">' + earnCount + ' Earnings</span></td>');
        out.push('<td><span class="pr-badge pr-badge-pending_approval">' + dedCount + ' Deductions</span></td>');
        out.push('<td><button class="pr-btn pr-btn-secondary pr-btn-sm pr-manage-struct" data-struct-id="' + s.id + '">Edit Components</button></td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 6: PAYSLIPS ── */
  function renderPayslipsTab() {
    var pg = pageOf('payslips', state.payslips);
    var out = [];
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="font-weight:700; font-size:14px;">Employee Payslips</div>');
    out.push('    <div style="font-size:12px; color:var(--text2);">Total Generated: <b>' + state.payslips.length + '</b></div>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Employee</th><th>Period</th><th>Worked / Paid</th><th>Gross</th><th>Deductions</th><th>Net Pay</th><th>Status</th><th>Actions</th>');
    out.push('</tr></thead><tbody>');

    if (!pg.items.length) {
      out.push('<tr><td colspan="8" style="text-align:center; padding:24px;">No payslips available for download yet. Run payroll and approve to lock payslips.</td></tr>');
    } else {
      pg.items.forEach(function (p) {
        out.push('<tr>');
        out.push('<td><b>' + p.employee_name + '</b><br><small style="color:var(--text2);">' + p.email + '</small></td>');
        out.push('<td><b>' + (p.run ? p.run.period_label : '—') + '</b></td>');
        out.push('<td>' + p.worked_days + ' / ' + p.paid_days + '</td>');
        out.push('<td>' + formatCurrency(p.gross_earnings) + '</td>');
        out.push('<td style="color:#f59e0b;">' + formatCurrency(p.total_deductions) + '</td>');
        out.push('<td style="color:#10b981; font-weight:700;">' + formatCurrency(p.net_pay) + '</td>');
        out.push('<td><span class="pr-badge ' + (p.status === 'approved' ? 'pr-badge-approved' : 'pr-badge-draft') + '">' + p.status + '</span></td>');
        out.push('<td>');
        out.push('  <button class="pr-btn pr-btn-secondary pr-btn-sm pr-view-payslip" data-payslip-id="' + p.id + '">📄 View PDF</button>');
        out.push('</td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push(pagerHtml('payslips', pg, 'payslips'));
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 7: APPROVAL PIPELINE ── */
  function renderApprovalsTab() {
    var out = [];
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar"><div style="font-weight:700; font-size:14px;">Approval Pipeline & Audit Timeline</div></div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Pay Run</th><th>Approval Level</th><th>Action</th><th>Approver</th><th>Comments</th><th>Timestamp</th>');
    out.push('</tr></thead><tbody>');

    if (!state.approvals.length) {
      out.push('<tr><td colspan="6" style="text-align:center; padding:24px;">No approval records found yet.</td></tr>');
    } else {
      state.approvals.forEach(function (a) {
        var actCls = a.action === 'approved' ? 'pr-badge-approved' : (a.action === 'rejected' ? 'pr-badge-rejected' : 'pr-badge-pending_approval');
        out.push('<tr>');
        out.push('<td><b>Run #' + (a.run || '—') + '</b></td>');
        out.push('<td>' + (a.role_name || a.level) + '</td>');
        out.push('<td><span class="pr-badge ' + actCls + '">' + a.action + '</span></td>');
        out.push('<td>' + (a.approver_name || a.approver_email || 'Approver') + '</td>');
        out.push('<td>' + (a.comments || '—') + '</td>');
        out.push('<td>' + (a.created_at ? a.created_at.slice(0, 19).replace('T', ' ') : '—') + '</td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 8: PAYMENT DISBURSAL ── */
  function renderPaymentsTab() {
    var out = [];
    var pendingPayments = state.payments.filter(function(p){ return p.status === 'pending'; });
    var successPayments = state.payments.filter(function(p){ return p.status === 'successful'; });

    out.push('<div class="pr-stats" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:16px;">');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Pending Payouts</span><span class="pr-stat-val" style="color:#d97706;">' + pendingPayments.length + '</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Disbursed Payouts</span><span class="pr-stat-val" style="color:#10b981;">' + successPayments.length + '</span></div>');
    out.push('  <div class="pr-stat-card"><span class="pr-stat-label">Disbursal Action</span><button class="pr-btn pr-btn-primary pr-btn-sm" id="pr-btn-disburse-all" style="margin-top:4px;">Disburse All Pending</button></div>');
    out.push('</div>');

    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="font-weight:700; font-size:14px;">Direct Bank Transfer Ledger (NEFT/RTGS)</div>');
    out.push('    <div style="display:flex; gap:8px;">');
    out.push('      <button class="pr-btn pr-btn-secondary pr-btn-sm" id="pr-btn-export-neft">Download Bank CSV</button>');
    out.push('    </div>');
    out.push('  </div>');
    out.push('  <div class="pr-table-wrap"><table class="pr-table"><thead><tr>');
    out.push('<th>Employee</th><th>Department</th><th>Account Number</th><th>IFSC</th><th>Net Amount</th><th>Payment Status</th><th>Reference No</th><th>Action</th>');
    out.push('</tr></thead><tbody>');

    if (!state.payments.length) {
      out.push('<tr><td colspan="8" style="text-align:center; padding:24px;">No payment records in current batch. Approve a pay run and initialize batch.</td></tr>');
    } else {
      state.payments.forEach(function (pm) {
        var stCls = pm.status === 'successful' ? 'pr-badge-paid' : (pm.status === 'failed' ? 'pr-badge-rejected' : 'pr-badge-pending_approval');
        out.push('<tr>');
        out.push('<td><b>' + (pm.employee_name || 'Staff') + '</b><br><small style="color:var(--text2);">' + (pm.employee_email || '') + '</small></td>');
        out.push('<td>' + (pm.department || 'General') + '</td>');
        out.push('<td>' + (pm.account_number || '<span style="color:#dc2626;">Missing</span>') + '</td>');
        out.push('<td><code>' + (pm.ifsc_code || '—') + '</code></td>');
        out.push('<td><b>' + formatCurrency(pm.amount) + '</b></td>');
        out.push('<td><span class="pr-badge ' + stCls + '">' + pm.status + '</span></td>');
        out.push('<td><code>' + (pm.reference_number || 'Pending') + '</code></td>');
        out.push('<td>');
        if (pm.status === 'pending') {
          out.push('<button class="pr-btn pr-btn-success pr-btn-sm pr-single-disburse" data-payment-id="' + pm.id + '">Pay</button> ');
          out.push('<button class="pr-btn pr-btn-danger pr-btn-sm pr-single-fail" data-payment-id="' + pm.id + '">Fail</button>');
        } else {
          out.push('✓ Disbursed');
        }
        out.push('</td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push('</div>');
    return out.join('\n');
  }

  /* ── TAB 9: REPORTS & TAX ── */
  function renderReportsTab() {
    var out = [];
    out.push('<div class="pr-card">');
    out.push('  <div class="pr-toolbar">');
    out.push('    <div style="display:flex; gap:10px; align-items:center;">');
    out.push('      <span style="font-weight:700; font-size:14px;">Select Report:</span>');
    out.push('      <select class="pr-select" id="pr-report-type-select">');
    out.push('        <option value="statutory"' + (state.reportType === 'statutory' ? ' selected' : '') + '>Statutory Tax Compliance (PF / ESI / PT / TDS)</option>');
    out.push('        <option value="department"' + (state.reportType === 'department' ? ' selected' : '') + '>Department Salary Distribution</option>');
    out.push('        <option value="monthly"' + (state.reportType === 'monthly' ? ' selected' : '') + '>Monthly Consolidation Summary</option>');
    out.push('      </select>');
    out.push('    </div>');
    out.push('    <button class="pr-btn pr-btn-secondary pr-btn-sm" id="pr-btn-export-report-csv">Export CSV</button>');
    out.push('  </div>');

    out.push('  <div class="pr-table-wrap"><table class="pr-table">');
    if (state.reportType === 'statutory') {
      out.push('<thead><tr><th>Staff</th><th>Department</th><th>Gross Earnings</th><th>PF (Employee)</th><th>ESI</th><th>Professional Tax</th><th>TDS</th></tr></thead><tbody>');
      state.compensations.forEach(function (c) {
        var base = Number(c.base_amount || 0);
        var gross = base * 1.5;
        var pf = base * 0.12;
        var pt = 200;
        var esi = gross <= 21000 ? (gross * 0.0075) : 0;
        out.push('<tr>');
        out.push('<td><b>' + (c.employee_name || c.email) + '</b></td>');
        out.push('<td>' + (c.department || 'General') + '</td>');
        out.push('<td>' + formatCurrency(gross) + '</td>');
        out.push('<td>' + formatCurrency(pf) + '</td>');
        out.push('<td>' + formatCurrency(esi) + '</td>');
        out.push('<td>' + formatCurrency(pt) + '</td>');
        out.push('<td>' + formatCurrency(0) + '</td>');
        out.push('</tr>');
      });
    } else if (state.reportType === 'department') {
      out.push('<thead><tr><th>Department</th><th>Headcount</th><th>Gross Total</th><th>Deductions</th><th>Net Disbursable</th></tr></thead><tbody>');
      var deptList = (state.dashboard && state.dashboard.department_distribution) ? state.dashboard.department_distribution : [];
      deptList.forEach(function (d) {
        out.push('<tr>');
        out.push('<td><b>' + d.department + '</b></td>');
        out.push('<td>' + (d.headcount || 1) + ' Staff</td>');
        out.push('<td>' + formatCurrency(d.gross_salary) + '</td>');
        out.push('<td>' + formatCurrency(d.total_deductions || 0) + '</td>');
        out.push('<td style="color:#10b981; font-weight:700;">' + formatCurrency(d.net_salary || d.gross_salary) + '</td>');
        out.push('</tr>');
      });
    } else {
      out.push('<thead><tr><th>Period</th><th>Runs Count</th><th>Total Gross</th><th>Total Deductions</th><th>Total Net</th><th>Headcount</th></tr></thead><tbody>');
      state.runs.forEach(function (r) {
        out.push('<tr>');
        out.push('<td><b>' + r.period_label + '</b></td>');
        out.push('<td>1</td>');
        out.push('<td>' + formatCurrency(r.total_gross) + '</td>');
        out.push('<td>' + formatCurrency(r.total_deductions) + '</td>');
        out.push('<td style="color:#10b981; font-weight:700;">' + formatCurrency(r.total_net) + '</td>');
        out.push('<td>' + (r.employee_count || 0) + ' Staff</td>');
        out.push('</tr>');
      });
    }
    out.push('  </tbody></table></div>');
    out.push('</div>');
    return out.join('\n');
  }

  /* ── Event Bindings & Actions ── */
  function bindEvents(root) {
    // Tab Switching
    var tabs = root.querySelectorAll('.pr-tab');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        state.activeTab = t.getAttribute('data-tab');
        render();
      });
    });

    var startWzBtn = root.querySelector('#pr-btn-start-wizard');
    if (startWzBtn) {
      startWzBtn.addEventListener('click', function () {
        state.activeTab = 'wizard';
        state.wizardStep = 1;
        render();
      });
    }

    var refreshBtn = root.querySelector('#pr-btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        showToast('Refreshing payroll suite data...');
        loadPayrollData();
      });
    }

    // Wizard Controls
    var wzStep1Next = root.querySelector('#wz-btn-step1-next');
    if (wzStep1Next) {
      wzStep1Next.addEventListener('click', function () {
        var pLabel = (document.getElementById('wz-period-label').value || '').trim();
        var pStart = (document.getElementById('wz-period-start').value || '').trim();
        var pEnd = (document.getElementById('wz-period-end').value || '').trim();
        var pDate = (document.getElementById('wz-pay-date').value || '').trim();
        state.wizardForm = { period_label: pLabel, period_start: pStart, period_end: pEnd, pay_date: pDate };

        showToast('Fetching attendance snapshot for ' + pLabel + '...');
        fetch('/api/payroll/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.wizardForm)
        }).then(function (r) {
          if (!r.ok) {
            return r.json().then(function (d) { throw new Error(d.error || 'Duplicate run or calculation failure'); });
          }
          return r.json();
        }).then(function (run) {
          state.selectedRun = run;
          state.selectedRunId = run.id;
          return fetch('/api/payroll/runs/' + run.id + '/attendance-summary').then(function(r){ return r.json(); });
        }).then(function (att) {
          state.attendanceSummary = att || [];
          state.wizardStep = 2;
          render();
        }).catch(function (err) {
          showToast(err.message, true);
        });
      });
    }

    var wzBack = root.querySelector('#wz-btn-back');
    if (wzBack) {
      wzBack.addEventListener('click', function () {
        if (state.wizardStep > 1) {
          state.wizardStep -= 1;
          render();
        }
      });
    }

    var wzStep3Calc = root.querySelector('#wz-btn-step3-calc');
    if (wzStep3Calc) {
      wzStep3Calc.addEventListener('click', function () {
        state.wizardStep = 4;
        render();
      });
    }

    var wzExecCalc = root.querySelector('#wz-btn-execute-calc');
    if (wzExecCalc) {
      wzExecCalc.addEventListener('click', function () {
        showToast('Calculating earnings, deductions, and tax contributions...');
        call('/api/payroll/runs/' + state.selectedRunId + '/validate', { method: 'POST' })
          .then(function(val){
            state.selectedRunValidation = val;
            state.wizardStep = 5;
            render();
          }).catch(fail);
      });
    }

    var wzStep5Next = root.querySelector('#wz-btn-step5-next');
    if (wzStep5Next) {
      wzStep5Next.addEventListener('click', function () {
        showToast('Loading employee salary review ledger...');
        call('/api/payroll/runs/' + state.selectedRunId + '/entries')
          .then(function(entries){
            state.selectedRunEntries = entries || [];
            state.wizardStep = 6;
            render();
          }).catch(fail);
      });
    }

    var wzStep6Next = root.querySelector('#wz-btn-step6-next');
    if (wzStep6Next) {
      wzStep6Next.addEventListener('click', function () {
        state.wizardStep = 7;
        render();
      });
    }

    var wzDoSubmit = root.querySelector('#wz-btn-do-submit');
    if (wzDoSubmit) {
      wzDoSubmit.addEventListener('click', function () {
        var subName = (document.getElementById('wz-submitter-name').value || '').trim();
        var subComm = (document.getElementById('wz-submitter-comments').value || '').trim();
        call('/api/payroll/runs/' + state.selectedRunId + '/submit-approval', {
          method: 'POST', body: { submitted_by: subName, comments: subComm }
        }).then(function (run) {
            state.selectedRun = run;
            state.wizardStep = 8;
            showToast('✓ Submitted to Approval Pipeline!');
            render();
          }).catch(fail);
      });
    }

    var wzApproveRun = root.querySelector('#wz-btn-approve-run');
    if (wzApproveRun) {
      wzApproveRun.addEventListener('click', function () {
        var user = getLoggedInUser();
        call('/api/payroll/runs/' + state.selectedRunId + '/action-approval', {
          method: 'POST',
          body: { level: 'finance_manager', action: 'approve', approver_email: user.email, approver_name: user.name, comments: 'Executive sign-off approved' }
        }).then(function(){
            showToast('✓ Payroll fully approved and released! Generating payment batch...');
            return call('/api/payroll/runs/' + state.selectedRunId + '/create-payment-batch', { method: 'POST' });
          }).then(function(){
            loadPayrollData();
            state.activeTab = 'payments';
            render();
          }).catch(fail);
      });
    }

    // Inspect run from table
    var inspectBtns = root.querySelectorAll('.pr-inspect-run, .pr-view-run');
    inspectBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rid = btn.getAttribute('data-run-id');
        state.selectedRunId = rid;
        showToast('Loading pay run #' + rid + '...');
        Promise.all([
          call('/api/payroll/runs/' + rid),
          call('/api/payroll/runs/' + rid + '/entries'),
          call('/api/payroll/runs/' + rid + '/validate', { method: 'POST' })
        ]).catch(function (e) { fail(e); throw e; }).then(function(res){
          state.selectedRun = res[0];
          state.selectedRunEntries = res[1] || [];
          state.selectedRunValidation = res[2];
          state.activeTab = 'wizard';
          state.wizardStep = 6;
          render();
        });
      });
    });

    // Pager clicks
    var pagerBtns = root.querySelectorAll('[data-pr-page]');
    pagerBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var p = parseInt(b.getAttribute('data-pr-page'), 10);
        var k = b.getAttribute('data-pr-list');
        if (p > 0 && k) {
          state.pages[k] = p;
          render();
        }
      });
    });

    // Disburse All Payments
    var disburseAllBtn = root.querySelector('#pr-btn-disburse-all');
    if (disburseAllBtn) {
      disburseAllBtn.addEventListener('click', function () {
        var pending = state.payments.filter(function(p){ return p.status === 'pending'; }).map(function(p){ return p.id; });
        if (!pending.length) {
          showToast('No pending payments to disburse.', true);
          return;
        }
        showToast('Processing bank payout batch for ' + pending.length + ' accounts...');
        call('/api/payroll/payments/disburse', {
          method: 'POST', body: { payment_ids: pending, reference_prefix: 'PAY', disbursed_by: getLoggedInUser().name }
        }).then(function(){
            showToast('✓ ' + pending.length + ' bank payments disbursed successfully!');
            loadPayrollData();
          }).catch(fail);
      });
    }

    // Per-run NEFT CSV and per-payslip PDF (fetched with identity headers)
    root.querySelectorAll('.pr-dl-neft').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rid = btn.getAttribute('data-run-id');
        downloadFile('/api/payroll/runs/' + rid + '/export-neft-file', 'payroll-run-' + rid + '-neft.csv')
          .then(function () { showToast('✓ NEFT CSV downloaded'); }).catch(fail);
      });
    });
    root.querySelectorAll('.pr-view-payslip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openFile('/api/payroll/payslips/' + btn.getAttribute('data-payslip-id') + '/pdf').catch(fail);
      });
    });

    // Single payment disburse / fail
    var singleDisburses = root.querySelectorAll('.pr-single-disburse');
    singleDisburses.forEach(function(btn){
      btn.addEventListener('click', function(){
        var pid = parseInt(btn.getAttribute('data-payment-id'), 10);
        call('/api/payroll/payments/disburse', {
          method: 'POST',
          body: { payment_ids: [pid], reference_prefix: 'PAY', disbursed_by: getLoggedInUser().name }
        }).then(function(){
          showToast('✓ Disbursed payment #' + pid);
          loadPayrollData();
        }).catch(fail);
      });
    });

    var singleFails = root.querySelectorAll('.pr-single-fail');
    singleFails.forEach(function(btn){
      btn.addEventListener('click', function(){
        var pid = parseInt(btn.getAttribute('data-payment-id'), 10);
        var reason = prompt('Enter payment decline reason:', 'Invalid account credentials');
        if (reason) {
          call('/api/payroll/payments/' + pid + '/mark-failed', {
            method: 'POST',
            body: { failure_reason: reason }
          }).then(function(){
            showToast('Payment #' + pid + ' flagged as failed');
            loadPayrollData();
          }).catch(fail);
        }
      });
    });

    // Revise Salary Modal trigger
    var reviseBtns = root.querySelectorAll('.pr-revise-btn');
    reviseBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cid = btn.getAttribute('data-comp-id');
        var comp = state.compensations.find(function(c){ return String(c.id) === cid; });
        if (!comp) return;
        var newCtc = prompt('Revise Annual CTC for ' + comp.employee_name + ':', comp.annual_ctc || 600000);
        if (newCtc) {
          var reason = prompt('Reason for salary revision:', 'Annual appraisal / Merit increment');
          var monthlyBase = (Number(newCtc) / 12 * 0.5).toFixed(2);
          fetch('/api/payroll/compensations/' + comp.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              annual_ctc: Number(newCtc),
              base_amount: Number(monthlyBase),
              revision_reason: reason || 'Salary revision',
              revised_by: getLoggedInUser().name
            })
          }).then(function(r){ return r.json(); })
            .then(function(){
              showToast('✓ Salary revised for ' + comp.employee_name);
              loadPayrollData();
            });
        }
      });
    });

    // "+ New Pay Run" → the guided wizard, step 1 (same as Start Payroll Wizard)
    var newRunBtn = root.querySelector('#pr-btn-new-run');
    if (newRunBtn) newRunBtn.addEventListener('click', function () {
      state.activeTab = 'wizard'; state.wizardStep = 1; render();
    });

    // "+ Create Structure"
    var newStructBtn = root.querySelector('#pr-btn-new-struct');
    if (newStructBtn) newStructBtn.addEventListener('click', function () {
      openModal('Create Salary Structure',
        '<div class="pr-form-group"><label>Name *</label><input id="pr-st-name" placeholder="e.g. Standard Staff"></div>' +
        '<div class="pr-form-group"><label>Code *</label><input id="pr-st-code" placeholder="e.g. STD"></div>' +
        '<div class="pr-form-group"><label>Currency</label><select id="pr-st-cur"><option>INR</option><option>USD</option></select></div>' +
        '<div class="pr-form-group"><label>Description</label><textarea id="pr-st-desc" rows="2"></textarea></div>',
        'Create', function (box) {
          var name = val(box, 'pr-st-name'), code = val(box, 'pr-st-code').toUpperCase();
          if (!name || !code) throw new Error('Name and code are required.');
          return call('/api/payroll/structures', { method: 'POST', body: {
            name: name, code: code, currency: val(box, 'pr-st-cur') || 'INR', description: val(box, 'pr-st-desc'),
            created_by: getLoggedInUser().name } })
            .then(function () { showToast('✓ Structure "' + name + '" created'); loadPayrollData(); });
        });
    });

    // "Edit Components" on a structure
    root.querySelectorAll('.pr-manage-struct').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = btn.getAttribute('data-struct-id');
        var st = (state.structures || []).filter(function (s) { return String(s.id) === String(sid); })[0] || {};
        var opts = (state.components || []).map(function (c) {
          return '<option value="' + escH(c.id) + '">' + escH(c.name) + ' (' + escH(c.component_type || '') + ')</option>';
        }).join('');
        var current = (st.components || []).map(function (c) {
          var d = c.component_details || {};
          return '<li style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">' +
            '<span>' + escH(d.name || ('#' + c.component)) + ' <span class="pr-muted">· ' + escH(c.calc_type) + ' ' +
            escH(c.calc_type === 'percentage' ? (c.rate + '%') : formatCurrency(c.amount)) + '</span></span>' +
            '<button type="button" class="pr-btn pr-btn-danger pr-btn-sm" data-pr-del-comp="' + escH(c.component) + '">Remove</button></li>';
        }).join('') || '<li class="pr-muted">No components yet.</li>';
        var box = openModal('Components — ' + (st.name || ('Structure #' + sid)),
          '<ul style="list-style:none;margin:0 0 14px;padding:0">' + current + '</ul>' +
          (opts ? '<div class="pr-form-group"><label>Add / update component</label><select id="pr-sc-comp">' + opts + '</select></div>' +
            '<div class="pr-form-group"><label>Calculation</label><select id="pr-sc-type"><option value="fixed">Fixed amount</option><option value="percentage">Percentage</option></select></div>' +
            '<div class="pr-form-group"><label>Amount (fixed) or rate % (percentage)</label><input id="pr-sc-val" type="number" min="0" step="0.01" value="0"></div>'
            : '<div class="pr-muted">No pay components exist yet — create them first.</div>'),
          'Save component', function (b) {
            if (!opts) throw new Error('No pay components to add.');
            var type = val(b, 'pr-sc-type'), v = Number(val(b, 'pr-sc-val') || 0);
            if (!(v >= 0)) throw new Error('Enter a valid number.');
            return call('/api/payroll/structures/' + sid + '/components', { method: 'POST', body: {
              component_id: Number(val(b, 'pr-sc-comp')), calc_type: type,
              rate: type === 'percentage' ? v : 0, amount: type === 'fixed' ? v : 0, updated_by: getLoggedInUser().name } })
              .then(function () { showToast('✓ Component saved'); loadPayrollData(); });
          });
        box.querySelectorAll('[data-pr-del-comp]').forEach(function (d) {
          d.addEventListener('click', function () {
            if (!window.confirm('Remove this component from the structure?')) return;
            call('/api/payroll/structures/' + sid + '/components/' + d.getAttribute('data-pr-del-comp'), { method: 'DELETE' })
              .then(function () { showToast('Component removed'); box.style.display = 'none'; box.innerHTML = ''; loadPayrollData(); })
              .catch(fail);
          });
        });
      });
    });

    // "+ Add Payroll Adjustment" (wizard step 6)
    var addAdjBtn = root.querySelector('#wz-btn-add-adj');
    if (addAdjBtn) addAdjBtn.addEventListener('click', function () {
      if (!state.selectedRunId) { showToast('Open a pay run first.', true); return; }
      var people = (state.selectedRunEntries || []).map(function (e) {
        return '<option value="' + escH(e.email) + '">' + escH(e.employee_name || e.email) + '</option>';
      }).join('');
      if (!people) { showToast('This run has no employees to adjust.', true); return; }
      openModal('Add Payroll Adjustment',
        '<div class="pr-form-group"><label>Employee *</label><select id="pr-adj-email">' + people + '</select></div>' +
        '<div class="pr-form-group"><label>Type *</label><select id="pr-adj-type">' +
          '<option value="bonus">Bonus</option><option value="incentive">Incentive</option><option value="arrear">Arrear</option>' +
          '<option value="reimbursement">Reimbursement</option><option value="deduction">Deduction</option></select></div>' +
        '<div class="pr-form-group"><label>Amount *</label><input id="pr-adj-amt" type="number" min="0" step="0.01"></div>' +
        '<div class="pr-form-group"><label>Description</label><input id="pr-adj-desc" placeholder="e.g. Q3 performance bonus"></div>',
        'Add adjustment', function (box) {
          var amt = Number(val(box, 'pr-adj-amt'));
          if (!(amt > 0)) throw new Error('Enter an amount greater than 0.');
          return call('/api/payroll/adjustments', { method: 'POST', body: {
            run: Number(state.selectedRunId), email: val(box, 'pr-adj-email'), adjustment_type: val(box, 'pr-adj-type'),
            amount: amt, description: val(box, 'pr-adj-desc'), approved_by: getLoggedInUser().name } })
            .then(function () { return call('/api/payroll/runs/' + state.selectedRunId + '/entries'); })
            .then(function (entries) { state.selectedRunEntries = entries || []; showToast('✓ Adjustment added'); render(); });
        });
    });

    // Step 8: "Request Corrections" / "Reject Run" (reason required)
    function decideRun(action, title, okMsg) {
      if (!state.selectedRunId) { showToast('Open a pay run first.', true); return; }
      openModal(title, '<div class="pr-form-group"><label>Reason *</label><textarea id="pr-dec-note" rows="3" placeholder="What needs to change, or why it is rejected"></textarea></div>',
        title, function (box) {
          var note = val(box, 'pr-dec-note');
          if (!note) throw new Error('A reason is required.');
          var user = getLoggedInUser();
          return call('/api/payroll/runs/' + state.selectedRunId + '/action-approval', { method: 'POST', body: {
            level: 'finance_manager', action: action, approver_email: user.email, approver_name: user.name, comments: note } })
            .then(function (run) { state.selectedRun = run; showToast(okMsg); loadPayrollData(); render(); });
        });
    }
    var correctBtn = root.querySelector('#wz-btn-correct-run');
    if (correctBtn) correctBtn.addEventListener('click', function () { decideRun('request_corrections', 'Request Corrections', 'Corrections requested — the run is sent back.'); });
    var rejectBtn = root.querySelector('#wz-btn-reject-run');
    if (rejectBtn) rejectBtn.addEventListener('click', function () { decideRun('reject', 'Reject Run', 'Pay run rejected.'); });

    // "Download Bank CSV" — the NEFT/RTGS file of the run whose payments are listed
    var neftBtn = root.querySelector('#pr-btn-export-neft');
    if (neftBtn) neftBtn.addEventListener('click', function () {
      var runId = state.selectedRunId;
      if (!runId) {
        var withPay = (state.payments || []).map(function (p) { return p.run || p.run_id || (p.payslip && p.payslip.run); }).filter(Boolean);
        runId = withPay[0];
      }
      if (!runId) {
        var done = (state.runs || []).filter(function (r) { return /approved|paid|released/i.test(r.status || ''); });
        runId = done.length ? done[0].id : null;
      }
      if (!runId) { showToast('No approved pay run to export yet.', true); return; }
      downloadFile('/api/payroll/runs/' + runId + '/export-neft-file', 'payroll-run-' + runId + '-neft.csv')
        .then(function () { showToast('✓ Bank CSV downloaded'); }).catch(fail);
    });

    // Report Type change
    var repSelect = root.querySelector('#pr-report-type-select');
    if (repSelect) {
      repSelect.addEventListener('change', function () {
        state.reportType = repSelect.value;
        render();
      });
    }

    // Export report CSV
    var exportRepBtn = root.querySelector('#pr-btn-export-report-csv');
    if (exportRepBtn) {
      exportRepBtn.addEventListener('click', function () {
        showToast('Generating CSV report...');
        var csvContent = "data:text/csv;charset=utf-8,";
        if (state.reportType === 'statutory') {
          csvContent += "Employee,Department,Gross Earnings,PF (Employee),ESI,Professional Tax,TDS\n";
          state.compensations.forEach(function(c){
            var b = Number(c.base_amount || 0);
            var g = b * 1.5;
            csvContent += (c.employee_name || c.email) + "," + (c.department || 'General') + "," + g + "," + (b*0.12) + "," + (g<=21000 ? g*0.0075 : 0) + ",200,0\n";
          });
        } else {
          csvContent += "Period,Employee,Net Pay\n";
          state.payslips.forEach(function(p){
            csvContent += (p.run ? p.run.period_label : 'Current') + "," + p.employee_name + "," + p.net_pay + "\n";
          });
        }
        var encodedUri = encodeURI(csvContent);
        var link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "Payroll_Report_" + state.reportType + ".csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }

    // Search in compensation tab
    var compSearch = root.querySelector('#pr-comp-search');
    if (compSearch) {
      compSearch.addEventListener('input', function () {
        state.searchQuery = compSearch.value;
        state.pages.compensations = 1;
        render();
      });
    }
  }

  /* ── Layout Mounting ── */
  function ensureLayout() {
    if (!isPayrollRoute()) {
      document.body.removeAttribute('data-payroll-active');
      return;
    }

    document.body.setAttribute('data-payroll-active', '1');
    ensureStyle();

    var existingRoot = document.getElementById(ID.root);
    if (!existingRoot) {
      var container = document.querySelector('.main') || document.querySelector('#root') || document.body;
      var el = document.createElement('div');
      el.id = ID.root;
      container.appendChild(el);
      loadPayrollData();
    }
  }

  // Hook into navigation
  window.addEventListener('popstate', ensureLayout);
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var res = orig.apply(this, arguments);
      setTimeout(ensureLayout, 50);
      return res;
    };
  });

  var observer = new MutationObserver(function () {
    if (isPayrollRoute()) ensureLayout();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLayout);
  } else {
    ensureLayout();
  }
})();
'''

with open('dist/dist/assets/hrms-payroll.js', 'w', encoding='utf-8') as f:
    f.write(payroll_js_content)

print("hrms-payroll.js updated successfully! Bytes:", len(payroll_js_content))
