// Puts the customer's REAL photos into the Stitch sketches.
// Stitch draws its own imaginary pictures; every image frame has its slot id as alt text, so we swap the
// picture for the real asset chosen by the creative director. Slots with no photo get a neutral "photo needed"
// block, and the logo area gets the real logo. The HTML files are rewritten in place (it is safe to run again).

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { showPhoto, dropDrawnPlaceholders } from '../../lib/frames.js';

const LOGO_LIKE = /logo|badge|seal|insignia|emblem|monogram/i;

// "Photo needed" picture used for slots without a real photo (an inline SVG, no file needed).
const placeholder = (label) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e9e4dc"/><text x="200" y="262" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#7a7468">Photo needed</text><text x="200" y="283" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#9a9488">${label.replace(/[<&]/g, '')}</text></svg>`,
)}`;

// slot id (or "photo-N" for the lean mode) -> asset id or null
function slotMap(projectId) {
  const map = new Map();
  if (exists(projectId, 'design-spec.json'))
    for (const page of readJson(projectId, 'design-spec.json', designSpecSchema).pages)
      for (const section of page.sections) for (const slot of section.slots) map.set(slot.id, slot.assignedAsset);
  if (exists(projectId, 'design/lean/frames.json'))
    for (const f of JSON.parse(fs.readFileSync(projectPath(projectId, 'design/lean/frames.json'), 'utf8'))) map.set(f.slot, f.assetId);
  return map;
}

// Rewrites the <img> tags of one HTML string. `urlFor(assetId)` gives the address of a real photo.
export function swapImages(html, { slots, urlFor, logoUrl }) {
  let swapped = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = tag.match(/\balt="([^"]*)"/i)?.[1] ?? '';
    let url = null;
    if (slots.has(alt)) url = slots.get(alt) ? urlFor(slots.get(alt)) : placeholder(alt);
    else if (logoUrl && LOGO_LIKE.test(alt)) url = logoUrl;
    if (!url) return tag;
    swapped++;
    const withSrc = /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, () => `src="${url}"`) : tag.replace(/^<img/i, () => `<img src="${url}"`);
    const noSet = showPhoto(withSrc).replace(/\s(srcset|data-src)="[^"]*"/gi, '');
    return /\bstyle="/i.test(noSet) ? noSet.replace(/\bstyle="/i, 'style="object-fit:cover;') : noSet.replace(/^<img/i, '<img style="object-fit:cover"');
  });
  return { html: dropDrawnPlaceholders(out), swapped };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.html') && e.name !== 'preview.html' ? [full] : [];
  });
}

// Applies the swap to every Stitch HTML file of a project. Returns the number of images replaced.
export function applyRealPhotos(projectId) {
  const designDir = projectPath(projectId, 'design');
  if (!fs.existsSync(designDir) || !exists(projectId, 'asset-manifest.json') || !exists(projectId, 'design-spec.json')) return 0;
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  const assets = new Map(manifest.assets.map((a) => [a.id, a]));
  const slots = slotMap(projectId);
  let total = 0;
  for (const file of walk(designDir)) {
    const rel = (assetId) => encodeURI(path.relative(path.dirname(file), projectPath(projectId, assets.get(assetId).file)).split(path.sep).join('/'));
    const urlFor = (id) => (assets.has(id) ? rel(id) : null);
    const logo = manifest.logo && assets.has(manifest.logo) ? rel(manifest.logo) : null;
    const { html, swapped } = swapImages(fs.readFileSync(file, 'utf8'), { slots, urlFor: (id) => urlFor(id) ?? placeholder(id), logoUrl: logo });
    if (swapped) fs.writeFileSync(file, html);
    total += swapped;
  }
  return total;
}
