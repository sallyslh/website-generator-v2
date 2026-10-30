// Tests for photo-shoot scenes: a generated set + the customer's real products standing on it (no network: all services are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { arrangeOnSurface, setProblem, composeScene, lookOf } from '../src/lib/scene.js';
import { setPrompt, propsPrompt } from '../src/lib/imageGen.js';
import { normalizeRecipes, composeImages } from '../src/stages/03-creative-director/compose.js';
import { checkDesign } from '../src/stages/03-creative-director/checks.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { flags as composeFlags } from '../src/stages/03-creative-director/compose.js';
composeFlags.collages = true; // this file tests the collage maker itself (collages are OFF in real projects)

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json') });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const slots = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));
const solid = (W, H, color) => sharp({ create: { width: W, height: H, channels: 3, background: color } }).jpeg().toBuffer();
const product = async (w, h, color = '#cc3344') => ({ buffer: await sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer(), width: w, height: h });

test('the generated set is judged: products, text, logos and a badly placed or too shallow surface are refused', () => {
  assert.equal(setProblem({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }), '');
  assert.match(setProblem({ horizon: 0.4, frontEdge: 1, hasProducts: true }), /something that looks like a product for sale/);
  assert.match(setProblem({ horizon: 0.4, frontEdge: 1, hasText: true }), /text or a logo/);
  assert.match(setProblem({ horizon: 0.4, frontEdge: 1, hasLogo: true }), /text or a logo/);
  assert.match(setProblem({ horizon: 0.05, frontEdge: 1 }), /badly placed/);
  assert.match(setProblem({ horizon: 0.5, frontEdge: 0.62 }), /too shallow/);
  assert.match(setPrompt({ scene: 'dark slate bar top in low morning light', mood: 'moody', colors: ['#112233'] }), /dark slate bar top.*tasteful decorative pieces.*vase.*candle.*nothing that looks like a product for sale.*no perfume or cosmetic bottles.*No text/);
  assert.ok(!/EMPTY|no decor/i.test(setPrompt({ scene: 'x y' })), 'the set is styled, not empty');
  assert.match(setPrompt({ scene: 'slate bar top', props: ['rose petals', 'lavender'] }), /lying loosely on the tabletop.*rose petals, lavender.*The middle of the table stays completely clear/);
  assert.ok(!/lying loosely/.test(setPrompt({ scene: 'slate bar top' })), 'no props, no scatter sentence');
  assert.match(propsPrompt(['roasted coffee beans', 'a curl of steam']), /roasted coffee beans, a curl of steam on a plain white seamless surface/);
});

test('products stand ON the surface: every base between the horizon and the front edge, the back row smaller, all inside the picture', () => {
  const items = [{ width: 400, height: 700 }, { width: 900, height: 500 }, { width: 300, height: 300 }];
  for (const [W, H, horizon, frontEdge] of [[1280, 1600, 0.36, 0.7], [1600, 900, 0.4, 1], [1280, 1600, 0.5, 1]]) {
    const p = arrangeOnSurface(items, W, H, horizon, frontEdge);
    for (const q of p) {
      assert.ok(q.baseline >= horizon * H && q.baseline <= frontEdge * H, `baseline ${q.baseline} on the surface`);
      assert.equal(q.top + q.height, q.baseline, 'the product stands on its baseline');
      assert.ok(q.left >= 0 && q.left + q.width <= W && q.top >= 0, 'inside the picture');
    }
  }
  const tall = arrangeOnSurface(items, 1280, 1600, 0.36, 1);
  assert.ok(tall[0].baseline < tall[2].baseline && tall[0].height < tall[2].height, 'the back row is higher and smaller');
  assert.equal(arrangeOnSurface([items[0]], 1280, 1600, 0.4, 1).length, 1);
});

test('a scene keeps the products\' own pixels and puts props in front of them; the look follows the set\'s light', async () => {
  const set = await solid(640, 800, '#335577');
  const red = await product(200, 400, '#ff0000');
  const props = await product(300, 200, '#ffff00');
  const out = await composeScene({ background: set, cutouts: [red], horizon: 0.3, frontEdge: 1, aspect: '4:5', props, look: { brightness: 1, warm: 1 } });
  assert.deepEqual([out.width, out.height], [1280, 1600]);
  const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const count = (test) => { let n = 0; for (let i = 0; i < raw.data.length; i += raw.info.channels) if (test(raw.data[i], raw.data[i + 1], raw.data[i + 2])) n++; return n; };
  assert.ok(count((r, g, b) => r > 230 && g < 40 && b < 40) > 5000, 'the real product is in the picture, unchanged');
  assert.ok(count((r, g, b) => r > 200 && g > 200 && b < 80) > 2000, 'props lie in the picture too');
  const dark = await lookOf(await solid(64, 64, '#202020'));
  const light = await lookOf(await solid(64, 64, '#f0e8e0'));
  assert.ok(dark.brightness < light.brightness && dark.brightness >= 0.8 && light.brightness <= 1.05);
  assert.ok((await lookOf(await solid(64, 64, '#c08040'))).warm > (await lookOf(await solid(64, 64, '#4080c0'))).warm, 'a warm set warms the products a little');
});

test('scene recipes: they need the image service and a safe description, otherwise the real photos are used', () => {
  const { design, manifest } = load();
  const s = slots(design);
  s[0].recipe = { type: 'scene', scene: 'dark slate bar top in low morning light', props: ['roasted coffee beans'], mood: 'moody', sources: ['asset-001', 'asset-002'], reason: '' };
  assert.deepEqual(normalizeRecipes(design, manifest, { generation: true, names: ['Cafe'] }), []);
  assert.deepEqual([s[0].recipe.type, s[0].assignedAsset], ['scene', null], 'waits to be built');
  assert.ok(normalizeRecipes(design, manifest, { generation: false }).some((w) => /no scene \(image generation is not available\)/.test(w)));
  assert.equal(s[0].recipe.type, 'collage', 'two real photos become a collage');
  s[0].recipe = { type: 'scene', scene: 'a table with a perfume bottle and a box', props: [], sources: ['asset-001'], reason: '' };
  assert.ok(normalizeRecipes(design, manifest, { generation: true }).some((w) => /only comes from the customer's real photos/.test(w)));
  assert.deepEqual([s[0].recipe.type, s[0].assignedAsset], ['use', 'asset-001']);
  s[0].recipe = { type: 'scene', scene: 'the logo of the shop on a sign', props: [], sources: [], reason: '' };
  normalizeRecipes(design, manifest, { generation: true });
  assert.equal(s[0].recipe.type, 'needs-photo');
  s[0].recipe = { type: 'scene', props: [], sources: [], reason: '' }; // not described
  assert.ok(normalizeRecipes(design, manifest, { generation: true }).some((w) => /not described/.test(w)));
  // props given as one text instead of a list are accepted by the schema
  const s2 = load();
  slots(s2.design)[0].recipe = { type: 'scene', scene: 'slate bar top', props: 'beans', sources: [], reason: '' };
  return import('../src/schemas/designSpec.js').then(({ designSpecSchema }) => assert.deepEqual(slots(designSpecSchema.parse(s2.design))[0].recipe.props, ['beans']));
});

test('the whole scene step: the first generated set is refused and replaced, the surface is used, costs are logged, paid pictures are cached', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = slots(design)[0];
    Object.assign(hero, { aspect: '4:5', preferredCategory: manifest.assets[0].category });
    hero.recipe = { type: 'scene', scene: 'pale pink linen tabletop by a sunny window, white blossoms blurred behind', props: ['loose flower petals'], mood: 'airy, soft', sources: ['asset-001', 'asset-002'], reason: 'the range, in the shop\'s own world' };
    normalizeRecipes(design, manifest, { generation: true, names: [brief.business.name] });
    const calls = { generate: 0, inspect: 0, cut: 0 };
    const deps = {
      generateImage: async () => { calls.generate++; return { buffer: await solid(1024, 1280, '#e8c8c8'), width: 1024, height: 1280, cost: 0.012 }; },
      inspectSet: async () => { calls.inspect++; return calls.inspect === 1 ? { horizon: 0.4, frontEdge: 1, hasProducts: true, hasText: false, hasLogo: false } : { horizon: 0.4, frontEdge: 0.95, hasProducts: false, hasText: false, hasLogo: false }; },
      removeBackground: async () => { calls.cut++; const t = await product(300, 500); return { ...t, cutOff: false, cost: 0.01 }; },
    };
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(made, ['scene-1']);
    assert.deepEqual(calls, { generate: 2, inspect: 2, cut: 2 }, 'the set twice (the first was refused; the props are drawn inside it); the two products were cut out');
    const sc = manifest.assets.find((a) => a.id === 'scene-1');
    assert.deepEqual([sc.origin, sc.approval, sc.derivedFrom], ['generated', 'pending', ['asset-001', 'asset-002']]);
    assert.equal(hero.assignedAsset, 'scene-1');
    assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => /recipe|combined|generated/.test(n)), []);
    const costLog = fs.readFileSync(projectPath('p1', 'cost-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(costLog.length, 4, 'every paid call is logged');
    assert.ok(costLog.every((c) => c.provider === 'fal' && c.estimatedUsd > 0));
    // the same scene again costs nothing: set, props and product cut-outs are reused
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(calls, { generate: 2, inspect: 2, cut: 2 });
    // the customer's decision on the same scene stays
    manifest.assets.find((a) => a.id === 'scene-1').approval = 'approved';
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(manifest.assets.find((a) => a.id === 'scene-1').approval, 'approved');
    // a set that is refused three times: the real photos become a collage, never an empty frame
    hero.recipe = { type: 'scene', scene: 'a different set', props: [], mood: '', sources: ['asset-001', 'asset-002'], reason: '' };
    const refusing = { ...deps, inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: true, hasLogo: false }) };
    await composeImages({ projectId: 'p1', design, manifest, deps: refusing });
    assert.equal(hero.recipe.type, 'collage');
    assert.deepEqual(manifest.assets.find((a) => a.id === hero.assignedAsset).derivedFrom, ['asset-001', 'asset-002']);
    // the check refuses an unsafe scene description even if it got through
    hero.recipe = { type: 'scene', scene: 'a perfume bottle on a table', props: [], sources: [], reason: '' };
    assert.ok(failed(checkDesign(design, brief, manifest)).length > 0);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the second attempt at a set insists on a wide, deep table (the first one was a shelf)', () => {
  const normal = setPrompt({ scene: 'linen shelf by a window' });
  const strict = setPrompt({ scene: 'linen shelf by a window', strict: true });
  assert.ok(!/VERY IMPORTANT/.test(normal));
  assert.match(strict, /VERY IMPORTANT: show a WIDE, DEEP, flat table top/);
  assert.match(strict, /not a shelf, a windowsill or a narrow ledge/);
});

test('props are loose small materials (no cloth), and they lie on the surface, never on the hanging cloth below its front edge', async () => {
  const { usableProps } = await import('../src/lib/imageGen.js');
  assert.deepEqual(usableProps(['pink petals', ' folded linen ', 'pink petals', '', 'dried wildflowers', 'a ribbon', 'coffee beans']), ['pink petals', 'folded linen', 'dried wildflowers', 'a ribbon'], 'trimmed, no repeats, at most 4; cloth and ribbon are fine now that props are drawn with the set');
  const set = await solid(640, 800, '#335577');
  const marker = await product(200, 200, '#ffff00');
  const horizon0 = 0.4; const frontEdge0 = 0.7;
  const keep = frontEdge0 + 0.04; // the set is zoomed to its useful part, so the surface moves in the new frame
  const horizon = horizon0 / keep; const frontEdge = frontEdge0 / keep;
  const out = await composeScene({ background: set, cutouts: [], horizon: horizon0, frontEdge: frontEdge0, aspect: '4:5', props: marker, look: {} });
  const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  let lowest = 0; let highest = raw.info.height;
  for (let y = 0; y < raw.info.height; y++) for (let x = 0; x < raw.info.width; x++) {
    const i = (y * raw.info.width + x) * raw.info.channels;
    if (raw.data[i] > 220 && raw.data[i + 1] > 220 && raw.data[i + 2] < 90) { lowest = Math.max(lowest, y); highest = Math.min(highest, y); }
  }
  assert.ok(lowest <= frontEdge * raw.info.height, `props end at ${lowest}px, the front edge is at ${frontEdge * raw.info.height}px`);
  assert.ok(highest >= horizon * raw.info.height * 0.9, 'and they are on the surface, not in the backdrop');
  const single = arrangeOnSurface([{ width: 400, height: 700 }], 1280, 1600, 0.4, 0.8)[0];
  const crowd = arrangeOnSurface([{ width: 400, height: 700 }, { width: 400, height: 700 }, { width: 400, height: 700 }], 1280, 1600, 0.4, 0.8)[2];
  assert.ok(single.height > crowd.height, 'a lone product is shown larger than one in a crowd');
});

test('the set is zoomed to its useful part: same picture size, the products stand in the middle, the hanging cloth is gone', async () => {
  // a set whose top half is blue (wall), then a green table up to 70% and a red "hanging cloth" below it
  const W = 640; const H = 800;
  const top = await sharp({ create: { width: W, height: Math.round(H * 0.4), channels: 3, background: '#0000ff' } }).png().toBuffer();
  const table = await sharp({ create: { width: W, height: Math.round(H * 0.3), channels: 3, background: '#00ff00' } }).png().toBuffer();
  const cloth = await sharp({ create: { width: W, height: H - Math.round(H * 0.4) - Math.round(H * 0.3), channels: 3, background: '#ff0000' } }).png().toBuffer();
  const set = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } }).composite([{ input: top, top: 0, left: 0 }, { input: table, top: Math.round(H * 0.4), left: 0 }, { input: cloth, top: Math.round(H * 0.7), left: 0 }]).jpeg({ quality: 95 }).toBuffer();
  const out = await composeScene({ background: set, cutouts: [], horizon: 0.4, frontEdge: 0.7, aspect: '4:5' });
  assert.deepEqual([out.width, out.height], [1280, 1600]);
  const raw = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let y = 0; y < raw.info.height; y++) for (let x = 0; x < raw.info.width; x += 4) { const i = (y * raw.info.width + x) * raw.info.channels; if (raw.data[i] > 200 && raw.data[i + 1] < 60 && raw.data[i + 2] < 60) red++; }
  assert.ok(red < 0.08 * raw.info.height * raw.info.width / 4, 'only a thin strip of the hanging cloth is left in the picture (was 30%)');
});

test('a scene built for one frame shape is rebuilt for the frame Stitch really drew (cached pieces, no new cost)', async () => {
  const { fitCollages } = await import('../src/stages/05-design-stitch/fitCollages.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscene-'));
  setProjectsRoot(tmp);
  try {
    const { brief, manifest, design } = load();
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = slots(design)[0];
    Object.assign(hero, { aspect: '4:5', preferredCategory: manifest.assets[0].category });
    hero.recipe = { type: 'scene', scene: 'pale linen table by a window', props: [], mood: 'soft', sources: ['asset-001'], reason: '' };
    normalizeRecipes(design, manifest, { generation: true, names: [brief.business.name] });
    let paid = 0;
    const deps = {
      generateImage: async () => { paid++; return { buffer: await solid(1024, 1280, '#e8c8c8'), width: 1024, height: 1280, cost: 0.012 }; },
      inspectSet: async () => ({ horizon: 0.4, frontEdge: 0.9, hasProducts: false, hasText: false, hasLogo: false }),
      removeBackground: async () => { paid++; return { ...(await product(300, 500)), cutOff: false, cost: 0.01 }; },
    };
    await composeImages({ projectId: 'p1', design, manifest, deps });
    const first = manifest.assets.find((a) => a.id === hero.assignedAsset);
    assert.ok(first.height > first.width, 'built for a tall 4:5 frame');
    const paidBefore = paid;
    fs.writeFileSync(projectPath('p1', 'design-spec.json'), JSON.stringify(design));
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    fs.mkdirSync(projectPath('p1', 'design'), { recursive: true });
    fs.writeFileSync(projectPath('p1', 'design/home.html'), `<div class="aspect-[4/3]"><img alt="${hero.id}" class="hidden" src="x"/></div>`); // Stitch drew a WIDE frame
    // the rebuild uses the real services only through their caches: nothing may be paid for again
    const rebuilt = await fitCollages('p1');
    assert.deepEqual(rebuilt, [hero.id]);
    assert.equal(paid, paidBefore, 'nothing new was paid for');
    const updated = JSON.parse(fs.readFileSync(projectPath('p1', 'asset-manifest.json'), 'utf8')).assets.find((a) => a.id === hero.assignedAsset || a.origin === 'generated');
    assert.ok(updated.width > updated.height, 'now a wide picture for the wide frame');
    assert.equal(JSON.parse(fs.readFileSync(projectPath('p1', 'design-spec.json'), 'utf8')).pages[0].sections[0].slots[0].aspect, '4:3');
    assert.deepEqual(await fitCollages('p1'), [], 'a picture that already fits is left alone');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('pictures that do not fit the frame they are shown in are found from the rendered page', async () => {
  const { pictureMisfits } = await import('../src/lib/measureFrames.js');
  const { aspectOf } = await import('../src/stages/05-design-stitch/prompts.js');
  const { design } = load();
  const [hero, other] = slots(design);
  const assets = [
    { id: 'scene-1', origin: 'generated', width: 1024, height: 1280 },   // built tall (4:5)
    { id: 'asset-002', origin: undefined, width: 800, height: 600 },    // a real photo is never rebuilt
  ];
  hero.assignedAsset = 'scene-1'; other.assignedAsset = 'asset-002';
  const rendered = [{ route: '/', images: [{ src: '/images/scene-1.webp', width: 640, height: 580 }, { src: '/images/asset-002.webp', width: 100, height: 500 }] }];
  const found = pictureMisfits({ assets, design, rendered, aspectOf });
  assert.deepEqual(found.map((f) => [f.slotId, f.assetId, f.frame]), [[hero.id, 'scene-1', '1:1']], 'the wide frame is found, the real photo is ignored');
  assert.deepEqual(pictureMisfits({ assets, design, rendered: [{ route: '/', images: [{ src: '/images/scene-1.webp', width: 464, height: 580 }] }], aspectOf }), [], 'a picture that fits is left alone');
  assert.deepEqual(pictureMisfits({ assets, design, rendered: null, aspectOf }), [], 'no measurement, nothing to do');
  const band = pictureMisfits({ assets, design, rendered: [{ route: '/', images: [{ src: '/images/scene-1.webp', width: 1136, height: 337 }] }], aspectOf });
  assert.equal(band[0].frame, '3.37:1', 'a very wide text band keeps its exact shape (16:9 would be a worse fit than what exists)');
});

test('after the build the pages are measured and mismatching pictures are rebuilt; without a browser nothing breaks', async () => {
  const { refitToRenderedFrames } = await import('../src/stages/07-site/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refit-'));
  setProjectsRoot(tmp);
  try {
    const { manifest, design } = load();
    const hero = slots(design)[0];
    hero.recipe = { type: 'scene', scene: 'x', props: [], mood: '', sources: [], reason: '' }; hero.aspect = '4:5'; hero.assignedAsset = 'scene-1';
    manifest.assets.push({ ...manifest.assets[0], id: 'scene-1', origin: 'generated', width: 1024, height: 1280, derivedFrom: undefined });
    fs.mkdirSync(projectPath('p1', 'site/dist'), { recursive: true });
    fs.writeFileSync(projectPath('p1', 'design-spec.json'), JSON.stringify(design));
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    assert.deepEqual(await refitToRenderedFrames('p1', ['/'], { measure: async () => null }), [], 'no browser: skipped');
    let rebuiltSlots = null;
    const measure = async () => [{ route: '/', images: [{ src: '/images/scene-1.webp', width: 1000, height: 560 }] }];
    const compose = async ({ only, design: d }) => { rebuiltSlots = only; assert.equal(slots(d).find((s) => s.id === only[0]).aspect, '16:9'); };
    const done = await refitToRenderedFrames('p1', ['/'], { measure, compose });
    assert.deepEqual(rebuiltSlots, [hero.id]);
    assert.deepEqual(done.map((d) => d.frame), ['16:9']);
    assert.equal(JSON.parse(fs.readFileSync(projectPath('p1', 'design-spec.json'), 'utf8')).pages[0].sections[0].slots[0].aspect, '16:9', 'the new frame shape is saved');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
