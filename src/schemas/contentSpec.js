// Schema for content-spec.json (written by Stage 4, content generation).
// Targets of CTAs: a page slug ("contact"), "form", a URL, "tel:<number>", or "social:<platform>".

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const ctaSchema = z.object({ label: z.string().min(1), target: z.string().min(1) });

const sectionSchema = z.object({
  id: z.string().min(1),
  heading: z.string().default(''),
  subheading: z.string().default(''),
  body: z.array(z.string()).default([]),
  items: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
  cta: ctaSchema.optional(),
  imageAlt: z.record(z.string(), z.string()).default({}),
  dishes: z.array(z.number().int()).optional(), // only while writing: which of the owner's dishes go in this list section (code turns it into items)
});

export const globalSchema = z.object({
  siteTitle: z.string().min(1),
  navigation: z.array(z.object({ label: z.string(), page: z.string() })),
  primaryCta: ctaSchema,
  footerText: z.string().default(''),
  formMessages: z.object({ success: z.string().min(1), error: z.string().min(1) }).optional(),
});

export const pageSchema = z.object({
  slug: z.string().min(1),
  seo: z.object({
    title: z.string().min(1).max(60, 'SEO title must be 60 characters or fewer'),
    description: z.string().min(1).max(155, 'SEO description must be 155 characters or fewer'),
  }),
  sections: z.array(sectionSchema).min(1),
});

export const contentSpecSchema = z.object({
  schemaVersion: z.literal(1),
  language: z.string().min(2),
  global: globalSchema,
  pages: z.array(pageSchema).min(1),
});

export const validate = makeValidate(contentSpecSchema);
