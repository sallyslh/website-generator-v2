// Tests for the "generate first" customer page and its pipeline pieces (no API calls: the pipeline is a fake).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWowServer } from '../src/server/wow.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { orderPages, withExtraPages, loadType, slugOf } from '../src/wow/run.js';
import { largePictureUrls, linkPages } from '../src/wow/assemble.js';

setProjectsRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'wow-')));

async function start(runJob) {
  const { server, jobs } = createWowServer({ runJob });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => { const res = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: res.status, data: await res.json().catch(() => ({})) }; };
  return { call, jobs, close: () => server.close() };
}
const wait = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

test('pages: exactly what the customer chose (Home first and Contact last when kept), unknown ids dropped, custom pages added, nothing forced', () => {
  const t = withExtraPages(loadType('padel'), ['Our delivery areas']);
  assert.deepEqual(orderPages(t, ['courts', 'nonsense', 'book', 'contact', 'our-delivery-areas']), ['courts', 'book', 'our-delivery-areas', 'contact']); // no Home was chosen: none is added
  assert.deepEqual(orderPages(t, ['courts', 'contact', 'home', 'book']), ['home', 'courts', 'book', 'contact']);
  assert.equal(slugOf('Café & Lounge!'), 'cafe-lounge');
});

test('pictures shown large are found; small cards are not', () => {
  const u = (n) => `https://lh3.googleusercontent.com/aida-public/${n}`;
  const html = `<img src="${u('hero')}" class="w-full h-full object-cover"><img src="${u('card')}" class="w-24 h-24"><img src="${u('bg')}" class="absolute inset-0 w-full h-full">`;
  assert.deepEqual(largePictureUrls(html).sort(), [u('bg'), u('hero')].sort());
});

test('links: a menu word goes to its page and sample contact links are switched off', () => {
  const pages = [{ slug: 'home', title: 'Home', navLabel: 'Home' }, { slug: 'courts', title: 'Our courts', navLabel: 'Courts' }];
  const { html } = linkPages('<a href="#">Courts</a><a href="tel:+15550100">Call</a><a href="https://example.org">x</a>', pages);
  assert.match(html, /href="courts\.html"/);
  assert.match(html, /<a href="#">Call<\/a>/);
  assert.match(html, /https:\/\/example\.org/);
});

test('the page serves the screens and lists the business types', async () => {
  const s = await start(async () => {});
  try {
    const types = await s.call('/api/types');
    assert.equal(types.status, 200);
    assert.ok(types.data.types.some((t) => t.id === 'padel' && t.ready));
  } finally { s.close(); }
});

test('page cards come from the type file; a known type costs nothing', async () => {
  const s = await start(async () => {});
  try {
    const r = await s.call('/api/pages', { type: 'padel' });
    assert.equal(r.status, 200);
    assert.equal(r.data.type, 'padel');
    assert.ok(r.data.pages.length >= 20);
    assert.ok(r.data.pages.every((p) => p.locked === false), 'nothing is forced on the customer');
    assert.equal(r.data.pages.filter((p) => p.default).length >= 5, true);
    assert.equal((await s.call('/api/pages', { type: '', label: '' })).status, 400);
  } finally { s.close(); }
});

test('generating: needs a name and 3 pages, runs in the background, reports progress and the finished site', async () => {
  const seen = [];
  const s = await start(async ({ projectId, options }) => {
    seen.push(options);
    options.onProgress({ type: 'step', key: 'brief', status: 'done', concept: 'A test idea', pages: [{ slug: 'home', title: 'Welcome' }] });
    options.onProgress({ type: 'page', slug: 'home', status: 'done' });
    options.onProgress({ type: 'preview' });
    fs.mkdirSync(projectPath(projectId, 'wow-site'), { recursive: true });
  });
  try {
    assert.equal((await s.call('/api/generate', { name: 'X', type: 'padel', pages: ['home'] })).status, 400); // name too short
    assert.equal((await s.call('/api/generate', { name: 'Smash', type: 'padel', pages: ['home', 'contact'] })).status, 400); // fewer than 3 pages
    assert.equal((await s.call('/api/generate', { name: 'Smash', type: 'padel', pages: ['courts', 'book', 'coaches'] })).status, 200); // no Home and no Contact is fine
    assert.equal((await s.call('/api/generate', { name: 'Smash', type: 'nonexistent-type', pages: ['home', 'courts', 'contact'] })).status, 400);
    const ok = await s.call('/api/generate', { name: 'Smash Point', type: 'padel', pages: ['home', 'courts', 'book', 'bogus'], extraPages: ['Our delivery areas'], language: 'French' });
    assert.equal(ok.status, 200);
    const id = ok.data.id;
    const done = await wait(async () => { const r = await s.call(`/api/status/${id}`); return r.data.state === 'done' ? r.data : null; });
    assert.equal(done.concept, 'A test idea');
    assert.equal(done.previewReady, true);
    assert.equal(done.pages.find((p) => p.slug === 'home').title, 'Welcome');
    assert.equal(done.internalError, undefined);
    const french = seen.find((o) => o.language === 'French');
    assert.deepEqual(french.pages, ['home', 'courts', 'book', 'our-delivery-areas']); // Contact was not chosen, so it is not added
    assert.deepEqual(seen.find((o) => o.language === 'English').pages, ['courts', 'book', 'coaches']);
    assert.equal(french.language, 'French');
    assert.equal((await s.call('/api/status/not-an-id')).status, 404);
    assert.equal((await s.call('/api/status/w-0000000000')).status, 404);
  } finally { s.close(); }
});

test('a failed website shows a friendly message and never the inside error', async () => {
  const s = await start(async () => { throw new Error('Stitch exploded at line 12 with key sk-secret'); });
  try {
    const { data } = await s.call('/api/generate', { name: 'Smash Point', type: 'restaurant', pages: ['home', 'menu', 'contact'] });
    const failed = await wait(async () => { const r = await s.call(`/api/status/${data.id}`); return r.data.state === 'failed' ? r.data : null; });
    assert.match(failed.error, /try again/i);
    assert.equal(JSON.stringify(failed).includes('sk-secret'), false);
  } finally { s.close(); }
});

test('the site files are served only from a real website folder', async () => {
  const s = await start(async () => {});
  try {
    assert.equal((await s.call('/site/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await s.call('/site/w-0000000000/index.html')).status, 404);
  } finally { s.close(); }
});

test('drafted page lists: legal and account pages are dropped, a feature page keeps its feature, capped, Home and Contact kept', async () => {
  const { tidyPages, MAX_DRAFT_PAGES } = await import('../src/wow/typeResearch.js');
  const mk = (id, title, extra = {}) => ({ id, title, purpose: 'x', default: false, feature: '', ...extra });
  const many = Array.from({ length: 40 }, (_, i) => mk(`p${i}`, `Page ${i}`));
  const list = tidyPages([mk('home', 'Home', { default: true, locked: true }), mk('contact', 'Contact', { default: true, locked: true }), mk('privacy', 'Privacy & Terms'), mk('acct', 'My Account & Wishlist'), mk('news', 'Newsletter Sign-up'),
    mk('book', 'Book', { feature: 'booking', default: true }), mk('kids', 'Kids <booking>', { feature: 'booking' }), mk('shop', 'Shop', { feature: 'order' }), mk('gift', 'Gift cards', { feature: 'order' }), ...many]);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('home') && ids.includes('contact'));
  assert.equal(ids.some((i) => ['privacy', 'acct', 'news'].includes(i)), false);
  assert.equal(list.find((p) => p.id === 'book').feature, 'booking');
  assert.ok(list.length <= MAX_DRAFT_PAGES);
});

test('merging duplicate pages: the merged list keeps Home and Contact, keeps what was joined, and always has at least 4 pre-ticked pages', async () => {
  const { draftType } = await import('../src/wow/typeResearch.js');
  const pg = (id, title, extra = {}) => ({ id, title, purpose: 'purpose of ' + title, default: false, feature: '', featureNote: '', demoNeeds: [], ...extra });
  const calls = [];
  const ask = async ({ stage }) => {
    calls.push(stage);
    if (stage === 'wow-type') return { pages: [pg('home', 'Home'), pg('book', 'Book a court', { feature: 'booking' }), pg('timetable', 'Weekly timetable'), pg('availability', 'Court availability'), pg('contact', 'Contact'), pg('a', 'A'), pg('b', 'B'), pg('c', 'C')], homeSectionIdeas: ['x'], styleNotes: ['y'] };
    return { // the merge step: joins three booking pages and "forgets" Contact on purpose
      pages: [{ ...pg('home', 'Home'), uniqueContent: 'The first impression of the club.', mergedFrom: ['home'] }, { ...pg('book', 'Book a court', { feature: 'booking' }), uniqueContent: 'Pick a court, day and time.', mergedFrom: ['book', 'timetable', 'availability'] },
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((i) => ({ ...pg(i, i.toUpperCase()), uniqueContent: 'Its own content ' + i, mergedFrom: [i] }))],
      merges: [{ kept: 'book', absorbed: ['timetable', 'availability'], why: 'the same booking idea' }],
    };
  };
  const d = await draftType({ id: 'test-club', label: 'Test club', ask });
  assert.deepEqual(calls, ['wow-type', 'wow-type-merge', 'wow-type-review']); // draft, merge, then the editor reads the result
  assert.ok(d.pages.some((p) => p.id === 'contact' && p.tier === 'essential'), 'Contact is suggested again when the merge forgets it');
  assert.ok(d.pages.every((p) => !p.locked), 'nothing is locked: the customer may remove any page');
  assert.ok(d.pages.some((p) => p.id === 'home' && p.tier === 'essential'));
  assert.equal(d.pages.some((p) => ['timetable', 'availability'].includes(p.id)), false);
  assert.deepEqual(d.pages.find((p) => p.id === 'book').mergedFrom, ['book', 'timetable', 'availability']);
  assert.equal(d.merges.length, 1);
  assert.equal(d.draftPages, 8);
  assert.ok(d.pages.filter((p) => p.default).length >= 4);
  const noMerge = await draftType({ id: 'test-club', label: 'Test club', merge: false, ask });
  assert.equal(noMerge.pages.length, 8);
});

test('page cards are ordered from the most to the least important, in three tiers, with their sections', async () => {
  const { tierOf } = await import('../src/wow/typeResearch.js');
  assert.equal(tierOf({ tier: 'optional', default: true }), 'optional');
  assert.equal(tierOf({ locked: true }), 'essential');
  assert.equal(tierOf({ evidence: 'seen' }), 'recommended'); // a hand-researched file has no tiers
  assert.equal(tierOf({ evidence: 'idea' }), 'optional');
  const s = await start(async () => {});
  try {
    const r = await s.call('/api/pages', { type: 'padel' });
    const order = { essential: 0, recommended: 1, optional: 2 };
    const tiers = r.data.pages.map((p) => order[p.tier]);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
    assert.equal(r.data.pages[0].tier, 'essential');
    assert.ok(r.data.pages.every((p) => Array.isArray(p.sections)));
    assert.equal(r.data.tiers.essential, 'Most important');
  } finally { s.close(); }
});

test('the editor: repeated sections go to their owner, thin or duplicate pages are merged, unclear names get the standard name', async () => {
  const { applyReview } = await import('../src/wow/listReview.js');
  const sec = (t) => ({ title: t, content: 'c' });
  const pg = (id, title, sections, extra = {}) => ({ id, title, tier: 'recommended', purpose: 'p', uniqueContent: 'u', sections: sections.map(sec), mergedFrom: [id], feature: '', featureNote: '', demoNeeds: [], ...extra });
  const pages = [pg('home', 'Home', ['Hero', 'Preview', 'Find us'], { tier: 'essential' }), pg('cakes', 'Cakes', ['Birthday cakes', 'Cake tasting', 'How to order'], { tier: 'essential' }),
    pg('classes', 'Classes', ['Adult classes', 'Cake tasting', 'Kids classes']), pg('love', 'Customer Love', ['Reviews', 'Awards', 'Press']), pg('reviews', 'Reviews', ['Testimonials', 'Ratings'], { evidence: 'seen' }),
    pg('bakers', 'Meet the Bakers', ['The bakers', 'Pastry team']), pg('contact', 'Contact', ['Hours', 'Map'], { tier: 'essential' })];
  const { pages: out, applied } = applyReview(pages, {
    repeats: [{ content: 'cake tasting', owner: 'cakes', removeFrom: 'classes', section: 'Cake tasting' }, { content: 'x', owner: 'cakes', removeFrom: 'contact', section: 'Hours' }], // Contact has only two sections: it keeps both
    samePages: [{ keep: 'reviews', absorb: 'love', why: 'same idea' }],
    thinPages: [{ id: 'contact', mergeInto: 'home', why: 'must never be merged away' }],
    unclearNames: [{ id: 'bakers', better: 'Team' }, { id: 'cakes', better: 'A very long clever name for the cake page' }],
  });
  assert.equal(out.find((p) => p.id === 'classes').sections.some((s) => s.title === 'Cake tasting'), false);
  assert.equal(out.find((p) => p.id === 'cakes').sections.some((s) => s.title === 'Cake tasting'), true, 'the owner keeps it');
  assert.equal(out.find((p) => p.id === 'contact').sections.length, 2, 'a page never goes below two sections');
  assert.ok(out.some((p) => p.id === 'contact'), 'Contact is never merged away');
  assert.equal(out.some((p) => p.id === 'love'), false);
  assert.deepEqual(out.find((p) => p.id === 'reviews').sections.map((s) => s.title), ['Testimonials', 'Ratings', 'Reviews', 'Awards', 'Press']);
  assert.equal(out.find((p) => p.id === 'bakers').title, 'Team');
  assert.equal(out.find((p) => p.id === 'cakes').title, 'Cakes', 'a long name is not accepted as a better name');
  assert.equal(applied.removedSections.length, 1); assert.equal(applied.merged.length, 1); assert.equal(applied.renamed.length, 1);
  assert.equal(pages.find((p) => p.id === 'classes').sections.length, 3, 'the input list is not changed');
});

test('the editor reads again after fixing, stops when clean, and never fails a list when it cannot work', async () => {
  const { reviewAndRepair } = await import('../src/wow/listReview.js');
  const pg = (id, title, n) => ({ id, title, tier: 'recommended', sections: Array.from({ length: n }, (_, i) => ({ title: `${id}-${i}`, content: '' })), mergedFrom: [id], demoNeeds: [] });
  const pages = [pg('a', 'A page', 3), pg('b', 'Customer Love', 3)];
  const answers = [{ unclearNames: [{ id: 'b', better: 'Reviews' }] }, {}];
  let calls = 0;
  const r = await reviewAndRepair({ label: 'Test', pages, ask: async () => answers[calls++] });
  assert.equal(calls, 2, 'one reading, one fix, one confirming reading');
  assert.equal(r.pages[1].title, 'Reviews');
  assert.deepEqual(r.report.remaining, []);
  const broken = await reviewAndRepair({ label: 'Test', pages, ask: async () => { throw new Error('network down'); } });
  assert.equal(broken.pages.length, 2);
  assert.match(broken.report.note, /could not finish/);
  let n = 0;
  const stubborn = await reviewAndRepair({ label: 'Test', pages, ask: async () => { n++; return { unclearNames: [{ id: 'a', better: 'Services' }] }; } });
  assert.equal(n, 3, 'at most two repairs and a final reading');
  assert.ok(stubborn.report.remaining.length > 0, 'what is left is reported, not hidden');
});

test('links: a menu word goes to its page even when the design drew an in-page anchor; other anchors are kept', () => {
  const pages = [{ slug: 'home', title: 'Home', navLabel: 'Home' }, { slug: 'coaches', title: 'Coaches & team', navLabel: 'Coaches' }, { slug: 'academy', title: 'Academy', navLabel: 'Academy' }, { slug: 'contact', title: 'Contact', navLabel: 'Contact' }];
  const html = '<section id="home-coaches"></section><section id="home-visit"></section><a href="#home-coaches">Coaches</a><a href="#home-coaches">Academy</a><a href="#home-visit">Contact</a><a href="#home-visit">See opening hours</a>';
  const out = linkPages(html, pages).html;
  assert.match(out, /href="coaches\.html">Coaches</);
  assert.match(out, /href="academy\.html">Academy</);
  assert.match(out, /href="contact\.html">Contact</);
  assert.match(out, /href="#home-visit">See opening hours</, 'a link that is not a menu word keeps its anchor');
});
