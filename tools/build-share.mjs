// Builds ONE folder with several draft websites and a start page, ready to be put online or opened from any device:
//   node tools/build-share.mjs <out folder> <projectId>[:<folder name>[:<title>]] ...
// Every site keeps its own folder (padel/, cafe/ ...), the pictures are made lighter for phones, every page gets a viewport tag and a
// "do not index" tag (these are drafts with sample content), and the start page lists the sites.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { projectPath } from '../src/lib/project.js';

const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) { console.log('Usage: node tools/build-share.mjs <out folder> <projectId>[:<folder>[:<title>]] ...'); process.exit(1); }
const MAX_WIDTH = 1600; // wide enough for a laptop, light enough for a phone
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const cards = [];
for (const spec of specs) {
  const [id, folder = id, title] = spec.split(':');
  const src = projectPath(id, 'wow-site');
  if (!fs.existsSync(path.join(src, 'index.html'))) { console.log(`skipped ${id}: no site`); continue; }
  const meta = JSON.parse(fs.readFileSync(projectPath(id, 'wow.json'), 'utf8'));
  const brief = fs.existsSync(projectPath(id, 'wow-brief.json')) ? JSON.parse(fs.readFileSync(projectPath(id, 'wow-brief.json'), 'utf8')) : {};
  const dest = path.join(out, folder);
  fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
  let before = 0; let after = 0;
  for (const f of fs.readdirSync(path.join(src, 'images'))) {
    const from = path.join(src, 'images', f); const buf = fs.readFileSync(from); before += buf.length;
    const m = await sharp(buf).metadata();
    const small = /\.(jpe?g|png|webp)$/i.test(f) && (m.width ?? 0) > MAX_WIDTH ? await sharp(buf).resize({ width: MAX_WIDTH }).jpeg({ quality: 80, mozjpeg: true }).toBuffer() : buf;
    // a png stays a png (a resized one is written as jpeg data under the same name: browsers read the content, not the extension)
    fs.writeFileSync(path.join(dest, 'images', f), small); after += small.length;
  }
  let pages = 0;
  // the style file and every other file the pages need (not the pictures: they were made lighter above)
  for (const f of fs.readdirSync(src, { withFileTypes: true })) if (f.isFile() && !f.name.endsWith('.html')) fs.copyFileSync(path.join(src, f.name), path.join(dest, f.name));
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.html')) continue;
    let html = fs.readFileSync(path.join(src, f), 'utf8');
    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width, initial-scale=1">');
    if (!/name=["']robots["']/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1><meta name="robots" content="noindex, nofollow">');
    // decorative shapes that stick out a few pixels must never make a phone or tablet page scroll sideways
    if (!html.includes('data-share-fit')) html = html.replace(/<head([^>]*)>/i, '<head$1><style data-share-fit>html,body{overflow-x:clip;max-width:100%}</style>');
    fs.writeFileSync(path.join(dest, f), html); pages++;
  }
  cards.push({ folder, title: title ?? meta.name, kind: meta.type.replace(/-/g, ' '), pages, concept: brief.concept ?? '' });
  console.log(`${folder}: ${pages} pages, pictures ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
}

fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Website drafts</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#15171a;--soft:#5d636b;--line:#dedbd3;--brand:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--ink:#f2f3f5;--soft:#9aa1ab;--line:#2a2f37;--brand:#6d8dff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 16px 60px}h1{font-size:clamp(26px,6vw,38px);line-height:1.12;letter-spacing:-.02em;margin:0 0 8px}
p.lead{color:var(--soft);margin:0 0 26px}.grid{display:grid;gap:14px}@media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
a.card{display:block;text-decoration:none;color:inherit;background:var(--card);border:1.5px solid var(--line);border-radius:18px;padding:20px;min-height:44px}
a.card:hover,a.card:focus-visible{border-color:var(--brand);outline:none}a.card b{font-size:20px;display:block}.kind{color:var(--brand);font-size:13px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.meta{color:var(--soft);font-size:14px;margin-top:8px}.open{display:inline-block;margin-top:14px;font-weight:700;color:var(--brand)}
.note{margin-top:26px;padding:14px 16px;border-radius:14px;background:var(--card);border:1px dashed var(--line);color:var(--soft);font-size:14px}
</style></head><body><div class="wrap">
<h1>Website drafts</h1>
<p class="lead">Generated automatically from a short description of each business. Tap one to open it. They work on a phone, a tablet and a laptop.</p>
<div class="grid">
${cards.map((c) => `<a class="card" href="${esc(c.folder)}/index.html"><span class="kind">${esc(c.kind)}</span><b>${esc(c.title)}</b><div class="meta">${c.pages} page${c.pages === 1 ? '' : 's'}${c.concept ? ` · ${esc(c.concept.slice(0, 150))}${c.concept.length > 150 ? '…' : ''}` : ''}</div><span class="open">Open the website →</span></a>`).join('\n')}
</div>
<div class="note">These are first drafts. The pictures, names, reviews, prices and contact details are samples, and the buttons that book, order or call become active once the business's real information is added.</div>
</div></body></html>
`);
console.log(`start page written: ${out}${path.sep}index.html (${cards.length} sites)`);
