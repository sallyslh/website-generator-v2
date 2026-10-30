// The art-direction concept: one idea for how THIS website feels and is composed, chosen before the creative director designs.
//
// Why: asked once, a model gives the most typical good answer, so two restaurants end up with the same layout in other colors.
// So the model first writes several DIFFERENT concepts (each rooted in the business's own story), a second call gives each ONE taste
// score and says whether it is a gimmick, and code chooses. The rule is deliberately small and can never refuse anything:
//   1. concepts flagged as gimmicks are set aside (unless they all are);
//   2. the best-tasting ones (within one point of the top, at most three) are kept;
//   3. of those, the LEAST typical one wins.
// There are no thresholds, so there is always an answer, and novelty can only choose between concepts that already taste good.
// Nothing here remembers other customers' sites, and no widget kit: only an idea, in the model's own words.

import crypto from 'node:crypto';
import { z } from 'zod';
import { askJson } from '../../lib/llm.js';
import { exists, readJson, writeJson } from '../../lib/project.js';
import { log } from '../../lib/log.js';
import { inventory, inventoryText } from './inventory.js';

const STAGE = 'concept';
export const FILE = 'design-concept.json';
export const CONCEPTS_ASKED = 8;

// Things that have nothing to do with food or shops. They are creative sparks: a concept may blend ONE with the owner's own story,
// but only when it makes the site more elegant. Drawn at random for every project (the draw is seeded by the project id).
export const SPARKS = [
  'a letterpress menu card', 'a lighthouse logbook', 'a tailor\'s pattern sheet', 'a vinyl record sleeve', 'a night-market stall',
  'a botanical plate from an old herbarium', 'a train departure board', 'a ceramics studio shelf', 'a vintage cinema poster', 'a map legend',
  'a linen garment label', 'an apothecary jar label', 'a jazz club set list', 'a tide table', 'a spice merchant\'s ledger',
  'a gallery wall label', 'a ship\'s manifest', 'a concert programme', 'a seed packet', 'a postage stamp sheet',
  'an architect\'s blueprint', 'a weaver\'s swatch book', 'a radio dial', 'a bookbinder\'s endpaper', 'a hand-painted shop sign',
  'a farmers\' market chalkboard', 'a watchmaker\'s bench', 'a kimono pattern book', 'a field notebook', 'a theatre curtain call',
  'a perfumer\'s organ of scents', 'a bakery window at dawn', 'a woodblock print', 'an ice-cream parlour awning', 'a mosaic floor',
  'a travelling circus ticket', 'a fisherman\'s net and floats', 'a school timetable', 'a kiln firing schedule', 'a copper pot rack',
  'a courtyard at noon', 'a rooftop at dusk', 'a narrow alley of shops', 'a glasshouse', 'a long communal table',
  'a hand-stitched book', 'a paper lantern', 'a rain-soaked window', 'a stack of linen', 'a wall of keys',
  'the rhythm of a metronome', 'a single candle', 'a wicker basket', 'an enamel mug', 'a stone threshold',
  'a calendar page', 'a recipe card in a drawer', 'a market scale and weights', 'a tram ticket', 'a pressed flower',
  'a signal flag alphabet', 'a collector\'s cabinet', 'an old atlas', 'a sundial', 'a loom at work',
  'a barber\'s pole stripes', 'a tea ceremony tray', 'a woodworker\'s workshop', 'a river ferry timetable', 'a hand-lettered banner',
  'a ceramic tile catalogue', 'a deli counter', 'a printing press', 'a violin maker\'s sketch', 'a greenhouse label',
];

// A small seeded random generator (so a project always gets the same draw, but every project gets a different one).
function seeded(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return h / 4294967296; };
}
export function pickSparks(seed, count = 3) {
  const rand = seeded(seed);
  const pool = [...SPARKS];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

export const conceptSchema = z.object({
  concepts: z.array(z.object({
    id: z.string(), name: z.string(), idea: z.string(), root: z.string().default(''), opening: z.string(), pictures: z.string(), rhythm: z.string(),
    typeVoice: z.string().default(''), spark: z.string().default(''), typicality: z.number().min(1).max(10),
  })).min(3),
});
export const judgeSchema = z.object({
  scores: z.array(z.object({ id: z.string(), taste: z.number(), gimmick: z.boolean().default(false), reason: z.string().default('') })),
});

export const CONCEPT_SYSTEM = `You are the art director of a small studio known for calm, elegant, professional websites for independent businesses.
Before any design is made, you write several DIFFERENT concepts for one business. A concept is an idea for how the website feels and is composed.

HOW TO WRITE THEM
- Root every concept in THIS business: its own story, place, materials, people, products or hours. Not in a generic category look.
- Match the owner's VIBE (the tone and personality words in the brief, and how the owner describes the place). A quiet noodle house, a loud barbecue joint and a candle-lit bistro must each feel like themselves. A concept that feels wrong for the vibe is a bad concept, however clever.
- All concepts are elegant. They differ in IDEA and COMPOSITION (what the first screen is, how pictures are used or not used, the rhythm of the page, the voice of the lettering), never in how strange they are.
- The usual flow of this kind of business stays easy: a visitor finds what is offered, the prices, the hours, how to contact or order. The idea changes the expression, not how people use it.
- Never rely on: hidden or unusual navigation, tiny or hard-to-read text, heavy animation, 3D, video, scroll tricks, loud effects, novelty for its own sake.
- Pictures: say honestly how they are used, and for a business with few or no photos say how the page is still beautiful (type-led, a color field, a pattern, one product on a plain color). "No picture on the first screen" is a normal, good option when it suits the business.
- Include about 2 concepts that are quite typical for this kind of business (a safe option), and the others more distinctive. Rate each concept's typicality honestly: 10 means "what almost every website of this kind does", 1 means "almost nobody does this".
- A creative spark is a random object from outside this business. Blend one into some concepts ONLY if it makes the site more elegant and truthful to the owner's story. Most concepts may ignore the sparks.
Return JSON only.`;

export const JUDGE_SYSTEM = `You are a calm, experienced art director with good taste who has seen thousands of websites. You judge design concepts for one business.
For each concept give:
- "taste": ONE score from 0 to 10. How elegant, calm and professional would the finished website look, does it match THIS business's vibe (the tone and personality words in the brief) and its owner's story, and is it easy to use (a visitor sees what is offered, the prices, how to contact or order)? Would a careful art director be proud of it?
- "gimmick": true only when the idea is novelty for its own sake, confusing, loud, or harder to use than a normal site. Strange is NOT good.
A concept that does not feel like this business's vibe gets a low taste score, however elegant. Judge on quality and fit only. Do not reward a concept for being unusual. Return JSON only.`;

const brief4 = (brief) => ({ business: brief.business, goals: brief.goals, audience: brief.audience, tone: brief.tone, brand: brief.brand, offerings: brief.offerings.slice(0, 12).map((o) => o.name), offeringCount: brief.offerings.length, language: brief.language, wishes: brief.wishes, siteType: brief.siteType });

export const conceptPrompt = ({ brief, manifest, sparks }) => `BUSINESS
${JSON.stringify(brief4(brief), null, 2)}

PHOTOS THE OWNER HAS
${inventoryText(inventory(manifest, brief))}

CREATIVE SPARKS (random, optional): ${sparks.join(' | ')}

Write ${CONCEPTS_ASKED} different concepts.
Return JSON: { "concepts": [ { "id": "c1", "name": "short name", "idea": "one or two sentences: the idea", "root": "what in THIS business it comes from", "opening": "what the first screen is", "pictures": "how pictures are used (or not)", "rhythm": "how the pages flow", "typeVoice": "the voice of the lettering", "spark": "the spark used, or empty", "typicality": 1 to 10 } ] }`;

export const judgePrompt = ({ brief, concepts }) => `BUSINESS
${JSON.stringify(brief4(brief), null, 2)}

CONCEPTS
${JSON.stringify(concepts.map(({ id, name, idea, root, opening, pictures, rhythm, typeVoice }) => ({ id, name, idea, root, opening, pictures, rhythm, typeVoice })), null, 2)}

Score every concept.
Return JSON: { "scores": [ { "id": "c1", "taste": 0-10, "gimmick": true or false, "reason": "one short sentence" } ] }`;

// The choice (pure code, unit tested). Taste first; novelty only chooses between concepts that already taste good.
export function chooseConcept(concepts, scores) {
  const rows = concepts.map((c) => {
    const j = scores.find((x) => x.id === c.id);
    return j ? { ...c, taste: Math.max(0, Math.min(10, Number(j.taste) || 0)), gimmick: j.gimmick === true, reason: j.reason ?? '' } : null;
  }).filter(Boolean).map((r) => ({ ...r, quality: r.taste }));
  if (!rows.length) return null;
  const sane = rows.filter((r) => !r.gimmick);
  const pool = sane.length ? sane : rows;
  const best = Math.max(...pool.map((r) => r.taste));
  const candidates = pool.filter((r) => r.taste >= best - 1).sort((a, b) => b.taste - a.taste).slice(0, 3);
  const chosen = [...candidates].sort((a, b) => a.typicality - b.typicality || b.taste - a.taste)[0];
  return { chosen, candidates: candidates.map((r) => r.id), why: `the least typical of the ${candidates.length} best-tasting concept(s)`, rows };
}

// Writes (or reads) projects/<id>/design-concept.json and returns the chosen concept, or null (the director then works without one).
export async function makeConcept({ projectId, brief, manifest, force = false, ask = askJson }) {
  if (!force && exists(projectId, FILE)) { const saved = readJson(projectId, FILE); return saved.chosen ?? null; }
  try {
    const sparks = pickSparks(projectId, 3);
    const { concepts } = await ask({ projectId, stage: STAGE, system: CONCEPT_SYSTEM, prompt: conceptPrompt({ brief, manifest, sparks }), schema: conceptSchema, maxTokens: 6000 });
    const { scores } = await ask({ projectId, stage: STAGE, system: JUDGE_SYSTEM, prompt: judgePrompt({ brief, concepts }), schema: judgeSchema, maxTokens: 3000 });
    const picked = chooseConcept(concepts, scores);
    if (!picked) return null;
    writeJson(projectId, FILE, { sparks, why: picked.why, chosenId: picked.chosen.id, candidates: picked.candidates, chosen: picked.chosen, concepts: picked.rows });
    log.info(STAGE, `concept "${picked.chosen.name}" (taste ${picked.chosen.taste}, typicality ${picked.chosen.typicality}): ${picked.why}`);
    return picked.chosen;
  } catch (e) {
    log.info(STAGE, `warning: no concept this time (${e.message}); the creative director works without one`);
    return null;
  }
}

// What the creative director is told.
export const conceptBlock = (c) => (c ? `ART DIRECTION CONCEPT (chosen for this business: follow it)
"${c.name}": ${c.idea}
Root: ${c.root}
First screen: ${c.opening}
Pictures: ${c.pictures}
Page rhythm: ${c.rhythm}
Lettering voice: ${c.typeVoice}
The concept decides the composition of the first screen, how pictures are used and the rhythm of the pages. The sections you plan may follow the concept instead of a standard list. The PROFESSIONAL FIRST rules still win: elegant, calm, readable, and the usual flow of this kind of business (what is offered, prices, hours, how to order or contact) stays easy to find.
` : '');
