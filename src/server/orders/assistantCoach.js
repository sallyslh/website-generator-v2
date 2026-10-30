// The owner's part of the assistant: try it, say what is wrong, review a proposed fix, keep test questions. Everything happens inside the
// business's own database; the team that built the website never sees it. Owner only (checked by the server).
//
//   suggest   the owner says what is wrong with an answer. The coach proposes a small change; the SAME question is answered with and
//             without it, and the owner's test questions are run, so the owner sees what the change does before agreeing
//   apply     the owner agrees: the change joins the assistant's adjustments (each can be removed again)
// The cost of tests and coaching counts against the business's monthly allowance (never the "questions answered" count).

import { randomBytes } from 'node:crypto';
import { buildSystem, MAX_ADJUSTMENTS, CHAT_SCHEMA } from '../../lib/chatPrompt.js';
import { proposeAdjustments, asAdjustment, PROPOSAL_JSON_SCHEMA, parseProposals, COACH_SYSTEM } from '../../lib/chatCoach.js';
import { runCases, passed } from '../../lib/chatTests.js';
import { chatComplete } from '../../lib/llm.js';
import { config, chatModelFor } from '../../config.js';
import { costOf } from './chat.js';

const MAX_TESTS = 40; const RUN_AT_MOST = 30; const PENDING_MINUTES = 30; const MAX_PENDING = 50;
const CATS = ['answer', 'unknown', 'off_topic', 'restricted'];
const clean = (s, n) => String(s ?? '').replace(/\u0000/g, '').trim().slice(0, n);

export function createAssistantCoach({ store, ask = chatComplete, now = () => Date.now() }) {
  const pending = new Map();
  const sweep = () => { for (const [k, v] of pending) if (now() - v.at > PENDING_MINUTES * 60000) pending.delete(k); while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value); };

  // every model call of the coach and the tests is counted as cost
  const counted = async (args) => { const m = chatModelFor(store.getAssistant()?.model); const r = await ask(m && !args.model ? { ...args, model: m } : args); store.addChatUsage(costOf(r.model, r.usage), undefined, false); return r; };
  const coachAsk = async ({ system, prompt }) => parseProposals((await counted({ system, messages: [{ role: 'user', content: prompt }], schema: PROPOSAL_JSON_SCHEMA, maxTokens: 2500 })).text);
  const systemOf = (a, adjustments = a.adjustments) => buildSystem({ persona: a.persona, facts: a.facts, knowledge: a.knowledge, ownerRules: a.ownerRules, adjustments });
  const overBudget = (a) => store.chatUsage().usd >= (a.monthlyBudgetUsd ?? config.chatMonthlyBudgetUsd);
  const tooBusy = { error: 'The assistant\'s monthly allowance is used up, so it cannot be tested or changed until next month.', status: 429 };

  const testsOf = (a) => (a.tests ?? []).slice(0, RUN_AT_MOST);
  const summary = (results) => ({ at: new Date(now()).toISOString(), pass: passed(results), total: results.length, results: results.map((r) => ({ id: r.id, ok: !r.problems.length })) });

  const view = (a) => ({
    enabled: a.enabled, knowledge: a.knowledge, ownerRules: a.ownerRules, facts: a.facts,
    adjustments: (a.adjustments ?? []).map((x) => ({ id: x.id, kind: x.kind, text: x.text, q: x.q, a: x.a, why: x.why, source: x.source, at: x.at })),
    tests: (a.tests ?? []).map((t) => ({ id: t.id, q: t.q, category: t.expect?.category ?? [], source: t.source })),
    lastRun: a.lastRun ? { at: a.lastRun.at, pass: a.lastRun.pass, total: a.lastRun.total, failing: (a.tests ?? []).filter((t) => a.lastRun.results.find((r) => r.id === t.id && !r.ok)).map((t) => t.q) } : null,
    tuned: a.tuned ? { before: a.tuned.before, after: a.tuned.after, at: a.tuned.at } : null,
    usage: { ...store.chatUsage(), budget: a.monthlyBudgetUsd },
  });

  async function suggest({ question, feedback }) {
    sweep();
    const a = store.getAssistant();
    if (!a) return { error: 'This website has no assistant.', status: 404 };
    if (overBudget(a)) return tooBusy;
    const q = clean(question, 600); const fb = clean(feedback, 1500);
    if (!fb) return { error: 'Please tell us what is not right, or what it should do.', status: 400 };

    const answerWith = async (cfg, text) => { const r = await counted({ system: systemOf(cfg), messages: [{ role: 'user', content: text }], schema: CHAT_SCHEMA }); try { return JSON.parse(r.text); } catch { return { category: 'invalid', reply: r.text }; } };
    const before = q ? await answerWith(a, q) : null;
    const problems = q ? [{ q, reply: before.reply, category: before.category, issues: ['the owner says this is not right'] }] : [];
    let proposals;
    try { proposals = await proposeAdjustments({ config: a, problems, feedback: fb, allowKnowledge: true, ask: coachAsk, projectId: 'owner-coach' }); }
    catch { return { error: 'Sorry, we could not work out a change just now. Please try again in a moment.', status: 502 }; }
    const real = proposals.filter((p) => p.kind !== 'none');
    if (!real.length) return { id: null, proposals: [], explanation: proposals.find((p) => p.kind === 'none')?.why || 'We could not find a safe change for that. If it is a missing fact, add it to "What it knows".', before };
    if ((a.adjustments ?? []).length + real.length > MAX_ADJUSTMENTS) return { error: `It already has ${MAX_ADJUSTMENTS} adjustments. Remove some you no longer need.`, status: 400 };

    const mine = real.slice(0, 2).map((p) => asAdjustment(p, 'owner', new Date(now())));
    const draft = { ...a, adjustments: [...(a.adjustments ?? []), ...mine] };
    const after = q ? await answerWith(draft, q) : null;

    // what the change does to the owner's test questions: the same questions on the current assistant (last run, or now) and on the changed one
    let tests = null; const cases = testsOf(a);
    if (cases.length) {
      const base = a.lastRun?.results?.length ? new Map(a.lastRun.results.map((r) => [r.id, r.ok])) : new Map((await runCases({ system: systemOf(a), cases, ask: counted })).map((r) => [r.id, !r.problems.length]));
      let res = await runCases({ system: systemOf(draft), cases, ask: counted });
      // an answer varies a little: a test that passed before and fails now is asked once more before the owner is warned about it
      const maybe = res.filter((r) => r.problems.length && base.get(r.id));
      if (maybe.length) {
        const again = new Map((await runCases({ system: systemOf(draft), cases: cases.filter((c) => maybe.some((r) => r.id === c.id)), ask: counted })).map((r) => [r.id, r]));
        res = res.map((r) => again.get(r.id) ?? r);
      }
      tests = { total: res.length, passBefore: [...base.values()].filter(Boolean).length, passAfter: passed(res), newlyFailing: res.filter((r) => r.problems.length && base.get(r.id)).map((r) => r.q), draftRun: summary(res) };
    }
    const id = randomBytes(6).toString('hex');
    pending.set(id, { at: now(), adjustments: mine, run: tests?.draftRun ?? null });
    return { id, proposals: mine.map((m) => ({ kind: m.kind, text: m.text, q: m.q, a: m.a, why: m.why })), before, after, tests: tests && { total: tests.total, passBefore: tests.passBefore, passAfter: tests.passAfter, newlyFailing: tests.newlyFailing } };
  }

  // The owner just writes what is wrong ("Not right?" under an answer). Nothing is shown to them but the result: the fix is used only when it
  // breaks none of their tests (and goes against none of their rules), and they see how it answers now. Otherwise nothing changes and they are told why.
  async function feedback({ question, comment }) {
    const p = await suggest({ question, feedback: comment });
    if (p.error) return { ok: false, message: p.status === 429 ? 'The assistant has used its allowance for this month, so it cannot be changed now. It starts again next month.' : p.error };
    if (!p.id) return { ok: false, message: p.explanation };
    if (p.tests?.newlyFailing?.length) { pending.delete(p.id); return { ok: false, message: 'I could not do that without spoiling other answers, so I left everything as it is. You can try saying it in another way.' }; }
    const done = apply({ id: p.id });
    if (done.error) return { ok: false, message: done.error };
    return { ok: true, message: 'Done. From now on it will answer this way.', after: p.after?.reply ?? '' };
  }

  // Takes back the last change the owner asked for.
  function undoLast() {
    const a = store.getAssistant();
    const mine = (a.adjustments ?? []).filter((x) => x.source === 'owner');
    if (!mine.length) return { ok: false, message: 'There is nothing to take back.' };
    const last = mine.at(-1);
    a.adjustments = a.adjustments.filter((x) => x.id !== last.id);
    a.lastRun = null;
    store.saveAssistant(a);
    return { ok: true, message: 'Taken back. It answers as it did before that change.', left: mine.length - 1 };
  }

  function apply({ id }) {
    sweep();
    const p = pending.get(String(id ?? ''));
    if (!p) return { error: 'This proposal has expired. Please ask for it again.', status: 410 };
    pending.delete(id);
    const a = store.getAssistant();
    if ((a.adjustments ?? []).length + p.adjustments.length > MAX_ADJUSTMENTS) return { error: `It already has ${MAX_ADJUSTMENTS} adjustments. Remove some you no longer need.`, status: 400 };
    a.adjustments = [...(a.adjustments ?? []), ...p.adjustments];
    a.lastRun = p.run;
    store.saveAssistant(a);
    return view(a);
  }

  function removeAdjustment(id) {
    const a = store.getAssistant(); const before = (a.adjustments ?? []).length;
    a.adjustments = (a.adjustments ?? []).filter((x) => x.id !== id);
    if (a.adjustments.length === before) return { error: 'We could not find that.', status: 404 };
    a.lastRun = null; // the tests no longer describe this assistant
    store.saveAssistant(a);
    return view(a);
  }

  function addTest({ q, category }) {
    const a = store.getAssistant();
    const text = clean(q, 300);
    if (!text) return { error: 'Please write the question.', status: 400 };
    if ((a.tests ?? []).length >= MAX_TESTS) return { error: `You can keep up to ${MAX_TESTS} test questions.`, status: 400 };
    if ((a.tests ?? []).some((t) => t.q.toLowerCase() === text.toLowerCase())) return { error: 'You already have that test.', status: 400 };
    const cat = CATS.includes(category) ? [category] : [];
    a.tests = [...(a.tests ?? []), { id: `o${randomBytes(3).toString('hex')}`, group: 'owner', q: text, expect: { category: cat }, source: 'owner' }];
    store.saveAssistant(a);
    return view(a);
  }

  function removeTest(id) {
    const a = store.getAssistant(); const before = (a.tests ?? []).length;
    a.tests = (a.tests ?? []).filter((t) => t.id !== id);
    if (a.tests.length === before) return { error: 'We could not find that.', status: 404 };
    store.saveAssistant(a);
    return view(a);
  }

  async function runTests() {
    const a = store.getAssistant();
    if (overBudget(a)) return tooBusy;
    const cases = testsOf(a);
    if (!cases.length) return { error: 'There are no test questions yet.', status: 400 };
    const results = await runCases({ system: systemOf(a), cases, ask: counted });
    a.lastRun = summary(results);
    store.saveAssistant(a);
    return { ...view(a), results: results.map((r) => ({ q: r.q, category: r.category, reply: r.reply, ok: !r.problems.length, problems: r.problems })) };
  }

  return { view, suggest, feedback, undoLast, apply, removeAdjustment, addTest, removeTest, runTests, COACH_SYSTEM };
}
