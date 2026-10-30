// One menu for the whole site, and a menu that works on a phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { syncMenus, addPhoneMenus } from '../src/wow/menu.js';

const cheerio = createRequire(import.meta.url)('cheerio');
const page = (links, active, dropdown = '') => `<!doctype html><html><head><title>x</title></head><body><header><div><a href="index.html">Brand</a><nav>${links.map((l) => `<a class="${l === active ? 'here' : 'plain'}" href="${l}.html">${l}</a>`).join('')}${dropdown}</nav></div></header><main><p>hello</p></main></body></html>`;
const site = (files) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-')); for (const [f, html] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), html); return dir; };

test('a page with a shorter menu gets the full one, and the "you are here" look moves to its own link', () => {
  const dir = site({
    'index.html': page(['index', 'courts', 'book', 'contact'], 'index'),
    'courts.html': page(['index', 'courts'], 'courts'),
    'book.html': page(['index'], 'index'),
    'contact.html': page(['index', 'contact'], 'contact'),
  });
  const r = syncMenus({ dir });
  assert.equal(r.source, 'index.html');
  const $ = cheerio.load(fs.readFileSync(path.join(dir, 'book.html'), 'utf8'));
  assert.deepEqual($('header nav a').map((_, a) => $(a).attr('href')).get(), ['index.html', 'courts.html', 'book.html', 'contact.html']);
  assert.equal($('header nav a.here').attr('href'), 'book.html');
  assert.equal($('header nav a.here').length, 1);
  assert.equal($('main p').text(), 'hello', 'the page itself is not touched');
});

test('the phone menu is added once, and an older copy is replaced', () => {
  const dir = site({ 'index.html': page(['index', 'courts'], 'index'), 'courts.html': page(['index', 'courts'], 'courts') });
  assert.equal(addPhoneMenus({ dir }).done.length, 2);
  const once = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.equal((once.match(/data-wm-menu/g) || []).length, 2, 'one style and one script');
  fs.writeFileSync(path.join(dir, 'index.html'), once.replace(/data-wm-menu/g, 'data-wm-menu=""')); // another step may rewrite the tag like this
  addPhoneMenus({ dir });
  assert.equal((fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/data-wm-menu/g) || []).length, 2);
  assert.match(once, /wm-burger/); assert.match(once, /data-wm-open/); assert.match(once, /scrolls away/);
});

test('a page without a header menu is left alone', () => {
  const dir = site({ 'index.html': '<html><body><p>no menu</p></body></html>' });
  const r = addPhoneMenus({ dir });
  assert.equal(r.done.length, 0); assert.equal(r.skipped.length, 1);
});

test('the readability safety net is in the page script, and skips text over photos and faint decoration', () => {
  const dir = site({ 'index.html': page(['index'], 'index') });
  addPhoneMenus({ dir });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /data-wm-contrast/);
  assert.match(html, /text over a photo/);
  assert.match(html, /op<0\.6/);
});
