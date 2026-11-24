/**
 * hrms-orgchart.js v4 — Org Chart page (/org-chart), mounted through HRMSSidecar.
 *
 * A zoomable SVG chart of the reporting hierarchy with matrix (dual) lines.
 *
 *   GET    /api/org/chart        {nodes, roots, unresolved, edges, projects, canEdit, canEditLines, me}
 *                                (falls back to GET /api/org/tree when matrix reporting is absent)
 *   POST   /api/org/manager      {email, managerEmail}           change the line manager (employee.edit)
 *   GET    /api/org/lines?email= one person's project lines + allocation (self / managers / leads / HR)
 *   POST   /api/org/lines        add a project / scrum line (HR)
 *   DELETE /api/org/lines/<id>   end a line (HR)
 *
 * Solid lines = line manager (UserProfile.manager_email, the one that routes
 * leave / WFH / timesheet approvals). Dashed coloured lines = project / scrum
 * leads (hrms_plus ReportingLine), % on hover. Project leads get no approvals.
 *
 * Features: tidy top-down tree layout (big leaf groups stack in two columns),
 * fully open up to 80 people, otherwise three levels open by default, collapsible subtrees, expand / collapse all,
 * wheel / pinch / button zoom, fit, drag to pan, search with focus and the
 * path to the top highlighted, "Show me", legend + "Show project lines"
 * toggle, a side panel (line manager, approvals, project leads with %, time
 * split, direct and project reports), HR editing (line manager, project
 * lines), export PNG / SVG, and the "No manager set" group. Large expanded
 * charts are culled to the viewport and drawn with less detail when zoomed out.
 *
 * Placeholders avoid the word "search": hrms-search-dd.js attaches its recent-searches
 * panel to such inputs, and it would cover our own result / pick lists.
 *
 * Renders only into its own sidecar root; never touches React-owned nodes.
 */
(function () {
  'use strict';
  if (window.__hrmsOrgChart) return;
  window.__hrmsOrgChart = true;

  var STYLE_ID = 'hrms-oc-style';
  var MINZ = 0.05, MAXZ = 2.5;
  var CW = 208, CH = 96, HG = 22, VG = 66, LH = CH + VG, ROWH = CH + 18, SPINE = 28, PAD = 48, ROOTGAP = 60;
  var STACK_MIN = 4;            // a manager with this many leaf reports gets a two-column stack
  var CULL_MIN = 220;           // laid-out nodes before drawing only what is near the viewport
  var LOD_Z = 0.38;             // below this zoom cards are drawn without text
  var OPEN_ALL_MAX = 80;        // orgs up to this size open fully; larger ones show three levels
  var LS_PROJ = 'hrms_oc_show_proj';
  var PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#c026d3', '#0d9488'];
  var SCREEN = {
    bg: 'var(--bg)', card: 'var(--bg2)', bg3: 'var(--bg3)', text: 'var(--text)', text2: 'var(--text2)', text3: 'var(--text3)',
    accent: 'var(--accent)', warn: 'var(--warn,#f59e0b)',
    border: 'color-mix(in srgb,var(--text3) 45%,transparent)', line: 'color-mix(in srgb,var(--text3) 75%,transparent)'
  };

  var S = null;            // HRMSSidecar
  var root = null;         // our page root
  var st = null;           // page state
  var cleanup = [];
  var FONT = 'sans-serif';

  function esc(s) { return S.esc(s); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function fresh() {
    return {
      loading: true, error: '', data: null, token: 0,
      by: {}, kids: {}, chartRoots: [], loose: [], pedges: [], pTo: {}, pFrom: {}, projColor: {}, projList: [],
      open: {}, sel: '', hit: '', path: {}, z: 1, tx: 0, ty: 0, placed: false, lay: null, win: null, lod: false,
      q: '', results: [], ri: -1,
      edit: false, pick: null, pickQ: '', saving: false, editErr: '',
      showProj: lsGet(LS_PROJ) !== '0', exportOpen: false,
      detail: {}, add: null, photos: {}, photoBusy: {}, tween: 0
    };
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.oc-page{display:flex;flex-direction:column;gap:14px;min-width:0;max-width:100%;color:var(--text);}',
      '.oc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 14px;}',
      '.oc-search{position:relative;flex:1 1 240px;min-width:0;max-width:420px;}',
      '.oc-search .input-field{padding:8px 12px;}',
      '.oc-dd{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:40;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.18);max-height:320px;overflow:auto;padding:4px;}',
      '.oc-dd-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:7px;cursor:pointer;}',
      '.oc-dd-row:hover,.oc-dd-row.oc-on{background:var(--bg3);}',
      '.oc-dd-empty{padding:10px;color:var(--text3);font-size:12.5px;}',
      '.oc-grp{display:inline-flex;align-items:center;gap:4px;position:relative;}',
      '.oc-zl{min-width:44px;text-align:center;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;}',
      '.oc-bar .btn-sm{white-space:nowrap;}',
      '.oc-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2);cursor:pointer;user-select:none;white-space:nowrap;}',
      '.oc-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:41;background:var(--bg2);border:1px solid var(--border2);border-radius:9px;box-shadow:0 12px 30px rgba(0,0,0,.2);padding:4px;min-width:150px;}',
      '.oc-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font:inherit;font-size:12.5px;padding:7px 10px;border-radius:6px;cursor:pointer;}',
      '.oc-menu button:hover{background:var(--bg3);}',
      '.oc-hint{font-size:11.5px;color:var(--text3);}',
      '.oc-body{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0;}',
      '.oc-body.oc-has-panel{grid-template-columns:minmax(0,1fr) 340px;}',
      '@media (max-width:980px){.oc-body.oc-has-panel{grid-template-columns:minmax(0,1fr);}}',
      '.oc-page .oc-vp{background-color:var(--bg);}',
      '.oc-vp{position:relative;overflow:hidden;height:calc(100vh - 250px);min-height:380px;padding:0!important;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;' +
        'background-image:radial-gradient(color-mix(in srgb,var(--text3) 30%,transparent) 1px,transparent 1px);background-size:22px 22px;}',
      '@media (max-width:640px){.oc-vp{height:62vh;min-height:320px;}}',
      '.oc-vp.oc-drag{cursor:grabbing;}',
      '.oc-svg{position:absolute;inset:0;width:100%;height:100%;display:block;}',
      '.oc-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:40px 20px;text-align:center;color:var(--text3);font-size:13px;}',
      '.oc-node{cursor:pointer;outline:none;}',
      '.oc-node:focus-visible .oc-cbg{stroke:var(--accent)!important;stroke-width:2.5!important;}',
      '.oc-node:hover .oc-cbg{stroke:var(--accent)!important;}',
      '.oc-node.oc-hit .oc-cbg{animation:oc-blink 1.1s ease 3;}',
      '@keyframes oc-blink{0%,100%{stroke-width:1.5}50%{stroke-width:6}}',
      '.oc-tg{cursor:pointer;}',
      '.oc-tg:hover rect{stroke:var(--accent)!important;}',
      '.oc-pe{cursor:help;}',
      '.oc-pe:hover .oc-pv{stroke-width:3.2!important;stroke-opacity:1!important;}',
      '.oc-legend{position:absolute;left:10px;bottom:10px;max-width:calc(100% - 20px);display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:7px 11px;font-size:11.5px;color:var(--text2);' +
        'background:color-mix(in srgb,var(--bg2) 92%,transparent);border:1px solid var(--border2);border-radius:9px;cursor:default;}',
      '.oc-lg{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
      '@media (max-width:640px){.oc-legend{font-size:10.5px;gap:3px 9px;padding:5px 8px;left:6px;bottom:6px;max-width:calc(100% - 12px);}}',
      '.oc-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;}',
      '.oc-tip{position:absolute;z-index:5;pointer-events:none;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 9px;font-size:12px;box-shadow:0 8px 20px rgba(0,0,0,.22);max-width:260px;}',
      '.oc-tip b{font-weight:700;}',
      '.oc-page .oc-av{width:44px;height:44px;border-radius:50%;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;overflow:hidden;position:relative;}',
      '.oc-page .oc-av.oc-sm{width:30px;height:30px;font-size:11px;}',
      '.oc-page .oc-av.oc-lg{width:56px;height:56px;font-size:18px;}',
      '.oc-avwrap{position:relative;display:inline-flex;}',
      '.oc-nm{margin-top:7px;font-size:13px;font-weight:700;color:var(--text);line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-ti{font-size:11.5px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;min-height:14px;}',
      '.oc-dp{font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:13px;}',
      /* side panel */
      '.oc-panel{padding:16px;align-self:start;max-height:calc(100vh - 250px);min-height:200px;overflow:auto;position:relative;}',
      '@media (max-width:980px){.oc-panel{max-height:none;}}',
      '.oc-x{position:absolute;top:10px;right:10px;border:none;background:none;color:var(--text3);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;}',
      '.oc-x:hover{background:var(--bg3);color:var(--text);}',
      '.oc-ph{display:flex;gap:12px;align-items:center;padding-right:24px;}',
      '.oc-ph .oc-nm{margin:0;font-size:15px;white-space:normal;}',
      '.oc-ph .oc-ti{white-space:normal;}',
      '.oc-sec{margin-top:16px;}',
      '.oc-sh{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);margin-bottom:7px;display:flex;align-items:center;gap:7px;}',
      '.oc-sh svg{flex:none;}',
      '.oc-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12.5px;}',
      '.oc-kv dt{color:var(--text3);}',
      '.oc-kv dd{margin:0;color:var(--text);word-break:break-word;}',
      '.oc-plink{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;padding:6px;cursor:pointer;color:var(--text);font:inherit;}',
      '.oc-plink:hover{background:var(--bg3);border-color:var(--border2);}',
      '.oc-plink .oc-pm{min-width:0;flex:1;}',
      '.oc-plink .oc-pn{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-plink .oc-ps{font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.oc-lrow{display:flex;align-items:center;gap:4px;}',
      '.oc-lrow .oc-plink{flex:1;min-width:0;}',
      '.oc-rm{border:none;background:none;color:var(--text3);font-size:17px;cursor:pointer;padding:2px 7px;border-radius:6px;line-height:1;}',
      '.oc-rm:hover{color:var(--danger,#dc2626);background:var(--bg3);}',
      '.oc-pj{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap;}',
      '.oc-pj i{width:8px;height:8px;border-radius:50%;display:inline-block;}',
      '.oc-st{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:var(--bg3);color:var(--text2);border:1px solid var(--border2);margin-left:4px;}',
      '.oc-split{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--bg3);border:1px solid var(--border2);margin:4px 0 6px;}',
      '.oc-split i{display:block;height:100%;}',
      '.oc-note{font-size:12.5px;line-height:1.5;color:var(--text2);background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:9px 11px;}',
      '.oc-note b{color:var(--text);}',
      '.oc-note.oc-bad{border-color:var(--warn,#f59e0b);}',
      '.oc-muted{font-size:12.5px;color:var(--text3);}',
      '.oc-link{color:var(--accent);text-decoration:none;font-weight:600;cursor:pointer;background:none;border:none;padding:0;font:inherit;}',
      '.oc-link:hover{text-decoration:underline;}',
      '.oc-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}',
      '.oc-pick{margin-top:8px;max-height:220px;overflow:auto;border:1px solid var(--border2);border-radius:9px;padding:3px;background:var(--bg2);}',
      '.oc-pick .oc-plink.oc-on{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:var(--accent);}',
      '.oc-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;}',
      '.oc-form label{display:block;font-size:11px;color:var(--text3);margin-bottom:3px;}',
      '.oc-form .oc-full{grid-column:1 / -1;}',
      '.oc-form .input-field{padding:7px 10px;}',
      '.oc-err{margin-top:8px;color:var(--danger,#dc2626);font-size:12.5px;}',
      /* no-manager group */
      '.oc-loose{padding:14px 16px;}',
      '.oc-chips{display:flex;flex-wrap:wrap;gap:8px;max-height:132px;overflow-y:auto;padding:2px 4px 2px 0;}',
      /* With people in "No manager set" the chart gives up some height so both fit on screen. */
      '.oc-page.oc-has-loose .oc-vp{height:calc(100vh - 440px);min-height:320px;}',
      '.oc-page.oc-has-loose .oc-panel{max-height:calc(100vh - 440px);}',
      '@media (max-width:980px){.oc-page.oc-has-loose .oc-panel{max-height:none;}}',
      '.oc-loose .oc-hint{font-size:11.5px;color:var(--text3);margin:-2px 0 8px;}',
      '.oc-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border2);background:var(--bg2);border-radius:999px;padding:4px 12px 4px 4px;font-size:12.5px;color:var(--text);cursor:pointer;font-family:inherit;max-width:100%;}',
      '.oc-chip:hover{border-color:var(--accent);}',
      '.oc-chip.oc-sel{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 30%,transparent);}',
      '.oc-chip.oc-hit{animation:oc-pulse 1.1s ease 3;}',
      '@keyframes oc-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent);}50%{box-shadow:0 0 0 9px color-mix(in srgb,var(--accent) 0%,transparent);}}',
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
  function personBtn(n, attr, extra, sub) {
    return '<button type="button" class="oc-plink' + (extra || '') + '" ' + attr + '>' + avatar(n, 'sm') +
      '<span class="oc-pm"><div class="oc-pn">' + esc(n.name) + '</div>' +
      '<div class="oc-ps">' + (sub != null ? sub : esc([n.title, n.department].filter(Boolean).join(' · ') || n.email)) + '</div></span></button>';
  }
  function toast(msg, bad) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;left:auto;max-width:min(440px,calc(100vw - 48px));z-index:100001;padding:11px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);background:' + (bad ? '#991b1b' : '#065f46');
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, bad ? 6000 : 4500);
  }
  function q(sel) { return root ? root.querySelector(sel) : null; }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
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
  function projColor(name) { return st.projColor[String(name || '').toLowerCase()] || PALETTE[hue(name) % PALETTE.length]; }
  function byName(a, b) { return st.by[a].name.toLowerCase() < st.by[b].name.toLowerCase() ? -1 : 1; }
  function lineSample(dashed, color) {
    return '<svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" style="stroke:' + (color || SCREEN.line) +
      ';stroke-width:2' + (dashed ? ';stroke-dasharray:5 4' : '') + '"/></svg>';
  }

  /* text fitting (SVG has no ellipsis) */
  var mctx = null, mcache = {};
  function measure(text, px, weight) {
    if (!mctx) { try { mctx = document.createElement('canvas').getContext('2d'); } catch (_) {} }
    if (!mctx) return String(text).length * px * 0.56;
    mctx.font = (weight || 400) + ' ' + px + 'px ' + FONT;
    return mctx.measureText(String(text)).width;
  }
  function fitText(text, px, weight, max) {
    text = String(text || '');
    var key = weight + '|' + px + '|' + max + '|' + text;
    if (mcache[key] != null) return mcache[key];
    var out = text;
    if (measure(text, px, weight) > max) {
      var lo = 0, hi = text.length;
      while (lo < hi) { var m = (lo + hi + 1) >> 1; if (measure(text.slice(0, m) + '…', px, weight) <= max) lo = m; else hi = m - 1; }
      out = text.slice(0, lo) + '…';
    }
    mcache[key] = out;
    return out;
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function load(keep) {
    st.loading = !keep; st.error = '';
    var tok = ++st.token;
    if (!keep) renderAll();
    return S.api('/api/org/chart').catch(function (e) {
      if (e.status === 404) return S.api('/api/org/tree');       // matrix reporting not installed
      throw e;
    }).then(function (d) {
      if (!root || tok !== st.token) return;
      index(d || {});
      st.loading = false;
      if (keep) { relayout(); renderChart(); renderLoose(); renderLegend(); renderPanel(); }
      else renderAll();
    }).catch(function (e) {
      if (!root || tok !== st.token) return;
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
    Object.keys(st.kids).forEach(function (k) { st.kids[k].sort(byName); });
    st.pedges = (d.edges || []).filter(function (e) { return e.kind === 'project' && st.by[e.from] && st.by[e.to]; });
    st.pTo = {}; st.pFrom = {};
    st.pedges.forEach(function (e) {
      (st.pTo[e.to] = st.pTo[e.to] || []).push(e);
      (st.pFrom[e.from] = st.pFrom[e.from] || []).push(e);
    });
    var names = {};
    (d.projects || []).forEach(function (p) { names[p.name.toLowerCase()] = p.name; });
    st.pedges.forEach(function (e) { if (!names[String(e.project).toLowerCase()]) names[String(e.project).toLowerCase()] = e.project; });
    st.projList = Object.keys(names).sort().map(function (k) { return names[k]; });
    st.projColor = {};
    st.projList.forEach(function (n, i) { st.projColor[n.toLowerCase()] = PALETTE[i % PALETTE.length]; });
    var roots = (d.roots || []).filter(function (e) { return st.by[e]; });
    var unresolved = {};
    (d.unresolved || []).forEach(function (e) { unresolved[e] = 1; });
    st.chartRoots = roots.filter(function (e) { return (st.kids[e] || []).length; });
    st.loose = roots.filter(function (e) { return !(st.kids[e] || []).length || unresolved[e]; }).sort(byName);
    if (!st.placed && (d.nodes || []).length <= OPEN_ALL_MAX) {     // small org: everything open
      st.open = {};
      Object.keys(st.kids).forEach(function (k) { st.open[k] = true; });
    } else if (!st.placed) {        // larger org: three levels visible, the rest collapsed
      st.open = {};
      st.chartRoots.forEach(function (r) {
        st.open[r] = true;
        (st.kids[r] || []).forEach(function (c) { st.open[c] = true; });
      });
    }
    if (st.sel && !st.by[st.sel]) st.sel = '';
    st.detail = {};
    computePath();
    relayout();
  }
  function computePath() {
    st.path = {};
    if (st.sel && st.by[st.sel]) { st.path[st.sel] = 1; ancestors(st.sel).forEach(function (a) { st.path[a] = 1; }); }
  }
  function loadDetail(email) {
    if (!email || st.detail[email]) return;
    st.detail[email] = { loading: true };
    var tok = st.token;
    S.api('/api/org/lines?email=' + encodeURIComponent(email)).then(function (d) {
      if (!root || !st || tok !== st.token) return;
      st.detail[email] = { data: d };
      if (st.sel === email) renderPanel();
    }).catch(function (e) {
      if (!root || !st || tok !== st.token) return;
      st.detail[email] = { error: e.message, status: e.status };
      if (st.sel === email) renderPanel();
    });
  }

  /* ── layout (tidy tree with contours) ─────────────────────────────────── */
  function visKids(e) { return st.open[e] ? (st.kids[e] || []) : []; }
  function isStack(e) {
    var k = visKids(e);
    if (k.length < STACK_MIN) return false;
    for (var i = 0; i < k.length; i++) if (visKids(k[i]).length) return false;
    return true;
  }
  function pack(cs, gap) {
    var offs = [0], mL = cs[0].l.slice(), mR = cs[0].r.slice();
    for (var i = 1; i < cs.length; i++) {
      var c = cs[i], s = -Infinity, n = Math.min(c.l.length, mR.length);
      for (var d = 0; d < n; d++) s = Math.max(s, mR[d] + gap - c.l[d]);
      offs.push(s);
      for (var d2 = 0; d2 < c.l.length; d2++) {
        if (d2 < mL.length) { mL[d2] = Math.min(mL[d2], s + c.l[d2]); mR[d2] = Math.max(mR[d2], s + c.r[d2]); }
        else { mL.push(s + c.l[d2]); mR.push(s + c.r[d2]); }
      }
    }
    return { offs: offs, l: mL, r: mR };
  }
  function relayout() {
    if (!st.chartRoots.length) { st.lay = null; return; }
    var rel = {}, stack = {};
    function lay(e, depth) {
      var k = visKids(e), L = [-CW / 2], R = [CW / 2];
      if (!k.length || depth > 80) return { l: L, r: R };
      if (isStack(e)) {
        stack[e] = true;
        var rows = Math.ceil(k.length / 2), half = CW / 2 + SPINE / 2;
        k.forEach(function (c, i) { rel[c] = { dx: (i % 2 ? 1 : -1) * half, row: Math.floor(i / 2) }; });
        var levels = Math.max(1, Math.ceil(rows * ROWH / LH));
        for (var d = 1; d <= levels; d++) { L[d] = -(CW + SPINE / 2); R[d] = CW + SPINE / 2; }
        return { l: L, r: R };
      }
      var p = pack(k.map(function (c) { return lay(c, depth + 1); }), HG);
      var mid = (p.offs[0] + p.offs[p.offs.length - 1]) / 2;
      k.forEach(function (c, i) { rel[c] = { dx: p.offs[i] - mid }; });
      for (var d4 = 0; d4 < p.l.length; d4++) { L.push(p.l[d4] - mid); R.push(p.r[d4] - mid); }
      return { l: L, r: R };
    }
    var top = pack(st.chartRoots.map(function (r) { return lay(r, 0); }), ROOTGAP);
    var pos = {}, count = 0;
    function place(e, x, y) {
      pos[e] = { x: x, y: y };
      count++;
      var k = visKids(e);
      if (stack[e]) k.forEach(function (c) { place(c, x + rel[c].dx, y + LH + rel[c].row * ROWH); });
      else k.forEach(function (c) { place(c, x + rel[c].dx, y + LH); });
    }
    st.chartRoots.forEach(function (r, i) { place(r, top.offs[i], 0); });
    var minX = Infinity, maxX = -Infinity, maxY = 0;
    Object.keys(pos).forEach(function (e) {
      var p = pos[e];
      minX = Math.min(minX, p.x - CW / 2); maxX = Math.max(maxX, p.x + CW / 2); maxY = Math.max(maxY, p.y + CH);
    });
    Object.keys(pos).forEach(function (e) { pos[e].x += PAD - minX; pos[e].y += PAD; });
    st.lay = { pos: pos, stack: stack, w: maxX - minX + PAD * 2, h: maxY + PAD * 2, count: count };
    st.win = null;
  }

  /* ── SVG drawing ──────────────────────────────────────────────────────── */
  function linePath(p, c, stacked) {
    var px = p.x, py = p.y + CH, cx = c.x, cy = c.y, r;
    if (stacked) {
      var my = c.y + CH / 2, dir = cx < px ? -1 : 1, ex = cx - dir * CW / 2;
      r = Math.min(10, Math.abs(ex - px));
      return 'M' + px + ',' + py + 'V' + (my - r) + 'Q' + px + ',' + my + ' ' + (px + dir * r) + ',' + my + 'H' + ex;
    }
    if (Math.abs(cx - px) < 1) return 'M' + px + ',' + py + 'V' + cy;
    var mid = py + VG / 2, d = cx > px ? 1 : -1;
    r = Math.min(10, Math.abs(cx - px) / 2);
    return 'M' + px + ',' + py + 'V' + (mid - r) + 'Q' + px + ',' + mid + ' ' + (px + d * r) + ',' + mid + 'H' + (cx - d * r) +
      'Q' + cx + ',' + mid + ' ' + cx + ',' + (mid + r) + 'V' + cy;
  }
  function projGeom(a, b, k) {
    var off = ((k % 3) - 1) * 14, sx, sy, ex, ey, c1x, c1y, c2x, c2y, dy;
    if (b.y > a.y + CH) {
      sx = a.x + CW / 4 + off; sy = a.y + CH; ex = b.x + CW / 4; ey = b.y;
      dy = Math.max(50, (ey - sy) / 2); c1x = sx; c1y = sy + dy; c2x = ex; c2y = ey - dy;
    } else if (a.y > b.y + CH) {
      sx = a.x + CW / 4 + off; sy = a.y; ex = b.x + CW / 4; ey = b.y + CH;
      dy = Math.max(50, (sy - ey) / 2); c1x = sx; c1y = sy - dy; c2x = ex; c2y = ey + dy;
    } else {
      var dir = b.x >= a.x ? 1 : -1;
      sx = a.x + dir * CW / 2; sy = a.y + CH / 2 + off / 2; ex = b.x - dir * CW / 2; ey = b.y + CH / 2;
      var bend = Math.min(160, 40 + Math.abs(ex - sx) / 4);
      c1x = sx + dir * 40; c1y = Math.min(sy, ey) - bend; c2x = ex - dir * 40; c2y = c1y;
    }
    return {
      d: 'M' + sx + ',' + sy + 'C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + ex + ',' + ey,
      mx: (sx + 3 * c1x + 3 * c2x + ex) / 8, my: (sy + 3 * c1y + 3 * c2y + ey) / 8, ex: ex, ey: ey,
      box: [Math.min(sx, c1x, c2x, ex), Math.min(sy, c1y, c2y, ey), Math.max(sx, c1x, c2x, ex), Math.max(sy, c1y, c2y, ey)]
    };
  }
  function hits(win, x1, y1, x2, y2) { return !win || (x2 >= win[0] && x1 <= win[2] && y2 >= win[1] && y1 <= win[3]); }
  function nodeIn(win, p) { return hits(win, p.x - CW / 2, p.y, p.x + CW / 2, p.y + CH); }
  function edgeLabel(e) {
    return String(e.project || 'Project') + (e.pct != null ? ' · ' + e.pct + '%' : '');
  }

  function nodeSvg(e, P, lod, exp) {
    var n = st.by[e], p = st.lay.pos[e];
    var me = st.data && e === st.data.me, sel = !exp && st.sel === e, on = !exp && st.path[e], hit = !exp && st.hit === e;
    var stroke = (sel || on || hit || me) ? P.accent : P.border, sw = sel ? 2.5 : (on || hit) ? 2 : 1.2;
    var label = n.name + (n.title ? ', ' + n.title : '') + (n.department ? ', ' + n.department : '');
    var h = '<g class="oc-node' + (hit ? ' oc-hit' : '') + '" data-oc-card="' + esc(e) + '" transform="translate(' + (p.x - CW / 2) + ',' + p.y + ')"' +
      (exp ? '' : ' tabindex="0" role="button" aria-label="' + esc(label) + '"') + '><title>' + esc(label) + '</title>';
    if (sel) h += '<rect x="-5" y="-5" width="' + (CW + 10) + '" height="' + (CH + 10) + '" rx="16" style="fill:none;stroke:' + P.accent + ';stroke-opacity:.35;stroke-width:5"/>';
    h += '<rect class="oc-cbg" width="' + CW + '" height="' + CH + '" rx="12" style="fill:' + P.card + ';stroke:' + stroke + ';stroke-width:' + sw + '"/>';
    var hu = hue(e), photo = st.photos[e];
    h += '<circle cx="32" cy="36" r="21" style="fill:hsl(' + hu + ',55%,46%)"/>';
    if (photo) h += '<image href="' + esc(photo) + '" x="11" y="15" width="42" height="42" clip-path="url(#oc-avclip)" preserveAspectRatio="xMidYMid slice"/>';
    else h += '<text x="32" y="41" text-anchor="middle" style="fill:#fff;font-size:13px;font-weight:700">' + esc(n.initials || '?') + '</text>';
    if (n.managerIssue) h += '<circle cx="14" cy="14" r="8" style="fill:' + P.warn + '"/><text x="14" y="18" text-anchor="middle" style="fill:#111;font-size:11px;font-weight:800">!</text>';
    if (lod) return h + '</g>';
    var tw = CW - 62 - (me ? 34 : 10);
    h += '<text x="62" y="30" style="fill:' + P.text + ';font-size:13px;font-weight:700">' + esc(fitText(n.name, 13, 700, tw)) + '</text>';
    h += '<text x="62" y="47" style="fill:' + P.text2 + ';font-size:11.5px">' + esc(fitText(n.title || '', 11.5, 400, CW - 70)) + '</text>';
    h += '<text x="62" y="62" style="fill:' + P.text3 + ';font-size:11px">' + esc(fitText(n.department || '', 11, 400, CW - 70)) + '</text>';
    if (me) h += '<rect x="' + (CW - 40) + '" y="8" width="32" height="16" rx="8" style="fill:' + P.accent + '"/><text x="' + (CW - 24) + '" y="20" text-anchor="middle" style="fill:#fff;font-size:10px;font-weight:700">You</text>';
    var ch = st.kids[e] || [];
    if (ch.length) {
      var open = !!st.open[e];
      var t = ch.length + (ch.length === 1 ? ' report ' : ' reports ') + (open ? '▴' : '▾');
      var w = Math.ceil(measure(t, 11, 600)) + 18;
      h += '<g class="oc-tg"' + (exp ? '' : ' data-oc-toggle="' + esc(e) + '" role="button" tabindex="0" aria-expanded="' + open + '" aria-label="' + esc((open ? 'Collapse ' : 'Expand ') + n.name + '’s ' + ch.length + ' reports') + '"') + '>' +
        '<rect x="10" y="70" width="' + w + '" height="19" rx="9.5" style="fill:' + P.bg3 + ';stroke:' + P.border + '"/>' +
        '<text x="' + (10 + w / 2) + '" y="83" text-anchor="middle" style="fill:' + P.text2 + ';font-size:11px;font-weight:600">' + esc(t) + '</text></g>';
    } else {
      h += '<text x="12" y="84" style="fill:' + P.text3 + ';font-size:11px">No reports</text>';
    }
    if (st.showProj && (n.projectReportsCount || n.projectLeadsCount)) {
      var bits = [];
      if (n.projectReportsCount) bits.push('leads ' + n.projectReportsCount);
      if (n.projectLeadsCount) bits.push(n.projectLeadsCount + (n.projectLeadsCount === 1 ? ' project' : ' projects'));
      var pt = bits.join(' · '), pw = Math.ceil(measure(pt, 10.5, 600)) + 14;
      h += '<g><title>' + esc((n.projectReportsCount ? 'Project lead of ' + n.projectReportsCount + ' ' : '') + (n.projectLeadsCount ? 'On ' + n.projectLeadsCount + ' project line(s)' : '')) + '</title>' +
        '<rect x="' + (CW - 10 - pw) + '" y="70" width="' + pw + '" height="19" rx="9.5" style="fill:none;stroke:' + P.accent + ';stroke-dasharray:3 3"/>' +
        '<text x="' + (CW - 10 - pw / 2) + '" y="83" text-anchor="middle" style="fill:' + P.accent + ';font-size:10.5px;font-weight:600">' + esc(pt) + '</text></g>';
    }
    return h + '</g>';
  }

  /** Draw the laid-out chart: {lines, projs, nodes, labels} SVG strings. */
  function draw(P, win, lod, exp) {
    var L = st.lay, pos = L.pos, lines = '', onPath = '', projs = '', nodes = '', labels = '';
    Object.keys(pos).forEach(function (e) {
      var k = visKids(e);
      if (!k.length) return;
      var p = pos[e];
      k.forEach(function (c) {
        var cp = pos[c];
        if (!hits(win, Math.min(p.x, cp.x) - CW / 2, p.y, Math.max(p.x, cp.x) + CW / 2, cp.y + CH)) return;
        var hl = !exp && st.path[e] && st.path[c];
        var path = '<path d="' + linePath(p, cp, L.stack[e]) + '" style="fill:none;stroke:' + (hl ? P.accent : P.line) + ';stroke-width:' + (hl ? 2.6 : 1.6) + '"/>';
        if (hl) onPath += path; else lines += path;
      });
    });
    if (st.showProj) {
      var selHas = !exp && st.sel && ((st.pTo[st.sel] || []).length || (st.pFrom[st.sel] || []).length);
      var nth = {};
      st.pedges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        var k = nth[e.from] = (nth[e.from] || 0) + 1;
        var g = projGeom(a, b, k);
        if (!hits(win, g.box[0], g.box[1], g.box[2], g.box[3])) return;
        var col = projColor(e.project), mine = selHas && (e.from === st.sel || e.to === st.sel);
        var op = selHas && !mine ? 0.28 : 0.9;
        projs += '<g class="oc-pe" data-oc-pe="' + esc(e.from + '|' + e.to + '|' + (e.id || '')) + '">' +
          '<path d="' + g.d + '" style="fill:none;stroke:transparent;stroke-width:12"/>' +
          '<path class="oc-pv" d="' + g.d + '" style="fill:none;stroke:' + col + ';stroke-width:' + (mine ? 2.6 : 1.8) + ';stroke-dasharray:7 5;stroke-opacity:' + op + '"/>' +
          '<circle cx="' + g.ex + '" cy="' + g.ey + '" r="3.5" style="fill:' + col + ';fill-opacity:' + op + '"/></g>';
        if (mine || exp) {
          var t = edgeLabel(e), tw = Math.ceil(measure(t, 11, 600)) + 14;
          labels += '<g><rect x="' + (g.mx - tw / 2) + '" y="' + (g.my - 10) + '" width="' + tw + '" height="20" rx="10" style="fill:' + P.card + ';stroke:' + col + '"/>' +
            '<text x="' + g.mx + '" y="' + (g.my + 4) + '" text-anchor="middle" style="fill:' + P.text + ';font-size:11px;font-weight:600">' + esc(t) + '</text></g>';
        }
      });
    }
    Object.keys(pos).forEach(function (e) { if (nodeIn(win, pos[e])) nodes += nodeSvg(e, P, lod, exp); });
    return { lines: lines + onPath, projs: projs, nodes: nodes, labels: labels };
  }
  var DEFS = '<defs><clipPath id="oc-avclip" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath></defs>';

  function viewRect() {
    var vp = q('#oc-vp');
    if (!vp) return [0, 0, 0, 0];
    return [-st.tx / st.z, -st.ty / st.z, (vp.clientWidth - st.tx) / st.z, (vp.clientHeight - st.ty) / st.z];
  }
  function renderChart() {
    var world = q('#oc-world');
    if (!world) return;
    var empty = q('#oc-cempty');
    if (!st.lay) {
      world.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = st.loading ? 'Loading org chart…' : st.error ? st.error : ('No reporting lines have been set yet.' + (st.loose.length ? ' Everyone is listed under “No manager set” below.' : ''));
        empty.style.color = st.error ? 'var(--danger,#dc2626)' : '';
      }
      return;
    }
    if (empty) empty.hidden = true;
    var win = null;
    if (st.lay.count > CULL_MIN) {
      var v = viewRect(), mw = (v[2] - v[0]) * 0.6, mh = (v[3] - v[1]) * 0.6;
      win = [v[0] - mw, v[1] - mh, v[2] + mw, v[3] + mh];
    }
    st.win = win;
    st.lod = st.z < LOD_Z;
    var d = draw(SCREEN, win, st.lod, false);
    world.innerHTML = '<g>' + d.lines + '</g><g>' + d.projs + '</g><g>' + d.nodes + '</g><g>' + d.labels + '</g>';
    applyXf();
    if (!st.lod) ensurePhotos(win);
  }
  var rerenderQueued = false;
  function queueRender() {
    if (rerenderQueued) return;
    rerenderQueued = true;
    requestAnimationFrame(function () { rerenderQueued = false; if (root && st) renderChart(); });
  }

  /* photos (from the avatar list hrms-avatars.js keeps) */
  var photoQ = 0, photoTimer = null;
  function ensurePhotos(win) {
    var A = window.__hrmsAvatars, ppl = A && A.people ? A.people() : null;
    if (!ppl || !st.lay) return;
    Object.keys(st.lay.pos).forEach(function (e) {
      var p = ppl[e];
      if (!p || st.photos[e] !== undefined || st.photoBusy[e] || photoQ >= 4 || !nodeIn(win, st.lay.pos[e])) return;
      st.photoBusy[e] = 1; photoQ++;
      var src = p.url || ('/api/avatars/' + encodeURIComponent(e) + '?v=' + encodeURIComponent(p.v));
      fetch(src, p.url ? {} : { headers: { Accept: 'image/*,*/*;q=0.8' } })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) {
          if (!b || !/^image\//.test(b.type || '')) return '';
          return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { res(''); }; fr.readAsDataURL(b); });
        })
        .catch(function () { return ''; })
        .then(function (du) {
          photoQ--;
          if (!st || !root) return;
          st.photos[e] = du || '';
          delete st.photoBusy[e];
          clearTimeout(photoTimer);
          photoTimer = setTimeout(function () { if (root && st) renderChart(); }, 150);
        });
    });
  }

  /* ── page rendering ───────────────────────────────────────────────────── */
  function renderAll() {
    if (!root) return;
    var searchHad = document.activeElement && document.activeElement.id === 'oc-q';
    root.innerHTML =
      '<div class="oc-page">' +
        '<div class="card oc-bar">' +
          '<div class="oc-search"><input id="oc-q" class="input-field" type="search" autocomplete="off" placeholder="Find a person: name, email, title or department" value="' + esc(st.q) + '" aria-label="Search people">' +
          '<div class="oc-dd" id="oc-dd" hidden></div></div>' +
          '<button type="button" class="btn-sm" data-oc="me">Show me</button>' +
          '<span class="oc-grp"><button type="button" class="btn-sm" data-oc="expand">Expand all</button>' +
          '<button type="button" class="btn-sm" data-oc="collapse">Collapse all</button></span>' +
          '<span class="oc-grp"><button type="button" class="btn-sm" data-oc="zout" aria-label="Zoom out">&minus;</button>' +
          '<span class="oc-zl" id="oc-zl">100%</span>' +
          '<button type="button" class="btn-sm" data-oc="zin" aria-label="Zoom in">+</button>' +
          '<button type="button" class="btn-sm" data-oc="fit">Fit</button></span>' +
          '<label class="oc-check"><input type="checkbox" id="oc-proj"' + (st.showProj ? ' checked' : '') + '> Show project lines</label>' +
          '<span class="oc-grp"><button type="button" class="btn-sm" data-oc="export" aria-haspopup="true" aria-expanded="false">Export &#9662;</button>' +
          '<div class="oc-menu" id="oc-menu" hidden><button type="button" data-oc="png">PNG image</button><button type="button" data-oc="svg">SVG (vector)</button></div></span>' +
          '<button type="button" class="btn-sm" data-oc="reload" title="Reload" aria-label="Reload">&#8635;</button>' +
        '</div>' +
        '<div class="oc-body" id="oc-body">' +
          '<div class="card oc-vp" id="oc-vp">' +
            '<svg class="oc-svg" id="oc-svg" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Org chart">' + DEFS + '<g id="oc-world"></g></svg>' +
            '<div class="oc-empty" id="oc-cempty" hidden></div>' +
            '<div class="oc-legend" id="oc-legend"></div>' +
            '<div class="oc-tip" id="oc-tip" hidden></div>' +
          '</div>' +
          '<aside class="card oc-panel" id="oc-panel" hidden></aside>' +
        '</div>' +
        '<div class="card oc-loose" id="oc-loose" hidden></div>' +
        '<div class="oc-hint">Drag to move around, scroll or pinch to zoom. Solid lines are line managers — leave, WFH and timesheet requests go to them. Dashed lines are project / scrum leads (no approvals).</div>' +
      '</div>';
    renderChart();
    renderLegend();
    renderLoose();
    renderPanel();
    if (!st.placed && st.lay) {
      st.placed = true;
      requestAnimationFrame(function () { initialView(); });
    }
    if (searchHad) { var i = q('#oc-q'); if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} } }
  }
  function initialView() {
    var vp = q('#oc-vp');
    if (!vp || !st.lay) return;
    var zf = Math.min(1, vp.clientWidth / st.lay.w, vp.clientHeight / st.lay.h);
    if (zf >= 0.6) { fit(false); return; }
    var mine = st.data && st.data.me;
    if (mine && st.lay.pos[mine]) centerOn(mine, false, 0.85, false);
    else centerOn(st.chartRoots[0], false, 0.85, true);
  }
  function renderLegend() {
    var lg = q('#oc-legend');
    if (!lg) return;
    if (!st.lay) { lg.hidden = true; return; }
    lg.hidden = false;
    var h = '<span class="oc-lg">' + lineSample(false) + 'Line manager</span>';
    if (st.showProj && st.pedges.length) {
      h += '<span class="oc-lg">' + lineSample(true, 'var(--accent)') + 'Project / scrum lead</span>';
      st.projList.slice(0, 8).forEach(function (p) { h += '<span class="oc-lg"><i style="background:' + projColor(p) + '"></i>' + esc(p) + '</span>'; });
      if (st.projList.length > 8) h += '<span class="oc-lg">+' + (st.projList.length - 8) + ' more</span>';
    } else if (!st.showProj && st.pedges.length) {
      h += '<span class="oc-lg" style="color:var(--text3)">Project lines hidden</span>';
    }
    lg.innerHTML = h;
  }
  function renderLoose() {
    var box = q('#oc-loose');
    if (!box) return;
    var page = box.closest ? box.closest('.oc-page') : null;
    if (st.loading || st.error || !st.loose.length) { box.hidden = true; if (page) page.classList.remove('oc-has-loose'); return; }
    box.hidden = false;
    if (page) page.classList.add('oc-has-loose');
    box.innerHTML = '<div class="oc-sh">No manager set (' + st.loose.length + ')</div>' +
      '<div class="oc-hint">Not in the tree yet: open a person and use “Change manager” to place them under their manager.</div><div class="oc-chips">' +
      st.loose.map(function (e) {
        var n = st.by[e];
        return '<button type="button" class="oc-chip' + (st.sel === e ? ' oc-sel' : '') + (st.hit === e ? ' oc-hit' : '') +
          '" data-oc-chip="' + esc(e) + '" title="' + esc(n.managerIssue || 'No manager linked') + '">' + avatar(n, 'sm') +
          '<span class="oc-cn">' + esc(n.name) + '</span>' + (n.managerIssue ? '<span class="oc-cw">!</span>' : '') + '</button>';
      }).join('') + '</div>';
    paintPresence();
  }

  /* ── side panel ───────────────────────────────────────────────────────── */
  function statusBadge(s) {
    return s && s !== 'active' ? '<span class="oc-st">' + esc(s === 'scheduled' ? 'starts later' : s) + '</span>' : '';
  }
  function leadLines(n) {
    var det = st.detail[n.email], d = det && det.data;
    if (d) return d.lines.map(function (l) { return { id: l.id, lead: l.leadEmail, project: l.project || l.kindLabel, pct: l.allocationPct, status: l.status, start: l.startDate, end: l.endDate }; });
    return (st.pTo[n.email] || []).map(function (e) { return { id: e.id, lead: e.from, project: e.project, pct: e.pct, status: 'active' }; });
  }
  function projectReports(n) {
    var det = st.detail[n.email], d = det && det.data;
    if (d && d.projectReports) return d.projectReports.map(function (l) { return { id: l.id, email: l.email, project: l.project || l.kindLabel, pct: l.allocationPct, status: l.status }; });
    return (st.pFrom[n.email] || []).map(function (e) { return { id: e.id, email: e.to, project: e.project, pct: e.pct, status: 'active' }; });
  }
  function splitHtml(n, lines) {
    var det = st.detail[n.email], a = det && det.data && det.data.allocation;
    if (!a) {
      var known = lines.filter(function (l) { return l.status === 'active' && l.pct != null; });
      if (!known.length) return '';
      var by = {}, order = [];
      known.forEach(function (l) { var k = String(l.project).toLowerCase(); if (!by[k]) { by[k] = { project: l.project, pct: 0 }; order.push(k); } by[k].pct += l.pct; });
      var projs = order.map(function (k) { return by[k]; }), tot = Math.min(100, projs.reduce(function (s, p) { return s + p.pct; }, 0));
      a = { projects: projs, projectPct: tot, lineTeamPct: 100 - tot, label: projs.filter(function (p) { return p.pct; }).map(function (p) { return p.pct + '% ' + p.project; }).concat(100 - tot ? [(100 - tot) + '% line team'] : []).join(', ') };
    }
    if (!a.projects.length) return '';
    var h = '<div class="oc-split" role="img" aria-label="' + esc(a.label) + '">';
    a.projects.forEach(function (p) { if (p.pct) h += '<i style="width:' + p.pct + '%;background:' + projColor(p.project) + '" title="' + esc(p.pct + '% ' + p.project) + '"></i>'; });
    if (a.lineTeamPct) h += '<i style="width:' + a.lineTeamPct + '%;background:var(--text3);opacity:.45" title="' + esc(a.lineTeamPct + '% line team') + '"></i>';
    return h + '</div><div class="oc-muted">' + esc(a.label) + '</div>';
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
    var leads = leadLines(n), preps = projectReports(n);
    var canLines = d.canEditLines && n.email !== d.me;
    var h = '<button type="button" class="oc-x" data-oc="close" aria-label="Close">&times;</button>' +
      '<div class="oc-ph">' + avatar(n, 'lg') + '<div style="min-width:0"><div class="oc-nm">' + esc(n.name) + '</div>' +
      '<div class="oc-ti">' + esc(n.title || '') + '</div><div class="oc-dp">' + esc(n.department || '') + '</div></div></div>' +
      '<div class="oc-sec"><dl class="oc-kv">' +
        '<dt>Email</dt><dd><a class="oc-link" href="mailto:' + esc(n.email) + '">' + esc(n.email) + '</a></dd>' +
        (n.employeeId ? '<dt>Employee ID</dt><dd>' + esc(n.employeeId) + '</dd>' : '') +
        '<dt>Reports</dt><dd>' + reports.length + ' direct' + (reports.length ? ', ' + Object.keys(descendants(n.email)).length + ' in total' : '') +
          (preps.length ? ' · ' + preps.length + ' on projects' : '') + '</dd>' +
      '</dl></div>';

    h += '<div class="oc-sec"><div class="oc-sh">' + lineSample(false) + 'Line manager</div>';
    if (mgr) h += personBtn(mgr, 'data-oc-go="' + esc(mgr.email) + '"');
    else if (n.managerEmail && n.managerEmail !== n.email) h += '<div class="oc-note oc-bad">Linked to <b>' + esc(n.managerEmail) + '</b>. ' + esc(n.managerIssue || '') + '</div>';
    else h += '<div class="oc-muted">No manager set.</div>';
    h += '</div>';

    h += '<div class="oc-sec"><div class="oc-sh">Approvals</div>';
    if (apprNode) h += '<div class="oc-note">Leave, WFH and timesheet requests go to <b>' + esc(apprNode.name) + '</b>' + (apprNode.title ? ' (' + esc(apprNode.title) + ')' : '') + '.' + (leads.length ? ' Project leads do not approve requests.' : '') + '</div>';
    else if (appr) h += '<div class="oc-note oc-bad">Leave, WFH and timesheet requests go to <b>' + esc(appr) + '</b>, who is not an active employee. Set a new manager so they are not stuck.</div>';
    else h += '<div class="oc-note">No manager is linked, so leave, WFH and timesheet requests are decided by HR.</div>';
    h += '</div>';

    h += '<div class="oc-sec"><div class="oc-sh">' + lineSample(true, 'var(--accent)') + 'Project / scrum leads (' + leads.length + ')</div>';
    if (leads.length) {
      h += leads.map(function (l) {
        var ln = st.by[l.lead] || { email: l.lead, name: l.lead, initials: '?' };
        var sub = '<span class="oc-pj"><i style="background:' + projColor(l.project) + '"></i>' + esc(l.project || '') + (l.pct != null ? ' · ' + l.pct + '%' : '') + '</span>' + statusBadge(l.status) +
          (l.status === 'scheduled' && l.start ? ' <span class="oc-muted">from ' + esc(l.start) + '</span>' : '') + (l.end && l.status === 'active' ? ' <span class="oc-muted">until ' + esc(l.end) + '</span>' : '');
        return '<div class="oc-lrow">' + personBtn(ln, 'data-oc-go="' + esc(l.lead) + '"', '', sub) +
          (canLines && l.id ? '<button type="button" class="oc-rm" data-oc-rmline="' + esc(l.id) + '" title="End this project line" aria-label="End the line to ' + esc(ln.name) + '">&times;</button>' : '') + '</div>';
      }).join('');
      h += splitHtml(n, leads);
    } else h += '<div class="oc-muted">None — all of their time is with the line team.</div>';
    h += '</div>';

    h += '<div class="oc-sec"><div class="oc-sh">Direct reports (' + reports.length + ')</div>';
    h += reports.length ? reports.map(function (e) { return personBtn(st.by[e], 'data-oc-go="' + esc(e) + '"'); }).join('') : '<div class="oc-muted">None.</div>';
    h += '</div>';

    if (preps.length) {
      h += '<div class="oc-sec"><div class="oc-sh">Project reports (' + preps.length + ')</div>';
      h += preps.map(function (l) {
        var rn = st.by[l.email] || { email: l.email, name: l.email, initials: '?' };
        var sub = '<span class="oc-pj"><i style="background:' + projColor(l.project) + '"></i>' + esc(l.project || '') + (l.pct != null ? ' · ' + l.pct + '%' : '') + '</span>' + statusBadge(l.status);
        return '<div class="oc-lrow">' + personBtn(rn, 'data-oc-go="' + esc(l.email) + '"', '', sub) +
          (d.canEditLines && l.email !== d.me && l.id ? '<button type="button" class="oc-rm" data-oc-rmline="' + esc(l.id) + '" title="End this project line" aria-label="End the line from ' + esc(rn.name) + '">&times;</button>' : '') + '</div>';
      }).join('');
      h += '</div>';
    }

    h += '<div class="oc-acts">';
    if (d.canViewProfiles || n.email === d.me) h += '<a class="btn-sm" href="' + esc(profileHref(n)) + '" data-oc-profile="' + esc(n.email) + '" style="text-decoration:none">' + (n.email === d.me ? 'Open my profile' : 'Open profile') + '</a>';
    if (d.canEdit && n.email !== d.me && !st.edit) h += '<button type="button" class="btn-primary btn-sm" data-oc="edit" style="padding:6px 12px;font-size:12px">Change manager</button>';
    if (canLines && !st.add) h += '<button type="button" class="btn-sm" data-oc="addline">+ Project lead</button>';
    h += '</div>';
    if ((d.canEdit || d.canEditLines) && n.email === d.me) h += '<div class="oc-muted" style="margin-top:8px">Your own reporting lines are changed by another HR administrator.</div>';

    if (st.edit && d.canEdit) {
      h += '<div class="oc-sec"><div class="oc-sh">Change manager</div>' +
        '<input id="oc-pq" class="input-field" type="search" autocomplete="off" placeholder="Type a name to find the new manager" value="' + esc(st.pickQ) + '">' +
        '<div class="oc-pick" id="oc-pick"></div>' +
        '<div class="oc-muted" id="oc-pickd" style="margin-top:8px"></div>' +
        (st.editErr ? '<div class="oc-err">' + esc(st.editErr) + '</div>' : '') +
        '<div class="oc-acts"><button type="button" class="btn-primary btn-sm" data-oc="save" style="padding:6px 12px;font-size:12px"' + (st.saving ? ' disabled' : '') + '>' + (st.saving ? 'Saving…' : 'Save') + '</button>' +
        '<button type="button" class="btn-sm" data-oc="cancel">Cancel</button></div>' +
        '<div class="oc-muted" style="margin-top:8px">Requests already pending with the current manager stay with them; new requests go to the new manager.</div></div>';
    }
    if (st.add && canLines) {
      var a = st.add;
      h += '<div class="oc-sec"><div class="oc-sh">Add project / scrum lead</div>' +
        '<input id="oc-lq" class="input-field" type="search" autocomplete="off" placeholder="Type a name to find the lead" value="' + esc(a.leadQ) + '" aria-label="Find the lead">' +
        '<div class="oc-pick" id="oc-lpick" style="max-height:170px"></div>' +
        '<div class="oc-form">' +
          '<div class="oc-full"><label for="oc-lp">Project</label><input id="oc-lp" class="input-field" list="oc-projlist" maxlength="160" value="' + esc(a.project) + '" placeholder="e.g. Project Alpha">' +
            '<datalist id="oc-projlist">' + st.projList.map(function (p) { return '<option value="' + esc(p) + '">'; }).join('') + '</datalist></div>' +
          '<div><label for="oc-lk">Kind</label><select id="oc-lk" class="input-field">' +
            [['project', 'Project / scrum'], ['dotted', 'Dotted line'], ['functional', 'Functional']].map(function (k) { return '<option value="' + k[0] + '"' + (a.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select></div>' +
          '<div><label for="oc-lpct">Time on it (%)</label><input id="oc-lpct" class="input-field" type="number" min="0" max="100" step="5" value="' + esc(a.pct) + '"></div>' +
          '<div><label for="oc-ls">Start</label><input id="oc-ls" class="input-field" type="date" value="' + esc(a.start) + '"></div>' +
          '<div><label for="oc-le">End</label><input id="oc-le" class="input-field" type="date" value="' + esc(a.end) + '"></div>' +
        '</div>' +
        (a.err ? '<div class="oc-err">' + esc(a.err) + '</div>' : '') +
        '<div class="oc-acts"><button type="button" class="btn-primary btn-sm" data-oc="saveline" style="padding:6px 12px;font-size:12px"' + (a.saving ? ' disabled' : '') + '>' + (a.saving ? 'Saving…' : 'Add line') + '</button>' +
        '<button type="button" class="btn-sm" data-oc="cancelline">Cancel</button></div>' +
        '<div class="oc-muted" style="margin-top:8px">A project lead sees this person in My Team (presence, calendar, workload) but does not approve their requests. Project time across lines cannot exceed 100%.</div></div>';
    }
    p.innerHTML = h;
    if (st.edit) renderPick();
    if (st.add) renderLeadPick();
    paintPresence();
  }

  function peopleFilter(term, bad) {
    term = String(term || '').trim().toLowerCase();
    return Object.keys(st.by).filter(function (e) {
      if (bad[e]) return false;
      if (!term) return true;
      var p = st.by[e];
      return (p.name + ' ' + p.email + ' ' + (p.title || '') + ' ' + (p.department || '')).toLowerCase().indexOf(term) !== -1;
    }).sort(byName).slice(0, 40);
  }
  function renderPick() {
    var box = q('#oc-pick'), desc = q('#oc-pickd');
    if (!box) return;
    var n = st.by[st.sel];
    var cur = st.pick === null ? (n.managerEmail || '') : st.pick;
    var bad = descendants(n.email); bad[n.email] = 1;
    var list = peopleFilter(st.pickQ, bad);
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
  function renderLeadPick() {
    var box = q('#oc-lpick');
    if (!box || !st.add) return;
    var bad = {}; bad[st.sel] = 1;
    var list = peopleFilter(st.add.leadQ, bad);
    box.innerHTML = list.map(function (e) { return personBtn(st.by[e], 'data-oc-lead="' + esc(e) + '"', e === st.add.lead ? ' oc-on' : ''); }).join('') ||
      '<div class="oc-dd-empty">No matching people.</div>';
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
  function setSel(email) {
    st.sel = email; st.edit = false; st.pick = null; st.pickQ = ''; st.editErr = ''; st.add = null;
    computePath();
    if (email) loadDetail(email);
  }
  function reveal(email, select) {
    if (!st.by[email]) return;
    ancestors(email).forEach(function (a) { st.open[a] = true; });
    if (select) setSel(email);
    st.hit = email;
    relayout(); renderChart(); renderLoose(); renderPanel();
    if (inChart(email)) requestAnimationFrame(function () { centerOn(email, true, 0.7, false); });
    else {
      var chip = root && root.querySelector('[data-oc-chip="' + cssq(email) + '"]');
      if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    var who = email;
    setTimeout(function () {
      if (st && st.hit === who) {
        st.hit = '';
        var el = root && root.querySelector('.oc-node.oc-hit');
        if (el) el.classList.remove('oc-hit');
        var ch = root && root.querySelector('.oc-chip.oc-hit');
        if (ch) ch.classList.remove('oc-hit');
      }
    }, 3600);
  }
  function select(email) {
    setSel(email);
    renderChart();
    var chips = root.querySelectorAll('.oc-chip.oc-sel');
    Array.prototype.forEach.call(chips, function (c) { c.classList.remove('oc-sel'); });
    if (email) { var mine = root.querySelector('[data-oc-chip="' + cssq(email) + '"]'); if (mine) mine.classList.add('oc-sel'); }
    renderPanel();
    var p = q('#oc-panel');                  // stacked layout: bring the panel into view
    if (email && p && !p.hidden && window.innerWidth <= 980 && p.scrollIntoView) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ── pan / zoom ───────────────────────────────────────────────────────── */
  function applyXf() {
    var w = q('#oc-world');
    if (!w) return;
    w.setAttribute('transform', 'translate(' + st.tx.toFixed(1) + ',' + st.ty.toFixed(1) + ') scale(' + st.z.toFixed(4) + ')');
    var zl = q('#oc-zl');
    if (zl) zl.textContent = Math.round(st.z * 100) + '%';
    var v = viewRect();
    if ((st.win && !(v[0] >= st.win[0] && v[1] >= st.win[1] && v[2] <= st.win[2] && v[3] <= st.win[3])) || (st.lay && (st.z < LOD_Z) !== st.lod)) queueRender();
  }
  function animateTo(z, tx, ty, anim) {
    var id = ++st.tween;
    if (!anim) { st.z = z; st.tx = tx; st.ty = ty; applyXf(); return; }
    var z0 = st.z, x0 = st.tx, y0 = st.ty, t0 = performance.now(), D = 280;
    function step(now) {
      if (!st || id !== st.tween) return;
      var t = Math.min(1, (now - t0) / D), k = 1 - Math.pow(1 - t, 3);
      st.z = z0 + (z - z0) * k; st.tx = x0 + (tx - x0) * k; st.ty = y0 + (ty - y0) * k;
      applyXf();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function zoomAt(nz, cx, cy, anim) {
    nz = Math.max(MINZ, Math.min(MAXZ, nz));
    var vp = q('#oc-vp');
    if (!vp) return;
    if (cx == null) { cx = vp.clientWidth / 2; cy = vp.clientHeight / 2; }
    animateTo(nz, cx - (cx - st.tx) * (nz / st.z), cy - (cy - st.ty) * (nz / st.z), anim);
  }
  function fit(anim) {
    var vp = q('#oc-vp');
    if (!vp || !st.lay) return;
    var w = st.lay.w, h = st.lay.h;
    var z = Math.max(MINZ, Math.min(1, vp.clientWidth / w, vp.clientHeight / h));
    animateTo(z, (vp.clientWidth - w * z) / 2, Math.max(0, (vp.clientHeight - h * z) / 2), anim !== false);
  }
  function centerOn(email, anim, minZ, top) {
    var vp = q('#oc-vp'), p = st.lay && st.lay.pos[email];
    if (!vp || !p) return;
    var z = Math.max(st.z, minZ || 0);
    z = Math.min(MAXZ, z);
    var tx = vp.clientWidth / 2 - p.x * z;
    var ty = top ? 24 - (p.y - 10) * z : vp.clientHeight / 2 - (p.y + CH / 2) * z;
    animateTo(z, tx, ty, anim);
  }

  var drag = null, justDragged = false, ptrs = {}, pinch = null;
  function nPtrs() { return Object.keys(ptrs).length; }
  function onDown(e) {
    var vp = q('#oc-vp');
    if (!vp || !vp.contains(e.target)) return;
    if (e.target.closest('button, a, input, select, .oc-legend, [data-oc-toggle]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (nPtrs() === 2) {
      var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]], r = vp.getBoundingClientRect();
      var cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: st.z, wx: (cx - st.tx) / st.z, wy: (cy - st.ty) / st.z };
      drag = null;
      return;
    }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false };
  }
  function onMove(e) {
    if (ptrs[e.pointerId]) ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    var vp = q('#oc-vp');
    if (pinch && nPtrs() >= 2 && vp) {
      var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]], r = vp.getBoundingClientRect();
      var cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      var z = Math.max(MINZ, Math.min(MAXZ, pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
      st.tween++;
      st.z = z; st.tx = cx - pinch.wx * z; st.ty = cy - pinch.wy * z;
      applyXf();
      justDragged = true;
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      hideTip();
      if (vp) { vp.classList.add('oc-drag'); try { vp.setPointerCapture(e.pointerId); } catch (_) {} }
    }
    st.tween++;
    st.tx = drag.tx + dx; st.ty = drag.ty + dy;
    applyXf();
  }
  function onUp(e) {
    if (e && ptrs[e.pointerId]) delete ptrs[e.pointerId];
    if (pinch && nPtrs() < 2) { pinch = null; setTimeout(function () { justDragged = false; }, 0); }
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var vp = q('#oc-vp');
    if (vp) vp.classList.remove('oc-drag');
    if (drag.moved) { justDragged = true; setTimeout(function () { justDragged = false; }, 0); }
    drag = null;
  }
  function onWheel(e) {
    var vp = q('#oc-vp');
    if (!vp || !vp.contains(e.target) || !st.lay) return;
    e.preventDefault();
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    var r = vp.getBoundingClientRect();
    var f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(st.z * Math.max(0.5, Math.min(2, f)), e.clientX - r.left, e.clientY - r.top, false);
  }

  /* project-edge tooltip */
  function hideTip() { var t = q('#oc-tip'); if (t) t.hidden = true; }
  function onOver(e) {
    var g = e.target.closest && e.target.closest('[data-oc-pe]');
    var tip = q('#oc-tip'), vp = q('#oc-vp');
    if (!tip || !vp) return;
    if (!g || drag && drag.moved) { hideTip(); return; }
    var parts = g.getAttribute('data-oc-pe').split('|');
    var ed = (st.pFrom[parts[0]] || []).filter(function (x) { return x.to === parts[1]; })[0];
    if (!ed) return;
    var a = st.by[ed.from], b = st.by[ed.to];
    tip.innerHTML = '<b>' + esc(b.name) + '</b> → ' + esc(a.name) + '<br>' +
      '<span class="oc-pj"><i style="background:' + projColor(ed.project) + '"></i>' + esc(ed.project) + '</span>' +
      (ed.pct != null ? ' · <b>' + ed.pct + '%</b> of their time' : '') +
      (ed.lineKind && ed.lineKind !== 'project' ? '<br><span class="oc-muted">' + esc(ed.lineKind) + ' line</span>' : '');
    var r = vp.getBoundingClientRect();
    tip.hidden = false;
    var x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    tip.style.left = Math.min(x, r.width - tip.offsetWidth - 6) + 'px';
    tip.style.top = Math.min(y, r.height - tip.offsetHeight - 6) + 'px';
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  function resolvedPalette() {
    var el = q('.oc-page') || document.documentElement, cs = getComputedStyle(el);
    function v(name, fb) { var x = (cs.getPropertyValue(name) || '').trim(); return x || fb; }
    var text3 = v('--text3', '#94a3b8');
    return {
      bg: v('--bg', '#0f172a'), card: v('--bg2', '#1e293b'), bg3: v('--bg3', '#334155'),
      text: v('--text', '#f1f5f9'), text2: v('--text2', '#cbd5e1'), text3: text3,
      accent: v('--accent', '#4f8ef7'), warn: v('--warn', '#f59e0b'), border: text3, line: text3
    };
  }
  function exportSvg() {
    var P = resolvedPalette(), L = st.lay, d = draw(P, null, false, true);
    var lgH = 34, x = PAD, items = '';
    function item(svg, label) {
      items += '<g transform="translate(' + x + ',' + (L.h + 10) + ')">' + svg + '<text x="32" y="12" style="fill:' + P.text2 + ';font-size:12px">' + esc(label) + '</text></g>';
      x += 44 + measure(label, 12, 400);
    }
    item('<line x1="0" y1="8" x2="26" y2="8" style="stroke:' + P.line + ';stroke-width:2"/>', 'Line manager');
    if (st.showProj && st.pedges.length) {
      item('<line x1="0" y1="8" x2="26" y2="8" style="stroke:' + P.accent + ';stroke-width:2;stroke-dasharray:5 4"/>', 'Project / scrum lead');
      st.projList.forEach(function (p) { item('<rect x="8" y="2" width="12" height="12" rx="3" style="fill:' + projColor(p) + '"/>', p); });
    }
    var W = Math.max(L.w, x + PAD), H = L.h + lgH;
    return { w: W, h: H, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.ceil(W) + '" height="' + Math.ceil(H) + '" viewBox="0 0 ' + Math.ceil(W) + ' ' + Math.ceil(H) + '" style="font-family:' + esc(FONT) + '">' +
      DEFS + '<rect width="100%" height="100%" style="fill:' + P.bg + '"/>' + d.lines + d.projs + d.nodes + d.labels + items + '</svg>' };
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function doExport(kind) {
    if (!st.lay) { toast('Nothing to export yet.', true); return; }
    var ex = exportSvg();
    if (kind === 'svg') { download(new Blob([ex.svg], { type: 'image/svg+xml;charset=utf-8' }), 'org-chart-' + stamp() + '.svg'); return; }
    var url = URL.createObjectURL(new Blob([ex.svg], { type: 'image/svg+xml;charset=utf-8' }));
    var img = new Image();
    img.onload = function () {
      try {
        var s = Math.min(2, 16000 / Math.max(ex.w, ex.h), Math.sqrt(40e6 / (ex.w * ex.h)));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.floor(ex.w * s)); c.height = Math.max(1, Math.floor(ex.h * s));
        var ctx = c.getContext('2d');
        ctx.scale(s, s); ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { if (b) download(b, 'org-chart-' + stamp() + '.png'); else toast('Could not create the image — try SVG.', true); }, 'image/png');
      } catch (err) { URL.revokeObjectURL(url); toast('Could not create the image — try SVG.', true); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Could not create the image — try SVG.', true); };
    img.src = url;
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
  function saveLine() {
    var n = st.by[st.sel], a = st.add;
    if (!n || !a || a.saving) return;
    if (!a.lead) { a.err = 'Choose the lead first.'; renderPanel(); return; }
    a.saving = true; a.err = '';
    renderPanel();
    S.api('/api/org/lines', { method: 'POST', body: {
      email: n.email, leadEmail: a.lead, kind: a.kind, project: a.project, allocationPct: a.pct === '' ? 0 : a.pct,
      startDate: a.start || null, endDate: a.end || null } }).then(function (r) {
      if (!root) return;
      st.add = null;
      toast((r && r.message) || 'Project line added.');
      return load(true).then(function () { if (root && st.sel) { loadDetail(st.sel); renderPanel(); } });
    }).catch(function (e) {
      if (!root || !st.add) return;
      st.add.saving = false; st.add.err = e.message || 'Could not add the line.';
      renderPanel();
    });
  }
  function removeLine(id) {
    if (!window.confirm('End this project line? The history is kept; approvals are not affected.')) return;
    S.api('/api/org/lines/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      if (!root) return;
      toast((r && r.message) || 'Project line ended.');
      return load(true).then(function () { if (root && st.sel) { loadDetail(st.sel); renderPanel(); } });
    }).catch(function (e) { toast(e.message || 'Could not end the line.', true); });
  }
  function toggle(em) {
    var before = st.lay && st.lay.pos[em] ? { x: st.lay.pos[em].x, y: st.lay.pos[em].y } : null;
    st.open[em] = !st.open[em];
    relayout();
    var after = st.lay && st.lay.pos[em];
    if (before && after) { st.tween++; st.tx += (before.x - after.x) * st.z; st.ty += (before.y - after.y) * st.z; }
    renderChart();
  }

  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;
    var res = t.closest('[data-oc-res]');
    if (res) { closeResults(); reveal(res.getAttribute('data-oc-res'), true); return; }
    if (!t.closest('.oc-search')) closeResults();
    var menu = q('#oc-menu');
    if (menu && !menu.hidden && !t.closest('#oc-menu') && !t.closest('[data-oc="export"]')) { menu.hidden = true; }

    var prof = t.closest('[data-oc-profile]');
    if (prof) { e.preventDefault(); e.stopPropagation(); navTo(prof.getAttribute('href')); return; }

    var tg = t.closest('[data-oc-toggle]');
    if (tg) { if (!justDragged) toggle(tg.getAttribute('data-oc-toggle')); return; }
    var cardEl = t.closest('[data-oc-card]');
    if (cardEl) { if (justDragged) return; select(cardEl.getAttribute('data-oc-card')); return; }
    var chip = t.closest('[data-oc-chip]');
    if (chip) { select(chip.getAttribute('data-oc-chip')); return; }
    var rm = t.closest('[data-oc-rmline]');
    if (rm) { removeLine(rm.getAttribute('data-oc-rmline')); return; }
    var go = t.closest('[data-oc-go]');
    if (go) { reveal(go.getAttribute('data-oc-go'), true); return; }
    var pk = t.closest('[data-oc-pick]');
    if (pk) { st.pick = pk.getAttribute('data-oc-pick'); st.editErr = ''; renderPick(); return; }
    var ld = t.closest('[data-oc-lead]');
    if (ld && st.add) { st.add.lead = ld.getAttribute('data-oc-lead'); st.add.err = ''; renderLeadPick(); return; }

    var b = t.closest('[data-oc]');
    if (!b) return;
    var act = b.getAttribute('data-oc');
    if (act === 'me') {
      var me = st.data && st.data.me;
      if (me && st.by[me]) reveal(me, true); else toast('You are not on the org chart yet.', true);
    } else if (act === 'expand') {
      Object.keys(st.kids).forEach(function (k) { st.open[k] = true; });
      relayout(); renderChart();
    } else if (act === 'collapse') {
      st.open = {};
      relayout(); renderChart();
      requestAnimationFrame(function () { if (st.chartRoots[0]) centerOn(st.chartRoots[0], true, 0, true); });
    } else if (act === 'zin') zoomAt(st.z * 1.25, null, null, true);
    else if (act === 'zout') zoomAt(st.z / 1.25, null, null, true);
    else if (act === 'fit') fit(true);
    else if (act === 'reload') load(true);
    else if (act === 'export') { var m = q('#oc-menu'); if (m) { m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden)); } }
    else if (act === 'png' || act === 'svg') { var m2 = q('#oc-menu'); if (m2) m2.hidden = true; doExport(act); }
    else if (act === 'close') select('');
    else if (act === 'edit') { st.edit = true; st.add = null; st.pick = null; st.pickQ = ''; st.editErr = ''; renderPanel(); var pi = q('#oc-pq'); if (pi) pi.focus(); }
    else if (act === 'cancel') { st.edit = false; st.pick = null; st.editErr = ''; renderPanel(); }
    else if (act === 'save') save();
    else if (act === 'addline') { st.edit = false; st.add = { lead: '', leadQ: '', project: '', kind: 'project', pct: '', start: '', end: '', saving: false, err: '' }; renderPanel(); var li = q('#oc-lq'); if (li) li.focus(); }
    else if (act === 'cancelline') { st.add = null; renderPanel(); }
    else if (act === 'saveline') saveLine();
  }
  function onInput(e) {
    var id = e.target.id;
    if (id === 'oc-q') search(e.target.value);
    else if (id === 'oc-pq') { st.pickQ = e.target.value; renderPick(); }
    else if (st.add && id === 'oc-lq') { st.add.leadQ = e.target.value; renderLeadPick(); }
    else if (st.add && id === 'oc-lp') st.add.project = e.target.value;
    else if (st.add && id === 'oc-lpct') st.add.pct = e.target.value;
    else if (st.add && id === 'oc-ls') st.add.start = e.target.value;
    else if (st.add && id === 'oc-le') st.add.end = e.target.value;
    else if (st.add && id === 'oc-lk') st.add.kind = e.target.value;
  }
  function onChange(e) {
    if (e.target.id === 'oc-proj') {
      st.showProj = !!e.target.checked;
      lsSet(LS_PROJ, st.showProj ? '1' : '0');
      renderChart(); renderLegend();
    } else if (e.target.tagName === 'SELECT' || e.target.type === 'date') {
      // Only fields without reliable input events: a text box's change fires on blur
      // (mousedown) and re-rendering its pick list then would swallow the click.
      onInput(e);
    }
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
    if (e.key === 'Enter' || e.key === ' ') {
      var tg = t.getAttribute && t.getAttribute('data-oc-toggle');
      if (tg) { e.preventDefault(); toggle(tg); var again = root.querySelector('[data-oc-toggle="' + cssq(tg) + '"]'); if (again) again.focus(); return; }
      var card = t.getAttribute && t.getAttribute('data-oc-card');
      if (card) { e.preventDefault(); select(card); var el = root.querySelector('[data-oc-card="' + cssq(card) + '"]'); if (el) el.focus(); }
    } else if (e.key === 'Escape' && st.sel && !t.closest('input, select')) select('');
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
    try { FONT = getComputedStyle(document.body).fontFamily || FONT; } catch (_) {}
    listen(root, 'click', onClick);
    listen(root, 'input', onInput);
    listen(root, 'change', onChange);
    listen(root, 'keydown', onKey);
    listen(root, 'focusin', onFocusIn);
    listen(root, 'pointerdown', onDown);
    listen(root, 'pointerover', onOver);
    listen(root, 'pointermove', function (e) { if (e.target.closest && e.target.closest('[data-oc-pe]')) onOver(e); });
    listen(root, 'pointerleave', hideTip);
    listen(window, 'pointermove', onMove);
    listen(window, 'pointerup', onUp);
    listen(window, 'pointercancel', onUp);
    listen(window, 'resize', function () { if (st && st.lay) queueRender(); });
    listen(root, 'wheel', onWheel, { passive: false });
    load(false);
  }
  function unmount() {
    while (cleanup.length) { try { cleanup.pop()(); } catch (_) {} }
    drag = null; pinch = null; ptrs = {};
    if (st) st.token++;
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
