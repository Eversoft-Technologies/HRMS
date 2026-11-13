/* Exercises the pure helpers of hrms-employee-tabs.js and hrms-hris.js in a
   stubbed browser environment (same approach as hrms-net.test.js):

     node tests/hrms-hris.test.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSETS = path.join(__dirname, '..', 'dist', 'dist', 'assets');
const noop = () => {};
const el = () => ({
  appendChild: noop, remove: noop, setAttribute: noop, removeAttribute: noop,
  hasAttribute: () => false, contains: () => false, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  classList: { add: noop, toggle: noop }, style: {}, childNodes: [],
  textContent: '', innerHTML: '',
});
const listeners = {};
const win = {
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
const ctx = {
  window: win,
  document: Object.assign(el(), {
    readyState: 'complete', getElementById: () => null, createElement: () => el(),
    head: el(), body: el(), documentElement: el(),
  }),
  location: { pathname: '/' },
  history: { pushState: noop, replaceState: noop },
  localStorage: { getItem: (k) => (k === 'hrms_session' && ctx.__session ? JSON.stringify(ctx.__session) : null), setItem: noop, removeItem: noop },
  MutationObserver: class { observe() {} },
  PopStateEvent: class { constructor(t) { this.type = t; } },
  fetch: () => Promise.reject(new Error('no network in tests')),
  setTimeout, clearTimeout, Date, Math, Object, Array, String, Number, JSON, Promise,
  Error, RegExp, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isFinite, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const file of ['hrms-employee-tabs.js', 'hrms-hris.js']) {
  vm.runInContext(fs.readFileSync(path.join(ASSETS, file), 'utf8'), ctx, { filename: file });
}

const H = win.__hrmsHris;
const T = win.HRMSEmployeeTabs;
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// --- route helpers: the URL key is an AppUser id OR a URL-encoded email ----
check('numeric key', H.profileKey('/hr/hris/7'), '7');
check('trailing slash tolerated', H.profileKey('/hr/hris/7/'), '7');
check('email key is decoded', H.profileKey('/hr/hris/priya%40company.com'), 'priya@company.com');
check('list route has no key', H.profileKey('/hr/hris'), '');
check('deeper path is not a profile', H.profileKey('/hr/hris/7/extra'), '');
check('other /hr route ignored', H.profileKey('/hr/perform/7'), '');
check('url for id', H.profileUrl('7'), '/hr/hris/7');
check('url for id (number)', H.profileUrl(7), '/hr/hris/7');
check('url for email is encoded', H.profileUrl('priya@company.com'), '/hr/hris/priya%40company.com');
check('url for blank key is the list', H.profileUrl(''), '/hr/hris');
check('round trip id', H.profileKey(H.profileUrl('42')), '42');
check('round trip email', H.profileKey(H.profileUrl('a.b+c@x.io')), 'a.b+c@x.io');
check('list route', H.isListRoute('/hr/hris/'), true);
check('profile is not the list route', H.isListRoute('/hr/hris/7'), false);

// --- My Profile: the signed-in user's own profile lives at /my-profile -------
ctx.__session = { email: 'Me@Company.com' };
check('my-profile path', H.MY_PATH, '/my-profile');
check('/my-profile resolves to the signed-in user', H.profileKey('/my-profile'), 'me@company.com');
check('trailing slash tolerated', H.profileKey('/my-profile/'), 'me@company.com');
check('own email links to /my-profile', H.profileUrl('me@company.com'), '/my-profile');
check('a colleague still links to their HRIS profile', H.profileUrl('priya@company.com'), '/hr/hris/priya%40company.com');
ctx.__session = null;
check('signed out: /my-profile has no key', H.profileKey('/my-profile'), '');

// --- tabs follow the server-computed section grants ------------------------
const sections = { attendance: true, leave: false, work: true, payroll: false, documents: true, account: false, onboarding: true, team: true };
check('tabs follow grants', H.tabsFor({ sections, onboarding: null }).map((t) => t.id).join(','),
  'overview,attendance,checkin,tasks,submissions,documents,team');
check('onboarding tab needs a linked record', H.tabsFor({ sections, onboarding: { candidateId: 1 } }).map((t) => t.id).includes('onboarding'), true);
check('payroll tab hidden without grant', H.tabsFor({ sections }).some((t) => t.id === 'payroll'), false);
check('no data → overview only', H.tabsFor(null).map((t) => t.id).join(','), 'overview');

// --- shared tab module -----------------------------------------------------
check('module exposes the five tabs', T.tabs.join(','), 'attendance,checkin,tasks,submissions,leave');
check('attendance % (1 present + 1 late of 3)', T.attendancePct({ present: 1, late: 1, absent: 1 }), 67);
check('attendance % counts half-day as half', T.attendancePct({ present: 1, half_day: 1 }), 75);
check('attendance % with no rows is null', T.attendancePct({}), null);
check('attendance % with no summary is null', T.attendancePct(null), null);
const r7 = T.rangeFor('7');
const d = new Date(); d.setDate(d.getDate() - 6);
check('7-day range starts 6 days ago', r7.from, T.isoDate(d));
check('7-day range ends today', r7.to, T.todayIso());
check('custom range keeps the given dates', T.rangeFor('custom', '2026-01-01', '2026-01-31').from, '2026-01-01');
check('escape neutralises markup', T.esc('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
check('initials from a full name', T.initials('Priya Sharma'), 'PS');
check('minutes formatting', T.fmtMins(125), '2h 5m');
check('render refuses an unknown tab', T.render('nope', el(), { email: 'a@b.c' }), false);
check('render refuses a missing email', T.render('tasks', el(), { email: '' }), false);

console.log(`\n${pass} passed, ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 30);
