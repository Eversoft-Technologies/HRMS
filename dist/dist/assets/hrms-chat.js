/**
 * HRMS Employee Chat — inline page module (v2)
 * =============================================================================
 * Renders INSIDE the `/employees/chat` route (into <div id="hrms-chat-page">)
 * exactly like the other employee sections (Attendance, Check-In/Out, Task
 * Tracker, Work Submissions) — NOT as a floating popup/overlay.
 *
 * Real data (no dummy content):
 *   • current user  → localStorage "hrms_session"  ({ email, name/fullName })
 *   • contacts      → GET  /api/chat/contacts?email=<me>
 *   • rooms         → GET  /api/chat/rooms?email=<me>
 *   • messages      → GET  /api/chat/messages/<roomId>?email=<me>
 *   • meetings      → GET  /api/chat/meetings?room_id=<roomId>
 *   • send message  → WebSocket ws(s)://<host>/ws/chat/<roomId>/  (REST fallback
 *                     POST /api/chat/messages/<roomId>)
 *   • new direct    → POST /api/chat/rooms  { type:'direct',  members, created_by }
 *   • new channel   → POST /api/chat/rooms  { type:'channel', name, members, created_by }
 *   • schedule mtg  → POST /api/chat/meetings { room_id, title, scheduled_at, ... }
 *
 * Two sidebar tabs: "Direct" (1:1) and "Channels" (groups). Auth headers are
 * attached automatically by hrms-actor.js.
 *
 * Public entry point: window.__hrmsOpenChat()  (called by the React route).
 */
(function (global) {
  "use strict";

  var PAGE_ID = "hrms-chat-page";
  var ROOT_ID = "hcx-root";

  // ───────────────────────────────────────────── state
  var state = {
    me: { email: "", name: "" },
    contacts: [],
    rooms: [],
    tab: "direct", // "direct" | "channels"
    search: "",
    activeRoomId: null,
    activeRoom: null,
    messages: [],
    meetings: [],
    knownIds: null, // Set of rendered message ids
    pending: [], // optimistic messages awaiting server echo
    ws: null,
    wsRoomId: null,
    pollTimer: null,
    loadingContacts: false,
    loadingRooms: false,
    booted: false,
    editingId: null,
    recog: null,
    listening: false,
    dictBase: "",
    msgSearch: { q: "", matches: [], idx: -1 },
  };

  // ───────────────────────────────────────────── helpers: session / api
  function getSession() {
    try {
      var s = JSON.parse(localStorage.getItem("hrms_session") || "null");
      if (!s) return { email: "", name: "" };
      return { email: (s.email || "").trim(), name: s.name || s.fullName || "" };
    } catch (_) {
      return { email: "", name: "" };
    }
  }

  function apiGet(path) {
    return fetch(path, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("GET " + path + " → " + r.status);
      return r.json();
    });
  }

  function apiPost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r
        .json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (!r.ok) throw new Error((data && data.message) || "POST " + path + " → " + r.status);
          return data;
        });
    });
  }

  // ───────────────────────────────────────────── helpers: misc
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Escape, then turn URLs into clickable links (used for message bodies).
  function linkify(str) {
    var safe = esc(str);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="hcx-link">' + url + "</a>";
    });
  }

  function initials(name) {
    var n = (name || "").trim();
    if (!n) return "?";
    var parts = n.split(/\s+/);
    var s = parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "");
    return s.toUpperCase();
  }

  var AVATAR_COLORS = [
    "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a",
    "#0891b2", "#9333ea", "#dc2626", "#0d9488", "#4f46e5",
  ];
  function colorFor(key) {
    var s = String(key || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function avatarHTML(name, key, pic, cls) {
    cls = cls || "";
    var inner = pic
      ? '<span class="hcx-av ' + cls + '"><img src="' + esc(pic) + '" alt=""></span>'
      : '<span class="hcx-av ' + cls + '" style="background:' + colorFor(key || name) + '">' +
        esc(initials(name)) + "</span>";
    // A person, not a channel: ask hrms-status.js for a presence dot. The dot
    // cannot live inside .hcx-av — that element is a clipped circle
    // (overflow:hidden), which would cut the corner off it — so the avatar is
    // wrapped in a positioned span and the dot hangs off that instead.
    var email = String(key || "");
    if (email.indexOf("@") === -1) return inner;
    return '<span class="hcx-avwrap" data-hrms-presence="' + esc(email) + '">' + inner + "</span>";
  }

  function fmtTime(iso) {
    return fmtTimeOf(parseDate(iso));
  }

  function fmtTimeOf(d) {
    if (!d) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabelOf(d) {
    if (!d) return "";
    var today = new Date();
    var y = new Date();
    y.setDate(today.getDate() - 1);
    function same(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    if (same(d, today)) return "Today";
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function parseDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      // Fallback for "YYYY-MM-DD HH:MM:SS"
      d = new Date(String(iso).replace(" ", "T"));
    }
    return isNaN(d.getTime()) ? null : d;
  }

  function dayLabel(iso) {
    var d = parseDate(iso);
    if (!d) return "";
    var today = new Date();
    var y = new Date();
    y.setDate(today.getDate() - 1);
    function same(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    if (same(d, today)) return "Today";
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function relTime(iso) {
    var d = parseDate(iso);
    if (!d) return "";
    var now = new Date();
    var diff = (now - d) / 1000;
    if (diff < 60) return "now";
    if (diff < 3600) return Math.floor(diff / 60) + "m";
    if (same(d, now)) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var y = new Date();
    y.setDate(now.getDate() - 1);
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
    function same(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
  }

  // ───────────────────────────────────────────── icons
  var ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    check2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 13 13"/><polyline points="7 11 11 15 3 23"/></svg>',
    check1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };

  // ───────────────────────────────────────────── styles
  function injectStyles() {
    // Remove any legacy stylesheet from the old popup build.
    var old = document.getElementById("hrms-chat-styles");
    if (old) old.remove();
    if (document.getElementById("hcx-styles")) return;
    var css = [
      "#" + PAGE_ID + "{position:relative;overflow:hidden;}",
      "#" + ROOT_ID + "{",
      "  --hcx-primary:#2563eb;--hcx-primary-2:#4f46e5;--hcx-bg:#f8fafc;--hcx-surface:#ffffff;",
      "  --hcx-border:#e5e7eb;--hcx-text:#0f172a;--hcx-muted:#64748b;--hcx-hover:#f1f5f9;",
      "  --hcx-sent:linear-gradient(135deg,#2563eb 0%,#4f46e5 100%);--hcx-radius:14px;",
      "  --hcx-font:'DM Sans','Inter','Segoe UI',system-ui,sans-serif;",
      "  position:absolute;inset:0;display:flex;background:var(--hcx-bg);color:var(--hcx-text);",
      "  font-family:var(--hcx-font);-webkit-font-smoothing:antialiased;",
      "}",
      // dark theme
      '[data-theme="dark"] #' + ROOT_ID + "{",
      "  --hcx-bg:#0f172a;--hcx-surface:#1e293b;--hcx-border:#334155;--hcx-text:#e2e8f0;",
      "  --hcx-muted:#94a3b8;--hcx-hover:#273449;",
      "}",
      "#" + ROOT_ID + " *{box-sizing:border-box;}",

      // sidebar
      "#" + ROOT_ID + " .hcx-side{width:330px;min-width:330px;background:var(--hcx-surface);border-right:1px solid var(--hcx-border);display:flex;flex-direction:column;}",
      "#" + ROOT_ID + " .hcx-side-top{padding:16px 16px 10px;border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-title{display:flex;align-items:center;gap:10px;}",
      "#" + ROOT_ID + " .hcx-title .hcx-logo{width:34px;height:34px;border-radius:9px;background:var(--hcx-sent);display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-title .hcx-logo svg{width:18px;height:18px;color:#fff;}",
      "#" + ROOT_ID + " .hcx-title h2{font-size:16px;font-weight:700;margin:0;letter-spacing:-.2px;}",
      "#" + ROOT_ID + " .hcx-title p{font-size:11.5px;color:var(--hcx-muted);margin:1px 0 0;}",
      "#" + ROOT_ID + " .hcx-newbtn{margin-left:auto;width:34px;height:34px;border-radius:9px;border:none;background:var(--hcx-primary);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-newbtn svg{width:18px;height:18px;}",
      "#" + ROOT_ID + " .hcx-tabs{display:flex;gap:6px;margin-top:12px;}",
      "#" + ROOT_ID + " .hcx-tab{flex:1;padding:8px;border:none;background:transparent;color:var(--hcx-muted);font-family:inherit;font-size:13px;font-weight:600;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}",
      "#" + ROOT_ID + " .hcx-tab svg{width:15px;height:15px;}",
      "#" + ROOT_ID + " .hcx-tab.on{background:var(--hcx-primary);color:#fff;}",
      "#" + ROOT_ID + " .hcx-searchwrap{padding:10px 14px;border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-searchbox{position:relative;display:flex;align-items:center;}",
      "#" + ROOT_ID + " .hcx-searchbox svg{position:absolute;left:11px;width:15px;height:15px;color:var(--hcx-muted);}",
      "#" + ROOT_ID + " .hcx-searchbox input{width:100%;padding:8px 12px 8px 34px;border:1.5px solid var(--hcx-border);border-radius:10px;background:var(--hcx-bg);color:var(--hcx-text);font-family:inherit;font-size:13px;outline:none;}",
      "#" + ROOT_ID + " .hcx-searchbox input:focus{border-color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-list{flex:1;overflow-y:auto;padding:6px;}",
      "#" + ROOT_ID + " .hcx-row{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;cursor:pointer;position:relative;}",
      "#" + ROOT_ID + " .hcx-row:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-row.on{background:rgba(37,99,235,.12);}",
      "#" + ROOT_ID + " .hcx-row .hcx-rn{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      "#" + ROOT_ID + " .hcx-row .hcx-rl{font-size:12px;color:var(--hcx-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}",
      "#" + ROOT_ID + " .hcx-row .hcx-mid{flex:1;min-width:0;}",
      "#" + ROOT_ID + " .hcx-row .hcx-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-row .hcx-rt{font-size:11px;color:var(--hcx-muted);}",
      "#" + ROOT_ID + " .hcx-badge{min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--hcx-primary);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-empty{padding:26px 16px;text-align:center;color:var(--hcx-muted);font-size:13px;}",
      "#" + ROOT_ID + " .hcx-empty small{display:block;margin-top:4px;font-size:12px;opacity:.8;}",

      // avatar
      "#" + ROOT_ID + " .hcx-av{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0;overflow:hidden;}",
      "#" + ROOT_ID + " .hcx-av img{width:100%;height:100%;object-fit:cover;}",
      "#" + ROOT_ID + " .hcx-avwrap{position:relative;display:inline-flex;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-hstatus{font-weight:600;}",
      "#" + ROOT_ID + " .hcx-hstatus:not(:empty)::before{content:'·';margin:0 5px;color:var(--hcx-muted,inherit);font-weight:400;}",
      // The dot is drawn by hrms-status.js; these two rules only size it to the
      // avatar it is sitting on and keep it out of the panel's own borders.
      "#" + ROOT_ID + " .hcx-avwrap .hrms-presence-dot{width:11px;height:11px;border:2px solid var(--hcx-panel,var(--bg2));}",
      "#" + ROOT_ID + " .hcx-avwrap:has(.hcx-av.sm) .hrms-presence-dot{width:9px;height:9px;}",
      "#" + ROOT_ID + " .hcx-av.sm{width:32px;height:32px;font-size:12px;}",
      "#" + ROOT_ID + " .hcx-av.lg{width:40px;height:40px;font-size:14px;}",
      "#" + ROOT_ID + " .hcx-av.ch{background:var(--hcx-sent)!important;}",
      "#" + ROOT_ID + " .hcx-av.ch svg{width:20px;height:20px;color:#fff;}",

      // main panel
      "#" + ROOT_ID + " .hcx-main{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--hcx-bg);}",
      "#" + ROOT_ID + " .hcx-head{display:flex;align-items:center;gap:12px;padding:12px 18px;min-height:64px;background:var(--hcx-surface);border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-head .hcx-hn{font-size:15px;font-weight:700;}",
      "#" + ROOT_ID + " .hcx-head .hcx-hm{font-size:12px;color:var(--hcx-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52vw;}",
      "#" + ROOT_ID + " .hcx-head .hcx-hinfo{flex:1;min-width:0;}",
      "#" + ROOT_ID + " .hcx-hbtn{display:flex;align-items:center;gap:6px;height:36px;padding:0 12px;border-radius:9px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-text);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;}",
      "#" + ROOT_ID + " .hcx-hbtn:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-hbtn svg{width:16px;height:16px;}",
      "#" + ROOT_ID + " .hcx-hbtn.primary{background:var(--hcx-primary);border-color:var(--hcx-primary);color:#fff;}",
      "#" + ROOT_ID + " .hcx-iconbtn{width:36px;height:36px;border-radius:9px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-muted);cursor:pointer;display:none;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-iconbtn svg{width:18px;height:18px;}",
      "#" + ROOT_ID + " .hcx-hicon{width:38px;height:38px;border-radius:9px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-hicon:hover{background:var(--hcx-hover);color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-hicon svg{width:17px;height:17px;}",
      "#" + ROOT_ID + " .hcx-menuwrap{position:relative;}",
      "#" + ROOT_ID + " .hcx-menu{position:absolute;top:44px;right:0;min-width:180px;background:var(--hcx-surface);border:1px solid var(--hcx-border);border-radius:11px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px;z-index:50;}",
      "#" + ROOT_ID + " .hcx-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border:none;background:transparent;color:var(--hcx-text);font-family:inherit;font-size:13px;font-weight:600;text-align:left;border-radius:8px;cursor:pointer;}",
      "#" + ROOT_ID + " .hcx-menu button:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-menu button.danger{color:var(--hcx-danger,#ef4444);}",
      "#" + ROOT_ID + " .hcx-menu button svg{width:15px;height:15px;}",
      // in-conversation search bar
      "#" + ROOT_ID + " .hcx-searchbar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--hcx-surface);border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-searchbar .si{display:flex;color:var(--hcx-muted);}",
      "#" + ROOT_ID + " .hcx-searchbar .si svg{width:16px;height:16px;}",
      "#" + ROOT_ID + " .hcx-searchbar input{flex:1;border:none;background:transparent;outline:none;font-family:inherit;font-size:13.5px;color:var(--hcx-text);}",
      "#" + ROOT_ID + " .hcx-search-count{font-size:12px;color:var(--hcx-muted);white-space:nowrap;}",
      "#" + ROOT_ID + " .hcx-search-nav{width:28px;height:28px;border:none;background:transparent;color:var(--hcx-muted);cursor:pointer;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;}",
      "#" + ROOT_ID + " .hcx-search-nav:hover{background:var(--hcx-hover);color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-search-nav svg{width:14px;height:14px;}",
      // mic recording state
      "#" + ROOT_ID + " .hcx-attachbtn.rec{background:#fee2e2;color:#ef4444;animation:hcx-pulse 1.2s infinite;}",
      '[data-theme="dark"] #' + ROOT_ID + " .hcx-attachbtn.rec{background:#7f1d1d;color:#fecaca;}",
      "@keyframes hcx-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
      // search match highlight
      "#" + ROOT_ID + " .hcx-msg.match .hcx-bubble{outline:2px solid rgba(37,99,235,.35);}",
      "#" + ROOT_ID + " .hcx-msg.match-current .hcx-bubble{outline:2px solid var(--hcx-primary);box-shadow:0 0 0 4px rgba(37,99,235,.18);}",

      // meetings strip
      "#" + ROOT_ID + " .hcx-mtg-strip{padding:10px 18px;background:var(--hcx-surface);border-bottom:1px solid var(--hcx-border);display:flex;flex-direction:column;gap:8px;}",
      "#" + ROOT_ID + " .hcx-mtg-card{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--hcx-border);border-radius:11px;background:var(--hcx-bg);}",
      "#" + ROOT_ID + " .hcx-mtg-card .hcx-mtg-ic{width:34px;height:34px;border-radius:9px;background:rgba(37,99,235,.12);color:var(--hcx-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-mtg-card .hcx-mtg-ic svg{width:17px;height:17px;}",
      "#" + ROOT_ID + " .hcx-mtg-t{font-size:13px;font-weight:700;}",
      "#" + ROOT_ID + " .hcx-mtg-s{font-size:12px;color:var(--hcx-muted);margin-top:1px;}",
      "#" + ROOT_ID + " .hcx-join{margin-left:auto;height:32px;padding:0 14px;border-radius:8px;border:none;background:var(--hcx-primary);color:#fff;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;text-decoration:none;}",
      "#" + ROOT_ID + " .hcx-join svg{width:14px;height:14px;}",
      "#" + ROOT_ID + " .hcx-mtg-x{width:30px;height:30px;border:none;background:transparent;color:var(--hcx-muted);cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:6px;}",
      "#" + ROOT_ID + " .hcx-mtg-x:hover{background:var(--hcx-hover);color:var(--hcx-danger,#ef4444);}",
      "#" + ROOT_ID + " .hcx-mtg-x svg{width:15px;height:15px;}",

      // chat area
      "#" + ROOT_ID + " .hcx-area{flex:1;overflow-y:auto;padding:20px 22px 8px;display:flex;flex-direction:column;gap:3px;}",
      "#" + ROOT_ID + " .hcx-sep{display:flex;align-items:center;gap:10px;margin:12px 0 8px;}",
      "#" + ROOT_ID + " .hcx-sep .l{flex:1;height:1px;background:var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-sep .t{font-size:11.5px;font-weight:600;color:var(--hcx-muted);background:var(--hcx-bg);padding:2px 10px;border:1px solid var(--hcx-border);border-radius:99px;}",
      "#" + ROOT_ID + " .hcx-msg{display:flex;align-items:flex-end;gap:8px;max-width:74%;}",
      "#" + ROOT_ID + " .hcx-msg.sent{align-self:flex-end;flex-direction:row-reverse;}",
      "#" + ROOT_ID + " .hcx-msg.recv{align-self:flex-start;}",
      "#" + ROOT_ID + " .hcx-msg.cons{margin-top:-1px;}",
      "#" + ROOT_ID + " .hcx-msg.cons .hcx-av{visibility:hidden;}",
      "#" + ROOT_ID + " .hcx-msg.cons .hrms-presence-dot{visibility:hidden;}",
      "#" + ROOT_ID + " .hcx-bubble{padding:9px 13px;border-radius:16px;font-size:13.5px;line-height:1.5;background:var(--hcx-surface);box-shadow:0 1px 2px rgba(0,0,0,.06);word-break:break-word;position:relative;}",
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-bubble{background:var(--hcx-sent);color:#fff;border-bottom-right-radius:5px;}",
      "#" + ROOT_ID + " .hcx-msg.recv .hcx-bubble{border-bottom-left-radius:5px;}",
      "#" + ROOT_ID + " .hcx-sender{font-size:11.5px;font-weight:700;color:var(--hcx-primary);margin-bottom:2px;}",
      "#" + ROOT_ID + " .hcx-meta{display:flex;align-items:center;gap:5px;justify-content:flex-end;margin-top:3px;}",
      "#" + ROOT_ID + " .hcx-meta .tm{font-size:10.5px;opacity:.72;}",
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-meta .tm{color:rgba(255,255,255,.85);}",
      "#" + ROOT_ID + " .hcx-meta svg{width:14px;height:14px;}",
      "#" + ROOT_ID + " .hcx-tick{color:rgba(255,255,255,.85);display:inline-flex;}",
      "#" + ROOT_ID + " .hcx-tick.read{color:#93c5fd;}",
      "#" + ROOT_ID + " .hcx-link{color:inherit;text-decoration:underline;font-weight:600;}",
      "#" + ROOT_ID + " .hcx-msg.recv .hcx-link{color:var(--hcx-primary);}",

      // input
      // extra right padding keeps the send button clear of the global
      // floating Live-Interviews pill + AI button in the bottom-right corner.
      "#" + ROOT_ID + " .hcx-inbar{padding:12px 92px 16px 18px;background:var(--hcx-surface);border-top:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-inwrap{display:flex;align-items:flex-end;gap:10px;background:var(--hcx-bg);border:1.5px solid var(--hcx-border);border-radius:14px;padding:7px 7px 7px 14px;}",
      "#" + ROOT_ID + " .hcx-inwrap:focus-within{border-color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-inwrap textarea{flex:1;border:none;background:transparent;resize:none;outline:none;font-family:inherit;font-size:13.5px;color:var(--hcx-text);max-height:130px;min-height:22px;line-height:1.5;padding:2px 0;}",
      "#" + ROOT_ID + " .hcx-attachbtn{width:36px;height:36px;border-radius:9px;border:none;background:transparent;color:var(--hcx-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-attachbtn:hover{background:var(--hcx-hover);color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-attachbtn svg{width:19px;height:19px;}",
      // message actions (edit / delete) — shown on hover of own messages
      "#" + ROOT_ID + " .hcx-actions{display:none;align-items:center;gap:2px;align-self:center;}",
      "#" + ROOT_ID + " .hcx-msg:hover .hcx-actions{display:flex;}",
      "#" + ROOT_ID + " .hcx-actbtn{width:26px;height:26px;border-radius:7px;border:none;background:transparent;color:var(--hcx-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-actbtn:hover{background:var(--hcx-hover);color:var(--hcx-primary);}",
      "#" + ROOT_ID + " .hcx-actbtn.danger:hover{color:var(--hcx-danger,#ef4444);}",
      "#" + ROOT_ID + " .hcx-actbtn svg{width:14px;height:14px;}",
      "#" + ROOT_ID + " .hcx-edited{font-size:10px;opacity:.7;font-style:italic;margin-right:2px;}",
      "#" + ROOT_ID + " .hcx-bubble.deleted{background:transparent!important;box-shadow:none;border:1px dashed var(--hcx-border);color:var(--hcx-muted)!important;font-style:italic;}",
      // sent bubbles are white-on-gradient by default; force muted colour so the
      // deleted placeholder is readable in light theme too.
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-bubble.deleted{color:var(--hcx-muted)!important;}",
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-bubble.deleted .tm{color:var(--hcx-muted)!important;}",
      // attachments
      "#" + ROOT_ID + " .hcx-att-img{display:block;max-width:260px;max-height:260px;border-radius:10px;margin-bottom:5px;cursor:pointer;}",
      "#" + ROOT_ID + " .hcx-att-video{display:block;max-width:320px;max-height:280px;border-radius:10px;margin-bottom:5px;background:#000;}",
      "#" + ROOT_ID + " .hcx-att-audio{display:block;width:260px;max-width:100%;margin-bottom:5px;}",
      "#" + ROOT_ID + " .hcx-att-file{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.06);margin-bottom:4px;text-decoration:none;color:inherit;max-width:280px;}",
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-att-file{background:rgba(255,255,255,.18);}",
      "#" + ROOT_ID + " .hcx-att-file .fi{width:34px;height:34px;border-radius:8px;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-msg.sent .hcx-att-file .fi{background:rgba(255,255,255,.25);}",
      "#" + ROOT_ID + " .hcx-att-file .fi svg{width:17px;height:17px;}",
      "#" + ROOT_ID + " .hcx-att-file .fn{font-size:12.5px;font-weight:600;word-break:break-word;flex:1;min-width:0;}",
      "#" + ROOT_ID + " .hcx-att-file .dl{flex-shrink:0;opacity:.8;}",
      "#" + ROOT_ID + " .hcx-att-file .dl svg{width:15px;height:15px;}",
      // inline edit editor
      "#" + ROOT_ID + " .hcx-editwrap{display:flex;flex-direction:column;gap:6px;min-width:220px;}",
      "#" + ROOT_ID + " .hcx-editwrap textarea{width:100%;border:1.5px solid var(--hcx-border);border-radius:9px;background:var(--hcx-surface);color:var(--hcx-text);font-family:inherit;font-size:13.5px;padding:8px 10px;resize:vertical;min-height:44px;outline:none;}",
      "#" + ROOT_ID + " .hcx-editrow{display:flex;gap:8px;justify-content:flex-end;}",
      "#" + ROOT_ID + " .hcx-editrow button{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-text);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;}",
      "#" + ROOT_ID + " .hcx-editrow button.primary{background:var(--hcx-primary);border-color:var(--hcx-primary);color:#fff;}",
      // lightbox for images
      "#" + ROOT_ID + " .hcx-lightbox{position:absolute;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px;cursor:zoom-out;}",
      "#" + ROOT_ID + " .hcx-lightbox img{max-width:100%;max-height:100%;border-radius:10px;}",
      "#" + ROOT_ID + " .hcx-sendbtn{width:38px;height:38px;border-radius:10px;border:none;cursor:pointer;background:var(--hcx-sent);display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-sendbtn svg{width:17px;height:17px;color:#fff;}",
      "#" + ROOT_ID + " .hcx-sendbtn:disabled{opacity:.5;cursor:default;}",

      // welcome / empty conversation
      "#" + ROOT_ID + " .hcx-welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--hcx-muted);text-align:center;padding:20px;}",
      "#" + ROOT_ID + " .hcx-welcome .ic{width:76px;height:76px;border-radius:22px;background:rgba(37,99,235,.1);color:var(--hcx-primary);display:flex;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-welcome .ic svg{width:36px;height:36px;}",
      "#" + ROOT_ID + " .hcx-welcome h3{margin:0;font-size:17px;color:var(--hcx-text);}",
      "#" + ROOT_ID + " .hcx-welcome p{margin:0;font-size:13.5px;max-width:320px;line-height:1.5;}",

      // modal (scoped inside the chat section, not a page-wide popup)
      "#" + ROOT_ID + " .hcx-modal-bg{position:absolute;inset:0;background:rgba(15,23,42,.5);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:40;padding:20px;}",
      "#" + ROOT_ID + " .hcx-modal{width:100%;max-width:460px;max-height:88%;overflow:hidden;background:var(--hcx-surface);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.3);display:flex;flex-direction:column;}",
      "#" + ROOT_ID + " .hcx-modal-h{display:flex;align-items:center;padding:16px 18px;border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-modal-h h3{margin:0;font-size:15.5px;font-weight:700;flex:1;}",
      "#" + ROOT_ID + " .hcx-modal-x{width:32px;height:32px;border:none;background:transparent;color:var(--hcx-muted);cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center;}",
      "#" + ROOT_ID + " .hcx-modal-x:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-modal-x svg{width:18px;height:18px;}",
      "#" + ROOT_ID + " .hcx-modal-b{padding:16px 18px;overflow-y:auto;}",
      "#" + ROOT_ID + " .hcx-modal-f{padding:14px 18px;border-top:1px solid var(--hcx-border);display:flex;gap:10px;justify-content:flex-end;}",
      "#" + ROOT_ID + " .hcx-field{margin-bottom:14px;}",
      "#" + ROOT_ID + " .hcx-field label{display:block;font-size:12.5px;font-weight:600;color:var(--hcx-muted);margin-bottom:6px;}",
      "#" + ROOT_ID + " .hcx-input{width:100%;padding:10px 12px;border:1.5px solid var(--hcx-border);border-radius:10px;background:var(--hcx-bg);color:var(--hcx-text);font-family:inherit;font-size:13.5px;outline:none;}",
      "#" + ROOT_ID + " .hcx-input:focus{border-color:var(--hcx-primary);}",
      "#" + ROOT_ID + " textarea.hcx-input{resize:vertical;min-height:64px;}",
      "#" + ROOT_ID + " .hcx-2col{display:flex;gap:10px;}",
      "#" + ROOT_ID + " .hcx-2col > *{flex:1;}",
      "#" + ROOT_ID + " .hcx-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-text);font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;}",
      "#" + ROOT_ID + " .hcx-btn svg{width:16px;height:16px;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-btn.primary{background:var(--hcx-primary);border-color:var(--hcx-primary);color:#fff;}",
      "#" + ROOT_ID + " .hcx-btn:disabled{opacity:.55;cursor:default;}",
      "#" + ROOT_ID + " .hcx-picklist{max-height:230px;overflow-y:auto;border:1px solid var(--hcx-border);border-radius:11px;}",
      "#" + ROOT_ID + " .hcx-pick{display:flex;align-items:center;gap:11px;padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--hcx-border);}",
      "#" + ROOT_ID + " .hcx-pick:last-child{border-bottom:none;}",
      "#" + ROOT_ID + " .hcx-pick:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-pick .hcx-mid{flex:1;min-width:0;}",
      "#" + ROOT_ID + " .hcx-pick .hcx-rn{font-size:13.5px;font-weight:600;color:var(--hcx-text);overflow:hidden;text-overflow:ellipsis;}",
      "#" + ROOT_ID + " .hcx-pick .hcx-rl{font-size:12px;color:var(--hcx-muted);overflow:hidden;text-overflow:ellipsis;margin-top:1px;}",
      "#" + ROOT_ID + " .hcx-pick .hcx-cbx{width:20px;height:20px;border:2px solid var(--hcx-border);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-pick.sel .hcx-cbx{background:var(--hcx-primary);border-color:var(--hcx-primary);color:#fff;}",
      "#" + ROOT_ID + " .hcx-pick .hcx-cbx svg{width:13px;height:13px;}",
      // members management
      "#" + ROOT_ID + " .hcx-admin-badge{display:inline-block;font-size:10px;font-weight:700;color:var(--hcx-primary);background:rgba(37,99,235,.12);padding:1px 6px;border-radius:99px;vertical-align:middle;}",
      "#" + ROOT_ID + " .hcx-mem-ctrls{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0;}",
      "#" + ROOT_ID + " .hcx-mini{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--hcx-border);background:var(--hcx-surface);color:var(--hcx-text);font-family:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;}",
      "#" + ROOT_ID + " .hcx-mini:hover{background:var(--hcx-hover);}",
      "#" + ROOT_ID + " .hcx-mini.danger{color:#ef4444;border-color:rgba(239,68,68,.4);}",
      "#" + ROOT_ID + " .hcx-hint{font-size:12.5px;color:var(--hcx-muted);background:var(--hcx-bg);border:1px solid var(--hcx-border);border-radius:9px;padding:8px 10px;margin-bottom:12px;}",

      // responsive
      "@media (max-width:820px){",
      "  #" + ROOT_ID + " .hcx-side{width:100%;min-width:0;position:absolute;inset:0;z-index:20;}",
      "  #" + ROOT_ID + ".show-convo .hcx-side{display:none;}",
      "  #" + ROOT_ID + " .hcx-main{width:100%;}",
      "  #" + ROOT_ID + " .hcx-iconbtn.back{display:flex;}",
      "  #" + ROOT_ID + " .hcx-head .hcx-hm{max-width:60vw;}",
      "}",
    ].join("\n");
    var el = document.createElement("style");
    el.id = "hcx-styles";
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ───────────────────────────────────────────── mount / lifecycle
  function getPage() {
    return document.getElementById(PAGE_ID);
  }

  function boot() {
    var page = getPage();
    if (!page) return; // route not active
    injectStyles();
    state.me = getSession();

    // Already rendered into this page? keep it.
    if (page.querySelector("#" + ROOT_ID)) return;
    page.innerHTML = "";

    if (!state.me.email) {
      page.innerHTML =
        '<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#64748b;padding:24px;text-align:center;">' +
        "<div><h3 style=\"margin:0 0 6px;color:#0f172a;\">Please sign in</h3>" +
        "<p style=\"margin:0;font-size:14px;\">Your session was not found — log in again to use chat.</p></div></div>";
      return;
    }

    var root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = layoutHTML();
    page.appendChild(root);
    state.root = root;

    wireEvents(root);
    fitLayout();
    // Re-fit a few times while the shell (top bar) finishes mounting, and on
    // every window resize.
    requestAnimationFrame(fitLayout);
    setTimeout(fitLayout, 150);
    setTimeout(fitLayout, 500);
    if (!state._fitBound) {
      state._fit = function () { fitLayout(); };
      window.addEventListener("resize", state._fit);
      state._fitBound = true;
    }
    loadContacts();
    loadRooms();
    observeUnmount(page);
    state.booted = true;
  }

  // Pin the chat panel to the real content area: below the app top bar and to
  // the right of the nav rail — instead of the raw 100vh the route container
  // is given (which tucks the top of the chat behind the fixed top bar).
  function fitLayout() {
    var page = getPage();
    if (!page || !state.root) return;
    var top = 0;
    var bar = document.querySelector(".topbar");
    if (bar) {
      var br = bar.getBoundingClientRect();
      if (br.height && br.bottom > 0) top = br.bottom;
    }
    var prect = page.getBoundingClientRect();
    var left = Math.max(0, prect.left);
    var h = Math.max(320, window.innerHeight - top);
    var w = Math.max(320, window.innerWidth - left);
    var s = state.root.style;
    s.position = "fixed";
    s.inset = "auto";
    s.top = top + "px";
    s.left = left + "px";
    s.width = w + "px";
    s.height = h + "px";
    // Neutralise the container's inline height:100vh so it doesn't reserve a
    // full extra viewport behind the fixed panel.
    page.style.height = h + "px";
    page.style.overflow = "hidden";
  }

  // When the route changes the React app removes #hrms-chat-page. Detect that
  // and clean up the WebSocket / timers.
  function observeUnmount(page) {
    var obs = new MutationObserver(function () {
      if (!document.body.contains(page)) {
        teardownWS();
        if (state.listening) stopDictation();
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state._fit) {
          window.removeEventListener("resize", state._fit);
          state._fit = null;
          state._fitBound = false;
        }
        state.booted = false;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function layoutHTML() {
    return (
      '<div class="hcx-side">' +
      '  <div class="hcx-side-top">' +
      '    <div class="hcx-title">' +
      '      <span class="hcx-logo">' + ICON.chat + "</span>" +
      "      <div><h2>Chat</h2><p>Team messaging</p></div>" +
      '      <button class="hcx-newbtn" data-act="new-menu" title="New chat / channel">' + ICON.plus + "</button>" +
      "    </div>" +
      '    <div class="hcx-tabs">' +
      '      <button class="hcx-tab on" data-tab="direct">' + ICON.chat + " Direct</button>" +
      '      <button class="hcx-tab" data-tab="channels">' + ICON.hash + " Channels</button>" +
      "    </div>" +
      "  </div>" +
      '  <div class="hcx-searchwrap"><div class="hcx-searchbox">' + ICON.search +
      '    <input type="search" placeholder="Search…" data-role="search" autocomplete="off"></div></div>' +
      '  <div class="hcx-list" data-role="list"><div class="hcx-empty">Loading…</div></div>' +
      "</div>" +
      '<div class="hcx-main" data-role="main">' + welcomeHTML() + "</div>"
    );
  }

  function welcomeHTML() {
    return (
      '<div class="hcx-welcome">' +
      '<div class="ic">' + ICON.chat + "</div>" +
      "<h3>Welcome to Team Chat</h3>" +
      "<p>Select a conversation on the left, or start a new direct message or channel with the + button.</p>" +
      "</div>"
    );
  }

  // ───────────────────────────────────────────── data loads
  function loadContacts() {
    state.loadingContacts = true;
    apiGet("/api/chat/contacts?email=" + encodeURIComponent(state.me.email))
      .then(function (list) {
        state.contacts = Array.isArray(list) ? list : [];
      })
      .catch(function (e) {
        console.warn("[hcx] contacts load failed", e);
        state.contacts = [];
      })
      .then(function () {
        state.loadingContacts = false;
      });
  }

  function loadRooms() {
    state.loadingRooms = true;
    apiGet("/api/chat/rooms?email=" + encodeURIComponent(state.me.email))
      .then(function (list) {
        state.rooms = Array.isArray(list) ? list : [];
      })
      .catch(function (e) {
        console.warn("[hcx] rooms load failed", e);
        state.rooms = [];
      })
      .then(function () {
        state.loadingRooms = false;
        renderList();
      });
  }

  function roomsForTab() {
    var wantGroup = state.tab === "channels";
    var q = state.search.toLowerCase().trim();
    return state.rooms.filter(function (r) {
      if (!!r.is_group !== wantGroup) return false;
      if (!q) return true;
      var name = (r.display_name || r.name || "").toLowerCase();
      var members = (r.member_emails || []).join(" ").toLowerCase();
      return name.indexOf(q) !== -1 || members.indexOf(q) !== -1;
    });
  }

  function renderList() {
    if (!state.root) return;
    var list = state.root.querySelector('[data-role="list"]');
    if (!list) return;
    var rooms = roomsForTab();

    if (!rooms.length) {
      var msg =
        state.tab === "channels"
          ? "No channels yet.<small>Create one with the + button.</small>"
          : "No direct chats yet.<small>Start one with the + button.</small>";
      list.innerHTML = '<div class="hcx-empty">' + msg + "</div>";
      return;
    }

    list.innerHTML = rooms
      .map(function (r) {
        var isCh = !!r.is_group;
        var name = r.display_name || r.name || "Chat";
        var av = isCh
          ? '<span class="hcx-av ch">' + ICON.hash + "</span>"
          : avatarHTML(name, r.other_email || name, memberPic(r, r.other_email));
        var last = r.last_message
          ? (r.last_sender && r.last_sender === state.me.email ? "You: " : "") + r.last_message
          : isCh
          ? (r.member_emails || []).length + " members"
          : "Say hello 👋";
        var time = r.last_time ? relTime(r.last_time) : "";
        var badge = r.unread > 0 ? '<span class="hcx-badge">' + r.unread + "</span>" : "";
        return (
          '<div class="hcx-row' + (r.id === state.activeRoomId ? " on" : "") + '" data-room="' + r.id + '">' +
          av +
          '<div class="hcx-mid"><div class="hcx-rn">' + esc(name) + '</div><div class="hcx-rl">' + esc(last) + "</div></div>" +
          '<div class="hcx-right"><span class="hcx-rt">' + esc(time) + "</span>" + badge + "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  function memberPic(room, email) {
    var m = (room.members || []).find(function (x) { return x.email === email; });
    return m ? m.profilePic : "";
  }

  // ───────────────────────────────────────────── open room
  function openRoom(roomId) {
    var room = state.rooms.find(function (r) { return String(r.id) === String(roomId); });
    if (!room) return;
    state.activeRoomId = room.id;
    state.activeRoom = room;
    room.unread = 0;
    state.messages = [];
    state.meetings = [];
    state.knownIds = {};
    state.pending = [];
    state.editingId = null;
    state.msgSearch = { q: "", matches: [], idx: -1 };
    if (state.listening) stopDictation();

    renderConversation(room);
    renderList();
    if (state.root) state.root.classList.add("show-convo");

    loadMessages(room.id);
    loadMeetings(room.id);
    connectWS(room.id);
  }

  function renderConversation(room) {
    var main = state.root.querySelector('[data-role="main"]');
    if (!main) return;
    var isCh = !!room.is_group;
    var name = room.display_name || room.name || "Chat";
    var sub = isCh
      ? (room.member_emails || []).length + " members"
      : memberInfo(room, room.other_email);
    // A direct conversation is with a person, so say where that person is.
    // hrms-status.js fills this in and keeps it current; it stays empty for
    // anyone the presence feed has nothing to say about.
    var presence = (!isCh && room.other_email)
      ? ' <span class="hcx-hstatus" data-hrms-presence-label="' + esc(room.other_email) + '"></span>'
      : "";
    var av = isCh
      ? '<span class="hcx-av lg ch">' + ICON.hash + "</span>"
      : avatarHTML(name, room.other_email || name, memberPic(room, room.other_email), "lg");

    var membersBtn = isCh
      ? '<button class="hcx-hicon" data-act="members" title="Members">' + ICON.people + "</button>"
      : "";

    main.innerHTML =
      '<div class="hcx-head">' +
      '  <button class="hcx-iconbtn back" data-act="back" title="Back">' + ICON.back + "</button>" +
      av +
      '  <div class="hcx-hinfo"><div class="hcx-hn">' + esc(name) + '</div><div class="hcx-hm">' + esc(sub) + presence + "</div></div>" +
      '  <button class="hcx-hicon" data-act="search-toggle" title="Search in conversation">' + ICON.search + "</button>" +
      membersBtn +
      '  <button class="hcx-hbtn primary" data-act="schedule">' + ICON.calendar + " Schedule meeting</button>" +
      '  <div class="hcx-menuwrap"><button class="hcx-hicon" data-act="room-menu" title="More">' + ICON.dots + "</button>" +
      '    <div class="hcx-menu" data-role="room-menu" style="display:none"></div></div>' +
      "</div>" +
      '<div class="hcx-searchbar" data-role="searchbar" style="display:none">' +
      '  <span class="si">' + ICON.search + "</span>" +
      '  <input type="search" data-role="msg-search" placeholder="Search messages…" autocomplete="off">' +
      '  <span class="hcx-search-count" data-role="search-count"></span>' +
      '  <button class="hcx-search-nav" data-act="search-prev" title="Previous">↑</button>' +
      '  <button class="hcx-search-nav" data-act="search-next" title="Next">↓</button>' +
      '  <button class="hcx-search-nav" data-act="search-close" title="Close">' + ICON.close + "</button>" +
      "</div>" +
      '<div class="hcx-mtg-strip" data-role="mtgs" style="display:none"></div>' +
      '<div class="hcx-area" data-role="area"><div class="hcx-empty">Loading messages…</div></div>' +
      '<div class="hcx-inbar"><div class="hcx-inwrap">' +
      '  <input type="file" data-role="file" accept="*/*" style="display:none">' +
      '  <button class="hcx-attachbtn" data-act="attach" title="Attach a file">' + ICON.attach + "</button>" +
      '  <button class="hcx-attachbtn" data-act="mic" data-role="mic" title="Dictate (speech to text)">' + ICON.mic + "</button>" +
      '  <textarea data-role="input" rows="1" placeholder="Type a message…"></textarea>' +
      '  <button class="hcx-sendbtn" data-act="send">' + ICON.send + "</button>" +
      "</div></div>";

    var input = main.querySelector('[data-role="input"]');
    if (input) input.focus();
  }

  function memberInfo(room, email) {
    var m = (room.members || []).find(function (x) { return x.email === email; });
    if (!m) return email || "";
    var bits = [];
    if (m.designation) bits.push(m.designation);
    if (m.department) bits.push(m.department);
    return bits.length ? bits.join(" · ") : m.email;
  }

  // ───────────────────────────────────────────── messages
  function loadMessages(roomId) {
    apiGet("/api/chat/messages/" + roomId + "?email=" + encodeURIComponent(state.me.email))
      .then(function (list) {
        if (String(state.activeRoomId) !== String(roomId)) return;
        state.messages = Array.isArray(list) ? list : [];
        state.knownIds = {};
        state.messages.forEach(function (m) {
          stampMsg(m);
          if (m.id != null) state.knownIds["id_" + m.id] = true;
        });
        renderMessages();
        startPolling(roomId);
      })
      .catch(function (e) {
        console.warn("[hcx] messages load failed", e);
        var area = areaEl();
        if (area) area.innerHTML = '<div class="hcx-empty">Could not load messages.</div>';
      });
  }

  function areaEl() {
    return state.root ? state.root.querySelector('[data-role="area"]') : null;
  }

  function renderMessages() {
    var area = areaEl();
    if (!area) return;
    // Preserve in-progress edit text across background re-renders (polling/WS).
    var editVal = null;
    if (state.editingId != null) {
      var ta0 = area.querySelector('[data-role="edit-input"]');
      if (ta0) editVal = ta0.value;
    }
    if (!state.messages.length) {
      area.innerHTML = '<div class="hcx-empty" style="margin:auto">No messages yet. Say hello! 👋</div>';
      return;
    }
    var html = "";
    var curDay = null;
    var prevSender = null;
    var isCh = state.activeRoom && !!state.activeRoom.is_group;
    state.messages.forEach(function (m) {
      var d = dayLabelOf(msgDate(m));
      if (d !== curDay) {
        curDay = d;
        html += '<div class="hcx-sep"><span class="l"></span><span class="t">' + esc(d) + '</span><span class="l"></span></div>';
        prevSender = null;
      }
      html += messageHTML(m, isCh, prevSender === m.sender_email);
      prevSender = m.sender_email;
    });
    area.innerHTML = html;
    if (state.editingId != null && editVal != null) {
      var ta1 = area.querySelector('[data-role="edit-input"]');
      if (ta1) { ta1.value = editVal; ta1.focus(); }
    }
    reapplySearchHighlights();
    scrollBottom();
  }

  function reapplySearchHighlights() {
    var s = state.msgSearch;
    if (!s || !s.q || !s.matches || !s.matches.length) return;
    s.matches.forEach(function (id, i) {
      var row = state.root.querySelector('.hcx-msg[data-mid="' + id + '"]');
      if (row) {
        row.classList.add("match");
        if (i === s.idx) row.classList.add("match-current");
      }
    });
  }

  function attachmentHTML(m) {
    var url = m.attachment_url;
    if (!url) return "";
    var type = m.attachment_type || "";
    var name = m.attachment_name || "file";
    if (type.indexOf("image/") === 0) {
      return '<img class="hcx-att-img" src="' + esc(url) + '" alt="' + esc(name) +
        '" data-act="lightbox" data-src="' + esc(url) + '">';
    }
    if (type.indexOf("video/") === 0) {
      return '<video class="hcx-att-video" src="' + esc(url) + '" controls preload="metadata"></video>';
    }
    if (type.indexOf("audio/") === 0) {
      return '<audio class="hcx-att-audio" src="' + esc(url) + '" controls preload="metadata"></audio>';
    }
    return (
      '<a class="hcx-att-file" href="' + esc(url) + '" target="_blank" rel="noopener" download="' + esc(name) + '">' +
      '<span class="fi">' + ICON.file + "</span>" +
      '<span class="fn">' + esc(name) + "</span>" +
      '<span class="dl">' + ICON.download + "</span></a>"
    );
  }

  function messageHTML(m, isCh, consecutive) {
    var sent = m.sender_email === state.me.email;
    var name = m.sender_name || (m.sender_email || "").split("@")[0];
    var av = sent ? "" : avatarHTML(name, m.sender_email, "", "sm");
    var senderLabel = !sent && isCh && !consecutive ? '<div class="hcx-sender">' + esc(name) + "</div>" : "";
    var rowAttr = (m.id != null ? ' data-mid="' + m.id + '"' : "");

    // Deleted placeholder
    if (m.is_deleted) {
      return (
        '<div class="hcx-msg ' + (sent ? "sent" : "recv") + '"' + rowAttr + ">" + av +
        '<div class="hcx-bubble deleted">' + senderLabel + "This message was deleted" +
        '<div class="hcx-meta"><span class="tm">' + esc(fmtTimeOf(msgDate(m))) + "</span></div></div></div>"
      );
    }

    // Inline edit mode
    if (sent && state.editingId != null && String(state.editingId) === String(m.id)) {
      return (
        '<div class="hcx-msg sent"' + rowAttr + ">" +
        '<div class="hcx-bubble"><div class="hcx-editwrap">' +
        '<textarea data-role="edit-input">' + esc(m.message) + "</textarea>" +
        '<div class="hcx-editrow">' +
        '<button data-act="edit-cancel">Cancel</button>' +
        '<button class="primary" data-act="edit-save">Save</button>' +
        "</div></div></div></div>"
      );
    }

    var tick = "";
    if (sent) {
      var cls = m.is_read ? "hcx-tick read" : "hcx-tick";
      tick = '<span class="' + cls + '">' + (m.is_read ? ICON.check2 : ICON.check1) + "</span>";
    }
    var editedLabel = m.edited ? '<span class="hcx-edited">edited</span>' : "";
    var body = attachmentHTML(m) + (m.message ? linkify(m.message) : "");

    // Own messages get hover actions: edit (text only) + delete — but only
    // within the edit/delete time window.
    var actions = "";
    if (sent && m.id != null && withinEditWindow(m)) {
      var editBtn = m.message
        ? '<button class="hcx-actbtn" data-act="msg-edit" title="Edit">' + ICON.edit + "</button>"
        : "";
      actions =
        '<div class="hcx-actions">' + editBtn +
        '<button class="hcx-actbtn danger" data-act="msg-delete" title="Delete">' + ICON.trash + "</button></div>";
    }

    return (
      '<div class="hcx-msg ' + (sent ? "sent" : "recv") + (consecutive ? " cons" : "") + '"' + rowAttr + ">" +
      av +
      '<div class="hcx-bubble">' + senderLabel + body +
      '<div class="hcx-meta">' + editedLabel + '<span class="tm">' + esc(fmtTimeOf(msgDate(m))) + "</span>" + tick + "</div>" +
      "</div>" + actions + "</div>"
    );
  }

  function scrollBottom() {
    var area = areaEl();
    if (area) requestAnimationFrame(function () { area.scrollTop = area.scrollHeight; });
  }

  function ingestMessage(m) {
    // De-dupe by real id.
    if (m.id != null && state.knownIds["id_" + m.id]) return;
    // Reconcile an optimistic (pending) message that this echoes.
    if (m.sender_email === state.me.email) {
      for (var i = 0; i < state.pending.length; i++) {
        var p = state.pending[i];
        if (p.message === (m.message || "") && (p.att || "") === (m.attachment_name || "")) {
          var idx = state.messages.indexOf(p.ref);
          if (idx !== -1) state.messages[idx] = stampMsg(m);
          state.pending.splice(i, 1);
          if (m.id != null) state.knownIds["id_" + m.id] = true;
          renderMessages();
          return;
        }
      }
    }
    if (m.id != null) state.knownIds["id_" + m.id] = true;
    state.messages.push(stampMsg(m));
    renderMessages();
    bumpRoomPreview(state.activeRoomId, m);
  }

  function applyEdit(id, text) {
    var m = state.messages.find(function (x) { return String(x.id) === String(id); });
    if (m) {
      m.message = text;
      m.edited = true;
      renderMessages();
      refreshLastPreview();
    }
  }

  function applyDelete(id) {
    var m = state.messages.find(function (x) { return String(x.id) === String(id); });
    if (m) {
      m.is_deleted = true;
      m.message = "";
      m.attachment_url = "";
      renderMessages();
      refreshLastPreview();
    }
  }

  // Keep the sidebar's last-message preview in sync after an edit/delete.
  function refreshLastPreview() {
    if (!state.messages.length) return;
    bumpRoomPreview(state.activeRoomId, state.messages[state.messages.length - 1]);
  }

  function previewText(m) {
    if (m.is_deleted) return "This message was deleted";
    if (m.message) return m.message;
    if (m.attachment_name) return "📎 " + m.attachment_name;
    return "";
  }

  function bumpRoomPreview(roomId, m) {
    var r = state.rooms.find(function (x) { return String(x.id) === String(roomId); });
    if (r) {
      r.last_message = previewText(m);
      r.last_sender = m.sender_email;
      r.last_time = m.created_at;
      renderList();
    }
  }

  // ───────────────────────────────────────────── send
  function sendMessage() {
    var input = state.root.querySelector('[data-role="input"]');
    if (!input || !state.activeRoomId) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    autoresize(input);
    resetDictationBuffer();

    var now = new Date().toISOString();
    var temp = {
      id: null,
      sender_email: state.me.email,
      sender_name: state.me.name || state.me.email.split("@")[0],
      message: text,
      created_at: now,
      is_read: false,
    };
    stampMsg(temp);
    state.messages.push(temp);
    state.pending.push({ message: text, att: "", ref: temp });
    renderMessages();
    bumpRoomPreview(state.activeRoomId, temp);

    // Prefer WebSocket; fall back to REST when the socket isn't open.
    if (state.ws && state.ws.readyState === 1 && String(state.wsRoomId) === String(state.activeRoomId)) {
      try {
        state.ws.send(JSON.stringify({
          sender_email: state.me.email,
          sender_name: temp.sender_name,
          message: text,
        }));
        return;
      } catch (_) {}
    }
    // REST fallback
    apiPost("/api/chat/messages/" + state.activeRoomId, {
      sender_email: state.me.email,
      sender_name: temp.sender_name,
      message: text,
    })
      .then(function (saved) { reconcileSaved(temp, saved); })
      .catch(function (e) { console.warn("[hcx] send failed", e); });
  }

  function reconcileSaved(temp, saved) {
    var i = state.pending.findIndex(function (p) { return p.ref === temp; });
    if (i !== -1) state.pending.splice(i, 1);
    var idx = state.messages.indexOf(temp);
    if (idx !== -1 && saved && saved.id != null) {
      state.messages[idx] = stampMsg(saved);
      state.knownIds["id_" + saved.id] = true;
      renderMessages();
    }
  }

  // How long after sending a message it can still be edited/deleted.
  // Keep this in sync with CHAT_EDIT_WINDOW in api/views.py.
  var EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  // Stamp a message with a timezone-proof age reference the moment it enters
  // our state: the server tells us how old it was (age_seconds), and we record
  // when we received it. Everything after is duration math — no wall-clock
  // comparison across the server/browser timezone gap.
  function stampMsg(m) {
    if (!m) return m;
    m._recvAt = new Date().getTime();
    m._ageMs = (typeof m.age_seconds === "number") ? m.age_seconds * 1000 : 0;
    return m;
  }

  function msgAgeMs(m) {
    var base = (m && typeof m._ageMs === "number") ? m._ageMs : 0;
    var since = (m && m._recvAt) ? (new Date().getTime() - m._recvAt) : 0;
    return base + since;
  }

  // The message's real moment, rendered in the browser's own timezone.
  function msgDate(m) {
    if (m && typeof m._recvAt === "number" && typeof m._ageMs === "number") {
      return new Date(m._recvAt - m._ageMs);
    }
    return parseDate(m && m.created_at);
  }

  function withinEditWindow(m) {
    if (!m || m.id == null || m.is_deleted) return false;
    return msgAgeMs(m) < EDIT_WINDOW_MS;
  }

  // Remove edit/delete buttons from messages whose window has closed, without a
  // full re-render (so scroll position is untouched).
  function pruneExpiredActions() {
    if (!state.root) return;
    var rows = state.root.querySelectorAll(".hcx-msg[data-mid]");
    rows.forEach(function (row) {
      var acts = row.querySelector(".hcx-actions");
      if (acts && !withinEditWindow(findMsgById(row.getAttribute("data-mid")))) {
        acts.remove();
      }
    });
  }

  function findMsgById(id) {
    return state.messages.find(function (x) { return String(x.id) === String(id); });
  }

  // ───────────────────────────────────────────── file sharing
  var MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB (covers short videos, PDFs, etc.)

  function handleFilePick(fileInput) {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // allow re-selecting the same file later
    if (!file || !state.activeRoomId) return;
    if (file.size > MAX_FILE_BYTES) {
      alert("File is too large. Please choose a file under 50 MB.");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      sendFile(file, reader.result); // result is a data: URL
    };
    reader.onerror = function () { alert("Could not read that file."); };
    reader.readAsDataURL(file);
  }

  function sendFile(file, dataUrl) {
    var input = state.root.querySelector('[data-role="input"]');
    var caption = input ? input.value.trim() : "";
    if (input) { input.value = ""; autoresize(input); resetDictationBuffer(); }

    var now = new Date().toISOString();
    var temp = {
      id: null,
      sender_email: state.me.email,
      sender_name: state.me.name || state.me.email.split("@")[0],
      message: caption,
      created_at: now,
      is_read: false,
      attachment_name: file.name,
      attachment_type: file.type || "application/octet-stream",
      attachment_url: dataUrl, // local preview until the server confirms
    };
    stampMsg(temp);
    state.messages.push(temp);
    state.pending.push({ message: caption, att: file.name, ref: temp });
    renderMessages();
    bumpRoomPreview(state.activeRoomId, temp);

    // Files always go via REST (the socket path handles text only).
    apiPost("/api/chat/messages/" + state.activeRoomId, {
      sender_email: state.me.email,
      sender_name: temp.sender_name,
      message: caption,
      attachment_name: file.name,
      attachment_type: temp.attachment_type,
      attachment_data: dataUrl,
    })
      .then(function (saved) { reconcileSaved(temp, saved); })
      .catch(function (e) {
        console.warn("[hcx] file send failed", e);
        alert("Could not send file: " + e.message);
      });
  }

  // ───────────────────────────────────────────── edit / delete
  function findMsg(id) {
    return state.messages.find(function (x) { return String(x.id) === String(id); });
  }

  function windowExpiredAlert() {
    alert("The " + Math.round(EDIT_WINDOW_MS / 60000) + "-minute window for editing or deleting this message has passed.");
  }

  function startEdit(id) {
    var m = findMsg(id);
    if (!withinEditWindow(m)) { windowExpiredAlert(); renderMessages(); return; }
    state.editingId = id;
    renderMessages();
    var ta = state.root.querySelector('[data-role="edit-input"]');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function cancelEdit() {
    state.editingId = null;
    renderMessages();
  }

  function saveEdit() {
    var ta = state.root.querySelector('[data-role="edit-input"]');
    if (!ta) return;
    var id = state.editingId;
    var text = ta.value.trim();
    if (!text) { alert("Message can't be empty. Use delete to remove it."); return; }
    state.editingId = null;
    applyEdit(id, text); // optimistic
    apiFetch("PUT", "/api/chat/message/" + id, { message: text, email: state.me.email })
      .catch(function (e) {
        console.warn("[hcx] edit failed", e);
        alert("Could not edit message: " + e.message);
        loadMessages(state.activeRoomId);
      });
  }

  function deleteMessage(id) {
    if (!withinEditWindow(findMsg(id))) { windowExpiredAlert(); renderMessages(); return; }
    if (!confirm("Delete this message?")) return;
    applyDelete(id); // optimistic
    apiFetch("DELETE", "/api/chat/message/" + id, { email: state.me.email })
      .then(function () {
        // The message may have announced a meeting that got cancelled too.
        loadMeetings(state.activeRoomId);
      })
      .catch(function (e) {
        console.warn("[hcx] delete failed", e);
        alert("Could not delete message: " + e.message);
        loadMessages(state.activeRoomId);
      });
  }

  function cancelMeeting(id) {
    if (!id) return;
    if (!confirm("Cancel this meeting? The Join link will be removed.")) return;
    apiFetch("DELETE", "/api/chat/meetings/" + id, { email: state.me.email })
      .then(function () {
        state.meetings = (state.meetings || []).filter(function (m) { return String(m.id) !== String(id); });
        renderMeetings();
      })
      .catch(function (e) { alert("Could not cancel meeting: " + e.message); });
  }

  function apiFetch(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.message) || method + " " + path + " → " + r.status);
        return data;
      });
    });
  }

  // ───────────────────────────────────────────── websocket
  function connectWS(roomId) {
    teardownWS();
    try {
      var proto = location.protocol === "https:" ? "wss" : "ws";
      var url = proto + "://" + location.host + "/ws/chat/" + roomId + "/";
      var ws = new WebSocket(url);
      state.ws = ws;
      state.wsRoomId = roomId;
      ws.onmessage = function (ev) {
        if (String(state.activeRoomId) !== String(roomId)) return;
        try {
          var data = JSON.parse(ev.data);
          if (!data) return;
          if (data.event === "deleted") { applyDelete(data.id); return; }
          if (data.event === "edited") { applyEdit(data.id, data.message || ""); return; }
          if (data.message != null || data.attachment_url) ingestMessage(data);
        } catch (_) {}
      };
      ws.onclose = function () {
        if (state.ws === ws) { state.ws = null; }
      };
      ws.onerror = function () {
        // REST fallback + polling already cover this; just log.
        console.warn("[hcx] websocket error — using REST fallback");
      };
    } catch (e) {
      console.warn("[hcx] websocket unavailable — using REST polling", e);
      state.ws = null;
    }
  }

  function teardownWS() {
    if (state.ws) {
      try { state.ws.onmessage = null; state.ws.close(); } catch (_) {}
    }
    state.ws = null;
    state.wsRoomId = null;
  }

  // Poll as a safety net (covers hosts where WebSockets don't run). De-dupes by id.
  function startPolling(roomId) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (String(state.activeRoomId) !== String(roomId)) return;
      pruneExpiredActions();
      renderMeetings(); // drop the Join button once a meeting has ended
      // If WS is healthy we still poll slowly to catch read-receipts.
      apiGet("/api/chat/messages/" + roomId + "?email=" + encodeURIComponent(state.me.email))
        .then(function (list) {
          if (!Array.isArray(list) || String(state.activeRoomId) !== String(roomId)) return;
          var added = false;
          var byId = {};
          state.messages.forEach(function (x) { if (x.id != null) byId[String(x.id)] = x; });
          list.forEach(function (m) {
            if (m.id == null) return;
            if (!state.knownIds["id_" + m.id]) {
              // New message. Skip if it reconciles a pending optimistic one.
              if (m.sender_email === state.me.email) {
                var pi = state.pending.findIndex(function (p) {
                  return p.message === (m.message || "") && (p.att || "") === (m.attachment_name || "");
                });
                if (pi !== -1) {
                  var idx = state.messages.indexOf(state.pending[pi].ref);
                  if (idx !== -1) state.messages[idx] = stampMsg(m);
                  state.pending.splice(pi, 1);
                  state.knownIds["id_" + m.id] = true;
                  added = true;
                  return;
                }
              }
              state.knownIds["id_" + m.id] = true;
              state.messages.push(stampMsg(m));
              added = true;
            } else {
              // Existing message — sync edited/deleted/read changes.
              var cur = byId[String(m.id)];
              if (cur && (cur.is_deleted !== m.is_deleted || cur.edited !== m.edited ||
                          cur.message !== m.message || cur.is_read !== m.is_read)) {
                cur.is_deleted = m.is_deleted;
                cur.edited = m.edited;
                cur.message = m.message;
                cur.is_read = m.is_read;
                if (m.is_deleted) cur.attachment_url = "";
                added = true;
              }
            }
          });
          if (added) {
            state.messages.sort(function (a, b) {
              return (parseDate(a.created_at) || 0) - (parseDate(b.created_at) || 0);
            });
            renderMessages();
          }
        })
        .catch(function () {});
    }, 5000);
  }

  // ───────────────────────────────────────────── meetings
  function loadMeetings(roomId) {
    apiGet("/api/chat/meetings?room_id=" + roomId)
      .then(function (list) {
        if (String(state.activeRoomId) !== String(roomId)) return;
        state.meetings = Array.isArray(list) ? list : [];
        renderMeetings();
      })
      .catch(function (e) { console.warn("[hcx] meetings load failed", e); });
  }

  function renderMeetings() {
    if (!state.root) return;
    var strip = state.root.querySelector('[data-role="mtgs"]');
    if (!strip) return;
    var now = new Date().getTime();
    var upcoming = (state.meetings || [])
      .filter(function (m) {
        var d = parseDate(m.scheduled_at);
        if (!d) return false;
        var durMs = (parseInt(m.duration_minutes, 10) || 30) * 60000;
        // Show until the meeting's end time; hide once it's over.
        return d.getTime() + durMs > now;
      })
      .sort(function (a, b) { return parseDate(a.scheduled_at) - parseDate(b.scheduled_at); })
      .slice(0, 3);
    if (!upcoming.length) {
      strip.style.display = "none";
      strip.innerHTML = "";
      return;
    }
    strip.style.display = "flex";
    strip.innerHTML = upcoming
      .map(function (m) {
        var d = parseDate(m.scheduled_at);
        var when = d
          ? d.toLocaleDateString([], { day: "numeric", month: "short" }) +
            ", " +
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";
        var canCancel = (m.created_by && m.created_by === state.me.email) ||
          (state.activeRoom && state.activeRoom.viewer_is_admin);
        var cancelBtn = canCancel
          ? '<button class="hcx-mtg-x" data-act="cancel-meeting" data-mid="' + m.id + '" title="Cancel meeting">' + ICON.close + "</button>"
          : "";
        return (
          '<div class="hcx-mtg-card">' +
          '<span class="hcx-mtg-ic">' + ICON.calendar + "</span>" +
          '<div class="hcx-mid"><div class="hcx-mtg-t">' + esc(m.title) + '</div><div class="hcx-mtg-s">' + esc(when) +
          (m.duration_minutes ? " · " + m.duration_minutes + " min" : "") + "</div></div>" +
          (m.join_url
            ? '<a class="hcx-join" href="' + esc(joinUrlWithName(m.join_url)) + '" target="_blank" rel="noopener">' + ICON.video + " Join</a>"
            : "") +
          cancelBtn +
          "</div>"
        );
      })
      .join("");
  }

  // Jitsi reads #userInfo.displayName from the URL fragment, so the user joins
  // with their name pre-filled. (Video, audio and screen-share are built into
  // meet.jit.si — no extra setup needed.)
  function joinUrlWithName(url) {
    if (!url || url.indexOf("meet.jit.si") === -1) return url;
    if (url.indexOf("#userInfo") !== -1) return url;
    var nm = state.me.name || (state.me.email || "").split("@")[0];
    if (!nm) return url;
    return url + '#userInfo.displayName=%22' + encodeURIComponent(nm) + '%22';
  }

  // ───────────────────────────────────────────── modals
  function closeModal() {
    var m = state.root.querySelector(".hcx-modal-bg");
    if (m) m.remove();
  }

  function openModal(innerHTML) {
    closeModal();
    var bg = document.createElement("div");
    bg.className = "hcx-modal-bg";
    bg.innerHTML = '<div class="hcx-modal">' + innerHTML + "</div>";
    bg.addEventListener("click", function (e) {
      if (e.target === bg) closeModal();
    });
    state.root.appendChild(bg);
    return bg;
  }

  // New: choose direct chat or channel
  function openNewMenu() {
    var html =
      '<div class="hcx-modal-h"><h3>Start something new</h3>' +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b">' +
      '<div class="hcx-picklist">' +
      '<div class="hcx-pick" data-act="pick-direct"><span class="hcx-av sm" style="background:#2563eb">' + '@' + '</span>' +
      '<div class="hcx-mid"><div class="hcx-rn">New direct message</div><div class="hcx-rl">Chat one-to-one with a colleague</div></div></div>' +
      '<div class="hcx-pick" data-act="pick-channel"><span class="hcx-av sm ch">' + ICON.hash + "</span>" +
      '<div class="hcx-mid"><div class="hcx-rn">New channel</div><div class="hcx-rl">Group conversation for a team or topic</div></div></div>' +
      "</div></div>";
    openModal(html);
  }

  // Direct message: pick a single contact
  function openNewDirect() {
    var rows = state.contacts
      .map(function (c) {
        return (
          '<div class="hcx-pick" data-email="' + esc(c.email) + '">' +
          avatarHTML(c.name, c.email, c.profilePic, "sm") +
          '<div class="hcx-mid"><div class="hcx-rn">' + esc(c.name) + '</div><div class="hcx-rl">' +
          esc([c.designation, c.department].filter(Boolean).join(" · ") || c.email) + "</div></div></div>"
        );
      })
      .join("");
    var html =
      '<div class="hcx-modal-h"><h3>New direct message</h3>' +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b">' +
      (rows
        ? '<div class="hcx-picklist" data-role="direct-list">' + rows + "</div>"
        : '<div class="hcx-empty">No colleagues found.</div>') +
      "</div>";
    var bg = openModal(html);
    bg.querySelectorAll(".hcx-pick").forEach(function (row) {
      row.addEventListener("click", function () {
        var email = row.getAttribute("data-email");
        startDirect(email);
      });
    });
  }

  function startDirect(email) {
    closeModal();
    apiPost("/api/chat/rooms", {
      type: "direct",
      members: [state.me.email, email],
      created_by: state.me.email,
    })
      .then(function (room) {
        upsertRoom(room);
        state.tab = "direct";
        syncTabs();
        openRoom(room.id);
      })
      .catch(function (e) {
        console.warn("[hcx] start direct failed", e);
        alert("Could not start chat: " + e.message);
      });
  }

  // Channel: name + multi-select members
  function openNewChannel() {
    var selected = {};
    var rows = state.contacts
      .map(function (c) {
        return (
          '<div class="hcx-pick" data-email="' + esc(c.email) + '">' +
          avatarHTML(c.name, c.email, c.profilePic, "sm") +
          '<div class="hcx-mid"><div class="hcx-rn">' + esc(c.name) + '</div><div class="hcx-rl">' +
          esc([c.designation, c.department].filter(Boolean).join(" · ") || c.email) + "</div></div>" +
          '<span class="hcx-cbx">' + ICON.check1 + "</span></div>"
        );
      })
      .join("");
    var html =
      '<div class="hcx-modal-h"><h3>New channel</h3>' +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b">' +
      '<div class="hcx-field"><label>Channel name</label>' +
      '<input class="hcx-input" data-role="ch-name" placeholder="e.g. Engineering, Design team"></div>' +
      '<div class="hcx-field"><label>Add members</label>' +
      (rows ? '<div class="hcx-picklist">' + rows + "</div>" : '<div class="hcx-empty">No colleagues found.</div>') +
      "</div></div>" +
      '<div class="hcx-modal-f">' +
      '<button class="hcx-btn" data-act="modal-close">Cancel</button>' +
      '<button class="hcx-btn primary" data-role="ch-create">Create channel</button></div>';
    var bg = openModal(html);
    bg.querySelectorAll(".hcx-pick").forEach(function (row) {
      row.addEventListener("click", function () {
        var email = row.getAttribute("data-email");
        if (selected[email]) { delete selected[email]; row.classList.remove("sel"); }
        else { selected[email] = true; row.classList.add("sel"); }
      });
    });
    bg.querySelector('[data-role="ch-create"]').addEventListener("click", function () {
      var name = (bg.querySelector('[data-role="ch-name"]').value || "").trim();
      if (!name) { alert("Please enter a channel name."); return; }
      var members = Object.keys(selected);
      members.push(state.me.email);
      createChannel(name, members, this);
    });
  }

  function createChannel(name, members, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
    apiPost("/api/chat/rooms", {
      type: "channel",
      name: name,
      members: members,
      created_by: state.me.email,
    })
      .then(function (room) {
        closeModal();
        upsertRoom(room);
        state.tab = "channels";
        syncTabs();
        openRoom(room.id);
      })
      .catch(function (e) {
        console.warn("[hcx] create channel failed", e);
        if (btn) { btn.disabled = false; btn.textContent = "Create channel"; }
        alert("Could not create channel: " + e.message);
      });
  }

  // Schedule meeting for the active room
  function openScheduleMeeting() {
    if (!state.activeRoom) return;
    var now = new Date();
    now.setMinutes(now.getMinutes() + 30 - (now.getMinutes() % 15));
    var dStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var tStr = pad(now.getHours()) + ":" + pad(now.getMinutes());
    var html =
      '<div class="hcx-modal-h"><h3>Schedule meeting</h3>' +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b">' +
      '<div class="hcx-field"><label>Title</label>' +
      '<input class="hcx-input" data-role="mt-title" placeholder="e.g. Sprint planning"></div>' +
      '<div class="hcx-2col">' +
      '<div class="hcx-field"><label>Date</label><input type="date" class="hcx-input" data-role="mt-date" value="' + dStr + '"></div>' +
      '<div class="hcx-field"><label>Time</label><input type="time" class="hcx-input" data-role="mt-time" value="' + tStr + '"></div>' +
      "</div>" +
      '<div class="hcx-field"><label>Duration</label><select class="hcx-input" data-role="mt-dur">' +
      "<option value=\"15\">15 minutes</option><option value=\"30\" selected>30 minutes</option>" +
      "<option value=\"45\">45 minutes</option><option value=\"60\">1 hour</option><option value=\"90\">1.5 hours</option></select></div>" +
      '<div class="hcx-field"><label>Notes (optional)</label><textarea class="hcx-input" data-role="mt-desc" placeholder="Agenda / details"></textarea></div>' +
      '<div class="hcx-field" style="margin-bottom:0"><label>A video link (meet.jit.si) is generated automatically and shared in the chat.</label></div>' +
      "</div>" +
      '<div class="hcx-modal-f">' +
      '<button class="hcx-btn" data-act="modal-close">Cancel</button>' +
      '<button class="hcx-btn primary" data-role="mt-create">Schedule</button></div>';
    var bg = openModal(html);
    bg.querySelector('[data-role="mt-create"]').addEventListener("click", function () {
      var title = (bg.querySelector('[data-role="mt-title"]').value || "").trim();
      var date = bg.querySelector('[data-role="mt-date"]').value;
      var time = bg.querySelector('[data-role="mt-time"]').value;
      var dur = bg.querySelector('[data-role="mt-dur"]').value;
      var desc = bg.querySelector('[data-role="mt-desc"]').value;
      if (!title) { alert("Please enter a meeting title."); return; }
      if (!date || !time) { alert("Please choose a date and time."); return; }
      scheduleMeeting({ title: title, scheduled_at: date + "T" + time, duration: dur, desc: desc }, this);
    });
  }

  function scheduleMeeting(data, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Scheduling…"; }
    apiPost("/api/chat/meetings", {
      room_id: state.activeRoomId,
      title: data.title,
      scheduled_at: data.scheduled_at,
      duration_minutes: parseInt(data.duration, 10) || 30,
      description: data.desc || "",
      created_by: state.me.email,
      created_by_name: state.me.name || state.me.email.split("@")[0],
    })
      .then(function () {
        closeModal();
        loadMeetings(state.activeRoomId);
        // The backend also posts an announcement message; refresh soon.
        setTimeout(function () { loadMessages(state.activeRoomId); }, 300);
      })
      .catch(function (e) {
        console.warn("[hcx] schedule failed", e);
        if (btn) { btn.disabled = false; btn.textContent = "Schedule"; }
        alert("Could not schedule meeting: " + e.message);
      });
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ───────────────────────────────────────────── rooms upsert / tabs
  function upsertRoom(room) {
    var i = state.rooms.findIndex(function (r) { return String(r.id) === String(room.id); });
    if (i === -1) state.rooms.unshift(room);
    else state.rooms[i] = room;
  }

  function syncTabs() {
    if (!state.root) return;
    state.root.querySelectorAll(".hcx-tab").forEach(function (t) {
      t.classList.toggle("on", t.getAttribute("data-tab") === state.tab);
    });
    renderList();
  }

  // ───────────────────────────────────────────── events
  function autoresize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 130) + "px";
  }

  function wireEvents(root) {
    // Delegated clicks
    root.addEventListener("click", function (e) {
      var t = e.target;
      var actEl = t.closest ? t.closest("[data-act]") : null;
      var act = actEl ? actEl.getAttribute("data-act") : null;

      // Close the room ⋯ menu on any click outside of it.
      if (!(t.closest && t.closest(".hcx-menuwrap"))) closeRoomMenu();

      if (act === "new-menu") return openNewMenu();
      if (act === "modal-close") return closeModal();
      if (act === "pick-direct") { closeModal(); return openNewDirect(); }
      if (act === "pick-channel") { closeModal(); return openNewChannel(); }
      if (act === "schedule") return openScheduleMeeting();
      if (act === "send") return sendMessage();
      if (act === "attach") {
        var fi = root.querySelector('[data-role="file"]');
        if (fi) fi.click();
        return;
      }
      if (act === "msg-edit") {
        var re = actEl.closest(".hcx-msg");
        if (re) startEdit(re.getAttribute("data-mid"));
        return;
      }
      if (act === "msg-delete") {
        var rd = actEl.closest(".hcx-msg");
        if (rd) deleteMessage(rd.getAttribute("data-mid"));
        return;
      }
      if (act === "edit-save") return saveEdit();
      if (act === "edit-cancel") return cancelEdit();
      if (act === "lightbox") return openLightbox(actEl.getAttribute("data-src"));
      if (act === "lightbox-close") return closeLightbox();
      if (act === "mic") return toggleDictation();
      if (act === "search-toggle") return toggleSearch();
      if (act === "search-prev") return stepSearch(-1);
      if (act === "search-next") return stepSearch(1);
      if (act === "search-close") return closeSearch();
      if (act === "cancel-meeting") return cancelMeeting(actEl.getAttribute("data-mid"));
      if (act === "room-menu") { e.stopPropagation(); return toggleRoomMenu(); }
      if (act === "room-delete") return deleteRoom();
      if (act === "room-leave") return leaveRoom();
      if (act === "members") return openMembers();
      if (act === "mem-add-open") return openAddMembers();
      if (act === "mem-add") return addMember(actEl.getAttribute("data-email"));
      if (act === "mem-promote" || act === "mem-demote" || act === "mem-remove") {
        return memberAction(act, actEl.getAttribute("data-email"));
      }
      if (act === "back") {
        root.classList.remove("show-convo");
        return;
      }

      var tab = t.closest ? t.closest(".hcx-tab") : null;
      if (tab) {
        state.tab = tab.getAttribute("data-tab");
        syncTabs();
        return;
      }
      var row = t.closest ? t.closest(".hcx-row") : null;
      if (row && row.getAttribute("data-room")) {
        openRoom(row.getAttribute("data-room"));
        return;
      }
    });

    // File picker
    root.addEventListener("change", function (e) {
      if (e.target.getAttribute("data-role") === "file") {
        handleFilePick(e.target);
      }
    });

    // Search
    root.addEventListener("input", function (e) {
      if (e.target.getAttribute("data-role") === "search") {
        state.search = e.target.value;
        renderList();
      }
      if (e.target.getAttribute("data-role") === "input") {
        autoresize(e.target);
      }
      if (e.target.getAttribute("data-role") === "msg-search") {
        runSearch(e.target.value);
      }
    });

    // Keyboard: Enter to send; in the edit box Enter saves, Esc cancels.
    root.addEventListener("keydown", function (e) {
      var role = e.target.getAttribute && e.target.getAttribute("data-role");
      if (role === "msg-search") {
        if (e.key === "Enter") { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
        return;
      }
      if (role === "input") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      } else if (role === "edit-input") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        }
      }
    });
  }

  // ───────────────────────────────────────────── image lightbox
  function openLightbox(src) {
    if (!src || !state.root) return;
    closeLightbox();
    var box = document.createElement("div");
    box.className = "hcx-lightbox";
    box.setAttribute("data-act", "lightbox-close");
    box.innerHTML = '<img src="' + esc(src) + '" alt="">';
    state.root.appendChild(box);
  }

  function closeLightbox() {
    var box = state.root && state.root.querySelector(".hcx-lightbox");
    if (box) box.remove();
  }

  // ───────────────────────────────────────────── speech-to-text (dictation)
  function toggleDictation() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Speech-to-text isn't available in this browser. It works in Google Chrome or Microsoft Edge.\n\n(Brave disables the speech engine by default, so dictation won't run there.)");
      return;
    }
    if (state.listening) { stopDictation(); return; }

    var input = state.root.querySelector('[data-role="input"]');
    if (!input) return;
    var micBtn = state.root.querySelector('[data-role="mic"]');
    // Base text = whatever is already typed. Kept in state so sendMessage can
    // reset it after a send (otherwise the sent text would reappear on the next
    // dictation).
    state.dictBase = input.value ? input.value.replace(/\s*$/, "") + " " : "";

    var recog = new SR();
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    state.recog = recog;
    state.listening = true;
    if (micBtn) micBtn.classList.add("rec");

    recog.onresult = function (ev) {
      var finalTxt = "";
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finalTxt += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (finalTxt) state.dictBase = (state.dictBase + finalTxt).replace(/\s*$/, "") + " ";
      input.value = state.dictBase + interim;
      autoresize(input);
    };
    recog.onerror = function (e) {
      var err = e && e.error;
      if (err === "not-allowed" || err === "service-not-allowed") {
        alert("Microphone access was blocked. Allow mic permission (and use Chrome/Edge) to dictate.");
      } else if (err === "network") {
        alert("The speech service couldn't be reached. Dictation needs Google Chrome or Microsoft Edge — Brave blocks it.");
      }
      stopDictation();
    };
    recog.onend = function () {
      // If the user is still "listening" (didn't stop), restart for continuous dictation.
      if (state.listening) {
        try { recog.start(); return; } catch (_) {}
      }
      stopDictation();
    };
    try { recog.start(); } catch (_) { stopDictation(); }
  }

  // After sending, clear the dictation base + the recognizer's buffer so the
  // just-sent words don't get prepended to the next dictation.
  function resetDictationBuffer() {
    state.dictBase = "";
    if (state.listening && state.recog) {
      try { state.recog.stop(); } catch (_) {}  // onend auto-restarts a fresh session
    }
  }

  function stopDictation() {
    state.listening = false;
    if (state.recog) {
      try { state.recog.onend = null; state.recog.stop(); } catch (_) {}
    }
    state.recog = null;
    var micBtn = state.root && state.root.querySelector('[data-role="mic"]');
    if (micBtn) micBtn.classList.remove("rec");
    var input = state.root && state.root.querySelector('[data-role="input"]');
    if (input) input.focus();
  }

  // ───────────────────────────────────────────── in-conversation search
  function toggleSearch() {
    var bar = state.root.querySelector('[data-role="searchbar"]');
    if (!bar) return;
    if (bar.style.display === "none" || !bar.style.display) {
      bar.style.display = "flex";
      var inp = bar.querySelector('[data-role="msg-search"]');
      if (inp) { inp.value = ""; inp.focus(); }
      state.msgSearch = { q: "", matches: [], idx: -1 };
    } else {
      closeSearch();
    }
  }

  function closeSearch() {
    var bar = state.root.querySelector('[data-role="searchbar"]');
    if (bar) bar.style.display = "none";
    state.msgSearch = { q: "", matches: [], idx: -1 };
    clearSearchHighlights();
  }

  function clearSearchHighlights() {
    if (!state.root) return;
    state.root.querySelectorAll(".hcx-msg.match, .hcx-msg.match-current").forEach(function (el) {
      el.classList.remove("match", "match-current");
    });
  }

  function runSearch(q) {
    state.msgSearch.q = q;
    clearSearchHighlights();
    var query = (q || "").toLowerCase().trim();
    var countEl = state.root.querySelector('[data-role="search-count"]');
    if (!query) {
      state.msgSearch.matches = [];
      state.msgSearch.idx = -1;
      if (countEl) countEl.textContent = "";
      return;
    }
    var matches = state.messages.filter(function (m) {
      return !m.is_deleted && m.id != null && (m.message || "").toLowerCase().indexOf(query) !== -1;
    }).map(function (m) { return m.id; });
    state.msgSearch.matches = matches;
    // highlight all matches
    matches.forEach(function (id) {
      var row = state.root.querySelector('.hcx-msg[data-mid="' + id + '"]');
      if (row) row.classList.add("match");
    });
    state.msgSearch.idx = matches.length ? matches.length - 1 : -1; // jump to latest
    focusMatch();
    if (countEl) {
      countEl.textContent = matches.length ? (state.msgSearch.idx + 1) + " / " + matches.length : "No matches";
    }
  }

  function focusMatch() {
    var s = state.msgSearch;
    state.root.querySelectorAll(".hcx-msg.match-current").forEach(function (el) { el.classList.remove("match-current"); });
    if (s.idx < 0 || !s.matches.length) return;
    var id = s.matches[s.idx];
    var row = state.root.querySelector('.hcx-msg[data-mid="' + id + '"]');
    if (row) {
      row.classList.add("match-current");
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    var countEl = state.root.querySelector('[data-role="search-count"]');
    if (countEl) countEl.textContent = (s.idx + 1) + " / " + s.matches.length;
  }

  function stepSearch(dir) {
    var s = state.msgSearch;
    if (!s.matches.length) return;
    s.idx = (s.idx + dir + s.matches.length) % s.matches.length;
    focusMatch();
  }

  // ───────────────────────────────────────────── channel members management
  function openMembers() {
    var room = state.activeRoom;
    if (!room || !room.is_group) return;
    apiGet("/api/chat/rooms/" + room.id + "/members?email=" + encodeURIComponent(state.me.email))
      .then(function (members) {
        renderMembersModal(Array.isArray(members) ? members : (room.members || []));
      })
      .catch(function () { renderMembersModal(room.members || []); });
  }

  function renderMembersModal(members) {
    var room = state.activeRoom;
    var iAmAdmin = !!(room && room.viewer_is_admin);
    var adminCount = members.filter(function (m) { return m.is_admin; }).length;
    var MAX_ADMINS = 3; // creator + 2 more
    var creator = ((room && room.created_by) || "").toLowerCase();

    var rows = members.map(function (m) {
      var isCreator = m.email.toLowerCase() === creator;
      var badge = "";
      if (isCreator) badge = '<span class="hcx-admin-badge">Creator · Admin</span>';
      else if (m.is_admin) badge = '<span class="hcx-admin-badge">Admin</span>';
      var isMe = m.email === state.me.email;
      var ctrls = "";
      if (iAmAdmin && !isCreator) {
        var canPromote = !m.is_admin && adminCount < MAX_ADMINS;
        var canDemote = m.is_admin; // creator excluded above
        if (canPromote) ctrls += '<button class="hcx-mini" data-act="mem-promote" data-email="' + esc(m.email) + '">Make admin</button>';
        if (canDemote) ctrls += '<button class="hcx-mini" data-act="mem-demote" data-email="' + esc(m.email) + '">Remove admin</button>';
        ctrls += '<button class="hcx-mini danger" data-act="mem-remove" data-email="' + esc(m.email) + '">Remove</button>';
      }
      return (
        '<div class="hcx-pick" style="cursor:default">' +
        avatarHTML(m.name, m.email, m.profilePic, "sm") +
        '<div class="hcx-mid"><div class="hcx-rn">' + esc(m.name) + (isMe ? " (you)" : "") + " " + badge + "</div>" +
        '<div class="hcx-rl">' + esc([m.designation, m.department].filter(Boolean).join(" · ") || m.email) + "</div></div>" +
        '<div class="hcx-mem-ctrls">' + ctrls + "</div></div>"
      );
    }).join("");

    var addBtn = iAmAdmin
      ? '<button class="hcx-btn primary" data-act="mem-add-open" style="width:100%;margin-top:12px">' + ICON.plus + " Add members</button>"
      : "";

    var hint = iAmAdmin
      ? '<div class="hcx-hint">The channel creator is a permanent admin. You can add up to 2 more admins (3 total).</div>'
      : '<div class="hcx-hint">Only channel admins can add or remove members. The creator is a permanent admin; up to 2 more admins allowed.</div>';

    var html =
      '<div class="hcx-modal-h"><h3>Channel members · ' + members.length + " · admins " + adminCount + "/" + MAX_ADMINS + "</h3>" +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b">' + hint +
      '<div class="hcx-picklist">' + rows + "</div>" + addBtn +
      "</div>";
    var bg = openModal(html);
    bg._members = members;
  }

  function memberAction(act, email) {
    var room = state.activeRoom;
    if (!room) return;
    var base = "/api/chat/rooms/" + room.id + "/members/" + encodeURIComponent(email);
    var p;
    if (act === "mem-remove") {
      if (!confirm("Remove this member from the channel?")) return;
      p = apiFetch("DELETE", base, { email: state.me.email });
    } else if (act === "mem-promote") {
      p = apiFetch("PUT", base, { email: state.me.email, is_admin: true });
    } else if (act === "mem-demote") {
      p = apiFetch("PUT", base, { email: state.me.email, is_admin: false });
    } else {
      return;
    }
    p.then(function (updatedRoom) {
      applyRoomUpdate(updatedRoom);
      renderMembersModal(updatedRoom.members || []);
    }).catch(function (e) { alert(e.message); });
  }

  function openAddMembers() {
    var room = state.activeRoom;
    if (!room) return;
    var present = {};
    (room.member_emails || []).forEach(function (e) { present[e] = true; });
    var candidates = state.contacts.filter(function (c) { return !present[c.email]; });
    if (!candidates.length) {
      alert("Everyone is already in this channel.");
      return;
    }
    var rows = candidates.map(function (c) {
      return (
        '<div class="hcx-pick" data-act="mem-add" data-email="' + esc(c.email) + '">' +
        avatarHTML(c.name, c.email, c.profilePic, "sm") +
        '<div class="hcx-mid"><div class="hcx-rn">' + esc(c.name) + '</div><div class="hcx-rl">' +
        esc([c.designation, c.department].filter(Boolean).join(" · ") || c.email) + "</div></div>" +
        '<span class="hcx-cbx">' + ICON.plus + "</span></div>"
      );
    }).join("");
    var html =
      '<div class="hcx-modal-h"><h3>Add members</h3>' +
      '<button class="hcx-modal-x" data-act="modal-close">' + ICON.close + "</button></div>" +
      '<div class="hcx-modal-b"><div class="hcx-picklist">' + rows + "</div></div>";
    openModal(html);
  }

  function addMember(email) {
    var room = state.activeRoom;
    if (!room) return;
    apiFetch("POST", "/api/chat/rooms/" + room.id + "/members", {
      email: state.me.email,
      member: email,
    })
      .then(function (updatedRoom) {
        applyRoomUpdate(updatedRoom);
        openMembers(); // reopen the members list
      })
      .catch(function (e) { alert(e.message); });
  }

  function applyRoomUpdate(updatedRoom) {
    if (!updatedRoom || updatedRoom.id == null) return;
    upsertRoom(updatedRoom);
    if (String(state.activeRoomId) === String(updatedRoom.id)) {
      state.activeRoom = updatedRoom;
      // refresh header subtitle (member count)
      var sub = state.root.querySelector(".hcx-hm");
      if (sub) sub.textContent = (updatedRoom.member_emails || []).length + " members";
    }
    renderList();
  }

  // ───────────────────────────────────────────── room ⋯ menu (delete / leave)
  function toggleRoomMenu() {
    var menu = state.root.querySelector('[data-role="room-menu"]');
    if (!menu) return;
    if (menu.style.display !== "none") { closeRoomMenu(); return; }
    var room = state.activeRoom;
    if (!room) return;
    var items = "";
    if (room.is_group) {
      if (room.viewer_is_admin) {
        items += '<button class="danger" data-act="room-delete">' + ICON.trash + " Delete channel</button>";
      }
      var iAmCreator = ((room.created_by || "").toLowerCase() === state.me.email.toLowerCase());
      if (!iAmCreator) {
        items += '<button data-act="room-leave">' + ICON.back + " Leave channel</button>";
      }
    } else {
      items += '<button class="danger" data-act="room-delete">' + ICON.trash + " Delete chat</button>";
    }
    if (!items) items = '<button disabled style="opacity:.6">No actions</button>';
    menu.innerHTML = items;
    menu.style.display = "block";
  }

  function closeRoomMenu() {
    var menu = state.root && state.root.querySelector('[data-role="room-menu"]');
    if (menu) menu.style.display = "none";
  }

  function closeActiveRoom() {
    teardownWS();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.activeRoomId = null;
    state.activeRoom = null;
    state.messages = [];
    state.meetings = [];
    var main = state.root.querySelector('[data-role="main"]');
    if (main) main.innerHTML = welcomeHTML();
    state.root.classList.remove("show-convo");
    renderList();
  }

  function removeRoomFromState(roomId) {
    state.rooms = state.rooms.filter(function (r) { return String(r.id) !== String(roomId); });
  }

  function deleteRoom() {
    var room = state.activeRoom;
    if (!room) return;
    closeRoomMenu();
    var label = room.is_group ? "channel" : "chat";
    if (!confirm("Delete this " + label + " permanently? This removes all messages for everyone and can't be undone.")) return;
    var id = room.id;
    apiFetch("DELETE", "/api/chat/rooms/" + id, { email: state.me.email })
      .then(function () {
        removeRoomFromState(id);
        closeActiveRoom();
      })
      .catch(function (e) { alert("Could not delete: " + e.message); });
  }

  function leaveRoom() {
    var room = state.activeRoom;
    if (!room) return;
    closeRoomMenu();
    if (!confirm("Leave this channel? You'll stop receiving its messages.")) return;
    var id = room.id;
    apiFetch("DELETE", "/api/chat/rooms/" + id + "/members/" + encodeURIComponent(state.me.email), { email: state.me.email })
      .then(function () {
        removeRoomFromState(id);
        closeActiveRoom();
      })
      .catch(function (e) { alert("Could not leave: " + e.message); });
  }

  // ───────────────────────────────────────────── public entry + auto-mount
  function openChat() {
    // Called by the React route (HrmsEmployeeChatPage) after it renders
    // <div id="hrms-chat-page">. Also safe to call directly.
    boot();
  }

  global.__hrmsOpenChat = openChat;

  // Auto-mount when the chat page appears (covers navigation without an
  // explicit __hrmsOpenChat() call), and re-mount on route re-entry.
  function watch() {
    var page = getPage();
    if (page && !page.querySelector("#" + ROOT_ID)) {
      boot();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      watch();
      new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
    });
  } else {
    watch();
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  }

  console.log("[hrms-chat v2] inline chat module loaded");
})(window);
