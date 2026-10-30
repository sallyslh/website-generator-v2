// Stage 8, pure functions: turn the form of a built page into one that really delivers messages, add a map and a booking
// button. No file access and no AI here, so everything is unit tested.
//
// A form on a live site must never be dead. When no form service is set up, the form is replaced by an email link made
// from the form's own button text, or removed when the customer has no email either (and the report says so).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const HONEYPOT = 'company_website';
export const FEATURES_MARK = 'data-features';

// Words shown after sending when the site's own copy has none (it always has them when the brief asked for a contact form).
export const DEFAULT_MESSAGES = {
  en: { success: 'Thank you! Your message was sent.', error: 'Sorry, your message could not be sent. Please try again or contact us directly.' },
  ar: { success: 'شكرًا لك! تم إرسال رسالتك.', error: 'عذرًا، تعذّر إرسال رسالتك. حاول مرة أخرى أو تواصل معنا مباشرة.' },
  fr: { success: 'Merci ! Votre message a bien été envoyé.', error: "Désolé, votre message n'a pas pu être envoyé. Réessayez ou contactez-nous directement." },
  es: { success: '¡Gracias! Tu mensaje fue enviado.', error: 'Lo sentimos, no se pudo enviar tu mensaje. Inténtalo de nuevo o contáctanos directamente.' },
  de: { success: 'Danke! Ihre Nachricht wurde gesendet.', error: 'Leider konnte Ihre Nachricht nicht gesendet werden. Bitte versuchen Sie es erneut oder kontaktieren Sie uns direkt.' },
};
export const messagesFor = (given, language = 'en') => ({
  success: (given?.success ?? '').trim() || (DEFAULT_MESSAGES[language] ?? DEFAULT_MESSAGES.en).success,
  error: (given?.error ?? '').trim() || (DEFAULT_MESSAGES[language] ?? DEFAULT_MESSAGES.en).error,
});

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/i;

// ---------- form fields ----------

// A name for every field, so the service receives them: email -> email, tel -> phone, textarea -> message, else from the placeholder or id.
export function nameFor(tag, index) {
  const attr = (n) => tag.match(new RegExp(`\\b${n}="([^"]*)"`, 'i'))?.[1] ?? '';
  const existing = attr('name');
  if (existing) return existing;
  const type = attr('type').toLowerCase();
  const hint = `${attr('id')} ${attr('placeholder')} ${attr('aria-label')}`.toLowerCase();
  if (/^textarea/i.test(tag) || /message|note|request|details|tell us|رسالة/.test(hint)) return 'message';
  if (type === 'email' || /e-?mail|بريد/.test(hint)) return 'email';
  if (type === 'tel' || /phone|mobile|whatsapp|هاتف|رقم/.test(hint)) return 'phone';
  if (/subject|topic|موضوع/.test(hint)) return 'subject';
  if (/name|الاسم|اسم/.test(hint)) return 'name';
  const slug = hint.trim().split(/\s+/)[0]?.replace(/[^a-z0-9]+/g, '-');
  return slug && slug !== '-' ? slug : `field-${index + 1}`;
}

// The visible button text of the form (used as the label of the email link when no service is set up).
export function submitLabel(formInner) {
  const btn = formInner.match(/<button\b[^>]*>([\s\S]*?)<\/button>/i)?.[1] ?? '';
  return btn.replace(/<span\b[^>]*material-symbols[^>]*>[\s\S]*?<\/span>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// service: { endpoint, accessKey? }. messages: { success, error }. Returns { html, connected, fields }.
export function connectForm(html, { service, messages = {} }) {
  const m = html.match(FORM_RE);
  if (!m) return { html, connected: false, fields: [], found: false };
  if (/data-features=/.test(m[1])) return { html, connected: true, fields: [], found: true, already: true };
  let inner = m[2];
  const used = new Set();
  const fields = [];
  let i = 0;
  inner = inner.replace(/<(input|textarea|select)\b[^>]*>/gi, (tag, kind) => {
    const type = tag.match(/\btype="([^"]*)"/i)?.[1]?.toLowerCase();
    if (['submit', 'button', 'hidden', 'image', 'reset'].includes(type)) return tag;
    let name = nameFor(`${kind === 'textarea' ? 'textarea ' : ''}${tag}`, i++);
    while (used.has(name)) name += '-2';
    used.add(name);
    fields.push(name);
    let out = /\bname="/i.test(tag) ? tag : tag.replace(/^<(input|textarea|select)/i, `<$1 name="${name}"`);
    const label = tag.match(/\bplaceholder="([^"]*)"/i)?.[1];
    if (label && !/\baria-label=/i.test(out) && !/\bid="/i.test(out)) out = out.replace(/^<(input|textarea|select)/i, `<$1 aria-label="${esc(label)}"`);
    return out;
  });
  // the buttons of the form submit it
  inner = inner.replace(/<button\b([^>]*)>/gi, (tag, attrs) => (/\btype="/i.test(attrs) ? tag : `<button type="submit"${attrs}>`));
  const honeypot = `<div style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Leave this field empty <input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>`;
  const key = service.accessKey ? `<input type="hidden" name="access_key" value="${esc(service.accessKey)}">` : '';
  const attrs = m[1].replace(/\s(action|method|onsubmit)="[^"]*"/gi, '');
  const opened = `<form${attrs} action="${esc(service.endpoint)}" method="POST" ${FEATURES_MARK}="form" data-success="${esc(messages.success ?? '')}" data-error="${esc(messages.error ?? '')}">`;
  const status = '<p data-form-status role="status" aria-live="polite" class="mt-4"></p>';
  return { html: html.replace(FORM_RE, () => `${opened}${inner}${honeypot}${key}</form>${status}\n<script src="/form.js" defer></script>`), connected: true, fields, found: true };
}

// WhatsApp mode (no server, no signup): the form composes the message and opens the owner's WhatsApp chat with it filled in.
// digits: the owner's number in international form (see lib/phone.js). Returns the same shape as connectForm.
export function connectWhatsApp(html, { digits, messages = {} }) {
  const base = connectForm(html, { service: { endpoint: 'https://wa.me/' }, messages });
  if (!base.found || base.already) return base;
  let out = base.html.replace(/\saction="https:\/\/wa\.me\/"/, '').replace(/\smethod="POST"/, '').replace(`${FEATURES_MARK}="form"`, `${FEATURES_MARK}="whatsapp" data-wa="${esc(digits)}"`);
  // a readable heading for every field: the label text, else the placeholder, else the field's name
  const labels = new Map([...out.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]));
  out = out.replace(/<(input|textarea|select)\b[^>]*>/gi, (tag) => {
    const type = tag.match(/\btype="([^"]*)"/i)?.[1]?.toLowerCase();
    const name = tag.match(/\bname="([^"]*)"/i)?.[1];
    if (!name || name === HONEYPOT || ['submit', 'button', 'hidden'].includes(type)) return tag;
    const label = labels.get(tag.match(/\bid="([^"]*)"/i)?.[1]) || tag.match(/\bplaceholder="([^"]*)"/i)?.[1] || name;
    return tag.replace(/^<(input|textarea|select)/i, `<$1 data-label="${esc(label)}"`);
  });
  return { ...base, html: out, mode: 'whatsapp' };
}

// No service: the form becomes an email link with the form's own button text. Returns { html, replaced: 'email' | 'removed' }.
export function formWithoutService(html, { email }) {
  const m = html.match(FORM_RE);
  if (!m) return { html, replaced: null };
  if (/data-features=/.test(m[1])) return { html, replaced: null };
  const label = submitLabel(m[2]);
  const classes = m[2].match(/<button\b[^>]*\bclass="([^"]*)"/i)?.[1] ?? '';
  if (email && label) return { html: html.replace(FORM_RE, () => `<a ${FEATURES_MARK}="mailto" class="${esc(classes)} inline-block text-center" href="mailto:${esc(email)}">${esc(label)}</a>`), replaced: 'email' };
  return { html: html.replace(FORM_RE, () => ''), replaced: 'removed' };
}

// ---------- map and booking ----------

export function addMap(html, { address }) {
  if (!address || /data-features="map"/.test(html)) return { html, added: false };
  const src = `https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed`;
  const block = `<section ${FEATURES_MARK}="map" class="mx-auto w-full max-w-6xl px-6 pb-16"><iframe title="${esc(address)}" src="${esc(src)}" class="h-80 w-full rounded-lg border-0" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></section>`;
  if (/<\/main>/i.test(html)) return { html: html.replace(/<\/main>/i, () => `${block}\n</main>`), added: true };
  return { html: `${html}\n${block}`, added: true };
}

const BOOKING_LABEL = { en: 'Book now', ar: 'احجز الآن', fr: 'Réserver', es: 'Reservar', de: 'Jetzt buchen' };

// A booking button, unless the page already links to the booking address (a call-to-action from the copy resolved to it).
export function addBooking(html, { url, language = 'en', label }) {
  if (!/^https?:\/\//i.test(url ?? '')) return { html, added: false, reason: 'the booking address is not a web link' };
  if (html.includes(`href="${esc(url)}"`) || /data-features="booking"/.test(html)) return { html, added: false, reason: 'the page already links to it' };
  const text = label || BOOKING_LABEL[language] || BOOKING_LABEL.en;
  const block = `<section ${FEATURES_MARK}="booking" class="mx-auto w-full max-w-6xl px-6 pb-12 text-center"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="inline-block rounded-full bg-primary px-8 py-3 text-on-primary">${esc(text)}</a></section>`;
  if (/<\/main>/i.test(html)) return { html: html.replace(/<\/main>/i, () => `${block}\n</main>`), added: true };
  return { html: `${html}\n${block}`, added: true };
}

// ---------- the script that sends the form ----------

// Served as /form.js. Sends the form without leaving the page, shows the copy's own success / error messages,
// drops bots silently (hidden field, or a form sent within 1.5 seconds), and never shows success when the service said no.
export const FORM_JS = `(function () {
  var forms = document.querySelectorAll('form[data-features="form"], form[data-features="whatsapp"]');
  Array.prototype.forEach.call(forms, function (form) {
    var status = form.parentNode.querySelector('[data-form-status]');
    var opened = Date.now();
    function say(text, ok) { if (status) { status.textContent = text; status.setAttribute('data-ok', ok ? 'true' : 'false'); } }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var trap = form.querySelector('[name="${HONEYPOT}"]');
      if ((trap && trap.value) || Date.now() - opened < 1500) { say(form.getAttribute('data-success') || '', true); return; }
      var digits = form.getAttribute('data-wa');
      if (digits) {
        // WhatsApp mode: the message is composed here and the owner's chat opens with it filled in
        var lines = [];
        Array.prototype.forEach.call(form.querySelectorAll('input, textarea, select'), function (field) {
          var type = (field.type || '').toLowerCase();
          if (!field.name || field.name === '${HONEYPOT}' || type === 'hidden' || type === 'submit' || type === 'button' || !field.value) return;
          lines.push((field.getAttribute('data-label') || field.name) + ': ' + field.value);
        });
        window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(lines.join('\\n')), '_blank', 'noopener');
        say(form.getAttribute('data-success') || '', true);
        return;
      }
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then(function (res) { if (!res.ok) throw new Error('status ' + res.status); form.reset(); say(form.getAttribute('data-success') || '', true); })
        .catch(function () { say(form.getAttribute('data-error') || '', false); })
        .then(function () { if (button) button.disabled = false; });
    });
  });
})();
`;
