// All LLM prompts for Stage 4 (content generation).

import { BANNED_CLICHES, NEEDS_MARKER } from './rules.js';
import { listedSections, dishIndex } from './dishLists.js';
import { formatPrice } from '../../lib/price.js';

export const WRITER_SYSTEM = `You are a senior copywriter for small businesses. You write the real website copy, section by section, in the brand's own voice.

TRUTH RULES (most important)
1. Use ONLY facts that are in the brief or in the customer's documents you are given. Never invent: prices, numbers, years, awards, certifications, guarantees, delivery promises, product names, ingredients, testimonials, reviews, customer counts, locations, or opening hours.
2. If a section needs a fact you do not have (prices, real testimonials, team names, an address...), do NOT make one up and do NOT pretend. Write around it, and add one line to that section's "body" that starts with "${NEEDS_MARKER}" and says what the customer must provide, e.g. "${NEEDS_MARKER} prices for each perfume from the customer". Use this marker only for facts that are really missing.
2b. PRICES: when an offering has a price in the brief, show that exact price next to the offering wherever you list it (for example in the item text: "Haircut - from $25"). Copy it exactly: do not change, round, convert or add a currency. If the brief has no price for an offering, do not write one.
3. Contact details (phone, email, address, hours, social links) appear only if the brief has them. Copy them exactly. If one is missing, use the NEEDS marker, never a placeholder like "[phone]".
4. The photo descriptions you see are ONLY for writing alt text. Never take product names, brand names, sizes or any other facts from them: a name on a photo is not confirmed by the owner. Use the offerings of the brief (generic names are fine).
5. Do not invent how the business works: no payment methods, delivery, returns, stock, confirmation steps or opening hours that the brief does not state. Describe only the process the brief gives (for example "customers order by DM"); for anything else use the NEEDS marker.
6. No claims the owner did not make ("100% original", "free delivery", "best prices", "handmade", "family-owned"...), unless the brief says so.
7. No lorem ipsum, no [placeholders], no emojis (unless the brief's tone clearly asks for them).

ABOUT / STORY
- If the brief has a "business.story", it is the INSPIRATION for the About section: rewrite it in YOUR OWN WORDS, better: warmer, clearer, more specific, in the voice of the business. Keep every fact exactly as given and add none (no years, places, numbers, awards or events the owner did not state).
- Speak directly to the ideal customer ("audience.description") and say in one or two short lines who the business is for, so the right people feel it is meant for them. If "audience.notFor" is given, say gently who it is not for.
- If there is no story, write around it and add a line starting with "${NEEDS_MARKER}" asking for the owner's story.

STYLE RULES
- Write in the brief's language and tone. Sound like THIS business, so the text could not be pasted onto a competitor's site.
- Headlines are short and specific (about 3 to 9 words). Say something concrete about what the business does or sells.
- Never use these clichés: ${BANNED_CLICHES.map((c) => `"${c}"`).join(', ')}.
- Calls to action name the real next step ("Order by DM", "Send us a message"), tied to the business goal.
- Copy length fits the section: heroes get a heading plus one short subheading; list sections get items with a title and a short text; do not pad.

STRUCTURE RULES
- Return EXACTLY the sections you are given, with the same ids, in the same order.
- "imageAlt" has one entry for EVERY image slot of the section, keyed by slot id: a plain, factual description of what the picture shows (use the asset description you are given; for a slot with no photo yet, describe the picture that should go there as if it existed, e.g. "A wildflower-print water bottle in a woven basket"; NEVER write the words placeholder, coming soon or TBD in alt text). Never put brand names in alt text unless the brief has them.
- CTA "target" is one of: a page slug from the site ("contact"), "form", a full URL, "tel:<number>" (only if the brief has the number), or "social:<platform>" (only if the brief has that social link).
- SEO: title at most 60 characters, description at most 155 characters, each specific to the page.`;

function compactBrief(brief) {
  return {
    // prices are given with their currency sign ("$39", not "39.0"), so the written text shows them the same way as the menu does
    business: brief.business, goals: brief.goals, audience: brief.audience, offerings: brief.offerings.map((o) => (o.price ? { ...o, price: formatPrice(o.price, brief.currency) } : o)),
    pages: brief.pages, features: brief.features, brand: { personality: brief.brand.personality }, tone: brief.tone,
    language: brief.language, unknowns: brief.unknowns,
  };
}

const documentsText = (manifest) => (manifest.documents.length ? JSON.stringify(manifest.documents.map((d) => ({ summary: d.summary, facts: d.facts }))) : 'none');

export function globalPrompt({ brief, design, manifest, feedback }) {
  return `Write the GLOBAL parts of the website.

BRIEF:
${JSON.stringify(compactBrief(brief), null, 2)}

CUSTOMER DOCUMENTS: ${documentsText(manifest)}

PAGES OF THE SITE (slug and title): ${JSON.stringify(brief.pages.map((p) => ({ slug: p.slug, title: p.title })))}
Header layout from the design: ${design.layout.header}
Footer layout from the design: ${design.layout.footer}
${feedback ? `\nREVIEWER FEEDBACK (apply it): ${feedback}\n` : ''}
Return JSON:
{ "siteTitle": "business name as the owner wrote it",
  "navigation": [{ "label": "short label", "page": "page slug" }],   // every page except home, in order
  "primaryCta": { "label": "...", "target": "..." },               // the main action for the business goal
  "footerText": "one short line, only facts from the brief"${brief.features.some((f) => f.type === 'contact-form') ? ',\n  "formMessages": { "success": "message after sending the contact form", "error": "message if sending fails" }' : ''} }`;
}

export function pagePrompt({ brief, design, manifest, page, global, feedback }) {
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const designPage = design.pages.find((p) => p.slug === page.slug);
  const sections = designPage.sections.map((s) => ({
    id: s.id, type: s.type, purpose: s.purpose, layoutNotes: s.layoutNotes,
    slots: s.slots.map((slot) => ({
      id: slot.id, shouldShow: slot.description,
      photo: slot.assignedAsset ? byId.get(slot.assignedAsset)?.description ?? '' : 'no photo yet (placeholder)',
    })),
  }));
  const listed = listedSections(designPage).map((s) => s.id);
  const listRule = listed.length ? `\nLISTED SECTIONS (${JSON.stringify(listed)}): the dishes or products of these sections are copied by code from the owner's list, so do NOT write items for them. For each one return "items": [] and "dishes": [the numbers of the owner's dishes that belong in this section]. Every dish of the list goes in exactly one section, grouped the way the owner's categories and the section names suggest. Write only the heading, subheading and imageAlt of these sections.\nTHE OWNER'S DISHES (number, name, category): ${JSON.stringify(dishIndex(brief))}\n` : '';
  return `Write the copy for the page "${page.title}" (slug ${page.slug}). Purpose of the page: ${page.purpose}

BRIEF:
${JSON.stringify(compactBrief(brief), null, 2)}

CUSTOMER DOCUMENTS: ${documentsText(manifest)}

SITE-WIDE: name "${global.siteTitle}", main call to action ${JSON.stringify(global.primaryCta)}, other pages: ${JSON.stringify(global.navigation)}

SECTIONS TO WRITE, in this order (keep the ids):
${JSON.stringify(sections, null, 2)}
${listRule}${feedback ? `\nREVIEWER FEEDBACK (apply it): ${feedback}\n` : ''}
Return JSON:
{ "slug": "${page.slug}",
  "seo": { "title": "...", "description": "..." },
  "sections": [{ "id": "<section id>", "heading": "", "subheading": "", "body": [""], "items": [{ "title": "", "text": "" }],
                 "cta": { "label": "", "target": "" }, "imageAlt": { "<slot id>": "..." } }] }
Leave fields empty ("" or []) when the section does not need them. Omit "cta" when the section has none.`;
}
