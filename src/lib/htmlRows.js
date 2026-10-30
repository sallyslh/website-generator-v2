import { numericPrice } from './price.js';

// Menus and product lists on a drawn page. No AI.
//
// Stitch draws a list as plain text rows (and, for a long list, only a sample of them). The owner's list is complete and exact, and
// every item has a standard shape on the finished site, for every menu and every product list:
//   [ its own photo ]  name + description  [ price with its currency sign, in a pill ]
// The rows Stitch drew are only used to find the list and to take the design's own colors and fonts from; every row of the final
// site is made here from the owner's list, so it is always complete, in order, and the same shape.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');
const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();

// Script, style and comment contents are hidden (same length, so positions stay valid) before the page is read.
const mask = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, ' '));

// A tree of elements and text nodes with their positions in the html string.
export function parseTree(html) {
  const text = mask(html);
  const root = { tag: '#root', start: 0, end: html.length, children: [], parent: null, attrs: '' };
  let node = root;
  const re = /<\/?([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>|[^<]+|</g;
  for (let m; (m = re.exec(text)); ) {
    if (m[1] === undefined) { // text
      if (m[0].trim()) node.children.push({ text: html.slice(m.index, m.index + m[0].length), start: m.index, end: m.index + m[0].length, parent: node });
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') { // closing tag: close up to the matching open element
      let up = node;
      while (up && up.tag !== tag) up = up.parent;
      if (up && up.parent) { up.end = m.index + m[0].length; node = up.parent; }
      continue;
    }
    const el = { tag, start: m.index, end: m.index + m[0].length, openEnd: m.index + m[0].length, children: [], parent: node, attrs: m[2] };
    node.children.push(el);
    if (!VOID.has(tag) && !m[3]) node = el;
  }
  return root;
}

const walk = (node, visit) => { visit(node); for (const c of node.children ?? []) walk(c, visit); };
const textNodes = (node) => { const out = []; walk(node, (n) => { if (n.text !== undefined) out.push(n); }); return out; };
const attr = (el, name) => el.attrs?.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
const ancestors = (n) => { const out = []; for (let p = n.parent; p; p = p.parent) out.push(p); return out; };

// ---- the design's own classes, without the ones that decide layout (the standard row decides that) ----
const LAYOUT = /^(flex|inline-flex|grid|block|inline-block|hidden|items-\S+|justify-\S+|gap(-[xy])?-\S+|space-[xy]-\S+|col-\S+|grid-\S+|text-(left|right|center|start|end)|w-\S+|h-\S+|flex-\S+|order-\S+|self-\S+|float-\S+|truncate|line-clamp-\S+|mb-\S+|mt-\S+|italic)$/;
const bare = (token) => token.replace(/^(?:[\w-]+:)+/, '');
const cleanClasses = (cls) => (cls ?? '').split(/\s+/).filter((t) => t && !LAYOUT.test(bare(t))).join(' ');
const HEADING_TYPE = /^(text|font)-(headline|display|title|label)\S*$|^font-(thin|light|normal|medium|semibold|bold|extrabold)$/;
const withoutType = (cls) => cls.split(/\s+/).filter((t) => t && !HEADING_TYPE.test(bare(t))).join(' ');

// What each text of a drawn row is, and the classes of the element holding it.
function rolesOf(row, sample) {
  const price = sample.priceRaw ? squash(sample.priceRaw) : '';
  const desc = sample.description ? squash(sample.description) : '';
  return textNodes(row).map((n) => {
    const t = squash(n.text);
    const cls = attr(n.parent, 'class') ?? '';
    if (t === squash(sample.name)) return { role: 'title', cls };
    if (price && t.includes(price)) return { role: t.replace(price, '').replace(/[\s\-—–·|:$€£]/g, '') === '' ? 'price' : 'both', cls };
    if (desc && (t === desc || desc.startsWith(t) || t.startsWith(desc.slice(0, 25)))) return { role: 'desc', cls };
    return { role: 'fixed', cls };
  });
}

// The rows of a drawn list found by their shape (no names needed): the element with the most children that look alike
// (same tag, same classes) and hold text. Used when the drawn rows are not the owner's current items.
const PRICE_TEXT = /^(?:(?:[$€£]|usd|eur|lbp)\s?)?\d[\d.,']*\s?(?:[$€£]|usd|eur|lbp|k)?$/i;
function findRepeatedRows(scope) {
  let best = null;
  walk(scope, (el) => {
    if (!el.tag || !el.children?.length) return;
    const groups = new Map();
    for (const c of el.children) {
      if (!c.tag || !textNodes(c).length) continue;
      const key = `${c.tag}|${attr(c, 'class') ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const rows of groups.values()) if (rows.length >= 2 && (!best || rows.length > best.rows.length)) best = { list: el, rows };
  });
  return best;
}
// Without the owner's names to go by: the first text of a row is its title, a price-like text its price, anything else its description.
function genericRoles(row) {
  let priceSeen = false;
  return textNodes(row).filter((n) => squash(n.text)).map((n, i) => {
    const t = squash(n.text); const cls = attr(n.parent, 'class') ?? '';
    if (i === 0) return { role: 'title', cls };
    if (!priceSeen && PRICE_TEXT.test(t)) { priceSeen = true; return { role: 'price', cls }; }
    return { role: 'desc', cls };
  });
}

// One standard row.
function dishRow(d, k) {
  const photo = d.photo ? `<img src="${escapeAttr(d.photo)}" alt="${escapeAttr(d.name)}" loading="lazy" data-thumb class="h-20 w-20 shrink-0 rounded-lg object-cover sm:h-24 sm:w-24"/>` : '';
  const text = `<div class="min-w-0 flex-1"><span class="${k.title} block" dir="auto">${escapeText(d.name)}</span>${d.description ? `<p class="${k.desc} mt-1" dir="auto">${escapeText(d.description)}</p>` : ''}</div>`;
  const price = d.price ? `<span class="${k.price} shrink-0 whitespace-nowrap rounded-full border border-current px-3 py-1 text-base font-bold" dir="ltr">${escapeText(d.price)}</span>` : '';
  const n = numericPrice(d.priceRaw); // the row says what it is and what it costs, so the site can offer to order it (stage 8)
  const item = ` data-item="${escapeAttr(d.name)}"${n ? ` data-price="${n}"` : ""}`;
  return `<div class="${k.row} flex items-center gap-4"${item}>${photo}${text}${price}</div>`;
}

// html: the page (or its body). dishes: the owner's items of ONE list section, in order:
//   [{ name, description, price (as it is shown, with its sign), priceRaw (as the owner wrote it), photo (a file name the site builder knows, or '') }].
// sectionId: the id of the drawn section (Stitch keeps our section ids), or null to search the whole page.
// Returns { html, added, shown, reason }; `reason` says why the list was left as drawn.
export function renderDishList(html, { dishes, sectionId = null }) {
  const tree = parseTree(html);
  let scope = tree;
  if (sectionId) {
    let found = null;
    walk(tree, (n) => { if (!found && n.tag && attr(n, 'id') === sectionId) found = n; });
    if (found) scope = found;
  }
  const texts = textNodes(scope);
  const shown = [];
  for (const d of dishes) {
    const hit = texts.find((t) => squash(t.text) === squash(d.name));
    if (hit) shown.push({ dish: d, node: hit });
  }
  // the list container: the closest element above the first two drawn dishes; each drawn row is its child holding one dish
  let rows = []; let rolesFor = null;
  if (shown.length >= 2) {
    const list = ancestors(shown[0].node).find((a) => ancestors(shown[1].node).includes(a));
    const rowOf = (s) => { let n = s.node; while (n.parent && n.parent !== list) n = n.parent; return n; };
    const byName = shown.map(rowOf);
    if (list && byName.every((r) => r.parent === list) && new Set(byName).size === byName.length) {
      rows = [...byName]; rolesFor = (row) => { const i = byName.indexOf(row); return i >= 0 ? rolesOf(row, { ...shown[i].dish }) : genericRoles(row); };
      // A drawn row whose name is written a little differently ("With" for "with", an accent) is not found by name, but it is the same
      // kind of row beside the others: it goes too, or the dish would show twice (once drawn, once standard).
      const shapes = new Set(byName.map((r) => `${r.tag}|${attr(r, 'class') ?? ''}`));
      for (const c of list.children) if (c.tag && !rows.includes(c) && shapes.has(`${c.tag}|${attr(c, 'class') ?? ''}`) && textNodes(c).length) rows.push(c);
      rows.sort((a, b) => a.start - b.start);
    }
  }
  if (!rows.length) { // the drawn rows are not (all) the owner's current items: find the list by the shape of its rows
    const g = findRepeatedRows(scope);
    if (g) { rows = g.rows; rolesFor = (row) => genericRoles(row); }
  }
  if (!rows.length) return { html, added: 0, shown: shown.length, reason: shown.length < 2 ? `only ${shown.length} drawn row(s) found` : 'the drawn rows do not share one list' };

  // the design's colors and fonts, taken from the drawn rows
  const found = { title: '', desc: '', price: '' };
  rows.forEach((row, i) => { for (const r of rolesFor(row, i)) {
    const key = r.role === 'both' ? 'desc' : r.role;
    if (key in found && !found[key]) found[key] = cleanClasses(r.cls);
  } });
  const title = found.title || 'font-semibold';
  const k = {
    row: cleanClasses(attr(rows[0], 'class')),
    title,
    desc: found.desc || `${withoutType(title)} text-sm opacity-75`,
    price: found.price || `${withoutType(title)}`,
  };

  // every drawn row goes; the standard rows for the whole list take the place of the first one
  const rowsHtml = dishes.map((d) => dishRow(d, k)).join('\n');
  let out = html;
  [...rows].sort((a, b) => b.start - a.start).forEach((r, i, all) => {
    const first = i === all.length - 1;
    out = out.slice(0, r.start) + (first ? rowsHtml : '') + out.slice(r.end);
  });
  return { html: out, added: dishes.length - shown.length, shown: shown.length, reason: '' };
}

// A list section's own picture (the photo beside the list): Stitch sometimes draws it without the slot name in `alt` (a long
// description in `data-alt` instead), so the site builder cannot tell which planned photo belongs there. Such a picture gets the
// section's slot id as its alt text. The dish photos (they have an alt) are never touched.
export function tagSectionImages(html, { sectionId, slotIds }) {
  if (!slotIds.length) return html;
  let found = null;
  walk(parseTree(html), (n) => { if (!found && n.tag && attr(n, 'id') === sectionId) found = n; });
  if (!found) return html;
  const queue = [...slotIds];
  const section = html.slice(found.start, found.end).replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\salt="[^"]+"/i.test(tag) || !queue.length) return tag;
    const slot = queue.shift();
    return /\salt=""/i.test(tag) ? tag.replace(/\salt=""/i, ` alt="${slot}"`) : tag.replace(/<img\b/i, `<img alt="${slot}"`);
  });
  return html.slice(0, found.start) + section + html.slice(found.end);
}
