// Side-by-side comparison of several projects' designs: are the websites for similar businesses clearly different?
//   node tools/compare-projects.mjs <projectId>[=Label] <projectId>[=Label] ...   (writes docs/restaurant-comparison.html)
// It shows each project's real sketches (home, menu, contact) and the design decisions the creative director made (colours, fonts,
// signature idea, page structure, the headline), and a plain similarity score for every pair.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('projects');
const out = path.resolve('docs');
const imgDir = path.join(out, 'restaurant-comparison');
fs.mkdirSync(imgDir, { recursive: true });

const args = process.argv.slice(2).map((a) => { const [id, label] = a.split('='); return { id, label: label ?? id }; });
if (args.length < 2) { console.error('Give at least two project ids.'); process.exit(1); }

const read = (id, f) => JSON.parse(fs.readFileSync(path.join(root, id, f), 'utf8'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hex = (h) => { const m = String(h).replace('#', '').match(/.{2}/g)?.map((x) => parseInt(x, 16)); return m?.length === 3 ? m : [0, 0, 0]; };
const colorDistance = (a, b) => { const [p, q] = [hex(a), hex(b)]; return Math.sqrt(p.reduce((s, v, i) => s + (v - q[i]) ** 2, 0)) / 441.7; }; // 0 same, 1 opposite
const fontOf = (t) => String(t ?? '').split(':')[0].trim();

const projects = [];
for (const { id, label } of args) {
  const design = read(id, 'design-spec.json'); const content = read(id, 'content-spec.json');
  const home = design.pages.find((p) => p.slug === 'home');
  const heroCopy = content.pages.find((p) => p.slug === 'home').sections[0];
  const shots = [];
  for (const slug of ['home', 'menu', 'contact']) {
    const src = path.join(root, id, 'design', `${slug}.png`);
    if (!fs.existsSync(src)) continue;
    const file = `${id}-${slug}.jpg`;
    await sharp(src).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(path.join(imgDir, file));
    shots.push({ slug, file });
  }
  const concept = fs.existsSync(path.join(root, id, 'design-concept.json')) ? read(id, 'design-concept.json') : null;
  projects.push({ id, label, design, shots, concept, headline: heroCopy.heading, sub: heroCopy.subheading,
    sections: home.sections.map((s) => s.type), headingFont: fontOf(design.typography?.headings ?? design.fonts?.headings), bodyFont: fontOf(design.typography?.body ?? design.fonts?.body),
    signature: design.signature ?? design.signatureElement ?? {}, colors: design.colors, style: design.direction?.style ?? '', mood: design.direction?.mood ?? [] });
}

// similarity of two projects, 0 (nothing alike) to 100 (the same website with other words)
function similarity(a, b) {
  const palette = 1 - (colorDistance(a.colors.primary, b.colors.primary) + colorDistance(a.colors.accent, b.colors.accent) + colorDistance(a.colors.background, b.colors.background)) / 3;
  const fonts = (a.headingFont === b.headingFont ? 0.5 : 0) + (a.bodyFont === b.bodyFont ? 0.5 : 0);
  const order = a.sections.filter((t, i) => b.sections[i] === t).length / Math.max(a.sections.length, b.sections.length);
  const signature = a.signature?.name === b.signature?.name ? 1 : 0;
  const score = Math.round(100 * (0.4 * palette + 0.2 * fonts + 0.25 * order + 0.15 * signature));
  return { score, palette: Math.round(palette * 100), fonts: Math.round(fonts * 100), order: Math.round(order * 100), signature: signature * 100 };
}

const pairs = [];
for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) pairs.push({ a: projects[i], b: projects[j], ...similarity(projects[i], projects[j]) });

const chips = (c) => Object.entries(c).map(([k, v]) => `<span class="chip" style="background:${esc(v)}" title="${esc(k)} ${esc(v)}"><i>${esc(k)}</i><b>${esc(v)}</b></span>`).join('');
const card = (p) => `<section class="col">
  <h2>${esc(p.label)}</h2>
  <p class="idea">${esc(p.design.direction?.summary ?? '')}</p>
  ${p.concept ? `<div class="concept"><b>Concept: ${esc(p.concept.chosen.name)}</b><br>${esc(p.concept.chosen.idea)}<br><small><b>First screen:</b> ${esc(p.concept.chosen.opening)}<br><b>Pictures:</b> ${esc(p.concept.chosen.pictures)}<br><small>quality ${p.concept.chosen.quality}, gimmick ${p.concept.chosen.gimmick}, typicality ${p.concept.chosen.typicality} · sparks: ${esc((p.concept.sparks ?? []).join(' | '))} · ${p.concept.concepts.filter((c) => c.id !== p.concept.chosenId && (c.gimmick > 3 || c.quality < 7)).length} other concept(s) rejected as weak or gimmicky</small></small></div>` : ''}
  <div class="chips">${chips(p.colors)}</div>
  <dl>
    <dt>Fonts</dt><dd>${esc(p.headingFont)} + ${esc(p.bodyFont)}</dd>
    <dt>Signature idea</dt><dd><b>${esc(p.signature?.name ?? '')}</b><br>${esc((p.signature?.idea ?? '').slice(0, 220))}</dd>
    <dt>Home page order</dt><dd>${p.sections.map((s) => `<span class="tag">${esc(s)}</span>`).join(' ')}</dd>
    <dt>Home headline</dt><dd>“${esc(p.headline)}”<br><small>${esc(p.sub)}</small></dd>
  </dl>
  ${p.shots.map((s) => `<figure><figcaption>${esc(s.slug)}</figcaption><img src="restaurant-comparison/${esc(s.file)}" alt="${esc(p.label)} ${esc(s.slug)}"></figure>`).join('')}
</section>`;

const verdict = (s) => (s < 35 ? 'clearly different websites' : s < 60 ? 'same family, but recognisably different' : 'too alike');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Are the websites different?</title>
<style>
:root{--bg:#f6f4ef;--fg:#1d1b18;--mut:#6d675d;--card:#fff;--line:#e2ddd2}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--fg:#f0ece3;--mut:#a39d90;--card:#201e1a;--line:#36322b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:26px} .lead{color:var(--mut);margin:0 0 20px;max-width:70ch}
.pairs{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-bottom:24px}
.pair{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.pair b{font-size:22px} .pair small{color:var(--mut)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start}
.col{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.col h2{margin:0 0 6px;font-size:20px} .idea{color:var(--mut);margin:0 0 10px}
.concept{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 10px;font-size:13px}.concept small{color:var(--mut)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{display:inline-flex;flex-direction:column;border-radius:8px;padding:6px 8px;font-size:11px;color:#fff;text-shadow:0 0 3px #000a;min-width:62px}
.chip i{font-style:normal;opacity:.9} dl{margin:0 0 12px} dt{font-weight:700;margin-top:8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
dd{margin:2px 0 0} .tag{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 8px;font-size:12px;margin:2px 2px 0 0}
figure{margin:10px 0 0} figcaption{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin-bottom:4px}
img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block}
</style></head><body>
<h1>Are the websites for similar businesses different?</h1>
<p class="lead">The same kind of business (a restaurant) sent through the same tool, each with its own personality, and no photos at all (Stitch drew its own pictures). Below: how alike the design decisions are, then the real sketches.</p>
<div class="pairs">${pairs.map((p) => `<div class="pair"><b>${p.score}%</b> alike <small>— ${verdict(p.score)}</small><br>${esc(p.a.label)} and ${esc(p.b.label)}<br><small>colours ${p.palette}% · fonts ${p.fonts}% · page order ${p.order}% · same signature ${p.signature}%</small></div>`).join('')}</div>
<div class="grid">${projects.map(card).join('')}</div>
</body></html>`;
fs.writeFileSync(path.join(out, 'restaurant-comparison.html'), html);
console.table(pairs.map((p) => ({ pair: `${p.a.label} / ${p.b.label}`, alike: `${p.score}%`, colours: p.palette, fonts: p.fonts, order: p.order, signature: p.signature, verdict: verdict(p.score) })));
