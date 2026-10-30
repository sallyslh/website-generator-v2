// Responsive design, page by page: Stitch draws laptop pages, so each page is redesigned for the phone and the tablet on purpose, the way a designer
// would (phone layout first, bigger screens add columns), instead of shrinking the laptop page.
//   responsiveSite({ dir, projectId })   one model call per page; the model answers ONLY with new class lists for the elements that need them
//                                        (a short list, so it is cheap), and the code applies them. Text, pictures, links and scripts cannot change.
//   A change that would alter the laptop look is dropped (see laptopKept). Answers are remembered, so a rebuild costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { askJson } from '../lib/llm.js';
import { projectPath } from '../lib/project.js';

const STAGE = 'wow-responsive';
export const MARK = 'data-responsive';

export const RESPONSIVE_SYSTEM = `You are a senior responsive web designer. You receive the body of one page drawn for a laptop (HTML with Tailwind classes). Every element that has a class attribute carries a number (data-r="N"). You answer with the elements whose classes must change so the page is excellent on a phone, a tablet and a laptop. Elements you do not list stay exactly as they are.

ANSWER FORMAT: JSON only: {"changes":[{"id":12,"class":"the COMPLETE new class list of element 12"}, ...]}. Only elements that really change. You cannot change text, pictures, links or structure, only classes.

THE LAPTOP MUST NOT CHANGE
- On a laptop (1024px and wider) the page must look exactly as it does now. Plain classes in a list are the phone. So when you change or remove a plain class, put it back with a prefix so the laptop keeps it: for example "p-12" becomes "p-5 lg:p-12" (or "md:p-12" if the tablet should have it too). Keep every existing "sm:", "md:", "lg:" and "xl:" class.

WHAT YOU DESIGN (mobile first: plain classes are the phone, "md:" is the tablet from 768px, "lg:" is the laptop from 1024px)
- Phone screens are 360 to 430px wide. Nothing scrolls sideways except a deliberate swipe row. The most important thing comes first.
- Compact, not stretched: section padding about py-10 px-5 on a phone, headings text-3xl to text-4xl at most (the huge laptop sizes from md: or lg:), gaps gap-3 to gap-5, paragraphs text-base.
- Hero: about 520px tall at most on a phone (for example min-h-[480px] with the laptop height from lg:), not a full tall screen.
- THE FIRST SCREEN ON A PHONE decides the first impression. When the hero has a headline, text and buttons laid over a photo: on a phone the photo becomes its own landscape block on top (aspect-[4/3] or aspect-video, w-full, object-cover) and the headline, text and buttons go BELOW it on the page background with dark text, no overlay (make the text container relative instead of absolute and drop the dark gradient on the phone; restore the overlay from lg:). Never let text or buttons cover the main subject of a photo (the cup, the bottle, the face), and never put light text on a bright photo. The headline and the main button must both be visible without scrolling.
- THE HEADER ON A PHONE is small: the logo on the left and the main button on the right, nothing else. Hide the row of menu links on a phone (hidden, with the laptop display restored from md: or lg:, for example "hidden md:flex"): the site adds its own three-bar menu button that lists every page. A logo has a modest size on a phone (about h-8) and the header is one row about 56 to 64px tall.
- Pictures are never tall strips: on a phone give the picture's box a landscape shape (aspect-[4/3] or aspect-video, with the laptop shape from lg:), w-full, object-cover. A very tall box (min-h-[460px] and more) gets a smaller phone height with the big one from lg:.
- Groups of similar items stay side by side, small, instead of one long column:
  - small things (statistics, time slots, dates, tags, price chips, 2 to 4 short cards): a compact grid on the container, grid-cols-2 or grid-cols-3 on a phone with a smaller gap, and smaller text and padding in the items. A row of 7 days stays one row (grid-cols-7).
  - larger cards (plans, coaches, rooms, products, events: 3 or more big cards): ONE horizontal swipe row on a phone. On the container: "flex overflow-x-auto snap-x snap-mandatory gap-4 -mx-5 px-5" and the laptop layout restored from md: or lg: (for example "md:grid md:grid-cols-3 md:overflow-visible md:mx-0 md:px-0"; if it was a grid, put the old grid classes behind the prefix). On each card: "shrink-0 basis-[82%] snap-start" and "md:basis-auto" (or the laptop width) from md:. List the container AND each of its cards.
  - a two-column split (text beside a big picture) is one column on a phone.
- Tablet (md:): two columns where the laptop has three or four, nothing stretched.
- Buttons: at least 44px tall; the main button may be full width on a phone.
- Use only standard Tailwind classes (arbitrary values like min-h-[480px] are fine). Do not invent classes. If the header already has its own mobile menu button, leave it as it is.`;

// A tag is "<name attrs>", where an attribute value in quotes may contain ">" (Tailwind classes like "[&>button]:min-h-[44px]")
const TAG = /<[a-zA-Z][^\s>"'/]*(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const bodyOf = (html) => html.match(/<body\b[^>]*>[\s\S]*<\/body>/i)?.[0] ?? null;

// Walks the tags of a body (not the inside of scripts and styles) and calls fn(tag, id) for every tag with a class attribute, numbering them 1, 2, 3...
// Returns the body with each tag replaced by fn's result.
function mapClassTags(body, fn) {
  const parts = body.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i);
  let id = 0;
  return parts.map((part) => (/^<(script|style)\b/i.test(part) ? part : part.replace(TAG, (tag) => {
    const m = tag.match(/\sclass="([^"]*)"/);
    if (!m) return tag;
    id += 1;
    return fn(tag, id, m[1]);
  }))).join('');
}

// The body with numbers added, as the model sees it.
export function numbered(body) {
  return mapClassTags(body, (tag, id) => tag.replace(/\sclass="/, ` data-r="${id}" class="`));
}

const tokens = (list) => String(list).split(/\s+/).filter(Boolean);
const PREFIXED = /^(sm|md|lg|xl|2xl):/;

// The laptop must look as before: every class that has a breakpoint stays, and every plain class that is removed either comes back behind a breakpoint
// or only ruled the phone (the list already had a breakpoint class of the same kind, such as "grid-cols-1 md:grid-cols-3": the plain one is only the phone).
const kindOf = (t) => t.replace(/-([[^]]+]|[^-]+)$/, '');
export function laptopKept(before, after) {
  const next = new Set(tokens(after));
  const prefixedKinds = new Set(tokens(before).filter((t) => /^(sm|md|lg):/.test(t)).map((t) => kindOf(t.replace(PREFIXED, ''))));
  for (const t of tokens(before)) {
    if (next.has(t)) continue;
    const pre = t.match(/^(sm|md|lg|xl|2xl):(.+)$/);
    if (pre) {
      // a phone or tablet class may move up to a bigger breakpoint, or become the plain class (same value); laptop classes (lg:, xl:) must stay
      if ((pre[1] === 'sm' || pre[1] === 'md') && (next.has(pre[2]) || next.has(`md:${pre[2]}`) || next.has(`lg:${pre[2]}`))) continue;
      return false;
    }
    if (/^(hover|focus|group-hover|dark|disabled|peer-[a-z]+):/.test(t)) return false;
    if (next.has(`lg:${t}`) || next.has(`md:${t}`) || next.has(`sm:${t}`)) continue;
    if (t === 'hidden') { if ([...next].some((x) => /^(flex|block|grid|inline-flex|inline-block)$/.test(x))) continue; return false; } // shown on the phone too
    if (prefixedKinds.has(kindOf(t)) && t !== 'grid' && t !== 'flex' && t !== 'block') continue;
    return false;
  }
  return true;
}

const changesSchema = z.object({ changes: z.array(z.object({ id: z.number().int(), class: z.string() })) });
const SAFE_CLASS = /^[^"<\n\r]*$/;

// One page. Returns { html, status: 'redesigned' | 'kept', changed, dropped, why }.
export async function responsivePage({ html, projectId, ask = askJson, label = 'page', remembered = null, hint = '' }) {
  const body = bodyOf(html);
  if (!body) return { html, status: 'kept', changed: 0, dropped: 0, why: 'no body found' };
  let answer = remembered?.get() ?? null;
  if (!answer) try {
    answer = await ask({ projectId, stage: STAGE, system: RESPONSIVE_SYSTEM, schema: changesSchema, maxTokens: 16000, prompt: `Redesign this page (${label}) for phone, tablet and laptop. Answer with the JSON of changed class lists only.${hint ? `\n\nTHIS PAGE WAS ALREADY REDESIGNED FOR THE PHONE, BUT A MEASUREMENT IN A REAL BROWSER FOUND PROBLEMS. Fix exactly these (change classes only; the laptop must stay as it is):\n${hint}` : ''}\n\n${numbered(body)}` });
    remembered?.set(answer);
  } catch (err) { return { html, status: 'kept', changed: 0, dropped: 0, why: err.message }; }
  const wanted = new Map();
  let dropped = 0;
  const original = new Map();
  mapClassTags(body, (tag, id, list) => { original.set(id, list); return tag; });
  for (const c of answer.changes ?? []) {
    const before = original.get(c.id);
    const next = c.class.replace(/\s+/g, ' ').trim();
    if (before === undefined || !next || !SAFE_CLASS.test(next) || !laptopKept(before, next)) { dropped++; if (process.env.DEBUG_RESPONSIVE) console.log(`  dropped ${label} #${c.id}: [${before}] => [${next}]`); continue; }
    if (tokens(before).join(' ') !== next) wanted.set(c.id, next);
  }
  if (!wanted.size) return { html, status: 'kept', changed: 0, dropped, why: 'the model proposed no usable change' };
  const out = mapClassTags(body, (tag, id) => (wanted.has(id) ? tag.replace(/(\sclass=")[^"]*"/, (_, a) => `${a}${wanted.get(id)}"`) : tag));
  return { html: html.replace(body, () => out).replace(/<body\b(?![^>]*data-responsive)/i, `<body ${MARK}`), status: 'redesigned', changed: wanted.size, dropped, why: '' };
}

export async function responsiveSite({ dir, projectId, ask = askJson, concurrency = 3 }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const cacheDir = projectId ? projectPath(projectId, 'wow-responsive') : null;
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const report = { redesigned: 0, kept: [], cached: 0, changed: 0, dropped: 0 };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const file = path.join(dir, f);
      const html = fs.readFileSync(file, 'utf8');
      if (html.includes(MARK)) continue;
      const hash = crypto.createHash('sha256').update('v2' + RESPONSIVE_SYSTEM + html).digest('hex').slice(0, 24);
      const answerFile = cacheDir ? path.join(cacheDir, hash + '.answer.json') : null;
      const remembered = answerFile ? { get: () => (fs.existsSync(answerFile) ? JSON.parse(fs.readFileSync(answerFile, 'utf8')) : null), set: (a) => fs.writeFileSync(answerFile, JSON.stringify(a)) } : null;
      if (remembered?.get()) report.cached++;
      const r = await responsivePage({ html, projectId, ask, label: f, remembered });
      report.dropped += r.dropped;
      if (r.status === 'redesigned') { fs.writeFileSync(file, r.html); report.redesigned++; report.changed += r.changed; } else report.kept.push(`${f} (${r.why})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return report;
}

// A second look at pages that are already redesigned: a real browser measured problems (a section far too tall on a phone, sideways scrolling, tiny text) and the model is
// told exactly which. problems is { 'page.html': ['line', ...] }. Pages are only changed when the model gives usable changes; the caller re-measures and may restore the old page.
export async function repairSite({ dir, projectId, problems, ask = askJson, concurrency = 3 }) {
  const files = Object.keys(problems).filter((f) => fs.existsSync(path.join(dir, f)));
  const cacheDir = projectId ? projectPath(projectId, 'wow-responsive') : null;
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const before = {}; const report = { repaired: [], unchanged: [] };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++]; const file = path.join(dir, f);
      const html = fs.readFileSync(file, 'utf8'); const hint = problems[f].map((l) => '- ' + l).join('\n');
      const hash = crypto.createHash('sha256').update('repair1' + RESPONSIVE_SYSTEM + hint + html).digest('hex').slice(0, 24);
      const answerFile = cacheDir ? path.join(cacheDir, hash + '.answer.json') : null;
      const remembered = answerFile ? { get: () => (fs.existsSync(answerFile) ? JSON.parse(fs.readFileSync(answerFile, 'utf8')) : null), set: (a) => fs.writeFileSync(answerFile, JSON.stringify(a)) } : null;
      const r = await responsivePage({ html, projectId, ask, label: f, remembered, hint });
      if (r.status === 'redesigned') { before[f] = html; fs.writeFileSync(file, r.html); report.repaired.push(f); } else report.unchanged.push(f);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  report.before = before; // the pages as they were, so a repair that made things worse can be undone
  return report;
}
