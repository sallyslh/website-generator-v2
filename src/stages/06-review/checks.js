// Automatic quality checks for Stage 6 (no LLM). Each check returns { name, ok, details }.

import { exists, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { designManifestSchema } from '../../schemas/designManifest.js';
import { approvedDesignSchema } from '../../schemas/approvedDesign.js';
import { reviewLogSchema } from '../../schemas/reviewLog.js';
import fs from 'node:fs';
import { projectPath } from '../../lib/project.js';

export function checkReview({ brief, design, assets, manifest, approved, reviewLog, fileExists }) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const slugs = brief.pages.map((p) => p.slug);

  check('a sketch was chosen (1 or 2)', manifest.chosenSketch === 1 || manifest.chosenSketch === 2);
  check('every page of the brief is approved', slugs.every((s) => approved.pages.some((p) => p.slug === s)) && approved.pages.length === slugs.length,
    slugs.filter((s) => !approved.pages.some((p) => p.slug === s)).join(', '));
  const home = approved.pages.find((p) => p.slug === 'home');
  const expectedHome = manifest.chosenSketch === 2 ? manifest.freestyle?.html : manifest.pages.find((p) => p.slug === 'home')?.html;
  check('the home page is the chosen sketch', Boolean(home) && home.html === expectedHome, `approved ${home?.html}, expected ${expectedHome}`);
  const missingFiles = approved.pages.filter((p) => !fileExists(p.html)).map((p) => p.html);
  check('every approved page file exists', missingFiles.length === 0, missingFiles.join(', '));
  const unapproved = manifest.pages.filter((p) => p.status !== 'approved').map((p) => p.slug);
  check('no page is waiting for changes', unapproved.length === 0, unapproved.join(', '));
  const unlogged = slugs.filter((s) => !reviewLog.some((e) => e.page === s && e.decision === 'approve'));
  check('the review log has an approval for every page', unlogged.length === 0, unlogged.join(', '));

  const slots = design.pages.flatMap((p) => p.sections.flatMap((s) => s.slots));
  const assetIds = new Set(assets.assets.map((a) => a.id));
  const wrong = slots.filter((s) => !(s.id in approved.slotAssets) || (approved.slotAssets[s.id] !== null && !assetIds.has(approved.slotAssets[s.id]))).map((s) => s.id);
  check('every photo slot is mapped to a real asset or null', wrong.length === 0, wrong.join(', '));
  return results;
}

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'approved-design.json')) throw new Error(`Missing approved-design.json in "${projectId}". Run: node src/cli.js review --project ${projectId} --approve-all`);
  return checkReview({
    brief: readJson(projectId, 'site-brief.json', siteBriefSchema),
    design: readJson(projectId, 'design-spec.json', designSpecSchema),
    assets: readJson(projectId, 'asset-manifest.json', assetManifestSchema),
    manifest: readJson(projectId, 'design/design-manifest.json', designManifestSchema),
    approved: readJson(projectId, 'approved-design.json', approvedDesignSchema),
    reviewLog: exists(projectId, 'review-log.json') ? readJson(projectId, 'review-log.json', reviewLogSchema) : [],
    fileExists: (f) => fs.existsSync(projectPath(projectId, f)),
  });
}
