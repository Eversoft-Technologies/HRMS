/**
 * hrms-fetch-dedupe.js — stop the app asking the server the same thing twice.
 *
 * Every page change used to fire 10–18 requests, and a handful of read-only
 * ones were sent two or three times in the same moment (attendance today /
 * events / team, chat unread, the shared config lists), because the header,
 * the check-in card, the presence dots and the page itself each ask for them
 * on their own. The browser allows six connections per host, so those copies
 * queue behind each other and every call, including the one a page is waiting
 * for, looks slow.
 *
 * This wraps window.fetch for a short allow-list of read-only GETs only:
 *   - callers asking for the same URL at the same time share ONE request;
 *   - a good answer is reused for a few seconds, then asked for again;
 *   - ANY write (POST/PUT/PATCH/DELETE) to /api/ clears everything, before and
 *     after it, so a check-in, an approval or a save is never answered from
 *     an older copy;
 *   - the key includes the signed-in email, so switching account never reuses
 *     someone else's answer.
 * Anything not on the list, any request with a body, an AbortSignal or
 * cache:"no-store"/"reload" goes straight through untouched.
 */
(function () {
  'use strict';
  if (window.__hrmsFetchDedupe || !window.fetch) return;
  window.__hrmsFetchDedupe = true;

  var nativeFetch = window.fetch.bind(window);

  // path (no query) -> how long a good answer may be reused, in ms
  var TTL = {
    '/api/attendance/today': 4000,
    '/api/attendance/events': 4000,
    '/api/attendance/team': 4000,
    '/api/chat/unread': 3000,
    '/api/config': 15000,
    '/api/job-form/config': 15000,
    '/api/master-data': 15000,
    '/api/currencies': 15000,
    '/api/avatars': 10000
  };

  var store = {}; // key -> { at, promise }

  function urlOf(input) {
    try { return typeof input === 'string' ? input : (input && input.url) || ''; } catch (_) { return ''; }
  }
  function pathOf(url) {
    var u = url.replace(location.origin, '');
    var q = u.indexOf('?');
    return q === -1 ? u : u.slice(0, q);
  }
  function who() {
    try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email || '').toLowerCase(); }
    catch (_) { return ''; }
  }
  function clearAll() { store = {}; }

  window.fetch = function (input, init) {
    try {
      var url = urlOf(input);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      if (url.indexOf('/api/') !== -1 && method !== 'GET' && method !== 'HEAD') {
        clearAll();
        var w = nativeFetch(input, init);
        var done = function () { clearAll(); };
        w.then(done, done);
        return w;
      }

      var ttl = method === 'GET' ? TTL[pathOf(url)] : 0;
      var skip = !ttl ||
        (init && (init.body || init.signal || init.cache === 'no-store' || init.cache === 'reload')) ||
        (typeof input === 'object' && input && (input.cache === 'no-store' || input.cache === 'reload'));
      if (skip) return nativeFetch(input, init);

      var key = who() + '|' + url.replace(location.origin, '');
      var hit = store[key];
      if (hit && Date.now() - hit.at < ttl) {
        return hit.promise.then(function (r) { return r.clone(); });
      }

      var p = nativeFetch(input, init);
      var entry = { at: Date.now(), promise: p };
      store[key] = entry;
      var drop = function () { if (store[key] === entry) delete store[key]; };
      p.then(function (r) { if (!r.ok) drop(); }, drop);
      return p.then(function (r) { return r.clone(); });
    } catch (_) {
      return nativeFetch(input, init);
    }
  };

  // A sign-in/out, an account switch or an explicit sync starts from scratch.
  window.addEventListener('storage', function (e) {
    if (e.key === 'hrms_session' || e.key === 'hrms_token') clearAll();
  });
  ['hrmsAttendanceSynced', 'hrmsContextUpdate'].forEach(function (n) {
    window.addEventListener(n, clearAll);
  });
})();
