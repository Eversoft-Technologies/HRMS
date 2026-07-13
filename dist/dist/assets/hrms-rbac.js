/**
 * hrms-rbac.js
 * Role-Based Access Control admin console (Super Admin only).
 *
 * Adds an "Access Control" item to the sidebar and opens a full console overlay
 * wired to the Django RBAC API (/api/roles, /api/permission-groups,
 * /api/permissions, /api/rbac/stats). Same no-rebuild injection pattern as
 * hrms-attendance.js — a self-contained overlay reusing the app's own CSS
 * classes (card / badge / btn-primary / input-field / table-wrap) so it matches
 * the rest of the UI without touching the React bundle or router.
 */
(function () {
  'use strict';

  var PAGE_ID = 'hrms-rbac-page';
  var NAV_ID = 'hrms-rbac-nav';
  var ACTIVE_CLS = 'hrms-rbac-active';   // set on .content while RBAC owns it

  /* ── icons ───────────────────────────────────────────────────────────── */
  var SHIELD =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>';

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function isAdmin() {
    // Only true admins may see the Administration → Access Control nav and open
    // the RBAC console. HR / Recruitment / Managers are intentionally excluded.
    try {
      var r = (JSON.parse(localStorage.getItem('hrms_session') || '{}').role || '').toLowerCase();
      return r === 'admin' || r === 'super admin';
    } catch (_) { return false; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    var hdrs = { 'Content-Type': 'application/json' };
    try { var s = JSON.parse(localStorage.getItem('hrms_session') || '{}'); if (s.email) hdrs['X-User-Email'] = s.email; } catch (_) {}
    opts.headers = Object.assign(hdrs, opts.headers || {});
    return fetch('/api' + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    }).catch(function () { return { ok: false, status: 0, data: null }; });
  }
  function toast(msg) {
    var t = document.getElementById('hrms-rbac-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  /* ── state ───────────────────────────────────────────────────────────── */
  var state = { tab: 'dashboard', sub: null };

  var TABS = [
    ['dashboard', 'Dashboard'],
    ['users', 'Users'],
    ['roles', 'Roles'],
    ['groups', 'Permission Groups'],
    ['permissions', 'Permissions'],
  ];

  /* Canonical permission codes the BACKEND actually enforces. A permission only
     does something if its code matches one the server checks, so the Create-
     Permission forms offer this list in a dropdown (grouped by module) instead
     of a free-text box — preventing typos and dead codes. "Custom code…" keeps
     the escape hatch for a brand-new code you're wiring up on the backend. */
  var CODE_CATALOG = [
    ['Dashboard',   [['dashboard.view', 'View Dashboard']]],
    ['Employee',    [['employee.view', 'View Employee'], ['employee.create', 'Create Employee'],
                     ['employee.edit', 'Update Employee'], ['employee.delete', 'Delete Employee'],
                     ['submission.action', 'Action (Approve / Reject)']]],
    ['Attendance',  [['attendance.view', 'View Attendance'], ['attendance.create', 'Create Attendance Log'],
                     ['attendance.edit', 'Edit Attendance'], ['attendance.delete', 'Delete Attendance Log'],
                     ['attendance.checkinout', 'Check-in / Check-out'],
                     ['attendance.remote', 'Work Remotely (no approval needed)']]],
    ['Leave',       [['leave.view', 'View Leave'], ['leave.create', 'Create Leave Request'],
                     ['leave.action', 'Action (Approve / Reject)'],
                     ['leave.delete', 'Delete Leave Request']]],
    ['Recruitment', [['recruitment.view', 'View Recruitment'], ['recruitment.create', 'Create Recruitment'],
                     ['recruitment.edit', 'Edit Recruitment'], ['recruitment.delete', 'Delete Recruitment'],
                     ['recruitment.kpi.view_own', 'KPI Dashboard — My View'],
                     ['recruitment.kpi.view_org', 'KPI Dashboard — Org View']]],
    ['Payroll',     [['payroll.view', 'View Payroll'], ['payroll.generate', 'Generate Payroll'],
                     ['payroll.approve', 'Approve Payroll'], ['payroll.manage', 'Manage Payroll']]],
    ['Reports',     [['reports.view', 'View Reports'], ['reports.export', 'Export Reports']]],
    ['Settings',    [['settings.view', 'View Settings'], ['settings.manage', 'Manage Settings']]],
    ['RBAC',        [['rbac.view', 'View Access Control'], ['rbac.manage', 'Manage Access Control']]],
  ];

  /* Build a code <select> (grouped) + a "custom" text input revealed when
     "Custom code…" is chosen. `nameId` is the NAME field to auto-fill on pick.
     `current` preselects an existing code; a code that isn't in the catalog
     (any code created via the custom box) drops straight into custom mode with
     its value filled in — otherwise editing such a permission would silently
     blank its code. */
  function codeSelect(selectId, customId, nameId, current) {
    current = (current || '').trim();
    var known = CODE_CATALOG.some(function (m) {
      return m[1].some(function (c) { return c[0] === current; });
    });
    var isCustom = !!current && !known;
    var opts = CODE_CATALOG.map(function (m) {
      return '<optgroup label="' + esc(m[0]) + '">' + m[1].map(function (c) {
        return '<option value="' + esc(c[0]) + '" data-name="' + esc(c[1]) + '"' +
          (c[0] === current ? ' selected' : '') + '>' + esc(c[0]) + ' — ' + esc(c[1]) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    return '<select class="input-field rbac-codesel" id="' + selectId + '" data-custom="' + customId + '" data-name="' + nameId + '">' +
        '<option value="">— select code —</option>' + opts +
        '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>✎ Custom code…</option>' +
      '</select>' +
      '<input class="input-field" id="' + customId + '" placeholder="module.action" value="' + esc(isCustom ? current : '') + '"' +
        ' style="margin-top:6px' + (isCustom ? '' : ';display:none') + '">';
  }
  /* Read the chosen code: the select value, or the custom input when custom. */
  function readCode(selectId, customId) {
    var sel = document.getElementById(selectId);
    if (!sel) return val(customId);                       // fallback (old markup)
    if (sel.value === '__custom__') return val(customId);
    return (sel.value || '').trim();
  }

  function statusBadge(active) {
    return active === false
      ? '<span class="badge" style="opacity:.7">Inactive</span>'
      : '<span class="badge green">Active</span>';
  }
  /* Every field the Edit form needs, carried on the button. */
  function permAttrs(p) {
    return ' data-id="' + p.id + '"' +
      ' data-name="' + esc(p.name) + '"' +
      ' data-code="' + esc(p.code) + '"' +
      ' data-desc="' + esc(p.description || '') + '"' +
      ' data-group="' + (p.groupId || '') + '"' +
      ' data-active="' + (p.isActive ? 1 : 0) + '"';
  }

  /* ── page shell (full-page, replaces .content area) ─────────────────── */
  /* Siblings are hidden with a class on .content (see injectStyle) rather than
     by stamping display:none on each child. React owns .content and re-renders
     it on its own schedule, so any snapshot we take goes stale — new nodes
     would appear alongside the panel, and restoring a stale list left the real
     page blank. A class covers whatever .content holds, whenever it holds it. */
  function open() {
    if (document.getElementById(PAGE_ID)) return;
    injectStyle();
    var content = document.querySelector('.content');
    if (!content) return;
    content.classList.add(ACTIVE_CLS);

    var page = document.createElement('div');
    page.id = PAGE_ID;
    page.className = 'hrms-rbac-page';
    content.appendChild(page);
    document.addEventListener('keydown', onKey);
    buildSkeleton();
    render();
  }
  function close() {
    var page = document.getElementById(PAGE_ID);
    if (page && page.parentNode) page.parentNode.removeChild(page);
    // Clear the flag wherever it landed — .content may have been swapped out.
    Array.prototype.forEach.call(
      document.querySelectorAll('.' + ACTIVE_CLS),
      function (el) { el.classList.remove(ACTIVE_CLS); }
    );
    document.removeEventListener('keydown', onKey);
    state.sub = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  /* Open RBAC on its own route. The sidebar entry used to call open() directly
     with preventDefault(), so the panel appeared while the URL still pointed at
     whatever page you were on (Attendance, Job Board, …) — that is how it ended
     up rendering over unrelated modules. Navigate first, then open. */
  function openAt(tab) {
    state.tab = tab || 'dashboard';
    state.sub = null;
    if (isSettingsRoute()) { open(); return; }
    history.pushState({}, '', '/settings');
    // React Router listens on popstate; pushState alone fires nothing.
    window.dispatchEvent(new PopStateEvent('popstate'));
    // Let React commit the Settings route before we take over .content.
    setTimeout(open, 0);
  }

  /* ── route guard ─────────────────────────────────────────────────────────
     RBAC is a /settings-only surface, but it is injected into .content rather
     than owned by the React router — so nothing tore it down when the user
     navigated away. The page (and the settings card) then rode along on top of
     Job Board, Attendance, etc., and because open() display:none's the .content
     siblings it also swallowed clicks, which is why module links appeared dead.
     Tear both down as soon as the path is no longer /settings. */
  function isSettingsRoute() {
    return window.location.pathname.replace(/\/+$/, '') === '/settings';
  }

  function syncRoute() {
    if (isSettingsRoute()) return;
    if (document.getElementById(PAGE_ID)) {
      close();
      state.tab = 'dashboard';   // don't reopen mid-flow on the next visit
    }
    var card = document.getElementById('hrms-rbac-settings-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
  }

  /* The SPA navigates with pushState/replaceState, which fire no event — wrap
     them so we learn about every route change, and cover Back/Forward too. */
  function watchRoute() {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      if (!orig || orig.__rbacWrapped) return;
      var wrapped = function () {
        var out = orig.apply(this, arguments);
        syncRoute();
        return out;
      };
      wrapped.__rbacWrapped = true;
      history[fn] = wrapped;
    });
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
  }

  /* Build the page chrome once. Tab switches only swap the body, so the page
     never re-renders the header/tabs when switching. */
  function buildSkeleton() {
    var page = document.getElementById(PAGE_ID);
    if (!page) return;
    page.innerHTML =
      '<div class="hrms-rbac-topbar">' +
        '<div class="hrms-rbac-topbar-left">' +
          '<div class="hrms-rbac-title">' + SHIELD + ' Role-Based Access Control</div>' +
          '<div class="hrms-rbac-sub">Create roles, group permissions, and assign access to users</div>' +
        '</div>' +
        '<button class="hrms-rbac-back-btn" data-act="close">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>' +
          ' Back to Settings' +
        '</button>' +
      '</div>' +
      '<div class="hrms-rbac-tabs">' +
        TABS.map(function (t) {
          return '<button class="hrms-rbac-tab" data-act="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="hrms-rbac-body"></div>' +
      '<div id="hrms-rbac-toast" class="hrms-rbac-toast"></div>';
    wire();
  }

  /* Update ONLY the body + the active-tab highlight — the header/tabs DOM is
     preserved, so switching tabs is a smooth in-place swap, not a rebuild. */
  function shell(bodyHtml) {
    var page = document.getElementById(PAGE_ID);
    if (!page) return;
    var body = page.querySelector('.hrms-rbac-body');
    if (!body) { buildSkeleton(); body = page.querySelector('.hrms-rbac-body'); }
    if (body) body.innerHTML = bodyHtml;
    var tabs = page.querySelectorAll('.hrms-rbac-tab');
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute('data-tab') === state.tab && !state.sub;
      if (active) tabs[i].classList.add('active'); else tabs[i].classList.remove('active');
    }
  }

  function loading() { shell('<div class="hrms-rbac-loading">Loading…</div>'); }

  /* ── router ──────────────────────────────────────────────────────────── */
  function render() {
    if (state.sub && state.sub.type === 'rolePerms') return renderRolePerms(state.sub.role);
    if (state.sub && state.sub.type === 'group') return renderGroupEditor(state.sub.group);
    if (state.tab === 'dashboard') return renderDashboard();
    if (state.tab === 'users') return renderUsers();
    if (state.tab === 'roles') return renderRoles();
    if (state.tab === 'groups') return renderGroups();
    if (state.tab === 'permissions') return renderPermissions();
  }

  /* ── dashboard ───────────────────────────────────────────────────────── */
  function renderDashboard() {
    loading();
    api('/rbac/stats').then(function (r) {
      var d = r.data || {};
      var cards = [
        ['Total Users', d.totalUsers, 'green'],
        ['Active Users', d.activeUsers, 'blue'],
        ['Total Roles', d.totalRoles, 'purple'],
        ['Permission Groups', d.permissionGroups, 'orange'],
        ['Permissions', d.permissions, 'blue'],
        ['Modules', d.modules, 'green'],
      ];
      shell('<div class="hrms-rbac-stats">' + cards.map(function (c) {
        return '<div class="hrms-rbac-stat b-' + c[2] + '">' +
          '<div class="hrms-rbac-statv">' + (c[1] == null ? '—' : c[1]) + '</div>' +
          '<div class="hrms-rbac-statl">' + c[0] + '</div></div>';
      }).join('') + '</div>' +
      '<div class="card" style="margin-top:16px"><div class="card-title">How it works</div>' +
      '<div style="font-size:12.5px;color:var(--text2);line-height:1.9">' +
      '• Create <b>Permission Groups</b> per module and add permissions under each.<br>' +
      '• Create a <b>Role</b> and grant it groups or individual permissions.<br>' +
      '• Assigning a group grants every permission in it; edit anytime.<br>' +
      '• Changing a group\'s permissions affects every role using it.</div></div>');
    });
  }

  /* ── users ───────────────────────────────────────────────────────────── */
  function renderUsers(showForm) {
    loading();
    Promise.all([api('/rbac/users'), api('/roles')]).then(function (res) {
      var roles = res[1].data || [];
      var allUsers = res[0].data || [];
      var rows = allUsers.map(function (u) {
        var roleOpts = roles.map(function (r) {
          return '<option value="' + r.id + '"' + ((u.roleId === r.id || u.role === r.name) ? ' selected' : '') + '>' + esc(r.name) + '</option>';
        }).join('');
        return '<tr data-search="' + esc((u.name + ' ' + u.email + ' ' + u.role).toLowerCase()) + '">' +
          '<td><div style="display:flex;align-items:center;gap:9px">' +
            '<span class="hrms-rbac-av">' + esc(u.initials || (u.name || '?').slice(0, 2).toUpperCase()) + '</span>' +
            '<div><div style="font-weight:600;font-size:12.5px">' + esc(u.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text3)">' + esc(u.email) + '</div></div></div></td>' +
          '<td><select class="hrms-rbac-inline-sel" data-act="change-role" data-id="' + u.id + '" data-name="' + esc(u.name) + '">' +
            '<option value="">— none —</option>' + roleOpts + '</select></td>' +
          '<td><span class="badge ' + (u.status === 'active' ? 'green' : 'gray') + '">' + esc(u.status) + '</span></td>' +
          '<td><div class="hrms-rbac-actions">' +
            '<button class="btn-sm" data-act="toggle-status" data-id="' + u.id + '" data-status="' + u.status + '" data-name="' + esc(u.name) + '">' + (u.status === 'active' ? 'Disable' : 'Enable') + '</button>' +
            '<button class="btn-sm hrms-rbac-del" data-act="del-user" data-id="' + u.id + '" data-name="' + esc(u.name) + '">Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
      shell(
        '<div class="hrms-rbac-bar"><div class="hrms-rbac-h2">Users <span class="badge blue" style="margin-left:6px">' + allUsers.length + '</span></div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<input class="input-field hrms-rbac-search" id="rbac-search-users" placeholder="Search users..." style="width:200px;font-size:12px">' +
            '<button class="btn-primary" data-act="new-user">+ Create User</button>' +
          '</div></div>' +
        (showForm ? userForm(roles) : '') +
        '<div id="rbac-confirm-panel"></div>' +
        '<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="4" class="hrms-rbac-empty">No users yet.</td></tr>') + '</tbody></table></div>');
      // Wire search
      var si = document.getElementById('rbac-search-users');
      if (si) si.addEventListener('input', function () {
        var q = si.value.trim().toLowerCase();
        var tbody = si.closest('.hrms-rbac-body').querySelector('tbody');
        if (!tbody) return;
        var trs = tbody.querySelectorAll('tr[data-search]');
        for (var i = 0; i < trs.length; i++) {
          trs[i].style.display = (!q || trs[i].getAttribute('data-search').indexOf(q) !== -1) ? '' : 'none';
        }
      });
    });
  }
  function userForm(roles) {
    return '<div class="card hrms-rbac-form"><div class="card-title">Create User</div>' +
      '<div class="hrms-rbac-grid">' +
        '<div><div class="hrms-rbac-lbl">FULL NAME</div><input class="input-field" id="rbac-u-name" placeholder="Jane Doe"></div>' +
        '<div><div class="hrms-rbac-lbl">EMAIL</div><input class="input-field" id="rbac-u-email" type="email" placeholder="jane@company.com"></div>' +
      '</div>' +
      '<div class="hrms-rbac-grid" style="margin-top:10px">' +
        '<div><div class="hrms-rbac-lbl">PASSWORD</div><input class="input-field" id="rbac-u-pass" type="text" placeholder="Min 6 characters"></div>' +
        '<div><div class="hrms-rbac-lbl">ROLE</div><select class="input-field" id="rbac-u-role">' +
          '<option value="">— select role —</option>' +
          roles.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="hrms-rbac-formbtns"><button class="btn-primary" data-act="save-user">Create User</button>' +
        '<button class="btn-sm" data-act="cancel-user">Cancel</button></div></div>';
  }

  /* ── roles ───────────────────────────────────────────────────────────── */
  function renderRoles(showForm) {
    loading();
    api('/roles').then(function (r) {
      var allRoles = r.data || [];
      var rows = allRoles.map(function (x) {
        // Build compact permission preview (up to 3 groups)
        var permPreview = (x.permissionCount || 0) > 0
          ? '<span class="badge blue">' + (x.permissionCount || 0) + ' perms</span>'
          : '<span style="color:var(--text3);font-size:11px">No permissions</span>';
        return '<tr data-search="' + esc((x.name + ' ' + (x.description || '')).toLowerCase()) + '">' +
          '<td><div style="font-weight:600;font-size:12.5px">' + esc(x.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text3)">' + esc(x.description || '—') + '</div></td>' +
          '<td>' + permPreview + '</td>' +
          '<td style="font-size:12px">' + (x.userCount || 0) + '</td>' +
          '<td><span class="badge ' + (x.isActive ? 'green' : 'gray') + '">' + esc(x.status) + '</span></td>' +
          '<td><div class="hrms-rbac-actions">' +
            '<button class="btn-sm" data-act="role-perms" data-id="' + x.id + '" data-name="' + esc(x.name) + '">Permissions</button>' +
            '<button class="btn-sm" data-act="edit-role" data-id="' + x.id + '" data-name="' + esc(x.name) + '" data-desc="' + esc(x.description || '') + '" data-active="' + (x.isActive ? 1 : 0) + '">Edit</button>' +
            '<button class="btn-sm hrms-rbac-del" data-act="del-role" data-id="' + x.id + '" data-name="' + esc(x.name) + '">Delete</button>' +
          '</div></td></tr>';
      }).join('');
      shell(
        '<div class="hrms-rbac-bar"><div class="hrms-rbac-h2">Roles <span class="badge blue" style="margin-left:6px">' + allRoles.length + '</span></div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<input class="input-field hrms-rbac-search" id="rbac-search-roles" placeholder="Search roles..." style="width:200px;font-size:12px">' +
            '<button class="btn-primary" data-act="new-role">+ Create Role</button>' +
          '</div></div>' +
        (showForm ? roleForm(showForm) : '') +
        '<div id="rbac-confirm-panel"></div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Role</th><th>Permissions</th><th>Users</th><th>Status</th><th>Actions</th>' +
          '</tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="hrms-rbac-empty">No roles yet.</td></tr>') + '</tbody></table></div>');
      // Wire search
      var si = document.getElementById('rbac-search-roles');
      if (si) si.addEventListener('input', function () {
        var q = si.value.trim().toLowerCase();
        var tbody = si.closest('.hrms-rbac-body').querySelector('tbody');
        if (!tbody) return;
        var trs = tbody.querySelectorAll('tr[data-search]');
        for (var i = 0; i < trs.length; i++) {
          trs[i].style.display = (!q || trs[i].getAttribute('data-search').indexOf(q) !== -1) ? '' : 'none';
        }
      });
    });
  }
  function roleForm(f) {
    f = f || {};
    return '<div class="card hrms-rbac-form"><div class="card-title">' + (f.id ? 'Edit Role' : 'Create Role') + '</div>' +
      '<input type="hidden" id="rbac-role-id" value="' + (f.id || '') + '">' +
      '<div class="hrms-rbac-grid">' +
        '<div><div class="hrms-rbac-lbl">ROLE NAME</div><input class="input-field" id="rbac-role-name" placeholder="e.g. HR Executive" value="' + esc(f.name || '') + '"></div>' +
        '<div><div class="hrms-rbac-lbl">STATUS</div><select class="input-field" id="rbac-role-active">' +
          '<option value="1"' + (f.active === 0 ? '' : ' selected') + '>Active</option>' +
          '<option value="0"' + (f.active === 0 ? ' selected' : '') + '>Inactive</option></select></div>' +
      '</div>' +
      '<div style="margin-top:10px"><div class="hrms-rbac-lbl">DESCRIPTION</div>' +
        '<input class="input-field" id="rbac-role-desc" placeholder="What this role can do" value="' + esc(f.desc || '') + '"></div>' +
      '<div class="hrms-rbac-formbtns"><button class="btn-primary" data-act="save-role">Save Role</button>' +
        '<button class="btn-sm" data-act="cancel-role">Cancel</button></div></div>';
  }

  /* ── role → permissions (assign groups + individual perms) ───────────── */
  function renderRolePerms(role) {
    loading();
    Promise.all([api('/permissions'), api('/roles/' + role.id + '/permissions')]).then(function (res) {
      var all = res[0].data || [];
      var granted = {};
      ((res[1].data && res[1].data.groups) || []).forEach(function (g) {
        (g.permissions || []).forEach(function (p) { granted[p.id] = true; });
      });
      // group permissions by group name (+ module)
      var groups = {}, order = [];
      all.forEach(function (p) {
        var key = p.groupId || 0;
        if (!groups[key]) { groups[key] = { name: p.group || 'Ungrouped', module: p.module || '', perms: [] }; order.push(key); }
        groups[key].perms.push(p);
      });
      var body = order.map(function (k) {
        var g = groups[k];
        var checkedAll = g.perms.every(function (p) { return granted[p.id]; });
        return '<div class="card hrms-rbac-gcard">' +
          '<label class="hrms-rbac-ghead"><input type="checkbox" class="rbac-grpall" data-group="' + k + '"' + (checkedAll ? ' checked' : '') + '>' +
            '<span class="hrms-rbac-gname">' + esc(g.name) + '</span>' +
            (g.module ? '<span class="badge blue">' + esc(g.module) + '</span>' : '') + '</label>' +
          '<div class="hrms-rbac-perms">' + g.perms.map(function (p) {
            return '<label class="hrms-rbac-perm"><input type="checkbox" class="rbac-perm" data-group="' + k + '" value="' + p.id + '"' + (granted[p.id] ? ' checked' : '') + '>' +
              '<span>' + esc(p.name) + '</span><code>' + esc(p.code) + '</code></label>';
          }).join('') + '</div></div>';
      }).join('');
      shell(
        '<div class="hrms-rbac-bar"><div><button class="btn-sm" data-act="back">&lsaquo; Back</button>' +
          '<span class="hrms-rbac-h2" style="margin-left:10px">Permissions — ' + esc(role.name) + '</span></div>' +
          '<div><span class="hrms-rbac-count" id="rbac-selcount"></span>' +
          '<button class="btn-primary" data-act="save-role-perms" data-id="' + role.id + '">Save Permissions</button></div></div>' +
        (body || '<div class="hrms-rbac-empty">No permissions defined yet. Create some under Permission Groups.</div>'));
      updateSelCount();
    });
  }
  function updateSelCount() {
    var checked = document.querySelectorAll('#' + OVERLAY_ID + ' .rbac-perm:checked');
    var n = checked.length;
    var el = document.getElementById('rbac-selcount');
    if (el) el.textContent = n + ' selected  ';
    // Sync each group’s “check all” checkbox to reflect its children
    var grpBoxes = document.querySelectorAll('#' + OVERLAY_ID + ' .rbac-grpall');
    for (var i = 0; i < grpBoxes.length; i++) {
      var g = grpBoxes[i].getAttribute('data-group');
      var perms = document.querySelectorAll('#' + OVERLAY_ID + ' .rbac-perm[data-group="' + g + '"]');
      if (!perms.length) continue;
      var allChecked = true;
      for (var j = 0; j < perms.length; j++) { if (!perms[j].checked) { allChecked = false; break; } }
      grpBoxes[i].checked = allChecked;
    }
  }

  /* ── permission groups ───────────────────────────────────────────────── */
  /* `form` is falsy (no form), {} (create) or a populated group (edit). */
  function renderGroups(form) {
    loading();
    Promise.all([api('/permission-groups'), api('/modules')]).then(function (res) {
      var mods = res[1].data || [];
      var rows = (res[0].data || []).map(function (g) {
        var attrs =
          ' data-id="' + g.id + '"' +
          ' data-name="' + esc(g.name) + '"' +
          ' data-desc="' + esc(g.description || '') + '"' +
          ' data-module="' + (g.moduleId || '') + '"' +
          ' data-active="' + (g.isActive ? 1 : 0) + '"';
        return '<tr>' +
          '<td><div style="font-weight:600;font-size:12.5px">' + esc(g.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text3)">' + esc(g.description || '—') + '</div></td>' +
          '<td>' + (g.module ? '<span class="badge blue">' + esc(g.module) + '</span>' : '<span style="color:var(--text3)">—</span>') + '</td>' +
          '<td><span class="badge purple">' + (g.permissionCount || 0) + '</span></td>' +
          '<td>' + statusBadge(g.isActive) + '</td>' +
          '<td><div class="hrms-rbac-actions">' +
            '<button class="btn-sm" data-act="manage-group"' + attrs + '>Manage</button>' +
            '<button class="btn-sm" data-act="edit-group"' + attrs + '>Edit</button>' +
            '<button class="btn-sm hrms-rbac-del" data-act="del-group"' + attrs + '>Delete</button>' +
          '</div></td></tr>';
      }).join('');
      shell(
        '<div class="hrms-rbac-bar"><div class="hrms-rbac-h2">Permission Groups</div>' +
          '<button class="btn-primary" data-act="new-group">+ Create Group</button></div>' +
        (form ? groupForm(mods, form) : '') +
        '<div class="table-wrap"><table><thead><tr><th>Group</th><th>Module</th><th>Permissions</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="5" class="hrms-rbac-empty">No groups yet.</td></tr>') + '</tbody></table></div>');
    });
  }
  function groupForm(mods, f) {
    f = f || {};
    var editing = !!f.id;
    return '<div class="card hrms-rbac-form">' +
      '<div class="card-title">' + (editing ? 'Edit Permission Group' : 'Create Permission Group') + '</div>' +
      '<input type="hidden" id="rbac-grp-id" value="' + (f.id || '') + '">' +
      '<div class="hrms-rbac-grid">' +
        '<div><div class="hrms-rbac-lbl">GROUP NAME</div>' +
          '<input class="input-field" id="rbac-grp-name" placeholder="e.g. Employee Group" value="' + esc(f.name || '') + '"></div>' +
        '<div><div class="hrms-rbac-lbl">MODULE</div><select class="input-field" id="rbac-grp-module">' +
          '<option value="">— none —</option>' +
          mods.map(function (m) {
            return '<option value="' + m.id + '"' + (+f.moduleId === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="hrms-rbac-grid" style="margin-top:10px">' +
        '<div><div class="hrms-rbac-lbl">DESCRIPTION</div>' +
          '<input class="input-field" id="rbac-grp-desc" placeholder="Optional" value="' + esc(f.description || '') + '"></div>' +
        '<div><div class="hrms-rbac-lbl">STATUS</div><select class="input-field" id="rbac-grp-active">' +
          '<option value="1"' + (f.isActive === false ? '' : ' selected') + '>Active</option>' +
          '<option value="0"' + (f.isActive === false ? ' selected' : '') + '>Inactive</option>' +
        '</select></div>' +
      '</div>' +
      '<div class="hrms-rbac-formbtns"><button class="btn-primary" data-act="save-group">' +
        (editing ? 'Save Changes' : 'Save Group') + '</button>' +
        '<button class="btn-sm" data-act="cancel-group-form">Cancel</button></div></div>';
  }

  /* ── group editor (permissions inside a group) ───────────────────────── */
  function renderGroupEditor(group) {
    loading();
    Promise.all([
      api('/permission-groups/' + group.id),
      api('/permissions'),
      api('/permission-groups'),
    ]).then(function (res) {
      var g = res[0].data || {};
      var perms = g.permissions || [];
      var allPerms = res[1].data || [];
      var allGroups = res[2].data || [];

      // Permissions that live somewhere else (or nowhere) can be pulled in here.
      var attachable = allPerms.filter(function (p) { return +p.groupId !== +g.id; });

      var moveOpts = function (p) {
        return '<option value="">— move to… —</option>' +
          '<option value="0">— no group —</option>' +
          allGroups.filter(function (x) { return +x.id !== +g.id; })
            .map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; })
            .join('');
      };

      var rows = perms.map(function (p) {
        return '<tr><td style="font-size:12.5px;font-weight:500">' + esc(p.name) +
            (p.description ? '<div style="font-size:11px;color:var(--text3)">' + esc(p.description) + '</div>' : '') + '</td>' +
          '<td><code class="hrms-rbac-code">' + esc(p.code) + '</code></td>' +
          '<td>' + statusBadge(p.isActive) + '</td>' +
          '<td><select class="hrms-rbac-inline-sel" data-kact="move-perm" data-id="' + p.id + '">' + moveOpts(p) + '</select></td>' +
          '<td><div class="hrms-rbac-actions">' +
            '<button class="btn-sm" data-act="edit-perm"' + permAttrs(p) + '>Edit</button>' +
            '<button class="btn-sm hrms-rbac-del" data-act="del-perm-row" data-id="' + p.id + '" data-name="' + esc(p.name) + '">Delete</button>' +
          '</div></td></tr>';
      }).join('');

      shell(
        '<div class="hrms-rbac-bar"><div><button class="btn-sm" data-act="back-groups">&lsaquo; Back</button>' +
          '<span class="hrms-rbac-h2" style="margin-left:10px">' + esc(g.name) + '</span>' +
          (g.module ? ' <span class="badge blue">' + esc(g.module) + '</span>' : '') +
          ' ' + statusBadge(g.isActive) + '</div>' +
          '<button class="btn-sm" data-act="edit-group"' +
            ' data-id="' + g.id + '" data-name="' + esc(g.name) + '"' +
            ' data-desc="' + esc(g.description || '') + '"' +
            ' data-module="' + (g.moduleId || '') + '"' +
            ' data-active="' + (g.isActive ? 1 : 0) + '">Rename / Edit Group</button></div>' +

        '<div class="card hrms-rbac-form"><div class="card-title">Create Permission in this Group</div>' +
          '<div class="hrms-rbac-grid3">' +
            '<div><div class="hrms-rbac-lbl">NAME</div><input class="input-field" id="rbac-p-name" placeholder="e.g. Create Employee"></div>' +
            '<div><div class="hrms-rbac-lbl">CODE</div>' + codeSelect('rbac-p-code-sel', 'rbac-p-code', 'rbac-p-name') + '</div>' +
            '<div><div class="hrms-rbac-lbl">DESCRIPTION</div><input class="input-field" id="rbac-p-desc" placeholder="Optional"></div>' +
          '</div>' +
          '<div class="hrms-rbac-formbtns"><button class="btn-primary" data-act="add-perm" data-id="' + g.id + '">Add Permission</button></div></div>' +

        '<div class="card hrms-rbac-form"><div class="card-title">Attach an Existing Permission</div>' +
          '<div class="hrms-rbac-lbl">Moves a permission out of its current group and into this one.</div>' +
          '<div class="hrms-rbac-grid" style="margin-top:8px">' +
            '<select class="input-field" id="rbac-attach-perm">' +
              '<option value="">— select a permission —</option>' +
              attachable.map(function (p) {
                return '<option value="' + p.id + '">' + esc(p.code) + ' — ' + esc(p.name) +
                  (p.group ? ' (in ' + esc(p.group) + ')' : ' (ungrouped)') + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn-primary" data-act="attach-perm" data-id="' + g.id + '">Attach</button>' +
          '</div></div>' +

        '<div class="table-wrap"><table><thead><tr><th>Permission</th><th>Code</th><th>Status</th><th>Move</th><th>Actions</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="5" class="hrms-rbac-empty">No permissions in this group yet.</td></tr>') + '</tbody></table></div>');
    });
  }

  /* ── all permissions ─────────────────────────────────────────────────── */
  /* `form` is falsy / {} (create) / a populated permission (edit). Inactive
     permissions are included here so they can be reactivated or cleaned up —
     the plain list hides them, which otherwise makes them unrecoverable. */
  function renderPermissions(form) {
    loading();
    Promise.all([
      api('/permissions?includeInactive=1'),
      api('/permission-groups'),
    ]).then(function (res) {
      var all = res[0].data || [];
      var groups = res[1].data || [];

      var q = (state.permQuery || '').toLowerCase();
      var gf = state.permGroup || '';
      var list = all.filter(function (p) {
        if (gf === '__none__' && p.groupId) return false;
        if (gf && gf !== '__none__' && String(p.groupId) !== String(gf)) return false;
        if (!q) return true;
        return (p.name + ' ' + p.code + ' ' + (p.group || '') + ' ' + (p.description || ''))
          .toLowerCase().indexOf(q) !== -1;
      });

      var rows = list.map(function (p) {
        return '<tr><td style="font-size:12.5px;font-weight:500">' + esc(p.name) +
            (p.description ? '<div style="font-size:11px;color:var(--text3)">' + esc(p.description) + '</div>' : '') + '</td>' +
          '<td><code class="hrms-rbac-code">' + esc(p.code) + '</code></td>' +
          '<td>' + (p.group ? '<span class="badge purple">' + esc(p.group) + '</span>' : '<span style="color:var(--text3)">— ungrouped —</span>') + '</td>' +
          '<td style="font-size:11px;color:var(--text3)">' + esc(p.module || '—') + '</td>' +
          '<td>' + statusBadge(p.isActive) + '</td>' +
          '<td><div class="hrms-rbac-actions">' +
            '<button class="btn-sm" data-act="edit-perm"' + permAttrs(p) + '>Edit</button>' +
            '<button class="btn-sm" data-act="toggle-perm" data-id="' + p.id + '" data-active="' + (p.isActive ? 1 : 0) + '">' +
              (p.isActive ? 'Disable' : 'Enable') + '</button>' +
            '<button class="btn-sm hrms-rbac-del" data-act="del-perm-row" data-id="' + p.id + '" data-name="' + esc(p.name) + '">Delete</button>' +
          '</div></td></tr>';
      }).join('');

      shell(
        '<div class="hrms-rbac-bar"><div class="hrms-rbac-h2">Permissions</div>' +
          '<button class="btn-primary" data-act="new-perm">+ Create Permission</button></div>' +

        '<div class="hrms-rbac-bar">' +
          '<input class="input-field hrms-rbac-search" id="rbac-perm-q" placeholder="Search name, code, group…" ' +
            'value="' + esc(state.permQuery || '') + '" style="max-width:280px">' +
          '<select class="hrms-rbac-inline-sel" id="rbac-perm-gf" data-kact="perm-filter">' +
            '<option value="">All groups</option>' +
            '<option value="__none__"' + (gf === '__none__' ? ' selected' : '') + '>— ungrouped —</option>' +
            groups.map(function (g) {
              return '<option value="' + g.id + '"' + (String(gf) === String(g.id) ? ' selected' : '') + '>' + esc(g.name) + '</option>';
            }).join('') +
          '</select>' +
          '<span class="hrms-rbac-count">' + list.length + ' of ' + all.length + '</span>' +
        '</div>' +

        (form ? permForm(groups, form) : '') +
        '<div class="table-wrap"><table><thead><tr><th>Permission</th><th>Code</th><th>Group</th><th>Module</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="6" class="hrms-rbac-empty">No permissions match.</td></tr>') + '</tbody></table></div>');

      var qEl = document.getElementById('rbac-perm-q');
      if (qEl) {
        qEl.oninput = function () {
          state.permQuery = qEl.value;
          clearTimeout(qEl._t);
          qEl._t = setTimeout(function () {
            renderPermissions(form);
            var again = document.getElementById('rbac-perm-q');
            if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
          }, 220);
        };
      }
    });
  }
  function permForm(groups, f) {
    f = f || {};
    var editing = !!f.id;
    return '<div class="card hrms-rbac-form">' +
      '<div class="card-title">' + (editing ? 'Edit Permission' : 'Create Permission') + '</div>' +
      '<input type="hidden" id="rbac-np-id" value="' + (f.id || '') + '">' +
      '<div class="hrms-rbac-grid3">' +
        '<div><div class="hrms-rbac-lbl">NAME</div>' +
          '<input class="input-field" id="rbac-np-name" placeholder="View Employee" value="' + esc(f.name || '') + '"></div>' +
        '<div><div class="hrms-rbac-lbl">CODE</div>' +
          codeSelect('rbac-np-code-sel', 'rbac-np-code', 'rbac-np-name', f.code) + '</div>' +
        '<div><div class="hrms-rbac-lbl">GROUP</div><select class="input-field" id="rbac-np-group">' +
          '<option value="">— none —</option>' +
          groups.map(function (g) {
            return '<option value="' + g.id + '"' + (+f.groupId === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="hrms-rbac-grid" style="margin-top:10px">' +
        '<div><div class="hrms-rbac-lbl">DESCRIPTION</div>' +
          '<input class="input-field" id="rbac-np-desc" placeholder="Optional — what this permission allows" value="' + esc(f.description || '') + '"></div>' +
        '<div><div class="hrms-rbac-lbl">STATUS</div><select class="input-field" id="rbac-np-active">' +
          '<option value="1"' + (f.isActive === false ? '' : ' selected') + '>Active</option>' +
          '<option value="0"' + (f.isActive === false ? ' selected' : '') + '>Inactive</option>' +
        '</select></div>' +
      '</div>' +
      (editing
        ? '<div class="hrms-rbac-lbl" style="margin-top:10px">Renaming the CODE only takes effect if the server checks that new code.</div>'
        : '') +
      '<div class="hrms-rbac-formbtns"><button class="btn-primary" data-act="save-perm">' +
        (editing ? 'Save Changes' : 'Save Permission') + '</button>' +
        '<button class="btn-sm" data-act="cancel-perm">Cancel</button></div></div>';
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  function wire() {
    var o = document.getElementById(PAGE_ID);
    if (!o) return;
    o.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      var id = b.getAttribute('data-id');
      handle(act, id, b, e);
    };
    /* property assignment (not addEventListener) so it replaces, not stacks,
       across re-renders; `change` bubbles from the checkboxes to the page */
    o.onchange = function (e) {
      var kact = e.target.getAttribute ? e.target.getAttribute('data-kact') : null;
      if (kact === 'move-perm') {
        var to = e.target.value;
        if (to === '') return;                       // placeholder — nothing chosen
        return movePerm(e.target.getAttribute('data-id'), to === '0' ? null : +to);
      }
      if (kact === 'perm-filter') {
        state.permGroup = e.target.value;
        return renderPermissions();
      }
      if (e.target.classList && e.target.classList.contains('rbac-grpall')) {
        var g = e.target.getAttribute('data-group');
        o.querySelectorAll('.rbac-perm[data-group="' + g + '"]').forEach(function (c) { c.checked = e.target.checked; });
        updateSelCount();
      } else if (e.target.classList && e.target.classList.contains('rbac-perm')) {
        updateSelCount();
      } else if (e.target.classList && e.target.classList.contains('rbac-codesel')) {
        // Code dropdown: reveal the custom box for "Custom code…", else auto-fill
        // the NAME field from the picked code's label (only if NAME is empty).
        var sel = e.target;
        var custom = document.getElementById(sel.getAttribute('data-custom'));
        var isCustom = sel.value === '__custom__';
        if (custom) { custom.style.display = isCustom ? '' : 'none'; if (isCustom) custom.focus(); }
        if (!isCustom && sel.value) {
          var nameEl = document.getElementById(sel.getAttribute('data-name'));
          var picked = sel.options[sel.selectedIndex];
          var suggested = picked ? picked.getAttribute('data-name') : '';
          if (nameEl && !nameEl.value.trim() && suggested) nameEl.value = suggested;
        }
      }
    };
  }

  function handle(act, id, b, e) {
    switch (act) {
      case 'close': return close();
      case 'tab': state.tab = b.getAttribute('data-tab'); state.sub = null; return render();
      case 'back': state.sub = null; state.tab = 'roles'; return render();
      case 'back-groups': state.sub = null; state.tab = 'groups'; return render();

      /* users */
      case 'new-user': return renderUsers(true);
      case 'cancel-user': return renderUsers();
      case 'save-user': return saveUser();
      case 'del-user': return confirmAction('Delete user "' + b.getAttribute('data-name') + '"? Their login is removed.', function () {
        api('/rbac/users/' + id, { method: 'DELETE' }).then(function (r) {
          if (!r.ok) { toast('Could not delete'); return; }
          toast('User deleted'); renderUsers();
        });
      });
      case 'change-role': return changeUserRole(id, b);
      case 'toggle-status': return toggleUserStatus(id, b);

      /* roles */
      case 'new-role': return renderRoles({});
      case 'cancel-role': return renderRoles();
      case 'edit-role': return renderRoles({ id: id, name: b.getAttribute('data-name'), desc: b.getAttribute('data-desc'), active: +b.getAttribute('data-active') });
      case 'save-role': return saveRole();
      case 'del-role': return confirmAction('Delete role "' + b.getAttribute('data-name') + '"? This removes its permission grants.', function () {
        api('/roles/' + id, { method: 'DELETE' }).then(function (r) {
          if (!r.ok) { toast('Could not delete'); return; }
          toast('Role deleted'); renderRoles();
        });
      });
      case 'role-perms': state.sub = { type: 'rolePerms', role: { id: id, name: b.getAttribute('data-name') } }; return render();
      case 'save-role-perms': return saveRolePerms(id);

      /* groups */
      case 'new-group': return renderGroups({});
      case 'cancel-group-form': return renderGroups();
      case 'save-group': return saveGroup();
      case 'edit-group': return renderGroups({
        id: id,
        name: b.getAttribute('data-name'),
        description: b.getAttribute('data-desc'),
        moduleId: b.getAttribute('data-module'),
        isActive: b.getAttribute('data-active') === '1',
      });
      case 'manage-group': state.sub = { type: 'group', group: { id: id, name: b.getAttribute('data-name') } }; return render();
      case 'del-group': return confirmAction(
        'Delete group "' + b.getAttribute('data-name') + '"? Its permissions are kept but become ungrouped.',
        function () {
          api('/permission-groups/' + id, { method: 'DELETE' }).then(function (r) {
            if (!r.ok) { toast('Could not delete'); return; }
            toast('Group deleted'); state.sub = null; state.tab = 'groups'; renderGroups();
          });
        });
      case 'add-perm': return addPermToGroup(id);
      case 'attach-perm': return attachPerm(id);

      /* permissions */
      case 'new-perm': return renderPermissions({});
      case 'cancel-perm': return renderPermissions();
      case 'save-perm': return savePerm();
      case 'edit-perm': return editPerm(b);
      case 'toggle-perm': return togglePerm(id, b.getAttribute('data-active') === '1');
      case 'del-perm-row': return confirmAction(
        'Delete permission "' + (b.getAttribute('data-name') || '') + '"? It is removed from every role that has it. ' +
        'To keep the grant history, Disable it instead.',
        function () {
          api('/permissions/' + id, { method: 'DELETE' }).then(function (r) {
            if (!r.ok) { toast('Could not delete'); return; }
            toast('Permission deleted'); render();
          });
        });
      case 'confirm-yes': if (window.__rbacConfirmCb) { window.__rbacConfirmCb(); window.__rbacConfirmCb = null; } dismissConfirm(); return;
      case 'confirm-no': window.__rbacConfirmCb = null; dismissConfirm(); return;
    }
  }

  function saveUser() {
    var name = val('rbac-u-name'), email = val('rbac-u-email'), pass = val('rbac-u-pass'), role = val('rbac-u-role');
    if (!name || !email || !pass) { toast('Name, email and password are required'); return; }
    if (pass.length < 6) { toast('Password must be at least 6 characters'); return; }
    if (!role) { toast('Please select a role'); return; }
    api('/rbac/users', { method: 'POST', body: { name: name, email: email, password: pass, roleId: +role } }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not create user'); return; }
      toast('User created — ' + esc(name)); renderUsers();
    });
  }
  function saveRole() {
    var name = val('rbac-role-name');
    if (!name) { toast('Role name is required'); return; }
    var id = val('rbac-role-id');
    var body = { name: name, description: val('rbac-role-desc'), is_active: val('rbac-role-active') === '1' };
    try { var s = JSON.parse(localStorage.getItem('hrms_session') || '{}'); if (s.email) body.actorEmail = s.email; } catch (_) {}
    api(id ? '/roles/' + id : '/roles', { method: id ? 'PUT' : 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not save role'); return; }
      toast('Role saved'); renderRoles();
    });
  }
  function saveRolePerms(id) {
    var ids = [];
    document.querySelectorAll('#' + PAGE_ID + ' .rbac-perm:checked').forEach(function (c) { ids.push(+c.value); });
    api('/roles/' + id + '/permissions', { method: 'POST', body: { permissionIds: ids } }).then(function (r) {
      if (!r.ok) { toast('Could not save permissions'); return; }
      var saved = r.data && r.data.total != null ? r.data.total : ids.length;
      toast('Permissions updated (' + saved + ')');
      // Re-render the permission panel so the count in the header reflects the new total
      if (state.sub && state.sub.type === 'rolePerms') {
        renderRolePerms(state.sub.role);
      }
    });
  }
  function saveGroup() {
    var name = val('rbac-grp-name');
    if (!name) { toast('Group name is required'); return; }
    var id = val('rbac-grp-id');
    var body = {
      name: name,
      description: val('rbac-grp-desc'),
      // null (not omitted) so clearing the module actually detaches it.
      moduleId: val('rbac-grp-module') ? +val('rbac-grp-module') : null,
      is_active: val('rbac-grp-active') !== '0',
    };
    api(id ? '/permission-groups/' + id : '/permission-groups',
        { method: id ? 'PUT' : 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not save group'); return; }
      toast(id ? 'Group updated' : 'Group created');
      renderGroups();
    });
  }
  function addPermToGroup(gid) {
    var name = val('rbac-p-name'), code = readCode('rbac-p-code-sel', 'rbac-p-code');
    if (!name || !code) { toast('Name and code are required'); return; }
    var body = { name: name, code: code, description: val('rbac-p-desc') };
    api('/permission-groups/' + gid + '/permissions', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not add permission'); return; }
      toast('Permission added'); render();
    });
  }
  function attachPerm(gid) {
    var pid = val('rbac-attach-perm');
    if (!pid) { toast('Pick a permission to attach'); return; }
    api('/permission-groups/' + gid + '/permissions', { method: 'POST', body: { permissionId: +pid } })
      .then(function (r) {
        if (!r.ok) { toast((r.data && r.data.message) || 'Could not attach permission'); return; }
        toast('Permission attached'); render();
      });
  }
  function movePerm(pid, groupId) {
    api('/permissions/' + pid, { method: 'PUT', body: { groupId: groupId } }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not move permission'); return; }
      toast(groupId ? 'Permission moved' : 'Permission ungrouped');
      render();
    });
  }
  function togglePerm(pid, isActive) {
    api('/permissions/' + pid, { method: 'PUT', body: { is_active: !isActive } }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not update permission'); return; }
      toast(isActive ? 'Permission disabled' : 'Permission enabled');
      renderPermissions();
    });
  }
  /* Editing always happens on the Permissions tab, even when launched from the
     group editor, so there is one form to maintain rather than two. */
  function editPerm(b) {
    state.sub = null;
    state.tab = 'permissions';
    buildSkeleton();
    renderPermissions({
      id: b.getAttribute('data-id'),
      name: b.getAttribute('data-name'),
      code: b.getAttribute('data-code'),
      description: b.getAttribute('data-desc'),
      groupId: b.getAttribute('data-group'),
      isActive: b.getAttribute('data-active') === '1',
    });
  }
  function savePerm() {
    var name = val('rbac-np-name'), code = readCode('rbac-np-code-sel', 'rbac-np-code');
    if (!name || !code) { toast('Name and code are required'); return; }
    var id = val('rbac-np-id');
    var body = {
      name: name,
      code: code,
      description: val('rbac-np-desc'),
      groupId: val('rbac-np-group') ? +val('rbac-np-group') : null,
      is_active: val('rbac-np-active') !== '0',
    };
    api(id ? '/permissions/' + id : '/permissions',
        { method: id ? 'PUT' : 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not save permission'); return; }
      toast(id ? 'Permission updated' : 'Permission created');
      renderPermissions();
    });
  }
  function confirmAction(msg, cb) {
    window.__rbacConfirmCb = cb;
    var panel = document.getElementById('rbac-confirm-panel');
    if (!panel) {
      // Fallback to browser confirm if no panel container
      if (window.confirm(msg)) cb();
      return;
    }
    panel.innerHTML =
      '<div class="hrms-rbac-confirm">' +
        '<span class="hrms-rbac-confirm-icon">⚠️</span>' +
        '<span class="hrms-rbac-confirm-msg">' + esc(msg) + '</span>' +
        '<div class="hrms-rbac-confirm-btns">' +
          '<button class="btn-sm hrms-rbac-del" data-act="confirm-yes">Yes, delete</button>' +
          '<button class="btn-sm" data-act="confirm-no">Cancel</button>' +
        '</div>' +
      '</div>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function dismissConfirm() {
    var panel = document.getElementById('rbac-confirm-panel');
    if (panel) panel.innerHTML = '';
  }
  function changeUserRole(userId, selectEl) {
    var roleId = selectEl.value;
    if (!roleId) return;
    api('/rbac/users/' + userId, { method: 'PUT', body: { roleId: +roleId } }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.message) || 'Could not change role'); return; }
      toast('Role updated for ' + (selectEl.getAttribute('data-name') || 'user'));
    });
  }
  function toggleUserStatus(userId, btn) {
    var newStatus = btn.getAttribute('data-status') === 'active' ? 'disabled' : 'active';
    var name = btn.getAttribute('data-name') || 'user';
    confirmAction((newStatus === 'disabled' ? 'Disable' : 'Enable') + ' user "' + name + '"?', function () {
      api('/rbac/users/' + userId, { method: 'PUT', body: { status: newStatus } }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.message) || 'Could not update status'); return; }
        toast(name + ' is now ' + newStatus); renderUsers();
      });
    });
  }

  /* ── sidebar entry ───────────────────────────────────────────────────── */
  function ensureNav() {
    if (!isAdmin()) return;
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.getElementById(NAV_ID)) return;
    var footer = sidebar.querySelector('.sidebar-footer');
    var sec = document.createElement('div');
    sec.className = 'nav-section';
    sec.id = NAV_ID;
    sec.innerHTML = '<div class="nav-label">Administration</div>' +
      '<a class="nav-item" href="#" id="hrms-rbac-link"><span class="nav-icon">' + SHIELD + '</span>Access Control</a>';
    if (footer && footer.parentNode) footer.parentNode.insertBefore(sec, footer);
    else sidebar.appendChild(sec);
    sec.querySelector('#hrms-rbac-link').addEventListener('click', function (ev) {
      ev.preventDefault();
      openAt('dashboard');
    });
  }

  /* ── styles (page-level; reuses app classes for content) ────────────── */
  function injectStyle() {
    if (document.getElementById('hrms-rbac-style')) return;
    var css =
      /* Full-page container — sits inside .content, no overlay */
      '#' + PAGE_ID + '{display:flex;flex-direction:column;min-height:100%;background:var(--bg2,#141a24);animation:rbacFadeIn .18s ease;}' +
      /* Hide whatever else .content holds, including nodes React adds later. */
      '.' + ACTIVE_CLS + ' > *:not(#' + PAGE_ID + '){display:none!important;}' +
      '@keyframes rbacFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
      /* Top bar */
      '.hrms-rbac-topbar{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 28px 0;border-bottom:1px solid var(--border2);margin-bottom:0;}' +
      '.hrms-rbac-topbar-left{display:flex;flex-direction:column;gap:3px;}' +
      '.hrms-rbac-title{font-family:var(--font-d);font-size:18px;font-weight:800;display:flex;align-items:center;gap:8px;}' +
      '.hrms-rbac-sub{font-size:12px;color:var(--text3);margin-top:2px;margin-bottom:14px;}' +
      '.hrms-rbac-back-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;margin-top:4px;}' +
      '.hrms-rbac-back-btn:hover{background:var(--bg4,var(--bg3));border-color:var(--accent);color:var(--text);}' +
      /* Tab bar */
      '.hrms-rbac-tabs{display:flex;gap:4px;padding:0 28px;flex-wrap:wrap;border-bottom:1px solid var(--border2);}' +
      '.hrms-rbac-tab{padding:10px 16px;border-radius:9px 9px 0 0;cursor:pointer;font-size:13px;font-weight:600;color:var(--text3);background:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px;transition:all .12s;}' +
      '.hrms-rbac-tab.active{color:var(--text);background:var(--bg3);border-color:var(--border2);}' +
      '.hrms-rbac-tab:hover:not(.active){color:var(--text2);}' +
      /* Content body */
      '.hrms-rbac-body{padding:20px 28px 32px;flex:1;overflow:auto;}' +
      '.hrms-rbac-body .table-wrap{overflow:auto;}' +
      '.hrms-rbac-body .table-wrap thead th{position:sticky;top:0;background:var(--bg2);z-index:1;}' +
      '.hrms-rbac-loading,.hrms-rbac-empty{text-align:center;color:var(--text3);padding:48px 0;font-size:13px;}' +
      /* Content elements */
      '.hrms-rbac-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:10px;flex-wrap:wrap;}' +
      '.hrms-rbac-h2{font-family:var(--font-d);font-size:15px;font-weight:700;}' +
      '.hrms-rbac-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:4px;}' +
      '.hrms-rbac-stat{background:var(--bg3);border:1px solid var(--border2);border-left:3px solid var(--accent);border-radius:12px;padding:18px 20px;transition:transform .15s;}' +
      '.hrms-rbac-stat:hover{transform:translateY(-2px);}' +
      '.hrms-rbac-stat.b-green{border-left-color:var(--success);}.hrms-rbac-stat.b-orange{border-left-color:var(--warn);}.hrms-rbac-stat.b-purple{border-left-color:var(--accent2,#7c5cfc);}.hrms-rbac-stat.b-blue{border-left-color:var(--accent);}' +
      '.hrms-rbac-statv{font-family:var(--font-d);font-size:32px;font-weight:800;}' +
      '.hrms-rbac-statl{font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;}' +
      '.hrms-rbac-actions{display:flex;gap:6px;flex-wrap:wrap;}' +
      '.hrms-rbac-del{color:var(--danger)!important;}' +
      '.hrms-rbac-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent2,#7c5cfc),var(--accent));color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;}' +
      '.hrms-rbac-form{margin-bottom:14px;}' +
      '.hrms-rbac-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}' +
      '.hrms-rbac-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}' +
      '.hrms-rbac-lbl{font-size:11px;color:var(--text3);font-weight:600;margin-bottom:5px;}' +
      '.hrms-rbac-formbtns{display:flex;gap:8px;margin-top:14px;}' +
      /* Permission editor: compact, aligned group cards (works in both themes) */
      '.hrms-rbac-gcard{display:block;margin-bottom:10px;padding:0;overflow:hidden;}' +
      '.hrms-rbac-gcard input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;cursor:pointer;flex-shrink:0;margin:0;}' +
      '.hrms-rbac-ghead{display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:700;font-size:12.5px;padding:10px 14px;margin:0;background:var(--bg3);border-bottom:1px solid var(--border2);}' +
      '.hrms-rbac-gname{flex:1;min-width:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.hrms-rbac-ghead .badge{flex-shrink:0;}' +
      '.hrms-rbac-perms{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1px 8px;padding:7px 10px;align-content:start;}' +
      '.hrms-rbac-perm{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--text2);padding:6px 8px;border-radius:7px;cursor:pointer;min-width:0;}' +
      '.hrms-rbac-perm:hover{background:rgba(125,125,125,.12);}' +
      '.hrms-rbac-perm>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.hrms-rbac-perm code,.hrms-rbac-code{font-size:10.5px;color:var(--text3);background:var(--bg2);border:1px solid var(--border2);padding:1px 6px;border-radius:5px;flex-shrink:0;}' +
      '.hrms-rbac-count{font-size:12px;color:var(--text3);margin-right:8px;}' +
      '.hrms-rbac-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--text,#eef);color:var(--bg2,#111);font-size:12.5px;font-weight:600;padding:9px 18px;border-radius:10px;opacity:0;transition:opacity .25s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:999;}' +
      '.hrms-rbac-search{background:var(--bg3)!important;border:1px solid var(--border2)!important;border-radius:8px!important;padding:7px 12px!important;color:var(--text)!important;}' +
      '.hrms-rbac-search:focus{border-color:var(--accent)!important;outline:none!important;}' +
      '.hrms-rbac-inline-sel{background:var(--bg3);border:1px solid var(--border2);border-radius:7px;padding:4px 8px;font-size:11.5px;color:var(--text);cursor:pointer;min-width:120px;}' +
      '.hrms-rbac-inline-sel:focus{border-color:var(--accent);outline:none;}' +
      '.hrms-rbac-confirm{display:flex;align-items:center;gap:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px;padding:12px 16px;margin-bottom:12px;animation:rbacSlideIn .2s ease;}' +
      '.hrms-rbac-confirm-icon{font-size:18px;flex-shrink:0;}' +
      '.hrms-rbac-confirm-msg{font-size:12.5px;color:var(--text);flex:1;}' +
      '.hrms-rbac-confirm-btns{display:flex;gap:6px;flex-shrink:0;}' +
      '@keyframes rbacSlideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}' +
      '@media(max-width:900px){.hrms-rbac-stats{grid-template-columns:1fr 1fr;}.hrms-rbac-topbar{flex-direction:column;gap:10px;align-items:stretch;}}' +
      '@media(max-width:720px){.hrms-rbac-stats{grid-template-columns:1fr;}.hrms-rbac-grid,.hrms-rbac-grid3,.hrms-rbac-perms{grid-template-columns:1fr;}.hrms-rbac-bar{flex-direction:column;align-items:stretch;}.hrms-rbac-search{width:100%!important;}.hrms-rbac-confirm{flex-direction:column;align-items:stretch;}}';
    var st = document.createElement('style');
    st.id = 'hrms-rbac-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── settings card entry ─────────────────────────────────────────────── */
  function ensureSettingsCard() {
    if (!isAdmin()) return;
    if (window.location.pathname !== '/settings') return;
    // If the RBAC page is open, don't inject the card
    if (document.getElementById(PAGE_ID)) return;
    var container = document.querySelector('.content');
    if (!container) return;
    if (document.getElementById('hrms-rbac-settings-card')) return;

    var card = document.createElement('div');
    card.id = 'hrms-rbac-settings-card';
    card.className = 'card';
    card.style.cssText = 'margin-top:20px;border:1px solid var(--border2);border-radius:14px;padding:22px 24px;background:linear-gradient(135deg,var(--bg3) 0%,var(--bg2) 100%);';
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<span style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#7c5cfc,#5b8af0);display:inline-flex;align-items:center;justify-content:center;color:#fff">' + SHIELD + '</span>' +
        '<div>' +
          '<div class="card-title" style="margin:0">Access Control (RBAC)</div>' +
          '<div style="font-size:11.5px;color:var(--text3)">Role-Based Access Control management</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:12.5px;color:var(--text2);margin-bottom:16px;line-height:1.7">' +
        'Manage roles, permission groups, and assign user access dynamically across the entire system.' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn-primary" id="open-rbac-btn" style="display:inline-flex;align-items:center;gap:6px">' +
          SHIELD + ' Open Access Control' +
        '</button>' +
        '<button class="btn-sm" id="open-rbac-users-btn" style="display:inline-flex;align-items:center;gap:6px;font-size:12px">Manage Users</button>' +
        '<button class="btn-sm" id="open-rbac-roles-btn" style="display:inline-flex;align-items:center;gap:6px;font-size:12px">Manage Roles</button>' +
      '</div>';

    container.appendChild(card);
    card.querySelector('#open-rbac-btn').addEventListener('click', function (ev) {
      ev.preventDefault(); openAt('dashboard');
    });
    card.querySelector('#open-rbac-users-btn').addEventListener('click', function (ev) {
      ev.preventDefault(); openAt('users');
    });
    card.querySelector('#open-rbac-roles-btn').addEventListener('click', function (ev) {
      ev.preventDefault(); openAt('roles');
    });
  }

  /* ── boot ────────────────────────────────────────────────────────────── */
  /* Disconnect the observer while ensureNav mutates the sidebar and reconnect
     after, and debounce, so re-inserting the nav entry never re-fires the
     observer (that self-loop, amplified by React reverting the injected node,
     was the main cause of the sidebar shaking). */
  var _rbacObs = null, _rbacPending = false;
  function _rbacRun() {
    if (_rbacObs) _rbacObs.disconnect();
    try {
      syncRoute();          // drop stale RBAC DOM before re-injecting anything
      ensureNav();
      ensureSettingsCard();
    }
    finally { if (_rbacObs) _rbacObs.observe(document.body, { childList: true, subtree: true }); }
  }
  function _rbacSchedule() {
    if (_rbacPending) return;
    _rbacPending = true;
    setTimeout(function () { _rbacPending = false; _rbacRun(); }, 120);
  }
  function boot() {
    watchRoute();
    syncRoute();
    ensureNav();
    ensureSettingsCard();
    _rbacObs = new MutationObserver(_rbacSchedule);
    _rbacObs.observe(document.body, { childList: true, subtree: true });
    setInterval(_rbacRun, 5000);   // long safety net only, not a driver
  }
  window.__hrmsOpenRBAC = openAt;   // programmatic entry (parity with other helpers)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  console.log('[hrms-rbac] loaded');
})();
