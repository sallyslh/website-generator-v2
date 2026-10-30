// Owner editing screen (journey step 5). Opens the structured pages of a project (projects/<id>/wow-structure) and lets the owner click any text to retype it,
// click a picture to replace it, and copy, delete or move the cards of a list. Edits go to projects/<id>/wow-edit (a working copy: the approved design is never changed),
// can be undone, and "Build the final site" writes projects/<id>/wow-built from the edited data.
//   node src/server/editor.js [--port 3020]      then open http://localhost:3020

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath } from '../lib/project.js';
import { renderPageEditable, setText, setPhoto, blankItem, duplicateItem, removeItem, moveItem, addItem, buildSite } from '../wow/structure.js';
import { contentOf, listPageHtml, parseLines, fillItem } from './listEditor.js';

const PROJECTS_DIR = path.dirname(projectPath('x'));
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3020;
const ID = /^[\w.-]+$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4' };
const UPLOAD_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const history = new Map(); // "project/page" -> earlier versions of the data, newest last

const dirs = (id) => ({ site: projectPath(id, 'wow-site'), structure: projectPath(id, 'wow-structure'), edit: projectPath(id, 'wow-edit'), built: projectPath(id, 'wow-built') });
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req, max = 12e6) => new Promise((resolve, reject) => { const parts = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });

// The working copy starts as a copy of the structured pages and is created once.
function ensureEdit(id) {
  const d = dirs(id);
  if (!fs.existsSync(d.structure)) throw new Error('this project has no structured pages yet (run: structure --project ' + id + ')');
  if (!fs.existsSync(d.edit)) { fs.mkdirSync(d.edit, { recursive: true }); for (const f of fs.readdirSync(d.structure)) if (/\.(base\.html|json)$/.test(f) && f !== 'report.json') fs.copyFileSync(path.join(d.structure, f), path.join(d.edit, f)); }
  return d;
}
const pagesOf = (id) => fs.readdirSync(ensureEdit(id).edit).filter((f) => f.endsWith('.base.html')).map((f) => f.replace(/\.base\.html$/, '')).sort((a, b) => (a === 'index' ? -1 : b === 'index' ? 1 : a.localeCompare(b)));
const loadPage = (id, slug) => { const d = ensureEdit(id); return { base: fs.readFileSync(path.join(d.edit, `${slug}.base.html`), 'utf8'), data: JSON.parse(fs.readFileSync(path.join(d.edit, `${slug}.json`), 'utf8')) }; };
function savePage(id, slug, data) {
  const key = `${id}/${slug}`; const file = path.join(dirs(id).edit, `${slug}.json`);
  const stack = history.get(key) ?? []; stack.push(fs.readFileSync(file, 'utf8')); if (stack.length > 60) stack.shift(); history.set(key, stack);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

// The slot "P.3" (outside lists) or "L2.1.5" (item 1 of list 2, slot 5) -> the object that holds the slots and the slot number.
function holderOf(data, slotId) {
  const [where, a, b] = slotId.split('.');
  if (where === 'P') return { holder: { slots: data.page.slots }, n: Number(a) };
  const list = data.lists.find((l) => `L${l.id}` === where);
  const item = list?.items[Number(a)];
  if (!item) throw new Error('unknown slot');
  return { holder: item, n: Number(b) };
}

function chrome(id, slug, pages) {
  const options = pages.map((p) => `<option value="${p}"${p === slug ? ' selected' : ''}>${p}</option>`).join('');
  return `<style>
[data-slot]{cursor:text}[data-slot]:hover{outline:2px dashed #7c3aed;outline-offset:2px}img[data-slot]{cursor:pointer}[data-slot][contenteditable]{outline:2px solid #7c3aed;outline-offset:2px;background:rgba(124,58,237,.12)}
span[data-slot]:empty::before{content:'(empty, click to type)';opacity:.5}
#ed-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:96vw;background:#1f1a2e;color:#fff;padding:8px 12px;border-radius:14px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}
#ed-bar button,#ed-bar select,#ed-bar a{font:inherit;border:0;border-radius:8px;padding:6px 12px;background:#3b3354;color:#fff;cursor:pointer;text-decoration:none}#ed-bar button.go{background:#7c3aed}#ed-bar .hint{opacity:.7;font-size:12px}
#ed-tools{position:fixed;z-index:2147483646;display:none;gap:4px;background:#1f1a2e;padding:4px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.4)}#ed-tools button{border:0;border-radius:6px;background:#3b3354;color:#fff;padding:4px 9px;font:13px system-ui;cursor:pointer}#ed-tools button.del{background:#b4233b}
#ed-toast{position:fixed;top:14px;right:14px;z-index:2147483647;background:#1f1a2e;color:#fff;padding:8px 14px;border-radius:10px;font:14px system-ui;opacity:0;transition:opacity .25s;pointer-events:none}
</style>
<div id="ed-bar"><select id="ed-page">${options}</select><button id="ed-undo">Undo</button><button class="go" id="ed-build">Build the final site</button><a id="ed-lists" href="/list/${id}/${slug}.html">Edit as lists</a><a id="ed-view" href="/preview/${id}/${slug}.html" target="_blank">See built site</a><span class="hint">Click a text to retype it (in a link or menu: double-click; a single click opens the page). Click a picture to replace it. Hover a card to copy, move or delete it.</span></div>
<div id="ed-tools"><button data-op="up" title="Move earlier">&#8592;</button><button data-op="down" title="Move later">&#8594;</button><button data-op="dup" title="Copy this card">Copy</button><button data-op="add" title="New empty card like this one">+ New</button><button class="del" data-op="del" title="Delete this card">Delete</button></div>
<div id="ed-toast"></div>
<input type="file" id="ed-file" accept="image/*" hidden>
<script>
(() => {
  const P = ${JSON.stringify(id)}, PAGE = ${JSON.stringify(slug)};
  const toast = (m) => { const t = document.getElementById('ed-toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 1800); };
  const api = (path, body, headers) => fetch('/api/' + P + '/' + PAGE + '/' + path, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body: body instanceof Blob ? body : JSON.stringify(body) }).then((r) => r.json());
  document.getElementById('ed-page').onchange = (e) => { location.href = '/p/' + P + '/' + e.target.value + '.html'; };
  document.getElementById('ed-undo').onclick = async () => { const r = await api('undo', {}); if (r.ok) location.reload(); else toast('Nothing to undo'); };
  document.getElementById('ed-build').onclick = async () => { toast('Building...'); const r = await fetch('/api/' + P + '/build', { method: 'POST' }).then((x) => x.json()); toast(r.ok ? 'Built ' + r.pages + ' pages. Use "See built site"' : 'Build failed: ' + r.error); };
  let editing = null;
  const startText = (el) => {
    if (editing) return; editing = el; el._orig = el.textContent;
    el.setAttribute('contenteditable', 'plaintext-only'); if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true'); el.focus();
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const stopText = async (save) => {
    const el = editing; if (!el) return; editing = null; el.removeAttribute('contenteditable');
    if (!save) { el.textContent = el._orig; return; }
    const text = el.textContent; if (text === el._orig) return;
    const r = await api('text', { slot: el.dataset.slot, text }); toast(r.ok ? 'Saved' : 'Not saved: ' + r.error);
  };
  document.addEventListener('keydown', (e) => { if (!editing) return; if (e.key === 'Enter') { e.preventDefault(); stopText(true); } else if (e.key === 'Escape') { e.preventDefault(); stopText(false); } }, true);
  document.addEventListener('focusout', (e) => { if (editing && e.target === editing) stopText(true); }, true);
  const file = document.getElementById('ed-file'); let pickFor = null;
  file.onchange = async () => {
    const f = file.files[0]; file.value = ''; if (!f || !pickFor) return; const slot = pickFor; pickFor = null; toast('Uploading...');
    const r = await api('photo?slot=' + encodeURIComponent(slot), f, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) });
    if (r.ok) location.reload(); else toast('Not saved: ' + r.error);
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('#ed-bar,#ed-tools')) return;
    if (editing && editing.contains(e.target)) { e.preventDefault(); e.stopPropagation(); return; }
    let hit = e.target.closest('[data-slot]');
    if (!hit && !e.target.closest('a,button,input,select,textarea')) hit = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.tagName === 'IMG' && x.dataset.slot) || null;
    if (editing) stopText(true);
    // words inside a link: one click follows the link (so the menu works), a double click edits the words
    const link = hit && hit.tagName !== 'IMG' ? hit.closest('a[href]') : (!hit ? e.target.closest('a[href]') : null);
    if (link && !link.getAttribute('href').startsWith('#')) {
      e.preventDefault(); e.stopPropagation(); clearTimeout(linkT);
      linkT = setTimeout(() => { location.href = link.href; }, 280);
      return;
    }
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    if (hit.tagName === 'IMG') { pickFor = hit.dataset.slot; file.click(); } else startText(hit);
  }, true);
  let linkT;
  document.addEventListener('dblclick', (e) => { const hit = e.target.closest('span[data-slot]'); if (!hit) return; clearTimeout(linkT); e.preventDefault(); startText(hit); }, true);
  const tools = document.getElementById('ed-tools'); let current = null, hideT;
  const place = (item) => { current = item; const r = item.getBoundingClientRect(); tools.style.display = 'flex'; tools.style.top = Math.max(4, r.top + 6) + 'px'; tools.style.left = Math.max(4, Math.min(innerWidth - tools.offsetWidth - 4, r.right - tools.offsetWidth - 6)) + 'px'; };
  document.addEventListener('mouseover', (e) => { const it = e.target.closest('[data-item]'); if (it && !editing) { clearTimeout(hideT); if (it !== current) place(it); } else if (e.target.closest('#ed-tools')) clearTimeout(hideT); else { clearTimeout(hideT); hideT = setTimeout(() => { tools.style.display = 'none'; current = null; }, 400); } });
  addEventListener('scroll', () => { tools.style.display = 'none'; current = null; }, { passive: true });
  tools.onclick = async (e) => {
    const op = e.target.dataset.op; if (!op || !current) return; const [list, index] = current.dataset.item.split('.');
    if (op === 'del' && !confirm('Delete this card?')) return;
    const r = await api('item', { list: Number(list), index: Number(index), op }); if (r.ok) location.reload(); else toast(r.error);
  };
})();
</script>`;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.some((p) => p === '..' || p.includes('\\'))) return send(res, 400, { error: 'bad path' });

  if (!parts.length) {
    const ids = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(PROJECTS_DIR, d.name, 'wow-structure'))).map((d) => d.name);
    return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit a site</title><body style="font:18px system-ui;max-width:560px;margin:60px auto;padding:0 16px"><h1>Edit a website</h1><p>Pick a site, then click on its words and pictures to change them.</p>${ids.map((i) => `<p><a href="/p/${i}/index.html" style="font-size:20px">${i}</a></p>`).join('') || '<p>No site has been converted yet.</p>'}</body>`, 'text/html; charset=utf-8');
  }

  // the page being edited
  if (parts[0] === 'p' && parts.length === 3 && parts[2].endsWith('.html') && ID.test(parts[1])) {
    const id = parts[1]; const slug = parts[2].replace(/\.html$/, '');
    try {
      const pages = pagesOf(id); if (!pages.includes(slug)) return send(res, 404, 'No such page', 'text/plain');
      const { base, data } = loadPage(id, slug); const html = renderPageEditable(base, data);
      const withBase = html.replace(/<head([^>]*)>/i, `<head$1><base href="/p/${id}/">`);
      return send(res, 200, withBase.replace(/<\/body>/i, `${chrome(id, slug, pages)}</body>`), 'text/html; charset=utf-8');
    } catch (e) { return send(res, 500, e.message, 'text/plain'); }
  }

  // the second way to edit: the same data as lists and forms
  if (parts[0] === 'list' && parts.length === 3 && parts[2].endsWith('.html') && ID.test(parts[1])) {
    try { const id = parts[1]; const slug = parts[2].replace(/.html$/, ''); const pages = pagesOf(id); if (!pages.includes(slug)) return send(res, 404, 'No such page', 'text/plain'); return send(res, 200, listPageHtml(id, slug, pages), 'text/html; charset=utf-8'); } catch (e) { return send(res, 500, e.message, 'text/plain'); }
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'content' && ID.test(parts[1] ?? '')) {
    try { const slug = url.searchParams.get('page') ?? 'index'; if (!pagesOf(parts[1]).includes(slug)) return send(res, 404, { error: 'no such page' }); return send(res, 200, contentOf(loadPage(parts[1], slug).data)); } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // files of the site (pictures, styles, scripts): the owner's uploads first, then the generated site
  if ((parts[0] === 'p' || parts[0] === 'preview') && ID.test(parts[1] ?? '')) {
    const d = dirs(parts[1]); const rel = parts.slice(2).join('/') || 'index.html';
    const roots = parts[0] === 'preview' ? [d.built] : [d.edit, d.site];
    for (const root of roots) {
      const file = path.join(root, rel);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    }
    return send(res, 404, 'Not found', 'text/plain');
  }

  if (req.method === 'POST' && parts[0] === 'api' && ID.test(parts[1] ?? '')) {
    const id = parts[1];
    try {
      if (parts[2] === 'build') {
        const d = ensureEdit(id); const r = buildSite({ dir: d.site, structureDir: d.edit, out: d.built });
        const up = path.join(d.edit, 'images', 'uploads'); if (fs.existsSync(up)) fs.cpSync(up, path.join(d.built, 'images', 'uploads'), { recursive: true });
        return send(res, 200, { ok: true, pages: r.built.length + r.copied.length });
      }
      const slug = parts[2]; if (!ID.test(slug ?? '') || !pagesOf(id).includes(slug)) return send(res, 404, { ok: false, error: 'no such page' });
      const action = parts[3]; const d = dirs(id);
      if (action === 'undo') {
        const stack = history.get(`${id}/${slug}`) ?? []; const last = stack.pop();
        if (!last) return send(res, 200, { ok: false });
        fs.writeFileSync(path.join(d.edit, `${slug}.json`), last); return send(res, 200, { ok: true });
      }
      const { data } = loadPage(id, slug);
      if (action === 'text') {
        const body = JSON.parse((await readBody(req)).toString('utf8')); const { holder, n } = holderOf(data, String(body.slot));
        if (holder.slots[n]?.k !== 't') throw new Error('not a text'); setText(holder, n, String(body.text).slice(0, 4000));
      } else if (action === 'photo') {
        const body = await readBody(req); const ext = path.extname(decodeURIComponent(req.headers['x-filename'] ?? '')).toLowerCase();
        if (!UPLOAD_TYPES.has(ext)) throw new Error('please choose a jpg, png, webp, gif or avif picture');
        const { holder, n } = holderOf(data, url.searchParams.get('slot') ?? '');
        if (holder.slots[n]?.k !== 'src') throw new Error('not a picture');
        const name = `photo-${Date.now()}${ext}`; fs.mkdirSync(path.join(d.edit, 'images', 'uploads'), { recursive: true });
        fs.writeFileSync(path.join(d.edit, 'images', 'uploads', name), body);
        setPhoto(holder.slots, n, `images/uploads/${name}`);
      } else if (action === 'item') {
        const body = JSON.parse((await readBody(req)).toString('utf8')); const list = data.lists.find((l) => l.id === body.list); const i = Number(body.index);
        if (!list || !list.items[i]) throw new Error('unknown card');
        if (body.op === 'dup') duplicateItem(list, i);
        else if (body.op === 'add') { const b = blankItem(list, i); duplicateItem(list, i); list.items[i + 1] = b; }
        else if (body.op === 'del') { if (!removeItem(list, i)) throw new Error('the last card of a list cannot be deleted'); }
        else if (body.op === 'up' && i > 0) moveItem(list, i, i - 1);
        else if (body.op === 'down' && i < list.items.length - 1) moveItem(list, i, i + 1);
      } else if (action === 'bulk') {
        const body = JSON.parse((await readBody(req)).toString('utf8')); const list = data.lists.find((l) => l.id === body.list);
        if (!list) throw new Error('unknown list');
        const rows = parseLines(body.text); if (!rows.length) throw new Error('nothing to add: write one item on each line');
        for (const row of rows) { const item = blankItem(list, list.items.length - 1); fillItem(item, row, setText); addItem(list, item); }
        savePage(id, slug, data);
        return send(res, 200, { ok: true, added: rows.length });
      } else return send(res, 404, { ok: false, error: 'unknown action' });
      savePage(id, slug, data);
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }
  send(res, 404, 'Not found', 'text/plain');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message }))).listen(PORT, () => console.log(`Editor on http://localhost:${PORT}`));
}
export { handle };
