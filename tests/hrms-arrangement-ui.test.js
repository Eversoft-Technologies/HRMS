/* Runs the REAL describeArrangement() out of hrms-attendance-admin.js.
 *
 * This one line of the admin table is the only place an approver sees what an
 * arrangement actually entitles someone to. If it says "2 remote days a week"
 * for a row whose anchor days are what really apply, the person reading it
 * makes the wrong call and nothing else in the system contradicts them. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  var WEEKDAYS = ');
const end = src.indexOf('  function arrangementsHtml()');
if (start < 0 || end < 0) { console.error('could not locate the arrangement section'); process.exit(1); }

const ctx = { console, state: { roster: [], arrangements: [], errors: {} } };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){'
  + 'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}\n'
  + src.slice(start, end)
  + '\nglobalThis.d = describeArrangement; globalThis.p = arrangementPill;'
  + '\nglobalThis.picker = employeePicker;',
  ctx);
const { d, p, picker } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + got}`); };

// Anchor days must be named, not counted — "2 days a week" would imply the
// employee chooses, which is exactly what anchor days deny.
{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [0, 4], remoteDaysPerWeek: 0 });
  check('anchor days are listed by name', s === 'Remote on Mon, Fri', s);
}
{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [2], remoteDaysPerWeek: 0 });
  check('a single anchor day reads correctly', s === 'Remote on Wed', s);
}

// Anchor days win over a stale quota — matching the server rule exactly. A UI
// that showed the quota here would contradict what the gate actually enforces.
{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [0, 4], remoteDaysPerWeek: 3 });
  check('anchor days win over a leftover quota', s === 'Remote on Mon, Fri', s);
}

{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [], remoteDaysPerWeek: 2 });
  check('a quota says the employee picks', /2 remote days a week, employee picks/.test(s), s);
}
{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [], remoteDaysPerWeek: 1 });
  check('one day is not pluralised', /1 remote day a week/.test(s) && !/1 remote days/.test(s), s);
}

// The server refuses to create this, but a row written before that check (or
// straight into the table) must not render as a confident blank.
{
  const s = d({ arrangement: 'hybrid', remoteWeekdays: [], remoteDaysPerWeek: 0 });
  check('a hybrid row with no entitlement says so', /no remote days allocated/.test(s), s);
}

{
  check('remote is unrestricted',
    d({ arrangement: 'remote' }) === 'Any day, anywhere', d({ arrangement: 'remote' }));
  check('onsite claims no remote entitlement',
    d({ arrangement: 'onsite' }) === 'Office only', d({ arrangement: 'onsite' }));
  check('a missing arrangement is "Not set", never blank',
    /Not set/.test(d(null)), d(null));
}

// Every weekday index must map to the right label — an off-by-one here would
// quietly move someone's remote day.
{
  const names = [0, 1, 2, 3, 4, 5, 6].map(i =>
    d({ arrangement: 'hybrid', remoteWeekdays: [i] }).replace('Remote on ', ''));
  check('weekday indices map Mon..Sun in order',
    names.join(',') === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', names.join(','));
}

// The pill is the at-a-glance signal; the three states must stay distinct.
{
  const pills = ['onsite', 'hybrid', 'remote'].map(p);
  const colours = pills.map(h => (h.match(/background:([^"]+)/) || [])[1]);
  check('each arrangement gets its own pill colour',
    new Set(colours).size === 3, colours.join(' | '));
  check('the pill is capitalised', /Remote/.test(pills[2]), pills[2]);
}

// ── the employee picker ───────────────────────────────────────────────
// Typing an email is how an arrangement gets attached to a typo: the API keys
// on the string, so a misspelt address creates a valid arrangement for nobody
// while the real person keeps being refused.
{
  ctx.state.roster = [
    { email: 'ravi@x.com', name: 'Ravi Kumar' },
    { email: 'priya@x.com', name: 'Priya S' },
  ];
  ctx.state.arrangements = [{ email: 'priya@x.com', arrangement: 'hybrid' }];
  const html = picker();

  check('a loaded roster renders a select', /^<select/.test(html), html.slice(0, 40));
  check('every employee is offered',
    /ravi@x\.com/.test(html) && /priya@x\.com/.test(html), html);
  check('options show the name, not just the address',
    /Ravi Kumar \(ravi@x\.com\)/.test(html), html);
  check('the placeholder option has no value, so it fails the required check',
    /<option value="">/.test(html), html);
  check('someone with an existing arrangement is marked',
    /Priya S \(priya@x\.com\).*hybrid/.test(html), html);
  check('someone without one is not marked',
    !/Ravi Kumar \(ravi@x\.com\)  · /.test(html), html);
}

// An empty dropdown is a dead end; a roster failure must not block the form.
{
  ctx.state.roster = [];
  ctx.state.errors = { roster: 'HTTP 500' };
  const html = picker();
  check('an unavailable roster falls back to a text input',
    /^<input/.test(html), html.slice(0, 40));
  check('and says why', /unavailable/.test(html), html);
}
{
  ctx.state.roster = [];
  ctx.state.errors = {};
  check('an empty roster with no error falls back quietly',
    /^<input/.test(picker()) && !/unavailable/.test(picker()), picker());
}

// A name carrying a quote or bracket must not break out of the option tag.
{
  ctx.state.roster = [{ email: 'x@x.com', name: 'A"B<script>' }];
  ctx.state.arrangements = [];
  const html = picker();
  check('employee names are escaped',
    !/<script>/.test(html) && /&lt;script&gt;/.test(html), html);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
