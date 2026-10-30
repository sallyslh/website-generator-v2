// Automatic quality checks for Stage 4 (no LLM). Each check returns { name, ok, details }.
// checkContent is pure (unit tested); runChecks loads the project files.

import { exists, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { crossCheck } from '../../schemas/crossChecks.js';
import { BANNED_CLICHES, CLAIM_WORDS, NEEDS_MARKER } from './rules.js';
import { missingPrices, pricedOfferings } from '../../lib/prices.js';

const digits = (s) => s.replace(/\D/g, '');

// Everyday words that appear on packaging and in normal copy; they are not product names.
const COMMON_WORDS = new Set(['from', 'with', 'this', 'that', 'which', 'your', 'works', 'made', 'pour', 'home', 'homme', 'femme', 'spray', 'natural', 'eau', 'parfum', 'toilette', 'perfume', 'scent', 'scents', 'fragrance', 'black', 'white', 'gold', 'silver', 'night', 'love', 'rose', 'flower', 'flowers', 'sweet', 'daily', 'body', 'lotion', 'cream', 'hand', 'butter', 'moisture', 'nourishing', 'mist', 'shea', 'hours', 'ounce', 'net', 'new', 'size', 'care']);

// All visible copy as { where, text } pairs. Alt text is kept apart (it describes pictures, not claims).
function copyTexts(content, { withAlt = false } = {}) {
  const out = [];
  const add = (where, text) => text && out.push({ where, text });
  const g = content.global;
  add('global.siteTitle', g.siteTitle);
  g.navigation.forEach((n) => add('global.navigation', n.label));
  add('global.primaryCta', g.primaryCta.label);
  add('global.footerText', g.footerText);
  add('global.formMessages', g.formMessages?.success);
  add('global.formMessages', g.formMessages?.error);
  for (const p of content.pages) {
    add(`${p.slug}.seo`, p.seo.title);
    add(`${p.slug}.seo`, p.seo.description);
    for (const s of p.sections) {
      add(s.id, s.heading);
      add(s.id, s.subheading);
      s.body.forEach((b) => add(s.id, b));
      s.items.forEach((i) => { add(s.id, i.title); add(s.id, i.text); });
      add(s.id, s.cta?.label);
      if (withAlt) Object.values(s.imageAlt).forEach((a) => add(s.id, a));
    }
  }
  return out;
}

// The facts the copy may use: the brief (without unknowns and proposals) and the customer's documents.
function sourcesText(brief, manifest) {
  const { unknowns, proposals, ...facts } = brief;
  return `${JSON.stringify(facts)} ${JSON.stringify(manifest.documents)}`.toLowerCase();
}

function inventedFacts(content, source) {
  const sourceDigits = digits(source);
  const problems = [];
  for (const { where, text } of copyTexts(content)) {
    if (text.trim().startsWith(NEEDS_MARKER)) continue;
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []) if (!source.includes(email.toLowerCase())) problems.push(`${where}: email ${email}`);
    for (const url of text.match(/https?:\/\/\S+/g) || []) if (!source.includes(url.toLowerCase().replace(/[.,;)]+$/, ''))) problems.push(`${where}: url ${url}`);
    for (const num of text.replace(/https?:\/\/\S+/g, '').match(/\d[\d ()\-.,:]*\d/g) || []) {
      if (/^\d(,\s*\d)+$/.test(num.trim())) continue; // step numbering like "1, 2, 3"
      const d = digits(num);
      if (d && !sourceDigits.includes(d)) problems.push(`${where}: number "${num}"`);
    }
  }
  return [...new Set(problems)];
}

function unsupportedClaims(content, source) {
  const found = [];
  for (const { where, text } of copyTexts(content)) {
    const lower = text.toLowerCase();
    for (const word of CLAIM_WORDS) {
      const re = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}($|[^a-z])`, 'i');
      if (re.test(lower) && !source.includes(word.toLowerCase())) found.push(`${where}: "${word}"`);
    }
  }
  return [...new Set(found)];
}

// Words that are only visible on a photo (names, brands) and not in the brief must not appear in the copy.
function photoOnlyWords(content, source, manifest) {
  // only the label text itself: words inside quotes, or ALL-CAPS words, after "Text visible:"
  const labelWords = (notes) => {
    const segment = notes.match(/Text visible:(.*)$/is)?.[1] ?? '';
    const quoted = [...segment.matchAll(/["“']([^"”']{2,60})["”']/g)].map((m) => m[1]).join(' ');
    const caps = segment.match(/\b\p{Lu}{4,}\b/gu) || [];
    return `${quoted} ${caps.join(' ')}`.match(/[\p{L}][\p{L}'’-]{3,}/gu) || [];
  };
  const visible = manifest.assets.filter((a) => a.kind !== 'logo').flatMap((a) => labelWords(a.notes));
  const risky = new Set(visible.map((w) => w.toLowerCase()).filter((w) => !source.includes(w) && !COMMON_WORDS.has(w)));
  const copy = copyTexts(content).filter(({ text }) => !text.trim().startsWith(NEEDS_MARKER));
  const found = [];
  for (const { where, text } of copy)
    for (const word of text.toLowerCase().match(/[\p{L}][\p{L}'’-]{3,}/gu) || []) if (risky.has(word)) found.push(`${where}: "${word}"`);
  return [...new Set(found)];
}

function badTargets(content, brief) {
  const slugs = new Set(brief.pages.map((p) => p.slug));
  const socials = new Set(brief.business.socialLinks.map((l) => l.platform.toLowerCase()));
  const bad = [];
  const ctas = [{ where: 'global.primaryCta', cta: content.global.primaryCta }];
  for (const p of content.pages) for (const s of p.sections) if (s.cta) ctas.push({ where: s.id, cta: s.cta });
  for (const { where, cta } of ctas) {
    const t = cta.target;
    const ok = slugs.has(t) || t === 'form' || /^https?:\/\//.test(t)
      || (t.startsWith('tel:') && brief.business.contact.phone && digits(t) === digits(brief.business.contact.phone))
      || (t.startsWith('social:') && socials.has(t.slice(7).toLowerCase()));
    if (!ok) bad.push(`${where}: "${t}"`);
  }
  return bad;
}

export function checkContent(rawContent, brief, design, manifest) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const parsed = contentSpecSchema.safeParse(rawContent);
  check('schema valid (SEO title <= 60, description <= 155)', parsed.success, parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  if (!parsed.success) return results;
  const content = parsed.data;
  const source = sourcesText(brief, manifest);

  const mismatch = crossCheck({ design, content });
  check('section ids match the design spec exactly', mismatch.length === 0, mismatch.join('; '));

  const missingAlt = [];
  for (const dp of design.pages)
    for (const s of dp.sections)
      for (const slot of s.slots)
        if (!content.pages.find((p) => p.slug === dp.slug)?.sections.find((x) => x.id === s.id)?.imageAlt?.[slot.id]?.trim()) missingAlt.push(slot.id);
  check('every image slot has alt text', missingAlt.length === 0, missingAlt.join(', '));

  const all = copyTexts(content, { withAlt: true });
  const cliches = all.flatMap(({ where, text }) => BANNED_CLICHES.filter((c) => text.toLowerCase().includes(c)).map((c) => `${where}: "${c}"`));
  check('no banned clichés', cliches.length === 0, [...new Set(cliches)].join('; '));

  const placeholders = all.filter(({ text }) => /lorem|ipsum|\[[^\]]{2,}\]|\bTODO\b|\bTBD\b|placeholder/i.test(text)).map((x) => `${x.where}: ${x.text.slice(0, 40)}`);
  check('no lorem ipsum or placeholder text', placeholders.length === 0, placeholders.join('; '));

  const invented = inventedFacts(content, source);
  check('no numbers, emails or URLs that are not in the brief or documents', invented.length === 0, invented.join('; '));
  const claims = unsupportedClaims(content, source);
  check('no unsupported claims (original, guaranteed, free delivery, since...)', claims.length === 0, claims.join('; '));

  const copyForPrices = copyTexts(content).map((c) => c.text).join(' | ');
  const unpriced = missingPrices(copyForPrices, brief);
  check('every price from the brief is shown in the copy', unpriced.length === 0,
    unpriced.length ? `missing: ${unpriced.map((o) => `${o.name} ${o.price}`).join(', ')}` : pricedOfferings(brief).length ? '' : 'the brief has no prices (nothing to show)');

  const fromPhotos = photoOnlyWords(content, source, manifest);
  check('no product or brand names taken from photos (they are not confirmed by the owner)', fromPhotos.length === 0, fromPhotos.join('; '));

  if (brief.business.story) {
    const aboutPages = content.pages.filter((p) => /about|story/i.test(p.slug) || p.sections.some((s) => /about|story/i.test(s.id)));
    const lines = aboutPages.flatMap((p) => p.sections.flatMap((s) => [...(s.body ?? []), ...(s.items ?? []).map((i) => i.text)]));
    const written = lines.filter((t) => !t.trim().startsWith(NEEDS_MARKER)).join(' ');
    const asksForStory = lines.some((t) => t.trim().startsWith(NEEDS_MARKER) && /story/i.test(t));
    check('the owner\'s story is used in the About section (not just a request for it)', aboutPages.length > 0 && written.length >= 60 && !asksForStory,
      aboutPages.length === 0 ? 'there is no About page or story section' : asksForStory ? 'the copy asks for a story the owner already gave' : `only ${written.length} characters of About text`);
  }

  const targets = badTargets(content, brief);
  check('call-to-action targets point to something real', targets.length === 0, targets.join('; '));

  const longHeadings = content.pages.flatMap((p) => p.sections).filter((s) => s.heading.split(/\s+/).filter(Boolean).length > 12).map((s) => s.id);
  check('headings are short (12 words or fewer)', longHeadings.length === 0, longHeadings.join(', '));

  if (brief.features.some((f) => f.type === 'contact-form')) check('form messages exist when the brief has a contact form', Boolean(content.global.formMessages));
  const needs = content.pages.flatMap((p) => p.sections).flatMap((s) => s.body.filter((b) => b.trim().startsWith(NEEDS_MARKER))).length;
  check('missing facts are marked with NEEDS (informational)', true, `${needs} NEEDS note(s)`);
  return results;
}

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'content-spec.json')) throw new Error(`Missing content-spec.json in "${projectId}". Run: node src/cli.js content --project ${projectId}`);
  return checkContent(
    readJson(projectId, 'content-spec.json'),
    readJson(projectId, 'site-brief.json', siteBriefSchema),
    readJson(projectId, 'design-spec.json', designSpecSchema),
    exists(projectId, 'asset-manifest.json') ? readJson(projectId, 'asset-manifest.json', assetManifestSchema) : { assets: [], documents: [] },
  );
}
