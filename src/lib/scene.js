// A photo-shoot style picture: a generated SET (surface, backdrop, light, props from the business's world) with the
// customer's REAL products standing on it. Three safeguards keep it honest:
//   1. a vision model checks the generated set: no products, no text, no logos, and where the table surface is
//   2. the real products are only cut out and placed (never redrawn): their pixels stay exactly as photographed
//   3. props in front of the products are raw materials and atmosphere (beans, petals, flour), never products
// The vision call is injectable so tests never touch the network.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { askVision } from './llm.js';
import { sizeFor } from './collage.js';
import { arrange } from './composite.js';

export const surfaceSchema = z.object({
  horizon: z.number().min(0).max(1),         // where the tabletop's far edge meets the background (0 = top, 1 = bottom)
  frontEdge: z.number().min(0).max(1).default(1), // where the tabletop ends at the front (a table edge, a drape); 1 when the surface runs to the bottom of the picture
  hasProducts: z.boolean().default(false),   // any product, bottle, box, package or branded object
  hasText: z.boolean().default(false),       // any readable text, letters or numbers
  hasLogo: z.boolean().default(false),
  note: z.string().default(''),
});

const SYSTEM = 'You inspect a generated still-life set before real products are placed on it. Answer with JSON only.';

export async function inspectSet({ projectId, buffer }) {
  const small = path.join(os.tmpdir(), `set-${process.pid}-${Date.now()}.jpg`);
  try {
    await sharp(buffer).resize({ width: 1100, height: 1100, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(small);
    return await askVision({
      projectId, stage: 'scene', system: SYSTEM, images: [{ path: small }], schema: surfaceSchema, maxTokens: 400,
      prompt: 'This picture should be a STYLED photo-shoot set: a table surface with a backdrop and tasteful decoration (flowers, vases, candles, plain books, trays, ceramic dishes, greenery, petals, wood, fabric, ribbon). Decoration is welcome and is NOT a problem. Answer { "horizon": the fraction of the picture height (0 top, 1 bottom) where the far edge of the table or surface meets the background, "frontEdge": the fraction where the flat top of the table ends at the front (where a table edge, apron or hanging cloth begins; 1 if the flat surface runs down to the bottom of the picture), "hasProducts": true ONLY if you see something that looks like a product for sale: a perfume or cosmetic bottle or vial, a labeled jar or tube, a retail box or package, a branded item (a vase, candle, plain book, dish or flowers are decoration, so false), "hasText": true if any letters, words or numbers are readable, "hasLogo": true if any logo or brand mark is visible, "note": "short" }.',
    });
  } finally {
    fs.rmSync(small, { force: true });
  }
}

// Is the generated set usable? Returns a reason when it is not.
export function setProblem(seen) {
  if (seen.hasProducts) return 'the generated set contains something that looks like a product for sale';
  if (seen.hasText || seen.hasLogo) return 'the generated set contains text or a logo';
  if (seen.horizon < 0.2 || seen.horizon > 0.8) return `the table surface is badly placed (horizon at ${Math.round(seen.horizon * 100)}%)`;
  if (seen.frontEdge - seen.horizon < 0.25) return 'the flat surface is too shallow to stand products on';
  return '';
}

// Places products ON the surface below the horizon, with depth: a back row (smaller, higher) and a front row.
// items: [{ width, height }]. Returns absolute placements in item order, each with the baseline its shadow belongs to.
export function arrangeOnSurface(items, W, H, horizon, frontEdge = 1) {
  const y0 = horizon * H;
  const depth = Math.max(H * 0.2, frontEdge * H - y0);
  const wide = W >= H * 1.2;
  const rows = items.length === 1 ? [[0]] : items.length === 2 || wide ? [items.map((_, i) => i)] : [[0, 1], [2]];
  const baselines = rows.length === 1 ? [y0 + depth * 0.62] : [y0 + depth * 0.36, y0 + depth * 0.82];
  const scales = rows.length === 1 ? [1] : [0.8, 1];
  const placements = new Array(items.length);
  rows.forEach((indexes, r) => {
    const base = baselines[r];
    const maxH = Math.min(H * (items.length === 1 ? 0.42 : items.length === 2 ? 0.38 : 0.32), base - H * 0.05) * scales[r];
    // one lineup: equal heights, shrunk together when too wide (arrange works inside a box of height maxH / 0.78)
    const box = arrange(indexes.map((i) => items[i]), W, maxH / 0.78, { maxWidth: 0.86, targetHeight: 0.78, gap: 0.04, baseline: 1 });
    indexes.forEach((itemIndex, k) => {
      const p = box.placements[k];
      placements[itemIndex] = { left: p.left, top: Math.round(base - p.height), width: p.width, height: p.height, baseline: Math.round(base) };
    });
  });
  return placements;
}

// A soft contact shadow under a product, wider than it is tall.
async function shadow(width, height, opacity = 0.34) {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(6, Math.round(height));
  const pad = Math.round(h * 1.4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + pad * 2}" height="${h + pad * 2}"><ellipse cx="${(w + pad * 2) / 2}" cy="${(h + pad * 2) / 2}" rx="${w / 2}" ry="${h / 2}" fill="rgba(35,22,12,${opacity})"/></svg>`;
  return { buffer: await sharp(Buffer.from(svg)).blur(Math.max(2, h * 0.5)).png().toBuffer(), pad };
}

// Exposure and warmth that suit a set, read from the picture itself (so a dark moody set darkens the products a little)
export async function lookOf(buffer) {
  const { channels } = await sharp(buffer).resize(64, 64, { fit: 'cover' }).stats();
  const mean = (channels[0].mean + channels[1].mean + channels[2].mean) / 3;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return { brightness: clamp(mean / 150, 0.8, 1.05), warm: clamp(1 + (channels[0].mean / Math.max(1, channels[2].mean) - 1) * 0.15, 0.96, 1.08) };
}

// Light and warmth of the set applied to the product (exposure and warmth only: its own colors and details stay).
// `look`: { brightness, warm } where warm > 1 is warmer, < 1 cooler.
export async function gradeProduct(png, { brightness = 1, warm = 1 } = {}) {
  return sharp(png).modulate({ brightness }).recomb([[warm, 0, 0], [0, 1, 0], [0, 0, 2 - warm]]).png().toBuffer();
}

// background: the generated set (Buffer). cutouts: [{ buffer, width, height }]. props: a cut-out of loose raw material
// ({ buffer, width, height }) placed in FRONT of the products along the bottom, or null.
export async function composeScene(options) {
  let { background, horizon, frontEdge = 1 } = options;
  const { cutouts, aspect = '4:5', props = null, look = {}, propSpots = null } = options;
  // props: where they lie. x = fraction of the width; y = fraction of the way from the horizon to the front edge of the surface
  const { width: W, height: H } = sizeFor(aspect);
  // Below the front edge of the table there is only hanging cloth or floor. The set is zoomed to its useful part (the same
  // frame shape, centered), so the products stand in the middle of the picture and keep the sharpness they were placed with.
  const keep = Math.min(1, frontEdge + 0.04);
  if (keep < 0.92) {
    const meta = await sharp(background).metadata();
    const w = Math.round(meta.width * keep);
    const h = Math.round(meta.height * keep);
    background = await sharp(background).extract({ left: Math.round((meta.width - w) / 2), top: 0, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
    horizon /= keep;
    frontEdge = Math.min(0.98, frontEdge / keep);
  }
  let canvas = await sharp(background).resize(W, H, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
  const items = [];
  for (const c of cutouts) items.push({ ...c, buffer: await gradeProduct(c.buffer, look) });
  const placed = items.length ? arrangeOnSurface(items, W, H, horizon, frontEdge) : [];
  const layers = [];
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    // two shadows ground the product on the table: a wide soft one (the light falling off) and a narrow dark one right at its base
    for (const [wide, high, opacity, dy] of [[1.2, 0.06, 0.3, 0.004], [0.97, 0.022, 0.6, -0.001]]) {
      const sh = await shadow(p.width * wide, H * high, opacity);
      layers.push({ input: sh.buffer, left: Math.round(p.left + p.width / 2 - (p.width * wide) / 2 - sh.pad), top: Math.round(p.baseline + H * dy - (H * high) / 2 - sh.pad) });
    }
  }
  for (let i = 0; i < placed.length; i++)
    layers.push({ input: await sharp(items[i].buffer).resize(placed[i].width, placed[i].height).png().toBuffer(), left: placed[i].left, top: placed[i].top });
  if (props) {
    const pw = Math.round(W * 0.2);
    const ph = Math.round(pw * props.height / props.width);
    const spots = propSpots ?? (items.length ? [[0.02, 0.9], [0.72, 0.95]] : [[0.05, 0.7], [0.66, 0.74]]);
    const front = frontEdge * H;
    const back = horizon * H;
    let k = 0;
    for (const [fx, fy] of spots) {
      // every spot gets the scatter mirrored, turned and sized differently, so the props do not look like copies
      let shaped = sharp(props.buffer);
      if (k % 2) shaped = shaped.flop();
      const sw = Math.round(pw * (k % 2 ? 1.15 : 0.9));
      const sh = Math.max(4, Math.round(sw * props.height / props.width));
      const piece = await shaped.resize(sw, sh).rotate([-12, 16, 4][k % 3], { background: { r: 0, g: 0, b: 0, alpha: 0 } }).modulate({ brightness: look.brightness ?? 1 }).png().toBuffer();
      k++;
      const meta = await sharp(piece).metadata();
      const bottom = Math.min(front - 2, back + (front - back) * fy);
      layers.push({ input: piece, left: Math.max(0, Math.min(W - meta.width, Math.round(W * fx))), top: Math.max(0, Math.round(bottom - meta.height * 0.85)) });
    }
  }
  canvas = await sharp(canvas).composite(layers).jpeg({ quality: 90 }).toBuffer();
  return { buffer: canvas, width: W, height: H, placements: placed };
}
