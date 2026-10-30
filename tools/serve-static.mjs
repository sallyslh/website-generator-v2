// Opens a folder of static pages in the browser:  node tools/serve-static.mjs <projectId> [--port 3200]
// For the "generate first" drafts: serves projects/<id>/wow-site.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { projectPath } from '../src/lib/project.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--port') + 1]);
const port = Number(args[args.indexOf('--port') + 1]) || 3200;
if (!id) { console.log('Usage: node tools/serve-static.mjs <projectId> [--port 3200]'); process.exit(1); }
const root = projectPath(id, 'wow-site');
if (!fs.existsSync(path.join(root, 'index.html'))) { console.log(`No draft site yet in ${root}. Run: node src/cli.js wow --project ${id}`); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Draft site: http://localhost:${port}/`));
