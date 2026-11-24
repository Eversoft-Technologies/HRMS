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

  /* Speech-recognition watchdog.
   *
   * Chrome's recognizer sometimes stalls without ending or erroring: the
   * candidate keeps talking and nothing appears. __hrmsSpeechWatch(rec, stream)
   * watches the microphone level; if the candidate has been speaking for ~2 s
   * and the recognizer has produced no result for 5 s, it is aborted. The
   * interview page's end handler then restarts it at once, keeping the text
   * gathered so far. The watch stops by itself when the recognizer is stopped.
   */
  window.__hrmsSpeechWatch = function (rec, stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
      if (!AC || !tracks.length) return;
      var c = new AC();
      var an = c.createAnalyser();
      an.fftSize = 1024;
      c.createMediaStreamSource(new MediaStream([tracks[0]])).connect(an);
      var buf = new Float32Array(an.fftSize);
      var loud = 0, lastResult = Date.now();
      var prevResult = rec.onresult, prevStart = rec.onstart;
      rec.onresult = function () { lastResult = Date.now(); return prevResult && prevResult.apply(this, arguments); };
      rec.onstart = function () { lastResult = Date.now(); return prevStart && prevStart.apply(this, arguments); };
      var timer = setInterval(function () {
        if (rec.__stopped) { clearInterval(timer); try { c.close(); } catch (e) {} return; }
        if (!rec.__running) { loud = 0; return; }
        an.getFloatTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        loud = Math.sqrt(sum / buf.length) > 0.015 ? loud + 1 : 0;
        if (loud >= 4 && Date.now() - lastResult > 5000) {
          console.warn('[Speech] recognizer stalled while the candidate was speaking; restarting it');
          loud = 0;
          lastResult = Date.now();
          try { rec.abort(); } catch (e) {}
        }
      }, 500);
    } catch (e) {
      console.warn('[Speech] watchdog not started', e);
    }
  };

  /* On-device speech recognition (Chrome 139+).
   *
   * The default recognizer streams the microphone to Google and waits for text
   * to come back, so words appear late and long answers lose pieces whenever
   * the network hiccups. Chrome can instead recognise on the laptop itself:
   * no round trip, no network drops. __hrmsSpeechPrep() (called when the
   * interview starts, a user gesture) asks the browser whether an on-device
   * model exists for the candidate's language and, if it can be downloaded,
   * installs it. __hrmsSpeechLocalLang() then returns the language to use, or
   * null to keep the cloud recognizer. Anything unsupported or failing leaves
   * the interview exactly as it was. Set speechLocal:false in __HRMS_CONFIG__
   * to switch this off.
   */
  var localLang = null, prepared = false;
  window.__hrmsSpeechPrep = function () {
    if (prepared) return;
    prepared = true;
    try {
      var cfg = window.__HRMS_CONFIG__ || {};
      if (cfg.speechLocal === false) return;
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR || !SR.available || !SR.prototype || !('processLocally' in SR.prototype)) return;
      var langs = [cfg.speechLang || 'en-IN', 'en-US'];
      (function next(i) {
        if (i >= langs.length) return;
        var lang = langs[i];
        Promise.resolve(SR.available({ langs: [lang], processLocally: true })).then(function (status) {
          if (status === 'available') {
            localLang = lang;
            console.info('[Speech] on-device recognition ready (' + lang + ')');
          } else if ((status === 'downloadable' || status === 'downloading') && SR.install) {
            return Promise.resolve(SR.install({ langs: [lang], processLocally: true })).then(function (ok) {
              if (ok === false) return next(i + 1);
              localLang = lang;
              console.info('[Speech] on-device model installed (' + lang + ')');
            });
          } else {
            next(i + 1);
          }
        }).catch(function (e) { console.warn('[Speech] on-device check failed:', e && e.message); });
      })(0);
    } catch (e) {
      console.warn('[Speech] on-device setup skipped', e);
    }
  };
  window.__hrmsSpeechLocalLang = function () { return localLang; };
  window.__hrmsSpeechNoLocal = function () { localLang = null; };

  /* Bias the on-device recognizer towards the words this question is about
   * (technologies, concepts), so "FastAPI" is not heard as "fast API". */
  window.__hrmsSpeechBias = function (rec, words) {
    try {
      if (!window.SpeechRecognitionPhrase || !('phrases' in rec)) return;
      rec.phrases = (words || []).slice(0, 30).map(function (w) { return new window.SpeechRecognitionPhrase(String(w), 3.0); });
    } catch (e) {}
  };
})();
