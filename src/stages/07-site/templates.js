// Text of the files written into the generated Astro site (kept apart from the logic in index.js).

const q = (s) => JSON.stringify(String(s ?? ''));

export const packageJson = (name) => JSON.stringify({
  name: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website',
  type: 'module',
  version: '1.0.0',
  private: true,
  scripts: {
    prebuild: 'node scripts/optimize-images.mjs',
    dev: 'node scripts/optimize-images.mjs && astro dev',
    build: 'astro build',
    preview: 'astro preview',
  },
  dependencies: { astro: '^7.3.8' },
  devDependencies: {
    tailwindcss: '^3.4.17',
    '@tailwindcss/forms': '^0.5.10',
    '@tailwindcss/container-queries': '^0.1.1',
    postcss: '^8.4.49',
    autoprefixer: '^10.4.20',
    sharp: '^0.34.0',
  },
}, null, 2) + '\n';

export const astroConfig = () => `import { defineConfig } from 'astro/config';

export default defineConfig({ build: { format: 'directory' } });
`;

export const postcssConfig = () => `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
`;

export const tailwindConfigFile = (config) => `// The design tokens (colors, fonts, spacing) of the approved design.
const config = ${JSON.stringify(config, null, 2)};

module.exports = {
  content: ['./src/**/*.{astro,html,js}'],
  darkMode: config.darkMode ?? 'class',
  theme: config.theme ?? {},
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')],
};
`;

export const globalCss = (styles) => `@tailwind base;
@tailwind components;
@tailwind utilities;

/* from the approved design */
${styles.join('\n\n')}

/* motion lives in public/motion.css; visitors who ask for less motion also get no smooth scrolling */
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto !important; } }
`;

export const robotsTxt = () => 'User-agent: *\nAllow: /\n';

// schema.org data from facts the customer gave (nothing is added that the brief does not contain)
export function jsonLdFor(brief) {
  const b = brief.business;
  const data = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name };
  if (b.description) data.description = b.description;
  if (b.contact.phone) data.telephone = b.contact.phone;
  if (b.contact.email) data.email = b.contact.email;
  if (b.contact.address) data.address = b.contact.address;
  if (b.socialLinks.length) data.sameAs = b.socialLinks.map((l) => l.url).filter((u) => /^https?:\/\//.test(u));
  return data;
}

// A site without a logo still gets a favicon (a missing one is a 404 on every page): the business's first letter on its main color.
export function initialFavicon(initial, color) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#444444';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const ink = (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#14181b' : '#ffffff';
  const letter = String(initial || '?').slice(0, 1).toUpperCase().replace(/[<>&"']/g, '');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='${hex}'/><text x='32' y='45' font-size='36' text-anchor='middle' fill='${ink}' font-family='sans-serif' font-weight='700'>${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function layoutAstro({ initial = '', lang, rtl, htmlClass, fontLinks, themeColor, hasHeader, hasFooter, siteTitle, logo, motion = 'calm' }) {
  return `---
import '../styles/global.css';
${hasHeader ? "import headerHtml from '../content/_header.html?raw';" : ''}
${hasFooter ? "import footerHtml from '../content/_footer.html?raw';" : ''}
const { title, description = '', bodyClass = '', jsonLd = null } = Astro.props;
const siteTitle = ${q(siteTitle)};
---
<!doctype html>
<html lang=${q(lang)}${rtl ? ' dir="rtl"' : ''}${motion !== 'none' ? ` data-motion=${q(motion)}` : ''} class=${q(htmlClass.replace(/\bscroll-smooth\b/, '').trim() + ' scroll-smooth')}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    {description && <meta name="description" content={description} />}
    <meta name="theme-color" content=${q(themeColor)} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content={siteTitle} />
    <meta property="og:title" content={title} />
    {description && <meta property="og:description" content={description} />}
${logo ? '    <link rel="icon" type="image/png" href="/favicon.png" />' : `    <link rel="icon" type="image/svg+xml" href="${initialFavicon(initial, themeColor)}" />`}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
${fontLinks.map((h) => `    <link rel="stylesheet" href=${q(h)} />`).join('\n')}
    {jsonLd && <script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />}
${motion !== 'none' ? '    <link rel="stylesheet" href="/motion.css" />\n    <script src="/motion.js" defer></script>\n' : ''}    <link rel="stylesheet" href="/responsive.css" />
    <link rel="stylesheet" href="/custom.css" />
  </head>
  <body class={bodyClass}>
${hasHeader ? '    <Fragment set:html={headerHtml} />' : ''}
    <slot />
${hasFooter ? '    <Fragment set:html={footerHtml} />' : ''}
  </body>
</html>
`;
}

export const pageAstro = ({ slug, title, description, bodyClass, jsonLd }) => `---
import Layout from '../layouts/Layout.astro';
import body from '../content/${slug}.html?raw';
---
<Layout title={${q(title)}} description={${q(description)}} bodyClass={${q(bodyClass)}} jsonLd={${jsonLd ? JSON.stringify(jsonLd) : 'null'}}>
  <Fragment set:html={body} />
</Layout>
`;

// Runs before every build: converts the customer's photos to web-sized WebP (and makes the favicon).
export const optimizeScript = (logoAssetId) => `// Converts originals/ to public/images/*.webp (max 1600 px wide, quality 80, EXIF rotation applied).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const from = 'originals';
const to = 'public/images';
fs.mkdirSync(to, { recursive: true });
if (fs.existsSync(from)) {
  for (const file of fs.readdirSync(from)) {
    const id = path.parse(file).name;
    const fresh = (out) => fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(path.join(from, file)).mtimeMs;
    const out = path.join(to, id + '.webp');
    if (!fresh(out)) {
      await sharp(path.join(from, file)).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toFile(out);
      console.log('optimized', file);
    }
    // a small copy (360 px wide) for thumbnails, such as the photo of each dish in a menu: 80 dishes must not load 80 big pictures
    const small = path.join(to, id + '-s.webp');
    if (!fresh(small)) await sharp(path.join(from, file)).rotate().resize({ width: 360, withoutEnlargement: true }).webp({ quality: 72 }).toFile(small);
  }
}
${logoAssetId ? `const logo = fs.readdirSync(from).find((f) => path.parse(f).name === ${q(logoAssetId)});
if (logo) await sharp(path.join(from, logo)).rotate().resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile('public/favicon.png');` : ''}
`;

export function readme({ brief, report, formPage }) {
  return `# ${brief.business.name} website

An Astro + Tailwind site generated from the approved design.

\`\`\`
npm install
npm run dev       # work on it locally
npm run build     # the finished site is written to dist/
npm run preview   # look at dist/
\`\`\`

- Pages: ${report.pages.map((p) => p.route).join(', ')}
- The customer's photos live in \`originals/\`; every build converts them to web-sized WebP in \`public/images/\`.
- Page text and structure: \`src/content/*.html\`. Colors, fonts and spacing: \`tailwind.config.cjs\`.
${report.emptyPhotoSlots.length ? `- Photo slots still empty (shown as quiet tinted blocks until the customer sends photos): ${[...new Set(report.emptyPhotoSlots)].join(', ')}.\n` : ''}${report.forms ? `- The contact form${formPage ? ` on /${formPage}/` : ''} is NOT connected yet: it needs a place to send messages to.\n` : ''}`;
}
