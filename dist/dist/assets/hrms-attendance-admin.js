/*
 * HRMS Attendance Administration — geofences, shifts and off-site reviews.
 *
 * The Django API for all three has existed for a while but nothing in the React
 * bundle ever called it: there was no way to define an office location, no way
 * to give anyone a shift other than the hard-coded "General Shift", and no way
 * to action an out-of-office check-in. This adds that surface as a sidecar, the
 * same pattern hrms-rbac.js and hrms-onboarding.js use, because the bundle's
 * source is not in this repository.
 *
 * Endpoints used (all already permission-gated server side):
 *   GET/POST         /api/attendance/geofences         + /<id> PUT|DELETE
 *   GET/POST         /api/shifts                       + /<id> PUT|DELETE
 *   GET/POST         /api/shift-assignments            + /<id> DELETE
 *   GET/POST         /api/attendance/location-reviews
 *
 * Mounted from a button on the attendance screens; hidden entirely from users
 * without attendance.edit, which is also what the server enforces.
 */
(function () {
  if (window.__hrmsAttendanceAdmin) return;
  window.__hrmsAttendanceAdmin = true;

  var BTN_ID = 'hrms-att-admin-btn';
  var OVERLAY_ID = 'hrms-att-admin-overlay';
  var state = { tab: 'fences', fences: [], shifts: [], assignments: [], reviews: [], busy: false, errors: {} };

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function can(code) {
    try { return !window.__hrmsCan || window.__hrmsCan(code); } catch (_) { return true; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + r.status));
          return d;
        });
      });
  }
  function toast(msg, bad) {
    var t = document.createElement('div');
    t.setAttribute('style',
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100002;' +
      'background:' + (bad ? '#dc2626' : '#0f9d58') + ';color:#fff;padding:11px 20px;' +
      "border-radius:9px;font:600 13px 'Segoe UI',Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 3200);
  }

  /* ── mini map ─────────────────────────────────────────────────────────
   * A slippy-map view built from OpenStreetMap raster tiles. No mapping
   * library: pulling Leaflet off a CDN would add a third-party script to every
   * page load, and all this needs is Web Mercator plus absolutely-positioned
   * <img> tiles. Draws the fence circle to scale and, when a check-in position
   * is known, a marker for it and the line between the two.
   *
   * OSM's tile policy covers casual use like an internal HR screen; swap
   * TILE_URL for your own tile server if this ever gets heavy traffic.
   */
  var TILE = 256;
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  function lngToWorldX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z) * TILE; }
  function latToWorldY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * TILE;
  }
  function worldXToLng(x, z) { return x / (TILE * Math.pow(2, z)) * 360 - 180; }
  function worldYToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (TILE * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function metersPerPixel(lat, z) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  }
  function haversine(aLat, aLng, bLat, bLng) {
    var R = 6371000, rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function prettyDistance(m) {
    if (m == null) return '';
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
  }
  /* Biggest zoom at which `spanMeters` still fits inside `px`. */
  function fitZoom(lat, spanMeters, px) {
    for (var z = 18; z >= 2; z--) {
      if (spanMeters / metersPerPixel(lat, z) <= px) return z;
    }
    return 2;
  }

  /*
   * opts: { lat, lng, radius, label,        -- the fence (required)
   *         pointLat, pointLng, pointLabel, -- the check-in (optional)
   *         width, height }
   */
  function renderMap(opts) {
    var W = opts.width || 380, H = opts.height || 240;
    var fLat = Number(opts.lat), fLng = Number(opts.lng);
    if (!isFinite(fLat) || !isFinite(fLng)) {
      return '<div class="haa-empty">No coordinates to plot.</div>';
    }
    var radius = Number(opts.radius) || 0;
    var hasPoint = isFinite(Number(opts.pointLat)) && isFinite(Number(opts.pointLng));
    var pLat = Number(opts.pointLat), pLng = Number(opts.pointLng);

    // Frame both the fence circle and the check-in, with a little margin.
    var dist = hasPoint ? haversine(fLat, fLng, pLat, pLng) : 0;
    var span = Math.max(radius * 2.6, hasPoint ? dist * 2.4 : 0, 120);
    var z = fitZoom(fLat, span, Math.min(W, H));

    // Centre between the two points so neither falls off the edge.
    var cLat = hasPoint ? (fLat + pLat) / 2 : fLat;
    var cLng = hasPoint ? (fLng + pLng) / 2 : fLng;
    var originX = lngToWorldX(cLng, z) - W / 2;
    var originY = latToWorldY(cLat, z) - H / 2;
    var toX = function (lng) { return lngToWorldX(lng, z) - originX; };
    var toY = function (lat) { return latToWorldY(lat, z) - originY; };

    // Tiles covering the viewport.
    var tiles = '';
    var n = Math.pow(2, z);
    var x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + W) / TILE);
    var y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + H) / TILE);
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;                 // above the pole / below it
        var wrapped = ((tx % n) + n) % n;                // wrap across the date line
        var url = TILE_URL.replace('{z}', z).replace('{x}', wrapped).replace('{y}', ty);
        tiles += '<img src="' + url + '" width="' + TILE + '" height="' + TILE + '" alt="" ' +
          'loading="lazy" referrerpolicy="no-referrer" style="position:absolute;left:' +
          (tx * TILE - originX) + 'px;top:' + (ty * TILE - originY) + 'px;">';
      }
    }

    var fx = toX(fLng), fy = toY(fLat);
    var rpx = radius / metersPerPixel(fLat, z);
    var svg = '<svg width="' + W + '" height="' + H + '" style="position:absolute;inset:0;' +
      'pointer-events:none;overflow:visible">';
    if (hasPoint) {
      svg += '<line x1="' + fx + '" y1="' + fy + '" x2="' + toX(pLng) + '" y2="' + toY(pLat) +
        '" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/>';
    }
    if (rpx > 0) {
      svg += '<circle cx="' + fx + '" cy="' + fy + '" r="' + rpx + '" fill="rgba(15,157,88,.18)" ' +
        'stroke="#0f9d58" stroke-width="2"/>';
    }
    svg += '<circle cx="' + fx + '" cy="' + fy + '" r="6" fill="#0f9d58" stroke="#fff" stroke-width="2"/>';
    if (hasPoint) {
      var px = toX(pLng), py = toY(pLat);
      svg += '<circle cx="' + px + '" cy="' + py + '" r="7" fill="#dc2626" stroke="#fff" stroke-width="2"/>';
    }
    svg += '</svg>';

    var inside = hasPoint && radius > 0 && dist <= radius;
    var caption = hasPoint
      ? '<span style="color:' + (inside ? '#166534' : '#b91c1c') + ';font-weight:700">' +
        (inside ? 'Inside' : 'Outside') + '</span> · ' + prettyDistance(dist) +
        ' from ' + esc(opts.label || 'the office')
      : esc(opts.label || '') + (radius ? ' · ' + radius + ' m radius' : '');

    return '' +
      '<div style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;' +
      'border:1px solid #e2e8f0;border-radius:10px;background:#e8eef3">' + tiles + svg +
      '<div style="position:absolute;right:0;bottom:0;background:rgba(255,255,255,.82);' +
      'font-size:9px;color:#475569;padding:1px 5px;border-radius:5px 0 0 0">' +
      '© OpenStreetMap contributors</div></div>' +
      '<div style="font-size:12px;color:#475569;margin-top:6px">' + caption + '</div>';
  }

  /* ── interactive map picker ───────────────────────────────────────────
   * Typing coordinates is what put a fence 5 km off: "13.4" is one decimal
   * place, which is 11 km of ground. This lets an admin drag, zoom and click
   * the exact spot instead, and always writes 6 decimal places (~0.1 m).
   *
   * Returns a handle with getCentre()/setCentre()/setRadius() so the form
   * fields and the map stay in step in both directions.
   */
  function createPicker(host, opts) {
    opts = opts || {};
    var st = {
      lat: opts.lat != null ? Number(opts.lat) : 20.5937,
      lng: opts.lng != null ? Number(opts.lng) : 78.9629,
      z: opts.zoom || (opts.lat != null ? 17 : 4),
      radius: Number(opts.radius) || 200,
      accuracy: null
    };
    var W = 0, H = 0, drag = null, moved = 0;

    host.innerHTML =
      '<div class="haa-map" style="position:relative;width:100%;height:' + (opts.height || 420) +
      'px;overflow:hidden;border:1px solid #e2e8f0;border-radius:10px;background:#e8eef3;' +
      'cursor:grab;touch-action:none;user-select:none">' +
      '<div class="haa-tiles" style="position:absolute;inset:0"></div>' +
      '<svg class="haa-ov" style="position:absolute;inset:0;pointer-events:none;overflow:visible"></svg>' +
      '<div class="haa-zoom" style="position:absolute;left:10px;top:10px;display:flex;' +
      'flex-direction:column;gap:4px;z-index:5">' +
      '<button type="button" data-zi style="width:30px;height:30px;border-radius:7px;border:1px solid #cbd5e1;' +
      'background:#fff;font-size:17px;font-weight:700;cursor:pointer;line-height:1">+</button>' +
      '<button type="button" data-zo style="width:30px;height:30px;border-radius:7px;border:1px solid #cbd5e1;' +
      'background:#fff;font-size:17px;font-weight:700;cursor:pointer;line-height:1">−</button>' +
      '</div>' +
      '<div class="haa-hint" style="position:absolute;left:50%;top:10px;transform:translateX(-50%);' +
      'background:rgba(15,23,42,.78);color:#fff;font-size:11px;padding:4px 10px;border-radius:20px;' +
      'pointer-events:none">Drag to pan · click to place the centre</div>' +
      '<div style="position:absolute;right:0;bottom:0;background:rgba(255,255,255,.82);font-size:9px;' +
      'color:#475569;padding:1px 5px;border-radius:5px 0 0 0">© OpenStreetMap contributors</div>' +
      '</div>' +
      '<div class="haa-read" style="font-size:12px;color:#475569;margin-top:6px"></div>';

    var box = host.querySelector('.haa-map');
    var tileLayer = host.querySelector('.haa-tiles');
    var ov = host.querySelector('.haa-ov');
    var read = host.querySelector('.haa-read');

    function draw() {
      W = box.clientWidth; H = box.clientHeight;
      if (!W || !H) return;
      var originX = lngToWorldX(st.lng, st.z) - W / 2;
      var originY = latToWorldY(st.lat, st.z) - H / 2;
      var n = Math.pow(2, st.z), html = '';
      for (var tx = Math.floor(originX / TILE); tx <= Math.floor((originX + W) / TILE); tx++) {
        for (var ty = Math.floor(originY / TILE); ty <= Math.floor((originY + H) / TILE); ty++) {
          if (ty < 0 || ty >= n) continue;
          var wx = ((tx % n) + n) % n;
          html += '<img src="' + TILE_URL.replace('{z}', st.z).replace('{x}', wx).replace('{y}', ty) +
            '" width="' + TILE + '" height="' + TILE + '" alt="" draggable="false" ' +
            'referrerpolicy="no-referrer" style="position:absolute;pointer-events:none;left:' +
            (tx * TILE - originX) + 'px;top:' + (ty * TILE - originY) + 'px">';
        }
      }
      tileLayer.innerHTML = html;

      var cx = W / 2, cy = H / 2;
      var rpx = st.radius / metersPerPixel(st.lat, st.z);
      var s = '';
      if (st.accuracy) {
        var apx = st.accuracy / metersPerPixel(st.lat, st.z);
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + apx + '" fill="rgba(37,99,235,.12)" ' +
          'stroke="#2563eb" stroke-width="1" stroke-dasharray="4 3"/>';
      }
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + rpx + '" fill="rgba(15,157,88,.18)" ' +
        'stroke="#0f9d58" stroke-width="2"/>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#0f9d58" stroke="#fff" stroke-width="2"/>';
      ov.innerHTML = s;

      read.innerHTML = '<strong>' + st.lat.toFixed(6) + ', ' + st.lng.toFixed(6) + '</strong>' +
        ' · zoom ' + st.z + ' · ' + st.radius + ' m radius' +
        (st.accuracy ? ' · GPS ±' + Math.round(st.accuracy) + ' m' : '');
      if (opts.onChange) opts.onChange(st.lat, st.lng);
    }

    box.addEventListener('mousedown', function (e) {
      drag = { x: e.clientX, y: e.clientY }; moved = 0; box.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      st.lng = worldXToLng(lngToWorldX(st.lng, st.z) - dx, st.z);
      st.lat = worldYToLat(latToWorldY(st.lat, st.z) - dy, st.z);
      draw();
    });
    window.addEventListener('mouseup', function () {
      if (drag) { drag = null; box.style.cursor = 'grab'; }
    });
    box.addEventListener('click', function (e) {
      if (moved > 4) return;                       // that was a pan, not a pick
      var r = box.getBoundingClientRect();
      st.lng = worldXToLng(lngToWorldX(st.lng, st.z) - W / 2 + (e.clientX - r.left), st.z);
      st.lat = worldYToLat(latToWorldY(st.lat, st.z) - H / 2 + (e.clientY - r.top), st.z);
      st.accuracy = null;                          // hand-placed, no GPS error to show
      draw();
    });
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      st.z = Math.max(2, Math.min(19, st.z + (e.deltaY < 0 ? 1 : -1)));
      draw();
    }, { passive: false });
    box.querySelector('[data-zi]').onclick = function (e) {
      e.stopPropagation(); st.z = Math.min(19, st.z + 1); draw();
    };
    box.querySelector('[data-zo]').onclick = function (e) {
      e.stopPropagation(); st.z = Math.max(2, st.z - 1); draw();
    };

    setTimeout(draw, 0);
    return {
      getCentre: function () { return { lat: st.lat, lng: st.lng }; },
      setCentre: function (lat, lng, zoom, accuracy) {
        if (isFinite(lat) && isFinite(lng)) { st.lat = Number(lat); st.lng = Number(lng); }
        if (zoom) st.z = zoom;
        st.accuracy = accuracy || null;
        draw();
      },
      setRadius: function (r) { st.radius = Number(r) || 0; draw(); },
      redraw: draw
    };
  }

  function injectStyle() {
    if (document.getElementById('hrms-att-admin-css')) return;
    var s = document.createElement('style');
    s.id = 'hrms-att-admin-css';
    s.textContent = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;',
      'border:1.5px solid var(--border,#e5e7eb);background:var(--card,#fff);color:var(--text1,#111);',
      'font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '#' + BTN_ID + ':hover{background:#0f9d58;color:#fff;border-color:#0f9d58}',
      '.haa-back{position:fixed;inset:0;z-index:100001;background:rgba(15,23,42,.55);display:flex;',
      "align-items:center;justify-content:center;padding:24px;font-family:'Segoe UI',Arial,sans-serif}",
      '.haa-panel{background:#fff;border-radius:14px;width:100%;max-width:940px;max-height:88vh;',
      'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.3)}',
      '.haa-head{padding:18px 24px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:14px}',
      '.haa-title{font-size:17px;font-weight:800;color:#0f172a;flex:1}',
      '.haa-tabs{display:flex;gap:6px;padding:12px 24px 0}',
      '.haa-tab{padding:7px 15px;border-radius:8px 8px 0 0;border:1px solid transparent;background:none;',
      'font-size:13px;font-weight:600;color:#64748b;cursor:pointer}',
      '.haa-tab.on{background:#f1f5f9;color:#0f172a;border-color:#e2e8f0;border-bottom-color:#f1f5f9}',
      '.haa-body{padding:18px 24px 24px;overflow:auto;flex:1;background:#f8fafc}',
      '.haa-tbl{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;',
      'border:1px solid #e2e8f0}',
      '.haa-tbl th{background:#f1f5f9;font-size:11px;text-transform:uppercase;letter-spacing:.5px;',
      'color:#64748b;text-align:left;padding:9px 12px}',
      '.haa-tbl td{padding:9px 12px;border-top:1px solid #f1f5f9;font-size:13px;color:#1e293b}',
      '.haa-in{padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;',
      'font-family:inherit;box-sizing:border-box;width:100%}',
      '.haa-btn{padding:8px 16px;border-radius:8px;border:none;background:#0f9d58;color:#fff;',
      'font-size:13px;font-weight:700;cursor:pointer}',
      '.haa-btn.sec{background:#fff;color:#334155;border:1px solid #e2e8f0}',
      '.haa-btn.dgr{background:#fee2e2;color:#b91c1c}',
      '.haa-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.haa-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px}',
      '.haa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.haa-lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;',
      'letter-spacing:.4px;display:block;margin-bottom:4px}',
      '.haa-empty{text-align:center;color:#94a3b8;padding:28px;font-size:13px}',
      '.haa-pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ── positioning ──────────────────────────────────────────────────────
   *
   * getCurrentPosition hands back the FIRST fix the device can produce, and
   * that is almost always the coarse one: WiFi/cell trilateration answers in
   * milliseconds, the GPS radio needs several seconds to lock and only ever
   * reports through watchPosition. enableHighAccuracy asks for the good fix,
   * it does not wait for it — so a one-shot call reliably places the pin at
   * whatever the network thinks, which for an office on a business ISP is
   * routinely the wrong suburb.
   *
   * So: watch, keep the tightest reading seen, and stop as soon as it is good
   * enough or the budget runs out. Callers get progress updates because the
   * pin visibly walking in is the honest way to spend those seconds.
   *
   * This cannot conjure a GPS radio. On a desktop the readings never improve
   * past the network fix, which is exactly why `accuracy` comes back with the
   * position instead of being swallowed — the caller shows it and lets a human
   * correct the pin rather than dropping a confident marker kilometres out.
   */
  var GEO_GOOD_ENOUGH_M = 20;      // a fix this tight is a street address; stop
  var GEO_MAX_WAIT_MS = 20000;     // ...but never hold someone longer than this

  function locateBest(onProgress) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('no geolocation'));
      var best = null, id = null, timer = null, done = false;

      function stop() {
        if (id !== null) { navigator.geolocation.clearWatch(id); id = null; }
        if (timer) { clearTimeout(timer); timer = null; }
      }
      function settle() {
        if (done) return;
        done = true; stop();
        if (best) resolve(best); else reject(new Error('no fix'));
      }

      timer = setTimeout(settle, GEO_MAX_WAIT_MS);

      id = navigator.geolocation.watchPosition(
        function (p) {
          var acc = p.coords.accuracy;
          // Readings arrive out of order and a later one is often worse (the
          // network fix landing after a GPS sample). Only ever tighten.
          if (best && !(acc < best.accuracy)) return;
          best = {
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: acc
          };
          if (onProgress) { try { onProgress(best); } catch (_) {} }
          if (acc <= GEO_GOOD_ENOUGH_M) settle();
        },
        function (err) {
          // Mid-watch failures (a momentary POSITION_UNAVAILABLE) must not
          // throw away a fix already in hand — only give up with nothing.
          if (best) return;
          done = true; stop(); reject(err);
        },
        { enableHighAccuracy: true, timeout: GEO_MAX_WAIT_MS, maximumAge: 0 }
      );
    });
  }

  /* Framing a ±2 km reading at street level just shows a confidently wrong
   * spot, so the zoom follows the error rather than the other way round. */
  function zoomForAccuracy(acc) {
    return acc > 1000 ? 13 : acc > 300 ? 15 : acc > 80 ? 16 : 18;
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  function loadAll() {
    state.busy = true;
    state.errors = {};
    render();
    // Each failure is remembered per tab. Swallowing them into [] made a 500 on
    // the reviews endpoint read as "Nothing waiting" — the queue looked healthy
    // and empty while real requests sat unseen.
    function grab(key, url) {
      return api(url).catch(function (e) {
        state.errors[key] = e.message || 'Could not load';
        console.warn('[hrms-attendance-admin]', url, e);
        return [];
      });
    }
    return Promise.all([
      grab('fences', '/api/attendance/geofences'),
      grab('shifts', '/api/shifts'),
      grab('shifts', '/api/shift-assignments'),
      grab('reviews', '/api/attendance/location-reviews?status=Pending')
    ]).then(function (r) {
      state.fences = Array.isArray(r[0]) ? r[0] : [];
      state.shifts = Array.isArray(r[1]) ? r[1] : [];
      state.assignments = Array.isArray(r[2]) ? r[2] : [];
      state.reviews = Array.isArray(r[3]) ? r[3] : [];
      state.busy = false; render();
    });
  }

  function errorBanner(key) {
    var msg = state.errors && state.errors[key];
    if (!msg) return '';
    return '<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;' +
      'border-radius:9px;padding:11px 14px;margin-bottom:14px;font-size:13px">' +
      '<strong>Could not load this list.</strong> ' + esc(msg) +
      ' — anything already submitted is still recorded; this is a display failure.' +
      '</div>';
  }

  /* ── tab: geofences ──────────────────────────────────────────────────── */
  function fencesHtml() {
    var rows = state.fences.map(function (f) {
      return '<tr><td>' + esc(f.name) + '</td>' +
        '<td>' + esc(f.latitude) + ', ' + esc(f.longitude) + '</td>' +
        '<td>' + esc(f.radiusMeters || f.radius_meters || 0) + ' m</td>' +
        '<td><span class="haa-pill" style="background:' +
        ((f.isActive === false) ? '#fee2e2;color:#b91c1c' : '#dcfce7;color:#166534') + '">' +
        ((f.isActive === false) ? 'Inactive' : 'Active') + '</span></td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-fence="' + f.id + '">Delete</button></td></tr>';
    }).join('');
    return errorBanner('fences') +
      '<div class="haa-card"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Add an office location</div>' +
      '<div class="haa-grid" style="margin-bottom:12px">' +
      '<div><label class="haa-lbl">Name</label><input class="haa-in" id="haa-f-name" placeholder="Head Office"></div>' +
      '<div><label class="haa-lbl">Radius (m)</label><input class="haa-in" id="haa-f-rad" value="200" type="number" min="20" step="10"></div>' +
      '<div><label class="haa-lbl">Latitude</label><input class="haa-in" id="haa-f-lat" placeholder="click the map" readonly></div>' +
      '<div><label class="haa-lbl">Longitude</label><input class="haa-in" id="haa-f-lng" placeholder="click the map" readonly></div>' +
      '</div>' +
      '<div id="haa-picker"></div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<button class="haa-btn" id="haa-f-add">Add location</button>' +
      '<button class="haa-btn sec" id="haa-f-here">Use my current position</button>' +
      '<span style="font-size:12px;color:#64748b;">Place the centre precisely — a coordinate rounded to one ' +
      'decimal place is 11&nbsp;km out.</span>' +
      '</div></div>' +
      (state.fences.length
        ? '<table class="haa-tbl" style="margin-bottom:18px"><thead><tr><th>Name</th><th>Centre</th><th>Radius</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
          state.fences.map(function (f) {
            return '<div>' + renderMap({
              lat: f.latitude, lng: f.longitude,
              radius: f.radiusMeters || f.radius_meters || 0,
              label: f.name, width: 300, height: 200
            }) + '</div>';
          }).join('') + '</div>'
        : '<div class="haa-empty">No office locations yet — geofencing stays off until you add one.</div>');
  }

  /* ── tab: shifts ─────────────────────────────────────────────────────── */
  function shiftsHtml() {
    var rows = state.shifts.map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td>' +
        '<td>' + esc(s.startTime || s.start_time || '') + ' – ' + esc(s.endTime || s.end_time || '') + '</td>' +
        '<td>' + esc(s.graceMinutes != null ? s.graceMinutes : s.grace_minutes) + ' min</td>' +
        '<td>' + Math.round((s.overtimeAfterMinutes != null ? s.overtimeAfterMinutes : s.overtime_after_minutes || 540) / 60) + ' h</td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-shift="' + s.id + '">Delete</button></td></tr>';
    }).join('');
    var opts = state.shifts.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
    var asg = state.assignments.map(function (a) {
      var sh = state.shifts.filter(function (s) { return s.id === (a.shiftId || a.shift); })[0];
      return '<tr><td>' + esc(a.email) + '</td><td>' + esc(sh ? sh.name : (a.shiftName || '—')) + '</td>' +
        '<td>' + esc(a.effectiveFrom || a.effective_from || '') + '</td>' +
        '<td>' + esc(a.effectiveTo || a.effective_to || 'open-ended') + '</td>' +
        '<td style="text-align:right"><button class="haa-btn dgr" data-del-asg="' + a.id + '">Remove</button></td></tr>';
    }).join('');
    return errorBanner('shifts') +
      '<div class="haa-card"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Create a shift</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">Name</label><input class="haa-in" id="haa-s-name" placeholder="Morning Shift"></div>' +
      '<div><label class="haa-lbl">Start</label><input class="haa-in" id="haa-s-start" type="time" value="09:00"></div>' +
      '<div><label class="haa-lbl">End</label><input class="haa-in" id="haa-s-end" type="time" value="18:00"></div>' +
      '<div><label class="haa-lbl">Grace (min)</label><input class="haa-in" id="haa-s-grace" value="15"></div>' +
      '<div><label class="haa-lbl">Overtime after (h)</label><input class="haa-in" id="haa-s-ot" value="9"></div>' +
      '</div><div style="margin-top:12px"><button class="haa-btn" id="haa-s-add">Create shift</button></div></div>' +
      (state.shifts.length
        ? '<table class="haa-tbl"><thead><tr><th>Shift</th><th>Timing</th><th>Grace</th><th>OT after</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="haa-empty">No shifts defined — everyone falls back to General Shift (09:00–18:00).</div>') +
      '<div class="haa-card" style="margin-top:18px"><div style="font-weight:700;margin-bottom:12px;font-size:14px;">Assign a shift</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">Employee email</label><input class="haa-in" id="haa-a-email" placeholder="person@eversoftit.com"></div>' +
      '<div><label class="haa-lbl">Shift</label><select class="haa-in" id="haa-a-shift">' + opts + '</select></div>' +
      '<div><label class="haa-lbl">Effective from</label><input class="haa-in" id="haa-a-from" type="date"></div>' +
      '<div><label class="haa-lbl">Until (optional)</label><input class="haa-in" id="haa-a-to" type="date"></div>' +
      '</div><div style="margin-top:12px"><button class="haa-btn" id="haa-a-add"' +
      (state.shifts.length ? '' : ' disabled') + '>Assign</button></div></div>' +
      (state.assignments.length
        ? '<table class="haa-tbl"><thead><tr><th>Employee</th><th>Shift</th><th>From</th><th>Until</th><th></th></tr></thead><tbody>' + asg + '</tbody></table>'
        : '<div class="haa-empty">No individual assignments — everyone is on the default shift.</div>');
  }

  /* ── tab: off-site reviews ───────────────────────────────────────────── */
  function reviewsHtml() {
    if (!state.reviews.length) {
      return errorBanner('reviews') +
        (state.errors.reviews ? ''
          : '<div class="haa-empty">Nothing waiting. Off-site check-ins appear here for approval.</div>');
    }
    // Nearest fence gives the map something to measure the check-in against.
    function nearestFence(lat, lng) {
      var best = null, bestD = Infinity;
      state.fences.forEach(function (f) {
        if (f.isActive === false) return;
        var d = haversine(lat, lng, Number(f.latitude), Number(f.longitude));
        if (d < bestD) { bestD = d; best = f; }
      });
      return best;
    }

    return state.reviews.map(function (r) {
      var hasPos = r.latitude != null && r.longitude != null;
      var fence = hasPos ? nearestFence(Number(r.latitude), Number(r.longitude)) : state.fences[0];
      var mapHtml = (hasPos && fence)
        ? renderMap({
            lat: fence.latitude, lng: fence.longitude,
            radius: fence.radiusMeters || fence.radius_meters || 0,
            label: fence.name,
            pointLat: r.latitude, pointLng: r.longitude,
            width: 340, height: 210
          })
        : '<div class="haa-empty" style="padding:16px">' +
          (hasPos ? 'No office location defined to compare against.'
                  : 'The browser gave no position for this check-in.') + '</div>';

      return '<div class="haa-card" style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">' +
        '<div style="flex:0 0 340px;max-width:100%">' + mapHtml + '</div>' +
        '<div style="flex:1;min-width:220px">' +
        '<div style="font-weight:700;font-size:14px;color:#0f172a">' + esc(r.employee || r.email) + '</div>' +
        '<div style="font-size:12px;color:#64748b;margin-bottom:10px">' + esc(r.email) + '</div>' +
        '<div style="font-size:12px;color:#64748b">Checked in</div>' +
        '<div style="font-size:13px;margin-bottom:10px">' + esc(r.date || '') + ' at ' +
        esc((r.checkIn || '').slice(11, 16) || '—') + '</div>' +
        '<div style="font-size:12px;color:#64748b">Reason given</div>' +
        '<div style="font-size:13px;margin-bottom:14px;white-space:pre-wrap">' +
        esc(r.reason || '—') + '</div>' +
        (hasPos ? '<a href="https://maps.google.com/?q=' + esc(r.latitude) + ',' + esc(r.longitude) +
          '" target="_blank" rel="noopener" style="color:#2563eb;font-size:12px">Open in Google Maps</a><br><br>' : '') +
        '<button class="haa-btn" data-ok="' + r.id + '">Approve</button> ' +
        '<button class="haa-btn dgr" data-no="' + r.id + '">Reject</button>' +
        '</div></div>';
    }).join('');
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  function render() {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    var body = el.querySelector('.haa-body');
    var tabs = el.querySelectorAll('.haa-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = 'haa-tab' + (tabs[i].getAttribute('data-tab') === state.tab ? ' on' : '');
    }
    if (state.busy) { body.innerHTML = '<div class="haa-empty">Loading…</div>'; return; }
    body.innerHTML = state.tab === 'fences' ? fencesHtml()
      : state.tab === 'shifts' ? shiftsHtml() : reviewsHtml();
    wire(body);
  }

  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  function wire(body) {
    var host = body.querySelector('#haa-picker');
    if (host) {
      var latEl = body.querySelector('#haa-f-lat'), lngEl = body.querySelector('#haa-f-lng');
      // Seed from an existing fence so a second office starts near the first,
      // not in the middle of the country.
      var seed = state.fences[0];
      state.picker = createPicker(host, {
        lat: seed ? seed.latitude : null,
        lng: seed ? seed.longitude : null,
        radius: parseInt(val('haa-f-rad'), 10) || 200,
        height: 400,
        onChange: function (la, ln) {
          // 6 dp ~= 0.1 m. The old free-text field let "13.4" through, which is
          // 11 km of latitude.
          if (latEl) latEl.value = la.toFixed(6);
          if (lngEl) lngEl.value = ln.toFixed(6);
        }
      });
      var radEl = body.querySelector('#haa-f-rad');
      if (radEl) radEl.oninput = function () {
        state.picker.setRadius(parseInt(radEl.value, 10) || 0);
      };
    }

    var add = body.querySelector('#haa-f-add');
    if (add) add.onclick = function () {
      var name = val('haa-f-name');
      var c = state.picker ? state.picker.getCentre() : null;
      var lat = c ? c.lat : parseFloat(val('haa-f-lat'));
      var lng = c ? c.lng : parseFloat(val('haa-f-lng'));
      var rad = parseInt(val('haa-f-rad'), 10) || 200;
      if (!name) return toast('Give the location a name', true);
      if (!isFinite(lat) || !isFinite(lng)) return toast('Place the centre on the map first', true);
      api('/api/attendance/geofences', {
        method: 'POST',
        body: JSON.stringify({
          name: name,
          latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)),
          radiusMeters: rad, radius_meters: rad
        })
      }).then(function () { toast('Location added'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    var here = body.querySelector('#haa-f-here');
    if (here) here.onclick = function () {
      if (!navigator.geolocation) return toast('This browser has no geolocation', true);
      var idle = 'Use my current position';
      here.disabled = true; here.textContent = 'Locating…';

      function place(fix) {
        if (state.picker) {
          state.picker.setCentre(fix.latitude, fix.longitude,
                                 zoomForAccuracy(fix.accuracy), fix.accuracy);
        }
      }

      locateBest(function (fix) {
        // Each refinement moves the pin and tightens the accuracy ring, so the
        // wait reads as the fix improving rather than as the button hanging.
        here.textContent = 'Locating… ±' + Math.round(fix.accuracy) + ' m';
        place(fix);
      }).then(function (fix) {
        here.disabled = false; here.textContent = idle;
        place(fix);
        if (fix.accuracy > 100) {
          toast('Best fix in ' + (GEO_MAX_WAIT_MS / 1000) + ' s was only ±' +
                Math.round(fix.accuracy) + ' m — this device has no GPS, so click ' +
                'the exact spot on the map', true);
        } else {
          toast('Placed at your position (±' + Math.round(fix.accuracy) + ' m)');
        }
      }).catch(function () {
        here.disabled = false; here.textContent = idle;
        toast('Could not read your position — click the map instead', true);
      });
    };

    var sAdd = body.querySelector('#haa-s-add');
    if (sAdd) sAdd.onclick = function () {
      var name = val('haa-s-name');
      if (!name) return toast('Shift name is required', true);
      var otH = parseFloat(val('haa-s-ot')); if (isNaN(otH)) otH = 9;
      api('/api/shifts', {
        method: 'POST',
        body: JSON.stringify({
          name: name,
          startTime: val('haa-s-start') || '09:00', start_time: val('haa-s-start') || '09:00',
          endTime: val('haa-s-end') || '18:00', end_time: val('haa-s-end') || '18:00',
          graceMinutes: parseInt(val('haa-s-grace'), 10) || 15,
          grace_minutes: parseInt(val('haa-s-grace'), 10) || 15,
          overtimeAfterMinutes: Math.round(otH * 60), overtime_after_minutes: Math.round(otH * 60)
        })
      }).then(function () { toast('Shift created'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    var aAdd = body.querySelector('#haa-a-add');
    if (aAdd) aAdd.onclick = function () {
      var email = val('haa-a-email'), from = val('haa-a-from'), to = val('haa-a-to');
      var shiftId = parseInt(val('haa-a-shift'), 10);
      if (!email || !from || !shiftId) return toast('Employee, shift and start date are required', true);
      api('/api/shift-assignments', {
        method: 'POST',
        body: JSON.stringify({
          email: email, shift: shiftId, shiftId: shiftId,
          effectiveFrom: from, effective_from: from,
          effectiveTo: to || null, effective_to: to || null
        })
      }).then(function () { toast('Shift assigned'); loadAll(); })
        .catch(function (e) { toast(e.message, true); });
    };

    function bindDelete(attr, url, label) {
      var els = body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.onclick = function () {
            if (!window.confirm('Delete this ' + label + '?')) return;
            api(url + el.getAttribute(attr), { method: 'DELETE' })
              .then(function () { toast(label + ' deleted'); loadAll(); })
              .catch(function (e) { toast(e.message, true); });
          };
        })(els[i]);
      }
    }
    bindDelete('data-del-fence', '/api/attendance/geofences/', 'location');
    bindDelete('data-del-shift', '/api/shifts/', 'shift');
    bindDelete('data-del-asg', '/api/shift-assignments/', 'assignment');

    function decide(attr, decision) {
      var els = body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.onclick = function () {
            el.disabled = true;
            api('/api/attendance/location-reviews', {
              method: 'POST',
              body: JSON.stringify({ id: parseInt(el.getAttribute(attr), 10), decision: decision })
            }).then(function () { toast('Check-in ' + decision.toLowerCase()); loadAll(); })
              .catch(function (e) { el.disabled = false; toast(e.message, true); });
          };
        })(els[i]);
      }
    }
    decide('data-ok', 'Approved');
    decide('data-no', 'Rejected');
  }

  /* ── open / close ────────────────────────────────────────────────────── */
  function open() {
    if (document.getElementById(OVERLAY_ID)) return;
    injectStyle();
    var back = document.createElement('div');
    back.id = OVERLAY_ID;
    back.className = 'haa-back';
    back.innerHTML =
      '<div class="haa-panel">' +
      '<div class="haa-head"><div class="haa-title">Attendance Settings</div>' +
      '<button class="haa-btn sec" id="haa-close">Close</button></div>' +
      '<div class="haa-tabs">' +
      '<button class="haa-tab on" data-tab="fences">Office Locations</button>' +
      '<button class="haa-tab" data-tab="shifts">Shifts</button>' +
      '<button class="haa-tab" data-tab="reviews">Off-site Approvals</button>' +
      '</div><div class="haa-body"></div></div>';
    document.body.appendChild(back);

    back.querySelector('#haa-close').onclick = close;
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    var tabs = back.querySelectorAll('.haa-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.onclick = function () { state.tab = t.getAttribute('data-tab'); render(); };
      })(tabs[i]);
    }
    loadAll();
  }
  function close() {
    var el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  window.__hrmsOpenAttendanceAdmin = open;

  /* ── mount ───────────────────────────────────────────────────────────── */
  function onAttendancePage() {
    return /attendance|check-?in|employees/i.test(location.pathname + location.hash);
  }

  function mount() {
    var existing = document.getElementById(BTN_ID);
    if (!onAttendancePage() || !can('attendance.edit')) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) {
      if (existing.getAttribute('data-home') === 'anchored') return;
      var home = findAnchor();
      if (home && home.parentNode) {
        home.parentNode.insertBefore(existing, home.nextSibling);
        existing.setAttribute('data-home', 'anchored');
      }
      return;
    }
    injectStyle();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="8" cy="7" r="2.2"/><path d="M8 1.5c2.5 0 4.5 2 4.5 4.5 0 3.2-4.5 8.5-4.5 8.5S3.5 9.2 3.5 6c0-2.5 2-4.5 4.5-4.5z"/>' +
      '</svg>Attendance Settings';
    btn.onclick = function (e) { e.stopPropagation(); open(); };

    var anchor = findAnchor();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      btn.setAttribute('data-home', 'anchored');
      return;
    }
    var card = document.querySelector('.page-header, .card');
    if (card) card.appendChild(btn);
  }

  /* Sit next to the page's own Filters control when there is one — same idea
     as the KPI button on the recruitment screens. */
  function findAnchor() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (buttons[i].id !== BTN_ID && label === 'Filters') return buttons[i];
    }
    return null;
  }

  function boot() {
    mount();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; mount(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', mount);
    window.addEventListener('hrmsPermsLoaded', mount);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
