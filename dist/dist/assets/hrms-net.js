/*
 * HRMS shared network-health guard.
 *
 * Every background poller in the app (permissions every 10s, notifications
 * every 30s, live sessions every 8s, interviews every 60s) used to fire on a
 * fixed setInterval regardless of whether the browser had a network at all.
 * When a user's connection dropped — WiFi switch, VPN flap, laptop waking from
 * sleep — each poller kept firing and every request failed at the network
 * layer, filling the console with hundreds of ERR_NAME_NOT_RESOLVED /
 * ERR_CONNECTION_TIMED_OUT / ERR_NETWORK_CHANGED lines and draining battery.
 *
 * A failed request is logged by the browser itself and cannot be silenced from
 * JavaScript, so the only real fix is to not send the request. That is what
 * this module centralises:
 *
 *   • no requests at all while navigator.onLine is false
 *   • no background polling while the tab is hidden — pollers refresh on
 *     visibilitychange instead, so the UI is current the moment it is looked at
 *   • per-poller exponential backoff (5s → 2m) after a network-layer failure,
 *     reset to zero on the first success
 *   • an 'hrmsNetOnline' event so pollers can refresh the instant the
 *     connection comes back, instead of waiting out their interval
 *
 * Only network-layer failures count. An HTTP 4xx/5xx means we reached the
 * server, so the connection is healthy and there is nothing to back off from.
 *
 * Loaded before every consumer in index.html; all scripts are `defer`, which
 * executes them in document order, so window.HRMSNet is always defined first.
 */
(function () {
  if (window.HRMSNet) return;

  var MIN_BACKOFF = 5000;        // first retry delay after a failure
  var MAX_BACKOFF = 120000;      // ceiling — a dead network is retried twice a minute
  var state = {};                // key -> { fails, until }

  function slot(key) {
    return state[key] || (state[key] = { fails: 0, until: 0 });
  }

  function online() {
    return navigator.onLine !== false;
  }

  /*
   * May the poller identified by `key` send a request right now?
   * Pass { background: false } for a user-initiated refresh, which is allowed
   * to run while the tab is hidden (it still respects offline and backoff).
   */
  function ready(key, opts) {
    if (!online()) return false;
    if (document.hidden && !(opts && opts.background === false)) return false;
    return Date.now() >= slot(key).until;
  }

  function succeeded(key) {
    var s = slot(key);
    s.fails = 0;
    s.until = 0;
  }

  function failed(key) {
    var s = slot(key);
    s.fails++;
    s.until = Date.now() + Math.min(MIN_BACKOFF * Math.pow(2, s.fails - 1), MAX_BACKOFF);
  }

  /* fetch() wrapper that feeds the backoff. Same signature as fetch, plus key. */
  function netFetch(key, url, opts) {
    return fetch(url, opts).then(
      function (res) { succeeded(key); return res; },
      function (err) { failed(key); throw err; }
    );
  }

  /* Run fn() only if `key` is allowed to poll right now. Returns whether it ran. */
  function poll(key, fn, opts) {
    if (!ready(key, opts)) return false;
    fn();
    return true;
  }

  /* Connection restored → clear every backoff so the app catches up at once. */
  window.addEventListener('online', function () {
    for (var k in state) {
      if (Object.prototype.hasOwnProperty.call(state, k)) { state[k].fails = 0; state[k].until = 0; }
    }
    window.dispatchEvent(new CustomEvent('hrmsNetOnline'));
  });

  window.HRMSNet = {
    online: online,
    ready: ready,
    poll: poll,
    fetch: netFetch,
    succeeded: succeeded,
    failed: failed
  };
})();
