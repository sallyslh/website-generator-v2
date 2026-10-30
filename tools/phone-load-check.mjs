// Opens a page like a phone on a slow connection (390 px wide, a slow network and a slow processor) and takes pictures while it loads,
// so a messy first paint (unstyled text, icon names shown as words) can be seen. It also measures sideways overflow at the end.
//   node tools/phone-load-check.mjs <url> <out prefix> [width] [slow|fast]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';

const [url, outPrefix, widthArg = '390', speed = 'slow'] = process.argv.slice(2);
if (!url || !outPrefix) { console.log('Usage: node tools/phone-load-check.mjs <url> <out prefix> [width] [slow|fast]'); process.exit(1); }
const width = Number(widthArg) || 390;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = findBrowser();
if (!exe) { console.log('No Edge or Chrome was found.'); process.exit(1); }
const port = 9600 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'load-'));
const child = spawn(exe, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let code = 0;
try {
  let ws = null; let opened = null;
  for (const start = Date.now(); Date.now() - start < 20000 && !ws; await sleep(400)) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json(); const tab = tabs.find((t) => t.type === 'page'); if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); } } catch { /* still starting */ }
  }
  if (!ws) throw new Error('The browser did not start.');
  await opened;
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pending.get(d.id)?.(d); };
  const send = (method, params = {}) => Promise.race([new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), sleep(60000).then(() => { throw new Error(`no answer to ${method}`); })]);
  const value = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  await send('Page.enable'); await send('Network.enable');
  await send('Network.clearBrowserCache'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height: Math.round(width * 2.16), deviceScaleFactor: 2, mobile: width < 900 });
  if (speed === 'slow') { // roughly a modest 4G phone: 1.6 Mbit/s, 150 ms latency, a processor 4 times slower
    await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  const shots = [];
  const take = async (label) => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); const f = `${outPrefix}.${label}.jpg`; fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); shots.push(f); };
  const started = Date.now();
  await send('Page.navigate', { url });
  for (const [label, at] of [['a-1s', 1000], ['b-3s', 3000], ['c-6s', 6000]]) { await sleep(Math.max(0, at - (Date.now() - started))); await take(label); }
  for (let i = 0; i < 60 && (await value('document.readyState')) !== 'complete'; i++) await sleep(500);
  const loadedAfter = ((Date.now() - started) / 1000).toFixed(1);
  await sleep(2500); await take('d-loaded');
  const overflow = await value('Math.max(0, document.documentElement.scrollWidth - ' + width + ')');
  const iconWords = await value("[...document.querySelectorAll('.material-symbols-outlined, [class*=material-symbols]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 70 }).length");
  const small = await value("[...document.querySelectorAll('a[href], button')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && e.offsetParent && (r.height < 32 || r.width < 32) }).length");
  console.log(`page complete after ${loadedAfter}s on a ${speed} connection | sideways overflow: ${overflow}px | icons wider than 70px (shown as words): ${iconWords} | tap targets under 32px: ${small}`);
  console.log(shots.join('\n'));
  ws.close();
} catch (e) { console.log('FAILED: ' + e.message); code = 2; } finally { child.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the folder */ } }
process.exit(code);
