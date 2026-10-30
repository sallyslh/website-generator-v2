// Tests for the owner's brand (logo and colours) in the "generate first" pipeline: reading it, putting it into the prompts, placing the real logo.
// No API calls: the model that looks at a logo is a fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { parseColorsText, saveLogo, dominantColors, readBrand, brandBlock, placeLogo, LOGO_FILE, BRAND_FILE } from '../src/wow/brand.js';
import { conceptPrompt } from '../src/wow/concept.js';
import { briefPrompt } from '../src/wow/brief.js';
import { buildWowPrompt } from '../src/wow/prompt.js';
import { loadType } from '../src/wow/run.js';
import { createWowServer } from '../src/server/wow.js';

setProjectsRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'brand-')));

// a small test logo: a big red square with a small blue one in a corner, on white
async function logoPng() {
  const base = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const red = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#c0392b' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#1f4fd8' } }).png().toBuffer();
  return sharp(base).composite([{ input: red, left: 30, top: 30 }, { input: blue, left: 160, top: 160 }]).png().toBuffer();
}
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;

test('typed colours: codes are found, words are kept', () => {
  const c = parseColorsText('deep green and gold, #1A2B3C and #fff');
  assert.deepEqual(c.hex, ['#1a2b3c', '#ffffff']);
  assert.match(c.words, /deep green and gold/);
  assert.deepEqual(parseColorsText('').hex, []);
});

test('a logo file: only a real picture is accepted, and it is stored at a sensible size', async () => {
  await assert.rejects(saveLogo('b-1', 'data:text/plain;base64,aGVsbG8='), (e) => e.status === 400 && /picture/i.test(e.message));
  await assert.rejects(saveLogo('b-1', dataUrl(Buffer.from('this is not a picture'))), (e) => e.status === 400 && /could not read/i.test(e.message));
  const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#336699' } }).png().toBuffer();
  const file = await saveLogo('b-1', dataUrl(big));
  const meta = await sharp(file).metadata();
  assert.ok(fs.existsSync(file) && meta.width <= 1024, 'stored, at most 1024 px wide');
});

test('the main colours of a logo come from its pixels: the big one first, white background ignored', async () => {
  const file = path.join(os.tmpdir(), `logo-${Date.now()}.png`);
  fs.writeFileSync(file, await logoPng());
  const colors = await dominantColors(file);
  assert.ok(colors.length >= 2);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colors[0].slice(i, i + 2), 16));
  assert.ok(r > 150 && g < 100 && b < 100, `the big red square leads, got ${colors[0]}`);
  assert.ok(!colors.includes('#ffffff'));
});

test('reading the brand: nothing given means no brand; typed colours; a logo is read once and kept', async () => {
  assert.equal(await readBrand({ projectId: 'b-none' }), null);
  assert.equal(fs.existsSync(projectPath('b-none', BRAND_FILE)), false);

  const typed = await readBrand({ projectId: 'b-typed', colorsText: 'gold and cream #c8a24a' });
  assert.deepEqual(typed.colors, ['#c8a24a']);
  assert.equal(typed.logo, null);
  assert.match(typed.source, /typed/);

  await saveLogo('b-logo', dataUrl(await logoPng()));
  let calls = 0;
  const ask = async () => { calls++; return { colors: ['#C0392B', '#1F4FD8'], personality: ['bold', 'sporty'], description: 'A red square with a small blue corner mark.' }; };
  const brand = await readBrand({ projectId: 'b-logo', colorsText: '#112233', ask });
  assert.deepEqual(brand.colors, ['#112233', '#c0392b', '#1f4fd8'], 'typed colours first, then the logo colours');
  assert.equal(brand.logo, LOGO_FILE);
  assert.deepEqual(brand.personality, ['bold', 'sporty']);
  await readBrand({ projectId: 'b-logo', ask });
  assert.equal(calls, 1, 'read once, then kept');

  await saveLogo('b-fallback', dataUrl(await logoPng()));
  const fallback = await readBrand({ projectId: 'b-fallback', ask: async () => { throw new Error('model down'); } });
  assert.ok(fallback.colors.length >= 2 && fallback.colors[0].startsWith('#'), 'when the model cannot look, the pixel count is used');
});

test('the brand reaches the concept, the brief and the Stitch prompt; with no brand the colours are free', () => {
  const brand = { logo: LOGO_FILE, colors: ['#c0392b', '#1f4fd8'], colorWords: 'red and blue', personality: ['bold'], description: 'A red square.', source: 'logo' };
  assert.match(brandBlock(brand), /#c0392b/);
  assert.match(brandBlock(null), /none given/i);
  const pages = [{ title: 'Home' }, { title: 'Courts' }];
  assert.match(conceptPrompt({ name: 'X', typeLabel: 'Padel', language: 'English', pages, sparks: [], directions: [], brand }), /#c0392b/);
  assert.doesNotMatch(conceptPrompt({ name: 'X', typeLabel: 'Padel', language: 'English', pages, sparks: [], directions: [] }), /#c0392b/);
  const typeData = loadType('padel');
  assert.match(briefPrompt({ name: 'X', typeData, pages: ['home', 'courts'], language: 'English', brand }), /MUST match it/);
  assert.doesNotMatch(briefPrompt({ name: 'X', typeData, pages: ['home', 'courts'], language: 'English' }), /MUST match it/);
  const brief = { colors: { primary: '#000000', secondary: '#111111', accent: '#222222', background: '#ffffff', text: '#000000' }, concept: 'c', styleBlock: 's', fonts: { headings: 'A', body: 'B' }, photoshoot: 'p', cast: '', signature: '', contact: { phone: '', email: '', address: '', hours: '' }, team: [], reviews: [] };
  const page = { slug: 'home', title: 'Home', headline: 'H', sections: [] };
  const withLogo = buildWowPrompt({ name: 'X', typeLabel: 'Padel', brief, page, pages: [page], siteLanguage: 'English', brand });
  const without = buildWowPrompt({ name: 'X', typeLabel: 'Padel', brief, page, pages: [page], siteLanguage: 'English' });
  assert.match(withLogo, /alt text is "logo"/);
  assert.doesNotMatch(without, /alt text is "logo"/);
  assert.match(without, /business name as a bold wordmark/);
});

test('the real logo replaces the one the design drew; with no logo drawn it goes in the header link; otherwise nothing changes', () => {
  const drawn = '<header><a href="#"><img class="h-10 w-auto" alt="Smash Point logo" src="x.png"></a></header><footer><img alt="logo mark" src="y.png"></footer>';
  const a = placeLogo(drawn, { name: 'Smash Point', src: 'images/logo.png' });
  assert.equal(a.placed, 2);
  assert.equal((a.html.match(/images\/logo\.png/g) || []).length, 2);
  assert.match(a.html, /alt="Smash Point logo"/);
  const text = '<header><a href="#">SMASH POINT</a><nav><a href="x.html">Courts</a></nav></header>';
  const b = placeLogo(text, { name: 'Smash Point', src: 'images/logo.png' });
  assert.equal(b.placed, 1);
  assert.match(b.html, /<a href="#"><img src="images\/logo\.png"/);
  assert.match(b.html, /<a href="x\.html">Courts<\/a>/, 'the other links stay');
  const c = placeLogo('<header><a href="#">Something else</a></header>', { name: 'Smash Point', src: 'images/logo.png' });
  assert.equal(c.placed, 0);
});

test('the customer screen sends a logo and colours; a bad file is refused before anything is paid for', async () => {
  const seen = [];
  const { server } = createWowServer({ runJob: async ({ options }) => { seen.push(options); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => { const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json().catch(() => ({})) }; };
  try {
    const pages = ['home', 'courts', 'book'];
    const bad = await post({ name: 'Smash Point', type: 'padel', pages, logo: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /could not read|picture/i);
    assert.equal(seen.length, 0, 'nothing ran');
    const ok = await post({ name: 'Smash Point', type: 'padel', pages, logo: dataUrl(await logoPng()), brandColors: 'red and blue' });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen[0].brandColors, 'red and blue');
    assert.ok(fs.existsSync(projectPath(ok.data.id, LOGO_FILE)), 'the logo is stored with the project');
    const state = fs.readFileSync(projectPath(ok.data.id, 'wow-state.json'), 'utf8');
    assert.equal(state.includes('base64'), false, 'the picture itself is not kept in the saved job');
    assert.equal(JSON.parse(state).hasLogo, true);
  } finally { server.close(); }
});
