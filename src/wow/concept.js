// The creative concept of ONE website: before the brief is written, several really different ideas are written and one is chosen.
// Why: asked once, a model gives the most typical good answer, so two padel clubs get the same dusk-navy-and-lime site. So:
//   - each project draws its own random starting points (seeded by the project id: the same project keeps its draw, every other project gets another),
//   - the model writes several concepts that must differ strongly (colour world, lettering, how pictures are used, the first screen, the motion),
//   - a judge gives each ONE taste score and flags gimmicks, and code picks the least typical of the best-tasting ones (concept.js of the old pipeline).
// There are no other rules here: no list of allowed looks, no kit of widgets, no memory of other customers' sites, and it always returns an answer.

import crypto from 'node:crypto';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { exists, readJson, writeJson } from '../lib/project.js';
import { log } from '../lib/log.js';
import { SPARKS, chooseConcept, judgeSchema, JUDGE_SYSTEM } from '../stages/03-creative-director/concept.js';
import { brandBlock, tasteBlock } from './brand.js';

export const FILE = 'wow-concept.json';
export const CONCEPTS_ASKED = 6;

// Starting points for a look: eras, movements, moods, material worlds. They belong to no trade, so a padel club can start from a travel poster
// and a bakery from a Swiss grid. A concept uses a starting point only as far as it fits THIS business.
export const DIRECTIONS = [
  'a Swiss international poster', 'a 1970s sports annual', 'an editorial magazine with huge numerals', 'a vintage travel poster', 'a brutalist grid in raw concrete',
  'sunrise gradients with soft film grain', 'a Mediterranean whitewash with deep blue', 'an earthy world of terracotta and handmade paper', 'a dark luxury world of black and brass',
  'a playful world of pastel shapes', 'a Japanese minimal world of space and one accent', 'a neon street at night', 'a tropical greenhouse', 'a blueprint and technical drawing',
  'a retro arcade cabinet', 'a gallery with white walls and one huge image', 'a collage of cut paper', 'a risograph print with two inks', 'a modern glass-and-steel showroom',
  'a handwritten notebook', 'a bold monochrome with one loud colour', 'a soft, warm, rounded home', 'a newspaper front page', 'a cinema title sequence',
  'a mountain refuge in wood and wool', 'a seaside promenade in faded colours', 'a botanical illustration plate', 'a 1990s music-festival flyer', 'a quiet library of muted tones',
  'a bright children\'s picture book', 'a motorsport livery', 'a spa of stone and steam', 'a map with a legend', 'a stage with a spotlight', 'a market stall with hand-painted signs',
];

function seeded(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return h / 4294967296; };
}
export function draw(list, seed, count) {
  const rand = seeded(seed); const pool = [...list]; const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

// How adventurous the look is. The owner can choose it; when they do not, the kind of business decides: a dentist, a doctor or a lawyer looks like a normal,
// trustworthy one (classic), while a padel club or a café may be bold. Nothing is hidden: "bold" is exactly the free, creative behaviour from before.
export const LOOKS = ['classic', 'modern', 'bold'];
const TRUST = /\b(dent\w*|clinic|medic\w*|doctor|health\w*|physio\w*|therap\w*|pharm\w*|hospital|orthodon\w*|optic\w*|vet\w*|law\w*|legal|attorney|account\w*|bank\w*|insur\w*|notary|school|nursery|kindergarten)\b/i;
export const defaultLook = ({ typeId = '', typeLabel = '' } = {}) => (TRUST.test(`${typeId} ${typeLabel}`) ? 'classic' : 'bold');

// Starting points for the classic look: calm, clean and trusted. No theme worlds.
export const CLASSIC_DIRECTIONS = [
  'a clean modern practice in white and one soft blue', 'a warm family practice with natural light and soft green', 'a calm editorial layout with generous white space',
  'a friendly, rounded home with soft colours', 'a precise minimal layout in white with one calm accent', 'a bright, airy studio with soft shadows and real photography',
  'a quiet waiting room in warm neutrals and wood', 'a fresh, light layout in mint and white',
];

export const wowConceptSchema = z.object({
  concepts: z.array(z.object({
    id: z.string(), name: z.string(), idea: z.string(), root: z.string().default(''), colourWorld: z.string().default(''), lettering: z.string().default(''),
    opening: z.string(), pictures: z.string(), rhythm: z.string(), motion: z.string().default(''), startedFrom: z.string().default(''), typicality: z.number().min(1).max(10),
  })).min(3),
});

export const CLASSIC_CONCEPT_SYSTEM = `You are the art director of a studio that designs websites for businesses where visitors must feel safe, informed and welcome in seconds (a dentist, a doctor, a clinic, a lawyer, a school).
Before any design is made you write several concepts for one website. The website must look like a NORMAL, TRUSTWORTHY one of its kind: clean, light, calm, easy to read, with real photography of people and places, clear services, clear ways to book or call, and where to find them.
- This is not the place for a theme world (no arcade, circus, jungle, neon, theatre, motorsport, comic or similar). Never make the business look like something else.
- Originality lives in the details only: how the pictures are framed, the rhythm of the sections, the typography, small friendly touches. A visitor should think "professional and kind", never "strange".
- The concepts differ from each other in layout, how pictures are used, and small touches, but all of them are calm and familiar. Colours are soft and clear: whites and light neutrals with one or two calm accents (blue, teal, green, warm sand).
- Each concept starts from a DIFFERENT starting point from the list you are given and stays clear and easy to use.
- Root each concept in what is true about this business: its name, its place, its people, its customers.
Return JSON only.`;

export const CONCEPT_SYSTEM = `You are the art director of a studio known for websites that make a business owner say "wow, that is exactly us, and nobody else looks like this".
Before any design is made you write several DIFFERENT concepts for one website. A concept is an idea for how the whole website looks, feels and moves.

- Be genuinely creative. The first idea that comes to mind for this kind of business is the one every other website has: use it at most once, as the safe option, and rate it as typical.
- The concepts must differ STRONGLY from each other: the colour world, the lettering, how pictures are used, what the first screen is, the rhythm of the pages, how things move. Not the same look in other colours.
- Each concept starts from a DIFFERENT starting point from the list you are given (a starting point is only a seed: use as much of it as fits this business, and bend it freely).
- Every concept must feel right for THIS business and the people who come to it, and stay clear and easy to use: a visitor always sees what is offered, how to book or order, and where it is. Elegant, never weird or confusing.
- Root each concept in what is true and particular about this business: its name, its place, its people, its way of working, its customers.
Return JSON only.`;

export const conceptPrompt = ({ name, typeLabel, language, pages, sparks, directions, brand = null, taste = '', look = 'bold' }) => `BUSINESS: "${name}", a ${typeLabel}. Language of the site: ${language}.
PAGES CHOSEN: ${pages.map((p) => p.title).join(', ')}.
${brand ? `${brandBlock(brand)}Because the brand colours are fixed, the concepts differ in layout, lettering, how pictures are used, the rhythm of the pages and the motion; their colour world always grows from the brand.
` : ''}
STARTING POINTS (seeds, one per concept, all different): ${directions.join(' | ')}
EXTRA SPARKS (random objects, optional): ${sparks.join(' | ')}

${tasteBlock(taste)}${look === 'classic' ? `Write ${CONCEPTS_ASKED} different concepts. ALL of them must be normal, calm and trustworthy for this kind of business; they differ in layout, how pictures are used and small touches.` : look === 'modern' ? `Write ${CONCEPTS_ASKED} different concepts. They are fresh and contemporary, clean and confident, but not theatrical; about 2 may be typical for this kind of business, the others distinctive.` : `Write ${CONCEPTS_ASKED} different concepts. About 1 may be a typical, safe one for this kind of business; the others must be clearly distinctive.`} Rate each concept's typicality honestly: 10 means "what almost every website of this kind does", 1 means "almost nobody does this".
Return JSON: { "concepts": [ { "id": "c1", "name": "short name", "idea": "one or two sentences: the idea", "root": "what in THIS business it comes from", "colourWorld": "the colours and mood", "lettering": "the voice of the lettering", "opening": "what the first screen is", "pictures": "how pictures are used", "rhythm": "how the pages flow", "motion": "how things move", "startedFrom": "the starting point used", "typicality": 1 to 10 } ] }`;

export const judgePrompt = ({ name, typeLabel, concepts }) => `BUSINESS: "${name}", a ${typeLabel}.

CONCEPTS
${JSON.stringify(concepts.map(({ id, name: n, idea, root, colourWorld, lettering, opening, pictures, rhythm, motion }) => ({ id, name: n, idea, root, colourWorld, lettering, opening, pictures, rhythm, motion })), null, 2)}

Score every concept.
Return JSON: { "scores": [ { "id": "c1", "taste": 0-10, "gimmick": true or false, "reason": "one short sentence" } ] }`;

// For a classic look the winner is the best-tasting concept, and among near-equals the most familiar one (the opposite of the bold choice).
export function chooseClassic(concepts, scores) {
  const rows = concepts.map((c) => { const j = scores.find((x) => x.id === c.id); return j ? { ...c, taste: Math.max(0, Math.min(10, Number(j.taste) || 0)), gimmick: j.gimmick === true, reason: j.reason ?? '' } : null; }).filter(Boolean);
  if (!rows.length) return null;
  const sane = rows.filter((r) => !r.gimmick); const pool = sane.length ? sane : rows;
  const best = Math.max(...pool.map((r) => r.taste));
  const candidates = pool.filter((r) => r.taste >= best - 1).sort((a, b) => b.taste - a.taste).slice(0, 3);
  const chosen = [...candidates].sort((a, b) => b.typicality - a.typicality || b.taste - a.taste)[0];
  return { chosen, candidates: candidates.map((r) => r.id), why: `the most familiar of the ${candidates.length} best-tasting concept(s): a classic look was wanted`, rows };
}

// Writes (or reads) projects/<id>/wow-concept.json and returns the chosen concept, or null (the brief is then written without one: never a failed site).
export async function makeWowConcept({ projectId, name, typeLabel, language = 'English', pages, brand = null, taste = '', look = 'bold', force = false, ask = askJson }) {
  if (!force && exists(projectId, FILE)) return readJson(projectId, FILE).chosen ?? null;
  try {
    const directions = draw(look === 'classic' ? CLASSIC_DIRECTIONS : DIRECTIONS, `${projectId}:d`, CONCEPTS_ASKED); const sparks = draw(SPARKS, `${projectId}:s`, 3);
    const { concepts } = await ask({ projectId, stage: 'wow-concept', system: look === 'classic' ? CLASSIC_CONCEPT_SYSTEM : CONCEPT_SYSTEM, prompt: conceptPrompt({ name, typeLabel, language, pages, sparks: look === 'classic' ? [] : sparks, directions, brand, taste, look }), schema: wowConceptSchema, maxTokens: 7000 });
    const { scores } = await ask({ projectId, stage: 'wow-concept', system: JUDGE_SYSTEM, prompt: judgePrompt({ name, typeLabel, concepts }), schema: judgeSchema, maxTokens: 3000 });
    const picked = look === 'classic' ? chooseClassic(concepts, scores) : chooseConcept(concepts, scores);
    if (!picked) return null;
    writeJson(projectId, FILE, { look, directions, sparks, why: picked.why, chosenId: picked.chosen.id, candidates: picked.candidates, chosen: picked.chosen, concepts: picked.rows });
    log.info('wow', `concept "${picked.chosen.name}" (taste ${picked.chosen.taste}, typicality ${picked.chosen.typicality}) from: ${picked.chosen.startedFrom}`);
    return picked.chosen;
  } catch (e) { log.info('wow', `warning: no concept this time (${e.message}); the brief is written without one`); return null; }
}

// What the brief writer is told
export const conceptBlock = (c) => (c ? `ART DIRECTION CONCEPT (chosen for this website: follow it, it decides the colours, the lettering, how pictures look, the first screen, the rhythm of the pages and how things move)
"${c.name}": ${c.idea}
Root: ${c.root}
Colour world: ${c.colourWorld}
Lettering: ${c.lettering}
First screen: ${c.opening}
Pictures: ${c.pictures}
Page rhythm: ${c.rhythm}
Motion: ${c.motion}
` : '');
