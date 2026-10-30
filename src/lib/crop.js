// Cuts ONE real item (for example "Bleu de Chanel") out of a group photo. A vision model finds where the item is and where
// any slideshow counter / watermark / badge is; code then crops, and refuses a crop that would show an overlay or that is too small.
// Nothing is drawn or changed: the crop is a rectangle of the customer's own photo.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { askVision } from './llm.js';

const frac = z.number().min(0).max(1);
const boxSchema = z.object({ x: frac, y: frac, width: frac, height: frac });
export const locateSchema = z.object({
  found: z.boolean(),
  box: boxSchema.optional(),      // the item, as fractions of the picture (x, y = top left corner)
  overlays: z.array(boxSchema).default([]), // slideshow counters, watermarks, badges, stickers
  note: z.string().default(''),
});

export const LOCATE_SYSTEM = `You locate ONE named item in a photo so it can be cropped out. Answer with JSON only.
Coordinates are fractions of the picture: x and y are the top-left corner, width and height the size, all between 0 and 1.
- "found": true only if the item is clearly visible and complete enough to be a picture of its own. If you are not sure it is the item, answer found false.
- "box": a tight rectangle around the item (the whole item, not parts of its neighbours). Do not include other products in the box when you can avoid it.
- "overlays": a rectangle for every slideshow counter (like "2/3"), watermark, sticker, app badge or caption drawn ON the photo. Empty list if none.
Never invent: if the item is not there, found is false.`;

const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// A crop hugging the item (a little air around it), in the shape of the frame it will fill when that needs little extra.
// Stretching a narrow item to a wide frame would pull its neighbours into the picture, so when the frame shape needs more
// than `maxGrow` times the item's own width or height, the crop keeps the item's natural shape (clamped) and the layout's
// object-fit does the rest. Always kept inside the photo.
export function fitBoxToAspect(box, imgW, imgH, aspect, { pad = 0.02, maxGrow = 1.3 } = {}) {
  const [aw, ah] = String(aspect || '1:1').split(':').map(Number);
  const target = aw > 0 && ah > 0 ? aw / ah : 1;
  let w = box.width * imgW * (1 + pad * 2);
  let h = box.height * imgH * (1 + pad * 2);
  const [w0, h0] = [w, h];
  if (w / h < target) w = h * target; else h = w / target;
  if (w / w0 > maxGrow || h / h0 > maxGrow) {
    [w, h] = [w0, h0];
    if (w / h < 0.6) w = Math.min(h * 0.6, w0 * maxGrow); else if (w / h > 1.7) h = Math.min(w / 1.7, h0 * maxGrow);
  }
  w = Math.min(w, imgW); h = Math.min(h, imgH);
  const cx = (box.x + box.width / 2) * imgW;
  const cy = (box.y + box.height / 2) * imgH;
  const left = Math.min(Math.max(0, cx - w / 2), imgW - w);
  const top = Math.min(Math.max(0, cy - h / 2), imgH - h);
  return { left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) };
}

// Decides if the crop may be used. Returns a reason when it may not.
export function cropProblem(located, region, imgW, imgH, minSide = 400) {
  if (!located.found || !located.box) return 'the item was not found in the photo';
  if (region.width < minSide * 0.6 || region.height < minSide * 0.6) return `the item is too small in the photo (a ${region.width}x${region.height} crop would look blurry)`;
  const rect = { x: region.left / imgW, y: region.top / imgH, width: region.width / imgW, height: region.height / imgH };
  if (located.overlays.some((o) => intersects(rect, o))) return 'the crop would include a counter, watermark or badge from the photo';
  return '';
}

// file: absolute path of the real photo. Returns { buffer, width, height, region } or { problem }.
export async function cropItem({ projectId, file, target, aspect = '1:1', locate = locateWithVision, verify = verifyWithVision }) {
  const meta = await sharp(file).rotate().metadata();
  const [imgW, imgH] = [meta.width, meta.height];
  const located = await locate({ projectId, file, target });
  if (!located.found || !located.box) return { problem: cropProblem(located, {}, imgW, imgH) };
  const region = fitBoxToAspect(located.box, imgW, imgH, aspect);
  const problem = cropProblem(located, region, imgW, imgH);
  if (problem) return { problem };
  const buffer = await sharp(file).rotate().extract(region).jpeg({ quality: 90 }).toBuffer();
  // a second look at the finished crop: is it really only this item?
  const seen = await verify({ projectId, buffer, target });
  if (!seen.mainSubjectIsTarget) return { problem: `the crop does not clearly show "${target}" (${seen.note || 'wrong subject'})` };
  if (seen.otherWholeProductsVisible > 0) return { problem: `the crop also shows ${seen.otherWholeProductsVisible} other whole product(s), so it is not a picture of "${target}" alone` };
  return { buffer, width: region.width, height: region.height, region };
}

export const verifySchema = z.object({ mainSubjectIsTarget: z.boolean(), otherWholeProductsVisible: z.number().int().min(0).default(0), note: z.string().default('') });

// Two crops of the same photo must show different things.
export function overlapRatio(a, b) {
  if (![a?.width, a?.height, b?.width, b?.height].every(Number.isFinite)) return 0;
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

export async function verifyWithVision({ projectId, buffer, target }) {
  const small = path.join(os.tmpdir(), `verify-${process.pid}-${Date.now()}.jpg`);
  try {
    await sharp(buffer).resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(small);
    return await askVision({
      projectId, stage: 'crop', images: [{ path: small }], schema: verifySchema, maxTokens: 300,
      system: 'You check a cropped product picture. Answer with JSON only.',
      prompt: `This picture is meant to show ONE item: "${target}". Answer { "mainSubjectIsTarget": true if that item is the clear main subject, "otherWholeProductsVisible": the number of OTHER complete products you can see (products cut off by the picture edge do not count), "note": "short reason" }.`,
    });
  } finally {
    fs.rmSync(small, { force: true });
  }
}

// The vision call. The photo is shrunk first (phone photos can be larger than the model accepts).
export async function locateWithVision({ projectId, file, target }) {
  const small = path.join(os.tmpdir(), `locate-${process.pid}-${Date.now()}.jpg`);
  try {
    await sharp(file).rotate().resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(small);
    return await askVision({
      projectId, stage: 'crop', system: LOCATE_SYSTEM, images: [{ path: small }], schema: locateSchema, maxTokens: 600,
      prompt: `Locate this item: "${target}". Return { "found": true|false, "box": { "x": 0, "y": 0, "width": 0, "height": 0 }, "overlays": [ { "x": 0, "y": 0, "width": 0, "height": 0 } ], "note": "" }.`,
    });
  } finally {
    fs.rmSync(small, { force: true });
  }
}
