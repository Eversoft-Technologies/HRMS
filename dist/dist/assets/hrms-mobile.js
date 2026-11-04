/**
 * hrms-mobile.js
 * Mobile/responsive helper for the HRMS dashboard. Pairs with responsive.css.
 *
 * On small screens the sidebar (already position:fixed) becomes a slide-in
 * drawer. This script injects a hamburger button into the .topbar and a
 * backdrop, and toggles `body.sidebar-open`. All visual rules live in
 * responsive.css — this only wires up the toggle. Same no-rebuild injection
 * approach as hrms-live.js / google-auth.js.
 */
(function () {
  'use strict';

  var BTN_ID = 'hrms-hamburger';
  var BACKDROP_ID = 'hrms-sidebar-backdrop';
  var MQ = '(max-width: 768px)';

  function isMobile() {
    return window.matchMedia(MQ).matches;
  }
  function openDrawer() { document.body.classList.add('sidebar-open'); syncButtonState(); if (window.__hrmsTabbar) window.__hrmsTabbar(); }
  function closeDrawer() {
    var was = document.body.classList.contains('sidebar-open');
    document.body.classList.remove('sidebar-open'); syncButtonState();
    if (was && window.__hrmsTabbar) window.__hrmsTabbar();
  }
  function toggleDrawer() {
    if (document.body.classList.contains('sidebar-open')) closeDrawer();
    else openDrawer();
  }

  function ensureBackdrop() {
    if (document.getElementById(BACKDROP_ID)) return;
    var bd = document.createElement('div');
    bd.id = BACKDROP_ID;
    bd.addEventListener('click', closeDrawer);
    document.body.appendChild(bd);
  }

  function ensureButton() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;                       // auth pages have no topbar
    if (document.getElementById(BTN_ID)) {
      // Keep it as the first child even if React re-renders the topbar.
      var existing = document.getElementById(BTN_ID);
      if (topbar.firstChild !== existing) topbar.insertBefore(existing, topbar.firstChild);
      return;
    }
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.setAttribute('aria-label', 'Open menu');
    b.setAttribute('aria-expanded', 'false');
    // Both icons ship together and responsive.css shows whichever matches the
    // drawer state, so the same button closes what it opened. Swapping
    // innerHTML on each toggle would fight the sync() timer below, which
    // re-runs every 800ms and would undo it.
    b.innerHTML =
      '<svg class="hrms-burger-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>' +
      '<svg class="hrms-burger-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDrawer();
    });
    topbar.insertBefore(b, topbar.firstChild);
  }

  /* Keep the button's label honest about what pressing it will do. */
  function syncButtonState() {
    var b = document.getElementById(BTN_ID);
    if (!b) return;
    var open = document.body.classList.contains('sidebar-open');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  /* ── App-style bottom tab bar (phones) ─────────────────────────────────
     Home · Check-in · Leave · Chat · More, like a native app. Each tab is the
     sidebar's own link (so routing and role visibility stay React's): a tab
     whose page this role cannot see is simply not shown. "More" opens the
     full menu (the sidebar drawer). Ours, appended to <body>; React nodes are
     never moved or removed. */
  var TABBAR_ID = 'hrms-tabbar';
  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    checkin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    leave: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="m9 15 2 2 4-4"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
    tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
    attendance: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    more: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'
  };
  var TAB_DEFS = [
    { key: 'home', label: 'Home', hrefs: ['/'] },
    { key: 'checkin', label: 'Check-in', hrefs: ['/employees/checkin'], alt: { key: 'attendance', label: 'Attendance', hrefs: ['/employees/attendance'] } },
    { key: 'leave', label: 'Leave', hrefs: ['/employees/leave'], alt: { key: 'tasks', label: 'Tasks', hrefs: ['/employees/tasks'] } },
    { key: 'chat', label: 'Chat', hrefs: ['/employees/chat'] }
  ];
  var chatUnread = 0, unreadAt = 0;

  function navLink(href) {
    var links = document.querySelectorAll('.sidebar a.nav-item');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('href') || '') === href) return links[i];
    }
    return null;
  }
  function resolveTabs() {
    var out = [];
    TAB_DEFS.forEach(function (d) {
      var pick = navLink(d.hrefs[0]) ? d : (d.alt && navLink(d.alt.hrefs[0]) ? d.alt : null);
      if (pick) out.push(pick);
    });
    out.push({ key: 'more', label: 'More' });
    return out;
  }
  function isActive(tab) {
    var path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    if (tab.key === 'more') return document.body.classList.contains('sidebar-open');
    if (document.body.classList.contains('sidebar-open')) return false;
    return tab.hrefs.some(function (h) { return h === '/' ? path === '/' : (path === h || path.indexOf(h + '/') === 0); });
  }
  function checkedIn() {
    try { var s = JSON.parse(localStorage.getItem('hrms_checked_in') || 'null'); return !!(s && s.checkedIn); }
    catch (_) { return false; }
  }
  function svg(key) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[key] + '</svg>';
  }

  function renderTabbar() {
    var bar = document.getElementById(TABBAR_ID);
    var loggedIn = !!document.querySelector('.topbar') && !!document.querySelector('.sidebar');
    if (!isMobile() || !loggedIn) {
      if (bar) bar.style.display = 'none';
      document.body.classList.remove('hrms-has-tabbar');
      return;
    }
    var tabs = resolveTabs();
    var sig = tabs.map(function (t) {
      return t.key + (isActive(t) ? '*' : '') + (t.key === 'chat' ? ':' + chatUnread : '') + (t.key === 'checkin' ? ':' + checkedIn() : '');
    }).join('|');
    if (!bar) {
      bar = document.createElement('nav');
      bar.id = TABBAR_ID;
      bar.setAttribute('aria-label', 'Main');
      bar.addEventListener('click', onTabClick);
      document.body.appendChild(bar);
    }
    bar.style.display = '';
    document.body.classList.add('hrms-has-tabbar');
    if (bar.getAttribute('data-sig') === sig) return;
    bar.setAttribute('data-sig', sig);
    bar.innerHTML = tabs.map(function (t) {
      var on = isActive(t);
      var badge = t.key === 'chat' && chatUnread > 0
        ? '<span class="tb-badge">' + (chatUnread > 99 ? '99+' : chatUnread) + '</span>' : '';
      var dot = t.key === 'checkin' && checkedIn() ? '<span class="tb-dot" title="Checked in"></span>' : '';
      return '<button type="button" class="tb' + (on ? ' on' : '') + '" data-tab="' + t.key + '"' +
        (t.hrefs ? ' data-href="' + t.hrefs[0] + '"' : '') + (on ? ' aria-current="page"' : '') + '>' +
        '<span class="tb-ic">' + svg(t.key) + badge + dot + '</span><span class="tb-l">' + t.label + '</span></button>';
    }).join('');
  }

  function onTabClick(e) {
    var b = e.target.closest && e.target.closest('button[data-tab]');
    if (!b) return;
    var key = b.getAttribute('data-tab');
    if (key === 'more') { toggleDrawer(); renderTabbar(); return; }
    var wasOn = b.classList.contains('on');
    closeDrawer();
    var link = navLink(b.getAttribute('data-href'));
    if (link) link.click();
    else { history.pushState({}, '', b.getAttribute('data-href')); window.dispatchEvent(new PopStateEvent('popstate')); }
    // Tapping the tab you're already on scrolls back to the top, like an app.
    var c = document.querySelector('.content');
    if (c && wasOn) c.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(renderTabbar, 60);
  }

  function refreshUnread(force) {
    if (!isMobile() || document.hidden || !document.getElementById(TABBAR_ID)) return;
    if (!force && Date.now() - unreadAt < 30000) return;
    if (!navLink('/employees/chat')) return;
    unreadAt = Date.now();
    fetch('/api/chat/unread', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.total === 'number') { chatUnread = d.total; renderTabbar(); } })
      .catch(function () {});
  }

  function sync() {
    ensureBackdrop();
    ensureButton();
    renderTabbar();
    refreshUnread(false);
    // Never leave the drawer "open" when we're back on a desktop width.
    if (!isMobile()) closeDrawer();
    syncButtonState();
  }

  // Close the drawer after tapping a nav link (delegated — survives re-renders).
  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    var navItem = e.target.closest && e.target.closest('.nav-item');
    if (navItem) setTimeout(closeDrawer, 60);
  });

  // Close on Escape.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
  });

  // Close on SPA navigation.
  var _pushState = history.pushState;
  history.pushState = function () {
    _pushState.apply(history, arguments);
    closeDrawer();
    setTimeout(renderTabbar, 0);
    // Reading a chat clears its unread count: refresh the badge soon after.
    if (/\/employees\/chat/.test(location.pathname)) setTimeout(function () { refreshUnread(true); }, 2500);
  };
  window.addEventListener('popstate', function () { closeDrawer(); setTimeout(renderTabbar, 0); });
  window.addEventListener('resize', function () { if (!isMobile()) closeDrawer(); });

  window.__hrmsTabbar = function () { renderTabbar(); };
  window.addEventListener('hrmsCheckinToggle', function () { setTimeout(renderTabbar, 50); });
  window.addEventListener('storage', function (e) { if (e.key === 'hrms_checked_in') renderTabbar(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshUnread(true); });

  function boot() {
    sync();
    // The topbar mounts after React hydrates — keep ensuring the button.
    setInterval(sync, 800);
    setTimeout(sync, 600);
    setTimeout(sync, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
