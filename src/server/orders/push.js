// Alerts on the phone (and computer) of the people who run a business: a notification that appears even when the panel is closed.
// The browser delivers it (Web Push): no account, no email, no WhatsApp, nobody in the middle can read it (it is encrypted for the device),
// and it carries NO customer details: only "new order" and its number. The details stay in the panel, behind the sign-in.
// Each business has its own pair of keys (made the first time they are needed, kept in its own database): a business can only ever
// notify its own devices.

import webpushLib from 'web-push';

const SUBJECT = () => process.env.VAPID_SUBJECT || process.env.PUBLIC_URL || 'mailto:alerts@example.com';

export function createPusher({ store, webpush = webpushLib, log = () => {} } = {}) {
  function keys() {
    let k = null;
    try { k = JSON.parse(store.getSetting('vapid') ?? 'null'); } catch { k = null; }
    if (!k?.publicKey || !k?.privateKey) { k = webpush.generateVAPIDKeys(); store.setSetting('vapid', JSON.stringify(k)); }
    return k;
  }
  const publicKey = () => keys().publicKey;

  // The words of an alert: never a name, a phone number, an address or an item.
  function words(kind, siteName, n) {
    const book = kind === 'book';
    return { title: book ? 'New appointment request' : 'New order', body: `${String(siteName ?? '').slice(0, 60)}${n ? `: #${n}` : ''}. Tap to open your panel.`, tag: 'new-request' };
  }

  // payload: { title, body, tag }. Returns { sent, failed, removed }; never throws.
  async function send(siteId, payload) {
    const out = { sent: 0, failed: 0, removed: 0 };
    let subs = []; let k;
    try { subs = store.listPush(siteId); k = keys(); } catch { return out; }
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { vapidDetails: { subject: SUBJECT(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 60 * 60 * 24, urgency: 'high' });
        out.sent++;
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) { store.removePush(s.endpoint); out.removed++; } else { out.failed++; log(`[push] a device did not get the alert: ${e?.statusCode ?? ''} ${String(e?.body ?? e?.message ?? '').slice(0, 200)}`); }
      }
    }));
    return out;
  }
  return { publicKey, words, send };
}

// What a browser's subscription must look like before it is kept.
export function cleanSubscription(sub) {
  const endpoint = String(sub?.endpoint ?? ''); const p256dh = String(sub?.keys?.p256dh ?? ''); const auth = String(sub?.keys?.auth ?? '');
  if (!/^https:\/\/[^\s]{10,900}$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}
