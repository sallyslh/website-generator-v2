// Tests for Stage 6 (no API calls): choosing a sketch, approving pages, changing the style, and the checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseSketch, approvePages, run } from '../src/stages/06-review/index.js';
import { checkReview } from '../src/stages/06-review/checks.js';
import { setProjectsRoot, projectPath, readJson, writeJson, exists } from '../src/lib/project.js';
import { designManifestSchema } from '../src/schemas/designManifest.js';
import { siteBriefSchema } from '../src/schemas/siteBrief.js';
import { designSpecSchema } from '../src/schemas/designSpec.js';
import { assetManifestSchema } from '../src/schemas/assetManifest.js';
import { approvedDesignSchema } from '../src/schemas/approvedDesign.js';
import { reviewLogSchema } from '../src/schemas/reviewLog.js';

const FIXTURE = path.resolve('test/fixtures/demo-restaurant');
const ID = 'review-test';

// a project that has the two sketches of the home page (fixture files + a freestyle sketch)
function makeProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  setProjectsRoot(tmp);
  fs.cpSync(FIXTURE, projectPath(ID), { recursive: true });
  for (const f of ['approved-design.json', 'review-log.json', 'qa-report.json']) fs.rmSync(projectPath(ID, f), { force: true });
  const manifest = readJson(ID, 'design/design-manifest.json', designManifestSchema);
  manifest.pages[0].status = 'generated';
  writeJson(ID, 'design/design-manifest.json', manifest, designManifestSchema);
  fs.mkdirSync(projectPath(ID, 'design/freestyle'), { recursive: true });
  fs.writeFileSync(projectPath(ID, 'design/freestyle/meta.json'), JSON.stringify({ stitchProjectId: 'sp2', screenId: 'fs1', html: 'design/freestyle/home-freestyle.html', screenshot: 'design/freestyle/home-freestyle.png', promptUsed: 'p' }));
  for (const f of ['design/home.html', 'design/freestyle/home-freestyle.html', 'design/menu.html', 'design/about.html', 'design/contact.html']) { fs.mkdirSync(path.dirname(projectPath(ID, f)), { recursive: true }); fs.writeFileSync(projectPath(ID, f), '<html></html>'); }
  return tmp;
}
const addOtherPages = () => {
  const manifest = readJson(ID, 'design/design-manifest.json', designManifestSchema);
  for (const slug of ['menu', 'about', 'contact']) manifest.pages.push({ slug, screenId: `${slug}1`, html: `design/${slug}.html`, screenshot: `design/${slug}.png`, variants: [], promptUsed: 'p', status: 'generated' });
  writeJson(ID, 'design/design-manifest.json', manifest, designManifestSchema);
};
const cleanup = (tmp) => { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); };
const stage6Checks = () => checkReview({
  brief: readJson(ID, 'site-brief.json', siteBriefSchema), design: readJson(ID, 'design-spec.json', designSpecSchema), assets: readJson(ID, 'asset-manifest.json', assetManifestSchema),
  manifest: readJson(ID, 'design/design-manifest.json', designManifestSchema), approved: readJson(ID, 'approved-design.json', approvedDesignSchema),
  reviewLog: readJson(ID, 'review-log.json', reviewLogSchema), fileExists: (f) => fs.existsSync(projectPath(ID, f)),
});

test('choosing sketch 1 approves the home page and logs the decision with the customer note', () => {
  const tmp = makeProject();
  try {
    assert.throws(() => chooseSketch(ID, { choice: 3 }), /sketch 1 or 2/);
    chooseSketch(ID, { choice: 1, note: 'make the logo bigger' });
    const manifest = readJson(ID, 'design/design-manifest.json', designManifestSchema);
    assert.equal(manifest.chosenSketch, 1);
    assert.equal(manifest.pages[0].status, 'approved');
    const log = readJson(ID, 'review-log.json', reviewLogSchema);
    assert.deepEqual([log[0].page, log[0].decision, log[0].comment], ['home', 'approve', 'make the logo bigger']);
  } finally { cleanup(tmp); }
});

test('sketch 2 needs its own Stitch project; it is remembered in the manifest', () => {
  const tmp = makeProject();
  try {
    fs.rmSync(projectPath(ID, 'design/freestyle/meta.json'));
    assert.throws(() => chooseSketch(ID, { choice: 2 }), /not been generated/);
    fs.writeFileSync(projectPath(ID, 'design/freestyle/meta.json'), JSON.stringify({ stitchProjectId: 'sp2', screenId: 'fs1', html: 'design/freestyle/home-freestyle.html', screenshot: 'design/freestyle/home-freestyle.png', promptUsed: 'p' }));
    chooseSketch(ID, { choice: 2 });
    const manifest = readJson(ID, 'design/design-manifest.json', designManifestSchema);
    assert.equal(manifest.chosenSketch, 2);
    assert.equal(manifest.freestyle.stitchProjectId, 'sp2');
  } finally { cleanup(tmp); }
});

test('approving needs every page; then approved-design.json is written and passes every check', () => {
  const tmp = makeProject();
  try {
    assert.throws(() => approvePages(ID), /Choose sketch 1 or 2 first/);
    chooseSketch(ID, { choice: 2, note: 'prefer a lighter background' });
    assert.throws(() => approvePages(ID), /not generated yet: menu, about, contact/);
    addOtherPages();
    const approved = approvePages(ID);
    assert.deepEqual(approved.pages.map((p) => p.slug), ['home', 'menu', 'about', 'contact']);
    assert.equal(approved.pages[0].html, 'design/freestyle/home-freestyle.html', 'home is the chosen sketch 2');
    assert.equal(approved.slotAssets['home-hero-image'], 'asset-001');
    assert.equal(approved.slotAssets['about-story-image'], null);
    assert.deepEqual(approved.reviewNotes, ['prefer a lighter background']);
    const failed = stage6Checks().filter((c) => !c.ok);
    assert.deepEqual(failed, []);
  } finally { cleanup(tmp); }
});

test('changing the style marks the other pages as outdated and removes the old approval', () => {
  const tmp = makeProject();
  try {
    chooseSketch(ID, { choice: 1 });
    addOtherPages();
    approvePages(ID);
    assert.ok(exists(ID, 'approved-design.json'));
    const r = chooseSketch(ID, { choice: 2 });
    assert.equal(r.changedStyle, true);
    assert.ok(!exists(ID, 'approved-design.json'));
    const manifest = readJson(ID, 'design/design-manifest.json', designManifestSchema);
    assert.deepEqual(manifest.pages.filter((p) => p.status === 'changes-requested').map((p) => p.slug), ['menu', 'about', 'contact']);
    assert.throws(() => approvePages(ID), /old style/);
  } finally { cleanup(tmp); }
});

test('run() uses the choice the customer saved, and checks catch a missing approval', async () => {
  const tmp = makeProject();
  try {
    await assert.rejects(() => run({ projectId: ID, options: {} }), /Nothing is chosen yet/);
    fs.writeFileSync(projectPath(ID, 'customer-choice.json'), JSON.stringify({ choice: 1, note: 'love it' }));
    await run({ projectId: ID, options: {} });
    assert.equal(readJson(ID, 'design/design-manifest.json', designManifestSchema).chosenSketch, 1);
    addOtherPages();
    await run({ projectId: ID, options: { approveAll: true } });
    assert.deepEqual(stage6Checks().filter((c) => !c.ok), []);
    // break the approval on purpose
    const approved = readJson(ID, 'approved-design.json', approvedDesignSchema);
    approved.pages = approved.pages.filter((p) => p.slug !== 'contact');
    approved.slotAssets['home-hero-image'] = 'asset-999';
    writeJson(ID, 'approved-design.json', approved, approvedDesignSchema);
    const names = stage6Checks().filter((c) => !c.ok).map((c) => c.name);
    assert.ok(names.some((n) => n.includes('every page of the brief is approved')));
    assert.ok(names.some((n) => n.includes('mapped to a real asset')));
  } finally { cleanup(tmp); }
});
