/**
 * hrms-f2f-candidate-info.js
 * ---------------------------------------------------------------------------
 * Recruit > F2F Interview > Schedule & Links (/recruit/interview).
 *
 * The "Share Interview Link" card only ever showed the meeting link and the
 * send/copy actions. Clicking a candidate — either in "Select Candidate" on
 * the left, or "Manage" on a row in "All Interview Links" below — gave no
 * way to see who they actually are: their resume, the JD they were matched
 * against, the platform/date/time they're booked for, or the questions Eva
 * (the AI interviewer) will ask them.
 *
 * This adds a "Candidate Details" panel to the bottom of the Share Interview
 * Link card whenever a candidate is selected, sourced entirely from the
 * existing /api/interviews record (resumeText, jdText, interviewQuestions,
 * platform, interviewDate, time) — no new endpoints.
 *
 * No-rebuild injection pattern (see hrms-interviews.js): our own DOM node,
 * appended once and kept mounted by a MutationObserver.
 */
(function () {
  'use strict';

  var IV_PATH = '/recruit/interview';
  var STYLE_ID = 'f2fcd-style';
  var PANEL_ID = 'f2fcd-panel';

  var DATA = [];
  var loaded = false, loading = false;
  var state = { email: '', name: '', full: {} };

  function onPage() { return location.pathname.replace(/\/+$/, '').indexOf(IV_PATH) === 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function api(path, opts) {
    var init = opts || {};
    init.headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) throw new Error((d && (d.error || d.detail || d.message)) || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function findByEmail(email) {
    var e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    for (var i = 0; i < DATA.length; i++) {
      if (String(DATA[i].email || '').trim().toLowerCase() === e) return DATA[i];
    }
    return null;
  }

  // The app pads its candidate list with demo rows that live only inside the
  // React bundle (Ravi Kumar, Ananya Singh, ...) and never reach /api/interviews.
  // For those, build the record from what is already on screen — name/email
  // from the clicked row, role/date/time/status from the All Interview Links
  // table — so the panel still opens instead of silently doing nothing.
  function fallbackRecord(email) {
    var rec = { email: email, name: state.name || email.split('@')[0], fromScreen: true };
    var lCard = linksCard();
    if (!lCard) return rec;
    var rows = lCard.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      if (emailFromNode(tr) !== email) continue;
      var cells = tr.cells;
      if (cells.length >= 3) {
        rec.role = (cells[1].textContent || '').trim();
        var strong = cells[2].querySelector('strong');
        if (strong) {
          rec.interviewDate = (strong.textContent || '').trim();
          rec.time = (cells[2].textContent || '').replace(rec.interviewDate, '').trim();
        }
      }
      break;
    }
    return rec;
  }

  var retryAt = 0;
  function load(force) {
    if (loading || (loaded && !force)) return;
    if (Date.now() < retryAt) return;
    loading = true;
    api('/api/interviews')
      .then(function (rows) { DATA = Array.isArray(rows) ? rows : []; loaded = true; retryAt = 0; })
      .catch(function () { retryAt = Date.now() + 15000; })
      .then(function () { loading = false; render(); if (state.email) prefillScheduleForm(state.email); });
  }

  function cardByTitle(title) {
    var titles = document.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || '').trim() === title) {
        return titles[i].closest('.card') || titles[i].parentNode;
      }
    }
    return null;
  }
  function candidateCard() { return cardByTitle('Schedule Interview & Generate Link'); }
  function shareCard() { return cardByTitle('Share Interview Link'); }
  function linksCard() { return cardByTitle('All Interview Links'); }

  /* ---- styles ---- */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      // A normal grid item (grid-column:2, see render()) — it now IS the
      // primary content of that column, with "Share Interview Link" (a real
      // React node, repositioned by JS — see positionShareCardBelowPanel())
      // tucked seamlessly underneath it. Rounded top / flat bottom, since
      // this is the box that now visually opens the column.
      '.f2fcd-panel{background:var(--bg2,#151b2e);border:1px solid var(--border2);border-bottom:none;border-radius:12px 12px 0 0;padding:20px;box-sizing:border-box;}',
      '.f2fcd-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.f2fcd-hd b{font-size:12px;font-weight:700;color:var(--text2,var(--text));}',
      '.f2fcd-body{margin-top:10px;display:flex;flex-direction:column;gap:10px;}',
      '.f2fcd-sub{font-size:11px;color:var(--text3,#64748b);margin-top:-4px;}',
      '.f2fcd-row{display:flex;gap:8px;flex-wrap:wrap;}',
      '.f2fcd-tile{flex:1 1 130px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;min-width:0;}',
      '.f2fcd-lbl{font-size:10px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--text3,#64748b);margin-bottom:3px;}',
      '.f2fcd-val{font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.f2fcd-block{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 11px;}',
      '.f2fcd-block .f2fcd-lbl{margin-bottom:6px;}',
      '.f2fcd-scroll{position:relative;max-height:150px;overflow-y:auto;font-size:11.5px;line-height:1.55;color:var(--text2,var(--text));white-space:pre-wrap;word-break:break-word;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--text3,#64748b) transparent;padding-right:6px;}',
      '.f2fcd-scroll::-webkit-scrollbar{width:8px;}',
      '.f2fcd-scroll::-webkit-scrollbar-thumb{background:var(--text3,#64748b);border-radius:8px;}',
      '.f2fcd-scroll.full{max-height:none;overflow:visible;}',
      '.f2fcd-more{display:inline-flex;align-items:center;gap:4px;margin-top:7px;background:none;border:1px solid var(--border2);border-radius:6px;padding:4px 10px;font:inherit;font-size:11px;font-weight:700;color:var(--accent,#4f8ef7);cursor:pointer;}',
      '.f2fcd-more:hover{background:rgba(79,142,247,.1);}',
      '.f2fcd-empty{font-size:11.5px;color:var(--text3,#64748b);font-style:italic;}',
      '.f2fcd-qlist{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;}',
      '.f2fcd-qlist li{font-size:11.5px;line-height:1.5;color:var(--text2,var(--text));}',
      '.f2fcd-resched{flex:0 0 auto;width:30px;height:30px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--accent,#4f8ef7);cursor:pointer;display:flex;align-items:center;justify-content:center;}',
      '.f2fcd-resched:hover{border-color:var(--accent,#4f8ef7);background:rgba(79,142,247,.1);}',
      /* ---- Reschedule modal ---- */
      '.f2fre-ovl{position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.6);display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow:auto;}',
      '.f2fre-modal{background:var(--bg2,#151b2e);color:var(--text);border:1px solid var(--border2);border-radius:18px;width:min(880px,96vw);box-shadow:0 24px 70px rgba(2,6,23,.5);font-family:var(--font,inherit);}',
      '.f2fre-head{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--border2);}',
      '.f2fre-head h3{margin:0;font-size:18px;font-weight:800;}',
      '.f2fre-x{width:32px;height:32px;border-radius:8px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2,var(--text));cursor:pointer;font-size:18px;line-height:1;}',
      '.f2fre-x:hover{border-color:var(--accent,#4f8ef7);}',
      '.f2fre-body{padding:22px 24px;max-height:80vh;overflow-y:auto;}',
      '.f2fre-info{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:16px;margin-bottom:16px;}',
      '.f2fre-info div{min-width:0;}',
      '.f2fre-ilbl{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3,#64748b);margin-bottom:4px;}',
      '.f2fre-ival{font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.f2fre-isub{font-size:11px;color:var(--text3,#64748b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.f2fre-cancelled{display:flex;gap:12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);border-radius:12px;padding:14px 16px;margin-bottom:18px;}',
      '.f2fre-cancelled b{color:#f87171;font-size:13.5px;}',
      '.f2fre-cancelled p{margin:4px 0 8px;font-size:12.5px;color:var(--text2,var(--text));}',
      '.f2fre-cancelled .row{font-size:12px;color:var(--text2,var(--text));display:flex;gap:6px;align-items:center;margin-top:3px;}',
      '.f2fre-lbl{font-size:12.5px;font-weight:600;color:var(--text2,var(--text));margin-bottom:6px;}',
      '.f2fre-select{width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:10px 12px;color:var(--text);font:inherit;font-size:13px;outline:none;margin-bottom:18px;}',
      '.f2fre-select:focus{border-color:var(--accent,#4f8ef7);}',
      '.f2fre-other{margin-top:-10px;}',
      '.f2fre-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;}',
      '.f2fre-panel{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:14px;}',
      '.f2fre-panel h4{margin:0 0 12px;font-size:13.5px;font-weight:700;display:flex;align-items:center;gap:7px;}',
      '.f2fre-datepill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--text2,var(--text));margin-bottom:10px;}',
      '.f2fre-slots{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
      '.f2fre-slot{background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:9px;font:inherit;font-size:12.5px;font-weight:600;color:var(--text2,var(--text));cursor:pointer;}',
      '.f2fre-slot:hover{border-color:var(--accent,#4f8ef7);}',
      '.f2fre-slot.on{background:rgba(79,142,247,.18);border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7);}',
      '.f2fre-added{margin-top:12px;display:flex;flex-direction:column;gap:6px;}',
      '.f2fre-chip{display:flex;align-items:center;justify-content:space-between;background:var(--bg2);border:1px solid rgba(34,197,94,.4);border-radius:8px;padding:7px 10px;font-size:12px;color:#4ade80;font-weight:600;}',
      '.f2fre-chip button{background:none;border:none;color:#4ade80;cursor:pointer;font-size:14px;line-height:1;}',
      '.f2fre-calhd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}',
      '.f2fre-calhd button{background:var(--bg2);border:1px solid var(--border2);border-radius:6px;color:var(--text2,var(--text));cursor:pointer;width:26px;height:26px;}',
      '.f2fre-calhd button:disabled{opacity:.35;cursor:not-allowed;}',
      '.f2fre-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}',
      '.f2fre-dow{font-size:10px;text-align:center;color:var(--text3,#64748b);font-weight:700;padding-bottom:4px;}',
      '.f2fre-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:11.5px;border-radius:6px;background:var(--bg2);border:1px solid transparent;cursor:pointer;color:var(--text2,var(--text));}',
      '.f2fre-day:hover:not(.off):not(.unavail){border-color:var(--accent,#4f8ef7);}',
      '.f2fre-day.off{visibility:hidden;cursor:default;}',
      '.f2fre-day.unavail{opacity:.3;cursor:not-allowed;background:transparent;}',
      '.f2fre-day.selected{background:rgba(34,197,94,.22);border-color:#22c55e;color:#4ade80;font-weight:700;}',
      '.f2fre-day.cancelled{background:rgba(239,68,68,.2);border-color:#ef4444;color:#f87171;font-weight:700;font-size:9px;}',
      '.f2fre-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;font-size:10.5px;color:var(--text3,#64748b);}',
      '.f2fre-legend span{display:inline-flex;align-items:center;gap:5px;}',
      '.f2fre-dot{width:10px;height:10px;border-radius:3px;display:inline-block;}',
      '.f2fre-foot{display:flex;gap:10px;margin-top:20px;}',
      '.f2fre-foot button{flex:1;padding:13px;border-radius:10px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;}',
      '.f2fre-cancel{background:var(--bg3);border:1px solid var(--border2);color:var(--text2,var(--text));}',
      '.f2fre-add{background:var(--bg3);border:1px solid var(--border2);color:var(--text2,var(--text));}',
      '.f2fre-confirm{background:var(--accent,#4f8ef7);border:none;color:#fff;}',
      '.f2fre-confirm:disabled{opacity:.5;cursor:not-allowed;}',
      '@media(max-width:640px){.f2fre-info{grid-template-columns:1fr 1fr;} .f2fre-cols{grid-template-columns:1fr;} .f2fre-foot{flex-wrap:wrap;}}'
    ].join('');
    var el = document.createElement('style'); el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---- picking a candidate email out of a clicked row ---- */
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var STRICT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  function emailFromNode(node) {
    if (!node) return '';
    var all = node.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].childElementCount === 0) {
        var t = (all[i].textContent || '').trim();
        if (STRICT_EMAIL.test(t)) return t.toLowerCase();
      }
    }
    var m = (node.textContent || '').match(EMAIL_RE);
    return m ? m[0].toLowerCase() : '';
  }
  // Candidate rows in "Select Candidate" are the only clickable (cursor:pointer)
  // divs in that card that carry an email — walk up from the click target to
  // find that row without depending on any class name (React ships none here).
  function findClickableRow(el, root) {
    var n = el;
    for (var i = 0; i < 8 && n && n !== root; i++) {
      if (n.style && n.style.cursor === 'pointer' && EMAIL_RE.test(n.textContent || '')) return n;
      n = n.parentElement;
    }
    return null;
  }

  // The name sits in the leaf just before the email in both the candidate row
  // and the table's candidate cell (avatar initials are 1-3 letters, skipped).
  function nameFromNode(node) {
    var leaves = [], all = node.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].childElementCount === 0) { var t = (all[i].textContent || '').trim(); if (t) leaves.push(t); }
    }
    for (var j = 0; j < leaves.length; j++) {
      if (STRICT_EMAIL.test(leaves[j])) {
        for (var k = j - 1; k >= 0; k--) if (leaves[k].length > 3) return leaves[k];
        return '';
      }
    }
    return '';
  }
  function select(node) {
    var email = emailFromNode(node);
    if (!email) return;
    state.email = email;
    state.name = nameFromNode(node);
    state.full = {};
    render();
    prefillScheduleForm(email);
  }

  // React controls the Date/Time inputs and the Platform buttons through its
  // own state (c/h/l in the bundle), set only from the row's own onClick —
  // never from what is already saved for that candidate. So a candidate who
  // already has a date, time and platform on file (scheduled from a previous
  // session, or seeded data) still shows blank fields and a disabled
  // "Generate Meeting Link" button until someone retypes what is already
  // known. This fills those fields in from the interview record so the
  // button lights up immediately — same one-click flow as a candidate who
  // already has a link.
  function setNativeValue(input, value) {
    var proto = window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function prefillScheduleForm(email) {
    setTimeout(function () {
      var iv = findByEmail(email);
      if (!iv || iv.link) return;               // already has a link to share
      if (!iv.interviewDate && !iv.time && !iv.platform) return;  // nothing on file to fill in
      var card = candidateCard();
      if (!card) return;
      var dateInput = card.querySelector('input[type="date"]');
      var timeInput = card.querySelector('input[type="time"]');
      if (dateInput && !dateInput.value && /^\d{4}-\d{2}-\d{2}$/.test(iv.interviewDate || '')) {
        setNativeValue(dateInput, iv.interviewDate);
      }
      if (timeInput && !timeInput.value && /^\d{2}:\d{2}$/.test(iv.time || '')) {
        setNativeValue(timeInput, iv.time);
      }
      if (iv.platform) {
        var btns = card.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var label = (btns[i].textContent || '').replace(/^\S+\s/, '').trim(); // drop a leading emoji/icon
          if (label === iv.platform || (btns[i].textContent || '').trim() === iv.platform) { btns[i].click(); break; }
        }
      }
    }, 60); // after React processes its own onClick for the row
  }

  function onDocClick(e) {
    if (!onPage()) return;
    var cCard = candidateCard();
    if (cCard && cCard.contains(e.target)) {
      var row = findClickableRow(e.target, cCard);
      if (row) select(row);
      return;
    }
    var lCard = linksCard();
    if (lCard && lCard.contains(e.target)) {
      var btn = e.target.closest('button');
      if (btn && /manage/i.test((btn.textContent || ''))) select(btn.closest('tr'));
    }
  }

  /* ---- render ---- */
  function fmtQuestions(list) {
    if (!Array.isArray(list) || !list.length) return '<div class="f2fcd-empty">No AI-generated questions for this interview yet.</div>';
    return '<ol class="f2fcd-qlist">' + list.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>';
  }
  function fmtText(t, emptyMsg, key) {
    var v = String(t || '').trim();
    if (!v) return '<div class="f2fcd-empty">' + esc(emptyMsg) + '</div>';
    var full = !!state.full[key];
    return '<div class="f2fcd-scroll' + (full ? ' full' : '') + '" data-key="' + esc(key) + '">' + esc(v) + '</div>' +
      '<button type="button" class="f2fcd-more" data-more="' + esc(key) + '">' + (full ? 'Show less' : 'Show full') + '</button>';
  }
  // Only a real, already-scheduled interview record can be rescheduled — a
  // demo-list fallback (see fallbackRecord()) has no id to PATCH.
  function canReschedule(iv) { return !!(iv && iv.id && !iv.fromScreen && iv.interviewDate); }

  // Where the panel lives: NOT inside the "Share Interview Link" card itself.
  // That card's own children swap completely between two render branches
  // (empty placeholder vs. meeting-link box + buttons), so appending into it
  // desyncs React's reconciliation — the very next re-render throws
  // "NotFoundError: Failed to execute 'removeChild'" and takes the whole app
  // down to a blank page. The two-column row that holds both cards
  // (".grid-2") always has exactly those two children, never more or fewer,
  // so a third node appended after them is never something React expects to
  // find or remove itself.
  function panelHost() {
    var card = shareCard();
    if (!card) return null;
    return card.parentElement && card.parentElement.classList.contains('grid-2')
      ? card.parentElement
      : card;
  }

  // The "Auto Follow-up: Reminder sent 24h and 1h before the interview" note
  // now sits directly above the merged Candidate Details panel and reads as
  // clutter there, so it's hidden. Only ever a style.display toggle on
  // React's own node — same rule as everywhere else in this file: never
  // remove or replace something React rendered, or its next re-render of
  // this card (a new link, a resent invite) throws trying to reconcile a
  // child that is no longer there and crashes the app.
  function hideFollowupNote() {
    var card = shareCard();
    if (!card) return;
    Array.prototype.forEach.call(card.children, function (ch) {
      if (ch.style.display !== 'none' && (ch.textContent || '').indexOf('Auto Follow-up:') !== -1) {
        ch.style.display = 'none';
      }
    });
  }

  // Candidate Details now needs to render ABOVE "Share Interview Link" —
  // but that card is a real React node fixed at grid-column:2/row:1, and
  // there is no safe way to move a React-owned element earlier in the DOM
  // (reparenting it is exactly the kind of mutation that desyncs React's
  // reconciliation — see panelHost() above). So instead we flip which of
  // the two is the plain grid item: the panel takes grid-column:2 in normal
  // flow (see render()), which is what makes it render first, and the share
  // card is pulled out of flow with position:absolute and placed by
  // measured geometry directly under it — a plain style property on React's
  // own node, never anything it would need to reconcile away. Because that
  // takes it out of normal flow, ".grid-2" no longer reserves room for it,
  // so we pad the host by exactly how far it reaches past the row, which
  // pushes "All Interview Links" below it down instead of being overlapped.
  function positionShareCardBelowPanel(share, panel, host) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (share.style.position !== 'absolute') { share.style.position = 'absolute'; share.style.zIndex = '0'; }
    var left = panel.offsetLeft, width = panel.offsetWidth, top = panel.offsetTop + panel.offsetHeight - 13;
    if (Math.abs((parseFloat(share.style.left) || 0) - left) > 0.5) share.style.left = left + 'px';
    if (Math.abs((parseFloat(share.style.width) || 0) - width) > 0.5) share.style.width = width + 'px';
    if (Math.abs((parseFloat(share.style.top) || 0) - top) > 0.5) share.style.top = top + 'px';

    var appliedPad = parseFloat(host.style.paddingBottom) || 0;
    var baseHeight = host.getBoundingClientRect().height - appliedPad; // host's height without our own reservation
    var needed = Math.max(0, (top + share.offsetHeight) - baseHeight);
    if (Math.abs(appliedPad - needed) > 1) host.style.paddingBottom = needed + 'px';
  }
  // Puts the share card back to its normal, single-column position — used
  // whenever no candidate is selected, so the page looks exactly as it did
  // before any of this (a plain style reset, not a removal).
  function resetShareCardPosition(share, host) {
    if (share && share.style.position) {
      share.style.position = ''; share.style.left = ''; share.style.top = '';
      share.style.width = ''; share.style.zIndex = '';
    }
    if (host && host.style.paddingBottom) host.style.paddingBottom = '';
  }
  var relayoutQueued = false;
  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(function () {
      relayoutQueued = false;
      var panel = document.getElementById(PANEL_ID), share = shareCard(), host = panelHost();
      if (panel && share && host && panel.style.display !== 'none') positionShareCardBelowPanel(share, panel, host);
    });
  }

  function render() {
    if (!onPage()) return;
    ensureStyle();
    var host = panelHost();
    if (!host) return;
    var panel = document.getElementById(PANEL_ID);
    if (!panel || panel.parentElement !== host) {
      panel = document.createElement('div');
      panel.id = PANEL_ID; panel.className = 'f2fcd-panel';
      // ".grid-2" is a fixed two-column grid (grid-template-columns:1fr 1fr).
      // Placing the panel explicitly in column 2 (normal flow — the share
      // card is what's pulled out of flow now, see positionShareCardBelowPanel())
      // is what makes it render first, opening that column. On the mobile
      // breakpoint .grid-2 collapses to a single column, where this has no
      // effect and the panel simply stacks like everything else.
      panel.style.gridColumn = '2';
      host.appendChild(panel);
    } else if (host.lastElementChild !== panel) {
      // React only ever manages its own two children of .grid-2; re-appending
      // ours after them (instead of inserting) never touches nodes it owns.
      host.appendChild(panel);
    }
    if (!state.email) {
      panel.style.display = 'none';
      resetShareCardPosition(shareCard(), host);
      return;
    }
    var iv = findByEmail(state.email);
    // Still fetching: don't flash the fallback for a candidate the API will
    // know about a moment later.
    if (!iv && !loaded) { panel.style.display = 'none'; return; }
    if (!iv) iv = fallbackRecord(state.email);
    panel.style.display = '';
    relayout();

    // tick() runs on every DOM mutation anywhere on the page (live clocks,
    // status pills...). Rebuilding the HTML each time reset the Resume/JD
    // scroll position the moment the user scrolled it and killed the Show
    // full buttons mid-click, so only rebuild when the candidate changes.
    var key = [state.email, iv.id || '', iv.fromScreen ? 's' : 'd', iv.resumeText ? 1 : 0, iv.jdText ? 1 : 0,
      (iv.interviewQuestions || []).length, iv.platform || '', iv.interviewDate || '', iv.time || '', iv.role || ''].join('|');
    if (panel.getAttribute('data-key') === key) return;
    panel.setAttribute('data-key', key);

    var when = iv.interviewDate
      ? esc(iv.interviewDate) + (iv.time ? ' · ' + esc(iv.time) : '')
      : 'Not scheduled yet';
    var platform = iv.platform ? esc(iv.platform) : 'Not selected yet';
    var role = iv.role ? esc(iv.role) : 'Not specified';
    var sub = iv.email ? esc(iv.email) : '';
    var demoNote = iv.fromScreen
      ? '<div class="f2fcd-empty" style="margin-top:-2px">This is a sample candidate from the demo list — it has no interview record in the database, so no resume, JD or questions can be shown.</div>'
      : '';

    panel.innerHTML =
      '<div class="f2fcd-hd"><b>Candidate Details — ' + esc(iv.name || '') + '</b>' +
        (canReschedule(iv) ? '<button type="button" class="f2fcd-resched" id="f2fcd-resched" title="Reschedule interview"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>' : '') +
      '</div>' +
      '<div class="f2fcd-body" id="f2fcd-body">' +
        (sub ? '<div class="f2fcd-sub">' + sub + '</div>' : '') +
        demoNote +
        '<div class="f2fcd-row">' +
          '<div class="f2fcd-tile"><div class="f2fcd-lbl">Role Applying For</div><div class="f2fcd-val" title="' + role + '">' + role + '</div></div>' +
          '<div class="f2fcd-tile"><div class="f2fcd-lbl">Platform</div><div class="f2fcd-val">' + platform + '</div></div>' +
          '<div class="f2fcd-tile"><div class="f2fcd-lbl">Scheduled</div><div class="f2fcd-val">' + when + '</div></div>' +
        '</div>' +
        '<div class="f2fcd-block"><div class="f2fcd-lbl">Resume</div>' + fmtText(iv.resumeText, 'No resume on file for this interview.', 'resume') + '</div>' +
        '<div class="f2fcd-block"><div class="f2fcd-lbl">Job Description</div>' + fmtText(iv.jdText, 'No job description on file for this interview.', 'jd') + '</div>' +
        '<div class="f2fcd-block"><div class="f2fcd-lbl">Questions Asked by AI Eva</div>' + fmtQuestions(iv.interviewQuestions) + '</div>' +
      '</div>';

    // Only the button is re-rendered, so the text box (and the page) keep
    // their scroll position when expanding.
    panel.querySelectorAll('.f2fcd-more').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-more');
        state.full[key] = !state.full[key];
        var box = panel.querySelector('.f2fcd-scroll[data-key="' + key + '"]');
        if (box) box.classList.toggle('full', !!state.full[key]);
        b.textContent = state.full[key] ? 'Show less' : 'Show full';
        relayout();  // panel's height just changed — reposition/re-reserve space
      });
    });
    var reschedBtn = panel.querySelector('#f2fcd-resched');
    if (reschedBtn) reschedBtn.addEventListener('click', function () { openReschedule(iv); });
    relayout();  // new content just replaced the old — its height likely changed
  }

  /* ---- Reschedule modal ---- */
  var RESCHED_SLOTS = ['10:00', '11:00', '13:00', '14:00', '15:00'];
  var RESCHED_REASONS = ['Recruiter Conflict', 'Candidate Request', 'Interviewer Unavailable', 'Technical Issue', 'Panel Change', 'Other'];
  // "Other" alone says nothing useful once saved — use what was actually
  // typed instead, wherever the reason gets persisted or displayed.
  function effectiveReason() {
    if (!rs) return '';
    if (rs.reason === 'Other') return rs.customReason.trim() || 'Other';
    return rs.reason;
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function to12h(hhmm) {
    var parts = String(hhmm || '').split(':'); if (parts.length < 2) return hhmm || '';
    var h = parseInt(parts[0], 10), m = parts[1];
    var ap = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + ap;
  }
  function fmtDateLong(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return iso || '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  function reschedKey(id) { return 'f2fcd_resched_' + id; }
  function getCancelledInfo(id) {
    try { return JSON.parse(localStorage.getItem(reschedKey(id)) || 'null'); } catch (_) { return null; }
  }
  function setCancelledInfo(id, info) {
    try { localStorage.setItem(reschedKey(id), JSON.stringify(info)); } catch (_) { /* private mode etc — non-fatal */ }
  }

  var rs = null; // reschedule-modal state, live only while the modal is open
  function closeReschedule() {
    var ovl = document.getElementById('f2fre-ovl');
    if (ovl && ovl.parentNode) ovl.parentNode.removeChild(ovl);
    document.removeEventListener('keydown', reschedEsc);
    rs = null;
  }
  function reschedEsc(e) { if (e.key === 'Escape') closeReschedule(); }

  function openReschedule(iv) {
    closeReschedule();
    var today = new Date();
    var pre = iv.interviewDate && /^\d{4}-\d{2}-\d{2}$/.test(iv.interviewDate) ? iv.interviewDate : '';
    var preD = pre ? new Date(pre + 'T00:00:00') : today;
    rs = {
      iv: iv,
      year: preD.getFullYear(), month: preD.getMonth(),
      selectedDate: pre || '', selectedTime: /^\d{2}:\d{2}$/.test(iv.time || '') ? iv.time : '',
      added: [], reason: RESCHED_REASONS[0], customReason: '', saving: false
    };
    var ovl = document.createElement('div');
    ovl.className = 'f2fre-ovl'; ovl.id = 'f2fre-ovl';
    document.body.appendChild(ovl);
    ovl.addEventListener('click', function (e) { if (e.target === ovl) closeReschedule(); });
    document.addEventListener('keydown', reschedEsc);
    renderReschedule();
  }

  function renderReschedule() {
    if (!rs) return;
    var ovl = document.getElementById('f2fre-ovl');
    if (!ovl) return;
    var iv = rs.iv;
    var cancelled = getCancelledInfo(iv.id);
    var interviewType = (Array.isArray(iv.interviewType) && iv.interviewType.length) ? iv.interviewType.join(', ') : 'Technical Interview';
    var assignedBy = iv.createdByName || iv.interviewer || 'Recruiter';

    var cancelledHtml = cancelled
      ? '<div class="f2fre-cancelled"><div style="flex:none;font-size:20px;line-height:1">⚠️</div><div>' +
          '<b>Previous Interview Rescheduled</b>' +
          '<p>This interview was moved by ' + esc(cancelled.by || 'Recruiter') + ' on ' + esc(fmtDateLong(cancelled.at ? cancelled.at.slice(0, 10) : '')) + '.</p>' +
          '<div class="row">📅&nbsp;<b>Previous Slot:</b>&nbsp;' + esc(fmtDateLong(cancelled.date)) + (cancelled.time ? ' | ' + esc(to12h(cancelled.time)) : '') + '</div>' +
          '<div class="row">📝&nbsp;<b>Reason:</b>&nbsp;' + esc(cancelled.reason || '—') + '</div>' +
        '</div></div>'
      : '';

    ovl.innerHTML =
      '<div class="f2fre-modal">' +
        '<div class="f2fre-head"><h3>Reschedule Interview with ' + esc(iv.name || '') + '</h3>' +
          '<button type="button" class="f2fre-x" id="f2fre-x">&times;</button></div>' +
        '<div class="f2fre-body">' +
          '<div class="f2fre-info">' +
            '<div><div class="f2fre-ilbl">👤 Candidate</div><div class="f2fre-ival">' + esc(iv.name || '') + '</div><div class="f2fre-isub">' + esc(iv.email || '') + '</div></div>' +
            '<div><div class="f2fre-ilbl">💼 Role</div><div class="f2fre-ival">' + esc(iv.role || 'Not specified') + '</div></div>' +
            '<div><div class="f2fre-ilbl">👥 Interview Type</div><div class="f2fre-ival">' + esc(interviewType) + '</div></div>' +
            '<div><div class="f2fre-ilbl">👤 Assigned By</div><div class="f2fre-ival">' + esc(assignedBy) + '</div></div>' +
          '</div>' +
          cancelledHtml +
          '<div class="f2fre-lbl">Reason for Change</div>' +
          '<select class="f2fre-select" id="f2fre-reason-top">' + RESCHED_REASONS.map(function (r) { return '<option' + (r === rs.reason ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select>' +
          (rs.reason === 'Other'
            ? '<input type="text" class="f2fre-select f2fre-other" id="f2fre-other-top" placeholder="Please specify the reason…" value="' + esc(rs.customReason) + '" maxlength="200">'
            : '') +
          '<div class="f2fre-cols">' +
            '<div class="f2fre-panel">' +
              '<h4>🕐 Select New Interview Time</h4>' +
              '<div class="f2fre-datepill">📅 ' + (rs.selectedDate ? esc(fmtDateLong(rs.selectedDate)) : 'Pick a date from the calendar') + '</div>' +
              '<div class="f2fre-slots">' + RESCHED_SLOTS.map(function (s) {
                return '<button type="button" class="f2fre-slot' + (rs.selectedTime === s ? ' on' : '') + '" data-slot="' + s + '"' + (rs.selectedDate ? '' : ' disabled') + '>' + to12h(s) + '</button>';
              }).join('') + '</div>' +
              (rs.added.length
                ? '<div class="f2fre-added">' + rs.added.map(function (a, i) {
                    return '<div class="f2fre-chip"><span>✓ ' + esc(fmtDateLong(a.date)) + ' · ' + esc(to12h(a.time)) + '</span><button type="button" data-rm="' + i + '">&times;</button></div>';
                  }).join('') + '</div>'
                : '') +
            '</div>' +
            '<div class="f2fre-panel">' +
              '<h4>📆 New Availability</h4>' +
              renderCalGrid() +
              '<div class="f2fre-legend">' +
                '<span><i class="f2fre-dot" style="background:#22c55e"></i>Selected Date</span>' +
                '<span><i class="f2fre-dot" style="background:#ef4444"></i>Previous Date</span>' +
                '<span><i class="f2fre-dot" style="background:var(--border2)"></i>Unavailable</span>' +
                '<span><i class="f2fre-dot" style="background:var(--bg2)"></i>Available</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="f2fre-foot">' +
            '<button type="button" class="f2fre-cancel" id="f2fre-cancel">Cancel</button>' +
            '<button type="button" class="f2fre-add" id="f2fre-add"' + (rs.selectedDate && rs.selectedTime ? '' : ' disabled') + '>Add</button>' +
            '<button type="button" class="f2fre-confirm" id="f2fre-confirm"' +
              (((rs.selectedDate && rs.selectedTime) || rs.added.length) && (rs.reason !== 'Other' || rs.customReason.trim()) ? '' : ' disabled') +
              '>' + (rs.saving ? 'Saving…' : 'Confirm Selection') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    wireReschedule(ovl);
  }

  function renderCalGrid() {
    var y = rs.year, m = rs.month;
    var first = new Date(y, m, 1), startDow = first.getDay();
    var days = new Date(y, m + 1, 0).getDate();
    var todayIso = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    var cancelled = getCancelledInfo(rs.iv.id);
    var dow = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    var monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var prevDisabled = (y < new Date().getFullYear()) || (y === new Date().getFullYear() && m <= new Date().getMonth());
    var html = '<div class="f2fre-calhd"><button type="button" id="f2fre-prevm"' + (prevDisabled ? ' disabled' : '') + '>‹</button>' +
      '<b style="font-size:12.5px">' + esc(monthLabel) + '</b>' +
      '<button type="button" id="f2fre-nextm">›</button></div>' +
      '<div class="f2fre-grid">' + dow.map(function (d) { return '<div class="f2fre-dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < startDow; i++) html += '<div class="f2fre-day off"></div>';
    for (var d = 1; d <= days; d++) {
      var iso = isoDate(y, m, d);
      var cls = 'f2fre-day';
      var label = String(d);
      if (iso < todayIso) cls += ' unavail';
      if (cancelled && cancelled.date === iso) { cls += ' cancelled'; label = 'CANCELLED'; }
      if (rs.selectedDate === iso) cls += ' selected';
      html += '<div class="' + cls + '" data-date="' + iso + '">' + label + '</div>';
    }
    html += '</div>';
    return html;
  }

  function wireReschedule(ovl) {
    var byId = function (id) { return ovl.querySelector('#' + id); };
    var xBtn = byId('f2fre-x'); if (xBtn) xBtn.onclick = closeReschedule;
    var cancelBtn = byId('f2fre-cancel'); if (cancelBtn) cancelBtn.onclick = closeReschedule;
    var reasonSel = byId('f2fre-reason-top');
    if (reasonSel) reasonSel.onchange = function () {
      rs.reason = reasonSel.value;
      renderReschedule();          // show/hide the "specify reason" box
      var input = document.getElementById('f2fre-other-top');
      if (input) input.focus();
    };
    var otherInput = byId('f2fre-other-top');
    if (otherInput) otherInput.oninput = function () {
      rs.customReason = otherInput.value;
      // Toggle in place rather than a full re-render, which would rebuild
      // the input and drop focus/cursor position mid-keystroke.
      var btn = byId('f2fre-confirm');
      if (btn) btn.disabled = !((rs.selectedDate && rs.selectedTime) || rs.added.length) || !rs.customReason.trim();
    };

    ovl.querySelectorAll('.f2fre-day:not(.off):not(.unavail)').forEach(function (el) {
      el.addEventListener('click', function () {
        rs.selectedDate = el.getAttribute('data-date');
        rs.selectedTime = '';
        renderReschedule();
      });
    });
    var prevM = byId('f2fre-prevm');
    if (prevM) prevM.onclick = function () { rs.month--; if (rs.month < 0) { rs.month = 11; rs.year--; } renderReschedule(); };
    var nextM = byId('f2fre-nextm');
    if (nextM) nextM.onclick = function () { rs.month++; if (rs.month > 11) { rs.month = 0; rs.year++; } renderReschedule(); };

    ovl.querySelectorAll('.f2fre-slot').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!rs.selectedDate) return;
        rs.selectedTime = b.getAttribute('data-slot');
        renderReschedule();
      });
    });

    ovl.querySelectorAll('[data-rm]').forEach(function (b) {
      b.addEventListener('click', function () {
        rs.added.splice(Number(b.getAttribute('data-rm')), 1);
        renderReschedule();
      });
    });

    var addBtn = byId('f2fre-add');
    if (addBtn) addBtn.onclick = function () {
      if (!rs.selectedDate || !rs.selectedTime) return;
      var exists = rs.added.some(function (a) { return a.date === rs.selectedDate && a.time === rs.selectedTime; });
      if (!exists) rs.added.push({ date: rs.selectedDate, time: rs.selectedTime });
      renderReschedule();
    };

    var confirmBtn = byId('f2fre-confirm');
    if (confirmBtn) confirmBtn.onclick = function () { confirmReschedule(); };
  }

  function confirmReschedule() {
    if (!rs || rs.saving) return;
    if (rs.reason === 'Other' && !rs.customReason.trim()) return;   // matches the disabled button
    var pick = rs.added.length ? rs.added[rs.added.length - 1] : (rs.selectedDate && rs.selectedTime ? { date: rs.selectedDate, time: rs.selectedTime } : null);
    if (!pick) return;
    var iv = rs.iv;
    var reason = effectiveReason();
    rs.saving = true;
    renderReschedule();

    var prevInfo = {
      date: iv.interviewDate || '', time: iv.time || '', reason: reason,
      by: (function () { try { return JSON.parse(localStorage.getItem('hrms_session') || '{}').name || ''; } catch (_) { return ''; } })(),
      at: new Date().toISOString()
    };

    api('/api/interviews/' + iv.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interviewDate: pick.date, time: pick.time, notes: (iv.notes ? iv.notes + '\n' : '') + 'Rescheduled from ' + (prevInfo.date || 'unscheduled') + ' ' + (prevInfo.time || '') + ' — ' + reason })
    }).then(function (updated) {
      if (prevInfo.date) setCancelledInfo(iv.id, prevInfo);
      // Patch our own cache in place so the panel reflects it immediately,
      // without waiting on the next /api/interviews poll.
      var rec = findByEmail(iv.email);
      if (rec) {
        rec.interviewDate = (updated && updated.interviewDate) || pick.date;
        rec.time = (updated && updated.time) || pick.time;
      }
      closeReschedule();
      panel_forceRerender();
    }).catch(function (err) {
      rs.saving = false;
      renderReschedule();
      alert('Could not reschedule: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  // The normal data-key cache (see render()) would otherwise skip rebuilding
  // since the candidate/email hasn't changed — force one pass through.
  function panel_forceRerender() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.removeAttribute('data-key');
    render();
  }

  /* ---- boot ---- */
  function tick() {
    if (!onPage()) return;
    var c = candidateCard(), s = shareCard();
    if (c || s) { if (!loaded && !loading) load(false); hideFollowupNote(); render(); }
  }

  function start() {
    document.addEventListener('click', onDocClick, true);
    tick();
    // setTimeout rather than requestAnimationFrame: rAF is paused in a
    // background tab, which would leave the panel unmounted until the user
    // came back and something else re-rendered.
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      setTimeout(function () { scheduled = false; tick(); }, 0);
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { state.email = ''; loaded = false; });
    window.addEventListener('hrmsNavigate', function () { state.email = ''; loaded = false; });
    window.addEventListener('resize', relayout);
  }

  window.HRMSF2FCandidateInfo = {
    state: state,
    data: function () { return DATA; },
    loaded: function () { return loaded; },
    select: function (email, name) { state.email = String(email || '').toLowerCase(); state.name = name || ''; render(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
