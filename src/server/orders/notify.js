// Alerts to the OWNER when an order or an appointment request arrives: a WhatsApp message and/or an email. Nothing here is shown to the
// provider (the team): each business's server sends its own alerts to its own owner.
// The senders are services that need an account, set up by the developer in the server's environment:
//   email      RESEND_API_KEY, MAIL_FROM                       (resend.com: a verified sending address)
//   WhatsApp   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE (+ WHATSAPP_LANG)   (Meta WhatsApp Business Cloud API: a message
//              template with ONE body variable, because a business may only start a chat with an approved template)
//   PUBLIC_URL (optional) is the business's address, used to add the link to the panel.
// Without the settings a channel is "not configured": it is reported honestly in the panel and nothing is sent. A failing alert never
// loses an order: every error is caught and reported, never thrown.

const line = (s, n = 400) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);
const money = (n, fmt = '#') => String(fmt || '#').replace('#', String(Math.round(Number(n) * 100) / 100));

// The words of an alert (one line of text: a WhatsApp template variable cannot hold line breaks).
export function describe(order, site = {}) {
  const d = order.data ?? order;
  const who = `${line(d.name, 80)} (${line(d.phone, 30)})`;
  if (order.kind === 'book' || d.kind === 'book') {
    return { subject: `New appointment request #${order.id ?? order.n}: ${line(d.service, 80)}`, text: `New appointment request #${order.id ?? order.n} at ${line(site.name, 80)}: ${line(d.service, 120)} on ${line(d.day, 10)} at ${line(d.time, 5)}. ${who}.${d.notes ? ` Note: ${line(d.notes, 200)}` : ''}` };
  }
  const items = (d.items ?? []).map((i) => `${i.qty} x ${line(i.name, 80)}`).join(', ');
  const way = { pickup: 'pick up', delivery: 'delivery', dinein: 'eat in' }[d.type] ?? line(d.type, 20);
  return { subject: `New order #${order.id ?? order.n}: ${money(d.total, site.fmt)}`, text: `New order #${order.id ?? order.n} at ${line(site.name, 80)}: ${items}. Total ${money(d.total, site.fmt)}, ${way}${d.address ? ` to ${line(d.address, 200)}` : ''}. ${who}.${d.notes ? ` Note: ${line(d.notes, 200)}` : ''}` };
}

// The channels this server can really use right now.
export function channelsAvailable(env = process.env) {
  return { email: Boolean(env.RESEND_API_KEY && env.MAIL_FROM), whatsapp: Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.WHATSAPP_TEMPLATE) };
}

async function sendEmail({ env, fetchFn, to, subject, text }) {
  const r = await fetchFn('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }) });
  if (!r.ok) throw new Error(`the email service answered ${r.status}`);
}
async function sendWhatsapp({ env, fetchFn, to, text }) {
  const r = await fetchFn(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: env.WHATSAPP_TEMPLATE, language: { code: env.WHATSAPP_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 900) }] }] } }),
  });
  if (!r.ok) throw new Error(`WhatsApp answered ${r.status}`);
}

// settings: { whatsapp, whatsappOn, emailOn }, owners: [{ email }]. Returns { email: 'sent'|'off'|'not configured'|'failed', whatsapp: ... } and never throws.
export function createNotifier({ env = process.env, fetchFn = globalThis.fetch, log = () => {} } = {}) {
  async function send({ site, order, settings, owners = [], test = false }) {
    const result = { email: 'off', whatsapp: 'off' };
    const avail = channelsAvailable(env);
    const words = test ? { subject: 'Test alert', text: `This is a test alert from your website ${line(site?.name, 80)}. If you can read it, your alerts work.` } : describe(order, site);
    const link = env.PUBLIC_URL ? ` Open your panel: ${String(env.PUBLIC_URL).replace(/\/$/, '')}/panel` : '';
    const emails = owners.map((o) => o.email).filter(Boolean);
    if (settings?.emailOn && emails.length) {
      if (!avail.email) result.email = 'not configured';
      else { try { await sendEmail({ env, fetchFn, to: emails, subject: words.subject, text: words.text + link }); result.email = 'sent'; } catch (e) { result.email = 'failed'; log(`[alerts] email failed: ${e.message}`); } }
    }
    const number = String(settings?.whatsapp ?? '').replace(/\D/g, '');
    if (settings?.whatsappOn && number.length >= 6) {
      if (!avail.whatsapp) result.whatsapp = 'not configured';
      else { try { await sendWhatsapp({ env, fetchFn, to: number, text: words.text }); result.whatsapp = 'sent'; } catch (e) { result.whatsapp = 'failed'; log(`[alerts] WhatsApp failed: ${e.message}`); } }
    }
    return result;
  }
  return { send, available: () => channelsAvailable(env) };
}
