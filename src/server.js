import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, ROOT, HEATMAP_FILE } from './config.js';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// Cache the gzipped heatmap, reloading when the file changes.
let cache = { mtime: 0, gz: null };
function heatmapGz() {
  const { mtimeMs } = fs.statSync(HEATMAP_FILE);
  if (mtimeMs !== cache.mtime) cache = { mtime: mtimeMs, gz: zlib.gzipSync(fs.readFileSync(HEATMAP_FILE)) };
  return cache.gz;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(`window.APP_CONFIG = ${JSON.stringify({ mapboxToken: config.mapboxToken })};`);
  }

  if (url.pathname === '/api/heatmap') {
    if (!fs.existsSync(HEATMAP_FILE)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No heatmap yet. Run "npm run collect" for a while, then "npm run build".' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
    return res.end(heatmapGz());
  }

  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(config.port, () => {
  console.log(`Flight noise map on http://localhost:${config.port}`);
  if (!config.mapboxToken || config.mapboxToken.startsWith('pk.your')) console.warn('Warning: set MAPBOX_TOKEN in .env');
});
