// Unit tests for the Stage 4 checks (no API calls), using the demo-restaurant fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkContent } from '../src/stages/04-content/checks.js';
import { needsList } from '../src/stages/04-content/index.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const load = () => ({ brief: read('site-brief.json'), design: read('design-spec.json'), manifest: read('asset-manifest.json'), content: read('content-spec.json') });
const failed = (r) => r.filter((x) => !x.ok).map((x) => x.name);
const run = ({ content, brief, design, manifest }) => checkContent(content, brief, design, manifest);

test('the fixture content passes every check', () => {
  assert.deepEqual(failed(run(load())), []);
});

test('banned cliché and placeholder text are caught', () => {
  const l = load();
  l.content.pages[0].sections[0].heading = 'Welcome to Cedar & Sumac';
  l.content.pages[0].sections[1].subheading = 'Lorem ipsum dolor';
  const names = failed(run(l));
  assert.ok(names.some((n) => n.includes('clichés')));
  assert.ok(names.some((n) => n.includes('placeholder')));
});

test('invented number, phone and unsupported claim are caught', () => {
  const l = load();
  l.content.pages[0].sections[0].subheading = 'Serving Beirut for 25 years. Call 01 999 888. 100% guaranteed, free delivery.';
  const result = run(l);
  const facts = result.find((r) => r.name.includes('numbers'));
  assert.equal(facts.ok, false);
  assert.match(facts.details, /25/);
  assert.match(facts.details, /999/);
  const claims = result.find((r) => r.name.includes('claims'));
  assert.match(claims.details, /guaranteed/);
  assert.match(claims.details, /free delivery/);
});

test('a claim the brief itself makes is allowed', () => {
  const l = load();
  l.brief.business.description += ' Everything is handmade.';
  l.content.pages[0].sections[1].items[0].text = 'Handmade every morning.';
  assert.ok(!failed(run(l)).some((n) => n.includes('claims')));
});

test('missing alt text, wrong section ids and bad CTA targets are caught', () => {
  const l = load();
  l.content.pages[0].sections[0].imageAlt = {};
  l.content.pages[1].sections[0].id = 'menu-banner';
  l.content.pages[0].sections[2].cta.target = 'tel:01000000';
  const names = failed(run(l));
  assert.ok(names.some((n) => n.includes('alt text')));
  assert.ok(names.some((n) => n.includes('section ids')));
  assert.ok(names.some((n) => n.includes('call-to-action')));
});

test('NEEDS notes are listed for the customer and are not treated as invented facts', () => {
  const l = load();
  l.content.pages[1].sections[1].body = ['NEEDS: prices for each dish from the customer'];
  assert.deepEqual(failed(run(l)), []);
  assert.deepEqual(needsList(l.content), ['menu-dishes: prices for each dish from the customer']);
});

test('names that are only visible on a photo are caught, names the brief has are fine', () => {
  const l = load();
  l.manifest.assets[0].notes = 'Text visible: TOM FORD, TOBACCO VANILLE, EAU DE PARFUM';
  l.content.pages[1].sections[1].items[0].title = 'Tom Ford Tobacco Vanille';
  const names = run(l).find((r) => r.name.includes('taken from photos'));
  assert.equal(names.ok, false);
  assert.match(names.details, /tobacco/);
  l.brief.offerings[0].name = 'Tom Ford Tobacco Vanille'; // the owner confirmed it in the brief
  assert.equal(run(l).find((r) => r.name.includes('taken from photos')).ok, true);
});

test('step numbering and ordinary sentences in photo notes are not false alarms', () => {
  const l = load();
  l.manifest.assets[0].notes = 'Text visible: "FLOWE" (cut off). Some empty space there for text.';
  l.content.pages[1].sections[1].items[0].text = 'Steps 1, 2, 3 and then there you are.';
  assert.deepEqual(failed(run(l)), []);
});

test('every price from the brief must be shown in the copy', () => {
  const l = load();
  l.brief.offerings = [{ name: 'Mezze selection', description: '', price: '$18' }, { name: 'Mixed grill', description: '', price: '$32' }];
  l.content.pages[1].sections[1].items[0].text = 'Hummus, moutabal, tabbouleh and warm bread. $18';
  const missing = run(l).find((r) => r.name.includes('every price'));
  assert.equal(missing.ok, false);
  assert.match(missing.details, /Mixed grill \$32/);
  l.content.pages[1].sections[1].items[1].text = 'Lamb, chicken and kafta over charcoal. $32';
  assert.equal(run(l).find((r) => r.name.includes('every price')).ok, true);
  // a brief without prices has nothing to show
  const none = load();
  assert.equal(run(none).find((r) => r.name.includes('every price')).ok, true);
});

test('when the owner gave a story, the About section must use it', () => {
  const l = load();
  assert.equal(run(l).find((r) => r.name.includes('story is used')), undefined, 'no story, nothing to check');
  l.brief.business.story = 'We started in my mother\'s kitchen in Gemmayzeh and cook the same recipes today.';
  // the fixture About page already has text, but it is short: make it a real paragraph
  l.content.pages[2].sections[0].body = ['Cedar & Sumac began in a family kitchen in Gemmayzeh, and the recipes cooked there then are the ones on the table today.'];
  assert.equal(run(l).find((r) => r.name.includes('story is used')).ok, true);
  l.content.pages[2].sections[0].body = ['NEEDS: the owner story from the customer'];
  assert.equal(run(l).find((r) => r.name.includes('story is used')).ok, false);
});
