/**
 * interview-access.js
 * Handles candidate / recruiter interview link token verification.
 *
 * When a user visits /interview-access?token=<TOKEN>, this script:
 *  1. Calls POST /api/interviews/verify-token
 *  2. If valid  → redirects to the platform link or shows the session UI
 *  3. If expired → shows a friendly "link expired" message with contact info
 *  4. If invalid → shows an error
 *
 * Also patches any premature "Interview Link Expired" messages in the existing
 * React bundle by intercepting the token check and using server-side validation.
 */
(function () {
  'use strict';

  var API_BASE = '/api';

  // -------------------------------------------------------------------------
  // Token verification
  // -------------------------------------------------------------------------
  function verifyToken(token) {
    return fetch(API_BASE + '/interviews/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
    }).then(function (r) { return r.json(); });
  }

  /*
   * Leaving the portal.
   *
   * This page is the candidate's entire view of the product — they are not HRMS
   * users. The old "← Back to Home" link pointed at "/", which dropped them
   * into the internal HRMS app (and its login screen). Close the tab instead;
   * window.close() only works when the tab was script-opened, so when the
   * browser refuses we say so rather than leaving a button that does nothing.
   */
  function wireExit(btn) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      window.close();
      // Still here → the browser blocked it (tab opened from an email link).
      setTimeout(function () {
        btn.outerHTML = '<p style="font-size:14px;color:#64748b;margin:0;">' +
          'You may now close this window.</p>';
      }, 120);
    });
  }

  // -------------------------------------------------------------------------
  // AI interview hand-off
  //
  // Interviews are invited two different ways: the recruiter console mails a
  // direct /recruit/interview?...&candidateEmail=... URL, while the server mails
  // the single-use /interview-access?token=... link. Only the first knew how to
  // start an AI interview, so a candidate arriving on a token link whose row has
  // no external meeting URL used to hit "Your recruiter will share the meeting
  // link shortly" — a dead end, since an AI interview never gets one.
  //
  // We rebuild the same URL the console does, including the &qid= question set,
  // so both invite routes land the candidate in the identical session.
  // -------------------------------------------------------------------------
  function isAiInterview(data) {
    var platform = String(data.platform || '');
    if (/\bai\b/i.test(platform)) return true;
    // Fall back to the stored question list: a row carrying interview questions
    // but no meeting URL can only be an AI session.
    return !data.link && Array.isArray(data.interviewQuestions) && data.interviewQuestions.length > 0;
  }

  function aiInterviewUrl(data, qid) {
    var qs = [
      'tab=ai-interviewer',
      'candidateEmail=' + encodeURIComponent(data.email || ''),
      'name=' + encodeURIComponent(data.name || ''),
      'role=' + encodeURIComponent(data.role || ''),
    ];
    if (qid) qs.push('qid=' + encodeURIComponent(qid));
    return window.location.origin + '/recruit/interview?' + qs.join('&');
  }

  /* Persist the recruiter's chosen questions so the interviewer can load them
     by id, exactly as the console's invite mail does. Resolves to null when
     there are none (or the POST fails) — the session then self-generates. */
  function questionSetId(data) {
    var questions = Array.isArray(data.interviewQuestions) ? data.interviewQuestions : [];
    var text = questions
      .map(function (q) { return (q && typeof q === 'object') ? (q.q || q.question || '') : q; })
      .filter(function (q) { return typeof q === 'string' && q.trim(); });
    if (!text.length) return Promise.resolve(null);
    return fetch(API_BASE + '/question-sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: text }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return (d && d.id) || null; })
      .catch(function () { return null; });
  }

  // -------------------------------------------------------------------------
  // Interview access page renderer
  // -------------------------------------------------------------------------
  function renderAccessPage(token) {
    var root = document.getElementById('root');
    if (!root) return;

    // Show loading state immediately
    root.innerHTML = [
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;',
      'background:var(--bg,#f1f5f9);font-family:\'Segoe UI\',Arial,sans-serif;padding:24px;">',
      '<div style="background:#fff;border-radius:20px;padding:40px;max-width:520px;width:100%;',
      'box-shadow:0 8px 40px rgba(0,0,0,0.10);text-align:center;">',
      '<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#4f8ef7,#a855f7);',
      'display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">',
      '<svg width="26" height="26" fill="none" stroke="#fff" stroke-width="2.2" viewBox="0 0 24 24">',
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3" stroke-linecap="round" stroke-linejoin="round"/>',
      '</svg></div>',
      '<h2 id="access-title" style="font-size:22px;font-weight:800;color:#1e293b;margin:0 0 10px;">',
      'Verifying your interview link…</h2>',
      '<p id="access-msg" style="font-size:15px;color:#64748b;margin:0 0 24px;line-height:1.6;">',
      'Please wait while we validate your access.</p>',
      '<div id="access-actions"></div>',
      '</div></div>',
    ].join('');

    verifyToken(token)
      .then(function (data) {
        var titleEl = document.getElementById('access-title');
        var msgEl = document.getElementById('access-msg');
        var actionsEl = document.getElementById('access-actions');
        var iconEl = root.querySelector('div[style*="border-radius:50%"]');

        if (data.valid) {
          // Valid token — redirect to interview platform or show success
          titleEl.textContent = 'Access Granted!';
          msgEl.innerHTML = [
            'Welcome, <strong>', data.name || 'Candidate', '</strong>.<br>',
            'Your interview for <strong>', data.role || 'the position', '</strong> is scheduled on ',
            '<strong>', data.interviewDate || 'the scheduled date', ' at ', data.time || '', '</strong>.',
          ].join('');

          if (iconEl) {
            iconEl.style.background = '#22c55e';
            iconEl.innerHTML = '<svg width="26" height="26" fill="none" stroke="#fff" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          }

          if (actionsEl && data.link) {
            actionsEl.innerHTML = [
              '<a href="', data.link, '" target="_blank" rel="noopener noreferrer" ',
              'style="display:inline-block;background:linear-gradient(135deg,#4f8ef7,#a855f7);',
              'color:#fff;font-size:15px;font-weight:700;text-decoration:none;',
              'padding:14px 36px;border-radius:12px;margin-top:8px;">',
              'Join Interview →</a>',
            ].join('');

            // Auto-redirect after 3 seconds
            var countdown = 3;
            var note = document.createElement('p');
            note.style.cssText = 'font-size:13px;color:#94a3b8;margin:14px 0 0;';
            note.textContent = 'Redirecting in ' + countdown + 's…';
            actionsEl.appendChild(note);

            var timer = setInterval(function () {
              countdown--;
              if (countdown <= 0) {
                clearInterval(timer);
                window.location.href = data.link;
              } else {
                note.textContent = 'Redirecting in ' + countdown + 's…';
              }
            }, 1000);
          } else if (actionsEl && isAiInterview(data)) {
            // AI interview: no external URL exists by design — start it here.
            actionsEl.innerHTML =
              '<p style="font-size:13px;color:#94a3b8;margin:0 0 14px;">Preparing your interview…</p>';
            questionSetId(data).then(function (qid) {
              actionsEl.innerHTML = [
                '<a id="start-interview" href="', aiInterviewUrl(data, qid), '" ',
                'style="display:inline-block;background:linear-gradient(135deg,#4f8ef7,#a855f7);',
                'color:#fff;font-size:15px;font-weight:700;text-decoration:none;',
                'padding:14px 36px;border-radius:12px;margin-top:8px;">',
                'Start Interview →</a>',
                '<p style="font-size:13px;color:#94a3b8;margin:14px 0 0;">',
                'Please allow camera and microphone access when prompted.</p>',
              ].join('');
            });
          } else if (actionsEl) {
            actionsEl.innerHTML = '<p style="font-size:13px;color:#64748b;margin:8px 0 0;">Your recruiter will share the meeting link shortly.</p>';
          }

        } else {
          // Already taken, expired, or invalid
          var reason = (data.reason || '').toLowerCase();
          var isExpired = reason.includes('expir');
          var isTaken = reason.includes('already completed');

          if (isTaken) {
            titleEl.textContent = 'Interview Already Completed';
            msgEl.innerHTML =
              'You have already completed this interview' +
              (data.completedAt ? ' on <strong>' + data.completedAt + '</strong>' : '') +
              '.<br><br>An interview can only be taken once. Your recruiter will be ' +
              'in touch with the outcome.';
          } else {
            titleEl.textContent = isExpired ? 'Interview Link Expired' : 'Invalid Link';
            msgEl.innerHTML = isExpired
              ? 'This interview link has expired. Interview links remain active until ' +
                '<strong>24 hours after the scheduled start time</strong>.<br><br>' +
                'Please contact your recruiter to receive a fresh invitation link.'
              : 'This interview link is not valid or has already been used. ' +
                'Please check your email for the correct link.';
          }

          if (iconEl) {
            iconEl.style.background = isTaken ? '#f59e0b' : '#ef4444';
            iconEl.innerHTML = isTaken
              ? '<svg width="26" height="26" fill="none" stroke="#fff" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              : '<svg width="26" height="26" fill="none" stroke="#fff" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          }

          if (actionsEl) {
            actionsEl.innerHTML = [
              '<p style="font-size:13px;color:#94a3b8;margin:8px 0 16px;">',
              'If you believe this is an error, please contact HR or your recruiter.',
              '</p>',
              '<button id="ia-exit" type="button" style="display:inline-block;',
              'border:1.5px solid #e2e8f0;background:#fff;cursor:pointer;',
              'color:#1e293b;font-size:14px;font-weight:600;font-family:inherit;',
              'padding:11px 28px;border-radius:10px;">Close</button>',
            ].join('');
            wireExit(document.getElementById('ia-exit'));
          }
        }
      })
      .catch(function (err) {
        console.error('[Interview Access]', err);
        var titleEl = document.getElementById('access-title');
        var msgEl = document.getElementById('access-msg');
        if (titleEl) titleEl.textContent = 'Connection Error';
        if (msgEl) msgEl.textContent = 'Could not verify your interview link. Please check your connection and try again.';
      });
  }

  // -------------------------------------------------------------------------
  // Patch: intercept any client-side "link expired" checks in the React bundle
  // that might fire prematurely (before the interview time).
  //
  // We override Date comparison helpers that the bundle may use for expiry
  // by ensuring token validation always defers to the server.
  // -------------------------------------------------------------------------
  function patchPrematureExpiry() {
    // If the page has an interview token in the URL, take over rendering
    // before React can show a premature "expired" screen.
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token') || params.get('interviewToken') || params.get('t');

    if (token) {
      // Run on the /interview-access route OR any route that carries a token
      var path = window.location.pathname.toLowerCase();
      var isInterviewRoute =
        path.includes('interview') ||
        path === '/' ||
        params.has('token') ||
        params.has('interviewToken');

      if (isInterviewRoute) {
        // Wait for DOM then take over
        function takeover() {
          var root = document.getElementById('root');
          if (!root) return;
          renderAccessPage(token);
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', takeover);
        } else {
          // Let React mount first (100ms), then replace if we're on an interview route
          setTimeout(function () {
            var errEl = document.querySelector('[class*="expired"], [class*="Expired"], [data-expired]');
            if (errEl || path.includes('interview-access')) {
              takeover();
            }
          }, 300);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  patchPrematureExpiry();

  // Handle /interview-access route specifically
  if (window.location.pathname === '/interview-access') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        var params = new URLSearchParams(window.location.search);
        var token = params.get('token');
        if (token) renderAccessPage(token);
      });
    } else {
      var params = new URLSearchParams(window.location.search);
      var token = params.get('token');
      if (token) {
        setTimeout(function () { renderAccessPage(token); }, 200);
      }
    }
  }
})();
