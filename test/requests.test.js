// Tests for written change requests: words become a few safe operations, one stylesheet, and every request can be undone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteMap, validateOps, buildCss, submitRequest, undoRequest, readRequests, requestsState, MAX_ACTIVE_REQUESTS } from '../src/lib/changeRequests.js';
import { revertAll, tagEditable } from '../src/lib/siteEdits.js';
import { createCustomerServer } from '../src/server/customer.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const HOME = '<header><a href="/">Shop</a></header><main><section id="home-hero"><h1>Welcome</h1></section><section id="home-range"><h2>Our perfumes</h2></section><section id="home-order"><h2>How to order</h2></section></main><footer><p>Footer</p></footer>';
const CONTACT = '<main><section id="contact-form"><h2>Write to us</h2><form><input name="n"></form></section></main>';

async function withSite(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-'));
  setProjectsRoot(tmp);
  try {
    const id = 'c-bbbbbb222222'; const site = projectPath(id, 'site');
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), text); };
    put('src/content/home.html', tagEditable(HOME, 'home')); put('src/content/contact.html', tagEditable(CONTACT, 'contact'));
    put('dist/index.html', `<html><head><title>x</title></head><body>${HOME}</body></html>`); put('dist/contact/index.html', `<html><head></head><body>${CONTACT}</body></html>`);
    put('public/custom.css', '/* empty */');
    fs.writeFileSync(projectPath(id, 'customer-state.json'), JSON.stringify({ id, phase: 'chosen' }));
    await fn(id);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
}
const asks = (answer) => ({ askJson: async () => answer });

test('the site map lists every page, its sections with their headings, and which ones hold a form', async () => {
  await withSite((id) => {
    const map = siteMap(id);
    assert.deepEqual(map.pages.map((p) => [p.slug, p.sections.map((s) => s.id)]).sort(), [['contact', ['contact-form']], ['home', ['home-hero', 'home-range', 'home-order']]]);
    assert.equal(map.pages.find((p) => p.slug === 'home').sections[1].title, 'Our perfumes');
    assert.deepEqual([map.hasHeader, map.hasFooter, map.pages.find((p) => p.slug === 'contact').sections[0].hasForm], [true, true, true]);
  });
});

test('only valid, safe operations are kept; the rest come back as plain reasons', async () => {
  await withSite((id) => {
    const map = siteMap(id);
    const { ok, dropped } = validateOps([
      { op: 'color', target: 'header', property: 'background', value: '#3B2715' },
      { op: 'color', target: 'headings', property: 'background', value: '#ffffff' },      // headings have no background
      { op: 'color', target: 'page', property: 'background', value: 'red' },               // not a clear colour
      { op: 'color', target: 'section', id: 'nope', property: 'text', value: '#ffffff' },  // no such section
      { op: 'font-scale', factor: 5 },                                                      // clamped
      { op: 'font', role: 'headings', family: 'Comic Sans' },                                // not offered
      { op: 'font', role: 'body', family: 'Lora' },
      { op: 'hide-section', id: 'home-range' },
      { op: 'hide-section', id: 'contact-form' },                                            // holds the contact form
      { op: 'move-section', page: 'home', id: 'home-order', to: 'up' },
      { op: 'move-section', page: 'home', id: 'home-order', to: 'sideways' },
      { op: 'align', id: 'home-hero', align: 'center' },
      { op: 'buttons-shape', shape: 'pill' },
      { op: 'run-script', code: 'alert(1)' },                                                // unknown operations vanish
      'not an object',
    ], map);
    assert.deepEqual(ok.map((o) => o.op), ['color', 'font-scale', 'font', 'hide-section', 'move-section', 'align', 'buttons-shape']);
    assert.equal(ok[0].value, '#3b2715');
    assert.equal(ok[1].factor, 1.3, 'text size is kept within a sensible range');
    assert.equal(dropped.length, 6);
    assert.ok(dropped.some((d) => /contact form/.test(d)) && dropped.some((d) => /Comic Sans/.test(d)));
  });
});

test('the stylesheet: colours of named parts, text size, fonts, hidden and moved sections, alignment, button shape; undone requests are not in it', async () => {
  await withSite((id) => {
    const map = siteMap(id);
    const css = buildCss([
      { id: 'r-1', text: 'dark header', ops: [{ op: 'color', target: 'header', property: 'background', value: '#3b2715' }, { op: 'color', target: 'header', property: 'text', value: '#f5ebdd' }] },
      { id: 'r-2', text: 'bigger text */ evil', ops: [{ op: 'font-scale', factor: 1.15 }, { op: 'font', role: 'headings', family: 'Playfair Display' }, { op: 'buttons-shape', shape: 'pill' }] },
      { id: 'r-3', text: 'order', ops: [{ op: 'hide-section', id: 'home-range' }, { op: 'move-section', page: 'home', id: 'home-order', to: 'first' }, { op: 'align', id: 'home-hero', align: 'center' }, { op: 'color', target: 'section', id: 'home-hero', property: 'background', value: '#fff8ee' }] },
    ], map);
    assert.match(css, /^@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display/);
    assert.match(css, /header \{ background-color: #3b2715 !important; \}/);
    assert.match(css, /header, header a, header span, header button \{ color: #f5ebdd !important; \}/);
    assert.match(css, /html \{ font-size: 115% !important; \}/);
    assert.match(css, /h1, h2, h3, h4, h5, h6, .*font-family: "Playfair Display", Georgia, serif !important/);
    assert.match(css, /border-radius: 9999px !important/);
    assert.match(css, /#home-range \{ display: none !important; \}/);
    assert.match(css, /#home-hero, #home-hero :is\(h1.*text-align: center !important/);
    assert.match(css, /#home-hero \{ background-color: #fff8ee !important; \}/);
    // the moved section comes first: the page's sections get an explicit order
    assert.match(css, /main \{ display: grid !important/);
    assert.match(css, /#home-order \{ order: 1; \}[\s\S]*#home-hero \{ order: 2; \}[\s\S]*#home-range \{ order: 3; \}/);
    assert.equal((css.match(/\*\//g) || []).length, (css.match(/\/\*/g) || []).length, 'the customer\'s words cannot close a CSS comment early');
    assert.equal(buildCss([], map).includes('{'), false, 'no requests, no rules');
  });
});

test('a request: understood, applied to the page source and the built pages at once, listed, undoable; "restore everything" removes it too', async () => {
  await withSite(async (id) => {
    const answer = { summary: 'The header is now dark brown with light text.', ops: [{ op: 'color', target: 'header', property: 'background', value: '#3b2715' }, { op: 'color', target: 'header', property: 'text', value: '#f5ebdd' }], needsTeam: [] };
    const asked = [];
    const done = await submitRequest(id, 'make the header dark brown', { deps: { askJson: async (o) => { asked.push(o); return answer; } } });
    assert.deepEqual([done.applied, done.team], [true, []]);
    assert.match(asked[0].prompt, /home-hero/);
    assert.match(asked[0].prompt, /THE OWNER'S REQUEST: make the header dark brown/);
    assert.match(asked[0].system, /Never change words, prices, product names, pictures or the logo/);
    for (const rel of ['public/custom.css', 'dist/custom.css']) assert.match(fs.readFileSync(path.join(projectPath(id, 'site'), rel), 'utf8'), /header \{ background-color: #3b2715 !important/);
    for (const rel of ['dist/index.html', 'dist/contact/index.html']) assert.match(fs.readFileSync(path.join(projectPath(id, 'site'), rel), 'utf8'), /<link rel="stylesheet" href="\/custom\.css" \/><\/head>/);
    assert.deepEqual(requestsState(id).map((r) => [r.status, r.summary]), [['applied', 'The header is now dark brown with light text.']]);
    // undo: the rules disappear
    undoRequest(id, done.id);
    assert.ok(!/header \{ background-color/.test(fs.readFileSync(path.join(projectPath(id, 'site'), 'dist/custom.css'), 'utf8')));
    assert.deepEqual(requestsState(id), []);
    assert.throws(() => undoRequest(id, done.id), /not found/);
    // "restore everything" takes requests away as well
    await submitRequest(id, 'dark header again please', { deps: asks(answer) });
    assert.equal(requestsState(id).length, 1);
    revertAll(id);
    assert.deepEqual(requestsState(id), []);
    assert.ok(!/background-color/.test(fs.readFileSync(path.join(projectPath(id, 'site'), 'dist/custom.css'), 'utf8')));
  });
});

test('what cannot be done by a safe operation goes to the team, in plain words, and changes nothing', async () => {
  await withSite(async (id) => {
    const done = await submitRequest(id, 'add a new gallery page with a slideshow', { deps: asks({ summary: 'We cannot add pages ourselves, so we passed this to our team.', ops: [], needsTeam: ['A new gallery page with a slideshow.'] }) });
    assert.deepEqual([done.applied, done.team], [false, ['A new gallery page with a slideshow.']]);
    assert.deepEqual(requestsState(id).map((r) => [r.status, r.team]), [['team', ['A new gallery page with a slideshow.']]]);
    assert.equal(fs.readFileSync(path.join(projectPath(id, 'site'), 'public/custom.css'), 'utf8'), '/* empty */', 'nothing was written');
    // a half-possible request: what works is applied, what is refused is said
    const mixed = await submitRequest(id, 'hide the contact form and make the header dark', { deps: asks({ summary: 'Done what we could.', ops: [{ op: 'hide-section', id: 'contact-form' }, { op: 'color', target: 'header', property: 'background', value: '#222222' }], needsTeam: [] }) });
    assert.equal(mixed.applied, true);
    assert.ok(mixed.team.some((t) => /contact form/.test(t)));
    assert.ok(!/contact-form/.test(fs.readFileSync(path.join(projectPath(id, 'site'), 'dist/custom.css'), 'utf8')), 'the contact form is never hidden');
  });
});

test('plain refusals: too short, too long, too many, a model that fails, and no site yet', async () => {
  await withSite(async (id) => {
    const answer = { summary: 's', ops: [{ op: 'font-scale', factor: 1.1 }], needsTeam: [] };
    await assert.rejects(submitRequest(id, 'bigger', { deps: asks(answer) }), /describe the change/);
    await assert.rejects(submitRequest(id, 'x '.repeat(400), { deps: asks(answer) }), /under 600 characters/);
    await assert.rejects(submitRequest(id, 'make the text bigger please', { deps: { askJson: async () => { throw new Error('down'); } } }), /could not read that request/);
    for (let i = 0; i < MAX_ACTIVE_REQUESTS; i++) await submitRequest(id, `make the text bigger ${i}`, { deps: asks(answer) });
    await assert.rejects(submitRequest(id, 'and bigger again please', { deps: asks(answer) }), (e) => e.status === 403 && /number of change requests/.test(e.message));
    assert.equal(readRequests(id).items.length, MAX_ACTIVE_REQUESTS);
  });
  await assert.rejects(submitRequest('c-nosite000000', 'make the text bigger please', { deps: asks({}) }), /not ready for changes/);
});

test('through the customer server: the request, the state with its requests, and undo', async () => {
  await withSite(async (id) => {
    const aiDeps = asks({ summary: 'Text is now a little bigger.', ops: [{ op: 'font-scale', factor: 1.1 }], needsTeam: [] });
    const { server } = createCustomerServer({ steps: {}, aiDeps });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const call = async (p, body) => { const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() }; };
      const sent = await call(`/api/edit/${id}/request`, { text: 'make the text a bit bigger' });
      assert.equal(sent.status, 200);
      assert.deepEqual([sent.json.applied, sent.json.requests.map((r) => r.summary)], [true, ['Text is now a little bigger.']]);
      assert.equal((await fetch(`${base}/site/${id}/custom.css`).then((r) => r.text())).includes('font-size: 110%'), true, 'the stylesheet is served with the site');
      assert.equal((await call(`/api/edit/${id}/request`, { text: 'x' })).status, 400);
      const undone = await call(`/api/edit/${id}/request-undo`, { id: sent.json.id });
      assert.deepEqual(undone.json.requests, []);
      assert.equal((await call(`/api/edit/${id}/request-undo`, { id: 'r-none' })).status, 404);
    } finally { server.close(); }
  });
});
