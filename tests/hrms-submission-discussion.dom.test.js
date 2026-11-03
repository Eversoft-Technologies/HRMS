/* Real-DOM check of hrms-submission-discussion.js (jsdom).
     node tests/hrms-submission-discussion.dom.test.js [out.html]
   Skips (exit 0) when jsdom is not installed: npm i -D jsdom
   With an output path it also writes the open panel as standalone HTML. */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) { console.log('SKIP  jsdom not installed (npm i -D jsdom) — DOM test not run'); process.exit(0); }

const ASSETS = path.join(__dirname, '..', 'dist', 'dist', 'assets');
const ROWS = [
  { id: 18, title: 'API spec', employee: 'Bob X', email: 'bob@x.com', commentCount: 2, collaborators: ['dan@x.com'] },
  { id: 19, title: 'Landing page', employee: 'Bob X', email: 'bob@x.com', commentCount: 0, collaborators: [] },
];
const THREAD = {
  id: 18, title: 'API spec', status: 'In Review', teamName: 'Backend', canManage: true,
  submitter: { email: 'bob@x.com', name: 'Bob X', initials: 'BX' },
  reviewer: { email: 'anna@x.com', name: 'Anna Lead', initials: 'AL' },
  collaborators: [{ email: 'dan@x.com', name: 'Dan Design', initials: 'DD' }],
  comments: [
    { id: 1, authorEmail: 'dan@x.com', authorName: 'Dan Design', body: 'Can the header use our design tokens?', createdAt: '2026-10-30 10:00:00' },
    { id: 2, authorEmail: 'bob@x.com', authorName: 'Bob X', body: 'Yes — updating now.', createdAt: '2026-10-30 10:05:00' },
  ],
};
const PEOPLE = [{ email: 'eve@x.com', name: 'Eve Ops', designation: 'SRE', department: 'Infra' }, { email: 'dan@x.com', name: 'Dan Design' }];
const sent = [];
const row = (emp, title) => `<tr><td>${emp}</td><td>Document</td><td>${title}</td><td>Today</td><td>Anna Lead</td><td>Pending</td><td>84</td><td><button>View</button></td></tr>`;
const html = `<!doctype html><body><div class="main"><div class="content"><table><thead><tr>${['EMPLOYEE', 'TYPE', 'TITLE', 'SUBMITTED', 'REVIEWER', 'STATUS', 'AI SCORE', 'ACTION'].map((h) => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${row('BX Bob X', 'API spec')}${row('BX Bob X', 'Landing page')}${row('ZZ Unknown', 'Not mine')}</tbody></table></div></div></body>`;
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8000/employees/submissions', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.localStorage.setItem('hrms_session', JSON.stringify({ email: 'bob@x.com' }));
w.fetch = (url, init) => {
  sent.push({ url, init: init || {} });
  let data = [];
  if (url === '/api/submissions') data = ROWS;
  else if (/\/thread$/.test(url)) data = THREAD;
  else if (url === '/api/org/people') data = PEOPLE;
  else if (/\/comments$/.test(url)) data = { id: 3 };
  else if (/\/collaborators/.test(url)) data = THREAD;
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(data)) });
};
w.eval(fs.readFileSync(path.join(ASSETS, 'hrms-submission-discussion.js'), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };

(async () => {
  await wait(120);
  const btns = w.document.querySelectorAll('.hsd-btn');
  check('a Discuss button per known submission', btns.length, 2);
  check('it carries the comment count', btns[0].textContent.replace(/\s+/g, ' ').trim(), '💬 Discuss 2');
  check('it sits in the Action cell', btns[0].parentElement === w.document.querySelector('tbody tr').lastElementChild, true);
  check('the unknown row gets none', w.document.querySelectorAll('tbody tr')[2].querySelector('.hsd-btn'), null);

  btns[0].click();
  await wait(120);
  const panel = w.document.getElementById('hrms-sd-panel');
  check('the panel opens', !!panel, true);
  check('people: submitter, reviewer and collaborator', panel.querySelectorAll('.hsd-chip').length, 3);
  check('both comments shown', panel.querySelectorAll('.hsd-msg').length, 2);
  check('own comment marked as mine', panel.querySelectorAll('.hsd-msg.mine').length, 1);
  const pick = panel.querySelector('[data-sd="pick"]');
  check('picker offers people not already in it', pick && Array.from(pick.options).map((o) => o.value).join(','), ',eve@x.com');
  if (process.argv[2]) {
    const css = ['index-C53rmAEs.css', 'theme-overrides.css'].map((f) => fs.readFileSync(path.join(ASSETS, f), 'utf8')).join('\n');
    const styles = Array.from(w.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    fs.writeFileSync(process.argv[2], `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style><style>${styles}</style><style>body{margin:0;background:var(--bg)}</style></head><body>${w.document.body.innerHTML}</body></html>`);
  }

  sent.length = 0;
  panel.querySelector('textarea').value = 'Looks good from Design.';
  panel.querySelector('[data-sd="send"]').click();
  await wait(60);
  const post = sent.find((s) => /\/comments$/.test(s.url));
  check('sending posts the comment', post && JSON.parse(post.init.body).body, 'Looks good from Design.');
  pick.value = 'eve@x.com';
  w.document.getElementById('hrms-sd-panel').querySelector('[data-sd="pick"]').value = 'eve@x.com';
  w.document.getElementById('hrms-sd-panel').querySelector('[data-sd="add"]').click();
  await wait(60);
  const add = sent.find((s) => /\/collaborators$/.test(s.url));
  check('adding posts the collaborator', add && JSON.parse(add.init.body).email, 'eve@x.com');
  w.document.querySelector('.hsd-back').click();
  check('backdrop closes the panel', w.document.getElementById('hrms-sd-panel'), null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
