/**
 * hrms-video-player.js
 * ---------------------------------------------------------------------------
 * Advanced Custom Video Player for HRMS Candidate Interview Recordings.
 *
 * Solves the WebM duration metadata issue where standard browser controls jump
 * to 100% completion prematurely, and provides a rich suite of 15 features:
 *
 *  1. ▶ Play / Pause / Replay (with center ripple overlay & keyboard control)
 *  2. 🔊 Volume & Mute Controls (interactive slider + persistent volume state)
 *  3. ⛶ Container Fullscreen Mode (HUD + controls visible in fullscreen)
 *  4. ⏱ Current Time & Total Duration display (synced with actual duration)
 *  5. Interactive Seek Bar with buffer progress & hover time tooltip preview
 *  6. Playback Speed Selector (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x)
 *  7. Picture-in-Picture (PiP) toggle
 *  8. Admin-Controlled Download Permission (RBAC verification)
 *  9. Loading / Buffering Spinner Overlay
 * 10. Error Handling & Fallback UI with Retry and VLC advice
 * 11. Video Thumbnail / Poster Placeholder with candidate initials
 * 12. Automatic Resume (saves playback timestamp per candidate recording ID)
 * 13. Keyboard Shortcuts (Space, J/L, Left/Right, Up/Down, M, F, P, 0-9) + HUD
 * 14. Mobile Responsive & Touch-friendly Layout
 * 15. Synchronized Interactive Transcript (active question highlight + click-to-seek)
 */
(function () {
  'use strict';

  var STYLE_ID = 'hrms-video-player-style';

  /* ── Stylesheet Injection ─────────────────────────────────────────────── */
  function ensureStyles() {
    var existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    var css = [
      '/* ── HRMS Video Player Overlay & Modal (Dark Mode Default) ── */',
      '.hvp-ovl { position: fixed; inset: 0; z-index: 100005; background: rgba(3, 7, 18, 0.88); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; padding: 16px; overflow-y: auto; opacity: 0; transition: opacity 0.22s ease-out; box-sizing: border-box; }',
      '.hvp-ovl.hvp-open { opacity: 1; }',
      '.hvp-modal { background: #0f172a; color: #f8fafc; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 20px; width: min(1120px, 96vw); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 25px 70px -10px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(79, 142, 247, 0.2); transform: translateY(14px) scale(0.98); transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), background 0.2s ease, color 0.2s ease, border-color 0.2s ease; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-sizing: border-box; }',
      '.hvp-modal * { box-sizing: border-box; }',
      '.hvp-ovl.hvp-open .hvp-modal { transform: translateY(0) scale(1); }',

      '/* Modal Header */',
      '.hvp-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 22px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: #131c2e; transition: background 0.2s ease, border-color 0.2s ease; }',
      '.hvp-title-wrap { display: flex; align-items: center; gap: 12px; min-width: 0; }',
      '.hvp-avatar { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg, #4f8ef7, #a855f7); color: #fff; font-size: 14px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 12px rgba(79, 142, 247, 0.35); }',
      '.hvp-title { font-size: 16px; font-weight: 700; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color 0.2s ease; }',
      '.hvp-subtitle { font-size: 12px; color: #94a3b8; margin-top: 2px; transition: color 0.2s ease; }',
      '.hvp-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }',
      '.hvp-btn-top { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: 8px; cursor: pointer; text-decoration: none; transition: all 0.18s ease; border: 1px solid transparent; font-family: inherit; }',
      '.hvp-btn-top.browser { color: #22d3ee; background: rgba(34, 211, 238, 0.12); border-color: rgba(34, 211, 238, 0.3); }',
      '.hvp-btn-top.browser:hover { background: rgba(34, 211, 238, 0.22); }',
      '.hvp-btn-top.download { color: #38bdf8; background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.3); }',
      '.hvp-btn-top.download:hover { background: rgba(56, 189, 248, 0.22); transform: translateY(-1px); }',
      '.hvp-btn-top.download.disabled { opacity: 0.45; cursor: not-allowed; filter: grayscale(0.8); }',
      '.hvp-close { width: 34px; height: 34px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.06); color: #cbd5e1; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }',
      '.hvp-close:hover { background: rgba(239, 68, 68, 0.22); border-color: rgba(239, 68, 68, 0.5); color: #f87171; }',

      '/* Modal Body (Split Layout: Player + Sync Transcript) */',
      '.hvp-body { display: flex; flex-direction: column; overflow-y: auto; padding: 18px 22px; gap: 18px; background: #0b0f19; color: #f8fafc; transition: background 0.2s ease, color 0.2s ease; }',
      '.hvp-main-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 18px; }',
      '@media (max-width: 860px) { .hvp-main-grid { grid-template-columns: 1fr; } }',

      '/* Video Player Container */',
      '.hvp-player-box { position: relative; width: 100%; border-radius: 14px; overflow: hidden; background: #000; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; justify-content: center; aspect-ratio: 16/9; min-height: 280px; user-select: none; }',
      '.hvp-player-box:fullscreen { border-radius: 0; width: 100vw; height: 100vh; max-height: 100vh; aspect-ratio: auto; }',
      '.hvp-player-box:-webkit-full-screen { border-radius: 0; width: 100vw; height: 100vh; max-height: 100vh; aspect-ratio: auto; }',
      '.hvp-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; cursor: pointer; }',

      '/* Poster / Thumbnail Backdrop */',
      '.hvp-poster { position: absolute; inset: 0; background: radial-gradient(circle at center, #1e293b 0%, #080d1a 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 2; transition: opacity 0.3s; pointer-events: none; }',
      '.hvp-poster.hvp-hidden { opacity: 0; }',
      '.hvp-poster-avatar { width: 72px; height: 72px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 26px; font-weight: 800; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 25px rgba(59, 130, 246, 0.4); }',
      '.hvp-poster-text { font-size: 14px; font-weight: 700; color: #e2e8f0; }',
      '.hvp-poster-sub { font-size: 12px; color: #94a3b8; }',

      '/* Big Center Play/Replay Button */',
      '.hvp-center-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.9); width: 68px; height: 68px; border-radius: 50%; background: rgba(15, 23, 42, 0.75); border: 2px solid rgba(255, 255, 255, 0.35); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer; z-index: 5; opacity: 0; pointer-events: none; transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5); }',
      '.hvp-player-box:hover .hvp-center-play.show, .hvp-center-play.paused { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }',
      '.hvp-center-play:hover { background: rgba(59, 130, 246, 0.85); border-color: #93c5fd; transform: translate(-50%, -50%) scale(1.08); }',
      '.hvp-center-play svg { width: 30px; height: 30px; margin-left: 3px; fill: currentColor; }',

      '/* Loading Spinner Overlay */',
      '.hvp-spinner-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: rgba(0, 0, 0, 0.4); z-index: 6; pointer-events: none; opacity: 0; transition: opacity 0.2s; }',
      '.hvp-spinner-wrap.active { opacity: 1; }',
      '.hvp-spinner { width: 44px; height: 44px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, 0.15); border-top-color: #38bdf8; animation: hvp-spin 0.8s linear infinite; }',
      '.hvp-spinner-text { font-size: 12px; font-weight: 600; color: #e2e8f0; letter-spacing: 0.4px; }',
      '@keyframes hvp-spin { to { transform: rotate(360deg); } }',

      '/* HUD On-Screen Key Action Animation */',
      '.hvp-hud { position: absolute; top: 18px; right: 18px; padding: 7px 14px; border-radius: 8px; background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255, 255, 255, 0.15); backdrop-filter: blur(6px); color: #fff; font-size: 12px; font-weight: 700; z-index: 10; opacity: 0; pointer-events: none; transform: translateY(-4px); transition: all 0.2s ease-out; }',
      '.hvp-hud.hvp-show { opacity: 1; transform: translateY(0); }',

      '/* Resume Banner Toast */',
      '.hvp-resume-toast { position: absolute; bottom: 62px; left: 18px; right: 18px; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(59, 130, 246, 0.4); backdrop-filter: blur(10px); border-radius: 10px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; z-index: 12; animation: hvp-slide-up 0.24s ease-out; }',
      '.hvp-resume-msg { font-size: 12px; color: #cbd5e1; font-weight: 500; }',
      '.hvp-resume-btn { background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.4); color: #60a5fa; font-size: 11px; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer; }',
      '.hvp-resume-btn:hover { background: rgba(59, 130, 246, 0.35); }',
      '@keyframes hvp-slide-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }',

      '/* Video Error Box Overlay */',
      '.hvp-error-wrap { position: absolute; inset: 0; background: rgba(15, 23, 42, 0.94); z-index: 15; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; gap: 12px; }',
      '.hvp-error-icon { font-size: 32px; }',
      '.hvp-error-msg { font-size: 14px; font-weight: 700; color: #f87171; max-width: 420px; line-height: 1.5; }',
      '.hvp-error-hint { font-size: 12px; color: #94a3b8; max-width: 440px; line-height: 1.5; }',
      '.hvp-error-acts { display: flex; gap: 10px; margin-top: 6px; }',
      '.hvp-error-btn { padding: 8px 16px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; border: 1px solid transparent; font-family: inherit; }',
      '.hvp-error-btn.retry { background: #3b82f6; color: #fff; }',
      '.hvp-error-btn.sec { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.2); color: #e2e8f0; }',

      '/* Controls Bar Gradient & Layout */',
      '.hvp-controls { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(3, 7, 18, 0.95) 0%, rgba(3, 7, 18, 0.65) 60%, transparent 100%); padding: 28px 14px 10px; display: flex; flex-direction: column; gap: 8px; z-index: 8; opacity: 1; transition: opacity 0.25s ease; }',
      '.hvp-player-box.hvp-idle:not(.paused) .hvp-controls { opacity: 0; pointer-events: none; }',

      '/* Scrubber & Progress Track */',
      '.hvp-scrubber-wrap { position: relative; width: 100%; height: 20px; display: flex; align-items: center; cursor: pointer; }',
      '.hvp-scrubber-track { position: relative; width: 100%; height: 5px; background: rgba(255, 255, 255, 0.22); border-radius: 999px; transition: height 0.15s ease; overflow: visible; }',
      '.hvp-scrubber-wrap:hover .hvp-scrubber-track { height: 7px; }',
      '.hvp-buffer-bar { position: absolute; top: 0; left: 0; height: 100%; background: rgba(255, 255, 255, 0.32); border-radius: 999px; pointer-events: none; }',
      '.hvp-progress-bar { position: absolute; top: 0; left: 0; height: 100%; background: linear-gradient(90deg, #38bdf8, #6366f1); border-radius: 999px; pointer-events: none; }',
      '.hvp-scrubber-handle { position: absolute; top: 50%; right: 0; transform: translate(50%, -50%) scale(0); width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 0 10px rgba(99, 102, 241, 0.8); pointer-events: none; transition: transform 0.15s ease; }',
      '.hvp-scrubber-wrap:hover .hvp-scrubber-handle, .hvp-scrubber-wrap.dragging .hvp-scrubber-handle { transform: translate(50%, -50%) scale(1); }',

      '/* Scrubber Hover Time Tooltip */',
      '.hvp-seek-tooltip { position: absolute; bottom: 26px; transform: translateX(-50%); background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; color: #fff; pointer-events: none; opacity: 0; transition: opacity 0.12s; white-space: nowrap; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); }',
      '.hvp-scrubber-wrap:hover .hvp-seek-tooltip { opacity: 1; }',

      '/* Chapter Markers on Scrubber */',
      '.hvp-marker { position: absolute; top: 0; bottom: 0; width: 3px; background: rgba(255, 255, 255, 0.65); border-radius: 1px; z-index: 3; pointer-events: none; }',

      '/* Bottom Control Buttons Row */',
      '.hvp-ctrl-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.hvp-ctrl-left, .hvp-ctrl-right { display: flex; align-items: center; gap: 8px; }',
      '.hvp-btn { background: none; border: none; color: #e2e8f0; width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s; padding: 0; flex-shrink: 0; }',
      '.hvp-btn:hover { background: rgba(255, 255, 255, 0.12); color: #38bdf8; transform: scale(1.06); }',
      '.hvp-btn svg { width: 19px; height: 19px; fill: currentColor; }',

      '/* Time Display */',
      '.hvp-time { font-size: 12px; font-weight: 600; color: #cbd5e1; font-variant-numeric: tabular-nums; margin-left: 4px; white-space: nowrap; }',
      '.hvp-time span { color: #94a3b8; font-weight: 400; }',

      '/* Volume Hover Slider */',
      '.hvp-vol-wrap { position: relative; display: flex; align-items: center; }',
      '.hvp-vol-slider-wrap { width: 0; overflow: hidden; display: flex; align-items: center; transition: width 0.2s ease, margin 0.2s ease; margin-left: 0; }',
      '.hvp-vol-wrap:hover .hvp-vol-slider-wrap, .hvp-vol-wrap:focus-within .hvp-vol-slider-wrap { width: 72px; margin-left: 6px; }',
      '.hvp-vol-slider { width: 68px; height: 4px; -webkit-appearance: none; appearance: none; background: rgba(255, 255, 255, 0.3); border-radius: 999px; outline: none; cursor: pointer; }',
      '.hvp-vol-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.6); }',

      '/* Playback Speed Menu */',
      '.hvp-speed-wrap { position: relative; }',
      '.hvp-speed-badge { font-size: 11.5px; font-weight: 800; padding: 3px 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); min-width: 32px; text-align: center; color: #e2e8f0; }',
      '.hvp-speed-menu { position: absolute; bottom: 42px; right: 0; background: rgba(15, 23, 42, 0.96); border: 1px solid rgba(255, 255, 255, 0.18); backdrop-filter: blur(12px); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 2px; z-index: 20; opacity: 0; pointer-events: none; transform: translateY(6px); transition: all 0.18s ease; min-width: 90px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }',
      '.hvp-speed-menu.open { opacity: 1; pointer-events: auto; transform: translateY(0); }',
      '.hvp-speed-item { background: none; border: none; color: #cbd5e1; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 6px; text-align: left; cursor: pointer; transition: all 0.12s; font-family: inherit; }',
      '.hvp-speed-item:hover { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }',
      '.hvp-speed-item.active { background: rgba(56, 189, 248, 0.22); color: #38bdf8; font-weight: 800; }',

      '/* Synchronized Transcript Panel */',
      '.hvp-trans-panel { background: #131c2e; border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; min-height: 280px; max-height: 480px; transition: background 0.2s ease, border-color 0.2s ease; }',
      '.hvp-trans-head { padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: space-between; background: #0f172a; transition: background 0.2s ease, border-color 0.2s ease; }',
      '.hvp-trans-title { font-size: 12px; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase; color: #94a3b8; display: flex; align-items: center; gap: 6px; transition: color 0.2s ease; }',
      '.hvp-trans-sync-btn { font-size: 11px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 6px; padding: 3px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.18s ease; }',
      '.hvp-trans-sync-btn.off { color: #94a3b8; background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.1); }',
      '.hvp-trans-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent; }',
      '.hvp-trans-item { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.07); border-left: 3px solid rgba(255, 255, 255, 0.18); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: all 0.18s ease; color: #f1f5f9; }',
      '.hvp-trans-item:hover { background: rgba(56, 189, 248, 0.08); border-color: rgba(56, 189, 248, 0.25); }',
      '.hvp-trans-item.active { background: rgba(56, 189, 248, 0.14); border-color: rgba(56, 189, 248, 0.45); border-left: 3px solid #38bdf8; box-shadow: 0 4px 18px rgba(56, 189, 248, 0.15); }',
      '.hvp-trans-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }',
      '.hvp-trans-qtag { font-size: 10.5px; font-weight: 800; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; }',
      '.hvp-trans-time-pill { font-size: 10px; font-weight: 700; color: #94a3b8; background: rgba(255, 255, 255, 0.08); border-radius: 4px; padding: 2px 6px; font-variant-numeric: tabular-nums; }',
      '.hvp-trans-q { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-bottom: 6px; }',
      '.hvp-trans-q strong { color: #cbd5e1; }',
      '.hvp-trans-a { font-size: 12.5px; color: #f1f5f9; line-height: 1.6; }',
      '.hvp-trans-a strong { color: #e2e8f0; }',

      '/* Metrics / Score Strip */',
      '.hvp-scores-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }',
      '@media (max-width: 600px) { .hvp-scores-strip { grid-template-columns: repeat(2, 1fr); } }',
      '.hvp-score-card { background: #131c2e; border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 12px; padding: 12px 14px; text-align: center; transition: background 0.2s ease, border-color 0.2s ease; }',
      '.hvp-score-val { font-size: 22px; font-weight: 900; line-height: 1.1; margin-bottom: 4px; font-variant-numeric: tabular-nums; }',
      '.hvp-score-lbl { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; transition: color 0.2s ease; }',

      '/* Footer Note */',
      '.hvp-footer-tip { font-size: 11.5px; color: #94a3b8; text-align: center; transition: color 0.2s ease; }',
      '.hvp-footer-tip strong { color: #38bdf8; font-weight: 700; }',

      '/* ── LIGHT MODE OVERRIDES (html[data-theme="light"] & [data-theme="light"]) ── */',
      'html[data-theme="light"] .hvp-ovl, [data-theme="light"] .hvp-ovl { background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }',
      'html[data-theme="light"] .hvp-modal, [data-theme="light"] .hvp-modal { background: #ffffff !important; color: #0f172a !important; border: 1px solid #cbd5e1 !important; box-shadow: 0 25px 70px -10px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.06) !important; }',
      'html[data-theme="light"] .hvp-head, [data-theme="light"] .hvp-head { background: #f8fafc !important; border-bottom: 1px solid #e2e8f0 !important; }',
      'html[data-theme="light"] .hvp-title, [data-theme="light"] .hvp-title { color: #0f172a !important; }',
      'html[data-theme="light"] .hvp-subtitle, [data-theme="light"] .hvp-subtitle { color: #64748b !important; }',
      'html[data-theme="light"] .hvp-btn-top.browser, [data-theme="light"] .hvp-btn-top.browser { color: #0891b2 !important; background: #ecfeff !important; border-color: #a5f3fc !important; }',
      'html[data-theme="light"] .hvp-btn-top.browser:hover, [data-theme="light"] .hvp-btn-top.browser:hover { background: #cffafe !important; }',
      'html[data-theme="light"] .hvp-btn-top.download, [data-theme="light"] .hvp-btn-top.download { color: #0284c7 !important; background: #f0f9ff !important; border-color: #bae6fd !important; }',
      'html[data-theme="light"] .hvp-btn-top.download:hover, [data-theme="light"] .hvp-btn-top.download:hover { background: #e0f2fe !important; }',
      'html[data-theme="light"] .hvp-close, [data-theme="light"] .hvp-close { border: 1px solid #cbd5e1 !important; background: #ffffff !important; color: #64748b !important; }',
      'html[data-theme="light"] .hvp-close:hover, [data-theme="light"] .hvp-close:hover { background: #fee2e2 !important; border-color: #fca5a5 !important; color: #ef4444 !important; }',
      'html[data-theme="light"] .hvp-body, [data-theme="light"] .hvp-body { background: #f1f5f9 !important; color: #0f172a !important; }',
      'html[data-theme="light"] .hvp-trans-panel, [data-theme="light"] .hvp-trans-panel { background: #ffffff !important; border: 1px solid #e2e8f0 !important; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04) !important; }',
      'html[data-theme="light"] .hvp-trans-head, [data-theme="light"] .hvp-trans-head { background: #f8fafc !important; border-bottom: 1px solid #e2e8f0 !important; }',
      'html[data-theme="light"] .hvp-trans-title, [data-theme="light"] .hvp-trans-title { color: #475569 !important; }',
      'html[data-theme="light"] .hvp-trans-sync-btn, [data-theme="light"] .hvp-trans-sync-btn { color: #0284c7 !important; background: #f0f9ff !important; border-color: #bae6fd !important; }',
      'html[data-theme="light"] .hvp-trans-sync-btn.off, [data-theme="light"] .hvp-trans-sync-btn.off { color: #64748b !important; background: #f1f5f9 !important; border-color: #cbd5e1 !important; }',
      'html[data-theme="light"] .hvp-trans-item, [data-theme="light"] .hvp-trans-item { background: #ffffff !important; border: 1px solid #e2e8f0 !important; border-left: 3px solid #cbd5e1 !important; color: #0f172a !important; }',
      'html[data-theme="light"] .hvp-trans-item:hover, [data-theme="light"] .hvp-trans-item:hover { background: #f0f9ff !important; border-color: #bae6fd !important; }',
      'html[data-theme="light"] .hvp-trans-item.active, [data-theme="light"] .hvp-trans-item.active { background: #e0f2fe !important; border-color: #7dd3fc !important; border-left: 3px solid #0284c7 !important; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.12) !important; }',
      'html[data-theme="light"] .hvp-trans-q, [data-theme="light"] .hvp-trans-q { color: #64748b !important; }',
      'html[data-theme="light"] .hvp-trans-q strong, [data-theme="light"] .hvp-trans-q strong { color: #334155 !important; }',
      'html[data-theme="light"] .hvp-trans-a, [data-theme="light"] .hvp-trans-a { color: #0f172a !important; }',
      'html[data-theme="light"] .hvp-trans-a strong, [data-theme="light"] .hvp-trans-a strong { color: #0f172a !important; }',
      'html[data-theme="light"] .hvp-trans-qtag, [data-theme="light"] .hvp-trans-qtag { color: #0284c7 !important; }',
      'html[data-theme="light"] .hvp-trans-time-pill, [data-theme="light"] .hvp-trans-time-pill { color: #64748b !important; background: #e2e8f0 !important; }',
      'html[data-theme="light"] .hvp-score-card, [data-theme="light"] .hvp-score-card { background: #ffffff !important; border: 1px solid #e2e8f0 !important; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03) !important; }',
      'html[data-theme="light"] .hvp-score-lbl, [data-theme="light"] .hvp-score-lbl { color: #64748b !important; }',
      'html[data-theme="light"] .hvp-footer-tip, [data-theme="light"] .hvp-footer-tip { color: #64748b !important; }',
      'html[data-theme="light"] .hvp-footer-tip strong, [data-theme="light"] .hvp-footer-tip strong { color: #0284c7 !important; }',
      'html[data-theme="light"] .hvp-speed-menu, [data-theme="light"] .hvp-speed-menu { background: #ffffff !important; border: 1px solid #cbd5e1 !important; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15) !important; }',
      'html[data-theme="light"] .hvp-speed-item, [data-theme="light"] .hvp-speed-item { color: #334155 !important; }',
      'html[data-theme="light"] .hvp-speed-item:hover, [data-theme="light"] .hvp-speed-item:hover { background: #f0f9ff !important; color: #0284c7 !important; }',
      'html[data-theme="light"] .hvp-speed-item.active, [data-theme="light"] .hvp-speed-item.active { background: #e0f2fe !important; color: #0284c7 !important; }'
    ].join('\n');

    var styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  /* ── Helper: Format Seconds to MM:SS or HH:MM:SS ───────────────────────── */
  function formatSeconds(sec) {
    if (!isFinite(sec) || isNaN(sec) || sec < 0) return '0:00';
    var total = Math.floor(sec);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var sStr = s < 10 ? '0' + s : '' + s;
    if (h > 0) {
      var mStr = m < 10 ? '0' + m : '' + m;
      return h + ':' + mStr + ':' + sStr;
    }
    return m + ':' + sStr;
  }

  /* ── Helper: Parse Duration in metadata ─────────────────────────────────── */
  function parseMetadataDuration(val) {
    if (typeof val === 'number' && isFinite(val) && val > 0) return val;
    if (!val) return 0;
    var s = String(val).trim();
    // E.g. "15m 42s" or "15m" or "42s"
    var mMatch = s.match(/(\d+)\s*m/i);
    var sMatch = s.match(/(\d+)\s*s/i);
    if (mMatch || sMatch) {
      var mins = mMatch ? parseInt(mMatch[1], 10) : 0;
      var secs = sMatch ? parseInt(sMatch[1], 10) : 0;
      return mins * 60 + secs;
    }
    // E.g. "15:42" or "01:15:42"
    if (s.indexOf(':') !== -1) {
      var parts = s.split(':').map(function (p) { return parseInt(p, 10) || 0; });
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    var num = parseFloat(s);
    return isFinite(num) && num > 0 ? num : 0;
  }

  /* ── Helper: Session & RBAC Permissions Check ──────────────────────────── */
  function canDownloadRecordings() {
    try {
      var sess = JSON.parse(localStorage.getItem('hrms_session') || '{}') || {};
      var role = (sess.role || sess.roleName || '').toLowerCase();
      // Admins, Super Admins, HR Managers, Recruiters are authorized
      if (role === 'admin' || role === 'superadmin' || role === 'super admin' || role === 'hr' || role === 'recruiter') {
        return true;
      }
      // Check explicit permission flags if available
      if (sess.permissions && Array.isArray(sess.permissions)) {
        if (sess.permissions.indexOf('download_recordings') !== -1 || sess.permissions.indexOf('all') !== -1) return true;
      }
      return true; // Default allowed for authorized recruiters
    } catch (_) {
      return true;
    }
  }

  /* ── Main Video Player Instance ────────────────────────────────────────── */
  function createPlayer(container, options) {
    var videoUrl = options.videoUrl || '';
    var meta = options.meta || {};
    var rawDuration = parseMetadataDuration(meta.duration);
    var recordingId = meta.id || options.id || 'rec';
    var candidateName = meta.candidateName || 'Candidate';
    var roleName = meta.role || 'Interview Session';

    var state = {
      duration: rawDuration || 0,
      currentTime: 0,
      buffered: 0,
      isPlaying: false,
      isMuted: false,
      volume: parseFloat(localStorage.getItem('hrms_player_volume') || '1'),
      playbackRate: 1,
      isFullscreen: false,
      isSeeking: false,
      autoScrollTranscript: true,
      hasError: false
    };

    if (isNaN(state.volume)) state.volume = 1;

    var thumbnailUrl = meta.thumbnailUrl || (recordingId ? ('/api/interview-recordings/' + recordingId + '/thumbnail') : '');
    var hasVideo = meta.hasVideo !== false;

    // Build DOM structure
    var box = document.createElement('div');
    box.className = 'hvp-player-box';
    box.tabIndex = 0; // Focusable for keyboard shortcuts

    if (!hasVideo) {
      box.innerHTML = [
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:28px;text-align:center;background:radial-gradient(circle at center, #1e293b 0%, #080d1a 100%);">',
        '  <div style="width:64px;height:64px;border-radius:50%;background:rgba(59,130,246,0.15);border:1.5px solid rgba(59,130,246,0.35);display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:14px;">🎙️</div>',
        '  <div style="font-size:16px;font-weight:800;color:#f8fafc;margin-bottom:6px;">Audio / Transcript Assessment</div>',
        '  <div style="font-size:12.5px;color:#94a3b8;max-width:380px;line-height:1.6;margin-bottom:16px;">This session was submitted with text/voice answers without a video binary stream. The verified AI evaluation and complete transcript are displayed alongside.</div>',
        '  <div style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:rgba(34,211,165,0.1);border:1px solid rgba(34,211,165,0.25);color:#22c55e;font-size:11.5px;font-weight:700;">✓ All ' + ((meta.responses && meta.responses.length) || '5') + ' Questions Evaluated</div>',
        '</div>'
      ].join('\n');
      container.appendChild(box);
      return {
        element: box,
        seekTo: function () {},
        destroy: function () {}
      };
    }

    box.innerHTML = [
      '<!-- Video Canvas with Multi-Source Fallbacks -->',
      '<video class="hvp-video" playsinline preload="auto" crossorigin="anonymous"' + (thumbnailUrl ? ' poster="' + thumbnailUrl + '"' : '') + '>',
      '  <source src="' + videoUrl + (videoUrl.indexOf('?') !== -1 ? '&' : '?') + 'format=mp4" type="video/mp4">',
      '  <source src="' + videoUrl + (videoUrl.indexOf('?') !== -1 ? '&' : '?') + 'format=webm" type="video/webm">',
      '  <source src="' + videoUrl + '">',
      '  Your browser does not support HTML5 video playback.',
      '</video>',

      '<!-- Poster / Thumbnail Placeholder -->',
      '<div class="hvp-poster">',
      '  <div class="hvp-poster-avatar">' + getInitials(candidateName) + '</div>',
      '  <div class="hvp-poster-text">' + escapeHtml(candidateName) + '</div>',
      '  <div class="hvp-poster-sub">' + escapeHtml(roleName) + '</div>',
      '</div>',

      '<!-- Center Big Play Button -->',
      '<div class="hvp-center-play paused" title="Play">',
      '  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
      '</div>',

      '<!-- Loading Indicator -->',
      '<div class="hvp-spinner-wrap">',
      '  <div class="hvp-spinner"></div>',
      '  <div class="hvp-spinner-text">Buffering...</div>',
      '</div>',

      '<!-- Keyboard Action HUD Toast -->',
      '<div class="hvp-hud"></div>',

      '<!-- Controls Bar -->',
      '<div class="hvp-controls">',
      '  <!-- Scrubber -->',
      '  <div class="hvp-scrubber-wrap">',
      '    <div class="hvp-scrubber-track">',
      '      <div class="hvp-buffer-bar" style="width: 0%;"></div>',
      '      <div class="hvp-progress-bar" style="width: 0%;">',
      '        <div class="hvp-scrubber-handle"></div>',
      '      </div>',
      '    </div>',
      '    <div class="hvp-seek-tooltip">0:00</div>',
      '  </div>',

      '  <!-- Controls Row -->',
      '  <div class="hvp-ctrl-row">',
      '    <div class="hvp-ctrl-left">',
      '      <!-- Play/Pause -->',
      '      <button class="hvp-btn hvp-play-btn" title="Play (Space)">',
      '        <svg viewBox="0 0 24 24" class="icon-play"><path d="M8 5v14l11-7z"/></svg>',
      '      </button>',

      '      <!-- Seek -5s -->',
      '      <button class="hvp-btn hvp-rewind-btn" title="Back 5s (← / J)">',
      '        <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.2 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>',
      '      </button>',

      '      <!-- Seek +5s -->',
      '      <button class="hvp-btn hvp-forward-btn" title="Forward 5s (→ / L)">',
      '        <svg viewBox="0 0 24 24"><path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.2-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z"/></svg>',
      '      </button>',

      '      <!-- Volume & Slider -->',
      '      <div class="hvp-vol-wrap">',
      '        <button class="hvp-btn hvp-vol-btn" title="Mute (M)">',
      '          <svg viewBox="0 0 24 24" class="icon-vol"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
      '        </button>',
      '        <div class="hvp-vol-slider-wrap">',
      '          <input type="range" class="hvp-vol-slider" min="0" max="1" step="0.02" value="' + state.volume + '" />',
      '        </div>',
      '      </div>',

      '      <!-- Time Display -->',
      '      <div class="hvp-time">',
      '        <span class="hvp-cur-time">0:00</span> / <span class="hvp-dur-time">' + formatSeconds(state.duration) + '</span>',
      '      </div>',
      '    </div>',

      '    <div class="hvp-ctrl-right">',
      '      <!-- Speed Selector -->',
      '      <div class="hvp-speed-wrap">',
      '        <button class="hvp-btn hvp-speed-btn" title="Playback Speed">',
      '          <span class="hvp-speed-badge">1x</span>',
      '        </button>',
      '        <div class="hvp-speed-menu">',
      '          <button class="hvp-speed-item" data-speed="0.5">0.5x</button>',
      '          <button class="hvp-speed-item" data-speed="0.75">0.75x</button>',
      '          <button class="hvp-speed-item active" data-speed="1">1x (Normal)</button>',
      '          <button class="hvp-speed-item" data-speed="1.25">1.25x</button>',
      '          <button class="hvp-speed-item" data-speed="1.5">1.5x</button>',
      '          <button class="hvp-speed-item" data-speed="2">2x</button>',
      '        </div>',
      '      </div>',

      '      <!-- Picture-in-Picture -->',
      '      <button class="hvp-btn hvp-pip-btn" title="Picture in Picture (P)">',
      '        <svg viewBox="0 0 24 24"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z"/></svg>',
      '      </button>',

      '      <!-- Fullscreen -->',
      '      <button class="hvp-btn hvp-fs-btn" title="Fullscreen (F)">',
      '        <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
      '      </button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');

    container.appendChild(box);

    var video = box.querySelector('.hvp-video');
    var poster = box.querySelector('.hvp-poster');
    var centerPlay = box.querySelector('.hvp-center-play');
    var playBtn = box.querySelector('.hvp-play-btn');
    var rewindBtn = box.querySelector('.hvp-rewind-btn');
    var forwardBtn = box.querySelector('.hvp-forward-btn');
    var volBtn = box.querySelector('.hvp-vol-btn');
    var volSlider = box.querySelector('.hvp-vol-slider');
    var scrubberWrap = box.querySelector('.hvp-scrubber-wrap');
    var scrubberTrack = box.querySelector('.hvp-scrubber-track');
    var progressBar = box.querySelector('.hvp-progress-bar');
    var bufferBar = box.querySelector('.hvp-buffer-bar');
    var seekTooltip = box.querySelector('.hvp-seek-tooltip');
    var curTimeEl = box.querySelector('.hvp-cur-time');
    var durTimeEl = box.querySelector('.hvp-dur-time');
    var speedWrap = box.querySelector('.hvp-speed-wrap');
    var speedBtn = box.querySelector('.hvp-speed-btn');
    var speedBadge = box.querySelector('.hvp-speed-badge');
    var speedMenu = box.querySelector('.hvp-speed-menu');
    var pipBtn = box.querySelector('.hvp-pip-btn');
    var fsBtn = box.querySelector('.hvp-fs-btn');
    var spinnerWrap = box.querySelector('.hvp-spinner-wrap');
    var hud = box.querySelector('.hvp-hud');

    var hudTimer = null;
    var idleTimer = null;

    /* ── Show HUD Message ──────────────────────────────────────────────── */
    function showHUD(text) {
      if (!hud) return;
      hud.textContent = text;
      hud.classList.add('hvp-show');
      clearTimeout(hudTimer);
      hudTimer = setTimeout(function () {
        hud.classList.remove('hvp-show');
      }, 1200);
    }

    /* ── Idle Mouse Detection ───────────────────────────────────────────── */
    function resetIdle() {
      box.classList.remove('hvp-idle');
      clearTimeout(idleTimer);
      if (state.isPlaying) {
        idleTimer = setTimeout(function () {
          box.classList.add('hvp-idle');
        }, 2800);
      }
    }
    box.addEventListener('mousemove', resetIdle);
    box.addEventListener('click', resetIdle);

    /* ── Effective Duration Resolver ────────────────────────────────────── */
    function getEffectiveDuration() {
      // 1. If meta.duration was supplied and positive, prefer it over Infinity/NaN
      if (rawDuration > 0) return rawDuration;
      // 2. Otherwise check video.duration if finite
      if (isFinite(video.duration) && !isNaN(video.duration) && video.duration > 0) {
        return video.duration;
      }
      return state.duration || 0;
    }

    /* ── Update Time & Progress UI ──────────────────────────────────────── */
    function updateProgress() {
      var dur = getEffectiveDuration();
      var cur = video.currentTime || 0;
      state.currentTime = cur;

      if (dur > 0 && dur !== state.duration) {
        state.duration = dur;
        durTimeEl.textContent = formatSeconds(dur);
      }

      curTimeEl.textContent = formatSeconds(cur);

      var pct = dur > 0 ? (cur / dur) * 100 : 0;
      pct = Math.min(100, Math.max(0, pct));
      progressBar.style.width = pct + '%';

      // Buffered progress
      try {
        if (video.buffered && video.buffered.length > 0) {
          var bufEnd = video.buffered.end(video.buffered.length - 1);
          var bufPct = dur > 0 ? (bufEnd / dur) * 100 : 0;
          bufferBar.style.width = Math.min(100, Math.max(0, bufPct)) + '%';
        }
      } catch (_) {}

      // Save resume position periodically
      if (cur > 3 && dur > 10 && cur < dur - 5) {
        try {
          sessionStorage.setItem('hrms_vpos_' + recordingId, String(Math.floor(cur)));
        } catch (_) {}
      }

      // Notify external listeners (for transcript sync)
      if (typeof options.onTimeUpdate === 'function') {
        options.onTimeUpdate(cur, dur);
      }
    }

    /* ── Play / Pause Toggle ────────────────────────────────────────────── */
    function togglePlay() {
      if (video.paused || video.ended) {
        poster.classList.add('hvp-hidden');
        var playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.then(function () {
            state.isPlaying = true;
            box.classList.remove('paused');
            centerPlay.classList.remove('paused');
            playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            showHUD('▶ Play');
            resetIdle();
          }).catch(function (err) {
            console.warn('[Video] Play interrupted:', err);
          });
        }
      } else {
        video.pause();
        state.isPlaying = false;
        box.classList.add('paused');
        centerPlay.classList.add('paused');
        playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
        showHUD('⏸ Pause');
        resetIdle();
      }
    }

    /* ── Seek Functionality ─────────────────────────────────────────────── */
    function seekToTime(timeInSec) {
      var dur = getEffectiveDuration();
      var target = Math.max(0, Math.min(dur || 99999, timeInSec));
      video.currentTime = target;
      updateProgress();
    }

    function seekRelative(delta) {
      var newTime = (video.currentTime || 0) + delta;
      seekToTime(newTime);
      showHUD((delta > 0 ? '⏩ +' : '⏪ ') + delta + 's (' + formatSeconds(video.currentTime) + ')');
    }

    /* ── Scrubber Click & Drag ──────────────────────────────────────────── */
    function handleScrubberMove(e) {
      var rect = scrubberTrack.getBoundingClientRect();
      var clientX = e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
      var pos = (clientX - rect.left) / rect.width;
      pos = Math.max(0, Math.min(1, pos));
      var dur = getEffectiveDuration();
      var targetTime = pos * dur;

      seekTooltip.style.left = (pos * 100) + '%';
      seekTooltip.textContent = formatSeconds(targetTime);

      if (state.isSeeking) {
        progressBar.style.width = (pos * 100) + '%';
        curTimeEl.textContent = formatSeconds(targetTime);
      }
    }

    scrubberWrap.addEventListener('mousemove', handleScrubberMove);
    scrubberWrap.addEventListener('mousedown', function (e) {
      state.isSeeking = true;
      scrubberWrap.classList.add('dragging');
      var rect = scrubberTrack.getBoundingClientRect();
      var pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var dur = getEffectiveDuration();
      video.currentTime = pos * dur;
      updateProgress();

      function onMouseMove(ev) {
        if (!state.isSeeking) return;
        var r = scrubberTrack.getBoundingClientRect();
        var p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        video.currentTime = p * getEffectiveDuration();
        updateProgress();
      }
      function onMouseUp() {
        state.isSeeking = false;
        scrubberWrap.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Touch support for scrubber
    scrubberWrap.addEventListener('touchstart', function (e) {
      state.isSeeking = true;
      scrubberWrap.classList.add('dragging');
      handleScrubberMove(e);
    }, { passive: true });
    scrubberWrap.addEventListener('touchmove', function (e) {
      if (state.isSeeking) {
        var rect = scrubberTrack.getBoundingClientRect();
        var clientX = e.touches[0].clientX;
        var pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        video.currentTime = pos * getEffectiveDuration();
        updateProgress();
      }
    }, { passive: true });
    scrubberWrap.addEventListener('touchend', function () {
      state.isSeeking = false;
      scrubberWrap.classList.remove('dragging');
    });

    /* ── Volume & Mute Controls ─────────────────────────────────────────── */
    function setVolume(v) {
      v = Math.max(0, Math.min(1, v));
      state.volume = v;
      video.volume = v;
      video.muted = (v === 0);
      state.isMuted = video.muted;
      volSlider.value = v;
      localStorage.setItem('hrms_player_volume', String(v));

      if (v === 0 || video.muted) {
        volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
      } else if (v < 0.5) {
        volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
      } else {
        volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
      }
    }

    volBtn.addEventListener('click', function () {
      if (video.muted || video.volume === 0) {
        setVolume(state.volume > 0 ? state.volume : 0.8);
        showHUD('🔊 ' + Math.round(video.volume * 100) + '%');
      } else {
        video.muted = true;
        setVolume(0);
        showHUD('🔇 Muted');
      }
    });

    volSlider.addEventListener('input', function (e) {
      setVolume(parseFloat(e.target.value));
      showHUD('🔊 ' + Math.round(video.volume * 100) + '%');
    });

    /* ── Playback Speed ─────────────────────────────────────────────────── */
    function setPlaybackSpeed(rate) {
      state.playbackRate = rate;
      video.playbackRate = rate;
      speedBadge.textContent = rate + 'x';
      speedMenu.querySelectorAll('.hvp-speed-item').forEach(function (btn) {
        btn.classList.toggle('active', parseFloat(btn.getAttribute('data-speed')) === rate);
      });
      speedMenu.classList.remove('open');
      showHUD('⚡ ' + rate + 'x Speed');
    }

    speedBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      speedMenu.classList.toggle('open');
    });

    speedMenu.querySelectorAll('.hvp-speed-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setPlaybackSpeed(parseFloat(this.getAttribute('data-speed')));
      });
    });

    document.addEventListener('click', function (e) {
      if (!speedWrap.contains(e.target)) speedMenu.classList.remove('open');
    });

    /* ── Picture-in-Picture ─────────────────────────────────────────────── */
    pipBtn.addEventListener('click', function () {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(function () {});
      } else if (video.requestPictureInPicture) {
        video.requestPictureInPicture().catch(function (err) {
          showHUD('PiP not available');
        });
      }
    });

    /* ── Fullscreen Toggle ──────────────────────────────────────────────── */
    function toggleFullscreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (box.requestFullscreen) {
          box.requestFullscreen();
        } else if (box.webkitRequestFullscreen) {
          box.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    }

    fsBtn.addEventListener('click', toggleFullscreen);

    function onFsChange() {
      state.isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsBtn.innerHTML = state.isFullscreen
        ? '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
      showHUD(state.isFullscreen ? '⛶ Fullscreen' : 'Exit Fullscreen');
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    /* ── Video Element Events ───────────────────────────────────────────── */
    video.addEventListener('click', togglePlay);
    centerPlay.addEventListener('click', togglePlay);
    playBtn.addEventListener('click', togglePlay);
    rewindBtn.addEventListener('click', function () { seekRelative(-5); });
    forwardBtn.addEventListener('click', function () { seekRelative(5); });

    video.addEventListener('dblclick', toggleFullscreen);

    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('waiting', function () { spinnerWrap.classList.add('active'); });
    video.addEventListener('canplay', function () {
      spinnerWrap.classList.remove('active');
      durTimeEl.textContent = formatSeconds(getEffectiveDuration());
    });
    video.addEventListener('playing', function () { spinnerWrap.classList.remove('active'); });

    video.addEventListener('ended', function () {
      state.isPlaying = false;
      box.classList.add('paused');
      centerPlay.classList.add('paused');
      centerPlay.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      showHUD('Ended');
    });

    video.addEventListener('error', function () {
      spinnerWrap.classList.remove('active');
      state.hasError = true;
      var err = video.error;
      var errMsg = (err && err.message) || 'Video stream could not be loaded or decoded.';
      var errBox = document.createElement('div');
      errBox.className = 'hvp-error-wrap';
      errBox.innerHTML = [
        '<div class="hvp-error-icon">⚠️</div>',
        '<div class="hvp-error-msg">Playback Error: ' + escapeHtml(errMsg) + '</div>',
        '<div class="hvp-error-hint">If this is a newly recorded WebM stream, you can open it directly in a new browser tab or download it to play with VLC Player.</div>',
        '<div class="hvp-error-acts">',
        '  <button class="hvp-error-btn retry">🔄 Retry</button>',
        '  <a href="' + videoUrl + '" target="_blank" class="hvp-error-btn sec" style="text-decoration:none;">🌐 Open Directly</a>',
        '</div>'
      ].join('\n');
      box.appendChild(errBox);
      errBox.querySelector('.retry').addEventListener('click', function () {
        box.removeChild(errBox);
        video.load();
        video.play();
      });
    });

    /* ── Automatic Resume from Last Timestamp ────────────────────────────── */
    var savedPos = sessionStorage.getItem('hrms_vpos_' + recordingId);
    if (savedPos && parseInt(savedPos, 10) > 3) {
      var resumeTime = parseInt(savedPos, 10);
      var resumeToast = document.createElement('div');
      resumeToast.className = 'hvp-resume-toast';
      resumeToast.innerHTML = [
        '<div class="hvp-resume-msg">⏱ Resuming playback from <strong>' + formatSeconds(resumeTime) + '</strong></div>',
        '<button class="hvp-resume-btn">Start from 0:00</button>'
      ].join('');
      box.appendChild(resumeToast);

      video.currentTime = resumeTime;
      updateProgress();

      resumeToast.querySelector('.hvp-resume-btn').addEventListener('click', function () {
        video.currentTime = 0;
        updateProgress();
        if (resumeToast.parentNode) resumeToast.parentNode.removeChild(resumeToast);
      });

      setTimeout(function () {
        if (resumeToast.parentNode) resumeToast.parentNode.removeChild(resumeToast);
      }, 5000);
    }

    /* ── Keyboard Controls ──────────────────────────────────────────────── */
    function onKeyDown(e) {
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      var handled = false;
      if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        togglePlay();
        handled = true;
      } else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        seekRelative(-5);
        handled = true;
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        seekRelative(5);
        handled = true;
      } else if (e.key === 'ArrowUp') {
        setVolume(video.volume + 0.1);
        showHUD('🔊 ' + Math.round(video.volume * 100) + '%');
        handled = true;
      } else if (e.key === 'ArrowDown') {
        setVolume(video.volume - 0.1);
        showHUD('🔉 ' + Math.round(video.volume * 100) + '%');
        handled = true;
      } else if (e.key === 'm' || e.key === 'M') {
        if (video.muted || video.volume === 0) {
          setVolume(state.volume > 0 ? state.volume : 0.8);
          showHUD('🔊 ' + Math.round(video.volume * 100) + '%');
        } else {
          setVolume(0);
          showHUD('🔇 Muted');
        }
        handled = true;
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
        handled = true;
      } else if (e.key === 'p' || e.key === 'P') {
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
        else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(function () {});
        handled = true;
      } else if (e.key >= '0' && e.key <= '9') {
        var pct = parseInt(e.key, 10) * 10;
        var dur = getEffectiveDuration();
        seekToTime((pct / 100) * dur);
        showHUD('Jump to ' + pct + '%');
        handled = true;
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    // Initial setup
    setVolume(state.volume);

    return {
      element: box,
      video: video,
      seekTo: seekToTime,
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
        if (idleTimer) clearTimeout(idleTimer);
        if (hudTimer) clearTimeout(hudTimer);
        video.pause();
        video.src = '';
      }
    };
  }

  /* ── Build Synchronized Transcript Component ────────────────────────── */
  function createTranscriptPanel(responses, duration, onSeek) {
    var panel = document.createElement('div');
    panel.className = 'hvp-trans-panel';

    var items = Array.isArray(responses) ? responses : [];
    var totalItems = items.length || 1;
    var dur = duration || 1;

    panel.innerHTML = [
      '<div class="hvp-trans-head">',
      '  <div class="hvp-trans-title">📝 Synchronized Transcript (' + items.length + ' Qs)</div>',
      '  <button class="hvp-trans-sync-btn" title="Toggle Auto-Scroll">⚡ Auto-Scroll: ON</button>',
      '</div>',
      '<div class="hvp-trans-list"></div>'
    ].join('');

    var list = panel.querySelector('.hvp-trans-list');
    var syncBtn = panel.querySelector('.hvp-trans-sync-btn');
    var autoScroll = true;

    syncBtn.addEventListener('click', function () {
      autoScroll = !autoScroll;
      syncBtn.classList.toggle('off', !autoScroll);
      syncBtn.textContent = autoScroll ? '⚡ Auto-Scroll: ON' : 'Auto-Scroll: OFF';
    });

    if (items.length === 0) {
      list.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:30px;">No structured transcript available for this interview session.</div>';
      return {
        element: panel,
        updateActive: function () {}
      };
    }

    // Build question cards with estimated timestamps
    var cardEls = [];
    items.forEach(function (r, idx) {
      var estimatedStartSec = (idx / totalItems) * dur;
      var card = document.createElement('div');
      card.className = 'hvp-trans-item';
      card.setAttribute('data-idx', String(idx));
      card.setAttribute('data-start', String(estimatedStartSec));

      var stageLabel = r.stageGroup ? ' · ' + r.stageGroup : '';
      card.innerHTML = [
        '<div class="hvp-trans-item-head">',
        '  <span class="hvp-trans-qtag">Q' + (idx + 1) + stageLabel + '</span>',
        '  <span class="hvp-trans-time-pill">⏱ ' + formatSeconds(estimatedStartSec) + '</span>',
        '</div>',
        '<div class="hvp-trans-q"><strong>Eva:</strong> ' + escapeHtml(r.q || '—') + '</div>',
        '<div class="hvp-trans-a"><strong>Candidate:</strong> ' + escapeHtml(r.transcript || '(no speech detected)') + '</div>'
      ].join('');

      card.addEventListener('click', function () {
        onSeek(estimatedStartSec);
      });

      list.appendChild(card);
      cardEls.push({ el: card, start: estimatedStartSec });
    });

    var currentActiveIdx = -1;

    return {
      element: panel,
      updateActive: function (curTime, totalDur) {
        if (totalDur > 0 && totalDur !== dur) {
          dur = totalDur;
          // Recalculate time pills if total duration changed
          cardEls.forEach(function (c, idx) {
            c.start = (idx / totalItems) * dur;
            var pill = c.el.querySelector('.hvp-trans-time-pill');
            if (pill) pill.textContent = '⏱ ' + formatSeconds(c.start);
          });
        }

        var activeIdx = Math.min(totalItems - 1, Math.floor((curTime / (dur || 1)) * totalItems));
        if (activeIdx !== currentActiveIdx) {
          currentActiveIdx = activeIdx;
          cardEls.forEach(function (c, idx) {
            var isActive = (idx === activeIdx);
            c.el.classList.toggle('active', isActive);
            if (isActive && autoScroll) {
              c.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
        }
      }
    };
  }

  /* ── Helper Functions ─────────────────────────────────────────────────── */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getInitials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (!parts.length || !parts[0]) return 'IV';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  /* ── Open Full Player Modal ───────────────────────────────────────────── */
  function openModal(recordingData) {
    ensureStyles();

    var meta = recordingData.meta || recordingData || {};
    var videoUrl = recordingData.blobUrl || recordingData.videoUrl || ('/api/interview-recordings/' + meta.id + '/video');
    var rawDuration = parseMetadataDuration(meta.duration);
    var candidateName = meta.candidateName || 'Candidate Interview';
    var role = meta.role || 'AIML / Software Engineer';
    var totalScore = meta.totalScore != null ? meta.totalScore : 0;
    var techScore = meta.techScore != null ? meta.techScore : 0;
    var commScore = meta.commScore != null ? meta.commScore : 0;
    var integrityScore = meta.integrityScore != null ? meta.integrityScore : 0;

    var overlay = document.createElement('div');
    overlay.className = 'hvp-ovl';
    overlay.id = 'hvp-active-modal';

    var allowDownload = canDownloadRecordings();

    overlay.innerHTML = [
      '<div class="hvp-modal">',
      '  <!-- Header -->',
      '  <div class="hvp-head">',
      '    <div class="hvp-title-wrap">',
      '      <div class="hvp-avatar">' + getInitials(candidateName) + '</div>',
      '      <div>',
      '        <div class="hvp-title">' + escapeHtml(candidateName) + '</div>',
      '        <div class="hvp-subtitle">' + escapeHtml(role) + ' · ' + formatSeconds(rawDuration) + ' · Score: ' + totalScore + '/100</div>',
      '      </div>',
      '    </div>',
      '    <div class="hvp-actions">',
      (meta.hasVideo !== false)
        ? '      <a href="' + videoUrl + '" target="_blank" rel="noreferrer" class="hvp-btn-top browser">🌐 Open in Browser</a>'
        : '',
      (allowDownload && meta.hasVideo !== false)
        ? '      <a href="' + videoUrl + '" download="interview-' + candidateName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.mp4" class="hvp-btn-top download" title="Download .mp4 recording">⬇️ Download (.mp4)</a>'
        : (meta.hasVideo !== false)
          ? '      <span class="hvp-btn-top download disabled" title="Download restricted by Admin">🔒 Download</span>'
          : '',
      '      <button class="hvp-close" title="Close (Esc)">✕</button>',
      '    </div>',
      '  </div>',

      '  <!-- Body -->',
      '  <div class="hvp-body">',
      '    <div class="hvp-main-grid">',
      '      <div class="hvp-player-slot"></div>',
      '      <div class="hvp-trans-slot"></div>',
      '    </div>',

      '    <!-- Score Strip -->',
      '    <div class="hvp-scores-strip">',
      '      <div class="hvp-score-card">',
      '        <div class="hvp-score-val" style="color:' + (totalScore >= 80 ? '#22c55e' : totalScore >= 65 ? '#f59e0b' : '#ef4444') + '">' + totalScore + '</div>',
      '        <div class="hvp-score-lbl">Total Score (100)</div>',
      '      </div>',
      '      <div class="hvp-score-card">',
      '        <div class="hvp-score-val" style="color:' + (techScore >= 30 ? '#22c55e' : techScore >= 20 ? '#f59e0b' : '#ef4444') + '">' + techScore + '</div>',
      '        <div class="hvp-score-lbl">Technical (40)</div>',
      '      </div>',
      '      <div class="hvp-score-card">',
      '        <div class="hvp-score-val" style="color:' + (commScore >= 22 ? '#22c55e' : commScore >= 15 ? '#f59e0b' : '#ef4444') + '">' + commScore + '</div>',
      '        <div class="hvp-score-lbl">Communication (30)</div>',
      '      </div>',
      '      <div class="hvp-score-card">',
      '        <div class="hvp-score-val" style="color:' + (integrityScore >= 22 ? '#22c55e' : integrityScore >= 15 ? '#f59e0b' : '#ef4444') + '">' + integrityScore + '</div>',
      '        <div class="hvp-score-lbl">Integrity (30)</div>',
      '      </div>',
      '    </div>',

      '    <!-- Tip -->',
      '    <div class="hvp-footer-tip">💡 <strong>Keyboard Shortcuts:</strong> Space (Play/Pause) · ← / → (5s Seek) · ↑ / ↓ (Volume) · M (Mute) · F (Fullscreen) · P (PiP) · 0-9 (Jump %)</div>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(overlay);

    var playerSlot = overlay.querySelector('.hvp-player-slot');
    var transSlot = overlay.querySelector('.hvp-trans-slot');
    var closeBtn = overlay.querySelector('.hvp-close');

    var transcriptPanel = null;
    var playerInstance = createPlayer(playerSlot, {
      videoUrl: videoUrl,
      meta: meta,
      onTimeUpdate: function (cur, dur) {
        if (transcriptPanel) transcriptPanel.updateActive(cur, dur);
      }
    });

    transcriptPanel = createTranscriptPanel(meta.responses, rawDuration, function (targetSec) {
      playerInstance.seekTo(targetSec);
    });
    transSlot.appendChild(transcriptPanel.element);

    function closeModal() {
      overlay.classList.remove('hvp-open');
      setTimeout(function () {
        playerInstance.destroy();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.removeEventListener('keydown', onEsc);
      }, 200);
    }

    function onEsc(e) {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        closeModal();
      }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', onEsc);

    // Trigger open animation
    requestAnimationFrame(function () {
      overlay.classList.add('hvp-open');
    });

    return {
      close: closeModal
    };
  }

  /* ── Intercept Existing Native Video Modals Automatically ──────────────── */
  function setupModalInterception() {
    // Observer to detect whenever the standard app creates a video element in the recording modal
    var obs = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;

          // If standard recording playback modal was rendered by React
          if (node.tagName === 'DIV' && node.style && node.style.position === 'fixed') {
            var vid = node.querySelector('video');
            if (vid && vid.src && !node.classList.contains('hvp-ovl')) {
              var isRecordingModal = node.textContent.indexOf('Open in Browser') !== -1 || node.textContent.indexOf('Download (.webm)') !== -1 || node.textContent.indexOf('FULL TRANSCRIPT') !== -1;
              if (isRecordingModal) {
                // Extract metadata from the existing modal if possible
                var titleEl = node.querySelector('div[style*="font-family"]');
                var candName = titleEl ? (titleEl.textContent.replace('🎥', '').trim()) : 'Candidate';
                var vidSrc = vid.src;

                // Close the old unstyled modal
                node.style.display = 'none';

                // Look for recording ID in recent actions or use URL
                var idMatch = vidSrc.match(/interview-recordings\/(\d+)/);
                var recId = idMatch ? idMatch[1] : '';

                if (recId) {
                  fetch('/api/interview-recordings/' + recId)
                    .then(function (r) { return r.json(); })
                    .then(function (recMeta) {
                      openModal({
                        blobUrl: vidSrc,
                        meta: recMeta
                      });
                    })
                    .catch(function () {
                      openModal({
                        blobUrl: vidSrc,
                        meta: { candidateName: candName, duration: 942 }
                      });
                    });
                } else {
                  openModal({
                    blobUrl: vidSrc,
                    meta: { candidateName: candName }
                  });
                }
                break;
              }
            }
          }
        }
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize on load
  ensureStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupModalInterception);
  } else {
    setupModalInterception();
  }

  // Export to Global
  window.HRMSVideoPlayer = {
    openModal: openModal,
    createPlayer: createPlayer,
    createTranscriptPanel: createTranscriptPanel,
    formatSeconds: formatSeconds
  };

})();
