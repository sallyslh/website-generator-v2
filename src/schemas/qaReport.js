// Schema for qa-report.json (written by Stage 9, QA).

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const qaReportSchema = z.object({
  schemaVersion: z.literal(1),
  passed: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      status: z.enum(['pass', 'fail', 'warn']),
      details: z.string().default(''),
    }),
  ),
  manualChecklist: z.array(z.object({ item: z.string().min(1), status: z.enum(['pending', 'done']) })),
});

export const validate = makeValidate(qaReportSchema);
