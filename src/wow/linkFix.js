// Makes every button of a drafted site go where a visitor expects, and nowhere by accident.
// Stitch draws links of its own: many go nowhere ("#"), some point to pages that were never drawn, and several different buttons
// ("Women", "Men", "Scent Guide") often open the same spot of the home page. For every such link:
//   1. a label that is the name of a page, of the business or "Home" goes to that page (no AI needed)
//   2. what is left is decided by ONE small model call for the whole site: a page of the site, "keep" (it scrolls to a spot of the same
//      page, which is right), or "none" (no page fits: Privacy Policy, a social network...)
//   3. "none" becomes an inert button: it does not jump to the top, it shows a friendly "sample" note (see polish.js)
// The decisions are saved in wow-links.json, so a rebuild does not ask again. A failure of the model never fails the site: the links
// that were decided by name still work, the others become inert.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { projectPath } from '../lib/project.js';
import { linksOf, classify, sameIdea } from './linkAudit.js';

const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
export const NEEDS_FIX = new Set(['dead', 'missing', 'missing-anchor', 'anchor']);
const mapSchema = z.object({ links: z.array(z.object({ id: z.number(), to: z.string() })) });

// legal words never lead to a page of the site (there is none): they always show the friendly note
export const LEGAL = /\b(privacy|terms|cookies?|legal|disclaimer|accessibility statement)\b/i;
const hrefFor = (slug, entry) => (slug === entry ? 'index.html' : `${slug}.html`);

// the label of a link as the audit reads it (icons and text), and the group it belongs to ("anchor" links and "dead" links are decided separately)
export const keyOf = (label, kind) => `${norm(label)}|${kind === 'anchor' || kind === 'missing-anchor' ? 'spot' : 'none'}`;

export function pagesByName(pages, businessName, entry) {
  const names = new Map();
  for (const p of pages) for (const n of [p.title, p.navLabel, p.slug]) if (n && norm(n)) names.set(norm(n), p.slug);
  names.set('home', entry);
  if (businessName) names.set(norm(businessName), entry);
  return names;
}

// every link that needs a decision, once per label: [{ id, label, kind, onPages, spot }]
export function collectQuestions(dir, files, names) {
  const seen = new Map();
  for (const file of files) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const l of linksOf(html)) {
      const c = classify(l, file, files);
      if (!NEEDS_FIX.has(c.kind) || l.label.startsWith('(no text')) continue;
      if (names.has(norm(l.label)) || LEGAL.test(l.label)) continue; // decided by name, or a legal link
      const key = keyOf(l.label, c.kind);
      const q = seen.get(key) ?? { label: l.label, kind: c.kind === 'anchor' || c.kind === 'missing-anchor' ? 'a spot of the same page' : 'goes nowhere', onPages: new Set(), spot: c.kind === 'anchor' ? c.dest.split('#')[1] : '' };
      q.onPages.add(file); seen.set(key, q);
    }
  }
  return [...seen.entries()].map(([key, q], i) => ({ id: i + 1, key, label: q.label, kind: q.kind, onPages: [...q.onPages].slice(0, 4), spot: q.spot }));
}

export async function askLinkTargets({ pages, questions, ask = askJson, projectId = 'wow-links' }) {
  if (!questions.length) return {};
  const out = await ask({
    projectId, stage: 'wow-links', schema: mapSchema, maxTokens: 6000,
    system: 'You are the editor of a small business website. You decide where every button should lead, like a careful person clicking through the site.',
    prompt: `The site has these pages:
${JSON.stringify(pages.map((p) => ({ slug: p.slug, title: p.title, about: p.purpose ?? '' })))}

These buttons and links have a wrong or missing destination. For each one decide where a visitor expects it to go:
- a page slug from the list above; or
- "keep" when it is a link that scrolls to a spot of the SAME page (only for links marked "a spot of the same page"); or
- "none" when no page fits (Privacy Policy, Terms, a social network such as Instagram, a phone number, an email address, a map).
Rules: a link that means "see all X" or "browse X" goes to the page about X; a button about booking or reserving goes to the booking page when there is one; do not send two links with clearly different meanings to the same page; when unsure between a page and "none", choose "none".
${JSON.stringify(questions.map((q) => ({ id: q.id, label: q.label, kind: q.kind, foundOn: q.onPages })))}
Answer as JSON: {"links":[{"id":1,"to":"slug | keep | none"}]}`,
  });
  const slugs = new Set(pages.map((p) => p.slug));
  const answers = {};
  for (const l of out.links ?? []) {
    const q = questions.find((x) => x.id === l.id); if (!q) continue;
    const to = String(l.to).trim();
    answers[q.key] = slugs.has(to) ? to : to === 'keep' && q.kind.startsWith('a spot') ? 'keep' : 'none';
  }
  return answers;
}

// rewrites the links of one page
export function applyDecisions(html, { file, files, names, answers, entry }) {
  let changed = 0; let inert = 0;
  const out = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const href = decode(attrs.match(/\bhref="([^"]*)"/i)?.[1] ?? '');
    const probe = linksOf(whole)[0]; if (!probe) return whole;
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/gi)].map((m) => m[1]));
    const c = classify({ href, label: probe.label, ids }, file, files);
    if (!NEEDS_FIX.has(c.kind)) return whole;
    const byName = names.has(norm(probe.label)); // the logo, Home and the menu words: decided by their name
    let target = LEGAL.test(probe.label) ? 'none' : names.get(norm(probe.label)) ?? answers[keyOf(probe.label, c.kind)];
    if (!target) return whole; // not asked about (no text) : left as it is
    if (target === 'keep') return whole;
    const rest = attrs.replace(/\shref="[^"]*"/i, '').replace(/\sdata-inert(="[^"]*")?/i, '');
    if (target === 'none') { inert++; return `<a${rest} href="#" data-inert>${inner}</a>`; }
    const dest = hrefFor(target, entry);
    if (!files.includes(dest)) { inert++; return `<a${rest} href="#" data-inert>${inner}</a>`; } // that page was never drawn
    if (dest === file && !byName) { inert++; return `<a${rest} href="#" data-inert>${inner}</a>`; }
    if (dest === href) return whole;
    changed++;
    return `<a${rest} href="${dest}">${inner}</a>`;
  });
  return { html: out, changed, inert };
}

// ---- the top menu: every item works, and every item has its own page ----
// The menu items are the links inside the <nav> of the header. A menu item whose page does not exist is REMOVED (never left dead), and when
// two different items lead to the same place, the one whose words are the page's name stays and the other one is removed.
export function navAnchors(html) {
  const header = html.match(/<header\b[\s\S]*?<\/header>/i);
  if (!header) return [];
  const base = header.index; const out = [];
  for (const nav of header[0].matchAll(/<nav\b[\s\S]*?<\/nav>/gi)) {
    for (const a of nav[0].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const start = base + nav.index + a.index;
      out.push({ start, end: start + a[0].length, tag: a[0] });
    }
  }
  return out;
}

export function navProblems(html, files, names = new Map()) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/gi)].map((m) => m[1]));
  const items = navAnchors(html).map((n) => { const l = linksOf(n.tag)[0]; return { ...n, label: l.label, ...classify({ href: l.href, label: l.label, ids }, 'this.html', files) }; });
  const broken = items.filter((i) => !['page', 'anchor'].includes(i.kind));
  const by = new Map();
  for (const i of items.filter((x) => ['page', 'anchor'].includes(x.kind))) { const key = i.dest.replace(/^this\.html/, ''); if (!by.has(key)) by.set(key, []); by.get(key).push(i); }
  const duplicates = [];
  for (const [dest, group] of by) {
    const labels = [...new Set(group.map((g) => g.label))];
    if (labels.length < 2) continue;
    // the item whose words are the page's own name stays; otherwise the first one
    const best = group.find((g) => names.get(norm(g.label)) && dest.startsWith(`${names.get(norm(g.label))}`)) ?? group[0];
    for (const g of group) if (g !== best && !sameIdea(g.label, best.label)) duplicates.push({ item: g, keeps: best.label });
  }
  return { items, broken, duplicates };
}

// removes the broken and the duplicate menu items (with their list item); returns { html, removed: [labels] }
export function cleanNav(html, files, names = new Map()) {
  const { broken, duplicates } = navProblems(html, files, names);
  const drop = [...broken.map((b) => ({ ...b, why: 'no page' })), ...duplicates.map((d) => ({ ...d.item, why: `same place as "${d.keeps}"` }))];
  if (!drop.length) return { html, removed: [] };
  let out = html; const removed = [];
  for (const d of drop.sort((a, b) => b.start - a.start)) {
    let { start, end } = d;
    const before = out.slice(0, start).match(/<li\b[^>]*>\s*$/i); const after = out.slice(end).match(/^\s*<\/li>/i);
    if (before && after) { start -= before[0].length; end += after[0].length; }
    out = out.slice(0, start) + out.slice(end);
    removed.push(`${d.label} (${d.why})`);
  }
  return { html: out, removed };
}

export async function fixLinks({ dir, pages, entry, businessName = '', projectId = null, ask = askJson }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const names = pagesByName(pages.filter((p) => files.includes(hrefFor(p.slug, entry))), businessName, entry);
  const cacheFile = projectId ? projectPath(projectId, 'wow-links.json') : null;
  let answers = {};
  try { if (cacheFile && fs.existsSync(cacheFile)) answers = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { answers = {}; }
  const questions = collectQuestions(dir, files, names).filter((q) => !(q.key in answers));
  let note = '';
  if (questions.length) {
    try { Object.assign(answers, await askLinkTargets({ pages: pages.filter((p) => files.includes(hrefFor(p.slug, entry))), questions, ask, projectId: projectId ?? 'wow-links' })); }
    catch (err) { note = `the model could not decide ${questions.length} link(s) (${String(err.message).slice(0, 80)}): they became inert`; }
    for (const q of questions) answers[q.key] ??= 'none'; // never leave a link pointing at the wrong place
    if (cacheFile && !note) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(answers, null, 2)); }
  }
  const total = { changed: 0, inert: 0, asked: questions.length, note, navRemoved: [] };
  for (const file of files) {
    const p = path.join(dir, file);
    const original = fs.readFileSync(p, 'utf8');
    const r = applyDecisions(original, { file, files, names, answers, entry });
    const nav = cleanNav(r.html, files, names);
    if (nav.html !== original) fs.writeFileSync(p, nav.html);
    total.changed += r.changed; total.inert += r.inert; total.navRemoved.push(...nav.removed.map((x) => `${file}: ${x}`));
  }
  return total;
}
