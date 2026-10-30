// Turns the Stitch pages of a "generate first" site into a folder of static pages that opens by itself:
//   - every picture Stitch drew (Google-hosted address) is downloaded into images/ at full size, then made sharp at a large size
//     (upscale.js), so the site never depends on those links and a full-screen picture is not blurry
//   - the menu and the buttons point to the real page files
//   - sample contact links (tel:, mailto:, WhatsApp) are switched off in draft, so nobody can call or write to a stranger

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeLabel } from '../stages/07-site/transform.js';
import { upscale } from './upscale.js';
import { placeLogo } from './brand.js';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif' };
const REMOTE = /https:\/\/[a-z0-9.-]*(?:googleusercontent\.com|gstatic\.com)\/[^\s"')<>\\]+/gi;
const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => { while (queue.length) await work(queue.shift()); }));
}

// One picture: download it at full size; sharpen it when asked. Returns { path, upscaled } or null.
async function fetchImage(url, folder, { projectId, doUpscale, stats }) {
  let bytes = null; let type = '';
  for (let attempt = 1; attempt <= 3 && !bytes; attempt++) {
    try {
      // Google serves Stitch pictures as 512 px thumbnails unless a size is asked for: "=s0" returns the full picture (about 1376 px)
      const res = await fetch(/=[a-z]\d*[^/]*$/i.test(url) ? url : `${url}=s0`);
      if (res.ok) { type = (res.headers.get('content-type') || '').split(';')[0]; bytes = Buffer.from(await res.arrayBuffer()); }
    } catch { /* try again */ }
    if (!bytes) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  if (!bytes) return null;
  fs.mkdirSync(folder, { recursive: true });
  const key = keyOf(url);
  if (doUpscale && /^image\/(jpeg|png|webp)$/.test(type)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const big = await upscale(bytes, { projectId });
        fs.writeFileSync(path.join(folder, `${key}.jpg`), big.buffer);
        stats.upscaled++;
        return { path: `images/${key}.jpg`, upscaled: true };
      } catch (err) { if (attempt === 2) { stats.upscaleFailed++; stats.errors.push(err.message); } }
    }
  }
  const name = `${key}-o${EXT[type] ?? '.jpg'}`; // "-o": the picture as Stitch gave it
  fs.writeFileSync(path.join(folder, name), bytes);
  return { path: `images/${name}`, upscaled: false };
}

// The pictures worth sharpening are the ones shown large: a picture that fills its whole section (absolute + inset-0, a screen-high
// block), the first picture of a page, and any picture used as a CSS background. Small cards and half-width pictures look fine at
// Stitch's own size (about 1376 px), so they are not paid for twice. This is a guess from the page's classes, not a measurement.
const BIG_CLASS = /\binset-0\b|\b(?:min-)?h-screen\b|\bw-screen\b|\b(?:min-)?h-\[\d+vh\]/;
export function largePictureUrls(html) {
  const big = new Set(); let first = true;
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const url = tag.match(/\bsrc="([^"]+)"/i)?.[1];
    if (!url || !REMOTE.test(url)) { REMOTE.lastIndex = 0; continue; }
    REMOTE.lastIndex = 0;
    if (first || BIG_CLASS.test(tag.match(/\bclass="([^"]*)"/i)?.[1] ?? '')) big.add(url);
    first = false;
  }
  for (const m of html.matchAll(/url\(["']?(https:\/\/[^)"']+)["']?\)/gi)) big.add(m[1]); // CSS backgrounds
  return [...big].filter((u) => { REMOTE.lastIndex = 0; return REMOTE.test(u); });
}

// The entry page of the site is index.html: the Home page when the customer kept one, otherwise the first page they chose.
const hrefFor = (entry = 'home') => (slug) => (slug === entry ? 'index.html' : `${slug}.html`);

// label -> page file, from the brief's pages
function labelMap(pages, hrefOf, entry) {
  const map = new Map();
  for (const p of pages) for (const l of [p.title, p.navLabel]) if (l) map.set(normalizeLabel(l), hrefOf(p.slug));
  map.set('home', hrefOf(entry));
  return map;
}

export function linkPages(html, pages, { bookSlug, entry = 'home' } = {}) {
  const hrefOf = hrefFor(entry);
  const labels = labelMap(pages, hrefOf, entry);
  const slugs = new Set(pages.map((p) => p.slug));
  let unresolved = 0;
  const out = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const href = attrs.match(/\bhref="([^"]*)"/i)?.[1] ?? '';
    const key = normalizeLabel(inner);
    let dest = null;
    if (/^(tel:|mailto:)/i.test(href) || /wa\.me|whatsapp\.com/i.test(href)) dest = '#'; // sample contact: no live link in draft
    else if (/^https?:/i.test(href)) return whole;
    else if (href && !href.startsWith('#')) { const f = href.replace(/^\.?\/?/, '').replace(/\.html?$/i, ''); dest = slugs.has(f) ? hrefOf(f) : f === 'index' ? 'index.html' : null; }
    else if (href.startsWith('#') && href.length > 1 && new RegExp(`\\bid="${href.slice(1)}"`, 'i').test(html)) {
      // an in-page anchor is kept only when its words are not the name of a page: a menu word ("Coaches", "Book", "Contact") goes to its page
      if (!labels.has(key)) return whole;
    }
    if (!dest) dest = labels.get(key) ?? ([...labels.keys()].filter((l) => l.length >= 4 && key.startsWith(l)).sort((a, b) => b.length - a.length).map((l) => labels.get(l))[0]);
    if (!dest && bookSlug && /\b(book|booking|reserve|reservation)\b/.test(key)) dest = hrefOf(bookSlug);
    if (!dest) { if (href === '#' || href === '') unresolved++; return whole; }
    return `<a${attrs.replace(/\shref="[^"]*"/i, '')} href="${dest}">${inner}</a>`;
  });
  return { html: out, unresolved };
}

export async function assemble({ pageFiles, outDir, pages, bookSlug, projectId, doUpscale = false, concurrency = 4, mode = 'final', entry = 'home', logoFile = null, businessName = '' }) {
  const hrefOf = hrefFor(entry);
  fs.mkdirSync(outDir, { recursive: true });
  const folder = path.join(outDir, 'images');
  const stats = { upscaled: 0, upscaleFailed: 0, errors: [] };
  const htmls = pageFiles.map(({ slug, file }) => ({ slug, html: fs.readFileSync(file, 'utf8') }));
  const urls = [...new Set(htmls.flatMap((p) => p.html.match(REMOTE) ?? []))];

  // every picture once (the same picture on several pages is made once); one that is already on disk is not paid for again
  const large = new Set(htmls.flatMap((p) => largePictureUrls(p.html)));
  const local = new Map(); let failedImages = 0;
  const onDisk = (name) => fs.existsSync(path.join(folder, name)) && fs.statSync(path.join(folder, name)).size > 0;
  await pool(urls, concurrency, async (url) => {
    const key = keyOf(url);
    const sharpen = doUpscale && mode === 'final' && large.has(url);
    if (sharpen && onDisk(`${key}.jpg`)) { local.set(url, `images/${key}.jpg`); return; }
    if (!sharpen) { // a sharpened copy from an earlier run is kept; otherwise the plain picture
      if (onDisk(`${key}.jpg`)) { local.set(url, `images/${key}.jpg`); return; }
      const plain = fs.existsSync(folder) ? fs.readdirSync(folder).find((f) => f.startsWith(`${key}-o.`)) : null;
      if (plain && onDisk(plain)) { local.set(url, `images/${plain}`); return; }
    }
    const got = await fetchImage(url, folder, { projectId, doUpscale: sharpen, stats });
    if (got) local.set(url, got.path); else failedImages++;
  });

  const report = { pages: [], images: urls.length, largePictures: large.size, failedImages, unresolvedLinks: {}, upscaled: stats.upscaled, upscaleFailed: stats.upscaleFailed, upscaleErrors: [...new Set(stats.errors)].slice(0, 3) };
  if (logoFile && fs.existsSync(logoFile)) fs.copyFileSync(logoFile, path.join(folder, 'logo.png'));
  for (const { slug, html: raw } of htmls) {
    let html = raw;
    for (const [url, to] of local) html = html.split(url).join(to);
    const linked = linkPages(html, pages, { bookSlug, entry });
    if (logoFile && fs.existsSync(logoFile)) { // the owner's real logo replaces the one the design drew; it is also the tab icon
      const placed = placeLogo(linked.html, { name: businessName, src: 'images/logo.png' });
      linked.html = /rel=["']icon["']/i.test(placed.html) ? placed.html : placed.html.replace(/<head([^>]*)>/i, '<head$1><link rel="icon" href="images/logo.png">');
      report.logoPlaced = (report.logoPlaced ?? 0) + placed.placed;
    }
    report.unresolvedLinks[slug] = linked.unresolved;
    fs.writeFileSync(path.join(outDir, hrefOf(slug)), linked.html);
    report.pages.push(hrefOf(slug));
  }
  report.uniqueImages = urls.length;
  return report;
}
