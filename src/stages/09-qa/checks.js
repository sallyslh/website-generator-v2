// Stage 9: quality checks of the BUILT site, without AI and without cost. Each check returns { name, ok, details }.
// A check whose name starts with "warning only:" never fails the site (ok is always true); it tells what to look at.
//   checkQa      pure and unit tested: the built pages' HTML, the files of the build, and (when a browser was available) its measurements
//   runChecks    loads the project, measures with a headless browser when there is one, and returns the results

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { approvedDesignSchema } from '../../schemas/approvedDesign.js';
import { inspectInBrowser } from './browser.js';

export const LIMITS = { titleMax: 65, titleMin: 10, descMin: 50, descMax: 170, pageWarnBytes: 1.5 * 1024 * 1024, pageFailBytes: 3 * 1024 * 1024, minContrastFail: 3, minContrast: 4.5 };
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
const strip = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<span\b[^>]*material-symbols[^>]*>[\s\S]*?<\/span>/gi, ' ').replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// pages: [{ slug, html }]; distFiles: Set of "/path"; fileSizes: { "/path": bytes }; fileTexts: { "/motion.css": text }
// browser: null (no browser) or { pages: [{ route, mobile: {...}, desktop: {...} }] } from inspectInBrowser
export function checkQa({ pages, distFiles = new Set(), fileSizes = {}, fileTexts = {}, browser = null }) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const warn = (name, problems, okText = 'nothing to report') => check(`warning only: ${name}`, true, problems.length ? problems.slice(0, 8).join('; ') + (problems.length > 8 ? ` (+${problems.length - 8} more)` : '') : okText);
  const each = (fn) => pages.flatMap((p) => fn(p).map((m) => `${p.slug}: ${m}`));

  // ---- search engines and sharing
  check('every page has an html lang and a mobile viewport', each((p) => [!/<html\b[^>]*\blang="[^"]+"/i.test(p.html) && 'no lang', !/<meta\b[^>]*name="viewport"/i.test(p.html) && 'no viewport'].filter(Boolean)).length === 0,
    each((p) => [!/<html\b[^>]*\blang="[^"]+"/i.test(p.html) && 'no lang', !/<meta\b[^>]*name="viewport"/i.test(p.html) && 'no viewport'].filter(Boolean)).join('; '));
  const titles = pages.map((p) => ({ slug: p.slug, title: strip(p.html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''), desc: p.html.match(/<meta\b[^>]*name="description"[^>]*>/i)?.[0] }));
  check('every page has its own title', titles.every((t) => t.title) && new Set(titles.map((t) => t.title)).size === titles.length, titles.filter((t) => !t.title).map((t) => `${t.slug}: no title`).concat(titles.filter((t, i) => t.title && titles.findIndex((u) => u.title === t.title) !== i).map((t) => `${t.slug}: same title as another page`)).join('; '));
  warn('titles have a good length (10 to 65 characters)', titles.filter((t) => t.title && (t.title.length < LIMITS.titleMin || t.title.length > LIMITS.titleMax)).map((t) => `${t.slug}: ${t.title.length} characters`));
  warn('descriptions exist and have a good length (50 to 170 characters)', titles.flatMap((t) => { const d = t.desc ? attr(t.desc, 'content') ?? '' : ''; return !d ? [`${t.slug}: no description`] : d.length < LIMITS.descMin || d.length > LIMITS.descMax ? [`${t.slug}: ${d.length} characters`] : []; }));
  const descs = titles.map((t) => (t.desc ? attr(t.desc, 'content') : '')).filter(Boolean);
  warn('no two pages share a description', descs.length === new Set(descs).size ? [] : ['two pages have the same description']);
  warn('the site has a robots.txt and a favicon', [!distFiles.has('/robots.txt') && 'no robots.txt', !pages.some((p) => /rel="icon"/i.test(p.html)) && 'no favicon (the customer has no logo file?)'].filter(Boolean));

  // ---- structure and accessibility
  const h1s = pages.map((p) => ({ slug: p.slug, n: (p.html.match(/<h1\b/gi) || []).length }));
  check('every page has exactly one main heading (h1)', h1s.every((h) => h.n === 1), h1s.filter((h) => h.n !== 1).map((h) => `${h.slug}: ${h.n} h1`).join('; '));
  warn('headings do not skip levels (h1 then h3)', each((p) => {
    const levels = [...p.html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
    return levels.some((l, i) => i > 0 && l > levels[i - 1] + 1) ? ['a heading level is skipped'] : [];
  }));
  const unnamed = each((p) => [...p.html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].filter(([, , a, inner]) => !attr(a, 'aria-label') && !attr(a, 'title') && !strip(inner) && !/<img\b[^>]*\balt="[^"]+"/i.test(inner)).map(([m]) => m.slice(0, 50).replace(/\s+/g, ' ')));
  check('every link and button has a name a screen reader can read', unnamed.length === 0, unnamed.slice(0, 5).join('; '));
  const badAlt = each((p) => [...p.html.matchAll(/<img\b[^>]*>/gi)].map(([t]) => attr(t, 'alt')).filter((a) => a && /\.(jpe?g|png|webp|gif)$|^(img|image|photo|dsc)[-_ ]?\d*$/i.test(a.trim())).map((a) => `alt text "${a}"`));
  check('picture descriptions are words, not file names', badAlt.length === 0, badAlt.join('; '));
  // a field is labelled by aria-label, by a label that points at its id, or by a label that wraps it (an open <label> before it)
  const insideLabel = (html, index) => { const before = html.slice(0, index); return before.lastIndexOf('<label') > before.lastIndexOf('</label>'); };
  const fields = each((p) => [...p.html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
    .filter((m) => !/type="(hidden|submit|button|checkbox|radio)"/i.test(m[2]) && !/tabindex="-1"/i.test(m[2]) && !/aria-hidden="true"/i.test(m[2]))
    .filter((m) => { const id = attr(m[2], 'id'); return !attr(m[2], 'aria-label') && !(id && new RegExp(`<label\\b[^>]*\\bfor="${id}"`, 'i').test(p.html)) && !insideLabel(p.html, m.index); })
    .map((m) => `field "${attr(m[2], 'name') ?? attr(m[2], 'id') ?? '?'}" has no label`));
  warn('form fields have a label (a placeholder alone disappears when typing)', fields);
  const anchors = each((p) => [...p.html.matchAll(/<a\b[^>]*\bhref="#([^"]+)"/gi)].filter(([, id]) => !new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(p.html)).map(([, id]) => `#${id} does not exist on the page`));
  check('every "#section" link points to a section that exists', anchors.length === 0, anchors.join('; '));
  const blank = each((p) => [...p.html.matchAll(/<a\b[^>]*>/gi)].filter(([t]) => /target="_blank"/i.test(t) && !/rel="[^"]*noopener/i.test(t)).map(([t]) => `${attr(t, 'href') ?? '?'} opens a new tab without rel="noopener"`));
  warn('links that open a new tab are safe (rel="noopener")', blank);
  const phones = each((p) => [...p.html.matchAll(/href="tel:([^"]*)"/gi)].filter(([, n]) => n.replace(/\D/g, '').length < 7).map(([, n]) => `tel:${n}`));
  check('phone links contain a real number', phones.length === 0, phones.join('; '));

  // ---- weight: what a phone has to download for one page
  const weights = pages.map((p) => {
    const refs = new Set([...p.html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|webp|png|jpe?g|svg|woff2?))"/gi)].map((m) => m[1]));
    for (const m of p.html.matchAll(/srcset="([^"]+)"/gi)) m[1].split(',').forEach((s) => refs.add(s.trim().split(/\s+/)[0]));
    return { slug: p.slug, bytes: Buffer.byteLength(p.html) + [...refs].reduce((s, f) => s + (fileSizes[f] ?? 0), 0) };
  });
  check(`no page is heavier than ${kb(LIMITS.pageFailBytes)}`, weights.every((w) => w.bytes <= LIMITS.pageFailBytes), weights.filter((w) => w.bytes > LIMITS.pageFailBytes).map((w) => `${w.slug}: ${kb(w.bytes)}`).join('; '));
  warn(`pages stay under ${kb(LIMITS.pageWarnBytes)} (fast on a phone)`, weights.filter((w) => w.bytes > LIMITS.pageWarnBytes).map((w) => `${w.slug}: ${kb(w.bytes)}`), weights.map((w) => `${w.slug} ${kb(w.bytes)}`).join(', '));

  // ---- motion: respects people who asked for less
  if (pages.some((p) => /\/motion\.js/.test(p.html))) {
    const css = fileTexts['/motion.css'] ?? ''; const js = fileTexts['/motion.js'] ?? '';
    check('motion stops for visitors who asked for reduced motion', css.includes('prefers-reduced-motion: no-preference') && /prefers-reduced-motion: reduce/.test(js), 'the motion files must contain both guards');
  }

  // ---- in a real browser (phone and desktop): only when a browser was available
  if (!browser) {
    check('warning only: browser checks (phone layout, console errors, contrast) were skipped', true, 'no Edge or Chrome was found; set BROWSER_PATH in .env');
    return results;
  }
  const views = (view) => browser.pages.map((p) => ({ route: p.route, ...p[view] })).filter((v) => v.ok !== false);
  const failedLoad = browser.pages.filter((p) => p.mobile?.ok === false || p.desktop?.ok === false);
  check('every page opened in the browser', failedLoad.length === 0, failedLoad.map((p) => p.route).join(', '));
  const over = views('mobile').filter((v) => v.overflowPx > 1);
  check('nothing sticks out sideways on a phone (390 px wide)', over.length === 0, over.map((v) => `${v.route}: ${v.overflowPx}px wider than the screen${v.overflowing?.length ? ` (${v.overflowing.slice(0, 3).join(', ')})` : ''}`).join('; '));
  const cut = views('mobile').filter((v) => v.cutOff?.length);
  check('no text is cut off at the edge of a phone screen', cut.length === 0, cut.map((v) => `${v.route}: ${v.cutOff.join(', ')}`).join('; '));
  const overD = views('desktop').filter((v) => v.overflowPx > 1);
  check('nothing sticks out sideways on a laptop (1440 px wide)', overD.length === 0, overD.map((v) => `${v.route}: ${v.overflowPx}px`).join('; '));
  const errs = [...views('mobile'), ...views('desktop')].flatMap((v) => (v.errors ?? []).map((e) => `${v.route}: ${e}`));
  check('no script errors and no missing files while the pages load', errs.length === 0, [...new Set(errs)].slice(0, 6).join('; '));
  const bad = [...views('desktop')].flatMap((v) => (v.contrast ?? []).filter((c) => c.ratio < LIMITS.minContrastFail).map((c) => `${v.route}: "${c.text}" ${c.ratio}:1 (${c.fg} on ${c.bg})`));
  check('no text is nearly unreadable (contrast below 3:1)', bad.length === 0, bad.slice(0, 5).join('; '));
  warn('text meets the 4.5:1 contrast of the web accessibility guidelines', views('desktop').flatMap((v) => (v.contrast ?? []).filter((c) => c.ratio >= LIMITS.minContrastFail).map((c) => `${v.route}: "${c.text}" ${c.ratio}:1`)));
  warn('buttons and links are big enough to tap (at least 32 px)', views('mobile').filter((v) => v.smallTargets > 0).map((v) => `${v.route}: ${v.smallTargets} small`));
  warn('text is not smaller than 12 px on a phone', views('mobile').filter((v) => v.tinyText > 0).map((v) => `${v.route}: ${v.tinyText} pieces`));
  return results;
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

export async function loadBuild(projectId) {
  if (!exists(projectId, 'approved-design.json')) throw new Error(`The project "${projectId}" has no approved design yet.`);
  const approved = readJson(projectId, 'approved-design.json', approvedDesignSchema);
  const dist = projectPath(projectId, 'site/dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`The site is not built in "${projectId}". Run: node src/cli.js site --project ${projectId} --build`);
  const files = walk(dist);
  const rel = (f) => '/' + path.relative(dist, f).split(path.sep).join('/');
  const pages = approved.pages.map((p) => ({ slug: p.slug, route: p.slug === 'home' ? '/' : `/${p.slug}/`, file: path.join(dist, p.slug === 'home' ? 'index.html' : `${p.slug}/index.html`) }))
    .filter((p) => fs.existsSync(p.file)).map((p) => ({ ...p, html: fs.readFileSync(p.file, 'utf8') }));
  return {
    dist, pages, distFiles: new Set(files.map(rel)), fileSizes: Object.fromEntries(files.map((f) => [rel(f), fs.statSync(f).size])),
    fileTexts: Object.fromEntries(files.filter((f) => /motion\.(css|js)$/.test(f)).map((f) => [rel(f), fs.readFileSync(f, 'utf8')])),
  };
}

export async function runChecks({ projectId, browser: given }) {
  const build = await loadBuild(projectId);
  const browser = given === undefined ? await inspectInBrowser({ distDir: build.dist, routes: build.pages.map((p) => p.route) }) : given;
  return checkQa({ ...build, browser });
}
