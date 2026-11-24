/* Leave balance + ledger in ONE card (attendance_ext/leave_accrual.py) —
 * hand-written ES5 overlay.
 *
 * window.HRMSLeaveLedger.mount(el) renders the Leave page's balance card into
 * `el` (an empty div the page owns, see hrms-leaveui.js):
 *   - one row per leave type: remaining of credited, a used bar; click a row
 *     to expand it into its ledger — every credit (annual grant / monthly
 *     credit / proration), carry-forward, HR adjustment, encashment, lapse —
 *     and the leave taken against it (approved = used, pending apart);
 *   - HR (Super Admin, settings.manage or leave.action) also get the employee
 *     picker, a manual adjustment form inside each expanded type, and the
 *     year-end rollover (preview → run, "Accrue now") inline at the bottom.
 * The numbers are /api/leave/ledger's `balances` — the same la.balances()
 * that /api/leave/balance (Apply Leave form) and payroll read, so the card,
 * the form and Settings › Leave Policy (which defines the rules) agree.
 *
 * Settings: a small card after #hrms-leave-policy (ours) holds the same
 * inline year-end rollover and a link to the Leave page. No pop-ups.
 * React-owned DOM is never touched.
 *
 * APIs: GET /api/leave/ledger, POST /api/leave/ledger/adjust,
 * GET /api/leave/ledger/people, POST /api/leave/rollover, POST /api/leave/accrual/run
 */
(function () {
  'use strict';

  var STYLE = 'hrms-leave-ledger-style';
  var CARD = 'hrms-leave-ledger-card';
  var thisYear = new Date().getFullYear();
  var st = { me: '', hr: null, people: null, email: '', year: thisYear, data: null, loading: false, err: '',
    open: {}, adj: {}, busy: false, msg: '', msgKind: '', mounts: [], permsP: null };
  var R = { open: false, year: thisYear - 1, preview: null, msg: '', kind: '', busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function me() { try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email || '').toLowerCase(); } catch (_) { return ''; } }
  function api(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error((d && (d.message || d.detail)) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function post(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function fmtD(iso) {
    if (!iso) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(String(iso).slice(0, 10)); } catch (_) {}
    var p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : iso;
  }
  function n(v) { return v == null ? '—' : String(v); }
  function signed(v) { return (v > 0 ? '+' : '') + n(v); }
  var KIND = { opening: 'Annual grant', accrual: 'Monthly credit', prorate: 'Prorated grant', carry_forward: 'Carry forward',
    lapse: 'Lapsed', encash: 'Encashed', adjust: 'HR adjustment', comp_off: 'Comp-off' };

  function ensureStyle() {
    if (document.getElementById(STYLE)) return;
    var s = document.createElement('style');
    s.id = STYLE;
    var C = '.hlb';
    s.textContent = [
      C + '{color:var(--text);font-size:13px;}',
      C + ' .hlb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}',
      C + ' .hlb-tot{text-align:right;line-height:1.15;}',
      C + ' .hlb-tot b{display:block;font-family:var(--font-d,inherit);font-size:20px;font-weight:700;color:var(--success);}',
      C + ' .hlb-tot span{font-size:11px;color:var(--text2);}',
      C + ' .hlb-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 10px;}',
      C + ' .hlb-bar label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:600;color:var(--text2);}',
      C + ' select,' + C + ' input{padding:6px 8px;border:1px solid var(--border2);border-radius:8px;background:var(--bg3);color:var(--text);font:inherit;font-size:12.5px;box-sizing:border-box;max-width:100%;}',
      C + ' .hlb-type{border:1px solid var(--border2);border-radius:10px;margin-bottom:8px;overflow:hidden;background:var(--bg2);}',
      C + ' .hlb-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;width:100%;text-align:left;background:transparent;border:none;color:var(--text);font:inherit;padding:9px 12px;cursor:pointer;}',
      C + ' .hlb-row:hover{background:var(--bg3);}',
      C + ' .hlb-name{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;min-width:0;}',
      C + ' .hlb-name small{font-weight:500;color:var(--text2);font-size:11px;}',
      C + ' .hlb-caret{display:inline-block;width:9px;font-size:9px;color:var(--text2);}',
      C + ' .hlb-val{font-size:12px;color:var(--text2);white-space:nowrap;}',
      C + ' .hlb-val b{color:var(--text);}',
      C + ' .hlb-track{grid-column:1 / -1;height:6px;border-radius:99px;background:var(--bg3);overflow:hidden;}',
      C + ' .hlb-track i{display:block;height:100%;border-radius:99px;}',
      C + ' .hlb-detail{border-top:1px solid var(--border2);padding:10px 12px;background:var(--bg3);}',
      C + ' .hlb-chips{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:11.5px;color:var(--text2);margin-bottom:8px;}',
      C + ' .hlb-chips b{color:var(--text);}',
      C + ' .hlb-wrap{overflow-x:auto;border:1px solid var(--border2);border-radius:8px;background:var(--bg2);}',
      C + ' table{width:100%;border-collapse:collapse;font-size:12px;}',
      C + ' th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text2);padding:6px 9px;white-space:nowrap;border-bottom:1px solid var(--border2);}',
      C + ' td{padding:6px 9px;border-top:1px solid var(--border);color:var(--text);vertical-align:top;}',
      C + ' td.num,' + C + ' th.num{text-align:right;white-space:nowrap;}',
      C + ' .neg{color:var(--danger);}' + C + ' .pos{color:var(--success);}' + C + ' .mut{color:var(--text2);}',
      C + ' .hlb-adj{display:grid;grid-template-columns:110px minmax(140px,1fr) auto;gap:8px;align-items:end;margin-top:10px;}',
      C + ' .hlb-adj label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:600;color:var(--text2);}',
      C + ' .hlb-btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:7px 13px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}',
      C + ' .hlb-btn.alt{background:var(--bg3);color:var(--text);border:1px solid var(--border2);}',
      C + ' .hlb-btn:disabled{opacity:.55;cursor:not-allowed;}',
      C + ' .hlb-note{font-size:12px;color:var(--text2);margin-top:10px;line-height:1.6;}',
      C + ' .hlb-msg{font-size:12px;font-weight:600;min-height:16px;margin-top:6px;}',
      C + ' .hlb-msg.ok{color:var(--success);}' + C + ' .hlb-msg.err{color:var(--danger);}',
      C + ' .hlb-empty{font-size:12px;color:var(--text2);padding:8px 0;}',
      C + ' .hlb-yr{margin-top:12px;border-top:1px solid var(--border2);padding-top:10px;}',
      C + ' .hlb-tl{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin:8px 0;}',
      C + ' .hlb-tl b{color:var(--text);}',
      '@media(max-width:560px){' + C + ' .hlb-adj{grid-template-columns:1fr 1fr;}' + C + ' .hlb-adj .hlb-btn{grid-column:1 / -1;}}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- data ---------- */
  function loadPerms() {
    st.me = me();
    if (!st.me) return Promise.resolve();
    if (st.permsP) return st.permsP;
    st.permsP = api('/api/me/permissions?email=' + encodeURIComponent(st.me)).then(function (d) {
      var ps = (d && d.permissions) || [];
      st.hr = !!(d && (d.superAdmin === true || ps.indexOf('settings.manage') !== -1 || ps.indexOf('leave.action') !== -1));
    }).catch(function () { st.hr = false; }).then(function () {
      if (st.hr && !st.people) {
        return api('/api/leave/ledger/people').then(function (p) { st.people = Array.isArray(p) ? p : []; }).catch(function () { st.people = []; });
      }
    });
    return st.permsP;
  }
  function loadLedger(quiet) {
    if (!st.email) { st.email = me(); }
    if (!st.email) { st.err = 'Sign in to see your leave balance.'; renderAll(true); return; }
    st.loading = true;
    if (!quiet) renderAll(true);
    var want = st.email + '|' + st.year;
    api('/api/leave/ledger?email=' + encodeURIComponent(st.email) + '&year=' + st.year).then(function (d) {
      if (want !== st.email + '|' + st.year) return;
      st.data = d; st.err = '';
    }).catch(function (e) { if (!quiet) { st.data = null; st.err = e.message; } })
      .then(function () { st.loading = false; renderAll(!quiet); });
  }

  /* ---------- render: balance card ---------- */
  function balColor(b) {
    var r = b.allowance ? b.remaining / b.allowance : 0;
    return r >= 0.5 ? 'var(--success)' : r >= 0.25 ? 'var(--warn)' : 'var(--danger)';
  }
  function typeDetail(b) {
    var d = st.data || {};
    var ents = (d.entries || []).filter(function (e) { return e.type === b.type; }).map(function (e) {
      return { date: e.effectiveDate, what: (KIND[e.kind] || e.kind) + (e.period && e.kind !== 'adjust' ? ' · ' + e.period : ''),
        days: e.days, cls: e.days < 0 ? 'neg' : 'pos', note: e.note || '',
        extra: e.amount != null ? 'Amount ' + e.amount + (e.paidRunId ? ' · paid in run #' + e.paidRunId : ' · unpaid') : '',
        by: e.createdBy || '' };
    });
    var lv = (d.leaves || []).filter(function (x) { return x.type === b.type; }).map(function (x) {
      var pend = x.status !== 'Approved';
      return { date: x.fromDate, what: pend ? 'Leave requested (pending)' : 'Leave taken',
        days: pend ? x.days : -x.days, cls: pend ? 'mut' : 'neg', pend: pend,
        note: fmtD(x.fromDate) + (x.toDate && x.toDate !== x.fromDate ? ' → ' + fmtD(x.toDate) : ''), extra: '', by: '' };
    });
    var rows = ents.concat(lv).sort(function (a, c) { return String(a.date) < String(c.date) ? -1 : String(a.date) > String(c.date) ? 1 : 0; });
    var chips = b.unlimited
      ? '<span>No limit</span><span>Used <b>' + n(b.used) + '</b></span><span>Pending <b>' + n(b.pending) + '</b></span>'
      : '<span>Credited <b>' + n(b.accrued) + '</b></span>' +
        (b.carriedForward ? '<span>Carried forward <b>' + n(b.carriedForward) + '</b></span>' : '') +
        (b.adjusted ? '<span>Adjusted <b>' + signed(b.adjusted) + '</b></span>' : '') +
        (b.encashed || b.lapsed ? '<span>Encashed / lapsed <b>' + n(b.encashed) + ' / ' + n(b.lapsed) + '</b></span>' : '') +
        '<span>Used <b>' + n(b.used) + '</b></span><span>Pending <b>' + n(b.pending) + '</b></span>' +
        '<span>Balance <b class="' + (b.balance < 0 ? 'neg' : '') + '">' + n(b.balance) + '</b></span>' +
        (b.nextAccrual ? '<span>Next credit <b>+' + n(b.nextAccrual.days) + '</b> on ' + esc(fmtD(b.nextAccrual.date)) + '</span>' : '');
    var table = rows.length
      ? '<div class="hlb-wrap"><table><thead><tr><th>Date</th><th>Entry</th><th class="num">Days</th><th>Note</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td style="white-space:nowrap">' + esc(fmtD(r.date)) + '</td><td>' + esc(r.what) + '</td>' +
            '<td class="num ' + r.cls + '">' + (r.pend ? '(' + n(r.days) + ')' : signed(r.days)) + '</td>' +
            '<td>' + esc(r.note) + (r.extra ? '<div class="mut" style="font-size:11px">' + esc(r.extra) + '</div>' : '') +
            (r.by && st.hr ? '<div class="mut" style="font-size:11px">by ' + esc(r.by) + '</div>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="hlb-empty">No entries for ' + esc(d.year) + ' yet.</div>';
    var adj = '';
    if (st.hr && !b.unlimited) {
      var a = st.adj[b.type] || {};
      adj = '<div class="hlb-adj">' +
        '<label>Days (− deducts)<input type="number" step="0.5" data-f="adjDays" data-t="' + esc(b.type) + '" value="' + esc(a.days || '') + '" placeholder="e.g. 1 or -0.5"></label>' +
        '<label>Note (kept in the ledger)<input type="text" maxlength="255" data-f="adjNote" data-t="' + esc(b.type) + '" value="' + esc(a.note || '') + '" placeholder="Why"></label>' +
        '<button type="button" class="hlb-btn" data-a="adjust" data-t="' + esc(b.type) + '"' + (st.busy ? ' disabled' : '') + '>Add adjustment</button></div>';
    }
    return '<div class="hlb-detail"><div class="hlb-chips">' + chips + '</div>' + table + adj + '</div>';
  }
  function cardHtml() {
    var d = st.data, bl = (d && d.balances) || [];
    var other = st.email && st.email !== st.me;
    var name = st.email;
    (st.people || []).forEach(function (p) { if (p.email === st.email) name = p.name; });
    var totRem = 0, totAll = 0;
    bl.forEach(function (b) { if (!b.unlimited) { totRem += Number(b.remaining) || 0; totAll += Number(b.allowance) || 0; } });
    totRem = Math.round(totRem * 2) / 2; totAll = Math.round(totAll * 2) / 2;
    var head = '<div class="hlb-head"><div class="card-title" style="margin-bottom:0">' + (other ? 'Leave Balance — ' + esc(name) : 'My Leave Balance') + '</div>' +
      (bl.length ? '<div class="hlb-tot"><b>' + totRem + '</b><span>of ' + totAll + ' days left</span></div>' : '') + '</div>';
    var bar = '<div class="hlb-bar">';
    if (st.hr && st.people) {
      var found = false;
      bar += '<label>Employee<select data-f="email" style="min-width:200px">' + st.people.map(function (p) {
        if (p.email === st.email) found = true;
        return '<option value="' + esc(p.email) + '"' + (p.email === st.email ? ' selected' : '') + '>' + esc(p.name) + (p.email === st.me ? ' (me)' : '') + '</option>';
      }).join('') + (found ? '' : '<option value="' + esc(st.email) + '" selected>' + esc(st.email) + '</option>') + '</select></label>';
    }
    bar += '<label>Year<select data-f="year">';
    for (var y = thisYear + 1; y >= thisYear - 3; y--) bar += '<option' + (y === st.year ? ' selected' : '') + '>' + y + '</option>';
    bar += '</select></label></div>';
    var list;
    if (!d) list = '<div class="hlb-empty">' + esc(st.err || 'Loading…') + '</div>';
    else if (!bl.length) list = '<div class="hlb-empty">No leave types in the leave policy.</div>';
    else list = bl.map(function (b) {
      var on = !!st.open[b.type];
      var val = b.unlimited ? '<b>' + n(b.used) + '</b> used · no limit' : '<b>' + n(b.remaining) + '</b> of ' + n(b.allowance) + ' left';
      var pct = b.unlimited ? 0 : Math.min(100, Math.round((Number(b.used) || 0) / (Number(b.allowance) || 1) * 100));
      var sub = b.unlimited ? '' : (b.accrual === 'monthly' ? 'Monthly · ' + n(b.monthlyRate) + '/mo' : 'Yearly · ' + n(b.annual) + ' days');
      return '<div class="hlb-type"><button type="button" class="hlb-row" data-a="toggle" data-t="' + esc(b.type) + '" aria-expanded="' + on + '" title="Show the ledger for ' + esc(b.type) + '">' +
        '<span class="hlb-name"><span class="hlb-caret">' + (on ? '▼' : '▶') + '</span>' + esc(b.type) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</span>' +
        '<span class="hlb-val">' + val + (b.pending ? ' · ' + n(b.pending) + ' pending' : '') + '</span>' +
        '<span class="hlb-track"><i style="width:' + pct + '%;background:' + (b.unlimited ? 'var(--text3)' : balColor(b)) + '"></i></span></button>' +
        (on ? typeDetail(b) : '') + '</div>';
    }).join('');
    var foot = d && bl.length ? '<div class="hlb-note">Bars show days used against the days credited so far. Click a type for its ledger — credits, carry-forward, adjustments, encashment / lapse and the leave taken.</div>' : '';
    var yr = st.hr ? '<div class="hlb-yr"><button type="button" class="hlb-btn alt" data-a="rollToggle" aria-expanded="' + R.open + '">' +
      (R.open ? '▼' : '▶') + ' Year-end rollover (HR)</button>' + (R.open ? rolloverHtml() : '') + '</div>' : '';
    return head + bar + list + foot + '<div class="hlb-msg ' + esc(st.msgKind) + '" role="status">' + esc(st.msg) + '</div>' + yr;
  }

  /* ---------- render: year-end rollover (inline, HR) ---------- */
  function rolloverHtml() {
    var pv = R.preview, table = '';
    if (pv) {
      var rows = (pv.rows || []).filter(function (r) { return r.status !== 'nothing'; });
      table = '<div class="hlb-tl"><span>' + (pv.dryRun ? '<b>Preview</b> — nothing written yet' : '<b>Done</b>') + '</span><span>Employees <b>' + pv.employees + '</b></span>' +
        '<span>Carried forward <b>' + pv.totals.carryForward + '</b> days</span><span>Encashed <b>' + pv.totals.encash + '</b> days (<b>' + pv.totals.encashAmount + '</b>)</span><span>Lapsed <b>' + pv.totals.lapse + '</b> days</span></div>' +
        '<div class="hlb-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th class="num">Remaining</th><th class="num">Carry fwd</th><th class="num">Encash</th><th class="num">Amount</th><th class="num">Lapse</th><th>Status</th></tr></thead><tbody>' +
        (rows.map(function (r) {
          return '<tr><td>' + esc(r.email) + '</td><td>' + esc(r.type) + '</td><td class="num">' + n(r.remaining) + '</td><td class="num">' + n(r.carryForward) + '</td><td class="num">' + n(r.encash) + '</td>' +
            '<td class="num">' + (r.encash ? (r.encashAmount ? esc(r.encashAmount) : '<span title="No salary on record — priced by the payroll run">at payroll</span>') : '—') + '</td><td class="num">' + n(r.lapse) + '</td>' +
            '<td>' + esc(r.status === 'done' ? 'Already rolled over' : r.status === 'rolled' ? (pv.dryRun ? 'Will roll over' : 'Rolled over') : r.status) + '</td></tr>';
        }).join('') || '<tr><td colspan="8" class="hlb-empty">Nothing to carry forward, encash or lapse.</td></tr>') + '</tbody></table></div>';
    }
    return '<div class="hlb-note" style="margin-top:8px">Closes a year for every employee: what is left of each leave type moves into next year up to the type’s carry-forward cap; the rest is encashed (paid in the January payroll, up to the encash cap) or lapses — as set in Settings › Leave Policy. Safe to run twice: finished employees are skipped.</div>' +
      '<div class="hlb-bar" style="margin-top:8px"><label>Year to close<input type="number" data-f="rYear" min="2000" max="2100" value="' + esc(R.year) + '" style="width:96px"></label>' +
      '<button type="button" class="hlb-btn alt" data-a="preview"' + (R.busy ? ' disabled' : '') + '>Preview</button>' +
      '<button type="button" class="hlb-btn" data-a="rollover"' + (R.busy || !pv || !pv.dryRun || pv.year !== R.year ? ' disabled title="Preview first"' : '') + '>Run rollover</button>' +
      '<button type="button" class="hlb-btn alt" data-a="accrue"' + (R.busy ? ' disabled' : '') + ' title="Credit every grant due up to today for everyone (also happens automatically)">Accrue now</button></div>' +
      table + '<div class="hlb-msg ' + esc(R.kind) + '" role="status">' + esc(R.msg) + '</div>';
  }

  function renderAll(force) {
    st.mounts = st.mounts.filter(function (m) { return document.documentElement.contains(m.el); });
    st.mounts.forEach(function (m) {
      var html = m.kind === 'settings' ? settingsHtml() : cardHtml();
      if (m.el.__html === html) return;
      var f = document.activeElement;
      if (!force && f && m.el.contains(f) && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) return;   // keep what HR is typing
      m.el.__html = html;
      m.el.innerHTML = html;
    });
  }

  /* ---------- actions ---------- */
  function adjust(type) {
    var a = st.adj[type] || {}, days = Number(a.days);
    if (!a.days || !days) { st.msg = 'Enter the days to add (or a negative number to deduct).'; st.msgKind = 'err'; renderAll(true); return; }
    if (String(a.note || '').trim().length < 3) { st.msg = 'Add a note saying why.'; st.msgKind = 'err'; renderAll(true); return; }
    st.busy = true; st.msg = ''; renderAll(true);
    post('/api/leave/ledger/adjust', { email: st.email, type: type, days: days, note: a.note, year: st.year,
      effectiveDate: st.year === thisYear ? undefined : st.year + '-12-31' })
      .then(function () {
        st.adj[type] = {}; st.msg = 'Adjustment added to ' + type + '.'; st.msgKind = 'ok'; loadLedger(true);
        try { window.dispatchEvent(new CustomEvent('hrmsLeaveLedgerChanged', { detail: { email: st.email } })); } catch (_) {}
      })
      .catch(function (e) { st.msg = e.message; st.msgKind = 'err'; })
      .then(function () { st.busy = false; renderAll(true); });
  }
  function rollover(dry) {
    if (!dry && !window.confirm('Roll over ' + R.year + ' for everyone? Carry-forward, encashment and lapse entries are written to the leave ledger.')) return;
    R.busy = true; R.msg = dry ? 'Working out the preview…' : 'Rolling over…'; R.kind = ''; renderAll(true);
    post('/api/leave/rollover', { year: R.year, dryRun: dry }).then(function (d) {
      R.preview = d; R.msg = dry ? '' : 'Rolled over ' + d.year + '. Encashments are paid in the next January payroll.'; R.kind = dry ? '' : 'ok';
      if (!dry) loadLedger(true);
    }).catch(function (e) { R.msg = e.message; R.kind = 'err'; })
      .then(function () { R.busy = false; renderAll(true); });
  }
  function accrueNow() {
    R.busy = true; R.msg = ''; renderAll(true);
    post('/api/leave/accrual/run', {}).then(function (d) {
      R.msg = 'Accrued up to ' + fmtD(d.upto) + ': ' + d.entries + ' new ledger entries for ' + d.employees + ' employees.'; R.kind = 'ok';
      loadLedger(true);
    }).catch(function (e) { R.msg = e.message; R.kind = 'err'; })
      .then(function () { R.busy = false; renderAll(true); });
  }

  function wire(el) {
    if (el.__hlb) return;
    el.__hlb = true;
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-a]') : null; if (!b || !el.contains(b)) return;
      var a = b.getAttribute('data-a'), t = b.getAttribute('data-t');
      if (a === 'toggle') { st.open[t] = !st.open[t]; renderAll(true); }
      else if (a === 'adjust') adjust(t);
      else if (a === 'rollToggle') { R.open = !R.open; renderAll(true); }
      else if (a === 'preview') rollover(true);
      else if (a === 'rollover') rollover(false);
      else if (a === 'accrue') accrueNow();
      else if (a === 'gotoLeave') {
        if (window.HRMSSidecar && window.HRMSSidecar.go) window.HRMSSidecar.go('/employees/leave'); else location.href = '/employees/leave';
      }
    });
    el.addEventListener('input', function (e) {
      var f = e.target.getAttribute('data-f'), t = e.target.getAttribute('data-t');
      if (f === 'adjDays' || f === 'adjNote') { st.adj[t] = st.adj[t] || {}; st.adj[t][f === 'adjDays' ? 'days' : 'note'] = e.target.value; }
    });
    el.addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f'), v = e.target.value;
      if (f === 'email') { st.email = v; st.data = null; st.msg = ''; st.open = {}; loadLedger(false); }
      else if (f === 'year') { var y = parseInt(v, 10); if (y >= 2000 && y <= 2100) { st.year = y; st.data = null; loadLedger(false); } }
      else if (f === 'rYear') { var r = parseInt(v, 10); if (r >= 2000 && r <= 2100) { R.year = r; R.preview = null; renderAll(true); } }
    });
  }

  function mount(el) {
    if (!el) return function () {};
    ensureStyle();
    el.classList.add('hlb');
    wire(el);
    var m = null;
    st.mounts.forEach(function (x) { if (x.el === el) m = x; });
    if (!m) { m = { el: el, kind: 'card' }; st.mounts.push(m); }
    if (!st.email || st.me !== me()) { st.me = me(); st.email = st.me; st.data = null; }
    el.__html = null;
    renderAll(true);
    loadPerms().then(function () { renderAll(true); loadLedger(!!st.data); });
    return function () { st.mounts = st.mounts.filter(function (x) { return x.el !== el; }); };
  }

  /* The Leave page reloads /api/leave/balance after an apply / approve /
     delete (and every 15 s): refresh our numbers quietly when we show the
     signed-in user's own current year. */
  window.addEventListener('hrmsLeaveBalanceChanged', function () {
    if (st.mounts.some(function (m) { return m.kind === 'card'; }) && st.email === me() && st.year === thisYear && !st.loading) loadLedger(true);
  });

  /* Compatibility: the old pop-up entry point now goes to the card. */
  function open() {
    var el = document.querySelector('[data-hrms-leave-balance]');
    if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (window.HRMSSidecar && window.HRMSSidecar.go) window.HRMSSidecar.go('/employees/leave'); else location.href = '/employees/leave';
  }
  window.HRMSLeaveLedger = { mount: mount, reload: function () { loadLedger(true); }, open: open };
  window.__hrmsLeaveLedger = { open: open, close: function () {} };

  /* ---------- Settings card (after the Leave Policy card, ours) ---------- */
  function settingsHtml() {
    return '<div class="card-title">Leave Ledger &amp; Year-end</div>' +
      '<div class="hlb-note" style="margin-top:0">Balances and every ledger entry (credits, carry-forward, adjustments, encashment / lapse, leave taken) are on the Leave page, in the balance card — HR can pick any employee there and add adjustments.</div>' +
      '<div class="hlb-bar" style="margin-top:8px"><button type="button" class="hlb-btn alt" data-a="gotoLeave">Open balances &amp; ledger</button></div>' +
      (st.hr ? '<div class="hlb-yr" style="margin-top:6px"><div style="font-size:13px;font-weight:700">Year-end rollover</div>' + rolloverHtml() + '</div>' : '');
  }
  function tick() {
    var onSettings = (location.pathname || '').replace(/\/+$/, '') === '/settings';
    var anchor = document.getElementById('hrms-leave-policy');
    var card = document.getElementById(CARD);
    if (!onSettings || !anchor || !anchor.parentNode) { if (card && card.parentNode) card.parentNode.removeChild(card); return; }
    if (!card) {
      ensureStyle();
      card = document.createElement('div');
      card.id = CARD;
      card.className = 'card hlb';
      wire(card);
      st.mounts.push({ el: card, kind: 'settings' });
      loadPerms().then(function () { renderAll(true); });
    }
    if (anchor.nextElementSibling !== card) anchor.parentNode.insertBefore(card, anchor.nextSibling);
    if (!card.__html) renderAll(true);
  }
  setInterval(tick, 400);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();
