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
