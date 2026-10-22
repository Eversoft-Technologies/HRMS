(function () {
  'use strict';

  var ROUTE = '/recruit/interview';
  var GROUPS = ['Actions', 'Outcome', 'Scope'];
  var frame = 0;
  var observedDrawer = null;
  var drawerObserver = null;

  function removeInjectedSelects() {
    var selects = document.querySelectorAll('select[data-hrms-qv-filter]');
    for (var i = 0; i < selects.length; i++) selects[i].remove();
  }

  function stopObservingDrawer() {
    if (drawerObserver) drawerObserver.disconnect();
    observedDrawer = null;
    drawerObserver = null;
  }

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

  function observeDrawer(drawer) {
    if (observedDrawer === drawer) return;
    stopObservingDrawer();
    if (!drawer) return;

    observedDrawer = drawer;
    drawerObserver = new MutationObserver(scheduleSync);
    drawerObserver.observe(drawer, {
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
      childList: true,
      subtree: true
    });
  }

  function renderGroup(group) {
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

    var select = group.element.querySelector('select[data-hrms-qv-filter]');
    if (!select) {
      select = document.createElement('select');
      select.setAttribute('data-filter', group.title);
      select.setAttribute('data-hrms-qv-filter', '1');
      select.setAttribute('aria-label', group.title);
      select.style.cssText = [
        'display:block',
        'flex:1 1 auto',
        'min-width:0',
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
        var activeSelect = activeGroup.element.querySelector('select[data-hrms-qv-filter]');
        var chosen = activeChips[Number(activeSelect && activeSelect.value)];
        if (chosen) chosen.click();
      });
      group.element.appendChild(select);
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
  }

  function sync() {
    frame = 0;
    if (location.pathname.replace(/\/+$/, '') !== ROUTE) {
      stopObservingDrawer();
      removeInjectedSelects();
      return;
    }

    var drawer = observedDrawer && observedDrawer.isConnected
      ? observedDrawer
      : currentDrawer();
    observeDrawer(drawer);
    var groups = drawer ? filterGroups(drawer) : [];
    if (!groups.length) {
      return;
    }

    for (var i = 0; i < groups.length; i++) renderGroup(groups[i]);
  }

  function scheduleSync() {
    if (frame) return;
    frame = window.requestAnimationFrame(sync);
  }

  function start() {
    var pageObserver = new MutationObserver(scheduleSync);
    pageObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () {
      removeInjectedSelects();
      scheduleSync();
    });
    window.addEventListener('hrmsNavigate', function () {
      removeInjectedSelects();
      scheduleSync();
    });
    scheduleSync();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
