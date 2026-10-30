// Stitch decides the shape of every picture frame after the creative director planned the collages. A wide collage in a
// tall frame would show only its middle photo, so every collage is rebuilt in the shape of the frame Stitch really drew
// (a row for wide frames, a stack for tall ones, a grid for square ones), from the same real photos.
// Safe to run again: it only rebuilds a collage whose shape no longer matches its frame.

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson, writeJson } from '../../lib/project.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { composeCollage, bestLayout } from '../../lib/collage.js';
import { frameAspect } from '../../lib/frames.js';
import { log } from '../../lib/log.js';
import { composeImages } from '../03-creative-director/compose.js';

const ratioOf = (aspect) => { const [w, h] = aspect.split(':').map(Number); return w / h; };
const orientationOf = (r) => (r > 1.2 ? 'landscape' : r < 0.85 ? 'portrait' : 'square');

function htmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? htmlFiles(full) : e.name.endsWith('.html') && e.name !== 'preview.html' ? [full] : [];
  });
}

// Returns the slot ids that were rebuilt.
export async function fitCollages(projectId) {
  if (!exists(projectId, 'design-spec.json') || !exists(projectId, 'asset-manifest.json')) return [];
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const collages = new Map(); // slot id -> combined asset
  for (const slot of design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots)))
    if (slot.recipe?.type === 'collage' && byId.get(slot.assignedAsset)?.derivedFrom?.length) collages.set(slot.id, byId.get(slot.assignedAsset));
  // scenes and composites are rebuilt for the real frame too (the set, the cut-outs and the props are cached, so this costs nothing)
  const regen = new Map(); // slot id -> the picture built for it
  for (const slot of design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots)))
    if (['scene', 'composite'].includes(slot.recipe?.type) && byId.get(slot.assignedAsset)?.width) regen.set(slot.id, byId.get(slot.assignedAsset));
  if (!collages.size && !regen.size) return [];

  const newAspect = new Map(); // slot id -> the frame shape Stitch drew
  const rebuilt = [];
  for (const file of htmlFiles(projectPath(projectId, 'design'))) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const alt = m[0].match(/\balt="([^"]*)"/i)?.[1];
      const generated = regen.get(alt);
      if (generated && !newAspect.has(alt)) {
        const shape = frameAspect(html, m.index);
        if (shape && Math.abs(ratioOf(shape) / (generated.width / generated.height) - 1) >= 0.12) newAspect.set(alt, shape);
      }
      const combo = collages.get(alt);
      if (!combo || rebuilt.includes(alt)) continue;
      const aspect = frameAspect(html, m.index);
      if (!aspect || Math.abs(ratioOf(aspect) / (combo.width / combo.height) - 1) < 0.12) continue; // no frame shape found, or it already fits
      const sources = combo.derivedFrom.map((id) => byId.get(id));
      const layout = bestLayout(sources.length, aspect);
      const { buffer, width, height } = await composeCollage({ files: sources.map((a) => projectPath(projectId, a.file)), layout, aspect, background: /^#[0-9a-f]{6}$/i.test(design.colors.background) ? design.colors.background : undefined });
      fs.writeFileSync(projectPath(projectId, combo.file), buffer);
      Object.assign(combo, { width, height, orientation: orientationOf(width / height) });
      rebuilt.push(alt);
      log.info('design', `the combined picture for ${alt} was rebuilt as a ${layout} to fit its ${aspect} frame`);
    }
  }
  if (rebuilt.length) writeJson(projectId, 'asset-manifest.json', manifest, assetManifestSchema);
  if (newAspect.size) {
    for (const slot of design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots))) if (newAspect.has(slot.id)) slot.aspect = newAspect.get(slot.id);
    await composeImages({ projectId, design, manifest, only: [...newAspect.keys()], background: /^#[0-9a-f]{6}$/i.test(design.colors.background) ? design.colors.background : undefined, palette: [design.colors.primary, design.colors.background] });
    writeJson(projectId, 'asset-manifest.json', manifest, assetManifestSchema);
    writeJson(projectId, 'design-spec.json', design, designSpecSchema);
    for (const [slot, shape] of newAspect) { rebuilt.push(slot); log.info('design', `the picture for ${slot} was rebuilt for its ${shape} frame`); }
  }
  return rebuilt;
}
