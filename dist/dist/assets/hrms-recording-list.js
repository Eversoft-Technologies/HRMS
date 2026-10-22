/*
 * Request compact interview-recording metadata for the recordings list.
 * Full transcript and evaluation data are fetched by the existing detail
 * endpoint only when a recruiter opens a recording.
 */
(function () {
  'use strict';

  var authenticatedFetch = window.fetch;
  if (!authenticatedFetch) return;

  window.fetch = function (input, init) {
    if (typeof input === 'string' &&
        String(init && init.method || 'GET').toUpperCase() === 'GET') {
      var url = new URL(input, window.location.href);
      if (url.origin === window.location.origin &&
          url.pathname === '/api/interview-recordings' &&
          !url.searchParams.has('summary')) {
        url.searchParams.set('summary', '1');
        input = url.toString();
      }
    }
    return authenticatedFetch.call(this, input, init);
  };
})();
