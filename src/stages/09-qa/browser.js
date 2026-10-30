// Opens every built page in a headless browser, once at phone width and once at laptop width, and measures what only a real
// rendering can tell: does anything stick out sideways, do files and scripts load, is the text readable against its background.
// Returns { pages: [{ route, mobile: {...}, desktop: {...} }] } or null when no browser is available or it does not answer.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from '../../lib/measureFrames.js';

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json' };
const VIEWS = { mobile: { width: 390, height: 844, mobile: true }, desktop: { width: 1440, height: 900, mobile: false } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(dist) {
  const server = http.createServer((req, res) => {
    // The order service is not part of the files: a stand-in answers its calendar (so the booking widget can be opened) and its orders.
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const day = new URL(req.url, 'http://x').searchParams.get('day');
      const days = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() + i * 86400000).toISOString().slice(0, 10), open: true, free: 3, total: 3 }));
      if (req.url.startsWith('/api/chat')) return res.end(JSON.stringify({ category: 'answer', reply: 'Hello! How can I help?' }));
      return res.end(JSON.stringify(req.url.startsWith('/api/availability') ? (day ? { day, open: true, slots: ['09:00', '10:00', '11:00'].map((time) => ({ time, free: true })) } : { slotMinutes: 60, days }) : { ok: true, ref: 1 }));
    }
    let p = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Runs INSIDE the page (it is sent to the browser as text). Plain browser JavaScript only.
function measurePage(expected) {
  const W = expected || innerWidth; // the screen width we asked for (a browser may widen its own, which hid overflow before)
  const label = (e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/)[0].slice(0, 30)}` : '');
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none'; };
  const opacityOf = (e) => { let o = 1; for (let c = e; c && c.nodeType === 1; c = c.parentElement) o *= Number(getComputedStyle(c).opacity); return o; };
  const parse = (v) => {
    const n = (v.match(/-?[\d.]+/g) || []).map(Number);
    if (/^color\(/.test(v)) return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n.length > 3 ? n[3] : 1 };
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  // the element that paints the colour behind a text (the button itself, or the band it sits on): the repair may darken it
  const bgSourceOf = (el) => {
    for (let c = el; c && c.nodeType === 1; c = c.parentElement) {
      const st = getComputedStyle(c);
      if (st.backgroundImage !== 'none') return null;
      if (parse(st.backgroundColor).a >= 0.5) return c;
    }
    return null;
  };
  // the colour behind a text, or null when it cannot be known (a picture or a gradient is behind it)
  const backgroundOf = (el) => {
    const layers = [];
    let depth = 0;
    for (let c = el; c && c.nodeType === 1; c = c.parentElement, depth++) {
      const s = getComputedStyle(c);
      if (s.backgroundImage !== 'none') return null;
      if (depth < 6 && [...c.children].some((k) => (k.tagName === 'IMG' || k.tagName === 'PICTURE' || k.tagName === 'VIDEO') && getComputedStyle(k).position === 'absolute')) return null;
      const bg = parse(s.backgroundColor);
      if (bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };

  const overflowPx = Math.max(0, document.documentElement.scrollWidth - W);
  const overflowing = overflowPx > 1 ? [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > W + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 5).map(label) : [];

  // text that is cut off at the screen edge (the page itself never scrolls sideways: the site clips the sides). Decorative things are ignored.
  const cutOff = [...document.querySelectorAll('body *')].filter((e) => {
    if (e.children.length > 0 || !e.textContent.trim()) return false;
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (r.width === 0 || r.right <= W + 2 || s.position === 'fixed' || s.visibility === 'hidden' || s.display === 'none') return false;
    for (let c = e; c && c.nodeType === 1; c = c.parentElement) {
      const cs = getComputedStyle(c);
      if (c.getAttribute('aria-hidden') === 'true' || cs.pointerEvents === 'none' || /auto|scroll/.test(cs.overflowX)) return false;
    }
    return true;
  }).slice(0, 6).map((e) => label(e) + ' "' + e.textContent.trim().slice(0, 24) + '"');

  const seen = new Map();
  const all = []; // every offending element, for the automatic repair (the report keeps one per colour pair)
  let tinyText = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (!['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(el.tagName.toUpperCase()) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1) && visible(el) && !el.closest('[aria-hidden="true"]') && !el.closest('svg')) {
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      if (size < 12) tinyText++;
      if (opacityOf(el) < 0.99 || /material-symbols|icon/.test(String(el.className))) continue;
      if (!/\p{L}/u.test(el.textContent)) continue; // numerals and bullets without a word ("01", "• • •") are decoration, not text to read
      const bg = backgroundOf(el);
      if (!bg) continue;
      const fg = parse(s.color);
      if (size >= 64 && fg.a < 0.6) continue; // an oversized, deliberately faint word is a drawing, not text to read
      const ink = over(fg, bg);
      const [hi, lo] = [lum(ink), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        const key = `${s.color}|${s.backgroundColor}|${large}`;
        const source = bgSourceOf(el);
        if (all.length < 80) all.push({ bgKey: source?.getAttribute('data-e') ?? null, bgTag: source ? source.tagName.toLowerCase() : null, bgCls: source ? String(source.className).slice(0, 300) : '', key: el.closest('[data-e]')?.getAttribute('data-e') ?? null, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 300), text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40), ratio: Math.round(ratio * 100) / 100, large, fg: s.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
        if (!seen.has(key)) seen.set(key, { text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 30), ratio: Math.round(ratio * 100) / 100, fg: s.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
      }
    }
  }
  const smallTargets = [...document.querySelectorAll('a[href], button, input[type="submit"]')].filter((e) => {
    if (!visible(e) || e.closest('[aria-hidden="true"]')) return false;
    const r = e.getBoundingClientRect();
    const inline = getComputedStyle(e).display === 'inline' && e.parentElement && /^(P|LI|SPAN|SMALL|EM|STRONG|DIV)$/.test(e.parentElement.tagName) && e.parentElement.textContent.trim().length > e.textContent.trim().length + 12;
    return !inline && (r.height < 32 || r.width < 32);
  }).length;
  return JSON.stringify({ overflowPx: Math.round(overflowPx), overflowing, cutOff, contrast: [...seen.values()].sort((a, b) => a.ratio - b.ratio).slice(0, 12), contrastAll: all, smallTargets, tinyText });
}

// views: the screen sizes to measure (the QA stage keeps the two default ones; a tool may pass more, for example a tablet)
export async function inspectInBrowser({ distDir, routes, timeoutMs = 20000, totalMs = 120000, views = VIEWS }) {
  const exe = findBrowser();
  if (!exe) return null;
  const server = await serve(distDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const port = 9900 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  const child = spawn(exe, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const work = async () => {
    let ws = null; let opened = null;
    for (const start = Date.now(); Date.now() - start < timeoutMs && !ws; await sleep(400)) {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
        const tab = tabs.find((t) => t.type === 'page');
        if (tab) { ws = new WebSocket(tab.webSocketDebuggerUrl); opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); }
      } catch { /* still starting */ }
    }
    if (!ws) return null;
    await opened;
    let n = 0;
    const pending = new Map();
    let errors = [];
    const urls = new Map();
    const local = (u) => u.startsWith(origin);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id) return pending.get(d.id)?.(d);
      const p = d.params ?? {};
      if (d.method === 'Runtime.exceptionThrown') errors.push(`script error: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0].slice(0, 120)}`);
      if (d.method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url);
      if (d.method === 'Network.responseReceived' && p.response.status >= 400 && local(p.response.url)) errors.push(`${p.response.status} ${new URL(p.response.url).pathname}`);
      if (d.method === 'Network.loadingFailed' && urls.has(p.requestId) && local(urls.get(p.requestId)) && !p.canceled) errors.push(`failed to load ${new URL(urls.get(p.requestId)).pathname}`);
    };
    const send = (method, params = {}) => Promise.race([
      new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }),
      sleep(15000).then(() => { throw new Error(`the browser did not answer ${method}`); }),
    ]);
    const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable');
    await send('Network.enable');
    const out = [];
    for (const route of routes) {
      const entry = { route };
      for (const [view, v] of Object.entries(views)) {
        errors = [];
        try {
          await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
          await send('Page.navigate', { url: origin + route });
          for (let i = 0; i < 40 && (await value('document.readyState')) !== 'complete'; i++) await sleep(400);
          await sleep(1000);
          const height = Number(await value('document.documentElement.scrollHeight')) || 0;
          for (let y = 0; y < Math.min(height, 15000); y += v.height * 0.6) { await value(`window.scrollTo(0, ${Math.round(y)})`); await sleep(120); }
          await sleep(1300); // the last reveal animation finishes
          await value('window.scrollTo(0, 0)');
          entry[view] = { ok: true, ...JSON.parse(await value(`(${measurePage.toString()})(${v.width})`)), errors: [...new Set(errors)] };
        } catch (e) { entry[view] = { ok: false, error: e.message }; }
      }
      out.push(entry);
    }
    ws.close();
    return { pages: out };
  };
  try {
    return await Promise.race([work().catch(() => null), sleep(totalMs).then(() => null)]);
  } finally {
    child.kill();
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the folder */ }
  }
}
