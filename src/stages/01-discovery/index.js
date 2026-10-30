// Stage 1, step B: turns inputs/answers.json into site-brief.json (the registered stage).
// The interview (step A) lives in interview.js and is run with the `discover` command.

import fs from 'node:fs';
import { askJson } from '../../lib/llm.js';
import { exists, projectPath, writeJson } from '../../lib/project.js';
import { cleanCurrency } from '../../lib/price.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { log } from '../../lib/log.js';
import { whatsappDigits } from '../../lib/phone.js';
import { applyItems } from '../../lib/shopItems.js';
import { stageSummary } from '../../lib/costLog.js';
import { BRIEF_SYSTEM, briefPrompt } from './prompts.js';

const STAGE = 'brief';

export function printBrief(brief) {
  const line = (label, value) => console.log(`  ${label.padEnd(10)} ${value || '(none)'}`);
  const b = brief.business;
  console.log(`\nSite brief for ${b.name} (${b.type})`);
  line('About', b.description);
  line('Location', b.location);
  line('Contact', [b.contact.phone, b.contact.email, b.contact.address, b.contact.hours].filter(Boolean).join(' | '));
  line('Goal', brief.goals.primary);
  line('Audience', brief.audience.description);
  line('Offerings', brief.offerings.map((o) => o.name + (o.price ? ` (${o.price})` : '')).join('; '));
  line('Pages', brief.pages.map((p) => p.slug).join(', '));
  line('Features', brief.features.map((f) => f.type + (f.url ? ` -> ${f.url}` : '')).join(', '));
  line('Brand', `${brief.brand.colors.join(', ')} | ${brief.brand.personality.join(', ')}`);
  line('Tone', brief.tone);
  console.log('  Unknowns:');
  brief.unknowns.forEach((u) => console.log(`    - ${u}`));
}

// The wishes are not facts about the business: the model never sees them (it cannot turn "my best sellers" into products),
// and code copies them into the brief word for word.
export function splitWishes(answers) {
  const { homeWishes, aiPictures, whatsapp, messagesTo, orderOnline, orderMode, fulfil, deliveryFee, assistant, openDays, openFrom, openTo, slotMinutes, timeZone, items, itemPhotos, siteType, currency, ...forBrief } = answers;
  return {
    forBrief,
    bookingHours: Array.isArray(openDays) && openDays.length ? { days: openDays.filter((d) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(d)), from: /^\d{1,2}:\d{2}$/.test(openFrom) ? openFrom : '09:00', to: /^\d{1,2}:\d{2}$/.test(openTo) ? openTo : '17:00', slotMinutes: [15, 20, 30, 45, 60, 75, 90, 120, 180].includes(Number(slotMinutes)) ? Number(slotMinutes) : 60, timeZone: String(timeZone ?? '').slice(0, 60) } : undefined,
    assistant: assistant && assistant.enabled === true ? { enabled: true, rules: String(assistant.rules ?? '').slice(0, 3000), model: assistant.model === 'economy' ? 'economy' : 'standard' } : undefined,
    orderTo: orderMode === 'panel' ? 'panel' : 'whatsapp',
    fulfil: (Array.isArray(fulfil) ? fulfil : []).filter((f, i, a) => ['delivery', 'pickup', 'dinein'].includes(f) && a.indexOf(f) === i),
    deliveryFee: String(deliveryFee ?? '').replace(/[^0-9.,]/g, '').slice(0, 10),
    ordering: !(['whatsapp', 'panel'].includes(orderMode) || (orderMode === undefined && orderOnline === true)) ? '' : { menu: 'order', shop: 'order', services: 'book' }[siteType] ?? '',
    structured: { items: Array.isArray(items) ? items : [], itemPhotos: Array.isArray(itemPhotos) ? itemPhotos : [], siteType }, // the owner's product list: code copies it, the model never rewrites it
    currency: cleanCurrency(currency),
    wishes: { home: String(homeWishes ?? '').trim().slice(0, 1500), aiPictures: aiPictures === 'photos-only' ? 'photos-only' : 'allowed' },
    // the WhatsApp number is only kept when it is clearly international (a wa.me link needs the country code)
    delivery: { whatsapp: whatsappDigits(whatsapp), contactMethod: ['whatsapp', 'email'].includes(messagesTo) ? messagesTo : '' },
  };
}

export async function run({ projectId }) {
  const started = Date.now();
  const since = new Date().toISOString();
  if (!exists(projectId, 'inputs/answers.json'))
    throw new Error(`Missing inputs/answers.json in project "${projectId}". Run: node src/cli.js discover --project ${projectId}`);
  const answers = JSON.parse(fs.readFileSync(projectPath(projectId, 'inputs/answers.json'), 'utf8'));

  const { forBrief, wishes, delivery, structured, currency, ordering, orderTo, fulfil: fulfilWays, deliveryFee: fee, bookingHours, assistant: assistantChoice } = splitWishes(answers);
  const brief = await askJson({
    projectId, stage: STAGE, system: BRIEF_SYSTEM, prompt: briefPrompt(projectId, forBrief), schema: siteBriefSchema,
  });
  brief.projectId = projectId;
  brief.wishes = wishes;
  brief.currency = currency;
  if (bookingHours) brief.bookingHours = bookingHours;
  if (assistantChoice) brief.assistant = assistantChoice;
  brief.orderTo = orderTo; brief.fulfil = fulfilWays; brief.deliveryFee = fee;
  brief.ordering = ordering; // orders / appointment requests on the site (they arrive on the owner's WhatsApp; stage 8 adds them when there is a way to receive them)
  applyItems(brief, structured);
  brief.business.contact.whatsapp = delivery.whatsapp;
  brief.contactMethod = delivery.contactMethod === 'whatsapp' && !delivery.whatsapp ? '' : delivery.contactMethod === 'email' && !brief.business.contact.email ? '' : delivery.contactMethod;
  writeJson(projectId, 'site-brief.json', brief, siteBriefSchema);

  printBrief(brief);
  log.info(STAGE, `site-brief.json written. ${stageSummary(projectId, STAGE, since, Date.now() - started)}`);
}
