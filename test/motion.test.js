// Tests for the motion layer: tuned by style, always guarded for reduced motion, only transform and opacity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionCss, motionJs, MOTION_STYLES } from '../src/stages/07-site/motion.js';
import { layoutAstro, globalCss } from '../src/stages/07-site/templates.js';
import { designSpecSchema } from '../src/schemas/designSpec.js';
import { checkSite } from '../src/stages/07-site/checks.js';
import fs from 'node:fs';
import path from 'node:path';

const layout = (motion) => layoutAstro({ lang: 'en', rtl: false, htmlClass: '', fontLinks: [], themeColor: '#000', hasHeader: true, hasFooter: true, siteTitle: 'T', logo: false, motion });

test('every style is guarded: motion only applies when the visitor has not asked for less, and only transform and opacity move', () => {
  for (const style of Object.keys(MOTION_STYLES)) {
    const css = motionCss(style);
    const guarded = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.ok(css.includes('@media (prefers-reduced-motion: no-preference)'), `${style}: guard present`);
    assert.ok(!/\b(width|height|top|left|margin|padding)\s*:\s*[^;]*;[^}]*transition/.test(guarded), `${style}: nothing that re-flows the page`);
    assert.match(css, /transition: opacity .* transform /);
    assert.match(motionJs(style), /prefers-reduced-motion: reduce\)'\)\.matches \|\| !\('IntersectionObserver' in window\)\) return;/, `${style}: the script stops itself`);
    new Function(motionJs(style)); // valid JavaScript
  }
  assert.ok(motionCss('bold').includes('[data-parallax]') && !motionCss('calm').includes('[data-parallax]'), 'only the bold style has parallax');
  assert.ok(motionCss('lively').includes('hover: hover') && !motionCss('calm').includes('hover: hover'), 'calm has no hover movement');
  assert.ok(Number.parseFloat(MOTION_STYLES.bold.rise) > Number.parseFloat(MOTION_STYLES.calm.rise), 'bold moves further than calm');
});

test('the layout loads the motion files and marks its style; "none" loads nothing; the header, footer and first screen are never hidden up front', () => {
  const calm = layout('calm');
  assert.match(calm, /data-motion="calm"/);
  assert.match(calm, /<link rel="stylesheet" href="\/motion\.css" \/>/);
  assert.match(calm, /<script src="\/motion\.js" defer><\/script>/);
  const none = layout('none');
  assert.ok(!/motion/.test(none), 'no motion files, no attribute');
  assert.ok(!/\.reveal/.test(globalCss([])), 'the old fade-in is gone');
  const js = motionJs('calm');
  assert.ok(js.includes("var chrome = 'header, footer, nav'") && js.includes('sections.slice(1)'), 'the first section only gets an entrance animation');
});

test('older designs without a motion field move calmly; the director\'s choice is validated', () => {
  const base = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/design-spec.json'), 'utf8'));
  delete base.motion;
  assert.equal(designSpecSchema.parse(base).motion.style, 'calm');
  assert.equal(designSpecSchema.parse({ ...base, motion: { style: 'bold', reason: 'young brand' } }).motion.style, 'bold');
  assert.throws(() => designSpecSchema.parse({ ...base, motion: { style: 'wild' } }));
});

test('the site check notices pages that load motion files the build does not contain', () => {
  const brief = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/site-brief.json'), 'utf8'));
  const content = { global: { siteTitle: 'T', footerText: '', primaryCta: { label: 'x', href: '/' }, navigation: [] }, pages: [] };
  const run = (distFiles) => checkSite({ brief, content, approvedSlugs: ['home'], pages: [{ slug: 'home', html: '<html><link href="/motion.css"><script src="/motion.js"></script></html>' }], distFiles: new Set(distFiles), built: true, report: { pages: [] } })
    .find((r) => /motion files/.test(r.name));
  assert.equal(run(['/motion.css', '/motion.js']).ok, true);
  assert.equal(run(['/motion.css']).ok, false);
});
