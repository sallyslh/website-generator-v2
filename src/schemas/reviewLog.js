// Schema for review-log.json (written by Stage 6): a list of every review decision.
// routedTo is only present when decision is "change".

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const reviewLogSchema = z.array(
  z.object({
    at: z.string().min(1),
    page: z.string().min(1),
    decision: z.enum(['approve', 'change']),
    comment: z.string().default(''),
    routedTo: z.enum(['assets', 'creative-director', 'content', 'stitch-edit']).optional(),
  }),
);

export const validate = makeValidate(reviewLogSchema);
