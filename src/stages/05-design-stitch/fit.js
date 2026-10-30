// Business-fit score (0-100) for one Stitch page: does the design serve THIS business's goal?
// Everything is measured from the page's own HTML, using facts from the brief and the content spec.
// It is a proxy for quality, not a replacement for a human eye.

import { htmlText } from './checks.js';

const WEIGHTS = {
  goalAction: 15,      // the main call to action is early on the page and repeated
  contactPath: 10,     // the customer can see how to reach/order (handles, phone, email)
  contrast: 15,        // text is readable on its background (WCAG 4.5:1)
  brandColors: 15,     // the page uses colors close to the brand's
  structure: 10,       // one h1, language set, every image has alt text
  responsive: 10,      // uses responsive classes (the design was made for desktop only)
  avoidList: 10,       // none of the AI-generic habits (glass blur, purple gradients, heavy shadows)
  honesty: 10,         // no invented prices or claims
  copyKept: 5,         // our exact copy is on the page
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

// Named colors from the page's Tailwind config, e.g. "on-surface": "#1f1b15".
export function namedColors(html) {
  const out = {};
  for (const m of html.matchAll(/["']?([a-z][a-z0-9-_]*)["']?\s*:\s*["'](#[0-9a-fA-F]{6})["']/g)) out[m[1].replace(/_/g, '-')] = m[2];
  return out;
}

// Smallest contrast among the usual text/background pairs the page defines (null when it defines none we know).
export function minContrast(html) {
  const c = namedColors(html);
  const pairs = [['on-background', 'background'], ['on-surface', 'surface'], ['on-primary', 'primary'], ['on-secondary', 'secondary'], ['on-surface', 'surface-container']];
  const ratios = pairs.filter(([a, b]) => c[a] && c[b]).map(([a, b]) => contrast(c[a], c[b]));
  return ratios.length ? Math.min(...ratios) : null;
}

export function fitScore(html, { content, brief, brandColors, verdictsOfMetrics }) {
  const text = htmlText(html);
  const lower = html.toLowerCase();
  const parts = {};
  const notes = {};

  // goal: the primary call to action label, early and repeated
  const label = content.global.primaryCta.label.toLowerCase();
  const positions = [];
  for (let i = text.indexOf(label); i >= 0; i = text.indexOf(label, i + 1)) positions.push(i);
  const early = positions.length > 0 && positions[0] / text.length < 0.25;
  parts.goalAction = (early ? 0.6 : 0) + (positions.length >= 2 ? 0.4 : 0);
  notes.goalAction = `"${content.global.primaryCta.label}" appears ${positions.length}x, first at ${positions.length ? Math.round((positions[0] / text.length) * 100) : '-'}% of the page text`;

  // contact path: every reachable fact the brief has should be on the page
  const c = brief.business.contact;
  const reach = [c.phone, c.email, c.address, ...brief.business.socialLinks.map((l) => l.url.split('/').filter(Boolean).pop().replace('@', ''))].filter(Boolean);
  const shown = reach.filter((r) => lower.includes(r.toLowerCase()));
  parts.contactPath = reach.length ? shown.length / reach.length : null;
  notes.contactPath = reach.length ? `${shown.length}/${reach.length} contact facts from the brief are on the page` : 'brief has no contact facts (n/a)';

  const ratio = minContrast(html);
  parts.contrast = ratio === null ? null : ratio >= 4.5 ? 1 : Math.max(0, (ratio - 3) / 1.5);
  notes.contrast = ratio === null ? 'page defines no text/background color pairs we can read (n/a)' : `lowest text/background contrast ${ratio.toFixed(1)}:1 (needs 4.5)`;

  // brand: how many brand colors have a close color (RGB distance <= 45) on the page
  const pageColors = [...new Set((html.match(/#[0-9a-fA-F]{6}\b/g) || []).map((x) => x.toLowerCase()))];
  const close = brandColors.filter((b) => pageColors.some((p) => distance(b, p) <= 45));
  parts.brandColors = brandColors.length ? close.length / brandColors.length : null;
  notes.brandColors = brandColors.length ? `${close.length}/${brandColors.length} brand colors have a close match on the page` : 'brief has no hex brand colors (n/a)';

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt="[^"]+"/i.test(t)).length;
  const h1 = (html.match(/<h1\b/gi) || []).length;
  const lang = /<html[^>]*\blang=/i.test(html);
  parts.structure = ((h1 === 1 ? 1 : 0) + (lang ? 1 : 0) + (noAlt === 0 ? 1 : 0)) / 3;
  notes.structure = `${h1} h1, lang ${lang ? 'set' : 'missing'}, ${noAlt} image(s) without alt text`;

  const responsive = (html.match(/\b(sm|md|lg|xl):[a-z]/g) || []).length;
  parts.responsive = Math.min(1, responsive / 15);
  notes.responsive = `${responsive} responsive class uses`;

  const blur = (html.match(/backdrop-blur/g) || []).length;
  const purple = (html.match(/(from|via|to)-(purple|violet|indigo|fuchsia)-\d+/g) || []).length;
  const heavyShadow = (html.match(/shadow-(xl|2xl)/g) || []).length;
  const violations = (blur ? 1 : 0) + (purple ? 1 : 0) + (heavyShadow > 6 ? 1 : 0);
  parts.avoidList = 1 - violations / 3;
  notes.avoidList = `glass blur ${blur}, purple gradients ${purple}, heavy shadows ${heavyShadow}`;

  parts.honesty = verdictsOfMetrics ? (verdictsOfMetrics['nothing invented (no risky lines)'] ? 1 : 0) : null;
  notes.honesty = verdictsOfMetrics ? (parts.honesty ? 'no risky invented lines' : 'risky invented lines found') : 'n/a';
  parts.copyKept = verdictsOfMetrics ? (verdictsOfMetrics['our copy appears exactly (>= 95%)'] ? 1 : 0) : null;
  notes.copyKept = verdictsOfMetrics ? (parts.copyKept ? 'our copy is on the page' : 'our copy is missing') : 'n/a';

  // weighted score over the parts that could be measured
  let got = 0;
  let possible = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (parts[key] === null || parts[key] === undefined) continue;
    got += weight * parts[key];
    possible += weight;
  }
  return { score: possible ? Math.round((got / possible) * 100) : null, parts, notes, measuredWeight: possible };
}
