// Tests for cut-outs and composites of REAL products (no network: the background-removal model and the image model are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { edgeRatio, trimToAlpha, removeBackground, CUT_OFF_LIMIT } from '../src/lib/cutout.js';
import { arrange, composeProducts } from '../src/lib/composite.js';
import { surfacePrompt } from '../src/lib/imageGen.js';
import { normalizeRecipes, composeImages } from '../src/stages/03-creative-director/compose.js';
import { checkDesign } from '../src/stages/03-creative-director/checks.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { config } from '../src/config.js';
import { flags as composeFlags } from '../src/stages/03-creative-director/compose.js';
composeFlags.collages = true; // this file tests the collage maker itself (collages are OFF in real projects)

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json') });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const slots = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));

// a transparent picture with an opaque rectangle (the "product") at the given place
const product = async (W, H, rect, color = '#cc3344') => sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: rect.w, height: rect.h, channels: 4, background: color } }).png().toBuffer(), left: rect.x, top: rect.y }]).png().toBuffer();

test('a product that touches the photo\'s own border is cut off and refused; a whole product is not', async () => {
  const whole = await product(400, 300, { x: 100, y: 50, w: 200, h: 200 });
  const cut = await product(400, 300, { x: 0, y: 50, w: 200, h: 200 }); // touches the left edge
  const read2 = async (png) => { const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true }); return edgeRatio(data, info.width, info.height); };
  assert.equal(await read2(whole), 0);
  assert.ok((await read2(cut)) > CUT_OFF_LIMIT);
  const t1 = await trimToAlpha(whole);
  assert.deepEqual([t1.width, t1.height, t1.cutOff], [200, 200, false]);
  assert.equal((await trimToAlpha(cut)).cutOff, true);
  // a box standing on its base that touches the bottom of the photo is whole; touching the top or a side is not
  assert.equal((await trimToAlpha(await product(400, 300, { x: 100, y: 100, w: 200, h: 200 }))).cutOff, false, 'base on the bottom edge');
  assert.equal((await trimToAlpha(await product(400, 300, { x: 100, y: 0, w: 200, h: 200 }))).cutOff, true, 'top touches the edge');
  assert.equal((await trimToAlpha(await product(400, 300, { x: 200, y: 100, w: 200, h: 200 }))).cutOff, true, 'right side and base touch the edge');
  await assert.rejects(trimToAlpha(await product(50, 50, { x: 0, y: 0, w: 1, h: 1 }, '#00000000')), /nothing was left/);
});

test('the background removal call: right request, the cut-out is trimmed to the product, failures are explained', async () => {
  config.falKey = 'k';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'));
  try {
    const file = path.join(tmp, 'p.jpg');
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#887766' } }).jpeg().toFile(file);
    const png = await product(600, 400, { x: 200, y: 100, w: 150, h: 220 });
    const calls = [];
    const fake = async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, json: async () => ({ image: { url: 'https://cdn.example/cut.png' } }) };
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    };
    const out = await removeBackground({ file, fetchImpl: fake });
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/birefnet/v2');
    assert.equal(calls[0].options.headers.Authorization, 'Key k');
    const sent = JSON.parse(calls[0].options.body);
    assert.match(sent.image_url, /^data:image\/jpeg;base64,/);
    assert.deepEqual([sent.output_format, sent.refine_foreground], ['png', true]);
    assert.deepEqual([out.width, out.height, out.cutOff, out.cost], [150, 220, false, 0.01]);
    await assert.rejects(removeBackground({ file, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({ detail: 'no credit' }) }) }), /402.*no credit/);
    config.falKey = '';
    await assert.rejects(removeBackground({ file, fetchImpl: fake }), /FAL_KEY/);
  } finally { config.falKey = ''; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('products are arranged like a lineup: same height, common baseline, centered, all inside the picture', () => {
  const items = [{ width: 400, height: 700 }, { width: 900, height: 500 }, { width: 300, height: 300 }];
  const { placements, baseline } = arrange(items, 1600, 900);
  assert.equal(new Set(placements.map((p) => p.height)).size, 1, 'all products have the same height');
  assert.ok(placements.every((p) => p.top + p.height === baseline), 'standing on one baseline');
  assert.ok(placements.every((p, i) => p.left >= 0 && p.left + p.width <= 1600 && (i === 0 || p.left > placements[i - 1].left + placements[i - 1].width)), 'inside the picture, in order, not overlapping');
  const rowL = placements[0].left; const rowR = placements.at(-1).left + placements.at(-1).width;
  assert.ok(Math.abs(rowL - (1600 - rowR)) <= 2, 'centered');
  const wide = arrange(Array(3).fill({ width: 2000, height: 500 }), 1600, 900);
  assert.ok(wide.placements.at(-1).left + wide.placements.at(-1).width <= 1600 * 0.93, 'a row that is too wide shrinks as a whole');
  assert.match(surfacePrompt({ colors: ['#f6e9e6'] }), /empty.*no products, no people, no text/);
});

test('a composite keeps the products\' own pixels: the real color is in the picture, on the new background, with the right size', async () => {
  const a = await product(300, 500, { x: 20, y: 20, w: 260, h: 460 }, '#ff0000');
  const b = await product(300, 500, { x: 20, y: 20, w: 260, h: 460 }, '#0000ff');
  const trimmed = async (png) => ({ buffer: await sharp(png).extract({ left: 20, top: 20, width: 260, height: 460 }).png().toBuffer(), width: 260, height: 460 });
  const out = await composeProducts({ cutouts: [await trimmed(a), await trimmed(b)], background: '#ffffff', aspect: '16:9' });
  assert.deepEqual([out.width, out.height], [1600, 900]);
  const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...raw.data.subarray((y * raw.info.width + x) * raw.info.channels, (y * raw.info.width + x) * raw.info.channels + 3)];
  const reds = []; const blues = [];
  for (let x = 0; x < 1600; x += 8) { const p = px(x, 500); if (p[0] > 220 && p[1] < 40 && p[2] < 40) reds.push(x); if (p[2] > 220 && p[0] < 40 && p[1] < 40) blues.push(x); }
  assert.ok(reds.length > 5 && blues.length > 5, 'both real products are in the picture, unchanged');
  assert.ok(Math.max(...reds) < Math.min(...blues), 'in the order given');
  assert.ok(px(10, 10).every((v) => v > 230), 'the background is the new background');
  await assert.rejects(composeProducts({ cutouts: [{ buffer: a, width: 10, height: 10 }] }), /at least 2/);
});

test('composite recipes: 2 or 3 usable photos and the image service, otherwise a plain collage of the same photos', () => {
  const { design, manifest } = load();
  const s = slots(design);
  s[0].recipe = { type: 'composite', sources: ['asset-001', 'asset-002'], background: 'plain', reason: '' };
  assert.deepEqual(normalizeRecipes(design, manifest, { generation: true }), []);
  assert.deepEqual([s[0].recipe.type, s[0].assignedAsset], ['composite', null], 'waits to be built');
  s[0].recipe = { type: 'composite', sources: ['asset-001', 'asset-002'], reason: '' };
  const w = normalizeRecipes(design, manifest, { generation: false });
  assert.ok(w.some((x) => /cutting products out is not available.*plain collage/.test(x)));
  assert.equal(s[0].recipe.type, 'collage');
  s[0].recipe = { type: 'composite', sources: ['asset-001', 'asset-003'], reason: '' }; // asset-003 is low quality: one photo left
  assert.ok(normalizeRecipes(design, manifest, { generation: true }).some((x) => /needs 2 or 3 usable photos/.test(x)));
  assert.equal(s[0].recipe.type, 'use');
  s[0].recipe = { type: 'composite', sources: ['asset-001', 'asset-002', 'asset-001', 'asset-004'], reason: '' }; // the logo cannot be a product
  assert.ok(normalizeRecipes(design, manifest, { generation: true }).some((x) => /cannot be used in a composite/.test(x)));
  assert.deepEqual(s[0].recipe.sources, ['asset-001', 'asset-002']);
});

test('the whole step: products are cut out once (cached), cut-off products are refused, the check passes, and a failure falls back to a collage', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compstep-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    manifest.assets.push({ ...manifest.assets[1], id: 'asset-005', file: 'inputs/assets/asset-005.jpg', description: 'A third product' });
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = slots(design)[0];
    Object.assign(hero, { aspect: '16:9', preferredCategory: manifest.assets[0].category });
    hero.recipe = { type: 'composite', sources: ['asset-001', 'asset-002', 'asset-005'], background: 'plain', reason: 'the range together' };
    normalizeRecipes(design, manifest, { generation: true });
    let cuts = 0;
    const good = await product(500, 700, { x: 50, y: 50, w: 300, h: 600 });
    const deps = {
      removeBackground: async ({ file }) => { cuts++; const t = await trimToAlpha(await product(500, 700, file.includes('asset-005') ? { x: 0, y: 50, w: 300, h: 600 } : { x: 50, y: 50, w: 300, h: 600 })); return { ...t, cost: 0.01 }; },
      generateImage: async () => { throw new Error('not needed for a plain background'); },
    };
    void good;
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(made, ['comp-1']);
    const comp = manifest.assets.find((a) => a.id === 'comp-1');
    assert.deepEqual([comp.origin, comp.approval], ['composite', 'pending']);
    assert.deepEqual(comp.derivedFrom, ['asset-001', 'asset-002'], 'the cut-off product (asset-005) was left out');
    assert.equal(hero.assignedAsset, 'comp-1');
    assert.equal(cuts, 3);
    assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => /recipe|combined|generated/.test(n)), []);
    const costLines = fs.readFileSync(projectPath('p1', 'cost-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([costLines.length, costLines[0].provider, costLines[0].estimatedUsd], [3, 'fal', 0.01]);
    // a second run uses the saved cut-outs: no new cost
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(cuts, 4, 'only the refused product is tried again (it was never saved)');
    // the cut-out service fails: the same real photos become a plain collage, never an empty frame
    hero.recipe = { type: 'composite', sources: ['asset-001', 'asset-005'], background: 'plain', reason: '' };
    fs.rmSync(projectPath('p1', 'inputs/cutouts'), { recursive: true, force: true });
    await composeImages({ projectId: 'p1', design, manifest, deps: { ...deps, removeBackground: async () => { throw new Error('service down'); } } });
    assert.equal(hero.recipe.type, 'collage');
    assert.match(hero.assignedAsset, /^combo-/);
    assert.deepEqual(manifest.assets.find((a) => a.id === hero.assignedAsset).derivedFrom, ['asset-001', 'asset-005']);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('frames follow the photos: a frame that would cut away more than a quarter of its photo is reported (informational)', () => {
  const { brief, manifest, design } = load();
  const s = slots(design)[0];
  const photo = manifest.assets.find((a) => a.id === s.assignedAsset);
  s.aspect = `${photo.height}:${photo.width}`; // the photo's shape turned on its side
  const warn = checkDesign(design, brief, manifest).find((r) => r.name.startsWith('warning only: frames that would cut away'));
  assert.equal(warn.ok, true);
  assert.match(warn.details, new RegExp(s.id));
  s.aspect = `${photo.width}:${photo.height}`;
  assert.equal(checkDesign(design, brief, manifest).find((r) => r.name.startsWith('warning only: frames that would cut away')).details, 'none');
});

test('a tall frame gets two rows: everything inside the picture, nothing overlapping, each product keeps its shape', async () => {
  const { arrangeRows } = await import('../src/lib/composite.js');
  for (const items of [[{ width: 400, height: 700 }, { width: 900, height: 500 }], [{ width: 400, height: 700 }, { width: 900, height: 500 }, { width: 300, height: 300 }]]) {
    const p = arrangeRows(items, 1280, 1600);
    assert.equal(p.length, items.length);
    for (let i = 0; i < p.length; i++) {
      assert.ok(p[i].left >= 0 && p[i].top >= 0 && p[i].left + p[i].width <= 1280 && p[i].top + p[i].height <= 1600, `item ${i} inside`);
      assert.ok(Math.abs(p[i].width / p[i].height - items[i].width / items[i].height) < 0.03, 'the product keeps its own proportions');
      for (let j = i + 1; j < p.length; j++) {
        const apart = p[i].left + p[i].width <= p[j].left || p[j].left + p[j].width <= p[i].left || p[i].top + p[i].height <= p[j].top || p[j].top + p[j].height <= p[i].top;
        assert.ok(apart, `items ${i} and ${j} do not overlap`);
      }
    }
    assert.ok(Math.max(...p.map((x) => x.height)) > 1600 * 0.18, 'the products are not tiny');
  }
  const out = await composeProducts({ cutouts: [{ buffer: await product(100, 200, { x: 0, y: 0, w: 100, h: 200 }), width: 100, height: 200 }, { buffer: await product(100, 200, { x: 0, y: 0, w: 100, h: 200 }, '#0000ff'), width: 100, height: 200 }], background: '#ffffff', aspect: '4:5' });
  assert.ok(out.height > out.width, 'the picture is portrait');
});

test('a photo of several products: the ones cut by the frame are dropped, the whole ones in the middle are kept', async () => {
  const W = 600; const H = 300;
  const box = async (w, h, color) => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
  const strip = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await box(150, 250, '#aa0000'), left: 0, top: 30 },     // touches the left edge: cut
      { input: await box(120, 220, '#00aa00'), left: 190, top: 50 },   // whole
      { input: await box(110, 230, '#0000aa'), left: 330, top: 45 },   // whole
      { input: await box(150, 250, '#aaaa00'), left: 450, top: 30 },   // touches the right edge: cut
    ]).png().toBuffer();
  const t = await trimToAlpha(strip);
  assert.deepEqual([t.cutOff, t.partial, t.whole, t.dropped], [false, true, 2, 2]);
  assert.deepEqual([t.width, t.height], [250, 230], 'trimmed to the two whole products together');
  const raw = await sharp(t.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...raw.data.subarray((y * raw.info.width + x) * 4, (y * raw.info.width + x) * 4 + 4)];
  assert.deepEqual(px(10, 100), [0, 170, 0, 255], 'the first whole product keeps its own pixels');
  assert.deepEqual(px(200, 100), [0, 0, 170, 255], 'so does the second');
  assert.equal(px(130, 100)[3], 0, 'the gap between them stays empty');
  // no whole product at all: still refused, like before
  const onlyCut = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await box(150, 250, '#aa0000'), left: 0, top: 30 }, { input: await box(150, 250, '#aaaa00'), left: 450, top: 30 }]).png().toBuffer();
  assert.equal((await trimToAlpha(onlyCut)).cutOff, true);
  // a bottle cut at the top is not rescued
  assert.equal((await trimToAlpha(await box(200, 300, '#aa0000'))).cutOff, true);
});

test('a product that touches the frame is judged: flush with the edge and readable is used, a sliced one is not; no judge means refused', async () => {
  const W = 600; const H = 300;
  const box = (w, h, color) => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
  const strip = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await box(150, 270, '#aa0000'), left: 0, top: 0 },      // touches the left AND the top edge
      { input: await box(120, 270, '#00aa00'), left: 200, top: 0 },    // touches only the top edge (ends flush with the frame)
      { input: await box(150, 250, '#aaaa00'), left: 450, top: 20 },   // touches the right edge
    ]).png().toBuffer();
  assert.equal((await trimToAlpha(strip)).cutOff, true, 'without a judge, touching the frame means cut off');
  const asked = [];
  const judge = async ({ edges, picture }) => { asked.push(edges.join('+')); assert.ok(Buffer.isBuffer(picture) && picture.length > 100); return edges.length === 1 && edges[0] === 'top'; };
  const t = await trimToAlpha(strip, 16, judge);
  assert.deepEqual([t.cutOff, t.partial, t.whole], [false, true, 1]);
  assert.deepEqual([t.width, t.height], [120, 270], 'only the box that was judged complete is kept');
  assert.deepEqual(asked.sort(), ['left+top', 'right', 'top']);
  assert.equal((await trimToAlpha(strip, 16, async () => false)).cutOff, true, 'every product judged cut off: refused');
});
