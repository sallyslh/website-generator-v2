// Tests the website assistant's prompt with the REAL AI (it costs a few cents). Four made-up businesses, about 30 questions each, plain-code checks.
//   node tools/chat-eval/run.mjs                      all businesses
//   node tools/chat-eval/run.mjs --only restaurant    one business
//   node tools/chat-eval/run.mjs --model claude-haiku-5-5   another model
//   node tools/chat-eval/run.mjs --repeat 2           ask every question twice (answers vary a little)
// Prints the pass rate per group and every failing answer; the full report is saved in tools/chat-eval/last-run.json.

import fs from 'node:fs';
import { buildSystem, personaFromBrief, factsFromBrief, CHAT_SCHEMA } from '../../src/lib/chatPrompt.js';
import { chatComplete } from '../../src/lib/llm.js';
import { costOf } from '../../src/server/orders/chat.js';
import { FIXTURES } from './fixtures.mjs';
import { casesFor, judge } from './cases.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('only'); const model = opt('model'); const repeat = Number(opt('repeat')) || 1;

const queue = []; const results = []; let spent = 0;
for (const [name, fx] of Object.entries(FIXTURES)) {
  if (only && only !== name) continue;
  const system = buildSystem({ persona: personaFromBrief(fx.brief), facts: factsFromBrief(fx.brief), knowledge: fx.knowledge, ownerRules: fx.ownerRules });
  for (const c of casesFor(fx)) for (let r = 0; r < repeat; r++) queue.push({ name, fx, system, c });
}
console.log(`${queue.length} questions...`);

async function worker() {
  while (queue.length) {
    const { name, fx, system, c } = queue.shift();
    let answer; let usage = {};
    try {
      const r = await chatComplete({ system, messages: [{ role: 'user', content: c.q }], schema: CHAT_SCHEMA, ...(model ? { model } : {}) });
      usage = r.usage; spent += costOf(r.model, r.usage);
      try { answer = JSON.parse(r.text); } catch { answer = { category: 'invalid', reply: r.text }; }
    } catch (err) { answer = { category: 'error', reply: String(err.message).slice(0, 200) }; }
    results.push({ business: name, group: c.group, id: c.id, q: c.q, category: answer.category, reply: answer.reply, problems: judge(fx, c, answer) });
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const by = new Map();
for (const r of results) { const k = r.group; const g = by.get(k) ?? { n: 0, ok: 0 }; g.n++; if (!r.problems.length) g.ok++; by.set(k, g); }
console.log('\nBy group:'); for (const [k, g] of by) console.log(`  ${k.padEnd(14)} ${g.ok}/${g.n}`);
const fails = results.filter((r) => r.problems.length).sort((a, b) => a.business.localeCompare(b.business) || a.id.localeCompare(b.id));
const pass = results.length - fails.length;
console.log(`\nPASS ${pass}/${results.length} (${Math.round((pass / results.length) * 100)}%)   cost about $${spent.toFixed(3)}`);
for (const f of fails) console.log(`\n[${f.business}/${f.id}] ${f.q}\n  -> ${f.category}: ${String(f.reply).replace(/\n/g, ' ').slice(0, 260)}\n  x ${f.problems.join('; ')}`);
fs.writeFileSync(new URL('./last-run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), model: model ?? 'default', pass, total: results.length, results }, null, 2));
process.exit(fails.length ? 1 : 0);
