// Reads every page of a drafted site and answers: where does every link, button and icon go?
//   - a link that goes nowhere ("#"): clicking it only jumps back to the top of the same page
//   - a link to a page or a spot that does not exist
//   - a link that starts with "/" (it works on a laptop's own server and breaks when the site sits in a folder on the internet)
//   - two DIFFERENT buttons that lead to the same place (for example "Coaches" and "Academy" both opening the same section)
// It only reads: nothing is changed. Pure functions, so they can be tested.

import fs from 'node:fs';
import path from 'node:path';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const textOf = (inner) => decode(inner.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const iconNames = (inner) => [...inner.matchAll(/<(?:span|i)\b[^>]*material-(?:symbols|icons)[^>]*>\s*([a-z0-9_]+)\s*<\/(?:span|i)>/gi)].map((m) => m[1]);
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length >= 4));

// "Book" and "Book a Court" are one idea; "Coaches" and "Academy" are two
export function sameIdea(a, b) {
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y || x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return true;
  const wa = words(a); const wb = words(b);
  return [...wa].some((w) => wb.has(w));
}

// The links of one page, each with its label and where it points
export function linksOf(html) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/gi)].map((m) => m[1]));
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = decode(m[1].match(/\bhref="([^"]*)"/i)?.[1] ?? '');
    const icons = iconNames(m[2]);
    const label = textOf(m[2].replace(/<(?:span|i)\b[^>]*material-(?:symbols|icons)[^>]*>[\s\S]*?<\/(?:span|i)>/gi, ' ')) || decode(m[1].match(/\baria-label="([^"]*)"/i)?.[1] ?? '') || (icons[0] ? `(icon: ${icons[0]})` : '(no text)');
    out.push({ href, label: label.slice(0, 60), ids });
  }
  return out;
}

// where a link goes: { kind, dest } with kind one of page | anchor | dead | external | contact | missing | missing-anchor | root-relative
export function classify(link, file, files) {
  const h = link.href.trim();
  if (!h || h === '#' || /^javascript:/i.test(h)) return { kind: 'dead', dest: '' };
  if (/^(tel:|mailto:|sms:)/i.test(h) || /wa\.me|whatsapp/i.test(h)) return { kind: 'contact', dest: h };
  if (/^https?:\/\//i.test(h)) return { kind: 'external', dest: h };
  if (h.startsWith('/')) return { kind: 'root-relative', dest: h };
  if (h.startsWith('#')) return link.ids.has(h.slice(1)) ? { kind: 'anchor', dest: `${file}${h}` } : { kind: 'missing-anchor', dest: `${file}${h}` };
  const [target, anchor] = h.split('#');
  const name = target.replace(/^\.\//, '');
  if (!files.includes(name)) return { kind: 'missing', dest: h };
  return { kind: 'page', dest: anchor ? `${name}#${anchor}` : name };
}

// Different labels that lead to the same place, within one page (the same label twice, such as a menu and a footer, is normal)
export function duplicateDestinations(links) {
  const by = new Map();
  for (const l of links) if (['page', 'anchor'].includes(l.kind)) { const key = l.dest; if (!by.has(key)) by.set(key, []); by.get(key).push(l.label); }
  const found = [];
  for (const [dest, labels] of by) {
    const distinct = [...new Set(labels.filter((x) => !x.startsWith('(')))];
    const conflict = distinct.some((a, i) => distinct.slice(i + 1).some((b) => !sameIdea(a, b)));
    if (conflict) found.push({ dest, labels: distinct });
  }
  return found;
}

export function auditSite(dir, { businessName = '' } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const brand = norm(businessName);
  const report = { pages: [], totals: { links: 0, working: 0, dead: 0, missing: 0, missingAnchors: 0, rootRelative: 0, duplicates: 0 } };
  for (const file of files) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const links = linksOf(html).map((l) => ({ ...l, ...classify(l, file, files) }));
    // the logo (the business name) and "Home" lead to the same place on purpose
    const checked = links.filter((l) => !(brand && norm(l.label) === brand) && norm(l.label) !== 'home');
    const dup = duplicateDestinations(checked);
    const page = {
      file, links: links.length,
      working: links.filter((l) => ['page', 'anchor', 'external', 'contact'].includes(l.kind)).length,
      dead: [...new Set(links.filter((l) => l.kind === 'dead').map((l) => l.label))],
      missing: links.filter((l) => l.kind === 'missing').map((l) => `${l.label} -> ${l.href}`),
      missingAnchors: links.filter((l) => l.kind === 'missing-anchor').map((l) => `${l.label} -> ${l.href}`),
      rootRelative: links.filter((l) => l.kind === 'root-relative').map((l) => `${l.label} -> ${l.href}`),
      duplicates: dup,
    };
    report.pages.push(page);
    const t = report.totals;
    t.links += page.links; t.working += page.working; t.dead += links.filter((l) => l.kind === 'dead').length;
    t.missing += page.missing.length; t.missingAnchors += page.missingAnchors.length; t.rootRelative += page.rootRelative.length; t.duplicates += dup.length;
  }
  return report;
}
