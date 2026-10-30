// The image lab: try a picture idea on a real project without changing the project's design.
//   labIdeas  asks the model for three different photo-shoot ideas for this business (a small brainstorm)
//   labRun    builds ONE scene picture from an idea: the same safe pipeline the real sites use (the set is inspected,
//             products are cut out and placed exactly as photographed, props are raw materials), saved under projects/<id>/lab/
// Nothing in design-spec.json or asset-manifest.json is changed. Identical ideas are free (the pieces are cached).
// The network and the model are injectable (deps), so tests never spend money.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exists, projectPath, readJson } from './project.js';
import { siteBriefSchema } from '../schemas/siteBrief.js';
import { assetManifestSchema } from '../schemas/assetManifest.js';
import { designSpecSchema } from '../schemas/designSpec.js';
import { askJson } from './llm.js';
import { generationAvailable, subjectProblems, MAX_ATMOSPHERE_PER_SITE } from './imageGen.js';
import { inventory, inventoryText } from '../stages/03-creative-director/inventory.js';
import { normalizeRecipes, composeImages } from '../stages/03-creative-director/compose.js';
import { readCostLog } from './costLog.js';
import { naturalRun } from './natural.js';
import { editingAvailable } from './realize.js';

export const LAB_ASPECTS = ['4:5', '4:3', '16:9', '1:1', '3:1'];
const hashOf = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 8);
const usablePhoto = (a) => a.kind !== 'logo' && a.quality !== 'low' && !a.derivedFrom && !a.origin;

function load(projectId) {
  if (!exists(projectId, 'site-brief.json') || !exists(projectId, 'asset-manifest.json')) throw new Error('This project needs its brief and its photos analyzed first (stages 1 and 2).');
  return { brief: readJson(projectId, 'site-brief.json', siteBriefSchema), manifest: readJson(projectId, 'asset-manifest.json', assetManifestSchema) };
}
const palettefor = (projectId) => (exists(projectId, 'design-spec.json') ? (() => { const c = readJson(projectId, 'design-spec.json', designSpecSchema).colors; return [c.primary, c.background]; })() : []);

// ---------- ideas ----------

const ideasSchema = z.object({
  ideas: z.array(z.object({
    title: z.string().min(1),
    scene: z.string().min(8),          // the set without any product: surface, backdrop, light
    props: z.array(z.string()).max(3).default([]),
    mood: z.string().default(''),
    products: z.array(z.string()).max(3).default([]),
    why: z.string().min(1),
  })).min(1).max(4),
});

const IDEAS_SYSTEM = `You are an art director who plans photo shoots for small businesses. You propose THREE clearly different ideas for ONE hero picture of this business's website.
Each idea is a SET: a wide, deep table or surface that products can stand on (never a shelf, a windowsill or a narrow ledge), a backdrop, the light, 2 to 4 tasteful DECORATION pieces from the business's own world (a vase of fresh flowers, a candle, a ceramic dish or tray, plain-cover books, a ribbon, greenery), and 1 to 3 loose natural PROPS (coffee beans, flour, petals, leaves, spices, wood shavings, dried flowers). The decoration goes inside the "scene" text.
Rules that are never broken:
- A real shoot is styled, never an empty table. The set contains NO product for sale (no perfume or cosmetic bottle, vial, jar, tube, box or package), no brand name, logo, sign or text. The business's real products are placed on the set afterwards, exactly as photographed, so "products" lists ONLY ids from the photo list whose product is shown WHOLE (not cut off), at most 3, or is empty for a pure mood picture.
- A generic person or hands may appear in a set when it truly fits, never as the owner, staff or customers.
- The three ideas must differ in mood, light and material, and each must fit THIS business and its brand, not a generic one.
Answer with JSON only: { "ideas": [ { "title": "", "scene": "", "props": [""], "mood": "", "products": ["asset-001"], "why": "one sentence: why this makes people want the products" } ] }`;

export async function labIdeas({ projectId, deps = {} }) {
  const { brief, manifest } = load(projectId);
  const ask = deps.askJson ?? askJson;
  const b = brief.business;
  const summary = { name: b.name, type: b.type, description: b.description, audience: brief.audience.description, tone: brief.tone, brand: brief.brand, language: brief.language };
  const out = await ask({
    projectId, stage: 'lab', system: IDEAS_SYSTEM, schema: ideasSchema, maxTokens: 2000,
    prompt: `BUSINESS\n${JSON.stringify(summary, null, 2)}\n\n${inventoryText(inventory(manifest, brief))}\n\nWrite the three ideas.`,
  });
  const photos = new Set(manifest.assets.filter(usablePhoto).map((a) => a.id));
  const names = [b.name, ...brief.offerings.map((o) => o.name)];
  // an idea that breaks the rules is dropped, not repaired
  return out.ideas
    .map((i) => ({ ...i, products: [...new Set(i.products)].filter((id) => photos.has(id)).slice(0, 3), props: i.props.slice(0, 3) }))
    .filter((i) => subjectProblems(`${i.scene} ${i.props.join(' ')}`, names).length === 0);
}

// ---------- one picture ----------

export async function labRun({ projectId, scene, props = [], mood = '', products = [], aspect = '4:5', mode = 'natural', deps = {} }) {
  const { brief, manifest } = load(projectId);
  const text = String(scene ?? '').trim();
  if (text.split(/\s+/).filter(Boolean).length < 3) throw new Error('Describe the set in a few words (for example: "dark slate bar top in low morning light").');
  if (!LAB_ASPECTS.includes(aspect)) throw new Error(`The shape must be one of: ${LAB_ASPECTS.join(', ')}.`);
  const propList = (Array.isArray(props) ? props : String(props).split(',')).map((p) => String(p).trim()).filter(Boolean).slice(0, 3);
  const photos = new Map(manifest.assets.filter(usablePhoto).map((a) => [a.id, a]));
  const wanted = [...new Set((Array.isArray(products) ? products : []).map(String))];
  const unknown = wanted.filter((id) => !photos.has(id));
  if (unknown.length) throw new Error(`These are not usable photos of this project: ${unknown.join(', ')}.`);
  if (wanted.length > 3) throw new Error('At most 3 products can stand on one set.');

  // natural mode: the customer's photo(s) and a plain description go straight to the image-editing model (see natural.js)
  if (mode === 'natural' && wanted.length && (deps.editImage || editingAvailable())) {
    const request = [text, propList.length ? `with ${propList.join(', ')} around` : '', mood ? `${String(mood).trim()} mood` : ''].filter(Boolean).join(', ');
    const done = await naturalRun({ projectId, request, products: wanted, aspect, deps });
    const dir = projectPath(projectId, 'lab');
    fs.mkdirSync(dir, { recursive: true });
    const file = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-nat-${done.hash}.jpg`;
    fs.writeFileSync(path.join(dir, file), done.buffer);
    const entry = { at: new Date().toISOString(), file, scene: text, props: propList, mood: String(mood ?? '').trim(), products: wanted, aspect, costUsd: done.costUsd, warnings: done.check && done.check.score >= 9 ? [] : [done.summary], mode: 'natural', check: done.check ?? null, summary: done.summary };
    const logFile = path.join(dir, 'lab-log.json');
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
    fs.writeFileSync(logFile, JSON.stringify([entry, ...log].slice(0, 200), null, 2));
    return { ...entry, url: `/files/${projectId}/lab/${file}`, limit: MAX_ATMOSPHERE_PER_SITE };
  }

  const slotId = `lab-${hashOf(text, propList, mood, wanted, aspect)}`;
  const slot = { id: slotId, kind: 'image', description: 'image lab', aspect, assignedAsset: null, recipe: { type: 'scene', scene: text, props: propList, mood: String(mood ?? '').trim(), sources: wanted, reason: 'image lab' } };
  const colors = palettefor(projectId);
  const design = { colors: { primary: colors[0] ?? '#444444', background: colors[1] ?? '#f4efe6' }, pages: [{ slug: 'lab', sections: [{ id: 'lab', slots: [slot] }] }] };
  const copy = structuredClone(manifest); // the project's own manifest is never touched

  const generation = deps.generation ?? (generationAvailable() && brief.wishes?.aiPictures !== 'photos-only');
  const warnings = normalizeRecipes(design, copy, { generation, names: [brief.business.name, ...brief.offerings.map((o) => o.name)] });
  if (slot.recipe.type !== 'scene') throw new Error(`The idea was not accepted: ${warnings.join('; ') || 'it could not be built'}.`);

  const costBefore = exists(projectId, 'cost-log.jsonl') ? readCostLog(projectId).length : 0;
  await composeImages({ projectId, design, manifest: copy, only: [slotId], palette: colors, deps: { ...deps, naturalScenes: false } }); // this is the exact method
  const made = copy.assets.find((a) => a.id === slot.assignedAsset);
  if (slot.recipe.type !== 'scene' || !made) {
    throw new Error(`The picture could not be made: ${slot.failure ?? 'the scene was not built'}.`);
  }

  const costUsd = exists(projectId, 'cost-log.jsonl') ? readCostLog(projectId).slice(costBefore).reduce((s, e) => s + (e.estimatedUsd ?? 0), 0) : 0;
  const dir = projectPath(projectId, 'lab');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${slotId.slice(4)}.jpg`;
  fs.copyFileSync(projectPath(projectId, made.file), path.join(dir, name));
  fs.rmSync(projectPath(projectId, made.file), { force: true }); // the working copy; the set and cut-outs stay cached for free reruns
  const entry = { at: new Date().toISOString(), file: name, scene: text, props: propList, mood: slot.recipe.mood, products: made.derivedFrom ?? [], aspect, costUsd: Number(costUsd.toFixed(4)), warnings };
  const logFile = path.join(dir, 'lab-log.json');
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  fs.writeFileSync(logFile, JSON.stringify([entry, ...log].slice(0, 200), null, 2));
  return { ...entry, url: `/files/${projectId}/lab/${name}`, limit: MAX_ATMOSPHERE_PER_SITE };
}

export function labHistory(projectId) {
  const file = projectPath(projectId, 'lab', 'lab-log.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => ({ ...e, url: `/files/${projectId}/lab/${e.file}` })) : [];
}
