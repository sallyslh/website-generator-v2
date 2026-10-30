// "Generate first" pipeline (draft mode):  type + pages  ->  one creative brief  ->  Stitch draws every page freely  ->  static site.
//   node src/cli.js wow --project <id> --name "Smash Point Padel" --type padel --pages home,courts,... [--language English] [--step brief|design|assemble]
// Each step saves its result in projects/<id>/, so a retry never repays a finished step.
// onProgress(event) tells a screen what is happening: { type: 'step'|'page'|'preview', ... }.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, projectPath, readJson, writeJson } from '../lib/project.js';
import { log } from '../lib/log.js';
import { stageSummary } from '../lib/costLog.js';
import { createProject, generateScreen, downloadTo } from '../stages/05-design-stitch/stitchClient.js';
import { generateScreenSmaller } from '../stages/05-design-stitch/index.js';
import { writeBrief, wowBriefSchema } from './brief.js';
import { buildWowPrompt } from './prompt.js';
import { assemble } from './assemble.js';
import { upscaleAvailable } from './upscale.js';
import { makeWowConcept, defaultLook, LOOKS } from './concept.js';
import { readBrand } from './brand.js';
import { polishSite } from './polish.js';
import { responsiveSite } from './responsive.js';
import { deviceCheck } from './deviceCheck.js';
import { fixLinks } from './linkFix.js';
import { auditSite } from './linkAudit.js';
import { syncMenus, addPhoneMenus } from './menu.js';
import { focusSite } from './focus.js';
import { repairPhone } from './repair.js';
import { fixAnchors } from './anchors.js';
import { rtlSite, isRtl } from './rtl.js';

const STAGE = 'wow';
export const TYPES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/business-types');
export const loadType = (type) => JSON.parse(fs.readFileSync(path.join(TYPES_DIR, `${type}.json`), 'utf8'));
export const slugOf = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'page';

// The pages of the draft, exactly the ones the customer chose (nothing is added for them, nothing is forced): Home first and Contact
// last when they kept them, never an unknown id. The first page is the entry page of the site.
export function orderPages(typeData, ids) {
  const known = new Set(typeData.pages.map((p) => p.id));
  const picked = [...new Set(ids)].filter((id) => known.has(id));
  return [...picked.filter((id) => id === 'home'), ...picked.filter((id) => id !== 'home' && id !== 'contact'), ...picked.filter((id) => id === 'contact')];
}

// pages the customer typed in themselves become ordinary pages of this draft (never saved into the type's file)
export function withExtraPages(typeData, titles = []) {
  const extra = titles.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 3).map((title) => ({ id: slugOf(title), title, purpose: `A page about "${title}", as the owner described it.`, default: false, evidence: 'idea' }));
  const known = new Set(typeData.pages.map((p) => p.id));
  return { ...typeData, pages: [...typeData.pages, ...extra.filter((p) => !known.has(p.id))] };
}

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => { while (queue.length) await work(queue.shift()); }));
}

export async function run({ projectId, options = {} }) {
  const started = Date.now(); const since = new Date().toISOString();
  const tell = (e) => { try { options.onProgress?.(e); } catch { /* a screen problem never stops the work */ } };
  const step = options.step ?? 'all';
  const meta = exists(projectId, 'wow.json') ? readJson(projectId, 'wow.json') : null;
  const name = options.name ?? meta?.name; const type = options.type ?? meta?.type;
  if (!name || !type) throw new Error('Give --name and --type (for example --name "Smash Point Padel" --type padel).');
  const extraPages = options.extraPages ?? meta?.extraPages ?? [];
  const typeData = withExtraPages(loadType(type), extraPages);
  const wanted = options.pages ?? meta?.pages ?? typeData.pages.filter((p) => p.default).map((p) => p.id);
  const pageIds = orderPages(typeData, [...wanted, ...extraPages.map(slugOf)]);
  const language = options.language ?? meta?.language ?? 'English';
  const brandColors = options.brandColors ?? meta?.brandColors ?? '';
  const notes = options.notes ?? meta?.notes ?? ''; // what the owner likes (optional)
  // how adventurous the look is: the owner's choice, else the kind of business decides (a dentist is classic, a padel club may be bold)
  const look = LOOKS.includes(options.look) ? options.look : LOOKS.includes(meta?.look) ? meta.look : defaultLook({ typeId: type, typeLabel: typeData.label });
  writeJson(projectId, 'wow.json', { name, type, pages: pageIds, extraPages, language, brandColors, notes, look, mode: 'draft' });
  log.info(STAGE, `look: ${look}`);
  // what the owner already has (a logo, brand colours): the website is built to match it; with nothing given the concept chooses freely
  const brand = await readBrand({ projectId, colorsText: brandColors });
  if (brand) log.info(STAGE, `brand: ${brand.source}${brand.colors.length ? `, colours ${brand.colors.join(' ')}` : ''}`);

  // 1. the creative brief (one call)
  tell({ type: 'step', key: 'brief', status: 'working' });
  if (!exists(projectId, 'wow-brief.json') || options.redoBrief) {
    log.info(STAGE, `writing the creative brief for ${pageIds.length} pages...`);
    // a creative concept first (several really different ideas, one chosen), so two clubs of the same kind never get the same website
    const concept = await makeWowConcept({ projectId, name, typeLabel: typeData.label, language, brand, taste: notes, look, pages: pageIds.map((id) => typeData.pages.find((p) => p.id === id)).filter(Boolean) });
    writeJson(projectId, 'wow-brief.json', await writeBrief({ projectId, name, typeData, pages: pageIds, language, concept, brand, taste: notes }), wowBriefSchema);
  }
  const brief = readJson(projectId, 'wow-brief.json', wowBriefSchema);
  const missing = pageIds.filter((id) => !brief.pages.some((p) => p.slug === id));
  if (missing.length) throw new Error(`The brief has no page for: ${missing.join(', ')}. Run again with --redo-brief.`);
  const pages = pageIds.map((id) => brief.pages.find((p) => p.slug === id));
  log.info(STAGE, `brief ready: "${brief.concept}"`);
  tell({ type: 'step', key: 'brief', status: 'done', concept: brief.concept, pages: pages.map((p) => ({ slug: p.slug, title: p.title })) });
  if (step === 'brief') return log.info(STAGE, `done. ${stageSummary(projectId, 'wow-brief', since, Date.now() - started)}`);

  const bookSlug = pageIds.includes('book') ? 'book' : pageIds.includes('reservations') ? 'reservations' : null;
  const siteOptions = () => {
    const state = readJson(projectId, 'wow-design.json');
    const pageFiles = pages.filter((p) => state.pages[p.slug]).map((p) => ({ slug: p.slug, file: projectPath(projectId, state.pages[p.slug].html) }));
    return { pageFiles, outDir: projectPath(projectId, 'wow-site'), pages, bookSlug, projectId, entry: pageIds[0], businessName: name, logoFile: brand?.logo ? projectPath(projectId, brand.logo) : null };
  };

  // 2. Stitch draws every page, freely (Home first so the others follow its header and footer)
  if (step !== 'assemble') {
    const manifestFile = 'wow-design.json';
    const state = exists(projectId, manifestFile) ? readJson(projectId, manifestFile) : { stitchProjectId: null, pages: {} };
    if (!state.stitchProjectId) { state.stitchProjectId = await createProject(projectId, `${name} (${projectId})`); writeJson(projectId, manifestFile, state); }
    const draw = async (page) => {
      if (state.pages[page.slug] && fs.existsSync(projectPath(projectId, state.pages[page.slug].html))) { tell({ type: 'page', slug: page.slug, status: 'done' }); return; }
      const prompt = buildWowPrompt({ name, typeLabel: typeData.label, brief, page, pages, siteLanguage: language, brand, meta: typeData.pages.find((p) => p.id === page.slug) });
      log.info(STAGE, `drawing "${page.title}" (prompt ${prompt.length} characters)...`);
      tell({ type: 'page', slug: page.slug, status: 'drawing' });
      try {
        const screen = await generateScreenSmaller({ projectId, stitchProjectId: state.stitchProjectId, prompt, mode: 'free', ask: generateScreen });
        const html = `wow-design/${page.slug}.html`;
        await downloadTo(screen.htmlUrl, projectPath(projectId, html));
        await downloadTo(screen.imageUrl, projectPath(projectId, `wow-design/${page.slug}.png`));
        state.pages[page.slug] = { screenId: screen.screenId, html };
        writeJson(projectId, manifestFile, state);
        log.info(STAGE, `"${page.title}" saved`);
        tell({ type: 'page', slug: page.slug, status: 'done' });
      } catch (err) { log.info(STAGE, `"${page.title}" failed: ${err.message}`); tell({ type: 'page', slug: page.slug, status: 'retry' }); }
    };
    await draw(pages[0]);
    // a first look as soon as Home exists (the other pages follow when they are drawn)
    if (state.pages[pages[0].slug]) { try { await assemble({ ...siteOptions(), mode: 'quick' }); await polishSite({ dir: projectPath(projectId, 'wow-site') }).catch(() => null); tell({ type: 'preview' }); } catch (err) { log.info(STAGE, `preview not ready: ${err.message}`); } }
    await pool(pages.slice(1), Number(options.concurrency) || 3, draw);
    for (const p of pages.filter((x) => !state.pages[x.slug])) await draw(p); // one more try for pages that failed, one at a time
    const still = pages.filter((p) => !state.pages[p.slug]);
    for (const p of still) tell({ type: 'page', slug: p.slug, status: 'failed' });
    if (still.length) log.info(STAGE, `WARNING: not drawn: ${still.map((p) => p.slug).join(', ')}. Run the same command again to retry only those.`);
  }

  // 3. a static site that opens by itself (only the pictures that are shown large are made sharper)
  tell({ type: 'step', key: 'finish', status: 'working' });
  const state = readJson(projectId, 'wow-design.json');
  if (!pages.some((p) => state.pages[p.slug])) throw new Error('No page was drawn. Please try again.');
  const doUpscale = options.upscale !== false && upscaleAvailable();
  if (!doUpscale) log.info(STAGE, 'pictures are kept at the size Stitch gives (about 1376 px): the upscaler is off (no FAL_KEY or --no-upscale)');
  const report = await assemble({ ...siteOptions(), doUpscale, mode: 'final' });
  // every site works on any device and any connection: compiled styles, icons that wait for their font, phone-sized pictures, TV scaling
  tell({ type: 'step', key: 'devices', status: 'working' });
  const siteDir = projectPath(projectId, 'wow-site');
  // every button goes where a visitor expects, or shows a friendly note: never to the top of the same page by accident
  try {
    const info = pages.map((p) => ({ slug: p.slug, title: p.title, navLabel: p.navLabel, purpose: typeData.pages.find((x) => x.id === p.slug)?.purpose ?? p.headline }));
    report.links = await fixLinks({ dir: siteDir, pages: info, entry: pageIds[0], businessName: name, projectId });
    report.linkAudit = auditSite(siteDir, { businessName: name }).totals;
    if (report.links.navRemoved.length) log.info(STAGE, `menu items removed because their page does not exist or another item already opens it: ${report.links.navRemoved.join(' | ')}`);
    log.info(STAGE, `links: ${report.links.changed} re-pointed, ${report.links.inert} made inert (sample note) | afterwards ${report.linkAudit.dead} inert, ${report.linkAudit.missing} to a missing page, ${report.linkAudit.duplicates} places reached by different buttons`);
  } catch (err) { log.info(STAGE, `the link step was skipped (${err.message})`); }
  // a link to a section that has no id gets the id (found by its heading), or becomes inactive
  try { const an = fixAnchors({ dir: siteDir }); if (an.named.length || an.inert.length) log.info(STAGE, `anchors: ${an.named.length} sections named, ${an.inert.length} dead links made inactive`); } catch (err) { log.info(STAGE, `the anchor step was skipped (${err.message})`); }
  // one menu on every page (the pages are drawn one by one, so their menus differ), before the phone redesign so they are redesigned alike
  try { const m = syncMenus({ dir: siteDir }); if (m.changed?.length) log.info(STAGE, `menu: the same top bar on ${m.changed.length} pages (from ${m.source})`); } catch (err) { log.info(STAGE, `the menu step was skipped (${err.message})`); }
  // every page is redesigned for the phone and the tablet on purpose (one model call per page, remembered for rebuilds); a page that does not pass the check stays as drawn
  if (options.responsive !== false) {
    try { report.responsive = await responsiveSite({ dir: siteDir, projectId }); log.info(STAGE, `responsive design: ${report.responsive.redesigned} pages redesigned (${report.responsive.cached} from memory), ${report.responsive.changed} class lists changed, ${report.responsive.dropped} proposals dropped to keep the laptop look${report.responsive.kept.length ? `, kept as drawn: ${report.responsive.kept.join(' | ')}` : ''}`); } catch (err) { log.info(STAGE, `the responsive step was skipped (${err.message}); the pages are kept as drawn`); }
  }
  // measured in a real browser: pages whose phone version is far taller than the laptop one, scroll sideways or have tiny text are repaired (two rounds at most)
  if (options.responsive !== false && options.repair !== false) {
    try { report.repair = await repairPhone({ dir: siteDir, projectId, log: (m) => log.info(STAGE, m) }); const rr = report.repair; log.info(STAGE, `phone repair: ${rr.repaired.length} pages repaired, ${rr.restored.length} put back (the repair did not help), still to improve: ${Object.keys(rr.remaining).join(", ") || "none"}`); } catch (err) { log.info(STAGE, `the phone repair was skipped (${err.message})`); }
  }
  // a right-to-left language (Arabic, Persian, Urdu...): the whole layout mirrors, before the styles are compiled
  if (isRtl(language)) { try { const rt = rtlSite({ dir: siteDir, language }); log.info(STAGE, `right-to-left: ${rt.done.length} pages mirrored`); } catch (err) { log.info(STAGE, `the right-to-left step was skipped (${err.message})`); } }
  try { report.polish = await polishSite({ dir: siteDir }); log.info(STAGE, `device-proof: styles ${report.polish.styles}, ${report.polish.pictures} pictures with phone sizes`); } catch (err) { log.info(STAGE, `the device-proof step was skipped (${err.message}); the site is kept as it was`); }
  // heads stay in view: a frame that crops a photo looks at the people in it
  try { const fo = await focusSite({ dir: siteDir, projectId }); log.info(STAGE, `photos: ${fo.withPeople} of ${fo.pictures} show people, ${fo.changed} frames now look at the heads${fo.failed ? `, ${fo.failed} could not be checked` : ""}`); } catch (err) { log.info(STAGE, `the head-focus step was skipped (${err.message})`); }
  // the phone menu, the "More" list that opens by tap, and a top bar that scrolls away (after the polish step, which rewrites the pages)
  try { const m = addPhoneMenus({ dir: siteDir }); log.info(STAGE, `phone menu added to ${m.done.length} pages`); } catch (err) { log.info(STAGE, `the phone menu was skipped (${err.message})`); }
  // and it is checked in a real browser on a phone, a tablet, a laptop and a TV (a report, never a reason to fail the site)
  if (options.deviceCheck !== false) {
    try {
      report.devices = await deviceCheck({ dir: siteDir, routes: report.pages });
      if (report.devices) for (const [name, d] of Object.entries(report.devices)) log.info(STAGE, `${name} (${d.width}px): ${d.fit} of ${d.total} pages fit${d.problems.length ? ` | ${d.problems.slice(0, 3).join(' | ')}` : ''}`);
      else log.info(STAGE, 'no browser was available to check the screen sizes');
    } catch (err) { log.info(STAGE, `the screen-size check was skipped (${err.message})`); }
  }
  const demo = { note: 'Sample content in this draft. Replace or delete every item except "decor" before going live.', contact: brief.contact, team: brief.team, reviews: brief.reviews, prices: pages.flatMap((p) => p.sections.flatMap((s) => s.items.filter((i) => i.price).map((i) => ({ page: p.slug, title: i.title, price: i.price })))) };
  writeJson(projectId, 'demo.json', demo);
  writeJson(projectId, 'wow-site-report.json', report);
  log.info(STAGE, `site written to projects/${projectId}/wow-site: ${report.pages.length} pages, ${report.uniqueImages} pictures (${report.upscaled} made sharper because they are shown large, ${report.upscaleFailed} could not be, ${report.failedImages} could not be downloaded)`);
  if (report.upscaleErrors.length) log.info(STAGE, `upscale problems: ${report.upscaleErrors.join(' | ')}`);
  log.info(STAGE, `done. ${stageSummary(projectId, 'design', since, Date.now() - started)}`);
  tell({ type: 'step', key: 'finish', status: 'done', report });
}
