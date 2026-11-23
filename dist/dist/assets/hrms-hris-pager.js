/**
 * hrms-hris-pager.js — pages for the HRIS "Employee Records" list (/hr/hris).
 *
 * The list used to show every employee in one long run. It now shows TEN at a
 * time with Prev / page numbers / Next under it, on desktop and on phones.
 *
 * How it works (nothing in the app bundle is edited):
 *   - the table is still drawn by the app; this only marks the rows that are
 *     not on the current page with data-hp-off, and one CSS rule hides them;
 *   - whenever the app redraws the rows (a department chip, a new employee, a
 *     sort) the marks are worked out again and the list goes back to page 1;
 *   - row clicks, the Add Employee button and the chips are untouched.
 */
(function () {
  'use strict';
  if (window.__hrmsHrisPager) return;
  window.__hrmsHrisPager = true;

  var PAGE_SIZE = 10;
  var PAGER_ID = 'hrms-hris-pager';
  var STYLE_ID = 'hrms-hris-pager-style';
  var page = 1;
  var lastSig = '';

  function onList() { return location.pathname.replace(/\/+$/, '') === '/hr/hris'; }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      'tr[data-hp-off]{display:none !important;}',
      '#' + PAGER_ID + '{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px;font-size:12.5px;color:var(--text2,#475569);}',
      '#' + PAGER_ID + ' .hpg-info b{color:var(--text,#0f172a);font-weight:700;}',
      '#' + PAGER_ID + ' .hpg-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '#' + PAGER_ID + ' button{min-width:32px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--border2,#e5e7eb);background:var(--bg2,#fff);color:var(--text,#0f172a);font:inherit;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s;}',
      '#' + PAGER_ID + ' button:hover:not(:disabled):not(.on){background:var(--bg3,#f1f5f9);}',
      '#' + PAGER_ID + ' button.on{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff;cursor:default;}',
      '#' + PAGER_ID + ' button:disabled{opacity:.45;cursor:not-allowed;}',
      '#' + PAGER_ID + ' .hpg-gap{padding:0 2px;color:var(--text3,#64748b);}',
      '@media (max-width:600px){#' + PAGER_ID + '{justify-content:center;gap:8px;}#' + PAGER_ID + ' .hpg-info{width:100%;text-align:center;}#' + PAGER_ID + ' button{height:34px;min-width:36px;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* The Employee Records card: the one whose heading says so and that holds the table. */
  function findWrap() {
    var heads = document.querySelectorAll('.content .card > .sec-head');
    for (var i = 0; i < heads.length; i++) {
      if (!/employee records/i.test(heads[i].textContent || '')) continue;
      var wrap = heads[i].parentElement.querySelector('.table-wrap');
      if (wrap && wrap.querySelector('tbody')) return wrap;
    }
    return null;
  }

  function pageList(pages) {
    // 1 … 4 5 6 … 12 : first, last and the neighbours of the current page
    var out = [], last = 0;
    for (var p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - page) <= 1) {
        if (last && p - last > 1) out.push(0);
        out.push(p); last = p;
      }
    }
    return out;
  }

  function apply() {
    var pager = document.getElementById(PAGER_ID);
    if (!onList()) { if (pager) pager.remove(); return; }
    var wrap = findWrap();
    if (!wrap) { if (pager) pager.remove(); return; }
    ensureStyle();

    var all = wrap.querySelectorAll('tbody > tr');
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length >= 3) rows.push(all[i]);        // skip the "no records" placeholder
      else if (all[i].hasAttribute('data-hp-off')) all[i].removeAttribute('data-hp-off');
    }
    var total = rows.length;

    // a different set of rows (chip, sort, add/remove) starts again from page 1
    var sig = total + '|' + (total ? (rows[0].textContent || '').slice(0, 60) : '') +
              '|' + (total ? (rows[total - 1].textContent || '').slice(0, 60) : '');
    if (sig !== lastSig) { lastSig = sig; page = 1; }

    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > pages) page = pages;
    var from = (page - 1) * PAGE_SIZE, to = Math.min(total, page * PAGE_SIZE);

    for (var r = 0; r < total; r++) {
      var off = r < from || r >= to;
      if (off) { if (!rows[r].hasAttribute('data-hp-off')) rows[r].setAttribute('data-hp-off', '1'); }
      else if (rows[r].hasAttribute('data-hp-off')) rows[r].removeAttribute('data-hp-off');
    }

    if (!total) { if (pager) pager.remove(); return; }

    var html = '<div class="hpg-info">Showing <b>' + (from + 1) + '–' + to + '</b> of <b>' + total +
               '</b> employee' + (total === 1 ? '' : 's') + '</div><div class="hpg-nav">' +
               '<button type="button" data-hpg="prev"' + (page <= 1 ? ' disabled' : '') + '>Prev</button>';
    var list = pageList(pages);
    for (var k = 0; k < list.length; k++) {
      html += list[k] ? '<button type="button" data-hpg="' + list[k] + '"' + (list[k] === page ? ' class="on" aria-current="page"' : '') + '>' + list[k] + '</button>'
                      : '<span class="hpg-gap">…</span>';
    }
    html += '<button type="button" data-hpg="next"' + (page >= pages ? ' disabled' : '') + '>Next</button></div>';

    if (!pager) {
      pager = document.createElement('div');
      pager.id = PAGER_ID;
      pager.addEventListener('click', onPagerClick);
    }
    if (pager.previousElementSibling !== wrap) wrap.parentNode.insertBefore(pager, wrap.nextSibling);
    if (pager.__html !== html) { pager.__html = html; pager.innerHTML = html; }
  }

  function onPagerClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-hpg]') : null;
    if (!b || b.disabled) return;
    var v = b.getAttribute('data-hpg');
    if (v === 'prev') page = Math.max(1, page - 1);
    else if (v === 'next') page = page + 1;
    else page = parseInt(v, 10) || 1;
    apply();
    // bring the top of the list back into view after a page change
    var wrap = findWrap();
    var card = wrap && wrap.closest('.card');
    if (card && card.getBoundingClientRect().top < 0) {
      try { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { card.scrollIntoView(); }
    }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { apply(); } catch (_) {} }, 40);
  }

  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.id === PAGER_ID) continue;
      if (t && t.closest && t.closest('#' + PAGER_ID)) continue;
      schedule();
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  schedule();
})();
