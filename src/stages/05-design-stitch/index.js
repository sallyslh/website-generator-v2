// Stage 5: UI design with Google Stitch. Input: site-brief.json, design-spec.json, content-spec.json.
// Output: design/ (HTML + screenshots) and design/design-manifest.json.
//   design                 -> home page + 1 variant (two options), then stop for review; --variants <n> changes the number
//   design --all           -> EVERY page of the site in the creative director's style (home first), in one run
//   design --page <slug>   -> one page, no variants
//   design --rest          -> every page that is not generated yet (home must be approved first)
//   design --baseline      -> A/B test: home from the brief only (no creative director, no copy)
//   design --freestyle     -> home from our real copy + image frames but NO creative-director style (Stitch picks the look)
//   design --lean          -> home from the brief + image facts computed by code (no creative director, no copy)

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { designManifestSchema } from '../../schemas/designManifest.js';
import { crossCheck } from '../../schemas/crossChecks.js';
import { log } from '../../lib/log.js';
import { stageSummary } from '../../lib/costLog.js';
import { createProject, generateScreen, generateVariants, downloadTo } from './stitchClient.js';
import { repairFolder } from './repairHtml.js';
import { applyRealPhotos } from './realPhotos.js';
import { fitCollages } from './fitCollages.js';
import { buildPagePrompt, buildBaselinePrompt, buildLeanPrompt, buildFreeStylePrompt, imageFrames, homeNoteFrom } from './prompts.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';

const STAGE = 'design';
const MANIFEST = 'design/design-manifest.json';
const DEFAULT_VARIANTS = 0; // the two sketches are made with --sketches (creative director + Stitch on its own); at most 1 extra variant
const VARIANT_PROMPT = 'Explore clearly different layouts and color schemes for this page. Keep exactly the same text, sections and the same overall style direction.';

const emptyManifest = () => ({ schemaVersion: 1, stitchProjectId: null, designSystemId: null, pages: [] });

async function saveScreen(projectId, screen, htmlFile, imageFile) {
  await downloadTo(screen.htmlUrl, projectPath(projectId, htmlFile));
  // exactly what Stitch drew, kept untouched (before our repairs and before the customer's photos are put in)
  const original = projectPath(projectId, htmlFile.replace(/^design\//, 'design/original/'));
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.copyFileSync(projectPath(projectId, htmlFile), original);
  const fixed = repairFolder(projectPath(projectId, 'design'));
  if (fixed) log.info(STAGE, `repaired ${fixed} bare image address(es) in the HTML`);
  await fitCollages(projectId); // collages take the shape of the frames Stitch drew
  const photos = applyRealPhotos(projectId);
  if (photos) log.info(STAGE, `put the customer's real photos into ${photos} image frame(s)`);
  await downloadTo(screen.imageUrl, projectPath(projectId, imageFile));
}

// Stitch has a time limit per page (about 5 minutes). A page that times out or is "unavailable" is asked again with a smaller sample of
// each long list (the finished site repeats the rows from the owner's list anyway); only then is the failure reported.
const STITCH_TOO_BIG = /timed out|unavailable|deadline|-32001/i;
export async function generateScreenSmaller({ projectId, stitchProjectId, prompt, mode, again, ask = generateScreen, wait = 20_000 }) {
  try { return await ask(projectId, stitchProjectId, prompt); }
  catch (err) {
    if (mode === 'free' || !STITCH_TOO_BIG.test(String(err.message))) throw err;
    for (const sample of [3, 2]) {
      const smaller = again(sample);
      if (smaller.length >= prompt.length) continue;
      log.info(STAGE, `Stitch could not finish this page in time (${err.message}); trying again with ${sample} rows per list`);
      try { return await ask(projectId, stitchProjectId, smaller); } catch (e) { if (!STITCH_TOO_BIG.test(String(e.message))) throw e; }
    }
    // a short outage of the service: one more try of the same page after a pause
    if (/unavailable/i.test(String(err.message))) {
      log.info(STAGE, `Stitch is unavailable; trying the same page again in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      return ask(projectId, stitchProjectId, prompt);
    }
    throw err;
  }
}

async function generatePage({ projectId, stitchProjectId, manifest, inputs, slug, homeNote, variants, mode = 'guided' }) {
  // mode "free": the page is made in sketch 2's own Stitch project, so it shares that look, with our real text and photo slots
  const prompt = mode === 'free'
    ? `${buildFreeStylePrompt({ ...inputs, slug })}
Use exactly the same visual style, header and footer as the other pages of this project.`
    : buildPagePrompt({ ...inputs, slug, homeNote });
  log.info(STAGE, `page ${slug}: prompt is ${prompt.length} characters`);
  const screen = await generateScreenSmaller({ projectId, stitchProjectId, prompt, mode, again: (sample) => buildPagePrompt({ ...inputs, slug, homeNote, sample }) });
  await saveScreen(projectId, screen, `design/${slug}.html`, `design/${slug}.png`);
  const entry = {
    slug, screenId: screen.screenId, html: `design/${slug}.html`, screenshot: `design/${slug}.png`,
    variants: [], promptUsed: prompt, status: 'generated',
  };
  manifest.pages = [...manifest.pages.filter((p) => p.slug !== slug), entry];
  writeJson(projectId, MANIFEST, manifest, designManifestSchema); // the main screen is kept even if variants fail
  if (slug === 'home' && variants > 0) {
    log.info(STAGE, `generating ${variants} variant${variants > 1 ? 's' : ''} of the home page (this takes a while)...`);
    for (const v of await generateVariants(projectId, stitchProjectId, screen.screenId, VARIANT_PROMPT, { count: variants })) {
      const html = `design/variants/${slug}-${v.screenId}.html`;
      const image = `design/variants/${slug}-${v.screenId}.png`;
      await saveScreen(projectId, v, html, image);
      entry.variants.push({ screenId: v.screenId, html, screenshot: image });
    }
  }
  manifest.pages = [...manifest.pages.filter((p) => p.slug !== slug), entry];
  writeJson(projectId, MANIFEST, manifest, designManifestSchema);
  log.info(STAGE, `page ${slug}: saved ${1 + entry.variants.length} screens`);
}

export const MAX_VARIANTS_PER_PAGE = 1;

// Another version of ONE page (the customer asks for it): Stitch draws a clearly different layout and colour scheme with the same text.
// The new version is saved next to the page; nothing is replaced until the customer chooses it (swapVersion).
export async function addVariant({ projectId, slug, deps = {} }) {
  const manifest = readJson(projectId, MANIFEST, designManifestSchema);
  const entry = manifest.pages.find((p) => p.slug === slug);
  if (!entry) throw new Error(`Unknown page "${slug}".`);
  if (entry.variants.length >= MAX_VARIANTS_PER_PAGE) throw new Error('This page already has another version.');
  log.info(STAGE, `page ${slug}: drawing another version (about two minutes)...`);
  const made = await (deps.generateVariants ?? generateVariants)(projectId, manifest.stitchProjectId, entry.screenId, VARIANT_PROMPT, { count: 1 });
  if (!made.length) throw new Error('Stitch did not return another version of this page.');
  const html = `design/variants/${slug}-${made[0].screenId}.html`;
  const image = `design/variants/${slug}-${made[0].screenId}.png`;
  await (deps.save ?? saveScreen)(projectId, made[0], html, image);
  entry.variants.push({ screenId: made[0].screenId, html, screenshot: image });
  writeJson(projectId, MANIFEST, manifest, designManifestSchema);
  return entry.variants.length;
}

// The customer prefers the other version: the page and that version trade places in the design list. Files stay where they are, and the
// later steps follow the list, so the chosen version is the one that is approved and built.
export function swapVersion({ projectId, slug, screenId }) {
  const manifest = readJson(projectId, MANIFEST, designManifestSchema);
  const entry = manifest.pages.find((p) => p.slug === slug);
  const other = entry?.variants.find((v) => v.screenId === screenId);
  if (!entry || !other) throw new Error('That version was not found.');
  for (const key of ['screenId', 'html', 'screenshot']) [entry[key], other[key]] = [other[key], entry[key]];
  writeJson(projectId, MANIFEST, manifest, designManifestSchema);
}

// Brief-only designs for the A/B tests. Each one gets its own Stitch project (projects share context, which would contaminate the test).
async function runSimple({ projectId, brief, kind }) {
  let prompt = buildBaselinePrompt(brief);
  if (kind === 'freestyle') {
    const design = readJson(projectId, 'design-spec.json', designSpecSchema);
    const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
    prompt = buildFreeStylePrompt({ brief, design, content });
  }
  if (kind === 'lean') {
    const manifest = exists(projectId, 'asset-manifest.json') ? readJson(projectId, 'asset-manifest.json', assetManifestSchema) : { assets: [], logo: null };
    prompt = buildLeanPrompt(brief, manifest);
    fs.mkdirSync(projectPath(projectId, 'design/lean'), { recursive: true });
    fs.writeFileSync(projectPath(projectId, 'design/lean/frames.json'), JSON.stringify(imageFrames(manifest), null, 2)); // photo-N -> asset id
  }
  log.info(STAGE, `${kind} prompt (${prompt.length} characters):
${prompt}`);
  const freshProjectId = await createProject(projectId, `${brief.business.name} ${kind} (${projectId})`);
  const screen = await generateScreen(projectId, freshProjectId, prompt);
  await saveScreen(projectId, screen, `design/${kind}/home-${kind}.html`, `design/${kind}/home-${kind}.png`);
  fs.writeFileSync(projectPath(projectId, `design/${kind}/prompt.txt`), prompt);
  if (kind === 'freestyle')
    fs.writeFileSync(projectPath(projectId, 'design/freestyle/meta.json'), JSON.stringify({ stitchProjectId: freshProjectId, screenId: screen.screenId, html: 'design/freestyle/home-freestyle.html', screenshot: 'design/freestyle/home-freestyle.png', promptUsed: prompt }, null, 2));
  log.info(STAGE, `saved design/${kind}/home-${kind}.html`);
}

export async function run({ projectId, options = {} }) {
  const started = Date.now();
  const since = new Date().toISOString();
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  if (options.baseline || options.lean || options.freestyle) {
    await runSimple({ projectId, brief, kind: options.freestyle ? 'freestyle' : options.lean ? 'lean' : 'baseline' });
    return log.info(STAGE, `done. ${stageSummary(projectId, STAGE, since, Date.now() - started)}`);
  }
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const problems = crossCheck({ brief, design, content });
  if (problems.length) throw new Error(`The spec files do not match each other:\n- ${problems.join('\n- ')}`);

  const manifest = exists(projectId, MANIFEST) ? readJson(projectId, MANIFEST, designManifestSchema) : emptyManifest();
  if (!manifest.stitchProjectId) {
    manifest.stitchProjectId = await createProject(projectId, `${brief.business.name} (${projectId})`);
    writeJson(projectId, MANIFEST, manifest, designManifestSchema); // saved at once, so a crash never loses the id
    log.info(STAGE, `created Stitch project ${manifest.stitchProjectId}`);
  }
  const base = { projectId, stitchProjectId: manifest.stitchProjectId, manifest, inputs: { brief, design, content } };

  {
    const home = manifest.pages.find((p) => p.slug === 'home');
    let slugs;
    if (options.rest) {
      if (home?.status !== 'approved') throw new Error(`The home page must be chosen first. Run: node src/cli.js review --project ${projectId} --sketch 1|2`);
      if (manifest.chosenSketch === 2 && !manifest.freestyle) throw new Error('Sketch 2 was chosen but its Stitch project is unknown. Run the review step again.');
      slugs = brief.pages.map((p) => p.slug).filter((s) => !manifest.pages.some((p) => p.slug === s && p.status !== 'changes-requested'));
    } else if (options.all) {
      // the whole website at once (home first, so the other pages can follow its header and footer)
      slugs = [...brief.pages.map((p) => p.slug)].sort((a, b) => (a === 'home' ? -1 : b === 'home' ? 1 : 0));
    } else if (options.page) {
      if (!brief.pages.some((p) => p.slug === options.page)) throw new Error(`Unknown page "${options.page}".`);
      slugs = [options.page];
    } else slugs = ['home'];

    const free = options.rest && manifest.chosenSketch === 2;
    for (const slug of slugs)
      await generatePage({ ...base, ...(free ? { stitchProjectId: manifest.freestyle.stitchProjectId, mode: 'free' } : {}), slug, homeNote: slug === 'home' ? '' : homeNoteFrom(design), variants: Math.min(1, Number(options.variants ?? DEFAULT_VARIANTS)) });
    if (slugs.includes('home') && !options.rest) log.info(STAGE, `Home page ready. Next: review it (Stage 6), then: design --project ${projectId} --rest`);
  }
  log.info(STAGE, `done. ${stageSummary(projectId, STAGE, since, Date.now() - started)}`);
}
