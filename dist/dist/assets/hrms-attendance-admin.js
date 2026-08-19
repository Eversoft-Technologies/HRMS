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
  var state = { tab: 'live_map', fences: [], shifts: [], assignments: [], reviews: [],
                arrangements: [], roster: [], homes: [], mapFeed: { fences: [], employees: [] },
                mapMode: 'markers', mapFilter: 'all', deptFilter: 'all', busy: false, errors: {} };

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
      ? '<span style="color:' + (inside ? 'var(--haa-ok-fg)' : 'var(--haa-err-fg)') + ';font-weight:700">' +
        (inside ? 'Inside' : 'Outside') + '</span> · ' + prettyDistance(dist) +
        ' from ' + esc(opts.label || 'the office')
      : esc(opts.label || '') + (radius ? ' · ' + radius + ' m radius' : '');

    return '' +
      '<div style="position:relative;width:' + W + 'px;height:' + H + 'px;overflow:hidden;' +
      'border:1px solid var(--haa-line);border-radius:10px;background:var(--haa-map-bg)">' + tiles + svg +
      '<div style="position:absolute;right:0;bottom:0;background:var(--haa-attrib);' +
      'font-size:9px;color:var(--haa-muted);padding:1px 5px;border-radius:5px 0 0 0">' +
      '© OpenStreetMap contributors</div></div>' +
      '<div style="font-size:12px;color:var(--haa-muted);margin-top:6px">' + caption + '</div>';
  }

  /* ── Full Interactive Attendance Slippy Map & Heatmap ─────────────────── */
  function createInteractiveAttendanceMap(host) {
    var fences = (state.mapFeed && state.mapFeed.fences) || state.fences || [];
    var employees = (state.mapFeed && state.mapFeed.employees) || [];
    var mode = state.mapMode || 'markers';
    var statusFilter = state.mapFilter || 'all';
    var deptFilter = state.deptFilter || 'all';

    var visibleEmps = employees.filter(function (emp) {
      if (deptFilter !== 'all' && emp.department !== deptFilter) return false;
      if (statusFilter === 'onsite' && (!emp.geoVerified || emp.isWfh)) return false;
      if (statusFilter === 'wfh' && !emp.isWfh) return false;
      if (statusFilter === 'pending' && emp.locationStatus !== 'Pending' && emp.status !== 'Pending Review') return false;
      return true;
    });

    var defaultLat = 12.9716, defaultLng = 77.5946;
    if (fences.length && fences[0].latitude) {
      defaultLat = fences[0].latitude;
      defaultLng = fences[0].longitude;
    } else if (visibleEmps.length && visibleEmps[0].latitude) {
      defaultLat = visibleEmps[0].latitude;
      defaultLng = visibleEmps[0].longitude;
    }

    var st = {
      lat: defaultLat,
      lng: defaultLng,
      z: 14,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
      mapStartX: 0,
      mapStartY: 0
    };

    var container = document.createElement('div');
    container.className = 'haa-live-map-canvas-wrap';
    container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;user-select:none;cursor:grab;';

    var tileLayer = document.createElement('div');
    tileLayer.className = 'haa-map-tiles-layer';
    tileLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    container.appendChild(tileLayer);

    var svgLayer = document.createElement('svg');
    svgLayer.className = 'haa-map-svg-layer';
    svgLayer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
    container.appendChild(svgLayer);

    var heatmapCanvas = document.createElement('canvas');
    heatmapCanvas.className = 'haa-map-heat-canvas';
    heatmapCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.85;display:' + (mode === 'heatmap' ? 'block' : 'none') + ';';
    container.appendChild(heatmapCanvas);

    var overlayLayer = document.createElement('div');
    overlayLayer.className = 'haa-map-overlay-layer';
    overlayLayer.style.cssText = 'position:absolute;inset:0;pointer-events:auto;';
    container.appendChild(overlayLayer);

    var zoomWrap = document.createElement('div');
    zoomWrap.className = 'haa-map-zoom-controls';
    zoomWrap.style.cssText = 'position:absolute;right:14px;top:14px;display:flex;flex-direction:column;gap:4px;z-index:30;';
    zoomWrap.innerHTML =
      '<button class="haa-map-zbtn" id="haa-z-in" title="Zoom In" style="width:34px;height:34px;border-radius:8px;border:1px solid var(--haa-line,#cbd5e1);background:var(--haa-surface,#fff);color:var(--haa-text,#0f172a);font-weight:700;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.15);">+</button>' +
      '<button class="haa-map-zbtn" id="haa-z-out" title="Zoom Out" style="width:34px;height:34px;border-radius:8px;border:1px solid var(--haa-line,#cbd5e1);background:var(--haa-surface,#fff);color:var(--haa-text,#0f172a);font-weight:700;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.15);">−</button>' +
      '<button class="haa-map-zbtn" id="haa-z-fit" title="Fit All" style="width:34px;height:34px;border-radius:8px;border:1px solid var(--haa-line,#cbd5e1);background:var(--haa-surface,#fff);color:var(--haa-text,#0f172a);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.15);">🎯</button>';
    container.appendChild(zoomWrap);

    var attrib = document.createElement('div');
    attrib.style.cssText = 'position:absolute;right:0;bottom:0;background:var(--haa-attrib,rgba(15,23,42,0.75));font-size:9px;color:var(--haa-muted,#fff);padding:1px 6px;border-radius:5px 0 0 0;z-index:20;';
    attrib.textContent = '© OpenStreetMap contributors';
    container.appendChild(attrib);

    host.innerHTML = '';
    host.appendChild(container);

    function redraw() {
      var W = container.clientWidth || 800;
      var H = container.clientHeight || 560;
      if (W < 10 || H < 10) return;

      var originX = lngToWorldX(st.lng, st.z) - W / 2;
      var originY = latToWorldY(st.lat, st.z) - H / 2;
      var toX = function (lng) { return lngToWorldX(lng, st.z) - originX; };
      var toY = function (lat) { return latToWorldY(lat, st.z) - originY; };

      // 1. Tiles
      var tilesHtml = '';
      var n = Math.pow(2, st.z);
      var x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + W) / TILE);
      var y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + H) / TILE);
      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= n) continue;
          var wrapped = ((tx % n) + n) % n;
          var url = TILE_URL.replace('{z}', st.z).replace('{x}', wrapped).replace('{y}', ty);
          tilesHtml += '<img src="' + url + '" width="' + TILE + '" height="' + TILE + '" alt="" ' +
            'loading="lazy" referrerpolicy="no-referrer" style="position:absolute;left:' +
            (tx * TILE - originX) + 'px;top:' + (ty * TILE - originY) + 'px;">';
        }
      }
      tileLayer.innerHTML = tilesHtml;

      // 2. SVG Geofence circles
      var svgHtml = '';
      fences.forEach(function (f) {
        if (!f.latitude || !f.longitude) return;
        var fx = toX(f.longitude), fy = toY(f.latitude);
        var rMeters = Number(f.radiusMeters || f.radius_meters) || 200;
        var rPx = rMeters / metersPerPixel(f.latitude, st.z);
        svgHtml += '<circle cx="' + fx + '" cy="' + fy + '" r="' + Math.max(4, rPx) + '" ' +
          'fill="rgba(79,142,247,0.15)" stroke="#4f8ef7" stroke-width="2.5" stroke-dasharray="6 4"/>';
        svgHtml += '<circle cx="' + fx + '" cy="' + fy + '" r="5" fill="#4f8ef7" stroke="#fff" stroke-width="2"/>';
      });
      svgLayer.innerHTML = svgHtml;

      // 3. Heatmap
      if (mode === 'heatmap') {
        heatmapCanvas.width = W;
        heatmapCanvas.height = H;
        var ctx = heatmapCanvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        visibleEmps.forEach(function (emp) {
          if (!emp.latitude || !emp.longitude) return;
          var px = toX(emp.longitude), py = toY(emp.latitude);
          var grad = ctx.createRadialGradient(px, py, 4, px, py, 48);
          grad.addColorStop(0, 'rgba(239, 68, 68, 0.9)');
          grad.addColorStop(0.3, 'rgba(245, 158, 11, 0.7)');
          grad.addColorStop(0.6, 'rgba(16, 185, 129, 0.4)');
          grad.addColorStop(1, 'rgba(59, 130, 246, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, 48, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // 4. Overlays (Fence badges & Employee Markers/Clusters)
      overlayLayer.innerHTML = '';

      fences.forEach(function (f) {
        if (!f.latitude || !f.longitude) return;
        var fx = toX(f.longitude), fy = toY(f.latitude);
        var lbl = document.createElement('div');
        lbl.className = 'haa-map-fence-badge';
        lbl.style.cssText = 'position:absolute;left:' + fx + 'px;top:' + (fy - 28) + 'px;transform:translate(-50%,-100%);' +
          'background:rgba(15,23,42,0.88);color:#fff;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;' +
          'border:1px solid #4f8ef7;box-shadow:0 4px 14px rgba(0,0,0,0.3);white-space:nowrap;pointer-events:auto;cursor:pointer;z-index:12;';
        lbl.innerHTML = '🏢 ' + esc(f.name) + ' <span style="background:#4f8ef7;color:#fff;border-radius:10px;padding:1px 6px;margin-left:4px;font-size:10px;">' + (f.activeCount || 0) + ' on-site</span>';
        lbl.onclick = function (e) {
          e.stopPropagation();
          st.lat = f.latitude;
          st.lng = f.longitude;
          st.z = 16;
          redraw();
        };
        overlayLayer.appendChild(lbl);
      });

      if (mode === 'markers') {
        var clusters = [];
        var CLUSTER_RADIUS = 32;

        visibleEmps.forEach(function (emp) {
          if (!emp.latitude || !emp.longitude) return;
          var px = toX(emp.longitude), py = toY(emp.latitude);
          if (px < -60 || px > W + 60 || py < -60 || py > H + 60) return;

          var matchedCluster = null;
          for (var c = 0; c < clusters.length; c++) {
            var dx = clusters[c].x - px, dy = clusters[c].y - py;
            if (Math.sqrt(dx * dx + dy * dy) <= CLUSTER_RADIUS) {
              matchedCluster = clusters[c];
              break;
            }
          }

          if (matchedCluster) {
            matchedCluster.members.push(emp);
          } else {
            clusters.push({ x: px, y: py, lat: emp.latitude, lng: emp.longitude, members: [emp] });
          }
        });

        clusters.forEach(function (cl) {
          if (cl.members.length > 1) {
            var cMarker = document.createElement('div');
            cMarker.className = 'haa-map-cluster-bubble';
            cMarker.style.cssText = 'position:absolute;left:' + cl.x + 'px;top:' + cl.y + 'px;transform:translate(-50%,-50%);' +
              'width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;' +
              'display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;border:3px solid #fff;' +
              'box-shadow:0 4px 14px rgba(79,70,229,0.45);cursor:pointer;transition:transform 0.15s;z-index:20;';
            cMarker.textContent = cl.members.length;
            cMarker.title = cl.members.length + ' employees (click to zoom in)';
            cMarker.onclick = function (e) {
              e.stopPropagation();
              st.lat = cl.lat;
              st.lng = cl.lng;
              st.z = Math.min(18, st.z + 2);
              redraw();
            };
            overlayLayer.appendChild(cMarker);
          } else {
            var emp = cl.members[0];
            var dotColor = emp.isWfh ? '#3b82f6' : (emp.status === 'Pending Review' ? '#f59e0b' : '#10b981');
            var initials = (emp.name || 'U').split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);

            var eMarker = document.createElement('div');
            eMarker.className = 'haa-map-emp-pin';
            eMarker.style.cssText = 'position:absolute;left:' + cl.x + 'px;top:' + cl.y + 'px;transform:translate(-50%,-50%);' +
              'cursor:pointer;z-index:15;transition:transform 0.15s;';
            eMarker.innerHTML =
              '<div style="width:34px;height:34px;border-radius:50%;background:' + dotColor + ';border:3px solid #fff;' +
              'display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;' +
              'box-shadow:0 4px 12px rgba(0,0,0,0.3);position:relative;">' +
              esc(initials) +
              (emp.device === 'mobile' ? '<span style="position:absolute;bottom:-3px;right:-3px;font-size:10px;">📱</span>' : '') +
              '</div>';

            eMarker.onclick = function (e) {
              e.stopPropagation();
              showEmployeePopup(emp, cl.x, cl.y);
            };
            overlayLayer.appendChild(eMarker);
          }
        });
      }
    }

    function showEmployeePopup(emp, px, py) {
      var existing = overlayLayer.querySelector('.haa-map-emp-popover');
      if (existing) existing.remove();

      var pop = document.createElement('div');
      pop.className = 'haa-map-emp-popover';
      pop.style.cssText = 'position:absolute;left:' + px + 'px;top:' + (py - 12) + 'px;transform:translate(-50%,-100%);' +
        'background:var(--haa-surface,#ffffff);color:var(--haa-text,#0f172a);border-radius:12px;padding:14px 16px;' +
        'box-shadow:0 12px 36px rgba(0,0,0,0.28);border:1px solid var(--haa-line,#cbd5e1);z-index:40;min-width:260px;' +
        'max-width:320px;font-family:\'Segoe UI\',Arial,sans-serif;animation:haa-pop-in 0.18s ease;';

      var statusColor = emp.isWfh ? '#3b82f6' : (emp.status === 'Pending Review' ? '#f59e0b' : '#10b981');
      var initials = (emp.name || 'U').split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);

      pop.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
        '  <div style="display:flex;align-items:center;gap:10px;">' +
        '    <div style="width:36px;height:36px;border-radius:50%;background:' + statusColor + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;">' + esc(initials) + '</div>' +
        '    <div>' +
        '      <div style="font-weight:700;font-size:14px;color:var(--haa-text);">' + esc(emp.name) + '</div>' +
        '      <div style="font-size:11px;color:var(--haa-muted);">' + esc(emp.department) + ' · ' + esc(emp.role || 'Staff') + '</div>' +
        '    </div>' +
        '  </div>' +
        '  <button id="haa-pop-x" style="background:none;border:none;color:var(--haa-muted);font-size:16px;cursor:pointer;padding:2px 6px;">✕</button>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 0;border-top:1px solid var(--haa-line);border-bottom:1px solid var(--haa-line);font-size:12px;">' +
        '  <div><span style="color:var(--haa-muted);">Status:</span> <strong>' + esc(emp.status) + '</strong></div>' +
        '  <div><span style="color:var(--haa-muted);">Device:</span> ' + (emp.device === 'mobile' ? '📱 Mobile' : '💻 Desktop') + '</div>' +
        '  <div><span style="color:var(--haa-muted);">Checked in:</span> <strong>' + esc(emp.checkIn || '—') + '</strong></div>' +
        '  <div><span style="color:var(--haa-muted);">GPS:</span> ' + (emp.accuracy ? '±' + Math.round(emp.accuracy) + ' m' : (emp.isSimulatedCoord ? 'Office Geo' : 'Verified')) + '</div>' +
        '</div>' +
        (emp.locationReason ? '<div style="margin-top:8px;font-size:11px;color:var(--haa-warn-fg);background:rgba(245,158,11,0.1);padding:6px 8px;border-radius:6px;"><strong>Note:</strong> ' + esc(emp.locationReason) + '</div>' : '') +
        '<div style="margin-top:10px;display:flex;justify-content:flex-end;gap:6px;">' +
        '  <a href="/hr/hris" style="font-size:11px;color:var(--haa-link);text-decoration:none;font-weight:600;padding:4px 8px;">View Profile →</a>' +
        '</div>';

      overlayLayer.appendChild(pop);
      pop.querySelector('#haa-pop-x').onclick = function (ev) {
        ev.stopPropagation();
        pop.remove();
      };
    }

    container.onmousedown = function (e) {
      if (e.target.closest('.haa-map-emp-popover') || e.target.closest('.haa-map-zoom-controls')) return;
      st.isDragging = true;
      st.dragStartX = e.clientX;
      st.dragStartY = e.clientY;
      st.mapStartX = lngToWorldX(st.lng, st.z);
      st.mapStartY = latToWorldY(st.lat, st.z);
      container.style.cursor = 'grabbing';
    };

    window.addEventListener('mousemove', function (e) {
      if (!st.isDragging) return;
      var dx = e.clientX - st.dragStartX;
      var dy = e.clientY - st.dragStartY;
      var newWorldX = st.mapStartX - dx;
      var newWorldY = st.mapStartY - dy;
      st.lng = worldXToLng(newWorldX, st.z);
      st.lat = worldYToLat(newWorldY, st.z);
      redraw();
    });

    window.addEventListener('mouseup', function () {
      if (st.isDragging) {
        st.isDragging = false;
        container.style.cursor = 'grab';
      }
    });

    container.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.deltaY < 0) {
        st.z = Math.min(18, st.z + 1);
      } else {
        st.z = Math.max(3, st.z - 1);
      }
      redraw();
    }, { passive: false });

    zoomWrap.querySelector('#haa-z-in').onclick = function (e) {
      e.stopPropagation();
      st.z = Math.min(18, st.z + 1);
      redraw();
    };
    zoomWrap.querySelector('#haa-z-out').onclick = function (e) {
      e.stopPropagation();
      st.z = Math.max(3, st.z - 1);
      redraw();
    };
    zoomWrap.querySelector('#haa-z-fit').onclick = function (e) {
      e.stopPropagation();
      st.z = 13;
      if (fences.length && fences[0].latitude) {
        st.lat = fences[0].latitude;
        st.lng = fences[0].longitude;
      }
      redraw();
    };

    redraw();

    return {
      setMode: function (m) {
        mode = state.mapMode = m;
        heatmapCanvas.style.display = (mode === 'heatmap' ? 'block' : 'none');
        redraw();
      },
      setFilter: function (flt) {
        statusFilter = state.mapFilter = flt;
        redraw();
      },
      setDept: function (dept) {
        deptFilter = state.deptFilter = dept;
        redraw();
      },
      refresh: function () {
        redraw();
      }
    };
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
      'px;overflow:hidden;border:1px solid var(--haa-line);border-radius:10px;background:var(--haa-map-bg);' +
      'cursor:grab;touch-action:none;user-select:none">' +
      '<div class="haa-tiles" style="position:absolute;inset:0"></div>' +
      '<svg class="haa-ov" style="position:absolute;inset:0;pointer-events:none;overflow:visible"></svg>' +
      '<div class="haa-zoom" style="position:absolute;left:10px;top:10px;display:flex;' +
      'flex-direction:column;gap:4px;z-index:5">' +
      '<button type="button" data-zi style="width:30px;height:30px;border-radius:7px;border:1px solid var(--haa-in-line);' +
      'background:var(--haa-card);color:var(--haa-text);font-size:17px;font-weight:700;cursor:pointer;line-height:1">+</button>' +
      '<button type="button" data-zo style="width:30px;height:30px;border-radius:7px;border:1px solid var(--haa-in-line);' +
      'background:var(--haa-card);color:var(--haa-text);font-size:17px;font-weight:700;cursor:pointer;line-height:1">−</button>' +
      '</div>' +
      '<div class="haa-hint" style="position:absolute;left:50%;top:10px;transform:translateX(-50%);' +
      'background:rgba(15,23,42,.78);color:#fff;font-size:11px;padding:4px 10px;border-radius:20px;' +
      'pointer-events:none">Drag to pan · click to place the centre</div>' +
      '<div style="position:absolute;right:0;bottom:0;background:var(--haa-attrib);font-size:9px;' +
      'color:var(--haa-muted);padding:1px 5px;border-radius:5px 0 0 0">© OpenStreetMap contributors</div>' +
      '</div>' +
      '<div class="haa-read" style="font-size:12px;color:var(--haa-muted);margin-top:6px"></div>';

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

  /* The panel is scoped to its overlay root (.haa-back) and painted from its
   * own token set, defined twice: once for light and once under
   * html[data-theme="dark"], which index.html always stamps before first paint.
   *
   * Scoping matters because the check-in page's sidecar
   * (hrms-attendance-actions.js) uses the same haa- prefix for its Work From
   * Home / Activity Log / Team Status cards. While both sheets were global they
   * fought over the same names in both directions, whichever <style> landed
   * last winning: .haa-tbl painted that page's tables solid #fff, and
   * .haa-head / .haa-title / .haa-empty pulled its grid and sticky-header rules
   * into this panel's chrome.
   *
   * Tokens matter because the panel used to hard-code a light palette and set
   * no `color` on its own surfaces. Text inside it therefore inherited the
   * app's, which in dark mode is near-white — so headings like "Add an office
   * location" rendered white-on-white and simply were not there. Every colour
   * below is a token, so the same rule serves both themes and nothing inherits
   * a colour from a surface it is not sitting on.
   *
   * The mount button lives OUTSIDE the overlay, so it takes the app's own
   * palette tokens rather than these. */
  function injectStyle() {
    if (document.getElementById('hrms-att-admin-css')) return;
    var s = document.createElement('style');
    s.id = 'hrms-att-admin-css';
    s.textContent = [
      /* ── light palette (the default) ─────────────────────────────────── */
      '.haa-back{',
      '--haa-surface:#ffffff;--haa-body:#f8fafc;--haa-card:#ffffff;--haa-alt:#f1f5f9;',
      '--haa-line:#e2e8f0;--haa-line2:#f1f5f9;',
      '--haa-text:#0f172a;--haa-text2:#334155;--haa-muted:#64748b;--haa-faint:#94a3b8;',
      '--haa-in-bg:#ffffff;--haa-in-line:#cbd5e1;',
      '--haa-ok-bg:#dcfce7;--haa-ok-fg:#166534;',
      '--haa-warn-bg:#fef3c7;--haa-warn-fg:#b45309;',
      '--haa-err-bg:#fee2e2;--haa-err-fg:#b91c1c;--haa-err-soft:#fef2f2;--haa-err-line:#fecaca;',
      '--haa-chip:#e2e8f0;--haa-link:#2563eb;--haa-scrim:rgba(15,23,42,.55);',
      '--haa-info-bg:#dbeafe;--haa-info-fg:#1e40af;',
      /* The tiles are raster OpenStreetMap PNGs, so dark mode cannot restyle
         them — it inverts them instead. The filter is on the tile layer alone,
         never the SVG overlay above it, or the geofence circle and the centre
         pin would invert with it and stop meaning what they mean. */
      '--haa-map-bg:#e8eef3;--haa-map-filter:none;',
      '--haa-attrib:rgba(255,255,255,.82);',
      'color-scheme:light}',
      /* ── dark palette ────────────────────────────────────────────────── */
      'html[data-theme="dark"] .haa-back{',
      '--haa-surface:#111827;--haa-body:#0a0e1a;--haa-card:#131c2e;--haa-alt:#1a2235;',
      '--haa-line:rgba(255,255,255,.10);--haa-line2:rgba(255,255,255,.06);',
      '--haa-text:#e8edf7;--haa-text2:#c7d2e4;--haa-muted:#8a9bb8;--haa-faint:#6b7c99;',
      '--haa-in-bg:#0d1424;--haa-in-line:rgba(255,255,255,.16);',
      '--haa-ok-bg:rgba(34,211,165,.16);--haa-ok-fg:#22d3a5;',
      '--haa-warn-bg:rgba(247,201,79,.16);--haa-warn-fg:#f7c94f;',
      '--haa-err-bg:rgba(247,95,79,.16);--haa-err-fg:#f87171;',
      '--haa-err-soft:rgba(247,95,79,.10);--haa-err-line:rgba(247,95,79,.35);',
      '--haa-chip:rgba(148,163,184,.18);--haa-link:#7aa7ff;--haa-scrim:rgba(0,0,0,.62);',
      '--haa-info-bg:rgba(79,142,247,.18);--haa-info-fg:#8ab4ff;',
      '--haa-map-bg:#0d1424;',
      '--haa-map-filter:invert(1) hue-rotate(180deg) brightness(.86) contrast(1.05);',
      '--haa-attrib:rgba(10,14,26,.82);',
      'color-scheme:dark}',
      /* ── mount button (outside the overlay: app tokens, not panel ones) ─ */
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;',
      'border:1px solid var(--border2,#e5e7eb);background:var(--bg3,#fff);color:var(--text,#111);',
      'font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '#' + BTN_ID + ':hover{background:#0f9d58;color:#fff;border-color:#0f9d58}',
      /* ── panel chrome ───────────────────────────────────────────────── */
      '.haa-back{position:fixed;inset:0;z-index:100001;background:var(--haa-scrim);display:flex;',
      "align-items:center;justify-content:center;padding:24px;font-family:'Segoe UI',Arial,sans-serif}",
      '.haa-back .haa-panel{background:var(--haa-surface);color:var(--haa-text);border-radius:14px;',
      'width:100%;max-width:940px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;',
      'box-shadow:0 24px 70px rgba(0,0,0,.3)}',
      '.haa-back .haa-head{padding:18px 24px;border-bottom:1px solid var(--haa-line);display:flex;',
      'align-items:center;gap:14px}',
      '.haa-back .haa-title{font-size:17px;font-weight:800;color:var(--haa-text);flex:1}',
      '.haa-back .haa-tabs{display:flex;gap:6px;padding:12px 24px 0}',
      '.haa-back .haa-tab{padding:7px 15px;border-radius:8px 8px 0 0;border:1px solid transparent;',
      'background:none;font-size:13px;font-weight:600;color:var(--haa-muted);cursor:pointer}',
      '.haa-back .haa-tab:hover{color:var(--haa-text)}',
      '.haa-back .haa-tab.on{background:var(--haa-alt);color:var(--haa-text);border-color:var(--haa-line);',
      'border-bottom-color:var(--haa-alt)}',
      '.haa-back .haa-body{padding:18px 24px 24px;overflow:auto;flex:1;background:var(--haa-body)}',
      /* ── tables ─────────────────────────────────────────────────────── */
      '.haa-back .haa-tbl{width:100%;border-collapse:collapse;background:var(--haa-card);',
      'border-radius:10px;overflow:hidden;border:1px solid var(--haa-line)}',
      '.haa-back .haa-tbl th{background:var(--haa-alt);font-size:11px;text-transform:uppercase;',
      'letter-spacing:.5px;color:var(--haa-muted);text-align:left;padding:9px 12px}',
      '.haa-back .haa-tbl td{padding:9px 12px;border-top:1px solid var(--haa-line2);font-size:13px;',
      'color:var(--haa-text2)}',
      /* ── form controls ──────────────────────────────────────────────── */
      '.haa-back .haa-in{padding:8px 10px;border:1px solid var(--haa-in-line);border-radius:7px;',
      'font-size:13px;font-family:inherit;box-sizing:border-box;width:100%;',
      'background:var(--haa-in-bg);color:var(--haa-text)}',
      '.haa-back .haa-in::placeholder{color:var(--haa-faint)}',
      '.haa-back .haa-in:focus{outline:none;border-color:#0f9d58}',
      '.haa-back select.haa-in{cursor:pointer}',
      /* ── buttons ────────────────────────────────────────────────────── */
      '.haa-back .haa-btn{padding:8px 16px;border-radius:8px;border:none;background:#0f9d58;color:#fff;',
      'font-size:13px;font-weight:700;cursor:pointer}',
      '.haa-back .haa-btn.sec{background:var(--haa-card);color:var(--haa-text2);',
      'border:1px solid var(--haa-line)}',
      '.haa-back .haa-btn.dgr{background:var(--haa-err-bg);color:var(--haa-err-fg)}',
      '.haa-back .haa-btn:disabled{opacity:.5;cursor:not-allowed}',
      /* ── cards + labels ─────────────────────────────────────────────── */
      '.haa-back .haa-card{background:var(--haa-card);border:1px solid var(--haa-line);',
      'border-radius:10px;padding:16px;margin-bottom:16px;color:var(--haa-text)}',
      '.haa-back .haa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.haa-back .haa-lbl{font-size:11px;font-weight:700;color:var(--haa-muted);text-transform:uppercase;',
      'letter-spacing:.4px;display:block;margin-bottom:4px}',
      '.haa-back .haa-empty{text-align:center;color:var(--haa-faint);padding:28px;font-size:13px}',
      '.haa-back .haa-pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;',
      'font-weight:700}',
      /* ── map ────────────────────────────────────────────────────────── */
      '.haa-back .haa-tiles{filter:var(--haa-map-filter)}',
      '.haa-back a{color:var(--haa-link)}',
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
      grab('reviews', '/api/attendance/location-reviews?status=Pending'),
      grab('arrangements', '/api/attendance/arrangements'),
      grab('roster', '/api/attendance/roster'),
      grab('homes', '/api/attendance/home-locations'),
      grab('mapFeed', '/api/attendance/map-feed')
    ]).then(function (r) {
      state.fences = Array.isArray(r[0]) ? r[0] : [];
      state.shifts = Array.isArray(r[1]) ? r[1] : [];
      state.assignments = Array.isArray(r[2]) ? r[2] : [];
      state.reviews = Array.isArray(r[3]) ? r[3] : [];
      state.arrangements = Array.isArray(r[4]) ? r[4] : [];
      state.roster = Array.isArray(r[5]) ? r[5] : [];
      state.homes = Array.isArray(r[6]) ? r[6] : [];
      state.mapFeed = r[7] && Array.isArray(r[7].employees) ? r[7] : { fences: state.fences, employees: [] };
      state.busy = false; render();
    });
  }

  function errorBanner(key) {
    var msg = state.errors && state.errors[key];
    if (!msg) return '';
    return '<div style="background:var(--haa-err-soft);border:1px solid var(--haa-err-line);color:var(--haa-err-fg);' +
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
        ((f.isActive === false) ? 'var(--haa-err-bg);color:var(--haa-err-fg)' : 'var(--haa-ok-bg);color:var(--haa-ok-fg)') + '">' +
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
      '<span style="font-size:12px;color:var(--haa-muted);">Place the centre precisely — a coordinate rounded to one ' +
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

  /* ── tab: work arrangements ──────────────────────────────────────────
   *
   * Where each person works: onsite, hybrid, or fully remote. This is the
   * control the geofence ultimately rests on — a 'remote' arrangement exempts
   * every check-in from it — so the form is deliberately explicit about what
   * each choice means rather than presenting three interchangeable words.
   *
   * Changes are effective-dated on the server: saving does not overwrite the
   * previous arrangement, it closes it and opens a new one. The form says so,
   * because "from when" looks like a formality until someone backdates a
   * change and wonders why last month's reports did not move.
   */
  var WEEKDAYS = [['0', 'Mon'], ['1', 'Tue'], ['2', 'Wed'], ['3', 'Thu'],
                  ['4', 'Fri'], ['5', 'Sat'], ['6', 'Sun']];

  function describeArrangement(a) {
    if (!a) return '<span style="color:var(--haa-faint)">Not set</span>';
    if (a.arrangement === 'remote') return 'Any day, anywhere';
    if (a.arrangement === 'onsite') return 'Office only';
    var days = (a.remoteWeekdays || []);
    if (days.length) {
      return 'Remote on ' + days.map(function (d) { return WEEKDAYS[d][1]; }).join(', ');
    }
    if (a.remoteDaysPerWeek > 0) {
      return a.remoteDaysPerWeek + ' remote day' +
        (a.remoteDaysPerWeek === 1 ? '' : 's') + ' a week, employee picks';
    }
    // The API refuses to create this, but a row predating that check, or one
    // written directly to the table, would otherwise render as a blank cell.
    return '<span style="color:var(--haa-warn-fg)">Hybrid with no remote days allocated</span>';
  }

  function arrangementPill(kind) {
    var c = kind === 'remote' ? 'var(--haa-info-bg);color:var(--haa-info-fg)'
      : kind === 'hybrid' ? 'var(--haa-warn-bg);color:var(--haa-warn-fg)'
      : 'var(--haa-chip);color:var(--haa-text2)';
    return '<span class="haa-pill" style="background:' + c + '">' +
      esc((kind || 'onsite').charAt(0).toUpperCase() + (kind || 'onsite').slice(1)) + '</span>';
  }

  /* The employee field.
   *
   * A dropdown, because typing an email is how an arrangement gets attached to
   * a typo: the API keys on the email string, so "ravi@evrsoft.com" creates a
   * perfectly valid arrangement for a person who does not exist, and the check
   * -in gate goes on refusing the real Ravi with nothing on screen to explain
   * why.
   *
   * Falls back to a free-text input if the roster could not be loaded, rather
   * than rendering an empty select — an empty dropdown is a dead end, and the
   * roster failing is not a reason to block the whole form.
   *
   * Whoever already has an arrangement is marked, so it is obvious when you are
   * about to supersede one rather than set a first.
   */
  function employeePicker() {
    if (!state.roster.length) {
      return '<input class="haa-in" id="haa-wa-email" placeholder="person@company.com">' +
        (state.errors.roster
          ? '<div style="font-size:11px;color:var(--haa-warn-fg);margin-top:4px">Employee list ' +
            'unavailable — type the address exactly.</div>'
          : '');
    }
    var have = {};
    state.arrangements.forEach(function (a) { have[a.email] = a.arrangement; });
    return '<select class="haa-in" id="haa-wa-email">' +
      '<option value="">Select an employee…</option>' +
      state.roster.map(function (u) {
        var tag = have[u.email] ? '  · ' + have[u.email] : '';
        return '<option value="' + esc(u.email) + '">' +
          esc(u.name) + ' (' + esc(u.email) + ')' + esc(tag) + '</option>';
      }).join('') +
      '</select>';
  }

  function arrangementsHtml() {
    var may = can('attendance.manage_arrangement');
    var rows = state.arrangements.map(function (a) {
      return '<tr><td>' + esc(a.employee || a.email) +
        (a.employee ? '<div style="font-size:11px;color:var(--haa-faint)">' + esc(a.email) + '</div>' : '') +
        '</td>' +
        '<td>' + arrangementPill(a.arrangement) + '</td>' +
        '<td style="font-size:13px">' + describeArrangement(a) + '</td>' +
        '<td style="font-size:13px">' + esc(a.effectiveFrom || '—') + '</td>' +
        '<td style="text-align:right">' +
        (may ? '<button class="haa-btn sec" data-arr-hist="' + esc(a.email) + '">History</button> ' +
               '<button class="haa-btn dgr" data-arr-del="' + a.id + '">Delete</button>' : '') +
        '</td></tr>';
    }).join('');

    var dayBoxes = WEEKDAYS.map(function (d) {
      return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:13px">' +
        '<input type="checkbox" class="haa-wa-day" value="' + d[0] + '"> ' + d[1] + '</label>';
    }).join('');

    var form = !may ? '' :
      '<div class="haa-card">' +
      '<div style="font-weight:700;margin-bottom:12px;font-size:14px;">Set a work arrangement</div>' +
      '<div class="haa-grid" style="margin-bottom:12px">' +
      '<div><label class="haa-lbl">Employee</label>' + employeePicker() + '</div>' +
      '<div><label class="haa-lbl">Arrangement</label>' +
      '<select class="haa-in" id="haa-wa-kind">' +
      '<option value="onsite">Onsite — office only</option>' +
      '<option value="hybrid">Hybrid — some remote days</option>' +
      '<option value="remote">Remote — works remotely full time</option>' +
      '</select></div>' +
      '<div><label class="haa-lbl">Effective from</label>' +
      '<input class="haa-in" id="haa-wa-from" type="date"></div>' +
      '</div>' +
      // Hybrid-only controls. Hidden rather than disabled: an onsite employee
      // has no remote days, and showing greyed-out day boxes invites the
      // reading that they exist but are switched off.
      '<div id="haa-wa-hybrid" style="display:none;border-top:1px solid var(--haa-line);padding-top:12px;margin-bottom:12px">' +
      '<label class="haa-lbl">Fixed remote days</label>' +
      '<div style="margin-bottom:10px">' + dayBoxes + '</div>' +
      '<div class="haa-grid">' +
      '<div><label class="haa-lbl">…or days per week</label>' +
      '<input class="haa-in" id="haa-wa-perweek" type="number" min="0" max="7" value="0"></div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--haa-muted);margin-top:8px">' +
      'Tick specific days for a team with fixed in-office days. Otherwise leave them ' +
      'unticked and set a number — the employee picks which days, up to that many a week. ' +
      'Ticked days win: the weekly number is ignored when any day is ticked.' +
      '</div></div>' +
      '<div><label class="haa-lbl">Note (optional)</label>' +
      '<input class="haa-in" id="haa-wa-note" placeholder="Agreed with manager, reviewed in Jan"></div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="haa-btn" id="haa-wa-save">Save arrangement</button>' +
      '<span style="font-size:12px;color:var(--haa-muted)">Saving does not overwrite the current ' +
      'arrangement — it ends it the day before this one starts, so past attendance stays ' +
      'judged by the rule that applied at the time.</span>' +
      '</div></div>';

    return errorBanner('arrangements') + form +
      (state.arrangements.length
        ? '<table class="haa-tbl"><thead><tr><th>Employee</th><th>Arrangement</th>' +
          '<th>Remote entitlement</th><th>Since</th><th></th></tr></thead><tbody>' +
          rows + '</tbody></table>'
        : (state.errors.arrangements ? ''
          : '<div class="haa-empty">No arrangements set. Everyone is treated as ' +
            'office-based and needs an approved WFH request to work remotely.</div>'));
  }

  /* Registered home addresses awaiting confirmation.
   *
   * Shown above the off-site queue because it gates it: an employee with no
   * confirmed home produces unverified WFH days rather than review items, so
   * an empty off-site queue can mean "nobody is working away from home" or
   * "nobody's home is registered yet", and those need telling apart.
   *
   * The map is the whole point of reviewing this. "17.4485, 78.3908" tells a
   * reviewer nothing; a circle over a residential street tells them whether to
   * confirm it, and a circle over an office park or a motorway tells them not
   * to. The captured GPS accuracy is shown for the same reason.
   */
  function homesHtml() {
    var may = can('attendance.approve_offsite');
    var pending = state.homes.filter(function (h) { return h.status === 'Pending'; });
    if (!pending.length) {
      var confirmed = state.homes.filter(function (h) { return h.status === 'Approved'; }).length;
      return errorBanner('homes') +
        '<div class="haa-card"><div style="font-weight:700;font-size:14px;margin-bottom:6px">' +
        'Home addresses</div><div style="font-size:13px;color:var(--haa-muted)">' +
        (confirmed
          ? confirmed + ' confirmed. Nothing waiting.'
          : 'None registered yet. Work-from-home check-ins are recorded but stay ' +
            'unverified until employees register a home address and it is confirmed.') +
        '</div></div>';
    }
    return errorBanner('homes') +
      '<div class="haa-card"><div style="font-weight:700;font-size:14px;margin-bottom:12px">' +
      'Home addresses awaiting confirmation (' + pending.length + ')</div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
      pending.map(function (h) {
        var acc = h.capturedAccuracy;
        return '<div style="border:1px solid var(--haa-line);border-radius:10px;padding:12px;max-width:400px">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:2px">' + esc(h.email) + '</div>' +
          '<div style="font-size:12px;color:var(--haa-muted);margin-bottom:10px">' +
          'Captured at GPS ' + (acc ? '±' + Math.round(acc) + ' m' : 'unknown accuracy') +
          ' · ' + esc(h.radiusMeters) + ' m radius' +
          (acc && acc > 100
            ? '<div style="color:var(--haa-warn-fg);margin-top:3px">Captured from a poor fix — ' +
              'check the map carefully before confirming.</div>'
            : '') +
          '</div>' +
          renderMap({ lat: h.latitude, lng: h.longitude, radius: h.radiusMeters,
                      label: 'Home', width: 360, height: 220 }) +
          (may
            ? '<div style="margin-top:10px">' +
              '<button class="haa-btn" data-home-ok="' + h.id + '">Confirm</button> ' +
              '<button class="haa-btn dgr" data-home-no="' + h.id + '">Reject</button></div>'
            : '<div style="font-size:12px;color:var(--haa-muted);margin-top:10px">You do not have ' +
              'permission to confirm home addresses.</div>') +
          '</div>';
      }).join('') +
      '</div></div>';
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
        '<div style="font-weight:700;font-size:14px;color:var(--haa-text)">' + esc(r.employee || r.email) + '</div>' +
        '<div style="font-size:12px;color:var(--haa-muted);margin-bottom:10px">' + esc(r.email) + '</div>' +
        '<div style="font-size:12px;color:var(--haa-muted)">Checked in</div>' +
        '<div style="font-size:13px;margin-bottom:10px">' + esc(r.date || '') + ' at ' +
        esc((r.checkIn || '').slice(11, 16) || '—') + '</div>' +
        '<div style="font-size:12px;color:var(--haa-muted)">Reason given</div>' +
        '<div style="font-size:13px;margin-bottom:14px;white-space:pre-wrap">' +
        esc(r.reason || '—') + '</div>' +
        (hasPos ? '<a href="https://maps.google.com/?q=' + esc(r.latitude) + ',' + esc(r.longitude) +
          '" target="_blank" rel="noopener" style="color:var(--haa-link);font-size:12px">Open in Google Maps</a><br><br>' : '') +
        // Deciding is a separate grant from reading the queue: someone who can
        // open this panel (attendance.edit) is not necessarily trusted to clear
        // a check-in from outside the fence. Showing buttons the server would
        // refuse just moves the refusal later and makes it look like a fault.
        (can('attendance.approve_offsite')
          ? '<button class="haa-btn" data-ok="' + r.id + '">Approve</button> ' +
            '<button class="haa-btn dgr" data-no="' + r.id + '">Reject</button>'
          : '<div style="font-size:12px;color:var(--haa-muted)">You do not have permission ' +
            'to approve or reject off-site check-ins.</div>') +
        '</div></div>';
    }).join('');
  }

  /* ── tab: interactive map & heatmap ───────────────────────────────────── */
  function liveMapHtml() {
    var feed = state.mapFeed || { fences: state.fences || [], employees: [] };
    var emps = feed.employees || [];
    var fences = feed.fences || state.fences || [];

    var totalActive = emps.length;
    var onSiteCount = emps.filter(function (e) { return e.geoVerified && !e.isWfh; }).length;
    var wfhCount = emps.filter(function (e) { return e.isWfh; }).length;
    var pendingCount = emps.filter(function (e) { return e.locationStatus === 'Pending' || e.status === 'Pending Review'; }).length;

    var depts = {};
    emps.forEach(function (e) { if (e.department) depts[e.department] = true; });
    var deptList = Object.keys(depts).sort();

    var deptOptions = '<option value="all">All Departments</option>' +
      deptList.map(function (d) {
        return '<option value="' + esc(d) + '"' + (state.deptFilter === d ? ' selected' : '') + '>' + esc(d) + '</option>';
      }).join('');

    return errorBanner('mapFeed') +
      '<div class="haa-map-toolbar" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;">' +
      '  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
      '    <div class="haa-map-btn-group" style="display:inline-flex;background:var(--haa-surface,#fff);border:1px solid var(--haa-line,#cbd5e1);border-radius:8px;padding:3px;">' +
      '      <button class="haa-map-tbtn ' + (state.mapMode !== 'heatmap' ? 'on' : '') + '" data-map-mode="markers">📍 Pins & Clusters</button>' +
      '      <button class="haa-map-tbtn ' + (state.mapMode === 'heatmap' ? 'on' : '') + '" data-map-mode="heatmap">🔥 Heatmap</button>' +
      '    </div>' +
      '    <div class="haa-map-filter-group" style="display:inline-flex;gap:4px;flex-wrap:wrap;">' +
      '      <button class="haa-map-chip ' + (state.mapFilter === 'all' ? 'on' : '') + '" data-map-flt="all">All (' + totalActive + ')</button>' +
      '      <button class="haa-map-chip ' + (state.mapFilter === 'onsite' ? 'on' : '') + '" data-map-flt="onsite">🏢 On-Site (' + onSiteCount + ')</button>' +
      '      <button class="haa-map-chip ' + (state.mapFilter === 'wfh' ? 'on' : '') + '" data-map-flt="wfh">🏠 Remote (' + wfhCount + ')</button>' +
      '      <button class="haa-map-chip ' + (state.mapFilter === 'pending' ? 'on' : '') + '" data-map-flt="pending">⏳ Pending (' + pendingCount + ')</button>' +
      '    </div>' +
      '  </div>' +
      '  <div style="display:flex;align-items:center;gap:8px;">' +
      '    <select class="haa-in" id="haa-map-dept" style="padding:6px 12px;font-size:12px;height:34px;border-radius:7px;">' + deptOptions + '</select>' +
      '    <button class="haa-btn sec" id="haa-map-refresh" style="height:34px;display:flex;align-items:center;gap:4px;font-size:12px;">🔄 Refresh</button>' +
      '  </div>' +
      '</div>' +
      '<div id="haa-live-map-container" style="position:relative;width:100%;height:560px;border-radius:12px;overflow:hidden;border:1px solid var(--haa-line,#cbd5e1);background:var(--haa-map-bg,#f8fafc);box-shadow:0 4px 20px rgba(0,0,0,0.12);"></div>' +
      '<div class="haa-map-stats-strip" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:12px;padding:10px 14px;background:var(--haa-surface,#fff);border:1px solid var(--haa-line,#cbd5e1);border-radius:8px;font-size:12px;color:var(--haa-muted,#64748b);">' +
      '  <div><strong style="color:var(--haa-text,#0f172a);">' + totalActive + '</strong> Active Now</div>' +
      '  <div><span style="color:#10b981;">●</span> <strong style="color:var(--haa-text,#0f172a);">' + onSiteCount + '</strong> On-Site Verified</div>' +
      '  <div><span style="color:#3b82f6;">●</span> <strong style="color:var(--haa-text,#0f172a);">' + wfhCount + '</strong> Remote / WFH</div>' +
      '  <div><span style="color:#f59e0b;">●</span> <strong style="color:var(--haa-text,#0f172a);">' + pendingCount + '</strong> Awaiting HR Approval</div>' +
      '  <div><strong style="color:var(--haa-text,#0f172a);">' + fences.length + '</strong> Office Geofences Configured</div>' +
      '</div>';
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
    body.innerHTML = state.tab === 'live_map' ? liveMapHtml()
      : state.tab === 'fences' ? fencesHtml()
      : state.tab === 'shifts' ? shiftsHtml()
      : state.tab === 'arrangements' ? arrangementsHtml()
      : (homesHtml() + reviewsHtml());
    wire(body);
  }

  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  function wire(body) {
    var mapHost = body.querySelector('#haa-live-map-container');
    if (mapHost) {
      state.interactiveMap = createInteractiveAttendanceMap(mapHost);

      var modeBtns = body.querySelectorAll('[data-map-mode]');
      for (var mb = 0; mb < modeBtns.length; mb++) {
        (function (b) {
          b.onclick = function () {
            var m = b.getAttribute('data-map-mode');
            state.mapMode = m;
            for (var j = 0; j < modeBtns.length; j++) modeBtns[j].classList.toggle('on', modeBtns[j] === b);
            if (state.interactiveMap) state.interactiveMap.setMode(m);
          };
        })(modeBtns[mb]);
      }

      var filterChips = body.querySelectorAll('[data-map-flt]');
      for (var fc = 0; fc < filterChips.length; fc++) {
        (function (c) {
          c.onclick = function () {
            var f = c.getAttribute('data-map-flt');
            state.mapFilter = f;
            for (var j = 0; j < filterChips.length; j++) filterChips[j].classList.toggle('on', filterChips[j] === c);
            if (state.interactiveMap) state.interactiveMap.setFilter(f);
          };
        })(filterChips[fc]);
      }

      var deptSel = body.querySelector('#haa-map-dept');
      if (deptSel) {
        deptSel.onchange = function () {
          state.deptFilter = deptSel.value;
          if (state.interactiveMap) state.interactiveMap.setDept(deptSel.value);
        };
      }

      var refBtn = body.querySelector('#haa-map-refresh');
      if (refBtn) {
        refBtn.onclick = function () {
          refBtn.disabled = true;
          refBtn.textContent = 'Refreshing…';
          api('/api/attendance/map-feed').then(function (d) {
            state.mapFeed = d || { fences: state.fences, employees: [] };
            render();
          }).catch(function (e) { toast(e.message, true); render(); });
        };
      }
    }
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

    function decideHome(attr, decision) {
      var els = body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          el.onclick = function () {
            el.disabled = true;
            api('/api/attendance/home-locations/review', {
              method: 'POST',
              body: JSON.stringify({ id: parseInt(el.getAttribute(attr), 10), decision: decision })
            }).then(function () {
              toast('Home address ' + decision.toLowerCase());
              loadAll();
            }).catch(function (e) { el.disabled = false; toast(e.message, true); });
          };
        })(els[i]);
      }
    }
    decideHome('data-home-ok', 'Approved');
    decideHome('data-home-no', 'Rejected');

    /* ── work arrangements ─────────────────────────────────────────────── */
    var kind = body.querySelector('#haa-wa-kind');
    if (kind) {
      var hybridBox = body.querySelector('#haa-wa-hybrid');
      var syncKind = function () {
        hybridBox.style.display = kind.value === 'hybrid' ? '' : 'none';
      };
      kind.onchange = syncKind;
      syncKind();

      // Default "effective from" to today rather than leaving it blank: an
      // empty date reads as "no opinion", and the server would silently pick
      // today anyway. Showing the date it will actually use is honest.
      var fromEl = body.querySelector('#haa-wa-from');
      if (fromEl && !fromEl.value) {
        var n = new Date();
        fromEl.value = n.getFullYear() + '-' +
          String(n.getMonth() + 1).padStart(2, '0') + '-' +
          String(n.getDate()).padStart(2, '0');
      }
    }

    var save = body.querySelector('#haa-wa-save');
    if (save) save.onclick = function () {
      var emailEl = body.querySelector('#haa-wa-email');
      var email = (emailEl.value || '').trim();
      if (!email) {
        return toast(emailEl.tagName === 'SELECT'
          ? 'Select an employee' : 'Employee email is required', true);
      }
      // Carry the name across so the table reads "Ravi Kumar", not a bare
      // address. Only the roster knows it; the arrangement row does not.
      var picked = null;
      for (var r = 0; r < state.roster.length; r++) {
        if (state.roster[r].email === email) { picked = state.roster[r]; break; }
      }
      var which = body.querySelector('#haa-wa-kind').value;

      var days = [];
      var boxes = body.querySelectorAll('.haa-wa-day');
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) days.push(boxes[i].value);
      var perWeek = parseInt(body.querySelector('#haa-wa-perweek').value, 10) || 0;

      // Catch the useless-hybrid case here as well as server-side: a round trip
      // to be told "pick something" is worse than being told before sending.
      if (which === 'hybrid' && !days.length && perWeek < 1) {
        return toast('Tick the remote days, or set how many days a week', true);
      }

      save.disabled = true;
      api('/api/attendance/arrangements', {
        method: 'POST',
        body: JSON.stringify({
          email: email,
          employee: picked ? picked.name : '',
          arrangement: which,
          remoteWeekdays: days,
          remoteDaysPerWeek: perWeek,
          effectiveFrom: body.querySelector('#haa-wa-from').value || null,
          notes: (body.querySelector('#haa-wa-note').value || '').trim()
        })
      }).then(function () {
        toast('Work arrangement saved');
        loadAll();
      }).catch(function (e) {
        save.disabled = false;
        toast(e.message, true);
      });
    };

    var hist = body.querySelectorAll('[data-arr-hist]');
    for (var h = 0; h < hist.length; h++) {
      (function (el) {
        el.onclick = function () {
          var em = el.getAttribute('data-arr-hist');
          api('/api/attendance/arrangements?email=' + encodeURIComponent(em))
            .then(function (rows) { showArrangementHistory(em, rows || []); })
            .catch(function (e) { toast(e.message, true); });
        };
      })(hist[h]);
    }

    var dels = body.querySelectorAll('[data-arr-del]');
    for (var d = 0; d < dels.length; d++) {
      (function (el) {
        el.onclick = function () {
          if (!window.confirm(
            'Delete this arrangement?\n\nThe one it replaced becomes current again. ' +
            'Use this to undo a mistake — to record a genuine change, save a new ' +
            'arrangement instead so the history is kept.')) return;
          el.disabled = true;
          api('/api/attendance/arrangements/' + el.getAttribute('data-arr-del'),
              { method: 'DELETE' })
            .then(function () { toast('Arrangement deleted'); loadAll(); })
            .catch(function (e) { el.disabled = false; toast(e.message, true); });
        };
      })(dels[d]);
    }
  }

  /* Full effective-dated history for one employee. Worth its own view: the
   * table shows only what is in force today, and "why was this check-in
   * allowed in March?" is answerable only from the row that applied then. */
  function showArrangementHistory(email, rows) {
    var back = document.createElement('div');
    // Same root class as the settings panel: this dialog renders .haa-tbl /
    // .haa-empty / .haa-btn markup and reads the panel's colour tokens, and
    // both are defined on .haa-back. As a bare div it got neither — no table
    // styling, and every var() falling back to inherited app colours on a
    // surface that is not the app's.
    back.className = 'haa-back';
    back.setAttribute('style', 'padding:20px');
    var body = rows.length ? rows.map(function (a) {
      return '<tr><td>' + esc(a.effectiveFrom || '—') + '</td>' +
        '<td>' + esc(a.effectiveTo || 'current') + '</td>' +
        '<td>' + arrangementPill(a.arrangement) + '</td>' +
        '<td style="font-size:13px">' + describeArrangement(a) + '</td>' +
        '<td style="font-size:12px;color:var(--haa-muted)">' + esc(a.notes || '') +
        (a.createdBy ? '<div>set by ' + esc(a.createdBy) + '</div>' : '') + '</td></tr>';
    }).join('') : '';

    back.innerHTML =
      '<div style="background:var(--haa-surface);color:var(--haa-text);border-radius:12px;' +
      'padding:20px;max-width:760px;width:100%;max-height:80vh;overflow:auto;' +
      'box-shadow:0 24px 70px rgba(0,0,0,.3);font-family:\'Segoe UI\',Arial,sans-serif">' +
      '<div style="font-weight:700;margin-bottom:4px">Work arrangement history</div>' +
      '<div style="font-size:12px;color:var(--haa-muted);margin-bottom:14px">' + esc(email) + '</div>' +
      (body
        ? '<table class="haa-tbl"><thead><tr><th>From</th><th>Until</th><th>Arrangement</th>' +
          '<th>Remote entitlement</th><th>Note</th></tr></thead><tbody>' + body + '</tbody></table>'
        : '<div class="haa-empty">No arrangement has ever been set for this employee.</div>') +
      '<div style="margin-top:16px;text-align:right">' +
      '<button class="haa-btn sec" id="haa-hist-close">Close</button></div></div>';

    document.body.appendChild(back);
    function shut() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.querySelector('#haa-hist-close').onclick = shut;
    back.addEventListener('click', function (e) { if (e.target === back) shut(); });
  }

  /* ── open / close ────────────────────────────────────────────────────── */
  function open() {
    if (document.getElementById(OVERLAY_ID)) return;
    injectStyle();
    var back = document.createElement('div');
    back.id = OVERLAY_ID;
    back.className = 'haa-back';
    back.innerHTML =
      '<div class="haa-panel" style="max-width:1100px;width:96vw;">' +
      '<div class="haa-head"><div class="haa-title">Attendance Administration & Live Map</div>' +
      '<button class="haa-btn sec" id="haa-close">Close</button></div>' +
      '<div class="haa-tabs">' +
      '<button class="haa-tab on" data-tab="live_map">🗺️ Live Map & Heatmap</button>' +
      '<button class="haa-tab" data-tab="fences">Office Locations</button>' +
      '<button class="haa-tab" data-tab="shifts">Shifts</button>' +
      '<button class="haa-tab" data-tab="reviews">Off-site Approvals</button>' +
      '<button class="haa-tab" data-tab="arrangements">Work Arrangements</button>' +
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
    return /check-?in/i.test(location.pathname + location.hash);
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
