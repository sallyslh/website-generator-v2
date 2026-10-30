// Automatic quality checks for Stage 5 (no LLM). Each check returns { name, ok, details }.
// Some entries are informational (always ok) and report facts we need to know for Stage 7:
// whether slot ids survived as alt text, and whether Stitch used Tailwind or plain CSS.

import fs from 'node:fs';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { designManifestSchema } from '../../schemas/designManifest.js';
import { readImageInfo } from '../../lib/imageInfo.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Visible text of an HTML file, lowercased, with tags and entities removed.
// Visible text lines of an HTML file (comments, scripts, styles and icon-font names removed).
export function htmlLines(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<span[^>]*material-symbols[^>]*>[^<]*<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2);
}

// Lines on the page that are not in our copy (content-spec), our brief, or the navigation labels.
// Returns { extra, risky }: risky = extra lines with sizes, percentages, prices or claim words.
export function invented(html, content, brief) {
  const own = normalize(
    JSON.stringify([content.global, content.pages.map((p) => [p.seo, p.sections.map((s) => [s.heading, s.subheading, s.body, s.items, s.cta])]), brief.business, brief.offerings, brief.pages.map((p) => p.title)]),
  ).replace(/\\"/g, '"');
  const extra = [...new Set(htmlLines(html))].filter((line) => {
    const l = normalize(line).replace(/[“”"]/g, '');
    return l.length > 2 && !own.includes(l) && !/^[\d\s/.:•·–—-]+$/.test(l);
  });
  const RISKY = /\d+\s?(ml|oz|%|\$|usd|€)|\$\s?\d|\b(authentic|original|genuine|guarantee|certified|award|hand-?made|hand-?decanted|organic|free (delivery|shipping)|since \d{4})\b|\b100%/i;
  return { extra, risky: extra.filter((l) => RISKY.test(l)) };
}

export function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function detectCss(html) {
  const tailwind = /cdn\.tailwindcss\.com|tailwind\.config|class="[^"]*\b(flex|grid|px-\d|py-\d|text-(sm|lg|xl)|bg-[a-z]+-\d{2,3})\b/i.test(html);
  return tailwind ? 'Tailwind' : 'plain CSS';
}

function normalize(s) { return s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); }

export function checkStitchFiles({ read, exists: has }, manifest, design, content, brief) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });

  const missing = [];
  const badPng = [];
  const files = manifest.pages.flatMap((p) => [p.html, p.screenshot, ...p.variants.flatMap((v) => [v.html, v.screenshot])]);
  for (const f of files) if (!has(f)) missing.push(f);
  for (const f of files.filter((x) => x.endsWith('.png') && has(x))) {
    const buf = read(f);
    try {
      if (!buf.subarray(0, 4).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
      const { width, height } = readImageInfo(buf, '.png');
      if (!width || !height) throw new Error('no size');
    } catch {
      badPng.push(f);
    }
  }
  check('every expected file exists', missing.length === 0 && manifest.pages.length > 0, missing.length ? `missing: ${missing.join(', ')}` : manifest.pages.length ? '' : 'no pages generated yet');
  check('screenshots are valid PNG images', badPng.length === 0, badPng.join(', '));

  const home = manifest.pages.find((p) => p.slug === 'home');
  if (home) check('home page has at most 1 variant (cost limit)', home.variants.length <= 1, `${home.variants.length} variant(s)`);

  for (const page of manifest.pages) {
    if (!has(page.html)) continue;
    const html = read(page.html).toString('utf8');
    const text = htmlText(html);
    const headings = content.pages.find((p) => p.slug === page.slug).sections.map((s) => s.heading).filter(Boolean);
    const absent = headings.filter((h) => !text.includes(normalize(h)));
    const share = headings.length ? (headings.length - absent.length) / headings.length : 1;
    check(`${page.slug}: the real headings appear in the HTML (at least 80%)`, share >= 0.8, `${headings.length - absent.length}/${headings.length} found${absent.length ? `; missing: ${absent.join(' | ')}` : ''}`);

    const extra = invented(html, content, brief);
    check(`${page.slug}: no invented numbers, sizes, prices or claims in the page text`, extra.risky.length === 0, extra.risky.slice(0, 8).join(' | '));
    check(`${page.slug}: text that is not in our copy (informational)`, true, `${extra.extra.length} extra line(s), e.g. ${extra.extra.slice(0, 6).join(' | ')}`);

    const slotIds = design.pages.find((p) => p.slug === page.slug).sections.flatMap((s) => s.slots.map((x) => x.id));
    const survived = slotIds.filter((id) => html.includes(`alt="${id}"`) || html.includes(`alt='${id}'`) || html.includes(`data-alt="${id}"`));
    check(`${page.slug}: slot ids kept as alt text (informational)`, true, `${survived.length}/${slotIds.length} slot ids found in the HTML`);
    check(`${page.slug}: CSS approach (informational)`, true, detectCss(html));
  }
  const prompts = manifest.pages.filter((p) => !p.promptUsed.includes(design.styleBlock.slice(0, 40)));
  check('every prompt contains the styleBlock', prompts.length === 0, prompts.map((p) => p.slug).join(', '));
  return results;
}

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'design/design-manifest.json')) throw new Error(`Missing design/design-manifest.json in "${projectId}". Run: node src/cli.js design --project ${projectId}`);
  const manifest = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const io = { read: (f) => fs.readFileSync(projectPath(projectId, f)), exists: (f) => fs.existsSync(projectPath(projectId, f)) };
  return checkStitchFiles(io, manifest, design, content, readJson(projectId, 'site-brief.json', siteBriefSchema));
}
