/* Runs the REAL getPosition() out of hrms-checkin.js against a faked
 * Geolocation API. The case that matters: an employee standing in the office
 * whose browser answers first with an IP-level fix must still end up sending
 * the GPS reading, and a retry must actually re-measure. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

// The file is an IIFE that bails without a DOM; lift out the geolocation
// section and evaluate it on its own.
const start = src.indexOf('  var GEO_GOOD_ENOUGH_M');
const end = src.indexOf('  /* ── leaving the office');
if (start < 0 || end < 0) { console.error('could not locate the geolocation section'); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`); };

function makeGeo(script) {
  const state = { cleared: 0, opts: null, watches: 0, oneShots: 0 };
  state.api = {
    watchPosition(ok, err, opts) {
      state.opts = opts; state.watches++;
      const id = state.watches;
      script.forEach(function (s) {
        setTimeout(function () {
          if (state.cleared >= id) return;
          if (s.error) err({ code: s.error });
          else ok({ coords: { latitude: s.lat, longitude: s.lng, accuracy: s.acc } });
        }, s.at);
      });
      return id;
    },
    clearWatch(id) { state.cleared = id; },
    getCurrentPosition() { state.oneShots++; }
  };
  return state;
}

function load(script, opts) {
  const ctx = { Math, Number, isFinite, Promise, Error, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  const geo = makeGeo(script);
  ctx.navigator = (opts && opts.noGeo) ? {} : { geolocation: geo.api };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) +
    '\nglobalThis.__get = getPosition;' +
    '\nglobalThis.__checkin = GEO_WAIT_CHECKIN_MS;' +
    '\nglobalThis.__sample = GEO_WAIT_SAMPLE_MS;', ctx);
  return { geo, ctx };
}

(async function () {
  // 1. The reported failure: the browser answers instantly with an IP-level
  //    fix (~100 km) and the GPS lock lands a second later. Sending the first
  //    one is what produced "we cannot tell whether you are at the office".
  {
    const { geo, ctx } = load([
      { at: 0,    lat: 12.90, lng: 77.50, acc: 100000 },  // IP: wrong city
      { at: 1000, lat: 13.41, lng: 79.73, acc: 22 }       // GPS: at the desk
    ]);
    const pos = await ctx.__get();
    check('the GPS lock beats the IP-level first answer', pos && pos.accuracy === 22,
      pos ? `±${pos.accuracy} m` : 'null');
    check('sends the GPS coordinates, not the IP ones',
      pos && Math.abs(pos.latitude - 13.41) < 1e-9, pos && pos.latitude);
    check('stops watching once the fix is good enough', geo.cleared > 0, 'still watching');
  }

  // 2. The retry trap. A cached fix is shared across tabs and accounts on the
  //    browser, so accepting one handed the same bad reading back to every
  //    "try again" for a minute. Each attempt must re-measure.
  {
    const { geo, ctx } = load([{ at: 0, lat: 13.4, lng: 79.7, acc: 40 }]);
    await ctx.__get();
    check('never accepts a cached fix, so a retry re-measures',
      geo.opts.maximumAge === 0, `maximumAge=${geo.opts.maximumAge}`);
    check('asks the platform for high accuracy',
      geo.opts.enableHighAccuracy === true, JSON.stringify(geo.opts));
    check('uses a watch, not the one-shot call',
      geo.watches === 1 && geo.oneShots === 0, `${geo.watches} watches, ${geo.oneShots} one-shots`);
  }

  // 3. A late, worse sample must not undo a good one already held.
  {
    const { ctx } = load([
      { at: 0,   lat: 13.41, lng: 79.73, acc: 60 },
      { at: 300, lat: 12.90, lng: 77.50, acc: 90000 }
    ]);
    const pos = await ctx.__get();
    check('a late IP-level sample cannot displace a better fix',
      pos && pos.accuracy === 60, pos && pos.accuracy);
  }

  // 4. No GPS anywhere: still resolve with the best seen so the server can
  //    widen the fence by it and explain itself, rather than resolving null.
  {
    const { ctx } = load([
      { at: 0,   lat: 12.9, lng: 77.5, acc: 100000 },
      { at: 400, lat: 12.9, lng: 77.5, acc: 60000 }
    ]);
    const pos = await ctx.__get(1500);
    check('a hopeless fix is still reported, with its accuracy attached',
      pos && pos.accuracy === 60000, pos ? `±${pos.accuracy}` : 'null');
  }

  // 5. Contract the callers rely on: never rejects, resolves null on failure.
  {
    const { ctx } = load([{ at: 0, error: 1 }]);            // PERMISSION_DENIED
    const pos = await ctx.__get();
    check('a denied prompt resolves null rather than rejecting', pos === null, `${pos}`);
  }
  {
    const { ctx } = load([], { noGeo: true });
    const pos = await ctx.__get();
    check('a browser with no geolocation resolves null', pos === null, `${pos}`);
  }

  // 6. A mid-watch error must not discard a fix already in hand.
  {
    const { ctx } = load([
      { at: 0,   lat: 13.41, lng: 79.73, acc: 55 },
      { at: 200, error: 2 }                                 // POSITION_UNAVAILABLE
    ]);
    const pos = await ctx.__get();
    check('a mid-watch error keeps the fix already collected',
      pos && pos.accuracy === 55, `${pos && pos.accuracy}`);
  }

  // 7. The background sweep runs every 5 minutes on someone's battery, so its
  //    budget has to be well under the interactive one.
  {
    const { ctx } = load([{ at: 0, lat: 13.4, lng: 79.7, acc: 40 }]);
    await ctx.__get();
    check('the background sweep budget is cheaper than check-in',
      ctx.__sample < ctx.__checkin, `${ctx.__sample} vs ${ctx.__checkin}`);
    check('check-in does not hang a person indefinitely',
      ctx.__checkin > 0 && ctx.__checkin <= 20000, `${ctx.__checkin} ms`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
