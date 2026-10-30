// "Make this picture with AI" in the customer's editor (no network: the image services are faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCustomerServer } from '../src/server/customer.js';
import { nearestAspect, aiOptions, MAX_AI_PER_PROJECT } from '../src/lib/aiEdit.js';
import { tagEditable } from '../src/lib/siteEdits.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const solid = (W, H, color) => sharp({ create: { width: W, height: H, channels: 3, background: color } }).jpeg().toBuffer();
const product = async (w, h) => ({ buffer: await sharp({ create: { width: w, height: h, channels: 4, background: '#cc3344' } }).png().toBuffer(), width: w, height: h });

test('the nearest picture shape follows the frame', () => {
  assert.equal(nearestAspect(0.8), '4:5');
  assert.equal(nearestAspect(1.78), '16:9');
  assert.equal(nearestAspect(3.3), '3:1');
  assert.equal(nearestAspect(1), '1:1');
  assert.equal(nearestAspect(undefined), '1:1');
});

test('AI pictures in the editor: preview first, products stay real, the limit and the owner\'s "photos only" choice are respected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiedit-'));
  setProjectsRoot(tmp);
  const id = 'c-aaaaaa111111';
  const calls = { generate: 0, cut: 0 };
  let cutNow = false;
  const aiDeps = {
    generation: true,
    askJson: async ({ prompt }) => ({ scene: prompt.split('DESCRIPTION: ')[1].split('Your previous answer')[0].trim().replace(/ with the logo/, ''), props: ['rose petals'], mood: 'soft' }), // the rewriter, faked
    generateImage: async () => { calls.generate++; return { buffer: await solid(1024, 1280, '#e8c8c8'), width: 1024, height: 1280, cost: 0.012 }; },
    inspectSet: async () => ({ horizon: 0.4, frontEdge: 1, hasProducts: false, hasText: false, hasLogo: false }),
    removeBackground: async () => { calls.cut++; return { ...(await product(300, 500)), cutOff: cutNow, cost: 0.01 }; },
  };
  const { server } = createCustomerServer({ steps: {}, aiDeps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = read('asset-manifest.json');
    fs.mkdirSync(projectPath(id, 'inputs/assets'), { recursive: true });
    for (const a of manifest.assets) { a.file = `inputs/assets/${a.id}.jpg`; await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5533' } }).jpeg().toFile(projectPath(id, a.file)); }
    fs.writeFileSync(projectPath(id, 'asset-manifest.json'), JSON.stringify(manifest));
    const brief = read('site-brief.json');
    fs.writeFileSync(projectPath(id, 'site-brief.json'), JSON.stringify(brief));
    fs.writeFileSync(projectPath(id, 'customer-state.json'), JSON.stringify({ id, phase: 'chosen' }));
    const site = projectPath(id, 'site');
    const page = tagEditable('<main><h1>Hello world</h1><img src="/images/asset-001.webp" alt="A box" class="w-full"/></main>', 'home');
    fs.mkdirSync(path.join(site, 'src/content'), { recursive: true }); fs.mkdirSync(path.join(site, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(site, 'src/content/home.html'), page); fs.writeFileSync(path.join(site, 'dist/index.html'), `<html><body>${page}</body></html>`);
    const call = async (method, p, body) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };

    // what the editor offers: the usable photos (not the low quality one, not the logo), and how many pictures are left
    const state = (await call('GET', `/api/edit/${id}/state`)).json;
    assert.equal(state.ai.allowed, true);
    assert.equal(state.ai.remaining, MAX_AI_PER_PROJECT);
    assert.ok(state.ai.photos.length >= 2 && state.ai.photos.every((p) => p.picture.startsWith(`/p/${id}/inputs/assets/`)) && !state.ai.photos.some((p) => p.id === 'asset-003'));

    // a preview is made, costs are counted, and nothing on the site has changed yet
    const made = await call('POST', `/api/edit/${id}/ai`, { scene: 'pale pink linen tabletop by a sunny window', products: ['asset-001', 'asset-002'], ratio: 0.8 });
    assert.equal(made.status, 200);
    assert.equal(made.json.remaining, MAX_AI_PER_PROJECT - 1);
    assert.match(made.json.url, new RegExp(`^/p/${id}/edits/ai/.+\\.jpg$`));
    assert.equal((await fetch(base + made.json.url)).status, 200, 'the customer can see the preview');
    assert.equal(calls.cut, 2, 'only the two real products are cut out; the props are drawn inside the set');
    assert.equal((await call('GET', `/api/edit/${id}/state`)).json.changes.length, 0, 'a preview changes nothing');
    assert.match(fs.readFileSync(path.join(site, 'dist/index.html'), 'utf8'), /asset-001\.webp/);

    // using it puts it on the site, marked as made with AI, and it can be undone
    const key = page.match(/<img data-e="([^"]+)"/)[1];
    const used = await call('POST', `/api/edit/${id}/ai-use`, { key, file: made.json.file, alt: 'My box on a pink linen table' });
    assert.equal(used.status, 200);
    assert.deepEqual([used.json.changes[0].ai, used.json.changes[0].after], [true, 'My box on a pink linen table']);
    assert.match(fs.readFileSync(path.join(site, 'dist/index.html'), 'utf8'), /edit-[0-9a-f]{10}\.webp" alt="My box on a pink linen table"/);
    assert.equal((await call('POST', `/api/edit/${id}/undo`, { key })).json.changes.length, 0);

    // only files we made can be used; unsafe descriptions are refused in plain words and cost nothing
    assert.equal((await call('POST', `/api/edit/${id}/ai-use`, { key, file: '../../site-brief.json', alt: 'x y z' })).status, 400);
    assert.equal((await call('POST', `/api/edit/${id}/ai-use`, { key, file: 'nothing-here.jpg', alt: 'x y z' })).status, 404);
    const before = calls.generate;
    const unsafe = await call('POST', `/api/edit/${id}/ai`, { scene: 'a perfume bottle with the logo on a table', products: [], ratio: 1 });
    assert.equal(unsafe.status, 422);
    assert.match(unsafe.json.error, /We could not use "perfume", "bottle" in a picture: pictures made with AI never show products, logos, signs, shops or words/, 'the words that were the problem are named');
    assert.equal((await call('POST', `/api/edit/${id}/ai`, { scene: 'table', products: [], ratio: 1 })).status, 422);
    assert.equal((await call('POST', `/api/edit/${id}/ai`, { scene: 'a marble table with roses', products: ['asset-003'], ratio: 1 })).status, 422, 'a low quality photo cannot be a product');
    assert.equal(calls.generate, before, 'refused requests spend nothing');

    // a banned word in the rewritten set: the writer is asked once more without it, and the second answer is used
    const asked = [];
    aiDeps.askJson = async ({ prompt }) => {
      asked.push(prompt);
      return /Your previous answer was refused because of: "?store/.test(prompt)
        ? { scene: 'a wide marble table in soft daylight against a plain cream wall', props: ['rose petals'], mood: 'soft' }
        : { scene: 'a wide marble table inside a luxury store window in soft daylight', props: [], mood: 'soft' };
    };
    const retried = await call('POST', `/api/edit/${id}/ai`, { scene: 'like a luxury perfume counter, soft light', products: [], ratio: 1 });
    assert.equal(retried.status, 200, JSON.stringify(retried.json));
    assert.equal(asked.length, 2);
    assert.match(asked[1], /WITHOUT those words/);
    // still refused after the second try: the customer is told which word, and nothing is generated
    aiDeps.askJson = async () => ({ scene: 'a table inside a shop with a sign', props: [], mood: '' });
    const gen = calls.generate;
    const stuck = await call('POST', `/api/edit/${id}/ai`, { scene: 'like a luxury counter, soft light', products: [], ratio: 1 });
    assert.equal(stuck.status, 422);
    assert.match(stuck.json.error, /We could not use "shop", "sign" in a picture/);
    assert.equal(calls.generate, gen);
    // a description with only light and no place: the writer invents a fitting set instead of giving up
    aiDeps.askJson = async ({ prompt }) => ({ scene: /soft light mode/.test(prompt) ? 'a wide pale wooden table against a cream wall in gentle window light with a vase of peonies' : 'x', props: [], mood: 'soft' });
    assert.equal((await call('POST', `/api/edit/${id}/ai`, { scene: 'the same picture but with a soft light mode', products: [], ratio: 1 })).status, 200);

    // a photo whose products are all cut by the frame: the customer is told which photo, and which photos are sure to work
    aiDeps.askJson = async () => ({ scene: 'a wide marble table with roses in soft light', props: [], mood: 'soft' });
    fs.rmSync(projectPath(id, 'inputs/cutouts/asset-001.png'), { force: true });
    cutNow = true;
    const noPhoto = await call('POST', `/api/edit/${id}/ai`, { scene: 'a marble table with roses in soft light', products: ['asset-001'], ratio: 1 });
    cutNow = false;
    assert.equal(noPhoto.status, 422);
    assert.match(noPhoto.json.error, /cuts every product at its edges/);
    assert.match(noPhoto.json.error, /These photos are sure to work/);
    assert.ok((await call('GET', `/api/edit/${id}/state`)).json.ai.photos.some((p) => p.known), 'photos that already worked are marked');

    // the limit
    fs.writeFileSync(projectPath(id, 'edits/ai/count.json'), JSON.stringify({ count: MAX_AI_PER_PROJECT }));
    const limited = await call('POST', `/api/edit/${id}/ai`, { scene: 'a marble table with roses', products: [], ratio: 1 });
    assert.equal(limited.status, 403);
    assert.match(limited.json.error, /used all the AI pictures/);
    assert.equal((await call('GET', `/api/edit/${id}/state`)).json.ai.allowed, false);

    // the owner chose "only my own photos"
    fs.writeFileSync(projectPath(id, 'edits/ai/count.json'), JSON.stringify({ count: 0 }));
    fs.writeFileSync(projectPath(id, 'site-brief.json'), JSON.stringify({ ...brief, wishes: { ...(brief.wishes ?? { home: '' }), aiPictures: 'photos-only' } }));
    const off = await call('POST', `/api/edit/${id}/ai`, { scene: 'a marble table with roses', products: [], ratio: 1 });
    assert.equal(off.status, 403);
    assert.match(off.json.error, /only your own photos/);
    assert.equal(aiOptions(id, { generation: true }).allowed, false);
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
