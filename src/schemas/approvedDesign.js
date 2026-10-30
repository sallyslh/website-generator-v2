// Schema for approved-design.json (written by Stage 6, only when every page is approved).

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const approvedDesignSchema = z.object({
  schemaVersion: z.literal(1),
  approvedAt: z.string().min(1),
  pages: z
    .array(
      z.object({
        slug: z.string().min(1),
        screenId: z.string().min(1),
        html: z.string().min(1),
        screenshot: z.string().min(1),
      }),
    )
    .min(1),
  slotAssets: z.record(z.string(), z.string().nullable()).default({}),
  reviewNotes: z.array(z.string()).default([]),
});

export const validate = makeValidate(approvedDesignSchema);
