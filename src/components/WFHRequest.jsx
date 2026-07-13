/**
 * HRMS Attendance Module - WFH Request Management
 * Handles work-from-home requests and approvals
 */

import React, { useState, useEffect } from 'react';

const WFHRequestComponent = () => {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState([]);
  const [showForm, setShowForm] = useState(false);

  const getEmployeeEmail = () => {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  };

  const getToken = () => {
    return localStorage.getItem('auth_token');
  };

  // Fetch WFH requests
  const fetchRequests = async () => {
    try {
      const token = getToken();
      const email = getEmployeeEmail();

      const response = await fetch(
        `http://localhost:8000/api/attendance/wfh/?email=${email}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setRequests(data);
      }
    } catch (error) {
      console.error('Error fetching requests:', error);
    }
  };

  // Submit WFH request
  const handleSubmitRequest = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const token = getToken();
      const payload = {
        email: getEmployeeEmail(),
        fromDate: fromDate,
        toDate: toDate,
        reason: reason
      };

      const response = await fetch('http://localhost:8000/api/attendance/wfh/submit/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        setMessage('✓ WFH request submitted successfully');
        setFromDate('');
        setToDate('');
        setReason('');
        setShowForm(false);
        fetchRequests();

        if (window.showNotification) {
          window.showNotification({
            title: 'WFH Request Submitted',
            message: `Request for ${fromDate} to ${toDate} submitted`,
            type: 'success'
          });
        }
      } else {
        setMessage(`✗ ${data.error || 'Failed to submit request'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Approve WFH request (for managers)
  const handleApprove = async (requestId) => {
    try {
      const token = getToken();

      const response = await fetch('http://localhost:8000/api/attendance/wfh/approve/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId: requestId })
      });

      if (response.ok) {
        setMessage('✓ Request approved');
        fetchRequests();
      } else {
        setMessage('✗ Failed to approve');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Reject WFH request (for managers)
  const handleReject = async (requestId) => {
    try {
      const token = getToken();

      const response = await fetch('http://localhost:8000/api/attendance/wfh/reject/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId: requestId })
      });

      if (response.ok) {
        setMessage('✓ Request rejected');
        fetchRequests();
      } else {
        setMessage('✗ Failed to reject');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Load requests on mount
  useEffect(() => {
    fetchRequests();
  }, []);

  const getStatusColor = (status) => {
    switch (status) {
      case 'Approved':
        return 'success';
      case 'Pending':
        return 'pending';
      case 'Rejected':
        return 'error';
      default:
        return 'default';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'Approved':
        return '✓';
      case 'Pending':
        return '⏳';
      case 'Rejected':
        return '✗';
      default:
        return '—';
    }
  };

  return (
    <div className="wfh-request-container">
      <div className="wfh-header">
        <h1>Work From Home Requests</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn btn-primary"
        >
          {showForm ? '✕ Cancel' : '+ New Request'}
        </button>
      </div>

      {showForm && (
        <div className="wfh-form-card">
          <h2>Submit WFH Request</h2>
          <form onSubmit={handleSubmitRequest}>
            <div className="form-group">
              <label htmlFor="fromDate">From Date</label>
              <input
                type="date"
                id="fromDate"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="toDate">To Date</label>
              <input
                type="date"
                id="toDate"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="reason">Reason</label>
              <textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter reason for WFH request"
                rows="4"
              ></textarea>
            </div>

            <div className="form-actions">
              <button
                type="submit"
                disabled={loading}
                className="btn btn-submit"
              >
                {loading ? 'Submitting...' : '✓ Submit Request'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="btn btn-cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {message && (
        <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}

      <div className="wfh-requests-list">
        <h2>Your Requests</h2>
        {requests.length === 0 ? (
          <div className="empty-state">
            <p>No WFH requests yet</p>
            <small>Click "New Request" to submit one</small>
          </div>
        ) : (
          <div className="requests-grid">
            {requests.map(req => (
              <div key={req.id} className="request-card">
                <div className="request-header">
                  <div>
                    <div className="dates">
                      {req.fromDate} to {req.toDate}
                    </div>
                    <div className="days-count">
                      {Math.ceil((new Date(req.toDate) - new Date(req.fromDate)) / (1000 * 60 * 60 * 24)) + 1} day(s)
                    </div>
                  </div>
                  <div className={`status-badge ${getStatusColor(req.status)}`}>
                    <span className="icon">{getStatusIcon(req.status)}</span>
                    {req.status}
                  </div>
                </div>

                <div className="request-body">
                  <p className="reason">{req.reason}</p>
                  {req.submittedAt && (
                    <small className="submitted-date">
                      Submitted: {new Date(req.submittedAt).toLocaleDateString()}
                    </small>
                  )}
                  {req.approver && (
                    <small className="approver">
                      Approver: {req.approver}
                    </small>
                  )}
                </div>

                {req.status === 'Pending' && (
                  <div className="request-actions">
                    <button
                      onClick={() => handleApprove(req.id)}
                      className="btn btn-approve"
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => handleReject(req.id)}
                      className="btn btn-reject"
                    >
                      ✗ Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <style jsx>{`
        .wfh-request-container {
          max-width: 1000px;
          margin: 0 auto;
          padding: 20px;
        }

        .wfh-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
        }

        .wfh-header h1 {
          font-size: 28px;
          font-weight: 700;
          margin: 0;
          color: #111827;
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          font-size: 14px;
        }

        .btn-primary {
          background: #3b82f6;
          color: white;
        }

        .btn-primary:hover {
          background: #2563eb;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }

        .wfh-form-card {
          background: white;
          border-radius: 12px;
          padding: 30px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          margin-bottom: 30px;
        }

        .wfh-form-card h2 {
          margin: 0 0 20px 0;
          font-size: 20px;
          font-weight: 600;
          color: #333;
        }

        .form-group {
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          font-weight: 600;
          margin-bottom: 8px;
          color: #333;
          font-size: 14px;
        }

        .form-group input,
        .form-group textarea {
          width: 100%;
          padding: 12px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 14px;
          font-family: inherit;
        }

        .form-group input:focus,
        .form-group textarea:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .form-actions {
          display: flex;
          gap: 12px;
          margin-top: 24px;
        }

        .btn-submit {
          flex: 1;
          background: #10b981;
          color: white;
        }

        .btn-submit:hover {
          background: #059669;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .btn-cancel {
          flex: 1;
          background: #e5e7eb;
          color: #333;
        }

        .btn-cancel:hover {
          background: #d1d5db;
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

        .wfh-requests-list {
          margin-top: 40px;
        }

        .wfh-requests-list h2 {
          font-size: 20px;
          font-weight: 600;
          margin: 0 0 20px 0;
          color: #333;
        }

        .empty-state {
          text-align: center;
          padding: 60px 20px;
          background: #f9fafb;
          border-radius: 12px;
        }

        .empty-state p {
          font-size: 16px;
          color: #666;
          margin: 0;
        }

        .empty-state small {
          display: block;
          color: #999;
          margin-top: 8px;
        }

        .requests-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }

        .request-card {
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .request-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 16px rgba(0, 0, 0, 0.15);
        }

        .request-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 16px;
          background: #f9fafb;
          border-bottom: 1px solid #e5e7eb;
        }

        .dates {
          font-weight: 600;
          color: #333;
          font-size: 14px;
        }

        .days-count {
          font-size: 12px;
          color: #666;
          margin-top: 4px;
        }

        .status-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
        }

        .status-badge.success {
          background: #dcfce7;
          color: #166534;
        }

        .status-badge.pending {
          background: #fef3c7;
          color: #92400e;
        }

        .status-badge.error {
          background: #fee2e2;
          color: #991b1b;
        }

        .status-badge .icon {
          font-size: 14px;
        }

        .request-body {
          padding: 16px;
        }

        .reason {
          font-size: 13px;
          color: #666;
          line-height: 1.5;
          margin: 0 0 12px 0;
        }

        .submitted-date,
        .approver {
          display: block;
          font-size: 11px;
          color: #999;
          margin-bottom: 4px;
        }

        .request-actions {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid #e5e7eb;
          background: #f9fafb;
        }

        .btn-approve,
        .btn-reject {
          flex: 1;
          padding: 8px 12px;
          font-size: 12px;
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

        @media (max-width: 600px) {
          .wfh-header {
            flex-direction: column;
            gap: 16px;
          }

          .requests-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
};

export default WFHRequestComponent;
