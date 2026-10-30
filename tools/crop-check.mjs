// Takes a picture of every photo that shows a named person (alt text or the words next to it) exactly as it appears on a phone, tablet and laptop,
// so a head that is cut off can be seen.   node tools/crop-check.mjs <site folder> <name> <out folder>
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';
const [siteArg, nameArg, outArg] = process.argv.slice(2);
const dir = path.resolve(siteArg); const out = path.resolve(outArg); fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer((req, res) => { const f = path.join(dir, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.png') ? 'image/png' : 'image/jpeg' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
const port = 9700 + Math.floor(Math.random() * 90); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-'));
const child = spawn(findBrowser(), ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(400); try { const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); } } catch { /* starting */ } }
let n = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const val = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const name = nameArg.toLowerCase(); const list = [];
for (const [view, w, h, mobile] of [['phone', 390, 844, true], ['tablet', 820, 1180, true], ['laptop', 1440, 900, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    await send('Page.navigate', { url: `${origin}/${f}` }); await sleep(2200);
    await val(`(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } scrollTo(0, 0); })()`); await sleep(800);
    const count = await val(`(() => { window.__m = [...document.querySelectorAll('img')].filter(i => { const box = i.closest('article, li, figure, [class*=card], div'); const t = ((i.alt || '') + ' ' + (box ? box.innerText.slice(0, 300) : '')).toLowerCase(); return t.includes(${JSON.stringify(name)}) && i.getBoundingClientRect().width > 60; }); return window.__m.length; })()`);
    for (let k = 0; k < count; k++) {
      await val(`window.__m[${k}].scrollIntoView({ block: 'center' })`); await sleep(500);
      const r = await val(`(() => { const i = window.__m[${k}]; const b = i.getBoundingClientRect(); const s = getComputedStyle(i); return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height, nw: i.naturalWidth, nh: i.naturalHeight, fit: s.objectFit, pos: s.objectPosition }; })()`);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.w, w), height: Math.min(r.h, h), scale: 1 } });
      const file = `${view}-${f.replace('.html', '')}-${k}.png`; fs.writeFileSync(path.join(out, file), Buffer.from(shot.result.data, 'base64'));
      list.push(`${file}: shown ${Math.round(r.w)}x${Math.round(r.h)} from a ${r.nw}x${r.nh} photo, ${r.fit} ${r.pos}`);
    }
  }
}
console.log(list.join('\n')); child.kill(); server.close(); process.exit(0);
