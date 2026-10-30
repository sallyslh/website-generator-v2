// Right-to-left languages (Arabic, Persian, Urdu): the whole layout mirrors. The text goes to the right of the picture, the menu starts on the right, margins,
// paddings, arrows and gradients flip. Stitch draws left-to-right, so after the pages are drawn every class that says "left" or "right" gets a mirrored twin that
// only applies when the page is right-to-left ("rtl:" in Tailwind). Nothing is removed, so the left-to-right page is never changed.
// Row direction, grid columns and text alignment follow the page direction by themselves once dir="rtl" is set.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const cheerio = createRequire(import.meta.url)('cheerio');

export const RTL_LANGUAGES = /\b(arabic|persian|farsi|urdu|pashto|kurdish|sindhi|yiddish)\b|^(ar|fa|ur|ps|ckb|sd|yi)(-|$)/i;
export const isRtl = (language = '') => RTL_LANGUAGES.test(String(language).trim());
const CODES = { arabic: 'ar', persian: 'fa', farsi: 'fa', urdu: 'ur', pashto: 'ps', kurdish: 'ckb', sindhi: 'sd', yiddish: 'yi', english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', turkish: 'tr', russian: 'ru', armenian: 'hy', greek: 'el', polish: 'pl', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', czech: 'cs', romanian: 'ro', ukrainian: 'uk', hindi: 'hi', bengali: 'bn', chinese: 'zh', japanese: 'ja', korean: 'ko', thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms', swahili: 'sw' };
// a language name or code -> the code for the page's lang attribute
export const langCode = (language = '') => { const l = String(language).trim().toLowerCase(); return CODES[l] ?? (/^[a-z]{2,3}(-|$)/.test(l) ? l.split('-')[0] : l.slice(0, 2) || 'en'); };

const SWAP = { l: 'r', r: 'l', left: 'right', right: 'left', tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };

// One class (with its variants, like md:hover:ml-4) -> the classes that mirror it, or [].
export function mirror(token) {
  const parts = token.split(/:(?![^\[]*\])/); // split on ":" but not inside [...]
  const util = parts.pop(); const variants = parts.length ? parts.join(':') + ':' : '';
  const out = [];
  const add = (u) => out.push(`${variants}rtl:${u}`);
  let m;
  if ((m = util.match(/^(-?)(m|p)([lr])-(.+)$/))) { add(`${m[1]}${m[2]}${SWAP[m[3]]}-${m[4]}`); add(`${m[2]}${m[3]}-0`); }
  else if ((m = util.match(/^(-?)(left|right)-(.+)$/))) { add(`${m[1]}${SWAP[m[2]]}-${m[3]}`); add(`${m[2]}-auto`); }
  else if ((m = util.match(/^text-(left|right)$/))) add(`text-${SWAP[m[1]]}`);
  else if ((m = util.match(/^rounded-(l|r|tl|tr|bl|br)(-.+)?$/))) { add(`rounded-${SWAP[m[1]]}${m[2] ?? ''}`); add(`rounded-${m[1]}-none`); }
  else if ((m = util.match(/^border-(l|r)(-.+)?$/))) { add(`border-${SWAP[m[1]]}${m[2] ?? ''}`); add(`border-${m[1]}-0`); }
  else if ((m = util.match(/^bg-gradient-to-(r|l|tr|tl|br|bl)$/))) add(`bg-gradient-to-${SWAP[m[1]]}`);
  else if ((m = util.match(/^(-?)translate-x-(.+)$/))) add(`${m[1] ? '' : '-'}translate-x-${m[2]}`);
  else if ((m = util.match(/^float-(left|right)$/))) add(`float-${SWAP[m[1]]}`);
  else if ((m = util.match(/^(origin)-(left|right)$/))) add(`origin-${SWAP[m[2]]}`);
  else if (/^space-x-(?!reverse)/.test(util)) add('space-x-reverse');
  else if ((m = util.match(/^(-?)scale-x-(.+)$/)) && m[1]) add(`scale-x-${m[2]}`);
  return out;
}

// Arrows and chevrons that point the "forward" way in a left-to-right page point the other way here.
const ICONS = { arrow_forward: 'arrow_back', arrow_back: 'arrow_forward', chevron_right: 'chevron_left', chevron_left: 'chevron_right', keyboard_arrow_right: 'keyboard_arrow_left', keyboard_arrow_left: 'keyboard_arrow_right', arrow_right_alt: 'arrow_left_alt', arrow_left_alt: 'arrow_right_alt', east: 'west', west: 'east', navigate_next: 'navigate_before', navigate_before: 'navigate_next', arrow_circle_right: 'arrow_circle_left', arrow_circle_left: 'arrow_circle_right', double_arrow: 'double_arrow', trending_flat: 'trending_flat' };

const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800&display=swap">';
const FONT_CSS = '<style data-rtl>html[dir="rtl"] body,html[dir="rtl"] h1,html[dir="rtl"] h2,html[dir="rtl"] h3,html[dir="rtl"] h4,html[dir="rtl"] p,html[dir="rtl"] a,html[dir="rtl"] li,html[dir="rtl"] button,html[dir="rtl"] input,html[dir="rtl"] textarea,html[dir="rtl"] label{font-family:"Cairo","Segoe UI",Tahoma,sans-serif;letter-spacing:0}html[dir="rtl"] .material-symbols-outlined{font-family:"Material Symbols Outlined"}</style>';

// Phone numbers, e-mail and web addresses keep their left-to-right order inside right-to-left text ("+1 555 010 012", not "012 010 555 1+").
// A dir="ltr" on the element that holds only that value isolates it from the text around it.
const VALUE = /^(?:\+?\d[\d\s().\-–]{6,}\d|[\w.+-]+@[\w-]+\.[\w.-]+|(?:https?:\/\/|www\.)\S+)$/;
export function isolateNumbers(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $('body *').each((_, el) => {
    if (el.attribs?.dir || !el.name || ['script', 'style', 'svg', 'html', 'body'].includes(el.name)) return;
    const own = (el.children ?? []).filter((c) => c.type === 'text' && c.data.trim());
    const link = /^(tel|mailto|sms):/i.test(el.attribs?.href ?? '');
    // the element's own words are one phone number, address or link (other children, such as an icon, may sit beside them)
    if (link || (own.length === 1 && VALUE.test(own[0].data.trim()))) $(el).attr('dir', 'ltr');
  });
  return $.html();
}

// html -> the same page, right-to-left. Run it before the styles are compiled (the polish step), so the new rtl: classes are in the style file.
export function rtlPage(html, language = 'Arabic') {
  if (/<html\b[^>]*\bdir="rtl"/i.test(html) && html.includes('data-rtl')) return isolateNumbers(html);
  let out = html.replace(/<html\b([^>]*)>/i, (whole, attrs) => `<html${attrs.replace(/\s(dir|lang)="[^"]*"/gi, '')} lang="${langCode(language)}" dir="rtl">`);
  out = out.replace(/(\sclass=")([^"]*)(")/g, (whole, a, list, c) => {
    const have = new Set(list.split(/\s+/).filter(Boolean)); const extra = [];
    for (const t of have) for (const m of mirror(t)) if (!have.has(m) && !extra.includes(m)) extra.push(m);
    return extra.length ? `${a}${[...have, ...extra].join(' ')}${c}` : whole;
  });
  out = out.replace(/(<span[^>]*material-symbols[^>]*>)\s*([a-z_]+)\s*(<\/span>)/g, (whole, o, name, c) => (ICONS[name] ? `${o}${ICONS[name]}${c}` : whole));
  return isolateNumbers(out.replace(/<\/head>/i, `${FONT_LINK}${FONT_CSS}</head>`));
}

export function rtlSite({ dir, language }) {
  const done = [];
  if (!isRtl(language)) return { done, skipped: 'the language is written left to right' };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const file = path.join(dir, f); const html = fs.readFileSync(file, 'utf8'); const next = rtlPage(html, language);
    if (next !== html) { fs.writeFileSync(file, next); done.push(f); }
  }
  return { done };
}
