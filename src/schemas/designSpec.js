// Schema for design-spec.json (written by Stage 3, creative director).

import { z } from 'zod';
import { makeValidate } from './helpers.js';

// How the creative director plans to fill an image slot. Everything shown must be backed by something real:
//   use          one real photo, as it is (cropped by the layout)
//   collage      several REAL photos arranged into one picture (nothing is drawn or generated)
//   crop         one real item cut out of a group photo (sources = [the photo], target = the item, found by a vision model)
//   atmosphere   a generated mood picture with NO product, person, place, logo or text (subject), only with the customer's approval
//   scene        a photo-shoot picture: a generated set designed by the director (surface, light, props from the business's world) with 0-3 REAL products standing on it
//   composite    2-3 REAL products cut out of their photos and placed together on a new background (products stay exactly as photographed)
//   needs-photo  nothing real fits yet: the slot stays a quiet block and the customer is told which photo would help
export const RECIPE_TYPES = ['use', 'crop', 'collage', 'composite', 'scene', 'atmosphere', 'needs-photo'];
export const COLLAGE_LAYOUTS = ['row', 'column', 'grid'];
export const recipeSchema = z.object({
  type: z.enum(RECIPE_TYPES),
  sources: z.array(z.string()).default([]), // asset ids of the real photos used
  // collage only; anything else (empty text, a copied placeholder) simply means "not set"
  layout: z.preprocess((v) => (COLLAGE_LAYOUTS.includes(v) ? v : undefined), z.enum(COLLAGE_LAYOUTS).optional()),
  target: z.string().optional(),  // crop: the item to cut out, for example "Bleu de Chanel box"
  subject: z.string().optional(), // atmosphere: what the mood picture shows, for example "ground coffee on dark slate"
  style: z.string().optional(),   // atmosphere: how it looks
  scene: z.string().optional(),   // scene: the set (surface, backdrop, light) without any product
  props: z.preprocess((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined), z.array(z.string()).optional()), // scene: raw materials from the business's world lying in front (beans, petals, flour)
  mood: z.string().optional(),
  background: z.preprocess((v) => (v === 'generated' || v === 'plain' ? v : undefined), z.enum(['plain', 'generated']).optional()), // composite: a plain color, or a generated empty surface
  reason: z.string().default(''),
});

// The director's reading of the images before it plans any slot: what exists, what the site needs, what to do about the gap.
export const imagePlanSchema = z.object({
  inventory: z.string().min(1),
  needs: z.string().min(1),
  strategy: z.string().min(1),
});

const slotSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  description: z.string(),
  preferredCategory: z.string().optional(),
  aspect: z.string().optional(),
  assignedAsset: z.string().nullable(), // asset id, or null = placeholder
  recipe: recipeSchema.optional(),
});

const sectionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  purpose: z.string(),
  layoutNotes: z.string().default(''),
  slots: z.array(slotSchema).default([]),
});

// A visual idea taken from the business's own world (beans for a coffee shop, the bow of a logo, scent trails...),
// drawn with simple vector shapes so it can be reused and animated later by Stage 7.
export const signatureSchema = z.object({
  name: z.string().min(1),
  idea: z.string().min(1),          // what it is and why it belongs to THIS business
  drawnWith: z.string().min(1),     // how it is drawn (simple SVG / CSS shapes)
  placements: z.array(z.string()).min(2), // where it appears on the pages
  interactions: z.array(z.string()).default([]), // what Stage 7 can animate later
});

// What the director did with each of the owner's wishes for the home page (the owner sees this on the review screen).
export const WISH_OUTCOMES = ['used', 'adapted', 'declined'];
export const wishResponseSchema = z.object({
  wish: z.string().min(1),                      // the wish, in the owner's words (one wish per line or sentence)
  outcome: z.enum(WISH_OUTCOMES),
  how: z.string().min(1),                       // what was done, or the honest reason it was not
});

export const designSpecSchema = z.object({
  schemaVersion: z.literal(1),
  direction: z.object({
    summary: z.string().min(1),
    style: z.string().min(1),
    mood: z.array(z.string()).min(1),
  }),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    text: z.string(),
  }),
  typography: z.object({ headings: z.string(), body: z.string(), accent: z.string().optional(), reason: z.string().optional(), scale: z.string() }),
  layout: z.object({
    principles: z.array(z.string()).min(1),
    header: z.string(),
    footer: z.string(),
  }),
  pages: z.array(z.object({ slug: z.string().min(1), sections: z.array(sectionSchema).min(1) })).min(1),
  avoid: z.array(z.string()).min(1),
  imagePlan: imagePlanSchema.optional(),
  wishResponses: z.array(wishResponseSchema).default([]),
  signature: signatureSchema.optional(),
  // how the finished site moves (scroll reveals, hover, parallax); Stage 7 turns this into motion.css and motion.js
  motion: z.object({ style: z.enum(['none', 'calm', 'lively', 'bold']).default('calm'), reason: z.string().default('') }).default({ style: 'calm', reason: '' }),
  styleBlock: z.string().min(1),
});

export const validate = makeValidate(designSpecSchema);
