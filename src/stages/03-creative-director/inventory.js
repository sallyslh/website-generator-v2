// The image inventory: what the customer's photos really are, counted by code before the creative director plans anything.
// The director gets this as facts (not guesses) so the design is based on what exists.

import { hasOverlay } from './compose.js';
import { aspectOf } from '../05-design-stitch/prompts.js';
import { generationAvailable, MAX_ATMOSPHERE_PER_SITE } from '../../lib/imageGen.js';

const GROUP = /\b(two|three|four|five|six|several|row|side by side|pair|set of|multiple|many)\b/i;

export function inventory(manifest, brief) {
  const photos = manifest.assets.filter((a) => a.kind !== 'logo' && !a.derivedFrom && !a.origin);
  const usable = photos.filter((a) => a.quality !== 'low');
  const named = new Map(); // asset id -> product names the customer confirmed for that photo
  for (const o of brief.offerings) if (o.assetId) named.set(o.assetId, [...(named.get(o.assetId) ?? []), o.name]);
  const rows = usable.map((a) => ({
    id: a.id, category: a.category, orientation: a.orientation, shape: aspectOf(a.width, a.height), quality: a.quality,
    overlay: hasOverlay(a), group: GROUP.test(a.description), shows: a.description.slice(0, 170), products: named.get(a.id) ?? [],
  }));
  return {
    total: photos.length, usable: usable.length, low: photos.length - usable.length, rows,
    portrait: rows.filter((r) => r.orientation === 'portrait').length, landscape: rows.filter((r) => r.orientation === 'landscape').length, square: rows.filter((r) => r.orientation === 'square').length,
    overlays: rows.filter((r) => r.overlay).length, groups: rows.filter((r) => r.group).length, hasLogo: Boolean(manifest.logo),
    generation: generationAvailable() && brief.wishes?.aiPictures !== 'photos-only',
    photosOnly: brief.wishes?.aiPictures === 'photos-only',
  };
}

// The text block put into the creative director's prompt.
export function inventoryText(inv) {
  const lines = [
    `IMAGE INVENTORY (counted by code, these are facts):`,
    `- ${inv.usable} usable photos (${inv.portrait} portrait, ${inv.landscape} landscape, ${inv.square} square)${inv.low ? `; ${inv.low} more are too low quality to use` : ''}; logo: ${inv.hasLogo ? 'yes' : 'no'}.`,
    `- ${inv.groups} photo(s) look like group shots that show several items; ${inv.overlays} photo(s) have a counter, watermark or badge drawn on them.`,
    `- Generated atmosphere pictures: ${inv.generation ? `AVAILABLE (at most ${MAX_ATMOSPHERE_PER_SITE} on the whole site, the customer must approve each)` : inv.photosOnly ? 'NOT allowed: the owner asked for ONLY their own photos. Plan no scene, atmosphere or composite.' : 'NOT available right now. Do not plan any atmosphere slot.'}`,
    'Photos:',
    ...inv.rows.map((r) => `  ${r.id}: ${r.category}, ${r.orientation} (shape ${r.shape}), ${r.quality}${r.group ? ', GROUP' : ''}${r.overlay ? ', HAS OVERLAY' : ''}${r.products.length ? `, products confirmed by the owner: ${r.products.join('; ')}` : ''} | ${r.shows}`),
  ];
  return lines.join('\n');
}
