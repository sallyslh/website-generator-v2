// The shop form: matching photos to the owner's product list, the answers it produces, the brief that copies the list word for word,
// and the link from each product to its photo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSubmission, formToAnswers } from '../src/server/customerFlow.js';
import { cleanItems, cleanItemPhotos, applyItems, applyItemPhotos, itemLines } from '../src/lib/shopItems.js';
import { splitWishes } from '../src/stages/01-discovery/index.js';
import { filterProposals } from '../src/stages/01-discovery/enrich.js';
import { createCustomerServer } from '../src/server/customer.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

// the matching file is plain browser code (also served to the customer's page); it is loaded here the way a script would run
const M = (() => { const m = { exports: {} }; new Function('module', fs.readFileSync(path.resolve('src/server/customer-public/match.js'), 'utf8'))(m); return m.exports; })();
const read = (f) => JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant', f), 'utf8'));

const ITEMS = [
  { name: 'Kayali Déjà Vu White Flower' }, { name: 'Tom Ford Black Orchid 100 ml' }, { name: 'Tom Ford Tobacco Vanille 100 ml' },
  { name: 'Dior Sauvage' }, { name: 'Dior Sauvage Elixir' }, { name: 'Valentino Born in Roma Intense' }, { name: 'Gucci Bloom' }, { name: 'Burberry Her' },
];

test('photos are matched to products by file name: capitals, accents, small words, sizes and photo numbers do not matter', () => {
  const kind = (file) => M.matchFile(file, ITEMS).kind;
  const cands = (file) => M.matchFile(file, ITEMS).cands;
  assert.deepEqual([kind('kayali deja vu white flower.jpg'), cands('kayali deja vu white flower.jpg')], ['matched', [0]]);
  assert.deepEqual([kind('KAYALI DÉJÀ VU WHITE FLOWER.PNG'), cands('Women/Gucci Bloom-2.jpg')], ['matched', [6]]);
  assert.equal(kind('Gucci Bloom (3).jpg'), 'matched', 'a trailing photo number is ignored');
  assert.equal(kind('Tom Ford Black Orchid.jpg'), 'matched', 'the size ("100 ml") is not needed');
  assert.deepEqual([kind('tobacco vanille.jpg'), cands('tobacco vanille.jpg')], ['probable', [2]]);
  assert.deepEqual([kind('born in roma.jpg'), cands('born in roma.jpg')], ['probable', [5]]);
  assert.deepEqual([kind('Sauvage.jpg'), cands('Sauvage.jpg')], ['ambiguous', [3, 4]], 'the name fits two products: the customer chooses');
  assert.equal(kind('Dior Sauvage.jpg'), 'matched', 'the full name settles it');
  assert.deepEqual([kind('Dior Sauvage Elixir.jpg'), cands('Dior Sauvage Elixir.jpg')], ['matched', [4]]);
  assert.equal(kind('shop front.jpg'), 'none');
  assert.equal(kind('IMG_0042.jpg'), 'none', 'a camera name matches nothing');
  assert.equal(kind('.jpg'), 'none');
  assert.equal(M.matchFile('x.jpg', []).kind, 'none');
});

test('the folder: categories come from sub-folders, several photos of one product stay together, the rest are pictures of the place', () => {
  const photos = ['Shop/Women/gucci bloom-1.jpg', 'Shop/Women/gucci bloom-2.jpg', 'Shop/Men/Sauvage.jpg', 'Shop/Men/tobacco vanille.jpg', 'Shop/shop front.jpg'].map((p) => ({ path: p }));
  const a = M.analyse(ITEMS, photos);
  assert.deepEqual(a.byItem[6].map((p) => p.name), ['gucci bloom-1.jpg', 'gucci bloom-2.jpg']);
  assert.deepEqual([a.photos[0].category, a.photos[2].category, a.photos[4].category], ['Women', 'Men', ''], 'the first folder is the one the customer picked, the next is the category');
  assert.deepEqual(a.extras.map((p) => p.name), ['Sauvage.jpg', 'shop front.jpg'], 'an ambiguous photo has no product until the customer chooses');
  assert.equal(M.status(a, 6), 'ok');
  assert.equal(M.status(a, 2), 'check', 'a probable match waits for the customer');
  assert.equal(M.status(a, 0), 'missing');
  assert.equal(M.status(a, 0, { 0: true }), 'left', 'the customer may leave a product without a photo');
  // the customer's choices
  const fixed = M.analyse(ITEMS, photos, { 2: 4, 3: 2, 4: -1 });
  assert.deepEqual([fixed.byItem[4].map((p) => p.name), M.status(fixed, 4), M.status(fixed, 2)], [['Sauvage.jpg'], 'ok', 'ok'], 'chosen by the customer = certain');
  assert.deepEqual(M.analyse(ITEMS, photos, { 0: -1 }).byItem[6].map((p) => p.name), ['gucci bloom-2.jpg'], '"not this product" sends a photo to the place pictures');
});

test('the shop form: a product list is required, prices are optional, one way to be reached is required', () => {
  const form = { siteType: 'shop', businessName: 'Bonza', story: 'We started in a small kitchen and grew slowly, one customer at a time.', phone: '81 526 765', items: [{ name: 'Gucci Bloom', price: '$85' }] };
  assert.deepEqual(validateSubmission(form), { ok: true, errors: [], soft: [] });
  assert.match(validateSubmission({ ...form, items: [] }).errors.join(' '), /at least one product/);
  assert.match(validateSubmission({ ...form, items: [{ name: '   ' }] }).errors.join(' '), /at least one product/);
  assert.match(validateSubmission({ ...form, phone: '' }).errors.join(' '), /at least one way for customers/);
  assert.equal(validateSubmission({ ...form, phone: '', instagram: '@bonza' }).ok, true, 'a social page counts');
  assert.match(validateSubmission({ ...form, businessName: 'B' }).errors.join(' '), /name of your business/);
  assert.equal(validateSubmission({ ...form, siteType: undefined, goal: 'orders' }).ok, true, 'the general form is unchanged');
});

test('the answers: the list is kept as typed (empty price = no price), photo links are made safe, nothing else is invented', () => {
  const form = { siteType: 'shop', businessName: 'Bonza', whatItDoes: 'Original perfumes', phone: '81 526 765', whatsapp: '+961 81 526 765', hasLogo: true,
    items: [{ name: ' Kayali Déjà Vu ', price: '$45', description: 'Sweet floral', category: 'Women' }, { name: 'Gucci Bloom', price: '', desc: 'White flowers' }, { name: '' }],
    itemPhotos: [{ file: 'kayali.jpg', item: 0 }, { file: '../evil.jpg', item: 0 }, { file: 'gucci.jpg', item: 99 }, { file: 'place.jpg', item: -1 }, { file: 'a/b.jpg', item: 1 }] };
  const a = formToAnswers(form);
  assert.equal(a.siteType, 'shop');
  assert.deepEqual(a.items, [{ name: 'Kayali Déjà Vu', price: '$45', description: 'Sweet floral', category: 'Women' }, { name: 'Gucci Bloom', price: '', description: 'White flowers', category: '' }]);
  assert.deepEqual(a.itemPhotos, [{ file: 'kayali.jpg', item: 0 }, { file: 'gucci.jpg', item: -1 }, { file: 'place.jpg', item: -1 }], 'unsafe names are dropped, a wrong index becomes "not a product"');
  assert.equal(a.productsAndServices.split('\n')[0], 'Kayali Déjà Vu - $45: Sweet floral');
  assert.match(a.productsAndServices, /prices shown for some items only/);
  assert.equal(a.mainGoal, 'Get orders by message or DM');
  assert.equal(a.whatsapp, '+961 81 526 765');
  assert.match(a.pages, /Shop.*Contact.*How to order/);
  assert.equal(formToAnswers({ ...form, items: [{ name: 'A', price: '1' }] }).productsAndServices.includes('some items only'), false);
  assert.match(formToAnswers({ ...form, items: [{ name: 'A' }, { name: 'B' }] }).productsAndServices, /does NOT want prices shown/);
  assert.equal(cleanItems(Array.from({ length: 500 }, (_, i) => ({ name: 'p' + i }))).length, 200, 'a list is limited');
  assert.equal(itemLines([{ name: 'X', price: '', description: '' }]), 'X');
});

test('the brief copies the owner\'s list word for word; the model never sees it as something to rewrite', () => {
  const answers = formToAnswers({ siteType: 'shop', businessName: 'Bonza', phone: '1', items: [{ name: 'Gucci Bloom', price: '$85', description: 'White flowers', category: 'Women' }, { name: 'Burberry Her' }], itemPhotos: [{ file: 'g.jpg', item: 0 }] });
  const { forBrief, structured } = splitWishes(answers);
  assert.ok(!('items' in forBrief) && !('itemPhotos' in forBrief) && !('siteType' in forBrief), 'the structured list is not sent as free text');
  const brief = read('site-brief.json');
  brief.offerings = [{ name: 'Invented perfume', description: 'made up by the model', price: '$1' }];
  applyItems(brief, structured);
  assert.equal(brief.siteType, 'shop');
  assert.deepEqual(brief.offerings, [{ name: 'Gucci Bloom', description: 'White flowers', price: '$85', category: 'Women' }, { name: 'Burberry Her', description: '' }]);
  const general = read('site-brief.json'); const before = JSON.stringify(general.offerings);
  applyItems(general, { items: [], itemPhotos: [], siteType: undefined });
  assert.equal(JSON.stringify(general.offerings), before, 'without a list (the general form) the brief is untouched');
});

test('each product is linked to its photo after Stage 2; photos of the place and unknown files are not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopphotos-'));
  setProjectsRoot(tmp);
  try {
    const brief = read('site-brief.json');
    brief.offerings = [{ name: 'Gucci Bloom', description: '' }, { name: 'Burberry Her', description: '' }, { name: 'Kayali', description: '' }];
    fs.mkdirSync(projectPath('p1', 'inputs'), { recursive: true });
    fs.writeFileSync(projectPath('p1', 'site-brief.json'), JSON.stringify(brief));
    const manifest = read('asset-manifest.json');
    manifest.assets = [['asset-001', 'gucci-bloom-1.jpg'], ['asset-002', 'gucci-bloom-2.jpg'], ['asset-003', 'burberry.jpg'], ['asset-004', 'shop-front.jpg']].map(([id, f], i) => ({ ...read('asset-manifest.json').assets[0], id, file: `inputs/assets/${f}` }));
    manifest.logo = null; manifest.documents = [];
    fs.writeFileSync(projectPath('p1', 'asset-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(projectPath('p1', 'inputs/answers.json'), JSON.stringify({ itemPhotos: [{ file: 'gucci-bloom-1.jpg', item: 0 }, { file: 'gucci-bloom-2.jpg', item: 0 }, { file: 'burberry.jpg', item: 1 }, { file: 'shop-front.jpg', item: -1 }, { file: 'missing.jpg', item: 2 }] }));
    assert.equal(applyItemPhotos('p1'), 2, 'two products got their photo');
    const after = JSON.parse(fs.readFileSync(projectPath('p1', 'site-brief.json'), 'utf8'));
    assert.deepEqual(after.offerings.map((o) => o.assetId), ['asset-001', 'asset-003', undefined], 'the first photo of a product is its main one');
    assert.equal(applyItemPhotos('p1'), 0, 'running again changes nothing');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('with the owner\'s own product list, photo-based product proposals are not made on top of it', () => {
  const brief = read('site-brief.json'); const manifest = read('asset-manifest.json');
  const proposals = [{ path: 'offerings.products', value: ['Black Orchid|asset-001'], evidence: 'seen on asset-001' }, { path: 'offerings.prices', value: ['Black Orchid|99'], evidence: 'asset-001' }, { path: 'business.contact.phone', value: '81 526 765', evidence: 'text asset-001' }];
  brief.offerings = [{ name: 'Gucci Bloom', description: '' }];
  const shop = filterProposals({ ...brief, siteType: 'shop' }, manifest, proposals);
  assert.deepEqual(shop.dropped.filter((d) => /owner gave the list/.test(d.reason)).map((d) => d.proposal.path), ['offerings.products', 'offerings.prices']);
});

test('on the customer server: the shared matching file is served, and a price list is read into a table to check', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopserver-'));
  setProjectsRoot(tmp);
  const calls = [];
  const aiDeps = { readList: async ({ projectId, files }) => { calls.push(files.map((f) => path.basename(f))); return [{ name: 'Gucci Bloom', price: '$85', description: '', category: 'Women' }]; } };
  const { server, flow } = createCustomerServer({ steps: {}, aiDeps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const call = async (method, p, body, headers = {}) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
    assert.match(await (await fetch(`${base}/match.js`)).text(), /ItemMatch/);
    const { id } = (await call('POST', '/api/start', {})).json;
    assert.equal((await call('POST', `/api/read-list/${id}`)).status, 400, 'no price list yet');
    await call('PUT', `/api/upload/${id}?kind=document&name=${encodeURIComponent('price list.pdf')}`, Buffer.from('%PDF-1.4 x'), { 'Content-Type': 'application/octet-stream' });
    const read = await call('POST', `/api/read-list/${id}`);
    assert.deepEqual([read.status, read.json.items[0].name, calls], [200, 'Gucci Bloom', [['price-list.pdf']]]);
    flow.save(id, { phase: 'queued' });
    assert.equal((await call('POST', `/api/read-list/${id}`)).status, 409, 'only while the form is being filled in');
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a big folder: photos named after a product are described from the owner\'s list (no AI reading); the rest are still read', async () => {
  const { namedPhotos, namedPhotoAnswer, BULK_PHOTOS } = await import('../src/stages/02-assets/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-'));
  setProjectsRoot(tmp);
  try {
    const brief = { offerings: [{ name: 'Fattoush', description: 'Salad with sumac' }, { name: 'Kibbeh', description: '' }] };
    fs.mkdirSync(projectPath('p1', 'inputs'), { recursive: true });
    fs.writeFileSync(projectPath('p1', 'inputs/answers.json'), JSON.stringify({ itemPhotos: [{ file: 'fattoush.jpg', item: 0 }, { file: 'terrace.jpg', item: -1 }, { file: 'kibbeh.jpg', item: 1 }, { file: 'x.jpg', item: 7 }] }));
    const named = namedPhotos('p1', brief);
    assert.deepEqual([...named.keys()], ['fattoush.jpg', 'kibbeh.jpg'], 'only photos linked to a real product; the place photo and a bad index are read normally');
    const a = namedPhotoAnswer({ info: { width: 800, height: 600 } }, named.get('fattoush.jpg'));
    assert.equal(a.category, 'product');
    assert.match(a.description, /Fattoush: Salad with sumac/);
    assert.ok(BULK_PHOTOS >= 20, 'small sets are always read photo by photo');
    const { MAX_FILES } = await import('../src/server/customerFlow.js');
    assert.ok(MAX_FILES >= 150 + 1 + 10, 'a folder of 150 photos fits');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a menu (restaurant) is a shop-style form: siteType menu, no "how to order" page, no menu file needed', () => {
  const form = { siteType: 'shop', shopKind: 'menu', businessName: 'Beit Lina', story: 'We started in a small kitchen and grew slowly, one customer at a time.',  whatItDoes: 'Lebanese food', phone: '71 123 456', items: [{ name: 'Fattoush', price: '$8', description: '', category: 'Starters' }, { name: 'Kibbeh', price: '', description: '', category: 'Mains' }], itemPhotos: [{ file: 'fattoush.jpg', item: 0 }], aiPictures: 'allowed' };
  assert.equal(validateSubmission(form).ok, true, 'no menu file asked for');
  const answers = formToAnswers(form);
  assert.equal(answers.siteType, 'menu');
  assert.ok(!/how to order/i.test(JSON.stringify(answers.otherPages ?? '')), 'a restaurant has no "how to order" page');
  assert.equal(answers.items.length, 2);
  assert.equal(formToAnswers({ ...form, shopKind: 'shop' }).siteType, 'shop');
});

test('a typed list: name - price - description per line; "Chanel No 5" and "Coca-Cola" stay whole names', () => {
  const rows = M.parseList('Fattoush - $8 - Salad with sumac\nKibbeh | 12 USD | Fried shells - with lamb\nCoca-Cola\nHaircut $25\nChanel No 5\nKnefeh\t6\n\n');
  assert.deepEqual(rows.map((r) => [r.name, r.price, r.description]), [['Fattoush', '$8', 'Salad with sumac'], ['Kibbeh', '12 USD', 'Fried shells - with lamb'], ['Coca-Cola', '', ''], ['Haircut', '$25', ''], ['Chanel No 5', '', ''], ['Knefeh', '6', '']]);
  const a = M.analyse(rows, [{ path: 'dishes/Starters/fattoush-2.jpg' }, { path: 'kibbeh.jpg' }]);
  assert.deepEqual([a.photos[0].item, a.photos[1].item], [0, 1], 'the typed lines are what the photos are matched to');
});

test('a list saved as a file: CSV columns are found by their titles, any order; semicolons, quotes and a text file also work', () => {
  const csv = 'Price,Dish,Description,Category\n$8,Fattoush,"Salad, with sumac",Starters\n$12,Kibbeh,Fried shells,Mains\n,Knefeh,,Desserts\n';
  assert.deepEqual(M.parseTable(csv, true).map((r) => [r.name, r.price, r.description, r.category]), [['Fattoush', '$8', 'Salad, with sumac', 'Starters'], ['Kibbeh', '$12', 'Fried shells', 'Mains'], ['Knefeh', '', '', 'Desserts']]);
  assert.deepEqual(M.parseTable('Fattoush;8;Salad\nKibbeh;12;Shells', true).map((r) => [r.name, r.price, r.description]), [['Fattoush', '8', 'Salad'], ['Kibbeh', '12', 'Shells']], 'no header: name first, the price-like cell is the price');
  assert.deepEqual(M.parseTable('Fattoush - $8 - Salad, crisp bread\nKibbeh - $12', false).map((r) => [r.name, r.price, r.description]), [['Fattoush', '$8', 'Salad, crisp bread'], ['Kibbeh', '$12', '']], 'a text file keeps its commas');
  assert.deepEqual(M.parseTable('', true), []);
});

test('sending the same photos again (a retry after a failed attempt) never makes copies; old copies are removed on submit', async () => {
  const { dropDuplicateFiles } = await import('../src/server/customer.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-'));
  setProjectsRoot(tmp);
  const { server } = createCustomerServer({ steps: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, n)]);
  try {
    const put = async (id, name, body) => (await fetch(`${base}/api/upload/${id}?kind=photo&name=${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body })).json();
    const { id } = await (await fetch(`${base}/api/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const first = await put(id, 'fattoush.png', png(1));
    assert.equal(first.saved, 'fattoush.png');
    assert.equal((await put(id, 'fattoush.png', png(1))).saved, 'fattoush.png', 'the same file again: the saved one is reused');
    assert.equal((await put(id, 'fattoush.png', png(2))).saved, 'fattoush-2.png', 'a different picture with the same name is kept apart');
    assert.equal((await put(id, 'fattoush.png', png(2))).saved, 'fattoush-2.png', 'and sending it again reuses that one too');
    assert.deepEqual(fs.readdirSync(projectPath(id, 'inputs/assets')).sort(), ['fattoush-2.png', 'fattoush.png']);
    // copies left by an old failed attempt: same bytes under a "-2" name
    fs.writeFileSync(projectPath(id, 'inputs/assets/fattoush-3.png'), png(1));
    assert.equal(dropDuplicateFiles(id), 1);
    assert.deepEqual(fs.readdirSync(projectPath(id, 'inputs/assets')).sort(), ['fattoush-2.png', 'fattoush.png'], 'the original stays, the copy goes');
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the offer page is named after the kind of site, never "Products or menu"', () => {
  const base = { siteType: 'shop', businessName: 'Kaze', phone: '1', items: [{ name: 'Ramen', price: '17' }] };
  assert.match(formToAnswers({ ...base, shopKind: 'menu' }).pages, /^Home, Menu, Contact$/);
  assert.match(formToAnswers({ ...base, shopKind: "shop" }).pages, /^Home, Shop, Contact, How to order$/);
  const general = formToAnswers({ businessName: 'X', phone: '1', goal: 'bookings', pages: ['products', 'contact'], pageNames: { products: 'Services' } });
  assert.match(general.pages, /Home, Services, Contact/);
  assert.doesNotMatch(general.pages, /Products or menu/);
});

test('the story is required (it inspires the About section): a few sentences, for every kind of form', () => {
  const general = { businessName: 'Salon Lina', goal: 'bookings', phone: '1' };
  const shop = { siteType: 'shop', businessName: 'Kaze', phone: '1', items: [{ name: 'Ramen', price: '17' }] };
  for (const form of [general, shop]) {
    assert.match(validateSubmission(form).errors.join(' '), /your story/, 'no story');
    assert.match(validateSubmission({ ...form, story: 'Nice.' }).errors.join(' '), /your story/, 'one word is not a story');
    assert.doesNotMatch(validateSubmission({ ...form, story: 'We opened after years of cooking at home for friends.' }).errors.join(' '), /your story/);
  }
});

test('the Services form uses the same list-and-pictures answers: exact prices from the list, services as the page, bookings as the goal', () => {
  const form = { siteType: 'shop', shopKind: 'services', businessName: 'Atelier Nour', story: 'Nour trained in Paris for six years and came home to open a calm salon.', phone: '+961 3 555 777', whatsapp: '+961 3 555 777', address: 'Sodeco Square, Beirut', instagram: '@ateliernour', bookingUrl: 'https://book.example.com', items: [{ name: 'Haircut and styling', price: '$35', description: '', category: 'Hair' }, { name: 'Bridal makeup', price: '$120', description: 'Trial included', category: 'Bridal' }] };
  assert.equal(validateSubmission(form).ok, true);
  const a = formToAnswers(form);
  assert.equal(a.siteType, 'services');
  assert.match(a.pages, /^Home, Services, About us, Contact$/, 'the offer page is called Services and the story gets its About page');
  assert.match(JSON.stringify(a), /bookings|book/i);
  assert.deepEqual(a.items.map((i) => [i.name, i.price]), [['Haircut and styling', '$35'], ['Bridal makeup', '$120']], 'the prices are the list\'s, copied by code');
  assert.match(a.features, /contact form/); assert.match(a.features, /map/); assert.match(a.features, /social links/); assert.match(a.features, /booking link: https:\/\/book\.example\.com/);
  assert.match(validateSubmission({ ...form, items: [] }).errors.join(' '), /at least one service to your list/);
});

test('a menu and a shop also get the features the owner\'s details allow (contact form, map, social links), nothing to tick', () => {
  const base = { siteType: 'shop', businessName: 'Kaze', story: 'A small ramen bar with a long story behind it.', phone: '1', items: [{ name: 'Ramen', price: '17' }] };
  const none = formToAnswers({ ...base, shopKind: 'menu' });
  assert.ok(!/contact form|map|social/.test(none.features ?? ''), 'no address, no WhatsApp or email: no map, no form');
  const all = formToAnswers({ ...base, shopKind: 'menu', whatsapp: '+1 514 555 0187', address: '88 Rue Saint-Denis', tiktok: '@kaze' });
  assert.match(all.features, /contact form/); assert.match(all.features, /map/); assert.match(all.features, /social links/);
  assert.doesNotMatch(all.features, /booking link/, 'a booking link only for services');
});

test('a list file whose name column is called Service or Treatment is read correctly; the header is never taken for a row', () => {
  const rows = (csv) => M.parseTable(csv, true).map((r) => [r.name, r.price, r.description, r.category]);
  assert.deepEqual(rows('Category,Service,Price,Description\nNails,Classic manicure,25,Shape and polish\nSkin,Facial,65,'), [['Classic manicure', '25', 'Shape and polish', 'Nails'], ['Facial', '65', '', 'Skin']]);
  assert.deepEqual(rows('Treatment,Rate\nCut,35\nColour,90'), [['Cut', '35', '', ''], ['Colour', '90', '', '']]);
  assert.deepEqual(rows('Name;Fee;Notes\nCut;35;Includes a wash'), [['Cut', '35', 'Includes a wash', '']], 'semicolons, other words for the same columns');
  assert.deepEqual(rows('Service,Price\nHaircut,"1,500"'), [['Haircut', '"1,500"'.replace(/"/g, ''), '', '']].map((r) => [r[0], '1,500', '', '']), 'a quoted price with a comma stays whole');
});

test('a website that only presents the business (intro) needs no list, has no prices, and gets about + contact pages (and "Our work" when the owner gave some)', async () => {
  const { validateSubmission, formToAnswers } = await import('../src/server/customerFlow.js');
  const form = { siteType: 'shop', shopKind: 'intro', businessName: 'Studio Noor', whatItDoes: 'Interior design', story: 'We design calm homes for families who love to host people.', whatsapp: '+961 71 014 463', items: [], itemPhotos: [], currency: 'USD' };
  assert.equal(validateSubmission(form).ok, true);
  const a = formToAnswers(form);
  assert.equal(a.siteType, 'intro');
  assert.equal(a.pages, 'Home, About us, Contact');
  assert.match(a.mainGoal, /trust|confidence|credib/i);
  const withWork = formToAnswers({ ...form, items: [{ name: 'Villa Rosa', description: 'A family home in Batroun', price: '' }] });
  assert.equal(withWork.pages, 'Home, About us, Our work, Contact');
  assert.match(withWork.productsAndServices, /The owner does NOT want prices/);
  // the other kinds still need their list
  assert.equal(validateSubmission({ ...form, shopKind: 'shop' }).ok, false);
});
