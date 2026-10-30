// The order service's storage: one SQLite database file (Node's built-in node:sqlite, nothing to install).
//   <dir>/orders.db
//   sites      what a site sells (name, price), how it is served, and the one-time setup token for its first owner
//   users      the people who work the panel of a site: an owner (can manage staff) and staff (handle orders)
//   sessions   signed-in browsers (only a hash of the cookie is kept)
//   resets     one-time password reset links (only a hash is kept)
//   orders     the orders and appointment requests received
// Passwords are never stored: only a salted scrypt hash. The prices of an order are never taken from the visitor: the total is
// calculated here from the site's own price list.
// Databases made by the first version of the service (JSON files in sites/ and orders/) are imported the first time this runs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { availability, addDays, isDay, nowIn } from './schedule.js';

export const SITE_ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
export const ORDER_STATUSES = ['new', 'accepted', 'ready', 'done', 'cancelled'];
export const BOOKING_STATUSES = ['new', 'confirmed', 'declined', 'done'];
export const FULFIL = ['delivery', 'pickup', 'dinein'];
export const MIN_PASSWORD = 8;
const SESSION_DAYS = 30; const RESET_HOURS = 24;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newToken = () => crypto.randomBytes(24).toString('hex'); // letters and digits only: a link with "-" or "_" at its end loses it when copied from chat or an email
export const newKey = newToken; // the setup token of a new site (kept under its old name)
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const money = (n) => Math.round(n * 100) / 100;
const normEmail = (s) => clean(s, 200).toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const sameToken = (hash, token) => { if (!hash || !token) return false; const a = Buffer.from(sha(token)); const b = Buffer.from(hash); return a.length === b.length && crypto.timingSafeEqual(a, b); };

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'orders.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL, catalog TEXT NOT NULL, fulfil TEXT NOT NULL,
      delivery_fee REAL NOT NULL DEFAULT 0, fmt TEXT NOT NULL DEFAULT '#', setup_hash TEXT, registered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','staff')),
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (site_id, email)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resets (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_edits (
      key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant (
      id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, keys TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_usage (
      month TEXT PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, n INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT, PRIMARY KEY (site_id, n)
    );
  `);
  try { db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT'); } catch { /* already there */ }
  for (const col of ['schedule TEXT', 'tz TEXT', 'slot_minutes INTEGER', 'alerts TEXT']) { try { db.exec(`ALTER TABLE sites ADD COLUMN ${col}`); } catch { /* already there */ } }
  const q = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const plusHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

  const siteRow = (id) => (SITE_ID.test(id ?? '') ? q('SELECT * FROM sites WHERE id = ?').get(id) : undefined);
  const asSite = (r) => r && { id: r.id, name: r.name, mode: r.mode, catalog: JSON.parse(r.catalog), fulfil: JSON.parse(r.fulfil), deliveryFee: r.delivery_fee, fmt: r.fmt, schedule: r.schedule ? JSON.parse(r.schedule) : null, tz: r.tz || 'UTC', slotMinutes: r.slot_minutes || 60, setupOpen: Boolean(r.setup_hash), registeredAt: r.registered_at };
  const getSite = (id) => asSite(siteRow(id)) ?? null;
  const hasOwner = (id) => Boolean(q("SELECT 1 FROM users WHERE site_id = ? AND role = 'owner' LIMIT 1").get(id));

  // Opening hours for appointments: schedule { mon: [['09:00','17:00']] }, slotMinutes (the length of one appointment), tz (the business's time zone).
  function saveSchedule(site) {
    const slot = Math.min(480, Math.max(10, Math.round(Number(site.slotMinutes) || 60)));
    q('UPDATE sites SET schedule = ?, tz = ?, slot_minutes = ? WHERE id = ?').run(site.schedule ? JSON.stringify(site.schedule) : null, clean(site.tz, 60) || 'UTC', slot, site.id);
  }

  // site: { id, name, setupToken?, catalog: [{ name, price }], mode: 'order' | 'book', fulfil: [], deliveryFee, fmt }.
  // A site that has no owner yet keeps a one-time setup token: whoever opens the setup link first creates the owner account.
  function registerSite(site) {
    if (!SITE_ID.test(site.id)) throw new Error('The site id is not valid.');
    const old = siteRow(site.id);
    const catalog = JSON.stringify((site.catalog ?? []).map((c) => ({ name: clean(c.name, 200), price: Number(c.price) || 0 })).filter((c) => c.name));
    const fulfil = JSON.stringify((site.fulfil ?? []).filter((f) => FULFIL.includes(f)));
    const setup = site.setupToken ?? site.key; // "key": the name the first version used
    if (old) {
      q('UPDATE sites SET name = ?, mode = ?, catalog = ?, fulfil = ?, delivery_fee = ?, fmt = ? WHERE id = ?')
        .run(clean(site.name, 120), site.mode === 'book' ? 'book' : 'order', catalog, fulfil, Math.max(0, Number(site.deliveryFee) || 0), clean(site.fmt, 20) || '#', site.id);
      saveSchedule(site);
      if (site.whatsapp && !getAlerts(site.id).whatsapp) setAlerts(site.id, { whatsapp: site.whatsapp, whatsappOn: true });
      if (setup && !hasOwner(site.id)) q('UPDATE sites SET setup_hash = ? WHERE id = ?').run(sha(setup), site.id);
      return { created: false };
    }
    if (!setup) throw new Error('A new site needs a setup token.');
    q('INSERT INTO sites (id, name, mode, catalog, fulfil, delivery_fee, fmt, setup_hash, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(site.id, clean(site.name, 120), site.mode === 'book' ? 'book' : 'order', catalog, fulfil, Math.max(0, Number(site.deliveryFee) || 0), clean(site.fmt, 20) || '#', sha(setup), now());
    saveSchedule(site);
    if (site.whatsapp) setAlerts(site.id, { whatsapp: site.whatsapp, whatsappOn: true });
    return { created: true };
  }

  // ---- alerts to the owner (where a new order or appointment request is announced): { whatsapp, whatsappOn, emailOn } ----
  const getAlerts = (id) => { let a = {}; try { a = JSON.parse(siteRow(id)?.alerts ?? '{}') || {}; } catch { a = {}; } return { whatsapp: String(a.whatsapp ?? ''), whatsappOn: a.whatsappOn === true, emailOn: a.emailOn !== false }; };
  function setAlerts(id, patch) {
    if (!siteRow(id)) return null;
    const a = getAlerts(id);
    if (typeof patch.whatsapp === 'string') a.whatsapp = patch.whatsapp.replace(/[^\d+]/g, '').slice(0, 20);
    if (typeof patch.whatsappOn === 'boolean') a.whatsappOn = patch.whatsappOn;
    if (typeof patch.emailOn === 'boolean') a.emailOn = patch.emailOn;
    q('UPDATE sites SET alerts = ? WHERE id = ?').run(JSON.stringify(a), id);
    return a;
  }

  // ---- the business's own settings, and the devices that get its alerts ----
  const getSetting = (key) => q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  const setSetting = (key, value) => { q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); };
  function addPush(userId, sub) { // a user keeps at most 5 devices; the newest replace the oldest
    q('INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys').run(sub.endpoint, userId, JSON.stringify(sub.keys), now());
    q('DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)').run(userId, userId);
  }
  const removePush = (endpoint) => { q('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint); };
  const listPush = (siteId) => q('SELECT p.endpoint, p.keys FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.site_id = ?').all(siteId).map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }));
  const hasPush = (userId, endpoint) => Boolean(q('SELECT 1 FROM push_subs WHERE user_id = ? AND endpoint = ?').get(userId, endpoint));

  // ---- accounts ----
  const asUser = (r) => r && { id: r.id, siteId: r.site_id, email: r.email, name: r.name, role: r.role };
  function checkNewAccount({ name, email, password }) {
    if (!clean(name, 80)) return 'Please give a name.';
    if (!EMAIL.test(normEmail(email))) return 'Please give a valid email address.';
    if (String(password ?? '').length < MIN_PASSWORD) return `The password needs at least ${MIN_PASSWORD} characters.`;
    return '';
  }
  function addUser(siteId, role, { name, email, password }) {
    const problem = checkNewAccount({ name, email, password });
    if (problem) return { error: problem };
    if (q('SELECT 1 FROM users WHERE site_id = ? AND email = ?').get(siteId, normEmail(email))) return { error: 'That email already has an account.' };
    const r = q('INSERT INTO users (site_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(siteId, normEmail(email), clean(name, 80), role, hashPassword(password), now());
    return { user: asUser(q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) };
  }
  // The first owner, with the one-time setup token from the setup link. The token stops working once it is used.
  function createOwner(siteId, { token, name, email, password }) {
    const site = siteRow(siteId);
    if (!site) return { error: 'This page does not exist.', status: 404 };
    if (!site.setup_hash) return { error: 'The owner account was already created. Please sign in instead.', status: 403 };
    if (!sameToken(site.setup_hash, token)) return { error: 'This setup link is incomplete or not right. Please copy the whole link again, all the way to its last character.', status: 403 };
    const made = addUser(siteId, 'owner', { name, email, password });
    if (made.error) return made;
    q('UPDATE sites SET setup_hash = NULL WHERE id = ?').run(siteId);
    return { ...made, recoveryCode: newRecoveryCode(made.user.id) };
  }
  // The owner's own way back in when the password is forgotten. It is shown once, only its hash is kept, and nobody else (not the team that
  // built the website, not whoever hosts it) has a way to sign in as the owner: this is the restaurant's business, not theirs.
  const normCode = (c) => String(c ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  function newRecoveryCode(userId) {
    const code = crypto.randomBytes(10).toString('hex'); // 20 characters
    q('UPDATE users SET recovery_hash = ? WHERE id = ?').run(sha(code), userId);
    return code.match(/.{4}/g).join('-');
  }
  // Returns { token, recoveryCode } (a session, and a NEW code: each code works once) or { error }.
  function recoverOwner(siteId, email, code, password) {
    if (String(password ?? '').length < MIN_PASSWORD) return { error: `The new password needs at least ${MIN_PASSWORD} characters.` };
    const u = q("SELECT * FROM users WHERE site_id = ? AND email = ? AND role = 'owner'").get(siteId, normEmail(email));
    // the same work is done when the email is unknown, so the answer takes the same time
    const ok = Boolean(u?.recovery_hash) && sameToken(u.recovery_hash, normCode(code));
    if (!u || !ok) return { error: 'The email or the recovery code is not right.', status: 403 };
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    q('DELETE FROM resets WHERE user_id = ?').run(u.id);
    return { token: startSession(u.id), recoveryCode: newRecoveryCode(u.id) };
  }
  // A new recovery code for the signed-in owner (the old one stops working). The password is asked again.
  function renewRecoveryCode(userId, password) {
    const u = q("SELECT * FROM users WHERE id = ? AND role = 'owner'").get(userId);
    if (!u || !checkPassword(password, u.password_hash)) return { error: 'The password is not right.' };
    return { recoveryCode: newRecoveryCode(u.id) };
  }
  const addStaff = (siteId, details) => addUser(siteId, 'staff', details);
  const listUsers = (siteId) => q('SELECT * FROM users WHERE site_id = ? ORDER BY role = \'owner\' DESC, id').all(siteId).map(asUser);
  function removeUser(siteId, userId) {
    const u = q('SELECT * FROM users WHERE id = ? AND site_id = ?').get(userId, siteId);
    if (!u) return { error: 'We could not find that person.' };
    if (u.role === 'owner') return { error: 'The owner cannot be removed.' };
    q('DELETE FROM users WHERE id = ?').run(u.id);
    return { ok: true };
  }
  function login(siteId, email, password) {
    const u = q('SELECT * FROM users WHERE site_id = ? AND email = ?').get(siteId, normEmail(email));
    // a password check is done even when the email is unknown, so the answer takes the same time
    const ok = checkPassword(password, u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) return null;
    return startSession(u.id);
  }
  function startSession(userId) {
    const token = newToken();
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, plusHours(SESSION_DAYS * 24));
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    return token;
  }
  function sessionUser(siteId, token) {
    if (!token) return null;
    const r = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.site_id = ?').get(sha(token), now(), siteId);
    return asUser(r) ?? null;
  }
  const logout = (token) => { if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); };
  function changePassword(userId, oldPassword, newPassword) {
    const u = q('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !checkPassword(oldPassword, u.password_hash)) return { error: 'The current password is not right.' };
    if (String(newPassword ?? '').length < MIN_PASSWORD) return { error: `The new password needs at least ${MIN_PASSWORD} characters.` };
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
    return { ok: true };
  }
  // A reset link for someone who forgot the password (the owner makes it for staff; the team makes it for an owner). Valid 24 hours, once.
  function createReset(siteId, userId) {
    const u = q('SELECT * FROM users WHERE id = ? AND site_id = ?').get(userId, siteId);
    if (!u) return null;
    const token = newToken();
    q('DELETE FROM resets WHERE user_id = ?').run(u.id);
    q('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), u.id, plusHours(RESET_HOURS));
    return { token, user: asUser(u) };
  }
  function useReset(siteId, token, password) {
    if (String(password ?? '').length < MIN_PASSWORD) return { error: `The new password needs at least ${MIN_PASSWORD} characters.` };
    const r = q('SELECT r.user_id FROM resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ? AND u.site_id = ?').get(sha(token ?? ''), now(), siteId);
    if (!r) return { error: 'This link is not valid any more. Ask for a new one.', status: 403 };
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), r.user_id);
    q('DELETE FROM resets WHERE user_id = ?').run(r.user_id);
    q('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // anyone signed in with the old password is signed out
    return { token: startSession(r.user_id) };
  }
  const ownersOf = (siteId) => listUsers(siteId).filter((u) => u.role === 'owner');

  // ---- orders ----
  const asOrder = (r) => ({ id: r.n, at: r.at, status: r.status, ...JSON.parse(r.data), ...(r.updated_at ? { updatedAt: r.updated_at, updatedBy: r.updated_by } : {}) });
  // A visitor's order. Returns { order } or { error } (a message that is safe to show).
  function createOrder(id, body) {
    const site = getSite(id);
    if (!site) return { error: 'This website does not take orders.', status: 404 };
    const name = clean(body?.name, 80); const phone = clean(body?.phone, 30); const notes = clean(body?.notes, 500);
    if (!name) return { error: 'Please give your name.' };
    if (phone.replace(/\D/g, '').length < 6) return { error: 'Please give a phone number we can reach.' };
    let record;
    if (site.mode === 'book') {
      const service = clean(body?.service, 200);
      if (site.catalog.length && !site.catalog.some((c) => c.name === service)) return { error: 'Please choose one of the services.' };
      const day = clean(body?.day, 10); const time = clean(body?.time, 5);
      if (!isDay(day)) return { error: 'Please choose a day.' };
      if (!/^\d{2}:\d{2}$/.test(time)) return { error: 'Please choose a time.' };
      if (site.schedule) { // a real calendar: only a free slot inside the opening hours can be taken (checked here, so two people can never take the same one)
        const a = availabilityOf(site, day);
        const slot = a.slots.find((s) => s.time === time);
        if (!slot) return { error: a.open ? 'Please choose one of the times shown.' : 'We do not take appointments that day.' };
        if (slot.past) return { error: 'That time has already passed. Please choose another.' };
        if (!slot.free) return { error: 'Sorry, that time was just taken. Please choose another.', status: 409 };
        record = { kind: 'book', service, day, time, minutes: site.slotMinutes, name, phone, notes };
      } else {
        if (day < new Date(Date.now() - 86400000).toISOString().slice(0, 10)) return { error: 'That day has passed.' };
        record = { kind: 'book', service, day, time, name, phone, notes };
      }
    } else {
      const type = clean(body?.type, 10);
      if (!site.fulfil.includes(type)) return { error: 'Please choose how you want to get your order.' };
      const address = clean(body?.address, 300);
      if (type === 'delivery' && !address) return { error: 'Please give the delivery address.' };
      const lines = Array.isArray(body?.items) ? body.items.slice(0, 60) : [];
      if (!lines.length) return { error: 'Your order is empty.' };
      const items = [];
      for (const l of lines) {
        const entry = site.catalog.find((c) => c.name === clean(l?.name, 200));
        const qty = Math.floor(Number(l?.qty));
        if (!entry || entry.price <= 0) return { error: 'One of the items is not on the menu any more.' };
        if (!(qty >= 1 && qty <= 50)) return { error: 'Please check the quantities.' };
        const same = items.find((i) => i.name === entry.name);
        if (same) same.qty += qty; else items.push({ name: entry.name, qty, price: entry.price });
      }
      if (items.some((i) => i.qty > 50)) return { error: 'Please check the quantities.' };
      const subtotal = money(items.reduce((s, i) => s + i.qty * i.price, 0));
      const fee = type === 'delivery' ? site.deliveryFee : 0;
      record = { kind: 'order', type, items, subtotal, fee, total: money(subtotal + fee), name, phone, address, notes, payment: 'cash' };
    }
    const n = (q('SELECT MAX(n) AS m FROM orders WHERE site_id = ?').get(id).m ?? 0) + 1;
    const { kind, ...data } = record;
    q('INSERT INTO orders (site_id, n, at, kind, status, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, n, now(), kind, 'new', JSON.stringify({ kind, ...data }));
    return { order: asOrder(q('SELECT * FROM orders WHERE site_id = ? AND n = ?').get(id, n)) };
  }
  // ---- the owner's edits of the website (text and pictures). The built website is never touched: these are a layer applied when a page is shown ----
  const editItems = () => Object.fromEntries(q('SELECT key, data FROM site_edits').all().map((r) => [r.key, JSON.parse(r.data)]));
  function saveEditItem(key, item) { q('INSERT INTO site_edits (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(key, JSON.stringify(item), now()); }

  // ---- the website assistant ----
  // One row per business: { enabled, persona, facts, knowledge, ownerRules, handoff, language, monthlyBudgetUsd }. The facts come from the
  // owner's form (made by the build); the knowledge and the owner's rules are the owner's to edit in the panel. No chat is ever stored:
  // only a count of messages and what they cost this month.
  const getAssistant = () => { const r = q('SELECT config FROM assistant WHERE id = 1').get(); return r ? JSON.parse(r.config) : null; };
  function saveAssistant(config) { q('INSERT INTO assistant (id, config, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at').run(JSON.stringify(config), now()); }
  // What the owner may change: on/off, the knowledge text and their rules (not the facts and not the persona).
  function patchAssistant({ enabled, knowledge, ownerRules }) {
    const a = getAssistant();
    if (!a) return null;
    if (typeof enabled === 'boolean') a.enabled = enabled;
    if (typeof knowledge === 'string') a.knowledge = knowledge.replace(/\u0000/g, '').slice(0, 120000);
    if (typeof ownerRules === 'string') a.ownerRules = ownerRules.replace(/\u0000/g, '').slice(0, 3000);
    saveAssistant(a);
    return a;
  }
  const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
  const chatUsage = (month = monthOf()) => { const r = q('SELECT messages, usd FROM chat_usage WHERE month = ?').get(month); return { month, messages: r?.messages ?? 0, usd: r?.usd ?? 0 }; };
  function addChatUsage(usd, month = monthOf(), question = true) { // question: false for the owner's own tests and coaching: the cost counts, the question count does not
    const n = question ? 1 : 0;
    q('INSERT INTO chat_usage (month, messages, usd) VALUES (?, ?, ?) ON CONFLICT(month) DO UPDATE SET messages = messages + excluded.messages, usd = usd + excluded.usd').run(month, n, Number(usd) || 0);
  }

  // ---- the calendar ----
  // The start times already taken on a day: appointments that are waiting, confirmed or done (a declined one gives its slot back).
  const bookedOn = (id, day) => q("SELECT json_extract(data, '$.time') AS time FROM orders WHERE site_id = ? AND kind = 'book' AND status IN ('new', 'confirmed', 'done') AND json_extract(data, '$.day') = ?").all(id, day).map((r) => r.time);
  const availabilityOf = (site, day) => availability({ schedule: site.schedule, slot: site.slotMinutes, tz: site.tz }, day, bookedOn(site.id, day));
  // One day: { open, slots: [{ time, free }] }; or the next days: what the website shows (booked times faded and not tappable).
  function availabilityFor(id, day) {
    const site = getSite(id);
    if (!site?.schedule || !isDay(day)) return null;
    return availabilityOf(site, day);
  }
  function calendarFor(id, from, days = 14) {
    const site = getSite(id);
    if (!site?.schedule) return null;
    const today = nowIn(site.tz).day;
    const start = isDay(from) && from >= today ? from : today;
    return { slotMinutes: site.slotMinutes, days: Array.from({ length: Math.min(60, Math.max(1, days)) }, (_, i) => { const d = addDays(start, i); const a = availabilityOf(site, d); return { day: d, open: a.open, free: a.slots.filter((s) => s.free).length, total: a.slots.length }; }) };
  }

  const listOrders = (id, limit = 2000) => q('SELECT * FROM orders WHERE site_id = ? ORDER BY n DESC LIMIT ?').all(id, limit).map(asOrder);
  function setStatus(id, orderId, status, by = '') {
    const r = q('SELECT * FROM orders WHERE site_id = ? AND n = ?').get(id, Number(orderId));
    if (!r) return null;
    if (!(r.kind === 'book' ? BOOKING_STATUSES : ORDER_STATUSES).includes(status)) return null;
    q('UPDATE orders SET status = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND n = ?').run(status, now(), clean(by, 80), id, r.n);
    return asOrder(q('SELECT * FROM orders WHERE site_id = ? AND n = ?').get(id, r.n));
  }

  // ---- import of the first version's JSON files ----
  function importLegacy() {
    const sitesDir = path.join(dir, 'sites'); const ordersDir = path.join(dir, 'orders');
    if (!fs.existsSync(sitesDir) || q('SELECT COUNT(*) AS c FROM sites').get().c > 0) return 0;
    let count = 0;
    for (const f of fs.readdirSync(sitesDir).filter((x) => x.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sitesDir, f), 'utf8'));
        if (!SITE_ID.test(s.id) || !s.keyHash) continue;
        q('INSERT INTO sites (id, name, mode, catalog, fulfil, delivery_fee, fmt, setup_hash, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(s.id, s.name, s.mode === 'book' ? 'book' : 'order', JSON.stringify(s.catalog ?? []), JSON.stringify(s.fulfil ?? []), Number(s.deliveryFee) || 0, s.fmt || '#', s.keyHash, s.registeredAt || now()); // the old key keeps working as the setup token
        const file = path.join(ordersDir, f);
        const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { orders: [] };
        for (const o of data.orders ?? []) {
          const { id: n, at, status, updatedAt, ...rest } = o;
          q('INSERT OR IGNORE INTO orders (site_id, n, at, kind, status, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.id, n, at, rest.kind ?? 'order', status ?? 'new', JSON.stringify(rest), updatedAt ?? null);
        }
        count++;
      } catch { /* a damaged old file is skipped */ }
    }
    return count;
  }
  importLegacy();

  // The orders of one site from a shared database made while developing (many sites in one file): they move to this business's own database.
  function importSiteFrom(otherDir, siteId) {
    const file = path.join(otherDir, 'orders.db');
    if (!fs.existsSync(file) || path.resolve(otherDir) === path.resolve(dir)) return 0;
    const other = new DatabaseSync(file, { readOnly: true });
    try {
      const s = other.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
      if (!s) return 0;
      if (!siteRow(siteId)) q('INSERT INTO sites (id, name, mode, catalog, fulfil, delivery_fee, fmt, setup_hash, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, s.name, s.mode, s.catalog, s.fulfil, s.delivery_fee, s.fmt, null, s.registered_at);
      let n = 0;
      for (const o of other.prepare('SELECT * FROM orders WHERE site_id = ?').all(siteId)) {
        q('INSERT OR IGNORE INTO orders (site_id, n, at, kind, status, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(o.site_id, o.n, o.at, o.kind, o.status, o.data, o.updated_at, o.updated_by); n++;
      }
      return n;
    } catch { return 0; } finally { other.close(); }
  }

  return {
    registerSite, getSite, hasOwner, getAlerts, setAlerts, getSetting, setSetting, addPush, removePush, listPush, hasPush,
    createOwner, recoverOwner, renewRecoveryCode, addStaff, listUsers, removeUser, login, sessionUser, logout, changePassword, createReset, useReset, ownersOf,
    editItems, saveEditItem, getAssistant, saveAssistant, patchAssistant, chatUsage, addChatUsage,
    createOrder, availabilityFor, calendarFor, listOrders, setStatus, importSiteFrom, close: () => db.close(),
  };
}
