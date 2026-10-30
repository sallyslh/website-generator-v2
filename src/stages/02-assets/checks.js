// Automatic quality checks for Stage 2 (no LLM). Each check returns { name, ok, details }.
// A photo whose file name starts with "bad-" or contains "blurry" is a known bad test photo.

import { exists, readJson } from '../../lib/project.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { scanAssets } from './scan.js';

const KNOWN_BAD = /(^|[/\\\-_ ])(bad|blurry)([\-_. ]|$)/i;

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'asset-manifest.json')) throw new Error(`Missing asset-manifest.json in "${projectId}". Run the assets stage first.`);
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });

  let manifest;
  try {
    manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
    check('schema valid', true);
  } catch (err) {
    check('schema valid', false, err.message);
    return results;
  }
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const { files } = scanAssets(projectId);

  // every supported file exactly once
  const listed = [...manifest.assets.map((a) => a.file), ...manifest.documents.map((d) => d.file)];
  const missing = files.filter((f) => !listed.includes(f.rel)).map((f) => f.name);
  const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
  const extra = listed.filter((f) => !files.some((x) => x.rel === f));
  check('every supported file is in the manifest exactly once', !missing.length && !dupes.length && !extra.length,
    [missing.length && `missing: ${missing}`, dupes.length && `duplicated: ${dupes}`, extra.length && `not on disk: ${extra}`].filter(Boolean).join('; '));

  // sizes come from the real files
  const wrong = [];
  for (const a of manifest.assets) {
    const real = files.find((f) => f.rel === a.file)?.info;
    if (real && (real.width !== a.width || real.height !== a.height || real.orientation !== a.orientation)) wrong.push(a.id);
  }
  check('width, height and orientation match the real files', !wrong.length, wrong.join(', '));

  // logo
  const hasLogoFile = files.some((f) => /^logo[.\-_ ]/i.test(f.name)) || manifest.assets.some((a) => a.kind === 'logo');
  check('a logo is set when a logo file exists', !hasLogoFile || manifest.logo !== null, hasLogoFile ? '' : 'no logo file in the folder');
  check('logo id points to a real asset', manifest.logo === null || manifest.assets.some((a) => a.id === manifest.logo));

  // quality rules
  const bad = files.filter((f) => KNOWN_BAD.test(f.name));
  const notLow = bad.filter((f) => manifest.assets.find((a) => a.file === f.rel)?.quality !== 'low').map((f) => f.name);
  check('known bad test photos are marked low', !notLow.length, bad.length ? notLow.join(', ') : 'no file named bad-* / *blurry* in this project (nothing to test)');
  const lowUsable = manifest.assets.filter((a) => a.quality === 'low' && a.usableFor.some((u) => u !== 'none')).map((a) => a.id);
  check('low quality images are not marked usable', !lowUsable.length, lowUsable.join(', '));

  // gaps
  const gapText = manifest.gaps.map((g) => `${g.need} ${g.reason}`).join(' ').toLowerCase();
  const wantsTeam = brief.pages.some((p) => /team|about|staff|doctor|lawyer/i.test(`${p.slug} ${p.title} ${p.purpose}`));
  const hasTeamPhotos = manifest.assets.some((a) => ['team', 'people'].includes(a.category) && a.quality !== 'low');
  check('a gap is listed for team photos when the brief needs them and none exist',
    !wantsTeam || hasTeamPhotos || /team|people|staff|portrait|lawyer|doctor|owner|family/.test(gapText), 'brief has a team/about page but no team photos and no gap');
  check('a gap is listed when there is no logo', manifest.logo !== null || /logo/.test(gapText), 'no logo and no logo gap');
  return results;
}
