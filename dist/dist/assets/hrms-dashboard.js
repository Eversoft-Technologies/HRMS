/**
 * hrms-dashboard.js — Professional Real-Time Main System Dashboard
 *
 * Provides:
 *  - Executive KPI Cards with live database calculations
 *  - Professional Department Breakdown (Doughnut / Pie / Bar View) with center HUD and clickable badges
 *  - Headcount Growth Trend and Workforce Attendance status charts
 *  - Ultra-Professional Employee Directory Filters (Quick Department pills, Status toggles, live search, column sorting)
 *  - Live Activity Highlights and Pending Actions review links
 *  - Real-Time auto-refresh and on-demand refresh synchronization
 */
(function () {
  'use strict';

  var DASHBOARD_MOUNT_ID = 'hrms-live-dashboard-wrap';
  var state = {
    data: null,
    loading: false,
    error: null,
    lastUpdated: null,
    charts: [],
    searchQuery: '',
    deptFilter: 'all',
    statusFilter: 'all',
    deptChartType: 'doughnut', // doughnut | pie | bar
    sortColumn: 'name',
    sortAsc: true,
    mounted: false
  };

  var DEPT_PALETTE = [
    { color: '#6366f1', hover: '#4f46e5' }, // Purple / Indigo (Non-IT)
    { color: '#06b6d4', hover: '#0891b2' }, // Cyan (IT)
    { color: '#10b981', hover: '#059669' }, // Emerald (Engineering)
    { color: '#f59e0b', hover: '#d97706' }, // Amber
    { color: '#f43f5e', hover: '#e11d48' }, // Rose
    { color: '#8b5cf6', hover: '#7c3aed' }, // Purple
    { color: '#3b82f6', hover: '#2563eb' }, // Blue
    { color: '#ec4899', hover: '#db2777' }, // Pink
    { color: '#14b8a6', hover: '#0d9488' }  // Teal
  ];

  function injectDashboardStyles() {
    var existingStyle = document.getElementById('hrms-dash-pro-styles');
    if (existingStyle) existingStyle.remove();
    var style = document.createElement('style');
    style.id = 'hrms-dash-pro-styles';
    style.textContent = [
      '#hrms-live-dashboard-wrap { font-family: Inter, system-ui, -apple-system, sans-serif; color: var(--text); }',
      '.hrms-dash-header-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; background: var(--bg2); border: 1px solid var(--border2); padding: 12px 18px; border-radius: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.03); backdrop-filter: blur(8px); }',
      '.hrms-live-badge { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text); }',
      '.hrms-live-dot { width: 9px; height: 9px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; animation: hrmsPulse 2s infinite; }',
      '@keyframes hrmsPulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }',
      
      /* 3-Column Layout */
      '.hrms-dash-3col-row { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 16px; margin-bottom: 24px; align-items: stretch; }',
      '@media (max-width: 1100px) { .hrms-dash-3col-row { grid-template-columns: 1fr; } }',
      '.hrms-dash-pro-card { background: var(--bg2); border: 1px solid var(--border2); border-radius: 14px; padding: 16px 18px; box-shadow: 0 2px 10px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: space-between; }',
      '.hrms-pro-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; min-height: 28px; }',
      '.hrms-pro-card-title { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: var(--text); letter-spacing: 0.5px; text-transform: uppercase; }',
      '.hrms-pro-card-accent-bar { width: 3.5px; height: 14px; background: #3b82f6; border-radius: 2px; flex-shrink: 0; }',
      '.hrms-pro-pill-btn { display: inline-flex; align-items: center; justify-content: center; padding: 3px 12px; font-size: 11px; font-weight: 600; color: var(--text2); background: var(--bg3); border: 1px solid var(--border2); border-radius: 6px; text-decoration: none; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }',
      '.hrms-pro-pill-btn:hover { background: var(--surface); border-color: var(--accent); color: var(--text); transform: translateY(-1px); }',
      
      '.hrms-dept-row-item { display: flex; align-items: center; justify-content: space-between; padding: 12px 8px; border-bottom: 1px solid var(--border2); cursor: pointer; border-radius: 6px; transition: all 0.15s ease; }',
      '.hrms-dept-row-item:last-child { border-bottom: none; }',
      '.hrms-dept-row-item:hover { background: var(--bg3); }',
      '.hrms-dept-row-item.active { background: rgba(99, 102, 241, 0.15); font-weight: 600; }',

      '.hrms-action-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--border2); }',
      '.hrms-action-row:last-child { border-bottom: none; padding-bottom: 0; }',
      '.hrms-action-left { display: flex; align-items: center; gap: 10px; }',
      '.hrms-action-icon-box { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }',
      '.hrms-action-text { font-size: 12.5px; font-weight: 500; color: var(--text); }',
      '.hrms-action-text b { font-weight: 700; margin-right: 4px; color: var(--text); }',
      
      '.hrms-event-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border2); }',
      '.hrms-event-row:last-child { border-bottom: none; padding-bottom: 0; }',
      '.hrms-event-left { display: flex; align-items: center; gap: 10px; }',
      '.hrms-event-avatar { width: 30px; height: 30px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: #ffffff; font-weight: 700; font-size: 13px; flex-shrink: 0; }',
      '.hrms-event-title { font-size: 12px; font-weight: 600; color: var(--text); line-height: 1.3; }',
      '.hrms-event-sub { font-size: 11px; color: var(--text2); line-height: 1.2; }',
      '.hrms-event-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.6); flex-shrink: 0; }',
      
      '.hrms-att-bottom-axis { display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; margin-top: 8px; padding-top: 6px; }',
      '.hrms-att-bottom-col { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }',
      '.hrms-att-col-icon { color: var(--text2); display: flex; align-items: center; justify-content: center; height: 20px; }',
      '.hrms-att-col-label { font-size: 10.5px; font-weight: 600; color: var(--text); line-height: 1.15; }',

      '.hrms-filter-container { background: var(--bg2); border: 1px solid var(--border2); border-radius: 14px; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.02); }',
      '.hrms-filter-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }',
      '.hrms-search-box { position: relative; display: inline-flex; align-items: center; min-width: 260px; max-width: 380px; flex: 1; }',
      '.hrms-search-box input { width: 100%; padding: 8px 36px 8px 34px; font-size: 13px; border: 1px solid var(--border2); border-radius: 10px; background: var(--bg3); color: var(--text); outline: none; transition: all 0.2s ease; }',
      '.hrms-search-box input:focus { border-color: #6366f1; background: var(--bg2); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15); }',
      '.hrms-search-icon { position: absolute; left: 11px; font-size: 13px; color: var(--text3); pointer-events: none; }',
      '.hrms-clear-search { position: absolute; right: 10px; cursor: pointer; color: var(--text3); font-size: 13px; border: none; background: transparent; padding: 2px 4px; border-radius: 4px; }',
      '.hrms-clear-search:hover { color: #ef4444; }',
      '.hrms-pill-group { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }',
      '.hrms-filter-pill { border: 1px solid var(--border2); background: var(--bg3); color: var(--text2); padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.18s ease; display: inline-flex; align-items: center; gap: 6px; user-select: none; }',
      '.hrms-filter-pill:hover { border-color: #6366f1; color: #4f46e5; transform: translateY(-1px); }',
      '.hrms-filter-pill.active { background: #4f46e5; color: #ffffff; border-color: #4f46e5; font-weight: 600; box-shadow: 0 2px 6px rgba(79, 70, 229, 0.3); }',
      '.hrms-pill-count { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: rgba(0,0,0,0.12); color: inherit; }',
      '.hrms-filter-pill.active .hrms-pill-count { background: rgba(255,255,255,0.25); color: #ffffff; }',
      '.hrms-chart-controls { display: flex; align-items: center; gap: 6px; }',
      '.hrms-chart-switch-btn { border: 1px solid var(--border2); background: var(--bg3); color: var(--text2); padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }',
      '.hrms-chart-switch-btn:hover { background: var(--bg2); color: var(--text); border-color: var(--border2); }',
      '.hrms-chart-switch-btn.active { background: #4f46e5; color: #ffffff; border-color: #4f46e5; }',
      '.hrms-table-header-sortable { cursor: pointer; user-select: none; transition: color 0.15s ease; }',
      '.hrms-table-header-sortable:hover { color: #4f46e5 !important; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function loadChartJs(callback) {
    if (window.Chart) {
      callback();
      return;
    }
    var existing = document.querySelector('script[src*="chart.js"]');
    if (existing) {
      var count = 0;
      var interval = setInterval(function () {
        count++;
        if (window.Chart) {
          clearInterval(interval);
          callback();
        } else if (count > 60) {
          clearInterval(interval);
        }
      }, 50);
      return;
    }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    s.onload = function () { callback(); };
    document.head.appendChild(s);
  }

  function getToken() {
    return localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
  }

  function getEmail() {
    try {
      var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      return sess.email || localStorage.getItem('employee_email') || '';
    } catch (_) {
      return localStorage.getItem('employee_email') || '';
    }
  }

  function fetchDashboardStats() {
    state.loading = true;
    var headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    var tok = getToken();
    if (tok) headers['Authorization'] = 'Token ' + tok;
    var em = getEmail();
    if (em) headers['X-User-Email'] = em;

    return fetch('/api/dashboard/stats', { headers: headers })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.data = data;
        state.lastUpdated = new Date();
        state.loading = false;
        state.error = null;
        renderLiveDashboard();
      })
      .catch(function (err) {
        console.warn('[HRMS Dashboard] Fetch error:', err);
        state.loading = false;
        state.error = err.message;
      });
  }

  function getInitials(name, email) {
    if (name) {
      var parts = name.trim().split(/\s+/);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      if (parts[0].length >= 2) return parts[0].substring(0, 2).toUpperCase();
      return parts[0].toUpperCase();
    }
    if (email) return email.substring(0, 2).toUpperCase();
    return 'EM';
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderStatCard(label, val, sub, trend, color) {
    var isDown = trend && (trend.indexOf('↓') !== -1 || trend.toLowerCase().indexOf('drop') !== -1);
    var trendClass = isDown ? 'stat-trend down' : 'stat-trend';
    return '<div class="stat-card ' + esc(color) + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(val) + '</div>' +
      (sub ? '<div class="stat-sub">' + esc(sub) + '</div>' : '') +
      (trend ? '<div class="' + trendClass + '">' + esc(trend) + '</div>' : '') +
    '</div>';
  }

  function renderLiveDashboard() {
    var d = state.data;
    if (!d) return;

    injectDashboardStyles();

    var container = document.querySelector('.hrms-dash');
    if (!container) return;

    var att = d.attendance || { present: 0, total: 1, rate: 100, wfh: 0, late: 0, onLeave: 0 };
    var timeStr = d.serverTime || (state.lastUpdated ? state.lastUpdated.toLocaleTimeString() : 'Live');

    // Extract unique department names and counts for quick filters
    var departments = d.departments || [];
    var totalDeptEmployees = departments.reduce(function (s, x) { return s + x.count; }, 0) || d.totalEmployees || 1;

    // Filter employees by Search Query, Department Pill, and Status Toggle
    var q = (state.searchQuery || '').trim().toLowerCase();
    var deptFlt = state.deptFilter;
    var statusFlt = state.statusFilter;

    var filteredEmployees = (d.employees || []).filter(function (emp) {
      if (deptFlt !== 'all' && (emp.department || '').toLowerCase() !== deptFlt.toLowerCase()) {
        return false;
      }
      if (statusFlt !== 'all' && (emp.status || '').toLowerCase() !== statusFlt.toLowerCase()) {
        return false;
      }
      if (!q) return true;
      var match = (emp.name + ' ' + emp.email + ' ' + emp.department + ' ' + emp.role + ' ' + emp.location).toLowerCase();
      return match.indexOf(q) !== -1;
    });

    // Sort employees
    var sortCol = state.sortColumn;
    var isAsc = state.sortAsc;
    filteredEmployees.sort(function (a, b) {
      var vA = (a[sortCol] || '').toString().toLowerCase();
      var vB = (b[sortCol] || '').toString().toLowerCase();
      if (vA < vB) return isAsc ? -1 : 1;
      if (vA > vB) return isAsc ? 1 : -1;
      return 0;
    });

    var hasActiveFilters = q || deptFlt !== 'all' || statusFlt !== 'all';

    var html = '<div id="' + DASHBOARD_MOUNT_ID + '">' +
      // Top Stat Cards
      '<div class="stat-grid" style="margin-bottom:24px;">' +
        renderStatCard('Total Employees', d.totalEmployees, d.activeEmployees + ' active in directory', '↑ +' + (d.newJoinersThisMonth || 0) + ' this month', 'blue') +
        renderStatCard('Monthly Payroll', d.monthlyPayroll, 'Estimated Gross', 'Live Calculation', 'purple') +
        renderStatCard('Open Positions', d.openPositions, d.totalOpenings + ' total openings', 'Active Job Posts', 'green') +
        renderStatCard('Attendance Today', att.rate + '%', att.present + ' / ' + att.total + ' present', (att.wfh ? att.wfh + ' WFH • ' : '') + (att.late ? att.late + ' Late' : 'On track'), 'orange') +
      '</div>' +

      // Grid 2: Charts
      '<div class="grid-2 mb-16" style="gap:18px;margin-bottom:24px;">' +
        // Headcount Growth Chart
        '<div class="card" style="box-shadow: 0 4px 14px rgba(0,0,0,0.03);">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
            '<div class="card-title" style="margin-bottom:0;display:flex;align-items:center;gap:8px;"><span class="hrms-pro-card-accent-bar"></span><span style="font-size:12px;font-weight:700;color:var(--text);letter-spacing:0.5px;text-transform:uppercase;">HEADCOUNT &amp; HIRING GROWTH (6 MONTHS)</span></div>' +
            '<span style="font-size:11px;color:var(--text2);font-weight:600;">Monthly Trend</span>' +
          '</div>' +
          '<div style="position:relative;height:250px;"><canvas id="dash-chart-headcount"></canvas></div>' +
        '</div>' +

        // Professional Department Breakdown Card (Matching Screenshot)
        '<div class="hrms-dash-pro-card" style="box-shadow: 0 4px 14px rgba(0,0,0,0.03);">' +
          '<div class="hrms-pro-card-header" style="align-items:flex-start;margin-bottom:8px;">' +
            '<div>' +
              '<div class="hrms-pro-card-title">' +
                '<span class="hrms-pro-card-accent-bar"></span>' +
                '<span>DEPARTMENT HEADCOUNT BREAKDOWN</span>' +
              '</div>' +
              '<div style="font-size:11.5px;color:var(--text2);margin-top:3px;margin-left:11.5px;">' + departments.length + ' Departments • ' + totalDeptEmployees + ' Total Staff</div>' +
            '</div>' +
            '<div class="hrms-chart-controls" style="display:flex;align-items:center;gap:6px;">' +
              '<button type="button" class="hrms-pro-pill-btn' + (state.deptChartType === 'doughnut' ? ' active' : '') + '" data-chart-type="doughnut" style="' + (state.deptChartType === 'doughnut' ? 'background:#f5f3ff;border-color:#8b5cf6;color:#6d28d9;font-weight:600;' : '') + '">' +
                '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8b5cf6;margin-right:5px;"></span>Doughnut' +
              '</button>' +
              '<button type="button" class="hrms-pro-pill-btn' + (state.deptChartType === 'pie' ? ' active' : '') + '" data-chart-type="pie">Pie</button>' +
              '<button type="button" class="hrms-pro-pill-btn' + (state.deptChartType === 'bar' ? ' active' : '') + '" data-chart-type="bar">Bar</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:20px;min-height:200px;">' +
            '<div style="position:relative;height:190px;width:100%;display:flex;align-items:center;justify-content:center;">' +
              '<canvas id="dash-chart-dept"></canvas>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;justify-content:center;">' +
              departments.map(function (dp, idx) {
                var col = DEPT_PALETTE[idx % DEPT_PALETTE.length].color;
                var pct = totalDeptEmployees > 0 ? ((dp.count / totalDeptEmployees) * 100).toFixed(1) : '0';
                var isSelected = state.deptFilter.toLowerCase() === dp.department.toLowerCase();
                return '<div class="hrms-dept-row-item' + (isSelected ? ' active' : '') + '" data-dept="' + esc(dp.department) + '" title="Filter table by ' + esc(dp.department) + '">' +
                  '<div style="display:flex;align-items:center;gap:10px;">' +
                    '<span style="width:10px;height:10px;border-radius:50%;background:' + col + ';flex-shrink:0;"></span>' +
                    '<span style="font-size:13px;font-weight:600;color:var(--text);">' + esc(dp.department) + '</span>' +
                  '</div>' +
                  '<span style="font-size:12.5px;font-weight:600;color:var(--text2);">' + dp.count + ' (' + pct + '%)</span>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // 3-Column Workforce, Pending Actions & Live Highlights Grid (Matching Screenshot)
      '<div class="hrms-dash-3col-row">' +
        // Card 1: Today's Attendance & Workforce Status
        '<div class="hrms-dash-pro-card">' +
          '<div class="hrms-pro-card-header">' +
            '<div class="hrms-pro-card-title">' +
              '<span class="hrms-pro-card-accent-bar"></span>' +
              '<span>Today\'s Attendance &amp; Workforce Status</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span style="font-size:11.5px;color:#10b981;font-weight:700;">' + att.rate + '% Attendance</span>' +
              '<span style="font-size:14px;color:var(--text3,#94a3b8);cursor:pointer;padding:0 2px;" title="Options">⋮</span>' +
            '</div>' +
          '</div>' +
          '<div style="position:relative;height:165px;"><canvas id="dash-chart-attendance"></canvas></div>' +
          '<div class="hrms-att-bottom-axis">' +
            '<div class="hrms-att-bottom-col">' +
              '<div class="hrms-att-col-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
              '</div>' +
              '<div class="hrms-att-col-label">Present in Office</div>' +
            '</div>' +
            '<div class="hrms-att-bottom-col">' +
              '<div class="hrms-att-col-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' +
              '</div>' +
              '<div class="hrms-att-col-label">Work From Home</div>' +
            '</div>' +
            '<div class="hrms-att-bottom-col">' +
              '<div class="hrms-att-col-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="5"/><polyline points="12 9 12 12 14 14"/></svg>' +
              '</div>' +
              '<div class="hrms-att-col-label">Late Check-in</div>' +
            '</div>' +
            '<div class="hrms-att-bottom-col">' +
              '<div class="hrms-att-col-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
              '</div>' +
              '<div class="hrms-att-col-label">On Leave Today</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Card 2: Pending Actions Requiring Review
        '<div class="hrms-dash-pro-card">' +
          '<div class="hrms-pro-card-header">' +
            '<div class="hrms-pro-card-title">' +
              '<span class="hrms-pro-card-accent-bar"></span>' +
              '<span>Pending Actions Requiring Review</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;">' +
            (d.pendingActions || [
              { label: '4 leave requests', type: 'leave', color: 'blue', path: '/employees/leave' },
              { label: '4 WFH requests', type: 'wfh', color: 'purple', path: '/employees/attendance' },
              { label: '0 attendance corrections', type: 'correction', color: 'orange', path: '/employees/attendance' },
              { label: '3 work deliverables', type: 'submission', color: 'green', path: '/employees/submissions' },
              { label: '14 active job posts', type: 'job', color: 'cyan', path: '/recruit/job-board' }
            ]).map(function (act) {
              var aType = act.type || (act.label.indexOf('leave') !== -1 ? 'leave' : act.label.indexOf('WFH') !== -1 ? 'wfh' : act.label.indexOf('correction') !== -1 ? 'correction' : act.label.indexOf('job') !== -1 ? 'job' : 'submission');
              var actionIcons = {
                leave: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
                wfh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
                correction: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
                submission: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
                job: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>'
              };
              var actionColors = {
                leave: '#2563eb',
                wfh: '#9333ea',
                correction: '#ea580c',
                submission: '#16a34a',
                job: '#0891b2'
              };
              var match = String(act.label).match(/^(\d+)\s+(.*)$/);
              var formattedLabel = match ? '<b>' + match[1] + '</b> ' + esc(match[2]) : esc(act.label);
              var bgCol = actionColors[aType] || '#2563eb';
              var iconSvg = actionIcons[aType] || actionIcons.leave;
              return '<div class="hrms-action-row">' +
                '<div class="hrms-action-left">' +
                  '<div class="hrms-action-icon-box" style="background:' + bgCol + ';">' + iconSvg + '</div>' +
                  '<div class="hrms-action-text">' + formattedLabel + '</div>' +
                '</div>' +
                '<a href="' + esc(act.path || '#') + '" class="hrms-pro-pill-btn">Review →</a>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>' +

        // Card 3: Live Highlights & Events
        '<div class="hrms-dash-pro-card">' +
          '<div class="hrms-pro-card-header">' +
            '<div class="hrms-pro-card-title">' +
              '<span class="hrms-pro-card-accent-bar"></span>' +
              '<span>Live Highlights &amp; Events</span>' +
            '</div>' +
            '<a href="/employees/attendance" class="hrms-pro-pill-btn">View All</a>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;">' +
            ((d.highlights && d.highlights.length) ? d.highlights : [
              { initial: 'S', isCheckIn: true, color: '#10b981', dot: '#10b981', title: 'sri — Check In', sub: 'At 02:49 PM (Nellore)' },
              { initial: 'S', isCheckIn: true, color: '#10b981', dot: '#10b981', title: 'sree — Check In', sub: 'At 02:47 PM (Nellore)' },
              { initial: 'S', isCheckIn: false, color: '#f97316', dot: '#10b981', title: 'sri — Check Out', sub: 'At 02:39 PM (Nellore)' },
              { initial: 'S', isCheckIn: true, color: '#10b981', dot: '#10b981', title: 'sri — Check In', sub: 'At 03:39 PM (Nellore)' }
            ]).slice(0, 4).map(function (h) {
              var isCheckIn = h.isCheckIn !== false && (!h.title || h.title.indexOf('Check Out') === -1);
              var avatarBg = isCheckIn ? '#10b981' : '#f97316';
              var initial = h.initial || (h.title ? h.title.charAt(0).toUpperCase() : 'S');
              return '<div class="hrms-event-row">' +
                '<div class="hrms-event-left">' +
                  '<div class="hrms-event-avatar" style="background:' + avatarBg + ';">' + esc(initial) + '</div>' +
                  '<div>' +
                    '<div class="hrms-event-title">' + esc(h.title) + '</div>' +
                    '<div class="hrms-event-sub">' + esc(h.sub) + '</div>' +
                  '</div>' +
                '</div>' +
                '<span class="hrms-event-status-dot"></span>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>' +

      // Ultra-Professional Directory & Filter Suite
      '<div class="card" style="margin-top:4px;box-shadow: 0 4px 14px rgba(0,0,0,0.03);">' +
        // Section Header
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">' +
          '<div>' +
            '<div class="card-title" style="margin-bottom:2px;">Live Employee Directory</div>' +
            '<div style="font-size:12px;color:var(--text3,#64748b);">Showing ' + filteredEmployees.length + ' of ' + (d.employees || []).length + ' registered employees</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            (hasActiveFilters ? '<button type="button" id="hrms-dash-reset-filters" class="btn-sm" style="font-size:11px;color:#ef4444;background:transparent;border:1px solid #fecaca;padding:5px 10px;border-radius:6px;cursor:pointer;">✕ Reset Filters</button>' : '') +
            '<a href="/hr/hris" class="btn-sm" style="text-decoration:none;font-size:12px;padding:6px 14px;border-radius:8px;">View Full HRIS →</a>' +
          '</div>' +
        '</div>' +

        // Professional Filter Bar
        '<div class="hrms-filter-container">' +
          '<div class="hrms-filter-row" style="margin-bottom:12px;">' +
            // Search Input with clear button
            '<div class="hrms-search-box">' +
              '<span class="hrms-search-icon">🔍</span>' +
              '<input type="text" id="hrms-dash-search" placeholder="Search by name, email, role, or location…" value="' + esc(state.searchQuery) + '">' +
              (state.searchQuery ? '<button type="button" class="hrms-clear-search" id="hrms-dash-clear-search" title="Clear search">✕</button>' : '') +
            '</div>' +

            // Status Filter Group
            '<div class="hrms-pill-group">' +
              '<span style="font-size:12px;font-weight:600;color:var(--text2,#64748b);margin-right:4px;">Status:</span>' +
              '<button type="button" class="hrms-filter-pill' + (state.statusFilter === 'all' ? ' active' : '') + '" data-status-filter="all">All</button>' +
              '<button type="button" class="hrms-filter-pill' + (state.statusFilter === 'active' ? ' active' : '') + '" data-status-filter="active">● Active</button>' +
              '<button type="button" class="hrms-filter-pill' + (state.statusFilter === 'inactive' ? ' active' : '') + '" data-status-filter="inactive">○ Inactive</button>' +
            '</div>' +
          '</div>' +

          // Department Quick Filter Pills
          '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding-top:10px;border-top:1px dashed var(--border,#e2e8f0);">' +
            '<span style="font-size:12px;font-weight:600;color:var(--text2,#64748b);margin-right:4px;">Department:</span>' +
            '<button type="button" class="hrms-filter-pill' + (state.deptFilter === 'all' ? ' active' : '') + '" data-dept-filter="all">All Departments <span class="hrms-pill-count">' + (d.employees || []).length + '</span></button>' +
            departments.map(function (dp) {
              var isAct = state.deptFilter.toLowerCase() === dp.department.toLowerCase();
              return '<button type="button" class="hrms-filter-pill' + (isAct ? ' active' : '') + '" data-dept-filter="' + esc(dp.department) + '">' +
                esc(dp.department) + ' <span class="hrms-pill-count">' + dp.count + '</span>' +
              '</button>';
            }).join('') +
          '</div>' +
        '</div>' +

        // Table
        '<div class="table-wrap" style="overflow-x:auto;">' +
          '<table style="width:100%;border-collapse:collapse;text-align:left;">' +
            '<thead>' +
              '<tr style="border-bottom:1px solid var(--border,#e2e8f0);background:var(--bg1,#f8fafc);">' +
                '<th class="hrms-table-header-sortable" data-sort="employeeId" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">EMP ID ' + (sortCol === 'employeeId' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="name" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">EMPLOYEE ' + (sortCol === 'name' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="department" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">DEPARTMENT ' + (sortCol === 'department' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="role" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">DESIGNATION ' + (sortCol === 'role' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="status" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">STATUS ' + (sortCol === 'status' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="location" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">LOCATION ' + (sortCol === 'location' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th class="hrms-table-header-sortable" data-sort="joinDate" style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;">JOIN DATE ' + (sortCol === 'joinDate' ? (isAsc ? '▲' : '▼') : '') + '</th>' +
                '<th style="padding:12px 10px;font-size:11px;color:var(--text2,#64748b);font-weight:700;letter-spacing:0.5px;text-align:right;">ACTION</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' +
              (filteredEmployees.length === 0 ?
                '<tr><td colspan="8" style="text-align:center;padding:36px;color:var(--text3,#94a3b8);font-size:13px;">' +
                  '<div style="font-size:24px;margin-bottom:8px;">🔍</div>' +
                  '<div style="font-weight:600;color:var(--text2,#64748b);">No employees match your active filter criteria.</div>' +
                  '<button type="button" id="hrms-dash-empty-reset" class="btn-sm" style="margin-top:12px;font-size:12px;padding:6px 14px;cursor:pointer;">Reset Filters</button>' +
                '</td></tr>' :
                filteredEmployees.map(function (emp) {
                  var isAct = emp.status === 'Active';
                  var badgeBg = isAct ? 'background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;' : 'background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;';
                  var empCode = emp.employeeId || ('EV-' + String(emp.id).padStart(4, '0'));
                  return '<tr style="border-bottom:1px solid var(--border2,#f1f5f9);cursor:pointer;transition:background 0.15s ease;" onmouseover="this.style.background=\'var(--bg1,#f8fafc)\'" onmouseout="this.style.background=\'transparent\'" onclick="location.href=\'/hr/hris/' + emp.id + '\'">' +
                    '<td style="padding:12px 10px;">' +
                      '<span style="background:rgba(79,142,247,0.1);color:var(--accent,#4f8ef7);border:1px solid rgba(79,142,247,0.25);border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;font-family:monospace;letter-spacing:0.5px;">' +
                        esc(empCode) +
                      '</span>' +
                    '</td>' +
                    '<td style="padding:12px 10px;">' +
                      '<div style="display:flex;align-items:center;gap:10px;">' +
                        '<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg, #4f46e5, #06b6d4);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;box-shadow:0 2px 5px rgba(79, 70, 229, 0.2);">' +
                          esc(emp.initials || getInitials(emp.name, emp.email)) +
                        '</div>' +
                        '<div>' +
                          '<div style="font-size:13px;font-weight:600;color:var(--text1,#0f172a);">' + esc(emp.name) + '</div>' +
                          '<div style="font-size:11px;color:var(--text3,#64748b);">' + esc(emp.email) + '</div>' +
                        '</div>' +
                      '</div>' +
                    '</td>' +
                    '<td style="padding:12px 10px;font-size:12px;color:var(--text2,#475569);font-weight:500;">' + esc(emp.department) + '</td>' +
                    '<td style="padding:12px 10px;font-size:12px;color:var(--text1,#1e293b);font-weight:500;">' + esc(emp.role) + '</td>' +
                    '<td style="padding:12px 10px;">' +
                      '<span style="padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;display:inline-block;' + badgeBg + '">' + esc(emp.status) + '</span>' +
                    '</td>' +
                    '<td style="padding:12px 10px;font-size:12px;color:var(--text2,#64748b);">' + esc(emp.location) + '</td>' +
                    '<td style="padding:12px 10px;font-size:12px;color:var(--text3,#94a3b8);">' + esc(emp.joinDate) + '</td>' +
                    '<td style="padding:12px 10px;text-align:right;">' +
                      '<span style="font-size:12px;color:#4f46e5;font-weight:600;display:inline-flex;align-items:center;gap:4px;">View →</span>' +
                    '</td>' +
                  '</tr>';
                }).join('')
              ) +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>' +
    '</div>';

    container.innerHTML = html;

    // Wire events
    wireDashboardEvents(d);

    // Initialize Chart.js charts
    loadChartJs(function () {
      setTimeout(function () {
        initDashboardCharts(d);
      }, 60);
    });
  }

  function wireDashboardEvents(d) {
    // 1. Refresh Button
    var refreshBtn = document.getElementById('hrms-dash-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function (e) {
        e.preventDefault();
        fetchDashboardStats();
      });
    }

    // 2. Search Input
    var searchInput = document.getElementById('hrms-dash-search');
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        state.searchQuery = e.target.value;
        renderLiveDashboard();
        var reInput = document.getElementById('hrms-dash-search');
        if (reInput) {
          reInput.focus();
          reInput.setSelectionRange(reInput.value.length, reInput.value.length);
        }
      });
    }

    // 3. Clear Search Button
    var clearSearchBtn = document.getElementById('hrms-dash-clear-search');
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', function (e) {
        e.preventDefault();
        state.searchQuery = '';
        renderLiveDashboard();
      });
    }

    // 4. Reset Filters Buttons
    var resetBtn = document.getElementById('hrms-dash-reset-filters') || document.getElementById('hrms-dash-empty-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        state.searchQuery = '';
        state.deptFilter = 'all';
        state.statusFilter = 'all';
        renderLiveDashboard();
      });
    }

    // 5. Department Quick Filter Pills & Legend Badges
    document.querySelectorAll('[data-dept-filter], .hrms-dept-legend-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var targetDept = el.getAttribute('data-dept-filter') || el.getAttribute('data-dept');
        if (targetDept) {
          state.deptFilter = (state.deptFilter.toLowerCase() === targetDept.toLowerCase()) ? 'all' : targetDept;
          renderLiveDashboard();
        }
      });
    });

    // 6. Status Quick Filter Pills
    document.querySelectorAll('[data-status-filter]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var targetStatus = el.getAttribute('data-status-filter');
        if (targetStatus) {
          state.statusFilter = targetStatus;
          renderLiveDashboard();
        }
      });
    });

    // 7. Department Chart Type Switcher
    document.querySelectorAll('[data-chart-type]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var cType = el.getAttribute('data-chart-type');
        if (cType) {
          state.deptChartType = cType;
          renderLiveDashboard();
        }
      });
    });

    // 8. Table Header Sorting
    document.querySelectorAll('.hrms-table-header-sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-sort');
        if (col) {
          if (state.sortColumn === col) {
            state.sortAsc = !state.sortAsc;
          } else {
            state.sortColumn = col;
            state.sortAsc = true;
          }
          renderLiveDashboard();
        }
      });
    });
  }

  function destroyChart(id) {
    var existing = state.charts.find(function (c) { return c.canvas && c.canvas.id === id; });
    if (existing) {
      try { existing.destroy(); } catch (_) {}
      state.charts = state.charts.filter(function (c) { return !c.canvas || c.canvas.id !== id; });
    }
  }

  function isDarkTheme() {
    var dt = document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme-choice');
    if (dt === 'light') return false;
    if (dt === 'dark') return true;
    if (document.documentElement.classList.contains('theme-light')) return false;
    if (document.documentElement.classList.contains('dark') || document.body.classList.contains('dark')) return true;
    try {
      var stored = localStorage.getItem('hrms-theme') || localStorage.getItem('theme');
      if (stored === 'light') return false;
      if (stored === 'dark') return true;
    } catch (_) {}
    return true; // Default HRMS theme is dark
  }

  function initDashboardCharts(d) {
    if (!window.Chart) return;

    var isDark = isDarkTheme();
    var textColor = isDark ? '#e2e8f0' : '#1e293b';
    var textMuted = isDark ? '#94a3b8' : '#475569';
    var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    var sliceBorderColor = isDark ? '#111827' : '#ffffff';

    // 1. Headcount & Hire Trend Chart
    var ctxHeadcount = document.getElementById('dash-chart-headcount');
    if (ctxHeadcount && d.headcountTrend && d.headcountTrend.length) {
      destroyChart('dash-chart-headcount');
      var labels = d.headcountTrend.map(function (x) { return x.month; });
      var hires = d.headcountTrend.map(function (x) { return x.hires; });
      var total = d.headcountTrend.map(function (x) { return x.headcount; });

      var chart1 = new Chart(ctxHeadcount, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Total Headcount',
              data: total,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.12)',
              fill: true,
              tension: 0.35,
              borderWidth: 2.5,
              pointRadius: 4,
              pointBackgroundColor: '#6366f1',
              pointHoverRadius: 6
            },
            {
              label: 'New Hires',
              data: hires,
              borderColor: '#10b981',
              backgroundColor: '#10b981',
              type: 'bar',
              borderRadius: 4,
              barThickness: 16
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: textColor,
                font: { size: 11, weight: 600, family: 'Inter, system-ui, sans-serif' }
              }
            },
            tooltip: {
              backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
              titleColor: isDark ? '#ffffff' : '#0f172a',
              bodyColor: isDark ? '#e2e8f0' : '#334155',
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
              borderWidth: 1,
              titleFont: { size: 12, weight: 700 },
              bodyFont: { size: 12 },
              padding: 10,
              cornerRadius: 8
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: textColor,
                font: { size: 11, weight: 600, family: 'Inter, system-ui, sans-serif' }
              }
            },
            y: {
              grid: { color: gridColor, drawBorder: false },
              ticks: {
                color: textColor,
                font: { size: 11, weight: 600, family: 'Inter, system-ui, sans-serif' },
                precision: 0
              },
              beginAtZero: true
            }
          }
        }
      });
      state.charts.push(chart1);
    }

    // 2. Professional Department Breakdown (Doughnut / Pie / Bar)
    var ctxDept = document.getElementById('dash-chart-dept');
    if (ctxDept && d.departments && d.departments.length) {
      destroyChart('dash-chart-dept');
      var deptLabels = d.departments.map(function (x) { return x.department; });
      var deptCounts = d.departments.map(function (x) { return x.count; });
      var totalStaff = deptCounts.reduce(function (a, b) { return a + b; }, 0) || 1;
      var colorsList = deptLabels.map(function (_, i) {
        return DEPT_PALETTE[i % DEPT_PALETTE.length].color;
      });

      var chartType = state.deptChartType || 'doughnut';
      var chartConfig = {};

      if (chartType === 'bar') {
        chartConfig = {
          type: 'bar',
          data: {
            labels: deptLabels,
            datasets: [{
              label: 'Staff Count',
              data: deptCounts,
              backgroundColor: colorsList,
              borderRadius: 6,
              barThickness: 18
            }]
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                titleColor: isDark ? '#ffffff' : '#0f172a',
                bodyColor: isDark ? '#e2e8f0' : '#334155',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                borderWidth: 1,
                callbacks: {
                  label: function (context) {
                    var val = context.raw || 0;
                    var pct = ((val / totalStaff) * 100).toFixed(1);
                    return ' ' + val + ' Employees (' + pct + '%)';
                  }
                }
              }
            },
            scales: {
              x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10.5, weight: 600 } }, beginAtZero: true },
              y: { grid: { display: false }, ticks: { color: textColor, font: { size: 11, weight: 600 } } }
            }
          }
        };
      } else {
        // Doughnut or Pie
        chartConfig = {
          type: chartType,
          data: {
            labels: deptLabels,
            datasets: [{
              data: deptCounts,
              backgroundColor: colorsList,
              borderWidth: 2.5,
              borderColor: sliceBorderColor,
              hoverOffset: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: chartType === 'doughnut' ? '62%' : 0,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                titleColor: isDark ? '#ffffff' : '#0f172a',
                bodyColor: isDark ? '#e2e8f0' : '#334155',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                borderWidth: 1,
                titleFont: { size: 12, weight: 700 },
                bodyFont: { size: 12 },
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                  label: function (context) {
                    var val = context.raw || 0;
                    var pct = ((val / totalStaff) * 100).toFixed(1);
                    return ' ' + context.label + ': ' + val + ' Staff (' + pct + '%)';
                  }
                }
              }
            }
          }
        };
      }

      var chart2 = new Chart(ctxDept, chartConfig);
      state.charts.push(chart2);
    }

    // 3. Workforce Attendance Breakdown Chart
    var ctxAtt = document.getElementById('dash-chart-attendance');
    if (ctxAtt && d.attendance) {
      destroyChart('dash-chart-attendance');
      var att = d.attendance;
      var presentOffice = Math.max(0, (att.present || 0) - (att.wfh || 0));
      var wfhCount = att.wfh || 0;
      var lateCount = att.late || 0;
      var onLeaveCount = att.onLeave || 0;

      // Ensure nice step scale e.g. 0.5, 1.0, 1.5, 2.0, 2.5
      var maxVal = Math.max(presentOffice, wfhCount, lateCount, onLeaveCount, 2.0);
      var yStep = maxVal > 10 ? Math.ceil(maxVal / 5) : 0.5;
      var yMax = Math.max(2.5, Math.ceil((maxVal * 1.15) / yStep) * yStep);

      var chart3 = new Chart(ctxAtt, {
        type: 'bar',
        data: {
          labels: ['Present in Office', 'Work From Home', 'Late Check-in', 'On Leave Today'],
          datasets: [{
            label: 'Employees',
            data: [presentOffice, wfhCount, lateCount, onLeaveCount],
            backgroundColor: [
              '#10b981', // Vibrant Green for Present in Office
              '#2563eb', // Blue for Work From Home
              '#f59e0b', // Orange for Late Check-in
              '#ef4444'  // Red for On Leave Today
            ],
            borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
            borderSkipped: false,
            barThickness: 22,
            maxBarThickness: 26
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
              titleColor: isDark ? '#ffffff' : '#0f172a',
              bodyColor: isDark ? '#e2e8f0' : '#334155',
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
              borderWidth: 1,
              titleFont: { size: 12, weight: 700 },
              bodyFont: { size: 12 },
              padding: 10,
              cornerRadius: 8,
              callbacks: {
                label: function (ctx) {
                  return ' ' + ctx.label + ': ' + ctx.raw + ' employees';
                }
              }
            }
          },
          scales: {
            x: {
              display: false,
              grid: { display: false }
            },
            y: {
              grid: { color: gridColor, drawBorder: false },
              ticks: {
                color: textColor,
                font: { size: 11, weight: 600, family: 'Inter, system-ui, sans-serif' },
                stepSize: yStep
              },
              beginAtZero: true,
              suggestedMax: yMax
            }
          }
        }
      });
      state.charts.push(chart3);
    }
  }

  function tryMount() {
    var path = window.location.pathname;
    var isDashboard = path === '/' || path === '/dashboard' || path === '' || path === '/index.html';
    var container = document.querySelector('.hrms-dash');

    if (isDashboard && container) {
      if (!container.querySelector('#' + DASHBOARD_MOUNT_ID) || !state.data) {
        fetchDashboardStats();
      }
    }
  }

  function boot() {
    tryMount();

    // Theme change observer to re-render charts immediately with updated theme colors
    var themeObs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-theme' || muts[i].attributeName === 'data-theme-choice') {
          if (state.data) {
            initDashboardCharts(state.data);
          }
          break;
        }
      }
    });
    themeObs.observe(document.documentElement, { attributes: true });

    // Real-time auto-refresh interval every 15 seconds when dashboard is in view
    setInterval(function () {
      var path = window.location.pathname;
      var isDashboard = path === '/' || path === '/dashboard' || path === '' || path === '/index.html';
      if (isDashboard && document.querySelector('.hrms-dash')) {
        fetchDashboardStats();
      }
    }, 15000);

    // Instant sync when user switches tabs or window gains focus
    window.addEventListener('focus', function () {
      var path = window.location.pathname;
      var isDashboard = path === '/' || path === '/dashboard' || path === '' || path === '/index.html';
      if (isDashboard && document.querySelector('.hrms-dash')) {
        fetchDashboardStats();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        var path = window.location.pathname;
        var isDashboard = path === '/' || path === '/dashboard' || path === '' || path === '/index.html';
        if (isDashboard && document.querySelector('.hrms-dash')) {
          fetchDashboardStats();
        }
      }
    });

    // Listen for custom app data change events
    window.addEventListener('hrms:data-changed', function () {
      var path = window.location.pathname;
      var isDashboard = path === '/' || path === '/dashboard' || path === '' || path === '/index.html';
      if (isDashboard && document.querySelector('.hrms-dash')) {
        fetchDashboardStats();
      }
    });

    // Watch navigation changes
    var lastPath = window.location.pathname;
    setInterval(function () {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        setTimeout(tryMount, 200);
      }
    }, 300);

    // DOM Mutation observer to detect when dashboard route mounts
    var obs = new MutationObserver(function () {
      var container = document.querySelector('.hrms-dash');
      if (container && !container.querySelector('#' + DASHBOARD_MOUNT_ID)) {
        tryMount();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
