import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctContactDetails, makeContactClickable } from '../src/lib/contactLinks.js';

const owner = { phone: '+961 3 220 330', whatsapp: '9613220330', email: 'hello@studionoor.example' };

test('a made-up phone link and its text become the owner\'s number', () => {
  const html = '<footer><a href="tel:+9611000000" class="x">+961 1 000 000</a></footer>';
  const r = correctContactDetails(html, owner);
  assert.equal(r.fixed, 1);
  assert.match(r.html, /href="tel:\+9613220330"[^>]*>\+961 3 220 330<\/a>/);
  assert.doesNotMatch(r.html, /000 000/);
});

test('the owner\'s own number (with or without the country code, spaces or a leading zero form) is left alone', () => {
  for (const n of ['+961 3 220 330', '+9613220330', '03 220 330', '3220330']) {
    const html = `<a href="tel:${n}">${n}</a>`;
    assert.equal(correctContactDetails(html, owner).html, html, n);
  }
});

test('a made-up email link is replaced (a button\'s words stay), an address shown as text is replaced', () => {
  const r = correctContactDetails('<a href="mailto:info@example.com">info@example.com</a><a href="mailto:info@example.com?subject=Hi">Write to us</a><a href="mailto:hello@studionoor.example">hello@studionoor.example</a>', owner);
  assert.equal(r.fixed, 2);
  assert.match(r.html, /href="mailto:hello@studionoor\.example">hello@studionoor\.example<\/a><a href="mailto:hello@studionoor\.example\?subject=Hi">Write to us<\/a>/);
  assert.doesNotMatch(r.html, /example\.com/);
});

test('a "+number" in plain text that is not the owner\'s is replaced; years, prices and hours are never touched', () => {
  const r = correctContactDetails('<p>Call +961 1 000 000 today. Open 09:00-18:00. Since 2019-2026. Sessions from 50,000 LBP.</p>', owner);
  assert.match(r.html, /Call \+961 3 220 330 today\. Open 09:00-18:00\. Since 2019-2026\. Sessions from 50,000 LBP\./);
});

test('when the owner gave no phone or email, the made-up ones are removed, never kept', () => {
  const r = correctContactDetails('<li><a href="tel:+9611000000">+961 1 000 000</a></li><a href="mailto:info@example.com">info@example.com</a><p>Call +961 1 000 000</p>', {});
  assert.doesNotMatch(r.html, /000 000|example\.com|tel:|mailto:/);
  assert.equal(r.removed.length, 3);
  // a WhatsApp number alone is a number the owner gave
  assert.match(correctContactDetails('<a href="tel:+9611000000">x</a>', { whatsapp: '96171014463' }).html, /tel:\+96171014463/);
});

test('the owner\'s WhatsApp link, email and phone written as plain text become clickable; text already in a link or button is left alone', () => {
  const o = { phone: '+961 1 330 440', whatsapp: '96171330440', email: 'hello@laylaskin.example' };
  const r = makeContactClickable('<p>Message us: https://wa.me/96171330440</p><p>hello@laylaskin.example</p><p>+961 1 330 440</p>', o);
  assert.equal(r.linked, 3);
  assert.ok(r.html.includes('<a href="https://wa.me/96171330440" target="_blank" rel="noopener noreferrer">+961 1 330 440</a>'));
  assert.ok(r.html.includes('<a href="mailto:hello@laylaskin.example">hello@laylaskin.example</a>'));
  assert.ok(r.html.includes('<a href="tel:+9611330440">+961 1 330 440</a>'));
  const keep = '<a href="mailto:hello@laylaskin.example">hello@laylaskin.example</a><button>https://wa.me/96171330440</button><head><title>hello@laylaskin.example</title></head><script>var a="hello@laylaskin.example"</script>';
  assert.equal(makeContactClickable(keep, o).html, keep);
  assert.equal(makeContactClickable('<p>https://wa.me/96170000000 other@x.com</p>', o).linked, 0); // never someone else's
  assert.equal(makeContactClickable('<p>x@y.com</p>', {}).html, '<p>x@y.com</p>');
});
