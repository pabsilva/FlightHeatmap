/* global mapboxgl, MapboxGeocoder */
const METRICS = {
  noise: { label: 'Noise exposure', unit: 'equiv. overflights at 1,000 m / day' },
  b1500: { label: 'Flights below 1,500 m', unit: 'flights / day' },
  b3000: { label: 'Flights below 3,000 m', unit: 'flights / day' },
  all: { label: 'All flights', unit: 'flights / day' },
};
const COLS = { all: 2, b3000: 3, b1500: 4, noise: 5 };
const RAMP = ['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027'];
const $ = (id) => document.getElementById(id);

const state = { metric: 'noise', view: 'heatmap', opacity: 0.7, intensity: 0.3, data: null, scales: {}, lookup: new Map() };

if (!window.APP_CONFIG.mapboxToken || window.APP_CONFIG.mapboxToken.startsWith('pk.your')) {
  $('summary').textContent = 'Set MAPBOX_TOKEN in .env and restart the server.';
  throw new Error('Missing Mapbox token');
}
mapboxgl.accessToken = window.APP_CONFIG.mapboxToken;

const map = new mapboxgl.Map({
  container: 'map',
  style: $('style').value,
  center: [-8.2, 39.6],
  zoom: 6.3,
});
map.addControl(new mapboxgl.NavigationControl(), 'top-right');
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');
const geocoder = new MapboxGeocoder({ accessToken: mapboxgl.accessToken, mapboxgl, countries: 'pt', marker: false, placeholder: 'Search an address…' });
map.addControl(geocoder, 'top-right');
const marker = new mapboxgl.Marker({ color: '#1d232b' });

// ---------- data ----------
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Log scale between the 5th and 99.5th percentile of non-zero cells -> t in [0,1].
function buildScale(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return { lo: 0, hi: 1, sorted: nz, t: () => 0 };
  const lo = Math.max(quantile(nz, 0.05), 1e-4);
  const hi = Math.max(quantile(nz, 0.995), lo * 10);
  const lLo = Math.log(lo), lHi = Math.log(hi);
  return { lo, hi, sorted: nz, t: (v) => (v <= 0 ? 0 : Math.min(1, Math.max(0, (Math.log(v) - lLo) / (lHi - lLo)))) };
}

function toGeoJSON(data) {
  const cs = data.cellSize;
  const points = [], polys = [];
  for (const c of data.cells) {
    const [i, j] = c;
    const props = {};
    for (const [m, col] of Object.entries(COLS)) {
      const t = state.scales[m].t(c[col]);
      props['t_' + m] = t;
      // Weight for the heatmap: keep any non-zero cell visible (green) even at the bottom of the scale.
      props['w_' + m] = c[col] > 0 ? 0.04 + 0.96 * t : 0;
    }
    const lat0 = i * cs, lon0 = j * cs;
    points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon0 + cs / 2, lat0 + cs / 2] }, properties: props });
    polys.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[lon0, lat0], [lon0 + cs, lat0], [lon0 + cs, lat0 + cs], [lon0, lat0 + cs], [lon0, lat0]]] },
      properties: props,
    });
  }
  return { points: { type: 'FeatureCollection', features: points }, polys: { type: 'FeatureCollection', features: polys } };
}

async function loadData() {
  const res = await fetch('/api/heatmap');
  const data = await res.json();
  if (!res.ok) {
    $('summary').textContent = data.error;
    return;
  }
  state.data = data;
  for (const [m, col] of Object.entries(COLS)) state.scales[m] = buildScale(data.cells.map((c) => c[col]));
  for (const c of data.cells) state.lookup.set(c[0] + ',' + c[1], c);
  state.geo = toGeoJSON(data);

  const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const days = data.coverageHours / 24;
  $('summary').innerHTML =
    `${data.flights.toLocaleString()} flights, ${days >= 2 ? days.toFixed(1) + ' days' : data.coverageHours.toFixed(1) + ' hours'} of data ` +
    `(${fmtDate(data.from)} – ${fmtDate(data.to)}).` +
    (days < 7 ? ' <b>Collect at least 2–4 weeks</b> so it includes different runway directions (wind).' : '');
  addLayers();
  updateLegend();
}

// ---------- layers ----------
function cellRadiusStops() {
  // Heatmap radius ~2 cells wide at every zoom, so neighbouring cells blend into a smooth surface.
  const cellM = state.data.cellSize * 111320;
  const mpp = (z) => (156543 * Math.cos((39.5 * Math.PI) / 180)) / 2 ** z;
  return ['interpolate', ['exponential', 2], ['zoom'], 6, Math.max(1, (2 * cellM) / mpp(6)), 13, (2 * cellM) / mpp(13)];
}

function addLayers() {
  if (!state.geo || map.getSource('cells-pt')) return;
  map.addSource('cells-pt', { type: 'geojson', data: state.geo.points });
  map.addSource('cells-poly', { type: 'geojson', data: state.geo.polys });

  // Insert below the map labels so place names stay readable.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({ id: 'grid', type: 'fill', source: 'cells-poly', paint: { 'fill-antialias': false } }, firstSymbol);
  map.addLayer({
    id: 'heat',
    type: 'heatmap',
    source: 'cells-pt',
    paint: {
      'heatmap-radius': cellRadiusStops(),
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(26,152,80,0)',
        0.02, 'rgba(26,152,80,0.55)',
        0.25, RAMP[1],
        0.5, RAMP[2],
        0.75, RAMP[3],
        1, RAMP[4],
      ],
    },
  }, firstSymbol);
  applyStyle();
}

function applyStyle() {
  if (!map.getLayer('heat')) return;
  const m = state.metric, op = state.opacity;
  map.setPaintProperty('heat', 'heatmap-weight', ['get', 'w_' + m]);
  map.setPaintProperty('heat', 'heatmap-intensity', state.intensity);
  map.setPaintProperty('grid', 'fill-color', [
    'interpolate', ['linear'], ['get', 't_' + m],
    0, RAMP[0], 0.25, RAMP[1], 0.5, RAMP[2], 0.75, RAMP[3], 1, RAMP[4],
  ]);
  // Cells with no traffic at all stay transparent.
  map.setFilter('grid', ['>', ['get', 'w_' + m], 0]);
  if (state.view === 'heatmap') {
    // The heatmap gets blotchy when zoomed in close, so it hands over to the exact grid.
    map.setPaintProperty('heat', 'heatmap-opacity', ['interpolate', ['linear'], ['zoom'], 12, op, 13.5, 0]);
    map.setPaintProperty('grid', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, op * 0.8]);
  } else {
    map.setPaintProperty('heat', 'heatmap-opacity', 0);
    map.setPaintProperty('grid', 'fill-opacity', op * 0.8);
  }
  $('intensityWrap').style.display = state.view === 'heatmap' ? '' : 'none';
}

const fmt = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v > 0 ? '<0.1' : '0');

function updateLegend() {
  const s = state.scales[state.metric];
  if (!s) return;
  $('legendLo').textContent = '≤ ' + fmt(s.lo);
  $('legendHi').textContent = '≥ ' + fmt(s.hi);
  $('legendNote').textContent =
    `${METRICS[state.metric].unit}, log scale. Transparent = no traffic recorded.` +
    (state.metric === 'noise' ? ' 1 = one plane per day passing straight overhead at 1,000 m.' : '');
}

// ---------- click info ----------
function percentile(metric, v) {
  // Share of all cells in the covered area (including ones with no traffic) that are quieter.
  const s = state.scales[metric].sorted;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < v) lo = mid + 1; else hi = mid; }
  return ((state.data.totalCells - s.length + lo) / state.data.totalCells) * 100;
}

function rating(noise) {
  if (noise < 1) return ['Very quiet', RAMP[0]];
  if (noise < 10) return ['Quiet', RAMP[1]];
  if (noise < 50) return ['Moderate', '#d9a600'];
  if (noise < 200) return ['Noisy', RAMP[3]];
  return ['Very noisy', RAMP[4]];
}

function showInfo(lngLat) {
  if (!state.data) return;
  marker.setLngLat(lngLat).addTo(map);
  const cs = state.data.cellSize;
  const c = state.lookup.get(Math.floor(lngLat.lat / cs) + ',' + Math.floor(lngLat.lng / cs)) || [0, 0, 0, 0, 0, 0];
  const [label, color] = rating(c[COLS.noise]);
  const rows = Object.entries(METRICS)
    .map(([m, d]) => `<tr><td>${d.label}</td><td>${fmt(c[COLS[m]])}</td></tr>`)
    .join('');
  $('info').classList.remove('muted');
  $('info').innerHTML =
    `<span class="badge" style="background:${color}">${label}</span>` +
    ` <span class="muted small">noisier than ${percentile('noise', c[COLS.noise]).toFixed(0)}% of the area</span>` +
    `<table>${rows}</table>` +
    `<p class="muted small">Per day, for the ~1 km cell at ${lngLat.lat.toFixed(4)}, ${lngLat.lng.toFixed(4)}. ` +
    `Noise exposure is an estimate from altitude and distance only (it ignores aircraft type, terrain height and weather).</p>`;
}

// ---------- events ----------
map.on('style.load', addLayers);
map.on('click', (e) => showInfo(e.lngLat));
geocoder.on('result', (e) => {
  const [lng, lat] = e.result.center;
  map.flyTo({ center: [lng, lat], zoom: 13 });
  showInfo({ lng, lat });
});

$('metric').onchange = (e) => { state.metric = e.target.value; applyStyle(); updateLegend(); };
$('view').onchange = (e) => { state.view = e.target.value; applyStyle(); };
$('opacity').oninput = (e) => { state.opacity = +e.target.value; applyStyle(); };
$('intensity').oninput = (e) => { state.intensity = +e.target.value; applyStyle(); };
$('style').onchange = (e) => map.setStyle(e.target.value);

map.once('load', loadData);
