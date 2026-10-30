// Opening hours and appointment slots. Pure functions (no database, no clock of their own), so they are tested.
//   schedule   { mon: [['09:00', '17:00']], tue: [...], ... }   the days a business takes appointments and between which hours
//   slot       the length of one appointment in minutes (the same for every service)
// A slot is free when it is inside the opening hours, not in the past (in the business's own time zone) and does not overlap an
// appointment that is waiting or confirmed (a declined or cancelled one gives the slot back).

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const toMinutes = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const weekdayOf = (day) => DAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
export const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// What day and minute of the day it is in a time zone ("Asia/Beirut"). An unknown zone falls back to UTC.
export function nowIn(tz, at = new Date()) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at); }
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// The schedule from the owner's answers: days ['mon', ...] open from 'HH:MM' to 'HH:MM'. null when there is nothing usable.
export function scheduleFrom({ days = [], from = '09:00', to = '17:00' } = {}) {
  const a = toMinutes(from); const b = toMinutes(to);
  if (a == null || b == null || b <= a) return null;
  const open = [...new Set(days.map((d) => String(d).toLowerCase()))].filter((d) => DAYS.includes(d));
  if (!open.length) return null;
  return Object.fromEntries(open.map((d) => [d, [[fromMinutes(a), fromMinutes(b)]]]));
}

// The start times of the appointments of one day: every `slot` minutes inside each opening range, while the appointment fits.
export function slotsOf(schedule, slot, day) {
  const out = [];
  for (const [from, to] of schedule?.[weekdayOf(day)] ?? []) {
    for (let t = toMinutes(from); t + slot <= toMinutes(to); t += slot) out.push(fromMinutes(t));
  }
  return out;
}

// booked: the start times ('HH:MM') of the appointments already taken that day. at: the moment now (a test can set it).
export function availability({ schedule, slot = 60, tz = 'UTC' }, day, booked = [], at = new Date()) {
  const now = nowIn(tz, at);
  const taken = booked.map(toMinutes).filter((n) => n != null);
  const slots = slotsOf(schedule, slot, day).map((time) => {
    const t = toMinutes(time);
    const past = day < now.day || (day === now.day && t <= now.minutes);
    const overlaps = taken.some((b) => t < b + slot && b < t + slot);
    return { time, free: !past && !overlaps, ...(past ? { past: true } : {}) };
  });
  return { day, open: slots.length > 0, slots };
}
