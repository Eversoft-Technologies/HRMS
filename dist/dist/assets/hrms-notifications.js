(function () {
  'use strict';

  var STORAGE_KEY = 'hrms_session';
  var BUTTON_ID = 'hrms-notifications-btn';
  var PANEL_ID = 'hrms-notifications-panel';
  var SEARCH_ID = 'hrms-notifications-search';
  var FILTER_ID = 'hrms-notifications-filter';
  var SELECT_ALL_ID = 'hrms-notifications-select-all';
  var DELETE_SELECTED_ID = 'hrms-notifications-delete-selected';
  var CLEAR_ALL_ID = 'hrms-notifications-clear-all';
  var MARK_READ_ID = 'hrms-notifications-mark-all-read';
  var REFRESH_MS = 30000;

  var state = {
    items: [],
    // Unread by default: a notification you have opened has done its job, so
    // it leaves the list. Nothing is deleted — All / Read still show it.
    filter: 'unread',
    search: '',
    selected: {},
    activeId: null,   // the notification just clicked, while the panel is open
  };

  function actorEmail() {
    try {
      var session = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return (session.email || session.userEmail || session.user?.email || '').toString().trim();
    } catch (_) {
      return '';
    }
  }

  function findExistingBell() {
    var selectors = [
      '.topbar [aria-label*="notif" i]',
      '.topbar [title*="notif" i]',
      '.topbar button[class*="bell" i]',
      '.topbar [data-route*="notif" i]',
      '.topbar [class*="notification" i]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      // Accept BUTTON, A, or DIV — React often renders interactive elements as divs
      if (el && el.tagName && /BUTTON|A|DIV/i.test(el.tagName)) {
        return el;
      }
    }
    return null;
  }

  function createPanel() {
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.position = 'absolute';
    panel.style.width = '360px';
    panel.style.maxWidth = 'calc(100vw - 24px)';
    panel.style.maxHeight = '420px';
    panel.style.overflow = 'hidden';
    panel.style.background = 'var(--surface, #0f172a)';
    panel.style.border = '1px solid var(--border, rgba(255,255,255,0.12))';
    panel.style.borderRadius = '14px';
    panel.style.boxShadow = '0 14px 45px rgba(0,0,0,0.24)';
    panel.style.display = 'none';
    panel.style.zIndex = '2000';
    panel.style.minWidth = '320px';
    panel.style.fontFamily = 'Inter, system-ui, sans-serif';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border, rgba(255,255,255,0.12));">
        <strong style="font-size:13px;">Notifications</strong>
        <button type="button" id="hrms-notifications-close" style="border:none;background:none;color:var(--text2,#94a3b8);cursor:pointer;font-size:12px;">Close</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border, rgba(255,255,255,0.12));">
        <input id="${SEARCH_ID}" placeholder="Search notifications..." style="flex:1;min-width:120px;background:var(--surface2,rgba(255,255,255,0.06));border:1px solid var(--border,rgba(255,255,255,0.10));border-radius:10px;padding:8px 10px;color:var(--text);font-size:12px;" />
        <select id="${FILTER_ID}" style="background:var(--surface2,rgba(255,255,255,0.06));border:1px solid var(--border,rgba(255,255,255,0.10));border-radius:10px;padding:8px 10px;color:var(--text);font-size:12px;">
          <option value="unread" selected>Unread</option>
          <option value="all">All</option>
          <option value="read">Read</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border, rgba(255,255,255,0.12));gap:8px;flex-wrap:wrap;">
        <label style="display:inline-flex;align-items:center;gap:6px;color:var(--text2,#94a3b8);font-size:12px;">
          <input id="${SELECT_ALL_ID}" type="checkbox" style="accent-color:var(--accent,#4f8ef7);width:14px;height:14px;cursor:pointer;" />
          Select all
        </label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="${MARK_READ_ID}" type="button" style="border:1px solid var(--border,rgba(255,255,255,0.10));background:var(--surface2,rgba(255,255,255,0.06));color:var(--text);border-radius:10px;padding:8px 10px;font-size:12px;cursor:pointer;">Mark all read</button>
          <button id="${DELETE_SELECTED_ID}" type="button" style="border:1px solid var(--border,rgba(255,255,255,0.10));background:var(--surface2,rgba(255,255,255,0.06));color:var(--text);border-radius:10px;padding:8px 10px;font-size:12px;cursor:pointer;">Delete selected</button>
          <button id="${CLEAR_ALL_ID}" type="button" style="border:1px solid var(--border,rgba(255,255,255,0.10));background:var(--surface2,rgba(255,255,255,0.06));color:var(--text);border-radius:10px;padding:8px 10px;font-size:12px;cursor:pointer;">Clear all</button>
        </div>
      </div>
      <div id="hrms-notifications-list" style="max-height:280px;overflow:auto;padding:8px 8px 12px;"></div>
    `.trim();

    var closeBtn = panel.querySelector('#hrms-notifications-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        hidePanel();
      });
    }

    return panel;
  }

  function syncBadgeVisibility(btn) {
    if (!btn) return;
    Array.from(btn.children).forEach(function (child) {
      if (child.id !== 'hrms-notifications-badge' && child.tagName && child.tagName.toLowerCase() !== 'svg') {
        child.style.display = 'none';
      }
    });
  }

  function setBadge(count) {
    var badge = document.getElementById('hrms-notifications-badge');
    if (!badge) return;
    var n = Number(count || 0);
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'inline-block' : 'none';

    var btn = document.getElementById(BUTTON_ID);
    if (btn) {
      syncBadgeVisibility(btn);
    }
  }

  function normalizeString(value) {
    return (value || '').toString().toLowerCase();
  }

  function filteredItems() {
    var items = state.items || [];
    var q = normalizeString(state.search);
    if (state.filter === 'unread') {
      // The one just clicked stays on screen while you are still looking at
      // the panel; it drops out once the panel closes.
      items = items.filter(function (item) {
        return item.isRead === false ||
          (state.activeId != null && String(state.activeId) === String(item.id));
      });
    } else if (state.filter === 'read') {
      items = items.filter(function (item) { return item.isRead === true; });
    }
    if (q) {
      items = items.filter(function (item) {
        return normalizeString(item.title).indexOf(q) !== -1 ||
               normalizeString(item.message).indexOf(q) !== -1 ||
               normalizeString(item.link).indexOf(q) !== -1;
      });
    }
    return items;
  }

  function updateSelectAllControl() {
    var checkbox = document.getElementById(SELECT_ALL_ID);
    if (!checkbox) return;
    var visible = filteredItems();
    var total = visible.length;
    var selected = visible.filter(function (item) {
      return state.selected[item.id];
    }).length;
    checkbox.checked = total > 0 && selected === total;
    checkbox.indeterminate = selected > 0 && selected < total;
  }

  function renderList(items) {
    var list = document.getElementById('hrms-notifications-list');
    if (!list) return;
    if (!items || !items.length) {
      var caughtUp = state.filter === 'unread' && !state.search;
      list.innerHTML = '<div style="padding:18px 10px;font-size:13px;color:var(--text2,#94a3b8);text-align:center;">' +
        (caughtUp ? 'You’re all caught up. Opened notifications are under <b>All</b> / <b>Read</b>.'
                  : 'No notifications match your search or filter.') + '</div>';
      return;
    }

    list.innerHTML = '';
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '20px 1fr 24px';
      row.style.gap = '10px';
      row.style.alignItems = 'start';
      row.style.padding = '10px 10px 12px';
      row.style.borderRadius = '10px';
      row.style.marginBottom = '6px';
      var active = state.activeId != null && String(state.activeId) === String(item.id);
      var restBg = item.isRead ? 'transparent' : 'rgba(79, 142, 247, 0.12)';
      row.setAttribute('data-nid', item.id);
      row.style.transition = 'background-color .15s ease, border-color .15s ease, box-shadow .15s ease';
      if (active) {
        // The one you clicked: unmistakable, and still marked when you come
        // back to the panel after it took you to the page.
        row.style.background = 'rgba(79, 142, 247, 0.20)';
        row.style.border = '1.5px solid var(--accent, #4f8ef7)';
        row.style.boxShadow = '0 0 0 3px rgba(79, 142, 247, 0.18)';
      } else {
        row.style.background = restBg;
        row.style.border = '1px solid var(--border, rgba(255,255,255,0.10))';
        row.addEventListener('mouseenter', function () { row.style.background = 'rgba(79, 142, 247, 0.08)'; });
        row.addEventListener('mouseleave', function () { row.style.background = restBg; });
      }

      var checkboxWrap = document.createElement('div');
      checkboxWrap.style.display = 'flex';
      checkboxWrap.style.alignItems = 'center';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(state.selected[item.id]);
      checkbox.style.accentColor = 'var(--accent,#4f8ef7)';
      checkbox.style.cursor = 'pointer';
      checkbox.addEventListener('click', function (e) {
        e.stopPropagation();
      });
      checkbox.addEventListener('change', function () {
        state.selected[item.id] = checkbox.checked;
        updateSelectAllControl();
      });
      checkboxWrap.appendChild(checkbox);

      var content = document.createElement('div');
      content.style.cursor = 'pointer';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      var target = resolveLink(item);
      content.addEventListener('click', function () {
        if (!item.id) return;
        state.activeId = item.id;
        if (!item.isRead) {
          markRead(item.id);
          item.isRead = true;
        }
        renderPanel();
        if (target) {
          hidePanel();
          openTarget(target);
        }
      });

      var title = document.createElement('div');
      title.textContent = item.title || 'Notification';
      title.style.fontWeight = '700';
      title.style.fontSize = '13px';
      title.style.marginBottom = '4px';

      var message = document.createElement('div');
      message.textContent = item.message || '';
      message.style.fontSize = '12px';
      message.style.color = 'var(--text2,#94a3b8)';
      message.style.lineHeight = '1.4';

      var meta = document.createElement('div');
      meta.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
      meta.style.fontSize = '11px';
      meta.style.marginTop = '8px';
      meta.style.color = 'var(--text3,#64748b)';

      if (active) {
        var last = document.createElement('span');
        last.textContent = '  ·  Last opened';
        last.style.color = 'var(--accent,#4f8ef7)';
        last.style.fontWeight = '600';
        meta.appendChild(last);
      }
      if (target && !active) {
        var open = document.createElement('span');
        open.textContent = '  ·  Open ›';
        open.style.color = 'var(--accent,#4f8ef7)';
        open.style.fontWeight = '600';
        meta.appendChild(open);
        content.title = 'Go to this notification';
      }

      content.appendChild(title);
      content.appendChild(message);
      content.appendChild(meta);

      var deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.innerHTML = '&#x2715;';
      deleteButton.title = 'Delete notification';
      deleteButton.style.border = 'none';
      deleteButton.style.background = 'transparent';
      deleteButton.style.color = 'var(--text2,#94a3b8)';
      deleteButton.style.cursor = 'pointer';
      deleteButton.style.fontSize = '14px';
      deleteButton.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deleteNotification(item.id);
      });

      row.appendChild(checkboxWrap);
      row.appendChild(content);
      row.appendChild(deleteButton);
      list.appendChild(row);
    });
  }

  /* ── Where a notification leads ─────────────────────────────────────────
     The server stores a link per notification: a path, optionally with
       ?focus=<text>   scroll to + highlight the row/card containing that text
       ?admin=<tab>    open the Attendance Settings overlay on that tab
       ?tab=<tab>      (onboarding) open the candidate drawer on that tab
     Older rows predate some of these links, so they are inferred from the
     title — the server only ever rewrote them to a bare page path. */
  var TITLE_ROUTES = [
    [/(off-site|away-from-home) check-in awaiting|out-of-office check-in needs|home location awaiting/i, '/employees/checkin?admin=reviews'],
    [/\bwfh\b|work-from-home/i, '/employees/checkin?focus=Work+From+Home'],
    [/attendance correction/i, '/employees/leave'],
  ];
  var KEYWORD_ROUTES = [
    [/leave/i, '/employees/leave'],
    [/submission/i, '/employees/submissions'],
    [/task/i, '/employees/tasks'],
    [/interview/i, '/recruit/interview'],
    [/onboarding/i, '/onboarding'],
    [/check-?in|check-?out|attendance|break|overtime|working day|work arrangement|home location/i, '/employees/attendance'],
  ];

  function resolveLink(item) {
    var link = String(item.link || '').trim();
    // Only same-app paths: '/x', never '//host' or 'javascript:'.
    if (link && (link.charAt(0) !== '/' || link.charAt(1) === '/')) link = '';
    var generic = !link || link === '/attendance' || link === '/employees/attendance';
    if (generic) {
      for (var i = 0; i < TITLE_ROUTES.length; i++) {
        if (TITLE_ROUTES[i][0].test(item.title || '')) return TITLE_ROUTES[i][1];
      }
    }
    if (link === '/attendance') return '/employees/attendance';
    if (link) return link;
    for (var j = 0; j < KEYWORD_ROUTES.length; j++) {
      // Title only: message bodies mention other modules in passing.
      if (KEYWORD_ROUTES[j][0].test(item.title || '')) return KEYWORD_ROUTES[j][1];
    }
    return '';
  }

  var focusTimer = null;

  function openTarget(link) {
    var url;
    try { url = new URL(link, location.origin); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    var path = url.pathname.replace(/\/+$/, '') || '/';
    var q = url.searchParams;

    var ob = path.match(/^\/onboarding(\/.*)?$/);
    if (ob) {
      // The onboarding pages are a sidecar React doesn't know about; a popstate
      // would make React Router bounce to '/'. Let that script navigate.
      var sub = ob[1] || '';
      var cand = sub.match(/^\/candidates\/(\d+)$/);
      if (window.__hrmsOnboardingOpen) {
        window.__hrmsOnboardingOpen(cand ? '/candidates' : sub, cand ? Number(cand[1]) : null, q.get('tab') || undefined);
      } else {
        window.location.assign(path);
      }
    } else if (location.pathname.replace(/\/+$/, '') !== path) {
      try {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new CustomEvent('hrmsNavigate', { detail: { path: path } }));
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch (_) {
        window.location.assign(path);
        return;
      }
    }

    var admin = q.get('admin');
    if (admin) {
      whenReady(function () { return window.__hrmsOpenAttendanceAdmin; }, function (openAdmin) {
        openAdmin(admin);
      });
    }
    var focus = q.get('focus');
    if (focus) focusOn(focus, path);
  }

  /* Poll for fn() to return something truthy (pages render, then fetch). */
  function whenReady(fn, then, ms) {
    var deadline = Date.now() + (ms || 8000);
    (function tick() {
      var v = null;
      try { v = fn(); } catch (_) {}
      if (v) { then(v); return; }
      if (Date.now() < deadline) setTimeout(tick, 200);
    })();
  }

  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
  }

  /* The smallest visible row/card on the page whose text contains `text`. */
  function findFocusTarget(text) {
    var root = document.querySelector('.main') || document.body;
    var needle = text.toLowerCase();
    var groups = ['tr', '[role="row"]', 'li', '[class*="card" i]', '[class*="item" i]', '[class*="row" i]'];
    for (var g = 0; g < groups.length; g++) {
      var els = root.querySelectorAll(groups[g]);
      var best = null;
      var bestLen = Infinity;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.closest('#' + PANEL_ID) || el.closest('.topbar')) continue;
        var t = (el.textContent || '').toLowerCase();
        if (t.indexOf(needle) === -1 || t.length >= bestLen || !isVisible(el)) continue;
        best = el;
        bestLen = t.length;
      }
      if (best) return best;
    }
    return null;
  }

  function focusOn(text, path) {
    if (focusTimer) clearTimeout(focusTimer);
    var deadline = Date.now() + 8000;
    (function tick() {
      // Stop if the user has moved on to another page meanwhile.
      if ((location.pathname.replace(/\/+$/, '') || '/') !== path) return;
      var el = findFocusTarget(text);
      if (!el) {
        if (Date.now() < deadline) focusTimer = setTimeout(tick, 250);
        return;
      }
      highlight(el);
    })();
  }

  function highlight(el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { el.scrollIntoView(); }
    var prev = { outline: el.style.outline, offset: el.style.outlineOffset, shadow: el.style.boxShadow, transition: el.style.transition };
    el.style.transition = 'box-shadow 0.4s ease, outline-color 0.4s ease';
    el.style.outline = '2px solid var(--accent, #4f8ef7)';
    el.style.outlineOffset = '2px';
    el.style.boxShadow = '0 0 0 6px rgba(79, 142, 247, 0.18)';
    setTimeout(function () {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      el.style.boxShadow = prev.shadow;
      setTimeout(function () { el.style.transition = prev.transition; }, 450);
    }, 2800);
  }

  function renderPanel() {
    var visible = filteredItems();
    renderList(visible);
    updateSelectAllControl();
    if (state.activeId != null) {
      var activeRow = document.querySelector('#hrms-notifications-list [data-nid="' + state.activeId + '"]');
      if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
    }
  }

  function fetchNotifications(opts) {
    var email = actorEmail();
    if (!email) {
      setBadge(0);
      return;
    }
    // Don't poll into a dead network — the request can only fail, and zeroing
    // the badge on that failure would hide unread counts we already know about.
    if (window.HRMSNet && !window.HRMSNet.ready('notifications', opts)) return;
    var headers = { 'X-User-Email': email };
    var req = window.HRMSNet
      ? window.HRMSNet.fetch('notifications', '/api/notifications?unreadOnly=true', { headers: headers })
      : fetch('/api/notifications?unreadOnly=true', { headers: headers });
    req
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        var count = Array.isArray(items) ? items.length : 0;
        setBadge(count);
        if (document.getElementById(PANEL_ID) && document.getElementById(PANEL_ID).style.display !== 'none') {
          loadPanelItems();
        }
      })
      .catch(function () { setBadge(0); });
  }

  function loadPanelItems() {
    var email = actorEmail();
    if (!email) return;
    var headers = { 'X-User-Email': email };
    fetch('/api/notifications', { headers: headers })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        state.items = Array.isArray(items) ? items : [];
        renderPanel();
      })
      .catch(function () {
        state.items = [];
        renderPanel();
      });
  }

  function markRead(id) {
    var email = actorEmail();
    if (!email || !id) return;
    fetch('/api/notifications/' + id + '/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Email': email }
    }).then(function () {
      state.items = state.items.map(function (item) {
        if (item.id === id) {
          item.isRead = true;
        }
        return item;
      });
      fetchNotifications();
    }).catch(function () {});
  }

  function deleteNotification(id) {
    var email = actorEmail();
    if (!email || !id) return;
    fetch('/api/notifications/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-User-Email': email }
    }).then(function (res) {
      if (res.ok) {
        state.items = state.items.filter(function (item) { return item.id !== id; });
        delete state.selected[id];
        renderPanel();
        fetchNotifications();
      }
    }).catch(function () {});
  }

  function deleteSelected() {
    var ids = Object.keys(state.selected).filter(function (id) {
      return state.selected[id];
    });
    if (!ids.length) {
      return;
    }
    deleteNotifications(ids);
  }

  function deleteNotifications(ids) {
    var email = actorEmail();
    if (!email || !ids || !ids.length) return;
    fetch('/api/notifications/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Email': email,
      },
      body: JSON.stringify({ ids: ids })
    }).then(function (res) {
      if (res.ok) {
        var toRemove = ids.map(Number);
        state.items = state.items.filter(function (item) {
          return toRemove.indexOf(Number(item.id)) === -1;
        });
        toRemove.forEach(function (id) { delete state.selected[id]; });
        renderPanel();
        fetchNotifications();
      }
    }).catch(function () {});
  }

  function clearAll() {
    var ids = state.items.map(function (item) { return item.id; });
    if (!ids.length) return;
    deleteNotifications(ids);
  }

  function markAllRead() {
    var unread = state.items.filter(function (item) { return !item.isRead; });
    unread.forEach(function (item) { markRead(item.id); });
  }

  function positionPanel(panel, trigger) {
    if (!panel || !trigger) return;
    var rect = trigger.getBoundingClientRect();
    var left = rect.left + window.pageXOffset;
    var top = rect.bottom + window.pageYOffset + 8;
    panel.style.left = Math.min(left, window.innerWidth - panel.offsetWidth - 12) + 'px';
    panel.style.top = top + 'px';
  }

  function showPanel() {
    var panel = document.getElementById(PANEL_ID);
    var btn = document.getElementById(BUTTON_ID);
    if (!panel || !btn) return;
    panel.style.display = 'block';
    positionPanel(panel, btn);
    loadPanelItems();
  }

  function hidePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.style.display = 'none';
    // Closing ends the "just clicked" highlight, so next time it is gone.
    state.activeId = null;
  }

  function togglePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (panel.style.display === 'block') {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function wirePanel(toolbar, panel) {
    var search = toolbar.querySelector('#' + SEARCH_ID);
    var filter = toolbar.querySelector('#' + FILTER_ID);
    var selectAll = toolbar.querySelector('#' + SELECT_ALL_ID);
    var deleteSelectedBtn = toolbar.querySelector('#' + DELETE_SELECTED_ID);
    var clearAllBtn = toolbar.querySelector('#' + CLEAR_ALL_ID);
    var markReadBtn = toolbar.querySelector('#' + MARK_READ_ID);

    if (search) {
      search.addEventListener('input', function (e) {
        state.search = e.target.value || '';
        renderPanel();
      });
    }
    if (filter) {
      filter.addEventListener('change', function (e) {
        state.filter = e.target.value || 'unread';
        renderPanel();
      });
    }
    if (selectAll) {
      selectAll.addEventListener('change', function (e) {
        var visible = filteredItems();
        visible.forEach(function (item) {
          state.selected[item.id] = e.target.checked;
        });
        renderPanel();
      });
    }
    if (deleteSelectedBtn) {
      deleteSelectedBtn.addEventListener('click', function () {
        deleteSelected();
      });
    }
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function () {
        clearAll();
      });
    }
    if (markReadBtn) {
      markReadBtn.addEventListener('click', function () {
        markAllRead();
      });
    }
  }

  /* The app's own topbar bell is what we enhance. React renders it only on
     signed-in pages and may re-create it (sign-in, layout changes), so rather
     than binding once at load — which used to give up after ~12s on the login
     page, fall back to a hidden bell of our own, and leave the real one dead
     after sign-in — adopt whichever bell is in the topbar right now, and
     handle clicks by delegation so a re-created bell keeps working. */
  function adoptBell() {
    var current = document.getElementById(BUTTON_ID);
    if (current && current.isConnected && current.closest('.topbar')) return current;
    var bell = findExistingBell();
    if (!bell) return null;
    bell.id = BUTTON_ID;
    bell.setAttribute('aria-label', 'Notifications');
    bell.style.position = bell.style.position || 'relative';
    if (!bell.querySelector('#hrms-notifications-badge')) {
      var stale = document.getElementById('hrms-notifications-badge');
      if (stale) stale.remove();
      var badge = document.createElement('span');
      badge.id = 'hrms-notifications-badge';
      badge.textContent = '0';
      badge.style.position = 'absolute';
      badge.style.top = '-2px';
      badge.style.right = '-2px';
      badge.style.minWidth = '18px';
      badge.style.height = '18px';
      badge.style.padding = '0 5px';
      badge.style.fontSize = '10px';
      badge.style.lineHeight = '18px';
      badge.style.borderRadius = '999px';
      badge.style.background = 'var(--danger, #ef4444)';
      badge.style.color = '#fff';
      badge.style.display = 'none';
      bell.appendChild(badge);
    }
    // A new bell (e.g. just signed in) should show the current count at once.
    fetchNotifications({ background: false });
    return bell;
  }

  function start() {
    var panel = createPanel();
    document.body.appendChild(panel);
    wirePanel(panel, panel);

    // Capture phase: runs before React's own handler and before the
    // outside-click handler below, whichever bell element is current.
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      if (target.closest('#' + BUTTON_ID)) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      }
    }, true);

    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      // Clicking a notification re-renders the list, so by the time the click
      // bubbles here its target may already be detached — that is a click
      // inside the panel, not outside it.
      if (!target.isConnected) return;
      if (target.closest('#' + PANEL_ID) || target.closest('#' + BUTTON_ID)) return;
      hidePanel();
    });

    window.addEventListener('resize', function () {
      var p = document.getElementById(PANEL_ID);
      var btn = document.getElementById(BUTTON_ID);
      if (p && p.style.display === 'block' && btn) positionPanel(p, btn);
    });

    adoptBell();
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        var bell = adoptBell();
        // Signed out / no topbar: don't leave the panel floating.
        if (!bell) hidePanel();
      }, 50);
    }).observe(document.body, { childList: true, subtree: true });

    fetchNotifications({ background: false });
    setInterval(fetchNotifications, REFRESH_MS);
    /* the interval is suppressed while hidden/offline — catch up on return */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchNotifications({ background: false });
    });
    window.addEventListener('hrmsNetOnline', function () { fetchNotifications({ background: false }); });

    setInterval(function () {
      var btn = document.getElementById(BUTTON_ID);
      if (btn) {
        syncBadgeVisibility(btn);
      }
    }, 500);
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  init();
})();
