// Raw snapshot storage: one CSV-ish file per UTC day in data/raw.
//   P,<pollTs>                         marks the start of a poll (used to measure coverage time)
//   <id>,<lat>,<lon>,<altFt>,<gsKt>,<ts>  one airborne aircraft seen in that poll
import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from './config.js';

fs.mkdirSync(RAW_DIR, { recursive: true });

export function appendSnapshot(pollTs, positions, suffix = '') {
  const day = new Date(pollTs * 1000).toISOString().slice(0, 10);
  const file = path.join(RAW_DIR, `${day}${suffix}.csv`);
  let out = `P,${pollTs}\n`;
  let n = 0;
  for (const p of positions) {
    if (p.ground || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    out += `${p.id},${p.lat.toFixed(4)},${p.lon.toFixed(4)},${Math.round(p.altFt)},${Math.round(p.gsKt)},${p.ts}\n`;
    n++;
  }
  fs.appendFileSync(file, out);
  return n;
}
