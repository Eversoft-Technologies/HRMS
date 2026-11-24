/**
 * hrms-assets.js  v1
 * IT asset life-cycle — two sidecar pages (hrms-sidecar.js):
 *   /it-assets              register (assets.view / assets.manage): KPIs, inventory,
 *   /it-assets/licenses     licence seats, expiring warranties / licences,
 *   /it-assets/expiring     asset drawer (specs, holder, history, actions),
 *   /it-assets/<id>         assign / return / lost / repair / retire / write-off, CSV.
 *   /my-assets              the signed-in employee's assets: "I received it",
 *                           "Report an issue" (raises an IT help-desk ticket).
 *
 * Backend: hrms_plus/assets_views.py (routes in hrms_plus/urls_assets.py).
 * React-owned DOM is never touched: pages render into the sidecar root, the
 * drawer / modals are our own nodes on <body> and are removed on unmount.
 */
(function () {
  'use strict';
  if (window.__hrmsAssetsLoaded) return;
  window.__hrmsAssetsLoaded = true;

  var STYLE_ID = 'hrms-assets-style';
  var SC = null;
  var st = {
    root: null, token: 0, meta: null, tab: 'inventory', list: [], drawerId: null,
    filters: { q: '', category: '', status: 'active', ownership: '' }, searchTimer: null
  };
  var my = { root: null, token: 0 };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function q(root, sel) { return root ? root.querySelector(sel) : null; }
  function val(root, sel) { var el = q(root, sel); return el ? String(el.value == null ? '' : el.value).trim() : ''; }
  function errMsg(e) { return (e && e.message) || 'Something went wrong.'; }
  function fmtDate(v, time) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: !!time }); } catch (_) {}
    return String(v).slice(0, time ? 16 : 10);
  }
  function money(v, cur) {
    if (v === null || v === undefined || v === '') return '—';
    var C = window.HRMSCompany;
    var code = C && C.get ? String((C.get() || {}).currency || 'INR').toUpperCase() : '';
    if (C && C.money && (!cur || cur === code)) { try { return C.money(v); } catch (_) {} }
    var n = Number(v);
    return (cur ? cur + ' ' : '') + (isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v));
  }
  function setBusy(el, on) { if (el) { el.disabled = !!on; el.classList.toggle('as-busy', !!on); } }
  function flash(box, msg, ok) {
    if (!box) return;
    box.innerHTML = msg ? '<div class="' + (ok ? 'as-ok' : 'as-err') + '">' + esc(msg) + '</div>' : '';
  }
  function canManage() { return !!(st.meta && st.meta.canManage); }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.as-page{max-width:1320px;margin:0 auto;color:var(--text)}',
      '.as-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}',
      '.as-h1{font-size:20px;font-weight:700;margin:0}',
      '.as-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.as-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.as-btn{background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.as-btn:hover{border-color:var(--accent)}',
      '.as-btn.as-ok-b{color:var(--success);border-color:color-mix(in srgb,var(--success) 45%,transparent)}',
      '.as-btn.as-dng{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent)}',
      '.as-btn.as-pri{background:var(--accent);border-color:var(--accent);color:#fff}',
      '.as-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}',
      '.as-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;text-align:left;font-family:inherit;color:var(--text);cursor:pointer}',
      '.as-kpi:hover{border-color:var(--accent)}',
      '.as-kpi span{display:block;font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}',
      '.as-kpi b{display:block;font-size:22px;font-weight:700;margin-top:4px}',
      '.as-kpi.as-warn b{color:var(--warn)}.as-kpi.as-danger b{color:var(--danger)}',
      '.as-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.as-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.as-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.as-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.as-filters .input-field{width:auto;min-width:140px;padding:7px 10px}',
      '.as-filters .as-search{flex:1;min-width:180px}',
      '.as-wrap{overflow-x:auto}',
      '.as-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.as-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.as-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.as-table tr.as-click{cursor:pointer}',
      '.as-table tr.as-click:hover td{background:var(--bg3)}',
      '.as-table .r{text-align:right}',
      '.as-tag{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text2);white-space:nowrap}',
      '.as-muted{color:var(--text3)}.as-small{font-size:11.5px}',
      '.as-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}',
      '.as-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.as-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.as-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.as-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.as-c-muted{color:var(--text2);background:var(--bg3)}',
      '.as-empty{padding:36px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.as-err{padding:10px 12px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin:8px 0}',
      '.as-ok{padding:10px 12px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent);font-size:13px;margin:8px 0}',
      '.as-seat{height:6px;border-radius:4px;background:var(--bg3);overflow:hidden;min-width:90px}',
      '.as-seat i{display:block;height:100%;background:var(--accent)}',
      '.as-seat.full i{background:var(--danger)}.as-seat.near i{background:var(--warn)}',
      '.as-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;justify-content:flex-end}',
      '.as-ov.as-center{align-items:center;justify-content:center;padding:16px}',
      '.as-drawer{background:var(--bg2);border-left:1px solid var(--border2);width:min(560px,100vw);height:100%;overflow-y:auto;padding:20px 22px;color:var(--text);box-sizing:border-box}',
      '.as-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:560px;padding:20px;color:var(--text);max-height:90vh;overflow:auto;box-sizing:border-box}',
      '.as-modal h3,.as-drawer h3{margin:0 0 12px;font-size:16px}',
      '.as-sec{margin-top:18px}',
      '.as-sec h4{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin:0 0 8px}',
      '.as-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--border)}',
      '.as-kv span:first-child{color:var(--text3)}.as-kv span:last-child{text-align:right;word-break:break-word}',
      '.as-holder{border:1px solid var(--border2);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--bg3)}',
      '.as-holder-row{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}',
      '.as-tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--border2)}',
      '.as-tl li{position:relative;padding:0 0 12px 10px;font-size:12.5px}',
      '.as-tl li:before{content:"";position:absolute;left:-20px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--bg2);border:2px solid var(--accent)}',
      '.as-tl .as-when{font-size:11px;color:var(--text3)}',
      '.as-field{margin-bottom:10px}',
      '.as-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}',
      '.as-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.as-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
      '@media (max-width:640px){.as-grid2,.as-grid3{grid-template-columns:1fr}.as-drawer{padding:16px}.as-kpi b{font-size:18px}}',
      '.as-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}',
      '.as-pick{border:1px solid var(--border2);border-radius:8px;max-height:200px;overflow:auto;margin-top:6px}',
      '.as-pick button{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--border);padding:8px 10px;color:var(--text);cursor:pointer;font-family:inherit;font-size:12.5px}',
      '.as-pick button:hover,.as-pick button.on{background:var(--bg3)}',
      '.as-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}',
      '.as-card{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:14px 16px}',
      '.as-card h5{margin:0;font-size:15px}',
      '.as-busy{opacity:.6;pointer-events:none}',
      'html[data-theme="light"] .as-ov{background:rgba(15,23,42,.35)}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ── small renderers ───────────────────────────────────────────────────── */
  var STATUS_CLS = { in_stock: 'as-c-success', assigned: 'as-c-accent', repair: 'as-c-warn', lost: 'as-c-danger', retired: 'as-c-muted',
    active: 'as-c-accent', returned: 'as-c-success', written_off: 'as-c-muted' };
  var STATUS_LABEL = { in_stock: 'In stock', assigned: 'Assigned', repair: 'In repair', lost: 'Lost', retired: 'Retired',
    active: 'Holding', returned: 'Returned', written_off: 'Written off' };
  var EVENT_LABEL = { created: 'Added to the register', updated: 'Details updated', assigned: 'Assigned', acknowledged: 'Receipt acknowledged',
    returned: 'Returned', lost: 'Reported lost', written_off: 'Written off', sent_to_repair: 'Sent to repair', back_from_repair: 'Back from repair',
    back_in_stock: 'Back in stock', retired: 'Retired', marked_lost: 'Marked lost', found: 'Found', alert_warranty: 'Warranty alert raised',
    alert_license: 'Licence expiry alert raised', ack_reminder: 'Acknowledgement reminder sent', issue_reported: 'Issue reported',
    separation_linked: 'Added to exit clearance', separation_unlinked: 'Removed from exit clearance' };
  var MOVE_LABEL = { repair: 'Send to repair', in_stock: 'Back in stock', retired: 'Retire', lost: 'Mark lost' };
  function badge(text, cls) { return '<span class="as-badge ' + (cls || 'as-c-muted') + '">' + esc(text) + '</span>'; }
  function statusBadge(s) { return badge(STATUS_LABEL[s] || s, STATUS_CLS[s]); }
  function catLabel(c) {
    var cats = (st.meta && st.meta.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].value === c) return cats[i].label;
    return String(c || '').replace(/_/g, ' ');
  }
  function daysBadge(days) {
    if (days == null) return '';
    if (days < 0) return badge('expired', 'as-c-danger');
    if (days <= 30) return badge(days + ' d', 'as-c-warn');
    return '';
  }
  function options(list, sel) {
    return list.map(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function holderCell(a) {
    if (!a.holders || !a.holders.length) return '<span class="as-muted">—</span>';
    if (a.category === 'license') return esc(a.seatsUsed + ' / ' + (a.licenseSeats || 0)) + ' <span class="as-muted as-small">seats</span>';
    var h = a.holders[0];
    return '<div>' + esc(h.name || h.email) + '</div><div class="as-muted as-small">' + esc(h.email) + ' ' +
      (h.acknowledgedAt ? badge('acknowledged', 'as-c-success') : badge('not acknowledged', 'as-c-warn')) + '</div>';
  }

  /* ── overlays (our own nodes on <body>) ────────────────────────────────── */
  var openOverlays = [];
  function overlay(cls, inner) {
    var ov = document.createElement('div');
    ov.className = 'as-ov' + (cls ? ' ' + cls : '');
    ov.innerHTML = inner;
    document.body.appendChild(ov);
    openOverlays.push(ov);
    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      document.removeEventListener('keydown', onKey);
      var i = openOverlays.indexOf(ov); if (i !== -1) openOverlays.splice(i, 1);
    }
    function onKey(e) { if (e.key === 'Escape' && openOverlays[openOverlays.length - 1] === ov) close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    return { el: ov, close: close };
  }
  function closeAll() { openOverlays.slice().forEach(function (o) { if (o.parentNode) o.parentNode.removeChild(o); }); openOverlays = []; }

  function modal(title, bodyHtml, opts) {
    opts = opts || {};
    var o = overlay('as-center', '<div class="as-modal" role="dialog" aria-modal="true"><h3>' + esc(title) + '</h3><div data-m="body">' + bodyHtml +
      '</div><div data-m="msg"></div><div class="as-foot"><button class="as-btn" data-m="cancel">Cancel</button>' +
      (opts.onOk ? '<button class="btn-primary btn-sm" data-m="ok">' + esc(opts.okLabel || 'Save') + '</button>' : '') + '</div></div>');
    var m = { el: o.el, body: q(o.el, '[data-m="body"]'), close: o.close, msg: function (t, ok) { flash(q(o.el, '[data-m="msg"]'), t, ok); } };
    q(o.el, '[data-m="cancel"]').addEventListener('click', o.close);
    var ok = q(o.el, '[data-m="ok"]');
    if (ok) ok.addEventListener('click', function () {
      setBusy(ok, true);
      Promise.resolve().then(function () { return opts.onOk(m); }).then(function (keep) {
        setBusy(ok, false);
        if (keep !== true) o.close();
      }, function (e) { setBusy(ok, false); m.msg(errMsg(e)); });
    });
    var first = q(o.el, 'input,select,textarea');
    if (first) try { first.focus(); } catch (_) {}
    return m;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Admin: /it-assets
   * ════════════════════════════════════════════════════════════════════ */
  function mountAdmin(root, sub) {
    injectStyle();
    st.root = root;
    var m = /^\/(\d+)$/.exec(sub || '');
    st.tab = sub === '/licenses' ? 'licenses' : sub === '/expiring' ? 'expiring' : 'inventory';
    st.drawerId = m ? m[1] : null;
    var tok = ++st.token;
    if (!root.querySelector('.as-page')) root.innerHTML = '<div class="as-page"><div class="as-empty">Loading…</div></div>';
    api('/api/assets/meta').then(function (meta) {
      if (tok !== st.token) return;
      st.meta = meta;
      renderShell();
      if (st.drawerId) openDrawer(st.drawerId);
    }, function (e) {
      if (tok !== st.token) return;
      root.innerHTML = '<div class="as-page"><h1 class="as-h1">IT Assets</h1><div class="as-err">' + esc(errMsg(e)) + '</div></div>';
    });
  }

  function renderShell() {
    var root = st.root, k = st.meta.kpis || {};
    function kpi(label, n, act, cls) { return '<button class="as-kpi ' + (cls || '') + '" data-kpi="' + act + '"><span>' + esc(label) + '</span><b>' + esc(n) + '</b></button>'; }
    root.innerHTML = '<div class="as-page">' +
      '<div class="as-head"><div><h1 class="as-h1">IT Assets</h1><div class="as-sub">Laptops, monitors, phones, access cards and software licences — who holds what, from onboarding to exit.</div></div>' +
      '<div class="as-actions">' + (canManage() ? '<button class="btn-primary btn-sm" data-act="add">+ Add asset</button><button class="as-btn" data-act="import">Import CSV</button>' : '') +
      '<button class="as-btn" data-act="export">Export CSV</button></div></div>' +
      '<div class="as-kpis">' + kpi('Total assets', k.total || 0, 'all') + kpi('Assigned', k.assigned || 0, 'assigned') + kpi('In stock', k.inStock || 0, 'in_stock') +
      kpi('In repair', k.inRepair || 0, 'repair', k.inRepair ? 'as-warn' : '') + kpi('Warranty ends ≤30 days', k.warrantyExpiring || 0, 'expiring', k.warrantyExpiring ? 'as-warn' : '') +
      kpi('Licences near seat limit', k.licensesNearLimit || 0, 'licenses', k.licensesNearLimit ? 'as-warn' : '') +
      kpi('Not acknowledged', k.unacknowledged || 0, 'unack', k.unacknowledged ? 'as-warn' : '') + '</div>' +
      '<div class="as-tabs">' + [['inventory', 'Inventory'], ['licenses', 'Licences'], ['expiring', 'Expiring soon']].map(function (t) {
        return '<button class="as-tab' + (st.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div><div class="card" style="padding:16px" data-body></div></div>';
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { var t = b.getAttribute('data-tab'); SC.go('/it-assets' + (t === 'inventory' ? '' : '/' + t)); });
    });
    root.querySelectorAll('[data-kpi]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-kpi');
        if (a === 'expiring' || a === 'licenses') { SC.go('/it-assets/' + a); return; }
        st.filters.unack = a === 'unack';
        st.filters.status = (a === 'all' || a === 'unack') ? 'active' : a;
        if (st.tab !== 'inventory') SC.go('/it-assets'); else renderBody();
      });
    });
    var add = q(root, '[data-act="add"]'); if (add) add.addEventListener('click', function () { assetForm(null); });
    var imp = q(root, '[data-act="import"]'); if (imp) imp.addEventListener('click', importModal);
    q(root, '[data-act="export"]').addEventListener('click', function () { exportCsv(this); });
    renderBody();
  }

  function renderBody() {
    var body = q(st.root, '[data-body]');
    if (!body) return;
    if (st.tab === 'licenses') return renderLicenses(body);
    if (st.tab === 'expiring') return renderExpiring(body);
    renderInventory(body);
  }

  function qs() {
    var f = st.filters, p = [];
    ['q', 'category', 'status', 'ownership'].forEach(function (k) { if (f[k]) p.push(k + '=' + encodeURIComponent(f[k])); });
    if (f.unack) p.push('unacknowledged=1');
    return p.length ? '?' + p.join('&') : '';
  }

  function renderInventory(body) {
    var f = st.filters, meta = st.meta;
    body.innerHTML = '<div class="as-filters">' +
      '<input class="input-field as-search" data-f="q" placeholder="Search tag, name, serial, holder…" value="' + esc(f.q) + '">' +
      '<select class="input-field" data-f="category"><option value="">All categories</option>' + options(meta.categories, f.category) + '</select>' +
      '<select class="input-field" data-f="status">' + options([{ value: 'active', label: 'All but retired' }, { value: '', label: 'All statuses' }].concat(
        meta.statuses.map(function (s) { return { value: s, label: STATUS_LABEL[s] || s }; })), f.status) + '</select>' +
      '<select class="input-field" data-f="ownership"><option value="">Any owner</option>' + options([{ value: 'company', label: 'Company' }, { value: 'client', label: 'Client' }, { value: 'byod', label: 'BYOD' }], f.ownership) + '</select>' +
      (f.unack ? '<button class="as-btn" data-f="unack">Not acknowledged ✕</button>' : '') + '</div><div data-rows><div class="as-empty">Loading…</div></div>';
    q(body, '[data-f="q"]').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(st.searchTimer);
      st.searchTimer = setTimeout(function () { f.q = v.trim(); loadRows(body); }, 300);
    });
    ['category', 'status', 'ownership'].forEach(function (k) {
      q(body, '[data-f="' + k + '"]').addEventListener('change', function () { f[k] = this.value; loadRows(body); });
    });
    var u = q(body, '[data-f="unack"]'); if (u) u.addEventListener('click', function () { f.unack = false; renderInventory(body); });
    loadRows(body);
  }

  function loadRows(body) {
    var box = q(body, '[data-rows]'), tok = ++st.token;
    api('/api/assets' + qs()).then(function (d) {
      if (tok !== st.token) return;
      st.list = d.assets || [];
      if (!st.list.length) { box.innerHTML = '<div class="as-empty">No assets match.' + (canManage() ? ' Add one, or import a CSV.' : '') + '</div>'; return; }
      box.innerHTML = '<div class="as-wrap"><table class="as-table"><thead><tr><th>Tag</th><th>Asset</th><th>Category</th><th>Status</th><th>Holder</th><th>Warranty / expiry</th><th>Location</th></tr></thead><tbody>' +
        st.list.map(function (a) {
          var endDate = a.category === 'license' ? a.licenseExpiry : a.warrantyUntil;
          var endDays = a.category === 'license' ? a.licenseDays : a.warrantyDays;
          return '<tr class="as-click" data-open="' + a.id + '"><td class="as-tag">' + esc(a.assetTag) + '</td>' +
            '<td><b>' + esc(a.label) + '</b><div class="as-muted as-small">' + esc([[a.make, a.model].filter(Boolean).join(' '), a.serialNumber ? 'S/N ' + a.serialNumber : ''].filter(Boolean).join(' · ')) + '</div></td>' +
            '<td>' + esc(catLabel(a.category)) + (a.ownership !== 'company' ? ' <span class="as-muted as-small">(' + esc(a.ownership === 'client' ? a.clientName || 'client' : 'BYOD') + ')</span>' : '') + '</td>' +
            '<td>' + statusBadge(a.status) + '</td><td>' + holderCell(a) + '</td>' +
            '<td>' + (endDate ? esc(fmtDate(endDate)) + ' ' + daysBadge(endDays) : '<span class="as-muted">—</span>') + '</td>' +
            '<td>' + esc(a.location || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (d.total > st.list.length ? '<div class="as-muted as-small" style="margin-top:8px">Showing ' + st.list.length + ' of ' + d.total + '. Narrow the search to see more.</div>' : '');
      box.querySelectorAll('[data-open]').forEach(function (tr) {
        tr.addEventListener('click', function () { SC.go('/it-assets/' + tr.getAttribute('data-open')); });
      });
    }, function (e) { if (tok === st.token) box.innerHTML = '<div class="as-err">' + esc(errMsg(e)) + '</div>'; });
  }

  function renderLicenses(body) {
    body.innerHTML = '<div class="as-empty">Loading…</div>';
    api('/api/assets/licenses').then(function (d) {
      var rows = d.licenses || [];
      if (!rows.length) { body.innerHTML = '<div class="as-empty">No software licences in the register yet. Add an asset with category “Software licence”.</div>'; return; }
      body.innerHTML = '<div class="as-wrap"><table class="as-table"><thead><tr><th>Tag</th><th>Licence</th><th>Seats used</th><th></th><th>Expiry</th><th>Status</th></tr></thead><tbody>' +
        rows.map(function (l) {
          var pct = l.seats ? Math.min(100, Math.round(l.used * 100 / l.seats)) : 0;
          return '<tr class="as-click" data-open="' + l.id + '"><td class="as-tag">' + esc(l.assetTag) + '</td><td><b>' + esc(l.label) + '</b><div class="as-muted as-small">' + esc(l.vendor || '') + '</div></td>' +
            '<td>' + esc(l.used + ' / ' + l.seats) + ' <span class="as-muted as-small">(' + esc(l.free) + ' free)</span></td>' +
            '<td style="width:140px"><div class="as-seat' + (l.free === 0 ? ' full' : l.nearLimit ? ' near' : '') + '"><i style="width:' + pct + '%"></i></div></td>' +
            '<td>' + (l.licenseExpiry ? esc(fmtDate(l.licenseExpiry)) + ' ' + daysBadge(l.licenseDays) : '<span class="as-muted">—</span>') + '</td><td>' + statusBadge(l.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      body.querySelectorAll('[data-open]').forEach(function (tr) { tr.addEventListener('click', function () { SC.go('/it-assets/' + tr.getAttribute('data-open')); }); });
    }, function (e) { body.innerHTML = '<div class="as-err">' + esc(errMsg(e)) + '</div>'; });
  }

  function renderExpiring(body) {
    body.innerHTML = '<div class="as-empty">Loading…</div>';
    api('/api/assets/expiring?days=' + ((st.meta && st.meta.alertDays) || 30)).then(function (d) {
      var rows = d.items || [];
      if (!rows.length) { body.innerHTML = '<div class="as-empty">Nothing ends in the next ' + esc(d.days) + ' days.</div>'; return; }
      body.innerHTML = '<div class="as-muted as-small" style="margin-bottom:8px">Warranties and licences ending within ' + esc(d.days) +
        ' days (expired licences included). Asset managers get an in-app alert and an email digest once per end date.</div>' +
        '<div class="as-wrap"><table class="as-table"><thead><tr><th>Ends</th><th>What</th><th>Tag</th><th>Asset</th><th>Status</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr class="as-click" data-open="' + r.id + '"><td>' + esc(fmtDate(r.date)) + ' ' + (r.days < 0 ? badge('expired', 'as-c-danger') : badge(r.days + ' d', 'as-c-warn')) + '</td>' +
            '<td>' + (r.kind === 'license' ? 'Licence' : 'Warranty') + '</td><td class="as-tag">' + esc(r.assetTag) + '</td><td>' + esc(r.label) +
            ' <span class="as-muted as-small">' + esc(catLabel(r.category)) + '</span></td><td>' + statusBadge(r.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      body.querySelectorAll('[data-open]').forEach(function (tr) { tr.addEventListener('click', function () { SC.go('/it-assets/' + tr.getAttribute('data-open')); }); });
    }, function (e) { body.innerHTML = '<div class="as-err">' + esc(errMsg(e)) + '</div>'; });
  }

  /* ── drawer ────────────────────────────────────────────────────────────── */
  var drawer = null;
  function closeDrawer(nav) {
    if (drawer) { drawer.close(); drawer = null; }
    if (nav && SC.current() && /^\/\d+$/.test(SC.current().sub || '')) SC.go('/it-assets');
  }
  function refreshAfterChange(id) {
    api('/api/assets/meta').then(function (meta) { st.meta = meta; renderShell(); if (id) openDrawer(id); }, function () {});
  }

  function openDrawer(id) {
    if (drawer) { drawer.close(); drawer = null; }
    var o = overlay('', '<aside class="as-drawer" role="dialog" aria-modal="true"><div class="as-empty">Loading…</div></aside>');
    drawer = o;
    var origClose = o.close;
    o.close = function () { origClose(); if (drawer === o) drawer = null; };
    o.el.addEventListener('mousedown', function (e) { if (e.target === o.el) closeDrawer(true); });
    var panel = q(o.el, '.as-drawer');
    api('/api/assets/' + id).then(function (a) {
      if (drawer !== o) return;
      renderDrawer(panel, a);
    }, function (e) {
      panel.innerHTML = '<button class="as-btn" data-x>Close</button><div class="as-err">' + esc(errMsg(e)) + '</div>';
      q(panel, '[data-x]').addEventListener('click', function () { closeDrawer(true); });
    });
  }

  function kv(label, v) { return v === null || v === undefined || v === '' ? '' : '<div class="as-kv"><span>' + esc(label) + '</span><span>' + v + '</span></div>'; }

  function renderDrawer(panel, a) {
    var mg = canManage(), lic = a.category === 'license';
    var canAssign = mg && (lic ? (a.status === 'in_stock' || a.status === 'assigned') && a.seatsUsed < (a.licenseSeats || 1) : a.status === 'in_stock');
    var holders = (a.holders || []).map(function (h) {
      return '<div class="as-holder"><div class="as-holder-row"><div><b>' + esc(h.name || h.email) + '</b> <span class="as-muted as-small">' + esc(h.email) + '</span>' +
        '<div class="as-muted as-small">Since ' + esc(fmtDate(h.assignedAt)) + (h.expectedReturn ? ' · due back ' + esc(fmtDate(h.expectedReturn)) : '') +
        (h.separationId ? ' · <a href="/payroll/separations/' + h.separationId + '">on exit clearance</a>' : '') + '</div></div>' +
        (h.acknowledgedAt ? badge('acknowledged ' + fmtDate(h.acknowledgedAt), 'as-c-success') : badge('not acknowledged', 'as-c-warn')) + '</div>' +
        (mg ? '<div class="as-foot" style="margin-top:8px;justify-content:flex-start"><button class="as-btn as-ok-b" data-ret="' + h.id + '">' + (lic ? 'Revoke seat' : 'Record return') + '</button>' +
          (lic ? '' : '<button class="as-btn as-dng" data-lost="' + h.id + '">Lost</button>') + '</div>' : '') + '</div>';
    }).join('');
    var moves = mg ? (a.allowedStatus || []).map(function (s) {
      return '<button class="as-btn' + (s === 'retired' || s === 'lost' ? ' as-dng' : '') + '" data-move="' + s + '">' + esc(MOVE_LABEL[s] || s) + '</button>';
    }).join('') : '';
    var events = (a.events || []).map(function (e) {
      var extra = [];
      if (e.data && e.data.condition) extra.push('condition ' + e.data.condition);
      if (e.data && e.data.recoveryAmount) extra.push('recovery ' + money(e.data.recoveryAmount, a.currency));
      if (e.data && e.data.ticketCode) extra.push('ticket <a href="/tickets/' + esc(e.data.ticketId) + '">' + esc(e.data.ticketCode) + '</a>');
      if (e.data && e.data.date) extra.push('ends ' + esc(fmtDate(e.data.date)));
      return '<li><b>' + esc(EVENT_LABEL[e.kind] || e.kind) + '</b>' + (e.email ? ' — ' + esc(e.name || e.email) : '') +
        (extra.length ? ' <span class="as-muted">(' + extra.map(function (x) { return x.indexOf('<a ') === 0 || x.indexOf('ticket <a') === 0 ? x : esc(x); }).join(', ') + ')</span>' : '') +
        (e.note ? '<div class="as-small">' + esc(e.note) + '</div>' : '') +
        '<div class="as-when">' + esc(fmtDate(e.at, true)) + (e.actor && e.actor !== 'system' ? ' · ' + esc(e.actorName || e.actor) : e.actor === 'system' ? ' · automatic' : '') + '</div></li>';
    }).join('');
    panel.innerHTML = '<div class="as-holder-row"><div><div class="as-tag">' + esc(a.assetTag) + '</div><h3 style="margin:2px 0 0">' + esc(a.label) + '</h3></div>' +
      '<button class="as-btn" data-x aria-label="Close">✕</button></div>' +
      '<div style="margin-top:6px">' + statusBadge(a.status) + ' ' + badge(catLabel(a.category), 'as-c-muted') + ' ' + badge(a.condition, a.condition === 'damaged' ? 'as-c-danger' : 'as-c-muted') + '</div>' +
      '<div data-msg></div>' +
      (mg ? '<div class="as-foot" style="justify-content:flex-start">' + (canAssign ? '<button class="btn-primary btn-sm" data-act="assign">Assign</button>' : '') +
        '<button class="as-btn" data-act="edit">Edit</button>' + moves + (a.status !== 'retired' ? '<button class="as-btn as-dng" data-act="writeoff">Write off</button>' : '') +
        (a.status !== 'retired' && !(a.assignments || []).length ? '<button class="as-btn as-dng" data-act="delete">Delete</button>' : '') + '</div>' : '') +
      '<div class="as-sec"><h4>' + (lic ? 'Seat holders (' + esc(a.seatsUsed) + ' / ' + esc(a.licenseSeats) + ')' : 'Current holder') + '</h4>' +
      (holders || '<div class="as-muted as-small">Nobody holds this ' + (lic ? 'licence' : 'asset') + '.</div>') + '</div>' +
      '<div class="as-sec"><h4>Details</h4>' +
      kv('Make / model', esc([a.make, a.model].filter(Boolean).join(' '))) + kv('Serial number', esc(a.serialNumber)) +
      kv('Ownership', esc(a.ownership === 'client' ? 'Client — ' + a.clientName : a.ownership === 'byod' ? 'BYOD' : 'Company')) +
      kv('Location', esc(a.location)) + kv('Vendor', esc(a.vendor)) +
      kv('Purchased', a.purchaseDate ? esc(fmtDate(a.purchaseDate)) : '') + kv('Cost', a.purchaseCost ? esc(money(a.purchaseCost, a.currency)) : '') +
      kv('Warranty until', a.warrantyUntil ? esc(fmtDate(a.warrantyUntil)) + ' ' + daysBadge(a.warrantyDays) : '') +
      kv('Licence expiry', a.licenseExpiry ? esc(fmtDate(a.licenseExpiry)) + ' ' + daysBadge(a.licenseDays) : '') +
      kv('Notes', esc(a.notes)) + '</div>' +
      '<div class="as-sec"><h4>History</h4>' + (events ? '<ul class="as-tl">' + events + '</ul>' : '<div class="as-muted as-small">No history.</div>') + '</div>';
    q(panel, '[data-x]').addEventListener('click', function () { closeDrawer(true); });
    function done() { refreshAfterChange(a.id); }
    function bind(sel, fn) { var el = q(panel, sel); if (el) el.addEventListener('click', fn); }
    bind('[data-act="assign"]', function () { assignModal(a, done); });
    bind('[data-act="edit"]', function () { assetForm(a); });
    bind('[data-act="writeoff"]', function () { writeOffModal(a, done); });
    bind('[data-act="delete"]', function () {
      if (!confirm('Delete ' + a.assetTag + ' from the register? This cannot be undone.')) return;
      api('/api/assets/' + a.id, { method: 'DELETE' }).then(function () { closeDrawer(true); refreshAfterChange(null); },
        function (e) { flash(q(panel, '[data-msg]'), errMsg(e)); });
    });
    panel.querySelectorAll('[data-move]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-move');
        modal(MOVE_LABEL[s] || s, '<div class="as-field"><label>Note</label><textarea class="input-field" data-f="note" maxlength="1000" placeholder="Optional"></textarea></div>', {
          okLabel: MOVE_LABEL[s] || 'Save',
          onOk: function (m) { return api('/api/assets/' + a.id + '/status', { method: 'POST', body: { status: s, note: val(m.body, '[data-f="note"]') } }).then(done); }
        });
      });
    });
    panel.querySelectorAll('[data-ret]').forEach(function (b) {
      b.addEventListener('click', function () { returnModal(a, b.getAttribute('data-ret'), done); });
    });
    panel.querySelectorAll('[data-lost]').forEach(function (b) {
      b.addEventListener('click', function () { lostModal(a, b.getAttribute('data-lost'), done); });
    });
  }

  /* ── modals ────────────────────────────────────────────────────────────── */
  function assetForm(a) {
    var e = a || { category: 'laptop', ownership: 'company', condition: 'new', currency: 'INR' };
    var meta = st.meta;
    var html = '<div class="as-grid2"><div class="as-field"><label>Asset tag *</label><input class="input-field" data-f="assetTag" maxlength="60" value="' + esc(e.assetTag || '') + '" placeholder="EV-LAP-0042"></div>' +
      '<div class="as-field"><label>Category</label><select class="input-field" data-f="category">' + options(meta.categories, e.category) + '</select></div></div>' +
      '<div class="as-field"><label>Name</label><input class="input-field" data-f="name" maxlength="200" value="' + esc(e.name || '') + '" placeholder="MacBook Pro 14"></div>' +
      '<div class="as-grid3"><div class="as-field"><label>Make</label><input class="input-field" data-f="make" value="' + esc(e.make || '') + '"></div>' +
      '<div class="as-field"><label>Model</label><input class="input-field" data-f="model" value="' + esc(e.model || '') + '"></div>' +
      '<div class="as-field"><label>Serial no.</label><input class="input-field" data-f="serialNumber" value="' + esc(e.serialNumber || '') + '"></div></div>' +
      '<div class="as-grid3"><div class="as-field"><label>Purchase date</label><input type="date" class="input-field" data-f="purchaseDate" value="' + esc(e.purchaseDate || '') + '"></div>' +
      '<div class="as-field"><label>Cost</label><input class="input-field" data-f="purchaseCost" inputmode="decimal" value="' + esc(e.purchaseCost || '') + '"></div>' +
      '<div class="as-field"><label>Currency</label><input class="input-field" data-f="currency" maxlength="3" value="' + esc(e.currency || 'INR') + '"></div></div>' +
      '<div class="as-grid2"><div class="as-field"><label>Vendor</label><input class="input-field" data-f="vendor" value="' + esc(e.vendor || '') + '"></div>' +
      '<div class="as-field"><label>Warranty until</label><input type="date" class="input-field" data-f="warrantyUntil" value="' + esc(e.warrantyUntil || '') + '"></div></div>' +
      '<div class="as-grid2" data-lic><div class="as-field"><label>Licence seats</label><input type="number" min="1" class="input-field" data-f="licenseSeats" value="' + esc(e.licenseSeats || '') + '"></div>' +
      '<div class="as-field"><label>Licence expiry</label><input type="date" class="input-field" data-f="licenseExpiry" value="' + esc(e.licenseExpiry || '') + '"></div></div>' +
      '<div class="as-grid3"><div class="as-field"><label>Ownership</label><select class="input-field" data-f="ownership">' + options([{ value: 'company', label: 'Company' }, { value: 'client', label: 'Client' }, { value: 'byod', label: 'BYOD' }], e.ownership) + '</select></div>' +
      '<div class="as-field" data-client><label>Client</label><input class="input-field" data-f="clientName" value="' + esc(e.clientName || '') + '"></div>' +
      '<div class="as-field"><label>Condition</label><select class="input-field" data-f="condition">' + options(meta.conditions, e.condition) + '</select></div></div>' +
      '<div class="as-field"><label>Location</label><input class="input-field" data-f="location" value="' + esc(e.location || '') + '" placeholder="Hyderabad office, IT store"></div>' +
      '<div class="as-field"><label>Notes</label><textarea class="input-field" data-f="notes" maxlength="4000">' + esc(e.notes || '') + '</textarea></div>';
    var m = modal(a ? 'Edit ' + a.assetTag : 'Add asset', html, {
      okLabel: a ? 'Save' : 'Add asset',
      onOk: function (mm) {
        var body = {};
        ['assetTag', 'category', 'name', 'make', 'model', 'serialNumber', 'purchaseDate', 'purchaseCost', 'currency', 'vendor', 'warrantyUntil',
          'licenseSeats', 'licenseExpiry', 'ownership', 'clientName', 'condition', 'location', 'notes'].forEach(function (k) { body[k] = val(mm.body, '[data-f="' + k + '"]'); });
        if (body.category !== 'license') { delete body.licenseSeats; if (!a) delete body.licenseExpiry; }
        return api(a ? '/api/assets/' + a.id : '/api/assets', { method: a ? 'PATCH' : 'POST', body: body }).then(function (r) {
          if (r.warnings && r.warnings.length) alert('Saved. Note: ' + r.warnings.join(' '));
          if (a) refreshAfterChange(r.id); else SC.go('/it-assets/' + r.id);
          if (!a) refreshAfterChange(r.id);
        });
      }
    });
    function sync() {
      q(m.body, '[data-lic]').style.display = val(m.body, '[data-f="category"]') === 'license' ? '' : 'none';
      q(m.body, '[data-client]').style.visibility = val(m.body, '[data-f="ownership"]') === 'client' ? '' : 'hidden';
    }
    q(m.body, '[data-f="category"]').addEventListener('change', sync);
    q(m.body, '[data-f="ownership"]').addEventListener('change', sync);
    sync();
  }

  function assignModal(a, done) {
    var chosen = '';
    var m = modal('Assign ' + a.assetTag, '<div class="as-field"><label>Employee</label><input class="input-field" data-f="who" placeholder="Search by name or email" autocomplete="off">' +
      '<div class="as-pick" data-pick><div class="as-empty" style="padding:12px">Type to search.</div></div></div>' +
      '<div class="as-grid2"><div class="as-field"><label>Expected return</label><input type="date" class="input-field" data-f="due"></div><div></div></div>' +
      '<div class="as-field"><label>Note</label><textarea class="input-field" data-f="note" maxlength="1000" placeholder="Charger, bag…"></textarea></div>' +
      '<div class="as-muted as-small">The employee is notified and asked to confirm receipt in My Assets.</div>', {
      okLabel: 'Assign',
      onOk: function (mm) {
        if (!chosen) throw new Error('Choose who receives the asset.');
        return api('/api/assets/' + a.id + '/assign', { method: 'POST', body: { email: chosen, expectedReturn: val(mm.body, '[data-f="due"]') || null, note: val(mm.body, '[data-f="note"]') } }).then(done);
      }
    });
    var timer = null, input = q(m.body, '[data-f="who"]'), pick = q(m.body, '[data-pick]');
    function search() {
      api('/api/assets/people?q=' + encodeURIComponent(input.value.trim())).then(function (d) {
        var ppl = d.people || [];
        pick.innerHTML = ppl.length ? ppl.map(function (p) {
          return '<button type="button" data-em="' + esc(p.email) + '"' + (p.email === chosen ? ' class="on"' : '') + '><b>' + esc(p.name) + '</b> <span class="as-muted">' + esc(p.email) + '</span></button>';
        }).join('') : '<div class="as-empty" style="padding:12px">No match.</div>';
        pick.querySelectorAll('[data-em]').forEach(function (b) {
          b.addEventListener('click', function () {
            chosen = b.getAttribute('data-em');
            pick.querySelectorAll('[data-em]').forEach(function (x) { x.classList.toggle('on', x === b); });
            input.value = chosen;
          });
        });
      }, function (e) { pick.innerHTML = '<div class="as-err">' + esc(errMsg(e)) + '</div>'; });
    }
    input.addEventListener('input', function () { chosen = ''; clearTimeout(timer); timer = setTimeout(search, 250); });
    search();
  }

  function returnModal(a, aid, done) {
    var lic = a.category === 'license';
    modal(lic ? 'Revoke licence seat' : 'Record return — ' + a.assetTag, lic
      ? '<div class="as-field"><label>Note</label><textarea class="input-field" data-f="note" maxlength="1000"></textarea></div>'
      : '<div class="as-grid2"><div class="as-field"><label>Condition</label><select class="input-field" data-f="cond">' + options(st.meta.conditions, 'good') + '</select></div>' +
        '<div class="as-field"><label>Received by (email)</label><input class="input-field" data-f="recv" value="' + esc(SC.me().email) + '"></div></div>' +
        '<div class="as-grid2"><div class="as-field"><label>Recovery amount (if damaged)</label><input class="input-field" data-f="rec" inputmode="decimal" placeholder="0"></div>' +
        '<div class="as-field"><label>&nbsp;</label><label class="as-small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="repair"> Send to repair</label></div></div>' +
        '<div class="as-field"><label>Note</label><textarea class="input-field" data-f="note" maxlength="1000"></textarea></div>' +
        '<div class="as-muted as-small">A damaged return goes to repair. If the holder is leaving, the recovery is added to their Full &amp; Final.</div>', {
      okLabel: lic ? 'Revoke' : 'Record return',
      onOk: function (m) {
        var body = { note: val(m.body, '[data-f="note"]') };
        if (!lic) {
          body.condition = val(m.body, '[data-f="cond"]'); body.receivedBy = val(m.body, '[data-f="recv"]');
          body.recoveryAmount = val(m.body, '[data-f="rec"]') || null; body.toRepair = q(m.body, '[data-f="repair"]').checked;
        }
        return api('/api/assets/assignments/' + aid + '/return', { method: 'POST', body: body }).then(done);
      }
    });
  }

  function lostModal(a, aid, done) {
    modal('Report lost — ' + a.assetTag, '<div class="as-field"><label>Recovery amount</label><input class="input-field" data-f="rec" inputmode="decimal" placeholder="' + esc(a.purchaseCost || '0') + '"></div>' +
      '<div class="as-field"><label>Note</label><textarea class="input-field" data-f="note" maxlength="1000" placeholder="Where / when it was lost, police report no."></textarea></div>' +
      '<div class="as-muted as-small">If the holder is leaving, the recovery is added to their Full &amp; Final settlement.</div>', {
      okLabel: 'Mark lost',
      onOk: function (m) {
        return api('/api/assets/assignments/' + aid + '/lost', { method: 'POST', body: { recoveryAmount: val(m.body, '[data-f="rec"]') || null, note: val(m.body, '[data-f="note"]') } }).then(done);
      }
    });
  }

  function writeOffModal(a, done) {
    modal('Write off ' + a.assetTag, '<div class="as-field"><label>Recovery amount</label><input class="input-field" data-f="rec" inputmode="decimal" placeholder="0"></div>' +
      '<div class="as-field"><label>Reason</label><textarea class="input-field" data-f="note" maxlength="1000"></textarea></div>' +
      '<div class="as-muted as-small">The asset is retired for good; any open custody is closed as written off.</div>', {
      okLabel: 'Write off',
      onOk: function (m) { return api('/api/assets/' + a.id + '/write-off', { method: 'POST', body: { recoveryAmount: val(m.body, '[data-f="rec"]') || null, note: val(m.body, '[data-f="note"]') } }).then(done); }
    });
  }

  function importModal() {
    var text = '';
    var m = modal('Import assets from CSV', '<div class="as-muted as-small" style="margin-bottom:8px">Columns: asset_tag (required), category, name, make, model, serial_number, purchase_date, purchase_cost, currency, vendor, warranty_until, license_seats, license_expiry, ownership, client_name, location, condition, notes. Existing tags are updated. Tip: export first to get the layout.</div>' +
      '<input type="file" accept=".csv,text/csv" class="input-field" data-f="file"><div data-prev></div>', {
      okLabel: 'Import',
      onOk: function (mm) {
        if (!text) throw new Error('Choose a CSV file first.');
        return api('/api/assets/import', { method: 'POST', body: { csv: text, dryRun: false } }).then(function (r) {
          mm.msg('Imported: ' + r.created + ' added, ' + r.updated + ' updated' + (r.errors.length ? ', ' + r.errors.length + ' row(s) skipped' : '') + '.', !r.errors.length);
          text = '';
          refreshAfterChange(null);
          return true;
        });
      }
    });
    q(m.body, '[data-f="file"]').addEventListener('change', function () {
      var f = this.files && this.files[0], prev = q(m.body, '[data-prev]');
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { prev.innerHTML = '<div class="as-err">The file is larger than 2 MB.</div>'; return; }
      var r = new FileReader();
      r.onload = function () {
        text = String(r.result || '');
        prev.innerHTML = '<div class="as-empty" style="padding:10px">Checking…</div>';
        api('/api/assets/import', { method: 'POST', body: { csv: text, dryRun: true } }).then(function (d) {
          prev.innerHTML = '<div class="' + (d.errors.length ? 'as-err' : 'as-ok') + '">Preview: ' + d.rows + ' row(s) — ' + d.created + ' new, ' + d.updated + ' update(s), ' + d.errors.length + ' error(s).</div>' +
            (d.errors.length ? '<ul class="as-small">' + d.errors.slice(0, 20).map(function (x) { return '<li>Row ' + esc(x.row) + ': ' + esc(x.message) + '</li>'; }).join('') + '</ul>' : '') +
            (d.warnings.length ? '<ul class="as-small as-muted">' + d.warnings.slice(0, 10).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '');
        }, function (e) { text = ''; prev.innerHTML = '<div class="as-err">' + esc(errMsg(e)) + '</div>'; });
      };
      r.onerror = function () { prev.innerHTML = '<div class="as-err">The file could not be read.</div>'; };
      r.readAsText(f);
    });
  }

  function exportCsv(btn) {
    setBusy(btn, true);
    fetch('/api/assets/export.csv' + qs()).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.message || 'Export failed (' + r.status + ')'); });
      return r.blob();
    }).then(function (blob) {
      setBusy(btn, false);
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'it-assets.csv'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
    }, function (e) { setBusy(btn, false); alert(errMsg(e)); });
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Employee: /my-assets
   * ════════════════════════════════════════════════════════════════════ */
  function mountMine(root) {
    injectStyle();
    my.root = root;
    var tok = ++my.token;
    root.innerHTML = '<div class="as-page"><div class="as-empty">Loading…</div></div>';
    api('/api/assets/my').then(function (d) {
      if (tok !== my.token) return;
      var rows = d.assignments || [];
      var held = rows.filter(function (r) { return r.status === 'active'; });
      var past = rows.filter(function (r) { return r.status !== 'active'; });
      root.innerHTML = '<div class="as-page"><div class="as-head"><div><h1 class="as-h1">My Assets</h1>' +
        '<div class="as-sub">Equipment and licences issued to you. Confirm what you received, and report a problem to IT here.</div></div></div><div data-msg></div>' +
        (held.length ? '<div class="as-cards">' + held.map(function (r) {
          var a = r.asset;
          return '<div class="as-card"><div class="as-holder-row"><div><div class="as-tag">' + esc(a.assetTag) + '</div><h5>' + esc(a.label) + '</h5></div>' +
            (r.acknowledgedAt ? badge('Received ' + fmtDate(r.acknowledgedAt), 'as-c-success') : badge('Please confirm', 'as-c-warn')) + '</div>' +
            '<div style="margin-top:8px">' + kv('Category', esc(catLabelMine(a.category))) + kv('Make / model', esc([a.make, a.model].filter(Boolean).join(' '))) +
            kv('Serial number', esc(a.serialNumber)) + kv('Issued', esc(fmtDate(r.assignedAt))) + kv('Due back', r.expectedReturn ? esc(fmtDate(r.expectedReturn)) : '') +
            kv(a.category === 'license' ? 'Licence expiry' : 'Warranty until', esc(fmtDate(a.category === 'license' ? a.licenseExpiry : a.warrantyUntil) === '—' ? '' : fmtDate(a.category === 'license' ? a.licenseExpiry : a.warrantyUntil))) + '</div>' +
            '<div class="as-foot">' + (r.acknowledgedAt ? '' : '<button class="btn-primary btn-sm" data-ack="' + r.id + '">I received it</button>') +
            '<button class="as-btn" data-rep="' + r.id + '" data-label="' + esc(a.label + ' (' + a.assetTag + ')') + '">Report an issue</button></div></div>';
        }).join('') + '</div>' : '<div class="card as-empty">No assets are issued to you right now.</div>') +
        (past.length ? '<div class="card" style="padding:16px;margin-top:16px"><h3 style="margin:0 0 10px;font-size:14px">Returned in the last year</h3><div class="as-wrap"><table class="as-table"><thead><tr><th>Asset</th><th>Issued</th><th>Closed</th><th>Status</th></tr></thead><tbody>' +
          past.map(function (r) {
            return '<tr><td><b>' + esc(r.asset.label) + '</b> <span class="as-tag">' + esc(r.asset.assetTag) + '</span></td><td>' + esc(fmtDate(r.assignedAt)) + '</td><td>' + esc(fmtDate(r.returnedAt)) + '</td><td>' + statusBadge(r.status) +
              (r.recoveryAmount ? ' <span class="as-muted as-small">recovery ' + esc(money(r.recoveryAmount)) + '</span>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>' : '') + '</div>';
      root.querySelectorAll('[data-ack]').forEach(function (b) {
        b.addEventListener('click', function () {
          setBusy(b, true);
          api('/api/assets/my/' + b.getAttribute('data-ack') + '/acknowledge', { method: 'POST', body: {} }).then(function () { mountMine(root); },
            function (e) { setBusy(b, false); flash(q(root, '[data-msg]'), errMsg(e)); });
        });
      });
      root.querySelectorAll('[data-rep]').forEach(function (b) {
        b.addEventListener('click', function () { reportModal(b.getAttribute('data-rep'), b.getAttribute('data-label')); });
      });
    }, function (e) {
      if (tok !== my.token) return;
      root.innerHTML = '<div class="as-page"><h1 class="as-h1">My Assets</h1><div class="as-err">' + esc(errMsg(e)) + '</div></div>';
    });
  }
  var MINE_CAT = { laptop: 'Laptop', desktop: 'Desktop', monitor: 'Monitor', phone: 'Phone', tablet: 'Tablet', peripheral: 'Peripheral', access_card: 'Access card', license: 'Software licence', other: 'Other' };
  function catLabelMine(c) { return MINE_CAT[c] || c; }

  function reportModal(aid, label) {
    modal('Report an issue', '<div class="as-muted as-small" style="margin-bottom:8px">' + esc(label) + ' — this raises an IT help-desk ticket.</div>' +
      '<div class="as-field"><label>What is wrong?</label><textarea class="input-field" data-f="desc" maxlength="4000" style="min-height:100px"></textarea></div>' +
      '<div class="as-field"><label>Priority</label><select class="input-field" data-f="pri">' + options(['Low', 'Medium', 'High', 'Urgent'], 'Medium') + '</select></div>', {
      okLabel: 'Raise ticket',
      onOk: function (m) {
        return api('/api/assets/my/' + aid + '/report', { method: 'POST', body: { description: val(m.body, '[data-f="desc"]'), priority: val(m.body, '[data-f="pri"]') } }).then(function (r) {
          var t = r.ticket || {};
          m.body.innerHTML = '<div class="as-ok">Ticket ' + esc(t.code) + ' raised. IT will reply on the ticket.</div><a class="as-btn" href="/tickets/' + esc(t.id) + '">Open ticket</a>';
          var ok = q(m.el, '[data-m="ok"]'); if (ok) ok.style.display = 'none';
          return true;
        });
      }
    });
  }

  /* ── registration ──────────────────────────────────────────────────────── */
  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: '/it-assets', title: 'IT Assets',
      mount: function (root, sub) { mountAdmin(root, sub); },
      update: function (root, sub) {
        var m = /^\/(\d+)$/.exec(sub || '');
        if (m && st.meta && root.querySelector('.as-page [data-body]')) { st.drawerId = m[1]; openDrawer(m[1]); return; }
        if (!m && drawer) { drawer.close(); drawer = null; }
        var tab = sub === '/licenses' ? 'licenses' : sub === '/expiring' ? 'expiring' : 'inventory';
        if (!m && st.meta && tab !== st.tab) { st.tab = tab; renderShell(); return; }
        if (!m && st.meta) return;
        mountAdmin(root, sub);
      },
      unmount: function () { st.token++; st.root = null; closeAll(); drawer = null; }
    });
    SC.register({
      base: '/my-assets', title: 'My Assets',
      mount: function (root) { mountMine(root); },
      update: function (root) { mountMine(root); },
      unmount: function () { my.token++; my.root = null; closeAll(); }
    });
  }
  (function wait(n) {
    if (window.HRMSSidecar) { register(); return; }
    if (n > 200) return;
    setTimeout(function () { wait(n + 1); }, 50);
  })(0);
})();
