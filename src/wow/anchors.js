// Links to a section of a page ("#reviews") whose section has no such id. The section is found by its words (a heading that mentions "review") and given the id;
// when no section matches, the link is made inactive like the other sample-content buttons. Runs after the link step, so no link ever points at nothing.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const cheerio = createRequire(import.meta.url)('cheerio');
const stem = (w) => w.toLowerCase().replace(/(ing|ies|es|s)$/, '').slice(0, 7);

export function fixAnchors({ dir }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const docs = new Map(files.map((f) => [f, cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'), { decodeEntities: false })]));
  const report = { named: [], inert: [] }; const touched = new Set();
  for (const [f, $] of docs) $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (!href.includes('#') || href === '#' || /^(https?:|mailto:|tel:)/i.test(href)) return;
    const [file, hash] = href.split('#'); const target = file || f;
    const t = docs.get(target); if (!t || !hash || t(`[id="${hash}"],a[name="${hash}"]`).length) return;
    const words = hash.split(/[-_]+/).filter((w) => w.length > 2).map(stem);
    const found = words.length && t('section, main > div, article').toArray().find((el) => {
      if (t(el).attr('id')) return false;
      const head = t(el).find('h1,h2,h3').first().text().toLowerCase() + ' ' + (t(el).attr('class') ?? '').toLowerCase();
      return words.some((w) => head.includes(w));
    });
    if (found) { t(found).attr('id', hash); report.named.push(`${target}#${hash}`); touched.add(target); }
    else { $(a).attr('href', '#').attr('data-inert', ''); report.inert.push(`${f} -> ${href}`); touched.add(f); }
  });
  for (const f of touched) fs.writeFileSync(path.join(dir, f), docs.get(f).html());
  return report;
}
