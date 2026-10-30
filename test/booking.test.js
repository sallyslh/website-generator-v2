import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availability, slotsOf, scheduleFrom, nowIn, weekdayOf, addDays, isDay } from '../src/server/orders/schedule.js';
import { createOrdersServer } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';

// ---------- the rules (pure) ----------
const week = scheduleFrom({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '12:00' });

test('a schedule is built from the owner\'s days and hours; nonsense gives none', () => {
  assert.deepEqual(Object.keys(week), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(scheduleFrom({ days: [], from: '09:00', to: '17:00' }), null);
  assert.equal(scheduleFrom({ days: ['mon'], from: '17:00', to: '09:00' }), null);
  assert.equal(scheduleFrom({ days: ['mon'], from: 'x', to: '09:00' }), null);
  assert.deepEqual(Object.keys(scheduleFrom({ days: ['MON', 'mon', 'funday'], from: '09:00', to: '10:00' })), ['mon']);
});

test('slots are every appointment length inside the opening hours, and only while the appointment fits', () => {
  assert.deepEqual(slotsOf(week, 60, '2030-01-07'), ['09:00', '10:00', '11:00']); // a Monday
  assert.deepEqual(slotsOf(week, 90, '2030-01-07'), ['09:00', '10:30']);
  assert.deepEqual(slotsOf(week, 60, '2030-01-06'), []); // a Sunday: closed
  assert.equal(weekdayOf('2030-01-07'), 'mon');
  assert.ok(isDay('2030-02-28')); assert.ok(!isDay('2030-02-30')); assert.ok(!isDay('soon'));
  assert.equal(addDays('2030-01-31', 1), '2030-02-01');
});

test('a booked time is not free, and neither is any slot it overlaps; a declined one would give it back', () => {
  const at = new Date('2029-12-01T00:00:00Z');
  const a = availability({ schedule: week, slot: 60, tz: 'UTC' }, '2030-01-07', ['10:00'], at);
  assert.deepEqual(a.slots.map((s) => [s.time, s.free]), [['09:00', true], ['10:00', false], ['11:00', true]]);
  const overlap = availability({ schedule: week, slot: 60, tz: 'UTC' }, '2030-01-07', ['09:30'], at); // a 09:30 appointment blocks 09:00 and 10:00
  assert.deepEqual(overlap.slots.map((s) => s.free), [false, false, true]);
  assert.equal(availability({ schedule: week, slot: 60, tz: 'UTC' }, '2030-01-07', [], at).open, true);
  assert.equal(availability({ schedule: week, slot: 60, tz: 'UTC' }, '2030-01-06', [], at).open, false);
});

test('times that already passed today are not free, judged in the business\'s own time zone', () => {
  // 10:30 UTC on a Monday is 13:30 in Beirut (summer time): the whole morning is over there, but not in UTC
  const at = new Date('2030-07-01T10:30:00Z'); // a Monday
  assert.equal(weekdayOf('2030-07-01'), 'mon');
  const beirut = availability({ schedule: week, slot: 60, tz: 'Asia/Beirut' }, '2030-07-01', [], at);
  assert.deepEqual(beirut.slots.map((s) => s.free), [false, false, false]);
  const utc = availability({ schedule: week, slot: 60, tz: 'UTC' }, '2030-07-01', [], at);
  assert.deepEqual(utc.slots.map((s) => s.free), [false, false, true]); // 10:30 UTC: 09:00 and 10:00 are over, 11:00 is still ahead
});

test('the clock of a time zone', () => {
  assert.deepEqual(nowIn('Asia/Beirut', new Date('2030-07-01T21:30:00Z')), { day: '2030-07-02', minutes: 0 * 60 + 30 }); // past midnight there
  assert.equal(nowIn('Not/AZone', new Date('2030-07-01T10:30:00Z')).day, '2030-07-01'); // an unknown zone falls back to UTC
});

// ---------- the service ----------
let root; let dir; let one; let base; let ownerCookie;
const SETUP = 'booking-setup-token';
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const nextMonday = () => { let d = addDays(new Date().toISOString().slice(0, 10), 7); while (weekdayOf(d) !== 'mon') d = addDays(d, 1); return d; };
const MONDAY = nextMonday();

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-'));
  dir = path.join(root, 'salon');
  const s = createStore(dir);
  s.registerSite({ id: 'salon-cal', name: 'Salon', setupToken: SETUP, mode: 'book', catalog: [{ name: 'Haircut', price: 0 }, { name: 'Facial', price: 0 }], fulfil: [], schedule: scheduleFrom({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '12:00' }), slotMinutes: 60, tz: 'UTC' });
  s.close();
  one = createOrdersServer({ dir, siteId: 'salon-cal', dist: root });
  await new Promise((r) => one.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${one.server.address().port}`;
  const setup = await post('/api/panel/setup', { token: SETUP, name: 'Layla', email: 'layla@example.com', password: 'long enough pass' });
  ownerCookie = setup.headers.get('set-cookie').split(';')[0];
});
after(() => { one.server.close(); one.store.close(); fs.rmSync(root, { recursive: true, force: true }); });

const book = (time, extra = {}) => post('/api/order', { service: 'Haircut', day: MONDAY, time, name: 'Sara', phone: '03 123 456', ...extra });

test('the website can read the calendar: the next days and the times of one day (the same address, no site id)', async () => {
  const cal = await (await fetch(`${base}/api/availability`)).json();
  assert.equal(cal.slotMinutes, 60);
  assert.equal(cal.days.length, 14);
  assert.ok(cal.days.some((d) => d.open) && cal.days.some((d) => !d.open)); // weekends are closed
  const day = await (await fetch(`${base}/api/availability?day=${MONDAY}`)).json();
  assert.deepEqual(day.slots.map((s) => [s.time, s.free]), [['09:00', true], ['10:00', true], ['11:00', true]]);
  assert.equal((await fetch(`${base}/api/availability?day=nonsense`)).status, 404);
});

test('a booked time is no longer free, and booking it again is refused (nobody can take the same time twice)', async () => {
  const first = await book('10:00');
  assert.equal(first.status, 200);
  const again = await book('10:00', { name: 'Someone else', phone: '70 111 222' });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /just taken/);
  const day = await (await fetch(`${base}/api/availability?day=${MONDAY}`)).json();
  assert.deepEqual(day.slots.map((s) => s.free), [true, false, true]);
  const cal = await (await fetch(`${base}/api/availability?from=${MONDAY}&days=1`)).json();
  assert.deepEqual([cal.days[0].free, cal.days[0].total], [2, 3]);
});

test('two people tapping the same time at the same moment: exactly one gets it', async () => {
  const results = await Promise.all([book('11:00', { name: 'A' }), book('11:00', { name: 'B' }), book('11:00', { name: 'C' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
});

test('a closed day, a time off the grid and a missing service are refused with a clear message', async () => {
  const sunday = addDays(MONDAY, -1);
  const closed = await post('/api/order', { service: 'Haircut', day: sunday, time: '10:00', name: 'Sara', phone: '03 123 456' });
  assert.equal(closed.status, 400); assert.match((await closed.json()).error, /do not take appointments/);
  const off = await book('10:30');
  assert.equal(off.status, 400); assert.match((await off.json()).error, /times shown/);
  assert.equal((await book('09:00', { service: 'Surgery' })).status, 400);
  assert.equal((await book('08:00')).status, 400); // before opening
  assert.equal((await book('12:00')).status, 400); // the appointment would end after closing
});

test('a day in the past is refused', async () => {
  const past = await post('/api/order', { service: 'Haircut', day: '2020-01-06', time: '10:00', name: 'Sara', phone: '03 123 456' });
  assert.equal(past.status, 400);
  assert.match((await past.json()).error, /already passed/);
});

test('the provider sees the appointments in the panel, and a declined one gives its time back', async () => {
  const list = await (await fetch(`${base}/api/panel/orders`, { headers: { cookie: ownerCookie } })).json();
  const booked = list.orders.filter((o) => o.kind === 'book' && o.day === MONDAY);
  assert.ok(booked.length >= 2);
  assert.ok(booked.every((o) => o.minutes === 60 && o.status === 'new'));
  const ten = booked.find((o) => o.time === '10:00');
  assert.equal((await (await post(`/api/panel/orders/${ten.id}`, { status: 'confirmed' }, { cookie: ownerCookie })).json()).order.status, 'confirmed');
  let day = await (await fetch(`${base}/api/availability?day=${MONDAY}`)).json();
  assert.equal(day.slots.find((s) => s.time === '10:00').free, false); // confirmed keeps the time
  await post(`/api/panel/orders/${ten.id}`, { status: 'declined' }, { cookie: ownerCookie });
  day = await (await fetch(`${base}/api/availability?day=${MONDAY}`)).json();
  assert.equal(day.slots.find((s) => s.time === '10:00').free, true); // declined gives it back
  assert.equal((await book('10:00', { name: 'Next client' })).status, 200);
});

test('a site without a calendar keeps the old free-form requests', () => {
  const s = createStore(path.join(root, 'old'));
  s.registerSite({ id: 'plain-site', name: 'Plain', setupToken: 'x', mode: 'book', catalog: [{ name: 'Haircut', price: 0 }], fulfil: [] });
  assert.equal(s.availabilityFor('plain-site', MONDAY), null);
  assert.ok(s.createOrder('plain-site', { service: 'Haircut', day: MONDAY, time: '13:15', name: 'Sara', phone: '03 123 456' }).order);
  s.close();
});
