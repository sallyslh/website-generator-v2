// Collages are OFF: a picture made of several photos looks unnatural and leaves blank areas. One real photo is used instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipes, flags } from '../src/stages/03-creative-director/compose.js';

const asset = (id) => ({ id, kind: 'image', quality: 'high', category: 'food', file: `inputs/assets/${id}.jpg`, notes: '' });
const manifest = { assets: [asset('asset-001'), asset('asset-002'), asset('asset-003'), { ...asset('asset-004'), quality: 'low' }] };
const design = (recipe) => ({ pages: [{ slug: 'home', sections: [{ id: 'home-hero', slots: [{ id: 'home-hero-image', aspect: '4:5', recipe, assignedAsset: null }] }] }] });
const slot = (d) => d.pages[0].sections[0].slots[0];

test('collages are off by default', () => assert.equal(flags.collages, false));

test('a planned collage becomes the first usable photo; with none usable, the slot waits for a real photo', () => {
  const d = design({ type: 'collage', sources: ['asset-004', 'asset-002', 'asset-003'], layout: 'row', reason: 'x' });
  const warnings = normalizeRecipes(d, manifest, {});
  assert.deepEqual([slot(d).recipe.type, slot(d).recipe.sources, slot(d).assignedAsset], ['use', ['asset-002'], 'asset-002'], 'the low-quality photo is skipped');
  assert.ok(warnings.some((w) => /no collage/.test(w)));
  const none = design({ type: 'collage', sources: ['asset-004'], layout: 'row', reason: 'x' });
  normalizeRecipes(none, manifest, {});
  assert.deepEqual([slot(none).recipe.type, slot(none).assignedAsset], ['needs-photo', null]);
});

test('a scene or composite that cannot be made falls back to ONE photo, not a collage', () => {
  const scene = design({ type: 'scene', scene: 'a table', props: [], sources: ['asset-001', 'asset-002'], reason: 'x' });
  normalizeRecipes(scene, manifest, { generation: false });
  assert.equal(slot(scene).recipe.type, 'use');
  assert.deepEqual(slot(scene).recipe.sources, ['asset-001']);
  const composite = design({ type: 'composite', sources: ['asset-001', 'asset-002'], reason: 'x' });
  normalizeRecipes(composite, manifest, { generation: false });
  assert.equal(slot(composite).recipe.type, 'use');
});

test('the option still exists for the collage maker\'s own tests', () => {
  const d = design({ type: 'collage', sources: ['asset-001', 'asset-002'], layout: 'row', reason: 'x' });
  normalizeRecipes(d, manifest, { collages: true });
  assert.equal(slot(d).recipe.type, 'collage');
});
