// Invisible protection for the customer page. A customer just opens the page: no account, no sign-in, nothing to type.
// Behind the scenes:
//   - one device cannot start a flood of projects, trigger a flood of paid actions (design runs, retries, AI pictures), or hammer the server
//   - a daily spending cap on the paid AI calls: when the day's cost (from every project's cost log) reaches the cap, new paid work is
//     paused with a friendly message until tomorrow (UTC), and the team is not surprised by the bill
// Settings (.env): DAILY_BUDGET_USD (default 30), GUARD=off (tests, local work), GUARD_LOCAL=1 (also limit this computer), TRUST_PROXY=1
// (behind a proxy the visitor's real address is read from X-Forwarded-For).

import fs from 'node:fs';
import { projectPath } from '../lib/project.js';

const HOUR = 60 * 60 * 1000;
export const LIMITS = {
  any: { max: 400, windowMs: 60 * 1000 },   // every request
  start: { max: 12, windowMs: HOUR },       // new projects
  paid: { max: 40, windowMs: HOUR },        // actions that start AI work
  list: { max: 20, windowMs: HOUR },        // reading a price list with AI
};

// What the paid work of a project costs today: the sum of every cost log entry since midnight UTC.
export function spentToday(now = Date.now()) {
  const since = new Date(now).toISOString().slice(0, 10); // "2026-10-21": entries are ISO strings, so a text comparison works
  const root = projectPath('');
  let total = 0;
  for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = projectPath(id, 'cost-log.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (String(e.at) >= since && Number.isFinite(e.estimatedUsd)) total += e.estimatedUsd; } catch { /* a damaged line is skipped */ }
    }
  }
  return total;
}

export function createGuard({ env = process.env, now = Date.now, spent = spentToday } = {}) {
  const off = env.GUARD === 'off';
  const limitLocal = env.GUARD_LOCAL === '1';
  const budgetUsd = Number(env.DAILY_BUDGET_USD) > 0 ? Number(env.DAILY_BUDGET_USD) : 30;
  const trustProxy = env.TRUST_PROXY === '1';
  const hits = new Map();
  let cached = { at: 0, usd: 0 };

  const addressOf = (req) => (trustProxy && String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket?.remoteAddress || '?';
  const isLocal = (ip) => ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';

  function tooMany(kind, ip) {
    const { max, windowMs } = LIMITS[kind];
    const key = `${kind}|${ip}`; const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return Math.ceil((windowMs - (t - recent[0])) / 1000); }
    hits.set(key, [...recent, t]);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < HOUR)) hits.delete(k);
    return 0;
  }
  function budget() {
    if (now() - cached.at > 30 * 1000) cached = { at: now(), usd: spent(now()) };
    return { spent: cached.usd, limit: budgetUsd, over: cached.usd >= budgetUsd };
  }

  // kinds: 'any' (every request), 'start', 'paid', 'list'. Returns { ok: true } or { ok: false, status, message, retryAfter }.
  function check(req, kinds = ['any']) {
    if (off) return { ok: true };
    const ip = addressOf(req);
    if (isLocal(ip) && !limitLocal) return { ok: true };
    for (const kind of kinds) {
      if (kind === 'paid' || kind === 'list') {
        if (budget().over) return { ok: false, status: 503, message: 'We are very busy today, so we have paused new designs. Please come back tomorrow: your request is safe.', retryAfter: 3600 };
      }
      const wait = tooMany(kind, ip);
      if (wait) return { ok: false, status: 429, message: 'Too many requests from this device. Please wait a little and try again.', retryAfter: wait };
    }
    return { ok: true };
  }
  return { check, budget };
}
