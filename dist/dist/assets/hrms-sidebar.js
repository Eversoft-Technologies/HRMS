/*
 * hrms-sidebar.js
 * ---------------------------------------------------------------------------
 * Collapsible left sidebar on desktop — no bundle rebuild.
 *
 *   • A toggle button at the start of the .topbar collapses the sidebar to a
 *     64px icon rail and expands it again. The choice is remembered
 *     (localStorage) and re-applied on the next load.
 *   • Collapsing just narrows the `--sidebar` CSS variable the layout already
 *     uses, so .sidebar (width) and .main (margin-left) follow together with a
 *     short transition. Labels are hidden with CSS only: React keeps owning
 *     every node, nothing is wrapped or moved.
 *   • Each nav item gets a `title` with its label so the icon rail still names
 *     the page on hover. Sections injected by other scripts (Access Control,
 *     Bench Sales, …) use the same classes, so they collapse too.
 *   • Phones (≤768px) keep the slide-in drawer from hrms-mobile.js untouched:
 *     every rule here is scoped to min-width 769px.
 */
(function () {
  'use strict';

  var KEY = 'hrms_sidebar_collapsed';
  var CLS = 'hrms-sb-collapsed';
  var BTN_ID = 'hrms-sb-toggle';
  var STYLE_ID = 'hrms-sb-style';
  var RAIL = '64px';

  var ICON_COLLAPSE =
    '<svg class="sb-ic sb-ic-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="M16.5 9.5 14 12l2.5 2.5"/></svg>';
  var ICON_EXPAND =
    '<svg class="sb-ic sb-ic-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="M13.5 9.5 16 12l-2.5 2.5"/></svg>';

  function isCollapsed() { return document.documentElement.classList.contains(CLS); }
  function apply(on) {
    document.documentElement.classList.toggle(CLS, !!on);
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) {}
    syncButton();
  }
  function toggle() { apply(!isCollapsed()); }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var C = 'html.' + CLS, B = '#' + BTN_ID;
    var css = [
      '@media (min-width: 769px){',
        C + '{--sidebar:' + RAIL + ';}',
        '.sidebar{transition:width .22s ease;}',
        '.main{transition:margin-left .22s ease;}',
        /* logo: icon only */
        C + ' .logo{justify-content:center;padding:14px 8px 12px;}',
        C + ' .logo > :not(.logo-icon){display:none;}',
        /* section labels become thin separators */
        C + ' .nav-label{font-size:0;line-height:0;padding:0;height:1px;margin:8px 16px 6px;background:var(--border2,rgba(255,255,255,.08));}',
        C + ' .nav-section{padding:6px 0 2px;}',
        /* nav items: centred icon, label hidden (it is a bare text node) */
        C + ' .nav-item{position:relative;font-size:0;line-height:0;justify-content:center;gap:0;padding:11px 0;}',
        C + ' .nav-item .nav-icon{width:18px;height:18px;}',
        C + ' .nav-item .nav-icon svg{width:18px;height:18px;}',
        /* "New" badge shrinks to a dot; "Soon" tags are dropped */
        C + ' .nav-item .nav-badge{position:absolute;top:7px;right:14px;width:7px;height:7px;padding:0;margin:0;border-radius:50%;font-size:0;overflow:hidden;}',
        C + ' .nav-item .nav-soon{display:none;}',
        /* footer: avatar only */
        C + ' .sidebar-footer{padding:12px 0;}',
        C + ' .sidebar-footer .av-row{justify-content:center;gap:0;}',
        C + ' .sidebar-footer .av-row > :not(.av){display:none;}',
        C + ' .sidebar-footer > :not(.av-row){display:none;}',
        /* the toggle */
        B + '{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin-left:-8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text2,#8a9bb8);cursor:pointer;flex-shrink:0;transition:all .15s;}',
        B + ':hover{background:var(--bg3,rgba(255,255,255,.06));color:var(--text,#e8edf7);border-color:var(--border2,rgba(255,255,255,.08));}',
        B + ' .sb-ic{width:19px;height:19px;}',
        B + ' .sb-ic-expand{display:none;}',
        C + ' ' + B + ' .sb-ic-collapse{display:none;}',
        C + ' ' + B + ' .sb-ic-expand{display:block;}',
      '}',
      '@media (max-width: 768px){' + B + '{display:none;}}'
    ].join('');
    var st = document.createElement('style'); st.id = STYLE_ID; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── toggle button in the topbar ──────────────────────────────────────── */
  function ensureButton() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;                               // auth pages have no topbar
    var btn = document.getElementById(BTN_ID);
    if (btn && btn.parentNode === topbar) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.innerHTML = ICON_COLLAPSE + ICON_EXPAND;
      btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    }
    // After the phone hamburger when it is there (hrms-mobile.js keeps that
    // one first), otherwise first in the bar.
    var burger = topbar.querySelector('#hrms-hamburger');
    if (burger && burger.parentNode === topbar) topbar.insertBefore(btn, burger.nextSibling);
    else topbar.insertBefore(btn, topbar.firstChild);
    syncButton();
  }
  function syncButton() {
    var btn = document.getElementById(BTN_ID); if (!btn) return;
    var on = isCollapsed();
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    btn.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    btn.title = on ? 'Expand sidebar' : 'Collapse sidebar';
  }

  /* ── hover labels for the icon rail ───────────────────────────────────── */
  // The label is a bare text node next to the icon, so read only text nodes:
  // "Surveys New" must not become the title of the Surveys item.
  function itemLabel(a) {
    var s = '';
    for (var n = a.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.textContent;
    s = s.replace(/\s+/g, ' ').trim();
    return s || (a.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function labelNavItems() {
    var items = document.querySelectorAll('.sidebar .nav-item');
    for (var i = 0; i < items.length; i++) {
      var t = itemLabel(items[i]);
      if (t && items[i].getAttribute('title') !== t) items[i].setAttribute('title', t);
    }
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  /* ── one active link, matching the real URL ────────────────────────────── */
  // React lights every link whose path prefixes its *router* location, and
  // the Onboarding module navigates with pushState without telling the
  // router, so a stale "Leave Management" stayed lit on /onboarding/* pages
  // while the injected Onboarding links never lit at all. Keep exactly one:
  // the link with the longest href that prefixes the current path.
  function syncActive() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var items = document.querySelectorAll('.sidebar a.nav-item[href]');
    var best = null, bestLen = -1;
    for (var i = 0; i < items.length; i++) {
      var href = (items[i].getAttribute('href') || '').replace(/\/+$/, '') || '/';
      if (href.charAt(0) !== '/') continue;
      var hit = href === '/' ? path === '/' : (path === href || path.indexOf(href + '/') === 0);
      if (hit && href.length > bestLen) { bestLen = href.length; best = items[i]; }
    }
    if (!best) return;   // route with no link of its own: leave React's choice alone
    for (var j = 0; j < items.length; j++) {
      var want = items[j] === best;
      if (items[j].classList.contains('active') !== want) items[j].classList.toggle('active', want);
    }
  }

  /* ── Employee Chat icon ───────────────────────────────────────────── */
  // The bundle gives Employee Chat the same square icon as Task Tracker; use
  // a speech bubble instead, in the sidebar's own 16px stroke style.
  var CHAT_ICON =
    '<svg viewBox="0 0 16 16" fill="none" width="16" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" data-sb-chat="1">' +
      '<path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5H4A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5z"/>' +
      '<circle cx="5.75" cy="6.5" r=".7" fill="currentColor" stroke="none"/>' +
      '<circle cx="8" cy="6.5" r=".7" fill="currentColor" stroke="none"/>' +
      '<circle cx="10.25" cy="6.5" r=".7" fill="currentColor" stroke="none"/>' +
    '</svg>';
  function swapChatIcon() {
    var a = document.querySelector('.sidebar a.nav-item[href="/employees/chat"]'); if (!a) return;
    var ic = a.querySelector('.nav-icon'); if (!ic || ic.querySelector('[data-sb-chat]')) return;
    ic.innerHTML = CHAT_ICON;
  }

  /* ── avatar fallback ──────────────────────────────────────────────────── */
  // The topbar avatar and the account drawer render <img src=pic> with no
  // error handling, so a profile-picture URL that no longer resolves showed
  // the browser's broken-image glyph in an empty circle. Fall back to the
  // initials the bundle itself shows when there is no picture. (error
  // events do not bubble, hence the capture listener.)
  function initialsOf(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    var s = parts.slice(0, 2).map(function (w) { return w.charAt(0); }).join('');
    return (s || '?').toUpperCase();
  }
  function avatarFallback(img) {
    var av = img.closest('.av'); if (!av) return;
    var head = av.closest('.hrms-drawer-head');
    var nameEl = head && head.querySelector('.hrms-drawer-name');
    var name = (nameEl && nameEl.textContent) || av.getAttribute('title') || '';
    av.textContent = initialsOf(name);
    av.style.background = 'linear-gradient(135deg,var(--accent4),var(--danger))';
    // The bundle seeds the picture from this cache before asking the API, so
    // a dead URL kept coming back on every load; the API refills it when the
    // profile has a working picture.
    try { localStorage.removeItem('hrms_profile_pic'); } catch (_) {}
  }
  document.addEventListener('error', function (e) {
    var img = e.target; if (!img || img.tagName !== 'IMG' || !img.closest) return;
    avatarFallback(img);
  }, true);
  // Images that had already failed before this script ran (the topbar avatar
  // loads with the page) fire no further error event, so sweep them on sync.
  function fixBrokenAvatars() {
    var imgs = document.querySelectorAll('.av > img');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete && imgs[i].naturalWidth === 0) avatarFallback(imgs[i]);
    }
  }

  function sync() {
    ensureStyle();
    if (!document.querySelector('.sidebar')) return;
    ensureButton();
    labelNavItems();
    syncActive();
    swapChatIcon();
    fixBrokenAvatars();
  }
  function start() {
    // Restore the saved state before React paints the shell, so a collapsed
    // sidebar does not flash open on every load.
    try { if (localStorage.getItem(KEY) === '1') document.documentElement.classList.add(CLS); } catch (_) {}
    ensureStyle();
    sync();
    // Back/forward changes the URL without touching the sidebar DOM.
    window.addEventListener('popstate', function () { setTimeout(sync, 0); });
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; sync(); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
