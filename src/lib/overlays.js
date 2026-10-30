// Removes slideshow counters ("2/3"), watermarks, app badges and stickers that are drawn ON a customer photo.
// A vision model finds them; code then cuts the thinnest edge strip that takes each one out of the picture. Nothing is
// painted over or invented: the photo is only cropped. When an overlay sits too far inside the photo to crop away
// (more than a quarter of the picture would be lost), the photo is left alone and reported.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { askVision } from './llm.js';

const frac = z.number().min(0).max(1);
export const overlaySchema = z.object({ overlays: z.array(z.object({ x: frac, y: frac, width: frac, height: frac })).default([]), note: z.string().default('') });

const SYSTEM = `You find text and graphics that were added ON TOP of a photo: slideshow counters like "1/3", watermarks, app badges, stickers, captions, usernames, icons from an app.
Answer with JSON only. Coordinates are fractions of the picture: x and y are the top-left corner, width and height the size (0 to 1).
Do NOT include text that is part of the scene itself (product labels, signs, packaging). If there is nothing added on top, return an empty list.`;

// The crop that removes every overlay, or null when that would cost too much.
// overlays: [{ x, y, width, height }] as fractions. maxLoss: the largest share of the picture that may be cut away.
export function cropAwayOverlays(overlays, { maxLoss = 0.25, margin = 0.012 } = {}) {
  if (!overlays.length) return { top: 0, bottom: 0, left: 0, right: 0, loss: 0 };
  const cut = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const o of overlays) {
    const options = {
      top: Math.min(1, o.y + o.height + margin), // cut the strip above the overlay's lower edge
      bottom: Math.min(1, 1 - o.y + margin),
      left: Math.min(1, o.x + o.width + margin),
      right: Math.min(1, 1 - o.x + margin),
    };
    const [side, amount] = Object.entries(options).sort((a, b) => a[1] - b[1])[0];
    cut[side] = Math.max(cut[side], amount);
  }
  const keptW = 1 - cut.left - cut.right;
  const keptH = 1 - cut.top - cut.bottom;
  const loss = 1 - keptW * keptH;
  if (keptW <= 0.3 || keptH <= 0.3 || loss > maxLoss) return null;
  return { ...cut, loss };
}

export async function findOverlays({ projectId, file }) {
  const small = path.join(os.tmpdir(), `overlay-${process.pid}-${Date.now()}.jpg`);
  try {
    await sharp(file).rotate().resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(small);
    return await askVision({
      projectId, stage: 'overlays', system: SYSTEM, images: [{ path: small }], schema: overlaySchema, maxTokens: 500,
      prompt: 'List every slideshow counter, watermark, badge, sticker or caption drawn on top of this photo. Return { "overlays": [ { "x": 0, "y": 0, "width": 0, "height": 0 } ], "note": "" }.',
    });
  } finally {
    fs.rmSync(small, { force: true });
  }
}

// Writes the cleaned photo to `out` and returns { cleaned, loss } or { cleaned: false, reason }. `find` is replaced in tests.
export async function cleanPhoto({ projectId, file, out, find = findOverlays }) {
  const { overlays } = await find({ projectId, file });
  if (!overlays.length) return { cleaned: false, reason: 'no overlay found' };
  const cut = cropAwayOverlays(overlays);
  if (!cut) return { cleaned: false, reason: 'the overlay is too far inside the photo to crop away' };
  const meta = await sharp(file).rotate().metadata();
  const left = Math.round(cut.left * meta.width);
  const top = Math.round(cut.top * meta.height);
  const width = Math.round((1 - cut.left - cut.right) * meta.width);
  const height = Math.round((1 - cut.top - cut.bottom) * meta.height);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(file).rotate().extract({ left, top, width, height }).jpeg({ quality: 92 }).toFile(out);
  return { cleaned: true, loss: cut.loss, width, height };
}
