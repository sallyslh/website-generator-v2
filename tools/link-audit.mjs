// Checks every link of a generated site: pages that exist, section anchors that exist, and which links do nothing.
// node tools/link-audit.mjs <site folder>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const cheerio = createRequire(import.meta.url)('cheerio');

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
const pages = new Map(files.map((f) => [f, cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'))]));
const problems = []; const dead = [];
let total = 0;
for (const [f, $] of pages) {
  $('a').each((_, a) => {
    const href = $(a).attr('href'); const text = $(a).text().replace(/\s+/g, ' ').trim().slice(0, 40);
    const area = $(a).closest('header,nav').length ? 'MENU' : $(a).closest('footer').length ? 'footer' : 'page';
    total++;
    if (!href || href === '#' || /^javascript:/i.test(href)) { dead.push({ f, area, text, why: 'does nothing' }); return; }
    if (/^(https?:|mailto:|tel:|sms:|https:\/\/wa\.me)/i.test(href)) return;
    const [file, hash] = href.split('#'); const target = file || f;
    if (!pages.has(target)) { problems.push({ f, area, text, why: `page ${target} does not exist` }); return; }
    if (hash && !pages.get(target)('[id="' + hash + '"],a[name="' + hash + '"]').length) problems.push({ f, area, text, why: `${target} has no section #${hash}` });
  });
}
console.log(`${files.length} pages, ${total} links`);
console.log(`broken (point to something missing): ${problems.length}`); for (const p of problems) console.log(`  ${p.f} [${p.area}] "${p.text}": ${p.why}`);
const deadMenu = dead.filter((d) => d.area === 'MENU');
console.log(`do nothing: ${dead.length} (${deadMenu.length} in the top menu)`); for (const d of deadMenu) console.log(`  ${d.f} [MENU] "${d.text}"`);
const byText = new Map(); for (const d of dead.filter((x) => x.area !== 'MENU')) byText.set(d.text, (byText.get(d.text) || 0) + 1);
console.log('inactive buttons in pages/footer (text x count):', [...byText].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, n]) => `"${t}"x${n}`).join(', '));
