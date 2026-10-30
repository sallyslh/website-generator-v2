// Tests for crops, atmosphere pictures and the image inventory (no network, no API calls: vision and the image model are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { normalizeRecipes, composeImages } from '../src/stages/03-creative-director/compose.js';
import { checkDesign } from '../src/stages/03-creative-director/checks.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { assetManifestSchema } from '../src/schemas/assetManifest.js';
import { config } from '../src/config.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json') });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const slots = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));

test("atmosphere subjects are checked by code: no product or package (those only come from real photos), place, logo, text, identity claim or the business's own names; generic people are fine", async () => {
  const { subjectProblems, atmospherePrompt, sizeForAspect, estimateCost } = await import('../src/lib/imageGen.js');
  assert.deepEqual(subjectProblems('ground coffee spilling on dark slate', ['Bean Bar']), []);
  assert.deepEqual(subjectProblems('dried flower petals on folded linen', ['Bonza']), []);
  for (const bad of ['a perfume bottle on a table', 'the shop front with a sign', 'a box with the logo', 'Bonza gift sets on linen', 'coffee', 'the owner smiling behind the counter', 'our staff with a testimonial'])
    assert.ok(subjectProblems(bad, ['Bonza']).length > 0, bad);
  const prompt = atmospherePrompt({ subject: 'ground coffee on slate', style: 'dark, moody', colors: ['#112233'] });
  assert.match(prompt, /ground coffee on slate/);
  assert.match(prompt, /no products, no bottles, no packaging, no text, no letters, no logos/);
  assert.deepEqual(subjectProblems('hands pouring tea into a cup', ['Bonza']), [], 'a generic person or hands are allowed');
  assert.deepEqual(subjectProblems('a woman standing at a sunny window', ['Bonza']), []);
  assert.deepEqual(sizeForAspect('4:3'), { width: 1152, height: 864 });
  const tall = sizeForAspect('3:4');
  assert.ok(tall.height > tall.width && tall.width * tall.height < 1_100_000);
  assert.equal(estimateCost({ width: 1152, height: 864 }), 0.0119);
});

test('the image provider call: the right request, the picture is downloaded, failures are explained (no network)', async () => {
  const { generateImage } = await import('../src/lib/imageGen.js');
  config.falKey = 'test-key';
  try {
    const calls = [];
    const fakeFetch = async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://cdn.example/p.jpg', width: 1152, height: 864 }], has_nsfw_concepts: [false] }) };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const out = await generateImage({ prompt: 'p', aspect: '4:3', fetchImpl: fakeFetch });
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/flux-2');
    assert.equal(calls[0].options.headers.Authorization, 'Key test-key');
    const sent = JSON.parse(calls[0].options.body);
    assert.deepEqual([sent.prompt, sent.num_images, sent.enable_safety_checker, sent.image_size], ['p', 1, true, { width: 1152, height: 864 }]);
    assert.deepEqual([...out.buffer], [1, 2, 3]);
    assert.equal(out.cost, 0.0119);
    await assert.rejects(generateImage({ prompt: 'p', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'bad key' }) }) }), /401.*bad key/);
    await assert.rejects(generateImage({ prompt: 'p', fetchImpl: async (u) => (u.startsWith('https://fal.run/') ? { ok: true, status: 200, json: async () => ({ images: [{ url: 'u' }], has_nsfw_concepts: [true] }) } : null) }), /flagged/);
    config.falKey = '';
    await assert.rejects(generateImage({ prompt: 'p', fetchImpl: fakeFetch }), /FAL_KEY/);
  } finally { config.falKey = ''; }
});

test('crop and atmosphere recipes are normalized: no target, no generation, an unsafe subject or too many all fall back honestly', async () => {
  const { design, manifest } = load();
  const s = slots(design);
  const [a, b, c] = s;
  a.recipe = { type: 'crop', sources: ['asset-001'], target: 'the red cup', reason: '' };
  b.recipe = { type: 'crop', sources: ['asset-001'], reason: '' }; // no target
  c.recipe = { type: 'atmosphere', sources: ['asset-001'], subject: 'ground coffee on slate', style: 'moody', reason: '' };
  const w1 = normalizeRecipes(design, manifest, { generation: false });
  assert.deepEqual([a.recipe.type, a.assignedAsset], ['crop', null], 'a crop waits to be built');
  assert.equal(b.recipe.type, 'needs-photo');
  assert.equal(c.recipe.type, 'needs-photo');
  assert.ok(w1.some((w) => /image generation is not available/.test(w)));
  c.recipe = { type: 'atmosphere', sources: [], subject: 'ground coffee on slate', style: 'moody', reason: '' };
  normalizeRecipes(design, manifest, { generation: true, names: ['Bean Bar'] });
  assert.deepEqual([c.recipe.type, c.recipe.sources, c.assignedAsset], ['atmosphere', [], null]);
  c.recipe = { type: 'atmosphere', sources: [], subject: 'a bottle of perfume', style: '', reason: '' };
  assert.ok(normalizeRecipes(design, manifest, { generation: true }).some((w) => /only comes from the customer's real photos/.test(w)));
  assert.equal(c.recipe.type, 'needs-photo');
  // a whole site may have only a few generated pictures
  const { MAX_ATMOSPHERE_PER_SITE: MAX } = await import('../src/lib/imageGen.js');
  const sections = design.pages[0].sections;
  while (slots(design).length < MAX + 1) sections[0].slots.push({ id: `extra-${slots(design).length}`, kind: 'image', description: 'x', aspect: '4:3', assignedAsset: null });
  const many = slots(design).slice(0, MAX + 1);
  for (const slot of many) slot.recipe = { type: 'atmosphere', sources: [], subject: 'dried petals on linen', style: '', reason: '' };
  const w2 = normalizeRecipes(design, manifest, { generation: true });
  assert.deepEqual(many.map((x) => x.recipe.type), [...Array(MAX).fill('atmosphere'), 'needs-photo']);
  assert.ok(w2.some((w) => new RegExp(`only ${MAX} generated pictures`).test(w)));
});

test('the whole step with crops and atmosphere (fake vision and fake image model): assets, approval states, cost, reuse of paid pictures', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const [crop, mood] = slots(design);
    crop.recipe = { type: 'crop', sources: ['asset-001'], target: 'the red cup', reason: 'one item' }; crop.aspect = '1:1';
    mood.recipe = { type: 'atmosphere', sources: [], subject: 'dried petals on linen', style: 'soft', reason: 'a quiet band' }; mood.aspect = '4:3';
    normalizeRecipes(design, manifest, { generation: true, names: [brief.business.name] });
    let generated = 0;
    const deps = {
      cropItem: async () => ({ buffer: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#112233' } }).jpeg().toBuffer(), width: 300, height: 300, region: {} }),
      generateImage: async () => { generated++; return { buffer: await sharp({ create: { width: 1152, height: 864, channels: 3, background: '#ddccbb' } }).jpeg().toBuffer(), width: 1152, height: 864, cost: 0.0119 }; },
    };
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(made, ['crop-1', 'atmo-1']);
    const c = manifest.assets.find((x) => x.id === 'crop-1');
    const m = manifest.assets.find((x) => x.id === 'atmo-1');
    assert.deepEqual([c.origin, c.derivedFrom, c.approval], ['crop', ['asset-001'], 'pending']);
    assert.deepEqual([m.origin, m.approval, m.derivedFrom], ['generated', 'pending', undefined]);
    assert.equal(crop.assignedAsset, 'crop-1');
    assert.equal(mood.assignedAsset, 'atmo-1');
    assert.equal(assetManifestSchema.safeParse(manifest).success, true);
    assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => /recipe|combined|generated/.test(n)), []);
    const logLines = fs.readFileSync(projectPath('p1', 'cost-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([logLines.length, logLines[0].provider, logLines[0].estimatedUsd], [1, 'fal', 0.0119]);
    // running again does not pay for the same mood picture twice
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(generated, 1, 'the paid picture is reused');
    // a crop that cannot be made cleanly falls back to a quiet block and the other slots are not affected
    const failing = { ...deps, cropItem: async () => ({ problem: 'the item was not found in the photo' }) };
    crop.recipe = { type: 'crop', sources: ['asset-001'], target: 'a unicorn', reason: '' };
    await composeImages({ projectId: 'p1', design, manifest, deps: failing });
    assert.deepEqual([crop.recipe.type, crop.assignedAsset], ['needs-photo', null]);
    assert.equal(mood.assignedAsset, 'atmo-1');
    // the check refuses an unsafe mood subject even if it got through
    mood.recipe.subject = 'a perfume bottle with a logo';
    assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('generated atmosphere pictures')));
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the image inventory counts what exists and tells the director whether generation is available', async () => {
  const { inventory, inventoryText } = await import('../src/stages/03-creative-director/inventory.js');
  const { brief, manifest } = load();
  manifest.assets[0].description = 'Four boxes in a row on a table'; manifest.assets[1].notes = 'Instagram counter (2/3) top right.';
  brief.offerings = [{ name: 'Sauvage', description: '', assetId: 'asset-001' }];
  config.falKey = '';
  const off = inventory(manifest, brief);
  assert.deepEqual([off.usable, off.low, off.groups, off.overlays, off.hasLogo, off.generation], [2, 1, 1, 1, true, false]);
  assert.match(inventoryText(off), /NOT available right now\. Do not plan any atmosphere slot/);
  assert.match(inventoryText(off), /asset-001: .*GROUP.*products confirmed by the owner: Sauvage/);
  assert.match(inventoryText(off), /asset-002: .*HAS OVERLAY/);
  config.falKey = 'x';
  try { assert.match(inventoryText(inventory(manifest, brief)), /AVAILABLE \(at most 4 on the whole site/); } finally { config.falKey = ''; }
});

test('the crop locator: the crop takes the frame shape, and it is refused when the item is missing, tiny or touches an overlay', async () => {
  const { fitBoxToAspect, cropProblem, cropItem } = await import('../src/lib/crop.js');
  const region = fitBoxToAspect({ x: 0.35, y: 0.3, width: 0.3, height: 0.35 }, 2000, 1500, '1:1');
  assert.ok(Math.abs(region.width / region.height - 1) < 0.02, 'a crop that needs little extra takes the shape of the frame');
  const narrow = fitBoxToAspect({ x: 0.4, y: 0.2, width: 0.1, height: 0.6 }, 2000, 1500, '16:9');
  assert.ok(narrow.width < 2000 * 0.1 * 1.5 && narrow.width / narrow.height < 0.7, 'a narrow item is NOT stretched wide: that would pull its neighbours into the picture');
  assert.ok(region.left >= 0 && region.top >= 0 && region.left + region.width <= 2000 && region.top + region.height <= 1500, 'and stays inside the photo');
  assert.match(cropProblem({ found: false }, {}, 2000, 1500), /not found/);
  assert.match(cropProblem({ found: true, box: { x: 0.4, y: 0.4, width: 0.05, height: 0.05 }, overlays: [] }, { left: 800, top: 600, width: 100, height: 100 }, 2000, 1500), /too small/);
  const touching = { found: true, box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 }, overlays: [{ x: 0.85, y: 0.02, width: 0.1, height: 0.06 }] };
  assert.match(cropProblem(touching, { left: 1000, top: 100, width: 800, height: 800 }, 2000, 1500), /counter, watermark or badge/);
  assert.equal(cropProblem({ ...touching, overlays: [{ x: 0.0, y: 0.0, width: 0.1, height: 0.06 }] }, { left: 1000, top: 300, width: 800, height: 800 }, 2000, 1500), '');
  // end to end with a fake locator on a real image file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-'));
  try {
    const file = path.join(tmp, 'p.jpg');
    await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#aa5533' } }).jpeg().toFile(file);
    const ok = async () => ({ mainSubjectIsTarget: true, otherWholeProductsVisible: 0, note: '' });
    const good = await cropItem({ file, target: 'x', aspect: '4:5', locate: async () => ({ found: true, box: { x: 0.4, y: 0.2, width: 0.2, height: 0.6 }, overlays: [] }), verify: ok });
    assert.ok(good.buffer && good.width / good.height > 0.5 && good.width / good.height < 0.9);
    const meta = await sharp(good.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [good.width, good.height]);
    const none = await cropItem({ file, target: 'x', locate: async () => ({ found: false, overlays: [] }) });
    assert.match(none.problem, /not found/);
    // the finished crop is checked: several products in it, or the wrong subject, means it is refused
    const found = async () => ({ found: true, box: { x: 0.4, y: 0.2, width: 0.2, height: 0.6 }, overlays: [] });
    const crowded = await cropItem({ file, target: 'the lotion', locate: found, verify: async () => ({ mainSubjectIsTarget: true, otherWholeProductsVisible: 2, note: '' }) });
    assert.match(crowded.problem, /also shows 2 other whole product/);
    const wrong = await cropItem({ file, target: 'the lotion', locate: found, verify: async () => ({ mainSubjectIsTarget: false, otherWholeProductsVisible: 0, note: 'it is a cup' }) });
    assert.match(wrong.problem, /does not clearly show/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('two crops of the same photo may not show the same area', async () => {
  const { overlapRatio } = await import('../src/lib/crop.js');
  const a = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(overlapRatio(a, { left: 200, top: 0, width: 100, height: 100 }), 0);
  assert.equal(overlapRatio(a, { left: 0, top: 0, width: 100, height: 100 }), 1);
  assert.ok(overlapRatio(a, { left: 50, top: 0, width: 100, height: 100 }) === 0.5);
  assert.equal(overlapRatio(a, {}), 0, 'unknown regions never block');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const m of manifest.assets) { m.file = `inputs/assets/${m.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', m.file)); }
    const [s1, s2] = slots(design);
    s1.recipe = { type: 'crop', sources: ['asset-001'], target: 'the lotion', reason: '' };
    s2.recipe = { type: 'crop', sources: ['asset-001'], target: 'the cream', reason: '' };
    normalizeRecipes(design, manifest);
    const region = { left: 100, top: 100, width: 300, height: 300 };
    const deps = { cropItem: async () => ({ buffer: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#112233' } }).jpeg().toBuffer(), width: 300, height: 300, region }) };
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(made, ['crop-1'], 'the second crop showed the same area, so it waits for a real photo');
    assert.deepEqual([s2.recipe.type, s2.assignedAsset], ['needs-photo', null]);
    void brief;
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
