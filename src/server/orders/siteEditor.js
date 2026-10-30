// The owner edits the delivered website: change a text, replace a picture or the logo, undo each change, go back to the original.
//
//   base copy      the built website (dist). It is never changed, so there is always a way back.
//   editable copy  the owner's changes, kept in the business's own database (what each piece was, what it is now, and every step before),
//                  and the pictures they upload in the business's own folder. They are put on the page when it is shown.
// The pieces that can be edited are the ones the build tagged with data-e="<page>.<n>" (see lib/siteEdits.js, the same way the website was
// edited before delivery). Owner only: the server checks it. Nobody else, including the team that built the website, can open this.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { applyToHtml, KEY, MAX_TEXT, decode, textRe, picRe } from '../../lib/siteEdits.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const scopeOf = (key) => key.slice(0, key.lastIndexOf('.'));
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PICTURE_KEY = /\.(img\d+|logo|logo-footer)$/;

export function createSiteEditor({ store, dir, dist }) {
  const imagesDir = path.join(dir, 'edit-images');

  const htmlFiles = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const f = path.join(d, e.name); if (e.isDirectory()) { if (out.length < 300) walk(f); } else if (e.name.endsWith('.html')) out.push(f); } };
    walk(dist);
    return out;
  };
  const routeOf = (file) => { const r = path.relative(dist, file).replace(/\\/g, '/').replace(/index\.html$/, ''); return r ? `/${r.replace(/\/?$/, '/')}` : '/'; };
  const pages = () => htmlFiles().filter((f) => !/404\.html$/.test(f)).map((f) => ({ route: routeOf(f) })).sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));

  // what the built website (the base copy) has at one key: the same text or picture on whichever page shows it first
  function findOriginal(key, kind) {
    if (!KEY.test(key)) throw httpError(404, 'That part of the page was not found. Please reload the page.');
    for (const f of htmlFiles()) {
      const html = fs.readFileSync(f, 'utf8');
      const hit = kind === 'text' ? html.match(textRe(key)) : html.match(picRe(key));
      if (hit) return kind === 'text' ? hit[3] : hit[0];
    }
    throw httpError(404, 'That part of the page has changed. Please reload the page.');
  }

  // After the website is rebuilt, the numbering of the texts can shift. An edit is only put on a text that is STILL the one the owner changed
  // (compared with what it was before the edit); if the text moved, it is followed to its new number (same page, only when exactly one text
  // matches); if it cannot be found any more, it is not put on a different text by mistake and the owner is told.
  const norm = (s) => decode(String(s)).replace(/\s+/g, ' ').trim();
  const noKey = (s) => String(s).replace(/\sdata-e="[^"]*"/, '');
  function place(html, items) {
    const placed = {};
    for (const [key, it] of Object.entries(items)) {
      if (it.kind === 'text') {
        const m = html.match(textRe(key));
        if (m && norm(m[3]) === norm(it.originalRaw)) { placed[key] = it; continue; }
        if (!html.includes(`data-e="${scopeOf(key)}.`)) continue; // this page does not show that part
        const found = []; const rx = new RegExp(`<(\\w+)\\b[^>]*\\bdata-e="(${escRe(scopeOf(key))}\\.\\d+)"[^>]*>([^<]*)</\\1>`, 'g');
        for (let h = rx.exec(html); h; h = rx.exec(html)) if (norm(h[3]) === norm(it.originalRaw) && !(h[2] in items)) found.push(h[2]);
        if (found.length === 1) placed[found[0]] = it;
      } else {
        const m = html.match(picRe(key));
        if (m && noKey(m[0]) === noKey(it.originalHtml)) placed[key] = it;
      }
    }
    return placed;
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // the owner's edits that no page of the website can take any more
  function lostKeys(items) {
    const files = htmlFiles().map((f) => fs.readFileSync(f, 'utf8'));
    return Object.keys(items).filter((key) => !files.some((html) => Object.values(place(html, { [key]: items[key] })).length));
  }

  const before = (it) => (it.kind === 'text' ? decode(it.originalRaw).replace(/\s+/g, ' ').trim() : '');
  function state() {
    const items = store.editItems();
    const changes = Object.entries(items).filter(([, it]) => it.current != null).map(([key, it]) => ({
      key, kind: it.kind, page: scopeOf(key),
      before: it.kind === 'text' ? before(it) : 'the original picture', after: it.kind === 'text' ? it.current : it.current.alt, picture: it.kind === 'image' ? it.current.src : undefined,
    }));
    const lost = new Set(lostKeys(Object.fromEntries(Object.entries(items).filter(([, it]) => it.current != null))));
    return { ready: true, changes: changes.map((c) => (lost.has(c.key) ? { ...c, outdated: true } : c)), pages: pages(), requests: [] };
  }

  // The page as the visitors see it: the base copy with the owner's changes on top. original: the base copy as it is.
  function apply(html, { original = false } = {}) {
    if (original) return html;
    const items = Object.fromEntries(Object.entries(store.editItems()).filter(([, it]) => it.current != null));
    if (!Object.keys(items).length) return html;
    const placed = place(html, items);
    return Object.keys(placed).length ? applyToHtml(html, placed).html : html;
  }

  function change(key, kind, make) {
    const items = store.editItems();
    let it = items[key];
    if (!it) {
      const el = findOriginal(key, kind);
      it = { kind, page: scopeOf(key), ...(kind === 'text' ? { originalRaw: el } : { originalHtml: el }), current: null, history: [] };
    }
    if (it.kind !== kind) throw httpError(400, 'That part of the page cannot be changed that way.');
    it.history.push(it.current);
    it.current = make(it);
    it.updatedAt = new Date().toISOString();
    store.saveEditItem(key, it);
    return state();
  }

  function text(key, value) {
    if (PICTURE_KEY.test(String(key))) throw httpError(400, 'That part of the page cannot be changed that way.');
    const t = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim();
    if (!t) throw httpError(400, 'The text cannot be empty. To go back, press "Undo".');
    if (t.length > MAX_TEXT) throw httpError(400, `That text is too long (${MAX_TEXT} characters at most).`);
    return change(key, 'text', () => t);
  }

  // A new picture: checked, turned into a web-sized WebP, kept in the business's own folder and shown at once.
  async function image(key, { bytes, alt }) {
    if (!PICTURE_KEY.test(String(key))) throw httpError(400, 'That part of the page cannot be changed that way.');
    const description = String(alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (description.length < 3) throw httpError(400, 'Please describe the picture in a few words (it helps people who cannot see it, and search engines).');
    let webp;
    try { webp = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); }
    catch { throw httpError(400, 'That file is not a picture we can use. Please choose a JPG, PNG or WebP photo.'); }
    const name = `edit-${crypto.createHash('sha1').update(webp).digest('hex').slice(0, 10)}`;
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, `${name}.webp`), webp);
    return change(key, 'image', () => ({ src: `/images/${name}.webp`, alt: description }));
  }

  // Back to the previous value, or to the original when there is nothing before it.
  function undo(key) {
    const items = store.editItems(); const it = items[key];
    if (!it || it.current == null) throw httpError(404, 'There is nothing to undo here.');
    it.current = it.history.length ? it.history.pop() : null;
    it.updatedAt = new Date().toISOString();
    store.saveEditItem(key, it);
    return state();
  }

  // Everything back to the original, in one step (the pictures stay in the folder, so a mistake here can be redone by editing again).
  function revertAll() {
    for (const [key, it] of Object.entries(store.editItems())) { it.current = null; it.history = []; store.saveEditItem(key, it); }
    return state();
  }

  // A picture the owner uploaded, if it exists (the name is checked: only edit-<hex>.webp)
  const imageFile = (name) => { if (!/^edit-[0-9a-f]{10}\.webp$/.test(name)) return null; const f = path.join(imagesDir, name); return fs.existsSync(f) ? f : null; };

  return { state, apply, text, image, undo, revertAll, imageFile, pages, escText };
}

export { httpError };
