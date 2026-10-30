// The customer-facing flow, separated from the web server so it can be tested:
//   form -> answers.json, validation, safe upload names, plain-language proposals, and the pipeline steps
//   (with a queue and a saved state per customer). The real stages are plugged in by customer.js.

import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from '../lib/project.js';
import { cleanItems, cleanItemPhotos, itemLines } from '../lib/shopItems.js';
import { cleanCurrency } from '../lib/price.js';

export const GOAL_OPTIONS = {
  orders: 'Get orders by message or DM',
  bookings: 'Get bookings or appointments',
  showcase: 'Show my products and prices',
  calls: 'Get phone calls and visits',
  trust: 'Introduce my business and build trust',
  other: 'Something else',
};
export const SITE_TYPES = { menu: 'Menu or food', shop: 'Shop', services: 'Services', intro: 'Introduce my business', both: 'Introduce and sell a few things' };
export const PAGE_OPTIONS = { products: 'Products or menu', about: 'About us', gallery: 'Gallery', contact: 'Contact' };
export const FEATURE_OPTIONS = { 'contact form': 'A contact form', map: 'A map to find me', 'booking link': 'A booking link', 'social links': 'Links to my social media', gallery: 'A photo gallery' };

const text = (v, max = 1200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, allowed) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x in allowed) : []);

// Hard rules only. Missing phone / address / hours are "soft": the form asks, the customer may continue without them.
export const STORY_MIN = 20; // the owner's story is required (it inspires the About section): a few sentences, not one word
const storyProblem = (form) => (text(form.story, 3000).length < STORY_MIN ? 'Please tell us your story in a few sentences: it is the inspiration for the About section of your website.' : null);

export function validateSubmission(form = {}) {
  if (form.siteType === 'shop') return validateShop(form);
  const errors = [];
  if (text(form.businessName, 100).length < 2) errors.push('Please tell us the name of your business.');
  if (storyProblem(form)) errors.push(storyProblem(form));
  if (!(form.goal in GOAL_OPTIONS)) errors.push('Please choose the main thing your website should do for you.');
  if (form.goal === 'other' && text(form.goalText).length < 3) errors.push('Please describe, in a few words, what your website should do.');
  const soft = [];
  if (!text(form.phone)) soft.push('phone');
  if (!text(form.address)) soft.push('address');
  if (!text(form.hours)) soft.push('hours');
  return { ok: errors.length === 0, errors, soft };
}

// The shop form: the product list is the heart of it. A product needs a name; a price is optional (empty = no price shown).
// There is no "main goal" question: a shop is for orders. Customers must have at least one way to reach the owner.
function validateShop(form) {
  const errors = [];
  if (text(form.businessName, 100).length < 2) errors.push('Please tell us the name of your business.');
  if (storyProblem(form)) errors.push(storyProblem(form));
  const items = cleanItems(form.items);
  if (!items.length && form.shopKind !== 'intro') errors.push({ menu: 'Please add at least one dish to your menu.', services: 'Please add at least one service to your list.' }[form.shopKind] ?? 'Please add at least one product to your list.');
  if (form.shopKind === 'services' && form.orderMode === 'panel' && (!Array.isArray(form.openDays) || !form.openDays.length || !(text(form.openTo, 5) > text(form.openFrom, 5)))) errors.push('Please tick the days you take appointments, and choose opening hours where "Until" is later than "From".');
  if (!['phone', 'whatsapp', 'email', 'instagram', 'tiktok', 'facebook'].some((k) => text(form[k], 120))) errors.push('Please give at least one way for customers to order or contact you (a phone number, WhatsApp, email or a social page).');
  return { ok: errors.length === 0, errors, soft: [] };
}

// The form -> the answers file used by Stage 1 (same keys as the interview).
export function formToAnswers(form = {}) {
  if (form.siteType === 'shop') return shopAnswers(form);
  const goal = form.goal in GOAL_OPTIONS ? GOAL_OPTIONS[form.goal] : '';
  const mainGoal = [goal, text(form.goalText)].filter(Boolean).join('. ');
  const contact = [`Phone: ${text(form.phone, 60)}`, `Email: ${text(form.email, 100)}`, `Address: ${text(form.address, 200)}`, `Hours: ${text(form.hours, 200)}`];
  for (const [label, key] of [['Instagram', 'instagram'], ['TikTok', 'tiktok'], ['Facebook', 'facebook']]) if (text(form[key], 120)) contact.push(`${label}: ${text(form[key], 120)}`);
  const priceNote = { yes: 'The owner wants prices shown on the website.', no: 'The owner does NOT want prices shown on the website.', some: 'The owner wants prices shown for some items only.' }[form.showPrices] ?? '';
  // the page is named after the kind of site ("Menu" for a restaurant), never the generic form label "Products or menu"
  const pageName = (k) => text(form.pageNames?.[k], 30) || PAGE_OPTIONS[k];
  const pages = ['Home', ...list(form.pages, PAGE_OPTIONS).map((k) => pageName(k)), ...text(form.otherPages, 200).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)];
  const features = list(form.features, FEATURE_OPTIONS).map((k) => (k === 'booking link' && text(form.bookingUrl, 300) ? `booking link: ${text(form.bookingUrl, 300)}` : k));
  const brand = [text(form.brandColors, 200) && `Colors: ${text(form.brandColors, 200)}`, form.hasLogo ? 'The customer uploaded their logo.' : 'The customer has no logo file yet.'].filter(Boolean).join(' ');
  return {
    businessName: text(form.businessName, 100),
    whatItDoes: text(form.whatItDoes),
    locationAndContact: contact.join('\n'),
    customers: text(form.customers),
    notFor: text(form.notFor),
    story: text(form.story, 3000),
    mainGoal,
    productsAndServices: [text(form.products, 2500), priceNote].filter(Boolean).join('\n'),
    pages: pages.length > 1 ? pages.join(', ') : '',
    features: features.join(', '),
    brand,
    brandFeeling: text(form.feelingWords, 200),
    likedSites: text(form.likedSites),
    dislikedSites: text(form.dislikedSites),
    whatsapp: text(form.whatsapp, 40),
    messagesTo: ['whatsapp', 'email'].includes(form.messagesTo) ? form.messagesTo : '',
    homeWishes: text(form.homeWishes, 1500),
    aiPictures: form.aiPictures === 'photos-only' ? 'photos-only' : 'allowed',
    anythingElse: text(form.notes, 2000),
    followUps: [],
  };
}

// The shop form's answers: the general keys the interview already reads, plus the owner's own product list and photo links.
function shopAnswers(form) {
  const items = cleanItems(form.items);
  const kind = ['menu', 'shop', 'services', 'intro'].includes(form.shopKind) ? form.shopKind : 'shop';
  const menu = kind === 'menu'; // a restaurant or cafe: the menu is built from the dish photos and the list, nobody sends a menu file
  const services = kind === 'services'; // a salon, a clinic: services with prices, and a way to book
  const intro = kind === 'intro'; // a website that presents the business (a portfolio, a firm): about, contact and, when the owner gave any, their work. No prices.
  const social = ['instagram', 'tiktok', 'facebook'].some((k) => text(form[k], 120));
  // what the owner gave decides the features (nothing to tick): a contact form when messages have somewhere to go, a map for an address...
  const features = [(text(form.whatsapp, 40) || text(form.email, 120)) && 'contact form', text(form.address, 300) && 'map', social && 'social links', services && text(form.bookingUrl, 300) && 'booking link'].filter(Boolean);
  const base = formToAnswers({ ...form, pageNames: { products: { menu: 'Menu', services: 'Services', shop: 'Shop', intro: 'Our work' }[kind] }, siteType: undefined, goal: { menu: 'showcase', services: 'bookings', shop: 'orders', intro: 'trust' }[kind], goalText: '', products: itemLines(items), showPrices: kind === 'intro' ? 'no' : items.every((i) => i.price) ? 'yes' : items.some((i) => i.price) ? 'some' : 'no', pages: intro ? (items.length ? ['about', 'products', 'contact'] : ['about', 'contact']) : services ? ['products', 'about', 'contact'] : ['products', 'contact'], otherPages: kind === 'shop' ? 'How to order' : '', features });
  return { ...base, siteType: kind, orderMode: ['whatsapp', 'panel'].includes(form.orderMode) ? form.orderMode : 'none', fulfil: Array.isArray(form.fulfil) ? form.fulfil.filter((f) => ['pickup', 'delivery', 'dinein'].includes(f)) : [], deliveryFee: text(form.deliveryFee, 10), assistant: { enabled: form.assistant === true, rules: text(form.assistantRules, 3000), model: form.assistantModel === 'economy' ? 'economy' : 'standard' }, ...(services && form.orderMode === 'panel' ? { openDays: Array.isArray(form.openDays) ? form.openDays : [], openFrom: text(form.openFrom, 5), openTo: text(form.openTo, 5), slotMinutes: Number(form.slotMinutes) || 60, timeZone: text(form.timeZone, 60) } : {}), currency: cleanCurrency(form.currency), items, itemPhotos: cleanItemPhotos(form.itemPhotos, items.length) };
}

// ---- uploads ----
const KINDS = {
  photo: { ext: ['.jpg', '.jpeg', '.png', '.webp', '.svg'], maxBytes: 5 * 1024 * 1024 },
  logo: { ext: ['.jpg', '.jpeg', '.png', '.webp', '.svg'], maxBytes: 5 * 1024 * 1024 },
  document: { ext: ['.pdf', '.jpg', '.jpeg', '.png', '.webp'], maxBytes: 20 * 1024 * 1024 }, // a PDF, or pictures of the pages
  knowledge: { ext: ['.pdf', '.docx', '.txt', '.md', '.csv', '.jpg', '.jpeg', '.png', '.webp'], maxBytes: 20 * 1024 * 1024 }, // what the website assistant should know
};
export const MAX_FILES = 170;
export const MAX_VARIANTS_PER_REQUEST = 4;
export const uploadLimit = (kind) => KINDS[kind]?.maxBytes ?? 0;

// A safe file name inside inputs/assets, or null when the kind or extension is not allowed.
export function safeUploadName(name, kind) {
  const rule = KINDS[kind];
  if (!rule) return null;
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!rule.ext.includes(ext)) return null;
  if (kind === 'logo') return `logo${ext}`;
  const prefix = kind === 'document' && ext !== '.pdf' ? 'document-' : ''; // a picture of a menu is a document, never a photo of the website (Stage 2 reads the prefix)
  const base = path.basename(String(name), path.extname(String(name))).normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'file';
  return `${prefix}${base}${ext}`;
}

// Does the content look like what the extension says? (a light check, not a virus scan)
export function looksLikeFile(buffer, ext) {
  const head = buffer.subarray(0, 12);
  if (ext === '.png') return head.subarray(1, 4).toString() === 'PNG';
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xff && head[1] === 0xd8;
  if (ext === '.webp') return head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
  if (ext === '.pdf') return head.subarray(0, 4).toString() === '%PDF';
  if (ext === '.svg') return buffer.subarray(0, 400).toString('utf8').includes('<svg');
  if (ext === '.docx') return head.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004'; // a zip
  if (['.txt', '.md', '.csv'].includes(ext)) return !buffer.subarray(0, 2000).includes(0); // text has no zero bytes
  return false;
}

// ---- what we found in the photos, in plain words ----
const LABELS = {
  'business.type': 'The kind of business you run',
  'business.description': 'How we would describe your business',
  offerings: 'Products or services we noticed',
  'offerings.prices': 'Prices from your price list',
  'offerings.products': 'Products we can read in your photos (are these really yours to sell?)',
  'business.contact.phone': 'A phone number we saw',
  'business.contact.email': 'An email address we saw',
  'business.contact.address': 'An address we saw',
  'business.contact.hours': 'Opening hours we saw',
  'business.socialLinks': 'Your social media accounts',
  'brand.hasIdentity': 'Your logo',
  'brand.colors': 'Your brand colors',
  'brand.personality': 'Words that describe your style',
  tone: 'The tone of the words on your website',
};
export function friendlyProposals(proposals) {
  return proposals.map((p, index) => ({ p, index })).filter(({ p }) => p.status === 'pending').map(({ p, index }) => {
    const raw = p.value;
    let kind = 'text';
    let value = raw;
    if (p.path === 'brand.colors') kind = 'colors';
    else if (p.path === 'offerings.prices') { kind = 'list'; value = raw.map((e) => e.replace('|', ': ')); }
    else if (p.path === 'offerings.products') { kind = 'list'; value = raw.map((e) => e.split('|')[0]); }
    else if (p.path === 'business.socialLinks') { kind = 'list'; value = raw.map((e) => e.replace(':', ' @')); }
    else if (Array.isArray(raw)) kind = 'list';
    else if (raw === true) value = 'We found your logo in the files you uploaded.';
    return { index, key: p.path, label: LABELS[p.path] ?? p.path, kind, value };
  });
}

// ---- progress steps shown to the customer ----
export const STEPS = [
  { key: 'brief', label: 'Reading your answers' },
  { key: 'photos', label: 'Looking at your photos' },
  { key: 'check', label: 'Checking what we found' },
  { key: 'direction', label: 'Choosing the look of your website' },
  { key: 'copy', label: 'Writing the text' },
  { key: 'sketches', label: 'Drawing all the pages of your website' },
];

// ---- the flow: saved state per customer + a queue so only one pipeline runs at a time ----
export function createFlow({ steps }) {
  const memory = new Map();
  const running = new Set();
  let queue = Promise.resolve();
  let waiting = 0;

  const stateFile = (id) => projectPath(id, 'customer-state.json');
  const read = (id) => memory.get(id) ?? (fs.existsSync(stateFile(id)) ? JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) : null);
  function save(id, patch) {
    const next = { ...(read(id) ?? { id, phase: 'new', steps: STEPS.map((s) => ({ ...s, status: 'waiting' })) }), ...patch, updatedAt: new Date().toISOString() };
    memory.set(id, next);
    fs.writeFileSync(stateFile(id), JSON.stringify(next, null, 2));
    return next;
  }
  const markStep = (id, key, status) => save(id, { steps: read(id).steps.map((s) => (s.key === key ? { ...s, status } : s)) });
  const enqueue = (id, job) => {
    waiting++;
    save(id, { queuePosition: waiting });
    queue = queue.then(() => { waiting = Math.max(0, waiting - 1); return job(); }, () => job());
    return queue;
  };

  async function guarded(id, label, fn) {
    if (running.has(id)) return;
    running.add(id);
    try {
      await fn();
    } catch (err) {
      console.error(`[customer] ${label} failed for ${id}: ${err.message}`);
      save(id, { phase: 'failed', message: 'Something went wrong while preparing your sketches. Please try again in a moment.', internalError: err.message });
    } finally {
      running.delete(id);
    }
  }

  // part 1: understand the business. Stops for the customer to confirm what was found, when something was found.
  const start = (id) => enqueue(id, () => guarded(id, 'part 1', async () => {
    save(id, { phase: 'analyzing', message: '', queuePosition: 0 });
    markStep(id, 'brief', 'working'); await steps.brief(id); markStep(id, 'brief', 'done');
    markStep(id, 'photos', 'working'); await steps.photos(id); markStep(id, 'photos', 'done');
    markStep(id, 'check', 'working');
    const found = await steps.findings(id); // runs enrich, returns the plain-language list
    if (found.length) { save(id, { phase: 'confirm', findings: found }); return; }
    markStep(id, 'check', 'done');
    await design(id);
  }));

  async function design(id, { skip = [] } = {}) {
    save(id, { phase: 'designing', findings: [], message: '' });
    if (!skip.includes('direction')) { markStep(id, 'direction', 'working'); await steps.direction(id); markStep(id, 'direction', 'done'); }
    if (!skip.includes('copy')) { markStep(id, 'copy', 'working'); await steps.copy(id); markStep(id, 'copy', 'done'); }
    markStep(id, 'sketches', 'working'); await steps.sketches(id); markStep(id, 'sketches', 'done');
    save(id, { phase: 'ready' });
  }

  // part 2: after the customer confirmed (or corrected) what we found
  const confirm = (id, decisions) => enqueue(id, () => guarded(id, 'part 2', async () => {
    await steps.applyDecisions(id, decisions);
    markStep(id, 'check', 'done');
    await design(id);
  }));

  // sketch 2 (a different style), only when the customer asks for it. A failure here never breaks the request.
  const another = (id) => {
    if (read(id)?.alt === 'working' || read(id)?.alt === 'ready') return Promise.resolve();
    save(id, { alt: 'working' });
    return enqueue(id, async () => {
      try { await steps.another(id); save(id, { alt: 'ready' }); } catch (err) { console.error(`[customer] another style failed for ${id}: ${err.message}`); save(id, { alt: 'failed' }); }
    });
  };

  // another version of one page, only when the customer asks for it (a few per request: each takes about two minutes).
  // A failure here never breaks the request.
  const variant = (id, slug) => {
    const now = read(id)?.variants ?? {};
    if (now[slug] === 'working' || now[slug] === 'ready') return Promise.resolve();
    if (Object.values(now).filter((v) => v === 'working' || v === 'ready').length >= MAX_VARIANTS_PER_REQUEST) throw Object.assign(new Error(`You can ask for up to ${MAX_VARIANTS_PER_REQUEST} other versions.`), { status: 409 });
    save(id, { variants: { ...now, [slug]: 'working' } });
    return enqueue(id, async () => {
      try { await steps.variant(id, slug); save(id, { variants: { ...(read(id)?.variants ?? {}), [slug]: 'ready' } }); }
      catch (err) { console.error(`[customer] another version of ${slug} failed for ${id}: ${err.message}`); save(id, { variants: { ...(read(id)?.variants ?? {}), [slug]: 'failed' } }); }
    });
  };

  // the customer chose: record it, then build the other pages in the chosen style
  const finish = (id, { choice, note }) => enqueue(id, () => guarded(id, 'finish', async () => {
    save(id, { phase: 'building', message: '' });
    await steps.recordChoice(id, { choice, note });
    await steps.rest(id); // only draws pages that are missing (a different style needs the other pages again)
    await steps.approve(id); // the customer saw every page: approved-design.json is written
    save(id, { phase: 'chosen' });
  }));

  // a server restart or a failure: run again from the start (photo analysis is cached, so it is cheap)
  // "Try again" continues where it stopped: the steps already done (and paid for) are not run again.
  const retry = (id) => {
    const done = (key) => read(id)?.steps?.find((x) => x.key === key)?.status === 'done';
    if (!['brief', 'photos', 'check'].every(done)) return start(id);
    return enqueue(id, () => guarded(id, 'resume', () => design(id, { skip: ['direction', 'copy'].filter(done) })));
  };

  function status(id) {
    const s = read(id);
    if (!s) return null;
    const stuck = ['analyzing', 'designing'].includes(s.phase) && !running.has(id) && waiting === 0;
    return stuck ? { ...s, phase: 'failed', message: 'This took longer than expected. Press "Try again" and we will continue.' } : s;
  }
  return { start, confirm, retry, another, variant, finish, status, save, read };
}
