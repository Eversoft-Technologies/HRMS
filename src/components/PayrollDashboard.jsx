/**
 * HRMS Payroll Module - Dashboard & Management Component
 * Includes: My Payslips, Pay Runs Engine, Employee Compensation Setup, and Pay Components Catalogue.
 */

import React, { useState, useEffect } from 'react';

const PayrollDashboard = () => {
  const [activeTab, setActiveTab] = useState('payslips'); // payslips, payruns, compensation, components
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  
  // Data states
  const [myPayslips, setMyPayslips] = useState([]);
  const [payRuns, setPayRuns] = useState([]);
  const [compensations, setCompensations] = useState([]);
  const [components, setComponents] = useState([]);
  const [selectedPayslip, setSelectedPayslip] = useState(null);
  
  // New Pay Run modal state
  const [showRunModal, setShowRunModal] = useState(false);
  const [newRunForm, setNewRunForm] = useState({
    period_label: '2026-08',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    created_by: localStorage.getItem('employee_name') || 'Admin'
  });

  // New Compensation form state
  const [showCompModal, setShowCompModal] = useState(false);
  const [compForm, setCompForm] = useState({
    email: '',
    pay_type: 'salaried',
    pay_frequency: 'monthly',
    base_amount: 5000,
    annual_ctc: 60000,
    currency: 'USD',
    effective_from: new Date().toISOString().split('T')[0]
  });

  const getEmail = () => localStorage.getItem('employee_email') || 'employee@company.com';
  const getToken = () => localStorage.getItem('auth_token') || '';

  useEffect(() => {
    fetchDataForTab(activeTab);
  }, [activeTab]);

  const fetchDataForTab = async (tab) => {
    setLoading(true);
    setMessage('');
    try {
      const email = getEmail();
      const token = getToken();

      if (tab === 'payslips') {
        const res = await fetch(`http://localhost:8000/api/payroll/payslips?email=${email}`, {
          headers: { 'Authorization': `Token ${token}` }
        });
        if (res.ok) setMyPayslips(await res.json());
      } else if (tab === 'payruns') {
        const res = await fetch(`http://localhost:8000/api/payroll/runs`, {
          headers: { 'Authorization': `Token ${token}` }
        });
        if (res.ok) setPayRuns(await res.json());
      } else if (tab === 'compensation') {
        const res = await fetch(`http://localhost:8000/api/payroll/compensations`, {
          headers: { 'Authorization': `Token ${token}` }
        });
        if (res.ok) setCompensations(await res.json());
      } else if (tab === 'components') {
        const res = await fetch(`http://localhost:8000/api/payroll/components`, {
          headers: { 'Authorization': `Token ${token}` }
        });
        if (res.ok) setComponents(await res.json());
      }
    } catch (err) {
      console.error('Error fetching payroll data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePayRun = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8000/api/payroll/runs', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${getToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newRunForm)
      });
      if (res.ok) {
        setMessage('✓ Payroll run created successfully in draft mode.');
        setShowRunModal(false);
        fetchDataForTab('payruns');
      } else {
        const err = await res.json();
        setMessage(`✕ Error: ${err.error || 'Failed to create pay run'}`);
      }
    } catch (err) {
      setMessage('✕ Failed to create pay run');
    } finally {
      setLoading(false);
    }
  };

  const handleApprovePayRun = async (runId) => {
    if (!window.confirm('Approve pay run and lock payslips?')) return;
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:8000/api/payroll/runs/${runId}/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${getToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ approved_by: localStorage.getItem('employee_name') || 'Admin' })
      });
      if (res.ok) {
        setMessage('✓ Pay run approved and PDF payslips rendered!');
        fetchDataForTab('payruns');
      }
    } catch (err) {
      setMessage('✕ Approval failed');
    } finally {
      setLoading(false);
    }
  };

  const handleExportBankFile = (runId, label) => {
    window.open(`http://localhost:8000/api/payroll/runs/${runId}/export-bank-file`, '_blank');
  };

  const handleSaveCompensation = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8000/api/payroll/compensations', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${getToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(compForm)
      });
      if (res.ok) {
        setMessage('✓ Employee compensation configured successfully.');
        setShowCompModal(false);
        fetchDataForTab('compensation');
      }
    } catch (err) {
      setMessage('✕ Error saving compensation');
    } finally {
      setLoading(false);
    }
  };

  const openPayslipPdf = async (id) => {
    window.open(`http://localhost:8000/api/payroll/payslips/${id}/pdf`, '_blank');
  };

  return (
    <div style={styles.container}>
      {/* Header Banner */}
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>💳 Payroll & Compensation Dashboard</h2>
          <p style={styles.subtitle}>Automated salary calculations, attendance LOP deductions, and batch pay runs</p>
        </div>
        <div style={styles.userBadge}>
          <span>Logged in as: <strong>{getEmail()}</strong></span>
        </div>
      </div>

      {/* Alert Messages */}
      {message && (
        <div style={{ ...styles.alert, backgroundColor: message.startsWith('✓') ? '#dcfce7' : '#fee2e2', color: message.startsWith('✓') ? '#166534' : '#991b1b' }}>
          {message}
        </div>
      )}

      {/* Navigation Tabs */}
      <div style={styles.tabsContainer}>
        <button style={activeTab === 'payslips' ? styles.activeTab : styles.tab} onClick={() => setActiveTab('payslips')}>
          📄 My Payslips
        </button>
        <button style={activeTab === 'payruns' ? styles.activeTab : styles.tab} onClick={() => setActiveTab('payruns')}>
          ⚙️ Pay Runs Engine (Admin)
        </button>
        <button style={activeTab === 'compensation' ? styles.activeTab : styles.tab} onClick={() => setActiveTab('compensation')}>
          💼 Employee Compensation
        </button>
        <button style={activeTab === 'components' ? styles.activeTab : styles.tab} onClick={() => setActiveTab('components')}>
          🏷️ Pay Components
        </button>
      </div>

      {loading && <div style={styles.loading}>Loading payroll data...</div>}

      {/* Tab 1: My Payslips */}
      {!loading && activeTab === 'payslips' && (
        <div>
          <div style={styles.sectionHeader}>
            <h3>My Payslip History</h3>
          </div>
          {myPayslips.length === 0 ? (
            <div style={styles.emptyState}>No payslips available yet. Check back after the next pay run.</div>
          ) : (
            <div style={styles.grid}>
              {myPayslips.map((slip) => (
                <div key={slip.id} style={styles.card}>
                  <div style={styles.cardHeader}>
                    <span style={styles.periodTag}>{slip.period_label || 'Pay Period'}</span>
                    <span style={styles.statusBadge(slip.status)}>{slip.status.toUpperCase()}</span>
                  </div>
                  <div style={styles.cardBody}>
                    <div style={styles.statRow}>
                      <span>Worked / Paid Days:</span>
                      <strong>{slip.worked_days} / {slip.paid_days}</strong>
                    </div>
                    <div style={styles.statRow}>
                      <span>LOP (Loss of Pay) Days:</span>
                      <strong style={{ color: slip.lop_days > 0 ? '#dc2626' : '#16a34a' }}>{slip.lop_days} days</strong>
                    </div>
                    <div style={styles.statRow}>
                      <span>Overtime Hours:</span>
                      <strong>{slip.overtime_hours} hrs</strong>
                    </div>
                    <hr style={styles.divider} />
                    <div style={styles.statRow}>
                      <span>Gross Earnings:</span>
                      <span>${Number(slip.gross_earnings).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div style={styles.statRow}>
                      <span>Total Deductions:</span>
                      <span style={{ color: '#dc2626' }}>-${Number(slip.total_deductions).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div style={styles.netPayRow}>
                      <span>Net Salary:</span>
                      <strong style={styles.netPayAmount}>${Number(slip.net_pay).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
                    </div>
                  </div>
                  <button style={styles.pdfBtn} onClick={() => openPayslipPdf(slip.id)}>
                    📥 View / Download PDF Payslip
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Pay Runs Engine */}
      {!loading && activeTab === 'payruns' && (
        <div>
          <div style={styles.sectionHeader}>
            <h3>Monthly Batch Pay Runs</h3>
            <button style={styles.actionBtn} onClick={() => setShowRunModal(true)}>
              + Generate New Pay Run
            </button>
          </div>

          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeadRow}>
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
              {payRuns.length === 0 ? (
                <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px' }}>No payroll runs created. Click 'Generate New Pay Run' to start.</td></tr>
              ) : (
                payRuns.map((run) => (
                  <tr key={run.id} style={styles.tableRow}>
                    <td><strong>{run.period_label}</strong></td>
                    <td>{run.period_start} to {run.period_end}</td>
                    <td>{run.employee_count}</td>
                    <td>${Number(run.total_gross).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td style={{ color: '#dc2626' }}>-${Number(run.total_deductions).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td style={{ fontWeight: 'bold', color: '#2563eb' }}>${Number(run.total_net).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td><span style={styles.statusBadge(run.status)}>{run.status.toUpperCase()}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {run.status === 'draft' && (
                          <button style={styles.smallApproveBtn} onClick={() => handleApprovePayRun(run.id)}>
                            ✓ Approve
                          </button>
                        )}
                        <button style={styles.smallExportBtn} onClick={() => handleExportBankFile(run.id, run.period_label)}>
                          🏦 Bank CSV
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 3: Employee Compensation */}
      {!loading && activeTab === 'compensation' && (
        <div>
          <div style={styles.sectionHeader}>
            <h3>Employee Salary & Compensation Config</h3>
            <button style={styles.actionBtn} onClick={() => setShowCompModal(true)}>
              + Add / Update Compensation
            </button>
          </div>

          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeadRow}>
                <th>Employee Email</th>
                <th>Pay Basis</th>
                <th>Frequency</th>
                <th>Base Monthly Amount</th>
                <th>Annual CTC</th>
                <th>Currency</th>
                <th>Effective From</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {compensations.length === 0 ? (
                <tr><td colSpan="8" style={{ textAlign: 'center', padding: '20px' }}>No compensation structures recorded.</td></tr>
              ) : (
                compensations.map((c) => (
                  <tr key={c.id} style={styles.tableRow}>
                    <td><strong>{c.email}</strong></td>
                    <td><span style={styles.typeBadge}>{c.pay_type.toUpperCase()}</span></td>
                    <td>{c.pay_frequency}</td>
                    <td>${Number(c.base_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td>${Number(c.annual_ctc).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td>{c.currency}</td>
                    <td>{c.effective_from}</td>
                    <td><span style={styles.statusBadge(c.status)}>{c.status.toUpperCase()}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 4: Pay Components Catalogue */}
      {!loading && activeTab === 'components' && (
        <div>
          <div style={styles.sectionHeader}>
            <h3>Pay Components Catalogue (Earnings & Deductions)</h3>
          </div>
          <div style={styles.grid}>
            {components.length === 0 ? (
              <div style={styles.emptyState}>Standard components active: BASE_SALARY, LOP_DEDUCTION, OVERTIME.</div>
            ) : (
              components.map((comp) => (
                <div key={comp.id} style={styles.card}>
                  <div style={styles.cardHeader}>
                    <strong>{comp.name}</strong>
                    <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', backgroundColor: comp.component_type === 'earning' ? '#dcfce7' : '#fee2e2', color: comp.component_type === 'earning' ? '#15803d' : '#b91c1c' }}>
                      {comp.component_type.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ marginTop: '10px', fontSize: '13px', color: '#4b5563' }}>
                    <p>Code: <code>{comp.code}</code></p>
                    <p>Calculation: {comp.calc_type}</p>
                    <p>Default Amount: ${Number(comp.default_amount).toFixed(2)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Modal: Generate Pay Run */}
      {showRunModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h3>Generate Automated Batch Pay Run</h3>
            <form onSubmit={handleCreatePayRun} style={{ marginTop: '15px' }}>
              <div style={styles.formGroup}>
                <label>Period Label (e.g. 2026-08):</label>
                <input style={styles.input} type="text" value={newRunForm.period_label} onChange={(e) => setNewRunForm({ ...newRunForm, period_label: e.target.value })} required />
              </div>
              <div style={styles.formGroup}>
                <label>Start Date:</label>
                <input style={styles.input} type="date" value={newRunForm.period_start} onChange={(e) => setNewRunForm({ ...newRunForm, period_start: e.target.value })} required />
              </div>
              <div style={styles.formGroup}>
                <label>End Date:</label>
                <input style={styles.input} type="date" value={newRunForm.period_end} onChange={(e) => setNewRunForm({ ...newRunForm, period_end: e.target.value })} required />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button type="button" style={styles.secondaryBtn} onClick={() => setShowRunModal(false)}>Cancel</button>
                <button type="submit" style={styles.actionBtn}>Run Salary Calculation Engine</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Add Compensation */}
      {showCompModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h3>Setup Employee Compensation</h3>
            <form onSubmit={handleSaveCompensation} style={{ marginTop: '15px' }}>
              <div style={styles.formGroup}>
                <label>Employee Email:</label>
                <input style={styles.input} type="email" value={compForm.email} onChange={(e) => setCompForm({ ...compForm, email: e.target.value })} required placeholder="employee@company.com" />
              </div>
              <div style={styles.formGroup}>
                <label>Pay Type:</label>
                <select style={styles.input} value={compForm.pay_type} onChange={(e) => setCompForm({ ...compForm, pay_type: e.target.value })}>
                  <option value="salaried">Salaried (Fixed Monthly + LOP)</option>
                  <option value="hourly">Hourly</option>
                </select>
              </div>
              <div style={styles.formGroup}>
                <label>Base Monthly Amount (USD):</label>
                <input style={styles.input} type="number" value={compForm.base_amount} onChange={(e) => setCompForm({ ...compForm, base_amount: Number(e.target.value), annual_ctc: Number(e.target.value) * 12 })} required />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button type="button" style={styles.secondaryBtn} onClick={() => setShowCompModal(false)}>Cancel</button>
                <button type="submit" style={styles.actionBtn}>Save Compensation</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Inline Styles Object
const styles = {
  container: { padding: '24px', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#f8fafc', minHeight: '100vh' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' },
  title: { margin: 0, fontSize: '24px', fontWeight: '700', color: '#0f172a' },
  subtitle: { margin: '4px 0 0 0', fontSize: '14px', color: '#64748b' },
  userBadge: { padding: '8px 14px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '13px' },
  alert: { padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontWeight: '500' },
  tabsContainer: { display: 'flex', gap: '8px', borderBottom: '2px solid #e2e8f0', marginBottom: '24px' },
  tab: { padding: '10px 18px', border: 'none', background: 'none', fontSize: '14px', fontWeight: '600', color: '#64748b', cursor: 'pointer' },
  activeTab: { padding: '10px 18px', border: 'none', background: 'none', fontSize: '14px', fontWeight: '600', color: '#2563eb', borderBottom: '3px solid #2563eb', cursor: 'pointer' },
  loading: { padding: '30px', textAlign: 'center', color: '#64748b' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' },
  card: { backgroundColor: '#ffffff', borderRadius: '12px', padding: '20px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  periodTag: { fontSize: '16px', fontWeight: '700', color: '#1e293b' },
  cardBody: { fontSize: '14px', color: '#334155' },
  statRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0' },
  divider: { margin: '12px 0', border: 'none', borderTop: '1px dashed #e2e8f0' },
  netPayRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', marginTop: '6px', backgroundColor: '#eff6ff', borderRadius: '6px', paddingLeft: '10px', paddingRight: '10px' },
  netPayAmount: { fontSize: '18px', color: '#1d4ed8' },
  pdfBtn: { width: '100%', marginTop: '14px', padding: '10px', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontWeight: '600', cursor: 'pointer' },
  actionBtn: { padding: '10px 18px', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' },
  secondaryBtn: { padding: '10px 18px', backgroundColor: '#f1f5f9', color: '#334155', border: 'none', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse', backgroundColor: '#ffffff', borderRadius: '10px', overflow: 'hidden', border: '1px solid #e2e8f0' },
  tableHeadRow: { backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' },
  tableRow: { borderBottom: '1px solid #f1f5f9' },
  statusBadge: (status) => ({
    padding: '4px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '700',
    backgroundColor: status === 'approved' || status === 'active' ? '#dcfce7' : status === 'draft' ? '#fef3c7' : '#f1f5f9',
    color: status === 'approved' || status === 'active' ? '#15803d' : status === 'draft' ? '#b45309' : '#475569'
  }),
  typeBadge: { padding: '3px 8px', backgroundColor: '#e0e7ff', color: '#3730a3', borderRadius: '4px', fontSize: '11px', fontWeight: '700' },
  smallApproveBtn: { padding: '6px 12px', backgroundColor: '#16a34a', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' },
  smallExportBtn: { padding: '6px 12px', backgroundColor: '#0284c7', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' },
  emptyState: { padding: '40px', backgroundColor: '#ffffff', borderRadius: '12px', textAlign: 'center', color: '#64748b', border: '1px solid #e2e8f0' },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15, 23, 42, 0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
  modal: { backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', width: '450px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' },
  formGroup: { marginBottom: '14px' },
  input: { width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', marginTop: '4px', fontSize: '14px' }
};

export default PayrollDashboard;
