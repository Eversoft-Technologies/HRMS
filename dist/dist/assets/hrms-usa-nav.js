/**
 * hrms-usa-nav.js — USA terminology in the sidebar for the Recruiter (USA) role.
 *
 * Does nothing for any other role. The role name is the one hrms-perms.js
 * stores from /api/me/permissions, and it is trusted only once permissions have
 * loaded in THIS page load: the stored value outlives sign-out, so before that
 * it can still be the previous person's role. Names are put back for any other
 * role, so switching accounts in one browser never leaves USA wording behind.
 * Only text is replaced; links, order, badges and layout are untouched.
 */
(function () {
  'use strict';

  var ROLE = 'Recruiter (USA)';
  var NAMES = {
    'Recruit': 'Recruitment',
    'Bench Sales': 'Staffing / Client Assignments',
    'Bench Work Submissions': 'Timesheets / Work Submissions',
    'Resume Scoring': 'Resume Screening',
    'F2F Interview': 'Interviews',
    'ATS': 'Applicant Tracking System',
    'Attendance': 'Time & Attendance',
    'Check In / Out': 'Clock In / Clock Out',
    'Task Tracker': 'Task Management',
    'Employee Chat': 'Employee Communication',
    'Work Submissions': 'Timesheets / Work Submissions',
    'Leave Management': 'PTO & Leave Management'
  };
  var ORIG_ATTR = 'data-hrms-orig';

  function isUsa() {
    try {
      var known = typeof window.__hrmsPerms === 'function' && window.__hrmsPerms();
      return !!known && localStorage.getItem('hrms_role_name') === ROLE;
    } catch (_) { return false; }
  }

  function apply() {
    var usa = isUsa();
    var links = document.querySelectorAll('aside a[href^="/"], .sidebar a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var orig = link.getAttribute(ORIG_ATTR);
      var nodes = link.childNodes;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.nodeType !== 3) continue;
        var t = (n.nodeValue || '').trim();
        if (!t) continue;
        if (usa) {
          if (Object.prototype.hasOwnProperty.call(NAMES, t) && NAMES[t] !== t) {
            link.setAttribute(ORIG_ATTR, t);
            n.nodeValue = n.nodeValue.replace(t, NAMES[t]);
          }
        } else if (orig && NAMES[orig] === t) {
          n.nodeValue = n.nodeValue.replace(t, orig);
          link.removeAttribute(ORIG_ATTR);
        }
      }
    }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; apply(); }, 60);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hrmsPermsLoaded', schedule);
  schedule();
})();
