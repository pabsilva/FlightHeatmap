// Long-running collector: polls the configured source for every region and stores snapshots.
// Also rebuilds data/heatmap.json periodically so the web map keeps improving.
import { config, REGION_BOUNDS } from './config.js';
import { getSource } from './sources.js';
import { appendSnapshot } from './storage.js';
import { build } from './build.js';

const fetchRegion = getSource();
let failures = 0;
let lastBuild = Date.now();
let building = false;

console.log(
  `Collecting from "${config.source}" every ${config.pollInterval}s for: ${config.regions.join(', ')}. Ctrl+C to stop.`
);

async function poll() {
  const started = Date.now();
  try {
    const all = [];
    for (const r of config.regions) all.push(...(await fetchRegion(REGION_BOUNDS[r])));
    const n = appendSnapshot(Math.round(started / 1000), all);
    failures = 0;
    console.log(`${new Date().toISOString()}  ${n} airborne aircraft`);
  } catch (err) {
    failures++;
    console.error(`${new Date().toISOString()}  poll failed (${failures}): ${err.message}`);
  }

  if (!building && Date.now() - lastBuild > config.rebuildEveryMin * 60_000) {
    building = true;
    lastBuild = Date.now();
    build({ quiet: true })
      .then((s) => console.log(`Heatmap rebuilt: ${s.cells} cells, ${s.coverageHours.toFixed(1)} h of data`))
      .catch((e) => console.error('Heatmap rebuild failed:', e.message))
      .finally(() => (building = false));
  }

  // Exponential backoff on errors (max 10 min) so we don't hammer the source.
  const wait = config.pollInterval * 1000 * Math.min(2 ** failures, 30);
  setTimeout(poll, Math.max(1000, wait - (Date.now() - started)));
}

poll();
