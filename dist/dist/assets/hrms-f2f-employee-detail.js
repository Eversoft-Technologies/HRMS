/**
 * hrms-f2f-employee-detail.js
 * ---------------------------------------------------------------------------
 * Recruit > F2F Interview > Schedule & Links (/recruit/interview).
 * Clicking a candidate row in "All Interview Links" opens an employee-detail
 * popup: a summary strip (attendance %, tasks completed, today's check-in/out)
 * and a tabbed set of employee modules.
 *
 * Pass 1 (this file): the shell, summary strip, and the Attendance + Check In /
 * Out tabs, driven entirely by existing APIs
 *   - GET /api/attendance/summary/?email=&fromDate=&toDate=
 *   - GET /api/attendance/day-detail?email=
 *   - GET /api/tasks?assigneeEmail=
 * Task Tracker / Work Submissions / Leave tabs are stubbed and wired in later
 * passes; live updates move to a WebSocket channel with the Task Tracker pass.
 * No bundle rebuild - same injection pattern as hrms-interviews.js.
 */
(function () {
  'use strict';

  var IV_PATH = '/recruit/interview';
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var state = { email: '', tab: 'attendance', timer: null, day: null, attRange: '30', attFrom: '', attTo: '', cioDate: '', taskStage: 'all', taskPriority: 'all', subStatus: 'all', leaveStatus: 'all', leaveRange: 'all', leaveFrom: '', leaveTo: '' };
  var PIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>';
  var PIN_BIG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="#e11d48" stroke="#fff" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="#fff"></circle></svg>';

  function onPage() { return location.pathname.replace(/\/+$/, '') === IV_PATH; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(p) {
    return fetch(p, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) throw new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function initials(n) { var s = String(n || '').trim(); if (!s) return '?'; var p = s.split(/[\s._-]+/).filter(Boolean); return ((p[0] || '')[0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : ''); }
  function fmtMins(m) { m = Math.max(0, m || 0); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  var AVCOL = ['#4f8ef7', '#7c5cfc', '#22d3a5', '#f7954f', '#f75f4f', '#06b6d4', '#8b5cf6', '#f7c94f'];
  function avColor(k) { var t = String(k || ''), h = 0; for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return AVCOL[h % AVCOL.length]; }

  var TABS = [
    { id: 'attendance', label: 'Attendance' },
    { id: 'checkinout', label: 'Check In / Out' },
    { id: 'tasks', label: 'Task Tracker' },
    { id: 'submissions', label: 'Work Submissions' },
    { id: 'leave', label: 'Leave' }
  ];

  /* ---- styles ---- */
  function ensureStyle() {
    if (document.getElementById('fed-style')) return;
    var css = [
      '.fed-back{position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.55);display:flex;align-items:flex-start;justify-content:center;padding:28px 14px;overflow:auto;}',
      '.fed-modal{background:var(--surface,#fff);color:var(--text,#0f172a);border:1px solid var(--border2,#e5e7eb);border-radius:16px;width:min(720px,96vw);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(2,6,23,.35);font-family:var(--font,Arial,Helvetica,sans-serif);}',
      '.fed-head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.fed-av{width:44px;height:44px;border-radius:50%;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.fed-hi{flex:1;min-width:0;}',
      '.fed-name{font-size:16px;font-weight:800;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.fed-email{font-size:12px;color:var(--text3,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.fed-x{width:34px;height:34px;border-radius:9px;border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f1f5f9);color:var(--text2,#475569);cursor:pointer;font-size:18px;flex-shrink:0;line-height:1;}',
      '.fed-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px 18px;}',
      '.fed-tile{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.fed-tl{font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3,#64748b);}',
      '.fed-tv{font-size:20px;font-weight:800;color:var(--text,#0f172a);margin-top:3px;line-height:1.15;}',
      '.fed-tv small{font-size:12px;font-weight:600;color:var(--text3,#64748b);}',
      '.fed-tabs{display:flex;gap:6px;padding:4px;margin:0 18px;background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;overflow-x:auto;}',
      '.fed-tab{flex:0 0 auto;border:none;background:transparent;color:var(--text2,#475569);font:inherit;font-size:12.5px;font-weight:700;padding:8px 14px;border-radius:9px;cursor:pointer;white-space:nowrap;}',
      '.fed-tab.on{background:var(--accent,#4f8ef7);color:#fff;}',
      '.fed-body{flex:1;overflow-y:auto;padding:16px 18px 20px;}',
      '.fed-pctwrap{display:flex;align-items:center;gap:16px;margin-bottom:14px;}',
      '.fed-ring{width:92px;height:92px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;position:relative;}',
      '.fed-ring span{font-size:22px;font-weight:800;color:var(--text,#0f172a);}',
      '.fed-ringlbl{font-size:12px;color:var(--text3,#64748b);}',
      '.fed-break{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:6px 0 4px;}',
      '.fed-bk{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:10px 8px;text-align:center;}',
      '.fed-bk b{display:block;font-size:18px;font-weight:800;color:var(--text,#0f172a);}',
      '.fed-bk small{font-size:10.5px;color:var(--text3,#64748b);text-transform:uppercase;letter-spacing:.3px;}',
      '.fed-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}',
      '.fed-cl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);}',
      '.fed-cv{font-size:17px;font-weight:800;color:var(--text,#0f172a);margin-top:2px;}',
      '.fed-hrs{display:flex;gap:18px;font-size:12.5px;color:var(--text3,#64748b);margin-bottom:12px;}',
      '.fed-hrs b{color:var(--text,#0f172a);}',
      '.fed-pill{display:inline-block;font-size:10.5px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:capitalize;}',
      '.fed-pill.present,.fed-pill.online{background:rgba(34,197,94,.16);color:#16a34a;}',
      '.fed-pill.late{background:rgba(247,201,79,.18);color:#b7791f;}',
      '.fed-pill.absent,.fed-pill.offline{background:rgba(247,95,79,.16);color:#dc2626;}',
      '.fed-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);margin:14px 0 8px;display:flex;align-items:center;gap:8px;}',
      '.fed-live{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#16a34a;text-transform:none;letter-spacing:0;}',
      '.fed-live i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:fed-pulse 1.6s infinite;}',
      '@keyframes fed-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5);}70%{box-shadow:0 0 0 7px rgba(34,197,94,0);}100%{box-shadow:0 0 0 0 rgba(34,197,94,0);}}',
      '.fed-log{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:8px 2px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.fed-log:last-child{border-bottom:none;}',
      '.fed-lt{font-weight:700;color:var(--text,#0f172a);white-space:nowrap;}',
      '.fed-le{color:var(--text2,#475569);}',
      '.fed-ll{color:var(--text3,#64748b);font-size:11px;text-align:right;}',
      '.fed-empty{color:var(--text3,#64748b);font-size:12.5px;text-align:center;padding:20px 8px;}',
      '.fed-stub{color:var(--text3,#64748b);font-size:13px;text-align:center;padding:34px 12px;line-height:1.6;}',
      '.fed-loading{color:var(--text3,#64748b);font-size:13px;text-align:center;padding:30px;}',
      '.fed-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}',
      '.fed-filter{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:8px;color:var(--text,#0f172a);font:inherit;font-size:12px;font-weight:600;padding:6px 9px;cursor:pointer;}',
      '.fed-filter:focus{border-color:var(--accent,#4f8ef7);outline:none;}',
      '.fed-punch{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:8px 2px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.fed-pt{font-weight:700;color:var(--text,#0f172a);white-space:nowrap;}',
      '.fed-pl{color:var(--text3,#64748b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.fed-pin{background:none;border:none;cursor:pointer;color:var(--accent,#4f8ef7);padding:4px;display:inline-flex;}',
      '.fed-pin:hover{opacity:.65;}',
      '.fed-mapmodal{max-width:520px;}',
      '.fed-map{position:relative;height:260px;border-radius:10px;overflow:hidden;border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f1f5f9);}',
      '.fed-mkr{position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));}',
      '.fed-coord{font-size:11px;color:var(--text3,#64748b);margin:8px 0;text-align:center;}',
      '.fed-mapmf{display:flex;justify-content:flex-end;gap:10px;}',
      '.fed-mapmf button,.fed-mapmf a{border:none;border-radius:9px;font:inherit;font-size:13px;font-weight:700;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block;}',
      '.fed-mapmf .cx{background:var(--bg3,#f1f5f9);color:var(--text,#0f172a);border:1px solid var(--border2,#e5e7eb);}',
      '.fed-mapmf .ok{background:var(--accent,#4f8ef7);color:#fff;}',
      '.fed-pipe{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;align-items:start;}',
      '.fed-col{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:8px;}',
      '.fed-colh{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:2px 4px;}',
      '.fed-colh span{background:var(--surface,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:999px;padding:0 7px;font-size:10.5px;color:var(--text2,#475569);}',
      '.fed-card{background:var(--surface,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:9px 10px;margin-bottom:8px;}',
      '.fed-ct{font-size:12.5px;font-weight:700;color:var(--text,#0f172a);line-height:1.3;}',
      '.fed-cmeta{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap;}',
      '.fed-prio{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:999px;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.fed-prio.high{background:rgba(247,95,79,.16);color:#dc2626;}',
      '.fed-prio.medium{background:rgba(247,201,79,.18);color:#b7791f;}',
      '.fed-prio.low{background:rgba(34,197,94,.16);color:#16a34a;}',
      '.fed-rej{font-size:9.5px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(247,95,79,.16);color:#dc2626;}',
      '.fed-bar{height:6px;border-radius:999px;background:var(--bg3,#e5e7eb);overflow:hidden;}',
      '.fed-bar i{display:block;height:100%;background:var(--accent,#4f8ef7);}',
      '.fed-cprog{font-size:10px;color:var(--text3,#64748b);margin-top:3px;text-align:right;}',
      '.fed-colempty{color:var(--text3,#94a3b8);font-size:11px;text-align:center;padding:8px;}',
      '.fed-subs{display:flex;flex-direction:column;gap:10px;}',
      '.fed-sub{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.fed-subtop{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.fed-subt{font-size:13px;font-weight:700;color:var(--text,#0f172a);}',
      '.fed-submeta{font-size:11.5px;color:var(--text3,#64748b);margin-top:4px;}',
      '.fed-score{font-weight:700;color:var(--accent,#4f8ef7);}',
      '.fed-snote{font-size:12px;color:var(--text2,#475569);margin-top:8px;background:var(--surface,#fff);border:1px solid var(--border2,#e5e7eb);border-left:3px solid var(--accent,#4f8ef7);border-radius:8px;padding:8px 10px;}',
      '.fed-pill2{flex-shrink:0;font-size:10px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:capitalize;white-space:nowrap;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.fed-pill2.pending{background:rgba(247,201,79,.18);color:#b7791f;}',
      '.fed-pill2.inreview{background:rgba(79,142,247,.16);color:#2563eb;}',
      '.fed-pill2.approved{background:rgba(34,197,94,.16);color:#16a34a;}',
      '.fed-pill2.rejected{background:rgba(247,95,79,.16);color:#dc2626;}',
      '@media(max-width:600px){',
      '  .fed-back{padding:0;align-items:stretch;}',
      '  .fed-modal{width:100vw;max-height:100vh;height:100vh;border-radius:0;}',
      '  .fed-strip{grid-template-columns:1fr;gap:8px;}',
      '  .fed-break{grid-template-columns:1fr 1fr;}',
      '  .fed-pipe{grid-template-columns:1fr;}',
      '}'
    ].join('');
    var el = document.createElement('style'); el.id = 'fed-style'; el.textContent = css; document.head.appendChild(el);
  }

  /* ---- open / close ---- */
  function close() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.ws) { try { state.ws.close(); } catch (_) {} state.ws = null; }
    var b = document.getElementById('fed-back'); if (b && b.parentNode) b.parentNode.removeChild(b);
    state.email = ''; state.day = null; state.tasks = null; state.subs = null; state.leave = null; state.punches = null;
  }
  function open(email, name) {
    ensureStyle();
    close();
    name = (name || '').trim() || email.split('@')[0];
    state.email = email; state.name = name; state.tab = 'attendance';
    var back = document.createElement('div'); back.id = 'fed-back'; back.className = 'fed-back';
    back.innerHTML =
      '<div class="fed-modal">' +
        '<div class="fed-head">' +
          '<span class="fed-av" style="background:' + avColor(name) + '">' + esc(initials(name)) + '</span>' +
          '<div class="fed-hi"><div class="fed-name" id="fed-name">' + esc(name) + '</div>' +
            '<div class="fed-email">' + esc(email) + '</div></div>' +
          '<button class="fed-x" id="fed-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="fed-strip" id="fed-strip">' +
          tileHtml('Attendance', '<span id="fed-s-att">...</span>') +
          tileHtml('Tasks completed', '<span id="fed-s-task">...</span>') +
          tileHtml('Today', '<span id="fed-s-cio">...</span>') +
        '</div>' +
        '<div class="fed-tabs" id="fed-tabs">' + TABS.map(function (t) {
          return '<button class="fed-tab' + (t.id === state.tab ? ' on' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>';
        }).join('') + '</div>' +
        '<div class="fed-body" id="fed-body"><div class="fed-loading">Loading...</div></div>' +
      '</div>';
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    back.querySelector('#fed-x').onclick = close;
    back.querySelector('#fed-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]'); if (!b) return;
      selectTab(b.getAttribute('data-tab'));
    });
    document.addEventListener('keydown', escClose);
    loadSummary();
    renderTab();
    openSocket(state.email);
  }
  function escClose(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escClose); } }
  function tileHtml(label, val) { return '<div class="fed-tile"><div class="fed-tl">' + esc(label) + '</div><div class="fed-tv">' + val + '</div></div>'; }

  /* ---- summary strip ---- */
  function attendancePct(sum) {
    if (!sum) return null;
    var denom = (sum.present || 0) + (sum.late || 0) + (sum.absent || 0) + (sum.half_day || 0);
    if (!denom) return null;
    var got = (sum.present || 0) + (sum.late || 0) + 0.5 * (sum.half_day || 0);
    return Math.round(got / denom * 100);
  }
  function loadSummary() {
    var email = state.email;
    var r0 = rangeFor('30');
    // attendance % (strip = 30-day snapshot; the tab has its own range filter)
    api('/api/attendance/summary/?email=' + encodeURIComponent(email) + '&fromDate=' + r0.from + '&toDate=' + r0.to)
      .then(function (sum) {
        var pct = attendancePct(sum);
        setText('fed-s-att', pct == null ? '--' : pct + '<small>%</small>');
      }).catch(function () { setText('fed-s-att', '--'); });
    // tasks completed
    loadTasks();
    // today check-in/out
    loadDay(true);
  }
  function loadDay(updateStrip) {
    var email = state.email, d0 = cioDateVal();
    return api('/api/attendance/day-detail?email=' + encodeURIComponent(email) + '&date=' + d0).then(function (d) {
      state.day = d;
      if (d && d.employee && (!state.name || state.name === email.split('@')[0])) {
        state.name = d.employee;
        var nm = document.getElementById('fed-name'); if (nm) nm.textContent = d.employee;
      }
      if (d0 === todayIso()) {   // the "Today" strip tile always shows today
        var inout = (d.checkIn || '--') + ' / ' + (d.checkOut || '--');
        setText('fed-s-cio', '<span style="font-size:14px">' + esc(inout) + '</span>');
      }
      if (state.tab === 'checkinout') renderCheckin();
      return d;
    }).catch(function () { if (updateStrip) setText('fed-s-cio', '--'); });
  }
  function setText(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
  function filterBar(inner) { return '<div class="fed-filters">' + inner + '</div>'; }
  function selOpts(id, val, opts) { return '<select class="fed-filter" id="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }
  function todayIso() { return isoDate(new Date()); }
  function cioDateVal() { return state.cioDate || todayIso(); }
  function rangeFor(key, cfrom, cto) {
    if (key === 'custom') { return { from: cfrom || isoDate(new Date()), to: cto || todayIso() }; }
    var to = new Date(), from = new Date();
    if (key === 'month') { from = new Date(to.getFullYear(), to.getMonth(), 1); }
    else { var n = ({ '7': 7, '30': 30, '60': 60, '90': 90 })[key] || parseInt(key, 10) || 30; from.setDate(from.getDate() - (n - 1)); }
    return { from: isoDate(from), to: isoDate(to) };
  }
  // Range dropdown + (when Custom) two date inputs. prefix is used for the ids:
  // <prefix>-range, <prefix>-from, <prefix>-to. withAll adds an 'All time' option.
  function rangeControls(prefix, val, cfrom, cto, withAll) {
    var opts = [];
    if (withAll) opts.push(['all', 'All time']);
    opts.push(['7', 'Last 7 days'], ['30', 'Last 30 days'], ['60', 'Last 2 months'], ['90', 'Last 3 months'], ['custom', 'Custom']);
    var html = selOpts(prefix + '-range', val, opts);
    if (val === 'custom') {
      html += '<input type="date" class="fed-filter" id="' + prefix + '-from" value="' + esc(cfrom || '') + '" max="' + todayIso() + '">' +
              '<input type="date" class="fed-filter" id="' + prefix + '-to" value="' + esc(cto || todayIso()) + '" max="' + todayIso() + '">';
    }
    return html;
  }

  /* ---- tabs ---- */
  function selectTab(id) {
    state.tab = id;
    var tabs = document.getElementById('fed-tabs');
    if (tabs) tabs.querySelectorAll('.fed-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === id); });
    renderTab();
  }
  function renderTab() {
    if (state.tab === 'attendance') return renderAttendance();
    if (state.tab === 'checkinout') return renderCheckin();
    if (state.tab === 'tasks') return renderTasks();
    if (state.tab === 'submissions') return renderSubmissions();
    if (state.tab === 'leave') return renderLeave();
    return renderStub();
  }
  function renderStub() {
    var body = document.getElementById('fed-body'); if (!body) return;
    var name = (TABS.filter(function (t) { return t.id === state.tab; })[0] || {}).label || '';
    body.innerHTML = '<div class="fed-stub"><b>' + esc(name) + '</b><br>This module is being added to the employee popup next.</div>';
  }
  var ATT_LBL = { '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 2 months', '90': 'Last 3 months', 'month': 'This month' };
  function loadAttendance() {
    var r = rangeFor(state.attRange || '30', state.attFrom, state.attTo);
    return api('/api/attendance/summary/?email=' + encodeURIComponent(state.email) + '&fromDate=' + r.from + '&toDate=' + r.to)
      .then(function (sum) { state.attSummary = sum; if (state.tab === 'attendance') renderAttendance(); })
      .catch(function () { state.attSummary = {}; if (state.tab === 'attendance') renderAttendance(); });
  }
  function wireAtt() {
    var r = document.getElementById('fed-att-range');
    if (r) r.onchange = function () { state.attRange = r.value; state.attSummary = null; renderAttendance(); };
    var f = document.getElementById('fed-att-from'); if (f) f.onchange = function () { state.attFrom = f.value; state.attSummary = null; renderAttendance(); };
    var t = document.getElementById('fed-att-to'); if (t) t.onchange = function () { state.attTo = t.value; state.attSummary = null; renderAttendance(); };
  }
  function renderAttendance() {
    var body = document.getElementById('fed-body'); if (!body) return;
    var bar = filterBar(rangeControls('fed-att', state.attRange || '30', state.attFrom, state.attTo, false));
    var sum = state.attSummary;
    if (!sum) { body.innerHTML = bar + '<div class="fed-loading">Loading attendance...</div>'; wireAtt(); loadAttendance(); return; }
    var pct = attendancePct(sum);
    var deg = pct == null ? 0 : Math.round(pct * 3.6);
    var ring = 'background:conic-gradient(var(--accent,#4f8ef7) ' + deg + 'deg, var(--bg3,#e5e7eb) 0deg);';
    body.innerHTML = bar +
      '<div class="fed-pctwrap">' +
        '<div class="fed-ring" style="' + ring + '"><div style="width:70px;height:70px;border-radius:50%;background:var(--surface,#fff);display:flex;align-items:center;justify-content:center;"><span>' + (pct == null ? '--' : pct + '%') + '</span></div></div>' +
        '<div><div class="fed-cv">' + (pct == null ? 'No records' : 'Attendance') + '</div>' +
          '<div class="fed-ringlbl">' + esc(state.attRange === 'custom' ? ((state.attFrom || '?') + ' to ' + (state.attTo || todayIso())) : (ATT_LBL[state.attRange || '30'] || '')) + '</div></div>' +
      '</div>' +
      '<div class="fed-break">' +
        bk(sum.present || 0, 'Present') + bk(sum.late || 0, 'Late') + bk(sum.absent || 0, 'Absent') + bk(sum.half_day || 0, 'Half-day') +
      '</div>' +
      '<div class="fed-hrs"><span>Worked <b>' + fmtMins(sum.total_worked_minutes) + '</b></span>' +
        '<span>Overtime <b>' + fmtMins(sum.total_overtime_minutes) + '</b></span></div>';
    wireAtt();
  }
  function bk(v, l) { return '<div class="fed-bk"><b>' + v + '</b><small>' + esc(l) + '</small></div>'; }

  function renderCheckin() {
    var body = document.getElementById('fed-body'); if (!body) return;
    var d = state.day;
    if (!d) { body.innerHTML = '<div class="fed-loading">Loading check-in...</div>'; loadDay(false); return; }
    var status = String(d.status || '').toLowerCase();
    var badge = d.onTime ? '<span class="fed-pill present">On time</span>' : (status ? '<span class="fed-pill ' + esc(status) + '">' + esc(d.status) + '</span>' : '');
    var logs = (d.events || []).filter(function (e) { return /check/.test(e.event || ''); }).map(function (e) {
      return '<div class="fed-log"><span class="fed-lt">' + esc(e.time || '') + '</span><span class="fed-le">' + esc(e.label || e.event || '') + '</span><span class="fed-ll">' + esc(e.location || '') + '</span></div>';
    }).join('') || '<div class="fed-empty">No check-in events today.</div>';
    var punches = state.punches;
    var punchHtml;
    if (punches == null) { punchHtml = '<div class="fed-empty">Loading location punches...</div>'; loadPunches(); }
    else if (!punches.length) { punchHtml = '<div class="fed-empty">No location punches recorded today.</div>'; }
    else {
      punchHtml = punches.map(function (p) {
        return '<div class="fed-punch"><span class="fed-pt">' + esc(p.time || '') + '</span>' +
          '<span class="fed-pl">' + esc(p.label || 'Location recorded') + '</span>' +
          '<button class="fed-pin" data-lat="' + esc(p.latitude) + '" data-lng="' + esc(p.longitude) + '" data-label="' + esc(p.label || '') + '" data-time="' + esc(p.time || '') + '" title="View location">' + PIN_SVG + '</button></div>';
      }).join('');
    }
    body.innerHTML =
      filterBar('<input type="date" id="fed-cio-date" class="fed-filter" value="' + cioDateVal() + '" max="' + todayIso() + '">') +
      '<div class="fed-two">' +
        '<div class="fed-tile"><div class="fed-cl">Check In</div><div class="fed-cv">' + esc(d.checkIn || '--') + '</div></div>' +
        '<div class="fed-tile"><div class="fed-cl">Check Out</div><div class="fed-cv">' + esc(d.checkOut || '--') + '</div></div>' +
      '</div>' +
      '<div class="fed-hrs"><span>Effective <b>' + fmtMins(d.effectiveMinutes) + '</b></span>' +
        '<span>Gross <b>' + fmtMins(d.grossMinutes) + '</b></span>' + (badge ? '<span>' + badge + '</span>' : '') + '</div>' +
      '<div class="fed-sec">Today\'s activity <span class="fed-live"><i></i>Live</span></div>' + logs +
      '<div class="fed-sec">Location punch (hourly)</div>' + punchHtml;
    body.querySelectorAll('.fed-pin').forEach(function (b) {
      b.onclick = function () { openLocationMap(parseFloat(b.getAttribute('data-lat')), parseFloat(b.getAttribute('data-lng')), b.getAttribute('data-label'), b.getAttribute('data-time')); };
    });
    var dp = document.getElementById('fed-cio-date');
    if (dp) dp.onchange = function () { state.cioDate = dp.value; state.day = null; state.punches = null; loadDay(false); loadPunches(); };
  }

  function loadPunches() {
    return api('/api/attendance/location-punch?email=' + encodeURIComponent(state.email) + '&date=' + cioDateVal()).then(function (rows) {
      state.punches = Array.isArray(rows) ? rows : [];
      if (state.tab === 'checkinout') renderCheckin();
    }).catch(function () { state.punches = state.punches || []; if (state.tab === 'checkinout') renderCheckin(); });
  }
  function tilePreview(lat, lng, W, H) {
    var z = 16, T = 256;
    function wx(l) { return (l + 180) / 360 * Math.pow(2, z) * T; }
    function wy(la) { var r = la * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * T; }
    var cx = wx(lng), cy = wy(lat), left = cx - W / 2, top = cy - H / 2, max = Math.pow(2, z);
    var x0 = Math.floor(left / T), x1 = Math.floor((left + W) / T), y0 = Math.floor(top / T), y1 = Math.floor((top + H) / T);
    var imgs = '';
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        var tx = ((x % max) + max) % max;
        imgs += '<img alt="" src="https://a.basemaps.cartocdn.com/rastertiles/voyager/' + z + '/' + tx + '/' + y + '.png" style="position:absolute;width:256px;height:256px;left:' + (x * T - left) + 'px;top:' + (y * T - top) + 'px;">';
      }
    }
    return '<div style="position:absolute;inset:0;overflow:hidden;">' + imgs + '</div><div class="fed-mkr">' + PIN_BIG + '</div>';
  }
  function openLocationMap(lat, lng, label, time) {
    if (!isFinite(lat) || !isFinite(lng)) { if (window.alert) window.alert('No coordinates for this punch.'); return; }
    ensureStyle();
    var gmap = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    var v = document.createElement('div'); v.className = 'fed-back'; v.style.zIndex = '100002';
    v.innerHTML = '<div class="fed-modal fed-mapmodal"><div class="fed-head"><div class="fed-hi"><div class="fed-name">Location</div>' +
      (label || time ? '<div class="fed-email">' + esc(label || '') + (label && time ? ' - ' : '') + esc(time || '') + '</div>' : '') + '</div>' +
      '<button class="fed-x" data-close="1" aria-label="Close">&times;</button></div>' +
      '<div style="padding:14px 18px 18px;"><div class="fed-map" id="fed-map"></div>' +
      '<div class="fed-coord">' + lat.toFixed(5) + ', ' + lng.toFixed(5) + '</div>' +
      '<div class="fed-mapmf"><button class="cx" data-close="1">Close</button>' +
      '<a class="ok" href="' + gmap + '" target="_blank" rel="noopener">Open in maps</a></div></div></div>';
    v.addEventListener('click', function (e) { if (e.target === v || (e.target.closest && e.target.closest('[data-close]'))) v.remove(); });
    document.body.appendChild(v);
    var el = v.querySelector('#fed-map');
    if (el) { var W = el.clientWidth || 460, H = el.clientHeight || 260; try { el.innerHTML = tilePreview(lat, lng, W, H); } catch (_) { el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3,#64748b)">Preview unavailable - use Open in maps.</div>'; } }
  }

  /* ---- Task Tracker tab ---- */
  function loadTasks() {
    return api('/api/tasks?assigneeEmail=' + encodeURIComponent(state.email)).then(function (rows) {
      state.tasks = Array.isArray(rows) ? rows : [];
      updateTaskCount();
      if (state.tab === 'tasks') renderTasks();
    }).catch(function () { state.tasks = state.tasks || []; });
  }
  function updateTaskCount() {
    var done = (state.tasks || []).filter(function (x) { return /done|complete/i.test(String(x.stage || x.status || '')); }).length;
    setText('fed-s-task', String(done));
  }
  function stageOf(t) { var st = String(t.stage || t.status || '').toLowerCase(); if (/done|complete/.test(st)) return 'done'; if (/review|qa/.test(st)) return 'review'; if (/progress|doing/.test(st)) return 'inprogress'; return 'todo'; }
  function renderTasks() {
    var body = document.getElementById('fed-body'); if (!body) return;
    if (!state.tasks) { body.innerHTML = '<div class="fed-loading">Loading tasks...</div>'; loadTasks(); return; }
    var bar = filterBar(
      selOpts('fed-task-stage', state.taskStage || 'all', [['all', 'All stages'], ['todo', 'To Do'], ['inprogress', 'In Progress'], ['review', 'Review'], ['done', 'Done']]) +
      selOpts('fed-task-prio', state.taskPriority || 'all', [['all', 'All priority'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]));
    var allRows = state.tasks;
    var rows = allRows.filter(function (t) { return !(state.taskPriority && state.taskPriority !== 'all') || String(t.priority || 'medium').toLowerCase() === state.taskPriority; });
    var html = '<div class="fed-sec">Task tracker <span class="fed-live"><i></i>Live</span></div>';
    if (!allRows.length) { body.innerHTML = bar + html + '<div class="fed-empty">No tasks assigned.</div>'; wireTaskFilters(); return; }
    var cols = [{ k: 'todo', l: 'To Do' }, { k: 'inprogress', l: 'In Progress' }, { k: 'review', l: 'Review' }, { k: 'done', l: 'Done' }].filter(function (c) { return !state.taskStage || state.taskStage === 'all' || state.taskStage === c.k; });
    html += '<div class="fed-pipe">';
    cols.forEach(function (c) {
      var items = rows.filter(function (t) { return stageOf(t) === c.k; });
      html += '<div class="fed-col"><div class="fed-colh">' + esc(c.l) + ' <span>' + items.length + '</span></div>';
      html += items.length ? items.map(function (t) {
        var pr = String(t.priority || 'medium').toLowerCase();
        var prog = Math.max(0, Math.min(100, t.progress || 0));
        var rej = (t.rejectReason || t.reject_reason) ? '<span class="fed-rej">Rejected</span>' : '';
        return '<div class="fed-card"><div class="fed-ct">' + esc(t.title || 'Untitled') + '</div>' +
          '<div class="fed-cmeta"><span class="fed-prio ' + esc(pr) + '">' + esc(pr) + '</span>' + rej + '</div>' +
          '<div class="fed-bar"><i style="width:' + prog + '%"></i></div>' +
          '<div class="fed-cprog">' + prog + '%</div></div>';
      }).join('') : '<div class="fed-colempty">-</div>';
      html += '</div>';
    });
    html += '</div>';
    body.innerHTML = bar + html;
    wireTaskFilters();
  }
  function wireTaskFilters() {
    var a = document.getElementById('fed-task-stage'); if (a) a.onchange = function () { state.taskStage = a.value; renderTasks(); };
    var b = document.getElementById('fed-task-prio'); if (b) b.onchange = function () { state.taskPriority = b.value; renderTasks(); };
  }

  /* ---- Work Submissions tab ---- */
  function loadSubmissions() {
    return api('/api/submissions?email=' + encodeURIComponent(state.email)).then(function (rows) {
      state.subs = Array.isArray(rows) ? rows : [];
      if (state.tab === 'submissions') renderSubmissions();
    }).catch(function () { state.subs = state.subs || []; if (state.tab === 'submissions') renderSubmissions(); });
  }
  function subCls(st) { return String(st || '').toLowerCase().replace(/\s+/g, ''); }
  function renderSubmissions() {
    var body = document.getElementById('fed-body'); if (!body) return;
    if (!state.subs) { body.innerHTML = '<div class="fed-loading">Loading submissions...</div>'; loadSubmissions(); return; }
    var bar = filterBar(selOpts('fed-sub-status', state.subStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['In Review', 'In Review'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]));
    var rows = (state.subs || []).filter(function (w) { return !state.subStatus || state.subStatus === 'all' || String(w.status || 'Pending') === state.subStatus; });
    var html = '<div class="fed-sec">Work submissions <span class="fed-live"><i></i>Live</span></div>';
    if (!rows.length) { body.innerHTML = bar + html + '<div class="fed-empty">No matching submissions.</div>'; wireSubFilter(); return; }
    html += '<div class="fed-subs">' + rows.map(function (w) {
      var st = w.status || 'Pending';
      var note = w.reviewerNote ? '<div class="fed-snote">' + esc(w.reviewerNote) + '</div>' : '';
      var score = w.aiScore ? '<span class="fed-score">AI ' + esc(w.aiScore) + '</span>' : '';
      return '<div class="fed-sub"><div class="fed-subtop"><div class="fed-subt">' + esc(w.title || 'Untitled') + '</div>' +
        '<span class="fed-pill2 ' + subCls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="fed-submeta">' + esc(w.type || 'Document') + (w.date ? ' &middot; ' + esc(w.date) : '') + (score ? ' &middot; ' + score : '') + '</div>' + note + '</div>';
    }).join('') + '</div>';
    body.innerHTML = bar + html;
    wireSubFilter();
  }
  function wireSubFilter() { var el = document.getElementById('fed-sub-status'); if (el) el.onchange = function () { state.subStatus = el.value; renderSubmissions(); }; }

  /* ---- Leave Management tab ---- */
  function loadLeave() {
    return api('/api/leave?email=' + encodeURIComponent(state.email)).then(function (rows) {
      state.leave = Array.isArray(rows) ? rows : [];
      if (state.tab === 'leave') renderLeave();
    }).catch(function () { state.leave = state.leave || []; if (state.tab === 'leave') renderLeave(); });
  }
  function renderLeave() {
    var body = document.getElementById('fed-body'); if (!body) return;
    if (!state.leave) { body.innerHTML = '<div class="fed-loading">Loading leave...</div>'; loadLeave(); return; }
    var bar = filterBar(
      selOpts('fed-leave-status', state.leaveStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]) +
      rangeControls('fed-leave', state.leaveRange || 'all', state.leaveFrom, state.leaveTo, true));
    var lrng = (state.leaveRange && state.leaveRange !== 'all') ? rangeFor(state.leaveRange, state.leaveFrom, state.leaveTo) : null;
    var rows = (state.leave || []).filter(function (l) {
      if (state.leaveStatus && state.leaveStatus !== 'all' && String(l.status || 'Pending') !== state.leaveStatus) return false;
      if (lrng) { var d = String(l.fromDate || ''); if (d && (d < lrng.from || d > lrng.to)) return false; }
      return true;
    });
    var html = '<div class="fed-sec">Leave management <span class="fed-live"><i></i>Live</span></div>';
    if (!rows.length) { body.innerHTML = bar + html + '<div class="fed-empty">No matching leave requests.</div>'; wireLeaveFilter(); return; }
    html += '<div class="fed-subs">' + rows.map(function (l) {
      var st = l.status || 'Pending';
      return '<div class="fed-sub"><div class="fed-subtop"><div class="fed-subt">' + esc(l.type || 'Leave') + '</div>' +
        '<span class="fed-pill2 ' + subCls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="fed-submeta">' + esc(l.fromDate || '') + ' &rarr; ' + esc(l.toDate || '') + ' &middot; ' + esc(l.days || 1) + 'd' + (l.approver ? ' &middot; ' + esc(l.approver) : '') + '</div>' +
        (l.reason ? '<div class="fed-snote">' + esc(l.reason) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    body.innerHTML = bar + html;
    wireLeaveFilter();
  }
  function wireLeaveFilter() {
    var s2 = document.getElementById('fed-leave-status'); if (s2) s2.onchange = function () { state.leaveStatus = s2.value; renderLeave(); };
    var r = document.getElementById('fed-leave-range'); if (r) r.onchange = function () { state.leaveRange = r.value; renderLeave(); };
    var f = document.getElementById('fed-leave-from'); if (f) f.onchange = function () { state.leaveFrom = f.value; renderLeave(); };
    var t = document.getElementById('fed-leave-to'); if (t) t.onchange = function () { state.leaveTo = t.value; renderLeave(); };
  }

  /* ---- live WebSocket ---- */
  function openSocket(email) {
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws = new WebSocket(proto + '//' + location.host + '/ws/employee/' + encodeURIComponent(email) + '/');
      state.ws = ws;
      ws.onopen = function () { state.socketOk = true; stopFallback(); };
      ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (_) { return; } onSocket(m); };
      ws.onclose = function () { state.ws = null; state.socketOk = false; if (document.getElementById('fed-back')) startFallback(); };
      ws.onerror = function () { try { ws.close(); } catch (_) {} };
    } catch (_) { startFallback(); }
  }
  function onSocket(m) {
    if (!document.getElementById('fed-back') || !m) return;
    if (m.event === 'task' && m.task) upsertTask(m.task);
    else if (m.event === 'attendance') { loadDay(true); loadPunches(); }
    else if (m.event === 'submission') loadSubmissions();
    else if (m.event === 'leave') loadLeave();
  }
  function upsertTask(t) {
    var list = state.tasks || (state.tasks = []);
    var idx = -1; for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(t.id)) { idx = k; break; } }
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], t); else list.push(t);
    updateTaskCount();
    if (state.tab === 'tasks') renderTasks();
  }
  function startFallback() {
    if (state.timer) return;
    state.timer = setInterval(function () {
      if (!document.getElementById('fed-back')) { stopFallback(); return; }
      if (state.tab === 'checkinout') loadDay(true);
      else if (state.tab === 'tasks') loadTasks();
      else if (state.tab === 'submissions') loadSubmissions();
      else if (state.tab === 'leave') loadLeave();
    }, 15000);
  }
  function stopFallback() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* ---- row click detection on the All Interview Links table ---- */
  function handleClick(e) {
    if (!onPage()) return;
    var t = e.target;
    if (!t || (t.closest && t.closest('button,a,input,select,textarea,label,[role="button"]'))) return;
    var row = null, el = t;
    for (var i = 0; i < 9 && el && el !== document.body; i++) {
      var txt = el.textContent || '';
      if (EMAIL_RE.test(txt) && /manage/i.test(txt) && el.childElementCount >= 3 && txt.length < 400) { row = el; break; }
      el = el.parentElement;
    }
    if (!row) return;
    var picked = pickEmailName(row);
    if (!picked.email) return;
    open(picked.email, picked.name);
  }

  // Read the email and candidate name from their own cells, not the row's glued
  // textContent (which would fuse the avatar initials, name and role letters
  // onto the email). The email sits in its own leaf element on its own line.
  var STRICT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  var SKIP_WORD = /^(copy|manage|scheduled|completed|active|cancelled|pending|--)$/i;
  function pickEmailName(row) {
    var leaves = [], all = row.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].childElementCount === 0) {
        var tx = (all[i].textContent || '').trim();
        if (tx) leaves.push(tx);
      }
    }
    var ei = -1;
    for (var j = 0; j < leaves.length; j++) { if (STRICT_EMAIL.test(leaves[j])) { ei = j; break; } }
    var email = '', name = '';
    if (ei >= 0) {
      email = leaves[ei].toLowerCase();
      for (var k = ei - 1; k >= 0; k--) {
        var c = leaves[k];
        if (c && c.length > 1 && !STRICT_EMAIL.test(c) && !/^[A-Za-z]{1,3}$/.test(c) && !SKIP_WORD.test(c)) { name = c; break; }
      }
      return { email: email, name: name };
    }
    // fallback: trim the row-text match at a known TLD so role letters don't glue on
    var m = (row.textContent || '').match(EMAIL_RE);
    if (m) {
      var trimmed = (m[0].match(/^.*?\.(?:com|in|org|net|io|co|edu|gov|info|biz|us|uk|ai)/i) || [m[0]])[0];
      return { email: trimmed.toLowerCase(), name: '' };
    }
    return { email: '', name: '' };
  }

  function start() {
    document.addEventListener('click', handleClick, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
