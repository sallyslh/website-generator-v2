// The gates and the automatic phone repair (the browser parts are tested through their measures, not by opening a browser).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileProblems, linkProblems, judge, phoneProblems } from '../src/wow/gates.js';
import { repairPhone } from '../src/wow/repair.js';

const site = (files) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } return dir; };
const page = (body, head = '<link rel="stylesheet" href="styles.css">') => `<html><head>${head}</head><body>${body}</body></html>`;

test('a page without its style file, or pointing to a missing picture, is a problem', () => {
  const ok = site({ 'index.html': page('<img src="images/a.jpg">'), 'styles.css': 'b{}', 'images/a.jpg': 'x' });
  assert.deepEqual(fileProblems(ok), []);
  const noSheet = site({ 'index.html': page('<img src="images/a.jpg">'), 'images/a.jpg': 'x' });
  assert.match(fileProblems(noSheet).join(' '), /styles.css is linked but the file is not there/);
  const noStyles = site({ 'index.html': page('<p>hi</p>', '') });
  assert.match(fileProblems(noStyles).join(' '), /no styles/);
  const missing = site({ 'index.html': page('<img src="images/gone.jpg">'), 'styles.css': 'b{}' });
  assert.match(fileProblems(missing).join(' '), /images\/gone.jpg is missing/);
});

test('links to missing pages and sections are problems; other places and mail links are not', () => {
  const dir = site({ 'index.html': page('<a href="about.html">a</a><a href="about.html#team">t</a><a href="#top">x</a><a href="nope.html">n</a><a href="about.html#gone">g</a><a href="https://x.com">e</a><a href="mailto:a@b.c">m</a><a href="#">h</a><h1 id="top">x</h1>'), 'about.html': page('<h2 id="team">team</h2>') });
  const p = linkProblems(dir);
  assert.equal(p.length, 2);
  assert.match(p.join(' '), /nope.html/); assert.match(p.join(' '), /#gone/);
});

const row = (page, view, extra) => ({ page, view, words: [], height: 3000, overflowX: 0, smallText: 0, smallTargets: 0, broken: 0, sections: [], ...extra });
const words = (n, skip = 0) => Array.from({ length: n }, (_, i) => `word${i + skip}`);

test('the measures block sideways scrolling, broken pictures and a phone that shows less than the laptop', () => {
  const good = [row('a.html', 'phone', { words: words(100) }), row('a.html', 'laptop', { words: words(100) })];
  assert.deepEqual(judge(good).blockers, []);
  const bad = [row('a.html', 'phone', { words: words(50), overflowX: 12, broken: 2 }), row('a.html', 'laptop', { words: words(100) })];
  const b = judge(bad).blockers.join(' | ');
  assert.match(b, /sideways by 12px/); assert.match(b, /2 picture/); assert.match(b, /only 50%/);
});

test('a very tall phone page is a warning, not a blocker', () => {
  const rows = [row('a.html', 'phone', { words: words(100), height: 6000 }), row('a.html', 'laptop', { words: words(100), height: 3000 })];
  const j = judge(rows);
  assert.deepEqual(j.blockers, []); assert.match(j.warnings.join(' '), /200% as tall/);
});

test('the repair is told which sections are tall, and a page that got worse is put back', async () => {
  const problems = phoneProblems([
    row('a.html', 'phone', { height: 6000, sections: [{ title: 'OUR TEAM', h: 2400 }, { title: 'HELLO', h: 300 }] }),
    row('a.html', 'laptop', { height: 3000, sections: [{ title: 'OUR TEAM', h: 700 }, { title: 'HELLO', h: 300 }] }),
  ]);
  assert.match(problems['a.html'].join(' '), /section starting with "OUR TEAM" is 2400px tall/);
  assert.equal(problems['a.html'].some((l) => l.includes('HELLO')), false);

  const dir = site({ 'a.html': '<body class="x">old</body>' });
  const states = [ // measure 1 (before), measure 2 (after the repair: worse)
    [row('a.html', 'phone', { height: 6000 }), row('a.html', 'laptop', { height: 3000 })],
    [row('a.html', 'phone', { height: 9000 }), row('a.html', 'laptop', { height: 3000 })],
    [row('a.html', 'phone', { height: 6000 }), row('a.html', 'laptop', { height: 3000 })],
    [row('a.html', 'phone', { height: 6000 }), row('a.html', 'laptop', { height: 3000 })],
  ];
  let i = 0; const measureFn = () => ({ rows: states[Math.min(i++, states.length - 1)] });
  const ask = async () => ({ changes: [{ id: 1, class: 'x md:y' }] });
  const r = await repairPhone({ dir, rounds: 1, ask, measureFn, lookFn: async () => null });
  assert.deepEqual(r.restored, ['a.html']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.html'), 'utf8'), '<body class="x">old</body>', 'the worse repair was undone');
});

test('what the vision check finds on the first screen of a phone goes to the repair, laptop findings are only reported', async () => {
  const dir = site({ 'index.html': '<body class="x">old</body>' });
  const rows = [row('index.html', 'phone', { height: 3000 }), row('index.html', 'laptop', { height: 3000 })];
  const lookFn = async () => ({ phone: { good: false, problems: ['the headline sits over the cup'] }, laptop: { good: false, problems: ['the buttons are below the first screen'] } });
  let hint = '';
  const ask = async ({ prompt }) => { hint = prompt; return { changes: [] }; };
  const r = await repairPhone({ dir, rounds: 1, ask, measureFn: () => ({ rows }), lookFn });
  assert.match(hint, /First screen on a phone: the headline sits over the cup/);
  assert.deepEqual(r.laptopLook, ['the buttons are below the first screen']);
});
