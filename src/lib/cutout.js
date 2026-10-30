// Cuts a real product out of its photo (background removed, transparent PNG) so several real products can be placed together.
// The product's pixels are never redrawn: only the background is taken away (BiRefNet on fal.ai). The network call is injectable.

import sharp from 'sharp';
import { config } from '../config.js';

export const CUTOUT_MODEL = 'fal-ai/birefnet/v2';
export const CUTOUT_COST = 0.01; // USD per picture, an estimate (fal.ai bills this model per second of compute)

// How much of the photo's own border the product touches (0 to 1). A product that touches the border is cut off by the
// photo's frame (half a bottle, a neighbour's slice), so it cannot be placed in a new picture as a whole product.
// The BOTTOM edge can be ignored: a product stands on its base, and a photo taken close to the table ends exactly there (a box whose
// base touches the bottom of the photo is still a whole box). Top, left and right contact always means it is cut off.
export function edgeRatio(data, width, height, ring = 2, threshold = 128, ignoreBottom = false) {
  let touching = 0;
  let total = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      if (ignoreBottom && y >= height - ring && x >= ring && x < width - ring) continue; // the bottom strip itself (not its corners)
      total++;
      if (data[(y * width + x) * 4 + 3] > threshold) touching++;
    }
  return total ? touching / total : 0;
}

export const CUT_OFF_LIMIT = 0.03;

// A photo of several products (four boxes in a row) is often cut by the frame at its sides while the ones in the middle are whole.
// Instead of refusing the whole photo, the products that stand free (not touching the top, left or right edge) are kept and the
// cut ones are dropped. A product is never completed or redrawn: only whole ones are used. Returns null when none is whole.
export async function wholeParts(png, { threshold = 128, ring = 2, minShare = 0.02, accept = null } = {}) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  const solid = new Uint8Array(n); for (let i = 0; i < n; i++) solid[i] = data[i * 4 + 3] > threshold ? 1 : 0;
  // 1. products that touch each other (boxes standing shoulder to shoulder) are pulled apart by shrinking the shape a few pixels
  const r = Math.max(2, Math.round(Math.min(w, h) / 200));
  const eroded = erode(solid, w, h, r);
  // 2. every separate piece of the shrunken shape is one product; the ones touching the top, left or right edge are cut by the photo
  const label = new Int32Array(n); const parts = []; const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] || !eroded[start]) continue;
    const id = parts.length + 1;
    const part = { id, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, touches: false };
    let top = 0; stack[top++] = start; label[start] = id;
    while (top) {
      const p = stack[--top]; const x = p % w; const y = (p - x) / w;
      part.area++;
      if (x < part.minX) part.minX = x; if (x > part.maxX) part.maxX = x; if (y < part.minY) part.minY = y; if (y > part.maxY) part.maxY = y;
      if (x > 0 && !label[p - 1] && eroded[p - 1]) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && !label[p + 1] && eroded[p + 1]) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && !label[p - w] && eroded[p - w]) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && !label[p + w] && eroded[p + w]) { label[p + w] = id; stack[top++] = p + w; }
    }
    // a shape that reached the border keeps a margin of exactly r after shrinking; the bottom edge is where a product stands
    part.edges = [part.minX < r + ring && 'left', part.maxX > w - 1 - r - ring && 'right', part.minY < r + ring && 'top'].filter(Boolean);
    part.touches = part.edges.length > 0;
    parts.push(part);
  }
  const candidates = parts.filter((p) => p.area >= w * h * minShare * 0.5);
  if (!candidates.length) return null;
  // 3. grow every piece (the cut ones too, so they claim their own territory) back to the real outline
  const owner = new Int32Array(n); const queue = new Int32Array(n); let head = 0; let tail = 0;
  for (let i = 0; i < n; i++) if (label[i]) { owner[i] = label[i]; queue[tail++] = i; }
  for (let step = 0; step < r + 3 && head < tail; step++) {
    const end = tail;
    for (; head < end; head++) {
      const p = queue[head]; const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1]) if (q >= 0 && solid[q] && !owner[q]) { owner[q] = owner[p]; queue[tail++] = q; }
    }
  }
  // 4. products that stand free are whole. One that touches an edge is judged (when a judge is given): flush with the frame and
  //    fully readable is fine, a sliced word or a missing side is not
  const keep = [];
  for (const p of candidates) {
    if (!p.touches) { keep.push(p); continue; }
    if (!accept) continue;
    const mask = Buffer.alloc(n); for (let i = 0; i < n; i++) mask[i] = owner[i] === p.id && solid[i] ? 255 : 0;
    const width = p.maxX - p.minX + 1; const height = p.maxY - p.minY + 1;
    const rgb = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).removeAlpha().extract({ left: p.minX, top: p.minY, width, height }).raw().toBuffer();
    const m = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).extract({ left: p.minX, top: p.minY, width, height }).raw().toBuffer();
    const shown = await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(m, { raw: { width, height, channels: 1 } }).flatten({ background: '#9a9a9a' }).jpeg({ quality: 85 }).toBuffer();
    if (await accept({ edges: p.edges, picture: shown })) keep.push(p);
  }
  if (!keep.length) return null;
  const ids = new Set(keep.map((p) => p.id));
  const out = Buffer.from(data);
  let [minX, minY, maxX, maxY] = [w, h, -1, -1];
  for (let i = 0; i < n; i++) {
    if (ids.has(owner[i]) && solid[i]) { const x = i % w; const y = (i - x) / w; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    else out[i * 4 + 3] = 0; // everything that is not a whole product disappears
  }
  if (maxX < 0 || (maxX - minX + 1) * (maxY - minY + 1) < n * minShare) return null;
  const buffer = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }).png().toBuffer();
  return { buffer, width: maxX - minX + 1, height: maxY - minY + 1, cutOff: false, partial: true, whole: keep.length, dropped: parts.length - keep.length };
}

// Shrinks a 0/1 mask by r pixels on every side (the picture's border counts as empty), in two passes.
function erode(mask, w, h, r) {
  const tmp = new Uint8Array(w * h); const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { let run = 0; for (let x = 0; x < w; x++) { run = mask[y * w + x] ? run + 1 : 0; tmp[y * w + x] = run >= r + 1 ? 1 : 0; } } // ones to the left, including this pixel
  const left = tmp; const right = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { let run = 0; for (let x = w - 1; x >= 0; x--) { run = mask[y * w + x] ? run + 1 : 0; right[y * w + x] = run >= r + 1 ? 1 : 0; } }
  const row = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) row[i] = left[i] && right[i] ? 1 : 0; // r ones on both sides
  for (let x = 0; x < w; x++) {
    let run = 0; const up = new Uint8Array(h);
    for (let y = 0; y < h; y++) { run = row[y * w + x] ? run + 1 : 0; up[y] = run >= r + 1 ? 1 : 0; }
    run = 0;
    for (let y = h - 1; y >= 0; y--) { run = row[y * w + x] ? run + 1 : 0; out[y * w + x] = up[y] && run >= r + 1 ? 1 : 0; }
  }
  return out;
}

// The bounding box of everything that is not transparent, so the cut-out has no empty border.
export async function trimToAlpha(png, threshold = 16, accept = null) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const edge = edgeRatio(data, info.width, info.height, 2, 128, true);
  let [minX, minY, maxX, maxY] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3] > threshold) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) throw new Error('nothing was left after removing the background');
  if (edge > CUT_OFF_LIMIT) { const whole = await wholeParts(png, { accept }); if (whole) return { ...whole, edgeRatio: edge }; } // some products in the photo are whole
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const buffer = await sharp(png).ensureAlpha().extract({ left: minX, top: minY, width, height }).png().toBuffer();
  return { buffer, width, height, edgeRatio: edge, cutOff: edge > CUT_OFF_LIMIT };
}

// file: path of the real photo. Returns { buffer (PNG with transparency), width, height, cost }.
export async function removeBackground({ file, fetchImpl = fetch, accept = null }) {
  if (!config.falKey) throw new Error('Cutting products out needs FAL_KEY in your .env file.');
  const jpeg = await sharp(file).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const res = await fetchImpl(`https://fal.run/${CUTOUT_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${config.falKey}` },
    body: JSON.stringify({ image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, output_format: 'png', refine_foreground: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Background removal failed (${res.status}): ${String(body.detail?.[0]?.msg ?? body.detail ?? body.error ?? 'no details').slice(0, 200)}`);
  const url = body.image?.url;
  if (!url) throw new Error('The background removal returned no picture.');
  const img = await fetchImpl(url);
  if (!img.ok) throw new Error(`The cut-out could not be downloaded (${img.status}).`);
  const trimmed = await trimToAlpha(Buffer.from(await img.arrayBuffer()), 16, accept);
  return { ...trimmed, cost: CUTOUT_COST };
}
