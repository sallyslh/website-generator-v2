// Translate a drawn website into another language. Every visible text (and the picture descriptions, the page title) is translated by the model; the design, the
// pictures, the links, brand names, numbers, prices, phone numbers and e-mail addresses stay as they are. The site is then rebuilt in the new language (and mirrored
// when the language reads right to left, see rtl.js).
//   translateProject({ from, to, language })   copies a project into a new one and translates its drawn pages
//   translatePage(html, { language, ask })     one page

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { projectPath, exists, readJson, writeJson } from '../lib/project.js';
import { langCode, isRtl } from './rtl.js';

const cheerio = createRequire(import.meta.url)('cheerio');
const STAGE = 'wow-translate';
const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'template', 'code', 'pre']);
const ATTRS = ['alt', 'title', 'placeholder', 'aria-label'];
const BATCH = 70;
const BLOCK = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'td', 'th', 'dd', 'dt', 'figcaption', 'blockquote', 'label', 'button', 'a', 'header', 'footer', 'nav', 'main']);
const schema = z.object({ items: z.array(z.object({ i: z.number().int(), text: z.string() })) });

export const TRANSLATE_SYSTEM = (language) => `You translate the visible text of a website into ${language}. You get numbered pieces of text, each with the sentence or block it sits in for context.
- Translate naturally, the way a ${language}-speaking business owner would write for their customers (warm, clear, no word-for-word stiffness). Short button and menu labels stay short.
- Keep UNCHANGED: brand and business names, people's names, numbers, prices and currency signs, times, phone numbers, e-mail addresses, web addresses, and icon names written in lowercase_with_underscores.
- Keep the same punctuation style and any leading or trailing spaces out of the answer (the text is given trimmed).
- Answer JSON only: {"items":[{"i":1,"text":"..."}]} with every number you were given.`;

const isIconText = ($, node) => /material-symbols|material-icons/.test($(node.parent).attr('class') ?? '');
const blockOf = ($, node) => { let p = node.parent; while (p && p.type === 'tag' && !BLOCK.has(p.name)) p = p.parent; return p; };

// Collects what must be translated: [{ node | el+attr, text, context }]
function collect($) {
  const found = [];
  const walk = (node) => {
    if (node.type === 'text') {
      const t = node.data.replace(/\s+/g, ' ').trim();
      if (!t || /^[\d\s.,:;%$€£+\-–—/|·•()]+$/.test(t) || isIconText($, node)) return;
      const b = blockOf($, node); const ctx = b ? $(b).text().replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      found.push({ node, text: t, context: ctx === t ? '' : ctx });
      return;
    }
    if (node.type !== 'tag' || SKIP.has(node.name)) return;
    for (const a of ATTRS) { const v = node.attribs?.[a]; if (v && v.trim().length > 1 && !/^[\d\s.,:;%$€£+\-/]+$/.test(v)) found.push({ el: node, attr: a, text: v.trim(), context: '' }); }
    (node.children ?? []).forEach(walk);
  };
  const head = $('head title').first()[0]; if (head) walk(head);
  const body = $('body')[0]; if (body) (body.children ?? []).forEach(walk);
  return found;
}

export async function translatePage(html, { language, ask = askJson, projectId = null }) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const items = collect($);
  let translated = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const group = items.slice(i, i + BATCH);
    const payload = group.map((it, k) => ({ i: k + 1, text: it.text, ...(it.context ? { context: it.context } : {}) }));
    let answer = null;
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      try { answer = await ask({ projectId, stage: STAGE, system: TRANSLATE_SYSTEM(language), schema, maxTokens: 12000, prompt: `Translate into ${language}:\n${JSON.stringify(payload)}` }); } catch { answer = null; }
    }
    for (const r of answer?.items ?? []) {
      const it = group[r.i - 1]; const text = (r.text ?? '').trim();
      if (!it || !text) continue;
      if (it.node) it.node.data = it.node.data.replace(/\S[\s\S]*\S|\S/, () => text);
      else it.el.attribs[it.attr] = text;
      translated++;
    }
  }
  const lang = langCode(language);
  const out = $.html().replace(/<html\b([^>]*)>/i, (w, attrs) => `<html${attrs.replace(/\s(lang|dir)="[^"]*"/gi, '')} lang="${lang}"${isRtl(language) ? ' dir="rtl"' : ''}>`);
  return { html: out, pieces: items.length, translated };
}

// Copies a project's drawn pages into a new project and translates them. The new project is then built with the normal pipeline (step assemble).
export async function translateProject({ from, to, language, ask = askJson, log = () => {} }) {
  const src = projectPath(from, 'wow-design');
  if (!fs.existsSync(src)) throw new Error(`${from} has no drawn pages (wow-design).`);
  const dest = projectPath(to, 'wow-design');
  fs.rmSync(projectPath(to), { recursive: true, force: true });
  fs.mkdirSync(projectPath(to), { recursive: true });
  for (const f of ['wow-brief.json', 'wow-concept.json', 'wow-design.json', 'brand.json']) if (fs.existsSync(projectPath(from, f))) fs.copyFileSync(projectPath(from, f), projectPath(to, f));
  fs.cpSync(src, dest, { recursive: true });
  const meta = exists(from, 'wow.json') ? readJson(from, 'wow.json') : {};
  writeJson(to, 'wow.json', { ...meta, language, mode: 'draft' });
  const report = { pages: [], pieces: 0, translated: 0 };
  for (const f of fs.readdirSync(dest).filter((x) => x.endsWith('.html')).sort()) {
    const file = path.join(dest, f);
    const r = await translatePage(fs.readFileSync(file, 'utf8'), { language, ask, projectId: to });
    fs.writeFileSync(file, r.html);
    report.pages.push(f); report.pieces += r.pieces; report.translated += r.translated;
    log(`${f}: ${r.translated} of ${r.pieces} pieces translated`);
  }
  return report;
}
