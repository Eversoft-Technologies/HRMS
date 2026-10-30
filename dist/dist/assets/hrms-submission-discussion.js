/**
 * hrms-submission-discussion.js
 * ---------------------------------------------------------------------------
 * Cross-team discussion on Work Submissions (/employees/submissions).
 *
 * Each row of the submissions table gets a "💬 Discuss" button (with the
 * comment count). It opens a side panel with:
 *   • the people involved — submitter, routed reviewer, collaborators;
 *   • "Add people" (submitter, reviewer and HR only) from any team;
 *   • the comment thread, refreshed every 15 s while open.
 * A collaborator can see the submission and its file and comment, but never
 * approve or reject — that stays with submission.action on the server.
 *
 *   GET  /api/submissions/<id>/thread
 *   POST /api/submissions/<id>/comments          { body }
 *   POST /api/submissions/<id>/collaborators     { email }
 *   DELETE /api/submissions/<id>/collaborators/<email>
 *   GET  /api/org/people                          (the people picker)
 */
(function () {
  'use strict';
  if (window.__hrmsSubDiscussion) return;

  var PATH = '/employees/submissions';
  var PANEL_ID = 'hrms-sd-panel';
  var state = { rows: [], loadedAt: 0, loading: false, open: null, thread: null, people: null, timer: null, busy: false };

  function onPage() { return (location.pathname || '').replace(/\/+$/, '') === PATH; }
  function me() { try { return String((JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}).email || '').toLowerCase(); } catch (_) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function api(p, init) {
    init = init || {};
    init.headers = Object.assign({ Accept: 'application/json' }, init.body ? { 'Content-Type': 'application/json' } : {});
    return fetch(p, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) { var e = new Error((d && d.message) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function when(s) {
    if (!s) return '';
    var d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d.getTime())) return s;
    var diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 1) return 'just now';
    if (diff < 60) return Math.floor(diff) + ' min ago';
    if (diff < 1440) return Math.floor(diff / 60) + ' h ago';
    return window.HRMSCompany ? window.HRMSCompany.date(s) : s.slice(0, 16);
  }

  /* ── styles ─────────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById('hrms-sd-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-sd-style';
    st.textContent = [
      '.hsd-btn{display:inline-flex;align-items:center;gap:5px;margin-left:6px;padding:5px 10px;border-radius:7px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;}',
      '.hsd-btn:hover{border-color:var(--accent);color:var(--accent);}',
      '.hsd-btn b{background:var(--accent);color:#fff;border-radius:999px;padding:0 6px;font-size:10.5px;}',
      '.hsd-back{position:fixed;inset:0;background:rgba(2,6,23,.45);z-index:100000;}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);background:var(--bg2,#fff);color:var(--text,#0f172a);border-left:1px solid var(--border2);z-index:100001;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(2,6,23,.25);font-family:var(--font,sans-serif);}',
      '.hsd-head{padding:16px 18px;border-bottom:1px solid var(--border2);display:flex;gap:10px;align-items:flex-start;}',
      '.hsd-head h3{margin:0;font-size:16px;font-weight:700;line-height:1.3;}',
      '.hsd-sub{font-size:12px;color:var(--text3);margin-top:4px;}',
      '.hsd-x{margin-left:auto;width:32px;height:32px;border-radius:8px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);font-size:18px;cursor:pointer;flex-shrink:0;}',
      '.hsd-sec{padding:12px 18px;border-bottom:1px solid var(--border2);}',
      '.hsd-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:8px;}',
      '.hsd-people{display:flex;flex-wrap:wrap;gap:6px;}',
      '.hsd-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 4px;border-radius:999px;border:1px solid var(--border2);background:var(--bg3);font-size:12px;}',
      '.hsd-av{width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:9.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;}',
      '.hsd-role{font-size:10px;font-weight:700;color:var(--accent);}',
      '.hsd-chip button{border:none;background:none;color:var(--text3);cursor:pointer;font-size:14px;padding:0 3px;}',
      '.hsd-add{display:flex;gap:6px;margin-top:10px;}',
      '.hsd-add select,.hsd-add input{flex:1;min-width:0;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:7px;padding:6px 8px;font:inherit;font-size:12.5px;}',
      '.hsd-thread{flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:12px;}',
      '.hsd-msg{display:flex;gap:9px;}',
      '.hsd-msg .hsd-av{width:30px;height:30px;font-size:11px;flex-shrink:0;}',
      '.hsd-bubble{background:var(--bg3);border:1px solid var(--border2);border-radius:4px 12px 12px 12px;padding:8px 11px;min-width:0;}',
      '.hsd-msg.mine{flex-direction:row-reverse;}',
      '.hsd-msg.mine .hsd-bubble{border-radius:12px 4px 12px 12px;background:rgba(79,142,247,.12);border-color:rgba(79,142,247,.3);}',
      '.hsd-meta{font-size:11px;color:var(--text3);margin-bottom:3px;}',
      '.hsd-meta b{color:var(--text);font-weight:700;}',
      '.hsd-body{font-size:13px;white-space:pre-wrap;word-break:break-word;}',
      '.hsd-empty{color:var(--text3);font-size:12.5px;text-align:center;padding:30px 10px;}',
      '.hsd-compose{border-top:1px solid var(--border2);padding:12px 18px;display:flex;flex-direction:column;gap:8px;}',
      '.hsd-compose textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;}',
      '.hsd-compose .row{display:flex;align-items:center;gap:8px;}',
      '.hsd-hint{font-size:11px;color:var(--text3);margin-right:auto;}',
      '.hsd-err{color:var(--danger,#dc2626);font-size:12px;}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ── rows ───────────────────────────────────────────────────────────────── */
  function loadRows(force) {
    if (state.loading || (!force && Date.now() - state.loadedAt < 20000)) return;
    state.loading = true;
    api('/api/submissions').then(function (rows) { state.rows = Array.isArray(rows) ? rows : []; })
      .catch(function () {})
      .then(function () { state.loading = false; state.loadedAt = Date.now(); decorate(); });
  }
  function table() {
    var tables = document.querySelectorAll('.content table');
    for (var i = 0; i < tables.length; i++) {
      var heads = Array.prototype.map.call(tables[i].querySelectorAll('thead th'), function (th) { return norm(th.textContent); });
      if (heads.indexOf('title') !== -1 && heads.indexOf('employee') !== -1) return { el: tables[i], heads: heads };
    }
    return null;
  }
  // Match a table row to a submission by its title and employee cells; the
  // n-th identical pair maps to the n-th matching submission.
  function decorate() {
    var t = table();
    if (!t) return;
    ensureStyle();
    var ti = t.heads.indexOf('title'), ei = t.heads.indexOf('employee');
    var used = {};
    t.el.querySelectorAll('tbody tr').forEach(function (tr) {
      var cells = tr.children;
      if (cells.length < Math.max(ti, ei) + 1) return;
      var title = norm(cells[ti].textContent), who = norm(cells[ei].textContent);
      var key = title + '|' + who;
      var n = used[key] = (used[key] || 0) + 1;
      var hits = state.rows.filter(function (r) {
        return norm(r.title) === title && (who.indexOf(norm(r.employee || '')) !== -1 || who.indexOf(norm(r.email)) !== -1 || !r.employee);
      });
      var sub = hits[n - 1];
      var host = cells[cells.length - 1];
      var btn = host.querySelector('.hsd-btn');
      if (!sub) { if (btn) btn.remove(); return; }
      var label = '💬 Discuss' + (sub.commentCount ? ' <b>' + sub.commentCount + '</b>' : '');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hsd-btn';
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(Number(btn.getAttribute('data-id'))); });
        host.appendChild(btn);
      }
      if (btn.getAttribute('data-id') !== String(sub.id)) btn.setAttribute('data-id', sub.id);
      if (btn.innerHTML !== label) btn.innerHTML = label;
      btn.title = sub.collaborators && sub.collaborators.length ? 'Discussion with ' + sub.collaborators.length + ' collaborator(s)' : 'Discuss this submission';
    });
  }

  /* ── panel ──────────────────────────────────────────────────────────────── */
  function close() {
    clearInterval(state.timer); state.timer = null;
    state.open = null; state.thread = null;
    var p = document.getElementById(PANEL_ID); if (p) p.remove();
    var b = document.querySelector('.hsd-back'); if (b) b.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open(id) {
    close();
    ensureStyle();
    state.open = id;
    var back = document.createElement('div'); back.className = 'hsd-back'; back.onclick = close;
    var panel = document.createElement('aside'); panel.id = PANEL_ID; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Submission discussion');
    panel.innerHTML = '<div class="hsd-empty">Loading discussion…</div>';
    panel.addEventListener('click', onPanelClick);
    document.body.appendChild(back); document.body.appendChild(panel);
    document.addEventListener('keydown', onKey);
    refresh(true);
    state.timer = setInterval(function () { if (!document.hidden) refresh(false); }, 15000);
  }
  function refresh(scrollDown) {
    var id = state.open;
    if (!id) return;
    api('/api/submissions/' + id + '/thread').then(function (t) {
      if (state.open !== id) return;
      var grew = !state.thread || t.comments.length !== state.thread.comments.length;
      state.thread = t;
      render(scrollDown || grew);
      if (t.canManage && state.people === null) {
        state.people = [];
        api('/api/org/people').then(function (rows) { state.people = Array.isArray(rows) ? rows : []; render(false); })
          .catch(function () { state.people = []; });
      }
    }).catch(function (e) {
      var p = document.getElementById(PANEL_ID);
      if (p) p.innerHTML = '<div class="hsd-head"><h3>Discussion</h3><button class="hsd-x" data-sd="close">&times;</button></div><div class="hsd-empty">' + esc(e.message) + '</div>';
    });
  }
  function chip(c, role, removable) {
    var ini = (c.initials || (c.name || '?').slice(0, 1)).slice(0, 2);
    return '<span class="hsd-chip" data-email="' + esc(c.email) + '"><span class="hsd-av">' + esc(ini) + '</span>' + esc(c.name || c.email) +
      (role ? ' <span class="hsd-role">' + esc(role) + '</span>' : '') +
      (removable ? '<button title="Remove" data-sd="remove" data-email="' + esc(c.email) + '">&times;</button>' : '') + '</span>';
  }
  function render(scrollDown) {
    var p = document.getElementById(PANEL_ID), t = state.thread;
    if (!p || !t) return;
    var mine = me();
    var draft = p.querySelector('textarea') ? p.querySelector('textarea').value : '';
    var thread = p.querySelector('.hsd-thread');
    var keepScroll = thread && !scrollDown ? thread.scrollTop : null;
    var people = chip(t.submitter, 'Submitter') + (t.reviewer ? chip(t.reviewer, 'Reviewer') : '') +
      t.collaborators.map(function (c) { return chip(c, '', t.canManage || c.email === mine); }).join('');
    var add = '';
    if (t.canManage) {
      var taken = {}; taken[t.submitter.email] = 1; if (t.reviewer) taken[t.reviewer.email] = 1;
      t.collaborators.forEach(function (c) { taken[c.email] = 1; });
      var opts = (state.people || []).filter(function (x) { return !taken[x.email]; }).map(function (x) {
        return '<option value="' + esc(x.email) + '">' + esc(x.name + (x.designation ? ' · ' + x.designation : '') + (x.department ? ' (' + x.department + ')' : '')) + '</option>';
      }).join('');
      add = '<div class="hsd-add"><select data-sd="pick"><option value="">' + (state.people && state.people.length ? 'Add someone from any team…' : 'Loading people…') + '</option>' + opts + '</select>' +
        '<button class="btn-sm" data-sd="add">Add</button></div>';
    }
    var isCollab = t.collaborators.some(function (c) { return c.email === mine; });
    var msgs = t.comments.length ? t.comments.map(function (c) {
      var ini = (c.authorName || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      return '<div class="hsd-msg' + (c.authorEmail === mine ? ' mine' : '') + '"><span class="hsd-av">' + esc(ini) + '</span><div class="hsd-bubble">' +
        '<div class="hsd-meta"><b>' + esc(c.authorName) + '</b> · ' + esc(when(c.createdAt)) + '</div><div class="hsd-body">' + esc(c.body) + '</div></div></div>';
    }).join('') : '<div class="hsd-empty">No comments yet. Start the conversation — everyone listed above is notified.</div>';
    p.innerHTML =
      '<div class="hsd-head"><div style="min-width:0"><h3>' + esc(t.title) + '</h3><div class="hsd-sub">' + esc(t.status || 'Pending') + (t.teamName ? ' · ' + esc(t.teamName) : '') + '</div></div>' +
        '<button class="hsd-x" data-sd="close" aria-label="Close">&times;</button></div>' +
      '<div class="hsd-sec"><div class="hsd-label">People in this discussion</div><div class="hsd-people">' + people + '</div>' + add +
        (isCollab && !t.canManage ? '<div style="margin-top:8px"><button class="btn-sm" data-sd="leave">Leave discussion</button></div>' : '') + '</div>' +
      '<div class="hsd-thread">' + msgs + '</div>' +
      '<div class="hsd-compose"><textarea placeholder="Write a comment…" maxlength="4000">' + esc(draft) + '</textarea>' +
        '<div class="row"><span class="hsd-hint">Ctrl+Enter to send · collaborators can comment, not approve</span><span class="hsd-err"></span><button class="btn-primary" data-sd="send">Send</button></div></div>';
    var th = p.querySelector('.hsd-thread');
    th.scrollTop = keepScroll != null ? keepScroll : th.scrollHeight;
    var ta = p.querySelector('textarea');
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  }
  function setErr(msg) { var el = document.querySelector('#' + PANEL_ID + ' .hsd-err'); if (el) el.textContent = msg || ''; }
  function act(promise) {
    if (state.busy) return;
    state.busy = true; setErr('');
    promise.then(function (r) {
      if (r && r.left) { close(); loadRows(true); return; }
      refresh(false); loadRows(true);
    }).catch(function (e) { setErr(e.message); }).then(function () { state.busy = false; });
  }
  function send() {
    var ta = document.querySelector('#' + PANEL_ID + ' textarea');
    var body = ta ? ta.value.trim() : '';
    if (!body) { setErr('Write a comment first.'); return; }
    var id = state.open;
    act(api('/api/submissions/' + id + '/comments', { method: 'POST', body: JSON.stringify({ body: body }) })
      .then(function (r) { if (ta) ta.value = ''; return r; }));
  }
  function onPanelClick(e) {
    var el = e.target.closest('[data-sd]');
    if (!el) return;
    var kind = el.getAttribute('data-sd'), id = state.open;
    if (kind === 'close') close();
    else if (kind === 'send') send();
    else if (kind === 'add') {
      var pick = document.querySelector('#' + PANEL_ID + ' [data-sd="pick"]');
      if (!pick || !pick.value) { setErr('Choose someone to add.'); return; }
      act(api('/api/submissions/' + id + '/collaborators', { method: 'POST', body: JSON.stringify({ email: pick.value }) }));
    } else if (kind === 'remove' || kind === 'leave') {
      var who = kind === 'leave' ? me() : el.getAttribute('data-email');
      act(api('/api/submissions/' + id + '/collaborators/' + encodeURIComponent(who), { method: 'DELETE' }));
    }
  }

  /* ── mount ──────────────────────────────────────────────────────────────── */
  var queued = false;
  function sweep() {
    queued = false;
    if (!onPage()) { if (state.open) close(); return; }
    loadRows(false);
    decorate();
  }
  function schedule() { if (queued) return; queued = true; (window.requestAnimationFrame || setTimeout)(sweep); }
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var tg = muts[i].target;
      if (tg && tg.closest && (tg.closest('#' + PANEL_ID) || tg.closest('.hsd-btn'))) continue;
      schedule(); return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();

  window.__hrmsSubDiscussion = { open: open, reload: function () { loadRows(true); } };
})();
