// What the owner already has: a logo and/or brand colours. When they give any, the website is built to match them; when they give
// nothing, the concept chooses the colours freely (and they can be changed later). Nothing is invented here: the colours come from the
// logo itself (read by the model, with a plain pixel count as a fallback) and from what the owner typed.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { askVision } from '../lib/llm.js';
import { projectPath, exists, readJson, writeJson } from '../lib/project.js';

export const BRAND_FILE = 'brand.json';
export const LOGO_FILE = 'brand/logo.png';
export const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

const normHex = (h) => { const x = h.toLowerCase(); return x.length === 4 ? `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}` : x; };
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// "gold and cream, #1a2b3c" -> { hex: ['#1a2b3c'], words: 'gold and cream' }
export function parseColorsText(text = '') {
  const t = String(text).slice(0, 200);
  const hex = [...new Set((t.match(HEX) ?? []).map(normHex))];
  const words = t.replace(HEX, ' ').replace(/[,;]+/g, ',').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return { hex, words };
}

// A data URL (or base64) of a picture -> projects/<id>/brand/logo.png, at most 1024 px. Throws a friendly error for anything that is not a picture.
export async function saveLogo(projectId, dataUrl) {
  const m = String(dataUrl ?? '').match(/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw Object.assign(new Error('Please choose a picture file for your logo (PNG, JPG, WebP or SVG).'), { status: 400 });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_LOGO_BYTES) throw Object.assign(new Error('That logo file is too large. Please use one under 4 MB.'), { status: 400 });
  let png;
  try { png = await sharp(bytes, { density: 192 }).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer(); }
  catch { throw Object.assign(new Error('We could not read that logo file. Please try another one.'), { status: 400 }); }
  const file = projectPath(projectId, LOGO_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return file;
}

// The most visible colours of a picture by counting pixels (transparent, near-white and near-black pixels are skipped unless nothing else is left)
export async function dominantColors(file, count = 4) {
  const { data, info } = await sharp(file).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  const add = (skipNeutral) => {
    buckets.clear();
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 128) continue;
      if (skipNeutral && ((r > 235 && g > 235 && b > 235) || (r < 25 && g < 25 && b < 25))) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }; e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
    }
  };
  add(true); if (!buckets.size) add(false);
  const ranked = [...buckets.values()].sort((x, y) => y.n - x.n).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
  const out = [];
  for (const c of ranked) { if (out.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) > 60)) out.push(c); if (out.length >= count) break; }
  return out.map((c) => toHex(...c));
}

const logoSchema = z.object({
  colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(6),
  personality: z.array(z.string()).default([]),
  description: z.string().default(''),
});

// Reads the logo (colours, what it looks like, the feeling) and the typed colours into one brand record. Saved once; the website is built from it.
export async function readBrand({ projectId, colorsText = '', ask = askVision }) {
  if (exists(projectId, BRAND_FILE)) return readJson(projectId, BRAND_FILE);
  const typed = parseColorsText(colorsText);
  const logoPath = projectPath(projectId, LOGO_FILE);
  const hasLogo = fs.existsSync(logoPath);
  if (!hasLogo && !typed.hex.length && !typed.words) return null; // nothing given: the concept chooses freely
  const brand = { logo: hasLogo ? LOGO_FILE : null, colors: [...typed.hex], colorWords: typed.words, personality: [], description: '', source: hasLogo ? (typed.hex.length || typed.words ? 'logo and typed colours' : 'logo') : 'typed colours' };
  if (hasLogo) {
    let read = null;
    try {
      read = await ask({ projectId, stage: 'wow-brand', images: [{ path: logoPath }], schema: logoSchema, maxTokens: 800,
        prompt: 'This is the logo of a small business. Answer as JSON: {"colors":["#rrggbb", ...up to 5 brand colours of the logo itself, most important first, ignoring a white or transparent background],"personality":["3 to 5 words for the feeling of the logo"],"description":"one sentence: what the logo looks like (shape, lettering, symbol)"}' });
    } catch { /* the pixel count below is used */ }
    const found = read?.colors?.length ? read.colors.map((c) => c.toLowerCase()) : await dominantColors(logoPath);
    brand.colors = [...new Set([...brand.colors, ...found])].slice(0, 6);
    brand.personality = read?.personality ?? []; brand.description = read?.description ?? '';
  }
  writeJson(projectId, BRAND_FILE, brand);
  return brand;
}

// What the concept writer, the brief writer and Stitch are told
export const brandBlock = (b) => (b ? `BRAND (the owner already has this: the website MUST match it)
${b.colors.length ? `- Brand colours: ${b.colors.join(', ')}.` : ''}${b.colorWords ? ` The owner describes their colours as: "${b.colorWords}".` : ''}
${b.description ? `- The logo: ${b.description}` : ''}${b.personality?.length ? ` Feeling: ${b.personality.join(', ')}.` : ''}
- Build the colour world of the site on these colours (other shades and one neutral are fine, but the brand colours lead). The lettering and mood should suit the logo. The real logo is placed by us in the header and the footer: leave a clean logo area and never redraw or invent a logo.
` : 'BRAND: none given. Choose the colour world freely.\n');

// What the owner wrote about their taste ("I like bright colours", "nothing too dark"). Optional; the brand colours, when there are any, come first.
export const tasteBlock = (t) => (String(t ?? '').trim() ? `THE OWNER'S TASTE (written by the owner, optional: follow it wherever it fits this business; brand colours, when given, come first): ${String(t).trim()}\n` : '');

// Puts the real logo where the design drew its own: a picture whose alt text says "logo", or else the business name in the header
export function placeLogo(html, { name, src }) {
  let placed = 0;
  const alt = `${String(name).replace(/"/g, '&quot;')} logo`;
  let out = html.replace(/<img\b[^>]*\balt="[^"]*logo[^"]*"[^>]*>/gi, (tag) => {
    const cls = tag.match(/\bclass="([^"]*)"/i)?.[1] ?? '';
    placed++;
    return `<img src="${src}" alt="${alt}" class="${cls}" style="object-fit:contain;max-height:56px;width:auto">`;
  });
  if (!placed) {
    const key = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    out = out.replace(/(<header\b[\s\S]*?<a\b[^>]*>)([\s\S]*?)(<\/a>)/i, (whole, open, inner, close) => {
      const text = inner.replace(/<[^>]+>/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (!text || !(key.startsWith(text) || text.startsWith(key) || text.includes(key))) return whole;
      placed++;
      return `${open}<img src="${src}" alt="${alt}" style="object-fit:contain;max-height:44px;width:auto">${close}`;
    });
  }
  return { html: out, placed };
}
