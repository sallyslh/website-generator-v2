// Places several REAL product cut-outs together on one background, with soft contact shadows.
// The products are the customer's own pixels, scaled but never redrawn or changed; only the background and the arrangement are new.

import sharp from 'sharp';
import { sizeFor } from './collage.js';

// Where each cut-out goes: one row like a product lineup. Every product gets the same height (photos have different
// scales, so their real pixel sizes mean nothing), bottoms on a common baseline, the row centered; when the row is too
// wide everything shrinks together. items: [{ width, height }]. Returns { placements: [{ left, top, width, height }], baseline }.
export function arrange(items, W, H, { maxWidth = 0.84, targetHeight = 0.6, gap = 0.04, baseline = 0.84 } = {}) {
  const gapPx = W * gap;
  const heights = H * targetHeight;
  const widthAtTarget = items.reduce((s, i) => s + (i.width / i.height) * heights, 0);
  const fit = Math.min(1, (W * maxWidth - gapPx * (items.length - 1)) / widthAtTarget);
  const scale = fit;
  const sized = items.map((i) => ({ width: Math.round((i.width / i.height) * heights * scale), height: Math.round(heights * scale) }));
  const rowW = sized.reduce((s, i) => s + i.width, 0) + gapPx * (items.length - 1);
  let x = (W - rowW) / 2;
  const base = Math.round(H * baseline);
  const placements = sized.map((s) => { const p = { left: Math.round(x), top: base - s.height, width: s.width, height: s.height }; x += s.width + gapPx; return p; });
  return { placements, baseline: base, scale };
}

// A tall frame cannot hold a wide lineup, so the products go into two rows (a lone product on top, the rest below it).
// Every row is a lineup of its own with its own baseline. Returns placements in the same order as the items.
export function arrangeRows(items, W, H) {
  const rows = items.length === 2 ? [[0], [1]] : [[0, 1], [2]];
  const rowH = H * 0.46;
  const placements = new Array(items.length);
  rows.forEach((indexes, r) => {
    const { placements: local } = arrange(indexes.map((i) => items[i]), W, rowH, { maxWidth: 0.88, targetHeight: 0.78, gap: 0.04, baseline: 0.9 });
    const offset = H * 0.04 + r * rowH + (r === 1 ? H * 0.02 : 0);
    indexes.forEach((itemIndex, k) => { placements[itemIndex] = { ...local[k], top: Math.round(local[k].top + offset) }; });
  });
  return placements;
}

// A soft elliptical contact shadow as a PNG.
async function shadow(width, height, opacity = 0.3) {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(6, Math.round(height));
  const pad = Math.round(h * 1.2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + pad * 2}" height="${h + pad * 2}"><ellipse cx="${(w + pad * 2) / 2}" cy="${(h + pad * 2) / 2}" rx="${w / 2}" ry="${h / 2}" fill="rgba(40,25,15,${opacity})"/></svg>`;
  return { buffer: await sharp(Buffer.from(svg)).blur(Math.max(2, h * 0.45)).png().toBuffer(), pad };
}

// background: a Buffer (a picture, scaled to cover) or a hex color (a very soft top-to-bottom gradient).
// cutouts: [{ buffer (PNG with transparency), width, height }]. Returns { buffer (JPEG), width, height }.
export async function composeProducts({ cutouts, background = '#f4efe6', aspect = '4:3' }) {
  if (cutouts.length < 2) throw new Error('A composite needs at least 2 products.');
  const { width: W, height: H } = sizeFor(aspect);
  let base;
  if (Buffer.isBuffer(background)) base = await sharp(background).resize(W, H, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
  else {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${background}"/><stop offset="1" stop-color="${background}" stop-opacity="0.86"/></linearGradient></defs><rect width="100%" height="100%" fill="#ffffff"/><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    base = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  }
  const placements = H > W * 1.05 && cutouts.length <= 3 ? arrangeRows(cutouts, W, H) : arrange(cutouts, W, H).placements;
  const layers = [];
  for (const p of placements) {
    const sh = await shadow(p.width * 0.92, H * 0.045);
    layers.push({ input: sh.buffer, left: Math.round(p.left + p.width * 0.04 - sh.pad), top: Math.round(p.top + p.height - H * 0.045 / 2 - sh.pad) });
  }
  for (let i = 0; i < cutouts.length; i++)
    layers.push({ input: await sharp(cutouts[i].buffer).resize(placements[i].width, placements[i].height).png().toBuffer(), left: placements[i].left, top: placements[i].top });
  return { buffer: await sharp(base).composite(layers).jpeg({ quality: 90 }).toBuffer(), width: W, height: H };
}
