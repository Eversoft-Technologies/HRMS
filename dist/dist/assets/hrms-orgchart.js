/**
 * hrms-orgchart.js — Org Chart page (/org-chart), mounted through HRMSSidecar.
 *
 * Draws the reporting hierarchy from GET /api/org/tree. That endpoint reads
 * UserProfile.manager_email — the same link that routes leave, WFH and
 * timesheet approvals — so the chart and the approval routing always agree.
 * Each node's approverEmail is computed server-side with the approval rule.
 *
 *   GET  /api/org/tree      {nodes, roots, unresolved, canEdit, me}
 *   POST /api/org/manager   {email, managerEmail}  (employee.edit)
 *
 * Features: top-down tree with CSS connectors, expand/collapse (two levels
 * open by default), expand/collapse all, zoom -/+/fit, drag-to-pan, search
 * with path expansion + highlight, "Show me", a details side panel (manager,
 * approver, direct reports, profile link) and "Change manager" for editors.
 * People with no manager and no reports (or a broken manager link) are
 * listed in a "No manager set" group so nobody is hidden.
 *
 * Renders only into its own sidecar root; never touches React-owned nodes.
 */
(function () {
  'use strict';
  if (window.__hrmsOrgChart) return;
  window.__hrmsOrgChart = true;

  var STYLE_ID = 'hrms-oc-style';
  var MINZ = 0.2, MAXZ = 2;

  var S = null;            // HRMSSidecar
  var root = null;         // our page root
  var st = null;           // page state
  var cleanup = [];

  function esc(s) { return S.esc(s); }
  function fresh() {
    return {
      loading: true, error: '', data: null,
      by: {}, kids: {}, chartRoots: [], loose: [],
      open: {}, sel: '', hit: '', z: 1, tx: 0, ty: 0, placed: false,
      q: '', results: [], ri: -1,
      edit: false, pick: null, pickQ: '', saving: false, editErr: ''
    };
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var line = 'color-mix(in srgb,var(--text3,#94a3b8) 55%,transparent)';
    var css = [
      '.oc-page{display:flex;flex-direction:column;gap:14px;min-width:0;max-width:100%;color:var(--text);}',
      '.oc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 14px;}',
      '.oc-search{position:relative;flex:1 1 240px;min-width:0;max-width:420px;}',
      '.oc-search .input-field{padding:8px 12px;}',
      '.oc-dd{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:40;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.18);max-height:320px;overflow:auto;padding:4px;}',
      '.oc-dd-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:7px;cursor:pointer;}',
      '.oc-dd-row:hover,.oc-dd-row.oc-on{background:var(--bg3);}',
      '.oc-dd-empty{padding:10px;color:var(--text3);font-size:12.5px;}',
      '.oc-grp{display:inline-flex;align-items:center;gap:4px;}',
      '.oc-zl{min-width:44px;text-align:center;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;}',
      '.oc-bar .btn-sm{white-space:nowrap;}',
      '.oc-spacer{flex:1 1 auto;}',
      '.oc-hint{font-size:11.5px;color:var(--text3);}',
      '.oc-body{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0;}',
      '.oc-body.oc-has-panel{grid-template-columns:minmax(0,1fr) 330px;}',
      '@media (max-width:980px){.oc-body.oc-has-panel{grid-template-columns:minmax(0,1fr);}}',
      '.oc-page .oc-vp{background-color:var(--bg);}',
      '.oc-vp{position:relative;overflow:hidden;height:calc(100vh - 250px);min-height:380px;padding:0!important;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;' +
        'background-image:radial-gradient(var(--border,rgba(127,127,127,.25)) 1px,transparent 1px);background-size:22px 22px;}',
      '@media (max-width:640px){.oc-vp{height:62vh;min-height:320px;}}',
      '.oc-vp.oc-drag{cursor:grabbing;}',
      '.oc-canvas{position:absolute;left:0;top:0;width:max-content;transform-origin:0 0;padding:24px 32px 40px;will-change:transform;}',
      '.oc-canvas.oc-anim{transition:transform .28s ease;}',
      '.oc-empty{padding:40px 20px;text-align:center;color:var(--text3);font-size:13px;}',
      /* tree + CSS connectors */
      '.oc-tree,.oc-tree ul{margin:0;padding:0;list-style:none;}',
      '.oc-tree{display:flex;gap:48px;align-items:flex-start;}',
      '.oc-tree ul{display:flex;justify-content:center;padding-top:22px;position:relative;}',
      '.oc-tree li{list-style:none;position:relative;flex-shrink:0;padding:22px 7px 0;display:flex;flex-direction:column;align-items:center;}',
      '.oc-tree>li{padding-top:0;}',
      '.oc-tree ul>li::before,.oc-tree ul>li::after{content:"";position:absolute;top:0;right:50%;width:50%;height:22px;border-top:2px solid ' + line + ';}',
      '.oc-tree ul>li::after{right:auto;left:50%;border-left:2px solid ' + line + ';}',
      '.oc-tree ul>li:only-child::before{display:none;}',
      '.oc-tree ul>li:first-child::before,.oc-tree ul>li:last-child::after{border:0 none;}',
      '.oc-tree ul>li:last-child::before{border-right:2px solid ' + line + ';border-radius:0 8px 0 0;}',
      '.oc-tree ul>li:first-child::after{border-radius:8px 0 0 0;}',
      '.oc-tree ul>li:only-child::after{border:0 none;border-left:2px solid ' + line + ';border-radius:0;}',
      '.oc-tree ul::before{content:"";position:absolute;top:0;left:50%;height:22px;border-left:2px solid ' + line + ';}',
      /* cards */
      '.oc-card{position:relative;width:184px;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border,var(--border2));border-radius:12px;padding:12px 10px 10px;text-align:center;cursor:pointer;' +
        'box-shadow:0 1px 3px rgba(0,0,0,.08);transition:box-shadow .15s,border-color .15s,transform .15s;}',
      '.oc-card:hover{border-color:var(--accent);box-shadow:0 6px 18px rgba(0,0,0,.14);}',
      '.oc-card.oc-me{border-color:var(--accent);}',
      '.oc-card.oc-sel{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent),0 6px 18px rgba(0,0,0,.14);}',
      '.oc-card.oc-hit{animation:oc-pulse 1.1s ease 3;}',
      '@keyframes oc-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent);}50%{box-shadow:0 0 0 9px color-mix(in srgb,var(--accent) 0%,transparent);}}',
      '.oc-avwrap{position:relative;display:inline-flex;}',
      '.oc-page .oc-av{width:44px;height:44px;border-radius:50%;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;overflow:hidden;position:relative;}',
      '.oc-page .oc-av.oc-sm{width:30px;height:30px;font-size:11px;}',
      '.oc-page .oc-av.oc-lg{width:56px;height:56px;font-size:18px;}',
      '.oc-nm{margin-top:7px;font-size:13px;font-weight:700;color:var(--text);line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-ti{font-size:11.5px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;min-height:14px;}',
      '.oc-dp{font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:13px;}',
      '.oc-tg{margin-top:8px;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;}',
      '.oc-tg:hover{color:var(--accent);border-color:var(--accent);}',
      '.oc-tg .oc-car{display:inline-block;transition:transform .15s;}',
      '.oc-tg.oc-open .oc-car{transform:rotate(180deg);}',
      '.oc-nr{margin-top:8px;font-size:11px;color:var(--text3);}',
      '.oc-badge{position:absolute;top:7px;right:8px;font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;}',
      '.oc-badge.oc-you{background:var(--accent);color:#fff;}',
      '.oc-badge.oc-warn{background:var(--warn,#f59e0b);color:#111;left:8px;right:auto;}',
      /* side panel */
      '.oc-panel{padding:16px;align-self:start;max-height:calc(100vh - 250px);min-height:200px;overflow:auto;position:relative;}',
      '@media (max-width:980px){.oc-panel{max-height:none;}}',
      '.oc-x{position:absolute;top:10px;right:10px;border:none;background:none;color:var(--text3);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;}',
      '.oc-x:hover{background:var(--bg3);color:var(--text);}',
      '.oc-ph{display:flex;gap:12px;align-items:center;padding-right:24px;}',
      '.oc-ph .oc-nm{margin:0;font-size:15px;white-space:normal;}',
      '.oc-ph .oc-ti{white-space:normal;}',
      '.oc-sec{margin-top:16px;}',
      '.oc-sh{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);margin-bottom:7px;}',
      '.oc-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12.5px;}',
      '.oc-kv dt{color:var(--text3);}',
      '.oc-kv dd{margin:0;color:var(--text);word-break:break-word;}',
      '.oc-plink{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;padding:6px;cursor:pointer;color:var(--text);font:inherit;}',
      '.oc-plink:hover{background:var(--bg3);border-color:var(--border2);}',
      '.oc-plink .oc-pm{min-width:0;}',
      '.oc-plink .oc-pn{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-plink .oc-ps{font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-note{font-size:12.5px;line-height:1.5;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:9px 11px;}',
      '.oc-note b{color:var(--text);}',
      '.oc-note.oc-bad{border-color:var(--warn,#f59e0b);}',
      '.oc-muted{font-size:12.5px;color:var(--text3);}',
      '.oc-link{color:var(--accent);text-decoration:none;font-weight:600;cursor:pointer;background:none;border:none;padding:0;font:inherit;}',
      '.oc-link:hover{text-decoration:underline;}',
      '.oc-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}',
      '.oc-pick{margin-top:8px;max-height:220px;overflow:auto;border:1px solid var(--border2);border-radius:9px;padding:3px;background:var(--bg2);}',
      '.oc-pick .oc-plink.oc-on{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:var(--accent);}',
      '.oc-err{margin-top:8px;color:var(--danger,#dc2626);font-size:12.5px;}',
      /* no-manager group */
      '.oc-loose{padding:14px 16px;}',
      '.oc-chips{display:flex;flex-wrap:wrap;gap:8px;}',
      '.oc-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border2);background:var(--bg2);border-radius:999px;padding:4px 12px 4px 4px;font-size:12.5px;color:var(--text);cursor:pointer;font-family:inherit;max-width:100%;}',
      '.oc-chip:hover{border-color:var(--accent);}',
      '.oc-chip.oc-sel{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 30%,transparent);}',
      '.oc-chip.oc-hit{animation:oc-pulse 1.1s ease 3;}',
      '.oc-chip .oc-cw{color:var(--warn,#f59e0b);font-weight:700;}',
      '.oc-chip span.oc-cn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function hue(s) {
    var h = 0; s = String(s || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function avatar(n, size) {
    var h = hue(n.email || n.name);
    return '<span class="oc-avwrap" data-hrms-presence="' + esc(n.email) + '">' +
      '<span class="oc-av hrms-rbac-av' + (size ? ' oc-' + size : '') + '" data-email="' + esc(n.email) + '" ' +
      'style="background:linear-gradient(135deg,hsl(' + h + ',62%,52%),hsl(' + ((h + 40) % 360) + ',58%,42%))">' +
      esc(n.initials || '?') + '</span></span>';
  }
  function personBtn(n, attr, extra) {
    return '<button type="button" class="oc-plink' + (extra || '') + '" ' + attr + '>' + avatar(n, 'sm') +
      '<span class="oc-pm"><div class="oc-pn">' + esc(n.name) + '</div>' +
      '<div class="oc-ps">' + esc([n.title, n.department].filter(Boolean).join(' · ') || n.email) + '</div></span></button>';
  }
  function toast(msg, bad) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;left:auto;max-width:min(440px,calc(100vw - 48px));z-index:100001;padding:11px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);background:' + (bad ? '#991b1b' : '#065f46');
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, bad ? 6000 : 4500);
  }
  function q(sel) { return root ? root.querySelector(sel) : null; }
  function paintPresence() { try { if (window.__hrmsPresence) window.__hrmsPresence.paint(); } catch (_) {} }
  function ancestors(email) {
    var out = [], seen = {}, cur = st.by[email] && st.by[email].parentEmail;
    while (cur && st.by[cur] && !seen[cur]) { out.push(cur); seen[cur] = 1; cur = st.by[cur].parentEmail; }
    return out;
  }
  function descendants(email) {
    var out = {}, stack = (st.kids[email] || []).slice();
    while (stack.length) {
      var e = stack.pop();
      if (out[e]) continue;
      out[e] = 1;
      stack.push.apply(stack, st.kids[e] || []);
    }
    return out;
  }
  function inChart(email) {
    var a = ancestors(email), top = a.length ? a[a.length - 1] : email;
    return st.chartRoots.indexOf(top) !== -1;
  }
  function profileHref(n) {
    if (st.data && n.email === st.data.me) return '/hr/hris/' + encodeURIComponent(n.email);   // self links use the email (route guard)
    return '/hr/hris/' + (n.hasAccount && /^\d+$/.test(n.key || '') ? n.key : encodeURIComponent(n.email));
  }
  function navTo(href) {
    if (window.__reactRouterNavigate) { window.__reactRouterNavigate(href); return; }
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function load(keep) {
    st.loading = !keep; st.error = '';
    if (!keep) renderAll();
    return S.api('/api/org/tree').then(function (d) {
      if (!root) return;
      index(d || {});
      st.loading = false;
      renderAll();
    }).catch(function (e) {
      if (!root) return;
      st.loading = false;
      st.error = e.status === 401 ? 'Please sign in again to view the org chart.' : (e.message || 'Could not load the org chart.');
      renderAll();
    });
  }
  function index(d) {
    st.data = d;
    st.by = {}; st.kids = {};
    (d.nodes || []).forEach(function (n) { st.by[n.email] = n; });
    (d.nodes || []).forEach(function (n) {
      if (n.parentEmail && st.by[n.parentEmail]) (st.kids[n.parentEmail] = st.kids[n.parentEmail] || []).push(n.email);
    });
    function byName(a, b) { return st.by[a].name.toLowerCase() < st.by[b].name.toLowerCase() ? -1 : 1; }
    Object.keys(st.kids).forEach(function (k) { st.kids[k].sort(byName); });
    var roots = (d.roots || []).filter(function (e) { return st.by[e]; });
    var unresolved = {};
    (d.unresolved || []).forEach(function (e) { unresolved[e] = 1; });
    st.chartRoots = roots.filter(function (e) { return (st.kids[e] || []).length; });
    st.loose = roots.filter(function (e) { return !(st.kids[e] || []).length || unresolved[e]; }).sort(byName);
    if (!st.placed) {               // default: two levels open
      st.open = {};
      st.chartRoots.forEach(function (r) {
        st.open[r] = true;
        (st.kids[r] || []).forEach(function (c) { st.open[c] = true; });
      });
    }
    if (st.sel && !st.by[st.sel]) st.sel = '';
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  function renderAll() {
    if (!root) return;
    var searchHad = document.activeElement && document.activeElement.id === 'oc-q';
    root.innerHTML =
      '<div class="oc-page">' +
        '<div class="card oc-bar">' +
          '<div class="oc-search"><input id="oc-q" class="input-field" type="search" autocomplete="off" placeholder="Search name, email, title or department" value="' + esc(st.q) + '" aria-label="Search people">' +
          '<div class="oc-dd" id="oc-dd" hidden></div></div>' +
          '<button type="button" class="btn-sm" data-oc="me">Show me</button>' +
          '<span class="oc-grp"><button type="button" class="btn-sm" data-oc="expand">Expand all</button>' +
          '<button type="button" class="btn-sm" data-oc="collapse">Collapse all</button></span>' +
          '<span class="oc-grp"><button type="button" class="btn-sm" data-oc="zout" aria-label="Zoom out">&minus;</button>' +
          '<span class="oc-zl" id="oc-zl">100%</span>' +
          '<button type="button" class="btn-sm" data-oc="zin" aria-label="Zoom in">+</button>' +
          '<button type="button" class="btn-sm" data-oc="fit">Fit</button></span>' +
          '<button type="button" class="btn-sm" data-oc="reload" title="Reload">&#8635;</button>' +
        '</div>' +
        '<div class="oc-body" id="oc-body">' +
          '<div class="card oc-vp" id="oc-vp"><div class="oc-canvas" id="oc-canvas"></div></div>' +
          '<aside class="card oc-panel" id="oc-panel" hidden></aside>' +
        '</div>' +
        '<div class="card oc-loose" id="oc-loose" hidden></div>' +
        '<div class="oc-hint">Drag to move around, Ctrl + scroll to zoom. Leave, WFH and timesheet requests go to the manager shown here.</div>' +
      '</div>';
    renderTree();
    renderLoose();
    renderPanel();
    if (searchHad) { var i = q('#oc-q'); if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} } }
  }

  function cardHtml(n) {
    var ch = st.kids[n.email] || [];
    var open = !!st.open[n.email];
    var me = st.data && n.email === st.data.me;
    var cls = 'oc-card' + (me ? ' oc-me' : '') + (st.sel === n.email ? ' oc-sel' : '') + (st.hit === n.email ? ' oc-hit' : '');
    return '<div class="' + cls + '" data-oc-card="' + esc(n.email) + '" tabindex="0" role="button" aria-label="' + esc(n.name) + '">' +
      (me ? '<span class="oc-badge oc-you">You</span>' : '') +
      (n.managerIssue ? '<span class="oc-badge oc-warn" title="' + esc(n.managerIssue) + '">!</span>' : '') +
      avatar(n) +
      '<div class="oc-nm" title="' + esc(n.name) + '">' + esc(n.name) + '</div>' +
      '<div class="oc-ti" title="' + esc(n.title) + '">' + esc(n.title || '') + '</div>' +
      '<div class="oc-dp" title="' + esc(n.department) + '">' + esc(n.department || '') + '</div>' +
      (ch.length ? '<button type="button" class="oc-tg' + (open ? ' oc-open' : '') + '" data-oc-toggle="' + esc(n.email) + '" aria-expanded="' + open + '">' +
        ch.length + (ch.length === 1 ? ' report' : ' reports') + ' <span class="oc-car">&#9662;</span></button>'
        : '<div class="oc-nr">No reports</div>') +
      '</div>';
  }
  function nodeHtml(email, depth) {
    var n = st.by[email];
    var h = '<li>' + cardHtml(n);
    var ch = st.kids[email] || [];
    if (ch.length && st.open[email] && depth < 60) {
      h += '<ul>';
      for (var i = 0; i < ch.length; i++) h += nodeHtml(ch[i], depth + 1);
      h += '</ul>';
    }
    return h + '</li>';
  }
  function renderTree() {
    var cv = q('#oc-canvas');
    if (!cv) return;
    if (st.loading) { cv.innerHTML = '<div class="oc-empty">Loading org chart…</div>'; return; }
    if (st.error) { cv.innerHTML = '<div class="oc-empty" style="color:var(--danger,#dc2626)">' + esc(st.error) + '</div>'; return; }
    if (!st.chartRoots.length) {
      cv.innerHTML = '<div class="oc-empty">No reporting lines have been set yet.' +
        (st.loose.length ? ' Everyone is listed under “No manager set” below.' : '') + '</div>';
    } else {
      var h = '<ul class="oc-tree">';
      st.chartRoots.forEach(function (r) { h += nodeHtml(r, 0); });
      cv.innerHTML = h + '</ul>';
    }
    applyXf(false);
    if (!st.placed) {
      st.placed = true;
      var mine = st.data && st.data.me;
      var first = st.chartRoots[0];
      requestAnimationFrame(function () {
        var vp = q('#oc-vp');
        if (!vp) return;
        var w = cv.offsetWidth;
        if (w <= vp.clientWidth) { st.tx = Math.round((vp.clientWidth - w) / 2); st.ty = 0; applyXf(false); }
        else if (mine && st.by[mine] && inChart(mine)) focusCard(mine, false, false);
        else if (first) focusCard(first, true, false);
      });
    }
    paintPresence();
  }
  function renderLoose() {
    var box = q('#oc-loose');
    if (!box) return;
    if (st.loading || st.error || !st.loose.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="oc-sh">No manager set (' + st.loose.length + ')</div><div class="oc-chips">' +
      st.loose.map(function (e) {
        var n = st.by[e];
        return '<button type="button" class="oc-chip' + (st.sel === e ? ' oc-sel' : '') + (st.hit === e ? ' oc-hit' : '') +
          '" data-oc-chip="' + esc(e) + '" title="' + esc(n.managerIssue || 'No manager linked') + '">' + avatar(n, 'sm') +
          '<span class="oc-cn">' + esc(n.name) + '</span>' + (n.managerIssue ? '<span class="oc-cw">!</span>' : '') + '</button>';
      }).join('') + '</div>';
    paintPresence();
  }

  function renderPanel() {
    var p = q('#oc-panel'), body = q('#oc-body');
    if (!p || !body) return;
    var n = st.sel && st.by[st.sel];
    if (!n) { p.hidden = true; body.classList.remove('oc-has-panel'); return; }
    p.hidden = false; body.classList.add('oc-has-panel');
    var d = st.data || {};
    var mgr = n.parentEmail && st.by[n.parentEmail];
    var appr = n.approverEmail, apprNode = appr && st.by[appr];
    var reports = st.kids[n.email] || [];
    var h = '<button type="button" class="oc-x" data-oc="close" aria-label="Close">&times;</button>' +
      '<div class="oc-ph">' + avatar(n, 'lg') + '<div style="min-width:0"><div class="oc-nm">' + esc(n.name) + '</div>' +
      '<div class="oc-ti">' + esc(n.title || '') + '</div><div class="oc-dp">' + esc(n.department || '') + '</div></div></div>' +
      '<div class="oc-sec"><dl class="oc-kv">' +
        '<dt>Email</dt><dd><a class="oc-link" href="mailto:' + esc(n.email) + '">' + esc(n.email) + '</a></dd>' +
        (n.employeeId ? '<dt>Employee ID</dt><dd>' + esc(n.employeeId) + '</dd>' : '') +
        '<dt>Reports</dt><dd>' + reports.length + ' direct' + (reports.length ? ', ' + Object.keys(descendants(n.email)).length + ' in total' : '') + '</dd>' +
      '</dl></div>';

    h += '<div class="oc-sec"><div class="oc-sh">Manager</div>';
    if (mgr) h += personBtn(mgr, 'data-oc-go="' + esc(mgr.email) + '"');
    else if (n.managerEmail && n.managerEmail !== n.email) h += '<div class="oc-note oc-bad">Linked to <b>' + esc(n.managerEmail) + '</b>. ' + esc(n.managerIssue || '') + '</div>';
    else h += '<div class="oc-muted">No manager set.</div>';
    h += '</div>';

    h += '<div class="oc-sec"><div class="oc-sh">Approvals</div>';
    if (apprNode) h += '<div class="oc-note">Leave, WFH and timesheet requests go to <b>' + esc(apprNode.name) + '</b>' + (apprNode.title ? ' (' + esc(apprNode.title) + ')' : '') + '.</div>';
    else if (appr) h += '<div class="oc-note oc-bad">Leave, WFH and timesheet requests go to <b>' + esc(appr) + '</b>, who is not an active employee. Set a new manager so they are not stuck.</div>';
    else h += '<div class="oc-note">No manager is linked, so leave, WFH and timesheet requests are decided by HR.</div>';
    h += '</div>';

    h += '<div class="oc-sec"><div class="oc-sh">Direct reports (' + reports.length + ')</div>';
    h += reports.length ? reports.map(function (e) { return personBtn(st.by[e], 'data-oc-go="' + esc(e) + '"'); }).join('') : '<div class="oc-muted">None.</div>';
    h += '</div>';

    h += '<div class="oc-acts">';
    if (d.canViewProfiles || n.email === d.me) h += '<a class="btn-sm" href="' + esc(profileHref(n)) + '" data-oc-profile="' + esc(n.email) + '" style="text-decoration:none">' + (n.email === d.me ? 'Open my profile' : 'Open profile') + '</a>';
    if (d.canEdit && n.email !== d.me && !st.edit) h += '<button type="button" class="btn-primary btn-sm" data-oc="edit" style="padding:6px 12px;font-size:12px">Change manager</button>';
    h += '</div>';
    if (d.canEdit && n.email === d.me) h += '<div class="oc-muted" style="margin-top:8px">Your own reporting line is changed by another HR administrator.</div>';

    if (st.edit && d.canEdit) {
      h += '<div class="oc-sec"><div class="oc-sh">Change manager</div>' +
        '<input id="oc-pq" class="input-field" type="search" autocomplete="off" placeholder="Search for the new manager" value="' + esc(st.pickQ) + '">' +
        '<div class="oc-pick" id="oc-pick"></div>' +
        '<div class="oc-muted" id="oc-pickd" style="margin-top:8px"></div>' +
        (st.editErr ? '<div class="oc-err">' + esc(st.editErr) + '</div>' : '') +
        '<div class="oc-acts"><button type="button" class="btn-primary btn-sm" data-oc="save" style="padding:6px 12px;font-size:12px"' + (st.saving ? ' disabled' : '') + '>' + (st.saving ? 'Saving…' : 'Save') + '</button>' +
        '<button type="button" class="btn-sm" data-oc="cancel">Cancel</button></div>' +
        '<div class="oc-muted" style="margin-top:8px">Requests already pending with the current manager stay with them; new requests go to the new manager.</div></div>';
    }
    p.innerHTML = h;
    if (st.edit) renderPick();
    paintPresence();
  }

  function pickList() {
    var n = st.by[st.sel];
    if (!n) return [];
    var bad = descendants(n.email); bad[n.email] = 1;
    var term = st.pickQ.trim().toLowerCase();
    return Object.keys(st.by).filter(function (e) {
      if (bad[e]) return false;
      if (!term) return true;
      var p = st.by[e];
      return (p.name + ' ' + p.email + ' ' + (p.title || '') + ' ' + (p.department || '')).toLowerCase().indexOf(term) !== -1;
    }).sort(function (a, b) { return st.by[a].name.toLowerCase() < st.by[b].name.toLowerCase() ? -1 : 1; }).slice(0, 40);
  }
  function renderPick() {
    var box = q('#oc-pick'), desc = q('#oc-pickd');
    if (!box) return;
    var n = st.by[st.sel];
    var cur = st.pick === null ? (n.managerEmail || '') : st.pick;
    var list = pickList();
    var h = '<button type="button" class="oc-plink' + (cur === '' ? ' oc-on' : '') + '" data-oc-pick=""><span class="oc-pm"><div class="oc-pn">No manager</div><div class="oc-ps">Remove the reporting line</div></span></button>';
    h += list.map(function (e) { return personBtn(st.by[e], 'data-oc-pick="' + esc(e) + '"', e === cur ? ' oc-on' : ''); }).join('');
    if (!list.length) h += '<div class="oc-dd-empty">No matching people (the person and their reports are excluded).</div>';
    box.innerHTML = h;
    if (desc) {
      var t = cur && st.by[cur];
      desc.innerHTML = 'New manager: <b>' + esc(t ? t.name : (cur || 'none')) + '</b>' + (cur === (n.managerEmail || '') ? ' (unchanged)' : '');
    }
    paintPresence();
  }

  /* ── search ───────────────────────────────────────────────────────────── */
  function search(term) {
    st.q = term;
    term = term.trim().toLowerCase();
    var dd = q('#oc-dd');
    if (!dd) return;
    if (!term) { dd.hidden = true; st.results = []; return; }
    var starts = [], has = [];
    Object.keys(st.by).forEach(function (e) {
      var n = st.by[e], name = n.name.toLowerCase();
      var hay = name + ' ' + e + ' ' + (n.title || '').toLowerCase() + ' ' + (n.department || '').toLowerCase();
      if (name.indexOf(term) === 0 || e.indexOf(term) === 0) starts.push(e);
      else if (hay.indexOf(term) !== -1) has.push(e);
    });
    function byName(a, b) { return st.by[a].name.toLowerCase() < st.by[b].name.toLowerCase() ? -1 : 1; }
    st.results = starts.sort(byName).concat(has.sort(byName)).slice(0, 12);
    st.ri = st.results.length ? 0 : -1;
    drawResults();
  }
  function drawResults() {
    var dd = q('#oc-dd');
    if (!dd) return;
    dd.hidden = false;
    dd.innerHTML = st.results.length ? st.results.map(function (e, i) {
      var n = st.by[e];
      return '<div class="oc-dd-row' + (i === st.ri ? ' oc-on' : '') + '" data-oc-res="' + esc(e) + '">' + avatar(n, 'sm') +
        '<span class="oc-pm" style="min-width:0"><div class="oc-pn" style="font-size:12.5px;font-weight:600">' + esc(n.name) + '</div>' +
        '<div class="oc-ps" style="font-size:11px;color:var(--text3)">' + esc([n.title, n.department, n.email].filter(Boolean).join(' · ')) + '</div></span></div>';
    }).join('') : '<div class="oc-dd-empty">No one matches “' + esc(st.q.trim()) + '”.</div>';
  }
  function closeResults() { var dd = q('#oc-dd'); if (dd) dd.hidden = true; }

  /* ── selection / focus ────────────────────────────────────────────────── */
  function reveal(email, select) {
    if (!st.by[email]) return;
    ancestors(email).forEach(function (a) { st.open[a] = true; });
    if (select) { st.sel = email; st.edit = false; st.pick = null; st.pickQ = ''; st.editErr = ''; }
    st.hit = email;
    renderTree(); renderLoose(); renderPanel();
    if (inChart(email)) requestAnimationFrame(function () { focusCard(email, false, true); });
    else {
      var chip = root && root.querySelector('[data-oc-chip="' + cssq(email) + '"]');
      if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    var who = email;
    setTimeout(function () {
      if (st && st.hit === who) {
        st.hit = '';
        var el = root && root.querySelector('.oc-hit');
        if (el) el.classList.remove('oc-hit');
        var ch = root && root.querySelector('.oc-chip.oc-hit');
        if (ch) ch.classList.remove('oc-hit');
      }
    }, 3600);
  }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function select(email) {
    st.sel = email; st.edit = false; st.pick = null; st.pickQ = ''; st.editErr = '';
    var cards = root.querySelectorAll('.oc-card.oc-sel, .oc-chip.oc-sel');
    Array.prototype.forEach.call(cards, function (c) { c.classList.remove('oc-sel'); });
    var mine = root.querySelectorAll('[data-oc-card="' + cssq(email) + '"], [data-oc-chip="' + cssq(email) + '"]');
    Array.prototype.forEach.call(mine, function (c) { c.classList.add('oc-sel'); });
    renderPanel();
    var p = q('#oc-panel');                  // stacked layout: bring the panel into view
    if (email && p && !p.hidden && window.innerWidth <= 980 && p.scrollIntoView) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ── pan / zoom ───────────────────────────────────────────────────────── */
  function applyXf(anim) {
    var cv = q('#oc-canvas');
    if (!cv) return;
    cv.classList.toggle('oc-anim', !!anim);
    cv.style.transform = 'translate(' + Math.round(st.tx) + 'px,' + Math.round(st.ty) + 'px) scale(' + st.z + ')';
    var zl = q('#oc-zl');
    if (zl) zl.textContent = Math.round(st.z * 100) + '%';
  }
  function zoomAt(nz, cx, cy, anim) {
    nz = Math.max(MINZ, Math.min(MAXZ, nz));
    var vp = q('#oc-vp');
    if (!vp) return;
    if (cx == null) { cx = vp.clientWidth / 2; cy = vp.clientHeight / 2; }
    st.tx = cx - (cx - st.tx) * (nz / st.z);
    st.ty = cy - (cy - st.ty) * (nz / st.z);
    st.z = nz;
    applyXf(anim);
  }
  function fit() {
    var vp = q('#oc-vp'), cv = q('#oc-canvas');
    if (!vp || !cv) return;
    var w = cv.offsetWidth, h = cv.offsetHeight;
    if (!w || !h) return;
    var z = Math.max(MINZ, Math.min(1, vp.clientWidth / w, vp.clientHeight / h));
    st.z = z;
    st.tx = (vp.clientWidth - w * z) / 2;
    st.ty = Math.max(0, (vp.clientHeight - h * z) / 2);
    applyXf(true);
  }
  function focusCard(email, top, anim) {
    var vp = q('#oc-vp'), card = root && root.querySelector('[data-oc-card="' + cssq(email) + '"]');
    if (!vp || !card) return;
    var v = vp.getBoundingClientRect(), c = card.getBoundingClientRect();
    st.tx += (v.left + v.width / 2) - (c.left + c.width / 2);
    st.ty += top ? (v.top + 24) - c.top : (v.top + v.height / 2) - (c.top + c.height / 2);
    applyXf(anim);
  }

  var drag = null, justDragged = false;
  function onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button, a, input, .oc-tg')) return;
    var vp = q('#oc-vp');
    if (!vp || !vp.contains(e.target)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false };
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    var vp = q('#oc-vp');
    if (!drag.moved) {
      drag.moved = true;
      if (vp) { vp.classList.add('oc-drag'); try { vp.setPointerCapture(e.pointerId); } catch (_) {} }
    }
    st.tx = drag.tx + dx; st.ty = drag.ty + dy;
    applyXf(false);
  }
  function onUp(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var vp = q('#oc-vp');
    if (vp) vp.classList.remove('oc-drag');
    if (drag.moved) { justDragged = true; setTimeout(function () { justDragged = false; }, 0); }
    drag = null;
  }
  function onWheel(e) {
    var vp = q('#oc-vp');
    if (!vp || !vp.contains(e.target)) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var r = vp.getBoundingClientRect();
      zoomAt(st.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top, false);
    } else {
      st.tx -= e.shiftKey ? e.deltaY : e.deltaX;
      st.ty -= e.shiftKey ? 0 : e.deltaY;
      applyXf(false);
    }
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  function save() {
    var n = st.by[st.sel];
    if (!n || st.saving) return;
    var target = st.pick === null ? (n.managerEmail || '') : st.pick;
    if (target === (n.managerEmail || '')) { st.editErr = 'Choose a different manager first.'; renderPanel(); return; }
    st.saving = true; st.editErr = '';
    renderPanel();
    S.api('/api/org/manager', { method: 'POST', body: { email: n.email, managerEmail: target } }).then(function (r) {
      if (!root) return;
      st.saving = false; st.edit = false; st.pick = null; st.pickQ = '';
      toast((r && r.message) || 'Manager updated.');
      return load(true).then(function () { if (root) reveal(n.email, false); });
    }).catch(function (e) {
      if (!root) return;
      st.saving = false;
      st.editErr = e.message || 'Could not change the manager.';
      renderPanel();
    });
  }

  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;
    var res = t.closest('[data-oc-res]');
    if (res) { closeResults(); reveal(res.getAttribute('data-oc-res'), true); return; }
    if (!t.closest('.oc-search')) closeResults();

    var prof = t.closest('[data-oc-profile]');
    if (prof) { e.preventDefault(); e.stopPropagation(); navTo(prof.getAttribute('href')); return; }

    var tg = t.closest('[data-oc-toggle]');
    if (tg) {
      var em = tg.getAttribute('data-oc-toggle');
      st.open[em] = !st.open[em];
      var card = tg.closest('[data-oc-card]'), before = card && card.getBoundingClientRect();
      renderTree();
      var after = root.querySelector('[data-oc-card="' + cssq(em) + '"]');
      if (before && after) {                 // keep the toggled card where it was
        var a = after.getBoundingClientRect();
        st.tx += before.left - a.left; st.ty += before.top - a.top;
        applyXf(false);
      }
      return;
    }
    var cardEl = t.closest('[data-oc-card]');
    if (cardEl) { if (justDragged) return; select(cardEl.getAttribute('data-oc-card')); return; }
    var chip = t.closest('[data-oc-chip]');
    if (chip) { select(chip.getAttribute('data-oc-chip')); return; }
    var go = t.closest('[data-oc-go]');
    if (go) { reveal(go.getAttribute('data-oc-go'), true); return; }
    var pk = t.closest('[data-oc-pick]');
    if (pk) { st.pick = pk.getAttribute('data-oc-pick'); st.editErr = ''; renderPick(); return; }

    var b = t.closest('[data-oc]');
    if (!b) return;
    var act = b.getAttribute('data-oc');
    if (act === 'me') {
      var me = st.data && st.data.me;
      if (me && st.by[me]) reveal(me, true); else toast('You are not on the org chart yet.', true);
    } else if (act === 'expand') {
      Object.keys(st.kids).forEach(function (k) { st.open[k] = true; });
      renderTree();
    } else if (act === 'collapse') {
      st.open = {};
      renderTree();
      requestAnimationFrame(function () { if (st.chartRoots[0]) focusCard(st.chartRoots[0], true, true); });
    } else if (act === 'zin') zoomAt(st.z * 1.2, null, null, true);
    else if (act === 'zout') zoomAt(st.z / 1.2, null, null, true);
    else if (act === 'fit') fit();
    else if (act === 'reload') load(true);
    else if (act === 'close') { st.sel = ''; st.edit = false; select(''); }
    else if (act === 'edit') { st.edit = true; st.pick = null; st.pickQ = ''; st.editErr = ''; renderPanel(); var pi = q('#oc-pq'); if (pi) pi.focus(); }
    else if (act === 'cancel') { st.edit = false; st.pick = null; st.editErr = ''; renderPanel(); }
    else if (act === 'save') save();
  }
  function onInput(e) {
    if (e.target.id === 'oc-q') search(e.target.value);
    else if (e.target.id === 'oc-pq') { st.pickQ = e.target.value; renderPick(); }
  }
  function onKey(e) {
    var t = e.target;
    if (t.id === 'oc-q') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!st.results.length) return;
        e.preventDefault();
        st.ri = (st.ri + (e.key === 'ArrowDown' ? 1 : -1) + st.results.length) % st.results.length;
        drawResults();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (st.ri >= 0 && st.results[st.ri]) { closeResults(); reveal(st.results[st.ri], true); }
      } else if (e.key === 'Escape') closeResults();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.getAttribute && t.getAttribute('data-oc-card')) {
      e.preventDefault();
      select(t.getAttribute('data-oc-card'));
    }
  }
  function onFocusIn(e) {
    if (e.target.id === 'oc-q' && st.q.trim()) search(st.q);
  }

  /* ── page ─────────────────────────────────────────────────────────────── */
  function listen(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); cleanup.push(function () { el.removeEventListener(ev, fn, opt); }); }

  function mount(r) {
    S = window.HRMSSidecar;
    ensureStyle();
    unmount();
    root = r;
    st = fresh();
    listen(root, 'click', onClick);
    listen(root, 'input', onInput);
    listen(root, 'keydown', onKey);
    listen(root, 'focusin', onFocusIn);
    listen(root, 'pointerdown', onDown);
    listen(window, 'pointermove', onMove);
    listen(window, 'pointerup', onUp);
    listen(window, 'pointercancel', onUp);
    listen(root, 'wheel', onWheel, { passive: false });
    load(false);
  }
  function unmount() {
    while (cleanup.length) { try { cleanup.pop()(); } catch (_) {} }
    drag = null;
    root = null;
  }

  function register() {
    if (!window.HRMSSidecar) return false;
    window.HRMSSidecar.register({
      base: '/org-chart',
      title: 'Org Chart',
      mount: function (r) { mount(r); },
      update: function () {},
      unmount: unmount
    });
    return true;
  }
  if (!register()) {
    var tries = 0, iv = setInterval(function () { if (register() || ++tries > 50) clearInterval(iv); }, 100);
  }
})();
