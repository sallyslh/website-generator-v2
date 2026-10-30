// Automatic quality checks for Stage 7 (no LLM). Each check returns { name, ok, details }.
// checkSite is pure (unit tested): it gets the HTML of every page (the built dist pages when they exist) and the file lists.

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { approvedDesignSchema } from '../../schemas/approvedDesign.js';
import { NEEDS_MARKER } from '../04-content/rules.js';
import { pageHref } from './transform.js';
import { allowedText, unknownText, words, textPieces } from './textRules.js';
import { formatPrice } from '../../lib/price.js';
import { editedTexts } from '../../lib/siteEdits.js';

export { allowedText, unknownText, textPieces } from './textRules.js';

export function checkSite({ brief, content, approvedSlugs, pages, distFiles, built, report, imageSizes = {}, ownText = [] }) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const allowed = allowedText(brief, content) + words(ownText.join(' | ')) + ' '; // what the customer typed themselves is theirs, not invented
  const routeOf = (slug) => (slug === 'home' ? '/' : `/${slug}/`);

  check('the site is built (dist exists)', built, built ? '' : 'run: node src/cli.js site --project <id> --build');
  const missingPages = approvedSlugs.filter((s) => !pages.some((p) => p.slug === s));
  check('every approved page became a page of the site', missingPages.length === 0, missingPages.join(', '));

  // A long list (a menu) was drawn with a sample of its rows and completed by code: every item of the owner's list must be on its page.
  const longLists = content.pages.flatMap((p) => p.sections.filter((s) => s.items.length >= 8).map((s) => ({ slug: p.slug, id: s.id, titles: s.items.map((i) => i.title) })));
  const listGaps = longLists.flatMap(({ slug, id, titles }) => {
    const page = pages.find((p) => p.slug === slug);
    if (!page) return [];
    const hay = ` ${words(textPieces(page.html).join(' | '))} `;
    const absent = titles.filter((t) => !hay.includes(` ${words(t)} `));
    return absent.length ? [`${slug}/${id}: ${absent.length} of ${titles.length} missing (${absent.slice(0, 3).join(', ')})`] : [];
  });
  check('every item of a long list is on its page', listGaps.length === 0, listGaps.join('; '));

  // ...and each price the owner gave is shown, with its currency sign when the owner chose one
  const keyOf = (t) => String(t).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const offeringOf = new Map(brief.offerings.map((o) => [keyOf(o.name), o]));
  const priceGaps = longLists.flatMap(({ slug, id, titles }) => {
    const page = pages.find((p) => p.slug === slug);
    if (!page) return [];
    const lacking = titles.map((t) => offeringOf.get(keyOf(t))).filter((o) => o?.price && !page.html.includes(`>${formatPrice(o.price, brief.currency)}<`)).map((o) => o.name);
    return lacking.length ? [`${slug}/${id}: ${lacking.length} price(s) not shown (${lacking.slice(0, 3).join(', ')})`] : [];
  });
  check('every price of a long list is shown with its currency sign', priceGaps.length === 0, priceGaps.join('; '));

  const bad = (re, label) => pages.filter((p) => re.test(p.html)).map((p) => `${p.slug}: ${label}`);
  const leftovers = [
    ...bad(/cdn\.tailwindcss\.com/i, 'still uses the Tailwind CDN'),
    ...bad(/\.\.\/inputs\/|inputs\/assets\//i, 'points to the customer\'s original files'),
    ...bad(/googleusercontent\.com|lh3\./i, 'shows a Stitch image from the internet'),
    ...bad(/<img\b[^>]*src="data:/i, 'has an inline placeholder picture'),
    ...bad(/photo needed/i, 'shows the words "Photo needed"'),
    ...bad(new RegExp(NEEDS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'shows a NEEDS note'),
    ...bad(/lorem ipsum/i, 'has lorem ipsum'),
    ...bad(/data-empty-photo/i, 'has an empty picture frame'),
  ];
  check('no Stitch leftovers (CDN, internet pictures, placeholders, notes)', leftovers.length === 0, leftovers.join('; '));

  const noAlt = [];
  const missingFiles = [];
  for (const p of pages)
    for (const tag of p.html.match(/<img\b[^>]*>/gi) || []) {
      if (!/\balt="[^"]+"/i.test(tag)) noAlt.push(`${p.slug}: ${tag.slice(0, 60)}`);
      const src = tag.match(/\bsrc="([^"]*)"/i)?.[1];
      if (src && src.startsWith('/') && distFiles && !distFiles.has(src.split('?')[0])) missingFiles.push(`${p.slug}: ${src}`);
    }
  check('every picture has alt text', noAlt.length === 0, noAlt.slice(0, 5).join('; '));
  check('every picture file exists in the build', missingFiles.length === 0, missingFiles.join('; '));
  const heavy = Object.entries(imageSizes).filter(([, bytes]) => bytes > 400 * 1024).map(([f, b]) => `${f} ${(b / 1024).toFixed(0)} KB`);
  check('pictures are web-sized (400 KB or less each)', heavy.length === 0, heavy.join(', '));

  // the motion files the pages load must exist in the build (a missing script file only fails silently in a visitor's browser)
  const motionMissing = pages.filter((p) => /\/motion\.(css|js)/.test(p.html) && distFiles && !(distFiles.has('/motion.css') && distFiles.has('/motion.js'))).map((p) => p.slug);
  check('the motion files the pages load are in the build', motionMissing.length === 0, motionMissing.join(', '));

  const deadLinks = [];
  const dead = [];
  for (const p of pages)
    for (const m of p.html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) {
      const href = m[1];
      if (href === '#' || href === '') dead.push(`${p.slug}: href="${href}"`);
      else if (href.startsWith('/')) {
        const clean = href.split('#')[0] || '/';
        if (!approvedSlugs.some((s) => routeOf(s) === clean) && !(distFiles && distFiles.has(clean))) deadLinks.push(`${p.slug}: ${href}`);
      }
    }
  check('every link goes somewhere (no "#" links, no missing pages)', dead.length === 0 && deadLinks.length === 0, [...new Set([...dead, ...deadLinks])].slice(0, 6).join('; '));

  const seoBad = [];
  for (const p of pages) {
    const spec = content.pages.find((c) => c.slug === p.slug)?.seo;
    const title = p.html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const desc = p.html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? '';
    if (!title || !desc) seoBad.push(`${p.slug}: no title or description`);
    else if (spec && (title.replace(/&amp;/g, '&') !== spec.title.replace(/&amp;/g, '&'))) seoBad.push(`${p.slug}: title is not the one from the copy`);
    if (!/<html[^>]*\blang="[a-z]{2}/i.test(p.html)) seoBad.push(`${p.slug}: no html lang`);
  }
  check('every page has the SEO title and description from the copy, and a language', seoBad.length === 0, seoBad.join('; '));

  const h1 = pages.filter((p) => (p.html.match(/<h1\b/gi) || []).length !== 1).map((p) => `${p.slug}: ${(p.html.match(/<h1\b/gi) || []).length} h1`);
  check('every page has exactly one main heading (h1)', h1.length === 0, h1.join(', '));

  const strange = pages.flatMap((p) => unknownText(p.html, allowed).map((t) => `${p.slug}: "${t.slice(0, 70)}"`));
  check('all visible text comes from the approved copy or the customer\'s facts (nothing invented by the design)', strange.length === 0, strange.slice(0, 6).join('; ') + (strange.length > 6 ? ` (+${strange.length - 6} more)` : ''));

  const mailTel = pages.flatMap((p) => [...p.html.matchAll(/href="(tel:[^"]*|mailto:[^"]*)"/gi)].map((m) => m[1])).filter((h) => {
    const d = h.replace(/\D/g, '');
    return h.startsWith('tel:') ? !(brief.business.contact.phone && brief.business.contact.phone.replace(/\D/g, '').endsWith(d.slice(-7))) : !h.toLowerCase().includes(brief.business.contact.email.toLowerCase() || '\0');
  });
  check('phone and email links use only the numbers the customer gave', mailTel.length === 0, [...new Set(mailTel)].join(', '));

  if (report) {
    check('forms are connected (informational: connecting forms is the features stage)', true, report.forms ? `${report.forms} form(s) not connected yet` : 'no forms');
    const combined = report.combined ?? [];
    const unapprovedAi = combined.filter((c) => c.origin === 'generated' && c.approval !== 'approved' && pages.some((p) => p.html.includes(`/images/${c.id}.webp`))).map((c) => c.id);
    check('a generated picture the customer did not approve is not on the site', unapprovedAi.length === 0, unapprovedAi.join(', '));
    const rejectedShown = combined.filter((c) => c.approval === 'rejected' && pages.some((p) => p.html.includes(`/images/${c.id}.webp`))).map((c) => c.id);
    check('a combined picture the customer rejected is not on the site', rejectedShown.length === 0, rejectedShown.join(', '));
    const pending = combined.filter((c) => c.approval === 'pending' && c.used).map((c) => c.id);
    check('combined pictures waiting for the owner approval (informational)', true, pending.length ? pending.join(', ') : combined.length ? 'all approved' : 'none');
    check('pictures planned for the page but not drawn by the design (informational)', true, report.undrawnSlots?.length ? report.undrawnSlots.join(', ') : 'none');
    check('photo slots without a photo (informational)', true, report.emptyPhotoSlots?.length ? [...new Set(report.emptyPhotoSlots)].join(', ') : 'all slots have photos');
  }
  return results;
}

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full, base) : [full];
});

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'site/site-report.json')) throw new Error(`The site is not generated in "${projectId}". Run: node src/cli.js site --project ${projectId}`);
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const approved = readJson(projectId, 'approved-design.json', approvedDesignSchema);
  const report = JSON.parse(fs.readFileSync(projectPath(projectId, 'site/site-report.json'), 'utf8'));
  const dist = projectPath(projectId, 'site/dist');
  const built = fs.existsSync(path.join(dist, 'index.html'));
  const pages = built
    ? approved.pages.map((p) => ({ slug: p.slug, html: fs.existsSync(path.join(dist, p.slug === 'home' ? 'index.html' : `${p.slug}/index.html`)) ? fs.readFileSync(path.join(dist, p.slug === 'home' ? 'index.html' : `${p.slug}/index.html`), 'utf8') : '' })).filter((p) => p.html)
    : [];
  const files = built ? walk(dist) : [];
  const distFiles = new Set(files.map((f) => '/' + path.relative(dist, f).split(path.sep).join('/')));
  const imageSizes = Object.fromEntries(files.filter((f) => /[\\/]images[\\/]/.test(f)).map((f) => [path.basename(f), fs.statSync(f).size]));
  return checkSite({ brief, content, approvedSlugs: approved.pages.map((p) => p.slug), pages, distFiles, built, report, imageSizes, ownText: editedTexts(projectId) });
}

export { pageHref };
