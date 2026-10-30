// Distinctive but PROFESSIONAL Google Fonts for the creative director, grouped by personality and by "tier".
// Every name was checked to exist on Google Fonts. A website must look trustworthy first:
//   tier "professional" = the default for every business (refined, modern or direct, never gimmicky)
//   tier "expressive"   = only when the business itself is expressive (bakery, cafe, diner, craft, barber...)
//   tier "playful"      = only for kids, toys, candy, parties, games
// Serif headings and the usual clean sans-serifs are the two biggest "AI website" tells, so they are not offered.

export const HEADING_GROUPS = [
  { group: 'Refined and quiet (not a serif)', tier: 'professional', moods: 'perfume, jewelry, fashion, beauty, quiet luxury, minimal, gifts', fonts: ['Tenor Sans', 'Federo', 'Questrial', 'Afacad'] },
  { group: 'Modern with character', tier: 'professional', moods: 'most businesses: shops, clinics, studios, services, restaurants, law, technology', fonts: ['Schibsted Grotesk', 'Familjen Grotesk', 'Epilogue', 'Geologica', 'Wix Madefor Display', 'Gantari', 'Funnel Display', 'Host Grotesk', 'Red Hat Display', 'Reddit Sans'] },
  { group: 'Strong and geometric', tier: 'professional', moods: 'confident, clean, trades, construction, sport, automotive, finance', fonts: ['League Spartan', 'Kumbh Sans', 'Archivo Black'] },
  { group: 'Condensed and direct', tier: 'professional', moods: 'barber, gym, workshop, market, street, events, direct and bold', fonts: ['Anton', 'Big Shoulders Display', 'League Gothic', 'Antonio', 'Staatliches', 'Barlow Condensed', 'Sofia Sans Condensed', 'Saira Condensed'] },
  { group: 'Chunky and retro', tier: 'expressive', moods: 'bakery, cafe, diner, street food, vintage, brewery', fonts: ['Shrikhand', 'Caprasimo', 'Bowlby One', 'Titan One'] },
  { group: 'Hand-lettered', tier: 'expressive', moods: 'craft, homemade, artisan, tattoo, handmade, family-run', fonts: ['Caveat Brush', 'Gochi Hand', 'Patrick Hand', 'Kalam', 'Amatic SC'] },
  { group: 'Soft and organic', tier: 'expressive', moods: 'wellness, herbal, tea, spa, natural, gentle', fonts: ['Gluten', 'Sansita', 'Itim', 'Mali', 'Chicle'] },
  { group: 'Rounded and bubbly', tier: 'playful', moods: 'kids, toys, candy, party, games, school, nursery', fonts: ['Fredoka', 'Baloo 2', 'Grandstander', 'Gabarito', 'Sniglet', 'Bagel Fat One', 'Lilita One'] },
];

// Script / handwriting for a few words only (never for paragraphs): a signature, a tagline. Use sparingly.
export const ACCENT_FONTS = ['Parisienne', 'Sacramento', 'Yellowtail', 'Kaushan Script', 'Allura'];

// Plain, legible fonts for paragraphs, menus, forms.
export const BODY_FONTS = ['Atkinson Hyperlegible', 'Lexend', 'Public Sans', 'Albert Sans', 'Onest', 'Red Hat Text', 'Commissioner', 'Readex Pro', 'Golos Text', 'Karla', 'Instrument Sans'];

// Fonts known to be serifs: headings must not use them. (A name with "Serif" but not "Sans" also counts.)
export const SERIF_FONTS = [
  'Playfair Display', 'Cormorant Garamond', 'Cormorant', 'Fraunces', 'Lora', 'Merriweather', 'Libre Baskerville', 'Libre Caslon Display', 'Libre Caslon Text',
  'Instrument Serif', 'DM Serif Display', 'DM Serif Text', 'Gloock', 'Bodoni Moda', 'Rozha One', 'Abril Fatface', 'Young Serif', 'Cinzel', 'Yeseva One',
  'Marcellus', 'EB Garamond', 'Crimson Text', 'Crimson Pro', 'Spectral', 'Vollkorn', 'Prata', 'Cardo', 'Gelasio', 'Old Standard TT', 'Playfair', 'Noto Serif', 'Source Serif 4', 'Italiana',
];

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const SERIFS = new Set(SERIF_FONTS.map(normalize));
export const isSerifFont = (name) => SERIFS.has(normalize(name)) || (/serif/i.test(name) && !/sans/i.test(name));

// "professional" | "expressive" | "playful" | null (a font that is not in the catalog)
export function fontTier(name) {
  const group = HEADING_GROUPS.find((g) => g.fonts.some((f) => normalize(f) === normalize(name)));
  return group ? group.tier : null;
}

// Words in the business description that make an expressive / playful lettering believable.
const PLAYFUL_BUSINESS = /\b(kids?|child(ren)?|toys?|candy|sweets shop|party|parties|games?|school|nursery|play ?ground|ice[- ]?cream|cupcakes?|donuts?)\b/i;
const EXPRESSIVE_BUSINESS = /\b(bakery|bakeries|cafe|café|coffee|diner|street food|food truck|brewery|craft|handmade|hand-made|artisan|tattoo|barber|market|festival|wellness|herbal|tea|spa|pastry|patisserie|family-run)\b/i;

// Does the heading font suit this business? Professional fonts always do; the others need a matching business.
export function fontFitsBusiness(fontName, businessText) {
  const tier = fontTier(fontName);
  if (tier === null || tier === 'professional') return true;
  if (tier === 'expressive') return EXPRESSIVE_BUSINESS.test(businessText) || PLAYFUL_BUSINESS.test(businessText);
  return PLAYFUL_BUSINESS.test(businessText);
}

// A few PROFESSIONAL heading fonts picked from the business name, so two customers do not end up with the same lettering.
// (Same name -> same picks, so a re-run is stable.)
export function varietyPicks(name, count = 3) {
  const all = HEADING_GROUPS.filter((g) => g.tier === 'professional').flatMap((g) => g.fonts);
  let seed = 7;
  for (const ch of String(name)) seed = (seed * 31 + ch.charCodeAt(0)) % 100003;
  const picks = [];
  for (let i = 0; picks.length < Math.min(count, all.length); i++) {
    const font = all[(seed + i * 7) % all.length];
    if (!picks.includes(font)) picks.push(font);
  }
  return picks;
}

// The catalog as text for the creative director's instructions.
export function catalogText() {
  return [
    ...HEADING_GROUPS.map((g) => `- [${g.tier.toUpperCase()}] ${g.group} (fits: ${g.moods}): ${g.fonts.join(', ')}`),
    `- Accent script, a few words only, use sparingly: ${ACCENT_FONTS.join(', ')}`,
    `BODY fonts that are clear and comfortable: ${BODY_FONTS.join(', ')}`,
  ].join('\n');
}
