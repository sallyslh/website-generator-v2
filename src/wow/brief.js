// The "generate first" creative brief: ONE deep concept for the whole site, written in a single call.
// Everything in it may be sample content (people, reviews, prices, stats, contact): it is tagged and replaced before going live.

import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { catalogText } from '../stages/03-creative-director/fontCatalog.js';
import { BANNED_FONTS } from '../stages/03-creative-director/fonts.js';
import { conceptBlock } from './concept.js';
import { brandBlock, tasteBlock } from './brand.js';

const str = () => z.string().default('');
const section = z.object({
  id: z.string().min(1),
  heading: str(),
  text: str(),
  layout: str(), // the layout idea: full-bleed image, split screen, horizontal gallery, oversized type...
  image: str(), // exactly what the picture shows (subject, angle, light, mood), or '' when the section has none
  items: z.array(z.object({ title: str(), text: str(), price: str(), image: str() })).default([]),
  button: str(),
});
export const wowBriefSchema = z.object({
  concept: z.string().min(10), // the idea in one sentence
  styleBlock: z.string().min(20), // the visual style, reused word for word in every page prompt
  photoshoot: z.string().min(20), // one art direction for all pictures: light, color grade, lens, time of day, subjects
  cast: str(), // how the people look, so they stay consistent across pages
  signature: str(), // the visual idea that repeats across the pages
  motion: z.enum(['calm', 'lively', 'bold']).default('bold'),
  colors: z.object({ primary: z.string(), secondary: z.string(), accent: z.string(), background: z.string(), text: z.string() }),
  fonts: z.object({ headings: z.string(), body: z.string() }),
  contact: z.object({ phone: str(), email: str(), address: str(), hours: str() }), // SAMPLE values
  team: z.array(z.object({ name: z.string(), role: z.string(), bio: str() })).default([]), // SAMPLE people
  reviews: z.array(z.object({ name: z.string(), text: z.string() })).default([]), // SAMPLE reviews
  pages: z.array(z.object({ slug: z.string(), title: z.string(), navLabel: str(), headline: str(), sections: z.array(section).min(2) })).min(1),
});

const SYSTEM = `You are the art director of a top web studio. You design ONE unforgettable website for a small business, in a single deep concept, for a customer who must say "wow, this is my website" the moment they see it.

The website is a SAMPLE for now: you may invent a believable team, reviews, prices, statistics and contact details, because the owner replaces them before the site goes live. They will be marked as sample. Never copy another business's text, people, prices or identity.
Rules for contact details: the email must end with @example.com, the phone must look like +1 555 010 0xx, the address must read "Sample address", never a real place.
Never assume anything the customer did not choose: no alcohol, wine or pork on the site unless a chosen page is about it, and keep the people, clothing and scenes modest and universally acceptable. A page called "Drinks" shows non-alcoholic drinks only.
Be elegant and tasteful, never weird. The look must feel made for THIS kind of business.`;

export function briefPrompt({ name, typeData, pages, language, concept = null, brand = null, taste = '' }) {
  const chosen = pages.map((id) => typeData.pages.find((p) => p.id === id)).filter(Boolean);
  // pages that carry a working feature must show it
  const featureNotes = chosen.filter((p) => p.feature).map((p) => `The "${p.title}" page must show ${{ booking: 'a day and time picker (and a guest or player count if it fits)', order: 'dish cards with prices and a basket' }[p.feature] ?? p.feature} as a real design element.`).join(' ');
  return `Business: "${name}", a ${typeData.label}.
Language of ALL the text on the site: ${language}.
${brand ? brandBlock(brand) : ''}${tasteBlock(taste)}${concept ? conceptBlock(concept) : ''}What is typical for this kind of business (do NOT just repeat it: it is what every other website of this kind does, and the art direction decides the look): ${typeData.styleNotes.join('; ')}.
Typical home page sections for this kind of business: ${typeData.homeSectionIdeas.join('; ')}.

The customer chose these pages (use exactly these slugs, in this order; the first one is the entry page of the site):
${chosen.map((p) => `- ${p.id}: "${p.title}". Purpose: ${p.purpose}${p.sections?.length ? ` It must cover these sections, each with its own content: ${p.sections.map((s) => `${s.title}${s.content ? ` (${s.content})` : ''}`).join('; ')}.` : ''}${p.layoutIdea ? ` Layout idea: ${p.layoutIdea}.` : ''}${p.featureNote ? ` It holds these kinds of ${p.feature}: ${p.featureNote}.` : ''}`).join('\n')}

Write the creative brief as JSON with exactly these fields:
{
 "concept": "the idea in one sentence",
 "styleBlock": "2-4 sentences describing the look: layout language, imagery, typography feel, spacing, how motion feels. It is pasted into every page prompt.",
 "photoshoot": "one art direction for ALL pictures: light, color grade, lens, time of day, what the people wear and do",
 "cast": "how the people (staff, owners, guests) look so they stay consistent",
 "signature": "one visual idea that repeats across pages (subtle, simple shapes)",
 "motion": "calm" | "lively" | "bold",
 "colors": {"primary":"#hex","secondary":"#hex","accent":"#hex","background":"#hex","text":"#hex"},
 "fonts": {"headings":"Google Font name","body":"Google Font name"},
 "contact": {"phone":"","email":"","address":"","hours":""},
 "team": [{"name":"","role":"","bio":"one sentence"}],  (4 people who run this kind of business: for example coaches, chefs or stylists)
 "reviews": [{"name":"","text":""}],  (4 short reviews)
 "pages": [{"slug":"","title":"","navLabel":"short menu label","headline":"the page's main headline","sections":[
    {"id":"slug-hero","heading":"","text":"short copy","layout":"the layout idea","image":"what the picture shows","items":[{"title":"","text":"","price":"","image":""}],"button":"button label or empty"}
 ]}]
}
Every page has 4 to 7 sections. Every section has a strong image idea unless it is a deliberate type-only moment. The entry page (the first one) opens with a cinematic full-screen hero. Vary the layouts between sections and between pages: full-bleed images, split screens, asymmetric grids, oversized type, overlapping image and text, horizontal galleries; never "hero, 3 cards, grid, testimonials" on every page. ${featureNotes} Prices (if any) include a currency sign ($).
Fonts: pick headings and body from this list only (designed lettering for headings, clear body). Never use: ${BANNED_FONTS.join(', ')}. Never a serif.
${catalogText()}
Section ids are unique across the whole site and start with the page slug.`;
}

export async function writeBrief({ projectId, name, typeData, pages, language = 'English', concept = null, brand = null, taste = '' }) {
  return askJson({ projectId, stage: 'wow-brief', system: SYSTEM, prompt: briefPrompt({ name, typeData, pages, language, concept, brand, taste }), schema: wowBriefSchema, maxTokens: 24000 });
}
