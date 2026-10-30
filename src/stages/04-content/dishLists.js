// Long lists (a menu of 100 dishes, a catalog) are not written by the model. The model only says WHICH dishes go in which section
// (by their number in the owner's list); code copies each dish's name, price and description from the owner's list, word for word.
// That keeps the answer short (it cannot be cut off), and a price or a name can never be changed on the way.

import { formatPrice } from '../../lib/price.js';

// A section that lists the owner's items (a menu, a catalog). The creative director may give a section any name now, so this is read from
// the type's words: a list word ("menu", "dish", "product", "catalog", "price", "list", "board", "ledger", "ticket", "collection") and
// none of the words of a section that only shows a few things or is about something else ("preview", "featured", "hero", "story"...).
const LIST_WORDS = /menu|dish|product|catalog|price|offer|list|board|ledger|ticket|collection/i;
const NOT_LIST = /preview|featured|feature|teaser|hero|header|footer|cta|story|about|contact|hours|info|testimonial|gallery|intro|nav/i;
export const isListedSection = (section) => { const t = section.type ?? ''; return LIST_WORDS.test(t) && !NOT_LIST.test(t); };

export const listedSections = (designPage) => (designPage?.sections ?? []).filter(isListedSection);

// The text the model gets so it can choose by number.
export const dishIndex = (brief) => brief.offerings.map((o, i) => ({ i, name: o.name, category: o.category ?? '' }));

const tokens = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Fills the listed sections' items from the owner's list. Dishes the model forgot go to the section whose id names their category,
// else to the last listed section: nothing the owner wrote is ever dropped. Returns the dish numbers that had to be placed this way.
export function fillListedSections({ brief, designPage, page }) {
  const listed = listedSections(designPage);
  if (!listed.length) return [];
  const sections = listed.map((s) => page.sections.find((w) => w.id === s.id)).filter(Boolean);
  const chosen = new Map(sections.map((s) => [s.id, []]));
  const taken = new Set();
  // a service that is the heading of its own (non-list) block on this page, such as a featured "Bridal makeup", is not listed a second time
  const key = (t) => String(t).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const listedIds = new Set(listed.map((s) => s.id));
  const featured = new Set(page.sections.filter((s) => !listedIds.has(s.id) && s.heading).map((s) => key(s.heading)));
  for (const s of sections) {
    for (const n of s.dishes ?? []) if (Number.isInteger(n) && brief.offerings[n] && !taken.has(n) && !featured.has(key(brief.offerings[n].name))) { taken.add(n); chosen.get(s.id).push(n); }
  }
  const leftovers = [];
  brief.offerings.forEach((o, n) => {
    if (taken.has(n)) return;
    if (featured.has(key(o.name))) return; // it has its own block on this page
    const cat = tokens(o.category ?? '');
    const home = cat.length ? sections.find((s) => cat.every((t) => tokens(s.id).includes(t))) : null;
    (chosen.get((home ?? sections[sections.length - 1]).id)).push(n); leftovers.push(n);
  });
  for (const s of sections) {
    s.items = chosen.get(s.id).sort((a, b) => a - b).map((n) => {
      const o = brief.offerings[n];
      return { title: o.name, text: [o.description, formatPrice(o.price, brief.currency)].filter(Boolean).join(' — ') };
    });
    delete s.dishes;
  }
  return leftovers;
}

// A hint for the retry only (never a failure): the model should place most dishes. Code adds any it forgot.
export function dishProblems({ brief, designPage, page }) {
  const listed = listedSections(designPage);
  if (!listed.length || !brief.offerings.length) return [];
  const placed = new Set(page.sections.flatMap((s) => (listed.some((l) => l.id === s.id) ? s.dishes ?? [] : [])).filter((n) => brief.offerings[n]));
  return placed.size < brief.offerings.length * 0.5 ? [`"dishes" must list the number of (nearly) every dish of the owner's list across the listed sections: you placed ${placed.size} of ${brief.offerings.length}`] : [];
}
