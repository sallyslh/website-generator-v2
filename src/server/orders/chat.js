// The website assistant's answer to one customer question. Used by the business server (POST /api/chat).
//   - checks the assistant is on and the business is under its monthly budget (a business can never run up a bill)
//   - builds the prompt from what the business's own database holds, calls the model, makes the answer safe (shapeReply)
//   - counts the message and its cost; stores NOTHING of the conversation
// Whatever goes wrong (the model is down, the budget is used, the answer is not understood) the customer is never left with an error:
// they get an apology and the way to reach a person.

import { PRICES, config, chatModelFor } from '../../config.js';
import { chatComplete } from '../../lib/llm.js';
import { CHAT_SCHEMA, buildSystem, cleanMessages, shapeReply } from '../../lib/chatPrompt.js';

const SORRY = {
  en: { busy: 'Sorry, I cannot answer right now. A person from the team will be glad to help.', error: 'Sorry, something went wrong on my side. A person from the team will be glad to help.' },
  ar: { busy: 'عذرًا، لا أستطيع الرد الآن. يسعد أحد أفراد الفريق بمساعدتك.', error: 'عذرًا، حدث خطأ من جهتي. يسعد أحد أفراد الفريق بمساعدتك.' },
  fr: { busy: "Désolé, je ne peux pas répondre pour le moment. Une personne de l'équipe se fera un plaisir de vous aider.", error: "Désolé, un problème est survenu de mon côté. Une personne de l'équipe se fera un plaisir de vous aider." },
  es: { busy: 'Lo siento, ahora no puedo responder. Una persona del equipo te ayudará con gusto.', error: 'Lo siento, algo salió mal por mi parte. Una persona del equipo te ayudará con gusto.' },
  de: { busy: 'Entschuldigung, ich kann gerade nicht antworten. Eine Person aus dem Team hilft Ihnen gern.', error: 'Entschuldigung, bei mir ist etwas schiefgelaufen. Eine Person aus dem Team hilft Ihnen gern.' },
};
const sorry = (language, kind) => (SORRY[String(language ?? 'en').slice(0, 2)] ?? SORRY.en)[kind];

// What one answer cost, from the tokens the API reports (cached reads are a tenth of the input price, cache writes a quarter more).
export function costOf(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return 0;
  const input = (usage.input_tokens ?? 0) * price.input + (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 + (usage.cache_read_input_tokens ?? 0) * price.input * 0.1;
  return (input + (usage.output_tokens ?? 0) * price.output) / 1_000_000;
}

// store: the business's store. body: { messages: [{ role, content }] } from the browser. ask: the model call (a test passes a fake).
// Returns { status, json }.
export async function answerChat({ store, body, ask = chatComplete, log = console }) {
  const a = store.getAssistant();
  if (!a?.enabled) return { status: 404, json: { error: 'This website has no assistant.' } };
  const messages = cleanMessages(body?.messages);
  if (!messages) return { status: 400, json: { error: 'Please type your question.' } };
  const question = messages.at(-1).content;
  const reach = (kind) => ({ ...shapeReply({ category: 'unknown', reply: sorry(a.language, kind) }, { handoff: a.handoff, question }) });

  const budget = a.monthlyBudgetUsd ?? config.chatMonthlyBudgetUsd;
  if (store.chatUsage().usd >= budget) return { status: 200, json: reach('busy') };

  let answer; let usage = {}; let model;
  try {
    const r = await ask({ system: buildSystem({ persona: a.persona, facts: a.facts, knowledge: a.knowledge, ownerRules: a.ownerRules, adjustments: a.adjustments }), messages, schema: CHAT_SCHEMA, ...(chatModelFor(a.model) ? { model: chatModelFor(a.model) } : {}) }); // the owner chose the standard or the economy model in the form
    usage = r.usage; model = r.model;
    try { answer = JSON.parse(r.text); } catch { answer = null; }
    if (r.stopReason === 'refusal') answer = null;
  } catch (err) {
    log.error?.(`[chat] the model call failed: ${err.status ?? ''} ${err.message}`); // never the customer's words
    return { status: 200, json: reach('error') };
  }
  store.addChatUsage(costOf(model, usage));
  if (!answer) return { status: 200, json: reach('error') };
  return { status: 200, json: shapeReply(answer, { handoff: a.handoff, question }) };
}
