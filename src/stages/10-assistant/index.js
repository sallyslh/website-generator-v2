// Stage 10: the website assistant (an extra the owner chose in the form). Prepares everything the assistant will know:
//   assistant.json = { enabled, persona, facts, knowledge, ownerRules, handoff, language, issues, heldBack, problems }
//   - facts      written by CODE from the owner's form: name, hours, contact, every item with its exact price, how to order or book
//   - knowledge  what the owner uploaded (PDF, Word, text, CSV, pictures), organised by the model into a clean knowledge base; whatever looks
//                private is set aside in "heldBack" instead of being published
//   - ownerRules the restrictions the owner wrote in the form
// Stage 8 puts it in the business's own database and the chat bubble on the site. The owner can then edit the knowledge and the rules in the panel.
//   assistant --project <id>

import fs from 'node:fs';
import path from 'node:path';
import { projectPath, readJson, exists } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { log } from '../../lib/log.js';
import { factsFromBrief, personaFromBrief } from '../../lib/chatPrompt.js';
import { organizeKnowledge, KNOWLEDGE_EXT } from '../../lib/knowledgeFiles.js';
import { whatsappDigits } from '../../lib/phone.js';
import { standardCases, generateSpecificCases } from '../../lib/chatTests.js';
import { tuneAssistant } from '../../lib/chatCoach.js';
import { chatComplete, askJson } from '../../lib/llm.js';
import { chatModelFor } from '../../config.js';

const STAGE = 'assistant';

export const knowledgeFilesOf = (projectId) => {
  const dir = projectPath(projectId, 'inputs/knowledge');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => KNOWLEDGE_EXT.includes(path.extname(f).toLowerCase())).sort().map((f) => path.join(dir, f)) : [];
};

// Who to send the customer to when the assistant does not know: the owner's WhatsApp, else the phone, else the contact page.
export function handoffOf(brief) {
  const c = brief.business?.contact ?? {};
  const wa = whatsappDigits(c.whatsapp ? `+${String(c.whatsapp).replace(/^\+/, '')}` : '');
  return { whatsapp: wa, phone: String(c.phone ?? '').trim(), contactPath: brief.pages?.some((p) => p.slug === 'contact') ? '/contact/' : '' };
}

// ask: the model call that organises the files. chat / coach / specific: the calls of the tuning (tests pass fakes). tune: false skips the tuning.
export async function prepareAssistant({ projectId, ask, chat = chatComplete, coach = askJson, specific = askJson, tune = process.env.ASSISTANT_TUNE !== 'off', onStep = () => {} } = {}) {
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  if (!brief.assistant?.enabled) return { enabled: false };
  const facts = factsFromBrief(brief);
  const made = await organizeKnowledge({ projectId, files: knowledgeFilesOf(projectId), facts, ...(ask ? { ask } : {}) });
  const config = {
    enabled: true,
    persona: personaFromBrief(brief),
    facts,
    knowledge: made.knowledge,
    ownerRules: brief.assistant.rules ?? '',
    handoff: handoffOf(brief),
    language: (brief.language || 'en').slice(0, 2).toLowerCase(),
    model: brief.assistant.model === 'economy' ? 'economy' : 'standard', // the owner's choice in the form: the tuning below runs on the same model the visitors will talk to
    issues: made.issues, heldBack: made.heldBack, problems: made.problems, used: made.used,
    adjustments: [], tests: [], tuned: null,
    preparedAt: new Date().toISOString(),
  };
  // Tuning before delivery: tests made from this business's own material, the coach fixes what fails, a fix stays only if it helps and breaks nothing.
  // What it learns goes into the business's own layer (adjustments); the tests are kept for the owner.
  if (tune) {
    try {
      const cases = [...standardCases(brief), ...(await generateSpecificCases({ persona: config.persona, facts, knowledge: config.knowledge, ownerRules: config.ownerRules, heldBack: config.heldBack, ask: specific, projectId }))];
      const t = await tuneAssistant({ config, cases, secrets: made.secrets, ask: (args) => chat({ ...args, ...(chatModelFor(config.model) ? { model: chatModelFor(config.model) } : {}) }), coachAsk: coach, onStep });
      if (t.results.length && t.results.every((r) => r.category === 'error')) throw new Error(`the AI service did not answer (${t.results[0].reply})`);
      config.adjustments = t.adjustments;
      config.tests = cases;
      config.tuned = { before: t.before, after: t.after, rounds: t.rounds.map((r) => ({ round: r.round, kept: r.kept ?? [], pass: r.pass })), failing: t.results.filter((r) => r.problems.length).map((r) => ({ q: r.q, category: r.category, problems: r.problems })), at: new Date().toISOString() };
    } catch (err) { config.problems.push(`The automatic tests could not run: ${String(err.message).split(/\r?\n/)[0].slice(0, 300)}`); }
  }
  fs.writeFileSync(projectPath(projectId, 'assistant.json'), JSON.stringify(config, null, 2));
  return config;
}

export async function run({ projectId }) {
  if (!exists(projectId, 'site-brief.json')) throw new Error(`There is no site-brief.json in "${projectId}": run the brief step first.`);
  const a = await prepareAssistant({ projectId });
  if (!a.enabled) { log.info(STAGE, 'the owner did not choose an assistant: nothing to prepare.'); return; }
  log.info(STAGE, `assistant prepared: ${a.used.length} file(s) read, ${a.knowledge.length} characters of knowledge, ${a.heldBack.length} item(s) set aside as private, ${a.issues.length} thing(s) to check.`);
  if (a.tuned) { log.info(STAGE, `tests: ${a.tuned.before.pass}/${a.tuned.before.total} passed at first, ${a.tuned.after.pass}/${a.tuned.after.total} after tuning (${a.adjustments.length} adjustment(s))`); for (const f of a.tuned.failing) log.info(STAGE, `still not right: "${f.q}" (${f.problems.join('; ')})`); }
  for (const p of a.problems) log.info(STAGE, `problem: ${p}`);
  for (const i of a.issues) log.info(STAGE, `to check: ${i}`);
  for (const h of a.heldBack) log.info(STAGE, `set aside (private): ${h}`);
}
