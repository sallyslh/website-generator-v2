import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';

// A small built website (the base copy): two pages, a logo, texts, a picture, and a footer both pages show.
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/"><img data-e="site.logo" src="/images/logo.webp" alt="Logo"></a></header><main>${body}</main><footer><span data-e="shared-footer.0">Open daily 10 to 10</span></footer></body></html>`;
const HOME = page('Home', '<h1 data-e="home.0">Welcome to Cedar House</h1><p data-e="home.1">We serve food.</p><img data-e="home.img0" src="/images/a.webp" alt="A plate"><a href="/menu/" data-e="home.2">See the menu</a>');
const MENU = page('Menu', '<h1 data-e="menu.0">Our menu</h1>');

let root; let dist; let one; let two; let baseOne; let baseTwo; let owner; let staff;
const post = (base, url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (url, headers = {}, base = baseOne) => fetch(base + url, { headers, redirect: 'manual' });
const api = (p) => `/api/panel/${p}`;
const edit = (sub) => `/api/panel/ed-one/edit/${sub}`;
const png = (color = '#ff0000') => sharp({ create: { width: 24, height: 16, channels: 3, background: color } }).png().toBuffer();
const sha = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-'));
  dist = path.join(root, 'dist'); fs.mkdirSync(path.join(dist, 'menu'), { recursive: true }); fs.mkdirSync(path.join(dist, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), HOME); fs.writeFileSync(path.join(dist, 'menu/index.html'), MENU); fs.writeFileSync(path.join(dist, 'images/a.webp'), 'a');
  for (const [name, d] of [['ed-one', 'one'], ['ed-two', 'two']]) {
    const s = createStore(path.join(root, d)); s.registerSite({ id: name, name: 'Cedar', setupToken: `tok-${d}`, mode: 'order', catalog: [], fulfil: [] }); s.close();
  }
  one = createOrdersServer({ dir: path.join(root, 'one'), siteId: 'ed-one', dist }); two = createOrdersServer({ dir: path.join(root, 'two'), siteId: 'ed-two', dist });
  await new Promise((r) => one.server.listen(0, '127.0.0.1', r)); await new Promise((r) => two.server.listen(0, '127.0.0.1', r));
  baseOne = `http://127.0.0.1:${one.server.address().port}`; baseTwo = `http://127.0.0.1:${two.server.address().port}`;
  owner = (await post(baseOne, '/api/panel/setup', { token: 'tok-one', name: 'Rami', email: 'rami@example.com', password: 'long enough pass' })).headers.get('set-cookie').split(';')[0];
  await post(baseOne, '/api/panel/staff', { name: 'Lina', email: 'lina@example.com', password: 'staff password' }, { cookie: owner });
  staff = (await post(baseOne, '/api/panel/login', { email: 'lina@example.com', password: 'staff password' })).headers.get('set-cookie').split(';')[0];
});
after(() => { one.server.close(); two.server.close(); one.store.close(); two.store.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('only the owner can edit: nobody, staff and a visitor are all refused, and the panel tells the owner the website is editable', async () => {
  for (const [method, sub, body] of [['GET', 'state'], ['POST', 'text', { key: 'home.0', value: 'x' }], ['POST', 'undo', { key: 'home.0' }], ['POST', 'revert-all', {}], ['PUT', 'image?key=home.img0&alt=abc', null]]) {
    const call = (cookie) => fetch(baseOne + edit(sub), { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined || body === null ? undefined : JSON.stringify(body) });
    assert.equal((await call()).status, 401, `${sub} without an account`);
    assert.equal((await call(staff)).status, 403, `${sub} as staff`);
  }
  assert.equal((await (await get(api('ed-one/me'), { cookie: owner })).json()).site.editable, true);
  assert.equal((await (await get(api('ed-one/me'), { cookie: staff })).json()).site.editable, true); // the flag is about the site; the button is for owners only (panel)
});

test('the editor knows the pages of the website and starts with no changes', async () => {
  const s = await (await get(edit('state'), { cookie: owner })).json();
  assert.deepEqual(s.pages.map((p) => p.route), ['/', '/menu/']);
  assert.deepEqual([s.ready, s.changes.length], [true, 0]);
});

test('a text change shows to every visitor at once, on every page that has it, and the base copy on disk never changes', async () => {
  const baseHome = sha(path.join(dist, 'index.html')); const baseMenu = sha(path.join(dist, 'menu/index.html'));
  const s = await (await post(baseOne, edit('text'), { key: 'home.0', value: '  Welcome to our   new place  ' }, { cookie: owner })).json();
  assert.deepEqual(s.changes.map((c) => [c.key, c.before, c.after]), [['home.0', 'Welcome to Cedar House', 'Welcome to our new place']]);
  const home = await (await get('/')).text(); // a visitor, no sign-in
  assert.match(home, /<h1 data-e="home\.0">Welcome to our new place<\/h1>/);
  assert.match(home, /<p data-e="home\.1">We serve food\.<\/p>/); // everything else is as it was
  await post(baseOne, edit('text'), { key: 'shared-footer.0', value: 'Open daily 9 to 11' }, { cookie: owner });
  for (const route of ['/', '/menu/']) assert.match(await (await get(route)).text(), /Open daily 9 to 11/); // the footer is on both pages
  assert.equal(sha(path.join(dist, 'index.html')), baseHome); assert.equal(sha(path.join(dist, 'menu/index.html')), baseMenu); // the base copy is untouched
});

test('what the owner types is only text: markup is escaped, empty or too long text and unknown parts are refused with a clear message', async () => {
  const t = (key, value) => post(baseOne, edit('text'), { key, value }, { cookie: owner });
  await t('home.1', '<script>alert(1)</script> & more');
  const html = await (await get('/')).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/); assert.doesNotMatch(html, /<script>alert/);
  assert.equal((await t('home.1', '   ')).status, 400);
  assert.equal((await t('home.1', 'x'.repeat(601))).status, 400);
  assert.equal((await t('nonsense key', 'x')).status, 404);
  assert.equal((await t('home.99', 'x')).status, 404); // a part that is not on the website
  assert.equal((await t('home.img0', 'x')).status, 400); // a picture cannot be changed as text
});

test('every change can be undone, one step at a time, back to the original', async () => {
  const text = async () => (await (await get('/')).text()).match(/<p data-e="home\.1">([^<]*)<\/p>/)[1];
  await post(baseOne, edit('text'), { key: 'home.1', value: 'Second version' }, { cookie: owner });
  await post(baseOne, edit('text'), { key: 'home.1', value: 'Third version' }, { cookie: owner });
  assert.equal(await text(), 'Third version');
  await post(baseOne, edit('undo'), { key: 'home.1' }, { cookie: owner }); assert.equal(await text(), 'Second version');
  await post(baseOne, edit('undo'), { key: 'home.1' }, { cookie: owner });
  const s = await (await post(baseOne, edit('undo'), { key: 'home.1' }, { cookie: owner })).json();
  assert.equal(await text(), 'We serve food.'); // the original
  assert.equal(s.changes.some((c) => c.key === 'home.1'), false);
  assert.equal((await post(baseOne, edit('undo'), { key: 'home.1' }, { cookie: owner })).status, 404); // nothing left to undo
});

test('a new picture: made web-sized, shown on the page, served from the business\'s own folder; a logo changes on every page', async () => {
  const put = (key, alt, bytes) => fetch(baseOne + edit(`image?key=${key}&alt=${encodeURIComponent(alt)}`), { method: 'PUT', headers: { cookie: owner }, body: bytes });
  assert.equal((await put('home.img0', 'x', await png())).status, 400); // a description is needed
  assert.equal((await put('home.img0', 'A new plate', Buffer.from('not a picture'))).status, 400);
  assert.equal((await put('home.img0', 'A new plate', Buffer.alloc(7 * 1024 * 1024))).status, 413);
  const s = await (await put('home.img0', 'A new plate', await png())).json();
  const src = s.changes.find((c) => c.key === 'home.img0').picture;
  assert.match(src, /^\/images\/edit-[0-9a-f]{10}\.webp$/);
  assert.match(await (await get('/')).text(), new RegExp(`<img data-e="home\\.img0" src="${src.replace(/[./]/g, '\\$&')}" alt="A new plate">`));
  const served = await get(src);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format, 'webp');
  assert.equal((await get('/images/edit-0123456789.webp')).status, 404); // a name that is not an upload
  assert.equal((await get('/images/edit-..%2f..%2fsecret.webp')).status, 404);
  const logo = await (await put('site.logo', 'Our new logo', await png('#0000ff'))).json();
  const logoSrc = logo.changes.find((c) => c.key === 'site.logo').picture;
  for (const route of ['/', '/menu/']) assert.match(await (await get(route)).text(), new RegExp(`src="${logoSrc.replace(/[./]/g, '\\$&')}"`));
  assert.equal(fs.existsSync(path.join(dist, 'images', path.basename(src))), false); // the base copy gets no new files
});

test('the owner can look at the original (base copy) and open the editing mode; nobody else can', async () => {
  const edited = await (await get('/')).text(); assert.doesNotMatch(edited, /edit-overlay/);
  const original = await (await get('/?original=1', { cookie: owner })).text();
  assert.match(original, /Welcome to Cedar House/); assert.match(original, /src="\/images\/a\.webp"/); // as built
  assert.match(await (await get('/?original=1')).text(), /Welcome to our new place/); // a visitor always sees the current website
  const editing = await get('/?edit=1', { cookie: owner });
  const html = await editing.text();
  assert.match(html, /<script src="\/edit-overlay\.js" data-api="\/api\/panel\/ed-one\/edit\/" data-prefix="\/" data-owner="1" data-done="\/panel"><\/script><\/body>/);
  for (const cookie of [undefined, staff]) { const r = await get('/?edit=1', cookie ? { cookie } : {}); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/panel'); }
  const overlay = await get('/edit-overlay.js');
  assert.equal(overlay.status, 200); const js = await overlay.text();
  assert.match(js, /data-owner/); assert.match(js, /data-api/);
});

test('restoring everything puts the website back exactly as it was built', async () => {
  const s = await (await post(baseOne, edit('revert-all'), {}, { cookie: owner })).json();
  assert.equal(s.changes.length, 0);
  assert.equal(await (await get('/')).text(), HOME); assert.equal(await (await get('/menu/')).text(), MENU);
});

test('after a rebuild an edit follows its text to its new number, is never put on a different text, and the owner is told when it was lost', async () => {
  const served = async () => (await get('/')).text();
  assert.equal((await post(baseOne, edit('text'), { key: 'home.1', value: 'We serve great food.' }, { cookie: owner })).status, 200);
  assert.match(await served(), /data-e="home\.1">We serve great food\./);
  try {
    // the rebuilt website has one more text before it: "We serve food." is now home.2
    fs.writeFileSync(path.join(dist, 'index.html'), page('Home', '<h1 data-e="home.0">Welcome to Cedar House</h1><p data-e="home.1">A brand new line.</p><p data-e="home.2">We serve food.</p><a href="/menu/" data-e="home.3">See the menu</a>'));
    const moved = await served();
    assert.match(moved, /data-e="home\.1">A brand new line\./); // the other text is left alone
    assert.match(moved, /data-e="home\.2">We serve great food\./); // the edit followed its text
    assert.equal((await (await get(edit('state'), { cookie: owner })).json()).changes[0].outdated, undefined);
    // the rebuilt website no longer has that text at all
    fs.writeFileSync(path.join(dist, 'index.html'), page('Home', '<h1 data-e="home.0">Welcome to Cedar House</h1><p data-e="home.1">Something else entirely.</p>'));
    const gone = await served();
    assert.match(gone, /data-e="home\.1">Something else entirely\./); // never put on a text that is not the one the owner changed
    assert.doesNotMatch(gone, /great food/);
    const st = await (await get(edit('state'), { cookie: owner })).json();
    assert.equal(st.changes[0].outdated, true); // the owner is told, and can remove it
    assert.equal((await post(baseOne, edit('undo'), { key: 'home.1' }, { cookie: owner })).status, 200);
  } finally { fs.writeFileSync(path.join(dist, 'index.html'), HOME); }
});


test('one business\'s edits never show on another\'s website, and they are still there after a restart', async () => {
  await post(baseOne, edit('text'), { key: 'home.0', value: 'Only for the first business' }, { cookie: owner });
  assert.match(await (await get('/')).text(), /Only for the first business/);
  assert.equal(await (await get('/', {}, baseTwo)).text(), HOME); // the second business's website is untouched
  one.server.close(); one.store.close();
  const again = createOrdersServer({ dir: path.join(root, 'one'), siteId: 'ed-one', dist });
  await new Promise((r) => again.server.listen(0, '127.0.0.1', r));
  try { assert.match(await (await fetch(`http://127.0.0.1:${again.server.address().port}/`)).text(), /Only for the first business/); }
  finally { again.server.close(); again.store.close(); }
  one = createOrdersServer({ dir: path.join(root, 'one'), siteId: 'ed-one', dist }); // the next tests of other files do not need it
});
