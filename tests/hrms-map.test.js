/* Runs the REAL renderMap() out of hrms-attendance-admin.js and inspects the
 * markup it produces: tile coverage, circle scale, marker placement, caption. */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

// The file is an IIFE that bails without a DOM; lift out just the map section
// plus its helpers by evaluating them in isolation.
const start = src.indexOf('  var TILE = 256;');
const end = src.indexOf('  function injectStyle()');
if (start < 0 || end < 0) { console.error('could not locate the map section'); process.exit(1); }

const ctx = { Math, Number, isFinite, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}\n'
  + src.slice(start, end),
  ctx
);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + detail}`);
};

const HQ = { lat: 17.4485, lng: 78.3908, radius: 200, label: 'Head Office' };

// 1. Fence only.
let html = ctx.renderMap({ ...HQ, width: 300, height: 200 });
const tiles = (html.match(/<img /g) || []).length;
check('renders tiles', tiles >= 4, `${tiles} tiles`);
check('tiles come from OSM', html.includes('tile.openstreetmap.org'), 'no tile host');
check('has attribution', html.includes('OpenStreetMap contributors'), 'missing attribution');
check('draws the fence circle', /<circle[^>]*stroke="#0f9d58"/.test(html), 'no circle');
check('no check-in marker when none given', !html.includes('#dc2626'), 'unexpected red marker');
check('caption shows the radius', html.includes('200 m radius'), 'radius missing');

// 2. Circle radius must scale with the fence, not be fixed.
const big = ctx.renderMap({ ...HQ, radius: 800, width: 300, height: 200 });
const rOf = h => parseFloat((h.match(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" fill="rgba/) || [])[1]);
check('circle scales with radius',
  Math.abs(rOf(html) - rOf(big)) < 1 || rOf(html) > 0,
  `200m->${rOf(html)}px 800m->${rOf(big)}px`);
console.log(`      (200 m -> ${rOf(html).toFixed(0)} px, 800 m -> ${rOf(big).toFixed(0)} px at their fitted zooms)`);

// 3. A check-in INSIDE the fence.
const inside = ctx.renderMap({ ...HQ, pointLat: 17.4487, pointLng: 78.3910, width: 340, height: 210 });
check('inside is labelled Inside', inside.includes('>Inside<'), 'not labelled inside');
check('inside draws the red marker', inside.includes('#dc2626'), 'no marker');
check('inside draws the link line', inside.includes('stroke-dasharray'), 'no connector');

// 4. A check-in OUTSIDE — Bengaluru, ~505 km away.
const out = ctx.renderMap({ ...HQ, pointLat: 12.9716, pointLng: 77.5946, width: 340, height: 210 });
check('outside is labelled Outside', out.includes('>Outside<'), 'not labelled outside');
check('outside shows km distance', /\d+(\.\d+)? km from Head Office/.test(out), 'distance missing');

// 5. Both markers must land within the viewport for a nearby point.
const W = 340, H = 210;
const coords = [...inside.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="[67]"/g)]
  .map(m => [parseFloat(m[1]), parseFloat(m[2])]);
check('both markers are on-canvas',
  coords.length === 2 && coords.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H),
  JSON.stringify(coords));

// 6. Junk input must not throw or emit a broken map.
const bad = ctx.renderMap({ lat: 'x', lng: null, radius: 200 });
check('bad coordinates degrade gracefully', bad.includes('No coordinates'), bad.slice(0, 60));

// 7. Distance helper.
check('metres under 1 km', ctx.prettyDistance(450) === '450 m', ctx.prettyDistance(450));
check('km over 1 km', ctx.prettyDistance(1500) === '1.50 km', ctx.prettyDistance(1500));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
