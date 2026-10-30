// The customer's editing of the finished site through the real HTTP server (fake project files, no AI, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCustomerServer } from '../src/server/customer.js';
import { tagEditable } from '../src/lib/siteEdits.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const HEADER = '<header><a href="/" class="l"><svg class="w-9"><circle r="2"></circle></svg><span>Bonza</span></a><a href="/perfumes/">Perfumes</a></header>';
const PAGE = (title) => `${HEADER}<main><h1>${title}</h1><img src="/images/a.webp" alt="A box" class="w-full"/></main>`;

test('the finished site is served under /site/<id>/ with the overlay only in edit mode; edits, undo and restore work through the API', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editsrv-'));
  setProjectsRoot(tmp);
  const id = 'c-abcdef123456';
  const { server } = createCustomerServer({ steps: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const site = projectPath(id, 'site');
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), text); };
    const pages = { home: tagEditable(PAGE('Welcome to Bonza'), 'home'), perfumes: tagEditable(PAGE('Our perfumes'), 'perfumes') };
    put('src/content/home.html', pages.home); put('src/content/perfumes.html', pages.perfumes);
    put('dist/index.html', `<html><body>${pages.home}</body></html>`); put('dist/perfumes/index.html', `<html><body>${pages.perfumes}</body></html>`);
    put('dist/images/a.webp', 'x'); put('dist/x.css', 'a{background:url(/images/a.webp)}');
    put('site-report.json', JSON.stringify({ pages: [{ slug: 'home', title: 'Home', route: '/' }, { slug: 'perfumes', title: 'Perfumes', route: '/perfumes/' }] }));
    fs.writeFileSync(projectPath(id, 'customer-state.json'), JSON.stringify({ id, phase: 'chosen' }));
    const call = async (method, p, body, raw) => { const res = await fetch(base + p, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
    const text = async (p) => (await fetch(base + p)).text();

    // looking at the site: addresses move under the prefix, the overlay only comes with ?edit=1
    const plain = await text(`/site/${id}/`);
    assert.match(plain, /<a data-e="site\.logo"|<svg data-e="site\.logo"/);
    assert.match(plain, /src="\/site\/c-abcdef123456\/images\/a\.webp"/);
    assert.match(plain, /href="\/site\/c-abcdef123456\/perfumes\/"/);
    assert.ok(!plain.includes('overlay.js'));
    assert.match(await text(`/site/${id}/?edit=1`), /<script src="\/edit\/overlay\.js" data-id="c-abcdef123456"/);
    assert.match(await text(`/site/${id}/x.css`), /url\(\/site\/c-abcdef123456\/images\/a\.webp\)/);
    assert.match(await text('/edit/overlay.js'), /Your changes/);
    assert.equal((await fetch(`${base}/site/${id}/..%2f..%2fcustomer-state.json`)).status, 404, 'nothing outside the built site');
    assert.equal((await fetch(`${base}/site/c-nope000000/`)).status, 404);

    // the toolbar's data and a text edit
    const state = (await call('GET', `/api/edit/${id}/state`)).json;
    assert.deepEqual([state.ready, state.changes.length, state.pages.map((p) => p.route)], [true, 0, ['/', '/perfumes/']]);
    const key = (await text(`/site/${id}/`)).match(/<h1 data-e="([^"]+)"/)[1];
    const edited = await call('POST', `/api/edit/${id}/text`, { key, value: 'Fine perfume, by DM' });
    assert.equal(edited.json.changes[0].after, 'Fine perfume, by DM');
    assert.equal(edited.json.changes[0].before, 'Welcome to Bonza');
    assert.match(await text(`/site/${id}/`), /Fine perfume, by DM/);
    assert.equal((await call('POST', `/api/edit/${id}/text`, { key, value: '' })).status, 400);
    assert.equal((await call('POST', `/api/edit/${id}/text`, { key: '../x.0', value: 'a' })).status, 404);

    // a picture: a fake file is refused, a real one replaces the picture, the logo changes on every page
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#224488' } }).jpeg().toBuffer();
    assert.equal((await call('PUT', `/api/edit/${id}/image?key=home.img0&alt=A%20new%20box`, Buffer.from('nope'), true)).status, 400);
    assert.equal((await call('PUT', `/api/edit/${id}/image?key=home.img0&alt=`, photo, true)).status, 400, 'a description is required');
    const withPic = await call('PUT', `/api/edit/${id}/image?key=home.img0&alt=A%20new%20box`, photo, true);
    assert.equal(withPic.status, 200);
    assert.match(await text(`/site/${id}/`), /src="\/site\/c-abcdef123456\/images\/edit-[0-9a-f]{10}\.webp" alt="A new box"/);
    await call('PUT', `/api/edit/${id}/image?key=site.logo&alt=Bonza%20logo`, photo, true);
    for (const route of ['/', '/perfumes/']) assert.match(await text(`/site/${id}${route}`), /<img data-e="site\.logo" src="\/site\/c-abcdef123456\/images\/edit-/, `new logo on ${route}`);
    assert.equal((await call('GET', `/api/edit/${id}/state`)).json.changes.length, 3);
    assert.equal((await call('GET', `/api/status/${id}`)).json.siteReady, true);

    // back to the original: one change, then everything
    const undone = await call('POST', `/api/edit/${id}/undo`, { key });
    assert.equal(undone.json.changes.length, 2);
    assert.match(await text(`/site/${id}/`), /Welcome to Bonza/);
    const all = await call('POST', `/api/edit/${id}/revert-all`, {});
    assert.deepEqual(all.json.changes, []);
    const back = (await text(`/site/${id}/`)).replace(/\/site\/c-abcdef123456/g, '');
    assert.equal(back, `<html><body>${pages.home}</body></html>`, 'the page is exactly as it was generated');
    assert.equal((await call('GET', `/api/edit/c-000000000000/state`)).status, 404);
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
