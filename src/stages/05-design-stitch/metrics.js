// Design metrics: scores one Stitch HTML page the same way for every version (full, free style, lean, baseline).
// It answers: are the image areas right, is our copy exact, are the colors used, did Stitch add things we did not ask for?
// "Looks professional, not AI-generic" stays a human 1-5 score (see scorecard.js).

import fs from 'node:fs';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { htmlText, invented } from './checks.js';
import { fitScore } from './fit.js';
import { fontsOnPage, isBannedFont } from '../03-creative-director/fonts.js';
import { numbersIn, missingPrices, pricedOfferings } from '../../lib/prices.js';
import { NEEDS_MARKER } from '../04-content/rules.js';

const HEX = /^#[0-9a-f]{6}$/i;
const norm = (s) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

function images(html) {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => ({
    tag: m[0], at: m.index,
    alt: m[0].match(/\balt="([^"]*)"/i)?.[1] ?? '',
  }));
}

// Aspect ratio planned for a frame vs the one Stitch used (from Tailwind aspect classes near the <img>).
function usedRatio(html, img) {
  const context = html.slice(Math.max(0, img.at - 700), img.at + img.tag.length);
  const found = [...context.matchAll(/aspect-\[(\d+)\/(\d+)\]|aspect-(square|video)/g)].pop();
  if (!found) return null;
  if (found[3] === 'square') return 1;
  if (found[3] === 'video') return 16 / 9;
  return Number(found[1]) / Number(found[2]);
}

// The prices of the brief that our copy puts on this page, and how many of them the Stitch page really shows.
function pagePrices(pageText, copy, brief) {
  const inCopy = new Set(numbersIn(copy.join(' | ')));
  const expected = pricedOfferings(brief).filter((o) => numbersIn(o.price).every((n) => inCopy.has(n)));
  const missing = missingPrices(pageText, { offerings: expected });
  return { expected: expected.length, found: expected.length - missing.length, missing: missing.map((o) => `${o.name} ${o.price}`) };
}

// slots: [{ id, aspect }], copy: strings that must appear, palette: hex colors that must appear
export function measure(html, { slots, copy, palette, brandColors, content, brief, designedSections }) {
  const imgs = images(html);
  const slotIds = new Set(slots.map((s) => s.id));
  const text = htmlText(html);
  const lower = html.toLowerCase();

  const placed = slots.filter((s) => imgs.some((i) => i.alt === s.id));
  const repeated = slots.filter((s) => imgs.filter((i) => i.alt === s.id).length > 1).map((s) => s.id);
  const looksLikeLogo = (i) => /logo|badge|seal|insignia|mark|emblem|monogram/i.test(i.alt);
  const unexpected = imgs.filter((i) => !slotIds.has(i.alt) && !looksLikeLogo(i));

  let shapeKnown = 0;
  let shapeOk = 0;
  for (const s of slots) {
    const img = imgs.find((i) => i.alt === s.id);
    const [w, h] = (s.aspect || '').split(':').map(Number);
    if (!img || !w || !h) continue;
    const used = usedRatio(html, img);
    if (used === null) continue;
    shapeKnown++;
    if (Math.abs(used - w / h) / (w / h) < 0.15) shapeOk++;
  }

  const missingCopy = copy.filter((c) => !text.includes(norm(c)));
  const paletteFound = palette.filter((c) => lower.includes(c.toLowerCase()));
  const brandFound = brandColors.filter((c) => lower.includes(c.toLowerCase()));
  const extra = content ? invented(html, content, brief) : { extra: [], risky: [] };
  const sectionTags = (html.match(/<section\b/gi) || []).length;

  return {
    imageAreas: { found: placed.length, expected: slots.length, repeated, unexpected: unexpected.length },
    shapes: { matching: shapeOk, measurable: shapeKnown, expected: slots.length },
    altTextIsSlotId: { found: placed.length, expected: slots.length },
    copyExact: { found: copy.length - missingCopy.length, expected: copy.length, missing: missingCopy.slice(0, 5) },
    paletteColors: { found: paletteFound.length, expected: palette.length },
    brandColors: { found: brandFound.length, expected: brandColors.length },
    prices: pagePrices(text, copy, brief),
    fonts: (() => { const used = fontsOnPage(html); return { used, banned: used.filter(isBannedFont) }; })(),
    invented: { extraTextLines: extra.extra.length, riskyLines: extra.risky.length, examples: extra.risky.slice(0, 3) },
    sections: { onPage: sectionTags, designed: designedSections },
    iconFontWords: (html.match(/material-symbols/g) || []).length,
    sizeKB: Math.round(html.length / 1024),
  };
}

// Pass/fail view of the numbers. Shapes and sections are informational (Stitch merges and styles freely).
export function verdicts(m) {
  const all = (x) => x.expected === 0 || x.found === x.expected;
  return {
    'image areas: every slot present': all(m.imageAreas) && m.imageAreas.repeated.length === 0,
    'no unrequested images': m.imageAreas.unexpected === 0,
    'shapes match the plan': m.shapes.measurable === 0 ? null : m.shapes.matching === m.shapes.measurable,
    'alt text = slot name': all(m.altTextIsSlotId),
    'our copy appears exactly (>= 95%)': m.copyExact.expected === 0 || m.copyExact.found / m.copyExact.expected >= 0.95,
    'palette colors used': all(m.paletteColors),
    'brand colors used': all(m.brandColors),
    'no font that every AI site uses': m.fonts.banned.length === 0,
    'every price of this page is shown': m.prices.expected === 0 ? null : m.prices.found === m.prices.expected,
    'nothing invented (no risky lines)': m.invented.riskyLines === 0,
    'few extra text lines (<= 10)': m.invented.extraTextLines <= 10,
  };
}

// Everything that must appear on a page, from the content spec (NEEDS notes excluded).
export function copyStrings(content, slug) {
  const page = content.pages.find((p) => p.slug === slug);
  const out = [];
  for (const s of page.sections) {
    if (s.heading) out.push(s.heading);
    if (s.subheading) out.push(s.subheading);
    (s.body ?? []).filter((b) => !b.trim().startsWith(NEEDS_MARKER)).forEach((b) => out.push(b));
    (s.items ?? []).forEach((i) => { out.push(i.title); out.push(i.text); });
    if (s.cta) out.push(s.cta.label);
  }
  return out.filter(Boolean);
}

// Finds every version of the home page in a project and measures them all.
export function measureProject(projectId, slug = 'home') {
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const designPage = design.pages.find((p) => p.slug === slug);
  const specSlots = designPage.sections.flatMap((s) => s.slots.map((x) => ({ id: x.id, aspect: x.aspect })));
  const leanSlots = exists(projectId, 'design/lean/frames.json')
    ? JSON.parse(fs.readFileSync(projectPath(projectId, 'design/lean/frames.json'), 'utf8')).map((f) => ({ id: f.slot, aspect: f.aspect }))
    : [];
  const brandColors = brief.brand.colors.filter((c) => HEX.test(c));
  const palette = Object.values(design.colors);

  const versions = [];
  const add = (label, file, opts) => exists(projectId, file) && versions.push({ label, file, opts });
  const full = { slots: specSlots, copy: copyStrings(content, slug), palette, brandColors };
  add('A: with creative director', `design/${slug}.html`, full);
  const manifest = exists(projectId, 'design/design-manifest.json') ? readJson(projectId, 'design/design-manifest.json') : { pages: [] };
  (manifest.pages.find((p) => p.slug === slug)?.variants ?? []).forEach((v, i) => add(`A variant ${i + 1}`, v.html, full));
  add('B: free style (our copy, Stitch picks the look)', 'design/freestyle/home-freestyle.html', { slots: specSlots, copy: copyStrings(content, slug), palette: [], brandColors });
  add('Lean: brief + image facts', 'design/lean/home-lean.html', { slots: leanSlots, copy: [], palette: [], brandColors });
  add('Baseline: brief only', 'design/baseline/home-baseline.html', { slots: [], copy: [], palette: [], brandColors });

  return versions.map((v) => {
    const html = fs.readFileSync(projectPath(projectId, v.file), 'utf8');
    const metrics = measure(html, { ...v.opts, content, brief, designedSections: designPage.sections.length });
    const v2 = verdicts(metrics);
    return { label: v.label, file: v.file, metrics, verdicts: v2, fit: fitScore(html, { content, brief, brandColors, verdictsOfMetrics: v2 }) };
  });
}

// Prints a table: one row per metric, one column per version.
export function printMetricsTable(results) {
  const mark = (v) => (v === null ? 'n/a' : v ? 'PASS' : 'FAIL');
  const names = Object.keys(results[0]?.verdicts ?? {});
  const width = Math.max(...names.map((n) => n.length), 10);
  const cols = results.map((r) => r.label.split(':')[0].slice(0, 12));
  console.log(`\n${'metric'.padEnd(width)}  ${cols.map((c) => c.padEnd(12)).join(' ')}`);
  for (const n of names) console.log(`${n.padEnd(width)}  ${results.map((r) => mark(r.verdicts[n]).padEnd(12)).join(' ')}`);
  console.log('\nDetails:');
  for (const r of results) {
    const m = r.metrics;
    console.log(`  ${r.label}`);
    console.log(`     image areas ${m.imageAreas.found}/${m.imageAreas.expected} (unrequested images: ${m.imageAreas.unexpected}) | shapes ${m.shapes.matching}/${m.shapes.measurable} measurable | copy exact ${m.copyExact.found}/${m.copyExact.expected}`);
    console.log(`     fonts ${m.fonts.used.slice(0, 4).join(', ') || 'n/a'}${m.fonts.banned.length ? ` (AI-default: ${m.fonts.banned.join(', ')})` : ''} | prices ${m.prices.found}/${m.prices.expected}${m.prices.missing.length ? ` (missing: ${m.prices.missing.join(', ')})` : ''} | palette ${m.paletteColors.found}/${m.paletteColors.expected} | brand colors ${m.brandColors.found}/${m.brandColors.expected} | extra text lines ${m.invented.extraTextLines}, risky ${m.invented.riskyLines} | sections ${m.sections.onPage} on page vs ${m.sections.designed} designed | icon-font words ${m.iconFontWords} | ${m.sizeKB} KB`);
    if (m.invented.examples.length) console.log(`     risky e.g.: ${m.invented.examples.join(' | ').slice(0, 160)}`);
    if (m.copyExact.missing.length) console.log(`     copy missing e.g.: ${m.copyExact.missing.slice(0, 2).join(' | ').slice(0, 160)}`);
  }
  console.log('\nBUSINESS-FIT SCORE (0-100, higher = serves this business better):');
  for (const r of results) console.log(`  ${String(r.fit.score ?? 'n/a').padStart(3)}  ${r.label}`);
  console.log('\nWhy (per version):');
  for (const r of results) {
    console.log(`  ${r.label}`);
    for (const [k, n] of Object.entries(r.fit.notes)) {
      const part = r.fit.parts[k];
      console.log(`     ${k.padEnd(12)} ${part === null || part === undefined ? 'n/a ' : `${String(Math.round(part * 100)).padStart(3)}%`}  ${n}`);
    }
  }
  console.log('\nStill needs a human score (1-5): does it look professional, not AI-generic?');
}
