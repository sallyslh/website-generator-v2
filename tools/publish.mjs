// Publishes finished sites to the GitHub preview link, and ONLY if every gate passes on the built copy that would go online.
//   node tools/publish.mjs <repo folder> <live url> <projectId>[:<folder>[:<title>]] ...
// 1. builds one folder with the sites (pages, styles, pictures)   2. runs all gates on each site of that folder
// 3. if anything is blocked: stops, the repo is not touched      4. otherwise commits and pushes (git -C <repo>, so never the wrong repository)
// 5. waits for the live link and checks that the pages and the style files are really there
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { runGates } from '../src/wow/gates.js';

const [repoArg, liveArg, ...specs] = process.argv.slice(2);
if (!repoArg || !liveArg || !specs.length) { console.log('Usage: node tools/publish.mjs <repo folder> <live url> <projectId>[:<folder>[:<title>]] ...'); process.exit(1); }
const repo = path.resolve(repoArg); const live = liveArg.replace(/\/$/, '');
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const origin = git('remote', 'get-url', 'origin').stdout.trim();
if (!origin || !fs.existsSync(path.join(repo, '.git'))) { console.log(`${repo} is not a git repository with an origin.`); process.exit(1); }
console.log(`publishing to ${origin} (${live})`);

const tmp = path.resolve('projects', `_publish-${Date.now()}`);
const build = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/build-share.mjs', tmp, ...specs], { encoding: 'utf8' });
if (build.status !== 0) { console.log('the build failed:\n' + build.stdout + build.stderr); process.exit(1); }
const folders = specs.map((s) => s.split(':')[1] ?? s.split(':')[0]);
let blocked = false;
for (const folder of folders) {
  console.log(`\n== gates: ${folder}`);
  const r = runGates({ dir: path.join(tmp, folder), log: (m) => console.log('  ' + m) });
  if (!r.ok) { blocked = true; console.log(`  BLOCKED (${r.blockers.length}):\n` + r.blockers.map((b) => '    - ' + b).join('\n')); }
  if (r.warnings.length) console.log(`  warnings (${r.warnings.length}):\n` + r.warnings.map((w) => '    - ' + w).join('\n'));
}
if (blocked) { console.log('\nNOT PUBLISHED: fix the blockers above first. The repository was not touched.'); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); }

for (const f of fs.readdirSync(repo)) if (f !== '.git') fs.rmSync(path.join(repo, f), { recursive: true, force: true });
fs.cpSync(tmp, repo, { recursive: true }); fs.rmSync(tmp, { recursive: true, force: true });
git('add', '-A');
const commit = git('-c', 'user.name=sallyslh', '-c', 'user.email=sallysaleh049@gmail.com', 'commit', '-m', `Publish ${folders.join(' + ')} (all gates passed)\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`);
console.log(commit.status === 0 ? 'committed' : 'nothing new to commit');
for (const target of ['main', 'main:root']) { const p = git('push', 'origin', target); console.log(`push ${target}: ${(p.stderr + p.stdout).trim().split('\n').pop()}`); if (p.status !== 0) process.exit(3); }

let bad = [];
for (let attempt = 0; attempt < 12; attempt++) {
  bad = [];
  for (const folder of folders) for (const file of ['index.html', 'styles.css']) {
    const res = await fetch(`${live}/${folder}/${file}`, { cache: 'no-store' }).catch(() => null);
    if (!res || res.status !== 200) bad.push(`${folder}/${file}`);
  }
  if (!bad.length) break;
  await new Promise((r) => setTimeout(r, 15000));
}
console.log(bad.length ? `\nPUSHED, but not yet online: ${bad.join(', ')}` : `\nLIVE and checked: ${live}/`);
process.exit(bad.length ? 4 : 0);
