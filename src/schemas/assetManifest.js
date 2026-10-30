// Schema for asset-manifest.json (written by Stage 2, asset intelligence).

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const KINDS = ['image', 'logo', 'document'];
export const CATEGORIES = ['logo', 'food', 'product', 'interior', 'exterior', 'team', 'people', 'service-in-action', 'detail', 'other'];
export const QUALITIES = ['high', 'medium', 'low'];
export const ORIENTATIONS = ['landscape', 'portrait', 'square'];
export const USABLE_FOR = ['hero', 'section-background', 'card', 'gallery', 'about', 'team', 'avatar', 'none'];

const assetSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  hash: z.string().default(''),
  kind: z.enum(KINDS),
  category: z.enum(CATEGORIES),
  description: z.string(),
  quality: z.enum(QUALITIES),
  orientation: z.enum(ORIENTATIONS),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dominantColors: z.array(z.string()).default([]),
  usableFor: z.array(z.enum(USABLE_FOR)).default([]),
  notes: z.string().default(''),
  // a combined picture made only from the customer's own photos (never drawn or generated): which photos, and whether the customer approved it
  derivedFrom: z.array(z.string()).optional(),
  // where a non-original picture comes from: a crop of one photo, a collage of several photos, or a generated mood picture
  origin: z.enum(['crop', 'collage', 'composite', 'generated']).optional(),
  // a counter / watermark / badge was cropped away: `file` is the cleaned copy, `originalFile` the untouched upload
  overlayRemoved: z.boolean().optional(),
  originalFile: z.string().optional(),
  approval: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const assetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  assets: z.array(assetSchema),
  logo: z.string().nullable().default(null),
  documents: z
    .array(z.object({ id: z.string(), file: z.string(), hash: z.string().default(''), summary: z.string(), facts: z.array(z.string()).default([]) }))
    .default([]),
  gaps: z
    .array(z.object({ need: z.string(), reason: z.string(), priority: z.enum(['high', 'medium', 'low']) }))
    .default([]),
});

export const validate = makeValidate(assetManifestSchema);
