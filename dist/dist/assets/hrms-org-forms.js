/**
 * hrms-org-forms.js
 * ---------------------------------------------------------------------------
 * Team-aware Task and Work Submission forms (the forms live in the React
 * bundle, so this sidecar extends them in place).
 *
 * Task create / edit modal
 *   • a Team dropdown above "Assigned To" (active teams);
 *   • the assignee search is narrowed to that team's members;
 *   • the Team Lead field is filled from the team and locked;
 *   • the chosen team id is added to the save request.
 * New Submission modal
 *   • the submitter is the signed-in user (the API enforces it);
 *   • a Team dropdown limited to the user's own active teams (preselected
 *     and read-only when there is only one);
 *   • the reviewer is shown read-only (the team lead); HR — holders of
 *     submission.view_all — get a dropdown of eligible reviewers instead.
 * Task Tracker / Work Submissions pages
 *   • a team filter for managers and admins.
 *
 * The bundle's save calls treat any failed response as success with no data,
 * so a refusal (e.g. "choose a team") would vanish silently. This file shows
 * the server's message instead. The API re-validates everything.
 */
(function () {
  'use strict';
  if (window.__hrmsOrgForms) return;

  var FILTER_KEY = { tasks: 'hrms_task_team_filter', submissions: 'hrms_sub_team_filter' };
  var state = { taskTeam: '', subTeam: '', subReviewer: '', teams: null, myTeams: null, taskIndex: null };
  var nativeFetch = window.fetch.bind(window);

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function me() { try { return String((JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}).email || '').toLowerCase(); } catch (_) { return ''; } }
  function can(code) { return typeof window.__hrmsCan === 'function' ? window.__hrmsCan(code) : false; }
  function getJson(url) { return nativeFetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }); }
  function path() { return (location.pathname || '').replace(/\/+$/, ''); }
  function toast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:100001;max-width:420px;padding:11px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;background:#991b1b;box-shadow:0 8px 24px rgba(0,0,0,.3)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }
  function filterValue(kind) { try { return sessionStorage.getItem(FILTER_KEY[kind]) || ''; } catch (_) { return ''; } }
  function setReactValue(input, value) {
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function loadTeams() {
    if (!state.teams) state.teams = getJson('/api/teams?status=active');
    return state.teams;
  }
  function loadMyTeams() {
    if (!state.myTeams) state.myTeams = getJson('/api/teams?status=active&email=' + encodeURIComponent(me()));
    return state.myTeams;
  }
  function withParam(url, key, value) {
    if (!value || new RegExp('[?&]' + key + '=').test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + key + '=' + encodeURIComponent(value);
  }

  /* ── request wiring ────────────────────────────────────────────────────── */
  function surfaceErrors(promise) {
    return promise.then(function (resp) {
      if (!resp.ok && resp.status >= 400 && resp.status < 500) {
        resp.clone().json().then(function (d) {
          if (d && d.message) toast(d.message);
        }).catch(function () {});
      }
      return resp;
    });
  }
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = String((init && init.method) || 'GET').toUpperCase();
      var rel = url.replace(location.origin, '');
      var isTaskSave = /^\/api\/tasks(\/\d+)?(\?|$)/.test(rel) && (method === 'POST' || method === 'PUT');
      var isSubSave = /^\/api\/submissions(\?|$)/.test(rel) && method === 'POST';
      if ((isTaskSave || isSubSave) && init && typeof init.body === 'string') {
        var body = JSON.parse(init.body || '{}');
        if (isTaskSave && state.taskTeam && body.teamId == null && (method === 'POST' || body.title !== undefined)) {
          body.teamId = state.taskTeam === 'none' ? '' : Number(state.taskTeam);
        }
        if (isSubSave) {
          if (state.subTeam && body.teamId == null) body.teamId = Number(state.subTeam);
          if (state.subReviewer && body.reviewerEmail == null) body.reviewerEmail = state.subReviewer;
          // The bundle's own Reviewer field is replaced by ours: send the
          // chosen person's name instead of its role placeholder.
          if (state.subReviewerName) body.reviewer = state.subReviewerName;
        }
        init = Object.assign({}, init, { body: JSON.stringify(body) });
        return surfaceErrors(nativeFetch(input, init));
      }
      if (method === 'GET' && typeof input === 'string') {
        if (/^\/api\/tasks\/assignees\?/.test(rel) && state.taskTeam && state.taskTeam !== 'none') {
          return nativeFetch(withParam(input, 'teamId', state.taskTeam), init);
        }
        if (/^\/api\/tasks(\?|$)/.test(rel) && filterValue('tasks')) {
          return nativeFetch(withParam(input, 'teamId', filterValue('tasks')), init);
        }
        if (/^\/api\/submissions(\?|$)/.test(rel) && filterValue('submissions')) {
          return nativeFetch(withParam(input, 'teamId', filterValue('submissions')), init);
        }
      }
    } catch (_) { /* never break the app's own request */ }
    return nativeFetch(input, init);
  };

  /* ── form fields ───────────────────────────────────────────────────────── */
  function fieldFor(labelRe, root) {
    var labels = (root || document).querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      // Ignore the optional leading icon and the trailing required-star.
      var text = (labels[i].textContent || '').replace(/[*\s]+$/, '').replace(/^[^A-Za-z0-9]+/, '').trim();
      if (labelRe.test(text)) return labels[i].parentElement;
    }
    return null;
  }
  function fieldHtml(id, label, inner, hint) {
    return '<label style="font-size:12px;font-weight:500;color:var(--text2);display:block;margin-bottom:6px"><span style="margin-right:6px">👥</span>' + esc(label) + '</label>' +
      inner + (hint ? '<div data-of-hint="' + id + '" style="font-size:11px;color:var(--text3);margin-top:5px">' + hint + '</div>' : '');
  }

  /* Task modal ------------------------------------------------------------- */
  function taskModal() {
    var assigned = fieldFor(/Assigned To$/);
    var lead = fieldFor(/Team Lead$/);
    if (!assigned || !lead) {
      if (state.taskTeam) state.taskTeam = '';
      return;
    }
    var modal = assigned.parentElement;
    if (modal.querySelector('[data-of="task-team"]')) return;
    var box = document.createElement('div');
    box.setAttribute('data-of', 'task-team');
    box.style.marginBottom = '16px';
    box.innerHTML = fieldHtml('task', 'Team', '<select class="input-field" style="cursor:pointer" data-of-sel="task"><option value="">Loading teams…</option></select>',
      'Pick the team first: Assigned To then lists its members, and the team lead is filled in.');
    assigned.parentNode.insertBefore(box, assigned);
    var leadInput = lead.querySelector('input');
    var codeInput = (fieldFor(/Task ID$/) || {}).querySelector ? fieldFor(/Task ID$/).querySelector('input') : null;

    Promise.all([loadTeams(), codeInput && codeInput.value ? taskIndex() : Promise.resolve(null)]).then(function (res) {
      var teams = res[0] || [], idx = res[1];
      var current = '';
      if (idx && codeInput && idx[codeInput.value]) current = String(idx[codeInput.value].teamId || '');
      var sel = box.querySelector('select');
      sel.innerHTML = '<option value="">— Choose a team —</option>' + teams.map(function (t) {
        return '<option value="' + t.id + '"' + (String(t.id) === current ? ' selected' : '') + '>' + esc(t.name + (t.lead ? ' · lead ' + t.lead.name : '')) + '</option>';
      }).join('') + '<option value="none">No team</option>';
      if (!teams.length) box.querySelector('[data-of-hint="task"]').textContent = 'No active teams yet. HR creates them on the HRIS page.';
      state.taskTeam = current;
      sel.onchange = function () {
        state.taskTeam = sel.value;
        var team = teams.filter(function (t) { return String(t.id) === sel.value; })[0];
        if (leadInput) {
          if (team && team.lead) { setReactValue(leadInput, team.lead.name); leadInput.readOnly = true; leadInput.title = 'Set by the team'; }
          else { leadInput.readOnly = false; leadInput.title = ''; }
        }
        // The assignee search re-runs with the new team on the next keystroke.
        var aIn = assigned.querySelector('input');
        if (aIn && aIn.value) setReactValue(aIn, aIn.value);
      };
      if (current) {
        var t0 = teams.filter(function (t) { return String(t.id) === current; })[0];
        if (t0 && t0.lead && leadInput) { leadInput.readOnly = true; leadInput.title = 'Set by the team'; }
      }
    });
  }
  function taskIndex() {
    return getJson('/api/tasks').then(function (rows) {
      var idx = {};
      (rows || []).forEach(function (t) { if (t.taskCode) idx[t.taskCode] = t; });
      return idx;
    });
  }

  /* Submission modal ------------------------------------------------------- */
  function submissionModal() {
    var title = fieldFor(/^Title$/);
    if (!title) { state.subTeam = ''; state.subReviewer = ''; return; }
    var scope = title.parentElement, hops = 0;
    while (scope && hops++ < 6 && (scope.textContent || '').indexOf('New Submission') === -1) scope = scope.parentElement;
    if (!scope || (scope.textContent || '').indexOf('New Submission') === -1) return;
    if (scope.querySelector('[data-of="sub-team"]')) { takeOverBundleReviewer(scope); return; }
    var box = document.createElement('div');
    box.setAttribute('data-of', 'sub-team');
    box.style.marginBottom = '16px';
    box.innerHTML = '<div style="font-size:12px;color:var(--text3)">Loading your teams…</div>';
    title.parentNode.insertBefore(box, title);
    var hr = can('submission.view_all');
    takeOverBundleReviewer(scope);
    loadMyTeams().then(function (teams) {
      teams = teams || [];
      state.subReviewer = '';
      if (!teams.length) {
        state.subTeam = '';
        box.innerHTML = fieldHtml('sub', 'Team', '<div style="font-size:12.5px;color:var(--text2)">You are not in a team, so this goes to the HR review queue.</div>');
        return;
      }
      var only = teams.length === 1;
      state.subTeam = only ? String(teams[0].id) : '';
      var sel = only
        ? '<div style="font-size:13px;font-weight:600;color:var(--text)">' + esc(teams[0].name) + '</div>'
        : '<select class="input-field" style="cursor:pointer" data-of-sel="sub"><option value="">— Choose your team —</option>' +
          teams.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') + '</select>';
      box.innerHTML = fieldHtml('sub', 'Team', sel) + '<div data-of="reviewer" style="margin-top:10px"></div>';
      var s = box.querySelector('[data-of-sel="sub"]');
      if (s) s.onchange = function () { state.subTeam = s.value; state.subReviewer = ''; showReviewer(box, teams, hr); };
      showReviewer(box, teams, hr);
    });
  }
  /* The bundle's form has its own required "Reviewer" select offering role
     names (Manager / Team Lead). Routing now comes from the team, so that
     field is hidden and satisfied with its "Team Lead" entry; ours replaces it. */
  function takeOverBundleReviewer(scope) {
    var labels = scope.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      if (l.closest('[data-of]')) continue;
      var txt = (l.textContent || '').replace(/[*\s]+$/, '').replace(/^[^A-Za-z]+/, '').trim();
      if (txt !== 'Reviewer') continue;
      var wrap = l.parentElement;
      var ctl = wrap && wrap.querySelector('select, input');
      if (!ctl || wrap.getAttribute('data-of-hidden')) return;
      if (ctl.tagName === 'SELECT') {
        var pick = '';
        Array.prototype.forEach.call(ctl.options, function (o) { if (!pick && /team lead/i.test(o.textContent)) pick = o.value; });
        if (!pick) Array.prototype.forEach.call(ctl.options, function (o) { if (!pick && o.value) pick = o.value; });
        if (pick) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(ctl, pick);
          ctl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (!ctl.value) {
        setReactValue(ctl, 'Team Lead');
      }
      wrap.style.display = 'none';
      wrap.setAttribute('data-of-hidden', '1');
      return;
    }
  }
  function showReviewer(box, teams, hr) {
    var slot = box.querySelector('[data-of="reviewer"]');
    if (!slot) return;
    state.subReviewerName = '';
    var team = teams.filter(function (t) { return String(t.id) === state.subTeam; })[0];
    if (!team) { slot.innerHTML = '<div style="font-size:11.5px;color:var(--text3)">Choose a team to see who will review this.</div>'; return; }
    var lead = team.lead && team.lead.email !== me() ? team.lead : null;
    state.subReviewerName = lead ? lead.name : '';
    if (!hr) {
      slot.innerHTML = '<div style="font-size:12px;color:var(--text2)">Reviewer: <b>' + esc(lead ? lead.name : 'HR review queue') + '</b>' +
        (lead ? ' <span style="color:var(--text3)">(team lead)</span>' : '') + '</div>';
      return;
    }
    getJson('/api/org/reviewers?teamId=' + team.id).then(function (rows) {
      slot.innerHTML = '<label style="font-size:12px;font-weight:500;color:var(--text2);display:block;margin-bottom:6px">Reviewer</label>' +
        '<select class="input-field" style="cursor:pointer" data-of-sel="rev">' + (rows || []).map(function (r) {
          return '<option value="' + esc(r.email) + '"' + (r.isLead ? ' selected' : '') + '>' + esc(r.name + (r.isLead ? ' (team lead)' : '')) + '</option>';
        }).join('') + '</select>';
      var rs = slot.querySelector('select');
      var sync = function () {
        state.subReviewer = rs.value;
        var o = rs.options[rs.selectedIndex];
        state.subReviewerName = o ? o.textContent.replace(/ \(team lead\)$/, '') : '';
      };
      rs.onchange = sync;
      sync();
    });
  }

  /* Page filters ------------------------------------------------------------ */
  function pageFilter() {
    var kind = path() === '/employees/tasks' ? 'tasks' : (path() === '/employees/submissions' ? 'submissions' : '');
    var old = document.querySelector('[data-of="filter"]');
    if (!kind || !(can('employee.view') || can('submission.view_all'))) { if (old) old.remove(); return; }
    var content = document.querySelector('.main > .content') || document.querySelector('.content');
    if (!content || !content.firstElementChild) return;
    if (old && old.getAttribute('data-kind') === kind && old.parentElement === content) return;
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.setAttribute('data-of', 'filter');
    bar.setAttribute('data-kind', kind);
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12.5px;color:var(--text2)';
    bar.innerHTML = '<span>👥 Team</span><select class="input-field" style="width:auto;min-width:200px;cursor:pointer"><option value="">All teams</option></select>';
    content.insertBefore(bar, content.firstElementChild);
    var sel = bar.querySelector('select');
    loadTeams().then(function (teams) {
      var cur = filterValue(kind);
      sel.innerHTML = '<option value="">All teams</option>' + (teams || []).map(function (t) {
        return '<option value="' + t.id + '"' + (String(t.id) === cur ? ' selected' : '') + '>' + esc(t.name) + '</option>';
      }).join('');
    });
    sel.onchange = function () {
      try { if (sel.value) sessionStorage.setItem(FILTER_KEY[kind], sel.value); else sessionStorage.removeItem(FILTER_KEY[kind]); } catch (_) {}
      location.reload();     // the bundle loads its list once per mount
    };
  }

  /* ── mount ──────────────────────────────────────────────────────────────── */
  var queued = false;
  function sweep() { queued = false; try { taskModal(); submissionModal(); pageFilter(); } catch (e) { console.warn('[hrms-org-forms]', e); } }
  function schedule() { if (queued) return; queued = true; (window.requestAnimationFrame || setTimeout)(sweep); }
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.closest && t.closest('[data-of]')) continue;
      schedule(); return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();

  window.__hrmsOrgForms = { state: state, refreshTeams: function () { state.teams = null; state.myTeams = null; } };
})();
