/* Runs the REAL locateBest() out of hrms-attendance-admin.js against a faked
 * Geolocation API, so the thing under test is the actual refinement logic:
 * does it wait past the first coarse network fix and keep the tightest one? */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

// The file is an IIFE that bails without a DOM; lift out just the positioning
// section and evaluate it on its own.
const start = src.indexOf('  var GEO_GOOD_ENOUGH_M');
const end = src.indexOf('  /* ── data ──');
if (start < 0 || end < 0) { console.error('could not locate the positioning section'); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`); };

/* A watchPosition that replays a scripted series of fixes on a virtual clock,
 * the way a real device does: the network answers instantly and coarsely, GPS
 * arrives seconds later and tight. */
function makeGeo(script) {
  const state = { cleared: 0, opts: null, watches: 0 };
  state.api = {
    watchPosition(ok, err, opts) {
      state.opts = opts; state.watches++;
      const id = state.watches;
      script.forEach(function (s) {
        setTimeout(function () {
          if (state.cleared >= id) return;              // watch already stopped
          if (s.error) err({ code: s.error });
          else ok({ coords: { latitude: s.lat, longitude: s.lng, accuracy: s.acc } });
        }, s.at);
      });
      return id;
    },
    clearWatch(id) { state.cleared = id; }
  };
  return state;
}

function run(script) {
  const ctx = {
    Math, Number, isFinite, Promise, Error, console,
    setTimeout, clearTimeout
  };
  ctx.globalThis = ctx;
  const geo = makeGeo(script);
  ctx.navigator = { geolocation: geo.api };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nglobalThis.__locate = locateBest;' +
    '\nglobalThis.__zoom = zoomForAccuracy;' +
    '\nglobalThis.__wait = GEO_MAX_WAIT_MS;' +
    '\nglobalThis.__good = GEO_GOOD_ENOUGH_M;', ctx);
  const progress = [];
  return {
    geo, ctx, progress,
    result: ctx.__locate(function (f) { progress.push(f.accuracy); })
      .then(function (f) { return { ok: f }; }, function (e) { return { err: e }; })
  };
}

(async function () {
  // 1. The whole point: a 1200 m network fix at t=0 must not win over the GPS
  //    lock that lands two seconds later.
  {
    const r = run([
      { at: 0,    lat: 13.4000, lng: 79.7000, acc: 1200 },
      { at: 300,  lat: 13.4100, lng: 79.7300, acc: 400 },
      { at: 2000, lat: 13.4123, lng: 79.7386, acc: 12 }
    ]);
    const { ok } = await r.result;
    check('keeps refining past the first coarse fix', ok && ok.accuracy === 12,
      ok ? `±${ok.accuracy} m` : 'rejected');
    check('resolves the coordinates of the best fix, not the first',
      ok && Math.abs(ok.longitude - 79.7386) < 1e-9, ok && ok.longitude);
    check('reports every improvement to the caller',
      r.progress.join(',') === '1200,400,12', r.progress.join(','));
    check('stops the watch once the fix is good enough', r.geo.cleared > 0, 'still watching');
    check('asks the platform for high accuracy and no cache',
      r.geo.opts.enableHighAccuracy === true && r.geo.opts.maximumAge === 0,
      JSON.stringify(r.geo.opts));
  }

  // 2. Readings arrive out of order; a later, worse one must never displace a
  //    good fix already in hand.
  {
    const r = run([
      { at: 0,    lat: 13.41, lng: 79.73, acc: 35 },
      { at: 400,  lat: 13.30, lng: 79.10, acc: 2400 },   // network fix landing late
      { at: 900,  lat: 13.35, lng: 79.50, acc: 900 }
    ]);
    const { ok } = await r.result;
    check('a later worse reading never displaces a better one',
      ok && ok.accuracy === 35, ok ? `±${ok.accuracy} m` : 'rejected');
    check('only improvements are reported', r.progress.join(',') === '35', r.progress.join(','));
  }

  // 3. Desktop with no GPS: readings never get good, so the wait budget has to
  //    end it — with the best fix seen, plus an accuracy the UI can warn on.
  {
    const r = run([
      { at: 0,   lat: 13.4, lng: 79.7, acc: 3000 },
      { at: 500, lat: 13.4, lng: 79.7, acc: 1400 }
    ]);
    const { ok } = await r.result;
    check('gives up at the budget and returns the best it saw',
      ok && ok.accuracy === 1400, ok ? `±${ok.accuracy} m` : 'rejected');
    check('the budget is bounded', r.ctx.__wait > 0 && r.ctx.__wait <= 30000, `${r.ctx.__wait} ms`);
  }

  // 4. A momentary failure mid-watch must not throw away a fix already held.
  {
    const r = run([
      { at: 0,   lat: 13.41, lng: 79.73, acc: 18 },
      { at: 200, error: 2 }                              // POSITION_UNAVAILABLE
    ]);
    const { ok, err } = await r.result;
    check('a mid-watch error does not discard the fix in hand',
      !err && ok && ok.accuracy === 18, err ? 'rejected' : ok && ok.accuracy);
  }

  // 5. Nothing but errors is a genuine failure, so the caller can say so.
  {
    const r = run([{ at: 0, error: 1 }]);                 // PERMISSION_DENIED
    const { err } = await r.result;
    check('rejects when no fix ever arrives', !!err, 'resolved anyway');
  }

  // 6. Zoom must widen as the error grows, or the map shows a confidently
  //    wrong spot at street level.
  {
    const r = run([{ at: 0, lat: 13.4, lng: 79.7, acc: 10 }]);
    await r.result;
    const z = r.ctx.__zoom;
    check('zoom loosens as accuracy worsens',
      z(10) > z(100) && z(100) > z(500) && z(500) > z(5000),
      `${z(10)},${z(100)},${z(500)},${z(5000)}`);
    check('a sub-20 m fix is framed at street level', z(10) >= 17, `${z(10)}`);
    check('a kilometre-scale fix is framed at town level', z(5000) <= 14, `${z(5000)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
