/* Drives the picker's projection the way its event handlers do, so a pan or a
 * click that lands in the wrong place shows up here rather than in production. */
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const s = src.indexOf('  var TILE = 256;'), e = src.indexOf('  function injectStyle()');
const ctx = { Math, Number, isFinite, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('function esc(x){return x}\n' + src.slice(s, e), ctx);
const { lngToWorldX, latToWorldY, worldXToLng, worldYToLat, metersPerPixel, haversine } = ctx;

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`); };

const Z = 17, W = 800, H = 400;
let lat = 13.4, lng = 79.7386;

// A drag of dx,dy must move the centre by exactly that many pixels of ground.
const dx = 120, dy = -80;
const nLng = worldXToLng(lngToWorldX(lng, Z) - dx, Z);
const nLat = worldYToLat(latToWorldY(lat, Z) - dy, Z);
const mpp = metersPerPixel(lat, Z);
const movedM = haversine(lat, lng, nLat, nLng);
const expectM = Math.hypot(dx, dy) * mpp;
check('pan distance matches the pixels dragged',
  Math.abs(movedM - expectM) / expectM < 0.02, `${movedM.toFixed(1)}m vs ${expectM.toFixed(1)}m`);
check('pan right moves the centre west', nLng < lng, `${nLng} !< ${lng}`);
// Dragging up reveals what lies below, so the centre travels south - the
// same convention as dragging right moving the centre west.
check('dragging up moves the view south', nLat < lat, `${nLat} !< ${lat}`);

// Clicking the exact centre of the canvas must not move anything.
const cLng = worldXToLng(lngToWorldX(lng, Z) - W / 2 + W / 2, Z);
const cLat = worldYToLat(latToWorldY(lat, Z) - H / 2 + H / 2, Z);
check('click at centre is a no-op', Math.abs(cLat - lat) < 1e-9 && Math.abs(cLng - lng) < 1e-9,
  `${cLat},${cLng}`);

// Clicking 200 px right / 100 px down lands the expected distance away.
const pLng = worldXToLng(lngToWorldX(lng, Z) - W / 2 + (W / 2 + 200), Z);
const pLat = worldYToLat(latToWorldY(lat, Z) - H / 2 + (H / 2 + 100), Z);
const clickM = haversine(lat, lng, pLat, pLng);
check('click offset maps to the right ground distance',
  Math.abs(clickM - Math.hypot(200, 100) * mpp) / clickM < 0.02, `${clickM.toFixed(1)} m`);
check('click right goes east', pLng > lng, `${pLng}`);
check('click down goes south', pLat < lat, `${pLat}`);

// Zooming in halves the ground each pixel covers.
check('zoom doubles resolution',
  Math.abs(metersPerPixel(lat, Z) / metersPerPixel(lat, Z + 1) - 2) < 1e-9, 'not 2x');

// 6 dp is what the picker writes; confirm it is sub-metre and 1 dp is not.
const step6 = haversine(lat, lng, lat + 1e-6, lng);
const step1 = haversine(lat, lng, lat + 0.1, lng);
check('6 dp is sub-metre', step6 < 1, `${step6.toFixed(3)} m`);
check('1 dp is kilometres out', step1 > 10000, `${step1.toFixed(0)} m`);
console.log(`      (6 dp = ${step6.toFixed(2)} m, 1 dp = ${(step1/1000).toFixed(1)} km)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
