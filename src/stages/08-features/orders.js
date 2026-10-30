// Stage 8, pure functions: orders and appointment requests on the finished site. No AI, no server, no payment.
//   ordering 'order': items with a price get an "Add" button and a cart; the order is sent to the owner's WhatsApp, the customer pays
//                     the owner in cash when they receive it (online card payment is a later step).
//   ordering 'book':  every service gets a "Book" button; the owner's booking link when there is one, otherwise an appointment request
//                     (service, day, time, name, phone) sent to the owner's WhatsApp.
// The browser part is order-client.js (served as /order.js) and order.css (served as /order.css).

import fs from 'node:fs';
import { formatPrice } from '../../lib/price.js';
import { parseTree } from '../../lib/htmlRows.js';

export const ORDER_JS = fs.readFileSync(new URL('./order-client.js', import.meta.url), 'utf8');
export const ORDER_CSS = fs.readFileSync(new URL('./order.css', import.meta.url), 'utf8');
export const ORDER_MARK = 'data-features';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// "$#" for the owner's currency: the script puts the number where the # is.
export const priceFormat = (currency) => formatPrice('7777', currency).replace('7777', '#');

// The page's rows that can be ordered: every row of the standard shape with a price.
export const orderableRows = (html) => (html.match(/<[a-z]+\b[^>]*\bdata-item="[^"]*"[^>]*\bdata-price="[^"]*"/gi) ?? []).length;

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// What the site really sells, read from its own rows: [{ name, price }] (the order service checks every order against this list).
export function catalogOf(pages) {
  const seen = new Map();
  for (const html of pages) for (const m of html.matchAll(/<[a-z]+\b[^>]*\bdata-item="([^"]*)"(?:[^>]*\bdata-price="([^"]*)")?/gi)) {
    const name = decode(m[1]); const price = Number(m[2]) || 0;
    if (name && !seen.has(name)) seen.set(name, price);
  }
  return [...seen].map(([name, price]) => ({ name, price }));
}

// mode: 'order' | 'book'. to: 'whatsapp' (digits: the owner's number with country code) or 'panel' (api: the order service address, siteId).
// fulfil: ['delivery', 'pickup', 'dinein']. fee: the delivery fee. Returns { html, added }.
export function addOrdering(html, { mode, to = 'whatsapp', digits = '', api = '', siteId = '', currency = '', language = 'en', bookUrl = '', services = [], fulfil = [], fee = 0, calendar = false }) {
  if (!['order', 'book'].includes(mode) || html.includes('id="order-config"')) return { html, added: false };
  if (to === 'panel' ? !siteId : !digits) return { html, added: false }; // api '' means the orders go to the same address as the website
  const a = {
    'data-mode': mode, 'data-to': to, 'data-wa': digits, 'data-api': api, 'data-site': siteId, 'data-fulfil': fulfil.join(','), 'data-fee': Number(fee) || 0,
    'data-fmt': priceFormat(currency), 'data-lang': language, 'data-book-url': /^https?:\/\//i.test(bookUrl) ? bookUrl : '', 'data-services': JSON.stringify(services), 'data-calendar': calendar ? '1' : '',
  };
  const attrs = Object.entries(a).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const config = `<div id="order-config" ${ORDER_MARK}="${mode === 'book' ? 'booking-request' : 'order'}" hidden ${attrs}></div>`;
  // the "#book" buttons need a place to point at: the inline calendar when the page has one, otherwise a marker
  const marker = calendar && !html.includes('id="book"') ? '<span id="book"></span>\n' : '';
  const block = `<link rel="stylesheet" href="/order.css">\n${marker}${config}\n<script src="/order.js" defer></script>`;
  return { html: `${html}\n${block}\n`, added: true };
}

// The designer's "Book now" buttons that link to the owner's external booking address now open the website's own calendar (href="#book").
export function pointBookingAtCalendar(html, url) {
  if (!url) return html;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<a\\b([^>]*?)\\bhref="' + esc(url) + '"([^>]*)>', 'gi');
  return html.replace(re, (m, before, after) => '<a' + before.replace(/\s*\btarget="_blank"/i, '').replace(/\s*\brel="[^"]*"/i, '') + 'href="#book"' + after.replace(/\s*\btarget="_blank"/i, '').replace(/\s*\brel="[^"]*"/i, '') + '>');
}

// The designer often draws a "Book your consultation" section with a calendar that does nothing (a place for an outside embed). With the
// website's own calendar, everything in that section after its heading is replaced by the real calendar (an empty box the script fills in).
export function replaceBookingWidget(html) {
  const tree = parseTree(html);
  let found = null;
  const walk = (n) => { if (!found && n.tag === 'section' && /\bid="(?:[a-z0-9-]*-)?(?:booking|book|appointment|appointments|schedule)"/i.test(n.attrs ?? '')) found = n; for (const c of n.children ?? []) walk(c); };
  walk(tree);
  if (!found) return { html, replaced: false };
  const hasHeading = (n) => n.tag === 'h2' || n.tag === 'h3' || (n.children ?? []).some(hasHeading);
  const kids = found.children.filter((c) => c.tag);
  const at = kids.findIndex(hasHeading);
  if (at < 0 || at === kids.length - 1) return { html, replaced: false };
  const first = kids[at + 1]; const last = kids[kids.length - 1];
  return { html: html.slice(0, first.start) + '<div id="book" data-inline-calendar class="mt-8"></div>' + html.slice(last.end), replaced: true };
}

// With the website's own calendar, the designer's in-page buttons about booking ("Book consultation" -> #visit) open the calendar too.
export function bookingButtonsToCalendar(html) {
  return html.replace(/<a\b([^>]*)\bhref="#(?!book")[^"]*"([^>]*)>([\s\S]*?)<\/a>/gi, (whole, before, after, inner) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return /\b(book|booking|appointment|reserve|schedule)\b|احجز|موعد|réserv|reserv|buchen|termin/i.test(text) ? `<a${before}href="#book"${after}>${inner}</a>` : whole;
  });
}

const ORDER_WORD = /order|طلب|commande|pedido|bestell/i;

// When orders are placed on the website itself, the designer's "Order on WhatsApp" buttons (a wa.me link whose text is about ordering) are
// removed, and so is any empty box they leave behind. The contact form and other WhatsApp links stay. Returns { html, removed }.
export function dropWhatsAppOrderButtons(html) {
  let removed = 0;
  let out = html.replace(/<a\b[^>]*\bhref="https?:\/\/wa\.me\/[^"]*"[^>]*>([\s\S]*?)<\/a>\s*/gi, (whole, inner) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/whatsapp|واتساب|واتس/i.test(text) || !ORDER_WORD.test(text)) return whole;
    removed++; return '';
  });
  if (removed) for (let i = 0; i < 3; i++) out = out.replace(/<(div|li|p|span)\b(?![^>]*\b(?:id|data-[a-z-]+)=)[^>]*>\s*<\/\1>\s*/gi, ''); // never a box with an id or data attribute (the order settings box is empty on purpose)
  return { html: out, removed };
}

// The same, for sentences: "order on WhatsApp" (English copy) becomes "order on this website" in the page text and in the search description.
export function rewordWhatsAppOrder(text) {
  return text.replace(/\b(order(?:s|ing)?) (?:on|via|through|by|with|using) WhatsApp\b/gi, (m, word) => `${word} on this website`);
}
