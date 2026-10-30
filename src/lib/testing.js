// Logic behind the testing commands: test-stage (isolated), chain, eval, freeze.
// Works for any stage through the registry in src/stages/index.js.

import fs from 'node:fs';
import path from 'node:path';
import { projectPath, exists } from './project.js';
import { BUSINESSES_ROOT, freezeStage, loadGolden } from './golden.js';
import { appendRow, askScorecard, average, printChecks } from './evalReport.js';
import { readCostLog, summarize, totalOf } from './costLog.js';
import { getStage, loadStageFile, stageNumbers } from '../stages/index.js';
import { log } from './log.js';
import { enrich, confirmProposals } from '../stages/01-discovery/enrich.js';

export function listBusinesses() {
  if (!fs.existsSync(BUSINESSES_ROOT)) return [];
  return fs.readdirSync(BUSINESSES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// "all" -> every test business, otherwise the one named (must exist).
export function resolveBusinesses(name) {
  const all = listBusinesses();
  if (name === 'all') return all;
  if (!all.includes(name)) throw new Error(`Unknown business "${name}". Available: ${all.join(', ')}`);
  return [name];
}

const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const metaPath = (id) => projectPath(id, 'meta.json');
export const readMeta = (id) => (fs.existsSync(metaPath(id)) ? JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) : null);

// Creates a fresh project from a test business's raw inputs (answers + assets).
function createProject(business, mode, n) {
  const tag = mode === 'isolated' ? `s${n}` : `chain${n}`;
  const projectId = `${business}-${tag}-${timestamp()}`;
  const source = path.join(BUSINESSES_ROOT, business);
  fs.mkdirSync(projectPath(projectId, 'inputs'), { recursive: true });
  fs.copyFileSync(path.join(source, 'answers.json'), projectPath(projectId, 'inputs', 'answers.json'));
  if (fs.existsSync(path.join(source, 'assets'))) fs.cpSync(path.join(source, 'assets'), projectPath(projectId, 'inputs', 'assets'), { recursive: true });
  fs.writeFileSync(metaPath(projectId), JSON.stringify({ business, mode, stage: n }, null, 2));
  return projectId;
}

async function runStage(n, projectId) {
  const started = Date.now();
  const { run } = await loadStageFile(n, 'index.js');
  await run({ projectId, options: {} });
  log.info(`stage ${n}`, `done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// ISOLATED: golden outputs of earlier stages + raw inputs -> run only stage n.
export async function testStage(n, businessName) {
  getStage(n);
  const created = [];
  for (const business of resolveBusinesses(businessName)) {
    const projectId = createProject(business, 'isolated', n);
    loadGolden(business, projectId, n, { stageNumbers: stageNumbers() });
    log.info('test-stage', `${projectId}: running stage ${n} only`);
    await runStage(n, projectId);
    created.push(projectId);
  }
  return created;
}

// Between stage 2 and 3 the brief is completed from the customer's files (test mode accepts every proposal).
async function fillBriefFromFiles(projectId) {
  log.info('chain', `${projectId}: filling the brief from the files (all proposals auto-accepted in test mode)`);
  await enrich({ projectId });
  await confirmProposals({ projectId, acceptAll: true });
}

// CHAIN: raw inputs only -> run stages 1..n in order. Stops at the first failure.
export async function chain(n, businessName) {
  getStage(n);
  const created = [];
  for (const business of resolveBusinesses(businessName)) {
    const projectId = createProject(business, 'chain', n);
    for (const k of stageNumbers().filter((s) => s <= n)) {
      log.info('chain', `${projectId}: stage ${k}`);
      await runStage(k, projectId);
      if (k === 2 && n >= 3) await fillBriefFromFiles(projectId);
    }
    created.push(projectId);
  }
  return created;
}

function showOutputs(n, projectId) {
  for (const file of getStage(n).outputs) {
    if (!exists(projectId, file)) continue;
    const full = projectPath(projectId, file);
    if (fs.statSync(full).isFile()) console.log(`\n--- ${file} ---\n${fs.readFileSync(full, 'utf8')}`);
    else console.log(`\n--- ${file}/ (folder) ---`);
  }
}

const costText = (projectId) => {
  const t = totalOf(summarize(readCostLog(projectId)));
  return t.usdKnown ? `$${t.usd.toFixed(4)}` : 'n/a';
};

// Auto checks, then the human scorecard, then one row in evals/stage-0n.md.
export async function evalStage(n, projectId) {
  getStage(n);
  const { runChecks } = await loadStageFile(n, 'checks.js');
  const { questions } = await loadStageFile(n, 'scorecard.js');
  const meta = readMeta(projectId);

  console.log(`\nAutomatic checks for stage ${n} (${projectId}):`);
  const checks = printChecks(await runChecks({ projectId }));
  showOutputs(n, projectId);

  console.log('\nScorecard (1 = bad, 5 = excellent):');
  const { scores, comments } = await askScorecard(questions);
  const file = appendRow(n, { project: projectId, mode: meta?.mode ?? 'manual', checks, scores, comments, cost: costText(projectId) });
  console.log(`\nAverage ${average(scores).toFixed(1)}. Saved to ${file}`);
}

export function freeze(n, projectId, businessOverride) {
  const business = businessOverride || readMeta(projectId)?.business;
  if (!business) throw new Error('Cannot tell which test business this project belongs to. Pass --business <name>.');
  const files = freezeStage(n, projectId, business);
  log.info('freeze', `stage ${n} frozen for "${business}": ${files.join(', ')}`);
}
