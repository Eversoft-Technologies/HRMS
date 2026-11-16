/**
 * hrms-popup-dismiss.js — small floating menus go away when you move on.
 *
 * The column filter on Resume Scoring and Job Board ("Sort A-Z / Search values /
 * Select all / Apply / Clear"), the Job Board priority picker and the two Export
 * menus are drawn fixed to the screen. Each one closes itself on a mouse press
 * outside it — which a tap also produces, but a SWIPE does not. So on a phone,
 * scrolling the page left the menu floating over the content, in the way of
 * whatever you went to do next.
 *
 * This closes any of those menus when:
 *   - you swipe anywhere outside the menu (a finger moving on the screen);
 *   - you turn the mouse wheel / two-finger scroll outside the menu;
 *   - you move to another page.
 * It deliberately does NOT react to "the page scrolled": opening a filter on a
 * column you had swiped sideways to makes the table re-centre itself, and the
 * phone keyboard opening scrolls the page too. Neither is the person moving
 * on, and treating them as such shut the menu the instant it opened.
 * It only removes the menu element, exactly as the menu's own close does; no
 * filter or sort is applied or lost that the menu had not already applied.
 */
(function () {
  'use strict';
  if (window.__hrmsPopupDismiss) return;
  window.__hrmsPopupDismiss = true;

  var IDS = [
    'hrms-cc-colpop',        // Resume Scoring: column filter
    'hrms-jobs-colpop',      // Job Board: column filter
    'hrms-jobs-pripop',      // Job Board: priority picker
    'hrms-cc-exportmenu',    // Resume Scoring: Export menu
    'hrms-jobs-exportmenu'   // Job Board: Export menu
  ];

  function openOnes() {
    var out = [];
    for (var i = 0; i < IDS.length; i++) {
      var el = document.getElementById(IDS[i]);
      if (el) out.push(el);
    }
    return out;
  }

  function inside(pop, node) {
    return !!(node && node.nodeType === 1 && pop.contains(node));
  }

  function closeAll(target) {
    var pops = openOnes();
    for (var i = 0; i < pops.length; i++) {
      if (inside(pops[i], target)) continue;   // acting inside the menu (its own list scrolls)
      pops[i].remove();
    }
  }

  document.addEventListener('touchmove', function (e) { closeAll(e.target); }, { capture: true, passive: true });
  document.addEventListener('wheel', function (e) { closeAll(e.target); }, { capture: true, passive: true });
  window.addEventListener('popstate', function () { closeAll(null); });
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var res = orig.apply(this, arguments);
      try { closeAll(null); } catch (_) {}
      return res;
    };
  });
})();
