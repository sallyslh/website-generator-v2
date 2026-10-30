// Tests for removing counters / watermarks from photos, generic links and undrawn pictures (no network: the vision model is faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cropAwayOverlays, cleanPhoto } from '../src/lib/overlays.js';
import { cleanOverlays } from '../src/stages/03-creative-director/cleanOverlays.js';
import { hasOverlay, normalizeRecipes } from '../src/stages/03-creative-director/compose.js';
import { resolveLinks, offerPage } from '../src/stages/07-site/transform.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { flags as composeFlags } from '../src/stages/03-creative-director/compose.js';
composeFlags.collages = true; // this file tests the collage maker itself (collages are OFF in real projects)

test('the thinnest edge strip that takes an overlay out is chosen, and a photo is left alone when too much would be lost', () => {
  // a counter in the top right corner: cut the top strip, not the right strip
  const corner = cropAwayOverlays([{ x: 0.82, y: 0.02, width: 0.14, height: 0.06 }]);
  assert.ok(corner.top > 0.08 && corner.top < 0.12 && corner.right === 0 && corner.left === 0 && corner.bottom === 0);
  assert.ok(corner.loss < 0.12);
  // two overlays: the cuts are combined
  const two = cropAwayOverlays([{ x: 0.82, y: 0.02, width: 0.14, height: 0.06 }, { x: 0.02, y: 0.92, width: 0.2, height: 0.06 }]);
  assert.ok(two.top > 0 && two.bottom > 0);
  // an overlay in the middle of the photo cannot be cropped away
  assert.equal(cropAwayOverlays([{ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }]), null);
  assert.deepEqual(cropAwayOverlays([]), { top: 0, bottom: 0, left: 0, right: 0, loss: 0 });
});

test('a photo with a counter is cleaned by cropping; the original is untouched and the result is the real photo, smaller', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  try {
    const file = path.join(tmp, 'p.jpg');
    await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#aa5533' } }).jpeg().toFile(file);
    const out = path.join(tmp, 'cleaned', 'p.jpg');
    const find = async () => ({ overlays: [{ x: 0.8, y: 0.02, width: 0.15, height: 0.07 }], note: '' });
    const done = await cleanPhoto({ file, out, find });
    assert.equal(done.cleaned, true);
    assert.ok(done.width === 1000 && done.height < 930 && done.height > 880, `${done.width}x${done.height}`);
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.width, meta.height], [done.width, done.height]);
    assert.equal((await sharp(file).metadata()).height, 1000, 'the original is untouched');
    assert.equal((await cleanPhoto({ file, out, find: async () => ({ overlays: [] }) })).cleaned, false);
    assert.match((await cleanPhoto({ file, out, find: async () => ({ overlays: [{ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }] }) })).reason, /too far inside/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the project step: only photos whose notes mention an overlay are cleaned, the manifest points to the cleaned copy and remembers the original', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  setProjectsRoot(tmp);
  try {
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    for (const n of ['a', 'b']) await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#335577' } }).jpeg().toFile(projectPath('p1', `inputs/assets/${n}.jpg`));
    const asset = (id, notes) => ({ id, file: `inputs/assets/${id.slice(-1)}.jpg`, hash: '', kind: 'image', category: 'product', description: 'x', quality: 'high', orientation: 'portrait', width: 800, height: 1000, dominantColors: [], usableFor: [], notes });
    const manifest = { assets: [asset('asset-a', 'Instagram slideshow counter (1/3) at the top right.'), asset('asset-b', 'Clean photo.')] };
    assert.deepEqual([hasOverlay(manifest.assets[0]), hasOverlay(manifest.assets[1])], [true, false]);
    const calls = [];
    const find = async ({ file }) => { calls.push(path.basename(file)); return { overlays: [{ x: 0.78, y: 0.02, width: 0.17, height: 0.05 }], note: '' }; };
    const result = await cleanOverlays({ projectId: 'p1', manifest, find });
    assert.deepEqual(result.cleaned, ['asset-a']);
    assert.deepEqual(calls, ['a.jpg'], 'the clean photo is not even looked at');
    const a = manifest.assets[0];
    assert.deepEqual([a.file, a.originalFile, a.overlayRemoved], ['inputs/cleaned/asset-a.jpg', 'inputs/assets/a.jpg', true]);
    assert.ok(a.height < 1000 && fs.existsSync(projectPath('p1', a.file)));
    assert.equal(hasOverlay(a), false, 'after cleaning, the photo may go into collages');
    // running again does nothing more
    assert.deepEqual((await cleanOverlays({ projectId: 'p1', manifest, find })).cleaned, []);
    // and a cleaned photo is now allowed in a collage
    const design = { pages: [{ slug: 'home', sections: [{ id: 's', slots: [{ id: 's-image', kind: 'image', description: '', assignedAsset: null, recipe: { type: 'collage', sources: ['asset-a', 'asset-b'], reason: '' } }] }] }] };
    assert.deepEqual(normalizeRecipes(design, manifest), []);
    assert.equal(design.pages[0].sections[0].slots[0].recipe.type, 'collage');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('generic link words ("view", "see all") go to the page that lists the offer', () => {
  assert.equal(offerPage([{ slug: 'home', title: 'Home' }, { slug: 'about', title: 'About' }, { slug: 'products', title: 'Products' }]), 'products');
  assert.equal(offerPage([{ slug: 'home', title: 'Home' }, { slug: 'contact', title: 'Contact' }]), null);
  const html = '<a href="#">view</a><a href="#">See all</a><a href="#">Mystery</a>';
  const args = { labelTargets: new Map(), businessName: 'Shop', socials: new Map(), formPage: null, slugs: new Set(['home', 'products']) };
  const withPage = resolveLinks(html, { ...args, genericPage: 'products' });
  assert.equal(withPage.html, '<a href="/products/">view</a><a href="/products/">See all</a><a href="#">Mystery</a>');
  assert.deepEqual(withPage.unresolved, ['mystery']);
  assert.deepEqual(resolveLinks(html, args).unresolved, ['view', 'see all', 'mystery'], 'without an offer page nothing is guessed');
});

test('a decision the customer already made about a picture survives when the same picture is built again', async () => {
  const { composeImages } = await import('../src/stages/03-creative-director/compose.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
  setProjectsRoot(tmp);
  try {
    fs.mkdirSync(projectPath('p1', 'inputs/assets'), { recursive: true });
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#335577' } }).jpeg().toFile(projectPath('p1', 'inputs/assets/a.jpg'));
    const asset = { id: 'asset-a', file: 'inputs/assets/a.jpg', hash: '', kind: 'image', category: 'product', description: 'x', quality: 'high', orientation: 'landscape', width: 800, height: 600, dominantColors: [], usableFor: [], notes: '' };
    const manifest = { assets: [asset] };
    const slot = { id: 'home-band-image', kind: 'image', description: '', aspect: '4:3', assignedAsset: null, recipe: { type: 'atmosphere', sources: [], subject: 'dried petals on linen', style: 'soft', reason: '' } };
    const crop = { id: 'home-card-image', kind: 'image', description: '', aspect: '1:1', assignedAsset: null, recipe: { type: 'crop', sources: ['asset-a'], target: 'the cup', reason: '' } };
    const design = { pages: [{ slug: 'home', sections: [{ id: 's', slots: [slot, crop] }] }] };
    const deps = {
      generateImage: async () => ({ buffer: await sharp({ create: { width: 1152, height: 864, channels: 3, background: '#ddccbb' } }).jpeg().toBuffer(), width: 1152, height: 864, cost: 0.0119 }),
      cropItem: async () => ({ buffer: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#112233' } }).jpeg().toBuffer(), width: 300, height: 300, region: {} }),
    };
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.deepEqual(manifest.assets.filter((a) => a.origin).map((a) => a.approval), ['pending', 'pending'].reverse());
    manifest.assets.find((a) => a.origin === 'generated').approval = 'approved';
    manifest.assets.find((a) => a.origin === 'crop').approval = 'rejected';
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(manifest.assets.find((a) => a.origin === 'generated').approval, 'approved', 'the approved mood picture stays approved');
    assert.equal(manifest.assets.find((a) => a.origin === 'crop').approval, 'rejected', 'the rejected crop stays rejected');
    // a different subject is a different picture: it starts undecided
    slot.recipe.subject = 'folded cream linen';
    await composeImages({ projectId: 'p1', design, manifest, deps });
    assert.equal(manifest.assets.find((a) => a.origin === 'generated').approval, 'pending');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
