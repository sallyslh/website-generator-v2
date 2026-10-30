// Tests for the device-proof step: every drafted website is made to work on any screen and any connection, and a site is never made worse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { polishSite, withFontFallbacks, findTailwind, GUARD_CSS, GUARD_JS } from '../src/wow/polish.js';
import { summariseDevices } from '../src/wow/deviceCheck.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polish-'));
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script><script id="tailwind-config">tailwind.config = { theme: { extend: { colors: { brand: '#123456' }, fontFamily: { display: ['Barlow Condensed'] } } } }</script><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet"></head><body>${body}</body></html>`;

test('fonts: a design that names a font without a fallback gets a sans-serif one; an existing generic is kept', () => {
  const cfg = withFontFallbacks({ theme: { extend: { fontFamily: { display: ['Barlow Condensed'], body: 'Plus Jakarta Sans', mono: ['Courier New', 'monospace'] } } } });
  assert.deepEqual(cfg.theme.extend.fontFamily.display, ['Barlow Condensed', 'system-ui', 'sans-serif']);
  assert.deepEqual(cfg.theme.extend.fontFamily.body, ['Plus Jakarta Sans', 'system-ui', 'sans-serif']);
  assert.deepEqual(cfg.theme.extend.fontFamily.mono, ['Courier New', 'monospace']);
  assert.doesNotThrow(() => withFontFallbacks({}));
});

test('the rules every site gets: icons wait for their font, TVs scale up, tablets get a wrapping header, fingers get room, nothing scrolls sideways', () => {
  assert.match(GUARD_CSS, /html\.icons-ready/);
  assert.match(GUARD_CSS, /min-width:1920px\)\{html\{font-size:calc\(100vw\/120\)/);
  assert.match(GUARD_CSS, /min-width:768px\) and \(max-width:1099px\)/);
  assert.match(GUARD_CSS, /pointer:coarse/);
  assert.match(GUARD_CSS, /overflow-x:clip/);
  assert.match(GUARD_JS, /fonts\.load/);
});

test('the screen-size report: which pages fit at each size, and what does not', () => {
  const views = { phone: { width: 390 }, tablet: { width: 820 } };
  const ok = { ok: true, overflowPx: 0, cutOff: [] };
  const r = summariseDevices({ pages: [{ route: '/a.html', phone: ok, tablet: ok }, { route: '/b.html', phone: ok, tablet: { ok: true, overflowPx: 0, cutOff: ['a "Book a Court"'] } }, { route: '/c.html', phone: { ok: true, overflowPx: 30, cutOff: [] }, tablet: { ok: false } }] }, views);
  assert.equal(r.phone.fit, 2); assert.equal(r.phone.total, 3);
  assert.match(r.phone.problems[0], /c\.html: 30px too wide/);
  assert.equal(r.tablet.fit, 1);
  assert.match(r.tablet.problems.join(' '), /b\.html.*cut off/);
  assert.match(r.tablet.problems.join(' '), /c\.html.*could not be measured/);
});

test('a page whose styles cannot be compiled is left exactly as it was', async () => {
  const dir = tmp();
  const html = '<!doctype html><html><head></head><body><h1>No style settings here</h1></body></html>';
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  const r = await polishSite({ dir });
  assert.match(r.styles, /not compiled/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), html);
  assert.equal(fs.existsSync(path.join(dir, 'styles.css')), false);
});

test('a site is made device-proof: compiled styles, no download-while-loading script, phone-sized and lazy pictures, and it can be run twice', { skip: findTailwind() ? false : 'no Tailwind compiler on this machine' }, async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'images'));
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#336699' } }).jpeg().toFile(path.join(dir, 'images', 'hero.jpg'));
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#993366' } }).jpeg().toFile(path.join(dir, 'images', 'card.jpg'));
  fs.writeFileSync(path.join(dir, 'index.html'), page('<h1 class="text-brand font-display p-4">Hi</h1><img src="images/hero.jpg" alt=""><img src="images/card.jpg" alt=""><span class="material-symbols-outlined">arrow_forward</span>'));
  fs.writeFileSync(path.join(dir, 'about.html'), page('<p class="text-brand">About</p>'));
  const r = await polishSite({ dir });
  assert.match(r.styles, /KB/);
  assert.equal(r.pages, 2);
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  assert.match(css, /\.text-brand/);
  assert.match(css, /Barlow Condensed,system-ui,sans-serif/);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.equal(html.includes('cdn.tailwindcss.com'), false);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<img fetchpriority="high"[^>]*src="images\/hero\.jpg"/, 'the first picture loads at once');
  assert.match(html, /<img loading="lazy"[^>]*src="images\/card\.jpg"/, 'the others wait');
  assert.match(html, /srcset="images\/card-640\.jpg 640w, images\/card-1024\.jpg 1024w, images\/card\.jpg 2000w"/);
  assert.ok(fs.existsSync(path.join(dir, 'images', 'card-640.jpg')) && fs.existsSync(path.join(dir, 'images', 'card-1024.jpg')));
  assert.equal((await sharp(path.join(dir, 'images', 'card-640.jpg')).metadata()).width, 640);
  // a second run changes nothing (no double rules, no double pictures)
  const again = await polishSite({ dir });
  assert.equal(again.pages, 0);
  assert.equal((fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/data-polish/g) || []).length, 2, 'one style block and one script, once');
});
