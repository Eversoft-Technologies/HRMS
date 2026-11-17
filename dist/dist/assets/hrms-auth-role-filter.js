(function () {
  'use strict';

  function removePublicSuperAdminRole() {
    if (window.location.pathname.replace(/\/+$/, '') !== '/login') return;
    var select = document.getElementById('auth-role');
    if (!select) return;
    Array.prototype.slice.call(select.options).forEach(function (option) {
      if ((option.value || option.textContent || '').trim().toLowerCase() === 'super admin') {
        option.remove();
      }
    });
  }

  removePublicSuperAdminRole();
  if (document.documentElement) {
    new MutationObserver(removePublicSuperAdminRole).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();