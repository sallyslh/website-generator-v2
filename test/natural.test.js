// Tests for natural photo shoots (no network: the editing model and the vision comparison are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { naturalPrompt, naturalRun, checkSummary, NATURAL_SIZES } from '../src/lib/natural.js';
import { labRun, labHistory } from '../src/lib/imageLab.js';
import { aiGenerate } from '../src/lib/aiEdit.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const solid = (color) => sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg().toBuffer();

async function withProject(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-'));
  setProjectsRoot(tmp);
  try {
    const manifest = read('asset-manifest.json');
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(projectPath('p1', 'site-brief.json'), JSON.stringify(read('site-brief.json')));
    await fn();
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('the prompt is plain: the owner\'s own words, the product kept as photographed, nothing hard-coded about tables or props', () => {
  const p = naturalPrompt({ request: 'on a dark walnut table, warm amber light, dried petals', count: 1 });
  assert.match(p, /professional commercial photo shoot of the product shown in the reference photo/);
  assert.match(p, /on a dark walnut table, warm amber light, dried petals/);
  assert.match(p, /exactly as in the photo: the same shape, colors, design and all of its printed text/);
  assert.match(naturalPrompt({ request: 'x', count: 3 }), /the products shown in the reference photos.*each product/s);
  assert.ok(!/cut|paste|empty/i.test(p));
  assert.deepEqual(NATURAL_SIZES['4:3'], [1600, 1216]);
});

test('two variants are made, each is compared with the real photo, and the more faithful one is kept', async () => {
  await withProject(async () => {
    const edits = []; let judged = 0;
    const colors = ['#112233', '#445566'];
    const editImage = async ({ images, prompt, width, height }) => { edits.push({ n: images.length, width, height, prompt }); return { buffer: await solid(colors[edits.length - 1]), width, height, cost: 0.04 }; };
    const verdicts = [{ score: 6, mainTextMatches: true, differences: ['small print differs'], extraProducts: false }, { score: 9.5, mainTextMatches: true, differences: [], extraProducts: false }];
    const compareFidelity = async ({ photos, picture }) => { assert.equal(photos.length, 1); assert.ok(Buffer.isBuffer(picture)); return verdicts[judged++]; };
    const out = await naturalRun({ projectId: 'p1', request: 'soft light on marble', products: ['asset-001'], aspect: '4:3', deps: { editImage, compareFidelity } });
    assert.equal(edits.length, 2);
    assert.deepEqual([edits[0].n, edits[0].width, edits[0].height], [1, 1600, 1216]);
    assert.equal(out.check.score, 9.5, 'the better variant wins');
    assert.equal(out.summary, 'Your product and its text match your photo.');
    assert.equal(out.costUsd, 0.08);
    const stat = await sharp(out.buffer).stats();
    assert.ok(Math.abs(stat.channels[0].mean - 0x44) < 6, 'the second picture (0x44) was kept');
  });
});

test('another product in the picture counts against it; an unreadable verdict is the worst; the summary says what to look at', async () => {
  await withProject(async () => {
    let i = 0;
    const editImage = async () => ({ buffer: await solid(i++ ? '#222222' : '#dddddd'), width: 640, height: 480, cost: 0.04 });
    // the bright picture gets a verdict (a perfect score, but with another product in it); for the dark one the vision service is down
    const compareFidelity = async ({ picture }) => { if ((await sharp(picture).stats()).channels[0].mean > 128) return { score: 10, mainTextMatches: true, differences: [], extraProducts: true }; throw new Error('vision down'); };
    const out = await naturalRun({ projectId: 'p1', request: 'soft light', products: ['asset-001'], deps: { editImage, compareFidelity } });
    assert.equal(out.check.extraProducts, true, 'a perfect score with an extra product still beats nothing at all');
  });
  assert.match(checkSummary({ score: 7, mainTextMatches: true, differences: ['BORN IN ROMA reads BORH IN ROMA'], extraProducts: false }), /names on your product match your photo, but some small print differs \(BORN IN ROMA reads BORH IN ROMA\)/);
  assert.match(checkSummary({ score: 3, mainTextMatches: false, differences: ['Burberry is printed twice'], extraProducts: false }), /Some text on your product looks different.*Burberry is printed twice.*trying again/);
  assert.match(checkSummary({ score: 10, mainTextMatches: true, differences: [], extraProducts: true }), /Another product appeared/);
  assert.match(checkSummary({ score: 6, mainTextMatches: true, differences: [], extraProducts: false, missingProducts: 2 }), /2 of your products are missing from the picture/);
  assert.match(checkSummary({ score: 6, mainTextMatches: true, differences: [], extraProducts: false, missingProducts: 1 }), /One of your products is missing/);
  assert.ok(checkSummary({ score: 7, mainTextMatches: true, differences: ['x'.repeat(300)], extraProducts: false, missingProducts: 0 }).length < 260, 'long findings are shortened');
  assert.equal(checkSummary(null), '');
});

test('natural mode refuses nothing about the photo: a photo of cut boxes goes straight to the model; bad ids and too many products are explained', async () => {
  await withProject(async () => {
    let called = 0;
    const deps = { editImage: async () => { called++; return { buffer: await solid('#888888'), width: 640, height: 480, cost: 0.04 }; }, compareFidelity: async () => ({ score: 9, mainTextMatches: true, differences: [], extraProducts: false }) };
    await assert.rejects(naturalRun({ projectId: 'p1', request: 'x y z', products: ['asset-003'], deps }), /not usable photos/);
    await assert.rejects(naturalRun({ projectId: 'p1', request: 'x y z', products: [], deps }), /At most 3/);
    await assert.rejects(naturalRun({ projectId: 'p1', request: 'x y z', products: ['asset-001', 'asset-002', 'a', 'b'], deps }), /At most 3/);
    assert.equal(called, 0, 'refusals spend nothing');
  });
});

test('in the lab and in the customer\'s editor, natural is the default and exact is still there', async () => {
  await withProject(async () => {
    let edits = 0; let exactAsked = 0; let compared = 0;
    const deps = {
      generation: true,
      verifyRealism: async () => '',
      editImage: async () => { edits++; return { buffer: await solid('#999999'), width: 640, height: 480, cost: 0.04 }; },
      compareFidelity: async () => { compared++; return { score: 7, mainTextMatches: true, differences: ['small print differs'], extraProducts: false }; },
      generateImage: async () => { exactAsked++; return { buffer: await solid('#e8c8c8'), width: 1024, height: 1280, cost: 0.012 }; },
      inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }),
      removeBackground: async () => ({ buffer: await sharp({ create: { width: 300, height: 500, channels: 4, background: '#cc3344' } }).png().toBuffer(), width: 300, height: 500, cutOff: false, cost: 0.01 }),
      askJson: async ({ prompt }) => ({ scene: prompt.split('DESCRIPTION: ')[1].trim(), props: [], mood: '' }),
    };
    // the team's lab
    const lab = await labRun({ projectId: 'p1', scene: 'a dark walnut table in warm amber light', props: ['dried petals'], mood: 'moody', products: ['asset-001'], aspect: '4:3', deps });
    assert.equal(lab.mode, 'natural');
    assert.match(lab.summary, /small print differs/);
    assert.equal(edits, 2);
    assert.equal(exactAsked, 0, 'no set, no cut-out, no inspector in natural mode');
    assert.equal(labHistory('p1')[0].mode, 'natural');
    // the lab can still ask for the exact way
    const exact = await labRun({ projectId: 'p1', scene: 'pale pink linen tabletop by a sunny window', products: ['asset-001'], aspect: '4:3', mode: 'exact', deps });
    assert.ok(exactAsked > 0 && exact.mode === undefined);
    // the customer's editor
    const natural = await aiGenerate('p1', { scene: 'my box on a marble table with roses, soft light', products: ['asset-001'], ratio: 1.33, deps });
    assert.equal(natural.mode, 'natural');
    assert.match(natural.summary, /small print differs/);
    assert.ok(fs.existsSync(projectPath('p1', 'edits/ai', natural.file)));
    const before = compared;
    const exactCustomer = await aiGenerate('p1', { scene: 'a marble table with roses, soft light', products: ['asset-001'], ratio: 1.33, mode: 'exact', deps });
    assert.equal(exactCustomer.mode, 'exact');
    assert.equal(compared, before, 'exact mode does not use the natural path (no comparison with the photo)');
    // no product ticked: the picture is a setting only, made the exact way
    const mood = await aiGenerate('p1', { scene: 'a marble table with roses, soft light', products: [], ratio: 1.33, deps });
    assert.equal(mood.mode, 'exact');
  });
});

test('a website scene with products is made the natural way when the comparison with the real photo is good, otherwise the exact method runs; a rebuild never pays twice', async () => {
  const { normalizeRecipes, composeImages } = await import('../src/stages/03-creative-director/compose.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-site-'));
  setProjectsRoot(tmp);
  try {
    const manifest = read('asset-manifest.json'); const design = read('design-spec.json');
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    const hero = design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots))[0];
    Object.assign(hero, { aspect: '16:9', preferredCategory: manifest.assets[0].category });
    hero.recipe = { type: 'scene', scene: 'a wide pale marble table in soft morning light with a vase of flowers', props: ['rose petals'], mood: 'soft', sources: ['asset-001', 'asset-002'], reason: 'the range' };
    normalizeRecipes(design, manifest, { generation: true, names: ['Cafe'] });
    const calls = { edit: 0, compare: 0, generate: 0 }; let verdict; let expectPrompt = true;
    const deps = {
      generation: true, verifyRealism: async () => '',
      editImage: async ({ prompt }) => { calls.edit++; if (expectPrompt && /^A professional commercial photo shoot/.test(prompt)) assert.match(prompt, /a wide pale marble table in soft morning light with a vase of flowers, with rose petals around, soft mood/); return { buffer: await solid('#99aabb'), width: 1600, height: 1216, cost: 0.05 }; },
      compareFidelity: async () => { calls.compare++; return verdict; },
      generateImage: async () => { calls.generate++; return { buffer: await solid('#e8d8c8'), width: 1024, height: 768, cost: 0.012 }; },
      inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }),
      removeBackground: async () => ({ buffer: await sharp({ create: { width: 300, height: 500, channels: 4, background: '#cc3344' } }).png().toBuffer(), width: 300, height: 500, cutOff: false, cost: 0.01 }),
    };
    // 1. a good comparison: the natural picture is the scene, in the page's frame shape, and nothing of the exact method ran
    verdict = { score: 9, mainTextMatches: true, differences: [], extraProducts: false, missingProducts: 0 };
    const made = await composeImages({ projectId: 'p1', design, manifest, deps });
    const scene = manifest.assets.find((a) => a.id === made[0]);
    assert.match(scene.description, /made with AI from the customer's own photo/);
    assert.match(scene.notes, /Natural photo shoot checked against the real photo \(score 9\)/);
    assert.deepEqual([scene.origin, scene.approval, scene.derivedFrom], ['generated', 'pending', ['asset-001', 'asset-002']]);
    assert.ok(Math.abs(scene.width / scene.height - 16 / 9) < 0.02);
    assert.deepEqual([calls.edit, calls.generate], [2, 0], 'two variants, no set drawn');
    // a rebuild (or a refit to the frame) reuses the checked picture: no new model calls
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual([calls.edit, calls.compare], [2, 2]);

    expectPrompt = false;
    // 2. a product is missing from the picture: not used, the exact method makes the scene, and a rebuild does not try again
    hero.recipe = { type: 'scene', scene: 'a dark walnut table in warm amber light', props: [], mood: '', sources: ['asset-001', 'asset-002'], reason: 'x' };
    normalizeRecipes(design, manifest, { generation: true, names: ['Cafe'] });
    verdict = { score: 7, mainTextMatches: true, differences: [], extraProducts: false, missingProducts: 1 };
    const edits1 = calls.edit;
    const fallback = await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.doesNotMatch(manifest.assets.find((a) => a.id === fallback[0]).description, /made with AI from the customer's own photo/);
    assert.ok(calls.generate > 0, 'the exact method drew its own table');
    const afterFirst = calls.edit;
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(calls.edit - afterFirst, 0, 'a rebuild repeats nothing: the rejected natural attempt and the exact method\'s editing pass are both remembered');
    assert.ok(afterFirst - edits1 >= 2);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
