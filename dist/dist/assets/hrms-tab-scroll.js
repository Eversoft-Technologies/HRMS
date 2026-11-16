/**
 * hrms-tab-scroll.js — every sideways-scrolling bar follows the tab you tap.
 *
 * On a phone many pages have a row of tabs / filter chips that is wider than
 * the screen and swipes sideways (Attendance Settings, Payroll, Work
 * Submissions, Interviews, Settings ...). Tapping a tab near the edge used to
 * leave it half hidden, and on pages that redraw the row the bar jumped back
 * to the start. This does for ALL of them what Attendance Settings does:
 * after a tap, the bar slides so the chosen tab sits in the middle.
 *
 * How it decides what a "bar" is, so nothing else is touched:
 *   - one of the tapped thing's near ancestors scrolls sideways (overflow-x auto|scroll and
 *     wider than its box) and is a single low row (not a table, board or
 *     panel).
 * It only ever changes that bar's own sideways scroll position. No clicks are
 * blocked, no text or layout is changed, and the page itself never scrolls.
 */
(function () {
  'use strict';
  if (window.__hrmsTabScroll) return;
  window.__hrmsTabScroll = true;

  var MAX_BAR_HEIGHT = 76;   // taller than this is a panel / board, not a bar

  function isBar(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (el.clientHeight > MAX_BAR_HEIGHT || el.scrollWidth <= el.clientWidth + 4) return false;
    var tag = el.tagName;
    if (tag === 'TABLE' || tag === 'TBODY' || tag === 'TR' || tag === 'TD') return false;
    var ox = getComputedStyle(el).overflowX;
    return ox === 'auto' || ox === 'scroll';
  }

  function findBar(el) {
    var p = el.parentElement;
    for (var i = 0; p && i < 6; i++, p = p.parentElement) {
      if (isBar(p)) return p;
    }
    return null;
  }

  /* The tab itself: the outermost piece around the tap that is still one item
   * of the bar (tabs can be buttons, links or plain boxes with a badge inside). */
  function itemIn(bar, target) {
    var el = target;
    while (el.parentElement && el.parentElement !== bar &&
           el.parentElement.getBoundingClientRect().width < bar.scrollWidth * 0.8) {
      el = el.parentElement;
    }
    return el;
  }

  function label(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

  function itemsOf(bar) { return Array.prototype.slice.call(bar.querySelectorAll('*')); }

  /* The page redrew the row: find the new copy of the same bar. */
  function replacementFor(job) {
    var list = [];
    try {
      if (job.id) { var byId = document.getElementById(job.id); if (byId) list.push(byId); }
      if (job.cls) list = list.concat(Array.prototype.slice.call(document.getElementsByClassName(job.cls)));
      if (!list.length && job.parent && job.parent.isConnected) {
        list = Array.prototype.slice.call(job.parent.children);
      }
    } catch (_) {}
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.isConnected || b.tagName !== job.tag) continue;
      var its = itemsOf(b);
      for (var j = 0; j < its.length; j++) if (label(its[j]) === job.text) return b;
    }
    return null;
  }

  function settle(job, last) {
    var bar = job.bar;
    var redrawn = false;
    if (!bar.isConnected) {
      bar = replacementFor(job);
      if (!bar) return;
      job.bar = bar; redrawn = true;
    }
    var item = job.item;
    if (!item.isConnected || !bar.contains(item)) {
      var its = itemsOf(bar);
      item = (its[job.index] && label(its[job.index]) === job.text) ? its[job.index] : null;
      for (var i = 0; !item && i < its.length; i++) if (label(its[i]) === job.text) item = its[i];
      if (!item) return;
      job.item = item; redrawn = true;
    }
    var max = bar.scrollWidth - bar.clientWidth;
    if (max <= 4) return;
    // a redrawn bar starts at 0: put it back where it was, then slide from there
    if (redrawn && Math.abs(bar.scrollLeft - job.from) > 2) bar.scrollLeft = Math.min(job.from, max);

    var br = bar.getBoundingClientRect(), ir = item.getBoundingClientRect();
    var to = bar.scrollLeft + (ir.left - br.left) - (bar.clientWidth - ir.width) / 2;
    to = Math.max(0, Math.min(to, max));
    if (Math.abs(to - bar.scrollLeft) <= 2) return;
    job.from = to;
    // Slide smoothly; on the last pass (or when the page cannot animate) just go there.
    if (last || document.hidden || !bar.scrollTo) { bar.scrollLeft = to; return; }
    try { bar.scrollTo({ left: to, behavior: 'smooth' }); } catch (_) { bar.scrollLeft = to; }
  }

  document.addEventListener('click', function (e) {
    try {
      var t = e.target;
      if (!t || !t.closest) return;
      var bar = findBar(t);
      if (!bar) return;
      var item = itemIn(bar, t);
      if (!item || item === bar || !label(item)) return;
      var its = itemsOf(bar);
      var job = {
        bar: bar, item: item, from: bar.scrollLeft,
        index: its.indexOf(item), text: label(item),
        id: bar.id || '', tag: bar.tagName, parent: bar.parentElement,
        cls: (typeof bar.className === 'string' && bar.className.trim()) ? bar.className.trim().split(/\s+/)[0] : ''
      };
      var run = function (last) { try { settle(job, last); } catch (_) {} };
      // once after the click handlers ran, and again for pages that redraw a moment later
      setTimeout(function () { run(false); }, 30);
      setTimeout(function () { run(false); }, 220);
      setTimeout(function () { run(true); }, 650);
    } catch (_) {}
  }, true);
})();
