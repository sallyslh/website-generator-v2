// A phone number or an email on a website must be the owner's, never a made-up one. The designer sometimes writes its own placeholder in a
// footer ("tel:+9611000000", "info@example.com"). Every phone link, every email link and every "+number" in the text that is not the
// owner's is corrected to the owner's, or removed when the owner gave none. No AI.

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, ''); // no leading zeros: 00961... and 03... are the same line as +961 3...
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sameNumber = (a, b) => a.length >= 6 && b.length >= 6 && (a === b || a.endsWith(b) || b.endsWith(a)); // with or without the country code

// owner: { phone, whatsapp (digits with country code, or as typed), email }. Returns { html, fixed, removed: [what] }.
export function correctContactDetails(html, { phone = '', whatsapp = '', email = '' } = {}) {
  const known = [digitsOf(phone), digitsOf(whatsapp)].filter((d) => d.length >= 6);
  const shownPhone = String(phone).trim() || (digitsOf(whatsapp) ? `+${digitsOf(whatsapp)}` : '');
  const ownEmail = String(email).trim().toLowerCase();
  const isOwnNumber = (d) => known.some((k) => sameNumber(k, d));
  const removed = []; let fixed = 0;

  // phone links
  let out = html.replace(/<a\b([^>]*?)\bhref="tel:([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi, (whole, before, num, after) => {
    let n = num; try { n = decodeURIComponent(num); } catch { /* keep as written */ }
    if (isOwnNumber(digitsOf(n))) return whole;
    if (!shownPhone) { removed.push(n); return ''; }
    fixed++;
    return `<a${before}href="tel:${esc(digitsOf(shownPhone) ? `+${digitsOf(shownPhone)}` : shownPhone)}"${after}>${esc(shownPhone)}</a>`;
  });
  // email links
  out = out.replace(/<a\b([^>]*?)\bhref="mailto:([^"?]*)([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi, (whole, before, addr, query, after, inner) => {
    if (addr.trim().toLowerCase() === ownEmail) return whole;
    if (!ownEmail) { removed.push(addr); return ''; }
    fixed++;
    const label = inner.replace(/<[^>]+>/g, '').includes('@') ? esc(email.trim()) : inner; // the words of a button stay, an address shown as text is replaced
    return `<a${before}href="mailto:${esc(email.trim())}${query}"${after}>${label}</a>`;
  });
  // a "+number" written as plain text (outside tags): the owner's, or gone
  out = out.replace(/(>[^<]*?)(\+\s?\d[\d\s().-]{7,}\d)([^<]*<)/g, (whole, a, number, b) => {
    if (isOwnNumber(digitsOf(number))) return whole;
    if (!shownPhone) { removed.push(number); return `${a}${b}`; }
    fixed++; return `${a}${esc(shownPhone)}${b}`;
  });
  return { html: out, fixed, removed };
}

// The owner's WhatsApp link, email address and phone number written as plain text (the designer often leaves them as words) become links
// that work with one click: WhatsApp opens the chat, the email opens the mail app, the phone starts a call. Text already inside a link, a
// button, a script or the head is never touched. No AI.
export function makeContactClickable(html, { phone = '', whatsapp = '', email = '' } = {}) {
  const wa = digitsOf(whatsapp) || digitsOf(phone);
  const ownEmail = String(email).trim();
  const shownPhone = String(phone).trim();
  if (!wa && !ownEmail && !shownPhone) return { html, linked: 0 };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [];
  if (wa) parts.push(`https?:\\/\\/wa\\.me\\/\\+?0*${escRe(wa)}\\/?(?:\\?[^\\s<"]*)?`);
  if (ownEmail) parts.push(escRe(ownEmail));
  if (shownPhone && digitsOf(shownPhone).length >= 6) parts.push(escRe(shownPhone));
  const rx = new RegExp(`(${parts.join('|')})`, 'gi');
  let linked = 0; let skip = 0; let head = false;
  const SKIP = /^<(a|button|script|style|title|textarea|select|option)\b/i; const SKIP_END = /^<\/(a|button|script|style|title|textarea|select|option)\b/i;
  const out = html.split(/(<[^>]*>)/).map((seg) => {
    if (seg.startsWith('<')) {
      if (/^<head\b/i.test(seg)) head = true; else if (/^<\/head/i.test(seg)) head = false;
      else if (SKIP.test(seg) && !/\/>$/.test(seg)) skip++; else if (SKIP_END.test(seg)) skip = Math.max(0, skip - 1);
      return seg;
    }
    if (skip || head || !seg.trim()) return seg;
    return seg.replace(rx, (m) => {
      linked++;
      if (/^https?:/i.test(m)) return `<a href="${esc(m)}" target="_blank" rel="noopener noreferrer">${esc(shownPhone || `+${wa}`)}</a>`;
      if (m.toLowerCase() === ownEmail.toLowerCase()) return `<a href="mailto:${esc(ownEmail)}">${esc(m)}</a>`;
      return `<a href="tel:+${digitsOf(m)}">${esc(m)}</a>`;
    });
  }).join('');
  return { html: out, linked };
}
