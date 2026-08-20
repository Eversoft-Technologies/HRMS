/* Runs the REAL cached-state helpers out of hrms-checkin.js.
 *
 * The toggle showed "checked in" for someone who was not, so pressing it asked
 * the server to close a session that never opened — "No check-in found for
 * today". The cause was a single unstamped localStorage key that nothing ever
 * reconciled, so it survived both a change of user and a change of day. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  function cachedState()');
const end = src.indexOf('  /* ── helpers ─');
if (start < 0 || end < 0) { console.error('could not locate the state section'); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + got}`); };

function load() {
  const store = {};
  const ctx = {
    console, JSON, Date, String,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    STORAGE_STATE: 'hrms_checked_in',
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) +
    '\nglobalThis.cached = cachedState;' +
    '\nglobalThis.remember = rememberState;' +
    '\nglobalThis.stamp = todayStamp;', ctx);
  return { ctx, store };
}

function signIn(store, email) {
  store['hrms_session'] = JSON.stringify({ email });
}

// ── the reported bug: a different user inherits the previous one's state ──
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  ctx.remember(true);
  check('the signed-in user sees their own state', ctx.cached() === true, ctx.cached());

  signIn(store, 'bob@x.com');
  check('a different user does NOT inherit it', ctx.cached() === false, ctx.cached());

  signIn(store, 'alice@x.com');
  check('and the original user still sees theirs', ctx.cached() === true, ctx.cached());
}

// ── the other half: yesterday's state must not survive into today ─────────
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  store['hrms_checked_in'] = JSON.stringify({
    email: 'alice@x.com', date: '2020-01-01', checkedIn: true });
  check("a previous day's state is not carried over", ctx.cached() === false, ctx.cached());
}

// ── signed out ───────────────────────────────────────────────────────────
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  ctx.remember(true);
  store['hrms_session'] = JSON.stringify({});
  check('signed out shows nobody as checked in', ctx.cached() === false, ctx.cached());
}
{
  const { ctx } = load();               // no session key at all
  check('a missing session is not an error', ctx.cached() === false, ctx.cached());
}

// ── the old format, which is exactly what is in every user's browser now ──
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  store['hrms_checked_in'] = 'true';    // what the previous build wrote
  check('a legacy unstamped value is distrusted, not believed',
    ctx.cached() === false, ctx.cached());
}
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  store['hrms_checked_in'] = 'not json at all';
  check('corrupt storage does not throw', ctx.cached() === false, ctx.cached());
}

// ── round trip ───────────────────────────────────────────────────────────
{
  const { ctx, store } = load();
  signIn(store, 'alice@x.com');
  ctx.remember(false);
  check('false round-trips as false', ctx.cached() === false, ctx.cached());
  ctx.remember(true);
  check('true round-trips as true', ctx.cached() === true, ctx.cached());

  const saved = JSON.parse(store['hrms_checked_in']);
  check('what is written carries the owner', saved.email === 'alice@x.com', saved.email);
  check('and the day', saved.date === ctx.stamp(), saved.date);
}

// ── the stamp itself ─────────────────────────────────────────────────────
{
  const { ctx } = load();
  const s = ctx.stamp();
  check('the day stamp is zero-padded YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(s), s);
  const now = new Date();
  check('and is actually today',
    s === now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0'), s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
