import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';

let srv; let base; let dir; let store;
const SETUP = 'setup-token-123';
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (url, headers = {}) => fetch(base + url, { headers });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
const order = { type: 'delivery', name: 'Sara', phone: '03 123 456', address: 'Hamra St', items: [{ name: 'Hummus', qty: 2 }, { name: 'Tabbouleh', qty: 1 }] };
const owner = { name: 'Rami', email: 'Rami@Example.com', password: 'correct horse' };
let ownerCookie;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-'));
  const made = createOrdersServer({ dir });
  store = made.store;
  store.registerSite({ id: 'shop-one', name: 'Al Jawad', setupToken: SETUP, mode: 'order', catalog: [{ name: 'Hummus', price: 7 }, { name: 'Tabbouleh', price: 8.5 }, { name: 'Free sample', price: 0 }], fulfil: ['delivery', 'pickup'], deliveryFee: 2, fmt: '$#' });
  store.registerSite({ id: 'salon-one', name: 'Atelier', setupToken: SETUP, mode: 'book', catalog: [{ name: 'Haircut', price: 0 }], fulfil: [] });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  srv = made.server; base = `http://127.0.0.1:${made.server.address().port}`;
  // the owner of the salon, for the appointment test
  await post('/api/panel/salon-one/setup', { token: SETUP, ...owner });
});
after(() => { srv.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------- orders from visitors ----------
test('an order is priced by the service, never by the visitor (the delivery fee is added for delivery only)', async () => {
  const r = await post('/api/order/shop-one', { ...order, items: [{ name: 'Hummus', qty: 2, price: 0.01 }, { name: 'Tabbouleh', qty: 1 }], total: 1 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).total, 24.5); // 14 + 8.5 + 2
  assert.equal((await (await post('/api/order/shop-one', { ...order, type: 'pickup', address: '' })).json()).total, 22.5);
});

test('an order with an unknown item, a free item, a bad quantity, no address or no way to get it is refused with a message', async () => {
  for (const bad of [{ items: [{ name: 'Pizza', qty: 1 }] }, { items: [{ name: 'Free sample', qty: 1 }] }, { items: [{ name: 'Hummus', qty: 0 }] }, { items: [{ name: 'Hummus', qty: 99 }] }, { address: '' }, { type: 'drone' }, { name: '' }, { phone: '12' }, { items: [] }]) {
    const r = await post('/api/order/shop-one', { ...order, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok((await r.json()).error);
  }
});

test('a site that does not exist takes no orders, and the browser may call it from another address', async () => {
  assert.equal((await post('/api/order/nobody', order)).status, 404);
  const pre = await fetch(base + '/api/order/shop-one', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('the hidden field catches bots: they get a friendly answer and nothing is saved', async () => {
  const before = store.listOrders('shop-one').length;
  assert.equal((await post('/api/order/shop-one', { ...order, website: 'http://spam' })).status, 200);
  assert.equal(store.listOrders('shop-one').length, before);
});

// ---------- accounts ----------
test('before setup the page says it needs setup; the setup link creates the owner once, a wrong token never does', async () => {
  const s0 = await (await get('/api/panel/shop-one/state')).json();
  assert.equal(s0.needsSetup, true);
  assert.equal(s0.signedIn, false);
  assert.equal((await post('/api/panel/shop-one/setup', { token: 'wrong', ...owner })).status, 403);
  assert.equal((await post('/api/panel/shop-one/setup', { token: SETUP, name: 'Rami', email: 'not-an-email', password: 'correct horse' })).status, 400);
  assert.equal((await post('/api/panel/shop-one/setup', { token: SETUP, ...owner, password: 'short' })).status, 400);
  const ok = await post('/api/panel/shop-one/setup', { token: SETUP, ...owner });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /ps_shop-one=.*HttpOnly.*SameSite=Strict/);
  ownerCookie = cookieOf(ok);
  assert.equal((await post('/api/panel/shop-one/setup', { token: SETUP, name: 'Mallory', email: 'm@example.com', password: 'another one' })).status, 403); // the link works once
  const s1 = await (await get('/api/panel/shop-one/state', { cookie: ownerCookie })).json();
  assert.deepEqual([s1.needsSetup, s1.signedIn], [false, true]);
});

test('passwords are never stored: only a salted hash in the database', () => {
  const db = new DatabaseSync(path.join(dir, 'orders.db'));
  const rows = db.prepare('SELECT password_hash, email FROM users').all();
  db.close();
  assert.ok(rows.length >= 1);
  for (const r of rows) { assert.match(r.password_hash, /^scrypt\$/); assert.doesNotMatch(r.password_hash, /correct horse/); assert.equal(r.email, r.email.toLowerCase()); }
});

test('sign-in needs the right email and password; a wrong try says the same thing for a wrong email or a wrong password', async () => {
  const noEmail = await post('/api/panel/shop-one/login', { email: 'nobody@example.com', password: 'correct horse' });
  const noPass = await post('/api/panel/shop-one/login', { email: 'rami@example.com', password: 'wrong password' });
  assert.equal(noEmail.status, 401); assert.equal(noPass.status, 401);
  assert.equal((await noEmail.json()).error, (await noPass.json()).error);
  const ok = await post('/api/panel/shop-one/login', { email: 'RAMI@example.com', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /ps_shop-one=/);
});

test('the orders need a signed-in person: no cookie, a cookie of another site and a changed status without one are refused', async () => {
  assert.equal((await get('/api/panel/shop-one/orders')).status, 401);
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: 'ps_shop-one=nonsense' })).status, 401);
  assert.equal((await get('/api/panel/salon-one/orders', { cookie: ownerCookie })).status, 401); // shop-one's session is no good on salon-one
  assert.equal((await post('/api/panel/shop-one/orders/1', { status: 'accepted' })).status, 401);
});

test('the owner sees the orders (newest first) and moves them along; a status that does not fit is refused', async () => {
  const list = await (await get('/api/panel/shop-one/orders', { cookie: ownerCookie })).json();
  assert.equal(list.site.name, 'Al Jawad');
  assert.ok(list.orders.length >= 2 && list.orders[0].id > list.orders[1].id);
  const id = list.orders[0].id;
  const moved = (await (await post(`/api/panel/shop-one/orders/${id}`, { status: 'accepted' }, { cookie: ownerCookie })).json()).order;
  assert.equal(moved.status, 'accepted');
  assert.equal(moved.updatedBy, 'Rami'); // who did it
  assert.equal((await post(`/api/panel/shop-one/orders/${id}`, { status: 'confirmed' }, { cookie: ownerCookie })).status, 400); // a booking status on an order
  assert.equal((await post('/api/panel/shop-one/orders/9999', { status: 'done' }, { cookie: ownerCookie })).status, 400);
});

test('staff: the owner adds a person, who can handle orders but not manage people; the owner can remove them', async () => {
  const add = await post('/api/panel/shop-one/staff', { name: 'Lina', email: 'lina@example.com', password: 'staff password' }, { cookie: ownerCookie });
  assert.equal(add.status, 200);
  const lina = (await add.json()).user;
  assert.equal(lina.role, 'staff');
  assert.equal((await post('/api/panel/shop-one/staff', { name: 'Lina 2', email: 'LINA@example.com', password: 'staff password' }, { cookie: ownerCookie })).status, 400); // same email
  const linaCookie = cookieOf(await post('/api/panel/shop-one/login', { email: 'lina@example.com', password: 'staff password' }));
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: linaCookie })).status, 200);
  assert.equal((await get('/api/panel/shop-one/staff', { cookie: linaCookie })).status, 403);
  assert.equal((await post('/api/panel/shop-one/staff', { name: 'X', email: 'x@example.com', password: 'whatever one' }, { cookie: linaCookie })).status, 403);
  const list = (await (await get('/api/panel/shop-one/staff', { cookie: ownerCookie })).json()).users;
  assert.deepEqual(list.map((u) => u.role), ['owner', 'staff']);
  const owners = list.filter((u) => u.role === 'owner');
  assert.equal((await post(`/api/panel/shop-one/staff/${owners[0].id}/remove`, {}, { cookie: ownerCookie })).status, 400); // never the owner
  assert.equal((await post(`/api/panel/shop-one/staff/${lina.id}/remove`, {}, { cookie: ownerCookie })).status, 200);
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: linaCookie })).status, 401); // removed people are signed out
});

test('a forgotten password: the owner makes a one-time link, the new password works, the old one and old sessions do not', async () => {
  await post('/api/panel/shop-one/staff', { name: 'Omar', email: 'omar@example.com', password: 'old password 1' }, { cookie: ownerCookie });
  const omar = (await (await get('/api/panel/shop-one/staff', { cookie: ownerCookie })).json()).users.find((u) => u.email === 'omar@example.com');
  const oldCookie = cookieOf(await post('/api/panel/shop-one/login', { email: 'omar@example.com', password: 'old password 1' }));
  const link = await (await post(`/api/panel/shop-one/staff/${omar.id}/reset`, {}, { cookie: ownerCookie })).json();
  const token = link.path.split('#reset=')[1];
  assert.ok(token && token.length > 20);
  assert.equal((await post('/api/panel/shop-one/reset', { token: 'nope', password: 'new password 2' })).status, 403);
  assert.equal((await post('/api/panel/shop-one/reset', { token, password: 'short' })).status, 400);
  const done = await post('/api/panel/shop-one/reset', { token, password: 'new password 2' });
  assert.equal(done.status, 200);
  assert.equal((await post('/api/panel/shop-one/reset', { token, password: 'new password 3' })).status, 403); // once
  assert.equal((await post('/api/panel/shop-one/login', { email: 'omar@example.com', password: 'old password 1' })).status, 401);
  assert.equal((await post('/api/panel/shop-one/login', { email: 'omar@example.com', password: 'new password 2' })).status, 200);
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: oldCookie })).status, 401);
});

test('a person can change their own password (the old one is needed)', async () => {
  assert.equal((await post('/api/panel/shop-one/password', { old: 'wrong', password: 'brand new pass' }, { cookie: ownerCookie })).status, 400);
  assert.equal((await post('/api/panel/shop-one/password', { old: 'correct horse', password: 'short' }, { cookie: ownerCookie })).status, 400);
  assert.equal((await post('/api/panel/shop-one/password', { old: 'correct horse', password: 'brand new pass' }, { cookie: ownerCookie })).status, 200);
  assert.equal((await post('/api/panel/shop-one/login', { email: 'rami@example.com', password: 'brand new pass' })).status, 200);
});

test('signing out ends the session', async () => {
  const c = cookieOf(await post('/api/panel/shop-one/login', { email: 'rami@example.com', password: 'brand new pass' }));
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: c })).status, 200);
  await post('/api/panel/shop-one/logout', {}, { cookie: c });
  assert.equal((await get('/api/panel/shop-one/orders', { cookie: c })).status, 401);
});

test('appointment requests: a listed service, a real day and a time; the owner confirms them', async () => {
  const cookie = cookieOf(await post('/api/panel/salon-one/login', { email: owner.email, password: owner.password }));
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const good = { service: 'Haircut', day, time: '15:30', name: 'Sara', phone: '03 123 456' };
  assert.equal((await post('/api/order/salon-one', good)).status, 200);
  for (const bad of [{ service: 'Surgery' }, { day: '2001-01-01' }, { day: 'soon' }, { time: '3pm' }]) assert.equal((await post('/api/order/salon-one', { ...good, ...bad })).status, 400, JSON.stringify(bad));
  const list = await (await get('/api/panel/salon-one/orders', { cookie })).json();
  assert.equal(list.orders[0].kind, 'book');
  assert.equal((await (await post(`/api/panel/salon-one/orders/${list.orders[0].id}`, { status: 'confirmed' }, { cookie })).json()).order.status, 'confirmed');
});

test('the panel page opens for a real site only', async () => {
  const page = await get('/panel/shop-one');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Orders<\/title>/);
  assert.equal((await get('/panel/nobody')).status, 404);
});

// ---------- the database ----------
test('orders and accounts survive a restart of the service', () => {
  const again = createStore(dir);
  assert.ok(again.listOrders('shop-one').length >= 2);
  assert.equal(again.hasOwner('shop-one'), true);
  assert.ok(again.sessionUser('shop-one', undefined) === null);
  again.close();
});

test('a database made by the first version (JSON files) is imported, and its old key still works once as the setup link', () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-old-'));
  fs.mkdirSync(path.join(old, 'sites')); fs.mkdirSync(path.join(old, 'orders'));
  const keyHash = crypto.createHash('sha256').update('old-key').digest('hex');
  fs.writeFileSync(path.join(old, 'sites/old-site.json'), JSON.stringify({ id: 'old-site', name: 'Old', keyHash, mode: 'order', catalog: [{ name: 'Tea', price: 3 }], fulfil: ['pickup'], deliveryFee: 0, fmt: '$#' }));
  fs.writeFileSync(path.join(old, 'orders/old-site.json'), JSON.stringify({ next: 2, orders: [{ id: 1, at: '2026-01-01T10:00:00.000Z', status: 'done', kind: 'order', type: 'pickup', items: [{ name: 'Tea', qty: 1, price: 3 }], total: 3, name: 'Ann', phone: '123456' }] }));
  const s = createStore(old);
  assert.equal(s.getSite('old-site').name, 'Old');
  assert.equal(s.listOrders('old-site')[0].name, 'Ann');
  assert.equal(s.createOrder('old-site', { type: 'pickup', name: 'Bob', phone: '987654', items: [{ name: 'Tea', qty: 2 }] }).order.id, 2);
  assert.ok(s.createOwner('old-site', { token: 'old-key', name: 'Olga', email: 'olga@example.com', password: 'long enough' }).user);
  s.close(); fs.rmSync(old, { recursive: true, force: true });
});

// ---------- protection ----------
test('too large a request is refused', async () => {
  assert.equal((await post('/api/order/shop-one', { ...order, notes: 'x'.repeat(40000) })).status, 413);
});

test('too many orders from one device in a short time are slowed down', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post('/api/order/shop-one', order)).status;
  assert.equal(last, 429);
});

test('too many wrong sign-ins from one device lock it out for a while (even with the right password)', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post('/api/panel/shop-one/login', { email: 'rami@example.com', password: `wrong ${i}` })).status;
  assert.equal(last, 429);
  assert.equal((await post('/api/panel/shop-one/login', { email: 'rami@example.com', password: 'brand new pass' })).status, 429);
});

test('setup and reset links are letters and digits only, and a failed setup says why (wrong or cut-off link, or already used)', async () => {
  const { newToken } = await import('../src/server/orders/store.js');
  for (let i = 0; i < 50; i++) assert.match(newToken(), /^[0-9a-f]{48}$/);
  const s = createStore(path.join(dir, 'why'));
  s.registerSite({ id: 'why-site', name: 'W', setupToken: 'abcdef123456', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  const cut = s.createOwner('why-site', { token: 'abcdef12345', name: 'A', email: 'a@example.com', password: 'long enough pass' }); // the last character lost
  assert.equal(cut.status, 403); assert.match(cut.error, /incomplete or not right/);
  assert.ok(s.createOwner('why-site', { token: 'abcdef123456', name: 'A', email: 'a@example.com', password: 'long enough pass' }).user);
  const again = s.createOwner('why-site', { token: 'abcdef123456', name: 'B', email: 'b@example.com', password: 'long enough pass' });
  assert.match(again.error, /already created/);
  s.close();
});

// ---------- the owner's business is the owner's: nobody else can get into the account ----------
test('the owner gets a recovery code once, and with it (and only it) can reset their own password', async () => {
  const s = createStore(path.join(dir, 'recover'));
  s.registerSite({ id: 'rec-site', name: 'R', setupToken: 'tok-rec-1', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  const made = s.createOwner('rec-site', { token: 'tok-rec-1', name: 'Rami', email: 'rami@example.com', password: 'first password 1' });
  assert.match(made.recoveryCode, /^([0-9a-f]{4}-){4}[0-9a-f]{4}$/);
  const db = new DatabaseSync(path.join(dir, 'recover', 'orders.db'));
  const stored = db.prepare('SELECT recovery_hash FROM users').get().recovery_hash;
  db.close();
  assert.doesNotMatch(stored, /[0-9a-f]{4}-/); // only a hash is kept, never the code
  const oldSession = s.login('rec-site', 'rami@example.com', 'first password 1');

  assert.equal(s.recoverOwner('rec-site', 'rami@example.com', 'aaaa-bbbb-cccc-dddd-eeee', 'new password 22').status, 403); // a wrong code
  assert.equal(s.recoverOwner('rec-site', 'nobody@example.com', made.recoveryCode, 'new password 22').status, 403); // a wrong email
  assert.ok(s.recoverOwner('rec-site', 'rami@example.com', 'x', 'short').error); // a short password
  const done = s.recoverOwner('rec-site', 'RAMI@example.com', made.recoveryCode.toUpperCase(), 'new password 22'); // case and dashes do not matter
  assert.ok(done.token && done.recoveryCode && done.recoveryCode !== made.recoveryCode);
  assert.equal(s.sessionUser('rec-site', oldSession), null); // everyone signed in with the old password is out
  assert.ok(s.login('rec-site', 'rami@example.com', 'new password 22'));
  assert.equal(s.login('rec-site', 'rami@example.com', 'first password 1'), null);
  assert.equal(s.recoverOwner('rec-site', 'rami@example.com', made.recoveryCode, 'another one 333').status, 403); // each code works once
  assert.ok(s.recoverOwner('rec-site', 'rami@example.com', done.recoveryCode, 'another one 333').token); // the new code does

  // staff have no recovery code (the owner resets them), and a reset link can never be made for an owner by the team's tools
  s.addStaff('rec-site', { name: 'Lina', email: 'lina@example.com', password: 'staff password' });
  assert.equal(s.recoverOwner('rec-site', 'lina@example.com', done.recoveryCode, 'staff new pass 1').status, 403);
  s.close();
});

test('over the web: setup shows the code, recovery works, wrong tries are limited, and a signed-in owner can renew the code', async () => {
  const s = createStore(path.join(dir, 'web-recover'));
  s.registerSite({ id: 'web-rec', name: 'W', setupToken: 'tok-web-1', mode: 'order', catalog: [{ name: 'Tea', price: 2 }], fulfil: ['pickup'] });
  s.close();
  const made = createOrdersServer({ dir: path.join(dir, 'web-recover') });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${made.server.address().port}`;
  const j = (u, body, h = {}) => fetch(b + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
  try {
    const su = await j('/api/panel/web-rec/setup', { token: 'tok-web-1', name: 'Rami', email: 'rami@example.com', password: 'first password 1' });
    const first = (await su.json()).recoveryCode;
    assert.ok(first);
    const cookie = su.headers.get('set-cookie').split(';')[0];
    const renewed = await (await j('/api/panel/web-rec/recovery-code', { password: 'first password 1' }, { cookie })).json();
    assert.ok(renewed.recoveryCode && renewed.recoveryCode !== first);
    assert.equal((await j('/api/panel/web-rec/recovery-code', { password: 'wrong' }, { cookie })).status, 400);
    assert.equal((await j('/api/panel/web-rec/recover', { email: 'rami@example.com', code: first, password: 'new password 22' })).status, 403); // the old code stopped working
    const ok = await j('/api/panel/web-rec/recover', { email: 'rami@example.com', code: renewed.recoveryCode, password: 'new password 22' });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).recoveryCode);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await j('/api/panel/web-rec/recover', { email: 'rami@example.com', code: `0000-0000-0000-0000-00${i}`, password: 'new password 22' })).status;
    assert.equal(last, 429); // guessing a code is locked out
  } finally { made.server.close(); made.store.close(); }
});

test('privacy: the team\'s own tools and pages have no way into a business\'s orders, customers or accounts', () => {
  const tool = fs.readFileSync(new URL('../tools/panel-link.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['createReset', 'listUsers', 'listOrders', 'login(', 'sessionUser', 'recoverOwner', 'createOrder']) assert.ok(!tool.includes(forbidden), `panel-link.mjs must not use ${forbidden}`);
  for (const file of ['../src/server/customer-public/index.html']) {
    const code = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const forbidden of ['listOrders', 'listUsers', 'orders.db', 'createReset']) assert.ok(!code.includes(forbidden), `${file} must not use ${forbidden}`);
  }
});
