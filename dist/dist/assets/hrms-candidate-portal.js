/**
 * hrms-candidate-portal.js
 * Handles candidate-facing onboarding & payroll document filling/signing.
 * Intercepts /onboarding/fill?token=TOKEN
 */
(function () {
  'use strict';

  var API_BASE = '/api';

  function getQueryParam(name) {
    var m = RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m && decodeURIComponent(m[1].replace(/\+/g, ' '));
  }

  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload = function () { resolve(window.PDFLib); };
      document.head.appendChild(s);
    });
  }

  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    var hdrs = { 'Content-Type': 'application/json' };
    var tok = getQueryParam('token');
    if (tok) hdrs['X-Candidate-Token'] = tok;
    opts.headers = Object.assign(hdrs, opts.headers || {});
    return fetch(API_BASE + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var e = new Error((d && (d.message || d.error || d.detail)) || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  function ensureStyle() {
    if (document.getElementById('candidate-portal-styles')) return;
    var st = document.createElement('style');
    st.id = 'candidate-portal-styles';
    st.textContent = [
      '.cp-container{max-width:800px;margin:40px auto;padding:24px;font-family:"DM Sans",sans-serif;color:var(--text,#e6edf7)}',
      '.cp-card{background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);border-radius:16px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,0.2);margin-bottom:24px}',
      '.cp-header{display:flex;align-items:center;gap:16px;margin-bottom:24px;border-bottom:1px solid var(--border,#2a3446);padding-bottom:20px}',
      '.cp-logo{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#a855f7));display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:800}',
      '.cp-title{font-size:24px;font-weight:800;margin:0;color:var(--text,#e6edf7)}',
      '.cp-subtitle{font-size:14px;color:var(--muted,#8a9bb8);margin-top:4px}',
      '.cp-form-item{background:var(--bg3,#1c2433);border:1px solid var(--border,#2a3446);border-radius:12px;padding:20px;margin-bottom:16px;transition:0.15s}',
      '.cp-form-item:hover{border-color:var(--accent,#4f8ef7)}',
      '.cp-form-header{display:flex;justify-content:space-between;align-items:center;cursor:pointer}',
      '.cp-form-name{font-size:16px;font-weight:700}',
      '.cp-badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700}',
      '.cp-badge.pending{background:rgba(245,158,11,0.15);color:#f59e0b}',
      '.cp-badge.completed{background:rgba(34,197,94,0.15);color:#22c55e}',
      '.cp-form-body{margin-top:16px;border-top:1px solid var(--border2,#1d2634);padding-top:16px;display:none}',
      '.cp-toggle-btns{display:flex;gap:8px;margin-bottom:20px}',
      '.cp-toggle-btn{flex:1;background:var(--bg2,#141b26);border:1px solid var(--border,#2a3446);color:var(--muted,#8a9bb8);padding:10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}',
      '.cp-toggle-btn.active{background:var(--accent,#4f8ef7);color:#fff;border-color:var(--accent,#4f8ef7)}',
      '.cp-input-group{margin-bottom:14px}',
      '.cp-label{display:block;font-size:12px;color:var(--muted,#8a9bb8);margin-bottom:5px;font-weight:600}',
      '.cp-input{width:100%;background:var(--bg,#0d131c);border:1px solid var(--border,#2a3446);border-radius:8px;padding:10px;color:var(--text,#e6edf7);font-size:13px}',
      '.cp-canvas-wrap{border:2px dashed var(--border,#2a3446);border-radius:12px;background:var(--bg,#0d131c);position:relative;margin-bottom:12px}',
      '.cp-canvas{display:block;width:100%;height:150px;cursor:crosshair}',
      '.cp-canvas-clear{position:absolute;top:10px;right:10px;background:rgba(239,68,68,0.1);color:#ef4444;border:none;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer}',
      '.cp-btn{background:var(--accent,#4f8ef7);color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;width:100%}',
      '.cp-btn:hover{opacity:0.9}',
      '.cp-btn.secondary{background:var(--bg3,#1c2433);border:1px solid var(--border,#2a3446);color:var(--text,#e6edf7)}',
      '.cp-btn:disabled{opacity:0.5;cursor:not-allowed}',
      '.cp-upload-zone{border:2px dashed var(--border,#2a3446);border-radius:12px;padding:32px;text-align:center;color:var(--muted,#8a9bb8);cursor:pointer;margin-bottom:16px}',
      '.cp-upload-zone:hover{border-color:var(--accent,#4f8ef7);background:var(--bg3,#1c2433)}',
      '.cp-error{color:#ef4444;font-size:12px;margin-top:10px;font-weight:600}',
      '.cp-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:12px 24px;border-radius:8px;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:99999;transition:opacity 0.4s}',
      '@keyframes cp-spin{to{transform:rotate(360deg)}}',
      '.cp-spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:cp-spin 0.8s linear infinite;margin-right:8px;vertical-align:middle}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.className = 'cp-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 2500);
    setTimeout(function () { t.remove(); }, 3000);
  }

  // Pre-configured basic schemas for standard forms
  var DEFAULT_FORM_SCHEMAS = {
    'W-4': [
      { key: 'fullName', label: '1. Full Name', type: 'text', x: 50, y: 640 },
      { key: 'ssn', label: '2. Social Security Number (SSN)', type: 'text', x: 420, y: 640 },
      { key: 'address', label: '3. Home Address', type: 'text', x: 50, y: 590 },
      { key: 'filingStatus', label: '4. Filing Status (Single/Married)', type: 'text', x: 50, y: 540 }
    ],
    'Direct Deposit': [
      { key: 'bankName', label: 'Bank Name', type: 'text', x: 100, y: 600 },
      { key: 'routingNumber', label: 'Routing Number (9 digits)', type: 'text', x: 100, y: 540 },
      { key: 'accountNumber', label: 'Account Number', type: 'text', x: 100, y: 480 },
      { key: 'accountType', label: 'Account Type (Checking/Savings)', type: 'text', x: 100, y: 420 }
    ]
  };

  async function generateCompletedPdf(blankPdfBase64, filledData, sigBase64, schema) {
    var pdfLib = await loadPdfLib();
    var pdfDoc = await pdfLib.PDFDocument.load(blankPdfBase64);
    var pages = pdfDoc.getPages();
    var firstPage = pages[0];

    // Overlay text fields
    if (schema && schema.length) {
      schema.forEach(function (f) {
        var val = filledData[f.key] || '';
        if (val) {
          firstPage.drawText(val, {
            x: f.x || 100,
            y: f.y || 100,
            size: 11,
            color: pdfLib.rgb(0.1, 0.1, 0.1)
          });
        }
      });
    }

    // Overlay signature at standard bottom position if not in schema
    if (sigBase64) {
      try {
        var sigImg = await pdfDoc.embedPng(sigBase64);
        var sigX = 150;
        var sigY = 150;
        
        // Find if signature coordinates are specified
        var sigField = (schema || []).find(function (f) { return f.key === 'signature'; });
        if (sigField) {
          sigX = sigField.x;
          sigY = sigField.y;
        }

        firstPage.drawImage(sigImg, {
          x: sigX,
          y: sigY,
          width: 140,
          height: 50
        });
      } catch (e) {
        console.error('[Candidate Portal] signature overlay error:', e);
      }
    }

    var pdfBytes = await pdfDoc.save();
    // Convert Uint8Array back to base64 for API transmission
    var binary = '';
    var len = pdfBytes.byteLength;
    for (var i = 0; i < len; i++) {
      binary += String.fromCharCode(pdfBytes[i]);
    }
    return window.btoa(binary);
  }

  function renderFormItem(f, index, token) {
    var id = 'form-body-' + f.id;
    var state = { mode: 'offline' };

    var item = document.createElement('div');
    item.className = 'cp-form-item';
    item.innerHTML = [
      '<div class="cp-form-header" id="header-' + f.id + '">',
      '  <span class="cp-form-name">' + esc(f.name) + '</span>',
      '  <span class="cp-badge ' + (f.isSubmitted ? 'completed' : 'pending') + '">',
      '    ' + (f.isSubmitted ? 'Submitted' : 'Pending') + '</span>',
      '</div>',
      '<div class="cp-form-body" id="' + id + '">',
      '  <div class="cp-error" id="err-' + f.id + '"></div>',
      '  <div id="content-off-' + f.id + '">',
      '    <p style="font-size:13px;color:var(--muted,#8a9bb8);line-height:1.6;margin:0 0 16px;">',
      '      Download this document, fill it out, sign physically, and upload a clear scan or photo back here.',
      '    </p>',
      '    <button class="cp-btn secondary" style="margin-bottom:16px" id="dl-' + f.id + '">⬇ Download Blank PDF Template</button>',
      '    <div class="cp-upload-zone" id="up-zone-' + f.id + '">',
      '      <span style="font-size:24px;display:block;margin-bottom:8px">⬆</span>',
      '      Drag &amp; drop your completed PDF/image here, or click to browse',
      '      <input type="file" id="file-inp-' + f.id + '" accept=".pdf,.png,.jpg,.jpeg" hidden>',
      '    </div>',
      '    <div style="font-size:12px;color:var(--muted,#8a9bb8);text-align:center" id="up-info-' + f.id + '"></div>',
      '    <button class="cp-btn" style="margin-top:12px" id="submit-off-' + f.id + '" disabled>Submit Offline Document</button>',
      '  </div>',
      '</div>'
    ].join('');

    // Toggle body expansion
    item.querySelector('#header-' + f.id).addEventListener('click', function () {
      var body = item.querySelector('#' + id);
      var current = body.style.display;
      body.style.display = current === 'block' ? 'none' : 'block';
    });

    var errEl = item.querySelector('#err-' + f.id);

    // Handle offline download
    item.querySelector('#dl-' + f.id).addEventListener('click', function () {
      api('/public/onboarding/forms/' + f.id).then(function (template) {
        var link = document.createElement('a');
        link.href = 'data:' + template.fileMime + ';base64,' + template.fileData;
        link.download = template.fileName || (template.name + '.pdf');
        link.click();
      }).catch(function (e) {
        errEl.textContent = 'Failed to download form: ' + e.message;
      });
    });

    // Handle offline upload
    var offlineFileBase64 = '';
    var offlineFileName = '';
    var offlineFileMime = '';
    var upZone = item.querySelector('#up-zone-' + f.id);
    var fileInp = item.querySelector('#file-inp-' + f.id);
    var upInfo = item.querySelector('#up-info-' + f.id);
    var btnSubmitOff = item.querySelector('#submit-off-' + f.id);

    upZone.addEventListener('click', function () { fileInp.click(); });
    fileInp.addEventListener('change', function () {
      var file = fileInp.files[0];
      if (!file) return;

      if (file.size > 10 * 1024 * 1024) {
        errEl.textContent = 'File exceeds maximum limit of 10MB.';
        return;
      }

      var reader = new FileReader();
      reader.onload = function (e) {
        offlineFileBase64 = e.target.result.split(',')[1];
        offlineFileName = file.name;
        offlineFileMime = file.type;
        upInfo.innerHTML = '<strong>Selected:</strong> ' + esc(file.name) + ' (' + Math.round(file.size/1024) + ' KB)';
        btnSubmitOff.disabled = false;
      };
      reader.readAsDataURL(file);
    });

    btnSubmitOff.addEventListener('click', function () {
      btnSubmitOff.disabled = true;
      btnSubmitOff.innerHTML = '<span class="cp-spinner"></span> Uploading completed document…';
      errEl.textContent = '';

      api('/public/onboarding/submit-form', {
        method: 'POST',
        body: {
          token: token,
          formId: f.id,
          mode: 'offline',
          fileData: offlineFileBase64,
          fileName: offlineFileName,
          fileMime: offlineFileMime
        }
      }).then(function () {
        showToast('Document uploaded successfully!');
        location.reload();
      }).catch(function (e) {
        btnSubmitOff.disabled = false;
        btnSubmitOff.innerHTML = 'Submit Offline Document';
        errEl.textContent = e.message;
      });
    });

    return item;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderGoodbyeScreen() {
    var cardEl = document.querySelector('.cp-card');
    if (cardEl) {
      cardEl.innerHTML = [
        '<div style="text-align:center;padding:40px 20px;">',
          '<div style="font-size:48px;margin-bottom:20px;">🎉</div>',
          '<h2 style="font-size:20px;font-weight:800;color:var(--text,#e6edf7);margin-bottom:12px;">Onboarding Submitted!</h2>',
          '<p style="font-size:14px;color:var(--muted,#8a9bb8);line-height:1.6;max-width:440px;margin:0 auto 24px;">',
            'Thank you for submitting your onboarding documents and forms. <strong>Our team will verify your submissions and get back to you shortly.</strong> Your access token has been deactivated and onboarding is now closed.',
          '</p>',
          '<div style="border-top:1px solid var(--border,#2a3446);padding-top:20px;font-size:12px;color:var(--muted,#8a9bb8);">',
            'If you need to update any submitted information, please reach out directly to your HR representative.',
          '</div>',
        '</div>'
      ].join('\n');
    }
  }

  function renderPortal(token) {
    var root = document.getElementById('root');
    if (!root) return;

    ensureStyle();

    root.innerHTML = [
      '<div class="cp-container">',
      '  <div class="cp-card">',
      '    <div class="cp-header">',
      '      <img src="/logo.jpg" alt="Company Logo" style="width:48px;height:48px;border-radius:12px;object-fit:contain;background:#fff;border:1px solid var(--border,#2a3446)">',
      '      <div style="flex:1">',
      '        <h1 class="cp-title" id="candidate-name">Onboarding Forms</h1>',
      '        <div class="cp-subtitle">Please complete the required paper forms and upload onboarding documents</div>',
      '      </div>',
      '    </div>',
      '    <div id="forms-list">',
      '      <div class="ob-empty">Loading your onboarding portal…</div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');

    api('/public/onboarding/forms?token=' + token)
      .then(function (data) {
        document.getElementById('candidate-name').textContent =
          (data.candidate.firstName + ' ' + data.candidate.lastName).trim() + ' Onboarding Portal';

        var confirmedKey = 'candidate_confirmed_' + token;
        var confirmed = sessionStorage.getItem(confirmedKey) === 'true';

        function drawPortalBody() {
          var listEl = document.getElementById('forms-list');
          if (!listEl) return;
          listEl.innerHTML = '';

          if (!confirmed) {
            // Show confirmation screen
            listEl.innerHTML = [
              '<div style="background:var(--bg3,#1c2433);border:1px solid var(--border,#2a3446);border-radius:12px;padding:24px;margin-bottom:20px;text-align:center;">',
                '<h2 style="font-size:16px;font-weight:700;margin-bottom:12px;color:var(--text,#e6edf7)">Confirm Your Details</h2>',
                '<p style="font-size:13px;color:var(--muted,#8a9bb8);margin-bottom:20px;">Please verify your details below. Once confirmed, you will gain access to upload your onboarding documents.</p>',
                '<div style="display:flex;flex-direction:column;gap:10px;max-width:320px;margin:0 auto 20px;text-align:left;">',
                  '<div>',
                    '<span style="font-size:11px;color:var(--muted,#8a9bb8);font-weight:600;display:block;">NAME</span>',
                    '<strong style="font-size:15px;color:var(--text,#e6edf7);">' + esc(data.candidate.name) + '</strong>',
                  '</div>',
                  '<div>',
                    '<span style="font-size:11px;color:var(--muted,#8a9bb8);font-weight:600;display:block;">EMAIL</span>',
                    '<strong style="font-size:15px;color:var(--text,#e6edf7);">' + esc(data.candidate.email) + '</strong>',
                  '</div>',
                '</div>',
                '<div style="margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:8px;">',
                  '<input type="checkbox" id="chk-confirm-identity" style="width:18px;height:18px;cursor:pointer;">',
                  '<label for="chk-confirm-identity" style="font-size:13px;color:var(--text,#e6edf7);cursor:pointer;user-select:none;">I confirm that my name and email are correct</label>',
                '</div>',
                '<button class="cp-btn" id="btn-confirm-identity" style="max-width:240px;margin:0 auto;" disabled>Confirm &amp; Proceed</button>',
              '</div>'
            ].join('\n');

            var chk = listEl.querySelector('#chk-confirm-identity');
            var btn = listEl.querySelector('#btn-confirm-identity');
            
            chk.addEventListener('change', function() {
              btn.disabled = !chk.checked;
            });

            btn.addEventListener('click', function() {
              confirmed = true;
              sessionStorage.setItem(confirmedKey, 'true');
              drawPortalBody();
            });
            return;
          }

          // 1. Render Onboarding Documents checklist
          var requestedList = data.candidate.requestedDocs || [];
          var activeRequests = requestedList.filter(function (item) { return item.sendToCandidate; });

          if (activeRequests.length > 0) {
            var docsTitle = document.createElement('h3');
            docsTitle.style.cssText = 'font-size:18px;margin:16px 0 16px;color:var(--text,#e6edf7);font-weight:700';
            docsTitle.textContent = 'Required Onboarding Documents';
            listEl.appendChild(docsTitle);

            activeRequests.forEach(function (item) {
              // Find matched uploaded document
              var match = (data.uploadedDocs || []).find(function (u) {
                return u.docType === item.type ||
                       u.docType === 'custom_' + item.type ||
                       (u.label || '').toLowerCase() === (item.label || '').toLowerCase();
              });

              var docItem = document.createElement('div');
              docItem.className = 'cp-form-item';
              
              var headId = 'doc-head-' + item.type;
              var bodyId = 'doc-body-' + item.type;

              docItem.innerHTML = [
                '<div class="cp-form-header" id="' + headId + '">',
                '  <span class="cp-form-name">' + esc(item.label) + (item.required ? ' <span style="color:#ef4444">*</span>' : '') + '</span>',
                '  <span class="cp-badge ' + (match ? 'completed' : 'pending') + '">',
                '    ' + (match ? 'Completed' : 'Pending') + '</span>',
                '</div>',
                '<div class="cp-form-body" id="' + bodyId + '">',
                '  <div class="cp-error" id="doc-err-' + item.type + '"></div>',
                '  <div id="doc-cont-' + item.type + '">',
                (match 
                  ? '    <p style="font-size:13px;color:var(--muted,#8a9bb8);margin-bottom:12px">File uploaded: <strong>' + esc(match.fileName) + '</strong> (' + Math.round(match.fileSize / 1024) + ' KB) on ' + match.uploadedAt + '</p>'
                  : ''),
                '    <div class="cp-upload-zone" id="doc-up-zone-' + item.type + '">',
                '      <span style="font-size:24px;display:block;margin-bottom:8px">⬆</span>',
                (match ? 'Upload new version / replace document' : 'Drag &amp; drop file here, or click to browse'),
                '      <input type="file" id="doc-file-inp-' + item.type + '" accept=".pdf,.png,.jpg,.jpeg" hidden>',
                '    </div>',
                '    <div style="font-size:12px;color:var(--muted,#8a9bb8);text-align:center" id="doc-up-info-' + item.type + '"></div>',
                '    <button class="cp-btn" style="margin-top:12px;display:none" id="doc-btn-submit-' + item.type + '">Upload Document</button>',
                '  </div>',
                '</div>'
              ].join('\n');

              docItem.querySelector('#' + headId).addEventListener('click', function () {
                var body = docItem.querySelector('#' + bodyId);
                var current = body.style.display;
                body.style.display = current === 'block' ? 'none' : 'block';
              });

              var upZone = docItem.querySelector('#doc-up-zone-' + item.type);
              var fileInp = docItem.querySelector('#doc-file-inp-' + item.type);
              var infoEl = docItem.querySelector('#doc-up-info-' + item.type);
              var submitBtn = docItem.querySelector('#doc-btn-submit-' + item.type);
              var errEl = docItem.querySelector('#doc-err-' + item.type);

              var base64 = '';
              var fileName = '';
              var fileMime = '';

              upZone.addEventListener('click', function () { fileInp.click(); });
              fileInp.addEventListener('change', function () {
                var file = fileInp.files[0];
                if (!file) return;

                if (file.size > 10 * 1024 * 1024) {
                  errEl.textContent = 'File exceeds maximum limit of 10MB.';
                  return;
                }

                var reader = new FileReader();
                reader.onload = function (e) {
                  base64 = e.target.result.split(',')[1];
                  fileName = file.name;
                  fileMime = file.type;
                  infoEl.innerHTML = '<strong>Selected:</strong> ' + esc(file.name) + ' (' + Math.round(file.size/1024) + ' KB)';
                  submitBtn.style.display = 'block';
                };
                reader.readAsDataURL(file);
              });

              submitBtn.addEventListener('click', function () {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="cp-spinner"></span> Uploading document…';
                errEl.textContent = '';

                api('/public/onboarding/upload-document', {
                  method: 'POST',
                  body: {
                    token: token,
                    docType: item.type,
                    isCustom: item.type.startsWith('custom_'),
                    label: item.label,
                    fileData: base64,
                    fileName: fileName,
                    fileMime: fileMime
                  }
                }).then(function () {
                  showToast('Document uploaded successfully!');
                  location.reload();
                }).catch(function (e) {
                  submitBtn.disabled = false;
                  submitBtn.innerHTML = 'Upload Document';
                  errEl.textContent = e.message;
                });
              });

              listEl.appendChild(docItem);
            });
          }

          // 2. Render Payroll Paper Forms Checklist
          var formsTitle = document.createElement('h3');
          formsTitle.style.cssText = 'font-size:18px;margin:28px 0 16px;color:var(--text,#e6edf7);font-weight:700';
          formsTitle.textContent = 'Payroll & Paper Forms';
          listEl.appendChild(formsTitle);

          if (!data.forms || !data.forms.length) {
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'ob-empty';
            emptyDiv.textContent = 'No payroll or paper forms are assigned at this moment.';
            listEl.appendChild(emptyDiv);
          } else {
            data.forms.forEach(function (f, idx) {
              listEl.appendChild(renderFormItem(f, idx, token));
            });
          }

          // 3. Render Complete & Exit button at the bottom of the portal page
          var exitContainer = document.createElement('div');
          exitContainer.style.cssText = 'margin-top:40px;padding-top:24px;border-top:1px solid var(--border,#2a3446);text-align:center;';
          exitContainer.innerHTML = [
            '<p style="font-size:13px;color:var(--muted,#8a9bb8);margin-bottom:14px;">If you have finished uploading all documents and signing all forms, you can submit and close your onboarding portal access.</p>',
            '<button class="cp-btn" id="btn-complete-exit" style="max-width:280px;margin:0 auto;background:#22c55e;border-color:#22c55e;color:#fff;">Completed &amp; Exit Portal</button>'
          ].join('\n');
          listEl.appendChild(exitContainer);

          exitContainer.querySelector('#btn-complete-exit').addEventListener('click', function() {
            if (!confirm('Are you sure you want to complete onboarding and close your portal access? You will not be able to log back in.')) return;
            
            var exitBtn = exitContainer.querySelector('#btn-complete-exit');
            exitBtn.disabled = true;
            exitBtn.innerHTML = '<span class="cp-spinner"></span> Deactivating access and exiting…';

            api('/public/onboarding/complete', {
              method: 'POST',
              body: { token: token }
            }).then(function() {
              showToast('Onboarding completed! Access closed.');
              renderGoodbyeScreen();
            }).catch(function(err) {
              exitBtn.disabled = false;
              exitBtn.innerHTML = 'Completed &amp; Exit Portal';
              alert(err.message || 'Failed to complete onboarding.');
            });
          });
        }

        drawPortalBody();
      })
      .catch(function (err) {
        document.getElementById('forms-list').innerHTML =
          '<div class="cp-error" style="text-align:center;padding:24px;">Failed to load candidate portal: ' + esc(err.message) + '</div>';
      });
  }


  // Intercept route check
  var normPath = window.location.pathname.replace(/\/$/, '');
  if (normPath === '/onboarding/fill') {
    var run = function () {
      var token = getQueryParam('token');
      if (token) {
        renderPortal(token);
      } else {
        document.getElementById('root').innerHTML =
          '<div class="cp-error" style="text-align:center;padding:40px;">Onboarding link token is missing. Please check your invitation email.</div>';
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      setTimeout(run, 150);
    }
  }

})();
