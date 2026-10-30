// Menus and product lists: every item gets the standard row (its photo, name, description, price with its currency sign),
// made by code from the owner's list; the drawn rows only show where the list is and which colors and fonts the design uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDishList } from '../src/lib/htmlRows.js';
import { formatPrice } from '../src/lib/price.js';
import { expandLists } from '../src/stages/07-site/lists.js';
import { checkSite } from '../src/stages/07-site/checks.js';

const owner = [
  { name: 'Fattoush', price: '8.0', description: 'Salad with sumac', photo: 'fattoush.jpg' },
  { name: 'Kibbeh & Co', price: '12', description: '', photo: '' },
  { name: 'Knefeh', price: '', description: 'Cheese <hot> & syrup', photo: 'knefeh.jpg' },
  { name: 'Hummus', price: '5', description: 'Chickpeas', photo: 'hummus.jpg' },
];
const dishes = owner.map((d) => ({ ...d, priceRaw: d.price, price: formatPrice(d.price, 'USD') }));
const row = (d) => `<div class="row border-b pb-4 flex justify-between" id="r-${d.name[0]}"><span class="t font-headline-sm text-[#F7F1E6] font-semibold">${d.name.replace(/&/g, '&amp;')}</span><span class="p text-[#C49A5A]">${d.price}</span><p class="d text-right text-[#C49A5A]/70">${d.description}</p></div>`;
const page = (rows) => `<html><body><header>Menu</header><script>var x = "<div>Fattoush</div>";</script><section id="menu-a"><h2>Starters</h2><div class="list space-y-6">${rows}</div></section><section id="menu-b"><div class="list"><div class="row"><span>Other</span></div></div></section></body></html>`;
const STD = 'flex items-center gap-4';

test('prices: the owner\'s number is kept, the currency sign makes it clear; a price that has a sign is left alone', () => {
  assert.deepEqual([['20.0', 'USD'], ['8', 'USD'], ['1,500', 'USD'], ['12', 'EUR'], ['50000', 'LBP'], ['$8', 'USD'], ['12 USD', 'EUR'], ['20.0', ''], ['', 'USD'], ['7.50', 'USD']].map(([p, c]) => formatPrice(p, c)),
    ['$20', '$8', '$1,500', '€12', '50000 LBP', '$8', '12 USD', '20.0', '', '$7.50']);
});

test('every item gets the standard row: photo, name, description, price in a pill; the design\'s own colors are kept', () => {
  const r = renderDishList(page(row(owner[0]) + row(owner[1])), { dishes, sectionId: 'menu-a' });
  assert.deepEqual([r.added, r.shown, r.reason], [2, 2, '']);
  assert.equal(r.html.split(STD).length - 1, 4, 'one standard row per item of the list');
  assert.match(r.html, /<img src="fattoush\.jpg" alt="Fattoush"/);
  assert.match(r.html, /rounded-full border border-current[^>]*>\$8<\/span>/, 'the price has its sign and sits in a pill');
  assert.match(r.html, /text-\[#F7F1E6\][^"]*block" dir="auto">Fattoush<\/span>/, 'the name keeps the design\'s color and font');
  assert.match(r.html, /text-\[#C49A5A\][^"]*mt-1" dir="auto">Salad with sumac<\/p>/);
  assert.doesNotMatch(r.html, /justify-between|text-right/, 'the drawn layout classes are not carried over');
  assert.ok(!r.html.includes('id="r-'), 'the drawn rows are gone');
  assert.ok(r.html.includes('<h2>Starters</h2>') && r.html.includes('<span>Other</span>'), 'the rest of the page is untouched');
});

test('an item without a photo, a price or a description leaves that part out; text is escaped', () => {
  const r = renderDishList(page(row(owner[0]) + row(owner[1])), { dishes, sectionId: 'menu-a' });
  const parts = r.html.split(STD);
  const kibbeh = parts.find((p) => p.includes('Kibbeh &amp; Co'));
  assert.ok(kibbeh && !kibbeh.split('Hummus')[0].includes('<img') && !kibbeh.split('Knefeh')[0].includes('<p '), 'no photo and no description for Kibbeh');
  const knefeh = parts.find((p) => p.includes('Knefeh'));
  assert.match(knefeh, /Cheese &lt;hot&gt; &amp; syrup/);
  assert.doesNotMatch(knefeh, /rounded-full/, 'no price, no pill');
});

test('a design without a drawn price or description still gets them, in the title\'s color', () => {
  const plain = (d) => `<li class="r"><b class="text-[#112233] font-headline-sm">${d.name}</b></li>`;
  const r = renderDishList(`<section id="s"><ul>${plain(owner[0])}${plain(owner[3])}</ul></section>`, { dishes, sectionId: 's' });
  assert.match(r.html, /text-\[#112233\][^"]*shrink-0 whitespace-nowrap rounded-full[^>]*>\$8<\/span>/);
  assert.equal(r.html.split('rounded-full border').length - 1, 3, 'three of the four have a price');
});

test('rows that cannot be found: the page is returned unchanged with the reason', () => {
  const one = page(row(owner[0]));
  const r = renderDishList(one, { dishes, sectionId: 'menu-a' });
  assert.equal(r.html, one); assert.match(r.reason, /only 1/);
  assert.match(renderDishList(page(''), { dishes, sectionId: 'menu-a' }).reason, /only 0/);
});

test('script text is never mistaken for a row', () => {
  const r = renderDishList(page(row(owner[0]) + row(owner[1])), { dishes, sectionId: null });
  assert.equal(r.added, 2);
  assert.equal((r.html.match(/var x = "<div>Fattoush<\/div>";/g) || []).length, 1);
});

test('stage 7: only list sections of the design are made; price, description and photo come from the owner\'s list by name', () => {
  const brief = { currency: 'USD', offerings: owner.map((d, i) => ({ name: d.name, price: d.price, description: d.description, assetId: d.photo ? `asset-00${i}` : undefined })) };
  const manifest = { assets: owner.map((d, i) => ({ id: `asset-00${i}`, file: `inputs/assets/${d.photo || 'none.jpg'}` })) };
  const design = { pages: [{ slug: 'menu', sections: [{ id: 'menu-a', type: 'menu-category' }, { id: 'menu-b', type: 'hero' }] }] };
  const content = { pages: [{ slug: 'menu', sections: [{ id: 'menu-a', items: owner.map((d) => ({ title: d.name, text: '' })) }, { id: 'menu-b', items: [] }] }] };
  const out = expandLists({ body: page(row(owner[0]) + row(owner[1])), slug: 'menu', brief, design, content, manifest });
  assert.deepEqual(out.report.map((x) => [x.section, x.total, x.shown, x.added, x.withPhoto]), [['menu-a', 4, 2, 2, 3]]);
  assert.match(out.html, /<img src="hummus\.jpg" alt="Hummus"/);
  assert.match(out.html, />\$5<\/span>/);
});

test('the site check fails when a dish of a long list is missing from its page', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ title: `Dish number ${i}`, text: '' }));
  const content = { global: { siteTitle: 's', navigation: [], primaryCta: { label: 'x', target: 'y' } }, pages: [{ slug: 'menu', seo: { title: 't', description: 'd' }, sections: [{ id: 'menu-a', heading: '', subheading: '', body: [], items, imageAlt: {} }] }] };
  const brief = { business: { name: 'B', contact: {}, socialLinks: [] }, offerings: [] };
  const run = (titles) => checkSite({ brief, content, approvedSlugs: ['menu'], pages: [{ slug: 'menu', html: `<main>${titles.map((t) => `<p>${t}</p>`).join('')}</main>` }], distFiles: null, built: true, report: {}, imageSizes: {} }).find((c) => c.name === 'every item of a long list is on its page');
  assert.equal(run(items.map((i) => i.title)).ok, true);
  const bad = run(items.slice(0, 7).map((i) => i.title));
  assert.equal(bad.ok, false); assert.match(bad.details, /2 of 9 missing/);
});

test('a link to #menu goes to the menu page when this page has no such spot; a real anchor stays', async () => {
  const { resolveLinks } = await import('../src/stages/07-site/transform.js');
  const ctx = { labelTargets: new Map(), businessName: 'B', socials: new Map(), formPage: null, slugs: new Set(['home', 'menu', 'contact']) };
  const a = resolveLinks('<a class="b" href="#menu">Show full menu</a><a href="#contact">Contact</a>', ctx).html;
  assert.match(a, /<a href="\/menu\/" class="b">Show full menu<\/a>/);
  assert.match(a, /<a href="\/contact\/">Contact<\/a>/);
  const b = resolveLinks('<section id="menu">x</section><a href="#menu">Down</a><a href="#story">Story</a>', ctx).html;
  assert.match(b, /<a href="#menu">Down<\/a>/, 'this page has a menu spot: the link stays');
  assert.match(b, /<a href="#story">/);
});

test('the picture beside a list: a picture without its slot name gets the section\'s slot id; dish photos are not touched', async () => {
  const { tagSectionImages } = await import('../src/lib/htmlRows.js');
  const html = '<section id="menu-a"><img class="w-full" data-alt="A long description" src="https://x/y.jpg"/><div><img src="fattoush.jpg" alt="Fattoush"/></div></section><section id="menu-b"><img data-alt="d" src="z.jpg"/></section>';
  const out = tagSectionImages(html, { sectionId: 'menu-a', slotIds: ['menu-a-image', 'menu-a-image-2'] });
  assert.match(out, /<img alt="menu-a-image" class="w-full" data-alt/);
  assert.match(out, /<img src="fattoush\.jpg" alt="Fattoush"\/>/);
  assert.ok(out.includes('<img data-alt="d" src="z.jpg"/>'), 'another section is untouched');
  assert.equal(tagSectionImages(html, { sectionId: 'nope', slotIds: ['a'] }), html);
});

test('no photo, no frame: an empty picture block goes away with the wrappers that hold only it', async () => {
  const { removeEmptyFrames } = await import('../src/stages/07-site/transform.js');
  const empty = '<div class="w-full h-full" aria-hidden="true" data-empty-photo style="background:#eee"></div>';
  const html = `<section><div class="grid"><div class="col"><h2>Story</h2><p>Text</p></div><div class="p-2"><div class="aspect-[4/3] border">${empty}</div></div></div></section>`;
  const r = removeEmptyFrames(html);
  assert.equal(r.removed, 1);
  assert.equal(r.html, '<section><div class="grid"><div class="col"><h2>Story</h2><p>Text</p></div></div></section>');
  const both = `<section><div class="grid"><div class="a">${empty}</div><div class="b">${empty}</div></div></section>`;
  assert.equal(removeEmptyFrames(both).html, '<section><div class="grid"></div></section>', 'two empty frames; the section and its grid stay');
  const withPhoto = '<section><div class="f"><img src="/images/a.webp" alt="x"/></div></section>';
  assert.equal(removeEmptyFrames(withPhoto).html, withPhoto, 'a frame with a real photo is never touched');
});

test('a list is found by the shape of its rows when the drawn rows are not the owner\'s current items', () => {
  const drawn = (name, price) => `<div class="r border-b"><span class="t text-[#111]">${name}</span><span class="p text-[#c90]">${price}</span></div>`;
  const html = `<section id="s"><h2>Title</h2><div class="list">${drawn('Old dish one', '$5')}${drawn('Old dish two', '$6')}${drawn('Old dish three', '$7')}</div></section>`;
  const r = renderDishList(html, { dishes, sectionId: 's' });
  assert.equal(r.reason, '');
  assert.equal(r.html.split('flex items-center gap-4').length - 1, 4, 'the four items of the owner\'s list replace the three drawn rows');
  assert.ok(!r.html.includes('Old dish'), 'the old drawn items are gone');
  assert.match(r.html, /text-\[#c90\][^"]*shrink-0[^>]*>\$8<\/span>/, 'the design\'s price color is still used');
});

test('a small copy of the picture is used for a dish thumbnail', async () => {
  const { swapImagesForSite } = await import('../src/stages/07-site/transform.js');
  const html = '<img src="fattoush.jpg" alt="Fattoush" data-thumb class="h-20"/><img src="fattoush.jpg" alt="Fattoush" class="big"/>';
  const out = swapImagesForSite(html, { slots: new Map(), altFor: () => '', logoAssetId: null, businessName: 'B', tint: '#eee', assetByFilename: new Map([['fattoush.jpg', 'asset-001']]) }).html;
  assert.match(out, /src="\/images\/asset-001-s\.webp"/);
  assert.match(out, /src="\/images\/asset-001\.webp"/);
});

test('the name shown is the owner\'s exact spelling, even when the written copy spelled the dish differently', () => {
  const brief = { currency: 'USD', offerings: [{ name: 'Kale & Quinoa', price: '15.0', description: 'Chicken breast' }, { name: 'Rocca BeetRoot', price: '7.0', description: '' }] };
  const design = { pages: [{ slug: 'menu', sections: [{ id: 's', type: 'menu-category' }] }] };
  const content = { pages: [{ slug: 'menu', sections: [{ id: 's', items: [{ title: 'Kale Quinoa', text: '' }, { title: 'Rocca Beetroot', text: '' }] }] }] };
  const drawn = (n) => `<div class="r"><span class="t">${n}</span></div>`;
  const out = expandLists({ body: `<section id="s">${drawn('Kale Quinoa')}${drawn('Rocca Beetroot')}</section>`, slug: 'menu', brief, design, content });
  assert.match(out.html, />Kale &amp; Quinoa<\/span>/); assert.match(out.html, />Rocca BeetRoot<\/span>/);
  assert.match(out.html, />\$15<\/span>/, 'and its own price and description are found');
  assert.match(out.html, />Chicken breast<\/p>/);
});

test('an accent does not make a dish a different dish ("Meunière" in the list, "Meuniere" in the copy)', () => {
  const brief = { currency: 'USD', offerings: [{ name: 'Meunière Creamy Fish', price: '25.0', description: '' }] };
  const design = { pages: [{ slug: 'menu', sections: [{ id: 's', type: 'menu-category' }] }] };
  const content = { pages: [{ slug: 'menu', sections: [{ id: 's', items: [{ title: 'Meuniere Creamy Fish', text: '' }] }] }] };
  const drawn = (n) => `<div class="r"><span class="t">${n}</span></div>`;
  const out = expandLists({ body: `<section id="s">${drawn('Meuniere Creamy Fish')}${drawn('Other')}</section>`, slug: 'menu', brief, design, content });
  assert.match(out.html, />Meunière Creamy Fish<\/span>/); assert.match(out.html, />\$25<\/span>/);
});

test('any section\'s own picture drawn without its slot name is matched to the planned photo, not only in lists', () => {
  const design = { pages: [{ slug: 'home', sections: [{ id: 'home-story', type: 'story', slots: [{ id: 'home-story-image' }] }] }] };
  const content = { pages: [{ slug: 'home', sections: [{ id: 'home-story', items: [] }] }] };
  const out = expandLists({ body: '<section id="home-story"><img data-alt="Long text" src="https://x/y.jpg"/></section>', slug: 'home', brief: { offerings: [] }, design, content });
  assert.match(out.html, /<img alt="home-story-image" data-alt/);
});

test('the site check also fails when a price of a long list is not shown, or an empty picture frame is left', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ title: `Dish ${i}`, text: '' }));
  const content = { global: { siteTitle: 's', navigation: [], primaryCta: { label: 'x', target: 'y' } }, pages: [{ slug: 'menu', seo: { title: 't', description: 'd' }, sections: [{ id: 'menu-a', heading: '', subheading: '', body: [], items, imageAlt: {} }] }] };
  const brief = { currency: 'USD', business: { name: 'B', contact: {}, socialLinks: [] }, offerings: items.map((i, n) => ({ name: i.title, price: `${n + 1}.0` })) };
  const page = (pills, extra = '') => ({ slug: 'menu', html: `<main>${items.map((i, n) => `<p>${i.title}</p>${pills(n) ? `<span>${pills(n)}</span>` : ''}`).join('')}${extra}</main>` });
  const run = (p) => checkSite({ brief, content, approvedSlugs: ['menu'], pages: [p], distFiles: null, built: true, report: {}, imageSizes: {} });
  const find = (rs, name) => rs.find((c) => c.name === name);
  assert.equal(find(run(page((n) => `$${n + 1}`)), 'every price of a long list is shown with its currency sign').ok, true);
  const bad = find(run(page((n) => (n < 7 ? `$${n + 1}` : ''))), 'every price of a long list is shown with its currency sign');
  assert.equal(bad.ok, false); assert.match(bad.details, /2 price\(s\) not shown/);
  assert.equal(find(run(page((n) => `$${n + 1}`, '<div data-empty-photo></div>')), 'no Stitch leftovers (CDN, internet pictures, placeholders, notes)').ok, false);
});

test('when a picture is left out, the text column next to it takes the whole width', async () => {
  const { removeEmptyFrames } = await import('../src/stages/07-site/transform.js');
  const empty = '<div class="f" aria-hidden="true" data-empty-photo style="background:#eee"></div>';
  const html = `<section><div class="grid grid-cols-1 lg:grid-cols-12"><div class="lg:col-span-6 pr-8"><h2>Story</h2></div><div class="lg:col-span-6">${empty}</div></div></section>`;
  const r = removeEmptyFrames(html);
  assert.equal(r.html, '<section><div class="grid grid-cols-1 lg:grid-cols-12"><div class="pr-8 col-span-12 max-w-3xl mx-auto"><h2>Story</h2></div></div></section>');
});

test('a drawn row whose name is written differently from the owner\'s is removed too, so no dish shows twice', () => {
  const html = '<section id="s"><div><div class="r"><span>Grilled Salmon With Lemon</span><p>a — 32.0</p></div><div class="r"><span>Grilled Salmon with Spinach</span><p>b — 34.0</p></div><div class="r"><span>Meuniere Creamy Fish</span><p>c — 25.0</p></div></div></section>';
  const dishes = [{ name: 'Grilled Salmon With Lemon', description: 'a', price: '$32', priceRaw: '32.0', photo: '' }, { name: 'Grilled Salmon With Spinach', description: 'b', price: '$34', priceRaw: '34.0', photo: '' }, { name: 'Meunière Creamy Fish', description: 'c', price: '$25', priceRaw: '25.0', photo: '' }];
  const out = renderDishList(html, { dishes, sectionId: 's' }).html;
  assert.equal((out.match(/>[^<]*Creamy Fish</g) || []).length, 1);
  assert.equal((out.match(/>[^<]*Salmon[^<]*</g) || []).length, 2);
  assert.doesNotMatch(out, /— 3/);
});
