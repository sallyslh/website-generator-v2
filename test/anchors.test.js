import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixAnchors } from '../src/wow/anchors.js';

test('a link to a missing section gets the section found by its heading, or becomes inactive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anch-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<body><a href="#reviews">r</a><a href="about.html#team">t</a><a href="#nothing-here">n</a><section><h2>Customer reviews</h2></section><section id="x"><h2>Other</h2></section></body>');
  fs.writeFileSync(path.join(dir, 'about.html'), '<body><section><h2>Our team</h2></section></body>');
  const r = fixAnchors({ dir });
  assert.deepEqual(r.named.sort(), ['about.html#team', 'index.html#reviews']);
  assert.equal(r.inert.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<section id="reviews">/);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /href="#"[^>]*data-inert/);
});
