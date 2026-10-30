// Tests for the QA checks of the built site (pure: no browser, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQa } from '../src/stages/09-qa/checks.js';
import { STAGES } from '../src/stages/index.js';

const page = (extra = '', { title = 'Bonza | Perfumes in Cairo', desc = 'Original and inspired perfumes for men and women, ordered easily through a direct message to the shop.' } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><meta name="description" content="${desc}"><link rel="icon" href="/favicon.png"></head><body><main><h1>Bonza</h1><h2>Perfumes</h2>${extra}</main></body></html>`;
const base = (pages, more = {}) => ({ pages, distFiles: new Set(['/robots.txt']), ...more });
const find = (results, re) => results.find((r) => re.test(r.name));
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

test('a clean page passes every check; browser checks are reported as skipped when there is no browser', () => {
  const r = checkQa(base([{ slug: 'home', html: page('<a href="/perfumes/">See perfumes</a>') }]));
  assert.deepEqual(failed(r), []);
  assert.ok(find(r, /browser checks .* were skipped/));
});

test('structure problems fail: two h1, a nameless icon button, a link to a missing section, a tiny phone number, a repeated title', () => {
  const html = page('<h1>Second</h1><button><span class="material-symbols-outlined">menu</span></button><a href="#nowhere">x</a><a href="tel:12">call</a>');
  const r = checkQa(base([{ slug: 'home', html }, { slug: 'about', html: page() }]));
  const f = failed(r);
  assert.ok(f.some((n) => /exactly one main heading/.test(n)));
  assert.ok(f.some((n) => /link and button has a name/.test(n)));
  assert.ok(f.some((n) => /"#section" link/.test(n)));
  assert.ok(f.some((n) => /phone links/.test(n)));
  assert.ok(f.some((n) => /its own title/.test(n)));
});

test('names are recognised: text, aria-label and a picture with alt all count; icon names do not', () => {
  const ok = '<a href="/x" aria-label="Instagram"><svg></svg></a><button>Send</button><a href="/y"><img src="/a.webp" alt="Logo of Bonza"></a>';
  assert.equal(find(checkQa(base([{ slug: 'home', html: page(ok) }])), /has a name/).ok, true);
  assert.equal(find(checkQa(base([{ slug: 'home', html: page('<a href="/x"><span class="material-symbols-outlined">arrow_forward</span></a>') }])), /has a name/).ok, false);
});

test('picture descriptions that are file names fail; unlabeled fields and unsafe new-tab links are advice only', () => {
  const html = page('<img src="/a.webp" alt="IMG_0412.jpg"><input name="email"><label>Name <input name="n"></label><a href="https://x.com" target="_blank">x</a>');
  const r = checkQa(base([{ slug: 'home', html }]));
  assert.equal(find(r, /words, not file names/).ok, false);
  const fields = find(r, /form fields have a label/);
  assert.ok(fields.ok && /email/.test(fields.details) && !/"n"/.test(fields.details));
  assert.ok(/noopener/.test(find(r, /new tab/).details));
});

test('weight: a page over 3 MB fails, over 1.5 MB is advice; the weight counts the files the page loads', () => {
  const html = page('<img src="/images/a.webp" alt="a"><link rel="stylesheet" href="/_astro/x.css">');
  const light = checkQa(base([{ slug: 'home', html }], { fileSizes: { '/images/a.webp': 100_000, '/_astro/x.css': 20_000 } }));
  assert.equal(find(light, /heavier than/).ok, true);
  const heavy = checkQa(base([{ slug: 'home', html }], { fileSizes: { '/images/a.webp': 3_500_000 } }));
  assert.equal(find(heavy, /heavier than/).ok, false);
  assert.ok(/home/.test(find(checkQa(base([{ slug: 'home', html }], { fileSizes: { '/images/a.webp': 2_000_000 } })), /stay under/).details));
});

test('motion files must carry both reduced-motion guards', () => {
  const html = page('<script src="/motion.js" defer></script>');
  const good = { '/motion.css': '@media (prefers-reduced-motion: no-preference) {}', '/motion.js': "matchMedia('(prefers-reduced-motion: reduce)')" };
  assert.equal(find(checkQa(base([{ slug: 'home', html }], { fileTexts: good })), /reduced motion/).ok, true);
  assert.equal(find(checkQa(base([{ slug: 'home', html }], { fileTexts: { ...good, '/motion.css': '.m-in{opacity:0}' } })), /reduced motion/).ok, false);
});

test('browser measurements: sideways overflow, load errors and unreadable text fail; weak contrast and small targets are advice', () => {
  const view = (o = {}) => ({ ok: true, overflowPx: 0, overflowing: [], contrast: [], smallTargets: 0, tinyText: 0, errors: [], ...o });
  const run = (mobile, desktop) => checkQa(base([{ slug: 'home', html: page() }], { browser: { pages: [{ route: '/', mobile, desktop }] } }));
  assert.deepEqual(failed(run(view(), view())), []);
  const r = run(view({ overflowPx: 40, overflowing: ['div.hero'] }), view({ errors: ['404 /favicon.png'], contrast: [{ text: 'Direct line', ratio: 1.4, fg: 'a', bg: 'b' }, { text: 'Muted', ratio: 3.9, fg: 'a', bg: 'b' }] }));
  const f = failed(r);
  assert.ok(f.some((n) => /sideways on a phone/.test(n)) && f.some((n) => /missing files/.test(n)) && f.some((n) => /nearly unreadable/.test(n)));
  assert.ok(/Direct line/.test(find(r, /nearly unreadable/).details) && !/Muted/.test(find(r, /nearly unreadable/).details));
  assert.ok(/Muted/.test(find(r, /4\.5:1/).details));
  assert.equal(failed(run(view({ ok: false }), view())).length, 1, 'a page that did not open is reported once');
});

test('stage 9 is registered with its report as output', () => {
  assert.deepEqual([STAGES[9].name, STAGES[9].outputs], ['qa', ['qa-report.json']]);
});
