/**
 * hrms-company-settings.js
 * Company Details & Employee ID Auto-Generation module.
 *
 * 1. Replaces the static Company Settings card in Settings -> General with
 *    the modern 2-column fit-to-page Company Details & Employee ID rule engine.
 * 2. Displays the user's formatted EMPLOYEE ID under their email in the Right Sidebar (Profile Drawer)
 *    as normal text, with 1-click clipboard copy for both email and employee ID.
 */
(function () {
  'use strict';

  var WRAPPER_ID = 'hrms-company-settings-root';
  var userEmpIdCache = {};

  var state = {
    loading: false,
    loaded: false,
    saving: false,
    backfilling: false,
    data: {
      companyName: 'Eversoft Technologies',
      legalName: 'Eversoft Technologies Private Limited',
      brandName: 'Eversoft',
      companyLogo: '',
      website: 'https://eversoftit.com',
      contactEmail: 'contact@eversoftit.com',
      phone: '+91 98765 43210',
      taxId: '',
      industry: 'Information Technology & Services',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      country: 'India',
      pincode: '',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      dateFormat: 'DD/MM/YYYY',
      workWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      empIdPrefix: 'EV-',
      empIdMinDigits: 4,
      empIdStartNumber: 1,
      empIdSuffix: ''
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
    }
    var hdrs = { 'Content-Type': 'application/json' };
    try {
      var s = JSON.parse(localStorage.getItem('hrms_session') || '{}');
      if (s.email) {
        hdrs['X-User-Email'] = s.email;
        hdrs['X-Actor-Email'] = s.email;
        hdrs['Authorization'] = 'Bearer ' + (s.token || s.email);
      }
    } catch (_) {}
    opts.headers = Object.assign(hdrs, opts.headers || {});
    var url = path.startsWith('/api') ? path : ('/api' + path);
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (txt) {
        var d = null;
        try { d = JSON.parse(txt); } catch (_) {}
        return { ok: r.ok, status: r.status, data: d, raw: txt };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, data: null, error: err };
    });
  }

  function showToast(msg, isErr) {
    var toastEl = document.getElementById('hrms-cs-toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'hrms-cs-toast';
      toastEl.style.cssText =
        'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:99999;' +
        'padding:11px 24px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;' +
        'box-shadow:0 14px 36px rgba(0,0,0,0.35);transition:all 0.25s ease;opacity:0;pointer-events:none;';
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = isErr
      ? 'linear-gradient(135deg, #ef4444, #dc2626)'
      : 'linear-gradient(135deg, #10b981, #059669)';
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    toastEl.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(10px)';
    }, 2800);
  }

  function copyTextToClipboard(text, label) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('✓ Copied ' + label + ': ' + text);
      }).catch(function () {
        fallbackCopy(text, label);
      });
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✓ Copied ' + label + ': ' + text);
    } catch (_) {
      showToast('Copied: ' + text);
    }
  }

  function computeLiveSampleId(d) {
    var src = d || state.data;
    var prefix = src.empIdPrefix != null ? src.empIdPrefix : 'EV-';
    var digits = Math.max(parseInt(src.empIdMinDigits, 10) || 4, 1);
    var start = Math.max(parseInt(src.empIdStartNumber, 10) || 1, 1);
    var suffix = src.empIdSuffix || '';
    var numStr = String(start);
    while (numStr.length < digits) {
      numStr = '0' + numStr;
    }
    return prefix + numStr + suffix;
  }

  function fetchCompanySettings(force) {
    if (state.loading || (state.loaded && !force)) return;
    state.loading = true;
    api('/settings/general')
      .then(function (res) {
        if (res.ok && res.data && typeof res.data === 'object') {
          state.data = Object.assign({}, state.data, res.data);
          state.loaded = true;
        }
      })
      .catch(function (err) {
        console.warn('[CompanySettings] fetch error:', err);
      })
      .finally(function () {
        state.loading = false;
        renderInPlace();
      });
  }

  function saveCompanySettings() {
    state.saving = true;
    var saveBtn = document.getElementById('hrms-cs-save-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }

    api('/settings/general', {
      method: 'PUT',
      body: state.data
    })
      .then(function (res) {
        if (res.ok && res.data) {
          state.data = Object.assign({}, state.data, res.data);
          showToast('✓ Company Details & Employee ID format saved successfully!');
        } else if (res.ok) {
          showToast('✓ Settings updated successfully!');
        } else {
          var errMsg = (res.data && res.data.message) || (res.data && JSON.stringify(res.data)) || 'Could not save settings';
          showToast('⚠️ ' + errMsg, true);
        }
      })
      .catch(function (err) {
        showToast('⚠️ Could not save settings: ' + (err.message || 'Server error'), true);
      })
      .finally(function () {
        state.saving = false;
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<span>💾</span> Save Changes';
        }
        updatePreview();
      });
  }

  function backfillAllEmployeeIds() {
    if (!confirm('Assign sequential Employee IDs to all staff who currently do not have one?')) {
      return;
    }
    state.backfilling = true;
    var bfBtn = document.getElementById('hrms-cs-backfill-btn');
    if (bfBtn) {
      bfBtn.disabled = true;
      bfBtn.textContent = '⟳ Backfilling…';
    }

    api('/settings/general/backfill', {
      method: 'POST',
      body: { force: false }
    })
      .then(function (res) {
        if (res.ok && res.data && res.data.message) {
          showToast('✓ ' + res.data.message);
        } else if (res.ok) {
          showToast('✓ Employee IDs assigned successfully!');
        } else {
          var errMsg = (res.data && res.data.message) || 'Backfill operation failed';
          showToast('⚠️ ' + errMsg, true);
        }
      })
      .catch(function (err) {
        showToast('⚠️ Backfill failed: ' + (err.message || 'Network error'), true);
      })
      .finally(function () {
        state.backfilling = false;
        if (bfBtn) {
          bfBtn.disabled = false;
          bfBtn.textContent = '⚡ Assign IDs to All Staff';
        }
      });
  }

  function buildHtml() {
    var d = state.data;
    var sampleId = computeLiveSampleId(d);
    var daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var curWorkWeek = Array.isArray(d.workWeek) ? d.workWeek : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

    return '' +
      '<div id="' + WRAPPER_ID + '" class="hrms-cs-wrapper" style="width:100%;max-width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding-bottom:30px;">' +
        // Header card
        '<div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;padding:16px 20px;">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<div style="width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,var(--accent,#3b82f6),var(--accent2,#06b6d4));display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;">🏢</div>' +
            '<div>' +
              '<h2 style="margin:0;font-size:18px;font-weight:700;font-family:var(--font-d,sans-serif);color:var(--text,#0f172a);">Company Details & General Settings</h2>' +
              '<p style="margin:2px 0 0;font-size:12px;color:var(--text3,#64748b);">Corporate profile, automated Employee ID sequence rules, and workspace localization.</p>' +
            '</div>' +
          '</div>' +
          '<button type="button" id="hrms-cs-save-btn" class="btn-primary" style="display:inline-flex;align-items:center;gap:6px;padding:9px 20px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;">' +
            '<span>💾</span> Save Changes' +
          '</button>' +
        '</div>' +

        // 2-Column Responsive Layout
        '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:16px;">' +

          // LEFT COLUMN: Corporate Information & Registered Office
          '<div style="display:flex;flex-direction:column;gap:16px;">' +
            // Corporate Profile
            '<div class="card" style="padding:20px;">' +
              '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">' +
                '<span style="font-size:16px;">🏢</span>' +
                '<div class="card-title" style="margin:0;font-size:15px;">CORPORATE PROFILE</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Company Official Name</label>' +
                  '<input type="text" id="hrms-cs-name" class="input-field" value="' + esc(d.companyName) + '" placeholder="e.g. Eversoft Technologies" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Brand Display Name</label>' +
                  '<input type="text" id="hrms-cs-brand" class="input-field" value="' + esc(d.brandName) + '" placeholder="e.g. Eversoft" />' +
                '</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Legal Registered Entity</label>' +
                  '<input type="text" id="hrms-cs-legal" class="input-field" value="' + esc(d.legalName) + '" placeholder="e.g. Eversoft Technologies Pvt Ltd" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Official Website</label>' +
                  '<input type="url" id="hrms-cs-web" class="input-field" value="' + esc(d.website) + '" placeholder="https://eversoftit.com" />' +
                '</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Contact Email</label>' +
                  '<input type="email" id="hrms-cs-email" class="input-field" value="' + esc(d.contactEmail) + '" placeholder="contact@eversoftit.com" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Contact Phone</label>' +
                  '<input type="text" id="hrms-cs-phone" class="input-field" value="' + esc(d.phone) + '" placeholder="+91 98765 43210" />' +
                '</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Tax / GSTIN Number</label>' +
                  '<input type="text" id="hrms-cs-tax" class="input-field" value="' + esc(d.taxId) + '" placeholder="e.g. 36AAACE1234F1Z5" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Industry Sector</label>' +
                  '<input type="text" id="hrms-cs-ind" class="input-field" value="' + esc(d.industry) + '" placeholder="Information Technology" />' +
                '</div>' +
              '</div>' +
            '</div>' +

            // Registered Office Address
            '<div class="card" style="padding:20px;">' +
              '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">' +
                '<span style="font-size:16px;">📍</span>' +
                '<div class="card-title" style="margin:0;font-size:15px;">REGISTERED OFFICE ADDRESS</div>' +
              '</div>' +
              '<div style="margin-bottom:12px;">' +
                '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Street Address</label>' +
                '<input type="text" id="hrms-cs-addr1" class="input-field" value="' + esc(d.addressLine1) + '" placeholder="Building, Suite, Street" />' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">City</label>' +
                  '<input type="text" id="hrms-cs-city" class="input-field" value="' + esc(d.city) + '" placeholder="Hyderabad" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">State / Province</label>' +
                  '<input type="text" id="hrms-cs-state" class="input-field" value="' + esc(d.state) + '" placeholder="Telangana" />' +
                '</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Country</label>' +
                  '<input type="text" id="hrms-cs-country" class="input-field" value="' + esc(d.country) + '" placeholder="India" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Postal Code</label>' +
                  '<input type="text" id="hrms-cs-pin" class="input-field" value="' + esc(d.pincode) + '" placeholder="500081" />' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          // RIGHT COLUMN: ID Rules & Localization
          '<div style="display:flex;flex-direction:column;gap:16px;">' +
            // Employee ID Rules (Featured Card)
            '<div class="card" style="padding:20px;border-top:3px solid var(--accent,#3b82f6);">' +
              '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">' +
                '<div>' +
                  '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<span style="font-size:17px;">🆔</span>' +
                    '<div class="card-title" style="margin:0;font-size:15px;">EMPLOYEE ID RULES</div>' +
                    '<span class="badge green" style="font-size:10px;padding:2px 8px;">Auto-Mint</span>' +
                  '</div>' +
                  '<p style="margin:4px 0 0;font-size:11.5px;color:var(--text3);">Automatic ID sequence rule engine for new team members.</p>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;background:var(--bg3);padding:5px 12px;border-radius:8px;border:1px solid var(--border2);">' +
                  '<span style="font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;">PREVIEW:</span>' +
                  '<span id="hrms-cs-preview-badge" style="font-family:monospace;font-size:13px;font-weight:800;color:var(--accent,#3b82f6);letter-spacing:0.8px;">' + esc(sampleId) + '</span>' +
                '</div>' +
              '</div>' +

              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">ID Prefix</label>' +
                  '<input type="text" id="hrms-cs-prefix" class="input-field" value="' + esc(d.empIdPrefix) + '" placeholder="e.g. EV-, EMP-" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Zero-Padding Digits</label>' +
                  '<select id="hrms-cs-digits" class="input-field">' +
                    '<option value="3"' + (d.empIdMinDigits === 3 ? ' selected' : '') + '>3 Digits (001)</option>' +
                    '<option value="4"' + (d.empIdMinDigits === 4 ? ' selected' : '') + '>4 Digits (0001)</option>' +
                    '<option value="5"' + (d.empIdMinDigits === 5 ? ' selected' : '') + '>5 Digits (00001)</option>' +
                    '<option value="6"' + (d.empIdMinDigits === 6 ? ' selected' : '') + '>6 Digits (000001)</option>' +
                  '</select>' +
                '</div>' +
              '</div>' +

              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Starting Counter</label>' +
                  '<input type="number" id="hrms-cs-start" class="input-field" min="1" value="' + esc(d.empIdStartNumber) + '" />' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Optional Suffix</label>' +
                  '<input type="text" id="hrms-cs-suffix" class="input-field" value="' + esc(d.empIdSuffix) + '" placeholder="e.g. /2026 or -IN" />' +
                '</div>' +
              '</div>' +

              '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 14px;border-radius:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);">' +
                '<div style="font-size:11.5px;color:var(--text2);">✨ Auto-generate IDs for staff missing one</div>' +
                '<button type="button" id="hrms-cs-backfill-btn" class="btn-sm" style="background:var(--accent,#3b82f6);color:#fff;border:none;padding:5px 12px;font-size:11.5px;font-weight:700;border-radius:6px;cursor:pointer;">' +
                  (state.backfilling ? '⟳ Backfilling…' : '⚡ Assign IDs to All Staff') +
                '</button>' +
              '</div>' +
            '</div>' +

            // Localization & Schedule
            '<div class="card" style="padding:20px;">' +
              '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">' +
                '<span style="font-size:16px;">🌐</span>' +
                '<div class="card-title" style="margin:0;font-size:15px;">LOCALIZATION & SCHEDULE</div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">System Timezone</label>' +
                  '<select id="hrms-cs-tz" class="input-field">' +
                    '<option value="Asia/Kolkata"' + (d.timezone === 'Asia/Kolkata' ? ' selected' : '') + '>Asia/Kolkata (IST)</option>' +
                    '<option value="America/New_York"' + (d.timezone === 'America/New_York' ? ' selected' : '') + '>America/New York</option>' +
                    '<option value="Europe/London"' + (d.timezone === 'Europe/London' ? ' selected' : '') + '>Europe/London</option>' +
                    '<option value="Asia/Dubai"' + (d.timezone === 'Asia/Dubai' ? ' selected' : '') + '>Asia/Dubai</option>' +
                  '</select>' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Default Currency</label>' +
                  '<select id="hrms-cs-cur" class="input-field">' +
                    '<option value="INR"' + (d.currency === 'INR' ? ' selected' : '') + '>INR (₹)</option>' +
                    '<option value="USD"' + (d.currency === 'USD' ? ' selected' : '') + '>USD ($)</option>' +
                    '<option value="EUR"' + (d.currency === 'EUR' ? ' selected' : '') + '>EUR (€)</option>' +
                    '<option value="GBP"' + (d.currency === 'GBP' ? ' selected' : '') + '>GBP (£)</option>' +
                  '</select>' +
                '</div>' +
              '</div>' +
              '<div style="margin-bottom:14px;">' +
                '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:4px;">Date Format</label>' +
                '<select id="hrms-cs-df" class="input-field">' +
                  '<option value="DD/MM/YYYY"' + (d.dateFormat === 'DD/MM/YYYY' ? ' selected' : '') + '>DD/MM/YYYY</option>' +
                  '<option value="MM/DD/YYYY"' + (d.dateFormat === 'MM/DD/YYYY' ? ' selected' : '') + '>MM/DD/YYYY</option>' +
                  '<option value="YYYY-MM-DD"' + (d.dateFormat === 'YYYY-MM-DD' ? ' selected' : '') + '>YYYY-MM-DD</option>' +
                '</select>' +
              '</div>' +
              '<div>' +
                '<label style="display:block;font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:6px;">Standard Work Week</label>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                  daysOfWeek.map(function (day) {
                    var isSelected = curWorkWeek.indexOf(day) !== -1;
                    return '<button type="button" class="hrms-cs-day-btn" data-day="' + day + '" style="padding:5px 11px;border-radius:7px;font-size:11.5px;font-weight:600;cursor:pointer;border:1px solid ' + (isSelected ? 'var(--accent,#3b82f6)' : 'var(--border2)') + ';background:' + (isSelected ? 'rgba(59,130,246,0.15)' : 'var(--bg3)') + ';color:' + (isSelected ? 'var(--accent,#3b82f6)' : 'var(--text3)') + ';">' + (isSelected ? '✓ ' : '') + day + '</button>';
                  }).join('') +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function updatePreview() {
    var prefixEl = document.getElementById('hrms-cs-prefix');
    var digitsEl = document.getElementById('hrms-cs-digits');
    var startEl = document.getElementById('hrms-cs-start');
    var suffixEl = document.getElementById('hrms-cs-suffix');
    var previewEl = document.getElementById('hrms-cs-preview-badge');

    if (prefixEl) state.data.empIdPrefix = prefixEl.value;
    if (digitsEl) state.data.empIdMinDigits = parseInt(digitsEl.value, 10) || 4;
    if (startEl) state.data.empIdStartNumber = parseInt(startEl.value, 10) || 1;
    if (suffixEl) state.data.empIdSuffix = suffixEl.value;

    if (previewEl) {
      previewEl.textContent = computeLiveSampleId(state.data);
    }
  }

  function attachListeners() {
    ['hrms-cs-prefix', 'hrms-cs-suffix', 'hrms-cs-start'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', updatePreview);
    });

    var digitsEl = document.getElementById('hrms-cs-digits');
    if (digitsEl) digitsEl.addEventListener('change', updatePreview);

    var saveBtn = document.getElementById('hrms-cs-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function (e) {
        e.preventDefault();
        var nEl = document.getElementById('hrms-cs-name');
        var lEl = document.getElementById('hrms-cs-legal');
        var bEl = document.getElementById('hrms-cs-brand');
        var wEl = document.getElementById('hrms-cs-web');
        var eEl = document.getElementById('hrms-cs-email');
        var pEl = document.getElementById('hrms-cs-phone');
        var tEl = document.getElementById('hrms-cs-tax');
        var iEl = document.getElementById('hrms-cs-ind');
        var aEl = document.getElementById('hrms-cs-addr1');
        var cEl = document.getElementById('hrms-cs-city');
        var sEl = document.getElementById('hrms-cs-state');
        var coEl = document.getElementById('hrms-cs-country');
        var piEl = document.getElementById('hrms-cs-pin');
        var tzEl = document.getElementById('hrms-cs-tz');
        var cuEl = document.getElementById('hrms-cs-cur');
        var dfEl = document.getElementById('hrms-cs-df');

        if (nEl) state.data.companyName = nEl.value.trim();
        if (lEl) state.data.legalName = lEl.value.trim();
        if (bEl) state.data.brandName = bEl.value.trim();
        if (wEl) state.data.website = wEl.value.trim();
        if (eEl) state.data.contactEmail = eEl.value.trim();
        if (pEl) state.data.phone = pEl.value.trim();
        if (tEl) state.data.taxId = tEl.value.trim();
        if (iEl) state.data.industry = iEl.value.trim();
        if (aEl) state.data.addressLine1 = aEl.value.trim();
        if (cEl) state.data.city = cEl.value.trim();
        if (sEl) state.data.state = sEl.value.trim();
        if (coEl) state.data.country = coEl.value.trim();
        if (piEl) state.data.pincode = piEl.value.trim();
        if (tzEl) state.data.timezone = tzEl.value;
        if (cuEl) state.data.currency = cuEl.value;
        if (dfEl) state.data.dateFormat = dfEl.value;

        saveCompanySettings();
      });
    }

    var bfBtn = document.getElementById('hrms-cs-backfill-btn');
    if (bfBtn) {
      bfBtn.addEventListener('click', function (e) {
        e.preventDefault();
        backfillAllEmployeeIds();
      });
    }

    document.querySelectorAll('.hrms-cs-day-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var day = btn.getAttribute('data-day');
        var arr = Array.isArray(state.data.workWeek) ? state.data.workWeek.slice() : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
        var idx = arr.indexOf(day);
        if (idx !== -1) arr.splice(idx, 1);
        else arr.push(day);
        state.data.workWeek = arr;
        renderInPlace();
      });
    });
  }

  function renderInPlace() {
    var cardTitles = document.querySelectorAll('.card-title');
    var targetCard = null;
    for (var i = 0; i < cardTitles.length; i++) {
      var t = cardTitles[i].textContent.trim();
      if (t === 'Company Settings' || t === 'CORPORATE PROFILE') {
        targetCard = cardTitles[i].closest('.card');
        break;
      }
    }

    var existing = document.getElementById(WRAPPER_ID);

    if (targetCard && !existing) {
      var parent = targetCard.parentNode;
      if (parent) {
        var temp = document.createElement('div');
        temp.innerHTML = buildHtml();
        var newEl = temp.firstElementChild;
        parent.replaceChild(newEl, targetCard);
        attachListeners();
      }
    } else if (existing) {
      existing.outerHTML = buildHtml();
      attachListeners();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RIGHT SIDEBAR (PROFILE DRAWER) EMPLOYEE ID & EMAIL COPYABLE
     ───────────────────────────────────────────────────────────── */
  function fetchUserEmpId(email, cb) {
    if (!email) return;
    email = email.trim().toLowerCase();
    if (userEmpIdCache[email]) {
      cb(userEmpIdCache[email]);
      return;
    }
    api('/user-settings/' + encodeURIComponent(email))
      .then(function (res) {
        var eid = '';
        if (res && res.data && res.data.profile && res.data.profile.employeeId) {
          eid = res.data.profile.employeeId;
        }
        if (!eid) {
          // Check session storage
          try {
            var s = JSON.parse(localStorage.getItem('hrms_session') || '{}');
            if (s.email && s.email.toLowerCase() === email && s.employeeId) {
              eid = s.employeeId;
            }
          } catch (_) {}
        }
        if (!eid) eid = 'EV-0001';
        userEmpIdCache[email] = eid;
        cb(eid);
      })
      .catch(function () {
        cb('EV-0001');
      });
  }

  function injectDrawerEmpId() {
    var drawerEmail = document.querySelector('.hrms-drawer-email');
    if (!drawerEmail) return;

    var rawEmail = drawerEmail.getAttribute('data-raw-email');
    if (!rawEmail) {
      rawEmail = drawerEmail.textContent.replace(/[📋\s]+/g, '').trim();
      if (!rawEmail) return;
      drawerEmail.setAttribute('data-raw-email', rawEmail);
      drawerEmail.setAttribute('title', 'Click to copy email');
      drawerEmail.innerHTML = '<span>' + esc(rawEmail) + '</span><span class="hrms-drawer-copy-hint" title="Copy email">📋</span>';
      drawerEmail.onclick = function (e) {
        e.stopPropagation();
        copyTextToClipboard(rawEmail, 'email');
      };
    }

    var existingBadge = document.querySelector('.hrms-drawer-empid');
    if (existingBadge) {
      if (existingBadge.getAttribute('data-email') === rawEmail) return;
      existingBadge.remove();
    }

    var badge = document.createElement('div');
    badge.className = 'hrms-drawer-empid';
    badge.setAttribute('data-email', rawEmail);
    badge.setAttribute('title', 'Click to copy Employee ID');
    badge.innerHTML = '<span class="empid-val">EV-0001</span><span class="hrms-drawer-copy-hint" title="Copy ID">📋</span>';

    drawerEmail.parentNode.insertBefore(badge, drawerEmail.nextSibling);

    fetchUserEmpId(rawEmail, function (eid) {
      if (badge && badge.parentNode) {
        badge.innerHTML = '<span class="empid-val">' + esc(eid) + '</span><span class="hrms-drawer-copy-hint" title="Copy ID">📋</span>';
        badge.onclick = function (e) {
          e.stopPropagation();
          copyTextToClipboard(eid, 'Employee ID');
        };
      }
    });
  }

  function checkAndRender() {
    injectDrawerEmpId();

    if (window.location.pathname.replace(/\/+$/, '') !== '/settings') return;

    var cardTitles = document.querySelectorAll('.card-title');
    for (var i = 0; i < cardTitles.length; i++) {
      if (cardTitles[i].textContent.trim() === 'Company Settings') {
        fetchCompanySettings();
        renderInPlace();
        break;
      }
    }
  }

  setInterval(checkAndRender, 250);

  window.addEventListener('hrmsSettingsTab', function (e) {
    if (e && e.detail && String(e.detail).toLowerCase() === 'general') {
      setTimeout(checkAndRender, 50);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndRender);
  } else {
    checkAndRender();
  }

})();
