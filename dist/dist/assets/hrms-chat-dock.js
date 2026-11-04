/* Chat shortcut bar + "Chat Mini" — Cliq-style, pinned to the HRMS sidebar.
 *
 *   My Pins | Chats | Channels | Threads | People      (bar at the bottom)
 *
 * Clicking a shortcut opens a small chat panel above the bar on that section,
 * without leaving the current page: search (Ctrl+Space), Recent / Unread,
 * conversations with presence dots, unread counts and previews, a row menu
 * (open in full chat / mark as read), a + button for a new chat or channel,
 * and a compact conversation view with a composer. The expand button opens
 * the full chat page (/employees/chat?tab=… or ?room=…, read by hrms-chat.js).
 *
 * Not shown on the chat page itself (it has the same bar in its own sidebar),
 * when signed out, without chat access, or with the sidebar collapsed.
 *
 * The React sidebar scrolls as a whole, so bar and panel are fixed overlays
 * aligned to the sidebar's box (never children of it — React owns that tree);
 * the sidebar gets bottom padding so its last items can scroll clear of the bar.
 * Uses the chat API only (/api/chat/*); identity headers come from hrms-actor.js.
 */
(function () {
  'use strict';
  if (window.__hrmsChatDock) return;
  window.__hrmsChatDock = true;

  var ID = 'hrms-chat-dock';
  var MINI = 'hrms-chat-mini';
  var CHAT_PATH = '/employees/chat';
  var ICO = {
    pins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 4H6l4-4-1-6z"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    direct: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H8l-4 4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="12" x2="13" y2="12"/></svg>',
    channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><line x1="10" y1="7" x2="9" y2="17"/><line x1="15" y1="7" x2="14" y2="17"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/></svg>',
    threads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v11h-9l-4 4v-4H4z"/><line x1="8" y1="8.5" x2="16" y2="8.5"/><line x1="8" y1="11.5" x2="16" y2="11.5"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 4.9"/></svg>',
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/><circle cx="9" cy="10.5" r=".8" fill="currentColor"/><circle cx="12" cy="10.5" r=".8" fill="currentColor"/><circle cx="15" cy="10.5" r=".8" fill="currentColor"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16" y2="16"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="10" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="14" y2="20"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg>'
  };
  var TABS = [['pins', 'My Pins'], ['direct', 'Chats'], ['channels', 'Channels'], ['threads', 'Threads'], ['people', 'People']];

  var unread = { direct: 0, channels: 0 };
  var fetched = false;
  var RAIL_BAR_W = 260;   // bar width when the sidebar is collapsed / hidden
  var FREE_BAR_W = 300;   // bar width once it has been dragged somewhere
  var LAUNCH_ID = 'hrms-chat-launch';

  /* Where the user put the bar, per user: { free, left, bottom, closed }.
     free = dragged off its spot under the sidebar; closed = folded into the
     chat bubble. */
  function prefKey() { return 'hrms_chat_dock_pos_v1_' + me(); }
  function loadPref() {
    try { var p = JSON.parse(localStorage.getItem(prefKey()) || 'null'); return p && typeof p === 'object' ? p : {}; }
    catch (_) { return {}; }
  }
  function savePref(p) { try { localStorage.setItem(prefKey(), JSON.stringify(p)); } catch (_) {} }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  var mini = {
    open: false, tab: 'direct', filter: 'recent', q: '',
    rooms: null, contacts: null, contactsAt: 0, threads: null, pins: null,
    room: null, messages: [], roomPoll: null, listPoll: null, menuFor: null, plusOpen: false, sending: false
  };

  // ── helpers ────────────────────────────────────────────────────────────
  function session() {
    try { return JSON.parse(localStorage.getItem('hrms_session') || 'null'); } catch (_) { return null; }
  }
  function me() { var s = session(); return s && s.email ? String(s.email).trim().toLowerCase() : ''; }
  function onChatPage() { return (location.pathname || '').replace(/\/+$/, '') === CHAT_PATH; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function getJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) { var e = new Error((d && d.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function postJSON(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify(body || {}) }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.message) || ('HTTP ' + r.status));
        return d;
      });
    });
  }
  function parseDt(s) {
    if (!s) return null;
    var d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }
  function shortTime(s) {
    var d = parseDt(s);
    if (!d) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function initials(name) {
    var p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function presence(email) {
    var P = window.__hrmsPresence;
    if (P && email) {
      try { var g = P.get(email); if (g) return { color: g.color, label: g.label }; } catch (_) {}
    }
    var c = (mini.contacts || []).filter(function (x) { return x.email === email; })[0];
    return c && c.online ? { color: '#22c55e', label: 'Online' } : { color: '#9ca3af', label: 'Offline' };
  }
  /* Status changed (mine or anyone's): repaint dots and the header line. */
  function repaintPresence() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pd-email]'), function (el) {
      var pr = presence(el.getAttribute('data-pd-email'));
      if (el.style.background !== pr.color) el.style.background = pr.color;
      if (el.title !== pr.label) el.title = pr.label;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dock-status]'), function (el) {
      var pr = presence(el.getAttribute('data-dock-status'));
      if (el.textContent !== pr.label) el.textContent = pr.label;
      el.style.color = pr.color;
    });
  }
  window.addEventListener('hrmsPresenceUpdated', repaintPresence);

  function avatar(name, email, pic, isChannel, withDot) {
    var inner = isChannel ? ICO.hash : (pic ? '<img src="' + esc(pic) + '" alt="">' : esc(initials(name)));
    var dot = '';
    if (withDot && email) {
      var pr = presence(email);
      dot = '<span class="pd" data-pd-email="' + esc(email) + '" style="background:' + esc(pr.color) + '" title="' + esc(pr.label) + '"></span>';
    }
    return '<span class="av' + (isChannel ? ' ch' : '') + '">' + inner + dot + '</span>';
  }

  // ── styles ─────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(ID + '-style')) return;
    var D = '#' + ID, M = '#' + MINI;
    var st = document.createElement('style');
    st.id = ID + '-style';
    st.textContent =
      D + '{position:fixed;display:flex;gap:0;padding:4px 2px 6px;box-sizing:border-box;' +
      'background:var(--bg2,var(--surface,#fff));border-top:1px solid var(--border2,#e5e7eb);box-shadow:0 -4px 14px rgba(0,0,0,.06);}' +
      D + ' button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0 4px;' +
      'border:none;border-radius:8px;background:transparent;color:var(--text3,#64748b);font-size:10px;font-weight:500;font-family:inherit;letter-spacing:-.1px;cursor:pointer;}' +
      D + ' button:hover{background:var(--bg3,#f1f5f9);color:var(--text,#0f172a);}' +
      D + ' button.on{background:rgba(79,142,247,.16);color:var(--accent,#2f6fe0);font-weight:600;}' +
      D + ' button:focus-visible{outline:2px solid var(--accent,#2f6fe0);outline-offset:-2px;}' +
      D + ' svg{width:19px;height:19px;}' +
      D + ' .ic{position:relative;display:inline-flex;}' +
      D + ' .dot{position:absolute;top:-4px;right:-7px;min-width:9px;height:9px;padding:0 3px;border-radius:99px;background:#ef4444;' +
      'border:2px solid var(--bg2,var(--surface,#fff));box-sizing:content-box;color:#fff;font-size:9px;line-height:9px;font-weight:700;text-align:center;}' +
      D + ' .lb{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}' +
      'body.hrms-chat-dock-on .sidebar{padding-bottom:64px!important;}' +
      // collapsed sidebar / no sidebar: the same horizontal row, wider than the
      // rail, with a rounded top edge where it sticks out over the page
      D + '.rail,' + D + '.float{border:1px solid var(--border2,#e5e7eb);border-bottom:none;border-left:none;border-radius:0 12px 0 0;}' +
      'body.hrms-chat-dock-rail .sidebar{padding-bottom:64px!important;}' +
      // grip (drag) + close at the bar's two ends
      // corner controls: they take no width from the five tabs
      D + ' .gr,' + D + ' .cx{position:absolute;top:2px;flex:none;width:18px;height:18px;min-width:0;padding:0;gap:0;border-radius:5px;justify-content:center;color:var(--text3,#64748b);opacity:.45;background:transparent;z-index:1;}' +
      D + ' .gr{left:2px;}' + D + ' .cx{right:2px;}' +
      D + ' .gr{cursor:grab;touch-action:none;}' + D + ' .gr:active{cursor:grabbing;}' +
      D + ' .gr:hover,' + D + ' .cx:hover{opacity:1;background:var(--bg3,#f1f5f9);}' +
      D + ' .gr svg,' + D + ' .cx svg{width:13px;height:13px;}' +
      D + ':hover .gr,' + D + ':hover .cx{opacity:.9;}' +
      D + '.dragging{opacity:.92;box-shadow:0 10px 32px rgba(0,0,0,.28)!important;transition:none;}' +
      D + '.free{border:1px solid var(--border2,#e5e7eb)!important;border-radius:14px!important;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:4px 2px;}' +
      '#' + LAUNCH_ID + '{position:fixed;width:46px;height:46px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#7c5cfc));color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);}' +
      '#' + LAUNCH_ID + ':hover{transform:scale(1.06);}' + '#' + LAUNCH_ID + ' svg{width:22px;height:22px;}' +
      '#' + LAUNCH_ID + ' .dot{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;' +
      'background:#ef4444;color:#fff;font-size:10.5px;font-weight:700;line-height:18px;text-align:center;border:2px solid var(--bg2,#fff);}' +
      '@media(max-width:768px){body.hrms-has-tabbar #' + LAUNCH_ID + '{display:none!important;}}' +
      // mini panel
      M + '{position:fixed;width:350px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;box-sizing:border-box;' +
      'background:var(--bg2,var(--surface,#fff));color:var(--text,#0f172a);border:1px solid var(--border2,#e5e7eb);border-bottom:none;' +
      'border-radius:12px 12px 0 0;box-shadow:0 -6px 28px rgba(0,0,0,.22);overflow:hidden;font-family:inherit;}' +
      M + ' button{font-family:inherit;}' +
      M + ' svg{width:16px;height:16px;}' +
      M + ' .hd{display:flex;align-items:center;gap:10px;padding:12px 12px 10px;border-bottom:1px solid var(--border2,#e5e7eb);}' +
      M + ' .lg{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
      'background:linear-gradient(135deg,var(--accent,#4f8ef7),var(--accent2,#7c5cfc));color:#fff;}' +
      M + ' .lg svg{width:19px;height:19px;}' +
      M + ' .tt{flex:1;min-width:0;}' + M + ' .tt b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      M + ' .tt small{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text3,#64748b);}' +
      M + ' .tt small i{width:8px;height:8px;border-radius:50%;display:inline-block;}' +
      M + ' .ib{width:30px;height:30px;border-radius:8px;border:1px solid var(--border2,#e5e7eb);background:transparent;color:var(--text3,#64748b);' +
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}' +
      M + ' .ib:hover{color:var(--text,#0f172a);background:var(--bg3,#f1f5f9);}' +
      M + ' .sr{display:flex;gap:6px;padding:10px 12px 6px;}' +
      M + ' .sb{flex:1;display:flex;align-items:center;gap:7px;border:1px solid var(--border2,#e5e7eb);border-radius:8px;padding:0 9px;background:var(--bg3,#f8fafc);}' +
      M + ' .sb:focus-within{border-color:var(--accent,#2f6fe0);box-shadow:0 0 0 2px rgba(79,142,247,.18);}' +
      M + ' .sb input{flex:1;border:none;outline:none;background:transparent;color:inherit;font:13px inherit;font-family:inherit;padding:8px 0;min-width:0;}' +
      M + ' .seg{display:flex;gap:6px;padding:4px 12px 8px;}' +
      M + ' .seg button{flex:1;border:none;border-radius:7px;padding:7px;font-size:13px;cursor:pointer;background:var(--bg3,#f1f5f9);color:var(--text,#0f172a);}' +
      M + ' .seg button.on{background:rgba(79,142,247,.16);color:var(--accent,#2f6fe0);font-weight:600;}' +
      M + ' .ls{flex:1;overflow-y:auto;padding:2px 6px 64px;position:relative;}' +
      M + ' .rw{display:flex;align-items:center;gap:10px;padding:8px;border-radius:9px;cursor:pointer;position:relative;}' +
      M + ' .rw:hover{background:var(--bg3,#f1f5f9);}' +
      M + ' .rw .mid{flex:1;min-width:0;}' +
      M + ' .rw .nm{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      M + ' .rw.un .nm{font-weight:800;}' +
      M + ' .rw .pv{font-size:12.5px;color:var(--text3,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      M + ' .rw.un .pv{color:var(--text,#0f172a);}' +
      M + ' .rw .rt{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;}' +
      M + ' .rw .tm{font-size:10.5px;color:var(--text3,#64748b);}' +
      M + ' .rw .bd{min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--accent,#2f6fe0);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;}' +
      M + ' .rw .mn{display:none;border:none;background:transparent;color:var(--text3,#64748b);cursor:pointer;padding:2px;border-radius:5px;}' +
      M + ' .rw:hover .mn,' + M + ' .rw .mn.on{display:inline-flex;}' +
      M + ' .av{position:relative;width:36px;height:36px;border-radius:50%;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(135deg,#94a3b8,#64748b);color:#fff;font-size:12.5px;font-weight:700;}' +
      M + ' .av img{width:100%;height:100%;border-radius:50%;object-fit:cover;}' +
      M + ' .av.ch{border-radius:10px;background:var(--bg3,#eef2f7);color:var(--text3,#64748b);}' +
      M + ' .av .pd{position:absolute;right:-1px;bottom:-1px;width:10px;height:10px;border-radius:50%;border:2px solid var(--bg2,#fff);}' +
      M + ' .pop{position:absolute;z-index:5;background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;min-width:170px;}' +
      M + ' .pop button{display:block;width:100%;text-align:left;border:none;background:transparent;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:inherit;}' +
      M + ' .pop button:hover{background:var(--bg3,#f1f5f9);}' +
      M + ' .fab{position:absolute;right:16px;bottom:14px;width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;' +
      'background:var(--accent,#2f6fe0);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(47,111,224,.45);z-index:4;}' +
      M + ' .fab svg{width:20px;height:20px;}' +
      M + ' .em{padding:30px 16px;text-align:center;color:var(--text3,#64748b);font-size:13px;}' +
      M + ' .wrap{flex:1;display:flex;flex-direction:column;min-height:0;position:relative;}' +
      // conversation view
      M + ' .ms{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--bg,transparent);}' +
      M + ' .sep{align-self:center;font-size:10.5px;color:var(--text3,#64748b);background:var(--bg3,#f1f5f9);border-radius:99px;padding:2px 10px;margin:6px 0;}' +
      M + ' .bb{max-width:82%;padding:7px 10px;border-radius:12px;font-size:13px;line-height:1.45;word-break:break-word;background:var(--bg3,#f1f5f9);align-self:flex-start;}' +
      M + ' .bb.me{align-self:flex-end;background:var(--accent,#2f6fe0);color:#fff;}' +
      M + ' .bb .sn{font-size:11px;font-weight:700;color:var(--accent,#2f6fe0);margin-bottom:1px;}' +
      M + ' .bb .tm2{font-size:10px;opacity:.7;text-align:right;margin-top:2px;}' +
      M + ' .bb .q{border-left:3px solid currentColor;opacity:.8;padding-left:7px;margin-bottom:4px;font-size:12px;}' +
      M + ' .bb .rx{display:inline-block;margin:3px 4px 0 0;padding:0 6px;border-radius:99px;background:rgba(0,0,0,.08);font-size:11.5px;}' +
      M + ' .bb a{color:inherit;text-decoration:underline;}' +
      M + ' .bb.del{font-style:italic;opacity:.7;}' +
      M + ' .cp{display:flex;align-items:flex-end;gap:8px;padding:8px 10px 10px;border-top:1px solid var(--border2,#e5e7eb);}' +
      M + ' .cp textarea{flex:1;resize:none;border:1px solid var(--border2,#e5e7eb);border-radius:9px;padding:8px 10px;font:13px inherit;font-family:inherit;' +
      'background:var(--bg3,#f8fafc);color:inherit;max-height:110px;min-height:36px;outline:none;}' +
      M + ' .cp textarea:focus{border-color:var(--accent,#2f6fe0);}' +
      M + ' .cp .snd{width:36px;height:36px;border-radius:9px;border:none;background:var(--accent,#2f6fe0);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;}' +
      M + ' .cp .snd:disabled{opacity:.5;cursor:default;}' +
      M + ' .err{color:#ef4444;font-size:11.5px;padding:0 12px 6px;}';
    document.head.appendChild(st);
  }

  // ── bar ────────────────────────────────────────────────────────────────
  function buildBar() {
    var bar = document.createElement('nav');
    bar.id = ID;
    bar.setAttribute('aria-label', 'Chat shortcuts');
    bar.innerHTML =
      '<button type="button" class="gr" data-a="grip" title="Drag to move · double-click to put it back · arrow keys move it" aria-label="Move chat bar">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg></button>' +
      TABS.map(function (t) {
      return '<button type="button" data-tab="' + t[0] + '" title="' + t[1] + '" aria-label="' + t[1] + '">' +
        '<span class="ic">' + ICO[t[0]] + (t[0] === 'direct' || t[0] === 'channels' ? '<span class="dot" style="display:none"></span>' : '') +
        '</span><span class="lb">' + t[1] + '</span></button>';
    }).join('') +
      '<button type="button" class="cx" data-a="hide" title="Hide the chat bar (the chat bubble brings it back)" aria-label="Hide chat bar">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    wireDrag(bar);
    bar.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-a="hide"]')) { hideBar(); return; }
      var b = e.target.closest && e.target.closest('button[data-tab]');
      if (!b) return;
      var tab = b.getAttribute('data-tab');
      if (mini.open && mini.tab === tab && !mini.room) { closeMini(); return; }
      openMini(tab);
    });
    document.body.appendChild(bar);
    return bar;
  }

  function wireDrag(bar) {
    var grip = bar.querySelector('[data-a="grip"]');
    var drag = null;
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      var r = bar.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      bar.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var w = FREE_BAR_W, h = bar.offsetHeight || 56;
      var left = clamp(e.clientX - drag.dx, 0, Math.max(0, window.innerWidth - Math.min(w, window.innerWidth)));
      var top = clamp(e.clientY - drag.dy, 0, Math.max(0, window.innerHeight - h));
      var p = loadPref();
      p.free = true; p.left = Math.round(left); p.bottom = Math.round(window.innerHeight - top - h);
      savePref(p);
      place();
    });
    function end() {
      if (!drag) return;
      drag = null;
      bar.classList.remove('dragging');
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', function () { resetBar(); });
    grip.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 40 : 10, dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = step; else if (e.key === 'ArrowDown') dy = -step;
      else if (e.key === 'Home') { e.preventDefault(); resetBar(); return; }
      else return;
      e.preventDefault();
      var r = bar.getBoundingClientRect(), p = loadPref();
      p.free = true;
      p.left = Math.round((p.free && p.left != null ? p.left : r.left) + dx);
      p.bottom = Math.round((p.bottom != null ? p.bottom : window.innerHeight - r.bottom) + dy);
      savePref(p);
      place();
    });
  }

  function resetBar() {
    var p = loadPref();
    p.free = false; delete p.left; delete p.bottom;
    savePref(p);
    place();
  }
  function hideBar() {
    var p = loadPref();
    p.closed = true;
    savePref(p);
    if (mini.open) closeMini();
    place();
  }
  function showBar() {
    var p = loadPref();
    p.closed = false;
    savePref(p);
    place();
  }

  function ensureLauncher() {
    var l = document.getElementById(LAUNCH_ID);
    if (l) return l;
    l = document.createElement('button');
    l.id = LAUNCH_ID;
    l.type = 'button';
    l.title = 'Show the chat bar';
    l.setAttribute('aria-label', 'Show the chat bar');
    l.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg><span class="dot" style="display:none"></span>';
    l.addEventListener('click', showBar);
    document.body.appendChild(l);
    return l;
  }
  function hideLauncher() {
    var l = document.getElementById(LAUNCH_ID);
    if (l && l.style.display !== 'none') l.style.display = 'none';
  }

  function paintBar(bar) {
    ['direct', 'channels'].forEach(function (k) {
      var b = bar.querySelector('[data-tab="' + k + '"]');
      if (!b) return;
      var dot = b.querySelector('.dot'), n = unread[k] || 0;
      var disp = n ? '' : 'none';
      if (dot.style.display !== disp) dot.style.display = disp;
      var txt = n > 9 ? '9+' : (n ? String(n) : '');
      if (dot.textContent !== txt) dot.textContent = txt;
      var title = (k === 'direct' ? 'Chats' : 'Channels') + (n ? ' — ' + n + ' unread' : '');
      if (b.title !== title) b.title = title;
    });
    TABS.forEach(function (t) {
      var b = bar.querySelector('[data-tab="' + t[0] + '"]');
      var on = mini.open && mini.tab === t[0];
      if (b && b.classList.contains('on') !== on) b.classList.toggle('on', on);
    });
  }

  /* Where the bar goes. It never disappears just because the sidebar is
     collapsed:
       wide  — sidebar expanded: horizontal bar under it (same width)
       rail  — sidebar collapsed to its icon rail: the same horizontal row,
               RAIL_BAR_W wide, extending past the rail at the bottom-left
       float — no sidebar on screen (small screens): compact bar bottom-left
     null only when chat isn't available here (signed out, no chat access,
     or on the chat page, which has its own bar). */
  function visibleSidebar() {
    var link = document.querySelector('a.nav-item[href="' + CHAT_PATH + '"]');
    var s = session();
    if (!(s && s.email && link) || onChatPage()) return null;
    var side = document.querySelector('.sidebar');
    var r = side && side.getBoundingClientRect();
    var cs = side && getComputedStyle(side);
    var z = cs ? parseInt(cs.zIndex, 10) : NaN;
    var shown = side && r && r.width >= 40 && r.right > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    if (!shown) {
      var w = Math.min(300, window.innerWidth);
      return { mode: 'float', z: isNaN(z) ? 100 : z,
               r: { left: 0, width: w, right: w, bottom: window.innerHeight } };
    }
    return { mode: r.width >= 180 ? 'wide' : 'rail', el: side, r: r, z: z };
  }

  function setStyles(el, want) {
    Object.keys(want).forEach(function (k) { if (el.style[k] !== want[k]) el.style[k] = want[k]; });
  }

  function place() {
    var bar = document.getElementById(ID);
    var sb = visibleSidebar();
    var show = !!sb;
    var pref = sb ? loadPref() : {};
    var mode = sb ? (pref.closed ? 'closed' : (pref.free ? 'free' : sb.mode)) : '';
    if (!show) hideLauncher();
    // Only write what changed: this runs from a MutationObserver.
    [['hrms-chat-dock-on', mode === 'wide'], ['hrms-chat-dock-rail', mode === 'rail']].forEach(function (c) {
      if (document.body.classList.contains(c[0]) !== c[1]) document.body.classList.toggle(c[0], c[1]);
    });
    if (!show) {
      if (bar && bar.style.display !== 'none') bar.style.display = 'none';
      if (mini.open) closeMini();
      return;
    }
    ensureStyle();
    if (!bar) bar = buildBar();
    if (!fetched) { fetched = true; refreshUnread(); }
    if (mode === 'closed') {
      // Folded into the chat bubble, where the bar was (or bottom-left).
      if (bar.style.display !== 'none') bar.style.display = 'none';
      if (mini.open) closeMini();
      var l = ensureLauncher(), n = (unread.direct || 0) + (unread.channels || 0);
      var lx = pref.free && pref.left != null ? pref.left : Math.round(sb.r.left) + 12;
      var lb = pref.free && pref.bottom != null ? pref.bottom : 12;
      setStyles(l, { display: 'flex', zIndex: String(Math.max((isNaN(sb.z) ? 100 : sb.z) + 1, 900)),
                     left: clamp(lx, 4, window.innerWidth - 50) + 'px', bottom: clamp(lb, 4, window.innerHeight - 50) + 'px' });
      var dot = l.querySelector('.dot'), txt = n > 99 ? '99+' : String(n);
      dot.style.display = n ? '' : 'none';
      if (dot.textContent !== txt) dot.textContent = txt;
      l.title = 'Show the chat bar' + (n ? ' — ' + n + ' unread' : '');
      return;
    }
    hideLauncher();
    if (mode === 'free') {
      // Wherever the user dragged it, kept on screen when the window changes.
      var fw = Math.min(FREE_BAR_W, window.innerWidth), fh = bar.offsetHeight || 56;
      var fl = clamp(pref.left || 0, 0, Math.max(0, window.innerWidth - fw));
      var fb = clamp(pref.bottom || 0, 0, Math.max(0, window.innerHeight - fh));
      ['wide', 'rail', 'float'].forEach(function (m) { if (bar.classList.contains(m)) bar.classList.remove(m); });
      if (!bar.classList.contains('free')) bar.classList.add('free');
      var fz = String(Math.max((isNaN(sb.z) ? 100 : sb.z) + 1, 900));
      setStyles(bar, { zIndex: fz, display: 'flex', left: fl + 'px', width: fw + 'px', bottom: fb + 'px' });
      paintBar(bar);
      var fp = document.getElementById(MINI);
      if (fp && mini.open) {
        var top = window.innerHeight - fb - fh;
        var pw = Math.min(350, window.innerWidth - 16), pl = clamp(fl, 8, Math.max(8, window.innerWidth - pw - 8));
        if (top - 12 >= 320) {          // room above the bar: open upwards
          setStyles(fp, { zIndex: fz, left: pl + 'px', top: 'auto', bottom: (fb + fh) + 'px',
                          height: Math.min(680, top - 12) + 'px', borderRadius: '12px 12px 0 0' });
        } else {                        // bar near the top: open downwards
          setStyles(fp, { zIndex: fz, left: pl + 'px', bottom: 'auto', top: (top + fh) + 'px',
                          height: Math.max(260, Math.min(680, window.innerHeight - top - fh - 12)) + 'px', borderRadius: '0 0 12px 12px' });
        }
      }
      return;
    }
    if (bar.classList.contains('free')) bar.classList.remove('free');
    ['wide', 'rail', 'float'].forEach(function (m) {
      if (bar.classList.contains(m) !== (m === mode)) bar.classList.toggle(m, m === mode);
    });
    var z = String((isNaN(sb.z) ? 100 : sb.z) + 1);
    var bottom = Math.max(0, Math.round(window.innerHeight - Math.min(sb.r.bottom, window.innerHeight)));
    // Always a horizontal row. On the collapsed (narrow) rail it keeps a
    // readable width and simply extends past the rail, like Cliq's bar.
    var width = mode === 'wide' ? Math.round(sb.r.width) : Math.min(Math.max(Math.round(sb.r.width), RAIL_BAR_W), window.innerWidth);
    setStyles(bar, { zIndex: z, display: 'flex', left: Math.round(sb.r.left) + 'px', width: width + 'px', bottom: bottom + 'px' });
    paintBar(bar);
    var panel = document.getElementById(MINI);
    if (panel && mini.open) {
      var barH = bar.offsetHeight || 56;
      var pb = bottom + barH;
      var h = Math.max(320, Math.min(680, window.innerHeight - pb - 12));
      setStyles(panel, { zIndex: z, left: Math.round(sb.r.left) + 'px', top: 'auto', bottom: pb + 'px', height: h + 'px', borderRadius: '12px 12px 0 0' });
    }
  }

  // ── unread (bar dots) ──────────────────────────────────────────────────
  function refreshUnread() {
    var s = session();
    if (!s || !s.email || !document.querySelector('a.nav-item[href="' + CHAT_PATH + '"]')) return;
    getJSON('/api/chat/unread').then(function (d) {
      if (!d) return;
      unread.direct = d.direct || 0;
      unread.channels = d.channels || 0;
      if (window.__hrmsAlerts && typeof d.total === 'number') window.__hrmsAlerts.chatUnread(d.total, 'dock');
      place();
    }).catch(function () {});
  }

  // ── mini panel ─────────────────────────────────────────────────────────
  function openMini(tab) {
    var pr = loadPref();
    if (pr.closed) { pr.closed = false; savePref(pr); }
    mini.open = true;
    mini.tab = tab || mini.tab || 'direct';
    mini.room = null;
    mini.menuFor = null;
    mini.plusOpen = false;
    stopRoomPoll();
    var panel = document.getElementById(MINI);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = MINI;
      panel.setAttribute('aria-label', 'Chat');
      panel.addEventListener('click', onPanelClick);
      panel.addEventListener('input', onPanelInput);
      panel.addEventListener('keydown', onPanelKey);
      document.body.appendChild(panel);
    }
    renderShell();
    place();
    loadForTab();
    if (!mini.listPoll) mini.listPoll = setInterval(function () { if (mini.open && !mini.room) loadForTab(true); }, 10000);
    var inp = panel.querySelector('[data-m="q"]');
    if (inp) inp.focus();
  }

  function closeMini() {
    mini.open = false;
    mini.room = null;
    stopRoomPoll();
    if (mini.listPoll) { clearInterval(mini.listPoll); mini.listPoll = null; }
    var panel = document.getElementById(MINI);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);   // ours, safe to remove
    var bar = document.getElementById(ID);
    if (bar) paintBar(bar);
  }

  function openFull(query) {
    closeMini();
    history.pushState({}, '', CHAT_PATH + (query ? '?' + query : ''));
    window.dispatchEvent(new PopStateEvent('popstate'));   // React Router knows /employees/chat
  }

  function myStatus() {
    var P = window.__hrmsPresence, e = me();
    var lab = '', col = '#9ca3af';
    try { if (P && e) { lab = P.label(e); col = P.color(e); } } catch (_) {}
    return { label: lab || 'Available', color: col || '#22c55e' };
  }

  function renderShell() {
    var panel = document.getElementById(MINI);
    if (!panel) return;
    if (mini.room) return renderRoom();
    var s = session() || {};
    var st = myStatus();
    var label = (TABS.filter(function (t) { return t[0] === mini.tab; })[0] || [0, 'Chats'])[1];
    var seg = (mini.tab === 'direct' || mini.tab === 'channels')
      ? '<div class="seg"><button type="button" data-m="flt" data-v="recent" class="' + (mini.filter === 'recent' ? 'on' : '') + '">Recent</button>' +
        '<button type="button" data-m="flt" data-v="unread" class="' + (mini.filter === 'unread' ? 'on' : '') + '">Unread</button></div>'
      : '';
    panel.innerHTML =
      '<div class="hd"><span class="lg">' + ICO.logo + '</span>' +
      '<div class="tt"><b>' + esc(s.name || 'Team Chat') + ' · ' + esc(label) + '</b>' +
      '<small><i style="background:' + esc(st.color) + '"></i>' + esc(st.label) + '</small></div>' +
      '<button type="button" class="ib" data-m="full" title="Open full chat" aria-label="Open full chat">' + ICO.expand + '</button>' +
      '<button type="button" class="ib" data-m="close" title="Close (Esc)" aria-label="Close">' + ICO.close + '</button></div>' +
      '<div class="sr"><label class="sb">' + ICO.search +
      '<input data-m="q" type="search" autocomplete="off" placeholder="Search (Ctrl + Space)" value="' + esc(mini.q) + '"></label></div>' +
      seg +
      '<div class="wrap"><div class="ls" data-m="list"><div class="em">Loading…</div></div>' +
      (mini.tab === 'direct' || mini.tab === 'channels' || mini.tab === 'people'
        ? '<button type="button" class="fab" data-m="plus" title="New chat or channel" aria-label="New chat or channel">' + ICO.plus + '</button>' : '') +
      '</div>';
    renderList();
  }

  function loadForTab(silent) {
    var t = mini.tab;
    var jobs = [];
    if ((t === 'direct' || t === 'channels') || !mini.rooms) jobs.push(getJSON('/api/chat/rooms?email=' + encodeURIComponent(me())).then(function (d) { mini.rooms = Array.isArray(d) ? d : []; }));
    if (!mini.contacts || Date.now() - mini.contactsAt > 300000) jobs.push(getJSON('/api/chat/contacts?email=' + encodeURIComponent(me())).then(function (d) { mini.contacts = Array.isArray(d) ? d : []; mini.contactsAt = Date.now(); }));
    if (t === 'threads') jobs.push(getJSON('/api/chat/threads').then(function (d) { mini.threads = Array.isArray(d) ? d : []; }));
    if (t === 'pins') jobs.push(getJSON('/api/chat/pins').then(function (d) { mini.pins = Array.isArray(d) ? d : []; }));
    Promise.all(jobs.map(function (j) { return j.catch(function () {}); })).then(function () {
      if (!mini.open || mini.room || mini.tab !== t) return;
      if (mini.rooms) {
        unread.direct = 0; unread.channels = 0;
        mini.rooms.forEach(function (r) { if (r.unread > 0) unread[r.is_group ? 'channels' : 'direct'] += r.unread; });
        if (window.__hrmsAlerts) window.__hrmsAlerts.chatUnread(unread.direct + unread.channels, 'mini');
      }
      renderList();
      place();
    });
  }

  function match(text) {
    var q = mini.q.trim().toLowerCase();
    return !q || String(text || '').toLowerCase().indexOf(q) !== -1;
  }

  function renderList() {
    var panel = document.getElementById(MINI);
    var list = panel && panel.querySelector('[data-m="list"]');
    if (!list) return;
    var t = mini.tab, html = '';
    if (t === 'direct' || t === 'channels') {
      if (!mini.rooms) { list.innerHTML = '<div class="em">Loading…</div>'; return; }
      var rooms = mini.rooms.filter(function (r) {
        if (t === 'channels' && !r.is_group) return false;
        if (mini.filter === 'unread' && !(r.unread > 0)) return false;
        return match((r.display_name || r.name) + ' ' + (r.last_message || ''));
      });
      html = rooms.map(function (r) {
        var name = r.display_name || r.name || 'Chat';
        var isCh = !!r.is_group;
        var other = r.other_email || '';
        var mem = (r.members || []).filter(function (x) { return x.email === other; })[0];
        var last = r.last_message
          ? ((r.last_sender && r.last_sender === me()) ? 'You: ' : '') + r.last_message
          : (isCh ? (r.member_emails || []).length + ' members' : 'Say hello 👋');
        return '<div class="rw' + (r.unread > 0 ? ' un' : '') + '" data-m="room" data-id="' + esc(r.id) + '" title="' + esc(last) + '">' +
          avatar(name, other, mem && mem.profilePic, isCh, !isCh) +
          '<div class="mid"><div class="nm">' + (isCh ? '#' : '') + esc(name) + '</div><div class="pv">' + esc(last) + '</div></div>' +
          '<div class="rt"><span class="tm">' + esc(shortTime(r.last_time)) + '</span>' +
          (r.unread > 0 ? '<span class="bd">' + (r.unread > 99 ? '99+' : r.unread) + '</span>' : '') +
          '<button type="button" class="mn' + (mini.menuFor === String(r.id) ? ' on' : '') + '" data-m="menu" data-id="' + esc(r.id) + '" aria-label="More">' + ICO.dots + '</button>' +
          '</div>' +
          (mini.menuFor === String(r.id)
            ? '<div class="pop" style="right:8px;top:38px"><button type="button" data-m="open-full" data-id="' + esc(r.id) + '">Open in full chat</button>' +
              (r.unread > 0 ? '<button type="button" data-m="mark-read" data-id="' + esc(r.id) + '">Mark as read</button>' : '') + '</div>'
            : '') +
          '</div>';
      }).join('');
      if (!html) html = '<div class="em">' + (mini.filter === 'unread' ? "You're all caught up." : (t === 'channels' ? 'No channels yet.' : 'No conversations yet.')) + '</div>';
    } else if (t === 'people') {
      if (!mini.contacts) { list.innerHTML = '<div class="em">Loading…</div>'; return; }
      html = mini.contacts.filter(function (c) { return match([c.name, c.email, c.department, c.designation].join(' ')); }).map(function (c) {
        return '<div class="rw" data-m="dm" data-email="' + esc(c.email) + '">' + avatar(c.name, c.email, c.profilePic, false, true) +
          '<div class="mid"><div class="nm">' + esc(c.name) + '</div><div class="pv">' + esc([c.designation, c.department].filter(Boolean).join(' · ') || c.email) + '</div></div></div>';
      }).join('') || '<div class="em">No people found.</div>';
    } else if (t === 'threads') {
      if (!mini.threads) { list.innerHTML = '<div class="em">Loading…</div>'; return; }
      html = mini.threads.filter(function (x) { return match(x.room_label + ' ' + x.parent.text); }).map(function (x) {
        return '<div class="rw" data-m="goto" data-id="' + esc(x.room_id) + '" title="' + esc(x.parent.text) + '">' +
          avatar(x.room_label, '', '', x.is_group, false) +
          '<div class="mid"><div class="nm">' + esc(x.room_label) + '</div><div class="pv">' + esc(x.parent.text || '(deleted message)') + '</div>' +
          '<div class="pv" style="font-size:11px">' + x.reply_count + (x.reply_count === 1 ? ' reply' : ' replies') + ' · last by ' + esc(x.last_reply_sender) + '</div></div>' +
          '<div class="rt"><span class="tm">' + esc(shortTime(x.last_reply_at)) + '</span></div></div>';
      }).join('') || '<div class="em">No threads yet. Reply to a message to start one.</div>';
    } else if (t === 'pins') {
      if (!mini.pins) { list.innerHTML = '<div class="em">Loading…</div>'; return; }
      html = mini.pins.filter(function (x) { return match(x.room_label + ' ' + x.text); }).map(function (x) {
        return '<div class="rw" data-m="goto" data-id="' + esc(x.room_id) + '" title="' + esc(x.text) + '">' +
          avatar(x.room_label, '', '', x.is_group, false) +
          '<div class="mid"><div class="nm">' + esc(x.room_label) + '</div><div class="pv">' + esc(x.text) + '</div></div>' +
          '<div class="rt"><span class="tm">' + esc(shortTime(x.pinned_at || x.created_at)) + '</span></div></div>';
      }).join('') || '<div class="em">No pins yet. Pin a message to keep it here for 30 days.</div>';
    }
    var st = list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = st;
    // The + menu belongs to the panel (not the scrolling list).
    var wrap = panel.querySelector('.wrap');
    var pop = wrap && wrap.querySelector('[data-m-pop="plus"]');
    if (mini.plusOpen && wrap && !pop) {
      pop = document.createElement('div');
      pop.className = 'pop';
      pop.setAttribute('data-m-pop', 'plus');
      pop.style.cssText = 'right:16px;bottom:66px;';
      pop.innerHTML = '<button type="button" data-m="new-chat">New chat</button><button type="button" data-m="new-channel">New channel</button>';
      wrap.appendChild(pop);
    } else if (!mini.plusOpen && pop) {
      pop.parentNode.removeChild(pop);
    }
  }

  // ── conversation inside the mini panel ──────────────────────────────────
  function stopRoomPoll() { if (mini.roomPoll) { clearInterval(mini.roomPoll); mini.roomPoll = null; } }

  function openRoom(id) {
    var r = (mini.rooms || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) { openFull('room=' + encodeURIComponent(id)); return; }
    mini.room = r;
    mini.messages = [];
    mini.menuFor = null;
    renderRoom();
    loadMessages(true);
    stopRoomPoll();
    mini.roomPoll = setInterval(function () { if (mini.open && mini.room) loadMessages(false); }, 4000);
  }

  function loadMessages(first) {
    var r = mini.room;
    if (!r) return;
    getJSON('/api/chat/messages/' + r.id + '?email=' + encodeURIComponent(me())).then(function (list) {
      if (!mini.room || String(mini.room.id) !== String(r.id)) return;
      var changed = JSON.stringify((list || []).map(function (m) { return [m.id, m.message, m.is_deleted, m.reactions]; })) !==
                    JSON.stringify(mini.messages.map(function (m) { return [m.id, m.message, m.is_deleted, m.reactions]; }));
      var before = {};
      mini.messages.forEach(function (m) { before[m.id] = true; });
      var hadAny = mini.messages.length > 0;
      mini.messages = Array.isArray(list) ? list : [];
      if (first) { r.unread = 0; refreshUnread(); }
      // New message from someone else in the conversation open in the panel:
      // sound / pop-up only when the tab is in the background (hrms-sounds.js).
      if (!first && hadAny && window.__hrmsAlerts) {
        mini.messages.forEach(function (m) {
          if (!before[m.id] && String(m.sender_email || '').toLowerCase() !== me()) window.__hrmsAlerts.chatMessage(m, r);
        });
      }
      if (first || changed) renderMessages(first);
    }).catch(function (e) {
      if (e && (e.status === 404 || e.status === 403)) {
        // Deleted, or you were removed: stop polling it and drop it from the list.
        stopRoomPoll();
        mini.rooms = (mini.rooms || []).filter(function (x) { return String(x.id) !== String(r.id); });
        if (mini.room && String(mini.room.id) === String(r.id)) {
          mini.room = null;
          renderShell();
          var list = document.querySelector('#' + MINI + ' [data-m="list"]');
          if (list) list.insertAdjacentHTML('afterbegin', '<div class="em">That conversation is no longer available — it was deleted, or you were removed from it.</div>');
        }
        return;
      }
      var box = document.querySelector('#' + MINI + ' [data-m="msgs"]');
      if (box && first) box.innerHTML = '<div class="em">Could not load messages: ' + esc(e.message) + '</div>';
    });
  }

  function renderRoom() {
    var panel = document.getElementById(MINI);
    var r = mini.room;
    if (!panel || !r) return;
    var isCh = !!r.is_group;
    var name = r.display_name || r.name || 'Chat';
    var other = r.other_email || '';
    var mem = (r.members || []).filter(function (x) { return x.email === other; })[0];
    var sub = isCh ? (r.member_emails || []).length + ' members' : presence(other).label;
    panel.innerHTML =
      '<div class="hd"><button type="button" class="ib" data-m="back" title="Back" aria-label="Back">' + ICO.back + '</button>' +
      avatar(name, other, mem && mem.profilePic, isCh, !isCh) +
      '<div class="tt"><b>' + (isCh ? '#' : '') + esc(name) + '</b><small' + (isCh ? '' : ' data-dock-status="' + esc(other) + '" style="color:' + esc(presence(other).color) + '"') + '>' + esc(sub) + '</small></div>' +
      '<button type="button" class="ib" data-m="open-full" data-id="' + esc(r.id) + '" title="Open in full chat" aria-label="Open in full chat">' + ICO.expand + '</button>' +
      '<button type="button" class="ib" data-m="close" title="Close (Esc)" aria-label="Close">' + ICO.close + '</button></div>' +
      '<div class="ms" data-m="msgs"><div class="em">Loading…</div></div>' +
      '<div class="err" data-m="err" style="display:none"></div>' +
      '<div class="cp"><textarea data-m="input" rows="1" placeholder="Message ' + esc(isCh ? '#' + name : name) + '…" aria-label="Message"></textarea>' +
      '<button type="button" class="snd" data-m="send" aria-label="Send">' + ICO.send + '</button></div>';
    var ta = panel.querySelector('[data-m="input"]');
    if (ta) ta.focus();
  }

  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function renderMessages(toBottom) {
    var box = document.querySelector('#' + MINI + ' [data-m="msgs"]');
    if (!box) return;
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    var isCh = mini.room && mini.room.is_group;
    var msgs = mini.messages.slice(-80);
    if (!msgs.length) { box.innerHTML = '<div class="em">No messages yet. Say hello 👋</div>'; return; }
    var html = '', day = '', prev = '';
    msgs.forEach(function (m) {
      var d = parseDt(m.created_at);
      var dl = d ? d.toDateString() : '';
      if (dl !== day) {
        day = dl; prev = '';
        var today = new Date().toDateString();
        html += '<div class="sep">' + esc(dl === today ? 'Today' : (d ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '')) + '</div>';
      }
      var mine = (m.sender_email || '').toLowerCase() === me();
      var body;
      if (m.is_deleted) body = 'This message was deleted';
      else {
        body = (m.reply_to_id ? '<div class="q"><b>' + esc(m.reply_to_sender || '') + '</b> ' + esc(m.reply_to_text || '') + '</div>' : '') +
          (m.attachment_url ? '<div>📎 <a href="' + esc(m.attachment_url) + '" target="_blank" rel="noopener">' + esc(m.attachment_name || 'Attachment') + '</a></div>' : '') +
          linkify(m.message || '') +
          ((m.reactions || []).length ? '<div>' + m.reactions.map(function (g) { return '<span class="rx" title="' + esc((g.names || []).join(', ')) + '">' + esc(g.emoji) + ' ' + g.count + '</span>'; }).join('') + '</div>' : '');
      }
      html += '<div class="bb' + (mine ? ' me' : '') + (m.is_deleted ? ' del' : '') + '">' +
        (isCh && !mine && prev !== m.sender_email ? '<div class="sn">' + esc(m.sender_name || m.sender_email) + '</div>' : '') +
        body + '<div class="tm2">' + esc(d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + '</div></div>';
      prev = m.sender_email;
    });
    box.innerHTML = html;
    if (toBottom || atBottom) box.scrollTop = box.scrollHeight;
  }

  function send() {
    var panel = document.getElementById(MINI);
    var ta = panel && panel.querySelector('[data-m="input"]');
    var r = mini.room;
    if (!ta || !r || mini.sending) return;
    var text = ta.value.trim();
    if (!text) return;
    mini.sending = true;
    var btn = panel.querySelector('[data-m="send"]');
    if (btn) btn.disabled = true;
    var err = panel.querySelector('[data-m="err"]');
    postJSON('/api/chat/messages/' + r.id, { message: text }).then(function (saved) {
      ta.value = '';
      ta.style.height = '';
      if (err) err.style.display = 'none';
      if (saved && saved.id != null && !mini.messages.some(function (m) { return m.id === saved.id; })) mini.messages.push(saved);
      renderMessages(true);
    }).catch(function (e) {
      if (err) { err.textContent = 'Not sent: ' + e.message; err.style.display = ''; }
    }).then(function () {
      mini.sending = false;
      if (btn) btn.disabled = false;
      ta.focus();
    });
  }

  function startDirect(email) {
    postJSON('/api/chat/rooms', { type: 'direct', members: [email, me()], created_by: me() }).then(function (room) {
      mini.rooms = mini.rooms || [];
      if (!mini.rooms.some(function (x) { return x.id === room.id; })) mini.rooms.unshift(room);
      mini.tab = 'direct';
      openRoom(room.id);
      var bar = document.getElementById(ID);
      if (bar) paintBar(bar);
    }).catch(function (e) { window.alert('Could not start the chat: ' + e.message); });
  }

  // ── events ─────────────────────────────────────────────────────────────
  function onPanelClick(e) {
    var el = e.target.closest && e.target.closest('[data-m]');
    var m = el && el.getAttribute('data-m');
    var hadMenu = mini.menuFor != null || mini.plusOpen;
    if (m !== 'menu' && m !== 'plus' && hadMenu) { mini.menuFor = null; mini.plusOpen = false; }
    if (!m) { if (hadMenu) renderList(); return; }
    if (m === 'close') return closeMini();
    if (m === 'full') return openFull('tab=' + mini.tab);
    if (m === 'flt') { mini.filter = el.getAttribute('data-v'); return renderShell(); }
    if (m === 'menu') { e.stopPropagation(); var id = el.getAttribute('data-id'); mini.menuFor = mini.menuFor === id ? null : id; mini.plusOpen = false; return renderList(); }
    if (m === 'plus') { mini.plusOpen = !mini.plusOpen; mini.menuFor = null; return renderList(); }
    if (m === 'new-chat') { mini.tab = 'people'; mini.q = ''; renderShell(); loadForTab(); var bar = document.getElementById(ID); if (bar) paintBar(bar); return; }
    if (m === 'new-channel') return openFull('tab=channels');
    if (m === 'open-full') return openFull('room=' + encodeURIComponent(el.getAttribute('data-id')));
    if (m === 'mark-read') {
      var rid = el.getAttribute('data-id');
      postJSON('/api/chat/rooms/' + rid + '/read', {}).then(function () { loadForTab(true); refreshUnread(); }).catch(function () {});
      return renderList();
    }
    if (m === 'room') return openRoom(el.getAttribute('data-id'));
    if (m === 'goto') return openRoom(el.getAttribute('data-id'));
    if (m === 'dm') return startDirect(el.getAttribute('data-email'));
    if (m === 'back') { mini.room = null; stopRoomPoll(); renderShell(); loadForTab(true); return; }
    if (m === 'send') return send();
    if (hadMenu) renderList();
  }

  function onPanelInput(e) {
    var m = e.target.getAttribute && e.target.getAttribute('data-m');
    if (m === 'q') { mini.q = e.target.value; renderList(); }
    if (m === 'input') { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px'; }
  }

  function onPanelKey(e) {
    var m = e.target.getAttribute && e.target.getAttribute('data-m');
    if (m === 'input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mini.open) {
      if (mini.menuFor != null || mini.plusOpen) { mini.menuFor = null; mini.plusOpen = false; renderList(); return; }
      if (mini.room) { mini.room = null; stopRoomPoll(); renderShell(); return; }
      closeMini();
      return;
    }
    // Ctrl+Space: open the mini panel on Chats and focus its search.
    if (e.ctrlKey && (e.code === 'Space' || e.key === ' ') && document.getElementById(ID) && visibleSidebar()) {
      e.preventDefault();
      if (mini.open && !mini.room) {
        var q = document.querySelector('#' + MINI + ' [data-m="q"]');
        if (q) q.focus();
      } else {
        openMini(mini.open ? mini.tab : 'direct');
      }
    }
  });

  // ── boot ───────────────────────────────────────────────────────────────
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; place(); });
  }

  function boot() {
    place();
    new MutationObserver(function (list) {
      // Ignore changes inside our own bar / panel (they re-render often).
      for (var i = 0; i < list.length; i++) {
        var t = list[i].target;
        if (t && t.closest && (t.closest('#' + ID) || t.closest('#' + MINI) || t.closest('#' + LAUNCH_ID))) continue;
        schedule();
        return;
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('popstate', function () { setTimeout(schedule, 50); });
    window.addEventListener('focus', refreshUnread);
    setTimeout(refreshUnread, 2000);
    setInterval(refreshUnread, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__hrmsChatMini = { open: openMini, close: closeMini };
})();
