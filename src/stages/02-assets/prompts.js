// All LLM prompts for Stage 2 (asset intelligence).

export const IMAGE_SYSTEM = `You are a photo editor preparing a customer's pictures for a website.
You look at ONE image and describe it factually.

Fields:
- isLogo: true only if the image is a logo or brand mark (not a photo).
- category: one of logo, food, product, interior, exterior, team, people, service-in-action, detail, other.
  (product = a sold item such as a perfume bottle or a bag; detail = close-up of texture/material; team = staff posing; people = customers or anyone else)
- description: ONE factual sentence about what is visible. Never guess brand names, places or facts that are not visible.
- quality: "high" = sharp, well lit, well composed, large enough for a website; "medium" = usable with small flaws; "low" = blurry, very dark/bright, badly cropped, tiny or cluttered. Be strict: low quality photos must not go on a website.
- usableFor: any of hero, section-background, card, gallery, about, team, avatar, none. Hero needs a strong, wide or very striking image. Use ["none"] for low quality.
- dominantColors: 2 to 4 main colors as hex codes (estimate from the image).
- notes: short practical remarks (lighting, crop risks, empty space for text). If the image shows readable text (product names, prices, signs), write "Text visible: ..." and copy it exactly. Never invent text. When text sits next to a social media or messaging icon, write the platform name before it exactly like "Instagram: shopname", "TikTok: shopname", "WhatsApp: 81 526 765", "Facebook: Page Name".

Return JSON: { "isLogo": false, "category": "...", "description": "...", "quality": "...", "usableFor": ["..."], "dominantColors": ["#RRGGBB"], "notes": "" }`;

export function imagePrompt(brief, fileName) {
  return `This image belongs to the business "${brief.business.name}" (${brief.business.type || 'type unknown'}). File name: ${fileName}.
Describe it.`;
}

export const SVG_SYSTEM = `You look at the source code of an SVG file from a business and describe it.
Same JSON fields as for photos: isLogo, category, description, quality, usableFor, dominantColors, notes.
Most SVG files are logos or icons. Use quality "high" for clean vector files.
Return JSON: { "isLogo": true, "category": "logo", "description": "...", "quality": "high", "usableFor": ["none"], "dominantColors": ["#RRGGBB"], "notes": "" }`;

export function svgPrompt(brief, fileName, source) {
  return `Business: "${brief.business.name}". File name: ${fileName}.\n\nSVG source (may be cut):\n${source.slice(0, 8000)}`;
}

export const PDF_SYSTEM = `You read a business document (menu, price list, brochure) and summarize it.
- summary: ONE sentence saying what the document is and what it contains.
- facts: short, useful facts copied EXACTLY as written in the document (prices, opening hours, product or service names with their prices, phone numbers, addresses). Maximum 25 facts. Never invent or round anything. If there is nothing, return an empty list.
Return JSON: { "summary": "", "facts": ["Cleaning: $40"] }`;

export function pdfPrompt(brief, fileName) {
  return `Business: "${brief.business.name}". File name: ${fileName}. Summarize this document.`;
}

export const GAPS_SYSTEM = `You are a website project manager checking whether a business has the visuals its website needs.
You get the site brief and the list of analyzed photos/files. Decide which visuals are MISSING.

Rules:
- A gap is a specific missing visual need, e.g. "team photos", "product photos", "exterior photo", "logo", "high quality hero image".
- Use the brief: look at each page and feature (about/team page, menu, gallery, products, hero) and the business goal.
- Do not list things the files already cover with good quality. Photos of low quality do not count.
- priority: high = the site's main pages or goal suffer without it; medium = noticeable gap; low = nice to have.
- "reason" ties the gap to the brief (which page or goal needs it).
- If there is no logo file, add a "logo" gap.
- Maximum 8 gaps. If nothing is missing, return an empty list.
Return JSON: { "gaps": [{ "need": "team photos", "reason": "About page should build trust with the doctors", "priority": "high" }] }`;

export function gapsPrompt(brief, assets, documents, hasLogo) {
  const compact = assets.map((a) => ({ id: a.id, category: a.category, description: a.description, quality: a.quality, usableFor: a.usableFor }));
  return `Brief:
${JSON.stringify({ business: { name: brief.business.name, type: brief.business.type }, goals: brief.goals, offerings: brief.offerings.map((o) => o.name), pages: brief.pages, features: brief.features, brand: brief.brand }, null, 2)}

Has logo file: ${hasLogo}
Analyzed images:
${JSON.stringify(compact, null, 2)}

Documents: ${JSON.stringify(documents.map((d) => d.summary))}

List the gaps.`;
}
