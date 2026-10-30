// Automatic phone repair, in two parts. Every repair is checked afterwards, and a repair that did not help is undone.
//
// 1. The first screen of the home page: a vision check says what a visitor would dislike on a phone. A fixed repair for the usual hero (text laid over a full photo)
//    is tried first, then the model with the exact problems. A repair is kept only when the check then finds fewer problems.
// 2. Measures from a real browser (a page far taller than on the laptop, sideways scrolling, tiny text): the model gets the exact sections, at most two rounds,
//    and a page that got worse is put back.

import fs from 'node:fs';
import path from 'node:path';
import { measure, phoneProblems } from './gates.js';
import { repairSite } from './responsive.js';
import { firstScreenLook } from './firstScreen.js';
import { stackHero } from './hero.js';

// lower is better: sideways scrolling counts heavily, then how much taller than the laptop the phone page is
const score = (phone, laptop) => (phone.overflowX > 0 ? 100 : 0) + Math.max(0, phone.height / Math.max(1, laptop?.height ?? phone.height) - 1) * 10 + phone.smallText * 0.1;
const found = (look) => look?.phone?.problems?.length ?? 0;

async function repairFirstScreen({ dir, projectId, ask, lookFn, log, report }) {
  const page = 'index.html'; const file = path.join(dir, page);
  if (!fs.existsSync(file)) return;
  let look = await lookFn({ dir, projectId }).catch(() => null);
  if (!look) { log('first screen: the check could not run'); return; }
  if (look.skipped) log(`first screen: the check was skipped (${look.skipped})`);
  report.laptopLook = look.laptop?.problems ?? [];
  if (!found(look)) { report.firstScreen = []; return; }
  log(`first screen on a phone: ${found(look)} problem(s): ${look.phone.problems.join(' | ')}`);
  const keep = async (label, change) => {
    const before = fs.readFileSync(file, 'utf8');
    const did = await change();
    if (!did) return;
    const after = await lookFn({ dir, projectId }).catch(() => null);
    if (after && found(after) < found(look)) { look = after; report.repaired.push(`${page} (${label})`); log(`first screen: ${label} helped, ${found(look)} problem(s) left`); }
    else { fs.writeFileSync(file, before); report.restored.push(`${page} (${label})`); log(`first screen: ${label} did not help, put back`); }
  };
  await keep('photo above the text', async () => { const r = stackHero(fs.readFileSync(file, 'utf8')); if (r.changed) fs.writeFileSync(file, r.html); return r.changed; });
  if (found(look)) await keep('model repair', async () => {
    const r = await repairSite({ dir, projectId, ask, problems: { [page]: look.phone.problems.map((p) => `First screen on a phone: ${p}`) } });
    return r.repaired.includes(page);
  });
  report.firstScreen = look.phone.problems;
}

export async function repairPhone({ dir, projectId, rounds = 2, ask, log = () => {}, measureFn = measure, lookFn = firstScreenLook }) {
  const report = { rounds: 0, repaired: [], restored: [], remaining: {}, laptopLook: [], firstScreen: [] };
  await repairFirstScreen({ dir, projectId, ask, lookFn, log, report });
  let rows = measureFn(dir, ['phone', 'laptop']).rows;
  for (let round = 1; round <= rounds; round++) {
    const problems = phoneProblems(rows);
    if (!Object.keys(problems).length) break;
    report.rounds = round;
    log(`repair round ${round}: ${Object.keys(problems).join(', ')}`);
    const r = await repairSite({ dir, projectId, problems, ask });
    if (!r.repaired.length) break;
    const after = measureFn(dir, ['phone', 'laptop']).rows;
    let undone = false;
    for (const f of r.repaired) {
      const get = (set, view) => set.find((x) => x.page === f && x.view === view);
      if (score(get(after, 'phone'), get(after, 'laptop')) > score(get(rows, 'phone'), get(rows, 'laptop'))) { fs.writeFileSync(path.join(dir, f), r.before[f]); report.restored.push(f); undone = true; } else report.repaired.push(f);
    }
    rows = undone ? measureFn(dir, ['phone', 'laptop']).rows : after;
  }
  report.remaining = phoneProblems(rows);
  return report;
}
