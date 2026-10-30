// The CUSTOMER-facing website: a form about the business, then two sketches to choose from.
// A separate server from the internal control panel on purpose: a customer must never reach the internal tools.
// Start with: npm run customer   then open http://localhost:3001

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectPath, readJson, writeJson, exists } from '../lib/project.js';
import { siteBriefSchema } from '../schemas/siteBrief.js';
import { assetManifestSchema } from '../schemas/assetManifest.js';
import { contentSpecSchema } from '../schemas/contentSpec.js';
import { designManifestSchema } from '../schemas/designManifest.js';
import { run as runBrief } from '../stages/01-discovery/index.js';
import { run as runAssets } from '../stages/02-assets/index.js';
import { enrich, applyProposals } from '../stages/01-discovery/enrich.js';
import { run as runDirect } from '../stages/03-creative-director/index.js';
import { run as runContent } from '../stages/04-content/index.js';
import { run as runDesign } from '../stages/05-design-stitch/index.js';
import { chooseSketch, approvePages } from '../stages/06-review/index.js';
import { addVariant, swapVersion } from '../stages/05-design-stitch/index.js';
import { editState, editText, editImage, undoEdit, revertAll } from '../lib/siteEdits.js';
import { aiOptions, aiGenerate, previewBytes } from '../lib/aiEdit.js';
import { submitRequest, undoRequest } from '../lib/changeRequests.js';
import { readPriceList } from '../lib/shopItems.js';
import { createGuard } from './guard.js';
import { prepareAssistant } from '../stages/10-assistant/index.js';
import { createOrdersServer, ordersDir } from './orders/server.js';
import { createFlow, MAX_VARIANTS_PER_REQUEST, validateSubmission, formToAnswers, safeUploadName, looksLikeFile, uploadLimit, friendlyProposals, MAX_FILES, GOAL_OPTIONS, PAGE_OPTIONS, FEATURE_OPTIONS } from './customerFlow.js';

const PORT = Number(process.env.CUSTOMER_PORT) || 3001;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'customer-public');
const ID_PATTERN = /^c-[a-z0-9-]{3,60}$/;
const SERVED_PREFIXES = ['design/', 'inputs/assets/', 'inputs/composed/', 'edits/ai/']; // customers can only see the sketches and their own uploads
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

// The real pipeline steps (the flow decides the order, these do the work).
export const realSteps = {
  brief: async (id) => {
    await runBrief({ projectId: id, options: {} });
    // the website assistant (an extra): its knowledge is prepared now; if that fails the website is still made, and it can be run again
    // (the tuning takes a few minutes, so it runs when the team delivers the site: node src/cli.js assistant --project <id>)
    try { await prepareAssistant({ projectId: id, tune: false }); } catch (err) { console.error(`[customer] the assistant could not be prepared for ${id}: ${err.message}`); }
  },
  photos: (id) => runAssets({ projectId: id, options: {} }),
  findings: async (id) => {
    const manifest = readJson(id, 'asset-manifest.json', assetManifestSchema);
    if (!manifest.assets.length && !manifest.documents.length) return [];
    await enrich({ projectId: id });
    return friendlyProposals(readJson(id, 'site-brief.json', siteBriefSchema).proposals);
  },
  applyDecisions: async (id, { accept = [], reject = [], skip = {} }) => {
    const brief = readJson(id, 'site-brief.json', siteBriefSchema);
    brief.proposals.forEach((p, i) => {
      if (p.status !== 'pending') return;
      p.status = accept.includes(i) && !reject.includes(i) ? 'accepted' : 'rejected';
      // the customer unticked some names of a list: they are not used (nothing left = the whole proposal is rejected)
      if (p.status === 'accepted' && Array.isArray(p.value) && Array.isArray(skip[i])) {
        p.value = p.value.filter((_, k) => !skip[i].includes(k));
        if (!p.value.length) p.status = 'rejected';
      }
    });
    writeJson(id, 'site-brief.json', applyProposals(brief), siteBriefSchema);
  },
  direction: (id) => runDirect({ projectId: id, options: {} }),
  copy: (id) => runContent({ projectId: id, options: {} }),
  // ONE design by default: the creative director's version, ALL pages of the website in one run
  sketches: (id) => runDesign({ projectId: id, options: { all: true, variants: 0 } }),
  // sketch 2 (Stitch creative on its own), only when the customer asks for a different style
  another: (id) => runDesign({ projectId: id, options: { freestyle: true } }),
  // another version of one page (Stitch draws a different layout and colours with the same text), and switching between the versions
  variant: (id, slug) => addVariant({ projectId: id, slug }),
  useVersion: async (id, slug, screenId) => swapVersion({ projectId: id, slug, screenId }),
  // the customer chose: Stage 6 records it and approves the home page in that style
  recordChoice: async (id, { choice, note }) => { if (exists(id, 'design/design-manifest.json')) chooseSketch(id, { choice: Number(choice), note: String(note ?? '').slice(0, 1000) }); },
  // all pages are approved when every page exists (the customer saw them all)
  approve: async (id) => { if (exists(id, 'design/design-manifest.json')) approvePages(id); },
  // other pages are drawn in the chosen style when they are missing (choosing sketch 2)
  rest: async (id) => { if (exists(id, 'design/design-manifest.json')) await runDesign({ projectId: id, options: { rest: true } }); },
};

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('That file is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const readJsonBody = async (req) => { const raw = (await readBody(req, 300 * 1024)).toString('utf8'); return raw ? JSON.parse(raw) : {}; };

const projectExists = (id) => ID_PATTERN.test(id || '') && fs.existsSync(projectPath(id));
const photoFiles = (id) => (fs.existsSync(projectPath(id, 'inputs/assets')) ? fs.readdirSync(projectPath(id, 'inputs/assets')) : []);

// the pages of sketch 1 (every page the creative director's design has), with their names
function pagesOf(id) {
  if (!exists(id, 'design/design-manifest.json') || !exists(id, 'site-brief.json')) return [];
  const manifest = readJson(id, 'design/design-manifest.json', designManifestSchema);
  const brief = readJson(id, 'site-brief.json', siteBriefSchema);
  return brief.pages.filter((p) => manifest.pages.some((m) => m.slug === p.slug)).map((p) => {
    const m = manifest.pages.find((x) => x.slug === p.slug);
    return { slug: p.slug, title: p.title, url: `/p/${id}/${m.html}`, picture: `/p/${id}/${m.screenshot}`, other: m.variants.map((v) => ({ screenId: v.screenId, url: `/p/${id}/${v.html}`, picture: `/p/${id}/${v.screenshot}` })) };
  });
}

// The saved file with the same name (or the same name with -2, -3...) and exactly the same bytes, if there is one.
function findSameFile(id, name, body) {
  const names = photoFiles(id);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : name.replace(/(\.[a-z]+)$/i, `-${n}$1`);
    if (!names.includes(candidate)) return null;
    if (fs.readFileSync(projectPath(id, 'inputs/assets', candidate)).equals(body)) return candidate;
  }
}
// Two saved files with identical bytes are one picture: the first (by name) stays.
export function dropDuplicateFiles(id) {
  const seen = new Set(); let removed = 0;
  for (const f of photoFiles(id).sort((a, b) => a.length - b.length || a.localeCompare(b))) { // an original is shorter than its "-2" copy
    const file = projectPath(id, 'inputs/assets', f);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (seen.has(hash)) { fs.rmSync(file); removed++; } else seen.add(hash);
  }
  return removed;
}

export function createCustomerServer({ steps = realSteps, aiDeps = {}, guard = createGuard() } = {}) {
  const flow = createFlow({ steps });

  // one card of "my projects": the business name, a picture, and where the request stands (nothing internal)
  const summaryOf = (id) => {
    const s = flow.status(id);
    if (!s) return null;
    const answersFile = projectPath(id, 'inputs/answers.json');
    const name = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf8')).businessName || '' : '';
    const pictures = photoFiles(id).filter((f) => /.(jpe?g|png|webp)$/i.test(f) && !/^document-/i.test(f)); // a picture of a menu is not the request's picture
    const picture = pictures.find((f) => /^logo./i.test(f)) ?? pictures[0];
    return { id, name, phase: s.phase, createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null, picture: picture ? `/p/${id}/inputs/assets/${encodeURIComponent(picture)}` : null };
  };

  // pictures arranged from the customer's own photos: shown to the customer, who approves or rejects each one
  const combinedOf = (id) => {
    if (!exists(id, 'asset-manifest.json')) return [];
    return readJson(id, 'asset-manifest.json', assetManifestSchema).assets.filter((a) => a.origin || a.derivedFrom?.length)
      .map((a) => ({ id: a.id, picture: `/p/${id}/${a.file}`, origin: a.origin ?? 'collage', photos: a.derivedFrom?.length ?? 0, approval: a.approval ?? 'pending' }));
  };

  // what the designer did with the owner's wishes for the home page (plain words only)
  const wishesOf = (id) => {
    if (!exists(id, 'design-spec.json')) return [];
    try { return (JSON.parse(fs.readFileSync(projectPath(id, 'design-spec.json'), 'utf8')).wishResponses ?? []).map((w) => ({ wish: String(w.wish), outcome: w.outcome, how: String(w.how) })); } catch { return []; }
  };

  // the status the page needs; internal details never leave the server
  const publicStatus = (id) => {
    const s = flow.status(id);
    if (!s) return null;
    const { internalError, ...safe } = s;
    const choice = exists(id, 'customer-choice.json') ? JSON.parse(fs.readFileSync(projectPath(id, 'customer-choice.json'), 'utf8')) : null;
    const ready = ['ready', 'building', 'chosen'].includes(s.phase);
    const siteReady = s.phase === 'chosen' && editState(id).ready && fs.existsSync(projectPath(id, 'site/dist/index.html'));
    // a long list (a menu) is drawn with a sample of its rows; the finished website has every item of the owner's list
    const longLists = ready && exists(id, 'content-spec.json') ? readJson(id, 'content-spec.json', contentSpecSchema).pages.flatMap((p) => p.sections.filter((x) => x.items.length >= 9).map((x) => x.items.length)).reduce((a, b) => a + b, 0) : 0;
    return { ...safe, longLists, siteReady, maxVersions: MAX_VARIANTS_PER_REQUEST, choice, pages: ready ? pagesOf(id) : [], combined: ready ? combinedOf(id) : [], wishes: ready ? wishesOf(id) : [], sketches: ready ? { 1: `/p/${id}/design/home.html`, 2: s.alt === 'ready' ? `/p/${id}/design/freestyle/home-freestyle.html` : null } : null };
  };

  async function api(req, res, url) {
    const [, , action, id] = url.pathname.split('/');
    const method = req.method;

    // invisible protection (no sign-in for customers): limits per device, and a daily cap on paid AI work (see guard.js)
    const PAID = ['submit', 'retry', 'another', 'variant', 'confirm', 'combined'];
    const kinds = action === 'start' ? ['start'] : action === 'read-list' ? ['list'] : (PAID.includes(action) && method === 'POST') || (action === 'edit' && url.pathname.split('/')[4] === 'ai' && method === 'POST') ? ['paid'] : [];
    if (kinds.length) { const g = guard.check(req, kinds); if (!g.ok) return send(res, g.status, { error: g.message }); }

    if (action === 'options' && method === 'GET') return send(res, 200, { goals: GOAL_OPTIONS, pages: PAGE_OPTIONS, features: FEATURE_OPTIONS });

    if (action === 'start' && method === 'POST') {
      const newId = `c-${crypto.randomBytes(6).toString('hex')}`;
      fs.mkdirSync(projectPath(newId, 'inputs', 'assets'), { recursive: true });
      flow.save(newId, { phase: 'new', createdAt: new Date().toISOString() });
      return send(res, 201, { id: newId });
    }

    if (action === 'mine' && method === 'POST') {
      const { ids = [] } = await readJsonBody(req);
      const mine = (Array.isArray(ids) ? ids : []).slice(0, 30).filter((x) => typeof x === 'string' && projectExists(x)).map((x) => summaryOf(x)).filter((x) => x && x.phase !== 'new');
      return send(res, 200, mine.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
    }

    if (!projectExists(id)) return send(res, 404, { error: 'We could not find your request. Please start again.' });
    const state = flow.status(id);

    // the customer edits the finished website: texts, pictures, undo (see lib/siteEdits.js)
    if (action === 'edit') {
      const op = url.pathname.split('/')[4] ?? 'state';
      if (op === 'state' && method === 'GET') return send(res, 200, { ...editState(id), pages: sitePagesOf(id), ai: aiOptions(id, aiDeps.generation === undefined ? {} : { generation: aiDeps.generation }) });
      // a picture made with AI: first a preview (it costs money, so it is limited), and it is only used when the customer says so
      if (op === 'ai' && method === 'POST') { const b = await readJsonBody(req); return send(res, 200, await aiGenerate(id, { scene: b.scene, products: b.products, ratio: b.ratio, mode: b.mode === 'exact' ? 'exact' : 'natural', deps: aiDeps })); }
      if (op === 'ai-use' && method === 'POST') { const b = await readJsonBody(req); return send(res, 200, await editImage(id, String(b.key ?? ''), { bytes: previewBytes(id, b.file), alt: b.alt, ai: true })); }
      if (op === 'text' && method === 'POST') { const b = await readJsonBody(req); return send(res, 200, editText(id, String(b.key ?? ''), b.value)); }
      if (op === 'image' && method === 'PUT') {
        const bytes = await readBody(req, uploadLimit('photo'));
        if (!looksLikeFile(bytes, '.jpg') && !looksLikeFile(bytes, '.png') && !looksLikeFile(bytes, '.webp')) return send(res, 400, { error: 'That file is not a picture we can use. Please choose a JPG, PNG or WebP photo.' });
        return send(res, 200, await editImage(id, String(url.searchParams.get('key') ?? ''), { bytes, alt: url.searchParams.get('alt') }));
      }
      // a bigger change in the customer's own words (colours, fonts, text size, order of sections): see lib/changeRequests.js
      if (op === 'request' && method === 'POST') { const b = await readJsonBody(req); const done = await submitRequest(id, b.text, { deps: aiDeps }); return send(res, 200, { ...done, ...editState(id) }); }
      if (op === 'request-undo' && method === 'POST') { undoRequest(id, String((await readJsonBody(req)).id ?? '')); return send(res, 200, editState(id)); }
      if (op === 'undo' && method === 'POST') return send(res, 200, undoEdit(id, String((await readJsonBody(req)).key ?? '')));
      if (op === 'revert-all' && method === 'POST') return send(res, 200, revertAll(id));
      return send(res, 404, { error: 'Not found' });
    }

    // the shop form: read the pictures of the owner's price list into the product table (they check every row before it is used)
    if (action === 'read-list' && method === 'POST') {
      if (state.phase !== 'new') return send(res, 409, { error: 'Your request was already sent.' });
      const docs = photoFiles(id).filter((f) => /^document-/i.test(f) || /\.pdf$/i.test(f)).map((f) => projectPath(id, 'inputs/assets', f));
      if (!docs.length) return send(res, 400, { error: 'Please add your price list first (a PDF or pictures of its pages).' });
      try { return send(res, 200, { items: await (aiDeps.readList ?? readPriceList)({ projectId: id, files: docs, deps: aiDeps }) }); }
      catch { return send(res, 502, { error: 'We could not read that price list just now. You can type your products instead, or try again in a moment.' }); }
    }

    if (action === 'upload' && method === 'PUT') {
      if (state.phase !== 'new') return send(res, 409, { error: 'Your request was already sent.' });
      const kind = url.searchParams.get('kind');
      const name = safeUploadName(url.searchParams.get('name'), kind);
      if (!name) return send(res, 400, { error: kind === 'knowledge' ? 'This kind of file is not supported. Please use PDF, Word (.docx), text, CSV or a picture.' : 'This kind of file is not supported. Please use JPG, PNG, WebP or PDF.' });
      const body = await readBody(req, uploadLimit(kind));
      if (!looksLikeFile(body, path.extname(name))) return send(res, 400, { error: kind === 'knowledge' ? 'This file does not look like a real PDF, Word, text or picture file.' : 'This file does not look like a real picture or PDF.' });
      if (kind === 'knowledge') { // what the website assistant should know: kept apart from the photos of the website
        const dir = projectPath(id, 'inputs/knowledge'); fs.mkdirSync(dir, { recursive: true });
        const have = fs.readdirSync(dir);
        const same = have.find((f) => f === name && fs.statSync(path.join(dir, f)).size === body.length);
        if (same) return send(res, 200, { saved: same });
        if (have.length >= 10) return send(res, 400, { error: 'You can add up to 10 files for the assistant.' });
        let finalName = name;
        for (let n = 2; have.includes(finalName); n++) finalName = name.replace(/(\.[a-z0-9]+)$/i, `-${n}$1`);
        fs.writeFileSync(path.join(dir, finalName), body);
        return send(res, 200, { saved: finalName });
      }
      // Sending the same file again (a retry after a failed attempt) never adds a copy: the saved one is reused.
      const same = findSameFile(id, name, body);
      if (same) return send(res, 200, { saved: same });
      if (photoFiles(id).length >= MAX_FILES) return send(res, 400, { error: `You can add up to ${MAX_FILES} files.` });
      if (kind === 'logo') for (const f of photoFiles(id)) if (/^logo\./i.test(f)) fs.rmSync(projectPath(id, 'inputs/assets', f));
      let finalName = name;
      for (let n = 2; photoFiles(id).includes(finalName); n++) finalName = name.replace(/(\.[a-z]+)$/i, `-${n}$1`);
      fs.writeFileSync(projectPath(id, 'inputs/assets', finalName), body);
      return send(res, 200, { saved: finalName });
    }

    if (action === 'submit' && method === 'POST') {
      if (state.phase !== 'new') return send(res, 409, { error: 'Your request was already sent.' });
      const form = (await readJsonBody(req)).form ?? {};
      dropDuplicateFiles(id); // copies left by an earlier failed attempt
      form.hasLogo = photoFiles(id).some((f) => /^logo\./i.test(f));
      const check = validateSubmission(form);
      if (!check.ok) return send(res, 400, { error: check.errors.join(' '), errors: check.errors });
      fs.writeFileSync(projectPath(id, 'inputs/answers.json'), JSON.stringify(formToAnswers(form), null, 2));
      flow.save(id, { phase: 'queued' });
      flow.start(id);
      return send(res, 202, { id });
    }

    if (action === 'status' && method === 'GET') return send(res, 200, publicStatus(id));

    if (action === 'confirm' && method === 'POST') {
      if (state.phase !== 'confirm') return send(res, 409, { error: 'There is nothing to confirm right now.' });
      const { accept = [], reject = [], skip = {} } = await readJsonBody(req);
      flow.save(id, { phase: 'designing', findings: [] });
      const skipClean = Object.fromEntries(Object.entries(skip && typeof skip === 'object' ? skip : {}).map(([i, ks]) => [Number(i), [].concat(ks).map(Number).filter(Number.isInteger)]));
      flow.confirm(id, { accept: accept.map(Number), reject: reject.map(Number), skip: skipClean });
      return send(res, 202, { id });
    }

    if (action === 'combined' && method === 'POST') {
      if (!['ready', 'chosen'].includes(state.phase)) return send(res, 409, { error: 'Your sketch is not ready yet.' });
      const { assetId, approve } = await readJsonBody(req);
      const manifest = readJson(id, 'asset-manifest.json', assetManifestSchema);
      const asset = manifest.assets.find((a) => a.id === assetId && (a.origin || a.derivedFrom?.length));
      if (!asset) return send(res, 404, { error: 'We could not find that picture.' });
      asset.approval = approve ? 'approved' : 'rejected';
      writeJson(id, 'asset-manifest.json', manifest, assetManifestSchema);
      return send(res, 200, { combined: combinedOf(id) });
    }

    if (action === 'retry' && method === 'POST') {
      if (state.phase !== 'failed') return send(res, 409, { error: 'Nothing to retry.' });
      flow.save(id, { phase: 'queued', message: '' });
      flow.retry(id);
      return send(res, 202, { id });
    }

    if (action === 'another' && method === 'POST') {
      if (state.phase !== 'ready') return send(res, 409, { error: 'Your sketch is not ready yet.' });
      flow.another(id);
      return send(res, 202, { id });
    }

    if (action === 'variant' && method === 'POST') {
      if (state.phase !== 'ready') return send(res, 409, { error: 'Your design is not ready yet.' });
      const slug = String((await readJsonBody(req)).slug ?? '');
      if (!pagesOf(id).some((p) => p.slug === slug)) return send(res, 404, { error: 'We could not find that page.' });
      if ((pagesOf(id).find((p) => p.slug === slug)?.other ?? []).length) return send(res, 409, { error: 'This page already has another version.' });
      try { flow.variant(id, slug); } catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
      return send(res, 202, { id });
    }

    if (action === 'version' && method === 'POST') {
      if (state.phase !== 'ready') return send(res, 409, { error: 'Your design is not ready yet.' });
      const { slug, screenId } = await readJsonBody(req);
      try { await steps.useVersion(id, String(slug ?? ''), String(screenId ?? '')); } catch { return send(res, 404, { error: 'We could not find that version.' }); }
      return send(res, 200, publicStatus(id));
    }

    if (action === 'choose' && method === 'POST') {
      if (!['ready', 'chosen'].includes(state.phase)) return send(res, 409, { error: 'Your sketch is not ready yet.' });
      const { choice, note } = await readJsonBody(req);
      if (![1, 2].includes(Number(choice))) return send(res, 400, { error: 'Please choose sketch 1 or 2.' });
      if (Number(choice) === 2 && state.alt !== 'ready') return send(res, 409, { error: 'The other style is not ready yet.' });
      fs.writeFileSync(projectPath(id, 'customer-choice.json'), JSON.stringify({ choice: Number(choice), note: String(note ?? '').slice(0, 1000), at: new Date().toISOString() }, null, 2));
      // Stage 6 records it and the other pages are drawn in the chosen style (in the background)
      flow.finish(id, { choice: Number(choice), note });
      return send(res, 200, { saved: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // the pages of the finished site, for the editing toolbar
  const sitePagesOf = (id) => {
    try { return JSON.parse(fs.readFileSync(projectPath(id, 'site/site-report.json'), 'utf8')).pages.map((p) => ({ title: p.title, route: p.route })); } catch { return []; }
  };

  // The finished website, served under /site/<id>/ so the customer can look at it and edit it. With ?edit=1 the page gets the editing
  // overlay; the delivered site never contains it. Root-relative addresses are moved under the prefix so images, styles and links keep working.
  function serveSite(res, url) {
    const [, , id, ...rest] = url.pathname.split('/');
    if (!projectExists(id)) return send(res, 404, { error: 'Not found' });
    const dist = projectPath(id, 'site/dist');
    let full = path.resolve(dist, decodeURIComponent(rest.join('/')));
    if (!full.startsWith(dist)) return send(res, 404, { error: 'Not found' });
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full)) return send(res, 404, { error: 'Not found' });
    const type = { ...TYPES, '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain' }[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
    const prefix = `/site/${id}/`;
    if (/\.(html|css)$/i.test(full)) {
      let body = fs.readFileSync(full, 'utf8')
        .replace(/(\s(?:src|href|action|poster)=")\/(?!\/)/gi, `$1${prefix}`)
        .replace(/url\((['"]?)\/(?!\/)/gi, `url($1${prefix}`);
      if (full.endsWith('.html') && url.searchParams.get('edit') === '1') body = body.replace(/<\/body>/i,`<script src="/edit/overlay.js" data-id="${id}" data-prefix="${prefix}"></script></body>`);
      return send(res, 200, body, type);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  }

  // The finished website inside a phone-sized frame (the real pages, at a real phone width), with a switch between the pages and the
  // sizes. /phone/<id>/?p=<page>&w=<width>
  const DEVICES = [[390, 844, 'Phone'], [360, 740, 'Small phone'], [768, 1024, 'Tablet']];
  function servePhone(res, url) {
    const id = url.pathname.split('/')[2];
    if (!/^c-[a-z0-9-]{3,60}$/.test(id ?? '') || !projectExists(id)) return send(res, 404, { error: 'Not found' });
    const dist = projectPath(id, 'site/dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) return send(res, 404, { error: 'The website is not built yet.' });
    const pages = ['home', ...fs.readdirSync(dist, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dist, e.name, 'index.html'))).map((e) => e.name).filter((n) => !/^(_|images$|assets$)/.test(n))];
    const page = pages.includes(url.searchParams.get('p')) ? url.searchParams.get('p') : 'home';
    const device = DEVICES.find((d) => String(d[0]) === url.searchParams.get('w')) ?? DEVICES[0];
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const link = (p, w) => `/phone/${id}/?p=${encodeURIComponent(p)}&w=${w}`;
    const tab = (href, label, on) => `<a href="${href}" class="${on ? 'on' : ''}">${esc(label)}</a>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>See it on a phone</title><style>
body{margin:0;background:#dfe5e8;font:15px/1.4 system-ui,sans-serif;color:#17222a;padding:18px 12px 12px;text-align:center}
h1{font-size:19px;margin:0 0 4px} p{margin:0 0 14px;color:#4d5d66}
.row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:0 0 10px}
a{padding:7px 14px;border-radius:99px;background:#fff;color:#17222a;text-decoration:none;border:1px solid #c5d0d5} a.on{background:#17222a;color:#fff;border-color:#17222a}
.phone{display:inline-block;background:#111;border-radius:42px;padding:14px 12px 18px;box-shadow:0 18px 50px rgba(0,0,0,.28);margin-top:10px}
iframe{display:block;border:0;background:#fff;border-radius:28px;width:${device[0]}px;height:${device[1]}px}
.stage{position:relative;margin:10px auto 0}.stage .phone{position:absolute;left:50%;top:0;margin:0;transform-origin:top center}
</style></head><body><h1>How it looks on a ${device[2].toLowerCase()}</h1><p>This is your real website, shown at ${device[0]} pixels wide. Scroll inside the screen.</p>
<div class="row">${pages.map((p) => tab(link(p, device[0]), p === 'home' ? 'Home' : p.replace(/-/g, ' '), p === page)).join('')}</div>
<div class="row">${DEVICES.map((d) => tab(link(page, d[0]), `${d[2]} (${d[0]})`, d[0] === device[0])).join('')}</div>
<div class="stage" id="stage"><div class="phone" id="phone"><iframe title="Your website on a ${esc(device[2].toLowerCase())}" src="/site/${id}/${page === 'home' ? '' : `${encodeURIComponent(page)}/`}"></iframe></div></div>
<script>(function(){var st=document.getElementById("stage"),ph=document.getElementById("phone");function fit(){var top=st.getBoundingClientRect().top+window.scrollY,room=window.innerHeight-top-16,w=ph.offsetWidth,h=ph.offsetHeight,s=Math.min(1,room/h,(window.innerWidth-24)/w);if(s<0.4)s=0.4;ph.style.transform="translateX(-50%) scale("+s+")";st.style.width=Math.round(w*s)+"px";st.style.height=Math.round(h*s)+"px";}window.addEventListener("resize",fit);window.addEventListener("load",fit);fit();})();</script></body></html>`;
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  // the sketches and the customer's own uploads, nothing else from the project
  function serveFile(res, url) {
    const [, , id, ...rest] = url.pathname.split('/');
    if (!projectExists(id)) return send(res, 404, { error: 'Not found' });
    const relative = decodeURIComponent(rest.join('/'));
    const full = path.resolve(projectPath(id), relative);
    const inside = full.startsWith(projectPath(id) + path.sep);
    if (!inside || !SERVED_PREFIXES.some((p) => relative.startsWith(p)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  }

  const businesses = new Map();
  async function previewOrder(req, res, url) {
    const id = url.pathname.split('/')[3] ?? '';
    if (!projectExists(id) || !fs.existsSync(projectPath(id, 'panel.json'))) return send(res, 404, { error: 'This website does not take orders.' });
    if (!businesses.has(id)) businesses.set(id, createOrdersServer({ dir: path.join(ordersDir(), id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')), siteId: id.toLowerCase().replace(/[^a-z0-9-]+/g, '-') }).handle);
    return businesses.get(id)(req, res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const g = guard.check(req, ['any']);
      if (!g.ok) return send(res, g.status, { error: g.message });
      // orders placed in the phone preview go to the business's own orders (the same database its live site uses)
      if (url.pathname.startsWith('/api/order/')) return await previewOrder(req, res, url);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname.startsWith('/p/')) return serveFile(res, url);
      if (url.pathname.startsWith('/site/')) return serveSite(res, url);
      if (url.pathname.startsWith('/phone/')) return servePhone(res, url);
      if (url.pathname === '/match.js') return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'match.js'), 'utf8'), 'text/javascript; charset=utf-8');
      if (url.pathname === '/edit/overlay.js') return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'edit-overlay.js'), 'utf8'), 'text/javascript; charset=utf-8');
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      return send(res, err.status ?? (err instanceof SyntaxError ? 400 : 500), { error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  });
  return { server, flow };
}

// start only when run directly (tests import createCustomerServer)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createCustomerServer().server.listen(PORT, '127.0.0.1', () => console.log(`[customer] Customer page running at http://localhost:${PORT}`));
}
