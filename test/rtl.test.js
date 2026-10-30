// Right-to-left languages: the layout mirrors, the left-to-right page is never changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRtl, langCode, mirror, rtlPage } from '../src/wow/rtl.js';

test('which languages are right to left', () => {
  for (const l of ['Arabic', 'arabic', 'Persian', 'Urdu', 'ar', 'fa-IR']) assert.equal(isRtl(l), true, l);
  for (const l of ['English', 'French', 'Spanish', 'German', 'Armenian', 'Hebrew', 'he', '']) assert.equal(isRtl(l), false, l);
  assert.equal(langCode('Arabic'), 'ar'); assert.equal(langCode('Persian'), 'fa');
});

test('physical classes get a mirrored twin, with their variants', () => {
  assert.deepEqual(mirror('ml-4'), ['rtl:mr-4', 'rtl:ml-0']);
  assert.deepEqual(mirror('-mr-2'), ['rtl:-ml-2', 'rtl:mr-0']);
  assert.deepEqual(mirror('md:pl-6'), ['md:rtl:pr-6', 'md:pl-0'.replace('md:pl-0', 'md:rtl:pl-0')]);
  assert.deepEqual(mirror('left-1/2'), ['rtl:right-1/2', 'rtl:left-auto']);
  assert.deepEqual(mirror('text-left'), ['rtl:text-right']);
  assert.deepEqual(mirror('rounded-l-xl'), ['rtl:rounded-r-xl', 'rtl:rounded-l-none']);
  assert.deepEqual(mirror('bg-gradient-to-r'), ['rtl:bg-gradient-to-l']);
  assert.deepEqual(mirror('space-x-4'), ['rtl:space-x-reverse']);
  assert.deepEqual(mirror('lg:hover:ml-2'), ['lg:hover:rtl:mr-2', 'lg:hover:rtl:ml-0']);
  for (const same of ['flex', 'p-4', 'mx-auto', 'text-center', 'w-[calc(100%-4px)]', 'md:grid-cols-3']) assert.deepEqual(mirror(same), [], same);
});

test('a page becomes right to left: dir and language, mirrored classes, flipped arrows, an Arabic font; the original classes stay', () => {
  const html = '<html lang="en"><head><title>x</title></head><body><div class="flex ml-4 text-left"><span class="material-symbols-outlined">arrow_forward</span></div></body></html>';
  const out = rtlPage(html, 'Arabic');
  assert.match(out, /<html lang="ar" dir="rtl">/);
  assert.match(out, /class="flex ml-4 text-left rtl:mr-4 rtl:ml-0 rtl:text-right"/);
  assert.match(out, />arrow_back</); assert.match(out, /Cairo/);
  assert.equal(rtlPage(out, 'Arabic'), out, 'running it twice changes nothing more');
});

test('phone numbers, e-mail addresses and links keep their left-to-right order inside right-to-left text', async () => {
  const { isolateNumbers } = await import('../src/wow/rtl.js');
  const out = isolateNumbers('<p>اتصل بنا</p><span class="x">+1 555 010 012</span><a href="tel:+15550100">اتصل</a><a href="mailto:a@b.com">a@b.com</a><p>نص عادي من 8 إلى 19</p>');
  assert.match(out, /<span class="x" dir="ltr">\+1 555 010 012<\/span>/);
  assert.match(out, /<a href="tel:\+15550100" dir="ltr">/);
  assert.match(out, /<a href="mailto:a@b.com" dir="ltr">a@b.com<\/a>/);
  assert.equal(out.includes('<p>اتصل بنا</p>'), true, 'ordinary Arabic text is left alone');
  assert.equal((out.match(/dir="ltr"/g) || []).length, 3);
  assert.equal(isolateNumbers(out), out, 'running it twice changes nothing');
});
