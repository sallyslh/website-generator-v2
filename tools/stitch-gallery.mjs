// Builds projects/stitch-tests.html: one page with every Stitch design test of every project (page screenshots, variants,
// the second "freestyle" sketch), newest first, each picture linking to its design page.
//   node tools/stitch-gallery.mjs        then open projects/stitch-tests.html in a browser
// The page sits next to the project folders and links to them with relative paths, so it works straight from disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (...parts) => parts.join('/').split('/').map(encodeURIComponent).join('/');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const has = (id, rel) => rel && fs.existsSync(path.join(root, id, rel));

const projects = [];
for (const id of fs.readdirSync(root)) {
  const dir = path.join(root, id);
  const manifest = readJson(path.join(dir, 'design/design-manifest.json'));
  if (!fs.statSync(dir).isDirectory() || !manifest) continue;
  const brief = readJson(path.join(dir, 'site-brief.json')); const answers = readJson(path.join(dir, 'inputs/answers.json'));
  const when = fs.statSync(path.join(dir, 'design/design-manifest.json')).mtime;
  projects.push({
    id, manifest, when,
    business: brief?.business?.name || answers?.businessName || 'Unnamed business',
    type: brief?.business?.type || answers?.whatItDoes || '',
    approved: fs.existsSync(path.join(dir, 'approved-design.json')),
    built: fs.existsSync(path.join(dir, 'site/dist/index.html')),
    preview: fs.existsSync(path.join(dir, 'design/preview.html')),
  });
}
projects.sort((a, b) => b.when - a.when);

const shot = (id, png, html, label, extra = '') => has(id, png)
  ? `<a class="shot" href="${has(id, html) ? url(id, html) : url(id, png)}" target="_blank" rel="noopener"><img loading="lazy" src="${url(id, png)}" alt="${esc(label)}"><span>${esc(label)}${extra}</span></a>` : '';

let total = 0;
const cards = projects.map((p) => {
  const pages = p.manifest.pages ?? [];
  const items = [];
  for (const pg of pages) {
    items.push(shot(p.id, pg.screenshot, pg.html, pg.slug));
    for (const [i, v] of (pg.variants ?? []).entries()) items.push(shot(p.id, v.screenshot, v.html, `${pg.slug} variant ${i + 1}`, ' <em>variant</em>'));
  }
  if (p.manifest.freestyle) items.push(shot(p.id, p.manifest.freestyle.screenshot, p.manifest.freestyle.html, 'sketch 2', ' <em>Stitch creative</em>'));
  const shots = items.filter(Boolean);
  total += shots.length;
  const date = p.when.toISOString().slice(0, 10) + ' ' + p.when.toTimeString().slice(0, 5);
  const chips = [
    p.manifest.chosenSketch ? `<b class="chip info">sketch ${p.manifest.chosenSketch} chosen</b>` : '',
    p.approved ? '<b class="chip ok">approved</b>' : '', p.built ? '<b class="chip ok">built into a site</b>' : '<b class="chip">design only</b>',
  ].join('');
  return `<section class="project" data-business="${esc(p.business.toLowerCase())}">
  <header><div><h2>${esc(p.business)}</h2><p>${esc(p.type)}</p></div><div class="meta"><code>${esc(p.id)}</code><span>${date}</span></div></header>
  <div class="chips">${chips}<b class="chip">${shots.length} picture${shots.length === 1 ? '' : 's'}</b>${p.preview ? `<a class="chip link" href="${url(p.id, 'design/preview.html')}" target="_blank" rel="noopener">open the preview page</a>` : ''}</div>
  <div class="shots">${shots.join('')}</div>
</section>`;
});

const businesses = [...new Map(projects.map((p) => [p.business.toLowerCase(), p.business.charAt(0).toUpperCase() + p.business.slice(1)])).values()]; // one button per business, whatever its capitals
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Stitch tests</title>
<style>
  :root { --bg:#f3f5fa; --card:#fff; --ink:#14213d; --muted:#5b667a; --line:#e0e5ef; --accent:#2f6fed; --ok:#1c8a4a; --ok-bg:#e2f4ea; --blue-bg:#e6eefd; --chip:#eef1f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1527; --card:#17213a; --ink:#e8eefc; --muted:#9aa8c4; --line:#2a3654; --accent:#6c9bff; --ok:#4fd38a; --ok-bg:#12301f; --blue-bg:#1c2d52; --chip:#1f2b49; } }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 "Segoe UI", system-ui, Arial, sans-serif; padding: 20px 16px 48px; }
  .wrap { max-width: 1280px; margin: 0 auto; } h1 { margin: 0 0 4px; font-size: 1.8rem; } .lead { color: var(--muted); margin: 0 0 14px; }
  .bar { position: sticky; top: 0; background: var(--bg); padding: 8px 0 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; z-index: 2; }
  .bar button, .bar input { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 10px; padding: 7px 12px; }
  .bar button.on { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; } .bar button { cursor: pointer; }
  .project { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin: 0 0 16px; }
  .project > header { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; } h2 { margin: 0; font-size: 1.15rem; } header p { margin: 0; color: var(--muted); font-size: .85rem; }
  .meta { text-align: right; color: var(--muted); font-size: .8rem; display: flex; flex-direction: column; gap: 2px; } code { background: var(--chip); padding: 1px 6px; border-radius: 5px; font-size: .8rem; overflow-wrap: anywhere; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; } .chip { font-size: .72rem; font-weight: 600; background: var(--chip); color: var(--muted); border-radius: 999px; padding: 2px 10px; text-decoration: none; }
  .chip.ok { background: var(--ok-bg); color: var(--ok); } .chip.info, .chip.link { background: var(--blue-bg); color: var(--accent); }
  .shots { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; }
  .shot { flex: none; width: 210px; text-decoration: none; color: inherit; } .shot img { width: 210px; height: 280px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 10px; display: block; background: var(--chip); }
  .shot span { display: block; margin-top: 4px; font-size: .78rem; color: var(--muted); text-transform: capitalize; } .shot em { font-style: normal; color: var(--accent); }
  .shot:hover img { outline: 2px solid var(--accent); } .hidden { display: none; }
</style></head><body><div class="wrap">
<h1>All Stitch tests</h1>
<p class="lead">${projects.length} projects, ${total} pictures. Newest first. Click a picture to open the full Stitch page.</p>
<div class="bar"><input id="q" type="search" placeholder="Search a business or project id"><button class="on" data-b="">All</button>${businesses.map((b) => `<button data-b="${esc(b.toLowerCase())}">${esc(b)}</button>`).join('')}</div>
${cards.join('\n')}
</div>
<script>
  var q = document.getElementById('q'), active = '';
  function apply() { var t = q.value.toLowerCase(); document.querySelectorAll('.project').forEach(function (p) { var hit = (!active || p.dataset.business === active) && (!t || p.textContent.toLowerCase().indexOf(t) >= 0); p.classList.toggle('hidden', !hit); }); }
  q.addEventListener('input', apply);
  document.querySelectorAll('.bar button').forEach(function (b) { b.addEventListener('click', function () { active = b.dataset.b; document.querySelectorAll('.bar button').forEach(function (x) { x.classList.toggle('on', x === b); }); apply(); }); });
</script></body></html>`;
fs.writeFileSync(path.join(root, 'stitch-tests.html'), html);
console.log(`projects/stitch-tests.html: ${projects.length} projects, ${total} pictures`);
