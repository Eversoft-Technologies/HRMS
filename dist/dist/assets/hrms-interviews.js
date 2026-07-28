/*
 * hrms-interviews.js
 * ---------------------------------------------------------------------------
 * Enhances the Interview dashboard (/recruit/interview) of the pre-built
 * (minified) React app via the repo's no-rebuild injection pattern:
 *
 *   • "Upcoming Interviews" and "Recently Completed" cards get job-board-style
 *     filters (search + status/outcome), pagination and a scrollable list.
 *     We render our own list from /api/interviews and hide the app's rows.
 *   • A note (pencil) button is added to every "Recently Completed" row AND to
 *     every "Candidate Follow-up Status" row. Clicking it opens a note editor
 *     that persists to the candidate's interview via PATCH /api/interviews/:id
 *     (the same `notes` field the app's own note modal uses).
 *
 * All our own DOM, kept mounted by a MutationObserver so it survives React
 * re-renders. Identity + auth headers are attached by hrms-actor.js.
 */
(function () {
  'use strict';

  var IV_PATH = '/recruit/interview';
  var PAGE = 6;
  var STYLE_ID = 'hrms-iv-style';

  var DATA = [];            // /api/interviews cache
  var loaded = false, loading = false;
  var state = {
    up:   { q: '', status: 'All', page: 0 },
    done: { q: '', outcome: 'All', page: 0 }
  };

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function onPage() { return location.pathname.replace(/\/+$/, '').indexOf(IV_PATH) === 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) throw new Error((d && (d.error || d.detail || d.message)) || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function session() { try { return JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}; } catch (_) { return {}; } }
  function actorEmail() { return session().email || ''; }
  function actorName() { var s = session(); return s.name || s.fullName || ''; }
  function initialsOf(iv) {
    if (iv.initials) return iv.initials;
    var parts = String(iv.name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
  }
  function findById(id) { for (var i = 0; i < DATA.length; i++) if (DATA[i].id === id) return DATA[i]; return null; }
  function findByName(name) {
    var n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    for (var i = 0; i < DATA.length; i++) if (String(DATA[i].name || '').trim().toLowerCase() === n) return DATA[i];
    return null;
  }

  /* ── icons ────────────────────────────────────────────────────────────── */
  var PENCIL =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      // ── Email Preview as a full-height right drawer ──────────────────────
      // !important throughout: React sets these as inline styles on every
      // render, and inline styles otherwise win over a stylesheet.
      // Right-hand drawer, full viewport height.
      // ── Email Preview — centred modal (matches the design mockup) ─────────
      // The overlay centres its single child; we restore the default flex
      // behaviour React uses so the modal floats in the middle of the screen.
      '.hrms-eml-ovl{align-items:center!important;justify-content:center!important;padding:20px!important;}',
      // The modal itself: fixed width, rounded, scrollable, no drawer side-effects.
      '.hrms-eml-drawer{width:min(680px,96vw)!important;max-width:96vw!important;height:auto!important;',
      '  max-height:92vh!important;border-radius:18px!important;margin:auto!important;',
      '  display:flex!important;flex-direction:column!important;overflow:hidden!important;padding:0!important;',
      '  box-shadow:0 24px 80px rgba(0,0,0,.45)!important;animation:hrms-eml-in .22s cubic-bezier(.2,.8,.3,1);}',
      '@keyframes hrms-eml-in{from{transform:translateY(18px) scale(.97);opacity:.3}to{transform:none;opacity:1}}',
      // Scrollable body — the editor and preview sit inside this
      '.hrms-eml-body{flex:1 1 auto!important;min-height:0!important;display:flex!important;',
      '  flex-direction:column!important;overflow-y:auto!important;padding:0 18px 14px;}',
      '.hrms-eml-editcard{flex:1 1 auto!important;min-height:260px;display:flex!important;',
      '  flex-direction:column!important;}',
      '.hrms-eml-editcard .hrms-ed-area,.hrms-eml-editcard .hrms-ed-src{flex:1 1 auto!important;',
      '  min-height:260px!important;max-height:none!important;height:auto!important;}',
      '.hrms-eml-drawer .hrms-eml-card{margin:0 0 12px;}',
      '.hrms-eml-editcard{margin:0!important;}',
      '.hrms-eml-drawer .hrms-ed-area{flex:1 1 auto;max-height:none!important;}',
      // ── header: icon tile · title · outcome pill · subtitle · close ───────
      '.hrms-eml-head{flex:none;display:flex;align-items:flex-start;gap:13px;',
      '  padding:18px 20px 16px!important;border-bottom:1px solid var(--border2);margin:0!important;',
      '  background:var(--bg2);}',
      '.hrms-eml-icon{flex:none;width:42px;height:42px;border-radius:12px;display:flex;align-items:center;',
      '  justify-content:center;background:rgba(139,92,246,.15);color:#8b5cf6;}',
      '.hrms-eml-htext{flex:1;min-width:0;}',
      '.hrms-eml-h1{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:800;',
      '  letter-spacing:-.01em;color:var(--text);line-height:1.2;}',
      '.hrms-eml-pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.02em;',
      '  white-space:nowrap;}',
      '.hrms-eml-pill.selected{background:rgba(34,211,165,.15);color:#10b981;border:1px solid rgba(34,211,165,.3);}',
      '.hrms-eml-pill.waitlisted{background:rgba(251,146,60,.12);color:#f97316;border:1px solid rgba(251,146,60,.3);}',
      '.hrms-eml-pill.rejected{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3);}',
      '.hrms-eml-sub{font-size:12px;color:var(--text3);margin-top:4px;font-weight:400;}',
      // ── field cards ─────────────────────────────────────────────────────
      '.hrms-eml-card{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;',
      '  padding:11px 14px;margin:0 0 12px;}',
      '.hrms-eml-label{font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;',
      '  color:var(--text3);margin-bottom:6px;}',
      '.hrms-eml-to{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.hrms-eml-chip{display:inline-flex;align-items:center;gap:8px;background:var(--bg2);',
      '  border:1px solid var(--border2);border-radius:8px;padding:6px 10px;font-size:13px;',
      '  font-weight:500;color:var(--text);}',
      '.hrms-eml-chip button{background:none;border:none;color:var(--text3);cursor:pointer;padding:0;',
      '  display:flex;align-items:center;border-radius:4px;transition:.13s;line-height:1;}',
      '.hrms-eml-chip button:hover{color:#ef4444;}',
      '.hrms-eml-count{font-size:11.5px;color:var(--text3);font-weight:500;}',
      '.hrms-eml-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}',
      // ── editor card ─────────────────────────────────────────────────────
      '.hrms-eml-editcard{padding:0!important;overflow:hidden;margin-bottom:0;',
      '  border:1px solid var(--border2);border-radius:12px;}',
      '.hrms-eml-editcard .hrms-eml-modes{padding:0 8px;background:var(--bg2);}',
      '.hrms-eml-editcard .hrms-ed-tb{border:none!important;border-bottom:1px solid var(--border2)!important;',
      '  border-radius:0!important;background:var(--bg3)!important;}',
      '.hrms-eml-editcard .hrms-ed-area,.hrms-eml-editcard .hrms-ed-src{border:none!important;',
      '  border-radius:0!important;background:#fff!important;color:#1a1a2e!important;}',
      // The email body area should look like a real email canvas
      '.hrms-eml-editcard .hrms-ed-area{padding:20px!important;font-family:Georgia,serif!important;',
      '  font-size:14px!important;line-height:1.7!important;background:linear-gradient(135deg,#f0f2ff,#f7f0ff)!important;}',
      '.hrms-eml-subject{width:100%;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border2);',
      '  border-radius:9px;padding:10px 13px;color:var(--text);font-size:13.5px;font-weight:600;outline:none;',
      '  transition:border-color .15s,box-shadow .15s;}',
      '.hrms-eml-subject:focus{border-color:var(--accent,#4f8ef7);box-shadow:0 0 0 3px rgba(79,142,247,.12);}',
      // ── template row ─────────────────────────────────────────────────────
      '.hrms-eml-tpl{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:12px;}',
      '.hrms-eml-tpl select{flex:1 1 180px;min-width:0;background:var(--bg2);border:1px solid var(--border2);',
      '  border-radius:9px;padding:9px 11px;color:var(--text);font-size:13px;font-weight:500;outline:none;cursor:pointer;}',
      '.hrms-eml-tpl select:focus{border-color:var(--accent,#4f8ef7);}',
      '.hrms-eml-tpl button{display:inline-flex;align-items:center;gap:5px;background:var(--bg2);',
      '  border:1px solid var(--border2);border-radius:9px;padding:8px 12px;color:var(--text2,var(--text));',
      '  font-size:12px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap;}',
      '.hrms-eml-tpl button:hover{border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7);}',
      '.hrms-eml-tpl button.danger{color:#ef4444;background:rgba(239,68,68,.07);border-color:rgba(239,68,68,.25);}',
      '.hrms-eml-tpl button.danger:hover{background:rgba(239,68,68,.13);border-color:#ef4444;color:#ef4444;}',
      // ── tab bar ─────────────────────────────────────────────────────────
      '.hrms-eml-modes{display:flex;align-items:center;gap:4px;margin-bottom:0;',
      '  border-bottom:1px solid var(--border2);background:var(--bg2);padding:0 6px;}',
      '.hrms-eml-seg{display:inline-flex;gap:0;}',
      '.hrms-eml-seg button{display:inline-flex;align-items:center;gap:6px;background:none;border:none;',
      '  border-bottom:2.5px solid transparent;border-radius:0;padding:11px 16px;color:var(--text3);',
      '  font-size:13px;font-weight:600;cursor:pointer;transition:.15s;margin-bottom:-1px;}',
      '.hrms-eml-seg button:hover{color:var(--text);}',
      '.hrms-eml-seg button.on{color:var(--accent,#4f8ef7);border-bottom-color:var(--accent,#4f8ef7);',
      '  font-weight:700;}',
      '.hrms-eml-modes button.alt{margin-left:auto;display:inline-flex;align-items:center;gap:6px;',
      '  align-self:center;background:none;border:1px solid var(--border2);border-radius:8px;',
      '  padding:6px 11px;color:var(--text2,var(--text));font-size:12px;font-weight:600;cursor:pointer;',
      '  transition:.15s;margin-right:4px;}',
      '.hrms-eml-modes button.alt:hover{color:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);}',
      '.hrms-eml-standalone{font-size:11px;color:var(--warning,#d97706);font-weight:600;}',
      '.hrms-eml-preview{flex:1 1 auto;width:100%;min-height:260px;border:none;background:#f1f5f9;}',
      // ── hint bar ────────────────────────────────────────────────────────
      '.hrms-eml-hint{flex:none;display:flex;align-items:center;gap:8px;font-size:11.5px;line-height:1.4;',
      '  color:var(--text2);margin:12px 0 0;padding:10px 14px;',
      '  background:rgba(59,130,246,.06);',
      '  border:1px solid rgba(59,130,246,.18);border-radius:10px;}',
      '.hrms-eml-hint svg{flex:none;color:#3b82f6;opacity:.85;}',
      '.hrms-eml-hint code{background:var(--bg2);border-radius:4px;padding:1px 5px;font-size:11px;}',
      // ── footer: React renders these buttons; restyle them in place ───────
      '.hrms-eml-drawer .hrms-eml-foot{flex:none!important;display:flex!important;gap:10px!important;',
      '  padding:14px 20px!important;align-items:center!important;',
      '  border-top:1px solid var(--border2)!important;margin:0!important;background:var(--bg2);}',
      '.hrms-eml-drawer .hrms-eml-foot button{border-radius:12px!important;font-size:13.5px!important;',
      '  font-weight:700!important;display:inline-flex!important;align-items:center!important;',
      '  justify-content:center!important;gap:8px!important;transition:.16s!important;}',
      '.hrms-eml-drawer .hrms-eml-foot button.btn-primary{flex:1!important;padding:13px 20px!important;',
      '  background:linear-gradient(135deg,#3b82f6,#4f46e5)!important;',
      '  box-shadow:0 4px 18px rgba(59,130,246,.35)!important;border:none!important;',
      '  border-radius:14px!important;color:#fff!important;}',
      '.hrms-eml-drawer .hrms-eml-foot button.btn-primary:hover:not(:disabled){transform:translateY(-1px)!important;',
      '  box-shadow:0 6px 22px rgba(59,130,246,.45)!important;}',
      '.hrms-eml-drawer .hrms-eml-foot button:not(.btn-primary){padding:13px 24px!important;',
      '  background:var(--bg3)!important;border:1px solid var(--border2)!important;',
      '  border-radius:12px!important;color:var(--text2)!important;}',
      '.hrms-eml-drawer .hrms-eml-foot button:not(.btn-primary):hover{border-color:var(--text3)!important;',
      '  color:var(--text)!important;}',
      // Keep Live Interview button visible (no drawer overlap in centered layout)
      'body:has(.hrms-eml-drawer) #hrms-live-btn{opacity:1!important;pointer-events:auto!important;}',
      // Light theme adjustments for the email canvas
      'html[data-theme="light"] .hrms-eml-editcard .hrms-ed-area{background:#fff!important;',
      '  background:linear-gradient(135deg,#f5f7ff,#faf5ff)!important;}',
      'html[data-theme="light"] .hrms-eml-drawer{background:#f4f5f7!important;}',
      'html[data-theme="light"] .hrms-eml-head{background:#ffffff!important;}',
      'html[data-theme="light"] .hrms-eml-card{background:#ffffff!important;',
      '  border-color:#e5e7eb!important;}',
      'html[data-theme="light"] .hrms-eml-chip{background:#f9fafb!important;border-color:#e5e7eb!important;}',
      'html[data-theme="light"] .hrms-eml-subject{background:#ffffff!important;border-color:#d1d5db!important;}',
      'html[data-theme="light"] .hrms-eml-editcard{border-color:#e5e7eb!important;}',
      'html[data-theme="light"] .hrms-eml-modes{background:#f9fafb!important;}',
      'html[data-theme="light"] .hrms-eml-foot{background:#ffffff!important;}',
      'html[data-theme="light"] .hrms-eml-hint{background:rgba(59,130,246,.05)!important;',
      '  border-color:rgba(59,130,246,.18)!important;color:#374151!important;}',
      '.hrms-iv-body{margin-top:4px;}',
      '.hrms-iv-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}',
      '.hrms-iv-toolbar input,.hrms-iv-toolbar select{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-size:12px;outline:none;}',
      '.hrms-iv-toolbar input{flex:1 1 140px;min-width:0;}',
      '.hrms-iv-toolbar input:focus,.hrms-iv-toolbar select:focus{border-color:var(--accent);}',
      '.hrms-iv-scroll{max-height:300px;overflow-y:auto;}',
      '.hrms-iv-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border2);}',
      '.hrms-iv-row:last-child{border-bottom:none;}',
      '.hrms-iv-av{flex-shrink:0;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11.8px;font-weight:600;color:#fff;}',
      '.hrms-iv-main{flex:1;min-width:0;}',
      '.hrms-iv-nm{font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hrms-iv-sub{font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hrms-iv-right{text-align:right;flex-shrink:0;}',
      '.hrms-iv-when{font-size:11px;font-weight:600;color:var(--accent);}',
      '.hrms-iv-when2{font-size:10px;color:var(--text3);}',
      '.hrms-iv-note{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid var(--border2);background:var(--bg3);color:var(--text3);cursor:pointer;padding:0;}',
      '.hrms-iv-note:hover{border-color:var(--accent);color:var(--accent);}',
      '.hrms-iv-note.has-note{color:var(--accent);border-color:var(--accent);}',
      '.hrms-iv-fu-note{margin-left:6px;}',
      '.hrms-iv-empty{font-size:12px;color:var(--text3);padding:12px 0;text-align:center;}',
      '.hrms-iv-pager{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px;font-size:11.5px;color:var(--text3);}',
      '.hrms-iv-pager button{background:var(--bg3);border:1px solid var(--border2);border-radius:7px;color:var(--text);font-size:12px;padding:4px 10px;cursor:pointer;}',
      '.hrms-iv-pager button:disabled{opacity:.45;cursor:not-allowed;}',
      /* note modal */
      '.hrms-iv-ovl{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;}',
      '.hrms-iv-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:14px;padding:20px;width:min(460px,94vw);box-shadow:0 20px 60px rgba(0,0,0,.45);}',
      '.hrms-iv-modal h3{margin:0 0 4px;font-size:15px;color:var(--text);}',
      '.hrms-iv-modal .hrms-iv-msub{font-size:12px;color:var(--text3);margin-bottom:12px;}',
      '.hrms-iv-modal textarea{width:100%;box-sizing:border-box;min-height:120px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px;color:var(--text);font:inherit;font-size:13px;resize:vertical;outline:none;}',
      '.hrms-iv-modal textarea:focus{border-color:var(--accent);}',
      '.hrms-iv-lastedit{font-size:11px;color:var(--text3);margin-top:8px;}',
      '.hrms-iv-lastedit strong{color:var(--text2,var(--text));font-weight:600;}',
      '.hrms-iv-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}',
      '.hrms-iv-acts button{padding:8px 16px;font-size:12px;font-weight:600;border-radius:7px;cursor:pointer;}',
      '.hrms-iv-cancel{background:transparent;border:1px solid var(--border2);color:var(--text3);}',
      '.hrms-iv-save{background:var(--accent);border:none;color:#fff;}',
      '.hrms-iv-save:disabled{opacity:.6;cursor:not-allowed;}'
    ].join('');
    var st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function load(force) {
    if (loading || (loaded && !force)) return;
    loading = true;
    api('/api/interviews')
      .then(function (rows) { DATA = Array.isArray(rows) ? rows : []; loaded = true; })
      .catch(function () {})
      .then(function () { loading = false; renderAll(); });
  }

  /* ── locate a card by its title ───────────────────────────────────────── */
  function cardByTitle(title) {
    var titles = document.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || '').trim() === title) {
        return titles[i].closest('.card') || titles[i].parentNode;
      }
    }
    return null;
  }

  /* ── list filtering ───────────────────────────────────────────────────── */
  function itemsFor(kind) {
    var st = state[kind];
    var rows = (kind === 'up')
      ? DATA.filter(function (x) { var s = String(x.status || ''); return s === 'Scheduled' || s === 'Pending'; })
      : DATA.filter(function (x) { return String(x.status || '') === 'Completed'; });
    var q = st.q.trim().toLowerCase();
    if (q) rows = rows.filter(function (x) {
      return (String(x.name || '') + ' ' + String(x.role || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (kind === 'up' && st.status !== 'All') rows = rows.filter(function (x) { return String(x.status || '') === st.status; });
    if (kind === 'done' && st.outcome !== 'All') rows = rows.filter(function (x) { return (String(x.outcome || '') || 'Pending') === st.outcome; });
    return rows;
  }

  function badgeClass(outcome) {
    return outcome === 'Selected' ? 'green'
      : outcome === 'Rejected' ? 'red'
      : (outcome === 'Waitlisted' || outcome === 'On Hold') ? 'orange' : 'blue';
  }

  function rowHtml(kind, iv) {
    var grad = kind === 'up' ? '135deg, var(--accent2), var(--accent)' : '135deg, var(--accent), var(--accent3)';
    var av = '<span class="hrms-iv-av" style="background:linear-gradient(' + grad + ')">' + esc(initialsOf(iv)) + '</span>';
    if (kind === 'up') {
      var right = iv.interviewDate
        ? '<div class="hrms-iv-when">' + esc(iv.interviewDate) + '</div><div class="hrms-iv-when2">' + esc(iv.time || '') + (iv.platform ? ' · ' + esc(iv.platform) : '') + '</div>'
        : '<span class="hrms-iv-when2">Not scheduled</span>';
      return '<div class="hrms-iv-row">' + av +
        '<div class="hrms-iv-main"><div class="hrms-iv-nm">' + esc(iv.name || '') + '</div>' +
        '<div class="hrms-iv-sub">' + esc(iv.role || '') + '</div></div>' +
        '<div class="hrms-iv-right">' + right + '</div></div>';
    }
    var outcome = iv.outcome || 'Pending';
    var noteCls = 'hrms-iv-note' + (iv.notes ? ' has-note' : '');
    return '<div class="hrms-iv-row">' + av +
      '<div class="hrms-iv-main"><div class="hrms-iv-nm">' + esc(iv.name || '') + '</div>' +
      '<div class="hrms-iv-sub">' + esc(iv.role || '') + (iv.interviewDate ? ' · ' + esc(iv.interviewDate) : '') + '</div></div>' +
      '<span class="badge ' + badgeClass(iv.outcome) + '">' + esc(outcome) + '</span>' +
      '<button class="' + noteCls + '" type="button" data-note="' + iv.id + '" title="' + (iv.notes ? 'Edit note' : 'Add note') + '">' + PENCIL + '</button>' +
      '</div>';
  }

  function toolbarHtml(kind) {
    var st = state[kind];
    var sel;
    if (kind === 'up') {
      sel = ['All', 'Scheduled', 'Pending'].map(function (o) {
        return '<option value="' + o + '"' + (o === st.status ? ' selected' : '') + '>' + (o === 'All' ? 'All Status' : o) + '</option>';
      }).join('');
    } else {
      sel = ['All', 'Selected', 'Rejected', 'Waitlisted', 'On Hold', 'Pending'].map(function (o) {
        return '<option value="' + o + '"' + (o === st.outcome ? ' selected' : '') + '>' + (o === 'All' ? 'All Outcomes' : o) + '</option>';
      }).join('');
    }
    return '<div class="hrms-iv-toolbar">' +
      '<input type="text" class="hrms-iv-q" placeholder="Search name or role…" value="' + esc(st.q) + '">' +
      '<select class="hrms-iv-sel">' + sel + '</select></div>';
  }

  /* Builds the card shell once (toolbar + list container + pager). */
  function renderShell(body, kind) {
    body.innerHTML = toolbarHtml(kind) + '<div class="hrms-iv-scroll"></div>' + '<div class="hrms-iv-pagerwrap"></div>';
    var q = body.querySelector('.hrms-iv-q');
    var sel = body.querySelector('.hrms-iv-sel');
    q.addEventListener('input', function () { state[kind].q = q.value; state[kind].page = 0; renderList(kind); });
    sel.addEventListener('change', function () {
      if (kind === 'up') state[kind].status = sel.value; else state[kind].outcome = sel.value;
      state[kind].page = 0; renderList(kind);
    });
    renderList(kind);
  }

  /* Re-renders only the list + pager (keeps the toolbar/input focused). */
  function renderList(kind) {
    var body = document.getElementById('hrms-iv-' + kind);
    if (!body) return;
    var scroll = body.querySelector('.hrms-iv-scroll');
    var pager = body.querySelector('.hrms-iv-pagerwrap');
    if (!scroll || !pager) return;
    var st = state[kind];
    var rows = itemsFor(kind);
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / PAGE));
    if (st.page >= pages) st.page = pages - 1;
    if (st.page < 0) st.page = 0;
    var pageItems = rows.slice(st.page * PAGE, st.page * PAGE + PAGE);

    scroll.innerHTML = pageItems.length
      ? pageItems.map(function (iv) { return rowHtml(kind, iv); }).join('')
      : '<div class="hrms-iv-empty">' + (loaded ? 'No matching interviews.' : 'Loading…') + '</div>';

    pager.innerHTML = total > PAGE
      ? '<div class="hrms-iv-pager"><button type="button" class="hrms-iv-prev"' + (st.page <= 0 ? ' disabled' : '') + '>‹ Prev</button>' +
        '<span>Page ' + (st.page + 1) + ' of ' + pages + ' · ' + total + '</span>' +
        '<button type="button" class="hrms-iv-next"' + (st.page >= pages - 1 ? ' disabled' : '') + '>Next ›</button></div>'
      : '';

    // wire pager
    var prev = pager.querySelector('.hrms-iv-prev'), next = pager.querySelector('.hrms-iv-next');
    if (prev) prev.addEventListener('click', function () { st.page--; renderList(kind); });
    if (next) next.addEventListener('click', function () { st.page++; renderList(kind); });

    // wire note pencils
    scroll.querySelectorAll('[data-note]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        var iv = findById(Number(b.getAttribute('data-note')));
        if (iv) openNote(iv);
      });
    });
  }

  /* Hides the app's own rows and mounts our list into the card. */
  function ensureReplaced(card, kind) {
    var id = 'hrms-iv-' + kind;
    var body = document.getElementById(id);
    if (!body || body.parentElement !== card) {
      body = document.createElement('div');
      body.id = id; body.className = 'hrms-iv-body';
      card.appendChild(body);
      renderShell(body, kind);
    }
    // hide React's own rows / empty message (everything but title + our body)
    Array.prototype.forEach.call(card.children, function (ch) {
      if (ch === body) return;
      if (ch.classList && ch.classList.contains('card-title')) return;
      ch.style.display = 'none';
    });
  }

  /* ── Candidate Follow-up Status: add a note pencil to each row ─────────── */
  function enhanceFollowup() {
    var card = cardByTitle('Candidate Follow-up Status');
    if (!card) return;
    var avs = card.querySelectorAll('.av');
    Array.prototype.forEach.call(avs, function (av) {
      var row = av.parentElement;
      if (!row) return;
      var main = row.children[1];
      var name = main && main.children[0] ? (main.children[0].textContent || '').trim() : '';
      if (!name) return;
      var iv = findByName(name);
      var btn = row.querySelector('.hrms-iv-fu-note');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hrms-iv-note hrms-iv-fu-note';
        btn.innerHTML = PENCIL;
        btn.addEventListener('click', function (e) {
          e.stopPropagation(); e.preventDefault();
          var cur = findByName(name);
          if (cur) openNote(cur);
          else if (!loaded) load(true);
        });
        row.appendChild(btn);
      }
      var has = !!(iv && iv.notes);
      btn.classList.toggle('has-note', has);
      btn.title = has ? 'Edit note' : 'Add note';
    });
  }

  /* ── note editor modal ────────────────────────────────────────────────── */
  function closeNote() {
    var o = document.getElementById('hrms-iv-ovl');
    if (o && o.parentNode) o.parentNode.removeChild(o);
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') closeNote(); }

  function lastEditedHtml(iv) {
    if (!iv.notesUpdatedBy && !iv.notesUpdatedAt) return '';
    var who = esc(iv.notesUpdatedBy || 'Someone');
    var when = iv.notesUpdatedAt ? ' · ' + esc(iv.notesUpdatedAt) : '';
    return '<div class="hrms-iv-lastedit" id="hrms-iv-lastedit">Last modified by <strong>' + who + '</strong>' + when + '</div>';
  }

  function openNote(iv) {
    closeNote();
    ensureStyle();
    var ovl = document.createElement('div');
    ovl.className = 'hrms-iv-ovl'; ovl.id = 'hrms-iv-ovl';
    ovl.innerHTML =
      '<div class="hrms-iv-modal">' +
        '<h3>Candidate Note</h3>' +
        '<div class="hrms-iv-msub">' + esc(iv.name || '') + (iv.role ? ' · ' + esc(iv.role) : '') + '</div>' +
        '<textarea id="hrms-iv-note-txt" placeholder="Add a note about this candidate…"></textarea>' +
        lastEditedHtml(iv) +
        '<div class="hrms-iv-acts">' +
          '<button type="button" class="hrms-iv-cancel">Cancel</button>' +
          '<button type="button" class="hrms-iv-save">Save Note</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ovl);

    var txt = ovl.querySelector('#hrms-iv-note-txt');
    txt.value = iv.notes || '';
    txt.focus();

    ovl.addEventListener('click', function (e) { if (e.target === ovl) closeNote(); });
    ovl.querySelector('.hrms-iv-cancel').addEventListener('click', closeNote);
    document.addEventListener('keydown', onEsc);

    var saveBtn = ovl.querySelector('.hrms-iv-save');
    saveBtn.addEventListener('click', function () {
      var val = txt.value;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      // Open endpoint (any user may edit); it stamps the last-modified user.
      api('/api/interviews/' + iv.id + '/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: val, email: actorEmail(), name: actorName() })
      })
        .then(function (updated) {
          var rec = findById(iv.id);
          if (rec && updated && typeof updated === 'object') {
            rec.notes = updated.notes;
            rec.notesUpdatedBy = updated.notesUpdatedBy;
            rec.notesUpdatedByEmail = updated.notesUpdatedByEmail;
            rec.notesUpdatedAt = updated.notesUpdatedAt;
          } else if (rec) {
            rec.notes = val;
          }
          closeNote();
          renderAll();
        })
        .catch(function (err) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save Note';
          alert((err && err.message) || 'Could not save the note.');
        });
    });
  }

  /* ── render everything currently on screen ────────────────────────────── */
  function renderAll() {
    if (document.getElementById('hrms-iv-up')) renderList('up');
    if (document.getElementById('hrms-iv-done')) renderList('done');
    enhanceFollowup();
  }

  /* ── Follow-up "Email Preview": make the body a rich-text editor ────────
   * The modal is rendered by the minified React bundle, so we enhance it in
   * place: swap its read-only <pre> for a contenteditable editor and take over
   * the Send button, posting the edited HTML to /api/interviews/send-followup
   * (which already wraps an HTML body in the branded template).
   * ---------------------------------------------------------------------- */
  // Anchor on the <pre> that holds the body and walk up to the modal. Matching
  // on the heading text is unreliable — it reads "📧 Email Preview — Rejected",
  // so it neither starts with nor equals "Email Preview".
  function findEmailPreview() {
    var pres = document.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var node = pres[i].parentNode;
      for (var depth = 0; depth < 6 && node && node !== document.body; depth++) {
        if ((node.textContent || '').indexOf('Email Preview') !== -1 &&
            node.querySelector('button')) {
          return { modal: node, pre: pres[i] };
        }
        node = node.parentNode;
      }
    }
    return null;
  }

  // "📧 Email Preview — Rejected" -> "Rejected".
  // Only leaf elements: the heading's wrapper also contains the ✕ button, so
  // matching it would yield "Rejected ✕".
  function previewOutcome(modal) {
    var all = modal.querySelectorAll('div, h1, h2, h3, span');
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length) continue;
      var t = (all[i].textContent || '').trim();
      if (t.indexOf('Email Preview') !== -1 && t.indexOf('—') !== -1) {
        return t.split('—').pop().trim();
      }
    }
    return '';
  }

  // The <span> holding a labelled value ("TO: " / "SUBJECT: " sits in the
  // previous sibling).
  function labelledSpan(modal, label) {
    var spans = modal.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      if ((spans[i].textContent || '').trim() === label) return spans[i].nextElementSibling;
    }
    return null;
  }

  function labelledValue(modal, label) {
    var el = labelledSpan(modal, label);
    return el ? (el.textContent || '').trim() : '';
  }

  var ICON = {
    mail: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    save: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
    info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>',
    x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  function fieldLabel(text) {
    var d = document.createElement('div');
    d.className = 'hrms-eml-label';
    d.textContent = text;
    return d;
  }

  // Initials for the recipient chip, from a name OR a bare email address.
  // Distinct from initialsOf() above, which takes an interview row.
  function chipInitials(s) {
    var parts = String(s || '').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  // Replace React's "📧 Email Preview — Rejected" heading with an icon tile,
  // a title, a colour-coded outcome pill and a one-line explainer.
  function dressHeader(modal, outcome) {
    var head = null, all = modal.querySelectorAll('div');
    for (var i = 0; i < all.length; i++) {
      if (!all[i].children.length && (all[i].textContent || '').indexOf('Email Preview') !== -1) {
        head = all[i]; break;
      }
    }
    if (!head || !head.parentNode) return;
    var bar = head.parentNode;                 // holds the heading and the ✕
    bar.classList.add('hrms-eml-head');
    var tone = String(outcome || '').toLowerCase();
    head.outerHTML =
      '<span class="hrms-eml-icon">' + ICON.mail + '</span>' +
      '<span class="hrms-eml-htext">' +
        '<span class="hrms-eml-h1">Email Preview' + (outcome ? ' — ' + esc(outcome) : '') +
          (outcome ? '<span class="hrms-eml-pill ' + esc(tone) + '">' + esc(outcome) + '</span>' : '') +
        '</span>' +
        '<span class="hrms-eml-sub">Review and customize your email before sending.</span>' +
      '</span>';
  }

  function byEmail(email) {
    var e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    for (var i = 0; i < DATA.length; i++) {
      if (String(DATA[i].email || '').trim().toLowerCase() === e) return DATA[i];
    }
    return null;
  }

  /* ── template picker + manager inside the drawer ───────────────────────── */
  function buildTemplateBar(bar, ed, subjInput, outcome, iv) {
    var sel = document.createElement('select');
    sel.innerHTML = '<option value="">— Select Template —</option>';
    bar.appendChild(sel);

    function mkBtn(label, title, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.innerHTML = label; b.title = title;   // label carries an inline SVG
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    }

    var templates = [];
    function current() {
      for (var i = 0; i < templates.length; i++) {
        if (String(templates[i].id) === sel.value) return templates[i];
      }
      return null;
    }

    // Placeholders are rendered server-side for this candidate, so the drawer
    // shows ready-to-send text rather than {{name}}.
    function query() {
      return '?outcome=' + encodeURIComponent(outcome || '') +
             '&name=' + encodeURIComponent((iv && iv.name) || '') +
             '&role=' + encodeURIComponent((iv && iv.role) || '');
    }

    function refresh(selectId) {
      return api('/api/email-templates' + query()).then(function (rows) {
        templates = Array.isArray(rows) ? rows : [];
        sel.innerHTML = '<option value="">— Select Template —</option>' +
          templates.map(function (t) {
            return '<option value="' + t.id + '">' + esc(t.name) +
              (t.isBuiltin ? '' : ' ★') + '</option>';
          }).join('');
        if (selectId) sel.value = String(selectId);
        return templates;
      }).catch(function () {
        sel.innerHTML = '<option value="">Templates unavailable</option>';
      });
    }

    sel.addEventListener('change', function () {
      var t = current();
      if (!t) return;
      subjInput.value = t.subject || '';
      ed.setHTML(t.body || '');
    });

    mkBtn(ICON.save + ' Save', 'Update the selected template with what is in the editor', '', function () {
      var t = current();
      if (!t) { alert('Pick a template to update, or use “Save as new”.'); return; }
      api('/api/email-templates/' + t.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subjInput.value.trim(), body: ed.getHTML() })
      }).then(function () { refresh(t.id); flash(bar, 'Template saved'); })
        .catch(function (e) { alert('Could not save: ' + (e.message || 'unknown error')); });
    });

    mkBtn(ICON.save + ' Save as new', 'Create a new template from the current subject and body', '', function () {
      var name = window.prompt('Name for the new template');
      if (!name) return;
      api('/api/email-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), outcome: outcome || '',
          subject: subjInput.value.trim(), body: ed.getHTML()
        })
      }).then(function (t) { refresh(t.id); flash(bar, 'Template created'); })
        .catch(function (e) { alert('Could not create: ' + (e.message || 'unknown error')); });
    });

    mkBtn(ICON.trash + ' Delete', 'Delete the selected template (built-ins reset instead)', 'danger', function () {
      var t = current();
      if (!t) { alert('Pick a template first.'); return; }
      var msg = t.isBuiltin
        ? 'Reset “' + t.name + '” to its original wording?'
        : 'Delete the template “' + t.name + '”?';
      if (!window.confirm(msg)) return;
      api('/api/email-templates/' + t.id, { method: 'DELETE' })
        .then(function () { refresh(); flash(bar, t.isBuiltin ? 'Template reset' : 'Template deleted'); })
        .catch(function (e) { alert('Could not delete: ' + (e.message || 'unknown error')); });
    });

    refresh();
  }

  function flash(anchor, text) {
    var el = document.createElement('span');
    el.style.cssText = 'font-size:12px;font-weight:600;color:var(--success,#22d3a5);margin-left:4px';
    el.textContent = text;
    anchor.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  function enhanceEmailPreview() {
    var found = findEmailPreview();
    if (!found) return;
    var modal = found.modal, pre = found.pre;
    if (pre.dataset.hrmsEd === '1') return;
    if (!window.HRMSEditor) { console.warn('[hrms-interviews] HRMSEditor not loaded'); return; }

    var outcome = previewOutcome(modal);
    var toEmail = labelledValue(modal, 'TO:');
    var iv = byEmail(toEmail);

    // ── turn the centred modal into a full-height right drawer ────────────
    modal.classList.add('hrms-eml-drawer');
    if (modal.parentNode && modal.parentNode.classList) modal.parentNode.classList.add('hrms-eml-ovl');

    dressHeader(modal, outcome);

    // ── recipient: bare text -> avatar chip in a labelled card ────────────
    var toEl = labelledSpan(modal, 'TO:');
    if (toEl && toEl.parentNode) {
      var toRow = toEl.parentNode;
      toRow.className = 'hrms-eml-card';
      toRow.innerHTML = '';
      toRow.appendChild(fieldLabel('To'));
      var chipWrap = document.createElement('div');
      chipWrap.className = 'hrms-eml-to';
      chipWrap.innerHTML = '<span class="hrms-eml-chip">' + esc(toEmail) +
        '<button type="button" title="This is the candidate’s address and cannot be changed here">' +
        ICON.x + '</button></span>';
      toRow.appendChild(chipWrap);
      // The address comes from the interview record; removing it would leave
      // nothing to send to, so explain rather than silently doing nothing.
      chipWrap.querySelector('button').addEventListener('click', function () {
        alert('This email goes to the candidate on the interview record (' + toEmail + '), ' +
              'so the recipient cannot be changed here.');
      });
    }

    // ── subject: read-only span -> editable input ─────────────────────────
    var subjEl = labelledSpan(modal, 'SUBJECT:');
    var subjInput = document.createElement('input');
    subjInput.className = 'hrms-eml-subject';
    subjInput.value = subjEl ? (subjEl.textContent || '').trim() : '';
    subjInput.placeholder = 'Subject line';
    if (subjEl && subjEl.parentNode) {
      var subjRow = subjEl.parentNode;
      subjRow.innerHTML = '';
      // Fold Subject into the To card — one card instead of two hands ~40px of
      // height back to the editor, which is the point of the drawer.
      var host = (typeof toRow !== 'undefined' && toRow) ? toRow : subjRow;
      if (host === toRow) subjRow.style.display = 'none';
      else subjRow.className = 'hrms-eml-card';
      var head = document.createElement('div');
      head.className = 'hrms-eml-row';
      head.style.marginTop = host === toRow ? '12px' : '';
      head.appendChild(fieldLabel('Subject'));
      var counter = document.createElement('span');
      counter.className = 'hrms-eml-count';
      head.appendChild(counter);
      host.appendChild(head);
      host.appendChild(subjInput);
      // Subject lines beyond ~120 chars get truncated by most mail clients.
      function countSubject() {
        var n = subjInput.value.length;
        counter.textContent = n + '/120';
        counter.style.color = n > 120 ? '#ef4444' : '';
      }
      subjInput.addEventListener('input', countSubject);
      countSubject();
    }

    // ── body editor in place of the <pre> ─────────────────────────────────
    var ed = window.HRMSEditor.richText({
      html: esc(pre.textContent || '').replace(/\n/g, '<br>'),
      minHeight: '220px'
    });
    pre.dataset.hrmsEd = '1';
    pre.style.display = 'none';

    // Wrap editor + template bar so they can grow to fill the drawer.
    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'hrms-eml-body';
    // Template row belongs with To/Subject in the upper card; the editor gets
    // its own card, with the mode tabs sitting on top of it.
    var tplBar = document.createElement('div');
    tplBar.className = 'hrms-eml-tpl';
    // `host` is the card the Subject ended up in (the To card when merged).
    if (typeof host !== 'undefined' && host) host.appendChild(tplBar);
    else bodyWrap.appendChild(tplBar);

    var editCard = document.createElement('div');
    editCard.className = 'hrms-eml-card hrms-eml-editcard';
    editCard.appendChild(ed.root);
    bodyWrap.appendChild(editCard);
    var note = document.createElement('div');
    note.className = 'hrms-eml-hint';
    note.innerHTML = ICON.info + '<span>Formatting is preserved. Templates can use ' +
      '<code>{{name}}</code>, <code>{{role}}</code>, <code>{{company}}</code>.</span>';
    bodyWrap.appendChild(note);
    pre.parentNode.insertBefore(bodyWrap, pre);

    // Live preview of the real email, rendered by the same server code the
    // send path uses — so what is shown here is what the candidate receives.
    var preview = document.createElement('iframe');
    preview.className = 'hrms-eml-preview';
    preview.style.display = 'none';
    editCard.appendChild(preview);

    var modeBar = document.createElement('div');
    modeBar.className = 'hrms-eml-modes';
    editCard.insertBefore(modeBar, ed.root);

    var seg = document.createElement('div');
    seg.className = 'hrms-eml-seg';
    modeBar.appendChild(seg);
    function mkMode(label, title, icon, parent) {
      var b = document.createElement('button');
      b.type = 'button'; b.title = title;
      b.innerHTML = (icon || '') + '<span>' + label + '</span>';
      (parent || seg).appendChild(b);
      return b;
    }
    var mEdit = mkMode('Visual', 'Visual editor');
    var mHtml = mkMode('HTML', 'Edit the raw HTML source');
    var mPrev = mkMode('Preview', 'Exactly what the candidate will receive', ICON.eye);

    // Pulls the fully-rendered email — header, footer and all — into the HTML
    // editor. Because a complete document is sent verbatim, everything in the
    // branded wrapper becomes editable from that point on.
    var mFull = mkMode('Edit full HTML',
      'Load the complete email, including the branded header and footer, for editing',
      ICON.code, modeBar);
    mFull.classList.add('alt');
    mFull.addEventListener('click', function () {
      if (ed.getHTML().trim().toLowerCase().indexOf('<!doctype') === 0) { setMode('html'); return; }
      if (!window.confirm(
        'Load the complete email — branded header, footer and all — into the HTML editor?\n\n' +
        'You will then control the whole layout, and it is sent exactly as written.')) return;
      mFull.disabled = true;
      api('/api/email-templates/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subjInput.value, body: ed.getHTML(), outcome: outcome,
          name: (iv && iv.name) || '', role: (iv && iv.role) || ''
        })
      }).then(function (r) {
        // setSource, not setHTML: a complete document must bypass the visual
        // editor, whose innerHTML would strip <html>/<body>.
        ed.setSource((r && r.html) || '');
        setMode('html');
        flash(modeBar, 'Full email loaded — you now control the whole layout');
      }).catch(function (e) {
        alert('Could not load the full HTML: ' + (e.message || 'unknown error'));
      }).then(function () { mFull.disabled = false; });
    });

    var standaloneNote = document.createElement('span');
    standaloneNote.className = 'hrms-eml-standalone';
    modeBar.appendChild(standaloneNote);

    function setMode(mode) {
      [mEdit, mHtml, mPrev].forEach(function (b) { b.classList.remove('on'); });
      ed.root.style.display = mode === 'preview' ? 'none' : '';
      preview.style.display = mode === 'preview' ? '' : 'none';
      if (mode === 'preview') {
        mPrev.classList.add('on');
        renderPreview();
      } else {
        ed.setHtmlMode(mode === 'html');
        // The editor refuses to leave source mode for a complete document, so
        // reflect what it actually did rather than what we asked for.
        (ed.isHtmlMode() ? mHtml : mEdit).classList.add('on');
      }
    }

    function renderPreview() {
      preview.srcdoc = '<p style="font:14px sans-serif;color:#64748b;padding:16px">Rendering…</p>';
      api('/api/email-templates/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subjInput.value, body: ed.getHTML(), outcome: outcome,
          name: (iv && iv.name) || '', role: (iv && iv.role) || ''
        })
      }).then(function (r) {
        preview.srcdoc = (r && r.html) || '';
        standaloneNote.textContent = r && r.standalone
          ? 'Your HTML is sent as-is (branded wrapper skipped).'
          : '';
      }).catch(function (e) {
        preview.srcdoc = '<p style="font:14px sans-serif;color:#ef4444;padding:16px">' +
          'Could not render preview: ' + esc(e.message || '') + '</p>';
      });
    }

    mEdit.addEventListener('click', function () { setMode('edit'); });
    mHtml.addEventListener('click', function () { setMode('html'); });
    mPrev.addEventListener('click', function () { setMode('preview'); });
    setMode('edit');

    buildTemplateBar(tplBar, ed, subjInput, outcome, iv);

    // Take over Send so our edited HTML is what actually goes out.
    var btns = modal.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var txt = (b.textContent || '');
      // Restyle the footer while we're here: React ships an emoji label.
      if (txt.indexOf('Close') !== -1 && b.dataset.hrmsFoot !== '1') {
        b.dataset.hrmsFoot = '1';
        if (b.parentNode) b.parentNode.classList.add('hrms-eml-foot');
        b.innerHTML = ICON.x + '<span>Close</span>';
      }
      if (txt.indexOf('Send This Email') === -1 || b.dataset.hrmsEd === '1') continue;
      b.dataset.hrmsEd = '1';
      if (b.parentNode) b.parentNode.classList.add('hrms-eml-foot');
      b.innerHTML = ICON.send + '<span>Send This Email</span>';
      b.addEventListener('click', function (e) {
        var btn = e.currentTarget;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (btn.disabled) return;
        var html = ed.getHTML().trim();
        if (!html) { alert('The email body is empty.'); return; }
        btn.disabled = true; btn.innerHTML = '<span>Sending…</span>';
        var target = byEmail(toEmail);
        var body = { outcome: outcome, subject: subjInput.value.trim(),
                     body: html, toEmail: toEmail };
        if (target) { body.interviewId = target.id; body.toName = target.name; body.role = target.role; }
        api('/api/interviews/send-followup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(function () {
          btn.innerHTML = '<span>Sent ✓</span>';
          load(true);
          setTimeout(function () {
            var x = modal.querySelector('button');   // the ✕ in the header
            if (x) x.click();
          }, 700);
        }).catch(function (err) {
          alert('Could not send the email: ' + (err.message || 'unknown error'));
          btn.disabled = false; btn.innerHTML = ICON.send + '<span>Send This Email</span>';
        });
      }, true);   // capture phase — runs before React's own handler
    }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  function tick() {
    if (!onPage()) return;
    ensureStyle();
    var up = cardByTitle('Upcoming Interviews');
    var done = cardByTitle('Recently Completed');
    var fu = cardByTitle('Candidate Follow-up Status');
    if (up) ensureReplaced(up, 'up');
    if (done) ensureReplaced(done, 'done');
    if (fu) enhanceFollowup();
    enhanceEmailPreview();
    if ((up || done || fu) && !loaded && !loading) load(false);
  }

  function start() {
    tick();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; tick(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { loaded = false; tick(); });
    window.addEventListener('hrmsNavigate', function () { loaded = false; tick(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && onPage()) load(true); });
    setInterval(function () { if (onPage() && (document.getElementById('hrms-iv-up') || document.getElementById('hrms-iv-done'))) load(true); }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  console.log('[hrms-interviews v1] loaded');
})();
