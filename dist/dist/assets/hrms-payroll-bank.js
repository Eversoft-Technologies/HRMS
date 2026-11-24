/**
 * hrms-payroll-bank.js  v1
 * Payouts & Banking — /payroll/banking (tabs) and /payroll/banking/batches/<id>.
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): renders into the sidecar's
 * own root; React-owned DOM is never touched. Modals are our own nodes on
 * <body> and are removed on close / unmount.
 *
 * Backend: api/payroll_ext/banking.py + channels.py (urls_bank.py)
 *   GET  /api/payroll/banking/meta | runs | batches | batches/<id> | reconciliation | integrations
 *   GET  /api/payroll/banking/runs/<id>/preview
 *   POST /api/payroll/banking/runs/<id>/prepare            (maker, fresh sign-in)
 *   POST /api/payroll/banking/otp {purpose,id}             (emails a 6-digit code)
 *   POST /api/payroll/banking/batches/<id>/release {code}  (checker ≠ maker, fresh sign-in + OTP)
 *   POST /api/payroll/banking/batches/<id>/poll | cancel | simulate-settle
 *   POST /api/payroll/banking/transactions/<id>/requeue    (new bank details + OTP)
 *   POST /api/payroll/banking/payments/<id>/bank-details   (fix bad data + OTP)
 *   PUT/DELETE /api/payroll/banking/integrations/<p>, POST …/<p>/test
 *   GET  /api/payroll/alerts/deliveries, POST /api/payroll/alerts/payrun/sweep
 *
 * Secrets are write-only: the server never returns them; this page only
 * shows which fields are set.
 */
(function () {
  'use strict';
  if (window.__hrmsPayrollBankLoaded) return;
  window.__hrmsPayrollBankLoaded = true;

  var BASE = '/payroll/banking';
  var STYLE_ID = 'hrms-pbank-style';
  var TAB_KEY = 'hrms_pbank_tab';
  var SC = null;
  var state = { root: null, meta: null, token: 0, tab: 'batches', modal: null, preview: null, idem: '' };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, { time: true }); } catch (_) {}
    return String(v).replace('T', ' ').slice(0, 16);
  }
  function money(v) {
    var n = Number(v || 0);
    try { return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch (_) { return '₹' + n.toFixed(2); }
  }
  function rid() {
    var s = '';
    try { var a = new Uint8Array(12); window.crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2); }
    catch (_) { s = String(Date.now()) + String(Math.random()).slice(2, 12); }
    return 'ui-' + s;
  }
  function errText(e) {
    var m = (e && e.message) || 'Something went wrong.';
    if (e && e.data && e.data.problems && e.data.problems.length && typeof e.data.problems[0] === 'string') {
      m += ' ' + e.data.problems.slice(0, 5).join(' ');
    }
    return m;
  }
  function errBox(e) { return '<div class="pbank-err">' + esc(errText(e)) + '</div>'; }
  function okBox(m) { return '<div class="pbank-ok">' + esc(m) + '</div>'; }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.pbank-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.pbank-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.pbank-h1{font-size:20px;font-weight:700;margin:0}',
      '.pbank-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.pbank-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.pbank-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.pbank-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.pbank-card{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:16px;margin-bottom:16px}',
      '.pbank-card h3{margin:0 0 12px;font-size:15px}',
      '.pbank-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}',
      '.pbank-row .pbank-field{flex:1;min-width:160px}',
      '.pbank-field{margin-bottom:10px}',
      '.pbank-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.pbank-field .input-field{width:100%;box-sizing:border-box}',
      '.pbank-field textarea.input-field{min-height:74px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;resize:vertical}',
      '.pbank-table-wrap{overflow-x:auto}',
      '.pbank-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.pbank-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.pbank-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.pbank-table tr.pbank-click{cursor:pointer}',
      '.pbank-table tr.pbank-click:hover td{background:var(--bg3)}',
      '.pbank-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.pbank-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text2);white-space:nowrap}',
      '.pbank-muted{color:var(--text3)}',
      '.pbank-small{font-size:12px}',
      '.pbank-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.pbank-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.pbank-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.pbank-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.pbank-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.pbank-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.pbank-err{padding:10px 14px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin:10px 0}',
      '.pbank-ok{padding:10px 14px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent);font-size:13px;margin:10px 0}',
      '.pbank-note{padding:10px 14px;border-radius:8px;color:var(--text2);background:color-mix(in srgb,var(--warn) 10%,var(--bg2));border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);font-size:12.5px;line-height:1.5;margin-bottom:14px}',
      '.pbank-empty{padding:30px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.pbank-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.pbank-btn{background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.pbank-btn:hover{border-color:var(--accent)}',
      '.pbank-btn.pbank-danger{color:var(--danger)}',
      '.pbank-btn[disabled],.btn-primary[disabled]{opacity:.55;cursor:not-allowed}',
      '.pbank-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}',
      '.pbank-kpi{background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:10px 12px}',
      '.pbank-kpi span{display:block;font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}',
      '.pbank-kpi b{display:block;font-size:17px;margin-top:3px}',
      '.pbank-back{display:inline-block;font-size:13px;color:var(--text2);text-decoration:none;margin-bottom:12px;cursor:pointer}',
      '.pbank-back:hover{color:var(--accent)}',
      '.pbank-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}',
      '.pbank-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--border)}',
      '.pbank-kv span:first-child{color:var(--text3)}',
      '.pbank-kv span:last-child{text-align:right;word-break:break-all}',
      '.pbank-set{font-size:10.5px;font-weight:700;color:var(--success);margin-left:6px;text-transform:none;letter-spacing:0}',
      '.pbank-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2);cursor:pointer;user-select:none}',
      '.pbank-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.pbank-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:560px;padding:20px;color:var(--text);max-height:90vh;overflow:auto;box-sizing:border-box}',
      '.pbank-modal h3{margin:0 0 12px;font-size:16px}',
      '.pbank-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;letter-spacing:8px;text-align:center}',
      '.pbank-issue{color:var(--danger);font-size:12px}',
      '.pbank-busy{opacity:.6;pointer-events:none}',
      '@media (max-width:640px){.pbank-card{padding:12px}.pbank-h1{font-size:18px}.pbank-table{font-size:12px}}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── badges ────────────────────────────────────────────────────────────── */
  var STATUS_CLS = {
    awaiting_release: 'pbank-c-warn', submitted: 'pbank-c-accent', partially_paid: 'pbank-c-warn', paid: 'pbank-c-success',
    failed: 'pbank-c-danger', cancelled: 'pbank-c-muted', draft: 'pbank-c-muted',
    queued: 'pbank-c-muted', sent: 'pbank-c-accent', success: 'pbank-c-success', requeued: 'pbank-c-muted',
    simulated: 'pbank-c-accent', skipped: 'pbank-c-muted', approved: 'pbank-c-success'
  };
  function badge(text, cls) { return '<span class="pbank-badge ' + (cls || 'pbank-c-muted') + '">' + esc(text) + '</span>'; }
  function stBadge(s) { return badge(String(s || '').replace(/_/g, ' '), STATUS_CLS[s]); }
  function modeBadge(m) { return m === 'live' ? badge('LIVE', 'pbank-c-danger') : badge('TEST', 'pbank-c-muted'); }

  /* ── modal ─────────────────────────────────────────────────────────────── */
  function closeModal() {
    if (state.modal && state.modal.parentNode) state.modal.parentNode.removeChild(state.modal);
    state.modal = null;
  }
  function openModal(html) {
    closeModal();
    var ov = document.createElement('div');
    ov.className = 'pbank-overlay';
    ov.innerHTML = '<div class="pbank-modal" role="dialog" aria-modal="true">' + html + '</div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
    state.modal = ov;
    return ov.firstChild;
  }
  function q(el, sel) { return el.querySelector(sel); }

  /* OTP two-step: request a code, then confirm with it. */
  function otpFlow(opts) {
    // opts: title, intro, fieldsHtml, purpose, id, confirmLabel, collect(modal)->body|null, submit(body)->Promise, done(result)
    var m = openModal(
      '<h3>' + esc(opts.title) + '</h3>' +
      (opts.intro ? '<div class="pbank-sub" style="margin:0 0 12px">' + opts.intro + '</div>' : '') +
      (opts.fieldsHtml || '') +
      '<div data-pb="otpwrap" style="display:none" class="pbank-field"><label>6-digit code from your email</label>' +
      '<input class="input-field pbank-code" data-pb="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
      '<div data-pb="msg"></div>' +
      '<div class="pbank-btns" style="justify-content:flex-end;margin-top:12px">' +
      '<button class="pbank-btn" data-pb="cancel">Cancel</button>' +
      '<button class="pbank-btn" data-pb="send">Email me a code</button>' +
      '<button class="btn-primary btn-sm" data-pb="go" disabled>' + esc(opts.confirmLabel || 'Confirm') + '</button></div>');
    var msg = q(m, '[data-pb="msg"]');
    q(m, '[data-pb="cancel"]').onclick = closeModal;
    q(m, '[data-pb="send"]').onclick = function () {
      var b = this;
      if (opts.collect && opts.collect(m, true) === null) return;
      b.disabled = true;
      api('/api/payroll/banking/otp', { method: 'POST', body: { purpose: opts.purpose, id: opts.id } }).then(function (d) {
        msg.innerHTML = okBox(d.message || 'Code sent.');
        q(m, '[data-pb="otpwrap"]').style.display = '';
        q(m, '[data-pb="go"]').disabled = false;
        q(m, '[data-pb="code"]').focus();
        b.textContent = 'Resend code';
        setTimeout(function () { b.disabled = false; }, 30000);
      }).catch(function (e) { b.disabled = false; msg.innerHTML = errBox(e); });
    };
    q(m, '[data-pb="go"]').onclick = function () {
      var b = this;
      var code = (q(m, '[data-pb="code"]').value || '').replace(/\D/g, '');
      if (code.length !== 6) { msg.innerHTML = errBox({ message: 'Enter the 6-digit code.' }); return; }
      var body = opts.collect ? opts.collect(m, false) : {};
      if (body === null) return;
      body.code = code;
      b.disabled = true; b.textContent = 'Working…';
      opts.submit(body).then(function (res) {
        closeModal();
        if (opts.done) opts.done(res);
      }).catch(function (e) {
        b.disabled = false; b.textContent = opts.confirmLabel || 'Confirm';
        var extra = '';
        if (e && e.data && e.data.errors) {
          extra = Object.keys(e.data.errors).map(function (k) { return e.data.errors[k]; }).join(' ');
        }
        msg.innerHTML = errBox({ message: errText(e) + (extra ? ' ' + extra : '') });
      });
    };
    return m;
  }

  function bankFields() {
    return '<div class="pbank-field"><label>Account number</label><input class="input-field" data-pb="acc" inputmode="numeric" autocomplete="off" maxlength="22"></div>' +
      '<div class="pbank-row"><div class="pbank-field"><label>IFSC</label><input class="input-field" data-pb="ifsc" maxlength="11" style="text-transform:uppercase" autocomplete="off"></div>' +
      '<div class="pbank-field"><label>Bank name</label><input class="input-field" data-pb="bank" maxlength="100"></div></div>';
  }
  function collectBank(m, quiet) {
    var acc = (q(m, '[data-pb="acc"]').value || '').replace(/[\s-]/g, '');
    var ifsc = (q(m, '[data-pb="ifsc"]').value || '').trim().toUpperCase();
    var bank = (q(m, '[data-pb="bank"]').value || '').trim();
    var msg = q(m, '[data-pb="msg"]');
    if (!/^\d{9,18}$/.test(acc)) { msg.innerHTML = errBox({ message: 'Account number must be 9–18 digits.' }); return null; }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { msg.innerHTML = errBox({ message: 'IFSC must look like ABCD0123456.' }); return null; }
    if (quiet) return {};
    return { accountNumber: acc, ifsc: ifsc, bankName: bank };
  }

  /* ── page shell ───────────────────────────────────────────────────────── */
  var TABS = [
    { id: 'batches', label: 'Payout batches' },
    { id: 'recon', label: 'Reconciliation' },
    { id: 'integrations', label: 'Integrations', need: 'canIntegrations' },
    { id: 'alerts', label: 'Alerts log' }
  ];

  function shell(root, inner) {
    var meta = state.meta || {};
    var tabs = TABS.filter(function (t) { return !t.need || meta[t.need]; });
    root.innerHTML = '<div class="pbank-page">' +
      '<div class="pbank-head"><div><h1 class="pbank-h1">Payouts &amp; Banking</h1>' +
      '<div class="pbank-sub">Salary transfers through the bank API — prepared by payroll (maker), released by a second person (checker) with an emailed code.</div></div></div>' +
      '<div class="pbank-tabs">' + tabs.map(function (t) {
        return '<button class="pbank-tab' + (state.tab === t.id ? ' on' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>';
      }).join('') + '</div><div data-pb="body"></div></div>';
    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () {
        state.tab = b.getAttribute('data-tab');
        try { localStorage.setItem(TAB_KEY, state.tab); } catch (_) {}
        if (SC.current() && SC.current().sub) SC.go(BASE); else renderTabs(root);
      };
    });
    return q(root, '[data-pb="body"]');
  }

  function renderTabs(root) {
    var body = shell(root);
    if (state.tab === 'recon') renderRecon(body);
    else if (state.tab === 'integrations' && state.meta.canIntegrations) renderIntegrations(body);
    else if (state.tab === 'alerts') renderAlerts(body);
    else renderBatches(body);
  }

  /* ── batches tab ──────────────────────────────────────────────────────── */
  function renderBatches(body) {
    var tok = state.token;
    var meta = state.meta;
    body.innerHTML = (meta.canPrepare ? '<div class="pbank-card" data-pb="prep"><h3>Prepare a payout</h3><div class="pbank-muted pbank-small">Loading approved pay runs…</div></div>' : '') +
      '<div class="pbank-card"><h3>Batches</h3><div data-pb="list"><div class="pbank-muted pbank-small">Loading…</div></div></div>';
    if (meta.canPrepare) loadPrepare(q(body, '[data-pb="prep"]'), tok);
    api('/api/payroll/banking/batches').then(function (d) {
      if (tok !== state.token) return;
      var list = q(body, '[data-pb="list"]');
      if (!d.batches.length) { list.innerHTML = '<div class="pbank-empty">No payout batches yet.</div>'; return; }
      list.innerHTML = '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>#</th><th>Run</th><th>Provider</th><th>Status</th>' +
        '<th class="pbank-num">Transfers</th><th class="pbank-num">Total</th><th>Prepared by</th><th>Released by</th><th>Created</th></tr></thead><tbody>' +
        d.batches.map(function (b) {
          return '<tr class="pbank-click" data-batch="' + b.id + '"><td class="pbank-mono">#' + b.id + (b.isFollowUp ? ' ↻' : '') + '</td>' +
            '<td>' + esc(b.runLabel) + '</td><td>' + esc(b.provider.toUpperCase()) + ' ' + modeBadge(b.mode) + '</td><td>' + stBadge(b.status) + '</td>' +
            '<td class="pbank-num">' + b.itemCount + '</td><td class="pbank-num">' + money(b.totalAmount) + '</td>' +
            '<td class="pbank-small">' + esc(b.createdBy) + '</td><td class="pbank-small">' + esc(b.releasedBy || '—') + '</td>' +
            '<td class="pbank-small pbank-muted">' + esc(fmtDate(b.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      Array.prototype.forEach.call(list.querySelectorAll('[data-batch]'), function (tr) {
        tr.onclick = function () { SC.go(BASE + '/batches/' + tr.getAttribute('data-batch')); };
      });
    }).catch(function (e) { if (tok === state.token) q(body, '[data-pb="list"]').innerHTML = errBox(e); });
  }

  function loadPrepare(card, tok) {
    api('/api/payroll/banking/runs').then(function (d) {
      if (tok !== state.token) return;
      var runs = d.runs.filter(function (r) { return r.status === 'approved'; });
      var prov = state.meta.providers || {};
      var opts = ['simulated', 'icici', 'hdfc'].filter(function (p) { return p === 'simulated' || (prov[p] && prov[p].enabled); });
      if (!runs.length) {
        card.innerHTML = '<h3>Prepare a payout</h3><div class="pbank-empty">No approved pay run is waiting for payment.</div>';
        return;
      }
      card.innerHTML = '<h3>Prepare a payout</h3><div class="pbank-row">' +
        '<div class="pbank-field"><label>Approved pay run</label><select class="input-field" data-pb="run">' +
        runs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.label) + ' — ' + money(r.totalNet) + ' (' + r.paid + '/' + r.payments + ' paid)</option>'; }).join('') +
        '</select></div><div class="pbank-field"><label>Bank</label><select class="input-field" data-pb="prov">' +
        opts.map(function (p) {
          var mode = p === 'simulated' ? 'test' : prov[p].mode;
          return '<option value="' + p + '">' + (p === 'simulated' ? 'Simulated bank' : p.toUpperCase()) + ' (' + mode + ')</option>';
        }).join('') + '</select></div>' +
        '<div class="pbank-field" style="max-width:180px"><label>Transfer mode</label><select class="input-field" data-pb="mode">' +
        '<option value="AUTO">Auto (by amount)</option><option>NEFT</option><option>IMPS</option><option>RTGS</option></select></div>' +
        '<div class="pbank-field"><button class="pbank-btn" data-pb="preview">Preview</button></div></div>' +
        '<div class="pbank-small pbank-muted">Auto: RTGS from ' + money(state.meta.settings.rtgsMin) + ', otherwise ' + esc(state.meta.settings.defaultMode) + '.</div>' +
        '<div data-pb="pv"></div>';
      q(card, '[data-pb="preview"]').onclick = function () { doPreview(card); };
    }).catch(function (e) { if (tok === state.token) card.innerHTML = '<h3>Prepare a payout</h3>' + errBox(e); });
  }

  function doPreview(card) {
    var runId = q(card, '[data-pb="run"]').value;
    var mode = q(card, '[data-pb="mode"]').value;
    var pv = q(card, '[data-pb="pv"]');
    pv.innerHTML = '<div class="pbank-muted pbank-small" style="margin-top:10px">Checking bank details…</div>';
    state.idem = rid();
    api('/api/payroll/banking/runs/' + encodeURIComponent(runId) + '/preview?mode=' + encodeURIComponent(mode)).then(function (d) {
      var h = '';
      if (!d.paymentsCreated) {
        h += '<div class="pbank-note">Payment records for this run will be created from the approved entries when you prepare the batch.</div>';
      } else {
        h += '<div class="pbank-kpis"><div class="pbank-kpi"><span>Ready</span><b>' + d.eligible.length + '</b></div>' +
          '<div class="pbank-kpi"><span>Total</span><b>' + money(d.eligibleTotal) + '</b></div>' +
          '<div class="pbank-kpi"><span>Problems</span><b style="color:' + (d.problems.length ? 'var(--danger)' : 'inherit') + '">' + d.problems.length + '</b></div></div>';
        if (d.eligible.length) {
          h += '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>Employee</th><th>Account</th><th>IFSC</th><th>Mode</th><th class="pbank-num">Amount</th></tr></thead><tbody>' +
            d.eligible.map(function (p) {
              return '<tr><td>' + esc(p.employeeName || p.email) + '</td><td class="pbank-mono">' + esc(p.account) + '</td><td class="pbank-mono">' + esc(p.ifsc) + '</td><td>' + esc(p.mode) + '</td><td class="pbank-num">' + money(p.amount) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        if (d.problems.length) h += problemsTable(d.problems);
      }
      h += '<div class="pbank-btns" style="margin-top:12px"><button class="btn-primary btn-sm" data-pb="prepare"' +
        (d.paymentsCreated && !d.eligible.length ? ' disabled' : '') + '>Prepare batch</button>' +
        '<span class="pbank-small pbank-muted">A different person with release rights must then release it.</span></div><div data-pb="pmsg"></div>';
      pv.innerHTML = h;
      wireProblems(pv, function () { doPreview(card); });
      q(pv, '[data-pb="prepare"]').onclick = function () {
        var b = this;
        b.disabled = true; b.textContent = 'Preparing…';
        api('/api/payroll/banking/runs/' + encodeURIComponent(runId) + '/prepare', {
          method: 'POST', body: { provider: q(card, '[data-pb="prov"]').value, transferMode: mode, idempotencyKey: state.idem }
        }).then(function (r) { SC.go(BASE + '/batches/' + r.batch.id); })
          .catch(function (e) {
            b.disabled = false; b.textContent = 'Prepare batch';
            var extra = e && e.data && e.data.problems && e.data.problems.length && typeof e.data.problems[0] === 'object' ? problemsTable(e.data.problems) : '';
            q(pv, '[data-pb="pmsg"]').innerHTML = errBox(e) + extra;
            wireProblems(q(pv, '[data-pb="pmsg"]'), function () { doPreview(card); });
          });
      };
    }).catch(function (e) { pv.innerHTML = errBox(e); });
  }

  function problemsTable(problems) {
    return '<h4 style="margin:14px 0 6px;font-size:13px;color:var(--danger)">Bank data problems — not included</h4>' +
      '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>Employee</th><th>Account</th><th>IFSC</th><th class="pbank-num">Amount</th><th>Issue</th><th></th></tr></thead><tbody>' +
      problems.map(function (p) {
        return '<tr><td>' + esc(p.employeeName || p.email) + '</td><td class="pbank-mono">' + esc(p.account || '—') + '</td><td class="pbank-mono">' + esc(p.ifsc || '—') + '</td>' +
          '<td class="pbank-num">' + money(p.amount) + '</td><td class="pbank-issue">' + esc((p.issues || []).join('; ')) + '</td>' +
          '<td>' + (state.meta.canPrepare ? '<button class="pbank-btn" data-fix="' + p.paymentId + '" data-name="' + esc(p.employeeName || p.email) + '">Fix bank details</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function wireProblems(scope, after) {
    Array.prototype.forEach.call(scope.querySelectorAll('[data-fix]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-fix');
        otpFlow({
          title: 'Fix bank details', intro: 'For <b>' + esc(b.getAttribute('data-name')) + '</b>. Changing bank details needs a code from your email.',
          fieldsHtml: bankFields(), purpose: 'bank_update', id: Number(id), confirmLabel: 'Save details',
          collect: collectBank,
          submit: function (body) { return api('/api/payroll/banking/payments/' + id + '/bank-details', { method: 'POST', body: body }); },
          done: after
        });
      };
    });
  }

  /* ── batch detail ─────────────────────────────────────────────────────── */
  function renderDetail(root, id) {
    var tok = state.token;
    root.innerHTML = '<div class="pbank-page"><a class="pbank-back" data-pb="back">← Payouts &amp; Banking</a><div data-pb="d"><div class="pbank-muted">Loading…</div></div></div>';
    q(root, '[data-pb="back"]').onclick = function () { state.tab = 'batches'; SC.go(BASE); };
    api('/api/payroll/banking/batches/' + encodeURIComponent(id)).then(function (d) {
      if (tok !== state.token) return;
      paintDetail(root, d.batch);
    }).catch(function (e) { if (tok === state.token) q(root, '[data-pb="d"]').innerHTML = errBox(e); });
  }

  function paintDetail(root, b, notice) {
    var meta = state.meta;
    var box = q(root, '[data-pb="d"]');
    var c = b.counts || {};
    var canPoll = (meta.canPrepare || meta.canRelease) && (c.sent > 0);
    var canSettle = meta.canIntegrations && b.mode === 'test' && c.sent > 0;
    var h = (notice || '') +
      '<div class="pbank-head"><div><h1 class="pbank-h1">Payout batch #' + b.id + (b.isFollowUp ? ' <span class="pbank-small pbank-muted">(re-queue)</span>' : '') + '</h1>' +
      '<div class="pbank-sub">Run ' + esc(b.runLabel) + ' · ' + esc(b.provider.toUpperCase()) + ' ' + modeBadge(b.mode) + ' · ' + stBadge(b.status) + '</div></div>' +
      '<div class="pbank-btns">' +
      (b.canRelease ? '<button class="btn-primary btn-sm" data-pb="release">Release to bank</button>' : '') +
      (canPoll ? '<button class="pbank-btn" data-pb="poll">Poll status</button>' : '') +
      (canSettle ? '<button class="pbank-btn" data-pb="settle">Simulate settlement</button>' : '') +
      (b.status === 'awaiting_release' && (meta.canPrepare || meta.canRelease) ? '<button class="pbank-btn pbank-danger" data-pb="cancel">Cancel batch</button>' : '') +
      '</div></div>' +
      (b.status === 'awaiting_release' && !b.canRelease && b.releaseBlockedReason ? '<div class="pbank-note">' + esc(b.releaseBlockedReason) + '</div>' : '') +
      (b.mode === 'live' ? '<div class="pbank-note"><b>Live mode:</b> releasing moves real money through ' + esc(b.provider.toUpperCase()) + '.</div>' : '') +
      '<div class="pbank-kpis">' +
      '<div class="pbank-kpi"><span>Total</span><b>' + money(b.totalAmount) + '</b></div>' +
      '<div class="pbank-kpi"><span>Transfers</span><b>' + b.itemCount + '</b></div>' +
      '<div class="pbank-kpi"><span>Paid</span><b style="color:var(--success)">' + (c.success || 0) + '</b></div>' +
      '<div class="pbank-kpi"><span>In flight</span><b>' + ((c.sent || 0) + (c.queued || 0)) + '</b></div>' +
      '<div class="pbank-kpi"><span>Failed</span><b style="color:' + (c.failed ? 'var(--danger)' : 'inherit') + '">' + (c.failed || 0) + '</b></div></div>' +
      '<div class="pbank-card"><div class="pbank-kv"><span>Prepared by (maker)</span><span>' + esc(b.createdBy) + ' · ' + esc(fmtDate(b.createdAt)) + '</span></div>' +
      '<div class="pbank-kv"><span>Released by (checker)</span><span>' + (b.releasedBy ? esc(b.releasedBy) + ' · ' + esc(fmtDate(b.releasedAt)) : '—') + '</span></div></div>' +
      '<div data-pb="msg"></div>' +
      '<div class="pbank-card"><h3>Transfers</h3><div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>Employee</th><th>Account</th><th>IFSC</th><th>Mode</th>' +
      '<th class="pbank-num">Amount</th><th>Status</th><th>UTR / reason</th><th>Ref</th><th></th></tr></thead><tbody>' +
      (b.transactions || []).map(function (t) {
        var detail = t.status === 'success' ? '<span class="pbank-mono">' + esc(t.utr) + '</span>' :
          (t.failureCode || t.failureReason ? '<span class="pbank-issue">' + esc((t.failureCode ? t.failureCode + ': ' : '') + t.failureReason) + '</span>' : '<span class="pbank-muted">—</span>');
        return '<tr><td>' + esc(t.employeeName || t.email) + (t.attempt > 1 ? ' <span class="pbank-small pbank-muted">attempt ' + t.attempt + '</span>' : '') + '</td>' +
          '<td class="pbank-mono">' + esc(t.account) + '</td><td class="pbank-mono">' + esc(t.ifsc) + '</td><td>' + esc(t.mode) + '</td>' +
          '<td class="pbank-num">' + money(t.amount) + '</td><td>' + stBadge(t.status) + '</td><td>' + detail + '</td>' +
          '<td class="pbank-mono pbank-small">' + esc(t.clientRef) + '</td>' +
          '<td>' + (t.status === 'failed' && meta.canPrepare ? '<button class="pbank-btn" data-rq="' + t.id + '" data-name="' + esc(t.employeeName || t.email) + '">Re-queue</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    box.innerHTML = h;
    var msg = q(box, '[data-pb="msg"]');
    function reload(note) {
      api('/api/payroll/banking/batches/' + b.id).then(function (d) { paintDetail(root, d.batch, note); })
        .catch(function (e) { msg.innerHTML = errBox(e); });
    }
    var rel = q(box, '[data-pb="release"]');
    if (rel) rel.onclick = function () {
      otpFlow({
        title: 'Release batch #' + b.id,
        intro: 'You are about to send <b>' + b.itemCount + '</b> transfer(s) totalling <b>' + esc(money(b.totalAmount)) + '</b> via ' + esc(b.provider.toUpperCase()) +
          ' (' + (b.mode === 'live' ? '<b style="color:var(--danger)">LIVE</b>' : 'test mode') + '). Totals are re-checked against the approved run before anything is sent.',
        purpose: 'release', id: b.id, confirmLabel: 'Release',
        submit: function (body) { return api('/api/payroll/banking/batches/' + b.id + '/release', { method: 'POST', body: body }); },
        done: function (res) {
          var s = res.summary || {};
          paintDetail(root, res.batch, okBox('Released: ' + (s.sent || 0) + ' sent, ' + (s.success || 0) + ' paid, ' + (s.failed || 0) + ' failed' + (s.unknown ? ', ' + s.unknown + ' awaiting confirmation' : '') + '.'));
        }
      });
    };
    var poll = q(box, '[data-pb="poll"]');
    if (poll) poll.onclick = function () {
      poll.disabled = true; poll.textContent = 'Polling…';
      api('/api/payroll/banking/batches/' + b.id + '/poll', { method: 'POST', body: {} }).then(function (res) {
        var s = res.summary || {};
        paintDetail(root, res.batch, okBox('Checked ' + s.checked + ': ' + s.success + ' paid, ' + s.failed + ' failed, ' + s.pending + ' still pending' + (s.errors ? ', ' + s.errors + ' errors' : '') + '.'));
      }).catch(function (e) { poll.disabled = false; poll.textContent = 'Poll status'; msg.innerHTML = errBox(e); });
    };
    var cancel = q(box, '[data-pb="cancel"]');
    if (cancel) cancel.onclick = function () {
      if (!window.confirm('Cancel batch #' + b.id + '? Its payments can be prepared again.')) return;
      cancel.disabled = true;
      api('/api/payroll/banking/batches/' + b.id + '/cancel', { method: 'POST', body: {} }).then(function (res) { paintDetail(root, res.batch, okBox('Batch cancelled.')); })
        .catch(function (e) { cancel.disabled = false; msg.innerHTML = errBox(e); });
    };
    var settle = q(box, '[data-pb="settle"]');
    if (settle) settle.onclick = function () { settleModal(root, b); };
    Array.prototype.forEach.call(box.querySelectorAll('[data-rq]'), function (btn) {
      btn.onclick = function () { requeueModal(btn.getAttribute('data-rq'), btn.getAttribute('data-name'), function (res) { SC.go(BASE + '/batches/' + res.batch.id); }); };
    });
    void reload;
  }

  function requeueModal(txnId, name, done) {
    otpFlow({
      title: 'Re-queue failed transfer',
      intro: 'Enter the corrected bank details for <b>' + esc(name) + '</b>. A new transfer (next attempt) is created in a follow-up batch that a checker must release. Payroll is not re-run.',
      fieldsHtml: bankFields(), purpose: 'requeue', id: Number(txnId), confirmLabel: 'Re-queue',
      collect: collectBank,
      submit: function (body) { return api('/api/payroll/banking/transactions/' + txnId + '/requeue', { method: 'POST', body: body }); },
      done: done
    });
  }

  function settleModal(root, b) {
    var codes = Object.keys(state.meta.failureCodes || {});
    var sent = (b.transactions || []).filter(function (t) { return t.status === 'sent'; });
    var m = openModal('<h3>Simulate bank settlement</h3><div class="pbank-sub" style="margin:0 0 12px">Test mode only — marks transfers paid with fake UTRs, or failed with the code you choose. No money moves.</div>' +
      '<div class="pbank-table-wrap"><table class="pbank-table"><tbody>' + sent.map(function (t) {
        return '<tr><td>' + esc(t.employeeName || t.email) + '<div class="pbank-small pbank-muted">' + money(t.amount) + '</div></td><td><select class="input-field" data-st="' + t.id + '">' +
          '<option value="">Success</option>' + codes.map(function (c) { return '<option value="' + esc(c) + '">Fail: ' + esc(c) + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') + '</tbody></table></div><div data-pb="msg"></div>' +
      '<div class="pbank-btns" style="justify-content:flex-end;margin-top:12px"><button class="pbank-btn" data-pb="x">Cancel</button><button class="btn-primary btn-sm" data-pb="go">Settle</button></div>');
    q(m, '[data-pb="x"]').onclick = closeModal;
    q(m, '[data-pb="go"]').onclick = function () {
      var failures = {};
      Array.prototype.forEach.call(m.querySelectorAll('[data-st]'), function (s) { if (s.value) failures[s.getAttribute('data-st')] = s.value; });
      this.disabled = true;
      var btn = this;
      api('/api/payroll/banking/batches/' + b.id + '/simulate-settle', { method: 'POST', body: { failures: failures } }).then(function (res) {
        closeModal();
        paintDetail(root, res.batch, okBox('Settlement simulated.'));
      }).catch(function (e) { btn.disabled = false; q(m, '[data-pb="msg"]').innerHTML = errBox(e); });
    };
  }

  /* ── reconciliation ───────────────────────────────────────────────────── */
  function renderRecon(body) {
    var tok = state.token;
    body.innerHTML = '<div class="pbank-muted">Loading…</div>';
    api('/api/payroll/banking/reconciliation').then(function (d) {
      if (tok !== state.token) return;
      var h = '<div class="pbank-card"><h3>Failed transfers</h3>';
      if (!d.failures.length) h += '<div class="pbank-empty">No failed transfers. </div>';
      else h += '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>Batch</th><th>Employee</th><th>Account</th><th class="pbank-num">Amount</th><th>Reason</th><th>Updated</th><th></th></tr></thead><tbody>' +
        d.failures.map(function (t) {
          return '<tr><td><a class="pbank-back" style="margin:0" data-go="' + t.batchId + '">#' + t.batchId + '</a></td><td>' + esc(t.employeeName || t.email) + '</td>' +
            '<td class="pbank-mono">' + esc(t.account) + '</td><td class="pbank-num">' + money(t.amount) + '</td>' +
            '<td class="pbank-issue">' + esc((t.failureCode ? t.failureCode + ': ' : '') + t.failureReason) + '</td><td class="pbank-small pbank-muted">' + esc(fmtDate(t.updatedAt)) + '</td>' +
            '<td>' + (state.meta.canPrepare ? '<button class="pbank-btn" data-rq="' + t.id + '" data-name="' + esc(t.employeeName || t.email) + '">Re-queue</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      h += '</div><div class="pbank-card"><h3>Bank callbacks</h3>';
      if (!d.webhooks.length) h += '<div class="pbank-empty">No bank callbacks received yet.</div>';
      else h += '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>Received</th><th>Provider</th><th>Event</th><th>Signature</th><th>Updates</th><th>Note</th></tr></thead><tbody>' +
        d.webhooks.map(function (w) {
          var ups = (w.events || []).map(function (e) { return esc(e.client_ref) + ' → ' + esc(e.status) + (e.utr ? ' (' + esc(e.utr) + ')' : '') + (e.failure_code ? ' [' + esc(e.failure_code) + ']' : ''); }).join('<br>');
          return '<tr><td class="pbank-small">' + esc(fmtDate(w.receivedAt)) + '</td><td>' + esc(w.provider.toUpperCase()) + '</td><td class="pbank-mono pbank-small">' + esc(w.eventId) + '</td>' +
            '<td>' + (w.signatureOk ? badge('valid', 'pbank-c-success') : badge('rejected', 'pbank-c-danger')) + '</td><td class="pbank-small">' + (ups || '<span class="pbank-muted">—</span>') + '</td>' +
            '<td class="pbank-small pbank-muted">' + esc(w.error || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      h += '</div>';
      body.innerHTML = h;
      Array.prototype.forEach.call(body.querySelectorAll('[data-go]'), function (a) { a.onclick = function () { SC.go(BASE + '/batches/' + a.getAttribute('data-go')); }; });
      Array.prototype.forEach.call(body.querySelectorAll('[data-rq]'), function (btn) {
        btn.onclick = function () { requeueModal(btn.getAttribute('data-rq'), btn.getAttribute('data-name'), function (res) { SC.go(BASE + '/batches/' + res.batch.id); }); };
      });
    }).catch(function (e) { if (tok === state.token) body.innerHTML = errBox(e); });
  }

  /* ── integrations ─────────────────────────────────────────────────────── */
  function renderIntegrations(body) {
    var tok = state.token;
    body.innerHTML = '<div class="pbank-muted">Loading…</div>';
    api('/api/payroll/banking/integrations').then(function (d) {
      if (tok !== state.token) return;
      body.innerHTML = '<div class="pbank-note"><b>Before going live:</b> the ICICI and HDFC adapters follow the banks\' published API-banking patterns ' +
        '(hybrid RSA + AES encryption, mTLS, API keys / OAuth), but they must be validated end-to-end in each bank\'s UAT sandbox with the bank-issued certificates, ' +
        'IP whitelisting and field mappings before switching to <b>live</b>. In <b>test</b> mode no bank, Twilio or Slack endpoint is ever called. ' +
        'Credentials are encrypted at rest and are never shown again — leave a field blank to keep the saved value.</div><div class="pbank-grid" data-pb="cards"></div>';
      var grid = q(body, '[data-pb="cards"]');
      d.integrations.forEach(function (it) {
        var card = document.createElement('div');
        card.className = 'pbank-card';
        grid.appendChild(card);
        paintIntegration(card, it);
      });
    }).catch(function (e) { if (tok === state.token) body.innerHTML = errBox(e); });
  }

  function paintIntegration(card, it, notice) {
    var pub = it.public || {};
    function pubVal(k) { var v = pub[k]; return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); }
    var hookUrl = it.webhookUrl ? (location.origin + it.webhookUrl) : '';
    card.innerHTML = '<h3>' + esc(it.label) + '</h3>' +
      '<div class="pbank-btns" style="margin-bottom:10px">' + (it.configured ? badge('configured', 'pbank-c-success') : badge('not configured', 'pbank-c-muted')) + ' ' +
      (it.enabled ? badge('enabled', 'pbank-c-accent') : badge('disabled', 'pbank-c-muted')) + ' ' + modeBadge(it.mode) +
      (it.validatedAt ? ' ' + badge('tested ' + fmtDate(it.validatedAt), 'pbank-c-success') : '') + '</div>' +
      (it.fingerprint ? '<div class="pbank-kv"><span>Fingerprint</span><span class="pbank-mono">' + esc(it.fingerprint) + '</span></div>' : '') +
      (it.updatedBy ? '<div class="pbank-kv"><span>Last changed</span><span>' + esc(it.updatedBy) + ' · ' + esc(fmtDate(it.updatedAt)) + '</span></div>' : '') +
      (hookUrl ? '<div class="pbank-kv"><span>' + (it.provider === 'slack' ? 'Interactivity URL' : 'Webhook URL') + '</span><span class="pbank-mono">' + esc(hookUrl) + '</span></div>' : '') +
      (notice || '') +
      '<div class="pbank-row" style="margin-top:12px"><div class="pbank-field" style="max-width:160px"><label>Mode</label><select class="input-field" data-k="mode">' +
      '<option value="test"' + (it.mode !== 'live' ? ' selected' : '') + '>Test</option><option value="live"' + (it.mode === 'live' ? ' selected' : '') + '>Live</option></select></div>' +
      '<div class="pbank-field"><label class="pbank-check" style="text-transform:none;letter-spacing:0;font-size:12.5px"><input type="checkbox" data-k="enabled"' + (it.enabled ? ' checked' : '') + '> Enabled</label></div></div>' +
      '<h4 style="margin:10px 0 6px;font-size:12px;color:var(--text2)">Credentials (write-only)</h4>' +
      it.secretFields.map(function (f) {
        var pem = /_pem$/.test(f.key);
        var ph = f.set ? '•••••• saved — leave blank to keep' : '';
        return '<div class="pbank-field"><label>' + esc(f.label) + (f.set ? '<span class="pbank-set">✓ set</span>' : '') + '</label>' +
          (pem ? '<textarea class="input-field" data-sec="' + f.key + '" spellcheck="false" autocomplete="off" placeholder="' + esc(ph || '-----BEGIN …-----') + '"></textarea>'
            : '<input class="input-field" type="password" data-sec="' + f.key + '" autocomplete="new-password" placeholder="' + esc(ph) + '">') +
          (f.set ? '<label class="pbank-check pbank-small" style="margin-top:4px;text-transform:none;letter-spacing:0"><input type="checkbox" data-clear="' + f.key + '"> remove saved value</label>' : '') + '</div>';
      }).join('') +
      '<h4 style="margin:10px 0 6px;font-size:12px;color:var(--text2)">Settings</h4>' +
      it.publicFields.map(function (f) {
        return '<div class="pbank-field"><label>' + esc(f.label) + '</label><input class="input-field" data-pub="' + f.key + '" value="' + esc(pubVal(f.key)) + '" autocomplete="off"></div>';
      }).join('') +
      '<div data-pb="msg"></div><div class="pbank-btns" style="margin-top:10px"><button class="btn-primary btn-sm" data-pb="save">Save</button>' +
      '<button class="pbank-btn" data-pb="test"' + (it.configured ? '' : ' disabled') + '>Test connection</button>' +
      '<button class="pbank-btn pbank-danger" data-pb="remove"' + (it.configured || it.updatedBy ? '' : ' disabled') + '>Remove</button></div>';
    var msg = q(card, '[data-pb="msg"]');
    q(card, '[data-pb="save"]').onclick = function () {
      var btn = this;
      var creds = {}, pubs = {}, clear = [];
      Array.prototype.forEach.call(card.querySelectorAll('[data-sec]'), function (el) { if (el.value.trim()) creds[el.getAttribute('data-sec')] = el.value.trim(); });
      Array.prototype.forEach.call(card.querySelectorAll('[data-pub]'), function (el) { pubs[el.getAttribute('data-pub')] = el.value.trim(); });
      Array.prototype.forEach.call(card.querySelectorAll('[data-clear]'), function (el) { if (el.checked) clear.push(el.getAttribute('data-clear')); });
      var mode = q(card, '[data-k="mode"]').value;
      if (mode === 'live' && it.mode !== 'live' && !window.confirm('Switch ' + it.provider.toUpperCase() + ' to LIVE? Real ' + (it.kind === 'bank' ? 'money transfers' : 'messages') + ' will be sent.')) return;
      btn.disabled = true;
      api('/api/payroll/banking/integrations/' + it.provider, {
        method: 'PUT', body: { credentials: creds, public: pubs, clear: clear, mode: mode, enabled: q(card, '[data-k="enabled"]').checked }
      }).then(function (r) { refreshMeta(); paintIntegration(card, r.integration, okBox('Saved.')); })
        .catch(function (e) { btn.disabled = false; msg.innerHTML = errBox(e); });
    };
    q(card, '[data-pb="test"]').onclick = function () {
      var btn = this;
      btn.disabled = true; btn.textContent = 'Testing…';
      api('/api/payroll/banking/integrations/' + it.provider + '/test', { method: 'POST', body: {} }).then(function (r) {
        paintIntegration(card, r.integration, r.ok ? okBox(r.message) : errBox({ message: r.message }));
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'Test connection'; msg.innerHTML = errBox(e); });
    };
    q(card, '[data-pb="remove"]').onclick = function () {
      if (!window.confirm('Remove the ' + it.provider.toUpperCase() + ' credentials? This cannot be undone.')) return;
      var btn = this;
      btn.disabled = true;
      api('/api/payroll/banking/integrations/' + it.provider, { method: 'DELETE' }).then(function (r) { refreshMeta(); paintIntegration(card, r.integration, okBox('Removed.')); })
        .catch(function (e) { btn.disabled = false; msg.innerHTML = errBox(e); });
    };
  }

  /* ── alerts log ───────────────────────────────────────────────────────── */
  function renderAlerts(body) {
    var tok = state.token;
    body.innerHTML = '<div class="pbank-card"><div class="pbank-row">' +
      '<div class="pbank-field" style="max-width:180px"><label>Channel</label><select class="input-field" data-f="channel"><option value="">All</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="slack">Slack</option></select></div>' +
      '<div class="pbank-field" style="max-width:180px"><label>Status</label><select class="input-field" data-f="status"><option value="">All</option><option>sent</option><option>simulated</option><option>failed</option><option>skipped</option></select></div>' +
      '<div class="pbank-field"><button class="pbank-btn" data-pb="sweep">Announce pending pay runs on Slack</button></div></div><div data-pb="smsg"></div><div data-pb="list"></div></div>';
    var list = q(body, '[data-pb="list"]');
    function load() {
      list.innerHTML = '<div class="pbank-muted pbank-small">Loading…</div>';
      var qs = '?channel=' + encodeURIComponent(q(body, '[data-f="channel"]').value) + '&status=' + encodeURIComponent(q(body, '[data-f="status"]').value);
      api('/api/payroll/alerts/deliveries' + qs).then(function (d) {
        if (tok !== state.token) return;
        if (!d.deliveries.length) { list.innerHTML = '<div class="pbank-empty">No alerts sent yet.</div>'; return; }
        list.innerHTML = '<div class="pbank-table-wrap"><table class="pbank-table"><thead><tr><th>When</th><th>Channel</th><th>Recipient</th><th>Employee / approver</th><th>Purpose</th><th>Status</th><th>Note</th></tr></thead><tbody>' +
          d.deliveries.map(function (x) {
            return '<tr><td class="pbank-small">' + esc(fmtDate(x.createdAt)) + '</td><td>' + esc(x.channel) + '</td><td class="pbank-mono">' + esc(x.recipient || '—') + '</td>' +
              '<td class="pbank-small">' + esc(x.email) + '</td><td class="pbank-small">' + esc(String(x.purpose).replace(/_/g, ' ')) + ' <span class="pbank-muted">' + esc(x.ref) + '</span></td>' +
              '<td>' + stBadge(x.status) + '</td><td class="pbank-small pbank-issue">' + esc(x.error || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }).catch(function (e) { if (tok === state.token) list.innerHTML = errBox(e); });
    }
    q(body, '[data-f="channel"]').onchange = load;
    q(body, '[data-f="status"]').onchange = load;
    q(body, '[data-pb="sweep"]').onclick = function () {
      var b = this;
      b.disabled = true;
      api('/api/payroll/alerts/payrun/sweep', { method: 'POST', body: {} }).then(function (r) {
        b.disabled = false;
        q(body, '[data-pb="smsg"]').innerHTML = okBox(r.announced ? r.announced + ' pay run(s) announced to approvers.' : 'No new pay run is waiting for approval.');
        load();
      }).catch(function (e) { b.disabled = false; q(body, '[data-pb="smsg"]').innerHTML = errBox(e); });
    };
    load();
  }

  /* ── routing ──────────────────────────────────────────────────────────── */
  function refreshMeta() {
    return api('/api/payroll/banking/meta').then(function (m) { state.meta = m; return m; });
  }

  function route(root, sub) {
    var m = /^\/batches\/(\d+)$/.exec(sub || '');
    if (m) renderDetail(root, m[1]);
    else renderTabs(root);
  }

  function render(root, sub) {
    state.root = root;
    state.token++;
    closeModal();
    injectStyle();
    var tok = state.token;
    if (state.meta) { route(root, sub); return; }
    root.innerHTML = '<div class="pbank-page"><div class="pbank-muted">Loading…</div></div>';
    refreshMeta().then(function (meta) {
      if (tok !== state.token) return;
      try { var t = localStorage.getItem(TAB_KEY); if (t) state.tab = t; } catch (_) {}
      route(root, sub);
      // Polling alternative to a submit hook: announce pay runs waiting for approval on Slack.
      if (meta.canPrepare || meta.canIntegrations) api('/api/payroll/alerts/payrun/sweep', { method: 'POST', body: {} }).catch(function () {});
    }).catch(function (e) {
      if (tok !== state.token) return;
      root.innerHTML = '<div class="pbank-page"><h1 class="pbank-h1">Payouts &amp; Banking</h1>' + errBox(e.status === 403 ? { message: 'You do not have access to salary payouts.' } : e) + '</div>';
    });
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE,
      title: 'Payouts & Banking',
      mount: render,
      update: render,
      unmount: function () {
        closeModal();
        state.token++;
        state.root = null;
        state.meta = null;
      }
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
