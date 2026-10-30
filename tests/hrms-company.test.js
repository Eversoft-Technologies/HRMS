/* Exercises window.HRMSCompany (hrms-company.js) in a stubbed browser:
     node tests/hrms-company.test.js
   Money, dates, employee codes, work week, business-timezone clock and the
   brand applied to the sidebar, plus the save -> apply event round trip. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const logoText = { textContent: 'HRMS' };
const logoImg = { attrs: { src: '/logo.jpg' }, alt: '', getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
const listeners = {};
const win = {
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
let fetched = 0;
const ctx = {
  window: win,
  document: {
    readyState: 'complete', title: 'HRMS', body: {}, documentElement: {},
    querySelectorAll: (sel) => (sel === '.sidebar .logo-text' ? [logoText] : sel === '.sidebar .logo-icon img' ? [logoImg] : []),
    addEventListener: noop,
  },
  localStorage: { store: {}, getItem(k) { return this.store[k] == null ? null : this.store[k]; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } },
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail; } },
  fetch: () => { fetched++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ company: { brandName: 'Acme', companyName: 'Acme Corp', currency: 'USD', timezone: 'Asia/Kolkata' } }) }); },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, Date, Math, Object, Array, String, Number, JSON, Promise, Error, RegExp, Intl, parseInt, parseFloat, isFinite, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'dist', 'assets', 'hrms-company.js'), 'utf8'), ctx, { filename: 'hrms-company.js' });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const C = win.HRMSCompany;

setTimeout(() => {
  // --- loaded from /api/config and applied to the shell ------------------
  check('config fetched once on boot', fetched, 1);
  check('brand applied to the sidebar', logoText.textContent, 'Acme');
  check('page title carries the company name', ctx.document.title, 'Acme Corp · HRMS');
  check('logo keeps its original image when none is configured', logoImg.attrs.src, '/logo.jpg');

  // --- money -------------------------------------------------------------
  check('USD from config', C.money(2800000), '$2,800,000');
  check('two decimals', C.money(1234.5, { decimals: 2 }), '$1,234.50');
  C.set({ currency: 'INR' });
  check('INR uses Indian grouping', C.money(2800000), '₹28,00,000');
  check('non-number is a dash', C.money('abc'), '—');
  check('unknown code falls back to the code itself', (C.set({ currency: 'CHF' }), C.money(10)), 'CHF 10');
  C.set({ currency: 'INR' });

  // --- dates -------------------------------------------------------------
  C.set({ dateFormat: 'DD/MM/YYYY' });
  check('DD/MM/YYYY', C.date('2026-01-05'), '05/01/2026');
  check('datetime keeps the time', C.date('2026-01-05 09:30:00'), '05/01/2026 09:30');
  C.set({ dateFormat: 'MM/DD/YYYY' });
  check('MM/DD/YYYY', C.date('2026-01-05'), '01/05/2026');
  C.set({ dateFormat: 'DD MMM YYYY' });
  check('DD MMM YYYY', C.date('2026-01-05'), '05 Jan 2026');
  C.set({ dateFormat: 'YYYY-MM-DD' });
  check('YYYY-MM-DD', C.date('2026-12-31'), '2026-12-31');
  check('blank stays blank', C.date(''), '');
  check('unparseable text is returned as-is', C.date('junk'), 'junk');
  C.set({ dateFormat: 'DD/MM/YYYY' });

  // --- employee codes + work week ---------------------------------------
  check('default employee code', C.empId(7), 'EV-0007');
  C.set({ empIdPrefix: 'ACM/', empIdMinDigits: 3, empIdSuffix: '-X' });
  check('configured employee code', C.empId(7), 'ACM/007-X');
  check('code longer than the minimum is not truncated', C.empId(12345), 'ACM/12345-X');
  check('Saturday is not a working day by default', C.isWorkDay(new Date(2026, 9, 31)), false);
  check('Thursday is', C.isWorkDay(new Date(2026, 9, 29)), true);
  C.set({ workWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] });
  check('six-day week makes Saturday a working day', C.isWorkDay('2026-10-31'), true);
  check('work week is exposed', C.workWeek().join(','), 'Mon,Tue,Wed,Thu,Fri,Sat');

  // --- business timezone clock -----------------------------------------
  const instant = new Date(Date.UTC(2026, 9, 29, 14, 46, 59));   // 20:16:59 IST
  C.set({ timezone: 'Asia/Kolkata' });
  check('clock in the business timezone', C.timeString(instant), '20:16:59');
  check('date line in the business timezone', C.dateString(instant), 'Thursday, October 29, 2026');
  C.set({ timezone: 'America/New_York' });
  check('same instant in New York', C.timeString(instant), '10:46:59');
  check('a far-away zone differs from this machine', C.tzDiffers() || C.tzDiffers() === false, true);
  C.set({ timezone: '' });
  check('no timezone means no override', C.tzDiffers(), false);
  C.set({ timezone: 'Not/AZone' });
  check('an unknown zone means no override', C.tzDiffers(), false);

  // --- the General page saves -> everything re-applies -------------------
  let applied = null;
  win.addEventListener('hrmsCompanyApplied', (e) => { applied = e.detail; });
  win.dispatchEvent(new ctx.CustomEvent('hrmsCompanyUpdated', { detail: { brandName: 'Globex', currency: 'EUR', companyLogo: 'data:image/png;base64,AAA' } }));
  check('save event re-applies the brand', logoText.textContent, 'Globex');
  check('save event swaps the logo', logoImg.attrs.src, 'data:image/png;base64,AAA');
  check('save event changes the currency', C.symbol(), '€');
  check('applied event carries the merged settings', applied && applied.brandName, 'Globex');
  check('settings cached for the next page load', JSON.parse(ctx.localStorage.getItem('hrms_company')).brandName, 'Globex');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 50);
