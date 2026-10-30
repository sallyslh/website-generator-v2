// Wording check: opens every step of every kind of website in a real browser and lists any word from the wrong kind of business
// ("menu" or "dish" for a salon, "product" for a restaurant...). The customer server must be running (npm run customer).
//   node tools/wording-scan.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from '../src/lib/measureFrames.js';
const port = 9700 + Math.floor(Math.random() * 200); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
const child = spawn(findBrowser(), ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, opened;
for (let i = 0; i < 40 && !ws; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const tab = tabs.find((t) => t.type === 'page'); if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); } } catch { await sleep(400); } }
await opened; let n = 0; const pending = new Map(); const errors = []; ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); pending.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const value = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:3001/' });
for (let i = 0; i < 40 && (await value('document.readyState')) !== 'complete'; i++) await sleep(300);
await sleep(1200);
const kinds = [['Menu or food', /\bproducts?\b|\bshop\b|\bservices?\b|price list/i], ['Shop', /\bmenu\b|dish|restaurant|cafe|\bservices?\b/i], ['Services', /\bmenu\b|dish|restaurant|cafe|\bproducts?\b|\bshop\b|\bsell/i], ['Introduce my business', /\bmenu\b|dish|restaurant|cafe|\bproducts?\b|\bshop\b|\bsell/i], ['Introduce and sell', /\bmenu\b|dish|restaurant|cafe/i]];
let found = 0;
for (const [kind, bad] of kinds) {
  await value(`S.kind = null; S.step = 0; S.formKind = null; render()`); await sleep(150);
  await value(`[...document.querySelectorAll('.tile.kind')].find(t => t.textContent.includes(${JSON.stringify(kind)})).click()`); await sleep(200);
  // some content, so the review step and the table have text
  await value(`S.form.businessName = 'Test Business'; S.form.whatItDoes = 'Something'; S.form.phone = '+1 555 0100'; S.form.whatsapp = '+1 555 0100'; S.items = [{ name: 'Alpha', price: '', description: '' }]; S.softOk = true; render()`);
  const count = await value(`document.querySelectorAll('.stepnav button').length`);
  for (let i = 0; i < count; i++) {
    await value(`document.querySelectorAll('.stepnav button')[${i}].click()`); await sleep(120);
    const text = await value(`[...document.querySelectorAll('.card')].filter(c => !c.closest('.card .card')).map(c => c.innerText).join('\\n')`);
    const sentences = String(text).split(/\n+/).filter((l) => bad.test(l.replace(/Kind of website:.*/, '')));
    if (sentences.length) { found += sentences.length; console.log(`\n[${kind}] step ${i + 1}:`); sentences.forEach((l) => console.log('   -', l.slice(0, 170))); }
  }
  // the second option of the products step (add one by one)
  if (kind === 'Menu or food' || kind === 'Shop') {
    await value(`document.querySelectorAll('.stepnav button')[2].click()`); await sleep(120);
    await value(`S.addTab = 'one'; render()`); await sleep(120);
    const text = await value(`document.body.innerText`);
    const sentences = String(text).split(/\n+/).filter((l) => bad.test(l));
    if (sentences.length) { found += sentences.length; console.log(`\n[${kind}] add one by one:`); sentences.forEach((l) => console.log('   -', l.slice(0, 170))); }
  }
}
console.log(`\nwrong-kind wording found: ${found}`);
console.log('errors:', JSON.stringify(errors));
child.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(0);
