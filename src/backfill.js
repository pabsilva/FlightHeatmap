// Backfill using the official Flightradar24 API historic positions endpoint.
// Costs API credits per returned flight - start small!
//   npm run backfill -- --days 2 --step 60 --delay 1500
import { config, REGION_BOUNDS } from './config.js';
import { fr24Historic } from './sources.js';
import { appendSnapshot } from './storage.js';

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const days = arg('days', 1);
const step = arg('step', 60);
const delay = arg('delay', 1500); // ms between calls, to respect API rate limits
const end = Math.floor(Date.now() / 1000 / step) * step - 3600; // historic data lags a bit
const start = end - days * 86400;
const total = Math.ceil((end - start) / step);

console.log(`Backfilling ${days} day(s) every ${step}s = ${total * config.regions.length} API calls.`);
let i = 0;
for (let t = start; t < end; t += step) {
  try {
    const all = [];
    for (const r of config.regions) all.push(...(await fr24Historic(REGION_BOUNDS[r], t)));
    const n = appendSnapshot(t, all, '-hist');
    await new Promise((r) => setTimeout(r, delay));
    if (++i % 20 === 0 || i === total) console.log(`${i}/${total}  ${new Date(t * 1000).toISOString()}  ${n} aircraft`);
  } catch (err) {
    console.error(`${new Date(t * 1000).toISOString()}: ${err.message}`);
    if (/HTTP (401|402|403)/.test(err.message)) process.exit(1);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log('Done. Run "npm run build" to regenerate the heatmap.');
