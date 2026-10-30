// The "generate first" customer page: three short screens (who you are, your pages, generate), then the finished draft website.
// Start with: npm run wow   then open http://localhost:3010
// One website is made at a time (the others wait in line): Stitch and the machine's memory are the limit.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectPath } from '../lib/project.js';
import { run, loadType, orderPages, withExtraPages, slugOf } from '../wow/run.js';
import { ensureType, hasType, KNOWN_TYPES, tierOf, TIER_LABELS } from '../wow/typeResearch.js';
import { saveLogo } from '../wow/brand.js';
import { structureSite } from '../wow/structure.js';
import { handle as editorHandle } from './editor.js';

const PORT = Number(process.env.WOW_PORT) || 3010;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'wow-public');
const ID_PATTERN = /^w-[a-f0-9]{10}$/;
const MAX_PAGES = 14; // more pages is more waiting and more cost
const MAX_JOBS_PER_DAY = Number(process.env.WOW_MAX_JOBS_PER_DAY) || 15;
const FILE_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function readBody(req, limit = 20_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw fail(413, 'That is too much text.'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail(400, 'Something was wrong with what was sent.'); }
}

export function createWowServer({ runJob = run } = {}) {
  const jobs = new Map();
  const queue = []; let working = false;
  const today = () => new Date().toISOString().slice(0, 10);
  let counted = { day: today(), n: 0 };

  const save = (job) => { try { fs.mkdirSync(projectPath(job.id), { recursive: true }); fs.writeFileSync(projectPath(job.id, 'wow-state.json'), JSON.stringify(job, null, 2)); } catch { /* the screen still works from memory */ } };
  const load = (id) => {
    if (jobs.has(id)) return jobs.get(id);
    try { const j = JSON.parse(fs.readFileSync(projectPath(id, 'wow-state.json'), 'utf8')); if (j.state === 'working' || j.state === 'queued') { j.state = 'failed'; j.error = 'This website was interrupted when the server restarted. Please make it again.'; } jobs.set(id, j); return j; } catch { return null; }
  };

  async function next() {
    if (working || !queue.length) return;
    working = true;
    const job = queue.shift();
    job.state = 'working'; job.startedAt = Date.now(); save(job);
    queue.forEach((j, i) => { j.position = i + 1; });
    try {
      await runJob({
        projectId: job.id,
        options: {
          name: job.name, type: job.type, pages: job.pageIds, extraPages: job.extraPages, language: job.language, brandColors: job.brandColors, notes: job.notes, concurrency: 3,
          onProgress: (e) => {
            if (e.type === 'step' && e.key === 'brief') { job.step = e.status === 'done' ? 'drawing' : 'brief'; if (e.concept) job.concept = e.concept; if (e.pages) for (const p of e.pages) { const mine = job.pages.find((x) => x.slug === p.slug); if (mine) mine.title = p.title; } }
            if (e.type === 'page') { const p = job.pages.find((x) => x.slug === e.slug); if (p) p.status = e.status; }
            if (e.type === 'preview') job.previewReady = true;
            if (e.type === 'step' && e.key === 'finish') job.step = e.status === 'done' ? 'done' : 'finishing';
            save(job);
          },
        },
      });
      job.state = 'done'; job.step = 'done'; job.previewReady = true;
    } catch (err) {
      console.error(`[wow] ${job.id} failed: ${err.stack ?? err.message}`);
      job.state = 'failed'; job.error = 'We could not finish this website. Please try again in a moment.';
      job.internalError = String(err.message).slice(0, 400);
    }
    job.finishedAt = Date.now(); save(job);
    working = false; next();
  }

  async function api(req, res, url) {
    if (url.pathname === '/api/types' && req.method === 'GET') return send(res, 200, { types: KNOWN_TYPES.map((t) => ({ ...t, ready: hasType(t.id) })) });

    // the page cards for a business type (a type we do not have yet is drafted by the model once, then kept)
    if (url.pathname === '/api/pages' && req.method === 'POST') {
      const b = await readBody(req);
      const known = KNOWN_TYPES.find((t) => t.id === b.type);
      const label = known?.label ?? text(b.label, 60);
      if (!known && label.length < 3) throw fail(400, 'Please tell us what your business is.');
      let id;
      try { id = await ensureType({ id: known?.id ?? slugOf(label), label, kind: known?.kind ?? 'intro' }); } catch (err) { console.error(`[wow] page ideas failed: ${err.message}`); throw fail(500, 'We could not find page ideas right now. Please try again.'); }
      const data = loadType(id);
      // most important first; a file written by hand (no tiers) gets its tiers from what it says
      const order = { essential: 0, recommended: 1, optional: 2 };
      const pages = data.pages.map((p, i) => ({ i, tier: tierOf(p), id: p.id, title: p.title, purpose: p.purpose, default: Boolean(p.default), locked: false, feature: p.feature ?? '', sections: (p.sections ?? []).map((s) => s.title) }));
      pages.sort((a, b) => order[a.tier] - order[b.tier] || a.i - b.i);
      return send(res, 200, { type: id, label: data.label, tiers: TIER_LABELS, pages: pages.map(({ i, ...p }) => p) });
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const b = await readBody(req, 6_000_000); // room for a logo picture
      const name = text(b.name, 80);
      if (name.length < 2) throw fail(400, 'Please tell us the name of your business.');
      const type = slugOf(text(b.type, 60));
      if (!hasType(type)) throw fail(400, 'Please choose the kind of business first.');
      const extraPages = (Array.isArray(b.extraPages) ? b.extraPages : []).map((t) => text(t, 40)).filter(Boolean).slice(0, 3);
      const typeData = withExtraPages(loadType(type), extraPages);
      const known = new Set(typeData.pages.map((p) => p.id));
      const chosen = (Array.isArray(b.pages) ? b.pages : []).filter((id) => typeof id === 'string' && known.has(id));
      const pageIds = orderPages(typeData, [...chosen, ...extraPages.map(slugOf)]);
      if (pageIds.length < 3) throw fail(400, 'Please choose at least 3 pages.');
      if (pageIds.length > MAX_PAGES) throw fail(400, `Please choose at most ${MAX_PAGES} pages.`);
      if (counted.day !== today()) counted = { day: today(), n: 0 };
      const id = `w-${crypto.randomBytes(5).toString('hex')}`;
      if (b.logo) await saveLogo(id, b.logo); // a file that is not a picture is refused here, before anything is paid for
      if (counted.n >= MAX_JOBS_PER_DAY) throw fail(429, 'We have made as many websites as we can for today. Please come back tomorrow.');
      counted.n++;
      const job = {
        id, name, domain: text(b.domain, 100), type, typeLabel: typeData.label, language: text(b.language, 30) || 'English', brandColors: text(b.brandColors, 120), notes: text(b.notes, 600), hasLogo: Boolean(b.logo), pageIds, extraPages,
        pages: pageIds.map((pid) => ({ slug: pid, title: typeData.pages.find((p) => p.id === pid)?.title ?? pid, status: 'waiting' })),
        state: 'queued', step: 'queued', position: queue.length + (working ? 1 : 0), createdAt: Date.now(), previewReady: false,
      };
      jobs.set(id, job); save(job); queue.push(job); next();
      return send(res, 200, { id });
    }

    // the customer approves the design: it becomes code (lists turn into data, texts and pictures into editable parts); the editors open on it
    const approve = url.pathname.match(/^\/api\/approve\/([^/]+)$/);
    if (approve && req.method === 'POST') {
      if (!ID_PATTERN.test(approve[1])) throw fail(404, 'Not found');
      const job = load(approve[1]);
      if (!job || job.state !== 'done') throw fail(400, 'The website is not finished yet.');
      const siteDir = projectPath(approve[1], 'wow-site');
      if (!fs.existsSync(siteDir)) throw fail(400, 'The website is not there anymore.');
      const report = await structureSite({ dir: siteDir, projectId: approve[1] });
      return send(res, 200, { ok: true, pages: report.pages.length, lists: report.lists, items: report.items, notConverted: report.notVerified });
    }

    const status = url.pathname.match(/^\/api\/status\/([^/]+)$/);
    if (status && req.method === 'GET') {
      if (!ID_PATTERN.test(status[1])) throw fail(404, 'Not found');
      const job = load(status[1]);
      if (!job) throw fail(404, 'We could not find this website.');
      const { internalError, ...visible } = job; // what went wrong inside stays on the server
      void internalError;
      visible.approved = fs.existsSync(projectPath(status[1], 'wow-structure', 'report.json')); // the design was approved and converted to code
      return send(res, 200, visible);
    }
    throw fail(404, 'Not found');
  }

  function serveSite(res, url) {
    const [, , id, ...rest] = url.pathname.split('/');
    if (!ID_PATTERN.test(id ?? '')) return send(res, 404, { error: 'Not found' });
    const root = projectPath(id, 'wow-site');
    let file = path.join(root, decodeURIComponent(rest.join('/') || 'index.html'));
    if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'Not allowed' });
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': FILE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      // the editors (on the page, and as lists) for a website that was approved
      if (/^\/api\/w-[a-f0-9]{10}\//.test(url.pathname) || /^\/(p|preview|list)\/w-[a-f0-9]{10}\//.test(url.pathname)) return await editorHandle(req, res);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname.startsWith('/site/')) return serveSite(res, url);
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) console.error(`[wow] ${err.stack ?? err.message}`);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  });
  return { server, jobs, queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWowServer().server.listen(PORT, '127.0.0.1', () => console.log(`[wow] Website maker running at http://localhost:${PORT}`));
}
