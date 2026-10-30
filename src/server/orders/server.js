// The order service: websites post their orders here, the restaurant's staff read them on a live panel.
//   npm run orders      http://localhost:3002   (ORDERS_PORT, ORDERS_DIR; data in <dir>/orders.db)
// Public:  POST /api/order/<siteId>                      a visitor's order or appointment request (the prices are recalculated here)
// Panel:   GET  /panel/<siteId>                          the page (sign in, first-time setup, password reset, orders, staff)
//          POST /api/panel/<siteId>/setup | login | logout | reset | password
//          GET  /api/panel/<siteId>/me | orders | staff
//          POST /api/panel/<siteId>/orders/<id>          { status }
//          POST /api/panel/<siteId>/staff                { name, email, password }  (owner)
//          POST /api/panel/<siteId>/staff/<userId>/reset | remove  (owner)
// Protection: accounts with salted scrypt passwords and 30-day sessions; one-time setup and reset links; sign-in attempts are
// limited; orders are size-limited, rate-limited per visitor, checked against the site's own price list, and a hidden field catches
// bots. No card data is ever received (payment is cash on delivery for now).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, SITE_ID } from './store.js';
import { answerChat } from './chat.js';
import { createAssistantCoach } from './assistantCoach.js';
import { createSiteEditor } from './siteEditor.js';
import { chatComplete } from '../../lib/llm.js';
import { createNotifier } from './notify.js';
import { createPusher, cleanSubscription } from './push.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ORDERS_PORT) || 3002;
export const ordersDir = () => process.env.ORDERS_DIR || path.resolve(HERE, '../../../orders-data');
const LIMIT = {
  order: { max: 8, windowMs: 10 * 60 * 1000 },    // placed orders per device
  try: { max: 40, windowMs: 10 * 60 * 1000 },     // order attempts (typos included)
  chat: { max: 25, windowMs: 10 * 60 * 1000 },    // questions to the assistant per device
  coach: { max: 30, windowMs: 60 * 60 * 1000 },
  alert: { max: 6, windowMs: 60 * 60 * 1000 },    // test alerts the owner sends per hour
  edit: { max: 240, windowMs: 60 * 60 * 1000 },   // the owner's edits of the website per hour   // the owner's coaching requests and test runs per hour
  login: { max: 8, windowMs: 15 * 60 * 1000 },    // failed sign-ins, setups and resets per device and site
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const send = (res, code, body, type = 'application/json', headers = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
async function readRaw(req, limit) {
  const chunks = []; let size = 0;
  let over = false;
  for await (const c of req) { // a file that is too large is read to the end and thrown away (up to 4 times the limit), so the browser gets a clear answer and not a broken connection
    size += c.length;
    if (size > limit * 4) { req.destroy(); break; }
    if (size > limit) { over = true; continue; }
    chunks.push(c);
  }
  if (over) throw Object.assign(new Error('That file is too large. Please choose a smaller photo.'), { status: 413 });
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 20 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('That request is too large.'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
const cookies = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

// One business (the way a site goes live): createOrdersServer({ dir, siteId, dist }). Its own database folder, its own panel at /panel,
// its orders at /api/order, and its finished website (dist) served from the same address, so the panel is on the business's own domain.
// Many businesses at once (development): createOrdersServer({ dir }); each has its panel at /panel/<siteId>.
// onOrder(siteId, order): called after every new order (the place to hang notifications: WhatsApp, SMS, email).
export function createOrdersServer({ dir = ordersDir(), siteId: single = '', dist = '', trustProxy = process.env.TRUST_PROXY === '1', onOrder = null, chatAsk = chatComplete, notifier = createNotifier({ log: (m) => console.warn(m) }), makePusher = (st) => createPusher({ store: st, log: (m) => console.warn(m) }) } = {}) {
  const store = createStore(dir);
  const pusher = makePusher(store); // the alerts on the phones of the people who run the business
  const coach = createAssistantCoach({ store, ask: chatAsk });
  const editor = single && dist ? createSiteEditor({ store, dir, dist }) : null; // the owner can edit the delivered website (base copy + the owner's changes)
  const hits = new Map();
  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  // Has this device done `what` `max` times in the window? record: count this one too.
  const tooMany = (what, scope, req, record = true) => {
    const { max, windowMs } = LIMIT[what];
    const key = `${what}|${scope}|${ipOf(req)}`; const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    const full = recent.length >= max;
    hits.set(key, record && !full ? [...recent, now] : recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 15 * 60 * 1000)) hits.delete(k);
    return full;
  };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  const cookieName = (siteId) => `ps_${siteId}`;
  const setCookie = (siteId, token) => `${cookieName(siteId)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`;
  const clearCookie = (siteId) => `${cookieName(siteId)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  const who = (siteId, req) => store.sessionUser(siteId, cookies(req)[cookieName(siteId)]);
  const lockedOut = (siteId, req) => tooMany('login', siteId, req, false);
  const failed = (siteId, req) => tooMany('login', siteId, req, true);
  const tooManyTries = { error: 'Too many tries. Please wait a few minutes and try again.' };

  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let parts = url.pathname.split('/').filter(Boolean);
    if (single) { // one business: its own address needs no site id (/panel, /api/panel/login, /api/order)
      if (parts[0] === 'panel' && parts.length === 1) parts = ['panel', single];
      else if (parts[0] === 'api' && parts[1] === 'panel' && parts[2] !== single) parts.splice(2, 0, single);
      else if (parts[0] === 'api' && (parts[1] === 'order' || parts[1] === 'availability' || parts[1] === 'chat') && parts.length === 2) parts.push(single);
    }
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (url.pathname === '/health') return send(res, 200, { ok: true });

      // a visitor's order
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'order' && parts.length === 3) {
        const siteId = parts[2];
        if (!SITE_ID.test(siteId) || !store.getSite(siteId)) return send(res, 404, { error: 'This website does not take orders.' }, 'application/json', cors);
        const body = await readJson(req);
        if (body.website) return send(res, 200, { ok: true, ref: 0 }, 'application/json', cors); // a bot filled the hidden field: pretend
        if (tooMany('try', siteId, req) || tooMany('order', siteId, req, false)) return send(res, 429, { error: 'Too many orders from this device. Please wait a few minutes or call us.' }, 'application/json', cors);
        const r = store.createOrder(siteId, body);
        if (r.error) return send(res, r.status ?? 400, { error: r.error }, 'application/json', cors);
        tooMany('order', siteId, req, true);
        try { onOrder?.(siteId, r.order); } catch { /* a failing notification never loses the order */ }
        // the people who run the business get a notification on their phones (no customer details in it: those stay in the panel)
        try { pusher.send(siteId, pusher.words(r.order.kind, store.getSite(siteId)?.name, r.order.id)).catch(() => {}); } catch { /* same */ }
        // the owner is told by WhatsApp and/or email (never awaited: the customer does not wait for it, and a failure never loses the order)
        try { notifier.send({ site: store.getSite(siteId), order: r.order, settings: store.getAlerts(siteId), owners: store.ownersOf(siteId) }).catch(() => {}); } catch { /* same */ }
        return send(res, 200, { ok: true, ref: r.order.id, total: r.order.total ?? null }, 'application/json', cors);
      }

      if (editor && req.method === 'GET' && url.pathname === '/edit-overlay.js') return send(res, 200, fs.readFileSync(path.resolve(HERE, '../customer-public/edit-overlay.js'), 'utf8'), 'text/javascript; charset=utf-8');

      // a customer's question to the website assistant (the conversation lives in their browser; nothing is stored here)
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chat' && parts.length === 3) {
        const siteId = parts[2];
        if (!SITE_ID.test(siteId) || !store.getSite(siteId)) return send(res, 404, { error: 'Not found.' }, 'application/json', cors);
        if (tooMany('chat', siteId, req)) return send(res, 429, { error: 'Too many questions from this device. Please wait a few minutes.' }, 'application/json', cors);
        const r = await answerChat({ store, body: await readJson(req, 16 * 1024), ask: chatAsk });
        return send(res, r.status, r.json, 'application/json', cors);
      }

      // the calendar a visitor sees: ?day=2026-10-30 gives the times of that day, otherwise the next days (booked times are not free)
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'availability' && parts.length === 3) {
        const siteId = parts[2];
        const day = url.searchParams.get('day');
        const r = day ? store.availabilityFor(siteId, day) : store.calendarFor(siteId, url.searchParams.get('from'), Number(url.searchParams.get('days')) || 14);
        return r ? send(res, 200, r, 'application/json', cors) : send(res, 404, { error: 'This website does not take appointments.' }, 'application/json', cors);
      }

      if (req.method === 'GET' && url.pathname === '/panel-sw.js') return send(res, 200, fs.readFileSync(path.join(HERE, 'panel-sw.js'), 'utf8'), 'text/javascript; charset=utf-8', { 'Service-Worker-Allowed': '/panel', 'Cache-Control': 'no-cache' });

      // the panel page (it works out by itself whether to show sign-in, setup, reset or the orders)
      if (req.method === 'GET' && parts[0] === 'panel' && parts.length === 2) {
        const siteId = parts[1];
        if (!SITE_ID.test(siteId) || !store.getSite(siteId)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
        return send(res, 200, fs.readFileSync(path.join(HERE, 'panel.html'), 'utf8').replace(/__SITE__/g, siteId), 'text/html; charset=utf-8', { 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      }

      if (parts[0] === 'api' && parts[1] === 'panel' && SITE_ID.test(parts[2] ?? '')) {
        const siteId = parts[2]; const site = store.getSite(siteId); const action = parts[3];
        if (!site) return send(res, 404, { error: 'Not found' });

        // ---- no account needed: these are protected by their own secret ----
        if (req.method === 'GET' && action === 'state') { // what the page should show before anyone is signed in
          const me = who(siteId, req);
          return send(res, 200, { name: site.name, signedIn: Boolean(me), needsSetup: !store.hasOwner(siteId) });
        }
        if (req.method === 'POST' && action === 'setup') {
          if (lockedOut(siteId, req)) return send(res, 429, tooManyTries);
          const b = await readJson(req, 4096);
          const r = store.createOwner(siteId, { token: String(b.token ?? ''), name: b.name, email: b.email, password: b.password });
          if (r.error) { if (r.status === 403) failed(siteId, req); return send(res, r.status ?? 400, { error: r.error }); }
          return send(res, 200, { ok: true, recoveryCode: r.recoveryCode }, 'application/json', { 'Set-Cookie': setCookie(siteId, store.login(siteId, b.email, b.password)) });
        }
        if (req.method === 'POST' && action === 'recover') { // the owner forgot the password: email + recovery code (nobody else can do this for the owner)
          if (lockedOut(siteId, req)) return send(res, 429, tooManyTries);
          const b = await readJson(req, 2048);
          const r = store.recoverOwner(siteId, b.email, b.code, b.password);
          if (r.error) { if (r.status === 403) failed(siteId, req); return send(res, r.status ?? 400, { error: r.error }); }
          return send(res, 200, { ok: true, recoveryCode: r.recoveryCode }, 'application/json', { 'Set-Cookie': setCookie(siteId, r.token) });
        }
        if (req.method === 'POST' && action === 'login') {
          if (lockedOut(siteId, req)) return send(res, 429, tooManyTries);
          const b = await readJson(req, 2048);
          const token = store.login(siteId, b.email, b.password);
          if (!token) { failed(siteId, req); return send(res, 401, { error: 'The email or password is not right.' }); }
          return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': setCookie(siteId, token) });
        }
        if (req.method === 'POST' && action === 'reset') {
          if (lockedOut(siteId, req)) return send(res, 429, tooManyTries);
          const b = await readJson(req, 2048);
          const r = store.useReset(siteId, String(b.token ?? ''), b.password);
          if (r.error) { if (r.status === 403) failed(siteId, req); return send(res, r.status ?? 400, { error: r.error }); }
          return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': setCookie(siteId, r.token) });
        }
        if (req.method === 'POST' && action === 'logout') {
          store.logout(cookies(req)[cookieName(siteId)]);
          return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': clearCookie(siteId) });
        }

        // ---- signed in ----
        const me = who(siteId, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (req.method === 'GET' && action === 'me') return send(res, 200, { user: me, site: { name: site.name, mode: site.mode, fmt: site.fmt, ordering: site.catalog.length > 0 || Boolean(site.schedule), assistant: Boolean(store.getAssistant()), editable: Boolean(editor) } });
        if (req.method === 'GET' && action === 'orders') return send(res, 200, { site: { name: site.name, mode: site.mode, fmt: site.fmt }, orders: store.listOrders(siteId), now: new Date().toISOString() });
        if (req.method === 'POST' && action === 'orders' && parts[4]) {
          const order = store.setStatus(siteId, parts[4], String((await readJson(req, 2048)).status ?? ''), me.name);
          return order ? send(res, 200, { order }) : send(res, 400, { error: 'That change is not possible.' });
        }
        if (req.method === 'POST' && action === 'recovery-code') { // a new code for the signed-in owner
          if (me.role !== 'owner') return send(res, 403, { error: 'Only the owner can do this.' });
          const r = store.renewRecoveryCode(me.id, (await readJson(req, 2048)).password);
          return r.error ? send(res, 400, { error: r.error }) : send(res, 200, { recoveryCode: r.recoveryCode });
        }
        if (req.method === 'POST' && action === 'password') {
          const b = await readJson(req, 2048);
          const r = store.changePassword(me.id, b.old, b.password);
          return r.error ? send(res, 400, { error: r.error }) : send(res, 200, { ok: true });
        }

        // ---- alerts on this phone: any signed-in person of the business can turn them on for their own device ----
        if (action === 'push') {
          if (req.method === 'GET') return send(res, 200, { key: pusher.publicKey() });
          if (req.method === 'POST' && !parts[4]) {
            const sub = cleanSubscription((await readJson(req, 4096)).subscription);
            if (!sub) return send(res, 400, { error: 'This device could not be registered for alerts.' });
            store.addPush(me.id, sub); return send(res, 200, { ok: true });
          }
          if (req.method === 'POST' && parts[4] === 'remove') { const e = String((await readJson(req, 2048)).endpoint ?? ''); if (store.hasPush(me.id, e)) store.removePush(e); return send(res, 200, { ok: true }); }
          if (req.method === 'POST' && parts[4] === 'test') {
            if (tooMany('alert', siteId, req)) return send(res, 429, { error: 'That is a lot of test alerts for one hour. Please wait a little.' });
            return send(res, 200, { result: await pusher.send(siteId, { title: 'Test alert', body: `${site.name}: your alerts work.`, tag: 'test' }) });
          }
        }
        // ---- the owner's alerts: where a new order or appointment request is announced ----
        if (action === 'alerts') {
          if (me.role !== 'owner') return send(res, 403, { error: 'Only the owner can do this.' });
          const view = () => ({ ...store.getAlerts(siteId), emails: store.ownersOf(siteId).map((u) => u.email), available: notifier.available() });
          if (req.method === 'GET') return send(res, 200, view());
          if (req.method === 'POST' && parts[4] === 'test') {
            if (tooMany('alert', siteId, req)) return send(res, 429, { error: 'That is a lot of test alerts for one hour. Please wait a little.' });
            return send(res, 200, { result: await notifier.send({ site, settings: store.getAlerts(siteId), owners: store.ownersOf(siteId), test: true }) });
          }
          if (req.method === 'POST') { const b = await readJson(req, 2048); store.setAlerts(siteId, { whatsapp: b.whatsapp, whatsappOn: b.whatsappOn, emailOn: b.emailOn }); return send(res, 200, view()); }
        }
        // ---- the owner's assistant: what it knows and the rules it follows (the facts come from the website's build and are not edited here) ----
        if (action === 'assistant') {
          if (me.role !== 'owner') return send(res, 403, { error: 'Only the owner can do this.' });
          const a = store.getAssistant();
          if (!a) return send(res, 404, { error: 'This website has no assistant.' });
          const out = (r) => (r.error ? send(res, r.status ?? 400, { error: r.error }) : send(res, 200, r));
          const sub = parts[4]; const id = parts[5];
          if (!sub) {
            if (req.method === 'GET') return send(res, 200, coach.view(a));
            if (req.method === 'POST') { // what it knows, the owner's rules, on/off (the facts come from the website's build and are not edited here)
              const b = await readJson(req, 160 * 1024);
              return send(res, 200, coach.view(store.patchAssistant({ enabled: b.enabled, knowledge: b.knowledge, ownerRules: b.ownerRules })));
            }
          }
          if (req.method === 'POST' && sub === 'coach' && !id) { // "this answer is not right": a proposed change, shown before it is used
            if (tooMany('coach', siteId, req)) return send(res, 429, { error: 'That is a lot of tries for one hour. Please wait a little.' });
            const b = await readJson(req, 8 * 1024);
            return out(await coach.suggest({ question: b.question, feedback: b.feedback }));
          }
          if (req.method === 'POST' && sub === 'feedback' && !id) { // the owner's comment under an answer of the assistant: handled behind the scenes
            if (tooMany('coach', siteId, req)) return send(res, 429, { error: 'That is a lot of tries for one hour. Please wait a little.' });
            const b = await readJson(req, 8 * 1024);
            return send(res, 200, await coach.feedback({ question: b.question, comment: b.comment }));
          }
          if (req.method === 'POST' && sub === 'feedback' && id === 'undo') return send(res, 200, coach.undoLast());
          if (req.method === 'POST' && sub === 'coach' && id === 'apply') { const b = await readJson(req, 2048); return out(coach.apply({ id: b.id })); }
          if (req.method === 'POST' && sub === 'adjustments' && parts[6] === 'remove') return out(coach.removeAdjustment(id));
          if (req.method === 'POST' && sub === 'tests' && !id) { const b = await readJson(req, 4096); return out(coach.addTest({ q: b.q, category: b.category })); }
          if (req.method === 'POST' && sub === 'tests' && id === 'run') {
            if (tooMany('coach', siteId, req)) return send(res, 429, { error: 'That is a lot of tries for one hour. Please wait a little.' });
            return out(await coach.runTests());
          }
          if (req.method === 'POST' && sub === 'tests' && parts[6] === 'remove') return out(coach.removeTest(id));
        }

        // ---- the owner edits the website: text, pictures, undo, back to the original (the built website itself is never changed) ----
        if (action === 'edit' && editor) {
          if (me.role !== 'owner') return send(res, 403, { error: 'Only the owner can do this.' });
          const sub = parts[4];
          if (req.method !== 'GET' && tooMany('edit', siteId, req)) return send(res, 429, { error: 'That is a lot of changes for one hour. Please wait a little.' });
          try {
            if (req.method === 'GET' && sub === 'state') return send(res, 200, editor.state());
            if (req.method === 'POST' && sub === 'text') { const b = await readJson(req, 4096); return send(res, 200, editor.text(String(b.key ?? ''), b.value)); }
            if (req.method === 'PUT' && sub === 'image') return send(res, 200, await editor.image(String(url.searchParams.get('key') ?? ''), { bytes: await readRaw(req, 6 * 1024 * 1024), alt: url.searchParams.get('alt') }));
            if (req.method === 'POST' && sub === 'undo') { const b = await readJson(req, 2048); return send(res, 200, editor.undo(String(b.key ?? ''))); }
            if (req.method === 'POST' && sub === 'revert-all') return send(res, 200, editor.revertAll());
          } catch (err) { if (err.status) return send(res, err.status, { error: err.message }); throw err; }
        }

        // ---- the owner manages the staff ----
        if (action === 'staff') {
          if (me.role !== 'owner') return send(res, 403, { error: 'Only the owner can do this.' });
          if (req.method === 'GET' && !parts[4]) return send(res, 200, { users: store.listUsers(siteId) });
          if (req.method === 'POST' && !parts[4]) {
            const b = await readJson(req, 2048);
            const r = store.addStaff(siteId, { name: b.name, email: b.email, password: b.password });
            return r.error ? send(res, 400, { error: r.error }) : send(res, 200, { user: r.user });
          }
          if (req.method === 'POST' && parts[4] && parts[5] === 'reset') { // a link for someone who forgot the password
            const r = store.createReset(siteId, Number(parts[4]));
            return r ? send(res, 200, { path: `/panel/${siteId}#reset=${r.token}`, user: r.user }) : send(res, 404, { error: 'We could not find that person.' });
          }
          if (req.method === 'POST' && parts[4] && parts[5] === 'remove') {
            const r = store.removeUser(siteId, Number(parts[4]));
            return r.error ? send(res, 400, { error: r.error }) : send(res, 200, { ok: true });
          }
        }
      }
      if (single && dist && (req.method === 'GET' || req.method === 'HEAD') && !parts.includes('api')) return serveStatic(req, res, url);
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      return send(res, err.status ?? (err instanceof SyntaxError ? 400 : 500), { error: err.status ? err.message : 'Something went wrong. Please try again.' }, 'application/json', cors);
    }
  };
  // the finished website, from the same address as the panel
  function serveStatic(req, res, url) {
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
    if (editor && rel.startsWith('/images/edit-')) { // a picture the owner uploaded
      const f = editor.imageFile(path.basename(rel));
      if (f) { res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); return req.method === 'HEAD' ? res.end() : fs.createReadStream(f).pipe(res); }
    }
    let file = path.resolve(dist, '.' + rel);
    if (file !== path.resolve(dist) && !file.startsWith(path.resolve(dist) + path.sep)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (editor && type.startsWith('text/html')) { // the page: the built website with the owner's changes on top; the owner can also see the base copy and open the editing mode
      const owner = who(single, req)?.role === 'owner';
      const wantsEdit = url.searchParams.get('edit') === '1';
      if (wantsEdit && !owner) { res.writeHead(302, { Location: '/panel', 'Cache-Control': 'no-store' }); return res.end(); }
      let html = editor.apply(fs.readFileSync(file, 'utf8'), { original: owner && url.searchParams.get('original') === '1' });
      if (owner && wantsEdit) html = html.replace(/<\/body>/i, () => `<style>.c-bubble,.c-panel,.o-bar,.o-overlay{display:none!important}</style><script src="/edit-overlay.js" data-api="/api/panel/${single}/edit/" data-prefix="/" data-owner="1" data-done="/panel"></script></body>`);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
  const server = http.createServer(handle);
  return { server, store, handle };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createOrdersServer();
  server.listen(PORT, process.env.ORDERS_HOST || '127.0.0.1', () => console.log(`[orders] Order service running at http://localhost:${PORT} (data in ${ordersDir()})`));
}
