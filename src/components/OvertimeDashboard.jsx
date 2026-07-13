/**
 * HRMS Attendance Module - Overtime Dashboard
 * Displays overtime tracking and approval
 */

import React, { useState, useEffect } from 'react';

const OvertimeDashboard = () => {
  const [overtimeData, setOvertimeData] = useState(null);
  const [monthlyOvertime, setMonthlyOvertime] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [message, setMessage] = useState('');

  const getEmployeeEmail = () => {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  };

  const getToken = () => {
    return localStorage.getItem('auth_token');
  };

  // Fetch daily overtime
  const fetchDailyOvertime = async () => {
    try {
      const token = getToken();
      const email = getEmployeeEmail();
      const today = new Date().toISOString().split('T')[0];

      const response = await fetch(
        `http://localhost:8000/api/attendance/overtime/daily/?email=${email}&date=${today}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setOvertimeData(data);
      }
    } catch (error) {
      console.error('Error fetching daily overtime:', error);
    }
  };

  // Fetch monthly overtime summary
  const fetchMonthlyOvertime = async () => {
    try {
      const token = getToken();
      const email = getEmployeeEmail();

      const response = await fetch(
        `http://localhost:8000/api/attendance/overtime/monthly/?email=${email}&period=${period}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setMonthlyOvertime(data);
      }
    } catch (error) {
      console.error('Error fetching monthly overtime:', error);
    }
  };

  // Fetch overtime balance
  const fetchOvertimeBalance = async () => {
    try {
      const token = getToken();
      const email = getEmployeeEmail();

      const response = await fetch(
        `http://localhost:8000/api/attendance/overtime/balance/?email=${email}&period=${period}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setBalance(data);
      }
    } catch (error) {
      console.error('Error fetching overtime balance:', error);
    }
  };

  // Approve overtime
  const handleApproveOvertime = async () => {
    try {
      const token = getToken();
      const email = getEmployeeEmail();
      const today = new Date().toISOString().split('T')[0];

      const response = await fetch(
        'http://localhost:8000/api/attendance/overtime/approve/',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email,
            date: today
          })
        }
      );

      const data = await response.json();
      if (response.ok) {
        setMessage('✓ Overtime approved');
        fetchDailyOvertime();
      } else {
        setMessage(`✗ ${data.error || 'Failed to approve'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Load data
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchDailyOvertime(),
      fetchMonthlyOvertime(),
      fetchOvertimeBalance()
    ]).finally(() => setLoading(false));
  }, [period]);

  if (loading) {
    return <div className="loading">Loading overtime data...</div>;
  }

  return (
    <div className="overtime-dashboard-container">
      <h1>Overtime Tracking</h1>

      <div className="dashboard-grid">
        {/* Daily Overtime Card */}
        <div className="overtime-card">
          <h2>Today's Overtime</h2>
          {overtimeData ? (
            <>
              <div className="metric">
                <span className="label">Worked Hours</span>
                <span className="value">{overtimeData.workedHours}h</span>
              </div>
              <div className="metric">
                <span className="label">Shift Hours</span>
                <span className="value">{overtimeData.shiftHours}h</span>
              </div>
              <div className="metric highlight">
                <span className="label">Overtime Hours</span>
                <span className="value">{overtimeData.overtimeHours}h</span>
              </div>
              <div className="overtime-type">
                Type: <span className="badge">{overtimeData.overtimeType}</span>
              </div>
              <div className="overtime-status">
                Status: <span className={`status-badge ${overtimeData.status}`}>
                  {overtimeData.status}
                </span>
              </div>
              {overtimeData.status === 'calculated' && (
                <button
                  onClick={handleApproveOvertime}
                  className="btn btn-approve"
                >
                  ✓ Request Approval
                </button>
              )}
            </>
          ) : (
            <p>No overtime recorded today</p>
          )}
        </div>

        {/* Monthly Summary Card */}
        <div className="overtime-card">
          <h2>Monthly Overview ({period})</h2>
          {monthlyOvertime ? (
            <>
              <div className="metric">
                <span className="label">Total OT Hours</span>
                <span className="value">{monthlyOvertime.totalOvertimeHours}h</span>
              </div>
              <div className="metric">
                <span className="label">Total Worked</span>
                <span className="value">{monthlyOvertime.totalWorkedHours}h</span>
              </div>
              <div className="metric">
                <span className="label">Records</span>
                <span className="value">{monthlyOvertime.recordCount}</span>
              </div>
              <div className="breakdown">
                <h4>OT Breakdown</h4>
                <ul>
                  {monthlyOvertime.byType && Object.entries(monthlyOvertime.byType).map(([type, hours]) => (
                    <li key={type}>
                      <span>{type}</span>
                      <span className="hours">{hours}h</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p>No data available</p>
          )}
        </div>

        {/* Balance Card */}
        <div className="overtime-card full-width">
          <h2>Overtime Balance ({period})</h2>
          {balance ? (
            <div className="balance-layout">
              <div className="balance-item">
                <div className="balance-title">Total Overtime</div>
                <div className="balance-amount">{balance.totalOvertimeHours}h</div>
              </div>
              <div className="balance-divider">÷</div>
              <div className="balance-item">
                <div className="balance-title">Comp-Off</div>
                <div className="balance-amount comp-off">{balance.compOffHours}h</div>
                <small>Can be used as leave</small>
              </div>
              <div className="balance-item">
                <div className="balance-title">Cash Payout</div>
                <div className="balance-amount cash">{balance.cashPayoutHours}h</div>
                <small>Salary component</small>
              </div>
            </div>
          ) : (
            <p>No balance data</p>
          )}
        </div>
      </div>

      {message && (
        <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}

      <style jsx>{`
        .overtime-dashboard-container {
          padding: 20px;
          background: #f9fafb;
          min-height: 100vh;
        }

        .overtime-dashboard-container h1 {
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 30px;
          color: #111827;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }

        .overtime-card {
          background: white;
          border-radius: 12px;
          padding: 24px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .overtime-card.full-width {
          grid-column: 1 / -1;
        }

        .overtime-card h2 {
          font-size: 18px;
          font-weight: 600;
          margin: 0 0 20px 0;
          color: #333;
        }

        .metric {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 0;
          border-bottom: 1px solid #e5e7eb;
        }

        .metric:last-of-type {
          border-bottom: none;
        }

        .metric.highlight {
          background: #fef3c7;
          padding: 12px 8px;
          border-radius: 6px;
          border-bottom: none;
          margin: 8px 0;
        }

        .metric .label {
          font-size: 13px;
          color: #666;
          font-weight: 500;
        }

        .metric .value {
          font-size: 20px;
          font-weight: 700;
          color: #111827;
        }

        .overtime-type,
        .overtime-status {
          margin: 12px 0;
          font-size: 13px;
          color: #666;
        }

        .badge {
          display: inline-block;
          background: #e0f2fe;
          color: #0369a1;
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
        }

        .status-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 600;
          font-size: 11px;
          text-transform: capitalize;
        }

        .status-badge.calculated {
          background: #fef3c7;
          color: #92400e;
        }

        .status-badge.approved {
          background: #dcfce7;
          color: #166534;
        }

        .status-badge.pending_approval {
          background: #e0e7ff;
          color: #3730a3;
        }

        .breakdown {
          margin-top: 16px;
        }

        .breakdown h4 {
          font-size: 12px;
          font-weight: 600;
          color: #666;
          margin: 0 0 8px 0;
          text-transform: uppercase;
        }

        .breakdown ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .breakdown li {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          font-size: 13px;
          border-bottom: 1px solid #f3f4f6;
        }

        .breakdown li:last-child {
          border-bottom: none;
        }

        .breakdown .hours {
          font-weight: 600;
          color: #111827;
        }

        .balance-layout {
          display: flex;
          justify-content: space-around;
          align-items: center;
          gap: 20px;
          padding: 30px 20px;
        }

        .balance-item {
          flex: 1;
          text-align: center;
        }

        .balance-title {
          font-size: 12px;
          color: #999;
          text-transform: uppercase;
          font-weight: 600;
          margin-bottom: 8px;
        }

        .balance-amount {
          font-size: 36px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 4px;
        }

        .balance-amount.comp-off {
          color: #059669;
        }

        .balance-amount.cash {
          color: #0891b2;
        }

        .balance-divider {
          font-size: 24px;
          color: #d1d5db;
          font-weight: 300;
        }

        .balance-item small {
          font-size: 12px;
          color: #999;
        }

        .btn {
          width: 100%;
          padding: 12px;
          margin-top: 16px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .btn-approve {
          background: #10b981;
          color: white;
        }

        .btn-approve:hover {
          background: #059669;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .message {
          margin-top: 20px;
          padding: 12px 16px;
          border-radius: 8px;
          text-align: center;
          font-weight: 500;
        }

        .message.success {
          background: #d1fae5;
          color: #065f46;
        }

        .message.error {
          background: #fee2e2;
          color: #991b1b;
        }

        .loading {
          padding: 40px;
          text-align: center;
          color: #666;
        }

        @media (max-width: 768px) {
          .dashboard-grid {
            grid-template-columns: 1fr;
          }

          .overtime-card.full-width {
            grid-column: 1;
          }

          .balance-layout {
            flex-direction: column;
            gap: 16px;
          }

          .balance-divider {
            display: none;
          }
        }
      `}</style>
    </div>
  );
};

export default OvertimeDashboard;
