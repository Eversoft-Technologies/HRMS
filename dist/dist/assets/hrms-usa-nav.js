/**
 * hrms-usa-nav.js — USA terminology across the app for the Recruiter (USA) role.
 *
 * Does nothing for any other role. The role name is the one hrms-perms.js
 * stores from /api/me/permissions, and it is trusted only once permissions have
 * loaded in THIS page load: the stored value outlives sign-out, so before that
 * it can still be the previous person's role. Every changed text is put back
 * for any other role, so switching accounts in one browser never leaves USA
 * wording behind.
 *
 * Scope: page titles, section and card titles, KPI labels, table headers,
 * filters and the Check In / Check Out buttons. A text is changed only when the
 * WHOLE text equals a known phrase, so names, emails, job titles, chat messages
 * and anything a person typed are never touched. Table body cells, inputs,
 * text areas and Chat are skipped outright. Links, order, badges and layout are
 * untouched; only words are replaced.
 *
 * Buttons are NOT renamed (other scripts find them by their label) except
 * Check In / Check Out, which hrms-perms.js and hrms-attendance-actions.js
 * recognise under the USA wording too.
 */
(function () {
  'use strict';

  var ROLE = 'Recruiter (USA)';

  // lower-case phrase -> USA phrase
  var DICT = {
    // sidebar + page titles
    'recruit': 'Recruitment',
    'job board': 'Job Postings',
    'bench sales': 'Staffing / Client Assignments',
    'bench work submissions': 'Timesheets / Work Submissions',
    'resume scoring': 'Resume Screening',
    'f2f interview': 'Interviews',
    'ats': 'Applicant Tracking System',
    'attendance': 'Time & Attendance',
    'check in / out': 'Clock In / Clock Out',
    'task tracker': 'Task Management',
    'employee chat': 'Employee Communication',
    'work submissions': 'Timesheets / Work Submissions',
    'leave management': 'PTO & Leave Management',
    // Recruit
    'open roles': 'Open Requisitions',
    'avg time to hire': 'Avg Time to Fill',
    'offer accepted': 'Offers Accepted',
    // Job Board
    'job code': 'Req ID',
    'salary': 'Compensation',
    'openings': 'Open Positions',
    'designation': 'Job Title',
    // Resume Scoring
    'resumes scored': 'Resumes Screened',
    // Attendance + Check In / Out
    'present days': 'Days Worked',
    'late arrivals': 'Late Clock-Ins',
    'my recent attendance': 'My Recent Time & Attendance',
    'attendance history': 'Time & Attendance History',
    'check in': 'Clock In',
    'check out': 'Clock Out',
    'check in / check out': 'Clock In / Clock Out',
    'check in/out': 'Clock In / Clock Out',
    'working': 'Hours Worked',
    'ot': 'Overtime',
    'not checked in': 'Not Clocked In',
    'checked in': 'Clocked In',
    'checked out': 'Clocked Out',
    'check in / out events': 'Clock In / Out Events',
    'work from home': 'Remote Work',
    'request wfh': 'Request Remote Work',
    'switch to wfh': 'Switch to Remote',
    'my wfh requests': 'My Remote Work Requests',
    'wfh requests': 'Remote Work Requests',
    'remote / office': 'Remote / On-site',
    // Leave
    'leave requests': 'PTO Requests',
    'my leave balance': 'My PTO Balance',
    'my upcoming leave': 'My Upcoming PTO',
    // People / HR wording
    'join date': 'Start Date',
    'joining date': 'Start Date',
    'emp id': 'Employee ID',
    'submission queue': 'Timesheet Queue'
  };

  // Only these buttons may be renamed: other scripts recognise them by label.
  var BUTTON_OK = { 'check in': 1, 'check out': 1 };

  var seen = [];          // [{ node, orig }] every text node we changed
  var origOf = typeof WeakMap === 'function' ? new WeakMap() : null;

  function isUsa() {
    try {
      var known = typeof window.__hrmsPerms === 'function' && window.__hrmsPerms();
      return !!known && localStorage.getItem('hrms_role_name') === ROLE;
    } catch (_) { return false; }
  }

  /* "▼ Job Code ▾" -> { pre: "▼ ", core: "Job Code", post: " ▾" } */
  var DECOR = /^([\s▼▲▾▴↑↓✦+⚙⭳▶•·\-–—]*)(.*?)([\s▼▲▾▴↑↓⤢:]*)$/;

  function caseLike(src, text) {
    if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) return text.toUpperCase();
    return text;
  }

  function translate(str) {
    var m = DECOR.exec(str);
    if (!m || !m[2]) return null;
    var core = m[2].replace(/\s+/g, ' ').trim();
    var key = core.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(DICT, key)) return null;
    var out = DICT[key];
    if (out === core) return null;
    return m[1] + caseLike(core, out) + m[3];
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  // Table body cells hold people's data, so only fixed system labels may change there.
  var CELL_OK = { 'check in': 1, 'check out': 1 };

  function skip(node) {
    for (var p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      if (SKIP_TAGS[p.tagName]) return true;
      if (p.tagName === 'TD' && !CELL_OK[(node.nodeValue || '').trim().toLowerCase()]) return true;
      if (p.isContentEditable) return true;
      if (p.id === 'hrms-chat-page' || p.id === 'root-modal-skip') return true;
      var tag = p.tagName;
      if (tag === 'BUTTON' || (p.getAttribute && p.getAttribute('role') === 'button')) {
        // renaming a button breaks scripts that find it by label
        var lbl = (node.nodeValue || '').replace(/[^a-zA-Z ]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!BUTTON_OK[lbl]) return true;
      }
    }
    return false;
  }

  function convert(node) {
    var v = node.nodeValue;
    if (!v || v.length > 60) return;
    var t = translate(v);
    if (t == null || skip(node)) return;
    if (origOf && !origOf.has(node)) {
      origOf.set(node, v); seen.push(node);
      if (seen.length > 3000) seen = seen.filter(function (x) { return x.isConnected; });
    }
    node.nodeValue = t;
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { convert(root); return; }
    if (root.nodeType !== 1 || SKIP_TAGS[root.tagName]) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) convert(n);
  }

  function restore() {
    for (var i = 0; i < seen.length; i++) {
      var n = seen[i];
      var o = origOf.get(n);
      if (o != null && n.isConnected) {
        // only put back what we wrote; if React replaced it, leave React's text
        if (translate(o) === n.nodeValue) n.nodeValue = o;
      }
      origOf.delete(n);
    }
    seen = [];
  }

  var usa = false;
  var pending = [];
  var queued = false;
  var full = false;

  function flush() {
    queued = false;
    var now = isUsa();
    if (now !== usa) { usa = now; full = true; if (!usa) restore(); }
    if (!usa) { pending = []; full = false; return; }
    if (full) { full = false; pending = []; walk(document.body); return; }
    var list = pending; pending = [];
    for (var i = 0; i < list.length; i++) walk(list[i]);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(flush, 60);
  }

  new MutationObserver(function (muts) {
    if (!usa && !isUsa()) { schedule(); return; }
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'characterData') { pending.push(m.target); continue; }
      for (var j = 0; j < m.addedNodes.length; j++) pending.push(m.addedNodes[j]);
    }
    // Rename right away (a mutation observer runs before the next paint), so a
    // re-rendered heading never shows its old wording for a frame.
    if (usa) flush(); else schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener('hrmsPermsLoaded', function () { full = true; schedule(); });
  full = true;
  schedule();
})();
