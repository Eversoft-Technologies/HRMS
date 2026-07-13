(function () {
  const rootId = 'attendance-portal-root';
  let root = document.getElementById(rootId);
  // Ensure a root exists; create if missing so the portal can mount in any page.
  if (!root) {
    root = document.createElement('div');
    root.id = rootId;
    document.body.appendChild(root);
  }

  // Create a fixed wrapper that will slide in from the right.
  let wrapper = document.getElementById('attendance-portal-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'attendance-portal-wrapper';
    document.body.appendChild(wrapper);
    wrapper.appendChild(root);
  } else if (!wrapper.contains(root)) {
    wrapper.appendChild(root);
  }

  // Wrap window.fetch to persist JWT returned by /api/auth/verify-otp automatically.
  try {
    const __origFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      // Normalize relative API paths (e.g. "api/notifications") to absolute origin paths
      let reqInput = input;
      try {
        if (typeof reqInput === 'string') {
          if (reqInput.indexOf('api/') === 0) {
            reqInput = window.location.origin + '/' + reqInput;
          } else if (reqInput.indexOf('/api/') === 0) {
            reqInput = window.location.origin + reqInput;
          }
        } else if (reqInput && reqInput.url && typeof reqInput.url === 'string') {
          // Request object with relative URL
          if (reqInput.url.indexOf('api/') === 0) {
            reqInput = new Request(window.location.origin + '/' + reqInput.url, reqInput);
          } else if (reqInput.url.indexOf('/api/') === 0) {
            reqInput = new Request(window.location.origin + reqInput.url, reqInput);
          }
        }
      } catch(e) {}

      const resp = await __origFetch(reqInput, init);
      try {
        const url = typeof reqInput === 'string' ? reqInput : (reqInput && reqInput.url) || '';
        if (String(url).indexOf('/api/auth/verify-otp') !== -1) {
          const clone = resp.clone();
          try {
            const body = await clone.json();
            if (body && body.token) {
              try { localStorage.setItem('auth_token', body.token); } catch (e) {}
              if (body.user) {
                try { localStorage.setItem('employee_email', body.user.email || ''); } catch (e) {}
                try { localStorage.setItem('employee_name', body.user.full_name || body.user.name || ''); } catch (e) {}
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
      return resp;
    };
  } catch (e) {
    // noop if fetch cannot be wrapped
  }

  // Create a backdrop for smooth modal-like experience
  let backdrop = document.getElementById('attendance-portal-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'attendance-portal-backdrop';
    document.body.appendChild(backdrop);
  }

  // Toggle button (floating) to open/close the right sidebar portal
  let toggleBtn = document.getElementById('attendance-portal-toggle');
  if (!toggleBtn) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'attendance-portal-toggle';
    toggleBtn.innerText = 'Attendance';
    document.body.appendChild(toggleBtn);
  }

  const state = {
    today: null,
    breaks: [],
    overtime: null,
    notifications: [],
    wfhRequests: [],
    message: '',
    loading: false,
    breakType: 'meal',
    fromDate: '',
    toDate: '',
    reason: ''
  };

  function getEmail() {
    return localStorage.getItem('employee_email') || 'employee@company.com';
  }

  function getName() {
    return localStorage.getItem('employee_name') || 'Employee';
  }

  function getToken() {
    return localStorage.getItem('auth_token') || 'demo-token';
  }

  function setMessage(message, isError) {
    state.message = message;
    state.messageType = isError ? 'error' : 'success';
    render();
  }

  async function api(path, options = {}, allowRetry = true) {
    // Use the current page origin so requests match the server host (avoids localhost vs 127.0.0.1 mismatches)
    const base = window.location.origin || 'http://localhost:8000';
    const token = getToken();
    // Identity for these endpoints travels in the `email` param, so also send it
    // as X-User-Email (matches the rest of the API's RBAC gate).
    const headers = {
      'Content-Type': 'application/json',
      'X-User-Email': getEmail(),
      ...(options.headers || {})
    };
    // Only attach a real JWT. Never send the 'demo-token' placeholder as a Bearer.
    if (token && token !== 'demo-token' && token.indexOf('.') >= 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${base}${path}`, { ...options, headers });
    // A stale/expired JWT is rejected at the auth layer (401) before AllowAny
    // applies. Drop the bad token and retry once anonymously so the portal
    // self-heals instead of showing an auth error.
    if (response.status === 401 && headers.Authorization && allowRetry) {
      try { localStorage.removeItem('auth_token'); } catch (e) {}
      return api(path, options, false);
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!response.ok) {
      throw new Error(data?.error || data?.detail || data?.message || `Request failed (${response.status})`);
    }
    return data;
  }

  async function loadData() {
    state.loading = true;
    render();
    const email = encodeURIComponent(getEmail());
    const today = new Date().toISOString().split('T')[0];
    // Load every panel independently so one failing/unavailable endpoint can't
    // blank the whole portal with a "backend unreachable" banner.
    const results = await Promise.allSettled([
      api(`/api/attendance/today/?email=${email}`),
      api(`/api/attendance/breaks/today/?email=${email}`),
      api(`/api/attendance/overtime/daily/?email=${email}&date=${encodeURIComponent(today)}`),
      api(`/api/notifications?email=${email}`),
      api(`/api/attendance/wfh?email=${email}`)
    ]);
    const [todayRes, breaksRes, overtimeRes, notifRes, wfhRes] = results;
    if (todayRes.status === 'fulfilled') {
      const t = todayRes.value;
      state.today = Array.isArray(t) ? t[0] || null : t;
    }
    if (breaksRes.status === 'fulfilled') state.breaks = breaksRes.value || [];
    if (overtimeRes.status === 'fulfilled') state.overtime = overtimeRes.value || null;
    if (notifRes.status === 'fulfilled') state.notifications = notifRes.value || [];
    if (wfhRes.status === 'fulfilled') state.wfhRequests = wfhRes.value || [];

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length === results.length) {
      // Every request failed — the API is genuinely unreachable or auth is required.
      const authErr = failures.some((f) => f.reason && /permission|authenticate|unauthorized|401|403/i.test(f.reason.message || ''));
      if (authErr) {
        state.message = 'Authentication required — please sign in (set `auth_token` in localStorage) or refresh your session.';
        state.authRequired = true;
      } else {
        state.message = 'Backend not reachable yet. The UI is ready for use when the API is running.';
        state.authRequired = false;
      }
      state.messageType = 'error';
    } else {
      // At least one panel loaded — clear any stale error banner.
      state.message = '';
      state.authRequired = false;
      failures.forEach((f) => console.warn('Attendance portal: a panel failed to load:', f.reason && f.reason.message));
    }
    state.loading = false;
    render();
  }

  async function handleCheckIn() {
    try {
      const location = await getLocation();
      await api('/api/attendance/check-in/', {
        method: 'POST',
        body: JSON.stringify({
          email: getEmail(),
          employeeName: getName(),
          latitude: location.latitude,
          longitude: location.longitude
        })
      });
      setMessage('Check-in recorded successfully.', false);
      loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  async function handleCheckOut() {
    try {
      const location = await getLocation();
      await api('/api/attendance/check-out/', {
        method: 'POST',
        body: JSON.stringify({
          email: getEmail(),
          employeeName: getName(),
          latitude: location.latitude,
          longitude: location.longitude
        })
      });
      setMessage('Check-out recorded successfully.', false);
      loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  async function handleStartBreak() {
    try {
      await api('/api/attendance/break/start/', {
        method: 'POST',
        body: JSON.stringify({
          email: getEmail(),
          employeeName: getName(),
          breakType: state.breakType,
          reason: ''
        })
      });
      setMessage('Break started.', false);
      loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  async function handleEndBreak() {
    try {
      await api('/api/attendance/break/end/', {
        method: 'POST',
        body: JSON.stringify({ email: getEmail() })
      });
      setMessage('Break ended.', false);
      loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  async function handleSubmitWfh(e) {
    e.preventDefault();
    try {
      await api('/api/attendance/wfh/submit/', {
        method: 'POST',
        body: JSON.stringify({
          email: getEmail(),
          fromDate: state.fromDate,
          toDate: state.toDate,
          reason: state.reason
        })
      });
      setMessage('WFH request submitted.', false);
      state.fromDate = '';
      state.toDate = '';
      state.reason = '';
      loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        resolve({ latitude: 28.5355, longitude: 77.3910 });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        () => resolve({ latitude: 28.5355, longitude: 77.3910 }),
        { timeout: 5000 }
      );
    });
  }

  function render() {
    const todayStatus = state.today || {};
    // The API returns checkIn/checkOut; tolerate the older checkInTime/checkOutTime too.
    const checkInAt = todayStatus.checkInTime || todayStatus.checkIn || null;
    const checkOutAt = todayStatus.checkOutTime || todayStatus.checkOut || null;
    const isCheckedIn = Boolean(checkInAt && !checkOutAt);
    const workedMinutes = todayStatus.workedMinutes || 0;
    const overtimeHours = state.overtime?.overtimeHours
      ?? (state.overtime?.overtimeMinutes ? (state.overtime.overtimeMinutes / 60).toFixed(1) : 0);

    root.innerHTML = `
      <section class="attendance-portal-shell">
        <button class="close-btn" aria-label="Close attendance panel">✕</button>
        ${state.loading ? `<div class="portal-loading-overlay"><div class="spinner" aria-hidden="true"></div></div>` : ''}
        <div class="attendance-portal-card">
          <div class="portal-content">
          <div class="portal-header">
            <div>
              <p class="eyebrow">Attendance Portal</p>
              <h2>HRMS attendance workspace</h2>
              <p class="subcopy">Check in, manage breaks, request WFH, and review activity from one place.</p>
            </div>
            <div class="portal-badge">${state.loading ? 'Loading…' : 'Live'}</div>
          </div>

          ${state.message ? `<div class="portal-message ${state.messageType}">${state.message} ${state.authRequired ? '<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><input id="portal-token-input" placeholder="Paste JWT here" style="flex:1;padding:8px;border-radius:8px;border:1px solid #cbd5e1" /><button id="portal-apply-token" class="btn btn-primary">Apply token</button><button id="portal-retry-btn" class="btn btn-secondary">Retry</button></div>' : ''}</div>` : ''}

          <div class="portal-grid">
            <article class="panel panel-hero">
              <div class="panel-title-row">
                <h3>Today</h3>
                <span class="pill">${todayStatus.status || 'Unknown'}</span>
              </div>
              <p class="employee-name">${getName()} · ${getEmail()}</p>
              <div class="metric-row">
                <div>
                  <div class="metric-label">Check-in</div>
                  <div class="metric-value">${checkInAt ? new Date(checkInAt).toLocaleTimeString() : '—'}</div>
                </div>
                <div>
                  <div class="metric-label">Check-out</div>
                  <div class="metric-value">${checkOutAt ? new Date(checkOutAt).toLocaleTimeString() : '—'}</div>
                </div>
              </div>
              <div class="metric-row">
                <div>
                  <div class="metric-label">Worked</div>
                  <div class="metric-value">${Math.floor(workedMinutes / 60)}h ${workedMinutes % 60}m</div>
                </div>
                <div>
                  <div class="metric-label">Overtime</div>
                  <div class="metric-value">${overtimeHours}h</div>
                </div>
              </div>
              <div class="action-row">
                <button class="btn btn-primary" data-action="check-in" ${isCheckedIn || state.loading ? 'disabled' : ''} aria-disabled="${isCheckedIn || state.loading}">${state.loading ? 'Please wait…' : 'Check in'}</button>
                <button class="btn btn-secondary" data-action="check-out" ${!isCheckedIn || state.loading ? 'disabled' : ''} aria-disabled="${!isCheckedIn || state.loading}">${state.loading ? 'Please wait…' : 'Check out'}</button>
              </div>
            </article>

            <article class="panel">
              <div class="panel-title-row">
                <h3>Breaks</h3>
                <select id="break-type">
                  <option value="meal" ${state.breakType === 'meal' ? 'selected' : ''}>Meal</option>
                  <option value="rest" ${state.breakType === 'rest' ? 'selected' : ''}>Rest</option>
                  <option value="personal" ${state.breakType === 'personal' ? 'selected' : ''}>Personal</option>
                  <option value="medical" ${state.breakType === 'medical' ? 'selected' : ''}>Medical</option>
                </select>
              </div>
              <div class="action-row">
                <button class="btn btn-primary" data-action="start-break" ${state.loading ? 'disabled' : ''}>Start break</button>
                <button class="btn btn-secondary" data-action="end-break" ${state.loading ? 'disabled' : ''}>End break</button>
              </div>
              <ul class="list">
                ${state.breaks.length ? state.breaks.map((br) => `<li>${br.breakType || 'break'} · ${br.status || 'active'}</li>`).join('') : '<li>No breaks recorded yet.</li>'}
              </ul>
            </article>

            <article class="panel">
              <div class="panel-title-row">
                <h3>WFH request</h3>
              </div>
              <form id="wfh-form">
                <label>From<input type="date" id="fromDate" value="${state.fromDate}" required></label>
                <label>To<input type="date" id="toDate" value="${state.toDate}" required></label>
                <label>Reason<textarea id="reason">${state.reason}</textarea></label>
                <button class="btn btn-primary" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Please wait…' : 'Submit'}</button>
              </form>
              <ul class="list">
                ${state.wfhRequests.length ? state.wfhRequests.map((req) => `<li>${req.fromDate || '-'} → ${req.toDate || '-'} · ${req.status || 'Pending'}</li>`).join('') : '<li>No WFH requests yet.</li>'}
              </ul>
            </article>

            <article class="panel">
              <div class="panel-title-row">
                <h3>Notifications</h3>
              </div>
              <ul class="list">
                ${state.notifications.length ? state.notifications.slice(0, 5).map((n) => `<li><strong>${n.title || 'Notice'}</strong> · ${n.message || ''}</li>`).join('') : '<li>No notifications.</li>'}
              </ul>
            </article>
          </div>
          </div>
        </div>
      </section>
    `;

    root.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        if (action === 'check-in') handleCheckIn();
        if (action === 'check-out') handleCheckOut();
        if (action === 'start-break') handleStartBreak();
        if (action === 'end-break') handleEndBreak();
      });
    });

    const breakTypeSelect = root.querySelector('#break-type');
    if (breakTypeSelect) {
      breakTypeSelect.addEventListener('change', (event) => {
        state.breakType = event.target.value;
      });
    }

    const fromInput = root.querySelector('#fromDate');
    const toInput = root.querySelector('#toDate');
    const reasonInput = root.querySelector('#reason');
    const form = root.querySelector('#wfh-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        state.fromDate = fromInput.value;
        state.toDate = toInput.value;
        state.reason = reasonInput.value;
        handleSubmitWfh(event);
      });
    }
    // Attach retry button handler when present
    const retryBtn = root.querySelector('#portal-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        state.message = '';
        state.authRequired = false;
        loadData();
      });
    }
    const applyBtn = root.querySelector('#portal-apply-token');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const input = root.querySelector('#portal-token-input');
        if (input && input.value.trim()) {
          localStorage.setItem('auth_token', input.value.trim());
          state.message = 'Token applied — reloading data.';
          state.messageType = 'success';
          state.authRequired = false;
          loadData();
        }
      });
    }
  }

  root.innerHTML = '<div class="attendance-portal-loading">Loading attendance workspace…</div>';
  loadData();

  const style = document.createElement('style');
  style.textContent = `
    /* Backdrop for modal effect */
    #attendance-portal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(6,12,24,0.55);
      backdrop-filter: blur(6px) saturate(1.04);
      opacity: 0;
      pointer-events: none;
      transition: opacity 260ms ease;
      z-index: 9996;
    }
    #attendance-portal-backdrop.visible { opacity: 1; pointer-events: auto; }

    /* Full-page wrapper that slides in from the right */
    #attendance-portal-wrapper {
      position: fixed;
      inset: 0; /* cover the entire viewport */
      width: 100%;
      height: 100%;
      transform: translateX(100%);
      transition: transform 360ms cubic-bezier(.2,.9,.3,1), box-shadow 220ms ease;
      z-index: 9997;
      display: flex;
      pointer-events: auto;
      will-change: transform;
      align-items: center;
      justify-content: center;
    }

    #attendance-portal-wrapper.open {
      transform: translateX(0);
      box-shadow: none;
    }

    /* Root sits inside wrapper and holds the card */
    #attendance-portal-root { margin: 0; padding: 0; width: 100%; height: 100%; }
    .attendance-portal-shell { color: var(--text, #0f172a); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; width:100%; height:100%; }
    /* Full-page card: fills the entire viewport (no floating modal). */
    .attendance-portal-card { background: #ffffff; border-radius: 0; padding: 28px 32px; box-shadow: none; width: 100%; height: 100%; max-height: 100vh; display:block; position:relative; }
    /* Content scrolls inside the full-page card, centered in a readable column. */
    .attendance-portal-card .portal-content { max-width: 1120px; margin: 0 auto; height: 100%; max-height: calc(100vh - 56px); overflow:auto; padding-right:12px; }
    .portal-header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:14px; }
    .eyebrow { text-transform:uppercase; letter-spacing:0.20em; font-weight:700; color:#2563eb; font-size:0.78rem; margin:0 0 4px; }
    .portal-header h2 { margin:0; font-size:1.35rem; }
    .subcopy { margin:6px 0 0; color:#475569; max-width:640px; font-size:0.95rem }
    .portal-badge { background:#dbeafe; color:#1d4ed8; padding:8px 12px; border-radius:999px; font-weight:700; }
    .portal-message { padding:10px 12px; border-radius:10px; margin-bottom:14px; font-weight:600; }
    .portal-message.success { background:#dcfce7; color:#166534; }
    .portal-message.error { background:#fee2e2; color:#b91c1c; }
    .portal-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
    .panel { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; }
    .panel-hero { grid-column:1 / -1; }
    .panel-title-row { display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:10px; }
    .panel-title-row h3 { margin:0; font-size:1rem }
    .pill { background:#e2e8f0; color:#0f172a; padding:4px 10px; border-radius:999px; font-size:0.8rem; font-weight:700; text-transform:capitalize; }
    .employee-name { color:#475569; margin:0 0 12px; }
    .metric-row { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:10px; }
    .metric-label { color:#64748b; font-size:0.82rem; margin-bottom:4px; }
    .metric-value { font-weight:700; font-size:1rem; }
    .action-row { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .btn { border:none; border-radius:999px; padding:8px 12px; font-weight:700; cursor:pointer; font-size:0.95rem }
    .btn:disabled { opacity:0.5; cursor:not-allowed; }
    .btn-primary { background:#2563eb; color:white; }
    .btn-secondary { background:#eef2ff; color:#0f172a; }
    .list { margin:10px 0 0; padding-left:18px; color:#475569; }
    label { display:block; font-size:0.92rem; color:#334155; margin-bottom:8px; }
    input, select, textarea { width:100%; border:1px solid #e6eef8; border-radius:10px; padding:8px 10px; margin-top:4px; font:inherit; }
    textarea { min-height:70px; }
    @media (max-width: 700px) { #attendance-portal-wrapper { right:8px; left:8px; width:auto; top:48px; height:calc(100% - 96px); } .portal-grid { grid-template-columns:1fr; } .portal-header { flex-direction:column; } }

    /* Floating toggle button */
    #attendance-portal-toggle {
      position: fixed;
      right: 28px;
      bottom: 28px;
      z-index: 10002;
      background: linear-gradient(90deg,#6366f1,#06b6d4);
      color: white;
      border: none;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 700;
      font-size:0.95rem;
      box-shadow: 0 10px 30px rgba(6,8,23,0.25);
      cursor: pointer;
      min-width:110px;
    }

    #attendance-portal-root .close-btn {
      position: absolute;
      right: 14px;
      top: 14px;
      background: transparent;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: #475569;
      padding: 8px;
      border-radius: 8px;
      z-index:12;
    }

    #attendance-portal-root .close-btn:hover { background: rgba(0,0,0,0.04); }

    /* Loading overlay + spinner */
    .portal-loading-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:linear-gradient(180deg, rgba(255,255,255,0.7), rgba(248,250,252,0.7)); border-radius:16px; z-index:20; }
    .spinner { width:36px; height:36px; border-radius:50%; border:4px solid rgba(0,0,0,0.08); border-top-color: #2563eb; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Responsive tweaks for small screens */
    @media (max-width: 700px) { #attendance-portal-wrapper { right:8px; left:8px; width:auto; top:48px; height:calc(100% - 96px); } .portal-grid { grid-template-columns:1fr; } .portal-header { flex-direction:column; } }
  `;
  document.head.appendChild(style);

  // Open/close helpers to centralize animations, backdrop, and focus management
  function openPortal() {
    wrapper.classList.add('open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
    // focus first actionable control after animation
    setTimeout(() => {
      const focusEl = root.querySelector('button:not([disabled]), a, input, select, textarea');
      if (focusEl) focusEl.focus();
    }, 260);
  }

  function closePortal() {
    wrapper.classList.remove('open');
    backdrop.classList.remove('visible');
    document.body.style.overflow = '';
    toggleBtn.focus();
  }

  toggleBtn.addEventListener('click', () => {
    if (wrapper.classList.contains('open')) closePortal(); else openPortal();
  });

  // Backdrop click closes the portal
  backdrop.addEventListener('click', () => closePortal());

  // Close button delegated attachment after each render
  const attachCloseHandler = () => {
    const closeBtn = root.querySelector('.close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => closePortal());
  };

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrapper.classList.contains('open')) {
      closePortal();
    }
  });

  // Ensure the close handler is attached after initial render and subsequent renders
  const originalRender = render;
  render = function () {
    originalRender();
    attachCloseHandler();
  };
})();
