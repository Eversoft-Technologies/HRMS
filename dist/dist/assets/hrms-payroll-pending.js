/**
 * hrms-payroll-pending.js — safety net for the payroll extension pages.
 *
 * Loaded after hrms-payroll-tax/bank/us/ess.js. Any of their routes that did
 * not register a page (file missing, failed to load, or not deployed yet)
 * gets a clear "not available" card instead of a blank screen or React's
 * Payroll Run fallback. Real pages always win: this only fills gaps.
 */
(function () {
  'use strict';
  var ROUTES = [
    ['/payroll/compliance', 'Tax & Statutory'],
    ['/payroll/banking', 'Payouts & Banking'],
    ['/payroll/us', 'US Payroll'],
    ['/payroll/separations', 'Separations & F&F'],
    ['/my-pay', 'My Pay'],
    ['/my-pay/tax', 'Tax Declaration'],
    ['/my-pay/w4', 'W-4']
  ];
  function fill() {
    var SC = window.HRMSSidecar;
    if (!SC || !SC.has) return;
    ROUTES.forEach(function (r) {
      if (SC.has(r[0])) return;
      SC.register({
        base: r[0],
        title: r[1],
        mount: function (root) {
          root.innerHTML =
            '<div class="card" style="max-width:560px;margin:40px auto;padding:28px;text-align:center;' +
            'background:var(--bg2);border:1px solid var(--border);border-radius:12px;color:var(--text)">' +
            '<div style="font-size:18px;font-weight:600;margin-bottom:8px">' + SC.esc(r[1]) + '</div>' +
            '<div style="color:var(--text2);font-size:14px;line-height:1.5">This page is not available yet. ' +
            'It is part of the payroll update that is still being installed. Please try again after the next update.</div>' +
            '<a href="/payroll/run" class="btn-primary btn-sm" style="display:inline-block;margin-top:18px;text-decoration:none">Go to Payroll Run</a>' +
            '</div>';
        }
      });
    });
  }
  // Deferred scripts run in order, so the real overlays have registered by now;
  // wait one more tick for any that register on DOMContentLoaded.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(fill, 0); });
  else setTimeout(fill, 0);
})();
