/**
 * hrms-tickets.js  v1
 * Help Desk Tickets — /tickets (list) and /tickets/<id> (detail).
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): the page renders into the
 * sidecar's own root; React-owned DOM is never touched.
 *
 * Backend: api/tickets.py
 *   GET  /api/tickets/meta            categories, agents, counts, canManage
 *   GET  /api/tickets?scope&status&category&priority&q&overdue
 *   POST /api/tickets                 raise a ticket
 *   GET/PATCH /api/tickets/<id>       detail + conversation / update
 *   POST /api/tickets/<id>/comments   reply or internal note
 *
 * SLA countdowns tick client-side every 30 s from the server's minutesLeft
 * (measured on the business clock), so the browser's timezone never matters.
 */
(function () {
  'use strict';
  if (window.__hrmsTicketsLoaded) return;
  window.__hrmsTicketsLoaded = true;

  var BASE = '/tickets';
  var STYLE_ID = 'hrms-tk-style';
  var SC = null;
  var state = {
    root: null, meta: null, token: 0, timer: null, searchTimer: null,
    filters: { scope: '', status: 'active', category: '', priority: '', q: '', overdue: false },
  };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: true }); } catch (_) {}
    return String(v);
  }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.tk-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.tk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap}',
      '.tk-h1{font-size:20px;font-weight:700;margin:0}',
      '.tk-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.tk-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}',
      '.tk-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius,10px);padding:18px;cursor:pointer;text-align:left;font-family:inherit;color:var(--text);position:relative;overflow:hidden;box-sizing:border-box;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,border-color .2s ease}',
      '.tk-kpi:before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent)}',
      '.tk-kpi.blue:before{background:var(--accent)}',
      '.tk-kpi.purple:before{background:var(--accent2)}',
      '.tk-kpi.green:before{background:var(--accent3)}',
      '.tk-kpi.orange:before{background:var(--accent4)}',
      '.tk-kpi:hover{border-color:color-mix(in srgb, var(--accent) 26%, var(--border2));transform:translateY(-3px);box-shadow:0 10px 26px rgba(0,0,0,.28)}',
      '@media (hover:none){.tk-kpi:hover{transform:none;box-shadow:none}}',
      '@media (prefers-reduced-motion: reduce){.tk-kpi{transition:none}}',
      '.tk-kpi span{display:block;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}',
      '.tk-kpi b{display:block;font-family:var(--font-d,inherit);font-size:28px;font-weight:800;line-height:1;color:var(--text)}',
      '.tk-kpi.tk-danger:before{background:var(--danger)}',
      '.tk-kpi.tk-danger b{color:var(--danger)}',
      '.tk-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px}',
      '.tk-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px}',
      '.tk-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.tk-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
      '.tk-filters .input-field{width:auto;min-width:140px;padding:7px 10px}',
      '.tk-filters .tk-search{flex:1;min-width:200px}',
      '.tk-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;user-select:none}',
      '.tk-table-wrap{overflow-x:auto}',
      '.tk-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.tk-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.tk-table td{padding:10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.tk-table tbody tr{cursor:pointer}',
      '.tk-table tbody tr:hover td{background:var(--bg3)}',
      '.tk-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text2);white-space:nowrap}',
      '.tk-subj{font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tk-muted{color:var(--text3)}',
      '.tk-nowrap{white-space:nowrap}',
      '.tk-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.tk-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.tk-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.tk-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.tk-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.tk-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.tk-sla{font-size:12px;font-weight:600;white-space:nowrap}',
      '.tk-sla.s-ok{color:var(--success)}.tk-sla.s-warn{color:var(--warn)}.tk-sla.s-bad{color:var(--danger)}.tk-sla.s-muted{color:var(--text3)}',
      '.tk-empty{padding:40px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.tk-err{padding:12px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px}',
      '.tk-back{display:inline-block;font-size:13px;color:var(--text2);text-decoration:none;margin-bottom:12px}',
      '.tk-back:hover{color:var(--accent)}',
      '.tk-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}',
      '@media (max-width:960px){.tk-grid{grid-template-columns:1fr}}',
      '@media (max-width:720px){.tk-kpis{grid-template-columns:repeat(2,1fr)}}',
      '@media (max-width:420px){.tk-kpis{grid-template-columns:1fr}}',
      '.tk-stack>*+*{margin-top:16px}',
      '.tk-title-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
      '.tk-desc{white-space:pre-wrap;font-size:13px;line-height:1.6;color:var(--text)}',
      '.tk-conv{display:flex;flex-direction:column;gap:12px}',
      '.tk-msg{border:1px solid var(--border2);border-radius:10px;padding:10px 14px;background:var(--bg3)}',
      '.tk-msg.mine{border-color:color-mix(in srgb,var(--accent) 40%,var(--border2))}',
      '.tk-msg.internal{background:color-mix(in srgb,var(--warn) 10%,var(--bg2));border-color:color-mix(in srgb,var(--warn) 45%,transparent)}',
      '.tk-msg-h{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}',
      '.tk-msg-h b{color:var(--text)}',
      '.tk-msg-b{white-space:pre-wrap;font-size:13px;line-height:1.55;word-break:break-word}',
      '.tk-event{font-size:11.5px;color:var(--text3);padding:0 4px;display:flex;gap:8px;align-items:center}',
      '.tk-event:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--border2);flex:none}',
      '.tk-reply{margin-top:16px;border-top:1px solid var(--border2);padding-top:14px}',
      '.tk-reply textarea{min-height:90px;resize:vertical}',
      '.tk-reply-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}',
      '.tk-field{margin-bottom:12px}',
      '.tk-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.tk-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--border)}',
      '.tk-kv:last-child{border-bottom:none}',
      '.tk-kv span:first-child{color:var(--text3)}',
      '.tk-kv span:last-child{text-align:right;word-break:break-word}',
      '.tk-btns{display:flex;gap:8px;flex-wrap:wrap}',
      '.tk-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.tk-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:540px;padding:22px;color:var(--text);max-height:90vh;overflow:auto}',
      '.tk-modal h3{margin:0 0 16px;font-size:16px}',
      '.tk-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.tk-hint{font-size:11.5px;color:var(--text3);margin-top:4px}',
      '.tk-busy{opacity:.6;pointer-events:none}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── small renderers ───────────────────────────────────────────────────── */
  var PRI_CLS = { Low: 'tk-c-muted', Medium: 'tk-c-accent', High: 'tk-c-warn', Urgent: 'tk-c-danger' };
  var STA_CLS = { 'Open': 'tk-c-accent', 'In Progress': 'tk-c-warn', 'Waiting': 'tk-c-muted', 'Resolved': 'tk-c-success', 'Closed': 'tk-c-muted' };
  function badge(text, cls) { return '<span class="tk-badge ' + (cls || 'tk-c-muted') + '">' + esc(text) + '</span>'; }
  function priBadge(p) { return badge(p, PRI_CLS[p]); }
  function staBadge(s) { return badge(s, STA_CLS[s]); }

  function dur(m) {
    m = Math.max(0, Math.round(m));
    if (m >= 1440) { var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d + 'd' + (h ? ' ' + h + 'h' : ''); }
    if (m >= 60) { var hh = Math.floor(m / 60), mm = m % 60; return hh + 'h' + (mm ? ' ' + mm + 'm' : ''); }
    return m + 'm';
  }
  /* SLA cell: data attributes let the 30 s ticker recompute it in place. */
  function slaHtml(t, fetchedAt) {
    var s = t.sla || {};
    return '<span class="tk-sla" data-tk-sla="1" data-state="' + esc(s.state || '') + '" data-left="' +
      (s.minutesLeft == null ? '' : s.minutesLeft) + '" data-hours="' + (t.slaHours || 24) + '" data-at="' +
      fetchedAt + '">' + slaText(s.state, s.minutesLeft, t.slaHours, fetchedAt).text + '</span>';
  }
  function slaText(state, left, hours, at) {
    if (state === 'met') return { text: 'Met', cls: 's-ok' };
    if (left === '' || left == null) return state === 'breached' ? { text: 'Breached', cls: 's-bad' } : { text: '—', cls: 's-muted' };
    var m = Number(left);
    if (state !== 'paused') m -= Math.floor((Date.now() - Number(at)) / 60000);
    if (m < 0) return { text: 'Overdue ' + dur(-m), cls: 's-bad' };
    if (state === 'paused') return { text: 'Paused · ' + dur(m) + ' left', cls: 's-muted' };
    return { text: dur(m) + ' left', cls: m < (Number(hours) || 24) * 60 * 0.25 ? 's-warn' : 's-ok' };
  }
  function tick() {
    if (!state.root) return;
    var els = state.root.querySelectorAll('[data-tk-sla]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var r = slaText(el.getAttribute('data-state'), el.getAttribute('data-left'), el.getAttribute('data-hours'), el.getAttribute('data-at'));
      if (el.textContent !== r.text) el.textContent = r.text;
      el.className = 'tk-sla ' + r.cls;
    }
  }
  function startTicker() {
    stopTicker();
    tick();
    state.timer = setInterval(tick, 30000);
  }
  function stopTicker() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  function options(list, selected, blankLabel) {
    var out = blankLabel != null ? '<option value="">' + esc(blankLabel) + '</option>' : '';
    for (var i = 0; i < list.length; i++) {
      var v = typeof list[i] === 'object' ? list[i].value : list[i];
      var l = typeof list[i] === 'object' ? list[i].label : list[i];
      out += '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }
    return out;
  }

  function loadMeta(force) {
    if (state.meta && !force) return Promise.resolve(state.meta);
    return api('/api/tickets/meta').then(function (m) { state.meta = m; return m; });
  }

  /* ── list page ─────────────────────────────────────────────────────────── */
  function renderList(root) {
    var tok = ++state.token;
    stopTicker();
    root.innerHTML = '<div class="tk-page"><div class="tk-empty">Loading help desk…</div></div>';
    loadMeta(true).then(function (meta) {
      if (tok !== state.token) return;
      var f = state.filters;
      if (!f.scope) f.scope = meta.canManage ? 'all' : 'mine';
      if (!meta.canManage && f.scope !== 'mine') f.scope = 'mine';
      var c = meta.counts || {};
      var tabs = [['mine', 'My tickets']];
      if (meta.canManage) { tabs.push(['assigned', 'Assigned to me']); tabs.push(['all', 'All tickets']); }
      var kpis = [
        ['open', 'Open', c.open, 'blue'],
        ['assigned', 'Assigned to me', c.assignedToMe, 'purple'],
        ['overdue', 'Overdue', c.overdue, c.overdue ? 'orange tk-danger' : 'orange'],
        ['mine', 'My tickets', c.mine, 'green'],
      ];
      var statusOpts = [{ value: 'active', label: 'Active (open)' }].concat(meta.statuses || []);
      root.innerHTML =
        '<div class="tk-page">' +
          '<div class="tk-head"><div><h1 class="tk-h1">Help Desk</h1>' +
            '<div class="tk-sub">Raise HR, IT, Payroll and Facilities requests and track them to resolution.</div></div>' +
            '<button class="btn-primary" data-tk="new">+ New ticket</button></div>' +
          '<div class="tk-kpis">' + kpis.map(function (k) {
            return '<button class="tk-kpi ' + k[3] + '" data-kpi="' + k[0] + '"><span>' + esc(k[1]) + '</span><b>' + (k[2] || 0) + '</b></button>';
          }).join('') + '</div>' +
          '<div class="card" style="padding:16px 18px">' +
            '<div class="tk-tabs">' + tabs.map(function (t) {
              return '<button class="tk-tab' + (f.scope === t[0] ? ' on' : '') + '" data-scope="' + t[0] + '">' + esc(t[1]) + '</button>';
            }).join('') + '</div>' +
            '<div class="tk-filters">' +
              '<input class="input-field tk-search" data-f="q" placeholder="Search subject, code or requester" value="' + esc(f.q) + '">' +
              '<select class="input-field" data-f="status">' + options(statusOpts, f.status, 'All statuses') + '</select>' +
              '<select class="input-field" data-f="category">' + options(meta.categories || [], f.category, 'All categories') + '</select>' +
              '<select class="input-field" data-f="priority">' + options(meta.priorities || [], f.priority, 'All priorities') + '</select>' +
              '<label class="tk-check"><input type="checkbox" data-f="overdue"' + (f.overdue ? ' checked' : '') + '> Overdue only</label>' +
            '</div>' +
            '<div data-tk="rows"><div class="tk-empty">Loading…</div></div>' +
          '</div>' +
        '</div>';
      bindList(root);
      loadRows(root);
    }).catch(function (e) {
      if (tok !== state.token) return;
      root.innerHTML = '<div class="tk-page"><div class="tk-err">' + esc(e.message || 'Could not load the help desk.') + '</div></div>';
    });
  }

  function bindList(root) {
    var f = state.filters;
    root.querySelector('[data-tk="new"]').addEventListener('click', openNewModal);
    Array.prototype.forEach.call(root.querySelectorAll('[data-scope]'), function (b) {
      b.addEventListener('click', function () { f.scope = b.getAttribute('data-scope'); renderList(root); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-kpi]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-kpi'), canManage = state.meta && state.meta.canManage;
        f.status = 'active'; f.overdue = false; f.category = ''; f.priority = ''; f.q = '';
        if (k === 'open') f.scope = canManage ? 'all' : 'mine';
        else if (k === 'assigned') f.scope = canManage ? 'assigned' : 'mine';
        else if (k === 'overdue') { f.scope = canManage ? 'all' : 'mine'; f.overdue = true; }
        else f.scope = 'mine';
        renderList(root);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-f]'), function (el) {
      var key = el.getAttribute('data-f');
      if (key === 'q') {
        el.addEventListener('input', function () {
          clearTimeout(state.searchTimer);
          state.searchTimer = setTimeout(function () { f.q = el.value.trim(); loadRows(root); }, 300);
        });
      } else {
        el.addEventListener('change', function () {
          f[key] = el.type === 'checkbox' ? el.checked : el.value;
          loadRows(root);
        });
      }
    });
  }

  function loadRows(root) {
    var box = root.querySelector('[data-tk="rows"]');
    if (!box) return;
    var f = state.filters;
    var qs = ['scope=' + encodeURIComponent(f.scope)];
    if (f.status) qs.push('status=' + encodeURIComponent(f.status));
    if (f.category) qs.push('category=' + encodeURIComponent(f.category));
    if (f.priority) qs.push('priority=' + encodeURIComponent(f.priority));
    if (f.q) qs.push('q=' + encodeURIComponent(f.q));
    if (f.overdue) qs.push('overdue=1');
    var tok = state.token;
    box.classList.add('tk-busy');
    api('/api/tickets?' + qs.join('&')).then(function (d) {
      if (tok !== state.token || !box.isConnected) return;
      box.classList.remove('tk-busy');
      var rows = (d && d.tickets) || [];
      if (!rows.length) {
        box.innerHTML = '<div class="tk-empty">No tickets match these filters.' +
          (f.scope === 'mine' ? ' Need help? Use <b>+ New ticket</b>.' : '') + '</div>';
        return;
      }
      var at = Date.now();
      box.innerHTML = '<div class="tk-table-wrap"><table class="tk-table"><thead><tr>' +
        '<th>Code</th><th>Subject</th><th>Category</th><th>Priority</th><th>Status</th><th>Requester</th><th>Assignee</th><th>SLA</th><th>Updated</th>' +
        '</tr></thead><tbody>' + rows.map(function (t) {
          return '<tr data-id="' + t.id + '">' +
            '<td class="tk-code">' + esc(t.code) + '</td>' +
            '<td><div class="tk-subj" title="' + esc(t.subject) + '">' + esc(t.subject) + '</div></td>' +
            '<td>' + esc(t.category) + '</td>' +
            '<td>' + priBadge(t.priority) + '</td>' +
            '<td>' + staBadge(t.status) + '</td>' +
            '<td class="tk-nowrap">' + esc(t.requesterName || t.requesterEmail) + '</td>' +
            '<td class="tk-nowrap">' + (t.assigneeName || t.assigneeEmail ? esc(t.assigneeName || t.assigneeEmail) : '<span class="tk-muted">Unassigned</span>') + '</td>' +
            '<td>' + slaHtml(t, at) + '</td>' +
            '<td class="tk-nowrap tk-muted">' + esc(fmtDate(t.updatedAt)) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>' +
        (d.total > rows.length ? '<div class="tk-hint">Showing ' + rows.length + ' of ' + d.total + ' — narrow the filters to see the rest.</div>' : '');
      Array.prototype.forEach.call(box.querySelectorAll('tr[data-id]'), function (tr) {
        tr.addEventListener('click', function () { SC.go(BASE + '/' + tr.getAttribute('data-id')); });
      });
      startTicker();
    }).catch(function (e) {
      if (tok !== state.token || !box.isConnected) return;
      box.classList.remove('tk-busy');
      box.innerHTML = '<div class="tk-err">' + esc(e.message || 'Could not load tickets.') + '</div>';
    });
  }

  /* ── new ticket modal ──────────────────────────────────────────────────── */
  function openNewModal() {
    var meta = state.meta || {};
    var root = state.root;
    if (!root || root.querySelector('.tk-overlay')) return;
    var sla = meta.slaHours || {};
    var ov = document.createElement('div');
    ov.className = 'tk-overlay';
    ov.innerHTML =
      '<div class="tk-modal" role="dialog" aria-modal="true" aria-label="New ticket">' +
        '<h3>New help desk ticket</h3>' +
        '<div data-tk="merr"></div>' +
        '<div class="tk-row2">' +
          '<div class="tk-field"><label>Category</label><select class="input-field" data-m="category">' + options(meta.categories || [], 'HR') + '</select></div>' +
          '<div class="tk-field"><label>Priority</label><select class="input-field" data-m="priority">' + options(meta.priorities || [], 'Medium') + '</select>' +
            '<div class="tk-hint" data-tk="slahint"></div></div>' +
        '</div>' +
        '<div class="tk-field"><label>Subject</label><input class="input-field" data-m="subject" maxlength="255" placeholder="Short summary of the request"></div>' +
        '<div class="tk-field"><label>Description</label><textarea class="input-field" data-m="description" rows="6" placeholder="Details, steps, anything that helps us resolve it"></textarea></div>' +
        '<div class="tk-btns" style="justify-content:flex-end"><button class="btn-sm" data-tk="cancel">Cancel</button><button class="btn-primary" data-tk="submit">Raise ticket</button></div>' +
      '</div>';
    root.appendChild(ov);
    var pri = ov.querySelector('[data-m="priority"]');
    function hint() { var h = sla[pri.value]; ov.querySelector('[data-tk="slahint"]').textContent = h ? 'Response target: ' + h + ' hours' : ''; }
    pri.addEventListener('change', hint); hint();
    function close() { document.removeEventListener('keydown', onKey); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.querySelector('[data-tk="cancel"]').addEventListener('click', close);
    ov.querySelector('[data-m="subject"]').focus();
    ov.querySelector('[data-tk="submit"]').addEventListener('click', function () {
      var btn = this;
      var body = {
        category: ov.querySelector('[data-m="category"]').value,
        priority: pri.value,
        subject: ov.querySelector('[data-m="subject"]').value.trim(),
        description: ov.querySelector('[data-m="description"]').value.trim(),
      };
      var err = ov.querySelector('[data-tk="merr"]');
      if (!body.subject) { err.innerHTML = '<div class="tk-err">Please enter a subject.</div>'; return; }
      btn.disabled = true; btn.textContent = 'Raising…';
      api('/api/tickets', { method: 'POST', body: body }).then(function (t) {
        close();
        SC.go(BASE + '/' + t.id);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Raise ticket';
        err.innerHTML = '<div class="tk-err">' + esc(e.message || 'Could not raise the ticket.') + '</div>';
      });
    });
  }

  /* ── detail page ───────────────────────────────────────────────────────── */
  function renderDetail(root, id) {
    var tok = ++state.token;
    stopTicker();
    root.innerHTML = '<div class="tk-page"><a class="tk-back" href="' + BASE + '">← Back to tickets</a><div class="tk-empty">Loading ticket…</div></div>';
    Promise.all([loadMeta(false), api('/api/tickets/' + id)]).then(function (res) {
      if (tok !== state.token) return;
      paintDetail(root, res[1]);
    }).catch(function (e) {
      if (tok !== state.token) return;
      root.innerHTML = '<div class="tk-page"><a class="tk-back" href="' + BASE + '">← Back to tickets</a>' +
        '<div class="tk-err">' + esc(e.status === 404 ? 'This ticket does not exist or you do not have access to it.' : (e.message || 'Could not load the ticket.')) + '</div></div>';
    });
  }

  function paintDetail(root, t) {
    var meta = state.meta || {};
    var perm = t.permissions || {};
    var me = (SC.me().email || '').toLowerCase();
    var at = Date.now();
    var draft = root.querySelector('[data-tk="body"]');
    var draftText = draft ? draft.value : '';

    var conv = (t.comments || []).map(function (c) {
      if (c.kind === 'event') {
        return '<div class="tk-event"><span>' + esc(c.body) + ' — ' + esc(c.authorName || c.authorEmail || 'System') +
          ', ' + esc(fmtDate(c.createdAt)) + '</span></div>';
      }
      var cls = 'tk-msg' + (c.internal ? ' internal' : '') + ((c.authorEmail || '').toLowerCase() === me ? ' mine' : '');
      return '<div class="' + cls + '"><div class="tk-msg-h"><span><b>' + esc(c.authorName || c.authorEmail) + '</b>' +
        (c.internal ? ' ' + badge('Internal note', 'tk-c-warn') : '') + '</span><span class="tk-muted">' + esc(fmtDate(c.createdAt)) + '</span></div>' +
        '<div class="tk-msg-b">' + esc(c.body) + '</div></div>';
    }).join('') || '<div class="tk-muted" style="font-size:13px">No activity yet.</div>';

    var side;
    if (perm.canManage) {
      var agents = (meta.agents || []).map(function (a) { return { value: a.email, label: a.name || a.email }; });
      if (t.assigneeEmail && !agents.some(function (a) { return a.value === t.assigneeEmail; })) {
        agents.unshift({ value: t.assigneeEmail, label: t.assigneeName || t.assigneeEmail });
      }
      var myAgent = agents.some(function (a) { return a.value === me; }) && t.assigneeEmail !== me;
      side =
        '<div class="card"><div class="card-title">Manage</div>' +
          '<div class="tk-field"><label>Status</label><select class="input-field" data-p="status">' + options(meta.statuses || [], t.status) + '</select></div>' +
          '<div class="tk-field"><label>Priority</label><select class="input-field" data-p="priority">' + options(meta.priorities || [], t.priority) + '</select></div>' +
          '<div class="tk-field"><label>Assignee</label><select class="input-field" data-p="assigneeEmail">' + options(agents, t.assigneeEmail, 'Unassigned') + '</select>' +
            (myAgent ? '<div class="tk-hint"><a href="#" data-tk="take" style="color:var(--accent)">Assign to me</a></div>' : '') + '</div>' +
          '<div class="tk-field"><label>Category</label><select class="input-field" data-p="category">' + options(meta.categories || [], t.category) + '</select></div>' +
          '<div data-tk="perr"></div>' +
        '</div>';
    } else {
      var btns = '';
      if (perm.canClose) btns += '<button class="btn-sm" data-tk="close">Close ticket</button>';
      if (perm.canReopen) btns += '<button class="btn-sm" data-tk="reopen">Reopen</button>';
      side = btns ? '<div class="card"><div class="card-title">Actions</div><div class="tk-btns">' + btns + '</div><div data-tk="perr"></div>' +
        (perm.canReopen ? '<div class="tk-hint" style="margin-top:8px">Resolved tickets can be reopened for 7 days.</div>' : '') + '</div>' : '';
    }
    var info =
      '<div class="card"><div class="card-title">Details</div>' +
        kv('Requester', t.requesterName || t.requesterEmail) +
        kv('Assignee', t.assigneeName || t.assigneeEmail || 'Unassigned') +
        kv('Category', t.category) +
        kv('SLA target', (t.slaHours || 0) + ' hours') +
        kv('Due', fmtDate(t.slaDueAt)) +
        kv('Raised', fmtDate(t.createdAt)) +
        kv('First response', fmtDate(t.firstResponseAt)) +
        (t.resolvedAt ? kv('Resolved', fmtDate(t.resolvedAt)) : '') +
        (t.closedAt ? kv('Closed', fmtDate(t.closedAt)) : '') +
      '</div>';

    var reply = perm.canComment ?
      '<div class="tk-reply">' +
        '<textarea class="input-field" data-tk="body" placeholder="Write a reply…"></textarea>' +
        '<div class="tk-reply-row">' +
          (perm.canInternal ? '<label class="tk-check"><input type="checkbox" data-tk="internal"> Internal note (agents only)</label>' : '<span></span>') +
          '<button class="btn-primary" data-tk="send">Send</button>' +
        '</div><div data-tk="rerr"></div>' +
      '</div>' : '';

    root.innerHTML =
      '<div class="tk-page">' +
        '<a class="tk-back" href="' + BASE + '">← Back to tickets</a>' +
        '<div class="tk-grid">' +
          '<div class="tk-stack">' +
            '<div class="card">' +
              '<div class="tk-code">' + esc(t.code) + ' · ' + esc(t.category) + '</div>' +
              '<h1 class="tk-h1" style="margin-top:6px;word-break:break-word">' + esc(t.subject) + '</h1>' +
              '<div class="tk-title-row">' + staBadge(t.status) + priBadge(t.priority) +
                '<span class="tk-muted" style="font-size:12px">SLA:</span>' + slaHtml(t, at) + '</div>' +
            '</div>' +
            '<div class="card"><div class="card-title">Description</div><div class="tk-desc">' +
              (t.description ? esc(t.description) : '<span class="tk-muted">No description.</span>') + '</div></div>' +
            '<div class="card"><div class="card-title">Conversation</div><div class="tk-conv">' + conv + '</div>' + reply + '</div>' +
          '</div>' +
          '<div class="tk-stack">' + side + info + '</div>' +
        '</div>' +
      '</div>';

    var ta = root.querySelector('[data-tk="body"]');
    if (ta && draftText) ta.value = draftText;
    bindDetail(root, t);
    startTicker();
  }

  function kv(k, v) { return '<div class="tk-kv"><span>' + esc(k) + '</span><span>' + esc(v == null || v === '' ? '—' : v) + '</span></div>'; }

  function bindDetail(root, t) {
    var tok = state.token;
    function patch(body, errBox) {
      root.querySelector('.tk-page').classList.add('tk-busy');
      return api('/api/tickets/' + t.id, { method: 'PATCH', body: body }).then(function (d) {
        if (tok !== state.token) return;
        loadMeta(true).catch(function () {});   // counts changed; keep the old meta meanwhile
        paintDetail(root, d);
      }).catch(function (e) {
        if (tok !== state.token) return;
        var page = root.querySelector('.tk-page'); if (page) page.classList.remove('tk-busy');
        var box = root.querySelector('[data-tk="perr"]') || errBox;
        if (box) box.innerHTML = '<div class="tk-err" style="margin-top:10px">' + esc(e.message || 'Update failed.') + '</div>';
      });
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-p]'), function (sel) {
      sel.addEventListener('change', function () {
        var b = {}; b[sel.getAttribute('data-p')] = sel.value; patch(b);
      });
    });
    var take = root.querySelector('[data-tk="take"]');
    if (take) take.addEventListener('click', function (e) { e.preventDefault(); patch({ assigneeEmail: SC.me().email }); });
    var closeBtn = root.querySelector('[data-tk="close"]');
    if (closeBtn) closeBtn.addEventListener('click', function () { if (window.confirm('Close this ticket?')) patch({ status: 'Closed' }); });
    var reopen = root.querySelector('[data-tk="reopen"]');
    if (reopen) reopen.addEventListener('click', function () { patch({ status: 'Open' }); });

    var send = root.querySelector('[data-tk="send"]');
    if (send) send.addEventListener('click', function () {
      var ta = root.querySelector('[data-tk="body"]');
      var chk = root.querySelector('[data-tk="internal"]');
      var err = root.querySelector('[data-tk="rerr"]');
      var body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      send.disabled = true; send.textContent = 'Sending…';
      api('/api/tickets/' + t.id + '/comments', { method: 'POST', body: { body: body, internal: !!(chk && chk.checked) } }).then(function (d) {
        if (tok !== state.token) return;
        ta.value = '';
        paintDetail(root, d);
      }).catch(function (e) {
        if (tok !== state.token) return;
        send.disabled = false; send.textContent = 'Send';
        err.innerHTML = '<div class="tk-err" style="margin-top:10px">' + esc(e.message || 'Could not send the reply.') + '</div>';
      });
    });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function render(root, sub) {
    state.root = root;
    injectStyle();
    var m = /^\/(\d+)$/.exec(sub || '');
    if (m) renderDetail(root, m[1]);
    else renderList(root);
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE,
      title: 'Help Desk',
      mount: render,
      update: render,
      unmount: function () {
        stopTicker();
        clearTimeout(state.searchTimer);
        state.token++;
        state.root = null;
      },
    });
  }

  if (window.HRMSSidecar) register();
  else {
    var tries = 0;
    var iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); }
      else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
