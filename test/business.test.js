import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';

// One business: its website, its panel and its orders on ONE address, with a database of its own.
let root; let dist; let one; let two; let baseOne; let baseTwo; const seen = [];
const SETUP = 'setup-token-abc';
const post = (base, url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-'));
  dist = path.join(root, 'dist-one'); fs.mkdirSync(path.join(dist, 'menu'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>Al Jawad</h1>'); fs.writeFileSync(path.join(dist, 'menu/index.html'), '<h1>Menu</h1>'); fs.writeFileSync(path.join(dist, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not for visitors');
  const dirOne = path.join(root, 'data', 'al-jawad'); const dirTwo = path.join(root, 'data', 'atelier');
  for (const [dir, id, name] of [[dirOne, 'al-jawad', 'Al Jawad'], [dirTwo, 'atelier', 'Atelier']]) {
    const s = createStore(dir);
    s.registerSite({ id, name, setupToken: SETUP, mode: 'order', catalog: [{ name: 'Hummus', price: 7 }], fulfil: ['pickup'], fmt: '$#' });
    s.close();
  }
  one = createOrdersServer({ dir: dirOne, siteId: 'al-jawad', dist, onOrder: (site, order) => seen.push([site, order.id]) });
  two = createOrdersServer({ dir: dirTwo, siteId: 'atelier', dist });
  await new Promise((r) => one.server.listen(0, '127.0.0.1', r)); await new Promise((r) => two.server.listen(0, '127.0.0.1', r));
  baseOne = `http://127.0.0.1:${one.server.address().port}`; baseTwo = `http://127.0.0.1:${two.server.address().port}`;
});
after(() => { one.server.close(); two.server.close(); one.store.close(); two.store.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('the website and the panel are on the same address', async () => {
  assert.match(await (await fetch(baseOne + '/')).text(), /Al Jawad/);
  assert.match(await (await fetch(baseOne + '/menu/')).text(), /Menu/);
  assert.equal((await fetch(baseOne + '/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  const panel = await fetch(baseOne + '/panel');
  assert.equal(panel.status, 200);
  const html = await panel.text();
  assert.match(html, /<title>Orders<\/title>/);
  assert.match(html, /var site = 'al-jawad'/); // the page knows which business it belongs to
  assert.equal((await fetch(baseOne + '/nothing-here')).status, 404);
});

test('visitors cannot read anything outside the website folder', async () => {
  for (const bad of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/menu/../../secret.txt']) {
    const r = await fetch(baseOne + bad);
    assert.notEqual(await r.text(), 'not for visitors', bad);
  }
});

test('an order is sent to the same address (no site id needed), appears in the business\'s own panel, and is kept', async () => {
  const placed = await post(baseOne, '/api/order', { type: 'pickup', name: 'Sara', phone: '03 123 456', items: [{ name: 'Hummus', qty: 3 }] });
  assert.equal(placed.status, 200);
  assert.equal((await placed.json()).total, 21);
  assert.deepEqual(seen.at(-1), ['al-jawad', 1]); // the notification hook was called
  const setup = await post(baseOne, '/api/panel/setup', { token: SETUP, name: 'Rami', email: 'rami@example.com', password: 'long enough pass' });
  assert.equal(setup.status, 200);
  const cookie = cookieOf(setup);
  const list = await (await fetch(baseOne + '/api/panel/orders', { headers: { cookie } })).json();
  assert.equal(list.site.name, 'Al Jawad');
  assert.equal(list.orders.length, 1);
  assert.equal((await (await post(baseOne, '/api/panel/orders/1', { status: 'accepted' }, { cookie })).json()).order.updatedBy, 'Rami');
});

test('each business is isolated: its orders, its accounts and its sessions never show in another', async () => {
  assert.equal(one.store.listOrders('al-jawad').length, 1);
  assert.equal(two.store.listOrders('atelier').length, 0);
  assert.equal(two.store.hasOwner('atelier'), false); // the other business has no account yet
  const state = await (await fetch(baseTwo + '/api/panel/state')).json();
  assert.deepEqual([state.name, state.needsSetup], ['Atelier', true]);
  // a session of the first business is no good on the second
  const cookie = cookieOf(await post(baseOne, '/api/panel/login', { email: 'rami@example.com', password: 'long enough pass' }));
  assert.equal((await fetch(baseTwo + '/api/panel/orders', { headers: { cookie } })).status, 401);
  // and its address knows no other site
  assert.equal((await fetch(baseOne + '/panel/atelier')).status, 404);
  assert.equal((await post(baseOne, '/api/order/atelier', { type: 'pickup', name: 'X', phone: '123456', items: [{ name: 'Hummus', qty: 1 }] })).status, 404);
});

test('a failing notification never loses the order', async () => {
  const dir = path.join(root, 'data', 'crash'); const s = createStore(dir);
  s.registerSite({ id: 'crash-test', name: 'C', setupToken: 'x', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  s.close();
  const c = createOrdersServer({ dir, siteId: 'crash-test', onOrder: () => { throw new Error('sms provider is down'); } });
  await new Promise((r) => c.server.listen(0, '127.0.0.1', r));
  try {
    const r = await post(`http://127.0.0.1:${c.server.address().port}`, '/api/order', { type: 'pickup', name: 'Ann', phone: '123456', items: [{ name: 'Tea', qty: 1 }] });
    assert.equal(r.status, 200);
    assert.equal(c.store.listOrders('crash-test').length, 1);
  } finally { c.server.close(); c.store.close(); }
});

test('the history is kept, newest first, and survives a restart; test orders from the shared development database can be moved in', () => {
  const shared = path.join(root, 'shared'); const s = createStore(shared);
  s.registerSite({ id: 'old-shop', name: 'Old', setupToken: 't', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  for (let i = 0; i < 3; i++) s.createOrder('old-shop', { type: 'pickup', name: `P${i}`, phone: '123456', items: [{ name: 'Tea', qty: 1 }] });
  s.close();
  const mine = createStore(path.join(root, 'data', 'old-shop'));
  assert.equal(mine.importSiteFrom(shared, 'old-shop'), 3);
  mine.registerSite({ id: 'old-shop', name: 'Old', setupToken: 't2', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  assert.deepEqual(mine.listOrders('old-shop').map((o) => o.name), ['P2', 'P1', 'P0']);
  mine.close();
  const again = createStore(path.join(root, 'data', 'old-shop'));
  assert.equal(again.listOrders('old-shop').length, 3);
  assert.equal(again.createOrder('old-shop', { type: 'pickup', name: 'P3', phone: '123456', items: [{ name: 'Tea', qty: 1 }] }).order.id, 4); // numbering carries on
  again.close();
});
