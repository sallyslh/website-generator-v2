// Unit tests for the Stage 3 checks and assignment fixing (no API calls), using the demo-restaurant fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkDesign, compareDirections } from '../src/stages/03-creative-director/checks.js';
import { fixAssignments } from '../src/stages/03-creative-director/index.js';
import { setProjectsRoot } from '../src/lib/project.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), manifest: read('asset-manifest.json'), design: read('design-spec.json') });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const firstSlot = (design) => design.pages[0].sections[0].slots[0];

test('the fixture design passes every check', () => {
  const { brief, manifest, design } = load();
  assert.deepEqual(failed(checkDesign(design, brief, manifest)), []);
});

test('low quality asset assigned is caught, and fixAssignments nulls it', () => {
  const { brief, manifest, design } = load();
  firstSlot(design).assignedAsset = 'asset-003'; // the blurry one
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('low quality')));
  const warnings = fixAssignments(design, manifest);
  assert.equal(firstSlot(design).assignedAsset, null);
  assert.match(warnings[0], /low quality/);
});

test('missing brand color, wrong category and wrong shape are caught', () => {
  const { brief, manifest, design } = load();
  design.colors.primary = '#123456';
  firstSlot(design).preferredCategory = 'food';
  firstSlot(design).aspect = '3:4';
  design.pages[0].sections[0].layoutNotes = 'Image on the right';
  const names = failed(checkDesign(design, brief, manifest));
  assert.ok(names.some((n) => n.includes('brand hex colors')));
  assert.ok(names.some((n) => n.includes('slot category')));
  assert.ok(names.some((n) => n.includes('slot shape')));
});

test('Stage 2 warnings must reach the design: overlay not cropped, rights warning ignored in hero', () => {
  const { brief, manifest, design } = load();
  manifest.assets[0].notes = 'A "1/3" counter overlay is in the corner. Third-party brand labels, check rights.';
  design.pages[0].sections[0].layoutNotes = 'Big photo right';
  firstSlot(design).description = 'Dining room';
  const names = failed(checkDesign(design, brief, manifest));
  assert.ok(names.some((n) => n.includes('warnings from Stage 2')));
  // saying it fixes the first problem
  design.pages[0].sections[0].layoutNotes = 'Big photo right, crop out the counter; rights must be confirmed with the customer';
  assert.ok(!failed(checkDesign(design, brief, manifest)).some((n) => n.includes('warnings from Stage 2')));
});

test('reusing a photo while a spare of the same category exists is only a warning (reuse is allowed when it is the best real photo)', () => {
  const { brief, manifest, design } = load();
  manifest.assets.push({ ...manifest.assets[0], id: 'asset-009', file: 'inputs/assets/extra.png' });
  design.pages[1].sections[0].slots.push({ id: 'menu-intro-image', kind: 'image', description: 'x', preferredCategory: 'interior', aspect: '4:3', assignedAsset: 'asset-001', recipe: { type: 'use', sources: ['asset-001'], reason: 'best photo' } });
  const results = checkDesign(design, brief, manifest);
  const warning = results.find((r) => r.name.startsWith('warning only: a photo reused'));
  assert.equal(warning.ok, true);
  assert.match(warning.details, /asset-001 used 2x while asset-009 unused/);
});

test('compareDirections flags a shared heading font', () => {
  setProjectsRoot(path.resolve('test/fixtures'));
  const { flags } = compareDirections(['demo-restaurant', 'demo-restaurant']);
  assert.ok(flags.some((f) => f.includes('share the heading font')));
});

test('"space for overlay text" is not mistaken for a visible overlay', () => {
  const { brief, manifest, design } = load();
  manifest.assets[0].notes = 'Some empty space at the top for overlay text.';
  design.pages[0].sections[0].layoutNotes = 'Big photo right';
  assert.deepEqual(failed(checkDesign(design, brief, manifest)), []);
});

test('"not AI-generated" rules: banned fonts, same font twice, and a missing signature are caught', () => {
  const { brief, manifest, design } = load();
  design.typography.headings = 'Playfair Display: elegant serif';
  design.typography.body = 'Inter: clean sans-serif';
  delete design.signature;
  const names = failed(checkDesign(design, brief, manifest));
  assert.ok(names.some((n) => n.includes('no font that every AI website uses')));
  assert.ok(names.some((n) => n.includes('signature visual idea')));
  design.typography.headings = 'Karla: x';
  design.typography.body = 'Karla: y';
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('two different fonts')));
});

test('fonts: names are read from a typography line and from a Stitch page', async () => {
  const { fontNameOf, isBannedFont, fontsOnPage } = await import('../src/stages/03-creative-director/fonts.js');
  assert.equal(fontNameOf('Rozha One: bold serif, large'), 'Rozha One');
  assert.equal(isBannedFont('inter'), true);
  assert.equal(isBannedFont('Rozha One'), false);
  const html = '<link href="https://fonts.googleapis.com/css2?family=Rozha+One&family=Karla:wght@400;700&display=swap" rel="stylesheet"><style>body{font-family:\'Inter\', sans-serif}</style>';
  assert.deepEqual(fontsOnPage(html).sort(), ['Inter', 'Karla', 'Rozha One']);
});

test('designed lettering: serif headings are caught, accent fonts and the catalog are consistent', async () => {
  const { isSerifFont, HEADING_GROUPS, BODY_FONTS, ACCENT_FONTS } = await import('../src/stages/03-creative-director/fontCatalog.js');
  const { isBannedFont } = await import('../src/stages/03-creative-director/fonts.js');
  assert.equal(isSerifFont('Gloock'), true);
  assert.equal(isSerifFont('Noto Serif Display'), true);
  assert.equal(isSerifFont('Noto Sans'), false);
  assert.equal(isSerifFont('Fredoka'), false);
  // nothing we recommend may be forbidden or a serif
  for (const font of [...HEADING_GROUPS.flatMap((g) => g.fonts), ...BODY_FONTS, ...ACCENT_FONTS]) {
    assert.equal(isBannedFont(font), false, `${font} is banned`);
    assert.equal(isSerifFont(font), false, `${font} is a serif`);
  }
  const { brief, manifest, design } = load();
  design.typography.headings = 'Gloock: bold serif';
  design.typography.reason = '';
  const names = failed(checkDesign(design, brief, manifest));
  assert.ok(names.some((n) => n.includes('not a serif')));
  assert.ok(names.some((n) => n.includes('reason tied to the business')));
});

test('lettering variety: suggestions depend on the business name and are stable', async () => {
  const { varietyPicks, HEADING_GROUPS } = await import('../src/stages/03-creative-director/fontCatalog.js');
  const all = new Set(HEADING_GROUPS.flatMap((g) => g.fonts));
  const bonza = varietyPicks('Bonza');
  assert.equal(bonza.length, 3);
  assert.equal(new Set(bonza).size, 3);
  assert.ok(bonza.every((f) => all.has(f)));
  assert.deepEqual(varietyPicks('Bonza'), bonza, 'same name, same picks');
  assert.notDeepEqual(varietyPicks('My Sweet Home'), bonza, 'different businesses get different suggestions');
});

test('professional first: playful or hand-drawn lettering only for businesses that are playful', async () => {
  const { fontTier, fontFitsBusiness } = await import('../src/stages/03-creative-director/fontCatalog.js');
  assert.equal(fontTier('Tenor Sans'), 'professional');
  assert.equal(fontTier('Caprasimo'), 'expressive');
  assert.equal(fontTier('Fredoka'), 'playful');
  assert.equal(fontTier('Not In The Catalog'), null);
  assert.equal(fontFitsBusiness('Tenor Sans', 'online perfume shop'), true);
  assert.equal(fontFitsBusiness('Fredoka', 'gift and home goods shop'), false, 'bubbly font for a gift shop is refused');
  assert.equal(fontFitsBusiness('Fredoka', 'toy shop for kids'), true);
  assert.equal(fontFitsBusiness('Caprasimo', 'family bakery'), true);
  assert.equal(fontFitsBusiness('Caprasimo', 'law firm'), false);
  // the check reaches the design review
  const { brief, manifest, design } = load();
  design.typography.headings = 'Fredoka: bubbly';
  assert.ok(failed(checkDesign(design, brief, manifest)).some((n) => n.includes('professional first')));
});
