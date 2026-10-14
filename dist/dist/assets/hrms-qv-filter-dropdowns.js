(function () {
  'use strict';

  var ROUTE = '/recruit/interview';
  var GROUPS = ['Actions', 'Outcome', 'Scope'];
  var PORTAL_ID = 'hrms-qv-filter-dropdowns';
  var frame = 0;

  function currentDrawer() {
    var headings = document.querySelectorAll('span');
    for (var i = 0; i < headings.length; i++) {
      if ((headings[i].textContent || '').trim() !== 'Recruiter Quick View') continue;
      var node = headings[i];
      while (node && node !== document.body) {
        if (window.getComputedStyle(node).position === 'fixed') return node;
        node = node.parentElement;
      }
    }
    return null;
  }

  function filterGroups(drawer) {
    var groups = [];
    var labels = drawer.querySelectorAll('span');
    for (var i = 0; i < labels.length; i++) {
      var title = (labels[i].textContent || '').trim();
      if (GROUPS.indexOf(title) === -1) continue;
      var group = labels[i].parentElement;
      if (!group || !group.querySelector('.chip')) continue;
      groups.push({ title: title, element: group, label: labels[i] });
    }
    return groups;
  }

  function optionText(chip) {
    var label = '';
    var count = '';
    for (var i = 0; i < chip.childNodes.length; i++) {
      var child = chip.childNodes[i];
      if (child.nodeType === 3) label += child.nodeValue || '';
      else if (child.nodeType === 1 && child.tagName === 'SPAN') count = (child.textContent || '').trim();
    }
    label = label.trim().replace(/\s+/g, ' ');
    return label + (count ? ' (' + count + ')' : '');
  }

  function ensurePortal() {
    var portal = document.getElementById(PORTAL_ID);
    if (portal) return portal;
    portal = document.createElement('div');
    portal.id = PORTAL_ID;
    portal.style.cssText = 'position:fixed;inset:0;z-index:1001;pointer-events:none;';
    document.body.appendChild(portal);
    return portal;
  }

  function renderGroup(portal, group) {
    var chips = group.element.querySelectorAll('.chip');
    if (!chips.length) return;

    group.element.style.display = 'flex';
    group.element.style.flexWrap = 'nowrap';
    group.element.style.alignItems = 'center';
    group.element.style.minHeight = '36px';
    group.element.style.marginBottom = '10px';
    group.label.style.flex = '0 0 62px';
    group.label.style.minWidth = '62px';
    group.label.style.marginBottom = '0';

    for (var i = 0; i < chips.length; i++) chips[i].style.display = 'none';

    var select = portal.querySelector('[data-filter="' + group.title + '"]');
    if (!select) {
      select = document.createElement('select');
      select.setAttribute('data-filter', group.title);
      select.setAttribute('aria-label', group.title);
      select.style.cssText = [
        'position:fixed',
        'pointer-events:auto',
        'box-sizing:border-box',
        'height:32px',
        'padding:6px 9px',
        'border:1px solid var(--border2)',
        'border-radius:7px',
        'background:var(--bg2)',
        'color:var(--text)',
        'font-size:12px',
        'font-weight:500',
        'font-family:inherit',
        'outline:none'
      ].join(';');
      select.addEventListener('change', function () {
        var current = currentDrawer();
        if (!current) return;
        var activeGroup = filterGroups(current).filter(function (item) {
          return item.title === select.getAttribute('data-filter');
        })[0];
        if (!activeGroup) return;
        var activeChips = activeGroup.element.querySelectorAll('.chip');
        var chosen = activeChips[Number(select.value)];
        if (chosen) chosen.click();
      });
      portal.appendChild(select);
    }

    var labels = [];
    var activeIndex = 0;
    for (var j = 0; j < chips.length; j++) {
      labels.push(optionText(chips[j]));
      if (chips[j].classList.contains('active')) activeIndex = j;
    }

    var signature = labels.join('\u0000');
    if (select.__hrmsOptions !== signature) {
      select.textContent = '';
      for (var k = 0; k < labels.length; k++) {
        var option = document.createElement('option');
        option.value = String(k);
        option.textContent = labels[k];
        select.appendChild(option);
      }
      select.__hrmsOptions = signature;
    }
    select.value = String(activeIndex);

    var rect = group.element.getBoundingClientRect();
    select.style.left = (rect.left + 70) + 'px';
    select.style.top = (rect.top + (rect.height - 32) / 2) + 'px';
    select.style.width = Math.max(100, rect.width - 78) + 'px';
  }

  function sync() {
    frame = 0;
    if (location.pathname.replace(/\/+$/, '') !== ROUTE) {
      var oldPortal = document.getElementById(PORTAL_ID);
      if (oldPortal) oldPortal.remove();
      return;
    }

    var drawer = currentDrawer();
    var groups = drawer ? filterGroups(drawer) : [];
    var portal = document.getElementById(PORTAL_ID);
    if (!groups.length) {
      if (portal) portal.remove();
      return;
    }

    portal = ensurePortal();
    for (var i = 0; i < groups.length; i++) renderGroup(portal, groups[i]);
  }

  function scheduleSync() {
    if (frame) return;
    frame = window.requestAnimationFrame(sync);
  }

  function start() {
    var observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
      childList: true,
      subtree: true
    });
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', scheduleSync, true);
    scheduleSync();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
