// Turns the creative director's image plan into real files.
//   normalizeRecipes  makes every slot's recipe honest and consistent (pure, unit tested)
//   composeImages     builds the pictures the plan asks for and registers them as ordinary assets:
//       collage     "combo-N"  several REAL photos arranged into one picture
//       crop        "crop-N"   ONE real item cut out of a group photo (a vision model finds it, code crops it)
//       atmosphere  "atmo-N"   a generated mood picture (FLUX.2) of a raw material or quiet scene: never a product, person, logo or text
// Every one of them starts with approval "pending". Collages and crops are the customer's own photos and are used unless the
// customer rejects them; an atmosphere picture is only used if the customer approves it.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { projectPath, exists } from '../../lib/project.js';
import { composeCollage } from '../../lib/collage.js';
import { cropItem, overlapRatio } from '../../lib/crop.js';
import { generateImage, atmospherePrompt, surfacePrompt, setPrompt, usableProps, subjectProblems, MAX_ATMOSPHERE_PER_SITE } from '../../lib/imageGen.js';
import { inspectSet, setProblem, composeScene, lookOf } from '../../lib/scene.js';
import { removeBackground } from '../../lib/cutout.js';
import { completenessJudge } from '../../lib/completeness.js';
import { naturalRun, nearestAspect } from '../../lib/natural.js';
import { sizeFor } from '../../lib/collage.js';
import crypto from 'node:crypto';
import { realizeScene, editingAvailable } from '../../lib/realize.js';
import { composeProducts } from '../../lib/composite.js';
import { logCall } from '../../lib/costLog.js';
import { log } from '../../lib/log.js';

const STAGE = 'direct';
const slotsOf = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));
const usable = (asset) => asset && asset.kind !== 'logo' && asset.quality !== 'low' && !asset.derivedFrom && asset.origin !== 'generated';
// Stage 2 notes mention slideshow counters, watermarks and badges. A single photo can be cropped around them by the layout,
// but inside a combined picture they would stay visible, so such photos are never used for collages.
export const HAS_OVERLAY = /\b(counter|watermark|badge|slideshow)\b|overlay (is|in|badge)|\d\/\d/i;
// the notes still say "counter" after the counter was cropped away, so a cleaned photo no longer counts
export const hasOverlay = (asset) => HAS_OVERLAY.test(asset?.notes ?? '') && !asset?.overlayRemoved;
const cleanForCollage = (asset) => usable(asset) && !hasOverlay(asset);
// A picture made of several photos looks unnatural (and leaves blank areas), so collages are OFF: wherever one was planned, or was the
// fallback of something else, ONE real photo is used. Tests switch this on to test the collage maker itself.
export const flags = { collages: false };

export const MADE_PREFIXES = ['combo-', 'crop-', 'atmo-', 'comp-', 'scene-'];
export const MAX_COMPOSITE_PRODUCTS = 3;
const isMade = (id) => MADE_PREFIXES.some((p) => id.startsWith(p));

// Returns warnings. After this, a slot never claims more than it has:
//   use          -> assignedAsset is its one source
//   collage      -> needs 2+ different usable photos without overlays, otherwise it falls back to "use" or "needs-photo"
//   crop         -> needs exactly one usable photo and a target, otherwise "needs-photo"
//   atmosphere   -> only when generation is available, the subject is safe and fewer than the maximum exist, otherwise "needs-photo"
//   needs-photo  -> assignedAsset is null
//   no recipe    -> one is derived from the assignment
// options: { generation: boolean, names: the business's own product and brand names }
export function normalizeRecipes(design, manifest, options = {}) {
  const { generation = false, names = [], collages = flags.collages } = options;
  const warnings = [];
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  let atmosphere = 0;
  for (const slot of slotsOf(design)) {
    const r = slot.recipe;
    if (!r) {
      slot.recipe = slot.assignedAsset ? { type: 'use', sources: [slot.assignedAsset], reason: '' } : { type: 'needs-photo', sources: [], reason: '' };
      continue;
    }
    if (r.type === 'scene') {
      const real = [...new Set(r.sources ?? [])].filter((id) => usable(byId.get(id))).slice(0, MAX_COMPOSITE_PRODUCTS);
      const problems = [
        ...(generation ? [] : ['image generation is not available']),
        ...(r.scene?.trim() ? [] : ['the scene is not described']),
        ...subjectProblems(`${r.scene ?? ''} ${(r.props ?? []).join(' ')}`, names),
        ...(atmosphere >= MAX_ATMOSPHERE_PER_SITE ? [`only ${MAX_ATMOSPHERE_PER_SITE} generated pictures are allowed on a site`] : []),
      ];
      r.sources = real;
      if (!problems.length) { atmosphere++; slot.assignedAsset = null; continue; }
      warnings.push(`slot ${slot.id}: no scene (${problems.join('; ')}); the real photos are used instead`);
      r.type = real.length >= 2 ? 'collage' : real.length === 1 ? 'use' : 'needs-photo';
      if (r.type === 'needs-photo') r.sources = [];
    }
    if (r.type === 'atmosphere') {
      const problems = [...(generation ? [] : ['image generation is not available']), ...subjectProblems(r.subject, names), ...(atmosphere >= MAX_ATMOSPHERE_PER_SITE ? [`only ${MAX_ATMOSPHERE_PER_SITE} generated pictures are allowed on a site`] : [])];
      if (problems.length) { warnings.push(`slot ${slot.id}: no atmosphere picture (${problems.join('; ')})`); r.type = 'needs-photo'; r.sources = []; } else { atmosphere++; r.sources = []; slot.assignedAsset = null; continue; }
    }
    if (r.type === 'composite') {
      const asked = [...new Set(r.sources)];
      const real = asked.filter((id) => usable(byId.get(id)));
      if (real.length < asked.length) warnings.push(`slot ${slot.id}: ${asked.filter((id) => !real.includes(id)).join(', ')} cannot be used in a composite (not a usable photo)`);
      if (real.length > MAX_COMPOSITE_PRODUCTS) warnings.push(`slot ${slot.id}: a composite shows at most ${MAX_COMPOSITE_PRODUCTS} products, the first ${MAX_COMPOSITE_PRODUCTS} are used`);
      r.sources = real.slice(0, MAX_COMPOSITE_PRODUCTS);
      if (r.sources.length >= 2 && generation) { slot.assignedAsset = null; continue; } // built later: cutting products out needs the image service
      warnings.push(`slot ${slot.id}: no composite (${r.sources.length < 2 ? 'it needs 2 or 3 usable photos' : 'cutting products out is not available'}); a plain collage is used instead`);
      r.type = 'collage';
    }
    if (r.type === 'collage' && !collages) {
      const first = [...new Set(r.sources ?? [])].find((id) => usable(byId.get(id)));
      warnings.push(`slot ${slot.id}: no collage (a picture made of several photos looks unnatural); ${first ? `the one photo ${first} is used` : 'the slot waits for a real photo'}`);
      r.type = first ? 'use' : 'needs-photo'; r.sources = first ? [first] : []; slot.assignedAsset = first ?? null;
      continue;
    }
    const wanted = [...new Set(r.sources)];
    r.sources = wanted.filter((id) => (r.type === 'collage' ? cleanForCollage : usable)(byId.get(id)));
    if (r.type === 'collage' && r.sources.length < wanted.length) warnings.push(`slot ${slot.id}: ${wanted.filter((id) => !r.sources.includes(id)).join(', ')} not used in the collage (low quality, or a counter/watermark/overlay that would stay visible)`);
    if (r.type === 'collage') {
      if (r.sources.length < 2) {
        warnings.push(`slot ${slot.id}: a collage needs 2 or more usable photos, found ${r.sources.length}`);
        r.type = r.sources.length === 1 ? 'use' : 'needs-photo';
      } else {
        r.layout ??= r.sources.length <= 3 ? 'row' : 'grid';
        slot.assignedAsset = null; // set when the picture is built
        continue;
      }
    }
    if (r.type === 'crop') {
      if (r.sources.length === 1 && r.target?.trim()) { slot.assignedAsset = null; continue; }
      warnings.push(`slot ${slot.id}: a crop needs exactly one usable photo and a target`);
      r.type = 'needs-photo'; r.sources = [];
    }
    if (r.type === 'use') {
      const id = r.sources[0] ?? (usable(byId.get(slot.assignedAsset)) ? slot.assignedAsset : null);
      if (id) { r.sources = [id]; slot.assignedAsset = id; } else { r.type = 'needs-photo'; r.sources = []; slot.assignedAsset = null; }
    } else if (r.type === 'needs-photo') {
      r.sources = [];
      slot.assignedAsset = null;
    }
  }
  return warnings;
}

const orientationOf = (width, height) => (width / height > 1.2 ? 'landscape' : width / height < 0.85 ? 'portrait' : 'square');
const baseAsset = (id, rel, extra, decided = new Map()) => ({
  id, file: rel, hash: '', kind: 'image', category: 'product', quality: 'medium', dominantColors: [], usableFor: ['hero', 'card', 'section-background'], approval: decided.get(extra.notes) ?? 'pending', ...extra,
});

// Builds every collage, crop and atmosphere slot. Mutates design (assignedAsset) and manifest (new assets). Returns the new asset ids.
// deps are replaced in tests: { cropItem, generateImage }.
// only: an optional list of slot ids; just those pictures are rebuilt (cached pieces are reused) and everything else stays as it is.
export async function composeImages({ projectId, design, manifest, background, palette = [], deps = {}, only = null }) {
  const crop = deps.cropItem ?? cropItem;
  const generate = deps.generateImage ?? generateImage;
  // a product that touches the edge of its photo is judged by a vision model (never in tests: they inject their own cut-out step)
  const accept = deps.judgeCompleteness ?? (deps.removeBackground ? null : completenessJudge({ projectId }));
  const byId = new Map(manifest.assets.filter((a) => !isMade(a.id)).map((a) => [a.id, a]));
  // generated pictures cost money: one that was already made for the same subject and style is reused
  const earlier = new Map(manifest.assets.filter((a) => a.origin === 'generated').map((a) => [a.notes, a]));
  // what the customer already decided about a picture stays decided when the same picture is made again (same photos / item / subject)
  const decided = new Map(manifest.assets.filter((a) => a.origin && a.approval && a.approval !== 'pending').map((a) => [a.notes, a.approval]));
  const redo = only ? new Set(only) : null;
  const rebuilding = (a) => !redo || slotsOf(design).some((s) => redo.has(s.id) && s.assignedAsset === a.id);
  manifest.assets = manifest.assets.filter((a) => !isMade(a.id) || !rebuilding(a));
  if (!redo) fs.rmSync(projectPath(projectId, 'inputs/composed'), { recursive: true, force: true });
  const made = [];
  const cropped = new Map(); // photo id -> regions already cut out of it
  const composites = [];
  const scenes = [];
  const top = (prefix) => Math.max(0, ...manifest.assets.filter((a) => a.id.startsWith(prefix)).map((a) => Number(a.id.slice(prefix.length)) || 0));
  const next = { combo: top('combo-'), crop: top('crop-'), atmo: top('atmo-'), comp: top('comp-'), scene: top('scene-') };
  const read = (rel) => fs.readFileSync(projectPath(projectId, rel));
  const write = (rel, data) => { fs.mkdirSync(path.dirname(projectPath(projectId, rel)), { recursive: true }); fs.writeFileSync(projectPath(projectId, rel), data); };
  const save = (slot, buffer) => {
    const rel = `inputs/composed/${slot.id}.jpg`;
    fs.mkdirSync(path.dirname(projectPath(projectId, rel)), { recursive: true });
    fs.writeFileSync(projectPath(projectId, rel), buffer);
    return rel;
  };
  const fallback = (slot, why) => {
    log.info(STAGE, `warning: ${why} for ${slot.id}; the slot waits for a real photo`);
    slot.recipe.type = 'needs-photo'; slot.recipe.sources = []; slot.assignedAsset = null;
  };

  for (const slot of slotsOf(design)) {
    const r = slot.recipe;
    if (redo && !redo.has(slot.id)) continue;
    if (!r || !['collage', 'crop', 'atmosphere', 'composite', 'scene'].includes(r.type)) continue;
    if (r.type === 'scene') { scenes.push(slot); continue; }
    if (r.type === 'composite') { composites.push(slot); continue; } // after the crops, because they may become sources later
    try {
      if (r.type === 'collage') {
        const sources = r.sources.map((id) => byId.get(id));
        const { buffer, width, height } = await composeCollage({ files: sources.map((a) => projectPath(projectId, a.file)), layout: r.layout, aspect: slot.aspect, background });
        const counts = {};
        for (const a of sources) counts[a.category] = (counts[a.category] ?? 0) + 1;
        const id = `combo-${++next.combo}`;
        manifest.assets.push(baseAsset(id, save(slot, buffer), {
          category: Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], origin: 'collage', derivedFrom: [...r.sources],
          description: `A combined picture arranged from ${sources.length} of the customer's own photos (${r.sources.join(', ')}). ${r.reason}`.trim(),
          orientation: orientationOf(width, height), width, height,
          notes: `Arranged from the customer's photos. Nothing was added or generated. Photos used: ${r.sources.join(', ')}.`,
        }, decided));
        slot.assignedAsset = id; made.push(id);
      } else if (r.type === 'crop') {
        const source = byId.get(r.sources[0]);
        const done = await crop({ projectId, file: projectPath(projectId, source.file), target: r.target, aspect: slot.aspect });
        if (done.problem) { fallback(slot, `could not crop "${r.target}" (${done.problem})`); continue; }
        if ((cropped.get(source.id) ?? []).some((other) => overlapRatio(done.region, other) > 0.5)) { fallback(slot, `the crop of "${r.target}" shows the same area as another crop of ${source.id}`); continue; }
        cropped.set(source.id, [...(cropped.get(source.id) ?? []), done.region]);
        const id = `crop-${++next.crop}`;
        manifest.assets.push(baseAsset(id, save(slot, done.buffer), {
          category: source.category, origin: 'crop', derivedFrom: [source.id],
          description: `${r.target}, cut out of the customer's photo ${source.id}. ${r.reason}`.trim(), orientation: orientationOf(done.width, done.height), width: done.width, height: done.height,
          notes: `A crop of the customer's own photo ${source.id}: "${r.target}". Nothing was added or changed.`,
        }, decided));
        slot.assignedAsset = id; made.push(id);
      } else {
        const key = `Generated mood picture. Subject: ${r.subject}. Style: ${r.style ?? ''}. Never a product, person, logo or text.`;
        const keptRel = `inputs/composed-kept/${slot.id}.jpg`;
        const old = earlier.get(key);
        let buffer; let width; let height;
        if (old && exists(projectId, keptRel)) {
          buffer = fs.readFileSync(projectPath(projectId, keptRel)); ({ width, height } = old);
        } else {
          const started = Date.now();
          const out = await generate({ prompt: atmospherePrompt({ subject: r.subject, style: r.style, colors: palette }), aspect: slot.aspect });
          logCall({ projectId, stage: STAGE, provider: 'fal', model: 'flux-2', durationMs: Date.now() - started, costUsd: out.cost });
          ({ buffer, width, height } = out);
        }
        const id = `atmo-${++next.atmo}`;
        const rel = save(slot, buffer);
        fs.mkdirSync(path.dirname(projectPath(projectId, keptRel)), { recursive: true });
        fs.writeFileSync(projectPath(projectId, keptRel), buffer);
        manifest.assets.push(baseAsset(id, rel, {
          category: 'other', origin: 'generated', description: `A generated mood picture: ${r.subject}. ${r.reason}`.trim(), orientation: orientationOf(width, height), width, height, notes: key,
        }, decided));
        slot.assignedAsset = id; made.push(id);
      }
    } catch (e) {
      fallback(slot, `the ${r.type} failed (${e.message})`);
    }
  }

  // composites: real products cut out of their photos (cached, so a rerun costs nothing), placed together on a new background
  for (const slot of composites) {
    const r = slot.recipe;
    try {
      const cut = [];
      for (const id of r.sources) {
        const cacheRel = `inputs/cutouts/${id}.png`;
        let item;
        if (exists(projectId, cacheRel)) {
          const buffer = fs.readFileSync(projectPath(projectId, cacheRel));
          const meta = await sharp(buffer).metadata();
          item = { buffer, width: meta.width, height: meta.height, cutOff: false };
        } else {
          const started = Date.now();
          item = await (deps.removeBackground ?? removeBackground)({ file: projectPath(projectId, byId.get(id).file), accept });
          logCall({ projectId, stage: STAGE, provider: 'fal', model: 'birefnet-v2', durationMs: Date.now() - started, costUsd: item.cost });
          if (!item.cutOff) { fs.mkdirSync(path.dirname(projectPath(projectId, cacheRel)), { recursive: true }); fs.writeFileSync(projectPath(projectId, cacheRel), item.buffer); }
        }
        if (item.cutOff) { log.info(STAGE, `warning: the product in ${id} is cut off by its photo's own frame, so it is not used in the composite`); continue; }
        cut.push({ id, ...item });
      }
      if (cut.length < 2) throw new Error('fewer than 2 whole products were left');
      let backdrop = background_(design, background);
      if (r.background === 'generated') {
        const bgRel = `inputs/cutouts/background-${slot.id}.jpg`;
        if (exists(projectId, bgRel)) backdrop = fs.readFileSync(projectPath(projectId, bgRel));
        else {
          const started = Date.now();
          const out = await generate({ prompt: surfacePrompt({ surface: r.subject && !subjectProblems(r.subject).length ? r.subject : undefined, colors: palette }), aspect: slot.aspect });
          logCall({ projectId, stage: STAGE, provider: 'fal', model: 'flux-2', durationMs: Date.now() - started, costUsd: out.cost });
          fs.mkdirSync(path.dirname(projectPath(projectId, bgRel)), { recursive: true });
          fs.writeFileSync(projectPath(projectId, bgRel), out.buffer);
          backdrop = out.buffer;
        }
      }
      const { buffer, width, height } = await composeProducts({ cutouts: cut, background: backdrop ?? '#f4efe6', aspect: slot.aspect });
      const used = cut.map((c) => c.id);
      const id = `comp-${++next.comp}`;
      manifest.assets.push(baseAsset(id, save(slot, buffer), {
        category: byId.get(used[0]).category, origin: 'composite', derivedFrom: used,
        description: `Real products from the customer's photos (${used.join(', ')}) cut out and placed together on a new background. ${r.reason}`.trim(),
        orientation: orientationOf(width, height), width, height,
        notes: `Real products cut out of the customer's photos and placed together on a new background. The products themselves are not changed. Photos used: ${used.join(', ')}.`,
      }, decided));
      slot.assignedAsset = id; made.push(id);
    } catch (e) {
      // the safe fallback is the first real photo (a collage of several only when collages are switched on)
      log.info(STAGE, `warning: the composite for ${slot.id} failed (${e.message}); ${flags.collages ? 'a collage of the same photos' : 'the first real photo'} is used instead`);
      if (!flags.collages) {
        const first = r.sources.map((x) => byId.get(x)).find(Boolean);
        if (first) { slot.recipe.type = 'use'; slot.recipe.sources = [first.id]; slot.assignedAsset = first.id; } else fallback(slot, 'the composite failed');
        continue;
      }
      slot.recipe.type = 'collage'; slot.recipe.layout ??= 'row';
      try {
        const sources = r.sources.map((x) => byId.get(x));
        const { buffer, width, height } = await composeCollage({ files: sources.map((a) => projectPath(projectId, a.file)), layout: r.layout, aspect: slot.aspect, background });
        const id = `combo-${++next.combo}`;
        manifest.assets.push(baseAsset(id, save(slot, buffer), {
          category: sources[0].category, origin: 'collage', derivedFrom: [...r.sources], description: `A combined picture arranged from ${sources.length} of the customer's own photos (${r.sources.join(', ')}).`,
          orientation: orientationOf(width, height), width, height, notes: `Arranged from the customer's photos. Nothing was added or generated. Photos used: ${r.sources.join(', ')}.`,
        }, decided));
        slot.assignedAsset = id; made.push(id);
      } catch (e2) { fallback(slot, `the composite and its collage fallback both failed (${e2.message})`); }
    }
  }

  // scenes: a photo shoot. The set is generated styled with decoration but with no product for sale (and inspected), real products are cut out and stand on it; the props are drawn with the set.
  // A scene with real products is made the natural way when it can be: the customer's photo(s) and the director's description go to the
  // image-editing model, which makes the whole photograph; it is only used when a comparison with the real photo says the products and
  // their text are right (no missing or extra product, main names exact, score 8 or more). Otherwise the exact method below runs.
  const naturalOn = deps.naturalScenes !== false && Boolean(deps.editImage || editingAvailable()); // the lab's and the editor's "exact" mode switch it off
  async function naturalScene(slot, r) {
    const request = [r.scene, (r.props ?? []).length ? `with ${usableProps(r.props).join(', ')} around` : '', r.mood ? `${r.mood} mood` : ''].filter(Boolean).join(', ');
    const bucket = nearestAspect(slot.aspect);
    const key = crypto.createHash('sha1').update(JSON.stringify([request, r.sources, bucket])).digest('hex').slice(0, 16);
    const imgRel = `inputs/cutouts/natural-${slot.id}.jpg`; const metaRel = `inputs/cutouts/natural-${slot.id}.json`;
    let meta = exists(projectId, metaRel) ? JSON.parse(read(metaRel)) : null;
    if (!meta || meta.key !== key) {
      const done = await naturalRun({ projectId, request, products: r.sources, aspect: bucket, manifest, deps });
      const c = done.check;
      const accepted = Boolean(c && c.score >= 8 && c.mainTextMatches && !c.extraProducts && !(c.missingProducts > 0));
      meta = { key, accepted, score: c?.score ?? null, summary: done.summary };
      if (accepted) write(imgRel, done.buffer);
      write(metaRel, JSON.stringify(meta));
      if (!accepted) log.info(STAGE, `the natural picture for ${slot.id} was not used (${done.summary}); the exact method is used`);
    }
    if (!meta.accepted || !exists(projectId, imgRel)) return null;
    const { width, height } = sizeFor(slot.aspect);
    const buffer = await sharp(read(imgRel)).resize(width, height, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
    return { buffer, width, height, meta, request };
  }

  for (const slot of scenes) {
    const r = slot.recipe;
    try {
      if (r.sources.length && naturalOn) {
        try {
          const nat = await naturalScene(slot, r);
          if (nat) {
            const id = `scene-${++next.scene}`;
            manifest.assets.push(baseAsset(id, save(slot, nat.buffer), {
              category: byId.get(r.sources[0]).category, origin: 'generated', derivedFrom: [...r.sources],
              description: `A photo-shoot picture made with AI from the customer's own photo(s) (${r.sources.join(', ')}): ${r.scene}. ${nat.meta.summary} ${r.reason ?? ''}`.trim(),
              orientation: orientationOf(nat.width, nat.height), width: nat.width, height: nat.height,
              notes: `Generated scene. ${r.scene}. Mood: ${r.mood ?? ''}. Props: ${(r.props ?? []).join(', ')}. Products: ${r.sources.join(', ')}. Natural photo shoot checked against the real photo (score ${nat.meta.score}). Never a new product, logo or text.`,
            }, decided));
            slot.assignedAsset = id; made.push(id);
            continue;
          }
        } catch (e) { log.info(STAGE, `warning: the natural picture for ${slot.id} failed (${e.message}); the exact method is used`); }
      }
      const cut = [];
      for (const id of r.sources) {
        const cacheRel = `inputs/cutouts/${id}.png`;
        let item;
        if (exists(projectId, cacheRel)) { const buffer = read(cacheRel); const meta = await sharp(buffer).metadata(); item = { buffer, width: meta.width, height: meta.height, cutOff: false }; }
        else {
          const started = Date.now();
          item = await (deps.removeBackground ?? removeBackground)({ file: projectPath(projectId, byId.get(id).file), accept });
          logCall({ projectId, stage: STAGE, provider: 'fal', model: 'birefnet-v2', durationMs: Date.now() - started, costUsd: item.cost });
          if (!item.cutOff) write(cacheRel, item.buffer);
        }
        if (item.cutOff) { log.info(STAGE, `warning: the product in ${id} is cut off by its photo's own frame, so it is not placed in the scene`); continue; }
        cut.push({ id, ...item });
      }
      if (r.sources.length && !cut.length) throw new Error(`none of the products is whole inside its photo (${r.sources.join(', ')})`);

      // the set: generated empty, then inspected (no product, text or logo may have sneaked in; the table surface is located)
      const setRel = `inputs/cutouts/set-${slot.id}.jpg`;
      const metaRel = `inputs/cutouts/set-${slot.id}.json`;
      let setBuffer; let seen;
      if (exists(projectId, setRel) && exists(projectId, metaRel) && JSON.parse(read(metaRel)).scene === r.scene && JSON.stringify(JSON.parse(read(metaRel)).props ?? null) === JSON.stringify(usableProps(r.props))) { setBuffer = read(setRel); seen = JSON.parse(read(metaRel)).seen; }
      else {
        let problem = 'no attempt';
        for (let attempt = 1; attempt <= 3 && problem; attempt++) {
          const started = Date.now();
          const gen = await generate({ prompt: setPrompt({ scene: r.scene, mood: r.mood, colors: palette, strict: attempt > 1, props: usableProps(r.props) }), aspect: slot.aspect });
          logCall({ projectId, stage: STAGE, provider: 'fal', model: 'flux-2', durationMs: Date.now() - started, costUsd: gen.cost });
          seen = await (deps.inspectSet ?? inspectSet)({ projectId, buffer: gen.buffer });
          problem = setProblem(seen);
          if (problem) { log.info(STAGE, `warning: attempt ${attempt} for the scene of ${slot.id} was refused: ${problem}${seen.note ? ` (the inspector saw: ${seen.note})` : ''}`); write(`inputs/cutouts/refused-${slot.id}-${attempt}.jpg`, gen.buffer); }
          else setBuffer = gen.buffer;
        }
        if (!setBuffer) throw new Error('the generated table picture did not pass the quality check in 3 tries');
        write(setRel, setBuffer);
        write(metaRel, JSON.stringify({ scene: r.scene, props: usableProps(r.props), seen }));
      }

      // the props are part of the set picture itself (see setPrompt): nothing is pasted on top

      const look = await lookOf(setBuffer);
      const rough = await composeScene({ background: setBuffer, cutouts: cut, horizon: seen.horizon, frontEdge: seen.frontEdge ?? 1, aspect: slot.aspect, look });
      const { width, height } = rough;
      let buffer = rough.buffer; let realistic = false;
      // the pasted product looks like a collage: re-render the scene as one photograph, then put the product's own pixels back
      // (its printed words are never redrawn). Any failure keeps the plain picture.
      if (cut.length && (deps.editImage || editingAvailable())) {
        const editRel = `inputs/cutouts/edit-${slot.id}.jpg`; const editMeta = `inputs/cutouts/edit-${slot.id}.json`;
        try {
          const real = await realizeScene({
            projectId, rough: { buffer: rough.buffer, width, height },
            items: await Promise.all(cut.map(async (c, i) => ({ cutout: c.buffer, placement: rough.placements[i], photo: await sharp(projectPath(projectId, byId.get(c.id).file)).rotate().resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer() }))),
            cache: {
              read: () => (exists(projectId, editRel) && exists(projectId, editMeta) ? { ...JSON.parse(read(editMeta)), buffer: read(editRel) } : null),
              write: ({ key: k, buffer: b, verified }) => { write(editRel, b); write(editMeta, JSON.stringify({ key: k, verified })); },
            },
            deps,
          });
          for (const s of real.spent) logCall({ projectId, stage: STAGE, provider: 'fal', model: s.model, durationMs: s.ms, costUsd: s.cost });
          buffer = real.buffer; realistic = true;
        } catch (e) {
          for (const s of e.spent ?? []) logCall({ projectId, stage: STAGE, provider: 'fal', model: s.model, durationMs: s.ms, costUsd: s.cost });
          log.info(STAGE, `warning: the scene ${slot.id} could not be made photographic (${e.message}); the plain pasted picture is used`);
        }
      }
      const key = `Generated scene. ${r.scene}. Mood: ${r.mood ?? ''}. Props: ${(r.props ?? []).join(', ')}. Products: ${r.sources.join(', ')}. Never a new product, logo or text.`;
      const id = `scene-${++next.scene}`;
      manifest.assets.push(baseAsset(id, save(slot, buffer), {
        category: cut.length ? byId.get(cut[0].id).category : 'other', origin: 'generated', ...(cut.length ? { derivedFrom: cut.map((c) => c.id) } : {}),
        description: `A photo-shoot scene made with AI: ${r.scene}${cut.length ? `. The customer's real products (${cut.map((c) => c.id).join(', ')}) stand on it exactly as photographed${realistic ? ', lit and reflected as if photographed there' : ''}.` : '.'} ${r.reason ?? ''}`.trim(),
        orientation: orientationOf(width, height), width, height, notes: key,
      }, decided));
      slot.assignedAsset = id; made.push(id);
    } catch (e) {
      slot.failure = e.message; // the reason travels with the slot, so a customer can be told what to change
      log.info(STAGE, `warning: the scene for ${slot.id} failed (${e.message}); the real photos are used instead`);
      const real = r.sources.map((x) => byId.get(x)).filter(Boolean);
      try {
        if (flags.collages && real.length >= 2) {
          const { buffer, width, height } = await composeCollage({ files: real.map((a) => projectPath(projectId, a.file)), layout: 'row', aspect: slot.aspect, background });
          const id = `combo-${++next.combo}`;
          slot.recipe.type = 'collage'; slot.recipe.layout = 'row';
          manifest.assets.push(baseAsset(id, save(slot, buffer), { category: real[0].category, origin: 'collage', derivedFrom: real.map((a) => a.id), description: `A combined picture arranged from ${real.length} of the customer's own photos.`, orientation: orientationOf(width, height), width, height, notes: `Arranged from the customer's photos. Nothing was added or generated. Photos used: ${real.map((a) => a.id).join(', ')}.` }, decided));
          slot.assignedAsset = id; made.push(id);
        } else if (real.length >= 1) { slot.recipe.type = 'use'; slot.recipe.sources = [real[0].id]; slot.assignedAsset = real[0].id; }
        else fallback(slot, 'the scene failed');
      } catch (e2) { fallback(slot, `the scene and its fallback failed (${e2.message})`); }
    }
  }
  return made;
}

// the plain color behind a composite when no surface is generated: the design's background color
function background_(design, given) {
  return given ?? (/^#[0-9a-f]{6}$/i.test(design.colors?.background ?? '') ? design.colors.background : undefined);
}
