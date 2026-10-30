// Schema for site-brief.json (written by Stage 1, business discovery).

import { z } from 'zod';
import { makeValidate } from './helpers.js';

export const FEATURE_TYPES = ['contact-form', 'map-embed', 'booking-embed', 'social-links', 'gallery'];

const str = () => z.string().default('');

// A fact suggested from the customer's files (not from the customer). Applied only after confirmation.
export const proposalSchema = z.object({
  path: z.string().min(1),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  evidence: z.string().min(1),
  status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});

export const siteBriefSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  business: z.object({
    name: z.string().min(1),
    type: str(),
    description: str(),
    story: str(), // the owner's own words: how it started, what makes it special
    location: str(),
    contact: z.object({ phone: str(), email: str(), address: str(), hours: str(), whatsapp: str() }), // whatsapp: digits with country code, copied by code from what the owner typed
    socialLinks: z.array(z.object({ platform: z.string(), url: z.string() })).default([]),
  }),
  goals: z.object({
    primary: str(),
    secondary: z.array(z.string()).default([]),
  }),
  audience: z.object({
    description: str(),
    needs: z.array(z.string()).default([]),
    notFor: z.array(z.string()).default([]), // who the business is NOT for (only if the owner said so)
  }),
  offerings: z
    .array(z.object({ name: z.string().min(1), description: str(), price: z.string().optional(), category: z.string().optional(), assetId: z.string().optional() })) // assetId: the customer photo this product is visible in (set only after the customer confirmed it)
    .default([]),
  pages: z
    .array(z.object({ slug: z.string().min(1), title: z.string().min(1), purpose: str() }))
    .refine((pages) => pages.some((p) => p.slug === 'home'), { message: 'pages must include a "home" page' }),
  features: z.array(z.object({ type: z.enum(FEATURE_TYPES), url: z.string().optional() })).default([]),
  brand: z.object({
    hasIdentity: z.boolean(),
    colors: z.array(z.string()).default([]),
    fonts: z.string().optional(),
    personality: z.array(z.string()).default([]),
  }),
  tone: str(),
  // the owner's wishes for the home page, kept word for word, and whether pictures made with AI are welcome
  // where a contact form's messages go when the owner has both ('whatsapp' or 'email'), '' = decide from what exists
  contactMethod: z.enum(['whatsapp', 'email', '']).default(''),
  // the kind of website the owner chose on the form (menu, shop, services, intro, both); the shop form also gives the product list itself
  siteType: z.enum(['menu', 'shop', 'services', 'intro', 'both']).optional(),
  ordering: z.enum(['', 'order', 'book']).default(''), // 'order': the cart (cash on delivery, sent on WhatsApp); 'book': an appointment request (or the owner's booking link)
  // appointments from a real calendar: the days and hours the business takes them, the length of one appointment, and its time zone
  bookingHours: z.object({ days: z.array(z.string()).default([]), from: z.string().default('09:00'), to: z.string().default('17:00'), slotMinutes: z.number().default(60), timeZone: z.string().default('') }).optional(),
  // the website assistant (an extra): on/off, and the owner's own restrictions written in the form
  assistant: z.object({ enabled: z.boolean().default(false), rules: z.string().default(''), model: z.enum(['standard', 'economy']).default('standard') }).optional(),
  orderTo: z.enum(['whatsapp', 'panel']).default('whatsapp'), // where orders go: the owner's WhatsApp, or his live panel on the order service
  fulfil: z.array(z.enum(['delivery', 'pickup', 'dinein'])).default([]), // how the customer gets the order (the owner's choice)
  deliveryFee: z.string().default(''),
  currency: z.string().default(''), // the currency of the owner's prices (USD, EUR, LBP...): only used to show prices clearly, never to change them
  wishes: z.object({ home: z.string().default(''), aiPictures: z.enum(['allowed', 'photos-only']).default('allowed') }).default({ home: '', aiPictures: 'allowed' }),
  references: z.object({
    liked: z.array(z.object({ url: z.string().optional(), why: str() })).default([]),
    disliked: z.array(z.object({ url: z.string().optional(), why: str() })).default([]),
  }),
  language: z.string().min(2),
  unknowns: z.array(z.string()).default([]),
  proposals: z.array(proposalSchema).default([]),
});

export const validate = makeValidate(siteBriefSchema);
