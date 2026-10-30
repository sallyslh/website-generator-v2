// Measures how big every picture really appears on the built pages, with a headless browser (Edge or Chrome).
// The CSS of a Stitch page cannot be trusted for this: a frame written as aspect-[4/5] may also have max-h-[580px] and
// end up much wider than 4:5. Only the rendered page tells the truth.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export const findBrowser = () => CANDIDATES.find((p) => fs.existsSync(p)) ?? null;

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json' };

function serve(dist) {
  const server = http.createServer((req, res) => {
    let p = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// routes: ["/", "/products/"]. Returns [{ route, images: [{ src, width, height }] }] (visible pictures only, in page order),
// or null when no browser is available or it does not answer.
export async function measureRenderedImages({ distDir, routes, width = 1440, timeoutMs = 20000, totalMs = 60000 }) {
  const exe = findBrowser();
  if (!exe) return null;
  const server = await serve(distDir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const child = spawn(exe, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  // a measurement must never be able to hang a build: after totalMs it gives up and returns null
  const work = async () => {
    let ws = null;
    let opened = null; // the listener is attached the moment the connection is created: it can open before the next line runs
    for (const start = Date.now(); Date.now() - start < timeoutMs && !ws; await sleep(400)) {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
        const tab = tabs.find((t) => t.type === 'page');
        if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); }
      } catch { /* the browser is still starting */ }
    }
    if (!ws) return null;
    await opened;
    let n = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
    const send = (method, params = {}) => Promise.race([
      new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }),
      sleep(12000).then(() => { throw new Error(`the browser did not answer ${method}`); }),
    ]);
    const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const out = [];
    for (const route of routes) {
      await send('Page.navigate', { url: base + route });
      for (let i = 0; i < 40 && (await value('document.readyState')) !== 'complete'; i++) await sleep(500);
      await sleep(800);
      // scroll in steps so lazy pictures load and their real size is known (the steps are driven from here, not from the page)
      const height = Number(await value('document.documentElement.scrollHeight')) || 0;
      for (let y = 0; y < Math.min(height, 12000); y += 600) { await value(`window.scrollTo(0, ${y})`); await sleep(150); }
      await value('window.scrollTo(0, 0)');
      await sleep(800);
      const json = await value("JSON.stringify([...document.images].map((i) => { const r = i.getBoundingClientRect(); return { src: new URL(i.src, location.href).pathname, width: Math.round(r.width), height: Math.round(r.height) }; }).filter((i) => i.width > 40 && i.height > 40))");
      out.push({ route, images: JSON.parse(json) });
    }
    ws.close();
    return out;
  };
  try {
    return await Promise.race([work().catch(() => null), sleep(totalMs).then(() => null)]);
  } finally {
    child.kill();
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the folder for a moment */ }
  }
}

const ratio = (w, h) => w / h;

// Which generated pictures do not fit the frame they are shown in? Pure, so it is unit tested.
//   assets: the manifest's assets, design: the design spec, rendered: the result of measureRenderedImages.
// Returns [{ slotId, assetId, frame: "w:h", rendered: { width, height } }]
export function pictureMisfits({ assets, design, rendered, tolerance = 0.12, aspectOf }) {
  const byFile = new Map(assets.map((a) => [a.id, a]));
  const slots = design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));
  const seen = new Map(); // asset id -> first rendered size
  for (const page of rendered ?? []) for (const img of page.images) {
    const id = img.src.match(/\/images\/([^/]+)\.webp$/)?.[1];
    if (id && !seen.has(id)) seen.set(id, img);
  }
  const misfits = [];
  for (const slot of slots) {
    const asset = byFile.get(slot.assignedAsset);
    if (!asset || !['collage', 'composite', 'generated'].includes(asset.origin) || !seen.has(asset.id)) continue;
    const shown = seen.get(asset.id);
    if (Math.abs(ratio(shown.width, shown.height) / ratio(asset.width, asset.height) - 1) < tolerance) continue;
    const r = ratio(shown.width, shown.height);
    // a common shape (4:5, 4:3, 16:9...) when the frame is ordinary, the exact measured ratio for very wide or very tall frames (text bands)
    const frame = r >= 0.55 && r <= 1.9 ? aspectOf(shown.width, shown.height) : `${r.toFixed(2)}:1`;
    misfits.push({ slotId: slot.id, assetId: asset.id, frame, rendered: { width: shown.width, height: shown.height } });
  }
  return misfits;
}
