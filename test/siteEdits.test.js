// Tests for the customer's edits: tagging, text and picture changes, undo, restore everything, survival of a regeneration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { tagEditable, applyToHtml, editText, editImage, undoEdit, revertAll, editState, applyEdits, readEdits, editedTexts, MAX_TEXT } from '../src/lib/siteEdits.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const HEADER = '<header><a href="/" class="logo"><div><svg class="w-9" viewbox="0 0 4 4"><circle r="2"></circle></svg></div><span class="brand">Bonza</span></a><nav><a href="/shop/">Shop</a></nav></header>';
const HOME = '<main><section><h1 class="t">Fine perfume, ordered by DM</h1><p>Original &amp; inspired scents.</p><img src="/images/asset-001.webp" alt="A box" class="w-full"/><span class="material-symbols-outlined">arrow_forward</span><form><label>Your name</label><input name="n"></form><p>01</p></section></main>';

async function withSite(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-'));
  setProjectsRoot(tmp);
  try {
    const site = projectPath('p1', 'site');
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), text); };
    const header = tagEditable(HEADER, 'shared-header');
    const home = tagEditable(HOME, 'home');
    put('src/content/_header.html', header); put('src/content/home.html', home);
    put('dist/index.html', `<html><body>${header}${home}</body></html>`);
    await fn({ site, header, home, read: (rel) => fs.readFileSync(path.join(site, rel), 'utf8') });
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('tagging: words and pictures and the logo get a key; icons, forms, numbers and pieces with markup do not', () => {
  const home = tagEditable(HOME, 'home');
  assert.match(home, /<h1 data-e="home\.0" class="t">Fine perfume/);
  assert.match(home, /<p data-e="home\.1">Original &amp; inspired scents\.<\/p>/);
  assert.match(home, /<img data-e="home\.img0" src=/);
  assert.ok(!/material-symbols[^>]*data-e|data-e[^>]*material-symbols/.test(home), 'icon glyph names are not text');
  assert.ok(!/<label data-e/.test(home), 'form texts are left alone');
  assert.ok(!/<p data-e="home\.\d+">01/.test(home), 'a number alone is not editable text');
  const header = tagEditable(HEADER, 'shared-header');
  assert.match(header, /<svg data-e="site.logo" class="w-9"/);
  assert.equal(tagEditable(header, 'shared-header'), header, 'tagging twice changes nothing');
});

test('a text edit changes the sources and the built page at once, escapes what was typed, and keeps the original', async () => {
  await withSite(async ({ read }) => {
    const state = editText('p1', 'home.0', 'Perfumes <b>you</b> will love & wear');
    assert.deepEqual(state.changes.map((c) => [c.key, c.before, c.after]), [['home.0', 'Fine perfume, ordered by DM', 'Perfumes <b>you</b> will love & wear']]);
    for (const rel of ['src/content/home.html', 'dist/index.html']) assert.match(read(rel), /<h1 data-e="home\.0" class="t">Perfumes &lt;b&gt;you&lt;\/b&gt; will love &amp; wear<\/h1>/);
    assert.ok(!/Fine perfume/.test(read('dist/index.html')));
    assert.ok(fs.existsSync(projectPath('p1', 'edits/original-content/home.html')), 'a pristine copy is kept');
    assert.match(fs.readFileSync(projectPath('p1', 'edits/original-content/home.html'), 'utf8'), /Fine perfume, ordered by DM/);
    assert.deepEqual(editedTexts('p1'), ['Perfumes <b>you</b> will love & wear']);
  });
});

test('undo goes back one step at a time, then to the original; restore everything puts back all of it', async () => {
  await withSite(async ({ read, home }) => {
    editText('p1', 'home.0', 'First');
    editText('p1', 'home.0', 'Second');
    editText('p1', 'home.1', 'Other');
    assert.match(read('dist/index.html'), />Second</);
    undoEdit('p1', 'home.0');
    assert.match(read('dist/index.html'), />First</);
    const s = undoEdit('p1', 'home.0');
    assert.equal(s.changes.some((c) => c.key === 'home.0'), false);
    assert.match(read('src/content/home.html'), />Fine perfume, ordered by DM</);
    assert.throws(() => undoEdit('p1', 'home.0'), /nothing to undo/);
    const after = revertAll('p1');
    assert.deepEqual(after.changes, []);
    assert.equal(read('src/content/home.html'), home, 'the generated page is exactly as before');
  });
});

test('a picture edit: any photo is made web-sized, the alt text is required, the original element is restorable, the logo can be replaced too', async () => {
  await withSite(async ({ site, read, home, header }) => {
    const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    await assert.rejects(editImage('p1', 'home.img0', { bytes: photo, alt: '' }), /describe the picture/);
    await assert.rejects(editImage('p1', 'home.img0', { bytes: Buffer.from('not a picture'), alt: 'A box' }), /not a picture we can use/);
    const s = await editImage('p1', 'home.img0', { bytes: photo, alt: 'Our new window display' });
    const src = s.changes[0].picture;
    assert.match(src, /^\/images\/edit-[0-9a-f]{10}\.webp$/);
    assert.match(read('dist/index.html'), new RegExp(`<img data-e="home\\.img0" src="${src.replace(/[./]/g, '\\$&')}" alt="Our new window display" class="w-full"/>`));
    const file = path.join(site, 'dist', src);
    assert.ok(fs.existsSync(file) && fs.existsSync(path.join(site, 'originals', path.basename(src))), 'visible now and kept for the next build');
    assert.equal((await sharp(fs.readFileSync(file)).metadata()).width, 1600);
    await editImage('p1', 'site.logo', { bytes: photo, alt: 'Bonza logo' });
    assert.match(read('src/content/_header.html'), /<img data-e="site.logo" src="\/images\/edit-[0-9a-f]{10}\.webp" alt="Bonza logo" class="w-9"/);
    assert.ok(!/<svg/.test(read('src/content/_header.html')), 'the drawn logo is replaced');
    revertAll('p1');
    assert.equal(read('src/content/home.html'), home);
    assert.equal(read('src/content/_header.html'), header, 'the drawn logo is back');
  });
});

test('edits survive a regeneration of the site; ones that lost their place are reported, not forced', async () => {
  await withSite(async ({ site, read }) => {
    editText('p1', 'home.0', 'Mine');
    await editImage('p1', 'home.img0', { bytes: await sharp({ create: { width: 100, height: 100, channels: 3, background: '#aa0000' } }).png().toBuffer(), alt: 'Red square' });
    // Stage 7 regenerates everything: the folder is emptied and written again from the design
    fs.rmSync(site, { recursive: true, force: true });
    fs.mkdirSync(path.join(site, 'src/content'), { recursive: true });
    fs.writeFileSync(path.join(site, 'src/content/home.html'), tagEditable(HOME, 'home'));
    fs.writeFileSync(path.join(site, 'src/content/_header.html'), tagEditable(HEADER, 'shared-header'));
    assert.deepEqual(applyEdits('p1'), { missing: [] });
    assert.match(read('src/content/home.html'), />Mine</);
    assert.ok(fs.readdirSync(path.join(site, 'originals')).some((f) => /^edit-/.test(f)), 'the picture is back for the build');
    // the new design has no such paragraph any more
    fs.writeFileSync(path.join(site, 'src/content/home.html'), tagEditable('<main><h1>New</h1></main>', 'home'));
    assert.deepEqual(applyEdits('p1').missing, ['home.1'].filter((k) => k in readEdits('p1').items).concat(['home.img0']).sort());
  });
});

test('limits and bad keys are refused with plain words', async () => {
  await withSite(async () => {
    assert.throws(() => editText('p1', 'home.0', '   '), /cannot be empty/);
    assert.throws(() => editText('p1', 'home.0', 'x'.repeat(MAX_TEXT + 1)), /too long/);
    assert.throws(() => editText('p1', '../etc.0', 'x'), /not found|reload/);
    assert.throws(() => editText('p1', 'home.99', 'x'), /changed|reload/);
    assert.throws(() => editText('p1', 'home.img0', 'x'), /changed|reload/);
    assert.equal(editState('p1').ready, true);
    assert.equal(editState('nope').ready, false);
  });
});

test('applyToHtml is pure and idempotent', () => {
  const html = tagEditable('<p>Hello</p>', 'home');
  const items = { 'home.0': { kind: 'text', originalRaw: 'Hello', current: 'Bye' } };
  const once = applyToHtml(html, items).html;
  assert.equal(applyToHtml(once, items).html, once);
  assert.deepEqual(applyToHtml(html, { 'home.7': items['home.0'] }).missing, ['home.7']);
});
