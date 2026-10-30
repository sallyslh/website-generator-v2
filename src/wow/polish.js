// Makes a drafted website work on any device and any connection (a phone on a slow network, a tablet, a laptop, a TV):
//   - the styles are compiled ahead of time into styles.css, so the first paint is already styled (no script to wait for)
//   - icons stay hidden until their font is ready, so a slow phone never shows an icon's name ("arrow_forward") as a word
//   - pictures come in several sizes (a phone is sent the small one) and the ones below the first screen load lazily
//   - above 1920 px wide everything scales up, so a TV or a big monitor does not show a tiny page in a sea of empty space
//   - nothing may make the page scroll sideways
// It runs on a folder of pages (index.html ...). It never fails a site: when something cannot be done the page stays as it was.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { extractParts, mergeConfigs } from '../stages/07-site/transform.js';

const PROJECTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../projects');
const MARK = 'data-polish';
export const SIZES = [640, 1024];

// A Tailwind 3 compiler with its two plugins: the main project's, or one inside an older generated site
export function findTailwind() {
  const roots = [path.resolve(PROJECTS, '..', 'node_modules')];
  if (fs.existsSync(PROJECTS)) for (const d of fs.readdirSync(PROJECTS)) roots.push(path.join(PROJECTS, d, 'site', 'node_modules'));
  for (const nm of roots) {
    const cli = path.join(nm, 'tailwindcss', 'lib', 'cli.js');
    if (fs.existsSync(cli) && fs.existsSync(path.join(nm, '@tailwindcss', 'forms')) && fs.existsSync(path.join(nm, '@tailwindcss', 'container-queries'))) return { cli, nodeModules: nm };
  }
  return null;
}

export const GUARD_CSS = `/* icons stay hidden until their font is ready, so no icon name is ever shown as a word; the box keeps its size meanwhile */
[class*="material-symbols"],.material-icons{display:inline-block;width:1em;overflow:hidden;white-space:nowrap;visibility:hidden}
html.icons-ready [class*="material-symbols"],html.icons-ready .material-icons{visibility:visible}
/* nothing makes the page scroll sideways */
html,body{max-width:100%;overflow-x:clip}
/* a TV or a big monitor: everything scales with the screen (16px at 1920 px wide, 32px at 3840) */
@media (min-width:1920px){html{font-size:calc(100vw/120)}}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* a row of three or more buttons (filters, chips) wraps on a phone instead of running off the edge of the screen */
@media (max-width:767px){div:has(>button+button+button),ul:has(>li>button){flex-wrap:wrap}}
/* a tablet held upright (768 to 1099 px) is too narrow for the full desktop menu on one line: the menu moves to its own row under the name and the button */
@media (min-width:768px) and (max-width:1099px){
header>div:first-child{flex-wrap:wrap;height:auto!important;row-gap:.35rem;column-gap:1rem;padding:.6rem 1rem!important}
header>div:first-child>a:first-child{white-space:nowrap;flex:none}
header>div:first-child>nav{order:3;flex:1 1 100%;flex-wrap:wrap;justify-content:center;column-gap:1.4rem;row-gap:.2rem}
header>div:first-child>*:last-child:not(nav){flex:none;white-space:nowrap;margin-left:auto}
}
.polish-note{position:fixed;left:50%;bottom:max(20px,env(safe-area-inset-bottom,0px));transform:translate(-50%,16px);max-width:min(92vw,420px);padding:12px 18px;border-radius:12px;background:#111;color:#fff;font:500 14px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:2147483000}
.polish-note.show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){.polish-note{transition:none}}
/* a finger needs room: menu and footer links and buttons are at least 44px tall on a touch screen */
@media (pointer:coarse){footer a,nav a,header a,button,[role=button]{min-height:44px;display:inline-flex;align-items:center}}`;

export const GUARD_JS = `(function(){var t,box;function note(m){if(!box){box=document.createElement('div');box.setAttribute('role','status');box.className='polish-note';document.body.appendChild(box)}box.textContent=m;box.classList.add('show');clearTimeout(t);t=setTimeout(function(){box.classList.remove('show')},3200)}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var h=a.getAttribute('href');if(a.hasAttribute('data-inert')||h==='#'||h===''||(h&&h.indexOf('javascript:')===0)){e.preventDefault();note('This is a preview: this button works once the real details are added.')}});
(function(){var d=document,h=d.documentElement,done=false;function ok(f){if(f&&f.length&&!done){done=true;h.classList.add('icons-ready')}}
if(!d.fonts||!d.fonts.load){h.classList.add('icons-ready');return}
['Material Symbols Outlined','Material Symbols Rounded','Material Symbols Sharp','Material Icons'].forEach(function(n){d.fonts.load('24px "'+n+'"').then(ok,function(){})});})();})();`;

// Every font family the design names gets a plain fallback, so text is never shown in the browser's serif while a font is on its way
export function withFontFallbacks(config) {
  const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy)$/i;
  for (const holder of [config?.theme, config?.theme?.extend]) {
    const families = holder?.fontFamily;
    if (!families || typeof families !== 'object') continue;
    for (const [key, value] of Object.entries(families)) {
      const list = Array.isArray(value) ? [...value] : String(value).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      if (!list.some((f) => GENERIC.test(String(f).trim()))) list.push('system-ui', 'sans-serif');
      families[key] = list;
    }
  }
  return config;
}

const esc = (n) => String(n).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

// A page redesigned for the phone often shows a plain size (text-4xl) on a phone and the design's own size ("md:text-display-xl") from a tablet up.
// The design's own size also carries the weight and spacing of its headings, so on a phone those are given back, from the design's own settings.
export function weightCss(config, htmls) {
  const sizes = { ...(config?.theme?.fontSize ?? {}), ...(config?.theme?.extend?.fontSize ?? {}) };
  const phone = []; const tablet = [];
  for (const [key, val] of Object.entries(sizes)) {
    const extra = Array.isArray(val) ? val[1] : null;
    if (!extra || typeof extra !== 'object') continue;
    const decl = [extra.fontWeight ? `font-weight:${extra.fontWeight}` : '', extra.letterSpacing ? `letter-spacing:${extra.letterSpacing}` : ''].filter(Boolean).join(';');
    if (!decl) continue;
    // a size that switches on at a tablet (md:) is missing on a phone; one that switches on at a laptop (lg:) is missing on a phone and a tablet
    for (const prefix of ['sm', 'md', 'lg']) if (htmls.some((h) => h.includes(`${prefix}:text-${key}`))) (prefix === 'lg' ? tablet : phone).push(`.${prefix}\\:text-${esc(key)}{${decl}}`);
  }
  return `${phone.length ? `@media (max-width:767px){${phone.join('')}}\n` : ''}${tablet.length ? `@media (max-width:1023px){${tablet.join('')}}\n` : ''}`;
}

// 1. the styles
function compileStyles(dir, files) {
  const tw = findTailwind();
  if (!tw) return { ok: false, why: 'no Tailwind compiler was found' };
  const configs = []; const styles = [];
  for (const f of files) {
    const parts = extractParts(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (parts.tailwindConfig) configs.push(parts.tailwindConfig);
    for (const s of parts.styles) if (!styles.includes(s)) styles.push(s);
  }
  if (!configs.length) return { ok: false, why: 'the pages carry no style settings' };
  const { config } = mergeConfigs(configs);
  withFontFallbacks(config);
  const work = path.join(dir, '.tw'); fs.mkdirSync(work, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(work, 'tailwind.config.cjs'), `const cfg = ${JSON.stringify(config)};\nmodule.exports = { ...cfg, content: [${JSON.stringify(slash(dir) + '/*.html')}], plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')] };\n`);
  fs.writeFileSync(path.join(work, 'in.css'), `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${styles.join('\n')}\n`);
  const out = path.join(dir, 'styles.css');
  const run = spawnSync(process.execPath, [tw.cli, '-c', path.join(work, 'tailwind.config.cjs'), '-i', path.join(work, 'in.css'), '-o', out, '--minify'], { cwd: work, encoding: 'utf8', env: { ...process.env, NODE_PATH: tw.nodeModules }, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
  fs.rmSync(work, { recursive: true, force: true });
  const pagesHtml = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  if (run.status === 0 && fs.existsSync(out)) fs.appendFileSync(out, weightCss(config, pagesHtml));
  if (run.status !== 0 || !fs.existsSync(out)) return { ok: false, why: `the compiler failed: ${String(run.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 200)}` };
  return { ok: true, bytes: fs.statSync(out).size };
}

// 2. pictures in several sizes (made once; a picture that is already small is left alone)
async function pictureVariants(dir, src) {
  const file = path.join(dir, src);
  if (!/\.(jpe?g|png|webp)$/i.test(src) || !fs.existsSync(file)) return null;
  const meta = await sharp(file).metadata();
  const width = meta.width ?? 0;
  const sizes = SIZES.filter((w) => w < width - 100);
  const base = src.replace(/\.[^.]+$/, '');
  for (const w of sizes) {
    const out = path.join(dir, `${base}-${w}.jpg`);
    if (!fs.existsSync(out)) await sharp(file).resize({ width: w }).jpeg({ quality: 74, mozjpeg: true }).toFile(out);
  }
  return { width, sizes, base };
}

export async function polishSite({ dir }) {
  const report = { styles: null, pages: 0, pictures: 0, skipped: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  if (!files.length) return report;
  // pages that were polished before have no style settings left: compile from what they were, only on a fresh page
  const fresh = files.filter((f) => !fs.readFileSync(path.join(dir, f), 'utf8').includes(MARK));
  const styles = fresh.length ? compileStyles(dir, fresh) : { ok: true, bytes: fs.existsSync(path.join(dir, 'styles.css')) ? fs.statSync(path.join(dir, 'styles.css')).size : 0, kept: true };
  report.styles = styles.ok ? `${Math.round(styles.bytes / 1024)} KB${styles.kept ? ' (kept)' : ''}` : `not compiled: ${styles.why}`;
  if (!styles.ok) { report.skipped = files; return report; }
  for (const f of fresh) {
    let html = fs.readFileSync(path.join(dir, f), 'utf8');
    if (styles.ok) {
      html = html.replace(/<script\b[^>]*cdn\.tailwindcss\.com[^>]*>\s*<\/script>/gi, '')
        .replace(/<script\b[^>]*id="tailwind-config"[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<script\b[^>]*>\s*tailwind\.config\s*=[\s\S]*?<\/script>/gi, '')
        .replace(/<head([^>]*)>/i, '<head$1><link rel="stylesheet" href="styles.css">');
    }
    // the first picture of the page is the one seen first: it loads at once; the others wait until they are near the screen
    let first = true;
    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    for (const tag of imgTags) {
      const src = tag.match(/\bsrc="(images\/[^"]+)"/i)?.[1];
      if (!src) continue;
      let next = tag;
      const v = await pictureVariants(dir, src);
      if (v && v.sizes.length && !/\bsrcset=/i.test(tag)) {
        const set = [...v.sizes.map((w) => `${v.base}-${w}.jpg ${w}w`), `${src} ${v.width}w`].join(', ');
        next = next.replace(/<img\b/i, `<img srcset="${set}" sizes="100vw"`);
        report.pictures++;
      }
      if (!/\bloading=/i.test(next)) next = next.replace(/<img\b/i, first ? '<img fetchpriority="high" decoding="async"' : '<img loading="lazy" decoding="async"');
      first = false;
      if (next !== tag) html = html.replace(tag, () => next);
    }
    html = html.replace(/<head([^>]*)>/i, `<head$1><style ${MARK}>${GUARD_CSS}</style><script ${MARK}>${GUARD_JS}</script>`);
    fs.writeFileSync(path.join(dir, f), html);
    report.pages++;
  }
  return report;
}
