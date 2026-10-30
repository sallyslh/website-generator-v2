// Opens each page at phone, tablet and laptop width exactly as a visitor gets it, measures it and saves a full-page picture.
// The measures are written to <out folder>/measures.json (with the words each width shows, for the same-content check).
//   node tools/measure-site.mjs <site folder> <out folder> [pages, comma separated]
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';
const [siteArg, outArg, pagesArg] = process.argv.slice(2);
const dir = path.resolve(siteArg); const out = path.resolve(outArg); fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { const f = path.join(dir, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
const port = 9600 + Math.floor(Math.random() * 90); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meas-'));
const child = spawn(findBrowser(), ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(400); try { const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); } } catch { /* starting */ } }
let n = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const pages = pagesArg ? pagesArg.split(',') : fs.readdirSync(dir).filter((x) => x.endsWith('.html'));
const rows = [];
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(',') : null; // for example VIEWS=phone,laptop
for (const [view, w, h, mobile] of [['phone', 390, 844, true], ['tablet', 820, 1180, true], ['laptop', 1440, 900, false]].filter((v) => !ONLY || ONLY.includes(v[0]))) {
  for (const page of pages) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: `${origin}/${page}` }); await sleep(3500);
    await val(`(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 450) { scrollTo(0, y); await new Promise(r => setTimeout(r, 140)); } scrollTo(0, 0); })()`); await sleep(1200);
    // pictures in a swipe row that nobody has swiped to are not loaded yet (lazy): make them load now, so a picture whose file is really missing is the only one left broken
    await val(`document.querySelectorAll("img[loading=lazy]").forEach((i) => { i.loading = "eager"; })`); await sleep(2500);
    const m = await val(`(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const small = [...document.querySelectorAll('p,a,li,span,button,h1,h2,h3,h4,td,label')].filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim().length > 2 && parseFloat(getComputedStyle(e).fontSize) < 10).length;
      const tap = [...document.querySelectorAll('a[href],button')].filter((e) => { const r = e.getBoundingClientRect(); return vis(e) && (r.height < 32 || r.width < 32) && e.textContent.trim().length > 0 && !e.closest('footer'); }).length;
      const imgs = [...document.images].filter(vis); const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0).length;
      const sections = [...document.querySelectorAll("body section, main > div")].filter((e) => !e.parentElement.closest("section") && vis(e)).slice(0, 14).map((e) => ({ title: ((e.querySelector("h1,h2,h3") || e).innerText || "").replace(/s+/g, " ").trim().slice(0, 50), h: Math.round(e.getBoundingClientRect().height) }));
      return { sections, words: [...new Set((document.body.innerText.toLowerCase().match(/[a-z؀-ۿ0-9$%]{3,}/g) || []))].slice(0, 4000), served: location.pathname, height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth), smallText: small, smallTargets: tap, images: imgs.length, broken }; })()`);
    const full = Math.min(m.height, 15000);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: full, scale: 1 } });
    const name = `${view}-${page.replace('.html', '')}.jpg`; fs.writeFileSync(path.join(out, name), Buffer.from(shot.result.data, 'base64'));
    rows.push({ view, page, ...m, picture: name });
  }
}
fs.writeFileSync(path.join(out, 'measures.json'), JSON.stringify(rows, null, 1));
for (const r of rows) r.words = r.words ?? [];
fs.writeFileSync(path.join(out, 'measures.json'), JSON.stringify(rows));
console.log('view   page          served            height  sideways  smallText  smallTargets  images(broken)');
for (const r of rows) console.log(`${r.view.padEnd(7)}${r.page.padEnd(14)}${r.served.padEnd(18)}${String(r.height).padEnd(8)}${String(r.overflowX).padEnd(10)}${String(r.smallText).padEnd(11)}${String(r.smallTargets).padEnd(14)}${r.images}(${r.broken})`);
child.kill(); server.close(); process.exit(0);
