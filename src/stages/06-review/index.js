// Stage 6: review. Records which sketch the customer chose, approves the pages, and writes approved-design.json.
//   review --sketch 1|2 [--note "..."]   the home page is approved in the chosen style (sketch 1 = creative director,
//                                        sketch 2 = Stitch creative on its own). The other pages are then generated
//                                        with: design --rest   (in the chosen style)
//   review --approve-all                 approves the other pages and writes approved-design.json (when every page exists)
// A customer choice saved by the customer page (customer-choice.json) is picked up automatically.

import fs from 'node:fs';
import { exists, projectPath, readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
import { designManifestSchema, freestyleSchema } from '../../schemas/designManifest.js';
import { approvedDesignSchema } from '../../schemas/approvedDesign.js';
import { reviewLogSchema } from '../../schemas/reviewLog.js';
import { log } from '../../lib/log.js';

const STAGE = 'review';
const LOG_FILE = 'review-log.json';

const readLog = (projectId) => (exists(projectId, LOG_FILE) ? readJson(projectId, LOG_FILE, reviewLogSchema) : []);
function appendLog(projectId, entries) {
  const at = new Date().toISOString();
  writeJson(projectId, LOG_FILE, [...readLog(projectId), ...entries.map((e) => ({ at, ...e }))], reviewLogSchema);
}

// The customer (or you) chooses sketch 1 or 2: the home page is approved in that style.
export function chooseSketch(projectId, { choice, note = '' }) {
  if (![1, 2].includes(Number(choice))) throw new Error('Choose sketch 1 or 2.');
  const picked = Number(choice);
  const manifest = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  const home = manifest.pages.find((p) => p.slug === 'home');
  if (!home) throw new Error('There is no home page yet. Generate the two sketches first.');
  if (picked === 2) {
    if (!exists(projectId, 'design/freestyle/meta.json')) throw new Error('Sketch 2 has not been generated yet.');
    manifest.freestyle = freestyleSchema.parse(JSON.parse(fs.readFileSync(projectPath(projectId, 'design/freestyle/meta.json'), 'utf8')));
  }
  const changedStyle = manifest.chosenSketch !== null && manifest.chosenSketch !== picked;
  manifest.chosenSketch = picked;
  home.status = 'approved';
  // other pages made in the other style no longer match
  if (changedStyle) for (const p of manifest.pages) if (p.slug !== 'home') p.status = 'changes-requested';
  writeJson(projectId, 'design/design-manifest.json', manifest, designManifestSchema);
  appendLog(projectId, [{ page: 'home', decision: 'approve', comment: note.trim() || `Chose sketch ${picked}` }]);
  if (exists(projectId, 'approved-design.json') && changedStyle) fs.rmSync(projectPath(projectId, 'approved-design.json')); // it described the old style
  return { chosenSketch: picked, changedStyle };
}

// What the approved page of a slug is: for the home page of sketch 2, the freestyle files.
function approvedPage(manifest, slug) {
  const page = manifest.pages.find((p) => p.slug === slug);
  if (slug === 'home' && manifest.chosenSketch === 2) {
    const f = manifest.freestyle;
    return { slug, screenId: f.screenId, html: f.html, screenshot: f.screenshot };
  }
  return { slug, screenId: page.screenId, html: page.html, screenshot: page.screenshot };
}

// Approves the remaining pages and writes approved-design.json, but only when EVERY page exists.
export function approvePages(projectId) {
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const manifest = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  if (!manifest.chosenSketch) throw new Error('Choose sketch 1 or 2 first (review --sketch).');
  const missing = brief.pages.map((p) => p.slug).filter((slug) => !manifest.pages.some((p) => p.slug === slug));
  if (missing.length) throw new Error(`These pages are not generated yet: ${missing.join(', ')}. Run: node src/cli.js design --project ${projectId} --rest`);
  const outdated = manifest.pages.filter((p) => p.status === 'changes-requested').map((p) => p.slug);
  if (outdated.length) throw new Error(`These pages are in the old style and must be generated again: ${outdated.join(', ')}. Run: node src/cli.js design --project ${projectId} --rest`);

  const newlyApproved = manifest.pages.filter((p) => p.status !== 'approved');
  for (const p of manifest.pages) p.status = 'approved';
  writeJson(projectId, 'design/design-manifest.json', manifest, designManifestSchema);
  if (newlyApproved.length) appendLog(projectId, newlyApproved.map((p) => ({ page: p.slug, decision: 'approve', comment: 'Approved in the chosen style' })));

  const slotAssets = {};
  for (const page of design.pages) for (const section of page.sections) for (const slot of section.slots) slotAssets[slot.id] = slot.assignedAsset;
  const notes = [...new Set(readLog(projectId).map((e) => e.comment).filter((c) => c && !/^Chose sketch \d$|^Approved in the chosen style$/.test(c)))];
  const approved = {
    schemaVersion: 1,
    approvedAt: new Date().toISOString(),
    pages: brief.pages.map((p) => approvedPage(manifest, p.slug)),
    slotAssets,
    reviewNotes: notes,
  };
  writeJson(projectId, 'approved-design.json', approved, approvedDesignSchema);
  return approved;
}

export async function run({ projectId, options = {} }) {
  const manifest = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  let choice = options.choice;
  let note = options.note ?? '';
  if (!choice && !manifest.chosenSketch && exists(projectId, 'customer-choice.json')) {
    const saved = JSON.parse(fs.readFileSync(projectPath(projectId, 'customer-choice.json'), 'utf8'));
    choice = saved.choice;
    note = saved.note ?? '';
    log.info(STAGE, `using the customer's choice: sketch ${choice}`);
  }
  if (choice) {
    const r = chooseSketch(projectId, { choice, note });
    log.info(STAGE, `sketch ${r.chosenSketch} chosen, the home page is approved.${r.changedStyle ? ' The style changed, so the other pages must be generated again.' : ''}`);
  }
  const current = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  if (!current.chosenSketch) throw new Error('Nothing is chosen yet. Use: review --sketch 1|2 (or let the customer choose on the customer page).');
  if (options.approveAll) {
    const approved = approvePages(projectId);
    log.info(STAGE, `approved-design.json written: ${approved.pages.length} pages approved in sketch ${current.chosenSketch} style.`);
    return;
  }
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const todo = brief.pages.map((p) => p.slug).filter((slug) => !current.pages.some((p) => p.slug === slug && p.status !== 'changes-requested'));
  log.info(STAGE, todo.length
    ? `Next: generate the other pages (${todo.join(', ')}): node src/cli.js design --project ${projectId} --rest`
    : `All pages exist. Next: look at them, then approve: node src/cli.js review --project ${projectId} --approve-all`);
}
