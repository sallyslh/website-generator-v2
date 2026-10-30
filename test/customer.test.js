// Tests for the customer-facing flow (no API calls): form logic, upload safety, and a full run through the real
// HTTP server with fake pipeline steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSubmission, formToAnswers, safeUploadName, looksLikeFile, friendlyProposals } from '../src/server/customerFlow.js';
import { createCustomerServer } from '../src/server/customer.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const goodForm = () => ({
  businessName: 'Bonza', story: 'We started in a small kitchen and grew slowly, one customer at a time.', whatItDoes: 'Online perfume shop', goal: 'orders', goalText: '', phone: '81 526 765', address: '', hours: '',
  products: 'Eau de parfum for men; Eau de parfum for women', showPrices: 'yes', pages: ['products', 'about'], otherPages: 'FAQ',
  features: ['contact form', 'booking link', 'social links'], bookingUrl: 'https://example.com/book', instagram: '@bonza_perfumes',
  brandColors: 'gold and cream', feelingWords: 'elegant, warm, classic', notes: 'Orders only by DM', hasLogo: true,
});

test('validation: name and goal are required, missing phone/address/hours are only soft warnings', () => {
  assert.deepEqual(validateSubmission({}).ok, false);
  const r = validateSubmission(goodForm());
  assert.equal(r.ok, true);
  assert.deepEqual(r.soft, ['address', 'hours']);
  assert.equal(validateSubmission({ ...goodForm(), goal: 'other', goalText: '' }).ok, false);
  assert.equal(validateSubmission({ ...goodForm(), goal: 'nonsense' }).ok, false);
});

test('form -> answers.json keeps the owner\'s words and states what is missing', () => {
  const a = formToAnswers(goodForm());
  assert.equal(a.businessName, 'Bonza');
  assert.match(a.mainGoal, /Get orders by message or DM/);
  assert.match(a.locationAndContact, /Phone: 81 526 765/);
  assert.match(a.locationAndContact, /Address: \n/); // empty on purpose, so Stage 1 lists it as unknown
  assert.match(a.locationAndContact, /Instagram: @bonza_perfumes/);
  assert.match(a.productsAndServices, /wants prices shown/);
  assert.equal(a.pages, 'Home, Products or menu, About us, FAQ');
  assert.equal(a.features, 'contact form, booking link: https://example.com/book, social links');
  assert.match(a.brand, /uploaded their logo/);
  assert.deepEqual(a.followUps, []);
});

test('uploads: only safe names and types, logo is always logo.*, content must match the type', () => {
  assert.equal(safeUploadName('My Photo (1).JPG', 'photo'), 'My-Photo-1.jpg');
  assert.equal(safeUploadName('../../evil.png', 'photo'), 'evil.png');
  assert.equal(safeUploadName('anything.png', 'logo'), 'logo.png');
  assert.equal(safeUploadName('menu.pdf', 'document'), 'menu.pdf');
  assert.equal(safeUploadName('script.exe', 'photo'), null);
  assert.equal(safeUploadName('Menu page 1.JPG', 'document'), 'document-Menu-page-1.jpg', 'a picture of a menu is a document, marked so it is never used as a photo');
  assert.equal(safeUploadName('prices.webp', 'document'), 'document-prices.webp');
  assert.equal(safeUploadName('malware.exe', 'document'), null);
  assert.equal(safeUploadName('a.png', 'unknown'), null);
  assert.equal(looksLikeFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), '.png'), true);
  assert.equal(looksLikeFile(Buffer.from('MZ not a png'), '.png'), false);
  assert.equal(looksLikeFile(Buffer.from('%PDF-1.4'), '.pdf'), true);
});

test('what we found is shown in plain words', () => {
  const found = friendlyProposals([
    { path: 'brand.colors', value: ['#F3EADF', '#9A6B35'], evidence: 'x', status: 'pending' },
    { path: 'offerings.prices', value: ['Haircut|$25'], evidence: 'x', status: 'pending' },
    { path: 'business.socialLinks', value: ['instagram:bonza_perfumes'], evidence: 'x', status: 'pending' },
    { path: 'tone', value: 'warm', evidence: 'x', status: 'accepted' },
  ]);
  assert.deepEqual(found.map((f) => [f.index, f.kind]), [[0, 'colors'], [1, 'list'], [2, 'list']]);
  assert.deepEqual(found[1].value, ['Haircut: $25']);
  assert.deepEqual(found[2].value, ['instagram @bonza_perfumes']);
  assert.equal(found[0].label, 'Your brand colors');
});

// ---- the whole customer journey through the real server, with fake stages ----
test('customer journey: start, upload, submit, confirm what was found, receive two sketches, choose one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  setProjectsRoot(tmp);
  const called = [];
  const steps = {
    brief: async () => called.push('brief'),
    photos: async () => called.push('photos'),
    findings: async () => { called.push('findings'); return [{ index: 0, key: 'brand.colors', label: 'Your brand colors', kind: 'colors', value: ['#112233'] }]; },
    applyDecisions: async (id, d) => called.push(`decisions ${JSON.stringify(d)}`),
    direction: async () => called.push('direction'),
    copy: async () => called.push('copy'),
    sketches: async (id) => {
      called.push('sketches');
      fs.mkdirSync(projectPath(id, 'design'), { recursive: true });
      fs.writeFileSync(projectPath(id, 'design/home.html'), '<html>sketch 1</html>');
    },
    another: async (id) => {
      called.push('another');
      fs.mkdirSync(projectPath(id, 'design/freestyle'), { recursive: true });
      fs.writeFileSync(projectPath(id, 'design/freestyle/home-freestyle.html'), '<html>sketch 2</html>');
    },
    recordChoice: async (id, c) => called.push(`recordChoice ${c.choice}`),
    rest: async () => called.push('rest'),
    approve: async () => called.push('approve'),
  };
  const { server } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  const waitFor = async (id, phase) => { for (let i = 0; i < 100; i++) { const s = (await call('GET', `/api/status/${id}`)).json; if (s.phase === phase) return s; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`never reached ${phase}`); };

  try {
    const { id } = (await call('POST', '/api/start', {})).json;
    assert.match(id, /^c-[0-9a-f]{12}$/);

    // uploads: a real PNG header passes, a fake one and a bad type are refused
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
    assert.equal((await call('PUT', `/api/upload/${id}?kind=photo&name=shop.png`, png, { 'Content-Type': 'application/octet-stream' })).status, 200);
    assert.equal((await call('PUT', `/api/upload/${id}?kind=logo&name=whatever.png`, png, { 'Content-Type': 'application/octet-stream' })).json.saved, 'logo.png');
    assert.equal((await call('PUT', `/api/upload/${id}?kind=photo&name=fake.png`, Buffer.from('not an image at all'), { 'Content-Type': 'application/octet-stream' })).status, 400);
    assert.equal((await call('PUT', `/api/upload/${id}?kind=photo&name=virus.exe`, png, { 'Content-Type': 'application/octet-stream' })).status, 400);

    // an invalid form is refused with a friendly message
    const bad = await call('POST', `/api/submit/${id}`, { form: { businessName: '' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /name of your business/);

    // a good form starts the pipeline, which stops to ask the customer about what it found
    assert.equal((await call('POST', `/api/submit/${id}`, { form: goodForm() })).status, 202);
    const answers = JSON.parse(fs.readFileSync(projectPath(id, 'inputs/answers.json'), 'utf8'));
    assert.match(answers.brand, /uploaded their logo/);
    const confirmState = await waitFor(id, 'confirm');
    assert.equal(confirmState.findings[0].label, 'Your brand colors');
    assert.equal(confirmState.sketches, null, 'no sketches before they exist');
    assert.equal((await call('POST', `/api/submit/${id}`, { form: goodForm() })).status, 409, 'cannot submit twice');

    // confirming continues to the two sketches
    assert.equal((await call('POST', `/api/confirm/${id}`, { accept: [0], reject: [] })).status, 202);
    const ready = await waitFor(id, 'ready');
    assert.deepEqual(called, ['brief', 'photos', 'findings', 'decisions {"accept":[0],"reject":[],"skip":{}}', 'direction', 'copy', 'sketches']);
    assert.ok(ready.steps.every((s) => s.status === 'done'));
    assert.equal(ready.internalError, undefined);
    assert.equal(ready.sketches[1], `/p/${id}/design/home.html`);
    assert.equal(ready.sketches[2], null, 'only ONE design by default');

    // the design can be opened; the project's internal files cannot
    assert.equal((await fetch(base + ready.sketches[1])).status, 200);
    assert.equal((await fetch(`${base}/p/${id}/inputs/answers.json`)).status, 404);
    assert.equal((await fetch(`${base}/p/${id}/design/../inputs/answers.json`)).status, 404);
    assert.equal((await fetch(`${base}/p/${id}/site-brief.json`)).status, 404);

    // style 2 cannot be chosen before it exists; it is drawn only when the customer asks
    assert.equal((await call('POST', `/api/choose/${id}`, { choice: 2 })).status, 409);
    assert.equal((await call('POST', `/api/another/${id}`, {})).status, 202);
    for (let i = 0; i < 100 && (await call('GET', `/api/status/${id}`)).json.alt !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    const two = (await call('GET', `/api/status/${id}`)).json;
    assert.equal(two.alt, 'ready');
    assert.equal(two.sketches[2], `/p/${id}/design/freestyle/home-freestyle.html`);
    assert.equal((await fetch(base + two.sketches[2])).status, 200);

    // choosing records it (Stage 6), draws the missing pages, approves everything, then the request is done
    assert.equal((await call('POST', `/api/choose/${id}`, { choice: 3 })).status, 400);
    assert.equal((await call('POST', `/api/choose/${id}`, { choice: 2, note: 'make the logo bigger' })).status, 200);
    const done = await waitFor(id, 'chosen');
    assert.equal(JSON.parse(fs.readFileSync(projectPath(id, 'customer-choice.json'), 'utf8')).choice, 2);
    assert.equal(done.choice.note, 'make the logo bigger');
    assert.deepEqual(called.slice(-4), ['another', 'recordChoice 2', 'rest', 'approve']);

    // unknown requests never expose anything
    assert.equal((await call('GET', '/api/status/c-doesnotexist')).status, 404);
    assert.equal((await call('GET', '/api/status/..%2f..%2fpackage')).status, 404);
  } finally {
    server.close();
    setProjectsRoot(path.resolve('projects'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a failing step shows a friendly message (no technical details) and can be retried', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  setProjectsRoot(tmp);
  let fail = true;
  const steps = {
    brief: async () => { if (fail) throw new Error('ANTHROPIC credit balance is too low (secret detail)'); },
    photos: async () => {}, findings: async () => [], applyDecisions: async () => {}, direction: async () => {}, copy: async () => {},
    sketches: async (id) => { fs.mkdirSync(projectPath(id, 'design'), { recursive: true }); fs.writeFileSync(projectPath(id, 'design/home.html'), 'x'); },
    another: async () => {}, recordChoice: async () => {}, rest: async () => {}, approve: async () => {},
  };
  const { server } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const waitFor = async (id, phase) => { for (let i = 0; i < 100; i++) { const s = await (await fetch(`${base}/api/status/${id}`)).json(); if (s.phase === phase) return s; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`never reached ${phase}`); };
  try {
    const { id } = (await post('/api/start')).json;
    await post(`/api/submit/${id}`, { form: goodForm() });
    const failed = await waitFor(id, 'failed');
    assert.match(failed.message, /Something went wrong/);
    assert.ok(!JSON.stringify(failed).includes('credit balance'), 'no technical detail reaches the customer');
    fail = false;
    assert.equal((await post(`/api/retry/${id}`)).status, 202);
    await waitFor(id, 'ready'); // no findings in this run, so it goes straight through to the sketches
  } finally {
    server.close();
    setProjectsRoot(path.resolve('projects'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the owner\'s story and who the business is for / not for reach the answers file', () => {
  const a = formToAnswers({ ...goodForm(), customers: 'Women 20 to 45 who love gifts', notFor: 'bargain hunters', story: 'I started in my kitchen in 2019.' });
  assert.equal(a.customers, 'Women 20 to 45 who love gifts');
  assert.equal(a.notFor, 'bargain hunters');
  assert.equal(a.story, 'I started in my kitchen in 2019.');
  const plain = formToAnswers(goodForm());
  assert.match(plain.story, /small kitchen/, 'the story is part of every answers file');
  assert.equal(plain.notFor, '');
});

test('"my projects": only the requests a browser asks for, only those that exist, nothing internal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  setProjectsRoot(tmp);
  const quiet = async () => {};
  const steps = { brief: quiet, photos: quiet, findings: async () => [], applyDecisions: quiet, direction: quiet, copy: quiet, sketches: quiet, another: quiet, recordChoice: quiet, rest: quiet, approve: quiet };
  const { server } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  try {
    const first = (await post('/api/start')).json.id;
    await fetch(`${base}/api/upload/${first}?kind=logo&name=x.png`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: png });
    await post(`/api/submit/${first}`, { form: { ...goodForm(), businessName: 'First Shop' } });
    await new Promise((r) => setTimeout(r, 400));
    const second = (await post('/api/start')).json.id;
    await post(`/api/submit/${second}`, { form: { ...goodForm(), businessName: 'Second Shop' } });
    const unsent = (await post('/api/start')).json.id; // started but never sent
    await new Promise((r) => setTimeout(r, 400));

    const mine = (await post('/api/mine', { ids: [first, second, unsent, 'c-doesnotexist', '../../etc', 42, null] })).json;
    assert.deepEqual(mine.map((m) => m.name).sort(), ['First Shop', 'Second Shop'], 'sent requests only: not the unsent one, nothing unknown');
    assert.equal(mine[0].name, 'Second Shop', 'newest first');
    const firstCard = mine.find((m) => m.id === first);
    assert.equal(firstCard.picture, `/p/${first}/inputs/assets/logo.png`);
    assert.equal(mine.find((m) => m.id === second).picture, null);
    assert.ok(firstCard.createdAt && firstCard.phase);
    assert.equal(JSON.stringify(mine).includes('internalError'), false);
    // an empty or broken request is harmless, and only 30 ids are ever read
    assert.deepEqual((await post('/api/mine', { ids: 'nope' })).json, []);
    assert.deepEqual((await post('/api/mine', {})).json, []);
    assert.equal((await post('/api/mine', { ids: Array(100).fill(first) })).json.length <= 30, true);
  } finally {
    server.close();
    setProjectsRoot(path.resolve('projects'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('combined pictures: the customer sees them when the design is ready, approves or rejects each, and nothing else can be changed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  setProjectsRoot(tmp);
  const quiet = async () => {};
  const steps = { brief: quiet, photos: quiet, findings: async () => [], applyDecisions: quiet, direction: quiet, copy: quiet, sketches: quiet, another: quiet, recordChoice: quiet, rest: quiet, approve: quiet };
  const { server, flow } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  try {
    const { id } = (await call('/api/start')).json;
    const asset = (n, extra = {}) => ({ id: n, file: `inputs/assets/${n}.jpg`, hash: '', kind: 'image', category: 'product', description: 'x', quality: 'high', orientation: 'square', width: 10, height: 10, dominantColors: [], usableFor: [], notes: '', ...extra });
    fs.mkdirSync(path.join(tmp, id, 'inputs/composed'), { recursive: true });
    fs.writeFileSync(path.join(tmp, id, 'inputs/composed/home-hero-image.jpg'), 'jpg');
    fs.writeFileSync(path.join(tmp, id, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, assets: [asset('asset-001'), asset('asset-002'), asset('combo-1', { file: 'inputs/composed/home-hero-image.jpg', derivedFrom: ['asset-001', 'asset-002'], approval: 'pending' })], logo: null, documents: [], gaps: [] }));
    assert.equal((await call(`/api/combined/${id}`, { assetId: 'combo-1', approve: true })).status, 409, 'not before the design is ready');
    flow.save(id, { phase: 'ready' });
    const status = (await call(`/api/status/${id}`, null, 'GET')).json;
    assert.deepEqual(status.combined, [{ id: 'combo-1', picture: `/p/${id}/inputs/composed/home-hero-image.jpg`, photos: 2, origin: 'collage', approval: 'pending' }]);
    assert.equal((await fetch(base + status.combined[0].picture)).status, 200, 'the customer can look at the picture');
    assert.equal((await call(`/api/combined/${id}`, { assetId: 'combo-1', approve: false })).json.combined[0].approval, 'rejected');
    assert.equal((await call(`/api/combined/${id}`, { assetId: 'combo-1', approve: true })).json.combined[0].approval, 'approved');
    assert.equal((await call(`/api/combined/${id}`, { assetId: 'asset-001', approve: false })).status, 404, 'an ordinary photo cannot be changed here');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, id, 'asset-manifest.json'), 'utf8')).assets[0].approval, undefined);
  } finally {
    server.close();
    setProjectsRoot(path.resolve('projects'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the customer is asked in plain words about the product names we can read in their photos', () => {
  const items = friendlyProposals([{ path: 'offerings.products', value: ['Dior Sauvage|asset-002', 'Gucci Bloom|asset-005'], evidence: 'asset-002', status: 'pending' }]);
  assert.equal(items[0].kind, 'list');
  assert.deepEqual(items[0].value, ['Dior Sauvage', 'Gucci Bloom']);
  assert.match(items[0].label, /Products we can read in your photos/);
  assert.equal(JSON.stringify(items).includes('asset-002'), false, 'internal ids are never shown');
});

test('the customer can untick single product names: only the ticked names are added to the brief, none ticked = nothing added', async () => {
  const { realSteps } = await import('../src/server/customer.js');
  const { siteBriefSchema } = await import('../src/schemas/siteBrief.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  setProjectsRoot(tmp);
  try {
    const brief = (status) => siteBriefSchema.parse({
      schemaVersion: 1, projectId: 'p', business: { name: 'Shop', type: '', description: '', location: '', contact: { phone: '', email: '', address: '', hours: '' } },
      goals: { primary: 'sell', secondary: [] }, audience: { description: '', needs: [] }, offerings: [], pages: [{ slug: 'home', title: 'Home', purpose: '' }], features: [],
      brand: { hasIdentity: false, colors: [], personality: [] }, tone: '', references: { liked: [], disliked: [] }, language: 'en', unknowns: [],
      proposals: [{ path: 'offerings.products', value: ['Aventus|asset-003', 'Bleu de Chanel|asset-003', 'Sauvage|asset-004'], evidence: 'asset-003', status }],
    });
    const write = () => { fs.mkdirSync(path.join(tmp, 'p1'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'p1/site-brief.json'), JSON.stringify(brief('pending'))); };
    const names = () => JSON.parse(fs.readFileSync(path.join(tmp, 'p1/site-brief.json'), 'utf8')).offerings.map((o) => `${o.name}@${o.assetId}`);
    write();
    await realSteps.applyDecisions('p1', { accept: [0], reject: [], skip: { 0: [1] } });
    assert.deepEqual(names(), ['Aventus@asset-003', 'Sauvage@asset-004'], 'the unticked name is not used');
    write();
    await realSteps.applyDecisions('p1', { accept: [0], reject: [], skip: { 0: [0, 1, 2] } });
    assert.deepEqual(names(), [], 'everything unticked adds nothing');
    write();
    await realSteps.applyDecisions('p1', { accept: [0], reject: [] });
    assert.equal(names().length, 3, 'without unticking everything is used');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
