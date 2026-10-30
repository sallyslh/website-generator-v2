// The responsive redesign: one model call per page answers only with new class lists; the code applies them, so words, pictures and links cannot change,
// and a change that would alter the laptop look is dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { numbered, laptopKept, responsivePage, responsiveSite, MARK } from '../src/wow/responsive.js';
import { weightCss } from '../src/wow/polish.js';

const page = (inner) => `<html><head><script class="not-an-element">var a="<b class='x'>"</script></head><body class="bg-black">${inner}</body></html>`;
const BEFORE = page('<section class="p-12 grid grid-cols-3"><h1 class="text-display-xl">Hello</h1><img class="h-96" src="images/a.jpg" alt="a"><a class="[&>b]:flex px-4" href="book.html">Book <b>now</b></a></section>');

test('every element with a class gets a number, in order; scripts and styles are not touched', () => {
  const n = numbered(BEFORE.match(/<body[\s\S]*<\/body>/)[0]);
  assert.match(n, /<body data-r="1" class="bg-black">/);
  assert.match(n, /<section data-r="2" class="p-12/);
  assert.match(n, /<a data-r="5" class="\[&>b\]:flex px-4"/, 'a ">" inside a class does not confuse the numbering');
  assert.equal(n.includes('data-r="6"'), false);
});

test('the laptop must stay: a removed plain class has to come back behind a breakpoint, and breakpoint classes cannot be removed', () => {
  assert.equal(laptopKept('p-12 grid grid-cols-3', 'p-5 lg:p-12 grid grid-cols-2 lg:grid-cols-3'), true);
  assert.equal(laptopKept('p-12 grid', 'p-5 grid'), false, 'p-12 is lost on the laptop');
  assert.equal(laptopKept('p-4 lg:p-8', 'p-4'), false, 'a breakpoint class is removed');
  assert.equal(laptopKept('text-xl', 'text-xl text-center'), true);
  assert.equal(laptopKept('grid grid-cols-1 md:grid-cols-3 gap-6', 'flex overflow-x-auto snap-x gap-4 md:grid md:grid-cols-3 md:gap-6 md:overflow-visible'), true, 'grid-cols-1 only ruled the phone (md:grid-cols-3 is kept); grid and gap come back behind md:');
  assert.equal(laptopKept('grid grid-cols-3', 'flex overflow-x-auto grid-cols-3'), false, 'grid is lost on the laptop');
});

test('the model\'s changes are applied to the class lists only; text, pictures and links stay exactly as they were', async () => {
  const ask = async () => ({ changes: [{ id: 2, class: 'p-5 lg:p-12 grid grid-cols-2 lg:grid-cols-3' }, { id: 4, class: 'aspect-video lg:h-96' }] });
  const r = await responsivePage({ html: BEFORE, ask });
  assert.equal(r.status, 'redesigned'); assert.equal(r.changed, 2);
  assert.ok(r.html.includes(MARK));
  assert.match(r.html, /<section class="p-5 lg:p-12 grid grid-cols-2 lg:grid-cols-3">/);
  assert.match(r.html, /<img class="aspect-video lg:h-96" src="images\/a.jpg" alt="a">/);
  assert.match(r.html, /<h1 class="text-display-xl">Hello<\/h1>/, 'an element that was not listed is unchanged');
  assert.match(r.html, /Book <b>now<\/b>/);
  assert.match(r.html, /var a="<b class='x'>"/, 'the script is untouched');
});

test('a change that would lose the laptop look, an unknown element, or a broken class list is dropped, the rest is kept', async () => {
  const ask = async () => ({ changes: [{ id: 2, class: 'p-5 grid grid-cols-3' }, { id: 99, class: 'x' }, { id: 3, class: 'bad"quote' }, { id: 4, class: 'h-48 lg:h-96' }] });
  const r = await responsivePage({ html: BEFORE, ask });
  assert.equal(r.changed, 1); assert.equal(r.dropped, 3);
  assert.match(r.html, /<section class="p-12 grid grid-cols-3">/);
  assert.match(r.html, /<img class="h-48 lg:h-96"/);
});

test('a failing or useless model answer never breaks the page', async () => {
  assert.equal((await responsivePage({ html: BEFORE, ask: async () => { throw new Error('network down'); } })).status, 'kept');
  const none = await responsivePage({ html: BEFORE, ask: async () => ({ changes: [] }) });
  assert.equal(none.status, 'kept'); assert.equal(none.html, BEFORE);
});

test('the site: every page is handled, and a second run does not redo pages that are already redesigned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-'));
  fs.writeFileSync(path.join(dir, 'index.html'), BEFORE); fs.writeFileSync(path.join(dir, 'book.html'), BEFORE);
  let calls = 0;
  const ask = async () => { calls++; return { changes: [{ id: 2, class: 'p-5 lg:p-12 grid grid-cols-3' }] }; };
  const r = await responsiveSite({ dir, ask });
  assert.equal(r.redesigned, 2); assert.equal(calls, 2); assert.equal(r.changed, 2);
  await responsiveSite({ dir, ask });
  assert.equal(calls, 2);
});

test('on a phone the heading weight of the design\'s own size is given back', () => {
  const cfg = { theme: { extend: { fontSize: { 'display-xl': ['84px', { fontWeight: '800', letterSpacing: '0.04em' }] } } } };
  const css = weightCss(cfg, ['<h1 class="text-4xl md:text-display-xl">x</h1>']);
  assert.match(css, /@media \(max-width:767px\)/);
  assert.match(css, /md\\:text-display-xl\{font-weight:800;letter-spacing:0\.04em\}/);
  assert.match(weightCss(cfg, ['<h1 class="text-4xl lg:text-display-xl">x</h1>']), /@media \(max-width:1023px\)\{\.lg\\:text-display-xl/, 'a size that starts at a laptop also gives the weight to tablets');
});
