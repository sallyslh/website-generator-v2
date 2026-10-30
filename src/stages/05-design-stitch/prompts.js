// Builds the Stitch prompts (no LLM here, just text assembly from the design and content specs).

import { NEEDS_MARKER } from '../04-content/rules.js';
import { isListedSection } from '../04-content/dishLists.js';

// A long list (a menu of 100 dishes) is too much for one Stitch request: it runs out of time. TEMPORARY RULE until the final site
// builder repeats the list rows itself: Stitch draws the layout with this many dishes per list section, and says so on the page.
export const SKETCH_SAMPLE = 6;

const fontName = (text) => text.split(':')[0].trim();

// The signature idea (for example drifting coffee beans) goes into every page prompt, so the design is not generic.
function signatureLine(sig) {
  if (!sig) return '';
  return `SIGNATURE ELEMENT (make it a visible, characteristic part of the design, drawn with simple vector shapes, never an emoji or a stock icon): "${sig.name}": ${sig.idea} Place it: ${sig.placements.join('; ')}.`;
}

function describeSection(section, copy, number, sample = SKETCH_SAMPLE) {
  const lines = [`${number}. Section "${section.id}" (${section.type}). Purpose: ${section.purpose}`, `   Layout: ${section.layoutNotes}`];
  if (copy) {
    if (copy.heading) lines.push(`   Heading: "${copy.heading}"`);
    if (copy.subheading) lines.push(`   Subheading: "${copy.subheading}"`);
    for (const b of (copy.body ?? []).filter((x) => !x.trim().startsWith(NEEDS_MARKER))) lines.push(`   Text: "${b}"`);
    const items = copy.items ?? [];
    const shownItems = isListedSection(section) && items.length > sample + 2 ? items.slice(0, sample) : items;
    for (const i of shownItems) lines.push(`   Item: "${i.title}" - "${i.text}"`);
    if (shownItems.length < items.length) lines.push(`   (This list has ${items.length} items in total. Draw ONLY the ${shownItems.length} above, as a sample of the row design. The other ${items.length - shownItems.length} are added later in exactly the same row style. Do not invent any item and do not write "and more".)`);
    if (copy.cta) lines.push(`   Button: "${copy.cta.label}"`);
    if ((copy.body ?? []).some((b) => b.trim().startsWith(NEEDS_MARKER))) lines.push('   (Some facts are not known yet: leave a tidy empty area where they will go. Do not invent them.)');
  }
  // a picture only where there is a photo for it: a slot without one is not drawn at all (no empty frame, no placeholder)
  const shown = section.slots.filter((slot) => slot.assignedAsset);
  for (const slot of shown)
    lines.push(`   [Image slot ${slot.id}: ${slot.description}, ${slot.aspect ?? 'any shape'}] Use the slot id as the image's alt text.`);
  if (section.slots.length && !shown.length) lines.push('   (No picture in this section: draw no picture, no frame, no placeholder box and no caption card. Let the text and the color use the full width.)');
  return lines.join('\n');
}

// homeNote: short text that makes other pages match the approved home page (header and footer).
export function buildPagePrompt({ brief, design, content, slug, homeNote, sample = SKETCH_SAMPLE }) {
  const page = brief.pages.find((p) => p.slug === slug);
  const designPage = design.pages.find((p) => p.slug === slug);
  const contentPage = content.pages.find((p) => p.slug === slug);
  const c = design.colors;
  const sections = designPage.sections.map((s, i) => describeSection(s, contentPage.sections.find((x) => x.id === s.id), i + 1, sample));
  return [
    `Design the "${page.title}" page of a website for ${brief.business.name} (${brief.business.type}). Desktop layout.`,
    'IMPORTANT: use only the exact text given below. Do not write any text of your own.',
    `Purpose of this page: ${page.purpose}`,
    `Audience: ${brief.audience.description || 'general public'}. Business goal: ${brief.goals.primary}.`,
    '',
    `STYLE (apply exactly): ${design.styleBlock}`,
    `Colors: primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, background ${c.background}, text ${c.text}.`,
    `Fonts: headings ${fontName(design.typography.headings)} (designed lettering, only for short headings), body ${fontName(design.typography.body)} (clear and comfortable to read, never thin, at least 16px)${design.typography.accent ? `, accent ${fontName(design.typography.accent)} for a few words only` : ''}. Do not use a serif font anywhere.`,
    `Header: ${design.layout.header}`,
    `Footer: ${design.layout.footer}`,
    signatureLine(design.signature),
    homeNote ? `Match the already approved home page: ${homeNote}` : '',
    '',
    'PAGE SECTIONS, in this order:',
    ...sections,
    '',
    'RULES (strict): The ONLY words allowed on the page are the quoted texts above, the business name, and the navigation labels. Do NOT add any other words: no extra taglines, badges, statistics, percentages, product names, sizes like "100ml", prices, claims like "authentic" or "handmade", section labels or step captions. If a section has little text, keep it short and use whitespace instead of adding words. Every image slot keeps its frame, and the slot id is the image alt text. Draw exactly one picture frame per listed image slot and one card per listed Item: do not add extra cards, products, product names or repeated frames of your own.',
    'PICTURES: draw a picture ONLY where a section lists an Image slot. Never draw an empty picture frame, a placeholder box, a caption card or a stock picture anywhere else; where a section has no picture, use the full width for its text.',
    `Do not use: ${design.avoid.join('; ')}.`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

// The simple prompt for the A/B test: the brief only, no creative director and no copy.
export function buildBaselinePrompt(brief) {
  return `Design the home page of a website for ${brief.business.name}, a ${brief.business.type}. ${brief.business.description} Audience: ${brief.audience.description || 'general public'}. Goal: ${brief.goals.primary}. Tone: ${brief.tone}. Desktop layout.`;
}

export function homeNoteFrom(design) {
  return `header: ${design.layout.header}; footer: ${design.layout.footer}.`;
}

// ---- Lean mode: the brief + image facts that CODE computes from the asset manifest ----

const COMMON_ASPECTS = [[1, 1], [4, 5], [3, 4], [2, 3], [4, 3], [3, 2], [16, 9]];

// Nearest simple aspect ratio, e.g. 1041x1280 -> "4:5".
export function aspectOf(width, height) {
  const ratio = width / height;
  const [w, h] = COMMON_ASPECTS.reduce((best, a) => (Math.abs(a[0] / a[1] - ratio) < Math.abs(best[0] / best[1] - ratio) ? a : best));
  return `${w}:${h}`;
}

// One frame per usable photo (not the logo, never a low-quality photo), best quality first.
export function imageFrames(manifest) {
  const rank = { high: 0, medium: 1 };
  return manifest.assets
    .filter((a) => a.kind !== 'logo' && a.quality !== 'low')
    .sort((a, b) => rank[a.quality] - rank[b.quality])
    .map((a, i) => ({ slot: `photo-${i + 1}`, assetId: a.id, aspect: aspectOf(a.width, a.height), orientation: a.orientation, category: a.category, quality: a.quality }));
}

export function buildLeanPrompt(brief, manifest) {
  const b = brief.business;
  const frames = imageFrames(manifest);
  const count = (o) => frames.filter((f) => f.orientation === o).length;
  const lines = [
    `Design the home page of a website for ${b.name}, a ${b.type}. ${b.description}`,
    `Audience: ${brief.audience.description || 'general public'}. Business goal: ${brief.goals.primary}. Tone: ${brief.tone}.`,
    brief.brand.colors.length || brief.brand.personality.length ? `Brand: colors ${brief.brand.colors.join(', ') || 'not fixed'}; personality ${brief.brand.personality.join(', ')}.` : '',
    brief.offerings.length ? `Products/services: ${brief.offerings.map((o) => o.name + (o.price ? ` (${o.price})` : '')).join('; ')}.` : '',
    [b.contact.phone && `phone ${b.contact.phone}`, b.contact.email && `email ${b.contact.email}`, b.contact.address && `address ${b.contact.address}`, b.contact.hours && `hours ${b.contact.hours}`, ...b.socialLinks.map((l) => `${l.platform} ${l.url}`)].filter(Boolean).join('; ').replace(/^(.)/, 'Contact details: $1'),
    `Navigation pages: ${brief.pages.map((p) => p.title).join(', ')}.`,
    frames.length
      ? `IMAGES: the customer has ${frames.length} usable photos (${count('portrait')} portrait, ${count('landscape')} landscape, ${count('square')} square). Design exactly ${frames.length} image frames in sensible places, one per photo, using these shapes: ${frames.map((f) => `${f.slot} = ${f.aspect} ${f.category} photo`).join('; ')}. Give each frame the alt text of its name (photo-1, photo-2 ...). Do not add other pictures.`
      : 'IMAGES: the customer has no usable photos yet. Design clear empty image frames and do not draw pictures.',
    manifest.logo ? 'The customer has a logo: leave a small square logo area in the header and the footer.' : '',
    'RULES: use only the facts above. Do not invent prices, claims, product names, statistics or reviews. Desktop layout.',
  ];
  return lines.filter(Boolean).join('\n');
}

// ---- Free-style mode: our real copy and image frames, but NO creative-director style (Stitch picks the look) ----

export function buildFreeStylePrompt({ brief, design, content, slug = 'home' }) {
  const b = brief.business;
  const page = brief.pages.find((p) => p.slug === slug);
  const designPage = design.pages.find((p) => p.slug === slug);
  const contentPage = content.pages.find((p) => p.slug === slug);
  const sections = designPage.sections.map((s, i) => {
    const copy = contentPage.sections.find((x) => x.id === s.id);
    const lines = [`${i + 1}. ${s.type} section`];
    if (copy.heading) lines.push(`   Heading: "${copy.heading}"`);
    if (copy.subheading) lines.push(`   Subheading: "${copy.subheading}"`);
    for (const t of (copy.body ?? []).filter((x) => !x.trim().startsWith(NEEDS_MARKER))) lines.push(`   Text: "${t}"`);
    for (const it of copy.items ?? []) lines.push(`   Item: "${it.title}" - "${it.text}"`);
    if (copy.cta) lines.push(`   Button: "${copy.cta.label}"`);
    for (const slot of s.slots) lines.push(`   Image frame (${slot.aspect ?? 'any shape'}), alt text "${slot.id}"`);
    return lines.join('\n');
  });
  return [
    `Design the ${page.title} page of a website for ${b.name}, a ${b.type}. ${b.description}`,
    `Audience: ${brief.audience.description || 'general public'}. Business goal: ${brief.goals.primary}. Tone: ${brief.tone}.`,
    brief.brand.colors.length ? `Brand colors: ${brief.brand.colors.join(', ')}.` : '',
    'Choose a beautiful, professional visual style yourself. Desktop layout.',
    '',
    'PAGE SECTIONS in this order, with their exact text:',
    ...sections,
    '',
    `Navigation: ${content.global.navigation.map((n) => n.label).join(', ')}. Main button: "${content.global.primaryCta.label}".`,
    'RULES: the ONLY words on the page are the quoted texts above, the business name and the navigation labels. Do not add any other words, prices, claims, statistics or product names. Keep every image frame with its alt text.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}
