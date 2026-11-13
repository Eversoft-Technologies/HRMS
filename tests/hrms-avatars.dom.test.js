/* Real-DOM check of hrms-avatars.js with jsdom: builds the markup each HRMS
   listing actually renders (copied from the bundle / overlays) and asserts
   which circles get a picture and which must not.

     node tests/hrms-avatars.dom.test.js

   jsdom is not a repo dependency; the test skips (exit 0) when it cannot be
   required. Install it anywhere on NODE_PATH, e.g.  npm i -D jsdom  */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) { console.log('SKIP  jsdom not installed (npm i -D jsdom) — DOM test not run'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const OVERLAY = fs.readFileSync(path.join(ROOT, 'dist', 'dist', 'assets', 'hrms-avatars.js'), 'utf8');
const OWN_PIC = 'data:image/png;base64,OWN';

const html = `<!doctype html><html><head></head><body>
  <div class="sidebar"><div class="sidebar-footer"><div class="av-row"><div class="av">MM</div><div>Me Myself</div></div></div></div>
  <div class="topbar"><div class="av" title="Me Myself">MM</div></div>

  <!-- dashboard directory (hrms-dashboard.js) -->
  <table id="dash"><tbody><tr class="hrms-dir-row"><td><span class="hrms-dir-code">EV-0007</span></td>
    <td><div class="hrms-dir-person"><div class="hrms-dir-avatar">PS</div><div><div class="hrms-dir-name">Priya Sharma</div><div class="hrms-dir-email">priya@company.com</div></div></div></td></tr></tbody></table>

  <!-- HRIS list (bundle Et avatars): name only, manager in another cell -->
  <table id="hris"><thead><tr><th>Employee</th><th>Dept</th><th>Manager</th></tr></thead><tbody>
    <tr id="hris-priya"><td><div class="av-row"><div class="av">PS</div><span>Priya Sharma</span></div></td><td>Engineering</td><td>Raja pavan</td></tr>
    <tr id="hris-ankit"><td><div class="av-row"><div class="av">AR</div><span>Ankit R</span></div></td><td>Engineering</td><td>Priya Sharma</td></tr>
  </tbody></table>

  <!-- leave management row (hrms-leaveui.js) -->
  <table id="leave"><tbody><tr><td><div style="display:flex"><span>▶</span><div class="av">RP</div><div><div>Raja pavan</div><div>raja.pavan@company.com</div></div></div></td></tr></tbody></table>

  <!-- Team Status Now (hrms-attendance-actions.js) -->
  <div id="team" class="haa-tr" data-email="raja.pavan@company.com"><span class="c-nm"><span class="haa-avwrap" data-hrms-presence="raja.pavan@company.com"><span class="haa-av">RP</span></span>Raja pavan</span></div>

  <!-- work submissions (hand-patched bundle: inline-styled circle, no class) -->
  <table id="subs"><tbody><tr><td><div style="display: flex; align-items: center; gap: 10px;"><div id="subs-circle" style="width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #f97316, #fb923c); color: #fff; display: flex;">PS</div><span>Priya Sharma</span></div></td><td>Document</td></tr></tbody></table>

  <!-- task tracker cards (bundle): bare text -->
  <div id="task1" class="kanban-card"><div>Fix login</div><div style="text-align:center">👤 Assigned To: <strong>Raja pavan</strong></div><div style="text-align:center">🧑‍💼 Team Lead: <strong>Priya Sharma</strong></div></div>
  <div id="task2" class="kanban-card"><div style="text-align:center">👤 Assigned To: <strong>Unassigned</strong></div></div>

  <!-- access control (hrms-rbac.js) -->
  <table id="rbac"><tbody><tr><td><div><span class="hrms-rbac-av">PS</span><div><div>Priya Sharma</div><div>priya@company.com</div></div></div></td></tr></tbody></table>

  <!-- employee profile page person card (hrms-hris.js) -->
  <div id="person" class="hp-person" data-key="7"><div class="hp-pav">AR</div><div><div class="hp-pn">Ankit R</div></div></div>

  <!-- a table with an Employee column shown as bare text (leave fallback) -->
  <table id="plain"><thead><tr><th>Employee</th><th>Type</th></tr></thead><tbody>
    <tr id="plain-priya"><td>Priya Sharma</td><td>Casual Leave</td></tr>
    <tr id="plain-nobody"><td>Nobody Known</td><td>Sick Leave</td></tr>
  </tbody></table>

  <!-- an employee listed under the login account's name (alias) + code -->
  <table id="alias"><tbody><tr><td><div class="av-row"><div class="av">RP</div><span>Raja Pavan Kumar</span></div></td></tr>
    <tr><td><div class="av-row"><div class="av">AR</div><span>EV-0042</span></div></td></tr></tbody></table>

  <!-- must stay untouched: a recruitment candidate, and someone with no picture -->
  <div id="cand" style="display:flex"><div class="av">SJ</div><div>Sara Johnson</div></div>
  <div id="nopic" style="display:flex"><div class="av">NK</div><div>Nobody Known · nobody@company.com</div></div>
</body></html>`;

const dom = new JSDOM(html, { url: 'http://127.0.0.1:8000/employees/tasks', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.localStorage.setItem('hrms_session', JSON.stringify({ email: 'me@company.com', name: 'Me Myself', initials: 'MM' }));
w.localStorage.setItem('hrms_profile_pic', OWN_PIC);
w.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
w.URL.createObjectURL = (blob) => 'blob:' + (blob && blob.__who || 'x');
const LIST = [
  { email: 'priya@company.com', name: 'Priya Sharma', aliases: ['Priya Sharma'], employeeId: 'EV-0007', initials: 'PS', v: 11, url: '' },
  { email: 'raja.pavan@company.com', name: 'Raja pavan', aliases: ['Raja pavan', 'Raja Pavan Kumar'], employeeId: '', initials: 'RP', v: 7, url: '' },
  { email: 'ankit@company.com', name: 'Ankit R', aliases: ['Ankit R'], employeeId: 'EV-0042', initials: 'AR', v: 3, url: '' },
];
const fetched = [];
w.fetch = (url) => {
  fetched.push(url);
  if (url === '/api/avatars') return Promise.resolve({ ok: true, json: () => Promise.resolve(LIST) });
  const m = /^\/api\/avatars\/([^?]+)/.exec(url);
  if (m) return Promise.resolve({ ok: true, blob: () => Promise.resolve({ __who: decodeURIComponent(m[1]) }) });
  return Promise.resolve({ ok: false });
};
w.eval(OVERLAY);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const picOf = (sel) => { const el = w.document.querySelector(sel); const img = el && el.querySelector('img.hrms-avatar-img'); return img ? img.getAttribute('src') : ''; };

setTimeout(() => {
  // own avatars
  check('sidebar footer shows my own picture', picOf('.sidebar-footer .av'), OWN_PIC);
  check('topbar avatar shows my own picture', picOf('.topbar .av'), OWN_PIC);
  // dashboard / lists keyed by email
  check('dashboard directory row', picOf('#dash .hrms-dir-avatar'), 'blob:priya@company.com');
  check('leave management row', picOf('#leave .av'), 'blob:raja.pavan@company.com');
  check('team status row (data-email)', picOf('#team .haa-av'), 'blob:raja.pavan@company.com');
  check('access control row', picOf('#rbac .hrms-rbac-av'), 'blob:priya@company.com');
  // name-only lists
  check('HRIS row resolves by the name beside the avatar', picOf('#hris-priya .av'), 'blob:priya@company.com');
  check('HRIS row ignores the manager named in another cell', picOf('#hris-ankit .av'), 'blob:ankit@company.com');
  check('profile page person card', picOf('#person .hp-pav'), 'blob:ankit@company.com');
  check('alias: login-account spelling of the name', picOf('#alias tr:nth-child(1) .av'), 'blob:raja.pavan@company.com');
  check('employee code resolves a person', picOf('#alias tr:nth-child(2) .av'), 'blob:ankit@company.com');
  // inline-styled circle (work submissions)
  check('work submissions inline circle', picOf('#subs-circle'), 'blob:priya@company.com');
  // injected avatars (task cards + plain Employee tables)
  const t1 = w.document.querySelectorAll('#task1 .hrms-av-inject');
  check('task card: avatar inserted for Assigned To and Team Lead', t1.length, 2);
  check('task card: assignee avatar shows the picture', t1[0] ? (t1[0].querySelector('img') || {}).getAttribute?.('src') || '' : '', 'blob:raja.pavan@company.com');
  check('task card: assignee initials', t1[0] ? t1[0].firstChild && t1[0].lastChild.nodeValue : '', 'RP');
  check('task card: team lead avatar shows the picture', t1[1] ? (t1[1].querySelector('img') || {}).getAttribute?.('src') || '' : '', 'blob:priya@company.com');
  check('task card: avatar sits right before the name', t1[0] && t1[0].nextSibling && t1[0].nextSibling.tagName, 'STRONG');
  check('task card: Unassigned gets nothing', w.document.querySelectorAll('#task2 .hrms-av-inject').length, 0);
  check('plain Employee table: avatar inserted on every row', w.document.querySelectorAll('#plain .hrms-av-inject').length, 2);
  check('plain Employee table: known person gets the picture', picOf('#plain-priya .hrms-av-inject'), 'blob:priya@company.com');
  check('plain Employee table: unknown person keeps initials only', picOf('#plain-nobody .hrms-av-inject'), '');
  check('plain Employee table: unknown person initials', (w.document.querySelector('#plain-nobody .hrms-av-inject') || {}).textContent, 'NK');
  check('HRIS table (already has avatars) is not double-injected', w.document.querySelectorAll('#hris .hrms-av-inject').length, 0);
  // must stay untouched
  check('candidate avatar untouched', picOf('#cand .av'), '');
  check('person without a picture untouched', picOf('#nopic .av'), '');
  // idempotent: a second sweep adds nothing
  const before = w.document.querySelectorAll('img.hrms-avatar-img, .hrms-av-inject').length;
  w.__hrmsAvatars.sweep();
  check('second sweep is idempotent', w.document.querySelectorAll('img.hrms-avatar-img, .hrms-av-inject').length, before);
  check('each picture fetched once', fetched.filter((u) => u.startsWith('/api/avatars/')).length, 3);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 400);
