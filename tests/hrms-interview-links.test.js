/* Runs the REAL candidateLink()/isStaleAppLink() out of hrms-interviews.js.
 *
 * The Link column read "Not generated" for interviews whose candidate already
 * had a working link in their inbox: `link` is only filled in by platforms that
 * mint a meeting URL, while the candidate's actual way in is the tokenized
 * /interview-access address — and the token is right there on the row.
 *
 * The other half is worse than missing. The links that WERE stored are
 * http://127.0.0.1:8000/... — whatever host the recruiter's browser happened to
 * be on when the interview was created — so the Copy button handed candidates a
 * link to their own machine. Those are rebased; a genuine meeting URL is not
 * touched, because that is a different link with a different purpose. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

const start = src.indexOf('  /* The candidate\'s interview link.');
const end = src.indexOf("  /* The scheduler's display name.");
if (start < 0 || end < 0) { console.error('could not locate the link helpers'); process.exit(1); }

const ORIGIN = 'https://hr.example.com';
const ctx = { console, location: { origin: ORIGIN } };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) +
  '\nglobalThis.candidateLink = candidateLink; globalThis.isStaleAppLink = isStaleAppLink;', ctx);
const { candidateLink, isStaleAppLink } = ctx;

let pass = 0, fail = 0;
const check = (n, c, got) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + JSON.stringify(got)}`); };

// ── building the candidate's link ───────────────────────────────────────────
check('a token becomes the candidate link',
  candidateLink({ candidateToken: 'abc123' }) === ORIGIN + '/interview-access?token=abc123',
  candidateLink({ candidateToken: 'abc123' }));

check('it is built against the origin being browsed, not a stored host',
  candidateLink({ candidateToken: 'abc123', link: 'http://127.0.0.1:8000/x' }).indexOf(ORIGIN) === 0,
  candidateLink({ candidateToken: 'abc123', link: 'http://127.0.0.1:8000/x' }));

check('a token needing encoding is encoded',
  candidateLink({ candidateToken: 'a b&c=d' }) === ORIGIN + '/interview-access?token=a%20b%26c%3Dd',
  candidateLink({ candidateToken: 'a b&c=d' }));

check('no token means no link to offer', candidateLink({ candidateToken: '' }) === '', candidateLink({ candidateToken: '' }));
check('a whitespace token is not a token', candidateLink({ candidateToken: '   ' }) === '', candidateLink({ candidateToken: '   ' }));
check('a missing interview is handled', candidateLink(null) === '' && candidateLink({}) === '', 'threw or built one');

// ── which stored links are stale ────────────────────────────────────────────
check('a link to this app on another host is stale',
  isStaleAppLink('http://127.0.0.1:8000/interview-access?token=x') === true, 'kept');

check('a recruiter link on another host is stale',
  isStaleAppLink('http://localhost:5173/recruiter-view?token=x') === true, 'kept');

check('the same address on this origin is not stale',
  isStaleAppLink(ORIGIN + '/interview-access?token=x') === false, 'rebased');

// A Teams/Zoom link is the meeting, not the portal — a different link entirely.
check('a real meeting link is left alone',
  isStaleAppLink('https://teams.microsoft.com/l/meetup-join/srikanth-a1b2c3') === false, 'rebased');
check('a zoom link is left alone',
  isStaleAppLink('https://zoom.us/j/9876543210') === false, 'rebased');

check('a non-URL is not stale', isStaleAppLink('teams-srikanth-a1b2c3') === false, 'rebased');
check('an empty link is not stale', isStaleAppLink('') === false && isStaleAppLink(null) === false, 'rebased');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
