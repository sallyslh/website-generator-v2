// The usual hero of a drawn page: a photo that fills the whole section (a wrapper "absolute inset-0" around the img) with the headline and buttons laid over it.
// On a phone that hides the best part of the photo behind the text. This puts the photo on top as its own landscape block and the text below it, and keeps the
// overlay exactly as drawn from the laptop width (lg:) up. Only the classes of the photo wrapper change.

import { createRequire } from 'node:module';

const cheerio = createRequire(import.meta.url)('cheerio');
const classes = ($, el) => ($(el).attr('class') ?? '').split(/\s+/).filter(Boolean);

export const HERO_MARK = 'data-hero-stacked';

// Returns { html, changed }.
export function stackHero(html) {
  if (html.includes(HERO_MARK)) return { html, changed: false };
  const $ = cheerio.load(html, { decodeEntities: false });
  const h1 = $('body h1').first();
  if (!h1.length) return { html, changed: false };
  // the section that holds the headline and a full-cover photo wrapper
  let section = null; let wrapper = null;
  h1.parents().each((_, p) => {
    if (section) return;
    const kid = $(p).children().toArray().find((k) => {
      const c = classes($, k);
      return c.includes('absolute') && c.includes('inset-0') && $(k).find('img').length > 0 && !$(k).find('h1').length;
    });
    if (kid) { section = p; wrapper = kid; }
  });
  if (!section) return { html, changed: false };
  const sec = classes($, section);
  const next = classes($, wrapper).filter((c) => !['absolute', 'inset-0', 'z-0'].includes(c) && !/^mx-/.test(c)); // the side margin that pushed the photo in from the edge of the section goes
  next.push('relative', 'w-full', 'aspect-[4/3]', 'lg:absolute', 'lg:inset-0', 'lg:aspect-auto', 'lg:z-0');
  $(wrapper).attr('class', [...new Set(next)].join(' '));
  // the section stacks its children on a phone and keeps its laptop layout from lg:
  if (!sec.some((c) => /^(flex|grid)$/.test(c))) $(section).attr('class', ['flex', 'flex-col', 'lg:block', ...sec].join(' '));
  else if (!sec.some((c) => /^(flex-col|grid)$/.test(c))) $(section).attr('class', ['flex-col', ...sec].join(' '));
  $(section).attr(HERO_MARK, '');
  // a text block that was centred or pushed over the photo starts at the top of its own space
  $(section).children().toArray().filter((k) => k !== wrapper).forEach((k) => { const c = classes($, k); if (c.includes('absolute')) $(k).attr('class', c.filter((x) => x !== 'absolute').concat('relative', 'lg:absolute').join(' ')); });
  return { html: $.html(), changed: true };
}
