/*
 * hrms-editor.js
 * ---------------------------------------------------------------------------
 * Shared editing widgets used by the no-rebuild injection scripts:
 *
 *   window.HRMSEditor.emoji(anchorEl, onPick)
 *       Emoji + symbol picker panel. Calls onPick(char) per selection and
 *       stays open so several can be inserted in a row.
 *
 *   window.HRMSEditor.insertAtCursor(textarea, text)
 *       Insert into a plain <textarea> at the caret (used by the LinkedIn
 *       post preview, which must stay plain text — LinkedIn renders no markup).
 *
 *   window.HRMSEditor.richText(opts) -> {root, getHTML, setHTML, focus}
 *       Toolbar + contenteditable surface for composing HTML email.
 *
 * Uses document.execCommand for the rich-text commands. It is formally
 * deprecated, but it is the only API supported across every browser for
 * contenteditable formatting, and this file enhances a pre-built bundle we
 * cannot recompile — a full editor dependency isn't an option here.
 */
(function () {
  'use strict';
  if (window.HRMSEditor) return;

  var STYLE_ID = 'hrms-ed-style';

  var EMOJI = {
    'Smileys': ('😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤨 😐 ' +
                '😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🥳 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓').split(' '),
    'Gestures': ('👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 💪 🦾 ✍️ 👏 🙌 👐 🤲 🫶').split(' '),
    'People': ('👨‍💻 👩‍💻 🧑‍💼 👔 🎓 🧑‍🏫 👨‍🔬 👩‍🔬 🧑‍🚀 🕵️ 👥 👤 🧠 💡 🎯 🚀 ⭐ 🌟 ✨ 🔥').split(' '),
    'Work': ('💼 📈 📉 📊 🗂️ 📋 📌 📍 🗓️ 📅 ⏰ 🕒 ⌛ 🏢 🏭 🖥️ 💻 ⌨️ 🖱️ 🖨️ 📱 ☎️ 📞 📠 🔧 ⚙️ 🛠️ 🔗 📎 ✂️').split(' '),
    'Comms': ('📧 📨 📩 ✉️ 📮 📢 📣 🔔 💬 💭 🗨️ 🗣️ 📝 ✏️ 🖊️ 📄 📑 📚 📖 🔍 🔎 ✅ ☑️ ✔️ ❌ ❗ ❓ ⚠️ 🚨 ℹ️').split(' '),
    'Symbols': ('◆ ◇ ● ○ ■ □ ▪ ▫ ★ ☆ ✦ ➤ ➔ → ⇒ • · — – | § ¶ © ® ™ ✓ ✗ ± ≈ ≠ ∞').split(' '),
    'Fun': ('🎉 🎊 🎁 🎂 🍰 ☕ 🍵 🥂 🍾 🏆 🥇 🎖️ 🏅 ⚽ 🏀 🎮 🎧 🎵 🌍 ✈️ 🚗 🏠 ❤️ 💙 💚 💛 🧡 💜 🖤 🤍').split(' ')
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.hrms-ed-pop{position:fixed;z-index:100010;width:330px;background:var(--bg2,#0f172a);',
      '  border:1px solid var(--border2,#1e293b);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.45);',
      '  color:var(--text,#e2e8f0);font-family:inherit;overflow:hidden}',
      '.hrms-ed-tabs{display:flex;gap:2px;padding:6px;border-bottom:1px solid var(--border2,#1e293b);overflow-x:auto}',
      '.hrms-ed-tabs button{flex:none;background:none;border:none;color:inherit;font:600 11px inherit;',
      '  padding:5px 8px;border-radius:6px;cursor:pointer;opacity:.65;white-space:nowrap}',
      '.hrms-ed-tabs button.on{background:var(--bg3,#0b1220);opacity:1}',
      '.hrms-ed-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px;max-height:220px;overflow-y:auto}',
      '.hrms-ed-grid button{background:none;border:none;font-size:19px;line-height:1;padding:5px 0;',
      '  border-radius:6px;cursor:pointer}',
      '.hrms-ed-grid button:hover{background:var(--bg3,#0b1220)}',
      '.hrms-ed-tb{display:flex;flex-wrap:wrap;align-items:center;gap:3px;padding:8px 10px;',
      '  border:1px solid var(--border2,#1e293b);border-bottom:none;border-radius:12px 12px 0 0;',
      '  background:var(--bg3,#0b1220)}',
      '.hrms-ed-tb button{background:none;border:none;color:var(--text2,var(--text,#e2e8f0));cursor:pointer;',
      '  min-width:32px;height:32px;border-radius:8px;font:600 13.5px inherit;line-height:1;',
      '  display:inline-flex;align-items:center;justify-content:center;transition:.13s}',
      '.hrms-ed-tb button:hover{background:var(--bg2,#0f172a);color:var(--accent,#4f8ef7)}',
      '.hrms-ed-tb button:active{transform:scale(.94)}',
      '.hrms-ed-tb select{background:var(--bg2,#0f172a);color:var(--text,#e2e8f0);',
      '  border:1px solid var(--border2,#1e293b);border-radius:8px;font:12.5px inherit;padding:0 8px;',
      '  height:32px;max-width:124px;cursor:pointer}',
      '.hrms-ed-tb select:hover{border-color:var(--accent,#4f8ef7)}',
      '.hrms-ed-tb input[type=color]{width:30px;height:30px;padding:0;border:1px solid var(--border2,#1e293b);',
      '  border-radius:8px;background:none;cursor:pointer}',
      '.hrms-ed-sep{width:1px;height:22px;background:var(--border2,#1e293b);margin:0 5px}',
      '.hrms-ed-area{border:1px solid var(--border2,#1e293b);border-radius:0 0 12px 12px;',
      '  background:var(--bg3,#0b1220);color:var(--text,#e2e8f0);padding:16px 18px;min-height:230px;',
      '  max-height:46vh;overflow-y:auto;font:14px/1.75 inherit;outline:none}',
      '.hrms-ed-area:focus{border-color:#0a66c2}',
      '.hrms-ed-src{width:100%;box-sizing:border-box;border:1px solid var(--border2,#1e293b);',
      '  border-top:none;border-radius:0 0 8px 8px;background:var(--bg3,#0b1220);color:var(--text,#e2e8f0);',
      '  padding:12px 14px;min-height:230px;font:12px/1.6 ui-monospace,Consolas,monospace;',
      '  outline:none;resize:vertical;white-space:pre}',
      '.hrms-ed-src:focus{border-color:#0a66c2}',
      '.hrms-ed-area a{color:#0a66c2}',
      '.hrms-ed-area ul,.hrms-ed-area ol{padding-left:22px;margin:6px 0}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ── emoji / symbol picker ───────────────────────────────────────────── */
  function emoji(anchor, onPick) {
    ensureStyle();
    var open = document.querySelector('.hrms-ed-pop');
    if (open) { open.remove(); if (open.__anchor === anchor) return null; }

    var pop = document.createElement('div');
    pop.className = 'hrms-ed-pop';
    pop.__anchor = anchor;
    var names = Object.keys(EMOJI);
    pop.innerHTML = '<div class="hrms-ed-tabs">' +
      names.map(function (n, i) { return '<button type="button" data-cat="' + n + '"' + (i ? '' : ' class="on"') + '>' + n + '</button>'; }).join('') +
      '</div><div class="hrms-ed-grid"></div>';
    document.body.appendChild(pop);

    var grid = pop.querySelector('.hrms-ed-grid');
    function fill(cat) {
      grid.innerHTML = '';
      EMOJI[cat].forEach(function (ch) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = ch; b.title = ch;
        // mousedown, not click: keeps the editor's selection from collapsing.
        b.addEventListener('mousedown', function (e) { e.preventDefault(); onPick(ch); });
        grid.appendChild(b);
      });
    }
    fill(names[0]);
    pop.querySelectorAll('.hrms-ed-tabs button').forEach(function (t) {
      t.addEventListener('mousedown', function (e) {
        e.preventDefault();
        pop.querySelectorAll('.hrms-ed-tabs button').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on'); fill(t.dataset.cat);
      });
    });

    // Position under the anchor, nudged back inside the viewport.
    var r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 300) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px';

    setTimeout(function () {
      document.addEventListener('mousedown', function close(e) {
        if (pop.contains(e.target) || anchor.contains(e.target)) return;
        pop.remove(); document.removeEventListener('mousedown', close);
      });
    }, 0);
    return pop;
  }

  /* ── plain-textarea insertion (LinkedIn stays plain text) ────────────── */
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var e = ta.selectionEnd == null ? s : ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    var pos = s + text.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ── rich text editor ────────────────────────────────────────────────── */
  var FONTS = ['Inter', 'Arial', 'Verdana', 'Georgia', 'Tahoma', 'Times New Roman', 'Courier New', 'Trebuchet MS'];
  var SIZES = [['1', '8'], ['2', '10'], ['3', '12'], ['4', '14'], ['5', '18'], ['6', '24'], ['7', '36']];

  var TB = {
    align_l: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h11M3 18h15"/></svg>',
    align_c: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M6 12h12M4 18h16"/></svg>',
    align_r: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M10 12h11M6 18h15"/></svg>',
    ul: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    ol: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4l2-3H4"/></svg>',
    indent: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 12h13M8 18h13M3 11l3 3-3 3"/></svg>',
    link: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    mail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    code: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
    undo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
    redo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>'
  };

  function btn(label, title, fn, style) {
    var b = document.createElement('button');
    b.type = 'button'; b.title = title; b.innerHTML = label;
    if (style) b.style.cssText = style;
    // mousedown+preventDefault keeps the caret/selection in the editable area.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); fn(); });
    return b;
  }

  function richText(opts) {
    ensureStyle();
    opts = opts || {};
    var root = document.createElement('div');
    var tb = document.createElement('div');
    tb.className = 'hrms-ed-tb';
    var area = document.createElement('div');
    area.className = 'hrms-ed-area';
    // setAttribute rather than the IDL property: the attribute is what actually
    // drives editability, and it reflects reliably everywhere.
    area.setAttribute('contenteditable', 'true');
    area.setAttribute('spellcheck', 'true');
    if (opts.minHeight) area.style.minHeight = opts.minHeight;
    area.innerHTML = opts.html || '';

    function cmd(name, val) {
      area.focus();
      try { document.execCommand(name, false, val === undefined ? null : val); } catch (e) {}
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function sep() { var d = document.createElement('span'); d.className = 'hrms-ed-sep'; return d; }

    tb.appendChild(btn('<b>B</b>', 'Bold (Ctrl+B)', function () { cmd('bold'); }));
    tb.appendChild(btn('<i>I</i>', 'Italic (Ctrl+I)', function () { cmd('italic'); }));
    tb.appendChild(btn('<u>U</u>', 'Underline (Ctrl+U)', function () { cmd('underline'); }));
    tb.appendChild(btn('<s>S</s>', 'Strikethrough', function () { cmd('strikeThrough'); }));
    tb.appendChild(sep());

    var fsel = document.createElement('select');
    fsel.title = 'Font';
    fsel.innerHTML = '<option value="">Font</option>' + FONTS.map(function (f) { return '<option value="' + f + '">' + f + '</option>'; }).join('');
    fsel.addEventListener('change', function () { if (fsel.value) cmd('fontName', fsel.value); });
    tb.appendChild(fsel);

    var ssel = document.createElement('select');
    ssel.title = 'Font size';
    ssel.innerHTML = '<option value="">Size</option>' + SIZES.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('');
    ssel.addEventListener('change', function () { if (ssel.value) cmd('fontSize', ssel.value); });
    tb.appendChild(ssel);
    tb.appendChild(sep());

    var fc = document.createElement('input');
    fc.type = 'color'; fc.title = 'Text colour'; fc.value = '#334155';
    fc.addEventListener('input', function () { cmd('foreColor', fc.value); });
    tb.appendChild(fc);
    var bc = document.createElement('input');
    bc.type = 'color'; bc.title = 'Highlight colour'; bc.value = '#fde68a';
    bc.addEventListener('input', function () { cmd('hiliteColor', bc.value); });
    tb.appendChild(bc);
    tb.appendChild(sep());

    tb.appendChild(btn(TB.align_l, 'Align left', function () { cmd('justifyLeft'); }));
    tb.appendChild(btn(TB.align_c, 'Align centre', function () { cmd('justifyCenter'); }));
    tb.appendChild(btn(TB.align_r, 'Align right', function () { cmd('justifyRight'); }));
    tb.appendChild(sep());
    tb.appendChild(btn(TB.ul, 'Bullet list', function () { cmd('insertUnorderedList'); }));
    tb.appendChild(btn(TB.ol, 'Numbered list', function () { cmd('insertOrderedList'); }));
    tb.appendChild(btn(TB.indent, 'Indent', function () { cmd('indent'); }));
    tb.appendChild(sep());

    tb.appendChild(btn(TB.link, 'Insert link', function () {
      var url = window.prompt('Link URL', 'https://');
      if (url) cmd('createLink', url);
    }));
    var emojiBtn = btn('😊', 'Emoji', function () { emoji(emojiBtn, function (ch) { cmd('insertText', ch); }); });
    tb.appendChild(emojiBtn);
    tb.appendChild(btn(TB.mail, 'Insert an email address as a mailto: link', function () {
      var addr = window.prompt('Email address', '');
      if (addr) cmd('insertHTML', '<a href="mailto:' + addr.trim() + '">' + addr.trim() + '</a>');
    }));

    // ── HTML source mode ─────────────────────────────────────────────────
    // Lets a full HTML email be pasted or hand-written. Editing the source and
    // toggling back re-parses it into the visual editor.
    var src = document.createElement('textarea');
    src.className = 'hrms-ed-src';
    src.spellcheck = false;
    src.style.display = 'none';
    var htmlMode = false;
    var srcBtn = btn(TB.code, 'Edit HTML source', function () { setMode(!htmlMode); });

    function setMode(on) {
      on = !!on;
      // No-op when already in that mode. Without this, switching "to" visual
      // mode while the source box is still empty would copy '' over the body.
      if (on === htmlMode) return;
      htmlMode = on;
      if (on) {
        src.value = formatHtml(area.innerHTML);
        src.style.display = '';
        area.style.display = 'none';
        srcBtn.style.background = 'var(--bg2,#0f172a)';
        srcBtn.title = 'Back to visual editing';
      } else {
        // A complete document cannot survive innerHTML on a <div> — the
        // doctype/html/body tags are stripped. Refuse rather than mangle it.
        if (isFullDocument(src.value)) {
          htmlMode = true;
          window.alert('This is a complete HTML document, so it can only be edited as source — ' +
                       'switching to the visual editor would strip its <html> and <body> tags.');
          return;
        }
        area.innerHTML = src.value;
        src.style.display = 'none';
        area.style.display = '';
        srcBtn.style.background = '';
        srcBtn.title = 'Edit HTML source';
      }
      // Formatting commands are meaningless while editing raw source.
      Array.prototype.forEach.call(tb.children, function (c) {
        if (c !== srcBtn) c.style.opacity = on ? '.35' : '';
        if (c !== srcBtn && 'disabled' in c) c.disabled = on;
      });
    }
    tb.appendChild(srcBtn);
    tb.appendChild(sep());
    tb.appendChild(btn(TB.undo, 'Undo (Ctrl+Z)', function () { cmd('undo'); }));
    tb.appendChild(btn(TB.redo, 'Redo (Ctrl+Y)', function () { cmd('redo'); }));

    root.appendChild(tb);
    root.appendChild(area);
    root.appendChild(src);
    return {
      root: root,
      area: area,
      // Always read from whichever surface the user last edited.
      getHTML: function () { return htmlMode ? src.value : area.innerHTML; },
      getText: function () { return area.innerText || area.textContent || ''; },
      setHTML: function (h) {
        area.innerHTML = h || '';
        if (htmlMode) src.value = formatHtml(area.innerHTML);
      },
      // Load raw markup straight into the source box, bypassing the visual
      // editor. The only safe way to load a complete HTML document.
      setSource: function (h) {
        setMode(true);
        src.value = h || '';
      },
      isFullDocument: function () { return isFullDocument(htmlMode ? src.value : area.innerHTML); },
      isHtmlMode: function () { return htmlMode; },
      setHtmlMode: setMode,
      focus: function () { (htmlMode ? src : area).focus(); }
    };
  }

  function isFullDocument(html) {
    var head = String(html || '').trimLeft().slice(0, 200).toLowerCase();
    return head.indexOf('<!doctype') === 0 || head.indexOf('<html') === 0;
  }

  // Put block-level tags on their own lines so hand-editing source is bearable.
  function formatHtml(html) {
    return String(html || '')
      .replace(/></g, '>\n<')
      .replace(/\n(<\/(b|i|u|s|em|strong|span|a)>)/gi, '$1');
  }

  window.HRMSEditor = {
    emoji: emoji,
    insertAtCursor: insertAtCursor,
    richText: richText,
    EMOJI: EMOJI
  };
})();
