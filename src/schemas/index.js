// Registry of every project JSON file: which schema validates it and which stage writes it.

import { siteBriefSchema } from './siteBrief.js';
import { assetManifestSchema } from './assetManifest.js';
import { designSpecSchema } from './designSpec.js';
import { contentSpecSchema } from './contentSpec.js';
import { designManifestSchema } from './designManifest.js';
import { approvedDesignSchema } from './approvedDesign.js';
import { reviewLogSchema } from './reviewLog.js';
import { qaReportSchema } from './qaReport.js';

export const FILES = {
  'site-brief.json': { schema: siteBriefSchema, stage: 'Stage 1 (brief)' },
  'asset-manifest.json': { schema: assetManifestSchema, stage: 'Stage 2 (assets)' },
  'design-spec.json': { schema: designSpecSchema, stage: 'Stage 3 (direct)' },
  'content-spec.json': { schema: contentSpecSchema, stage: 'Stage 4 (content)' },
  'design/design-manifest.json': { schema: designManifestSchema, stage: 'Stage 5 (design)' },
  'approved-design.json': { schema: approvedDesignSchema, stage: 'Stage 6 (review)' },
  'review-log.json': { schema: reviewLogSchema, stage: 'Stage 6 (review)' },
  'qa-report.json': { schema: qaReportSchema, stage: 'Stage 9 (qa)' },
};
