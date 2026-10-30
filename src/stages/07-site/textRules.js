// What the live site is allowed to say: the approved copy and the facts the customer gave.
// Shared by the generator (which removes invented text) and the checks (which verify nothing invented is left).

export const words = (s) => String(s).toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function allowedText(brief, content) {
  const handles = brief.business.socialLinks.map((l) => ({ platform: l.platform, handle: l.url.replace(/^https?:\/\/(www\.)?[^/]+\/@?/, '').replace(/\/$/, '') }));
  const platforms = handles.map((h) => h.platform);
  const parts = [brief.business.name, brief.business.contact.phone, brief.business.contact.email, brief.business.contact.address, brief.business.contact.hours,
    ...handles.flatMap((h) => [h.platform, h.handle, `${h.platform} ${h.handle}`]),
    // the lines a design makes from the customer's own handles ("Instagram & TikTok: @name")
    ...[...new Set(handles.map((h) => h.handle))].flatMap((handle) => [`${platforms.join(' ')} ${handle}`, `${[...platforms].reverse().join(' ')} ${handle}`]),
    ...brief.offerings.flatMap((o) => [o.name, o.price ?? '']),
    content.global.siteTitle, content.global.footerText, content.global.formMessages?.success, content.global.formMessages?.error,
    content.global.primaryCta.label, ...content.global.navigation.map((n) => n.label)];
  for (const p of content.pages) {
    parts.push(p.seo.title, p.seo.description);
    for (const s of p.sections) parts.push(s.heading, s.subheading, ...s.body, s.cta?.label ?? '', ...s.items.flatMap((i) => [i.title, i.text]));
  }
  return ` ${words(parts.filter(Boolean).join(' | '))} `;
}

// Visible text pieces of a page: every text between tags, without scripts, styles and icon fonts.
export function textPieces(html) {
  const body = html.replace(/<head\b[\s\S]*?<\/head>/i, '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<span\b[^>]*material-symbols[^>]*>[\s\S]*?<\/span>/gi, ' ');
  return body.split(/<[^>]+>/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Three or more words that are not in the allowed text, or a picture's slot id printed as text.
export const isUnknownPiece = (text, allowed) => {
  const w = words(text);
  if (/^[a-z]+(-[a-z0-9]+){2,}$/i.test(text.trim())) return true; // "how-to-order-hero-image"
  return w.split(' ').length >= 3 && !allowed.includes(` ${w} `) && !allowed.includes(w);
};

export const unknownText = (html, allowed) => textPieces(html).filter((t) => isUnknownPiece(t, allowed));

// Grey "loading skeleton" bars: empty boxes with a small height, a fractional width and a faint background color. Stitch draws
// them as "reserved space" where a fact is missing; on a live site they look like a page that has not finished loading.
// They are removed, together with any container that held nothing else. One-pixel divider lines are not skeletons.
const SKELETON = /<div\b[^>]*\bclass="(?=[^"]*(?<![\w:/[-])h-(?:2|3|4|5|6|8)(?![\w/.-]))(?=[^"]*(?<![\w:/[-])w-(?:full|\d\/\d|2[4-9]|[3-9]\d)(?![\w/.-]))(?=[^"]*(?<![\w:/[-])bg-[\w-]+\/(?:5|10|15|20|25)(?![\w/.-]))[^"]*"[^>]*>\s*<\/div>/gi;
export function removeSkeletons(html) {
  const GONE = '\u0001GONE\u0001';
  let count = 0;
  let out = html.replace(SKELETON, () => { count++; return GONE; });
  if (!count) return { html, removed: 0 };
  // a container that now holds only removed bars (and whitespace) goes too, and so on upwards
  const empty = new RegExp('<(div|section|li|span)\\b[^>]*>(?:\\s|' + GONE + ')*' + GONE + '(?:\\s|' + GONE + ')*<\\/\\1>', 'gi');
  for (let again = true; again;) { const next = out.replace(empty, GONE); again = next !== out; out = next; }
  return { html: out.split(GONE).join(''), removed: count };
}

// Removes plain text elements (a tagline, a made-up product name, a slot id) that the design added on its own.
// Buttons and links are never removed (that would break the page): the checks report them instead.
export function removeInventedText(html, allowed) {
  const removed = [];
  const out = html.replace(/<(p|div|span|h[1-6]|li|small|label|figcaption|em|strong|i)\b([^>]*)>([^<]+)<\/\1>/gi, (whole, tag, attrs, inner) => {
    const text = inner.replace(/\s+/g, ' ').trim();
    if (/material-symbols|icon/i.test(attrs) || /^[a-z0-9_]+$/.test(text)) return whole; // icon glyph names such as arrow_right_alt are not text
    if (!text || !isUnknownPiece(text, allowed)) return whole;
    removed.push(text);
    return '';
  });
  return { html: out, removed };
}
