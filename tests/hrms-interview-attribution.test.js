/* Runs the REAL linkRowCreator()/creatorOf()/findByEmail() out of
 * hrms-interviews.js.
 *
 * The "Created By" column is grafted onto a React-owned table, so every row has
 * to be matched back to /api/interviews by hand. The dangerous failure is not a
 * missing name, it is a WRONG one: the same candidate is routinely interviewed
 * twice for different roles, and matching on the displayed name would credit
 * one recruiter's work to another. These cases pin the matching key and the
 * fallbacks around it.
 *
 * The DOM grafting itself (inserting the th/td, and doing it once per repaint)
 * is not covered here — there is no DOM implementation available to this
 * runner, and a hand-written stub would prove only that the stub agrees with
 * itself. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  function findByEmail(email)');
const end = src.indexOf('  /* ── the create form says who is scheduling');
if (start < 0 || end < 0) { console.error('could not locate the attribution helpers'); process.exit(1); }

// Only the pure helpers are wanted; the DOM function in between is defined but
// never called, so it just needs its references to resolve.
const ctx = {
  console, DATA: [],
  esc: (s) => String(s == null ? '' : s),
  cardByTitle: () => null,
  loaded: true,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) +
  '\nglobalThis.linkRowCreator = linkRowCreator; globalThis.creatorOf = creatorOf;' +
  '\nglobalThis.findByEmail = findByEmail;', ctx);
const { linkRowCreator, creatorOf, findByEmail } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + JSON.stringify(got)}`); };

// The cell renders the candidate's name above their email, so its textContent
// is the two run together exactly like this.
const cell = (name, email) => name + email;

ctx.DATA = [
  { id: 1, name: 'srikanth', email: 'srikanth@cand.test', role: 'data analyst',
    createdByName: 'Mourya', createdByEmail: 'mourya@x.com' },
  { id: 2, name: 'srikanth', email: 'srikanth.b@cand.test', role: 'data engineer',
    createdByName: 'Sree', createdByEmail: 'sree@x.com' },
  { id: 3, name: 'legacy', email: 'legacy@cand.test', role: 'qa',
    createdByName: '', createdByEmail: '', interviewer: '' },
  { id: 4, name: 'handle', email: 'handle@cand.test', role: 'qa',
    createdByName: '', createdByEmail: 'no.name@x.com', interviewer: '' },
  { id: 5, name: 'typed', email: 'typed@cand.test', role: 'qa',
    createdByName: '', createdByEmail: '', interviewer: 'HR Team' },
];

// ── the matching key ────────────────────────────────────────────────────────
check('a row is credited to whoever scheduled it',
  linkRowCreator(cell('srikanth', 'srikanth@cand.test')) === 'Mourya',
  linkRowCreator(cell('srikanth', 'srikanth@cand.test')));

check('the same candidate name twice does not cross-credit',
  linkRowCreator(cell('srikanth', 'srikanth.b@cand.test')) === 'Sree',
  linkRowCreator(cell('srikanth', 'srikanth.b@cand.test')));

check('matching ignores case in the email',
  linkRowCreator(cell('srikanth', 'SRIKANTH@CAND.TEST')) === 'Mourya',
  linkRowCreator(cell('srikanth', 'SRIKANTH@CAND.TEST')));

check('a row whose candidate is unknown credits nobody',
  linkRowCreator(cell('stranger', 'stranger@cand.test')) === '', 'named someone');

check('a cell with no email credits nobody',
  linkRowCreator('srikanth') === '', 'named someone');

check('an empty cell is handled', linkRowCreator('') === '' && linkRowCreator(null) === '', 'threw or named someone');

// One address can be a tail of another, and the cell gives no word boundary to
// lean on, so the longer match has to win or the wrong row is credited.
ctx.DATA.push(
  { id: 6, name: 'short', email: 'a@x.test', createdByName: 'Short Owner' },
  { id: 7, name: 'long', email: 'ba@x.test', createdByName: 'Long Owner' });
check('a candidate whose email ends with another one is credited correctly',
  linkRowCreator(cell('long', 'ba@x.test')) === 'Long Owner',
  linkRowCreator(cell('long', 'ba@x.test')));
check('the shorter address still resolves to its own row',
  linkRowCreator(cell('short', 'a@x.test')) === 'Short Owner',
  linkRowCreator(cell('short', 'a@x.test')));

// ── the fallbacks ───────────────────────────────────────────────────────────
check('an interview with no creator recorded names nobody',
  linkRowCreator(cell('legacy', 'legacy@cand.test')) === '', 'named someone');

check('an account with no display name falls back to the email handle',
  linkRowCreator(cell('handle', 'handle@cand.test')) === 'no.name',
  linkRowCreator(cell('handle', 'handle@cand.test')));

check('the typed interviewer is the last resort',
  linkRowCreator(cell('typed', 'typed@cand.test')) === 'HR Team',
  linkRowCreator(cell('typed', 'typed@cand.test')));

check('a recorded creator outranks the typed interviewer',
  creatorOf({ createdByName: 'Mourya', interviewer: 'HR Team' }) === 'Mourya',
  creatorOf({ createdByName: 'Mourya', interviewer: 'HR Team' }));

check('whitespace does not pass for a name',
  creatorOf({ createdByName: '   ', createdByEmail: 'sri@x.com' }) === 'sri',
  creatorOf({ createdByName: '   ', createdByEmail: 'sri@x.com' }));

check('an interview with nothing at all yields an empty label',
  creatorOf({}) === '', creatorOf({}));

// ── the lookup itself ───────────────────────────────────────────────────────
check('findByEmail returns the right row', (findByEmail('srikanth.b@cand.test') || {}).id === 2,
  findByEmail('srikanth.b@cand.test'));
check('findByEmail on an empty string finds nothing', findByEmail('') === null, findByEmail(''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
