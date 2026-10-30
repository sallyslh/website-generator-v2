// The second way to edit (journey step 5): the same data as the click-on-the-page editor, as lists and forms. Every text of the page in one form, every list
// as a stack of cards (copy, move, delete, new, photo replace), and "paste many": one line per item. Changes go through the same endpoints as the page editor.

import { pageSlotsByRole, slotsByRole } from '../wow/structure.js';

// What the form needs: texts and photos outside lists, and each list with its items' fields. Slot ids are the ones the page editor uses.
export function contentOf(data) {
  const shown = pageSlotsByRole(data);
  const texts = shown.filter((s) => s.k === 't' && s.role !== 'icon').map((s) => ({ slot: `P.${s.i}`, role: s.role, value: s.value }));
  const photos = shown.filter((s) => s.k === 'src').map((s) => ({ slot: `P.${s.i}`, value: s.value }));
  const lists = (data.lists ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    items: l.items.map((item, index) => ({
      index,
      fields: slotsByRole(item).filter((s) => (s.k === 't' && s.role !== 'icon') || s.k === 'src').map((s) => ({ slot: `L${l.id}.${index}.${s.i}`, role: s.k === 'src' ? 'photo' : s.role, value: s.value })),
    })),
  }));
  return { texts, photos, lists };
}

// One line per item: "name | price | description" (a tab works instead of the bar, so a line copied from a spreadsheet pastes as it is).
export function parseLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200).map((line) => {
    const cells = line.split(/\t|\|/).map((c) => c.trim());
    return { name: cells[0] ?? '', price: cells[1] ?? '', description: cells.slice(2).join(' ') };
  });
}

// Puts a row into a new item: the name goes where the card shows its name, the price where it shows its price, the description in its long text.
export function fillItem(item, row, setText) {
  const find = (role) => item.slots.findIndex((s) => s.k === 't' && s.role === role);
  for (const [roles, value] of [[['name'], row.name], [['price'], row.price], [['description', 'label'], row.description]]) { // a short description is a "label" on some cards
    const i = roles.map(find).find((x) => x >= 0);
    if (i !== undefined) setText(item, i, value);
  }
}

const PAGE_JS = String.raw`
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = 0; }, 1800); };
const api = (path, body, headers) => fetch('/api/' + P + '/' + PAGE + '/' + path, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body: body instanceof Blob ? body : JSON.stringify(body) }).then((r) => r.json());
const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of [].concat(kids)) if (c) e.append(c);
  return e;
};
$('#page').onchange = (e) => { location.href = '/list/' + P + '/' + e.target.value + '.html'; };
$('#undo').onclick = async () => { const r = await api('undo', {}); if (r.ok) load(); else toast('Nothing to undo'); };
$('#build').onclick = async () => { toast('Building...'); const r = await fetch('/api/' + P + '/build', { method: 'POST' }).then((x) => x.json()); toast(r.ok ? 'Built ' + r.pages + ' pages' : 'Failed: ' + r.error); };
let pickFor = null; const file = $('#file');
file.onchange = async () => {
  const f = file.files[0]; file.value = ''; if (!f || !pickFor) return;
  const slot = pickFor; pickFor = null; toast('Uploading...');
  const r = await api('photo?slot=' + encodeURIComponent(slot), f, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) });
  if (r.ok) load(); else toast(r.error);
};
const field = (f) => {
  if (f.role === 'photo') return el('div', { class: 'row' }, [el('label', { text: 'photo' }), el('div', { class: 'photo' }, [el('img', { src: '/p/' + P + '/' + f.value, alt: '' }), el('button', { text: 'Replace photo', onclick: () => { pickFor = f.slot; file.click(); } })])]);
  const long = f.value.length > 70 || f.role === 'paragraph' || f.role === 'description';
  const input = el(long ? 'textarea' : 'input', long ? {} : { type: 'text' }); input.value = f.value;
  input.addEventListener('change', async () => { const r = await api('text', { slot: f.slot, text: input.value }); if (r.ok) { input.classList.add('saved'); setTimeout(() => input.classList.remove('saved'), 900); } else toast(r.error); });
  return el('div', { class: 'row' }, [el('label', { text: f.role }), input]);
};
const op = async (list, index, o) => {
  if (o === 'del' && !confirm('Delete this item?')) return;
  const r = await api('item', { list, index, op: o }); if (r.ok) load(); else toast(r.error);
};
async function load() {
  const c = await fetch('/api/' + P + '/content?page=' + PAGE).then((r) => r.json());
  const main = $('#main'); main.replaceChildren();
  main.append(el('h2', { text: 'Texts on this page' }), el('p', { class: 'hint', text: 'Change a word and click outside the box: it saves by itself.' }));
  const box = el('div', { class: 'card' }); for (const t of c.texts) box.append(field(t)); main.append(box);
  if (c.photos.length) { main.append(el('h2', { text: 'Pictures on this page' })); const pb = el('div', { class: 'card' }); for (const p of c.photos) pb.append(field({ ...p, role: 'photo' })); main.append(pb); }
  for (const l of c.lists) {
    main.append(el('h2', { text: l.name + ' (' + l.items.length + ')' }), el('p', { class: 'hint', text: 'One card for each item. Copy, move, delete, or add new ones.' }));
    l.items.forEach((it, i) => {
      const card = el('div', { class: 'card' }, it.fields.map(field));
      card.append(el('div', { class: 'tools' }, [
        el('button', { text: 'Move up', onclick: () => op(l.id, i, 'up') }), el('button', { text: 'Move down', onclick: () => op(l.id, i, 'down') }),
        el('button', { text: 'Copy', onclick: () => op(l.id, i, 'dup') }), el('button', { text: '+ New after this', onclick: () => op(l.id, i, 'add') }),
        el('button', { class: 'del', text: 'Delete', onclick: () => op(l.id, i, 'del') })]));
      main.append(card);
    });
    const ta = el('textarea', { placeholder: 'Iced latte | 4.50 | Espresso over ice and milk' });
    main.append(el('details', {}, [el('summary', { text: 'Paste many items for ' + l.name }),
      el('p', { class: 'hint', text: 'One item per line: name | price | description. Lines copied from a spreadsheet work too. Pictures are added after.' }), ta,
      el('div', { class: 'tools' }, [el('button', { class: 'go', text: 'Add these items', onclick: async () => { const r = await api('bulk', { list: l.id, text: ta.value }); if (r.ok) { toast(r.added + ' items added'); load(); } else toast(r.error); } })])]));
  }
}
load();
`;

const CSS = `
:root{--bg:#f6f4ef;--ink:#1f1d1a;--mute:#6b665e;--card:#fff;--line:#e2ded5;--accent:#2f5d50;--bad:#b4233b}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--ink:#f1eee7;--mute:#a39e93;--card:#201f1c;--line:#34322d;--accent:#8fc4b2;--bad:#ff8a9a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
header.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
header.top b{margin-right:auto}main{max-width:860px;margin:0 auto;padding:18px 16px 80px}
button,select,a.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:7px 12px;cursor:pointer;text-decoration:none}
button.go{background:var(--accent);color:#fff;border-color:var(--accent)}button.del{color:var(--bad)}
h2{margin:30px 0 4px;font-size:1.25rem}p.hint{color:var(--mute);margin:0 0 12px;font-size:.92rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0}
.row{display:grid;gap:6px;grid-template-columns:130px 1fr;align-items:start;margin:6px 0}@media(max-width:560px){.row{grid-template-columns:1fr}}
.row label{color:var(--mute);font-size:.85rem;padding-top:8px;text-transform:capitalize}
input[type=text],textarea{width:100%;font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:inherit}
textarea{min-height:70px;resize:vertical}.photo{display:flex;gap:10px;align-items:center}.photo img{width:96px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.tools{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.saved{outline:2px solid var(--accent)}
#toast{position:fixed;right:14px;bottom:14px;background:#1f1d1a;color:#fff;border-radius:10px;padding:8px 14px;opacity:0;transition:opacity .25s;pointer-events:none}
details{margin:8px 0}summary{cursor:pointer;color:var(--accent)}`;

export function listPageHtml(id, slug, pages) {
  const options = pages.map((p) => `<option value="${p}"${p === slug ? ' selected' : ''}>${p}</option>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit as lists</title><style>${CSS}</style></head><body>
<header class="top"><b>Edit as lists</b><select id="page">${options}</select><a class="btn" href="/p/${id}/${slug}.html">Edit on the page</a><button id="undo">Undo</button><button class="go" id="build">Build the final site</button><a class="btn" target="_blank" href="/preview/${id}/${slug}.html">See built site</a></header>
<main id="main">Loading...</main><div id="toast"></div><input type="file" id="file" accept="image/*" hidden>
<script>const P = ${JSON.stringify(id)}, PAGE = ${JSON.stringify(slug)};${PAGE_JS}</script></body></html>`;
}
