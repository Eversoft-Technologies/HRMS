/**
 * hrms-att-policy.js  v1
 * Attendance policy profiles (workstream P).
 *
 * 1. Settings page /settings/attendance-policies (HRMSSidecar):
 *      Profiles  — list (default badge, scope chips, employee counts) and the
 *                  editor: General & hours · Punctuality & penalties ·
 *                  Short leave & regularization · Overtime & comp-off ·
 *                  individual assignments · "who would get this profile" preview
 *      Who gets which — every employee, the profile that applies and why
 *      Penalties — by month / employee / status; waive with a note
 *    Backend: api/attendance_ext/policy_views.py
 *      GET/POST /api/attendance/policies · GET/PATCH/DELETE /api/attendance/policies/<id>
 *      GET/POST /api/attendance/policies/assignments · GET|POST /api/attendance/policies/preview
 *      GET /api/attendance/policies/options · GET /api/attendance/penalties · POST .../<id>/waive
 *    Reading: settings.view / settings.manage / attendance.edit; writing: settings.manage.
 *
 * 2. Check In / Out page: a "Short leave" section appended INSIDE the missed-
 *    punch card (#hrms-att-regz, owned by hrms-attendance-actions.js — not
 *    React) — quota, "Request short leave" form, this month's requests,
 *    cancel. Approvals happen in My Team (type 'short_leave').
 *    Backend: api/attendance_ext/short_leave.py
 *
 * Only our own nodes are created / removed; React-owned DOM is never touched.
 */
(function () {
  'use strict';
  if (window.__hrmsAttPolicyLoaded) return;
  window.__hrmsAttPolicyLoaded = true;

  var BASE = '/settings/attendance-policies';
  var STYLE_ID = 'hrms-ap-style';
  var SC = null;
  var S = {
    root: null, token: 0, tab: 'profiles', list: null, opts: null, sel: null, form: null, section: 'general',
    preview: null, who: null, whoQ: '', pens: null, penMonth: '', penStatus: '', penQ: '', msg: null, modal: null
  };

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(url, opts) {
    if (SC) return SC.api(url, opts);
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) {}
        if (!r.ok) { var e = new Error((d && (d.message || d.detail)) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function me() { try { return (JSON.parse(localStorage.getItem('hrms_session') || '{}').email || '').toLowerCase(); } catch (_) { return ''; } }
  function fmtDate(v) {
    if (!v) return '—';
    try { if (window.HRMSCompany && window.HRMSCompany.date) return window.HRMSCompany.date(v); } catch (_) {}
    return String(v);
  }
  function hm(m) { m = parseInt(m, 10) || 0; return Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm'; }
  function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function badge(t, cls) { return '<span class="ap-badge ' + (cls || 'ap-c-muted') + '">' + esc(t) + '</span>'; }
  var SOURCE = { assignment: 'Individual', department: 'Department', location: 'Location', 'default': 'Default', builtin: 'Built-in' };
  var PSTATUS = { applied: ['Leave deducted', 'ap-c-warn'], lop: ['Loss of Pay', 'ap-c-danger'], warned: ['Warning', 'ap-c-accent'], waived: ['Waived', 'ap-c-muted'] };

  /* ── style (one block, prefix ap-) ───────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.ap-page{max-width:1280px;margin:0 auto;color:var(--text)}',
      '.ap-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap}',
      '.ap-h1{font-size:20px;font-weight:700;margin:0}',
      '.ap-sub{font-size:13px;color:var(--text2);margin-top:4px;max-width:820px;line-height:1.5}',
      '.ap-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:0 0 14px;flex-wrap:wrap}',
      '.ap-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;font-family:inherit;margin-bottom:-1px}',
      '.ap-tab.on{color:var(--accent);border-bottom-color:var(--accent)}',
      '.ap-grid{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;align-items:start}',
      '@media (max-width:900px){.ap-grid{grid-template-columns:1fr}}',
      '.ap-list{display:flex;flex-direction:column;gap:8px}',
      '.ap-prof{display:block;width:100%;text-align:left;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;color:var(--text);font-family:inherit}',
      '.ap-prof:hover{border-color:var(--accent)}',
      '.ap-prof.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}',
      '.ap-prof.off{opacity:.6}',
      '.ap-prof b{display:block;font-size:14px;margin-bottom:6px}',
      '.ap-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--text2)}',
      '.ap-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}',
      '.ap-c-accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}',
      '.ap-c-success{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}',
      '.ap-c-warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}',
      '.ap-c-danger{color:var(--danger);background:color-mix(in srgb,var(--danger) 13%,transparent)}',
      '.ap-c-muted{color:var(--text2);background:var(--bg3);border-color:var(--border)}',
      '.ap-panel{padding:18px;min-width:0}',
      '.ap-secs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}',
      '.ap-sec{background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.ap-sec.on{color:var(--accent);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}',
      '.ap-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}',
      '.ap-field>label{display:block;font-size:11px;font-weight:700;color:var(--text2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.6px}',
      '.ap-field .input-field,.ap-field select,.ap-field textarea{width:100%;box-sizing:border-box}',
      '.ap-wide{grid-column:1 / -1}',
      '.ap-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.45}',
      '.ap-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer;user-select:none}',
      '.ap-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.ap-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--bg3);border:1px solid var(--border);font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit}',
      '.ap-chip.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}',
      '.ap-chip i{font-style:normal;font-weight:700;font-size:11px}',
      '.ap-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:16px;align-items:center}',
      '.ap-ghost{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.ap-ghost:hover{border-color:var(--accent)}',
      '.ap-danger:hover{border-color:var(--danger);color:var(--danger)}',
      '.ap-wrap{overflow-x:auto}',
      '.ap-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.ap-table th{text-align:left;font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.7px;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}',
      '.ap-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
      '.ap-muted{color:var(--text2)}',
      '.ap-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
      '.ap-bar .input-field{width:auto;min-width:130px;padding:7px 10px}',
      '.ap-bar .ap-grow{flex:1;min-width:180px}',
      '.ap-empty{padding:26px 10px;text-align:center;color:var(--text2);font-size:13px}',
      '.ap-err{padding:10px 12px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);font-size:13px;margin-bottom:12px;white-space:pre-wrap}',
      '.ap-ok{padding:10px 12px;border-radius:8px;color:var(--success);background:color-mix(in srgb,var(--success) 11%,transparent);font-size:13px;margin-bottom:12px}',
      '.ap-box{border:1px dashed var(--border2,var(--border));border-radius:10px;padding:12px 14px;margin-top:16px;background:var(--bg2)}',
      '.ap-box h4{margin:0 0 8px;font-size:13px}',
      '.ap-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px}',
      '.ap-kpi{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:9px 12px}',
      '.ap-kpi span{font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px}',
      '.ap-kpi b{display:block;font-size:19px;margin-top:2px}',
      '.ap-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}',
      '.ap-modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:100%;max-width:480px;padding:20px;color:var(--text);max-height:90vh;overflow:auto;box-sizing:border-box}',
      '.ap-modal h3{margin:0 0 14px;font-size:16px}',
      '.ap-modal .ap-field{margin-bottom:12px}',
      '.ap-busy{opacity:.6;pointer-events:none}',
      '.ap-assign{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}',
      '.ap-assign .input-field{flex:1;min-width:200px}',
      /* employee short-leave section (inside the missed-punch card) */
      '.ap-sl{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}',
      '.ap-sl-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ap-sl-head b{font-size:14px;color:var(--text)}',
      '.ap-sl-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:9px 12px;margin-top:8px;font-size:12.5px;color:var(--text)}',
      '.ap-sl-row.st-Approved{border-left-color:var(--success)}',
      '.ap-sl-row.st-Rejected,.ap-sl-row.st-Cancelled{border-left-color:var(--border2,var(--border));opacity:.75}',
      '.ap-sl-btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.ap-sl-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '@media (max-width:560px){.ap-panel{padding:14px}.ap-fields{grid-template-columns:1fr}.ap-table{font-size:12px}.ap-table th,.ap-table td{padding:7px 6px}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── field model ─────────────────────────────────────────────────────── */
  var SECTIONS = [
    ['general', 'General & hours'], ['punctuality', 'Punctuality & penalties'],
    ['short', 'Short leave & regularization'], ['overtime', 'Overtime & comp-off'], ['assign', 'Scope & assignments']
  ];
  // [field, label, type, hint]
  var FIELDS = {
    general: [
      ['name', 'Profile name', 'text', ''],
      ['priority', 'Priority', 'num', 'When two profiles match one employee at the same level, the higher priority wins.'],
      ['description', 'Description', 'area', ''],
      ['is_active', 'Active', 'bool', ''],
      ['is_default', 'Default profile (everyone not matched otherwise)', 'bool', ''],
      ['use_shift_hours', 'Full day = shift length minus break', 'bool', 'When on, the shift decides the full day; the minutes below are used for staff without a shift.'],
      ['full_day_minutes', 'Full day (minutes)', 'num', 'At or above: present (or late). 480 = 8h.'],
      ['half_day_minutes', 'Half-day minimum (minutes)', 'num', 'Below this: absent; between this and a full day: half-day. 270 = 4h 30m.']
    ],
    punctuality: [
      ['grace_checkin_minutes', 'Check-in grace (minutes)', 'num', 'Arriving later than shift start + grace is late.'],
      ['grace_early_out_minutes', 'Early-out grace (minutes)', 'num', 'Leaving earlier than shift end − grace is an early out.'],
      ['late_half_day_after_minutes', 'Late by more than this = half-day (minutes)', 'num', '0 = off.'],
      ['free_lates_per_month', 'Free late arrivals per month', 'num', 'Every later occurrence in the month is penalised.'],
      ['count_early_outs', 'Early outs count towards the allowance', 'bool', ''],
      ['penalty_action', 'Penalty', 'action', ''],
      ['penalty_leave_types', 'Deduct from (in order)', 'leaves', 'The first type with ½ day available is used; with none, ½ day Loss of Pay.']
    ],
    short: [
      ['short_leaves_per_month', 'Short leaves per month', 'num', '0 = short leave not available.'],
      ['short_leave_max_minutes', 'Longest short leave (minutes)', 'num', 'Approved short leave counts as worked time and is never late / early out.'],
      ['regularize_within_days', 'Regularize missed punches within (days)', 'num', 'Deadline for flagged days; 0 = the missed-punch policy setting.']
    ],
    overtime: [
      ['overtime_after_minutes', 'Overtime after (minutes worked)', 'numnull', 'Blank = the shift setting.'],
      ['overtime_daily_cap_minutes', 'Daily overtime cap (minutes)', 'num', ''],
      ['overtime_weekly_cap_minutes', 'Weekly overtime cap (minutes)', 'num', ''],
      ['overtime_requires_approval', 'Overtime needs approval', 'bool', ''],
      ['comp_off_enabled', 'Comp-off for weekend / holiday work', 'bool', ''],
      ['comp_off_half_day_minutes', 'Comp-off ½ day after (minutes)', 'num', ''],
      ['comp_off_full_day_minutes', 'Comp-off full day after (minutes)', 'num', ''],
      ['comp_off_leave_type', 'Comp-off leave type', 'text', ''],
      ['comp_off_expiry_days', 'Comp-off expires after (days)', 'num', '']
    ]
  };

  function blankForm() {
    var b = (S.list && S.list.builtin) || {};
    var f = { id: null, name: '', description: '', is_active: true, is_default: !(S.list && S.list.profiles && S.list.profiles.length),
      priority: 0, departments: [], locations: [], assignments: [] };
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) f[k] = Array.isArray(b[k]) ? b[k].slice() : b[k];
    return f;
  }
  function selProfile() {
    var ps = (S.list && S.list.profiles) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === S.sel) return ps[i];
    return null;
  }
  function canManage() { return !!(S.list && S.list.canManage); }
  function flash(kind, text) { S.msg = { kind: kind, text: text }; paintMsg(); }
  function fail(e) { flash('err', (e && e.message) || 'Something went wrong.'); }
  function paintMsg() {
    var el = S.root && S.root.querySelector('[data-ap="msg"]');
    if (!el) return;
    el.innerHTML = S.msg ? '<div class="' + (S.msg.kind === 'ok' ? 'ap-ok' : 'ap-err') + '">' + esc(S.msg.text) + '</div>' : '';
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  function load() {
    var tok = ++S.token;
    return Promise.all([api('/api/attendance/policies'), S.opts ? Promise.resolve(S.opts) : api('/api/attendance/policies/options')])
      .then(function (r) {
        if (tok !== S.token || !S.root) return;
        S.list = r[0]; S.opts = r[1];
        if (S.sel && !selProfile()) S.sel = null;
        if (!S.form) {
          if (!S.sel && S.list.profiles.length) S.sel = S.list.profiles[0].id;
          if (S.sel) openProfile(S.sel); else S.form = blankForm();
        }
        paint();
      }).catch(function (e) {
        if (tok !== S.token || !S.root) return;
        S.root.innerHTML = '<div class="ap-page"><div class="ap-err">' + esc(e.message || 'Could not load attendance policies.') + '</div></div>';
      });
  }
  function openProfile(id) {
    S.sel = id; S.preview = null;
    var p = selProfile();
    S.form = p ? JSON.parse(JSON.stringify(p)) : blankForm();
    S.form.assignments = S.form.assignments || [];
    if (id) api('/api/attendance/policies/' + id).then(function (d) {
      if (S.form && S.form.id === id) { S.form.assignments = d.assignments || []; paintPanel(); }
    }).catch(function () {});
  }

  /* ── render: page ────────────────────────────────────────────────────── */
  function paint() {
    var r = S.root; if (!r) return;
    var h = '<div class="ap-page"><div class="ap-head"><div><h1 class="ap-h1">Attendance Policies</h1>' +
      '<div class="ap-sub">A profile sets how a day is counted (full / half day / absent from hours worked), punctuality grace and penalties, short leave and the regularization deadline. ' +
      'Each employee follows one profile: individual assignment, else their department, else their location, else the default — or the built-in defaults when nothing matches. ' +
      'Changes apply to days closed from now on; use <code>manage.py recalc_attendance --policy</code> to re-evaluate past days.</div></div>';
    if (canManage() && S.tab === 'profiles') h += '<button type="button" class="btn-primary btn-sm" data-act="new">+ New profile</button>';
    h += '</div><div class="ap-tabs">' +
      tabBtn('profiles', 'Profiles') + tabBtn('who', 'Who gets which profile') + tabBtn('penalties', 'Penalties') + '</div>' +
      '<div data-ap="msg"></div><div data-ap="body"></div></div>';
    r.innerHTML = h;
    paintMsg();
    paintBody();
  }
  function tabBtn(id, label) { return '<button type="button" class="ap-tab' + (S.tab === id ? ' on' : '') + '" data-act="tab" data-tab="' + id + '">' + esc(label) + '</button>'; }
  function paintBody() {
    var b = S.root && S.root.querySelector('[data-ap="body"]'); if (!b) return;
    if (S.tab === 'who') return paintWho(b);
    if (S.tab === 'penalties') return paintPenalties(b);
    var ps = S.list.profiles || [];
    var h = '<div class="ap-grid"><div class="ap-list">';
    ps.forEach(function (p) {
      var chips = (p.departments || []).map(function (d) { return badge(d, 'ap-c-accent'); }).join('') +
        (p.locations || []).map(function (d) { return badge(d, 'ap-c-muted'); }).join('');
      h += '<button type="button" class="ap-prof' + (p.id === S.sel ? ' on' : '') + (p.is_active ? '' : ' off') + '" data-act="pick" data-id="' + p.id + '">' +
        '<b>' + esc(p.name) + '</b><div class="ap-meta">' + (p.is_default ? badge('Default', 'ap-c-success') : '') + (p.is_active ? '' : badge('Inactive')) +
        '<span>' + p.employee_count + ' employee' + (p.employee_count === 1 ? '' : 's') + '</span>' +
        (p.assignment_count ? '<span>· ' + p.assignment_count + ' assigned</span>' : '') + '</div>' +
        (chips ? '<div class="ap-meta" style="margin-top:6px">' + chips + '</div>' : '') + '</button>';
    });
    if (!ps.length) h += '<div class="ap-empty card">No profiles yet — everyone follows the built-in defaults.</div>';
    if (S.list.builtinCount) h += '<div class="ap-meta" style="padding:4px 2px">' + S.list.builtinCount + ' employee' + (S.list.builtinCount === 1 ? '' : 's') + ' on the built-in defaults</div>';
    h += '</div><div class="card ap-panel" data-ap="panel"></div></div>';
    b.innerHTML = h;
    paintPanel();
  }

  /* ── render: editor ──────────────────────────────────────────────────── */
  function fieldHtml(f, def) {
    var k = def[0], label = def[1], type = def[2], hint = def[3], v = f[k], ro = canManage() ? '' : ' disabled';
    var h = '<div class="ap-field' + (type === 'area' || type === 'leaves' ? ' ap-wide' : '') + '">';
    if (type === 'bool') {
      h += '<label class="ap-check" style="text-transform:none;letter-spacing:0;font-size:13px;font-weight:500;color:var(--text)"><input type="checkbox" data-f="' + k + '"' + (v ? ' checked' : '') + ro + '> ' + esc(label) + '</label>';
    } else {
      h += '<label>' + esc(label) + '</label>';
      if (type === 'area') h += '<textarea class="input-field" rows="2" data-f="' + k + '"' + ro + '>' + esc(v || '') + '</textarea>';
      else if (type === 'action') {
        h += '<select class="input-field" data-f="' + k + '"' + ro + '>' + ((S.opts && S.opts.penaltyActions) || []).map(function (a) {
          return '<option value="' + esc(a.value) + '"' + (a.value === v ? ' selected' : '') + '>' + esc(a.label) + '</option>';
        }).join('') + '</select>';
      } else if (type === 'leaves') {
        var sel = v || [];
        var all = ((S.opts && S.opts.leaveTypes) || []).slice();
        sel.forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); });
        h += '<div class="ap-chips">' + all.map(function (t) {
          var i = sel.indexOf(t);
          return '<button type="button" class="ap-chip' + (i >= 0 ? ' on' : '') + '" data-act="leave" data-v="' + esc(t) + '"' + ro + '>' + (i >= 0 ? '<i>' + (i + 1) + '</i>' : '') + esc(t) + '</button>';
        }).join('') + '</div>';
      } else {
        var num = type === 'num' || type === 'numnull';
        h += '<input class="input-field" ' + (num ? 'type="number" min="0" step="1"' : 'type="text"') + ' data-f="' + k + '" data-t="' + type + '" value="' + esc(v == null ? '' : v) + '"' + ro + '>';
        if (num && /minutes/.test(k) && v) hint = (hint ? hint + ' ' : '') + '(' + hm(v) + ')';
      }
    }
    if (hint) h += '<div class="ap-hint">' + esc(hint) + '</div>';
    return h + '</div>';
  }
  function scopeChips(kind, values, picked) {
    var low = picked.map(function (x) { return String(x).toLowerCase(); });
    var all = values.slice();
    picked.forEach(function (x) { if (all.map(function (y) { return y.toLowerCase(); }).indexOf(String(x).toLowerCase()) < 0) all.push(x); });
    if (!all.length) return '<div class="ap-hint">No ' + kind + ' values on employee profiles yet.</div>';
    return '<div class="ap-chips">' + all.map(function (v) {
      var on = low.indexOf(String(v).toLowerCase()) >= 0;
      return '<button type="button" class="ap-chip' + (on ? ' on' : '') + '" data-act="scope" data-k="' + kind + '" data-v="' + esc(v) + '"' + (canManage() ? '' : ' disabled') + '>' + (on ? '✓ ' : '') + esc(v) + '</button>';
    }).join('') + '</div>';
  }
  function paintPanel() {
    var el = S.root && S.root.querySelector('[data-ap="panel"]'); if (!el || !S.form) return;
    var f = S.form, h = '';
    h += '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px"><h2 style="margin:0;font-size:17px">' +
      esc(f.id ? f.name : 'New profile') + '</h2>' + (f.id ? '<span class="ap-meta">' + (f.is_default ? badge('Default', 'ap-c-success') : '') +
      '<span>' + (f.employee_count || 0) + ' employees</span></span>' : '') + '</div>';
    h += '<div class="ap-secs">' + SECTIONS.map(function (s) { return '<button type="button" class="ap-sec' + (S.section === s[0] ? ' on' : '') + '" data-act="sec" data-sec="' + s[0] + '">' + esc(s[1]) + '</button>'; }).join('') + '</div>';
    if (S.section === 'assign') {
      h += '<div class="ap-field"><label>Departments</label>' + scopeChips('departments', (S.opts && S.opts.departments) || [], f.departments || []) + '</div>';
      h += '<div class="ap-field" style="margin-top:12px"><label>Locations</label>' + scopeChips('locations', (S.opts && S.opts.locations) || [], f.locations || []) +
        '<div class="ap-hint">Department matches win over location matches; an individual assignment wins over both.</div></div>';
      h += '<div class="ap-field" style="margin-top:14px"><label>Individual assignments</label>';
      if (!f.id) h += '<div class="ap-hint">Save the profile first, then assign individual employees.</div>';
      else {
        var as = f.assignments || [];
        h += as.length ? '<div class="ap-chips">' + as.map(function (a) {
          return '<span class="ap-chip on">' + esc(a.name || a.email) + (canManage() ? ' <button type="button" class="ap-ghost" style="padding:0 6px;font-size:12px" data-act="unassign" data-email="' + esc(a.email) + '" title="Remove">×</button>' : '') + '</span>';
        }).join('') + '</div>' : '<div class="ap-hint">Nobody is assigned individually.</div>';
        if (canManage()) h += '<div class="ap-assign"><input class="input-field" list="ap-emps" data-ap="assignq" placeholder="Search employee by name or email"><button type="button" class="ap-ghost" data-act="assign">Assign</button></div>' +
          '<datalist id="ap-emps">' + ((S.opts && S.opts.employees) || []).map(function (e) { return '<option value="' + esc(e.email) + '">' + esc(e.name + (e.department ? ' · ' + e.department : '')) + '</option>'; }).join('') + '</datalist>';
      }
      h += '</div>';
    } else {
      h += '<div class="ap-fields">' + FIELDS[S.section].map(function (d) { return fieldHtml(f, d); }).join('') + '</div>';
      if (S.section === 'overtime') h += '<div class="ap-hint" style="margin-top:10px">Overtime records and comp-off credits are computed by the overtime engine from these values.</div>';
    }
    h += '<div class="ap-btns"><button type="button" class="ap-ghost" data-act="preview">Preview who gets it</button>';
    if (canManage()) {
      if (f.id) h += '<button type="button" class="ap-ghost ap-danger" data-act="delete">Delete</button>';
      h += '<button type="button" class="btn-primary btn-sm" data-act="save">' + (f.id ? 'Save changes' : 'Create profile') + '</button>';
    }
    h += '</div><div data-ap="preview">' + previewHtml() + '</div>';
    el.innerHTML = h;
  }
  function previewHtml() {
    var p = S.preview; if (!p) return '';
    if (p.loading) return '<div class="ap-box"><div class="ap-muted">Working out who gets which profile…</div></div>';
    var target = S.form.id || p.draftId;
    var mine = p.rows.filter(function (r) { return r.profileId === target; });
    var h = '<div class="ap-box"><h4>With these settings, ' + mine.length + ' employee' + (mine.length === 1 ? '' : 's') + ' would follow this profile</h4>';
    if (!mine.length) return h + '<div class="ap-hint">Nobody — add departments, locations or individual assignments, or make it the default.</div></div>';
    h += '<div class="ap-wrap"><table class="ap-table"><thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Because of</th></tr></thead><tbody>' +
      mine.slice(0, 200).map(function (r) {
        return '<tr><td><b>' + esc(r.name) + '</b><div class="ap-muted" style="font-size:11.5px">' + esc(r.email) + '</div></td><td>' + esc(r.department || '—') + '</td><td>' + esc(r.location || '—') + '</td><td>' + badge(SOURCE[r.source] || r.source, 'ap-c-accent') + '</td></tr>';
      }).join('') + '</tbody></table></div>' + (mine.length > 200 ? '<div class="ap-hint">… and ' + (mine.length - 200) + ' more</div>' : '') + '</div>';
    return h;
  }

  /* ── render: who gets which ──────────────────────────────────────────── */
  function paintWho(b) {
    if (!S.who) {
      b.innerHTML = '<div class="card ap-panel"><div class="ap-empty">Loading…</div></div>';
      api('/api/attendance/policies/preview').then(function (d) { S.who = d; if (S.tab === 'who') paintBody(); }).catch(function (e) { S.who = { error: e.message, rows: [] }; paintBody(); });
      return;
    }
    if (S.who.error) { b.innerHTML = '<div class="ap-err">' + esc(S.who.error) + '</div>'; return; }
    var q = S.whoQ.toLowerCase();
    var rows = S.who.rows.filter(function (r) { return !q || (r.name + ' ' + r.email + ' ' + r.department + ' ' + r.location + ' ' + r.profileName).toLowerCase().indexOf(q) >= 0; });
    var counts = {};
    S.who.rows.forEach(function (r) { counts[r.profileName] = (counts[r.profileName] || 0) + 1; });
    var h = '<div class="card ap-panel"><div class="ap-kpis">' + Object.keys(counts).sort().map(function (k) { return '<div class="ap-kpi"><span>' + esc(k) + '</span><b>' + counts[k] + '</b></div>'; }).join('') + '</div>' +
      '<div class="ap-bar"><input class="input-field ap-grow" data-ap="whoq" placeholder="Search employee, department, location or profile" value="' + esc(S.whoQ) + '"></div>' +
      '<div class="ap-wrap"><table class="ap-table"><thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Profile</th><th>Because of</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) {
        return '<tr><td><b>' + esc(r.name) + '</b><div class="ap-muted" style="font-size:11.5px">' + esc(r.email) + '</div></td><td>' + esc(r.department || '—') + '</td><td>' + esc(r.location || '—') +
          '</td><td>' + esc(r.profileName) + '</td><td>' + badge(SOURCE[r.source] || r.source, r.source === 'builtin' ? 'ap-c-muted' : 'ap-c-accent') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="ap-empty">No employees match.</td></tr>') + '</tbody></table></div></div>';
    b.innerHTML = h;
  }

  /* ── render: penalties ───────────────────────────────────────────────── */
  function loadPens() {
    var qs = '?month=' + encodeURIComponent(S.penMonth || thisMonth()) + (S.penStatus ? '&status=' + encodeURIComponent(S.penStatus) : '');
    S.pens = null; S.pensLoading = true; paintBody();
    api('/api/attendance/penalties' + qs).then(function (d) { S.pens = d; })
      .catch(function (e) { S.pens = { error: e.message, results: [] }; })
      .then(function () { S.pensLoading = false; if (S.tab === 'penalties') paintBody(); });
  }
  function paintPenalties(b) {
    if (!S.penMonth) S.penMonth = thisMonth();
    var h = '<div class="card ap-panel"><div class="ap-bar"><input class="input-field" type="month" data-ap="pmonth" value="' + esc(S.penMonth) + '">' +
      '<select class="input-field" data-ap="pstatus"><option value="">All statuses</option>' + ['applied', 'lop', 'warned', 'waived'].map(function (s) {
        return '<option value="' + s + '"' + (S.penStatus === s ? ' selected' : '') + '>' + PSTATUS[s][0] + '</option>';
      }).join('') + '</select><input class="input-field ap-grow" data-ap="pq" placeholder="Filter by employee" value="' + esc(S.penQ) + '"></div>';
    if (!S.pens) { b.innerHTML = h + '<div class="ap-empty">Loading…</div></div>'; if (!S.pensLoading) loadPens(); return; }
    if (S.pens.error) { b.innerHTML = h + '<div class="ap-err">' + esc(S.pens.error) + '</div></div>'; return; }
    var q = S.penQ.toLowerCase();
    var rows = S.pens.results.filter(function (p) { return !q || (p.employee + ' ' + p.email).toLowerCase().indexOf(q) >= 0; });
    var sm = S.pens.summary || {};
    h += '<div class="ap-kpis">' + ['applied', 'lop', 'warned', 'waived'].map(function (s) { return '<div class="ap-kpi"><span>' + PSTATUS[s][0] + '</span><b>' + (sm[s] || 0) + '</b></div>'; }).join('') + '</div>';
    h += '<div class="ap-wrap"><table class="ap-table"><thead><tr><th>Date</th><th>Employee</th><th>Reason</th><th>Outcome</th><th>Note</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        var st = PSTATUS[p.status] || [p.statusLabel, 'ap-c-muted'];
        return '<tr><td style="white-space:nowrap">' + esc(fmtDate(p.date)) + '</td><td><b>' + esc(p.employee) + '</b><div class="ap-muted" style="font-size:11.5px">' + esc(p.email) + '</div></td>' +
          '<td>' + esc(p.kindLabel) + ' · ' + p.occurrence + (p.occurrence === 1 ? 'st' : p.occurrence === 2 ? 'nd' : p.occurrence === 3 ? 'rd' : 'th') + ' this month</td>' +
          '<td>' + badge(st[0], st[1]) + (p.status === 'applied' ? '<div class="ap-muted" style="font-size:11.5px">½ day ' + esc(p.leaveType) + '</div>' : '') +
          (p.paidRunId ? '<div class="ap-muted" style="font-size:11.5px">Deducted in run #' + p.paidRunId + '</div>' : '') + '</td>' +
          '<td class="ap-muted" style="max-width:260px">' + esc(p.note) + (p.waivedBy ? '<div style="font-size:11.5px">by ' + esc(p.waivedBy) + '</div>' : '') + '</td>' +
          '<td style="text-align:right">' + (p.canWaive ? '<button type="button" class="ap-ghost" data-act="waive" data-id="' + p.id + '">Waive</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="ap-empty">No penalties for this month.</td></tr>') + '</tbody></table></div></div>';
    b.innerHTML = h;
  }

  /* ── modal (note) ────────────────────────────────────────────────────── */
  function askNote(title, label, cb) {
    closeModal();
    var ov = document.createElement('div');
    ov.className = 'ap-overlay'; ov.setAttribute('data-ap-modal', '1');
    ov.innerHTML = '<div class="ap-modal" role="dialog" aria-modal="true"><h3>' + esc(title) + '</h3><div class="ap-field"><label>' + esc(label) + '</label>' +
      '<textarea class="input-field" rows="3" data-ap="note" style="width:100%;box-sizing:border-box"></textarea></div><div data-ap="merr"></div>' +
      '<div class="ap-btns"><button type="button" class="ap-ghost" data-m="cancel">Cancel</button><button type="button" class="btn-primary btn-sm" data-m="ok">Confirm</button></div></div>';
    document.body.appendChild(ov);
    S.modal = ov;
    var ta = ov.querySelector('textarea'); setTimeout(function () { ta.focus(); }, 30);
    ov.addEventListener('click', function (e) {
      var m = e.target.getAttribute && e.target.getAttribute('data-m');
      if (e.target === ov || m === 'cancel') return closeModal();
      if (m === 'ok') {
        var v = ta.value.trim();
        if (!v) { ov.querySelector('[data-ap="merr"]').innerHTML = '<div class="ap-err">A note is required.</div>'; return; }
        ov.querySelector('.ap-modal').classList.add('ap-busy');
        cb(v, function (errMsg) {
          if (errMsg) { ov.querySelector('.ap-modal').classList.remove('ap-busy'); ov.querySelector('[data-ap="merr"]').innerHTML = '<div class="ap-err">' + esc(errMsg) + '</div>'; }
          else closeModal();
        });
      }
    });
  }
  function closeModal() { if (S.modal && S.modal.parentNode) S.modal.parentNode.removeChild(S.modal); S.modal = null; }

  /* ── events ──────────────────────────────────────────────────────────── */
  function readForm() {
    if (!S.root || !S.form) return;
    var els = S.root.querySelectorAll('[data-f]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], k = el.getAttribute('data-f'), t = el.getAttribute('data-t');
      if (el.type === 'checkbox') S.form[k] = el.checked;
      else if (t === 'num') S.form[k] = el.value === '' ? 0 : parseInt(el.value, 10);
      else if (t === 'numnull') S.form[k] = el.value === '' ? null : parseInt(el.value, 10);
      else S.form[k] = el.value;
    }
  }
  function payload() {
    var f = S.form, out = {};
    var keys = ['name', 'description', 'is_default', 'is_active', 'priority', 'departments', 'locations'];
    for (var s in FIELDS) FIELDS[s].forEach(function (d) { if (keys.indexOf(d[0]) < 0) keys.push(d[0]); });
    keys.forEach(function (k) { if (f[k] !== undefined) out[k] = f[k]; });
    return out;
  }
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !S.root.contains(t) || t.disabled) return;
    var act = t.getAttribute('data-act');
    if (act === 'tab') { readForm(); S.tab = t.getAttribute('data-tab'); S.msg = null; if (S.tab === 'who') S.who = null; if (S.tab === 'penalties') S.pens = null; paint(); return; }
    if (act === 'pick') { S.msg = null; openProfile(+t.getAttribute('data-id')); paintBody(); paintMsg(); return; }
    if (act === 'new') { S.tab = 'profiles'; S.sel = null; S.form = blankForm(); S.section = 'general'; S.preview = null; S.msg = null; paint(); return; }
    if (act === 'sec') { readForm(); S.section = t.getAttribute('data-sec'); paintPanel(); return; }
    if (act === 'scope') {
      readForm();
      var k = t.getAttribute('data-k'), v = t.getAttribute('data-v'), arr = S.form[k] || [];
      var idx = -1; arr.forEach(function (x, i) { if (String(x).toLowerCase() === v.toLowerCase()) idx = i; });
      if (idx >= 0) arr.splice(idx, 1); else arr.push(v);
      S.form[k] = arr; S.preview = null; paintPanel(); return;
    }
    if (act === 'leave') {
      readForm();
      var lv = t.getAttribute('data-v'), la = S.form.penalty_leave_types || [], li = la.indexOf(lv);
      if (li >= 0) la.splice(li, 1); else la.push(lv);
      S.form.penalty_leave_types = la; paintPanel(); return;
    }
    if (act === 'preview') {
      readForm();
      S.preview = { loading: true }; paintPanel();
      var draft = { id: S.form.id, name: S.form.name || 'New profile', departments: S.form.departments, locations: S.form.locations,
        is_default: S.form.is_default, is_active: S.form.is_active, priority: S.form.priority };
      api('/api/attendance/policies/preview', { method: 'POST', body: { draft: draft } })
        .then(function (d) { S.preview = d; paintPanel(); }).catch(function (er) { S.preview = null; paintPanel(); fail(er); });
      return;
    }
    if (act === 'save') {
      readForm();
      var id = S.form.id;
      t.classList.add('ap-busy');
      api(id ? '/api/attendance/policies/' + id : '/api/attendance/policies', { method: id ? 'PATCH' : 'POST', body: payload() })
        .then(function (p) { S.sel = p.id; S.form = null; S.who = null; flash('ok', id ? 'Profile saved.' : 'Profile created.'); return load(); })
        .catch(function (er) { t.classList.remove('ap-busy'); fail(er); });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('Delete the profile "' + S.form.name + '"? Its employees fall back to the next matching profile.')) return;
      api('/api/attendance/policies/' + S.form.id, { method: 'DELETE' })
        .then(function () { S.sel = null; S.form = null; flash('ok', 'Profile deleted.'); return load(); }).catch(fail);
      return;
    }
    if (act === 'assign' || act === 'unassign') {
      var em;
      if (act === 'assign') { var inp = S.root.querySelector('[data-ap="assignq"]'); em = resolveEmp(inp ? inp.value : ''); if (!em) { flash('err', 'Pick an employee from the list.'); return; } }
      else em = t.getAttribute('data-email');
      var fid = S.form.id;
      api('/api/attendance/policies/assignments', { method: 'POST', body: { profileId: act === 'assign' ? fid : null, emails: [em] } })
        .then(function () { S.form = null; S.sel = fid; S.who = null; flash('ok', act === 'assign' ? 'Assigned.' : 'Assignment removed.'); S.section = 'assign'; return load(); })
        .catch(fail);
      return;
    }
    if (act === 'waive') {
      var pid = t.getAttribute('data-id');
      askNote('Waive penalty', 'Why is it waived? (shown to the employee)', function (note, done) {
        api('/api/attendance/penalties/' + pid + '/waive', { method: 'POST', body: { note: note } })
          .then(function () { done(); flash('ok', 'Penalty waived — any leave deducted was credited back.'); loadPens(); })
          .catch(function (er) { done(er.message || 'Could not waive.'); });
      });
    }
  }
  function resolveEmp(v) {
    v = String(v || '').trim().toLowerCase(); if (!v) return '';
    var es = (S.opts && S.opts.employees) || [];
    for (var i = 0; i < es.length; i++) if (es[i].email === v || es[i].name.toLowerCase() === v) return es[i].email;
    var hits = es.filter(function (e) { return (e.name + ' ' + e.email).toLowerCase().indexOf(v) >= 0; });
    return hits.length === 1 ? hits[0].email : '';
  }
  var qTimer = null;
  function onInput(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-ap');
    if (k !== 'whoq' && k !== 'pq') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(function () {
      if (k === 'whoq') S.whoQ = t.value; else S.penQ = t.value;
      paintBody();
      var n = S.root && S.root.querySelector('[data-ap="' + k + '"]');
      if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
    }, 200);
  }
  function onChange(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-ap');
    if (k === 'pmonth') { S.penMonth = t.value || thisMonth(); loadPens(); }
    else if (k === 'pstatus') { S.penStatus = t.value; loadPens(); }
  }

  function mount(root) {
    S.root = root; S.msg = null; S.form = null; S.preview = null; S.who = null; S.pens = null;
    injectStyle();
    root.innerHTML = '<div class="ap-page"><div class="ap-empty">Loading attendance policies…</div></div>';
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    load();
  }

  /* ═════════ 2. Employee: short leave on the Check In / Out page ═════════ */
  var SL = { data: null, loading: false, at: 0, open: false, msg: '', host: null };
  var SL_KINDS = [['early_out', 'Leave early'], ['late_in', 'Arrive late'], ['middle', 'Step out (mid-day)']];

  function slLoad(force) {
    if (SL.loading || (!force && SL.data && Date.now() - SL.at < 60000)) { slRender(); return; }
    SL.loading = true;
    api('/api/attendance/short-leave').then(function (d) { SL.data = d; SL.at = Date.now(); })
      .catch(function (e) { SL.data = { error: e.message }; SL.at = Date.now(); })
      .then(function () { SL.loading = false; slRender(); });
  }
  function slRender() {
    var el = SL.host; if (!el || !document.documentElement.contains(el)) return;
    var d = SL.data, h = '';
    if (!d) { el.innerHTML = ''; return; }
    if (d.error) { el.innerHTML = ''; return; }
    var q = d.quota || {}, left = q.limit ? q.remaining : 0;
    h += '<div class="ap-sl-head"><div><b>Short leave</b> <span class="ap-muted" style="font-size:12px">' +
      (q.limit ? left + ' of ' + q.limit + ' left · ' + esc(q.month) + ' · up to ' + hm(q.maxMinutes) : 'Not available under your attendance policy') + '</span></div>' +
      (q.limit ? '<button type="button" class="ap-sl-btn" data-sl="open"' + (left > 0 ? '' : ' disabled title="All short leaves for this month are used"') + '>Request short leave</button>' : '') + '</div>';
    if (SL.msg) h += '<div class="ap-ok" style="margin-top:8px">' + esc(SL.msg) + '</div>';
    (d.items || []).slice(0, 6).forEach(function (r) {
      var st = { Pending: 'ap-c-warn', Approved: 'ap-c-success', Rejected: 'ap-c-danger', Cancelled: 'ap-c-muted' }[r.status] || 'ap-c-muted';
      h += '<div class="ap-sl-row st-' + esc(r.status) + '"><div><b>' + esc(fmtDate(r.date)) + '</b> · ' + esc(r.kindLabel) + ' · ' + esc(r.fromLabel) + ' – ' + esc(r.toLabel) +
        ' <span class="ap-muted">(' + r.minutes + ' min)</span>' + (r.reviewerNote ? '<div class="ap-muted" style="font-size:11.5px">' + esc(r.reviewerNote) + '</div>' : '') + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center">' + badge(r.status, st) +
        (r.status === 'Pending' || r.status === 'Approved' ? '<button type="button" class="ap-ghost" style="padding:4px 9px;font-size:12px" data-sl="cancel" data-id="' + r.id + '">Cancel</button>' : '') + '</div></div>';
    });
    el.innerHTML = h;
  }
  function slForm() {
    closeModal();
    var today = new Date(), iso = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    var q = (SL.data && SL.data.quota) || {};
    var ov = document.createElement('div');
    ov.className = 'ap-overlay'; ov.setAttribute('data-ap-modal', '1');
    ov.innerHTML = '<div class="ap-modal" role="dialog" aria-modal="true"><h3>Request short leave</h3>' +
      '<div class="ap-field"><label>Date</label><input class="input-field" type="date" name="date" value="' + iso + '" style="width:100%;box-sizing:border-box"></div>' +
      '<div class="ap-field"><label>Type</label><select class="input-field" name="kind" style="width:100%">' + SL_KINDS.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="ap-fields" style="grid-template-columns:1fr 1fr"><div class="ap-field"><label>From</label><input class="input-field" type="time" name="fromTime"></div>' +
      '<div class="ap-field"><label>To</label><input class="input-field" type="time" name="toTime"></div></div>' +
      '<div class="ap-hint" style="margin:-4px 0 10px">At most ' + hm(q.maxMinutes || 0) + '. Leave early: "To" may stay empty (= shift end); arrive late: "From" may stay empty (= shift start).</div>' +
      '<div class="ap-field"><label>Reason</label><textarea class="input-field" name="reason" rows="3" style="width:100%;box-sizing:border-box"></textarea></div>' +
      '<div data-ap="merr"></div><div class="ap-btns"><button type="button" class="ap-ghost" data-m="cancel">Cancel</button><button type="button" class="btn-primary btn-sm" data-m="ok">Send to manager</button></div></div>';
    document.body.appendChild(ov);
    S.modal = ov;
    injectStyle();
    ov.addEventListener('click', function (e) {
      var m = e.target.getAttribute && e.target.getAttribute('data-m');
      if (e.target === ov || m === 'cancel') return closeModal();
      if (m !== 'ok') return;
      var g = function (n) { return ov.querySelector('[name="' + n + '"]').value; };
      var box = ov.querySelector('.ap-modal'); box.classList.add('ap-busy');
      api('/api/attendance/short-leave', { method: 'POST', body: { date: g('date'), kind: g('kind'), fromTime: g('fromTime'), toTime: g('toTime'), reason: g('reason').trim() } })
        .then(function () { closeModal(); SL.msg = 'Short leave sent to your manager for approval.'; slLoad(true); })
        .catch(function (er) { box.classList.remove('ap-busy'); ov.querySelector('[data-ap="merr"]').innerHTML = '<div class="ap-err">' + esc(er.message) + '</div>'; });
    });
  }
  function slClick(e) {
    var t = e.target.closest ? e.target.closest('[data-sl]') : null;
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-sl');
    if (a === 'open') { SL.msg = ''; slForm(); }
    else if (a === 'cancel') {
      if (!window.confirm('Cancel this short leave?')) return;
      api('/api/attendance/short-leave/' + t.getAttribute('data-id') + '/cancel', { method: 'POST', body: {} })
        .then(function () { SL.msg = 'Short leave cancelled.'; slLoad(true); }).catch(function (er) { SL.msg = er.message; slRender(); });
    }
  }
  function slEnsure() {
    if (String(location.pathname).replace(/\/+$/, '') !== '/employees/checkin') return;
    var card = document.getElementById('hrms-att-regz');            // hrms-attendance-actions.js's own card
    if (!card) return;
    var host = card.querySelector('#ap-sl-mount');
    if (!host) {
      injectStyle();
      host = document.createElement('div');
      host.id = 'ap-sl-mount'; host.className = 'ap-sl';
      host.addEventListener('click', slClick);
      card.appendChild(host);
      SL.host = host;
      if (SL.data) slRender();
      slLoad(false);
    } else if (SL.host !== host) { SL.host = host; slRender(); }
  }
  var slQueued = false;
  function slSchedule() { if (slQueued) return; slQueued = true; requestAnimationFrame(function () { slQueued = false; slEnsure(); }); }

  /* ── boot ─────────────────────────────────────────────────────────────── */
  function register() {
    SC = window.HRMSSidecar;
    SC.register({
      base: BASE, title: 'Attendance Policies', mount: mount, update: function () {},
      unmount: function () { S.token++; S.root = null; clearTimeout(qTimer); closeModal(); }
    });
  }
  function boot() {
    new MutationObserver(slSchedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', slSchedule);
    window.addEventListener('hrmsAttendanceSynced', function () { slLoad(true); });
    slSchedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  if (window.HRMSSidecar) register();
  else {
    var tries = 0, iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); }
      else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
