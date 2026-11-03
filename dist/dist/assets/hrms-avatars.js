/**
 * hrms-avatars.js
 * ---------------------------------------------------------------------------
 * Shows people's profile pictures wherever the app lists a person.
 *
 * The React bundle only renders a picture on the topbar avatar and the
 * account drawer; every other avatar (sidebar footer, HRIS / directory
 * tables, Leave rows, Team Status Now, dashboard directory, access control,
 * the employee profile page, the work-submissions table ...) is an initials
 * circle. This sidecar overlays an <img> on those circles once it knows who
 * they stand for. Lists that show a person as bare text (the task tracker's
 * "Assigned To" / "Team Lead" lines, tables whose first column is "Employee")
 * first get an initials circle inserted, so the picture has somewhere to go.
 *
 *   GET /api/avatars             who has a picture: [{email, name, aliases,
 *                                employeeId, initials, v, url}]
 *   GET /api/avatars/<email>?v=  the picture bytes, fetched lazily once per
 *                                version and kept as an object URL
 *
 * Who an avatar stands for is resolved from, in order: the signed-in user for
 * topbar / sidebar avatars; a data-email / data-hrms-presence / data-key /
 * mailto: on the element or a near ancestor; an email, an employee code or a
 * known name in the text beside it (nearest text first, then the whole row).
 * A match only counts when the initials drawn in the circle are plausible
 * for that person, so a manager named in the same table row never lands on
 * the employee's avatar.
 *
 * Own picture changes are instant: the Settings page writes
 * localStorage.hrms_profile_pic and fires 'hrmsProfilePic'. Colleagues pick a
 * new picture up on the next list refresh (every 5 minutes, and whenever the
 * app announces hrmsContextUpdate). No bundle rebuild.
 */
(function () {
  'use strict';
  if (window.__hrmsAvatars) return;

  var STYLE_ID   = 'hrms-avatars-style';
  var IMG_CLASS  = 'hrms-avatar-img';
  var INJ_CLASS  = 'hrms-av-inject';
  var SELECTOR   = '.av, .haa-av, .hrms-dir-avatar, .fed-av, .hp-pav, .hrms-event-avatar, .hrms-rbac-av';
  /* Circles drawn with inline styles and no class (the work-submissions table
     hand-patched into the bundle draws its initials that way). */
  var CIRCLE_SEL = 'div[style*="border-radius: 50%"], span[style*="border-radius: 50%"], div[style*="border-radius:50%"], span[style*="border-radius:50%"]';
  var OWN_SCOPE  = '.topbar, .sidebar-footer, .hrms-drawer';
  var ROW_SCOPE  = 'tr, li, .av-row, .haa-tr, .hrms-dir-row, .hrms-dir-person, .hp-person, .fed-head, .kanban-card';
  var LIST_TTL   = 5 * 60 * 1000;
  var EMAIL_RE   = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  var people  = {};    // email -> { email, name, initials, v, url }
  var byName  = {};    // lower-cased name or alias -> email
  var byCode  = {};    // upper-cased employee code -> email
  var nameRe  = null;  // one alternation of every known name, longest first
  var codeRe  = null;  // one alternation of every known employee code
  var pics    = {};    // email -> { v, src } once a picture is known usable ('' = none)
  var pending = {};    // email -> true while a picture is being fetched
  var listAt  = 0, listBusy = false;
  var ownPic  = '', ownState = 'unknown';   // own data URL and whether it decodes

  function session() { try { return JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}; } catch (_) { return {}; } }
  function norm(e) { return String(e || '').trim().toLowerCase(); }
  function sessionEmail() { return norm(session().email); }
  function readOwnPic() {
    try { return localStorage.getItem('hrms_profile_pic') || session().profilePic || ''; }
    catch (_) { return session().profilePic || ''; }
  }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ── initials ──────────────────────────────────────────────────────────── */
  /* The initials an avatar might show for this person. The app derives them
     several ways (first+last word, first two words, the stored initials, the
     email's local part), so accept any of them. */
  function initialsSet(name, email, stored) {
    var set = {};
    function add(s) { s = String(s || '').replace(/[^A-Za-z]/g, '').toUpperCase(); if (s) set[s] = true; }
    var words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
    if (words.length) {
      add(words[0][0] + (words.length > 1 ? words[words.length - 1][0] : ''));
      add(words[0][0] + (words.length > 1 ? words[1][0] : ''));
      add(words.slice(0, 2).map(function (w) { return w[0]; }).join(''));
      add(words[0][0]);
      add(words[0].slice(0, 2));
    }
    var local = String(email || '').split('@')[0];
    if (local) {
      var lw = local.split(/[._-]+/).filter(Boolean);
      if (lw.length) add(lw[0][0] + (lw.length > 1 ? lw[lw.length - 1][0] : ''));
      add(local.slice(0, 2));
      add(local[0]);
    }
    add(stored);
    return set;
  }
  function initialsOf(name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    return ((w[0][0] || '') + (w.length > 1 ? (w[w.length - 1][0] || '') : '')).toUpperCase();
  }
  // The circle's own text, ignoring nested nodes (presence dots, our image).
  function ownText(el) {
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/[^A-Za-z]/g, '').toUpperCase();
  }
  function initialsOk(el, person) {
    var txt = ownText(el);
    if (!txt) return true;
    if (txt.length > 3) return false;
    var set = initialsSet(person.name, person.email, person.initials);
    (person.aliases || []).forEach(function (a) { var s = initialsSet(a, '', ''); for (var k in s) set[k] = true; });
    return !!set[txt];
  }

  /* ── the list of people with pictures ──────────────────────────────────── */
  function loadList(force) {
    if (listBusy || !sessionEmail()) return;
    if (!force && Date.now() - listAt < LIST_TTL) return;
    listBusy = true;
    fetch('/api/avatars', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        var next = {}, names = {}, codes = {}, nameList = [], codeList = [];
        rows.forEach(function (p) {
          var em = norm(p.email);
          if (!em) return;
          var aliases = Array.isArray(p.aliases) ? p.aliases.slice() : [];
          if (p.name && aliases.indexOf(p.name) === -1) aliases.unshift(p.name);
          next[em] = { email: em, name: String(p.name || ''), aliases: aliases, initials: String(p.initials || ''), v: p.v || 0, url: String(p.url || '') };
          aliases.forEach(function (a) {
            var nm = String(a || '').trim().toLowerCase();
            if (nm.length >= 3 && !names[nm]) { names[nm] = em; nameList.push(nm); }
          });
          var code = String(p.employeeId || '').trim().toUpperCase();
          if (code.length >= 3 && !codes[code]) { codes[code] = em; codeList.push(code); }
        });
        // A picture whose version moved on is fetched again on next use.
        Object.keys(pics).forEach(function (em) { if (!next[em] || next[em].v !== pics[em].v) delete pics[em]; });
        people = next;
        byName = names;
        byCode = codes;
        nameList.sort(function (a, b) { return b.length - a.length; });
        nameRe = nameList.length ? new RegExp('(?:^|[^a-z])(' + nameList.map(escRe).join('|') + ')(?![a-z])', 'i') : null;
        codeList.sort(function (a, b) { return b.length - a.length; });
        codeRe = codeList.length ? new RegExp('(?:^|[^a-z0-9])(' + codeList.map(escRe).join('|') + ')(?![a-z0-9])', 'i') : null;
        listAt = Date.now();
      })
      .catch(function () {})
      .then(function () { listBusy = false; schedule(); });
  }

  /* ── pictures ──────────────────────────────────────────────────────────── */
  // Resolves true when the browser can decode the source. Nothing is painted
  // until it can: a broken <img> inside an avatar trips hrms-sidebar.js's
  // fallback, which rewrites the circle's text.
  function verify(src) {
    return new Promise(function (resolve) {
      try {
        var im = new Image();
        im.onload = function () { resolve(true); };
        im.onerror = function () { resolve(false); };
        im.src = src;
      } catch (_) { resolve(false); }
    });
  }
  // The usable picture source for this person right now, or '' (which may
  // mean "being fetched": a later sweep paints it).
  function ensurePic(email) {
    if (email === sessionEmail()) {
      var cur = readOwnPic();
      if (cur !== ownPic) { ownPic = cur; ownState = 'unknown'; }
      if (ownPic) {
        if (ownState === 'ok') return ownPic;
        if (ownState === 'unknown') {
          ownState = 'pending';
          verify(ownPic).then(function (ok) { ownState = ok ? 'ok' : 'bad'; if (ok) schedule(); });
        }
        return '';
      }
      // No local copy yet (fresh sign-in): fall through to the server copy.
    }
    var p = people[email];
    if (!p) return '';
    var have = pics[email];
    if (have && have.v === p.v) return have.src;
    if (pending[email]) return '';
    pending[email] = true;
    function done(src) { pics[email] = { v: p.v, src: src || '' }; delete pending[email]; if (src) schedule(); }
    if (p.url) { verify(p.url).then(function (ok) { done(ok ? p.url : ''); }); return ''; }
    fetch('/api/avatars/' + encodeURIComponent(email) + '?v=' + encodeURIComponent(p.v), { headers: { Accept: 'image/*,*/*;q=0.8' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then(function (b) { var src = URL.createObjectURL(b); return verify(src).then(function (ok) { done(ok ? src : ''); }); })
      .catch(function () { done(''); });
    return '';
  }

  /* ── who is this avatar? ───────────────────────────────────────────────── */
  function attrEmail(el) {
    var n = el, hops = 0;
    while (n && n.nodeType === 1 && hops < 6) {
      var cand = n.getAttribute('data-email') || n.getAttribute('data-hrms-presence') ||
                 n.getAttribute('data-hrms-email') || n.getAttribute('data-hris-email') || '';
      if (!cand) { var k = n.getAttribute('data-key') || ''; if (k.indexOf('@') !== -1) cand = k; }
      if (!cand && n.tagName === 'A') { var h = n.getAttribute('href') || ''; if (h.indexOf('mailto:') === 0) cand = h.slice(7); }
      if (cand) { var m = cand.match(EMAIL_RE); if (m) return norm(m[0]); }
      n = n.parentElement; hops++;
    }
    return '';
  }
  function emailsIn(text) {
    var out = [], re = new RegExp(EMAIL_RE.source, 'g'), m;
    while ((m = re.exec(text)) && out.length < 6) out.push(norm(m[0]));
    return out;
  }
  function nameFor(text) {
    if (!nameRe) return '';
    var m = String(text || '').match(nameRe);
    return m ? (byName[m[1].toLowerCase()] || '') : '';
  }
  function codeFor(text) {
    if (!codeRe) return '';
    var m = String(text || '').match(codeRe);
    return m ? (byCode[m[1].toUpperCase()] || '') : '';
  }
  // The words around an avatar, with a space between adjacent elements.
  // textContent would glue them ("PSPriya Sharmapriya@company.com"), hiding
  // both the name and the email; the avatar's own initials are left out.
  function textAround(scope, skip) {
    var out = [], walker = document.createTreeWalker(scope, 4 /* text nodes */, null), n;
    while ((n = walker.nextNode())) {
      if (skip && skip !== scope && skip.contains(n)) continue;
      var s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (s) out.push(s);
    }
    return out.join(' ');
  }
  function personFor(email) {
    if (!email) return null;
    if (people[email]) return people[email];
    if (email === sessionEmail()) {
      var s = session();
      return { email: email, name: String(s.name || s.fullName || ''), aliases: [], initials: String(s.initials || ''), v: 0, url: '' };
    }
    return null;
  }
  function accept(el, email) {
    var p = personFor(email);
    return (p && initialsOk(el, p)) ? email : '';
  }
  function resolve(el) {
    if (el.closest(OWN_SCOPE)) return accept(el, sessionEmail());
    var em = attrEmail(el);
    if (em) return accept(el, em);
    // Nearest text first (the name beside the avatar), then the whole row.
    var scopes = [];
    if (el.parentElement) scopes.push(el.parentElement);
    var row = el.closest(ROW_SCOPE);
    if (row && row !== el.parentElement) scopes.push(row);
    for (var i = 0; i < scopes.length; i++) {
      var text = textAround(scopes[i], el);
      var emails = emailsIn(text);
      for (var j = 0; j < emails.length; j++) { var hit = accept(el, emails[j]); if (hit) return hit; }
      var byCd = accept(el, codeFor(text));
      if (byCd) return byCd;
      var byNm = accept(el, nameFor(text));
      if (byNm) return byNm;
    }
    return '';
  }

  /* ── inserting avatars where a list shows only a name ──────────────────── */
  function injectedAvatar(name) {
    var sp = document.createElement('span');
    sp.className = 'av ' + INJ_CLASS;
    sp.setAttribute('aria-hidden', 'true');
    sp.textContent = initialsOf(name);
    return sp;
  }
  function textOnly(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return false;
    return (el.textContent || '').trim().length > 0;
  }
  function inject() {
    // Task tracker cards: "👤 Assigned To: <strong>Name</strong>" and the
    // Team Lead line beneath it.
    var cards = document.querySelectorAll('.kanban-card');
    for (var c = 0; c < cards.length; c++) {
      var lines = cards[c].children;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.querySelector('.' + INJ_CLASS)) continue;
        var strong = line.querySelector(':scope > strong');
        if (!strong) continue;
        var label = (line.firstChild && line.firstChild.nodeType === 3) ? line.firstChild.nodeValue : '';
        if (!/assigned to|team lead/i.test(label)) continue;
        var who = (strong.textContent || '').trim();
        if (!who || /^unassigned$/i.test(who)) continue;
        line.insertBefore(injectedAvatar(who), strong);
      }
    }
    // Tables whose first column is the employee, shown as bare text.
    var tables = document.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var th = tables[t].querySelector('thead th, tr:first-child th');
      if (!th || !/^(employee|employee name|assignee|assigned to)$/i.test((th.textContent || '').trim())) continue;
      var rows = tables[t].querySelectorAll('tbody tr');
      for (var r = 0; r < rows.length; r++) {
        var cell = rows[r].querySelector('td');
        if (!cell || cell.colSpan > 1 || !textOnly(cell)) continue;
        var nm = (cell.textContent || '').trim();
        if (!nm || nm.length > 60) continue;
        cell.insertBefore(injectedAvatar(nm), cell.firstChild);
      }
    }
  }

  /* ── painting ──────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.' + IMG_CLASS + '{position:absolute;inset:0;width:100%!important;height:100%!important;border-radius:inherit;object-fit:cover;display:block;margin:0;padding:0;border:0;pointer-events:none;}' +
      '.' + INJ_CLASS + '{display:inline-flex!important;width:24px;height:24px;font-size:9px;font-weight:700;vertical-align:middle;margin-right:7px;background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#7c5cfc));color:#fff;}' +
      '.kanban-card .' + INJ_CLASS + '{width:20px;height:20px;font-size:8px;margin:0 5px 0 2px;}' +
      /* The topbar avatar and the account drawer paint the signed-in user in
         an orange gradient while the sidebar footer and the My Profile card
         use the app's blue one. Same person, same colours. */
      '.topbar .av:not(:has(> img)),.hrms-drawer-av:not(:has(> img)){background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#7c5cfc))!important;}';
    document.head.appendChild(st);
  }
  function ourImg(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.tagName === 'IMG') return n.classList.contains(IMG_CLASS) ? n : null;
    }
    return undefined;   // no image at all
  }
  function looksLikeCircle(el) {
    if (el.children.length && !ourImg(el)) return false;
    var txt = ownText(el);
    if (!txt || txt.length > 3) return false;
    var w = parseInt((el.getAttribute('style') || '').replace(/.*width:\s*([\d.]+)px.*/i, '$1'), 10);
    return !isNaN(w) && w >= 14 && w <= 96;
  }
  function paint(el, email) {
    var img = ourImg(el);
    if (img === null) return;                       // somebody else's picture (topbar, chat)
    var src = email ? ensurePic(email) : '';
    if (!src) {
      if (img) img.parentNode.removeChild(img);
      if (!email) el.removeAttribute('data-hrms-avatar');
      return;
    }
    if (!img) {
      if (el.style.position !== 'relative' && getComputedStyle(el).position === 'static') el.style.position = 'relative';
      img = document.createElement('img');
      img.className = IMG_CLASS;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
      el.insertBefore(img, el.firstChild);
    }
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    if (el.getAttribute('data-hrms-avatar') !== email) el.setAttribute('data-hrms-avatar', email);
  }
  function sweep() {
    if (!document.body || !sessionEmail()) return;
    ensureStyle();
    inject();
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) paint(els[i], resolve(els[i]));
    var circles = document.querySelectorAll(CIRCLE_SEL);
    for (var j = 0; j < circles.length; j++) {
      var el = circles[j];
      if (el.classList.contains('av') || !looksLikeCircle(el)) continue;
      paint(el, resolve(el));
    }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { queued = false; sweep(); });
  }
  function ours(node) {
    return node.nodeType === 1 && node.classList &&
      (node.classList.contains(IMG_CLASS) || node.classList.contains(INJ_CLASS));
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i], a, r;
        for (a = 0; a < m.addedNodes.length; a++) if (!ours(m.addedNodes[a])) { schedule(); return; }
        for (r = 0; r < m.removedNodes.length; r++) if (!ours(m.removedNodes[r])) { schedule(); return; }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ── when to refresh ───────────────────────────────────────────────────── */
  window.addEventListener('hrmsProfilePic', function () { ownState = 'unknown'; schedule(); });
  window.addEventListener('storage', function (e) {
    if (e.key === 'hrms_profile_pic' || e.key === 'hrms_session') { ownState = 'unknown'; loadList(true); schedule(); }
  });
  window.addEventListener('hrmsContextUpdate', function () { loadList(true); });
  window.addEventListener('popstate', schedule);
  setInterval(function () { loadList(false); }, 60000);
  // Signing in or out happens without a reload: notice the session changing.
  var lastEmail = sessionEmail();
  setInterval(function () {
    var now = sessionEmail();
    if (now === lastEmail) return;
    lastEmail = now;
    people = {}; byName = {}; byCode = {}; nameRe = null; codeRe = null; pics = {}; pending = {}; listAt = 0; ownState = 'unknown';
    if (now) loadList(true);
    schedule();
  }, 2000);

  function boot() { loadList(true); schedule(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__hrmsAvatars = {
    sweep: sweep,
    refresh: function () { loadList(true); },
    initialsSet: initialsSet,
    initialsOf: initialsOf,
    nameFor: nameFor,
    codeFor: codeFor,
    people: function () { return people; }
  };
})();
