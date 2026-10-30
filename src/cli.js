// Command-line entry point: node src/cli.js <command> ...
// Stage commands are added phase by phase; testing commands work for any registered stage.

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { config, mask } from './config.js';
import { log } from './lib/log.js';
import { exists, readJson, setProjectsRoot, projectPath } from './lib/project.js';
import { FILES } from './schemas/index.js';
import { crossCheck } from './schemas/crossChecks.js';
import { askJson } from './lib/llm.js';
import { printCostTable } from './lib/costLog.js';
import { interview } from './stages/01-discovery/interview.js';
import { useAnswersFile } from './stages/01-discovery/interview.js';
import { run as runBrief } from './stages/01-discovery/index.js';
import { enrich, confirmProposals } from './stages/01-discovery/enrich.js';
import { run as runDirect } from './stages/03-creative-director/index.js';
import { compareDirections } from './stages/03-creative-director/checks.js';
import { run as runContent } from './stages/04-content/index.js';
import { run as runDesign } from './stages/05-design-stitch/index.js';
import { buildPreview, openFile } from './stages/05-design-stitch/preview.js';
import { measureProject, printMetricsTable } from './stages/05-design-stitch/metrics.js';
import { run as runReview } from './stages/06-review/index.js';
import { run as runSite } from './stages/07-site/index.js';
import { run as runFeatures } from './stages/08-features/index.js';
import { run as runQa } from './stages/09-qa/index.js';
import { run as runAssistant } from './stages/10-assistant/index.js';
import { run as runWow, loadType } from './wow/run.js';
import { draftType, archiveAndReplace, hasType, TIER_LABELS, tierOf } from './wow/typeResearch.js';
import { saveLogo } from './wow/brand.js';
import { structureSite, buildSite } from './wow/structure.js';
import { translateProject } from './wow/translate.js';
import { run as runAssets } from './stages/02-assets/index.js';
import { chain, evalStage, freeze, testStage } from './lib/testing.js';

const program = new Command();
program.name('website-builder').description('AI website builder pipeline');

program
  .command('hello')
  .description('Print the current config (keys masked)')
  .action(() => {
    log.info('hello', 'Config loaded:');
    console.log({
      anthropicApiKey: mask(config.anthropicApiKey),
      anthropicModel: config.anthropicModel,
      stitchApiKey: mask(config.stitchApiKey),
      formEndpoint: config.formEndpoint || '(not set)',
    });
  });

program
  .command('validate')
  .description('Validate every JSON file of a project and run cross-file checks')
  .requiredOption('--project <id>', 'project id')
  .option('--root <dir>', 'folder that contains the project (default: projects/)')
  .action((opts) => {
    if (opts.root) setProjectsRoot(opts.root);
    const id = opts.project;
    let failed = false;
    const loaded = {};
    for (const [file, { schema }] of Object.entries(FILES)) {
      if (!exists(id, file)) {
        console.log(`  -  ${file} (not created yet)`);
        continue;
      }
      try {
        loaded[file] = readJson(id, file, schema);
        console.log(`  ok ${file}`);
      } catch (err) {
        failed = true;
        console.log(`  XX ${err.message}`);
      }
    }
    const problems = crossCheck({
      brief: loaded['site-brief.json'],
      assets: loaded['asset-manifest.json'],
      design: loaded['design-spec.json'],
      content: loaded['content-spec.json'],
    });
    if (problems.length) failed = true;
    for (const p of problems) console.log(`  XX cross-check: ${p}`);
    if (!problems.length) console.log('  ok cross-checks');
    log.info('validate', failed ? 'FAILED' : 'all green');
    if (failed) process.exitCode = 1;
  });

program
  .command('cost')
  .description('Cost table per stage')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => printCostTable(opts.project));

program
  .command('llm-test')
  .description('Smoke test: ask Claude for a tiny JSON object and print the cost')
  .action(async () => {
    const projectId = 'llm-test';
    const schema = z.object({ greeting: z.string(), number: z.number() });
    const data = await askJson({
      projectId,
      stage: 'llm-test',
      prompt: 'Return a JSON object with a short "greeting" string and a "number" field equal to 7.',
      schema,
      maxTokens: 200,
    });
    log.info('llm-test', `Claude answered: ${JSON.stringify(data)}`);
    printCostTable(projectId);
  });

program
  .command('test-stage <n>')
  .description('ISOLATED test: golden inputs of earlier stages, run only stage n')
  .requiredOption('--business <name>', 'test business name or "all"')
  .action(async (n, opts) => {
    const ids = await testStage(Number(n), opts.business);
    log.info('test-stage', `created: ${ids.join(', ')}`);
    log.info('test-stage', `next: node src/cli.js eval ${n} --project <id>`);
  });

program
  .command('chain <n>')
  .description('CHAIN test: raw inputs, run stages 1..n')
  .requiredOption('--business <name>', 'test business name or "all"')
  .action(async (n, opts) => {
    const ids = await chain(Number(n), opts.business);
    log.info('chain', `created: ${ids.join(', ')}`);
  });

program
  .command('eval <n>')
  .description('Automatic checks + human scorecard, appended to evals/stage-0n.md')
  .requiredOption('--project <id>', 'project id')
  .action((n, opts) => evalStage(Number(n), opts.project));

program
  .command('freeze <n>')
  .description("Copy stage n's approved output into test-businesses/<name>/golden/")
  .requiredOption('--project <id>', 'project id')
  .option('--business <name>', 'test business (default: read from the project)')
  .action((n, opts) => freeze(Number(n), opts.project, opts.business));

program
  .command('discover')
  .description('Stage 1A: interview the customer in the terminal')
  .requiredOption('--project <id>', 'project id')
  .option('--from-answers <file>', 'skip the interview and use an existing answers file')
  .action(async (opts) => {
    if (opts.fromAnswers) return useAnswersFile(opts.project, opts.fromAnswers);
    await interview(opts.project);
  });

program
  .command('brief')
  .description('Stage 1B: build site-brief.json from the interview answers')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => runBrief({ projectId: opts.project, options: {} }));

program
  .command('assets')
  .description('Stage 2: analyze the customer files in inputs/assets/')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => runAssets({ projectId: opts.project, options: {} }));

program
  .command('enrich')
  .description('Propose empty brief fields from the analyzed files (needs site-brief.json + asset-manifest.json)')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => enrich({ projectId: opts.project }));

program
  .command('confirm')
  .description('Accept or reject the proposals saved by enrich; accepted ones are merged into the brief')
  .requiredOption('--project <id>', 'project id')
  .option('--accept-all', 'accept every proposal without asking (tests)')
  .action((opts) => confirmProposals({ projectId: opts.project, acceptAll: Boolean(opts.acceptAll) }));

program
  .command('direct')
  .description('Stage 3: creative director, writes design-spec.json')
  .requiredOption('--project <id>', 'project id')
  .option('--feedback <text>', 'reviewer feedback to apply')
  .action((opts) => runDirect({ projectId: opts.project, options: { feedback: opts.feedback } }));

program
  .command('compare-directions')
  .description('Show the design directions of several projects side by side')
  .requiredOption('--projects <ids>', 'comma-separated project ids')
  .action((opts) => {
    const { rows, flags } = compareDirections(opts.projects.split(','));
    for (const r of rows) {
      console.log(`\n${r.id}`);
      console.log(`  style:   ${r.style}`);
      console.log(`  summary: ${r.summary}`);
      console.log(`  colors:  ${r.colors}`);
      console.log(`  fonts:   ${r.headings} / ${r.body}`);
    }
    if (flags.length) console.log(`\nFLAGS:\n  - ${flags.join('\n  - ')}`);
    else console.log('\nNo two projects share heading font or style.');
  });

program
  .command('content')
  .description('Stage 4: write the website copy, writes content-spec.json')
  .requiredOption('--project <id>', 'project id')
  .option('--page <slug>', 'rewrite only this page')
  .option('--feedback <text>', 'reviewer feedback to apply')
  .action((opts) => runContent({ projectId: opts.project, options: { page: opts.page, feedback: opts.feedback } }));

program
  .command('design')
  .description('Stage 5: design the pages with Google Stitch (the home page by default; --sketches makes the two sketches)')
  .requiredOption('--project <id>', 'project id')
  .option('--page <slug>', 'generate one page')
  .option('--rest', 'generate every remaining page (home must be approved)')
  .option('--all', 'generate EVERY page of the site in one run, in the creative-director style')
  .option('--sketches', 'make the TWO sketches: with the creative director + Stitch creative on its own')
  .option('--variants <n>', 'extra variants of the home page (0 or 1, default 0)')
  .option('--baseline', 'A/B test: home from the brief only')
  .option('--lean', 'A/B test: home from the brief + image facts computed by code')
  .option('--freestyle', 'A/B test: our real copy and image frames, but Stitch picks the style')
  .action((opts) => opts.sketches
    ? Promise.all([runDesign({ projectId: opts.project, options: { variants: 0 } }), runDesign({ projectId: opts.project, options: { freestyle: true } })])
    : runDesign({ projectId: opts.project, options: { page: opts.page, rest: opts.rest, all: opts.all, variants: opts.variants, baseline: opts.baseline, lean: opts.lean, freestyle: opts.freestyle } }));

program
  .command('preview')
  .description('Build design/preview.html (all Stitch pages side by side) and open it in the browser')
  .requiredOption('--project <id>', 'project id')
  .option('--no-open', 'only build the file')
  .action((opts) => {
    const file = buildPreview(opts.project);
    log.info('preview', file);
    if (opts.open) openFile(file);
  });

program
  .command('design-metrics')
  .description('Score every Stitch version of the home page with the same metrics (image areas, exact copy, colors, invented text)')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => {
    const results = measureProject(opts.project);
    if (!results.length) return console.log('No Stitch pages found in this project.');
    printMetricsTable(results);
  });

program
  .command('review')
  .description('Stage 6: record the chosen sketch (1 or 2), then approve the pages')
  .requiredOption('--project <id>', 'project id')
  .option('--sketch <n>', 'the sketch that was chosen: 1 (creative director) or 2 (Stitch on its own)')
  .option('--note <text>', 'the customer note')
  .option('--approve-all', 'approve every page and write approved-design.json')
  .action((opts) => runReview({ projectId: opts.project, options: { choice: opts.sketch ? Number(opts.sketch) : undefined, note: opts.note, approveAll: opts.approveAll } }));

program
  .command('site')
  .description('Stage 7: build the real website (Astro + Tailwind) from the approved design')
  .requiredOption('--project <id>', 'project id')
  .option('--build', 'also install and build the site (site/dist)')
  .action((opts) => runSite({ projectId: opts.project, options: { build: opts.build } }));

program
  .command('assistant')
  .description('Stage 10: prepare the website assistant (facts, knowledge from the uploaded files, the owner\'s rules)')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => runAssistant({ projectId: opts.project }));

program
  .command('features')
  .description('Stage 8: connect the contact form, add the map and the booking button to the generated site')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => runFeatures({ projectId: opts.project }));

program
  .command('qa')
  .description('Stage 9: check the built site (structure, links, weight, motion, phone layout, readability) and write qa-report.json')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => runQa({ projectId: opts.project }));

program
  .command('wow')
  .description('Generate-first draft: creative brief, Stitch draws every page freely, static site in projects/<id>/wow-site')
  .requiredOption('--project <id>', 'project id')
  .option('--name <text>', 'business name')
  .option('--type <id>', 'business type file in src/data/business-types (for example padel)')
  .option('--pages <list>', 'comma-separated page ids (default: the default pages of the type)')
  .option('--language <text>', 'language of the site', 'English')
  .option('--step <step>', 'brief | design | assemble (default: all)')
  .option('--concurrency <n>', 'pages drawn at the same time', '2')
  .option('--redo-brief', 'write the creative brief again')
  .option('--no-upscale', 'keep the pictures at the size Stitch gives (no paid upscale)')
  .option('--no-responsive', 'skip the responsive redesign of every page (one model call per page)')
  .option('--no-device-check', 'skip the check of every page at phone, tablet, laptop and TV widths (it takes a few minutes)')
  .option('--logo <file>', 'the owner\'s logo (a picture file): the website is built to match it')
  .option('--brand-colors <text>', 'the owner\'s brand colours, as names or codes')
  .option('--look <look>', 'how adventurous the look is: classic | modern | bold (default: the kind of business decides; a dentist is classic)')
  .option('--notes <text>', 'what the owner likes, in their own words (for example: bright colours, nothing too dark)')
  .action(async (opts) => {
    if (opts.logo) { const ext = path.extname(opts.logo).slice(1).toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml'); await saveLogo(opts.project, `data:image/${ext};base64,${fs.readFileSync(opts.logo).toString('base64')}`); }
    return runWow({ projectId: opts.project, options: { name: opts.name, type: opts.type, pages: opts.pages ? opts.pages.split(',').map((s) => s.trim()) : undefined, language: opts.language, step: opts.step, concurrency: opts.concurrency, redoBrief: opts.redoBrief, upscale: opts.upscale, deviceCheck: opts.deviceCheck, responsive: opts.responsive, brandColors: opts.brandColors, look: opts.look, notes: opts.notes } });
  });

program
  .command('structure')
  .description('Journey step 4: turn the lists of cards of an approved generated site into editable data (writes projects/<id>/wow-structure; the site itself is not changed)')
  .requiredOption('--project <id>', 'project id')
  .action(async (opts) => {
    const report = await structureSite({ dir: projectPath(opts.project, 'wow-site'), projectId: opts.project });
    for (const p of report.pages) console.log(`${p.page}: ${p.verified ? `${p.lists} lists, ${p.items} items${p.names.length ? ` | ${p.names.join(', ')}` : ''}` : 'NOT converted (rebuilt page differs)'}`);
    console.log(`\n${report.lists} lists with ${report.items} items over ${report.pages.length} pages${report.notVerified.length ? `; not converted: ${report.notVerified.join(' | ')}` : '; every converted page rebuilds exactly'}`);
  });

program
  .command('translate')
  .description('Translate a drawn website into another language as a NEW project (the text is translated, the design stays; Arabic, Persian and Urdu mirror the layout)')
  .requiredOption('--project <id>', 'the project to translate')
  .requiredOption('--to <language>', 'for example Arabic, French, Spanish')
  .option('--as <id>', 'the new project id (default: <id>-<language code>)')
  .action(async (opts) => {
    const newId = opts.as ?? `${opts.project}-${opts.to.toLowerCase().slice(0, 2)}`;
    const report = await translateProject({ from: opts.project, to: newId, language: opts.to, log: (m) => console.log('  ' + m) });
    console.log(`translated ${report.translated} of ${report.pieces} pieces on ${report.pages.length} pages into ${opts.to}; building project ${newId}...`);
    const meta = JSON.parse(fs.readFileSync(projectPath(newId, 'wow.json'), 'utf8'));
    await runWow({ projectId: newId, options: { name: meta.name, type: meta.type, pages: meta.pages, language: opts.to, step: 'assemble' } });
  });

program
  .command('build-structured')
  .description('Journey step 4/5: build the final site from the structured pages and their data (projects/<id>/wow-structure) into projects/<id>/wow-built')
  .requiredOption('--project <id>', 'project id')
  .action((opts) => {
    const r = buildSite({ dir: projectPath(opts.project, 'wow-site'), structureDir: projectPath(opts.project, 'wow-structure'), out: projectPath(opts.project, 'wow-built') });
    console.log(`built from data: ${r.built.length} pages; copied as they were: ${r.copied.length}${r.copied.length ? ` (${r.copied.join(', ')})` : ''}`);
  });

program
  .command('research-type')
  .description('Build the page list of a business type (the model drafts it, a second step merges duplicates into pages with sections). Without --replace it only writes a preview.')
  .requiredOption('--type <id>', 'type id, for example padel')
  .requiredOption('--label <text>', 'what the business is, for example "Padel / sports club"')
  .option('--kind <kind>', 'menu | shop | services | intro', 'services')
  .option('--with-existing', 'merge in the pages of the existing hand-researched file (their evidence is kept)')
  .option('--replace', 'replace the type file (the old one is first copied to src/data/archive)')
  .action(async (opts) => {
    const existing = opts.withExisting && hasType(opts.type) ? loadType(opts.type).pages : [];
    const data = await draftType({ id: opts.type, label: opts.label, kind: opts.kind, existing });
    if (opts.replace) { const kept = archiveAndReplace(opts.type, data); log.info('research-type', `saved src/data/business-types/${opts.type}.json${kept ? ` (the old file is kept at ${kept})` : ''}`); }
    else { const out = projectPath('wow-research', `${opts.type}.preview.json`); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(data, null, 2)); log.info('research-type', `preview written to ${out} (add --replace to use it)`); }
    console.log(`
${data.label}: ${data.draftPages} draft pages -> ${data.pages.length} pages`);
    if (data.review) { const a = data.review.applied; console.log(`
EDITOR (${data.review.rounds} reading${data.review.rounds === 1 ? '' : 's'}): removed ${a.removedSections.length} repeated section(s), merged ${a.merged.length} page(s), renamed ${a.renamed.length}; left over: ${data.review.remaining?.length ? data.review.remaining.join('; ') : 'nothing'}${data.review.note ? ` (${data.review.note})` : ''}`); for (const x of a.removedSections) console.log(`  dropped "${x.section}" from ${x.page} (it belongs to ${x.ownedBy})`); for (const x of a.merged) console.log(`  merged ${x.absorbed} into ${x.kept}`); for (const x of a.renamed) console.log(`  renamed "${x.from}" to "${x.to}"`); }
    for (const tier of ['essential', 'recommended', 'optional']) { console.log(`
${TIER_LABELS[tier].toUpperCase()}`); for (const p of data.pages.filter((x) => tierOf(x) === tier)) console.log(`  ${p.title}${p.feature ? `  <${p.feature}: ${p.featureNote}>` : ''}
      sections: ${(p.sections ?? []).map((x) => x.title).join(' | ')}`); }
  });

program.parseAsync().catch((err) => {
  log.error('cli', err.message);
  process.exit(1);
});
