/* Exercises hrms-net.js in a stubbed browser environment. */
const fs = require('fs');
const vm = require('vm');

const listeners = {};
const win = {
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
};
const ctx = {
  window: win,
  navigator: { onLine: true },
  document: { hidden: false },
  CustomEvent: class { constructor(t, d) { this.type = t; Object.assign(this, d); } },
  fetch: null,
  Date, Math, Object,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);

const Net = win.HRMSNet;
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${got}, want ${want})`}`);
};

// 1. Healthy tab, online and visible → polling allowed.
check('online + visible polls', Net.ready('perms'), true);

// 2. Offline → every poller is silenced, which is the console-flood fix.
ctx.navigator.onLine = false;
check('offline blocks background poll', Net.ready('perms'), false);
check('offline blocks foreground too', Net.ready('perms', { background: false }), false);
ctx.navigator.onLine = true;

// 3. Hidden tab → background polls stop, user-initiated refresh still runs.
ctx.document.hidden = true;
check('hidden blocks background poll', Net.ready('perms'), false);
check('hidden allows foreground refresh', Net.ready('perms', { background: false }), true);
ctx.document.hidden = false;

// 4. A network-layer failure backs the poller off; other pollers are unaffected.
Net.failed('perms');
check('backoff after 1 failure', Net.ready('perms'), false);
check('backoff is per-poller', Net.ready('live'), true);

// 5. Backoff grows, then the reconnect event clears it for everyone at once.
Net.failed('perms'); Net.failed('perms');
check('still backed off after 3 failures', Net.ready('perms'), false);
win.dispatchEvent(new ctx.CustomEvent('online', {}));
check('online event clears backoff', Net.ready('perms'), true);

// 6. A success resets the counter so the next failure starts at the floor again.
Net.failed('live'); Net.succeeded('live');
check('success resets backoff', Net.ready('live'), true);

// 7a. In-flight guard: a poller must never overlap itself. This is what stopped
//     the flood — a hung request used to leave the slot open every interval.
Net.begin('slow');
check('in-flight blocks a second request', Net.ready('slow'), false);
Net.succeeded('slow');
check('slot frees when the request settles', Net.ready('slow'), true);

// 7b. A healthy app is never throttled, however many requests it makes.
let throttled = 0;
for (let i = 0; i < 50; i++) {
  if (!Net.ready('healthy')) throttled++;
  Net.begin('healthy');
  Net.succeeded('healthy');
}
check('healthy polling is never gated', throttled, 0);

// 7c. Circuit breaker: widespread failures gate everyone, but one flaky
//     endpoint does not.
Net.failed('a');
check('one failure leaves others alone', Net.ready('b'), true);
Net.failed('b'); Net.failed('c');
check('three failures trip the shared gate', Net.ready('d'), false);
Net.succeeded('a');
check('one success reopens everything', Net.ready('d'), true);

// 7. HTTP errors must NOT back off — the server was reached.
ctx.fetch = () => Promise.resolve({ ok: false, status: 500 });
Net.fetch('http', '/api/x').then(() => {
  check('HTTP 500 does not back off', Net.ready('http'), true);

  // 8. A rejected fetch (real network failure) does back off.
  ctx.fetch = () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
  return Net.fetch('dns', '/api/y').catch(() => {});
}).then(() => {
  check('rejected fetch backs off', Net.ready('dns'), false);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
