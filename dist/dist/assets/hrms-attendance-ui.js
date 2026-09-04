/*
 * hrms-attendance-ui.js
 * ---------------------------------------------------------------------------
 * All of the Organization Attendance admin view's DOM-injection sidecars in
 * one file (merged from the former hrms-attendance-monitoring.js and
 * hrms-attendance-presence-chart.js — same page, same anchor-by-heading-text
 * technique, so they live together now). Two independent, self-guarded IIFEs
 * below, unchanged in behavior from their original separate files:
 *
 *   1. Attendance Monitoring — Requires Attention, Attendance History,
 *      Attendance % & Rates, Leave Analytics, Today's Attendance, and the
 *      Day/Week/Month Monthly Summary (with its per-employee summary popup).
 *      Also turns the employee self-view's "My Recent Attendance" into the
 *      same Attendance History UI, scoped to that employee.
 *
 *   2. Live Team Presence bar chart — turns the "Live Team Presence" status
 *      counts into an animated bar chart, reading the counts straight off
 *      what React already rendered (no separate API call).
 *
 * The page itself is rendered by the pre-built React bundle
 * (dist/dist/assets/index-*.js); its source is not in this repository, so —
 * same no-rebuild injection pattern as hrms-attendance-admin.js — each part
 * finds its card by heading text and enhances it in place.
 */

/* ============================================================================
 * 1. Attendance Monitoring — Requires Attention, Attendance History,
 *    Attendance % & Rates, Leave Analytics, Today's Attendance, Monthly
 *    Summary (Day/Week/Month + per-employee summary popup), and the
 *    employee self-view's Attendance History.
 *
 * Endpoints used (all already permission-gated server side):
 *   GET  /api/attendance?from=&to=[&email=]                 attendance rows
 *   GET  /api/attendance/correction/pending/                pending corrections
 *   POST /api/attendance/correction/approve/                {correctionId, reviewerNote}
 *   POST /api/attendance/correction/reject/                 {correctionId, reviewerNote}
 *   GET  /api/attendance/late-alerts/?date=                 today's late alerts
 *   POST /api/attendance/late-alerts/excuse/                {alertId, excusedBy}
 *   GET  /api/leave?status=Approved                         approved leave requests
 *
 * Identity (X-Actor-Email / Authorization) is attached automatically by
 * hrms-actor.js's window.fetch wrap; nothing here needs to add auth headers.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__hrmsAttendanceMonitoring) return;
  window.__hrmsAttendanceMonitoring = true;

  var ROOT_ID = 'hrms-attn-mon';
  var built = null; // the DOM node, built once and reattached if React wipes it

  /* ── shared helpers (small, local copies — no cross-script coupling) ──── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + r.status));
          return d;
        });
      });
  }
  function actorEmail() {
    try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}).email || 'admin'; }
    catch (_) { return 'admin'; }
  }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayStr() { return ymd(new Date()); }
  function daysAgoStr(n) { var d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }
  function monthStartStr() { var d = new Date(); d.setDate(1); return ymd(d); }
  function hm(mins) { mins = Math.round(mins || 0); return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'; }
  function dayShort(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr + 'T00:00:00');
    return isNaN(d) ? '--' : d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  function initials(name) {
    return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(function (p) { return p[0]; }).join('').toUpperCase();
  }
  /* Weekdays elapsed this month up to today — same definition the bundle's
     own hrWeekdays() uses for the Monthly Summary "Absent"/"Rate" math. */
  function weekdaysSoFar() {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth(), t = d.getDate(), c = 0;
    for (var i = 1; i <= t; i++) {
      var w = new Date(y, m, i).getDay();
      if (w !== 0 && w !== 6) c++;
    }
    return c;
  }
  /* Weekday count within an inclusive [from, to] date range — the same
     "expected working days" denominator, generalized for the Day/Week/Month
     summary toggle. Clamped to at least 1 so a weekend-only range never
     divides by zero. */
  function weekdaysInRange(fromStr, toStr) {
    var from = new Date(fromStr + 'T00:00:00'), to = new Date(toStr + 'T00:00:00'), c = 0;
    for (var d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      var w = d.getDay();
      if (w !== 0 && w !== 6) c++;
    }
    return Math.max(1, c);
  }
  /* Date range for the Day / Week / Month summary toggle. Week starts
     Monday (standard work-week convention) and runs through today. */
  function periodRange(period) {
    var today = new Date();
    if (period === 'day') { var d = todayStr(); return { from: d, to: d }; }
    if (period === 'week') {
      var dow = today.getDay(); // 0=Sun..6=Sat
      var back = dow === 0 ? 6 : dow - 1;
      var monday = new Date(today); monday.setDate(today.getDate() - back);
      return { from: ymd(monday), to: todayStr() };
    }
    return { from: monthStartStr(), to: todayStr() };
  }
  var PERIOD_LABEL = { day: 'Day Summary', week: 'Week Summary', month: 'Monthly Summary' };
  /* Human-readable date / date-range labels for the Monthly Summary "Period"
     column and its per-employee detail modal. */
  function fmtDatePretty(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr + 'T00:00:00');
    return isNaN(d) ? dateStr : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function periodLabel(fromStr, toStr) {
    if (!fromStr || !toStr) return '--';
    return fromStr === toStr ? fmtDatePretty(fromStr) : fmtDatePretty(fromStr) + ' – ' + fmtDatePretty(toStr);
  }
  /* Re-attach a live-typing input's listener so re-rendering the container
     via innerHTML (which detaches the old input) doesn't drop focus/caret —
     the bug fixed in the Attendance History search, reused everywhere else
     a search box rebuilds its own container. */
  function wireSearchInput(container, selector, onChange) {
    var input = container.querySelector(selector);
    if (!input) return;
    input.addEventListener('input', function () {
      var pos = input.selectionStart;
      onChange(input.value);
      var fresh = container.querySelector(selector);
      if (fresh) { fresh.focus(); fresh.setSelectionRange(pos, pos); }
    });
  }

  /* Same idiom as the presence-chart / admin sidecars: find a card by its
     heading text (no stable class/id in the bundle to hook into). */
  function cardContaining(re) {
    var els = document.querySelectorAll('.card, [class*="card"]');
    for (var i = 0; i < els.length; i++) {
      if (re.test((els[i].textContent || '').slice(0, 60))) return els[i];
    }
    return null;
  }

  /* ── Requires Attention ───────────────────────────────────────────────── */
  function RequiresAttention() {
    var el = document.createElement('div');
    el.className = 'card hram-card';
    var tab = 'approvals';
    var data = { approvals: [], late: [], missing: [], highOt: [] };
    var loaded = false;

    function pill(key, label) {
      return '<button type="button" class="hram-pill' + (tab === key ? ' active' : '') + '" data-tab="' + key + '">' +
        esc(label) + ' <span class="hram-pill-count">' + (data[key] ? data[key].length : 0) + '</span></button>';
    }

    function rowHtml(item) {
      var actions = '';
      if (item._kind === 'approvals') {
        actions = '<div class="hram-row-actions">' +
          '<button type="button" class="hram-icon-btn approve" data-approve="' + item.id + '">✓</button>' +
          '<button type="button" class="hram-icon-btn reject" data-reject="' + item.id + '">✕</button>' +
          '</div>';
      } else if (item._kind === 'late') {
        actions = '<div class="hram-row-actions"><button type="button" class="hram-icon-btn approve" data-excuse="' + item.id + '">✓</button></div>';
      }
      return '<div class="hram-attn-row">' +
        '<div class="hram-avatar">' + esc(initials(item.employee)) + '</div>' +
        '<div class="hram-attn-info"><strong>' + esc(item.employee || item.email || 'Unknown') + '</strong><small>' + esc(item._sub) + '</small></div>' +
        actions +
        '</div>';
    }

    function render() {
      var list = data[tab] || [];
      el.innerHTML =
        '<div class="card-title">Requires Attention</div>' +
        '<div class="hram-pill-row">' +
          pill('late', 'Late') + pill('missing', 'Missing') + pill('highOt', 'High OT') + pill('approvals', 'Approvals') +
        '</div>' +
        (!loaded ? '<div class="hram-empty">Loading…</div>' :
          (list.length ? list.map(rowHtml).join('') : '<div class="hram-empty">Nothing needs attention right now.</div>'));

      el.querySelectorAll('[data-tab]').forEach(function (btn) {
        btn.addEventListener('click', function () { tab = btn.getAttribute('data-tab'); render(); });
      });
      el.querySelectorAll('[data-approve]').forEach(function (btn) {
        btn.addEventListener('click', function () { act('approve', btn.getAttribute('data-approve')); });
      });
      el.querySelectorAll('[data-reject]').forEach(function (btn) {
        btn.addEventListener('click', function () { act('reject', btn.getAttribute('data-reject')); });
      });
      el.querySelectorAll('[data-excuse]').forEach(function (btn) {
        btn.addEventListener('click', function () { excuse(btn.getAttribute('data-excuse')); });
      });
    }

    function act(kind, id) {
      api('/api/attendance/correction/' + kind + '/', {
        method: 'POST', body: JSON.stringify({ correctionId: Number(id), reviewerNote: kind === 'approve' ? 'Approved' : 'Rejected' })
      }).then(load).catch(function (e) { console.error('[hrms-attendance-ui]', e); });
    }
    function excuse(id) {
      api('/api/attendance/late-alerts/excuse/', {
        method: 'POST', body: JSON.stringify({ alertId: Number(id), excusedBy: actorEmail() })
      }).then(load).catch(function (e) { console.error('[hrms-attendance-ui]', e); });
    }

    function load() {
      var today = todayStr();
      Promise.all([
        api('/api/attendance/correction/pending/').catch(function () { return []; }),
        api('/api/attendance/late-alerts/?date=' + today).catch(function () { return []; }),
        api('/api/attendance?date=' + today).catch(function () { return []; })
      ]).then(function (res) {
        var corrections = res[0] || [], alerts = res[1] || [], rows = res[2] || [];
        data.approvals = corrections.map(function (c) {
          c._kind = 'approvals';
          c._sub = (c.attendanceDate || '') + ' · ' + (c.reason || 'Correction request');
          return c;
        });
        data.late = alerts.filter(function (a) { return !a.isExcused; }).map(function (a) {
          a._kind = 'late'; a._sub = (a.lateMinutes || 0) + 'm late today';
          return a;
        });
        data.missing = rows.filter(function (r) { return r.checkIn && !r.checkOut; }).map(function (r) {
          r._kind = 'missing'; r._sub = 'Checked in, no checkout yet';
          return r;
        });
        data.highOt = rows.filter(function (r) { return (r.overtimeMinutes || 0) > 120; }).map(function (r) {
          r._kind = 'highOt'; r._sub = (r.overtimeMinutes || 0) + 'm overtime today';
          return r;
        });
        loaded = true;
        render();
      }).catch(function (e) { console.error('[hrms-attendance-ui]', e); loaded = true; render(); });
    }

    render();
    load();
    return el;
  }

  /* ── Attendance History ───────────────────────────────────────────────── */
  function AttendanceHistory() {
    var el = document.createElement('div');
    el.className = 'card hram-card hram-history';
    var range = '30';
    var statusFilter = 'all';
    var search = '';
    var rows = [];
    var loaded = false;

    function fmtTime(t) { return t || '--'; }

    function filtered() {
      return rows.filter(function (r) {
        if (statusFilter !== 'all' && (r.status || '').toLowerCase() !== statusFilter) return false;
        if (search) {
          var q = search.toLowerCase();
          // Search matches employee, email, status, location and date — not
          // just the two fields the placeholder used to advertise.
          var haystack = [r.employee, r.email, r.status, r.isWfh ? 'wfh remote' : 'office', r.date]
            .filter(Boolean).join(' ').toLowerCase();
          if (haystack.indexOf(q) === -1) return false;
        }
        return true;
      });
    }

    function exportCsv() {
      var list = filtered();
      var headers = ['Employee', 'Date', 'Day', 'Check In', 'Check Out', 'Working', 'Break', 'OT', 'Status', 'Mode'];
      var lines = [headers].concat(list.map(function (r) {
        return [r.employee, r.date, dayShort(r.date), fmtTime(r.checkInTime), fmtTime(r.checkOutTime),
          hm(r.workedMinutes), hm(r.breakMinutes), (r.overtimeMinutes || 0) + 'm', r.status, r.isWfh ? 'WFH' : 'Office'];
      }));
      var csv = lines.map(function (row) {
        return row.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'attendance-history.csv'; a.click();
      URL.revokeObjectURL(url);
    }

    function render() {
      var list = filtered();
      el.innerHTML =
        '<div class="hram-history-head">' +
          '<div class="card-title" style="margin:0">Attendance History</div>' +
          '<div class="hram-history-controls">' +
            '<select class="hram-range">' +
              '<option value="7"' + (range === '7' ? ' selected' : '') + '>Last 7 days</option>' +
              '<option value="30"' + (range === '30' ? ' selected' : '') + '>Last 30 days</option>' +
              '<option value="90"' + (range === '90' ? ' selected' : '') + '>Last 90 days</option>' +
            '</select>' +
            '<select class="hram-status">' +
              '<option value="all">All statuses</option>' +
              '<option value="present"' + (statusFilter === 'present' ? ' selected' : '') + '>Present</option>' +
              '<option value="late"' + (statusFilter === 'late' ? ' selected' : '') + '>Late</option>' +
              '<option value="absent"' + (statusFilter === 'absent' ? ' selected' : '') + '>Absent</option>' +
            '</select>' +
            '<input type="text" class="hram-search" placeholder="Search by name, status, or mode" value="' + esc(search) + '" autocomplete="off" autocapitalize="off" spellcheck="false" name="hram-history-q" data-lpignore="true" data-1p-ignore>' +
            '<button type="button" class="hram-btn hram-export">Export CSV</button>' +
          '</div>' +
        '</div>' +
        (!loaded ? '<div class="hram-empty">Loading…</div>' :
          (!list.length ? '<div class="hram-empty">No attendance records for this range.</div>' :
            '<div class="hram-table-wrap"><table class="hram-table"><thead><tr>' +
              '<th>Employee</th><th>Date</th><th>Day</th><th>Check In</th><th>Check Out</th><th>Working</th>' +
              '<th>Break</th><th>OT</th><th>Status</th><th>Mode</th>' +
            '</tr></thead><tbody>' +
            list.slice(0, 200).map(function (r) {
              return '<tr>' +
                '<td class="hram-emp-cell"><div class="hram-emp-row">' +
                  '<span class="hram-avatar hram-avatar-sm">' + esc(initials(r.employee || r.email)) + '</span>' +
                  '<div class="hram-ta-identity">' +
                    '<strong>' + esc(r.employee || r.email || '') + '</strong>' +
                    '<span class="hram-ta-email">' + esc(r.email || '--') + '</span>' +
                  '</div>' +
                '</div></td>' +
                '<td>' + esc(r.date) + '</td><td>' + dayShort(r.date) + '</td>' +
                '<td>' + esc(fmtTime(r.checkInTime)) + '</td><td>' + esc(fmtTime(r.checkOutTime)) + '</td>' +
                '<td>' + hm(r.workedMinutes) + '</td><td>' + hm(r.breakMinutes) + '</td>' +
                '<td>' + (r.overtimeMinutes || 0) + 'm</td>' +
                '<td><span class="hram-status-badge ' + esc((r.status || '').toLowerCase()) + '">' + esc(r.status || '--') + '</span></td>' +
                '<td>' + (r.isWfh ? 'WFH' : 'Office') + '</td>' +
                '</tr>';
            }).join('') +
            '</tbody></table></div>' +
            (list.length > 200 ? '<div class="hram-caption">Showing first 200 of ' + list.length + ' rows — narrow the range or search to see more.</div>' : '')));

      var rangeSel = el.querySelector('.hram-range');
      if (rangeSel) rangeSel.addEventListener('change', function () { range = rangeSel.value; load(); });
      var statusSel = el.querySelector('.hram-status');
      if (statusSel) statusSel.addEventListener('change', function () { statusFilter = statusSel.value; render(); });
      var searchInput = el.querySelector('.hram-search');
      if (searchInput) {
        searchInput.addEventListener('input', function () {
          search = searchInput.value;
          var pos = searchInput.selectionStart;
          render();
          // render() just rebuilt the whole card via innerHTML, so the input
          // above is already detached — re-query the fresh one to restore
          // focus and caret position, or every keystroke drops focus.
          var fresh = el.querySelector('.hram-search');
          if (fresh) { fresh.focus(); fresh.setSelectionRange(pos, pos); }
        });
      }
      var exportBtn = el.querySelector('.hram-export');
      if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    }

    function load() {
      loaded = false; render();
      api('/api/attendance?from=' + daysAgoStr(Number(range)) + '&to=' + todayStr())
        .then(function (data) {
          rows = (Array.isArray(data) ? data : []).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
          loaded = true; render();
        })
        .catch(function (e) { console.error('[hrms-attendance-ui]', e); rows = []; loaded = true; render(); });
    }

    load();
    return el;
  }

  /* ── Attendance % & Rates + Leave Analytics ──────────────────────────── */
  function RatesAndLeave() {
    var wrap = document.createElement('div');
    wrap.className = 'grid-2 hram-grid';
    var ratesCard = document.createElement('div');
    ratesCard.className = 'card hram-card';
    var leaveCard = document.createElement('div');
    leaveCard.className = 'card hram-card';
    wrap.appendChild(ratesCard);
    wrap.appendChild(leaveCard);

    ratesCard.innerHTML = '<div class="card-title">Attendance % &amp; Rates</div><div class="hram-empty">Loading…</div>';
    leaveCard.innerHTML = '<div class="card-title">Leave Analytics</div><div class="hram-empty">Loading…</div>';

    function renderRates(monthRows) {
      var pres = monthRows.filter(function (r) { return r.checkIn; });
      var todayRows = monthRows.filter(function (r) { return r.date === todayStr(); });
      var todayPres = todayRows.filter(function (r) { return r.checkIn; });
      var todayRate = todayRows.length ? Math.round(todayPres.length / todayRows.length * 100) : 0;
      var monthRate = monthRows.length ? Math.round(pres.length / monthRows.length * 100) : 0;
      var avgHours = pres.length ? (pres.reduce(function (s, r) { return s + (r.workedMinutes || 0); }, 0) / pres.length / 60) : 0;
      var ot = monthRows.reduce(function (s, r) { return s + (r.overtimeMinutes || 0); }, 0);
      var avgBreak = pres.length ? (pres.reduce(function (s, r) { return s + (r.breakMinutes || 0); }, 0) / pres.length) : 0;
      var lateCount = monthRows.filter(function (r) { return (r.status || '').toLowerCase() === 'late'; }).length;
      var lateRate = monthRows.length ? Math.round(lateCount / monthRows.length * 100) : 0;

      ratesCard.innerHTML =
        '<div class="card-title">Attendance % &amp; Rates</div>' +
        '<div class="hram-ring-row">' +
          '<div class="hram-ring"><div class="hram-ring-value">' + todayRate + '%</div><div class="hram-ring-label">Today</div></div>' +
          '<div class="hram-ring"><div class="hram-ring-value">' + monthRate + '%</div><div class="hram-ring-label">This month</div></div>' +
          '<div class="hram-ring muted"><div class="hram-ring-value">--</div><div class="hram-ring-label">This quarter</div></div>' +
        '</div>' +
        '<div class="hram-caption">Quarterly view needs a wider backend date range.</div>' +
        '<div class="hram-rate-tiles">' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Avg Hours/Day</div><div class="hram-rate-value">' + avgHours.toFixed(1) + 'h</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Overtime (Month)</div><div class="hram-rate-value warn">' + Math.round(ot) + 'm</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Avg Break</div><div class="hram-rate-value">' + hm(avgBreak) + '</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Late Rate</div><div class="hram-rate-value good">' + lateRate + '%</div></div>' +
        '</div>';
    }

    function renderLeave(leaves) {
      var now = new Date();
      var thisMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      var d3 = new Date(); d3.setMonth(d3.getMonth() - 3);
      var thisMonth = 0, last3 = 0, totalDays = 0;
      var monthCounts = {};
      leaves.forEach(function (l) {
        var key = (l.fromDate || '').slice(0, 7);
        totalDays += l.days || 0;
        if (key === thisMonthKey) thisMonth += l.days || 0;
        if (l.fromDate && new Date(l.fromDate) >= d3) last3 += l.days || 0;
        if (key) monthCounts[key] = (monthCounts[key] || 0) + (l.days || 0);
      });
      var months = Object.keys(monthCounts).sort().slice(-6);
      var maxDays = Math.max.apply(null, months.map(function (k) { return monthCounts[k]; }).concat([1]));

      leaveCard.innerHTML =
        '<div class="card-title">Leave Analytics</div>' +
        '<div class="hram-leave-stats">' +
          '<div><div class="hram-rate-value">' + thisMonth + '</div><div class="hram-rate-label">This month</div></div>' +
          '<div><div class="hram-rate-value">' + last3 + '</div><div class="hram-rate-label">Last 3 mo</div></div>' +
          '<div><div class="hram-rate-value">' + totalDays + '</div><div class="hram-rate-label">Total days</div></div>' +
        '</div>' +
        (!leaves.length ? '<div class="hram-empty">No approved leave yet.</div>' :
          '<div class="hram-leave-list">' + leaves.slice(0, 4).map(function (l) {
            return '<div class="hram-leave-row"><span>' + esc(l.employee || l.email) + '</span><span class="hram-muted">' +
              esc(l.fromDate) + ' → ' + esc(l.toDate) + ' · ' + esc(l.days) + 'd</span></div>';
          }).join('') + '</div>') +
        '<div class="hram-caption">Approved leave · last ' + (months.length || 0) + ' months</div>' +
        '<div class="hram-trend-row">' + months.map(function (k) {
          var h = Math.max(4, Math.round(monthCounts[k] / maxDays * 28));
          return '<div class="hram-trend-bar" style="height:' + h + 'px" title="' + k + ': ' + monthCounts[k] + 'd"></div>';
        }).join('') + '</div>';
    }

    Promise.all([
      api('/api/attendance?from=' + monthStartStr() + '&to=' + todayStr()).catch(function () { return []; }),
      api('/api/leave?status=Approved').catch(function () { return []; })
    ]).then(function (res) {
      renderRates(Array.isArray(res[0]) ? res[0] : []);
      renderLeave(Array.isArray(res[1]) ? res[1] : []);
    }).catch(function (e) {
      console.error('[hrms-attendance-ui]', e);
      ratesCard.innerHTML = '<div class="card-title">Attendance % &amp; Rates</div><div class="hram-empty">Could not load rates.</div>';
      leaveCard.innerHTML = '<div class="card-title">Leave Analytics</div><div class="hram-empty">Could not load leave data.</div>';
    });

    return wrap;
  }

  /* ── Today's Attendance (replaces "Top Attendance (This Month)") ────────
     Controls (search + status filter) are built ONCE and never rebuilt —
     only the list below them re-renders on every filter change. That's what
     lets them live inside the card's title row, right-aligned next to the
     heading, without ever losing focus mid-keystroke. */
  function TodaysAttendanceWidget() {
    var controls = document.createElement('div');
    controls.className = 'hram-ta-controls';
    var body = document.createElement('div');
    var search = '', statusFilter = 'all', rows = [], loaded = false;

    function filtered() {
      return rows.filter(function (r) {
        if (statusFilter !== 'all' && (r.status || '').toLowerCase() !== statusFilter) return false;
        if (search) {
          var q = search.toLowerCase();
          var hay = [r.employee, r.email, r.status].filter(Boolean).join(' ').toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
    }

    function renderBody() {
      var list = filtered();
      body.innerHTML = !loaded ? '<div class="hram-empty">Loading…</div>' :
        (!list.length ? '<div class="hram-empty">No attendance records for today.</div>' :
          list.map(function (r, i) {
            return '<div class="hram-ta-row">' +
              '<span class="hram-muted hram-ta-num">' + (i + 1) + '</span>' +
              '<span class="hram-avatar">' + esc(initials(r.employee || r.email)) + '</span>' +
              '<div class="hram-ta-identity">' +
                '<strong>' + esc(r.employee || r.email || '') + '</strong>' +
                '<span class="hram-ta-email">' + esc(r.email || '--') + '</span>' +
              '</div>' +
              '<div class="hram-ta-meta">' +
                '<span class="hram-status-badge ' + esc((r.status || '').toLowerCase()) + '">' + esc(r.status || '--') + '</span>' +
                '<span class="hram-muted">' + esc(r.checkInTime || '--') + ' → ' + esc(r.checkOutTime || '--') + '</span>' +
              '</div>' +
              '</div>';
          }).join(''));
    }

    controls.innerHTML =
      '<input type="text" class="hram-ta-search" placeholder="Search employee" autocomplete="off" autocapitalize="off" spellcheck="false" name="hram-today-q" data-lpignore="true" data-1p-ignore>' +
      '<select class="hram-ta-status">' +
        '<option value="all">All statuses</option>' +
        '<option value="present">Present</option>' +
        '<option value="late">Late</option>' +
        '<option value="absent">Absent</option>' +
      '</select>';
    controls.querySelector('.hram-ta-search').addEventListener('input', function (e) { search = e.target.value; renderBody(); });
    controls.querySelector('.hram-ta-status').addEventListener('change', function (e) { statusFilter = e.target.value; renderBody(); });

    function load() {
      api('/api/attendance?date=' + todayStr()).then(function (data) {
        rows = Array.isArray(data) ? data : [];
        loaded = true; renderBody();
      }).catch(function (e) { console.error('[hrms-attendance-ui]', e); rows = []; loaded = true; renderBody(); });
    }

    renderBody(); load();
    return { controls: controls, body: body };
  }

  function enhanceTodaysAttendance() {
    var card = cardContaining(/Top Attendance|Today.s Attendance/i);
    if (!card) return;
    var title = card.querySelector('.card-title');
    if (!title) return;

    // Hide whatever React rendered under the title, every tick — a re-render
    // can bring its own "Top Attendance" list/empty-state back.
    Array.prototype.slice.call(card.children).forEach(function (child) {
      if (child !== title && child.id !== 'hram-today-attn') child.style.display = 'none';
    });

    if (card.querySelector('#hram-today-attn')) return; // already built

    // Build exactly one widget instance and place its two halves: controls
    // go inside the (now flex) title row, right-aligned next to the label;
    // the body goes in its own host below. Marked by our own class so later
    // ticks never rebuild the title and disturb the live controls inside it.
    title.classList.add('hram-title-row');
    title.textContent = '';
    var label = document.createElement('span');
    label.textContent = "Today's Attendance";
    title.appendChild(label);

    var widget = TodaysAttendanceWidget();
    title.appendChild(widget.controls);
    var host = document.createElement('div');
    host.id = 'hram-today-attn';
    host.appendChild(widget.body);
    card.appendChild(host);
  }

  /* ── Monthly Summary: Day/Week/Month toggle + search + rate filter ──────
     Recomputes the same per-employee aggregate the bundle's own Monthly
     Summary table does (present/absent/late/overtime/rate), independently,
     over whichever range the toggle selects, so it can be filtered
     client-side without needing access to React's internal state.
     titleLeft (heading label + period toggle) sits left of the heading row;
     controls (search + rate filter) sit at the right — same split as
     Today's Attendance, so nothing here rebuilds on every keystroke. */
  function MonthlySummaryWidget() {
    var titleLeft = document.createElement('span');
    titleLeft.className = 'hram-title-left';
    var label = document.createElement('span');
    var periodBar = document.createElement('span');
    periodBar.className = 'hram-period-row';
    titleLeft.appendChild(label);
    titleLeft.appendChild(periodBar);

    var controls = document.createElement('div');
    controls.className = 'hram-ta-controls';
    var body = document.createElement('div');
    var search = '', rateFilter = 'all', period = 'month', rows = [], loaded = false;
    var dateRange = null; // {from, to} for whichever period is currently loaded

    function filtered() {
      return rows.filter(function (a) {
        if (rateFilter === 'high' && a.rate < 90) return false;
        if (rateFilter === 'medium' && (a.rate < 75 || a.rate >= 90)) return false;
        if (rateFilter === 'low' && a.rate >= 75) return false;
        if (search && (a.name || '').toLowerCase().indexOf(search.toLowerCase()) === -1) return false;
        return true;
      });
    }

    function renderBody() {
      var list = filtered();
      var periodText = dateRange ? periodLabel(dateRange.from, dateRange.to) : '--';
      body.innerHTML = !loaded ? '<div class="hram-empty">Loading…</div>' :
        (!list.length ? '<div class="hram-empty">No attendance records for this period yet.</div>' :
          '<div class="hram-table-wrap"><table class="hram-table"><thead><tr>' +
            '<th>#</th><th>ID</th><th>Employee</th><th>Period</th>' +
          '</tr></thead><tbody>' +
          list.map(function (a, i) {
            return '<tr class="hram-row-click" title="View ' + esc(PERIOD_LABEL[period].toLowerCase()) + ' for ' + esc(a.name || a.email || '') + '">' +
              '<td class="hram-muted">' + (i + 1) + '</td><td class="hram-strong">' + esc(a.email || '--') + '</td>' +
              '<td class="hram-strong">' + esc(a.name) + '</td><td>' + esc(periodText) + '</td></tr>';
          }).join('') + '</tbody></table></div>' +
          '<div class="hram-caption">Click an employee to view their summary for this period (present, absent, late, overtime, rate).</div>');

      Array.prototype.forEach.call(body.querySelectorAll('.hram-row-click'), function (tr, idx) {
        tr.addEventListener('click', function () {
          if (!dateRange) return;
          openMonthlySummaryDetail(list[idx], period, dateRange);
        });
      });
    }

    function renderPeriodBar() {
      label.textContent = PERIOD_LABEL[period];
      periodBar.innerHTML = ['day', 'week', 'month'].map(function (p) {
        var text = p.charAt(0).toUpperCase() + p.slice(1);
        return '<button type="button" class="hram-period-btn' + (period === p ? ' active' : '') + '" data-period="' + p + '">' + text + '</button>';
      }).join('');
      Array.prototype.forEach.call(periodBar.querySelectorAll('[data-period]'), function (btn) {
        btn.addEventListener('click', function () {
          if (period === btn.getAttribute('data-period')) return;
          period = btn.getAttribute('data-period');
          renderPeriodBar();
          load();
        });
      });
    }

    controls.innerHTML =
      '<input type="text" class="hram-ms-search" placeholder="Search employee" autocomplete="off" autocapitalize="off" spellcheck="false" name="hram-ms-q" data-lpignore="true" data-1p-ignore>' +
      '<select class="hram-ms-rate">' +
        '<option value="all">All rates</option>' +
        '<option value="high">High (≥90%)</option>' +
        '<option value="medium">Medium (75–89%)</option>' +
        '<option value="low">Low (&lt;75%)</option>' +
      '</select>';
    controls.querySelector('.hram-ms-search').addEventListener('input', function (e) { search = e.target.value; renderBody(); });
    controls.querySelector('.hram-ms-rate').addEventListener('change', function (e) { rateFilter = e.target.value; renderBody(); });

    function load() {
      loaded = false; renderBody();
      var range = periodRange(period);
      dateRange = range;
      // "ID" is the company email — already on every attendance row — not
      // a separate employee-ID field (the schema's only employee_id column
      // belongs to HrVerification's candidate background checks, unrelated).
      api('/api/attendance?from=' + range.from + '&to=' + range.to).then(function (data) {
        var list = Array.isArray(data) ? data : [];
        var wd = weekdaysInRange(range.from, range.to);
        var agg = {};
        list.forEach(function (r) {
          var k = r.email; if (!k) return;
          var a = agg[k] || (agg[k] = {
            name: r.employee || k.split('@')[0], email: k, present: 0, late: 0, min: 0
          });
          if (r.checkIn) a.present++;
          if ((r.status || '').toLowerCase() === 'late') a.late++;
          a.min += (r.workedMinutes || 0);
        });
        rows = Object.keys(agg).map(function (k) {
          var a = agg[k];
          return {
            name: a.name, email: a.email, present: a.present, absent: Math.max(wd - a.present, 0), late: a.late,
            ot: Math.max(Math.round((a.min - a.present * 480) / 60), 0),
            rate: wd ? Math.round(a.present / wd * 100) : 0
          };
        }).sort(function (x, y) { return y.rate - x.rate; });
        loaded = true; renderBody();
      }).catch(function (e) { console.error('[hrms-attendance-ui]', e); rows = []; loaded = true; renderBody(); });
    }

    renderPeriodBar();
    renderBody(); load();
    return { titleLeft: titleLeft, controls: controls, body: body };
  }

  /* ── Monthly Summary: per-employee summary drill-down ────────────────────
     Opened by clicking a row in the Monthly/Week/Day Summary table. Shows
     that employee's already-computed aggregate for the exact period the
     row belongs to (present/absent/late/overtime/rate) as a stats card —
     deliberately NOT a day-by-day history dump, which is what the separate
     Attendance History card further down the page already covers. Self-
     contained overlay — closes on backdrop click, the Close button, or
     Escape. */
  function openMonthlySummaryDetail(row, period, range) {
    var existing = document.getElementById('hram-detail-overlay');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var cls = row.rate >= 90 ? 'present' : (row.rate >= 75 ? '' : 'late');
    var back = document.createElement('div');
    back.id = 'hram-detail-overlay';
    back.className = 'hram-back';
    back.innerHTML =
      '<div class="hram-modal hram-modal-narrow">' +
        '<div class="hram-modal-head">' +
          '<div><div class="hram-modal-title">' + esc(row.name || row.email || 'Employee') + '</div>' +
          '<div class="hram-modal-sub">' + esc(row.email || '') + ' · ' + esc(PERIOD_LABEL[period] || 'Summary') + ' · ' + esc(periodLabel(range.from, range.to)) + '</div></div>' +
          '<button type="button" class="hram-btn" id="hram-detail-close">Close</button>' +
        '</div>' +
        '<div class="hram-rate-tiles">' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Present</div><div class="hram-rate-value good">' + row.present + '</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Absent</div><div class="hram-rate-value warn">' + row.absent + '</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Late</div><div class="hram-rate-value">' + row.late + '</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Overtime</div><div class="hram-rate-value">' + row.ot + 'h</div></div>' +
          '<div class="hram-rate-tile"><div class="hram-rate-label">Rate</div><div class="hram-rate-value"><span class="hram-status-badge ' + cls + '">' + row.rate + '%</span></div></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    function shut() {
      if (back.parentNode) back.parentNode.removeChild(back);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    back.querySelector('#hram-detail-close').addEventListener('click', shut);
    back.addEventListener('click', function (e) { if (e.target === back) shut(); });
    document.addEventListener('keydown', onKey);
  }

  function enhanceMonthlySummary() {
    // The heading text itself now switches with the Day/Week/Month toggle,
    // so match on any of the three — otherwise switching away from "Month"
    // would make this card un-findable on the next tick.
    var card = cardContaining(/Monthly Summary|Day Summary|Week Summary/i);
    if (!card) return null;
    var title = card.querySelector('.card-title');
    if (!title) return card;

    Array.prototype.slice.call(card.children).forEach(function (child) {
      if (child !== title && child.id !== 'hram-monthly-summary') child.style.display = 'none';
    });

    if (!card.querySelector('#hram-monthly-summary')) {
      // Same atomic rebuild as Today's Attendance: clear and recreate the
      // title's label+toggle and controls together with the body, in one
      // pass, so there's never a chance of two search boxes (or two period
      // toggles) stacking up in the title.
      title.classList.add('hram-title-row');
      title.textContent = '';

      var widget = MonthlySummaryWidget();
      title.appendChild(widget.titleLeft); // label + Day/Week/Month toggle
      title.appendChild(widget.controls);  // search + rate filter, right-aligned
      var host = document.createElement('div');
      host.id = 'hram-monthly-summary';
      host.appendChild(widget.body);
      card.appendChild(host);
    }
    return card;
  }

  /* ── styles (injected once) ─────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('hrms-attn-mon-style')) return;
    var style = document.createElement('style');
    style.id = 'hrms-attn-mon-style';
    style.textContent =
      '.hram-card{margin-top:14px}' +
      '.hram-pill-row{display:flex;gap:8px;margin:10px 0 12px;flex-wrap:wrap}' +
      '.hram-pill{padding:6px 12px;border-radius:999px;border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#f9fafb);font-size:12px;font-weight:600;color:var(--text2,#4b5563);cursor:pointer}' +
      '.hram-pill.active{background:var(--text,#111827);color:#fff;border-color:var(--text,#111827)}' +
      '.hram-pill-count{opacity:.75}' +
      '.hram-attn-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border2,#f3f4f6)}' +
      '.hram-attn-row:last-child{border-bottom:none}' +
      '.hram-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#8b7bf0,#6d5ce8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}' +
      '.hram-attn-info{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}' +
      '.hram-attn-info strong{font-size:13px;color:var(--text,#111827)}' +
      '.hram-attn-info small{font-size:11px;color:var(--text3,#6b7280)}' +
      '.hram-row-actions{display:flex;gap:6px;flex-shrink:0}' +
      '.hram-icon-btn{width:26px;height:26px;border-radius:6px;border:none;cursor:pointer;font-weight:700;font-size:12px;color:#fff}' +
      '.hram-icon-btn.approve{background:var(--success,#10b981)}' +
      '.hram-icon-btn.reject{background:var(--danger,#ef4444)}' +
      '.hram-empty{text-align:center;padding:22px 10px;color:var(--text3,#9ca3af);font-size:13px}' +
      '.hram-history-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px}' +
      '.hram-history-controls{display:flex;gap:8px;flex-wrap:wrap}' +
      '.hram-history-controls select,.hram-history-controls input{padding:6px 9px;border:1px solid var(--border2,#d1d5db);border-radius:6px;font-size:12px;background:var(--bg,#fff);color:var(--text,#111827)}' +
      '.hram-history-controls input.hram-search{width:190px}' +
      '.hram-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--border2,#d1d5db);background:var(--bg,#fff);color:var(--text,#111827);font-size:12px;font-weight:600;cursor:pointer}' +
      '.hram-btn:hover{background:var(--bg3,#f3f4f6)}' +
      '.hram-table-wrap{overflow-x:auto}' +
      '.hram-table{width:100%;border-collapse:collapse;font-size:12px}' +
      '.hram-table thead{background:var(--bg3,#f9fafb)}' +
      '.hram-table th{text-align:left;padding:9px;font-weight:600;color:var(--text3,#6b7280);text-transform:uppercase;font-size:10px;letter-spacing:.03em;white-space:nowrap}' +
      '.hram-table td{padding:9px;border-bottom:1px solid var(--border2,#f3f4f6);white-space:nowrap}' +
      '.hram-strong{font-weight:600;color:var(--text,#111827)}' +
      '.hram-emp-cell{white-space:normal}' +
      '.hram-emp-row{display:flex;align-items:center;gap:8px;min-width:170px}' +
      '.hram-avatar-sm{width:26px;height:26px;font-size:10px}' +
      '.hram-status-badge{display:inline-block;padding:3px 8px;border-radius:4px;font-weight:600;font-size:10px;text-transform:capitalize;background:var(--bg3,#f3f4f6);color:var(--text2,#374151)}' +
      '.hram-status-badge.late{background:#fef3c7;color:#92400e}' +
      '.hram-status-badge.present{background:#dcfce7;color:#166534}' +
      '.hram-status-badge.absent{background:#fee2e2;color:#991b1b}' +
      '.hram-caption{font-size:11px;color:var(--text3,#9ca3af);margin-top:8px}' +
      '.hram-grid{margin-top:14px}' +
      '.hram-ring-row{display:flex;gap:16px;margin-bottom:8px}' +
      '.hram-ring{width:72px;height:72px;border-radius:50%;border:6px solid var(--success,#a7f3d0);display:flex;flex-direction:column;align-items:center;justify-content:center}' +
      '.hram-ring.muted{border-color:var(--border2,#e5e7eb)}' +
      '.hram-ring-value{font-size:14px;font-weight:700;color:var(--text,#111827)}' +
      '.hram-ring-label{font-size:9px;color:var(--text3,#6b7280);text-transform:uppercase;margin-top:2px}' +
      '.hram-rate-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-top:10px}' +
      '.hram-rate-tile{background:var(--bg3,#f9fafb);border:1px solid var(--border2,#e5e7eb);border-radius:8px;padding:9px}' +
      '.hram-rate-label{font-size:10px;text-transform:uppercase;color:var(--text3,#9ca3af);margin-bottom:4px}' +
      '.hram-rate-value{font-size:17px;font-weight:700;color:var(--text,#111827)}' +
      '.hram-rate-value.good{color:#059669}.hram-rate-value.warn{color:#d97706}' +
      '.hram-leave-stats{display:flex;gap:22px;margin-bottom:12px}' +
      '.hram-leave-list{margin-bottom:10px}' +
      '.hram-leave-row{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border2,#f3f4f6)}' +
      '.hram-muted{color:var(--text3,#9ca3af)}' +
      '.hram-trend-row{display:flex;align-items:flex-end;gap:5px;height:28px;margin-top:6px}' +
      '.hram-trend-bar{flex:1;background:var(--accent,#6366f1);border-radius:2px 2px 0 0;min-width:6px}' +
      '.hram-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}' +
      '.hram-title-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.hram-period-row{display:inline-flex;gap:4px;background:var(--bg3,#f3f4f6);padding:3px;border-radius:8px}' +
      '.hram-period-btn{padding:4px 10px;border:none;border-radius:6px;background:transparent;font-size:11px;font-weight:600;text-transform:none;letter-spacing:normal;color:var(--text2,#4b5563);cursor:pointer}' +
      '.hram-period-btn.active{background:var(--bg,#fff);color:var(--text,#111827);box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
      '.hram-period-btn:hover:not(.active){color:var(--text,#111827)}' +
      '.hram-ta-controls{display:flex;gap:8px;flex-wrap:wrap;margin:0}' +
      '.hram-ta-controls input,.hram-ta-controls select,.hram-ms-search,.hram-ms-rate{padding:6px 9px;border:1px solid var(--border2,#d1d5db);border-radius:6px;font-size:12px;font-weight:400;text-transform:none;background:var(--bg,#fff);color:var(--text,#111827)}' +
      '.hram-ta-search{width:190px}' +
      '.hram-ms-search{width:190px}' +
      '.hram-ta-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border2,#f3f4f6)}' +
      '.hram-ta-row:last-child{border-bottom:none}' +
      '.hram-ta-num{width:16px;flex-shrink:0;font-size:11px;text-align:right}' +
      '.hram-ta-identity{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}' +
      '.hram-ta-identity strong{font-size:13px;font-weight:700;color:var(--text,#111827)}' +
      '.hram-ta-email{font-size:12px;color:var(--accent,#2563eb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.hram-ta-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}' +
      '.hram-row-click{cursor:pointer}' +
      '.hram-row-click:hover td{background:var(--bg3,#f9fafb)}' +
      '.hram-back{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}' +
      '.hram-modal{background:var(--bg,#fff);color:var(--text,#111827);border-radius:12px;padding:20px;max-width:900px;width:100%;max-height:82vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.3)}' +
      '.hram-modal-narrow{max-width:460px}' +
      '.hram-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}' +
      '.hram-modal-title{font-size:15px;font-weight:700;color:var(--text,#111827)}' +
      '.hram-modal-sub{font-size:12px;color:var(--text3,#6b7280);margin-top:2px}' +
      '@media (max-width:900px){.hram-grid{grid-template-columns:1fr}.hram-ta-meta{display:none}}';
    document.head.appendChild(style);
  }

  /* ── Live Team Presence: narrower column only ─────────────────────────
     That card and its bar chart are entirely owned by the Live Team
     Presence section below (part 2 of this file) and never touched here.
     The only thing this part does to it is give it a smaller share of the
     grid row so its sibling ("Today's Attendance") gets more room — no
     search box (removed per feedback: it didn't belong there). */
  function enhancePresenceCard() {
    var card = cardContaining(/Live Team Presence/i);
    if (!card) return;

    // Reapplied every tick since it's a cheap inline style set on this
    // specific element instance, not a shared class.
    var parent = card.parentElement;
    if (parent && /grid-2/.test(parent.className || '')) {
      parent.style.gridTemplateColumns = '0.8fr 1.2fr';
    }

    var stale = card.querySelector('#hram-presence-search');
    if (stale) stale.remove(); // drop a previously-injected search box, if any
  }

  /* ── Employee self-view: replace "My Recent Attendance" with a proper
     Attendance History (date range + status filter + CSV export), scoped to
     the signed-in employee's own records only. Everything else on this page
     — Requires Attention, Today's Attendance, Rates, Leave Analytics, the
     Monthly Summary toggle — is admin-only content rendered by hrAdminDash;
     hrUserDash (what a plain employee sees) never has those cards to begin
     with, so enhanceMonthlySummary()'s anchor lookup fails there and tick()
     bails out before mounting any of them. This is the one thing employees
     get. */
  function EmployeeAttendanceHistoryWidget(email) {
    var el = document.createElement('div');
    var range = '30', statusFilter = 'all', rows = [], loaded = false;

    function filtered() {
      return rows.filter(function (r) {
        if (statusFilter !== 'all' && (r.status || '').toLowerCase() !== statusFilter) return false;
        return true;
      });
    }

    function fmtTime(t) { return t || '--'; }

    function exportCsv() {
      var list = filtered();
      var headers = ['Date', 'Day', 'Check In', 'Check Out', 'Working', 'Break', 'OT', 'Status', 'Mode'];
      var lines = [headers].concat(list.map(function (r) {
        return [r.date, dayShort(r.date), fmtTime(r.checkInTime), fmtTime(r.checkOutTime),
          hm(r.workedMinutes), hm(r.breakMinutes), (r.overtimeMinutes || 0) + 'm', r.status, r.isWfh ? 'WFH' : 'Office'];
      }));
      var csv = lines.map(function (row) {
        return row.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'my-attendance-history.csv'; a.click();
      URL.revokeObjectURL(url);
    }

    function render() {
      var list = filtered();
      el.innerHTML =
        '<div class="hram-history-head">' +
          '<div class="card-title" style="margin:0">Attendance History</div>' +
          '<div class="hram-history-controls">' +
            '<select class="hram-range">' +
              '<option value="7"' + (range === '7' ? ' selected' : '') + '>Last 7 days</option>' +
              '<option value="30"' + (range === '30' ? ' selected' : '') + '>Last 30 days</option>' +
              '<option value="90"' + (range === '90' ? ' selected' : '') + '>Last 90 days</option>' +
            '</select>' +
            '<select class="hram-status">' +
              '<option value="all">All statuses</option>' +
              '<option value="present"' + (statusFilter === 'present' ? ' selected' : '') + '>Present</option>' +
              '<option value="late"' + (statusFilter === 'late' ? ' selected' : '') + '>Late</option>' +
              '<option value="absent"' + (statusFilter === 'absent' ? ' selected' : '') + '>Absent</option>' +
            '</select>' +
            '<button type="button" class="hram-btn hram-export">Export CSV</button>' +
          '</div>' +
        '</div>' +
        (!loaded ? '<div class="hram-empty">Loading…</div>' :
          (!list.length ? '<div class="hram-empty">No attendance records for this range.</div>' :
            '<div class="hram-table-wrap"><table class="hram-table"><thead><tr>' +
              '<th>Date</th><th>Day</th><th>Check In</th><th>Check Out</th><th>Working</th>' +
              '<th>Break</th><th>OT</th><th>Status</th><th>Mode</th>' +
            '</tr></thead><tbody>' +
            list.slice(0, 200).map(function (r) {
              return '<tr>' +
                '<td class="hram-strong">' + esc(r.date) + '</td><td>' + dayShort(r.date) + '</td>' +
                '<td>' + esc(fmtTime(r.checkInTime)) + '</td><td>' + esc(fmtTime(r.checkOutTime)) + '</td>' +
                '<td>' + hm(r.workedMinutes) + '</td><td>' + hm(r.breakMinutes) + '</td>' +
                '<td>' + (r.overtimeMinutes || 0) + 'm</td>' +
                '<td><span class="hram-status-badge ' + esc((r.status || '').toLowerCase()) + '">' + esc(r.status || '--') + '</span></td>' +
                '<td>' + (r.isWfh ? 'WFH' : 'Office') + '</td>' +
                '</tr>';
            }).join('') +
            '</tbody></table></div>'));

      var rangeSel = el.querySelector('.hram-range');
      if (rangeSel) rangeSel.addEventListener('change', function () { range = rangeSel.value; load(); });
      var statusSel = el.querySelector('.hram-status');
      if (statusSel) statusSel.addEventListener('change', function () { statusFilter = statusSel.value; render(); });
      var exportBtn = el.querySelector('.hram-export');
      if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    }

    function load() {
      loaded = false; render();
      api('/api/attendance?email=' + encodeURIComponent(email) + '&from=' + daysAgoStr(Number(range)) + '&to=' + todayStr())
        .then(function (data) {
          rows = (Array.isArray(data) ? data : []).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
          loaded = true; render();
        })
        .catch(function (e) { console.error('[hrms-attendance-ui]', e); rows = []; loaded = true; render(); });
    }

    load();
    return el;
  }

  function enhanceEmployeeHistory() {
    var card = cardContaining(/My Recent Attendance|^Attendance History/i);
    if (!card) return;
    // Never touch this on the admin page — our own "Attendance History" card
    // there already has this exact same heading; only replace the personal
    // one, which the bundle always titles "My Recent Attendance" up front.
    if (card.id === ROOT_ID || card.closest('#' + ROOT_ID)) return;

    var title = card.querySelector('.card-title');
    if (!title) return;
    // The widget appended below renders its own "Attendance History" heading
    // (together with the range/status/export controls) — leaving this outer
    // title visible too just duplicated it. Every tick, since React can
    // reset inline styles on its own nodes.
    title.style.display = 'none';

    Array.prototype.slice.call(card.children).forEach(function (child) {
      if (child !== title && child.id !== 'hram-emp-history') child.style.display = 'none';
    });

    // "Only the attendance history table should be available" for the
    // employee view — hide every OTHER sibling in hrUserDash's page (the
    // stat-grid tiles etc. rendered above this card), every tick, since
    // React can re-render them back.
    var parent = card.parentElement;
    if (parent) {
      Array.prototype.slice.call(parent.children).forEach(function (sibling) {
        if (sibling !== card) sibling.style.display = 'none';
      });
    }

    if (card.querySelector('#hram-emp-history')) return; // already built
    var host = document.createElement('div');
    host.id = 'hram-emp-history';
    card.appendChild(host);
    host.appendChild(EmployeeAttendanceHistoryWidget(actorEmail()));
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  function buildOnce() {
    if (built) return built;
    injectStyles();
    var container = document.createElement('div');
    container.id = ROOT_ID;
    container.appendChild(RequiresAttention());
    container.appendChild(AttendanceHistory());
    container.appendChild(RatesAndLeave());
    built = container;
    return container;
  }

  function tick() {
    injectStyles();
    enhanceEmployeeHistory(); // no-op unless this is the personal (non-admin) attendance view
    enhancePresenceCard();
    enhanceTodaysAttendance();
    var anchor = enhanceMonthlySummary();
    if (!anchor || !anchor.parentElement) return; // not on the admin attendance view (yet)
    var node = buildOnce();
    if (node.parentElement !== anchor.parentElement || node.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement('afterend', node);
    }
  }

  function start() {
    tick();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      setTimeout(function () { scheduled = false; tick(); }, 80);
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', tick);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ============================================================================
 * 2. Live Team Presence bar chart — turns the "Live Team Presence" section
 *    of the Organization Attendance admin view into a proper animated bar
 *    chart. Everything else on the Attendance page (stat cards, Today's
 *    Attendance, Monthly Summary, the personal "My Attendance" view) is
 *    left completely alone — see part 1 above for that.
 *
 *    We deliberately do NOT fetch the counts from an API: the exact endpoint
 *    backing this bundled page is unknown (its source is lost), and reading
 *    the numbers React already rendered guarantees the chart can never
 *    disagree with the rest of the page.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__hrmsPresenceChart) return;
  window.__hrmsPresenceChart = true;

  var LABELS = ['In Office', 'Remote', 'On Break', 'Absent'];
  var COLORS = {
    'In Office': 'var(--success,#16a34a)',
    'Remote': 'var(--accent,#2563eb)',
    'On Break': 'var(--warn,#d97706)',
    'Absent': 'var(--danger,#dc2626)'
  };
  var CHART_ID = 'hrms-presence-chart';
  var HIDDEN_FLAG = 'hrmsPresenceOrigHidden';
  var POLL_MS = 15000;

  /* ── find the card by heading text (same idiom as the other sidecars) ── */
  function cardContaining(re) {
    var els = document.querySelectorAll('.card, [class*="card"]');
    for (var i = 0; i < els.length; i++) {
      if (re.test(els[i].textContent || '')) return els[i];
    }
    return null;
  }
  function presenceCard() { return cardContaining(/Live Team Presence/i); }

  /* Leaf elements only (no element children) — labels and count pills are
     always leaves, whatever class names the bundle happens to use. Excludes
     our own previously-injected chart: once it exists its <text> labels and
     values would otherwise be re-scanned as if they were fresh page content,
     poisoning every subsequent read. */
  function leaves(root) {
    var out = [];
    var all = root.querySelectorAll('*');
    var ownChart = document.getElementById(CHART_ID);
    for (var i = 0; i < all.length; i++) {
      if (ownChart && ownChart.contains(all[i])) continue;
      if (all[i].children.length === 0) out.push(all[i]);
    }
    return out;
  }

  /* Read the 4 status counts straight off the rendered DOM: walk the card's
     leaf elements in document order, and for each label leaf take the first
     following leaf (before the next label) whose text is a bare integer —
     that's the count pill next to it, regardless of what markup wraps it. */
  function extractRows(card) {
    var ls = leaves(card);
    var hits = [];
    for (var i = 0; i < ls.length; i++) {
      var text = (ls[i].textContent || '').trim();
      var label = LABELS.filter(function (l) { return l.toLowerCase() === text.toLowerCase(); })[0];
      if (label) hits.push({ label: label, index: i, el: ls[i] });
    }
    if (hits.length < LABELS.length) return null; // page hasn't rendered the section (yet)

    var rows = [];
    for (var h = 0; h < hits.length; h++) {
      var start = hits[h].index + 1;
      var end = (h + 1 < hits.length) ? hits[h + 1].index : ls.length;
      var count = null, countEl = null;
      for (var j = start; j < end; j++) {
        var t = (ls[j].textContent || '').trim();
        if (/^\d+$/.test(t)) { count = parseInt(t, 10); countEl = ls[j]; break; }
      }
      if (count === null) return null; // couldn't confidently read this row — bail, leave the original UI alone
      rows.push({ label: hits[h].label, count: count, labelEl: hits[h].el, countEl: countEl });
    }
    return rows;
  }

  /* Nearest common ancestor of two elements — used per-row (label + its count
     pill) rather than across all 4 rows at once: the rows are not guaranteed
     to share one wrapper distinct from the card itself (on the real page they
     don't — each row's own small container is the only thing safe to hide). */
  function commonAncestor(card, a, b) {
    function ancestors(el) {
      var chain = [];
      while (el && el !== card.parentElement) { chain.push(el); el = el.parentElement; }
      return chain;
    }
    var chainB = ancestors(b);
    var chainA = ancestors(a);
    for (var i = 0; i < chainA.length; i++) {
      if (chainB.indexOf(chainA[i]) !== -1) return chainA[i];
    }
    return card;
  }

  /* ── chart markup ─────────────────────────────────────────────────────── */
  /* Plain HTML/CSS bars, not SVG: each column below holds its value, its bar,
     and its own label chip as one vertical flex stack, so the three pieces
     are guaranteed to line up under each other — no coordinate math, no
     separate label row to keep in sync with separately-positioned bars. */
  function buildChart(rows) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.count; }).concat([1]));
    var TRACK_H = 140; // px — fixed track height every bar grows within

    // Final position is baked directly into the initial markup — no
    // animate-in step. A deferred "start at 0, grow after insertion" pass was
    // tried and, in this app's actual environment, left the bar's computed
    // height permanently desynced from its own inline style after the JS
    // mutation (reproducible only in that exact context, not in isolation).
    // Correct-and-static beats an animation that silently fails.
    var cols = rows.map(function (r) {
      var color = COLORS[r.label] || 'var(--accent,#2563eb)';
      var barPx = Math.max(6, Math.round((r.count / max) * TRACK_H));
      var top = TRACK_H - barPx;
      return (
        '<div class="hrms-pc-col">' +
          '<div class="hrms-pc-val">' + r.count + '</div>' +
          '<div class="hrms-pc-track">' +
            '<div class="hrms-pc-fill" style="background:' + color + ';top:' + top + 'px;height:' + barPx + 'px" title="' + r.label + ': ' + r.count + '"></div>' +
          '</div>' +
          '<span class="hrms-pc-chip"><i class="hrms-pc-chip-dot" style="background:' + color + '"></i>' + r.label + '</span>' +
        '</div>'
      );
    }).join('');

    var host = document.createElement('div');
    host.id = CHART_ID;
    host.innerHTML =
      '<style>' +
        '#' + CHART_ID + '{padding:10px 4px 2px;}' +
        '#' + CHART_ID + ' .hrms-pc-bars{display:flex;align-items:flex-end;gap:18px;}' +
        '#' + CHART_ID + ' .hrms-pc-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:10px;}' +
        '#' + CHART_ID + ' .hrms-pc-val{font-family:var(--font-d,inherit);font-weight:700;font-size:16px;color:var(--text,#111827);line-height:1;}' +
        '#' + CHART_ID + ' .hrms-pc-track{position:relative;width:100%;max-width:56px;height:' + TRACK_H + 'px;}' +
        '#' + CHART_ID + ' .hrms-pc-fill{position:absolute;left:0;width:100%;border-radius:8px 8px 3px 3px;box-shadow:0 3px 8px rgba(0,0,0,.12);}' +
        '#' + CHART_ID + ' .hrms-pc-fill:hover{filter:brightness(1.08);}' +
        '#' + CHART_ID + ' .hrms-pc-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:5px 10px;border-radius:999px;background:var(--bg3,rgba(0,0,0,.04));border:1px solid var(--border2,rgba(0,0,0,.08));font-size:11px;font-weight:600;color:var(--text2,#374151);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#' + CHART_ID + ' .hrms-pc-chip-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0;}' +
      '</style>' +
      '<div class="hrms-pc-bars">' + cols + '</div>';
    return host;
  }

  /* ── mount / refresh ──────────────────────────────────────────────────── */
  function tick() {
    var card = presenceCard();
    if (!card) return;

    var rows = extractRows(card);
    var existingChart = document.getElementById(CHART_ID);

    if (!rows) {
      // Couldn't confidently read the counts this pass (e.g. mid re-render) —
      // leave whatever is currently on screen alone rather than guess.
      return;
    }

    var signature = rows.map(function (r) { return r.label + ':' + r.count; }).join('|');
    if (existingChart && existingChart.dataset.sig === signature && card.contains(existingChart)) {
      return; // nothing changed, and our chart is still in place
    }

    // Hide each row individually (its own label+pill container) rather than
    // hunting for one wrapper shared by all 4 — the rows aren't guaranteed to
    // share a container distinct from the card itself.
    rows.forEach(function (r) {
      var rowEl = commonAncestor(card, r.labelEl, r.countEl);
      if (rowEl && rowEl !== card) {
        rowEl.style.display = 'none';
        rowEl.dataset[HIDDEN_FLAG] = '1';
      }
    });

    if (existingChart && existingChart.parentNode) existingChart.parentNode.removeChild(existingChart);
    var chart = buildChart(rows);
    chart.dataset.sig = signature;
    card.appendChild(chart);
  }

  function start() {
    tick();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      // Plain setTimeout, not requestAnimationFrame: rAF is throttled/paused
      // on background or non-compositing tabs, which would otherwise delay
      // picking up new counts until the next 15s poll.
      setTimeout(function () { scheduled = false; tick(); }, 50);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('popstate', tick);
    setInterval(tick, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
