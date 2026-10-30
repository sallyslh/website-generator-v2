// The product list a shop owner typed (or we read from their price list) and the photos they named after each product.
// The model never touches these: code puts them into the brief word for word, and code links each photo to its product.
//   answers.items       [{ name, price, description, category }]   the owner's list, in the owner's order
//   answers.itemPhotos  [{ file, item }]                          the saved photo name and the product index it belongs to (-1: not a product)
//   brief.offerings     one entry per item (price kept exactly as typed; empty = no price shown)
//   offering.assetId    the photo of that product (Stage 2 knows the ids), the same field the director's image inventory already reads

import fs from 'node:fs';
import { exists, projectPath, readJson, writeJson } from './project.js';
import { siteBriefSchema } from '../schemas/siteBrief.js';
import { assetManifestSchema } from '../schemas/assetManifest.js';

export const MAX_ITEMS = 200;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The list as the form sends it, made safe. Rows without a name are dropped.
export function cleanItems(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS)
    .map((i) => ({ name: clean(i?.name, 120), price: clean(i?.price, 30), description: clean(i?.description ?? i?.desc, 300), category: clean(i?.category, 60) }))
    .filter((i) => i.name);
}

// The photo links: only real indexes, only safe file names.
export function cleanItemPhotos(raw, itemCount) {
  return (Array.isArray(raw) ? raw : []).slice(0, 160)
    .map((p) => ({ file: clean(p?.file, 140), item: Number.isInteger(p?.item) && p.item >= -1 && p.item < itemCount ? p.item : -1 }))
    .filter((p) => p.file && !p.file.includes('/') && !p.file.includes('\\'));
}

// One line per product, for the answers file that people (and the interview) read.
export const itemLines = (items) => items.map((i) => `${i.name}${i.price ? ` - ${i.price}` : ''}${i.description ? `: ${i.description}` : ''}`).join('\n');

// Stage 1: the brief's offerings ARE the owner's list.
export function applyItems(brief, structured) {
  if (structured?.siteType) brief.siteType = structured.siteType; // the kind of website the owner chose (also when there is no list: a website that only presents the business)
  if (!structured?.items?.length) return brief;
  brief.offerings = structured.items.map((i) => ({ name: i.name, description: i.description, ...(i.price ? { price: i.price } : {}), ...(i.category ? { category: i.category } : {}) }));
  return brief;
}

// Stage 2: link each product to its photo (the first photo of that product is its main one).
export function applyItemPhotos(projectId) {
  if (!exists(projectId, 'inputs/answers.json') || !exists(projectId, 'site-brief.json') || !exists(projectId, 'asset-manifest.json')) return 0;
  const answers = JSON.parse(fs.readFileSync(projectPath(projectId, 'inputs/answers.json'), 'utf8'));
  if (!answers.itemPhotos?.length) return 0;
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  let linked = 0;
  for (const link of answers.itemPhotos) {
    const offering = brief.offerings[link.item];
    const asset = manifest.assets.find((a) => a.file.split('/').pop() === link.file);
    if (!offering || !asset || offering.assetId) continue;
    offering.assetId = asset.id; linked++;
  }
  if (linked) writeJson(projectId, 'site-brief.json', brief, siteBriefSchema);
  return linked;
}

// ---------- reading a price list into the product table ----------
// The customer uploaded pictures (or a PDF) of their menu or price list; the table is filled for them to CHECK. Nothing is added to a
// website from this: the customer sees every row, fixes it, and only then does it become their list.

import { z } from 'zod';
import { askVision } from './llm.js';

const readSchema = z.object({ items: z.array(z.object({ name: z.string(), price: z.string().default(''), description: z.string().default(''), category: z.string().default('') })).default([]) });
const READ_SYSTEM = `You copy the product or menu list out of a picture or PDF of a price list or menu, exactly as written.
Return JSON: { "items": [ { "name": "", "price": "", "description": "", "category": "" } ] }
- One entry per product, dish or service, in the order of the document.
- "name" and "description" are copied word for word. "price" is copied exactly as written, with its currency sign or code (for example "$45" or "45 USD"), and is "" when the document shows no price for that item. Never calculate, convert or guess a price.
- "category" is the heading the item sits under in the document (for example "Women", "Starters"), or "".
- Skip anything that is not a product (opening hours, phone numbers, slogans). Never invent an item. At most 150 items.`;

export async function readPriceList({ projectId, files, deps = {} }) {
  const out = await (deps.askVision ?? askVision)({ projectId, stage: 'form-list', system: READ_SYSTEM, prompt: 'Copy the list from these pages. They are the pages of one price list or menu, in order.', images: files.map((f) => ({ path: f })), schema: readSchema, maxTokens: 6000 });
  return cleanItems(out.items);
}
