import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const HEATMAP_FILE = path.join(DATA_DIR, 'heatmap.json');

// Minimal .env loader (no dependencies). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

// Bounding boxes with some margin over the sea, since approach paths start offshore.
export const REGION_BOUNDS = {
  mainland: { north: 42.25, south: 36.85, west: -10.0, east: -6.1 },
  madeira: { north: 33.2, south: 32.55, west: -17.35, east: -16.2 },
  azores: { north: 40.0, south: 36.8, west: -31.4, east: -24.9 },
};

const source = env('SOURCE', 'combined');
const defaultInterval = { combined: 20, 'fr24-public': 20, adsblol: 20, adsbfi: 20, fr24: 30, opensky: 60 }[source] ?? 30;
const pollInterval = Number(env('POLL_INTERVAL', defaultInterval));

export const config = {
  port: Number(env('PORT', 3000)),
  mapboxToken: env('MAPBOX_TOKEN', ''),
  source,
  fr24Token: env('FR24_API_TOKEN', ''),
  openskyClientId: env('OPENSKY_CLIENT_ID', ''),
  openskyClientSecret: env('OPENSKY_CLIENT_SECRET', ''),
  pollInterval,
  regions: env('REGIONS', 'mainland')
    .split(',')
    .map((s) => s.trim())
    .filter((r) => REGION_BOUNDS[r]),
  cellSize: Number(env('CELL_SIZE', 0.01)),
  rebuildEveryMin: Number(env('REBUILD_EVERY_MIN', 30)),
  // Two consecutive positions further apart than this are not joined into a track segment.
  maxGapSec: Math.max(120, pollInterval * 3),
};
