// Tests for the image plan: recipes (use / collage / needs-photo), the collage maker and the checks. No API calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { normalizeRecipes, composeImages } from '../src/stages/03-creative-director/compose.js';
import { checkDesign } from '../src/stages/03-creative-director/checks.js';
import { cells, sizeFor, composeCollage } from '../src/lib/collage.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { designSpecSchema } from '../src/schemas/designSpec.js';
import { assetManifestSchema } from '../src/schemas/assetManifest.js';
import { flags as composeFlags } from '../src/stages/03-creative-director/compose.js';
composeFlags.collages = true; // this file tests the collage maker itself (collages are OFF in real projects)

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json') });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const slots = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));

test('the schemas accept a plan with recipes and a combined asset', () => {
  const { design, manifest } = load();
  slots(design)[0].recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], layout: 'row', reason: 'two dishes together' };
  assert.equal(designSpecSchema.safeParse(design).success, true);
  manifest.assets.push({ ...manifest.assets[0], id: 'combo-1', derivedFrom: ['asset-001', 'asset-002'], approval: 'pending' });
  assert.equal(assetManifestSchema.safeParse(manifest).success, true);
  slots(design)[0].recipe.type = 'magic';
  assert.equal(designSpecSchema.safeParse(design).success, false);
});

test('recipes never claim more than exists: bad collages fall back, needs-photo is empty, use names its photo', () => {
  const { design, manifest } = load();
  const [a, b, c] = slots(design);
  a.recipe = { type: 'collage', sources: ['asset-001'], reason: '' }; // only one photo: becomes "use"
  b.recipe = { type: 'collage', sources: ['asset-001', 'asset-003'], reason: '' }; // asset-003 is low quality: becomes "use" of asset-001
  c.recipe = { type: 'needs-photo', sources: ['asset-001'], reason: '' }; c.assignedAsset = 'asset-001';
  const warnings = normalizeRecipes(design, manifest);
  assert.equal(warnings.length, 3); // a: one photo only; b: the low photo is dropped, then only one is left
  assert.deepEqual([a.recipe.type, a.assignedAsset], ['use', 'asset-001']);
  assert.deepEqual([b.recipe.type, b.assignedAsset], ['use', 'asset-001']);
  assert.deepEqual([c.recipe.type, c.assignedAsset, c.recipe.sources], ['needs-photo', null, []]);
  const real = load();
  slots(real.design)[0].recipe = { type: 'collage', sources: ['asset-001', 'asset-002', 'asset-001'], reason: '' };
  assert.deepEqual(normalizeRecipes(real.design, real.manifest), []);
  assert.deepEqual([slots(real.design)[0].recipe.layout, slots(real.design)[0].assignedAsset], ['row', null]);
  const logo = load();
  slots(logo.design)[0].recipe = { type: 'use', sources: [logo.manifest.logo], reason: '' };
  normalizeRecipes(logo.design, logo.manifest);
  assert.notEqual(slots(logo.design)[0].assignedAsset, logo.manifest.logo, 'the logo is never a photo');
});

test('collage layout: cells fit the picture, the last row is centered', () => {
  const [w, h] = [800, 600];
  for (const [n, layout] of [[2, 'row'], [3, 'row'], [4, 'grid'], [5, 'grid'], [6, 'grid']]) {
    const rects = cells(n, layout, w, h, 16);
    assert.equal(rects.length, n);
    for (const r of rects) assert.ok(r.left >= 16 && r.top >= 16 && r.left + r.width <= w - 16 + 1 && r.top + r.height <= h - 16 + 1, `${layout} ${n}: ${JSON.stringify(r)}`);
  }
  const five = cells(5, 'grid', w, h, 16);
  assert.ok(five[3].left > five[0].left, 'two photos in the last row of three columns are centered');
  assert.deepEqual(sizeFor('4:5', 1000), { width: 800, height: 1000 });
  assert.deepEqual(sizeFor('16:9', 1600), { width: 1600, height: 900 });
});

const solid = async (file, color, width = 300, height = 400) => { await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(file); };

test('a collage is built from the real files: right size, every photo visible, nothing else added', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collage-'));
  try {
    const files = ['#ff0000', '#00ff00', '#0000ff'].map((c, i) => path.join(tmp, `p${i}.jpg`));
    await Promise.all(files.map((f, i) => solid(f, ['#ff0000', '#00ff00', '#0000ff'][i])));
    const { buffer, width, height } = await composeCollage({ files, layout: 'row', aspect: '16:9', background: '#ffffff' });
    assert.deepEqual([width, height], [1600, 900]);
    const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => [...raw.data.subarray((y * raw.info.width + x) * raw.info.channels, (y * raw.info.width + x) * raw.info.channels + 3)];
    const [r, g, b] = [px(300, 450), px(800, 450), px(1300, 450)];
    assert.ok(r[0] > 200 && r[1] < 60, 'left photo is red'); assert.ok(g[1] > 200 && g[0] < 60, 'middle photo is green'); assert.ok(b[2] > 200 && b[0] < 60, 'right photo is blue');
    assert.ok(px(5, 5).every((v) => v > 240), 'the gap is the background color');
    await assert.rejects(composeCollage({ files: [files[0]] }), /at least 2/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the whole step: a collage slot becomes a combined asset that remembers its photos, and passes the checks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await solid(projectPath('p1', a.file), '#aa5533'); }
    const hero = slots(design)[0];
    hero.recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], reason: 'two dishes side by side' };
    hero.aspect = '16:9'; hero.preferredCategory = manifest.assets.find((a) => a.id === 'asset-001').category;
    normalizeRecipes(design, manifest);
    const made = await composeImages({ projectId: 'p1', design, manifest });
    assert.deepEqual(made, ['combo-1']);
    assert.equal(hero.assignedAsset, 'combo-1');
    const combo = manifest.assets.find((a) => a.id === 'combo-1');
    assert.deepEqual(combo.derivedFrom, ['asset-001', 'asset-002']);
    assert.equal(combo.approval, 'pending');
    assert.ok(fs.existsSync(projectPath('p1', combo.file)));
    assert.equal(combo.orientation, 'landscape');
    assert.equal(assetManifestSchema.safeParse(manifest).success, true);
    assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => /recipe|combined/.test(n)), []);
    // running it again rebuilds instead of piling up
    const again = await composeImages({ projectId: 'p1', design, manifest });
    assert.deepEqual(again, ['combo-1']);
    assert.equal(manifest.assets.filter((a) => a.id.startsWith('combo-')).length, 1);
    // a combined picture that claims other photos than it was built from is caught
    manifest.assets.find((a) => a.id === 'combo-1').derivedFrom = ['asset-001', 'asset-004'];
    assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('combined pictures')));
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the checks catch recipes that do not match the plan', () => {
  const { brief, manifest, design } = load();
  const [a, b] = slots(design);
  delete a.recipe;
  b.recipe = { type: 'needs-photo', sources: [], reason: '' }; // but it has an assigned photo
  const names = failed(checkDesign(design, brief, manifest));
  assert.ok(names.some((n) => n.includes('recipe')));
});

test('photos with a counter, watermark or overlay are never put into a collage (they would stay visible)', () => {
  const { brief, manifest, design } = load();
  manifest.assets[1].notes = 'Instagram slideshow counter (2/3) at the top right.';
  const hero = slots(design)[0];
  hero.recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], reason: '' };
  const warnings = normalizeRecipes(design, manifest);
  assert.match(warnings[0], /asset-002 not used in the collage/);
  assert.deepEqual([hero.recipe.type, hero.assignedAsset], ['use', 'asset-001']);
  // and the check catches a combined picture that was built from such a photo anyway
  const bad = load();
  const s0 = slots(bad.design)[0];
  s0.recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], layout: 'row', reason: '' }; s0.assignedAsset = 'combo-1';
  bad.manifest.assets[1].notes = 'Watermark in the corner.';
  bad.manifest.assets.push({ ...bad.manifest.assets[0], id: 'combo-1', derivedFrom: ['asset-001', 'asset-002'], approval: 'pending' });
  assert.ok(failed(checkDesign(bad.design, bad.brief, bad.manifest)).some((n) => n.includes('combined pictures')));
});

test('a model that leaves the collage layout empty or copies a placeholder is accepted (layout simply not set)', () => {
  for (const layout of ['', null, 'row | grid (collage only)', 'diagonal']) {
    const { design } = load();
    slots(design)[0].recipe = { type: 'use', sources: ['asset-001'], layout, reason: 'x' };
    const parsed = designSpecSchema.safeParse(design);
    assert.equal(parsed.success, true, `layout ${JSON.stringify(layout)}`);
    assert.equal(slots(parsed.data)[0].recipe.layout, undefined);
  }
  const { design } = load();
  slots(design)[0].recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], layout: 'grid', reason: '' };
  assert.equal(slots(designSpecSchema.parse(design))[0].recipe.layout, 'grid');
});

test('frame shape is read from Stitch\'s aspect class, and a collage gets the arrangement that suits it', async () => {
  const { frameAspect, clearDrawnFrames } = await import('../src/lib/frames.js');
  const { bestLayout } = await import('../src/lib/collage.js');
  const html = '<div class="relative aspect-[4/5] x"><img alt="a"/></div><div class="aspect-square"><img alt="b"/></div><div class="aspect-video"><img alt="c"/></div><div class="plain"><img alt="d"/></div>';
  assert.equal(frameAspect(html, html.indexOf('alt="a"')), '4:5');
  assert.equal(frameAspect(html, html.indexOf('alt="b"')), '1:1');
  assert.equal(frameAspect(html, html.indexOf('alt="c"')), '16:9');
  assert.deepEqual([bestLayout(3, '16:9'), bestLayout(3, '4:5'), bestLayout(3, '1:1'), bestLayout(6, '16:9')], ['row', 'column', 'grid', 'grid']);
  assert.equal(cells(3, 'column', 800, 1000, 16).every((r, i, all) => r.left === all[0].left && (i === 0 || r.top > all[i - 1].top)), true, 'a column stacks the photos');
  // drawn product icons in frames go, big decorative shapes (the signature line) and drawings outside frames stay
  const page = '<div class="aspect-[4/5]"><svg width="44" height="66"><rect/></svg><svg viewBox="0 0 400 300" class="absolute w-full"><path/></svg></div><div class="nav"><svg width="24"><path/></svg></div>';
  const cleaned = clearDrawnFrames(page);
  assert.ok(!cleaned.includes('width="44"') && cleaned.includes('viewBox="0 0 400 300"') && cleaned.includes('<div class="nav"><svg width="24">'));
});

test('a collage is rebuilt in the shape of the frame Stitch drew (so the whole collage shows, not only its middle photo)', async () => {
  const { fitCollages } = await import('../src/stages/05-design-stitch/fitCollages.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-'));
  setProjectsRoot(tmp);
  try {
    const { manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 300, height: 400, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = slots(design)[0];
    hero.recipe = { type: 'collage', sources: ['asset-001', 'asset-002'], reason: 'x' }; hero.aspect = '16:9';
    normalizeRecipes(design, manifest);
    await composeImages({ projectId: 'p1', design, manifest });
    fs.writeFileSync(projectPath('p1', 'design-spec.json'), JSON.stringify(design));
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    assert.equal(manifest.assets.find((a) => a.id === 'combo-1').orientation, 'landscape');
    fs.mkdirSync(projectPath('p1', 'design'), { recursive: true });
    fs.writeFileSync(projectPath('p1', 'design/home.html'), `<div class="aspect-[4/5]"><img alt="${hero.id}" class="hidden" src="x"/></div>`);
    assert.deepEqual(await fitCollages('p1'), [hero.id]);
    const after = JSON.parse(fs.readFileSync(projectPath('p1', 'asset-manifest.json'), 'utf8')).assets.find((a) => a.id === 'combo-1');
    assert.equal(after.orientation, 'portrait');
    assert.ok(after.height > after.width);
    const meta = await sharp(projectPath('p1', after.file)).metadata();
    assert.deepEqual([meta.width, meta.height], [after.width, after.height]);
    assert.deepEqual(await fitCollages('p1'), [], 'a collage that already fits is left alone');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
