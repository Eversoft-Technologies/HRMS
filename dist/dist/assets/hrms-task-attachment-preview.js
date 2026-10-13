/**
 * hrms-task-attachment-preview.js
 * ---------------------------------------------------------------------------
 * Employees > Task Tracker (/employees/tasks).
 *
 * The task "View" modal renders an attached file as a plain
 * <a href="data:...;base64,..." download>📎 name</a> — clicking it downloads
 * immediately, with no way to see what it actually is first — and an
 * attached image as a bare inline <img>. This intercepts clicks on both and
 * opens a preview popup instead: the image (or an inline PDF), with a
 * Download and a Close button in the top-right corner. Choosing Download
 * from the popup saves the exact same file the direct link would have.
 *
 * No-rebuild injection pattern: our own overlay, appended to <body> and
 * never touching the React-owned task modal underneath it, so there is
 * nothing for React's reconciliation to trip over on its next re-render.
 */
(function () {
  'use strict';

  var TASKS_PATH = '/employees/tasks';
  var STYLE_ID = 'tkap-style';
  var OVL_ID = 'tkap-ovl';

  function onPage() { return location.pathname.replace(/\/+$/, '') === TASKS_PATH; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function mimeOf(dataUrl) {
    var m = /^data:([^;,]*)/.exec(dataUrl || '');
    return m ? m[1] : '';
  }
  // Rough decoded size of a base64 data: URL, for the "97.8 KB" line under
  // the filename — nothing in the DOM otherwise carries the byte count.
  function sizeOfDataUrl(dataUrl) {
    var b64 = String(dataUrl || '').split(',')[1] || '';
    var pad = (b64.slice(-2).match(/=/g) || []).length;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.tkap-ovl{position:fixed;inset:0;z-index:100001;background:rgba(2,6,23,.75);display:flex;align-items:center;justify-content:center;padding:18px;}',
      // Explicit height (not just max-height): a flex child needs a bounded
      // ancestor height to shrink-to-fit instead of growing with its
      // content. Without this the PDF <iframe> — which reports its own
      // natural size once its viewer renders — pushed the whole box taller
      // than the screen and broke out from behind the dark overlay.
      '.tkap-modal{background:var(--bg2,#151b2e);border:1px solid var(--border2);border-radius:14px;width:min(1100px,96vw);height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(2,6,23,.5);}',
      '.tkap-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--border2);}',
      '.tkap-hinfo{min-width:0;}',
      '.tkap-title{font-size:15px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tkap-size{font-size:11.5px;color:var(--text3,#64748b);margin-top:2px;}',
      '.tkap-acts{flex:none;display:flex;gap:10px;}',
      '.tkap-acts button{font:inherit;font-size:13px;font-weight:700;border-radius:9px;padding:9px 18px;cursor:pointer;white-space:nowrap;}',
      '.tkap-dl{background:none;border:1px solid transparent;color:var(--accent,#4f8ef7);}',
      '.tkap-dl:hover{background:rgba(79,142,247,.12);}',
      '.tkap-x{background:var(--bg3);border:1px solid var(--border2);color:var(--text2,var(--text));}',
      '.tkap-x:hover{border-color:var(--text3,#64748b);}',
      // min-height:0 is the fix — a flex child otherwise refuses to shrink
      // below its content's natural size, which is exactly what let the PDF
      // viewer's own height dictate the whole modal's.
      '.tkap-body{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:18px;background:var(--bg1,#0b1120);}',
      '.tkap-img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;display:block;}',
      '.tkap-frame{width:100%;height:100%;border:none;border-radius:8px;background:#fff;}',
      '.tkap-generic{text-align:center;color:var(--text2,var(--text));padding:20px;}',
      '.tkap-generic svg{color:var(--text3,#64748b);margin-bottom:10px;}',
      '.tkap-fname{font-size:13px;font-weight:700;margin-bottom:4px;word-break:break-word;}',
      '.tkap-fnote{font-size:11.5px;color:var(--text3,#64748b);}',
      '@media(max-width:640px){.tkap-modal{height:94vh;} .tkap-title{max-width:46vw;}}',
      // Stand-in for the image React renders inline in the task view (now
      // hidden — see hideInlineImages()) — styled to match the file
      // attachment's own "📎 name" link so both read as the same affordance.
      '.tkap-thumb{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--accent,#4f8ef7);text-decoration:none;cursor:pointer;background:none;border:none;font-family:inherit;padding:0;}',
      '.tkap-thumb:hover{text-decoration:underline;}'
    ].join('');
    var el = document.createElement('style'); el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  var FILE_ICON = '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

  function closePreview() {
    var ovl = document.getElementById(OVL_ID);
    if (ovl && ovl.parentNode) ovl.parentNode.removeChild(ovl);
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') closePreview(); }

  function triggerDownload(name, dataUrl) {
    var a = document.createElement('a');
    a.href = dataUrl; a.download = name || 'download';
    a.setAttribute('data-tkap-download', '1');   // let onDocClick ignore its own click
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
  }

  function openPreview(name, dataUrl) {
    closePreview();
    ensureStyle();
    var mime = mimeOf(dataUrl);
    var bodyHtml;
    if (/^image\//.test(mime)) {
      bodyHtml = '<img class="tkap-img" src="' + esc(dataUrl) + '" alt="' + esc(name) + '">';
    } else if (mime === 'application/pdf') {
      bodyHtml = '<iframe class="tkap-frame" src="' + esc(dataUrl) + '" title="' + esc(name) + '"></iframe>';
    } else {
      bodyHtml = '<div class="tkap-generic">' + FILE_ICON +
        '<div class="tkap-fname">' + esc(name) + '</div>' +
        '<div class="tkap-fnote">Preview isn’t available for this file type — use Download to save it.</div></div>';
    }
    var ovl = document.createElement('div');
    ovl.id = OVL_ID; ovl.className = 'tkap-ovl';
    ovl.innerHTML =
      '<div class="tkap-modal">' +
        '<div class="tkap-head">' +
          '<div class="tkap-hinfo"><div class="tkap-title">' + esc(name) + '</div>' +
            '<div class="tkap-size">' + esc(fmtBytes(sizeOfDataUrl(dataUrl))) + '</div></div>' +
          '<div class="tkap-acts">' +
            '<button type="button" class="tkap-dl" id="tkap-dl">Download</button>' +
            '<button type="button" class="tkap-x" id="tkap-x">Close</button>' +
          '</div>' +
        '</div>' +
        '<div class="tkap-body">' + bodyHtml + '</div>' +
      '</div>';
    document.body.appendChild(ovl);
    ovl.addEventListener('click', function (e) { if (e.target === ovl) closePreview(); });
    document.addEventListener('keydown', onEsc);
    ovl.querySelector('#tkap-x').addEventListener('click', closePreview);
    ovl.querySelector('#tkap-dl').addEventListener('click', function () { triggerDownload(name, dataUrl); });
  }

  // The task "View" modal renders an attached image inline at full size —
  // exactly the "conjusted" clash the popup was meant to fix. React's <img>
  // is only ever hidden (style.display), never removed or replaced, so its
  // node identity survives and there's nothing for React's own re-render to
  // trip over; a plain button takes its place, opening the same popup as
  // the file attachment link does.
  function hideInlineImages() {
    if (!onPage()) return;
    var imgs = document.querySelectorAll('img[src^="data:"]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.closest('#' + OVL_ID)) continue;         // our own preview image
      if (img.dataset.tkapDone) continue;
      img.dataset.tkapDone = '1';
      img.style.display = 'none';
      var name = img.getAttribute('alt') || 'image';
      var src = img.getAttribute('src') || '';
      var thumb = document.createElement('button');
      thumb.type = 'button'; thumb.className = 'tkap-thumb';
      thumb.innerHTML = '🖼️ ' + esc(name);
      thumb.addEventListener('click', function (n, s) {
        return function () { openPreview(n, s); };
      }(name, src));
      img.parentNode.insertBefore(thumb, img.nextSibling);
    }
  }

  function onDocClick(e) {
    if (!onPage()) return;
    // Our own preview <img> (data: src) must never re-trigger itself.
    if (e.target.closest && e.target.closest('#' + OVL_ID)) return;

    var a = e.target.closest && e.target.closest('a[download]');
    if (a && !a.hasAttribute('data-tkap-download') && /^data:/.test(a.getAttribute('href') || '')) {
      e.preventDefault(); e.stopPropagation();
      openPreview(a.getAttribute('download') || 'attachment', a.getAttribute('href'));
      return;
    }
    var img = e.target.closest && e.target.closest('img');
    if (img && /^data:/.test(img.getAttribute('src') || '')) {
      e.preventDefault();
      openPreview(img.getAttribute('alt') || 'image', img.getAttribute('src'));
    }
  }

  function start() {
    document.addEventListener('click', onDocClick, true);
    ensureStyle();
    hideInlineImages();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      setTimeout(function () { scheduled = false; hideInlineImages(); }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
