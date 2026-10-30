// Step 4: the lists of cards of an approved site become data, and the page can be rebuilt from it exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { renderPageEditable, pageSlotsByRole, setPageText, setPagePhoto, buildSite, findCandidates, structurePage, renderPage, renderList, blankItem, addItem, duplicateItem, removeItem, moveItem, setText, slotsByRole } from '../src/wow/structure.js';

const cheerio = createRequire(import.meta.url)('cheerio');

const card = (name, price, extra = '') => `<article class="rounded p-4${extra}"><img src="images/${name}.jpg" alt="${name} photo" srcset="images/${name}-640.jpg 640w, images/${name}.jpg 1376w"><h3 class="text-xl">${name} &amp; co</h3><p>Fresh and good, made every day with care for you &lt;always&gt; and for our guests.</p><span>${price}</span><a href="#" data-inert>Order</a></article>`;
const PAGE = `<!DOCTYPE html><html><head><title>x</title></head><body><header><nav><a href="a.html">A</a><a href="b.html">B</a><a href="c.html">C</a></nav></header><main>
<h2>Our menu</h2>
<section class="grid">
<!-- Item 1 -->
${card('Haircut', '$25')}
<!-- Item 2 (featured) -->
${card('Coloring', '$60', ' ring-2')}
${card('Styling', '$40')}
</section>
<ul><li><a href="x.html">one</a></li><li><a href="y.html">two</a></li><li><a href="z.html">three</a></li></ul>
</main><footer><a href="p.html">Privacy</a><a href="q.html">Terms</a><a href="r.html">Cookies</a></footer></body></html>`;
const ask = async () => ({ lists: [{ id: 1, keep: true, name: 'Services' }, { id: 2, keep: true, name: 'Not a list' }] });

test('the cards are found as a list; navigation, footer and plain link lists are not', () => {
  const found = findCandidates(cheerio.load(PAGE));
  assert.equal(found.length, 1);
  assert.equal(found[0].kids.length, 3);
  assert.equal(found[0].before, 'Our menu');
});

test('the page is converted and rebuilt exactly, with the comments and spaces between the cards kept', async () => {
  const r = await structurePage({ html: PAGE, ask });
  assert.equal(r.verified, true); assert.equal(r.lists, 1); assert.equal(r.items, 3);
  assert.equal(renderPage(r.base, r.data), cheerio.load(PAGE).html());
  assert.match(r.base, /<!--list:1-->/);
  assert.equal(r.base.includes('Haircut'), false, 'the content moved into the data');
  assert.equal(r.data.lists[0].name, 'Services');
});

test('every item keeps its own look: the featured card keeps its extra class, and words with & < > survive', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const html = renderList(r.data.lists[0]);
  assert.match(html, /class="rounded p-4 ring-2"/);
  assert.match(html, /Coloring &amp; co/);
  assert.match(html, /&lt;always&gt;/);
});

test('slots get roles: the heading is the name, the price is the price, the long text is the description', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const roles = slotsByRole(r.data.lists[0].items[0]).map((s) => `${s.role}:${s.value.slice(0, 12)}`);
  assert.ok(roles.includes('name:Haircut & co'));
  assert.ok(roles.includes('price:$25'));
  assert.ok(roles.some((x) => x.startsWith('description:')));
  assert.ok(roles.some((x) => x.startsWith('photo:images/Hair')));
});

test('editing: change a word, duplicate, delete, move and add; the rebuilt page follows and keeps the design', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const list = r.data.lists[0];
  const priceSlot = slotsByRole(list.items[0]).find((s) => s.role === 'price').i;
  setText(list.items[0], priceSlot, '$30');
  duplicateItem(list, 1);
  assert.equal(list.items.length, 4);
  moveItem(list, 3, 0);
  assert.equal(removeItem(list, 0), true);
  const added = addItem(list);
  assert.equal(slotsByRole(added).find((s) => s.role === 'name').value, '', 'a new item has empty words');
  const html = renderPage(r.base, r.data);
  assert.match(html, /<span>\$30<\/span>/);
  assert.equal((html.match(/<article/g) || []).length, 4);
  assert.match(html, /<!-- Item 1 -->/, 'the comments between cards stay');
});

test('a page whose lists cannot be rebuilt exactly is not converted, and a failing model call converts nothing', async () => {
  const none = await structurePage({ html: PAGE, ask: async () => { throw new Error('network down'); } });
  assert.equal(none.lists, 0); assert.equal(none.verified, true);
  assert.equal(renderPage(none.base, none.data), cheerio.load(PAGE).html());
});

test('the last item of a list cannot be deleted (the list would disappear from the page)', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const list = r.data.lists[0];
  removeItem(list, 0); removeItem(list, 0);
  assert.equal(removeItem(list, 0), false);
  assert.equal(list.items.length, 1);
});

test('words and pictures outside the lists are slots too; editing them changes the rebuilt page and nothing else', async () => {
  const html = PAGE.replace('<h2>Our menu</h2>', '<h2 class="t">Our menu</h2><p>Open <b>daily</b> &amp; late</p><img src="images/hero.jpg" srcset="images/hero-640.jpg 640w" alt="Hero">');
  const r = await structurePage({ html, ask });
  assert.equal(r.verified, true);
  assert.equal(renderPage(r.base, r.data), cheerio.load(html).html());
  assert.equal(r.base.includes('Our menu'), false, 'the words moved into the data');
  const shown = pageSlotsByRole(r.data);
  const heading = shown.find((s) => s.value === 'Our menu');
  assert.equal(heading.role, 'heading');
  setPageText(r.data, heading.i, 'What we serve');
  const hero = shown.find((s) => s.k === 'src' && s.value === 'images/hero.jpg');
  setPagePhoto(r.data, hero.i, 'images/new.jpg');
  const out = renderPage(r.base, r.data);
  assert.match(out, /<h2 class="t">What we serve<\/h2>/);
  assert.match(out, /src="images\/new.jpg" srcset="images\/new.jpg"/);
  assert.match(out, /Open <b>daily<\/b> &amp; late/, 'what was not edited stays');
});

test('the final site is built from base + data: converted pages from data, everything else copied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-'));
  const site = path.join(dir, 'site'); const st = path.join(dir, 'st'); const out = path.join(dir, 'out');
  fs.mkdirSync(site); fs.mkdirSync(st); fs.writeFileSync(path.join(site, 'index.html'), PAGE); fs.writeFileSync(path.join(site, 'other.html'), '<html><body>x</body></html>'); fs.writeFileSync(path.join(site, 'a.css'), 'b{}');
  const r = await structurePage({ html: PAGE, ask });
  fs.writeFileSync(path.join(st, 'index.base.html'), r.base); fs.writeFileSync(path.join(st, 'index.json'), JSON.stringify(r.data));
  const res = buildSite({ dir: site, structureDir: st, out });
  assert.deepEqual(res.built, ['index.html']); assert.deepEqual(res.copied, ['other.html']);
  assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), cheerio.load(PAGE).html());
  assert.equal(fs.existsSync(path.join(out, 'a.css')), true);
});

test('the editing view marks every text, picture and card, and shows the same words as the page', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const html = renderPageEditable(r.base, r.data);
  assert.match(html, /<span data-slot="P\.\d+"/);
  assert.match(html, /data-item="1\.0"/);
  assert.match(html, /src="images\/Haircut\.jpg" data-slot="L1\.0\.\d+"/);
  assert.equal(cheerio.load(html).text().replace(/\s+/g, ' '), cheerio.load(PAGE).text().replace(/\s+/g, ' '));
});

test('blankItem keeps icons and design, empties the words', () => {
  const list = { items: [{ skeleton: '<div><span class="material-symbols-outlined">@@S0@@</span><b>@@S1@@</b></div>', slots: [{ k: 't', v: 'shower', role: 'icon' }, { k: 't', v: '  Hot showers ', role: 'label' }] }], seps: [] };
  const item = blankItem(list);
  assert.equal(item.slots[0].v, 'shower');
  assert.equal(item.slots[1].v.trim(), '');
});
