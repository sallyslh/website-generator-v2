// Tests for "every button goes where a visitor expects": the link audit, the decisions (by name, then one model call), and the friendly note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameIdea, duplicateDestinations, classify, linksOf, auditSite } from '../src/wow/linkAudit.js';
import { fixLinks, collectQuestions, pagesByName, applyDecisions, keyOf } from '../src/wow/linkFix.js';
import { linkPages } from '../src/wow/assemble.js';
import { GUARD_JS, GUARD_CSS } from '../src/wow/polish.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
const PAGES = [
  { slug: 'home', title: 'Home', navLabel: 'Home', purpose: 'The entry page' },
  { slug: 'women', title: "Women's fragrances", navLabel: 'Women', purpose: 'Perfumes for women' },
  { slug: 'men', title: "Men's fragrances", navLabel: 'Men', purpose: 'Perfumes for men' },
  { slug: 'brands', title: 'Brands', navLabel: 'Brands', purpose: 'The brands we carry' },
];
const site = (extra = '') => {
  const dir = tmp();
  const head = '<header><a href="#">Bonza</a><nav><a href="#home-families">Women</a><a href="#home-families">Men</a></nav></header>';
  fs.writeFileSync(path.join(dir, 'index.html'), `<html><body>${head}<section id="home-families"></section><section id="home-featured"></section>
    <a href="#home-families">View all brands</a><a href="#">Privacy Policy</a><a href="gift-cards.html">Gift Cards</a><a href="#home-featured">See the details</a>${extra}</body></html>`);
  for (const f of ['women', 'men', 'brands']) fs.writeFileSync(path.join(dir, `${f}.html`), `<html><body>${head}<h1>${f}</h1></body></html>`);
  return dir;
};

test('two buttons are one idea when their words overlap ("Book" and "Book a Court"), and two ideas when they do not', () => {
  assert.equal(sameIdea('Book', 'Book a Court'), true);
  assert.equal(sameIdea('Contact', 'Contact us'), true);
  assert.equal(sameIdea('Coaches', 'Academy'), false);
  assert.equal(sameIdea('Women', 'Men'), false);
});

test('the audit finds buttons that go nowhere, to a missing page, and different buttons reaching the same place', () => {
  const dir = site();
  const r = auditSite(dir, { businessName: 'Bonza' });
  const home = r.pages.find((p) => p.file === 'index.html');
  assert.ok(home.dead.includes('Privacy Policy'));
  assert.ok(home.missing.some((m) => m.includes('gift-cards.html')));
  assert.ok(home.duplicates.some((d) => d.dest === 'index.html#home-families' && d.labels.includes('Women') && d.labels.includes('Men')));
  assert.equal(home.duplicates.some((d) => d.labels.includes('Bonza')), false, 'the logo and Home lead to the same place on purpose');
});

test('a link that starts with a slash is reported (it breaks when a site sits in a folder on the internet)', () => {
  assert.equal(classify({ href: '/courts', label: 'Courts', ids: new Set() }, 'index.html', ['index.html']).kind, 'root-relative');
});

test('the decisions: names are decided without the model, the rest by ONE call, nothing sent to the wrong place', async () => {
  const dir = site();
  let calls = 0; let asked = null;
  const ask = async ({ prompt }) => {
    calls++; asked = prompt;
    return { links: [{ id: 1, to: 'brands' }, { id: 2, to: 'none' }, { id: 3, to: 'keep' }] }; // Privacy Policy is never asked: legal links are always inert
  };
  const r = await fixLinks({ dir, pages: PAGES, entry: 'home', businessName: 'Bonza', ask });
  assert.equal(calls, 1);
  assert.doesNotMatch(asked, /"label":"Women"/, 'a menu word that is a page name is not sent to the model');
  const home = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(home, /<a href="women\.html">Women<\/a>/);
  assert.match(home, /<a href="men\.html">Men<\/a>/);
  assert.match(home, /<a href="index\.html">Bonza<\/a>/, 'the logo goes to the entry page');
  assert.equal(r.asked, 3, 'View all brands, Gift Cards and See the details: the legal link and the names are not asked');
  const audit = auditSite(dir, { businessName: 'Bonza' });
  assert.equal(audit.totals.missing, 0, 'no link to a page that does not exist');
  assert.equal(audit.totals.duplicates, 0, 'no two different buttons reach the same place');
});

test('what the model answers is checked: an unknown page becomes inert, and "none" keeps the page from jumping to the top', async () => {
  const dir = site();
  const ask = async () => ({ links: [{ id: 1, to: 'no-such-page' }, { id: 2, to: 'none' }, { id: 3, to: 'keep' }] });
  await fixLinks({ dir, pages: PAGES, entry: 'home', businessName: 'Bonza', ask });
  const home = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(home, /<a href="#" data-inert>View all brands<\/a>/);
  assert.match(home, /<a href="#" data-inert>Privacy Policy<\/a>/);
  assert.match(home, /<a href="#home-featured">See the details<\/a>/, '"keep": a link to a spot of the same page stays');
});

test('when the model fails the site is not broken: named links still work and the others become inert', async () => {
  const dir = site();
  const r = await fixLinks({ dir, pages: PAGES, entry: 'home', businessName: 'Bonza', ask: async () => { throw new Error('network down'); } });
  assert.match(r.note, /inert/);
  const home = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(home, /<a href="women\.html">Women<\/a>/);
  assert.match(home, /<a href="#" data-inert>Gift Cards<\/a>/);
});

test('the decisions are remembered: a second build asks nothing again', async () => {
  const dir = site();
  const root = tmp();
  const { setProjectsRoot } = await import('../src/lib/project.js');
  setProjectsRoot(root);
  let calls = 0;
  const ask = async () => { calls++; return { links: [{ id: 1, to: 'brands' }, { id: 2, to: 'none' }, { id: 3, to: 'none' }, { id: 4, to: 'keep' }] }; };
  await fixLinks({ dir, pages: PAGES, entry: 'home', businessName: 'Bonza', projectId: 'links-p1', ask });
  const second = site();
  await fixLinks({ dir: second, pages: PAGES, entry: 'home', businessName: 'Bonza', projectId: 'links-p1', ask });
  assert.equal(calls, 1);
  assert.match(fs.readFileSync(path.join(second, 'index.html'), 'utf8'), /<a href="brands\.html">View all brands<\/a>/);
});

test('the booking page is only for booking words: "Court Rules" no longer opens it', () => {
  const pages = [{ slug: 'home', title: 'Home', navLabel: 'Home' }, { slug: 'book', title: 'Book a court', navLabel: 'Book' }];
  const html = '<a href="#">Court Rules</a><a href="#">Reserve a spot</a><a href="#">Court Guidelines</a>';
  const out = linkPages(html, pages, { bookSlug: 'book' }).html;
  assert.match(out, /<a href="book\.html">Reserve a spot<\/a>/);
  assert.match(out, /<a href="#">Court Rules<\/a>/);
  assert.match(out, /<a href="#">Court Guidelines<\/a>/);
});

test('a button with nowhere to go shows a friendly note on every site', () => {
  assert.match(GUARD_JS, /data-inert/);
  assert.match(GUARD_JS, /this button works once the real details are added/);
  assert.match(GUARD_CSS, /\.polish-note/);
});
