/* Settings › General › Leave Policy.
 *
 * The admin sets the leave types and how many days of each an employee gets
 * per calendar year (Casual, Sick, Earned, … or "no limit" for e.g. Loss of
 * Pay). GET/PUT /api/leave/policy; saving needs settings.manage. The Leave
 * page's balance card and Apply Leave picker read the same policy through
 * /api/leave/balance, and the server refuses a request beyond the balance
 * when "Stop requests beyond the balance" is on.
 *
 * Sits right after the Company Settings form (hrms-company-settings.js) as a
 * sibling — that form re-renders itself by replacing its own outerHTML, so
 * nothing may live inside it. Our card is ours to remove; React nodes are
 * never touched.
 */
(function () {
  'use strict';

  var ID = 'hrms-leave-policy';
  var ANCHOR = 'hrms-company-settings-root';
  var DEFAULTS = [{ name: 'Casual Leave', days: 12 }, { name: 'Sick Leave', days: 12 }, { name: 'Earned Leave', days: 15 }];
  var state = { loaded: false, loading: false, types: [], enforce: true, dirty: false, saving: false, msg: '', msgKind: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function onSettings() { return (location.pathname || '').replace(/\/+$/, '') === '/settings'; }
  function api(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error((d && (d.message || d.detail)) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  function ensureStyle() {
    if (document.getElementById(ID + '-style')) return;
    var st = document.createElement('style');
    st.id = ID + '-style';
    var R = '#' + ID;
    st.textContent =
      R + ' .lp-sub{font-size:12px;color:var(--text3);margin:-4px 0 14px;line-height:1.55}' +
      R + ' table{width:100%;border-collapse:collapse;font-size:13px}' +
      R + ' th{text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);padding:0 8px 8px}' +
      R + ' td{padding:6px 8px;border-top:1px solid var(--border2);vertical-align:middle}' +
      R + ' input[type=text],' + R + ' input[type=number]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border2);border-radius:8px;background:var(--bg2,var(--surface));color:var(--text);font:inherit}' +
      R + ' input[type=number]{max-width:110px}' +
      R + ' input:disabled{opacity:.45}' +
      R + ' .lp-nolimit{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);white-space:nowrap;cursor:pointer}' +
      R + ' .lp-x{border:none;background:transparent;color:var(--text3);font-size:18px;cursor:pointer;padding:2px 8px;border-radius:6px}' +
      R + ' .lp-x:hover{background:var(--bg3);color:var(--danger,#ef4444)}' +
      R + ' .lp-x:disabled{opacity:.3;cursor:not-allowed}' +
      R + ' .lp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px}' +
      R + ' .lp-add{border:1px dashed var(--border2);background:transparent;color:var(--accent);border-radius:8px;padding:7px 14px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}' +
      R + ' .lp-enf{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text2);margin-top:14px;cursor:pointer;line-height:1.45}' +
      R + ' .lp-total{font-size:12px;color:var(--text3)}' +
      R + ' .lp-msg{font-size:12.5px;min-height:18px}' + R + ' .lp-msg.ok{color:var(--success,#16a34a)}' + R + ' .lp-msg.err{color:var(--danger,#ef4444)}' +
      '@media(max-width:600px){' + R + ' th:nth-child(3){display:none}' + R + ' td{padding:6px 4px}}';
    document.head.appendChild(st);
  }

  function load() {
    if (state.loading) return;
    state.loading = true;
    api('/api/leave/policy').then(function (d) {
      state.types = (d && Array.isArray(d.types) && d.types.length ? d.types : DEFAULTS).map(function (t) { return { name: t.name, days: t.days }; });
      state.enforce = !(d && d.enforceBalance === false);
      state.loaded = true; state.dirty = false;
    }).catch(function (e) {
      state.types = DEFAULTS.slice(); state.loaded = true;
      state.msg = 'Could not load the leave policy: ' + e.message; state.msgKind = 'err';
    }).then(function () { state.loading = false; render(); });
  }

  function total() {
    var n = 0, open = false;
    state.types.forEach(function (t) { if (t.days == null) open = true; else n += Number(t.days) || 0; });
    return n + ' days a year' + (open ? ' + types with no limit' : '');
  }

  function html() {
    if (!state.loaded) return '<div class="card-title">Leave Policy</div><div class="lp-sub">Loading…</div>';
    var rows = state.types.map(function (t, i) {
      var nolimit = t.days == null;
      return '<tr data-i="' + i + '">' +
        '<td><input type="text" data-f="name" maxlength="60" value="' + esc(t.name) + '" placeholder="e.g. Casual Leave" aria-label="Leave type name"></td>' +
        '<td><input type="number" data-f="days" min="0" max="366" step="1" value="' + (nolimit ? '' : esc(t.days)) + '"' + (nolimit ? ' disabled placeholder="—"' : '') + ' aria-label="Days per year for ' + esc(t.name) + '"></td>' +
        '<td><label class="lp-nolimit"><input type="checkbox" data-f="nolimit"' + (nolimit ? ' checked' : '') + '> No limit</label></td>' +
        '<td style="width:36px;text-align:right"><button type="button" class="lp-x" data-a="del" title="Remove this leave type" aria-label="Remove ' + esc(t.name) + '"' + (state.types.length < 2 ? ' disabled' : '') + '>&times;</button></td>' +
        '</tr>';
    }).join('');
    return '<div class="card-title">Leave Policy</div>' +
      '<div class="lp-sub">The leave types employees can apply for and how many days of each they get per calendar year (January – December). ' +
      'Balances on the Leave page count leave approved this year. Tick <b>No limit</b> for types such as Loss of Pay.</div>' +
      '<table><thead><tr><th>Leave type</th><th>Days / year</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="lp-row"><button type="button" class="lp-add" data-a="add">+ Add leave type</button><span class="lp-total">Total: ' + esc(total()) + '</span></div>' +
      '<label class="lp-enf"><input type="checkbox" data-f="enforce"' + (state.enforce ? ' checked' : '') + '> <span><b>Stop requests beyond the balance</b><br>' +
      'An employee cannot apply for more days than they have left (requests still waiting for approval count too). Off: they can apply and the approver decides.</span></label>' +
      '<div class="lp-row"><span class="lp-msg ' + esc(state.msgKind) + '" role="status">' + esc(state.msg) + '</span>' +
      '<button type="button" class="btn-primary" data-a="save" style="padding:9px 20px"' + (state.saving || !state.dirty ? ' disabled' : '') + '>' + (state.saving ? 'Saving…' : 'Save leave policy') + '</button></div>';
  }

  function render() {
    var root = document.getElementById(ID);
    if (!root) return;
    var f = document.activeElement, fi = null, ff = null, sel = null;
    if (f && root.contains(f) && f.getAttribute('data-f')) {
      var tr = f.closest('tr'); fi = tr ? tr.getAttribute('data-i') : null; ff = f.getAttribute('data-f');
      try { sel = f.selectionStart; } catch (_) {}
    }
    root.innerHTML = html();
    if (ff) {   // keep the caret where the admin is typing
      var again = fi != null ? root.querySelector('tr[data-i="' + fi + '"] [data-f="' + ff + '"]') : root.querySelector('[data-f="' + ff + '"]');
      if (again) { again.focus(); try { if (sel != null) again.setSelectionRange(sel, sel); } catch (_) {} }
    }
  }

  function changed(msg) { state.dirty = true; state.msg = msg || ''; state.msgKind = ''; render(); }

  function wire(root) {
    root.addEventListener('input', function (e) {
      var el = e.target, f = el.getAttribute('data-f'), tr = el.closest('tr');
      if (!tr || (f !== 'name' && f !== 'days')) return;
      var t = state.types[+tr.getAttribute('data-i')];
      if (f === 'name') t.name = el.value;
      else t.days = el.value === '' ? '' : Number(el.value);
      state.dirty = true; state.msg = ''; state.msgKind = '';
      var btn = root.querySelector('[data-a="save"]'); if (btn && !state.saving) btn.disabled = false;
      var tot = root.querySelector('.lp-total'); if (tot) tot.textContent = 'Total: ' + total();
    });
    root.addEventListener('change', function (e) {
      var el = e.target, f = el.getAttribute('data-f');
      if (f === 'enforce') { state.enforce = el.checked; changed(); return; }
      if (f === 'nolimit') {
        var t = state.types[+el.closest('tr').getAttribute('data-i')];
        if (el.checked) { t.lastDays = t.days; t.days = null; }
        else t.days = (t.lastDays != null && t.lastDays !== '') ? t.lastDays : 12;
        changed();
      }
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-a]'); if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'add') {
        state.types.push({ name: '', days: 0 }); changed();
        var last = root.querySelector('tr:last-child [data-f="name"]'); if (last) last.focus();
      } else if (a === 'del') {
        var i = +b.closest('tr').getAttribute('data-i');
        state.types.splice(i, 1);
        changed('Removed. Requests already made with that type keep it; nobody can apply for it after you save.');
      } else if (a === 'save') save();
    });
  }

  function save() {
    var types = state.types.map(function (t) { return { name: String(t.name || '').trim(), days: t.days == null ? null : (t.days === '' ? '' : Number(t.days)) }; });
    for (var i = 0; i < types.length; i++) {
      if (!types[i].name) { state.msg = 'Every leave type needs a name.'; state.msgKind = 'err'; render(); return; }
      if (types[i].days === '' || (types[i].days != null && (!(types[i].days >= 0) || types[i].days % 1))) {
        state.msg = 'Enter whole days for "' + types[i].name + '" (or tick No limit).'; state.msgKind = 'err'; render(); return;
      }
    }
    state.saving = true; state.msg = ''; render();
    api('/api/leave/policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: types, enforceBalance: state.enforce }) })
      .then(function (d) {
        state.types = d.types.map(function (t) { return { name: t.name, days: t.days }; });
        state.enforce = d.enforceBalance !== false;
        state.dirty = false; state.msg = 'Saved. Employees see the new balances on the Leave page.'; state.msgKind = 'ok';
      })
      .catch(function (e) {
        state.msg = e.status === 403 ? 'Only administrators with the "Manage settings" permission can change the leave policy.' : 'Not saved: ' + e.message;
        state.msgKind = 'err';
      })
      .then(function () { state.saving = false; render(); });
  }

  function tick() {
    var root = document.getElementById(ID);
    var anchor = document.getElementById(ANCHOR);
    if (!onSettings() || !anchor || !anchor.parentNode) {
      if (root && root.parentNode) root.parentNode.removeChild(root);   // ours
      if (!onSettings()) state.loaded = false;                          // reload next visit
      return;
    }
    if (!root) {
      ensureStyle();
      root = document.createElement('div');
      root.id = ID;
      root.className = 'card';
      wire(root);
      if (!state.loaded) load();
      root.innerHTML = html();
    }
    if (anchor.nextElementSibling !== root) anchor.parentNode.insertBefore(root, anchor.nextSibling);
  }

  setInterval(tick, 300);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();
