// Stage 9: QA. Checks the BUILT site (no AI, no cost) and writes projects/<id>/qa-report.json.
//   qa --project <id>     opens every page in a headless browser at phone and laptop width and checks structure, links,
//                         weight, motion and readability. Failing checks are listed with what to fix; "warning only" ones are advice.
// The report decides nothing by itself: the delivery step (Stage 10) refuses a site whose report has failures.

import fs from 'node:fs';
import { projectPath } from '../../lib/project.js';
import { log } from '../../lib/log.js';
import { checkQa, loadBuild } from './checks.js';
import { inspectInBrowser } from './browser.js';
import { planRepairs, saveRepairs, parseColor, fixColor } from '../../lib/repairs.js';

const STAGE = 'qa';

// Opens every page and checks it. Text that is too faint to read is repaired automatically (same hue, just dark or light enough, written as
// an inline colour and remembered in repairs.json), then the pages are measured again so the report shows the repaired state.
// deps.inspect replaces the browser in tests.
export async function run({ projectId, deps = {} }) {
  log.info(STAGE, 'checking the built site (this opens each page in a browser, about a minute)...');
  const inspect = deps.inspect ?? inspectInBrowser;
  const measure = async () => { const build = await loadBuild(projectId); return { build, browser: await inspect({ distDir: build.dist, routes: build.pages.map((p) => p.route) }) }; };
  let { build, browser } = await measure();
  const offenders = (browser?.pages ?? []).flatMap((p) => ['desktop', 'mobile'].flatMap((v) => p[v]?.contrastAll ?? []));
  let repaired = [];
  if (offenders.length) {
    const items = planRepairs(offenders);
    saveRepairs(projectId, items);
    repaired = Object.values(items).map((it) => ({ text: it.text, was: `${it.was.ratio}:1`, color: it.color }));
    log.info(STAGE, `repaired ${repaired.length} text(s) that were too faint to read: ${repaired.slice(0, 5).map((r) => `"${r.text}" (${r.was} -> ${r.color})`).join('; ')}`);
    ({ build, browser } = await measure());
  }
  const results = checkQa({ ...build, browser });
  const failures = results.filter((r) => !r.ok);
  const warnings = results.filter((r) => r.ok && /^warning only:/.test(r.name) && r.details && !/^(nothing to report|all slots)/.test(r.details));
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: failures.length === 0, total: results.length, repaired, failures, warnings, results };
  fs.writeFileSync(projectPath(projectId, 'qa-report.json'), JSON.stringify(report, null, 2));
  for (const f of failures) log.info(STAGE, `FAIL  ${f.name}${f.details ? `: ${f.details}` : ''}`);
  for (const w of warnings) log.info(STAGE, `note  ${w.name.replace('warning only: ', '')}: ${w.details}`);
  log.info(STAGE, failures.length ? `${failures.length} problem(s) to fix (see qa-report.json).` : `the site passed all ${results.filter((r) => !/^warning only:/.test(r.name)).length} checks.`);
  return report;
}
