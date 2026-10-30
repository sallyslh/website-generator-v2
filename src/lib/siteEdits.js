// Edits the customer makes on the finished site: change a text, replace a picture or the logo, and go back to the original.
//
// How it works
//  - Stage 7 tags every editable text and picture of the generated pages with data-e="<scope>.<n>" (tagEditable). The scope is the
//    page slug, or "shared-header" / "shared-footer" for what every page shows.
//  - Each edit is saved in projects/<id>/edits.json WITH the original (originalRaw / originalHtml), so undo is exact. The first
//    edit also keeps a pristine copy of the generated pages in projects/<id>/edits/original-content/.
//  - applyEdits writes the current state of every edited key into site/src/content (what the next build uses) AND into the built
//    site/dist pages (so the customer sees the change at once, with no rebuild). It is idempotent, and Stage 7 calls it after a
//    regeneration, so edits survive a rebuild.
//  - Nothing here touches the design, the copy or the photo list: the generated site stays the original, the edits are a layer on top.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { projectPath } from './project.js';
import { requestsState, revertRequests } from './changeRequests.js';

export const KEY = /^[a-z0-9][a-z0-9-]*\.(\d+|img\d+|logo|logo-footer)$/;
export const MAX_TEXT = 600;
const TEXT_TAGS = 'p|h[1-6]|span|li|small|label|figcaption|em|strong|a|button|div|blockquote|cite|dt|dd|td|th';
const SKIPPED = /(<form\b[\s\S]*?<\/form>|<svg\b[\s\S]*?<\/svg>|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->)/gi;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
export const decode = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

// ---------- tagging (Stage 7) ----------

const outside = (html, fn) => html.split(SKIPPED).map((part, i) => (i % 2 ? part : fn(part))).join('');

// Adds data-e to the texts and pictures that a customer may edit. Texts with markup inside (a word in bold) are left alone.
export function tagEditable(html, scope) {
  let out = html;
  // the logo: the first drawing or picture inside the link to the home page, in the header and in the footer. One key for the whole
  // site (site.logo), so a new logo replaces it on every page.
  for (const [block, name] of [['header', 'logo'], ['footer', 'logo-footer']]) {
    out = out.replace(new RegExp(`<${block}\\b[\\s\\S]*?</${block}>`, 'i'), (part) => part.replace(/(<a\b[^>]*\bhref="\/"[^>]*>)([\s\S]*?)(<\/a>)/i, (whole, open, inner, close) => {
      if (/data-e="/.test(inner) || !/<(svg|img)\b/i.test(inner)) return whole;
      return open + inner.replace(/<(svg|img)\b/i, (m, t) => `<${t} data-e="site.${name}"`) + close;
    }));
  }
  let n = 0; let img = 0;
  out = outside(out, (part) => part
    .replace(new RegExp(`<(${TEXT_TAGS})\\b([^>]*)>([^<>]+)</\\1>`, 'gi'), (whole, tag, attrs, text) => {
      if (/\bdata-e="/.test(attrs) || /material-symbols|icon/i.test(attrs) || !/\p{L}/u.test(text) || /^[a-z0-9_]+$/.test(text.trim())) return whole;
      return `<${tag} data-e="${scope}.${n++}"${attrs}>${text}</${tag}>`;
    })
    .replace(/<img\b([^>]*)>/gi, (whole, attrs) => (/\bdata-e="/.test(attrs) ? whole : `<img data-e="${scope}.img${img++}"${attrs}>`)));
  return out;
}

// ---------- the saved edits ----------

const file = (projectId) => projectPath(projectId, 'edits.json');
export function readEdits(projectId) {
  try { return JSON.parse(fs.readFileSync(file(projectId), 'utf8')); } catch { return { schemaVersion: 1, items: {} }; }
}
const writeEdits = (projectId, data) => fs.writeFileSync(file(projectId), JSON.stringify(data, null, 2));
const siteDir = (projectId) => projectPath(projectId, 'site');
const contentDir = (projectId) => path.join(siteDir(projectId), 'src/content');
const fileOfScope = (scope) => (scope === 'shared-header' ? '_header.html' : scope === 'shared-footer' ? '_footer.html' : `${scope}.html`);
const scopeOf = (key) => key.slice(0, key.lastIndexOf('.'));
// "site" keys (the logo) live on every page; any other scope is one file
const contentFilesOf = (projectId, scope) => (scope === 'site' ? (fs.existsSync(contentDir(projectId)) ? fs.readdirSync(contentDir(projectId)).filter((f) => f.endsWith('.html')) : []) : [fileOfScope(scope)]);

// the pieces of one tagged element in a page
export const textRe = (key) => new RegExp(`(<(\\w+)\\b[^>]*\\bdata-e="${escRe(key)}"[^>]*>)([^<]*)(</\\2>)`);
export const picRe = (key) => new RegExp(`<img\\b[^>]*\\bdata-e="${escRe(key)}"[^>]*>|<svg\\b[^>]*\\bdata-e="${escRe(key)}"[^>]*>[\\s\\S]*?</svg>`);

// the markup an image edit puts in place of the original element
function pictureHtml(originalHtml, key, { src, alt }) {
  if (/^<img\b/i.test(originalHtml)) {
    return originalHtml.replace(/\bsrc="[^"]*"/i, `src="${escAttr(src)}"`).replace(/\balt="[^"]*"/i, `alt="${escAttr(alt)}"`).replace(/\s(srcset|sizes)="[^"]*"/gi, '');
  }
  const cls = originalHtml.match(/^<svg\b[^>]*\bclass="([^"]*)"/i)?.[1] ?? '';
  return `<img data-e="${key}" src="${escAttr(src)}" alt="${escAttr(alt)}" class="${escAttr(cls)}" style="object-fit:contain"/>`;
}

// Pure: puts the current state of every edit into one page's html. Returns the new html and the keys it did not find.
export function applyToHtml(html, items) {
  let out = html; const missing = [];
  for (const [key, it] of Object.entries(items)) {
    if (!out.includes(`data-e="${key}"`)) { missing.push(key); continue; }
    if (it.kind === 'text') {
      const wanted = it.current == null ? it.originalRaw : escText(it.current);
      out = out.replace(textRe(key), (m, open, tag, text, close) => open + wanted + close);
    } else {
      const html2 = it.current == null ? it.originalHtml : pictureHtml(it.originalHtml, key, it.current);
      out = out.replace(picRe(key), () => html2);
    }
  }
  return { html: out, missing };
}

const walkHtml = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkHtml(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : [])) : []);

// The customer's pictures live in projects/<id>/edits/images; a regenerated site starts empty, so they are put back where the build needs them.
function restoreEditPictures(projectId) {
  const from = projectPath(projectId, 'edits/images');
  if (!fs.existsSync(from)) return;
  const targets = ['originals', 'public/images', 'dist/images'].map((d) => path.join(siteDir(projectId), d)).filter((d, i) => i < 2 || fs.existsSync(d));
  for (const f of fs.readdirSync(from)) for (const t of targets) { fs.mkdirSync(t, { recursive: true }); fs.copyFileSync(path.join(from, f), path.join(t, f)); }
}

// Writes every edit into the page sources and the built pages. Safe to run again and again.
export function applyEdits(projectId) {
  const { items } = readEdits(projectId);
  const keys = Object.keys(items);
  if (!keys.length) return { missing: [] };
  restoreEditPictures(projectId);
  const missing = new Set();
  const dir = contentDir(projectId);
  for (const [scope, group] of Object.entries(Object.groupBy(keys, scopeOf))) {
    const found = new Set();
    for (const name of contentFilesOf(projectId, scope)) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      const { html, missing: m } = applyToHtml(fs.readFileSync(f, 'utf8'), Object.fromEntries(group.map((k) => [k, items[k]])));
      group.filter((k) => !m.includes(k)).forEach((k) => found.add(k));
      fs.writeFileSync(f, html);
    }
    group.filter((k) => !found.has(k)).forEach((k) => missing.add(k));
  }
  for (const f of walkHtml(path.join(siteDir(projectId), 'dist'))) { // the built pages (the shared header appears in every page)
    const before = fs.readFileSync(f, 'utf8');
    const { html } = applyToHtml(before, items);
    if (html !== before) fs.writeFileSync(f, html);
  }
  return { missing: [...missing] };
}

// ---------- what the customer sees and does ----------

const isReady = (projectId) => fs.existsSync(contentDir(projectId)) && fs.readdirSync(contentDir(projectId)).some((f) => /^[^_].*\.html$/.test(f) && /data-e="/.test(fs.readFileSync(path.join(contentDir(projectId), f), 'utf8')));

const before = (it) => (it.kind === 'text' ? decode(it.originalRaw).replace(/\s+/g, ' ').trim() : '');

export function editState(projectId) {
  const { items } = readEdits(projectId);
  const changes = Object.entries(items).filter(([, it]) => it.current != null).map(([key, it]) => ({
    key, kind: it.kind, page: scopeOf(key),
    before: it.kind === 'text' ? before(it) : 'the original picture', after: it.kind === 'text' ? it.current : it.current.alt, picture: it.kind === 'image' ? it.current.src : undefined, ai: it.kind === 'image' ? Boolean(it.current.ai) : undefined,
  }));
  return { ready: isReady(projectId), changes, requests: requestsState(projectId) };
}

function readElement(projectId, key, kind) {
  if (!KEY.test(key)) throw httpError(404, 'That part of the page was not found. Please reload the page.');
  let hit = null;
  for (const name of contentFilesOf(projectId, scopeOf(key))) {
    const f = path.join(contentDir(projectId), name);
    if (!hit && fs.existsSync(f)) { const html = fs.readFileSync(f, 'utf8'); hit = kind === 'text' ? html.match(textRe(key)) : html.match(picRe(key)); }
  }
  if (!hit) throw httpError(404, 'That part of the page has changed. Please reload the page.');
  return kind === 'text' ? hit[3] : hit[0];
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

// the first edit keeps a pristine copy of the generated pages: a way back even if the edits file is lost
function snapshotOriginal(projectId) {
  const dest = projectPath(projectId, 'edits/original-content');
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(contentDir(projectId))) fs.copyFileSync(path.join(contentDir(projectId), f), path.join(dest, f));
}

function change(projectId, key, kind, make) {
  if (!isReady(projectId)) throw httpError(409, 'The website is not ready for editing yet.');
  const data = readEdits(projectId);
  let it = data.items[key];
  if (!it) {
    snapshotOriginal(projectId);
    const el = readElement(projectId, key, kind);
    it = { kind, page: scopeOf(key), ...(kind === 'text' ? { originalRaw: el } : { originalHtml: el }), current: null, history: [] };
  }
  if (it.kind !== kind) throw httpError(400, 'That part of the page cannot be changed that way.');
  it.history.push(it.current);
  it.current = make(it);
  it.updatedAt = new Date().toISOString();
  data.items[key] = it;
  writeEdits(projectId, data);
  applyEdits(projectId);
  return editState(projectId);
}

export function editText(projectId, key, value) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw httpError(400, 'The text cannot be empty. To go back, press "Undo".');
  if (text.length > MAX_TEXT) throw httpError(400, `That text is too long (${MAX_TEXT} characters at most).`);
  return change(projectId, key, 'text', () => text);
}

// A new picture: checked, turned into a web-sized WebP and put where the build and the built site can use it.
export async function editImage(projectId, key, { bytes, alt, ai = false }) {
  const description = String(alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (description.length < 3) throw httpError(400, 'Please describe the picture in a few words (it helps people who cannot see it, and search engines).');
  let webp;
  try { webp = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); } catch { throw httpError(400, 'That file is not a picture we can use. Please choose a JPG, PNG or WebP photo.'); }
  const name = `edit-${crypto.createHash('sha1').update(webp).digest('hex').slice(0, 10)}`;
  const place = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.webp`), webp); };
  place(projectPath(projectId, 'edits/images'));
  place(path.join(siteDir(projectId), 'originals')); // the next build converts it like any other photo
  place(path.join(siteDir(projectId), 'public/images'));
  if (fs.existsSync(path.join(siteDir(projectId), 'dist'))) place(path.join(siteDir(projectId), 'dist/images')); // visible at once
  return change(projectId, key, 'image', () => ({ src: `/images/${name}.webp`, alt: description, ...(ai ? { ai: true } : {}) }));
}

// Undo: back to the previous value, or to the original when there is nothing before it.
export function undoEdit(projectId, key) {
  const data = readEdits(projectId);
  const it = data.items[key];
  if (!it || it.current == null) throw httpError(404, 'There is nothing to undo here.');
  it.current = it.history.length ? it.history.pop() : null;
  it.updatedAt = new Date().toISOString();
  writeEdits(projectId, data);
  applyEdits(projectId);
  return editState(projectId);
}

// Everything back to the original, in one step.
export function revertAll(projectId) {
  const data = readEdits(projectId);
  for (const it of Object.values(data.items)) { it.current = null; it.history = []; }
  writeEdits(projectId, data);
  applyEdits(projectId);
  revertRequests(projectId);
  return editState(projectId);
}

// The texts the customer wrote themselves: Stage 7's checks must not call them invented.
export const editedTexts = (projectId) => Object.values(readEdits(projectId).items).filter((it) => it.kind === 'text' && it.current != null).map((it) => it.current);
