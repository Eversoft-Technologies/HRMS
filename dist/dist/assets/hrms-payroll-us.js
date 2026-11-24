/**
 * hrms-payroll-us.js  v1
 * US Payroll — /payroll/us (admin) and /my-pay/w4 (employee self-service W-4).
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): pages render into the
 * sidecar's own root; React-owned DOM is never touched or removed.
 *
 * Backend: api/payroll_ext/us_payroll.py + fx.py (routes in urls_us.py)
 *   /api/payroll/us/meta | settings | employees | employees/<email>/w4|preview
 *   /api/payroll/us/tax-tables[/<id>|/copy] | pay-calendar | w2[/generate]
 *   /api/payroll/us/1099/generate | filings[/<id>/download] | contractors/payments[/<id>]
 *   /api/payroll/fx/rates[/<id>] | settings | fetch | dashboard
 *   /api/me/w4[/preview] | /api/me/us-forms[/<id>/download]
 *
 * SSNs / TINs are only ever typed in (write-only fields); the server returns
 * masked values (***-**-1234) and this page never stores them.
 */
(function () {
  'use strict';
  if (window.__hrmsPayrollUsLoaded) return;
  window.__hrmsPayrollUsLoaded = true;

  var STYLE_ID = 'hrms-pus-style';
  var BASE = '/payroll/us';
  var SC = null;
  var TABS = [
    { id: 'employees', sub: '', label: 'Employees & W-4' },
    { id: 'tables', sub: '/tables', label: 'Tax tables' },
    { id: 'calendars', sub: '/calendars', label: 'Pay calendars' },
    { id: 'forms', sub: '/forms', label: 'W-2 / 1099' },
    { id: 'cfo', sub: '/cfo', label: 'CFO dashboard' }
  ];
  var STATUS = [
    { v: 'single', l: 'Single or Married filing separately' },
    { v: 'married_jointly', l: 'Married filing jointly' },
    { v: 'head_of_household', l: 'Head of household' }
  ];
  var STATUS_SHORT = { single: 'Single', married_jointly: 'MFJ', head_of_household: 'HOH' };
  var STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
    'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
    'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
  var FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Bi-weekly', semimonthly: 'Semi-monthly', monthly: 'Monthly' };

  var st = { root: null, tab: 'employees', meta: null, year: new Date().getFullYear(), token: 0 };
  var me = { root: null, year: new Date().getFullYear(), token: 0 };

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  var usdFmt = null;
  function usd(v) {
    try { usdFmt = usdFmt || new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); return usdFmt.format(Number(v || 0)); }
    catch (_) { return '$' + Number(v || 0).toFixed(2); }
  }
  function money(v, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(Number(v || 0)); }
    catch (_) { return (cur || '') + ' ' + Math.round(Number(v || 0)).toLocaleString('en-US'); }
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d }) : '—'; }
  function fmtDate(v, time) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, time ? { time: true } : undefined); } catch (_) {}
    return String(v).slice(0, time ? 16 : 10).replace('T', ' ');
  }
  function yearOptions(sel) {
    var y = new Date().getFullYear() + 1, out = '';
    for (; y >= 2020; y--) out += '<option value="' + y + '"' + (y === Number(sel) ? ' selected' : '') + '>' + y + '</option>';
    return out;
  }
  function opts(list, sel) {
    return list.map(function (o) {
      var v = typeof o === 'string' ? o : o.v, l = typeof o === 'string' ? o : o.l;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function badge(text, cls) { return '<span class="pus-badge ' + (cls || 'pus-c-muted') + '">' + esc(text) + '</span>'; }
  function errBox(e) { return '<div class="pus-err">' + esc(e && e.message ? e.message : String(e || 'Something went wrong')) + '</div>'; }
  function okBox(t) { return '<div class="pus-ok">' + esc(t) + '</div>'; }
  function busy(btn, on) { if (btn) { btn.disabled = !!on; btn.classList.toggle('pus-busy', !!on); } }
  function val(root, sel) { var el = q(root, sel); return el ? el.value : ''; }
  function checked(root, sel) { var el = q(root, sel); return !!(el && el.checked); }
  function flash(host, html) { if (host) { host.innerHTML = html; } }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function saveFile(name, mime, content) {
    var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name || 'file';
    a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
  }
  function openHtml(content) {
    var w = window.open('', '_blank', 'noopener=no');
    if (!w) { saveFile('form.html', 'text/html', content); return; }
    w.document.open(); w.document.write(content); w.document.close();
  }
  function handleDownload(d, print) {
    if (!d) return;
    if (print && /html/.test(d.mime || '')) openHtml(d.content);
    else saveFile(d.fileName, d.mime, d.content);
  }

  /* ── modal (inside our own root, so leaving the page removes it) ─────── */
  function modal(host, title, bodyHtml, wide) {
    var ov = document.createElement('div');
    ov.className = 'pus-overlay';
    ov.innerHTML = '<div class="pus-modal' + (wide ? ' pus-wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="pus-modal-h"><h3>' + esc(title) + '</h3><button class="pus-x" data-x="close" aria-label="Close">×</button></div>' +
      '<div data-x="msg"></div>' + bodyHtml + '</div>';
    host.appendChild(ov);
    function close() { document.removeEventListener('keydown', onKey); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    qa(ov, '[data-x="close"]').forEach(function (b) { b.addEventListener('click', close); });
    return { el: ov, close: close, msg: function (h) { flash(q(ov, '[data-x="msg"]'), h); } };
  }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.pus-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.pus-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.pus-h1{font-size:20px;font-weight:700;margin:0}',
      '.pus-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.pus-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:16px;overflow-x:auto}',
      '.pus-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.pus-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.pus-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}',
      '.pus-bar .input-field{width:auto;min-width:110px;padding:7px 10px}',
      '.pus-grow{flex:1}',
      '.pus-card{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:16px;margin-bottom:16px;min-width:0}',
      '.pus-card h4{margin:0 0 10px;font-size:14px;font-weight:700}',
      '.pus-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}',
      '.pus-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}',
      '.pus-kpi{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px}',
      '.pus-kpi span{display:block;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}',
      '.pus-kpi b{display:block;font-size:20px;font-weight:700;margin-top:4px;word-break:break-word}',
      '.pus-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.pus-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.pus-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.pus-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.pus-table td.n,.pus-table th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.pus-table tbody tr:hover td{background:var(--bg3)}',
      '.pus-table input.input-field{padding:5px 8px;min-width:90px}',
      '.pus-muted{color:var(--text3)}',
      '.pus-small{font-size:12px}',
      '.pus-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
      '.pus-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent;margin:1px 2px 1px 0}',
      '.pus-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.pus-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.pus-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.pus-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.pus-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.pus-banner{border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px;line-height:1.5;border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);background:color-mix(in srgb,var(--warn) 11%,var(--bg2));color:var(--text)}',
      '.pus-banner b{color:var(--warn)}',
      '.pus-info{border-radius:10px;padding:10px 14px;font-size:12.5px;margin-bottom:14px;line-height:1.5;border:1px solid var(--border2);background:var(--bg3);color:var(--text2)}',
      '.pus-err{padding:10px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px}',
      '.pus-ok{padding:10px 14px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 11%,transparent);font-size:13px;margin-bottom:12px}',
      '.pus-empty{padding:30px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.pus-field{margin-bottom:12px;min-width:0}',
      '.pus-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.pus-field .pus-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.4}',
      '.pus-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.pus-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}',
      '@media (max-width:640px){.pus-row2,.pus-row3{grid-template-columns:1fr}.pus-grid2{grid-template-columns:1fr}}',
      '.pus-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--text);cursor:pointer;line-height:1.45;margin-bottom:10px}',
      '.pus-check input{margin-top:3px;flex:none}',
      '.pus-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.pus-btns.end{justify-content:flex-end}',
      '.pus-link{background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;font-size:12.5px;padding:2px 4px}',
      '.pus-link.danger{color:var(--danger)}',
      '.pus-busy{opacity:.6;pointer-events:none}',
      '.pus-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.pus-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:620px;padding:20px;color:var(--text);max-height:92vh;overflow:auto}',
      '.pus-modal.pus-wide{max-width:900px}',
      '.pus-modal-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px}',
      '.pus-modal-h h3{margin:0;font-size:16px}',
      '.pus-x{background:none;border:none;color:var(--text3);font-size:22px;cursor:pointer;line-height:1}',
      '.pus-step{border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--bg2)}',
      '.pus-step h5{margin:0 0 10px;font-size:13px;font-weight:700;color:var(--text)}',
      '.pus-step h5 small{font-weight:500;color:var(--text3);margin-left:6px}',
      '.pus-lines{display:grid;grid-template-columns:1fr auto;gap:4px 16px;font-size:13px}',
      '.pus-lines span:nth-child(even){text-align:right;font-variant-numeric:tabular-nums}',
      '.pus-lines .tot{font-weight:700;border-top:1px solid var(--border2);padding-top:4px}',
      '.pus-bars{display:flex;flex-direction:column;gap:6px}',
      '.pus-bar-row{display:grid;grid-template-columns:70px 1fr 120px;gap:10px;align-items:center;font-size:12px}',
      '.pus-bar-track{height:14px;background:var(--bg3);border-radius:4px;overflow:hidden;display:flex}',
      '.pus-bar-fill{height:100%;background:var(--accent)}',
      '.pus-bar-fill.miss{background:var(--warn)}',
      '.pus-bar-row .n{text-align:right;font-variant-numeric:tabular-nums}',
      '@media (max-width:640px){.pus-bar-row{grid-template-columns:58px 1fr 90px}}',
      '.pus-subtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}',
      '.pus-chip{border:1px solid var(--border2);background:var(--bg3);color:var(--text2);border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.pus-chip.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}',
      'html[data-theme="light"] .pus-overlay{background:rgba(15,23,42,.35)}',
      'html[data-theme="light"] .pus-banner{background:color-mix(in srgb,var(--warn) 9%,#fff)}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * Shared W-4 form (admin modal + self-service page)
   * ═════════════════════════════════════════════════════════════════════ */
  function w4FormHtml(w, opt) {
    opt = opt || {};
    var ssnHint = w.ssnOnFile ? 'On file: ' + esc(w.ssnMasked) + ' — leave blank to keep it.' : 'Required. Stored encrypted; only the last 4 digits are ever shown.';
    return '' +
      '<div class="pus-step"><h5>Step 1 — Personal information<small>filing status &amp; SSN</small></h5>' +
        '<div class="pus-row2">' +
          '<div class="pus-field"><label>Filing status (1c)</label><select class="input-field" data-w="filingStatus">' + opts(STATUS, w.filingStatus) + '</select></div>' +
          '<div class="pus-field"><label>Social Security number</label><input class="input-field" data-w="ssn" type="password" inputmode="numeric" autocomplete="off" maxlength="11" placeholder="' + (w.ssnOnFile ? esc(w.ssnMasked) : '123-45-6789') + '">' +
            '<div class="pus-hint">' + ssnHint + '</div></div>' +
        '</div></div>' +
      '<div class="pus-step"><h5>Step 2 — Multiple jobs or spouse works</h5>' +
        '<label class="pus-check"><input type="checkbox" data-w="multipleJobs"' + (w.multipleJobs ? ' checked' : '') + '> Step 2(c): there are only two jobs total (uses the higher withholding table)</label></div>' +
      '<div class="pus-step"><h5>Step 3 — Claim dependents<small>$2,000 per qualifying child, $500 per other dependent</small></h5>' +
        '<div class="pus-field"><label>Total dependents amount ($)</label><input class="input-field" data-w="dependentsAmount" type="number" min="0" step="1" value="' + esc(w.dependentsAmount) + '"></div></div>' +
      '<div class="pus-step"><h5>Step 4 — Other adjustments (optional)</h5>' +
        '<div class="pus-row3">' +
          '<div class="pus-field"><label>4(a) Other income / yr</label><input class="input-field" data-w="otherIncome" type="number" min="0" step="0.01" value="' + esc(w.otherIncome) + '"></div>' +
          '<div class="pus-field"><label>4(b) Deductions / yr</label><input class="input-field" data-w="deductions" type="number" min="0" step="0.01" value="' + esc(w.deductions) + '"></div>' +
          '<div class="pus-field"><label>4(c) Extra / pay period</label><input class="input-field" data-w="extraWithholding" type="number" min="0" step="0.01" value="' + esc(w.extraWithholding) + '"></div>' +
        '</div>' +
        '<label class="pus-check"><input type="checkbox" data-w="exempt"' + (w.exempt ? ' checked' : '') + '> Claim exemption from federal withholding (no tax liability last year and none expected this year; expires Feb 15 next year)</label></div>' +
      '<div class="pus-step"><h5>State withholding certificate</h5>' +
        '<div class="pus-row3">' +
          '<div class="pus-field"><label>Work state</label><select class="input-field" data-w="workState"><option value="">—</option>' + opts(STATES, w.workState) + '</select></div>' +
          '<div class="pus-field"><label>State allowances</label><input class="input-field" data-w="stateAllowances" type="number" min="0" max="99" step="1" value="' + esc(w.stateAllowances) + '"></div>' +
          '<div class="pus-field"><label>State extra / period</label><input class="input-field" data-w="stateExtraWithholding" type="number" min="0" step="0.01" value="' + esc(w.stateExtraWithholding) + '"></div>' +
        '</div></div>' +
      (opt.certify ? '<label class="pus-check"><input type="checkbox" data-w="certify"> Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete. Saving signs it with today’s date and time.</label>' : '') +
      '<div data-w="preview"></div>';
  }
  function readW4(root) {
    var b = {
      filingStatus: val(root, '[data-w="filingStatus"]'),
      multipleJobs: checked(root, '[data-w="multipleJobs"]'),
      dependentsAmount: val(root, '[data-w="dependentsAmount"]') || 0,
      otherIncome: val(root, '[data-w="otherIncome"]') || 0,
      deductions: val(root, '[data-w="deductions"]') || 0,
      extraWithholding: val(root, '[data-w="extraWithholding"]') || 0,
      exempt: checked(root, '[data-w="exempt"]'),
      workState: val(root, '[data-w="workState"]'),
      stateAllowances: val(root, '[data-w="stateAllowances"]') || 0,
      stateExtraWithholding: val(root, '[data-w="stateExtraWithholding"]') || 0
    };
    var ssn = (val(root, '[data-w="ssn"]') || '').trim();
    if (ssn) b.ssn = ssn;
    if (q(root, '[data-w="certify"]')) b.certify = checked(root, '[data-w="certify"]');
    return b;
  }
  function previewHtml(p) {
    var L = p.lines || {};
    var rows = [['Wages this period', p.wages], ['Federal income tax (FIT)', L.fit], ['State income tax (SIT)', L.sit],
      ['Social Security', L.socsec], ['Medicare', L.medicare]];
    var h = '<div class="pus-card" style="margin:6px 0 0"><h4>Estimated withholding — ' + esc(FREQ_LABEL[p.payFrequency] || p.payFrequency) + ' pay period</h4><div class="pus-lines">';
    rows.forEach(function (r) { h += '<span>' + esc(r[0]) + '</span><span>' + usd(r[1]) + '</span>'; });
    h += '<span class="tot">Estimated take-home</span><span class="tot">' + usd(p.net) + '</span></div>';
    (p.warnings || []).forEach(function (w) { h += '<div class="pus-small" style="color:var(--warn);margin-top:6px">⚠ ' + esc(w) + '</div>'; });
    h += '<div class="pus-small pus-muted" style="margin-top:6px">' + esc(p.note || '') + '</div></div>';
    return h;
  }
  function w4Payload(b) { var c = deepCopy(b); delete c.ssn; delete c.certify; return c; }

  /* ═══════════════════════════════════════════════════════════════════════
   * Admin page: /payroll/us
   * ═════════════════════════════════════════════════════════════════════ */
  function tabFromSub(sub) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].sub && sub.indexOf(TABS[i].sub) === 0) return TABS[i].id;
    return 'employees';
  }
  function mountAdmin(root, sub) {
    injectStyle();
    st.root = root;
    st.tab = tabFromSub(sub || '');
    root.innerHTML = '<div class="pus-page"><div class="pus-head"><div><h1 class="pus-h1">US Payroll</h1>' +
      '<div class="pus-sub">W-4s, federal &amp; state withholding, FICA / FUTA / SUTA, pay calendars, W-2 / 1099 and multi-currency consolidation</div></div></div>' +
      '<div class="pus-tabs" role="tablist">' + TABS.map(function (t) {
        return '<button class="pus-tab' + (t.id === st.tab ? ' on' : '') + '" data-tab="' + t.id + '" role="tab">' + esc(t.label) + '</button>';
      }).join('') + '</div><div data-pus="body"><div class="pus-empty">Loading…</div></div></div>';
    qa(root, '[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = TABS.filter(function (x) { return x.id === b.getAttribute('data-tab'); })[0];
        SC.go(BASE + t.sub);
      });
    });
    var tok = ++st.token;
    api('/api/payroll/us/meta').then(function (m) {
      if (tok !== st.token) return;
      st.meta = m;
      renderTab();
    }).catch(function (e) { if (tok === st.token) flash(body(), errBox(e)); });
  }
  function updateAdmin(root, sub) {
    var t = tabFromSub(sub || '');
    if (!st.root || st.root !== root) return mountAdmin(root, sub);
    st.tab = t;
    qa(root, '[data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
    renderTab();
  }
  function body() { return st.root ? q(st.root, '[data-pus="body"]') : null; }
  function renderTab() {
    var b = body();
    if (!b || !st.meta) return;
    st.token++;
    var canManage = st.meta.canManage, canFile = st.meta.canFile;
    if (st.tab === 'cfo') return renderCfo(b);
    if (st.tab === 'forms' && (canManage || canFile)) return renderForms(b);
    if (!canManage) {
      b.innerHTML = '<div class="pus-card"><div class="pus-empty">You need the “Manage US Payroll” permission to use this page.<br>' +
        'Employees can fill in their own W-4 at <a href="/my-pay/w4">My Pay › W-4</a>.</div></div>';
      return;
    }
    if (st.tab === 'tables') return renderTables(b);
    if (st.tab === 'calendars') return renderCalendars(b);
    return renderEmployees(b);
  }

  /* ── Employees & W-4 ───────────────────────────────────────────────── */
  function renderEmployees(b) {
    var tok = st.token;
    b.innerHTML = '<div class="pus-bar"><label class="pus-small pus-muted">Tax year</label><select class="input-field" data-f="year">' + yearOptions(st.year) + '</select>' +
      '<input class="input-field pus-grow" data-f="q" placeholder="Search name, email, department or state"></div><div data-pus="list"><div class="pus-empty">Loading…</div></div>';
    q(b, '[data-f="year"]').addEventListener('change', function () { st.year = Number(this.value); renderEmployees(b); });
    var rows = [];
    function draw() {
      var term = (val(b, '[data-f="q"]') || '').toLowerCase();
      var list = rows.filter(function (r) { return !term || (r.name + ' ' + r.email + ' ' + r.department + ' ' + r.workState).toLowerCase().indexOf(term) >= 0; });
      var host = q(b, '[data-pus="list"]');
      if (!list.length) { host.innerHTML = '<div class="pus-card"><div class="pus-empty">No US employees yet. An employee is “US” when their compensation currency is USD or they have a W-4 on file.</div></div>'; return; }
      host.innerHTML = '<div class="pus-card"><div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Employee</th><th>Department</th><th>Pay frequency</th><th>W-4</th><th>Filing</th><th>State</th><th>SSN</th><th>Attention</th><th></th></tr></thead><tbody>' +
        list.map(function (r) {
          var w4b = r.w4Status === 'current' ? badge('Current ' + r.w4Year, 'pus-c-success') : r.w4Status === 'carried' ? badge('Using ' + r.w4Year, 'pus-c-warn') : badge('Missing', 'pus-c-danger');
          return '<tr><td><b>' + esc(r.name) + '</b><div class="pus-small pus-muted">' + esc(r.email) + '</div></td>' +
            '<td>' + esc(r.department || '—') + '</td><td>' + esc(FREQ_LABEL[r.payFrequency] || r.payFrequency || '—') + (r.currency ? ' <span class="pus-muted pus-small">' + esc(r.currency) + '</span>' : '') + '</td>' +
            '<td>' + w4b + (r.exempt ? badge('Exempt', 'pus-c-accent') : '') + '</td><td>' + esc(STATUS_SHORT[r.filingStatus] || '—') + '</td><td>' + esc(r.workState || '—') + '</td>' +
            '<td class="pus-mono">' + esc(r.ssnMasked || '—') + '</td>' +
            '<td>' + (r.warnings.length ? r.warnings.map(function (w) { return badge(w, 'pus-c-warn'); }).join('') : badge('OK', 'pus-c-success')) + '</td>' +
            '<td><button class="btn-sm" data-edit="' + esc(r.email) + '">Edit W-4</button></td></tr>';
        }).join('') + '</tbody></table></div></div>';
      qa(host, '[data-edit]').forEach(function (btn) { btn.addEventListener('click', function () { openW4Modal(btn.getAttribute('data-edit'), function () { renderEmployees(b); }); }); });
    }
    q(b, '[data-f="q"]').addEventListener('input', draw);
    api('/api/payroll/us/employees?year=' + st.year).then(function (d) {
      if (tok !== st.token) return;
      rows = d.employees || [];
      draw();
    }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="list"]'), errBox(e)); });
  }
  function openW4Modal(email, done) {
    var m = modal(st.root, 'W-4 — ' + email + ' (' + st.year + ')', '<div data-x="body"><div class="pus-empty">Loading…</div></div>', true);
    var url = '/api/payroll/us/employees/' + encodeURIComponent(email);
    api(url + '/w4?year=' + st.year).then(function (d) {
      var w = d.w4;
      var note = w.carriedFrom ? '<div class="pus-info">No ' + st.year + ' W-4 yet — showing the ' + w.carriedFrom + ' certificate, which stays in force until replaced. Saving creates the ' + st.year + ' record.</div>' :
        (!w.exists ? '<div class="pus-info">No W-4 on file — payroll withholds as Single with no adjustments until one is submitted.</div>' : '');
      var signed = w.signedAt ? '<div class="pus-small pus-muted" style="margin-bottom:10px">Signed by the employee ' + esc(fmtDate(w.signedAt, true)) + '</div>' : '';
      q(m.el, '[data-x="body"]').innerHTML = note + signed + w4FormHtml(w, {}) +
        '<div class="pus-btns end"><button class="btn-sm" data-x="preview">Estimate withholding</button><button class="btn-sm" data-x="close">Cancel</button><button class="btn-primary" data-x="save">Save W-4</button></div>';
      q(m.el, '[data-x="close"]:not(.pus-x)') && qa(m.el, '[data-x="close"]').forEach(function (bb) { bb.addEventListener('click', m.close); });
      q(m.el, '[data-x="preview"]').addEventListener('click', function () {
        var btn = this; busy(btn, true);
        api(url + '/preview', { method: 'POST', body: { year: st.year, w4: w4Payload(readW4(m.el)) } }).then(function (p) {
          q(m.el, '[data-w="preview"]').innerHTML = previewHtml(p);
        }).catch(function (e) { m.msg(errBox(e)); }).then(function () { busy(btn, false); });
      });
      q(m.el, '[data-x="save"]').addEventListener('click', function () {
        var btn = this; busy(btn, true);
        api(url + '/w4?year=' + st.year, { method: 'PUT', body: readW4(m.el) }).then(function () {
          m.close(); if (done) done();
        }).catch(function (e) { m.msg(errBox(e)); m.el.querySelector('.pus-modal').scrollTop = 0; }).then(function () { busy(btn, false); });
      });
    }).catch(function (e) { q(m.el, '[data-x="body"]').innerHTML = errBox(e); });
  }

  /* ── Tax tables ────────────────────────────────────────────────────── */
  function tableSummary(t) {
    var d = t.data || {};
    if (t.kind === 'federal') return 'Pub 15-T percentage method · adjustment ' + usd((d.standard_adjustment || {}).single) + ' / ' + usd((d.standard_adjustment || {}).married_jointly) + ' (MFJ)';
    if (t.kind === 'fica') return 'SS ' + d.ss_rate + '% to ' + usd(d.ss_wage_base) + ' · Medicare ' + d.medicare_rate + '% + ' + d.addl_medicare_rate + '% over ' + usd(d.addl_medicare_threshold);
    if (t.kind === 'futa' || t.kind === 'suta') return d.rate + '% on the first ' + usd(d.wage_base);
    if (t.kind === 'state') {
      if (d.type === 'none') return 'No state income tax';
      if (d.type === 'flat') return 'Flat ' + d.rate + '%' + (d.allowance_value ? ' · allowance ' + usd(d.allowance_value) : '');
      var s = ((d.brackets || {}).single || []);
      return 'Brackets ' + (s.length ? s[0].rate + '% – ' + s[s.length - 1].rate + '%' : '') + ' (' + s.length + ' bands)';
    }
    return '';
  }
  function renderTables(b) {
    var tok = st.token;
    b.innerHTML = '<div class="pus-bar"><label class="pus-small pus-muted">Tax year</label><select class="input-field" data-f="year"></select>' +
      '<span class="pus-grow"></span><button class="btn-sm" data-f="add">Add state / SUTA table</button><button class="btn-sm" data-f="copy">Copy to another year…</button></div><div data-pus="tables"><div class="pus-empty">Loading…</div></div>';
    function load(year) {
      api('/api/payroll/us/tax-tables' + (year ? '?year=' + year : '')).then(function (d) {
        if (tok !== st.token) return;
        var ys = q(b, '[data-f="year"]');
        var years = (d.years || []).slice();
        if (years.indexOf(d.year) < 0) years.unshift(d.year);
        ys.innerHTML = years.map(function (y) { return '<option value="' + y + '"' + (y === d.year ? ' selected' : '') + '>' + y + '</option>'; }).join('');
        ys.onchange = function () { load(this.value); };
        draw(d);
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="tables"]'), errBox(e)); });
    }
    function draw(d) {
      var host = q(b, '[data-pus="tables"]');
      var html = '';
      if (d.unverified) html += '<div class="pus-banner"><b>' + d.unverified + ' table(s) not verified.</b> ' + esc(d.verifyNote) + '. Open each table, compare it with the current IRS Pub 15-T / state publication, correct it and tick “Verified”.</div>';
      if (!d.tables.length) html += '<div class="pus-card"><div class="pus-empty">No tables for ' + d.year + '. Copy them from another year.</div></div>';
      var groups = [['federal', 'Federal income tax'], ['fica', 'FICA'], ['futa', 'FUTA'], ['state', 'State income tax'], ['suta', 'SUTA (state unemployment)']];
      groups.forEach(function (g) {
        var list = d.tables.filter(function (t) { return t.kind === g[0]; });
        if (!list.length) return;
        html += '<div class="pus-card"><h4>' + esc(g[1]) + '</h4><div class="pus-table-wrap"><table class="pus-table"><thead><tr>' + (g[0] === 'state' || g[0] === 'suta' ? '<th>State</th>' : '') +
          '<th>Values</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
          list.map(function (t) {
            return '<tr>' + (g[0] === 'state' || g[0] === 'suta' ? '<td><b>' + esc(t.region) + '</b></td>' : '') + '<td>' + esc(tableSummary(t)) + '</td>' +
              '<td>' + (t.verified ? badge('Verified', 'pus-c-success') + '<div class="pus-small pus-muted">' + esc(t.verifiedBy || '') + '</div>' : badge('Verify', 'pus-c-warn')) + '</td>' +
              '<td class="pus-small pus-muted">' + esc(fmtDate(t.updatedAt)) + '<div>' + esc(t.updatedBy || '') + '</div></td>' +
              '<td style="white-space:nowrap"><button class="btn-sm" data-t="' + t.id + '">Edit</button>' + (g[0] === 'state' || g[0] === 'suta' ? ' <button class="pus-link danger" data-del="' + t.id + '">Delete</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';
      });
      html += '<div class="pus-info">A state without a table withholds no state income tax and shows a warning on the employee and on the run. Rates are percentages (6.2 = 6.2%).</div>';
      host.innerHTML = html;
      qa(host, '[data-t]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var t = d.tables.filter(function (x) { return String(x.id) === btn.getAttribute('data-t'); })[0];
          openTableEditor(t, function () { load(d.year); });
        });
      });
      qa(host, '[data-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!window.confirm('Delete this table? Employees in that state will get no state withholding / SUTA until a table is added.')) return;
          busy(btn, true);
          api('/api/payroll/us/tax-tables/' + btn.getAttribute('data-del'), { method: 'DELETE' }).then(function () { load(d.year); })
            .catch(function (e) { busy(btn, false); window.alert(e.message); });
        });
      });
      q(b, '[data-f="add"]').onclick = function () { openAddTable(d.year, function () { load(d.year); }); };
      q(b, '[data-f="copy"]').onclick = function () {
        var to = window.prompt('Copy all ' + d.year + ' US tables to which year?', String(Number(d.year) + 1));
        if (!to) return;
        api('/api/payroll/us/tax-tables/copy', { method: 'POST', body: { fromYear: d.year, toYear: Number(to) } }).then(function (r) {
          window.alert(r.created + ' table(s) created for ' + r.year + '. They are marked “Verify” — update them for the new year.');
          load(r.year);
        }).catch(function (e) { window.alert(e.message); });
      };
    }
    load(st.year);
  }

  function rowsEditor(rows, cols) {
    /* cols: [{k, label, blankOk}] */
    return '<div class="pus-table-wrap"><table class="pus-table"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr data-row="' + i + '">' + cols.map(function (c) {
          var v = r[c.k]; return '<td><input class="input-field" type="number" step="any" data-k="' + c.k + '" value="' + (v == null ? '' : esc(v)) + '"' + (c.blankOk && i === rows.length - 1 ? ' placeholder="no limit"' : '') + '></td>';
        }).join('') + '<td><button class="pus-link danger" data-rm="' + i + '" title="Remove row">✕</button></td></tr>';
      }).join('') + '</tbody></table></div><button class="pus-link" data-addrow="1">+ Add row</button>';
  }
  function readRows(host, cols) {
    return qa(host, 'tr[data-row]').map(function (tr) {
      var o = {};
      cols.forEach(function (c) { var v = q(tr, '[data-k="' + c.k + '"]').value; o[c.k] = v === '' ? (c.blankOk ? null : 0) : Number(v); });
      return o;
    });
  }
  function statusMapFields(prefix, mp, label) {
    mp = (mp && typeof mp === 'object') ? mp : { single: mp || 0, married_jointly: mp || 0, head_of_household: mp || 0 };
    return '<div class="pus-row3">' + STATUS.map(function (s) {
      return '<div class="pus-field"><label>' + esc(label) + ' — ' + esc(STATUS_SHORT[s.v]) + '</label><input class="input-field" type="number" step="any" min="0" data-' + prefix + '="' + s.v + '" value="' + esc(mp[s.v] || 0) + '"></div>';
    }).join('') + '</div>';
  }
  function readStatusMap(host, prefix) {
    var o = {};
    STATUS.forEach(function (s) { o[s.v] = Number(q(host, '[data-' + prefix + '="' + s.v + '"]').value || 0); });
    return o;
  }

  function openTableEditor(t, done) {
    var title = (t.kind === 'state' || t.kind === 'suta' ? t.region + ' ' : '') + t.kind.toUpperCase() + ' — ' + t.year;
    var data = deepCopy(t.data || {});
    var m = modal(st.root, title, '<div data-x="ed"></div>' +
      '<div class="pus-field"><label>Notes</label><textarea class="input-field" data-x="notes" rows="2" maxlength="1000">' + esc(t.notes || '') + '</textarea></div>' +
      '<label class="pus-check"><input type="checkbox" data-x="verified"' + (t.verified ? ' checked' : '') + '> Verified against the current official publication</label>' +
      '<div class="pus-btns end"><button class="btn-sm" data-x="close">Cancel</button><button class="btn-primary" data-x="save">Save table</button></div>', t.kind === 'federal' || t.kind === 'state');
    var ed = q(m.el, '[data-x="ed"]');
    var collect = editorFor(t.kind, data, ed);
    q(m.el, '[data-x="save"]').addEventListener('click', function () {
      var btn = this; busy(btn, true);
      var payload;
      try { payload = { data: collect(), verified: checked(m.el, '[data-x="verified"]'), notes: val(m.el, '[data-x="notes"]') }; }
      catch (e) { m.msg(errBox(e)); busy(btn, false); return; }
      api('/api/payroll/us/tax-tables/' + t.id, { method: 'PUT', body: payload }).then(function () { m.close(); done(); })
        .catch(function (e) { m.msg(errBox(e)); }).then(function () { busy(btn, false); });
    });
  }
  function simpleFields(fields, data) {
    return '<div class="pus-row2">' + fields.map(function (f) {
      return '<div class="pus-field"><label>' + esc(f[1]) + '</label><input class="input-field" type="number" step="any" min="0" data-s="' + f[0] + '" value="' + esc(data[f[0]] == null ? '' : data[f[0]]) + '"></div>';
    }).join('') + '</div>';
  }
  function readSimple(host, fields) { var o = {}; fields.forEach(function (f) { o[f[0]] = Number(q(host, '[data-s="' + f[0] + '"]').value || 0); }); return o; }

  function editorFor(kind, data, host) {
    if (kind === 'fica' || kind === 'futa' || kind === 'suta') {
      var fields = kind === 'fica' ? [['ss_rate', 'Social Security rate %'], ['ss_wage_base', 'SS wage base $'], ['medicare_rate', 'Medicare rate %'],
        ['addl_medicare_rate', 'Additional Medicare rate %'], ['addl_medicare_threshold', 'Additional Medicare threshold $']] :
        [['rate', 'Rate %'], ['wage_base', 'Taxable wage base $']];
      host.innerHTML = simpleFields(fields, data) + (kind === 'futa' ? '<div class="pus-info">0.6% assumes the full 5.4% state credit. Credit-reduction states pay more — adjust if needed.</div>' :
        kind === 'suta' ? '<div class="pus-info">Use the employer’s assigned rate from the state agency (seeded values are new-employer rates).</div>' : '');
      return function () { return readSimple(host, fields); };
    }
    if (kind === 'federal') return federalEditor(data, host);
    return stateEditor(data, host);
  }
  function federalEditor(data, host) {
    var cur = { status: 'single', table: 'standard' };
    var cols = [{ k: 'over', label: 'Annual wage over $' }, { k: 'base', label: 'Tax base $' }, { k: 'rate', label: 'Rate % of excess' }];
    function save() {
      var tb = q(host, '[data-fed="rows"]');
      if (tb) data.tables[cur.status][cur.table] = readRows(tb, cols);
    }
    function draw() {
      host.innerHTML = '<div class="pus-info">IRS Pub 15-T “Percentage Method Tables for Automated Payroll Systems” — annual tables. Use the “Step 2 checkbox” table for employees who checked W-4 Step 2(c).</div>' +
        '<div class="pus-field"><label>Standard adjustment (Worksheet 1A line 1g, used when Step 2 is not checked)</label></div>' + statusMapFields('adj', data.standard_adjustment, 'Adjustment $') +
        '<div class="pus-subtabs">' + STATUS.map(function (s) { return '<button class="pus-chip' + (s.v === cur.status ? ' on' : '') + '" data-st="' + s.v + '">' + esc(s.l) + '</button>'; }).join('') + '</div>' +
        '<div class="pus-subtabs"><button class="pus-chip' + (cur.table === 'standard' ? ' on' : '') + '" data-tb="standard">Standard</button><button class="pus-chip' + (cur.table === 'step2' ? ' on' : '') + '" data-tb="step2">Step 2 checkbox</button></div>' +
        '<div data-fed="rows">' + rowsEditor(data.tables[cur.status][cur.table], cols) + '</div>';
      wire();
    }
    function wire() {
      qa(host, '[data-st]').forEach(function (b) { b.addEventListener('click', function () { data.standard_adjustment = readStatusMap(host, 'adj'); save(); cur.status = b.getAttribute('data-st'); draw(); }); });
      qa(host, '[data-tb]').forEach(function (b) { b.addEventListener('click', function () { data.standard_adjustment = readStatusMap(host, 'adj'); save(); cur.table = b.getAttribute('data-tb'); draw(); }); });
      var tb = q(host, '[data-fed="rows"]');
      qa(tb, '[data-rm]').forEach(function (b) { b.addEventListener('click', function () { save(); data.tables[cur.status][cur.table].splice(Number(b.getAttribute('data-rm')), 1); data.standard_adjustment = readStatusMap(host, 'adj'); draw(); }); });
      q(tb, '[data-addrow]').addEventListener('click', function () { save(); data.tables[cur.status][cur.table].push({ over: 0, base: 0, rate: 0 }); data.standard_adjustment = readStatusMap(host, 'adj'); draw(); });
    }
    draw();
    return function () { save(); data.standard_adjustment = readStatusMap(host, 'adj'); return data; };
  }
  function stateEditor(data, host) {
    var cur = 'single';
    var cols = [{ k: 'upto', label: 'Taxable income up to $', blankOk: true }, { k: 'rate', label: 'Rate %' }];
    data.brackets = data.brackets || { single: [{ upto: null, rate: 0 }], married_jointly: [{ upto: null, rate: 0 }], head_of_household: [{ upto: null, rate: 0 }] };
    function saveRows() { var tb = q(host, '[data-stb="rows"]'); if (tb) data.brackets[cur] = readRows(tb, cols); }
    function saveCommon() {
      var t = q(host, '[data-sx="type"]'); if (t) data.type = t.value;
      if (q(host, '[data-sx="rate"]')) data.rate = Number(val(host, '[data-sx="rate"]') || 0);
      if (q(host, '[data-std="single"]')) data.std_deduction = readStatusMap(host, 'std');
      if (q(host, '[data-sx="allowance_value"]')) data.allowance_value = Number(val(host, '[data-sx="allowance_value"]') || 0);
      if (q(host, '[data-sx="allowance_credit"]')) data.allowance_credit = Number(val(host, '[data-sx="allowance_credit"]') || 0);
    }
    function draw() {
      var t = data.type || 'none';
      var h = '<div class="pus-row2"><div class="pus-field"><label>Type</label><select class="input-field" data-sx="type">' + opts([{ v: 'none', l: 'No income tax' }, { v: 'flat', l: 'Flat rate' }, { v: 'brackets', l: 'Progressive brackets' }], t) + '</select></div>' +
        (t === 'flat' ? '<div class="pus-field"><label>Rate %</label><input class="input-field" type="number" step="any" min="0" data-sx="rate" value="' + esc(data.rate || 0) + '"></div>' : '<div></div>') + '</div>';
      if (t !== 'none') {
        h += statusMapFields('std', data.std_deduction, 'Std deduction $') +
          '<div class="pus-row2"><div class="pus-field"><label>Allowance value $ (deducted per allowance)</label><input class="input-field" type="number" step="any" min="0" data-sx="allowance_value" value="' + esc(data.allowance_value || 0) + '"></div>' +
          '<div class="pus-field"><label>Allowance credit $ (tax credit per allowance)</label><input class="input-field" type="number" step="any" min="0" data-sx="allowance_credit" value="' + esc(data.allowance_credit || 0) + '"></div></div>';
      }
      if (t === 'brackets') {
        h += '<div class="pus-subtabs">' + STATUS.map(function (s) { return '<button class="pus-chip' + (s.v === cur ? ' on' : '') + '" data-bst="' + s.v + '">' + esc(s.l) + '</button>'; }).join('') + '</div>' +
          '<div data-stb="rows">' + rowsEditor(data.brackets[cur] || [], cols) + '</div><div class="pus-hint pus-small pus-muted">Leave the last band’s limit empty (no upper limit).</div>';
      }
      h += '<div class="pus-info">Generic annualised formula: (wages × periods − standard deduction − allowances × value) through the rate / brackets, less allowances × credit, ÷ periods. States with special methods are approximated.</div>';
      host.innerHTML = h;
      q(host, '[data-sx="type"]').addEventListener('change', function () { saveRows(); saveCommon(); draw(); });
      qa(host, '[data-bst]').forEach(function (b) { b.addEventListener('click', function () { saveRows(); saveCommon(); cur = b.getAttribute('data-bst'); draw(); }); });
      var tb = q(host, '[data-stb="rows"]');
      if (tb) {
        qa(tb, '[data-rm]').forEach(function (b) { b.addEventListener('click', function () { saveRows(); saveCommon(); data.brackets[cur].splice(Number(b.getAttribute('data-rm')), 1); draw(); }); });
        q(tb, '[data-addrow]').addEventListener('click', function () {
          saveRows(); saveCommon();
          var rows = data.brackets[cur]; var last = rows[rows.length - 1];
          rows.splice(Math.max(0, rows.length - 1), 0, { upto: 0, rate: last ? last.rate : 0 });
          draw();
        });
      }
    }
    draw();
    return function () { saveRows(); saveCommon(); return data; };
  }
  function openAddTable(year, done) {
    var m = modal(st.root, 'Add state table — ' + year,
      '<div class="pus-row2"><div class="pus-field"><label>Kind</label><select class="input-field" data-x="kind"><option value="state">State income tax</option><option value="suta">SUTA</option></select></div>' +
      '<div class="pus-field"><label>State</label><select class="input-field" data-x="region">' + opts(STATES, '') + '</select></div></div>' +
      '<div data-x="ed"></div><div class="pus-btns end"><button class="btn-sm" data-x="close">Cancel</button><button class="btn-primary" data-x="save">Add table</button></div>', true);
    var ed = q(m.el, '[data-x="ed"]');
    var collect;
    function draw() {
      var kind = val(m.el, '[data-x="kind"]');
      collect = kind === 'suta' ? editorFor('suta', { rate: 2.7, wage_base: 7000 }, ed) : editorFor('state', { type: 'flat', rate: 0, std_deduction: 0, allowance_value: 0 }, ed);
    }
    q(m.el, '[data-x="kind"]').addEventListener('change', draw);
    draw();
    q(m.el, '[data-x="save"]').addEventListener('click', function () {
      var btn = this; busy(btn, true);
      api('/api/payroll/us/tax-tables', { method: 'POST', body: { year: year, kind: val(m.el, '[data-x="kind"]'), region: val(m.el, '[data-x="region"]'), data: collect() } })
        .then(function () { m.close(); done(); }).catch(function (e) { m.msg(errBox(e)); }).then(function () { busy(btn, false); });
    });
  }

  /* ── Pay calendars ─────────────────────────────────────────────────── */
  function renderCalendars(b) {
    var tok = st.token;
    var s = st.meta.settings || {};
    b.innerHTML = '<div class="pus-bar"><label class="pus-small pus-muted">Periods</label><select class="input-field" data-f="count">' + opts(['4', '6', '8', '12', '26'], '6') + '</select>' +
      '<label class="pus-small pus-muted">From</label><input class="input-field" type="date" data-f="from"></div>' +
      '<div class="pus-card"><h4>Calendar settings</h4><div class="pus-row3">' +
        '<div class="pus-field"><label>Bi-weekly anchor (a period start)</label><input class="input-field" type="date" data-c="biweeklyAnchor" value="' + esc(s.biweeklyAnchor || '') + '"></div>' +
        '<div class="pus-field"><label>Weekly anchor</label><input class="input-field" type="date" data-c="weeklyAnchor" value="' + esc(s.weeklyAnchor || '') + '"></div>' +
        '<div class="pus-field"><label>Pay date = period end + days</label><input class="input-field" type="number" min="0" max="31" data-c="payLagDays" value="' + esc(s.payLagDays || 0) + '"></div>' +
      '</div><div class="pus-btns"><button class="btn-sm" data-c="save">Save calendar settings</button><span data-c="msg" class="pus-small"></span></div></div>' +
      '<div data-pus="cal"><div class="pus-empty">Loading…</div></div>';
    function load() {
      var qs = '?count=' + val(b, '[data-f="count"]') + (val(b, '[data-f="from"]') ? '&from=' + val(b, '[data-f="from"]') : '');
      api('/api/payroll/us/pay-calendar' + qs).then(function (d) {
        if (tok !== st.token) return;
        q(b, '[data-pus="cal"]').innerHTML = '<div class="pus-info">' + esc(d.note) + ' Semi-monthly periods run 1–15 and 16–end of month; bi-weekly and weekly periods are anchored to the dates above.</div><div class="pus-grid2">' +
          d.calendars.map(function (c) {
            return '<div class="pus-card"><h4>' + esc(c.label) + ' <span class="pus-muted pus-small">' + c.periodsPerYear + ' periods / yr · ' + c.usEmployees + ' US employee(s)</span></h4><div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Label</th><th>Start</th><th>End</th><th>Pay date</th><th class="n">Days</th></tr></thead><tbody>' +
              c.periods.map(function (p) { return '<tr><td class="pus-mono">' + esc(p.label) + '</td><td>' + esc(fmtDate(p.start)) + '</td><td>' + esc(fmtDate(p.end)) + '</td><td>' + esc(fmtDate(p.payDate)) + '</td><td class="n">' + p.days + '</td></tr>'; }).join('') +
              '</tbody></table></div></div>';
          }).join('') + '</div>';
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="cal"]'), errBox(e)); });
    }
    q(b, '[data-f="count"]').addEventListener('change', load);
    q(b, '[data-f="from"]').addEventListener('change', load);
    q(b, '[data-c="save"]').addEventListener('click', function () {
      var btn = this; busy(btn, true);
      api('/api/payroll/us/settings', { method: 'PUT', body: { biweeklyAnchor: val(b, '[data-c="biweeklyAnchor"]'), weeklyAnchor: val(b, '[data-c="weeklyAnchor"]'), payLagDays: val(b, '[data-c="payLagDays"]') || 0 } })
        .then(function (s2) { st.meta.settings = s2; q(b, '[data-c="msg"]').innerHTML = '<span style="color:var(--success)">Saved.</span>'; load(); })
        .catch(function (e) { q(b, '[data-c="msg"]').innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; })
        .then(function () { busy(btn, false); });
    });
    load();
  }

  /* ── W-2 / 1099 ────────────────────────────────────────────────────── */
  function renderForms(b) {
    var tok = st.token;
    var canManage = st.meta.canManage;
    var s = st.meta.settings || {};
    var ids = s.stateIds || {};
    b.innerHTML = '<div class="pus-bar"><label class="pus-small pus-muted">Tax year</label><select class="input-field" data-f="year">' + yearOptions(st.year) + '</select></div>' +
      '<div class="pus-banner"><b>Review before filing.</b> W-2s must be filed with the SSA as an EFW2 file or through Business Services Online (BSO); 1099-NEC Copy A goes to the IRS through IRIS / FIRE. Forms generated here are employee / recipient copies and summaries with masked SSNs/TINs — they are not official IRS forms.</div>' +
      (canManage ? '<div class="pus-card"><h4>Employer details</h4><div class="pus-row3">' +
        '<div class="pus-field"><label>Legal name</label><input class="input-field" data-e="employerName" maxlength="200" value="' + esc(s.employerName || '') + '"></div>' +
        '<div class="pus-field"><label>EIN</label><input class="input-field" data-e="employerEin" maxlength="10" placeholder="12-3456789" value="' + esc(s.employerEin ? s.employerEin.slice(0, 2) + '-' + s.employerEin.slice(2) : '') + '"></div>' +
        '<div class="pus-field"><label>State employer IDs</label><input class="input-field" data-e="stateIds" placeholder="CA=123-4567-8, NY=..." value="' + esc(Object.keys(ids).map(function (k) { return k + '=' + ids[k]; }).join(', ')) + '"></div>' +
      '</div><div class="pus-field"><label>Address</label><input class="input-field" data-e="employerAddress" maxlength="400" value="' + esc(s.employerAddress || '') + '"></div>' +
      '<div class="pus-btns"><button class="btn-sm" data-e="save">Save employer details</button><span class="pus-small" data-e="msg"></span></div></div>' : '') +
      '<div class="pus-card"><div class="pus-btns" style="justify-content:space-between;margin-bottom:10px"><h4 style="margin:0">W-2 — wages from USD payslips</h4><button class="btn-primary" data-g="w2">Generate W-2s</button></div><div data-pus="w2"><div class="pus-empty">Loading…</div></div></div>' +
      (canManage ? '<div class="pus-card"><div class="pus-btns" style="justify-content:space-between;margin-bottom:10px"><h4 style="margin:0">1099 contractors</h4><div class="pus-btns"><button class="btn-sm" data-g="addpay">Add payment</button><button class="btn-primary" data-g="1099">Generate 1099-NEC</button></div></div><div data-pus="pay"><div class="pus-empty">Loading…</div></div></div>' : '') +
      '<div class="pus-card"><h4>Generated forms</h4><div data-pus="hist"><div class="pus-empty">Loading…</div></div></div>';
    q(b, '[data-f="year"]').addEventListener('change', function () { st.year = Number(this.value); renderForms(b); });
    var saveBtn = q(b, '[data-e="save"]');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      var stateIds = {};
      (val(b, '[data-e="stateIds"]') || '').split(',').forEach(function (p) { var kv = p.split('='); if (kv.length === 2 && kv[0].trim()) stateIds[kv[0].trim().toUpperCase()] = kv[1].trim(); });
      busy(saveBtn, true);
      api('/api/payroll/us/settings', { method: 'PUT', body: { employerName: val(b, '[data-e="employerName"]'), employerEin: val(b, '[data-e="employerEin"]'), employerAddress: val(b, '[data-e="employerAddress"]'), stateIds: stateIds } })
        .then(function (s2) { st.meta.settings = s2; q(b, '[data-e="msg"]').innerHTML = '<span style="color:var(--success)">Saved.</span>'; })
        .catch(function (e) { q(b, '[data-e="msg"]').innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; })
        .then(function () { busy(saveBtn, false); });
    });
    function loadW2() {
      api('/api/payroll/us/w2?year=' + st.year).then(function (d) {
        if (tok !== st.token) return;
        var host = q(b, '[data-pus="w2"]');
        if (!d.employees.length) { host.innerHTML = '<div class="pus-empty">No USD payslips for ' + st.year + '.</div>'; return; }
        host.innerHTML = (d.draftPayslips ? '<div class="pus-banner"><b>' + d.draftPayslips + ' payslip(s)</b> come from runs that are not approved yet.</div>' : '') +
          '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Employee</th><th>SSN</th><th class="n">1 Wages</th><th class="n">2 FIT</th><th class="n">3 SS wages</th><th class="n">4 SS tax</th><th class="n">5 Medicare wages</th><th class="n">6 Medicare tax</th><th>15</th><th class="n">16 State wages</th><th class="n">17 SIT</th></tr></thead><tbody>' +
          d.employees.map(function (r) {
            return '<tr><td><b>' + esc(r.name) + '</b><div class="pus-small pus-muted">' + r.payslips + ' payslip(s)</div></td><td class="pus-mono">' + (r.ssnMasked ? esc(r.ssnMasked) : badge('Missing', 'pus-c-danger')) + '</td>' +
              ['box1', 'box2', 'box3', 'box4', 'box5', 'box6'].map(function (k) { return '<td class="n">' + usd(r[k]) + '</td>'; }).join('') +
              '<td>' + esc(r.box15 || '—') + '</td><td class="n">' + usd(r.box16) + '</td><td class="n">' + usd(r.box17) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="w2"]'), errBox(e)); });
    }
    function loadPayments() {
      if (!canManage) return;
      api('/api/payroll/us/contractors/payments?year=' + st.year).then(function (d) {
        if (tok !== st.token) return;
        var host = q(b, '[data-pus="pay"]');
        var h = '<div class="pus-info">1099-NEC is required for payees paid ' + usd(d.threshold) + ' or more in ' + d.year + '. Payments to the same payee are grouped by email (or name).</div>';
        if (d.summary.length) {
          h += '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Payee</th><th>TIN</th><th class="n">Payments</th><th class="n">Box 1 total</th><th>1099-NEC</th></tr></thead><tbody>' +
            d.summary.map(function (r) {
              return '<tr><td><b>' + esc(r.payeeName) + '</b><div class="pus-small pus-muted">' + esc(r.payeeEmail || '') + '</div></td><td class="pus-mono">' + (r.tinMasked ? esc(r.tinMasked) : badge('Missing', 'pus-c-danger')) + '</td>' +
                '<td class="n">' + r.payments + '</td><td class="n">' + usd(r.total) + '</td><td>' + (r.requires1099 ? badge('Required', 'pus-c-accent') : badge('Below threshold', 'pus-c-muted')) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        h += '<h4 style="margin-top:14px">Payments</h4>';
        if (!d.payments.length) h += '<div class="pus-empty">No contractor payments in ' + d.year + '.</div>';
        else h += '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Paid on</th><th>Payee</th><th>TIN</th><th>Description</th><th class="n">Amount</th><th></th></tr></thead><tbody>' +
          d.payments.map(function (p) {
            return '<tr><td>' + esc(fmtDate(p.paidOn)) + '</td><td>' + esc(p.payeeName) + '</td><td class="pus-mono">' + esc(p.tinMasked || '—') + '</td><td>' + esc(p.description || '') + '</td><td class="n">' + usd(p.amount) + '</td>' +
              '<td style="white-space:nowrap"><button class="pus-link" data-pe="' + p.id + '">Edit</button><button class="pus-link danger" data-pd="' + p.id + '">Delete</button></td></tr>';
          }).join('') + '</tbody></table></div>';
        host.innerHTML = h;
        qa(host, '[data-pe]').forEach(function (btn) { btn.addEventListener('click', function () { openPayment(d.payments.filter(function (p) { return String(p.id) === btn.getAttribute('data-pe'); })[0], loadPayments); }); });
        qa(host, '[data-pd]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (!window.confirm('Delete this payment?')) return;
            api('/api/payroll/us/contractors/payments/' + btn.getAttribute('data-pd'), { method: 'DELETE' }).then(loadPayments).catch(function (e) { window.alert(e.message); });
          });
        });
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="pay"]'), errBox(e)); });
    }
    function loadHistory() {
      api('/api/payroll/us/filings?year=' + st.year).then(function (d) {
        if (tok !== st.token) return;
        var host = q(b, '[data-pus="hist"]');
        if (!d.filings.length) { host.innerHTML = '<div class="pus-empty">Nothing generated for ' + st.year + ' yet.</div>'; return; }
        host.innerHTML = '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Form</th><th>File</th><th>For</th><th>Generated</th><th></th></tr></thead><tbody>' +
          d.filings.map(function (f) {
            var html = /html/.test(f.mime);
            return '<tr><td>' + badge(f.kind === 'W2' ? 'W-2' : '1099-NEC', 'pus-c-accent') + '</td><td class="pus-mono">' + esc(f.fileName) + '</td><td>' + esc(f.email || (html ? '—' : 'Summary (' + f.rows + ')')) + '</td>' +
              '<td class="pus-small">' + esc(fmtDate(f.generatedAt, true)) + '<div class="pus-muted">' + esc(f.generatedBy) + '</div></td>' +
              '<td style="white-space:nowrap">' + (html ? '<button class="pus-link" data-dl="' + f.id + '" data-print="1">Open / print</button>' : '') + '<button class="pus-link" data-dl="' + f.id + '">Download</button></td></tr>';
          }).join('') + '</tbody></table></div>';
        qa(host, '[data-dl]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            busy(btn, true);
            api('/api/payroll/us/filings/' + btn.getAttribute('data-dl') + '/download').then(function (d2) { handleDownload(d2, btn.getAttribute('data-print')); })
              .catch(function (e) { window.alert(e.message); }).then(function () { busy(btn, false); });
          });
        });
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="hist"]'), errBox(e)); });
    }
    q(b, '[data-g="w2"]').addEventListener('click', function () {
      var btn = this;
      if (!window.confirm('Generate W-2s for every US employee with ' + st.year + ' USD payslips? Previous versions stay in the history.')) return;
      busy(btn, true);
      api('/api/payroll/us/w2/generate', { method: 'POST', body: { year: st.year } }).then(function (r) {
        window.alert(r.forms.length + ' W-2(s) and a summary CSV were generated. Review them before filing.');
        loadHistory();
      }).catch(function (e) { window.alert(e.message); }).then(function () { busy(btn, false); });
    });
    var g1099 = q(b, '[data-g="1099"]');
    if (g1099) g1099.addEventListener('click', function () {
      busy(g1099, true);
      api('/api/payroll/us/1099/generate', { method: 'POST', body: { year: st.year } }).then(function (r) {
        window.alert(r.forms.length + ' 1099-NEC form(s) generated (threshold ' + usd(r.threshold) + ').');
        loadHistory();
      }).catch(function (e) { window.alert(e.message); }).then(function () { busy(g1099, false); });
    });
    var addPay = q(b, '[data-g="addpay"]');
    if (addPay) addPay.addEventListener('click', function () { openPayment(null, loadPayments); });
    loadW2(); loadPayments(); loadHistory();
  }
  function openPayment(p, done) {
    var isNew = !p;
    p = p || { payeeName: '', payeeEmail: '', address: '', amount: '', paidOn: new Date().toISOString().slice(0, 10), description: '' };
    var m = modal(st.root, isNew ? 'Add contractor payment' : 'Edit payment',
      '<div class="pus-row2"><div class="pus-field"><label>Payee name</label><input class="input-field" data-p="payeeName" maxlength="255" value="' + esc(p.payeeName) + '"></div>' +
      '<div class="pus-field"><label>Payee email (optional)</label><input class="input-field" data-p="payeeEmail" type="email" maxlength="255" value="' + esc(p.payeeEmail) + '"></div></div>' +
      '<div class="pus-row3"><div class="pus-field"><label>TIN type</label><select class="input-field" data-p="tinType"><option value="ein">EIN</option><option value="ssn">SSN</option></select></div>' +
      '<div class="pus-field"><label>TIN</label><input class="input-field" data-p="tin" type="password" autocomplete="off" maxlength="11" placeholder="' + (p.tinMasked ? esc(p.tinMasked) : '12-3456789') + '">' +
        '<div class="pus-hint">' + (p.tinMasked ? 'On file — leave blank to keep.' : 'Blank re-uses the payee’s TIN from an earlier payment.') + '</div></div>' +
      '<div class="pus-field"><label>Amount (USD)</label><input class="input-field" data-p="amount" type="number" min="0.01" step="0.01" value="' + esc(p.amount) + '"></div></div>' +
      '<div class="pus-row2"><div class="pus-field"><label>Paid on</label><input class="input-field" data-p="paidOn" type="date" value="' + esc(p.paidOn) + '"></div>' +
      '<div class="pus-field"><label>Description</label><input class="input-field" data-p="description" maxlength="255" value="' + esc(p.description) + '"></div></div>' +
      '<div class="pus-field"><label>Payee address</label><textarea class="input-field" data-p="address" rows="2" maxlength="500">' + esc(p.address) + '</textarea></div>' +
      '<div class="pus-btns end"><button class="btn-sm" data-x="close">Cancel</button><button class="btn-primary" data-x="save">' + (isNew ? 'Add payment' : 'Save') + '</button></div>');
    q(m.el, '[data-x="save"]').addEventListener('click', function () {
      var btn = this; busy(btn, true);
      var bd = {};
      ['payeeName', 'payeeEmail', 'address', 'amount', 'paidOn', 'description'].forEach(function (k) { bd[k] = val(m.el, '[data-p="' + k + '"]'); });
      var tin = (val(m.el, '[data-p="tin"]') || '').trim();
      if (tin) { bd.tin = tin; bd.tinType = val(m.el, '[data-p="tinType"]'); }
      api('/api/payroll/us/contractors/payments' + (isNew ? '' : '/' + p.id), { method: isNew ? 'POST' : 'PATCH', body: bd })
        .then(function () { m.close(); done(); }).catch(function (e) { m.msg(errBox(e)); }).then(function () { busy(btn, false); });
    });
  }

  /* ── CFO dashboard ─────────────────────────────────────────────────── */
  function renderCfo(b) {
    var tok = st.token;
    var canManage = st.meta.canManage;
    b.innerHTML = '<div class="pus-bar"><label class="pus-small pus-muted">Year</label><select class="input-field" data-f="year">' + yearOptions(st.year) + '</select>' +
      '<label class="pus-small pus-muted">Report in</label><input class="input-field" data-f="cur" maxlength="3" style="width:80px;text-transform:uppercase" placeholder="INR">' +
      '<button class="btn-sm" data-f="go">Refresh</button></div><div data-pus="dash"><div class="pus-empty">Loading…</div></div>' +
      '<div class="pus-card"><h4>Exchange rates</h4><div data-pus="fx"><div class="pus-empty">Loading…</div></div></div>';
    q(b, '[data-f="year"]').addEventListener('change', function () { st.year = Number(this.value); loadDash(); });
    q(b, '[data-f="go"]').addEventListener('click', loadDash);
    function table(rows, keyLabel, key, cur) {
      if (!rows.length) return '<div class="pus-empty">No data.</div>';
      return '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>' + esc(keyLabel) + '</th><th class="n">Headcount</th><th class="n">Gross</th><th class="n">Employer cost</th><th class="n">Net</th></tr></thead><tbody>' +
        rows.map(function (r) { var c = cur || r.currency; return '<tr><td>' + esc(r[key]) + '</td><td class="n">' + r.headcount + '</td><td class="n">' + money(r.gross, c) + '</td><td class="n">' + money(r.employerCost, c) + '</td><td class="n">' + money(r.net, c) + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    }
    function loadDash() {
      var cur = (val(b, '[data-f="cur"]') || '').trim().toUpperCase();
      var host = q(b, '[data-pus="dash"]');
      host.innerHTML = '<div class="pus-empty">Loading…</div>';
      api('/api/payroll/fx/dashboard?year=' + st.year + (cur ? '&currency=' + encodeURIComponent(cur) : '')).then(function (d) {
        if (tok !== st.token) return;
        var R = d.reportingCurrency;
        if (!val(b, '[data-f="cur"]')) q(b, '[data-f="cur"]').placeholder = R;
        var h = (d.warnings || []).map(function (w) { return '<div class="pus-banner"><b>Missing rate.</b> ' + esc(w) + '</div>'; }).join('');
        h += '<div class="pus-kpis">' +
          '<div class="pus-kpi"><span>Employer cost (' + esc(R) + ')</span><b>' + money(d.totals.employerCost, R) + '</b></div>' +
          '<div class="pus-kpi"><span>Gross pay</span><b>' + money(d.totals.gross, R) + '</b></div>' +
          '<div class="pus-kpi"><span>Net pay</span><b>' + money(d.totals.net, R) + '</b></div>' +
          '<div class="pus-kpi"><span>Headcount</span><b>' + d.totals.headcount + '</b></div></div>';
        var max = 0;
        d.months.forEach(function (m) { max = Math.max(max, m.consolidated.employerCost); });
        h += '<div class="pus-grid2"><div class="pus-card"><h4>Monthly employer cost (' + esc(R) + ')</h4>' + (d.months.length ? '<div class="pus-bars">' +
          d.months.map(function (m) {
            var pct = max ? Math.round(m.consolidated.employerCost / max * 100) : 0;
            return '<div class="pus-bar-row" title="' + esc(m.month) + '"><span>' + esc(m.month) + '</span><div class="pus-bar-track"><div class="pus-bar-fill' + (m.missing.length ? ' miss' : '') + '" style="width:' + pct + '%"></div></div><span class="n">' + money(m.consolidated.employerCost, R) + '</span></div>';
          }).join('') + '</div><div class="pus-small pus-muted" style="margin-top:8px">Amber bars exclude currencies without a rate.</div>' : '<div class="pus-empty">No pay runs in ' + d.year + '.</div>') + '</div>' +
          '<div class="pus-card"><h4>By currency (original amounts)</h4>' + table(d.byCurrency, 'Currency', 'currency') + '</div></div>';
        h += '<div class="pus-grid2"><div class="pus-card"><h4>By department (' + esc(R) + ')</h4>' + table(d.byDepartment, 'Department', 'department', R) + '</div>' +
          '<div class="pus-card"><h4>By country (' + esc(R) + ')</h4>' + table(d.byCountry, 'Country', 'country', R) + '</div></div>';
        h += '<div class="pus-card"><h4>Month by currency</h4><div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Month</th><th>Currency</th><th class="n">Headcount</th><th class="n">Gross</th><th class="n">Employer cost</th><th class="n">Net</th><th class="n">Consolidated cost (' + esc(R) + ')</th></tr></thead><tbody>' +
          d.months.map(function (m) {
            return m.byCurrency.map(function (c, i) {
              return '<tr><td>' + (i === 0 ? '<b>' + esc(m.month) + '</b>' : '') + '</td><td>' + esc(c.currency) + (m.missing.indexOf(c.currency) >= 0 ? ' ' + badge('no rate', 'pus-c-warn') : '') + '</td><td class="n">' + c.headcount + '</td><td class="n">' + money(c.gross, c.currency) + '</td><td class="n">' + money(c.employerCost, c.currency) + '</td><td class="n">' + money(c.net, c.currency) + '</td>' +
                '<td class="n">' + (i === 0 ? money(m.consolidated.employerCost, R) : '') + '</td></tr>';
            }).join('');
          }).join('') + '</tbody></table></div><div class="pus-small pus-muted" style="margin-top:8px">' + esc(d.note) + '</div></div>';
        host.innerHTML = h;
      }).catch(function (e) { if (tok === st.token) flash(host, errBox(e)); });
    }
    function loadFx() {
      api('/api/payroll/fx/rates').then(function (d) {
        if (tok !== st.token) return;
        var host = q(b, '[data-pus="fx"]');
        var h = '<div class="pus-info">1 unit of the currency = rate × reporting currency. Conversions use the latest rate on or before the pay period end. Currencies in use: ' + esc((d.currenciesInUse || []).join(', ') || '—') + '.</div>';
        if (canManage) {
          h += '<div class="pus-row3"><div class="pus-field"><label>Reporting currency</label><input class="input-field" data-fx="rep" maxlength="3" value="' + esc(d.reportingCurrency) + '"></div>' +
            '<div class="pus-field"><label>Fetch from public API</label><label class="pus-check"><input type="checkbox" data-fx="auto"' + (d.autoFetch ? ' checked' : '') + '> Allowed (off by default)</label></div>' +
            '<div class="pus-field"><label>&nbsp;</label><div class="pus-btns"><button class="btn-sm" data-fx="saveset">Save</button>' + (d.autoFetch ? '<button class="btn-sm" data-fx="fetch">Fetch today’s rates</button>' : '') + '</div></div></div>' +
            '<div class="pus-row3" style="align-items:end"><div class="pus-field"><label>Currency</label><input class="input-field" data-fx="cur" maxlength="3" placeholder="USD"></div>' +
            '<div class="pus-field"><label>Rate (in ' + esc(d.reportingCurrency) + ')</label><input class="input-field" data-fx="rate" type="number" step="any" min="0"></div>' +
            '<div class="pus-field"><label>As of</label><input class="input-field" data-fx="asof" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div></div>' +
            '<div class="pus-btns" style="margin-bottom:12px"><button class="btn-primary" data-fx="add">Save rate</button><span class="pus-small" data-fx="msg"></span></div>';
        }
        h += d.rates.length ? '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>As of</th><th>Currency</th><th class="n">Rate</th><th>Into</th><th>Source</th><th></th></tr></thead><tbody>' +
          d.rates.map(function (r) {
            return '<tr><td>' + esc(fmtDate(r.asOf)) + '</td><td><b>' + esc(r.currency) + '</b></td><td class="n">' + num(r.rate, 6) + '</td><td>' + esc(r.reportingCurrency) + '</td><td class="pus-small pus-muted">' + esc(r.source) + ' · ' + esc(r.updatedBy) + '</td>' +
              '<td>' + (canManage ? '<button class="pus-link danger" data-fxd="' + r.id + '">Delete</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="pus-empty">No exchange rates yet.</div>';
        host.innerHTML = h;
        function msg(t, ok) { var el = q(host, '[data-fx="msg"]'); if (el) el.innerHTML = '<span style="color:var(--' + (ok ? 'success' : 'danger') + ')">' + esc(t) + '</span>'; }
        var add = q(host, '[data-fx="add"]');
        if (add) add.addEventListener('click', function () {
          busy(add, true);
          api('/api/payroll/fx/rates', { method: 'POST', body: { currency: (val(host, '[data-fx="cur"]') || '').toUpperCase(), rate: val(host, '[data-fx="rate"]'), asOf: val(host, '[data-fx="asof"]') } })
            .then(function () { loadFx(); loadDash(); }).catch(function (e) { msg(e.message); busy(add, false); });
        });
        var ss = q(host, '[data-fx="saveset"]');
        if (ss) ss.addEventListener('click', function () {
          busy(ss, true);
          api('/api/payroll/fx/settings', { method: 'PUT', body: { reportingCurrency: (val(host, '[data-fx="rep"]') || '').toUpperCase(), autoFetch: checked(host, '[data-fx="auto"]') } })
            .then(function () { loadFx(); loadDash(); }).catch(function (e) { msg(e.message); busy(ss, false); });
        });
        var fb = q(host, '[data-fx="fetch"]');
        if (fb) fb.addEventListener('click', function () {
          busy(fb, true);
          api('/api/payroll/fx/fetch', { method: 'POST', body: {} }).then(function (r) { msg(r.saved.length + ' rate(s) saved.', true); loadFx(); loadDash(); })
            .catch(function (e) { msg(e.message); busy(fb, false); });
        });
        qa(host, '[data-fxd]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (!window.confirm('Delete this rate?')) return;
            api('/api/payroll/fx/rates/' + btn.getAttribute('data-fxd'), { method: 'DELETE' }).then(function () { loadFx(); loadDash(); }).catch(function (e) { window.alert(e.message); });
          });
        });
      }).catch(function (e) { if (tok === st.token) flash(q(b, '[data-pus="fx"]'), errBox(e)); });
    }
    loadDash(); loadFx();
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * Employee self-service: /my-pay/w4
   * ═════════════════════════════════════════════════════════════════════ */
  function mountMe(root) {
    injectStyle();
    me.root = root;
    var tok = ++me.token;
    root.innerHTML = '<div class="pus-page" style="max-width:860px"><div class="pus-head"><div><h1 class="pus-h1">Form W-4 — Employee’s Withholding Certificate</h1>' +
      '<div class="pus-sub">Tell payroll how much US federal and state income tax to withhold from your pay.</div></div>' +
      '<div class="pus-bar" style="margin:0"><label class="pus-small pus-muted">Tax year</label><select class="input-field" data-f="year">' + yearOptions(me.year) + '</select></div></div>' +
      '<div data-me="msg"></div><div data-me="body"><div class="pus-empty">Loading…</div></div>' +
      '<div class="pus-card"><h4>My tax forms</h4><div data-me="forms"><div class="pus-empty">Loading…</div></div></div></div>';
    q(root, '[data-f="year"]').addEventListener('change', function () { me.year = Number(this.value); mountMe(root); });
    api('/api/me/w4?year=' + me.year).then(function (d) {
      if (tok !== me.token) return;
      var w = d.w4;
      var info = w.carriedFrom ? '<div class="pus-info">Your ' + w.carriedFrom + ' W-4 is still in force. Submit a new one only if something changed (or to renew an exemption).</div>' :
        (!w.exists ? '<div class="pus-info">You have no W-4 for ' + me.year + '. Until you submit one, payroll withholds as Single with no adjustments.</div>' :
          '<div class="pus-ok">Signed ' + esc(fmtDate(w.signedAt || w.updatedAt, true)) + '. You can update it at any time.</div>');
      q(root, '[data-me="body"]').innerHTML = info + w4FormHtml(w, { certify: true }) +
        '<div class="pus-info">For two-earner / multiple-jobs worksheets and the deductions worksheet use the official IRS Form W-4 instructions or the IRS Tax Withholding Estimator. Saving requires a recent sign-in.</div>' +
        '<div class="pus-btns end" style="margin-bottom:16px"><button class="btn-sm" data-me="preview">Estimate my withholding</button><button class="btn-primary" data-me="save">Sign &amp; save W-4</button></div>';
      q(root, '[data-me="preview"]').addEventListener('click', function () {
        var btn = this; busy(btn, true);
        api('/api/me/w4/preview', { method: 'POST', body: { year: me.year, w4: w4Payload(readW4(root)) } }).then(function (p) {
          q(root, '[data-w="preview"]').innerHTML = previewHtml(p);
        }).catch(function (e) { flash(q(root, '[data-me="msg"]'), errBox(e)); }).then(function () { busy(btn, false); });
      });
      q(root, '[data-me="save"]').addEventListener('click', function () {
        var btn = this; busy(btn, true);
        api('/api/me/w4?year=' + me.year, { method: 'PUT', body: readW4(root) }).then(function (r) {
          var ssn = q(root, '[data-w="ssn"]'); if (ssn) ssn.value = '';
          flash(q(root, '[data-me="msg"]'), okBox(r.message || 'Saved.'));
          window.scrollTo(0, 0);
          setTimeout(function () { if (me.root === root) mountMe(root); }, 1200);
        }).catch(function (e) {
          flash(q(root, '[data-me="msg"]'), errBox(e));
          window.scrollTo(0, 0);
        }).then(function () { busy(btn, false); });
      });
    }).catch(function (e) { if (tok === me.token) flash(q(root, '[data-me="body"]'), errBox(e)); });
    api('/api/me/us-forms').then(function (d) {
      if (tok !== me.token) return;
      var host = q(root, '[data-me="forms"]');
      if (!d.forms.length) { host.innerHTML = '<div class="pus-empty">No W-2 or 1099 forms have been issued to you yet.</div>'; return; }
      host.innerHTML = '<div class="pus-table-wrap"><table class="pus-table"><thead><tr><th>Form</th><th>Year</th><th>Issued</th><th></th></tr></thead><tbody>' +
        d.forms.map(function (f) {
          return '<tr><td>' + badge(f.kind === 'W2' ? 'W-2' : '1099-NEC', 'pus-c-accent') + '</td><td>' + esc(f.period) + '</td><td>' + esc(fmtDate(f.generatedAt)) + '</td>' +
            '<td><button class="pus-link" data-mf="' + f.id + '">Open / print</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      qa(host, '[data-mf]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          busy(btn, true);
          api('/api/me/us-forms/' + btn.getAttribute('data-mf') + '/download').then(function (d2) { handleDownload(d2, true); })
            .catch(function (e) { window.alert(e.message); }).then(function () { busy(btn, false); });
        });
      });
    }).catch(function (e) { if (tok === me.token) flash(q(root, '[data-me="forms"]'), errBox(e)); });
  }

  /* ── registration ──────────────────────────────────────────────────── */
  function boot() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE, title: 'US Payroll',
      mount: mountAdmin, update: updateAdmin,
      unmount: function () { st.token++; st.root = null; }
    });
    SC.register({
      base: '/my-pay/w4', title: 'W-4',
      mount: function (root) { mountMe(root); },
      unmount: function () { me.token++; me.root = null; }
    });
  }
  (function wait(n) {
    if (window.HRMSSidecar) return boot();
    if (n > 200) return;
    setTimeout(function () { wait(n + 1); }, 50);
  })(0);
})();
