import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, LIMITS } from '../src/server/guard.js';
import { createCustomerServer } from '../src/server/customer.js';

const req = (ip = '203.0.113.5', headers = {}) => ({ headers, socket: { remoteAddress: ip } });
const guardWith = (env = {}, extra = {}) => createGuard({ env: { GUARD_LOCAL: '1', ...env }, ...extra });

test('a device that starts too many projects in an hour is slowed down, another device is not', () => {
  const g = guardWith();
  for (let i = 0; i < LIMITS.start.max; i++) assert.ok(g.check(req(), ['start']).ok);
  const blocked = g.check(req(), ['start']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
  assert.match(blocked.message, /wait a little/);
  assert.ok(g.check(req('198.51.100.7'), ['start']).ok);
});

test('the limit lifts when the hour has passed', () => {
  let t = 1_000_000;
  const g = guardWith({}, { now: () => t });
  for (let i = 0; i < LIMITS.paid.max; i++) g.check(req(), ['paid']);
  assert.equal(g.check(req(), ['paid']).ok, false);
  t += 61 * 60 * 1000;
  assert.ok(g.check(req(), ['paid']).ok);
});

test('when the day\'s spending reaches the cap, paid work is paused with a friendly message, but opening the page still works', () => {
  const g = guardWith({ DAILY_BUDGET_USD: '10' }, { spent: () => 12 });
  const paid = g.check(req(), ['paid']);
  assert.equal(paid.ok, false);
  assert.equal(paid.status, 503);
  assert.match(paid.message, /come back tomorrow/);
  assert.equal(g.check(req(), ['list']).status, 503);
  assert.ok(g.check(req(), ['any']).ok);
  assert.ok(g.check(req(), ['start']).ok);
  assert.ok(guardWith({ DAILY_BUDGET_USD: '10' }, { spent: () => 3 }).check(req(), ['paid']).ok);
});

test('this computer is not limited unless asked, and GUARD=off turns everything off', () => {
  const local = createGuard({ env: { DAILY_BUDGET_USD: '1' }, spent: () => 99 });
  assert.ok(local.check(req('127.0.0.1'), ['paid']).ok);
  assert.ok(local.check(req('::1'), ['paid']).ok);
  assert.equal(local.check(req('203.0.113.5'), ['paid']).ok, false);
  assert.ok(createGuard({ env: { GUARD: 'off' }, spent: () => 99 }).check(req(), ['paid']).ok);
});

test('behind a proxy the visitor\'s own address counts, not the proxy\'s', () => {
  const g = guardWith({ TRUST_PROXY: '1' });
  for (let i = 0; i < LIMITS.start.max; i++) g.check(req('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), ['start']);
  assert.equal(g.check(req('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), ['start']).ok, false);
  assert.ok(g.check(req('10.0.0.1', { 'x-forwarded-for': '203.0.113.10' }), ['start']).ok);
});

test('the customer server refuses paid work over the cap, but still lets people start and read their status', async () => {
  const guard = createGuard({ env: { GUARD_LOCAL: '1', DAILY_BUDGET_USD: '1' }, spent: () => 5 });
  const { server } = createCustomerServer({ guard });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = await fetch(`${base}/api/start`, { method: 'POST' });
    assert.equal(started.status, 201);
    const { id } = await started.json();
    const submit = await fetch(`${base}/api/submit/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(submit.status, 503);
    assert.match((await submit.json()).error, /come back tomorrow/);
    assert.equal((await fetch(`${base}/api/status/${id}`)).status, 200);
    assert.equal((await fetch(`${base}/`)).headers.get('x-content-type-options'), 'nosniff');
  } finally { server.close(); }
});
