// Makes a product scene look PHOTOGRAPHED instead of pasted, without ever changing the product.
//
// The rough scene (the real product cut out of the customer's photo and placed on a generated, styled set) looks like a collage:
// flat, lit differently from the room, with no reflection. An image-editing model (FLUX.2 edit) can re-render it realistically, but it
// also redraws small print on the product (letters come out wrong), and the owner must never get a product with changed words.
// So the edited picture is used for EVERYTHING EXCEPT the product's own pixels:
//   1. the editing model gets the rough scene and the real product photo(s) and returns a realistic picture;
//   2. the product is found in that picture (scale and position are measured, not assumed);
//   3. the product's ORIGINAL pixels are put back there, with the room's light transferred onto them (only the slow
//      changes of brightness and colour, never the fine detail), keeping the edited picture's own edges, shadow and reflection;
//   4. a vision check makes sure nothing new appeared elsewhere (readable text, a logo, another product for sale).
// Any failure means the rough scene is used as it is: a plain pasted picture is better than a wrong product.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { askVision } from './llm.js';

export const EDIT_MODEL = 'fal-ai/flux-2/edit';
export const EDIT_PRICE_PER_MP = 0.012; // USD per megapixel (outputs and inputs), an estimate: fal.ai does not list this endpoint's price on its page
export const MIN_ALIGN_SCORE = 0.35;
// Editing is on whenever there is a key, unless IMAGE_EDITING=off (the tests switch it off so they never spend money).
export const editingAvailable = () => Boolean(config.falKey) && process.env.IMAGE_EDITING !== 'off' && process.env.IMAGE_GENERATION !== 'off';
const RELIGHT = { sigma: 14, limit: 28 };

const mp = (w, h) => (w * h) / 1e6;
const round64 = (v) => Math.max(512, Math.min(2048, Math.round(v / 64) * 64));

export function realizePrompt(count) {
  const many = count > 1;
  return [
    `Image 1 is a rough collage: ${many ? `${count} real products were` : 'a real product was'} pasted onto a styled table. ${many ? `The other images are the real photos of those products, in the same order.` : 'Image 2 is the real photo of that product.'}`,
    'Turn image 1 into ONE realistic professional photograph.',
    `Keep the table, every decoration piece, the backdrop and the whole layout exactly where they are, and keep ${many ? 'each product' : 'the product'} in the same place and about the same size.`,
    `Re-render ${many ? 'each product' : 'the product'} so it truly belongs in the scene: natural perspective and a slight angle, its base resting on the table, lit by the same light as the room (soft highlights on its edges, a natural shadow cast on the table, a faint reflection on the surface when the table is polished).`,
    `${many ? 'Each product' : 'The product'}'s design, colors, shape and ALL printed text must stay identical to its real photo: do not add, remove or change any letter, logo or number, and do not add any new product, packaging or text anywhere in the picture.`,
  ].join(' ');
}

// images: JPEG/PNG buffers (the rough scene first). Returns { buffer, width, height, cost }.
export async function editImage({ images, prompt, width, height, fetchImpl = fetch }) {
  if (!config.falKey) throw new Error('Editing pictures needs FAL_KEY in your .env file.');
  const uri = async (b) => `data:image/jpeg;base64,${(await sharp(b).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()).toString('base64')}`;
  const size = { width: round64(width), height: round64(height) };
  const res = await fetchImpl(`https://fal.run/${EDIT_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${config.falKey}` },
    body: JSON.stringify({ prompt, image_urls: await Promise.all(images.map(uri)), image_size: size, output_format: 'jpeg', guidance_scale: 3.5, num_images: 1, enable_safety_checker: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Picture editing failed (${res.status}): ${String(body.detail?.[0]?.msg ?? body.detail ?? body.error ?? 'no details').slice(0, 200)}`);
  if (body.has_nsfw_concepts?.[0]) throw new Error('The image model flagged its own picture, so it was not used.');
  const url = body.images?.[0]?.url;
  if (!url) throw new Error('The picture editor returned no picture.');
  const img = await fetchImpl(url);
  if (!img.ok) throw new Error(`The edited picture could not be downloaded (${img.status}).`);
  const inputMp = images.length * mp(1280, 960);
  return { buffer: Buffer.from(await img.arrayBuffer()), width: body.images[0].width ?? size.width, height: body.images[0].height ?? size.height, cost: Number((EDIT_PRICE_PER_MP * (mp(size.width, size.height) + inputMp)).toFixed(4)) };
}

// ---------- finding the product in the edited picture ----------

const gradient = (rgb, w, h, ch) => {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.3 * rgb[i * ch] + 0.59 * rgb[i * ch + 1] + 0.11 * rgb[i * ch + 2];
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) g[y * w + x] = Math.hypot(L[y * w + x + 1] - L[y * w + x - 1], L[(y + 1) * w + x] - L[(y - 1) * w + x]);
  return g;
};

// Where is the product in the edited picture? Searches scale and position around where it was pasted, comparing outlines and
// printed edges (at half size, to be fast). Returns { left, top, width, height, score } in full-size pixels.
export async function alignProduct({ edited, cutout, placement, range = 14, scales = [0.9, 0.93, 0.96, 0.98, 1, 1.02, 1.04, 1.07, 1.1] }) {
  const w2 = Math.floor(edited.width / 2); const h2 = Math.floor(edited.height / 2);
  const half = await sharp(edited.data, { raw: { width: edited.width, height: edited.height, channels: 3 } }).resize(w2, h2).raw().toBuffer();
  const gE = gradient(half, w2, h2, 3);
  let best = { score: -1 };
  for (const scale of scales) {
    const pw = Math.round(placement.width * scale); const ph = Math.round(placement.height * scale);
    const hw = Math.max(8, Math.round(pw / 2)); const hh = Math.max(8, Math.round(ph / 2));
    const small = await sharp(cutout).resize(hw, hh).ensureAlpha().raw().toBuffer();
    const gP = gradient(small, hw, hh, 4);
    const inside = []; for (let i = 0; i < hw * hh; i++) if (small[i * 4 + 3] > 128 && gP[i] > 0) inside.push(i);
    const baseX = Math.round((placement.left + placement.width / 2 - pw / 2) / 2); const baseY = Math.round((placement.top + placement.height - ph) / 2);
    for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
      let num = 0; let na = 0; let nb = 0;
      for (const i of inside) {
        const ex = baseX + dx + (i % hw); const ey = baseY + dy + Math.floor(i / hw);
        if (ex < 0 || ex >= w2 || ey < 0 || ey >= h2) continue;
        const a = gP[i]; const b = gE[ey * w2 + ex];
        num += a * b; na += a * a; nb += b * b;
      }
      const score = num / Math.sqrt(na * nb + 1);
      if (score > best.score) best = { score, left: (baseX + dx) * 2, top: (baseY + dy) * 2, width: pw, height: ph };
    }
  }
  return best;
}

// ---------- putting the real pixels back ----------

// edited: { data: raw RGB, width, height }. items: [{ cutout: PNG buffer, box: { left, top, width, height } }].
// Returns a JPEG buffer: the edited picture with each product's own pixels inside its box, relit to match.
export async function mergeProducts({ edited, items, quality = 93 }) {
  const { width: W, height: H } = edited;
  const out = Buffer.from(edited.data);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (const { cutout, box } of items) {
    const { width: pw, height: ph } = box;
    const prod = await sharp(cutout).resize(pw, ph).ensureAlpha().raw().toBuffer();
    const alpha = Buffer.alloc(pw * ph); for (let i = 0; i < pw * ph; i++) alpha[i] = prod[i * 4 + 3];
    // the silhouette shrinks about 2 px and softens: the edited picture keeps drawing the product's rim and its edge
    const mask = await sharp(alpha, { raw: { width: pw, height: ph, channels: 1 } }).blur(3).threshold(235).blur(1.5).toColourspace('b-w').raw().toBuffer();
    const left = clamp(box.left, 0, W - 1); const top = clamp(box.top, 0, H - 1);
    const cw = Math.min(pw, W - box.left); const ch = Math.min(ph, H - box.top);
    if (box.left < 0 || box.top < 0 || cw < 8 || ch < 8) continue;
    const win = await sharp(edited.data, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width: pw, height: ph }).raw().toBuffer().catch(() => null);
    if (!win) continue;
    // the slow changes of light: blurred edited product minus blurred original product, measured over the product only
    const premul = (src, c) => { const o = Buffer.alloc(pw * ph * 3); for (let i = 0; i < pw * ph; i++) for (let k = 0; k < 3; k++) o[i * 3 + k] = Math.round(src[i * c + k] * mask[i] / 255); return o; };
    const blurRaw = (b, c) => sharp(b, { raw: { width: pw, height: ph, channels: c } }).blur(RELIGHT.sigma).raw().toBuffer();
    const mB = await blurRaw(mask, 1); const eB = await blurRaw(premul(win, 3), 3); const pB = await blurRaw(premul(prod, 4), 3);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * pw + x; const a = mask[i] / 255; if (a <= 0) continue;
      const weight = Math.max(8, mB[i]) / 255;
      const o = ((top + y) * W + left + x) * 3;
      for (let k = 0; k < 3; k++) {
        const delta = clamp((eB[i * 3 + k] - pB[i * 3 + k]) / weight, -RELIGHT.limit, RELIGHT.limit);
        out[o + k] = Math.round(clamp(prod[i * 4 + k] + delta, 0, 255) * a + edited.data[o + k] * (1 - a));
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality }).toBuffer();
}

// ---------- the check ----------

const verifySchema = z.object({ hasText: z.boolean(), hasLogo: z.boolean(), hasOtherProducts: z.boolean(), note: z.string().default('') });

// Looks at the finished picture OUTSIDE the products (their boxes are given as fractions): nothing readable, no logo, no other product.
export async function verifyRealism({ projectId, buffer, boxes, width, height }) {
  const tmp = path.join(os.tmpdir(), `real-${process.pid}-${Date.now()}.jpg`);
  try {
    await sharp(buffer).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmp);
    const places = boxes.map((b) => `[left ${(b.left / width).toFixed(2)}, top ${(b.top / height).toFixed(2)}, right ${((b.left + b.width) / width).toFixed(2)}, bottom ${((b.top + b.height) / height).toFixed(2)}]`).join(' ');
    const seen = await askVision({
      projectId, stage: 'scene', system: 'You check a finished product photograph for things that must not be there. Answer with JSON only.', images: [{ path: tmp }], schema: verifySchema, maxTokens: 300,
      prompt: `This is a styled photo shoot with the real product(s) standing on the table at these places, as fractions of the picture ${places}. The product(s), their printed text and their reflection on the table are expected: IGNORE them completely. Look ONLY at everything else (the table, the decoration, the background). Answer { "hasText": true if any letters, words or numbers are readable anywhere else, "hasLogo": true if any logo or brand mark is visible anywhere else, "hasOtherProducts": true if you see any other product for sale (a perfume or cosmetic bottle or vial, a labeled jar or tube, a retail box or package) apart from the product(s) listed, "note": "short" }. A vase, candle, plain blank-cover books, flowers, a dish or a ribbon are decoration, not products.`,
    });
    return seen.hasText || seen.hasLogo || seen.hasOtherProducts ? `something new appeared in the picture (${seen.note || [seen.hasText && 'text', seen.hasLogo && 'a logo', seen.hasOtherProducts && 'another product'].filter(Boolean).join(', ')})` : '';
  } finally { fs.rmSync(tmp, { force: true }); }
}

// ---------- the whole step ----------

// rough: { buffer, width, height }. items: [{ cutout, placement: { left, top, width, height }, photo (Buffer of the real photo) }].
// cache: optional { read() -> { key, buffer, verified } | null, write({ key, buffer, verified }) } so a rebuild does not pay again.
// Returns { buffer, cost, spent: [{ model, cost, ms }], boxes } or throws (the caller keeps the rough picture).
export async function realizeScene({ projectId, rough, items, cache = null, deps = {} }) {
  const spent = [];
  try { return await realizeInner({ projectId, rough, items, cache, deps, spent }); } catch (e) { e.spent = spent; throw e; }
}

async function realizeInner({ projectId, rough, items, cache, deps, spent }) {
  const prompt = realizePrompt(items.length);
  const key = crypto.createHash('sha1').update(rough.buffer).update(prompt).update(String(items.length)).digest('hex').slice(0, 16);
  let edited; let editedJpeg; let verified = false;
  const hit = cache?.read();
  if (hit && hit.key === key) { editedJpeg = hit.buffer; edited = await sharp(hit.buffer).resize(rough.width, rough.height, { fit: 'fill' }).removeAlpha().raw().toBuffer(); verified = Boolean(hit.verified); }
  else {
    const started = Date.now();
    const out = await (deps.editImage ?? editImage)({ images: [rough.buffer, ...items.map((i) => i.photo)], prompt, width: rough.width, height: rough.height });
    spent.push({ model: 'flux-2-edit', cost: out.cost, ms: Date.now() - started });
    editedJpeg = out.buffer;
    edited = await sharp(out.buffer).resize(rough.width, rough.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    cache?.write({ key, buffer: out.buffer, verified: false });
  }
  const data = { data: edited, width: rough.width, height: rough.height };
  const boxes = [];
  for (const it of items) {
    const box = await alignProduct({ edited: data, cutout: it.cutout, placement: it.placement });
    if (box.score < MIN_ALIGN_SCORE) throw new Error(`the product could not be found in the edited picture (match ${box.score.toFixed(2)})`);
    boxes.push(box);
  }
  const buffer = await mergeProducts({ edited: data, items: items.map((it, i) => ({ cutout: it.cutout, box: boxes[i] })) });
  if (!verified) {
    const problem = await (deps.verifyRealism ?? verifyRealism)({ projectId, buffer, boxes, width: rough.width, height: rough.height });
    if (problem) throw new Error(problem);
    cache?.write({ key, buffer: editedJpeg, verified: true });
  }
  return { buffer, cost: spent.reduce((s, x) => s + x.cost, 0), spent, boxes };
}
