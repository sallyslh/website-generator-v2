// Step 4 of the journey: the approved visual site becomes a structured one, so the owner can edit it as content.
//   structurePage({ html, ask })   finds the lists of cards (coaches, prices, products, events...), moves their content into data, and keeps the page
//                                  as a "base" with a marker where each list goes. The page can be rebuilt from base + data, and the rebuilt page must be
//                                  exactly the page we started from (verified: a page that does not match is not converted).
//   renderPage(base, data)         base + data -> the page
//   structureSite({ dir, projectId })   every page of a site; writes projects/<id>/wow-structure/<page>.base.html and <page>.json
//
// A list item is one card: a "skeleton" (its tags and classes, with a marker where each text, picture address and link goes) and its slots (the values).
// The owner changes slot values, deletes, duplicates, reorders or adds items; the design and the phone layout are in the skeleton and do not change.
// Code finds the candidates; one small model call per page only says which candidates are real lists the owner would edit, and names them.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { projectPath, writeJson } from '../lib/project.js';

const require = createRequire(import.meta.url);
const cheerio = require('cheerio');

const STAGE = 'wow-structure';
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'template']);
const SKIP_AREAS = new Set(['header', 'footer', 'nav']);
const ATTRS = ['src', 'srcset', 'alt', 'href'];
const PRICE = /^[$€£]\s?\d|^\d[\d.,]*\s?(usd|eur|lbp|\$|€|£)\b|\d\s*\/\s*(month|mo|session|hour|hr|week|year|person)/i;
const MARK = /@@S(\d+)@@/g;

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;');

const elementKids = (el) => (el.children ?? []).filter((c) => c.type === 'tag');
const textOf = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();

// structure of a card without its words, pictures and links (the classes are not part of it: one card may have one more class than the others)
const looseSig = (el) => (el.type !== 'tag' ? '' : `${el.name}(${elementKids(el).map(looseSig).join(',')})`);

function slotCount($, el) {
  let n = 0;
  const walk = (node) => {
    if (node.type === 'text') { if (node.data.trim()) n++; return; }
    if (node.type !== 'tag' || SKIP_TAGS.has(node.name)) return;
    if (node.name === 'img') n++;
    if (node.name === 'a' && node.attribs?.href) n++;
    (node.children ?? []).forEach(walk);
  };
  walk(el);
  return n;
}

// ---------- 1. candidates (code) ----------

// Containers whose children are cards: three or more, each with real content, and most of them built the same way. A card that differs a little (the
// "featured" one) is still an item: every item keeps its own skeleton. Returns [{ id, el, kids, sample, before }], outermost only, in page order.
export function findCandidates($) {
  const found = [];
  let id = 0;
  let heading = '';
  const visit = (el) => {
    if (!el || el.type !== 'tag' || SKIP_TAGS.has(el.name) || SKIP_AREAS.has(el.name)) return;
    if (/^h[1-4]$/.test(el.name)) heading = textOf($, el).slice(0, 80);
    const kids = elementKids(el);
    if (kids.length >= 3 && kids.length <= 40 && kids.every((k) => slotCount($, k) >= 3)) {
      const sigs = kids.map(looseSig);
      const counts = sigs.reduce((m, s) => m.set(s, (m.get(s) || 0) + 1), new Map());
      const n = Math.max(...counts.values());
      if (n >= 2 && n >= kids.length * 0.6) {
        found.push({ id: ++id, el, kids, sample: textOf($, kids[0]).slice(0, 110), before: heading });
        return; // the outermost list only: what is inside a card belongs to the card
      }
    }
    for (const k of el.children ?? []) visit(k);
  };
  visit($('body')[0]);
  return found;
}

// ---------- 2. which candidates are real lists (one small model call per page) ----------

const labelSchema = z.object({ lists: z.array(z.object({ id: z.number().int(), keep: z.boolean(), name: z.string() })) });

export const LABEL_SYSTEM = `You help a business owner edit their website. You receive groups of repeated cards found on one page (a number, how many cards, the text of the first card, and the heading before it). Say which groups are lists of items an owner would add to, remove from or edit: for example menu items, services, products, prices and plans, team members and coaches, events, reviews, gallery photos, time slots, FAQs, courses. Say keep=false for groups that are not that: decorative or fixed layout pieces, groups of small icons or badges, steps of how the page works, navigation or footer links, statistics. Give each kept group a short plural name an owner would understand ("Coaches", "Membership plans"). Answer JSON only: {"lists":[{"id":1,"keep":true,"name":"Coaches"}]}`;

async function chooseLists(candidates, { ask, projectId, label }) {
  if (!candidates.length) return new Map();
  const payload = candidates.map((c) => ({ id: c.id, cards: c.kids.length, firstCard: c.sample, headingBefore: c.before }));
  let answer;
  try { answer = await ask({ projectId, stage: STAGE, system: LABEL_SYSTEM, schema: labelSchema, maxTokens: 2000, prompt: `Page: ${label}\n${JSON.stringify(payload)}` }); } catch { return new Map(); }
  const chosen = new Map();
  for (const l of answer.lists ?? []) if (l.keep && candidates.some((c) => c.id === l.id) && l.name.trim()) chosen.set(l.id, l.name.trim().slice(0, 60));
  return chosen;
}

// ---------- 3. one list -> skeletons + slots ----------

function cardToItem($, card) {
  const slots = [];
  const walk = (node, parentTag, parentClass) => {
    if (node.type === 'text') {
      if (!node.data.trim()) return;
      const role = /material-symbols|material-icons/.test(parentClass) ? 'icon' : /^h[1-6]$/.test(parentTag) ? 'name' : PRICE.test(node.data.trim()) ? 'price' : node.data.trim().length > 60 ? 'description' : 'label';
      slots.push({ k: 't', v: node.data, role });
      node.data = `@@S${slots.length - 1}@@`;
      return;
    }
    if (node.type !== 'tag' || SKIP_TAGS.has(node.name)) return;
    for (const a of ATTRS) {
      const v = node.attribs?.[a];
      if (v === undefined || v === '' || (a === 'alt' && node.name !== 'img') || (a === 'href' && node.name !== 'a') || ((a === 'src' || a === 'srcset') && node.name !== 'img')) continue;
      slots.push({ k: a, v, role: a === 'src' || a === 'srcset' ? 'photo' : a === 'alt' ? 'photo text' : 'link' });
      node.attribs[a] = `@@S${slots.length - 1}@@`;
    }
    (node.children ?? []).forEach((c) => walk(c, node.name, node.attribs?.class ?? ''));
  };
  walk(card, '', '');
  return { skeleton: $.html(card), slots };
}

export const renderItem = (item) => item.skeleton.replace(MARK, (_, n) => {
  const s = item.slots[Number(n)];
  return s.k === 't' ? escText(s.v) : escAttr(s.v);
});

export const renderList = (list) => list.items.map((it, i) => renderItem(it) + (i < list.items.length - 1 ? (list.seps[i] ?? list.seps[0] ?? '') : '')).join('');

// base + data -> the page. The words and pictures outside lists come back first (markers @@P<n>@@), then each list is put where its marker is.
export function renderPage(base, data) {
  const slots = data.page?.slots ?? [];
  const byId = new Map((data.lists ?? []).map((l) => [String(l.id), l]));
  return base
    .replace(/@@P(\d+)@@/g, (whole, n) => { const s = slots[Number(n)]; return s ? (s.k === 't' ? escText(s.v) : escAttr(s.v)) : whole; })
    .replace(/<!--list:(\d+)-->/g, (whole, id) => (byId.has(id) ? renderList(byId.get(id)) : whole));
}

// ---------- 3b. the words and pictures outside the lists ----------

// Every text, picture address, picture description and link of the page body that is not in a list becomes a slot in data.page.slots; the base keeps a
// marker in its place. The role says what it is (heading, paragraph, button, link, picture...) so an editor can show it in plain words.
function pageToSlots($) {
  const slots = [];
  const walk = (node, parentTag, parentClass) => {
    if (node.type === 'text') {
      if (!node.data.trim()) return;
      const role = /material-symbols|material-icons/.test(parentClass) ? 'icon' : /^h[1-6]$/.test(parentTag) ? 'heading' : parentTag === 'button' ? 'button' : parentTag === 'a' ? 'link text' : node.data.trim().length > 60 ? 'paragraph' : 'text';
      slots.push({ k: 't', v: node.data, role });
      node.data = `@@P${slots.length - 1}@@`;
      return;
    }
    if (node.type !== 'tag' || SKIP_TAGS.has(node.name)) return;
    for (const a of ATTRS) {
      const v = node.attribs?.[a];
      if (v === undefined || v === '' || (a === 'alt' && node.name !== 'img') || (a === 'href' && node.name !== 'a') || ((a === 'src' || a === 'srcset') && node.name !== 'img')) continue;
      slots.push({ k: a, v, role: a === 'src' || a === 'srcset' ? 'photo' : a === 'alt' ? 'photo text' : 'link' });
      node.attribs[a] = `@@P${slots.length - 1}@@`;
    }
    (node.children ?? []).forEach((c) => walk(c, node.name, node.attribs?.class ?? ''));
  };
  const body = $('body')[0];
  if (body) (body.children ?? []).forEach((c) => walk(c, 'body', ''));
  return slots;
}

// The page slots the owner can see and change (icons and the second copy of a picture address, srcset, follow the photo and are not shown).
export const pageSlotsByRole = (data) => (data.page?.slots ?? []).map((s, i) => ({ i, k: s.k, role: s.role, value: s.v.trim() })).filter((s) => (s.k === 't' && s.role !== 'icon') || s.k === 'src' || s.k === 'href' || s.k === 'alt');
export function setPageText(data, slotIndex, text) { setText({ slots: data.page.slots }, slotIndex, text); }
// A new picture for a slot: the small copies listed in srcset no longer fit it, so srcset points at the new picture too.
export function setPhoto(slots, srcIndex, address) {
  slots[srcIndex].v = address;
  const next = slots[srcIndex + 1]; // the picture's own srcset comes right after its src in reading order of the attributes
  if (next && next.k === 'srcset') next.v = address;
}
export const setPagePhoto = (data, srcIndex, address) => setPhoto(data.page.slots, srcIndex, address);

// ---------- 3c. the page as the editor shows it ----------

// Same page as renderPage, but every text is wrapped in <span data-slot="..."> and every picture carries data-slot, and every list item carries data-item="list.index",
// so the editing screen knows what the owner clicked. Slot ids: "P.<n>" outside lists, "L<list>.<item>.<n>" inside an item.
function fillEditable(str, tag, slots, key) {
  return str
    .replace(new RegExp(`\\b(src|srcset|alt|href)="@@${tag}(\\d+)@@"`, 'g'), (whole, name, n) => {
      const s = slots[Number(n)]; if (!s) return whole;
      return `${name}="${escAttr(s.v)}"${name === 'src' ? ` data-slot="${key}.${n}"` : ''}`;
    })
    .replace(new RegExp(`@@${tag}(\\d+)@@`, 'g'), (whole, n) => {
      const s = slots[Number(n)]; if (!s) return whole;
      return s.role === 'icon' ? escText(s.v) : `<span data-slot="${key}.${n}" data-role="${s.role}">${escText(s.v)}</span>`;
    });
}
export function renderPageEditable(base, data) {
  const byId = new Map((data.lists ?? []).map((l) => [String(l.id), l]));
  return fillEditable(base, 'P', data.page?.slots ?? [], 'P').replace(/<!--list:(\d+)-->/g, (whole, id) => {
    const list = byId.get(id); if (!list) return whole;
    return list.items.map((it, i) => {
      const html = fillEditable(it.skeleton, 'S', it.slots, `L${id}.${i}`).replace(/^<([a-zA-Z][\w-]*)/, `<$1 data-item="${id}.${i}"`);
      return html + (i < list.items.length - 1 ? (list.seps[i] ?? list.seps[0] ?? '') : '');
    }).join('');
  });
}

// ---------- 4. one page ----------

// Returns { base, data, verified, lists, items, why }. A page whose rebuilt copy is not exactly the original is not converted (verified false).
export async function structurePage({ html, projectId, ask = askJson, label = 'page' }) {
  const original = cheerio.load(html).html();
  const $ = cheerio.load(html);
  const candidates = findCandidates($);
  const chosen = await chooseLists(candidates, { ask, projectId, label });
  const seen = candidates.map((c) => `${chosen.has(c.id) ? 'KEPT    ' : 'rejected'} ${c.kids.length} cards, before "${c.before}": ${c.sample.slice(0, 50)}`);
  const lists = [];
  for (const c of candidates) {
    if (!chosen.has(c.id)) continue;
    const kids = c.kids;
    // the text between the cards (line breaks and indentation) is kept, so the page is rebuilt exactly
    const all = c.el.children;
    const startAt = all.indexOf(kids[0]); const endAt = all.indexOf(kids[kids.length - 1]);
    const seps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const between = all.slice(all.indexOf(kids[i]) + 1, all.indexOf(kids[i + 1]));
      seps.push(between.map((n) => $.html(n)).join('')); // line breaks, indentation and comments between two cards are kept as they are
    }
    if (kids.length > 1 && seps.length !== kids.length - 1) continue;
    const id = lists.length + 1;
    const items = kids.map((k) => cardToItem($, k));
    const toRemove = all.slice(startAt, endAt + 1); // taken before the marker goes in: the list of children is live
    $(kids[0]).before($(`<!--list:${id}-->`)[0]);
    for (const n of toRemove) $(n).remove();
    lists.push({ id, name: chosen.get(c.id), items, seps });
  }
  const pageSlots = pageToSlots($);
  const base = $.html();
  const data = { version: 2, page: { slots: pageSlots }, lists };
  const rebuilt = renderPage(base, data);
  const verified = rebuilt === original;
  return { seen, base, data, verified, lists: lists.length, items: lists.reduce((n, l) => n + l.items.length, 0), why: verified ? '' : 'the rebuilt page is not identical to the original' };
}

export async function structureSite({ dir, projectId, ask = askJson }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const out = projectId ? projectPath(projectId, 'wow-structure') : null;
  if (out) { fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true }); }
  const report = { pages: [], lists: 0, items: 0, notVerified: [] };
  for (const f of files) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = await structurePage({ html, projectId, ask, label: f });
    const slug = f.replace(/\.html$/, '');
    report.pages.push({ seen: r.seen, page: f, lists: r.verified ? r.lists : 0, items: r.verified ? r.items : 0, verified: r.verified, names: r.data.lists.map((l) => `${l.name} (${l.items.length})`) });
    if (!r.verified) { report.notVerified.push(`${f}: ${r.why}`); continue; }
    report.lists += r.lists; report.items += r.items;
    if (out) { fs.writeFileSync(path.join(out, `${slug}.base.html`), r.base); fs.writeFileSync(path.join(out, `${slug}.json`), JSON.stringify(r.data, null, 1)); }
  }
  if (out) writeJson(projectId, 'wow-structure/report.json', report);
  return report;
}

// ---------- 4b. the final site, built from base + data ----------

// Copies the generated site (pictures, styles, scripts) to `out` and writes every converted page from its base and data. A page that was not converted is copied
// as it is. Returns { built: [pages rebuilt from data], copied: [pages copied]}. The data may have been edited by the owner since structureSite.
export function buildSite({ dir, structureDir, out }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(dir, out, { recursive: true });
  const built = []; const copied = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const slug = f.replace(/\.html$/, '');
    const baseFile = path.join(structureDir, `${slug}.base.html`); const dataFile = path.join(structureDir, `${slug}.json`);
    if (!fs.existsSync(baseFile) || !fs.existsSync(dataFile)) { copied.push(f); continue; }
    fs.writeFileSync(path.join(out, f), renderPage(fs.readFileSync(baseFile, 'utf8'), JSON.parse(fs.readFileSync(dataFile, 'utf8'))));
    built.push(f);
  }
  return { built, copied };
}

// ---------- 5. what the owner can do with a list (the editor will call these) ----------

const cloneItem = (item) => ({ skeleton: item.skeleton, slots: item.slots.map((s) => ({ ...s })) });
const sepAt = (list, i) => list.seps[Math.min(i, list.seps.length - 1)] ?? '\n';

// A new item looks like an existing one with its words emptied (icons and the picture frame stay, so the design stays). Returns the new item.
export function blankItem(list, like = list.items.length - 1) {
  const item = cloneItem(list.items[Math.max(0, Math.min(like, list.items.length - 1))]);
  for (const s of item.slots) if (s.k === 't' && s.role !== 'icon') s.v = s.v.replace(/\S[\s\S]*\S|\S/, '');
  return item;
}
export function addItem(list, item = blankItem(list)) { list.seps.push(sepAt(list, list.seps.length)); list.items.push(item); return item; }
export function duplicateItem(list, index) { list.items.splice(index + 1, 0, cloneItem(list.items[index])); list.seps.splice(index, 0, sepAt(list, index)); }
export function removeItem(list, index) { if (list.items.length <= 1) return false; list.items.splice(index, 1); list.seps.splice(Math.min(index, list.seps.length - 1), 1); return true; }
export function moveItem(list, from, to) { const [it] = list.items.splice(from, 1); list.items.splice(to, 0, it); }
// Changes the words of a text slot but keeps the spaces and line breaks around them, so the page keeps its look.
export function setText(item, slotIndex, text) {
  const s = item.slots[slotIndex];
  const lead = s.v.match(/^\s*/)[0]; const trail = s.v.match(/\s*$/)[0];
  s.v = `${lead}${String(text).trim()}${trail}`;
}
export const slotsByRole = (item) => item.slots.map((s, i) => ({ i, k: s.k, role: s.role, value: s.v.trim() })).filter((s) => s.k === 't' || s.k === 'src' || s.k === 'href');
