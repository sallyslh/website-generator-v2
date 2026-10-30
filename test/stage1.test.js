// Unit tests for the Stage 1 automatic checks (no API calls): good brief passes, tampered ones fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBrief } from '../src/stages/01-discovery/checks.js';

const answers = {
  businessName: 'Studio Lina',
  locationAndContact: 'Phone: 70 123 456\nEmail: \nAddress: Hamra, Beirut\nHours: Tue-Sat 10-7',
  productsAndServices: 'Haircut from $25; Color; Balayage',
  pages: 'home, services',
  brand: 'I like pink',
  likedSites: '',
  dislikedSites: '',
  anythingElse: '',
  followUps: [],
};

const goodBrief = () => ({
  schemaVersion: 1,
  projectId: 'p',
  business: {
    name: 'Studio Lina', type: 'hair salon', description: 'Hair salon in Hamra', location: 'Hamra, Beirut',
    contact: { phone: '70 123 456', email: '', address: 'Hamra, Beirut', hours: 'Tue-Sat 10-7' },
    socialLinks: [],
  },
  goals: { primary: 'bookings', secondary: [] },
  audience: { description: 'women', needs: [] },
  offerings: [{ name: 'Haircut', description: '', price: 'from $25' }, { name: 'Color', description: '' }, { name: 'Balayage', description: '' }],
  pages: [{ slug: 'home', title: 'Home', purpose: '' }, { slug: 'services', title: 'Services', purpose: '' }],
  features: [{ type: 'gallery' }],
  brand: { hasIdentity: false, colors: ['pink'], personality: ['fresh'] },
  tone: 'fresh',
  references: { liked: [], disliked: [] },
  language: 'en',
  unknowns: ['No email provided', 'No liked reference websites provided', 'No disliked reference websites provided'],
});

const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

test('good brief passes every check', () => {
  assert.deepEqual(failed(checkBrief(goodBrief(), answers)), []);
});

test('invented phone number is caught', () => {
  const brief = goodBrief();
  brief.business.contact.phone = '+961 1 999 999';
  assert.ok(failed(checkBrief(brief, answers)).some((n) => n.includes('invented')));
});

test('invented price and invented hex color are caught', () => {
  const brief = goodBrief();
  brief.offerings[1].price = '$40';
  brief.brand.colors = ['#FF69B4'];
  const result = checkBrief(brief, answers).find((r) => r.name.includes('invented'));
  assert.equal(result.ok, false);
  assert.match(result.details, /40/);
  assert.match(result.details, /#FF69B4/);
});

test('missing offering and missing unknowns entry are caught', () => {
  const brief = goodBrief();
  brief.offerings = brief.offerings.slice(0, 1);
  brief.unknowns = [];
  const names = failed(checkBrief(brief, answers));
  assert.ok(names.some((n) => n.includes('offering')));
  assert.ok(names.some((n) => n.includes('unknowns')));
});

test('no home page fails the schema check', () => {
  const brief = goodBrief();
  brief.pages = [{ slug: 'services', title: 'Services', purpose: '' }];
  assert.deepEqual(failed(checkBrief(brief, answers)), ['schema valid']);
});

test('social url built from the owner handle is fine, other invented urls are not', () => {
  const withHandle = { ...answers, anythingElse: 'Instagram is @studiolina.hamra' };
  const brief = goodBrief();
  brief.business.socialLinks = [{ platform: 'instagram', url: 'https://www.instagram.com/studiolina.hamra' }];
  assert.deepEqual(failed(checkBrief(brief, withHandle)), []);
  brief.business.socialLinks = [{ platform: 'instagram', url: 'https://www.instagram.com/someone.else' }];
  assert.ok(failed(checkBrief(brief, withHandle)).some((n) => n.includes('invented')));
});
