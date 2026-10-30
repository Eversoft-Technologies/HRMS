/* Real-DOM check of hrms-org-forms.js (jsdom). Builds the bundle's own task
   and submission modal markup and asserts the team controls and the request
   rewriting.
     node tests/hrms-org-forms.dom.test.js
   Skips (exit 0) when jsdom is not installed: npm i -D jsdom */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) { console.log('SKIP  jsdom not installed (npm i -D jsdom) — DOM test not run'); process.exit(0); }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dist', 'dist', 'assets', 'hrms-org-forms.js'), 'utf8');
// le({label, required, icon}) from the bundle: <div><label><span>icon</span>Label<span>*</span></label>child</div>
const field = (label, child, req) => `<div style="margin-bottom:16px"><label><span>🎫</span>${label}${req ? '<span>*</span>' : ''}</label>${child}</div>`;

const TEAMS = [
  { id: 1, name: 'Platform', lead: { email: 'anna@x.com', name: 'Anna Lead' } },
  { id: 2, name: 'Infra', lead: { email: 'dan@x.com', name: 'Dan Ops' } },
];
const sent = [];

function boot(html, opts) {
  opts = opts || {};
  const dom = new JSDOM(`<!doctype html><body><div class="main"><div class="content">${html}</div></div></body>`,
    { url: 'http://127.0.0.1:8000' + (opts.path || '/employees/tasks'), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.setItem('hrms_session', JSON.stringify({ email: opts.me || 'hr@x.com' }));
  w.__hrmsCan = (c) => (opts.perms || []).indexOf(c) !== -1;
  w.fetch = (url, init) => {
    sent.push({ url: String(url), init: init || {} });
    let data = [];
    if (/\/api\/teams\?status=active&email=/.test(url)) data = opts.myTeams || [];
    else if (/\/api\/teams\?status=active/.test(url)) data = TEAMS;
    else if (/\/api\/org\/reviewers/.test(url)) data = [{ email: 'anna@x.com', name: 'Anna Lead', isLead: true }, { email: 'hr@x.com', name: 'HR Person' }];
    else if (/\/api\/tasks\?/.test(url) || url === '/api/tasks') data = opts.tasks || [];
    return Promise.resolve({ ok: !opts.fail, status: opts.fail ? 400 : 200, json: () => Promise.resolve(opts.fail ? { message: opts.fail } : data),
      clone() { return this; } });
  };
  w.eval(SRC);
  return w;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

(async () => {
  // ---- task modal ---------------------------------------------------------
  const taskHtml = '<div id="modal">' + field('Task ID', '<input value="" readonly>') +
    field('Assigned To', '<input id="assignee" value="">', true) + field('Team Lead', '<input id="lead" value="">', true) + '</div>';
  let w = boot(taskHtml);
  await wait(80);
  const sel = w.document.querySelector('[data-of-sel="task"]');
  check('task: team dropdown inserted', !!sel, true);
  check('task: it sits right above Assigned To', sel && sel.closest('[data-of]').nextElementSibling.textContent.indexOf('Assigned To') !== -1, true);
  check('task: active teams + "No team" listed', sel && sel.options.length, 4);
  sel.value = '2'; sel.dispatchEvent(new w.Event('change'));
  const lead = w.document.getElementById('lead');
  check('task: lead filled from the team', lead.value, 'Dan Ops');
  check('task: lead locked once a team sets it', lead.readOnly, true);
  sent.length = 0;
  await w.fetch('/api/tasks/assignees?q=c');
  check('task: assignee search narrowed to the team', sent[0].url, '/api/tasks/assignees?q=c&teamId=2');
  sent.length = 0;
  await w.fetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'X', assigneeEmail: 'cara@x.com' }) });
  check('task: save carries the team id', JSON.parse(sent[0].init.body).teamId, 2);

  // editing an existing task preselects its team
  w = boot('<div>' + field('Task ID', '<input value="TASK-1" readonly>') + field('Assigned To', '<input>', true) +
    field('Team Lead', '<input id="lead">', true) + '</div>', { tasks: [{ taskCode: 'TASK-1', teamId: 1 }] });
  await wait(80);
  check('task edit: current team preselected', w.document.querySelector('[data-of-sel="task"]').value, '1');

  // a refused save shows the server's message
  w = boot(taskHtml, { fail: 'This person belongs to several teams. Choose the team this belongs to.' });
  await wait(50);
  await w.fetch('/api/tasks', { method: 'POST', body: '{}' });
  await wait(20);
  check('task: refusal is shown, not swallowed', w.document.body.textContent.indexOf('several teams') !== -1, true);

  // ---- submission modal -----------------------------------------------------
  // The bundle's own form: Title, then a required role-name Reviewer select.
  const subHtml = '<div><h3>New Submission</h3>' + field('Title', '<input>', true) +
    '<div><label>Reviewer <span>*</span></label><select id="bundle-rev" required><option value="">Select a reviewer…</option><option value="Manager">Manager</option><option value="Team Lead">Team Lead</option></select></div></div>';
  w = boot(subHtml, { path: '/employees/submissions', me: 'bob@x.com', myTeams: [TEAMS[0]] });
  await wait(80);
  const box = w.document.querySelector('[data-of="sub-team"]');
  check('submission: single team shown read-only', box && box.textContent.indexOf('Platform') !== -1 && !box.querySelector('select[data-of-sel="sub"]'), true);
  check('submission: reviewer is the lead, read-only', box.textContent.indexOf('Reviewer: Anna Lead') !== -1, true);
  const bundleRev = w.document.getElementById('bundle-rev');
  check('submission: the bundle Reviewer field is hidden', bundleRev.parentElement.style.display, 'none');
  check('submission: ...and still satisfied for the form', bundleRev.value, 'Team Lead');
  const visibleReviewerLabels = Array.from(w.document.querySelectorAll('label')).filter((l) => /^Reviewer/.test(l.textContent.trim()) && l.parentElement.style.display !== 'none' && !l.closest('[style*="display: none"]'));
  check('submission: only one Reviewer visible', visibleReviewerLabels.length + (box.textContent.indexOf('Reviewer:') !== -1 ? 1 : 0), 1);
  sent.length = 0;
  await w.fetch('/api/submissions', { method: 'POST', body: JSON.stringify({ title: 'R', email: 'bob@x.com' }) });
  check('submission: save carries the preselected team', JSON.parse(sent[0].init.body).teamId, 1);
  check('submission: save names the routed reviewer, not the role', JSON.parse(sent[0].init.body).reviewer, 'Anna Lead');

  w = boot(subHtml, { path: '/employees/submissions', me: 'cara@x.com', myTeams: TEAMS });
  await wait(80);
  const s2 = w.document.querySelector('[data-of-sel="sub"]');
  check('submission: several teams means an explicit choice', s2 && s2.value, '');
  check('submission: only the person\'s own teams offered', s2 && s2.options.length, 3);

  w = boot(subHtml, { path: '/employees/submissions', me: 'hr@x.com', myTeams: [TEAMS[0]], perms: ['submission.view_all'] });
  await wait(100);
  const rev = w.document.querySelector('[data-of-sel="rev"]');
  check('submission: HR gets a reviewer dropdown, lead preselected', rev && rev.value, 'anna@x.com');

  w = boot(subHtml, { path: '/employees/submissions', me: 'eve@x.com', myTeams: [] });
  await wait(80);
  check('submission: no team means the HR queue', w.document.querySelector('[data-of="sub-team"]').textContent.indexOf('HR review queue') !== -1, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
