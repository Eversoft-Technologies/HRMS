/**
 * HRMS Attendance Module - Notification Center
 * Displays system notifications and alerts
 */

import React, { useState, useEffect } from 'react';

const NotificationCenter = () => {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showPanel, setShowPanel] = useState(false);
  const [loading, setLoading] = useState(false);

  const getEmployeeEmail = () => {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  };

  const getToken = () => {
    return localStorage.getItem('auth_token');
  };

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      setLoading(true);
      const token = getToken();
      const email = getEmployeeEmail();

      const response = await fetch(
        `http://localhost:8000/api/notifications/?email=${email}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        setNotifications(data);
        const unread = data.filter(n => !n.isRead).length;
        setUnreadCount(unread);
      }
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  // Mark notification as read
  const handleMarkAsRead = async (notificationId) => {
    try {
      const token = getToken();
      const response = await fetch(
        `http://localhost:8000/api/notifications/${notificationId}/mark-read/`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        fetchNotifications();
      }
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  };

  // Mark all as read
  const handleMarkAllAsRead = async () => {
    try {
      const token = getToken();
      const response = await fetch(
        'http://localhost:8000/api/notifications/mark-all-read/',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        fetchNotifications();
      }
    } catch (error) {
      console.error('Error marking all as read:', error);
    }
  };

  // Delete notification
  const handleDelete = async (notificationId) => {
    try {
      const token = getToken();
      const response = await fetch(
        `http://localhost:8000/api/notifications/${notificationId}/`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Token ${token}`
          }
        }
      );

      if (response.ok) {
        fetchNotifications();
      }
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  };

  // Clear all notifications
  const handleClearAll = async () => {
    if (confirm('Clear all notifications?')) {
      const token = getToken();
      for (const notif of notifications) {
        try {
          await fetch(
            `http://localhost:8000/api/notifications/${notif.id}/`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': `Token ${token}`
              }
            }
          );
        } catch (error) {
          console.error('Error deleting notification:', error);
        }
      }
      fetchNotifications();
    }
  };

  // Load notifications on mount and setup polling
  useEffect(() => {
    fetchNotifications();

    // Poll for new notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000);

    return () => clearInterval(interval);
  }, []);

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'check_in':
        return '📍';
      case 'check_out':
        return '🚪';
      case 'break':
        return '☕';
      case 'overtime':
        return '⏱️';
      case 'wfh':
        return '🏠';
      case 'approval':
        return '✓';
      case 'alert':
        return '⚠️';
      case 'error':
        return '❌';
      default:
        return '🔔';
    }
  };

  const getNotificationType = (type) => {
    switch (type) {
      case 'check_in':
        return 'Check-In';
      case 'check_out':
        return 'Check-Out';
      case 'break':
        return 'Break';
      case 'overtime':
        return 'Overtime';
      case 'wfh':
        return 'WFH';
      case 'approval':
        return 'Approval';
      case 'alert':
        return 'Alert';
      case 'error':
        return 'Error';
      default:
        return 'Notification';
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="notification-center">
      {/* Bell Icon */}
      <button
        className={`bell-icon ${unreadCount > 0 ? 'has-unread' : ''}`}
        onClick={() => setShowPanel(!showPanel)}
        title={`${unreadCount} unread notifications`}
      >
        🔔
        {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
      </button>

      {/* Notification Panel */}
      {showPanel && (
        <div className="notification-panel">
          <div className="panel-header">
            <h3>Notifications</h3>
            <div className="panel-actions">
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllAsRead}
                  className="action-btn"
                  title="Mark all as read"
                >
                  ✓ Read All
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="action-btn danger"
                  title="Clear all notifications"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="panel-content">
            {loading ? (
              <div className="loading-state">Loading notifications...</div>
            ) : notifications.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🎉</div>
                <p>All caught up!</p>
                <small>No notifications</small>
              </div>
            ) : (
              <div className="notifications-list">
                {notifications.map(notif => (
                  <div
                    key={notif.id}
                    className={`notification-item ${notif.isRead ? 'read' : 'unread'}`}
                  >
                    <div className="notification-icon">
                      {getNotificationIcon(notif.type)}
                    </div>

                    <div className="notification-content">
                      <div className="notification-header">
                        <h4>{notif.title}</h4>
                        <small className="time">
                          {formatTime(notif.createdAt)}
                        </small>
                      </div>
                      <p className="notification-message">{notif.message}</p>
                      <small className="notification-type">
                        {getNotificationType(notif.type)}
                      </small>
                    </div>

                    <div className="notification-actions">
                      {!notif.isRead && (
                        <button
                          onClick={() => handleMarkAsRead(notif.id)}
                          className="action-icon"
                          title="Mark as read"
                        >
                          ○
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(notif.id)}
                        className="action-icon delete"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {notifications.length > 0 && (
            <div className="panel-footer">
              <small>Showing {notifications.length} notification(s)</small>
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .notification-center {
          position: relative;
        }

        .bell-icon {
          position: relative;
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          padding: 8px;
          border-radius: 8px;
          transition: all 0.3s ease;
        }

        .bell-icon:hover {
          background: #f3f4f6;
        }

        .bell-icon.has-unread {
          animation: ring 0.5s ease-in-out;
        }

        @keyframes ring {
          0%, 100% {
            transform: rotate(0deg);
          }
          25% {
            transform: rotate(-10deg);
          }
          75% {
            transform: rotate(10deg);
          }
        }

        .badge {
          position: absolute;
          top: 0;
          right: 0;
          background: #ef4444;
          color: white;
          font-size: 11px;
          font-weight: 700;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid white;
        }

        .notification-panel {
          position: absolute;
          right: 0;
          top: 100%;
          margin-top: 8px;
          width: 380px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
          z-index: 1000;
          max-height: 600px;
          display: flex;
          flex-direction: column;
        }

        .panel-header {
          padding: 16px;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .panel-header h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: #111827;
        }

        .panel-actions {
          display: flex;
          gap: 8px;
        }

        .action-btn {
          padding: 6px 10px;
          border: none;
          background: #e5e7eb;
          color: #333;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .action-btn:hover {
          background: #d1d5db;
        }

        .action-btn.danger {
          background: #fee2e2;
          color: #991b1b;
        }

        .action-btn.danger:hover {
          background: #fecaca;
        }

        .panel-content {
          flex: 1;
          overflow-y: auto;
          padding: 0;
        }

        .loading-state,
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          text-align: center;
          color: #999;
          font-size: 14px;
        }

        .empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
        }

        .empty-state p {
          margin: 0;
          font-weight: 600;
          color: #666;
        }

        .empty-state small {
          display: block;
          margin-top: 4px;
          color: #999;
        }

        .notifications-list {
          display: flex;
          flex-direction: column;
        }

        .notification-item {
          display: flex;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid #f3f4f6;
          transition: all 0.3s ease;
          background: white;
        }

        .notification-item:hover {
          background: #f9fafb;
        }

        .notification-item.unread {
          background: #eff6ff;
        }

        .notification-item.unread::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          background: #3b82f6;
        }

        .notification-icon {
          font-size: 20px;
          flex-shrink: 0;
        }

        .notification-content {
          flex: 1;
          min-width: 0;
        }

        .notification-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 4px;
        }

        .notification-header h4 {
          margin: 0;
          font-size: 13px;
          font-weight: 600;
          color: #111827;
        }

        .time {
          font-size: 11px;
          color: #999;
          flex-shrink: 0;
          margin-left: 8px;
        }

        .notification-message {
          margin: 0 0 6px 0;
          font-size: 12px;
          color: #666;
          line-height: 1.4;
        }

        .notification-type {
          display: inline-block;
          font-size: 10px;
          font-weight: 600;
          color: #999;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .notification-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        .action-icon {
          background: none;
          border: none;
          color: #d1d5db;
          cursor: pointer;
          font-size: 16px;
          padding: 4px;
          border-radius: 4px;
          transition: all 0.3s ease;
        }

        .action-icon:hover {
          color: #9ca3af;
          background: #f3f4f6;
        }

        .action-icon.delete:hover {
          color: #ef4444;
        }

        .panel-footer {
          padding: 12px 16px;
          border-top: 1px solid #e5e7eb;
          text-align: center;
          font-size: 11px;
          color: #999;
          background: #f9fafb;
        }

        /* Scrollbar styling */
        .panel-content::-webkit-scrollbar {
          width: 6px;
        }

        .panel-content::-webkit-scrollbar-track {
          background: #f3f4f6;
        }

        .panel-content::-webkit-scrollbar-thumb {
          background: #d1d5db;
          border-radius: 3px;
        }

        .panel-content::-webkit-scrollbar-thumb:hover {
          background: #9ca3af;
        }

        @media (max-width: 600px) {
          .notification-panel {
            width: 320px;
          }
        }

        @media (max-width: 400px) {
          .notification-panel {
            width: 280px;
          }

          .panel-header {
            padding: 12px;
          }

          .notification-item {
            padding: 10px 12px;
          }
        }
      `}</style>
    </div>
  );
};

export default NotificationCenter;
