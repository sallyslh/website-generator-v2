// Automatic quality checks for Stage 8 (no LLM). Each check returns { name, ok, details }.
// checkFeatures is pure (unit tested); runChecks loads the project files.

import fs from 'node:fs';
import path from 'node:path';
import { exists, projectPath, readJson } from '../../lib/project.js';
import { siteBriefSchema } from '../../schemas/siteBrief.js';
import { HONEYPOT } from './forms.js';

// pages: [{ slug, html }]. report: the features part of site-report.json. publicFiles: names found in site/public.
export function checkFeatures({ pages, brief, report, publicFiles = [] }) {
  const results = [];
  const check = (name, ok, details = '') => results.push({ name, ok, details });
  const all = (re) => pages.flatMap((p) => [...p.html.matchAll(re)].map((m) => ({ slug: p.slug, text: m[0] })));
  const forms = all(/<form\b[\s\S]*?<\/form>/gi);

  const connectedForm = /data-features="(form|whatsapp)"/;
  const loose = forms.filter((f) => !connectedForm.test(f.text));
  check('no dead form: every form on the site delivers its messages (a service or WhatsApp)', loose.length === 0, loose.map((f) => f.slug).join(', '));
  const bad = [];
  for (const f of forms.filter((x) => connectedForm.test(x.text))) {
    const open = f.text.match(/<form\b[^>]*>/i)[0];
    if (/data-features="whatsapp"/.test(open)) {
      const digits = open.match(/data-wa="(\d+)"/)?.[1] ?? '';
      if (digits.length < 8 || digits.length > 15) bad.push(`${f.slug}: the WhatsApp number is missing or is not international`);
      if (/\baction="/i.test(open)) bad.push(`${f.slug}: a WhatsApp form must not post anywhere`);
    } else {
      if (!/\baction="https:\/\//i.test(open)) bad.push(`${f.slug}: the form does not post to an https address`);
      if (!/\bmethod="POST"/i.test(open)) bad.push(`${f.slug}: the form does not use POST`);
    }
    if (!new RegExp(`name="${HONEYPOT}"`).test(f.text)) bad.push(`${f.slug}: no spam trap`);
    const unnamed = (f.text.match(/<(input|textarea|select)\b[^>]*>/gi) ?? []).filter((t) => !/type="(submit|button|hidden)"/i.test(t) && !/\bname="/i.test(t));
    if (unnamed.length) bad.push(`${f.slug}: ${unnamed.length} field(s) have no name, so the service would not receive them`);
    if (!/data-success="[^"]+"/.test(open) || !/data-error="[^"]+"/.test(open)) bad.push(`${f.slug}: the success or error message is missing`);
  }
  if (forms.some((f) => connectedForm.test(f.text))) {
    if (!pages.some((p) => /data-form-status/.test(p.html))) bad.push('no place to show the success or error message');
    if (!publicFiles.includes('form.js')) bad.push('form.js (the script that sends the form) is missing');
  }
  check('connected forms are complete: https address (or an international WhatsApp number), POST, spam trap, named fields, messages, sender script', bad.length === 0, bad.join('; '));

  const wantsMap = brief.features.some((f) => f.type === 'map-embed');
  const hasMap = pages.some((p) => /data-features="map"/.test(p.html));
  check('a requested map appears when the owner gave an address', !wantsMap || !brief.business.contact.address.trim() || hasMap, 'the owner wanted a map and gave an address, but there is none');
  const booking = brief.features.find((f) => f.type === 'booking-embed');
  const linked = booking?.url && pages.some((p) => p.html.includes(booking.url.replace(/&/g, '&amp;')) || p.html.includes(booking.url));
  check('a requested booking button appears when the owner gave a link', !booking?.url || Boolean(linked), 'the owner gave a booking link, but no page links to it');
  check('features that could not be added (informational)', true, [report?.form && !['connected', 'whatsapp', 'none'].includes(report.form) ? `form: ${report.form} (no form service set up yet)` : '', report?.map?.startsWith('skipped') ? `map: ${report.map}` : '', report?.booking?.startsWith('skipped') || report?.booking?.startsWith('not added') ? `booking: ${report.booking}` : ''].filter(Boolean).join('; ') || 'none');
  return results;
}

export async function runChecks({ projectId }) {
  const siteDir = projectPath(projectId, 'site');
  if (!fs.existsSync(path.join(siteDir, 'src/content'))) throw new Error(`The site is not generated in "${projectId}". Run: node src/cli.js site --project ${projectId}`);
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const dir = path.join(siteDir, 'src/content');
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => ({ slug: f.replace(/\.html$/, ''), html: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const report = exists(projectId, 'site/site-report.json') ? JSON.parse(fs.readFileSync(path.join(siteDir, 'site-report.json'), 'utf8')).features : null;
  const publicDir = path.join(siteDir, 'public');
  return checkFeatures({ pages, brief, report, publicFiles: fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : [] });
}
