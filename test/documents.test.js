// A menu or price list can be uploaded as a PDF or as pictures of its pages; the pictures are kept apart from the website's photos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCustomerServer } from '../src/server/customer.js';
import { scanAssets, isDocument } from '../src/stages/02-assets/scan.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

test('menu pages as pictures: accepted, marked as documents, found by Stage 2 as documents, and never the request\'s picture', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  setProjectsRoot(tmp);
  const { server, flow } = createCustomerServer({ steps: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const call = async (method, p, body, headers = {}) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
    const { id } = (await call('POST', '/api/start', {})).json;
    const jpeg = (color) => sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toBuffer();
    const put = async (name, kind, buffer) => call('PUT', `/api/upload/${id}?kind=${kind}&name=${encodeURIComponent(name)}`, buffer, { 'Content-Type': 'application/octet-stream' });

    assert.equal((await put('shop front.jpg', 'photo', await jpeg('#a63'))).json.saved, 'shop-front.jpg');
    assert.equal((await put('Menu page 1.JPG', 'document', await jpeg('#fff'))).json.saved, 'document-Menu-page-1.jpg');
    assert.equal((await put('Menu page 2.jpg', 'document', await jpeg('#eee'))).json.saved, 'document-Menu-page-2.jpg');
    assert.equal((await put('prices.pdf', 'document', Buffer.from('%PDF-1.4 test'))).json.saved, 'prices.pdf', 'a PDF still works');
    assert.equal((await put('notes.exe', 'document', Buffer.from('x'))).status, 400);
    assert.equal((await put('fake.jpg', 'document', Buffer.from('not a picture'))).status, 400, 'the content must match the type');

    // Stage 2 sees the three documents and one photo
    const { files } = scanAssets(id);
    assert.deepEqual(files.filter(isDocument).map((f) => f.name).sort(), ['document-Menu-page-1.jpg', 'document-Menu-page-2.jpg', 'prices.pdf']);
    assert.deepEqual(files.filter((f) => !isDocument(f)).map((f) => f.name), ['shop-front.jpg']);

    // the card of "my requests" shows the shop photo, never a menu page
    fs.writeFileSync(projectPath(id, 'inputs/answers.json'), JSON.stringify({ businessName: 'Cafe' }));
    flow.save(id, { phase: 'queued' }); // a request that was sent shows in the list
    const mine = (await call('POST', '/api/mine', { ids: [id] })).json;
    assert.match(mine[0].picture ?? '', /shop-front\.jpg$/);
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the files limit leaves room for 20 photos, a logo and the pages of a menu', async () => {
  const { MAX_FILES } = await import('../src/server/customerFlow.js');
  assert.ok(MAX_FILES >= 20 + 1 + 10);
});
