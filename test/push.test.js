import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';
import { createPusher, cleanSubscription } from '../src/server/orders/push.js';

// a pretend push service: it records what it was asked to send and can answer "gone" for chosen devices
const pretend = (gone = []) => { const sent = []; return { sent, generateVAPIDKeys: webpush.generateVAPIDKeys, sendNotification: async (sub, body, opt) => { if (gone.includes(sub.endpoint)) { const e = new Error('gone'); e.statusCode = 410; throw e; } sent.push({ endpoint: sub.endpoint, body: JSON.parse(body), opt }); } }; };
const sub = (n) => ({ endpoint: `https://push.example.com/send/device-${n}-abcdefghij`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

test('a subscription is only kept when it looks like a real browser one', () => {
  assert.ok(cleanSubscription(sub(1)));
  assert.equal(cleanSubscription({ endpoint: 'http://insecure.example.com/x', keys: sub(1).keys }), null);
  assert.equal(cleanSubscription({ endpoint: sub(1).endpoint, keys: { p256dh: 'x', auth: 'y' } }), null);
  assert.equal(cleanSubscription(null), null);
});

test('the alert carries only that something is new: never a name, phone, address or item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-')); const store = createStore(path.join(root, 'd'));
  try {
    store.registerSite({ id: 'al-jawad', name: 'Al Jawad', setupToken: 't', mode: 'order', catalog: [{ name: 'Hummus', price: 7 }], fulfil: ['pickup'], fmt: '$#' });
    const owner = store.createOwner('al-jawad', { token: 't', name: 'Rami', email: 'rami@example.com', password: 'long enough pass' });
    const fake = pretend(); const p = createPusher({ store, webpush: fake });
    store.addPush(store.listUsers('al-jawad')[0].id, sub(1));
    const w = p.words('order', 'Al Jawad', 7);
    assert.deepEqual(await p.send('al-jawad', w), { sent: 1, failed: 0, removed: 0 });
    assert.equal(fake.sent[0].body.title, 'New order');
    assert.match(fake.sent[0].body.body, /Al Jawad: #7/);
    assert.equal(p.words('book', 'Layla', 3).title, 'New appointment request');
    // the same keys every time (made once, kept in this business's own database)
    assert.equal(p.publicKey(), p.publicKey()); assert.equal(createPusher({ store, webpush: fake }).publicKey(), p.publicKey());
    assert.ok(owner);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a device that is gone (the browser says 410) is forgotten; one business never alerts another business\'s devices', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push2-'));
  const a = createStore(path.join(root, 'a')); const b = createStore(path.join(root, 'b'));
  try {
    for (const [s, id] of [[a, 'one'], [b, 'two']]) { s.registerSite({ id, name: id, setupToken: 't', mode: 'order', catalog: [{ name: 'X', price: 1 }], fulfil: ['pickup'], fmt: '#' }); s.createOwner(id, { token: 't', name: 'O', email: `${id}@example.com`, password: 'long enough pass' }); }
    a.addPush(a.listUsers('one')[0].id, sub(1)); a.addPush(a.listUsers('one')[0].id, sub(2)); b.addPush(b.listUsers('two')[0].id, sub(3));
    const fake = pretend([sub(2).endpoint]);
    assert.deepEqual(await createPusher({ store: a, webpush: fake }).send('one', { title: 't', body: 'b' }), { sent: 1, failed: 0, removed: 1 });
    assert.deepEqual(a.listPush('one').map((x) => x.endpoint), [sub(1).endpoint]); // the gone device was removed
    assert.deepEqual(fake.sent.map((x) => x.endpoint), [sub(1).endpoint]); // never the other business's device
    assert.equal(a.getSetting('vapid') !== b.getSetting('vapid'), true); // each business has its own keys
  } finally { a.close(); b.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('signed-in people turn alerts on and off for their own device; an order alerts the devices; visitors cannot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push3-')); const dist = path.join(root, 'dist'); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'index.html'), 'x');
  const dir = path.join(root, 'data');
  const s0 = createStore(dir); s0.registerSite({ id: 'al-jawad', name: 'Al Jawad', setupToken: 'tok', mode: 'order', catalog: [{ name: 'Hummus', price: 7 }], fulfil: ['pickup'], fmt: '$#' }); s0.close();
  const fake = pretend();
  const made = createOrdersServer({ dir, siteId: 'al-jawad', dist, notifier: { send: async () => ({}), available: () => ({}) }, makePusher: (st) => createPusher({ store: st, webpush: fake }) });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const post = (u, b, h = {}) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  try {
    const setup = await post('/api/panel/setup', { token: 'tok', name: 'Rami', email: 'rami@example.com', password: 'long enough pass' });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/panel/push')).status, 401);
    assert.equal((await post('/api/panel/push', { subscription: sub(1) })).status, 401); // a visitor cannot register a device
    const key = (await (await fetch(base + '/api/panel/push', { headers: { cookie } })).json()).key;
    assert.ok(key && key.length > 60);
    assert.equal((await post('/api/panel/push', { subscription: { endpoint: 'nope' } }, { cookie })).status, 400);
    assert.equal((await post('/api/panel/push', { subscription: sub(1) }, { cookie })).status, 200);
    const sw = await fetch(base + '/panel-sw.js');
    assert.equal(sw.headers.get('service-worker-allowed'), '/panel');
    assert.doesNotMatch(await sw.text(), /addEventListener\('fetch'/); // it never touches the pages
    assert.equal((await post('/api/order', { type: 'pickup', name: 'Sara', phone: '03 123 456', items: [{ name: 'Hummus', qty: 2 }] })).status, 200);
    for (let i = 0; i < 50 && !fake.sent.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(fake.sent[0].body), /Sara|03 123|Hummus/); // nothing about the customer leaves the server
    const test = await (await post('/api/panel/push/test', {}, { cookie })).json();
    assert.equal(test.result.sent, 1);
    await post('/api/panel/push/remove', { endpoint: sub(1).endpoint }, { cookie });
    fake.sent.length = 0;
    assert.equal((await post('/api/panel/push/test', {}, { cookie })).status, 200);
    assert.equal(fake.sent.length, 0); // turned off: nothing more is sent
  } finally { made.server.close(); made.store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
