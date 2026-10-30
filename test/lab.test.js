// Tests for the image lab (no network: the model, the image service and the set inspection are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { labIdeas, labRun, labHistory } from '../src/lib/imageLab.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const solid = (W, H, color) => sharp({ create: { width: W, height: H, channels: 3, background: color } }).jpeg().toBuffer();
const product = async (w, h) => ({ buffer: await sharp({ create: { width: w, height: h, channels: 4, background: '#cc3344' } }).png().toBuffer(), width: w, height: h });

async function withProject(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  setProjectsRoot(tmp);
  try {
    const manifest = read('asset-manifest.json');
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath('p1', a.file)); }
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(projectPath('p1', 'site-brief.json'), JSON.stringify(read('site-brief.json')));
    await fn(manifest);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('ideas: unsafe ideas are dropped, products are limited to real usable photos', async () => {
  await withProject(async () => {
    const ask = async () => ({ ideas: [
      { title: 'ok', scene: 'dark slate bar top in low morning light', props: ['coffee beans'], mood: 'moody', products: ['asset-001', 'asset-003', 'nope'], why: 'warm' },
      { title: 'bad', scene: 'a table with a perfume bottle and a box', props: [], mood: '', products: [], why: 'no' },
    ] });
    const ideas = await labIdeas({ projectId: 'p1', deps: { askJson: ask } });
    assert.deepEqual(ideas.map((i) => i.title), ['ok']);
    assert.deepEqual(ideas[0].products, ['asset-001'], 'the low quality photo and the unknown id are gone');
  });
});

test('a lab picture is saved under lab/, costs are reported, the project\'s own files are untouched, the same idea is free', async () => {
  await withProject(async (manifest) => {
    const before = fs.readFileSync(projectPath('p1', 'asset-manifest.json'), 'utf8');
    const calls = { generate: 0, cut: 0 };
    const deps = {
      generation: true,
      generateImage: async () => { calls.generate++; return { buffer: await solid(1024, 1280, '#e8c8c8'), width: 1024, height: 1280, cost: 0.012 }; },
      inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }),
      removeBackground: async () => { calls.cut++; return { ...(await product(300, 500)), cutOff: false, cost: 0.01 }; },
    };
    const idea = { projectId: 'p1', scene: 'pale pink linen tabletop by a sunny window', props: ['loose flower petals'], mood: 'airy', products: ['asset-001', 'asset-002'], aspect: '4:5', deps };
    const out = await labRun(idea);
    assert.ok(out.costUsd > 0);
    assert.match(out.url, /^\/files\/p1\/lab\/.+\.jpg$/);
    assert.ok(fs.existsSync(projectPath('p1', 'lab', out.file)));
    assert.deepEqual(out.products, ['asset-001', 'asset-002']);
    assert.equal(fs.readFileSync(projectPath('p1', 'asset-manifest.json'), 'utf8'), before, 'the manifest is not changed');
    assert.ok(!fs.existsSync(projectPath('p1', 'design-spec.json')), 'no design is created');
    const first = { ...calls };
    const again = await labRun(idea);
    assert.deepEqual(calls, first, 'cached pieces are reused');
    assert.equal(again.costUsd, 0);
    assert.equal(labHistory('p1').length, 2);
    void manifest;
  });
});

test('lab refuses unusable input in plain words', async () => {
  await withProject(async () => {
    const base = { projectId: 'p1', scene: 'linen table by a window', deps: { generation: true } };
    await assert.rejects(labRun({ ...base, scene: 'table' }), /few words/);
    await assert.rejects(labRun({ ...base, aspect: '9:16' }), /shape must be one of/);
    await assert.rejects(labRun({ ...base, products: ['asset-003'] }), /not usable photos/);
    await assert.rejects(labRun({ ...base, products: ['asset-001', 'asset-002', 'asset-001', 'x'] }), /not usable photos/);
    await assert.rejects(labRun({ ...base, scene: 'a perfume bottle standing on a table' }), /not accepted/);
    assert.deepEqual(labHistory('p1'), []);
  });
});
