// The look: a dentist looks like a normal dentist, a padel club may be bold, and the owner can choose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLook, chooseClassic, conceptPrompt, makeWowConcept, CLASSIC_DIRECTIONS, DIRECTIONS } from '../src/wow/concept.js';

test('trusted professions default to a classic look, other businesses to the free bold look', () => {
  for (const [typeId, typeLabel] of [['clinic', 'Clinic / dentist'], ['x', 'Dentist'], ['x', 'Family law office'], ['x', 'Veterinary clinic'], ['x', 'Primary school'], ['x', 'Physiotherapy']]) assert.equal(defaultLook({ typeId, typeLabel }), 'classic', typeLabel);
  for (const [typeId, typeLabel] of [['padel', 'Padel / sports club'], ['cafe', 'Café'], ['restaurant', 'Restaurant'], ['barber', 'Barber'], ['shop', 'Shop / boutique']]) assert.equal(defaultLook({ typeId, typeLabel }), 'bold', typeLabel);
});

test('the classic choice is the best-tasting familiar concept, not the least typical', () => {
  const concepts = [{ id: 'a', typicality: 2 }, { id: 'b', typicality: 8 }, { id: 'c', typicality: 5 }];
  const scores = [{ id: 'a', taste: 9, gimmick: false }, { id: 'b', taste: 8, gimmick: false }, { id: 'c', taste: 4, gimmick: false }];
  assert.equal(chooseClassic(concepts, scores).chosen.id, 'b');
  assert.equal(chooseClassic([{ id: 'a', typicality: 9 }, { id: 'b', typicality: 3 }], [{ id: 'a', taste: 9, gimmick: true }, { id: 'b', taste: 6, gimmick: false }]).chosen.id, 'b', 'a gimmick never wins');
});

test('a classic look asks only for calm concepts and uses calm starting points', async () => {
  const p = conceptPrompt({ name: 'Smile', typeLabel: 'Dentist', language: 'English', pages: [{ title: 'Home' }], sparks: [], directions: ['x'], look: 'classic' });
  assert.match(p, /ALL of them must be normal, calm and trustworthy/);
  assert.match(conceptPrompt({ name: 'P', typeLabel: 'Padel club', language: 'English', pages: [{ title: 'Home' }], sparks: [], directions: ['x'] }), /clearly distinctive/);
  const seen = {};
  const ask = async ({ system, prompt, schema }) => {
    if (/art director of a studio that designs websites for businesses where visitors/.test(system)) seen.classic = true;
    seen.prompt = prompt;
    if (/Score every concept/.test(prompt)) return { scores: [{ id: 'c1', taste: 8, gimmick: false, reason: 'ok' }, { id: 'c2', taste: 7, gimmick: false, reason: 'ok' }, { id: 'c3', taste: 6, gimmick: false, reason: 'ok' }] };
    return { concepts: ['c1', 'c2', 'c3'].map((id, i) => ({ id, name: id, idea: 'i', opening: 'o', pictures: 'p', rhythm: 'r', typicality: 5 + i })) };
  };
  const chosen = await makeWowConcept({ projectId: 'look-test-' + Date.now(), name: 'Smile', typeLabel: 'Dentist', pages: [{ title: 'Home' }], look: 'classic', ask });
  assert.equal(seen.classic, true);
  assert.ok(chosen);
  assert.ok(CLASSIC_DIRECTIONS.length >= 6 && DIRECTIONS.length > 20);
  assert.equal(CLASSIC_DIRECTIONS.some((d) => /arcade|neon|motorsport|stage/i.test(d)), false);
});
