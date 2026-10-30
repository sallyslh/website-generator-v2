// Builds design/preview.html: every generated Stitch page shown as its real HTML (scaled down),
// with a link to open each at full size. Stitch's screenshots are tiny (~150x512 px), so the HTML is what we look at.

import fs from 'node:fs';
import { exec } from 'node:child_process';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { designManifestSchema } from '../../schemas/designManifest.js';
import { repairFolder } from './repairHtml.js';
import { applyRealPhotos } from './realPhotos.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function card(title, note, htmlFile) {
  return `<figure>
  <figcaption>${esc(title)}<small>${esc(note)}</small></figcaption>
  <div class="frame"><iframe src="${esc(htmlFile)}" loading="lazy" title="${esc(title)}"></iframe></div>
  <p><a href="${esc(htmlFile)}" target="_blank">Open full size in a new tab</a></p>
</figure>`;
}

export function buildPreview(projectId) {
  repairFolder(projectPath(projectId, 'design'));
  applyRealPhotos(projectId);
  const manifest = readJson(projectId, 'design/design-manifest.json', designManifestSchema);
  const cards = [];
  for (const page of manifest.pages) {
    cards.push(card(page.slug === 'home' ? 'Sketch 1: with the creative director' : `${page.slug}: main version`, 'Style, colors, fonts and layout from the creative director + our real text', page.html.replace(/^design\//, '')));
    page.variants.forEach((v, i) => cards.push(card(`${page.slug}: variant ${i + 1}`, 'Different layout and colors, same copy', v.html.replace(/^design\//, ''))));
  }
  if (exists(projectId, 'design/freestyle/home-freestyle.html'))
    cards.push(card('Sketch 2: Stitch is creative on its own', 'Same real text and photo frames, but Stitch chooses the whole look (no creative director)', 'freestyle/home-freestyle.html'));
  if (exists(projectId, 'design/lean/home-lean.html'))
    cards.push(card('Lean: brief + image facts', 'Stitch got the brief and the photo shapes computed by code (no creative director, no copywriter)', 'lean/home-lean.html'));
  if (exists(projectId, 'design/baseline/home-baseline.html'))
    cards.push(card('A/B baseline', 'Stitch got only a short description of the business (no creative director, no copy)', 'baseline/home-baseline.html'));

  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stitch results: ${esc(projectId)}</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f4f1ec; color: #1c1c1c; }
  header { padding: 14px 20px; background: #fff; border-bottom: 1px solid #ddd; position: sticky; top: 0; z-index: 2; }
  h1 { margin: 0; font-size: 1.05rem; } header p { margin: 2px 0 0; color: #666; font-size: .9rem; }
  .grid { display: flex; gap: 16px; padding: 16px; overflow-x: auto; align-items: flex-start; }
  figure { margin: 0; flex: 0 0 440px; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
  figcaption { font-weight: 600; margin-bottom: 6px; } figcaption small { display: block; font-weight: 400; color: #666; }
  .frame { width: 424px; height: 1500px; overflow: hidden; border: 1px solid #eee; position: relative; }
  iframe { width: 1440px; height: 4400px; border: 0; transform: scale(0.2944); transform-origin: top left; }
  a { color: #1f4e3d; }
</style></head><body>
<header><h1>Stitch results: ${esc(projectId)}</h1><p>Scroll sideways to compare. Each box shows the top of the real page, scaled down. Use the link under each box to read it at full size.</p></header>
<div class="grid">
${cards.join('\n')}
</div></body></html>`;
  const file = projectPath(projectId, 'design/preview.html');
  fs.writeFileSync(file, page);
  return file;
}

// Opens a file with the system's default program (the browser for .html).
export function openFile(file) {
  const command = process.platform === 'win32' ? `start "" "${file}"` : process.platform === 'darwin' ? `open "${file}"` : `xdg-open "${file}"`;
  exec(command);
}
