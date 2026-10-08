// Preprocessing: turns raw snapshots into a gridded heatmap (data/heatmap.json).
//
// For every aircraft, consecutive positions are joined into straight track segments and sampled
// every ~half a cell. Per grid cell (default 0.01 deg, ~1 km) we compute, per day of coverage:
//   all   - distinct flights passing over the cell (any altitude)
//   b3000 - distinct flights passing over below 3,000 m (~10,000 ft)
//   b1500 - distinct flights passing over below 1,500 m (~5,000 ft)
//   noise - noise exposure, in "equivalent overflights at 1,000 m altitude". Every track sample
//           below 6,000 m spreads sound energy to cells within 5 km, decaying with the squared
//           slant distance (L / (h^2 + d^2)), which approximates a sound exposure level sum.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config, RAW_DIR, HEATMAP_FILE, REGION_BOUNDS } from './config.js';

const M_PER_DEG = 111320;
const FT = 0.3048;
const NOISE_MAX_ALT = 6000; // m; above this the contribution is negligible
const NOISE_RADIUS = 5000; // m
const NEW_FLIGHT_GAP = 1200; // s
const MIN_H = 150; // m; floor for altitude (ground clutter, receivers are not on the runway)
// A straight overflight at 1,000 m integrates to 2*atan(R/1000)/1000 within the radius; normalize to 1.
const NOISE_NORM = 1000 / (2 * Math.atan(NOISE_RADIUS / 1000));

function makeGrids(cs) {
  return config.regions.map((name) => {
    const b = REGION_BOUNDS[name];
    const i0 = Math.floor(b.south / cs);
    const j0 = Math.floor(b.west / cs);
    const ni = Math.floor(b.north / cs) - i0 + 1;
    const nj = Math.floor(b.east / cs) - j0 + 1;
    const n = ni * nj;
    return {
      name, i0, j0, ni, nj,
      all: new Float64Array(n), b3000: new Float64Array(n), b1500: new Float64Array(n), noise: new Float64Array(n),
    };
  });
}

async function firstPollTs(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64);
  fs.readSync(fd, buf, 0, 64, 0);
  fs.closeSync(fd);
  const m = buf.toString().match(/^P,(\d+)/);
  return m ? Number(m[1]) : Infinity;
}

export async function build({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const cs = config.cellSize;
  const grids = makeGrids(cs);
  const cellM = cs * M_PER_DEG;
  const stepLen = cellM / 2;
  const di = Math.ceil(NOISE_RADIUS / cellM);

  const gridAt = (i, j) => {
    for (const g of grids) {
      const a = i - g.i0, b = j - g.j0;
      if (a >= 0 && a < g.ni && b >= 0 && b < g.nj) return [g, a * g.nj + b];
    }
    return null;
  };

  // Count a flight once per cell it passes through.
  const visit = (f, lat, lon, altM) => {
    const i = Math.floor(lat / cs), j = Math.floor(lon / cs);
    const key = i * 100000 + j;
    if (f.cells.has(key)) return;
    f.cells.add(key);
    const hit = gridAt(i, j);
    if (!hit) return;
    const [g, idx] = hit;
    g.all[idx]++;
    if (altM < 3000) g.b3000[idx]++;
    if (altM < 1500) g.b1500[idx]++;
  };

  // Spread the sound exposure of a track sample of length L (m) to nearby cells.
  const expose = (lat, lon, altM, L) => {
    if (altM >= NOISE_MAX_ALT) return;
    const h2 = Math.max(altM, MIN_H) ** 2;
    const ci = Math.floor(lat / cs), cj = Math.floor(lon / cs);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dj = Math.ceil(NOISE_RADIUS / (cellM * cosLat));
    const hit = gridAt(ci, cj);
    for (let a = -di; a <= di; a++) {
      const dy = ((ci + a + 0.5) * cs - lat) * M_PER_DEG;
      for (let b = -dj; b <= dj; b++) {
        const dx = ((cj + b + 0.5) * cs - lon) * M_PER_DEG * cosLat;
        const d2 = dx * dx + dy * dy;
        if (d2 > NOISE_RADIUS * NOISE_RADIUS) continue;
        let g, idx;
        // Fast path: neighbor is in the same grid as the sample.
        if (hit && ci + a - hit[0].i0 >= 0 && ci + a - hit[0].i0 < hit[0].ni && cj + b - hit[0].j0 >= 0 && cj + b - hit[0].j0 < hit[0].nj) {
          g = hit[0];
          idx = (ci + a - g.i0) * g.nj + (cj + b - g.j0);
        } else {
          const h = gridAt(ci + a, cj + b);
          if (!h) continue;
          [g, idx] = h;
        }
        g.noise[idx] += L / (h2 + d2);
      }
    }
  };

  const files = fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.csv')) : [];
  const ordered = [];
  for (const f of files) ordered.push({ f, t: await firstPollTs(path.join(RAW_DIR, f)) });
  ordered.sort((a, b) => a.t - b.t);

  const flights = new Map();
  const seenIds = new Set();
  let coverage = 0, lastPoll = null, firstTs = null, lastTs = null, positions = 0;

  for (const { f } of ordered) {
    log(`Reading ${f}`);
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW_DIR, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.startsWith('P,')) {
        const t = Number(line.slice(2));
        if (lastPoll !== null && t > lastPoll && t - lastPoll <= config.maxGapSec) coverage += t - lastPoll;
        if (lastPoll === null || t > lastPoll) lastPoll = t;
        firstTs ??= t;
        lastTs = Math.max(lastTs ?? t, t);
        // Forget flights not seen for 2 hours.
        if (flights.size > 2000) for (const [id, s] of flights) if (t - s.ts > 7200) flights.delete(id);
        continue;
      }
      const [id, sLat, sLon, sAlt, , sTs] = line.split(',');
      const lat = +sLat, lon = +sLon, altM = +sAlt * FT, ts = +sTs;
      if (!Number.isFinite(lat) || !Number.isFinite(ts)) continue;
      positions++;
      seenIds.add(id);

      let s = flights.get(id);
      if (!s) {
        s = { lat, lon, altM, ts, cells: new Set() };
        flights.set(id, s);
        visit(s, lat, lon, altM);
        continue;
      }
      const dt = ts - s.ts;
      if (dt <= 0) continue; // stale / duplicate position
      // Ids are airframes (ICAO hex): after a long gap it's a new flight, so count its cells again.
      if (dt > NEW_FLIGHT_GAP) s.cells = new Set();
      if (dt <= config.maxGapSec) {
        const cosLat = Math.cos((lat * Math.PI) / 180);
        const dyM = (lat - s.lat) * M_PER_DEG, dxM = (lon - s.lon) * M_PER_DEG * cosLat;
        const D = Math.hypot(dxM, dyM);
        if (D / dt < 350) { // ignore glitches faster than ~1,260 km/h
          const n = Math.max(1, Math.ceil(D / stepLen));
          for (let k = 0; k < n; k++) {
            const fr = (k + 0.5) / n;
            const pLat = s.lat + (lat - s.lat) * fr;
            const pLon = s.lon + (lon - s.lon) * fr;
            const pAlt = s.altM + (altM - s.altM) * fr;
            visit(s, pLat, pLon, pAlt);
            expose(pLat, pLon, pAlt, D / n);
          }
        }
      }
      visit(s, lat, lon, altM);
      Object.assign(s, { lat, lon, altM, ts });
    }
  }

  const days = Math.max(coverage, 3600) / 86400;
  const r3 = (v) => (v === 0 ? 0 : Number(v.toPrecision(3)));
  const cells = [];
  for (const g of grids) {
    for (let a = 0; a < g.ni; a++) {
      for (let b = 0; b < g.nj; b++) {
        const idx = a * g.nj + b;
        const noise = (g.noise[idx] * NOISE_NORM) / days;
        if (g.all[idx] === 0 && noise < 1e-4) continue;
        cells.push([g.i0 + a, g.j0 + b, r3(g.all[idx] / days), r3(g.b3000[idx] / days), r3(g.b1500[idx] / days), r3(noise)]);
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: config.source,
    cellSize: cs,
    coverageHours: coverage / 3600,
    from: firstTs && new Date(firstTs * 1000).toISOString(),
    to: lastTs && new Date(lastTs * 1000).toISOString(),
    flights: seenIds.size,
    positions,
    totalCells: grids.reduce((s, g) => s + g.ni * g.nj, 0),
    regions: config.regions.map((r) => ({ name: r, ...REGION_BOUNDS[r] })),
    columns: ['i', 'j', 'all', 'b3000', 'b1500', 'noise'],
    cells,
  };
  fs.mkdirSync(path.dirname(HEATMAP_FILE), { recursive: true });
  fs.writeFileSync(HEATMAP_FILE + '.tmp', JSON.stringify(result));
  fs.renameSync(HEATMAP_FILE + '.tmp', HEATMAP_FILE);
  log(`Wrote ${cells.length} cells from ${positions} positions / ${seenIds.size} flights, ${(coverage / 3600).toFixed(1)} h coverage.`);
  return { cells: cells.length, coverageHours: coverage / 3600 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
