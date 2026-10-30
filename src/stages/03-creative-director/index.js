// Stage 3: creative director. Input: site-brief.json + asset-manifest.json. Output: design-spec.json.
// The LLM decides the direction and structure; code then enforces the rules (real pages, real assets,
// no low-quality assets) and asks for one correction if the page list is wrong.

import { askJson } from '../../lib/llm.js';
import { exists, readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { crossCheck } from '../../schemas/crossChecks.js';
import { log } from '../../lib/log.js';
import { stageSummary } from '../../lib/costLog.js';
import { DIRECTOR_SYSTEM, directorPrompt } from './prompts.js';
import { normalizeRecipes, composeImages } from './compose.js';
import { cleanOverlays } from './cleanOverlays.js';
import { generationAvailable } from '../../lib/imageGen.js';
import { makeConcept } from './concept.js';

const STAGE = 'direct';

// Page problems the LLM must fix (it is asked once more). Asset problems are fixed by code.
function pageProblems(brief, design) {
  return crossCheck({ brief, design }).filter((p) => /page|duplicate slot/i.test(p));
}

// Sets assignments to null when the asset does not exist or is low quality. Returns warnings.
export function fixAssignments(design, manifest) {
  const warnings = [];
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  for (const page of design.pages)
    for (const section of page.sections)
      for (const slot of section.slots) {
        const asset = slot.assignedAsset ? byId.get(slot.assignedAsset) : null;
        if (slot.assignedAsset && !asset) warnings.push(`slot ${slot.id}: asset ${slot.assignedAsset} does not exist, set to null`);
        else if (asset?.quality === 'low') warnings.push(`slot ${slot.id}: asset ${asset.id} is low quality, set to null`);
        else continue;
        slot.assignedAsset = null;
      }
  return warnings;
}

export function printDesign(design) {
  console.log(`\nDirection: ${design.direction.summary}`);
  console.log(`  style: ${design.direction.style} | mood: ${design.direction.mood.join(', ')}`);
  console.log(`  colors: ${Object.entries(design.colors).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  console.log(`  fonts: headings ${design.typography.headings} | body ${design.typography.body}`);
  console.log(`  layout: ${design.layout.principles.join('; ')}`);
  for (const page of design.pages) {
    console.log(`  page ${page.slug}:`);
    for (const s of page.sections) {
      const slots = s.slots.map((sl) => `${sl.id}->${sl.assignedAsset ?? 'PLACEHOLDER'}`).join(', ');
      console.log(`    - ${s.id} (${s.type})${slots ? `  [${slots}]` : ''}`);
    }
  }
  console.log(`  avoid: ${design.avoid.join('; ')}`);
}

export async function run({ projectId, options = {} }) {
  const started = Date.now();
  const since = new Date().toISOString();
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const manifest = exists(projectId, 'asset-manifest.json')
    ? readJson(projectId, 'asset-manifest.json', assetManifestSchema)
    : (log.info(STAGE, 'No asset-manifest.json: designing with an empty one, all image slots become placeholders.'),
      { schemaVersion: 1, assets: [], logo: null, documents: [], gaps: [] });

  // counters / watermarks drawn on the customer's photos are cropped away first, so the photos can be used everywhere
  if (manifest.assets.length) {
    const overlays = await cleanOverlays({ projectId, manifest });
    if (overlays.cleaned.length && exists(projectId, 'asset-manifest.json')) writeJson(projectId, 'asset-manifest.json', manifest, assetManifestSchema);
  }

  // one art-direction concept for this business: several are written, judged on taste, and the best-quality one that is also the least typical is chosen
  const concept = await makeConcept({ projectId, brief, manifest, force: Boolean(options.redoConcept) });

  let design;
  let problems = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    design = await askJson({
      projectId, stage: STAGE, system: DIRECTOR_SYSTEM,
      prompt: directorPrompt({ brief, manifest, feedback: options.feedback, problems, concept }), schema: designSpecSchema, maxTokens: 12000,
    });
    problems = pageProblems(brief, design);
    if (!problems.length) break;
    log.info(STAGE, `Attempt ${attempt} had page problems: ${problems.join('; ')}`);
  }
  if (problems.length) throw new Error(`Design spec does not match the brief pages after a retry:\n- ${problems.join('\n- ')}`);

  fixAssignments(design, manifest).forEach((w) => log.info(STAGE, `warning: ${w}`));
  const names = [brief.business.name, ...brief.offerings.map((o) => o.name)];
  normalizeRecipes(design, manifest, { generation: generationAvailable() && brief.wishes?.aiPictures !== 'photos-only', names }).forEach((w) => log.info(STAGE, `warning: ${w}`));
  // combined pictures are built from the customer's real photos and become ordinary assets
  const combined = await composeImages({ projectId, design, manifest, background: /^#[0-9a-f]{6}$/i.test(design.colors.background) ? design.colors.background : undefined, palette: [design.colors.primary, design.colors.background].filter((c) => /^#[0-9a-f]{6}$/i.test(c)) });
  if (exists(projectId, 'asset-manifest.json') || combined.length) writeJson(projectId, 'asset-manifest.json', manifest, assetManifestSchema);
  if (combined.length) log.info(STAGE, `${combined.length} combined picture(s) arranged from the customer's own photos: ${combined.join(', ')}. The customer must approve them.`);
  writeJson(projectId, 'design-spec.json', design, designSpecSchema);
  printDesign(design);
  log.info(STAGE, `design-spec.json written. ${stageSummary(projectId, STAGE, since, Date.now() - started)}`);
}
