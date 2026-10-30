// Before the creative director plans anything: photos that carry a slideshow counter, watermark or badge (Stage 2 notes say so)
// are cleaned by cropping the overlay away, so the real photo can be used everywhere (cards, crops, collages) without it.
// The cleaned copy goes to inputs/cleaned/; the original stays untouched and is remembered as originalFile.

import { projectPath } from '../../lib/project.js';
import { cleanPhoto } from '../../lib/overlays.js';
import { hasOverlay } from './compose.js';
import { log } from '../../lib/log.js';

const orientationOf = (w, h) => (w / h > 1.2 ? 'landscape' : w / h < 0.85 ? 'portrait' : 'square');

// Mutates the manifest. Returns { cleaned: [ids], left: [{id, reason}] }. `find` is replaced in tests.
export async function cleanOverlays({ projectId, manifest, find }) {
  const result = { cleaned: [], left: [] };
  for (const asset of manifest.assets) {
    if (asset.kind !== 'image' || asset.derivedFrom || asset.origin || !hasOverlay(asset)) continue;
    try {
      const out = `inputs/cleaned/${asset.id}.jpg`;
      const done = await cleanPhoto({ projectId, file: projectPath(projectId, asset.originalFile ?? asset.file), out: projectPath(projectId, out), find });
      if (!done.cleaned) { result.left.push({ id: asset.id, reason: done.reason }); continue; }
      asset.originalFile ??= asset.file;
      Object.assign(asset, { file: out, overlayRemoved: true, width: done.width, height: done.height, orientation: orientationOf(done.width, done.height) });
      result.cleaned.push(asset.id);
    } catch (e) {
      result.left.push({ id: asset.id, reason: e.message });
    }
  }
  for (const id of result.cleaned) log.info('direct', `removed the counter/watermark from ${id} by cropping it away`);
  for (const l of result.left) log.info('direct', `warning: ${l.id} still has an overlay (${l.reason})`);
  return result;
}
