/**
 * HRMS Attendance Module - Admin Dashboard
 * For admins to manage policies, geofences, and system settings
 */

import React, { useState, useEffect } from 'react';

const AdminDashboard = () => {
  const [policies, setPolicies] = useState([]);
  const [geofences, setGeofences] = useState([]);
  const [activeTab, setActiveTab] = useState('policies'); // policies, geofences
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  
  // Policy form state
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policyForm, setPolicyForm] = useState({
    name: '',
    type: 'break', // break, late, overtime, wfh
    maxMinutes: 60,
    minMinutes: 15,
    description: ''
  });

  // Geofence form state
  const [showGeofenceForm, setShowGeofenceForm] = useState(false);
  const [geofenceForm, setGeofenceForm] = useState({
    name: '',
    latitude: '',
    longitude: '',
    radiusMeters: 100,
    description: ''
  });

  const getToken = () => {
    return localStorage.getItem('auth_token');
  };

  // Fetch policies
  const fetchPolicies = async () => {
    try {
      const token = getToken();
      const response = await fetch('http://localhost:8000/api/attendance/policies/', {
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        setPolicies(data);
      }
    } catch (error) {
      console.error('Error fetching policies:', error);
    }
  };

  // Fetch geofences
  const fetchGeofences = async () => {
    try {
      const token = getToken();
      const response = await fetch('http://localhost:8000/api/attendance/geofences/', {
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        setGeofences(data);
      }
    } catch (error) {
      console.error('Error fetching geofences:', error);
    }
  };

  // Create policy
  const handleCreatePolicy = async (e) => {
    e.preventDefault();
    try {
      const token = getToken();
      const response = await fetch('http://localhost:8000/api/attendance/policies/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(policyForm)
      });

      if (response.ok) {
        setMessage('✓ Policy created successfully');
        setPolicyForm({
          name: '',
          type: 'break',
          maxMinutes: 60,
          minMinutes: 15,
          description: ''
        });
        setShowPolicyForm(false);
        fetchPolicies();
      } else {
        setMessage('✗ Failed to create policy');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Update policy
  const handleUpdatePolicy = async (policyId, updates) => {
    try {
      const token = getToken();
      const response = await fetch(
        `http://localhost:8000/api/attendance/policies/${policyId}/`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updates)
        }
      );

      if (response.ok) {
        setMessage('✓ Policy updated');
        fetchPolicies();
      } else {
        setMessage('✗ Failed to update policy');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Delete policy
  const handleDeletePolicy = async (policyId) => {
    if (confirm('Are you sure you want to delete this policy?')) {
      try {
        const token = getToken();
        const response = await fetch(
          `http://localhost:8000/api/attendance/policies/${policyId}/`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Token ${token}`
            }
          }
        );

        if (response.ok) {
          setMessage('✓ Policy deleted');
          fetchPolicies();
        } else {
          setMessage('✗ Failed to delete policy');
        }
      } catch (error) {
        setMessage(`✗ Error: ${error.message}`);
      }
    }
  };

  // Create geofence
  const handleCreateGeofence = async (e) => {
    e.preventDefault();
    try {
      const token = getToken();
      const response = await fetch('http://localhost:8000/api/attendance/geofences/', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(geofenceForm)
      });

      if (response.ok) {
        setMessage('✓ Geofence created successfully');
        setGeofenceForm({
          name: '',
          latitude: '',
          longitude: '',
          radiusMeters: 100,
          description: ''
        });
        setShowGeofenceForm(false);
        fetchGeofences();
      } else {
        setMessage('✗ Failed to create geofence');
      }
    } catch (error) {
      setMessage(`✗ Error: ${error.message}`);
    }
  };

  // Delete geofence
  const handleDeleteGeofence = async (geofenceId) => {
    if (confirm('Are you sure you want to delete this geofence?')) {
      try {
        const token = getToken();
        const response = await fetch(
          `http://localhost:8000/api/attendance/geofences/${geofenceId}/`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Token ${token}`
            }
          }
        );

        if (response.ok) {
          setMessage('✓ Geofence deleted');
          fetchGeofences();
        } else {
          setMessage('✗ Failed to delete geofence');
        }
      } catch (error) {
        setMessage(`✗ Error: ${error.message}`);
      }
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPolicies(), fetchGeofences()]).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="loading">Loading admin dashboard...</div>;
  }

  return (
    <div className="admin-dashboard-container">
      <h1>Admin Dashboard</h1>

      <div className="tab-navigation">
        <button
          className={`tab-btn ${activeTab === 'policies' ? 'active' : ''}`}
          onClick={() => setActiveTab('policies')}
        >
          Policies ({policies.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'geofences' ? 'active' : ''}`}
          onClick={() => setActiveTab('geofences')}
        >
          Geofences ({geofences.length})
        </button>
      </div>

      {message && (
        <div className={`message ${message.includes('✓') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}

      {/* Policies Tab */}
      {activeTab === 'policies' && (
        <div className="tab-content">
          <div className="tab-header">
            <h2>Attendance Policies</h2>
            <button
              className="btn btn-primary"
              onClick={() => setShowPolicyForm(!showPolicyForm)}
            >
              {showPolicyForm ? '✕ Cancel' : '+ New Policy'}
            </button>
          </div>

          {showPolicyForm && (
            <div className="form-card">
              <h3>Create New Policy</h3>
              <form onSubmit={handleCreatePolicy}>
                <div className="form-group">
                  <label>Policy Name</label>
                  <input
                    type="text"
                    value={policyForm.name}
                    onChange={(e) =>
                      setPolicyForm({ ...policyForm, name: e.target.value })
                    }
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Type</label>
                  <select
                    value={policyForm.type}
                    onChange={(e) =>
                      setPolicyForm({ ...policyForm, type: e.target.value })
                    }
                  >
                    <option value="break">Break Policy</option>
                    <option value="late">Late Check-In Policy</option>
                    <option value="overtime">Overtime Policy</option>
                    <option value="wfh">WFH Policy</option>
                  </select>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Max Minutes</label>
                    <input
                      type="number"
                      value={policyForm.maxMinutes}
                      onChange={(e) =>
                        setPolicyForm({
                          ...policyForm,
                          maxMinutes: parseInt(e.target.value)
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>Min Minutes</label>
                    <input
                      type="number"
                      value={policyForm.minMinutes}
                      onChange={(e) =>
                        setPolicyForm({
                          ...policyForm,
                          minMinutes: parseInt(e.target.value)
                        })
                      }
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    value={policyForm.description}
                    onChange={(e) =>
                      setPolicyForm({ ...policyForm, description: e.target.value })
                    }
                    rows="3"
                  ></textarea>
                </div>

                <button type="submit" className="btn btn-submit">
                  ✓ Create Policy
                </button>
              </form>
            </div>
          )}

          <div className="policies-grid">
            {policies.map(policy => (
              <div key={policy.id} className="policy-card">
                <div className="policy-header">
                  <h3>{policy.name}</h3>
                  <span className="type-badge">{policy.type}</span>
                </div>

                <div className="policy-details">
                  <div className="detail">
                    <span className="label">Min:</span>
                    <span className="value">{policy.minMinutes}m</span>
                  </div>
                  <div className="detail">
                    <span className="label">Max:</span>
                    <span className="value">{policy.maxMinutes}m</span>
                  </div>
                </div>

                {policy.description && (
                  <p className="description">{policy.description}</p>
                )}

                <div className="policy-actions">
                  <button
                    onClick={() => handleDeletePolicy(policy.id)}
                    className="btn btn-delete"
                  >
                    ✗ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Geofences Tab */}
      {activeTab === 'geofences' && (
        <div className="tab-content">
          <div className="tab-header">
            <h2>Office Geofences</h2>
            <button
              className="btn btn-primary"
              onClick={() => setShowGeofenceForm(!showGeofenceForm)}
            >
              {showGeofenceForm ? '✕ Cancel' : '+ New Geofence'}
            </button>
          </div>

          {showGeofenceForm && (
            <div className="form-card">
              <h3>Create New Geofence</h3>
              <form onSubmit={handleCreateGeofence}>
                <div className="form-group">
                  <label>Location Name</label>
                  <input
                    type="text"
                    value={geofenceForm.name}
                    onChange={(e) =>
                      setGeofenceForm({ ...geofenceForm, name: e.target.value })
                    }
                    required
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Latitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={geofenceForm.latitude}
                      onChange={(e) =>
                        setGeofenceForm({
                          ...geofenceForm,
                          latitude: parseFloat(e.target.value)
                        })
                      }
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Longitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={geofenceForm.longitude}
                      onChange={(e) =>
                        setGeofenceForm({
                          ...geofenceForm,
                          longitude: parseFloat(e.target.value)
                        })
                      }
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Radius (meters)</label>
                  <input
                    type="number"
                    value={geofenceForm.radiusMeters}
                    onChange={(e) =>
                      setGeofenceForm({
                        ...geofenceForm,
                        radiusMeters: parseInt(e.target.value)
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    value={geofenceForm.description}
                    onChange={(e) =>
                      setGeofenceForm({
                        ...geofenceForm,
                        description: e.target.value
                      })
                    }
                    rows="3"
                  ></textarea>
                </div>

                <button type="submit" className="btn btn-submit">
                  ✓ Create Geofence
                </button>
              </form>
            </div>
          )}

          <div className="geofences-grid">
            {geofences.map(geofence => (
              <div key={geofence.id} className="geofence-card">
                <div className="geofence-header">
                  <h3>📍 {geofence.name}</h3>
                </div>

                <div className="geofence-details">
                  <div className="detail">
                    <span className="label">Latitude:</span>
                    <span className="value">{geofence.latitude.toFixed(4)}</span>
                  </div>
                  <div className="detail">
                    <span className="label">Longitude:</span>
                    <span className="value">{geofence.longitude.toFixed(4)}</span>
                  </div>
                  <div className="detail">
                    <span className="label">Radius:</span>
                    <span className="value">{geofence.radiusMeters}m</span>
                  </div>
                </div>

                {geofence.description && (
                  <p className="description">{geofence.description}</p>
                )}

                <div className="geofence-actions">
                  <button
                    onClick={() => handleDeleteGeofence(geofence.id)}
                    className="btn btn-delete"
                  >
                    ✗ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <style jsx>{`
        .admin-dashboard-container {
          padding: 20px;
          background: #f9fafb;
          min-height: 100vh;
        }

        .admin-dashboard-container h1 {
          font-size: 28px;
          font-weight: 700;
          margin: 0 0 30px 0;
          color: #111827;
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

        .tab-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
        }

        .tab-header h2 {
          font-size: 22px;
          font-weight: 600;
          margin: 0;
          color: #333;
        }

        .btn {
          padding: 10px 16px;
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

        .btn-submit {
          width: 100%;
          background: #10b981;
          color: white;
          margin-top: 16px;
        }

        .btn-submit:hover {
          background: #059669;
        }

        .btn-delete {
          width: 100%;
          background: #ef4444;
          color: white;
        }

        .btn-delete:hover {
          background: #dc2626;
        }

        .message {
          margin-bottom: 20px;
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

        .form-card {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 30px;
        }

        .form-card h3 {
          margin: 0 0 16px 0;
          font-size: 16px;
          font-weight: 600;
          color: #333;
        }

        .form-group {
          margin-bottom: 16px;
        }

        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }

        .form-group label {
          display: block;
          font-weight: 600;
          margin-bottom: 6px;
          color: #333;
          font-size: 13px;
        }

        .form-group input,
        .form-group select,
        .form-group textarea {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          font-size: 13px;
          font-family: inherit;
        }

        .form-group input:focus,
        .form-group select:focus,
        .form-group textarea:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .policies-grid,
        .geofences-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
        }

        .policy-card,
        .geofence-card {
          background: #fafbfc;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 16px;
          transition: all 0.3s ease;
        }

        .policy-card:hover,
        .geofence-card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          transform: translateY(-2px);
        }

        .policy-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .policy-header h3 {
          font-size: 14px;
          font-weight: 600;
          margin: 0;
          color: #111827;
        }

        .type-badge {
          display: inline-block;
          background: #e0f2fe;
          color: #0369a1;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .geofence-header h3 {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 12px 0;
          color: #111827;
        }

        .policy-details,
        .geofence-details {
          background: white;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 12px;
        }

        .detail {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          padding: 4px 0;
        }

        .detail .label {
          font-weight: 600;
          color: #666;
        }

        .detail .value {
          color: #111827;
          font-weight: 500;
        }

        .description {
          font-size: 12px;
          color: #666;
          margin: 0 0 12px 0;
          line-height: 1.4;
        }

        .policy-actions,
        .geofence-actions {
          display: flex;
          gap: 8px;
        }

        .loading {
          padding: 40px;
          text-align: center;
          color: #666;
        }

        @media (max-width: 600px) {
          .tab-header {
            flex-direction: column;
            gap: 12px;
          }

          .form-row {
            grid-template-columns: 1fr;
          }

          .policies-grid,
          .geofences-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
};

export default AdminDashboard;
