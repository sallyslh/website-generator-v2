// Stage 8: features. Works on the site that Stage 7 generated (no AI, no cost):
//   - every form becomes a form that really delivers messages (a form service), or an email link, or is removed: never a dead form
//   - a map is added when the owner wanted one and gave an address
//   - a booking button is added when the owner gave a booking link
//   features --project <id>     applies the features to projects/<id>/site (Stage 7 runs this automatically before a build)
// The form service: projects/<id>/form.json { "endpoint": "https://...", "accessKey": "..." } or FORM_ENDPOINT / FORM_ACCESS_KEY in .env
// (Formspree and Web3Forms both work: create a free form there with the owner's email address).

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { contentSpecSchema } from '../../schemas/contentSpec.js';
import { log } from '../../lib/log.js';
import { connectForm, connectWhatsApp, formWithoutService, addMap, addBooking, messagesFor, FORM_JS } from './forms.js';
import { whatsappDigits } from '../../lib/phone.js';
import { pointBookingAtCalendar, bookingButtonsToCalendar, replaceBookingWidget, addOrdering, dropWhatsAppOrderButtons, rewordWhatsAppOrder, orderableRows, catalogOf, priceFormat, ORDER_JS, ORDER_CSS } from './orders.js';
import { numericPrice } from '../../lib/price.js';
import { createStore, newKey } from '../../server/orders/store.js';
import { scheduleFrom } from '../../server/orders/schedule.js';
import { addChat, CHAT_JS, CHAT_CSS } from './chat-widget.js';
import { ordersDir } from '../../server/orders/server.js';

const STAGE = 'features';
const isHttps = (u) => /^https:\/\/[^\s]+$/i.test(String(u ?? '').trim());

// The service the forms post to: the project's own form.json first, then the .env settings. null when none is set up.
export function formService(projectId) {
  const file = projectPath(projectId, 'form.json');
  let own = null;
  if (fs.existsSync(file)) { try { own = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { own = null; } }
  const endpoint = (own?.endpoint ?? config.formEndpoint ?? '').trim();
  if (!isHttps(endpoint)) return null;
  return { endpoint, accessKey: (own?.accessKey ?? config.formAccessKey ?? '').trim() || undefined };
}

const contentFiles = (siteDir) => {
  const dir = path.join(siteDir, 'src/content');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => ({ slug: f.replace(/\.html$/, ''), file: path.join(dir, f) })) : [];
};

// How a form delivers its messages. The owner's choice comes first; otherwise WhatsApp (no server, no signup) when a
// WhatsApp number with country code exists, else a form service, else an email link, else the form is removed.
// `whatsapp` is the digits stored in the brief (country code included).
export function deliveryMode({ method = '', whatsapp = '', email = '', service = null }) {
  const wa = whatsappDigits(whatsapp ? `+${String(whatsapp).replace(/^\+/, '')}` : '');
  if (method === 'whatsapp' && wa) return { mode: 'whatsapp', digits: wa };
  if (method === 'email') return service ? { mode: 'service' } : email ? { mode: 'email' } : wa ? { mode: 'whatsapp', digits: wa } : { mode: 'removed' };
  if (wa) return { mode: 'whatsapp', digits: wa };
  return service ? { mode: 'service' } : email ? { mode: 'email' } : { mode: 'removed' };
}

// The owner's panel: the site is registered with the order service (its price list, how it serves, a secret key) and the key is kept in the
// project (panel.json), so a rebuild keeps the same private link. Returns { siteId, url }.
function registerPanel(projectId, { name, mode, catalog, fulfil, fee, fmt, schedule = null, slotMinutes = 60, tz = '', whatsapp = '' }) {
  const file = projectPath(projectId, 'panel.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = null; }
  const siteId = String(projectId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 60);
  const key = saved?.setupToken || saved?.key || newKey();
  // every business has its own database folder, so its orders, accounts and history are its own
  const store = createStore(path.join(ordersDir(), siteId));
  if (!store.getSite(siteId)) store.importSiteFrom(ordersDir(), siteId); // test orders made while developing, in the shared database
  store.registerSite({ id: siteId, name, setupToken: key, mode, catalog, fulfil, deliveryFee: fee, fmt, schedule, slotMinutes, tz, whatsapp });
  const ownerExists = store.hasOwner(siteId); store.close();
  // the first link creates the owner account (it works once); after that the owner signs in at the panel address
  // the panel lives on the business's own address: <its domain>/panel (the setup link is that address plus the fragment)
  const url = ownerExists ? '/panel' : `/panel#setup=${key}`;
  fs.writeFileSync(file, JSON.stringify({ siteId, setupToken: key, url, panel: '/panel', dataDir: path.join(ordersDir(), siteId) }, null, 2));
  return { siteId, url };
}

// The website assistant in the business's own database. The first time, everything comes from assistant.json. After that the facts, the persona
// and the way to a person are refreshed from each build, but what the OWNER edited in the panel (the knowledge, their rules, on/off) is kept.
// replaceKnowledge: the files were uploaded again, so the knowledge of assistant.json replaces the owner's text.
function registerAssistant(siteId, cfg, { replaceKnowledge = false } = {}) {
  const store = createStore(path.join(ordersDir(), siteId));
  try {
    const old = store.getAssistant();
    const mine = old && !replaceKnowledge
      ? { knowledge: old.knowledge, ownerRules: old.ownerRules, enabled: old.enabled, adjustments: old.adjustments ?? [], tests: old.tests ?? [], lastRun: old.lastRun ?? null, tuned: old.tuned ?? cfg.tuned ?? null }
      : { knowledge: cfg.knowledge, ownerRules: cfg.ownerRules, enabled: cfg.enabled, adjustments: cfg.adjustments ?? [], tests: cfg.tests ?? [], lastRun: null, tuned: cfg.tuned ?? null };
    store.saveAssistant({ ...mine, persona: cfg.persona, facts: cfg.facts, handoff: cfg.handoff, language: cfg.language, model: cfg.model ?? old?.model ?? 'standard', monthlyBudgetUsd: old?.monthlyBudgetUsd ?? config.chatMonthlyBudgetUsd });
    return { kept: Boolean(old && !replaceKnowledge) };
  } finally { store.close(); }
}

export function applyFeatures(projectId, { service = formService(projectId) } = {}) {
  const siteDir = projectPath(projectId, 'site');
  if (!fs.existsSync(path.join(siteDir, 'src/content'))) throw new Error(`The site is not generated in "${projectId}". Run: node src/cli.js site --project ${projectId}`);
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const content = readJson(projectId, 'content-spec.json', contentSpecSchema);
  const wants = (type) => brief.features.find((f) => f.type === type);
  const pages = contentFiles(siteDir);
  const report = { form: 'none', formFields: [], map: 'not requested', booking: 'not requested', ordering: 'not requested', formService: service ? 'connected' : 'none' };
  let needScript = false;

  for (const page of pages) {
    let html = fs.readFileSync(page.file, 'utf8');
    if (/<form\b/i.test(html)) {
      const messages = messagesFor(content.global.formMessages, (content.language || brief.language || 'en').slice(0, 2).toLowerCase());
      const how = deliveryMode({ method: brief.contactMethod, whatsapp: brief.business.contact.whatsapp, email: brief.business.contact.email, service });
      if (how.mode === 'whatsapp') {
        const done = connectWhatsApp(html, { digits: how.digits, messages });
        if (!done.already) { html = done.html; report.formFields = done.fields; }
        report.form = 'whatsapp'; needScript = true;
      } else if (how.mode === 'service') {
        const done = connectForm(html, { service, messages });
        if (!done.already) { html = done.html; report.formFields = done.fields; }
        report.form = 'connected'; needScript = true;
      } else {
        const done = formWithoutService(html, { email: how.mode === 'email' ? brief.business.contact.email : '' });
        if (done.replaced) { html = done.html; report.form = done.replaced === 'email' ? 'email-link' : 'removed'; }
      }
    }
    fs.writeFileSync(page.file, html);
  }

  // the contact page: where the map and the booking button go
  const target = pages.find((p) => p.slug === 'contact') ?? pages.find((p) => /<form\b|data-features="form"/.test(fs.readFileSync(p.file, 'utf8'))) ?? pages.at(-1);
  if (wants('map-embed')) {
    const address = brief.business.contact.address.trim();
    if (!address) report.map = 'skipped: the owner gave no address';
    else if (!target) report.map = 'skipped: there is no page to put it on';
    else { const r = addMap(fs.readFileSync(target.file, 'utf8'), { address }); fs.writeFileSync(target.file, r.html); report.map = r.added ? `added on /${target.slug}/` : 'already there'; }
  }
  const booking = wants('booking-embed');
  // our own calendar (the owner gave opening hours and chose the live panel): every booking button opens it, the external link is not used
  const ownCalendar = brief.ordering === 'book' && brief.orderTo === 'panel' && Boolean(brief.bookingHours && scheduleFrom({ days: brief.bookingHours.days, from: brief.bookingHours.from, to: brief.bookingHours.to }));
  if (ownCalendar) {
    for (const page of pages) { const html = fs.readFileSync(page.file, 'utf8'); const out = bookingButtonsToCalendar(replaceBookingWidget(pointBookingAtCalendar(html, booking?.url ?? '')).html); if (out !== html) fs.writeFileSync(page.file, out); }
    report.booking = 'the booking buttons open the website\'s own calendar';
  } else if (booking) {
    if (!booking.url) report.booking = 'skipped: the owner gave no booking link';
    else if (!target) report.booking = 'skipped: there is no page to put it on';
    else {
      const r = addBooking(fs.readFileSync(target.file, 'utf8'), { url: booking.url, language: (content.language || brief.language || 'en').slice(0, 2).toLowerCase() });
      fs.writeFileSync(target.file, r.html);
      report.booking = r.added ? `added on /${target.slug}/` : `not added: ${r.reason}`;
    }
  }

  // orders (menu, shop) or appointment requests (services). The owner chose where they go: his live panel on the order service, or his WhatsApp.
  // The customer pays the owner directly (cash on delivery, or at the visit): no online payment is taken.
  if (brief.ordering) {
    const mode = brief.ordering;
    const to = brief.orderTo === 'panel' ? 'panel' : 'whatsapp';
    const digits = whatsappDigits(brief.business.contact.whatsapp ? `+${String(brief.business.contact.whatsapp).replace(/^\+/, '')}` : '');
    const bookUrl = ownCalendar ? '' : (booking?.url ?? ''); // with our own calendar the buttons never leave the website
    const htmls = pages.map((p) => fs.readFileSync(p.file, 'utf8'));
    const rows = htmls.reduce((n, h) => n + orderableRows(h), 0);
    const catalog = catalogOf(htmls);
    const link = mode === 'book' && bookUrl && to === 'whatsapp'; // the owner's own booking link is enough: no way to receive requests needed
    if (!link && to === 'whatsapp' && !digits) report.ordering = 'skipped: the owner gave no WhatsApp number to receive them';
    else if (mode === 'order' && !rows) report.ordering = 'skipped: no item with a price to order';
    else {
      const language = (content.language || brief.language || 'en').slice(0, 2).toLowerCase();
      const services = catalog.length ? catalog.map((c) => c.name) : brief.offerings.map((o) => o.name);
      const fee = numericPrice(brief.deliveryFee) ?? 0;
      const fulfil = brief.fulfil.length ? brief.fulfil : ['pickup'];
      let panel = null;
      // appointments from a real calendar when the owner gave opening hours (booked times are then taken off the website by the server)
      const hours = mode === 'book' ? brief.bookingHours : null;
      const schedule = hours ? scheduleFrom({ days: hours.days, from: hours.from, to: hours.to }) : null;
      if (to === 'panel') panel = registerPanel(projectId, { name: brief.business.name, mode, catalog: catalog.length ? catalog : services.map((name) => ({ name, price: 0 })), fulfil, fee, fmt: priceFormat(brief.currency), schedule, slotMinutes: hours?.slotMinutes ?? 60, tz: hours?.timeZone ?? '', whatsapp: brief.business.contact.whatsapp || '' });
      for (const page of pages) {
        let html = fs.readFileSync(page.file, 'utf8');
        // orders are placed on the site itself: the designer's "Order on WhatsApp" buttons are not needed any more (cleaned first, then the cart is added)
        if (to === 'panel' && mode === 'order') {
          const cleaned = dropWhatsAppOrderButtons(html);
          report.whatsappButtonsRemoved = (report.whatsappButtonsRemoved ?? 0) + cleaned.removed;
          html = rewordWhatsAppOrder(cleaned.html);
        }
        const r = addOrdering(html, { mode, to, digits: digits || '0', api: config.ordersUrl, siteId: panel?.siteId ?? '', currency: brief.currency, language, bookUrl, services, fulfil, fee, calendar: Boolean(schedule) });
        fs.writeFileSync(page.file, r.html);
      }
      if (to === 'panel' && mode === 'order') { // the search descriptions (src/pages/*.astro) say the same thing
        const pagesDir = path.join(siteDir, 'src/pages');
        for (const f of fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter((x) => x.endsWith('.astro')) : []) { const file = path.join(pagesDir, f); const s = fs.readFileSync(file, 'utf8'); const r = rewordWhatsAppOrder(s); if (r !== s) fs.writeFileSync(file, r); }
      }
      fs.mkdirSync(path.join(siteDir, 'public'), { recursive: true });
      fs.writeFileSync(path.join(siteDir, 'public/order.js'), ORDER_JS); fs.writeFileSync(path.join(siteDir, 'public/order.css'), ORDER_CSS);
      const where = to === 'panel' ? "the owner's live panel" : "the owner's WhatsApp";
      report.ordering = mode === 'book' ? (link ? "booking buttons open the owner's booking link" : `appointment requests go to ${where}`) : `cart on ${rows} items, ${fulfil.join('/')}, orders go to ${where}, cash on delivery`;
      if (panel) report.panel = panel.url;
    }
  }

  // the website assistant (an extra): needs the business's own server, so the site is registered even when nothing can be ordered on it
  const assistantFile = projectPath(projectId, 'assistant.json');
  report.assistant = 'not requested';
  if (brief.assistant?.enabled) {
    if (!fs.existsSync(assistantFile)) report.assistant = 'skipped: the assistant was not prepared yet (run: node src/cli.js assistant --project <id>)';
    else {
      const cfg = JSON.parse(fs.readFileSync(assistantFile, 'utf8'));
      let siteId;
      let reg = null;
      try { reg = JSON.parse(fs.readFileSync(projectPath(projectId, 'panel.json'), 'utf8')); } catch { reg = null; }
      if (!report.panel) { // nothing is ordered or booked here: an empty shop, only so the business has its own server and panel
        const made = registerPanel(projectId, { name: brief.business.name, mode: 'order', catalog: [], fulfil: [], fee: 0, fmt: '#' });
        report.panel = made.url; siteId = made.siteId;
      } else siteId = reg?.siteId;
      const kept = registerAssistant(siteId, cfg, { replaceKnowledge: process.env.ASSISTANT_REPLACE_KNOWLEDGE === '1' }).kept;
      const language = (content.language || brief.language || 'en').slice(0, 2).toLowerCase();
      for (const page of pages) { const r = addChat(fs.readFileSync(page.file, 'utf8'), { siteId, name: brief.business.name, language, api: config.ordersUrl }); fs.writeFileSync(page.file, r.html); }
      fs.mkdirSync(path.join(siteDir, 'public'), { recursive: true });
      fs.writeFileSync(path.join(siteDir, 'public/chat.js'), CHAT_JS); fs.writeFileSync(path.join(siteDir, 'public/chat.css'), CHAT_CSS);
      report.assistant = `chat bubble on ${pages.length} pages, ${cfg.knowledge.length} characters of knowledge${kept ? ' (the owner\'s own edits kept)' : ''}`;
    }
  }

  if (needScript) { fs.mkdirSync(path.join(siteDir, 'public'), { recursive: true }); fs.writeFileSync(path.join(siteDir, 'public/form.js'), FORM_JS); }
  const reportFile = path.join(siteDir, 'site-report.json');
  if (fs.existsSync(reportFile)) {
    const site = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    fs.writeFileSync(reportFile, JSON.stringify({ ...site, features: report, forms: 0 }, null, 2));
  }
  return report;
}

export async function run({ projectId }) {
  const r = applyFeatures(projectId);
  const say = { whatsapp: "the contact form opens the owner's WhatsApp with the message filled in", connected: 'the contact form delivers messages through your form service', 'email-link': 'there is no form service yet, so the form became an email link', removed: 'there is no form service and no email, so the form was removed', none: 'there is no form' }[r.form];
  log.info(STAGE, `form: ${say}.`);
  log.info(STAGE, `map: ${r.map}. booking: ${r.booking}.`);
  if (['email-link', 'removed'].includes(r.form)) log.info(STAGE, "To receive the form's messages: ask the owner for a WhatsApp number with its country code, or create a free form at formspree.io or web3forms.com with the owner's email and put its address in projects/<id>/form.json or FORM_ENDPOINT in .env.");
}
