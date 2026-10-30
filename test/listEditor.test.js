// The second way to edit: lists and forms, and "paste many".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { structurePage, setText, slotsByRole } from '../src/wow/structure.js';
import { contentOf, parseLines, fillItem } from '../src/server/listEditor.js';

const cheerio = createRequire(import.meta.url)('cheerio');
const card = (n, p) => `<article class="c"><img src="images/${n}.jpg" alt="${n}"><h3>${n}</h3><p>Short note</p><span>${p}</span></article>`;
const PAGE = `<html><body><h1>Menu</h1><section>${card('Latte', '$4')}${card('Mocha', '$5')}${card('Tea', '$3')}</section></body></html>`;
const ask = async () => ({ lists: [{ id: 1, keep: true, name: 'Drinks' }] });

test('the form shows the texts of the page and each item with name, price and photo', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const c = contentOf(r.data);
  assert.ok(c.texts.some((t) => t.role === 'heading' && t.value === 'Menu'));
  assert.equal(c.lists[0].name, 'Drinks'); assert.equal(c.lists[0].items.length, 3);
  const roles = c.lists[0].items[0].fields.map((f) => f.role);
  assert.ok(roles.includes('name') && roles.includes('price') && roles.includes('photo'));
  assert.match(c.lists[0].items[0].fields[0].slot, /^L1\.0\.\d+$/);
});

test('pasted lines become rows, with a bar, a tab or a spreadsheet line', () => {
  assert.deepEqual(parseLines('Iced latte | 4.50 | Espresso over ice\nBun\t3.00\n\n  Tea  '), [
    { name: 'Iced latte', price: '4.50', description: 'Espresso over ice' }, { name: 'Bun', price: '3.00', description: '' }, { name: 'Tea', price: '', description: '' }]);
  assert.equal(parseLines(Array.from({ length: 500 }, (_, i) => `x${i}`).join('\n')).length, 200, 'at most 200 lines at once');
});

test('a row fills the name, the price and the short note of a new item, and the page keeps its design', async () => {
  const r = await structurePage({ html: PAGE, ask });
  const item = JSON.parse(JSON.stringify(r.data.lists[0].items[0]));
  for (const s of item.slots) if (s.k === 't') s.v = '';
  fillItem(item, { name: 'Flat white', price: '$4.20', description: 'Double shot' }, setText);
  const by = Object.fromEntries(slotsByRole(item).filter((s) => s.k === 't').map((s) => [s.role, s.value]));
  assert.equal(by.name, 'Flat white'); assert.equal(by.price, '$4.20'); assert.equal(by.label, 'Double shot');
  assert.equal(cheerio.load(item.skeleton)('article').attr('class'), 'c');
});
