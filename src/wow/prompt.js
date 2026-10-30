// The Stitch prompt of one page in "generate first" mode: Stitch designs freely, with its own photographic pictures and people.
// Everything written here is sample content; nothing is stripped afterwards.

const fontName = (t) => String(t).split(':')[0].trim();

function describeSection(s, n) {
  const lines = [`${n}. Section "${s.id}"${s.layout ? `. Layout: ${s.layout}` : ''}`];
  if (s.heading) lines.push(`   Heading: "${s.heading}"`);
  if (s.text) lines.push(`   Text: "${s.text}"`);
  for (const i of s.items) { lines.push(`   Item: "${i.title}"${i.text ? ` - "${i.text}"` : ''}${i.price ? ` - price ${i.price}` : ''}`); if (i.image) lines.push(`   Its picture (a plain photograph, only this subject): ${i.image}`); }
  if (s.image) lines.push(`   Picture (a plain photograph, only this subject): ${s.image}`);
  if (s.button) lines.push(`   Button: "${s.button}"`);
  return lines.join('\n');
}

import { brandBlock } from './brand.js';

export function buildWowPrompt({ name, typeLabel, brief, page, pages, siteLanguage, meta = {}, brand = null }) {
  const c = brief.colors;
  const nav = pages.map((p) => p.navLabel || p.title);
  const main = nav.slice(0, 6);
  const more = nav.slice(6);
  const entry = pages[0]?.slug === page.slug; // the entry page of the site (Home, when the customer kept it)
  const team = entry ||(meta.demoNeeds ?? []).includes('people') ? `\nTeam members (sample): ${brief.team.map((t) => `${t.name}, ${t.role}${t.bio ? ` (${t.bio})` : ''}`).join('; ')}.` : '';
  const reviews = entry ||(meta.demoNeeds ?? []).includes('review') ? `\nReviews (sample): ${brief.reviews.map((r) => `"${r.text}" - ${r.name}`).join(' | ')}.` : '';
  return [
    `Design the "${page.title}" page of a stunning, image-rich website for ${name}, a ${typeLabel}. ${process.env.STITCH_DEVICE === 'MOBILE' ? 'Mobile phone layout: one phone screen wide, designed for thumbs, not a shrunk laptop page.' : 'Desktop layout.'} Language of all text: ${siteLanguage}.`,
    `CONCEPT: ${brief.concept}`,
    `STYLE (apply exactly, the same on every page): ${brief.styleBlock}`,
    `Colors: primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, background ${c.background}, text ${c.text}.`,
    `Fonts: headings ${fontName(brief.fonts.headings)}, body ${fontName(brief.fonts.body)}. No serif fonts.`,
    brief.signature ? `SIGNATURE ELEMENT repeated across pages (subtle): ${brief.signature}` : '',
    `PICTURES: this must be a cinematic, photography-led design. Every section has a strong, beautiful photographic image (real-looking photographs, including real-looking people), all in ONE art direction: ${brief.photoshoot} People look like this: ${brief.cast || 'natural, diverse, athletic'}. The subject of every photograph is clearly visible and well lit: a dark or moody look is fine, but light the subject and never dim a whole picture with a heavy dark overlay (only a soft gradient behind text where it is needed). The first picture of the site shows people or the place large and sharp. Every picture is a plain photograph: never a screenshot, never a website or app screen, no menu bar, button, price, caption or any text drawn inside a picture. A picture fills its frame completely (cropped to fit), never a small picture sitting inside a bigger box. No icons or illustration in place of photographs, no empty frames, no placeholders.`,
    brand ? brandBlock(brand) : '',
    brand?.logo ? 'LOGO: in the header and in the footer show the owner logo as a picture whose alt text is "logo" (a clean, empty logo area is fine). Never draw or invent a logo of your own.' : '',
    `Header (identical on every page): ${brand?.logo ? 'the logo picture' : 'the business name as a bold wordmark'} on the left; menu links: ${main.join(', ')}${more.length ? `, and a "More" menu with: ${more.join(', ')}` : ''}; one prominent button. Footer (identical on every page): wordmark, all page links (${nav.join(', ')}), contact details, social icons.`,
    `Contact details (sample): phone ${brief.contact.phone}, email ${brief.contact.email}, address ${brief.contact.address}, hours ${brief.contact.hours}.${team}${reviews}`,
    '',
    `PAGE HEADLINE: "${page.headline}"`,
    'PAGE SECTIONS, in this order:',
    ...page.sections.map((s, i) => describeSection(s, i + 1)),
    '',
    'MAKE IT UNFORGETTABLE: oversized expressive headlines, full-bleed imagery, asymmetric layouts, overlapping image and text, generous space, one clear main button. Elegant, never weird. It must work beautifully on a phone too.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}
