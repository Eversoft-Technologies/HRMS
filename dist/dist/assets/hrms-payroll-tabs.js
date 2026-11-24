/**
 * hrms-payroll-tabs.js — one Payroll module.
 *
 * Payroll Run (hrms-payroll.js) and the extension pages (Tax & Statutory,
 * Payouts & Banking, US Payroll, Separations & F&F — sidecar pages) are
 * separate scripts. This puts ONE tab strip above whichever of them is open,
 * so they read and behave as a single Payroll screen.
 *
 * The strip is our own node, inserted as a sibling just before the page root
 * inside .main (page roots re-render their own innerHTML, which would wipe a
 * strip placed inside them). React-owned nodes are never touched.
 */
(function () {
  'use strict';
  if (window.__hrmsPayrollTabs) return;
  window.__hrmsPayrollTabs = true;

  var TABS = [
    { href: '/payroll/run', label: 'Payroll Run', run: true },
    { href: '/payroll/compliance', label: 'Tax & Statutory' },
    { href: '/payroll/banking', label: 'Payouts & Banking' },
    { href: '/payroll/us', label: 'US Payroll' },
    { href: '/payroll/separations', label: 'Separations & F&F' }
  ];
  var RUN_PATHS = ['/payroll', '/payroll/run', '/payroll/runs', '/payroll/dashboard'];
  var STRIP_ID = 'hrms-paynav';

  function norm(p) { return String(p || '').replace(/\/+$/, '') || '/'; }
  function activeTab() {
    var p = norm(location.pathname);
    if (RUN_PATHS.indexOf(p) !== -1) return TABS[0];
    for (var i = 1; i < TABS.length; i++) {
      if (p === TABS[i].href || p.indexOf(TABS[i].href + '/') === 0) return TABS[i];
    }
    return null;
  }

  function ensureStyle() {
    if (document.getElementById('hrms-paynav-style')) return;
    var s = document.createElement('style');
    s.id = 'hrms-paynav-style';
    s.textContent = [
      '#' + STRIP_ID + '{flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:14px 28px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg,transparent);overflow-x:auto;scrollbar-width:thin}',
      '#' + STRIP_ID + ' .pn-lbl{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text3,#8a9bb8);margin-right:8px;white-space:nowrap}',
      '#' + STRIP_ID + ' a{position:relative;padding:9px 14px 11px;font-size:13.5px;font-weight:600;color:var(--text2,#9aa8c0);text-decoration:none;white-space:nowrap;border-radius:8px 8px 0 0}',
      '#' + STRIP_ID + ' a:hover{color:var(--text,#e8edf7);background:var(--bg3,rgba(255,255,255,.04))}',
      '#' + STRIP_ID + ' a.on{color:var(--accent,#4f8ef7)}',
      '#' + STRIP_ID + ' a.on::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--accent,#4f8ef7)}',
      // The Payroll Run root sits in .main (overflow:hidden) — let it scroll
      // itself, the same way sidecar pages do.
      'body[data-payroll-active="1"] #hrms-payroll-root{flex:1;min-height:0;overflow-y:auto}',
      // hrms-payroll.js never hides its root when you navigate away (it only
      // drops data-payroll-active), so it would sit under the next page.
      'body:not([data-payroll-active="1"]) #hrms-payroll-root{display:none}',
      '@media (max-width:640px){#' + STRIP_ID + '{padding:10px 16px 0}#' + STRIP_ID + ' .pn-lbl{display:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function pageRoot(tab) {
    if (tab.run) {
      var r = document.getElementById('hrms-payroll-root');
      return r && document.body.getAttribute('data-payroll-active') === '1' ? r : null;
    }
    return document.querySelector('.hrms-sc-root[data-sc="' + tab.href + '"]');
  }

  function buildStrip() {
    var nav = document.createElement('nav');
    nav.id = STRIP_ID;
    nav.setAttribute('aria-label', 'Payroll');
    // No "PAYROLL" caption here: it sat in the tab row and looked like a tab
    // that did nothing. The page title already says Payroll.
    TABS.forEach(function (t) {
      var a = document.createElement('a');
      a.href = t.href;
      a.textContent = t.label;
      a.setAttribute('data-pn', t.href);
      nav.appendChild(a);
    });
    nav.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[data-pn]') : null;
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      go(a.getAttribute('data-pn'));
    });
    return nav;
  }

  function go(href) {
    var SC = window.HRMSSidecar;
    if (SC && SC.has && SC.has(href)) { SC.go(href); return; }
    // Payroll Run is mounted by hrms-payroll.js on a React route.
    if (window.__reactRouterNavigate) {
      window.__reactRouterNavigate(href);
      // React's navigation may not touch the DOM (its .content is hidden), so
      // tell hrms-sidecar.js (and us) the URL changed: it unmounts the page.
      setTimeout(function () {
        try { window.dispatchEvent(new PopStateEvent('popstate')); } catch (_) {}
        schedule();
      }, 0);
    } else {
      location.href = href;
    }
  }

  var queued = false;
  function ensure() {
    queued = false;
    var strip = document.getElementById(STRIP_ID);
    var tab = activeTab();
    var root = tab && pageRoot(tab);
    if (!root || !root.parentNode) {
      if (strip && strip.parentNode) strip.parentNode.removeChild(strip);
      return;
    }
    ensureStyle();
    if (!strip) strip = buildStrip();
    if (strip.parentNode !== root.parentNode || strip.nextSibling !== root) {
      root.parentNode.insertBefore(strip, root);
    }
    var links = strip.querySelectorAll('a[data-pn]');
    for (var i = 0; i < links.length; i++) {
      var on = links[i].getAttribute('data-pn') === tab.href;
      if (links[i].classList.contains('on') !== on) links[i].classList.toggle('on', on);
      if (on) links[i].setAttribute('aria-current', 'page'); else links[i].removeAttribute('aria-current');
    }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(ensure);
  }

  function boot() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { setTimeout(schedule, 80); });
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
