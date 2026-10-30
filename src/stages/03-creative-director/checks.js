// Automatic quality checks for Stage 3 (no LLM). Each check returns { name, ok, details }.
// checkDesign is pure (unit tested); runChecks loads the project files.
// compareDirections prints several businesses side by side and flags look-alikes.

import { exists, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { crossCheck } from '../../schemas/crossChecks.js';
import { fontNameOf, isBannedFont } from './fonts.js';
import { hasOverlay } from './compose.js';
import { subjectProblems, MAX_ATMOSPHERE_PER_SITE } from '../../lib/imageGen.js';
import { isSerifFont, fontTier, fontFitsBusiness } from './fontCatalog.js';

const HEX = /^#[0-9a-f]{6}$/i;
const slotsOf = (design) => design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));

export function checkDesign(rawDesign, brief, manifest) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const parsed = designSpecSchema.safeParse(rawDesign);
  check('schema valid', parsed.success, parsed.success ? '' : parsed.error.issues.map((i) => i.path.join('.')).join(', '));
  if (!parsed.success) return results;
  const design = parsed.data;

  const problems = crossCheck({ brief, assets: manifest, design });
  const lowUsed = slotsOf(design).filter((s) => manifest.assets.find((a) => a.id === s.assignedAsset)?.quality === 'low').map((s) => s.id);
  check('pages match the brief, slot ids unique, assigned assets exist', problems.length === 0, problems.join('; '));
  check('no low quality asset is assigned', lowUsed.length === 0, lowUsed.join(', '));

  const roles = Object.values(design.colors);
  check('the five colors are valid hex codes', roles.every((c) => HEX.test(c)), roles.filter((c) => !HEX.test(c)).join(', '));
  const brandHex = brief.brand.colors.filter((c) => HEX.test(c)).slice(0, 5);
  const missing = brandHex.filter((c) => !roles.some((r) => r.toLowerCase() === c.toLowerCase()));
  check('brand hex colors from the brief are used', missing.length === 0, brandHex.length ? `missing: ${missing.join(', ')}` : 'brief has no hex brand colors (nothing to test)');

  // an asset used twice while an unused usable asset of the same category is left
  const usage = new Map();
  for (const s of slotsOf(design)) {
    if (s.assignedAsset) usage.set(s.assignedAsset, (usage.get(s.assignedAsset) ?? 0) + 1);
    for (const id of s.recipe?.type === 'collage' ? s.recipe.sources : []) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  const reused = [];
  for (const [id, count] of usage) {
    if (count < 2) continue;
    const category = manifest.assets.find((a) => a.id === id)?.category;
    const spare = manifest.assets.filter((a) => a.category === category && a.quality !== 'low' && a.kind !== 'logo' && !usage.has(a.id));
    if (spare.length) reused.push(`${id} used ${count}x while ${spare.map((a) => a.id).join(', ')} unused`);
  }
  check('warning only: a photo reused while unused photos of its category remain (reuse is allowed when it is the best real photo)', true, reused.join('; ') || 'none');

  // each assigned photo must fit its slot: category, shape, and Stage 2's warnings must reach the design
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const wrongCategory = [];
  const wrongShape = [];
  const unhandled = [];
  const riskyHero = [];
  for (const page of design.pages)
    for (const section of page.sections)
      for (const slot of section.slots) {
        const asset = slot.assignedAsset ? byId.get(slot.assignedAsset) : null;
        if (!asset) continue;
        if (slot.preferredCategory && slot.preferredCategory !== asset.category && asset.origin !== 'generated') wrongCategory.push(`${slot.id} wants ${slot.preferredCategory}, got ${asset.category}`);
        const [w, h] = (slot.aspect || '').split(':').map(Number);
        if (w && h) {
          const want = w / h > 1.2 ? 'landscape' : w / h < 0.85 ? 'portrait' : 'square';
          if (asset.orientation !== want && !/crop|column|tall|narrow|band|strip/i.test(section.layoutNotes)) wrongShape.push(`${slot.id} is ${slot.aspect} but ${asset.id} is ${asset.orientation}`);
        }
        const text = `${section.layoutNotes} ${slot.description}`;
        if (/\b(counter|watermark|badge|slideshow)\b|overlay (is|in|badge)|\d\/\d/i.test(asset.notes) && !asset.overlayRemoved && !/crop|cut|trim|remove|mask/i.test(text)) unhandled.push(`${slot.id}: ${asset.id} has an overlay to remove but the design does not say so`);
        if (/third-party|rights|authentic/i.test(asset.notes)) {
          if (!/rights|authentic|third-party|permission|licen|confirm/i.test(text)) unhandled.push(`${slot.id}: ${asset.id} has a rights warning that the design does not mention`);
          const cleaner = manifest.assets.some((a) => a.id !== asset.id && a.category === asset.category && a.quality !== 'low' && a.kind !== 'logo' && !/third-party|rights|authentic/i.test(a.notes));
          if (section.type === 'hero' && cleaner) riskyHero.push(`${slot.id} uses ${asset.id} (rights warning) although a cleaner photo exists`);
        }
      }
  check('assigned photos match the slot category', wrongCategory.length === 0, wrongCategory.join('; '));
  check('assigned photos fit the slot shape (or the design explains the crop)', wrongShape.length === 0, wrongShape.join('; '));
  check('warnings from Stage 2 (overlays, rights) are handled in the design', unhandled.length === 0, unhandled.join('; '));
  check('the hero does not use a photo with a rights warning when a cleaner one exists', riskyHero.length === 0, riskyHero.join('; '));

  // the image plan: every picture is backed by real photos
  const badRecipes = [];
  const badCombos = [];
  const needPhoto = [];
  const names = [brief.business.name, ...brief.offerings.map((o) => o.name)];
  const badMood = [];
  let atmosphereCount = 0;
  for (const slot of slotsOf(design)) {
    const r = slot.recipe;
    if (!r) { badRecipes.push(`${slot.id}: no recipe`); continue; }
    if (r.type === 'use' && !(slot.assignedAsset && r.sources.length === 1 && r.sources[0] === slot.assignedAsset)) badRecipes.push(`${slot.id}: "use" must name the assigned photo`);
    if (r.type === 'needs-photo') { needPhoto.push(slot.id); if (slot.assignedAsset || r.sources.length) badRecipes.push(`${slot.id}: "needs-photo" must have no photo`); }
    if (r.type === 'crop') {
      const piece = byId.get(slot.assignedAsset);
      if (r.sources.length !== 1 || !r.target) badRecipes.push(`${slot.id}: a crop needs one photo and a target`);
      else if (piece?.origin !== 'crop' || piece.derivedFrom?.[0] !== r.sources[0]) badRecipes.push(`${slot.id}: the cropped picture was not built from ${r.sources[0]}`);
      else if (!byId.has(r.sources[0]) || byId.get(r.sources[0]).kind === 'logo' || byId.get(r.sources[0]).derivedFrom) badCombos.push(`${slot.id}: ${r.sources[0]} is not one of the customer's own photos`);
    }
    if (r.type === 'composite') {
      const comp = byId.get(slot.assignedAsset);
      if (r.sources.length < 2 || r.sources.length > 3) badRecipes.push(`${slot.id}: a composite needs 2 or 3 photos`);
      else if (comp?.origin !== 'composite') badRecipes.push(`${slot.id}: the composite picture was not built`);
      else {
        if (JSON.stringify([...comp.derivedFrom].sort()) !== JSON.stringify([...r.sources].sort()) && !comp.derivedFrom.every((id) => r.sources.includes(id))) badCombos.push(`${slot.id}: built from other photos than planned`);
        for (const id of comp.derivedFrom) if (!byId.has(id) || byId.get(id).kind === 'logo' || byId.get(id).derivedFrom) badCombos.push(`${slot.id}: ${id} is not one of the customer's own photos`);
        if (comp.approval === 'rejected') badCombos.push(`${slot.id}: the customer rejected this composite picture`);
      }
    }
    if (r.type === 'scene') {
      atmosphereCount++;
      const sc = byId.get(slot.assignedAsset);
      if (sc?.origin !== 'generated') badRecipes.push(`${slot.id}: the scene was not built`);
      else if (r.sources.length && !(sc.derivedFrom ?? []).every((id) => r.sources.includes(id))) badCombos.push(`${slot.id}: the scene shows other products than planned`);
      for (const id of sc?.derivedFrom ?? []) if (!byId.has(id) || byId.get(id).kind === 'logo' || byId.get(id).derivedFrom || byId.get(id).origin) badCombos.push(`${slot.id}: ${id} is not one of the customer's own photos`);
      for (const p of subjectProblems(`${r.scene ?? ''} ${(r.props ?? []).join(' ')}`, names)) badMood.push(`${slot.id}: ${p}`);
    }
    if (r.type === 'atmosphere') {
      atmosphereCount++;
      const mood = byId.get(slot.assignedAsset);
      if (mood?.origin !== 'generated') badRecipes.push(`${slot.id}: the atmosphere picture was not built`);
      for (const p of subjectProblems(r.subject, names)) badMood.push(`${slot.id}: ${p}`);
    }
    if (r.type === 'collage') {
      const combo = byId.get(slot.assignedAsset);
      if (r.sources.length < 2) badRecipes.push(`${slot.id}: a collage needs 2 or more photos`);
      if (!combo?.derivedFrom) badRecipes.push(`${slot.id}: the combined picture was not built`);
      else {
        if (JSON.stringify([...combo.derivedFrom].sort()) !== JSON.stringify([...r.sources].sort())) badCombos.push(`${slot.id}: built from other photos than planned`);
        for (const id of combo.derivedFrom) if (!byId.has(id) || byId.get(id).kind === 'logo' || byId.get(id).derivedFrom) badCombos.push(`${slot.id}: ${id} is not one of the customer's own photos`);
        for (const id of combo.derivedFrom) if (hasOverlay(byId.get(id))) badCombos.push(`${slot.id}: ${id} has a counter, watermark or overlay that would stay visible`);
        if (combo.approval === 'rejected') badCombos.push(`${slot.id}: the customer rejected this combined picture`);
      }
    }
  }
  // the owner's wishes: each one gets an honest answer, and "only my own photos" is respected
  const wishText = (brief.wishes?.home ?? '').trim();
  const answered = design.wishResponses ?? [];
  check('the owner\'s wishes for the home page were answered one by one (used / adapted / declined, with a reason)', !wishText || (answered.length > 0 && answered.every((w) => w.how.trim().length > 8)), wishText ? `${answered.length} answer(s) for the wishes: "${wishText.slice(0, 80)}"` : 'the owner gave no wishes (nothing to answer)');
  const generatedKinds = slotsOf(design).filter((s) => ['scene', 'atmosphere', 'composite'].includes(s.recipe?.type)).map((s) => s.id);
  check('the owner asked for only their own photos: no scene, atmosphere or composite was planned', brief.wishes?.aiPictures !== 'photos-only' || generatedKinds.length === 0, generatedKinds.join(', '));

  // frames follow the photos: a frame that cuts away a lot of its photo is worth a second look (informational)
  const cutsMuch = [];
  for (const slot of slotsOf(design)) {
    const photo = byId.get(slot.assignedAsset);
    const [sw, sh] = (slot.aspect || '').split(':').map(Number);
    if (!photo || photo.origin || !sw || !sh) continue;
    const [a, b] = [photo.width / photo.height, sw / sh];
    const loss = 1 - Math.min(a, b) / Math.max(a, b);
    if (loss > 0.25) cutsMuch.push(`${slot.id} (photo ${photo.width}x${photo.height} in a ${slot.aspect} frame loses ${(loss * 100).toFixed(0)}%)`);
  }
  check('warning only: frames that would cut away more than a quarter of their photo', true, cutsMuch.length ? cutsMuch.join('; ') : 'none');
  check('every image slot has a recipe (use / crop / collage / composite / scene / atmosphere / needs-photo) that matches what it is assigned', badRecipes.length === 0, badRecipes.join('; '));
  if (atmosphereCount > MAX_ATMOSPHERE_PER_SITE) badMood.push(`${atmosphereCount} atmosphere pictures, at most ${MAX_ATMOSPHERE_PER_SITE} are allowed`);
  check('generated atmosphere pictures show only a raw material or quiet scene: never a product, person, place, logo or text', badMood.length === 0, badMood.join('; '));
  check('combined pictures are made only from the customer\'s own photos', badCombos.length === 0, badCombos.join('; '));
  check('photo slots still waiting for a photo (informational)', true, needPhoto.length ? needPhoto.join(', ') : 'none');

  // the "not AI-generated" rules: no default AI fonts, and a signature idea that can grow later
  const fonts = [fontNameOf(design.typography.headings), fontNameOf(design.typography.body)];
  const bannedFonts = fonts.filter(isBannedFont);
  check('no font that every AI website uses', bannedFonts.length === 0, bannedFonts.length ? `banned: ${bannedFonts.join(', ')}` : fonts.join(' + '));
  check('headings are not a serif font (a known AI tell): designed lettering instead', !isSerifFont(fonts[0]), isSerifFont(fonts[0]) ? `${fonts[0]} is a serif` : fonts[0]);
  const businessText = `${brief.business.type} ${brief.business.description} ${brief.business.name} ${brief.audience.description}`;
  check('professional first: the heading font suits this business (playful or hand-drawn fonts only for businesses that are)', fontFitsBusiness(fonts[0], businessText), `${fonts[0]} is ${fontTier(fonts[0])} tier for a ${brief.business.type || 'business'}`);
  check('the lettering has a reason tied to the business', Boolean(design.typography.reason && design.typography.reason.length > 15), design.typography.reason ?? 'missing typography.reason');
  check('headings and body use two different fonts', fonts[0].toLowerCase() !== fonts[1].toLowerCase(), fonts.join(' / '));
  const sig = design.signature;
  check('has a signature visual idea with 2+ placements and 2+ interactions for later', Boolean(sig) && sig.placements.length >= 2 && sig.interactions.length >= 2,
    sig ? `${sig.name}: ${sig.placements.length} placements, ${sig.interactions.length} interactions` : 'missing: add one so the site does not look generic');

  const words = design.styleBlock.trim().split(/\s+/).length;
  check('styleBlock is at most 150 words', words <= 150, `${words} words`);
  const ids = design.pages.flatMap((p) => p.sections.map((s) => s.id));
  check('section ids are unique', new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(', '));
  check('fonts name real fonts in headings and body', design.typography.headings.length > 2 && design.typography.body.length > 2);
  check('avoid list keeps the default items', design.avoid.length >= 6, `${design.avoid.length} items`);
  return results;
}

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'design-spec.json')) throw new Error(`Missing design-spec.json in "${projectId}". Run: node src/cli.js direct --project ${projectId}`);
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  return checkDesign(readJson(projectId, 'design-spec.json'), brief, manifest);
}

const firstFont = (text) => (text.match(/[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*/g) || [text]).find((w) => !/^(Serif|Sans|Large|Clean|Body|Display|Headings?|Bold|Light|Regular)/i.test(w)) ?? text;

// Prints a side-by-side summary and flags projects that share fonts or style.
export function compareDirections(projectIds) {
  const rows = projectIds.map((id) => {
    const d = readJson(id, 'design-spec.json', designSpecSchema);
    return { id, style: d.direction.style, summary: d.direction.summary, colors: Object.values(d.colors).join(' '), headings: firstFont(d.typography.headings), body: firstFont(d.typography.body) };
  });
  const flags = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const [a, b] = [rows[i], rows[j]];
      if (a.headings.toLowerCase() === b.headings.toLowerCase()) flags.push(`${a.id} and ${b.id} share the heading font "${a.headings}"`);
      if (a.style.toLowerCase() === b.style.toLowerCase()) flags.push(`${a.id} and ${b.id} share the style "${a.style}"`);
    }
  return { rows, flags };
}
