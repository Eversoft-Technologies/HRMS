/**
 * hrms-careers.js  v1
 * Job Applications inbox — /recruit/applications (list) and /recruit/applications/<id> (detail drawer).
 * Applications arrive from the public careers page (/careers) and the embeddable widget.
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js); React-owned DOM is never touched.
 *
 * Backend: hrms_plus/careers.py
 *   GET   /api/recruit/applications?job&status&source&from&to&q   list (no resume body)
 *   GET   /api/recruit/applications/meta                           jobs, statuses, transitions, permissions
 *   GET/PATCH /api/recruit/applications/<id>                       detail / {status, note}
 *   GET   /api/recruit/applications/<id>/resume                    file (audited)
 *   POST  /api/recruit/applications/<id>/score                     Resume Scoring engine
 *   POST  /api/recruit/applications/<id>/onboard                   onboarding candidate (hired)
 *   GET/PUT /api/recruit/careers/settings                          careers page settings
 */
(function () {
  'use strict';
  if (window.__hrmsCareersLoaded) return;
  window.__hrmsCareersLoaded = true;

  var BASE = '/recruit/applications';
  var STYLE_ID = 'hrms-careers-style';
  var SC = null;
  var STATUS_LABEL = { 'new': 'New', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' };
  var STATUS_CLS = { 'new': 'cr-c-accent', screening: 'cr-c-warn', interview: 'cr-c-warn', offer: 'cr-c-accent', hired: 'cr-c-success', rejected: 'cr-c-danger', withdrawn: 'cr-c-muted' };
  var SOURCE_LABEL = { careers: 'Careers page', widget: 'Website widget', referral: 'Referral', manual: 'Manual' };
  var state = {
    root: null, meta: null, token: 0, searchTimer: null, list: [], detailId: null,
    filters: { status: 'open', job: '', source: '', from: '', to: '', q: '' }
  };

  function esc(s) { return SC.esc(s); }
  function api(url, opts) { return SC.api(url, opts); }
  function fmtDate(v, time) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v, time ? { time: true } : undefined); } catch (_) {}
    return String(v).slice(0, time ? 16 : 10).replace('T', ' ');
  }
  function badge(text, cls) { return '<span class="cr-badge ' + (cls || 'cr-c-muted') + '">' + esc(text) + '</span>'; }
  function statusBadge(s) { return badge(STATUS_LABEL[s] || s, STATUS_CLS[s]); }

  /* ── style ─────────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.cr-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.cr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.cr-h1{font-size:20px;font-weight:700;margin:0}',
      '.cr-sub{font-size:13px;color:var(--text3);margin-top:4px}',
      '.cr-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.cr-link{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--border2);border-radius:8px;color:var(--text2);text-decoration:none;font-size:13px;background:var(--bg2);cursor:pointer;font-family:inherit}',
      '.cr-link:hover{border-color:var(--accent);color:var(--accent)}',
      '.cr-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border2);margin-bottom:14px;overflow-x:auto}',
      '.cr-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 12px;font-size:13px;font-weight:600;color:var(--text3);cursor:pointer;font-family:inherit;margin-bottom:-1px;white-space:nowrap}',
      '.cr-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.cr-tab i{font-style:normal;font-weight:600;font-size:11px;margin-left:5px;padding:1px 7px;border-radius:999px;background:var(--bg3);color:var(--text2)}',
      '.cr-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
      '.cr-filters .input-field{width:auto;min-width:140px;padding:7px 10px}',
      '.cr-filters .cr-search{flex:1;min-width:200px}',
      '.cr-table-wrap{overflow-x:auto}',
      '.cr-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.cr-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:8px 10px;border-bottom:1px solid var(--border2);white-space:nowrap}',
      '.cr-table td{padding:10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.cr-table tbody tr{cursor:pointer}',
      '.cr-table tbody tr:hover td,.cr-table tbody tr:focus td{background:var(--bg3)}',
      '.cr-name{font-weight:600}',
      '.cr-muted{color:var(--text3)}',
      '.cr-nowrap{white-space:nowrap}',
      '.cr-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.cr-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.cr-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 13%,transparent)}',
      '.cr-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}',
      '.cr-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.cr-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border2)}',
      '.cr-empty{padding:40px 10px;text-align:center;color:var(--text3);font-size:13px}',
      '.cr-err{padding:10px 12px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px}',
      '.cr-ok{padding:10px 12px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 12%,transparent);font-size:13px;margin-bottom:12px}',
      '.cr-drawer-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;justify-content:flex-end}',
      '.cr-drawer{background:var(--bg2);border-left:1px solid var(--border2);width:560px;max-width:100%;height:100%;overflow-y:auto;padding:20px 22px;color:var(--text);box-shadow:-8px 0 24px rgba(0,0,0,.18)}',
      '.cr-dh{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}',
      '.cr-dh h2{font-size:18px;margin:0}',
      '.cr-x{background:none;border:none;color:var(--text2);font-size:22px;line-height:1;cursor:pointer;padding:2px 6px}',
      '.cr-sec{border-top:1px solid var(--border);padding-top:14px;margin-top:14px}',
      '.cr-sec h3{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin:0 0 10px}',
      '.cr-kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:5px 0}',
      '.cr-kv span:first-child{color:var(--text3);flex:none}',
      '.cr-kv span:last-child{text-align:right;word-break:break-word}',
      '.cr-kv a{color:var(--accent)}',
      '.cr-pre{white-space:pre-wrap;font-size:13px;line-height:1.55;word-break:break-word}',
      '.cr-pipe{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}',
      '.cr-step{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--border2);color:var(--text3)}',
      '.cr-step.on{border-color:var(--accent);color:var(--accent);font-weight:700}',
      '.cr-step.done{color:var(--success);border-color:color-mix(in srgb,var(--success) 50%,transparent)}',
      '.cr-score{display:flex;gap:14px;align-items:center}',
      '.cr-score b{font-size:28px}',
      '.cr-hist{font-size:12px;color:var(--text3);padding:4px 0;border-bottom:1px dashed var(--border)}',
      '.cr-hist:last-child{border-bottom:none}',
      '.cr-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;width:100%;max-width:760px;padding:22px;color:var(--text);max-height:92vh;overflow:auto;margin:auto}',
      '.cr-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1001;padding:16px}',
      '.cr-modal h3{margin:0 0 14px;font-size:16px}',
      '.cr-field{margin-bottom:12px}',
      '.cr-field label{display:block;font-size:11px;font-weight:600;color:var(--text3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.cr-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);margin-bottom:8px;cursor:pointer}',
      '.cr-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.cr-hint{font-size:11.5px;color:var(--text3);margin-top:4px}',
      '.cr-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;min-height:84px;resize:vertical}',
      '.cr-q{display:grid;grid-template-columns:2fr 1fr auto auto;gap:8px;align-items:center;margin-bottom:8px}',
      '.cr-q .cr-qopts{grid-column:1/-1}',
      '.cr-busy{opacity:.6;pointer-events:none}',
      '@media (max-width:640px){.cr-row2{grid-template-columns:1fr}.cr-drawer{padding:16px}.cr-filters .input-field{flex:1 1 140px}.cr-q{grid-template-columns:1fr 1fr}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── list ───────────────────────────────────────────────────────────────── */
  function shell(root) {
    var f = state.filters;
    root.innerHTML =
      '<div class="cr-page">' +
        '<div class="cr-head"><div><h1 class="cr-h1">Job Applications</h1>' +
        '<div class="cr-sub">Applications from your careers page and website widget.</div></div>' +
        '<div class="cr-btns"><a class="cr-link" href="/careers" target="_blank" rel="noopener">View careers page ↗</a>' +
        '<button type="button" class="cr-link" data-cr="settings">Careers settings &amp; embed code</button></div></div>' +
        '<div class="cr-tabs" role="tablist" data-cr="tabs"></div>' +
        '<div class="cr-filters">' +
          '<input class="input-field cr-search" type="search" placeholder="Search name, email or phone" aria-label="Search applications" data-cr="q" value="' + esc(f.q) + '">' +
          '<select class="input-field" data-cr="job" aria-label="Job"><option value="">All jobs</option></select>' +
          '<select class="input-field" data-cr="source" aria-label="Source"><option value="">All sources</option>' +
            Object.keys(SOURCE_LABEL).map(function (k) { return '<option value="' + k + '"' + (f.source === k ? ' selected' : '') + '>' + SOURCE_LABEL[k] + '</option>'; }).join('') +
          '</select>' +
          '<input class="input-field" type="date" data-cr="from" aria-label="Applied from" value="' + esc(f.from) + '">' +
          '<input class="input-field" type="date" data-cr="to" aria-label="Applied to" value="' + esc(f.to) + '">' +
        '</div>' +
        '<div data-cr="msg"></div>' +
        '<div class="card cr-table-wrap" data-cr="list"><div class="cr-empty">Loading…</div></div>' +
      '</div>';
    var q = root.querySelector('[data-cr="q"]');
    q.addEventListener('input', function () {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () { f.q = q.value.trim(); load(); }, 300);
    });
    ['job', 'source', 'from', 'to'].forEach(function (k) {
      root.querySelector('[data-cr="' + k + '"]').addEventListener('change', function (e) { f[k] = e.target.value; load(); });
    });
    root.querySelector('[data-cr="settings"]').addEventListener('click', openSettings);
  }

  function renderTabs(counts) {
    var el = state.root && state.root.querySelector('[data-cr="tabs"]');
    if (!el) return;
    counts = counts || {};
    var open = (counts['new'] || 0) + (counts.screening || 0) + (counts.interview || 0) + (counts.offer || 0);
    var all = 0; Object.keys(counts).forEach(function (k) { all += counts[k] || 0; });
    var tabs = [['open', 'Open', open]].concat(['new', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'].map(function (s) { return [s, STATUS_LABEL[s], counts[s] || 0]; })).concat([['', 'All', all]]);
    el.innerHTML = tabs.map(function (t) {
      var on = state.filters.status === t[0];
      return '<button type="button" role="tab" aria-selected="' + on + '" class="cr-tab' + (on ? ' on' : '') + '" data-st="' + t[0] + '">' + esc(t[1]) + '<i>' + t[2] + '</i></button>';
    }).join('');
    el.querySelectorAll('[data-st]').forEach(function (b) {
      b.addEventListener('click', function () { state.filters.status = b.getAttribute('data-st'); load(); });
    });
  }

  function fillJobs() {
    var sel = state.root && state.root.querySelector('[data-cr="job"]');
    if (!sel || !state.meta) return;
    sel.innerHTML = '<option value="">All jobs</option>' + (state.meta.jobs || []).map(function (j) {
      return '<option value="' + j.id + '"' + (String(state.filters.job) === String(j.id) ? ' selected' : '') + '>' +
        esc(j.title + (j.code ? ' (' + j.code + ')' : '') + (/^active$/i.test(j.status || '') ? '' : ' · ' + j.status)) + '</option>';
    }).join('');
  }

  function load() {
    var tk = ++state.token, f = state.filters;
    var qs = ['status', 'job', 'source', 'from', 'to', 'q'].filter(function (k) { return f[k]; })
      .map(function (k) { return k + '=' + encodeURIComponent(f[k]); }).join('&');
    var box = state.root.querySelector('[data-cr="list"]');
    box.classList.add('cr-busy');
    api('/api/recruit/applications?pageSize=200' + (qs ? '&' + qs : '')).then(function (d) {
      if (tk !== state.token || !state.root) return;
      box.classList.remove('cr-busy');
      state.list = d.items || [];
      renderTabs(d.counts);
      if (!state.list.length) {
        box.innerHTML = '<div class="cr-empty">No applications here yet. Share your <a href="/careers" target="_blank" rel="noopener">careers page</a> or add the job widget to your website.</div>';
        return;
      }
      box.innerHTML = '<table class="cr-table"><thead><tr><th>Applicant</th><th>Job</th><th>Source</th><th>Status</th><th>Score</th><th>Applied</th></tr></thead><tbody>' +
        state.list.map(function (a) {
          return '<tr tabindex="0" data-id="' + a.id + '">' +
            '<td><div class="cr-name">' + esc(a.fullName) + '</div><div class="cr-muted">' + esc(a.email) + '</div></td>' +
            '<td>' + esc(a.jobTitle) + '<div class="cr-muted">' + esc(a.jobCode || '') + '</div></td>' +
            '<td class="cr-nowrap">' + esc(SOURCE_LABEL[a.source] || a.source) + (a.sourceDetail ? '<div class="cr-muted">' + esc(a.sourceDetail) + '</div>' : '') + '</td>' +
            '<td>' + statusBadge(a.status) + '</td>' +
            '<td class="cr-muted">' + (a.resumeScoreId ? 'Scored' : '—') + '</td>' +
            '<td class="cr-nowrap">' + esc(fmtDate(a.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        (d.total > state.list.length ? '<div class="cr-empty">Showing the latest ' + state.list.length + ' of ' + d.total + '. Narrow the filters to see more.</div>' : '');
      box.querySelectorAll('tr[data-id]').forEach(function (tr) {
        var open = function () { SC.go(BASE + '/' + tr.getAttribute('data-id')); };
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    }).catch(function (e) {
      if (tk !== state.token || !state.root) return;
      box.classList.remove('cr-busy');
      box.innerHTML = '<div class="cr-err">' + esc(e.status === 403 ? 'You do not have access to job applications (recruitment.view).' : e.message) + '</div>';
    });
  }

  /* ── detail drawer ─────────────────────────────────────────────────────── */
  function closeDrawer(nav) {
    var bg = document.querySelector('.cr-drawer-bg');
    if (bg && bg.parentNode) bg.parentNode.removeChild(bg);
    document.removeEventListener('keydown', drawerKey, true);
    state.detailId = null;
    if (nav !== false && location.pathname !== BASE) SC.go(BASE);
  }
  function drawerKey(e) { if (e.key === 'Escape') closeDrawer(); }

  function openDrawer(id) {
    state.detailId = id;
    var bg = document.querySelector('.cr-drawer-bg');
    if (!bg) {
      bg = document.createElement('div');
      bg.className = 'cr-drawer-bg';
      bg.innerHTML = '<aside class="cr-drawer" role="dialog" aria-modal="true" aria-label="Application"><div class="cr-empty">Loading…</div></aside>';
      bg.addEventListener('click', function (e) { if (e.target === bg) closeDrawer(); });
      state.root.appendChild(bg);
      document.addEventListener('keydown', drawerKey, true);
    }
    api('/api/recruit/applications/' + id).then(function (a) {
      if (state.detailId !== id) return;
      renderDrawer(a);
    }).catch(function (e) {
      var d = document.querySelector('.cr-drawer');
      if (d) d.innerHTML = '<div class="cr-dh"><h2>Application</h2><button class="cr-x" type="button" aria-label="Close">×</button></div><div class="cr-err">' + esc(e.message) + '</div>';
      var x = d && d.querySelector('.cr-x'); if (x) x.addEventListener('click', function () { closeDrawer(); });
    });
  }

  function kv(label, value, html) { return value ? '<div class="cr-kv"><span>' + esc(label) + '</span><span>' + (html ? value : esc(value)) + '</span></div>' : ''; }

  /* Applicant confirmation email: sent / failed (with the provider's reason) /
     not recorded, plus a resend for recruiters who can edit. */
  function confirmationHtml(a, canEdit) {
    var c = a.confirmation || { status: 'unknown' };
    var label = c.status === 'sent' ? '<span style="color:var(--success)">Sent</span>' + (c.at ? ' · ' + esc(fmtDate(c.at, true)) : '')
      : c.status === 'failed' ? '<span style="color:var(--danger)">Not delivered</span>' + (c.at ? ' · ' + esc(fmtDate(c.at, true)) : '')
      : '<span class="cr-muted">Not recorded</span>';
    var err = c.status === 'failed' && c.error ? '<div class="cr-muted" style="margin-top:4px">Reason: ' + esc(c.error) + '</div>' : '';
    var btn = canEdit ? ' <button type="button" class="cr-link" data-resend="1">' + (c.status === 'sent' ? 'Send again' : 'Resend confirmation') + '</button>' : '';
    return kv('Confirmation email', label + btn, true) + err;
  }

  function renderDrawer(a) {
    var d = document.querySelector('.cr-drawer');
    if (!d) return;
    var meta = state.meta || {};
    var canEdit = !!meta.canEdit;
    var stages = ['new', 'screening', 'interview', 'offer', 'hired'];
    var idx = stages.indexOf(a.status);
    var pipe = stages.map(function (s, i) {
      var cls = s === a.status ? ' on' : (idx > i ? ' done' : '');
      return '<span class="cr-step' + cls + '">' + STATUS_LABEL[s] + '</span>';
    }).join('') + (idx < 0 ? '<span class="cr-step on">' + esc(STATUS_LABEL[a.status] || a.status) + '</span>' : '');
    var next = (a.next || []).filter(function (s) { return s !== 'rejected'; });
    var actions = '';
    if (canEdit) {
      actions = next.map(function (s) {
        var label = s === 'withdrawn' ? 'Mark withdrawn' : (a.status === 'rejected' || a.status === 'withdrawn') ? 'Re-open' : 'Move to ' + STATUS_LABEL[s];
        return '<button type="button" class="' + (s === 'withdrawn' ? 'cr-link' : 'btn-primary btn-sm') + '" data-move="' + s + '">' + esc(label) + '</button>';
      }).join(' ') + ((a.next || []).indexOf('rejected') >= 0 ? ' <button type="button" class="cr-link" data-reject="1" style="color:var(--danger)">Reject…</button>' : '');
    }
    var score = a.score ? '<div class="cr-score"><b>' + esc(a.score.score) + '</b><div><div class="cr-muted">Technical ' + esc(a.score.technical) + ' · Experience ' + esc(a.score.experience) + ' · Domain ' + esc(a.score.domain) + '</div>' +
      (a.score.aiEvaluated ? '' : '<div class="cr-muted">Keyword estimate (AI was unavailable)</div>') + '</div></div>' +
      (a.score.gap ? '<p class="cr-pre cr-muted">' + esc(a.score.gap) + '</p>' : '') +
      ((a.score.skills || []).length ? '<div class="cr-muted">Matched: ' + esc(a.score.skills.join(', ')) + '</div>' : '') +
      ((a.score.missing || []).length ? '<div class="cr-muted">Missing: ' + esc(a.score.missing.join(', ')) + '</div>' : '')
      : '<div class="cr-muted">Not scored yet.</div>';
    var answers = Object.keys(a.answers || {}).map(function (k) { var x = a.answers[k] || {}; return kv(x.label || k, x.value || ''); }).join('');
    var onboarding = '';
    if (a.onboarding) onboarding = '<div class="cr-ok">In onboarding as ' + esc(a.onboarding.code) + ' (' + esc(a.onboarding.status) + '). <a href="/onboarding">Open onboarding</a></div>';
    else if (a.status === 'hired' && meta.canOnboard) onboarding = '<button type="button" class="btn-primary btn-sm" data-onboard="1">Create onboarding candidate</button>';
    else if (a.status === 'hired') onboarding = '<div class="cr-muted">Creating an onboarding candidate needs onboarding.create.</div>';
    var hist = (a.history || []).map(function (h) {
      var c = h.changes || {};
      var what = h.action === 'careers.status' ? 'Moved ' + (STATUS_LABEL[c.from] || c.from) + ' → ' + (STATUS_LABEL[c.to] || c.to)
        : h.action === 'careers.resume_download' ? 'Downloaded the resume'
        : h.action === 'careers.score' ? 'Scored the resume (' + c.score + ')'
        : h.action === 'careers.onboard' ? 'Created onboarding candidate ' + (c.candidateCode || '') : h.action;
      return '<div class="cr-hist">' + esc(fmtDate(h.at, true)) + ' · ' + esc(h.by) + ' — ' + esc(what) + (h.note ? '<div class="cr-pre">' + esc(h.note) + '</div>' : '') + '</div>';
    }).join('');
    d.innerHTML =
      '<div class="cr-dh"><div><h2>' + esc(a.fullName) + '</h2><div class="cr-muted">' + esc(a.reference) + ' · ' + esc(a.jobTitle) + (a.jobCode ? ' (' + esc(a.jobCode) + ')' : '') + '</div></div>' +
      '<button class="cr-x" type="button" aria-label="Close">×</button></div>' +
      '<div data-cr="dmsg"></div>' +
      '<div class="cr-pipe">' + pipe + '</div>' +
      (actions ? '<div class="cr-btns">' + actions + '</div>' : '') +
      '<div data-cr="reject"></div>' +
      (a.stageNote ? '<div class="cr-sec"><h3>Latest note</h3><div class="cr-pre">' + esc(a.stageNote) + '</div></div>' : '') +
      (onboarding ? '<div class="cr-sec"><h3>Onboarding</h3>' + onboarding + '</div>' : '') +
      '<div class="cr-sec"><h3>Contact</h3>' +
        kv('Email', '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>', true) +
        kv('Phone', a.phone) + kv('Location', a.location) +
        (a.linkedinUrl && /^https?:\/\//i.test(a.linkedinUrl) ? kv('LinkedIn', '<a href="' + esc(a.linkedinUrl) + '" target="_blank" rel="noopener noreferrer">Profile ↗</a>', true) : '') +
        kv('Source', (SOURCE_LABEL[a.source] || a.source) + (a.sourceDetail ? ' · ' + a.sourceDetail : '')) +
        kv('Applied', fmtDate(a.createdAt, true)) + kv('Consent', a.consent ? 'Given' : 'Not given') +
        confirmationHtml(a, canEdit) +
      '</div>' +
      '<div class="cr-sec"><h3>Resume</h3>' +
        (a.hasResume ? '<div class="cr-btns"><button type="button" class="cr-link" data-dl="1">Download ' + esc(a.resumeName || 'resume') + ' (' + Math.max(1, Math.round((a.resumeSize || 0) / 1024)) + ' KB)</button>' +
          (canEdit ? '<button type="button" class="btn-primary btn-sm" data-score="1">' + (a.score ? 'Re-score resume' : 'Score resume') + '</button>' : '') + '</div>' : '<div class="cr-muted">No resume attached.</div>') +
        '<div style="margin-top:12px">' + score + '</div>' +
      '</div>' +
      (answers ? '<div class="cr-sec"><h3>Answers</h3>' + answers + '</div>' : '') +
      (a.coverLetter ? '<div class="cr-sec"><h3>Cover letter</h3><div class="cr-pre">' + esc(a.coverLetter) + '</div></div>' : '') +
      '<div class="cr-sec"><h3>History</h3>' + (hist || '<div class="cr-muted">No activity yet.</div>') + '</div>';

    var msg = function (text, ok) { var m = d.querySelector('[data-cr="dmsg"]'); if (m) m.innerHTML = text ? '<div class="' + (ok ? 'cr-ok' : 'cr-err') + '">' + esc(text) + '</div>' : ''; };
    d.querySelector('.cr-x').addEventListener('click', function () { closeDrawer(); });
    d.querySelector('.cr-x').focus();
    var move = function (status, note, btn) {
      if (btn) btn.disabled = true;
      api('/api/recruit/applications/' + a.id, { method: 'PATCH', body: { status: status, note: note || '' } }).then(function (na) {
        renderDrawer(na); load();
      }).catch(function (e) { if (btn) btn.disabled = false; msg(e.message); });
    };
    d.querySelectorAll('[data-move]').forEach(function (b) { b.addEventListener('click', function () { move(b.getAttribute('data-move'), '', b); }); });
    var rj = d.querySelector('[data-reject]');
    if (rj) rj.addEventListener('click', function () {
      var box = d.querySelector('[data-cr="reject"]');
      box.innerHTML = '<div class="cr-field" style="margin-top:12px"><label for="cr-rnote">Reason for rejection</label>' +
        '<textarea id="cr-rnote" class="input-field" rows="3" maxlength="2000" placeholder="Visible to recruiters only"></textarea></div>' +
        '<div class="cr-btns"><button type="button" class="btn-primary btn-sm" data-rgo="1">Reject application</button><button type="button" class="cr-link" data-rno="1">Cancel</button></div>';
      var ta = box.querySelector('textarea'); ta.focus();
      box.querySelector('[data-rno]').addEventListener('click', function () { box.innerHTML = ''; });
      box.querySelector('[data-rgo]').addEventListener('click', function (e) {
        if (ta.value.trim().length < 3) { msg('Add a short note explaining the rejection.'); ta.focus(); return; }
        move('rejected', ta.value.trim(), e.target);
      });
    });
    var dl = d.querySelector('[data-dl]');
    if (dl) dl.addEventListener('click', function () {
      dl.disabled = true;
      fetch('/api/recruit/applications/' + a.id + '/resume').then(function (r) {
        if (!r.ok) throw new Error('Download failed (' + r.status + ')');
        return r.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = a.resumeName || 'resume';
        document.body.appendChild(link); link.click(); link.parentNode.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        dl.disabled = false;
      }).catch(function (e) { dl.disabled = false; msg(e.message); });
    });
    var sc = d.querySelector('[data-score]');
    if (sc) sc.addEventListener('click', function () {
      sc.disabled = true; sc.textContent = 'Scoring… (can take ~20 s)';
      api('/api/recruit/applications/' + a.id + '/score', { method: 'POST', body: {} }).then(function (na) {
        renderDrawer(na); load();
      }).catch(function (e) { sc.disabled = false; sc.textContent = 'Score resume'; msg(e.message); });
    });
    var rs = d.querySelector('[data-resend]');
    if (rs) rs.addEventListener('click', function () {
      rs.disabled = true; rs.textContent = 'Sending…';
      api('/api/recruit/applications/' + a.id + '/resend-confirmation', { method: 'POST', body: {} }).then(function (r) {
        a.confirmation = r.confirmation; renderDrawer(a);
        var m = d.querySelector('[data-cr="dmsg"]');
        if (m) m.innerHTML = '<div class="cr-ok">Confirmation email sent to ' + esc(a.email) + '.</div>';
      }).catch(function (e) {
        if (e.data && e.data.confirmation) { a.confirmation = e.data.confirmation; renderDrawer(a); }
        msg(e.message);
      });
    });
    var ob = d.querySelector('[data-onboard]');
    if (ob) ob.addEventListener('click', function () {
      ob.disabled = true;
      api('/api/recruit/applications/' + a.id + '/onboard', { method: 'POST', body: {} }).then(function (r) {
        renderDrawer(r.application);
        var m = d.querySelector('[data-cr="dmsg"]');
        if (m) m.innerHTML = '<div class="cr-ok">Onboarding candidate ' + esc(r.candidateCode) + ' created. <a href="/onboarding">Open onboarding</a></div>';
      }).catch(function (e) { ob.disabled = false; msg(e.message); });
    });
  }

  /* ── settings + embed code ─────────────────────────────────────────────── */
  function openSettings() {
    var bg = document.createElement('div');
    bg.className = 'cr-modal-bg';
    bg.innerHTML = '<div class="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-set-h"><h3 id="cr-set-h">Careers settings</h3><div class="cr-empty">Loading…</div></div>';
    state.root.appendChild(bg);
    var close = function () { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener('keydown', onKey, true); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    api('/api/recruit/careers/settings').then(function (d) { renderSettings(bg.querySelector('.cr-modal'), d, close); })
      .catch(function (e) { bg.querySelector('.cr-modal').innerHTML = '<div class="cr-err">' + esc(e.message) + '</div>'; });
  }

  function renderSettings(m, d, close) {
    var s = d.settings || {}, can = !!d.canEdit;
    var base = (d.urls && d.urls.base) || location.origin;
    var dis = can ? '' : ' disabled';
    var questions = (s.questions || []).slice();
    m.innerHTML =
      '<h3 id="cr-set-h">Careers settings</h3>' + (can ? '' : '<div class="cr-err">You can view these settings; changing them needs recruitment.edit.</div>') +
      '<div data-cr="smsg"></div>' +
      '<label class="cr-check"><input type="checkbox" data-s="enabled"' + (s.enabled ? ' checked' : '') + dis + '> Careers page and widget are live</label>' +
      '<label class="cr-check"><input type="checkbox" data-s="showSalary"' + (s.showSalary ? ' checked' : '') + dis + '> Show salary ranges publicly</label>' +
      '<label class="cr-check"><input type="checkbox" data-s="showApplicants"' + (s.showApplicants ? ' checked' : '') + dis + '> Show the number of applicants</label>' +
      '<div class="cr-row2">' +
        '<div class="cr-field"><label for="cr-priv">Privacy notice URL</label><input id="cr-priv" class="input-field" data-s="privacyUrl" placeholder="https://…" value="' + esc(s.privacyUrl || '') + '"' + dis + '></div>' +
        '<div class="cr-field"><label for="cr-notify">Also email new applications to</label><input id="cr-notify" class="input-field" data-s="notifyEmails" placeholder="hr@company.com, …" value="' + esc((s.notifyEmails || []).join(', ')) + '"' + dis + '></div>' +
      '</div>' +
      '<div class="cr-field"><label for="cr-intro">Careers page intro</label><input id="cr-intro" class="input-field" maxlength="300" data-s="intro" value="' + esc(s.intro || '') + '"' + dis + '></div>' +
      '<div class="cr-field"><label for="cr-orig">Allowed websites (widget / iframe)</label><textarea id="cr-orig" class="input-field cr-code" data-s="allowedOrigins" placeholder="https://www.yourcompany.com"' + dis + '>' + esc((s.allowedOrigins || []).join('\n')) + '</textarea>' +
        '<div class="cr-hint">One origin per line (scheme + host, no path). Only these sites can show the job widget or frame the careers page.</div></div>' +
      ((d.customFields || []).length ? '<div class="cr-field"><label>Job fields shown publicly</label>' + d.customFields.map(function (f) {
        var on = f.public || (s.publicFields || []).indexOf(f.key) >= 0;
        return '<label class="cr-check"><input type="checkbox" data-pf="' + esc(f.key) + '"' + (on ? ' checked' : '') + (f.public || !can ? ' disabled' : '') + '> ' + esc(f.label) + '</label>';
      }).join('') + '<div class="cr-hint">Everything else on a job post stays internal.</div></div>' : '') +
      '<div class="cr-field"><label>Application questions (all jobs)</label><div data-cr="qs"></div>' +
        (can ? '<button type="button" class="cr-link" data-cr="qadd">+ Add question</button>' : '') + '</div>' +
      (can ? '<div class="cr-btns" style="margin:6px 0 18px"><button type="button" class="btn-primary btn-sm" data-cr="save">Save settings</button><button type="button" class="cr-link" data-cr="close">Close</button></div>' :
        '<div class="cr-btns" style="margin:6px 0 18px"><button type="button" class="cr-link" data-cr="close">Close</button></div>') +
      '<h3>Embed code</h3>' +
      '<div class="cr-row2">' +
        '<div class="cr-field"><label for="cr-e-dept">Department (optional)</label><input id="cr-e-dept" class="input-field" data-e="department" placeholder="e.g. Engineering"></div>' +
        '<div class="cr-field"><label for="cr-e-limit">Max jobs</label><input id="cr-e-limit" class="input-field" type="number" min="1" max="100" value="10" data-e="limit"></div>' +
      '</div>' +
      '<div class="cr-row2">' +
        '<div class="cr-field"><label for="cr-e-apply">Apply button</label><select id="cr-e-apply" class="input-field" data-e="apply"><option value="link">Opens the job on the careers page</option><option value="modal">Apply inline (pop-up form)</option></select></div>' +
        '<div class="cr-field"><label for="cr-e-theme">Theme</label><select id="cr-e-theme" class="input-field" data-e="theme"><option value="auto">Follow visitor (light/dark)</option><option value="light">Light</option><option value="dark">Dark</option></select></div>' +
      '</div>' +
      '<div class="cr-field"><label for="cr-snip">Widget snippet</label><textarea id="cr-snip" class="input-field cr-code" readonly data-cr="snip"></textarea><button type="button" class="cr-link" data-copy="cr-snip" style="margin-top:6px">Copy</button></div>' +
      '<div class="cr-field"><label for="cr-ifr">Or an iframe</label><textarea id="cr-ifr" class="input-field cr-code" readonly data-cr="ifr"></textarea><button type="button" class="cr-link" data-copy="cr-ifr" style="margin-top:6px">Copy</button>' +
        '<div class="cr-hint">The site must be in the allowed list above. The small script resizes the frame to its content.</div></div>' +
      '<div class="cr-btns"><a class="cr-link" href="/careers" target="_blank" rel="noopener">View careers page ↗</a></div>';

    function renderQs() {
      var box = m.querySelector('[data-cr="qs"]');
      if (!questions.length) { box.innerHTML = '<div class="cr-hint" style="margin-bottom:8px">No extra questions. Applicants give name, email, phone, LinkedIn, resume and a cover letter.</div>'; return; }
      box.innerHTML = questions.map(function (q, i) {
        return '<div class="cr-q" data-qi="' + i + '">' +
          '<input class="input-field" aria-label="Question" data-qf="label" maxlength="200" value="' + esc(q.label || '') + '"' + dis + '>' +
          '<select class="input-field" aria-label="Answer type" data-qf="type"' + dis + '>' + ['text', 'textarea', 'select', 'boolean', 'number', 'url', 'email'].map(function (t) { return '<option' + (q.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
          '<label class="cr-check" style="margin:0"><input type="checkbox" data-qf="required"' + (q.required ? ' checked' : '') + dis + '> Required</label>' +
          (can ? '<button type="button" class="cr-x" aria-label="Remove question" data-qdel="' + i + '">×</button>' : '<span></span>') +
          (q.type === 'select' ? '<input class="input-field cr-qopts" aria-label="Options" data-qf="options" placeholder="Options, separated by commas" value="' + esc((q.options || []).join(', ')) + '"' + dis + '>' : '') +
          '</div>';
      }).join('');
      box.querySelectorAll('[data-qi]').forEach(function (row) {
        var i = +row.getAttribute('data-qi');
        row.querySelectorAll('[data-qf]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            var k = inp.getAttribute('data-qf');
            questions[i][k] = k === 'required' ? inp.checked : k === 'options' ? inp.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : inp.value;
            if (k === 'type') renderQs();
          });
        });
      });
      box.querySelectorAll('[data-qdel]').forEach(function (b) { b.addEventListener('click', function () { questions.splice(+b.getAttribute('data-qdel'), 1); renderQs(); }); });
    }
    renderQs();
    var add = m.querySelector('[data-cr="qadd"]');
    if (add) add.addEventListener('click', function () { questions.push({ label: '', type: 'text', required: false }); renderQs(); var ins = m.querySelectorAll('[data-qf="label"]'); if (ins.length) ins[ins.length - 1].focus(); });

    function snippet() {
      var g = function (k) { return (m.querySelector('[data-e="' + k + '"]').value || '').trim(); };
      var attrs = '';
      if (g('department')) attrs += ' data-department="' + esc(g('department')) + '"';
      attrs += ' data-limit="' + (parseInt(g('limit'), 10) || 10) + '"';
      if (g('apply') === 'modal') attrs += ' data-apply="modal"';
      if (g('theme') !== 'auto') attrs += ' data-theme="' + g('theme') + '"';
      m.querySelector('[data-cr="snip"]').value = '<div id="eversoft-jobs"></div>\n<script src="' + base + '/careers/widget.js"' + attrs + ' async></script>';
      var qp = '?embed=1' + (g('department') ? '&department=' + encodeURIComponent(g('department')) : '');
      m.querySelector('[data-cr="ifr"]').value = '<iframe id="eversoft-careers" src="' + base + '/careers' + qp + '" title="Open positions" style="width:100%;height:700px;border:0" loading="lazy"></iframe>\n' +
        '<script>addEventListener("message",function(e){if(e.origin==="' + base + '"&&e.data&&e.data.type==="eversoft-careers-height"){document.getElementById("eversoft-careers").style.height=e.data.height+"px";}});</script>';
    }
    m.querySelectorAll('[data-e]').forEach(function (i) { i.addEventListener('input', snippet); i.addEventListener('change', snippet); });
    snippet();
    m.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ta = m.querySelector('#' + b.getAttribute('data-copy'));
        var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
        else { ta.select(); document.execCommand('copy'); done(); }
      });
    });
    m.querySelectorAll('[data-cr="close"]').forEach(function (b) { b.addEventListener('click', close); });
    var save = m.querySelector('[data-cr="save"]');
    if (save) save.addEventListener('click', function () {
      var v = function (k) { return m.querySelector('[data-s="' + k + '"]'); };
      var body = {
        enabled: v('enabled').checked, showSalary: v('showSalary').checked, showApplicants: v('showApplicants').checked,
        privacyUrl: v('privacyUrl').value.trim(), notifyEmails: v('notifyEmails').value, intro: v('intro').value.trim(),
        allowedOrigins: v('allowedOrigins').value.split(/[\s,]+/).filter(Boolean),
        publicFields: Array.prototype.map.call(m.querySelectorAll('[data-pf]:checked:not([disabled])'), function (i) { return i.getAttribute('data-pf'); }),
        questions: questions.filter(function (q) { return (q.label || '').trim(); })
      };
      save.disabled = true;
      api('/api/recruit/careers/settings', { method: 'PUT', body: body }).then(function (nd) {
        renderSettings(m, nd, close);
        var dropped = body.allowedOrigins.length - (nd.settings.allowedOrigins || []).length;
        m.querySelector('[data-cr="smsg"]').innerHTML = '<div class="cr-ok">Settings saved.' + (dropped > 0 ? ' ' + dropped + ' invalid website entr' + (dropped === 1 ? 'y was' : 'ies were') + ' ignored (use https://host only).' : '') + '</div>';
      }).catch(function (e) { save.disabled = false; m.querySelector('[data-cr="smsg"]').innerHTML = '<div class="cr-err">' + esc(e.message) + '</div>'; });
    });
  }

  /* ── page lifecycle ────────────────────────────────────────────────────── */
  function subId(sub) { var m = /^\/(\d+)$/.exec(sub || ''); return m ? +m[1] : null; }

  function mount(root, sub) {
    injectStyle();
    state.root = root;
    shell(root);
    renderTabs({});
    api('/api/recruit/applications/meta').then(function (meta) {
      state.meta = meta; fillJobs();
      if (state.detailId) openDrawer(state.detailId);
    }).catch(function () {});
    load();
    var id = subId(sub);
    if (id) openDrawer(id);
  }
  function update(root, sub) {
    var id = subId(sub);
    if (id) openDrawer(id); else closeDrawer(false);
  }
  function unmount() {
    closeDrawer(false);
    state.root = null; state.token++;
  }

  function boot() {
    SC = window.HRMSSidecar;
    if (!SC) return false;
    SC.register({ base: BASE, title: 'Job Applications', mount: mount, update: update, unmount: unmount });
    return true;
  }
  if (!boot()) {
    var tries = 0;
    var t = setInterval(function () { if (boot() || ++tries > 50) clearInterval(t); }, 100);
  }
})();
