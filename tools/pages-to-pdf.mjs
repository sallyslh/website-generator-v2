// Turns the pages of a draft website into ONE PDF (every website page is one long PDF page), exactly as the browser shows it.
//   node tools/pages-to-pdf.mjs <site folder> <out.pdf> [laptop|tablet|phone]
// A real browser opens each page at the chosen width, scrolls through it (so the reveal animations finish), takes a full-height
// picture, and the pictures are written into a PDF (no extra library). The page needs internet (its styles load from a CDN).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';

const [dirArg, outArg, viewArg = 'laptop'] = process.argv.slice(2);
if (!dirArg || !outArg) { console.log('Usage: node tools/pages-to-pdf.mjs <site folder> <out.pdf> [laptop|tablet|phone]'); process.exit(1); }
const dir = path.resolve(dirArg);
const VIEW = { laptop: { width: 1440, height: 900, mobile: false, maxScale: 1 }, phone: { width: 390, height: 844, mobile: true, maxScale: 2 }, tablet: { width: 820, height: 1180, mobile: true, maxScale: 1.5 } }[viewArg];
if (!VIEW) { console.log('The view is laptop, tablet or phone.'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PIXELS = 16000; // the longest picture the browser will make in one piece

// Pages in a sensible order: the entry page first, the others as the site's own list gives them (else alphabetical)
function pageOrder() {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  let order = [];
  try { const w = JSON.parse(fs.readFileSync(path.join(dir, '..', 'wow.json'), 'utf8')); order = w.pages.map((s, i) => (i === 0 ? 'index.html' : `${s}.html`)); } catch { /* alphabetical */ }
  const sorted = [...order.filter((f) => all.includes(f)), ...all.filter((f) => !order.includes(f)).sort()];
  const only = process.env.PAGES ? process.env.PAGES.split(',').map((x) => x.trim()) : null;
  return only ? sorted.filter((f) => only.includes(f)) : sorted;
}

// --- the PDF (JPEG pictures, one per page; the page is the size of the picture) ---
function buildPdf(images) {
  const parts = []; const offsets = []; let pos = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); pos += buf.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  const pageIds = images.map((_, i) => 3 + 3 * i);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(' ')}] /Count ${images.length} >>`);
  images.forEach((im, i) => {
    const [page, content, image] = [3 + 3 * i, 4 + 3 * i, 5 + 3 * i];
    const w = +(im.cssWidth * 0.75).toFixed(2); const h = +(im.cssHeight * 0.75).toFixed(2); // CSS pixels to PDF points
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(image, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.pxWidth} /Height ${im.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`, 'latin1'), im.jpeg, Buffer.from('\nendstream', 'latin1')]));
  });
  const size = 3 + 3 * images.length;
  const xref = pos;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const exe = findBrowser();
if (!exe) { console.log('No Edge or Chrome was found.'); process.exit(1); }
const port = 9600 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
const child = spawn(exe, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let exitCode = 0;
try {
  let ws = null; let opened = null;
  for (const start = Date.now(); Date.now() - start < 20000 && !ws; await sleep(400)) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json(); const tab = tabs.find((t) => t.type === 'page'); if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); } } catch { /* still starting */ }
  }
  if (!ws) throw new Error('The browser did not start.');
  await opened;
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pending.get(d.id)?.(d); };
  const send = (method, params = {}) => Promise.race([new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), sleep(60000).then(() => { throw new Error(`the browser did not answer ${method}`); })]);
  const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  await send('Page.enable');
  const images = [];
  for (const file of pageOrder()) {
    await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: VIEW.mobile });
    await send('Page.navigate', { url: `${origin}/${file}` });
    for (let i = 0; i < 60 && (await value('document.readyState')) !== 'complete'; i++) await sleep(400);
    await sleep(1500);
    await value("document.documentElement.style.scrollBehavior = 'auto'; document.body.style.scrollBehavior = 'auto'");
    const height = Number(await value('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)')) || VIEW.height;
    for (let y = 0; y < Math.min(height, 20000); y += VIEW.height * 0.6) { await value(`window.scrollTo(0, ${Math.round(y)})`); await sleep(160); } // lets lazy pictures and reveal animations finish
    await sleep(1500);
    await value('window.scrollTo(0, 0)'); for (let i = 0; i < 20 && Number(await value('window.scrollY')) > 0; i++) await sleep(150); await sleep(400);
    await value(`(() => { for (const el of document.querySelectorAll('body *')) { const st = getComputedStyle(el); if (st.position !== 'fixed') continue; const r = el.getBoundingClientRect(); if (r.top < 200 && r.width > innerWidth * 0.5) { el.style.position = 'absolute'; el.style.top = '0px'; el.style.transform = 'none'; el.style.opacity = '1'; } else el.style.display = 'none'; } window.scrollTo(0, 0); })()`); await sleep(300);
    const h = Math.min(Math.max(...[height, Number(await value('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)')) || 0]), 16000);
    const scale = Math.max(1, Math.min(VIEW.maxScale, MAX_PIXELS / h));
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: true, clip: { x: 0, y: 0, width: VIEW.width, height: h, scale } });
    if (!shot.result?.data) throw new Error(`no picture of ${file}`);
    images.push({ jpeg: Buffer.from(shot.result.data, 'base64'), pxWidth: Math.round(VIEW.width * scale), pxHeight: Math.round(h * scale), cssWidth: VIEW.width, cssHeight: h });
    if (process.env.SAVE_PAGES) fs.writeFileSync(path.resolve(outArg).replace(/\.pdf$/i, '') + `.${file.replace(/\.html$/, '')}.jpg`, images[images.length - 1].jpeg);
    console.log(`  ${file}: ${h}px tall`);
  }
  ws.close();
  fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
  fs.writeFileSync(path.resolve(outArg).replace(/.pdf$/i, '') + '.page1.jpg', images[0].jpeg); // the first page as a picture, for a quick look
  const pdf = buildPdf(images);
  fs.writeFileSync(outArg, pdf);
  console.log(`${path.resolve(outArg)}  (${images.length} pages, ${(pdf.length / 1048576).toFixed(1)} MB, ${viewArg} view)`);
} catch (e) { console.log(`FAILED: ${e.message}`); exitCode = 2; } finally {
  child.kill(); server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the folder */ }
}
process.exit(exitCode);
