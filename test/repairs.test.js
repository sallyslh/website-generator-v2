// Tests for the automatic readability repair (no browser: the page measurements are given).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseColor, contrast, fixColor, planRepairs, applyToHtml, applyRepairs, readRepairs } from '../src/lib/repairs.js';
import { run as runQa } from '../src/stages/09-qa/index.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const rgbOf = (hex) => parseColor(`rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`);

test('the repaired colour keeps its hue and reaches the contrast; a see-through colour that was only too light just becomes solid', () => {
  const gold = parseColor('rgba(196, 142, 79, 0.4)');
  const cream = parseColor('rgb(245, 235, 221)');
  assert.ok(contrast({ r: 196, g: 142, b: 79 }, cream) < 3, 'the solid brand gold alone is not enough on this cream');
  const fixed = fixColor(gold, cream);
  const c = rgbOf(fixed);
  assert.ok(contrast(c, cream) >= 4.5, `reaches 4.5:1 (${fixed})`);
  assert.ok(c.r > c.b && c.r >= c.g, 'still a warm gold-brown, not grey');
  assert.equal(fixColor(parseColor('rgba(10, 10, 10, 0.3)'), parseColor('rgb(255, 255, 255)')), '#0a0a0a', 'a dark colour only needed to stop being see-through');
  const onDark = fixColor(parseColor('rgba(120, 90, 60, 0.5)'), parseColor('rgb(20, 20, 20)'));
  assert.ok(contrast(rgbOf(onDark), parseColor('rgb(20, 20, 20)')) >= 4.5, 'on a dark background the text is lightened');
  assert.notEqual(fixColor(gold, cream, { large: true }), fixed, 'big text only needs 3:1: a milder change');
});

test('offenders become repairs, by data-e key or by tag and class', () => {
  const items = planRepairs([
    { key: 'contact.13', tag: 'span', cls: 'x', text: 'Direct line', ratio: 1.39, large: false, fg: 'rgba(196, 142, 79, 0.4)', bg: 'rgb(245, 235, 221)' },
    { key: null, tag: 'p', cls: 'text-muted', text: 'Hours', ratio: 3.2, large: false, fg: 'rgb(150, 150, 150)', bg: 'rgb(255, 255, 255)' },
    { key: null, tag: 'p', cls: '', text: 'nowhere to put it', ratio: 2, large: false, fg: 'rgb(1,1,1)', bg: 'rgb(2,2,2)' },
  ]);
  assert.deepEqual(Object.keys(items).sort(), ['class:p|text-muted', 'contact.13']);
  assert.match(items['contact.13'].color, /^#[0-9a-f]{6}$/);
});

test('applying a repair changes only the named element, keeps its other style, and is idempotent', () => {
  const html = '<p data-e="a.1" class="faint" style="margin:4px">One</p><p data-e="a.2" class="faint">Two</p><span class="text-muted">x</span><span class="text-muted other">y</span>';
  const once = applyToHtml(html, { 'a.1': { color: '#7a5a20' }, 'class:span|text-muted': { color: '#444444' } });
  assert.match(once, /<p data-e="a\.1" class="faint" style="margin:4px;color:#7a5a20" data-fixed="color">One<\/p>/);
  assert.match(once, /<p data-e="a\.2" class="faint">Two<\/p>/, 'the other element is untouched');
  assert.match(once, /<span class="text-muted" style="color:#444444" data-fixed="color">x<\/span>/);
  assert.match(once, /<span class="text-muted other">y<\/span>/, 'a different class string is not touched');
  assert.equal(applyToHtml(once, { 'a.1': { color: '#7a5a20' } }), once, 'twice changes nothing');
  assert.match(applyToHtml(once, { 'a.1': { color: '#222222' } }), /style="margin:4px;color:#222222" data-fixed="color"/, 'a new colour replaces the old one');
});

test('QA repairs faint text, measures again, remembers the repair for a regenerated site, and reports it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  setProjectsRoot(tmp);
  try {
    const id = 'p1'; const site = projectPath(id, 'site');
    const page = '<html lang="en"><head><meta name="viewport" content="width=device-width"><title>Home page of the shop</title><meta name="description" content="A description that is long enough to be a good description for the home page of this shop."></head><body><h1>Shop</h1><span data-e="home.3" class="faint">Direct line</span></body></html>';
    fs.mkdirSync(path.join(site, 'dist'), { recursive: true }); fs.mkdirSync(path.join(site, 'src/content'), { recursive: true });
    fs.writeFileSync(path.join(site, 'dist/index.html'), page);
    fs.writeFileSync(path.join(site, 'src/content/home.html'), '<span data-e="home.3" class="faint">Direct line</span>');
    fs.writeFileSync(projectPath(id, 'approved-design.json'), JSON.stringify({ schemaVersion: 1, pages: [{ slug: 'home', html: 'x', screenId: 's1', screenshot: 'x.png' }], slotAssets: {}, approvedAt: '2026-01-01T00:00:00Z' }));
    let round = 0;
    const view = (offenders) => ({ ok: true, overflowPx: 0, overflowing: [], contrast: offenders.slice(0, 1), contrastAll: offenders, smallTargets: 0, tinyText: 0, errors: [] });
    const bad = { key: 'home.3', tag: 'span', cls: 'faint', text: 'Direct line', ratio: 1.39, large: false, fg: 'rgba(196, 142, 79, 0.4)', bg: 'rgb(245, 235, 221)' };
    const inspect = async ({ distDir }) => {
      round++;
      const fixed = /data-fixed="color"/.test(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')); // the second measurement sees the repaired page
      return { pages: [{ route: '/', mobile: view(fixed ? [] : [bad]), desktop: view(fixed ? [] : [bad]) }] };
    };
    const report = await runQa({ projectId: id, deps: { inspect } });
    assert.equal(round, 2, 'measured, repaired, measured again');
    assert.deepEqual(report.repaired.map((r) => [r.text, r.was]), [['Direct line', '1.39:1']]);
    assert.equal(report.results.find((r) => /nearly unreadable/.test(r.name)).ok, true);
    assert.match(fs.readFileSync(path.join(site, 'dist/index.html'), 'utf8'), /data-e="home\.3" class="faint" style="color:#[0-9a-f]{6}" data-fixed="color"/);
    assert.match(fs.readFileSync(path.join(site, 'src/content/home.html'), 'utf8'), /data-fixed="color"/, 'the page source is repaired too, so the next build keeps it');
    assert.equal(Object.keys(readRepairs(id).items).join(), 'home.3');
    // Stage 7 regenerates the pages from the design: the saved repair is applied again
    fs.writeFileSync(path.join(site, 'src/content/home.html'), '<span data-e="home.3" class="faint">Direct line</span>');
    assert.ok(applyRepairs(id) >= 1);
    assert.match(fs.readFileSync(path.join(site, 'src/content/home.html'), 'utf8'), /data-fixed="color"/);
    // nothing to repair: nothing is reported
    const quiet = await runQa({ projectId: id, deps: { inspect: async () => ({ pages: [{ route: '/', mobile: view([]), desktop: view([]) }] }) } });
    assert.deepEqual(quiet.repaired, []);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('white text on a mid-tone button cannot get whiter: the button background is darkened instead, and only that', () => {
  const items = planRepairs([
    // the text IS the button: white on gold, 3.3:1
    { key: 'contact.5', bgKey: 'contact.5', bgTag: 'a', bgCls: 'bg-gold', tag: 'a', cls: 'bg-gold', text: 'Order by DM', ratio: 3.3, large: false, fg: 'rgb(255, 255, 255)', bg: 'rgb(176, 124, 70)' },
    // faint see-through text on a pale band: the text is fixed, the band stays
    { key: 'contact.13', bgKey: null, bgTag: 'section', bgCls: 'band', tag: 'span', cls: 'x', text: 'Direct line', ratio: 1.39, large: false, fg: 'rgba(196, 142, 79, 0.4)', bg: 'rgb(245, 235, 221)' },
  ]);
  assert.deepEqual(Object.keys(items).sort(), ['bg:contact.5', 'contact.13']);
  const button = items['bg:contact.5'];
  assert.equal(button.prop, 'background-color');
  assert.ok(contrast({ r: 255, g: 255, b: 255 }, rgbOf(button.color)) >= 4.5, `white on ${button.color} reaches 4.5:1`);
  const was = rgbOf('#b07c46');
  const now = rgbOf(button.color);
  assert.ok(now.r < was.r && now.g < was.g && now.b < was.b && now.r > now.b, 'darker, but still the same warm gold-brown');
  assert.equal(items['contact.13'].prop, undefined, 'a text repair stays a text repair');
  // dark text on a mid-tone background is lightened
  const lighter = planRepairs([{ key: 'a.1', bgKey: 'a.1', bgTag: 'p', bgCls: 'c', tag: 'p', cls: 'c', text: 'x y', ratio: 3, large: false, fg: 'rgb(20, 20, 20)', bg: 'rgb(90, 90, 90)' }]);
  assert.ok(contrast({ r: 20, g: 20, b: 20 }, rgbOf(lighter['bg:a.1'].color)) >= 4.5 && rgbOf(lighter['bg:a.1'].color).r > 90);
  // a background that is a class of a band with no key: repaired by tag and class
  const byClass = planRepairs([{ key: null, bgKey: null, bgTag: 'div', bgCls: 'bg-mid', tag: 'p', cls: 'p-1', text: 'w', ratio: 3, large: false, fg: 'rgb(255,255,255)', bg: 'rgb(150, 110, 60)' }]);
  assert.deepEqual(Object.keys(byClass), ['bg:class:div|bg-mid']);
});

test('a colour repair and a background repair live side by side on one element without touching each other or the rest of its style', () => {
  const html = '<a data-e="c.5" class="btn" style="padding:4px;background-color:#123456">Order</a><div class="bg-mid">band</div>';
  const withBoth = applyToHtml(applyToHtml(html, { 'c.5': { color: '#ffffff' } }), { 'bg:c.5': { color: '#7a5226', prop: 'background-color' } });
  assert.match(withBoth, /style="padding:4px;color:#ffffff;background-color:#7a5226"/, 'the old background colour was replaced, the colour kept');
  assert.match(withBoth, /data-fixed="color"/);
  assert.match(withBoth, /data-fixed-bg="1"/);
  const again = applyToHtml(applyToHtml(withBoth, { 'c.5': { color: '#ffffff' } }), { 'bg:c.5': { color: '#7a5226', prop: 'background-color' } });
  assert.equal(again, withBoth, 'applying twice changes nothing');
  const changed = applyToHtml(withBoth, { 'bg:c.5': { color: '#6b4620', prop: 'background-color' } });
  assert.match(changed, /color:#ffffff;background-color:#6b4620"/);
  assert.match(applyToHtml(html, { 'bg:class:div|bg-mid': { color: '#555555' } }), /<div class="bg-mid" style="background-color:#555555" data-fixed-bg="1">band<\/div>/);
});
