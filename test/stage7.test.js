// Tests for Stage 7 (no API calls, no npm install): taking a Stitch page apart, links, images, checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractParts, mergeConfigs, cleanBody, swapImagesForSite, resolveLinks, markForm, splitShell, hoistShared, fixCopyright, normalizeLabel } from '../src/stages/07-site/transform.js';
import { checkSite, unknownText, allowedText } from '../src/stages/07-site/checks.js';
import { removeInventedText } from '../src/stages/07-site/textRules.js';
import { packageJson, tailwindConfigFile, jsonLdFor } from '../src/stages/07-site/templates.js';

const PAGE = `<!DOCTYPE html><html class="scroll-smooth" lang="en"><head><title>Cafe &amp; Bar</title>
<link href="https://fonts.googleapis.com/css2?family=Karla&amp;display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
<script id="tailwind-config">tailwind.config = { darkMode: "class", theme: { extend: { colors: { primary: "#412408" } } } }</script>
<style>.material-symbols-outlined { font-size: 20px; }</style></head>
<body class="bg-background text-on-surface"><header><a href="#"><img alt="Cafe logo" src="x.png"/></a><nav><a href="#">Menu</a><a href="#">Home</a></nav></header>
<main><h1>Hello</h1><img alt="home-hero" data-alt="a long imaginary description" src="https://lh3.googleusercontent.com/x"/></main>
<footer>© 2024 Cafe. Handcrafted botanical formulations.</footer><script>var a = {b: 1};</script></body></html>`;

test('a Stitch page is taken apart: config, styles, fonts, body, title', () => {
  const p = extractParts(PAGE);
  assert.equal(p.title, 'Cafe & Bar');
  assert.equal(p.lang, 'en');
  assert.equal(p.bodyClass, 'bg-background text-on-surface');
  assert.deepEqual(p.tailwindConfig.theme.extend.colors, { primary: '#412408' });
  assert.equal(p.styles.length, 1);
  assert.deepEqual(p.fontLinks, ['https://fonts.googleapis.com/css2?family=Karla&display=swap']);
  assert.ok(p.bodyInner.startsWith('<header>') && !p.bodyInner.includes('<body'));
});

test('a broken Tailwind config does not crash; configs of several pages are merged without overriding', () => {
  assert.equal(extractParts('<html><head><script id="tailwind-config">tailwind.config = {{{</script></head><body>x</body></html>').tailwindConfig, null);
  const { config, conflicts } = mergeConfigs([{ theme: { extend: { colors: { a: '1', b: '2' } } } }, { theme: { extend: { colors: { a: 'X', c: '3' } } } }, null]);
  assert.deepEqual(config.theme.extend.colors, { a: '1', b: '2', c: '3' });
  assert.equal(conflicts, 1);
});

test('cleanBody removes the CDN script and the imaginary picture descriptions', () => {
  const out = cleanBody('<script src="https://cdn.tailwindcss.com"></script><img data-alt="long text" style="object-fit:cover;object-fit:cover;"/>');
  assert.ok(!out.includes('cdn.tailwindcss') && !out.includes('data-alt'));
  assert.equal((out.match(/object-fit/g) || []).length, 1);
});

test('images: slot photos become optimized files with real alt text, empty slots a quiet block, the logo by name', () => {
  const html = '<img alt="home-hero" class="w-full" src="https://lh3.googleusercontent.com/x"/><img alt="home-gallery" class="a" src="y"/><img alt="Cafe circular badge" class="logo" src="z"/><img alt="stock" src="https://lh3.googleusercontent.com/q"/>';
  const { html: out, stats } = swapImagesForSite(html, {
    slots: new Map([['home-hero', 'asset-001'], ['home-gallery', null]]), altFor: (id) => ({ 'home-hero': 'Barista pouring coffee' })[id], logoAssetId: 'asset-009', businessName: 'Cafe', tint: '#1122331f', assetByFilename: new Map(),
  });
  assert.match(out, /<img src="\/images\/asset-001\.webp" alt="Barista pouring coffee" class="w-full" fetchpriority="high"/);
  assert.match(out, /<div class="a" aria-hidden="true" data-empty-photo style="background:#1122331f"><\/div>/);
  assert.match(out, /src="\/images\/asset-009\.webp" alt="Cafe logo"/);
  assert.ok(!out.includes('googleusercontent') && !/photo needed/i.test(out));
  assert.deepEqual(stats.empty, ['home-gallery']);
  assert.equal(stats.external, 1);
  assert.deepEqual([...stats.used].sort(), ['asset-001', 'asset-009']);
});

test('links: menu words, buttons, social names, brand and long cards go to real places', () => {
  const html = ['<a href="#">Menu</a>', '<a href="#"><span class="material-symbols-outlined">menu</span> Order now</a>', '<a href="#">Home</a>', '<a href="#">Instagram</a>', '<a href="#"><img alt="x" src="y"/></a>',
    '<a href="#">Cafe Bar</a>', '<a href="#">See the menu Read all our dishes</a>', '<a href="#">Mystery</a>', '<a href="#section">Jump</a>', '<a href="about.html">About</a>', '<a href="https://example.com">Out</a>'].join('\n');
  const { html: out, unresolved } = resolveLinks(html, {
    labelTargets: new Map([['menu', 'menu'], ['order now', 'form'], ['see the menu', 'menu']]), businessName: 'Cafe', socials: new Map([['instagram', 'https://instagram.com/cafe']]), formPage: 'contact', slugs: new Set(['home', 'menu', 'about', 'contact']),
  });
  assert.match(out, /<a href="\/menu\/">Menu<\/a>/);
  assert.match(out, /<a href="\/contact\/#contact-form"><span/);
  assert.match(out, /<a href="\/">Home<\/a>/);
  assert.match(out, /<a href="https:\/\/instagram.com\/cafe" target="_blank" rel="noopener noreferrer">Instagram<\/a>/);
  assert.match(out, /<a href="\/"><img/);
  assert.match(out, /<a href="\/">Cafe Bar<\/a>/);
  assert.match(out, /<a href="\/menu\/">See the menu Read/);
  assert.match(out, /<a href="#section">Jump<\/a>/);
  assert.match(out, /<a href="\/about\/">About<\/a>/);
  assert.match(out, /href="https:\/\/example.com" target="_blank"/);
  assert.deepEqual(unresolved, ['mystery']);
});

test('the form gets the id the buttons point to; the copyright line keeps only facts', () => {
  assert.match(markForm('<form class="a">'), /<form id="contact-form" class="a">/);
  assert.equal(markForm('<form id="mine">'), '<form id="mine">');
  const r = fixCopyright('<p>© 2024 Cafe Atelier. Handcrafted botanical formulations. All rights reserved.</p><p>© 2026 Cafe</p>', { businessName: 'Cafe', year: 2026 });
  assert.equal(r.html, '<p>© 2026 Cafe</p><p>© 2026 Cafe</p>');
  assert.equal(r.fixed, 1);
});

test('header and footer move into the layout only when every page has the same ones', () => {
  const page = (h, m) => `<header>${h}</header><main>${m}</main><footer>F</footer><script>x()</script>`;
  const same = hoistShared(['A', 'B'].map((m) => splitShell(page('H', m))));
  assert.equal(same.header, '<header>H</header>');
  assert.equal(same.footer, '<footer>F</footer>');
  assert.ok(same.pages[0].includes('<main>A</main>') && same.pages[0].includes('<script>x()</script>') && !same.pages[0].includes('<header>'));
  const different = hoistShared([splitShell(page('H1', 'A')), splitShell(page('H2', 'B'))]);
  assert.equal(different.header, null);
  assert.ok(different.pages[1].includes('<header>H2</header>'));
});

const brief = { business: { name: 'Cafe', contact: { phone: '+20 100 123 4567', email: 'hi@cafe.com', address: '', hours: '' }, socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/cafe' }] }, offerings: [{ name: 'Latte', price: '50 EGP' }] };
const content = { global: { siteTitle: 'Cafe', navigation: [{ label: 'Menu', page: 'menu' }], primaryCta: { label: 'Order now', target: 'form' }, footerText: 'Open daily for coffee lovers' }, pages: [{ slug: 'home', seo: { title: 'Cafe | Coffee', description: 'Good coffee.' }, sections: [{ id: 's', heading: 'Fresh coffee every morning', subheading: '', body: ['We roast beans in the shop each day.'], items: [], imageAlt: {} }] }] };

test('invented text is found: three or more words that are not in the copy or the customer facts', () => {
  const allowed = allowedText(brief, content);
  const html = '<body><h1>Fresh coffee every morning</h1><p>We roast beans in the shop each day.</p><p>Handcrafted botanical formulations</p><p>Menu</p><script>var a = "not shown to visitors at all";</script><span class="material-symbols-outlined">arrow_forward long icon name</span></body>';
  assert.deepEqual(unknownText(html, allowed), ['Handcrafted botanical formulations']);
});

test('checkSite passes a clean site and flags the leftovers', () => {
  const clean = '<html lang="en"><head><title>Cafe | Coffee</title><meta name="description" content="Good coffee."></head><body><h1>Fresh coffee every morning</h1><img src="/images/asset-001.webp" alt="Barista"><a href="/">Home</a><a href="tel:+201001234567">Call</a></body></html>';
  const args = { brief, content, approvedSlugs: ['home'], pages: [{ slug: 'home', html: clean }], distFiles: new Set(['/images/asset-001.webp']), built: true, report: { forms: 0, emptyPhotoSlots: [] } };
  assert.deepEqual(checkSite(args).filter((c) => !c.ok), []);
  const dirty = '<html><head><script src="https://cdn.tailwindcss.com"></script><title>Other</title></head><body><img src="data:image/svg+xml;x"><img src="/images/missing.webp" alt="x"><a href="#">x</a><a href="/nowhere/">y</a><a href="tel:+999">z</a><h1>a</h1><h1>b</h1></body></html>';
  const failed = checkSite({ ...args, pages: [{ slug: 'home', html: dirty }], imageSizes: { 'big.webp': 900 * 1024 } }).filter((c) => !c.ok).map((c) => c.name);
  for (const part of ['leftovers', 'alt text', 'picture file exists', 'web-sized', 'link goes somewhere', 'SEO title', 'exactly one main', 'phone and email']) assert.ok(failed.some((n) => n.includes(part)), `expected a failing check about "${part}"`);
  assert.equal(checkSite({ ...args, built: false, pages: [] }).find((c) => c.name.includes('built')).ok, false);
});

test('generated files: package, tailwind config from the design, business data for search engines', () => {
  assert.equal(JSON.parse(packageJson('Cafe & Bar!')).name, 'cafe-bar');
  assert.match(tailwindConfigFile({ theme: { extend: { colors: { primary: '#fff' } } } }), /"primary": "#fff"/);
  const ld = jsonLdFor({ business: { name: 'Cafe', description: '', contact: { phone: '123', email: '', address: '', hours: '' }, socialLinks: [{ platform: 'ig', url: 'https://i.com/c' }, { platform: 'x', url: 'not-a-url' }] } });
  assert.deepEqual(ld, { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Cafe', telephone: '123', sameAs: ['https://i.com/c'] });
  assert.equal(normalizeLabel('<span class="material-symbols-outlined">menu</span> Order  Now!'), 'order now');
});

test('a rejected combined picture is a failing check only when it is still shown; pending ones are only reported', () => {
  const page = (img) => ({ slug: 'home', html: `<html lang="en"><head><title>Cafe | Coffee</title><meta name="description" content="Good coffee."></head><body><h1>Fresh coffee every morning</h1>${img}</body></html>` });
  const args = { brief, content, approvedSlugs: ['home'], distFiles: new Set(['/images/combo-1.webp']), built: true };
  const shown = checkSite({ ...args, pages: [page('<img src="/images/combo-1.webp" alt="Coffee and cake">')], report: { forms: 0, emptyPhotoSlots: [], combined: [{ id: 'combo-1', approval: 'rejected', used: false }] } });
  assert.equal(shown.find((c) => c.name.includes('rejected')).ok, false);
  const hidden = checkSite({ ...args, pages: [page('<div aria-hidden="true"></div>')], report: { forms: 0, emptyPhotoSlots: [], combined: [{ id: 'combo-1', approval: 'rejected', used: false }] } });
  assert.equal(hidden.find((c) => c.name.includes('rejected')).ok, true);
  const pending = checkSite({ ...args, pages: [page('<img src="/images/combo-1.webp" alt="Coffee and cake">')], report: { forms: 0, emptyPhotoSlots: [], combined: [{ id: 'combo-1', approval: 'pending', used: true }] } });
  assert.match(pending.find((c) => c.name.includes('waiting for the owner')).details, /combo-1/);
});

test('invented text is removed from the page; links and buttons are never removed; the customer\'s own handle lines stay', () => {
  const brief2 = { ...brief, business: { ...brief.business, socialLinks: [{ platform: 'instagram', url: 'https://www.instagram.com/cafe_shop' }, { platform: 'tiktok', url: 'https://www.tiktok.com/@cafe_shop' }] } };
  const allowed = allowedText(brief2, content);
  const html = '<h1>Fresh coffee every morning</h1><div class="x">Pure botanical poise</div><p>Instagram &amp; TikTok: @cafe_shop</p><span>how-to-order-hero-image</span><p>We roast beans in the shop each day.</p><a href="/">Message on TikTok now</a><li>Menu</li>';
  const { html: out, removed } = removeInventedText(html, allowed);
  assert.deepEqual(removed, ['Pure botanical poise', 'how-to-order-hero-image']);
  assert.ok(out.includes('Instagram &amp; TikTok: @cafe_shop') && out.includes('We roast beans') && out.includes('<h1>Fresh coffee every morning</h1>'));
  assert.ok(out.includes('<a href="/">Message on TikTok now</a>'), 'a link is only reported by the checks, not removed');
  assert.ok(!out.includes('Pure botanical') && !out.includes('hero-image'));
  assert.deepEqual(unknownText(out, allowed), ['Message on TikTok now']);
});

test('comments left by Stitch (they hold picture addresses) are removed from the page', () => {
  assert.equal(cleanBody('<p>a</p><!-- Right column https://lh3.googleusercontent.com/x -->'), '<p>a</p>');
});

test('icon glyph names (arrow_right_alt) are never removed as invented text', () => {
  const allowed = allowedText(brief, content);
  const html = '<span class="material-symbols-outlined">arrow_right_alt</span><span class="x">arrow_right_alt</span><i class="icon">arrow right alt here</i>';
  assert.deepEqual(removeInventedText(html, allowed), { html, removed: [] });
});

test('Stitch frames: a hidden <img> becomes a visible photo that fills its frame, and the drawn placeholder is removed (only in that frame)', () => {
  const frame = (slot, extra = '') => `<div class="relative aspect-[4/5] overflow-hidden"><img alt="${slot}" class="hidden${extra}" src="x"/><div class="flex"><span class="dot"></span></div><div class="flex my-auto"><svg height="66"><rect/></svg></div></div><h3>Title</h3>`;
  const html = frame('a') + frame('b') + '<div class="frame2"><svg><path/></svg></div>';
  const { html: out, stats } = swapImagesForSite(html, { slots: new Map([['a', 'asset-001'], ['b', null]]), altFor: (id) => `photo ${id}`, logoAssetId: null, businessName: 'Cafe', tint: '#11223344', assetByFilename: new Map() });
  assert.match(out, /<img src="\/images\/asset-001\.webp" alt="photo a" class="absolute inset-0 w-full h-full object-cover"/);
  assert.ok(!/data-photo-frame/.test(out), 'the marker never reaches the page');
  const firstFrame = out.slice(0, out.indexOf('<h3>'));
  assert.ok(!firstFrame.includes('<svg'), 'the drawn bottle in the photo frame is gone');
  assert.ok(!out.includes('<svg height="66">'), 'the drawn bottle is gone from the empty frame too: no drawing of a product we have no photo of');
  assert.ok(out.includes('class="absolute inset-0 w-full h-full object-cover" aria-hidden="true" data-empty-photo style="background:#11223344"'), 'the empty frame is a visible quiet tinted block');
  assert.ok(out.includes('<div class="frame2"><svg>'), 'other drawings elsewhere on the page stay');
  assert.deepEqual(stats.empty, ['b']);
});

test('a hidden photo that already has a size keeps it, a visible one is untouched', async () => {
  const { photoClasses } = await import('../src/lib/frames.js');
  assert.deepEqual(photoClasses('hidden w-full h-40 object-cover'), { classes: 'w-full h-40 object-cover', marked: true });
  assert.deepEqual(photoClasses('w-full h-full'), { classes: 'w-full h-full', marked: false });
  assert.deepEqual(photoClasses(undefined), { classes: undefined, marked: false });
});

test('only the fonts the design uses are loaded, once each (not the extra ones Stitch pages carry)', async () => {
  const { usedFontLinks } = await import('../src/stages/07-site/transform.js');
  const links = [
    'https://fonts.googleapis.com/css2?family=Tenor+Sans&display=swap',
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=Epilogue:wght@300&family=Parisienne&display=swap',
    'https://fonts.googleapis.com/css2?family=Albert+Sans:ital,wght@0,300;0,400&family=Tenor+Sans&display=swap',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap',
  ];
  const kept = usedFontLinks(links, '{"fontFamily":{"headline":["Tenor Sans"],"body":["Albert Sans"],"script":["Parisienne"]}}');
  assert.deepEqual(kept, [
    'https://fonts.googleapis.com/css2?family=Tenor+Sans&display=swap',
    'https://fonts.googleapis.com/css2?family=Parisienne&display=swap',
    'https://fonts.googleapis.com/css2?family=Albert+Sans:ital,wght@0,300;0,400&display=swap',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap',
  ]);
});

test('footer links to pages that do not exist (privacy, terms) are removed with their list item; real links stay', async () => {
  const { dropUnbackedLegalLinks } = await import('../src/stages/07-site/transform.js');
  const html = '<ul><li><a href="#">Privacy Policy</a></li><li><a href="/contact/">Contact</a></li><li class="x"><a href="#"><span>Terms of Service</span></a></li></ul><a href="#">Cookie settings</a><a href="#">Mystery</a><a href="/privacy/">Privacy</a>';
  const r = dropUnbackedLegalLinks(html);
  assert.deepEqual(r.removed, ['Privacy Policy', 'Terms of Service', 'Cookie settings']);
  assert.equal(r.html, '<ul><li><a href="/contact/">Contact</a></li></ul><a href="#">Mystery</a><a href="/privacy/">Privacy</a>');
});

test('grey loading-skeleton bars (and the card that held only them) are removed; dividers, accents and real content stay', async () => {
  const { removeSkeletons } = await import('../src/stages/07-site/textRules.js');
  const card = '<div class="border p-5"><div class="h-4 w-1/3 bg-outline-variant/20 mb-2"></div> <div class="h-3 w-2/3 bg-outline-variant/10"></div></div>';
  const real = '<div class="border p-5"><div class="h-4 w-1/3 bg-outline-variant/20"></div><p>Real text</p></div>';
  const keep = '<div class="w-full h-[1px] bg-outline-variant/30"></div><div class="h-px w-full bg-line/20"></div><div class="h-2 w-12 bg-primary/20"></div><div class="h-4 w-1/3 bg-primary"></div><div class="aspect-[4/5]"></div>';
  const r = removeSkeletons('<section><h2>Title</h2>' + card + real + keep + '</section>');
  assert.equal(r.removed, 3);
  assert.equal(r.html, '<section><h2>Title</h2><div class="border p-5"><p>Real text</p></div>' + keep + '</section>');
  assert.deepEqual(removeSkeletons('<p>nothing to do</p>'), { html: '<p>nothing to do</p>', removed: 0 });
  // containers collapse upwards, but never past something that has content
  const nested = '<div class="outer"><div class="inner"><div class="h-3 w-full bg-x/10"></div></div></div><p>after</p>';
  assert.equal(removeSkeletons(nested).html, '<p>after</p>');
});

test('grey bars with a wide fixed width (w-48, w-96) are skeletons too; short accent lines are not', async () => {
  const { removeSkeletons } = await import('../src/stages/07-site/textRules.js');
  const card = '<div class="border"><div class="h-3 w-48 bg-outline-variant/20 mb-2"></div><div class="h-2 w-96 bg-outline-variant/10"></div></div>';
  const accent = '<div class="h-2 w-12 bg-primary/20"></div><div class="h-2 w-16 bg-primary/10"></div>';
  const r = removeSkeletons('<section>' + card + accent + '</section>');
  assert.equal(r.removed, 2);
  assert.equal(r.html, '<section>' + accent + '</section>');
});
