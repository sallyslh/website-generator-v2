// Found by testing a service business (a salon): favicon, social links, form labels, no frames without pictures, no double listing. No API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { labelFields } from '../src/lib/formLabels.js';
import { socialLinksOf, socialUrl } from '../src/lib/socials.js';
import { resolveLinks } from '../src/stages/07-site/transform.js';
import { initialFavicon, layoutAstro } from '../src/stages/07-site/templates.js';
import { buildPagePrompt } from '../src/stages/05-design-stitch/prompts.js';
import { fillListedSections } from '../src/stages/04-content/dishLists.js';

test('form fields get an accessible name from their placeholder; labelled and hidden fields are left alone', () => {
  const html = '<form><input type="text" name="your_name" placeholder="Your name"><input type="tel" name="phone"><label for="m">Message</label><textarea id="m"></textarea><input type="hidden" name="x"><input type="submit" value="Send"><select name="service"><option>A</option></select><input aria-label="Already" placeholder="p"></form>';
  const r = labelFields(html);
  assert.equal(r.added, 3);
  assert.match(r.html, /<input aria-label="Your name" type="text"/);
  assert.match(r.html, /<input aria-label="phone" type="tel"/);
  assert.match(r.html, /<select aria-label="service"/);
  assert.match(r.html, /<textarea id="m">/, 'a field with a label is untouched');
  assert.match(r.html, /<input type="hidden" name="x">/);
  assert.match(r.html, /<input aria-label="Already" placeholder="p">/);
});

test('a social handle becomes a real link, found by the platform, the handle, or the handle without @', () => {
  assert.equal(socialUrl('instagram', '@ateliernour'), 'https://www.instagram.com/ateliernour');
  assert.equal(socialUrl('tiktok', 'ateliernour'), 'https://www.tiktok.com/@ateliernour');
  assert.equal(socialUrl('facebook', 'https://facebook.com/nour'), 'https://facebook.com/nour', 'a link stays a link');
  const socials = socialLinksOf([{ platform: 'instagram', url: '@ateliernour' }]);
  assert.equal(socials.get('instagram'), 'https://www.instagram.com/ateliernour');
  assert.equal(socials.get('ateliernour'), 'https://www.instagram.com/ateliernour');
  const out = resolveLinks('<a href="#">@ateliernour</a>', { labelTargets: new Map(), businessName: 'Atelier Nour', socials, formPage: null, slugs: new Set(['home']) });
  assert.match(out.html, /href="https:\/\/www\.instagram\.com\/ateliernour" target="_blank"/);
  assert.deepEqual(out.unresolved, []);
});

test('a site without a logo still has a favicon: the first letter on the main color, readable on light and dark colors', () => {
  const dark = decodeURIComponent(initialFavicon('n', '#1a3a4a'));
  assert.match(dark, /fill='#1a3a4a'/); assert.match(dark, />N</); assert.match(dark, /fill='#ffffff'/);
  assert.match(decodeURIComponent(initialFavicon('A', '#f2e6d0')), /fill='#14181b'/, 'dark letter on a light color');
  assert.match(decodeURIComponent(initialFavicon('', 'nonsense')), />\?</, 'bad input never breaks the build');
  const layout = layoutAstro({ initial: 'N', lang: 'en', rtl: false, htmlClass: '', fontLinks: [], themeColor: '#1a3a4a', hasHeader: false, hasFooter: false, siteTitle: 'Nour', logo: null });
  assert.match(layout, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.doesNotMatch(layoutAstro({ initial: 'N', lang: 'en', rtl: false, htmlClass: '', fontLinks: [], themeColor: '#111111', hasHeader: false, hasFooter: false, siteTitle: 'Nour', logo: 'asset-001' }), /image\/svg\+xml/, 'with a logo the logo is the icon');
});

const brief = { business: { name: 'Atelier Nour', type: 'salon', contact: {} }, audience: { description: '' }, goals: { primary: 'bookings' }, pages: [{ slug: 'home', title: 'Home', purpose: 'p' }], brand: { colors: [], personality: [] }, offerings: [], tone: '' };
const design = (slots) => ({ styleBlock: 's', colors: { primary: '#111', secondary: '#222', accent: '#333', background: '#fff', text: '#000' }, typography: { headings: 'Serif: x', body: 'Sans: y' }, layout: { header: 'h', footer: 'f' }, signature: null, avoid: [], pages: [{ slug: 'home', sections: [{ id: 'home-hero', type: 'hero', purpose: 'p', layoutNotes: 'a tall image on the right', slots }] }] });
const content = { pages: [{ slug: 'home', sections: [{ id: 'home-hero', heading: 'Hello', subheading: '', body: [], items: [] }] }] };

test('Stitch is told to draw a picture only where there is a photo: no frame, no placeholder, no caption card', () => {
  const without = buildPagePrompt({ brief, design: design([{ id: 'home-hero-image', description: 'the salon', aspect: '4:5', assignedAsset: null }]), content, slug: 'home' });
  assert.doesNotMatch(without, /Image slot home-hero-image/);
  assert.match(without, /No picture in this section: draw no picture, no frame, no placeholder box and no caption card/);
  assert.match(without, /PICTURES: draw a picture ONLY where a section lists an Image slot/);
  const withPhoto = buildPagePrompt({ brief, design: design([{ id: 'home-hero-image', description: 'the salon', aspect: '4:5', assignedAsset: 'asset-001' }]), content, slug: 'home' });
  assert.match(withPhoto, /Image slot home-hero-image/);
  assert.doesNotMatch(withPhoto, /No picture in this section/);
});

test('a service that has its own feature block on the page is not listed a second time', () => {
  const b = { offerings: [{ name: 'Haircut', price: '$35', description: '' }, { name: 'Bridal makeup', price: '$120', description: '' }, { name: 'Manicure', price: '$25', description: '' }] };
  const designPage = { slug: 'services', sections: [{ id: 'services-bridal', type: 'service-feature' }, { id: 'services-list', type: 'service-list' }] };
  const page = { slug: 'services', sections: [{ id: 'services-bridal', heading: 'Bridal makeup', items: [] }, { id: 'services-list', heading: 'Services', items: [], dishes: [0, 1, 2] }] };
  fillListedSections({ brief: b, designPage, page });
  assert.deepEqual(page.sections[1].items.map((i) => i.title), ['Haircut', 'Manicure'], 'Bridal makeup is shown once, in its own block');
});

test('every file edited for the salon fixes is free of stray control characters', () => {
  for (const f of ['src/lib/formLabels.js', 'src/lib/socials.js', 'src/stages/07-site/templates.js', 'src/stages/04-content/dishLists.js', 'src/stages/05-design-stitch/prompts.js']) {
    assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(fs.readFileSync(f, 'utf8')), false, f);
  }
});

test('the writer sees prices with their currency sign, so featured cards say "$39", not "39.0"', async () => {
  const { pagePrompt } = await import('../src/stages/04-content/prompts.js');
  const b = { ...brief, currency: 'USD', features: [], unknowns: [], language: 'en', offerings: [{ name: 'Lamb Chops', price: '39.0', description: '' }, { name: 'Tea', price: '', description: '' }, { name: 'Soup', price: '$6', description: '' }] };
  const text = pagePrompt({ brief: b, design: design([]), manifest: { assets: [], documents: [] }, page: { slug: 'home', title: 'Home', purpose: 'p' }, global: { siteTitle: 's', primaryCta: {}, navigation: [] } });
  assert.match(text, /"price": "\$39"/);
  assert.match(text, /"price": "\$6"/, 'a price that already has a sign is unchanged');
  assert.doesNotMatch(text, /"price": "39\.0"/);
});

test('a bare price beside a card gets the currency sign; numbers inside sentences and prices that already have a sign are left alone', async () => {
  const { formatLoosePrices } = await import('../src/stages/07-site/lists.js');
  const offerings = [{ name: 'Lamb Chops', price: '39.0' }, { name: 'Soup', price: '$6' }, { name: 'Tea', price: '5' }];
  const html = '<div><span>Grilled Lamb Chops</span> <span>◆</span> <span>39.0</span></div><p>Open 39.0 hours</p><b>\n  39.0\n</b><i>5</i><i>$6</i>';
  const r = formatLoosePrices(html, { offerings, currency: 'USD' });
  assert.equal(r.changed, 2);
  assert.match(r.html, /<span>\$39<\/span>/); assert.match(r.html, /<b>\n {2}\$39\n<\/b>/);
  assert.match(r.html, /Open 39\.0 hours/, 'inside a sentence: untouched');
  assert.match(r.html, /<i>5<\/i>/, 'a whole number could be anything: untouched');
  assert.equal(formatLoosePrices(html, { offerings, currency: '' }).html, html, 'no currency chosen: nothing changes');
});
