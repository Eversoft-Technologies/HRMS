/**
 * hrms-employee-tabs.js
 * ---------------------------------------------------------------------------
 * Shared per-employee module tabs — Attendance, Check In / Out, Tasks, Work
 * Submissions and Leave — rendered for ONE email from the existing list APIs:
 *
 *   GET /api/attendance/summary/?email=&fromDate=&toDate=
 *   GET /api/attendance/day-detail?email=&date=
 *   GET /api/attendance/location-punch?email=&date=
 *   GET /api/tasks?assigneeEmail=
 *   GET /api/submissions?email=
 *   GET /api/leave?email=            GET /api/leave/balance?email=
 *
 * First consumer: the Employee Profile page (hrms-hris.js). The F2F interview
 * popup (hrms-f2f-employee-detail.js) still carries its own copy of these
 * renderers and can be switched over to this module in a later pass.
 *
 * Usage
 *   HRMSEmployeeTabs.render('attendance', containerEl, ctx)
 * where ctx = { email: 'a@b.com', state: {} }. The renderers keep their
 * filters and loaded rows in ctx.state, so pass the same ctx for every tab of
 * one employee. HRMSEmployeeTabs.reset(ctx) drops the cached rows (e.g. after
 * a live update) while keeping the user's filters.
 *
 * Every query is scoped to the container (no document-wide ids), so two
 * consumers can be on screen at once without clashing. No bundle rebuild.
 */
(function () {
  'use strict';
  if (window.HRMSEmployeeTabs) return;

  var STYLE_ID = 'hrms-employee-tabs-style';

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(p) {
    return fetch(p, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('Request failed (' + r.status + ')'));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }
  function initials(n) {
    var s = String(n || '').trim();
    if (!s) return '?';
    var p = s.split(/[\s._-]+/).filter(Boolean);
    return ((p[0] || '')[0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '');
  }
  function fmtMins(m) { m = Math.max(0, m || 0); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  // Date format from Settings > General (hrms-company.js); raw when it is not loaded.
  function fmtDate(v) { return (v && window.HRMSCompany) ? window.HRMSCompany.date(v) : (v || ''); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return isoDate(new Date()); }
  function rangeFor(key, cfrom, cto) {
    if (key === 'custom') { return { from: cfrom || todayIso(), to: cto || todayIso() }; }
    var to = new Date(), from = new Date();
    if (key === 'month') { from = new Date(to.getFullYear(), to.getMonth(), 1); }
    else { var n = ({ '7': 7, '30': 30, '60': 60, '90': 90 })[key] || parseInt(key, 10) || 30; from.setDate(from.getDate() - (n - 1)); }
    return { from: isoDate(from), to: isoDate(to) };
  }
  var RANGE_LABEL = { '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 2 months', '90': 'Last 3 months', 'month': 'This month' };

  /* Attendance % the way the F2F popup and the profile strip both compute it:
     present and late count as a day, half-day as half, absent and approved
     leave as nothing (a leave day is a day not attended). */
  function attendancePct(sum) {
    if (!sum) return null;
    var denom = (sum.present || 0) + (sum.late || 0) + (sum.absent || 0) + (sum.half_day || 0) + (sum.leave || 0);
    if (!denom) return null;
    var got = (sum.present || 0) + (sum.late || 0) + 0.5 * (sum.half_day || 0);
    return Math.round(got / denom * 100);
  }

  function selOpts(name, val, opts) {
    opts = Array.isArray(opts) ? opts : [];
    return '<select class="het-filter" data-het="' + esc(name) + '">' +
      opts.map(function (o) {
        if (!Array.isArray(o) || o.length < 2) return '';
  
        return '<option value="' + esc(o[0]) + '"' +
          (String(val) === String(o[0]) ? ' selected' : '') +
          '>' + esc(o[1]) + '</option>';
      }).join('') +
      '</select>';
  }
  function rangeControls(prefix, val, cfrom, cto, withAll) {
    var opts = [];
    if (withAll) opts.push(['all', 'All time']);
    opts.push(['7', 'Last 7 days'], ['30', 'Last 30 days'], ['60', 'Last 2 months'], ['90', 'Last 3 months'], ['month', 'This month'], ['custom', 'Custom']);
    var html = selOpts(prefix + '-range', val, opts);
    if (val === 'custom') {
      html += '<input type="date" class="het-filter" data-het="' + prefix + '-from" value="' + esc(cfrom || '') + '" max="' + todayIso() + '">' +
              '<input type="date" class="het-filter" data-het="' + prefix + '-to" value="' + esc(cto || todayIso()) + '" max="' + todayIso() + '">';
    }
    return html;
  }
  function filterBar(inner) { return '<div class="het-filters">' + inner + '</div>'; }
  function loading(what) { return '<div class="het-loading">Loading ' + esc(what) + '…</div>'; }
  function empty(msg) { return '<div class="het-empty">' + esc(msg) + '</div>'; }
  function denied(err, what) {
    if (err && err.status === 403) return '<div class="het-empty">You do not have access to this employee\'s ' + esc(what) + '.</div>';
    return '<div class="het-empty">' + esc((err && err.message) || ('Could not load ' + what + '.')) + '</div>';
  }
  function q(box, name) { return box.querySelector('[data-het="' + name + '"]'); }
  function on(box, name, handler) { var el = q(box, name); if (el) el.onchange = handler; }
  function cls(st) { return String(st || '').toLowerCase().replace(/\s+/g, ''); }

  /* Re-render only if the container is still showing this tab (the user may
     have switched tabs while a request was in flight). */
  function settle(box, ctx, tab) {
    if (box.getAttribute('data-het-tab') === tab) render(tab, box, ctx);
  }

  /* ── styles (theme variables with light fallbacks) ─────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.het{color:var(--text,#0f172a);font-size:13px;}',
      '.het-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}',
      '.het-filter{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:8px;color:var(--text,#0f172a);font:inherit;font-size:12px;font-weight:600;padding:6px 9px;cursor:pointer;}',
      '.het-filter:focus{border-color:var(--accent,#4f8ef7);outline:none;}',
      '.het-loading,.het-empty{color:var(--text3,#64748b);font-size:13px;text-align:center;padding:28px 10px;}',
      '.het-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);margin:14px 0 8px;display:flex;align-items:center;gap:8px;}',
      '.het-sec:first-child{margin-top:0;}',
      '.het-pctwrap{display:flex;align-items:center;gap:16px;margin-bottom:14px;}',
      '.het-ring{width:92px;height:92px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;}',
      '.het-ring>div{width:70px;height:70px;border-radius:50%;background:var(--bg2,#fff);display:flex;align-items:center;justify-content:center;}',
      '.het-ring span{font-size:20px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-ringlbl{font-size:12px;color:var(--text3,#64748b);}',
      '.het-cv{font-size:17px;font-weight:800;color:var(--text,#0f172a);margin-top:2px;}',
      '.het-cl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);}',
      '.het-break{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:6px 0 4px;}',
      '.het-bk{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:10px 8px;text-align:center;}',
      '.het-bk b{display:block;font-size:18px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-bk small{font-size:10.5px;color:var(--text3,#64748b);text-transform:uppercase;letter-spacing:.3px;}',
      '.het-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}',
      '.het-tile{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.het-hrs{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--text3,#64748b);margin-bottom:12px;align-items:center;}',
      '.het-hrs b{color:var(--text,#0f172a);}',
      '.het-pill{display:inline-block;font-size:10.5px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:capitalize;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.het-pill.present,.het-pill.online,.het-pill.approved,.het-pill.completed,.het-pill.done,.het-pill.paid{background:rgba(34,197,94,.16);color:var(--success,#16a34a);}',
      '.het-pill.late,.het-pill.pending,.het-pill.inprogress{background:rgba(247,201,79,.18);color:var(--warn,#b7791f);}',
      '.het-pill.absent,.het-pill.offline,.het-pill.rejected{background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-pill.inreview,.het-pill.review{background:rgba(79,142,247,.16);color:var(--accent,#2563eb);}',
      '.het-log{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:8px 2px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.het-log:last-child{border-bottom:none;}',
      '.het-lt{font-weight:700;color:var(--text,#0f172a);white-space:nowrap;}',
      '.het-le{color:var(--text2,#475569);}',
      '.het-ll{color:var(--text3,#64748b);font-size:11px;text-align:right;}',
      '.het-ll a{color:var(--accent,#4f8ef7);text-decoration:none;font-weight:600;}',
      '.het-pipe{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;align-items:start;}',
      '.het-col{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:8px;}',
      '.het-colh{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3,#64748b);display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:2px 4px;}',
      '.het-colh span{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:999px;padding:0 7px;font-size:10.5px;color:var(--text2,#475569);}',
      '.het-card{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:10px;padding:9px 10px;margin-bottom:8px;}',
      '.het-ct{font-size:12.5px;font-weight:700;color:var(--text,#0f172a);line-height:1.3;}',
      '.het-cmeta{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap;font-size:10.5px;color:var(--text3,#64748b);}',
      '.het-prio{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:999px;background:rgba(148,163,184,.2);color:var(--text2,#475569);}',
      '.het-prio.high{background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-prio.medium{background:rgba(247,201,79,.18);color:var(--warn,#b7791f);}',
      '.het-prio.low{background:rgba(34,197,94,.16);color:var(--success,#16a34a);}',
      '.het-rej{font-size:9.5px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(247,95,79,.16);color:var(--danger,#dc2626);}',
      '.het-bar{height:6px;border-radius:999px;background:var(--bg3,#e5e7eb);overflow:hidden;}',
      '.het-bar i{display:block;height:100%;background:var(--accent,#4f8ef7);}',
      '.het-cprog{font-size:10px;color:var(--text3,#64748b);margin-top:3px;text-align:right;}',
      '.het-colempty{color:var(--text3,#94a3b8);font-size:11px;text-align:center;padding:8px;}',
      '.het-list{display:flex;flex-direction:column;gap:10px;}',
      '.het-item{background:var(--bg3,#f1f5f9);border:1px solid var(--border2,#e5e7eb);border-radius:12px;padding:12px;}',
      '.het-itop{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.het-it{font-size:13px;font-weight:700;color:var(--text,#0f172a);}',
      '.het-imeta{font-size:11.5px;color:var(--text3,#64748b);margin-top:4px;}',
      '.het-score{font-weight:700;color:var(--accent,#4f8ef7);}',
      '.het-note{font-size:12px;color:var(--text2,#475569);margin-top:8px;background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-left:3px solid var(--accent,#4f8ef7);border-radius:8px;padding:8px 10px;}',
      '.het-bal{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;}',
      '.het-bal .het-tile b{display:block;font-size:20px;font-weight:800;color:var(--text,#0f172a);}',
      '.het-bal .het-tile small{font-size:11px;color:var(--text3,#64748b);}',
      '.attendance-layout{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;width:100%;}',
      '.attendance-layout .het-two{grid-column:1/-1;margin-bottom:16px;}',
      '.attendance-details{grid-column:1;width:100%;box-sizing:border-box;}',
      '.attendance-history{grid-column:2;grid-row:2;min-width:0;box-sizing:border-box;margin-bottom:12px;}',
      '.attendance-history-title{font-size:13px;font-weight:700;cursor:pointer;padding:4px 0 12px;}',
      '.attendance-history-day{border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.attendance-history-day{display:block;width:100%;}',
      '.attendance-history-day > summary{display:block;cursor:pointer;pointer-events:auto;}',
      '.attendance-history-day[open] .attendance-history-content{display:block;}',
      '.attendance-history-day summary{cursor:pointer;padding:10px 0;font-size:11px;font-weight:600;line-height:1.6;}',
      '.attendance-history-content{padding:10px;background:var(--bg2,#fff);border-radius:8px;}','.ah-card{background:#1e2538;border:1px solid #293249;border-radius:14px;padding:24px;color:#e5e9f4;width:100%;box-sizing:border-box;}',
      '.ah-title{font-family:inherit;font-size:17px;font-weight:700;margin-bottom:6px;color:var(--text,#e5e9f4);}',
      '.ah-subtitle{font-family:inherit;font-size:12.5px;color:var(--text3,#98a5bf);margin-bottom:18px;}',
      '.ah-tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--bg2,#141c2e);border-radius:9px;padding:4px;margin-bottom:18px;gap:4px;}',
      '.ah-tab{font-family:inherit;border:0;background:transparent;color:var(--text3,#a4b0c8);padding:10px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.ah-tab.active{background:var(--accent,#39558e);color:#fff;font-weight:700;}',
      '.ah-label{font-family:inherit;display:block;font-size:11px;font-weight:600;color:var(--text3,#a4b0c8);margin-bottom:7px;}',
      '.ah-date-row{display:flex;gap:10px;margin-bottom:20px;}',
      '.ah-date-input{font-family:inherit;font-size:12px;font-weight:500;background:var(--bg2,#141c2e);border:1px solid var(--border2,#293249);color:var(--text,#e5e9f4);border-radius:8px;padding:10px;width:100%;box-sizing:border-box;color-scheme:dark;}',
      '.ah-nav{font-family:inherit;font-size:15px;background:var(--bg2,#141c2e);border:1px solid var(--border2,#293249);color:var(--text2,#c6d0e4);border-radius:8px;padding:0 16px;cursor:pointer;}',
      '.ah-day-header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;}',
      '.ah-day-title{font-family:inherit;font-size:14px;font-weight:700;color:var(--text,#e5e9f4);}',
      '.ah-status{background:rgba(34,197,94,.16);color:var(--success,#55e0bf);padding:6px 13px;border-radius:30px;font-family:inherit;font-size:11px;font-weight:600;}',
      '.ah-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}',
      '.ah-stat-label{font-family:inherit;font-size:11px;font-weight:600;color:var(--text3,#9ca9c1);margin-bottom:7px;}',
      '.ah-stat-value{font-family:inherit;font-size:18px;font-weight:700;color:var(--text,#e5e9f4);}',
      '.ah-divider{border:0;border-top:1px solid var(--border2,#354057);margin:16px 0;}',
      '.ah-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px;}',
      '.ah-section-title{font-family:inherit;font-size:11px;font-weight:700;color:var(--text3,#9daac2);margin-bottom:12px;}',
      '.ah-log{display:flex;gap:12px;align-items:center;min-height:34px;font-family:inherit;font-size:12px;}',
      '.ah-time{font-size:11px;font-weight:600;color:var(--text3,#a7b3ca);min-width:80px;}',
      '.ah-event{font-size:12px;font-weight:600;}',
      '.ah-event.checkin{color:#42dfc0;}',
      '.ah-event.checkout{color:#d4a4ff;}',
      '.ah-event.breakstart{color:#ffc76a;}',
      '.ah-event.breakend{color:#88aaff;}',
      '.ah-location{font-family:inherit;font-size:12px;color:var(--text2,#e5e9f4);margin-bottom:10px;}',
      '.ah-location small{display:block;font-size:11px;color:var(--text3,#9ca9c1);margin-top:4px;}',
      '.ah-location a{color:var(--accent,#8dafff);text-decoration:none;}',
      '.ah-range-inputs{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;margin-bottom:20px;}',
      '.ah-apply{font-family:inherit;font-size:12px;background:var(--accent,#527fe3);border:0;color:white;padding:11px 20px;border-radius:8px;cursor:pointer;font-weight:700;}',
      '.ah-range-heading{font-family:inherit;font-size:14px;font-weight:700;margin-bottom:8px;}',
      '.ah-range-summary{font-family:inherit;font-size:12px;color:var(--text3,#9ca9c1);margin-bottom:18px;}',
      '.ah-record{background:var(--bg2,#141c2e);border:1px solid var(--border2,#293249);border-radius:10px;padding:14px;margin-bottom:12px;}',
      '.ah-record-header{display:flex;justify-content:space-between;align-items:center;gap:12px;font-family:inherit;font-size:13px;}',
      '.ah-record-meta{font-family:inherit;font-size:11px;color:var(--text3,#a1aec6);margin-top:8px;}',
      '.ah-footer{font-family:inherit;font-size:11px;color:var(--text3,#9ca9c1);margin-top:20px;}',
      '.ah-filter-panel{position:relative;margin-bottom:16px;font-family:inherit;}',
      '.ah-filter-heading{font-size:12px;font-weight:600;color:#9ca9c1;margin-bottom:8px;}',
      '.ah-filter-dropdown{position:relative;}',
      '.ah-filter-trigger{height:56px;display:flex;align-items:center;justify-content:space-between;background:#141c2e;border:1px solid #293249;border-radius:10px;padding:0 16px;color:#c6d0e4;font-family:inherit;font-size:14px;cursor:pointer;list-style:none;}',
      '.ah-filter-trigger::-webkit-details-marker{display:none;}',
      '.ah-filter-dropdown[open] .ah-filter-trigger{border:2px solid #398bff;box-shadow:0 0 8px rgba(57,139,255,.4);}',
      '.ah-filter-menu{position:absolute;top:calc(100% + 1px);left:0;right:0;z-index:100;background:#1e2538;border:1px solid #398bff;border-radius:0 0 10px 10px;padding:8px 14px;box-shadow:0 5px 15px rgba(0,0,0,.25);}',
      '.ah-filter-option{display:flex;align-items:center;gap:13px;min-height:43px;padding:3px 10px;background:transparent!important;border:0!important;border-radius:5px;color:#c6d0e4;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;}',
      '.ah-filter-option:hover{background:rgba(79,142,247,.10)!important;}',
      '.ah-filter-option input{appearance:none;width:20px;height:20px;flex-shrink:0;border:2px solid #aab7cb;border-radius:5px;background:transparent;margin:0;cursor:pointer;}',
      '.ah-filter-option input:checked{background:#398bff;border-color:#398bff;}',
      '.ah-filter-option input:checked::after{content:"✓";display:block;color:white;font-size:14px;font-weight:700;text-align:center;line-height:17px;}',
      '.ah-filter-icon{width:23px;height:23px;flex-shrink:0;display:inline-block;}',
      '.ah-filter-icon.green{color:#35d99a;}',
      '.ah-filter-icon.purple{color:#d946ef;}',
      '.ah-filter-icon.orange{color:#f59e0b;}',
      '.ah-filter-icon.red{color:#fb7185;}',
      '.ah-filter-icon.blue{color:#3b82f6;}',
      '.ah-filter-icon.teal{color:#2dd4bf;}',
      '.ah-filter-footer{border-top:1px solid #354057;margin-top:12px;padding-top:12px;}',
      '.ah-filter-submit{width:100%;height:50px;background:#216cf0;border:0;border-radius:12px;color:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:background .2s ease;}',
      '.ah-filter-submit:hover{background:#347dfb;}',
      '.ah-filter-submit:active{transform:scale(.99);}',
      '.ah-range-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999;}',
      '.ah-range-popup{position:relative;width:420px;max-width:90%;background:#1b2438;border:1px solid #354057;border-radius:18px;padding:30px 24px 22px;text-align:center;box-shadow:0 15px 45px rgba(0,0,0,.4);font-family:inherit;}',
      '.ah-popup-icon{width:58px;height:58px;border:4px solid #ff5265;color:#ff5265;border-radius:50%;font-size:42px;font-weight:600;line-height:52px;margin:0 auto 18px;}',
      '.ah-range-popup h3{font-size:22px;color:#f1f4fb;margin:0 0 12px;}',
      '.ah-range-popup p{font-size:15px;color:#a4b0c8;margin:0 0 28px;}',
      '.ah-popup-ok{width:100%;background:#4385f5;color:white;border:0;border-radius:9px;padding:14px;font-size:16px;font-weight:600;cursor:pointer;}',
      '.ah-popup-close{position:absolute;right:16px;top:12px;background:none;border:0;color:#a4b0c8;font-size:27px;cursor:pointer;}',
      '.ah-filter-footer{border-top:1px solid #354057;margin-top:12px;padding-top:12px;}',
      '.ah-filter-submit{width:100%;height:50px;background:#216cf0;border:0;border-radius:12px;color:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:background .2s ease;}',
      '.ah-filter-submit:hover{background:#347dfb;}',
      '.ah-filter-submit:active{transform:scale(.99);}',
      '@media(max-width:700px){.ah-stats{grid-template-columns:1fr 1fr;}.ah-columns{grid-template-columns:1fr;}.ah-range-inputs{grid-template-columns:1fr;}.ah-card{padding:16px;}}',
      '@media(max-width:600px){.attendance-layout{grid-template-columns:1fr;}.attendance-history{grid-column:1;grid-row:auto;}}',
      '@media(max-width:720px){.het-pipe{grid-template-columns:1fr 1fr;}.het-break{grid-template-columns:1fr 1fr;}}',
      '@media(max-width:480px){.het-pipe{grid-template-columns:1fr;}.het-two{grid-template-columns:1fr;}}'
      
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── Attendance ─────────────────────────────────────────────────────────── */
  function wireAtt(box, ctx) {
    var s = ctx.state;
    var again = function () { s.attSummary = null; s.ahData = null; s.ahPage = 1; render('attendance', box, ctx); };
    on(box, 'att-range', function () { s.attRange = this.value; again(); });
    on(box, 'att-from', function () { s.attFrom = this.value; again(); });
    on(box, 'att-to', function () { s.attTo = this.value; again(); });
  }
  function renderAttendance(box, ctx) {
    var s = ctx.state;
    var bar = filterBar(rangeControls('att', s.attRange || '30', s.attFrom, s.attTo, false));
    if (!s.attSummary) {
      box.innerHTML = bar + loading('attendance');
      wireAtt(box, ctx);
      var r = rangeFor(s.attRange || '30', s.attFrom, s.attTo);
      api('/api/attendance/summary/?email=' + encodeURIComponent(ctx.email) + '&fromDate=' + r.from + '&toDate=' + r.to)
        .then(function (sum) { s.attSummary = sum || {}; s.attError = null; settle(box, ctx, 'attendance'); })
        .catch(function (e) { s.attSummary = {}; s.attError = e; settle(box, ctx, 'attendance'); });
      return;
    }
    if (s.attError) { box.innerHTML = bar + denied(s.attError, 'attendance'); wireAtt(box, ctx); return; }
    var sum = s.attSummary;
    var pct = attendancePct(sum);
    var deg = pct == null ? 0 : Math.round(pct * 3.6);
    var label = (s.attRange === 'custom') ? ((s.attFrom || '?') + ' to ' + (s.attTo || todayIso())) : (RANGE_LABEL[s.attRange || '30'] || '');
    box.innerHTML = bar +
      '<div class="het-pctwrap">' +
        '<div class="het-ring" style="background:conic-gradient(var(--accent,#4f8ef7) ' + deg + 'deg, var(--bg3,#e5e7eb) 0deg);"><div><span>' + (pct == null ? '--' : pct + '%') + '</span></div></div>' +
        '<div><div class="het-cv">' + (pct == null ? 'No records' : 'Attendance') + '</div><div class="het-ringlbl">' + esc(label) + '</div></div>' +
      '</div>' +
      '<div class="het-break">' +
        bk(sum.present || 0, 'Present') + bk(sum.late || 0, 'Late') + bk(sum.absent || 0, 'Absent') + bk(sum.leave || 0, 'Leave') + bk(sum.half_day || 0, 'Half-day') +
      '</div>' +
      '<div class="het-hrs"><span>Worked <b>' + fmtMins(sum.total_worked_minutes) + '</b></span>' +
        '<span>Breaks <b>' + fmtMins(sum.total_break_minutes) + '</b></span>' +
        '<span>Overtime <b>' + fmtMins(sum.total_overtime_minutes) + '</b></span></div>' +
      '<div class="het-ah" data-het="ah"></div>';
    wireAtt(box, ctx);
    renderHistory(box, ctx);
  }

  /* ── Attendance history: every day of the range, filters + pagination ─── */
  var AH_STATUS = [
    ['present', 'Present'], ['late', 'Late'], ['half-day', 'Half-day'], ['absent', 'Absent'], ['leave', 'Leave'],
    ['holiday', 'Holiday'], ['weekend', 'Weekly off'], ['working', 'Working'], ['pending', 'Not checked in']
  ];
  var AH_LABEL = {}; AH_STATUS.forEach(function (x) { AH_LABEL[x[0]] = x[1]; });
  function ahQuery(ctx, extra) {
    var s = ctx.state, r = rangeFor(s.attRange || '30', s.attFrom, s.attTo);
    var qs = 'email=' + encodeURIComponent(ctx.email) + '&from=' + r.from + '&to=' + r.to +
      '&page=' + (s.ahPage || 1) + '&pageSize=' + (s.ahSize || 10);
    var st = Object.keys(s.ahStatus || {}).filter(function (k) { return s.ahStatus[k]; });
    if (st.length) qs += '&status=' + encodeURIComponent(st.join(','));
    if (s.ahMode) qs += '&mode=' + s.ahMode;
    if (s.ahIssues) qs += '&issues=1';
    return '/api/attendance/history?' + qs + (extra || '');
  }
  function renderHistory(box, ctx) {
    var s = ctx.state, host = q(box, 'ah');
    if (!host) return;
    if (!s.ahData && !s.ahError) {
      host.innerHTML = ahHead(s, null) + '<div class="het-loading">Loading history…</div>';
      wireHistory(box, ctx);
      var tok = s.ahTok = (s.ahTok || 0) + 1;
      api(ahQuery(ctx)).then(function (d) {
        if (tok !== s.ahTok) return;
        s.ahData = d; s.ahError = null;
        if (box.getAttribute('data-het-tab') === 'attendance') renderHistory(box, ctx);
      }).catch(function (e) {
        if (tok !== s.ahTok) return;
        s.ahError = e;
        if (box.getAttribute('data-het-tab') === 'attendance') renderHistory(box, ctx);
      });
      return;
    }
    if (s.ahError) {
      var err = s.ahError; s.ahError = null;
      host.innerHTML = ahHead(s, null) + denied(err, 'attendance history');
      wireHistory(box, ctx);
      return;
    }
    var d = s.ahData, rows = d.results || [];
    var body = rows.length ? rows.map(function (x) {
      var mode = x.mode === 'wfh' ? '<span class="het-ahm wfh">WFH</span>' : x.mode === 'office' ? '<span class="het-ahm">Office</span>' : '';
      var extra = [];
      if (x.detail) extra.push(esc(x.detail));
      if (x.punchIssue) extra.push('<span class="het-ahwarn">Missed punch</span>');
      if (x.lateMinutes && x.status === 'late') extra.push(x.lateMinutes + ' min late');
      if (x.note) extra.push('<span title="' + esc(x.note) + '">' + esc(x.note.length > 40 ? x.note.slice(0, 40) + '…' : x.note) + '</span>');
      return '<tr class="het-ahr ' + esc(x.status) + '">' +
        '<td><b>' + esc(fmtDate(x.date)) + '</b><small>' + esc(x.weekday) + '</small></td>' +
        '<td><span class="het-ahs ' + esc(x.status) + '">' + esc(AH_LABEL[x.status] || x.status) + '</span></td>' +
        '<td>' + (x.checkIn ? esc(x.checkIn) : '<i>—</i>') + '</td>' +
        '<td>' + (x.checkOut ? esc(x.checkOut) : (x.status === 'working' ? '<span class="het-ahlive">In progress</span>' : '<i>—</i>')) + '</td>' +
        '<td>' + (x.workedMinutes ? esc(fmtMins(x.workedMinutes)) : '<i>—</i>') + '</td>' +
        '<td>' + (x.breakMinutes ? esc(fmtMins(x.breakMinutes)) : '<i>—</i>') + '</td>' +
        '<td>' + (x.overtimeMinutes ? esc(fmtMins(x.overtimeMinutes)) : '<i>—</i>') + '</td>' +
        '<td>' + mode + '</td>' +
        '<td class="het-ahx">' + (extra.join(' · ') || '<i>—</i>') + '</td></tr>';
    }).join('') : '<tr><td colspan="9" class="het-empty">No days match these filters.</td></tr>';
    var from = d.total ? (d.page - 1) * d.pageSize + 1 : 0, to = Math.min(d.page * d.pageSize, d.total);
    host.innerHTML = ahHead(s, d) +
      '<div class="het-ahwrap" tabindex="0" aria-label="Attendance history"><table class="het-aht"><thead><tr>' +
        '<th>Date</th><th>Status</th><th>Check in</th><th>Check out</th><th>Worked</th><th>Break</th><th>Overtime</th><th>Mode</th><th>Details</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="het-ahpg"><span>' + (d.total ? 'Showing <b>' + from + '–' + to + '</b> of <b>' + d.total + '</b> days' : '0 days') + '</span>' +
        '<span class="het-ahnav">' + pager(d) + '</span></div>';
    wireHistory(box, ctx);
  }
  function pager(d) {
    var p = d.page, n = d.pages, out = [];
    out.push('<button type="button" data-ahpage="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>');
    var pages = [];
    for (var i = 1; i <= n; i++) if (i === 1 || i === n || Math.abs(i - p) <= 1) pages.push(i);
    var last = 0;
    pages.forEach(function (i) {
      if (i - last > 1) out.push('<span class="het-ahdots">…</span>');
      out.push('<button type="button" data-ahpage="' + i + '"' + (i === p ? ' class="on" aria-current="page"' : '') + '>' + i + '</button>');
      last = i;
    });
    out.push('<button type="button" data-ahpage="' + (p + 1) + '"' + (p >= n ? ' disabled' : '') + ' aria-label="Next page">›</button>');
    return out.join('');
  }
  function ahHead(s, d) {
    var counts = (d && d.counts) || {};
    var chips = AH_STATUS.filter(function (x) { return !d || counts[x[0]] || (s.ahStatus || {})[x[0]]; }).map(function (x) {
      var on = (s.ahStatus || {})[x[0]];
      return '<button type="button" class="het-ahc ' + x[0] + (on ? ' on' : '') + '" data-ahst="' + x[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        esc(x[1]) + (d ? ' <span>' + (counts[x[0]] || 0) + '</span>' : '') + '</button>';
    }).join('');
    var any = Object.keys(s.ahStatus || {}).some(function (k) { return s.ahStatus[k]; }) || s.ahMode || s.ahIssues;
    return '<div class="het-sec" style="margin-top:20px">Attendance history</div>' +
      '<div class="het-ahbar">' +
        '<div class="het-ahchips" role="group" aria-label="Filter by status">' + chips + '</div>' +
        '<div class="het-ahctl">' +
          selOpts('ah-mode', s.ahMode || '', [['', 'All work modes'], ['office', 'Office'], ['wfh', 'WFH']]) +
          '<label class="het-ahiss"><input type="checkbox" data-het="ah-issues"' + (s.ahIssues ? ' checked' : '') + '> Needs attention</label>' +
          selOpts('ah-size', String(s.ahSize || 10), [['10', '10 / page'], ['20', '20 / page'], ['50', '50 / page'], ['100', '100 / page']]) +
          (any ? '<button type="button" class="het-ahlink" data-ahclear="1">Clear filters</button>' : '') +
          '<button type="button" class="het-filter" data-ahcsv="1" title="Download these days as CSV">Export CSV</button>' +
        '</div>' +
      '</div>';
  }
  function wireHistory(box, ctx) {
    var s = ctx.state, host = q(box, 'ah');
    if (!host) return;
    var reload = function (keepPage) { s.ahData = null; if (!keepPage) s.ahPage = 1; renderHistory(box, ctx); };
    host.querySelectorAll('[data-ahst]').forEach(function (b) {
      b.onclick = function () { s.ahStatus = s.ahStatus || {}; var k = b.getAttribute('data-ahst'); s.ahStatus[k] = !s.ahStatus[k]; reload(); };
    });
    var m = q(host, 'ah-mode'); if (m) m.onchange = function () { s.ahMode = this.value; reload(); };
    var sz = q(host, 'ah-size'); if (sz) sz.onchange = function () { s.ahSize = parseInt(this.value, 10) || 10; reload(); };
    var iss = q(host, 'ah-issues'); if (iss) iss.onchange = function () { s.ahIssues = this.checked; reload(); };
    var cl = host.querySelector('[data-ahclear]'); if (cl) cl.onclick = function () { s.ahStatus = {}; s.ahMode = ''; s.ahIssues = false; reload(); };
    host.querySelectorAll('[data-ahpage]').forEach(function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        s.ahPage = parseInt(b.getAttribute('data-ahpage'), 10) || 1; reload(true);
        var w = host.querySelector('.het-ahwrap'); if (w) w.scrollTop = 0;
      };
    });
    var csv = host.querySelector('[data-ahcsv]');
    if (csv) csv.onclick = function () {
      csv.disabled = true;
      fetch(ahQuery(ctx, '&export=csv')).then(function (r) {
        if (!r.ok) throw new Error('Export failed (' + r.status + ')');
        var name = ((r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'attendance.csv';
        return r.blob().then(function (b) { return { b: b, name: name }; });
      }).then(function (x) {
        var url = URL.createObjectURL(x.b), a = document.createElement('a');
        a.href = url; a.download = x.name; document.body.appendChild(a); a.click(); a.parentNode.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }).catch(function (e) { alert(e.message); }).then(function () { csv.disabled = false; });
    };
  }
  function bk(v, l) { return '<div class="het-bk"><b>' + v + '</b><small>' + esc(l) + '</small></div>'; }

  /* ── Check In / Out ─────────────────────────────────────────────────────── */
  function ahEventClass(event) {
    var value = String(event || '').toLowerCase();
  
    if (/check.?in/.test(value)) return 'checkin';
    if (/check.?out/.test(value)) return 'checkout';
    if (/break.*start|start.*break/.test(value)) return 'breakstart';
    if (/break.*end|end.*break/.test(value)) return 'breakend';
  
    return '';
  }
  
  function ahMinutes(value) {
    value = Number(value) || 0;
  
    return Math.floor(value / 60) + 'h ' + (value % 60) + 'm';
  }
  
  function ahDayTitle(date) {
    var d = new Date(date + 'T12:00:00');
  
    return d.toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }
  
  function ahRenderActivity(day) {
    var events = day.events || [];
  
    if (!events.length) {
      return '<div class="het-empty">No activity recorded.</div>';
    }
  
    return events.map(function (event) {
      return '<div class="ah-log">' +
        '<span class="ah-time">' + esc(event.time || '--') + '</span>' +
        '<span class="ah-event ' + ahEventClass(event.event || event.label) + '">' +
          esc(event.label || event.event || 'Activity') +
        '</span>' +
      '</div>';
    }).join('');
  }
  
  function ahRenderLocations(day) {
    var punches = day.punches || [];
  
    if (!punches.length) {
      return '<div class="het-empty">No location punches recorded.</div>';
    }
  
    return punches.map(function (punch) {
      var lat = Number(punch.latitude);
      var lng = Number(punch.longitude);
  
      var hasCoordinates =
        punch.latitude != null &&
        punch.longitude != null &&
        isFinite(lat) &&
        isFinite(lng);
  
      var map = hasCoordinates
        ? '<a href="https://www.google.com/maps?q=' +
          lat + ',' + lng +
          '" target="_blank" rel="noopener">View map ↗</a>'
        : '';
  
      return '<div class="ah-location">' +
        esc(punch.label || 'Location recorded') +
        '<small>' +
          esc(punch.time || '') +
          (map ? ' · ' + map : '') +
        '</small>' +
      '</div>';
    }).join('');
  }
  
  function ahRenderColumns(day, filters) {
    filters = filters || {};

    var showActivity = filters.activity !== false;
    var showLocations = filters.locations !== false;

    var columns = [];

    if (showActivity) {
      columns.push(
        '<div>' +
          '<div class="ah-section-title">ACTIVITY</div>' +
          ahRenderActivity(day) +
        '</div>'
      );
    }

    if (showLocations) {
      columns.push(
        '<div>' +
          '<div class="ah-section-title">LOCATION PUNCHES</div>' +
          ahRenderLocations(day) +
        '</div>'
      );
    }

    if (!columns.length) {
      return '<div class="het-empty">Select at least one display filter.</div>';
    }

    return '<div class="ah-columns">' +
      columns.join('') +
    '</div>';
  }
  
  function ahStatus(day) {
    var status = String(day.status || '').toLowerCase();
  
    if (status === 'late') return 'Late';
    if (status === 'absent') return 'Absent';
    if (status === 'half_day') return 'Half-day';
  
    return day.checkIn ? 'Present' : 'No record';
  }
  function renderAttendanceHistory(box, ctx) {
    var s = ctx.state;
    s.ahFilters = s.ahFilters || {
      effective: true,
      gross: true,
      break: true,
      punches: true,
      activity: true,
      locations: true
    };
  
    var mode = s.ahMode || 'daily';
    var date = s.ahDate || s.cioDate || todayIso();
  
    var fromDate = s.ahFrom || date;
    var toDate = s.ahTo || date;
    function ahShowRangePopup() {
      var oldPopup = document.querySelector('.ah-range-overlay');
      if (oldPopup) oldPopup.remove();
    
      var overlay = document.createElement('div');
      overlay.className = 'ah-range-overlay';
    
      overlay.innerHTML =
        '<div class="ah-range-popup">' +
          '<button class="ah-popup-close" type="button">&times;</button>' +
          '<div class="ah-popup-icon">!</div>' +
          '<h3>Date range not allowed</h3>' +
          '<p>Date range above 5 days is not considered.</p>' +
          '<button class="ah-popup-ok" type="button">OK</button>' +
        '</div>';
    
      document.body.appendChild(overlay);
    
      function closePopup() {
        overlay.remove();
      }
    
      overlay.querySelector('.ah-popup-ok').onclick = closePopup;
      overlay.querySelector('.ah-popup-close').onclick = closePopup;
    }
    function fetchDays(from, to) {
      var start = new Date(from + 'T12:00:00');
      var end = new Date(to + 'T12:00:00');
  
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
        s.ahError = new Error('Please select a valid date range.');
        s.ahRows = [];
        renderAttendanceHistory(box, ctx);
        return;
      }
  
      var dates = [];

for (
  var current = new Date(start);
  current <= end;
  current.setDate(current.getDate() + 1)
) {
  dates.push(isoDate(current));
}

if (dates.length > 5) {
  s.ahError = null;
  s.ahRows = null;
  s.ahLoading = false;
  s.ahKey = null;

  ahShowRangePopup();
  return;
}
      if (dates.length > 5) {
        s.ahError = new Error('Please select a range of up to 31 days.');
        s.ahRows = [];
        renderAttendanceHistory(box, ctx);
        return;
      }
  
      var key = ctx.email + ':' + from + ':' + to;
  
      if (s.ahKey === key && (s.ahRows || s.ahLoading)) return;
  
      s.ahKey = key;
      s.ahLoading = true;
      s.ahError = null;
      s.ahRows = null;
  
      Promise.all(dates.map(function (d) {
        return api(
          '/api/attendance/day-detail?email=' +
          encodeURIComponent(ctx.email) +
          '&date=' +
          encodeURIComponent(d)
        );
      }))
      .then(function (rows) {
        if (s.ahKey !== key) return;
  
        s.ahRows = rows.reverse();
        s.ahLoading = false;
  
        renderAttendanceHistory(box, ctx);
      })
      .catch(function (error) {
        if (s.ahKey !== key) return;
  
        s.ahError = error;
        s.ahLoading = false;
  
        renderAttendanceHistory(box, ctx);
      });
    }
  
    var html =
      '<div class="ah-card">' +
  
        '<div class="ah-title">Activity History</div>' +
  
        '<div class="ah-subtitle">' +
          'Review activity and recorded locations for any day.' +
        '</div>' +
        '<div class="ah-filter-panel">' +
        '<div class="ah-filter-heading">Filters</div>' +

        '<details class="ah-filter-dropdown">' +

          '<summary class="ah-filter-trigger">' +
            '<span>☰ &nbsp; Select filters</span>' +
            '<span>⌄</span>' +
          '</summary>' +

          '<div class="ah-filter-menu">' +

            ['effective', 'gross', 'break', 'punches', 'activity', 'locations']
              .map(function (key) {
                var labels = {
                  effective: 'Effective',
                  gross: 'Gross',
                  break: 'Break',
                  punches: 'Punches',
                  activity: 'Activity',
                  locations: 'Location Punches'
                };
                var icons = {
                  effective: '<svg viewBox="0 0 24 24" class="ah-filter-icon green"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
                
                  gross: '<svg viewBox="0 0 24 24" class="ah-filter-icon purple"><path d="M4 19V11h4v8H4zm6 0V5h4v14h-4zm6 0V8h4v11h-4z" fill="currentColor"/></svg>',
                
                  break: '<svg viewBox="0 0 24 24" class="ah-filter-icon orange"><path d="M5 8h12v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8zm12 2h2a2 2 0 0 1 0 4h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 3l-1 3m6-3l-1 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
                
                  punches: '<svg viewBox="0 0 24 24" class="ah-filter-icon red"><path d="M12 3a8 8 0 0 0-8 8m16 0a8 8 0 0 0-8-8m-5 8a5 5 0 0 1 10 0m-7-2a2 2 0 0 1 4 0v5m-7-3v2a5 5 0 0 0 10 0v-2m-13 0v2a8 8 0 0 0 16 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
                
                  activity: '<svg viewBox="0 0 24 24" class="ah-filter-icon blue"><path d="M6 3h9l4 4v14H6V3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5M9 12h7M9 16h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
                
                  locations: '<svg viewBox="0 0 24 24" class="ah-filter-icon teal"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0z" fill="currentColor"/><circle cx="12" cy="10" r="2.5" fill="#141c2e"/></svg>'
                };

                var filters = s.ahFilters || {};

                return '<label class="ah-filter-option">' +
                    '<input type="checkbox" data-ah-filter="' + key + '"' +
                    (filters[key] !== false ? ' checked' : '') +
                    '>' +
                    icons[key] +
                    '<span>' + labels[key] + '</span>' +
                '</label>';
              }).join('') +

              '<div class="ah-filter-footer">' +
                '<button type="button" class="ah-filter-submit" data-het="ah-filter-submit">' +
                  'Submit' +
                '</button>' +
              '</div>' +
    
            '</div>' +
        '</details>' +
      '</div>' +
  
        '<div class="ah-tabs">' +
          '<button class="ah-tab ' + (mode === 'daily' ? 'active' : '') +
            '" data-het="ah-daily">Daily</button>' +
  
          '<button class="ah-tab ' + (mode === 'range' ? 'active' : '') +
            '" data-het="ah-range">Date range</button>' +
        '</div>';
  
    if (mode === 'daily') {
      html +=
        '<label class="ah-label">Date</label>' +
  
        '<div class="ah-date-row">' +
  
          '<input type="date" class="ah-date-input" ' +
            'data-het="ah-date" value="' + esc(date) + '" max="' + todayIso() + '">' +
  
          '<button class="ah-nav" data-het="ah-prev">‹</button>' +
  
          '<button class="ah-nav" data-het="ah-next">›</button>' +
  
        '</div>';
    } else {
      html +=
        '<div class="ah-range-inputs">' +
  
          '<div>' +
            '<label class="ah-label">From date</label>' +
            '<input type="date" class="ah-date-input" ' +
              'data-het="ah-from" value="' + esc(fromDate) + '">' +
          '</div>' +
  
          '<div>' +
            '<label class="ah-label">To date</label>' +
            '<input type="date" class="ah-date-input" ' +
              'data-het="ah-to" value="' + esc(toDate) + '">' +
          '</div>' +
  
          '<button class="ah-apply" data-het="ah-apply">Apply</button>' +
  
        '</div>';
    }
  
    if (s.ahLoading) {
      html += loading('attendance history');
    } else if (s.ahError) {
      html += denied(s.ahError, 'attendance history');
    } else if (s.ahRows && s.ahRows.length) {
      var rows = s.ahRows;
  
      if (mode === 'daily') {
        var day = rows[0];
  
        html +=
          '<div class="ah-day-header">' +
            '<div class="ah-day-title">' + esc(ahDayTitle(day.date)) + '</div>' +
            '<span class="ah-status">' + esc(ahStatus(day)) + '</span>' +
          '</div>' +
  
          '<div class="ah-stats">' +

          (s.ahFilters.effective !== false ?
            '<div><div class="ah-stat-label">Effective</div>' +
              '<div class="ah-stat-value">' +
                ahMinutes(day.effectiveMinutes) +
              '</div></div>' : '') +

          (s.ahFilters.gross !== false ?
            '<div><div class="ah-stat-label">Gross</div>' +
              '<div class="ah-stat-value">' +
                ahMinutes(day.grossMinutes) +
              '</div></div>' : '') +

          (s.ahFilters.break !== false ?
            '<div><div class="ah-stat-label">Break</div>' +
              '<div class="ah-stat-value">' +
                ahMinutes(Math.max(0,
                  (day.grossMinutes || 0) - (day.effectiveMinutes || 0)
                )) +
              '</div></div>' : '') +

          (s.ahFilters.punches !== false ?
            '<div><div class="ah-stat-label">Punches</div>' +
              '<div class="ah-stat-value">' +
                (day.punches || []).length +
              '</div></div>' : '') +

        '</div>' +
          '<hr class="ah-divider">' +
  
          ahRenderColumns(day, s.ahFilters);
  
      } else {
        var totalPunches = 0;
        var totalMinutes = 0;
  
        rows.forEach(function (day) {
          totalPunches += (day.punches || []).length;
          totalMinutes += Number(day.effectiveMinutes) || 0;
        });
  
        html +=
          '<div class="ah-range-heading">' +
            esc(fmtDate(fromDate)) + ' – ' + esc(fmtDate(toDate)) +
          '</div>' +
  
          '<div class="ah-range-summary">' +
            rows.length + ' days · ' +
            totalPunches + ' punches · ' +
            ahMinutes(totalMinutes) + ' effective' +
          '</div>';
  
        rows.forEach(function (day) {
          html +=
            '<div class="ah-record">' +
  
              '<div class="ah-record-header">' +
                '<strong>' + esc(ahDayTitle(day.date)) + '</strong>' +
                '<span class="ah-status">' + esc(ahStatus(day)) + '</span>' +
              '</div>' +
  
              '<div class="ah-record-meta">' +
                'Effective ' + ahMinutes(day.effectiveMinutes) +
                ' · Gross ' + ahMinutes(day.grossMinutes) +
                ' · Break ' + ahMinutes(Math.max(
                  0,
                  (day.grossMinutes || 0) - (day.effectiveMinutes || 0)
                )) +
              '</div>' +
  
              '<hr class="ah-divider">' +
  
              ahRenderColumns(day) +
  
            '</div>';
        });
      }
    }
  
    html +=
      '<div class="ah-footer">All times are in IST (UTC+05:30).</div>' +
      '</div>';
  
    box.innerHTML = html;   
    var submitFilter = q(box, 'ah-filter-submit');

if (submitFilter) {
  submitFilter.onclick = function () {

    s.ahFilters = s.ahFilters || {};

    box.querySelectorAll('[data-ah-filter]').forEach(function (input) {
      s.ahFilters[input.getAttribute('data-ah-filter')] = input.checked;
    });

    renderAttendanceHistory(box, ctx);
  };
}
    var dailyButton = q(box, 'ah-daily');
    var rangeButton = q(box, 'ah-range');
    var prevButton = q(box, 'ah-prev');
    var nextButton = q(box, 'ah-next');
    var applyButton = q(box, 'ah-apply');
    if (applyButton) {
      applyButton.onclick = function () {
        var from = q(box, 'ah-from').value;
        var to = q(box, 'ah-to').value;
    
        if (!from || !to) {
          alert('Please select both dates.');
          return;
        }
    
        var start = new Date(from + 'T12:00:00');
        var end = new Date(to + 'T12:00:00');
        var days = Math.round((end - start) / 86400000) + 1;
    
        if (days > 5) {
          Swal.fire({
            icon: 'error',
            title: 'Date range not allowed',
            text: 'Date range above 5 days is not considered.',
            confirmButtonText: 'OK',
            confirmButtonColor: '#4285f4'
          });
          return;
        }
    
        if (days < 1) {
          alert('From date cannot be after To date.');
          return;
        }
    
        s.ahFrom = from;
        s.ahKey = null;
        s.ahRows = null;
        s.ahError = null;
        s.ahLoading = false;
    
        renderAttendanceHistory(box, ctx);
      };
    }
  
    if (dailyButton) {
      dailyButton.onclick = function () {
        s.ahMode = 'daily';
        s.ahKey = null;
        s.ahRows = null;
        renderAttendanceHistory(box, ctx);
      };
    }
  
    if (rangeButton) {
      rangeButton.onclick = function () {
        s.ahMode = 'range';
        s.ahKey = null;
        s.ahRows = null;
        renderAttendanceHistory(box, ctx);
      };
    }
  
    on(box, 'ah-date', function () {
      s.ahDate = this.value;
      s.ahKey = null;
      s.ahRows = null;
      renderAttendanceHistory(box, ctx);
    });
  
    on(box, 'ah-from', function () {
      s.ahFrom = this.value;
    });
  
    on(box, 'ah-to', function () {
      s.ahTo = this.value;
    });
  
    if (prevButton) {
      prevButton.onclick = function () {
        var d = new Date(date + 'T12:00:00');
        d.setDate(d.getDate() - 1);
  
        s.ahDate = isoDate(d);
        s.ahKey = null;
        s.ahRows = null;
  
        renderAttendanceHistory(box, ctx);
      };
    }
  
    if (nextButton) {
      nextButton.onclick = function () {
        var d = new Date(date + 'T12:00:00');
        d.setDate(d.getDate() + 1);
  
        if (isoDate(d) > todayIso()) return;
  
        s.ahDate = isoDate(d);
        s.ahKey = null;
        s.ahRows = null;
  
        renderAttendanceHistory(box, ctx);
      };
    }
  
    if (applyButton) {
      applyButton.onclick = function () {
        if (fromDate > toDate) {
          alert('From date cannot be after To date.');
          return;
        }
  
        s.ahKey = null;
        s.ahRows = null;
  
        renderAttendanceHistory(box, ctx);
      };
    }
  
    if (!s.ahLoading && !s.ahError && !s.ahRows) {
      if (mode === 'daily') {
        fetchDays(date, date);
      } else {
        fetchDays(fromDate, toDate);
      }
    }
  }
  
  function loadDay(box, ctx) {
    var s = ctx.state, d0 = s.cioDate || todayIso();
    return api('/api/attendance/day-detail?email=' + encodeURIComponent(ctx.email) + '&date=' + d0)
      .then(function (d) {
        s.day = d || {};
        s.dayError = null;
        if (Array.isArray(d && d.punches)) { s.punches = d.punches; return; }
        return api('/api/attendance/location-punch?email=' + encodeURIComponent(ctx.email) + '&date=' + d0)
          .then(function (rows) { s.punches = Array.isArray(rows) ? rows : []; })
          .catch(function () { s.punches = []; });
      })
      .catch(function (e) { s.day = {}; s.dayError = e; s.punches = []; })
      .then(function () { settle(box, ctx, 'checkin'); });
  }
  function renderCheckin(box, ctx) {
    var s = ctx.state, d0 = s.cioDate || todayIso();
    var bar = filterBar('<input type="date" class="het-filter" data-het="cio-date" value="' + esc(d0) + '" max="' + todayIso() + '">');
    function wire() {
      on(box, 'cio-date', function () {
        s.cioDate = this.value;
        s.day = null;
        s.punches = null;
        s.cioHistoryKey = null;
        s.cioHistory = null;
        render('checkin', box, ctx);
      });
    
      on(box, 'cio-history-range', function () {
        s.cioHistoryRange = this.value;
        s.cioHistoryKey = null;
        s.cioHistory = null;
        s.cioHistoryError = null;
        render('checkin', box, ctx);
      });
      on(box, 'cio-from-date', function () {
        s.cioFromDate = this.value;
      });
      
      on(box, 'cio-to-date', function () {
        s.cioToDate = this.value;
      });
      
      on(box, 'cio-apply-range', function () {
        if (!s.cioFromDate || !s.cioToDate) {
          alert('Please select both dates.');
          return;
        }
      
        if (s.cioFromDate > s.cioToDate) {
          alert('From Date cannot be after To Date.');
          return;
        }
      
        s.cioHistoryKey = null;
        s.cioHistory = null;
        s.cioHistoryError = null;
      
        render('checkin', box, ctx);
      });
    
      var panel = q(box, 'history-panel');
      if (panel) {
        panel.ontoggle = function () {
          s.cioHistoryOpen = panel.open;
          if (panel.open) render('checkin', box, ctx);
        };
      }
    }
    if (!s.day) { box.innerHTML = bar + loading('check-in'); wire(); loadDay(box, ctx); return; }
    if (s.dayError) { box.innerHTML = bar + denied(s.dayError, 'check-in records'); wire(); return; }
    var d = s.day;var historyRange = s.cioHistoryRange || 'daily';
    var historyOpen = !!s.cioHistoryOpen;
    var fromDate = s.cioFromDate || d0;
    var toDate = s.cioToDate || d0;
    
    var selected = new Date(d0 + 'T12:00:00');
    var start = new Date(selected);
    var end = new Date(selected);
    if (historyRange === 'weekly') {
      start.setDate(start.getDate() - 6);
    } else if (historyRange === 'monthly') {
      start = new Date(selected.getFullYear(), selected.getMonth(), 1);
      end = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
    } else if (historyRange === 'custom') {
      start = new Date(fromDate + 'T12:00:00');
      end = new Date(toDate + 'T12:00:00');
    }
    
    var dates = [];
    
    for (var current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
      if (isoDate(current) <= todayIso()) {
        dates.push(isoDate(current));
      }
    }
    
    var historyKey = historyRange + ':' +
  (historyRange === 'custom' ? fromDate + ':' + toDate : d0);
    
    if (historyOpen && s.cioHistoryKey !== historyKey) {
      s.cioHistoryKey = historyKey;
      s.cioHistory = null;
      s.cioHistoryError = null;
    
      Promise.all(dates.map(function (date) {
        return api(
          '/api/attendance/day-detail?email=' +
          encodeURIComponent(ctx.email) +
          '&date=' + date
        );
      }))
      .then(function (rows) {
        if (s.cioHistoryKey !== historyKey) return;
        s.cioHistory = rows;
        settle(box, ctx, 'checkin');
      })
      .catch(function (e) {
        if (s.cioHistoryKey !== historyKey) return;
        s.cioHistoryError = e;
        settle(box, ctx, 'checkin');
      });
    }
    
    var historyHtml = '';
    
    if (historyOpen) {
      if (s.cioHistoryError) {
        historyHtml = denied(s.cioHistoryError, 'attendance history');
      } else if (!s.cioHistory) {
        historyHtml = loading('attendance history');
      } else {
        historyHtml = s.cioHistory.map(function (row) {
    
          var activity = (row.events || []).map(function (e) {
            return '<div class="het-log">' +
              '<span>' + esc(e.time || '') + '</span>' +
              '<span>' + esc(e.label || e.event || '') + '</span>' +
              '</div>';
          }).join('') || empty('No activity.');
    
          var locations = (row.punches || []).map(function (p) {
            var lat = Number(p.latitude);
            var lng = Number(p.longitude);
            var hasCoords = p.latitude != null && p.longitude != null &&
              isFinite(lat) && isFinite(lng);
    
            return '<div class="het-log">' +
              '<span>' + esc(p.time || '') + '</span>' +
              '<span>' + esc(p.label || 'Location recorded') + '</span>' +
              '<span>' + (hasCoords
                ? '<a href="https://www.google.com/maps?q=' +
                  lat + ',' + lng +
                  '" target="_blank" rel="noopener">Map ↗</a>'
                : '') + '</span>' +
              '</div>';
          }).join('') || empty('No location punches.');
    
          return '<details class="attendance-history-day">' +
            '<summary>' +
              esc(row.date) + ' | ' +
              esc(row.checkIn || '--') + ' | ' +
              esc(row.checkOut || '--') +
            '</summary>' +
            '<div class="attendance-history-content">' +
              '<div class="het-sec">Activity</div>' +
              activity +
              '<div class="het-sec">Location punches</div>' +
              locations +
            '</div>' +
          '</details>';
    
        }).join('') || empty('No records.');
      }
    }
    var status = String(d.status || '').toLowerCase();
    var badge = d.onTime ? '<span class="het-pill present">On time</span>' : (status ? '<span class="het-pill ' + esc(status) + '">' + esc(d.status) + '</span>' : '');
    var logs = (d.events || []).filter(function (e) { return /check/i.test(e.event || e.label || ''); }).map(function (e) {
      return '<div class="het-log"><span class="het-lt">' + esc(e.time || '') + '</span><span class="het-le">' + esc(e.label || e.event || '') + '</span><span class="het-ll">' + esc(e.location || '') + '</span></div>';
    }).join('') || empty('No check-in events on this day.');
    var punches = s.punches || [];
    var punchHtml = punches.length ? punches.map(function (p) {
      var lat = parseFloat(p.latitude), lng = parseFloat(p.longitude);
      var link = (isFinite(lat) && isFinite(lng))
        ? '<a href="https://www.google.com/maps?q=' + lat + ',' + lng + '" target="_blank" rel="noopener">Map ↗</a>' : '';
      return '<div class="het-log"><span class="het-lt">' + esc(p.time || '') + '</span><span class="het-le">' + esc(p.label || 'Location recorded') + (p.approximate && !/^Approximate/.test(p.label || '') ? ' <small title="Device location was not precise">(approximate)</small>' : '') + '</span><span class="het-ll">' + link + '</span></div>';
    }).join('') : empty('No location punches recorded on this day.');
    box.innerHTML = bar +
      '<div class="attendance-layout">' +

      '<div class="het-two">' +
      '<div class="het-tile">' +
        '<div class="het-cl">Check In</div>' +
        '<div class="het-cv">' + esc(d.checkIn || '--') + '</div>' +
      '</div>' +

      '<div class="het-tile">' +
        '<div class="het-cl">Check Out</div>' +
        '<div class="het-cv">' + esc(d.checkOut || '--') + '</div>' +
      '</div>' +
       '</div>' +
        '<div class="attendance-history" data-het="ah-history-box">' +
        '</div>' +
      
       '<div class="het-tile attendance-details">' +
        '<div class="het-hrs">' +
        '<span>Effective <b>' + fmtMins(d.effectiveMinutes) + '</b></span>' +
        '<span>Gross <b>' + fmtMins(d.grossMinutes) + '</b></span>' +
        (badge ? '<span>' + badge + '</span>' : '') +
        (d.shift && (d.shift.name || d.shift.label)
          ? '<span>Shift <b>' + esc(d.shift.name || d.shift.label) + '</b></span>'
          : '') +
      '</div>' +

       '<div class="het-sec">Activity</div>' +
      logs +

        '<div class="het-sec">Location punches</div>' +
      punchHtml +
       '</div>' +

     '</div>';

    wire();
    var historyBox = q(box, 'ah-history-box');

    if (historyBox) {
    renderAttendanceHistory(historyBox, ctx);
    }
  }

  /* ── Tasks ──────────────────────────────────────────────────────────────── */
  function stageOf(t) {
    var st = String(t.stage || t.status || '').toLowerCase();
    if (/done|complete/.test(st)) return 'done';
    if (/review|qa/.test(st)) return 'review';
    if (/progress|doing/.test(st)) return 'inprogress';
    return 'todo';
  }
  function renderTasks(box, ctx) {
    var s = ctx.state;
    function wire() {
      on(box, 'task-stage', function () { s.taskStage = this.value; render('tasks', box, ctx); });
      on(box, 'task-prio', function () { s.taskPriority = this.value; render('tasks', box, ctx); });
    }
    var bar = filterBar(
      selOpts('task-stage', s.taskStage || 'all', [['all', 'All stages'], ['todo', 'To Do'], ['inprogress', 'In Progress'], ['review', 'Review'], ['done', 'Done']]) +
      selOpts('task-prio', s.taskPriority || 'all', [['all', 'All priority'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]));
    if (!s.tasks) {
      box.innerHTML = bar + loading('tasks');
      wire();
      api('/api/tasks?assigneeEmail=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.tasks = Array.isArray(rows) ? rows : []; s.tasksError = null; settle(box, ctx, 'tasks'); })
        .catch(function (e) { s.tasks = []; s.tasksError = e; settle(box, ctx, 'tasks'); });
      return;
    }
    if (s.tasksError) { box.innerHTML = bar + denied(s.tasksError, 'tasks'); wire(); return; }
    var all = s.tasks;
    if (!all.length) { box.innerHTML = bar + empty('No tasks assigned.'); wire(); return; }
    var rows = all.filter(function (t) { return !(s.taskPriority && s.taskPriority !== 'all') || String(t.priority || 'medium').toLowerCase() === s.taskPriority; });
    var cols = [{ k: 'todo', l: 'To Do' }, { k: 'inprogress', l: 'In Progress' }, { k: 'review', l: 'Review' }, { k: 'done', l: 'Done' }]
      .filter(function (c) { return !s.taskStage || s.taskStage === 'all' || s.taskStage === c.k; });
    var html = '<div class="het-pipe">';
    cols.forEach(function (c) {
      var items = rows.filter(function (t) { return stageOf(t) === c.k; });
      html += '<div class="het-col"><div class="het-colh">' + esc(c.l) + ' <span>' + items.length + '</span></div>';
      html += items.length ? items.map(function (t) {
        var pr = String(t.priority || 'medium').toLowerCase();
        var prog = Math.max(0, Math.min(100, t.progress || 0));
        var rej = (t.rejectReason || t.reject_reason) ? '<span class="het-rej">Rejected</span>' : '';
        return '<div class="het-card"><div class="het-ct">' + esc(t.title || 'Untitled') + '</div>' +
          '<div class="het-cmeta"><span class="het-prio ' + esc(pr) + '">' + esc(pr) + '</span>' + rej +
          (t.due ? '<span>Due ' + esc(t.due) + '</span>' : '') + (t.taskCode ? '<span>' + esc(t.taskCode) + '</span>' : '') + '</div>' +
          '<div class="het-bar"><i style="width:' + prog + '%"></i></div>' +
          '<div class="het-cprog">' + prog + '%</div></div>';
      }).join('') : '<div class="het-colempty">—</div>';
      html += '</div>';
    });
    html += '</div>';
    box.innerHTML = bar + html;
    wire();
  }

  /* ── Work submissions ───────────────────────────────────────────────────── */
  function renderSubmissions(box, ctx) {
    var s = ctx.state;
    function wire() { on(box, 'sub-status', function () { s.subStatus = this.value; render('submissions', box, ctx); }); }
    var bar = filterBar(selOpts('sub-status', s.subStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['In Review', 'In Review'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]));
    if (!s.subs) {
      box.innerHTML = bar + loading('submissions');
      wire();
      api('/api/submissions?email=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.subs = Array.isArray(rows) ? rows : []; s.subsError = null; settle(box, ctx, 'submissions'); })
        .catch(function (e) { s.subs = []; s.subsError = e; settle(box, ctx, 'submissions'); });
      return;
    }
    if (s.subsError) { box.innerHTML = bar + denied(s.subsError, 'work submissions'); wire(); return; }
    var rows = s.subs.filter(function (w) { return !s.subStatus || s.subStatus === 'all' || String(w.status || 'Pending') === s.subStatus; });
    if (!rows.length) { box.innerHTML = bar + empty('No matching submissions.'); wire(); return; }
    box.innerHTML = bar + '<div class="het-list">' + rows.map(function (w) {
      var st = w.status || 'Pending';
      var note = w.reviewerNote ? '<div class="het-note">' + esc(w.reviewerNote) + '</div>' : '';
      var score = w.aiScore ? ' &middot; <span class="het-score">AI ' + esc(w.aiScore) + '</span>' : '';
      return '<div class="het-item"><div class="het-itop"><div class="het-it">' + esc(w.title || 'Untitled') + '</div>' +
        '<span class="het-pill ' + cls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="het-imeta">' + esc(w.type || 'Document') + (w.date ? ' &middot; ' + esc(fmtDate(w.date)) : '') + score + '</div>' + note + '</div>';
    }).join('') + '</div>';
    wire();
  }

  /* ── Leave ──────────────────────────────────────────────────────────────── */
  function renderLeave(box, ctx) {
    var s = ctx.state;
    function wire() {
      on(box, 'leave-status', function () { s.leaveStatus = this.value; render('leave', box, ctx); });
      on(box, 'leave-range', function () { s.leaveRange = this.value; render('leave', box, ctx); });
      on(box, 'leave-from', function () { s.leaveFrom = this.value; render('leave', box, ctx); });
      on(box, 'leave-to', function () { s.leaveTo = this.value; render('leave', box, ctx); });
    }
    var bar = filterBar(
      selOpts('leave-status', s.leaveStatus || 'all', [['all', 'All status'], ['Pending', 'Pending'], ['Approved', 'Approved'], ['Rejected', 'Rejected']]) +
      rangeControls('leave', s.leaveRange || 'all', s.leaveFrom, s.leaveTo, true));
    if (!s.leave) {
      box.innerHTML = bar + loading('leave');
      wire();
      var list = api('/api/leave?email=' + encodeURIComponent(ctx.email))
        .then(function (rows) { s.leave = Array.isArray(rows) ? rows : []; s.leaveError = null; })
        .catch(function (e) { s.leave = []; s.leaveError = e; });
      var bal = api('/api/leave/balance?email=' + encodeURIComponent(ctx.email))
        .then(function (b) { s.leaveBalance = (b && b.balances) || []; })
        .catch(function () { s.leaveBalance = []; });
      Promise.all([list, bal]).then(function () { settle(box, ctx, 'leave'); });
      return;
    }
    if (s.leaveError) { box.innerHTML = bar + denied(s.leaveError, 'leave'); wire(); return; }
    var balHtml = '';
    if (s.leaveBalance && s.leaveBalance.length) {
      balHtml = '<div class="het-bal">' + s.leaveBalance.map(function (b) {
        return '<div class="het-tile"><div class="het-cl">' + esc(b.type) + '</div><b>' + esc(b.remaining) + '</b><small>of ' + esc(b.allowance) + ' remaining &middot; ' + esc(b.used) + ' used</small></div>';
      }).join('') + '</div>';
    }
    var lrng = (s.leaveRange && s.leaveRange !== 'all') ? rangeFor(s.leaveRange, s.leaveFrom, s.leaveTo) : null;
    var rows = s.leave.filter(function (l) {
      if (s.leaveStatus && s.leaveStatus !== 'all' && String(l.status || 'Pending') !== s.leaveStatus) return false;
      if (lrng) { var d = String(l.fromDate || ''); if (d && (d < lrng.from || d > lrng.to)) return false; }
      return true;
    });
    var listHtml = rows.length ? '<div class="het-list">' + rows.map(function (l) {
      var st = l.status || 'Pending';
      return '<div class="het-item"><div class="het-itop"><div class="het-it">' + esc(l.type || 'Leave') + '</div>' +
        '<span class="het-pill ' + cls(st) + '">' + esc(st) + '</span></div>' +
        '<div class="het-imeta">' + esc(fmtDate(l.fromDate)) + ' &rarr; ' + esc(fmtDate(l.toDate)) + ' &middot; ' + esc(l.days || 1) + 'd' + (l.approver ? ' &middot; ' + esc(l.approver) : '') + '</div>' +
        (l.reason ? '<div class="het-note">' + esc(l.reason) + '</div>' : '') + '</div>';
    }).join('') + '</div>' : empty('No matching leave requests.');
    box.innerHTML = bar + balHtml + '<div class="het-sec">Requests</div>' + listHtml;
    wire();
  }

  /* ── public API ─────────────────────────────────────────────────────────── */
  var RENDERERS = {
    attendance: renderAttendance,
    checkin: renderCheckin,
    tasks: renderTasks,
    submissions: renderSubmissions,
    leave: renderLeave
  };

  function render(tab, box, ctx) {
    var fn = RENDERERS[tab];
    if (!fn || !box || !ctx || !ctx.email) return false;
    ensureStyle();
    ctx.state = ctx.state || {};
    box.classList.add('het');
    box.setAttribute('data-het-tab', tab);
    fn(box, ctx);
    return true;
  }

  /* Drop cached rows (keep filters) so the next render refetches. */
  function reset(ctx, tab) {
    var s = (ctx && ctx.state) || {};
    var keys = {
      attendance: ['attSummary', 'attError', 'ahData', 'ahError'],
      checkin: ['day', 'dayError', 'punches'],
      tasks: ['tasks', 'tasksError'],
      submissions: ['subs', 'subsError'],
      leave: ['leave', 'leaveError', 'leaveBalance']
    };
    (tab ? [tab] : Object.keys(keys)).forEach(function (t) {
      (keys[t] || []).forEach(function (k) { delete s[k]; });
    });
  }

  window.HRMSEmployeeTabs = {
    render: render,
    reset: reset,
    tabs: Object.keys(RENDERERS),
    esc: esc,
    api: api,
    initials: initials,
    fmtMins: fmtMins,
    isoDate: isoDate,
    todayIso: todayIso,
    rangeFor: rangeFor,
    attendancePct: attendancePct
  };
})();
