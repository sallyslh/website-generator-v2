// Tests for all schemas, cross-checks and project.js, using the demo-restaurant fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILES } from '../src/schemas/index.js';
import { crossCheck } from '../src/schemas/crossChecks.js';
import { validate as validateBrief } from '../src/schemas/siteBrief.js';
import { readJson, writeJson, setProjectsRoot, projectPath } from '../src/lib/project.js';

const FIXTURES = path.resolve('test/fixtures');
setProjectsRoot(FIXTURES);
const ID = 'demo-restaurant';
const load = (file) => readJson(ID, file); // raw, unvalidated
const clone = (x) => structuredClone(x);

// Two deliberately broken versions per schema: [description, function that breaks a copy, expected text in error]
const BROKEN = {
  'site-brief.json': [
    ['no home page', (d) => { d.pages = d.pages.filter((p) => p.slug !== 'home'); }, 'home'],
    ['unknown feature type', (d) => { d.features.push({ type: 'live-chat' }); }, 'features'],
    ['wrong schemaVersion', (d) => { d.schemaVersion = 2; }, 'schemaVersion'],
  ],
  'asset-manifest.json': [
    ['bad category', (d) => { d.assets[0].category = 'selfie'; }, 'assets.0.category'],
    ['missing width', (d) => { delete d.assets[0].width; }, 'assets.0.width'],
  ],
  'design-spec.json': [
    ['slot without id', (d) => { delete d.pages[0].sections[0].slots[0].id; }, 'slots.0.id'],
    ['missing colors', (d) => { delete d.colors.primary; }, 'colors.primary'],
  ],
  'content-spec.json': [
    ['SEO title too long', (d) => { d.pages[0].seo.title = 'x'.repeat(61); }, 'seo.title'],
    ['SEO description too long', (d) => { d.pages[0].seo.description = 'x'.repeat(156); }, 'seo.description'],
  ],
  'design/design-manifest.json': [
    ['bad status', (d) => { d.pages[0].status = 'done'; }, 'pages.0.status'],
    ['pages not a list', (d) => { d.pages = 'home'; }, 'pages'],
  ],
  'approved-design.json': [
    ['missing approvedAt', (d) => { delete d.approvedAt; }, 'approvedAt'],
    ['slotAssets value is a number', (d) => { d.slotAssets['home-hero-image'] = 5; }, 'slotAssets'],
  ],
  'review-log.json': [
    ['bad decision', (d) => { d[0].decision = 'maybe'; }, '0.decision'],
    ['bad routedTo', (d) => { d[0].routedTo = 'nowhere'; }, '0.routedTo'],
  ],
  'qa-report.json': [
    ['passed is a string', (d) => { d.passed = 'yes'; }, 'passed'],
    ['bad check status', (d) => { d.checks[0].status = 'ok'; }, 'checks.0.status'],
  ],
};

for (const [file, { schema }] of Object.entries(FILES)) {
  test(`${file}: fixture passes`, () => {
    const result = schema.safeParse(load(file));
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  for (const [what, breakIt, expected] of BROKEN[file]) {
    test(`${file}: fails when ${what}`, () => {
      const data = clone(load(file));
      breakIt(data);
      const result = schema.safeParse(data);
      assert.equal(result.success, false);
      const text = result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('\n');
      assert.ok(text.includes(expected), `expected "${expected}" in:\n${text}`);
    });
  }
}

test('validate() helper returns readable errors', () => {
  const data = clone(load('site-brief.json'));
  data.pages = [];
  const r = validateBrief(data);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /pages/);
});

function loadAll() {
  return {
    brief: load('site-brief.json'),
    assets: load('asset-manifest.json'),
    design: load('design-spec.json'),
    content: load('content-spec.json'),
  };
}

test('cross-checks: fixture is clean', () => {
  assert.deepEqual(crossCheck(loadAll()), []);
});

test('cross-checks: page missing in design-spec', () => {
  const all = loadAll();
  all.design.pages = all.design.pages.filter((p) => p.slug !== 'menu');
  assert.ok(crossCheck(all).some((p) => p.includes('missing page "menu"')));
});

test('cross-checks: section id mismatch in content-spec', () => {
  const all = loadAll();
  all.content.pages[0].sections[0].id = 'home-banner';
  const problems = crossCheck(all);
  assert.ok(problems.some((p) => p.includes('missing section "home-hero"')));
  assert.ok(problems.some((p) => p.includes('unknown section "home-banner"')));
});

test('cross-checks: unknown assigned asset', () => {
  const all = loadAll();
  all.design.pages[0].sections[0].slots[0].assignedAsset = 'asset-999';
  assert.ok(crossCheck(all).some((p) => p.includes('asset-999')));
});

test('cross-checks: duplicate slot ids', () => {
  const all = loadAll();
  all.design.pages[0].sections[1].slots[0].id = 'home-hero-image';
  assert.ok(crossCheck(all).some((p) => p.includes('duplicate slot id')));
});

test('project.js: write validates, backs up, and refuses invalid data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  setProjectsRoot(tmp);
  try {
    const schema = FILES['qa-report.json'].schema;
    const good = clone(load0());
    writeJson('p1', 'qa-report.json', good, schema);
    assert.ok(!fs.existsSync(projectPath('p1', 'qa-report.prev.json')));
    good.passed = true;
    writeJson('p1', 'qa-report.json', good, schema);
    assert.ok(fs.existsSync(projectPath('p1', 'qa-report.prev.json')));
    assert.throws(() => writeJson('p1', 'qa-report.json', { nope: 1 }, schema), /invalid/);
    assert.throws(() => readJson('p1', 'site-brief.json'), /Stage 1/);
  } finally {
    setProjectsRoot(FIXTURES);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function load0() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, ID, 'qa-report.json'), 'utf8'));
}
