// Automatic repairs of what the QA stage finds in the built site. Today: text that is too faint to read.
//
// Designs sometimes draw small labels in a pale, see-through brand colour (a 40% gold on cream is 1.4:1). QA measures every text in a
// real browser; this module turns each offender into a solid colour of the SAME hue that is just dark (or light) enough, and writes it
// as an inline colour on that element. Nothing else changes: the words, the size, the layout and every element that was already
// readable stay exactly as designed.
//   repairs.json  { items: { "<data-e key | class:tag|class>": { color, was, text } } }  (kept, so a regenerated site gets them again)

import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from './project.js';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const file = (projectId) => projectPath(projectId, 'repairs.json');
export function readRepairs(projectId) {
  try { return JSON.parse(fs.readFileSync(file(projectId), 'utf8')); } catch { return { schemaVersion: 1, items: {} }; }
}

// ---------- colour maths ----------

export const parseColor = (v) => {
  const n = String(v).match(/-?[\d.]+/g)?.map(Number) ?? [];
  if (/^color\(/.test(String(v))) return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n.length > 3 ? n[3] : 1 };
  return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n.length > 3 ? n[3] : 1 };
};
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
export const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgbOf = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

// The colour to use instead: the text's own colour made solid, then mixed toward black (on a light background) or white (on a dark one)
// by the smallest amount that reaches the target contrast. A colour that only needed to stop being see-through is just made solid.
export function fixColor(fg, bg, { large = false, margin = 0.2 } = {}) {
  const target = (large ? 3 : 4.5) + margin;
  const base = { r: fg.r, g: fg.g, b: fg.b };
  const toward = lum(bg) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = { r: base.r + (toward.r - base.r) * t, g: base.g + (toward.g - base.g) * t, b: base.b + (toward.b - base.b) * t };
    if (contrast(c, bg) >= target) return hex(c);
  }
  return hex(toward);
}

// The other way round: when the TEXT cannot get better (white text on a mid-tone button: white cannot get whiter), the background it
// sits on is moved away from the text colour (darker for light text, lighter for dark text) by the smallest amount that reaches the target.
export function fixBackground(text, bg, { large = false, margin = 0.2 } = {}) {
  const target = (large ? 3 : 4.5) + margin;
  const toward = lum(text) > lum(bg) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = { r: bg.r + (toward.r - bg.r) * t, g: bg.g + (toward.g - bg.g) * t, b: bg.b + (toward.b - bg.b) * t };
    if (contrast(text, c) >= target) return { hex: hex(c), reached: true };
  }
  return { hex: hex(toward), reached: false };
}

// From the browser's list of offenders ({ key, tag, cls, text, ratio, large, fg, bg }) to repairs.
export function planRepairs(offenders) {
  const items = {};
  for (const o of offenders) {
    const id = o.key ?? (o.cls ? `class:${o.tag}|${o.cls}` : null);
    if (!id) continue;
    const bg = parseColor(o.bg); const fg = parseColor(o.fg);
    const bgId = o.bgKey ?? (o.bgCls ? `class:${o.bgTag}|${o.bgCls}` : null);
    // Solid white or near-black text (a button label) is part of the design: the background it sits on is moved first. Anything else
    // (a see-through brand colour, a mid-tone grey) gets its own colour fixed.
    const extreme = fg.a >= 0.99 && (lum(fg) >= 0.75 || lum(fg) <= 0.04);
    if (extreme && bgId) {
      const fixed = fixBackground(fg, bg, { large: o.large });
      if (fixed.reached) { items[`bg:${bgId}`] = { color: fixed.hex, prop: 'background-color', was: { fg: o.fg, bg: o.bg, ratio: o.ratio }, text: o.text }; continue; }
    }
    const color = fixColor(fg, bg, { large: o.large });
    items[id] = { color, was: { fg: o.fg, bg: o.bg, ratio: o.ratio }, text: o.text };
  }
  return items;
}

// ---------- applying ----------

// Puts the colour on every element the repair names. Pure and idempotent: a repair is marked with data-fixed, so a new colour replaces
// the old one and applying twice changes nothing.
export function applyToHtml(html, items) {
  let out = html;
  for (const [rawId, it] of Object.entries(items)) {
    const background = rawId.startsWith('bg:');
    const id = background ? rawId.slice(3) : rawId;
    const prop = background ? 'background-color' : 'color';
    const marker = background ? 'data-fixed-bg' : 'data-fixed';
    const open = id.startsWith('class:')
      ? (() => { const [tag, cls] = id.slice(6).split('|'); return new RegExp(`<(${escRe(tag)})\\b((?:(?!>)[^])*?\\bclass="${escRe(cls)}"(?:(?!>)[^])*)>`, 'g'); })()
      : new RegExp(`<(\\w+)\\b((?:(?!>)[^])*?\\bdata-e="${escRe(id)}"(?:(?!>)[^])*)>`, 'g');
    // an earlier repair of the SAME property is replaced; the other property and the element's own style stay
    const earlier = new RegExp(`;?\\s*(?<![-\\w])${prop}:\\s*#[0-9a-f]{6}\\s*;?`, 'i');
    out = out.replace(open, (whole, tag, attrs) => {
      const fixed = attrs.includes(` ${marker}="1"`) || (!background && / data-fixed="color"/.test(attrs));
      let next = attrs;
      const style = next.match(/\sstyle="([^"]*)"/)?.[1];
      const clean = (style ?? '').replace(earlier, ';').replace(/;{2,}/g, ';').replace(/^;|;$/g, '').trim();
      const merged = `${clean ? `${clean};` : ''}${prop}:${it.color}`;
      next = style === undefined ? `${next} style="${merged}"` : next.replace(/\sstyle="[^"]*"/, ` style="${merged}"`);
      if (!fixed) next = `${next} ${marker}="${background ? '1' : 'color'}"`;
      return `<${tag}${next}>`;
    });
  }
  return out;
}

const walkHtml = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkHtml(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : [])) : []);

// Writes the saved repairs into the page sources (what the next build uses) and the built pages (visible at once).
export function applyRepairs(projectId) {
  const { items } = readRepairs(projectId);
  if (!Object.keys(items).length) return 0;
  let files = 0;
  for (const dir of ['src/content', 'dist']) {
    for (const f of walkHtml(projectPath(projectId, 'site', dir))) {
      const before = fs.readFileSync(f, 'utf8');
      const after = applyToHtml(before, items);
      if (after !== before) { fs.writeFileSync(f, after); files++; }
    }
  }
  return files;
}

// Adds repairs to the saved ones and applies them. Returns the number of elements repaired.
export function saveRepairs(projectId, items) {
  const data = readRepairs(projectId);
  Object.assign(data.items, items);
  fs.writeFileSync(file(projectId), JSON.stringify(data, null, 2));
  applyRepairs(projectId);
  return Object.keys(items).length;
}
