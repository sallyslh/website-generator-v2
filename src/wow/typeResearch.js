// The page list of a business type, made like a designer would make it: the customer is never asked how the site is structured.
//   1. the model drafts every page a site of this kind could have (optionally together with a hand-researched list)
//   2. a second step builds the final structure: a short list of top-level pages, each with SECTIONS inside it. Variants and related
//      things (every kind of ordering, every kind of booking, each treatment of a clinic) are sections of ONE page, never several pages
//      that say the same thing. The list is ordered from the most to the least important, in three tiers.
// A type that does not have a file yet ("Café", or anything typed under "Other") is drafted once and saved, so the next customer of
// that type gets it instantly and free. A person should read each new file once: it is the model's knowledge, not a proven fact.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { TYPES_DIR, slugOf } from './run.js';
import { reviewAndRepair } from './listReview.js';

export const KNOWN_TYPES = [
  { id: 'padel', label: 'Padel / sports club', kind: 'services' },
  { id: 'restaurant', label: 'Restaurant', kind: 'menu' },
  { id: 'cafe', label: 'Café', kind: 'menu' },
  { id: 'bakery', label: 'Bakery', kind: 'menu' },
  { id: 'salon', label: 'Beauty salon', kind: 'services' },
  { id: 'barber', label: 'Barber', kind: 'services' },
  { id: 'gym', label: 'Gym / fitness', kind: 'services' },
  { id: 'clinic', label: 'Clinic / dentist', kind: 'services' },
  { id: 'hotel', label: 'Hotel / guesthouse', kind: 'services' },
  { id: 'shop', label: 'Shop / boutique', kind: 'shop' },
  { id: 'agency', label: 'Agency / studio', kind: 'intro' },
];

export const TIERS = ['essential', 'recommended', 'optional'];
// Nothing here is forced on the customer: every page can be removed and any can be added (the screen asks for at least 3 pages).
export const TIER_LABELS = { essential: 'Most important', recommended: 'Also useful', optional: 'Extras' };

const pageShape = {
  id: z.string().min(2), title: z.string().min(2), purpose: z.string().min(5), default: z.boolean().default(false),
  feature: z.enum(['booking', 'order', '']).default(''), featureNote: z.string().default(''), // which kinds of booking or ordering: "table", "room stay", "court slot"...
  demoNeeds: z.array(z.enum(['people', 'review', 'price', 'contact', 'stat'])).default([]),
};
const draftSchema = z.object({
  pages: z.array(z.object(pageShape)).min(8),
  homeSectionIdeas: z.array(z.string()).default([]),
  styleNotes: z.array(z.string()).default([]),
});
const consolidatedSchema = z.object({
  pages: z.array(z.object({
    ...pageShape,
    uniqueContent: z.string().min(10),
    tier: z.enum(TIERS),
    layoutIdea: z.string().default(''),
    sections: z.array(z.object({ title: z.string().min(2), content: z.string().default('') })).min(2),
    mergedFrom: z.array(z.string()).default([]),
  })).min(8),
  merges: z.array(z.object({ kept: z.string(), absorbed: z.array(z.string()).default([]), why: z.string().default('') })).default([]),
});

const SYSTEM = 'You are the lead designer of a web studio. You decide the structure of a small business website yourself, like an interior designer who arranges a room for the client instead of asking where the mirror goes. Be practical and grounded: only pages that real businesses of that kind actually have. Never assume alcohol, pork or anything the owner did not choose.';

export const fileFor = (id) => path.join(TYPES_DIR, `${id}.json`);
export const hasType = (id) => fs.existsSync(fileFor(id));

// Pages that are not pages of the design (legal text, accounts, a newsletter box) are dropped, and the draft is capped. A tiny tidy-up:
// it never refuses a list, it only trims it.
export const MAX_DRAFT_PAGES = 60;
const NOT_A_DESIGN_PAGE = /privacy|terms|cookie|newsletter|my[- ]?account|wish ?list|log ?in|sign ?in|sitemap|404/i;
export function tidyPages(pages) {
  const kept = pages.filter((p) => p.id === 'home' || p.id === 'contact' || !NOT_A_DESIGN_PAGE.test(`${p.id} ${p.title}`));
  const first = kept.filter((p) => p.default || p.locked); const rest = kept.filter((p) => !(p.default || p.locked));
  const dropped = new Set(rest.slice(Math.max(0, MAX_DRAFT_PAGES - first.length)));
  return kept.filter((p) => !dropped.has(p));
}

// The tier of a page in a file that has none (the hand-researched ones): used by the screen
export const tierOf = (p) => p.tier ?? (p.locked || p.default ? 'essential' : p.evidence === 'seen' ? 'recommended' : 'optional');

// Sections that look the same on two different pages (the Home page may preview anything). A check for a person or a test, not a rule that refuses.
const STOP = /\b(the|a|an|and|your|our|of|for|to|in|at|by|with|us)\b/g;
const wordsOf = (t) => new Set(String(t).toLowerCase().replace(/[^a-z ]/g, ' ').replace(STOP, ' ').split(/\s+/).filter((w) => w.length > 3));
export function duplicateSections(pages) {
  const all = pages.filter((p) => p.id !== 'home').flatMap((p) => (p.sections ?? []).map((s) => ({ page: p.title, id: p.id, section: s.title })));
  const found = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].id === all[j].id) continue;
    const a = wordsOf(all[i].section); const b = wordsOf(all[j].section);
    const same = [...a].filter((w) => b.has(w)).length;
    if (a.size && b.size && same >= 1 && same / Math.min(a.size, b.size) >= 0.67) found.push([`${all[i].page} > ${all[i].section}`, `${all[j].page} > ${all[j].section}`]);
  }
  return found;
}

export async function consolidatePages({ label, pages, ask = askJson }) {
  return ask({
    projectId: 'wow-research', stage: 'wow-type-merge', system: SYSTEM, schema: consolidatedSchema, maxTokens: 14000,
    prompt: `Here is a draft list of pages for the website of a "${label}". It comes from more than one source and many pages overlap. Build the FINAL structure the way a designer would, without asking the customer anything.
${JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, purpose: p.purpose, feature: p.feature ?? '', featureNote: p.featureNote ?? '', demoNeeds: p.demoNeeds ?? [], source: p.evidence === 'seen' ? 'found on real sites' : 'idea' })))}

STRUCTURE
- The final list has 12 to 20 TOP-LEVEL pages: what a visitor sees in the menu. Each page has SECTIONS (3 to 7), each with a one-line "content".
- A page has content that NO other page has ("uniqueContent": one sentence), and a visitor would look for it by name.
- Never several pages for the same idea under different names. Variants and related things are SECTIONS of one page:
  every kind of booking of one business is a section of ONE "Book" page; every kind of ordering (pickup, custom orders, holiday pre-orders, catering, subscriptions, gift cards) is a section of ONE "Order" page; each treatment or service of a hub (a clinic's treatments, a salon's services) is a section of ONE page; hours, directions and parking live in "Contact"; rules, policies and questions are one page; a beginner's guide and "how it works" are one page.
  A different kind of booking (a room stay and a restaurant table) can sit in the same page as sections, or in the page of what it belongs to (a table in the dining page), as a designer would decide.
- When one page holds many parallel items (the treatments of a clinic, the services of a salon, rooms, products), it is ONE long page: a clear overview board at the top that lets the visitor jump to each item further down, then a block for each item. Say so in "layoutIdea" (one sentence); other pages may leave it empty.
- A separate page is right when it has its own audience or its own substance: for example a team page, a gallery, reviews, corporate events, a junior programme, a shop, a story.
- Every section lives on exactly ONE page. The Home page may preview a section in a few words, but no other page repeats it: if two pages would both show it (a private room, a cake tasting, "book a court"), decide which page owns it and drop it from the other one, which simply links to it.
- Do not merge just to be short, and do not keep pages just to be long.

NAMES (very important)
- Page names are the plain, well-known names that any business owner and any visitor understands at once: the standard words websites use. Never a clever, poetic or marketing name.
  Prefer: Home, About us, Services, Prices, Menu, Shop, Order online, Book online, Team, Gallery, Reviews, FAQ, Contact, Events, News, Blog, Careers, Gift cards, Memberships, Classes, Lessons, Courts, Rooms, Offers, Catering, Wholesale, Private events, Community, Rules, Treatments, Our work.
  Bad names: "Customer Love", "Good to Know", "What's on", "Social play", "Regulars' Club", "Start Here", "The Experience".
- Use the common name of the thing: "Community" (not "Social play"), "Reviews" (not "Customer Love"), "FAQ" (not "Good to Know"), "About us" (not a story title), "Events" (not "What's on").
- One to three words. Add the trade's own word only when it is needed to be clear ("Padel lessons", "Wedding cakes", "Dental treatments").

ORDER AND TIERS
- Sort the list from the MOST important page to the least important for this kind of business.
- "tier": "essential" (5 to 7 pages this kind of business cannot do without), "recommended" (most good sites of this kind have it), "optional" (a nice extra that makes the site stand out).
- If people are part of what the business sells (coaches, barbers, dentists, stylists, chefs), the page that shows them is essential.
- Home and Contact are always essential. Keep their ids "home" and "contact".

FEATURES
- "feature" is "booking" or "order" on the page that holds that flow, and "featureNote" lists the kinds inside it (for example "court slot; private lesson; open match").

For each final page set "mergedFrom" to the ids of the draft pages it absorbed (including its own id). Also list every merge in "merges" with the reason.
Answer as JSON: {"pages":[{"id":"","title":"","purpose":"one sentence","uniqueContent":"","tier":"essential","layoutIdea":"","sections":[{"title":"","content":""}],"mergedFrom":[],"feature":"","featureNote":"","demoNeeds":[]}],"merges":[{"kept":"id","absorbed":["id"],"why":""}]}`,
  });
}

// The model's draft of a type file (not saved). existing: a hand-researched list to merge in (its evidence is kept).
export async function draftType({ id, label, kind = 'intro', merge = true, existing = [], ask = askJson }) {
  const safe = slugOf(id || label);
  const draft = await ask({
    projectId: 'wow-research', stage: 'wow-type', system: SYSTEM, schema: draftSchema, maxTokens: 9000,
    prompt: `The business type is "${label}". List 30 to 36 pages a website for this kind of business could have, from the most common to the more creative but still real ones.
Be specific and thorough, not only the standard pages: think of the particular programs, session formats, events, courses, community features, practical-information pages (rules, how it works, timetables, policies), and the pages that help a first-time visitor, a regular, a family and a company. Name real formats of this industry (for example the actual names of its competitions, classes or services) instead of generic words.
Rules: "home" and "contact" must be in the list. Mark default:true on the 5 most common pages (home and contact included). Pages are real pages with their own design: no legal pages (privacy, terms, cookies), no account or login pages, no newsletter sign-up page. "feature" is "booking" on a page where visitors book (a time, table, room, court...) and "order" on a page where visitors order online; "featureNote" says which kind. "demoNeeds" lists what sample content the page needs (people, review, price).
Answer as JSON: {"pages":[{"id":"short-slug","title":"","purpose":"one sentence","default":false,"feature":"","featureNote":"","demoNeeds":[]}],"homeSectionIdeas":["8 ideas for the home page's sections"],"styleNotes":["4 notes about the look that suits this business"]}`,
  });
  const fromModel = tidyPages(draft.pages.map((p) => ({ ...p, id: slugOf(p.id), evidence: 'idea' })));
  const mine = existing.map((p) => ({ ...p, id: slugOf(p.id) }));
  const have = new Set(mine.map((p) => p.id));
  const sources = [...mine, ...fromModel.filter((p) => !have.has(p.id))];
  const evidenceOf = new Map(sources.map((p) => [p.id, p.evidence ?? 'idea']));
  let pages; let merges = []; let review = null;
  if (merge) {
    const merged = await consolidatePages({ label, pages: sources, ask });
    pages = merged.pages.map((p) => { const from = (p.mergedFrom?.length ? p.mergedFrom : [p.id]).map(slugOf); return { ...p, id: slugOf(p.id), mergedFrom: from, evidence: from.some((f) => evidenceOf.get(f) === 'seen') ? 'seen' : 'idea' }; });
    merges = merged.merges;
    const checked = await reviewAndRepair({ label, pages, ask }); // an independent editor reads the result: repeats, thin pages, unclear names
    pages = checked.pages; review = checked.report;
  } else pages = sources.map((p) => ({ ...p, tier: tierOf(p), uniqueContent: p.purpose, sections: [], mergedFrom: [p.id] }));
  for (const must of [['home', 'Home', 'The first impression of the business, with the main action.'], ['contact', 'Contact', 'Where to find and reach the business.']])
    if (!pages.some((p) => p.id === must[0])) pages.unshift({ id: must[0], title: must[1], purpose: must[2], uniqueContent: must[2], tier: 'essential', sections: [], mergedFrom: [must[0]], default: true, feature: '', featureNote: '', demoNeeds: [], evidence: 'idea' });
  for (const p of pages) { if (p.id === 'home' || p.id === 'contact') p.tier = 'essential'; p.default = p.tier === 'essential'; delete p.locked; }
  if (pages.filter((p) => p.default).length < 4) for (const p of pages.filter((x) => !x.default).slice(0, 4 - pages.filter((x) => x.default).length)) { p.default = true; p.tier = 'essential'; }
  return {
    type: safe, label, kind, researchedAt: new Date().toISOString().slice(0, 10), draftedByModel: true,
    note: 'Written by the model from general knowledge' + (mine.length ? ' together with a hand-researched list (web searches)' : '') + '. Pages are ordered from the most to the least important; each has sections inside it. "merges" lists the draft pages that were joined because they said the same thing. A person should read it once.',
    draftPages: sources.length, pages, merges, review, homeSectionIdeas: draft.homeSectionIdeas, styleNotes: draft.styleNotes, sources: [],
  };
}

// The type file for this business type: drafted by the model once when it does not exist yet, then kept for the next customer.
// A file that exists is never overwritten here (use archiveAndReplace on purpose).
export async function ensureType({ id, label, kind = 'intro' }) {
  const safe = slugOf(id || label);
  if (hasType(safe)) return safe;
  const data = await draftType({ id: safe, label, kind });
  fs.mkdirSync(TYPES_DIR, { recursive: true });
  fs.writeFileSync(fileFor(safe), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); // "wx": fails instead of replacing a file
  return safe;
}

// Replaces a type file on purpose: the old file is first copied to src/data/archive/ so it can always be brought back.
export function archiveAndReplace(id, data) {
  const archive = path.join(path.dirname(TYPES_DIR), 'archive');
  fs.mkdirSync(archive, { recursive: true });
  let kept = null;
  if (hasType(id)) { kept = path.join(archive, `${id}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`); fs.copyFileSync(fileFor(id), kept); }
  fs.writeFileSync(fileFor(id), JSON.stringify(data, null, 2) + '\n');
  return kept;
}
