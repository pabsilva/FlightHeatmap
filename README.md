# Portugal flight noise map

Collects aircraft positions over Portugal, preprocesses them into a ~1 km grid, and shows a
green → red heatmap over Mapbox, highlighting areas with heavy or low-flying air traffic.

No npm dependencies, just Node.js 20 or newer.

## Setup

1. Put a Mapbox public token (`pk.…`) in `.env` as `MAPBOX_TOKEN`. See `.env.example` for all options.
2. Start collecting. Leave this running: days, ideally **2–4 weeks**.
   ```
   npm run collect
   ```
   It polls every 20 s, appends to `data/raw/YYYY-MM-DD.csv` (~20 MB/day), and rebuilds
   `data/heatmap.json` every 30 min.
3. Start the web app in another terminal and open http://localhost:3000.
   ```
   npm start
   ```
4. Optional: rebuild the heatmap at any time with `npm run build`.

### Running next to an older Node

If the machine's system Node is older than 20 and another application depends on it, install
a separate Node in its own folder and point `install.sh` at it. Nothing on the `PATH` changes,
so the other application keeps using the system Node.

```bash
uname -m           # aarch64 -> arm64, armv7l -> armv7l, armv6l -> see below
ldd --version      # Node 20+ needs glibc 2.28 or newer (Raspberry Pi OS Buster or later)

V=v22.20.0 ARCH=arm64    # pick the current v22 release and your architecture
curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-$ARCH.tar.xz | sudo tar -xJ -C /opt
sudo ln -sfn /opt/node-$V-linux-$ARCH /opt/node22

/opt/node22/bin/node -v
NODE_BIN=/opt/node22/bin/node ./install.sh
```

The systemd services store that absolute path, so they always use it. For manual commands, use
the same binary, e.g. `/opt/node22/bin/node src/build.js`.

For an `armv6l` Pi (Pi 1 / Zero / Zero W), use the
[unofficial builds](https://unofficial-builds.nodejs.org/download/release/) instead of nodejs.org.

## Data sources (`SOURCE` in `.env`)

Only positions are used. Callsigns, routes and so on are thrown away.

| SOURCE | Key needed | Notes |
|---|---|---|
| `combined` (default) | no | Flightradar24 web feed + adsb.lol, merged per aircraft. Best coverage, and keeps working if one source is down. |
| `fr24-public` | no | The feed flightradar24.com uses. Unofficial; FR24's terms only allow personal use. |
| `adsblol` | no | [adsb.lol](https://adsb.lol) open data (ODbL). About 80% of what FR24 sees over Portugal (fewer light aircraft). |
| `adsbfi` | no | [adsb.fi](https://adsb.fi) open data, personal/non-commercial, max 1 req/s. |
| `fr24` | `FR24_API_TOKEN` | [Official FR24 API](https://fr24api.flightradar24.com) (paid credits). |
| `opensky` | optional | OpenSky Network. Anonymous use is heavily rate-limited, so set `POLL_INTERVAL` to 60 or more. |

**Backfill:** with the official FR24 API you can fetch past days instead of waiting.
Each call costs credits, so start small:
```
npm run backfill -- --days 1 --step 60
```

## What the map shows

Each ~1 km cell gets these values, averaged per day of collected data:

- **Noise exposure** (default): every track point below 6,000 m spreads sound energy to cells
  within 5 km. It falls off with the squared slant distance, which approximates a sound
  exposure sum. The unit is *equivalent overflights per day straight overhead at 1,000 m*.
  As a rough guide: under 1 is very quiet, 1–10 quiet, 10–50 moderate, 50–200 noisy, over 200 very noisy.
- **Flights below 1,500 m / 3,000 m**: distinct flights crossing the cell at that height.
- **All flights**: distinct flights at any altitude. High cruise traffic is mostly inaudible.

Positions about 20 s apart are joined into straight segments, so the gaps between snapshots get filled in.
Colours use a log scale. A cell with no recorded traffic is transparent.
Click the map or search an address to see the numbers for that spot.

## Caveats

- **Runway direction depends on the wind.** Lisbon (LIS) mostly uses runway 03 or 21,
  which moves the approach path over either the city or the south bank. Collect over several
  weeks, or you might only see one configuration.
- **The model is altitude and distance only.** It ignores aircraft type, terrain height
  (altitudes are above sea level) and night flights. Night flights matter more for sleep.
- **Future changes are not in the data**, for example the planned new Lisbon airport at
  Alcochete or changes at Montijo. Check those plans before drawing conclusions about an area.
- For an official cross-check, see the strategic noise maps (*mapas estratégicos de ruído*)
  that ANA and APA publish for each airport.

## Layout

```
src/collector.js   polls the source, writes data/raw, rebuilds periodically
src/sources.js     data source adapters (normalized positions)
src/build.js       preprocessing: tracks → grid → data/heatmap.json
src/backfill.js    historic backfill (official FR24 API)
src/server.js      static files + /api/heatmap (gzipped) + /config.js (Mapbox token)
public/            Mapbox GL front end (heatmap, grid, address search, click info)
```

To include Madeira and/or the Azores, set `REGIONS=mainland,madeira,azores`.

## Cell size

`CELL_SIZE` in `.env` sets the grid resolution in degrees. The default `0.01` (~1 km) is a
deliberate trade-off, and going finer is not recommended. Measured on the same raw data (mainland):

| | 0.01 (~1 km) | 0.005 (~500 m) |
|---|---|---|
| Cells in the grid | 212k | 844k (×4) |
| `heatmap.json` (gzipped) | 430 KB | 1.45 MB (×3.4) |
| Build peak memory | 76 MB | 144 MB (×1.9) |

After a few weeks of collecting, almost every cell near a flight path has a value, so expect
the full ×4.

- **Front end:** the browser creates a point and a polygon for every cell. At 500 m that is
  over 600k of each, which is slow to load on desktops and can stall or crash phones.
- **Build time:** the noise step grows with the number of track samples (spaced half a cell
  apart, so ×2) times the cells within 5 km of each sample (×4), roughly ×8 overall. On a
  Raspberry Pi with a month of data, one rebuild can approach the 30 min `REBUILD_EVERY_MIN` interval.
- **Little gain for noise:** each sample spreads over a 5 km radius, so the noise field is
  smooth and smaller cells only resample it.
- **Tracks aren't that precise:** positions ~20 s apart (1.5–5 km of flight) are joined with
  straight lines, so paths through turns can be a few hundred metres off.
- **Noisier counts:** the flight-count layers record a flight only in cells its track crosses.
  Smaller cells catch fewer flights each and need more days of data to settle.
- **What you would gain:** under low approaches, the below-1,500 m counts can show which side
  of a neighbourhood a path runs along.

Raw data doesn't depend on the cell size, so a change is reversible: set `CELL_SIZE`, run
`npm run build`, and restart the collector so its periodic rebuilds use the new value.

## License

MIT, see [LICENSE](LICENSE). This covers the code only. Flight data you collect is subject to
the terms of its source (see the data sources table above).
