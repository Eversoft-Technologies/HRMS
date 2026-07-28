/*
 * hrms-job-form-builder.js  v3
 * ---------------------------------------------------------------------------
 * Enterprise Job Form Builder for the pre-built React app (no-rebuild injection).
 *
 *   • Section-based form model (collapsible sections → fields).
 *   • Palette (Basic / Advanced field types), drag-and-drop ordering of fields
 *     across sections and of sections themselves, per-field settings, dropdowns
 *     from reusable Master Data, salary ranges in all world currencies,
 *     conditional show/hide logic, device-aware LIVE PREVIEW and form stats.
 *   • Tabs: Build · Options · Logic · Permissions. Header: Import / Export /
 *     Save as Template / Save & Publish. Footer quick-cards.
 *   • The real "Post a Job" form is rendered from the active schema (the app's
 *     modal is intercepted); a ⚙ on the card opens the builder. Core fields map
 *     to JobPost columns, the rest to JobPost.custom_fields.
 */
(function () {
  'use strict';

  var JOBS_PATH = '/recruit/job-board';
  var LS_CURRENCY = 'hrms_job_currency';
  var LS_OPTS = 'hrms_jobform_options';
  var CORE_KEYS = { title: 1, dept: 1, location: 1, type: 1, salary: 1, openings: 1, priority: 1, status: 1, remote: 1, description: 1 };

  var TYPES = {
    text: { label: 'Text Input', icon: 'Tt', cat: 'basic' },
    textarea: { label: 'Text Area', icon: '¶', cat: 'basic' },
    select: { label: 'Dropdown', icon: '▾', cat: 'basic' },
    multiselect: { label: 'Multi Select', icon: '☰', cat: 'basic' },
    date: { label: 'Date Picker', icon: '📅', cat: 'basic' },
    checkbox: { label: 'Checkbox', icon: '☑', cat: 'basic' },
    radio: { label: 'Radio Button', icon: '◉', cat: 'basic' },
    file: { label: 'File Upload', icon: '⬆', cat: 'basic' },
    number: { label: 'Number', icon: '#', cat: 'basic' },
    currency: { label: 'Currency', icon: '$', cat: 'basic' },
    email: { label: 'Email', icon: '@', cat: 'basic' },
    phone: { label: 'Phone Number', icon: '☎', cat: 'basic' },
    url: { label: 'URL', icon: '🔗', cat: 'basic' },
    salary: { label: 'Salary Range', icon: '$$', cat: 'advanced' },
    boolean: { label: 'Yes / No', icon: '⊘', cat: 'advanced' },
    rating: { label: 'Rating', icon: '★', cat: 'advanced' },
    heading: { label: 'Section Heading', icon: '§', cat: 'advanced' },
    richtext: { label: 'Rich Text', icon: '≣', cat: 'advanced' }
  };
  var OPTION_TYPES = { select: 1, multiselect: 1, radio: 1 };

  var state = {
    sections: [], master: {}, currencies: [], templates: [],
    loaded: false, _loading: false,
    activeTab: 'build', paletteTab: 'basic', device: 'desktop',
    activeSection: null, dragField: null, dragSection: null
  };
  function opts() { try { return JSON.parse(localStorage.getItem(LS_OPTS) || '{}') || {}; } catch (_) { return {}; } }
  function setOpts(o) { localStorage.setItem(LS_OPTS, JSON.stringify(o)); }

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function session() { try { return JSON.parse(localStorage.getItem('hrms_session') || '{}') || {}; } catch (_) { return {}; } }
  function actorEmail() { return session().email || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }
  function slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
  // A valid field key is never empty and never purely numeric (which would show
  // up as junk keys like "18" in stored custom_fields).
  function safeKey(s, fallbackSeed) { var k = slug(s); if (!k || /^\d+$/.test(k)) k = 'field_' + (fallbackSeed || slug(s) || Math.random().toString(36).slice(2, 6)); return k; }
  function uid(p) { return (p || 'f_') + Math.random().toString(36).slice(2, 9); }
  function onJobsPage() { return location.pathname.replace(/\/+$/, '').indexOf(JOBS_PATH) === 0; }
  function api(path, o) {
    return fetch(path, o).then(function (r) { return r.text().then(function (t) { var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } } if (!r.ok) throw new Error((d && (d.error || d.detail || d.message)) || ('Request failed (' + r.status + ')')); return d; }); });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function defaultCurrency() { return localStorage.getItem(LS_CURRENCY) || 'USD'; }
  function currencyByCode(code) { for (var i = 0; i < state.currencies.length; i++) if (state.currencies[i].code === code) return state.currencies[i]; return null; }
  function optionsFor(f) {
    if (f.masterKey && state.master[f.masterKey]) return state.master[f.masterKey].options || [];
    return (f.options || []).map(function (o) { return typeof o === 'string' ? { value: o, label: o } : o; });
  }
  function allFields() { var out = []; state.sections.forEach(function (s) { (s.fields || []).forEach(function (f) { out.push(f); }); }); return out; }
  function reqCount() { return allFields().filter(function (f) { return f.required; }).length; }

  function normField(f) {
    f = f || {};
    return {
      id: f.id || uid(), key: safeKey(f.key || f.label, f.type), label: f.label || 'Field',
      type: TYPES[f.type] ? f.type : 'text', required: !!f.required, placeholder: f.placeholder || '',
      help: f.help || '', width: f.width === 'half' ? 'half' : 'full', options: f.options || [],
      masterKey: f.masterKey, defaultValue: f.defaultValue, conditional: f.conditional, currency: f.currency, core: !!f.core || !!CORE_KEYS[f.key]
    };
  }
  function normalizeSchema(raw) {
    if (!Array.isArray(raw) || !raw.length) return [{ id: uid('sec_'), title: 'Job Details', collapsed: false, fields: [] }];
    if (raw[0] && Array.isArray(raw[0].fields)) {
      return raw.map(function (s, i) { return { id: s.id || uid('sec_'), title: s.title || ('Section ' + (i + 1)), collapsed: !!s.collapsed, fields: (s.fields || []).map(normField) }; });
    }
    return [{ id: uid('sec_'), title: 'Job Details', collapsed: false, fields: raw.map(normField) }];
  }
  function findField(fid) {
    for (var i = 0; i < state.sections.length; i++) {
      var fs = state.sections[i].fields;
      for (var j = 0; j < fs.length; j++) if (fs[j].id === fid) return { section: state.sections[i], field: fs[j], si: i, fi: j };
    }
    return null;
  }
  function sectionById(sid) { for (var i = 0; i < state.sections.length; i++) if (state.sections[i].id === sid) return state.sections[i]; return null; }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function load(cb) {
    state._loading = true;
    Promise.all([
      api('/api/job-form/config').catch(function () { return { schema: [] }; }),
      api('/api/master-data').catch(function () { return []; }),
      api('/api/currencies').catch(function () { return []; })
    ]).then(function (res) {
      state.sections = normalizeSchema((res[0] && res[0].schema) || []);
      state.master = {}; (res[1] || []).forEach(function (m) { state.master[m.key] = m; });
      state.currencies = res[2] || [];
      if (!state.activeSection && state.sections[0]) state.activeSection = state.sections[0].id;
      state.loaded = true; state._loading = false;
      if (cb) cb();
    });
  }
  function saveSchema() {
    // Never publish empty sections — they'd render as a stray title on the form.
    var payload = state.sections.filter(function (s) { return (s.fields || []).length; }).map(function (s) { return { id: s.id, title: s.title, collapsed: !!s.collapsed, fields: s.fields }; });
    return api('/api/job-form/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: payload }) });
  }
  function loadTemplates(cb) { api('/api/job-form/templates').then(function (r) { state.templates = r || []; if (cb) cb(); }).catch(function () { if (cb) cb(); }); }

  /* ══════════════════════════════ STYLES ════════════════════════════════ */
  function ensureStyle() {
    if (document.getElementById('jfb-style')) return;
    var css = [
      '#jfb-open-btn{display:inline-flex;align-items:center;gap:6px;margin-left:8px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;}',
      '#jfb-open-btn:hover{border-color:var(--accent);color:var(--accent);}',
      '.jfb-ovl,.pjf-ovl{position:fixed;inset:0;background:rgba(8,12,20,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;}',
      '.jfb-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:min(1300px,98vw);height:min(92vh,940px);display:flex;flex-direction:column;box-shadow:0 30px 90px rgba(0,0,0,.5);overflow:hidden;}',
      '.jfb-head{display:flex;align-items:center;gap:14px;padding:15px 22px;border-bottom:1px solid var(--border2);}',
      '.jfb-head .jfb-crumb{font-size:11px;color:var(--text3);margin-bottom:2px;}',
      '.jfb-head h2{margin:0;font-size:19px;color:var(--text);font-family:var(--font-d,inherit);}',
      '.jfb-head .jfb-sub{font-size:12px;color:var(--text3);margin-top:1px;}',
      '.jfb-head .sp{flex:1;}',
      '.jfb-hbtn{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:9px;padding:8px 13px;font-size:12.5px;font-weight:600;cursor:pointer;}',
      '.jfb-hbtn:hover{border-color:var(--accent);}',
      '.jfb-hbtn.primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
      '.jfb-x{width:34px;height:34px;border-radius:9px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;}',
      '.jfb-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--border2);}',
      '.jfb-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--text3);font-size:13px;font-weight:600;padding:11px 15px;cursor:pointer;}',
      '.jfb-tab.on{color:var(--accent);border-bottom-color:var(--accent);}',
      '.jfb-body{flex:1;overflow:hidden;display:flex;flex-direction:column;}',
      '.jfb-main{flex:1;overflow:hidden;display:flex;}',
      '.jfb-scroll{overflow-y:auto;padding:16px 18px;}',
      '.jfb-c-pal{width:210px;border-right:1px solid var(--border2);flex-shrink:0;}',
      '.jfb-c-canvas{flex:1;min-width:0;border-right:1px solid var(--border2);background:var(--bg);}',
      '.jfb-c-prev{width:430px;flex-shrink:0;}',
      '.jfb-h1{font-size:14px;font-weight:700;color:var(--text);margin:0 0 3px;}',
      '.jfb-h2{font-size:11.5px;color:var(--text3);margin:0 0 12px;}',
      '.jfb-sech{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);margin:0 0 9px;}',
      '.jfb-ptabs{display:flex;gap:4px;margin-bottom:12px;background:var(--bg3);border-radius:9px;padding:3px;}',
      '.jfb-ptab{flex:1;text-align:center;background:none;border:none;border-radius:7px;color:var(--text3);font-size:11.5px;font-weight:600;padding:6px;cursor:pointer;}',
      '.jfb-ptab.on{background:var(--bg2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.15);}',
      '.jfb-pal-btn{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:8px 10px;margin-bottom:6px;color:var(--text);font-size:12.5px;font-weight:500;cursor:grab;}',
      '.jfb-pal-btn:hover{border-color:var(--accent);color:var(--accent);}',
      '.jfb-pal-ic{width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg2);border-radius:6px;font-size:11px;font-weight:700;color:var(--accent);}',
      /* section cards */
      '.jfb-sec{border:1px solid var(--border2);border-radius:12px;margin-bottom:12px;background:var(--bg2);overflow:hidden;}',
      '.jfb-sec.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);}',
      '.jfb-sec.dropinto{border-color:var(--accent);}',
      '.jfb-sec-h{display:flex;align-items:center;gap:9px;padding:11px 13px;cursor:pointer;background:var(--bg3);}',
      '.jfb-sec-h .grip{color:var(--text3);cursor:grab;font-size:13px;}',
      '.jfb-sec-h .num{width:20px;height:20px;border-radius:6px;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.jfb-sec-h .tt{flex:1;font-size:13.5px;font-weight:700;color:var(--text);background:none;border:1px solid transparent;border-radius:6px;padding:3px 6px;min-width:0;}',
      '.jfb-sec-h .tt:focus{border-color:var(--border2);background:var(--bg2);outline:none;}',
      '.jfb-sec-b{padding:9px 11px;}',
      '.jfb-fld{display:flex;align-items:center;gap:9px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:9px 11px;margin-bottom:7px;cursor:grab;}',
      '.jfb-fld.drag{opacity:.35;}',
      '.jfb-fld .grip{color:var(--text3);cursor:grab;font-size:13px;}',
      '.jfb-fld .fic{width:20px;height:20px;border-radius:5px;background:var(--bg2);color:var(--text3);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.jfb-fld .lb{flex:1;min-width:0;font-size:12.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jfb-fld .lb .rq{color:var(--danger,#f75f4f);}',
      '.jfb-fld .lb .cnd{color:#8b5cf6;font-size:10px;margin-left:5px;}',
      '.jfb-ico{background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;padding:3px;border-radius:6px;}',
      '.jfb-ico:hover{color:var(--accent);background:var(--bg2);}',
      '.jfb-ico.del:hover{color:var(--danger,#f75f4f);}',
      '.jfb-addsec{width:100%;border:1px dashed var(--border2);background:none;color:var(--accent);border-radius:10px;padding:11px;font-size:12.5px;font-weight:600;cursor:pointer;}',
      '.jfb-addsec:hover{background:var(--bg3);}',
      '.jfb-empty{font-size:12px;color:var(--text3);text-align:center;padding:16px 8px;border:1px dashed var(--border2);border-radius:8px;}',
      /* preview */
      '.jfb-prev-top{display:flex;align-items:center;gap:8px;margin-bottom:12px;}',
      '.jfb-badge{font-size:10px;font-weight:700;background:rgba(34,211,165,.16);color:var(--success,#22d3a5);padding:2px 8px;border-radius:999px;}',
      '.jfb-dev{display:flex;gap:3px;margin-left:auto;background:var(--bg3);border-radius:8px;padding:3px;}',
      '.jfb-dev button{background:none;border:none;border-radius:6px;padding:5px 8px;color:var(--text3);cursor:pointer;font-size:13px;}',
      '.jfb-dev button.on{background:var(--accent);color:#fff;}',
      '.jfb-prev-frame{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:16px;margin:0 auto;transition:max-width .2s;}',
      '.jfb-stats{display:flex;align-items:center;gap:18px;margin-top:14px;padding:12px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;}',
      '.jfb-stat{text-align:center;}',
      '.jfb-stat b{display:block;font-size:18px;font-weight:800;color:var(--text);font-family:var(--font-d,inherit);}',
      '.jfb-stat span{font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}',
      '.jfb-stat.a b{color:var(--warn,#f7c94f);}.jfb-stat.r b{color:var(--danger,#f75f4f);}',
      '.jfb-viewlogic{margin-left:auto;background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:6px 11px;font-size:11.5px;font-weight:600;cursor:pointer;}',
      /* footer cards */
      '.jfb-foot{display:flex;gap:10px;padding:12px 18px;border-top:1px solid var(--border2);overflow-x:auto;}',
      '.jfb-fcard{flex:1;min-width:150px;display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:10px 12px;cursor:pointer;}',
      '.jfb-fcard:hover{border-color:var(--accent);}',
      '.jfb-fcard .ic{width:30px;height:30px;border-radius:8px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}',
      '.jfb-fcard b{display:block;font-size:12.5px;color:var(--text);}',
      '.jfb-fcard span{font-size:10.5px;color:var(--text3);}',
      /* generic controls */
      '.jfb-btn{background:var(--accent);color:#fff;border:none;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;}',
      '.jfb-btn.ghost{background:var(--bg3);color:var(--text);border:1px solid var(--border2);}',
      '.jfb-btn.sm{padding:6px 12px;font-size:12px;}',
      '.jfb-btn:disabled{opacity:.55;cursor:not-allowed;}',
      'label.jfb-lab{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin:0 0 5px;}',
      '.jfb-in,.jfb-sel,.jfb-ta{width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font:inherit;font-size:13px;outline:none;}',
      '.jfb-in:focus,.jfb-sel:focus,.jfb-ta:focus{border-color:var(--accent);}',
      '.jfb-ta{min-height:70px;resize:vertical;}',
      '.jfb-row{display:flex;gap:10px;}.jfb-row>*{flex:1;min-width:0;}',
      '.jfb-fgrp{margin-bottom:13px;}',
      '.jfb-ck{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text);cursor:pointer;}',
      '.jfb-hint{font-size:11px;color:var(--text3);margin-top:4px;}',
      '.jfb-mrow{background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:10px;}',
      '.jfb-mrow h4{margin:0 0 8px;font-size:13.5px;color:var(--text);}',
      '.jfb-tag{display:inline-flex;align-items:center;gap:5px;background:var(--bg2);border:1px solid var(--border2);border-radius:999px;padding:3px 6px 3px 10px;font-size:11.5px;color:var(--text);margin:0 6px 6px 0;}',
      '.jfb-tag button{background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;line-height:1;}',
      '.jfb-ed-ovl{position:fixed;inset:0;background:rgba(8,12,20,.5);z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px;}',
      '.jfb-ed{background:var(--bg2);border:1px solid var(--border2);border-radius:14px;width:min(540px,96vw);max-height:90vh;overflow-y:auto;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.5);}',
      '.jfb-ed h3{margin:0 0 14px;font-size:15px;color:var(--text);}',
      '.pjf-msg{font-size:12px;font-weight:600;}',
      '.pjf-msg.err{color:var(--danger,#f75f4f);}.pjf-msg.ok{color:var(--success,#22d3a5);}',
      /* preview + real form fields */
      '.pjf-form .pjf-sec-t{grid-column:1/-1;font-size:14px;font-weight:700;color:var(--text);margin:6px 0 2px;}',
      '.pjf-form .pjf-fgrp{margin-bottom:13px;}',
      '.pjf-form label.pjf-lab{display:block;font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:5px;}',
      '.pjf-form label.pjf-lab .req{color:var(--danger,#f75f4f);}',
      '.pjf-in,.pjf-sel,.pjf-ta{width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:9px 11px;color:var(--text);font:inherit;font-size:13.5px;outline:none;}',
      '.pjf-in:focus,.pjf-sel:focus,.pjf-ta:focus{border-color:var(--accent);}',
      '.pjf-ta{min-height:80px;resize:vertical;}',
      '.pjf-help{font-size:11px;color:var(--text3);margin-top:4px;}',
      '.pjf-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;}',
      '.pjf-w-full{grid-column:1 / -1;}',
      '.pjf-sal{display:flex;gap:8px;align-items:center;}.pjf-sal .pjf-cur{width:130px;flex-shrink:0;}.pjf-sal .to{font-size:12px;color:var(--text3);}',
      '.pjf-radio{display:flex;gap:14px;flex-wrap:wrap;padding-top:2px;}',
      '.pjf-radio label{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text);}',
      '.pjf-multi{border:1px solid var(--border2);border-radius:9px;padding:8px;background:var(--bg3);}',
      '.pjf-chips{display:flex;flex-wrap:wrap;gap:6px;}.pjf-chips:not(:empty){margin-bottom:8px;}',
      '.pjf-chip{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;border-radius:999px;padding:3px 6px 3px 11px;font-size:12px;font-weight:600;}',
      '.pjf-chip button{background:rgba(255,255,255,.25);border:none;color:#fff;cursor:pointer;font-size:12px;line-height:1;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;}',
      '.pjf-multi-add{display:flex;gap:8px;}.pjf-multi-add .pjf-msel{width:150px;flex:0 0 auto;}.pjf-multi-add .pjf-mtxt{flex:1;}',
      '.pjf-multi .pjf-sel,.pjf-multi .pjf-in{background:var(--bg2);}',
      '.pjf-err{color:var(--danger,#f75f4f);font-size:11px;margin-top:3px;display:none;}.pjf-err.on{display:block;}',
      '.pjf-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:min(700px,96vw);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.5);overflow:hidden;}',
      '.pjf-head{display:flex;align-items:center;gap:8px;padding:16px 20px;border-bottom:1px solid var(--border2);}',
      '.pjf-head h2{margin:0;font-size:18px;color:var(--text);font-family:var(--font-d,inherit);flex:1;}',
      '.pjf-gear{width:34px;height:34px;border-radius:9px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;}',
      '.pjf-gear:hover{border-color:var(--accent);color:var(--accent);}',
      '.pjf-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--border2);}',
      '.pjf-foot .pjf-msg{margin-right:auto;align-self:center;}',
      '@media(max-width:1000px){.jfb-c-pal{display:none;}.jfb-c-prev{display:none;}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'jfb-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ══════════════════════════════ BUILDER ═══════════════════════════════ */
  function openBuilder() {
    ensureStyle(); closeBuilder();
    var ovl = el('<div class="jfb-ovl" id="jfb-ovl"></div>');
    ovl.innerHTML =
      '<div class="jfb-modal">' +
        '<div class="jfb-head">' +
          '<div><div class="jfb-crumb">Forms › Job Form Builder</div><h2>Job Form Builder</h2><div class="jfb-sub">Create, customize and manage job posting forms without code</div></div>' +
          '<div class="sp"></div>' +
          '<span class="pjf-msg" id="jfb-msg"></span>' +
          '<button class="jfb-hbtn" id="jfb-import">⬆ Import</button>' +
          '<button class="jfb-hbtn" id="jfb-export">⬇ Export</button>' +
          '<button class="jfb-hbtn" id="jfb-astpl">🗂 Save as Template</button>' +
          '<button class="jfb-hbtn primary" id="jfb-save">📣 Save &amp; Publish</button>' +
          '<button class="jfb-x" id="jfb-close">×</button>' +
        '</div>' +
        '<div class="jfb-tabs" id="jfb-tabs"></div>' +
        '<div class="jfb-body" id="jfb-body"></div>' +
      '</div>';
    document.body.appendChild(ovl);
    ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) closeBuilder(); });
    ovl.querySelector('#jfb-close').addEventListener('click', closeBuilder);
    ovl.querySelector('#jfb-save').addEventListener('click', doSave);
    ovl.querySelector('#jfb-import').addEventListener('click', function () { state.activeTab = 'io'; renderTabs(); renderTab(); });
    ovl.querySelector('#jfb-export').addEventListener('click', function () { downloadSchema(); });
    ovl.querySelector('#jfb-astpl').addEventListener('click', saveAsTemplate);
    renderTabs(); renderTab();
  }
  function closeBuilder() { var o = document.getElementById('jfb-ovl'); if (o) o.remove(); closeFieldEditor(); }
  function msg(t, cls) { var m = document.getElementById('jfb-msg'); if (!m) return; m.textContent = t || ''; m.className = 'pjf-msg' + (cls ? ' ' + cls : ''); if (t) setTimeout(function () { if (m.textContent === t) m.textContent = ''; }, 3000); }
  function doSave() {
    var b = document.getElementById('jfb-save'); if (b) { b.disabled = true; b.textContent = 'Publishing…'; }
    saveSchema().then(function () { msg('Saved & published ✓', 'ok'); window.dispatchEvent(new CustomEvent('hrmsJobFormPublished', { detail: {} })); }).catch(function (e) { msg(e.message || 'Save failed', 'err'); })
      .then(function () { if (b) { b.disabled = false; b.innerHTML = '📣 Save &amp; Publish'; } });
  }
  function saveAsTemplate() {
    var name = prompt('Template name (e.g. Tech Roles, Sales Roles):'); if (!name) return;
    var payload = state.sections.map(function (s) { return { id: s.id, title: s.title, collapsed: !!s.collapsed, fields: s.fields }; });
    api('/api/job-form/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), schema: payload, email: actorEmail() }) })
      .then(function () { msg('Template saved ✓', 'ok'); }).catch(function (e) { alert(e.message); });
  }
  function downloadSchema() {
    var data = { sections: state.sections };
    var blob = new Blob([JSON.stringify(data.sections, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'job-form.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  var TABS = [['build', 'Build'], ['options', 'Options'], ['logic', 'Logic'], ['permissions', 'Permissions'], ['master', 'Master Data'], ['templates', 'Templates'], ['io', 'Import / Export']];
  function renderTabs() {
    var t = document.getElementById('jfb-tabs'); if (!t) return;
    t.innerHTML = TABS.map(function (x) { return '<button class="jfb-tab' + (state.activeTab === x[0] ? ' on' : '') + '" data-tab="' + x[0] + '">' + x[1] + '</button>'; }).join('');
    t.querySelectorAll('.jfb-tab').forEach(function (b) { b.addEventListener('click', function () { state.activeTab = b.getAttribute('data-tab'); renderTabs(); renderTab(); }); });
  }
  function renderTab() {
    var body = document.getElementById('jfb-body'); if (!body) return;
    body.className = 'jfb-body';
    if (state.activeTab === 'build') return renderBuild(body);
    body.innerHTML = '<div class="jfb-scroll" style="flex:1"></div>';
    var host = body.firstChild;
    if (state.activeTab === 'options') return renderOptions(host);
    if (state.activeTab === 'logic') return renderLogic(host);
    if (state.activeTab === 'permissions') return renderPermissions(host);
    if (state.activeTab === 'master') return renderMaster(host);
    if (state.activeTab === 'templates') return renderTemplatesTab(host);
    if (state.activeTab === 'io') return renderIO(host);
  }

  /* ── Build tab ────────────────────────────────────────────────────────── */
  function renderBuild(body) {
    body.innerHTML =
      '<div class="jfb-main">' +
        '<div class="jfb-c-pal jfb-scroll">' +
          '<div class="jfb-h1">Add Fields</div><div class="jfb-h2">Drag or click to add fields</div>' +
          '<div class="jfb-ptabs"><button class="jfb-ptab' + (state.paletteTab === 'basic' ? ' on' : '') + '" data-pt="basic">Basic Fields</button><button class="jfb-ptab' + (state.paletteTab === 'advanced' ? ' on' : '') + '" data-pt="advanced">Advanced Fields</button></div>' +
          '<div id="jfb-palette"></div>' +
        '</div>' +
        '<div class="jfb-c-canvas jfb-scroll">' +
          '<div style="display:flex;align-items:center"><div><div class="jfb-h1">Form Sections</div><div class="jfb-h2">Drag to reorder fields and sections</div></div><button class="jfb-viewlogic" id="jfb-clear" style="margin-left:auto;color:var(--danger,#f75f4f)">Clear All</button></div>' +
          '<div id="jfb-sections"></div>' +
          '<button class="jfb-addsec" id="jfb-addsec">⊕ Add Section</button>' +
        '</div>' +
        '<div class="jfb-c-prev jfb-scroll">' +
          '<div class="jfb-prev-top"><div><div class="jfb-h1" style="display:inline">Live Preview</div> <span class="jfb-badge">Preview</span><div class="jfb-h2">This is how candidates will see the form</div></div>' +
            '<div class="jfb-dev"><button data-dev="desktop" class="' + (state.device === 'desktop' ? 'on' : '') + '">🖥</button><button data-dev="tablet" class="' + (state.device === 'tablet' ? 'on' : '') + '">▭</button><button data-dev="mobile" class="' + (state.device === 'mobile' ? 'on' : '') + '">▯</button></div></div>' +
          '<div class="jfb-prev-frame" id="jfb-preview"></div>' +
          '<div class="jfb-stats" id="jfb-stats"></div>' +
        '</div>' +
      '</div>' +
      '<div class="jfb-foot" id="jfb-foot"></div>';

    body.querySelectorAll('[data-pt]').forEach(function (b) { b.addEventListener('click', function () { state.paletteTab = b.getAttribute('data-pt'); renderBuild(body); }); });
    body.querySelectorAll('[data-dev]').forEach(function (b) { b.addEventListener('click', function () { state.device = b.getAttribute('data-dev'); renderBuild(body); }); });
    body.querySelector('#jfb-addsec').addEventListener('click', function () { state.sections.push({ id: uid('sec_'), title: 'New Section', collapsed: false, fields: [] }); renderSections(); renderPreview(); });
    body.querySelector('#jfb-clear').addEventListener('click', function () { if (confirm('Remove all sections and fields?')) { state.sections = [{ id: uid('sec_'), title: 'Job Details', collapsed: false, fields: [] }]; state.activeSection = state.sections[0].id; renderSections(); renderPreview(); } });
    renderPalette(); renderSections(); renderPreview(); renderFooter();
  }
  function renderPalette() {
    var p = document.getElementById('jfb-palette'); if (!p) return;
    p.innerHTML = Object.keys(TYPES).filter(function (k) { return TYPES[k].cat === state.paletteTab; }).map(function (k) {
      return '<button class="jfb-pal-btn" draggable="true" data-add="' + k + '"><span class="jfb-pal-ic">' + TYPES[k].icon + '</span>' + TYPES[k].label + '</button>';
    }).join('');
    p.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () { addField(b.getAttribute('data-add')); });
      b.addEventListener('dragstart', function (e) { state.dragField = { paletteType: b.getAttribute('data-add') }; try { e.dataTransfer.setData('text/plain', 'palette'); } catch (_) {} });
      b.addEventListener('dragend', function () { state.dragField = null; });
    });
  }
  function renderFooter() {
    var f = document.getElementById('jfb-foot'); if (!f) return;
    var cards = [
      ['master', '🗄', 'Master Data', 'Manage global dropdowns and lists'],
      ['logic', '🔀', 'Conditional Logic', 'Show/hide fields based on rules'],
      ['templates', '🗂', 'Templates', 'Save and reuse form templates'],
      ['options', '🌐', 'Multi Currency', 'Salary in all world currencies'],
      ['io', '⬆', 'Export/Import', 'Backup and migrate forms']
    ];
    f.innerHTML = cards.map(function (c) { return '<div class="jfb-fcard" data-go="' + c[0] + '"><div class="ic">' + c[1] + '</div><div><b>' + c[2] + '</b><span>' + c[3] + '</span></div></div>'; }).join('');
    f.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { state.activeTab = b.getAttribute('data-go'); renderTabs(); renderTab(); }); });
  }

  function renderSections() {
    var wrap = document.getElementById('jfb-sections'); if (!wrap) return;
    wrap.innerHTML = state.sections.map(function (s, si) {
      var body = s.collapsed ? '' :
        '<div class="jfb-sec-b" data-sbody="' + s.id + '">' +
          ((s.fields || []).length ? s.fields.map(function (f) { return fieldRow(f); }).join('') : '<div class="jfb-empty">Drop fields here</div>') +
        '</div>';
      return '<div class="jfb-sec' + (state.activeSection === s.id ? ' active' : '') + '" data-sec="' + s.id + '">' +
        '<div class="jfb-sec-h" data-sh="' + s.id + '" draggable="true">' +
          '<span class="grip">⋮⋮</span><span class="num">' + (si + 1) + '</span>' +
          '<input class="tt" value="' + escAttr(s.title) + '" data-stitle="' + s.id + '">' +
          '<button class="jfb-ico" data-scollapse="' + s.id + '" title="Collapse">' + (s.collapsed ? '▸' : '▾') + '</button>' +
          '<button class="jfb-ico del" data-sdel="' + s.id + '" title="Delete section">🗑</button>' +
        '</div>' + body + '</div>';
    }).join('');
    wireSections(wrap);
  }
  function fieldRow(f) {
    return '<div class="jfb-fld" draggable="true" data-fid="' + f.id + '">' +
      '<span class="grip">⋮⋮</span><span class="fic">' + (TYPES[f.type] ? TYPES[f.type].icon : '?') + '</span>' +
      '<span class="lb">' + esc(f.label) + (f.required ? ' <span class="rq">*</span>' : '') + (f.conditional && f.conditional.field ? '<span class="cnd">◈ logic</span>' : '') + '</span>' +
      '<button class="jfb-ico" data-fedit="' + f.id + '" title="Settings">⚙</button>' +
      '<button class="jfb-ico" data-fdup="' + f.id + '" title="Duplicate">⧉</button>' +
      '<button class="jfb-ico del" data-fdel="' + f.id + '" title="Delete">🗑</button>' +
      '</div>';
  }
  function wireSections(wrap) {
    wrap.querySelectorAll('[data-sec]').forEach(function (secEl) {
      secEl.addEventListener('click', function () { state.activeSection = secEl.getAttribute('data-sec'); wrap.querySelectorAll('.jfb-sec').forEach(function (x) { x.classList.toggle('active', x === secEl); }); });
    });
    wrap.querySelectorAll('[data-stitle]').forEach(function (inp) {
      inp.addEventListener('click', function (e) { e.stopPropagation(); });
      inp.addEventListener('input', function () { var s = sectionById(inp.getAttribute('data-stitle')); if (s) { s.title = inp.value; renderPreview(); } });
    });
    wrap.querySelectorAll('[data-scollapse]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); var s = sectionById(b.getAttribute('data-scollapse')); if (s) { s.collapsed = !s.collapsed; renderSections(); } }); });
    wrap.querySelectorAll('[data-sdel]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); if (state.sections.length <= 1) { alert('Keep at least one section.'); return; } if (!confirm('Delete this section and its fields?')) return; var sid = b.getAttribute('data-sdel'); state.sections = state.sections.filter(function (s) { return s.id !== sid; }); renderSections(); renderPreview(); }); });
    wrap.querySelectorAll('[data-fedit]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); openFieldEditor(b.getAttribute('data-fedit')); }); });
    wrap.querySelectorAll('[data-fdup]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); dupField(b.getAttribute('data-fdup')); }); });
    wrap.querySelectorAll('[data-fdel]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); delField(b.getAttribute('data-fdel')); }); });

    // section drag
    wrap.querySelectorAll('[data-sh]').forEach(function (h) {
      h.addEventListener('dragstart', function (e) { state.dragSection = h.getAttribute('data-sh'); state.dragField = null; e.stopPropagation(); });
      h.addEventListener('dragend', function () { state.dragSection = null; });
    });
    // field drag
    wrap.querySelectorAll('[data-fid]').forEach(function (row) {
      row.addEventListener('dragstart', function (e) { state.dragField = { fid: row.getAttribute('data-fid') }; state.dragSection = null; row.classList.add('drag'); e.stopPropagation(); });
      row.addEventListener('dragend', function () { row.classList.remove('drag'); state.dragField = null; });
      row.addEventListener('dragover', function (e) { e.preventDefault(); });
      row.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); dropOnField(row.getAttribute('data-fid')); });
    });
    // section body drop (append) + section reorder
    wrap.querySelectorAll('[data-sec]').forEach(function (secEl) {
      secEl.addEventListener('dragover', function (e) { e.preventDefault(); });
      secEl.addEventListener('drop', function (e) {
        e.preventDefault();
        var sid = secEl.getAttribute('data-sec');
        if (state.dragSection) { reorderSection(state.dragSection, sid); return; }
        dropInSection(sid);
      });
    });
  }
  function dropOnField(targetFid) {
    var tgt = findField(targetFid); if (!tgt) return;
    if (state.dragField && state.dragField.paletteType) { insertField(makeField(state.dragField.paletteType), tgt.section.id, tgt.fi); }
    else if (state.dragField && state.dragField.fid && state.dragField.fid !== targetFid) { moveField(state.dragField.fid, tgt.section.id, tgt.fi); }
    state.dragField = null; renderSections(); renderPreview();
  }
  function dropInSection(sid) {
    var s = sectionById(sid); if (!s) return;
    if (state.dragField && state.dragField.paletteType) { insertField(makeField(state.dragField.paletteType), sid, s.fields.length); }
    else if (state.dragField && state.dragField.fid) { moveField(state.dragField.fid, sid, s.fields.length); }
    state.dragField = null; renderSections(); renderPreview();
  }
  function moveField(fid, toSid, toIdx) {
    var src = findField(fid); if (!src) return;
    src.section.fields.splice(src.fi, 1);
    var to = sectionById(toSid); if (!to) return;
    if (src.section === to && src.fi < toIdx) toIdx--;
    to.fields.splice(toIdx, 0, src.field);
  }
  function insertField(f, sid, idx) { var s = sectionById(sid); if (!s) return; s.fields.splice(idx, 0, f); openFieldEditor(f.id); }
  function reorderSection(fromSid, toSid) {
    if (fromSid === toSid) return;
    var fromI = state.sections.findIndex(function (s) { return s.id === fromSid; });
    var toI = state.sections.findIndex(function (s) { return s.id === toSid; });
    if (fromI < 0 || toI < 0) return;
    var m = state.sections.splice(fromI, 1)[0]; state.sections.splice(toI, 0, m);
    state.dragSection = null; renderSections(); renderPreview();
  }

  function makeField(type) {
    var n = allFields().length + 1;
    var f = normField({ id: uid(), type: type, label: TYPES[type].label + ' ' + n, key: slug(type + '_' + n) });
    if (type === 'salary') f.currency = true;
    if (type === 'heading') { f.label = 'Heading'; }
    return f;
  }
  function addField(type) {
    var sid = state.activeSection || (state.sections[0] && state.sections[0].id);
    var s = sectionById(sid) || state.sections[0]; if (!s) return;
    var f = makeField(type); s.fields.push(f); renderSections(); renderPreview(); openFieldEditor(f.id);
  }
  function dupField(fid) { var r = findField(fid); if (!r) return; var c = normField(JSON.parse(JSON.stringify(r.field))); c.id = uid(); c.key = uniqueKey(r.field.key + '_copy'); c.core = false; c.label = r.field.label + ' (copy)'; r.section.fields.splice(r.fi + 1, 0, c); renderSections(); renderPreview(); }
  function delField(fid) { var r = findField(fid); if (!r) return; if (!confirm('Delete “' + (r.field.label || 'this field') + '”?')) return; r.section.fields.splice(r.fi, 1); renderSections(); renderPreview(); }
  function uniqueKey(k) { var base = safeKey(k), key = base, n = 2, taken = {}; allFields().forEach(function (f) { taken[f.key] = 1; }); while (taken[key]) key = base + '_' + (n++); return key; }

  /* ── field editor ─────────────────────────────────────────────────────── */
  function closeFieldEditor() { var o = document.getElementById('jfb-ed-ovl'); if (o) o.remove(); }
  function openFieldEditor(fid) {
    var r = findField(fid); if (!r) return; var f = r.field;
    closeFieldEditor();
    var isOpt = OPTION_TYPES[f.type];
    var masterSel = '<option value="">— Custom options below —</option>' + Object.keys(state.master).map(function (k) { return '<option value="' + esc(k) + '"' + (f.masterKey === k ? ' selected' : '') + '>' + esc(state.master[k].label) + '</option>'; }).join('');
    var others = allFields().filter(function (x) { return x.id !== f.id && x.type !== 'heading'; });
    var condF = '<option value="">— No condition (always show) —</option>' + others.map(function (x) { return '<option value="' + esc(x.key) + '"' + (f.conditional && f.conditional.field === x.key ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('');
    var ops = [['equals', 'equals'], ['not_equals', 'does not equal'], ['not_empty', 'is filled'], ['empty', 'is empty']];
    var condO = ops.map(function (o) { return '<option value="' + o[0] + '"' + (f.conditional && f.conditional.operator === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    var secSel = state.sections.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === r.section.id ? ' selected' : '') + '>' + esc(s.title) + '</option>'; }).join('');

    var ovl = el('<div class="jfb-ed-ovl" id="jfb-ed-ovl"></div>');
    ovl.innerHTML = '<div class="jfb-ed">' +
      '<h3>Field Settings' + (f.core ? ' · <span style="color:var(--accent)">core</span>' : '') + '</h3>' +
      '<div class="jfb-fgrp"><label class="jfb-lab">Label</label><input class="jfb-in" id="ed-label" value="' + escAttr(f.label) + '"></div>' +
      '<div class="jfb-row jfb-fgrp"><div><label class="jfb-lab">Field key</label><input class="jfb-in" id="ed-key" value="' + escAttr(f.key) + '"' + (f.core ? ' disabled' : '') + '></div>' +
        '<div><label class="jfb-lab">Type</label><select class="jfb-sel" id="ed-type"' + (f.core ? ' disabled' : '') + '>' + Object.keys(TYPES).map(function (k) { return '<option value="' + k + '"' + (f.type === k ? ' selected' : '') + '>' + TYPES[k].label + '</option>'; }).join('') + '</select></div></div>' +
      (f.type === 'heading' ? '' :
      '<div class="jfb-row jfb-fgrp"><div><label class="jfb-lab">Placeholder</label><input class="jfb-in" id="ed-ph" value="' + escAttr(f.placeholder) + '"></div>' +
        '<div><label class="jfb-lab">Width</label><select class="jfb-sel" id="ed-width"><option value="full"' + (f.width !== 'half' ? ' selected' : '') + '>Full</option><option value="half"' + (f.width === 'half' ? ' selected' : '') + '>Half</option></select></div></div>' +
      '<div class="jfb-row jfb-fgrp"><div><label class="jfb-lab">Section</label><select class="jfb-sel" id="ed-sec">' + secSel + '</select></div>' +
        '<div><label class="jfb-lab">Default value</label><input class="jfb-in" id="ed-def" value="' + escAttr(f.defaultValue == null ? '' : f.defaultValue) + '"></div></div>' +
      '<div class="jfb-fgrp"><label class="jfb-lab">Help text</label><input class="jfb-in" id="ed-help" value="' + escAttr(f.help) + '"></div>' +
      '<div class="jfb-fgrp"><label class="jfb-ck"><input type="checkbox" id="ed-req"' + (f.required ? ' checked' : '') + '> Required field</label></div>') +
      (isOpt ? '<div class="jfb-fgrp"><label class="jfb-lab">Options source (Master Data)</label><select class="jfb-sel" id="ed-master">' + masterSel + '</select></div>' +
        '<div class="jfb-fgrp" id="ed-optwrap"><label class="jfb-lab">Custom options (one per line)</label><textarea class="jfb-ta" id="ed-opts">' + esc((f.options || []).map(function (o) { return typeof o === 'string' ? o : o.label; }).join('\n')) + '</textarea></div>' : '') +
      (f.type === 'salary' || f.type === 'currency' ? '<div class="jfb-fgrp"><label class="jfb-ck"><input type="checkbox" id="ed-cur"' + (f.currency !== false ? ' checked' : '') + '> Show world-currency selector</label></div>' : '') +
      (f.type === 'heading' ? '' :
      '<div class="jfb-sech" style="margin-top:4px">Conditional logic</div>' +
      '<div class="jfb-fgrp"><label class="jfb-lab">Show this field when</label><select class="jfb-sel" id="ed-cf">' + condF + '</select></div>' +
      '<div class="jfb-row jfb-fgrp"><div><select class="jfb-sel" id="ed-co">' + condO + '</select></div><div><input class="jfb-in" id="ed-cv" placeholder="value" value="' + escAttr(f.conditional ? (f.conditional.value == null ? '' : f.conditional.value) : '') + '"></div></div>') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px"><button class="jfb-btn ghost" id="ed-cancel">Cancel</button><button class="jfb-btn" id="ed-apply">Apply</button></div>' +
      '</div>';
    document.body.appendChild(ovl);
    ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) closeFieldEditor(); });
    ovl.querySelector('#ed-cancel').addEventListener('click', closeFieldEditor);
    var mEl = ovl.querySelector('#ed-master'), ow = ovl.querySelector('#ed-optwrap');
    if (mEl && ow) { var sy = function () { ow.style.display = mEl.value ? 'none' : ''; }; mEl.addEventListener('change', sy); sy(); }
    ovl.querySelector('#ed-apply').addEventListener('click', function () { applyFieldEdit(r, ovl); });
  }
  function applyFieldEdit(r, ovl) {
    var f = r.field;
    function v(id) { var e = ovl.querySelector(id); return e ? e.value : undefined; }
    function ck(id) { var e = ovl.querySelector(id); return e ? e.checked : false; }
    f.label = (v('#ed-label') || '').trim() || f.label;
    if (!f.core) { var nk = slug(v('#ed-key')); if (nk && nk !== f.key) f.key = uniqueKey(nk); var nt = v('#ed-type'); if (nt) f.type = nt; }
    if (f.type !== 'heading') {
      f.placeholder = v('#ed-ph') || ''; f.width = v('#ed-width') || 'full'; f.help = v('#ed-help') || '';
      var dv = v('#ed-def'); f.defaultValue = dv === '' ? undefined : dv; f.required = ck('#ed-req');
      var cf = v('#ed-cf'); if (cf) f.conditional = { field: cf, operator: v('#ed-co') || 'equals', value: v('#ed-cv') || '' }; else delete f.conditional;
      // move to chosen section
      var newSid = v('#ed-sec');
      if (newSid && newSid !== r.section.id) { r.section.fields.splice(r.fi, 1); var to = sectionById(newSid); if (to) to.fields.push(f); }
    }
    if (OPTION_TYPES[f.type]) { var mk = v('#ed-master'); if (mk) f.masterKey = mk; else { delete f.masterKey; f.options = (v('#ed-opts') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return { value: s, label: s }; }); } }
    else delete f.masterKey;
    if (f.type === 'salary' || f.type === 'currency') f.currency = ck('#ed-cur');
    closeFieldEditor(); renderSections(); renderPreview();
  }

  /* ── Options / Logic / Permissions / Master / Templates / IO ──────────── */
  function renderOptions(host) {
    var o = opts();
    host.innerHTML = '<div style="max-width:640px;margin:0 auto">' +
      '<div class="jfb-mrow"><h4>Form Options</h4>' +
        '<div class="jfb-fgrp"><label class="jfb-lab">Form title</label><input class="jfb-in" id="op-title" value="' + escAttr(o.formTitle || 'Post a Job') + '"></div>' +
        '<div class="jfb-fgrp"><label class="jfb-lab">Submit button label</label><input class="jfb-in" id="op-submit" value="' + escAttr(o.submitLabel || 'Post Job') + '"></div>' +
        '<div class="jfb-fgrp"><label class="jfb-lab">Success message</label><input class="jfb-in" id="op-success" value="' + escAttr(o.successMsg || 'Job posted ✓') + '"></div>' +
      '</div>' +
      '<div class="jfb-mrow"><h4>🌐 Multi-Currency</h4><p class="jfb-hint">Default currency for all salary fields (choose from ' + state.currencies.length + ' world currencies).</p>' +
        '<div class="jfb-fgrp"><label class="jfb-lab">Default currency</label><select class="jfb-sel" id="op-cur">' + state.currencies.map(function (c) { return '<option value="' + c.code + '"' + (c.code === defaultCurrency() ? ' selected' : '') + '>' + esc(c.code) + ' — ' + esc(c.name) + ' (' + esc(c.symbol) + ')</option>'; }).join('') + '</select></div></div>' +
      '<button class="jfb-btn" id="op-save">Save Options</button></div>';
    host.querySelector('#op-save').addEventListener('click', function () {
      var no = opts(); no.formTitle = host.querySelector('#op-title').value; no.submitLabel = host.querySelector('#op-submit').value; no.successMsg = host.querySelector('#op-success').value;
      setOpts(no); localStorage.setItem(LS_CURRENCY, host.querySelector('#op-cur').value); msg('Options saved ✓', 'ok');
    });
  }
  function renderLogic(host) {
    var withRules = allFields().filter(function (f) { return f.conditional && f.conditional.field; });
    host.innerHTML = '<div style="max-width:680px;margin:0 auto"><h4 style="color:var(--text);margin:0 0 4px">Conditional Logic</h4><p class="jfb-hint" style="margin-bottom:14px">Rules that show or hide fields based on other answers. Edit a field to add or change its rule.</p>' +
      (withRules.length ? withRules.map(function (f) {
        var c = f.conditional; var tf = allFields().filter(function (x) { return x.key === c.field; })[0];
        return '<div class="jfb-mrow" style="display:flex;align-items:center;gap:10px"><div style="flex:1"><b style="color:var(--text)">' + esc(f.label) + '</b><div class="jfb-hint">shows when <b>' + esc(tf ? tf.label : c.field) + '</b> ' + esc(({ equals: 'equals', not_equals: 'does not equal', not_empty: 'is filled', empty: 'is empty' })[c.operator] || c.operator) + (c.value ? ' “' + esc(c.value) + '”' : '') + '</div></div><button class="jfb-btn ghost sm" data-edit="' + f.id + '">Edit</button></div>';
      }).join('') : '<div class="jfb-empty">No conditional rules yet. Open a field’s ⚙ settings to add one.</div>') + '</div>';
    host.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { state.activeTab = 'build'; renderTabs(); renderTab(); openFieldEditor(b.getAttribute('data-edit')); }); });
  }
  function renderPermissions(host) {
    var o = opts(); var p = o.perms || { build: 'admins', post: 'recruiters' };
    host.innerHTML = '<div style="max-width:600px;margin:0 auto"><h4 style="color:var(--text);margin:0 0 4px">Permissions</h4><p class="jfb-hint" style="margin-bottom:14px">Who can use the builder and post jobs. (Applied by your role settings; recorded here for reference.)</p>' +
      '<div class="jfb-mrow"><div class="jfb-fgrp"><label class="jfb-lab">Who can edit this form</label><select class="jfb-sel" id="pm-build"><option value="admins"' + (p.build === 'admins' ? ' selected' : '') + '>Admins only</option><option value="hr"' + (p.build === 'hr' ? ' selected' : '') + '>Admins + HR</option><option value="everyone"' + (p.build === 'everyone' ? ' selected' : '') + '>Everyone</option></select></div>' +
      '<div class="jfb-fgrp"><label class="jfb-lab">Who can post jobs</label><select class="jfb-sel" id="pm-post"><option value="recruiters"' + (p.post === 'recruiters' ? ' selected' : '') + '>Recruiters</option><option value="hr"' + (p.post === 'hr' ? ' selected' : '') + '>HR</option><option value="everyone"' + (p.post === 'everyone' ? ' selected' : '') + '>Everyone</option></select></div></div>' +
      '<button class="jfb-btn" id="pm-save">Save Permissions</button></div>';
    host.querySelector('#pm-save').addEventListener('click', function () { var no = opts(); no.perms = { build: host.querySelector('#pm-build').value, post: host.querySelector('#pm-post').value }; setOpts(no); msg('Permissions saved ✓', 'ok'); });
  }
  function renderMaster(host) {
    var keys = Object.keys(state.master);
    host.innerHTML = '<div style="max-width:760px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><div><h4 style="margin:0;color:var(--text)">Global Master Data</h4><div class="jfb-hint">Reusable dropdown lists shared across fields and forms.</div></div><button class="jfb-btn sm" id="jfb-add-master" style="margin-left:auto">+ New list</button></div>' +
      (keys.length ? keys.map(function (k) { var m = state.master[k];
        var tags = (m.options || []).map(function (o, i) { return '<span class="jfb-tag">' + esc(o.label || o.value) + '<button data-rmopt="' + k + '::' + i + '">×</button></span>'; }).join('');
        return '<div class="jfb-mrow"><h4>' + esc(m.label) + ' <span style="color:var(--text3);font-weight:400;font-size:11px">(' + esc(k) + ')</span></h4><div>' + (tags || '<span class="jfb-hint">No options.</span>') + '</div>' +
          '<div class="jfb-row" style="margin-top:10px;align-items:flex-end"><div style="flex:1"><input class="jfb-in" placeholder="Add an option, press Enter" data-addopt="' + k + '"></div><button class="jfb-btn ghost sm" data-delmaster="' + k + '" style="flex:0 0 auto">Delete list</button></div></div>';
      }).join('') : '<div class="jfb-empty">No master data.</div>') + '</div>';
    host.querySelector('#jfb-add-master').addEventListener('click', function () { var label = prompt('New list name (e.g. Work Modes):'); if (!label) return; var key = slug(label); if (!key || state.master[key]) { alert('Invalid or existing key.'); return; } saveMaster(key, { label: label, options: [] }).then(function () { renderTab(); }); });
    host.querySelectorAll('[data-addopt]').forEach(function (inp) { inp.addEventListener('keydown', function (e) { if (e.key !== 'Enter') return; e.preventDefault(); var val = inp.value.trim(); if (!val) return; var k = inp.getAttribute('data-addopt'); var m = state.master[k]; m.options = (m.options || []).concat([{ value: val, label: val }]); saveMaster(k, m).then(function () { renderTab(); }); }); });
    host.querySelectorAll('[data-rmopt]').forEach(function (b) { b.addEventListener('click', function () { var p = b.getAttribute('data-rmopt').split('::'); var m = state.master[p[0]]; m.options.splice(+p[1], 1); saveMaster(p[0], m).then(function () { renderTab(); }); }); });
    host.querySelectorAll('[data-delmaster]').forEach(function (b) { b.addEventListener('click', function () { var k = b.getAttribute('data-delmaster'); if (!confirm('Delete list “' + k + '”?')) return; api('/api/master-data/' + encodeURIComponent(k), { method: 'DELETE' }).then(function () { delete state.master[k]; renderTab(); }).catch(function (e) { alert(e.message); }); }); });
  }
  function saveMaster(k, m) { return api('/api/master-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, label: m.label, options: m.options }) }).then(function (r) { state.master[k] = r; }); }
  function renderTemplatesTab(host) {
    host.innerHTML = '<div style="max-width:720px;margin:0 auto"><div class="jfb-empty">Loading templates…</div></div>';
    loadTemplates(function () {
      host.innerHTML = '<div style="max-width:720px;margin:0 auto">' +
        '<div class="jfb-mrow"><h4>Save current form as template</h4><div class="jfb-row" style="align-items:flex-end"><div style="flex:1"><input class="jfb-in" id="tpl-name" placeholder="Template name"></div><button class="jfb-btn sm" id="tpl-save" style="flex:0 0 auto">Save</button></div></div>' +
        '<div class="jfb-sech" style="margin:16px 0 10px">Saved templates</div>' +
        (state.templates.length ? state.templates.map(function (t) { return '<div class="jfb-mrow" style="display:flex;align-items:center;gap:10px"><div style="flex:1"><h4 style="margin:0">' + esc(t.name) + (t.isActive ? ' <span class="jfb-badge">Active</span>' : '') + '</h4><div class="jfb-hint">' + t.fields + ' fields · ' + esc(t.updatedAt || '') + '</div></div><button class="jfb-btn ghost sm" data-load="' + t.id + '">Load</button>' + (t.isActive ? '' : '<button class="jfb-btn sm" data-act="' + t.id + '">Activate</button><button class="jfb-ico del" data-del="' + t.id + '">🗑</button>') + '</div>'; }).join('') : '<div class="jfb-empty">No templates.</div>') + '</div>';
      host.querySelector('#tpl-save').addEventListener('click', function () { var name = (host.querySelector('#tpl-name').value || '').trim(); if (!name) { alert('Enter a name.'); return; } var payload = state.sections.map(function (s) { return { id: s.id, title: s.title, collapsed: !!s.collapsed, fields: s.fields }; }); api('/api/job-form/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, schema: payload, email: actorEmail() }) }).then(function () { renderTab(); msg('Template saved ✓', 'ok'); }).catch(function (e) { alert(e.message); }); });
      host.querySelectorAll('[data-load]').forEach(function (b) { b.addEventListener('click', function () { api('/api/job-form/templates/' + b.getAttribute('data-load')).then(function (t) { state.sections = normalizeSchema(t.schema || []); state.activeSection = state.sections[0] && state.sections[0].id; state.activeTab = 'build'; renderTabs(); renderTab(); msg('Loaded “' + t.name + '” — Publish to apply', 'ok'); }); }); });
      host.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', function () { api('/api/job-form/templates/' + b.getAttribute('data-act'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activate: true }) }).then(function (t) { state.sections = normalizeSchema(t.schema || []); renderTab(); msg('Activated', 'ok'); }); }); });
      host.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { if (!confirm('Delete template?')) return; api('/api/job-form/templates/' + b.getAttribute('data-del'), { method: 'DELETE' }).then(function () { renderTab(); }).catch(function (e) { alert(e.message); }); }); });
    });
  }
  function renderIO(host) {
    host.innerHTML = '<div style="max-width:720px;margin:0 auto">' +
      '<div class="jfb-mrow"><h4>Export</h4><p class="jfb-hint">Download the form definition as JSON.</p><div style="display:flex;gap:8px;margin-top:8px"><button class="jfb-btn sm" id="io-dl">⬇ Download JSON</button><button class="jfb-btn ghost sm" id="io-copy">Copy</button></div></div>' +
      '<div class="jfb-mrow"><h4>Import</h4><p class="jfb-hint">Paste a form definition (sections or flat field array). Publish to apply.</p><textarea class="jfb-ta" id="io-txt" style="min-height:160px;font-family:monospace;font-size:12px"></textarea><div style="display:flex;gap:8px;margin-top:8px"><button class="jfb-btn sm" id="io-imp">Import</button><label class="jfb-btn ghost sm" style="cursor:pointer">Load file<input type="file" id="io-file" accept="application/json,.json" style="display:none"></label></div></div></div>';
    host.querySelector('#io-dl').addEventListener('click', downloadSchema);
    host.querySelector('#io-copy').addEventListener('click', function () { var txt = JSON.stringify(state.sections, null, 2); if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { msg('Copied ✓', 'ok'); }); else host.querySelector('#io-txt').value = txt; });
    function doImp(txt) { try { var arr = JSON.parse(txt); state.sections = normalizeSchema(arr); state.activeSection = state.sections[0] && state.sections[0].id; state.activeTab = 'build'; renderTabs(); renderTab(); msg('Imported — Publish to apply', 'ok'); } catch (e) { alert('Import failed: ' + e.message); } }
    host.querySelector('#io-imp').addEventListener('click', function () { doImp(host.querySelector('#io-txt').value); });
    host.querySelector('#io-file').addEventListener('change', function (e) { var f = e.target.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = function () { doImp(rd.result); }; rd.readAsText(f); });
  }

  /* ══════════════════ SHARED FORM RENDERING (preview + real) ═════════════ */
  function conditionMet(f, values) {
    var c = f.conditional; if (!c || !c.field) return true;
    var v = values[c.field]; var sv = (v == null ? '' : (Array.isArray(v) ? v.join(',') : String(v))).toLowerCase(); var st = (c.value == null ? '' : String(c.value)).toLowerCase();
    if (c.operator === 'empty') return sv === '' || sv === 'false' || sv === 'no';
    if (c.operator === 'not_empty') return !(sv === '' || sv === 'false' || sv === 'no');
    if (c.operator === 'not_equals') return sv !== st;
    return sv === st;
  }
  function inputHtml(f) {
    var name = 'name="' + escAttr(f.key) + '"'; var ph = f.placeholder ? ' placeholder="' + escAttr(f.placeholder) + '"' : ''; var def = f.defaultValue == null ? '' : f.defaultValue;
    switch (f.type) {
      case 'textarea': case 'richtext': return '<textarea class="pjf-ta" ' + name + ph + '>' + esc(def) + '</textarea>';
      case 'number': return '<input type="number" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '">';
      case 'email': return '<input type="email" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '">';
      case 'url': return '<input type="url" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '">';
      case 'phone': return '<input type="tel" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '">';
      case 'date': return '<input type="date" class="pjf-in" ' + name + ' value="' + escAttr(def) + '">';
      case 'file': return '<input type="file" class="pjf-in" ' + name + '>';
      case 'rating': return '<select class="pjf-sel" ' + name + '>' + [''].concat([1, 2, 3, 4, 5]).map(function (n) { return '<option value="' + n + '"' + (String(def) === String(n) ? ' selected' : '') + '>' + (n === '' ? 'Rate…' : ('★'.repeat(n))) + '</option>'; }).join('') + '</select>';
      case 'checkbox': case 'boolean': return '<select class="pjf-sel" ' + name + '><option value="No"' + (String(def) !== 'true' && def !== 'Yes' ? ' selected' : '') + '>No</option><option value="Yes"' + (String(def) === 'true' || def === 'Yes' ? ' selected' : '') + '>Yes</option></select>';
      case 'select': {
        var os = optionsFor(f).map(function (o) { return '<option value="' + escAttr(o.value) + '"' + (String(def) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('');
        return '<select class="pjf-sel" ' + name + '><option value="">' + esc(f.placeholder || 'Select…') + '</option>' + os + '</select>';
      }
      case 'multiselect': {
        // Editable chips: pick from options or type a value; add / remove dynamically.
        var mopt = optionsFor(f).map(function (o) { return '<option value="' + escAttr(o.value) + '">' + esc(o.label) + '</option>'; }).join('');
        return '<div class="pjf-multi" data-multi="' + escAttr(f.key) + '" data-default="' + escAttr(def) + '">' +
          '<div class="pjf-chips"></div>' +
          '<div class="pjf-multi-add">' +
            '<select class="pjf-sel pjf-msel"><option value="">+ Add…</option>' + mopt + '</select>' +
            '<input class="pjf-in pjf-mtxt" placeholder="' + escAttr(f.placeholder || 'Type and press Enter') + '">' +
          '</div>' +
          '<input type="hidden" ' + name + '></div>';
      }
      case 'radio': return '<div class="pjf-radio">' + optionsFor(f).map(function (o) { return '<label><input type="radio" name="' + escAttr(f.key) + '" value="' + escAttr(o.value) + '"' + (String(def) === String(o.value) ? ' checked' : '') + '> ' + esc(o.label) + '</label>'; }).join('') + '</div>';
      case 'currency': {
        var cur1 = (f.currency !== false) ? '<select class="pjf-sel pjf-cur" name="' + escAttr(f.key) + '__cur">' + state.currencies.map(function (c) { return '<option value="' + c.code + '"' + (c.code === defaultCurrency() ? ' selected' : '') + '>' + esc(c.code) + ' ' + esc(c.symbol) + '</option>'; }).join('') + '</select>' : '';
        return '<div class="pjf-sal">' + cur1 + '<input type="text" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '"></div>';
      }
      case 'salary': {
        var cur = (f.currency !== false) ? '<select class="pjf-sel pjf-cur" name="' + escAttr(f.key) + '__cur">' + state.currencies.map(function (c) { return '<option value="' + c.code + '"' + (c.code === defaultCurrency() ? ' selected' : '') + '>' + esc(c.code) + ' (' + esc(c.symbol) + ')</option>'; }).join('') + '</select>' : '';
        return '<div class="pjf-sal">' + cur + '<input type="text" class="pjf-in" name="' + escAttr(f.key) + '__min" placeholder="Min Salary"><span class="to">To</span><input type="text" class="pjf-in" name="' + escAttr(f.key) + '__max" placeholder="Max Salary"></div>';
      }
      case 'heading': return '';
      default: return '<input type="text" class="pjf-in" ' + name + ph + ' value="' + escAttr(def) + '">';
    }
  }
  function formHtml() {
    // Skip empty sections (e.g. an accidental "Add Section" with no fields).
    return '<form class="pjf-form">' + state.sections.filter(function (s) { return (s.fields || []).length; }).map(function (s) {
      return '<div class="pjf-sec-block"><div class="pjf-grid">' +
        '<div class="pjf-sec-t">' + esc(s.title) + '</div>' +
        (s.fields || []).map(function (f) {
          if (f.type === 'heading') return '<div class="pjf-sec-t" style="font-size:12px;color:var(--text3);text-transform:uppercase">' + esc(f.label) + '</div>';
          var wcls = f.width === 'half' ? '' : 'pjf-w-full';
          return '<div class="pjf-fgrp ' + wcls + '" data-fkey="' + escAttr(f.key) + '">' +
            '<label class="pjf-lab">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>' + inputHtml(f) +
            (f.help ? '<div class="pjf-help">' + esc(f.help) + '</div>' : '') +
            '<div class="pjf-err" data-err="' + escAttr(f.key) + '">This field is required.</div></div>';
        }).join('') + '</div></div>';
    }).join('') + '</form>';
  }
  function renderPreview() {
    var p = document.getElementById('jfb-preview'); if (p) { p.style.maxWidth = state.device === 'mobile' ? '360px' : state.device === 'tablet' ? '600px' : 'none'; p.innerHTML = allFields().length ? formHtml() : '<div class="jfb-empty">Add fields to preview the form.</div>'; var pf = p.querySelector('.pjf-form'); if (pf) wireMultiselects(pf); }
    var st = document.getElementById('jfb-stats');
    if (st) st.innerHTML = '<div class="jfb-stat"><b>' + allFields().length + '</b><span>Fields</span></div><div class="jfb-stat a"><b>' + state.sections.length + '</b><span>Sections</span></div><div class="jfb-stat r"><b>' + reqCount() + '</b><span>Required</span></div><button class="jfb-viewlogic" id="jfb-vlogic">◈ View Logic</button>';
    var vl = document.getElementById('jfb-vlogic'); if (vl) vl.addEventListener('click', function () { state.activeTab = 'logic'; renderTabs(); renderTab(); });
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  // Turn each multiselect into an editable chip input (add via dropdown or by
  // typing; remove via the × on each chip). Selected values live on box._vals
  // and mirror to the hidden input so validation + conditional logic see them.
  function wireMultiselects(root) {
    root.querySelectorAll('.pjf-multi').forEach(function (box) {
      if (box._wired) return; box._wired = true;
      var vals = (box.getAttribute('data-default') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var chips = box.querySelector('.pjf-chips'), sel = box.querySelector('.pjf-msel'), txt = box.querySelector('.pjf-mtxt'), hidden = box.querySelector('input[type=hidden]');
      function render() {
        chips.innerHTML = vals.map(function (v, i) { return '<span class="pjf-chip">' + esc(v) + '<button type="button" data-rm="' + i + '">×</button></span>'; }).join('');
        hidden.value = vals.join(','); box._vals = vals.slice();
        chips.querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { vals.splice(+b.getAttribute('data-rm'), 1); render(); box.dispatchEvent(new Event('change', { bubbles: true })); }); });
      }
      function add(v) { v = (v || '').trim(); if (v && vals.indexOf(v) === -1) { vals.push(v); render(); box.dispatchEvent(new Event('change', { bubbles: true })); } }
      if (sel) sel.addEventListener('change', function () { if (sel.value) { add(sel.value); sel.value = ''; } });
      if (txt) txt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(txt.value); txt.value = ''; } });
      render();
    });
  }
  function wireConditional(formRoot) {
    function collect() { var vals = {}; allFields().forEach(function (f) { var els = formRoot.querySelectorAll('[name="' + cssEsc(f.key) + '"]'); if (!els.length) return; if (f.type === 'radio') { els.forEach(function (e) { if (e.checked) vals[f.key] = e.value; }); } else vals[f.key] = els[0].value; }); return vals; }
    function apply() {
      var vals = collect();
      allFields().forEach(function (f) { if (!f.conditional || !f.conditional.field) return; var g = formRoot.querySelector('[data-fkey="' + cssEsc(f.key) + '"]'); if (g) g.style.display = conditionMet(f, vals) ? '' : 'none'; });
      // Hide a whole section (incl. its title) when every field in it is hidden.
      formRoot.querySelectorAll('.pjf-sec-block').forEach(function (block) {
        var groups = block.querySelectorAll('.pjf-fgrp');
        var anyVisible = Array.prototype.some.call(groups, function (g) { return g.style.display !== 'none'; });
        block.style.display = (groups.length && !anyVisible) ? 'none' : '';
      });
    }
    formRoot.addEventListener('input', apply); formRoot.addEventListener('change', apply); apply();
  }

  /* ══════════════════════════ DYNAMIC POST-A-JOB ═════════════════════════ */
  function openPostJob() {
    ensureStyle(); if (document.getElementById('pjf-ovl')) return;
    var o = opts();
    var ovl = el('<div class="pjf-ovl" id="pjf-ovl"></div>');
    ovl.innerHTML = '<div class="pjf-modal">' +
      '<div class="pjf-head"><h2>' + esc(o.formTitle || 'Post a Job') + '</h2><button class="pjf-gear" id="pjf-gear" title="Edit this form (Form Builder)">⚙</button><button class="jfb-x" id="pjf-close">×</button></div>' +
      '<div class="jfb-scroll" style="flex:1" id="pjf-bodywrap"></div>' +
      // Hidden until setupLinkedInRow confirms LinkedIn is set up server-side
      // and this user has linked their own account.
      '<div id="pjf-li-row" style="display:none;padding:12px 20px 0;border-top:1px solid var(--border2)">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text)">' +
          '<input type="checkbox" id="pjf-li" style="width:auto;margin:0;flex:none">' +
          '<span>Also post to my LinkedIn</span>' +
        '</label>' +
        '<div id="pjf-li-hint" style="font-size:12px;color:var(--text3,#94a3b8);margin-top:4px"></div>' +
      '</div>' +
      '<div class="pjf-foot"><span class="pjf-msg" id="pjf-msg"></span><button class="jfb-btn ghost" id="pjf-cancel">Cancel</button><button class="jfb-btn" id="pjf-submit">' + esc(o.submitLabel || 'Post Job') + '</button></div></div>';
    document.body.appendChild(ovl);
    document.getElementById('pjf-bodywrap').innerHTML = formHtml();
    setupLinkedInRow(ovl);
    wireMultiselects(ovl.querySelector('.pjf-form'));
    wireConditional(ovl.querySelector('.pjf-form'));
    ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) closePostJob(); });
    ovl.querySelector('#pjf-close').addEventListener('click', closePostJob);
    ovl.querySelector('#pjf-cancel').addEventListener('click', closePostJob);
    ovl.querySelector('#pjf-gear').addEventListener('click', function () { closePostJob(); openBuilderEnsured(); });
    ovl.querySelector('#pjf-submit').addEventListener('click', submitPostJob);
  }
  function closePostJob() { var o = document.getElementById('pjf-ovl'); if (o) o.remove(); }
  function pjfMsg(t, cls) { var m = document.getElementById('pjf-msg'); if (m) { m.textContent = t || ''; m.className = 'pjf-msg' + (cls ? ' ' + cls : ''); } }
  function submitPostJob() {
    var ovl = document.getElementById('pjf-ovl'); if (!ovl) return; var formRoot = ovl.querySelector('.pjf-form');
    var vals = {}, ok = true, firstErr = null;
    formRoot.querySelectorAll('.pjf-err').forEach(function (e) { e.classList.remove('on'); });
    allFields().forEach(function (f) {
      if (f.type === 'heading') return;
      var grp = formRoot.querySelector('[data-fkey="' + cssEsc(f.key) + '"]'); var visible = grp && grp.style.display !== 'none'; var val;
      if (f.type === 'radio') { var r = formRoot.querySelector('[name="' + cssEsc(f.key) + '"]:checked'); val = r ? r.value : ''; }
      else if (f.type === 'multiselect') { var box = formRoot.querySelector('.pjf-multi[data-multi="' + cssEsc(f.key) + '"]'); val = box && box._vals ? box._vals.slice() : []; }
      else if (f.type === 'salary') {
        var mn = formRoot.querySelector('[name="' + cssEsc(f.key) + '__min"]'); var mx = formRoot.querySelector('[name="' + cssEsc(f.key) + '__max"]'); var cu = formRoot.querySelector('[name="' + cssEsc(f.key) + '__cur"]');
        var mnv = mn ? mn.value.trim() : '', mxv = mx ? mx.value.trim() : ''; var cc = cu ? currencyByCode(cu.value) : null; if (cu && (mnv || mxv)) localStorage.setItem(LS_CURRENCY, cu.value);
        val = (mnv || mxv) ? ((cc ? cc.symbol + ' ' : (cu ? cu.value + ' ' : '')) + mnv + (mxv ? ' - ' + mxv : '')) : '';
      }
      else if (f.type === 'currency') { var e2 = formRoot.querySelector('[name="' + cssEsc(f.key) + '"]'); var cu2 = formRoot.querySelector('[name="' + cssEsc(f.key) + '__cur"]'); var cc2 = cu2 ? currencyByCode(cu2.value) : null; if (cu2 && e2 && e2.value) localStorage.setItem(LS_CURRENCY, cu2.value); val = e2 && e2.value ? ((cc2 ? cc2.symbol + ' ' : '') + e2.value) : ''; }
      else { var e3 = formRoot.querySelector('[name="' + cssEsc(f.key) + '"]'); val = e3 ? e3.value : ''; }
      vals[f.key] = val;
      if (f.required && visible && (val === '' || (Array.isArray(val) && !val.length))) { ok = false; var eEl = grp && grp.querySelector('[data-err]'); if (eEl) eEl.classList.add('on'); if (!firstErr) firstErr = grp; }
    });
    if (!ok) { pjfMsg('Please fill the required fields.', 'err'); if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    var liBox = document.getElementById('pjf-li');
    var shareToLinkedIn = !!(liBox && liBox.checked && !liBox.disabled);
    var payload = { customFields: {}, autoPost: shareToLinkedIn, userEmail: actorEmail() };
    allFields().forEach(function (f) {
      if (f.type === 'heading') return; var v = vals[f.key];
      if (CORE_KEYS[f.key]) { if (f.key === 'remote') payload.remote = (v === 'Yes' || v === 'true' || v === true); else if (f.key === 'openings') payload.openings = parseInt(v, 10) || 1; else payload[f.key] = v; }
      // Only persist custom fields that actually have a value — keeps
      // JobPost.custom_fields clean (no empty strings / empty arrays).
      else if (!(v === '' || v == null || (Array.isArray(v) && v.length === 0))) payload.customFields[f.key] = v;
    });
    if (!payload.title || !payload.dept) { pjfMsg('Title and Department are required.', 'err'); return; }

    // Sharing to a public profile gets a review step; plain saves do not.
    if (shareToLinkedIn) { openLinkedInPreview(payload); return; }
    savePostJob(payload, false);
  }

  // Creates the job. `msg` is the approved LinkedIn text, or null when not sharing.
  function savePostJob(payload, share, msg) {
    var btn = document.getElementById('pjf-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    var body = JSON.parse(JSON.stringify(payload));
    body.autoPost = !!share;
    if (share && msg) body.linkedinMessage = msg;
    return api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (job) {
        pjfMsg(opts().successMsg || 'Job posted ✓', 'ok');
        window.dispatchEvent(new CustomEvent('hrmsJobPosted', { detail: {} }));
        // The job is saved either way — a failed share is reported, not fatal.
        if (share) reportShareResult(job && job.socialResults);
        setTimeout(closePostJob, 700);
      })
      .catch(function (e) {
        pjfMsg(e.message || 'Could not post the job.', 'err');
        if (btn) { btn.disabled = false; btn.textContent = opts().submitLabel || 'Post Job'; }
        throw e;
      });
  }

  /* ── LinkedIn review-before-post (shared dialog in hrms-linkedin.js) ───── */
  function openLinkedInPreview(payload) {
    if (!window.HRMSLinkedIn || !window.HRMSLinkedIn.review) {
      savePostJob(payload, true);   // no dialog available — don't block posting
      return;
    }
    window.HRMSLinkedIn.review(payload, payload.userEmail).then(function (text) {
      if (!text) return;            // backed out — nothing saved, form intact
      savePostJob(payload, true, text).catch(function () {});
    });
  }

  /* ── "Also post to my LinkedIn" ───────────────────────────────────────── */
  function setupLinkedInRow(ovl) {
    var row = ovl.querySelector('#pjf-li-row');
    var box = ovl.querySelector('#pjf-li');
    var hint = ovl.querySelector('#pjf-li-hint');
    if (!row || !box || !window.HRMSLinkedIn) return;
    window.HRMSLinkedIn.status().then(function (s) {
      if (!s || !s.configured) return;   // not set up server-side — stay hidden
      row.style.display = '';
      if (s.connected && !s.expired) {
        box.checked = true;
        hint.textContent = s.name ? 'Posting as ' + s.name + '.' : 'Posting to your LinkedIn profile.';
        return;
      }
      box.checked = false;
      box.disabled = true;
      hint.textContent = (s.expired
        ? 'Your LinkedIn connection expired — reconnect it in '
        : 'Connect your LinkedIn account in ') +
        'Settings → Email Configuration → Social Media Accounts.';
    });
  }

  function reportShareResult(results) {
    var li = null;
    for (var i = 0; i < (results || []).length; i++) {
      if (results[i] && results[i].platform === 'linkedin') { li = results[i]; break; }
    }
    if (!li) return;
    liToast(li.ok ? 'Job posted to your LinkedIn.'
                  : 'Job created, but LinkedIn sharing failed: ' + (li.error || 'unknown error'),
            li.ok ? '' : 'error');
  }

  function liToast(text, type) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:100000;' +
      'padding:12px 22px;border-radius:10px;font:600 14px/1.4 inherit;max-width:min(560px,90vw);' +
      'text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.18);color:#fff;transition:opacity .4s;' +
      'background:' + (type === 'error' ? '#ef4444' : '#0a66c2');
    t.textContent = text;
    document.body.appendChild(t);
    var ms = type === 'error' ? 6000 : 3000;
    setTimeout(function () { t.style.opacity = '0'; }, ms);
    setTimeout(function () { t.remove(); }, ms + 500);
  }

  /* ══════════════════════════ INJECTION / BOOT ══════════════════════════ */
  function matchesTrigger(text) { var t = (text || '').trim().toLowerCase().replace(/\s+/g, ' '); return /^[+＋]\s*post\s*job$/.test(t) || t === 'post a job'; }
  function isPostJobTrigger(elm) { if (!elm || !elm.closest) return null; var t = elm.closest('button, a'); if (!t) return null; if (t.id === 'jfb-open-btn' || t.closest('.jfb-ovl') || t.closest('.pjf-ovl')) return null; return matchesTrigger(t.textContent) ? t : null; }
  function injectBuilderButton() {
    if (!onJobsPage() || document.getElementById('jfb-open-btn')) return;
    var trigger = null, btns = document.querySelectorAll('button, a');
    for (var i = 0; i < btns.length; i++) { if (matchesTrigger(btns[i].textContent)) { trigger = btns[i]; break; } }
    if (!trigger || !trigger.parentNode) return;
    var b = el('<button id="jfb-open-btn" type="button">⚙ Form Builder</button>');
    b.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); openBuilderEnsured(); });
    trigger.parentNode.insertBefore(b, trigger.nextSibling);
  }
  // Always re-fetch the latest published schema on open so the builder and the
  // Post-a-Job form never show a stale field set.
  function openBuilderEnsured() { load(function () { openBuilder(); }); }
  document.addEventListener('click', function (e) { var t = isPostJobTrigger(e.target); if (!t) return; e.preventDefault(); e.stopPropagation(); load(function () { openPostJob(); }); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFieldEditor(); });

  function tick() { ensureStyle(); injectBuilderButton(); }
  function startBuilder() {
    if (!state.loaded && !state._loading) load(function () {});
    tick();
    var scheduled = false;
    new MutationObserver(function () { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; tick(); }); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', tick);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startBuilder); else startBuilder();
  window.__hrmsJobFormBuilder = { open: openBuilderEnsured, post: openPostJob };
  console.log('[hrms-job-form-builder v3] loaded');
})();
