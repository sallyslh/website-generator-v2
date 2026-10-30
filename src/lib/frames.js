// Stitch draws a picture frame as a box (usually with an aspect-[w/h] class) with its OWN small illustration inside
// (for example a bottle made of SVG shapes) and puts the real <img> in it with class="hidden". When the customer's real
// photo goes in, the photo must be visible and fill the frame, and the drawn placeholder must go. A frame whose photo
// does not exist yet becomes a quiet tinted block, never a drawing of a product we do not have a photo of.
// Used by the sketches (Stage 5) and by the built site (Stage 7). Large decorative shapes (the signature motif) are kept.

const MARK = 'data-photo-frame';
export const PHOTO_MARK = MARK;

// Classes for an <img> or block that goes into a frame: "hidden" is removed and, when it had no size, it fills the frame.
export function photoClasses(classes) {
  if (classes === undefined || !/(^|\s)hidden(\s|$)/.test(classes)) return { classes, marked: false };
  const kept = classes.split(/\s+/).filter((c) => c && c !== 'hidden');
  const sized = kept.some((c) => /^(w-|h-|size-|absolute|inset-)/.test(c));
  return { classes: [...(sized ? [] : ['absolute', 'inset-0', 'w-full', 'h-full', 'object-cover']), ...kept].join(' '), marked: true };
}

export function showPhoto(tag) {
  const { classes, marked } = photoClasses(tag.match(/\bclass="([^"]*)"/i)?.[1]);
  return marked ? tag.replace(/\bclass="[^"]*"/i, () => `class="${classes}" ${MARK}`) : tag;
}

// The shape of the frame a picture sits in, read from the nearest aspect class before it: "4:5", "1:1", "16:9" or null.
export function frameAspect(html, imgIndex) {
  const before = html.slice(Math.max(0, imgIndex - 900), imgIndex);
  const tags = [...before.matchAll(/<[a-z0-9]+\b[^>]*\bclass="([^"]*)"[^>]*>/gi)];
  for (let i = tags.length - 1; i >= 0; i--) {
    const c = tags[i][1];
    const m = c.match(/aspect-\[(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]/);
    if (m) return `${m[1]}:${m[2]}`;
    if (/(^|\s)aspect-square(\s|$)/.test(c)) return '1:1';
    if (/(^|\s)aspect-video(\s|$)/.test(c)) return '16:9';
  }
  return null;
}

// End index of the <div> that opens at `start` (counts nested divs), or -1.
function blockEnd(html, start) {
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

// A drawn placeholder is small (an icon-sized illustration); a big svg is decoration (the signature line) and stays.
function isSmallSvg(tag) {
  const num = (name) => Number(tag.match(new RegExp(`\\s${name}="(\\d+(?:\\.\\d+)?)"`, 'i'))?.[1]);
  const w = num('width');
  const h = num('height');
  const unit = tag.match(/\b(?:w|h|size)-(\d+)\b/)?.[1];
  if (Number.isFinite(w) || Number.isFinite(h)) return (!Number.isFinite(w) || w <= 140) && (!Number.isFinite(h) || h <= 140);
  return unit !== undefined && Number(unit) <= 32;
}

// Removes the small drawn illustrations inside photo frames (containers with an aspect-* class).
export function clearDrawnFrames(html) {
  const open = /<div\b[^>]*\bclass="[^"]*\baspect-(?:\[[^\]"]+\]|square|video)[^"]*"[^>]*>/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = open.exec(html))) {
    const end = blockEnd(html, m.index);
    if (end < 0) continue;
    const block = html.slice(m.index, end);
    const cleaned = block.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => (isSmallSvg(svg.match(/^<svg\b[^>]*>/i)[0]) ? '' : svg));
    if (cleaned !== block) { out += html.slice(last, m.index) + cleaned; last = end; open.lastIndex = end; }
  }
  return out + html.slice(last);
}

// The final clean-up of a page after the photos went in: drawings out of the frames, internal markers out of the page.
export function dropDrawnPlaceholders(html) {
  return clearDrawnFrames(html).replace(new RegExp(` ${MARK}`, 'g'), '');
}
