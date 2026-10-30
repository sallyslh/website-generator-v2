// Another version of a page, asked for by the customer: Stitch draws it (faked here), the customer picks, nothing else moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addVariant, swapVersion, MAX_VARIANTS_PER_PAGE } from '../src/stages/05-design-stitch/index.js';
import { createCustomerServer } from '../src/server/customer.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const dir = path.resolve('test/fixtures/demo-restaurant');
const pagesOfBrief = JSON.parse(fs.readFileSync(path.join(dir, 'site-brief.json'), 'utf8')).pages.map((p) => p.slug);

function makeProject(id) {
  const put = (rel, data) => { const f = projectPath(id, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); };
  const manifest = { schemaVersion: 1, stitchProjectId: 'stitch-1', designSystemId: null, chosenSketch: null, freestyle: null,
    pages: pagesOfBrief.map((slug) => ({ slug, screenId: `main-${slug}`, html: `design/${slug}.html`, screenshot: `design/${slug}.png`, variants: [], promptUsed: 'x', status: 'generated' })) };
  put('design/design-manifest.json', manifest);
  for (const slug of pagesOfBrief) { put(`design/${slug}.html`, `<html>main ${slug}</html>`); put(`design/${slug}.png`, `png main ${slug}`); }
  fs.copyFileSync(path.join(dir, 'site-brief.json'), projectPath(id, 'site-brief.json'));
  fs.writeFileSync(projectPath(id, 'customer-state.json'), JSON.stringify({ id, phase: 'ready', createdAt: new Date().toISOString() }));
  return put;
}
const readManifest = (id) => JSON.parse(fs.readFileSync(projectPath(id, 'design/design-manifest.json'), 'utf8'));

// Stitch's answer and the saving of its files, faked
const deps = (calls = []) => ({
  generateVariants: async (projectId, stitchId, screenId, prompt, opts) => { calls.push({ stitchId, screenId, prompt, count: opts.count }); return [{ screenId: `var-of-${screenId}`, htmlUrl: 'x', imageUrl: 'y' }]; },
  save: async (projectId, screen, html, image) => { fs.mkdirSync(path.dirname(projectPath(projectId, html)), { recursive: true }); fs.writeFileSync(projectPath(projectId, html), `<html>${screen.screenId}</html>`); fs.writeFileSync(projectPath(projectId, image), `png ${screen.screenId}`); },
});

test('another version of one page is drawn and saved beside it; the page itself is not replaced; only one other version per page', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-'));
  setProjectsRoot(tmp);
  try {
    makeProject('p1');
    const calls = [];
    assert.equal(await addVariant({ projectId: 'p1', slug: 'menu', deps: deps(calls) }), 1);
    assert.deepEqual(calls.map((c) => [c.stitchId, c.screenId, c.count]), [['stitch-1', 'main-menu', 1]]);
    assert.match(calls[0].prompt, /different layouts and color schemes.*same text/);
    const menu = readManifest('p1').pages.find((p) => p.slug === 'menu');
    assert.deepEqual([menu.screenId, menu.html, menu.variants.length], ['main-menu', 'design/menu.html', 1]);
    assert.equal(menu.variants[0].html, 'design/variants/menu-var-of-main-menu.html');
    assert.equal(fs.readFileSync(projectPath('p1', 'design/menu.html'), 'utf8'), '<html>main menu</html>', 'the main page file is untouched');
    assert.ok(readManifest('p1').pages.filter((p) => p.slug !== 'menu').every((p) => p.variants.length === 0), 'other pages are untouched');
    await assert.rejects(addVariant({ projectId: 'p1', slug: 'menu', deps: deps() }), /already has another version/);
    await assert.rejects(addVariant({ projectId: 'p1', slug: 'nope', deps: deps() }), /Unknown page/);
    await assert.rejects(addVariant({ projectId: 'p1', slug: 'about', deps: { ...deps(), generateVariants: async () => [] } }), /did not return another version/);
    assert.equal(MAX_VARIANTS_PER_PAGE, 1);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('choosing the other version swaps the two in the design list (and back); the files stay where they are', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-'));
  setProjectsRoot(tmp);
  try {
    makeProject('p1');
    await addVariant({ projectId: 'p1', slug: 'home', deps: deps() });
    swapVersion({ projectId: 'p1', slug: 'home', screenId: 'var-of-main-home' });
    let home = readManifest('p1').pages.find((p) => p.slug === 'home');
    assert.deepEqual([home.screenId, home.html, home.screenshot], ['var-of-main-home', 'design/variants/home-var-of-main-home.html', 'design/variants/home-var-of-main-home.png'], 'the page now points at the new version');
    assert.deepEqual([home.variants[0].screenId, home.variants[0].html], ['main-home', 'design/home.html'], 'the old version is the other one');
    assert.equal(fs.readFileSync(projectPath('p1', home.html), 'utf8'), '<html>var-of-main-home</html>');
    swapVersion({ projectId: 'p1', slug: 'home', screenId: 'main-home' }); // back
    home = readManifest('p1').pages.find((p) => p.slug === 'home');
    assert.deepEqual([home.screenId, home.html], ['main-home', 'design/home.html']);
    assert.throws(() => swapVersion({ projectId: 'p1', slug: 'home', screenId: 'nothing' }), /not found/);
    assert.throws(() => swapVersion({ projectId: 'p1', slug: 'nope', screenId: 'x' }), /not found/);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('on the customer page: ask for another version of a page, see both, choose; limits and wrong requests are explained', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-'));
  setProjectsRoot(tmp);
  const id = 'c-cccccc333333';
  const stitchCalls = [];
  const stitch = deps(stitchCalls);
  let failNext = false;
  let release; let hold = new Promise((r) => { release = r; }); // the first drawing waits, so "being drawn" can be seen
  const steps = {
    variant: async (pid, slug) => { await hold; if (failNext) { failNext = false; throw new Error('stitch down'); } return addVariant({ projectId: pid, slug, deps: stitch }); },
    useVersion: async (pid, slug, screenId) => swapVersion({ projectId: pid, slug, screenId }),
  };
  const { server, flow } = createCustomerServer({ steps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    makeProject(id);
    const call = async (method, p, body) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
    const waitFor = async (check) => { for (let i = 0; i < 100; i++) { const s = (await call('GET', `/api/status/${id}`)).json; if (check(s)) return s; await new Promise((r) => setTimeout(r, 40)); } throw new Error('never happened'); };
    let st = (await call('GET', `/api/status/${id}`)).json;
    assert.ok(st.pages.every((p) => p.other.length === 0 && /^\/p\/c-cccccc333333\/design\/.+\.png$/.test(p.picture)));
    assert.equal(st.maxVersions, 4);

    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'nope' })).status, 404);
    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'menu' })).status, 202);
    assert.equal((await call('GET', `/api/status/${id}`)).json.variants.menu, 'working', 'it shows as being drawn at once');
    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'menu' })).status, 202, 'asking again while it is being drawn is harmless');
    release();
    st = await waitFor((s) => s.variants?.menu === 'ready');
    const menu = st.pages.find((p) => p.slug === 'menu');
    assert.equal(menu.other.length, 1);
    assert.equal(stitchCalls.length, 1, 'it was drawn only once');
    assert.match(menu.other[0].url, /\/p\/c-cccccc333333\/design\/variants\/menu-var-of-main-menu\.html$/);
    assert.equal((await fetch(base + menu.other[0].picture)).status, 200, 'the customer can see the picture of the other version');
    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'menu' })).status, 409, 'one other version per page');

    // choose it: the page list now points at it, and the old one is the other version
    const chosen = await call('POST', `/api/version/${id}`, { slug: 'menu', screenId: menu.other[0].screenId });
    assert.equal(chosen.status, 200);
    assert.match(chosen.json.pages.find((p) => p.slug === 'menu').url, /variants\/menu-var-of-main-menu\.html$/);
    assert.match(chosen.json.pages.find((p) => p.slug === 'menu').other[0].url, /design\/menu\.html$/);
    assert.equal((await call('POST', `/api/version/${id}`, { slug: 'menu', screenId: 'nothing' })).status, 404);

    // a failure never breaks the request, and can be tried again
    failNext = true;
    await call('POST', `/api/variant/${id}`, { slug: 'about' });
    st = await waitFor((s) => s.variants?.about === 'failed');
    assert.equal(st.phase, 'ready');
    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'about' })).status, 202, 'try again after a failure');
    await waitFor((s) => s.variants?.about === 'ready');

    // the most that can be asked for in one request
    await call('POST', `/api/variant/${id}`, { slug: 'home' }); await waitFor((s) => s.variants?.home === 'ready');
    await call('POST', `/api/variant/${id}`, { slug: 'contact' }); await waitFor((s) => s.variants?.contact === 'ready');
    const limited = await call('POST', `/api/variant/${id}`, { slug: 'menu' }); // menu already has one
    assert.equal(limited.status, 409);

    // only while the design is waiting for the customer's choice
    flow.save(id, { phase: 'chosen' });
    assert.equal((await call('POST', `/api/variant/${id}`, { slug: 'home' })).status, 409);
    assert.equal((await call('POST', `/api/version/${id}`, { slug: 'home', screenId: 'x' })).status, 409);
  } finally { server.close(); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
