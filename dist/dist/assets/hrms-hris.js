/**
 * hrms-hris.js
 * ---------------------------------------------------------------------------
 * HR > HRIS employee profile page (/hr/hris/<key>) plus the row links that
 * lead to it from the HRIS list (/hr/hris).
 *
 * The React bundle routes /hr/hris/:id to a placeholder ("Employee Profile
 * Page"). This sidecar hides that placeholder and mounts the real page under
 * .main, the same way hrms-payroll.js does for /payroll/run. No bundle rebuild.
 *
 * <key> is either an AppUser id (the Dashboard directory links with it) or a
 * URL-encoded email (the HRIS list links with it, because employees added
 * there have a profile but no login account). The backend resolves both.
 *
 * Data
 *   GET   /api/employees/<key>/profile        header, stat strip, section grants
 *   PATCH /api/employees/<key>                edit personal / employment details
 *   GET   /api/payroll/compensations?email=   GET /api/payroll/payslips?email=
 *   GET   /api/user-settings/<email>          (documents list)
 *   GET   /api/user-settings/<email>/documents/<docType>
 *   Attendance / Check-in / Tasks / Submissions / Leave tabs are rendered by
 *   hrms-employee-tabs.js, which index.html loads before this file.
 *
 * Which tabs appear is decided by the server (`sections` in the profile
 * payload), never guessed from the client-side permission cache.
 */
(function () {
  'use strict';
  if (window.__hrmsHris) return;

  var HRIS_PATH = '/hr/hris';
  var TITLE = 'Employee Profile';
  var ID = { root: 'hrms-hris-root', style: 'hrms-hris-style', modal: 'hrms-hris-modal', toast: 'hrms-hris-toast' };

  var state = {
    key: '',          // profile key taken from the URL
    data: null,       // /api/employees/<key>/profile payload
    loading: false,
    error: null,
    tab: 'overview',
    tabCtx: null,     // { email, state } handed to HRMSEmployeeTabs
    payroll: null,    // { comps, slips, runs, error }
    docs: null,       // { rows, error }
    saving: false
  };

  /* ── route helpers (exported on window.__hrmsHris for tests) ──────────── */
  /* The signed-in user's own profile lives at /my-profile. React Router has no
     such route and bounces unknown paths to '/', so (like hrms-onboarding.js)
     we never hand this URL to React: we pushState without a popstate, and undo
     React's bounce on a deep link / refresh while `armed`. */
  var MY_PATH = '/my-profile';
  function requestedPath() {
    try {
      var nav = (performance.getEntriesByType('navigation') || [])[0];
      if (nav && nav.name) return new URL(nav.name, location.origin).pathname;
    } catch (_) {}
    return location.pathname;
  }
  var armed = String(requestedPath() || '').replace(/\/+$/, '') === MY_PATH;
  function trimSlash(p) { return String(p || '').replace(/\/+$/, ''); }
  function profileKey(pathname) {
    var p = trimSlash(pathname);
    if (p === MY_PATH) return sessionEmail();
    if (p.indexOf(HRIS_PATH + '/') !== 0) return '';
    var rest = p.slice(HRIS_PATH.length + 1);
    if (!rest || rest.indexOf('/') !== -1) return '';
    try { return decodeURIComponent(rest); } catch (_) { return rest; }
  }
  function isListRoute(pathname) { return trimSlash(pathname) === HRIS_PATH; }
  function profileUrl(key) {
    key = String(key == null ? '' : key).trim();
    if (!key) return HRIS_PATH;
    if (key.toLowerCase() === sessionEmail()) return MY_PATH;
    return HRIS_PATH + '/' + (/^\d+$/.test(key) ? key : encodeURIComponent(key));
  }
  function navTo(href) {
    if (trimSlash(href) === MY_PATH) {
      armed = true;
      history.pushState({}, '', MY_PATH);     // no popstate: React would bounce it to '/'
      schedule();
      if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
      return;
    }
    armed = false;
    if (window.__reactRouterNavigate) { window.__reactRouterNavigate(href); }
    else { history.pushState({}, '', href); window.dispatchEvent(new PopStateEvent('popstate')); }
  }

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(p, init) {
    init = init || {};
    init.headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    return fetch(p, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
          e.status = r.status;
          e.code = d && d.code;
          throw e;
        }
        return d;
      });
    });
  }
  function listOf(r) { return Array.isArray(r) ? r : ((r && Array.isArray(r.results)) ? r.results : []); }
  // Currency and date format come from Settings > General (hrms-company.js).
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    if (window.HRMSCompany) return window.HRMSCompany.money(v);
    try { return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
    catch (_) { return '₹' + Math.round(v); }
  }
  function fmtDate(v) { return (v && window.HRMSCompany) ? window.HRMSCompany.date(v) : (v || ''); }
  function sessionEmail() {
    try { return String((JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}).email || '').toLowerCase(); }
    catch (_) { return ''; }
  }
  function dash(v) { return (v == null || v === '') ? '<i class="hp-dash">—</i>' : esc(v); }
  function statusLabel(s) {
    if (s === 'active') return ['Active', 'green'];
    if (s === 'none') return ['No login account', 'orange'];
    return [s ? (s.charAt(0).toUpperCase() + s.slice(1)) : 'Unknown', 'red'];
  }

  /* ── tabs ───────────────────────────────────────────────────────────────── */
  var TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'attendance', label: 'Attendance', sec: 'attendance' },
    { id: 'checkin', label: 'Check In / Out', sec: 'attendance' },
    { id: 'leave', label: 'Leave', sec: 'leave' },
    { id: 'tasks', label: 'Tasks', sec: 'work' },
    { id: 'submissions', label: 'Work Submissions', sec: 'work' },
    { id: 'payroll', label: 'Payroll', sec: 'payroll' },
    { id: 'documents', label: 'Documents', sec: 'documents' },
    { id: 'onboarding', label: 'Onboarding', sec: 'onboarding', needs: 'onboarding' },
    { id: 'team', label: 'Team', sec: 'team' },
    { id: 'access', label: 'Access', needs: 'access' }
  ];
  function tabsFor(data) {
    var sec = (data && data.sections) || {};
    return TABS.filter(function (t) {
      if (t.sec && !sec[t.sec]) return false;
      if (t.needs && !(data && data[t.needs])) return false;
      return true;
    });
  }

  /* ── styles ─────────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var css = [
      'body[data-hris-profile="1"] .main > .content { display: none !important; }',
      '#' + ID.root + ' { flex: 1; overflow-y: auto; padding: 24px; color: var(--text, #0f172a); font-family: var(--font, "DM Sans", sans-serif); font-size: 13px; }',
      '#' + ID.root + ' * { box-sizing: border-box; }',
      '.hp-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }',
      '.hp-back { font-size: 12.5px; font-weight: 600; color: var(--text2, #475569); text-decoration: none; }',
      '.hp-back:hover { color: var(--accent, #4f8ef7); }',
      '.hp-loading, .hp-empty { color: var(--text3, #64748b); text-align: center; padding: 40px 12px; font-size: 13px; }',
      '.hp-errcard { text-align: center; padding: 40px 20px; }',
      '.hp-errcard h3 { margin: 0 0 8px; font-family: var(--font-d, "Syne", sans-serif); }',
      '.hp-errcard p { color: var(--text3, #64748b); margin: 0 0 16px; }',
      /* header */
      '.hp-head { display: flex; align-items: flex-start; gap: 18px; flex-wrap: wrap; margin-bottom: 16px; }',
      '.hp-av { width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; font-size: 24px; background: linear-gradient(135deg, var(--accent, #4f8ef7), var(--accent2, #7c5cff)); flex-shrink: 0; overflow: hidden; }',
      '.hp-av img { width: 100%; height: 100%; object-fit: cover; }',
      '.hp-who { flex: 1; min-width: 220px; }',
      '.hp-who h2 { margin: 0 0 4px; font-size: 22px; font-weight: 700; font-family: var(--font-d, "Syne", sans-serif); color: var(--text, #0f172a); }',
      '.hp-sub { font-size: 13px; color: var(--text2, #475569); margin-bottom: 10px; }',
      '.hp-chips { display: flex; gap: 6px; flex-wrap: wrap; }',
      '.hp-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
      /* strip */
      '.hp-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 18px; }',
      '.hp-tile { background: var(--bg2, #fff); border: 1px solid var(--border2, #e5e7eb); border-radius: var(--radius, 12px); padding: 14px 16px; }',
      '.hp-tl { font-size: 10.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--text3, #64748b); }',
      '.hp-tv { font-size: 22px; font-weight: 800; color: var(--text, #0f172a); margin-top: 4px; line-height: 1.15; font-family: var(--font-d, "Syne", sans-serif); }',
      '.hp-tv small { font-size: 12px; font-weight: 600; color: var(--text3, #64748b); }',
      '.hp-ts { font-size: 11.5px; color: var(--text3, #64748b); margin-top: 3px; }',
      /* tabs */
      '.hp-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border2, #e5e7eb); margin-bottom: 18px; overflow-x: auto; }',
      '.hp-tab { flex: 0 0 auto; background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; font-size: 13px; font-weight: 600; color: var(--text2, #475569); cursor: pointer; white-space: nowrap; }',
      '.hp-tab:hover { color: var(--text, #0f172a); }',
      '.hp-tab.on { color: var(--accent, #4f8ef7); border-bottom-color: var(--accent, #4f8ef7); }',
      '.hp-body { padding-bottom: 48px; }',
      /* overview */
      '.hp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }',
      '.hp-card { background: var(--bg2, #fff); border: 1px solid var(--border2, #e5e7eb); border-radius: var(--radius, 12px); padding: 16px 18px; }',
      '.hp-card.wide { grid-column: 1 / -1; }',
      '.hp-ch { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--text3, #64748b); margin-bottom: 10px; }',
      '.hp-ch a { font-size: 11px; text-transform: none; letter-spacing: 0; color: var(--accent, #4f8ef7); text-decoration: none; font-weight: 600; cursor: pointer; }',
      '.hp-row { display: grid; grid-template-columns: 130px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border2, #e5e7eb); font-size: 12.5px; }',
      '.hp-row:last-child { border-bottom: none; }',
      '.hp-k { color: var(--text3, #64748b); }',
      '.hp-v { color: var(--text, #0f172a); font-weight: 500; word-break: break-word; }',
      '.hp-dash { color: var(--text3, #94a3b8); font-style: normal; }',
      '.hp-link { color: var(--accent, #4f8ef7); text-decoration: none; font-weight: 600; cursor: pointer; }',
      '.hp-link:hover { text-decoration: underline; }',
      /* people */
      '.hp-people { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }',
      '.hp-person { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border2, #e5e7eb); border-radius: 10px; background: var(--bg3, #f8fafc); }',
      '.hp-person[data-key] { cursor: pointer; }',
      '.hp-person[data-key]:hover { border-color: var(--accent, #4f8ef7); }',
      '.hp-pav { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--accent, #4f8ef7), var(--accent2, #7c5cff)); flex-shrink: 0; }',
      '.hp-pn { font-weight: 600; font-size: 13px; color: var(--text, #0f172a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.hp-pm { font-size: 11.5px; color: var(--text3, #64748b); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      /* tables */
      '.hp-table-wrap { overflow-x: auto; }',
      '.hp-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }',
      '.hp-table th { text-align: left; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--text3, #64748b); border-bottom: 1px solid var(--border2, #e5e7eb); white-space: nowrap; }',
      '.hp-table td { padding: 10px 12px; border-bottom: 1px solid var(--border2, #e5e7eb); color: var(--text, #0f172a); vertical-align: middle; }',
      '.hp-table tr:last-child td { border-bottom: none; }',
      '.hp-stack { display: flex; flex-direction: column; gap: 14px; }',
      /* onboarding */
      '.hp-prog { height: 8px; border-radius: 999px; background: var(--bg3, #e5e7eb); overflow: hidden; margin: 8px 0 14px; }',
      '.hp-prog i { display: block; height: 100%; background: var(--success, #16a34a); }',
      '.hp-stages { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }',
      '.hp-stage { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--border2, #e5e7eb); border-radius: 8px; font-size: 12.5px; background: var(--bg3, #f8fafc); }',
      /* modal */
      '.hp-overlay { position: fixed; inset: 0; background: rgba(2, 6, 23, .6); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 100000; padding: 16px; }',
      '.hp-modal { background: var(--bg2, #fff); color: var(--text, #0f172a); border: 1px solid var(--border2, #e5e7eb); border-radius: 14px; width: min(760px, 100%); max-height: 92vh; display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(2, 6, 23, .4); font-family: var(--font, sans-serif); }',
      '.hp-mh { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border2, #e5e7eb); }',
      '.hp-mh h3 { margin: 0; font-size: 17px; font-weight: 700; font-family: var(--font-d, "Syne", sans-serif); }',
      '.hp-x { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border2, #e5e7eb); background: var(--bg3, #f1f5f9); color: var(--text2, #475569); cursor: pointer; font-size: 18px; line-height: 1; }',
      '.hp-mb { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; }',
      '.hp-fst { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--text3, #64748b); margin-bottom: 10px; }',
      '.hp-fst small { text-transform: none; letter-spacing: 0; font-weight: 500; }',
      '.hp-fgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }',
      '.hp-field { display: flex; flex-direction: column; gap: 5px; }',
      '.hp-field.wide { grid-column: 1 / -1; }',
      '.hp-field label { font-size: 11.5px; font-weight: 600; color: var(--text2, #475569); }',
      '.hp-field input, .hp-field select, .hp-field textarea { background: var(--bg3, #f8fafc); border: 1px solid var(--border2, #e5e7eb); color: var(--text, #0f172a); padding: 8px 11px; border-radius: 8px; font: inherit; font-size: 13px; outline: none; }',
      '.hp-field input:focus, .hp-field select:focus, .hp-field textarea:focus { border-color: var(--accent, #4f8ef7); }',
      '.hp-field input:disabled, .hp-field select:disabled, .hp-field textarea:disabled { opacity: .55; cursor: not-allowed; }',
      '.hp-mf { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border2, #e5e7eb); }',
      /* toast */
      '#' + ID.toast + ' { position: fixed; bottom: 24px; right: 24px; background: #065f46; color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,.3); z-index: 100001; }',
      '#' + ID.toast + '.err { background: #991b1b; }',
      /* HRIS list rows that link to a profile */
      'tr[data-hris-email] .av-row span { color: var(--accent, #4f8ef7); }',
      'tr[data-hris-email]:hover td { background: var(--bg3, rgba(148,163,184,.08)); }',
      '@media (max-width: 640px) { #' + ID.root + ' { padding: 14px; } .hp-row { grid-template-columns: 1fr; gap: 2px; } }'
    ].join('\n');
    var st = document.createElement('style');
    st.id = ID.style;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function toast(msg, isError) {
    var old = document.getElementById(ID.toast);
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = ID.toast;
    if (isError) el.className = 'err';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, isError ? 5000 : 3000);
  }

  /* ── data ───────────────────────────────────────────────────────────────── */
  function load(key) {
    state.key = key;
    state.data = null; state.error = null; state.loading = true;
    state.tab = 'overview'; state.tabCtx = null; state.payroll = null; state.docs = null;
    render();
    api('/api/employees/' + encodeURIComponent(key) + '/profile').then(function (d) {
      if (state.key !== key) return;
      state.data = d; state.loading = false;
      state.tabCtx = { email: d.email, state: {} };
      if (d.isSelf && trimSlash(location.pathname) !== MY_PATH) {
        armed = true;
        history.replaceState({}, '', MY_PATH);
      }
      render();
    }).catch(function (e) {
      if (state.key !== key) return;
      state.loading = false; state.error = e;
      render();
    });
  }

  /* ── render ─────────────────────────────────────────────────────────────── */
  function shell(inner) {
    return '<div class="hp-top"><a class="hp-back" href="' + HRIS_PATH + '" data-act="back">' + icon('back', 18) + 'Back to HRIS</a></div>' + inner;
  }
  function render() {
    var root = document.getElementById(ID.root);
    if (!root) return;
    if (state.loading && !state.data) { root.innerHTML = shell('<div class="hp-loading">Loading profile…</div>'); return; }
    if (state.error) {
      var e = state.error;
      var title = e.status === 404 ? 'Employee not found' : (e.status === 403 ? 'Access denied' : (e.status === 401 ? 'Please sign in' : 'Could not load this profile'));
      root.innerHTML = shell('<div class="card hp-errcard"><h3>' + esc(title) + '</h3><p>' + esc(e.message || '') + '</p>' +
        '<button class="btn-sm" data-act="reload">Try again</button></div>');
      return;
    }
    var d = state.data;
    if (!d) return;
    root.innerHTML = shell(headerHtml(d) + stripHtml(d) + tabsHtml(d) + '<div class="hp-body" data-hp="body"></div>');
    setTopTitle(d.isSelf ? 'My Profile' : TITLE);
    renderTab();
    if (window.__hrmsPresence && window.__hrmsPresence.paint) { try { window.__hrmsPresence.paint(); } catch (_) {} }
  }

  /* ── icons (inline, stroke = currentColor) ─────────────────────────────── */
  var IC = {
    back: 'M19 12H5M12 19l-7-7 7-7',
    mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
    edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    crown: 'M2 18h20M3 7l4.5 5L12 5l4.5 7L21 7l-2 11H5z',
    brief: 'M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    cal: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
    check: 'M3 3h18v18H3zM8 12l3 3 5-6',
    clock: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zM12 6v6l4 2',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 13h2',
    home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    leave: 'M12 2a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8zM12 10v10a2 2 0 0 0 4 0',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    folder: 'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    onb: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
    team: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    build: 'M3 21h18M5 21V5l7-3 7 3v16M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'
  };
  function icon(name, size) {
    return '<svg class="hp-ic" width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC[name] + '"/></svg>';
  }
  var TAB_ICONS = { overview: 'home', attendance: 'cal', checkin: 'clock', leave: 'leave', tasks: 'check', submissions: 'file',
                    payroll: 'wallet', documents: 'folder', onboarding: 'onb', team: 'team', access: 'shield' };

  function ensureStyleV2() {
    if (document.getElementById('hrms-hris-v2-style')) return;
    var R = '#' + ID.root;
    var css = [
      R + ' .hp-ic{flex-shrink:0;display:inline-block;vertical-align:middle;}',
      R + ' .hp-back{display:inline-flex;align-items:center;gap:7px;font-size:14px;color:var(--text,#0f172a);font-weight:600;}',
      R + ' .hp-back .hp-ic{color:var(--accent,#4f8ef7);}',
      /* header */
      R + ' .hp-head{align-items:center;gap:22px;margin-bottom:20px;}',
      R + ' .hp-avwrap{position:relative;flex-shrink:0;}',
      R + ' .hp-av{width:92px;height:92px;font-size:30px;box-shadow:0 6px 18px rgba(15,23,42,.18);}',
      R + ' .hp-who h2{font-size:30px;margin-bottom:6px;letter-spacing:-.3px;}',
      R + ' .hp-sub{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:14.5px;margin-bottom:12px;}',
      R + ' .hp-sub .hp-link{display:inline-flex;align-items:center;gap:5px;font-weight:600;}',
      R + ' .hp-chip{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:8px;background:var(--bg3,#f1f5f9);color:var(--text2,#334155);border:1px solid var(--border2,#e5e7eb);}',
      R + ' .hp-chip.blue{background:rgba(79,142,247,.12);color:var(--accent,#2563eb);border-color:rgba(79,142,247,.25);}',
      R + ' .hp-chip.green{background:rgba(34,197,94,.12);color:var(--success,#16a34a);border-color:rgba(34,197,94,.25);}',
      R + ' .hp-chip.green i{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block;}',
      R + ' .hp-chip.orange{background:rgba(247,149,79,.12);color:var(--accent4,#ea580c);border-color:rgba(247,149,79,.25);}',
      R + ' .hp-chip.purple{background:rgba(124,92,252,.12);color:var(--accent2,#7c3aed);border-color:rgba(124,92,252,.25);}',
      R + ' .hp-edit{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:9px;font-size:14px;}',
      /* stat tiles */
      R + ' .hp-strip{grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:16px;margin-bottom:22px;}',
      R + ' .hp-tile{display:flex;align-items:center;gap:18px;padding:18px 20px;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,.06);}',
      R + ' .hp-tile-ic{width:58px;height:58px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      R + ' .hp-tile-ic.green{background:rgba(34,197,94,.13);color:var(--success,#16a34a);}',
      R + ' .hp-tile-ic.blue{background:rgba(79,142,247,.13);color:var(--accent,#2563eb);}',
      R + ' .hp-tile-ic.orange{background:rgba(247,149,79,.14);color:#f59e0b;}',
      R + ' .hp-tile-ic.purple{background:rgba(124,92,252,.13);color:var(--accent2,#7c3aed);}',
      R + ' .hp-tv{font-size:28px;margin:2px 0;}',
      R + ' .hp-ts{font-size:13px;}',
      /* tabs */
      R + ' .hp-tabs{gap:6px;margin-bottom:20px;}',
      R + ' .hp-tab{display:inline-flex;align-items:center;gap:8px;padding:12px 16px;font-size:14px;font-weight:500;border-bottom-width:3px;}',
      R + ' .hp-tab .hp-ic{color:var(--text3,#64748b);}',
      R + ' .hp-tab.on .hp-ic{color:var(--accent,#4f8ef7);}',
      /* overview cards */
      R + ' .hp-ov{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:18px;}',
      R + ' .hp-ov .hp-card{padding:0;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.06);}',
      R + ' .hp-ov .hp-ch{margin:0;padding:15px 18px;border-bottom:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f8fafc);font-size:15px;font-weight:700;text-transform:none;letter-spacing:0;color:var(--text,#0f172a);}',
      R + ' .hp-ch-t{display:inline-flex;align-items:center;gap:10px;}',
      R + ' .hp-ch-t .hp-ic{color:var(--accent,#4f8ef7);}',
      R + ' .hp-ch .hp-chlink{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;color:var(--accent,#4f8ef7);cursor:pointer;text-decoration:none;}',
      R + ' .hp-cb{padding:8px 18px 14px;}',
      R + ' .hp-ov .hp-row{grid-template-columns:minmax(110px,40%) 1fr;padding:9px 0;font-size:13px;}',
      R + ' .hp-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--success,#16a34a);margin-right:7px;vertical-align:middle;}',
      R + ' .hp-dot.off{background:var(--danger,#dc2626);}',
      R + ' .hp-today-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:26px 10px;color:var(--text2,#475569);font-size:14px;}',
      R + ' .hp-today-art{width:120px;height:100px;}',
      /* team & reporting */
      R + ' .hp-org{padding:0;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.06);}',
      R + ' .hp-org .hp-ch{margin:0;padding:16px 20px;font-size:17px;font-weight:700;text-transform:none;letter-spacing:0;color:var(--text,#0f172a);}',
      R + ' .hp-org-body{display:grid;grid-template-columns:230px 1fr;gap:20px;padding:4px 20px 20px;align-items:start;}',
      R + ' .hp-org-stats{border:1px solid var(--border2,#e5e7eb);border-radius:12px;background:var(--bg3,#f8fafc);}',
      R + ' .hp-ostat{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      R + ' .hp-ostat:last-child{border-bottom:none;}',
      R + ' .hp-ostat small{display:block;font-size:12.5px;color:var(--text2,#475569);}',
      R + ' .hp-ostat b{display:block;font-size:26px;font-weight:800;color:var(--text,#0f172a);margin-top:2px;}',
      R + ' .hp-ostat .hp-tile-ic{width:42px;height:42px;border-radius:10px;}',
      R + ' .hp-tree{display:flex;flex-direction:column;align-items:center;overflow-x:auto;padding:4px 4px 6px;}',
      R + ' .hp-node{position:relative;display:flex;align-items:center;gap:12px;background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px 14px;box-shadow:0 2px 8px rgba(15,23,42,.07);text-align:left;min-width:0;}',
      R + ' .hp-node[data-act]{cursor:pointer;transition:border-color .15s,transform .15s;}',
      R + ' .hp-node[data-act]:hover{border-color:var(--accent,#4f8ef7);transform:translateY(-1px);}',
      R + ' .hp-node .hp-pav{width:52px;height:52px;font-size:16px;}',
      R + ' .hp-node-n{font-size:14px;font-weight:700;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      R + ' .hp-node-d{font-size:12px;color:var(--text2,#475569);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      R + ' .hp-node-c{font-size:11.5px;color:var(--text3,#64748b);margin-top:5px;}',
      R + ' .hp-tag{display:inline-block;margin-left:6px;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:5px;background:rgba(34,197,94,.13);color:var(--success,#16a34a);}',
      R + ' .hp-tag.team{background:rgba(79,142,247,.13);color:var(--accent,#2563eb);}',
      R + ' .hp-node-c .hp-tag:first-child{margin-left:0;}',
      R + ' .hp-you{display:inline-block;margin-top:6px;font-size:11px;font-weight:700;color:#fff;background:var(--accent,#2563eb);border-radius:5px;padding:2px 10px;}',
      R + ' .hp-root{min-width:230px;max-width:280px;}',
      R + ' .hp-stem{width:2px;height:22px;background:var(--accent,#4f8ef7);position:relative;}',
      R + ' .hp-stem::after{content:"";position:absolute;left:50%;top:-1px;width:9px;height:9px;border-radius:50%;border:2px solid var(--accent,#4f8ef7);background:var(--bg2,#fff);transform:translate(-50%,-50%);}',
      R + ' .hp-kids{display:flex;justify-content:center;gap:18px;padding-top:24px;width:100%;}',
      R + ' .hp-kid{position:relative;flex:1 1 0;min-width:170px;max-width:240px;}',
      R + ' .hp-kid::before{content:"";position:absolute;left:50%;top:-24px;height:24px;width:2px;background:var(--accent,#4f8ef7);}',
      R + ' .hp-kid::after{content:"";position:absolute;top:-24px;left:-9px;right:-9px;height:2px;background:var(--accent,#4f8ef7);}',
      R + ' .hp-kid:first-child::after{left:50%;}',
      R + ' .hp-kid:last-child::after{right:50%;}',
      R + ' .hp-kid:only-child::after{display:none;}',
      R + ' .hp-kid .hp-kdot{position:absolute;left:50%;top:-6px;width:9px;height:9px;border-radius:50%;border:2px solid var(--accent,#4f8ef7);background:var(--bg2,#fff);transform:translateX(-50%);z-index:1;}',
      R + ' .hp-kid .hp-node{width:100%;}',
      R + ' .hp-more{justify-content:center;color:var(--accent,#4f8ef7);font-weight:700;font-size:13px;min-height:78px;}',
      R + ' .hp-org-empty{color:var(--text3,#64748b);font-size:13px;padding:18px 0 4px;}',
      '@media (max-width:1280px){' + R + ' .hp-ov{grid-template-columns:repeat(2,minmax(0,1fr));}}',
      '@media (max-width:900px){' + R + ' .hp-org-body{grid-template-columns:1fr;}' + R + ' .hp-kids{flex-wrap:wrap;}' +
        R + ' .hp-kid::before,' + R + ' .hp-kid::after,' + R + ' .hp-kid .hp-kdot{display:none;}' + R + ' .hp-kid{min-width:200px;}}',
      '@media (max-width:640px){' + R + ' .hp-ov{grid-template-columns:1fr;}' + R + ' .hp-who h2{font-size:24px;}' + R + ' .hp-av{width:72px;height:72px;font-size:24px;}' +
        R + ' .hp-head{flex-direction:column;align-items:flex-start;gap:12px;}' + R + ' .hp-who{min-width:0;width:100%;}' +
        R + ' .hp-sub a{word-break:break-all;}' + R + ' .hp-actions{width:100%;}' + R + ' .hp-actions .hp-edit{flex:1;justify-content:center;}' +
        R + ' .hp-tile{padding:14px;gap:14px;}' + R + ' .hp-tile-ic{width:48px;height:48px;}' + R + ' .hp-kid{min-width:0;flex-basis:100%;max-width:none;}' +
        R + ' .hp-root{min-width:0;width:100%;max-width:none;}' + R + ' .hp-ov .hp-row{grid-template-columns:1fr;gap:2px;}' + R + ' .hp-v{word-break:break-word;}}',
      R + '{max-width:100%;box-sizing:border-box;}' + R + ' .hp-card{min-width:0;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'hrms-hris-v2-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function headerHtml(d) {
    ensureStyleV2();
    var p = d.person || {}, em = d.employment || {}, sec = d.sections || {};
    var av = p.profilePic
      ? '<div class="hp-av"><img src="' + esc(p.profilePic) + '" alt=""></div>'
      : '<div class="hp-av">' + esc(p.initials || 'EM') + '</div>';
    var chips = '';
    if (p.employeeId) chips += '<span class="hp-chip blue">' + esc(p.employeeId) + '</span>';
    if (p.accountStatus === 'active') chips += '<span class="hp-chip green"><i></i>Active</span>';
    else chips += '<span class="hp-chip orange">' + esc(statusLabel(p.accountStatus)[0]) + '</span>';
    if (p.role) chips += '<span class="hp-chip purple">' + icon('crown', 15) + esc(p.role) + '</span>';
    if (em.employmentType) chips += '<span class="hp-chip">' + icon('brief', 15) + esc(em.employmentType) + '</span>';
    var bits = [em.designation, em.department].filter(Boolean).map(esc).join(' · ');
    var actions = '';
    if (!d.isSelf && p.accountStatus === 'active') actions += '<button class="btn-sm" data-act="message">💬 Message</button>';
    if (sec.canEditPersonal || sec.canEditEmployment) actions += '<button class="btn-primary hp-edit" data-act="edit">' + icon('edit', 17) + 'Edit profile</button>';
    return '<div class="hp-head"><div class="hp-avwrap" data-hrms-presence="' + esc(p.email) + '">' + av + '</div>' +
      '<div class="hp-who"><h2>' + esc(p.name || p.email) + '</h2><div class="hp-sub">' + (bits ? '<span>' + bits + '</span><span>·</span>' : '') +
      '<a class="hp-link" href="mailto:' + esc(p.email) + '">' + icon('mail', 16) + esc(p.email) + '</a></div>' +
      '<div class="hp-chips">' + chips + '</div></div>' +
      '<div class="hp-actions">' + actions + '</div></div>';
  }

  function stripHtml(d) {
    var s = d.stats || {}, t = d.today, sec = d.sections || {};
    function tile(ic, color, label, value, subtext) {
      return '<div class="hp-tile"><div class="hp-tile-ic ' + color + '">' + icon(ic, 30) + '</div><div><div class="hp-tl">' + esc(label) + '</div>' +
        '<div class="hp-tv">' + value + '</div>' + (subtext ? '<div class="hp-ts">' + esc(subtext) + '</div>' : '') + '</div></div>';
    }
    var html = '<div class="hp-strip">';
    html += tile('cal', 'green', 'Attendance', s.attendancePct == null ? '--' : s.attendancePct + '%', 'Last ' + (s.attendanceDays || 30) + ' days');
    html += tile('check', 'blue', 'Open tasks', esc(s.openTasks == null ? '--' : s.openTasks), 'Assigned and not done');
    html += tile('clock', 'orange', 'Pending leave', esc(s.pendingLeave == null ? '--' : s.pendingLeave), 'Awaiting approval');
    if (sec.payroll && s.lastPayslip) {
      html += tile('wallet', 'purple', 'Last net pay', money(s.lastPayslip.netPay), (s.lastPayslip.period || '') + (s.lastPayslip.status ? ' · ' + s.lastPayslip.status : ''));
    } else {
      var today = t ? ((t.checkIn || '--') + ' / ' + (t.checkOut || '--')) : 'Not in';
      html += tile('clock', 'purple', 'Today', esc(today), t ? (t.status + (t.isWfh ? ' · WFH' : '')) : 'No attendance record yet');
    }
    return html + '</div>';
  }

  function tabsHtml(d) {
    return '<div class="hp-tabs">' + tabsFor(d).map(function (t) {
      var label = (t.id === 'access' && d.isSelf) ? 'My Access' : t.label;
      return '<button class="hp-tab' + (t.id === state.tab ? ' on' : '') + '" data-act="tab" data-tab="' + t.id + '">' + icon(TAB_ICONS[t.id] || 'file', 18) + esc(label) + '</button>';
    }).join('') + '</div>';
  }

  function renderTab() {
    var root = document.getElementById(ID.root);
    if (!root) return;
    var body = root.querySelector('[data-hp="body"]');
    var d = state.data;
    if (!body || !d) return;
    if (!tabsFor(d).some(function (t) { return t.id === state.tab; })) state.tab = 'overview';
    root.querySelectorAll('.hp-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); });

    var module = window.HRMSEmployeeTabs && window.HRMSEmployeeTabs.tabs.indexOf(state.tab) !== -1;
    if (module) {
      if (!state.tabCtx) return;
      window.HRMSEmployeeTabs.render(state.tab, body, state.tabCtx);
      return;
    }
    body.className = 'hp-body';
    body.removeAttribute('data-het-tab');
    switch (state.tab) {
      case 'payroll': renderPayroll(body); break;
      case 'documents': renderDocuments(body); break;
      case 'onboarding': body.innerHTML = onboardingHtml(d); break;
      case 'team': body.innerHTML = teamHtml(d); break;
      case 'access': body.innerHTML = accessHtml(d); break;
      case 'overview': body.innerHTML = overviewHtml(d); if (window.__hrmsPresence && window.__hrmsPresence.paint) { try { window.__hrmsPresence.paint(); } catch (_) {} } break;
      default: body.innerHTML = '<div class="hp-empty">This tab is unavailable (hrms-employee-tabs.js did not load).</div>';
    }
  }

  /* ── Overview ───────────────────────────────────────────────────────────── */
  function row(label, valueHtml) { return '<div class="hp-row"><span class="hp-k">' + esc(label) + '</span><span class="hp-v">' + valueHtml + '</span></div>'; }
  function personLink(c) {
    if (!c) return '<i class="hp-dash">—</i>';
    var inner = esc(c.name || c.email);
    return c.key ? '<a class="hp-link" data-act="person" data-key="' + esc(c.key) + '" href="' + esc(profileUrl(c.key)) + '">' + inner + '</a>' : inner;
  }
  function cardHead(ic, title, linkHtml) {
    return '<div class="hp-ch"><span class="hp-ch-t">' + icon(ic, 19) + esc(title) + '</span>' + (linkHtml || '') + '</div>';
  }
  function editLink() { return '<a class="hp-chlink" data-act="edit">' + icon('edit', 14) + 'Edit</a>'; }
  var TODAY_ART = '<svg class="hp-today-art" viewBox="0 0 120 100" aria-hidden="true">' +
    '<ellipse cx="62" cy="58" rx="46" ry="36" fill="var(--accent,#4f8ef7)" opacity=".08"/>' +
    '<rect x="34" y="28" width="56" height="50" rx="8" fill="var(--bg2,#fff)" stroke="var(--accent,#4f8ef7)" stroke-width="3"/>' +
    '<rect x="34" y="28" width="56" height="13" rx="6" fill="var(--accent,#4f8ef7)" opacity=".85"/>' +
    '<line x1="48" y1="22" x2="48" y2="33" stroke="var(--accent,#4f8ef7)" stroke-width="4" stroke-linecap="round"/>' +
    '<line x1="76" y1="22" x2="76" y2="33" stroke="var(--accent,#4f8ef7)" stroke-width="4" stroke-linecap="round"/>' +
    '<g fill="var(--accent,#4f8ef7)" opacity=".55"><rect x="44" y="49" width="9" height="8" rx="2"/><rect x="58" y="49" width="9" height="8" rx="2"/><rect x="72" y="49" width="9" height="8" rx="2"/><rect x="44" y="62" width="9" height="8" rx="2"/><rect x="58" y="62" width="9" height="8" rx="2"/></g>' +
    '<path d="M98 16l5-4M102 26h6" stroke="var(--accent,#4f8ef7)" stroke-width="3" stroke-linecap="round" opacity=".6"/></svg>';

  function overviewHtml(d) {
    var p = d.person || {}, em = d.employment || {}, a = d.account, org = d.org || {}, t = d.today, sec = d.sections || {};
    var html = '<div class="hp-ov">';
    html += '<div class="hp-card">' + cardHead('user', 'Personal Details', sec.canEditPersonal ? editLink() : '') + '<div class="hp-cb">' +
      row('Email', '<a class="hp-link" href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>') +
      row('Phone', dash(p.phone)) + row('Alternate email', dash(p.altEmail)) +
      row('Blood group', dash(p.bloodGroup)) + row('Address', dash(p.address)) + '</div></div>';
    html += '<div class="hp-card">' + cardHead('brief', 'Employment', sec.canEditEmployment ? editLink() : '') + '<div class="hp-cb">' +
      row('Employee ID', dash(p.employeeId)) + row('Department', dash(em.department)) + row('Designation', dash(em.designation)) +
      row('Level', dash(em.level)) + row('Type', dash(em.employmentType)) + row('Location', dash(em.location)) +
      row('Start date', dash(fmtDate(em.startDate))) +
      row('Manager', org.manager ? personLink(org.manager) + (org.manager.unlinked ? ' <span class="badge orange" title="Typed name, not linked to an employee record">unlinked</span>' : '') : dash(em.manager)) +
      (sec.payroll ? row('Annual CTC', em.annualCtc ? money(em.annualCtc) : dash('')) : '') + '</div></div>';
    if (a) {
      html += '<div class="hp-card">' + cardHead('shield', 'Account & Access') + '<div class="hp-cb">' +
        row('Role', dash(a.role)) +
        row('Status', '<span class="hp-dot' + (a.status === 'active' ? '' : ' off') + '"></span>' + esc(a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : '—')) +
        row('Sign-in', dash(a.authProvider)) + row('Company', dash(a.company)) + row('Created', dash(fmtDate(a.createdAt))) + '</div></div>';
    } else {
      html += '<div class="hp-card">' + cardHead('shield', 'Account & Access') + '<div class="hp-cb"><div class="hp-empty" style="padding:18px 0">' +
        (p.accountStatus === 'none' ? 'No login account yet. Activating this person from Onboarding, or adding them in Settings &rsaquo; User Access, creates one.' : 'Account details are visible to HR and admins.') +
        '</div></div></div>';
    }
    html += '<div class="hp-card">' + cardHead('cal', 'Today', sec.attendance ? '<a class="hp-chlink" data-act="tab" data-tab="checkin">Check-in details ' + icon('arrow', 14) + '</a>' : '') + '<div class="hp-cb">' +
      (t ? row('Status', '<span class="hp-dot' + (t.status === 'absent' ? ' off' : '') + '"></span>' + esc(t.status || '') + (t.isWfh ? ' · WFH' : '')) +
           row('Check in', dash(t.checkIn)) + row('Check out', dash(t.checkOut))
         : '<div class="hp-today-empty">' + TODAY_ART + '<span>No attendance record for today.</span></div>') + '</div></div>';
    html += '</div>';
    return html + workSetupHtml(d) + orgChartHtml(d);
  }

  /* ── Work setup (read-only summary; changes happen in Attendance) ─────── */
  var WS_DAYS = { onsite: 'Office only', remote: 'Any day, anywhere' };
  var HOME_TONE = { 'Approved': 'green', 'Pending review': 'orange', 'Change requested': 'orange', 'Rejected': 'red', 'Not set up': '' };
  function wsStyle() {
    if (document.getElementById('hrms-hris-ws-style')) return;
    var R = '#' + ID.root;
    var st = document.createElement('style');
    st.id = 'hrms-hris-ws-style';
    st.textContent = [
      R + ' .hp-ws{margin-bottom:18px;padding:0;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.06);}',
      R + ' .hp-ws .hp-ch{margin:0;padding:15px 18px;border-bottom:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f8fafc);font-size:15px;font-weight:700;text-transform:none;letter-spacing:0;color:var(--text,#0f172a);}',
      R + ' .hp-ws-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));}',
      R + ' .hp-ws-cell{padding:14px 16px;border-right:1px solid var(--border2,#e5e7eb);min-width:0;}',
      R + ' .hp-ws-cell:last-child{border-right:none;}',
      R + ' .hp-ws-k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);margin-bottom:8px;display:flex;align-items:center;gap:6px;}',
      R + ' .hp-ws-v{font-size:14px;font-weight:700;color:var(--text,#0f172a);margin-bottom:3px;}',
      R + ' .hp-ws-s{font-size:12px;color:var(--text2,#475569);line-height:1.5;}',
      R + ' .hp-ws-s a{color:var(--accent,#4f8ef7);font-weight:600;text-decoration:none;cursor:pointer;}',
      R + ' .hp-ws-list{display:flex;flex-direction:column;gap:5px;font-size:12px;}',
      R + ' .hp-ws-list span{display:flex;justify-content:space-between;gap:6px;}',
      R + ' .hp-ws-form{margin-top:10px;display:flex;flex-direction:column;gap:7px;}',
      R + ' .hp-ws-form textarea{background:var(--bg3,#f8fafc);border:1px solid var(--border2,#e5e7eb);color:var(--text,#0f172a);border-radius:7px;padding:7px 9px;font:inherit;font-size:12.5px;min-height:54px;resize:vertical;}',
      R + ' .hp-ws-err{color:var(--danger,#dc2626);font-size:12px;}',
      R + ' .hp-ws-cell .hp-chlink{display:inline-flex;margin-top:6px;font-size:12.5px;font-weight:600;color:var(--accent,#4f8ef7);cursor:pointer;text-decoration:none;}',
      R + ' .hp-ws-cell .hp-chlink:hover{text-decoration:underline;}',
      '@media (max-width:1280px){' + R + ' .hp-ws-grid{grid-template-columns:repeat(3,minmax(0,1fr));}' + R + ' .hp-ws-cell{border-bottom:1px solid var(--border2,#e5e7eb);}}',
      '@media (max-width:640px){' + R + ' .hp-ws-grid{grid-template-columns:1fr;}' + R + ' .hp-ws-cell{border-right:none;}}'
    ].join('\n');
    document.head.appendChild(st);
  }
  function wsDates(from, to) {
    if (!from) return '';
    return 'From ' + esc(fmtDate(from)) + (to ? ' to ' + esc(fmtDate(to)) : ' · ongoing');
  }
  function wsArrangement(a) {
    if (!a) return '<div class="hp-ws-v">Not set</div><div class="hp-ws-s">No arrangement on file — WFH needs an approved request.</div>';
    var kind = a.arrangement || 'onsite';
    var desc = WS_DAYS[kind];
    if (kind === 'hybrid') {
      desc = (a.remoteWeekdays && a.remoteWeekdays.length) ? 'Remote on ' + a.remoteWeekdays.join(', ')
        : (a.remoteDaysPerWeek ? a.remoteDaysPerWeek + ' remote day' + (a.remoteDaysPerWeek === 1 ? '' : 's') + ' a week' : 'No remote days set');
    }
    return '<div class="hp-ws-v">' + esc(kind.charAt(0).toUpperCase() + kind.slice(1)) + '</div><div class="hp-ws-s">' + esc(desc) + '<br>' + wsDates(a.effectiveFrom, a.effectiveTo) + '</div>';
  }
  function workSetupHtml(d) {
    var ws = d.workSetup;
    if (!ws) return '';
    wsStyle();
    var sh = ws.shift, home = ws.home || {}, today = ws.today;
    var upcoming = ws.upcomingArrangement
      ? '<div class="hp-ws-s" style="margin-top:6px">Changes to <b>' + esc(ws.upcomingArrangement.arrangement) + '</b> on ' + esc(fmtDate(ws.upcomingArrangement.effectiveFrom)) + '</div>' : '';
    var shiftHtml = sh
      ? '<div class="hp-ws-v">' + esc(sh.name) + '</div><div class="hp-ws-s">' +
        (sh.flexible ? esc(sh.flexHours) + ' h a day, flexible' : esc(sh.start) + ' – ' + esc(sh.end)) + '<br>' +
        (sh.isDefault ? 'Company default shift' : wsDates(sh.effectiveFrom, sh.effectiveTo)) + '</div>'
      : '<div class="hp-ws-v">—</div>';
    var wfh = ws.wfh || [];
    var wfhHtml = wfh.length
      ? '<div class="hp-ws-list">' + wfh.map(function (w) {
          var tone = w.status === 'Approved' ? 'green' : (w.status === 'Rejected' ? 'red' : 'orange');
          var range = w.fromDate === w.toDate ? fmtDate(w.fromDate) : fmtDate(w.fromDate) + ' – ' + fmtDate(w.toDate);
          return '<span><span>' + esc(range) + '</span><span class="badge ' + tone + '">' + esc(w.status) + '</span></span>';
        }).join('') + '</div>'
      : '<div class="hp-ws-s">No WFH requests in the last 30 days.</div>';
    var homeHtml = '<div class="hp-ws-v"><span class="badge ' + (HOME_TONE[home.status] || '') + '">' + esc(home.status || 'Not set up') + '</span></div><div class="hp-ws-s">';
    if (ws.canSeeLocation && home.latitude != null) {
      homeHtml += esc(Number(home.latitude).toFixed(5)) + ', ' + esc(Number(home.longitude).toFixed(5)) + ' · ' + esc(home.radiusMeters) + ' m<br>' +
        '<a href="https://www.google.com/maps?q=' + home.latitude + ',' + home.longitude + '" target="_blank" rel="noopener">View on map ↗</a><br>';
    }
    if (home.updatedAt) homeHtml += 'Updated ' + esc(fmtDate(home.updatedAt)) + '<br>';
    if (home.captureMethod === 'manual') homeHtml += 'Coordinates entered manually<br>';
    if (home.pendingChange) homeHtml += 'Change requested ' + esc(fmtDate(home.pendingChange.requestedAt)) + (home.pendingChange.reason ? ': “' + esc(home.pendingChange.reason) + '”' : '') + '<br>';
    homeHtml += '</div>';
    if (d.isSelf) {
      var st = home.status || 'Not set up';
      if (st === 'Approved') homeHtml += '<a class="hp-chlink" data-act="ws-home" data-mode="change">Request a change</a>';
      else if (st === 'Change requested' && home.pendingChange) homeHtml += '<a class="hp-chlink" data-act="ws-withdraw" data-id="' + home.pendingChange.id + '">Withdraw change request</a>';
      else if (st === 'Not set up' || st === 'Rejected') homeHtml += '<a class="hp-chlink" data-act="ws-home" data-mode="initial">Register my home location</a>';
      if (state.wsForm) {
        homeHtml += '<div class="hp-ws-form">' +
          (state.wsForm === 'change' ? '<textarea data-hp="ws-reason" placeholder="Why is your home location changing? HR sees this.">' + esc(state.wsReason || '') + '</textarea>' : '') +
          (state.wsManual
            ? '<div class="hp-ws-s">Enter your home\'s coordinates. In Google Maps, right-click (or long-press) your house and copy the numbers, e.g. <b>14.34385, 80.06623</b>.</div>' +
              '<input data-hp="ws-coords" placeholder="Latitude, longitude" style="background:var(--bg3,#f8fafc);border:1px solid var(--border2,#e5e7eb);color:var(--text,#0f172a);border-radius:7px;padding:7px 9px;font:inherit;font-size:12.5px">' +
              (state.wsForm === 'change' ? '' : '<input data-hp="ws-note" placeholder="Where are these from? e.g. Google Maps pin on my house" style="background:var(--bg3,#f8fafc);border:1px solid var(--border2,#e5e7eb);color:var(--text,#0f172a);border-radius:7px;padding:7px 9px;font:inherit;font-size:12.5px">') +
              '<div class="hp-ws-s">HR checks typed coordinates on a map before approving; they are marked as entered manually.</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-primary" data-act="ws-submit">Submit coordinates</button><button class="btn-sm" data-act="ws-mode" data-manual="0">Use my current location instead</button><button class="btn-sm" data-act="ws-cancel">Cancel</button></div>'
            : '<div class="hp-ws-s">Stand at home: your current position is captured. The ' + (state.wsForm === 'change' ? 'approved location stays in use' : 'location verifies nothing') + ' until HR approves.</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-primary" data-act="ws-submit">Use my current location</button><button class="btn-sm" data-act="ws-mode" data-manual="1">Enter latitude &amp; longitude instead</button><button class="btn-sm" data-act="ws-cancel">Cancel</button></div>') +
          '<div class="hp-ws-err" data-hp="ws-err">' + esc(state.wsMsg || '') + '</div></div>';
      }
    }
    var todayHtml = today
      ? '<div class="hp-ws-v">' + esc(today.mode) + (today.checkedIn ? ' · checked in' : '') + '</div><div class="hp-ws-s">Location ' +
        (today.locationVerified ? '<span class="badge green">verified</span>' : (today.locationStatus ? '<span class="badge orange">' + esc(today.locationStatus.toLowerCase()) + '</span>' : '<span class="badge red">not verified</span>')) + '</div>'
      : '<div class="hp-ws-v">Not checked in</div><div class="hp-ws-s">No attendance record today.</div>';
    var cell = function (ic, label, inner) { return '<div class="hp-ws-cell"><div class="hp-ws-k">' + icon(ic, 14) + esc(label) + '</div>' + inner + '</div>'; };
    return '<div class="hp-card hp-ws">' + cardHead('home', 'Work Setup', '<a class="hp-chlink" href="/employees/attendance" data-act="ws-nav">Attendance ' + icon('arrow', 14) + '</a>') +
      '<div class="hp-ws-grid">' +
        cell('brief', 'Arrangement', wsArrangement(ws.arrangement) + upcoming) +
        cell('clock', 'Shift', shiftHtml) +
        cell('cal', 'WFH requests', wfhHtml) +
        cell('home', 'Home location', homeHtml) +
        cell('check', 'Today', todayHtml) +
      '</div></div>';
  }
  function wsSubmit() {
    var root = document.getElementById(ID.root), d = state.data;
    var errEl = root && root.querySelector('[data-hp="ws-err"]');
    var setErr = function (m) { if (errEl) errEl.textContent = m; };
    var reasonEl = root && root.querySelector('[data-hp="ws-reason"]');
    var reason = reasonEl ? reasonEl.value.trim() : '';
    state.wsReason = reasonEl ? reasonEl.value : state.wsReason;   // survives re-rendering the form
    if (state.wsForm === 'change' && reason.length < 5) { setErr('Tell HR why it is changing.'); return; }
    var sent = function () {
      state.wsForm = null; state.wsManual = false; state.wsMsg = ''; state.wsReason = '';
      toast(reason ? 'Change request sent to HR' : 'Home location sent to HR for review');
      load(state.key);
    };
    if (state.wsManual) {
      var raw = ((root.querySelector('[data-hp="ws-coords"]') || {}).value || '').trim();
      var m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
      if (!m) { setErr('Enter latitude and longitude as two numbers, e.g. 14.34385, 80.06623'); return; }
      var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { setErr('Latitude is between -90 and 90, longitude between -180 and 180.'); return; }
      var note = ((root.querySelector('[data-hp="ws-note"]') || {}).value || '').trim() || reason;
      if (note.length < 5) { setErr('Tell HR where these coordinates came from.'); return; }
      setErr('Sending…');
      api('/api/attendance/home-locations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: d.email, latitude: lat, longitude: lng, captureMethod: 'manual',
                               manualNote: note, reason: reason })
      }).then(sent).catch(function (e) { setErr(e.message); });
      return;
    }
    if (!navigator.geolocation) { setErr('This browser cannot share your location.'); return; }
    setErr('Getting your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      api('/api/attendance/home-locations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: d.email, latitude: pos.coords.latitude, longitude: pos.coords.longitude,
                               accuracy: pos.coords.accuracy, reason: reason })
      }).then(sent).catch(function (e) {
        if (e.code === 'POSITION_TOO_VAGUE') {
          // The device only offered an internet-based position: switch to typing it.
          state.wsManual = true;
          state.wsMsg = 'Your device could not get a precise position. Enter your latitude and longitude below.';
          renderTab();
          return;
        }
        setErr(e.message);
      });
    }, function (e) { setErr(e.code === 1 ? 'Location permission was denied.' : 'Could not get your location. Try again outdoors or near a window.'); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  /* Team & reporting structure: the person, their direct reports beneath. */
  var ORG_MAX = 5;
  function orgTag(c) {
    if (c._direct) return '<span class="hp-tag">Direct report</span>';
    return (c.teams || []).map(function (n) { return '<span class="hp-tag team">' + esc(n) + '</span>'; }).join('');
  }
  function orgNode(c, extraCls, badge) {
    var attrs = c.key ? ' data-act="person" data-key="' + esc(c.key) + '"' : '';
    return '<div class="hp-node ' + (extraCls || '') + '"' + attrs + ' data-email="' + esc(c.email || '') + '">' +
      '<span class="hp-avwrap" data-hrms-presence="' + esc(c.email || '') + '"><span class="hp-pav">' + esc(c.initials || 'EM') + '</span></span>' +
      '<div style="min-width:0"><div class="hp-node-n">' + esc(c.name || c.email) + '</div>' +
      '<div class="hp-node-d">' + esc(c.designation || c.department || '') + '</div>' +
      (badge || ('<div class="hp-node-c">' + (c.employeeId ? esc(c.employeeId) : '') + orgTag(c) + '</div>')) + '</div></div>';
  }
  function orgChartHtml(d) {
    var p = d.person || {}, em = d.employment || {}, org = d.org || {};
    var reports = org.reports || [];
    var depts = org.departments || [];
    // Beneath the person: their direct reports (reporting line), then members
    // of the teams they lead (work line). Someone who is both shows once.
    var kids = [], seen = {};
    reports.forEach(function (r) { seen[r.email] = true; kids.push(Object.assign({}, r, { _direct: true })); });
    (org.teamMembers || []).forEach(function (m) {
      if (seen[m.email]) { kids.forEach(function (k) { if (k.email === m.email) k.teams = m.teams; }); return; }
      seen[m.email] = true; kids.push(m);
    });
    function stat(label, value, ic, color) {
      return '<div class="hp-ostat"><div><small>' + esc(label) + '</small><b>' + esc(value) + '</b></div><div class="hp-tile-ic ' + color + '">' + icon(ic, 20) + '</div></div>';
    }
    var me = { key: d.key, email: p.email, name: p.name, initials: p.initials, designation: em.designation, department: em.department, employeeId: p.employeeId };
    var tree = '<div class="hp-tree">' + orgNode(me, 'hp-root', d.isSelf ? '<span class="hp-you">You</span>' : (p.employeeId ? '<div class="hp-node-c">' + esc(p.employeeId) + '</div>' : ''));
    if (kids.length) {
      var shown = kids.slice(0, ORG_MAX);
      tree += '<div class="hp-stem"></div><div class="hp-kids">' + shown.map(function (r) {
        return '<div class="hp-kid"><span class="hp-kdot"></span>' + orgNode(r) + '</div>';
      }).join('') + (kids.length > ORG_MAX
        ? '<div class="hp-kid"><span class="hp-kdot"></span><div class="hp-node hp-more" data-act="tab" data-tab="team">+' + (kids.length - ORG_MAX) + ' more</div></div>' : '') + '</div>';
    } else {
      tree += '<div class="hp-org-empty">No one reports to ' + esc(d.isSelf ? 'you' : (p.name || 'this person')) + ', and ' + (d.isSelf ? 'you do' : 'they do') + ' not lead a team yet. Set managers in Edit profile, or team leads on the HRIS page.</div>';
    }
    tree += '</div>';
    return '<div class="hp-card hp-org">' + cardHead('team', 'Team & Reporting Structure', '<a class="hp-chlink" data-act="tab" data-tab="team">Open team ' + icon('arrow', 14) + '</a>') +
      '<div class="hp-org-body"><div class="hp-org-stats">' +
        stat('Direct Reports', reports.length, 'user', 'green') +
        stat('Total Team Size', org.treeSize != null ? org.treeSize : kids.length, 'team', 'blue') +
        stat('Departments', depts.length, 'build', 'purple') +
      '</div>' + tree + '</div></div>';
  }

  /* ── Team ───────────────────────────────────────────────────────────────── */
  function personCard(c) {
    var attrs = c.key ? ' data-act="person" data-key="' + esc(c.key) + '"' : '';
    return '<div class="hp-person"' + attrs + '><div class="hp-pav">' + esc(c.initials || 'EM') + '</div><div style="min-width:0">' +
      '<div class="hp-pn">' + esc(c.name || c.email) + '</div><div class="hp-pm">' + esc([c.designation, c.department].filter(Boolean).join(' · ') || c.email || '') + '</div></div></div>';
  }
  function teamHtml(d) {
    var org = d.org || {}, reports = org.reports || [];
    var html = '<div class="hp-stack">';
    html += '<div class="hp-card"><div class="hp-ch">Reports to</div>' +
      (org.manager ? '<div class="hp-people">' + personCard(org.manager) + '</div>' : '<div class="hp-empty" style="padding:10px 0">No manager recorded.</div>') + '</div>';
    html += '<div class="hp-card"><div class="hp-ch">Direct reports <span>' + reports.length + '</span></div>' +
      (reports.length ? '<div class="hp-people">' + reports.map(personCard).join('') + '</div>' : '<div class="hp-empty" style="padding:10px 0">Nobody lists ' + esc((d.person || {}).name || 'this person') + ' as their manager.</div>') + '</div>';
    var teams = org.teams || [];
    html += '<div class="hp-card"><div class="hp-ch">Teams <span>' + teams.length + '</span></div>' +
      (teams.length ? '<div class="hp-table-wrap"><table class="hp-table"><thead><tr><th>Team</th><th>Department</th><th>Lead</th><th>Members</th><th></th></tr></thead><tbody>' +
        teams.map(function (t) {
          return '<tr><td><b>' + esc(t.name) + '</b>' + (t.status === 'archived' ? ' <span class="badge">archived</span>' : '') + '</td><td>' + dash(t.department) + '</td><td>' +
            (t.lead ? personLink(t.lead) : '<i class="hp-dash">—</i>') + '</td><td>' + esc(t.memberCount) + '</td><td>' + (t.isLead ? '<span class="badge blue">Lead</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="hp-empty" style="padding:10px 0">Not in any team yet. HR adds people to teams from the HRIS page.</div>') + '</div>';
    if (org.manager && org.manager.unlinked) {
      html += '<div class="hp-empty" style="padding:4px 0 0;font-size:11.5px">The manager shown is a typed name that is not linked to an employee record yet.</div>';
    }
    return html + '</div>';
  }

  /* ── Access: role, what you can do, and what you can edit here ─────────── */
  function accessHtml(d) {
    var a = d.access;
    if (!a) return '<div class="hp-empty">Access details are visible to the employee and administrators.</div>';
    var you = d.isSelf ? 'You' : esc((d.person || {}).name || 'This person');
    var html = '<div class="hp-stack">';
    html += '<div class="hp-card"><div class="hp-ch"><span class="hp-ch-t">' + icon('shield', 18) + 'Role</span>' +
      (a.superAdmin ? '<span class="badge purple" style="font-size:12px">Super Admin · full access</span>' : '') + '</div>' +
      '<div style="font-size:15px;font-weight:700;margin-bottom:4px">' + esc(a.role || 'No role assigned') + '</div>' +
      '<div class="hp-empty" style="padding:0;text-align:left">' + you + ' ' + (d.isSelf ? 'have' : 'has') + ' ' + a.grantedCount + ' of ' + a.totalCount +
      ' permissions. Roles are changed by an administrator in Settings &rsaquo; User Access.</div></div>';
    html += '<div class="hp-card"><div class="hp-ch">What ' + (d.isSelf ? 'you can' : 'they can') + ' edit on this profile</div>' +
      '<div class="hp-table-wrap"><table class="hp-table"><thead><tr><th>Information</th><th>Can edit</th><th>How</th></tr></thead><tbody>' +
      (a.canEdit || []).map(function (e) {
        return '<tr><td>' + esc(e.item) + '</td><td>' + (e.allowed ? '<span class="badge green">Yes</span>' : '<span class="badge">No</span>') + '</td>' +
          '<td style="color:var(--text2,#475569)">' + esc(e.how) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    html += '<div class="hp-card"><div class="hp-ch">What ' + (d.isSelf ? 'you' : 'they') + ' can do in the app</div>' +
      ((a.modules || []).length ? (a.modules || []).map(function (m) {
        return '<div style="margin-bottom:12px"><div style="font-weight:700;font-size:13px;margin-bottom:6px">' + esc(m.module) +
          ' <span class="hp-empty" style="padding:0;font-weight:500">(' + m.permissions.length + ')</span></div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px">' + m.permissions.map(function (p) {
            return '<span class="badge blue" title="' + esc(p.code) + '">' + esc(p.name) + '</span>';
          }).join('') + '</div></div>';
      }).join('') : '<div class="hp-empty">No permissions are granted to this role.</div>') + '</div>';
    return html + '</div>';
  }

  /* ── Onboarding ─────────────────────────────────────────────────────────── */
  function onboardingHtml(d) {
    var ob = d.onboarding;
    if (!ob) return '<div class="hp-empty">No onboarding record is linked to this email.</div>';
    var pct = ob.total ? Math.round((ob.completed || 0) / ob.total * 100) : 0;
    var html = '<div class="hp-stack">';
    html += '<div class="hp-card"><div class="hp-ch">Onboarding progress <a href="/onboarding/candidates">Open in Onboarding &rarr;</a></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12.5px"><span><b>' + esc(ob.status || '') + '</b>' + (ob.candidateCode ? ' · ' + esc(ob.candidateCode) : '') + '</span><span>' + ob.completed + ' / ' + ob.total + ' stages</span></div>' +
      '<div class="hp-prog"><i style="width:' + pct + '%"></i></div>' +
      '<div class="hp-stages">' + (ob.stages || []).map(function (s) {
        return '<div class="hp-stage"><span>' + esc(s.label) + '</span><span class="badge ' + (s.status === 'Completed' ? 'green' : (s.status === 'In Progress' ? 'orange' : '')) + '">' + esc(s.status) + '</span></div>';
      }).join('') + '</div>' +
      row('Joining date', dash(fmtDate(ob.joiningDate))) + row('Client', dash(ob.client)) + row('Recruiter', dash(ob.recruiter)) + '</div>';
    var assets = ob.assets || [];
    html += '<div class="hp-card"><div class="hp-ch">IT assets <span>' + assets.length + '</span></div>' +
      (assets.length ? '<div class="hp-table-wrap"><table class="hp-table"><thead><tr><th>Source</th><th>Client</th><th>Assets</th><th>Asset ID</th><th>Issued</th><th>Status</th></tr></thead><tbody>' +
        assets.map(function (a) {
          return '<tr><td>' + esc(a.source) + '</td><td>' + dash(a.client) + '</td><td>' + esc((a.assets || []).join(', ')) + '</td><td>' + dash(a.assetId) + '</td><td>' + dash(fmtDate(a.issuedDate)) + '</td><td><span class="badge ' + (/returned/i.test(a.status) ? 'orange' : 'green') + '">' + esc(a.status) + '</span></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="hp-empty" style="padding:10px 0">No assets allocated.</div>') + '</div>';
    return html + '</div>';
  }

  /* ── Payroll ────────────────────────────────────────────────────────────── */
  function renderPayroll(body) {
    var d = state.data, enc = encodeURIComponent(d.email);
    if (!state.payroll) {
      body.innerHTML = '<div class="hp-loading">Loading payroll…</div>';
      var err = null;
      function grab(p) { return api(p).then(listOf).catch(function (e) { err = err || e; return []; }); }
      Promise.all([grab('/api/payroll/compensations?email=' + enc), grab('/api/payroll/payslips?email=' + enc), grab('/api/payroll/runs')])
        .then(function (r) {
          var runs = {};
          r[2].forEach(function (run) { runs[run.id] = run.period_label || ''; });
          state.payroll = { comps: r[0], slips: r[1], runs: runs, error: err };
          if (state.tab === 'payroll') renderTab();
        });
      return;
    }
    var pr = state.payroll;
    if (pr.error && !pr.comps.length && !pr.slips.length) {
      body.innerHTML = '<div class="hp-empty">' + esc(pr.error.status === 403 ? 'You do not have access to payroll details.' : pr.error.message) + '</div>';
      return;
    }
    var c = pr.comps.slice().sort(function (a, b) { return String(b.effective_from || '').localeCompare(String(a.effective_from || '')); })[0];
    var html = '<div class="hp-stack">';
    html += '<div class="hp-card"><div class="hp-ch">Compensation</div>' + (c
      ? '<div class="hp-grid">' +
        '<div>' + row('Annual CTC', money(c.annual_ctc)) + row('Basic (monthly)', money(c.base_amount)) + row('Pay frequency', dash(c.pay_frequency)) + row('Effective from', dash(fmtDate(c.effective_from))) + row('Status', dash(c.status)) + '</div>' +
        '<div>' + row('PAN', dash(c.pan_number)) + row('UAN', dash(c.uan_number)) + row('PF account', dash(c.pf_account_number)) + row('Bank', dash(c.bank_name)) + row('Account no.', dash(c.bank_account_number)) + '</div>' +
        '</div>'
      : '<div class="hp-empty" style="padding:10px 0">No compensation record. Add one from Payroll &rsaquo; Compensation.</div>') + '</div>';
    var slips = pr.slips.slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    html += '<div class="hp-card"><div class="hp-ch">Payslips <span>' + slips.length + '</span></div>' +
      (slips.length ? '<div class="hp-table-wrap"><table class="hp-table"><thead><tr><th>Period</th><th>Paid days</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Status</th><th></th></tr></thead><tbody>' +
        slips.map(function (p) {
          var period = p.run_period || pr.runs[p.run] || ('Run #' + p.run);
          var st = String(p.status || 'draft');
          return '<tr><td><b>' + esc(period) + '</b></td><td>' + esc(p.paid_days == null ? '—' : p.paid_days) + '</td><td>' + money(p.gross_earnings) + '</td><td>' + money(p.total_deductions) + '</td><td><b>' + money(p.net_pay) + '</b></td>' +
            '<td><span class="badge ' + (/paid|approved/i.test(st) ? 'green' : 'orange') + '">' + esc(st) + '</span></td>' +
            '<td style="text-align:right"><button class="btn-sm" data-act="payslip" data-id="' + esc(p.id) + '">View</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="hp-empty" style="padding:10px 0">No payslips generated yet.</div>') + '</div>';
    body.innerHTML = html + '</div>';
  }

  /* ── Documents ──────────────────────────────────────────────────────────── */
  function renderDocuments(body) {
    var d = state.data;
    if (!state.docs) {
      body.innerHTML = '<div class="hp-loading">Loading documents…</div>';
      api('/api/user-settings/' + encodeURIComponent(d.email))
        .then(function (r) { state.docs = { rows: (r && r.documents) || [] }; })
        .catch(function (e) { state.docs = { rows: [], error: e }; })
        .then(function () { if (state.tab === 'documents') renderTab(); });
      return;
    }
    var rows = state.docs.rows;
    var manage = d.isSelf ? '<div class="hp-empty" style="padding:0 0 10px;text-align:left">Upload or replace your documents in ' +
      '<a class="hp-link" href="/settings" data-act="ws-settings">Settings &rsaquo; My Documents</a>.</div>' : '';
    if (state.docs.error) {
      body.innerHTML = '<div class="hp-empty">' + esc(state.docs.error.status === 403 ? 'You do not have access to this employee\'s documents.' : state.docs.error.message) + '</div>';
      return;
    }
    body.innerHTML = '<div class="hp-card"><div class="hp-ch">Documents <span>' + rows.length + '</span></div>' + manage +
      (rows.length ? '<div class="hp-table-wrap"><table class="hp-table"><thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th></th></tr></thead><tbody>' +
        rows.map(function (doc) {
          return '<tr><td><b>' + esc(doc.docType) + '</b></td><td>' + dash(doc.fileName) + '</td><td>' + dash(fmtDate(doc.uploadedAt)) + '</td>' +
            '<td style="text-align:right"><button class="btn-sm" data-act="doc" data-type="' + esc(doc.docType) + '" data-name="' + esc(doc.fileName || doc.docType) + '">Open</button></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="hp-empty" style="padding:10px 0">No documents uploaded. Documents are added from Settings &rsaquo; Profile.</div>') + '</div>';
  }
  function openDocument(docType, name) {
    // Open the tab synchronously (inside the click) so popup blockers allow it,
    // then point it at the decoded file once it arrives.
    var win = null;
    try { win = window.open('', '_blank'); } catch (_) { win = null; }
    api('/api/user-settings/' + encodeURIComponent(state.data.email) + '/documents/' + encodeURIComponent(docType)).then(function (doc) {
      var data = doc && doc.fileData;
      if (!data) throw new Error('This document has no file content.');
      var mime = doc.fileMime || 'application/octet-stream', b64 = data;
      var m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/.exec(data);
      if (m) { mime = m[1] || mime; b64 = m[2]; }
      var bin = atob(b64), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([arr], { type: mime }));
      if (win) { win.location = url; }
      else { var a = document.createElement('a'); a.href = url; a.download = name || docType; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) {
      if (win) { try { win.close(); } catch (_) {} }
      toast(e.message || 'Could not open the document', true);
    });
  }

  /* ── Edit modal ─────────────────────────────────────────────────────────── */
  var LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
  var EMP_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern', 'Consultant'];

  function closeModal() { var m = document.getElementById(ID.modal); if (m) m.remove(); state.saving = false; state.editPic = undefined; }
  /* Shrinks a chosen photo to 256 px (JPEG) so the stored data URL stays small. */
  function readPhoto(file, done) {
    if (!file || !/^image\//.test(file.type)) { toast('Choose an image file', true); return; }
    if (file.size > 8 * 1024 * 1024) { toast('That image is over 8 MB', true); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var s = 256, c = document.createElement('canvas'), k = Math.min(img.width, img.height);
        c.width = c.height = s;
        c.getContext('2d').drawImage(img, (img.width - k) / 2, (img.height - k) / 2, k, k, 0, 0, s, s);
        done(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { toast('That image could not be read', true); };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function openEdit() {
    var d = state.data;
    if (!d) return;
    var sec = d.sections || {}, canP = !!sec.canEditPersonal, canE = !!sec.canEditEmployment;
    if (!canP && !canE) return;
    closeModal();
    var p = d.person || {}, em = d.employment || {};

    function field(name, label, value, opts) {
      opts = opts || {};
      var dis = opts.disabled ? ' disabled' : '';
      var inner;
      if (opts.type === 'textarea') {
        inner = '<textarea name="' + name + '" rows="2"' + dis + '>' + esc(value) + '</textarea>';
      } else if (opts.options) {
        var list = opts.options.slice();
        if (value && list.indexOf(value) === -1) list.unshift(value);
        inner = '<select name="' + name + '"' + dis + '>' + list.map(function (o) { return '<option value="' + esc(o) + '"' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      } else {
        inner = '<input type="' + (opts.type || 'text') + '" name="' + name + '" value="' + esc(value) + '"' + dis + (opts.step ? ' step="' + opts.step + '"' : '') + '>';
      }
      return '<div class="hp-field' + (opts.wide ? ' wide' : '') + '"><label>' + esc(label) + '</label>' + inner + '</div>';
    }

    var html = '<div class="hp-overlay" id="' + ID.modal + '"><div class="hp-modal" role="dialog" aria-modal="true" aria-label="Edit profile">' +
      '<div class="hp-mh"><h3>Edit profile</h3><button class="hp-x" data-m="close" aria-label="Close">&times;</button></div>' +
      '<form class="hp-mb" data-m="form" onsubmit="return false">' +
        (canP ? '<div style="display:flex;align-items:center;gap:14px">' +
          '<div class="hp-av" data-m="pic" style="width:64px;height:64px;font-size:20px">' + (p.profilePic ? '<img src="' + esc(p.profilePic) + '" alt="">' : esc(p.initials || 'EM')) + '</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;gap:6px">' +
            '<label class="btn-sm" style="cursor:pointer">Change photo<input type="file" accept="image/*" data-m="pic-file" style="display:none"></label>' +
            (p.profilePic ? '<button type="button" class="btn-sm" data-m="pic-remove">Remove</button>' : '') +
          '</div><small style="font-size:11px;color:var(--text3)">JPG or PNG. Shown everywhere your avatar appears.</small></div></div>' : '') +
        '<div><div class="hp-fst">Personal details' + (canP ? '' : ' <small>(read only)</small>') + '</div><div class="hp-fgrid">' +
          field('firstName', 'First name', p.firstName || '', { disabled: !canP }) +
          field('lastName', 'Last name', p.lastName || '', { disabled: !canP }) +
          field('phone', 'Phone', p.phone || '', { disabled: !canP }) +
          field('altEmail', 'Alternate email', p.altEmail || '', { type: 'email', disabled: !canP }) +
          field('bloodGroup', 'Blood group', p.bloodGroup || '', { disabled: !canP }) +
          field('address', 'Address', p.address || '', { type: 'textarea', wide: true, disabled: !canP }) +
        '</div></div>' +
        (d.isSelf ? '<div class="hp-ws-s" style="padding:10px 12px;border:1px dashed var(--border2,#e5e7eb);border-radius:8px;color:var(--text2,#475569);font-size:12.5px">' +
          'Employment details — department, designation, manager, level, location and start date — are managed by HR.</div>' :
        '<div><div class="hp-fst">Employment' + (canE ? '' : ' <small>(HR only)</small>') + '</div><div class="hp-fgrid">' +
          field('employeeId', 'Employee ID', p.employeeId || '', { disabled: !canE }) +
          field('department', 'Department', em.department || '', { disabled: !canE }) +
          field('designation', 'Designation', em.designation || '', { disabled: !canE }) +
          '<div class="hp-field"><label>Manager</label><select name="managerEmail" data-hp="mgr"' + (canE ? '' : ' disabled') + '>' +
            '<option value="">— No manager —</option>' +
            (em.managerEmail ? '<option value="' + esc(em.managerEmail) + '" selected>' + esc(em.manager || em.managerEmail) + '</option>' : '') +
          '</select>' + (em.manager && !em.managerEmail ? '<small style="color:var(--warn,#b7791f);font-size:11px">Currently “' + esc(em.manager) + '” (not linked) — pick the person.</small>' : '') + '</div>' +
          field('level', 'Level', em.level || 'L4', { options: LEVELS, disabled: !canE }) +
          field('employmentType', 'Employment type', em.employmentType || 'Full-time', { options: EMP_TYPES, disabled: !canE }) +
          field('location', 'Location', em.location || '', { disabled: !canE }) +
          field('startDate', 'Start date', em.startDate || '', { type: 'date', disabled: !canE }) +
          ('annualCtc' in em ? field('annualCtc', 'Annual CTC (₹)', em.annualCtc || '', { type: 'number', step: '0.01', disabled: !canE }) : '') +
        '</div></div>') +
      '</form>' +
      '<div class="hp-mf"><button class="btn-sm" data-m="close">Cancel</button><button class="btn-primary" data-m="save">Save changes</button></div>' +
    '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var modal = document.getElementById(ID.modal);
    var picInput = modal.querySelector('[data-m="pic-file"]');
    if (picInput) picInput.addEventListener('change', function () {
      readPhoto(picInput.files && picInput.files[0], function (url) {
        state.editPic = url;
        var box = modal.querySelector('[data-m="pic"]');
        if (box) box.innerHTML = '<img src="' + url + '" alt="">';
      });
    });
    modal.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-m="pic-remove"]');
      if (rm) { state.editPic = ''; var bx = modal.querySelector('[data-m="pic"]'); if (bx) bx.textContent = p.initials || 'EM'; rm.remove(); return; }
      var el = e.target.closest('[data-m]');
      if (e.target === modal) { closeModal(); return; }
      if (!el) return;
      var m = el.getAttribute('data-m');
      if (m === 'close') closeModal();
      else if (m === 'save') saveEdit(modal, el);
    });
    document.addEventListener('keydown', escClose);
    if (canE) fillManagerOptions(modal, d.email, em.managerEmail || '');
    var first = modal.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
    if (first) first.focus();
  }
  // Manager choices: every active employee except this one and anyone who
  // already reports up to them (the server rejects those too).
  function fillManagerOptions(modal, selfEmail, current) {
    var sel = modal.querySelector('[data-hp="mgr"]');
    if (!sel) return;
    api('/api/org/people').then(function (rows) {
      rows = listOf(rows);
      var under = {}, byEmail = {};
      rows.forEach(function (r) { byEmail[r.email] = r; });
      rows.forEach(function (r) {
        var cur = r.email, hops = 0;
        while (cur && hops++ < 50) {
          if (cur === selfEmail) { under[r.email] = true; break; }
          cur = byEmail[cur] ? byEmail[cur].managerEmail : '';
        }
      });
      var html = '<option value="">— No manager —</option>';
      rows.forEach(function (r) {
        if (r.email === selfEmail || under[r.email]) return;
        var label = r.name + (r.designation ? ' · ' + r.designation : '') + ' (' + r.email + ')';
        html += '<option value="' + esc(r.email) + '"' + (r.email === current ? ' selected' : '') + '>' + esc(label) + '</option>';
      });
      sel.innerHTML = html;
      // Search box: narrows the list by name, title, department or email.
      if (!modal.querySelector('[data-hp="mgr-q"]')) {
        var q = document.createElement('input');
        q.type = 'search'; q.placeholder = 'Search people…'; q.setAttribute('data-hp', 'mgr-q');
        q.style.marginBottom = '6px';
        sel.parentNode.insertBefore(q, sel);
        q.oninput = function () {
          var needle = q.value.trim().toLowerCase();
          Array.prototype.forEach.call(sel.options, function (o) {
            o.hidden = !!needle && o.value !== '' && o.value !== sel.value && o.textContent.toLowerCase().indexOf(needle) === -1;
          });
        };
      }
      if (rows.length <= 1) sel.insertAdjacentHTML('afterend', '<small style="font-size:11px;color:var(--text3)">No other employees to choose from yet.</small>');
    }).catch(function () { sel.insertAdjacentHTML('afterend', '<small style="font-size:11px;color:var(--danger)">Could not load people.</small>'); });
  }
  function escClose(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escClose); } }

  function saveEdit(modal, btn) {
    if (state.saving) return;
    var d = state.data, p = d.person || {}, em = d.employment || {};
    var orig = Object.assign({}, em, {
      firstName: p.firstName, lastName: p.lastName, phone: p.phone, altEmail: p.altEmail,
      bloodGroup: p.bloodGroup, address: p.address, employeeId: p.employeeId
    });
    var body = {};
    modal.querySelectorAll('[name]').forEach(function (inp) {
      if (inp.disabled) return;
      var was = orig[inp.name] == null ? '' : String(orig[inp.name]);
      if (was !== String(inp.value)) body[inp.name] = inp.value;
    });
    if (state.editPic !== undefined) body.profilePic = state.editPic;
    if (!Object.keys(body).length) { closeModal(); return; }
    state.saving = true;
    btn.disabled = true; btn.textContent = 'Saving…';
    api('/api/employees/' + encodeURIComponent(state.key), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      if (d.isSelf) {
        // The topbar, drawer and every avatar follow the new photo and name at once.
        try {
          if (body.profilePic !== undefined) {
            localStorage.setItem('hrms_profile_pic', body.profilePic || '');
            window.dispatchEvent(new CustomEvent('hrmsProfilePic', { detail: body.profilePic || '' }));
          }
          if (body.firstName !== undefined || body.lastName !== undefined) {
            var full = ((body.firstName !== undefined ? body.firstName : p.firstName || '') + ' ' +
                        (body.lastName !== undefined ? body.lastName : p.lastName || '')).trim();
            if (full) {
              localStorage.setItem('hrms_profile_name', full);
              window.dispatchEvent(new CustomEvent('hrmsProfileName', { detail: full }));
            }
          }
        } catch (_) {}
      }
      state.editPic = undefined;
      closeModal();
      toast('Profile updated');
      load(state.key);
    }).catch(function (e) {
      state.saving = false;
      btn.disabled = false; btn.textContent = 'Save changes';
      toast(e.message || 'Could not save', true);
    });
  }

  /* ── clicks inside the page ─────────────────────────────────────────────── */
  function onRootClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'back') { e.preventDefault(); navTo(HRIS_PATH); }
    else if (act === 'tab') { e.preventDefault(); state.tab = el.getAttribute('data-tab'); renderTab(); }
    else if (act === 'person') { var k = el.getAttribute('data-key'); if (k) { e.preventDefault(); navTo(profileUrl(k)); } }
    else if (act === 'message') { e.preventDefault(); navTo('/employees/chat'); }
    else if (act === 'edit') { openEdit(); }
    else if (act === 'payslip') { window.open('/api/payroll/payslips/' + encodeURIComponent(el.getAttribute('data-id')) + '/pdf', '_blank'); }
    else if (act === 'doc') { openDocument(el.getAttribute('data-type'), el.getAttribute('data-name')); }
    else if (act === 'reload') { load(state.key); }
    else if (act === 'ws-home') { e.preventDefault(); state.wsForm = el.getAttribute('data-mode'); renderTab(); }
    else if (act === 'ws-cancel') { state.wsForm = null; state.wsManual = false; state.wsMsg = ''; state.wsReason = ''; renderTab(); }
    else if (act === 'ws-mode') {
      var rEl = document.querySelector('#' + ID.root + ' [data-hp="ws-reason"]');
      if (rEl) state.wsReason = rEl.value;
      state.wsManual = el.getAttribute('data-manual') === '1'; state.wsMsg = ''; renderTab();
    }
    else if (act === 'ws-settings') { e.preventDefault(); window.__hrmsSettingsTab = 'My Documents'; navTo('/settings'); }
    else if (act === 'ws-submit') { wsSubmit(); }
    else if (act === 'ws-nav') { e.preventDefault(); navTo('/employees/attendance'); }
    else if (act === 'ws-withdraw') {
      api('/api/attendance/home-locations/changes/' + el.getAttribute('data-id'), { method: 'DELETE' })
        .then(function () { toast('Change request withdrawn'); load(state.key); })
        .catch(function (err2) { toast(err2.message, true); });
    }
  }

  /* React owns .topbar-title. Assigning textContent swaps out React's text node,
     after which React's own updates land on a detached node and the title is
     stuck (Settings showed "My Profile"). So change only the text node's value,
     and on leaving the profile put React's title back if it is still ours. */
  var titleOurs = null, titleSaved = null;
  function writeTitle(tt, text) {
    var n = tt.firstChild;
    if (n && n.nodeType === 3 && tt.childNodes.length === 1) n.nodeValue = text;
    else tt.textContent = text;
  }
  function setTopTitle(want) {
    var tt = document.querySelector('.topbar-title');
    if (!tt || tt.textContent === want) return;
    if (titleOurs === null || tt.textContent !== titleOurs) titleSaved = tt.textContent;
    writeTitle(tt, want);
    titleOurs = want;
  }
  function restoreTopTitle() {
    if (titleOurs === null) return;
    var tt = document.querySelector('.topbar-title');
    if (tt && tt.textContent === titleOurs) {
      var path = trimSlash(location.pathname);
      writeTitle(tt, path === '/settings' ? 'Settings' : (titleSaved || ''));
    }
    titleOurs = null; titleSaved = null;
  }

  /* The left sidebar's Settings entry opens the right-hand drawer (which lists
     every settings section) instead of navigating to the Settings page.
     Registered on window in the capture phase so it runs before the generic
     document-level Settings click handler in hrms-checkin.js. Only the app's
     own /settings link is affected (not e.g. Onboarding › Settings). */
  function drawerOpen() {
    var back = document.querySelector('.hrms-drawer-backdrop');
    if (!back) return false;
    var cs = getComputedStyle(back);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && back.getClientRects().length > 0;
  }
  window.addEventListener('click', function (e) {
    var t0 = e.target;
    if (!t0 || !t0.closest) return;
    if (!t0.closest('.sidebar a.nav-item[href="/settings"]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (drawerOpen()) { closeDrawer(); return; }
    var av = document.querySelector('.topbar .av');
    if (av) av.click();
  }, true);

  /* "My Profile" everywhere opens this page for the signed-in user. */
  function myProfileUrl() { return sessionEmail() ? MY_PATH : ''; }
  function closeDrawer() {
    var back = document.querySelector('.hrms-drawer-backdrop');
    if (back) back.click();
  }
  document.addEventListener('click', function (e) {
    var t0 = e.target;
    if (!t0 || !t0.closest) return;
    var item = t0.closest('.hrms-drawer-litem');
    var head = t0.closest('.hrms-drawer-av, .hrms-drawer-name');
    var isProfileItem = item && (item.textContent || '').trim() === 'My Profile';
    if (!isProfileItem && !head) return;
    var url = myProfileUrl();
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    closeDrawer();
    navTo(url);
  }, true);
  /* My Profile has its own page, so the Settings page never shows the old
     "My Profile" section: switch to the first real settings section (React's
     own hrmsSettingsTab event, detail 'settings' = General / Email / first
     non-profile tab). If the user has no other section, open /my-profile. */
  var profileSwitch = 0;
  function settingsBanner() {
    if ((location.pathname || '').replace(/\/+$/, '') !== '/settings') { profileSwitch = 0; return; }
    var titles = document.querySelectorAll('.content .card-title');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || '').trim() !== 'My Profile') continue;
      if (profileSwitch === 0) {
        profileSwitch = 1;
        window.dispatchEvent(new CustomEvent('hrmsSettingsTab', { detail: 'settings' }));
        return;
      }
      if (profileSwitch === 1) {
        profileSwitch = 2;
        var u0 = myProfileUrl();
        if (u0) { navTo(u0); return; }
      }
      var card = titles[i].closest('.card');
      if (!card || card.querySelector('[data-hp-banner]')) return;
      var b = document.createElement('div');
      b.setAttribute('data-hp-banner', '1');
      b.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:10px 14px;border-radius:9px;background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.25);font-size:13px;color:var(--text)';
      b.innerHTML = '<span>Your full profile — employment, work setup, team and what you can access — has its own page.</span>' +
        '<button class="btn-primary" style="font-size:12.5px;padding:6px 14px">Open My Profile</button>';
      b.querySelector('button').onclick = function () { var u = myProfileUrl(); if (u) navTo(u); };
      titles[i].parentNode.insertBefore(b, titles[i].nextSibling);
      return;
    }
  }

  /* ── HRIS list (/hr/hris): make the React table rows open the profile ───── */
  var listCache = null, listFetchedAt = 0, listLoading = false;
  function decorateList() {
    var table = document.querySelector('.content table');
    if (!table) return;
    var rows = table.querySelectorAll('tbody tr');
    if (!rows.length) return;
    ensureStyle();
    var unmatched = false;
    rows.forEach(function (tr) {
      if (tr.hasAttribute('data-hris-email') || tr.hasAttribute('data-hris-skip')) return;
      var nameEl = tr.querySelector('td .av-row span') || tr.querySelector('td');
      var name = nameEl ? (nameEl.textContent || '').trim().toLowerCase() : '';
      if (!name || tr.children.length < 3) { tr.setAttribute('data-hris-skip', '1'); return; }   // the "no employees" placeholder row
      var email = listCache && listCache[name];
      if (!email) { unmatched = true; return; }
      tr.setAttribute('data-hris-email', email);
      tr.style.cursor = 'pointer';
      tr.title = 'Open employee profile';
      tr.addEventListener('click', function (ev) {
        if (ev.target.closest('a, button, input, select')) return;
        navTo(profileUrl(email));
      });
    });
    if ((!listCache || unmatched) && !listLoading && Date.now() - listFetchedAt > 5000) {
      listLoading = true;
      api('/api/employees').then(function (list) {
        listCache = {};
        listOf(list).forEach(function (u) {
          var nm = ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email || '';
          if (nm && u.email) listCache[nm.toLowerCase()] = u.email;
        });
      }).catch(function () { listCache = listCache || {}; })
        .then(function () { listLoading = false; listFetchedAt = Date.now(); schedule(); });
    }
  }

  /* ── mount / unmount ────────────────────────────────────────────────────── */
  function ensureLayout() {
    var here = trimSlash(location.pathname);
    if (armed && (here === '' || here === '/')) {
      history.replaceState({}, '', MY_PATH);   // React bounced /my-profile to '/'
      here = MY_PATH;
      if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
    } else if (armed && here !== MY_PATH) {
      armed = false;                             // a genuine navigation elsewhere
    }
    var key = profileKey(location.pathname);
    if (!key) {
      if (document.body.hasAttribute('data-hris-profile')) {
        document.body.removeAttribute('data-hris-profile');
        var old = document.getElementById(ID.root);
        if (old) old.remove();
        closeModal();
        state.key = ''; state.data = null; state.tabCtx = null;
      }
      restoreTopTitle();
      if (isListRoute(location.pathname)) decorateList();
      settingsBanner();
      return;
    }
    document.body.setAttribute('data-hris-profile', '1');
    var main = document.querySelector('.main');
    if (!main) return;
    ensureStyle();
    setTopTitle((state.data && state.data.isSelf) ? 'My Profile' : TITLE);
    var root = document.getElementById(ID.root);
    if (!root) {
      root = document.createElement('div');
      root.id = ID.root;
      root.addEventListener('click', onRootClick);
      main.appendChild(root);
    } else if (root.parentElement !== main) {
      main.appendChild(root);
    }
    if (state.key !== key) load(key);
    else if (state.data && state.data.isSelf && trimSlash(location.pathname) !== MY_PATH) {
      // Your own profile reached by its HRIS URL (email or id): show it as /my-profile.
      armed = true;
      history.replaceState({}, '', MY_PATH);
    }
    else if (!root.childNodes.length) render();
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () { scheduled = false; ensureLayout(); });
  }

  window.addEventListener('popstate', function () {
    armed = trimSlash(location.pathname) === MY_PATH;   // back/forward is a real navigation
    schedule();
  });
  // A click on any link or sidebar item is a genuine navigation: stop
  // re-asserting /my-profile, otherwise going to the Dashboard ('/') would be
  // mistaken for React bouncing the deep link (capture phase, before React).
  document.addEventListener('click', function (e) {
    if (!armed || !e.target || !e.target.closest) return;
    var a = e.target.closest('a[href], .nav-item, .hrms-drawer-litem');
    if (!a) return;
    var href = a.getAttribute && a.getAttribute('href');
    if (href && trimSlash(href) === MY_PATH) return;
    if (a.classList && a.classList.contains('hrms-drawer-litem') && (a.textContent || '').trim() === 'My Profile') return;
    armed = false;
  }, true);
  window.addEventListener('hrmsCompanyApplied', function () { if (state.data) render(); });
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var res = orig.apply(this, arguments);
      setTimeout(schedule, 0);
      return res;
    };
  });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (muts) {
      var root = document.getElementById(ID.root), modal = document.getElementById(ID.modal);
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if ((root && root.contains(t)) || (modal && modal.contains(t))) continue;
        schedule();
        return;
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();

  window.__hrmsHris = {
    profileKey: profileKey,
    MY_PATH: MY_PATH,
    profileUrl: profileUrl,
    isListRoute: isListRoute,
    tabsFor: tabsFor,
    reload: function () { if (state.key) load(state.key); }
  };
})();
