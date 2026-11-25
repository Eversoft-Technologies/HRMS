/**
 * hrms-payroll-ess.js  v1
 * Employee self-service pay + Full & Final settlement.
 *
 *   /my-pay                 My Pay: Payslips (encrypted PDF), Expense claims,
 *                           Loans & advances, Total rewards, Approvals
 *   /payroll/separations    Separations & F&F (HR) + "Email payslips for run"
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): renders into the sidecar's
 * own root; React-owned DOM is never touched. Backend: api/payroll_ext/ess.py,
 * api/payroll_ext/fnf.py (routes in urls_ess.py). Identity / token headers are
 * added by hrms-actor.js; money and approval actions need a fresh sign-in and
 * the server explains when one is required.
 */
(function () {
  'use strict';
  if (window.__hrmsPayrollEssLoaded) return;
  window.__hrmsPayrollEssLoaded = true;

  var STYLE_ID = 'hrms-pess-style';
  var SC = null;
  var CUR_SYM = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', SGD: 'S$' };
  var CAT_COLORS = ['var(--accent)', 'var(--success)', 'var(--warn)', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316', 'var(--danger)'];

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v); } catch (_) {}
    return String(v).slice(0, 10);
  }
  function num(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    try { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (_) { return n.toFixed(2); }
  }
  function money(v, cur) {
    if (cur && cur !== 'INR') return (CUR_SYM[cur] || cur + ' ') + num(v);
    try { if (window.HRMSCompany && window.HRMSCompany.money) return window.HRMSCompany.money(v, { decimals: 2 }); } catch (_) {}
    return '₹' + num(v);
  }
  function monthLabel(p) {
    var m = /^(\d{4})-(\d{2})/.exec(String(p || ''));
    if (!m) return String(p || '');
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[+m[2] - 1] + ' ' + m[1];
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function errMsg(e) { return (e && e.message) || 'Something went wrong.'; }
  function badge(text, tone) { return '<span class="pess-badge pess-' + (tone || 'muted') + '">' + esc(text) + '</span>'; }
  var STATUS_TONE = {
    submitted: 'warn', requested: 'warn', approved: 'accent', paid: 'success', active: 'accent', closed: 'success',
    rejected: 'danger', withdrawn: 'muted', cancelled: 'muted', initiated: 'warn', clearance: 'warn', computed: 'accent',
    pending: 'warn', cleared: 'success', waived: 'muted', scheduled: 'muted', deducted: 'success', prepaid: 'success',
    recovered: 'success'
  };
  function statusBadge(s) { return badge(String(s || '').replace(/_/g, ' '), STATUS_TONE[s] || 'muted'); }
  function options(list, sel) {
    return list.map(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function q(root, sel) { return root.querySelector(sel); }
  function val(root, sel) { var el = q(root, sel); return el ? String(el.value || '').trim() : ''; }
  function setBusy(el, on) { if (el) { el.disabled = !!on; el.classList.toggle('pess-busy', !!on); } }
  function flash(box, msg, ok) {
    if (!box) return;
    box.innerHTML = msg ? '<div class="pess-' + (ok ? 'ok' : 'err') + '">' + esc(msg) + '</div>' : '';
  }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.pess-page{max-width:1240px;margin:0 auto;color:var(--text)}',
      '.pess-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap}',
      '.pess-h1{font-size:20px;font-weight:700;margin:0}',
      '.pess-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.pess-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:16px;overflow-x:auto}',
      '.pess-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.pess-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.pess-card{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:16px 18px;margin-bottom:14px;min-width:0}',
      '.pess-card h3{margin:0 0 12px;font-size:15px;font-weight:700}',
      '.pess-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}',
      '.pess-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '@media (max-width:860px){.pess-grid2,.pess-grid3{grid-template-columns:1fr}}',
      '.pess-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}',
      '.pess-kpi{background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:12px 14px}',
      '.pess-kpi span{display:block;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}',
      '.pess-kpi b{display:block;font-size:19px;font-weight:700;margin-top:4px;word-break:break-word}',
      '.pess-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.pess-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.pess-table th{text-align:left;font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.pess-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text)}',
      '.pess-table td.r,.pess-table th.r{text-align:right;white-space:nowrap}',
      '.pess-table tr.pess-click{cursor:pointer}.pess-table tr.pess-click:hover td{background:var(--bg3)}',
      '.pess-table tr.pess-tot td{font-weight:700;background:var(--bg3)}',
      '.pess-muted{color:var(--text3)}.pess-small{font-size:12px}',
      '.pess-formula{font-size:11.5px;color:var(--text2);font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-word}',
      '.pess-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;text-transform:capitalize}',
      '.pess-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}',
      '.pess-success{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}',
      '.pess-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}',
      '.pess-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 14%,transparent)}',
      '.pess-muted.pess-badge{color:var(--text2);background:var(--bg3);border:1px solid var(--border2)}',
      '.pess-field{margin-bottom:11px;min-width:0}',
      '.pess-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.pess-field .input-field{width:100%;box-sizing:border-box}',
      '.pess-field textarea.input-field{min-height:70px;resize:vertical}',
      '.pess-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.45}',
      '.pess-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.pess-row .input-field{width:auto;min-width:120px}',
      '.pess-btn{background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.pess-btn:hover{border-color:var(--accent);color:var(--accent)}',
      '.pess-btn.pess-dng{color:var(--danger)}.pess-btn.pess-dng:hover{border-color:var(--danger)}',
      '.pess-btn.pess-ok{color:var(--success)}.pess-btn.pess-ok:hover{border-color:var(--success)}',
      '.pess-btn[disabled],.pess-busy{opacity:.55;pointer-events:none}',
      '.pess-err{padding:10px 12px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin:8px 0}',
      '.pess-ok{padding:10px 12px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent);font-size:13px;margin:8px 0}',
      '.pess-info{padding:12px 14px;border-radius:10px;background:color-mix(in srgb,var(--accent) 9%,var(--bg2));border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);font-size:13px;line-height:1.55;color:var(--text)}',
      '.pess-empty{padding:30px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.pess-bar{display:flex;height:22px;border-radius:7px;overflow:hidden;background:var(--bg3);border:1px solid var(--border2)}',
      '.pess-bar i{display:block;height:100%;min-width:2px}',
      '.pess-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 18px;margin-top:14px}',
      '.pess-leg{display:flex;align-items:center;gap:8px;font-size:13px;min-width:0}',
      '.pess-leg i{width:11px;height:11px;border-radius:3px;flex:none}',
      '.pess-leg span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.pess-leg b{white-space:nowrap}',
      '.pess-total{font-size:28px;font-weight:800;margin:4px 0 12px}',
      '.pess-progress{height:8px;border-radius:5px;background:var(--bg3);overflow:hidden;border:1px solid var(--border2)}',
      '.pess-progress i{display:block;height:100%;background:var(--success)}',
      '.pess-loan{border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg3)}',
      '.pess-loan-h{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
      '.pess-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--border)}',
      '.pess-kv:last-child{border-bottom:none}.pess-kv span:first-child{color:var(--text3)}.pess-kv span:last-child{text-align:right;word-break:break-word}',
      '.pess-back{display:inline-block;font-size:13px;color:var(--text2);text-decoration:none;margin-bottom:12px;cursor:pointer;background:none;border:none;font-family:inherit;padding:0}',
      '.pess-back:hover{color:var(--accent)}',
      '.pess-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:14px}',
      '.pess-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:560px;padding:20px;color:var(--text);max-height:92vh;overflow:auto;box-sizing:border-box}',
      '.pess-modal.pess-wide{max-width:900px}',
      '.pess-modal h3{margin:0 0 14px;font-size:16px}',
      '.pess-doc{width:100%;height:65vh;border:1px solid var(--border2);border-radius:8px;background:#fff}',
      '.pess-net{font-size:20px;font-weight:800}.pess-net.pos{color:var(--success)}.pess-net.neg{color:var(--danger)}',
      'html[data-theme="light"] .pess-overlay{background:rgba(15,23,42,.35)}',
      /* Timesheets-style accent strip + hover lift (opt-in via .pess-acc) */
      '.pess-acc{--pess-c:var(--border2);position:relative;overflow:hidden;box-sizing:border-box;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,border-color .2s ease}',
      '.pess-acc:before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--pess-c);transition:height .2s ease}',
      '.pess-acc:hover{border-color:color-mix(in srgb,var(--pess-c) 45%,var(--border2));transform:translateY(-2px);box-shadow:0 6px 16px rgba(15,23,42,.08)}',
      '.pess-acc:hover:before{height:3px}',
      '.pess-loan.pess-acc{background:var(--bg2);padding-top:14px}',
      '.pess-c-blue{--pess-c:var(--accent)}.pess-c-purple{--pess-c:var(--accent2)}.pess-c-green{--pess-c:var(--accent3)}.pess-c-orange{--pess-c:var(--accent4)}',
      '.pess-c-warn{--pess-c:var(--warn)}.pess-c-danger{--pess-c:var(--danger)}.pess-c-muted{--pess-c:var(--text3)}.pess-c-violet{--pess-c:#8b5cf6}',
      '.pess-hov{transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,border-color .2s ease}',
      '.pess-hov:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--border2));transform:translateY(-2px);box-shadow:0 6px 16px rgba(15,23,42,.08)}',
      '@media (hover:none){.pess-hov:hover{transform:none;box-shadow:none}}',
      '@media (prefers-reduced-motion: reduce){.pess-hov{transition:none}}',
      '.pess-acc .pess-table tbody tr td{transition:background-color .15s ease}.pess-acc .pess-table tbody tr:hover td{background:color-mix(in srgb,var(--pess-c) 7%,transparent)}',
      '.pess-acc .pess-kv{transition:background-color .15s ease;border-radius:6px;padding-left:6px;padding-right:6px;margin:0 -6px}.pess-acc .pess-kv:hover{background:color-mix(in srgb,var(--pess-c) 7%,transparent)}',
      '@media (hover:none){.pess-acc:hover{transform:none;box-shadow:none}}',
      '@media (prefers-reduced-motion: reduce){.pess-acc,.pess-acc:before{transition:none}}',
      '@media (max-width:600px){.pess-card{padding:13px 12px}.pess-total{font-size:23px}.pess-table{font-size:12px}.pess-table td,.pess-table th{padding:7px 6px}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── modal (our own overlay node, appended to body) ────────────────────── */
  function modal(title, bodyHtml, opts) {
    opts = opts || {};
    var ov = document.createElement('div');
    ov.className = 'pess-overlay';
    ov.innerHTML = '<div class="pess-modal' + (opts.wide ? ' pess-wide' : '') + '" role="dialog" aria-modal="true">' +
      '<h3>' + esc(title) + '</h3><div data-m="body">' + bodyHtml + '</div><div data-m="msg"></div>' +
      '<div class="pess-row" style="justify-content:flex-end;margin-top:14px">' +
      (opts.extraBtn || '') + '<button class="pess-btn" data-m="close">' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
      (opts.okLabel ? '<button class="btn-primary btn-sm" data-m="ok">' + esc(opts.okLabel) + '</button>' : '') + '</div></div>';
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) {
      if (e.target === ov || (e.target.getAttribute && e.target.getAttribute('data-m') === 'close')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    var api_ = {
      el: ov, close: close,
      body: q(ov, '[data-m="body"]'),
      msg: function (m, ok) { flash(q(ov, '[data-m="msg"]'), m, ok); }
    };
    var ok = q(ov, '[data-m="ok"]');
    if (ok && opts.onOk) {
      ok.addEventListener('click', function () {
        setBusy(ok, true);
        Promise.resolve().then(function () { return opts.onOk(api_); }).then(function (keep) {
          setBusy(ok, false);
          if (keep !== true) close();
        }, function (e) { setBusy(ok, false); api_.msg(errMsg(e)); });
      });
    }
    var first = q(ov, 'input,select,textarea');
    if (first) try { first.focus(); } catch (_) {}
    return api_;
  }

  function showDocument(title, html) {
    var m = modal(title, '<iframe class="pess-doc" sandbox="allow-same-origin allow-modals" title="' + esc(title) + '"></iframe>',
      { wide: true, cancelLabel: 'Close', extraBtn: '<button class="btn-primary btn-sm" data-m="print">Print</button>' });
    var frame = q(m.el, 'iframe');
    frame.srcdoc = html || '<p>No document.</p>';
    q(m.el, '[data-m="print"]').addEventListener('click', function () {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) { m.msg('Printing is blocked by the browser.'); }
    });
  }

  /* ── files ─────────────────────────────────────────────────────────────── */
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
  }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { resolve(null); return; }
      if (file.size > 5 * 1024 * 1024) { reject(new Error('Receipts must be 5 MB or smaller.')); return; }
      var type = (file.type || '').toLowerCase();
      if (['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'].indexOf(type) === -1) {
        reject(new Error('Attach a PDF, PNG or JPG receipt.')); return;
      }
      var r = new FileReader();
      r.onload = function () { resolve({ data: String(r.result || '').split(',')[1] || '', mime: type, name: file.name }); };
      r.onerror = function () { reject(new Error('The file could not be read.')); };
      r.readAsDataURL(file);
    });
  }
  function viewReceipt(id) {
    return api('/api/me/pay/expenses/' + id + '/receipt').then(function (d) {
      var ext = d.mime === 'application/pdf' ? '.pdf' : (d.mime === 'image/png' ? '.png' : '.jpg');
      saveBlob(b64ToBlob(d.data, d.mime), (d.name || 'receipt').replace(/\.[a-z0-9]+$/i, '') + ext);
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  /my-pay
   * ════════════════════════════════════════════════════════════════════════ */
  var my = { root: null, tab: 'payslips', token: 0, showApprovals: false, canApproveLoans: false, fy: null };

  function mountMyPay(root) {
    injectStyle();
    var bound = root.__pessBound;
    my.root = root;
    root.innerHTML = '<div class="pess-page">' +
      '<div class="pess-head"><div><h1 class="pess-h1">My Pay</h1>' +
      '<div class="pess-sub">Payslips, expense claims, salary advances & loans and your total rewards.</div></div></div>' +
      '<div class="pess-tabs" data-pess="tabs"></div><div data-pess="body"></div></div>';
    if (!root.__pessBound) root.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tab]') : null;
      if (t && root.contains(t)) { my.tab = t.getAttribute('data-tab'); renderTabs(); renderMyTab(); }
    });
    root.__pessBound = true;
    renderTabs();
    renderMyTab();
    // Approvals tab only for managers / approvers.
    Promise.all([
      api('/api/payroll/ess/expenses/approvals').catch(function () { return null; }),
      api('/api/me/pay/loans').catch(function () { return null; })
    ]).then(function (res) {
      var a = res[0], l = res[1];
      my.canApproveLoans = !!(l && l.canApprove);
      my.showApprovals = !!((a && (a.canApproveAll || a.hasReports || (a.claims || []).length)) || my.canApproveLoans);
      renderTabs();
    });
  }

  function renderTabs() {
    var tabs = [['payslips', 'Payslips'], ['expenses', 'Expense claims'], ['loans', 'Loans & advances'], ['rewards', 'Total rewards']];
    if (my.showApprovals) tabs.push(['approvals', 'Approvals']);
    var el = q(my.root, '[data-pess="tabs"]');
    if (!el) return;
    el.innerHTML = tabs.map(function (t) {
      return '<button class="pess-tab' + (my.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('');
  }

  function renderMyTab() {
    var body = q(my.root, '[data-pess="body"]');
    var tok = ++my.token;
    body.innerHTML = '<div class="pess-empty">Loading…</div>';
    var fn = { payslips: tabPayslips, expenses: tabExpenses, loans: tabLoans, rewards: tabRewards, approvals: tabApprovals }[my.tab] || tabPayslips;
    fn(body, function () { return tok === my.token; });
  }

  /* ── Payslips ── */
  function tabPayslips(body, live) {
    api('/api/me/pay/payslips').then(function (d) {
      if (!live()) return;
      var pw = d.password || {};
      var rows = (d.payslips || []).map(function (p) {
        return '<tr><td><b>' + esc(monthLabel(p.period)) + '</b><div class="pess-muted pess-small">' + esc(fmtDate(p.periodStart)) + ' – ' + esc(fmtDate(p.periodEnd)) + '</div></td>' +
          '<td class="r">' + esc(money(p.grossEarnings)) + '</td><td class="r">' + esc(money(p.totalDeductions)) + '</td>' +
          '<td class="r"><b>' + esc(money(p.netPay)) + '</b></td><td>' + statusBadge(p.status) + '</td>' +
          '<td class="pess-small">' + (p.emailedAt ? 'Emailed ' + esc(fmtDate(p.emailedAt)) : '<span class="pess-muted">Not emailed</span>') + '</td>' +
          '<td class="r"><button class="pess-btn" data-dl="' + p.id + '" data-name="Payslip_' + esc(p.period) + '.pdf">Download PDF</button></td></tr>';
      }).join('');
      body.innerHTML =
        '<div class="pess-info" style="margin-bottom:14px"><b>Your payslip PDFs are password protected.</b> ' +
        (pw.available ? 'To open one, enter ' + esc(pw.description || '') + '.' :
          'Your date of birth or PAN is not on record yet, so a protected PDF cannot be created. Please ask HR to update your details.') +
        ' The password is never sent by email.</div>' +
        '<div class="pess-card"><h3>Payslips</h3><div data-pess="msg"></div>' +
        (rows ? '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Month</th><th class="r">Gross</th><th class="r">Deductions</th><th class="r">Net pay</th><th>Status</th><th>Email</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="pess-empty">No payslips have been released to you yet.</div>') + '</div>';
      body.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          setBusy(b, true);
          fetch('/api/me/pay/payslips/' + b.getAttribute('data-dl') + '/pdf').then(function (r) {
            if (r.ok) return r.blob().then(function (blob) { saveBlob(blob, b.getAttribute('data-name')); });
            return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.message || ('Download failed (' + r.status + ')')); });
          }).then(function () { setBusy(b, false); flash(q(body, '[data-pess="msg"]'), ''); }, function (e) {
            setBusy(b, false); flash(q(body, '[data-pess="msg"]'), errMsg(e));
          });
        });
      });
    }, function (e) { if (live()) body.innerHTML = '<div class="pess-err">' + esc(errMsg(e)) + '</div>'; });
  }

  /* ── Expense claims ── */
  function tabExpenses(body, live) {
    api('/api/me/pay/expenses').then(function (d) {
      if (!live()) return;
      var caps = d.caps || {};
      var capText = Object.keys(caps).map(function (k) {
        var c = (d.categories || []).filter(function (x) { return x.value === k; })[0];
        return esc((c ? c.label : k) + ': ' + money(caps[k]) + '/month');
      }).join(' · ');
      var rows = (d.claims || []).map(function (c) {
        var flags = (c.overCap ? ' ' + badge('Over cap', 'warn') : '') + (c.taxable ? ' ' + badge('Taxable', 'muted') : '');
        return '<tr><td>' + esc(fmtDate(c.expenseDate)) + '</td><td>' + esc(c.categoryLabel) + flags +
          '<div class="pess-muted pess-small">' + esc(c.description) + '</div></td>' +
          '<td class="r">' + esc(money(c.amount, c.currency)) + '</td><td>' + statusBadge(c.status) +
          (c.decisionNote ? '<div class="pess-muted pess-small">' + esc(c.decisionNote) + '</div>' : '') +
          (c.paidRunId ? '<div class="pess-muted pess-small">Paid with payroll</div>' : '') + '</td>' +
          '<td class="r"><div class="pess-row" style="justify-content:flex-end">' +
          (c.hasReceipt ? '<button class="pess-btn" data-rc="' + c.id + '">Receipt</button>' : '') +
          (c.status === 'submitted' ? '<button class="pess-btn pess-dng" data-wd="' + c.id + '">Withdraw</button>' : '') +
          '</div></td></tr>';
      }).join('');
      body.innerHTML =
        '<div class="pess-grid2">' +
        '<div class="pess-card"><h3>New claim</h3>' +
        '<div class="pess-field"><label>Category</label><select class="input-field" data-f="category">' + options(d.categories || [], 'travel') + '</select></div>' +
        '<div class="pess-grid2"><div class="pess-field"><label>Amount</label><input class="input-field" data-f="amount" inputmode="decimal" placeholder="0.00"></div>' +
        '<div class="pess-field"><label>Expense date</label><input type="date" class="input-field" data-f="date" max="' + todayIso() + '" value="' + todayIso() + '"></div></div>' +
        '<div class="pess-field"><label>Description</label><textarea class="input-field" data-f="desc" maxlength="1000" placeholder="What was this for?"></textarea></div>' +
        '<div class="pess-field"><label>Receipt</label><input type="file" class="input-field" data-f="file" accept="application/pdf,image/png,image/jpeg">' +
        '<div class="pess-hint">PDF, PNG or JPG, up to 5 MB. Required.</div></div>' +
        '<div data-pess="msg"></div><button class="btn-primary" data-pess="submit">Submit claim</button></div>' +
        '<div class="pess-card"><h3>How it works</h3><div class="pess-small" style="line-height:1.6">' +
        'Claims go to your reporting manager (or Finance) for approval. Approved claims are paid with the next payroll run as ' +
        '<b>Reimbursements</b>. Monthly caps apply per category; anything above a cap is still reimbursed but treated as taxable.' +
        (capText ? '<div class="pess-hint" style="margin-top:8px">Caps: ' + capText + '</div>' : '') + '</div></div></div>' +
        '<div class="pess-card"><h3>My claims</h3>' +
        (rows ? '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Date</th><th>Claim</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="pess-empty">No claims yet.</div>') + '</div>';
      var btn = q(body, '[data-pess="submit"]');
      btn.addEventListener('click', function () {
        var msg = q(body, '[data-pess="msg"]');
        var fileEl = q(body, '[data-f="file"]');
        setBusy(btn, true);
        readFile(fileEl.files && fileEl.files[0]).then(function (f) {
          if (!f) throw new Error('Attach the receipt.');
          return api('/api/me/pay/expenses', { method: 'POST', body: {
            category: val(body, '[data-f="category"]'), amount: val(body, '[data-f="amount"]'),
            expenseDate: val(body, '[data-f="date"]'), description: val(body, '[data-f="desc"]'),
            receiptData: f.data, receiptMime: f.mime, receiptName: f.name } });
        }).then(function (c) {
          setBusy(btn, false);
          renderMyTab();
          setTimeout(function () { flash(q(my.root, '[data-pess="msg"]'), c.overCap ? 'Claim submitted. It is above the monthly cap, so the excess will be taxable.' : 'Claim submitted for approval.', true); }, 300);
        }, function (e) { setBusy(btn, false); flash(msg, errMsg(e)); });
      });
      bindReceiptAndWithdraw(body);
    }, function (e) { if (live()) body.innerHTML = '<div class="pess-err">' + esc(errMsg(e)) + '</div>'; });
  }
  function bindReceiptAndWithdraw(body) {
    body.querySelectorAll('[data-rc]').forEach(function (b) {
      b.addEventListener('click', function () {
        setBusy(b, true);
        viewReceipt(b.getAttribute('data-rc')).then(function () { setBusy(b, false); }, function (e) { setBusy(b, false); alert(errMsg(e)); });
      });
    });
    body.querySelectorAll('[data-wd]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Withdraw this claim?')) return;
        api('/api/me/pay/expenses/' + b.getAttribute('data-wd') + '/cancel', { method: 'POST', body: {} })
          .then(renderMyTab, function (e) { alert(errMsg(e)); });
      });
    });
  }

  /* ── Loans & advances ── */
  function estimateEmi(p, rate, n, method) {
    p = Number(p) || 0; n = Number(n) || 0; rate = Number(rate) || 0;
    if (p <= 0 || n <= 0) return 0;
    if (!rate) return p / n;
    if (method === 'flat') return (p + p * rate / 100 * n / 12) / n;
    var r = rate / 1200, f = Math.pow(1 + r, n);
    return p * r * f / (f - 1);
  }
  function scheduleTable(l) {
    var rows = (l.schedule || []).map(function (s) {
      return '<tr><td>' + s.seq + '</td><td>' + esc(monthLabel(s.period)) + '</td><td class="r">' + esc(money(s.principal)) + '</td>' +
        '<td class="r">' + esc(money(s.interest)) + '</td><td class="r"><b>' + esc(money(s.amount)) + '</b></td><td>' + statusBadge(s.status) + '</td></tr>';
    }).join('');
    return rows ? '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>#</th><th>Month</th><th class="r">Principal</th><th class="r">Interest</th><th class="r">EMI</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="pess-muted pess-small">The repayment schedule is created when the amount is disbursed.</div>';
  }
  function loanCard(l, actionsHtml) {
    var total = Number(l.principal) || 0;
    var paidPct = total > 0 ? Math.max(0, Math.min(100, (total - Number(l.outstanding || 0)) / total * 100)) : 0;
    if (l.status === 'requested' || l.status === 'approved' || l.status === 'rejected' || l.status === 'withdrawn') paidPct = 0;
    if (l.status === 'closed') paidPct = 100;
    var LOAN_ACC = { requested: 'warn', approved: 'blue', active: 'green', closed: 'violet', rejected: 'danger', withdrawn: 'muted', cancelled: 'muted' };
    return '<div class="pess-loan pess-acc pess-c-' + (LOAN_ACC[l.status] || 'muted') + '"><div class="pess-loan-h"><div><b>' + esc(l.kind === 'advance' ? 'Salary advance' : 'Loan') + ' · ' + esc(money(l.principal)) + '</b>' +
      (l.employeeName ? ' <span class="pess-muted pess-small">' + esc(l.employeeName) + ' (' + esc(l.email) + ')</span>' : '') +
      '<div class="pess-muted pess-small">' + esc(l.tenureMonths) + ' month(s) · ' + esc(l.interestRate) + '% p.a. · EMI ' + esc(money(l.emi)) +
      ' · requested ' + esc(fmtDate(l.createdAt)) + '</div></div><div>' + statusBadge(l.status) + '</div></div>' +
      (l.reason ? '<div class="pess-small" style="margin-bottom:8px">' + esc(l.reason) + '</div>' : '') +
      (l.decisionNote ? '<div class="pess-muted pess-small" style="margin-bottom:8px">Note: ' + esc(l.decisionNote) + '</div>' : '') +
      (l.status === 'active' || l.status === 'closed' ?
        '<div class="pess-row pess-small" style="justify-content:space-between;margin-bottom:5px"><span>Outstanding <b>' + esc(money(l.outstanding)) + '</b></span><span class="pess-muted">' + Math.round(paidPct) + '% repaid</span></div>' +
        '<div class="pess-progress"><i style="width:' + paidPct.toFixed(1) + '%"></i></div>' : '') +
      '<details style="margin-top:8px"><summary class="pess-small" style="cursor:pointer">Repayment schedule</summary><div style="margin-top:8px">' + scheduleTable(l) + '</div></details>' +
      (actionsHtml ? '<div class="pess-row" style="margin-top:10px">' + actionsHtml + '</div>' : '') + '</div>';
  }
  function tabLoans(body, live) {
    api('/api/me/pay/loans').then(function (d) {
      if (!live()) return;
      var lim = d.limits || {};
      var adv = lim.advance || {}, ln = lim.loan || {};
      body.innerHTML =
        '<div class="pess-kpis">' +
        '<div class="pess-kpi pess-acc pess-c-green"><span>Max salary advance</span><b>' + esc(money(adv.maxAmount)) + '</b></div>' +
        '<div class="pess-kpi pess-acc pess-c-blue"><span>Max loan</span><b>' + esc(money(ln.maxAmount)) + '</b></div>' +
        '<div class="pess-kpi pess-acc pess-c-purple"><span>Max tenure (loan)</span><b>' + esc(ln.maxTenure) + ' months</b></div>' +
        '<div class="pess-kpi pess-acc pess-c-orange"><span>Loan interest</span><b>' + esc(ln.interestRate) + '% p.a.</b></div></div>' +
        '<div class="pess-grid2"><div class="pess-card"><h3>Request an advance or loan</h3>' +
        '<div class="pess-grid2"><div class="pess-field"><label>Type</label><select class="input-field" data-f="kind">' +
        options([{ value: 'advance', label: 'Salary advance' }, { value: 'loan', label: 'Loan' }], 'advance') + '</select></div>' +
        '<div class="pess-field"><label>Amount</label><input class="input-field" data-f="amount" inputmode="decimal" placeholder="0.00"></div></div>' +
        '<div class="pess-field"><label>Tenure (months)</label><input type="number" min="1" class="input-field" data-f="tenure" value="1"><div class="pess-hint" data-pess="lim"></div></div>' +
        '<div class="pess-field"><label>Reason</label><textarea class="input-field" data-f="reason" maxlength="1000"></textarea></div>' +
        '<div class="pess-hint" data-pess="emi" style="margin-bottom:10px"></div>' +
        '<div data-pess="msg"></div><button class="btn-primary" data-pess="req">Submit request</button></div>' +
        '<div class="pess-card"><h3>Policy</h3><div class="pess-small" style="line-height:1.6">' +
        'Limits are based on your last payslip (' + esc(lim.basis || '—') + '): an advance up to ' + esc(lim.policy ? lim.policy.max_advance_multiple_of_net : 1) +
        '× monthly net pay, repaid within ' + esc(adv.maxTenure) + ' month(s) interest-free; a loan up to ' + esc(lim.policy ? lim.policy.max_loan_multiple_of_gross : 6) +
        '× monthly gross over at most ' + esc(ln.maxTenure) + ' months. Requests are approved by Payroll / HR. EMIs are deducted from salary from the month after ' +
        'disbursement and never take your net pay below zero — any shortfall moves to the next month.</div></div></div>' +
        '<div class="pess-card"><h3>My loans & advances</h3>' + ((d.loans || []).length ? (d.loans || []).map(function (l) {
          return loanCard(l, l.status === 'requested' ? '<button class="pess-btn pess-dng" data-lw="' + l.id + '">Withdraw request</button>' : '');
        }).join('') : '<div class="pess-empty">No loans or advances.</div>') + '</div>';
      function refreshHint() {
        var kind = val(body, '[data-f="kind"]');
        var spec = kind === 'loan' ? ln : adv;
        var rate = kind === 'loan' ? ln.interestRate : 0;
        q(body, '[data-pess="lim"]').textContent = 'Up to ' + money(spec.maxAmount) + ' over 1–' + spec.maxTenure + ' months.';
        var emi = estimateEmi(val(body, '[data-f="amount"]'), rate, val(body, '[data-f="tenure"]'), ln.method);
        q(body, '[data-pess="emi"]').textContent = emi ? 'Estimated EMI: ' + money(emi) + ' per month' + (rate ? ' (' + rate + '% p.a.)' : '') : '';
      }
      ['kind', 'amount', 'tenure'].forEach(function (f) { q(body, '[data-f="' + f + '"]').addEventListener('input', refreshHint); });
      refreshHint();
      var btn = q(body, '[data-pess="req"]');
      btn.addEventListener('click', function () {
        setBusy(btn, true);
        api('/api/me/pay/loans', { method: 'POST', body: { kind: val(body, '[data-f="kind"]'), amount: val(body, '[data-f="amount"]'),
          tenureMonths: val(body, '[data-f="tenure"]'), reason: val(body, '[data-f="reason"]') } })
          .then(function () { setBusy(btn, false); renderMyTab(); }, function (e) { setBusy(btn, false); flash(q(body, '[data-pess="msg"]'), errMsg(e)); });
      });
      body.querySelectorAll('[data-lw]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Withdraw this request?')) return;
          api('/api/me/pay/loans/' + b.getAttribute('data-lw') + '/cancel', { method: 'POST', body: {} }).then(renderMyTab, function (e) { alert(errMsg(e)); });
        });
      });
    }, function (e) { if (live()) body.innerHTML = '<div class="pess-err">' + esc(errMsg(e)) + '</div>'; });
  }

  /* ── Total rewards ── */
  function fyList() {
    var d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, out = [];
    for (var i = 0; i < 3; i++) { var a = y - i; out.push({ value: a + '-' + ('0' + ((a + 1) % 100)).slice(-2), label: 'FY ' + a + '-' + ('0' + ((a + 1) % 100)).slice(-2) }); }
    return out;
  }
  function tabRewards(body, live) {
    if (!my.fy) my.fy = fyList()[0].value;
    api('/api/me/pay/total-rewards?fy=' + encodeURIComponent(my.fy)).then(function (d) {
      if (!live()) return;
      var comps = (d.components || []).filter(function (c) { return Number(c.amount) > 0; });
      var total = Number(d.total) || 0;
      var bar = comps.map(function (c, i) {
        return '<i title="' + esc(c.label + ': ' + money(c.amount, d.currency)) + '" style="width:' + (total ? (c.amount / total * 100).toFixed(2) : 0) + '%;background:' + CAT_COLORS[i % CAT_COLORS.length] + '"></i>';
      }).join('');
      var legend = comps.map(function (c, i) {
        return '<div class="pess-leg"><i style="background:' + CAT_COLORS[i % CAT_COLORS.length] + '"></i><span>' + esc(c.label) + '</span><b>' +
          esc(money(c.amount, d.currency)) + '</b><span class="pess-muted pess-small" style="flex:none">' + (total ? Math.round(c.amount / total * 100) : 0) + '%</span></div>';
      }).join('');
      var detailRows = (d.components || []).map(function (c) {
        return '<tr><td>' + esc(c.label) + (c.formula ? '<div class="pess-formula">' + esc(c.formula) + '</div>' : '') +
          (c.sumInsured ? '<div class="pess-muted pess-small">Cover: ' + esc(money(c.sumInsured, d.currency)) + '</div>' : '') + '</td>' +
          '<td class="pess-muted pess-small" style="text-transform:capitalize">' + esc(c.group) + '</td><td class="r">' + esc(money(c.amount, d.currency)) + '</td></tr>';
      }).join('');
      var g = d.gratuity || {};
      body.innerHTML =
        '<div class="pess-row" style="margin-bottom:12px"><select class="input-field" data-f="fy">' + options(fyList(), my.fy) + '</select>' +
        '<span class="pess-muted pess-small">' + esc(fmtDate(d.from)) + ' – ' + esc(fmtDate(d.to)) + ' · ' + esc(d.payslipCount) + ' payslip(s)</span></div>' +
        '<div class="pess-card pess-hov"><h3>Total rewards ' + esc(d.fy) + '</h3><div class="pess-muted pess-small">Everything the company invests in you this year</div>' +
        '<div class="pess-total">' + esc(money(total, d.currency)) + '</div>' +
        (comps.length ? '<div class="pess-bar" role="img" aria-label="Breakdown of total rewards">' + bar + '</div><div class="pess-legend">' + legend + '</div>' : '<div class="pess-empty">No pay data for this year yet.</div>') + '</div>' +
        '<div class="pess-grid2"><div class="pess-card"><h3>Breakdown</h3><div class="pess-table-wrap"><table class="pess-table"><tbody>' + detailRows +
        '<tr class="pess-tot"><td>Total</td><td></td><td class="r">' + esc(money(total, d.currency)) + '</td></tr></tbody></table></div></div>' +
        '<div class="pess-card"><h3>Gratuity</h3>' +
        '<div class="pess-kv"><span>Date of joining</span><span>' + esc(fmtDate(g.dateOfJoining)) + '</span></div>' +
        '<div class="pess-kv"><span>Completed years</span><span>' + esc(g.serviceYears) + '</span></div>' +
        '<div class="pess-kv"><span>Monthly basic + DA</span><span>' + esc(money(g.monthlyBasicDa, d.currency)) + '</span></div>' +
        '<div class="pess-kv"><span>Accrued liability</span><span><b>' + esc(money(g.accruedLiability, d.currency)) + '</b></span></div>' +
        '<div class="pess-kv"><span>Vested</span><span>' + (g.vested ? badge('Yes', 'success') : badge('After 5 years', 'muted')) + '</span></div>' +
        '<div class="pess-formula" style="margin-top:8px">' + esc(g.formula || '') + '</div>' +
        '<div class="pess-hint">Gratuity becomes payable on leaving after 5 years of continuous service (Payment of Gratuity Act).</div></div></div>';
      q(body, '[data-f="fy"]').addEventListener('change', function () { my.fy = this.value; renderMyTab(); });
    }, function (e) { if (live()) body.innerHTML = '<div class="pess-err">' + esc(errMsg(e)) + '</div>'; });
  }

  /* ── Approvals ── */
  function decideModal(kind, id, action, extra) {
    var isReject = action === 'reject';
    var bodyHtml = '<div class="pess-field"><label>' + (isReject ? 'Reason (required)' : 'Note (optional)') + '</label>' +
      '<textarea class="input-field" data-f="note" maxlength="255"></textarea></div>' + (extra || '');
    modal((isReject ? 'Reject ' : 'Approve ') + kind, bodyHtml, {
      okLabel: isReject ? 'Reject' : 'Approve',
      onOk: function (m) {
        var b = { action: action, note: val(m.body, '[data-f="note"]') };
        var tx = q(m.body, '[data-f="taxable"]');
        if (tx) b.taxable = tx.checked;
        var url = kind === 'claim' ? '/api/payroll/ess/expenses/' + id + '/decide' : '/api/payroll/ess/loans/' + id + '/decide';
        return api(url, { method: 'POST', body: b }).then(function () { renderMyTab(); });
      }
    });
  }
  function tabApprovals(body, live) {
    Promise.all([
      api('/api/payroll/ess/expenses/approvals?status=submitted'),
      my.canApproveLoans ? api('/api/payroll/ess/loans') : Promise.resolve(null)
    ]).then(function (res) {
      if (!live()) return;
      var claims = res[0].claims || [], loans = res[1] ? (res[1].loans || []) : null;
      var rows = claims.map(function (c) {
        return '<tr><td><b>' + esc(c.employeeName || c.email) + '</b><div class="pess-muted pess-small">' + esc(c.email) + '</div></td>' +
          '<td>' + esc(c.categoryLabel) + (c.overCap ? ' ' + badge('Over cap', 'warn') : '') + '<div class="pess-muted pess-small">' + esc(c.description) + '</div></td>' +
          '<td>' + esc(fmtDate(c.expenseDate)) + '</td><td class="r"><b>' + esc(money(c.amount, c.currency)) + '</b>' +
          (c.cap ? '<div class="pess-muted pess-small">Month ' + esc(money(c.monthTotal)) + ' / cap ' + esc(money(c.cap)) + '</div>' : '') + '</td>' +
          '<td class="r"><div class="pess-row" style="justify-content:flex-end">' +
          (c.hasReceipt ? '<button class="pess-btn" data-rc="' + c.id + '">Receipt</button>' : '') +
          '<button class="pess-btn pess-ok" data-ca="' + c.id + '" data-over="' + (c.overCap || c.taxableCategory ? 1 : 0) + '">Approve</button>' +
          '<button class="pess-btn pess-dng" data-cr="' + c.id + '">Reject</button></div></td></tr>';
      }).join('');
      var html = '<div class="pess-card"><h3>Expense claims awaiting your decision</h3>' +
        (rows ? '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Employee</th><th>Claim</th><th>Date</th><th class="r">Amount</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="pess-empty">Nothing waiting.</div>') + '</div>';
      if (loans) {
        var open = loans.filter(function (l) { return ['requested', 'approved', 'active'].indexOf(l.status) !== -1; });
        html += '<div class="pess-card"><h3>Loans & advances</h3>' + (open.length ? open.map(function (l) {
          var acts = '';
          if (l.isMine) acts = '<span class="pess-muted pess-small">Your own request — another approver must act.</span>';
          else if (l.status === 'requested') acts = '<button class="pess-btn pess-ok" data-la="' + l.id + '">Approve</button><button class="pess-btn pess-dng" data-lr="' + l.id + '">Reject</button>';
          else if (l.status === 'approved') acts = '<button class="btn-primary btn-sm" data-ld="' + l.id + '">Mark disbursed</button>';
          else if (l.status === 'active') acts = '<button class="pess-btn" data-lf="' + l.id + '" data-out="' + l.outstanding + '">Prepay / foreclose</button>';
          return loanCard(l, acts);
        }).join('') : '<div class="pess-empty">No open loans or advances.</div>') + '</div>';
      }
      body.innerHTML = html;
      bindReceiptAndWithdraw(body);
      body.querySelectorAll('[data-ca]').forEach(function (b) {
        b.addEventListener('click', function () {
          var over = b.getAttribute('data-over') === '1';
          decideModal('claim', b.getAttribute('data-ca'), 'approve',
            '<label class="pess-small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-f="taxable"' + (over ? ' checked' : '') + '> Treat as taxable' +
            (over ? ' (over the monthly cap: only the excess is taxed)' : '') + '</label>');
        });
      });
      body.querySelectorAll('[data-cr]').forEach(function (b) { b.addEventListener('click', function () { decideModal('claim', b.getAttribute('data-cr'), 'reject'); }); });
      body.querySelectorAll('[data-la]').forEach(function (b) { b.addEventListener('click', function () { decideModal('loan', b.getAttribute('data-la'), 'approve'); }); });
      body.querySelectorAll('[data-lr]').forEach(function (b) { b.addEventListener('click', function () { decideModal('loan', b.getAttribute('data-lr'), 'reject'); }); });
      body.querySelectorAll('[data-ld]').forEach(function (b) {
        b.addEventListener('click', function () {
          var d = new Date(); d.setMonth(d.getMonth() + 1);
          var next = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
          modal('Mark disbursed', '<div class="pess-field"><label>First EMI month</label><input type="month" class="input-field" data-f="first" value="' + next + '"></div>' +
            '<div class="pess-field"><label>Payment reference (optional)</label><input class="input-field" data-f="ref" maxlength="200"></div>' +
            '<div class="pess-hint">This creates the EMI schedule; EMIs are deducted from salary from the first EMI month.</div>', {
            okLabel: 'Mark disbursed',
            onOk: function (m) {
              return api('/api/payroll/ess/loans/' + b.getAttribute('data-ld') + '/disburse', { method: 'POST',
                body: { firstEmiPeriod: val(m.body, '[data-f="first"]'), reference: val(m.body, '[data-f="ref"]') } }).then(function () { renderMyTab(); });
            }
          });
        });
      });
      body.querySelectorAll('[data-lf]').forEach(function (b) {
        b.addEventListener('click', function () {
          modal('Prepayment / foreclosure', '<div class="pess-hint" style="margin-bottom:10px">Outstanding principal: <b>' + esc(money(b.getAttribute('data-out'))) + '</b></div>' +
            '<div class="pess-field"><label>Type</label><select class="input-field" data-f="mode">' + options([
              { value: 'full', label: 'Full foreclosure — repaid outside payroll' },
              { value: 'partial', label: 'Part prepayment — repaid outside payroll' },
              { value: 'payroll', label: 'Recover everything in one payroll' }], 'full') + '</select></div>' +
            '<div class="pess-field"><label>Amount (part prepayment)</label><input class="input-field" data-f="amount" inputmode="decimal"></div>' +
            '<div class="pess-field"><label>Recovery month (one payroll)</label><input type="month" class="input-field" data-f="period"></div>' +
            '<div class="pess-field"><label>Note</label><input class="input-field" data-f="note" maxlength="255"></div>', {
            okLabel: 'Confirm',
            onOk: function (m) {
              return api('/api/payroll/ess/loans/' + b.getAttribute('data-lf') + '/foreclose', { method: 'POST', body: {
                mode: val(m.body, '[data-f="mode"]'), amount: val(m.body, '[data-f="amount"]'),
                period: val(m.body, '[data-f="period"]'), note: val(m.body, '[data-f="note"]') } }).then(function () { renderMyTab(); });
            }
          });
        });
      });
    }, function (e) { if (live()) body.innerHTML = '<div class="pess-err">' + esc(errMsg(e)) + '</div>'; });
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  /payroll/separations
   * ════════════════════════════════════════════════════════════════════════ */
  var sep = { root: null, token: 0, status: '', canManage: false };
  var SEP_TYPES = [
    { value: 'resignation', label: 'Resignation' }, { value: 'termination', label: 'Termination' },
    { value: 'retirement', label: 'Retirement' }, { value: 'death', label: 'Death' },
    { value: 'disablement', label: 'Disablement' }, { value: 'absconding', label: 'Absconding' }, { value: 'other', label: 'Other' }];

  function mountSeparations(root, sub) {
    injectStyle();
    sep.root = root;
    var id = /^\/(\d+)$/.exec(sub || '');
    if (id) renderSepDetail(root, id[1]); else renderSepList(root);
  }

  function renderSepList(root) {
    var tok = ++sep.token;
    root.innerHTML = '<div class="pess-page"><div class="pess-empty">Loading…</div></div>';
    api('/api/payroll/fnf/separations' + (sep.status ? '?status=' + encodeURIComponent(sep.status) : '')).then(function (d) {
      if (tok !== sep.token) return;
      sep.canManage = !!d.canManage;
      var rows = (d.separations || []).map(function (s) {
        return '<tr class="pess-click" data-open="' + s.id + '"><td><b>' + esc(s.employeeName || s.email) + '</b><div class="pess-muted pess-small">' + esc(s.email) + '</div></td>' +
          '<td style="text-transform:capitalize">' + esc(s.separationType) + '</td><td>' + esc(fmtDate(s.lastWorkingDay)) + '</td>' +
          '<td>' + statusBadge(s.status) + '</td><td>' + esc(s.clearanceDone) + ' / ' + esc(s.clearanceTotal) + '</td>' +
          (sep.canManage ? '<td class="r">' + (s.status === 'initiated' || s.status === 'clearance' ? '<span class="pess-muted">—</span>' : esc(money(s.netPayable))) + '</td>' : '') + '</tr>';
      }).join('');
      root.innerHTML = '<div class="pess-page">' +
        '<div class="pess-head"><div><h1 class="pess-h1">Separations & F&F</h1>' +
        '<div class="pess-sub">' + (sep.canManage ? 'Exit clearance, Full & Final settlement, statements and No-Dues certificates.' : 'Exit handover items for your team members.') + '</div></div>' +
        (sep.canManage ? '<button class="btn-primary" data-pess="new">+ Initiate separation</button>' : '') + '</div>' +
        (sep.canManage ? '<div data-pess="emailcard"></div>' : '') +
        '<div class="pess-card"><div class="pess-row" style="justify-content:space-between;margin-bottom:10px"><h3 style="margin:0">Separations</h3>' +
        '<select class="input-field" data-f="status">' + options([{ value: '', label: 'All statuses' }, 'initiated', 'clearance', 'computed', 'approved', 'paid', 'cancelled'], sep.status) + '</select></div>' +
        (rows ? '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Employee</th><th>Type</th><th>Last working day</th><th>Status</th><th>Clearance</th>' +
          (sep.canManage ? '<th class="r">Net settlement</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="pess-empty">No separations.</div>') +
        '</div></div>';
      q(root, '[data-f="status"]').addEventListener('change', function () { sep.status = this.value; renderSepList(root); });
      root.querySelectorAll('[data-open]').forEach(function (tr) {
        tr.addEventListener('click', function () { SC.go('/payroll/separations/' + tr.getAttribute('data-open')); });
      });
      var nb = q(root, '[data-pess="new"]');
      if (nb) nb.addEventListener('click', initiateModal);
      if (sep.canManage) renderEmailCard(q(root, '[data-pess="emailcard"]'));
    }, function (e) {
      if (tok !== sep.token) return;
      root.innerHTML = '<div class="pess-page"><h1 class="pess-h1" style="margin-bottom:12px">Separations & F&F</h1><div class="pess-err">' + esc(errMsg(e)) + '</div></div>';
    });
  }

  function renderEmailCard(box) {
    api('/api/payroll/ess/payslips/email-runs').then(function (d) {
      var runs = d.runs || [];
      if (!runs.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="pess-card"><h3>Email payslips for a pay run</h3>' +
        '<div class="pess-small pess-muted" style="margin-bottom:10px">Each employee receives their payslip as a password-protected (AES-256) PDF. ' +
        'The email contains no salary figures; payslips already emailed are skipped.</div>' +
        '<div class="pess-row"><select class="input-field" data-f="run">' + options(runs.map(function (r) {
          return { value: r.id, label: monthLabel(r.period) + ' · ' + r.emailed + '/' + r.payslips + ' emailed' };
        }), runs[0].id) + '</select>' +
        '<label class="pess-small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="resend"> Resend to everyone</label>' +
        '<button class="btn-primary btn-sm" data-pess="send">Email payslips</button></div><div data-pess="emsg"></div></div>';
      var b = q(box, '[data-pess="send"]');
      b.addEventListener('click', function () {
        var resend = q(box, '[data-f="resend"]').checked;
        if (!confirm(resend ? 'Send every payslip of this run again?' : 'Email the payslips of this run?')) return;
        setBusy(b, true);
        api('/api/payroll/ess/payslips/email', { method: 'POST', body: { runId: Number(val(box, '[data-f="run"]')), resend: resend } }).then(function (r) {
          setBusy(b, false);
          var x = r.result || {};
          flash(q(box, '[data-pess="emsg"]'), 'Sent ' + (x.sent || 0) + ', already sent ' + (x.already_sent || 0) +
            ', skipped (no DOB/PAN on record) ' + (x.skipped_no_password || 0) + ', failed ' + (x.failed || 0) + '.', !(x.failed || x.skipped_no_password));
        }, function (e) { setBusy(b, false); flash(q(box, '[data-pess="emsg"]'), errMsg(e)); });
      });
    }, function () { box.innerHTML = ''; });
  }

  function initiateModal() {
    var m = modal('Initiate separation', '<div class="pess-empty">Loading employees…</div>', {
      okLabel: 'Initiate',
      onOk: function (mm) {
        return api('/api/payroll/fnf/separations', { method: 'POST', body: {
          email: val(mm.body, '[data-f="email"]'), separationType: val(mm.body, '[data-f="type"]'),
          resignationDate: val(mm.body, '[data-f="rdate"]'), lastWorkingDay: val(mm.body, '[data-f="lwd"]'),
          noticeDaysRequired: val(mm.body, '[data-f="req"]'), noticeDaysServed: val(mm.body, '[data-f="served"]'),
          noticeBuyout: q(mm.body, '[data-f="buyout"]').checked, reason: val(mm.body, '[data-f="reason"]') } })
          .then(function (s) { SC.go('/payroll/separations/' + s.id); });
      }
    });
    api('/api/payroll/fnf/employees').then(function (d) {
      m.body.innerHTML =
        '<div class="pess-field"><label>Employee</label><select class="input-field" data-f="email"><option value="">Choose…</option>' +
        options((d.employees || []).map(function (e) { return { value: e.email, label: e.name + ' (' + e.email + ')' }; }), '') + '</select></div>' +
        '<div class="pess-grid2"><div class="pess-field"><label>Type</label><select class="input-field" data-f="type">' + options(SEP_TYPES, 'resignation') + '</select></div>' +
        '<div class="pess-field"><label>Resignation / notice date</label><input type="date" class="input-field" data-f="rdate" value="' + todayIso() + '"></div></div>' +
        '<div class="pess-grid2"><div class="pess-field"><label>Last working day</label><input type="date" class="input-field" data-f="lwd"></div>' +
        '<div class="pess-field"><label>Notice required (days)</label><input type="number" min="0" class="input-field" data-f="req" value="30"></div></div>' +
        '<div class="pess-grid2"><div class="pess-field"><label>Notice served (days)</label><input type="number" min="0" class="input-field" data-f="served" placeholder="Auto"></div>' +
        '<div class="pess-field"><label>&nbsp;</label><label class="pess-small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="buyout"> Notice waived / bought out</label></div></div>' +
        '<div class="pess-field"><label>Reason</label><textarea class="input-field" data-f="reason" maxlength="2000"></textarea></div>';
    }, function (e) { m.msg(errMsg(e)); });
  }

  function renderSepDetail(root, id) {
    var tok = ++sep.token;
    root.innerHTML = '<div class="pess-page"><div class="pess-empty">Loading…</div></div>';
    api('/api/payroll/fnf/separations/' + id).then(function (s) {
      if (tok !== sep.token) return;
      var hr = 'computation' in s;
      var me = SC.me().email;
      var locked = ['approved', 'paid', 'cancelled'].indexOf(s.status) !== -1;
      var clrRows = (s.clearances || []).map(function (c) {
        var canAct = !locked && (hr || c.department === 'Manager');
        return '<tr><td><b>' + esc(c.department) + '</b></td><td>' + esc(c.item) + (c.note ? '<div class="pess-muted pess-small">' + esc(c.note) + '</div>' : '') + '</td>' +
          '<td>' + statusBadge(c.status) + (c.clearedBy ? '<div class="pess-muted pess-small">' + esc(c.clearedBy) + ' · ' + esc(fmtDate(c.clearedAt)) + '</div>' : '') + '</td>' +
          (hr ? '<td class="r">' + (canAct ? '<input class="input-field" style="width:110px;text-align:right" data-rec="' + c.id + '" value="' + esc(c.recoveryAmount) + '" inputmode="decimal">' : esc(money(c.recoveryAmount))) + '</td>' : '') +
          '<td class="r">' + (canAct ? '<div class="pess-row" style="justify-content:flex-end">' +
            (c.status !== 'cleared' ? '<button class="pess-btn pess-ok" data-clr="' + c.id + '" data-st="cleared">Clear</button>' : '') +
            (hr && c.status !== 'waived' ? '<button class="pess-btn" data-clr="' + c.id + '" data-st="waived">Waive</button>' : '') +
            (c.status !== 'pending' ? '<button class="pess-btn" data-clr="' + c.id + '" data-st="pending">Reopen</button>' : '') +
            (hr && c.status === 'cleared' ? '<button class="pess-btn" data-clr="' + c.id + '" data-st="cleared">Save</button>' : '') +
            '</div>' : '') + '</td></tr>';
      }).join('');
      var comp = s.computation || {};
      var compHtml = '';
      if (hr && comp.items) {
        var cur = comp.currency;
        var section = function (kind, title) {
          return '<tr><td colspan="3" class="pess-muted pess-small" style="font-weight:700;text-transform:uppercase;letter-spacing:.6px">' + title + '</td></tr>' +
            comp.items.filter(function (i) { return i.type === kind; }).map(function (i) {
              return '<tr><td>' + esc(i.label) + '</td><td class="pess-formula">' + esc(i.formula) + '</td><td class="r">' + (kind === 'deduction' && i.amount ? '− ' : '') + esc(money(i.amount, cur)) + '</td></tr>';
            }).join('');
        };
        var net = Number(comp.net) || 0;
        compHtml = '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Component</th><th>Computation</th><th class="r">Amount</th></tr></thead><tbody>' +
          section('earning', 'Payable') + section('deduction', 'Recoveries') +
          '<tr class="pess-tot"><td colspan="2">Total payable</td><td class="r">' + esc(money(comp.totalEarnings, cur)) + '</td></tr>' +
          '<tr class="pess-tot"><td colspan="2">Total recoveries</td><td class="r">' + esc(money(comp.totalDeductions, cur)) + '</td></tr></tbody></table></div>' +
          '<div class="pess-row" style="justify-content:space-between;margin-top:12px"><span class="pess-small pess-muted">Salary basis: ' + esc(comp.salaryBasis) +
          ' · computed ' + esc(fmtDate(comp.computedAt)) + ' by ' + esc(comp.computedBy || '') + '</span>' +
          '<span class="pess-net ' + (net >= 0 ? 'pos' : 'neg') + '">' + (net >= 0 ? 'Net payable ' : 'Net recoverable ') + esc(money(Math.abs(net), cur)) + '</span></div>';
      }
      var ov = comp.overrides || {};
      var initiator = String(s.createdBy || '').toLowerCase() === me;
      root.innerHTML = '<div class="pess-page">' +
        '<button class="pess-back" data-pess="back">← All separations</button>' +
        '<div class="pess-head"><div><h1 class="pess-h1">' + esc(s.employeeName || s.email) + ' ' + statusBadge(s.status) + '</h1>' +
        '<div class="pess-sub">' + esc(s.email) + ' · <span style="text-transform:capitalize">' + esc(s.separationType) + '</span> · last working day ' + esc(fmtDate(s.lastWorkingDay)) + '</div></div>' +
        (hr && (s.status === 'approved' || s.status === 'paid') ? '<div class="pess-row"><button class="pess-btn" data-doc="statement">Settlement statement</button><button class="pess-btn" data-doc="nodues">No-Dues certificate</button></div>' : '') + '</div>' +
        '<div data-pess="msg"></div>' +
        '<div class="pess-grid2"><div class="pess-card"><h3>Details</h3>' +
        '<div class="pess-kv"><span>Resignation date</span><span>' + esc(fmtDate(s.resignationDate)) + '</span></div>' +
        '<div class="pess-kv"><span>Last working day</span><span>' + esc(fmtDate(s.lastWorkingDay)) + '</span></div>' +
        '<div class="pess-kv"><span>Notice required / served</span><span>' + esc(s.noticeDaysRequired) + ' / ' + esc(s.noticeDaysServed) + ' days' + (s.noticeBuyout ? ' (waived)' : '') + '</span></div>' +
        '<div class="pess-kv"><span>Initiated by</span><span>' + esc(s.createdBy) + '</span></div>' +
        (s.approvedBy ? '<div class="pess-kv"><span>Approved by</span><span>' + esc(s.approvedBy) + ' · ' + esc(fmtDate(s.approvedAt)) + '</span></div>' : '') +
        (s.paidAt ? '<div class="pess-kv"><span>Paid</span><span>' + esc(fmtDate(s.paidAt)) + (s.paymentReference ? ' · ' + esc(s.paymentReference) : '') + '</span></div>' : '') +
        (s.reason ? '<div class="pess-small" style="margin-top:8px">' + esc(s.reason) + '</div>' : '') +
        (hr && !locked ? '<div class="pess-row" style="margin-top:12px"><button class="pess-btn pess-dng" data-pess="cancel">Cancel separation</button></div>' : '') + '</div>' +
        (hr ? '<div class="pess-card"><h3>Compute settlement</h3>' + (locked ? '<div class="pess-muted pess-small">The settlement is ' + esc(s.status) + '.</div>' :
          '<div class="pess-grid3">' +
          '<div class="pess-field"><label>Payable days</label><input class="input-field" data-ov="payableDays" value="' + esc(ov.payableDays == null ? '' : ov.payableDays) + '" placeholder="Auto"></div>' +
          '<div class="pess-field"><label>Leave days</label><input class="input-field" data-ov="leaveDays" value="' + esc(ov.leaveDays == null ? '' : ov.leaveDays) + '" placeholder="From leave"></div>' +
          '<div class="pess-field"><label>TDS rate %</label><input class="input-field" data-ov="tdsRate" value="' + esc(ov.tdsRate == null ? '' : ov.tdsRate) + '" placeholder="Auto"></div>' +
          '<div class="pess-field"><label>Monthly gross</label><input class="input-field" data-ov="lastDrawnGross" value="' + esc(ov.lastDrawnGross == null ? '' : ov.lastDrawnGross) + '" placeholder="Last payslip"></div>' +
          '<div class="pess-field"><label>Monthly basic</label><input class="input-field" data-ov="lastDrawnBasic" value="' + esc(ov.lastDrawnBasic == null ? '' : ov.lastDrawnBasic) + '" placeholder="Last payslip"></div>' +
          '<div class="pess-field"><label>Date of joining</label><input type="date" class="input-field" data-ov="dateOfJoining" value="' + esc(ov.dateOfJoining || '') + '"></div></div>' +
          '<label class="pess-small" style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><input type="checkbox" data-ov="waiveNotice"' + (ov.waiveNotice ? ' checked' : '') + '> Waive notice recovery</label>' +
          '<button class="btn-primary btn-sm" data-pess="compute">' + (comp.items ? 'Recompute' : 'Compute') + '</button>' +
          '<div class="pess-hint">Leave blank to use payroll and leave records. Changing clearance recoveries requires a recompute.</div>') + '</div>' : '') + '</div>' +
        '<div class="pess-card"><h3>Clearance checklist (' + esc(s.clearanceDone) + ' / ' + esc(s.clearanceTotal) + ')</h3>' +
        '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Dept</th><th>Item</th><th>Status</th>' + (hr ? '<th class="r">Recovery</th>' : '') + '<th></th></tr></thead><tbody>' + clrRows + '</tbody></table></div>' +
        (hr && !locked ? '<div class="pess-row" style="margin-top:12px"><select class="input-field" data-f="dept">' + options(['IT', 'Finance', 'HR', 'Admin', 'Manager', 'Other'], 'Other') + '</select>' +
          '<input class="input-field" data-f="item" placeholder="Add an item" style="flex:1;min-width:160px"><input class="input-field" data-f="recovery" placeholder="Recovery" style="width:110px">' +
          '<button class="pess-btn" data-pess="additem">Add</button></div>' : '') + '</div>' +
        '<div data-pess="assets"></div>' +
        (hr && comp.items ? '<div class="pess-card"><h3>Full & Final computation</h3>' + compHtml +
          (s.status === 'computed' ? '<div class="pess-row" style="margin-top:14px;justify-content:flex-end">' +
            (initiator ? '<span class="pess-muted pess-small">You initiated this separation, so another F&F manager must approve it.</span>' :
              '<button class="btn-primary" data-pess="approve">Approve settlement</button>') + '</div>' : '') +
          (s.status === 'approved' ? '<div class="pess-row" style="margin-top:14px;justify-content:flex-end"><input class="input-field" data-f="ref" placeholder="Payment reference (UTR / cheque)" maxlength="100">' +
            '<button class="btn-primary" data-pess="paid">Mark paid</button></div>' : '') + '</div>' : '') +
        '</div>';

      function act(promise, btn) {
        setBusy(btn, true);
        return promise.then(function () { renderSepDetail(root, id); }, function (e) {
          setBusy(btn, false);
          flash(q(root, '[data-pess="msg"]'), errMsg(e));
          try { q(root, '[data-pess="msg"]').scrollIntoView({ block: 'nearest' }); } catch (_) {}
        });
      }
      q(root, '[data-pess="back"]').addEventListener('click', function () { SC.go('/payroll/separations'); });
      renderSepAssets(q(root, '[data-pess="assets"]'), id, tok, function () { renderSepDetail(root, id); }, act);
      root.querySelectorAll('[data-clr]').forEach(function (b) {
        b.addEventListener('click', function () {
          var cid = b.getAttribute('data-clr');
          var body = { status: b.getAttribute('data-st') };
          var rec = q(root, '[data-rec="' + cid + '"]');
          if (rec) body.recoveryAmount = rec.value || '0';
          act(api('/api/payroll/fnf/separations/' + id + '/clearances/' + cid, { method: 'POST', body: body }), b);
        });
      });
      var add = q(root, '[data-pess="additem"]');
      if (add) add.addEventListener('click', function () {
        act(api('/api/payroll/fnf/separations/' + id + '/clearances', { method: 'POST', body: {
          department: val(root, '[data-f="dept"]'), item: val(root, '[data-f="item"]'), recoveryAmount: val(root, '[data-f="recovery"]') || '0' } }), add);
      });
      var cb = q(root, '[data-pess="compute"]');
      if (cb) cb.addEventListener('click', function () {
        var o = {};
        root.querySelectorAll('[data-ov]').forEach(function (el) {
          var k = el.getAttribute('data-ov');
          if (el.type === 'checkbox') { if (el.checked) o[k] = true; } else if (String(el.value).trim() !== '') o[k] = String(el.value).trim();
        });
        act(api('/api/payroll/fnf/separations/' + id + '/compute', { method: 'POST', body: { overrides: o } }), cb);
      });
      var ab = q(root, '[data-pess="approve"]');
      if (ab) ab.addEventListener('click', function () {
        if (!confirm('Approve this Full & Final settlement? The statement and No-Dues certificate will be issued.')) return;
        act(api('/api/payroll/fnf/separations/' + id + '/approve', { method: 'POST', body: {} }), ab);
      });
      var pb = q(root, '[data-pess="paid"]');
      if (pb) pb.addEventListener('click', function () {
        if (!confirm('Mark this settlement as paid? Loans will be closed and pending reimbursements settled.')) return;
        act(api('/api/payroll/fnf/separations/' + id + '/mark-paid', { method: 'POST', body: { reference: val(root, '[data-f="ref"]') } }), pb);
      });
      var xb = q(root, '[data-pess="cancel"]');
      if (xb) xb.addEventListener('click', function () {
        if (!confirm('Cancel this separation?')) return;
        act(api('/api/payroll/fnf/separations/' + id + '/cancel', { method: 'POST', body: {} }), xb);
      });
      root.querySelectorAll('[data-doc]').forEach(function (b) {
        b.addEventListener('click', function () {
          setBusy(b, true);
          api('/api/payroll/fnf/separations/' + id + '/documents').then(function (d) {
            setBusy(b, false);
            var st = b.getAttribute('data-doc') === 'statement';
            showDocument(st ? 'Full & Final settlement statement' : 'No-Dues clearance certificate', st ? d.statementHtml : d.noDuesHtml);
          }, function (e) { setBusy(b, false); flash(q(root, '[data-pess="msg"]'), errMsg(e)); });
        });
      });
    }, function (e) {
      if (tok !== sep.token) return;
      root.innerHTML = '<div class="pess-page"><button class="pess-back" data-pess="back">← All separations</button><div class="pess-err">' + esc(errMsg(e)) + '</div></div>';
      q(root, '[data-pess="back"]').addEventListener('click', function () { SC.go('/payroll/separations'); });
    });
  }

  /* IT asset recovery (hrms_plus/assets_links.py): one IT clearance item per
     asset the leaver holds. Recording the return here clears that item; lost /
     damaged puts the recovery on it, which the computation above sums. */
  var ASSET_ST = { active: ['With employee', 'warn'], returned: ['Returned', 'success'], lost: ['Lost', 'danger'], written_off: ['Written off', 'muted'] };
  function renderSepAssets(box, id, tok, reload, act) {
    if (!box) return;
    api('/api/assets/separations/' + id).then(function (d) {
      if (tok !== sep.token) return;
      if (d.created) { reload(); return; }        // items were just added to the checklist
      var rows = d.assets || [];
      var can = d.canAct && !d.locked;
      box.innerHTML = '<div class="pess-card"><h3>IT asset recovery</h3>' + (rows.length ?
        '<div class="pess-table-wrap"><table class="pess-table"><thead><tr><th>Asset</th><th>Status</th><th>Clearance</th><th class="r">Recovery</th>' + (can ? '<th></th>' : '') + '</tr></thead><tbody>' +
        rows.map(function (r) {
          var a = r.asset || {}, stt = ASSET_ST[r.status] || [r.status, 'muted'], lic = a.category === 'license';
          return '<tr><td><b>' + esc(a.label) + '</b><div class="pess-muted pess-small">' + esc(a.assetTag) + (a.serialNumber ? ' · S/N ' + esc(a.serialNumber) : '') +
            (a.purchaseCost ? ' · cost ' + esc(money(a.purchaseCost, a.currency)) : '') + '</div></td>' +
            '<td>' + badge(stt[0], stt[1]) + (r.returnCondition ? '<div class="pess-muted pess-small">' + esc(r.returnCondition) + (r.receivedBy ? ' · ' + esc(r.receivedBy) : '') + '</div>' : '') + '</td>' +
            '<td>' + (r.clearance ? statusBadge(r.clearance.status) : '<span class="pess-muted">—</span>') + '</td>' +
            '<td class="r">' + (r.status === 'active' && can && !lic ? '<input class="input-field" style="width:100px;text-align:right" data-arec="' + r.id + '" placeholder="0" inputmode="decimal">' :
              esc(money(r.clearance ? r.clearance.recoveryAmount : r.recoveryAmount))) + '</td>' +
            (can ? '<td class="r">' + (r.status === 'active' ? '<div class="pess-row" style="justify-content:flex-end">' +
              (lic ? '<button class="pess-btn pess-ok" data-aret="' + r.id + '" data-cond="good">Revoke seat</button>' :
                '<button class="pess-btn pess-ok" data-aret="' + r.id + '" data-cond="good">Returned</button>' +
                '<button class="pess-btn" data-aret="' + r.id + '" data-cond="damaged">Damaged</button>' +
                '<button class="pess-btn pess-dng" data-alost="' + r.id + '">Lost</button>') + '</div>' : '') + '</td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div><div class="pess-hint">Recovery applies to damaged or lost assets and is added to the clearance recoveries; recompute the settlement afterwards.</div>' :
        '<div class="pess-muted pess-small">No IT assets are registered to this employee.</div>') + '</div>';
      function recOf(aid) { var el = q(box, '[data-arec="' + aid + '"]'); return el && String(el.value).trim() ? String(el.value).trim() : null; }
      box.querySelectorAll('[data-aret]').forEach(function (b) {
        b.addEventListener('click', function () {
          var aid = b.getAttribute('data-aret'), cond = b.getAttribute('data-cond');
          act(api('/api/assets/assignments/' + aid + '/return', { method: 'POST', body: { condition: cond, recoveryAmount: cond === 'damaged' ? recOf(aid) : null } }), b);
        });
      });
      box.querySelectorAll('[data-alost]').forEach(function (b) {
        b.addEventListener('click', function () {
          var aid = b.getAttribute('data-alost');
          if (!confirm('Record this asset as lost' + (recOf(aid) ? ' with a recovery of ' + recOf(aid) : ' with no recovery') + '?')) return;
          act(api('/api/assets/assignments/' + aid + '/lost', { method: 'POST', body: { recoveryAmount: recOf(aid) } }), b);
        });
      });
    }, function () { if (tok === sep.token) box.innerHTML = ''; });   // no access to the register: section hidden
  }

  /* ── registration ──────────────────────────────────────────────────────── */
  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: '/my-pay', title: 'My Pay',
      mount: function (root) { mountMyPay(root); },
      update: function (root) { mountMyPay(root); },
      unmount: function () { my.token++; my.root = null; }
    });
    SC.register({
      base: '/payroll/separations', title: 'Separations & F&F',
      mount: function (root, sub) { mountSeparations(root, sub); },
      update: function (root, sub) { mountSeparations(root, sub); },
      unmount: function () { sep.token++; sep.root = null; }
    });
  }
  (function wait(n) {
    if (window.HRMSSidecar) { register(); return; }
    if (n > 200) return;
    setTimeout(function () { wait(n + 1); }, 50);
  })(0);
})();
