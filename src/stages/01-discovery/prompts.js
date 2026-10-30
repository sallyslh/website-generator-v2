// All LLM prompts for Stage 1 (business discovery).

export const SUGGEST_PAGES_SYSTEM =
  'You help plan small-business websites. Suggest the pages a simple website for this business needs.';

export function suggestPagesPrompt(answers) {
  return `Business: ${answers.businessName}
What it does: ${answers.whatItDoes}
Products/services: ${answers.productsAndServices}

Suggest 3 to 6 page names for a small static website (always include "Home"). Use simple, plain names.
Answer as JSON: { "pages": ["Home", "..."] }`;
}

export const FOLLOWUP_SYSTEM =
  'You are a careful website project manager. You interview business owners so a designer can build their website.';

export function followUpPrompt(answers) {
  return `Here are the interview answers of a business owner (JSON):

${JSON.stringify(answers, null, 2)}

What important information is missing or unclear for building this website?
Ask up to 5 short follow-up questions. Rules:
- Only ask what is really needed (contact details, prices the owner wants shown, real services, goals, tone, content the site depends on).
- Do not repeat anything already answered. Do not ask obvious or generic questions.
- If nothing important is missing, return fewer questions, or an empty list.
Answer as JSON: { "questions": ["...", "..."] }`;
}

export const BRIEF_SYSTEM = `You turn a business owner's raw interview answers into a structured website brief (JSON).

RULES
1. Use ONLY facts from the answers. NEVER invent facts: no prices, phone numbers, emails, addresses, hours, years in business, awards, team sizes, testimonials.
2. Anything the owner did not answer or left unclear becomes an empty value ("" or []) AND gets a short entry in "unknowns" (e.g. "No phone number provided", "Opening hours not provided", "No liked reference websites provided").
3. Keep the owner's own wording for the business name and for offering names. Do not rename things.
4. An offering's "price" is only included if the owner gave one. If the owner said they do not want prices shown, leave price out and add that to "unknowns".
5. Pages: use the owner's pages. Slugs are lowercase kebab-case ("our team" -> "our-team", "about us" -> "about"). Always include a "home" page. If the owner gave no pages, propose sensible ones for this business type and add "Pages were not specified by the customer, defaults proposed" to "unknowns".
6. Features: map what the owner wants ONLY to these types: contact-form, map-embed, booking-embed, social-links, gallery. A booking link URL goes in the feature's "url". Anything else the owner wants (online shop, catering orders, another language, chat, blog...) is NOT a feature: add "requested but out of MVP scope: <what>" to "unknowns".
7. Brand colors: copy exactly what the owner said (hex codes if given, otherwise color names like "green"). Do NOT invent hex codes. "hasIdentity" is true only if the owner says they have a logo or clear brand colors/fonts.
8. "personality" = the owner's 3 feeling words. "tone" = a short description of the writing tone that fits those words and the audience (this is the one field where you may infer).
9. "language" is "en" unless the owner clearly asks for another main language.
10. Social links: only if the owner gave a handle or URL. If only a platform is mentioned without a handle, do not create a social link; add it to "unknowns".
11. If the owner explicitly asks for a supported feature (named in the features answer or clearly requested elsewhere) but gives no details (e.g. "linkedin link" with no URL, "instagram" with no handle), STILL include the feature (social-links, booking-embed) without a url and add the missing detail to "unknowns". Never drop a requested feature because information is missing. Never ADD a feature the owner did not ask for, even if it would suit their goal (you may mention the idea in "unknowns").
12. Offering "description": only text the owner actually gave. If they gave none, use "" . NEVER repeat the offering's name or invent a description.
13. References: fill "liked" ONLY from the likedSites answer and "disliked" ONLY from the dislikedSites answer. If that answer is empty, the list stays empty, even if other answers contain opinions. If the owner gave a reason but no website (e.g. "I hate sites that look like hotels"), add the entry with only "why" and NO "url" field.
14. "story": the owner's own account of how the business started and what makes it special (answer "story"). Keep it faithfully: fix only spelling, add NO facts. If there is none, use "" and add "The owner's story was not provided" to "unknowns".
15. "audience.description" is the IDEAL customer the business is for (answers "customers"). "audience.notFor" lists who the business is NOT for, ONLY if the owner said it (answer "notFor"); otherwise [].
16. Follow-up answers (field "followUps") are part of the answers and count as facts.

OUTPUT SHAPE (JSON):
{
  "schemaVersion": 1,
  "projectId": "<given>",
  "business": { "name": "", "type": "", "description": "", "story": "", "location": "",
    "contact": { "phone": "", "email": "", "address": "", "hours": "" },
    "socialLinks": [{ "platform": "", "url": "" }] },
  "goals": { "primary": "", "secondary": [""] },
  "audience": { "description": "", "needs": [""], "notFor": [] },
  "offerings": [{ "name": "", "description": "", "price": "only if given" }],
  "pages": [{ "slug": "home", "title": "Home", "purpose": "" }],
  "features": [{ "type": "contact-form" }, { "type": "booking-embed", "url": "only if given" }],
  "brand": { "hasIdentity": true, "colors": [""], "fonts": "only if given", "personality": [""] },
  "tone": "",
  "references": { "liked": [{ "url": "", "why": "" }], "disliked": [{ "url": "", "why": "" }] },
  "language": "en",
  "unknowns": [""]
}`;

export function briefPrompt(projectId, answers) {
  return `projectId: ${projectId}

Interview answers (JSON):

${JSON.stringify(answers, null, 2)}

Write the site brief.`;
}

export const ENRICH_SYSTEM = `You complete a website brief using ONLY what the customer's own files show (photos, logo, documents).
You get the current brief (the owner's answers) and the analysis of every file.

Propose values for EMPTY brief fields only. Allowed paths and value types:
- business.type (string, e.g. "gift and home goods shop")
- business.description (string, one factual sentence about what the files show is sold or offered)
- business.contact.phone / .email / .address / .hours (string) ONLY if that exact text is visible in a file (see "Text visible" in the notes). Copy it exactly. Never guess or complete it.
- business.socialLinks (array of "platform:handle" strings, e.g. ["instagram:shopname"], platforms instagram or tiktok) ONLY if the handle is visible text next to that platform's icon or name. Never guess a handle.
- offerings (array of short generic product/service names seen in the photos, e.g. "Floral insulated tumblers"). No prices unless a price is visible. Do not use third-party brand names as product names.
- offerings.products (array of "Product name|asset-id" strings) for INDIVIDUAL products whose name is readable text in a photo (a label, a box, a tag). Use it even when the owner already listed categories: it lets the owner confirm the real product names. The name must be copied exactly as written in that photo's notes or description, and the asset id must be that photo. Never guess a name that is not readable. The owner will confirm every name.
- brand.hasIdentity (true if there is a logo file)
- brand.colors (array of hex codes taken from the logo's dominant colors)
- brand.personality (array of up to 3 words describing the look of the logo and photos)
- tone (short writing tone that fits that look)

Rules:
1. Every proposal needs "evidence": a short sentence naming the asset id(s) it comes from, e.g. "logo asset-001 shows the text 71-014463".
2. Never propose a field the owner already filled. Never invent facts: no prices, hours, addresses, years, awards, locations.
3. If any file shows a phone number, email, address or opening hours as readable text (look for "Text visible" in the notes) and that brief field is empty, you MUST propose it, copied exactly. The customer will confirm it, so proposing it is safe.
4. Skip anything you cannot support from the files. Fewer, correct proposals beat many guesses.
Return JSON: { "proposals": [{ "path": "business.type", "value": "...", "evidence": "asset-002, asset-005 show ..." }] }`;

export function enrichPrompt(brief, manifest) {
  const files = manifest.assets.map((a) => ({
    id: a.id, kind: a.kind, category: a.category, description: a.description, quality: a.quality,
    dominantColors: a.dominantColors, notes: a.notes,
  }));
  const owner = {
    name: brief.business.name, type: brief.business.type, description: brief.business.description, contact: brief.business.contact,
    goals: brief.goals, offerings: brief.offerings.map((o) => o.name), brand: brief.brand, tone: brief.tone,
  };
  return `Current brief (owner's answers):\n${JSON.stringify(owner, null, 2)}\n\nLogo asset id: ${manifest.logo ?? 'none'}\n\nAnalyzed files:\n${JSON.stringify(files, null, 2)}\n\nDocuments: ${JSON.stringify(manifest.documents)}\n\nPropose values for the empty fields.`;
}
