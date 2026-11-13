/* Exercises the matching logic of hrms-avatars.js in a stubbed browser:
     node tests/hrms-avatars.test.js
   fetch is stubbed to return a fixed /api/avatars list; nothing is painted. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const el = () => ({
  appendChild: noop, insertBefore: noop, removeChild: noop, setAttribute: noop, removeAttribute: noop,
  getAttribute: () => null, addEventListener: noop, closest: () => null, querySelector: () => null,
  querySelectorAll: () => [], classList: { add: noop, contains: () => false }, style: {}, firstChild: null,
});
const listeners = {};
const win = {
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
const LIST = [
  { email: 'priya@company.com', name: 'Priya Sharma', initials: 'PS', v: 11, url: '' },
  { email: 'raja.pavan@company.com', name: 'Raja pavan', initials: 'RP', v: 7, url: '' },
  { email: 'ann@company.com', name: 'Ann Lee', initials: 'AL', v: 1, url: 'https://pics.example/ann.png' },
];
const ctx = {
  window: win,
  document: Object.assign(el(), { readyState: 'complete', getElementById: () => null, createElement: () => el(), head: el(), body: el(), documentElement: el() }),
  localStorage: {
    getItem: (k) => (k === 'hrms_session' ? JSON.stringify({ email: 'me@company.com', name: 'Me Myself', initials: 'MM' }) : null),
    setItem: noop, removeItem: noop,
  },
  MutationObserver: class { observe() {} },
  Image: class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); } },
  URL: { createObjectURL: () => 'blob:x' },
  fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/api/avatars' ? LIST : null), blob: () => Promise.resolve({}) }),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, Date, Math, Object, Array, String, Number, JSON, Promise,
  Error, RegExp, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isFinite, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'dist', 'assets', 'hrms-avatars.js'), 'utf8'), ctx, { filename: 'hrms-avatars.js' });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const A = win.__hrmsAvatars;

// --- initials an avatar may legitimately show for a person -----------------
const rp = A.initialsSet('Raja pavan', 'raja.pavan@company.com', 'RP');
check('first+last initials', !!rp.RP, true);
check('single initial', !!rp.R, true);
check('first two letters', !!rp.RA, true);
check('unrelated initials rejected', !!rp.XY, false);
const one = A.initialsSet('Admin', 'admineversoftit@gmail.com', 'A');
check('one-word name: initial', !!one.A, true);
check('one-word name: email local part', !!one.AD, true);

// --- name matching once the list has loaded --------------------------------
setTimeout(() => {
  check('list loaded', Object.keys(A.people()).length, 3);
  check('name beside avatar resolves', A.nameFor('Priya Sharma · Engineering'), 'priya@company.com');
  check('case-insensitive', A.nameFor('PRIYA SHARMA'), 'priya@company.com');
  check('longest name wins inside a row', A.nameFor('Raja pavan In Break 08:15 PM'), 'raja.pavan@company.com');
  check('substring of a longer word is not a match', A.nameFor('Annabelle Lee'), '');
  check('unknown name', A.nameFor('Ankit R'), '');
  check('empty text', A.nameFor(''), '');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 60);
