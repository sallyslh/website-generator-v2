// After a site is built, opens every page in a real browser at a phone, a tablet, a laptop and a TV width and reports what does not fit
// (content wider than the screen, text cut off at the edge). It only reports: it never fails a site. Without a browser it says so and returns null.

import { inspectInBrowser } from '../stages/09-qa/browser.js';

export const DEVICE_VIEWS = {
  phone: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
  laptop: { width: 1440, height: 900, mobile: false },
  tv: { width: 1920, height: 1080, mobile: false },
};

// pure: the measured pages -> { phone: { fit, total, problems: [...] }, ... }
export function summariseDevices(result, views = DEVICE_VIEWS) {
  const out = {};
  for (const name of Object.keys(views)) {
    const rows = (result?.pages ?? []).map((p) => ({ route: p.route, m: p[name] }));
    const problems = rows.filter((r) => !r.m?.ok || r.m.overflowPx > 1 || r.m.cutOff?.length).map((r) => `${r.route}: ${r.m?.ok ? `${r.m.overflowPx > 1 ? `${r.m.overflowPx}px too wide` : ''}${r.m.cutOff?.length ? ` text cut off (${r.m.cutOff.slice(0, 2).join(', ')})` : ''}`.trim() : 'could not be measured'}`);
    out[name] = { width: views[name].width, fit: rows.length - problems.length, total: rows.length, problems };
  }
  return out;
}

export async function deviceCheck({ dir, routes, views = DEVICE_VIEWS, totalMs = 420000 }) {
  const result = await inspectInBrowser({ distDir: dir, routes: routes.map((r) => `/${r}`), views, totalMs });
  return result ? summariseDevices(result, views) : null;
}
