// Links that go nowhere: category words go to their section, a section on another page works from any page, dead footer links are removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLinks, dropDeadFooterLinks, normalizeLabel } from '../src/stages/07-site/transform.js';

const ctx = (extra = {}) => ({ labelTargets: new Map(), businessName: 'Atelier Nour', socials: new Map(), formPage: null, slugs: new Set(['home', 'services', 'about', 'contact']), ...extra });

test('a link whose words are a section heading goes to that section', () => {
  const labelTargets = new Map([[normalizeLabel('Face and Hands'), 'services#services-face-hands'], [normalizeLabel('Hair'), 'services#services-hair']]);
  const r = resolveLinks('<a class="x" href="#">Hair</a> <a href="#">Face and Hands</a>', ctx({ labelTargets }));
  assert.match(r.html, /<a href="\/services\/#services-hair" class="x">Hair<\/a>/);
  assert.match(r.html, /<a href="\/services\/#services-face-hands">Face and Hands<\/a>/);
  assert.deepEqual(r.unresolved, []);
});

test('a link to a section of another page works from any page; a section on this page stays an in-page link', () => {
  const anchorPages = new Map([['services-hair', 'services']]);
  assert.match(resolveLinks('<a href="#services-hair">Services</a>', ctx({ anchorPages })).html, /href="\/services\/#services-hair"/);
  assert.match(resolveLinks('<section id="services-hair"></section><a href="#services-hair">Down</a>', ctx({ anchorPages })).html, /<a href="#services-hair">Down<\/a>/);
});

test('footer links that go nowhere are removed with their list items; real links and links outside the footer stay', () => {
  const html = '<main><a href="#">Book now</a></main><footer><ul><li><a href="/services/">Services</a></li><li><a href="#">Philosophy</a></li><li><a href="#">Atelier Schedule</a></li></ul><a href="#" class="y">Sanctuary Inquiries</a></footer>';
  const r = dropDeadFooterLinks(html);
  assert.deepEqual(r.removed, ['Philosophy', 'Atelier Schedule', 'Sanctuary Inquiries']);
  assert.ok(r.html.includes('<a href="#">Book now</a>'), 'a button in the page is left');
  assert.ok(r.html.includes('<li><a href="/services/">Services</a></li>'));
  assert.ok(!r.html.includes('Philosophy') && !r.html.includes('Sanctuary'));
});

test('link words that begin exactly one section heading go to it ("Bridal" for "Bridal makeup"); two candidates means no guess', () => {
  const one = resolveLinks('<a href="#">Bridal</a>', ctx({ headingTargets: [[normalizeLabel('Bridal makeup'), 'services#services-bridal'], [normalizeLabel('Hair'), 'services#services-hair']] }));
  assert.match(one.html, /href="\/services\/#services-bridal"/);
  const two = resolveLinks('<a href="#">Bridal</a>', ctx({ headingTargets: [[normalizeLabel('Bridal makeup'), 'services#a'], [normalizeLabel('Bridal hair'), 'services#b']] }));
  assert.match(two.html, /href="#"/, 'ambiguous: left alone');
});

test('an in-page link "#visit" goes to the one section of the page whose id ends with it ("home-visit")', async () => {
  const { resolveLinks } = await import('../src/stages/07-site/transform.js');
  const html = '<a href="#visit">Visit</a><a href="#nothing">X</a><a href="#path">Path</a><section id="home-visit"></section><section id="home-path"></section><section id="a-path"></section>';
  const out = resolveLinks(html, { labelTargets: new Map(), businessName: 'Shop', socials: new Map(), formPage: null, slugs: new Set(['home']) }).html;
  assert.match(out, /href="#home-visit"/);
  assert.match(out, /href="#nothing"/);  // no section of that name: left as it was
  assert.match(out, /href="#path"/);     // two sections end with it: not guessed
});
