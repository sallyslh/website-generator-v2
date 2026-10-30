// Stage 2: asset intelligence. Understands the customer's files (photos, logo, PDFs) and
// finds missing visuals. Input: inputs/assets/ + site-brief.json. Output: asset-manifest.json.
// Size, orientation and hash come from code; the LLM only describes and judges.
// Files already analyzed (same hash) are reused from the previous manifest, which saves cost.

import fs from 'node:fs';
import { select } from '@inquirer/prompts';
import { z } from 'zod';
import { askJson, askVision } from '../../lib/llm.js';
import { exists, projectPath, readJson, writeJson } from '../../lib/project.js';
import { readCostLog, summarize, totalOf } from '../../lib/costLog.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema, CATEGORIES, QUALITIES, USABLE_FOR } from '../../schemas/assetManifest.js';
import { log } from '../../lib/log.js';
import { scanAssets, isDocument } from './scan.js';
import { applyItemPhotos } from '../../lib/shopItems.js';
import { IMAGE_SYSTEM, imagePrompt, SVG_SYSTEM, svgPrompt, PDF_SYSTEM, pdfPrompt, GAPS_SYSTEM, gapsPrompt } from './prompts.js';

const STAGE = 'assets';
const TINY_SIDE = 500; // shortest side below this many pixels = too small for a website
const PARALLEL = 3;
export const BULK_PHOTOS = 30; // above this many photos, the ones the owner named after a product are not read one by one

const imageAnswer = z.object({
  isLogo: z.boolean(),
  category: z.enum(CATEGORIES),
  description: z.string(),
  quality: z.enum(QUALITIES),
  usableFor: z.array(z.enum(USABLE_FOR)),
  dominantColors: z.array(z.string()),
  notes: z.string().default(''),
});
const pdfAnswer = z.object({ summary: z.string(), facts: z.array(z.string()).default([]) });
const gapsAnswer = z.object({
  gaps: z.array(z.object({ need: z.string(), reason: z.string(), priority: z.enum(['high', 'medium', 'low']) })).max(8),
});

// Runs async tasks a few at a time.
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]);
      }
    }),
  );
  return results;
}

function nextId(prefix, used) {
  let n = 1;
  while (used.has(`${prefix}-${String(n).padStart(3, '0')}`)) n++;
  const id = `${prefix}-${String(n).padStart(3, '0')}`;
  used.add(id);
  return id;
}

async function analyzeImage(projectId, brief, file) {
  if (file.ext === '.svg') {
    const source = fs.readFileSync(file.abs, 'utf8');
    return askJson({ projectId, stage: 'assets-vision', system: SVG_SYSTEM, prompt: svgPrompt(brief, file.name, source), schema: imageAnswer, maxTokens: 800 });
  }
  return askVision({
    projectId, stage: 'assets-vision', system: IMAGE_SYSTEM, prompt: imagePrompt(brief, file.name),
    images: [{ path: file.abs }], schema: imageAnswer, maxTokens: 800,
  });
}

// A photo the owner named after one of their products: the product's name is the description, no AI reading is paid for.
// The product's own list tells us what it is; quality comes from the pixels (code). Only used for big folders (BULK_PHOTOS).
export function namedPhotoAnswer(file, item) {
  return { isLogo: false, category: 'product', description: `${item.name}${item.description ? `: ${item.description}` : ''} (named by the owner, not read by AI)`, quality: 'medium', usableFor: ['card', 'gallery'], dominantColors: [], notes: 'Matched from the file name; not analysed.' };
}
export function namedPhotos(projectId, brief) {
  if (!exists(projectId, 'inputs/answers.json')) return new Map();
  const answers = JSON.parse(fs.readFileSync(projectPath(projectId, 'inputs/answers.json'), 'utf8'));
  const out = new Map();
  for (const link of answers.itemPhotos ?? []) {
    const item = link.item >= 0 ? brief.offerings[link.item] : null;
    if (item) out.set(link.file, item);
  }
  return out;
}

// Applies the rules that code (not the LLM) is responsible for.
function buildAsset(id, file, answer) {
  const looksLikeLogo = answer.isLogo || /^logo[.\-_ ]/i.test(file.name);
  const tiny = Math.min(file.info.width, file.info.height) < TINY_SIDE && file.ext !== '.svg';
  let quality = tiny ? 'low' : answer.quality;
  let notes = answer.notes;
  if (tiny) notes = `${notes} Image is only ${file.info.width}x${file.info.height}px (too small).`.trim();
  return {
    id, file: file.rel, hash: file.hash,
    kind: looksLikeLogo ? 'logo' : 'image',
    category: looksLikeLogo ? 'logo' : answer.category,
    description: answer.description,
    quality,
    orientation: file.info.orientation, width: file.info.width, height: file.info.height,
    dominantColors: answer.dominantColors,
    usableFor: quality === 'low' ? ['none'] : answer.usableFor.length ? answer.usableFor : ['gallery'],
    notes,
  };
}

async function chooseLogo(assets, previousLogo) {
  const candidates = assets.filter((a) => a.kind === 'logo');
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].id;
  if (previousLogo && candidates.some((c) => c.id === previousLogo)) return previousLogo;
  const named = candidates.filter((c) => /(^|\/)logo\.[a-z]+$/i.test(c.file));
  if (named.length === 1) return named[0].id;
  if (!process.stdin.isTTY) {
    log.info(STAGE, `Several logo candidates, using ${candidates[0].id} (no terminal to ask).`);
    return candidates[0].id;
  }
  return select({ message: 'Which of these is the logo?', choices: candidates.map((c) => ({ name: `${c.id}  ${c.file} - ${c.description}`, value: c.id })) });
}

function printResult(manifest, stats) {
  console.log(`\nAssets for this project: ${manifest.assets.length} images/logos, ${manifest.documents.length} documents`);
  for (const a of manifest.assets)
    console.log(`  ${a.id} ${a.file.replace('inputs/assets/', '')}  [${a.category}, ${a.quality}, ${a.orientation} ${a.width}x${a.height}]  ${a.usableFor.join('/')}\n      ${a.description}`);
  console.log(`  Logo: ${manifest.logo ?? 'none found'}`);
  for (const d of manifest.documents) {
    console.log(`  ${d.id} ${d.file.replace('inputs/assets/', '')}: ${d.summary}`);
    d.facts.forEach((f) => console.log(`      fact: ${f}`));
  }
  if (manifest.documents.length) console.log('  (document facts are NOT copied into site-brief.json, review them yourself)');
  console.log('  Gaps:');
  if (!manifest.gaps.length) console.log('    none');
  manifest.gaps.forEach((g) => console.log(`    [${g.priority}] ${g.need} - ${g.reason}`));
  if (stats.skipped.length) console.log(`  Skipped (unsupported): ${stats.skipped.join(', ')}`);
}

export async function run({ projectId }) {
  const started = Date.now();
  const since = new Date().toISOString();
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const previous = exists(projectId, 'asset-manifest.json') ? safeRead(projectId) : null;
  const { files, skipped } = scanAssets(projectId);
  skipped.forEach((name) => log.info(STAGE, `Skipping unsupported file: ${name}`));

  const cachedAssets = new Map((previous?.assets ?? []).filter((a) => a.hash).map((a) => [a.hash, a]));
  const cachedDocs = new Map((previous?.documents ?? []).filter((d) => d.hash).map((d) => [d.hash, d]));
  const usedAssetIds = new Set([...cachedAssets.values()].map((a) => a.id));
  const usedDocIds = new Set([...cachedDocs.values()].map((d) => d.id));

  const images = files.filter((f) => !isDocument(f));
  const pdfs = files.filter(isDocument); // PDFs and pictures of menus or price lists
  const toAnalyze = images.filter((f) => !cachedAssets.has(f.hash));
  log.info(STAGE, `${images.length} images (${images.length - toAnalyze.length} cached), ${pdfs.length} PDFs`);

  // ids are handed out in file order before the parallel calls start, so they stay predictable
  const newIds = new Map(toAnalyze.map((file) => [file.hash, nextId('asset', usedAssetIds)]));
  const named = images.length > BULK_PHOTOS ? namedPhotos(projectId, brief) : new Map();
  if (named.size) log.info(STAGE, `${images.length} photos: the ${[...toAnalyze].filter((f) => named.has(f.name)).length} named after a product are described from the owner's list, not read by AI`);
  const analyzed = await mapLimit(toAnalyze, PARALLEL, async (file) => {
    const item = file.ext !== '.svg' && !/^logo/i.test(file.name) ? named.get(file.name) : null;
    const answer = item ? namedPhotoAnswer(file, item) : await analyzeImage(projectId, brief, file);
    return [file.hash, buildAsset(newIds.get(file.hash), file, answer)];
  });
  const fresh = new Map(analyzed);

  const assets = images.map((file) => {
    const asset = fresh.get(file.hash) ?? { ...cachedAssets.get(file.hash), file: file.rel };
    return asset;
  });

  const documents = [];
  for (const file of pdfs) {
    const cached = cachedDocs.get(file.hash);
    if (cached) {
      documents.push({ ...cached, file: file.rel });
      continue;
    }
    const answer = await askVision({
      projectId, stage: 'assets-pdf', system: PDF_SYSTEM, prompt: pdfPrompt(brief, file.name), images: [{ path: file.abs }], schema: pdfAnswer, maxTokens: 2500,
    });
    documents.push({ id: nextId('doc', usedDocIds), file: file.rel, hash: file.hash, summary: answer.summary, facts: answer.facts });
  }

  const logo = await chooseLogo(assets, previous?.logo);
  const { gaps } = await askJson({
    projectId, stage: 'assets-gaps', system: GAPS_SYSTEM, prompt: gapsPrompt(brief, assets, documents, Boolean(logo)), schema: gapsAnswer, maxTokens: 1500,
  });

  const manifest = { schemaVersion: 1, assets, logo, documents, gaps };
  writeJson(projectId, 'asset-manifest.json', manifest, assetManifestSchema);
  const linked = applyItemPhotos(projectId); // photos the owner named after their products
  if (linked) log.info(STAGE, `${linked} product photo(s) linked to the owner's product list`);
  printResult(manifest, { skipped });

  const t = totalOf(summarize(readCostLog(projectId).filter((e) => e.stage.startsWith('assets') && e.at >= since)));
  const perImage = toAnalyze.length ? ` | ${Math.round((t.inputTokens + t.outputTokens) / toAnalyze.length)} tokens per new image` : '';
  const usd = t.usdKnown ? `$${t.usd.toFixed(4)}` : 'cost n/a (set PRICES)';
  log.info(STAGE, `asset-manifest.json written. ${((Date.now() - started) / 1000).toFixed(1)}s, ${t.calls} API calls, ${usd}${perImage}`);
}

function safeRead(projectId) {
  try {
    return readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  } catch {
    return null; // an old or broken manifest is simply not used as a cache
  }
}
