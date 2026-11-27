/**
 * hrms-sidecar.js — one routing/mounting helper for pages the React bundle
 * does not know about (Tickets, Timesheets, Org Chart, …).
 *
 * Same proven approach as hrms-onboarding.js, written once:
 *   - Our page renders into its own root appended to `.main`; React's
 *     `.content` is HIDDEN (style only, never removed — removing React nodes
 *     crashes the app) and given back when we leave.
 *   - Sidebar links to our routes are intercepted in the capture phase and
 *     navigated with history.pushState, which React Router does not observe,
 *     so its catch-all cannot bounce us to '/'.
 *   - A deep link / F5 boots React at our URL and React redirects to '/'; the
 *     originally requested path (Navigation Timing) is re-asserted once.
 *
 * Usage (from a module overlay):
 *   HRMSSidecar.register({
 *     base: '/tickets',                  // owns /tickets and /tickets/*
 *     title: 'Tickets',                  // topbar title while mounted
 *     mount: function (root, sub) {},    // build the page; sub = '' or '/123'
 *     update: function (root, sub) {},   // optional: same page, new sub-path
 *     unmount: function () {}            // optional cleanup
 *   });
 *   HRMSSidecar.go('/tickets/42');       // navigate in-app
 */
(function () {
  'use strict';
  if (window.HRMSSidecar) return;

  var pages = [];
  var active = null;          // { page, root, sub }
  var armed = null;           // path we intend to be on (undo React's bounce)

  function norm(p) { return String(p || '').replace(/\/+$/, '') || '/'; }
  function match(pathname) {
    // Longest base wins, so '/my-pay/tax' is not swallowed by '/my-pay'.
    var p = norm(pathname), best = null;
    for (var i = 0; i < pages.length; i++) {
      var b = pages[i].base;
      if ((p === b || p.indexOf(b + '/') === 0) && (!best || b.length > best.page.base.length)) {
        best = { page: pages[i], sub: p === b ? '' : p.slice(b.length) };
      }
    }
    return best;
  }
  function requestedPath() {
    try {
      var nav = (performance.getEntriesByType('navigation') || [])[0];
      if (nav && nav.name) return new URL(nav.name, location.origin).pathname;
    } catch (_) {}
    return location.pathname;
  }
  (function () { var m = match(requestedPath()); armed = m ? norm(requestedPath()) : null; })();
  // Query/hash of the page load, so a deep link's filters (e.g.
  // /employees/tasks/issue/5?view=table) survive React's bounce to '/'.
  var bootTail = (function () {
    try {
      var nav = (performance.getEntriesByType('navigation') || [])[0];
      if (nav && nav.name) { var u = new URL(nav.name, location.origin); return u.search + u.hash; }
    } catch (_) {}
    return '';
  })();
  function pathOf(href) { return String(href || '').split('#')[0].split('?')[0]; }

  function setTitle(t) {
    var el = document.querySelector('.topbar .page-title, .topbar h1, .topbar-title');
    if (el && t && el.textContent !== t) { el.setAttribute('data-sc-old', el.getAttribute('data-sc-old') || el.textContent); el.textContent = t; }
  }
  function restoreTitle() {
    var el = document.querySelector('.topbar [data-sc-old]');
    if (el) { el.textContent = el.getAttribute('data-sc-old'); el.removeAttribute('data-sc-old'); }
  }
  function markActiveNav(base) {
    // hrms-sidebar.js lights "Settings" while the account drawer is open;
    // don't take that highlight away (it hands it back when the drawer closes).
    if (window.__hrmsSettingsDrawerOpen && window.__hrmsSettingsDrawerOpen()) return;
    var payrollSections = ['/payroll/compliance', '/payroll/banking', '/payroll/us', '/payroll/separations'];
    for (var i = 0; base && i < payrollSections.length; i++) {
      if (base === payrollSections[i] || base.indexOf(payrollSections[i] + '/') === 0) {
        base = '/payroll/run';
        break;
      }
    }
    document.querySelectorAll('.sidebar a.nav-item').forEach(function (a) {
      var h = a.getAttribute('href') || '';
      var on = !!base && (h === base || h.indexOf(base + '/') === 0);
      if (a.classList.contains('active') !== on) a.classList.toggle('active', on);
    });
  }

  // index.html hides React's page from the first paint on routes we own
  // (html.hrms-sc-boot, from the bases remembered below) so the old screen
  // never flashes before our page mounts. Show it again once we know.
  function reveal() { document.documentElement.classList.remove('hrms-sc-boot'); }
  function rememberBases() {
    try {
      var keep = JSON.parse(localStorage.getItem('hrms_sc_bases') || '[]');
      if (!Array.isArray(keep)) keep = [];
      pages.forEach(function (pg) { if (pg.base !== '/' && keep.indexOf(pg.base) === -1) keep.push(pg.base); });
      localStorage.setItem('hrms_sc_bases', JSON.stringify(keep.slice(-60)));
    } catch (_) {}
  }

  function leave() {
    if (!active) return;
    try { if (active.page.unmount) active.page.unmount(); } catch (_) {}
    if (active.root && active.root.parentNode) active.root.parentNode.removeChild(active.root);
    var c = document.querySelector('.content');
    if (c && c.dataset.scHidden) { c.style.display = ''; delete c.dataset.scHidden; }
    restoreTitle();
    active = null;
  }

  /* Other scripts move through React with window.__reactRouterNavigate (the
     access-denied "Go to an allowed page" button, dashboard tiles, My Team).
     Leaving one of our pages that way must drop `armed`, or ensure() takes
     the move to '/' for React's deep-link bounce and puts our URL back, so
     the click seems to do nothing. */
  function wrapReactNav() {
    var f = window.__reactRouterNavigate;
    if (typeof f !== 'function' || f.__sc) return;
    var w = function (to) {
      var path = typeof to === 'string' ? pathOf(to) : '';
      if (path && !match(path)) armed = null;
      else if (path) armed = norm(path);
      return f.apply(this, arguments);
    };
    w.__sc = true;
    window.__reactRouterNavigate = w;
  }

  function ensure() {
    wrapReactNav();
    var m = match(location.pathname);
    // React bounced our deep link to '/': put the URL back once.
    if (!m && armed && location.pathname === '/') {
      var tail = (armed === norm(requestedPath())) ? bootTail : '';
      bootTail = '';
      history.replaceState({}, '', armed + tail);
      m = match(armed);
      if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
    }
    if (!m) {
      if (active) { leave(); markActiveNav(null); }
      // Every overlay has registered by the time the document has loaded.
      if (document.readyState === 'complete') reveal();
      return;
    }
    armed = norm(location.pathname);
    var main = document.querySelector('.main');
    if (!main) return;
    var content = document.querySelector('.content');
    if (content && content.style.display !== 'none') { content.style.display = 'none'; content.dataset.scHidden = '1'; }

    if (active && active.page !== m.page) leave();
    if (!active) {
      var root = document.createElement('div');
      root.className = 'hrms-sc-root';
      root.setAttribute('data-sc', m.page.base);
      // .main is a flex column with overflow:hidden (React's .content is the
      // scroller there), so our root must scroll itself, like .content does.
      root.style.cssText = 'padding:24px 28px;min-width:0;flex:1;min-height:0;overflow-y:auto;';
      main.appendChild(root);
      active = { page: m.page, root: root, sub: m.sub };
      try { m.page.mount(root, m.sub); } catch (e) { root.innerHTML = '<div style="color:var(--danger,#ef4444)">Could not open this page: ' + String(e && e.message || e) + '</div>'; }
      reveal();
    } else {
      if (active.root.parentElement !== main) main.appendChild(active.root);
      if (active.sub !== m.sub) {
        active.sub = m.sub;
        try { (m.page.update || m.page.mount)(active.root, m.sub); } catch (_) {}
      }
    }
    setTitle(m.page.title);
    markActiveNav(m.page.base);
  }

  function go(path) {
    // A path may carry ?query/#hash (e.g. /employees/tasks?view=table): match
    // and arm on the path part only, but push the full URL.
    armed = match(pathOf(path)) ? norm(pathOf(path)) : null;
    if (!armed) { location.href = path; return; }
    history.pushState({}, '', path);
    ensure();
    if (window.__hrmsApplyGuard) window.__hrmsApplyGuard();
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) !== '/') return;
    if (match(href.split('?')[0].split('#')[0])) {
      e.preventDefault();
      e.stopPropagation();
      go(href);
    } else if (a.classList.contains('nav-item')) {
      armed = null;                                   // a real navigation away
      // React Router pushes the new URL without a popstate. When the target is
      // the route React was already showing under us (Attendance -> Tasks ->
      // Attendance), React re-renders nothing, so no DOM mutation would wake
      // ensure() and our page would stay on screen. Check after the push.
      if (active) { setTimeout(ensure, 0); setTimeout(ensure, 120); }
    }
  }, true);

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; ensure(); });
  }
  function boot() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { armed = match(location.pathname) ? norm(location.pathname) : null; setTimeout(ensure, 60); });
    ensure();
    // Safety net: never leave the page hidden (e.g. a page that stopped
    // registering itself, or a script error while mounting).
    window.addEventListener('load', function () { setTimeout(function () { ensure(); reveal(); }, 400); });
  }

  window.HRMSSidecar = {
    register: function (spec) {
      if (!spec || !spec.base || typeof spec.mount !== 'function') return;
      spec.base = norm(spec.base);
      pages.push(spec);
      rememberBases();
      var m = match(requestedPath());
      if (m && m.page === spec) armed = norm(requestedPath());
      if (document.body) schedule();
    },
    go: go,
    // Forget the page we were holding on to (before leaving it some other way).
    release: function () { armed = null; },
    has: function (base) { base = norm(base); for (var i = 0; i < pages.length; i++) if (pages[i].base === base) return true; return false; },
    current: function () { return active ? { base: active.page.base, sub: active.sub } : null; },
    /* shared helpers for module pages */
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    me: function () {
      try { var s = JSON.parse(localStorage.getItem('hrms_session') || '{}'); return { email: (s.email || '').toLowerCase(), name: s.name || s.fullName || '' }; }
      catch (_) { return { email: '', name: '' }; }
    },
    api: function (url, opts) {
      opts = opts || {};
      var init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
      if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      return fetch(url, init).then(function (r) {
        return r.text().then(function (t) {
          var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) {}
          if (!r.ok) { var e = new Error((d && (d.message || d.detail || d.error)) || ('Request failed (' + r.status + ')')); e.status = r.status; e.data = d; throw e; }
          return d;
        });
      });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
