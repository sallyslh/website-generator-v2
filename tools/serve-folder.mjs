// Serves any folder of static pages:  node tools/serve-folder.mjs <folder> [port]   (default port 3230)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]) || 3230;
if (!process.argv[2] || !fs.existsSync(root)) { console.log('Usage: node tools/serve-folder.mjs <folder> [port]'); process.exit(1); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://localhost:${port}/`));
