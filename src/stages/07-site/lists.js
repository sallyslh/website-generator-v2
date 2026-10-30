// Menus and product lists on a drawn page: every list section gets the standard row for each item of the owner's list
// (its own photo, name, description, and the price with its currency sign). See lib/htmlRows.js.

import path from 'node:path';
import { renderDishList, tagSectionImages } from '../../lib/htmlRows.js';
import { formatPrice } from '../../lib/price.js';
import { listedSections } from '../04-content/dishLists.js';

// letters and digits only: "Kale & Quinoa", "Kale Quinoa" and "kale-quinoa" are the same dish
const norm = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// body: the page's html. manifest: the asset manifest (an item's photo is the one the owner named after it).
// Returns the html with every list section made, and one report line per list section.
export function expandLists({ body, slug, brief, design, content, manifest = { assets: [] } }) {
  const designPage = design.pages.find((p) => p.slug === slug);
  const contentPage = content.pages.find((p) => p.slug === slug);
  const byName = new Map(brief.offerings.map((o) => [norm(o.name), o]));
  const fileOf = new Map(manifest.assets.map((a) => [a.id, path.basename(a.file)]));
  let html = body; const report = [];
  for (const section of listedSections(designPage)) {
    const written = contentPage?.sections.find((s) => s.id === section.id);
    if (!written?.items.length) continue;
    const dishes = written.items.map((i) => {
      const o = byName.get(norm(i.title));
      return { name: o?.name ?? i.title, description: o?.description ?? '', priceRaw: o?.price ?? '', price: formatPrice(o?.price, brief.currency), photo: (o?.assetId && fileOf.get(o.assetId)) || '' };
    });
    const r = renderDishList(html, { dishes, sectionId: section.id });
    html = tagSectionImages(r.html, { sectionId: section.id, slotIds: (section.slots ?? []).map((s) => s.id) });
    report.push({ slug, section: section.id, total: dishes.length, shown: r.shown, added: r.added, withPhoto: dishes.filter((d) => d.photo).length, reason: r.reason });
  }
  // any section's own picture that Stitch drew without the slot name (a long description in data-alt instead) is matched to its planned photo
  for (const section of designPage?.sections ?? []) html = tagSectionImages(html, { sectionId: section.id, slotIds: (section.slots ?? []).map((x) => x.id) });
  return { html, report };
}

// A price written as a bare number in the page ("39.0" beside a dish card) is shown with the owner's currency sign, like the menu rows.
// Only a text of its own that equals an offering's price (one that has a decimal part), never a number inside a sentence.
export function formatLoosePrices(html, { offerings = [], currency = '' } = {}) {
  if (!currency) return { html, changed: 0 };
  const raws = [...new Set(offerings.map((o) => String(o.price ?? '').trim()).filter((p) => /^\d+[.,]\d+$/.test(p)))];
  let changed = 0; let out = html;
  for (const raw of raws) {
    const shown = formatPrice(raw, currency);
    const re = new RegExp(`>(\\s*(?:[◆·•—–-]\\s*)?)${raw.replace(/[.,]/g, (c) => `\\${c}`)}(\\s*)<`, 'g');
    out = out.replace(re, (m, before, after) => { changed++; return `>${before}${shown}${after}<`; });
  }
  return { html: out, changed };
}
