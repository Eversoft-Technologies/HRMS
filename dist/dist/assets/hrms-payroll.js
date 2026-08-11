/**
 * hrms-payroll.js  v1
 * Complete Payroll & Compensation Dashboard Overlay & Portal Launcher.
 *
 * Provides window.__hrmsOpenPayroll() to open the full Payroll Dashboard overlay
 * from anywhere in the application, and auto-mounts a floating Payroll button
 * on the HRMS interface.
 */
(function () {
  'use strict';

  var OVERLAY_ID = 'hrms-payroll-overlay';

  function getEmail() {
    try {
      var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return sess.email || localStorage.getItem('employee_email') || 'employee@company.com';
    } catch (_) {
      return localStorage.getItem('employee_email') || 'employee@company.com';
    }
  }

  function getName() {
    try {
      var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return sess.name || localStorage.getItem('employee_name') || 'Employee';
    } catch (_) {
      return localStorage.getItem('employee_name') || 'Employee';
    }
  }

  function getRole() {
    try {
      var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return (sess.role || localStorage.getItem('user_role') || 'admin').toLowerCase();
    } catch (_) {
      return (localStorage.getItem('user_role') || 'admin').toLowerCase();
    }
  }

  function isAdmin() {
    var role = getRole();
    return role === 'admin' || role === 'hr' || role === 'payroll_admin' || role === 'superadmin';
  }

  function openPayrollModal() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.style.display = 'flex';
      loadPayslips();
      return;
    }

    var admin = isAdmin();

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.7);z-index:999999;display:flex;justify:center;align-items:center;padding:20px;font-family:Inter,system-ui,sans-serif;box-sizing:border-box;';

    var dialog = document.createElement('div');
    dialog.style.cssText = 'background:#ffffff;width:100%;max-width:1100px;max-height:90vh;border-radius:16px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);overflow:hidden;display:flex;flex-direction:column;';

    dialog.innerHTML = `
      <div style="background:#0f172a;color:#ffffff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;">
            <h2 style="margin:0;font-size:20px;font-weight:700;">💳 Payroll & Compensation Portal</h2>
            ${admin ? '<span style="padding:4px 10px;background:#1e293b;color:#38bdf8;border-radius:12px;font-size:11px;font-weight:600;">🛡️ Full Admin Access</span>' : '<span style="padding:4px 10px;background:#1e293b;color:#a7f3d0;border-radius:12px;font-size:11px;font-weight:600;">👤 Employee Self-Service</span>'}
          </div>
          <p style="margin:4px 0 0 0;font-size:13px;color:#94a3b8;">Automated salary calculations, LOP deductions, payslips, and pay runs</p>
        </div>
        <button id="hrms-payroll-close" style="background:transparent;border:none;color:#94a3b8;font-size:24px;cursor:pointer;padding:4px 8px;">✕</button>
      </div>

      <div style="display:flex;gap:12px;background:#f8fafc;padding:12px 24px;border-bottom:1px solid #e2e8f0;">
        <button id="tab-payslips" class="pr-tab active-tab">📄 My Payslips</button>
        <button id="tab-payruns" class="pr-tab">⚙️ Pay Runs Engine ${admin ? '(Admin)' : '🔒'}</button>
        <button id="tab-compensation" class="pr-tab">💼 Employee Compensation ${admin ? '' : '🔒'}</button>
        <button id="tab-components" class="pr-tab">🏷️ Pay Components ${admin ? '' : '🔒'}</button>
      </div>

      <div id="payroll-content" style="padding:24px;overflow-y:auto;flex:1;background:#ffffff;">
        <div style="text-align:center;padding:40px;color:#64748b;">Loading payroll details...</div>
      </div>

      <style>
        .pr-tab { padding:8px 16px; border:none; background:transparent; font-size:14px; font-weight:600; color:#64748b; cursor:pointer; border-radius:6px; }
        .pr-tab.active-tab { background:#e0e7ff; color:#3730a3; }
        .pr-card { border:1px solid #e2e8f0; border-radius:12px; padding:20px; background:#ffffff; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
        .pr-badge-approved { padding:4px 10px; background:#dcfce7; color:#15803d; border-radius:12px; font-size:11px; font-weight:700; }
        .pr-badge-draft { padding:4px 10px; background:#fef3c7; color:#b45309; border-radius:12px; font-size:11px; font-weight:700; }
        .pr-btn { padding:8px 16px; background:#2563eb; color:#ffffff; border:none; border-radius:6px; font-weight:600; cursor:pointer; }
        .pr-btn-success { background:#16a34a; }
        .pr-btn-export { background:#0284c7; }
        .pr-table { width:100%; border-collapse:collapse; margin-top:12px; }
        .pr-table th, .pr-table td { padding:12px; border-bottom:1px solid #e2e8f0; text-align:left; font-size:14px; }
        .pr-table th { background:#f8fafc; font-weight:600; color:#475569; }
      </style>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    document.getElementById('hrms-payroll-close').onclick = function () {
      overlay.style.display = 'none';
    };

    var tabs = ['payslips', 'payruns', 'compensation', 'components'];
    tabs.forEach(function (t) {
      var btn = document.getElementById('tab-' + t);
      if (btn) {
        btn.onclick = function () {
          tabs.forEach(function (x) {
            var b = document.getElementById('tab-' + x);
            if (b) b.classList.remove('active-tab');
          });
          btn.classList.add('active-tab');

          if (!admin && t !== 'payslips') {
            showAccessRestrictedView(t);
            return;
          }

          if (t === 'payslips') loadPayslips();
          else if (t === 'payruns') loadPayRuns();
          else if (t === 'compensation') loadCompensations();
          else if (t === 'components') loadComponents();
        };
      }
    });

    loadPayslips();
  }

  function showAccessRestrictedView(tabName) {
    var content = document.getElementById('payroll-content');
    var title = tabName === 'payruns' ? 'Pay Runs Engine' : (tabName === 'compensation' ? 'Employee Compensation' : 'Pay Components');
    content.innerHTML = `
      <div style="text-align:center;padding:56px 24px;background:#f8fafc;border-radius:12px;border:1px dashed #cbd5e1;max-width:600px;margin:24px auto;">
        <div style="font-size:48px;margin-bottom:16px;">🔒</div>
        <h3 style="margin:0 0 8px 0;color:#0f172a;font-size:18px;">Administrator Access Required</h3>
        <p style="color:#64748b;font-size:14px;line-height:1.5;margin:0 0 20px 0;">
          The <strong>${title}</strong> module is restricted to HR and Payroll Administrators.
          As an employee, your essential self-service access includes viewing and downloading your monthly payslips under <strong>My Payslips</strong>.
        </p>
        <button id="btn-back-payslips" class="pr-btn">Return to My Payslips</button>
      </div>
    `;
    var backBtn = document.getElementById('btn-back-payslips');
    if (backBtn) {
      backBtn.onclick = function () {
        var payslipTab = document.getElementById('tab-payslips');
        if (payslipTab) payslipTab.click();
      };
    }
  }

  function loadPayslips() {
    var content = document.getElementById('payroll-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;">Loading payslips...</div>';

    var email = getEmail();
    fetch('/api/payroll/payslips?email=' + encodeURIComponent(email))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.length === 0) {
          content.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;background:#f8fafc;border-radius:12px;">No payslips available yet for <strong>' + email + '</strong>. Check back after a pay run is approved.</div>';
          return;
        }

        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:20px;">';
        data.forEach(function (slip) {
          html += `
            <div class="pr-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <strong style="font-size:16px;color:#0f172a;">${slip.period_label || 'Pay Period'}</strong>
                <span class="pr-badge-${slip.status === 'approved' ? 'approved' : 'draft'}">${(slip.status || 'DRAFT').toUpperCase()}</span>
              </div>
              <div style="font-size:14px;color:#334155;line-height:1.6;">
                <div style="display:flex;justify-content:space-between;"><span>Worked / Paid Days:</span><strong>${slip.worked_days} / ${slip.paid_days}</strong></div>
                <div style="display:flex;justify-content:space-between;"><span>Loss of Pay (LOP):</span><strong style="color:${slip.lop_days > 0 ? '#dc2626' : '#16a34a'};">${slip.lop_days} days</strong></div>
                <div style="display:flex;justify-content:space-between;"><span>Overtime Hours:</span><strong>${slip.overtime_hours} hrs</strong></div>
                <hr style="margin:10px 0;border:none;border-top:1px dashed #e2e8f0;"/>
                <div style="display:flex;justify-content:space-between;"><span>Gross Earnings:</span><span>$${Number(slip.gross_earnings).toFixed(2)}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Deductions:</span><span style="color:#dc2626;">-$${Number(slip.total_deductions).toFixed(2)}</span></div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;background:#eff6ff;padding:8px 12px;border-radius:6px;">
                  <span style="font-weight:600;">Net Salary:</span>
                  <strong style="font-size:18px;color:#1d4ed8;">$${Number(slip.net_pay).toFixed(2)}</strong>
                </div>
              </div>
              <button onclick="window.open('/api/payroll/payslips/${slip.id}/pdf','_blank')" class="pr-btn" style="width:100%;margin-top:14px;">📥 View / Download PDF Payslip</button>
            </div>
          `;
        });
        html += '</div>';
        content.innerHTML = html;
      })
      .catch(function () {
        content.innerHTML = '<div style="color:#dc2626;padding:20px;">Failed to load payslips. Please check backend connection.</div>';
      });
  }

  function loadPayRuns() {
    var content = document.getElementById('payroll-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;">Loading pay runs...</div>';

    fetch('/api/payroll/runs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var html = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#0f172a;">Pay Runs Engine</h3>
            <button id="btn-create-run" class="pr-btn">+ Run New Monthly Payroll</button>
          </div>
          <table class="pr-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Dates</th>
                <th>Employees</th>
                <th>Total Gross</th>
                <th>Total Deductions</th>
                <th>Total Net Payout</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
        `;

        if (!data || data.length === 0) {
          html += '<tr><td colSpan="8" style="text-align:center;padding:24px;">No pay runs generated. Click "+ Run New Monthly Payroll" to execute.</td></tr>';
        } else {
          data.forEach(function (run) {
            html += `
              <tr>
                <td><strong>${run.period_label}</strong></td>
                <td>${run.period_start} to ${run.period_end}</td>
                <td>${run.employee_count}</td>
                <td>$${Number(run.total_gross).toFixed(2)}</td>
                <td style="color:#dc2626;">-$${Number(run.total_deductions).toFixed(2)}</td>
                <td style="font-weight:700;color:#2563eb;">$${Number(run.total_net).toFixed(2)}</td>
                <td><span class="pr-badge-${run.status === 'approved' ? 'approved' : 'draft'}">${(run.status || 'DRAFT').toUpperCase()}</span></td>
                <td>
                  <div style="display:flex;gap:6px;">
                    ${run.status === 'draft' ? `<button onclick="window.__hrmsApproveRun(${run.id})" class="pr-btn pr-btn-success" style="padding:4px 8px;font-size:12px;">✓ Approve</button>` : ''}
                    <button onclick="window.open('/api/payroll/runs/${run.id}/export-bank-file','_blank')" class="pr-btn pr-btn-export" style="padding:4px 8px;font-size:12px;">🏦 Bank CSV</button>
                  </div>
                </td>
              </tr>
            `;
          });
        }

        html += '</tbody></table>';
        content.innerHTML = html;

        var createBtn = document.getElementById('btn-create-run');
        if (createBtn) {
          createBtn.onclick = function () {
            var period = prompt('Enter Pay Period Label (e.g. 2026-08):', '2026-08');
            if (!period) return;

            fetch('/api/payroll/runs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ period_label: period.trim() })
            })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res.error) {
                alert('✕ Error creating pay run: ' + res.error);
              } else {
                alert('✓ Pay run created in draft mode!');
                loadPayRuns();
              }
            })
            .catch(function (err) {
              alert('✕ Server connection error');
            });
          };
        }
      });
  }

  window.__hrmsApproveRun = function (runId) {
    if (!confirm('Approve pay run and lock payslips?')) return;
    fetch('/api/payroll/runs/' + runId + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved_by: getName() })
    }).then(function () {
      alert('Pay run approved!');
      loadPayRuns();
    });
  };

  function loadCompensations() {
    var content = document.getElementById('payroll-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;">Loading compensations...</div>';
    fetch('/api/payroll/compensations')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var html = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#0f172a;">Employee Compensation Setup</h3>
            <button id="btn-add-comp" class="pr-btn">+ Add / Update Compensation</button>
          </div>
          <table class="pr-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Pay Basis</th>
                <th>Frequency</th>
                <th>Base Monthly Amount</th>
                <th>Annual CTC</th>
                <th>Effective From</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
        `;

        if (!data || data.length === 0) {
          html += '<tr><td colSpan="7" style="text-align:center;padding:24px;">No compensation records setup. Click "+ Add / Update Compensation" to configure.</td></tr>';
        } else {
          data.forEach(function (c) {
            html += `<tr><td><strong>${c.email}</strong></td><td>${(c.pay_type||'salaried').toUpperCase()}</td><td>${c.pay_frequency}</td><td>$${Number(c.base_amount).toFixed(2)}</td><td>$${Number(c.annual_ctc).toFixed(2)}</td><td>${c.effective_from || 'Now'}</td><td><span class="pr-badge-approved">${(c.status||'active').toUpperCase()}</span></td></tr>`;
          });
        }
        html += '</tbody></table>';
        content.innerHTML = html;

        var addBtn = document.getElementById('btn-add-comp');
        if (addBtn) {
          addBtn.onclick = function () {
            var email = prompt('Enter Employee Email:', getEmail());
            if (!email) return;
            var amountStr = prompt('Enter Base Monthly Salary Amount (USD):', '5000');
            if (!amountStr) return;
            var amount = parseFloat(amountStr) || 5000;

            fetch('/api/payroll/compensations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: email.trim().toLowerCase(),
                pay_type: 'salaried',
                pay_frequency: 'monthly',
                base_amount: amount,
                annual_ctc: amount * 12,
                currency: 'USD',
                status: 'active'
              })
            }).then(function () {
              alert('✓ Employee compensation saved successfully!');
              loadCompensations();
            });
          };
        }
      });
  }

  function loadComponents() {
    var content = document.getElementById('payroll-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;">Loading pay components...</div>';
    fetch('/api/payroll/components')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:16px;">';
        if (!data || data.length === 0) {
          html += '<div style="padding:20px;background:#f8fafc;border-radius:8px;">Built-in active components: BASE_SALARY, LOP_DEDUCTION, OVERTIME.</div>';
        } else {
          data.forEach(function (c) {
            html += `<div class="pr-card"><strong>${c.name}</strong> (${c.code})<br/><small>Type: ${c.component_type} | Default: $${c.default_amount}</small></div>`;
          });
        }
        html += '</div>';
        content.innerHTML = html;
      });
  }

  // Mount Floating Quick Access Payroll Button on HRMS interface
  function mountFloatingButton() {
    if (document.getElementById('hrms-payroll-trigger')) return;
    var btn = document.createElement('button');
    btn.id = 'hrms-payroll-trigger';
    btn.innerHTML = '💳 Payroll';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#ffffff;border:none;padding:12px 20px;border-radius:30px;font-weight:700;font-size:14px;box-shadow:0 10px 15px -3px rgba(37,99,235,0.4);cursor:pointer;font-family:Inter,system-ui,sans-serif;transition:transform 0.2s;';
    btn.onmouseover = function() { btn.style.transform = 'scale(1.05)'; };
    btn.onmouseout = function() { btn.style.transform = 'scale(1)'; };
    btn.onclick = openPayrollModal;
    document.body.appendChild(btn);
  }

  window.__hrmsOpenPayroll = openPayrollModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountFloatingButton);
  } else {
    mountFloatingButton();
  }
})();
