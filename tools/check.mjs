// One command that says whether the code is fit to commit:  npm run check   (or: node tools/check.mjs --fast to skip the tests)
//   1. every .js / .mjs file of src, tools and test is valid JavaScript
//   2. the scripts written inside the pages (the customer form, the owner's panel) and the browser script of the cart are valid
//   3. the words of the form fit each kind of business (tools/wording-scan.mjs finds 0 problems)
//   4. the whole test suite passes
// A broken edit (a lost backslash, a missing bracket, a half-finished change) is caught here, before it is saved or sent anywhere.
// Installed as the git pre-commit hook by  node tools/check.mjs --install-hook

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const problems = [];
const say = (m) => console.log(m);

if (process.argv.includes('--install-hook')) {
  const hook = path.join(root, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\n# runs the checks of tools/check.mjs before every commit (a failing check stops the commit)\nnode tools/check.mjs\n');
  try { fs.chmodSync(hook, 0o755); } catch { /* not needed on Windows */ }
  say(`Installed: ${hook}`);
  process.exit(0);
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (['node_modules', '.git', 'dist', 'projects', 'orders-data'].includes(e.name) || e.name.startsWith('.')) return [];
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});

// 1. syntax of every module (checked as a module: the project is ESM)
const files = ['src', 'tools', 'test'].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : [])).filter((f) => /\.(m?js|cjs)$/.test(f));
let checked = 0;
for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  const asModule = !f.endsWith('.cjs') && !/^\s*(const|var|let) .*require\(/m.test(code.slice(0, 400));
  const tmp = path.join(root, `.check-${process.pid}${asModule ? '.mjs' : '.cjs'}`);
  fs.writeFileSync(tmp, code);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.rmSync(tmp, { force: true });
  checked++;
  if (r.status !== 0) problems.push(`${path.relative(root, f)}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) ?? 'syntax error'}`);
}
say(`syntax: ${checked} files checked`);

// 2. scripts inside pages
let scripts = 0;
for (const page of ['src/server/customer-public/index.html', 'src/server/orders/panel.html']) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    scripts++;
    try { new vm.Script(m[1], { filename: page }); } catch (e) { problems.push(`${page}: script does not compile (${e.message})`); }
  }
}
for (const f of ['src/stages/08-features/order-client.js', 'src/stages/08-features/chat-client.js', 'src/server/customer-public/match.js', 'src/server/customer-public/edit-overlay.js']) {
  if (!fs.existsSync(path.join(root, f))) continue;
  scripts++;
  try { new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }); } catch (e) { problems.push(`${f}: browser script does not compile (${e.message})`); }
}
say(`page scripts: ${scripts} checked`);

// 3. wording
const words = spawnSync(process.execPath, [path.join(root, 'tools/wording-scan.mjs')], { encoding: 'utf8' });
if (words.status !== 0 || !/wrong-kind wording found: 0/.test(words.stdout)) problems.push(`wording: ${words.stdout.split('\n').slice(-4).join(' ').trim()}`);
say('wording: ' + (words.stdout.match(/wrong-kind wording found: \d+/)?.[0] ?? 'no result'));

// 4. tests
if (!fast && problems.length === 0) {
  say('tests: running (about two minutes)...');
  const t = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', '--import', './test/setup.mjs', 'test/*.test.js'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${t.stdout}\n${t.stderr}`;
  const pass = out.match(/ℹ pass (\d+)/)?.[1]; const fail = out.match(/ℹ fail (\d+)/)?.[1];
  say(`tests: ${pass ?? '?'} passed, ${fail ?? '?'} failed`);
  if (t.status !== 0 || fail !== '0') problems.push(`tests failed:\n${out.split('\n').filter((l) => /^✖|not ok/.test(l)).slice(0, 8).join('\n')}`);
}

if (problems.length) { console.error(`\nNOT FIT TO COMMIT (${problems.length}):\n- ${problems.join('\n- ')}`); process.exit(1); }
say('\nAll checks passed.');
