// Stage 4: content generation. Input: site-brief.json, design-spec.json, asset-manifest.json.
// Output: content-spec.json. One LLM call for the global parts and one per page, merged into one file.
// With --page <slug> only that page is rewritten and merged into the existing file.

import { z } from 'zod';
import { askJson } from '../../lib/llm.js';
import { exists, readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { contentSpecSchema, globalSchema, pageSchema } from '../../schemas/contentSpec.js';
import { crossCheck } from '../../schemas/crossChecks.js';
import { log } from '../../lib/log.js';
import { stageSummary } from '../../lib/costLog.js';
import { WRITER_SYSTEM, globalPrompt, pagePrompt } from './prompts.js';
import { NEEDS_MARKER } from './rules.js';
import { fillListedSections, dishProblems } from './dishLists.js';

const STAGE = 'content';
const PARALLEL = 3;

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

// Section ids and slot alt texts must match the design exactly; asks once more if not.
function pageProblems(design, page) {
  const designPage = design.pages.find((p) => p.slug === page.slug);
  const problems = [];
  const want = designPage.sections.map((s) => s.id);
  const got = page.sections.map((s) => s.id);
  if (want.join('|') !== got.join('|')) problems.push(`sections must be exactly ${JSON.stringify(want)} in this order, you wrote ${JSON.stringify(got)}`);
  for (const section of designPage.sections) {
    const written = page.sections.find((s) => s.id === section.id);
    for (const slot of section.slots)
      if (!written?.imageAlt?.[slot.id]?.trim()) problems.push(`section ${section.id} needs imageAlt for slot ${slot.id}`);
  }
  return problems;
}

async function writePage({ projectId, brief, design, manifest, page, global, feedback }) {
  let problems = [];
  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote = problems.length ? `\n\nYOUR PREVIOUS ANSWER HAD THESE PROBLEMS, FIX THEM:\n- ${problems.join('\n- ')}` : '';
    result = await askJson({
      projectId, stage: STAGE, system: WRITER_SYSTEM, schema: pageSchema, maxTokens: 6000,
      prompt: pagePrompt({ brief, design, manifest, page, global, feedback }) + retryNote,
    });
    result.slug = page.slug;
    const designPage = design.pages.find((p) => p.slug === page.slug);
    const structural = pageProblems(design, result);
    // how well the writer placed the dishes is only a hint for the first retry: code adds any forgotten dish, so it never fails a page
    const hint = attempt === 1 ? dishProblems({ brief, designPage, page: result }) : [];
    problems = [...structural, ...hint];
    if (!structural.length && (!hint.length || attempt === 2)) {
      const placed = fillListedSections({ brief, designPage, page: result });
      if (placed.length) log.info(STAGE, `page ${page.slug}: ${placed.length} dish(es) the writer left out were added from the owner's list`);
      return result;
    }
    log.info(STAGE, `page ${page.slug} attempt ${attempt}: ${problems.join('; ')}`);
  }
  throw new Error(`Page "${page.slug}" does not match the design after a retry:\n- ${problems.join('\n- ')}`);
}

// Lists every "NEEDS:" line so the customer knows what to provide.
export function needsList(content) {
  return content.pages.flatMap((p) => p.sections.flatMap((s) => (s.body ?? []).filter((b) => b.trim().startsWith(NEEDS_MARKER)).map((b) => `${s.id}: ${b.trim().slice(NEEDS_MARKER.length).trim()}`)));
}

export function printContent(content, slug) {
  const pages = slug ? content.pages.filter((p) => p.slug === slug) : content.pages.filter((p) => p.slug === 'home');
  console.log(`\nSite: ${content.global.siteTitle} | CTA: ${content.global.primaryCta.label} -> ${content.global.primaryCta.target} | nav: ${content.global.navigation.map((n) => n.label).join(', ')}`);
  for (const page of pages) {
    console.log(`\nPage ${page.slug}  [${page.seo.title}]`);
    for (const s of page.sections) {
      console.log(`  ${s.id}: ${s.heading}${s.subheading ? ` | ${s.subheading}` : ''}`);
      s.body.forEach((b) => console.log(`      ${b}`));
      s.items.forEach((i) => console.log(`      - ${i.title}: ${i.text}`));
      if (s.cta) console.log(`      [${s.cta.label} -> ${s.cta.target}]`);
    }
  }
  const needs = needsList(content);
  if (needs.length) console.log(`\nStill needed from the customer:\n${needs.map((n) => `  - ${n}`).join('\n')}`);
}

export async function run({ projectId, options = {} }) {
  const started = Date.now();
  const since = new Date().toISOString();
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const manifest = exists(projectId, 'asset-manifest.json')
    ? readJson(projectId, 'asset-manifest.json', assetManifestSchema)
    : { schemaVersion: 1, assets: [], logo: null, documents: [], gaps: [] };
  const problems = crossCheck({ brief, design });
  if (problems.length) throw new Error(`site-brief.json and design-spec.json do not match:\n- ${problems.join('\n- ')}\nRun the creative director again.`);

  const existing = exists(projectId, 'content-spec.json') ? readJson(projectId, 'content-spec.json', contentSpecSchema) : null;
  const { feedback, page: onlyPage } = options;
  if (onlyPage && !existing) throw new Error('--page needs an existing content-spec.json. Run the stage without --page first.');
  if (onlyPage && !brief.pages.some((p) => p.slug === onlyPage)) throw new Error(`Unknown page "${onlyPage}".`);

  const global = onlyPage ? existing.global : await askJson({
    projectId, stage: STAGE, system: WRITER_SYSTEM, prompt: globalPrompt({ brief, design, manifest, feedback }), schema: globalSchema, maxTokens: 1500,
  });
  const toWrite = brief.pages.filter((p) => !onlyPage || p.slug === onlyPage);
  const written = await mapLimit(toWrite, PARALLEL, (page) => writePage({ projectId, brief, design, manifest, page, global, feedback }));

  const pages = brief.pages.map((p) => written.find((w) => w.slug === p.slug) ?? existing.pages.find((e) => e.slug === p.slug));
  const content = { schemaVersion: 1, language: brief.language, global, pages };
  writeJson(projectId, 'content-spec.json', content, contentSpecSchema);
  printContent(content, onlyPage);
  log.info(STAGE, `content-spec.json written. ${stageSummary(projectId, STAGE, since, Date.now() - started)}`);
}
