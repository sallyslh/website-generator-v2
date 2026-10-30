// Tests for the photographic re-rendering of product scenes (no network: the editing model and the vision check are faked).
// The rule under test: the product's own fine detail (its printed text) always survives, whatever the editing model did to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { alignProduct, mergeProducts, realizeScene, realizePrompt, editImage, MIN_ALIGN_SCORE } from '../src/lib/realize.js';
import { normalizeRecipes, composeImages } from '../src/stages/03-creative-director/compose.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { config } from '../src/config.js';
import { flags as composeFlags } from '../src/stages/03-creative-director/compose.js';
composeFlags.collages = true; // this file tests the collage maker itself (collages are OFF in real projects)

const W = 640; const H = 480;
// a product with fine "printed text": a checkerboard of 3 px cells on a light body, with a dark rim
async function product(w = 120, h = 180) {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4; const rim = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
    const ink = !rim && ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0) && x > 20 && x < w - 20 && y > 40 && y < 120;
    const v = rim ? 60 : ink ? 20 : 235;
    raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
const table = () => sharp({ create: { width: W, height: H, channels: 3, background: '#c9b8a6' } }).jpeg().toBuffer();
// fine detail inside a rectangle: the mean difference between the picture and a blurred copy of it (high = crisp print, low = smeared)
async function detail(buffer, rect) {
  const a = await sharp(buffer).extract(rect).greyscale().raw().toBuffer();
  const b = await sharp(buffer).extract(rect).greyscale().blur(2).raw().toBuffer();
  let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

test('the product is found in the edited picture even when it moved a little and grew', async () => {
  const cutout = await product();
  const placement = { left: 260, top: 200, width: 120, height: 180 };
  // the "edited" picture: the same product drawn 4% bigger, 8 px to the left and 5 px lower
  const pw = Math.round(120 * 1.04); const ph = Math.round(180 * 1.04);
  const edited = await sharp(await table()).composite([{ input: await sharp(cutout).resize(pw, ph).png().toBuffer(), left: 252, top: 205 }]).removeAlpha().raw().toBuffer();
  const box = await alignProduct({ edited: { data: edited, width: W, height: H }, cutout, placement });
  assert.ok(box.score > MIN_ALIGN_SCORE);
  assert.ok(Math.abs(box.left - 252) <= 3 && Math.abs(box.top - 205) <= 3, `found at ${box.left},${box.top}`);
  assert.ok(Math.abs(box.width - pw) <= 6);
});

test('the merge puts the real fine detail back and takes the light from the edited picture', async () => {
  const cutout = await product();
  const placement = { left: 260, top: 200, width: 120, height: 180 };
  // the editing model smeared the printed area (like garbled letters) and made the whole product darker
  const smeared = await sharp(cutout).blur(4).modulate({ brightness: 0.85 }).png().toBuffer();
  const editedJpeg = await sharp(await table()).composite([{ input: smeared, left: 260, top: 200 }]).jpeg({ quality: 95 }).toBuffer();
  const raw = await sharp(editedJpeg).removeAlpha().raw().toBuffer();
  const merged = await mergeProducts({ edited: { data: raw, width: W, height: H }, items: [{ cutout, box: placement }] });
  const printed = { left: 290, top: 250, width: 60, height: 60 };
  const lost = await detail(editedJpeg, printed); const back = await detail(merged, printed); const real = await detail(cutout, { left: 30, top: 50, width: 60, height: 60 });
  assert.ok(lost < real / 4, `the edited picture lost the detail (${lost.toFixed(1)} vs ${real.toFixed(1)})`);
  assert.ok(back > real * 0.8, `the merged picture has the product's own detail back (${back.toFixed(1)} vs ${real.toFixed(1)})`);
  const light = async (b) => (await sharp(b).extract({ left: 268, top: 215, width: 20, height: 15 }).greyscale().stats()).channels[0].mean; // body area without ink
  assert.ok((await light(merged)) < (await light(cutout.length ? await sharp(cutout).extract({ left: 8, top: 15, width: 20, height: 15 }).jpeg().toBuffer() : cutout)) + 1, 'the body follows the darker light of the edited picture');
  // nothing outside the product's box changed
  const around = { left: 20, top: 20, width: 100, height: 100 };
  assert.equal(Math.round((await sharp(merged).extract(around).stats()).channels[0].mean), Math.round((await sharp(editedJpeg).extract(around).stats()).channels[0].mean));
});

test('a whole realize step: edited picture used for the room, product detail intact, costs reported; a failed check keeps nothing new', async () => {
  const cutout = await product();
  const placement = { left: 260, top: 200, width: 120, height: 180 };
  const rough = { buffer: await sharp(await table()).composite([{ input: cutout, left: 260, top: 200 }]).jpeg().toBuffer(), width: W, height: H };
  const calls = { edit: 0, verify: 0 };
  const editImageFake = async ({ images, prompt }) => {
    calls.edit++;
    assert.equal(images.length, 2, 'the rough scene and the real photo');
    assert.match(prompt, /ALL printed text must stay identical/);
    const smeared = await sharp(cutout).blur(4).png().toBuffer();
    return { buffer: await sharp(await table()).composite([{ input: smeared, left: 256, top: 203 }]).jpeg().toBuffer(), width: W, height: H, cost: 0.05 };
  };
  const items = [{ cutout, placement, photo: await sharp(await table()).jpeg().toBuffer() }];
  const ok = await realizeScene({ projectId: 'p1', rough, items, deps: { editImage: editImageFake, verifyRealism: async () => { calls.verify++; return ''; } } });
  assert.deepEqual([calls.edit, calls.verify, ok.cost], [1, 1, 0.05]);
  assert.ok((await detail(ok.buffer, { left: 290, top: 250, width: 60, height: 60 })) > 0.8 * (await detail(cutout, { left: 30, top: 50, width: 60, height: 60 })), 'the product keeps its own detail');

  // the check finds something new in the picture: the step fails, and the money already spent is reported on the error
  await assert.rejects(realizeScene({ projectId: 'p1', rough, items, deps: { editImage: editImageFake, verifyRealism: async () => 'something new appeared in the picture (text)' } }),
    (e) => /something new appeared/.test(e.message) && e.spent.length === 1 && e.spent[0].cost === 0.05);

  // the product cannot be found: refused
  const empty = async () => ({ buffer: await sharp(await table()).jpeg().toBuffer(), width: W, height: H, cost: 0.05 });
  await assert.rejects(realizeScene({ projectId: 'p1', rough, items, deps: { editImage: empty, verifyRealism: async () => '' } }), /could not be found/);

  // cached: the second time the editing model is not called again, and a checked picture is not checked again
  let stored = null;
  const cache = { read: () => stored, write: (v) => { stored = v; } };
  const deps = { editImage: editImageFake, verifyRealism: async () => { calls.verify++; return ''; } };
  await realizeScene({ projectId: 'p1', rough, items, cache, deps });
  const editsBefore = calls.edit; const verifiesBefore = calls.verify;
  await realizeScene({ projectId: 'p1', rough, items, cache, deps });
  assert.deepEqual([calls.edit - editsBefore, calls.verify - verifiesBefore], [0, 0]);
});

test('the editing request: the right model, up to four pictures, a size the model likes, and plain error messages', async () => {
  config.falKey = 'k';
  try {
    const sent = [];
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const fake = async (url, options) => {
      sent.push({ url, options });
      if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://cdn.example/x.jpg', width: 1600, height: 1216 }], has_nsfw_concepts: [false] }) };
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    };
    const out = await editImage({ images: [png, png], prompt: 'p', width: 1600, height: 1200, fetchImpl: fake });
    assert.equal(sent[0].url, 'https://fal.run/fal-ai/flux-2/edit');
    const body = JSON.parse(sent[0].options.body);
    assert.deepEqual([body.image_urls.length, body.image_size, body.output_format], [2, { width: 1600, height: 1216 }, 'jpeg']);
    assert.match(body.image_urls[0], /^data:image\/jpeg;base64,/);
    assert.ok(out.cost > 0 && out.cost < 0.2);
    await assert.rejects(editImage({ images: [png], prompt: 'p', width: 800, height: 600, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({ detail: 'no credit' }) }) }), /402.*no credit/);
    config.falKey = '';
    await assert.rejects(editImage({ images: [png], prompt: 'p', width: 800, height: 600, fetchImpl: fake }), /FAL_KEY/);
  } finally { config.falKey = ''; }
  assert.match(realizePrompt(3), /3 real products/);
});

test('in the whole scene step the realistic picture replaces the pasted one, and any failure keeps the pasted one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realize-'));
  setProjectsRoot(tmp);
  try {
    const dir = path.resolve('test/fixtures/demo-restaurant');
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const manifest = read('asset-manifest.json'); const design = read('design-spec.json');
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots))[0];
    Object.assign(hero, { aspect: '4:3', preferredCategory: manifest.assets[0].category });
    hero.recipe = { type: 'scene', scene: 'pale linen tabletop by a window', props: ['rose petals'], mood: 'soft', sources: ['asset-001'], reason: 'x' };
    normalizeRecipes(design, manifest, { generation: true, names: ['Cafe'] });
    const cutPng = await product(300, 500);
    let edits = 0; let verdict = ''; let n = 0;
    const deps = {
      naturalScenes: false, // this test is about the exact method
      generateImage: async () => ({ buffer: await sharp({ create: { width: 1024, height: 768, channels: 3, background: { r: 120 + (n++ % 4) * 40, g: 190, b: 170 } } }).jpeg().toBuffer(), width: 1024, height: 768, cost: 0.012 }), // every set is different
      inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }),
      removeBackground: async () => ({ buffer: cutPng, width: 300, height: 500, cutOff: false, cost: 0.01 }),
      // the editing model returns the rough picture it was given, slightly darker: the product stays where it was
      editImage: async ({ images }) => { edits++; return { buffer: await sharp(images[0]).modulate({ brightness: 0.95 }).jpeg().toBuffer(), width: 1600, height: 1200, cost: 0.06 }; },
      verifyRealism: async () => verdict,
    };
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(made.length, 1);
    const scene = manifest.assets.find((a) => a.id === made[0]);
    assert.match(scene.description, /lit and reflected as if photographed there/);
    assert.equal(edits, 1);
    const costs = fs.readFileSync(projectPath('p1', 'cost-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(costs.some((c) => c.model === 'flux-2-edit' && c.estimatedUsd === 0.06), 'the edit is paid and logged');
    assert.ok(fs.existsSync(projectPath('p1', 'inputs/cutouts/edit-' + hero.id + '.jpg')), 'the edited picture is kept for rebuilds');

    // a second slot whose check fails: still a scene, but the plain pasted one
    hero.recipe = { type: 'scene', scene: 'dark slate bar top in low light', props: [], mood: 'moody', sources: ['asset-001'], reason: 'x' };
    normalizeRecipes(design, manifest, { generation: true, names: ['Cafe'] });
    verdict = 'something new appeared in the picture (a logo)';
    const again = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(again.length, 1);
    assert.doesNotMatch(manifest.assets.find((a) => a.id === again[0]).description, /lit and reflected/);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
