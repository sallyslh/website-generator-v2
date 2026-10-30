import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';
import { createNotifier, describe, channelsAvailable } from '../src/server/orders/notify.js';

const ENV = { RESEND_API_KEY: 'rk', MAIL_FROM: 'Alerts <alerts@example.com>', WHATSAPP_TOKEN: 'wt', WHATSAPP_PHONE_ID: '123', WHATSAPP_TEMPLATE: 'new_order_alert', PUBLIC_URL: 'https://aljawad.example/' };
const order = { id: 7, kind: 'order', type: 'delivery', items: [{ name: 'Mixed Grill', qty: 2, price: 12 }, { name: 'Kibbeh', qty: 1, price: 4 }], total: 28, name: 'Sara', phone: '03 123 456', address: 'Hamra, Bliss St', notes: 'No onions\nplease' };
const site = { name: 'Al Jawad', fmt: '$#' };
const pretendNetwork = (status = 200) => { const calls = []; const fetchFn = async (url, opt) => { calls.push({ url, ...opt, json: JSON.parse(opt.body) }); return { ok: status < 400, status }; }; return { calls, fetchFn }; };

test('the alert says what was ordered, the total, how, and who to call, on one line', () => {
  const w = describe(order, site);
  assert.match(w.text, /New order #7 at Al Jawad: 2 x Mixed Grill, 1 x Kibbeh\. Total \$28, delivery to Hamra, Bliss St\. Sara \(03 123 456\)\. Note: No onions please/);
  assert.doesNotMatch(w.text, /\n/);
  const b = describe({ id: 3, kind: 'book', service: 'Light peel', day: '2026-11-03', time: '10:00', name: 'Rima', phone: '70 111 222' }, site);
  assert.match(b.text, /appointment request #3 at Al Jawad: Light peel on 2026-11-03 at 10:00\. Rima/);
});

test('email goes to the owner through the email service, WhatsApp through the official template, each only when switched on', async () => {
  const { calls, fetchFn } = pretendNetwork();
  const n = createNotifier({ env: ENV, fetchFn });
  const r = await n.send({ site, order, settings: { whatsapp: '96171330440', whatsappOn: true, emailOn: true }, owners: [{ email: 'owner@example.com' }] });
  assert.deepEqual(r, { email: 'sent', whatsapp: 'sent' });
  const mail = calls.find((c) => c.url.includes('resend')); const wa = calls.find((c) => c.url.includes('graph.facebook'));
  assert.equal(mail.headers.Authorization, 'Bearer rk');
  assert.deepEqual(mail.json.to, ['owner@example.com']);
  assert.match(mail.json.text, /Open your panel: https:\/\/aljawad\.example\/panel/);
  assert.equal(wa.json.to, '96171330440');
  assert.equal(wa.json.template.name, 'new_order_alert');
  assert.match(wa.json.template.components[0].parameters[0].text, /New order #7/);
  // off means off
  calls.length = 0;
  assert.deepEqual(await n.send({ site, order, settings: { whatsapp: '96171330440', whatsappOn: false, emailOn: false }, owners: [{ email: 'owner@example.com' }] }), { email: 'off', whatsapp: 'off' });
  assert.equal(calls.length, 0);
});

test('without the service set up a channel says so honestly, and a failing service never throws', async () => {
  assert.deepEqual(channelsAvailable({}), { email: false, whatsapp: false });
  const a = await createNotifier({ env: {}, fetchFn: async () => { throw new Error('no'); } }).send({ site, order, settings: { whatsapp: '96171330440', whatsappOn: true, emailOn: true }, owners: [{ email: 'o@e.com' }] });
  assert.deepEqual(a, { email: 'not configured', whatsapp: 'not configured' });
  const logs = [];
  const b = await createNotifier({ env: ENV, fetchFn: async () => { throw new Error('network down'); }, log: (m) => logs.push(m) }).send({ site, order, settings: { whatsapp: '96171330440', whatsappOn: true, emailOn: true }, owners: [{ email: 'o@e.com' }] });
  assert.deepEqual(b, { email: 'failed', whatsapp: 'failed' });
  assert.equal(logs.length, 2);
  const c = await createNotifier({ env: ENV, fetchFn: pretendNetwork(500).fetchFn }).send({ site, order, settings: { emailOn: true }, owners: [{ email: 'o@e.com' }] });
  assert.equal(c.email, 'failed');
});

test('a business server alerts its own owner when an order arrives, the owner sets the alerts, and staff cannot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')); const dist = path.join(root, 'dist'); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'index.html'), 'x');
  const dir = path.join(root, 'data');
  const s = createStore(dir); s.registerSite({ id: 'al-jawad', name: 'Al Jawad', setupToken: 'tok', mode: 'order', catalog: [{ name: 'Hummus', price: 7 }], fulfil: ['pickup'], fmt: '$#', whatsapp: '96171330440' });
  assert.deepEqual(s.getAlerts('al-jawad'), { whatsapp: '96171330440', whatsappOn: true, emailOn: true }); // from the owner's form; email on by default
  s.close();
  const { calls, fetchFn } = pretendNetwork();
  const { server, store } = createOrdersServer({ dir, siteId: 'al-jawad', dist, notifier: createNotifier({ env: ENV, fetchFn }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b, h = {}) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  try {
    const setup = await post('/api/panel/setup', { token: 'tok', name: 'Rami', email: 'rami@example.com', password: 'long enough pass' });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/order', { type: 'pickup', name: 'Sara', phone: '03 123 456', items: [{ name: 'Hummus', qty: 2 }] })).status, 200);
    for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.map((c) => c.url.includes('resend') ? 'email' : 'wa').sort(), ['email', 'wa']);
    assert.deepEqual(calls.find((c) => c.url.includes('resend')).json.to, ['rami@example.com']); // only this business's owner
    // the owner's page
    const view = await (await fetch(base + '/api/panel/alerts', { headers: { cookie } })).json();
    assert.deepEqual([view.whatsappOn, view.emailOn, view.available.email, view.available.whatsapp], [true, true, true, true]);
    const saved = await (await post('/api/panel/alerts', { emailOn: false, whatsapp: '+961 71 330 440' }, { cookie })).json();
    assert.deepEqual([saved.emailOn, saved.whatsapp], [false, '+96171330440']);
    calls.length = 0;
    const t = await (await post('/api/panel/alerts/test', {}, { cookie })).json();
    assert.deepEqual(t.result, { email: 'off', whatsapp: 'sent' });
    assert.match(calls[0].json.template.components[0].parameters[0].text, /test alert/i);
    // staff may not see or change them
    await post('/api/panel/staff', { name: 'Hadi', email: 'hadi@example.com', password: 'another long pass' }, { cookie });
    const staffLogin = await post('/api/panel/login', { email: 'hadi@example.com', password: 'another long pass' });
    const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/panel/alerts', { headers: { cookie: staffCookie } })).status, 403);
    assert.equal((await post('/api/panel/alerts', { emailOn: true }, { cookie: staffCookie })).status, 403);
    assert.equal((await fetch(base + '/api/panel/alerts')).status, 401);
  } finally { server.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
