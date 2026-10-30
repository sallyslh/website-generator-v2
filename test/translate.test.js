// Translate: texts change, everything else stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePage } from '../src/wow/translate.js';

const HTML = '<html lang="fr"><head><title>Cabinet dentaire</title></head><body><header><a href="a.html">Accueil</a></header><main><h1 class="t">Bienvenue chez dent de lait</h1><p>Ouvert de 8h à 19h <b>tous les jours</b></p><img src="a.jpg" alt="Une dentiste souriante"><span class="material-symbols-outlined">arrow_forward</span><span>+1 555 010 012</span><script>var x = "texte";</script></main></body></html>';
const sentOf = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('[')));

test('texts, picture descriptions and the title are translated; icons, numbers, links, scripts and classes stay', async () => {
  const seen = [];
  const ask = async ({ prompt }) => {
    const sent = sentOf(prompt);
    seen.push(...sent.map((s) => s.text));
    return { items: sent.map((s) => ({ i: s.i, text: `AR(${s.text})` })) };
  };
  const r = await translatePage(HTML, { language: 'Arabic', ask });
  assert.match(r.html, /<html lang="ar" dir="rtl">/);
  assert.match(r.html, /<title>AR\(Cabinet dentaire\)<\/title>/);
  assert.match(r.html, /<h1 class="t">AR\(Bienvenue chez dent de lait\)<\/h1>/);
  assert.match(r.html, /alt="AR\(Une dentiste souriante\)"/);
  assert.match(r.html, />arrow_forward</);
  assert.match(r.html, />\+1 555 010 012</);
  assert.match(r.html, /var x = "texte"/);
  assert.match(r.html, /href="a.html"/);
  assert.equal(seen.includes('arrow_forward'), false, 'icon names are not sent');
  assert.equal(seen.includes('+1 555 010 012'), false, 'numbers are not sent');
  assert.equal(r.translated, r.pieces);
});

test('a left-to-right target language gets no dir attribute, and a failing model leaves the page as it was', async () => {
  const ok = await translatePage(HTML, { language: 'Spanish', ask: async ({ prompt }) => ({ items: sentOf(prompt).map((s) => ({ i: s.i, text: 'ES' })) }) });
  assert.match(ok.html, /<html lang="es">/);
  assert.equal(ok.html.includes('dir="rtl"'), false);
  const bad = await translatePage(HTML, { language: 'Arabic', ask: async () => { throw new Error('down'); } });
  assert.equal(bad.translated, 0);
  assert.match(bad.html, /Bienvenue chez dent de lait/);
});
