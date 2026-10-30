// Unit tests for the "brief from files" safety rules (no API calls).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterProposals, applyProposals, contactProposals } from '../src/stages/01-discovery/enrich.js';
import { siteBriefSchema } from '../src/schemas/siteBrief.js';

const brief = () => siteBriefSchema.parse({
  schemaVersion: 1, projectId: 'p',
  business: { name: 'Shop', type: '', description: '', location: '', contact: { phone: '', email: '', address: '', hours: 'Mon-Fri 9-5' } },
  goals: { primary: 'sell', secondary: [] }, audience: { description: '', needs: [] }, offerings: [],
  pages: [{ slug: 'home', title: 'Home', purpose: '' }], features: [],
  brand: { hasIdentity: false, colors: [], personality: [] }, tone: '',
  references: { liked: [], disliked: [] }, language: 'en',
  unknowns: ['Business type not provided', 'No phone number provided', 'Opening hours not provided', 'Products and services not provided'],
});

const manifest = {
  schemaVersion: 1, logo: 'asset-001', documents: [], gaps: [],
  assets: [
    { id: 'asset-001', file: 'inputs/assets/logo.jpg', hash: '', kind: 'logo', category: 'logo', description: 'A logo', quality: 'high', orientation: 'square', width: 600, height: 600, dominantColors: [], usableFor: [], notes: 'Text visible: "Shop" and "71-014463".' },
    { id: 'asset-002', file: 'inputs/assets/a.jpg', hash: '', kind: 'image', category: 'product', description: 'Lotion 236 ml', quality: 'high', orientation: 'portrait', width: 600, height: 800, dominantColors: [], usableFor: [], notes: 'Text visible: "236 ml / 8 fl oz".' },
  ],
};

test('contact proposals come from visible text only (and ignore sizes like 236 ml)', () => {
  const found = contactProposals(brief(), manifest);
  assert.deepEqual(found.map((f) => [f.path, f.value]), [['business.contact.phone', '71-014463']]);
});

test('social handles are found by code when the notes name the platform', () => {
  const m = structuredClone(manifest);
  m.assets[0].notes += ' Text visible: WhatsApp: 81 526 765; Instagram: bonza_perfumes; TikTok: bonza_perfumes; Facebook: Bonza Perfume';
  const social = contactProposals(brief(), m).find((p) => p.path === 'business.socialLinks');
  assert.deepEqual(social.value, ['instagram:bonza_perfumes', 'tiktok:bonza_perfumes']);
});

test('filter: owner answers are never overwritten, invented phones and unknown evidence are dropped', () => {
  const proposals = [
    { path: 'business.type', value: 'gift shop', evidence: 'asset-002 shows gifts' },
    { path: 'business.contact.hours', value: 'Mon-Sun 8-9', evidence: 'asset-001 shows it' },
    { path: 'business.contact.phone', value: '03 999 999', evidence: 'asset-001 shows it' },
    { path: 'business.contact.phone', value: '71-014463', evidence: 'asset-001 shows it' },
    { path: 'tone', value: 'warm', evidence: 'looks warm' },
    { path: 'business.location', value: 'Beirut', evidence: 'asset-001' },
  ];
  const { kept, dropped } = filterProposals(brief(), manifest, proposals);
  assert.deepEqual(kept.map((p) => `${p.path}=${p.value}`), ['business.type=gift shop', 'business.contact.phone=71-014463']);
  const reasons = dropped.map((d) => d.reason).join(' | ');
  assert.match(reasons, /owner already answered/);
  assert.match(reasons, /not visible text/);
  assert.match(reasons, /no real asset id/);
  assert.match(reasons, /path not allowed/);
});

test('social handles: must be visible text, URLs are built by code', () => {
  const m = structuredClone(manifest);
  m.assets[0].notes += ' Text visible: bonza_perfumes';
  const good = { path: 'business.socialLinks', value: ['instagram:bonza_perfumes'], evidence: 'asset-001 shows it' };
  const bad = { path: 'business.socialLinks', value: ['instagram:made_up_name'], evidence: 'asset-001 shows it' };
  const { kept, dropped } = filterProposals(brief(), m, [good, bad]);
  assert.equal(kept.length, 1);
  assert.match(dropped[0].reason, /handle is not visible/);
  const b = brief();
  b.proposals = [{ ...kept[0], status: 'accepted' }];
  assert.deepEqual(applyProposals(b).business.socialLinks, [{ platform: 'instagram', url: 'https://www.instagram.com/bonza_perfumes' }]);
});

test('apply: only accepted proposals are merged, matching unknowns disappear', () => {
  const b = brief();
  b.proposals = [
    { path: 'business.type', value: 'gift shop', evidence: 'asset-002', status: 'accepted' },
    { path: 'offerings', value: ['Tumblers', 'Cups'], evidence: 'asset-002', status: 'accepted' },
    { path: 'business.contact.phone', value: '71-014463', evidence: 'asset-001', status: 'rejected' },
  ];
  const out = applyProposals(b);
  assert.equal(out.business.type, 'gift shop');
  assert.deepEqual(out.offerings.map((o) => o.name), ['Tumblers', 'Cups']);
  assert.equal(out.business.contact.phone, '');
  assert.ok(!out.unknowns.some((u) => /type|product/i.test(u)));
  assert.ok(out.unknowns.some((u) => /phone/i.test(u)), 'rejected proposal keeps its unknown');
  assert.equal(b.business.type, '', 'input is not modified');
});

// ---- prices from price-list documents ----
import { priceProposals } from '../src/stages/01-discovery/enrich.js';
import { priceFromFact, missingPrices, numbersIn } from '../src/lib/prices.js';

const withDoc = (facts) => ({ ...manifest, documents: [{ id: 'doc-001', file: 'inputs/assets/prices.pdf', hash: '', summary: 'Price list', facts }] });

test('prices.js: reads name + price facts, finds numbers, finds missing prices', () => {
  assert.deepEqual(priceFromFact('Haircut: $25'), { name: 'Haircut', price: '$25' });
  assert.deepEqual(priceFromFact('Balayage - from 120 USD'), { name: 'Balayage', price: 'from 120 USD' });
  assert.equal(priceFromFact('Open Monday to Friday 9 to 5'), null);
  assert.deepEqual(numbersIn('$1,200 and 25.5'), ['1200', '25.5']);
  const b = brief();
  b.offerings = [{ name: 'Haircut', description: '', price: '$25' }, { name: 'Color', description: '', price: '$60' }, { name: 'Bridal', description: '' }];
  assert.deepEqual(missingPrices('Haircut $25 and more', b).map((o) => o.name), ['Color']);
});

test('price proposals: made from document facts, applied only when confirmed, never invented', () => {
  const b = brief();
  b.offerings = [{ name: 'Haircut', description: '' }];
  const m = withDoc(['Haircut: $25', 'Color: $60', 'Open Tue-Sat 10-7']);
  const proposals = priceProposals(b, m);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].value, ['Haircut|$25', 'Color|$60']);
  assert.match(proposals[0].evidence, /doc-001/);

  const { kept } = filterProposals(b, m, proposals);
  assert.equal(kept.length, 1);
  // a made-up price that is not in the document is dropped
  const fake = [{ path: 'offerings.prices', value: ['Haircut|$99'], evidence: 'doc-001 lists it' }];
  assert.match(filterProposals(b, m, fake).dropped[0].reason, /not written in any document/);

  b.proposals = [{ ...kept[0], status: 'accepted' }];
  const out = applyProposals(b);
  assert.deepEqual(out.offerings.map((o) => [o.name, o.price]), [['Haircut', '$25'], ['Color', '$60']]);
  // already priced offerings are not proposed again
  assert.equal(priceProposals(out, m).length, 0);
});

test('individual product names: only text that is readable in THEIR photo, confirmed by the owner, then added with their photo', () => {
  const b = brief();
  b.offerings = [{ name: "Men's eau de parfum", description: '' }]; // the owner listed a category already
  const m = structuredClone(manifest);
  m.assets[1].description = 'Two boxes: Dior Sauvage and Valentino Born in Roma on a table';
  m.assets[1].notes = 'Text visible: "SAUVAGE", "BORN IN ROMA".';
  const ask = (value) => filterProposals(b, m, [{ path: 'offerings.products', value, evidence: 'asset-002 shows the boxes' }]);
  // names that are readable in asset-002 are kept; the proposal still waits for the owner
  const ok = ask(['Dior Sauvage|asset-002', 'Valentino Born in Roma|asset-002']);
  assert.equal(ok.kept.length, 1);
  assert.equal(ok.kept[0].status, 'pending');
  // a name not readable in that photo, a photo that does not exist, or the logo photo: dropped
  assert.match(ask(['Creed Aventus|asset-002']).dropped[0].reason, /not readable/);
  assert.match(ask(['Dior Sauvage|asset-999']).dropped[0].reason, /not readable/);
  assert.match(ask(['Dior Sauvage|asset-001']).dropped[0].reason, /not readable/);
  const mixed = ask(['Dior Sauvage|asset-002', 'Creed Aventus|asset-002']);
  assert.deepEqual(mixed.kept[0].value, ['Dior Sauvage|asset-002'], 'the readable name is kept, the invented one is dropped');
  const split = structuredClone(m);
  split.assets[1].notes = 'Text visible: KAY ALI, DÉJÀ VU WHITE FLOWER, EAU DE PARFUM';
  assert.equal(filterProposals(b, split, [{ path: 'offerings.products', value: ['Kay Ali Déjà Vu White Flower|asset-002'], evidence: 'asset-002' }]).kept.length, 1, 'commas between the words do not matter');
  // products already known are not proposed again
  b.offerings.push({ name: 'dior sauvage', description: '' });
  assert.match(filterProposals(b, m, [{ path: 'offerings.products', value: ['Dior Sauvage|asset-002'], evidence: 'asset-002' }]).dropped[0].reason, /already/);
  // only after the owner accepts do the products join the brief, each with the photo it is visible in
  const accepted = brief();
  accepted.offerings = [{ name: "Men's eau de parfum", description: '' }];
  accepted.proposals = [{ path: 'offerings.products', value: ['Dior Sauvage|asset-002'], evidence: 'asset-002', status: 'pending' }];
  assert.equal(applyProposals(accepted).offerings.length, 1, 'pending proposals change nothing');
  accepted.proposals[0].status = 'accepted';
  assert.deepEqual(applyProposals(accepted).offerings, [{ name: "Men's eau de parfum", description: '' }, { name: 'Dior Sauvage', description: '', assetId: 'asset-002' }]);
  accepted.proposals[0].status = 'rejected';
  assert.equal(applyProposals(accepted).offerings.length, 1);
});
