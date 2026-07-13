/**
 * HRMS Attendance Module - Manager Dashboard
 * For managers to view team attendance and manage approvals
 */

import React, { useState, useEffect } from 'react';

const ManagerDashboard = () => {
  const [teamAttendance, setTeamAttendance] = useState([]);
  const [pendingCorrections, setPendingCorrections] = useState([]);
  const [lateAlerts, setLateAlerts] = useState([]);
  const [activeTab, setActiveTab] = useState('attendance'); // attendance, corrections, alerts
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  const getToken = () => {
    return localStorage.getItem('auth_token');
  };

  // Fetch team attendance
  const fetchTeamAttendance = async () => {
    try {
      const token = getToken();
      const response = await fetch(
        `http://localhost:8000/api/attendance/team/?date=${selectedDate}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setTeamAttendance(data);
      }
    } catch (error) {
      console.error('Error fetching team attendance:', error);
    }
  };

  // Fetch pending corrections
  const fetchPendingCorrections = async () => {
    try {
      const token = getToken();
      const response = await fetch(
        'http://localhost:8000/api/attendance/correction/pending/',
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setPendingCorrections(data);
      }
    } catch (error) {
      console.error('Error fetching corrections:', error);
    }
  };

  // Fetch late alerts
  const fetchLateAlerts = async () => {
    try {
      const token = getToken();
      const response = await fetch(
        `http://localhost:8000/api/attendance/late-alerts/?date=${selectedDate}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setLateAlerts(data);
      }
    } catch (error) {
      console.error('Error fetching late alerts:', error);
    }
  };

  // Approve correction
  const handleApproveCorrection = async (correctionId) => {
    try {
      const token = getToken();
      const response = await fetch(
        'http://localhost:8000/api/attendance/correction/approve/',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            correctionId: correctionId,
            reviewerNote: 'Approved'
          })
        }
      );

      if (response.ok) {
        setMessage('✓ Correction approved');
        fetchPendingCorrections();
      } else {
        setMessage('✗ Failed to approve');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Reject correction
  const handleRejectCorrection = async (correctionId) => {
    try {
      const token = getToken();
      const response = await fetch(
        'http://localhost:8000/api/attendance/correction/reject/',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            correctionId: correctionId,
            reviewerNote: 'Rejected'
          })
        }
      );

      if (response.ok) {
        setMessage('✓ Correction rejected');
        fetchPendingCorrections();
      } else {
        setMessage('✗ Failed to reject');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Excuse late arrival
  const handleExcuseLate = async (alertId) => {
    try {
      const token = getToken();
      const response = await fetch(
        'http://localhost:8000/api/attendance/late-alerts/excuse/',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            alertId: alertId,
            excusedBy: localStorage.getItem('manager_email') || 'manager@company.com'
          })
        }
      );

      if (response.ok) {
        setMessage('✓ Late arrival excused');
        fetchLateAlerts();
      } else {
        setMessage('✗ Failed to excuse');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Load data
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchTeamAttendance(),
      fetchPendingCorrections(),
      fetchLateAlerts()
    ]).finally(() => setLoading(false));
  }, [selectedDate]);

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  return (
    <div className="manager-dashboard-container">
      <h1>Manager Dashboard</h1>

      <div className="dashboard-controls">
        <div className="date-picker">
          <label>Select Date:</label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
        </div>
      </div>

      <div className="tab-navigation">
        <button
          className={`tab-btn ${activeTab === 'attendance' ? 'active' : ''}`}
          onClick={() => setActiveTab('attendance')}
        >
          Attendance ({teamAttendance.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'corrections' ? 'active' : ''}`}
          onClick={() => setActiveTab('corrections')}
        >
          Pending Corrections ({pendingCorrections.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'alerts' ? 'active' : ''}`}
          onClick={() => setActiveTab('alerts')}
        >
          Late Alerts ({lateAlerts.length})
        </button>
      </div>

      {message && (
        <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}

      {/* Team Attendance Tab */}
      {activeTab === 'attendance' && (
        <div className="tab-content">
          {teamAttendance.length === 0 ? (
            <div className="empty-state">No attendance records for this date</div>
          ) : (
            <table className="attendance-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Email</th>
                  <th>Check-In</th>
                  <th>Check-Out</th>
                  <th>Status</th>
                  <th>Worked</th>
                  <th>OT</th>
                </tr>
              </thead>
              <tbody>
                {teamAttendance.map(att => (
                  <tr key={att.id}>
                    <td className="employee-name">{att.employeeName}</td>
                    <td className="email">{att.email}</td>
                    <td>
                      {att.checkInTime
                        ? new Date(att.checkInTime).toLocaleTimeString()
                        : '-'}
                    </td>
                    <td>
                      {att.checkOutTime
                        ? new Date(att.checkOutTime).toLocaleTimeString()
                        : '-'}
                    </td>
                    <td>
                      <span className={`status-badge ${att.status}`}>
                        {att.status}
                      </span>
                    </td>
                    <td>
                      {att.workedMinutes
                        ? `${Math.floor(att.workedMinutes / 60)}h ${att.workedMinutes % 60}m`
                        : '-'}
                    </td>
                    <td>
                      {att.overtimeMinutes
                        ? `${att.overtimeMinutes}m`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Corrections Tab */}
      {activeTab === 'corrections' && (
        <div className="tab-content">
          {pendingCorrections.length === 0 ? (
            <div className="empty-state">No pending corrections</div>
          ) : (
            <div className="corrections-grid">
              {pendingCorrections.map(corr => (
                <div key={corr.id} className="correction-card">
                  <div className="correction-header">
                    <div>
                      <div className="employee-info">
                        <strong>{corr.employeeName}</strong>
                        <small>{corr.email}</small>
                      </div>
                      <div className="date-info">
                        {new Date(corr.attendanceDate).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  <div className="correction-details">
                    <div className="detail-row">
                      <span className="label">Requested Check-In:</span>
                      <span className="value">
                        {new Date(corr.requestedCheckIn).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Requested Check-Out:</span>
                      <span className="value">
                        {new Date(corr.requestedCheckOut).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Reason:</span>
                      <span className="value">{corr.reason}</span>
                    </div>
                  </div>

                  <div className="correction-actions">
                    <button
                      onClick={() => handleApproveCorrection(corr.id)}
                      className="btn btn-approve"
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => handleRejectCorrection(corr.id)}
                      className="btn btn-reject"
                    >
                      ✗ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Late Alerts Tab */}
      {activeTab === 'alerts' && (
        <div className="tab-content">
          {lateAlerts.length === 0 ? (
            <div className="empty-state">No late check-ins</div>
          ) : (
            <div className="alerts-grid">
              {lateAlerts.map(alert => (
                <div key={alert.id} className="alert-card">
                  <div className="alert-header">
                    <div>
                      <div className="employee-info">
                        <strong>{alert.employeeName}</strong>
                        <small>{alert.email}</small>
                      </div>
                    </div>
                    <div className={`late-badge ${alert.isExcused ? 'excused' : ''}`}>
                      {alert.lateMinutes}m late
                    </div>
                  </div>

                  <div className="alert-details">
                    <div className="detail-row">
                      <span className="label">Check-In Time:</span>
                      <span className="value">
                        {new Date(alert.checkInTime).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Shift Start:</span>
                      <span className="value">
                        {new Date(alert.shiftStartTime).toLocaleTimeString()}
                      </span>
                    </div>
                    {alert.reason && (
                      <div className="detail-row">
                        <span className="label">Reason:</span>
                        <span className="value">{alert.reason}</span>
                      </div>
                    )}
                  </div>

                  {!alert.isExcused && (
                    <div className="alert-actions">
                      <button
                        onClick={() => handleExcuseLate(alert.id)}
                        className="btn btn-excuse"
                      >
                        ✓ Excuse
                      </button>
                    </div>
                  )}

                  {alert.isExcused && (
                    <div className="excused-badge">
                      Excused by {alert.excusedBy}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .manager-dashboard-container {
          padding: 20px;
          background: #f9fafb;
          min-height: 100vh;
        }

        .manager-dashboard-container h1 {
          font-size: 28px;
          font-weight: 700;
          margin: 0 0 30px 0;
          color: #111827;
        }

        .dashboard-controls {
          display: flex;
          gap: 20px;
          margin-bottom: 30px;
          background: white;
          padding: 20px;
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .date-picker {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .date-picker label {
          font-weight: 600;
          color: #333;
        }

        .date-picker input {
          padding: 8px 12px;
          border: 1px solid #d1d5db;
          border-radius: 6px;
        }

        .tab-navigation {
          display: flex;
          gap: 12px;
          margin-bottom: 20px;
          background: white;
          padding: 12px;
          border-radius: 12px;
          border-bottom: 2px solid #e5e7eb;
        }

        .tab-btn {
          padding: 10px 16px;
          border: none;
          background: none;
          cursor: pointer;
          font-weight: 600;
          color: #666;
          border-bottom: 3px solid transparent;
          transition: all 0.3s ease;
        }

        .tab-btn:hover {
          color: #333;
        }

        .tab-btn.active {
          color: #3b82f6;
          border-bottom-color: #3b82f6;
        }

        .tab-content {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #999;
          font-size: 16px;
        }

        .attendance-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .attendance-table thead {
          background: #f3f4f6;
          border-bottom: 2px solid #e5e7eb;
        }

        .attendance-table th {
          padding: 12px;
          text-align: left;
          font-weight: 600;
          color: #333;
        }

        .attendance-table td {
          padding: 12px;
          border-bottom: 1px solid #e5e7eb;
        }

        .employee-name {
          font-weight: 600;
          color: #111827;
        }

        .email {
          color: #666;
          font-size: 12px;
        }

        .status-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 600;
          font-size: 11px;
          text-transform: capitalize;
        }

        .status-badge.on_time {
          background: #dcfce7;
          color: #166534;
        }

        .status-badge.late {
          background: #fef3c7;
          color: #92400e;
        }

        .status-badge.absent {
          background: #fee2e2;
          color: #991b1b;
        }

        .corrections-grid,
        .alerts-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }

        .correction-card,
        .alert-card {
          background: #fafbfc;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          overflow: hidden;
          transition: all 0.3s ease;
        }

        .correction-card:hover,
        .alert-card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          transform: translateY(-2px);
        }

        .correction-header,
        .alert-header {
          padding: 12px;
          background: #f3f4f6;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .employee-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .employee-info strong {
          color: #111827;
          font-size: 14px;
        }

        .employee-info small {
          color: #666;
          font-size: 12px;
        }

        .date-info {
          font-size: 12px;
          color: #999;
          margin-top: 6px;
        }

        .late-badge {
          background: #fef3c7;
          color: #92400e;
          padding: 6px 12px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 12px;
        }

        .late-badge.excused {
          background: #dcfce7;
          color: #166534;
        }

        .correction-details,
        .alert-details {
          padding: 12px;
        }

        .detail-row {
          display: flex;
          justify-content: space-between;
          padding: 6px 0;
          font-size: 12px;
          border-bottom: 1px solid #e5e7eb;
        }

        .detail-row:last-child {
          border-bottom: none;
        }

        .detail-row .label {
          font-weight: 600;
          color: #666;
        }

        .detail-row .value {
          color: #111827;
        }

        .correction-actions,
        .alert-actions {
          display: flex;
          gap: 8px;
          padding: 12px;
          background: #f9fafb;
          border-top: 1px solid #e5e7eb;
        }

        .btn {
          flex: 1;
          padding: 8px 12px;
          border: none;
          border-radius: 6px;
          font-weight: 600;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .btn-approve {
          background: #10b981;
          color: white;
        }

        .btn-approve:hover {
          background: #059669;
        }

        .btn-reject {
          background: #ef4444;
          color: white;
        }

        .btn-reject:hover {
          background: #dc2626;
        }

        .btn-excuse {
          background: #3b82f6;
          color: white;
        }

        .btn-excuse:hover {
          background: #2563eb;
        }

        .excused-badge {
          padding: 12px;
          background: #dcfce7;
          color: #166534;
          text-align: center;
          font-size: 12px;
          font-weight: 600;
          border-top: 1px solid #e5e7eb;
        }

        .message {
          margin: 20px 0;
          padding: 12px 16px;
          border-radius: 8px;
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
          .attendance-table {
            font-size: 11px;
          }

          .attendance-table th,
          .attendance-table td {
            padding: 8px;
          }

          .corrections-grid,
          .alerts-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
};

export default ManagerDashboard;
