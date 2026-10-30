// Unit tests for Stage 5 (no API calls): the prompt builder and the file checks, using the fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPagePrompt, buildBaselinePrompt, homeNoteFrom } from '../src/stages/05-design-stitch/prompts.js';
import { checkStitchFiles, htmlText, detectCss } from '../src/stages/05-design-stitch/checks.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const inputs = () => ({ brief: read('site-brief.json'), design: read('design-spec.json'), content: read('content-spec.json') });

test('home prompt contains the styleBlock, every section id, every slot id and the avoid list', () => {
  const { brief, design, content } = inputs();
  const prompt = buildPagePrompt({ brief, design, content, slug: 'home' });
  assert.ok(prompt.includes(design.styleBlock));
  for (const s of design.pages[0].sections) {
    assert.ok(prompt.includes(`"${s.id}"`), `section ${s.id}`);
    for (const slot of s.slots) assert.ok(prompt.includes(`Image slot ${slot.id}`), `slot ${slot.id}`);
  }
  for (const a of design.avoid) assert.ok(prompt.includes(a), a);
  assert.ok(prompt.includes('Mezze, made fresh every morning'), 'real copy is in the prompt');
  assert.match(prompt, /Use the slot id as the image's alt text/);
});

test('NEEDS lines never reach the prompt, and other pages get the home note', () => {
  const { brief, design, content } = inputs();
  content.pages[1].sections[1].body = ['NEEDS: prices for each dish from the customer'];
  const prompt = buildPagePrompt({ brief, design, content, slug: 'menu', homeNote: homeNoteFrom(design) });
  assert.ok(!prompt.includes('prices for each dish'));
  assert.match(prompt, /Do not invent them/);
  assert.match(prompt, /Match the already approved home page: header:/);
});

test('baseline prompt uses the brief only', () => {
  const { brief, design } = inputs();
  const prompt = buildBaselinePrompt(brief);
  assert.ok(prompt.includes('Cedar & Sumac'));
  assert.ok(!prompt.includes(design.styleBlock));
});

test('html helpers', () => {
  assert.equal(htmlText('<h1>Mezze &amp; more</h1><style>.a{}</style><p>Hi</p>'), 'mezze & more hi');
  assert.equal(detectCss('<div class="flex px-4 bg-blue-500">'), 'Tailwind');
  assert.equal(detectCss('<div class="hero">'), 'plain CSS');
});

test('file checks: missing files, wrong headings, bad PNG and slot ids are reported', () => {
  const { brief, design, content } = inputs();
  const pngHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8), Buffer.from([0, 0, 1, 144, 0, 0, 1, 44])]);
  const files = {
    'design/home.html': Buffer.from('<h1>Mezze, made fresh every morning</h1><h2>From our kitchen</h2><img alt="home-hero-image"><h2>Save a seat for tonight</h2>'),
    'design/home.png': pngHeader,
  };
  const io = { read: (f) => files[f], exists: (f) => f in files };
  const manifest = { pages: [{ slug: 'home', screenId: 'a', html: 'design/home.html', screenshot: 'design/home.png', variants: [], promptUsed: design.styleBlock, status: 'generated' }] };
  const results = checkStitchFiles(io, manifest, design, content, brief);
  const byName = (part) => results.find((r) => r.name.includes(part));
  assert.equal(byName('expected file').ok, true);
  assert.equal(byName('valid PNG').ok, true);
  assert.equal(byName('at most 1 variant').ok, true);
  assert.equal(byName('real headings').ok, true);
  assert.match(byName('slot ids').details, /1\/2/);

  files['design/home.html'] = Buffer.from('<h1>Something else entirely</h1>');
  assert.equal(checkStitchFiles(io, manifest, design, content, brief).find((r) => r.name.includes('real headings')).ok, false);
  files['design/home.png'] = Buffer.from('not a png');
  assert.equal(checkStitchFiles(io, manifest, design, content, brief).find((r) => r.name.includes('valid PNG')).ok, false);
});

test('stitch response parsing picks the real page, not the helper logo screen', async () => {
  const { screensIn, pickPages } = await import('../src/stages/05-design-stitch/stitchClient.js');
  const screen = (id, title, w, h) => ({ id, title, width: w, height: h, screenType: 'DESIGN', htmlCode: { downloadUrl: `h-${id}` }, screenshot: { downloadUrl: `i-${id}` } });
  const response = { outputComponents: [{ design: { screens: [screen('logo', 'Logo badge', 240, 240), screen('page', 'Bonza - Home', 2560, 8924)] } }, { text: 'done' }, { suggestion: 'next' }] };
  const pages = pickPages(screensIn(response));
  assert.deepEqual(pages.map((p) => p.screenId), ['page', 'logo']);
  assert.equal(pages[0].htmlUrl, 'h-page');
  assert.deepEqual(screensIn({ outputComponents: [{ text: 'only text' }] }), []);
});

test('invented text on the page is caught, our own copy and icon names are not', async () => {
  const { invented } = await import('../src/stages/05-design-stitch/checks.js');
  const { brief, content } = inputs();
  const html = '<!-- Left (7 cols) --><h1>Mezze, made fresh every morning</h1><span class="material-symbols-outlined">arrow_forward</span><p>100% Authentic Oils</p><p>Eau de Parfum - 100ml</p><p>Hand-decanted in small batches</p><p>Reserve a table</p>';
  const result = invented(html, content, brief);
  assert.deepEqual(result.risky, ['100% Authentic Oils', 'Eau de Parfum - 100ml', 'Hand-decanted in small batches']);
  assert.ok(!result.extra.includes('Mezze, made fresh every morning'));
  assert.ok(!result.extra.some((l) => /arrow_forward|cols/.test(l)));
});

test('repairHtml turns a bare image address into a real image and leaves normal pages alone', async () => {
  const { repairHtml } = await import('../src/stages/05-design-stitch/repairHtml.js');
  const url = 'https://lh3.googleusercontent.com/aida/AEtjO1VlS66M-abc_123';
  const broken = `<a href="#">\n${url}\n</a><div>${url}</div><footer><img alt="Bonza badge" src="${url}"></footer>`;
  const { html, repaired } = repairHtml(broken);
  assert.equal(repaired, 2);
  assert.ok(html.includes(`<img src="${url}" alt="Bonza badge"`));
  assert.ok(!/>\s*https:\/\/lh3/.test(html));
  const fine = `<img src="${url}" alt="x"><p>Visit https://example.com today</p>`;
  assert.equal(repairHtml(fine).repaired, 0);
  assert.equal(repairHtml(fine).html, fine);
});

test('lean prompt: image facts are computed by code from the asset manifest', async () => {
  const { imageFrames, aspectOf, buildLeanPrompt } = await import('../src/stages/05-design-stitch/prompts.js');
  assert.equal(aspectOf(1041, 1280), '4:5');
  assert.equal(aspectOf(400, 300), '4:3');
  assert.equal(aspectOf(300, 300), '1:1');
  const { brief } = inputs();
  const manifest = read('asset-manifest.json');
  const frames = imageFrames(manifest);
  // fixture: interior (high), mezze (high), blurry (low, excluded), logo (excluded)
  assert.deepEqual(frames.map((f) => [f.slot, f.assetId, f.aspect]), [['photo-1', 'asset-001', '4:3'], ['photo-2', 'asset-002', '1:1']]);
  const prompt = buildLeanPrompt(brief, manifest);
  assert.ok(prompt.includes('2 usable photos'));
  assert.ok(prompt.includes('photo-1 = 4:3') && prompt.includes('photo-2 = 1:1'));
  assert.ok(prompt.includes('Mezze selection'));
  assert.ok(prompt.includes('small square logo area'));
  assert.ok(!prompt.includes('blurry'));
});

test('free-style prompt: real copy and frames, but none of the creative-director style', async () => {
  const { buildFreeStylePrompt } = await import('../src/stages/05-design-stitch/prompts.js');
  const { brief, design, content } = inputs();
  const prompt = buildFreeStylePrompt({ brief, design, content });
  assert.ok(prompt.includes('Mezze, made fresh every morning'));
  assert.ok(prompt.includes('alt text "home-hero-image"'));
  assert.ok(!prompt.includes(design.styleBlock));
  assert.ok(!prompt.includes(design.layout.header));
  assert.ok(!prompt.includes(design.typography.headings));
  for (const a of design.avoid) assert.ok(!prompt.includes(a));
  assert.match(prompt, /Choose a beautiful, professional visual style yourself/);
});

test('design metrics: image areas, exact copy, palette, invented text and shapes are measured', async () => {
  const { measure, verdicts, copyStrings } = await import('../src/stages/05-design-stitch/metrics.js');
  const { brief, design, content } = inputs();
  const slots = design.pages[0].sections.flatMap((s) => s.slots.map((x) => ({ id: x.id, aspect: x.aspect })));
  const copy = copyStrings(content, 'home');
  const goodHtml = `<style>:root{--a:#1F4E3D}</style>
    <div class="aspect-[4/3]"><img alt="home-hero-image" src="x"></div><div class="aspect-square"><img alt="home-highlights-image" src="y"></div>
    <img alt="Logo badge" src="z">
    ${copy.map((c) => `<p>${c}</p>`).join('')}`;
  const opts = { slots, copy, palette: ['#1F4E3D'], brandColors: ['#1F4E3D', '#E9DCC9'], content, brief, designedSections: 3 };
  const good = measure(goodHtml, opts);
  assert.equal(good.imageAreas.found, 2);
  assert.equal(good.imageAreas.unexpected, 0);
  assert.deepEqual([good.shapes.matching, good.shapes.measurable], [2, 2]);
  assert.equal(good.copyExact.found, copy.length);
  assert.deepEqual([good.brandColors.found, good.brandColors.expected], [1, 2]);
  assert.equal(verdicts(good)['image areas: every slot present'], true);
  assert.equal(verdicts(good)['brand colors used'], false);

  const bad = measure(goodHtml.replace('alt="home-hero-image"', 'alt="hero"').replace('aspect-square', 'aspect-[3/4]') + '<img alt="stock photo" src="q"><p>Free delivery, 30-Day Guarantee 100% authentic</p>', opts);
  assert.equal(bad.imageAreas.found, 1);
  assert.equal(bad.imageAreas.unexpected, 2); // "hero" and "stock photo" are not slots
  assert.equal(bad.shapes.matching, 0);
  assert.ok(bad.invented.riskyLines >= 1);
});

test('real photos replace Stitch pictures by slot id; empty slots and the logo are handled', async () => {
  const { swapImages } = await import('../src/stages/05-design-stitch/realPhotos.js');
  const slots = new Map([['home-hero-image', 'asset-001'], ['about-story-image', null]]);
  const urlFor = (id) => `../inputs/assets/${id}.jpg`;
  const html = '<img class="a" src="https://lh3.googleusercontent.com/x" alt="home-hero-image" data-alt="a bottle"><img alt="about-story-image" src="y" srcset="z 2x"><img alt="Bonza Circular Badge Logo" src="b"><img alt="decoration" src="d">';
  const { html: out, swapped } = swapImages(html, { slots, urlFor, logoUrl: '../inputs/assets/logo.png' });
  assert.equal(swapped, 3);
  assert.ok(out.includes('src="../inputs/assets/asset-001.jpg"'));
  assert.ok(!out.includes('lh3.googleusercontent.com/x'));
  assert.ok(decodeURIComponent(out).includes('Photo needed'), 'empty slot gets a neutral photo-needed block');
  assert.ok(!out.includes('srcset'));
  assert.ok(out.includes('src="../inputs/assets/logo.png"'));
  assert.ok(out.includes('<img alt="decoration" src="d">'), 'unrelated images are left alone');
  assert.ok(out.includes('alt="home-hero-image"'), 'alt text (slot id) is kept');
  assert.equal(swapImages(out, { slots, urlFor, logoUrl: '../inputs/assets/logo.png' }).html.includes('asset-001.jpg"'), true, 'safe to run twice');
});

test('design metrics: prices of our copy must be on the Stitch page', async () => {
  const { measure, verdicts } = await import('../src/stages/05-design-stitch/metrics.js');
  const { brief, design, content } = inputs();
  brief.offerings = [{ name: 'Mezze selection', description: '', price: '$18' }, { name: 'Mixed grill', description: '', price: '$32' }];
  const copy = ['Mezze selection $18', 'Mixed grill $32'];
  const opts = { slots: [], copy, palette: [], brandColors: [], content, brief, designedSections: 1 };
  const good = measure('<p>Mezze selection $18</p><p>Mixed grill $32</p>', opts);
  assert.deepEqual([good.prices.found, good.prices.expected], [2, 2]);
  assert.equal(verdicts(good)['every price of this page is shown'], true);
  const bad = measure('<p>Mezze selection $18</p><p>Mixed grill</p>', opts);
  assert.deepEqual(bad.prices.missing, ['Mixed grill $32']);
  assert.equal(verdicts(bad)['every price of this page is shown'], false);
  // a page whose copy shows no prices expects none
  assert.equal(verdicts(measure('<p>Home</p>', { ...opts, copy: ['Welcome home'] }))['every price of this page is shown'], null);
});
