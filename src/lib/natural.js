// "Natural" photo shoots: the customer's own product photo(s) go to the image-editing model (FLUX.2 edit) together with a plain
// description, and the model makes the whole photograph (set, light, shadows, reflections, the product standing in it). There are no
// cut-outs, no pasted pieces and no word filters: the model sees the real product, so it keeps its shape, colours and almost all of its
// printed text. Its weakness is the smallest print, so every picture is COMPARED with the real photo by a vision model:
//   - two variants are made and the more faithful one is kept;
//   - the customer is told plainly how well the printed text matches (the main names, and whether small print differs);
//   - a picture with another product-like object in it counts against it.
// The exact mode (cut-out + restored pixels, see realize.js) remains for owners who want zero change to a product.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { projectPath, exists, readJson } from './project.js';
import { assetManifestSchema } from '../schemas/assetManifest.js';
import { editImage } from './realize.js';
import { askVision } from './llm.js';
import { logCall, readCostLog } from './costLog.js';

export const NATURAL_SIZES = { '4:5': [1280, 1600], '4:3': [1600, 1216], '16:9': [1920, 1088], '1:1': [1408, 1408], '3:1': [2048, 704] };
export const VARIANTS = 2;

// the nearest picture shape the image model can make for a frame of this width : height (a ratio, or a text like "4:3")
export function nearestAspect(ratio) {
  const parsed = typeof ratio === 'string' && ratio.includes(':') ? Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]) : Number(ratio);
  const r = parsed > 0 ? parsed : 1;
  const value = (a) => { const [w, h] = a.split(':').map(Number); return w / h; };
  return Object.keys(NATURAL_SIZES).sort((a, b) => Math.abs(Math.log(r / value(a))) - Math.abs(Math.log(r / value(b))))[0];
}
const usablePhoto = (a) => a.kind !== 'logo' && a.quality !== 'low' && !a.derivedFrom?.length && !a.origin;

export function naturalPrompt({ request, count }) {
  const many = count > 1;
  return [
    `A professional commercial photo shoot of ${many ? 'the products' : 'the product'} shown in the reference photo${many ? 's' : ''}.`,
    String(request).replace(/\s+/g, ' ').trim().slice(0, 600),
    `Keep ${many ? 'each product' : 'the product'} exactly as in the photo: the same shape, colors, design and all of its printed text, with nothing added to or changed on it. Do not add any other product, and no text or logo anywhere else.`,
    'Realistic professional lighting, natural shadows and reflections, shot like a high-end editorial photograph.',
  ].join(' ');
}

const fidelitySchema = z.object({
  score: z.number().min(0).max(10),
  mainTextMatches: z.boolean(),
  differences: z.array(z.string()).default([]),
  extraProducts: z.boolean().default(false),
  missingProducts: z.number().int().min(0).default(0),
});

// How faithful is the generated picture to the real photo(s)? photos: file paths. Returns { score, mainTextMatches, differences, extraProducts }.
export async function compareFidelity({ projectId, photos, picture }) {
  const tmps = []; const images = [];
  try {
    for (const [i, p] of [...photos, picture].entries()) {
      const tmp = path.join(os.tmpdir(), `fid-${process.pid}-${Date.now()}-${i}.jpg`);
      tmps.push(tmp);
      await sharp(p).rotate().resize({ width: 1100, height: 1100, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmp);
      images.push({ path: tmp });
    }
    return await askVision({
      projectId, stage: 'scene', system: 'You compare a generated photo shoot with the real product photos it was made from. Answer with JSON only.', images, schema: fidelitySchema, maxTokens: 500,
      prompt: `The first ${photos.length} image(s) are the customer's REAL product photo(s). The last image is a generated photo shoot that should show the same product(s) unchanged. For every product visible in the last image, compare its shape, colors, design and PRINTED TEXT (brand and product names, descriptions, volumes, small print) with the real photo. Answer { "score": 0 to 10 (10 = the products are identical, 7 = the main names and design are right but some small print differs, 4 = a name or a main word is wrong, 0 = a different product), "mainTextMatches": true if every brand and product name is spelled exactly as on the real photo, "differences": a short list of what differs (for example "BORN IN ROMA reads BORH IN ROMA", "Burberry is printed twice on the right box"), "extraProducts": true if the generated photo contains another product for sale (a bottle, box or package) that is not in the real photos (vases, candles, flowers and books are decoration, so false), "missingProducts": how many products that are in the real photos do NOT appear in the generated photo (a missing product also lowers the score to 6 or less) }.`,
    });
  } finally { for (const t of tmps) fs.rmSync(t, { force: true }); }
}

// What to tell the customer, in plain words.
export function checkSummary(check) {
  if (!check) return '';
  const short = (list) => list.slice(0, 2).map((d) => (d.length > 90 ? `${d.slice(0, 87)}...` : d)).join('; ');
  if (check.extraProducts) return 'Another product appeared in the picture that is not yours. Please try again.';
  if (check.missingProducts > 0) return `${check.missingProducts === 1 ? 'One of your products is' : `${check.missingProducts} of your products are`} missing from the picture. Please try again.`;
  if (check.score >= 9 && check.mainTextMatches) return 'Your product and its text match your photo.';
  if (check.mainTextMatches && check.score >= 6) return `The names on your product match your photo, but some small print differs${check.differences.length ? ` (${short(check.differences)})` : ''}. Please look closely before using it.`;
  return `Some text on your product looks different from your photo${check.differences.length ? ` (${short(check.differences)})` : ''}. We suggest trying again.`;
}

// products: ids of the customer's own photos (1 to 3). Returns { buffer, check, summary, files, costUsd, variants }.
export async function naturalRun({ projectId, request, products, aspect = '4:5', variants = VARIANTS, manifest: given = null, deps = {} }) {
  const manifest = given ?? readJson(projectId, 'asset-manifest.json', assetManifestSchema); // inside the pipeline the manifest in memory is the current one
  const photos = new Map(manifest.assets.filter(usablePhoto).map((a) => [a.id, a]));
  const wanted = [...new Set(products.map(String))];
  if (!wanted.length || wanted.length > 3) throw new Error('At most 3 products can be in one picture, and at least 1.');
  const unknown = wanted.filter((id) => !photos.has(id));
  if (unknown.length) throw new Error(`These are not usable photos of this project: ${unknown.join(', ')}.`);
  const [width, height] = NATURAL_SIZES[aspect] ?? NATURAL_SIZES['4:5'];
  const files = wanted.map((id) => projectPath(projectId, photos.get(id).file));
  const buffers = await Promise.all(files.map((f) => sharp(f).rotate().resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()));
  const prompt = naturalPrompt({ request, count: wanted.length });
  const costBefore = exists(projectId, 'cost-log.jsonl') ? readCostLog(projectId).length : 0;

  const made = await Promise.all(Array.from({ length: variants }, async () => {
    const started = Date.now();
    const out = await (deps.editImage ?? editImage)({ images: buffers, prompt, width, height });
    logCall({ projectId, stage: 'edit', provider: 'fal', model: 'flux-2-edit', durationMs: Date.now() - started, costUsd: out.cost });
    return out;
  }));
  const judged = [];
  for (const out of made) {
    const jpeg = await sharp(out.buffer).jpeg({ quality: 92 }).toBuffer();
    let check = null;
    try { check = await (deps.compareFidelity ?? compareFidelity)({ projectId, photos: files, picture: jpeg }); } catch { check = null; }
    // an unreadable verdict is the worst verdict: the picture is only used when nothing better exists
    const rank = check ? check.score - (check.extraProducts ? 5 : 0) - (check.missingProducts ?? 0) * 3 + (check.mainTextMatches ? 1 : 0) : -1;
    judged.push({ buffer: jpeg, check, rank });
  }
  judged.sort((a, b) => b.rank - a.rank);
  const best = judged[0];
  const costUsd = Number(readCostLog(projectId).slice(costBefore).reduce((s, e) => s + (e.estimatedUsd ?? 0), 0).toFixed(4));
  return { buffer: best.buffer, check: best.check, summary: best.check ? checkSummary(best.check) : 'We could not check the text on your product against your photo. Please look closely before using it.', costUsd, variants: judged.length, hash: crypto.createHash('sha1').update(best.buffer).digest('hex').slice(0, 8) };
}
