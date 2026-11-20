/* Eva's voice in the interview recording.
 *
 * The browser's speechSynthesis cannot be captured by a MediaRecorder, so a
 * recording made with earphones or Bluetooth had no trace of Eva, and with
 * speakers only a faint echo through the microphone. Eva's lines are now
 * fetched as audio from /api/eva-tts and played through a Web Audio graph
 * that feeds BOTH the speakers and the recorder, alongside the microphone.
 *
 *  - __hrmsEvaMix(stream)        camera+mic stream -> stream whose audio track
 *                                is mic + Eva, for the MediaRecorder
 *  - __hrmsEvaSpeak(text, onend) plays a line; resolves false when the audio
 *                                could not be fetched (caller then falls back
 *                                to speechSynthesis, unrecorded as before)
 *  - __hrmsEvaCancel()           stops the current line (fires its onend, like
 *                                speechSynthesis.cancel does)
 *  - __hrmsEvaPrefetch(texts)    warms the cache for the questions to come
 *
 * Called from the interview screen in the React bundle.
 */
(function () {
  'use strict';

  var ctx = null;        // AudioContext shared by playback and recording
  var dest = null;       // MediaStreamDestination the recorder listens to
  var current = null;    // BufferSource of the line being spoken
  var cache = {};        // text -> Promise<AudioBuffer>
  var seq = 0;           // bumps on every speak/cancel so stale fetches are ignored

  function audioCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  function fetchAudio(text) {
    if (!cache[text]) {
      cache[text] = fetch('/api/eva-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      }).then(function (r) {
        if (!r.ok) throw new Error('eva-tts ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var c = audioCtx();
        if (!c) throw new Error('no AudioContext');
        return c.decodeAudioData(buf.slice(0));
      });
      cache[text].catch(function () { delete cache[text]; });
    }
    return cache[text];
  }

  window.__hrmsEvaMix = function (stream) {
    try {
      var c = audioCtx();
      if (!c || !stream || !stream.getAudioTracks) return stream;
      dest = c.createMediaStreamDestination();
      var mic = stream.getAudioTracks();
      if (mic.length) {
        // Same track object, so the mute button on the original stream still applies.
        c.createMediaStreamSource(new MediaStream([mic[0]])).connect(dest);
      }
      return new MediaStream(stream.getVideoTracks().concat(dest.stream.getAudioTracks()));
    } catch (e) {
      console.warn('[EvaVoice] could not mix Eva into the recording; recording mic only', e);
      return stream;
    }
  };

  window.__hrmsEvaPrefetch = function (texts) {
    (texts || []).forEach(function (t) {
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (t) fetchAudio(t).catch(function () {});
    });
  };

  window.__hrmsEvaCancel = function () {
    seq++;
    var src = current;
    current = null;
    if (src) {
      var cb = src.__onend;
      src.__onend = null;
      try { src.onended = null; src.stop(); } catch (e) {}
      if (cb) setTimeout(cb, 0);
    }
  };

  window.__hrmsEvaSpeak = function (text, onend) {
    window.__hrmsEvaCancel();
    var my = ++seq;
    text = String(text || '').replace(/\s+/g, ' ').trim();
    var c = audioCtx();
    if (!c || !text) return Promise.resolve(false);
    return fetchAudio(text).then(function (buffer) {
      if (my !== seq) return true;               // cancelled while loading: handled, nothing to play
      var src = c.createBufferSource();
      src.buffer = buffer;
      src.connect(c.destination);                 // speakers / earphones
      if (dest) src.connect(dest);                // the recording
      src.__onend = onend || null;
      src.onended = function () {
        if (current !== src) return;
        current = null;
        var cb = src.__onend;
        src.__onend = null;
        if (cb) cb();
      };
      current = src;
      src.start();
      return true;
    }).catch(function (e) {
      console.warn('[EvaVoice] falling back to browser speech (not recorded):', e && e.message);
      return false;
    });
  };
})();
