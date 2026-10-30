// Opens every page of a site in a real browser at phone, tablet and laptop width and USES the menu like a visitor:
//   phone/tablet: if the menu bar is hidden, taps the three-bar button and checks the list of pages that opens
//   every width:  clicks each top-menu link of the page (in the list or the bar, "More" lists opened first) and checks that the right page loads
//   node tools/click-test.mjs <site folder> [out folder for a picture of the open phone menu]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';

const dir = path.resolve(process.argv[2] ?? '.'); const shots = process.argv[3] ? path.resolve(process.argv[3]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const exe = findBrowser(); const port = 9900 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'click-'));
const child = spawn(exe, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const VIEWS = [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'tablet', width: 820, height: 1180, mobile: true }, { name: 'laptop', width: 1440, height: 900, mobile: false }];
const failures = []; let checks = 0; let code = 0;
try {
  let ws = null; let opened = null;
  for (const start = Date.now(); Date.now() - start < 20000 && !ws; await sleep(400)) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json(); const tab = tabs.find((t) => t.type === 'page'); if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); } } catch { /* still starting */ }
  }
  await opened;
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pending.get(d.id)?.(d); };
  const send = (method, params = {}) => Promise.race([new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), sleep(30000).then(() => { throw new Error(`no answer to ${method}`); })]);
  const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  await send('Page.enable');
  const open = async (view, file) => {
    await send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
    await send('Page.navigate', { url: `${origin}/${file}` });
    for (let i = 0; i < 50 && (await value('document.readyState')) !== 'complete'; i++) await sleep(300);
    await sleep(700);
  };
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  for (const view of VIEWS) {
    for (const file of pages) {
      await open(view, file);
      // the pages the menu of this page promises (read from the page itself)
      const menu = await value(`(() => { const h = document.querySelector('header'); if (!h) return null; const nav = h.querySelector('nav'); const out = []; for (const a of h.querySelectorAll('a[href]')) { const href = a.getAttribute('href'); if (/\\.html$/.test(href) && !out.includes(href)) out.push(href); } return { links: out, navHidden: nav ? getComputedStyle(nav).display === 'none' : true, burger: !!document.querySelector('.wm-burger.wm-on') }; })()`);
      if (!menu) { failures.push(`${view.name} ${file}: no header menu`); continue; }
      // on a screen where the bar is hidden, the three-bar button must exist and list the pages
      let tapped = false;
      if (menu.navHidden) {
        checks++;
        const listed = await value(`(() => { const b = document.querySelector('.wm-burger'); if (!b || getComputedStyle(b).display === 'none') return null; b.click(); return [...document.querySelectorAll('.wm-panel a')].map((a) => a.getAttribute('href')); })()`);
        if (!listed) { failures.push(`${view.name} ${file}: the menu bar is hidden and there is no menu button`); continue; }
        tapped = true;
        const missing = menu.links.filter((l) => l !== 'index.html' && !listed.includes(l));
        if (missing.length) failures.push(`${view.name} ${file}: the phone menu lacks ${missing.join(', ')}`);
        if (shots && file === 'index.html' && view.name === 'phone') { fs.mkdirSync(shots, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, 'phone-menu-open.png'), Buffer.from(s.result.data, 'base64')); }
      }
      // click every link of the menu the way a visitor would and see where it lands
      for (const target of menu.links) {
        checks++;
        await open(view, file);
        const clicked = await value(`(() => { const sel = 'header a[href="${target}"]'; let a = [...document.querySelectorAll(sel)].find((x) => x.offsetParent !== null && x.getBoundingClientRect().width > 0); if (!a) { const b = document.querySelector('.wm-burger'); if (b && getComputedStyle(b).display !== 'none') { b.click(); a = [...document.querySelectorAll('.wm-panel a[href="${target}"]')][0]; } } if (!a) { for (const t of document.querySelectorAll('header nav button, header nav [aria-haspopup]')) { t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); t.click(); } a = [...document.querySelectorAll(sel)].find((x) => x.offsetParent !== null && x.getBoundingClientRect().width > 0); } if (!a) return 'not reachable'; a.click(); return 'ok'; })()`);
        if (clicked !== 'ok') { failures.push(`${view.name} ${file} -> ${target}: ${clicked} (a visitor cannot click it)`); continue; }
        await sleep(900);
        const landed = await value('location.pathname.split("/").pop() || "index.html"');
        if (landed !== target) failures.push(`${view.name} ${file} -> ${target}: landed on ${landed}`);
      }
    }
    console.log(`${view.name}: done`);
  }
  ws.close();
  console.log(`\n${checks} menu checks over ${pages.length} pages at phone, tablet and laptop width`);
  if (failures.length) { console.log(`PROBLEMS (${failures.length}):`); for (const f of failures.slice(0, 60)) console.log('  ' + f); code = 1; } else console.log('Every menu link can be reached and opens the right page, at every width.');
} catch (e) { console.log(`FAILED: ${e.message}`); code = 2; } finally { child.kill(); server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ } }
process.exit(code);
