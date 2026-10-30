// Heads stay in view: a picture with people gets a focus point, a picture of a product is left alone, the answer is remembered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { focusSite, positionFor } from '../src/wow/focus.js';

test('the frame looks at the heads, a little above their middle, and never leaves the picture', () => {
  assert.equal(positionFor({ top: 15, bottom: 33, left: 44, right: 60 }), '52% 21%');
  assert.equal(positionFor({ top: 0, bottom: 10, left: 0, right: 4 }), '5% 4%');
  assert.equal(positionFor({ top: 90, bottom: 100, left: 96, right: 100 }), '95% 94%');
});

test('pictures with people get object-position, a product does not, the second run asks nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
  fs.mkdirSync(path.join(dir, 'images'));
  for (const n of ['coach.jpg', 'bottle.jpg']) await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335' } }).jpeg().toFile(path.join(dir, 'images', n));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><img class="w-full object-cover" src="images/coach.jpg" alt="c"><img class="object-cover" style="opacity:1" src="images/bottle.jpg" alt="b"><img class="w-10" src="images/coach.jpg" alt="small"></body></html>');
  let calls = 0;
  const ask = async ({ images }) => { calls++; return { pictures: images.map((_, i) => ({ n: i + 1, people: i === 0, heads: i === 0 ? { top: 10, bottom: 30, left: 40, right: 60 } : null })) }; };
  const r = await focusSite({ dir, ask });
  assert.deepEqual([r.pictures, r.withPeople, r.changed], [2, 1, 1]);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /src="images\/coach.jpg"[^>]*|object-position: 50% 17%/);
  assert.match(html, /object-position: 50% 17%/);
  assert.equal((html.match(/object-position/g) || []).length, 1, 'only the person got a focus point; the small icon without object-cover is untouched');
  assert.match(html, /opacity:1/, 'other styles stay');
  assert.equal(calls, 1);
});

test('a failing model call changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
  fs.mkdirSync(path.join(dir, 'images'));
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).jpeg().toFile(path.join(dir, 'images', 'a.jpg'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><img class="object-cover" src="images/a.jpg" alt=""></body></html>');
  const r = await focusSite({ dir, ask: async () => { throw new Error('down'); } });
  assert.equal(r.changed, 0); assert.equal(r.failed, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes('object-position'), false);
});
