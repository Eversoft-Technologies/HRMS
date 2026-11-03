/**
 * hrms-company.js
 * ---------------------------------------------------------------------------
 * Makes Settings > General apply to the whole app.
 *
 * The General page (hrms-company-settings.js) saves company details, but
 * nothing else used to read them: the sidebar brand, the currency symbol,
 * the date format, the work week and the employee-ID format were all
 * hard-coded, and the business timezone only lived on the server.
 *
 * This sidecar loads the public company block from GET /api/config (cached
 * in localStorage for an instant first paint), applies the brand to the
 * sidebar and the page title, and exposes window.HRMSCompany so the other
 * overlays format money, dates, employee codes and the live clock the way
 * the settings say. Saving the General page fires 'hrmsCompanyUpdated';
 * this file re-applies and then fires 'hrmsCompanyApplied' so pages that
 * are open can re-render without a reload. No bundle rebuild.
 */
(function () {
  'use strict';
  if (window.HRMSCompany) return;

  var KEY = 'hrms_company';
  var DEFAULTS = {
    companyName: '', brandName: '', companyLogo: '', timezone: '',
    currency: 'INR', dateFormat: 'DD/MM/YYYY',
    workWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    empIdPrefix: 'EV-', empIdMinDigits: 4, empIdSuffix: ''
  };
  var SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', SGD: 'S$', AUD: 'A$', CAD: 'C$', JPY: '¥' };
  var LOCALES = { INR: 'en-IN', USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', AED: 'en-AE', SGD: 'en-SG', AUD: 'en-AU', CAD: 'en-CA', JPY: 'ja-JP' };
  var DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var current = Object.assign({}, DEFAULTS, loadCache());
  var originalTitle = (typeof document !== 'undefined' && document.title) || 'HRMS';

  function loadCache() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return (v && typeof v === 'object') ? v : {}; }
    catch (_) { return {}; }
  }
  function saveCache() { try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (_) {} }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ── values ─────────────────────────────────────────────────────────────── */
  function get() { return current; }
  function set(data) {
    var next = Object.assign({}, DEFAULTS, current);
    Object.keys(data || {}).forEach(function (k) { if (data[k] !== undefined && data[k] !== null) next[k] = data[k]; });
    if (!Array.isArray(next.workWeek) || !next.workWeek.length) next.workWeek = DEFAULTS.workWeek.slice();
    next.empIdMinDigits = parseInt(next.empIdMinDigits, 10) || DEFAULTS.empIdMinDigits;
    current = next;
    saveCache();
    (window.__HRMS_CONFIG__ = window.__HRMS_CONFIG__ || {}).company = current;
    apply();
    try { window.dispatchEvent(new CustomEvent('hrmsCompanyApplied', { detail: current })); } catch (_) {}
  }
  function refresh() {
    return fetch('/api/config', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) { if (cfg && cfg.company && typeof cfg.company === 'object') set(cfg.company); })
      .catch(function () {});
  }

  /* ── money ──────────────────────────────────────────────────────────────── */
  function code() { return String(current.currency || 'INR').toUpperCase(); }
  function symbol() { var c = code(); return SYMBOLS[c] || (c + ' '); }
  function money(value, opts) {
    opts = opts || {};
    var v = Number(value);
    if (!isFinite(v)) return opts.blank != null ? opts.blank : '—';
    var d = opts.decimals != null ? opts.decimals : 0;
    try { return symbol() + v.toLocaleString(LOCALES[code()] || 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
    catch (_) { return symbol() + v.toFixed(d); }
  }

  /* ── dates ──────────────────────────────────────────────────────────────── */
  // Server strings are 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' in the business
  // timezone; they are read as wall-clock values, never shifted.
  function parseDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    var s = String(value == null ? '' : value).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }
  function hasTime(value) { return /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(value || '')) || value instanceof Date; }
  function date(value, opts) {
    opts = opts || {};
    var d = parseDate(value);
    if (!d) return value == null ? '' : String(value);
    var map = { YYYY: String(d.getFullYear()), MMM: MONTHS[d.getMonth()], MM: pad(d.getMonth() + 1), DD: pad(d.getDate()) };
    var out = String(current.dateFormat || DEFAULTS.dateFormat).replace(/YYYY|MMM|MM|DD/g, function (tok) { return map[tok]; });
    if (opts.time === true || (opts.time !== false && hasTime(value) && !(value instanceof Date))) {
      out += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    return out;
  }

  /* ── employee codes / work week ─────────────────────────────────────────── */
  function empId(n) {
    var digits = parseInt(current.empIdMinDigits, 10) || 4;
    var body = String(n == null ? '' : n);
    while (body.length < digits) body = '0' + body;
    return (current.empIdPrefix != null ? current.empIdPrefix : 'EV-') + body + (current.empIdSuffix || '');
  }
  function workWeek() { return Array.isArray(current.workWeek) ? current.workWeek : DEFAULTS.workWeek; }
  function isWorkDay(d) {
    if (!(d instanceof Date)) d = parseDate(d);
    if (!d) return false;
    var days = workWeek().map(function (x) { return String(x).slice(0, 3).toLowerCase(); });
    return days.indexOf(DAYS[d.getDay()].toLowerCase()) !== -1;
  }

  /* ── timezone ───────────────────────────────────────────────────────────── */
  function timezone() { return String(current.timezone || '').trim(); }
  function browserZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }
  function parts(dateObj, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var out = {};
    f.formatToParts(dateObj || new Date()).forEach(function (p) { out[p.type] = p.value; });
    if (out.hour === '24') out.hour = '00';
    return out;
  }
  function tzUsable() { var tz = timezone(); if (!tz) return false; try { parts(new Date(), tz); return true; } catch (_) { return false; } }
  // Does the business clock differ from this browser's clock right now?
  function tzDiffers() {
    if (!tzUsable()) return false;
    var tz = timezone(), bz = browserZone();
    if (bz && bz === tz) return false;
    try {
      var now = new Date(), a = parts(now, tz), b = parts(now, bz || undefined);
      return a.hour !== b.hour || a.minute !== b.minute || a.day !== b.day;
    } catch (_) { return false; }
  }
  function timeString(dateObj) { if (!tzUsable()) { var d = dateObj || new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); } var p = parts(dateObj, timezone()); return p.hour + ':' + p.minute + ':' + p.second; }
  function dateString(dateObj) {
    if (!tzUsable()) return (dateObj || new Date()).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    var p = parts(dateObj, timezone());
    return p.weekday + ', ' + p.month + ' ' + p.day + ', ' + p.year;
  }

  /* ── brand on the shell ─────────────────────────────────────────────────── */
  function apply() {
    if (typeof document === 'undefined' || !document.body) return;
    var brand = String(current.brandName || '').trim();
    var texts = document.querySelectorAll('.sidebar .logo-text');
    for (var i = 0; i < texts.length; i++) {
      var want = brand || 'HRMS';
      if (texts[i].textContent !== want) texts[i].textContent = want;
    }
    var imgs = document.querySelectorAll('.sidebar .logo-icon img');
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      if (!img.getAttribute('data-hrms-logo-src')) img.setAttribute('data-hrms-logo-src', img.getAttribute('src') || '');
      var want2 = current.companyLogo || img.getAttribute('data-hrms-logo-src') || '';
      if (want2 && img.getAttribute('src') !== want2) img.setAttribute('src', want2);
      if (current.companyName) img.alt = current.companyName;
    }
    var name = String(current.companyName || '').trim();
    var title = name ? name + ' · HRMS' : originalTitle;
    if (document.title !== title) document.title = title;
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { queued = false; apply(); });
  }
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (t && t.closest && t.closest('.sidebar .logo')) { schedule(); return; }
        if (muts[i].addedNodes.length) { schedule(); return; }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.addEventListener('hrmsCompanyUpdated', function (e) { set((e && e.detail) || {}); });
  window.addEventListener('storage', function (e) { if (e.key === KEY) { current = Object.assign({}, DEFAULTS, loadCache()); apply(); } });
  window.addEventListener('popstate', schedule);

  (window.__HRMS_CONFIG__ = window.__HRMS_CONFIG__ || {}).company = current;
  function boot() { apply(); refresh(); }
  if (typeof document !== 'undefined' && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(refresh, 10 * 60 * 1000);

  window.HRMSCompany = {
    get: get, set: set, refresh: refresh, apply: apply,
    money: money, symbol: symbol,
    date: date, parseDate: parseDate,
    empId: empId, workWeek: workWeek, isWorkDay: isWorkDay,
    timezone: timezone, tzDiffers: tzDiffers, timeString: timeString, dateString: dateString
  };
})();
