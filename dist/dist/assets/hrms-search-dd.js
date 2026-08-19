/*
 * hrms-search-dd.js — a search dropdown for every search box in the app.
 *
 * Adds the panel first built for Work Submissions to every other search input:
 *
 *   SEARCH IN        chips derived from the associated table's column headers,
 *                    scoping the search to one column. Omitted where the search
 *                    filters cards rather than a table (Notifications,
 *                    Interviews) — there are no columns to scope by.
 *   RECENT SEARCHES  the last five committed terms for that particular box,
 *                    replayable in one click. Kept per route + placeholder in
 *                    localStorage, so each module has its own history.
 *
 * Design constraints, because this runs on top of modules owned by others:
 *
 *   - It never restructures a module's DOM. The panel is appended to <body> and
 *     positioned from the input's bounding rect, so no host markup is wrapped,
 *     moved or re-parented. Removing this file removes every trace.
 *   - Replaying a search sets the input through React's native value setter and
 *     dispatches a real `input` event, so the module's own filtering runs. We
 *     never reimplement anyone's search.
 *   - Column scoping layers on top: the module filters as it always did, and we
 *     additionally hide rows whose chosen column does not match. The result is
 *     the intersection, i.e. "matches, in this column".
 *   - Work Submissions is skipped — it has its own built-in panel.
 *   - Every entry point is wrapped so a failure here can never break a page.
 */
(function () {
  'use strict';

  var PANEL_ID = 'hrms-sdd-panel';
  var STORE = 'hrms_sdd_recent';
  var MAX_RECENT = 5;
  var MARK = 'data-sdd-hidden';

  /* ── storage ─────────────────────────────────────────────────────────── */
  function keyFor(input) {
    var ph = (input.getAttribute('placeholder') || 'search').toLowerCase();
    return location.pathname + '::' + ph.replace(/[^a-z]+/g, '-').slice(0, 40);
  }
  function readAll() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function recentsFor(input) {
    var v = readAll()[keyFor(input)];
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  }
  function remember(input, field, term) {
    term = String(term || '').trim();
    if (!term) return;
    try {
      var all = readAll(), k = keyFor(input);
      var list = recentsFor(input).filter(function (x) {
        return !(x.q === term && x.f === field);
      });
      list.unshift({ f: field, q: term });
      all[k] = list.slice(0, MAX_RECENT);
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch (_) { /* private mode, quota — not worth breaking a page over */ }
  }
  function forget(input) {
    try {
      var all = readAll();
      delete all[keyFor(input)];
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch (_) {}
  }

  /* ── the table a search box belongs to ───────────────────────────────── */
  /* Walk up from the input, and at each ancestor look for a table below it.
     The nearest one wins, which is what a person would assume visually. */
  function tableFor(input) {
    var node = input;
    for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      /* Stop before <body>. Climbing that far would let a search box with no
         table of its own (Notifications, Interviews) adopt an unrelated
         module's table further down the page, and offer columns that have
         nothing to do with it. */
      if (node === document.body || node === document.documentElement) break;
      var t = node.querySelector && node.querySelector('table');
      if (t && t.querySelector('thead th')) return t;
    }
    return null;
  }
  function columnsOf(table) {
    if (!table) return [];
    var out = [];
    var ths = table.querySelectorAll('thead tr th');
    for (var i = 0; i < ths.length; i++) {
      var label = (ths[i].textContent || '').trim();
      /* skip checkbox / action / icon-only columns — nothing to search in */
      if (!label || label.length > 24 || /^actions?$/i.test(label)) continue;
      out.push({ i: i, label: label });
    }
    return out;
  }

  /* ── column scoping ──────────────────────────────────────────────────── */
  /* Applied on top of the module's own filtering. `state` lives on the input so
     several search boxes on one page never interfere with each other. */
  var observer = null;
  function applyScope(input) {
    var st = input.__sdd;
    if (!st) return;
    var table = tableFor(input);
    if (!table) return;
    var term = String(input.value || '').trim().toLowerCase();
    var rows = table.querySelectorAll('tbody tr');

    if (observer) observer.disconnect();          // never observe our own writes
    try {
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var hide = false;
        if (st.col >= 0 && term && row.children.length > st.col) {
          var cell = row.children[st.col];
          hide = ((cell && cell.textContent) || '').toLowerCase().indexOf(term) === -1;
        }
        if (hide) {
          if (!row.hasAttribute(MARK)) {
            row.setAttribute(MARK, '1');
            row.style.display = 'none';
          }
        } else if (row.hasAttribute(MARK)) {
          row.removeAttribute(MARK);
          row.style.display = '';
        }
      }
    } catch (_) {} finally { observe(); }
  }
  function clearScope(input) {
    var table = tableFor(input);
    if (!table) return;
    var hidden = table.querySelectorAll('tbody tr[' + MARK + ']');
    if (observer) observer.disconnect();
    try {
      for (var i = 0; i < hidden.length; i++) {
        hidden[i].removeAttribute(MARK);
        hidden[i].style.display = '';
      }
    } catch (_) {} finally { observe(); }
  }

  /* ── driving the host module's own search ────────────────────────────── */
  function setValue(input, value) {
    try {
      var proto = input instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, value);                    // bypass React's value shim
    } catch (_) { input.value = value; }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ── the panel ───────────────────────────────────────────────────────── */
  var openFor = null;

  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p && p.parentNode) p.parentNode.removeChild(p);
    openFor = null;
  }

  function position(panel, input) {
    var r = input.getBoundingClientRect();
    var width = Math.max(240, Math.min(340, Math.max(r.width, 240)));
    var left = Math.min(r.left, window.innerWidth - width - 12);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, left) + 'px';
    panel.style.top = (r.bottom + 7) + 'px';
  }

  function chip(label, on, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'hrms-sdd-chip' + (on ? ' on' : '');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = label;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onClick);
    return b;
  }

  function section(title, clearFn) {
    var sec = document.createElement('div');
    sec.className = 'hrms-sdd-sec';
    var h = document.createElement('div');
    h.className = 'hrms-sdd-h';
    var span = document.createElement('span');
    span.textContent = title;
    h.appendChild(span);
    if (clearFn) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'hrms-sdd-clr';
      c.textContent = 'Clear';
      c.addEventListener('mousedown', function (e) { e.preventDefault(); });
      c.addEventListener('click', clearFn);
      h.appendChild(c);
    }
    sec.appendChild(h);
    return sec;
  }

  function buildPanel(input) {
    var st = input.__sdd;
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'hrms-sdd';

    /* SEARCH IN — only where there is a table to take columns from */
    var cols = columnsOf(tableFor(input));
    if (cols.length) {
      var sec = section('Search in', null);
      var wrap = document.createElement('div');
      wrap.className = 'hrms-sdd-chips';
      wrap.appendChild(chip('All fields', st.col === -1, function () {
        st.col = -1;
        clearScope(input);
        render(input);
      }));
      cols.forEach(function (c) {
        wrap.appendChild(chip(c.label, st.col === c.i, function () {
          st.col = c.i;
          applyScope(input);
          render(input);
        }));
      });
      sec.appendChild(wrap);
      panel.appendChild(sec);
    }

    /* RECENT SEARCHES */
    var recents = recentsFor(input);
    if (recents.length) {
      var rsec = section('Recent searches', function () {
        forget(input);
        render(input);
      });
      var list = document.createElement('div');
      list.className = 'hrms-sdd-list';
      recents.forEach(function (entry) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'hrms-sdd-item';
        var label = document.createElement('span');
        label.className = 'hrms-sdd-txt';
        var f = document.createElement('span');
        f.className = 'hrms-sdd-f';
        f.textContent = (entry.f >= 0 && cols.length
          ? ((cols.filter(function (c) { return c.i === entry.f; })[0] || {}).label || 'All fields')
          : 'All fields') + ': ';
        var q = document.createElement('span');
        q.className = 'hrms-sdd-q';
        q.textContent = entry.q;
        label.appendChild(f);
        label.appendChild(q);
        item.appendChild(label);
        item.addEventListener('mousedown', function (e) { e.preventDefault(); });
        item.addEventListener('click', function () {
          st.col = typeof entry.f === 'number' ? entry.f : -1;
          setValue(input, entry.q);
          setTimeout(function () { applyScope(input); }, 0);
          closePanel();
        });
        list.appendChild(item);
      });
      rsec.appendChild(list);
      panel.appendChild(rsec);
    }

    /* Card-based searches (Interviews, Notifications) have no columns to scope
       by, so with no history yet there would be nothing to render. Returning
       null there made focusing the box do nothing at all, which reads as a
       broken control rather than an empty one. Show what the panel is for
       instead — history builds from there. */
    if (!panel.firstChild) {
      var hint = section('Recent searches', null);
      var line = document.createElement('div');
      line.className = 'hrms-sdd-hint';
      line.textContent = 'Press Enter to keep a search here.';
      hint.appendChild(line);
      panel.appendChild(hint);
    }
    return panel;
  }

  function render(input) {
    closePanel();
    var panel = buildPanel(input);
    if (!panel) return;
    document.body.appendChild(panel);
    position(panel, input);
    openFor = input;
  }

  /* ── wiring an input ─────────────────────────────────────────────────── */
  function isSearch(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['text', 'search', ''].indexOf(type) === -1) return false;
    var ph = el.getAttribute('placeholder') || '';
    if (!/search/i.test(ph)) return false;
    if (el.closest && el.closest('.subs-search')) return false;   // has its own
    return true;
  }

  function attach(input) {
    if (input.__sdd) return;
    input.__sdd = { col: -1 };
    input.addEventListener('focus', function () { render(input); });
    input.addEventListener('click', function () { if (openFor !== input) render(input); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        remember(input, input.__sdd.col, input.value);
        closePanel();
      } else if (e.key === 'Escape') {
        closePanel();
      }
    });
    input.addEventListener('input', function () {
      if (input.__sdd.col >= 0) setTimeout(function () { applyScope(input); }, 0);
    });
  }

  function scan() {
    try {
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        if (isSearch(inputs[i])) attach(inputs[i]);
      }
    } catch (_) {}
  }

  /* ── observation, mirroring hrms-perms.js: never observe our own writes ─ */
  function observe() {
    if (!observer) return;
    try { observer.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  }
  function start() {
    scan();
    observer = new MutationObserver(function () {
      if (observer) observer.disconnect();
      try {
        scan();
        if (openFor && document.contains(openFor)) {
          var p = document.getElementById(PANEL_ID);
          if (p) position(p, openFor);
          applyScope(openFor);
        } else if (openFor) {
          closePanel();                        // the input went away with a re-render
        }
      } catch (_) {} finally { observe(); }
    });
    observe();

    document.addEventListener('mousedown', function (e) {
      if (!openFor) return;
      var t = e.target;
      if (t === openFor) return;
      if (t && t.closest && t.closest('#' + PANEL_ID)) return;
      closePanel();
    });
    window.addEventListener('resize', function () {
      var p = document.getElementById(PANEL_ID);
      if (p && openFor) position(p, openFor);
    });
    window.addEventListener('scroll', function () {
      var p = document.getElementById(PANEL_ID);
      if (p && openFor) position(p, openFor);
    }, true);

    console.log('[hrms-search-dd v1] loaded');
  }

  var css = document.createElement('style');
  css.textContent = [
    '.hrms-sdd{position:fixed;z-index:2400;max-height:min(70vh,430px);overflow-y:auto;',
    'padding:6px;border:1px solid var(--border2,#2b3849);border-radius:12px;',
    'background:var(--bg2,#111827);box-shadow:0 12px 32px rgba(10,16,32,.24),0 2px 6px rgba(10,16,32,.12)}',
    '.hrms-sdd-sec{padding:8px 8px 10px}',
    '.hrms-sdd-sec+.hrms-sdd-sec{border-top:1px solid var(--border2,#2b3849)}',
    '.hrms-sdd-h{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;',
    'color:var(--text3,#7d8aa2);margin-bottom:9px}',
    '.hrms-sdd-clr{border:0;background:none;padding:0;cursor:pointer;font:inherit;',
    'font-size:10px;letter-spacing:.09em;color:var(--danger,#f75f4f)}',
    '.hrms-sdd-clr:hover{text-decoration:underline}',
    '.hrms-sdd-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.hrms-sdd-chip{border:1px solid var(--border2,#2b3849);background:var(--bg3,#1a2235);',
    'color:var(--text2,#8a9bb8);border-radius:8px;padding:5px 11px;font:inherit;font-size:12px;',
    'cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
    '.hrms-sdd-chip:hover{background:var(--surface,#1e2d45);color:var(--text,#e8edf7)}',
    '.hrms-sdd-chip.on{background:color-mix(in srgb,var(--accent,#4f8ef7) 14%,transparent);',
    'border-color:color-mix(in srgb,var(--accent,#4f8ef7) 40%,transparent);',
    'color:var(--accent,#4f8ef7);font-weight:600}',
    '.hrms-sdd-list{display:flex;flex-direction:column}',
    '.hrms-sdd-item{display:flex;align-items:center;gap:9px;width:100%;border:0;background:none;',
    'padding:7px 6px;border-radius:8px;cursor:pointer;text-align:left;font:inherit;',
    'color:var(--text2,#8a9bb8);transition:background .15s ease}',
    '.hrms-sdd-item:hover{background:var(--bg3,#1a2235)}',
    '.hrms-sdd-txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}',
    '.hrms-sdd-hint{font-size:12px;color:var(--text3,#7d8aa2);padding:2px 6px 2px}',
    '.hrms-sdd-f{color:var(--text3,#7d8aa2)}',
    '.hrms-sdd-q{color:var(--text,#e8edf7);font-weight:600}',
    '.hrms-sdd-chip:focus-visible,.hrms-sdd-item:focus-visible,.hrms-sdd-clr:focus-visible',
    '{outline:2px solid var(--accent,#4f8ef7);outline-offset:2px}',
  ].join('');
  try { document.head.appendChild(css); } catch (_) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { try { start(); } catch (_) {} });
  } else {
    try { start(); } catch (_) {}
  }
})();
