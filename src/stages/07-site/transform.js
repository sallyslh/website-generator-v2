// Pure functions that turn an approved Stitch page (one HTML file using the Tailwind CDN) into pieces of a real Astro site.
// No file access and no AI here, so everything can be unit tested.

import vm from 'node:vm';
import { parseTree } from '../../lib/htmlRows.js';

import { photoClasses, dropDrawnPlaceholders, PHOTO_MARK } from '../../lib/frames.js';

const LOGO_LIKE = /logo|badge|seal|insignia|emblem|monogram/i;
const ICON_SPAN = /<span\b[^>]*material-symbols[^>]*>[\s\S]*?<\/span>/gi;

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const normalizeLabel = (s) => decode(s.replace(ICON_SPAN, ' ').replace(/<[^>]+>/g, ' ')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const pageHref = (slug) => (slug === 'home' ? '/' : `/${slug}/`);

// ---------- 1. take the page apart ----------

export function extractParts(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const bodyMatch = html.match(/<body\b([^>]*)>([\s\S]*)<\/body>/i);
  const htmlAttrs = html.match(/<html\b([^>]*)>/i)?.[1] ?? '';
  const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] ?? '';

  let tailwindConfig = null;
  const configCode = head.match(/<script\b[^>]*id="tailwind-config"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    ?? html.match(/<script\b[^>]*>\s*(tailwind\.config\s*=[\s\S]*?)<\/script>/i)?.[1];
  if (configCode) {
    try { tailwindConfig = JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){var tailwind={};${configCode};return tailwind.config;})()`, {}, { timeout: 1000 }))); } catch { tailwindConfig = null; }
  }
  const styles = [...head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const fontLinks = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel="stylesheet"/i.test(t)).map((t) => decode(t.match(/href="([^"]*)"/i)?.[1] ?? '')).filter((h) => /fonts\.googleapis\.com/.test(h));
  return {
    title: decode(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim(),
    lang: attr(htmlAttrs, 'lang'),
    htmlClass: attr(htmlAttrs, 'class'),
    bodyClass: attr(bodyMatch?.[1] ?? '', 'class'),
    bodyInner: bodyMatch ? bodyMatch[2].trim() : '',
    styles,
    fontLinks,
    tailwindConfig,
  };
}

// Several pages each carry their own Tailwind config. Keep the first value of every key, add the keys only later pages have.
export function mergeConfigs(configs) {
  let conflicts = 0;
  const merge = (base, extra) => {
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (!(k in base)) base[k] = JSON.parse(JSON.stringify(v));
      else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
      else if (JSON.stringify(base[k]) !== JSON.stringify(v)) conflicts++;
    }
    return base;
  };
  const merged = configs.filter(Boolean).reduce((acc, c) => merge(acc, c), {});
  return { config: merged, conflicts };
}

// ---------- 2. clean the body ----------

export function cleanBody(body) {
  return body
    .replace(/<script\b[^>]*cdn\.tailwindcss\.com[^>]*><\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '') // Stitch leaves comments with picture addresses in the page
    .replace(/\sdata-alt="[^"]*"/gi, '')
    .replace(/\sdata-location="[^"]*"/gi, '')
    .replace(/(object-fit:\s*cover;?\s*)+/gi, 'object-fit:cover;');
}

// ---------- 3. images ----------

// A frame without a photo: a quiet tinted block that fills the frame (never the design's own drawing of a product).
const EMPTY_MARK = 'data-empty-photo';
const neutralBlock = (classes, tint) => `<div class="${photoClasses(classes).classes ?? ''}" aria-hidden="true" ${EMPTY_MARK} style="background:${tint}"></div>`;

// Where there is no photo there is no frame: an empty picture block is removed together with the wrappers that hold nothing else
// (a border, an aspect-ratio box), so no empty rectangle is left on the page.
const KEEP = new Set(['#root', 'html', 'body', 'main', 'section', 'header', 'footer', 'article', 'nav', 'ul', 'ol', 'form']);
export function removeEmptyFrames(html) {
  const empties = [];
  const walkTree = (n) => { if (n.tag && n.tag !== '#root' && n.attrs.includes(EMPTY_MARK)) empties.push(n); (n.children ?? []).forEach(walkTree); };
  walkTree(parseTree(html));
  const cutNodes = empties.map((el) => { let n = el; while (n.parent && !KEEP.has(n.parent.tag) && n.parent.children.length === 1) n = n.parent; return n; });
  const edits = new Map(); // start -> [start, end, replacement]
  for (const n of cutNodes) edits.set(n.start, [n.start, n.end, '']);
  // the columns that remain next to a removed picture take the whole width (and stay a readable width), instead of a half-empty row
  for (const n of cutNodes) {
    for (const sib of n.parent?.children ?? []) {
      if (!sib.tag || cutNodes.includes(sib) || edits.has(sib.start) || !/\bcol-span-\d+/.test(sib.attrs)) continue;
      const open = html.slice(sib.start, sib.openEnd);
      const next = open.replace(/class="([^"]*)"/, (m, c) => 'class="' + c.replace(/(^|\s)(?:[\w-]+:)*col-span-\d+/g, '$1').replace(/\s+/g, ' ').trim() + ' col-span-12 max-w-3xl mx-auto"');
      edits.set(sib.start, [sib.start, sib.openEnd, next]);
    }
  }
  let out = html; let last = Infinity;
  for (const [s, e, text] of [...edits.values()].sort((x, y) => y[0] - x[0])) { if (e > last) continue; out = out.slice(0, s) + text + out.slice(e); last = s; }
  return { html: out, removed: cutNodes.length };
}

// slots: Map slotId -> assetId|null.  assets: Map assetId -> asset.  altFor(slotId) -> descriptive alt text.
// A photo the customer has not given us becomes a quiet tinted block (never a "Photo needed" label on a live site).
export function swapImagesForSite(html, { slots, altFor, logoAssetId, businessName, tint, assetByFilename }) {
  const nameKey = normalizeLabel(businessName);
  const stats = { real: 0, empty: [], external: 0, used: new Set(), seen: new Set() };
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = decode(tag.match(/\balt="([^"]*)"/i)?.[1] ?? '');
    const classes = tag.match(/\bclass="([^"]*)"/i)?.[1] ?? '';
    const src = tag.match(/\bsrc="([^"]*)"/i)?.[1] ?? '';
    let assetId;
    let label = alt;
    if (slots.has(alt)) { stats.seen.add(alt); assetId = slots.get(alt); label = altFor(alt) || alt; }
    else if (logoAssetId && (LOGO_LIKE.test(alt) || (nameKey && normalizeLabel(alt).includes(nameKey)))) { assetId = logoAssetId; label = `${businessName} logo`; }
    else {
      const file = decodeURIComponent(src.split('?')[0]).split('/').pop();
      assetId = assetByFilename.get(file) ?? null; // an image of a real asset that was not named by a slot
      if (!assetId) stats.external++;
      if (!label || /^photo-\d+$/.test(label)) label = '';
    }
    if (!assetId) {
      if (slots.has(alt)) stats.empty.push(alt);
      return neutralBlock(classes, tint);
    }
    stats.real++;
    stats.used.add(assetId);
    const eager = assetId === logoAssetId || /hero/i.test(alt);
    const shown = photoClasses(classes);
    const thumb = tag.includes('data-thumb'); // a small picture (a dish in a menu) loads the small copy
    const attrs = [`src="/images/${assetId}${thumb ? '-s' : ''}.webp"`, `alt="${escapeAttr(label)}"`, shown.classes && `class="${shown.classes}"`, shown.marked && PHOTO_MARK, eager ? 'fetchpriority="high"' : 'loading="lazy"', 'decoding="async"', 'style="object-fit:cover"'];
    return `<img ${attrs.filter(Boolean).join(' ')}/>`;
  });
  return { html: dropDrawnPlaceholders(out), stats };
}

// ---------- 4. links ----------

// labelTargets: Map normalizedLabel -> target (page slug, "form", url, "tel:..", "social:..").
// Words that point to "the offer" without naming it (a card's "view" link, "see all", "shop now").
export const GENERIC_LINKS = new Set(['view', 'view all', 'view more', 'see all', 'see more', 'see details', 'details', 'learn more', 'read more', 'explore', 'browse', 'shop now', 'shop', 'discover']);
export const offerPage = (pages) => pages.find((p) => /product|menu|shop|catalog|collection|service|perfume|gallery/i.test(`${p.slug} ${p.title}`))?.slug ?? null;

export function resolveLinks(html, { labelTargets, businessName, socials, formPage, slugs, genericPage = null, anchorPages = new Map(), headingTargets = [] }) {
  const unresolved = [];
  const nameKey = normalizeLabel(businessName);
  const hrefFor = (target) => {
    if (slugs.has(target)) return { href: pageHref(target) };
    if (target.includes('#') && slugs.has(target.split('#')[0])) return { href: `${pageHref(target.split('#')[0])}#${target.split('#')[1]}` }; // a section of a page
    if (target === 'form') return { href: formPage ? `${pageHref(formPage)}#contact-form` : '#contact-form' };
    if (target.startsWith('tel:')) return { href: target };
    if (target.startsWith('social:')) { const url = socials.get(target.slice(7).toLowerCase()); return url ? { href: url, external: true } : null; }
    if (/^https?:\/\//.test(target)) return { href: target, external: true };
    return null;
  };
  const out = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const href = attrs.match(/\bhref="([^"]*)"/i)?.[1] ?? '';
    const file = href.replace(/^\.?\/?/, '').replace(/\.html?$/i, '');
    let dest = null;
    if (/^(https?:|tel:|mailto:)/i.test(href)) dest = /^https?:/i.test(href) ? { href, external: true } : { href };
    else if (href && href !== '#' && !href.startsWith('#')) dest = slugs.has(file) ? { href: pageHref(file) } : file === 'index' ? { href: '/' } : null;
    else if (href === '#' || href === '') {
      const key = normalizeLabel(inner);
      if (/<img\b/i.test(inner) && !key) dest = { href: '/' };
      else if (key && (key === nameKey || (key.length >= 4 && nameKey.startsWith(`${key} `)))) dest = { href: '/' }; // the logo text may be a shorter form of the name ("Al Jawad" for "Al Jawad restaurant")
      else if (labelTargets.has(key)) dest = hrefFor(labelTargets.get(key));
      else if (key === 'home') dest = { href: '/' };
      else if (genericPage && GENERIC_LINKS.has(key)) dest = { href: pageHref(genericPage) };
      else if (socials.has(key)) dest = { href: socials.get(key), external: true };
      else if (key.startsWith(nameKey + ' ') && key.split(' ').length <= nameKey.split(' ').length + 2) dest = { href: '/' };
      else {
        // a card whose text starts with a known button or menu label ("Browse the perfumes See the fragrances ...")
        const best = [...labelTargets.keys()].filter((l) => l.length >= 5 && key.startsWith(l + ' ')).sort((a, b) => b.length - a.length)[0];
        if (best) dest = hrefFor(labelTargets.get(best));
        // the words begin exactly one section's heading ("Bridal" for "Bridal makeup"): that section
        if (!dest && key) { const near = headingTargets.filter(([h]) => h.startsWith(`${key} `)); if (near.length === 1) dest = hrefFor(near[0][1]); }
      }
      if (!dest) { unresolved.push(key || '(no text)'); return whole; }
    } else {
      // an in-page anchor such as #menu: kept when this page has that spot, otherwise it means the page of that name ("Show full menu" -> /menu/)
      const anchor = href.slice(1);
      const here = new RegExp(`\\bid="${anchor}"`, 'i').test(html);
      if (slugs.has(anchor) && !here) dest = { href: pageHref(anchor) };
      else if (!here && anchorPages.has(anchor)) dest = { href: `${pageHref(anchorPages.get(anchor))}#${anchor}` }; // a section of another page
      else if (!here && anchor) { // "#visit" for the section whose id is "home-visit": the one section of this page whose id ends with the name
        const ids = [...html.matchAll(/\bid="([a-z0-9][a-z0-9_-]*)"/gi)].map((m) => m[1]).filter((id) => id.toLowerCase().endsWith(`-${anchor.toLowerCase()}`));
        if (ids.length === 1) dest = { href: `#${ids[0]}` }; else return whole;
      } else return whole;
    }
    if (!dest) return whole;
    const rest = attrs.replace(/\shref="[^"]*"/i, '').replace(/\s(target|rel)="[^"]*"/gi, '');
    return `<a href="${escapeAttr(dest.href)}"${rest}${dest.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
  });
  return { html: out, unresolved: [...new Set(unresolved)] };
}

// Gives the first form of the page the id the "form" call-to-actions point to.
// Stitch likes to add footer links to pages that do not exist ("Privacy Policy", "Terms of Service"). A link that goes nowhere
// is worse than no link, so links of this kind that were not resolved to a real page are removed (with their list item).
const LEGAL = /\b(privacy|terms|cookies?|legal|disclaimer|sitemap|accessibility statement)\b/i;
export function dropUnbackedLegalLinks(html) {
  const removed = [];
  const dead = (attrs, inner) => {
    const href = attrs.match(/\bhref="([^"]*)"/i)?.[1] ?? '';
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if ((href === '#' || href === '') && LEGAL.test(label)) { removed.push(label); return true; }
    return false;
  };
  let out = html.replace(/<li\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/li>/gi, (whole, attrs, inner) => (dead(attrs, inner) ? '' : whole));
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => (dead(attrs, inner) ? '' : whole));
  return { html: out, removed };
}

// A footer link that goes nowhere ("#") with a label Stitch made up ("Philosophy", "Atelier Schedule") is removed, with its list item:
// a link that goes nowhere is worse than no link. Only footers: a dead button in the page itself is left for the owner to see.
export function dropDeadFooterLinks(html) {
  const removed = [];
  const label = (inner) => inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const out = html.replace(/<footer\b[\s\S]*?<\/footer>/gi, (footer) => {
    const dead = (attrs, inner) => { const href = attrs.match(/\bhref="([^"]*)"/i)?.[1] ?? ''; if (href === '#' || href === '') { removed.push(label(inner)); return true; } return false; };
    return footer
      .replace(/<li\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/li>/gi, (whole, attrs, inner) => (dead(attrs, inner) ? '' : whole))
      .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => (dead(attrs, inner) ? '' : whole));
  });
  return { html: out, removed };
}

export function markForm(html) {
  return /<form\b/i.test(html) && !/<form\b[^>]*\bid=/i.test(html) ? html.replace(/<form\b/i, '<form id="contact-form"') : html;
}

// Stitch likes to write its own copyright line ("Handcrafted botanical formulations. All rights reserved."): keep only the facts.
export function fixCopyright(html, { businessName, year }) {
  let fixed = 0;
  const clean = `© ${year} ${businessName}`;
  const out = html.replace(/>(\s*(?:©|&copy;)[^<]*)</gi, (whole, text) => {
    const t = decode(text).replace(/\s+/g, ' ').trim();
    if (t === clean) return whole;
    fixed++;
    return `>${clean.replace(/&/g, '&amp;')}<`;
  });
  return { html: out, fixed };
}

// ---------- 5. header and footer shared by every page ----------

// Splits <header> at the start and <footer> (+ trailing scripts) at the end. Returns null parts when the page has another shape.
export function splitShell(body) {
  const header = body.match(/^\s*(<header\b[\s\S]*?<\/header>)/i)?.[1] ?? null;
  const afterHeader = header ? body.slice(body.indexOf(header) + header.length) : body;
  const footerMatch = afterHeader.match(/(<footer\b[\s\S]*<\/footer>)\s*((?:<script\b[\s\S]*?<\/script>\s*)*)$/i);
  const footer = footerMatch ? footerMatch[1] : null;
  const main = footerMatch ? afterHeader.slice(0, footerMatch.index) : afterHeader;
  const tail = footerMatch ? footerMatch[2].trim() : '';
  return { header, main: main.trim(), footer, tail };
}

// A header or footer is hoisted into the layout only when it is the same on every page.
export function hoistShared(shells) {
  const same = (key) => shells.length > 0 && shells.every((s) => s[key] && s[key] === shells[0][key]);
  const header = same('header') ? shells[0].header : null;
  const footer = same('footer') ? shells[0].footer : null;
  return {
    header,
    footer,
    pages: shells.map((s) => [header ? '' : s.header ?? '', s.main, footer ? '' : s.footer ?? '', s.tail].filter(Boolean).join('\n')),
  };
}

// Keeps only the font families that are named in the design (Tailwind config or CSS). A Google Fonts link can carry
// several families (&family=A&family=B): each link is rebuilt with only the used ones, and families already loaded by
// an earlier link are not loaded twice. Icon fonts (Material Symbols) are always kept. `used` = text of config + styles.
export function usedFontLinks(links, used) {
  const seen = new Set();
  const out = [];
  for (const href of links) {
    const [base, query = ''] = href.split('?');
    const params = query.split('&').filter(Boolean);
    const keep = params.filter((p) => {
      if (!p.startsWith('family=')) return true;
      const name = decodeURIComponent(p.slice(7).split(':')[0]).replace(/\+/g, ' ');
      if (seen.has(name)) return false;
      if (/material symbols/i.test(name) || used.includes(name)) { seen.add(name); return true; }
      return false;
    });
    if (keep.some((p) => p.startsWith('family='))) out.push(`${base}?${keep.join('&')}`);
  }
  return out;
}
