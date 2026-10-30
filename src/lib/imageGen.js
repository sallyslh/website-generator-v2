// Atmosphere images: a generated mood picture (coffee grounds, flower petals, fabric texture...) that adds life to a page.
// Made with FLUX.2 on fal.ai (about $0.012 per megapixel). Strict limits, enforced by code and not left to the prompt:
//   - never a product, packaging, a person, a hand, a place that belongs to the business, a logo or any text
//   - only when FAL_KEY is set in .env
//   - every generated picture needs the customer's approval before it is used on the site
// The network call is injectable so tests never touch it.

import { config } from '../config.js';

export const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux-2';
export const MAX_ATMOSPHERE_PER_SITE = 4; // generated pictures (mood pictures and scenes together) on one site
export const PRICE_PER_MEGAPIXEL = 0.012; // USD, fal.ai list price for fal-ai/flux-2 (checked 2026-10-12)

export const generationAvailable = () => Boolean(config.falKey) && process.env.IMAGE_GENERATION !== 'off';

// Words that make a subject unsafe: products, packaging, people, branding, text.
const FORBIDDEN = /\b(bottles?|boxe?s|packag\w*|products?|perfumes?|flacons?|logos?|brands?|labels?|text|words?|letters?|signs?|storefronts?|shops?|stores?|customers?|owners?|staff|team|testimonials?)\b/i;

// Returns the problems that make a subject unusable (empty list = fine). `names` = the business's own product and brand names.
export function subjectProblems(subject, names = []) {
  const problems = [];
  const text = String(subject ?? '').trim();
  if (text.split(/\s+/).filter(Boolean).length < 2) problems.push('the subject is too short to describe a picture');
  const hits = [...new Set((text.match(new RegExp(FORBIDDEN.source, 'gi')) ?? []).map((h) => h.toLowerCase()))];
  if (hits.length) problems.push(`the subject mentions ${hits.map((h) => `"${h}"`).join(', ')} (a product or package only comes from the customer's real photos; never a place, logo, text or a claim about who a person is)`);
  for (const n of names.filter((x) => x && x.length > 2)) if (text.toLowerCase().includes(n.toLowerCase())) problems.push(`the subject names "${n}"`);
  return problems;
}

// The prompt is built by code: the subject comes from the director, the limits are fixed.
export function atmospherePrompt({ subject, style = '', colors = [] }) {
  return [
    `A photographic still life of ${subject}.`,
    style && `Style: ${style}.`,
    colors.length ? `Soft color harmony with ${colors.join(', ')}.` : '',
    'Natural light, shallow depth of field, calm and uncluttered, plenty of quiet space.',
    'STRICT: no products, no bottles, no packaging, no text, no letters, no logos, no brand names, no signs. Any person is generic and anonymous.',
  ].filter(Boolean).join(' ');
}

// An empty, flat surface to place real products on (no objects: the products come from the customer's photos).
export function surfacePrompt({ surface = 'soft cream linen', wall = 'plain pale blush', colors = [] } = {}) {
  return [
    `An empty, straight-on, eye-level scene: a flat seamless ${surface} tabletop filling the lower third of the frame and a ${wall} wall above it, gentle even window light.`,
    colors.length ? `Soft color harmony with ${colors.join(', ')}.` : '',
    'No drapes, no folds, no table edge, no objects, completely empty and calm.',
    'STRICT: no products, no people, no text, no logos, no signs.',
  ].filter(Boolean).join(' ');
}

// The styled SET of a photo shoot, designed by the creative director: surface, backdrop, light, mood and DECORATION from the business's
// world (flowers in a vase, a candle, a dish, plain books...), like a real commercial shoot. The real products are placed on it afterwards,
// so the middle of the table stays clear. What the set must never contain is a PRODUCT for sale (a bottle, a box, a package), text or a logo.
export function setPrompt({ scene, mood = '', colors = [], strict = false, props = [] }) {
  return [
    `A premium commercial still-life photograph, straight-on and eye-level: ${scene}.`,
    mood && `Mood: ${mood}.`,
    colors.length ? `Soft color harmony with ${colors.join(', ')}.` : '',
    'The flat tabletop surface fills the lower two thirds of the frame and runs all the way to the bottom edge (no table edge, no drape hanging at the front), with a large clear area in the middle of it, left free for the hero product. Style it like an art director on a professional commercial shoot: a few tasteful decorative pieces that suit the description (for example fresh flowers in a simple vase, a candle, a small ceramic dish or tray, a stack of plain-cover books, a sprig of greenery, a ribbon), arranged naturally toward the back and the sides, never in the clear middle. Shallow depth of field, realistic light and shadows, high-end editorial quality.',
    // props are drawn WITH the set, in the same light, so they cast their own shadows and look photographed together (a separately
    // generated and pasted pile looks like a sticker). The middle stays clear: the real products are placed there afterwards.
    props.length ? `Also lying loosely on the tabletop, naturally and sparsely, a few ${props.join(', ')}, scattered mostly toward the front corners and along the sides, catching the same light and casting small soft shadows. The middle of the table stays completely clear.` : '',
    // second attempt: the first set had too little surface to stand products on (a shelf, a sill, a narrow ledge)
    strict && 'VERY IMPORTANT: show a WIDE, DEEP, flat table top seen from slightly above and straight on, covering the whole bottom 60% of the picture from the left edge to the right edge, with the window or backdrop only in the top 40%. It is a big table, not a shelf, a windowsill or a narrow ledge.',
    'STRICT: nothing that looks like a product for sale: no perfume or cosmetic bottles, no vials, no labeled jars, no tubes, no boxes, no retail packaging. No text, no letters, no numbers, no logos, no brand names, no signs (any books or boxes used as decoration have plain blank covers).',
  ].filter(Boolean).join(' ');
}

// Natural items that lie loosely on the table (they are drawn together with the set). Cloth and ribbon are fine now that nothing is pasted on.
export const usableProps = (props = []) => [...new Set(props.map((p) => String(p).trim()).filter(Boolean))].slice(0, 4);

export function propsPrompt(props) {
  return `A small natural scatter of ${props.join(', ')} on a plain white seamless surface, top view, soft light. STRICT: no products, no text, no logos.`;
}

// About one megapixel in the shape of the frame, sides in multiples of 16 (what the model prefers).
export function sizeForAspect(aspect = '4:3') {
  const [w, h] = String(aspect).split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 4 / 3;
  const width = Math.max(512, Math.min(1536, Math.round(Math.sqrt(1_000_000 * ratio) / 16) * 16));
  return { width, height: Math.max(512, Math.min(1536, Math.round(width / ratio / 16) * 16)) };
}

export const estimateCost = (size) => Number(((size.width * size.height) / 1_000_000 * PRICE_PER_MEGAPIXEL).toFixed(4));

// Calls FLUX.2. Returns { buffer, width, height, cost }. `fetchImpl` is only replaced in tests.
export async function generateImage({ prompt, aspect = '4:3', fetchImpl = fetch }) {
  if (!generationAvailable()) throw new Error('Image generation is off: add FAL_KEY to your .env file.');
  const size = sizeForAspect(aspect);
  const res = await fetchImpl(`https://fal.run/${IMAGE_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${config.falKey}` },
    body: JSON.stringify({ prompt, image_size: size, num_images: 1, output_format: 'jpeg', enable_safety_checker: true, enable_prompt_expansion: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Image generation failed (${res.status}): ${String(body.detail?.[0]?.msg ?? body.detail ?? body.error ?? 'no details').slice(0, 200)}`);
  if (body.has_nsfw_concepts?.[0]) throw new Error('The image model flagged its own picture, so it was not used.');
  const url = body.images?.[0]?.url;
  if (!url) throw new Error('The image model returned no picture.');
  const img = await fetchImpl(url);
  if (!img.ok) throw new Error(`The generated picture could not be downloaded (${img.status}).`);
  return { buffer: Buffer.from(await img.arrayBuffer()), width: body.images[0].width ?? size.width, height: body.images[0].height ?? size.height, cost: estimateCost(size) };
}
