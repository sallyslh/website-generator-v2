// Tests for the owner's optional taste notes ("I like bright colours", "nothing too dark"): they reach the concept and the brief, and only when written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setProjectsRoot } from '../src/lib/project.js';
import { tasteBlock } from '../src/wow/brand.js';
import { conceptPrompt } from '../src/wow/concept.js';
import { briefPrompt } from '../src/wow/brief.js';
import { loadType } from '../src/wow/run.js';
import { createWowServer } from '../src/server/wow.js';

setProjectsRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'taste-')));

test('taste notes: nothing written means nothing added; written text is passed on and says the brand colours come first', () => {
  assert.equal(tasteBlock(''), '');
  assert.equal(tasteBlock('   '), '');
  assert.equal(tasteBlock(undefined), '');
  const t = tasteBlock('Soft neutral tones. I love nude and gold');
  assert.match(t, /nude and gold/);
  assert.match(t, /brand colours, when given, come first/);
});

test('taste notes reach the concept and the brief only when the owner wrote some', () => {
  const pages = [{ title: 'Home' }];
  const base = { name: 'X', typeLabel: 'Padel', language: 'English', pages, sparks: [], directions: [] };
  assert.match(conceptPrompt({ ...base, taste: 'Dark and moody' }), /Dark and moody/);
  assert.doesNotMatch(conceptPrompt(base), /THE OWNER'S TASTE/);
  const typeData = loadType('padel');
  assert.match(briefPrompt({ name: 'X', typeData, pages: ['home'], language: 'English', taste: 'Bright and colourful' }), /Bright and colourful/);
  assert.doesNotMatch(briefPrompt({ name: 'X', typeData, pages: ['home'], language: 'English' }), /THE OWNER'S TASTE/);
});

test('the customer screen sends the notes to the pipeline, shortened to a sensible length', async () => {
  const seen = [];
  const { server } = createWowServer({ runJob: async ({ options }) => { seen.push(options); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smash Point', type: 'padel', pages: ['home', 'courts', 'book'], notes: `Bright and colourful. ${'x'.repeat(2000)}` }) });
    assert.equal(res.status, 200);
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(seen[0].notes, /^Bright and colourful\./);
    assert.ok(seen[0].notes.length <= 600);
  } finally { server.close(); }
});

test('the customer screen has the optional taste section and the optional logo section', () => {
  const html = fs.readFileSync(new URL('../src/server/wow-public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Tell us your taste \(optional\)/);
  assert.match(html, /I already have a logo or brand colours \(optional\)/);
  assert.match(html, /Soft neutral tones/);
  assert.match(html, /notes: tasteText\(\)/);
});
