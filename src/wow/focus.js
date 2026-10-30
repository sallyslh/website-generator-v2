// Keeps the heads of people in view. Photos are shown in frames of other shapes (a tall portrait in a wide phone card) and the browser crops from the
// middle, which can cut a forehead off. For every picture that fills its frame (object-cover) the model is shown a small copy and says where the heads are;
// the frame then looks at that part of the photo (object-position). Pictures without people are left alone. The answer is remembered per picture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import sharp from 'sharp';
import { askVision } from '../lib/llm.js';
import { projectPath, exists, readJson, writeJson } from '../lib/project.js';

const cheerio = createRequire(import.meta.url)('cheerio');
const STAGE = 'wow-focus';
const CACHE = 'wow-focus.json';
const BATCH = 6;
const pct = z.number().min(0).max(100);
const schema = z.object({ pictures: z.array(z.object({ n: z.number().int(), people: z.boolean(), heads: z.object({ top: pct, bottom: pct, left: pct, right: pct }).nullable() })) });

export const FOCUS_SYSTEM = `You help a website show people's photos without cutting their heads off. You get numbered pictures. For each one say whether a real person or people are clearly shown (people=true), and if so give the box that covers ALL the visible heads and faces, as percentages of the picture (top and bottom from the top edge, left and right from the left edge; 0 to 100). Pictures of products, places, food, objects or tiny far-away figures: people=false and heads=null. Answer JSON only: {"pictures":[{"n":1,"people":true,"heads":{"top":8,"bottom":30,"left":38,"right":62}}]}`;

// Where the frame should look so the heads stay in view whatever the frame's shape: keep the box of heads near the top of what is shown.
export function positionFor(heads) {
  const x = Math.round(Math.min(95, Math.max(5, (heads.left + heads.right) / 2)));
  const y = Math.round(Math.min(95, Math.max(0, heads.top + (heads.bottom - heads.top) * 0.35)));
  return `${x}% ${y}%`;
}

const keyOf = (src) => path.posix.basename(src.split('?')[0]);

export async function focusSite({ dir, projectId, ask = askVision }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const docs = new Map(files.map((f) => [f, cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'), { decodeEntities: false })]));
  // the pictures that fill their frame
  const wanted = new Map();
  for (const [, $] of docs) $('img').each((_, im) => {
    const src = $(im).attr('src'); const cls = $(im).attr('class') ?? '';
    if (!src || /^https?:|^data:/.test(src) || !/\bobject-cover\b/.test(cls)) return;
    if (!wanted.has(keyOf(src))) wanted.set(keyOf(src), src);
  });
  const cache = projectId && exists(projectId, CACHE) ? readJson(projectId, CACHE) : {};
  const todo = [...wanted].filter(([key]) => !(key in cache));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
  let failed = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const group = [];
      for (const [key, src] of todo.slice(i, i + BATCH)) {
        const file = path.join(dir, src);
        if (!fs.existsSync(file)) { cache[key] = { people: false }; continue; }
        const small = path.join(tmp, `${group.length + 1}.jpg`);
        try { await sharp(file).resize({ width: 640, height: 640, fit: 'inside' }).jpeg({ quality: 70 }).toFile(small); } catch { cache[key] = { people: false }; continue; }
        group.push({ key, path: small });
      }
      if (!group.length) continue;
      try {
        const answer = await ask({ projectId, stage: STAGE, system: FOCUS_SYSTEM, schema, maxTokens: 1500, images: group.map((g) => ({ path: g.path })), prompt: `${group.length} pictures, numbered in order from 1. Answer for each.` });
        for (const p of answer.pictures ?? []) { const g = group[p.n - 1]; if (g) cache[g.key] = p.people && p.heads ? { people: true, heads: p.heads } : { people: false }; }
      } catch { failed += group.length; }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (projectId) writeJson(projectId, CACHE, cache);
  // apply
  let changed = 0; let withPeople = 0;
  for (const [f, $] of docs) {
    let page = false;
    $('img').each((_, im) => {
      const src = $(im).attr('src'); const c = src ? cache[keyOf(src)] : null;
      if (!c?.people || !c.heads || !/\bobject-cover\b/.test($(im).attr('class') ?? '')) return;
      const style = ($(im).attr('style') ?? '').replace(/object-position:[^;]*;?/g, '').trim();
      $(im).attr('style', `${style ? `${style.replace(/;?$/, ';')} ` : ''}object-position: ${positionFor(c.heads)};`);
      page = true; changed++;
    });
    if (page) fs.writeFileSync(path.join(dir, f), $.html());
  }
  for (const c of Object.values(cache)) if (c.people) withPeople++;
  return { pictures: wanted.size, withPeople, changed, failed };
}
