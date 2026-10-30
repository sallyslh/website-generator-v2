// Every form field gets an accessible name. Stitch usually draws fields with only a placeholder, which disappears when typing and tells a
// screen reader nothing. A field without a label gets aria-label from its placeholder (or its name).

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];

export function labelFields(html) {
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]*)"/gi)].map((m) => m[1]));
  let added = 0;
  const out = html.replace(/<(input|textarea|select)\b([^>]*)>/gi, (tag, kind, rest) => {
    const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    if (kind.toLowerCase() === 'input' && SKIP_TYPES.has(type)) return tag;
    if (attr(tag, 'aria-label') || attr(tag, 'aria-labelledby')) return tag;
    const id = attr(tag, 'id');
    if (id && labelled.has(id)) return tag;
    const text = (attr(tag, 'placeholder') || attr(tag, 'name') || '').replace(/[_-]+/g, ' ').trim();
    if (!text) return tag;
    added++;
    return tag.replace(/<(input|textarea|select)\b/i, (m) => `${m} aria-label="${text.replace(/"/g, '&quot;')}"`);
  });
  return { html: out, added };
}
