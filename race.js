/* Strava Race – comparison page */
(() => {
  'use strict';

  const COLORS = ['#fc4c02', '#2563eb', '#16a34a', '#9333ea', '#ca8a04', '#0891b2', '#db2777', '#475569'];
  const NEAR_KM = 5;          // other tracks must come within this of the primary's area to be mapped
  const CHART_POINTS = 2000;  // max points per elevation series

  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const srcTab = params.get('tab') ? Number(params.get('tab')) : null;
  const primaryId = params.get('id');
  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id && chrome.tabs);

  const state = {
    activities: [],
    T: 0,
    maxT: 0,
    playing: false,
    speed: 60,
    mode: 'elapsed',
    follow: true
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    subtitle: $('subtitle'), racers: $('racers'), standings: $('standings'),
    addForm: $('addForm'), addInput: $('addInput'), recent: $('recent'), matched: $('matched'), tiles: $('tiles'), addStatus: $('addStatus'),
    mapNote: $('mapNote'), play: $('play'), playIcon: $('playIcon'), pauseIcon: $('pauseIcon'),
    timeline: $('timeline'), clock: $('clock'), total: $('total'),
    speed: $('speed'), mode: $('mode'), follow: $('follow')
  };

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  function fmtGap(sec) {
    sec = Math.round(Math.abs(sec));
    if (sec < 60) return `+${sec}s`;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `+${h}:${pad(m)}:${pad(s)}` : `+${m}:${pad(s)}`;
  }
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
  const fmtPace = (mPerS) => {
    if (!(mPerS > 0.3)) return '–';
    const secPerKm = 1000 / mPerS;
    return `${Math.floor(secPerKm / 60)}:${pad(Math.round(secPerKm % 60))} /km`;
  };
  const fmtSpeed = (mPerS) => (mPerS * 3.6).toFixed(1) + ' km/h';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setStatus(msg, isError) {
    el.addStatus.textContent = msg || '';
    el.addStatus.classList.toggle('error', !!isError);
  }

  // ---------------------------------------------------------------------------
  // Strava data access
  // ---------------------------------------------------------------------------
  // Requests go through a strava.com tab's content script so they carry the
  // user's Strava session. Falls back to a direct fetch from this page.
  async function stravaFetch(path, { as = 'json', headers = {} } = {}) {
    let body = null;
    if (hasChrome) {
      const ids = [];
      if (srcTab != null) ids.push(srcTab);
      try {
        const tabs = await chrome.tabs.query({ url: 'https://www.strava.com/*' });
        tabs.forEach((t) => { if (!ids.includes(t.id)) ids.push(t.id); });
      } catch (_) { /* ignore */ }

      for (const id of ids) {
        let res;
        try {
          res = await chrome.tabs.sendMessage(id, { type: 'stravaFetch', path, headers });
        } catch (_) {
          continue; // no content script in that tab – try the next one
        }
        if (!res) continue;
        if (!res.ok) throw new Error(res.status ? `Strava responded ${res.status}` : (res.error || 'Request failed'));
        if (res.url && /\/login|\/session/.test(res.url)) throw new Error('Not logged in to Strava');
        body = res.body;
        break;
      }
    }
    if (body == null) {
      const res = await fetch('https://www.strava.com' + path, { credentials: 'include', headers });
      if (!res.ok) throw new Error(`Strava responded ${res.status}`);
      body = await res.text();
    }
    if (as === 'text') return body;
    try { return JSON.parse(body); } catch (_) {
      throw new Error('Unexpected response – are you logged in, and is the activity visible to you?');
    }
  }

  function parseActivityId(input) {
    const s = String(input || '').trim();
    const m = s.match(/activities\/(\d+)/) || s.match(/^(\d+)$/);
    return m ? m[1] : null;
  }

  // Name, athlete and start date (local calendar date, as a UTC midnight
  // timestamp) from the activity page.
  async function fetchActivityMeta(id) {
    const meta = { name: null, athlete: null, date: null };
    let html;
    try { html = await stravaFetch(`/activities/${id}`, { as: 'text' }); } catch (_) { return meta; }
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Title looks like "Morning Run | Run | Strava".
    const og = doc.querySelector('meta[property="og:title"]');
    const parts = ((og && og.content) || doc.title || '').split(' | ');
    meta.name = (parts.length >= 3 ? parts.slice(0, -2) : parts.filter((p) => !/^strava$/i.test(p.trim()))).join(' | ').trim() || null;

    try {
      const ath = extractJsonArg(html, 'activityAthlete = new Strava.Models.Athlete(');
      if (ath) meta.athlete = { id: String(ath.id), name: ath.display_name || [ath.first_name, ath.last_name].filter(Boolean).join(' ') };
    } catch (_) { /* ignore */ }

    // Runs with matched activities embed exact start dates; use our own entry if present.
    try {
      const sim = extractJsonArg(html, 'similarActivitiesData(');
      const own = sim && (sim.efforts || []).find((e) => String(e.activity_id) === String(id));
      if (own && own.start_date_local) meta.date = localEpochToDay(own.start_date_local);
    } catch (_) { /* ignore */ }

    // Otherwise parse the localized <time> text, e.g. "16.12 på fredag, 30. oktober 2026".
    if (meta.date == null) {
      const t = doc.querySelector('.details time, time');
      if (t) meta.date = parseLocalizedDate(t.getAttribute('datetime') || t.textContent, doc.documentElement.lang);
    }
    return meta;
  }

  // start_date_local is local wall-clock time expressed as epoch seconds.
  const localEpochToDay = (sec) => {
    const d = new Date(sec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };

  function parseLocalizedDate(text, lang) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const year = t.match(/\b(19|20)\d{2}\b/);
    if (!year) return null;
    let best = null;
    for (const locale of [lang, 'en'].filter(Boolean)) {
      for (const style of ['long', 'short']) {
        let fmt;
        try { fmt = new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }); } catch (_) { continue; }
        for (let m = 0; m < 12; m++) {
          const name = fmt.format(new Date(Date.UTC(2000, m, 1))).toLowerCase().replace(/\.$/, '');
          const idx = t.indexOf(name);
          if (idx >= 0 && (!best || name.length > best.name.length)) best = { m, idx, name };
        }
      }
      if (best) break;
    }
    if (!best) return null;
    const before = t.slice(0, best.idx).match(/(\d{1,2})\D{0,3}$/);
    const after = t.slice(best.idx + best.name.length).match(/^\D{0,3}(\d{1,2})\b/);
    const day = before ? +before[1] : after ? +after[1] : null;
    return day ? Date.UTC(+year[0], best.m, day) : null;
  }

  function fmtDate(day, short) {
    if (day == null) return '';
    const d = new Date(day);
    const opts = { timeZone: 'UTC', day: 'numeric', month: 'short' };
    if (!short || d.getUTCFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  async function fetchStreams(id) {
    const q = ['latlng', 'distance', 'altitude', 'time', 'moving'].map((t) => `stream_types[]=${t}`).join('&');
    return stravaFetch(`/activities/${id}/streams?${q}`);
  }

  async function fetchRecentActivities() {
    const data = await stravaFetch('/athlete/training_activities?page=1&per_page=50', {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript' }
    });
    return (data && (data.models || data.activities || data)) || [];
  }

  // Pulls the JSON object passed to e.g. `.similarActivitiesData({...})` out of
  // a page's inline script, using string-aware bracket matching.
  function extractJsonArg(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    if (start < 0) return null;
    let depth = 0, inStr = false, escaped = false;
    for (let k = start; k < html.length; k++) {
      const c = html[k];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (--depth === 0) return JSON.parse(html.slice(start, k + 1));
      }
    }
    return null;
  }

  // Strava's "Matched activities" view (/activities/{id}/matched) embeds the
  // list of same-route efforts in an inline script.
  async function fetchMatchedActivities(id) {
    const html = await stravaFetch(`/activities/${id}/matched`, { as: 'text' });
    const data = extractJsonArg(html, 'similarActivitiesData(');
    return (data && data.efforts) || [];
  }

  // ---------------------------------------------------------------------------
  // Activity model
  // ---------------------------------------------------------------------------
  function buildActivity(id, name, s) {
    const time = s.time, distance = s.distance;
    if (!time || !time.length || !distance || distance.length !== time.length) {
      throw new Error('This activity has no time/distance data');
    }
    const n = time.length;
    const tElapsed = new Float64Array(n);
    const tMoving = new Float64Array(n);
    const dist = new Float64Array(n);
    const moving = s.moving && s.moving.length === n ? s.moving : null;
    for (let i = 0; i < n; i++) {
      tElapsed[i] = time[i] - time[0];
      dist[i] = Math.max(distance[i] || 0, i ? dist[i - 1] : 0); // keep monotonic
      if (i) {
        const dt = time[i] - time[i - 1];
        tMoving[i] = tMoving[i - 1] + (moving && !moving[i] ? 0 : dt);
      }
    }
    const alt = s.altitude && s.altitude.length === n ? Float64Array.from(s.altitude) : null;
    const latlng = s.latlng && s.latlng.length === n ? s.latlng : null;

    let bbox = null;
    if (latlng) {
      bbox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [la, ln] of latlng) {
        if (la < bbox[0]) bbox[0] = la; if (ln < bbox[1]) bbox[1] = ln;
        if (la > bbox[2]) bbox[2] = la; if (ln > bbox[3]) bbox[3] = ln;
      }
    }
    let gain = 0;
    if (alt) for (let i = 1; i < n; i++) { const d = alt[i] - alt[i - 1]; if (d > 0) gain += d; }

    return { id: String(id), name, n, tElapsed, tMoving, dist, alt, latlng, bbox, gain, totalDist: dist[n - 1] };
  }

  const times = (a) => (state.mode === 'moving' ? a.tMoving : a.tElapsed);
  const duration = (a) => { const t = times(a); return t[t.length - 1]; };

  // Last index i with arr[i] <= v (arr is non-decreasing).
  function indexAt(arr, v) {
    let lo = 0, hi = arr.length - 1;
    if (v <= arr[0]) return 0;
    if (v >= arr[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid; else hi = mid;
    }
    return lo;
  }

  function positionAt(a, T) {
    const t = times(a), n = a.n;
    let i, f;
    if (T >= t[n - 1]) { i = n - 1; f = 0; } else {
      i = indexAt(t, T);
      const span = t[i + 1] - t[i];
      f = span > 0 ? (T - t[i]) / span : 0;
    }
    const j = Math.min(i + 1, n - 1);
    const lerp = (x, y) => x + (y - x) * f;
    return {
      i, f,
      finished: T >= t[n - 1],
      d: lerp(a.dist[i], a.dist[j]),
      alt: a.alt ? lerp(a.alt[i], a.alt[j]) : 0,
      ll: a.latlng ? [lerp(a.latlng[i][0], a.latlng[j][0]), lerp(a.latlng[i][1], a.latlng[j][1])] : null
    };
  }

  // Time (on the current clock) at which activity a reached distance d.
  function timeAtDistance(a, d) {
    const t = times(a), n = a.n;
    if (d >= a.dist[n - 1]) return t[n - 1];
    const i = indexAt(a.dist, d);
    const span = a.dist[i + 1] - a.dist[i];
    const f = span > 0 ? (d - a.dist[i]) / span : 0;
    return t[i] + (t[i + 1] - t[i]) * f;
  }

  // Instantaneous speed around time T (m/s), over a ~30 s window.
  function speedAt(a, T) {
    const t0 = Math.max(0, T - 15), t1 = Math.min(duration(a), T + 15);
    if (t1 - t0 < 1) return 0;
    return (positionAt(a, t1).d - positionAt(a, t0).d) / (t1 - t0);
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  // Highcharts Maps with a tiled web map background.
  const TILE_PROVIDERS = {
    topo: { type: 'Esri', theme: 'WorldTopoMap' },
    osm: { type: 'OpenStreetMap', theme: 'Standard' },
    satellite: { type: 'Esri', theme: 'WorldImagery' }
  };
  const MAP_POINTS = 2000; // max points per track line
  let mapChart = null;
  let tileProvider = 'topo';

  // A manual pan pauses "follow leader" until it's ticked again.
  (() => {
    let down = null;
    const mapEl = $('map');
    mapEl.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    mapEl.addEventListener('pointermove', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
        down.moved = true;
        panAnim = null;
        if (state.follow) { state.follow = false; el.follow.checked = false; }
      }
    });
    window.addEventListener('pointerup', () => {
      // Also after +/- button zooms, once their animation has finished.
      if (down) setTimeout(settleView, down.moved ? 0 : 450);
      down = null;
    });
    // Trackpads zoom in fractions; settle on a whole zoom level when they stop.
    let wheelTimer = null;
    mapEl.addEventListener('wheel', () => {
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(settleView, 250);
    }, { passive: true });
  })();

  function settleView() {
    if (!mapChart) return;
    const mv = mapChart.mapView;
    if (Math.abs(mv.zoom - Math.round(mv.zoom)) > 1e-6) mv.setView(mv.center, Math.round(mv.zoom), false);
    mapChart.mapView.redraw(false);
    if (snapToPixelGrid()) mapChart.mapView.redraw(false);
  }

  el.tiles.addEventListener('change', () => {
    tileProvider = el.tiles.value;
    if (mapChart) mapChart.series[0].update({ provider: TILE_PROVIDERS[tileProvider] });
  });

  let mapRefs = []; // per activity: { progress, marker, coords, step } or null

  function anchorActivity() {
    return state.activities.find((a) => a.bbox) || null;
  }

  function isNear(anchor, a) {
    if (!a.bbox || !anchor) return false;
    if (a === anchor) return true;
    const latPad = NEAR_KM / 111;
    const midLat = (anchor.bbox[0] + anchor.bbox[2]) / 2;
    const lngPad = NEAR_KM / (111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
    const b = anchor.bbox;
    return !(a.bbox[2] < b[0] - latPad || a.bbox[0] > b[2] + latPad ||
             a.bbox[3] < b[1] - lngPad || a.bbox[1] > b[3] + lngPad);
  }

  let lastBoxKey = '';

  function ensureMapChart() {
    if (mapChart) return;
    mapChart = Highcharts.mapChart('map', {
      chart: { animation: false, margin: 0, style: { fontFamily: 'inherit' } },
      title: { text: undefined },
      legend: { enabled: false },
      credits: { position: { align: 'right', x: -6, y: -4 }, style: { fontSize: '10px' } },
      mapNavigation: {
        enabled: true,
        enableMouseWheelZoom: true,
        mouseWheelSensitivity: 2, // one wheel notch = one whole zoom level
        buttonOptions: { align: 'left', verticalAlign: 'top', x: 10, y: 10 }
      },
      mapView: {
        center: [10.75, 59.91],
        zoom: 4,
        // Pan limits = the whole world, not the routes. Otherwise Highcharts
        // pins the centre to the routes whenever they fit in the view.
        fitToGeometry: { type: 'MultiPoint', coordinates: [[-180, -85], [180, 85]] }
      },
      tooltip: { headerFormat: '', hideDelay: 100 },
      plotOptions: {
        series: { animation: false, states: { inactive: { opacity: 1 }, hover: { enabled: false } } },
        mapline: { enableMouseTracking: false, zIndex: 1 },
        mappoint: { zIndex: 2 }
      },
      series: [
        { type: 'tiledwebmap', name: 'Tiles', provider: TILE_PROVIDERS[tileProvider], enableMouseTracking: false, zIndex: 0 }
      ]
    });
    Highcharts.addEvent(mapChart, 'render', crispTiles);
  }

  // Tiles only render 1:1 at whole zoom levels (Highcharts uses tiles from
  // floor(zoom) and scales them), so fit the routes at an integer zoom.
  function fitMap(box) {
    const mv = mapChart.mapView;
    const sw = mv.lonLatToProjectedUnits({ lon: box[1], lat: box[0] });
    const ne = mv.lonLatToProjectedUnits({ lon: box[3], lat: box[2] });
    mv.fitToBounds({ x1: Math.min(sw.x, ne.x), y1: Math.min(sw.y, ne.y), x2: Math.max(sw.x, ne.x), y2: Math.max(sw.y, ne.y) }, 40, false);
    mv.setView(mv.center, Math.floor(mv.zoom), false);
    mapChart.mapView.redraw(false);
    snapToPixelGrid();
  }

  // Shift the view by the sub-pixel remainder so tile edges land on whole
  // pixels. Reads an actual tile's position, so call it after a redraw.
  function snapToPixelGrid() {
    const mv = mapChart.mapView;
    const zoom = Math.round(mv.zoom);
    if (Math.abs(mv.zoom - zoom) > 1e-6) return false;
    const level = mapChart.series[0].tiles && mapChart.series[0].tiles[zoom];
    const tile = level && Object.values(level.tiles)[0];
    if (!tile) return false;
    const x = Number(tile.attr('x')), y = Number(tile.attr('y'));
    const fx = x - Math.round(x), fy = y - Math.round(y);
    if (Math.abs(fx) < 0.005 && Math.abs(fy) < 0.005) return false;
    const c = mv.pixelsToLonLat({ x: mapChart.plotWidth / 2 + fx, y: mapChart.plotHeight / 2 + fy });
    if (!c) return false;
    mv.setView([c.lon, c.lat], zoom, false);
    return true;
  }

  // Highcharts draws each tile 1px larger than its slot to hide seams when
  // tiles are scaled. At 1:1 that 1px stretch blurs them, so undo it.
  function crispTiles() {
    const mv = mapChart.mapView;
    if (Math.abs(mv.zoom - Math.round(mv.zoom)) > 1e-6) return;
    const group = mapChart.series[0] && mapChart.series[0].group;
    if (!group) return;
    group.element.querySelectorAll('image').forEach((img) => {
      if (img.getAttribute('width') === '257') img.setAttribute('width', '256');
      if (img.getAttribute('height') === '257') img.setAttribute('height', '256');
    });
  }

  function rebuildMap() {
    const anchor = anchorActivity();
    const far = [], noGps = [];
    const lines = [], markers = [];
    const box = [Infinity, Infinity, -Infinity, -Infinity]; // minLat, minLon, maxLat, maxLon
    mapRefs = [];

    state.activities.forEach((a, idx) => {
      a.onMap = isNear(anchor, a);
      if (!a.latlng) noGps.push(a);
      else if (!a.onMap) far.push(a);
      if (!a.onMap) { mapRefs.push(null); return; }

      const step = Math.max(1, Math.ceil(a.n / MAP_POINTS));
      const coords = [];
      for (let i = 0; i < a.n; i += step) coords.push([a.latlng[i][1], a.latlng[i][0]]);
      coords.push([a.latlng[a.n - 1][1], a.latlng[a.n - 1][0]]);

      lines.push({
        type: 'mapline', id: 'track' + idx, color: Highcharts.color(a.color).setOpacity(0.45).get('rgba'), lineWidth: 3,
        data: [{ geometry: { type: 'LineString', coordinates: coords } }]
      });
      lines.push({
        type: 'mapline', id: 'progress' + idx, color: a.color, lineWidth: 5,
        data: [{ geometry: { type: 'LineString', coordinates: [coords[0], coords[0]] } }]
      });
      markers.push({
        type: 'mappoint', id: 'marker' + idx, color: a.color,
        data: [{ lon: coords[0][0], lat: coords[0][1] }],
        marker: { symbol: 'circle', radius: 11, fillColor: a.color, lineColor: '#fff', lineWidth: 2 },
        enableMouseTracking: true,
        tooltip: { pointFormatter: () => `<b>${esc(a.name)}</b><br>${esc(a.subtitle || '')}` },
        dataLabels: [{
          enabled: true, allowOverlap: false, align: 'center', verticalAlign: 'middle', y: 0,
          formatter: () => String(idx + 1),
          style: { color: '#fff', textOutline: 'none', fontSize: '11px', fontWeight: '700' }
        }, {
          enabled: true, allowOverlap: false, align: 'left', verticalAlign: 'middle', x: 16, y: 0,
          formatter: () => esc(a.label),
          style: { color: a.color, textOutline: '2px #fff', fontSize: '11px', fontWeight: '600' }
        }]
      });
      mapRefs.push({ progressId: 'progress' + idx, markerId: 'marker' + idx, coords, step, lastProgress: 0 });

      box[0] = Math.min(box[0], a.bbox[0]); box[1] = Math.min(box[1], a.bbox[1]);
      box[2] = Math.max(box[2], a.bbox[2]); box[3] = Math.max(box[3], a.bbox[3]);
    });

    ensureMapChart();
    // Swap the racer series in place, so the tile layer isn't re-created.
    mapChart.series.slice(1).forEach((series) => series.remove(false));
    [...lines, ...markers].forEach((opts) => mapChart.addSeries(opts, false));
    const boxKey = box.join(',');
    if (isFinite(box[0]) && boxKey !== lastBoxKey) {
      lastBoxKey = boxKey;
      fitMap(box);
    }
    mapChart.mapView.redraw(false);

    const notes = [];
    if (far.length) notes.push(`Not on map (too far from the primary route): ${far.map((a) => a.name).join(', ')}`);
    if (noGps.length) notes.push(`No GPS data: ${noGps.map((a) => a.name).join(', ')}`);
    el.mapNote.hidden = !notes.length;
    el.mapNote.textContent = notes.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Elevation chart
  // ---------------------------------------------------------------------------
  let chart = null;

  function rebuildChart() {
    if (chart) chart.destroy();
    const series = [];
    state.activities.forEach((a, idx) => {
      const step = Math.max(1, Math.ceil(a.n / CHART_POINTS));
      const data = [];
      for (let i = 0; i < a.n; i += step) data.push([a.dist[i] / 1000, a.alt ? Math.round(a.alt[i] * 10) / 10 : null]);
      if ((a.n - 1) % step) data.push([a.dist[a.n - 1] / 1000, a.alt ? a.alt[a.n - 1] : null]);
      series.push({
        type: 'area', id: 'p' + idx, name: a.name, color: a.color, data,
        fillOpacity: 0.07, lineWidth: 2, threshold: null,
        custom: { idx }
      });
      series.push({
        type: 'scatter', linkedTo: 'p' + idx, name: a.name, color: a.color,
        data: [[0, a.alt ? a.alt[0] : 0]],
        marker: { symbol: 'circle', radius: 7, lineWidth: 2, lineColor: '#fff' },
        dataLabels: {
          enabled: true, formatter: () => esc(a.label), align: 'left', verticalAlign: 'middle', x: 6, y: 0,
          crop: false, overflow: 'allow',
          style: { color: a.color, fontSize: '11px', fontWeight: '600', textOutline: '2px #fff' }
        },
        enableMouseTracking: false, zIndex: 10, animation: false, showInLegend: false
      });
    });

    chart = Highcharts.chart('chart', {
      chart: { animation: false, spacing: [12, 16, 8, 8], style: { fontFamily: 'inherit' } },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        title: { text: undefined },
        labels: { format: '{value} km' },
        crosshair: { color: '#9997', width: 1 },
        min: 0
      },
      yAxis: {
        title: { text: undefined },
        labels: { format: '{value} m' },
        gridLineColor: '#eee'
      },
      tooltip: {
        shared: true,
        headerFormat: '<span style="font-size:11px">{point.key:.2f} km</span><br>',
        pointFormat: '<span style="color:{series.color}">●</span> {series.name}: <b>{point.y:.0f} m</b><br>',
        valueDecimals: 0
      },
      plotOptions: {
        series: {
          animation: false,
          states: { inactive: { opacity: 1 } },
          cursor: 'pointer',
          point: {
            events: {
              // Click the profile to jump to when that racer reached that distance.
              click() {
                const a = state.activities[this.series.options.custom?.idx];
                if (a) seek(timeAtDistance(a, this.x * 1000));
              }
            }
          }
        },
        area: { marker: { enabled: false } }
      },
      series
    });
  }

  // ---------------------------------------------------------------------------
  // Sidebar: racers list & recent activities
  // ---------------------------------------------------------------------------
  function renderRacers() {
    el.racers.innerHTML = state.activities.map((a, idx) => {
      const dur = duration(a);
      const avg = dur > 0 ? a.totalDist / dur : 0;
      const badges = [];
      if (idx === 0) badges.push('<span class="badge primary">Primary</span>');
      if (a.latlng && !a.onMap) badges.push('<span class="badge">Not on map – too far away</span>');
      if (!a.latlng) badges.push('<span class="badge">No GPS</span>');
      if (!a.alt) badges.push('<span class="badge">No elevation</span>');
      const link = DEMO ? '#' : `https://www.strava.com/activities/${a.id}`;
      return `<li>
        <span class="swatch" style="background:${a.color}"></span>
        <div>
          <a class="racer-name" href="${link}" target="_blank" rel="noopener">${idx + 1}. ${esc(a.name)}</a>
          ${a.subtitle ? `<div class="racer-sub">${esc(a.subtitle)}</div>` : ''}
          <div class="racer-meta">${fmtKm(a.totalDist)} · ${fmtTime(dur)} · ${fmtPace(avg)} · ↑${Math.round(a.gain)} m</div>
          ${badges.join(' ')}
        </div>
        ${idx === 0 ? '<span></span>' : `<button class="remove" data-idx="${idx}" title="Remove">×</button>`}
      </li>`;
    }).join('');
  }

  el.racers.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove');
    if (!btn) return;
    state.activities.splice(Number(btn.dataset.idx), 1);
    recolor();
    refreshAll();
  });

  function recolor() {
    state.activities.forEach((a, i) => { a.color = COLORS[i % COLORS.length]; });
  }

  async function populateRecent() {
    if (DEMO) {
      el.recent.innerHTML = '<option value="">Not available in demo mode</option>';
      return;
    }
    try {
      const list = await fetchRecentActivities();
      const opts = ['<option value="">Choose an activity…</option>'];
      list.forEach((m) => {
        if (!m || !m.id || String(m.id) === String(primaryId)) return;
        const date = m.start_date || m.start_time || m.start_date_local_raw || '';
        const bits = [m.name, m.display_type || m.type, m.distance && (typeof m.distance === 'number' ? fmtKm(m.distance) : m.distance), String(date).slice(0, 16)];
        if (m.name) knownNames.set(String(m.id), m.name);
        opts.push(`<option value="${esc(m.id)}">${esc(bits.filter(Boolean).join(' · '))}</option>`);
      });
      el.recent.innerHTML = opts.length > 1 ? opts.join('') : '<option value="">No recent activities found</option>';
      el.recent.disabled = opts.length <= 1;
    } catch (err) {
      el.recent.innerHTML = '<option value="">Couldn’t load recent activities</option>';
      el.recent.disabled = true;
    }
  }

  async function populateMatched() {
    if (DEMO) {
      el.matched.innerHTML = '<option value="">Not available in demo mode</option>';
      return;
    }
    try {
      const efforts = (await fetchMatchedActivities(primaryId))
        .filter((m) => m && m.activity_id && String(m.activity_id) !== String(primaryId));
      if (!efforts.length) {
        el.matched.innerHTML = '<option value="">No matched activities</option>';
        return;
      }
      const medal = { 1: '🥇 ', 2: '🥈 ', 3: '🥉 ' };
      const opts = [
        '<option value="">Choose a matched activity…</option>',
        `<option value="__all__">➕ Add all ${efforts.length} matched activities</option>`
      ];
      efforts.forEach((m) => {
        const id = String(m.activity_id);
        const v = (m.activity_values && m.activity_values.values) || {};
        // start_date_local is local wall-clock time expressed as epoch seconds.
        const date = m.start_date_local
          ? new Date(m.start_date_local * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
          : '';
        const bits = [
          (medal[m.pr_rank] || '') + date,
          m.activity_name,
          v.distance ? fmtKm(v.distance) : '',
          m.moving_time ? fmtTime(m.moving_time) : '',
          m.average_speed ? fmtPace(m.average_speed) : ''
        ];
        if (m.activity_name) knownNames.set(id, m.activity_name);
        if (m.start_date_local) knownDates.set(id, localEpochToDay(m.start_date_local));
        opts.push(`<option value="${esc(id)}">${esc(bits.filter(Boolean).join(' · '))}</option>`);
      });
      el.matched.innerHTML = opts.join('');
      el.matched.disabled = false;
    } catch (_) {
      el.matched.innerHTML = '<option value="">No matched activities</option>';
    }
  }

  async function addActivity(id, knownName) {
    if (!id) { setStatus('Enter a Strava activity URL or ID.', true); return; }
    if (state.activities.some((a) => a.id === String(id))) { setStatus('That activity is already in the race.', true); return; }
    setStatus('Loading activity…');
    el.addForm.querySelector('button').disabled = true;
    try {
      const [streams, meta] = await Promise.all([fetchStreams(id), fetchActivityMeta(id)]);
      const a = buildActivity(id, meta.name || knownName || `Activity ${id}`, streams);
      a.athlete = meta.athlete;
      a.date = meta.date != null ? meta.date : (knownDates.has(String(id)) ? knownDates.get(String(id)) : null);
      state.activities.push(a);
      recolor();
      refreshAll();
      setStatus('');
      return a;
    } catch (err) {
      setStatus(`Couldn’t load activity ${id}: ${err.message}`, true);
      throw err;
    } finally {
      el.addForm.querySelector('button').disabled = false;
    }
  }

  el.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = parseActivityId(el.addInput.value);
    if (!id) { setStatus('That doesn’t look like a Strava activity URL or ID.', true); return; }
    addActivity(id).then(() => { el.addInput.value = ''; }).catch(() => {});
  });

  // Names/dates from the select lists, used as fallbacks for the activity page.
  const knownNames = new Map();
  const knownDates = new Map();

  function onPick(select) {
    select.addEventListener('change', async () => {
      const id = select.value;
      select.value = '';
      if (!id) return;
      if (id === '__all__') {
        const ids = [...select.options].map((o) => o.value).filter((v) => /^\d+$/.test(v));
        for (const mid of ids) {
          if (state.activities.some((a) => a.id === mid)) continue;
          try { await addActivity(mid, knownNames.get(mid)); } catch (_) { /* status shown; keep going */ }
        }
        return;
      }
      addActivity(id, knownNames.get(id)).catch(() => {});
    });
  }
  onPick(el.recent);
  onPick(el.matched);

  // ---------------------------------------------------------------------------
  // Race rendering
  // ---------------------------------------------------------------------------
  // With one athlete, racers are told apart by date; with several, by athlete.
  function updateLabels() {
    const athletes = new Set(state.activities.filter((a) => a.athlete).map((a) => a.athlete.id));
    const multi = athletes.size > 1;
    state.activities.forEach((a) => {
      const who = multi && a.athlete ? a.athlete.name : '';
      a.subtitle = [fmtDate(a.date), who].filter(Boolean).join(' · ');
      a.label = (multi ? who : fmtDate(a.date, true)) || a.name;
    });
  }

  function refreshAll() {
    state.maxT = state.activities.reduce((m, a) => Math.max(m, duration(a)), 0);
    state.T = Math.min(state.T, state.maxT);
    el.timeline.max = String(Math.ceil(state.maxT));
    el.total.textContent = '/ ' + fmtTime(state.maxT);
    el.play.disabled = !state.activities.length;
    updateLabels();
    rebuildMap();
    rebuildChart();
    renderRacers();
    render(true);
  }

  let lastChartUpdate = 0;
  let panAnim = null; // { from, to, start, dur } while the map slides

  function render(force) {
    const T = state.T;
    const positions = state.activities.map((a) => positionAt(a, T));

    // Map markers + progress trail
    const now = performance.now();
    let leaderLL = null, leaderD = -1;
    positions.forEach((p, idx) => {
      const ref = mapRefs[idx];
      if (!ref || !p.ll) return;
      // Move the existing point (keeps its marker and label elements).
      mapChart.get(ref.markerId).points[0].update({ lon: p.ll[1], lat: p.ll[0] }, false, false);
      // The trail is costlier to redraw, so update it ~10 times a second.
      if (force || now - ref.lastProgress > 100) {
        ref.lastProgress = now;
        const pts = ref.coords.slice(0, Math.floor(p.i / ref.step) + 1);
        pts.push([p.ll[1], p.ll[0]]);
        mapChart.get(ref.progressId).points[0].update({ geometry: { type: 'LineString', coordinates: pts } }, false, false);
      }
      if (p.d > leaderD && !p.finished) { leaderD = p.d; leaderLL = p.ll; }
    });
    if (!leaderLL) { // everyone finished – follow whoever's furthest along
      positions.forEach((p, idx) => { if (mapRefs[idx] && p.ll && p.d > leaderD) { leaderD = p.d; leaderLL = p.ll; } });
    }
    if (mapChart) {
      let viewMoved = false;
      if (state.follow && state.playing && leaderLL && !panAnim) {
        const px = mapChart.mapView.lonLatToPixels({ lon: leaderLL[1], lat: leaderLL[0] });
        const w = mapChart.plotWidth, h = mapChart.plotHeight;
        if (px && (px.x < w * 0.2 || px.x > w * 0.8 || px.y < h * 0.2 || px.y > h * 0.8)) {
          panAnim = { from: mapChart.mapView.center.slice(), to: [leaderLL[1], leaderLL[0]], start: now, dur: 800 };
        }
      }
      if (panAnim) {
        // Ease the map centre towards the target, a frame at a time, so the
        // slide stays in step with the racer markers.
        const k = Math.min(1, (now - panAnim.start) / panAnim.dur);
        const e = 0.5 - Math.cos(Math.PI * k) / 2; // ease in-out
        const { from, to } = panAnim;
        mapChart.mapView.setView([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e], undefined, false);
        viewMoved = true;
        if (k >= 1) { panAnim = null; requestAnimationFrame(() => { if (!panAnim && snapToPixelGrid()) mapChart.mapView.redraw(false); }); }
        else if (!state.playing) requestAnimationFrame(() => render(false));
      }
      // After a view change every geometry series (tiles, lines) must be
      // re-rendered; mapView.redraw marks them dirty. Otherwise only the
      // updated points are redrawn.
      if (viewMoved) mapChart.mapView.redraw(false);
      else mapChart.redraw(false);
    }

    // Chart markers (throttled ~30 fps)
    if (chart && (force || now - lastChartUpdate > 33)) {
      lastChartUpdate = now;
      positions.forEach((p, idx) => {
        const s = chart.series[idx * 2 + 1];
        if (s && s.points[0]) s.points[0].update({ x: p.d / 1000, y: state.activities[idx].alt ? p.alt : 0 }, false, false);
      });
      chart.redraw(false);
    }

    // Clock + timeline
    el.clock.textContent = fmtTime(T);
    if (!scrubbing) el.timeline.value = String(Math.round(T));

    renderStandings(positions);
  }

  function renderStandings(positions) {
    const T = state.T;
    const rows = state.activities.map((a, idx) => ({ a, idx, p: positions[idx], fin: duration(a) }));
    // Finished racers first (by finish time), then by distance covered.
    rows.sort((x, y) => {
      if (x.p.finished && y.p.finished) return x.fin - y.fin;
      if (x.p.finished !== y.p.finished) return x.p.finished ? -1 : 1;
      return y.p.d - x.p.d;
    });
    const leader = rows[0];
    el.standings.innerHTML = rows.map((r, pos) => {
      let gap = '';
      let sub = '';
      if (r.p.finished) {
        gap = pos === 0 ? '🏁 ' + fmtTime(r.fin) : fmtGap(r.fin - leader.fin);
        sub = pos === 0 ? 'Finished' : '🏁 ' + fmtTime(r.fin);
      } else if (pos === 0) {
        gap = 'Leader';
        sub = fmtKm(r.p.d);
      } else {
        // How long ago the leader passed this racer's current distance.
        const behind = T - timeAtDistance(leader.a, r.p.d);
        gap = fmtGap(behind);
        sub = `${fmtKm(r.p.d)} · −${Math.round(leader.p.d - r.p.d)} m`;
      }
      const v = r.p.finished ? 0 : speedAt(r.a, T);
      return `<li>
        <span class="pos">${pos + 1}</span>
        <span class="dot" style="background:${r.a.color}"></span>
        <span class="who">${esc(r.a.name)}<small>${[r.a.subtitle, r.p.finished ? '' : fmtPace(v)].filter(Boolean).map(esc).join(' · ')}</small></span>
        <span class="gap">${gap}<small>${sub}</small></span>
      </li>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  let lastFrame = 0;
  let scrubbing = false;

  function setPlaying(on) {
    state.playing = on;
    el.playIcon.hidden = on;
    el.pauseIcon.hidden = !on;
    el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) {
      if (state.T >= state.maxT) state.T = 0;
      lastFrame = performance.now();
      requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (!state.playing) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    state.T += dt * state.speed;
    if (state.T >= state.maxT) {
      state.T = state.maxT;
      render(true);
      setPlaying(false);
      return;
    }
    render(false);
    requestAnimationFrame(frame);
  }

  function seek(T) {
    state.T = Math.max(0, Math.min(state.maxT, T));
    render(true);
  }

  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.timeline.addEventListener('input', () => { scrubbing = true; seek(Number(el.timeline.value)); });
  el.timeline.addEventListener('change', () => { scrubbing = false; });
  el.speed.addEventListener('change', () => { state.speed = Number(el.speed.value); });
  el.follow.addEventListener('change', () => { state.follow = el.follow.checked; });
  el.mode.addEventListener('change', () => {
    // Keep the primary racer at the same spot when switching clocks.
    const a = state.activities[0];
    const d = a ? positionAt(a, state.T).d : 0;
    state.mode = el.mode.value;
    const T = a ? timeAtDistance(a, d) : 0;
    refreshAll();
    seek(T);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input[type="text"], select')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seek(state.T + (e.shiftKey ? 300 : 30)); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(state.T - (e.shiftKey ? 300 : 30)); }
    else if (e.code === 'Home') { e.preventDefault(); seek(0); }
  });

  // ---------------------------------------------------------------------------
  // Demo data (race.html?demo) – lets the page run without Strava
  // ---------------------------------------------------------------------------
  function demoStreams(seed, basePace, pauseAt, offset) {
    let r = seed;
    const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
    const N = 1800, center = [59.945, 10.71];
    const latlng = [], altitude = [], distance = [], time = [], moving = [];
    let d = 0, t = 0;
    for (let i = 0; i < N; i++) {
      const th = (i / (N - 1)) * Math.PI * 2;
      const rad = 0.018 + 0.006 * Math.sin(3 * th) + 0.003 * Math.cos(7 * th);
      const lat = center[0] + rad * Math.sin(th) + offset[0];
      const lng = center[1] + rad * 1.9 * Math.cos(th) - rad * 1.9 + offset[1];
      const alt = 120 + 70 * Math.sin(th * 2 + 0.6) + 25 * Math.sin(th * 5);
      if (i) {
        const [pl, pn] = latlng[latlng.length - 1];
        const step = Math.hypot((lat - pl) * 111000, (lng - pn) * 111000 * Math.cos(lat * Math.PI / 180));
        const grade = (alt - altitude[altitude.length - 1]) / Math.max(step, 1);
        const v = basePace * (1 - 4 * grade) * (0.92 + 0.16 * rand());
        d += step;
        t += step / Math.max(v, 0.8);
        if (pauseAt && i === pauseAt) { // a 2-minute stop
          latlng.push([lat, lng]); altitude.push(alt); distance.push(d); time.push(Math.round(t)); moving.push(true);
          t += 120; latlng.push([lat, lng]); altitude.push(alt); distance.push(d); time.push(Math.round(t)); moving.push(false);
          continue;
        }
      }
      latlng.push([lat, lng]); altitude.push(alt); distance.push(d); time.push(Math.round(t)); moving.push(true);
    }
    return { latlng, altitude, distance, time, moving };
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    if (DEMO) {
      el.subtitle.textContent = 'Demo race with generated activities';
      const me = { id: '1', name: 'Torstein Hønsi' };
      const demo = [
        ['1', 'Tuesday tempo', demoStreams(7, 3.9, 0, [0, 0]), me, Date.UTC(2026, 10, 3)],
        ['2', 'Saturday long run', demoStreams(13, 3.6, 900, [0.0002, 0.0001]), me, Date.UTC(2026, 9, 31)],
        ['3', 'Tuesday tempo', demoStreams(29, 3.75, 0, [-0.0002, 0.0002]), { id: '2', name: 'Kari Nordmann' }, Date.UTC(2026, 10, 3)],
        ['4', 'Bergen trip', demoStreams(31, 3.5, 0, [0.45, -5.4]), me, Date.UTC(2025, 5, 14)]
      ];
      // ?demo=solo leaves out the second athlete
      demo.filter((d) => params.get('demo') !== 'solo' || d[3] === me).forEach(([id, name, streams, athlete, date]) => {
        const a = buildActivity(id, name, streams);
        a.athlete = athlete;
        a.date = date;
        state.activities.push(a);
      });
      recolor();
      refreshAll();
      populateRecent();
      populateMatched();
      return;
    }

    if (!primaryId) {
      el.subtitle.textContent = 'Open an activity on Strava and choose “Race” from its menu.';
      el.play.disabled = true;
      setStatus('No primary activity selected.', true);
      return;
    }

    const knownName = params.get('name');
    el.subtitle.textContent = knownName ? `Primary: ${knownName}` : `Primary: activity ${primaryId}`;
    el.play.disabled = true;
    populateRecent();
    populateMatched();
    try {
      const a = await addActivity(primaryId, knownName || undefined);
      el.subtitle.textContent = `Primary: ${a.name} — add one or more activities to race against it`;
      document.title = `${a.name} · Strava Race`;
    } catch (_) { /* status already shown */ }
  }

  boot();
})();
