// Data source adapters. Each returns an array of normalized positions:
//   { id, lat, lon, altFt, gsKt, ts (unix seconds), ground (bool) }
import { config } from './config.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const bbox = (b) => `${b.north},${b.south},${b.west},${b.east}`;

// --- Flightradar24 public web feed (what flightradar24.com itself uses) ---------------------
async function fr24Public(b) {
  const url =
    `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=${bbox(b)}` +
    '&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=0&air=1&vehicles=0&estimated=0&maxage=14400&gliders=0&stats=0';
  const data = await getJson(url, { Referer: 'https://www.flightradar24.com/', Origin: 'https://www.flightradar24.com' });
  const out = [];
  for (const [id, v] of Object.entries(data)) {
    if (!Array.isArray(v)) continue; // skip full_count, version, stats
    // Key by ICAO hex (airframe) so positions can be merged with other networks.
    out.push({ id: (v[0] || id).toLowerCase(), lat: v[1], lon: v[2], altFt: v[4], gsKt: v[5], ts: v[10], ground: v[14] === 1 });
  }
  return out;
}

// --- Official Flightradar24 API ---------------------------------------------------------------
function fr24Map(rows) {
  return (rows || []).map((f) => ({
    id: (f.hex || f.fr24_id).toLowerCase(),
    lat: f.lat,
    lon: f.lon,
    altFt: f.alt,
    gsKt: f.gspeed,
    ts: Math.round(new Date(f.timestamp).getTime() / 1000),
    ground: f.alt <= 0 && f.gspeed < 50,
  }));
}

function fr24Headers() {
  if (!config.fr24Token) throw new Error('SOURCE=fr24 needs FR24_API_TOKEN in .env');
  return { Authorization: `Bearer ${config.fr24Token}`, 'Accept-Version': 'v1' };
}

async function fr24Official(b) {
  const data = await getJson(
    `https://fr24api.flightradar24.com/api/live/flight-positions/light?bounds=${bbox(b)}`,
    fr24Headers()
  );
  return fr24Map(data.data);
}

export async function fr24Historic(b, timestamp) {
  const data = await getJson(
    `https://fr24api.flightradar24.com/api/historic/flight-positions/light?bounds=${bbox(b)}&timestamp=${timestamp}`,
    fr24Headers()
  );
  return fr24Map(data.data);
}

// --- Community ADS-B networks (readsb v2 API): adsb.lol, adsb.fi ------------------------------
// They take a centre point + radius (nautical miles), so query the circle around the box and clip.
function circleFor(b) {
  const lat = (b.north + b.south) / 2, lon = (b.east + b.west) / 2;
  const dLat = (b.north - b.south) / 2, dLon = ((b.east - b.west) / 2) * Math.cos((b.north * Math.PI) / 180);
  return { lat, lon, nm: Math.min(250, Math.ceil(Math.hypot(dLat, dLon) * 60) + 5) };
}

function readsbMap(data, b) {
  const now = (data.now ?? Date.now()) / 1000;
  return (data.ac || data.aircraft || [])
    .filter((a) => a.lat != null && a.lat >= b.south && a.lat <= b.north && a.lon >= b.west && a.lon <= b.east)
    .map((a) => ({
      id: a.hex.replace(/^~/, '').toLowerCase(),
      lat: a.lat,
      lon: a.lon,
      altFt: typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom ?? 0,
      gsKt: a.gs ?? 0,
      ts: Math.round(now - (a.seen_pos ?? 0)),
      ground: a.alt_baro === 'ground',
    }));
}

async function adsbLol(b) {
  const c = circleFor(b);
  return readsbMap(await getJson(`https://api.adsb.lol/v2/lat/${c.lat}/lon/${c.lon}/dist/${c.nm}`), b);
}

async function adsbFi(b) {
  const c = circleFor(b);
  return readsbMap(await getJson(`https://opendata.adsb.fi/api/v2/lat/${c.lat}/lon/${c.lon}/dist/${c.nm}`), b);
}

// --- Combined: Flightradar24 web feed + adsb.lol, merged per aircraft (newest position wins) ---
async function combined(b) {
  const results = await Promise.allSettled([fr24Public(b), adsbLol(b)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(results.map((r) => r.reason.message).join(' / '));
  for (const r of results) if (r.status === 'rejected') console.warn('  (one source failed: ' + r.reason.message + ')');
  const byId = new Map();
  for (const r of ok) for (const p of r.value) if (!byId.has(p.id) || byId.get(p.id).ts < p.ts) byId.set(p.id, p);
  return [...byId.values()];
}

// --- OpenSky Network --------------------------------------------------------------------------
let openskyToken = null;
async function openskyAuth() {
  if (!config.openskyClientId) return {};
  if (!openskyToken || openskyToken.expires < Date.now() + 30_000) {
    const res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.openskyClientId,
          client_secret: config.openskyClientSecret,
        }),
      }
    );
    if (!res.ok) throw new Error(`OpenSky auth failed: HTTP ${res.status}`);
    const j = await res.json();
    openskyToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  }
  return { Authorization: `Bearer ${openskyToken.value}` };
}

async function opensky(b) {
  const url = `https://opensky-network.org/api/states/all?lamin=${b.south}&lomin=${b.west}&lamax=${b.north}&lomax=${b.east}`;
  const data = await getJson(url, await openskyAuth());
  return (data.states || [])
    .filter((s) => s[5] != null && s[6] != null)
    .map((s) => ({
      id: s[0],
      lat: s[6],
      lon: s[5],
      altFt: (s[7] ?? s[13] ?? 0) * 3.28084,
      gsKt: (s[9] ?? 0) * 1.94384,
      ts: s[3] ?? s[4] ?? data.time,
      ground: s[8] === true,
    }));
}

const SOURCES = { combined, 'fr24-public': fr24Public, adsblol: adsbLol, adsbfi: adsbFi, fr24: fr24Official, opensky };

export function getSource(name = config.source) {
  const fn = SOURCES[name];
  if (!fn) throw new Error(`Unknown SOURCE "${name}". Use one of: ${Object.keys(SOURCES).join(', ')}`);
  return fn;
}
