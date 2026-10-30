/**
 * hrms-teams.js
 * ---------------------------------------------------------------------------
 * Team management and manager review on HR > HRIS (/hr/hris).
 *
 * Adds two cards under the React "Employee Records" table:
 *   • Teams — create a team, set its department and lead, add / remove
 *     members, archive or delete it. Expanding a team lists its members.
 *   • Manager review (HR only, shown when there is something to fix) —
 *     profiles whose manager is still a typed name that matched no one, or
 *     points at someone who left. Pick the person to link them.
 *
 *   GET/POST   /api/teams                 PUT/DELETE /api/teams/<id>
 *   POST       /api/teams/<id>/members    DELETE /api/teams/<id>/members/<email>
 *   GET        /api/org/people            GET /api/org/manager-review
 *   PATCH      /api/employees/<email>     { managerEmail }
 *
 * Editing controls show only when the role holds employee.edit; the server
 * enforces the same rule. No bundle rebuild.
 */
(function () {
  'use strict';
  if (window.__hrmsTeams) return;

  var PATH = '/hr/hris';
  var ROOT_ID = 'hrms-teams-root';
  var state = { teams: null, people: null, review: null, open: {}, creating: false, busy: false, error: '' };

  function onPage() { return (location.pathname || '').replace(/\/+$/, '') === PATH; }
  function canEdit() { return typeof window.__hrmsCan === 'function' ? window.__hrmsCan('employee.edit') : true; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(p, init) {
    init = init || {};
    init.headers = Object.assign({ Accept: 'application/json' }, init.body ? { 'Content-Type': 'application/json' } : {}, init.headers || {});
    return fetch(p, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) { var e = new Error((d && d.message) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function profileUrl(p) { return '/hr/hris/' + (/^\d+$/.test(p.key || '') ? p.key : encodeURIComponent(p.email)); }
  function personLink(p) { return p ? '<a class="ht-link" href="' + esc(profileUrl(p)) + '" data-nav="1">' + esc(p.name || p.email) + '</a>' : '<i class="ht-dash">—</i>'; }
  function peopleOptions(exclude, selected, blank) {
    var html = blank ? '<option value="">' + esc(blank) + '</option>' : '';
    (state.people || []).forEach(function (p) {
      if (exclude && exclude[p.email]) return;
      html += '<option value="' + esc(p.email) + '"' + (p.email === selected ? ' selected' : '') + '>' + esc(p.name + (p.designation ? ' · ' + p.designation : '')) + '</option>';
    });
    return html;
  }
  function toast(msg, bad) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:100001;padding:11px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);background:' + (bad ? '#991b1b' : '#065f46');
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, bad ? 5000 : 2800);
  }

  function ensureStyle() {
    if (document.getElementById('hrms-teams-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-teams-style';
    st.textContent = [
      '#' + ROOT_ID + '{display:flex;flex-direction:column;gap:16px;margin-top:16px;}',
      '#' + ROOT_ID + ' .ht-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;}',
      '#' + ROOT_ID + ' .ht-title{font-size:14px;font-weight:700;color:var(--text);}',
      '#' + ROOT_ID + ' .ht-sub{font-size:12px;color:var(--text3);}',
      '#' + ROOT_ID + ' table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '#' + ROOT_ID + ' th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);padding:9px 10px;border-bottom:1px solid var(--border2);}',
      '#' + ROOT_ID + ' td{padding:10px;border-bottom:1px solid var(--border2);color:var(--text);vertical-align:middle;}',
      '#' + ROOT_ID + ' tr.ht-row{cursor:pointer;}',
      '#' + ROOT_ID + ' tr.ht-row:hover td{background:var(--bg3);}',
      '#' + ROOT_ID + ' .ht-detail td{background:var(--bg3);}',
      '#' + ROOT_ID + ' .ht-members{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 12px;}',
      '#' + ROOT_ID + ' .ht-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 6px 5px 10px;border:1px solid var(--border2);border-radius:999px;background:var(--bg2);font-size:12px;}',
      '#' + ROOT_ID + ' .ht-chip button{border:none;background:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;padding:0 4px;}',
      '#' + ROOT_ID + ' .ht-chip button:hover{color:var(--danger,#dc2626);}',
      '#' + ROOT_ID + ' .ht-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '#' + ROOT_ID + ' select,#' + ROOT_ID + ' input{background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:7px;padding:6px 9px;font:inherit;font-size:12.5px;}',
      '#' + ROOT_ID + ' .ht-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:12px;padding:12px;border:1px dashed var(--border2);border-radius:10px;}',
      '#' + ROOT_ID + ' .ht-form label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--text2);font-weight:600;}',
      '#' + ROOT_ID + ' .ht-link{color:var(--accent);text-decoration:none;font-weight:600;}',
      '#' + ROOT_ID + ' .ht-dash{color:var(--text3);font-style:normal;}',
      '#' + ROOT_ID + ' .ht-empty{color:var(--text3);font-size:12.5px;text-align:center;padding:18px 8px;}',
      '#' + ROOT_ID + ' .ht-danger{color:var(--danger,#dc2626)!important;}',
      '#' + ROOT_ID + ' .ht-wrap{overflow-x:auto;}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ── data ───────────────────────────────────────────────────────────────── */
  function load() {
    state.error = '';
    var jobs = [
      api('/api/teams').then(function (r) { state.teams = Array.isArray(r) ? r : []; })
        .catch(function (e) { state.teams = []; state.error = e.message; })
    ];
    if (canEdit()) {
      jobs.push(api('/api/org/people').then(function (r) { state.people = Array.isArray(r) ? r : []; }).catch(function () { state.people = []; }));
      jobs.push(api('/api/org/manager-review').then(function (r) { state.review = Array.isArray(r) ? r : []; }).catch(function () { state.review = []; }));
      jobs.push(api('/api/org/unresolved').then(function (r) { state.unresolved = Array.isArray(r) ? r : []; }).catch(function () { state.unresolved = []; }));
    }
    render();
    return Promise.all(jobs).then(render);
  }
  function act(promise, okMsg) {
    state.busy = true;
    return promise.then(function () { if (okMsg) toast(okMsg); return load(); })
      .catch(function (e) { toast(e.message || 'Something went wrong', true); })
      .then(function () { state.busy = false; });
  }

  /* ── render ─────────────────────────────────────────────────────────────── */
  function teamsCard() {
    var edit = canEdit();
    var teams = state.teams;
    var html = '<div class="card"><div class="ht-head"><div><div class="ht-title">Teams</div>' +
      '<div class="ht-sub">Team leads guide work. Managers, set on each profile, handle reporting and approvals.</div></div>' +
      (edit ? '<button class="btn-primary" data-ht="new">' + (state.creating ? 'Cancel' : '+ New Team') + '</button>' : '') + '</div>';
    if (edit && state.creating) {
      html += '<div class="ht-form">' +
        '<label>Name<input data-ht-f="name" placeholder="e.g. Platform"></label>' +
        '<label>Department / function<input data-ht-f="department" placeholder="e.g. Engineering"></label>' +
        '<label>Team lead<select data-ht-f="leadEmail">' + peopleOptions(null, '', '— Choose later —') + '</select></label>' +
        '<label>&nbsp;<button class="btn-primary" data-ht="create">Create team</button></label></div>';
    }
    if (teams === null) return html + '<div class="ht-empty">Loading teams…</div></div>';
    if (state.error) return html + '<div class="ht-empty">' + esc(state.error) + '</div></div>';
    if (!teams.length) return html + '<div class="ht-empty">' + (edit ? 'No teams yet. Create the first one.' : 'You are not in any team yet.') + '</div></div>';
    html += '<div class="ht-wrap"><table><thead><tr><th>Team</th><th>Department</th><th>Lead</th><th>Members</th><th>Status</th></tr></thead><tbody>';
    teams.forEach(function (t) {
      var open = !!state.open[t.id];
      html += '<tr class="ht-row" data-ht="toggle" data-id="' + t.id + '"><td><b>' + (open ? '▾ ' : '▸ ') + esc(t.name) + '</b></td><td>' + esc(t.department || '—') + '</td><td>' + personLink(t.lead) +
        '</td><td>' + t.memberCount + '</td><td><span class="badge ' + (t.status === 'active' ? 'green' : '') + '">' + esc(t.status) + '</span></td></tr>';
      if (open) html += '<tr class="ht-detail"><td colspan="5">' + teamDetail(t, edit) + '</td></tr>';
    });
    return html + '</tbody></table></div></div>';
  }
  function teamDetail(t, edit) {
    var members = t.members || [], inTeam = {};
    members.forEach(function (m) { inTeam[m.email] = true; });
    var html = '<div class="ht-members">' + (members.length ? members.map(function (m) {
      var isLead = m.email === t.leadEmail;
      return '<span class="ht-chip">' + personLink(m) + (isLead ? ' <span class="badge blue">Lead</span>' : '') +
        (edit && !isLead ? '<button title="Remove from team" data-ht="remove" data-id="' + t.id + '" data-email="' + esc(m.email) + '">×</button>' : '') + '</span>';
    }).join('') : '<span class="ht-sub">No members yet.</span>') + '</div>';
    if (!edit) return html;
    return html + '<div class="ht-controls">' +
      '<select data-ht-add="' + t.id + '">' + peopleOptions(inTeam, '', '+ Add member…') + '</select>' +
      '<button class="btn-sm" data-ht="add" data-id="' + t.id + '">Add</button>' +
      '<select data-ht-lead="' + t.id + '">' + peopleOptions(null, t.leadEmail, '— No lead —') + '</select>' +
      '<button class="btn-sm" data-ht="lead" data-id="' + t.id + '">Set lead</button>' +
      '<button class="btn-sm" data-ht="archive" data-id="' + t.id + '" data-status="' + (t.status === 'active' ? 'archived' : 'active') + '">' + (t.status === 'active' ? 'Archive' : 'Reactivate') + '</button>' +
      '<button class="btn-sm ht-danger" data-ht="delete" data-id="' + t.id + '" data-name="' + esc(t.name) + '">Delete</button></div>';
  }
  function reviewCard() {
    var rows = state.review || [];
    if (!canEdit() || !rows.length) return '';
    var html = '<div class="card"><div class="ht-head"><div><div class="ht-title">Manager review <span class="badge orange">' + rows.length + '</span></div>' +
      '<div class="ht-sub">These managers are typed names that could not be matched to an employee. Pick the right person to link them.</div></div></div>' +
      '<div class="ht-wrap"><table><thead><tr><th>Employee</th><th>Recorded manager</th><th>Why</th><th>Link to</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var e = r.employee || {}, pick = (r.candidates && r.candidates.length === 1) ? r.candidates[0].email : '';
      var self = {}; self[e.email] = true;
      html += '<tr><td>' + personLink(e) + '</td><td>' + esc(r.managerText || r.managerEmail || '—') + '</td><td class="ht-sub">' + esc(r.reason) + '</td>' +
        '<td><div class="ht-controls"><select data-ht-mgr="' + esc(e.email) + '">' + peopleOptions(self, pick, '— No manager —') + '</select>' +
        '<button class="btn-sm" data-ht="link" data-email="' + esc(e.email) + '">Save</button></div></td></tr>';
    });
    return html + '</tbody></table></div></div>';
  }
  function unresolvedCard() {
    var rows = state.unresolved || [];
    if (!canEdit() || !rows.length) return '';
    return '<div class="card"><div class="ht-head"><div><div class="ht-title">Unlinked approvers &amp; reviewers <span class="badge orange">' + rows.length + '</span></div>' +
      '<div class="ht-sub">Older records whose approver, reviewer or team lead is only a typed name, or pending requests from people with no manager linked. Link managers on profiles and leads on teams; new requests then route automatically.</div></div></div>' +
      '<div class="ht-wrap"><table><thead><tr><th>Record</th><th>#</th><th>Employee</th><th>Recorded name</th><th>Status</th></tr></thead><tbody>' +
      rows.slice(0, 100).map(function (r) {
        return '<tr><td>' + esc(r.kind) + '</td><td>' + esc(r.id) + '</td><td>' + esc(r.employee || '—') + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.status || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' + (rows.length > 100 ? '<div class="ht-sub" style="margin-top:8px">Showing the first 100.</div>' : '') + '</div>';
  }
  function render() {
    var root = document.getElementById(ROOT_ID);
    if (root) root.innerHTML = teamsCard() + reviewCard() + unresolvedCard();
  }

  /* ── actions ────────────────────────────────────────────────────────────── */
  function onClick(e) {
    var nav = e.target.closest('a[data-nav]');
    if (nav) {
      e.preventDefault();
      history.pushState({}, '', nav.getAttribute('href'));
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    var el = e.target.closest('[data-ht]');
    if (!el || state.busy) return;
    var root = document.getElementById(ROOT_ID);
    var kind = el.getAttribute('data-ht'), id = el.getAttribute('data-id');
    if (kind === 'toggle') { state.open[id] = !state.open[id]; render(); return; }
    if (kind === 'new') { state.creating = !state.creating; render(); return; }
    if (kind === 'create') {
      var val = function (f) { var x = root.querySelector('[data-ht-f="' + f + '"]'); return x ? x.value.trim() : ''; };
      if (!val('name')) { toast('Give the team a name.', true); return; }
      act(api('/api/teams', { method: 'POST', body: JSON.stringify({ name: val('name'), department: val('department'), leadEmail: val('leadEmail') }) }), 'Team created')
        .then(function () { state.creating = false; render(); });
      return;
    }
    if (kind === 'add') {
      var sel = root.querySelector('[data-ht-add="' + id + '"]');
      if (!sel || !sel.value) { toast('Choose someone to add.', true); return; }
      act(api('/api/teams/' + id + '/members', { method: 'POST', body: JSON.stringify({ email: sel.value }) }), 'Member added');
      return;
    }
    if (kind === 'remove') {
      act(api('/api/teams/' + id + '/members/' + encodeURIComponent(el.getAttribute('data-email')), { method: 'DELETE' }), 'Member removed');
      return;
    }
    if (kind === 'lead') {
      var lead = root.querySelector('[data-ht-lead="' + id + '"]');
      act(api('/api/teams/' + id, { method: 'PUT', body: JSON.stringify({ leadEmail: lead ? lead.value : '' }) }), 'Team lead updated');
      return;
    }
    if (kind === 'archive') {
      act(api('/api/teams/' + id, { method: 'PUT', body: JSON.stringify({ status: el.getAttribute('data-status') }) }), 'Team updated');
      return;
    }
    if (kind === 'delete') {
      if (!window.confirm('Delete the team "' + el.getAttribute('data-name') + '"? Its tasks are kept but no longer filed under it.')) return;
      act(api('/api/teams/' + id, { method: 'DELETE' }), 'Team deleted');
      return;
    }
    if (kind === 'link') {
      var email = el.getAttribute('data-email');
      var m = root.querySelector('[data-ht-mgr="' + email + '"]');
      act(api('/api/employees/' + encodeURIComponent(email), { method: 'PATCH', body: JSON.stringify({ managerEmail: m ? m.value : '' }) }), 'Manager linked');
    }
  }

  /* ── mount ──────────────────────────────────────────────────────────────── */
  function ensure() {
    var root = document.getElementById(ROOT_ID);
    if (!onPage()) { if (root) root.remove(); state.teams = null; return; }
    var content = document.querySelector('.main > .content') || document.querySelector('.content');
    if (!content || !content.querySelector('table')) return;      // wait for the HRIS table
    ensureStyle();
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.addEventListener('click', onClick);
    }
    var host = content.firstElementChild && content.firstElementChild !== root ? content.firstElementChild : content;
    if (root.parentElement !== host || host.lastElementChild !== root) host.appendChild(root);
    if (state.teams === null && !state.loading) { state.loading = true; load().then(function () { state.loading = false; }); }
    else if (!root.childNodes.length) render();
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { queued = false; ensure(); });
  }
  new MutationObserver(function (muts) {
    var root = document.getElementById(ROOT_ID);
    for (var i = 0; i < muts.length; i++) { if (!(root && root.contains(muts[i].target))) { schedule(); return; } }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();

  window.__hrmsTeams = { reload: load };
})();
