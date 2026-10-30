// Stage 7: builds the real website (an Astro project) from the approved Stitch pages. No AI, no cost.
//   site --project <id>          writes projects/<id>/site/ (an Astro + Tailwind project, real photos, links, SEO)
//   site --project <id> --build  also runs npm install + astro build there, so site/dist is the finished website
//
// What changes compared with the Stitch page: Tailwind is compiled (not the CDN), photos are the customer's own files
// converted to web size, empty photo slots become quiet tinted blocks, links point to real pages, alt text comes from the
// copy, SEO + business data come from the brief and content spec, and sections fade in gently as they scroll into view.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, projectPath, readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { designSpecSchema } from '../../schemas/designSpec.js';
const designSpecSchemaForFit = designSpecSchema;
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { approvedDesignSchema } from '../../schemas/approvedDesign.js';
import { log } from '../../lib/log.js';
import { usedFontLinks, offerPage } from './transform.js';
import { fitCollages } from '../05-design-stitch/fitCollages.js';
import { measureRenderedImages, pictureMisfits, findBrowser } from '../../lib/measureFrames.js';
import { applyFeatures } from '../08-features/index.js';
import { composeImages } from '../03-creative-director/compose.js';
import { bestLayout } from '../../lib/collage.js';
import { aspectOf } from '../05-design-stitch/prompts.js';
import { assetManifestSchema as manifestSchema } from '../../schemas/assetManifest.js';
import { expandLists, formatLoosePrices } from './lists.js';
import { makeResponsive, responsiveCss } from './responsive.js';
import { socialLinksOf } from '../../lib/socials.js';
import { labelFields } from '../../lib/formLabels.js';
import { correctContactDetails, makeContactClickable } from '../../lib/contactLinks.js';
import { dropDeadFooterLinks, removeEmptyFrames, extractParts, mergeConfigs, cleanBody, swapImagesForSite, resolveLinks, markForm, splitShell, hoistShared, normalizeLabel, fixCopyright, dropUnbackedLegalLinks } from './transform.js';
import { allowedText, removeInventedText, removeSkeletons } from './textRules.js';
import { motionCss, motionJs } from './motion.js';
import { tagEditable, applyEdits } from '../../lib/siteEdits.js';
import { applyRepairs } from '../../lib/repairs.js';
import { applyRequests } from '../../lib/changeRequests.js';
import { layoutAstro, pageAstro, globalCss, packageJson, astroConfig, tailwindConfigFile, postcssConfig, optimizeScript, readme, robotsTxt, jsonLdFor } from './templates.js';

const STAGE = 'site';
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

export function generateSite(projectId) {
  for (const f of ['approved-design.json', 'site-brief.json', 'content-spec.json', 'design-spec.json', 'asset-manifest.json'])
    if (!exists(projectId, f)) throw new Error(`Missing ${f} in "${projectId}". Stage 7 needs the approved design: run the earlier stages first (review --approve-all).`);
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const design = readJson(projectId, 'design-spec.json', designSpecSchema);
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  const approved = readJson(projectId, 'approved-design.json', approvedDesignSchema);

  const siteDir = projectPath(projectId, 'site');
  if (fs.existsSync(siteDir)) for (const e of fs.readdirSync(siteDir)) if (e !== 'node_modules' && e !== 'package-lock.json') fs.rmSync(path.join(siteDir, e), { recursive: true, force: true });
  const slugs = new Set(approved.pages.map((p) => p.slug));
  const assets = new Map(manifest.assets.map((a) => [a.id, a]));
  const lang = (content.language || brief.language || 'en').slice(0, 2).toLowerCase();

  // slot id -> asset id (or null) and descriptive alt text from the copy
  // a combined picture the customer rejected is not used: its place waits for a real photo
  // (a generated mood picture is only used when the customer approved it; photos and crops are used unless rejected)
  const notUsed = (a) => a.approval === 'rejected' || (a.origin === 'generated' && a.approval !== 'approved');
  const rejected = new Set(manifest.assets.filter((a) => (a.derivedFrom?.length || a.origin) && notUsed(a)).map((a) => a.id));
  const slots = new Map(Object.entries(approved.slotAssets).map(([slot, id]) => [slot, rejected.has(id) ? null : id]));
  const combined = manifest.assets.filter((a) => a.derivedFrom?.length || a.origin).map((a) => ({ id: a.id, origin: a.origin ?? 'collage', approval: a.approval ?? 'pending', used: !rejected.has(a.id) }));
  const altText = new Map();
  for (const p of content.pages) for (const s of p.sections) for (const [slot, alt] of Object.entries(s.imageAlt)) altText.set(slot, alt);
  const logoAssetId = manifest.logo && assets.has(manifest.logo) ? manifest.logo : null;
  const assetByFilename = new Map(manifest.assets.map((a) => [path.basename(a.file), a.id]));

  // words on a link -> where it goes (navigation, call-to-action buttons)
  const labelTargets = new Map();
  for (const n of content.global.navigation) labelTargets.set(normalizeLabel(n.label), n.page);
  const ctas = [content.global.primaryCta, ...content.pages.flatMap((p) => p.sections.map((s) => s.cta).filter(Boolean))];
  for (const c of ctas) if (!labelTargets.has(normalizeLabel(c.label))) labelTargets.set(normalizeLabel(c.label), c.target);
  // a link whose words are a section's heading ("Hair") goes to that section; a link to a section that is on another page works from any page
  const anchorPages = new Map(); const headingTargets = [];
  for (const p of content.pages) for (const s of p.sections) {
    anchorPages.set(s.id, p.slug);
    if (s.heading) headingTargets.push([normalizeLabel(s.heading), `${p.slug}#${s.id}`]);
    if (s.heading && !labelTargets.has(normalizeLabel(s.heading))) labelTargets.set(normalizeLabel(s.heading), `${p.slug}#${s.id}`);
  }
  const socials = socialLinksOf(brief.business.socialLinks);

  // 1. take every approved page apart
  const parts = approved.pages.map((p) => ({ slug: p.slug, ...extractParts(fs.readFileSync(projectPath(projectId, p.html), 'utf8')) }));
  const formPage = parts.find((p) => /<form\b/i.test(p.bodyInner))?.slug ?? null;
  const tint = /^#[0-9a-f]{6}$/i.test(design.colors.primary) ? `${design.colors.primary}1f` : 'rgba(0,0,0,.07)';

  const allowed = allowedText(brief, content);
  const report = { tokens: new Set(), emptyFramesRemoved: 0, lists: [], drawnSlots: new Set(), removedText: [], pages: [], emptyPhotoSlots: [], unresolvedLinks: {}, forms: 0, externalImages: 0, usedAssets: new Set(), configConflicts: 0 };
  const shells = parts.map((p) => {
    let body = cleanBody(p.bodyInner);
    const grown = expandLists({ body, slug: p.slug, brief, design, content, manifest }); // long lists: the drawn sample rows are repeated for the whole list
    body = grown.html; report.lists.push(...grown.report);
    body = formatLoosePrices(body, brief).html; // a bare price beside a card ("39.0") gets the currency sign
    const images = swapImagesForSite(body, { slots, altFor: (id) => altText.get(id), logoAssetId, businessName: brief.business.name, tint, assetByFilename });
    const framed = removeEmptyFrames(images.html); // no photo, no frame
    report.emptyFramesRemoved += framed.removed;
    body = labelFields(markForm(framed.html)).html; // every form field gets a label for screen readers
    const links = resolveLinks(body, { labelTargets, businessName: brief.business.name, socials, formPage, slugs, genericPage: offerPage(brief.pages), anchorPages, headingTargets });
    const legal = dropUnbackedLegalLinks(links.html);
    report.removedText.push(...legal.removed.map((t) => `${p.slug}: ${t} (a link to a page that does not exist)`));
    const footer = dropDeadFooterLinks(legal.html);
    report.removedText.push(...footer.removed.map((t) => `${p.slug}: ${t} (a footer link that goes nowhere)`));
    body = fixCopyright(footer.html, { businessName: brief.business.name, year: new Date().getFullYear() }).html;
    const contact = correctContactDetails(body, { phone: brief.business.contact.phone, whatsapp: brief.business.contact.whatsapp, email: brief.business.contact.email }); // never a made-up phone number or email
    body = makeContactClickable(contact.html, { phone: brief.business.contact.phone, whatsapp: brief.business.contact.whatsapp, email: brief.business.contact.email }).html; // one click opens WhatsApp, the mail app or a call
    report.removedText.push(...contact.removed.map((t) => `${p.slug}: ${t} (a phone number or email the owner did not give)`));
    report.contactCorrected = (report.contactCorrected ?? 0) + contact.fixed;
    report.emptyPhotoSlots.push(...images.stats.empty);
    images.stats.seen.forEach((s) => report.drawnSlots.add(s));
    report.externalImages += images.stats.external;
    images.stats.used.forEach((a) => report.usedAssets.add(a));
    if (links.unresolved.length) report.unresolvedLinks[p.slug] = links.unresolved;
    const cleaned = removeInventedText(body, allowed);
    const bars = removeSkeletons(cleaned.html);
    if (bars.removed) cleaned.removed.push(`${bars.removed} grey placeholder bar(s)`);
    body = bars.html;
    report.removedText.push(...cleaned.removed.map((t) => `${p.slug}: ${t}`));
    report.forms += (body.match(/<form\b/gi) || []).length;
    const resp = makeResponsive(body); // columns stack on a phone, desktop unchanged
    body = resp.html; resp.tokens.forEach((t) => report.tokens.add(t));
    return splitShell(body);
  });
  const shared = hoistShared(shells);

  // 2. shared pieces: Tailwind config, CSS, fonts
  const { config, conflicts } = mergeConfigs(parts.map((p) => p.tailwindConfig));
  report.configConflicts = conflicts;
  const styles = [...new Set(parts.flatMap((p) => p.styles))];
  // only the fonts the design really uses (Stitch pages also load fonts they never use, which only slows the site down)
  const usedText = JSON.stringify(config) + styles.join(' ');
  const fontLinks = usedFontLinks([...new Set(parts.flatMap((p) => p.fontLinks))], usedText);
  const home = parts.find((p) => p.slug === 'home') ?? parts[0];
  const rtl = RTL.has(lang);
  const motion = design.motion?.style ?? 'calm'; // sites designed before the motion layer existed move calmly

  write(path.join(siteDir, 'package.json'), packageJson(brief.business.name));
  write(path.join(siteDir, 'astro.config.mjs'), astroConfig());
  write(path.join(siteDir, 'tailwind.config.cjs'), tailwindConfigFile(config));
  write(path.join(siteDir, 'postcss.config.cjs'), postcssConfig());
  write(path.join(siteDir, 'src/styles/global.css'), globalCss(styles));
  write(path.join(siteDir, 'src/layouts/Layout.astro'), layoutAstro({ initial: [...brief.business.name.trim()][0] ?? '', lang, rtl, htmlClass: home.htmlClass, fontLinks, themeColor: design.colors.primary, hasHeader: Boolean(shared.header), hasFooter: Boolean(shared.footer), siteTitle: content.global.siteTitle, logo: Boolean(logoAssetId), motion }));
  if (motion !== 'none') { write(path.join(siteDir, 'public/motion.css'), motionCss(motion)); write(path.join(siteDir, 'public/motion.js'), motionJs(motion)); }
  if (shared.header) write(path.join(siteDir, 'src/content/_header.html'), tagEditable(shared.header, 'shared-header'));
  if (shared.footer) write(path.join(siteDir, 'src/content/_footer.html'), tagEditable(shared.footer, 'shared-footer'));
  write(path.join(siteDir, 'public/robots.txt'), robotsTxt());
  write(path.join(siteDir, 'public/custom.css'), '/* changes the customer asked for are written here */');
  write(path.join(siteDir, 'public/responsive.css'), responsiveCss({ tokens: report.tokens, tailwindConfig: config }));

  // 3. one page per approved page
  parts.forEach((p, i) => {
    const seo = content.pages.find((c) => c.slug === p.slug)?.seo ?? { title: content.global.siteTitle, description: '' };
    write(path.join(siteDir, 'src/content', `${p.slug}.html`), tagEditable(shared.pages[i], p.slug));
    write(path.join(siteDir, 'src/pages', p.slug === 'home' ? 'index.astro' : `${p.slug}.astro`), pageAstro({ slug: p.slug, title: seo.title, description: seo.description, bodyClass: p.bodyClass, jsonLd: p.slug === 'home' ? jsonLdFor(brief) : null }));
    report.pages.push({ slug: p.slug, title: seo.title, route: p.slug === 'home' ? '/' : `/${p.slug}/` });
  });

  // 4. the customer's own photos, converted to web size when the site is built (scripts/optimize-images.mjs)
  for (const id of new Set([...report.usedAssets, ...(logoAssetId ? [logoAssetId] : [])])) { // the logo is always copied: it makes the favicon even when no page shows it
    const a = assets.get(id);
    const src = projectPath(projectId, a.file);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(siteDir, 'originals'), { recursive: true });
    fs.copyFileSync(src, path.join(siteDir, 'originals', `${id}${path.extname(a.file).toLowerCase()}`));
  }
  write(path.join(siteDir, 'scripts/optimize-images.mjs'), optimizeScript(logoAssetId));
  write(path.join(siteDir, 'README.md'), readme({ brief, report, formPage }));

  const summary = { generatedAt: new Date().toISOString(), pages: report.pages, lists: report.lists, emptyFramesRemoved: report.emptyFramesRemoved, combined, photosUsed: report.usedAssets.size, emptyPhotoSlots: [...new Set(report.emptyPhotoSlots)], unresolvedLinks: report.unresolvedLinks, removedText: report.removedText,
    // pictures the plan gave a photo to, but that the design never drew a frame for (nothing to put them in)
    undrawnSlots: Object.entries(approved.slotAssets).filter(([slot, id]) => id && !report.drawnSlots.has(slot)).map(([slot]) => slot), forms: report.forms, externalImages: report.externalImages, sharedHeader: Boolean(shared.header), sharedFooter: Boolean(shared.footer), configConflicts: report.configConflicts, logoAssetId };
  fs.writeFileSync(path.join(siteDir, 'site-report.json'), JSON.stringify(summary, null, 2));
  return summary;
}

// npm install + astro build inside the generated site. Returns { ok, output }.
export function buildSite(projectId) {
  const siteDir = projectPath(projectId, 'site');
  if (!fs.existsSync(path.join(siteDir, 'package.json'))) throw new Error('The site has not been generated yet. Run: node src/cli.js site --project ' + projectId);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // one thread for the build tools: it is slower by seconds and does not run out of memory on a small or busy machine
  const env = { ...process.env, RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS ?? '1', VIPS_CONCURRENCY: process.env.VIPS_CONCURRENCY ?? '1' };
  const run = (args) => spawnSync(npm, args, { cwd: siteDir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 50 * 1024 * 1024, env });
  if (!fs.existsSync(path.join(siteDir, 'node_modules'))) {
    log.info(STAGE, 'installing the site tools (first time only, about a minute)...');
    const install = run(['install', '--no-audit', '--no-fund']);
    if (install.status !== 0) return { ok: false, output: `${install.stdout}\n${install.stderr}` };
  }
  log.info(STAGE, 'building the site...');
  let build = run(['run', 'build']);
  // out of memory is often temporary on a busy machine: one more try
  if (build.status !== 0 && /memory allocation|out of memory|ENOMEM/i.test(`${build.stdout}${build.stderr}`)) {
    log.info(STAGE, 'the build ran out of memory; trying once more...');
    build = run(['run', 'build']);
  }
  return { ok: build.status === 0, output: `${build.stdout}\n${build.stderr}` };
}

// Measures the built pages and rebuilds every collage / composite / scene whose shape differs from the frame it is shown in.
// Returns the pictures that were rebuilt (an empty list when everything fits or no browser is available).
export async function refitToRenderedFrames(projectId, routes, deps = {}) {
  const rendered = await (deps.measure ?? measureRenderedImages)({ distDir: projectPath(projectId, 'site/dist'), routes });
  if (!rendered) { log.info(STAGE, 'no browser was available to measure the pictures, so their fit was not checked'); return []; }
  const design = readJson(projectId, 'design-spec.json', designSpecSchemaForFit);
  const manifest = readJson(projectId, 'asset-manifest.json', manifestSchema);
  const misfits = pictureMisfits({ assets: manifest.assets, design, rendered, aspectOf });
  if (!misfits.length) return [];
  const slots = design.pages.flatMap((p) => p.sections.flatMap((x) => x.slots));
  for (const m of misfits) {
    const slot = slots.find((x) => x.id === m.slotId);
    slot.aspect = m.frame;
    if (slot.recipe?.type === 'collage') slot.recipe.layout = bestLayout(slot.recipe.sources.length, m.frame);
  }
  await (deps.compose ?? composeImages)({ projectId, design, manifest, only: misfits.map((m) => m.slotId), background: /^#[0-9a-f]{6}$/i.test(design.colors.background) ? design.colors.background : undefined, palette: [design.colors.primary, design.colors.background] });
  writeJson(projectId, 'asset-manifest.json', manifest, manifestSchema);
  writeJson(projectId, 'design-spec.json', design, designSpecSchemaForFit);
  return misfits;
}

export async function run({ projectId, options = {} }) {
  // a collage must match the frame it sits in, or only its middle photo shows. With a browser the built pages are measured
  // after the build (the truth); without one, the CSS of the page is used as a rough guide.
  if (!findBrowser()) await fitCollages(projectId);
  const s = generateSite(projectId);
  const features = applyFeatures(projectId);
  log.info(STAGE, `features: form ${features.form}, map ${features.map}, booking ${features.booking}`);
  const kept = applyEdits(projectId); // the customer's own changes survive a regeneration
  applyRepairs(projectId); // so do the readability repairs QA made
  applyRequests(projectId); // and the look changes the customer asked for in writing
  if (kept.missing.length) log.info(STAGE, `${kept.missing.length} edit(s) no longer have a place on the regenerated pages: ${kept.missing.join(', ')}`);
  log.info(STAGE, `site written to projects/${projectId}/site: ${s.pages.length} pages, ${s.photosUsed} real photos, ${s.emptyPhotoSlots.length} photo slot(s) still empty.`);
  if (Object.keys(s.unresolvedLinks).length) log.info(STAGE, `WARNING: links left as "#": ${JSON.stringify(s.unresolvedLinks)}`);
  if (options.build) {
    const r = buildSite(projectId);
    if (!r.ok) throw new Error(`The site build failed:\n${r.output.slice(-3000)}`);
    log.info(STAGE, `built: projects/${projectId}/site/dist (open it with: npm run preview inside the site folder)`);
    // the CSS of a Stitch page does not tell how big a frame really is: measure the built pages, rebuild pictures that do not fit
    if (options.fit !== false) {
      const fitted = await refitToRenderedFrames(projectId, s.pages.map((p) => p.route));
      if (fitted.length) {
        generateSite(projectId);
        applyFeatures(projectId);
        const again = buildSite(projectId);
        if (!again.ok) throw new Error(`The site build failed after fitting the pictures:\n${again.output.slice(-3000)}`);
        log.info(STAGE, `rebuilt with ${fitted.length} picture(s) fitted to their real frame: ${fitted.map((f) => `${f.slotId} (${f.frame})`).join(', ')}`);
      }
    }
  } else log.info(STAGE, `Next: node src/cli.js site --project ${projectId} --build`);
}
