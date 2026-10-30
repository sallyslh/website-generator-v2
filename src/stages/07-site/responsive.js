// Stitch draws desktop pages: columns like "7 and 5 of 12", big type, wide padding. This makes the finished site work on a phone.
//   makeResponsive(html)    rewrites the layout classes so columns stack on a phone and sit side by side from a tablet up
//   responsiveCss(...)      the phone rules that need the page's own numbers (big type, big padding), plus a few safety rules
// No AI. The desktop look is not changed: every rewrite keeps the same classes for screens 768px and wider.

const BASE = (t) => !t.includes(':'); // a class without a breakpoint or state prefix

// One class list ("grid grid-cols-12 gap-gutter") rewritten for phones. Returns the new list.
export function rewriteClasses(list) {
  const tokens = list.split(/\s+/).filter(Boolean);
  const has = (re) => tokens.some((t) => re.test(t));
  const out = [];
  for (const t of tokens) {
    let m;
    if (BASE(t) && (m = t.match(/^col-span-(\d+)$/)) && Number(m[1]) <= 12) { out.push('col-span-full', `md:col-span-${m[1]}`); continue; }
    if (BASE(t) && (m = t.match(/^col-start-(\d+)$/))) { out.push(`md:col-start-${m[1]}`); continue; }
    if (BASE(t) && (m = t.match(/^grid-cols-(\d+)$/)) && Number(m[1]) >= 2) { out.push('grid-cols-1', ...(Number(m[1]) >= 3 ? ['sm:grid-cols-2'] : []), `md:grid-cols-${m[1]}`); continue; }
    if ((m = t.match(/^lg:col-span-(\d+)$/)) && !has(/^md:col-span-/) && !has(/^col-span-/)) { out.push('col-span-full', `md:col-span-${m[1]}`, t); continue; } // a tablet gets the desktop columns too
    if (BASE(t) && (m = t.match(/^w-(1\/2|1\/3|2\/3|1\/4|3\/4|2\/5|3\/5)$/))) { out.push('w-full', `md:w-${m[1]}`); continue; }
    out.push(t);
  }
  return [...new Set(out)].join(' ');
}

// All class attributes of a page. Returns { html, tokens } (tokens: every class used, for the data-driven css).
export function makeResponsive(html) {
  const tokens = new Set();
  const out = html.replace(/\bclass="([^"]*)"/g, (whole, list) => {
    const next = rewriteClasses(list);
    for (const t of next.split(/\s+/)) tokens.add(t);
    return `class="${next}"`;
  });
  return { html: out, tokens };
}

const px = (v) => { const m = String(Array.isArray(v) ? v[0] : v ?? '').match(/^([\d.]+)(px|rem)$/); return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null; };
const esc = (cls) => cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

// Phone rules from the page's own tailwind numbers: a heading class of 64px becomes at most 9vw (never under 28px), and a section
// padding of 120px becomes 56px. Only classes that are really used are written.
export function responsiveCss({ tokens = new Set(), tailwindConfig = null } = {}) {
  const extend = tailwindConfig?.theme?.extend ?? {};
  const fontSizes = { ...(tailwindConfig?.theme?.fontSize ?? {}), ...(extend.fontSize ?? {}) };
  const spacing = { ...(tailwindConfig?.theme?.spacing ?? {}), ...(extend.spacing ?? {}) };
  const phone = []; const tablet = [];
  for (const [key, value] of Object.entries(fontSizes)) {
    const size = px(value);
    const own = px(fontSizes[`${key}-mobile`]); // the design may say what its phone size is
    if (size && size >= 34 && tokens.has(`text-${key}`)) phone.push(`.${esc(`text-${key}`)}{font-size:${own ? `${own}px` : `clamp(28px,9vw,${size}px)`}!important;line-height:1.12!important}`);
  }
  const RULES = [
    ['px', (v, o) => `padding-left:${o ?? Math.min(v, 20)}px!important;padding-right:${o ?? Math.min(v, 20)}px!important`], ['pl', (v, o) => `padding-left:${o ?? Math.min(v, 20)}px!important`], ['pr', (v, o) => `padding-right:${o ?? Math.min(v, 20)}px!important`],
    ['py', (v, o) => `padding-top:${o ?? Math.min(v, 56)}px!important;padding-bottom:${o ?? Math.min(v, 56)}px!important`], ['pt', (v, o) => `padding-top:${o ?? Math.min(v, 56)}px!important`], ['pb', (v, o) => `padding-bottom:${o ?? Math.min(v, 56)}px!important`],
    ['gap', (v, o) => `gap:${o ?? Math.min(v, 24)}px!important`], ['gap-x', (v, o) => `column-gap:${o ?? Math.min(v, 24)}px!important`], ['gap-y', (v, o) => `row-gap:${o ?? Math.min(v, 24)}px!important`],
    ['mb', (v, o) => `margin-bottom:${o ?? Math.min(v, 40)}px!important`], ['mt', (v, o) => `margin-top:${o ?? Math.min(v, 40)}px!important`],
  ];
  for (const [key, value] of Object.entries(spacing)) {
    const size = px(value);
    if (!size || size < 32) continue;
    const own = px(spacing[`${key}-mobile`]); // the design may say what its phone size is
    for (const [prefix, rule] of RULES) if (tokens.has(`${prefix}-${key}`)) phone.push(`.${esc(`${prefix}-${key}`)}{${rule(size, own)}}`);
  }
  // fixed type sizes ("text-[130px]", "text-8xl") and their fixed line heights ("leading-[100px]"): one word of 130px does not fit a phone
  const STANDARD = { '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
  for (const t of tokens) {
    let size = null; let m;
    if ((m = t.match(/^text-\[([\d.]+)(px|rem)\]$/))) size = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
    else if ((m = t.match(/^text-(\dxl)$/))) size = STANDARD[m[1]] ?? null;
    if (size && size >= 40) phone.push(`.${esc(t)}{font-size:clamp(30px,12vw,${Math.round(size)}px)!important;line-height:1.08!important}`);
    if (size && size >= 90) tablet.push(`.${esc(t)}{font-size:clamp(40px,8vw,${Math.round(size)}px)!important;line-height:1.08!important}`); // a huge word beside its text must fit its column on a tablet
    if ((m = t.match(/^leading-\[([\d.]+)(px|rem)\]$/)) && Number(m[1]) * (m[2] === 'rem' ? 16 : 1) >= 56) phone.push(`.${esc(t)}{line-height:1.08!important}`);
  }
  // fixed widths that are wider than a phone
  for (const t of tokens) {
    const m = t.match(/^(min-w|w|max-w)-\[(\d+)px\]$/);
    if (m && Number(m[2]) > 340) phone.push(`.${esc(t)}{${m[1] === 'w' ? 'width:100%!important;' : ''}min-width:0!important;max-width:100%!important}`);
  }
  return `/* Phones and small screens. Made for this site: see src/stages/07-site/responsive.js */
html,body{overflow-x:clip}
img,video,svg,canvas{max-width:100%}
@media (max-width:767px){
  h1,h2,h3,h4,p,li,a,span,dd,dt{overflow-wrap:anywhere}
  header>div{height:auto!important;min-height:0!important;padding-top:10px;padding-bottom:10px;row-gap:8px;flex-wrap:wrap}
  header>div>div{flex:1 1 100%;flex-wrap:wrap;justify-content:center;column-gap:14px;row-gap:8px}
  header nav{flex-wrap:wrap;justify-content:center;column-gap:18px;row-gap:6px}
  table{display:block;overflow-x:auto}
${phone.map((r) => `  ${r}`).join('\n')}
}
${tablet.length ? `@media (min-width:768px) and (max-width:1279px){\n${tablet.map((r) => `  ${r}`).join('\n')}\n}\n` : ''}`;
}
