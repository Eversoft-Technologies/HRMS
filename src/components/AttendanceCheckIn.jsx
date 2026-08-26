/**
 * HRMS Attendance Module - Check-In/Check-Out Component
 * Handles employee check-in with GPS location validation
 */

import React, { useState, useEffect } from 'react';

const CheckInComponent = () => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [location, setLocation] = useState(null);
  const [isCheckedIn, setIsCheckedIn] = useState(false);
  const [todayAttendance, setTodayAttendance] = useState(null);

  // Get employee email from local storage or context
  const getEmployeeEmail = () => {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  };

  const getEmployeeName = () => {
    return localStorage.getItem('employee_name') || 'Employee';
  };

  const formatAttendanceTime = (value) => {
    if (!value) return '';
    const parts = String(value).split(':');
    if (parts.length < 2) return String(value);
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return String(value);
    const display = new Date(2000, 0, 1, hours, minutes);
    return display.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  // Get current location
  const getLocation = () => {
    return new Promise((resolve, reject) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude
            });
          },
          (error) => {
            console.error('Geolocation error:', error);
            // Fallback coordinates (can be customized)
            resolve({
              latitude: 28.5355,
              longitude: 77.3910
            });
          }
        );
      } else {
        reject('Geolocation not supported');
      }
    });
  };

  // Check if already checked in today
  const checkTodayStatus = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const email = getEmployeeEmail();
      
      const response = await fetch(
        `http://localhost:8000/api/attendance/today/?email=${email}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setTodayAttendance(data);
        setIsCheckedIn(data.checkInTime ? true : false);
      }
    } catch (error) {
      console.error('Error fetching today status:', error);
    }
  };

  // Handle Check-In
  const handleCheckIn = async () => {
    setLoading(true);
    setMessage('');

    try {
      const loc = await getLocation();
      setLocation(loc);

      const token = localStorage.getItem('auth_token');
      const payload = {
        email: getEmployeeEmail(),
        employeeName: getEmployeeName(),
        latitude: loc.latitude,
        longitude: loc.longitude,
        device: 'web'
      };

      const response = await fetch('http://localhost:8000/api/attendance/check-in/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        setStatus(data.status);
        setMessage(`✓ ${data.message}`);
        setIsCheckedIn(true);
        checkTodayStatus();

        // Show success notification
        if (window.showNotification) {
          window.showNotification({
            title: 'Check-In Successful',
            message: data.message,
            type: 'success'
          });
        }
      } else {
        setMessage(`✗ ${data.error || 'Check-in failed'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Handle Check-Out
  const handleCheckOut = async () => {
    setLoading(true);
    setMessage('');

    try {
      const loc = await getLocation();
      const token = localStorage.getItem('auth_token');

      const payload = {
        email: getEmployeeEmail(),
        employeeName: getEmployeeName(),
        latitude: loc.latitude,
        longitude: loc.longitude,
        device: 'web'
      };

      const response = await fetch('http://localhost:8000/api/attendance/check-out/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(`✓ ${data.message}`);
        setIsCheckedIn(false);
        checkTodayStatus();

        if (window.showNotification) {
          window.showNotification({
            title: 'Check-Out Successful',
            message: `Worked ${Math.floor(data.worked_minutes / 60)}h ${data.worked_minutes % 60}m`,
            type: 'success'
          });
        }
      } else {
        setMessage(`✗ ${data.error || 'Check-out failed'}`);
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Update current time
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    checkTodayStatus();

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="attendance-checkin-container">
      <div className="checkin-card">
        <h2>Daily Check-In/Out</h2>
        
        <div className="time-display">
          <div className="current-time">
            {currentTime.toLocaleTimeString()}
          </div>
          <div className="current-date">
            {currentTime.toLocaleDateString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}
          </div>
        </div>

        <div className="attendance-status">
          {todayAttendance && (
            <>
              <div className="status-badge" data-status={status || todayAttendance.status}>
                {status || todayAttendance.status}
              </div>
              <div className="status-details">
                {todayAttendance.checkInTime && (
                  <p>Check-In: {formatAttendanceTime(todayAttendance.checkInTime)}</p>
                )}
                {todayAttendance.checkOutTime && (
                  <p>Check-Out: {formatAttendanceTime(todayAttendance.checkOutTime)}</p>
                )}
                {todayAttendance.workedMinutes && (
                  <p>Worked: {Math.floor(todayAttendance.workedMinutes / 60)}h {todayAttendance.workedMinutes % 60}m</p>
                )}
              </div>
            </>
          )}
        </div>

        {location && (
          <div className="location-info">
            <small>📍 Location: {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}</small>
          </div>
        )}

        {message && (
          <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
            {message}
          </div>
        )}

        <div className="button-group">
          <button
            onClick={handleCheckIn}
            disabled={loading || isCheckedIn}
            className="btn btn-check-in"
          >
            {loading ? 'Processing...' : '✓ Check In'}
          </button>
          <button
            onClick={handleCheckOut}
            disabled={loading || !isCheckedIn}
            className="btn btn-check-out"
          >
            {loading ? 'Processing...' : '✗ Check Out'}
          </button>
        </div>
      </div>

      <style jsx>{`
        .attendance-checkin-container {
          max-width: 600px;
          margin: 20px auto;
          padding: 20px;
        }

        .checkin-card {
          background: white;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          padding: 30px;
          text-align: center;
        }

        .checkin-card h2 {
          margin: 0 0 20px 0;
          font-size: 24px;
          font-weight: 600;
          color: #333;
        }

        .time-display {
          margin: 20px 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          border-radius: 8px;
        }

        .current-time {
          font-size: 48px;
          font-weight: 700;
          margin-bottom: 10px;
          font-family: 'Courier New', monospace;
        }

        .current-date {
          font-size: 14px;
          opacity: 0.9;
        }

        .attendance-status {
          margin: 20px 0;
        }

        .status-badge {
          display: inline-block;
          padding: 8px 16px;
          border-radius: 20px;
          font-weight: 600;
          text-transform: uppercase;
          font-size: 12px;
          margin-bottom: 10px;
        }

        .status-badge[data-status="on_time"] {
          background: #10b981;
          color: white;
        }

        .status-badge[data-status="late"] {
          background: #f59e0b;
          color: white;
        }

        .status-badge[data-status="absent"] {
          background: #ef4444;
          color: white;
        }

        .status-badge[data-status="present"] {
          background: #10b981;
          color: white;
        }

        .status-details {
          font-size: 14px;
          color: #666;
          margin-top: 10px;
        }

        .status-details p {
          margin: 5px 0;
        }

        .location-info {
          margin: 15px 0;
          padding: 10px;
          background: #f3f4f6;
          border-radius: 6px;
          font-size: 12px;
          color: #666;
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

        .button-group {
          display: flex;
          gap: 12px;
          margin-top: 20px;
        }

        .btn {
          flex: 1;
          padding: 12px 20px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .btn-check-in {
          background: #10b981;
          color: white;
        }

        .btn-check-in:hover:not(:disabled) {
          background: #059669;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .btn-check-in:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }

        .btn-check-out {
          background: #ef4444;
          color: white;
        }

        .btn-check-out:hover:not(:disabled) {
          background: #dc2626;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        }

        .btn-check-out:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }

        @media (max-width: 600px) {
          .checkin-card {
            padding: 20px;
          }

          .current-time {
            font-size: 36px;
          }

          .button-group {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
};

export default CheckInComponent;
