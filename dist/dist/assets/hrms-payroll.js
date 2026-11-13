/**
 * hrms-payroll.js
 * ---------------------------------------------------------------------------
 * Replaces the "Coming Soon" placeholder on /payroll/run with the live,
 * fully interactive Indian Payroll & Payslips Management Dashboard.
 *
 * Includes:
 *   • Pay Runs Engine: batch run generation, approval, bank payout file export
 *   • Employee Payslips Table: instant view/download of rendered Eversoft Indian Payslips
 *   • Compensation Overview: basic salary, annual CTC, PAN, UAN, PF, and Bank accounts
 *   • Pay Components Catalogue: Indian statutory components (Basic, HRA, PF, PT, ESI, etc.)
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
    activeTab: 'runs',      // 'runs' | 'payslips' | 'compensation' | 'components'
    runs: [],
    payslips: [],
    compensations: [],
    components: [],
    loading: false,
    selectedRun: null,
    searchQuery: '',
    selectedPeriodFilter: '',
    modalOpen: false,
    modalType: null,        // 'newRun' | 'viewRun'
  };

  function isPayrollRoute() {
    var p = (location.pathname || '').replace(/\/+$/, '');
    return p === '/payroll/run' || p === '/payroll' || p === '/payroll/runs';
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
      '.pr-actions { display: flex; gap: 10px; align-items: center; }',
      '.pr-btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.18s ease; border: 1px solid transparent; text-decoration: none; }',
      '.pr-btn-primary { background: linear-gradient(135deg, var(--accent, #4f8ef7), #2563eb); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,0.25); }',
      '.pr-btn-primary:hover { opacity: 0.93; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(37,99,235,0.35); }',
      '.pr-btn-secondary { background: var(--bg3, rgba(255,255,255,0.06)); border-color: var(--border, rgba(255,255,255,0.12)); color: var(--text, #fff); }',
      '.pr-btn-secondary:hover { background: var(--bg2, rgba(255,255,255,0.1)); }',
      '.pr-btn-success { background: #059669; color: #fff; }',
      '.pr-btn-success:hover { background: #047857; }',
      '.pr-btn-sm { padding: 5px 11px; font-size: 11.5px; border-radius: 6px; }',
      
      /* Stat Cards */
      '.pr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-bottom: 24px; }',
      '.pr-stat-card { background: var(--bg2, #161b26); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }',
      '.pr-stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3, #6b7280); font-weight: 600; }',
      '.pr-stat-val { font-size: 22px; font-weight: 700; color: var(--text, #fff); font-family: "Syne", sans-serif; }',
      '.pr-stat-sub { font-size: 11.5px; color: var(--text2, #9ca3af); }',

      /* Nav Tabs */
      '.pr-tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); margin-bottom: 22px; }',
      '.pr-tab { padding: 11px 18px; font-size: 13.5px; font-weight: 600; color: var(--text2, #8a9bb8); border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 8px; }',
      '.pr-tab:hover { color: var(--text, #fff); }',
      '.pr-tab.active { color: var(--accent, #4f8ef7); border-bottom-color: var(--accent, #4f8ef7); }',
      '.pr-tab-badge { background: var(--bg3, rgba(255,255,255,0.08)); padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 700; }',

      /* Table Styles */
      '.pr-card { background: var(--bg2, #161b26); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin-bottom: 24px; }',
      '.pr-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); gap: 12px; flex-wrap: wrap; }',
      '.pr-search { background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 7px 14px; border-radius: 7px; font-size: 12.5px; min-width: 220px; outline: none; }',
      '.pr-search:focus { border-color: var(--accent, #4f8ef7); }',
      '.pr-select { background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 7px 12px; border-radius: 7px; font-size: 12.5px; outline: none; }',
      '.pr-table-wrap { overflow-x: auto; width: 100%; }',
      '.pr-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px; }',
      '.pr-table th { padding: 12px 16px; background: var(--bg3, rgba(255,255,255,0.02)); font-weight: 600; color: var(--text2, #8a9bb8); text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); }',
      '.pr-table td { padding: 12px 16px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.05)); color: var(--text, #e8edf7); vertical-align: middle; }',
      '.pr-table tr:hover td { background: var(--bg3, rgba(255,255,255,0.02)); }',
      
      /* Badges */
      '.pr-badge { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: capitalize; }',
      '.pr-badge-draft { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }',
      '.pr-badge-approved { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }',
      '.pr-badge-paid { background: rgba(59,130,246,0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3); }',
      
      /* Modals */
      '.pr-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }',
      '.pr-modal { background: var(--bg2, #1a2232); border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: 14px; width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto; box-shadow: 0 16px 40px rgba(0,0,0,0.4); display: flex; flex-direction: column; }',
      '.pr-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08)); }',
      '.pr-modal-header h3 { margin: 0; font-size: 18px; font-weight: 700; color: var(--text, #fff); font-family: "Syne", sans-serif; }',
      '.pr-modal-close { background: none; border: none; font-size: 20px; color: var(--text3, #9ca3af); cursor: pointer; padding: 4px; border-radius: 4px; line-height: 1; }',
      '.pr-modal-close:hover { color: #fff; }',
      '.pr-modal-body { padding: 22px 24px; display: flex; flex-direction: column; gap: 16px; }',
      '.pr-field { display: flex; flex-direction: column; gap: 6px; }',
      '.pr-field label { font-size: 12px; font-weight: 600; color: var(--text2, #8a9bb8); }',
      '.pr-field input, .pr-field select { background: var(--bg3, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(255,255,255,0.1)); color: var(--text, #fff); padding: 9px 13px; border-radius: 7px; font-size: 13px; outline: none; }',
      '.pr-field input:focus, .pr-field select:focus { border-color: var(--accent, #4f8ef7); }',
      '.pr-modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 24px; border-top: 1px solid var(--border, rgba(255,255,255,0.08)); background: var(--bg3, rgba(255,255,255,0.02)); }',

      /* Toast */
      '#' + ID.toast + ' { position: fixed; bottom: 24px; right: 24px; background: #065f46; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 2000; display: flex; align-items: center; gap: 8px; transition: opacity 0.25s; }'
    ].join('\n');
    var st = document.createElement('style');
    st.id = ID.style;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function showToast(msg, isError) {
    var old = document.getElementById(ID.toast);
    if (old) old.remove();
    var t = document.createElement('div');
    t.id = ID.toast;
    t.style.background = isError ? '#991b1b' : '#065f46';
    t.innerHTML = (isError ? '⚠ ' : '✓ ') + msg;
    document.body.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.remove(); }, 300);
    }, 3500);
  }

  function formatCurrency(val) {
    var num = parseFloat(val) || 0;
    // Currency from Settings > General (hrms-company.js); rupees until it loads.
    if (window.HRMSCompany) return window.HRMSCompany.money(num, { decimals: 2 });
    return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(v) { return (v && window.HRMSCompany) ? window.HRMSCompany.date(v) : (v || ''); }

  /* ── API Loaders ── */
  function loadPayrollData() {
    state.loading = true;
    Promise.all([
      fetch('/api/payroll/runs').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/payslips').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/compensations').then(function (r) { return r.ok ? r.json() : []; }),
      fetch('/api/payroll/components').then(function (r) { return r.ok ? r.json() : []; })
    ]).then(function (res) {
      state.runs = Array.isArray(res[0]) ? res[0] : (res[0].results || []);
      state.payslips = Array.isArray(res[1]) ? res[1] : (res[1].results || []);
      state.compensations = Array.isArray(res[2]) ? res[2] : (res[2].results || []);
      state.components = Array.isArray(res[3]) ? res[3] : (res[3].results || []);
      state.loading = false;
      render();
    }).catch(function (err) {
      state.loading = false;
      console.error('Failed to load payroll data:', err);
      render();
    });
  }

  /* ── Action Handlers ── */
  function handleGenerateRun(periodLabel, start, end) {
    state.loading = true;
    render();
    fetch('/api/payroll/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        period_label: periodLabel,
        period_start: start,
        period_end: end,
        created_by: 'HR Admin'
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed to create run');
      return r.json();
    }).then(function (data) {
      showToast('Payroll Run ' + periodLabel + ' successfully generated!');
      state.modalOpen = false;
      loadPayrollData();
    }).catch(function (err) {
      showToast('Error generating run: ' + err.message, true);
      state.loading = false;
      render();
    });
  }

  function handleApproveRun(runId) {
    if (!confirm('Approve this pay run? This will lock all payslips and generate PDFs.')) return;
    fetch('/api/payroll/runs/' + runId + '/approve', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('Approval failed');
        return r.json();
      }).then(function () {
        showToast('Pay run approved and payslips locked!');
        loadPayrollData();
      }).catch(function (err) {
        showToast(err.message, true);
      });
  }

  /* ── Main Render Functions ── */
  function render() {
    var root = document.getElementById(ID.root);
    if (!root) return;

    var totalGross = state.runs.reduce(function (acc, r) { return acc + (parseFloat(r.total_gross) || 0); }, 0);
    var totalNet = state.runs.reduce(function (acc, r) { return acc + (parseFloat(r.total_net) || 0); }, 0);
    var totalEmps = state.compensations.length || 1;

    var html = [
      '<div class="pr-header">',
      '  <div class="pr-title-group">',
      '    <h2>💳 Payroll & Compensation</h2>',
      '    <p>Manage monthly Indian payroll runs, statutory pay components, and employee payslips.</p>',
      '  </div>',
      '  <div class="pr-actions">',
      '    <button class="pr-btn pr-btn-secondary" id="pr-btn-refresh">↻ Refresh</button>',
      '    <button class="pr-btn pr-btn-primary" id="pr-btn-new-run">+ Generate Pay Run</button>',
      '  </div>',
      '</div>',

      /* Stat Cards */
      '<div class="pr-stats">',
      '  <div class="pr-stat-card">',
      '    <span class="pr-stat-label">Total Pay Runs</span>',
      '    <span class="pr-stat-val">' + state.runs.length + '</span>',
      '    <span class="pr-stat-sub">Generated batches</span>',
      '  </div>',
      '  <div class="pr-stat-card">',
      '    <span class="pr-stat-label">Total Gross Payroll</span>',
      '    <span class="pr-stat-val">' + formatCurrency(totalGross) + '</span>',
      '    <span class="pr-stat-sub">All-time earnings calculated</span>',
      '  </div>',
      '  <div class="pr-stat-card">',
      '    <span class="pr-stat-label">Net Disbursed</span>',
      '    <span class="pr-stat-val" style="color:#10b981;">' + formatCurrency(totalNet) + '</span>',
      '    <span class="pr-stat-sub">Net employee payout</span>',
      '  </div>',
      '  <div class="pr-stat-card">',
      '    <span class="pr-stat-label">Active Employees</span>',
      '    <span class="pr-stat-val">' + totalEmps + '</span>',
      '    <span class="pr-stat-sub">On compensation roll</span>',
      '  </div>',
      '</div>',

      /* Tabs */
      '<div class="pr-tabs">',
      '  <div class="pr-tab ' + (state.activeTab === 'runs' ? 'active' : '') + '" data-tab="runs">Pay Runs <span class="pr-tab-badge">' + state.runs.length + '</span></div>',
      '  <div class="pr-tab ' + (state.activeTab === 'payslips' ? 'active' : '') + '" data-tab="payslips">Employee Payslips <span class="pr-tab-badge">' + state.payslips.length + '</span></div>',
      '  <div class="pr-tab ' + (state.activeTab === 'compensation' ? 'active' : '') + '" data-tab="compensation">Compensation Roll <span class="pr-tab-badge">' + state.compensations.length + '</span></div>',
      '  <div class="pr-tab ' + (state.activeTab === 'components' ? 'active' : '') + '" data-tab="components">Salary Components <span class="pr-tab-badge">' + state.components.length + '</span></div>',
      '</div>'
    ];

    /* Tab Content */
    if (state.activeTab === 'runs') {
      html.push(renderRunsTab());
    } else if (state.activeTab === 'payslips') {
      html.push(renderPayslipsTab());
    } else if (state.activeTab === 'compensation') {
      html.push(renderCompensationTab());
    } else if (state.activeTab === 'components') {
      html.push(renderComponentsTab());
    }

    /* Modal (if open) */
    if (state.modalOpen && state.modalType === 'newRun') {
      html.push(renderNewRunModal());
    }

    root.innerHTML = html.join('\n');
    attachEvents();
  }

  function renderRunsTab() {
    if (!state.runs.length) {
      return '<div class="pr-card" style="padding: 48px; text-align: center; color: var(--text2);">' +
        '<div style="font-size: 32px; margin-bottom: 8px;">💳</div>' +
        '<h3>No pay runs created yet</h3>' +
        '<p style="font-size: 13px; margin-bottom: 20px;">Click "+ Generate Pay Run" above to calculate and generate payslips for all active employees.</p>' +
        '<button class="pr-btn pr-btn-primary" id="pr-btn-new-run-empty">+ Generate Pay Run</button>' +
        '</div>';
    }

    var rows = state.runs.map(function (r) {
      var badgeCls = 'pr-badge-' + (r.status || 'draft').toLowerCase();
      return '<tr>' +
        '<td style="font-weight: 700; color: var(--accent, #4f8ef7);">' + r.period_label + '</td>' +
        '<td>' + fmtDate(r.period_start) + ' to ' + fmtDate(r.period_end) + '</td>' +
        '<td>' + (r.employee_count || 1) + ' Employees</td>' +
        '<td style="font-weight: 600;">' + formatCurrency(r.total_gross) + '</td>' +
        '<td style="color: #ef4444;">' + formatCurrency(r.total_deductions) + '</td>' +
        '<td style="font-weight: 700; color: #10b981;">' + formatCurrency(r.total_net) + '</td>' +
        '<td><span class="pr-badge ' + badgeCls + '">' + r.status + '</span></td>' +
        '<td>' +
        '  <div style="display:flex; gap:6px;">' +
        '    <button class="pr-btn pr-btn-secondary pr-btn-sm btn-filter-payslips" data-period="' + r.period_label + '">View Payslips</button>' +
        (r.status === 'draft' ? '    <button class="pr-btn pr-btn-success pr-btn-sm btn-approve-run" data-id="' + r.id + '">Approve</button>' : '') +
        '    <a href="/api/payroll/runs/' + r.id + '/export-bank-file" target="_blank" class="pr-btn pr-btn-secondary pr-btn-sm">Bank CSV</a>' +
        '  </div>' +
        '</td>' +
        '</tr>';
    }).join('');

    return '<div class="pr-card">' +
      '<div class="pr-table-wrap">' +
      '<table class="pr-table">' +
      '<thead><tr>' +
      '  <th>Pay Period</th><th>Dates</th><th>Employees</th><th>Gross Total</th><th>Deductions</th><th>Net Disbursed</th><th>Status</th><th>Actions</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }

  function renderPayslipsTab() {
    var filtered = state.payslips.filter(function (p) {
      var matchPeriod = !state.selectedPeriodFilter || (p.run_period === state.selectedPeriodFilter || (p.run && p.run.period_label === state.selectedPeriodFilter));
      var q = state.searchQuery.toLowerCase();
      var matchSearch = !q || (p.employee_name && p.employee_name.toLowerCase().indexOf(q) !== -1) || (p.email && p.email.toLowerCase().indexOf(q) !== -1);
      return matchPeriod && matchSearch;
    });

    // Extract unique periods for filter dropdown
    var periods = [];
    state.runs.forEach(function (r) { if (periods.indexOf(r.period_label) === -1) periods.push(r.period_label); });

    var periodOptions = '<option value="">All Pay Periods</option>' + periods.map(function (p) {
      return '<option value="' + p + '"' + (state.selectedPeriodFilter === p ? ' selected' : '') + '>' + p + '</option>';
    }).join('');

    var rows = filtered.map(function (p) {
      var period = p.run_period || (p.run ? p.run.period_label : '2026-06');
      var badgeCls = 'pr-badge-' + (p.status || 'draft').toLowerCase();
      return '<tr>' +
        '<td>' +
        '  <div style="font-weight:600; color:var(--text, #fff);">' + (p.employee_name || p.email) + '</div>' +
        '  <div style="font-size:11px; color:var(--text3, #8a9bb8);">' + (p.employee_code ? p.employee_code + ' • ' : '') + p.email + '</div>' +
        '</td>' +
        '<td style="font-weight:600; color:var(--accent, #4f8ef7);">' + period + '</td>' +
        '<td>' + (p.paid_days !== undefined ? p.paid_days : 30) + ' / ' + (p.month_days || 30) + '</td>' +
        '<td style="font-weight:600;">' + formatCurrency(p.gross_earnings) + '</td>' +
        '<td style="color:#ef4444;">' + formatCurrency(p.total_deductions) + '</td>' +
        '<td style="font-weight:700; color:#10b981;">' + formatCurrency(p.net_pay) + '</td>' +
        '<td><span class="pr-badge ' + badgeCls + '">' + p.status + '</span></td>' +
        '<td>' +
        '  <button class="pr-btn pr-btn-primary pr-btn-sm btn-view-pdf" data-id="' + p.id + '" style="background:#0e7490; border-color:#0891b2;">' +
        '    📄 View / Print Payslip' +
        '  </button>' +
        '</td>' +
        '</tr>';
    }).join('');

    if (!rows) {
      rows = '<tr><td colspan="8" style="text-align:center; padding:36px; color:var(--text3);">No payslips match your search or filter.</td></tr>';
    }

    return '<div class="pr-card">' +
      '<div class="pr-toolbar">' +
      '  <input type="text" class="pr-search" id="pr-search-payslips" placeholder="Search employee name, email, code..." value="' + (state.searchQuery || '') + '">' +
      '  <select class="pr-select" id="pr-filter-period">' + periodOptions + '</select>' +
      '</div>' +
      '<div class="pr-table-wrap">' +
      '<table class="pr-table">' +
      '<thead><tr>' +
      '  <th>Employee</th><th>Period</th><th>Paid Days</th><th>Gross Earnings</th><th>Total Deductions</th><th>Net Pay</th><th>Status</th><th>Eversoft Payslip</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }

  function renderCompensationTab() {
    var rows = state.compensations.map(function (c) {
      return '<tr>' +
        '<td>' +
        '  <div style="font-weight:600;">' + c.email + '</div>' +
        '  <div style="font-size:11px; color:var(--text3);">' + (c.employee_code || 'Code Pending') + '</div>' +
        '</td>' +
        '<td style="font-weight:700; color:#10b981;">' + formatCurrency(c.base_amount) + '</td>' +
        '<td style="font-weight:600;">' + formatCurrency(c.annual_ctc) + '</td>' +
        '<td>' + (c.pan_number || '-') + '</td>' +
        '<td>' + (c.uan_number || '-') + '</td>' +
        '<td>' + (c.pf_account_number || '-') + '</td>' +
        '<td>' + (c.bank_name ? c.bank_name + ' (' + c.bank_account_number + ')' : '-') + '</td>' +
        '<td><span class="pr-badge pr-badge-approved">Active</span></td>' +
        '</tr>';
    }).join('');

    return '<div class="pr-card">' +
      '<div class="pr-table-wrap">' +
      '<table class="pr-table">' +
      '<thead><tr>' +
      '  <th>Employee</th><th>Monthly Base</th><th>Annual CTC</th><th>PAN</th><th>UAN</th><th>PF Account</th><th>Bank Account</th><th>Status</th>' +
      '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="8" style="text-align:center; padding:30px;">No compensation records set.</td></tr>') + '</tbody>' +
      '</table></div></div>';
  }

  function renderComponentsTab() {
    var rows = state.components.map(function (pc) {
      var typeColor = pc.component_type === 'earning' ? '#10b981' : (pc.component_type === 'deduction' ? '#ef4444' : '#3b82f6');
      return '<tr>' +
        '<td style="font-weight:600; color:var(--text);">' + pc.name + '</td>' +
        '<td><code>' + pc.code + '</code></td>' +
        '<td><span style="font-weight:600; text-transform:uppercase; font-size:11px; color:' + typeColor + ';">' + pc.component_type + '</span></td>' +
        '<td>' + pc.calc_type + '</td>' +
        '<td>' + (pc.rate > 0 ? (pc.rate * 100) + '%' : '-') + '</td>' +
        '<td>' + (pc.default_amount > 0 ? formatCurrency(pc.default_amount) : '-') + '</td>' +
        '<td><span class="pr-badge ' + (pc.is_active ? 'pr-badge-approved' : 'pr-badge-draft') + '">' + (pc.is_active ? 'Active' : 'Inactive') + '</span></td>' +
        '</tr>';
    }).join('');

    return '<div class="pr-card">' +
      '<div class="pr-table-wrap">' +
      '<table class="pr-table">' +
      '<thead><tr>' +
      '  <th>Component Name</th><th>Code</th><th>Type</th><th>Calculation</th><th>Rate</th><th>Default Amount</th><th>Status</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }

  function renderNewRunModal() {
    var now = new Date();
    var y = now.getFullYear();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var defaultPeriod = '2026-06';
    var defaultStart = '2026-06-01';
    var defaultEnd = '2026-06-30';

    return '<div class="pr-overlay" id="pr-modal-overlay">' +
      '<div class="pr-modal">' +
      '  <div class="pr-modal-header">' +
      '    <h3>Generate Indian Pay Run</h3>' +
      '    <button class="pr-modal-close" id="pr-modal-close">&times;</button>' +
      '  </div>' +
      '  <div class="pr-modal-body">' +
      '    <p style="margin:0; font-size:13px; color:var(--text2);">This batch will compute salaries, statutory PF/ESI/PT deductions, CTC, and generate payslips for all active employees.</p>' +
      '    <div class="pr-field">' +
      '      <label>Pay Period Label (YYYY-MM)</label>' +
      '      <input type="text" id="pr-new-period" value="' + defaultPeriod + '" placeholder="e.g. 2026-06">' +
      '    </div>' +
      '    <div class="pr-field">' +
      '      <label>Period Start Date</label>' +
      '      <input type="date" id="pr-new-start" value="' + defaultStart + '">' +
      '    </div>' +
      '    <div class="pr-field">' +
      '      <label>Period End Date</label>' +
      '      <input type="date" id="pr-new-end" value="' + defaultEnd + '">' +
      '    </div>' +
      '  </div>' +
      '  <div class="pr-modal-footer">' +
      '    <button class="pr-btn pr-btn-secondary" id="pr-modal-cancel">Cancel</button>' +
      '    <button class="pr-btn pr-btn-primary" id="pr-modal-submit">Calculate & Generate Run</button>' +
      '  </div>' +
      '</div></div>';
  }

  /* ── Event Attachments ── */
  function attachEvents() {
    var root = document.getElementById(ID.root);
    if (!root) return;

    // Tab buttons
    root.querySelectorAll('.pr-tab').forEach(function (tabEl) {
      tabEl.addEventListener('click', function () {
        state.activeTab = this.getAttribute('data-tab');
        render();
      });
    });

    // Refresh button
    var refreshBtn = root.querySelector('#pr-btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadPayrollData();
        showToast('Refreshing payroll data...');
      });
    }

    // New Pay Run button
    var newRunBtn = root.querySelector('#pr-btn-new-run') || root.querySelector('#pr-btn-new-run-empty');
    if (newRunBtn) {
      newRunBtn.addEventListener('click', function () {
        state.modalOpen = true;
        state.modalType = 'newRun';
        render();
      });
    }

    // Modal close & submit
    var closeBtn = root.querySelector('#pr-modal-close') || root.querySelector('#pr-modal-cancel');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        state.modalOpen = false;
        render();
      });
    }

    var submitBtn = root.querySelector('#pr-modal-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var p = (document.getElementById('pr-new-period').value || '').trim();
        var s = (document.getElementById('pr-new-start').value || '').trim();
        var e = (document.getElementById('pr-new-end').value || '').trim();
        if (!p || !s || !e) {
          alert('Please enter period label, start date, and end date.');
          return;
        }
        handleGenerateRun(p, s, e);
      });
    }

    // Action: View PDF Payslip
    root.querySelectorAll('.btn-view-pdf').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        window.open('/api/payroll/payslips/' + id + '/pdf', '_blank');
      });
    });

    // Action: Approve Run
    root.querySelectorAll('.btn-approve-run').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        handleApproveRun(id);
      });
    });

    // Action: Filter payslips by run
    root.querySelectorAll('.btn-filter-payslips').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selectedPeriodFilter = this.getAttribute('data-period');
        state.activeTab = 'payslips';
        render();
      });
    });

    // Search & Filter
    var searchInput = root.querySelector('#pr-search-payslips');
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        state.searchQuery = e.target.value;
        render();
      });
    }

    var periodSelect = root.querySelector('#pr-filter-period');
    if (periodSelect) {
      periodSelect.addEventListener('change', function (e) {
        state.selectedPeriodFilter = e.target.value;
        render();
      });
    }
  }

  /* ── Mount / Unmount Orchestration ── */
  function ensureLayout() {
    var onPayroll = isPayrollRoute();
    var main = document.querySelector('.main');
    var content = document.querySelector('.content');

    if (!onPayroll) {
      document.body.removeAttribute('data-payroll-active');
      var oldRoot = document.getElementById(ID.root);
      if (oldRoot) oldRoot.remove();
      if (content && content.dataset.payrollHidden) {
        content.style.display = '';
        delete content.dataset.payrollHidden;
      }
      return;
    }

    document.body.setAttribute('data-payroll-active', '1');
    if (!main) return;
    ensureStyle();

    // Hide the "Coming Soon" placeholder in React's .content
    if (content) {
      content.style.display = 'none';
      content.dataset.payrollHidden = '1';
    }

    // Update Topbar Title
    var topbarTitle = document.querySelector('.topbar-title');
    if (topbarTitle && topbarTitle.textContent !== 'Payroll & Compensation') {
      topbarTitle.textContent = 'Payroll & Compensation';
    }

    var root = document.getElementById(ID.root);
    if (!root) {
      root = document.createElement('div');
      root.id = ID.root;
      main.appendChild(root);
      render();
      loadPayrollData();
    } else if (root.parentElement !== main) {
      main.appendChild(root);
    }
  }

  // ── Intercept Add Employee in HRIS (/hr/hris) to persist to database & sync payroll ──
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var btnText = (btn.textContent || '').trim();
    if (btnText !== 'Add Employee') return;

    // Check if inside modal
    var modal = btn.closest('.modal, [class*="modal"], [class*="dialog"], [role="dialog"]') || btn.closest('.card') || (btn.parentElement ? btn.parentElement.parentElement : null);
    if (!modal) return;

    var nameInput = modal.querySelector('input[placeholder*="Priya"], input[name="name"]');
    var emailInput = modal.querySelector('input[type="email"], input[placeholder*="@"]');
    if (!nameInput || !emailInput) return;

    var fullName = (nameInput.value || '').trim();
    var email = (emailInput.value || '').trim();
    if (!fullName || !email) return;

    var deptEl = modal.querySelector('select, input[placeholder*="department" i]');
    var titleEl = modal.querySelector('input[placeholder*="Engineer" i]');
    var managerEl = modal.querySelector('input[placeholder*="Ankit" i]');
    var selects = modal.querySelectorAll('select');
    var levelEl = selects.length > 1 ? selects[1] : (selects[0] || null);
    var locEl = modal.querySelector('input[placeholder*="Bengaluru" i]');
    var ctcEl = modal.querySelector('input[placeholder*="2800000" i], input[value*="2800000"]');
    var dateEl = modal.querySelector('input[type="date"]');

    var payload = {
      fullName: fullName,
      email: email,
      department: (deptEl ? deptEl.value : 'Engineering') || 'Engineering',
      jobTitle: (titleEl ? titleEl.value : 'Software Engineer') || 'Software Engineer',
      manager: (managerEl ? managerEl.value : '') || '',
      level: (levelEl ? levelEl.value : 'L4') || 'L4',
      employmentType: 'Full-time',
      location: (locEl ? locEl.value : 'Bengaluru / Remote') || 'Bengaluru / Remote',
      annualCtc: (ctcEl ? ctcEl.value : '2800000') || '2800000',
      startDate: (dateEl ? dateEl.value : '') || '2026-06-01'
    };

    fetch('/api/employees', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok) {
        showToast('✓ ' + fullName + ' saved to HRIS & Indian Payroll generated!');
        loadPayrollData();
      }
    }).catch(function (err) {
      console.warn('Auto-save to backend failed:', err);
    });
  }, true);

  // Settings > General changed (currency / dates): repaint if mounted.
  window.addEventListener('hrmsCompanyApplied', function () { if (document.getElementById(ID.root)) render(); });

  // Hook into navigation events
  window.addEventListener('popstate', ensureLayout);
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var res = orig.apply(this, arguments);
      setTimeout(ensureLayout, 50);
      return res;
    };
  });

  // Watch DOM mutations to ensure layout remains mounted
  var observer = new MutationObserver(function () {
    if (isPayrollRoute()) {
      ensureLayout();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLayout);
  } else {
    ensureLayout();
  }
})();
