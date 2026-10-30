// An independent editor for the page list of ANY business type. After the list is built, a second AI call reads every page and section
// and reports three kinds of problem; code then applies the fixes and the list is read again to confirm.
//   1. content that would be shown on two pages (the page that owns it keeps it, the other drops it)
//   2. two pages about the same thing, or a page too thin to be a real page (they are merged)
//   3. a page name that is not instantly clear to an owner and a visitor (it gets the standard name)
// It never refuses a list: if the editor fails (network), the list is kept as it is and the report says so.

import { z } from 'zod';
import { askJson } from '../lib/llm.js';

const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const TIER_RANK = { essential: 0, recommended: 1, optional: 2 };
export const MAX_NAME_WORDS = 4;
export const MAX_SECTIONS = 8;

export const reviewSchema = z.object({
  repeats: z.array(z.object({ content: z.string().default(''), owner: z.string(), removeFrom: z.string(), section: z.string().default('') })).default([]),
  samePages: z.array(z.object({ keep: z.string(), absorb: z.string(), why: z.string().default('') })).default([]),
  thinPages: z.array(z.object({ id: z.string(), mergeInto: z.string(), why: z.string().default('') })).default([]),
  unclearNames: z.array(z.object({ id: z.string(), better: z.string(), why: z.string().default('') })).default([]),
});

const EDITOR = 'You are a strict editor of website structures. You only report real problems, with the exact ids. If the list is fine you return empty lists.';

export const reviewPrompt = ({ label, pages }) => `Here is the final page structure for the website of a "${label}". Check it as a strict editor.
${JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, tier: p.tier, purpose: p.purpose, uniqueContent: p.uniqueContent, sections: (p.sections ?? []).map((s) => ({ title: s.title, content: s.content })) })))}

Check three things.

1. REPEATED CONTENT. Would any content be shown on more than one page? Look at what each section really contains, not at its title: "Book a court" on two pages, a private room on three pages, a tasting on two pages, opening hours on Home, Contact and a café page are all repeats. The Home page may preview something in a few words, so ignore Home. Different pages may talk about the same topic only if their content is clearly different (a gallery of finished cakes is not the cake order form). For every repeat say which page OWNS the content ("owner": page id) and which page must drop it ("removeFrom": page id, "section": the exact section title to drop there).
   If two WHOLE pages are about the same thing, list them in "samePages" (keep, absorb).
2. THIN PAGES. Is any page too thin to be a real page, with less than a few distinct things to show? List it in "thinPages" with the page it should be merged into. Do not report Home or Contact.
3. NAMES. Is the page name instantly clear to a business owner and to any visitor, from the name alone? It must be the plain, standard name websites use, one to three words (four at most), never clever, poetic or marketing. Report unclear names in "unclearNames" with the standard name to use ("better").
   Good: About us, Menu, Prices, Team, Reviews, FAQ, Events, Community, Order online, Book online, Courts, Dental treatments.
   Bad: Customer Love, Good to Know, What's on, Social play, Regulars' Club, Start Here, The Experience.

Answer as JSON: {"repeats":[{"content":"what is repeated","owner":"page id","removeFrom":"page id","section":"section title to drop there"}],"samePages":[{"keep":"id","absorb":"id","why":""}],"thinPages":[{"id":"id","mergeInto":"id","why":""}],"unclearNames":[{"id":"id","better":"Name","why":""}]}`;

const issuesIn = (r) => (r.repeats?.length ?? 0) + (r.samePages?.length ?? 0) + (r.thinPages?.length ?? 0) + (r.unclearNames?.length ?? 0);

function mergeInto(pages, keepId, absorbId, applied, why) {
  const keep = pages.find((p) => p.id === keepId); const absorb = pages.find((p) => p.id === absorbId);
  if (!keep || !absorb || keep === absorb || absorb.id === 'home' || absorb.id === 'contact') return;
  const have = new Set((keep.sections ?? []).map((s) => norm(s.title)));
  for (const s of absorb.sections ?? []) if (!have.has(norm(s.title)) && (keep.sections ?? []).length < MAX_SECTIONS) { keep.sections = [...(keep.sections ?? []), s]; have.add(norm(s.title)); }
  keep.mergedFrom = [...new Set([...(keep.mergedFrom ?? [keep.id]), ...(absorb.mergedFrom ?? [absorb.id])])];
  if ((TIER_RANK[absorb.tier] ?? 2) < (TIER_RANK[keep.tier] ?? 2)) keep.tier = absorb.tier;
  if (!keep.feature && absorb.feature) { keep.feature = absorb.feature; keep.featureNote = absorb.featureNote ?? ''; }
  else if (keep.feature && absorb.feature === keep.feature && absorb.featureNote) keep.featureNote = [keep.featureNote, absorb.featureNote].filter(Boolean).join('; ');
  keep.demoNeeds = [...new Set([...(keep.demoNeeds ?? []), ...(absorb.demoNeeds ?? [])])];
  if ((absorb.evidence === 'seen')) keep.evidence = 'seen';
  pages.splice(pages.indexOf(absorb), 1);
  applied.merged.push({ kept: keep.title, absorbed: absorb.title, why: why ?? '' });
}

// Applies one review to a list of pages (a copy is returned, the input is not changed)
export function applyReview(pagesIn, review) {
  const pages = pagesIn.map((p) => ({ ...p, sections: (p.sections ?? []).map((s) => ({ ...s })) }));
  const applied = { removedSections: [], merged: [], renamed: [] };
  for (const r of review.repeats ?? []) {
    const page = pages.find((p) => p.id === r.removeFrom);
    if (!page || page.id === 'home' || (page.sections ?? []).length <= 2) continue; // a page keeps at least two sections
    const at = page.sections.findIndex((s) => norm(s.title) === norm(r.section));
    if (at < 0) continue;
    const [gone] = page.sections.splice(at, 1);
    applied.removedSections.push({ page: page.title, section: gone.title, ownedBy: pages.find((p) => p.id === r.owner)?.title ?? r.owner });
  }
  for (const m of review.samePages ?? []) mergeInto(pages, m.keep, m.absorb, applied, m.why);
  for (const t of review.thinPages ?? []) mergeInto(pages, t.mergeInto, t.id, applied, t.why);
  for (const n of review.unclearNames ?? []) {
    const page = pages.find((p) => p.id === n.id); const better = String(n.better ?? '').trim();
    if (!page || !better || norm(better) === norm(page.title) || better.split(/\s+/).length > MAX_NAME_WORDS || better.length > 34) continue;
    applied.renamed.push({ from: page.title, to: better }); page.title = better;
  }
  return { pages, applied };
}

// Review, repair, review again. At most two repair rounds and a final reading; whatever is left is reported, never hidden.
export async function reviewAndRepair({ label, pages: start, ask = askJson, rounds = 2 }) {
  let pages = start; const total = { removedSections: [], merged: [], renamed: [] };
  const report = { rounds: 0, applied: total, remaining: null, note: '' };
  try {
    for (let round = 0; round <= rounds; round++) {
      const review = await ask({ projectId: 'wow-research', stage: 'wow-type-review', system: EDITOR, schema: reviewSchema, maxTokens: 5000, prompt: reviewPrompt({ label, pages }) });
      report.rounds = round + 1;
      if (!issuesIn(review)) { report.remaining = []; break; }
      if (round === rounds) { report.remaining = [...(review.repeats ?? []).map((r) => `repeated: ${r.content}`), ...(review.samePages ?? []).map((s) => `same page: ${s.keep} / ${s.absorb}`), ...(review.thinPages ?? []).map((t) => `thin: ${t.id}`), ...(review.unclearNames ?? []).map((n) => `unclear name: ${n.id}`)]; break; }
      const out = applyReview(pages, review);
      pages = out.pages;
      for (const k of Object.keys(total)) total[k].push(...out.applied[k]);
    }
  } catch (err) { report.note = `the editor could not finish (${String(err.message).slice(0, 80)}): the list is kept as built`; report.remaining ??= ['not reviewed']; }
  return { pages, report };
}
