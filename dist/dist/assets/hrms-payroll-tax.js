/**
 * hrms-payroll-tax.js  v1
 * India tax & statutory compliance.
 *   /payroll/compliance  (HR)        Tax tables · Declarations · Statutory files · TDS preview
 *   /my-pay/tax          (employee)  Regime choice + old/new estimate, IT declaration, proofs, Form 16
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js); renders only into the
 * sidecar's own root (modals are appended to that root too). React-owned DOM
 * is never touched.
 *
 * Backend: api/payroll_ext/india_tax.py, api/payroll_ext/statutory.py
 * (routes in api/payroll_ext/urls_tax.py). Every permission check happens on
 * the server; this page only hides what the server would refuse anyway.
 */
(function () {
  'use strict';
  if (window.__hrmsPayrollTaxLoaded) return;
  window.__hrmsPayrollTaxLoaded = true;

  var STYLE_ID = 'hrms-ptax-style';
  var SC = null;

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function money(v) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '—';
    try {
      if (window.HRMSCompany && window.HRMSCompany.money && window.HRMSCompany.symbol && window.HRMSCompany.symbol() === '₹') {
        return window.HRMSCompany.money(n);
      }
    } catch (_) {}
    try { return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); } catch (_) { return '₹' + Math.round(n); }
  }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v); } catch (_) {}
    return String(v).slice(0, 10);
  }
  function currentFY() {
    var d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return fyLabel(y);
  }
  function fyLabel(y) { return y + '-' + String((y + 1) % 100).replace(/^(\d)$/, '0$1'); }
  function fyOptions(sel, extra) {
    var y = parseInt(currentFY().slice(0, 4), 10), list = [fyLabel(y + 1), fyLabel(y), fyLabel(y - 1), fyLabel(y - 2)];
    (extra || []).forEach(function (f) { if (list.indexOf(f) < 0) list.push(f); });
    list.sort().reverse();
    return list.map(function (f) { return '<option value="' + esc(f) + '"' + (f === sel ? ' selected' : '') + '>FY ' + esc(f) + '</option>'; }).join('');
  }
  var STATUS_CLS = { draft: 'ptax-c-muted', submitted: 'ptax-c-accent', verified: 'ptax-c-success', rejected: 'ptax-c-danger',
    locked: 'ptax-c-warn', pending: 'ptax-c-muted', accepted: 'ptax-c-success' };
  function badge(text, cls) { return '<span class="ptax-badge ' + (cls || STATUS_CLS[text] || 'ptax-c-muted') + '">' + esc(text) + '</span>'; }
  function errBox(msg) { return '<div class="ptax-err">' + esc(msg) + '</div>'; }
  function okBox(msg) { return '<div class="ptax-ok">' + esc(msg) + '</div>'; }
  function loading() { return '<div class="ptax-empty">Loading…</div>'; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function on(root, sel, ev, fn) { qa(root, sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(e, el); }); }); }
  function busy(btn, b, label) {
    if (!btn) return;
    if (b) { btn.setAttribute('data-label', btn.textContent); btn.disabled = true; btn.textContent = label || 'Working…'; }
    else { btn.disabled = false; btn.textContent = btn.getAttribute('data-label') || btn.textContent; }
  }
  function saveFile(name, mime, content, encoding, host) {
    var blob;
    if (encoding === 'base64') {
      var bin = atob(content || ''), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      blob = new Blob([arr], { type: mime || 'application/octet-stream' });
    } else {
      blob = new Blob([content || ''], { type: (mime || 'text/plain') + ';charset=utf-8' });
    }
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name || 'file'; a.style.display = 'none';
    (host || document.body).appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ''); resolve(s.indexOf(',') >= 0 ? s.split(',')[1] : s); };
      r.onerror = function () { reject(new Error('The file could not be read.')); };
      r.readAsDataURL(file);
    });
  }
  function fileMime(file) {
    var t = (file.type || '').toLowerCase(), n = (file.name || '').toLowerCase();
    if (t) return t === 'image/jpg' ? 'image/jpeg' : t;
    if (/\.pdf$/.test(n)) return 'application/pdf';
    if (/\.png$/.test(n)) return 'image/png';
    if (/\.jpe?g$/.test(n)) return 'image/jpeg';
    return '';
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.ptax-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.ptax-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.ptax-h1{font-size:20px;font-weight:700;margin:0}',
      '.ptax-sub{font-size:13px;color:var(--text3);margin-top:4px;max-width:720px}',
      '.ptax-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:16px;overflow-x:auto}',
      '.ptax-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.ptax-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.ptax-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px;align-items:start}',
      '.ptax-stack>*+*{margin-top:16px}',
      '.ptax-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}',
      '.ptax-row>.ptax-field{flex:1;min-width:140px}',
      '.ptax-field{margin-bottom:10px}',
      '.ptax-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.ptax-page .input-field{box-sizing:border-box;max-width:100%}',
      '.ptax-inline{width:auto;min-width:120px;padding:7px 10px}',
      '.ptax-num{width:120px;text-align:right}',
      '.ptax-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.ptax-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.ptax-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.ptax-table td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.ptax-table td.n,.ptax-table th.n{text-align:right;white-space:nowrap}',
      '.ptax-table tr.click{cursor:pointer}',
      '.ptax-table tr.click:hover td{background:var(--bg3)}',
      '.ptax-table tr.tot td{font-weight:700;border-top:1px solid var(--border2)}',
      '.ptax-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.ptax-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.ptax-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.ptax-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.ptax-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.ptax-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.ptax-banner{padding:10px 14px;border-radius:8px;font-size:12.5px;line-height:1.5;margin-bottom:12px;color:var(--text);background:color-mix(in srgb,var(--warn) 12%,var(--bg2));border:1px solid color-mix(in srgb,var(--warn) 45%,transparent)}',
      '.ptax-info{padding:10px 14px;border-radius:8px;font-size:12.5px;line-height:1.5;margin-bottom:12px;color:var(--text2);background:var(--bg3);border:1px solid var(--border2)}',
      '.ptax-err{padding:10px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin:10px 0}',
      '.ptax-ok{padding:10px 14px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent);font-size:13px;margin:10px 0}',
      '.ptax-empty{padding:32px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.ptax-muted{color:var(--text3)}',
      '.ptax-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.45}',
      '.ptax-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.ptax-link{background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;font-size:12.5px;padding:0;text-decoration:underline}',
      '.ptax-x{background:none;border:1px solid var(--border2);color:var(--text2);border-radius:6px;cursor:pointer;width:28px;height:28px;font-size:15px;line-height:1}',
      '.ptax-x:hover{color:var(--danger);border-color:var(--danger)}',
      '.ptax-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
      '.ptax-chip{border:1px solid var(--border2);background:var(--bg2);color:var(--text2);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.ptax-chip.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--bg2))}',
      '.ptax-regimes{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '@media (max-width:640px){.ptax-regimes{grid-template-columns:1fr}.ptax-num{width:100px}}',
      '.ptax-reg{border:1px solid var(--border2);border-radius:10px;padding:14px;background:var(--bg2)}',
      '.ptax-reg.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}',
      '.ptax-reg h4{margin:0 0 4px;font-size:14px}',
      '.ptax-reg .big{font-size:22px;font-weight:700;margin:6px 0 2px}',
      '.ptax-reg .lower{color:var(--success);font-size:11.5px;font-weight:700}',
      '.ptax-sec{border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--bg2)}',
      '.ptax-sec-h{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline;margin-bottom:8px}',
      '.ptax-sec-h b{font-size:13px}',
      '.ptax-meter{font-size:12px;color:var(--text2);white-space:nowrap}',
      '.ptax-meter.over{color:var(--warn);font-weight:700}',
      '.ptax-item{display:grid;grid-template-columns:minmax(0,1fr) 130px auto 30px;gap:8px;align-items:center;padding:6px 0;border-top:1px dashed var(--border)}',
      '.ptax-item:first-of-type{border-top:none}',
      '@media (max-width:640px){.ptax-item{grid-template-columns:1fr 1fr}}',
      '.ptax-proofs{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px}',
      '.ptax-proof{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border2);border-radius:6px;padding:3px 8px;background:var(--bg3)}',
      '.ptax-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;user-select:none;white-space:nowrap}',
      '.ptax-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;z-index:1000;padding:24px 12px;overflow:auto}',
      '.ptax-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:880px;padding:20px;color:var(--text)}',
      '.ptax-modal h3{margin:0 0 4px;font-size:16px}',
      '.ptax-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--border)}',
      '.ptax-kv:last-child{border-bottom:none}',
      '.ptax-kv span:first-child{color:var(--text3)}',
      '.ptax-kv span:last-child{text-align:right;word-break:break-word}',
      '.ptax-list{margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6}',
      '.ptax-busy{opacity:.6;pointer-events:none}',
      '.ptax-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
      'html[data-theme="light"] .ptax-overlay{background:rgba(15,23,42,.35)}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── shared: regime comparison ─────────────────────────────────────────── */
  function compareTable(est) {
    var n = est.regimes.new, o = est.regimes.old;
    function row(label, a, b, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + esc(label) + '</td><td class="n">' + money(a) + '</td><td class="n">' + money(b) + '</td></tr>'; }
    var ni = n.income, oi = o.income, nt = n.tax, ot = o.tax;
    return '<div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Annual projection</th><th class="n">New regime</th><th class="n">Old regime</th></tr></thead><tbody>' +
      row('Gross taxable salary', ni.gross, oi.gross) +
      row('Standard deduction', ni.standard_deduction, oi.standard_deduction) +
      row('HRA exemption', ni.hra_exemption, oi.hra_exemption) +
      row('Professional tax', ni.professional_tax, oi.professional_tax) +
      row('80C (incl. employee PF)', ni.deductions['80C'], oi.deductions['80C']) +
      row('80CCD(1B) NPS', ni.deductions['80CCD1B'], oi.deductions['80CCD1B']) +
      row('80D health insurance', ni.deductions['80D'], oi.deductions['80D']) +
      row('24(b) home-loan interest', ni.deductions['24b'], oi.deductions['24b']) +
      row('Taxable income', ni.taxable, oi.taxable, 'tot') +
      row('Tax on slabs', nt.slab_tax, ot.slab_tax) +
      row('Rebate 87A (+ marginal relief)', nt.rebate_87a + nt.marginal_relief_87a, ot.rebate_87a + ot.marginal_relief_87a) +
      row('Surcharge', nt.surcharge, ot.surcharge) +
      row('Health & education cess', nt.cess, ot.cess) +
      row('Annual tax', nt.total, ot.total, 'tot') +
      row('TDS already deducted this FY', est.tds_paid, est.tds_paid) +
      row('TDS per remaining month', n.monthly_tds, o.monthly_tds, 'tot') +
      '</tbody></table></div>' +
      '<div class="ptax-hint">Projection: ' + esc(est.sample_month || '') + ' salary × ' + esc(est.months_left) +
      ' remaining month(s) + amounts already paid this year. ' +
      (est.uses_verified ? 'Old-regime deductions use HR-verified amounts.' : 'Old-regime deductions use your declared amounts until HR verifies them.') + '</div>';
  }
  function slabTable(tax) {
    var rows = (tax.slabs || []).map(function (s) {
      return '<tr><td>' + money(s.from) + ' – ' + (s.upto == null ? 'above' : money(s.upto)) + '</td><td class="n">' + esc(s.rate) + '%</td><td class="n">' + money(s.income) + '</td><td class="n">' + money(s.tax) + '</td></tr>';
    }).join('');
    return '<table class="ptax-table"><thead><tr><th>Slab</th><th class="n">Rate</th><th class="n">Income</th><th class="n">Tax</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ════════════════════════════ HR PAGE ═══════════════════════════════════ */
  var HR = { root: null, tab: 'tables', fy: currentFY(), token: 0, status: 'submitted', models: {}, retry: null };

  function hrMount(root) {
    HR.root = root;
    HR.token++;
    injectStyle();
    root.innerHTML =
      '<div class="ptax-page">' +
        '<div class="ptax-head"><div><h1 class="ptax-h1">Tax &amp; Statutory</h1>' +
          '<div class="ptax-sub">India income tax (Old / New regime), employee IT declarations and proofs, and statutory returns (EPFO ECR, ESIC, Form 24Q, Form 16).</div></div>' +
          '<div><select class="input-field ptax-inline" data-hr="fy">' + fyOptions(HR.fy) + '</select></div></div>' +
        '<div class="ptax-tabs">' +
          [['tables', 'Tax tables'], ['decl', 'Declarations'], ['stat', 'Statutory files'], ['preview', 'TDS preview']].map(function (t) {
            return '<button class="ptax-tab' + (HR.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
          }).join('') +
        '</div><div data-hr="body"></div></div>';
    on(root, '[data-tab]', 'click', function (e, el) {
      HR.tab = el.getAttribute('data-tab');
      qa(root, '[data-tab]').forEach(function (b) { b.classList.toggle('on', b === el); });
      hrTab();
    });
    q(root, '[data-hr="fy"]').addEventListener('change', function (e) { HR.fy = e.target.value; hrTab(); });
    hrTab();
  }
  function hrBody() { return HR.root && q(HR.root, '[data-hr="body"]'); }
  function hrTab() {
    HR.token++;
    var body = hrBody();
    if (!body) return;
    body.innerHTML = loading();
    ({ tables: tabTables, decl: tabDecl, stat: tabStat, preview: tabPreview })[HR.tab](body, HR.token);
  }
  function denied(body, e) {
    body.innerHTML = errBox(e.status === 403 ? 'You do not have access to this section. ' + (e.message || '') : (e.message || 'Could not load.'));
  }

  /* ── Tax tables ─────────────────────────────────────────────────────────── */
  function tabTables(body, tok) {
    api('/api/payroll/tax/tables?fy=' + encodeURIComponent(HR.fy)).then(function (d) {
      if (tok !== HR.token) return;
      HR.models = {};
      ['regime_new', 'regime_old'].forEach(function (k) { HR.models[k] = JSON.parse(JSON.stringify(d.tables[k].data)); });
      body.innerHTML = '<div class="ptax-info">Tables apply to FY ' + esc(d.fy) + '. TDS for every pay run in that year is computed from them. ' +
        (d.can_edit ? 'Edits are audited.' : 'You can view these tables; editing needs “Manage Tax Tables”.') + '</div>' +
        '<div class="ptax-grid2"><div class="card" data-card="regime_new"></div><div class="card" data-card="regime_old"></div></div>';
      ['regime_new', 'regime_old'].forEach(function (k) { paintTableCard(q(body, '[data-card="' + k + '"]'), k, d.tables[k], d.can_edit); });
    }).catch(function (e) { if (tok === HR.token) denied(body, e); });
  }
  function paintTableCard(card, kind, row, canEdit) {
    var m = HR.models[kind], ro = canEdit ? '' : ' disabled';
    function inp(path, val, extra) { return '<input class="input-field ptax-num" data-path="' + path + '" value="' + esc(val == null ? '' : val) + '"' + ro + (extra || '') + '>'; }
    var slabs = m.slabs.map(function (s, i) {
      var last = i === m.slabs.length - 1;
      return '<tr><td>' + (last ? '<span class="ptax-muted">No upper limit</span>' : inp('slabs.' + i + '.upto', s.upto)) + '</td><td>' + inp('slabs.' + i + '.rate', s.rate) + '</td><td>' +
        (canEdit && !last && m.slabs.length > 1 ? '<button class="ptax-x" data-del="slabs.' + i + '" title="Remove">×</button>' : '') + '</td></tr>';
    }).join('');
    var sur = m.surcharge.map(function (s, i) {
      return '<tr><td>' + inp('surcharge.' + i + '.above', s.above) + '</td><td>' + inp('surcharge.' + i + '.rate', s.rate) + '</td><td>' +
        (canEdit ? '<button class="ptax-x" data-del="surcharge.' + i + '" title="Remove">×</button>' : '') + '</td></tr>';
    }).join('');
    var lim = m.section_limits || {};
    card.innerHTML =
      '<div class="card-title">' + (kind === 'regime_new' ? 'New regime — Sec 115BAC' : 'Old regime') + '</div>' +
      (row.seeded ? '<div class="ptax-banner"><b>Seeded defaults — verify against the current Finance Act.</b> These values were filled in automatically; confirm them before the first pay run of the year.</div>' :
        '<div class="ptax-hint" style="margin-bottom:10px">Last edited by ' + esc(row.updated_by || '—') + ' · ' + esc(fmtDate(row.updated_at)) + '</div>') +
      '<div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Income up to (₹)</th><th>Rate %</th><th></th></tr></thead><tbody>' + slabs + '</tbody></table></div>' +
      (canEdit ? '<button class="btn-sm" data-add="slabs" style="margin:8px 0 12px">+ Add slab</button>' : '<div style="height:12px"></div>') +
      '<div class="ptax-row">' +
        '<div class="ptax-field"><label>Standard deduction</label>' + inp('standard_deduction', m.standard_deduction) + '</div>' +
        '<div class="ptax-field"><label>Cess %</label>' + inp('cess_pct', m.cess_pct) + '</div></div>' +
      '<div class="ptax-row">' +
        '<div class="ptax-field"><label>87A: taxable income up to</label>' + inp('rebate_limit', m.rebate_limit) + '</div>' +
        '<div class="ptax-field"><label>87A: max rebate</label>' + inp('rebate_max', m.rebate_max) + '</div></div>' +
      '<label class="ptax-check" style="margin-bottom:12px"><input type="checkbox" data-path="rebate_marginal_relief"' + (m.rebate_marginal_relief ? ' checked' : '') + ro + '> Marginal relief just above the 87A limit</label>' +
      '<div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Surcharge above (₹)</th><th>Rate %</th><th></th></tr></thead><tbody>' + sur + '</tbody></table></div>' +
      (canEdit ? '<button class="btn-sm" data-add="surcharge" style="margin:8px 0 12px">+ Add surcharge band</button>' : '<div style="height:12px"></div>') +
      '<div class="ptax-field"><label>Section limits (old regime deductions)</label><div class="ptax-row">' +
        [['80C', '80C'], ['80CCD1B', '80CCD(1B)'], ['80D', '80D'], ['80D_senior', '80D senior'], ['24b', '24(b)']].map(function (p) {
          return '<div class="ptax-field"><label>' + p[1] + '</label>' + inp('section_limits.' + p[0], lim[p[0]]) + '</div>';
        }).join('') + '</div></div>' +
      (canEdit ? '<div class="ptax-btns"><button class="btn-primary" data-save="1">Save ' + (kind === 'regime_new' ? 'new' : 'old') + ' regime</button></div>' : '') +
      '<div data-msg="1"></div>';
    on(card, '[data-path]', 'input', function (e, el) { setPath(m, el.getAttribute('data-path'), el.type === 'checkbox' ? el.checked : el.value); });
    on(card, '[data-path]', 'change', function (e, el) { if (el.type === 'checkbox') setPath(m, el.getAttribute('data-path'), el.checked); });
    on(card, '[data-del]', 'click', function (e, el) {
      var p = el.getAttribute('data-del').split('.');
      m[p[0]].splice(parseInt(p[1], 10), 1);
      paintTableCard(card, kind, row, canEdit);
    });
    on(card, '[data-add]', 'click', function (e, el) {
      var k = el.getAttribute('data-add');
      if (k === 'slabs') m.slabs.splice(m.slabs.length - 1, 0, { upto: '', rate: '' });
      else m.surcharge.push({ above: '', rate: '' });
      paintTableCard(card, kind, row, canEdit);
    });
    on(card, '[data-save]', 'click', function (e, btn) {
      var msg = q(card, '[data-msg]');
      var data = JSON.parse(JSON.stringify(m));
      data.slabs = data.slabs.map(function (s, i) { return { upto: i === data.slabs.length - 1 ? null : String(s.upto).trim(), rate: String(s.rate).trim() }; });
      busy(btn, true, 'Saving…');
      api('/api/payroll/tax/tables', { method: 'PUT', body: { fy: HR.fy, kind: kind, data: data } }).then(function (r) {
        HR.models[kind] = JSON.parse(JSON.stringify(r.data));
        paintTableCard(card, kind, r, canEdit);
        q(card, '[data-msg]').innerHTML = okBox('Saved. New pay runs will use these values.');
      }).catch(function (er) { busy(btn, false); msg.innerHTML = errBox(er.message); });
    });
  }
  function setPath(obj, path, val) {
    var p = path.split('.'), o = obj;
    for (var i = 0; i < p.length - 1; i++) o = o[p[i]];
    o[p[p.length - 1]] = val;
  }

  /* ── Declarations ───────────────────────────────────────────────────────── */
  function tabDecl(body, tok) {
    var url = '/api/payroll/tax/declarations?fy=' + encodeURIComponent(HR.fy) + (HR.status ? '&status=' + HR.status : '');
    api(url).then(function (d) {
      if (tok !== HR.token) return;
      var c = d.counts || {}, w = d.window || {};
      var chips = [['', 'All'], ['submitted', 'Submitted'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['locked', 'Locked'], ['draft', 'Draft']].map(function (s) {
        var n = s[0] ? (c[s[0]] || 0) : Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0);
        return '<button class="ptax-chip' + (HR.status === s[0] ? ' on' : '') + '" data-st="' + s[0] + '">' + s[1] + ' (' + n + ')</button>';
      }).join('');
      var rows = (d.results || []).map(function (r) {
        return '<tr class="click" data-open="' + r.id + '"><td><b>' + esc(r.employee_name) + '</b><div class="ptax-muted" style="font-size:11.5px">' + esc(r.email) + '</div></td>' +
          '<td>' + esc(r.regime === 'old' ? 'Old' : 'New') + (r.regime_locked ? ' 🔒' : '') + '</td><td>' + badge(r.status) + '</td>' +
          '<td class="n">' + esc(r.items) + '</td><td class="n">' + money(r.declared_total) + '</td><td class="n">' + money(r.monthly_rent) + '</td>' +
          '<td class="n">' + esc(r.proofs) + (r.pending_proofs ? ' <span class="ptax-muted">(' + r.pending_proofs + ' pending)</span>' : '') + '</td>' +
          '<td>' + esc(fmtDate(r.submitted_at)) + '</td></tr>';
      }).join('');
      body.innerHTML =
        '<div class="card" style="margin-bottom:16px"><div class="card-title">Proof window &amp; year-end lock</div>' +
          '<div class="ptax-row"><div class="ptax-field"><label>Proofs open from (MM-DD)</label><input class="input-field" data-w="start" value="' + esc(w.start) + '" maxlength="5"></div>' +
          '<div class="ptax-field"><label>Until (MM-DD)</label><input class="input-field" data-w="end" value="' + esc(w.end) + '" maxlength="5"></div>' +
          '<div class="ptax-field"><button class="btn-sm" data-wsave="1">Save window</button></div>' +
          '<div class="ptax-field"><button class="btn-primary" data-lockall="1">Lock all verified</button></div></div>' +
          '<div class="ptax-hint">Window is currently <b>' + (w.open ? 'open' : 'closed') + '</b>. Employees upload proofs only inside it; declarations can be edited any time until locked. Lock declarations before the final (March) TDS run.</div>' +
          '<div data-wmsg="1"></div></div>' +
        '<div class="ptax-chips">' + chips + '</div>' +
        (rows ? '<div class="card"><div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Employee</th><th>Regime</th><th>Status</th><th class="n">Items</th><th class="n">Declared</th><th class="n">Rent / month</th><th class="n">Proofs</th><th>Submitted</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
          : '<div class="card"><div class="ptax-empty">No declarations in this view for FY ' + esc(HR.fy) + '.</div></div>');
      on(body, '[data-st]', 'click', function (e, el) { HR.status = el.getAttribute('data-st'); hrTab(); });
      on(body, '[data-open]', 'click', function (e, el) { openDecl(parseInt(el.getAttribute('data-open'), 10)); });
      on(body, '[data-wsave]', 'click', function (e, btn) {
        busy(btn, true, 'Saving…');
        api('/api/payroll/tax/window', { method: 'PUT', body: { start: q(body, '[data-w="start"]').value.trim(), end: q(body, '[data-w="end"]').value.trim() } })
          .then(function () { hrTab(); }).catch(function (er) { busy(btn, false); q(body, '[data-wmsg]').innerHTML = errBox(er.message); });
      });
      on(body, '[data-lockall]', 'click', function (e, btn) {
        if (!window.confirm('Lock every verified declaration for FY ' + HR.fy + '? Employees will no longer be able to edit them or change their regime.')) return;
        busy(btn, true, 'Locking…');
        api('/api/payroll/tax/declarations/lock-verified', { method: 'POST', body: { fy: HR.fy } })
          .then(function (r) { hrTab(); setTimeout(function () { var m = q(hrBody(), '[data-wmsg]'); if (m) m.innerHTML = okBox(r.locked + ' declaration(s) locked.'); }, 400); })
          .catch(function (er) { busy(btn, false); q(body, '[data-wmsg]').innerHTML = errBox(er.message); });
      });
    }).catch(function (e) { if (tok === HR.token) denied(body, e); });
  }

  function modal(html) {
    var ov = document.createElement('div');
    ov.className = 'ptax-overlay';
    ov.innerHTML = '<div class="ptax-modal">' + html + '</div>';
    (HR.root || document.body).appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    return { el: ov, close: close };
  }

  function proofCtl(p, editable) {
    return '<div class="ptax-proof" data-proof="' + p.id + '"><button class="ptax-link" data-view="' + p.id + '">' + esc(p.file_name) + '</button>' +
      (editable ? '<select class="input-field" style="padding:3px 6px;width:auto" data-pst="' + p.id + '">' +
        ['pending', 'accepted', 'rejected'].map(function (s) { return '<option' + (s === p.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select><input class="input-field" style="padding:3px 6px;width:150px" placeholder="Note" data-pnote="' + p.id + '" value="' + esc(p.note) + '" maxlength="255">'
        : badge(p.status)) + '</div>';
  }
  function viewProof(id, host, msgEl) {
    api('/api/payroll/tax/proofs/' + id + '/file').then(function (f) { saveFile(f.file_name, f.mime, f.data, 'base64', host); })
      .catch(function (e) { if (msgEl) msgEl.innerHTML = errBox(e.message); });
  }

  function openDecl(id) {
    var mm = modal(loading());
    var box = q(mm.el, '.ptax-modal');
    api('/api/payroll/tax/declarations/' + id).then(function (d) { paintDecl(mm, box, d); })
      .catch(function (e) { box.innerHTML = errBox(e.message) + '<button class="btn-sm" data-close="1">Close</button>'; on(box, '[data-close]', 'click', mm.close); });
  }
  function paintDecl(mm, box, d) {
    var editable = !d.own && d.status !== 'locked';
    var proofsBy = {};
    (d.proofs || []).forEach(function (p) { (proofsBy[p.item_id] = proofsBy[p.item_id] || []).push(p); });
    var items = (d.items || []).map(function (it) {
      var v = it.verified == null ? it.declared : it.verified;
      return '<tr><td>' + esc(it.section) + (it.senior ? ' <span class="ptax-muted">(senior)</span>' : '') + '</td><td>' + esc(it.description || '—') + '</td>' +
        '<td class="n">' + money(it.declared) + '</td><td class="n">' + (editable ? '<input class="input-field ptax-num" data-ver="' + esc(it.id) + '" value="' + esc(v) + '">' : money(it.verified)) + '</td></tr>' +
        ((proofsBy[it.id] || []).length ? '<tr><td></td><td colspan="3"><div class="ptax-proofs">' + proofsBy[it.id].map(function (p) { return proofCtl(p, editable); }).join('') + '</div></td></tr>' : '');
    }).join('');
    var h = d.hra || {};
    var hra = h.monthly_rent > 0 ?
      '<div class="card-title" style="margin-top:14px">HRA — rent</div>' +
      '<div class="ptax-kv"><span>Monthly rent</span><span>' + money(h.monthly_rent) + (h.metro ? ' · metro' : ' · non-metro') + '</span></div>' +
      '<div class="ptax-kv"><span>Landlord</span><span>' + esc(h.landlord_name || '—') + ' · PAN ' + esc(h.landlord_pan || (h.pan_required ? 'missing' : 'not needed')) + '</span></div>' +
      '<div class="ptax-kv"><span>Verified monthly rent</span><span>' + (editable ? '<input class="input-field ptax-num" data-hraver="1" value="' + esc(h.verified_monthly_rent == null ? h.monthly_rent : h.verified_monthly_rent) + '">' : money(h.verified_monthly_rent)) + '</span></div>' +
      ((proofsBy.hra || []).length ? '<div class="ptax-proofs" style="margin-top:6px">' + proofsBy.hra.map(function (p) { return proofCtl(p, editable); }).join('') + '</div>' : '') : '';
    box.innerHTML =
      '<div class="ptax-btns" style="justify-content:space-between"><div><h3>' + esc(d.employee_name) + '</h3><div class="ptax-muted" style="font-size:12px">' + esc(d.email) + ' · FY ' + esc(d.fy) + '</div></div>' +
        '<div class="ptax-btns">' + badge(d.status) + '<button class="ptax-x" data-close="1" title="Close">×</button></div></div>' +
      (d.own ? '<div class="ptax-banner">This is your own declaration — another verifier must review it.</div>' : '') +
      '<div class="ptax-row" style="margin:12px 0"><div class="ptax-field"><label>Regime</label><select class="input-field" data-reg="1"' + (d.own ? ' disabled' : '') + '>' +
        '<option value="new"' + (d.regime === 'new' ? ' selected' : '') + '>New (115BAC)</option><option value="old"' + (d.regime === 'old' ? ' selected' : '') + '>Old</option></select></div>' +
        '<div class="ptax-field"><label class="ptax-check"><input type="checkbox" data-reglock="1"' + (d.regime_locked ? ' checked' : '') + (d.own ? ' disabled' : '') + '> Regime locked</label>' +
        '<div class="ptax-hint">' + esc(d.regime_lock_reason || 'Employee can still change it.') + '</div></div>' +
        (d.own ? '' : '<div class="ptax-field"><button class="btn-sm" data-regsave="1">Apply regime</button></div>') + '</div>' +
      (items ? '<div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Section</th><th>Description</th><th class="n">Declared</th><th class="n">Verified</th></tr></thead><tbody>' + items + '</tbody></table></div>'
        : '<div class="ptax-empty" style="padding:14px">No investment items declared.</div>') +
      hra +
      '<div class="ptax-field" style="margin-top:14px"><label>Note to employee</label><textarea class="input-field" data-note="1" rows="2" maxlength="1000"' + (editable ? '' : ' disabled') + '>' + esc(d.reviewer_note) + '</textarea></div>' +
      (d.verified_by ? '<div class="ptax-hint">Last reviewed by ' + esc(d.verified_by) + ' · ' + esc(fmtDate(d.verified_at)) + '</div>' : '') +
      '<div data-msg="1"></div>' +
      '<div class="ptax-btns" style="margin-top:12px">' +
        (editable ? '<button class="btn-sm" data-dec="save">Save review</button><button class="btn-sm" data-dec="rejected">Reject</button><button class="btn-primary" data-dec="verified">Verify</button>' : '') +
        (!d.own && d.status === 'verified' ? '<button class="btn-primary" data-lock="lock">Lock for final TDS</button>' : '') +
        (!d.own && d.status === 'locked' ? '<button class="btn-sm" data-lock="unlock">Unlock</button>' : '') +
      '</div>';
    var msg = q(box, '[data-msg]');
    on(box, '[data-close]', 'click', function () { mm.close(); hrTab(); });
    on(box, '[data-view]', 'click', function (e, el) { viewProof(el.getAttribute('data-view'), box, msg); });
    function reload(r) { paintDecl(mm, box, r); }
    on(box, '[data-dec]', 'click', function (e, btn) {
      var dec = btn.getAttribute('data-dec');
      var body = { decision: dec, note: q(box, '[data-note]').value,
        items: qa(box, '[data-ver]').map(function (i) { return { id: i.getAttribute('data-ver'), verified: i.value.trim() === '' ? null : i.value.trim() }; }),
        proofs: qa(box, '[data-pst]').map(function (s) { var id = s.getAttribute('data-pst'); return { id: parseInt(id, 10), status: s.value, note: q(box, '[data-pnote="' + id + '"]').value }; }) };
      var hv = q(box, '[data-hraver]');
      if (hv) body.hra_verified_monthly_rent = hv.value.trim() === '' ? null : hv.value.trim();
      busy(btn, true);
      api('/api/payroll/tax/declarations/' + d.id + '/review', { method: 'POST', body: body }).then(reload)
        .catch(function (er) { busy(btn, false); msg.innerHTML = errBox(er.message); });
    });
    on(box, '[data-lock]', 'click', function (e, btn) {
      busy(btn, true);
      api('/api/payroll/tax/declarations/' + d.id + '/lock', { method: 'POST', body: { action: btn.getAttribute('data-lock') } })
        .then(function (r) { r.own = false; reload(r); }).catch(function (er) { busy(btn, false); msg.innerHTML = errBox(er.message); });
    });
    on(box, '[data-regsave]', 'click', function (e, btn) {
      busy(btn, true);
      api('/api/payroll/tax/declarations/' + d.id + '/regime', { method: 'POST', body: { regime: q(box, '[data-reg]').value, regime_locked: q(box, '[data-reglock]').checked } })
        .then(function (r) { r.own = false; r.proofs = d.proofs; reload(r); }).catch(function (er) { busy(btn, false); msg.innerHTML = errBox(er.message); });
    });
  }

  /* ── Statutory files ────────────────────────────────────────────────────── */
  function tabStat(body, tok) {
    Promise.all([api('/api/payroll/statutory/options'), api('/api/payroll/statutory/filings')]).then(function (res) {
      if (tok !== HR.token) return;
      var o = res[0], f = res[1].results || [];
      var runs = (o.runs || []).map(function (r) { return '<option value="' + r.id + '">' + esc(r.period_label) + ' · ' + esc(r.status) + ' · ' + esc(r.employee_count) + ' emp</option>'; }).join('');
      var hist = f.map(function (x) {
        return '<tr><td>' + badge(x.kind, 'ptax-c-accent') + '</td><td>' + esc(x.period) + '</td><td class="ptax-mono">' + esc(x.file_name) + (x.email ? '<div class="ptax-muted">' + esc(x.email) + '</div>' : '') + '</td>' +
          '<td class="n">' + esc(x.row_count) + '</td><td>' + esc(x.generated_by) + '</td><td>' + esc(fmtDate(x.generated_at)) + '</td>' +
          '<td><button class="btn-sm" data-dl="' + x.id + '">Download</button></td></tr>';
      }).join('');
      body.innerHTML =
        '<div class="ptax-info">Generating or downloading statutory files needs a <b>fresh sign-in</b>. If you are asked to sign in again, sign out and back in, then retry. Every file is stored with its SHA-256 and every generation / download is audited.</div>' +
        '<div class="ptax-grid2">' +
          '<div class="card"><div class="card-title">Monthly returns (pay run)</div>' +
            '<div class="ptax-field"><label>Pay run</label><select class="input-field" data-s="run">' + (runs || '<option value="">No pay runs yet</option>') + '</select></div>' +
            '<div class="ptax-btns"><button class="btn-primary" data-gen="ecr">EPFO ECR</button><button class="btn-primary" data-gen="esic">ESIC contribution</button></div>' +
            '<div class="ptax-hint">ECR: one line per PF member, fields separated by #~#, EPS/EDLI wages capped at ₹15,000. ESIC: employees with gross ≤ ₹21,000; Excel-compatible CSV (save as .xls if the portal insists).</div></div>' +
          '<div class="card"><div class="card-title">Form 24Q — quarterly TDS</div>' +
            '<div class="ptax-row"><div class="ptax-field"><label>Financial year</label><select class="input-field" data-s="fy24">' + fyOptions(HR.fy, o.fys) + '</select></div>' +
            '<div class="ptax-field"><label>Quarter</label><select class="input-field" data-s="q">' +
              ['Q1 (Apr–Jun)', 'Q2 (Jul–Sep)', 'Q3 (Oct–Dec)', 'Q4 (Jan–Mar)'].map(function (l, i) { return '<option value="' + (i + 1) + '">' + l + '</option>'; }).join('') + '</select></div></div>' +
            '<div class="ptax-btns"><button class="btn-primary" data-gen="24q">Generate 24Q data</button></div>' +
            '<div class="ptax-banner" style="margin-top:10px">' + esc(o.fvu_note) + ' Q4 also produces Annexure II (salary details).</div></div>' +
          '<div class="card"><div class="card-title">Form 16</div>' +
            '<div class="ptax-row"><div class="ptax-field"><label>Financial year</label><select class="input-field" data-s="fy16">' + fyOptions(HR.fy, o.fys) + '</select></div>' +
            '<div class="ptax-field"><label>Employee email (blank = everyone)</label><input class="input-field" data-s="em16" placeholder="name@company.com"></div></div>' +
            '<div class="ptax-btns"><button class="btn-primary" data-gen="form16">Generate Part B</button></div>' +
            '<div class="ptax-hint">Part B (salary, deductions, tax computation) is generated from payroll. <b>Part A comes from TRACES</b> — download it there and attach it below.</div>' +
            '<div class="ptax-row" style="margin-top:10px"><div class="ptax-field"><label>Part A for (email)</label><input class="input-field" data-s="emA" placeholder="name@company.com"></div>' +
            '<div class="ptax-field"><label>TRACES PDF</label><input type="file" accept="application/pdf" class="input-field" data-s="fileA"></div>' +
            '<div class="ptax-field"><button class="btn-sm" data-gen="parta">Upload Part A</button></div></div></div>' +
          '<div class="card"><div class="card-title">Employer details</div>' +
            '<div class="ptax-row"><div class="ptax-field"><label>Employer TAN</label><input class="input-field" data-s="tan" value="' + esc(o.employer_tan) + '" maxlength="10" placeholder="ABCD12345E"></div>' +
            '<div class="ptax-field"><button class="btn-sm" data-gen="tan">Save TAN</button></div></div>' +
            (o.tan_configured ? '' : '<div class="ptax-hint" style="color:var(--warn)">TAN is not configured — Form 16 will flag it.</div>') +
            '<div class="ptax-row" style="margin-top:6px"><div class="ptax-field"><label>ESIC IP number for (email)</label><input class="input-field" data-s="ipem" placeholder="name@company.com"></div>' +
            '<div class="ptax-field"><label>IP number (10 digits, blank = remove)</label><input class="input-field" data-s="ip" maxlength="10"></div>' +
            '<div class="ptax-field"><button class="btn-sm" data-gen="ip">Save</button></div></div>' +
            '<div class="ptax-hint">' + esc(o.esic_ip_count) + ' ESIC IP number(s) on file.</div></div>' +
        '</div>' +
        '<div data-result="1" style="margin-top:16px"></div>' +
        '<div class="card" style="margin-top:16px"><div class="card-title">Generated files</div>' +
          (hist ? '<div class="ptax-table-wrap"><table class="ptax-table"><thead><tr><th>Kind</th><th>Period</th><th>File</th><th class="n">Rows</th><th>By</th><th>When</th><th></th></tr></thead><tbody>' + hist + '</tbody></table></div>'
            : '<div class="ptax-empty">Nothing generated yet.</div>') + '</div>';
      bindStat(body);
    }).catch(function (e) { if (tok === HR.token) denied(body, e); });
  }
  function val(body, k) { var el = q(body, '[data-s="' + k + '"]'); return el ? String(el.value || '').trim() : ''; }
  function problemsHtml(title, list) {
    if (!list || !list.length) return '';
    return '<div style="margin-top:8px"><b style="font-size:12.5px">' + esc(title) + '</b><ul class="ptax-list">' + list.map(function (p) {
      return '<li>' + (typeof p === 'string' ? esc(p) : esc((p.name ? p.name + ' — ' : '') + p.issue)) + '</li>';
    }).join('') + '</ul></div>';
  }
  function bindStat(body) {
    var out = q(body, '[data-result]');
    function show(r, partialFn) {
      var made = r.filings || (r.filing ? [r.filing] : []);
      out.innerHTML = '<div class="card">' +
        (made.length ? okBox('Generated: ' + made.map(function (m) { return m.file_name + ' (' + m.row_count + ' rows)'; }).join(', ')) : '') +
        (r.fvu_note ? '<div class="ptax-banner">' + esc(r.fvu_note) + '</div>' : '') +
        (r.note ? '<div class="ptax-info">' + esc(r.note) + '</div>' : '') +
        problemsHtml('Problems (these employees are not in the file)', r.problems) +
        problemsHtml('Warnings', r.warnings) +
        problemsHtml('Not included', r.skipped) + '</div>';
      setTimeout(function () { var tb = hrBody(); if (tb && made.length) { var keep = out.innerHTML; tabStat(tb, HR.token); setTimeout(function () { var o2 = q(hrBody(), '[data-result]'); if (o2) o2.innerHTML = keep; }, 600); } }, 50);
    }
    function fail(e, again) {
      var d = e.data || {};
      out.innerHTML = '<div class="card">' + errBox(e.message) + problemsHtml('Problems', d.problems) + problemsHtml('Warnings', d.warnings) +
        (again && d.problems && d.problems.length ? '<button class="btn-sm" data-partial="1">Generate anyway, leaving these employees out</button>' : '') + '</div>';
      var pb = q(out, '[data-partial]');
      if (pb) pb.addEventListener('click', function () { busy(pb, true); again(); });
    }
    function gen(url, payload, btn) {
      busy(btn, true, 'Generating…');
      var go = function (partial) {
        var b = JSON.parse(JSON.stringify(payload));
        if (partial) b.allow_partial = true;
        return api(url, { method: 'POST', body: b }).then(function (r) { busy(btn, false); show(r); })
          .catch(function (e) { busy(btn, false); fail(e, payload.hasOwnProperty('allow_partial') ? function () { go(true); } : null); });
      };
      go(false);
    }
    on(body, '[data-gen]', 'click', function (e, btn) {
      var k = btn.getAttribute('data-gen'), run = parseInt(val(body, 'run'), 10);
      if (k === 'ecr' || k === 'esic') {
        if (!run) { out.innerHTML = errBox('Pick a pay run.'); return; }
        gen('/api/payroll/statutory/' + k, { run_id: run, allow_partial: false }, btn);
      } else if (k === '24q') {
        gen('/api/payroll/statutory/24q', { fy: val(body, 'fy24'), quarter: parseInt(val(body, 'q'), 10), allow_partial: false }, btn);
      } else if (k === 'form16') {
        var p = { fy: val(body, 'fy16') };
        if (val(body, 'em16')) p.email = val(body, 'em16');
        gen('/api/payroll/statutory/form16', p, btn);
      } else if (k === 'parta') {
        var fileEl = q(body, '[data-s="fileA"]'), file = fileEl.files && fileEl.files[0];
        if (!file) { out.innerHTML = errBox('Choose the TRACES Part A PDF.'); return; }
        if (file.size > 5 * 1024 * 1024) { out.innerHTML = errBox('Files must be 5 MB or smaller.'); return; }
        busy(btn, true, 'Uploading…');
        readFile(file).then(function (b64) {
          return api('/api/payroll/statutory/form16/part-a', { method: 'POST', body: { fy: val(body, 'fy16'), email: val(body, 'emA'), file_name: file.name, mime: fileMime(file), data: b64 } });
        }).then(function (r) { busy(btn, false); show(r); }).catch(function (er) { busy(btn, false); fail(er); });
      } else if (k === 'tan') {
        busy(btn, true, 'Saving…');
        api('/api/payroll/statutory/employer', { method: 'PUT', body: { tan: val(body, 'tan') } })
          .then(function () { busy(btn, false); out.innerHTML = okBox('Employer TAN saved.'); }).catch(function (er) { busy(btn, false); fail(er); });
      } else if (k === 'ip') {
        busy(btn, true, 'Saving…');
        api('/api/payroll/statutory/esic-ip', { method: 'PUT', body: { email: val(body, 'ipem'), ip_number: val(body, 'ip') } })
          .then(function (r) { busy(btn, false); out.innerHTML = okBox('Saved. ' + r.count + ' ESIC IP number(s) on file.'); }).catch(function (er) { busy(btn, false); fail(er); });
      }
    });
    on(body, '[data-dl]', 'click', function (e, btn) {
      busy(btn, true, '…');
      api('/api/payroll/statutory/filings/' + btn.getAttribute('data-dl') + '/download').then(function (f) {
        busy(btn, false);
        saveFile(f.file_name, f.mime, f.content, f.encoding, HR.root);
      }).catch(function (er) { busy(btn, false); out.innerHTML = errBox(er.message); });
    });
  }

  /* ── TDS preview ────────────────────────────────────────────────────────── */
  function tabPreview(body, tok) {
    api('/api/payroll/tax/employees').then(function (d) {
      if (tok !== HR.token) return;
      var opts = (d.results || []).map(function (e) { return '<option value="' + esc(e.email) + '">' + esc(e.name) + ' — ' + esc(e.email) + '</option>'; }).join('');
      body.innerHTML = '<div class="card"><div class="ptax-row"><div class="ptax-field" style="flex:3"><label>Employee (INR salaries)</label><select class="input-field" data-pv="em">' +
        (opts || '<option value="">No active INR compensations</option>') + '</select></div>' +
        '<div class="ptax-field"><button class="btn-primary" data-pv="go">Show projection</button></div></div>' +
        '<div class="ptax-hint">Runs the same calculation as a pay run for one month of FY ' + esc(HR.fy) + ' and projects the year for both regimes. Nothing is saved.</div></div>' +
        '<div data-pv="out" style="margin-top:16px"></div>';
      q(body, '[data-pv="go"]').addEventListener('click', function (e) {
        var btn = e.currentTarget, em = q(body, '[data-pv="em"]').value, out = q(body, '[data-pv="out"]');
        if (!em) return;
        busy(btn, true, 'Calculating…');
        api('/api/payroll/tax/preview?email=' + encodeURIComponent(em) + '&fy=' + encodeURIComponent(HR.fy)).then(function (p) {
          busy(btn, false);
          if (!p.available) { out.innerHTML = '<div class="card">' + errBox(p.reason) + '</div>'; return; }
          var ch = p.regimes[p.regime];
          out.innerHTML = '<div class="ptax-grid2"><div class="card"><div class="card-title">' + esc(p.employee_name) + ' — FY ' + esc(p.fy) + '</div>' +
            '<div class="ptax-kv"><span>Chosen regime</span><span>' + (p.regime === 'old' ? 'Old' : 'New (115BAC)') + '</span></div>' +
            '<div class="ptax-kv"><span>Declaration</span><span>' + badge(p.declaration_status) + '</span></div>' +
            '<div class="ptax-kv"><span>Sample month</span><span>' + esc(p.sample_month) + ' · gross ' + money(p.monthly_gross) + '</span></div>' +
            '<div class="ptax-kv"><span>Months left incl. this one</span><span>' + esc(p.months_left) + '</span></div>' +
            '<div class="ptax-kv"><span>Paid earlier this FY</span><span>' + money(p.prior.taxable) + ' (' + esc(p.prior.months) + ' month(s))</span></div>' +
            '<div class="ptax-kv"><span>TDS deducted so far</span><span>' + money(p.tds_paid) + '</span></div>' +
            '<div class="ptax-kv"><span><b>TDS this month</b></span><span><b>' + money(p.tds_this_month) + '</b></span></div></div>' +
            '<div class="card"><div class="card-title">Slabs — chosen regime</div>' + slabTable(ch.tax) + '</div></div>' +
            '<div class="card" style="margin-top:16px"><div class="card-title">Old vs new</div>' + compareTable(p) + '</div>';
        }).catch(function (er) { busy(btn, false); out.innerHTML = errBox(er.message); });
      });
    }).catch(function (e) { if (tok === HR.token) denied(body, e); });
  }

  /* ═════════════════════════ EMPLOYEE PAGE ════════════════════════════════ */
  var ME = { root: null, fy: currentFY(), token: 0, d: null, items: [], hra: {}, est: null };
  var SECTION_HELP = {
    '80C': 'PPF, ELSS, LIC premium, children’s tuition fees, home-loan principal, NSC, 5-year FD, Sukanya Samriddhi. Your employee PF is added automatically.',
    '80CCD1B': 'Your own additional NPS contribution (over and above 80C).',
    '80D': 'Health insurance premium for yourself, spouse and children. Tick “senior” if any insured person is 60+.',
    '80D_parents': 'Health insurance premium for your parents. Tick “senior” if a parent is 60+.',
    '24b': 'Interest on a housing loan for a self-occupied home.'
  };

  function meMount(root) {
    ME.root = root;
    ME.token++;
    injectStyle();
    root.innerHTML = '<div class="ptax-page"><div class="ptax-head"><div><h1 class="ptax-h1">Tax Declaration</h1>' +
      '<div class="ptax-sub">Choose your income-tax regime for the year, declare investments and rent, and upload proofs when HR opens the proof window.</div></div>' +
      '<div><select class="input-field ptax-inline" data-me="fy">' + fyOptions(ME.fy) + '</select></div></div><div data-me="body"></div></div>';
    q(root, '[data-me="fy"]').addEventListener('change', function (e) { ME.fy = e.target.value; meLoad(); });
    meLoad();
  }
  function meBody() { return ME.root && q(ME.root, '[data-me="body"]'); }
  function meLoad(flash) {
    var tok = ++ME.token, body = meBody();
    if (!body) return;
    body.innerHTML = loading();
    api('/api/me/tax/declaration?fy=' + encodeURIComponent(ME.fy)).then(function (d) {
      if (tok !== ME.token) return;
      ME.d = d;
      ME.items = (d.items || []).map(function (it) { return JSON.parse(JSON.stringify(it)); });
      ME.hra = { monthly_rent: d.hra.monthly_rent || '', metro: !!d.hra.metro, landlord_name: d.hra.landlord_name || '', landlord_pan: '' };
      mePaint(flash);
      api('/api/me/tax/estimate?fy=' + encodeURIComponent(ME.fy)).then(function (est) { if (tok === ME.token) { ME.est = est; paintEstimate(); } })
        .catch(function (e) { if (tok === ME.token) { ME.est = { available: false, reason: e.message }; paintEstimate(); } });
      api('/api/me/tax/forms').then(function (r) { if (tok === ME.token) paintForms(r.results || []); }).catch(function () {});
    }).catch(function (e) { if (tok === ME.token) body.innerHTML = errBox(e.message); });
  }

  function mePaint(flash) {
    var d = ME.d, body = meBody(), w = d.window || {};
    var statusNote = {
      draft: 'Draft — not yet sent to HR.', submitted: 'Submitted — waiting for HR to verify.', verified: 'Verified by HR. Editing sends it back to draft.',
      rejected: 'HR sent this back. Fix it and submit again.', locked: 'Locked by HR for the final TDS of the year.'
    }[d.status] || '';
    body.innerHTML =
      (flash ? okBox(flash) : '') +
      '<div class="card" style="margin-bottom:16px"><div class="ptax-btns" style="justify-content:space-between"><div>' + badge(d.status) + ' <span class="ptax-muted" style="font-size:12.5px">' + esc(statusNote) + '</span></div>' +
        '<div class="ptax-muted" style="font-size:12px">Proof window ' + esc(w.start) + ' → ' + esc(w.end) + ' (MM-DD): <b>' + (d.can_upload ? 'open' : 'closed') + '</b></div></div>' +
        (d.reviewer_note ? '<div class="ptax-info" style="margin:10px 0 0"><b>Note from HR:</b> ' + esc(d.reviewer_note) + '</div>' : '') + '</div>' +
      '<div class="card" style="margin-bottom:16px"><div class="card-title">Tax regime for FY ' + esc(d.fy) + '</div><div data-me="regime"></div></div>' +
      '<div class="card" style="margin-bottom:16px"><div class="card-title">Investments &amp; deductions <span class="ptax-muted" style="font-weight:400">(count only under the old regime)</span></div>' +
        '<div data-me="sections"></div></div>' +
      '<div class="card" style="margin-bottom:16px"><div class="card-title">House rent (HRA)</div><div data-me="hra"></div></div>' +
      '<div data-me="msg"></div>' +
      (d.can_edit ? '<div class="ptax-btns" style="margin-bottom:16px"><button class="btn-sm" data-me="save">Save draft</button>' +
        (d.status === 'draft' || d.status === 'rejected' || d.status === 'submitted' || d.status === 'verified' ? '<button class="btn-primary" data-me="submit">Save &amp; submit to HR</button>' : '') + '</div>' : '') +
      '<div class="card"><div class="card-title">Form 16</div><div data-me="forms"><div class="ptax-muted" style="font-size:12.5px">Loading…</div></div></div>';
    paintEstimate();
    paintSections();
    paintHra();
    var sv = q(body, '[data-me="save"]'), sb = q(body, '[data-me="submit"]');
    if (sv) sv.addEventListener('click', function () { meSave(sv, false); });
    if (sb) sb.addEventListener('click', function () { meSave(sb, true); });
  }

  function paintEstimate() {
    var box = ME.root && q(ME.root, '[data-me="regime"]');
    if (!box || !ME.d) return;
    var d = ME.d, est = ME.est;
    var lockTxt = d.regime_locked ? '<div class="ptax-info">🔒 ' + esc(d.regime_lock_reason) + '</div>' :
      '<div class="ptax-hint" style="margin-bottom:10px">The new regime is the default. Pick at the start of the year — the choice is frozen once HR locks it or the first payroll of the year is finalised.</div>';
    function tile(r, title) {
      var e = est && est.available ? est.regimes[r] : null, other = est && est.available ? est.regimes[r === 'new' ? 'old' : 'new'] : null;
      var lower = e && other && e.tax.total < other.tax.total;
      return '<div class="ptax-reg' + (d.regime === r ? ' on' : '') + '"><h4>' + title + (d.regime === r ? ' · <span style="color:var(--accent)">your choice</span>' : '') + '</h4>' +
        (e ? '<div class="big">' + money(e.tax.total) + '</div><div class="ptax-muted" style="font-size:12px">estimated tax for the year · ' + money(e.monthly_tds) + ' / month</div>' +
          (lower ? '<div class="lower">Lower for you</div>' : '') : '<div class="ptax-muted" style="font-size:12.5px;margin:8px 0">' + (est ? esc(est.reason || 'No estimate') : 'Estimating…') + '</div>') +
        (d.regime !== r && !d.regime_locked && d.can_edit ? '<button class="btn-sm" style="margin-top:10px" data-pick="' + r + '">Switch to ' + (r === 'new' ? 'new' : 'old') + ' regime</button>' : '') + '</div>';
    }
    box.innerHTML = lockTxt + '<div class="ptax-regimes">' + tile('new', 'New regime (115BAC)') + tile('old', 'Old regime') + '</div>' +
      (est && est.available ? '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12.5px;color:var(--accent)">Show the side-by-side calculation</summary><div style="margin-top:10px">' + compareTable(est) + '</div></details>' : '') +
      '<div data-me="rmsg"></div>';
    on(box, '[data-pick]', 'click', function (e, btn) {
      var r = btn.getAttribute('data-pick');
      if (!window.confirm('Switch to the ' + r + ' regime for FY ' + d.fy + '? TDS from the next payroll will use it.')) return;
      busy(btn, true);
      api('/api/me/tax/regime', { method: 'POST', body: { fy: d.fy, regime: r } }).then(function () { meLoad('Regime updated.'); })
        .catch(function (er) { busy(btn, false); q(box, '[data-me="rmsg"]').innerHTML = errBox(er.message); });
    });
  }

  function sectionTotal(code) {
    return ME.items.filter(function (i) { return i.section === code; }).reduce(function (a, i) { return a + num(i.declared); }, 0);
  }
  function meterHtml(s) {
    var tot = sectionTotal(s.code), lim = s.limit;
    var senior = s.code.indexOf('80D') === 0 && ME.items.some(function (i) { return i.section === s.code && i.senior; });
    if (senior && s.senior_limit) lim = s.senior_limit;
    return '<span class="ptax-meter' + (lim && tot > lim ? ' over' : '') + '" data-meter="' + s.code + '">' + money(tot) + ' of ' + money(lim) + ' limit' + (lim && tot > lim ? ' — only the limit counts' : '') + '</span>';
  }
  function paintSections() {
    var box = ME.root && q(ME.root, '[data-me="sections"]');
    if (!box) return;
    var d = ME.d, ed = d.can_edit, savedIds = {};
    (d.items || []).forEach(function (i) { savedIds[i.id] = true; });
    var proofsBy = {};
    (d.proofs || []).forEach(function (p) { (proofsBy[p.item_id] = proofsBy[p.item_id] || []).push(p); });
    box.innerHTML = (d.sections || []).map(function (s) {
      var rows = ME.items.map(function (it, idx) {
        if (it.section !== s.code) return '';
        return '<div class="ptax-item"><input class="input-field" data-i="' + idx + '" data-f="description" placeholder="Description (e.g. PPF, LIC policy no.)" value="' + esc(it.description || '') + '" maxlength="120"' + (ed ? '' : ' disabled') + '>' +
          '<input class="input-field" style="text-align:right" inputmode="decimal" data-i="' + idx + '" data-f="declared" placeholder="Amount ₹" value="' + esc(it.declared === 0 || it.declared ? it.declared : '') + '"' + (ed ? '' : ' disabled') + '>' +
          (s.code.indexOf('80D') === 0 ? '<label class="ptax-check"><input type="checkbox" data-i="' + idx + '" data-f="senior"' + (it.senior ? ' checked' : '') + (ed ? '' : ' disabled') + '> senior</label>' : '<span></span>') +
          (ed ? '<button class="ptax-x" data-rm="' + idx + '" title="Remove">×</button>' : '<span></span>') +
          proofRow(it.id, savedIds[it.id], proofsBy[it.id] || [], it.verified) + '</div>';
      }).join('');
      return '<div class="ptax-sec"><div class="ptax-sec-h"><b>' + esc(s.label) + '</b>' + meterHtml(s) + '</div>' +
        '<div class="ptax-hint" style="margin:-4px 0 6px">' + esc(SECTION_HELP[s.code] || '') + '</div>' + rows +
        (ed ? '<button class="btn-sm" data-addsec="' + s.code + '" style="margin-top:6px">+ Add item</button>' : '') + '</div>';
    }).join('');
    bindItems(box);
  }
  function proofRow(itemId, saved, proofs, verified) {
    var d = ME.d;
    var list = proofs.map(function (p) {
      return '<span class="ptax-proof"><button class="ptax-link" data-view="' + p.id + '">' + esc(p.file_name) + '</button>' + badge(p.status) +
        (p.note ? '<span class="ptax-muted">' + esc(p.note) + '</span>' : '') +
        (p.status === 'pending' && d.can_upload ? '<button class="ptax-x" style="width:22px;height:22px" data-delp="' + p.id + '" title="Remove">×</button>' : '') + '</span>';
    }).join('');
    var up = '';
    if (d.can_upload) {
      up = saved ? '<label class="btn-sm" style="cursor:pointer">Upload proof<input type="file" accept="application/pdf,image/png,image/jpeg" data-up="' + esc(itemId) + '" style="display:none"></label>'
        : '<span class="ptax-muted">Save to upload a proof</span>';
    }
    var ver = verified != null ? '<span class="ptax-muted">HR verified ' + money(verified) + '</span>' : '';
    return (list || up || ver) ? '<div class="ptax-proofs">' + list + up + ver + '</div>' : '';
  }
  function bindItems(box) {
    on(box, '[data-f]', 'input', function (e, el) {
      var it = ME.items[parseInt(el.getAttribute('data-i'), 10)], f = el.getAttribute('data-f');
      it[f] = el.type === 'checkbox' ? el.checked : el.value;
      var s = (ME.d.sections || []).filter(function (x) { return x.code === it.section; })[0];
      var m = q(box, '[data-meter="' + it.section + '"]');
      if (s && m) m.outerHTML = meterHtml(s);
    });
    on(box, '[data-f="senior"]', 'change', function (e, el) { ME.items[parseInt(el.getAttribute('data-i'), 10)].senior = el.checked; paintSections(); });
    on(box, '[data-rm]', 'click', function (e, el) { ME.items.splice(parseInt(el.getAttribute('data-rm'), 10), 1); paintSections(); });
    on(box, '[data-addsec]', 'click', function (e, el) { ME.items.push({ section: el.getAttribute('data-addsec'), description: '', declared: '', senior: false }); paintSections(); });
    bindProofs(box);
  }
  function bindProofs(box) {
    var msg = function () { return q(ME.root, '[data-me="msg"]'); };
    on(box, '[data-view]', 'click', function (e, el) { viewProof(el.getAttribute('data-view'), ME.root, msg()); });
    on(box, '[data-delp]', 'click', function (e, el) {
      if (!window.confirm('Remove this proof?')) return;
      api('/api/me/tax/proofs/' + el.getAttribute('data-delp'), { method: 'DELETE' }).then(function () { meLoad('Proof removed.'); })
        .catch(function (er) { msg().innerHTML = errBox(er.message); });
    });
    on(box, '[data-up]', 'change', function (e, el) {
      var file = el.files && el.files[0];
      if (!file) return;
      var mime = fileMime(file);
      if (['application/pdf', 'image/png', 'image/jpeg'].indexOf(mime) < 0) { msg().innerHTML = errBox('Only PDF, PNG or JPG files are allowed.'); return; }
      if (file.size > 5 * 1024 * 1024) { msg().innerHTML = errBox('Files must be 5 MB or smaller.'); return; }
      var lbl = el.parentNode;
      lbl.classList.add('ptax-busy');
      readFile(file).then(function (b64) {
        return api('/api/me/tax/proofs', { method: 'POST', body: { fy: ME.d.fy, item_id: el.getAttribute('data-up'), file_name: file.name, mime: mime, data: b64 } });
      }).then(function () { meLoad('Proof uploaded.'); }).catch(function (er) { lbl.classList.remove('ptax-busy'); msg().innerHTML = errBox(er.message); });
    });
  }

  function paintHra() {
    var box = ME.root && q(ME.root, '[data-me="hra"]');
    if (!box) return;
    var d = ME.d, h = ME.hra, ed = d.can_edit, saved = d.hra || {};
    var proofs = (d.proofs || []).filter(function (p) { return p.item_id === 'hra'; });
    var annual = num(h.monthly_rent) * 12;
    box.innerHTML =
      '<div class="ptax-row"><div class="ptax-field"><label>Monthly rent (₹)</label><input class="input-field" inputmode="decimal" data-h="monthly_rent" value="' + esc(h.monthly_rent) + '"' + (ed ? '' : ' disabled') + '></div>' +
      '<div class="ptax-field"><label class="ptax-check" style="margin-top:22px"><input type="checkbox" data-h="metro"' + (h.metro ? ' checked' : '') + (ed ? '' : ' disabled') + '> Metro city (Delhi, Mumbai, Kolkata, Chennai)</label></div></div>' +
      '<div class="ptax-row"><div class="ptax-field"><label>Landlord name</label><input class="input-field" data-h="landlord_name" maxlength="120" value="' + esc(h.landlord_name) + '"' + (ed ? '' : ' disabled') + '></div>' +
      '<div class="ptax-field"><label>Landlord PAN' + (annual > 100000 ? ' (required)' : '') + '</label><input class="input-field" data-h="landlord_pan" maxlength="10" autocomplete="off" style="text-transform:uppercase" placeholder="' +
        esc(saved.landlord_pan ? saved.landlord_pan + ' (saved — type to replace)' : 'AAAAA9999A') + '"' + (ed ? '' : ' disabled') + '></div></div>' +
      '<div class="ptax-hint" data-hhint="1">' + hraHint(annual) + '</div>' +
      (saved.monthly_rent > 0 ? '<div class="ptax-proofs" style="margin-top:8px">' + proofRow('hra', true, proofs, saved.verified_monthly_rent).replace(/^<div class="ptax-proofs">|<\/div>$/g, '') + '</div>' : '');
    on(box, '[data-h]', 'input', function (e, el) {
      var k = el.getAttribute('data-h');
      h[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'monthly_rent') q(box, '[data-hhint]').innerHTML = hraHint(num(el.value) * 12);
    });
    on(box, '[data-h="metro"]', 'change', function (e, el) { h.metro = el.checked; });
    bindProofs(box);
  }
  function hraHint(annual) {
    return 'Annual rent ' + money(annual) + '. ' + (annual > 100000 ? 'Your landlord’s PAN is required because annual rent exceeds ₹1,00,000. It is stored encrypted and shown only masked.' :
      'Landlord PAN is needed only when annual rent exceeds ₹1,00,000.') + ' HRA exemption applies only under the old regime.';
  }

  function meSave(btn, submit) {
    var d = ME.d, msg = q(ME.root, '[data-me="msg"]');
    var items = ME.items.filter(function (i) { return String(i.declared).trim() !== '' || String(i.description || '').trim() !== ''; }).map(function (i) {
      var o = { section: i.section, description: String(i.description || '').trim(), declared: String(i.declared === '' || i.declared == null ? 0 : i.declared).trim() };
      if (i.id) o.id = i.id;
      if (i.section.indexOf('80D') === 0) o.senior = !!i.senior;
      return o;
    });
    var rent = String(ME.hra.monthly_rent === '' || ME.hra.monthly_rent == null ? 0 : ME.hra.monthly_rent).trim();
    var hra = { monthly_rent: rent, metro: !!ME.hra.metro, landlord_name: String(ME.hra.landlord_name || '').trim() };
    var pan = String(ME.hra.landlord_pan || '').trim().toUpperCase();
    if (pan) hra.landlord_pan = pan;
    busy(btn, true, submit ? 'Submitting…' : 'Saving…');
    api('/api/me/tax/declaration', { method: 'PUT', body: { fy: d.fy, items: items, hra: hra } }).then(function () {
      if (!submit) return 'Draft saved.';
      return api('/api/me/tax/submit', { method: 'POST', body: { fy: d.fy } }).then(function () { return 'Submitted to HR for verification.'; });
    }).then(function (m) { meLoad(m); }).catch(function (er) { busy(btn, false); msg.innerHTML = errBox(er.message); });
  }

  function paintForms(list) {
    var box = ME.root && q(ME.root, '[data-me="forms"]');
    if (!box) return;
    var mine = list.filter(function (f) { return f.period === ME.fy; });
    box.innerHTML = mine.length ? mine.map(function (f) {
      return '<div class="ptax-kv"><span>' + (f.kind === 'FORM16A' ? 'Part A (TRACES)' : 'Part B') + ' · ' + esc(fmtDate(f.generated_at)) + '</span><span><button class="btn-sm" data-form="' + f.id + '">Download</button></span></div>';
    }).join('') + '<div data-fmsg="1"></div>' : '<div class="ptax-muted" style="font-size:12.5px">HR has not issued Form 16 for FY ' + esc(ME.fy) + ' yet.</div>';
    on(box, '[data-form]', 'click', function (e, btn) {
      busy(btn, true, '…');
      api('/api/me/tax/forms/' + btn.getAttribute('data-form')).then(function (f) { busy(btn, false); saveFile(f.file_name, f.mime, f.content, f.encoding, ME.root); })
        .catch(function (er) { busy(btn, false); q(box, '[data-fmsg]').innerHTML = errBox(er.message); });
    });
  }

  /* ── registration ──────────────────────────────────────────────────────── */
  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: '/payroll/compliance', title: 'Tax & Statutory',
      mount: function (root) { hrMount(root); }, update: function () {},
      unmount: function () { HR.token++; HR.root = null; }
    });
    SC.register({
      base: '/my-pay/tax', title: 'Tax Declaration',
      mount: function (root) { meMount(root); }, update: function () {},
      unmount: function () { ME.token++; ME.root = null; }
    });
  }
  if (window.HRMSSidecar) register();
  else {
    var tries = 0;
    var iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); }
      else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
