(function () {
  'use strict';

  var ROUTES = ['/recruit', '/recruit/interview'];
  var PIPELINE_GROUPS = ['STAGE FOCUS', 'DEPARTMENT', 'MATCH QUALITY'];
  var RECRUITER_GROUPS = ['Actions', 'Outcome', 'Scope'];
  var ICONS = {
    'Pipeline Quick View': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-6m4 6V4"/></svg>',
    'STAGE FOCUS': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="19" r="2"/></svg>',
    'DEPARTMENT': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V5l7-3 7 3v16M9 9h1m4 0h1m-6 4h1m4 0h1m-5 8v-4h4v4"/></svg>',
    'MATCH QUALITY': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4m-9-13v8m-3-4h6"/></svg>'
  };
  var ACTIVE_FILTER = 'var(--accent';
  var FOOTER_ID = 'data-hrms-qv-footer';
  var frame = 0;
  var observedDrawer = null;
  var drawerObserver = null;
  var pipelineDraft = {};
  var applyInProgress = false;

  function removeInjectedSelects() {
    var selects = document.querySelectorAll('select[data-hrms-qv-filter]');
    for (var i = 0; i < selects.length; i++) selects[i].remove();
    removeFooters();
  }

  function removeFooters() {
    var footers = document.querySelectorAll('[' + FOOTER_ID + ']');
    for (var i = 0; i < footers.length; i++) footers[i].remove();
  }

  function routeSupported() {
    return ROUTES.indexOf(location.pathname.replace(/\/+$/, '') || '/') !== -1;
  }

  function stopObservingDrawer() {
    if (drawerObserver) drawerObserver.disconnect();
    observedDrawer = null;
    drawerObserver = null;
  }

  function currentDrawer() {
    var headings = document.querySelectorAll('span');
    for (var i = 0; i < headings.length; i++) {
      var title = (headings[i].textContent || '').trim();
      if (title !== 'Recruiter Quick View' && title !== 'Pipeline Quick View') continue;
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
    if (!drawer) return groups;
    var title = drawer.querySelector('span');
    var pipeline = title && (title.textContent || '').trim() === 'Pipeline Quick View';
    if (pipeline) {
      var sections = drawer.querySelectorAll('div');
      for (var s = 0; s < sections.length; s++) {
        var section = sections[s];
        if (section.children.length < 2) continue;
        var sectionTitle = (section.children[0].textContent || '').trim();
        if (PIPELINE_GROUPS.indexOf(sectionTitle) === -1) continue;
        var optionList = section.children[1];
        if (!optionList.children.length) continue;
        groups.push({
          title: sectionTitle,
          element: section,
          label: section.children[0],
          optionList: optionList,
          options: Array.prototype.slice.call(optionList.children),
          pipeline: true
        });
      }
      return groups;
    }

    var labels = drawer.querySelectorAll('span');
    for (var i = 0; i < labels.length; i++) {
      var title = (labels[i].textContent || '').trim();
      if (RECRUITER_GROUPS.indexOf(title) === -1) continue;
      var group = labels[i].parentElement;
      if (!group || !group.querySelector('.chip')) continue;
      groups.push({
        title: title,
        element: group,
        label: labels[i],
        options: Array.prototype.slice.call(group.querySelectorAll('.chip')),
        pipeline: false
      });
    }
    return groups;
  }

  function optionText(chip, pipeline) {
    var label = '';
    var count = '';
    if (pipeline) {
      var spans = chip.querySelectorAll('span');
      label = spans.length ? (spans[0].textContent || '').trim() : (chip.textContent || '').trim();
      if (spans.length > 1) count = (spans[spans.length - 1].textContent || '').trim();
      return label + (count ? ' (' + count + ')' : '');
    }
    for (var i = 0; i < chip.childNodes.length; i++) {
      var child = chip.childNodes[i];
      if (child.nodeType === 3) label += child.nodeValue || '';
      else if (child.nodeType === 1 && child.tagName === 'SPAN') count = (child.textContent || '').trim();
    }
    label = label.trim().replace(/\s+/g, ' ');
    return label + (count ? ' (' + count + ')' : '');
  }

  function optionKey(chip) {
    var labels = chip.querySelectorAll('span');
    return labels.length ? (labels[0].textContent || '').trim() : (chip.textContent || '').trim();
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

  function addIcon(label, title) {
    if (!ICONS[title] || label.querySelector('[data-hrms-qv-icon]')) return;
    var icon = document.createElement('span');
    icon.setAttribute('data-hrms-qv-icon', '1');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = ICONS[title];
    icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 14px;width:14px;height:14px;color:var(--accent,#6366f1);';
    var svg = icon.querySelector('svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    label.insertBefore(icon, label.firstChild);
  }

  function renderGroup(group) {
    var chips = group.options;
    if (!chips.length) return;

    group.element.style.display = 'flex';
    group.element.style.flexWrap = 'nowrap';
    group.element.style.alignItems = 'center';
    group.element.style.minHeight = '36px';
    group.element.style.marginBottom = '10px';
    group.label.style.display = 'flex';
    group.label.style.alignItems = 'center';
    group.label.style.gap = '6px';
    group.label.style.flex = group.pipeline ? '0 0 112px' : '0 0 82px';
    group.label.style.minWidth = group.pipeline ? '112px' : '82px';
    group.label.style.marginBottom = '0';

    if (group.pipeline) {
      group.optionList.style.display = 'none';
    } else {
      for (var i = 0; i < chips.length; i++) chips[i].style.display = 'none';
    }

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
        if (group.pipeline) {
          var drawer = currentDrawer();
          var currentGroup = drawer && filterGroups(drawer).filter(function (item) {
            return item.title === group.title;
          })[0];
          var options = currentGroup ? currentGroup.options : group.options;
          var selected = options[Number(select.value)];
          if (selected) pipelineDraft[group.title] = optionKey(selected);
          return;
        }
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
    var keys = [];
    var activeIndex = 0;
    for (var j = 0; j < chips.length; j++) {
      labels.push(optionText(chips[j], group.pipeline));
      keys.push(group.pipeline ? optionKey(chips[j]) : labels[j]);
      if (group.pipeline
        ? (chips[j].style.background || '').indexOf(ACTIVE_FILTER) !== -1
        : chips[j].classList.contains('active')) activeIndex = j;
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
    if (group.pipeline) {
      if (Object.prototype.hasOwnProperty.call(pipelineDraft, group.title)) {
        var draftIndex = keys.indexOf(pipelineDraft[group.title]);
        if (draftIndex !== -1) activeIndex = draftIndex;
        else pipelineDraft[group.title] = keys[activeIndex];
      } else {
        pipelineDraft[group.title] = keys[activeIndex];
      }
    }
    select.value = String(activeIndex);
    addIcon(group.label, group.title);
  }

  function removeClearButton(drawer) {
    var buttons = drawer.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || '').trim() === 'Clear') buttons[i].style.display = 'none';
    }
  }

  function ensureFooter(drawer) {
    if (!drawer || !filterGroups(drawer).some(function (group) { return group.pipeline; })) return;
    removeClearButton(drawer);
    if (drawer.querySelector('[' + FOOTER_ID + ']')) return;

    drawer.style.display = 'flex';
    drawer.style.flexDirection = 'column';
    var heading = drawer.querySelector('span');
    if (heading) {
      heading.style.display = 'inline-flex';
      heading.style.alignItems = 'center';
      heading.style.gap = '8px';
      addIcon(heading, 'Pipeline Quick View');
    }

    var content = drawer.firstElementChild;
    if (content) {
      content.style.flex = '1 1 auto';
      content.style.minHeight = '0';
    }

    var footer = document.createElement('div');
    footer.setAttribute(FOOTER_ID, '1');
    footer.style.cssText = 'display:flex;flex:0 0 auto;gap:7px;padding:12px 14px;border-top:1px solid var(--border2,rgba(255,255,255,.12));background:var(--bg2,#1e293b);';
    footer.innerHTML =
      '<button type="button" data-action="reset">Reset</button>' +
      '<button type="button" data-action="cancel">Cancel</button>' +
      '<button type="button" data-action="apply">Apply Filter</button>' +
      '<span data-action="status" role="status" aria-live="polite" style="display:none;flex-basis:100%;font-size:12px;color:var(--danger,#f75f4f)"></span>';
    footer.style.flexWrap = 'wrap';
    var buttons = footer.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var action = buttons[i].getAttribute('data-action');
      buttons[i].style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:1 1 0;min-width:0;height:38px;padding:0 7px;border:1px solid var(--border2,#334155);border-radius:8px;background:var(--bg3,#1e293b);color:var(--text,#f8fafc);font:inherit;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer;';
      buttons[i].style.borderWidth = '1px';
      buttons[i].style.borderStyle = 'solid';
      if (action === 'reset') {
        buttons[i].style.color = 'var(--danger,#f75f4f)';
        buttons[i].style.borderColor = 'var(--danger,#f75f4f)';
      } else if (action === 'apply') {
        buttons[i].style.color = '#fff';
        buttons[i].style.borderColor = 'var(--accent,#6366f1)';
        buttons[i].style.background = 'var(--accent,#6366f1)';
      }
    }
    footer.querySelector('[data-action="reset"]').addEventListener('click', function () {
      var groups = filterGroups(currentDrawer());
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].pipeline) {
          var select = groups[i].element.querySelector('select[data-hrms-qv-filter]');
          if (select && select.options.length) {
            select.value = '0';
            pipelineDraft[groups[i].title] = optionKey(groups[i].options[0]);
          }
        }
      }
    });
    footer.querySelector('[data-action="cancel"]').addEventListener('click', closeQuickView);
    footer.querySelector('[data-action="apply"]').addEventListener('click', function () {
      if (applyInProgress) return;
      var groups = filterGroups(currentDrawer());
      var pending = [];
      for (var i = 0; i < groups.length; i++) {
        if (!groups[i].pipeline) continue;
        var select = groups[i].element.querySelector('select[data-hrms-qv-filter]');
        var selected = select && groups[i].options[Number(select.value)];
        if (selected) pending.push({ title: groups[i].title, key: optionKey(selected) });
      }
      setApplying(true);
      applyPending(pending, 0, footer, 0);
    });
    var closeButtons = drawer.querySelectorAll('button');
    for (var i = 0; i < closeButtons.length; i++) {
      if ((closeButtons[i].textContent || '').trim() === '✕') {
        closeButtons[i].addEventListener('click', function () { pipelineDraft = {}; }, true);
        break;
      }
    }
    drawer.appendChild(footer);
  }

  function setApplying(value) {
    applyInProgress = value;
    var footer = document.querySelector('[' + FOOTER_ID + ']');
    if (!footer) return;
    var buttons = footer.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = value;
    var status = footer.querySelector('[data-action="status"]');
    if (status) {
      status.style.display = value ? 'block' : 'none';
      status.textContent = '';
    }
  }

  function activeOptionKey(group) {
    for (var i = 0; i < group.options.length; i++) {
      if ((group.options[i].style.background || '').indexOf(ACTIVE_FILTER) !== -1) return optionKey(group.options[i]);
    }
    return '';
  }

  function applyPending(pending, index, footer, attempts) {
    if (index >= pending.length) {
      setApplying(false);
      closeQuickView();
      return;
    }
    var drawer = currentDrawer();
    var group = drawer && filterGroups(drawer).filter(function (item) {
      return item.title === pending[index].title;
    })[0];
    if (!group) {
      showApplyError(footer, 'Could not apply filters. Please reopen the panel and try again.');
      return;
    }
    var target = group.options.filter(function (option) {
      return optionKey(option) === pending[index].key;
    })[0];
    if (!target) {
      showApplyError(footer, 'A filter option is no longer available. Please review your selections.');
      return;
    }
    if (activeOptionKey(group) === pending[index].key) {
      window.setTimeout(function () { applyPending(pending, index + 1, footer, 0); }, 0);
      return;
    }
    if (!attempts) target.click();
    if (attempts >= 25) {
      showApplyError(footer, 'A filter did not update. Please try applying your filters again.');
      return;
    }
    window.setTimeout(function () { applyPending(pending, index, footer, attempts + 1); }, 40);
  }

  function showApplyError(footer, message) {
    setApplying(false);
    var status = footer && footer.querySelector('[data-action="status"]');
    if (status) {
      status.style.display = 'block';
      status.textContent = message;
    }
  }

  function closeQuickView() {
    var drawer = currentDrawer();
    pipelineDraft = {};
    setApplying(false);
    if (!drawer) return;
    var buttons = drawer.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || '').trim() === '✕') {
        buttons[i].click();
        return;
      }
    }
    drawer.remove();
  }

  function sync() {
    frame = 0;
    if (!routeSupported()) {
      stopObservingDrawer();
      removeInjectedSelects();
      return;
    }

    var drawer = observedDrawer && observedDrawer.isConnected
      ? observedDrawer
      : currentDrawer();
    observeDrawer(drawer);
    if (drawer && parseFloat(window.getComputedStyle(drawer).right) < -100 && !applyInProgress) {
      pipelineDraft = {};
    }
    var groups = drawer ? filterGroups(drawer) : [];
    if (!groups.length) {
      removeFooters();
      return;
    }

    for (var i = 0; i < groups.length; i++) renderGroup(groups[i]);
    ensureFooter(drawer);
    if (drawer) removeClearButton(drawer);
  }

  function scheduleSync() {
    if (frame) return;
    frame = window.requestAnimationFrame(sync);
  }

  function containsQuickView(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'SPAN') {
      var text = (node.textContent || '').trim();
      if (text === 'Pipeline Quick View' || text === 'Recruiter Quick View') return true;
    }
    var labels = node.querySelectorAll('span');
    for (var i = 0; i < labels.length; i++) {
      var title = (labels[i].textContent || '').trim();
      if (title === 'Pipeline Quick View' || title === 'Recruiter Quick View') return true;
    }
    return false;
  }

  function start() {
    var pageObserver = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (observedDrawer && observedDrawer.isConnected) {
          for (var j = 0; j < record.addedNodes.length; j++) {
            if (record.addedNodes[j] === observedDrawer || (record.addedNodes[j].contains && record.addedNodes[j].contains(observedDrawer))) {
              scheduleSync();
              return;
            }
          }
          for (var k = 0; k < record.removedNodes.length; k++) {
            if (record.removedNodes[k] === observedDrawer || (record.removedNodes[k].contains && record.removedNodes[k].contains(observedDrawer))) {
              scheduleSync();
              return;
            }
          }
        } else {
          for (var n = 0; n < record.addedNodes.length; n++) {
            if (containsQuickView(record.addedNodes[n])) {
              scheduleSync();
              return;
            }
          }
        }
      }
    });
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
