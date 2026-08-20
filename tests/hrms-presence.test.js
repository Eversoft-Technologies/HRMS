/* Runs the REAL isCheckedIn()/getStatusKey()/colorForLabel()/presenceFor() out
 * of hrms-status.js.
 *
 * isCheckedIn() is the reason this file exists. It used to compare
 * localStorage[hrms_checked_in] against the string 'true', and hrms-checkin.js
 * had long since changed that cache to {email, date, checkedIn} — stamped so it
 * cannot leak between users or across days. The comparison was therefore false
 * for everybody, forever, and every visible symptom followed from it: a
 * permanently grey presence dot, a status picker stuck on "Check in to set your
 * status", and no presence ever posted for the team panel.
 *
 * Nothing failed loudly, which is exactly why the shape of that cache is
 * pinned here — including the two rejections that make it worth stamping at
 * all (someone else's cache, and yesterday's). */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to);
  if (a < 0 || b < 0) { console.error('could not locate ' + JSON.stringify(from)); process.exit(1); }
  return src.slice(a, b);
}

const ME = 'me@example.test';
let STORE = {};

const ctx = {
  console,
  document: { hidden: false, addEventListener() {}, querySelectorAll: () => [] },
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }),
  setInterval() {},
  localStorage: {
    getItem: (k) => (k in STORE ? STORE[k] : null),
    setItem: (k, v) => { STORE[k] = String(v); },
  },
  actorEmail: () => ME,
  render: () => {},          // the picker's own re-render; not under test here
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

vm.runInContext(
  slice('  var STORAGE_STATUS', '  /* panel open/closed') +
  slice('  /* ── state helpers', '  function setStatus(key)') +
  slice('  /* ── team presence', '  /* ── presence dot on my own avatars') +
  '\nglobalThis.isCheckedIn = isCheckedIn; globalThis.getStatusKey = getStatusKey;' +
  '\nglobalThis.colorForLabel = colorForLabel; globalThis.presenceFor = presenceFor;' +
  '\nglobalThis.setPresence = function (m) { PRESENCE = m; };',
  ctx);

const { isCheckedIn, getStatusKey, colorForLabel, presenceFor, setPresence,
        reconcileLocalStatus } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + JSON.stringify(got)}`); };

const today = () => {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') +
    '-' + String(n.getDate()).padStart(2, '0');
};
const reset = () => { STORE = {}; delete ctx.__hrmsCheckinAPI; };

// ── the cache shape hrms-checkin.js actually writes ─────────────────────────
reset();
check('no cache at all means checked out', isCheckedIn() === false, isCheckedIn());

STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: true });
check('today’s cache for me counts as checked in', isCheckedIn() === true, STORE.hrms_checked_in);

STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: false });
check('a checked-out cache is honoured', isCheckedIn() === false, STORE.hrms_checked_in);

// The two reasons the cache is stamped in the first place.
STORE.hrms_checked_in = JSON.stringify({ email: 'someone.else@example.test', date: today(), checkedIn: true });
check('another user’s cache is not mine', isCheckedIn() === false, STORE.hrms_checked_in);

STORE.hrms_checked_in = JSON.stringify({ email: ME, date: '2020-01-01', checkedIn: true });
check('yesterday’s cache does not carry over', isCheckedIn() === false, STORE.hrms_checked_in);

reset();
STORE.hrms_checked_in = 'true';
check('the legacy bare "true" is still honoured', isCheckedIn() === true, STORE.hrms_checked_in);
STORE.hrms_checked_in = 'not json';
check('an unreadable cache does not throw', isCheckedIn() === false, STORE.hrms_checked_in);

// ── the live module outranks the cache ──────────────────────────────────────
reset();
STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: false });
ctx.__hrmsCheckinAPI = { isCheckedIn: () => true };
check('the check-in module is the authority when it is loaded', isCheckedIn() === true, 'cache won');
ctx.__hrmsCheckinAPI = { isCheckedIn: () => false };
STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: true });
check('...in both directions', isCheckedIn() === false, 'cache won');
ctx.__hrmsCheckinAPI = { isCheckedIn: () => { throw new Error('boom'); } };
check('a throwing module falls back to the cache', isCheckedIn() === true, 'threw');

// ── status follows check-in ─────────────────────────────────────────────────
reset();
check('checked out is offline', getStatusKey() === 'offline', getStatusKey());
STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: true });
check('checked in with nothing chosen is available', getStatusKey() === 'available', getStatusKey());
STORE.hrms_presence_status = 'busy';
check('a chosen status is kept', getStatusKey() === 'busy', getStatusKey());
STORE.hrms_presence_status = 'nonsense';
check('an unknown stored status falls back to available', getStatusKey() === 'available', getStatusKey());
STORE.hrms_presence_status = 'offline';
check('"offline" cannot be chosen by hand', getStatusKey() === 'available', getStatusKey());

// ── the colour a label maps to ──────────────────────────────────────────────
const c = colorForLabel;
check('In Office is green', c('In Office') === '#22c55e', c('In Office'));
check('Available is green', c('Available') === '#22c55e', c('Available'));
check('Remote is blue', c('Remote') === '#4f8ef7', c('Remote'));
check('In Break is amber', c('In Break') === '#f59e0b', c('In Break'));
check('Coffee break is amber', c('Coffee break') === '#f59e0b', c('Coffee break'));
check('Busy is red', c('Busy') === '#ef4444', c('Busy'));
check('Do not disturb is red', c('Do not disturb') === '#ef4444', c('Do not disturb'));
check('In a Meeting is purple', c('In a Meeting') === '#8b5cf6', c('In a Meeting'));
check('Travelling is cyan', c('Travelling') === '#06b6d4', c('Travelling'));
check('Absent is grey', c('Absent') === '#9ca3af', c('Absent'));
check('an unknown label is grey, not a guess', c('Zzz') === '#9ca3af', c('Zzz'));
check('an empty label is grey', c('') === '#9ca3af' && c(null) === '#9ca3af', 'threw or coloured');

// ── whose presence is whose ─────────────────────────────────────────────────
reset();
STORE.hrms_checked_in = JSON.stringify({ email: ME, date: today(), checkedIn: true });
STORE.hrms_presence_status = 'busy';
setPresence({ 'other@example.test': { label: 'In Office', color: '#22c55e' } });

check('before the first poll my own dot comes from my picker',
  presenceFor(ME).label === 'Busy', presenceFor(ME));
check('...case-insensitively', presenceFor(ME.toUpperCase()).label === 'Busy', presenceFor(ME.toUpperCase()));

// Breaks and location switches happen outside the status menu, and the server
// is the only place that knows about them. Once it has spoken about me, it
// wins over whatever the picker last stored.
setPresence({ 'me@example.test': { label: 'In Break', color: '#f59e0b' } });
check('a break started elsewhere shows on my own dot',
  presenceFor(ME).label === 'In Break', presenceFor(ME));
setPresence({ 'me@example.test': { label: 'Remote', color: '#4f8ef7' } });
check('switching to Remote shows on my own dot, though it is not in the picker',
  presenceFor(ME).label === 'Remote' && presenceFor(ME).color === '#4f8ef7', presenceFor(ME));

// ...and the picker catches up with a break it did not start.
STORE.hrms_presence_status = 'available';
setPresence({ 'me@example.test': { label: 'In Break', color: '#f59e0b' } });
reconcileLocalStatus();
check('the picker follows a break it did not start',
  STORE.hrms_presence_status === 'away', STORE.hrms_presence_status);

STORE.hrms_presence_status = 'coffee';
reconcileLocalStatus();
check('a break already chosen by hand is left alone',
  STORE.hrms_presence_status === 'coffee', STORE.hrms_presence_status);

STORE.hrms_presence_status = 'busy';
setPresence({ 'me@example.test': { label: 'In Office', color: '#22c55e' } });
reconcileLocalStatus();
check('a non-break status is not rewritten',
  STORE.hrms_presence_status === 'busy', STORE.hrms_presence_status);

STORE.hrms_presence_status = 'busy';
setPresence({ 'other@example.test': { label: 'In Office', color: '#22c55e' } });
check('a colleague comes from the snapshot',
  presenceFor('other@example.test').label === 'In Office', presenceFor('other@example.test'));
check('a colleague nobody has reported on gets no dot',
  presenceFor('stranger@example.test') === null, presenceFor('stranger@example.test'));
check('an empty email gets no dot', presenceFor('') === null && presenceFor(null) === null, 'returned something');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
