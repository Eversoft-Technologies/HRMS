/* Runs the REAL teamRows()/renderTeam()/teamCsv() out of hrms-recruit-kpi.js
   against server-shaped payloads.

   The Team Performance tab is the only place an admin sees per-person numbers,
   and the CSV it exports is the only version of them that leaves the building.
   Three failure modes matter more than the layout: an empty state while
   interviews exist, a search or filter that hides somebody who matches, and an
   export that disagrees with the screen it came from. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  /* ── Team Performance ');
const end = src.indexOf('  function initTeamCharts(d)');
if (start < 0 || end < 0) { console.error('could not locate the team section'); process.exit(1); }

const ctx = {
  console, Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  state: { teamQuery: '', charts: [], teamActiveOnly: false, teamAttr: '', from: '', to: '', scope: 'all', data: null },
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  pct: (v) => v + '%',
  score: (v) => String(v),
  kpiCard: (label, value) => '<card>' + label + ':' + value + '</card>',
  personName: (r) => r.name || String(r.interviewer || '').split('@')[0] || '—',
};
ctx.periodLabel = () => (ctx.state.data && ctx.state.data.period && ctx.state.data.period.label) || 'All time';
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) +
  '\nglobalThis.renderTeam = renderTeam; globalThis.teamRows = teamRows; globalThis.teamCsv = teamCsv;', ctx);
const { renderTeam, teamRows, teamCsv } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + JSON.stringify(got)}`); };
const reset = () => { ctx.state.teamQuery = ''; ctx.state.teamActiveOnly = false;
  ctx.state.teamAttr = ''; ctx.state.from = ''; ctx.state.to = ''; ctx.state.data = null; };

const person = (over) => Object.assign({
  interviewer: 'zeta@x.com', email: 'zeta@x.com', name: 'Zeta Recruiter', attributed: true,
  drillable: true, total: 5, selected: 2, rejected: 1, pending: 2, completed: 3, invited: 5,
  shortlistRate: 40, avgScore: 71.5, lastAt: '2026-08-14',
}, over || {});

const quiet = person({
  interviewer: 'quiet@x.com', email: 'quiet@x.com', name: 'Quiet Colleague', total: 0,
  selected: 0, rejected: 0, pending: 0, completed: 0, invited: 0, shortlistRate: 0,
  avgScore: 0, lastAt: null,
});

// ── interviews exist, nobody is credited (the state the screenshot showed) ──
reset();
const orphan = {
  recruiterStats: [{
    interviewer: '', email: '', name: 'Unattributed', attributed: false, drillable: false,
    total: 31, selected: 0, rejected: 0, pending: 31, completed: 0, invited: 4,
    shortlistRate: 0, avgScore: 0, lastAt: '2026-08-12',
  }],
};
let html = renderTeam(orphan);
check('unattributed interviews are not reported as "no data"', !/No recruiter data found/.test(html), html.slice(0, 120));
check('it says how many are uncredited', /31 interviews/.test(html), html.slice(0, 400));
check('it explains why they are uncredited', /scheduled before the creator was recorded/.test(html), '');
check('the count is still shown in a row', /<td style="font-weight:700">31<\/td>/.test(html), '');
check('an uncredited row is not click-to-drill', !/data-kact="drill-recruiter"/.test(html), 'row is drillable');

// a listed-but-idle team must not suppress that banner
reset();
html = renderTeam({ recruiterStats: [quiet, orphan.recruiterStats[0]] });
check('listing idle accounts does not hide the "nobody credited" banner',
  /Nobody is credited yet/.test(html), html.slice(0, 200));
check('the banner counts only what nobody is credited for', /31 interviews/.test(html), '');

// ── the normal state ────────────────────────────────────────────────────────
reset();
const full = { recruiterStats: [person(), person({
  interviewer: 'yara@x.com', email: 'yara@x.com', name: 'Yara Viewer', total: 3, selected: 0,
  rejected: 2, pending: 1, completed: 2, invited: 3, shortlistRate: 0, avgScore: 55, lastAt: '2026-08-10',
})] };
html = renderTeam(full);
check('every person gets a row', (html.match(/kpi-person-row/g) || []).length === 2, html.match(/kpi-person-row/g));
check('rows are click-to-drill', /data-kact="drill-recruiter" data-val="zeta@x.com"/.test(html), '');
check('scheduled count is shown', /<td style="font-weight:700">5<\/td>/.test(html), '');
check('the extra analysis columns render', /Invited/.test(html) && /Completed/.test(html)
  && /Awaiting outcome/.test(html) && /Last scheduled/.test(html), '');
check('a search box is offered', /data-kact="team-search"/.test(html), '');
check('a download is offered', /data-kact="team-download"/.test(html), '');
check('the period is stated on the report', /kpi-period">All time/.test(html), '');
check('totals count only people with activity', /<card>People Credited:2<\/card>/.test(html), html.match(/<card>[^<]*<\/card>/g));

// ── search ──────────────────────────────────────────────────────────────────
ctx.state.teamQuery = 'yara';
check('search matches on name', teamRows(full).length === 1 && teamRows(full)[0].name === 'Yara Viewer', teamRows(full));
ctx.state.teamQuery = 'ZETA@X.COM';
check('search matches on email, case-insensitively', teamRows(full).length === 1
  && teamRows(full)[0].email === 'zeta@x.com', teamRows(full));
ctx.state.teamQuery = 'recruiter';
check('search matches a partial name', teamRows(full).length === 1, teamRows(full));
ctx.state.teamQuery = '  ';
check('a blank search shows everybody', teamRows(full).length === 2, teamRows(full));
ctx.state.teamQuery = 'nobody';
html = renderTeam(full);
check('a search with no hits says so, and keeps the box', /Nobody matches/.test(html)
  && /data-kact="team-search"/.test(html), html.slice(-300));
check('the miss message is escaped', !/Nobody matches “<b>/.test(renderTeam(full)), '');
ctx.state.teamQuery = 'zeta';
check('a filtered table reports what it is hiding', /Showing 1 of 2/.test(renderTeam(full)), '');

// ── "with activity only" ────────────────────────────────────────────────────
reset();
const withQuiet = { recruiterStats: [person(), quiet] };
check('every account is listed by default, including idle ones',
  teamRows(withQuiet).length === 2, teamRows(withQuiet).length);
check('an idle colleague is still named', /Quiet Colleague/.test(renderTeam(withQuiet)), '');
ctx.state.teamActiveOnly = true;
check('the activity filter hides people with nothing scheduled',
  teamRows(withQuiet).length === 1 && teamRows(withQuiet)[0].total === 5, teamRows(withQuiet));
check('"People Credited" ignores idle accounts',
  /<card>People Credited:1<\/card>/.test(renderTeam(withQuiet)), renderTeam(withQuiet).match(/<card>[^<]*<\/card>/g));

// ── attribution filter ──────────────────────────────────────────────────────
reset();
const mixed = { recruiterStats: [person(), orphan.recruiterStats[0]] };
check('everyone is shown by default', teamRows(mixed).length === 2, teamRows(mixed).length);
ctx.state.teamAttr = 'credited';
check('"credited only" drops the uncredited bucket',
  teamRows(mixed).length === 1 && teamRows(mixed)[0].attributed === true, teamRows(mixed));
ctx.state.teamAttr = 'uncredited';
check('"not credited" keeps only what nobody is credited for',
  teamRows(mixed).length === 1 && teamRows(mixed)[0].attributed === false, teamRows(mixed));
ctx.state.teamAttr = '';
html = renderTeam(mixed);
check('the attribution filter is offered', /data-kact="team-attr"/.test(html), '');
check('the report period dates are offered',
  /data-kact="team-from"/.test(html) && /data-kact="team-to"/.test(html), '');
check('no Clear button until a date is set', !/team-clear-dates/.test(html), '');
ctx.state.from = '2026-07-01';
check('a set date offers a way back', /team-clear-dates/.test(renderTeam(mixed)), '');
check('the chosen date is shown in the box',
  /data-kact="team-from" title="From" value="2026-07-01"/.test(renderTeam(mixed)), '');

// ── CSV export ──────────────────────────────────────────────────────────────
reset();
ctx.state.data = Object.assign({ period: { label: '2026-07-01 to 2026-07-31' } }, full);
let csv = teamCsv();
check('the export names the period it covers',
  csv.indexOf('Period,2026-07-01 to 2026-07-31') !== -1, csv.split('\r\n')[1]);
check('the export has a header row',
  /Person,Email,Scheduled,Invited,Completed,Selected,Rejected,Awaiting outcome/.test(csv), '');
check('the export carries one line per person',
  csv.split('\r\n').filter((l) => /^(Zeta|Yara)/.test(l)).length === 2, csv);
check('figures survive the export',
  /Zeta Recruiter,zeta@x\.com,5,5,3,2,1,2,40,71\.5,2026-08-14,credited/.test(csv), csv);

ctx.state.teamQuery = 'yara';
csv = teamCsv();
check('the export matches what the table is showing',
  csv.indexOf('Zeta Recruiter') === -1 && csv.indexOf('Yara Viewer') !== -1, csv);
check('the export records the search that shaped it', /Search,yara/.test(csv), csv);

reset();
ctx.state.data = Object.assign({ period: { label: 'All time' } }, full);
ctx.state.teamAttr = 'credited';
check('the export records the attribution filter',
  /Attribution,credited interviews only/.test(teamCsv()), teamCsv());
ctx.state.teamAttr = '';

// A cell starting with = + - or @ is run as a formula by Excel and Sheets.
reset();
ctx.state.data = { period: { label: 'All time' }, recruiterStats: [person({ name: '=cmd|calc' })] };
check('a name that looks like a formula is neutralised', teamCsv().indexOf("'=cmd|calc") !== -1, teamCsv());

ctx.state.data = { period: { label: 'All time' }, recruiterStats: [person({ name: 'Smith, Jane "JJ"' })] };
csv = teamCsv();
check('commas and quotes in a name are escaped',
  csv.indexOf('"Smith, Jane ""JJ"""') !== -1, csv);

// ── nothing at all ──────────────────────────────────────────────────────────
reset();
check('an empty range says the range is empty',
  /No interviews in this time range/.test(renderTeam({ recruiterStats: [] })), '');
check('my-view still explains the tab needs org scope', /Switch to Org View/.test(renderTeam({})), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
