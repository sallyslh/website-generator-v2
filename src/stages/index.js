// Stage registry: stage number -> folder, input files and output files.
// Empty for now; each phase registers its stage here. test-stage, chain, eval and freeze
// work generically from this list.
//
// Entry shape:
//   1: { name: 'discovery', dir: '01-discovery', inputs: ['inputs/answers.json'], outputs: ['site-brief.json'] }
// Each stage folder has index.js (run), checks.js (runChecks) and scorecard.js (questions).

export const STAGES = {
  1: { name: 'discovery', dir: '01-discovery', inputs: ['inputs/answers.json'], outputs: ['site-brief.json'] },
  2: { name: 'assets', dir: '02-assets', inputs: ['site-brief.json', 'inputs/assets'], outputs: ['asset-manifest.json'] },
  3: { name: 'creative-director', dir: '03-creative-director', inputs: ['site-brief.json', 'asset-manifest.json'], outputs: ['design-spec.json'] },
  4: { name: 'content', dir: '04-content', inputs: ['site-brief.json', 'design-spec.json', 'asset-manifest.json'], outputs: ['content-spec.json'] },
  5: { name: 'design', dir: '05-design-stitch', inputs: ['design-spec.json', 'content-spec.json'], outputs: ['design'] },
  6: { name: 'review', dir: '06-review', inputs: ['design/design-manifest.json'], outputs: ['approved-design.json', 'review-log.json'] },
  7: { name: 'site', dir: '07-site', inputs: ['approved-design.json', 'content-spec.json', 'asset-manifest.json'], outputs: ['site'] },
  8: { name: 'features', dir: '08-features', inputs: ['site', 'site-brief.json', 'content-spec.json'], outputs: ['site'] },
  9: { name: 'qa', dir: '09-qa', inputs: ['site/dist', 'approved-design.json'], outputs: ['qa-report.json'] },
};

export function registerStage(n, definition) {
  STAGES[n] = definition;
}

export function getStage(n) {
  const stage = STAGES[n];
  if (!stage) throw new Error(`Stage ${n} is not built yet (it is not in src/stages/index.js).`);
  return stage;
}

export function stageNumbers() {
  return Object.keys(STAGES).map(Number).sort((a, b) => a - b);
}

// Loads index.js, checks.js or scorecard.js of a stage.
export async function loadStageFile(n, file) {
  const { dir } = getStage(n);
  return import(`./${dir}/${file}`);
}
