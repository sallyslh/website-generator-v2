// Tests for the owner's wishes for the home page and the "only my own photos" choice (no network, no API calls).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formToAnswers } from '../src/server/customerFlow.js';
import { splitWishes } from '../src/stages/01-discovery/index.js';
import { checkBrief } from '../src/stages/01-discovery/checks.js';
import { briefPrompt } from '../src/stages/01-discovery/prompts.js';
import { siteBriefSchema } from '../src/schemas/siteBrief.js';
import { designSpecSchema } from '../src/schemas/designSpec.js';
import { directorPrompt } from '../src/stages/03-creative-director/prompts.js';
import { inventory, inventoryText } from '../src/stages/03-creative-director/inventory.js';
import { checkDesign } from '../src/stages/03-creative-director/checks.js';
import { createCustomerServer } from '../src/server/customer.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { config } from '../src/config.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json'), answers: JSON.parse(fs.readFileSync(path.join(dir, 'inputs/answers.json'), 'utf8')) });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

test('the form carries the wishes and the AI choice into the answers file; anything odd becomes the safe default', () => {
  const a = formToAnswers({ businessName: 'Cafe', homeWishes: '  my best sellers first, and coffee beans  ', aiPictures: 'photos-only' });
  assert.equal(a.homeWishes, 'my best sellers first, and coffee beans');
  assert.equal(a.aiPictures, 'photos-only');
  const b = formToAnswers({ businessName: 'Cafe', aiPictures: 'something else' });
  assert.deepEqual([b.homeWishes, b.aiPictures], ['', 'allowed']);
  assert.equal(formToAnswers({ businessName: 'x', homeWishes: 'w'.repeat(5000) }).homeWishes.length, 1500, 'a wish is limited in length');
  assert.equal(formToAnswers({ businessName: 'x', homeWishes: 42 }).homeWishes, '', 'not text: ignored');
});

test('the model never sees the wishes, and code copies them into the brief word for word', () => {
  const answers = { businessName: 'Cafe', whatItDoes: 'coffee', homeWishes: ' Eid offer and my bestsellers ', aiPictures: 'photos-only', anythingElse: 'x' };
  const { forBrief, wishes } = splitWishes(answers);
  assert.equal('homeWishes' in forBrief, false);
  assert.equal('aiPictures' in forBrief, false);
  assert.ok(!briefPrompt('p1', forBrief).includes('Eid offer'), 'the prompt for the model does not contain the wishes');
  assert.deepEqual(wishes, { home: 'Eid offer and my bestsellers', aiPictures: 'photos-only' });
  assert.deepEqual(splitWishes({ businessName: 'x' }).wishes, { home: '', aiPictures: 'allowed' });
});

test('an old brief without wishes still loads (empty wishes, AI pictures allowed); the Stage 1 check catches altered wishes', () => {
  const { brief, answers } = load();
  delete brief.wishes;
  assert.deepEqual(siteBriefSchema.parse(brief).wishes, { home: '', aiPictures: 'allowed' });
  const kept = { ...siteBriefSchema.parse(brief), wishes: { home: 'my best sellers first', aiPictures: 'allowed' } };
  const ok = checkBrief(kept, { ...answers, homeWishes: 'my best sellers first' }).find((c) => c.name.includes('wishes'));
  assert.equal(ok.ok, true);
  const altered = checkBrief({ ...kept, wishes: { home: 'a rewritten wish', aiPictures: 'allowed' } }, { ...answers, homeWishes: 'my best sellers first' }).find((c) => c.name.includes('wishes'));
  assert.equal(altered.ok, false);
  const choice = checkBrief({ ...kept, wishes: { home: 'my best sellers first', aiPictures: 'allowed' } }, { ...answers, homeWishes: 'my best sellers first', aiPictures: 'photos-only' }).find((c) => c.name.includes('wishes'));
  assert.equal(choice.ok, false, 'the "only my photos" choice must reach the brief');
});

test('the director receives the wishes with rules: wishes are input, never invented facts, and every one gets an answer', () => {
  const { brief, manifest } = load();
  brief.wishes = { home: 'my best sellers first; an Eid offer', aiPictures: 'allowed' };
  const prompt = directorPrompt({ brief, manifest });
  assert.match(prompt, /"home": "my best sellers first; an Eid offer"/);
  const system = fs.readFileSync(path.resolve('src/stages/03-creative-director/prompts.js'), 'utf8');
  assert.match(system, /THE OWNER'S WISHES FOR THE HOME PAGE/);
  assert.match(system, /Never turn a wish into an invented fact/);
  assert.match(system, /Answer EVERY wish in "wishResponses"/);
  assert.match(system, /"photos-only" means the owner does NOT want pictures made with AI/);
});

test('"only my own photos" switches generation off for the director, whatever the keys allow', () => {
  const { brief, manifest } = load();
  config.falKey = 'k';
  try {
    assert.equal(inventory(manifest, brief).generation, true);
    brief.wishes = { home: '', aiPictures: 'photos-only' };
    const inv = inventory(manifest, brief);
    assert.equal(inv.generation, false);
    assert.match(inventoryText(inv), /NOT allowed: the owner asked for ONLY their own photos/);
  } finally { config.falKey = ''; }
});

test('the checks: every wish is answered with a reason, and a design that plans AI pictures for a photos-only owner fails', () => {
  const { brief, manifest, design } = load();
  assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => /wishes|only their own photos/.test(n)), [], 'no wishes, nothing to answer');
  brief.wishes = { home: 'my best sellers first', aiPictures: 'allowed' };
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('wishes')), 'a wish without an answer fails');
  design.wishResponses = [{ wish: 'my best sellers first', outcome: 'used', how: 'We put your best sellers first in the home grid.' }];
  assert.equal(designSpecSchema.safeParse(design).success, true);
  assert.deepEqual(failed(checkDesign(design, brief, manifest)).filter((n) => n.includes('wishes')), []);
  design.wishResponses[0].how = 'ok';
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('wishes')), 'a one-word answer is not an explanation');
  design.wishResponses[0].outcome = 'maybe';
  assert.equal(designSpecSchema.safeParse(design).success, false);
  // photos only
  design.wishResponses = [{ wish: 'my best sellers first', outcome: 'used', how: 'We put your best sellers first in the home grid.' }];
  brief.wishes.aiPictures = 'photos-only';
  design.pages[0].sections[0].slots[0].recipe = { type: 'scene', scene: 'linen table', props: [], sources: [], reason: '' };
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('only their own photos')));
});

test('the customer sees what the designer did with each wish once the design is ready, and nothing before', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-'));
  setProjectsRoot(tmp);
  const quiet = async () => {};
  const steps = { brief: quiet, photos: quiet, findings: async () => [], applyDecisions: quiet, direction: quiet, copy: quiet, sketches: quiet, another: quiet, recordChoice: quiet, rest: quiet, approve: quiet };
  const { server, flow } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, method = 'GET', body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  try {
    const { id } = await call('/api/start', 'POST');
    const { design } = load();
    design.wishResponses = [{ wish: 'coffee beans', outcome: 'adapted', how: 'We use roasted beans as a quiet backdrop.' }, { wish: 'my Eid offer', outcome: 'declined', how: 'We need the offer details first.' }];
    fs.writeFileSync(path.join(tmp, id, 'design-spec.json'), JSON.stringify(design));
    flow.save(id, { phase: 'designing' });
    assert.deepEqual((await call(`/api/status/${id}`)).wishes, []);
    flow.save(id, { phase: 'ready' });
    const status = await call(`/api/status/${id}`);
    assert.deepEqual(status.wishes.map((w) => [w.wish, w.outcome]), [['coffee beans', 'adapted'], ['my Eid offer', 'declined']]);
    assert.equal(JSON.stringify(status).includes('imagePlan'), false, 'internal details never leave the server');
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
