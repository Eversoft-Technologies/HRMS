/*
 * hrms-regularize.js — ONE missed-punch / regularization feature.
 * ---------------------------------------------------------------------------
 * Before the merge there were three parallel UIs: the Leave page's
 * "+ Missed Clock-Out" form (/api/attendance/corrections), the Check In / Out
 * "Attendance tickets" pop-up (/api/attendance/punch-ticket) and the
 * "Attendance needs your attention" card (/api/attendance/regularization).
 * This module is the single replacement, used by BOTH pages:
 *
 *   window.HRMSRegularize.mount(el)   renders the panel into `el` (a node the
 *                                     caller owns and leaves empty):
 *                                       • entry button "Missed punch / Regularize"
 *                                       • quota for the month (policy monthly_limit)
 *                                       • the employee's flagged days + deadlines
 *                                       • their requests of every kind (one history)
 *                                       • for a manager / HR: the one approval queue
 *   window.HRMSRegularize.open({date}) the one form (prefilled for a flagged
 *                                     day when there is one; otherwise the
 *                                     employee picks the date)
 *   window.HRMSRegularize.load(force)  re-fetch (pages call it on their events)
 *
 * Server (api/attendance_ext/regularization.py) applies one rule set to every
 * request: monthly limit counting every kind, one pending per day, the day's
 * deadline / late flag, reason code required, proof optional, and one
 * approval → recalculation path.
 *
 * Only our own nodes are created or replaced; nothing React renders is
 * touched. All state lives here, so every mounted panel shows the same data.
 * Events: dispatches 'hrmsRegularizeChanged' after every load, and
 * 'hrmsAttendanceSynced' after a submit / decision (attendance changed).
 */
(function () {
  'use strict';

  var STYLE = 'hrms-regularize-style';
  var BACK = 'hrz-back';
  var S = {
    data: null, queue: [], fetchedAt: 0, busy: null, mounts: [], qAll: false,
    showAll: false, msg: '', msgKind: '', proof: '', autoDone: false, err: ''
  };
  var REASONS = [
    ['client_meeting', 'Client meeting'], ['forgot_badge', 'Forgot ID badge'], ['network_issue', 'Network issue'],
    ['field_work', 'Field work'], ['system_issue', 'System issue'], ['other', 'Other']
  ];

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function me() { try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email || '').toLowerCase(); } catch (_) { return ''; } }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
          e.status = r.status; throw e;
        }
        return d;
      });
    });
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return (S.data && S.data.today) || isoOf(new Date()); }
  function fmtDate(iso) {
    if (!iso) return '';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(String(iso).slice(0, 10)); } catch (_) {}
    var p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : iso;
  }
  function timeOf(s) { return s ? String(s).slice(11, 16) : ''; }
  function t12(hm) {
    if (!hm) return '';
    var h = parseInt(hm.slice(0, 2), 10), m = hm.slice(3, 5);
    if (isNaN(h)) return hm;
    return ((h % 12) || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function fmtLeft(secs) {
    if (secs == null) return '';
    var neg = secs < 0; secs = Math.abs(secs);
    var d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    var t = d ? (d + 'd ' + h + 'h') : (h ? (h + 'h ' + m + 'm') : (m + 'm'));
    return neg ? 'Overdue by ' + t : 'Due in ' + t;
  }
  function secsLeft(i) { return i.secondsLeft == null ? null : i.secondsLeft - Math.round((Date.now() - S.fetchedAt) / 1000); }
  function issues() { return (S.data && Array.isArray(S.data.issues)) ? S.data.issues : []; }
  function requests() { return (S.data && Array.isArray(S.data.requests)) ? S.data.requests : []; }
  function reasonText(r) {
    var l = r.reasonLabel || '';
    if (!l && r.reasonCode) REASONS.forEach(function (c) { if (c[0] === r.reasonCode) l = c[1]; });
    return [l, r.reason || ''].filter(Boolean).join(' — ');
  }
  function timesText(r) {
    var s = [];
    if (r.requestedCheckIn) s.push('in ' + (r.requestedCheckInLabel || t12(timeOf(r.requestedCheckIn))));
    if (r.requestedCheckOut) s.push('out ' + (r.requestedCheckOutLabel || t12(timeOf(r.requestedCheckOut))) +
      (String(r.requestedCheckOut).slice(0, 10) !== r.date ? ' (+1 day)' : ''));
    return s.join(', ');
  }
  function kindText(r) {
    if (r.kind === 'regularize') return r.issueLabel ? r.issueLabel : 'Regularization';
    return r.kindLabel || 'Missed punch';
  }
  function pill(status) {
    var s = String(status || 'Pending');
    return '<span class="hrz-pill ' + esc(s.toLowerCase()) + '">' + esc(s) + '</span>';
  }
  function emit(name) { try { window.dispatchEvent(new CustomEvent(name, { detail: {} })); } catch (_) {} }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE)) return;
    var P = '.hrz', B = '#' + BACK;
    var css = [
      P + '{color:var(--text);font-size:13px;}',
      P + ' .hrz-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      P + ' .hrz-title{font-size:14px;font-weight:700;color:var(--text);margin-right:auto;}',
      P + ' .hrz-quota{font-size:11.5px;font-weight:600;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-radius:999px;padding:3px 10px;white-space:nowrap;}',
      P + ' .hrz-quota.out{color:var(--danger);border-color:var(--danger);}',
      P + ' .hrz-sub{font-size:12px;color:var(--text2);margin:6px 0 2px;line-height:1.5;}',
      P + ' .hrz-btn,' + B + ' .hrz-btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:7px 14px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}',
      P + ' .hrz-btn:disabled,' + B + ' .hrz-btn:disabled{opacity:.55;cursor:not-allowed;}',
      P + ' .hrz-btn.alt,' + B + ' .hrz-btn.alt{background:var(--bg3);color:var(--text);border:1px solid var(--border2);}',
      P + ' .hrz-btn.ok{background:var(--success);}',
      P + ' .hrz-btn.no{background:var(--danger);}',
      P + ' .hrz-sec{margin-top:14px;}',
      P + ' .hrz-h{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.45px;color:var(--text2);margin-bottom:8px;}',
      P + ' .hrz-h .hrz-chips{margin-left:auto;display:flex;gap:6px;}',
      P + ' .hrz-chip{border:1px solid var(--border2);background:transparent;color:var(--text2);border-radius:999px;padding:2px 10px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;text-transform:none;letter-spacing:normal;}',
      P + ' .hrz-chip.on{border-color:var(--accent);color:var(--accent);}',
      P + ' .hrz-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--border2);border-radius:10px;padding:9px 12px;margin-bottom:7px;}',
      P + ' .hrz-row.flag{border-left-color:var(--warn);}',
      P + ' .hrz-row.overdue{border-left-color:var(--danger);}',
      P + ' .hrz-row.pending{border-left-color:var(--warn);}',
      P + ' .hrz-row.approved{border-left-color:var(--success);}',
      P + ' .hrz-row.rejected{border-left-color:var(--danger);}',
      P + ' .hrz-row.queue{border-left-color:var(--accent);}',
      P + ' .hrz-main{flex:1 1 240px;min-width:0;}',
      P + ' .hrz-what{font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      P + ' .hrz-msg2{font-size:12px;color:var(--text2);margin-top:2px;word-break:break-word;}',
      P + ' .hrz-meta{font-size:11.5px;color:var(--text2);margin-top:3px;word-break:break-word;}',
      P + ' .hrz-due{font-weight:700;color:var(--warn);}',
      P + ' .hrz-due.overdue{color:var(--danger);}',
      P + ' .hrz-acts{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      P + ' .hrz-note{background:var(--bg2);border:1px solid var(--border2);border-radius:7px;color:var(--text);font:inherit;font-size:11.5px;padding:5px 8px;width:150px;max-width:100%;box-sizing:border-box;}',
      P + ' .hrz-note::placeholder{color:var(--text3);}',
      P + ' .hrz-empty{font-size:12px;color:var(--text2);padding:9px 12px;border:1px dashed var(--border2);border-radius:10px;}',
      P + ' .hrz-more{background:none;border:none;padding:0;font:inherit;font-size:11.5px;font-weight:600;color:var(--accent);cursor:pointer;}',
      P + ' .hrz-status{font-size:12px;font-weight:600;min-height:16px;margin-top:8px;}',
      '.hrz-status.ok,' + B + ' .hrz-status.ok{color:var(--success);}',
      '.hrz-status.err,' + B + ' .hrz-status.err{color:var(--danger);}',
      '.hrz-pill{display:inline-block;flex-shrink:0;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;background:rgba(148,163,184,.18);color:var(--text2);text-transform:none;letter-spacing:normal;}',
      '.hrz-pill.pending{background:rgba(234,179,8,.18);color:var(--warn);}',
      '.hrz-pill.approved{background:rgba(34,197,94,.16);color:var(--success);}',
      '.hrz-pill.rejected,.hrz-pill.late,.hrz-pill.overdue{background:rgba(239,68,68,.15);color:var(--danger);}',
      /* the form */
      B + '{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;box-sizing:border-box;}',
      B + ' .hrz-modal{background:var(--bg2,var(--surface,#fff));color:var(--text);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:560px;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.35);box-sizing:border-box;font-size:13px;}',
      B + ' .hrz-mhead{display:flex;align-items:center;gap:10px;margin-bottom:12px;}',
      B + ' .hrz-mtitle{font-size:17px;font-weight:800;color:var(--text);margin-right:auto;}',
      B + ' .hrz-x{border:none;background:transparent;color:var(--text2);font-size:22px;line-height:1;cursor:pointer;padding:0 6px;border-radius:6px;}',
      B + ' .hrz-x:hover{background:var(--bg3);}',
      B + ' .hrz-f{display:flex;flex-direction:column;gap:5px;margin-bottom:11px;}',
      B + ' .hrz-f label{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;}',
      B + ' .hrz-f label .hrz-cur{font-weight:500;text-transform:none;letter-spacing:normal;color:var(--text2);}',
      B + ' .hrz-req{color:var(--danger);}',
      B + ' .hrz-in{background:var(--bg3);border:1px solid var(--border2);border-radius:9px;color:var(--text);font:inherit;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box;width:100%;}',
      B + ' .hrz-in:focus{border-color:var(--accent);}',
      B + ' textarea.hrz-in{min-height:60px;resize:vertical;}',
      B + ' .hrz-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
      B + ' .hrz-info{font-size:12px;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-left:3px solid var(--accent);border-radius:8px;padding:9px 11px;margin-bottom:12px;line-height:1.5;}',
      B + ' .hrz-info.warn{border-left-color:var(--warn);}',
      B + ' .hrz-info.bad{border-left-color:var(--danger);}',
      B + ' .hrz-days{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}',
      B + ' .hrz-day{border:1px solid var(--border2);background:var(--bg3);color:var(--text);border-radius:999px;padding:4px 11px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;}',
      B + ' .hrz-day.on{border-color:var(--accent);color:var(--accent);}',
      B + ' .hrz-preview img{max-width:100%;max-height:170px;border-radius:9px;border:1px solid var(--border2);display:block;margin-top:6px;}',
      B + ' .hrz-mf{display:flex;justify-content:flex-end;gap:10px;margin-top:6px;flex-wrap:wrap;}',
      B + ' .hrz-proofimg{max-height:70vh;overflow:auto;border-radius:10px;border:1px solid var(--border2);}',
      B + ' .hrz-proofimg img{width:100%;display:block;}',
      '@media(max-width:560px){' + B + ' .hrz-grid{grid-template-columns:1fr;}' + P + ' .hrz-note{width:100%;}' + P + ' .hrz-acts{width:100%;}}'
    ].join('');
    var st = document.createElement('style');
    st.id = STYLE; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function load(force) {
    var em = me();
    if (!em) return Promise.resolve(S);
    if (S.busy) return S.busy;
    if (!force && S.data && Date.now() - S.fetchedAt < 4000) { renderAll(); return Promise.resolve(S); }
    S.busy = api('/api/attendance/regularization?email=' + encodeURIComponent(em))
      .then(function (d) {
        S.data = d || {}; S.fetchedAt = Date.now(); S.err = '';
        return (d && d.canReview)
          ? api('/api/attendance/regularization/queue' + (S.qAll ? '?status=all' : '')).catch(function () { return []; })
          : [];
      })
      .then(function (q) { S.queue = Array.isArray(q) ? q : []; })
      .catch(function (e) { S.err = (e && e.message) || 'Could not load your attendance requests.'; })
      .then(function () { S.busy = null; renderAll(); autoOpen(); emit('hrmsRegularizeChanged'); return S; });
    return S.busy;
  }

  /* ── panel ────────────────────────────────────────────────────────────── */
  function mount(el) {
    if (!el) return function () {};
    ensureStyle();
    for (var i = 0; i < S.mounts.length; i++) if (S.mounts[i] === el) { renderOne(el, true); return unmountFn(el); }
    el.classList.add('hrz');
    if (!el.__hrz) {
      el.__hrz = true;
      el.addEventListener('click', onPanelClick);
    }
    S.mounts.push(el);
    renderOne(el, true);
    load(false);
    return unmountFn(el);
  }
  function unmountFn(el) {
    return function () { S.mounts = S.mounts.filter(function (m) { return m !== el; }); };
  }
  function renderAll() {
    S.mounts = S.mounts.filter(function (el) { return document.documentElement.contains(el); });
    S.mounts.forEach(function (el) { renderOne(el, false); });
  }

  function quotaHtml() {
    var q = S.data && S.data.quota;
    if (!q || !q.limit) return '';
    var left = q.remaining == null ? q.limit : q.remaining;
    return '<span class="hrz-quota' + (left <= 0 ? ' out' : '') + '" title="Missed-punch requests filed for days of ' + esc(q.month) +
      ' (rejected ones do not count)">' + left + ' of ' + q.limit + ' left · ' + esc(q.month) + '</span>';
  }
  function issuesHtml() {
    var mine = issues(), block = !!(S.data && S.data.policy && S.data.policy.blockAfterDeadline);
    if (!mine.length) return '';
    return '<div class="hrz-sec"><div class="hrz-h">Needs your attention</div>' + mine.map(function (i, idx) {
      var left = secsLeft(i), over = left != null && left < 0;
      var act = i.pendingId ? pill('Pending')
        : (over && block ? '<span class="hrz-pill overdue">Deadline passed — contact HR</span>'
          : '<button type="button" class="hrz-btn" data-hrz="fix" data-date="' + esc(i.date) + '">Regularize</button>');
      return '<div class="hrz-row flag' + (over ? ' overdue' : '') + '"><div class="hrz-main">' +
        '<div class="hrz-what">' + esc(i.issueLabel || 'Missed punch') + ' · ' + esc(fmtDate(i.date)) + '</div>' +
        '<div class="hrz-msg2">' + esc(i.message || '') + '</div>' +
        '<div class="hrz-meta"><span class="hrz-due' + (over ? ' overdue' : '') + '" data-left="' + idx + '">' + esc(fmtLeft(left)) + '</span>' +
          (i.regularizeByLabel ? ' · regularize by ' + esc(i.regularizeByLabel) : '') + '</div>' +
        '</div><div class="hrz-acts">' + act + '</div></div>';
    }).join('') + '</div>';
  }
  function requestsHtml() {
    var rows = requests();
    var body;
    if (!rows.length) {
      body = '<div class="hrz-empty">No missed-punch requests yet. Use <b>Missed punch / Regularize</b> if you forgot to check in or out.</div>';
    } else {
      var shown = S.showAll ? rows : rows.slice(0, 4);
      body = shown.map(function (r) {
        var st = String(r.status || 'Pending').toLowerCase(), times = timesText(r);
        return '<div class="hrz-row ' + esc(st) + '"><div class="hrz-main">' +
          '<div class="hrz-what">' + esc(fmtDate(r.date)) + ' · ' + esc(kindText(r)) +
            (r.late ? ' <span class="hrz-pill late" title="Filed after the deadline">Filed late</span>' : '') + '</div>' +
          (times ? '<div class="hrz-msg2">Requested ' + esc(times) + '</div>' : '') +
          '<div class="hrz-meta">' + esc(reasonText(r) || '— no reason —') + '</div>' +
          ((r.reviewer || r.reviewerNote) ? '<div class="hrz-meta">' + (r.reviewer ? esc((r.status || '') + ' by ' + r.reviewer) : '') +
            (r.reviewerNote ? (r.reviewer ? ' — ' : '') + '“' + esc(r.reviewerNote) + '”' : '') + '</div>' : '') +
          '</div><div class="hrz-acts">' + pill(r.status) + '</div></div>';
      }).join('') + (rows.length > 4 ? '<button type="button" class="hrz-more" data-hrz="more">' +
        (S.showAll ? 'Show fewer' : 'Show all ' + rows.length) + '</button>' : '');
    }
    return '<div class="hrz-sec"><div class="hrz-h">My requests</div>' + body + '</div>';
  }
  function queueHtml() {
    if (!(S.data && S.data.canReview)) return '';
    var q = S.queue;
    var chips = '<span class="hrz-chips"><button type="button" class="hrz-chip' + (S.qAll ? '' : ' on') + '" data-hrz="qpend">Pending</button>' +
      '<button type="button" class="hrz-chip' + (S.qAll ? ' on' : '') + '" data-hrz="qall">All</button></span>';
    var body = q.length ? q.map(function (r) {
      var cur = [];
      if (r.currentCheckIn) cur.push('recorded in ' + t12(timeOf(r.currentCheckIn)));
      if (r.currentCheckOut) cur.push('out ' + t12(timeOf(r.currentCheckOut)));
      var pending = String(r.status || 'Pending') === 'Pending', times = timesText(r);
      var acts = pending
        ? '<input type="text" class="hrz-note" data-note="' + esc(r.id) + '" placeholder="Note (optional)" aria-label="Note for ' + esc(r.employee || r.email) + '">' +
          (r.hasProof ? '<button type="button" class="hrz-btn alt" data-hrz="proof" data-id="' + esc(r.id) + '">Proof</button>' : '') +
          '<button type="button" class="hrz-btn ok" data-hrz="approve" data-id="' + esc(r.id) + '">Approve</button>' +
          '<button type="button" class="hrz-btn no" data-hrz="reject" data-id="' + esc(r.id) + '">Reject</button>'
        : (r.hasProof ? '<button type="button" class="hrz-btn alt" data-hrz="proof" data-id="' + esc(r.id) + '">Proof</button>' : '') + pill(r.status);
      return '<div class="hrz-row queue"><div class="hrz-main">' +
        '<div class="hrz-what">' + esc(r.employee || r.email) + (r.late ? ' <span class="hrz-pill late">Filed late</span>' : '') + '</div>' +
        '<div class="hrz-msg2">' + esc(kindText(r)) + ' · ' + esc(fmtDate(r.date)) + (times ? ' · ' + esc(times) : '') + '</div>' +
        '<div class="hrz-meta">' + esc(reasonText(r) || '— no reason —') + (cur.length ? ' · ' + esc(cur.join(', ')) : '') + '</div>' +
        '</div><div class="hrz-acts">' + acts + '</div></div>';
    }).join('') : '<div class="hrz-empty">' + (S.qAll ? 'Nothing here yet.' : 'Nothing waiting for your approval.') + '</div>';
    return '<div class="hrz-sec" data-hrz-queue="1"><div class="hrz-h">' + (S.qAll ? 'Team requests' : 'Awaiting your approval') + chips + '</div>' + body + '</div>';
  }

  function renderOne(el, force) {
    var key = JSON.stringify([S.data && S.data.issues && S.data.issues.map(function (i) { return [i.id, i.issue, i.pendingId]; }),
      requests().map(function (r) { return [r.id, r.status, r.reviewerNote]; }), S.queue.map(function (r) { return [r.id, r.status]; }),
      S.data && S.data.quota, S.qAll, S.showAll, S.msg, S.err, !!S.data]);
    var focused = document.activeElement;
    if (!force && el.__key === key) { tick(el); return; }
    // Never wipe a note the reviewer is typing — re-render on their next action.
    if (!force && focused && el.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return;
    el.__key = key;
    var body = !S.data
      ? (S.err ? '<div class="hrz-empty">' + esc(S.err) + '</div>' : '<div class="hrz-empty">Loading…</div>')
      : issuesHtml() + requestsHtml() + queueHtml();
    el.innerHTML =
      '<div class="hrz-head"><div class="hrz-title">Missed punch / Regularize</div>' + quotaHtml() +
        '<button type="button" class="hrz-btn" data-hrz="new">+ Missed punch / Regularize</button></div>' +
      '<div class="hrz-sub">Forgot to check in or out, or left early? File it here with the times you actually worked — ' +
        'your manager approves and the day (worked hours, late, loss of pay) is recalculated.</div>' +
      body +
      '<div class="hrz-status ' + esc(S.msgKind) + '" role="status">' + esc(S.msg) + '</div>';
  }
  function tick(el) {
    var mine = issues();
    el.querySelectorAll('[data-left]').forEach(function (n) {
      var i = mine[+n.getAttribute('data-left')]; if (!i) return;
      var left = secsLeft(i);
      n.textContent = fmtLeft(left);
      n.className = 'hrz-due' + (left != null && left < 0 ? ' overdue' : '');
    });
  }
  function say(t, kind) { S.msg = t || ''; S.msgKind = kind || ''; renderAll(); }

  function onPanelClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-hrz]') : null;
    if (!b) return;
    var a = b.getAttribute('data-hrz'), id = b.getAttribute('data-id');
    if (a === 'new') open({});
    else if (a === 'fix') open({ date: b.getAttribute('data-date') });
    else if (a === 'more') { S.showAll = !S.showAll; renderAll(); }
    else if (a === 'qpend' || a === 'qall') { S.qAll = a === 'qall'; load(true); }
    else if (a === 'proof') viewProof(id);
    else if (a === 'approve' || a === 'reject') decide(id, a, b);
  }

  function decide(id, action, btn) {
    var panel = btn.closest('.hrz');
    var noteEl = panel && panel.querySelector('[data-note="' + id + '"]');
    var note = noteEl ? noteEl.value.trim() : '';
    var row = btn.closest('.hrz-row');
    if (row) row.querySelectorAll('button,input').forEach(function (x) { x.disabled = true; });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    post('/api/attendance/regularization/' + encodeURIComponent(id) + '/decide', { action: action, reviewerNote: note })
      .then(function (r) {
        say((r && r.message) || (action === 'approve' ? 'Approved.' : 'Rejected.'), 'ok');
        load(true);
        emit('hrmsAttendanceSynced');
      })
      .catch(function (err) {
        if (row) row.querySelectorAll('button,input').forEach(function (x) { x.disabled = false; });
        say((err && err.message) || 'Could not update the request.', 'err');
      });
  }

  function viewProof(id) {
    ensureStyle();
    api('/api/attendance/punch-ticket/' + encodeURIComponent(id) + '/proof').then(function (d) {
      var v = document.createElement('div');
      v.id = BACK + '-proof'; v.className = 'hrz-proofback';
      v.setAttribute('style', 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;');
      var src = (d && d.proofImage) || '';
      v.innerHTML = '<div style="background:var(--bg2,#fff);color:var(--text);border:1px solid var(--border2);border-radius:14px;padding:16px;max-width:640px;width:100%;">' +
        '<div style="display:flex;align-items:center;margin-bottom:10px"><b style="margin-right:auto">Proof</b><button type="button" data-x="1" style="border:none;background:transparent;color:var(--text2);font-size:22px;cursor:pointer">&times;</button></div>' +
        (/^data:image\//.test(src) ? '<img alt="Proof" style="width:100%;border-radius:10px;border:1px solid var(--border2)" src="' + esc(src) + '">' : '<div style="color:var(--text2)">No proof attached.</div>') + '</div>';
      v.addEventListener('click', function (e) { if (e.target === v || (e.target.getAttribute && e.target.getAttribute('data-x'))) v.remove(); });
      document.body.appendChild(v);
    }).catch(function (err) { say((err && err.message) || 'Could not load the proof.', 'err'); });
  }

  /* ── the one form ─────────────────────────────────────────────────────── */
  function close() { var b = document.getElementById(BACK); if (b && b.parentNode) b.parentNode.removeChild(b); }

  function open(opts) {
    opts = opts || {};
    if (!me()) { if (window.alert) window.alert('Please sign in first.'); return; }
    ensureStyle();
    var go = function () { buildForm(opts); };
    if (S.data) go(); else load(true).then(go);
  }

  function minDate() {
    var back = (S.data && S.data.policy && S.data.policy.maxDaysBack) || 31;
    var d = new Date(todayIso() + 'T00:00:00'); d.setDate(d.getDate() - back);
    return isoOf(d);
  }

  function buildForm(opts) {
    close();
    S.proof = '';
    var flagged = issues().filter(function (i) { return !i.pendingId; });
    var date = opts.date || (flagged[0] && flagged[0].date) || '';
    var back = document.createElement('div');
    back.id = BACK;
    var q = S.data && S.data.quota;
    back.innerHTML =
      '<div class="hrz-modal" role="dialog" aria-modal="true" aria-labelledby="hrz-mt">' +
        '<div class="hrz-mhead"><div class="hrz-mtitle" id="hrz-mt">Missed punch / Regularize</div>' +
          '<button type="button" class="hrz-x" data-x="1" aria-label="Close">&times;</button></div>' +
        (flagged.length ? '<div class="hrz-days" aria-label="Days that need attention">' + flagged.map(function (i) {
          return '<button type="button" class="hrz-day" data-day="' + esc(i.date) + '">' + esc(fmtDate(i.date)) + ' · ' + esc(i.issueLabel || 'Missed punch') + '</button>';
        }).join('') + '</div>' : '') +
        '<div class="hrz-f"><label for="hrz-date">Date <span class="hrz-req">*</span></label>' +
          '<input type="date" id="hrz-date" class="hrz-in" min="' + esc(minDate()) + '" max="' + esc(todayIso()) + '" value="' + esc(date) + '"></div>' +
        '<div class="hrz-info" id="hrz-info">Pick the day to correct.</div>' +
        '<div class="hrz-grid">' +
          '<div class="hrz-f"><label for="hrz-in">Check-in <span class="hrz-cur" id="hrz-cin"></span></label><input type="time" id="hrz-in" class="hrz-in"></div>' +
          '<div class="hrz-f"><label for="hrz-out">Check-out <span class="hrz-cur" id="hrz-cout"></span></label><input type="time" id="hrz-out" class="hrz-in"></div>' +
        '</div>' +
        '<div class="hrz-f"><label for="hrz-code">Reason <span class="hrz-req">*</span></label><select id="hrz-code" class="hrz-in">' +
          '<option value="">Choose a reason…</option>' + REASONS.map(function (r) { return '<option value="' + r[0] + '">' + esc(r[1]) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="hrz-f"><label for="hrz-reason">Note <span class="hrz-cur">(required for “Other”)</span></label>' +
          '<textarea id="hrz-reason" class="hrz-in" placeholder="What happened? Your manager sees this."></textarea></div>' +
        '<div class="hrz-f"><label for="hrz-file">Proof <span class="hrz-cur">(optional photo, e.g. the attendance sheet)</span></label>' +
          '<input type="file" accept="image/*" id="hrz-file" class="hrz-in"><div id="hrz-preview" class="hrz-preview"></div></div>' +
        (q && q.limit ? '<div class="hrz-cur" style="font-size:11.5px;color:var(--text2)">' + (q.remaining == null ? q.limit : q.remaining) + ' of ' + q.limit +
          ' requests left for ' + esc(q.month) + ' (the limit counts days of the same month).</div>' : '') +
        '<div class="hrz-status" id="hrz-fmsg" role="alert"></div>' +
        '<div class="hrz-mf"><button type="button" class="hrz-btn alt" data-x="1">Cancel</button>' +
          '<button type="button" class="hrz-btn" id="hrz-send">Send for approval</button></div>' +
      '</div>';
    back.addEventListener('click', function (e) {
      if (e.target === back || (e.target.closest && e.target.closest('[data-x]'))) { close(); return; }
      var d = e.target.closest && e.target.closest('[data-day]');
      if (d) { back.querySelector('#hrz-date').value = d.getAttribute('data-day'); onDate(back); }
    });
    back.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.body.appendChild(back);
    back.querySelector('#hrz-date').addEventListener('change', function () { onDate(back); });
    back.querySelector('#hrz-file').addEventListener('change', onFile);
    back.querySelector('#hrz-send').onclick = function () { submit(back); };
    onDate(back);
    var f = back.querySelector(date ? '#hrz-code' : '#hrz-date'); try { f.focus(); } catch (_) {}
  }

  /* What we know about the chosen day: a flagged issue (from the panel's
     data), a pending request, else the recorded punches (one lookup). */
  function onDate(back) {
    var date = back.querySelector('#hrz-date').value;
    var info = back.querySelector('#hrz-info'), send = back.querySelector('#hrz-send');
    var inEl = back.querySelector('#hrz-in'), outEl = back.querySelector('#hrz-out');
    back.querySelectorAll('[data-day]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-day') === date); });
    back.__ctx = { date: date, issue: null, recIn: '', recOut: '', open: false };
    send.disabled = false;
    if (!date) { info.className = 'hrz-info'; info.textContent = 'Pick the day to correct.'; return; }
    if (date > todayIso()) { info.className = 'hrz-info bad'; info.textContent = 'That date is in the future.'; send.disabled = true; return; }
    var pend = null;
    requests().forEach(function (r) { if (r.date === date && String(r.status || 'Pending') === 'Pending') pend = r; });
    if (pend) {
      info.className = 'hrz-info warn';
      info.textContent = 'You already have a pending request for ' + fmtDate(date) + ' — wait for it to be reviewed.';
      send.disabled = true;
    }
    var issue = null;
    issues().forEach(function (i) { if (i.date === date) issue = i; });
    var apply = function (cin, cout, open, text, cls) {
      var ctx = back.__ctx; if (ctx.date !== date) return;
      ctx.issue = issue; ctx.recIn = cin; ctx.recOut = open ? '' : cout; ctx.open = open;
      inEl.value = cin; outEl.value = open ? '' : cout;
      back.querySelector('#hrz-cin').textContent = cin ? '(recorded ' + t12(cin) + ')' : (issue && issue.issue === 'missing_checkin' ? '— required' : '');
      back.querySelector('#hrz-cout').textContent = cout && !open ? '(recorded ' + t12(cout) + ')' : (open ? '— required' : '');
      if (!pend) { info.className = 'hrz-info ' + (cls || ''); info.textContent = text; }
    };
    if (issue) {
      var left = secsLeft(issue);
      apply(timeOf(issue.checkIn), timeOf(issue.checkOut), issue.issue === 'missing_checkout',
        (issue.message || '') + ' ' + fmtLeft(left) + (issue.regularizeByLabel ? ' (by ' + issue.regularizeByLabel + ')' : '') + '.',
        left != null && left < 0 ? 'bad' : 'warn');
      return;
    }
    info.className = 'hrz-info'; if (!pend) info.textContent = 'Looking up ' + fmtDate(date) + '…';
    api('/api/attendance?email=' + encodeURIComponent(me()) + '&date=' + encodeURIComponent(date))
      .then(function (rows) {
        var a = Array.isArray(rows) && rows.length ? rows[0] : null;
        var cin = a ? timeOf(a.checkIn) : '', cout = a ? timeOf(a.checkOut) : '';
        var open = !!(cin && !cout);
        var txt = !a || (!cin && !cout) ? 'No punches recorded on ' + fmtDate(date) + ' — enter both times.'
          : 'Recorded on ' + fmtDate(date) + ': in ' + (cin ? t12(cin) : '—') + ', out ' + (cout ? t12(cout) : '—') +
            '. Change what was wrong; your manager sees both.';
        apply(cin, cout, open, txt, '');
      })
      .catch(function () { apply('', '', false, 'Could not look the day up — enter the times you worked.', ''); });
  }

  function onFile(e) {
    var f = e.target.files && e.target.files[0]; if (!f) { S.proof = ''; return; }
    var prev = document.getElementById('hrz-preview');
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      var show = function () { if (prev) prev.innerHTML = '<img src="' + esc(S.proof) + '" alt="Proof preview">'; };
      img.onload = function () {
        var max = 1400, w = img.width, h = img.height;
        if (w > max || h > max) { var sc = Math.min(max / w, max / h); w = Math.round(w * sc); h = Math.round(h * sc); }
        try {
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          S.proof = cv.toDataURL('image/jpeg', 0.72);
        } catch (_) { S.proof = String(reader.result || ''); }
        show();
      };
      img.onerror = function () { S.proof = String(reader.result || ''); show(); };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  }

  function submit(back) {
    var ctx = back.__ctx || {}, msg = back.querySelector('#hrz-fmsg'), send = back.querySelector('#hrz-send');
    var set = function (t) { msg.textContent = t; msg.className = 'hrz-status err'; };
    var date = back.querySelector('#hrz-date').value;
    var inV = back.querySelector('#hrz-in').value, outV = back.querySelector('#hrz-out').value;
    var code = back.querySelector('#hrz-code').value, reason = back.querySelector('#hrz-reason').value.trim();
    msg.textContent = '';
    if (!date) return set('Pick the date to correct.');
    if (date > todayIso()) return set('That date is in the future.');
    if (date < minDate()) return set('Days older than ' + ((S.data && S.data.policy && S.data.policy.maxDaysBack) || 31) + ' days cannot be corrected here — ask HR.');
    var body = { email: me(), date: date, reasonCode: code, reason: reason };
    if (inV && inV !== ctx.recIn) body.checkIn = inV;
    if (outV && (ctx.open || outV !== ctx.recOut)) body.checkOut = outV;
    if (ctx.issue && ctx.issue.issue === 'missing_checkin' && !inV) return set('Enter your check-in time.');
    if (ctx.open && !outV) return set('Enter your check-out time.');
    if (!body.checkIn && !body.checkOut) return set('Enter the check-in and/or check-out time you actually worked.');
    if (!code) return set('Choose a reason.');
    if (code === 'other' && !reason) return set('Describe the reason.');
    if (S.proof) body.proofImage = S.proof;
    send.disabled = true; send.textContent = 'Sending…';
    post('/api/attendance/regularization', body)
      .then(function (r) {
        close();
        say('Sent for approval' + (r && r.late ? ' — filed after the deadline, HR has been told.' : '.'), 'ok');
        load(true);
        emit('hrmsAttendanceSynced');
      })
      .catch(function (err) {
        send.disabled = false; send.textContent = 'Send for approval';
        set((err && err.message) || 'Could not send the request.');
      });
  }

  /* Notification links: ?regularize=YYYY-MM-DD opens that day's form once;
     ?regularizations=1 / ?regularize-overdue= scroll the panel into view. */
  function autoOpen() {
    if (S.autoDone || !S.mounts.length) return;
    var m = /[?&]regularize=(\d{4}-\d{2}-\d{2})/.exec(location.search);
    if (m) { S.autoDone = true; open({ date: m[1] }); return; }
    if (/[?&](regularizations?|regularize-overdue)=/.test(location.search)) {
      S.autoDone = true;
      var q = S.mounts[0].querySelector('[data-hrz-queue]') || S.mounts[0];
      if (q.scrollIntoView) q.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  /* Countdowns every 30 s; data every minute while a panel is on screen. */
  setInterval(function () { S.mounts.forEach(function (el) { if (document.documentElement.contains(el)) tick(el); }); }, 30000);
  setInterval(function () { if (!document.hidden && S.mounts.some(function (el) { return document.documentElement.contains(el); })) load(true); }, 60000);
  window.addEventListener('focus', function () { if (S.mounts.length) load(false); });
  window.addEventListener('popstate', function () { S.autoDone = false; });

  window.HRMSRegularize = { mount: mount, open: open, load: load, close: close, viewProof: viewProof, state: function () { return S; } };
  try { window.dispatchEvent(new CustomEvent('hrmsRegularizeReady')); } catch (_) {}
})();
