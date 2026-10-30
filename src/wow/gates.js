// The gates: everything that must be true of a finished site, checked by code in the way a visitor meets the site.
// A site that fails a BLOCKER is not published. A WARNING is written in the report and does not stop anything.
//   runGates({ dir })  ->  { ok, blockers: [...], warnings: [...], measures }
//
// Blockers: a page without its styles or with a missing file, a link to a page or section that does not exist, a menu link a visitor cannot click or that opens
// the wrong page (phone, tablet and laptop), sideways scrolling, pictures that do not load, words that exist on the laptop but not on the phone.
// Warnings: a phone page much taller than the laptop page, tiny tap targets, tiny text on the phone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const cheerio = createRequire(import.meta.url)('cheerio');
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const PARITY_MIN = 0.85; // of the words the laptop shows, at least this share must be on the phone too
const TALL_RATIO = 1.3; // a phone page taller than this many laptop pages is a warning

const htmlFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
const isLocal = (u) => u && !/^(https?:|\/\/|data:|mailto:|tel:|sms:|#|javascript:)/i.test(u);

// 1. every page has its styles, and every local file a page points to exists
export function fileProblems(dir) {
  const out = [];
  const hasSheet = fs.existsSync(path.join(dir, 'styles.css'));
  for (const f of htmlFiles(dir)) {
    const $ = cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    const linksSheet = $('link[rel="stylesheet"]').toArray().some((l) => /(^|\/)styles\.css/.test($(l).attr('href') ?? ''));
    const hasRuntime = $('script[src*="tailwindcss"]').length > 0;
    if (!linksSheet && !hasRuntime) out.push(`${f}: the page has no styles (no styles.css link and no style script)`);
    if (linksSheet && !hasSheet) out.push(`${f}: styles.css is linked but the file is not there`);
    const need = new Set();
    $('img[src]').each((_, i) => need.add($(i).attr('src')));
    $('img[srcset],source[srcset]').each((_, i) => String($(i).attr('srcset')).split(',').forEach((s) => need.add(s.trim().split(/\s+/)[0])));
    $('script[src]').each((_, s) => need.add($(s).attr('src')));
    $('link[rel="stylesheet"][href]').each((_, l) => need.add($(l).attr('href')));
    for (const u of need) if (isLocal(u) && !fs.existsSync(path.join(dir, decodeURIComponent(u.split('?')[0])))) out.push(`${f}: the file ${u} is missing`);
  }
  return [...new Set(out)];
}

// 2. every link points to a page and a section that exist
export function linkProblems(dir) {
  const pages = new Map(htmlFiles(dir).map((f) => [f, cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'))]));
  const out = [];
  for (const [f, $] of pages) $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!isLocal(href) || href === '#') return;
    const [file, hash] = href.split('#'); const target = file || f;
    if (!pages.has(target)) out.push(`${f}: link "${$(a).text().replace(/\s+/g, ' ').trim().slice(0, 30)}" goes to ${target}, which does not exist`);
    else if (hash && !pages.get(target)(`[id="${hash}"],a[name="${hash}"]`).length) out.push(`${f}: link goes to #${hash}, which is not on ${target}`);
  });
  return [...new Set(out)];
}

const run = (script, args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(TOOLS, script), ...args], { encoding: 'utf8', timeout: 25 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });

// 3. a visitor clicks every menu link at phone, tablet and laptop width
export function menuProblems(dir) {
  const r = run('click-test.mjs', [dir]);
  if (r.status === 0) return [];
  const lines = String(r.stdout).split('\n');
  const at = lines.findIndex((l) => l.startsWith('PROBLEMS'));
  return at >= 0 ? lines.slice(at + 1).map((l) => l.trim()).filter(Boolean).slice(0, 40) : [`the menu test could not run: ${String(r.stdout).slice(-200)}${String(r.stderr).slice(-200)}`];
}

// 4. the pages as phone, tablet and laptop show them
export function measure(dir, views = null) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-'));
  const r = run('measure-site.mjs', [dir, out], views ? { VIEWS: views.join(',') } : {});
  const file = path.join(out, 'measures.json');
  if (!fs.existsSync(file)) return { rows: [], error: `the page measurements could not run: ${String(r.stdout).slice(-200)}${String(r.stderr).slice(-200)}` };
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  return { rows };
}

export function judge(rows) {
  const blockers = []; const warnings = [];
  const pages = [...new Set(rows.map((r) => r.page))];
  for (const r of rows) {
    if (r.overflowX > 0) blockers.push(`${r.page} at ${r.view}: scrolls sideways by ${r.overflowX}px`);
    if (r.broken > 0) blockers.push(`${r.page} at ${r.view}: ${r.broken} picture(s) did not load`);
  }
  for (const page of pages) {
    const phone = rows.find((r) => r.page === page && r.view === 'phone'); const laptop = rows.find((r) => r.page === page && r.view === 'laptop');
    if (!phone || !laptop) continue;
    const lap = new Set(laptop.words); const ph = new Set(phone.words);
    if (lap.size >= 20) {
      const shared = [...lap].filter((w) => ph.has(w)).length / lap.size;
      if (shared < PARITY_MIN) blockers.push(`${page}: the phone shows only ${Math.round(shared * 100)}% of the words the laptop shows (the same content is needed on every device)`);
    }
    if (phone.height > laptop.height * TALL_RATIO) warnings.push(`${page}: the phone page is ${Math.round((phone.height / laptop.height) * 100)}% as tall as the laptop page (${phone.height}px)`);
    if (phone.smallText > 0) warnings.push(`${page}: ${phone.smallText} piece(s) of text under 10px on the phone`);
    if (phone.smallTargets > 8) warnings.push(`${page}: ${phone.smallTargets} buttons or links smaller than 32px on the phone`);
  }
  return { blockers, warnings };
}

export function runGates({ dir, log = () => {} }) {
  const blockers = []; const warnings = [];
  const step = (name, problems) => { log(`${name}: ${problems.length ? `${problems.length} problem(s)` : 'ok'}`); blockers.push(...problems); };
  step('files and styles', fileProblems(dir));
  step('links', linkProblems(dir));
  step('menu clicks (phone, tablet, laptop)', menuProblems(dir));
  const m = measure(dir);
  if (m.error) blockers.push(m.error); else { const j = judge(m.rows); step('page measures', j.blockers); warnings.push(...j.warnings); }
  return { ok: blockers.length === 0, blockers, warnings, measures: m.rows ?? [] };
}

// What a phone page needs fixed, from the measures of phone and laptop: { 'page.html': ['line', ...] }. Used by the automatic repair.
export const REPAIR_RATIO = 1.2; // a phone page taller than this many laptop pages gets its tall sections tightened
export function phoneProblems(rows) {
  const out = {};
  for (const phone of rows.filter((r) => r.view === 'phone')) {
    const laptop = rows.find((r) => r.page === phone.page && r.view === 'laptop');
    const lines = [];
    if (phone.overflowX > 0) lines.push(`The page scrolls sideways by ${phone.overflowX}px on a phone. Find what is wider than the screen and make it fit.`);
    if (laptop && phone.height > laptop.height * REPAIR_RATIO) {
      lines.push(`The page is ${phone.height}px tall on a phone but ${laptop.height}px on a laptop. It should be about as tall as on the laptop: tighten the tallest parts.`);
      const tall = (phone.sections ?? []).map((s, i) => ({ ...s, lap: laptop.sections?.[i]?.h ?? 0 })).filter((s) => s.h > 700 && s.h > s.lap * 1.5).sort((a, b) => b.h - a.h).slice(0, 4);
      for (const s of tall) lines.push(`The section starting with "${s.title}" is ${s.h}px tall on a phone (${s.lap}px on a laptop): smaller pictures (landscape), less padding, smaller gaps, side-by-side small items or a swipe row.`);
    }
    if (phone.smallText > 0) lines.push(`${phone.smallText} pieces of text are under 10px on a phone: make them at least text-xs.`);
    if (lines.length) out[phone.page] = lines;
  }
  return out;
}
