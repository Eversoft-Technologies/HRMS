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
  var TIMEOUT = 15000;           // give up on a hung request rather than wait out the OS
  var state = {};                // key -> { fails, until, inflight }

  /*
   * Shared circuit breaker. failed() is only called for network-layer failures
   * (an HTTP 4xx/5xx means we reached the server), so consecutive failures
   * across different pollers mean the connection is gone, not that one endpoint
   * is unhappy. Backing each poller off independently still lets a dozen of
   * them take turns hammering a dead network; one shared gate lets a single
   * probe through per cooldown instead. Any success reopens it immediately.
   */
  var netFails = 0;
  var netUntil = 0;
  var inflightCount = 0;
  var TRIP_AFTER = 3;            // consecutive network failures before we go half-open

  function slot(key) {
    return state[key] || (state[key] = { fails: 0, until: 0, inflight: false });
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
    var s = slot(key);
    // Never let a poller overlap itself. When DNS dies a request can hang for
    // 40s while a 10s interval keeps firing, and backoff cannot help because it
    // is only set once a request *fails* — so four more are already in flight by
    // then. This single check is what stops the pile-up.
    if (s.inflight) return false;
    if (Date.now() < netUntil) return false;   // whole connection looks down
    // Half-open: once the connection looks dead, let exactly one request at a
    // time test it. Otherwise every poller whose timer is due fires the instant
    // the cooldown lapses, and they all fail together.
    if (netFails >= TRIP_AFTER && inflightCount > 0) return false;
    return Date.now() >= s.until;
  }

  /* Mark a request as started for callers that do their own fetching. */
  function begin(key) {
    var s = slot(key);
    if (!s.inflight) { s.inflight = true; inflightCount++; }
  }

  function settle(s) {
    if (s.inflight) { s.inflight = false; inflightCount = Math.max(0, inflightCount - 1); }
  }

  function succeeded(key) {
    var s = slot(key);
    s.fails = 0;
    s.until = 0;
    settle(s);
    netFails = 0;                 // the connection is alive — reopen for everyone
    netUntil = 0;
  }

  function failed(key) {
    var s = slot(key);
    s.fails++;
    s.until = Date.now() + Math.min(MIN_BACKOFF * Math.pow(2, s.fails - 1), MAX_BACKOFF);
    settle(s);
    // Only trip the shared gate once failures look widespread. A single flaky
    // endpoint must not pause every other poller — that is what the per-key
    // backoff above is for.
    netFails++;
    netUntil = netFails >= TRIP_AFTER
      ? Date.now() + Math.min(MIN_BACKOFF * Math.pow(2, netFails - TRIP_AFTER), MAX_BACKOFF)
      : 0;
  }

  /*
   * fetch() wrapper that feeds the backoff. Same signature as fetch, plus key.
   * Aborts after TIMEOUT so a hung request registers its failure (and starts
   * backing off) promptly instead of occupying the slot for the OS's own,
   * much longer, DNS timeout.
   */
  function netFetch(key, url, opts) {
    begin(key);
    var ctl = null, timer = null;
    opts = opts || {};
    try {
      if (typeof AbortController === 'function' && !opts.signal) {
        ctl = new AbortController();
        opts.signal = ctl.signal;
        timer = setTimeout(function () { try { ctl.abort(); } catch (_) {} }, TIMEOUT);
      }
    } catch (_) {}
    function done() { if (timer) clearTimeout(timer); }
    return fetch(url, opts).then(
      function (res) { done(); succeeded(key); return res; },
      function (err) { done(); failed(key); throw err; }
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
      if (Object.prototype.hasOwnProperty.call(state, k)) {
        state[k].fails = 0; state[k].until = 0; state[k].inflight = false;
      }
    }
    inflightCount = 0;
    netFails = 0;
    netUntil = 0;
    window.dispatchEvent(new CustomEvent('hrmsNetOnline'));
  });

  window.HRMSNet = {
    online: online,
    ready: ready,
    poll: poll,
    fetch: netFetch,
    begin: begin,
    succeeded: succeeded,
    failed: failed
  };
})();
