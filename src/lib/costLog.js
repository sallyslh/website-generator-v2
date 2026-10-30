// Cost log: one JSON line per external API call in projects/<id>/cost-log.jsonl.
// Prices come from PRICES in config.js. A missing price gives estimatedUsd = null (warned once).

import fs from 'node:fs';
import path from 'node:path';
import { PRICES } from '../config.js';
import { projectPath } from './project.js';
import { log } from './log.js';

const warnedModels = new Set();

function estimateUsd(model, inputTokens, outputTokens) {
  if (inputTokens == null || outputTokens == null) return null;
  const price = PRICES[model];
  if (!price) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      log.info('cost', `No price set for model "${model}" in PRICES (config.js), cost will show as n/a.`);
    }
    return null;
  }
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// Appends one entry. Pass provider "stitch" with null tokens for Stitch calls.
export function logCall({ projectId, stage, provider = 'anthropic', model, inputTokens = null, outputTokens = null, durationMs, costUsd = null }) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    provider,
    model,
    inputTokens,
    outputTokens,
    durationMs,
    estimatedUsd: costUsd ?? estimateUsd(model, inputTokens, outputTokens), // costUsd: a priced call that has no tokens (image generation)
  };
  const file = projectPath(projectId, 'cost-log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

export function readCostLog(projectId) {
  const file = projectPath(projectId, 'cost-log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Groups entries per stage: { stage, calls, inputTokens, outputTokens, durationMs, usd, usdKnown }.
export function summarize(entries) {
  const rows = new Map();
  for (const e of entries) {
    const row = rows.get(e.stage) || { stage: e.stage, calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, usd: 0, usdKnown: true };
    row.calls += 1;
    row.inputTokens += e.inputTokens || 0;
    row.outputTokens += e.outputTokens || 0;
    row.durationMs += e.durationMs || 0;
    // entries saved before a price existed are priced now; Stitch calls (no tokens) are free in Google Labs
    const price = PRICES[e.model];
    const usd = e.estimatedUsd ?? (price && e.inputTokens != null ? (e.inputTokens * price.input + (e.outputTokens || 0) * price.output) / 1_000_000 : null);
    if (usd == null && e.provider !== 'stitch') row.usdKnown = false;
    else row.usd += usd ?? 0;
    rows.set(e.stage, row);
  }
  return [...rows.values()];
}

export function totalOf(rows) {
  return rows.reduce(
    (t, r) => ({
      stage: 'TOTAL',
      calls: t.calls + r.calls,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      durationMs: t.durationMs + r.durationMs,
      usd: t.usd + r.usd,
      usdKnown: t.usdKnown && r.usdKnown,
    }),
    { stage: 'TOTAL', calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, usd: 0, usdKnown: true },
  );
}

const usdText = (r) => (r.usdKnown ? `$${r.usd.toFixed(4)}` : r.usd > 0 ? `>=$${r.usd.toFixed(4)}` : 'n/a');

// Prints the table used by the `cost` command.
export function printCostTable(projectId) {
  const rows = summarize(readCostLog(projectId));
  if (!rows.length) return console.log(`No API calls logged yet for project "${projectId}".`);
  const line = (r) =>
    [r.stage.padEnd(14), String(r.calls).padStart(5), String(r.inputTokens).padStart(10), String(r.outputTokens).padStart(10),
      `${(r.durationMs / 1000).toFixed(1)}s`.padStart(9), usdText(r).padStart(10)].join(' ');
  console.log(['stage'.padEnd(14), 'calls'.padStart(5), 'in tokens'.padStart(10), 'out tokens'.padStart(10), 'time'.padStart(9), 'cost'.padStart(10)].join(' '));
  rows.forEach((r) => console.log(line(r)));
  console.log(line(totalOf(rows)));
}

// One-line summary of the calls a stage made since a start time: "3.2s, 1 API calls, $0.0100".
export function stageSummary(projectId, stage, sinceIso, durationMs) {
  const rows = summarize(readCostLog(projectId).filter((e) => e.stage === stage && e.at >= sinceIso));
  const t = totalOf(rows);
  return `${(durationMs / 1000).toFixed(1)}s, ${t.calls} API calls, ${usdText(t)}`;
}
