/*
 * Careers job widget.
 *
 *   <div id="eversoft-jobs"></div>
 *   <script src="https://<hrms-host>/careers/widget.js" data-department="Engineering"
 *           data-limit="10" async></script>
 *
 * Options (data-* on the script tag):
 *   data-target      CSS selector of the container (default #eversoft-jobs; created after the script if missing)
 *   data-department  data-location  data-type  data-remote ("1" / "0")  data-q   filters
 *   data-limit       max jobs (default 10, max 100)
 *   data-apply       "link" (default: open the job on the careers site) or "modal" (apply inline)
 *   data-theme       "auto" (default) | "light" | "dark"
 *
 * Renders into a Shadow DOM so the host page's CSS cannot clash. Works only on
 * sites listed in Careers settings > Allowed origins.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) {
    var all = document.querySelectorAll('script[src*="/careers/widget.js"]');
    script = all[all.length - 1];
  }
  if (!script) return;
  var ORIGIN = new URL(script.src, location.href).origin;
  var ds = script.dataset || {};
  var target = document.querySelector(ds.target || '#eversoft-jobs');
  if (!target) {
    target = document.createElement('div');
    target.id = 'eversoft-jobs';
    script.parentNode.insertBefore(target, script.nextSibling);
  }
  if (target.__evJobs) return;
  target.__evJobs = true;
  var root = target.attachShadow ? target.attachShadow({ mode: 'open' }) : target;
  var MODAL = ds.apply === 'modal';
  var theme = ds.theme === 'light' || ds.theme === 'dark' ? ds.theme : 'auto';

  var CSS = [
    ':host{all:initial;display:block}',
    '.ev{--bg:#fff;--card:#fff;--text:#111827;--muted:#5b6474;--border:#e2e5ea;--accent:#1d4ed8;--onaccent:#fff;--chip:#eef2f7;--danger:#b42318;--ok:#067647;',
    'font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--text)}',
    '.ev.dark{--bg:#0e1116;--card:#161b22;--text:#e8ebf0;--muted:#9aa4b2;--border:#2a313c;--accent:#6b9bff;--onaccent:#0b1220;--chip:#202734;--danger:#ff8a80;--ok:#5fd39a}',
    '@media (prefers-color-scheme:dark){.ev.auto{--bg:#0e1116;--card:#161b22;--text:#e8ebf0;--muted:#9aa4b2;--border:#2a313c;--accent:#6b9bff;--onaccent:#0b1220;--chip:#202734;--danger:#ff8a80;--ok:#5fd39a}}',
    '*{box-sizing:border-box}',
    'ul.list{list-style:none;margin:0;padding:0;display:grid;gap:10px}',
    'li.job{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
    '.t{font-weight:650;font-size:16px;color:var(--text);text-decoration:none}',
    'a.t:hover{color:var(--accent);text-decoration:underline}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.chip{background:var(--chip);border-radius:999px;padding:1px 9px;font-size:12px}',
    '.btn{display:inline-flex;align-items:center;border:1px solid var(--accent);background:var(--accent);color:var(--onaccent);border-radius:8px;padding:8px 14px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}',
    '.btn.ghost{background:transparent;color:var(--accent)}',
    '.btn[disabled]{opacity:.6}',
    'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    '.muted{color:var(--muted);font-size:14px}',
    '.more{margin-top:10px;font-size:14px}.more a{color:var(--accent)}',
    '.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2147483000}',
    '.md{background:var(--card);color:var(--text);border-radius:12px;width:100%;max-width:560px;max-height:92vh;overflow:auto;padding:20px;border:1px solid var(--border)}',
    '.md h2{margin:0 0 4px;font-size:19px}',
    '.f{margin:0 0 12px}.f label{display:block;font-weight:600;font-size:14px;margin-bottom:4px}',
    '.in{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:14px}',
    'textarea.in{min-height:90px;resize:vertical}',
    '.err{color:var(--danger);font-size:13px;margin-top:3px}',
    '.alert{border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:14px;background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)}',
    '.okbox{color:var(--ok);font-weight:600}',
    '.check{display:flex;gap:8px;align-items:flex-start;font-weight:400 !important}',
    '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}',
    '.row{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}'
  ].join('\n');

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  var wrap = el('div', { 'class': 'ev ' + theme });
  var style = el('style'); style.textContent = CSS;
  root.appendChild(style); root.appendChild(wrap);

  function jobUrl(j) {
    return ORIGIN + j.url + '?src=widget&ref=' + encodeURIComponent(location.hostname);
  }
  function getJSON(url, opts) {
    return fetch(url, Object.assign({ credentials: 'omit', mode: 'cors' }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, d: d }; });
    });
  }

  function load() {
    var p = new URLSearchParams();
    ['department', 'location', 'type', 'remote', 'q'].forEach(function (k) { if (ds[k]) p.set(k, ds[k]); });
    p.set('limit', String(Math.min(Math.max(parseInt(ds.limit, 10) || 10, 1), 100)));
    wrap.appendChild(el('p', { 'class': 'muted', role: 'status' }, 'Loading jobs…'));
    getJSON(ORIGIN + '/api/public/careers/jobs?' + p.toString()).then(function (res) {
      wrap.innerHTML = '';
      if (res.status !== 200 || !res.d.ok) {
        wrap.appendChild(el('p', { 'class': 'muted' }, res.status === 403 ? 'Job listings are not available on this website.' : 'Job listings are not available right now.'));
        return;
      }
      var jobs = res.d.jobs || [];
      if (!jobs.length) { wrap.appendChild(el('p', { 'class': 'muted' }, 'No open positions right now. Please check back soon.')); return; }
      var ul = el('ul', { 'class': 'list', 'aria-label': 'Open positions' });
      jobs.forEach(function (j) {
        var li = el('li', { 'class': 'job' });
        var left = el('div');
        var a = el('a', { 'class': 't', href: jobUrl(j), target: '_blank', rel: 'noopener' }, j.title);
        left.appendChild(a);
        var chips = el('div', { 'class': 'chips' });
        [j.department, j.location, j.type, j.remote ? 'Remote' : '', j.salary || ''].forEach(function (c) { if (c) chips.appendChild(el('span', { 'class': 'chip' }, c)); });
        left.appendChild(chips);
        li.appendChild(left);
        if (MODAL) {
          var b = el('button', { 'class': 'btn', type: 'button' }, 'Apply');
          b.setAttribute('aria-label', 'Apply for ' + j.title);
          b.addEventListener('click', function () { openApply(j, b); });
          li.appendChild(b);
        } else {
          li.appendChild(el('a', { 'class': 'btn ghost', href: jobUrl(j), target: '_blank', rel: 'noopener', 'aria-label': 'View and apply: ' + j.title }, 'View & apply'));
        }
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      if (res.d.total > jobs.length) {
        var m = el('p', { 'class': 'more' });
        m.appendChild(el('a', { href: ORIGIN + '/careers', target: '_blank', rel: 'noopener' }, 'See all ' + res.d.total + ' open positions'));
        wrap.appendChild(m);
      }
    }).catch(function () {
      wrap.innerHTML = '';
      wrap.appendChild(el('p', { 'class': 'muted' }, 'Job listings are not available right now.'));
    });
  }

  function field(form, id, label, input, required) {
    var f = el('div', { 'class': 'f' });
    var l = el('label', { 'for': id }, label + (required ? ' *' : ''));
    input.id = id; input.className = input.className || 'in';
    if (required) input.required = true;
    var e = el('div', { 'class': 'err', id: id + '-e' });
    input.setAttribute('aria-describedby', id + '-e');
    f.appendChild(l); f.appendChild(input); f.appendChild(e);
    form.appendChild(f);
    return { input: input, err: e };
  }

  function openApply(j, opener) {
    var ov = el('div', { 'class': 'ov' });
    var md = el('div', { 'class': 'md', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ev-h' });
    ov.appendChild(md);
    wrap.appendChild(ov);
    md.appendChild(el('p', { 'class': 'muted' }, 'Loading…'));
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey, true); if (opener) opener.focus(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

    getJSON(ORIGIN + '/api/public/careers/jobs/' + encodeURIComponent(j.code || j.id)).then(function (res) {
      md.innerHTML = '';
      if (res.status !== 200 || !res.d.ok) { md.appendChild(el('p', null, res.d.message || 'This job is no longer open.')); return; }
      var job = res.d.job, token = res.d.formToken, maxMb = res.d.maxResumeMb || 5;
      md.appendChild(el('h2', { id: 'ev-h' }, 'Apply: ' + job.title));
      md.appendChild(el('p', { 'class': 'muted' }, [job.department, job.location, job.type].filter(Boolean).join(' · ')));
      var status = el('div', { role: 'status', 'aria-live': 'polite' });
      md.appendChild(status);
      var form = el('form', { novalidate: 'novalidate' });
      var hp = el('div', { 'class': 'hp', 'aria-hidden': 'true' });
      var hpi = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
      hp.appendChild(hpi); form.appendChild(hp);
      var F = {};
      F.fullName = field(form, 'ev-name', 'Full name', el('input', { autocomplete: 'name', maxlength: '200' }), true);
      F.email = field(form, 'ev-email', 'Email', el('input', { type: 'email', autocomplete: 'email', maxlength: '254' }), true);
      F.phone = field(form, 'ev-phone', 'Phone', el('input', { type: 'tel', autocomplete: 'tel', maxlength: '40' }), false);
      F.linkedinUrl = field(form, 'ev-li', 'LinkedIn profile', el('input', { type: 'url', maxlength: '300', placeholder: 'https://' }), false);
      F.resume = field(form, 'ev-resume', 'Resume (PDF or DOCX, up to ' + maxMb + ' MB)', el('input', { type: 'file', accept: '.pdf,.docx', 'class': 'in' }), true);
      var Q = [];
      (job.questions || []).forEach(function (q, i) {
        var inp;
        if (q.type === 'select') {
          inp = el('select');
          inp.appendChild(el('option', { value: '' }, 'Choose…'));
          (q.options || []).forEach(function (o) { inp.appendChild(el('option', { value: o }, o)); });
        } else if (q.type === 'textarea') inp = el('textarea', { maxlength: '2000' });
        else if (q.type === 'boolean') inp = el('select');
        else inp = el('input', { type: q.type === 'number' ? 'number' : q.type === 'url' ? 'url' : q.type === 'email' ? 'email' : 'text', maxlength: '2000' });
        if (q.type === 'boolean') { inp.appendChild(el('option', { value: '' }, 'Choose…')); inp.appendChild(el('option', { value: 'true' }, 'Yes')); inp.appendChild(el('option', { value: 'false' }, 'No')); }
        var fq = field(form, 'ev-q' + i, q.label, inp, q.required);
        F['answers.' + q.key] = fq;
        Q.push({ key: q.key, label: q.label || '', input: inp, required: q.required });
      });
      F.coverLetter = field(form, 'ev-cover', 'Cover letter', el('textarea', { maxlength: '10000' }), false);
      var cf = el('div', { 'class': 'f' });
      var cl = el('label', { 'class': 'check', 'for': 'ev-consent' });
      var cb = el('input', { type: 'checkbox', id: 'ev-consent', 'aria-describedby': 'ev-consent-e' });
      cl.appendChild(cb);
      var span = el('span', null, 'I agree that my application data may be stored and processed for recruiting purposes');
      if (res.d.privacyUrl) {
        span.appendChild(document.createTextNode(' ('));
        span.appendChild(el('a', { href: res.d.privacyUrl, target: '_blank', rel: 'noopener' }, 'privacy notice'));
        span.appendChild(document.createTextNode(')'));
      }
      span.appendChild(document.createTextNode('. *'));
      cl.appendChild(span); cf.appendChild(cl);
      var ce = el('div', { 'class': 'err', id: 'ev-consent-e' }); cf.appendChild(ce);
      form.appendChild(cf);
      F.consent = { input: cb, err: ce };
      var row = el('div', { 'class': 'row' });
      var cancel = el('button', { 'class': 'btn ghost', type: 'button' }, 'Cancel');
      cancel.addEventListener('click', close);
      var submit = el('button', { 'class': 'btn', type: 'submit' }, 'Submit application');
      row.appendChild(cancel); row.appendChild(submit); form.appendChild(row);
      md.appendChild(form);
      F.fullName.input.focus();

      // Resume parsing: fill only the fields still empty, then say what was filled.
      var QMAP = [[/linked\s*in/i, 'linkedinUrl'], [/git\s*hub/i, 'githubUrl'], [/portfolio|website/i, 'portfolioUrl'],
        [/experience|years/i, 'experienceYears'], [/skill|stack|technolog/i, 'skills'], [/phone|mobile/i, 'phone'],
        [/location|city/i, 'location']];
      var parseSeq = 0;
      function fillIn(inp, v) {
        if (!inp || v === undefined || v === null || v === '' || inp.tagName === 'SELECT' || (inp.value && inp.value.trim())) return false;
        v = Array.isArray(v) ? v.join(', ') : String(v);
        if (inp.type === 'number') { var n = parseFloat(v); if (isNaN(n)) return false; v = String(n); }
        if (inp.type === 'url' && !/^https?:\/\//i.test(v)) return false;
        inp.value = inp.maxLength > 0 ? v.slice(0, inp.maxLength) : v;
        return true;
      }
      F.resume.input.addEventListener('change', function () {
        var file = F.resume.input.files && F.resume.input.files[0], seq = ++parseSeq;
        if (!file || !/\.(pdf|docx)$/i.test(file.name) || file.size > maxMb * 1048576) return;
        status.innerHTML = '';
        status.appendChild(el('div', { 'class': 'muted' }, 'Reading your resume…'));
        var rd = new FileReader();
        rd.onload = function () {
          getJSON(ORIGIN + '/api/public/careers/parse-resume', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resume: { name: file.name, mime: file.type, data: String(rd.result || '') } })
          }).then(function (res) {
            if (seq !== parseSeq) return;
            status.innerHTML = '';
            if (res.status !== 200 || !res.d.ok || !res.d.readable) {
              status.appendChild(el('div', { 'class': 'muted' }, (res.d && res.d.message) || "We couldn't read details from this resume — please fill the form in."));
              return;
            }
            var f = res.d.fields || {}, n = 0;
            ['fullName', 'email', 'phone', 'linkedinUrl'].forEach(function (k) { if (fillIn(F[k].input, f[k])) n++; });
            Q.forEach(function (q) {
              var t = '';
              for (var i = 0; i < QMAP.length && !t; i++) if (QMAP[i][0].test(q.key + ' ' + q.label)) t = QMAP[i][1];
              if (t && fillIn(q.input, f[t])) n++;
            });
            status.appendChild(el('div', { 'class': 'muted' }, n
              ? 'We filled ' + n + ' field' + (n === 1 ? '' : 's') + ' from your resume — please check them.'
              : 'Resume attached.'));
          }).catch(function () { if (seq === parseSeq) status.innerHTML = ''; });
        };
        rd.readAsDataURL(file);
      });

      function showErrors(errs, msg) {
        Object.keys(F).forEach(function (k) { F[k].err.textContent = ''; F[k].input.removeAttribute('aria-invalid'); });
        var first = null;
        Object.keys(errs || {}).forEach(function (k) {
          if (F[k]) { F[k].err.textContent = errs[k]; F[k].input.setAttribute('aria-invalid', 'true'); first = first || F[k].input; }
        });
        status.innerHTML = '';
        if (msg) status.appendChild(el('div', { 'class': 'alert' }, msg));
        if (first) first.focus();
      }
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var errs = {};
        var val = function (k) { return F[k].input.value.trim(); };
        if (val('fullName').length < 2) errs.fullName = 'Please enter your full name.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) errs.email = 'Please enter a valid email address.';
        var file = F.resume.input.files && F.resume.input.files[0];
        if (!file) errs.resume = 'Please attach your resume.';
        else if (!/\.(pdf|docx)$/i.test(file.name)) errs.resume = 'Only PDF or DOCX resumes are accepted.';
        else if (file.size > maxMb * 1048576) errs.resume = 'Resumes must be ' + maxMb + ' MB or smaller.';
        if (!cb.checked) errs.consent = 'Please agree so we can process your application.';
        var answers = {};
        Q.forEach(function (q) { var v = q.input.value.trim(); if (v) answers[q.key] = v; else if (q.required) errs['answers.' + q.key] = 'This question is required.'; });
        if (Object.keys(errs).length) { showErrors(errs, 'Please fix the highlighted fields.'); return; }
        submit.disabled = true; submit.textContent = 'Submitting…';
        var r = new FileReader();
        r.onload = function () {
          getJSON(ORIGIN + '/api/public/careers/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: job.id, formToken: token, website: hpi.value, fullName: val('fullName'), email: val('email'),
              phone: val('phone'), linkedinUrl: val('linkedinUrl'), coverLetter: F.coverLetter.input.value,
              answers: answers, consent: true, source: 'widget', sourceDetail: location.hostname,
              resume: { name: file.name, mime: file.type, data: String(r.result || '') }
            })
          }).then(function (res2) {
            if (res2.status === 201 && res2.d.ok) {
              md.innerHTML = '';
              md.appendChild(el('h2', { id: 'ev-h', 'class': 'okbox', tabindex: '-1' }, 'Application sent'));
              md.appendChild(el('p', null, res2.d.message || 'Thank you for applying.'));
              md.appendChild(el('p', { 'class': 'muted' }, 'Reference: ' + (res2.d.reference || '')));
              md.appendChild(el('p', { 'class': 'muted' }, 'A confirmation email is on its way to ' + (res2.d.email || val('email')) +
                '. If it does not arrive in a few minutes, please check your spam folder.'));
              var row2 = el('div', { 'class': 'row' });
              var done = el('button', { 'class': 'btn', type: 'button' }, 'Back to open roles');
              done.addEventListener('click', close);
              row2.appendChild(done);
              row2.appendChild(el('a', { 'class': 'btn ghost', href: ORIGIN + '/careers', target: '_blank', rel: 'noopener' }, 'All jobs at the careers site'));
              md.appendChild(row2);
              md.querySelector('h2').focus();
              return;
            }
            showErrors(res2.d.errors || {}, res2.d.message || 'Something went wrong. Please try again.');
            submit.disabled = false; submit.textContent = 'Submit application';
          }).catch(function () {
            showErrors({}, 'Network error. Please try again.');
            submit.disabled = false; submit.textContent = 'Submit application';
          });
        };
        r.onerror = function () { showErrors({ resume: 'The file could not be read.' }); submit.disabled = false; submit.textContent = 'Submit application'; };
        r.readAsDataURL(file);
      });
    }).catch(function () { md.innerHTML = ''; md.appendChild(el('p', null, 'This job could not be loaded.')); });
  }

  load();
})();
