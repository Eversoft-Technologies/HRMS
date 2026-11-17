/* AI interview: the video is mandatory.
 *
 *  - __hrmsIvGate(kind, retry)  The interview does not start when the camera /
 *    microphone is blocked or the browser cannot record video: a full-screen
 *    message explains how to fix it, with "Try again".
 *  - __hrmsIvUpload(id, blob)   Uploads the recorded video with progress,
 *    automatic retries and a "don't close this tab" guard. If it still fails,
 *    the candidate gets a "Retry upload" button; the promise resolves only once
 *    the video is on the server (the interview is marked complete then).
 *
 * Called from the interview screen in the React bundle. Our own overlay, on
 * <body>; React nodes are never touched.
 */
(function () {
  'use strict';

  var ID = 'hrms-iv-guard';
  var RETRY_DELAYS = [2000, 5000, 10000];      // automatic retries after the first try

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function overlay() {
    var o = document.getElementById(ID);
    if (!o) {
      o = document.createElement('div');
      o.id = ID;
      o.setAttribute('role', 'alertdialog');
      o.setAttribute('aria-modal', 'true');
      o.setAttribute('style', 'position:fixed;inset:0;z-index:100010;background:rgba(15,23,42,.82);display:flex;' +
        'align-items:center;justify-content:center;padding:20px;font-family:inherit;');
      document.body.appendChild(o);
    }
    return o;
  }
  function closeOverlay() { var o = document.getElementById(ID); if (o) o.remove(); }

  function card(icon, title, body, buttons) {
    var o = overlay();
    o.innerHTML =
      '<div style="background:var(--bg2,#fff);color:var(--text,#0f172a);border-radius:16px;max-width:460px;width:100%;' +
      'padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,.4);text-align:center">' +
      '<div style="font-size:40px;line-height:1;margin-bottom:12px">' + icon + '</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:10px">' + esc(title) + '</div>' +
      '<div style="font-size:13.5px;line-height:1.6;color:var(--text2,#475569)">' + body + '</div>' +
      (buttons || '') + '</div>';
    return o;
  }
  function btn(id, label, primary) {
    return '<button type="button" id="' + id + '" style="margin-top:18px;padding:11px 22px;border-radius:10px;border:' +
      (primary ? 'none;background:var(--accent,#4f8ef7);color:#fff' : '1px solid var(--border2,#cbd5e1);background:transparent;color:inherit') +
      ';font:inherit;font-weight:600;cursor:pointer">' + esc(label) + '</button>';
  }

  /* ── no camera / no recording: the interview does not start ──────────── */
  window.__hrmsIvGate = function (kind, retry) {
    var body = kind === 'recorder'
      ? 'This browser cannot record the interview video, and the interview needs a video recording. ' +
        'Please open the interview link in the latest <b>Google Chrome</b>, <b>Microsoft Edge</b> or <b>Firefox</b> on a computer.'
      : 'The interview is recorded on video, so it needs your <b>camera and microphone</b>. ' +
        'Click the camera icon in the browser’s address bar, choose <b>Allow</b>, check no other app is using the camera, ' +
        'then press <b>Try again</b>.';
    card('🎥', kind === 'recorder' ? 'Video recording not supported' : 'Camera and microphone needed', body,
      btn('hrms-iv-retry', 'Try again', true));
    document.getElementById('hrms-iv-retry').onclick = function () { closeOverlay(); if (retry) retry(); };
  };

  /* ── the video upload: retried until it is on the server ─────────────── */
  var uploading = false;
  function beforeUnload(e) {
    if (!uploading) return;
    e.preventDefault();
    e.returnValue = 'Your interview video is still uploading. If you leave now, your interview will not be completed.';
    return e.returnValue;
  }
  window.addEventListener('beforeunload', beforeUnload);

  function sendOnce(id, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/interview-recordings/' + encodeURIComponent(id) + '/video');
      xhr.setRequestHeader('Content-Type', blob.type || 'video/webm');
      xhr.timeout = 15 * 60 * 1000;
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        var msg = 'HTTP ' + xhr.status;
        try { msg = (JSON.parse(xhr.responseText) || {}).message || msg; } catch (_) {}
        if (xhr.status === 413) msg = 'the video is larger than the server accepts';
        reject(new Error(msg));
      };
      xhr.onerror = function () { reject(new Error('the connection dropped')); };
      xhr.ontimeout = function () { reject(new Error('the upload took too long')); };
      xhr.send(blob);
    });
  }

  function progressCard(pct, attempt, total) {
    var mb = '';
    card('⏳', 'Uploading your interview video…',
      'Please <b>keep this tab open</b> until the upload finishes — your interview is complete only once the video is saved.' +
      '<div style="margin:16px 0 6px;height:10px;border-radius:5px;background:var(--bg3,#e2e8f0);overflow:hidden">' +
      '<div id="hrms-iv-bar" style="height:100%;width:' + Math.round(pct * 100) + '%;background:var(--accent,#4f8ef7);transition:width .2s"></div></div>' +
      '<div id="hrms-iv-pct" style="font-size:12px;color:var(--text3,#64748b)">' + Math.round(pct * 100) + '%' +
      (attempt > 1 ? ' · attempt ' + attempt + ' of ' + total : '') + mb + '</div>');
  }

  window.__hrmsIvUpload = function (id, blob) {
    return new Promise(function (resolve) {
      var total = RETRY_DELAYS.length + 1;
      function run(attempt) {
        uploading = true;
        progressCard(0, attempt, total);
        sendOnce(id, blob, function (f) {
          var bar = document.getElementById('hrms-iv-bar'), pct = document.getElementById('hrms-iv-pct');
          if (bar) bar.style.width = Math.round(f * 100) + '%';
          if (pct) pct.textContent = Math.round(f * 100) + '%' + (attempt > 1 ? ' · attempt ' + attempt + ' of ' + total : '');
        }).then(function () {
          uploading = false;
          card('✅', 'Interview video saved', 'Thank you — your interview is complete.',
            btn('hrms-iv-ok', 'Close', true));
          document.getElementById('hrms-iv-ok').onclick = closeOverlay;
          resolve();
        }).catch(function (err) {
          if (attempt < total) {
            var wait = RETRY_DELAYS[attempt - 1];
            card('🔄', 'Upload interrupted — retrying',
              'The upload failed (' + esc(err.message) + '). Trying again in ' + Math.round(wait / 1000) + ' seconds… Please keep this tab open.');
            setTimeout(function () { run(attempt + 1); }, wait);
            return;
          }
          // Out of automatic retries: the candidate decides when to try again.
          card('⚠️', 'Your video has not been uploaded yet',
            'The upload failed (' + esc(err.message) + '). Your answers are saved, but <b>the interview is not complete until the video is uploaded</b>. ' +
            'Check your internet connection, keep this tab open, and press <b>Retry upload</b>.',
            btn('hrms-iv-again', 'Retry upload', true));
          document.getElementById('hrms-iv-again').onclick = function () { run(1); };
        });
      }
      run(1);
    });
  };
})();
