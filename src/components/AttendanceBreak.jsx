/**
 * HRMS Attendance Module - Break Management Component
 * Handles break start/end and break tracking
 */

import React, { useState, useEffect } from 'react';

const BreakComponent = () => {
  const [breakStatus, setBreakStatus] = useState('idle'); // idle, on_break, completed
  const [breakType, setBreakType] = useState('meal');
  const [breakDuration, setBreakDuration] = useState(0);
  const [todayBreaks, setTodayBreaks] = useState([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [breakStartTime, setBreakStartTime] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const breakTypes = [
    { value: 'meal', label: '🍽️ Meal Break' },
    { value: 'rest', label: '☕ Rest Break' },
    { value: 'personal', label: '👤 Personal' },
    { value: 'medical', label: '🏥 Medical' }
  ];

  const getEmployeeEmail = () => {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  };

  const getEmployeeName = () => {
    return localStorage.getItem('employee_name') || 'Employee';
  };

  // Fetch today's breaks
  const fetchTodayBreaks = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const email = getEmployeeEmail();

      const response = await fetch(
        `http://localhost:8000/api/attendance/breaks/today/?email=${email}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setTodayBreaks(data);
      }
    } catch (error) {
      console.error('Error fetching breaks:', error);
    }
  };

  // Start break
  const handleStartBreak = async () => {
    setLoading(true);
    setMessage('');

    try {
      const token = localStorage.getItem('auth_token');
      const payload = {
        email: getEmployeeEmail(),
        employeeName: getEmployeeName(),
        breakType: breakType,
        reason: ''
      };

      const response = await fetch('http://localhost:8000/api/attendance/break/start/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        setBreakStatus('on_break');
        setBreakStartTime(new Date());
        setMessage(`✓ Break started (${breakType})`);
        localStorage.setItem('current_break_id', data.break_id);
        localStorage.setItem('break_start_time', new Date().toISOString());

        if (window.showNotification) {
          window.showNotification({
            title: 'Break Started',
            message: `${breakType} break started`,
            type: 'info'
          });
        }
      } else {
        setMessage(`✗ ${data.error || 'Failed to start break'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // End break
  const handleEndBreak = async () => {
    setLoading(true);
    setMessage('');

    try {
      const token = localStorage.getItem('auth_token');
      const breakId = localStorage.getItem('current_break_id');

      const payload = {
        email: getEmployeeEmail(),
        breakId: parseInt(breakId)
      };

      const response = await fetch('http://localhost:8000/api/attendance/break/end/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        setBreakStatus('completed');
        setBreakDuration(data.break_minutes);
        setMessage(`✓ Break ended. Duration: ${data.break_minutes}m`);
        localStorage.removeItem('current_break_id');
        localStorage.removeItem('break_start_time');
        
        setTimeout(() => {
          setBreakStatus('idle');
          fetchTodayBreaks();
        }, 2000);

        if (window.showNotification) {
          window.showNotification({
            title: 'Break Ended',
            message: `Break duration: ${data.break_minutes} minutes`,
            type: 'success'
          });
        }
      } else {
        setMessage(`✗ ${data.error || 'Failed to end break'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Track elapsed time during break
  useEffect(() => {
    let timer;
    if (breakStatus === 'on_break' && breakStartTime) {
      timer = setInterval(() => {
        const now = new Date();
        const elapsed = Math.floor((now - breakStartTime) / 1000);
        setElapsedSeconds(elapsed);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [breakStatus, breakStartTime]);

  // Load breaks on mount
  useEffect(() => {
    fetchTodayBreaks();
  }, []);

  const formatTime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="break-management-container">
      <div className="break-card">
        <h2>Break Management</h2>

        {breakStatus === 'idle' && (
          <div className="break-controls">
            <div className="break-type-selector">
              <label>Break Type:</label>
              <div className="break-type-buttons">
                {breakTypes.map(type => (
                  <button
                    key={type.value}
                    onClick={() => setBreakType(type.value)}
                    className={`break-type-btn ${breakType === type.value ? 'active' : ''}`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleStartBreak}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? 'Starting...' : '▶ Start Break'}
            </button>
          </div>
        )}

        {breakStatus === 'on_break' && (
          <div className="break-timer">
            <div className="timer-display">
              {formatTime(elapsedSeconds)}
            </div>
            <p className="break-info">{breakType} Break in Progress</p>
            <button
              onClick={handleEndBreak}
              disabled={loading}
              className="btn btn-danger"
            >
              {loading ? 'Ending...' : '⏹ End Break'}
            </button>
          </div>
        )}

        {message && (
          <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
            {message}
          </div>
        )}

        <div className="today-breaks">
          <h3>Today's Breaks</h3>
          {todayBreaks.length === 0 ? (
            <p className="no-breaks">No breaks yet</p>
          ) : (
            <table className="breaks-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {todayBreaks.map(brk => (
                  <tr key={brk.id}>
                    <td>
                      <span className={`break-badge ${brk.breakType}`}>
                        {brk.breakType}
                      </span>
                    </td>
                    <td>{new Date(brk.breakStart).toLocaleTimeString()}</td>
                    <td>{brk.breakEnd ? new Date(brk.breakEnd).toLocaleTimeString() : '-'}</td>
                    <td>{brk.breakMinutes ? `${brk.breakMinutes}m` : '-'}</td>
                    <td>
                      <span className={`status-badge ${brk.status}`}>
                        {brk.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style jsx>{`
        .break-management-container {
          max-width: 800px;
          margin: 20px auto;
          padding: 20px;
        }

        .break-card {
          background: white;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          padding: 30px;
        }

        .break-card h2 {
          margin: 0 0 20px 0;
          font-size: 24px;
          font-weight: 600;
          color: #333;
        }

        .break-controls {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .break-type-selector label {
          display: block;
          font-weight: 600;
          margin-bottom: 10px;
          color: #333;
        }

        .break-type-buttons {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 8px;
        }

        .break-type-btn {
          padding: 10px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          background: white;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.3s ease;
        }

        .break-type-btn:hover {
          border-color: #3b82f6;
          background: #eff6ff;
        }

        .break-type-btn.active {
          border-color: #3b82f6;
          background: #3b82f6;
          color: white;
        }

        .btn {
          padding: 12px 24px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .btn-primary {
          background: #3b82f6;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #2563eb;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }

        .btn-primary:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }

        .btn-danger {
          background: #ef4444;
          color: white;
          width: 100%;
        }

        .btn-danger:hover:not(:disabled) {
          background: #dc2626;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        }

        .break-timer {
          text-align: center;
          padding: 40px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 8px;
          color: white;
        }

        .timer-display {
          font-size: 72px;
          font-weight: 700;
          font-family: 'Courier New', monospace;
          margin-bottom: 10px;
        }

        .break-info {
          font-size: 16px;
          margin-bottom: 20px;
        }

        .message {
          margin: 15px 0;
          padding: 12px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
        }

        .message.success {
          background: #d1fae5;
          color: #065f46;
          border: 1px solid #6ee7b7;
        }

        .message.error {
          background: #fee2e2;
          color: #991b1b;
          border: 1px solid #fca5a5;
        }

        .today-breaks {
          margin-top: 30px;
          padding-top: 30px;
          border-top: 1px solid #e5e7eb;
        }

        .today-breaks h3 {
          margin: 0 0 15px 0;
          font-size: 16px;
          font-weight: 600;
          color: #333;
        }

        .no-breaks {
          text-align: center;
          color: #999;
          padding: 20px;
        }

        .breaks-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .breaks-table thead {
          background: #f3f4f6;
          border-bottom: 2px solid #e5e7eb;
        }

        .breaks-table th {
          padding: 10px;
          text-align: left;
          font-weight: 600;
          color: #333;
        }

        .breaks-table td {
          padding: 10px;
          border-bottom: 1px solid #e5e7eb;
        }

        .break-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 500;
          font-size: 11px;
        }

        .break-badge.meal {
          background: #fef3c7;
          color: #92400e;
        }

        .break-badge.rest {
          background: #dbeafe;
          color: #0c2340;
        }

        .break-badge.personal {
          background: #e9d5ff;
          color: #5b21b6;
        }

        .break-badge.medical {
          background: #fee2e2;
          color: #991b1b;
        }

        .status-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 500;
          font-size: 11px;
        }

        .status-badge.active {
          background: #dcfce7;
          color: #166534;
        }

        .status-badge.completed {
          background: #dbeafe;
          color: #0c2340;
        }

        @media (max-width: 600px) {
          .break-card {
            padding: 20px;
          }

          .break-type-buttons {
            grid-template-columns: repeat(2, 1fr);
          }

          .timer-display {
            font-size: 48px;
          }

          .breaks-table {
            font-size: 11px;
          }
        }
      `}</style>
    </div>
  );
};

export default BreakComponent;
