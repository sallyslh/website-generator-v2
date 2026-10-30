// Opens every page of a folder of sites at a phone (390), a tablet (820) and a laptop (1440) width in a real browser and reports the
// pages that stick out sideways or have text cut off at the edge.
//   node tools/check-responsive.mjs <folder> [site folder]
// Uses the same browser measuring as the QA stage. A page needs internet (its styles load from a CDN).

import fs from 'node:fs';
import path from 'node:path';
import { inspectInBrowser } from '../src/stages/09-qa/browser.js';

const root = path.resolve(process.argv[2] ?? '');
const only = process.argv[3];
if (!fs.existsSync(root)) { console.log('Usage: node tools/check-responsive.mjs <folder> [site folder]'); process.exit(1); }
// WIDTHS=360,390,768,1920,3840 chooses other sizes; PAGES=index.html,book.html chooses fewer pages
const NAMES = (w) => (w < 600 ? 'phone' : w < 1100 ? 'tablet' : w < 1800 ? 'laptop' : 'tv');
const VIEWS = Object.fromEntries((process.env.WIDTHS ?? '390,820,1440').split(',').map(Number).filter(Boolean).map((w) => [`${NAMES(w)} ${w}`, { width: w, height: Math.round(w < 600 ? w * 2.16 : w < 1100 ? w * 1.4 : w * 0.625), mobile: w < 1100 }]));
const ONLY_PAGES = process.env.PAGES ? process.env.PAGES.split(',') : null;
const routes = [];
for (const dir of fs.readdirSync(root, { withFileTypes: true })) if (dir.isDirectory() && (!only || dir.name === only)) for (const f of fs.readdirSync(path.join(root, dir.name))) if (f.endsWith('.html') && (!ONLY_PAGES || ONLY_PAGES.includes(f))) routes.push(`/${dir.name}/${f}`);
console.log(`checking ${routes.length} pages at ${Object.values(VIEWS).map((v) => v.width).join(', ')} px (a few minutes)...`);
const result = await inspectInBrowser({ distDir: root, routes, views: VIEWS, totalMs: 540000 });
if (!result) { console.log('The browser did not return results (none found, or it timed out). Try one site at a time.'); process.exit(2); }
let bad = 0;
for (const [name, v] of Object.entries(VIEWS)) {
  const rows = result.pages.map((p) => ({ route: p.route, m: p[name] }));
  const fit = rows.filter((r) => r.m?.ok && r.m.overflowPx <= 1 && !r.m.cutOff.length);
  console.log(`${name.padEnd(11)}: ${fit.length} of ${rows.length} pages fit`);
  for (const r of rows.filter((x) => !fit.includes(x))) { bad++; console.log(`   PROBLEM ${r.route}: ${r.m?.ok ? `${r.m.overflowPx}px too wide${r.m.overflowing.length ? ` (${r.m.overflowing.slice(0, 3).join(', ')})` : ''}${r.m.cutOff.length ? ` | text cut off: ${r.m.cutOff.slice(0, 3).join(', ')}` : ''}` : `could not be measured: ${r.m?.error}`}`); }
}
fs.writeFileSync(path.join(root, '..', `_share-responsive-${only ?? 'all'}.json`), JSON.stringify(result, null, 2));
console.log(bad ? `${bad} problem(s) found.` : 'Every page fits all three screen sizes.');
