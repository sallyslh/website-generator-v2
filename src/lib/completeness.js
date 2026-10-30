// Is a product that touches the edge of its photo still usable? A fixed rule cannot tell a box that simply ends flush with the frame
// (everything readable) from a box whose side slices through a word. A vision model looks at the cut-out and decides, and any doubt
// or failure means "no": a product is never used when it may be missing a real part.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { askVision } from './llm.js';

const schema = z.object({ complete: z.boolean(), why: z.string().default('') });
const SYSTEM = 'You judge whether a product photo is complete enough to place the product on a new background. Answer with JSON only.';

// Returns async ({ edges, picture }) => boolean, for cutout.js. picture: a JPEG of the product alone on grey.
export function completenessJudge({ projectId, ask = askVision }) {
  return async ({ edges, picture }) => {
    const tmp = path.join(os.tmpdir(), `whole-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    try {
      fs.writeFileSync(tmp, picture);
      const seen = await ask({
        projectId, stage: 'scene', system: SYSTEM, images: [{ path: tmp }], schema, maxTokens: 200,
        prompt: `This product was cut out of a customer's photo and is shown on grey. It touches the photo's ${edges.join(' and ')} edge, so part of it may have been cut off by the frame. We want to stand it on a new table WITHOUT changing it. Answer { "complete": true if its whole shape is visible and none of its printed text, logo or main design is cut off (losing a few pixels of the outer edge is fine, and a box that ends exactly at the frame is fine), false if a real part is missing (a sliced word or logo, a missing side or top, a half bottle), "why": "short" }.`,
      });
      return seen.complete;
    } catch { return false; } finally { fs.rmSync(tmp, { force: true }); }
  };
}
