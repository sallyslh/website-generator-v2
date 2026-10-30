// The first screen of the home page, looked at the way a visitor sees it (a phone and a laptop). The model is shown the two pictures and says what a visitor would
// dislike: text hard to read, text or buttons covering the main subject of the photo, a crowded header, the main button out of sight, a cut-off head.
// The problems of the phone go to the automatic repair; those of the laptop are only reported (the laptop design is Stitch's own).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import sharp from 'sharp';
import { askVision } from '../lib/llm.js';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const STAGE = 'wow-first-screen';
const view = z.object({ good: z.boolean(), problems: z.array(z.string()) });
const schema = z.object({ phone: view, laptop: view });

export const LOOK_SYSTEM = `You are a strict art director checking the FIRST SCREEN of a website home page, the part a visitor sees before scrolling. You get two pictures: first the phone (390 px wide), then the laptop. For each, say what a visitor would dislike. Look for exactly these:
- text that is hard to read (light text on a bright photo, small text over a busy photo);
- text or buttons laid over the main subject of the photo (a cup, a bottle, a person's face), hiding it;
- a crowded or messy header (logo, buttons and many links squeezed together, things touching or cut off);
- the main button or the headline not visible on this first screen;
- a head or face cut off by the edge of a photo;
- a photo that looks blurry or stretched, or a large empty area.
Each problem is one short sentence that says WHAT is wrong and WHERE, so a designer can fix it (for example: "the headline and paragraph sit over the cup and pastry, which is the subject of the photo"). good=true and an empty list when nothing is wrong. Do not invent problems and do not praise. Answer JSON only: {"phone":{"good":false,"problems":["..."]},"laptop":{"good":true,"problems":[]}}`;

// The first screen pictures of a page, cropped from full-page pictures taken by tools/measure-site.mjs.
function screens(dir, page = 'index.html') {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'first-'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(TOOLS, 'measure-site.mjs'), dir, out, page], { encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, VIEWS: 'phone,laptop' } });
  void r;
  return out;
}

export async function firstScreenLook({ dir, projectId, ask = askVision, page = 'index.html', shots = null }) {
  const out = shots ?? screens(dir, page);
  const slug = page.replace(/\.html$/, '');
  try {
    const files = [];
    for (const [name, height] of [['phone', 844], ['laptop', 900]]) {
      const src = path.join(out, `${name}-${slug}.jpg`);
      if (!fs.existsSync(src)) return { phone: { good: true, problems: [] }, laptop: { good: true, problems: [] }, skipped: `no ${name} picture` };
      const dest = path.join(out, `first-${name}.jpg`);
      const meta = await sharp(src).metadata();
      await sharp(src).extract({ left: 0, top: 0, width: meta.width, height: Math.min(height, meta.height) }).resize({ width: name === 'phone' ? 390 : 1000 }).jpeg({ quality: 82 }).toFile(dest);
      files.push({ path: dest });
    }
    const answer = await ask({ projectId, stage: STAGE, system: LOOK_SYSTEM, schema, maxTokens: 1500, images: files, prompt: 'The first picture is the phone, the second is the laptop. Check the first screen of each.' });
    return answer;
  } catch (err) {
    return { phone: { good: true, problems: [] }, laptop: { good: true, problems: [] }, skipped: err.message };
  } finally { if (!shots) fs.rmSync(out, { recursive: true, force: true }); }
}
