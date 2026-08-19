/* Runs the REAL scheduledBy()/rowHtml() out of hrms-interviews.js.
 *
 * The line these produce is the only place in the product that says who
 * scheduled an interview. Two failure modes matter more than the layout: a row
 * that shows nothing when the creator IS recorded (the attribution work becomes
 * invisible), and a row that shows a name when nobody was recorded (an invented
 * recruiter is indistinguishable from a real one, and the KPI report credits
 * that same field). */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  /* Who scheduled this interview');
const end = src.indexOf('  function toolbarHtml(kind)');
if (start < 0 || end < 0) { console.error('could not locate the row section'); process.exit(1); }

const ctx = {
  console,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  initialsOf: () => 'XX',
  badgeClass: () => 'blue',
  PENCIL: '<svg/>',
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + '\nglobalThis.scheduledBy = scheduledBy; globalThis.rowHtml = rowHtml;', ctx);
const { scheduledBy, rowHtml } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + JSON.stringify(got)}`); };

// ── the name the server resolved from the account wins ──────────────────────
check('the recorded creator is named',
  scheduledBy({ createdByName: 'Mourya', createdByEmail: 'mourya123@gmail.com' }) === ' · by Mourya',
  scheduledBy({ createdByName: 'Mourya', createdByEmail: 'mourya123@gmail.com' }));

check('an account with no full name falls back to the email handle',
  scheduledBy({ createdByName: '', createdByEmail: 'sree.k@example.com' }) === ' · by sree.k',
  scheduledBy({ createdByName: '', createdByEmail: 'sree.k@example.com' }));

check('whitespace does not pass for a name',
  scheduledBy({ createdByName: '   ', createdByEmail: 'sri@example.com' }) === ' · by sri',
  scheduledBy({ createdByName: '   ', createdByEmail: 'sri@example.com' }));

// ── nothing recorded means nothing shown ────────────────────────────────────
check('an interview with no creator names nobody',
  scheduledBy({ createdByName: '', createdByEmail: '', interviewer: '' }) === '',
  scheduledBy({ createdByName: '', createdByEmail: '', interviewer: '' }));

check('missing fields entirely name nobody', scheduledBy({}) === '', scheduledBy({}));

// ── the legacy free-text box is a last resort, not a first choice ───────────
check('a typed interviewer is used only when no creator was recorded',
  scheduledBy({ interviewer: 'HR Team' }) === ' · by HR Team',
  scheduledBy({ interviewer: 'HR Team' }));

check('a recorded creator outranks the typed interviewer',
  scheduledBy({ createdByName: 'Mourya', interviewer: 'HR Team' }) === ' · by Mourya',
  scheduledBy({ createdByName: 'Mourya', interviewer: 'HR Team' }));

// ── escaping: the name reaches the DOM as text ──────────────────────────────
const nasty = scheduledBy({ createdByName: '<img src=x onerror=alert(1)>' });
check('the name is escaped', nasty.indexOf('<img') === -1 && nasty.indexOf('&lt;img') !== -1, nasty);

// ── both lists carry it ─────────────────────────────────────────────────────
const iv = { name: 'A Candidate', role: 'QA Engineer', interviewDate: '2026-09-01',
             createdByName: 'Mourya', id: 7 };
check('upcoming rows show the scheduler', rowHtml('up', iv).indexOf('by Mourya') !== -1, rowHtml('up', iv));
check('completed rows show the scheduler', rowHtml('done', iv).indexOf('by Mourya') !== -1, rowHtml('done', iv));
check('the candidate is still the headline',
  /hrms-iv-nm">A Candidate</.test(rowHtml('up', iv)), rowHtml('up', iv));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
