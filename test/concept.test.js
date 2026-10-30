// The art-direction concept: taste decides, novelty only chooses between concepts that already taste good. It never refuses anything. No API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseConcept, pickSparks, SPARKS, makeConcept, conceptBlock, conceptPrompt, CONCEPT_SYSTEM, JUDGE_SYSTEM, FILE } from '../src/stages/03-creative-director/concept.js';
import { directorPrompt } from '../src/stages/03-creative-director/prompts.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const c = (id, typicality) => ({ id, name: id, idea: 'x', root: 'r', opening: 'o', pictures: 'p', rhythm: 'r', typeVoice: 't', spark: '', typicality });
const s = (id, taste, gimmick = false) => ({ id, taste, gimmick, reason: '' });

test('a gimmick is set aside, however unusual; the least typical of the best-tasting wins', () => {
  const r = chooseConcept([c('safe', 9), c('elegant', 5), c('weird', 1)], [s('safe', 8), s('elegant', 8), s('weird', 9, true)]);
  assert.equal(r.chosen.id, 'elegant');
});

test('only concepts within one point of the best taste compete, at most three; then the least typical wins', () => {
  const concepts = [c('a', 8), c('b', 4), c('c', 2)];
  assert.equal(chooseConcept(concepts, [s('a', 9), s('b', 8), s('c', 7)]).chosen.id, 'b', 'c is least typical but two points below the best');
  const many = chooseConcept([c('a', 9), c('b', 8), c('c', 7), c('d', 1)], [s('a', 9), s('b', 9), s('c', 9), s('d', 9)]);
  assert.deepEqual(many.candidates.length, 3, 'at most three candidates');
});

test('equal typicality: the better taste wins; a complete tie keeps the first', () => {
  const concepts = [c('a', 5), c('b', 5)];
  assert.equal(chooseConcept(concepts, [s('a', 8), s('b', 9)]).chosen.id, 'b');
  assert.equal(chooseConcept(concepts, [s('a', 8), s('b', 8)]).chosen.id, 'a');
});

test('it never refuses: with only weak concepts the best one is used, and even if all are flagged the best taste wins', () => {
  const weak = chooseConcept([c('typical', 10), c('odd', 1)], [s('typical', 3), s('odd', 1)]);
  assert.equal(weak.chosen.id, 'typical', 'there is no threshold to fail: the best taste is taken');
  const allFlagged = chooseConcept([c('a', 3), c('b', 8)], [s('a', 7, true), s('b', 5, true)]);
  assert.equal(allFlagged.chosen.id, 'a');
  assert.equal(chooseConcept([c('a', 3)], []), null, 'no scores at all: no concept (the director works without one)');
});

test('scores are kept sane: out-of-range or missing values do not break the choice', () => {
  const r = chooseConcept([c('a', 5), c('b', 5)], [{ id: 'a', taste: 99 }, { id: 'b', taste: 'x' }]);
  assert.equal(r.chosen.id, 'a');
  assert.equal(r.chosen.taste, 10);
});

test('the creative sparks: three different ones, the same for the same project, different for another', () => {
  const a = pickSparks('c-111111111111'); const b = pickSparks('c-111111111111'); const other = pickSparks('c-222222222222');
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
  assert.ok(a.every((x) => SPARKS.includes(x)));
  assert.notDeepEqual(a, other);
  assert.ok(new Set(Array.from({ length: 40 }, (_, i) => pickSparks(`c-${i}`, 1)[0])).size > 15, 'different projects get a wide spread of sparks');
});

test('the vibe: the writer and the judge are both told to match the owner\'s vibe', () => {
  assert.match(CONCEPT_SYSTEM, /VIBE/);
  assert.match(JUDGE_SYSTEM, /vibe/i);
  assert.match(JUDGE_SYSTEM, /taste/);
  const brief = { business: { name: 'Mori' }, goals: {}, audience: {}, tone: 'quiet, warm, unhurried', brand: { personality: ['calm', 'handmade'] }, offerings: [], language: 'en', wishes: {}, siteType: 'menu' };
  assert.match(conceptPrompt({ brief, manifest: { assets: [], logo: null, documents: [], gaps: [] }, sparks: ['a seed packet'] }), /quiet, warm, unhurried/, 'the tone words reach the writer');
});

test('makeConcept: writes the concept file once, and a model failure never blocks the design', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-')); setProjectsRoot(tmp); fs.mkdirSync(projectPath('p', ''), { recursive: true });
  try {
    const brief = { business: { name: 'Nonna Rosa' }, goals: {}, audience: {}, tone: '', brand: {}, offerings: [{ name: 'Pasta' }], language: 'en', wishes: {}, siteType: 'menu' };
    const manifest = { assets: [], logo: null, documents: [], gaps: [] };
    let calls = 0;
    const ask = async ({ stage, prompt }) => {
      calls++;
      if (/Score every concept/.test(prompt)) return { scores: [s('c1', 8), s('c2', 8), s('c3', 9, true)] };
      assert.match(prompt, /CREATIVE SPARKS/); assert.equal(stage, 'concept');
      return { concepts: [c('c1', 4), c('c2', 8), c('c3', 1)] };
    };
    const chosen = await makeConcept({ projectId: 'p', brief, manifest, ask });
    assert.equal(chosen.id, 'c1');
    assert.equal(calls, 2);
    const saved = JSON.parse(fs.readFileSync(projectPath('p', FILE), 'utf8'));
    assert.deepEqual([saved.chosenId, saved.concepts.length, saved.sparks.length, saved.candidates], ['c1', 3, 3, ['c1', 'c2']]);
    assert.equal((await makeConcept({ projectId: 'p', brief, manifest, ask })).id, 'c1', 'the saved concept is reused');
    assert.equal(calls, 2);
    fs.rmSync(projectPath('p', FILE));
    assert.equal(await makeConcept({ projectId: 'p', brief, manifest, ask: async () => { throw new Error('model down'); } }), null, 'a failure means no concept, not a failed site');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the creative director is told the concept, and keeps its professional-first rules', () => {
  const brief = { business: { name: 'B' }, goals: {}, audience: {}, offerings: [], pages: [], features: [], brand: {}, tone: '', references: [], language: 'en', unknowns: [], wishes: {} };
  const manifest = { assets: [], logo: null, documents: [], gaps: [] };
  const chosen = { ...c('c1', 3), name: 'The Ticket Wall', idea: 'Orders pinned like kitchen tickets' };
  const text = directorPrompt({ brief, manifest, concept: chosen });
  assert.match(text, /ART DIRECTION CONCEPT/); assert.match(text, /The Ticket Wall/); assert.match(text, /PROFESSIONAL FIRST rules still win/);
  assert.doesNotMatch(directorPrompt({ brief, manifest }), /ART DIRECTION CONCEPT/);
  assert.equal(conceptBlock(null), '');
});
