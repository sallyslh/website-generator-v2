// Schema for design/design-manifest.json (written by Stage 5, updated by Stage 6).
// "freestyle" is sketch 2 (Stitch creative on its own). It lives in its own Stitch project, so that project id is kept
// to generate the other pages in the same look. "chosenSketch" is 1 or 2 once the customer decided.

import { z } from 'zod';
import { makeValidate } from './helpers.js';

const variantSchema = z.object({
  screenId: z.string().min(1),
  screenshot: z.string().min(1),
  html: z.string().min(1),
});

export const freestyleSchema = z.object({
  stitchProjectId: z.string().min(1),
  screenId: z.string().min(1),
  html: z.string().min(1),
  screenshot: z.string().min(1),
  promptUsed: z.string(),
});

export const designManifestSchema = z.object({
  schemaVersion: z.literal(1),
  stitchProjectId: z.string().nullable(),
  designSystemId: z.string().nullable().default(null),
  chosenSketch: z.union([z.literal(1), z.literal(2)]).nullable().default(null),
  freestyle: freestyleSchema.nullable().default(null),
  pages: z.array(
    z.object({
      slug: z.string().min(1),
      screenId: z.string().min(1),
      html: z.string().min(1),
      screenshot: z.string().min(1),
      variants: z.array(variantSchema).default([]),
      promptUsed: z.string(),
      status: z.enum(['generated', 'approved', 'changes-requested']),
    }),
  ),
});

export const validate = makeValidate(designManifestSchema);
