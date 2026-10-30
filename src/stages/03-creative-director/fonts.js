// Fonts that make a website look AI-generated: they appear on almost every generated site, so the creative
// director must not use them. (Case-insensitive; matched against the font name.) Edit this list freely.

export const BANNED_FONTS = [
  'Inter', 'Roboto', 'Open Sans', 'Poppins', 'Montserrat', 'Lato', 'DM Sans', 'Nunito', 'Nunito Sans', 'Raleway',
  'Source Sans', 'Source Sans Pro', 'Source Sans 3', 'Work Sans', 'Plus Jakarta Sans', 'Manrope', 'Space Grotesk', 'Outfit',
  'Figtree', 'Jost', 'Hanken Grotesk', 'Urbanist', 'Sora', 'Be Vietnam Pro', 'IBM Plex Sans',
  'Playfair Display', 'Cormorant Garamond', 'Cormorant', 'Fraunces', 'Libre Baskerville', 'Lora', 'Merriweather',
  'Instrument Serif', 'DM Serif Display', 'Libre Caslon Display', 'Libre Caslon Text', 'Marcellus', 'Bricolage Grotesque',
];

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const BANNED = new Set(BANNED_FONTS.map(normalize));

// "Cormorant Garamond: light, large..." -> "Cormorant Garamond"
export const fontNameOf = (typographyText) => String(typographyText).split(/[:,(]/)[0].trim();

export const isBannedFont = (name) => BANNED.has(normalize(name));

// Every font family named on a Stitch page: Google Fonts links, tailwind fontFamily lists and font-family rules.
export function fontsOnPage(html) {
  const names = new Set();
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"']+)/g))
    for (const f of m[1].matchAll(/family=([^&:;"']+)/g)) names.add(decodeURIComponent(f[1]).replace(/\+/g, ' ').trim());
  for (const m of html.matchAll(/font-family:\s*([^;}"]+)/gi)) for (const f of m[1].split(',')) names.add(f.replace(/["']/g, '').trim());
  for (const m of html.matchAll(/fontFamily:\s*\{[^}]*\}/g)) for (const f of m[0].matchAll(/["']([^"']+)["']/g)) names.add(f[1].trim());
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'system-ui', 'ui-sans-serif', 'ui-serif', 'inherit', 'initial', 'sans', 'mono', 'display', 'body', 'headline', 'label']);
  return [...names].filter((n) => n && !generic.has(n.toLowerCase()) && !/^(fontFamily|\d)/.test(n) && !n.includes('{') && n.length < 40);
}
