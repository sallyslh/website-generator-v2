// The photo moves above the text on a phone; the laptop keeps its overlay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stackHero } from '../src/wow/hero.js';

const cheerio = createRequire(import.meta.url)('cheerio');
const HERO = `<html><body><header>h</header><section class="relative flex flex-col lg:flex-row px-5"><div class="absolute inset-0 z-0 rounded-2xl mx-5 md:mx-0"><img class="w-full h-full object-cover" src="a.jpg"><div class="hidden lg:block absolute inset-0 bg-gradient-to-t"></div></div><div class="relative z-10"><h1>Your corner</h1><a href="menu.html">Menu</a></div></section></body></html>`;

test('the photo wrapper becomes a landscape block on a phone and stays an overlay from the laptop width', () => {
  const r = stackHero(HERO);
  assert.equal(r.changed, true);
  const $ = cheerio.load(r.html);
  const wrap = $('section > div').first().attr('class').split(/\s+/);
  for (const c of ['relative', 'w-full', 'aspect-[4/3]', 'lg:absolute', 'lg:inset-0', 'lg:aspect-auto']) assert.ok(wrap.includes(c), c);
  for (const c of ['absolute', 'inset-0', 'mx-5']) assert.equal(wrap.includes(c), false, `${c} removed`);
  assert.ok(wrap.includes('md:mx-0'), 'prefixed classes stay');
  assert.equal($('h1').text(), 'Your corner');
});

test('a page without that hero, and a page already changed, are left alone', () => {
  assert.equal(stackHero('<html><body><h1>x</h1><section><p>plain</p></section></body></html>').changed, false);
  const once = stackHero(HERO);
  assert.equal(stackHero(once.html).changed, false);
});
