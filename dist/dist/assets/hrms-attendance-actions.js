/*
 * hrms-attendance-actions.js
 * ---------------------------------------------------------------------------
 * Enhances the Check In / Out page (/employees/checkin) of the pre-built
 * (minified) React app via the repo's no-rebuild injection pattern.
 *
 * Layout (forced 2×2 grid):
 *     ┌ Check In (React) + Overtime ┐  ┌ Work From Home (ours) ┐
 *     └ Today's Activity Log (ours) ┘  └ Team Status Now (ours) ┘
 *
 *   • Overtime is shown inside the check-in card (not its own card).
 *   • Work From Home: request form + your requests + (for admins) approvals.
 *   • Approved WFH gets a "Switch to WFH" button that logs a remote-switch on
 *     the same channel the app's own "Switch to Remote" uses. A refusal from
 *     either button lands on our message line — the app's card has no slot of
 *     its own, so it hands us the text via 'hrmsAttendanceEventFailed'.
 *   • Activity Log and Team Status are rendered by us — columned, scrollable,
 *     each with a filter — so the app's stacked/combined card is hidden.
 *   • Retires the old floating Attendance portal button.
 *
 * React owns the check-in card, so a MutationObserver re-applies everything
 * idempotently. Our cards are appended at the END of the grid (never inserted
 * between React's nodes) and arranged with CSS `order`, which React never sets.
 * The haa- class prefix is shared with hrms-attendance-admin.js, whose rules are
 * scoped to its own overlay root (.haa-back) for exactly that reason — keep any
 * new rule on either side scoped so the two sheets cannot repaint each other.
 *
 * Endpoints are AllowAny; identity travels in `email` + the X-User-Email header
 * hrms-actor.js attaches to fetches.
 */
(function () {
  'use strict';

  var CHECKIN_PATH = '/employees/checkin';
  var ID = {
    ot:    'hrms-att-ot',       // overtime line inside the check-in card
    brk:   'hrms-att-brk',      // break-taken line inside the check-in card
    wfh:   'hrms-att-wfh',      // Work From Home card
    act:   'hrms-att-activity', // our Today's Activity Log card
    team:  'hrms-att-team',     // our Team Status Now card
    style: 'hrms-att-actions-style'
  };
  var state = { actFilter: 'all', teamFilter: 'all', teamSearch: '' };
  var PIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>';
  var PIN_BIG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="#e11d48" stroke="#fff" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="#fff"></circle></svg>';

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function session() { try { return JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}; } catch (_) { return {}; } }
  function actorEmail() { return session().email || ''; }
  function actorName() { var s = session(); return s.name || s.fullName || ''; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtMins(m) { m = Math.max(0, m || 0); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function onCheckinPage() { return location.pathname.replace(/\/+$/, '') === CHECKIN_PATH; }

  /*
   * The check-in page's one message line. Returns whether it was there to
   * write to, so callers can fall back to an alert rather than swallow the
   * message when our card has not been built yet.
   */
  function showAttMsg(text, kind) {
    var m = document.getElementById('haa-msg');
    if (!m) return false;
    m.textContent = text;
    m.className = 'haa-msg' + (kind ? ' ' + kind : '');
    return true;
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        if (t) { try { data = JSON.parse(t); } catch (_) { data = t; } }
        if (!r.ok) throw new Error((data && (data.error || data.detail || data.message)) || ('Request failed (' + r.status + ')'));
        return data;
      });
    });
  }

  function removeLegacyPortal() {
    ['attendance-portal-toggle', 'attendance-portal-wrapper', 'attendance-portal-backdrop', 'attendance-portal-root']
      .forEach(function (id) { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  /* The sheet is scoped to .haa-scope — the three cards this file owns.
   * hrms-attendance-admin.js uses the same haa- prefix for the Attendance
   * Settings panel and both sheets are live on this page, so unscoped rules
   * repainted each other: its .haa-tbl{background:#fff} whitened these dark
   * cards' tables, and this .haa-tbl{display:flex} flattened the panel's real
   * <table> rows. Neither sheet is global now. */
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var W = '#' + ID.wfh, A = '#' + ID.act, T = '#' + ID.team;
    var css = [
      /* overtime + break lines inside the check-in card */
      '#' + ID.ot + '{margin-top:14px;font-size:12px;color:var(--text3);text-align:center;}',
      '#' + ID.brk + '{margin-top:6px;font-size:12px;color:var(--text3);text-align:center;}',
      '#' + ID.ot + ' strong,#' + ID.brk + ' strong{color:var(--text);}',
      /* section titles (with optional trailing filter) */
      '.haa-scope .haa-title{font-family:var(--font-d,inherit);font-size:14px;font-weight:700;color:var(--text);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      /* wfh form */
      W + ' .haa-form{display:flex;flex-direction:column;gap:9px;}',
      W + ' .haa-row{display:grid;grid-template-columns:1fr 1fr;gap:9px;}',
      W + ' label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}',
      W + ' input,' + W + ' textarea{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font:inherit;font-size:12.5px;text-transform:none;letter-spacing:normal;font-weight:400;}',
      W + ' input:focus,' + W + ' textarea:focus{border-color:var(--accent);outline:none;}',
      W + ' textarea{min-height:44px;resize:vertical;}',
      W + ' .haa-btn{align-self:flex-start;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-weight:700;font-size:12.5px;cursor:pointer;}',
      W + ' .haa-btn:disabled{opacity:.55;cursor:not-allowed;}',
      W + ' .haa-msg{font-size:11.5px;font-weight:600;min-height:14px;}',
      W + ' .haa-msg.ok{color:var(--success,#22d3a5);}',
      W + ' .haa-msg.err{color:var(--danger,#f75f4f);}',
      /* WFH request counts */
      W + ' .haa-wfh-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}',
      W + ' .haa-stat{display:flex;flex-direction:column;align-items:center;gap:2px;background:var(--bg3);border:1px solid var(--border2);border-top:3px solid var(--text3);border-radius:10px;padding:12px 8px;}',
      W + ' .haa-stat.pending{border-top-color:var(--warn,#f7c94f);}',
      W + ' .haa-stat.approved{border-top-color:var(--success,#22d3a5);}',
      W + ' .haa-stat.rejected{border-top-color:var(--danger,#f75f4f);}',
      W + ' .haa-stat-v{font-family:var(--font-d,inherit);font-size:22px;font-weight:800;color:var(--text);}',
      W + ' .haa-stat-l{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);}',
      /* lists */
      '.haa-scope .haa-list-title{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin:16px 0 8px;}',
      '.haa-scope .haa-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}',
      '.haa-scope .haa-li{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;}',
      '.haa-scope .haa-li .haa-li-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}',
      '.haa-scope .haa-li .haa-who{color:var(--text);font-weight:600;}',
      '.haa-scope .haa-li .haa-sub{color:var(--text3);font-size:11px;}',
      '.haa-scope .haa-empty{color:var(--text2);font-size:12px;padding:14px 2px;text-align:center;}',
      '.haa-scope .haa-switch{background:var(--accent);color:#fff;border:none;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;}',
      '.haa-scope .haa-appr-btn{border:none;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;color:#fff;}',
      '.haa-scope .haa-appr-btn.approve{background:var(--success,#22d3a5);}',
      '.haa-scope .haa-appr-btn.reject{background:var(--danger,#f75f4f);}',
      '.haa-scope .haa-appr-btn:disabled{opacity:.55;cursor:not-allowed;}',
      /* status pills */
      '.haa-scope .haa-pill{flex-shrink:0;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;text-transform:capitalize;white-space:nowrap;background:rgba(148,163,184,.16);color:var(--text2);}',
      '.haa-scope .haa-pill.pending{background:rgba(247,201,79,.16);color:var(--warn,#f7c94f);}',
      '.haa-scope .haa-pill.approved,.haa-scope .haa-pill.inoffice,.haa-scope .haa-pill.available{background:rgba(34,211,165,.16);color:var(--success,#22d3a5);}',
      '.haa-scope .haa-pill.rejected,.haa-scope .haa-pill.absent,.haa-scope .haa-pill.busy,.haa-scope .haa-pill.donotdisturb{background:rgba(247,95,79,.16);color:var(--danger,#f75f4f);}',
      /* every break-type status renders as the amber "In Break" pill */
      '.haa-scope .haa-pill.onbreak,.haa-scope .haa-pill.inbreak,.haa-scope .haa-pill.away,.haa-scope .haa-pill.coffeebreak{background:rgba(247,201,79,.16);color:var(--warn,#f7c94f);}',
      '.haa-scope .haa-pill.remote,.haa-scope .haa-pill.wfh{background:rgba(79,142,247,.18);color:var(--accent,#4f8ef7);}',
      '.haa-scope .haa-pill.travelling{background:rgba(6,182,212,.16);color:#06b6d4;}',
      '.haa-scope .haa-pill.inameeting,.haa-scope .haa-pill.meeting{background:rgba(139,92,246,.18);color:#8b5cf6;}',
      '.haa-scope .haa-pill.invisible{background:rgba(148,163,184,.16);color:var(--text3);}',
      /* filters */
      '.haa-scope .haa-flt{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:11.5px;font-weight:600;padding:5px 8px;cursor:pointer;}',
      '.haa-scope .haa-flt:focus{border-color:var(--accent);outline:none;}',
      /* columned + scrollable tables (activity + team share the pattern) */
      '.haa-scope .haa-tbl{display:flex;flex-direction:column;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;overflow:hidden;}',
      '.haa-scope .haa-scroll{max-height:300px;overflow-y:auto;}',
      '.haa-scope .haa-head,.haa-scope .haa-tr{display:grid;align-items:center;gap:12px;padding:8px 12px;}',
      '.haa-scope .haa-head{position:sticky;top:0;background:var(--bg3);z-index:1;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);border-bottom:1px solid var(--border2);}',
      '.haa-scope .haa-tr{border-bottom:1px solid var(--border2);font-size:12.5px;color:var(--text2);}',
      '.haa-scope .haa-tr:last-child{border-bottom:none;}',
      A + ' .haa-head,' + A + ' .haa-tr{grid-template-columns:1fr auto 1fr;}',
      A + ' .c-event{justify-self:center;text-align:center;}',
      A + ' .haa-dot{justify-self:end;}',
      T + ' .haa-head,' + T + ' .haa-tr{grid-template-columns:1fr 1fr 1fr;}',
      T + ' .c-status{justify-self:center;text-align:center;}',
      '.haa-scope .haa-tr .c-nm,.haa-scope .haa-tr .c-ev{color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      T + ' .haa-tr .c-nm{display:flex;align-items:center;gap:8px;}',
      '.haa-scope .haa-avwrap{position:relative;display:inline-flex;flex-shrink:0;}',
      '.haa-scope .haa-av{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;',
      'justify-content:center;color:#fff;font-size:10.5px;font-weight:700;letter-spacing:.2px;}',
      /* The dot itself is drawn by hrms-status.js; this only rings it in the
         table's own colour so it reads as sitting on the avatar. */
      '.haa-scope .haa-avwrap .hrms-presence-dot{width:9px;height:9px;border:2px solid var(--bg3);}',
      '.haa-scope .haa-tr .c-loc{color:var(--text3);font-size:11px;font-weight:400;}',
      '.haa-scope .haa-tr .c-tm{color:var(--text3);}',
      '.haa-scope .haa-tr .c-since{color:var(--text3);text-align:right;font-size:11.5px;}',
      '.haa-scope .haa-dot{width:9px;height:9px;border-radius:50%;justify-self:center;}',
      '@media(max-width:520px){' + W + ' .haa-row{grid-template-columns:1fr;}}',
      /* raise-a-ticket button row */
      '.haa-scope .haa-btnrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}',
      '.haa-scope .haa-btn-alt{background:var(--bg3);color:var(--text);border:1px solid var(--border2);}',
      /* attendance-ticket modal */
      '.hat-back{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;}',
      '.hat-modal{background:var(--surface,#fff);color:var(--text);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:560px;padding:22px;font-family:var(--font,Arial,Helvetica,sans-serif);box-shadow:0 24px 60px rgba(0,0,0,.35);}',
      '.hat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;}',
      '.hat-title{font-size:17px;font-weight:800;color:var(--text);}',
      '.hat-count{font-size:11.5px;font-weight:700;color:var(--text3);background:var(--bg3);border:1px solid var(--border2);border-radius:999px;padding:4px 11px;white-space:nowrap;}',
      '.hat-f{margin-bottom:12px;display:flex;flex-direction:column;gap:5px;}',
      '.hat-f label{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}',
      '.hat-req{color:var(--danger,#f75f4f);}',
      '.hat-in{background:var(--bg3);border:1px solid var(--border2);border-radius:9px;color:var(--text);font:inherit;font-size:13px;padding:9px 11px;outline:none;box-sizing:border-box;width:100%;}',
      '.hat-in:focus{border-color:var(--accent);}',
      'textarea.hat-in{min-height:64px;resize:vertical;}',
      '.hat-note{font-size:12px;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-left:3px solid var(--accent);border-radius:8px;padding:9px 11px;margin-bottom:12px;}',
      '.hat-block{font-size:12.5px;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:12px 13px;margin-bottom:6px;}',
      '.hat-file{font-size:12px;color:var(--text2);}',
      '.hat-preview{margin-top:8px;}',
      '.hat-preview img{max-width:100%;max-height:180px;border-radius:9px;border:1px solid var(--border2);display:block;}',
      '.hat-mf{display:flex;justify-content:flex-end;gap:10px;margin-top:8px;}',
      '.hat-mf button{border:none;border-radius:9px;font:inherit;font-size:13px;font-weight:700;padding:9px 16px;cursor:pointer;}',
      '.hat-mf .ok{background:var(--accent);color:#fff;}',
      '.hat-mf .cx{background:rgba(127,127,127,.18);color:var(--text);}',
      '.hat-mf button:disabled{opacity:.55;cursor:not-allowed;}',
      '.hat-msg{font-size:11.5px;font-weight:600;min-height:14px;margin-top:8px;}',
      '.hat-msg.ok{color:var(--success,#22d3a5);}.hat-msg.err{color:var(--danger,#f75f4f);}',
      '.hat-reason{font-style:italic;}',
      '.hat-proofview{max-width:640px;}',
      '.hat-proofimg{max-height:70vh;overflow:auto;border-radius:10px;border:1px solid var(--border2);}',
      '.hat-proofimg img{width:100%;display:block;}',
      '.hat-loading,.hat-err{padding:20px;text-align:center;color:var(--text2);font-size:13px;}',
      '.haa-scope .haa-tr-click{cursor:pointer;}',
      '.haa-scope .haa-tr-click:hover{background:rgba(127,127,127,.10);}',
      '.hat-emp{max-width:520px;}',
      '.hat-clockrow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 12px;}',
      '.hat-clock{background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:10px 12px;}',
      '.hat-cl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);}',
      '.hat-cv{font-size:16px;font-weight:800;color:var(--text);margin-top:2px;}',
      '.hat-hrs{display:flex;gap:18px;font-size:12px;color:var(--text3);margin-bottom:6px;}',
      '.hat-hrs b{color:var(--text);font-weight:700;}',
      '.hat-badge{font-size:10.5px;font-weight:800;padding:4px 10px;border-radius:999px;background:rgba(148,163,184,.16);color:var(--text2);white-space:nowrap;}',
      '.hat-badge.ok{background:rgba(34,197,94,.16);color:#22c55e;}',
      '.hat-log{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:7px 2px;border-bottom:1px solid var(--border2);}',
      '.hat-lt{color:var(--text);font-weight:700;white-space:nowrap;}',
      '.hat-le{color:var(--text2);}',
      '.hat-ll{color:var(--text3);font-size:11px;text-align:right;}',
      '.hat-punchlist{max-height:230px;overflow:auto;}',
      '.hat-punch{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;font-size:12.5px;padding:8px 2px;border-bottom:1px solid var(--border2);}',
      '.hat-pt{color:var(--text);font-weight:700;white-space:nowrap;}',
      '.hat-pl{color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hat-pin{background:none;border:none;cursor:pointer;color:var(--accent,#4f8ef7);padding:4px;display:inline-flex;}',
      '.hat-pin:hover{opacity:.65;}',
      '.hat-empty2{color:var(--text3);font-size:12px;padding:12px 2px;text-align:center;}',
      '.hat-mapmodal{max-width:520px;}',
      '.hat-map{position:relative;height:260px;border-radius:10px;overflow:hidden;border:1px solid var(--border2);background:var(--bg3);}',
      '.hat-mkr{position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));}',
      '.hat-mapfallback{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:13px;}',
      '.hat-coord{font-size:11px;color:var(--text3);margin:6px 0;text-align:center;}',
      '.hat-mf a.ok{text-decoration:none;display:inline-block;}',
      '.haa-scope .haa-title-ctrls{display:flex;gap:8px;align-items:center;}',
      '.haa-scope .haa-search{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font:inherit;font-size:11.5px;font-weight:500;padding:5px 9px;width:130px;max-width:42vw;text-transform:none;letter-spacing:normal;}',
      '.haa-scope .haa-search:focus{border-color:var(--accent);outline:none;}',
      '.haa-scope .haa-search::placeholder{color:var(--text3);}',
      'body.hrms-checkin-page .card,body.hrms-checkin-page .card *,body.hrms-checkin-page .haa-scope,body.hrms-checkin-page .haa-scope *{font-family:Arial,Helvetica,sans-serif!important;}'
    ].join('');
    var st = document.createElement('style');
    st.id = ID.style; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── locate the app's cards ───────────────────────────────────────────── */
  function cardContaining(re) {
    var els = document.querySelectorAll('.card, [class*="card"]');
    for (var i = 0; i < els.length; i++) {
      if (re.test(els[i].textContent || '')) {
        var card = els[i], p = card.parentElement;
        while (p && p.className && /(^|\s)card(\s|$)/.test(p.className)) { card = p; p = p.parentElement; }
        return card;
      }
    }
    return null;
  }
  function clockCard()    { return cardContaining(/Working hours today/i); }
  function reactActTeam() { return cardContaining(/Today.s Activity Log/i); }

  /* ── Work From Home card ──────────────────────────────────────────────── */
  function buildWfhCard() {
    var card = document.createElement('div');
    card.id = ID.wfh; card.className = 'card haa-scope';
    card.innerHTML =
      '<div class="haa-title">Work From Home</div>' +
      '<div class="haa-wfh-stats">' +
        '<div class="haa-stat pending"><span class="haa-stat-v" id="haa-c-pending">0</span><span class="haa-stat-l">Pending</span></div>' +
        '<div class="haa-stat approved"><span class="haa-stat-v" id="haa-c-approved">0</span><span class="haa-stat-l">Approved</span></div>' +
        '<div class="haa-stat rejected"><span class="haa-stat-v" id="haa-c-rejected">0</span><span class="haa-stat-l">Rejected</span></div>' +
      '</div>' +
      '<form class="haa-form" id="haa-form" autocomplete="off">' +
        '<div class="haa-row">' +
          '<label>From<input type="date" id="haa-from" required></label>' +
          '<label>To<input type="date" id="haa-to" required></label>' +
        '</div>' +
        '<label>Reason<textarea id="haa-reason" placeholder="Optional — why do you need to work from home?"></textarea></label>' +
        '<button type="submit" class="haa-btn" id="haa-submit">Request WFH</button>' +
        '<span class="haa-msg" id="haa-msg"></span>' +
      '</form>' +
      '<div class="haa-list-title">My WFH requests</div>' +
      '<ul class="haa-list" id="haa-list"><li class="haa-empty">Loading…</li></ul>' +
      '<div id="haa-approvals" style="display:none">' +
        '<div class="haa-list-title">Pending approvals (team)</div>' +
        '<ul class="haa-list" id="haa-appr-list"></ul>' +
      '</div>';
    card.querySelector('#haa-from').value = todayIso();
    card.querySelector('#haa-to').value = todayIso();
    card.querySelector('#haa-form').addEventListener('submit', function (e) { e.preventDefault(); submitWfh(card); });
    return card;
  }

  /* ── our Today's Activity Log card ────────────────────────────────────── */
  function buildActivityCard() {
    var card = document.createElement('div');
    card.id = ID.act; card.className = 'card haa-scope';
    card.innerHTML =
      '<div class="haa-title">Today\'s Activity Log' +
        '<select class="haa-flt" id="haa-act-flt">' +
          '<option value="all">All events</option>' +
          '<option value="attendance">Check in / out</option>' +
          '<option value="break">Breaks</option>' +
          '<option value="remote">Remote / office</option>' +
        '</select></div>' +
      '<div class="haa-tbl">' +
        '<div class="haa-head"><span>Time</span><span class="c-event">Event</span><span></span></div>' +
        '<div class="haa-scroll"><div id="haa-act-list"><div class="haa-empty">Loading…</div></div></div>' +
      '</div>';
    card.querySelector('#haa-act-flt').addEventListener('change', function (e) { state.actFilter = e.target.value; renderActivity(); });
    return card;
  }

  /* ── our Team Status Now card ─────────────────────────────────────────── */
  function buildTeamCard() {
    var card = document.createElement('div');
    card.id = ID.team; card.className = 'card haa-scope';
    card.innerHTML =
      '<div class="haa-title">Team Status Now' +
        '<span class="haa-title-ctrls">' +
        '<input type="text" class="haa-search" id="haa-team-search" placeholder="Search name…" autocomplete="off">' +
        '<select class="haa-flt" id="haa-team-flt">' +
          '<option value="all">All</option>' +
          '<option value="in office">In Office</option>' +
          '<option value="in break">In Break</option>' +
          '<option value="remote">Remote</option>' +
          '<option value="absent">Absent</option>' +
        '</select></span></div>' +
      '<div class="haa-tbl">' +
        '<div class="haa-head"><span>Employee</span><span class="c-status">Status</span><span style="text-align:right">Since</span></div>' +
        '<div class="haa-scroll"><div id="haa-team-list"><div class="haa-empty">Loading…</div></div></div>' +
      '</div>';
    card.querySelector('#haa-team-flt').addEventListener('change', function (e) { state.teamFilter = e.target.value; renderTeam(); });
    var tsearch = card.querySelector('#haa-team-search');
    if (tsearch) tsearch.addEventListener('input', function (e) { state.teamSearch = e.target.value; renderTeam(); });
    var tlist = card.querySelector('#haa-team-list');
    if (tlist) tlist.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('.haa-tr-click'); if (!row) return;
      var em = row.getAttribute('data-email'); if (em) openEmployeeDetail(em, row.getAttribute('data-name'));
    });
    return card;
  }

  /* ── overtime inside the check-in card ────────────────────────────────── */
  // otVal is cached so a re-created line restores instantly without re-fetching
  // (the check-in card re-renders on the live clock).
  var otVal = null;
  function ensureOvertimeLine(clock) {
    var line = document.getElementById(ID.ot);
    if (!line) {
      line = document.createElement('div');
      line.id = ID.ot;
      line.innerHTML = 'Overtime worked today: <strong id="haa-ot-val"></strong>';
    }
    if (line.parentElement !== clock) clock.appendChild(line); // keep it last
    var v = document.getElementById('haa-ot-val');
    if (v) v.textContent = (otVal == null ? '…' : otVal);
  }

  // brkVal is cached alongside otVal so the re-created line restores instantly.
  var brkVal = null;
  function ensureBreakLine(clock) {
    var line = document.getElementById(ID.brk);
    if (!line) {
      line = document.createElement('div');
      line.id = ID.brk;
      line.innerHTML = 'Break taken today: <strong id="haa-brk-val"></strong>';
    }
    if (line.parentElement !== clock) clock.appendChild(line); // keep it last
    var v = document.getElementById('haa-brk-val');
    if (v) v.textContent = (brkVal == null ? '…' : brkVal);
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  // Loads the overtime + break totals for today (one fetch feeds both lines).
  function loadOvertime() {
    var em = actorEmail(); if (!em) return;
    api('/api/attendance/today?email=' + encodeURIComponent(em))
      .then(function (rec) {
        rec = Array.isArray(rec) ? (rec[0] || {}) : (rec || {});
        otVal = fmtMins(rec.overtimeMinutes || 0);
        var el = document.getElementById('haa-ot-val'); if (el) el.textContent = otVal;
        brkVal = fmtMins(rec.breakMinutes || 0);
        var bel = document.getElementById('haa-brk-val'); if (bel) bel.textContent = brkVal;
      })
      .catch(function () {
        if (otVal == null) otVal = '0h 0m'; var el = document.getElementById('haa-ot-val'); if (el) el.textContent = otVal;
        if (brkVal == null) brkVal = '0h 0m'; var bel = document.getElementById('haa-brk-val'); if (bel) bel.textContent = brkVal;
      });
  }

  var activityData = [];
  function loadActivity() {
    var em = actorEmail(); if (!em) return;
    api('/api/attendance/events?email=' + encodeURIComponent(em))
      .then(function (rows) { activityData = Array.isArray(rows) ? rows : []; renderActivity(); })
      .catch(function () { var l = document.getElementById('haa-act-list'); if (l) l.innerHTML = '<div class="haa-empty">Could not load activity.</div>'; });
  }
  function actCategory(r) {
    var t = (r.type || r.event || '').toLowerCase();
    if (/remote|office|home|wfh/.test(t)) return 'remote';
    if (/break/.test(t)) return 'break';
    if (/check|in|out/.test(t)) return 'attendance';
    return 'other';
  }
  function dotColor(c) {
    return ({ success: 'var(--success,#22d3a5)', warn: 'var(--warn,#f7c94f)', danger: 'var(--danger,#f75f4f)', accent: 'var(--accent,#4f8ef7)' })[c] || 'var(--text3)';
  }
  function renderActivity() {
    var l = document.getElementById('haa-act-list'); if (!l) return;
    var f = state.actFilter;
    var rows = activityData.filter(function (r) { return f === 'all' || actCategory(r) === f; });
    if (!rows.length) { l.innerHTML = '<div class="haa-empty">No matching activity today.</div>'; return; }
    l.innerHTML = rows.map(function (r) {
      var loc = r.location && r.location !== '—' ? '<div class="c-loc">' + esc(r.location) + '</div>' : '';
      return '<div class="haa-tr"><span class="c-tm">' + esc(r.time || '—') + '</span>' +
        '<span class="c-event"><span class="c-ev">' + esc(r.event || r.type || '—') + '</span>' + loc + '</span>' +
        '<span class="haa-dot" style="background:' + dotColor(r.color) + '"></span></div>';
    }).join('');
  }

  /* A face for each row. Nobody here has uploaded a photo, so this draws the
     same initials circle the rest of the app uses, coloured from the email so
     one person keeps one colour wherever they appear. The wrapper carries
     data-hrms-presence, which hrms-status.js paints a live dot onto: the row
     already spells the status out, and the dot makes the panel scannable. */
  function avatarInitials(name, email) {
    var src = String(name || email || '').trim();
    if (!src) return '?';
    var parts = src.split(/[\s._-]+/).filter(Boolean);
    var a = (parts[0] || '')[0] || '';
    var b = (parts.length > 1 ? parts[parts.length - 1][0] : '') || '';
    return (a + b).toUpperCase();
  }
  var AV_COLORS = ['#4f8ef7', '#7c5cfc', '#22d3a5', '#f7954f', '#f75f4f', '#06b6d4', '#8b5cf6', '#f7c94f'];
  function avatarColor(key) {
    var t = String(key || ''), h = 0;
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }
  function avatarHtml(r) {
    var em = String(r.email || '');
    return '<span class="haa-avwrap"' + (em ? ' data-hrms-presence="' + esc(em) + '"' : '') + '>' +
      '<span class="haa-av" style="background:' + avatarColor(em || r.name) + '">' +
      esc(avatarInitials(r.name, em)) + '</span></span>';
  }

  var teamData = [];
  function loadTeam() {
    api('/api/attendance/team')
      .then(function (rows) { teamData = Array.isArray(rows) ? rows : []; renderTeam(); })
      .catch(function () { var l = document.getElementById('haa-team-list'); if (l) l.innerHTML = '<div class="haa-empty">Could not load team status.</div>'; });
  }
  function renderTeam() {
    var l = document.getElementById('haa-team-list'); if (!l) return;
    var f = state.teamFilter;
    var q = (state.teamSearch || '').trim().toLowerCase();
    var rows = teamData.filter(function (r) {
      if (q && String(r.name || r.email || '').toLowerCase().indexOf(q) === -1) return false;
      if (f === 'all') return true;
      var s = String(r.status || '').toLowerCase();
      if (f === 'remote') return /remote|home|wfh/.test(s);
      return s.indexOf(f) !== -1;
    });
    if (!rows.length) { l.innerHTML = '<div class="haa-empty">' + (q ? 'No employee matches your search.' : 'No one matches this filter.') + '</div>'; return; }
    l.innerHTML = rows.map(function (r) {
      var status = String(r.status || 'Absent'), cls = status.toLowerCase().replace(/\s+/g, '');
      return '<div class="haa-tr haa-tr-click" data-email="' + esc(r.email || '') + '" data-name="' + esc(r.name || r.email || '') + '"><span class="c-nm">' + avatarHtml(r) + esc(r.name || r.email || '—') + '</span>' +
        '<span class="c-status"><span class="haa-pill ' + esc(cls) + '">' + esc(status) + '</span></span>' +
        '<span class="c-since">' + esc(r.since || '—') + '</span></div>';
    }).join('');
    // Every poll and every filter change replaces these nodes, so the dots are
    // being painted onto brand-new elements each time.
    if (window.__hrmsPresence) window.__hrmsPresence.paint();
  }

  function updateWfhCounts(rows) {
    var c = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach(function (r) {
      var s = String(r.status || '').toLowerCase();
      if (s in c) c[s]++;
    });
    ['pending', 'approved', 'rejected'].forEach(function (k) {
      var el = document.getElementById('haa-c-' + k); if (el) el.textContent = c[k];
    });
  }

  function loadWfh() {
    var em = actorEmail();
    var list = document.getElementById('haa-list'); if (!list) return;
    if (!em) { list.innerHTML = '<li class="haa-empty">Sign in to view your requests.</li>'; return; }
    api('/api/attendance/wfh?email=' + encodeURIComponent(em))
      .then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        updateWfhCounts(rows);
        if (!rows.length) { list.innerHTML = '<li class="haa-empty">No WFH requests yet.</li>'; return; }
        list.innerHTML = rows.slice(0, 8).map(function (r) {
          var status = String(r.status || 'Pending'), cls = status.toLowerCase().replace(/\s+/g, '');
          var approved = /approved/i.test(status);
          var range = esc(r.fromDate || '—') + ' → ' + esc(r.toDate || '—') + (r.days ? ' · ' + esc(r.days) + 'd' : '');
          return '<li class="haa-li"><span>' + range + '</span><div class="haa-li-actions">' +
            (approved ? '<button class="haa-switch" data-switch="1">Switch to WFH</button>' : '') +
            '<span class="haa-pill ' + esc(cls) + '">' + esc(status) + '</span></div></li>';
        }).join('');
        list.querySelectorAll('[data-switch]').forEach(function (b) { b.addEventListener('click', switchToWfh); });
      })
      .catch(function () { list.innerHTML = '<li class="haa-empty">Could not load requests.</li>'; });
  }

  var isApprover = null;
  function checkApprover(cb) {
    if (isApprover !== null) { cb(isApprover); return; }
    var em = actorEmail();
    if (!em) { isApprover = false; cb(false); return; }
    api('/api/me/permissions?email=' + encodeURIComponent(em))
      .then(function (p) {
        // attendance.approve_wfh, not settings.manage: approving a day at home
        // used to require the company-configuration permission, which also
        // carries the SMTP credentials and the pay cycle. The server checks the
        // new code, so this has to as well or the panel shows buttons that 403.
        var perms = (p && Array.isArray(p.permissions)) ? p.permissions : [];
        isApprover = !!(p && (p.superAdmin || perms.indexOf('attendance.approve_wfh') !== -1));
        cb(isApprover);
      })
      .catch(function () { isApprover = false; cb(false); });
  }
  function loadApprovals() {
    var box = document.getElementById('haa-approvals'); if (!box) return;
    checkApprover(function (ok) {
      if (!ok) { box.style.display = 'none'; return; }
      api('/api/attendance/wfh')
        .then(function (rows) {
          var pending = (Array.isArray(rows) ? rows : []).filter(function (r) { return /pending/i.test(String(r.status || '')); });
          var list = document.getElementById('haa-appr-list'); if (!list) return;
          box.style.display = pending.length ? '' : 'none';
          if (!pending.length) { list.innerHTML = ''; return; }
          list.innerHTML = pending.map(function (r) {
            return '<li class="haa-li"><span><span class="haa-who">' + esc(r.employee || r.email || '—') + '</span>' +
              '<div class="haa-sub">' + esc(r.fromDate || '—') + ' → ' + esc(r.toDate || '—') + (r.days ? ' · ' + esc(r.days) + 'd' : '') + '</div></span>' +
              '<div class="haa-li-actions">' +
                '<button class="haa-appr-btn approve" data-appr="' + esc(r.id) + '">Approve</button>' +
                '<button class="haa-appr-btn reject" data-rej="' + esc(r.id) + '">Reject</button>' +
              '</div></li>';
          }).join('');
          list.querySelectorAll('[data-appr]').forEach(function (b) { b.addEventListener('click', function () { decide('approve', b.getAttribute('data-appr'), b); }); });
          list.querySelectorAll('[data-rej]').forEach(function (b) { b.addEventListener('click', function () { decide('reject', b.getAttribute('data-rej'), b); }); });
        })
        .catch(function () { box.style.display = 'none'; });
    });
  }
  function decide(action, id, btn) {
    if (!id) return;
    var li = btn.closest('.haa-li');
    if (li) li.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    api('/api/attendance/wfh/' + action + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: Number(id) }) })
      .then(function () { loadApprovals(); loadWfh(); })
      .catch(function () { if (li) li.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); });
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  function submitWfh(card) {
    var em = actorEmail();
    var msg = card.querySelector('#haa-msg'), btn = card.querySelector('#haa-submit');
    var fromDate = card.querySelector('#haa-from').value, toDate = card.querySelector('#haa-to').value;
    var reason = card.querySelector('#haa-reason').value;
    msg.className = 'haa-msg';
    if (!em) { msg.textContent = 'Please sign in first.'; msg.className = 'haa-msg err'; return; }
    if (!fromDate || !toDate) { msg.textContent = 'Pick both dates.'; msg.className = 'haa-msg err'; return; }
    if (toDate < fromDate) { msg.textContent = 'The end date is before the start date.'; msg.className = 'haa-msg err'; return; }
    btn.disabled = true; btn.textContent = 'Submitting…';
    api('/api/attendance/wfh/submit/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, fromDate: fromDate, toDate: toDate, reason: reason }) })
      .then(function () { msg.textContent = 'Request submitted — your admin has been notified.'; msg.className = 'haa-msg ok'; card.querySelector('#haa-reason').value = ''; loadWfh(); })
      .catch(function (err) { msg.textContent = err.message || 'Could not submit the request.'; msg.className = 'haa-msg err'; })
      .then(function () { btn.disabled = false; btn.textContent = 'Request WFH'; });
  }
  function switchToWfh(e) {
    var btn = e.currentTarget, em = actorEmail(); if (!em) return;
    btn.disabled = true; btn.textContent = 'Switching…';
    api('/api/attendance/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, employee: actorName(), event: 'remote-switch', location: 'Home' }) })
      .then(function () { window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced', { detail: {} })); btn.textContent = 'Working from home ✓'; setTimeout(function () { loadTeam(); loadActivity(); }, 400); })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Switch to WFH';
        // The server refuses remote without an approved WFH request (or the
        // attendance.remote grant). Say why instead of silently resetting.
        var m = (err && err.message) || 'Could not switch to remote.';
        if (!showAttMsg(m, 'err') && window.alert) window.alert(m);
      });
  }

  /* ── layout ───────────────────────────────────────────────────────────── */
  /* ---- Forgot-punch tickets ---- */
  var ticketProofData = '';
  function kindLabel(k) { return k === 'forgot_checkin' ? 'Check-in correction' : (k === 'forgot_checkout' ? 'Check-out correction' : (k || '')); }
  function setMsg(el, t, c) { if (!el) return; el.textContent = t || ''; el.className = 'hat-msg' + (c ? (' ' + c) : ''); }
  function closeTicketModal() { var b = document.getElementById('hat-back'); if (b && b.parentNode) b.parentNode.removeChild(b); }

  function openTicketModal() {
    var em = actorEmail();
    if (!em) { if (window.alert) window.alert('Please sign in first.'); return; }
    ensureStyle();
    var back = document.createElement('div');
    back.id = 'hat-back'; back.className = 'hat-back haa-scope';
    back.innerHTML = '<div class="hat-modal"><div class="hat-loading">Loading…</div></div>';
    back.addEventListener('click', function (e) { if (e.target === back) closeTicketModal(); });
    document.body.appendChild(back);
    checkApprover(function (isAppr) {
      api('/api/attendance/punch-ticket?email=' + encodeURIComponent(em))
        .then(function (ctx) { renderTicketModal(back, ctx, isAppr); if (isAppr) loadTicketApprovals(back); })
        .catch(function (err) {
          var m = back.querySelector('.hat-modal');
          if (m) m.innerHTML = '<div class="hat-err">' + esc((err && err.message) || 'Could not load tickets.') + '</div><div class="hat-mf"><button class="cx" id="hat-x">Close</button></div>';
          var x = back.querySelector('#hat-x'); if (x) x.onclick = closeTicketModal;
        });
    });
  }

  function renderTicketModal(back, ctx, isAppr) {
    ticketProofData = '';
    var m = back.querySelector('.hat-modal'); if (!m) return;
    var canIn = ctx.canRaiseCheckin, canOut = ctx.canRaiseCheckout;
    var remaining = (ctx.remaining == null ? 0 : ctx.remaining), limit = ctx.limit || 3;
    var picker = '';
    if (canIn && canOut) {
      picker = '<div class="hat-f"><label>What did you forget?</label>' +
        '<select id="hat-kind" class="hat-in">' +
          '<option value="forgot_checkout">Correct check-out (missed)</option>' +
          '<option value="forgot_checkin">Correct check-in (late or missed)</option>' +
        '</select></div>';
    } else if (canIn) {
      picker = '<input type="hidden" id="hat-kind" value="forgot_checkin">' +
        '<div class="hat-note">Correct your <b>check-in</b>. On approval it is set to the office start time (' + esc(ctx.officeStart || '09:00') + ') — use this if you missed check-in, or checked in late but were working from the start.</div>';
    } else if (canOut) {
      picker = '<input type="hidden" id="hat-kind" value="forgot_checkout">' +
        '<div class="hat-note">You forgot to <b>check out</b> today. On approval your check-out becomes the office end time (' + esc(ctx.officeEnd || '18:00') + ').</div>';
    }
    var raise;
    if (canIn || canOut) {
      if (remaining <= 0) {
        raise = '<div class="hat-block">You have used all ' + limit + ' attendance tickets this month.</div>';
      } else {
        raise = picker +
          '<div class="hat-f"><label>Reason <span class="hat-req">*</span></label>' +
            '<textarea id="hat-reason" class="hat-in" placeholder="Why did you forget to punch? This is what the approver verifies."></textarea></div>' +
          '<div class="hat-f"><label>Proof — photo of attendance sheet <span class="hat-req">*</span></label>' +
            '<input type="file" accept="image/*" id="hat-file" class="hat-file">' +
            '<div id="hat-preview" class="hat-preview" style="display:none"></div></div>' +
          '<div class="hat-mf"><button class="cx" id="hat-cancel">Cancel</button>' +
            '<button class="ok" id="hat-submit">Submit ticket</button></div>' +
          '<div class="hat-msg" id="hat-msg"></div>';
      }
    } else {
      raise = '<div class="hat-block">' + esc(ctx.blockReason || 'Nothing to correct for today.') + '</div>';
    }
    var mine = (ctx.tickets || []).map(function (t) {
      var cls = String(t.status || 'Pending').toLowerCase();
      return '<li class="haa-li"><span><span class="haa-who">' + esc(kindLabel(t.kind)) + '</span>' +
        '<div class="haa-sub">' + esc(t.date || '') + (t.reviewerNote ? ' Â· ' + esc(t.reviewerNote) : '') + '</div></span>' +
        '<span class="haa-pill ' + esc(cls) + '">' + esc(t.status || 'Pending') + '</span></li>';
    }).join('') || '<li class="haa-empty">No tickets yet.</li>';

    m.innerHTML =
      '<div class="hat-head"><div class="hat-title">Attendance Tickets</div>' +
        '<div class="hat-count">' + remaining + ' of ' + limit + ' left this month</div></div>' +
      raise +
      '<div class="haa-list-title">My recent tickets</div>' +
      '<ul class="haa-list">' + mine + '</ul>' +
      '<div id="hat-approvals"></div>' +
      ((canIn || canOut) && remaining > 0 ? '' : '<div class="hat-mf"><button class="cx" id="hat-close2">Close</button></div>');

    var cancel = m.querySelector('#hat-cancel') || m.querySelector('#hat-close2');
    if (cancel) cancel.onclick = closeTicketModal;
    var file = m.querySelector('#hat-file'); if (file) file.addEventListener('change', onTicketFile);
    var sub = m.querySelector('#hat-submit'); if (sub) sub.onclick = function () { submitTicket(back, isAppr); };
  }

  function onTicketFile(e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var prev = document.getElementById('hat-preview');
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1400, w = img.width, h = img.height;
        if (w > max || h > max) { var sc = Math.min(max / w, max / h); w = Math.round(w * sc); h = Math.round(h * sc); }
        try {
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          ticketProofData = cv.toDataURL('image/jpeg', 0.72);
        } catch (_) { ticketProofData = reader.result; }
        if (prev) { prev.style.display = 'block'; prev.innerHTML = '<img src="' + ticketProofData + '" alt="proof">'; }
      };
      img.onerror = function () { ticketProofData = reader.result; if (prev) { prev.style.display = 'block'; prev.innerHTML = '<img src="' + ticketProofData + '" alt="proof">'; } };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  }

  function submitTicket(back, isAppr) {
    var m = back.querySelector('.hat-modal'); var em = actorEmail();
    var msg = m.querySelector('#hat-msg'), sub = m.querySelector('#hat-submit');
    var kindEl = m.querySelector('#hat-kind'); var kind = kindEl ? kindEl.value : '';
    var rEl = m.querySelector('#hat-reason'); var reason = (rEl ? rEl.value : '').trim();
    setMsg(msg, '', '');
    if (!kind) { setMsg(msg, 'Please choose what you forgot.', 'err'); return; }
    if (!reason) { setMsg(msg, 'Please enter a reason.', 'err'); return; }
    if (!ticketProofData) { setMsg(msg, 'Please attach a photo of the attendance sheet.', 'err'); return; }
    if (sub) { sub.disabled = true; sub.textContent = 'Submitting…'; }
    api('/api/attendance/punch-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, employeeName: actorName(), kind: kind, reason: reason, proofImage: ticketProofData }) })
      .then(function () { return api('/api/attendance/punch-ticket?email=' + encodeURIComponent(em)); })
      .then(function (ctx2) {
        renderTicketModal(back, ctx2, isAppr);
        if (isAppr) loadTicketApprovals(back);
        var okm = back.querySelector('#hat-msg') || back.querySelector('.hat-block');
        var note = document.createElement('div'); note.className = 'hat-msg ok'; note.textContent = 'Ticket submitted for approval.';
        var head = back.querySelector('.hat-head'); if (head && head.parentNode) head.parentNode.insertBefore(note, head.nextSibling);
      })
      .catch(function (err) { if (sub) { sub.disabled = false; sub.textContent = 'Submit ticket'; } setMsg(msg, (err && err.message) || 'Could not submit the ticket.', 'err'); });
  }

  function loadTicketApprovals(back) {
    var box = back.querySelector('#hat-approvals'); if (!box) return;
    api('/api/attendance/punch-ticket/pending').then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      var head = '<div class="haa-list-title">Pending tickets (team)</div>';
      if (!rows.length) { box.innerHTML = head + '<ul class="haa-list"><li class="haa-empty">No pending tickets.</li></ul>'; return; }
      box.innerHTML = head + '<ul class="haa-list">' + rows.map(function (r) {
        return '<li class="haa-li"><span><span class="haa-who">' + esc(r.employee || r.email) + '</span>' +
          '<div class="haa-sub">' + esc(kindLabel(r.kind)) + ' Â· ' + esc(r.date || '') + '</div>' +
          '<div class="haa-sub hat-reason">' + esc(r.reason || '') + '</div></span>' +
          '<div class="haa-li-actions">' +
            (r.hasProof ? '<button class="haa-switch" data-proof="' + esc(r.id) + '">Proof</button>' : '') +
            '<button class="haa-appr-btn approve" data-appr="' + esc(r.id) + '">Approve</button>' +
            '<button class="haa-appr-btn reject" data-rej="' + esc(r.id) + '">Reject</button>' +
          '</div></li>';
      }).join('') + '</ul>';
      box.querySelectorAll('[data-appr]').forEach(function (b) { b.onclick = function () { decideTicket(back, 'approve', b.getAttribute('data-appr'), b); }; });
      box.querySelectorAll('[data-rej]').forEach(function (b) { b.onclick = function () { decideTicket(back, 'reject', b.getAttribute('data-rej'), b); }; });
      box.querySelectorAll('[data-proof]').forEach(function (b) { b.onclick = function () { viewProof(b.getAttribute('data-proof')); }; });
    }).catch(function () { box.innerHTML = ''; });
  }

  function decideTicket(back, action, id, btn) {
    if (!id) return;
    var li = btn.closest('.haa-li'); if (li) li.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    api('/api/attendance/punch-ticket/' + id + '/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }) })
      .then(function () { loadTicketApprovals(back); window.dispatchEvent(new CustomEvent('hrmsAttendanceSynced', { detail: {} })); })
      .catch(function (err) { if (li) li.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); if (window.alert) window.alert((err && err.message) || 'Could not update the ticket.'); });
  }

  function viewProof(id) {
    api('/api/attendance/punch-ticket/' + id + '/proof').then(function (d) {
      var v = document.createElement('div'); v.className = 'hat-back haa-scope'; v.style.zIndex = '100001';
      v.innerHTML = '<div class="hat-modal hat-proofview"><div class="hat-head"><div class="hat-title">Proof of attendance</div></div>' +
        '<div class="hat-proofimg"><img src="' + ((d && d.proofImage) || '') + '" alt="proof"></div>' +
        '<div class="hat-mf"><button class="cx">Close</button></div></div>';
      v.addEventListener('click', function (e) { if (e.target === v || (e.target.classList && e.target.classList.contains('cx'))) v.remove(); });
      document.body.appendChild(v);
    }).catch(function (err) { if (window.alert) window.alert((err && err.message) || 'Could not load the proof.'); });
  }

  /* --- Employee attendance detail popup (opened from Team Status) --- */
  function openEmployeeDetail(email, name) {
    if (!email) return;
    ensureStyle();
    var back = document.createElement('div');
    back.className = 'hat-back haa-scope';
    back.innerHTML = '<div class="hat-modal hat-emp"><div class="hat-loading">Loading...</div></div>';
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    api('/api/attendance/day-detail?email=' + encodeURIComponent(email))
      .then(function (d) { renderEmployeeDetail(back, d, name); })
      .catch(function (err) {
        var m = back.querySelector('.hat-modal');
        if (m) m.innerHTML = '<div class="hat-err">' + esc((err && err.message) || 'Could not load attendance.') + '</div><div class="hat-mf"><button class="cx" data-close="1">Close</button></div>';
        var c = m && m.querySelector('[data-close]'); if (c) c.onclick = function () { back.remove(); };
      });
  }

  function renderEmployeeDetail(back, d, fallbackName) {
    var m = back.querySelector('.hat-modal'); if (!m) return;
    var name = d.employee || fallbackName || d.email || 'Employee';
    var badge = d.onTime ? '<span class="hat-badge ok">ON TIME</span>'
      : (d.status ? '<span class="hat-badge">' + esc(String(d.status).toUpperCase()) + '</span>' : '');
    var logs = (d.events || []).filter(function (e) { return /check/.test(e.event || ''); }).map(function (e) {
      return '<div class="hat-log"><span class="hat-lt">' + esc(e.time || '') + '</span>' +
        '<span class="hat-le">' + esc(e.label || e.event || '') + '</span>' +
        '<span class="hat-ll">' + esc(e.location || '') + '</span></div>';
    }).join('') || '<div class="hat-empty2">No clock events for this day.</div>';
    var punches = (d.punches || []).map(function (p) {
      return '<div class="hat-punch"><span class="hat-pt">' + esc(p.time || '') + '</span>' +
        '<span class="hat-pl">' + esc(p.label || 'Location recorded') + '</span>' +
        '<button class="hat-pin" data-lat="' + esc(p.latitude) + '" data-lng="' + esc(p.longitude) + '" data-label="' + esc(p.label || '') + '" data-time="' + esc(p.time || '') + '" title="View location">' + PIN_SVG + '</button></div>';
    }).join('') || '<div class="hat-empty2">No location punches recorded' + (d.isSelf ? ' yet. They are captured hourly while you are checked in.' : ' for this day.') + '</div>';

    m.innerHTML =
      '<div class="hat-head"><div><div class="hat-title">' + esc(name) + '</div>' +
        '<div class="hat-sub">' + esc(d.date || '') + (d.shift && d.shift.name ? ' &middot; ' + esc(d.shift.name) : '') +
        (d.shift && d.shift.start ? ' (' + esc(d.shift.start) + ' - ' + esc(d.shift.end) + ')' : '') + '</div></div>' +
        badge + '</div>' +
      '<div class="hat-clockrow">' +
        '<div class="hat-clock"><div class="hat-cl">Check In</div><div class="hat-cv">' + esc(d.checkIn || '--') + '</div></div>' +
        '<div class="hat-clock"><div class="hat-cl">Check Out</div><div class="hat-cv">' + esc(d.checkOut || '--') + '</div></div>' +
      '</div>' +
      '<div class="hat-hrs"><span>Effective <b>' + fmtMins(d.effectiveMinutes || 0) + '</b></span>' +
        '<span>Gross <b>' + fmtMins(d.grossMinutes || 0) + '</b></span></div>' +
      '<div class="haa-list-title">Time logs</div>' + logs +
      '<div class="haa-list-title">Location punch (hourly)</div><div class="hat-punchlist">' + punches + '</div>' +
      '<div class="hat-mf">' +
        (d.isSelf ? '<button class="ok" data-raise="1">Raise Request</button>' : '') +
        '<button class="cx" data-close="1">Close</button></div>';

    m.querySelector('[data-close]').onclick = function () { back.remove(); };
    var rq = m.querySelector('[data-raise]');
    if (rq) rq.onclick = function () { back.remove(); openTicketModal(); };
    m.querySelectorAll('.hat-pin').forEach(function (b) {
      b.onclick = function () {
        openLocationMap(parseFloat(b.getAttribute('data-lat')), parseFloat(b.getAttribute('data-lng')), b.getAttribute('data-label'), b.getAttribute('data-time'));
      };
    });
  }

  /* --- OSM tile preview (no external library, same idea as the admin map) --- */
  function tilePreview(lat, lng, W, H) {
    var z = 16, T = 256;
    function wx(l) { return (l + 180) / 360 * Math.pow(2, z) * T; }
    function wy(la) { var r = la * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * T; }
    var cx = wx(lng), cy = wy(lat), left = cx - W / 2, top = cy - H / 2, max = Math.pow(2, z);
    var x0 = Math.floor(left / T), x1 = Math.floor((left + W) / T);
    var y0 = Math.floor(top / T), y1 = Math.floor((top + H) / T);
    var imgs = '';
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        var tx = ((x % max) + max) % max;
        imgs += '<img alt="" src="https://tile.openstreetmap.org/' + z + '/' + tx + '/' + y + '.png" style="position:absolute;width:256px;height:256px;left:' + (x * T - left) + 'px;top:' + (y * T - top) + 'px;">';
      }
    }
    return '<div style="position:absolute;inset:0;overflow:hidden;">' + imgs + '</div><div class="hat-mkr">' + PIN_BIG + '</div>';
  }

  function openLocationMap(lat, lng, label, time) {
    if (!isFinite(lat) || !isFinite(lng)) { if (window.alert) window.alert('No coordinates for this location.'); return; }
    ensureStyle();
    var gmap = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    var v = document.createElement('div'); v.className = 'hat-back haa-scope'; v.style.zIndex = '100002';
    v.innerHTML = '<div class="hat-modal hat-mapmodal"><div class="hat-head"><div class="hat-title">Location</div></div>' +
      (label || time ? '<div class="hat-sub">' + esc(label || '') + (label && time ? ' &middot; ' : '') + esc(time || '') + '</div>' : '') +
      '<div class="hat-map" id="hat-map"></div>' +
      '<div class="hat-coord">' + lat.toFixed(5) + ', ' + lng.toFixed(5) + '</div>' +
      '<div class="hat-mf"><button class="cx" data-close="1">Close</button>' +
        '<a class="ok" href="' + gmap + '" target="_blank" rel="noopener">Open in maps</a></div></div>';
    v.addEventListener('click', function (e) { if (e.target === v || (e.target.closest && e.target.closest('[data-close]'))) v.remove(); });
    document.body.appendChild(v);
    var el = v.querySelector('#hat-map');
    if (el) {
      var W = el.clientWidth || 460, H = el.clientHeight || 260;
      try { el.innerHTML = tilePreview(lat, lng, W, H); }
      catch (_) { el.innerHTML = '<div class="hat-mapfallback">Preview unavailable - use Open in maps.</div>'; }
    }
  }

  /* --- location capture: fires ~hourly WHILE the tab is open ---------------
   * A single 1-hour setInterval is unreliable: browsers suspend/coalesce long
   * timers in background tabs, and getCurrentPosition is deferred while hidden,
   * so in practice it only ran on page load (i.e. on refresh). Instead we poll
   * every 5 minutes (and whenever the tab regains focus) and actually capture
   * only if an hour has elapsed since the last stored point. The elapsed check
   * uses localStorage so it survives reloads without double-storing, and the
   * server also throttles to hourly as a backstop. Requires the tab to be open
   * (a web page cannot capture location after the tab/app is closed). */
  var HOUR_MS = 60 * 60 * 1000;
  var geoBusy = false, geoRetryAt = 0;
  function lastTsKey() { return 'hrms_loc_ts_' + (actorEmail() || ''); }
  function getLastTs() { try { return parseInt(localStorage.getItem(lastTsKey()) || '0', 10) || 0; } catch (_) { return 0; } }
  function setLastTs(t) { try { localStorage.setItem(lastTsKey(), String(t)); } catch (_) {} }

  function captureLocation() {
    var em = actorEmail();
    if (!em || !navigator.geolocation) { geoBusy = false; return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy;
      var send = function (label) {
        api('/api/attendance/location-punch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, latitude: lat, longitude: lng, accuracy: acc, label: label || '' }) })
          .then(function (r) {
            if (r && r.stored) setLastTs(Date.now());
            else if (r && r.reason === 'not_checked_in') geoRetryAt = Date.now() + 30 * 60 * 1000;
          })
          .catch(function () {})
          .then(function () { geoBusy = false; });
      };
      try {
        fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat + '&lon=' + lng, { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (j) { var a = (j && j.address) || {}; var city = a.city || a.town || a.village || a.suburb || a.county || ''; send([city, a.state || ''].filter(Boolean).join(', ')); })
          .catch(function () { send(''); });
      } catch (_) { send(''); }
    }, function () { geoBusy = false; geoRetryAt = Date.now() + 10 * 60 * 1000; }, { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 });
  }

  function maybeCapture() {
    var em = actorEmail(); if (!em || geoBusy) return;
    var now = Date.now();
    if (now < geoRetryAt) return;
    if ((now - getLastTs()) < 58 * 60 * 1000) return;   // still within the hour
    geoBusy = true;
    captureLocation();
  }

  var trackingStarted = false;
  function startLocationTracking() {
    if (trackingStarted || !actorEmail()) return;
    trackingStarted = true;
    setTimeout(maybeCapture, 5000);                 // first sample shortly after load
    setInterval(maybeCapture, 5 * 60 * 1000);       // re-check every 5 min; stores hourly
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') maybeCapture();
    });
    window.addEventListener('focus', maybeCapture);
  }

  function appendOrdered(grid, node, order) {
    node.style.order = order;
    if (node.parentElement !== grid) grid.appendChild(node);
  }
  function ensureLayout() {
    if (!onCheckinPage()) {
      document.body.classList.remove('hrms-checkin-page');
      [ID.wfh, ID.act, ID.team, ID.ot, ID.brk].forEach(function (id) { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
      return;
    }
    var clock = clockCard();
    if (!clock) return;
    var grid = clock.parentElement;
    if (!grid) return;

    ensureStyle();
    document.body.classList.add('hrms-checkin-page');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = (window.innerWidth <= 900 ? '1fr' : '1fr 1fr');
    grid.style.gap = '14px';
    grid.style.alignItems = 'start';
    clock.style.order = '10';

    // Overtime + break totals inside the check-in card (restored from cache; fetched once).
    ensureOvertimeLine(clock);
    ensureBreakLine(clock);
    if (otVal === null || brkVal === null) loadOvertime();

    // Hide the app's combined Activity+Team card (we render our own two).
    var reactCard = reactActTeam();
    if (reactCard && reactCard !== clock) reactCard.style.display = 'none';

    // Our three cards, appended at the end, arranged by CSS order:
    //   Check In (10) | Today's Activity Log (20)
    //   Work From Home (30) | Team Status Now (40)
    var act = document.getElementById(ID.act), freshAct = false;
    if (!act) { act = buildActivityCard(); freshAct = true; }
    appendOrdered(grid, act, '20');

    var wfh = document.getElementById(ID.wfh), freshWfh = false;
    if (!wfh) { wfh = buildWfhCard(); freshWfh = true; }
    appendOrdered(grid, wfh, '30');

    var team = document.getElementById(ID.team), freshTeam = false;
    if (!team) { team = buildTeamCard(); freshTeam = true; }
    appendOrdered(grid, team, '40');

    if (freshWfh) { loadWfh(); loadApprovals(); }
    if (freshAct) { loadActivity(); }
    if (freshTeam) { loadTeam(); }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  function tick() { removeLegacyPortal(); ensureLayout(); }
  function start() {
    tick();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; tick(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', tick);
    var _rz; window.addEventListener('resize', function () { clearTimeout(_rz); _rz = setTimeout(function () { if (onCheckinPage()) ensureLayout(); }, 150); });
    window.addEventListener('hrmsAttendanceSynced', function () { loadOvertime(); loadWfh(); loadApprovals(); loadActivity(); loadTeam(); });
    window.addEventListener('hrmsContextUpdate', function () { loadOvertime(); loadWfh(); loadApprovals(); loadActivity(); loadTeam(); });
    // The app's own Switch to Remote / Switch to Office post the same
    // remote-switch event our button does, and the server refuses it without
    // an approved WFH request. That card has nowhere to print the reason, so
    // it hands it to us; preventDefault() tells it we displayed the message
    // and it should not alert on top of us.
    window.addEventListener('hrmsAttendanceEventFailed', function (e) {
      var msg = (e.detail && e.detail.message) || 'Could not complete that action.';
      if (onCheckinPage() && showAttMsg(msg, 'err')) e.preventDefault();
    });
    // Check-in toggled (topbar switch) → refresh totals + team status.
    window.addEventListener('hrmsCheckinToggle', function () { loadOvertime(); loadTeam(); });
    setInterval(function () { if (onCheckinPage() && document.getElementById(ID.team)) { loadTeam(); loadActivity(); loadOvertime(); } }, 30000);
    startLocationTracking();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
