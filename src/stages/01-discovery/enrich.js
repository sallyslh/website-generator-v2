// Stage 1, step C: fill empty parts of the brief from the customer's analyzed files.
//   enrich  : reads site-brief.json + asset-manifest.json, saves PROPOSALS (with evidence) in the brief.
//   confirm : the customer accepts or rejects each proposal; accepted ones are merged into the brief.
// The owner's own answers are never overwritten, and contact details are only proposed when they
// are literally visible text in a file (for example a phone number printed on the logo).

import { confirm } from '@inquirer/prompts';
import { z } from 'zod';
import { askJson } from '../../lib/llm.js';
import { readJson, writeJson } from '../../lib/project.js';
import { siteBriefSchema, proposalSchema } from '../../schemas/siteBrief.js';
import { assetManifestSchema } from '../../schemas/assetManifest.js';
import { log } from '../../lib/log.js';
import { ENRICH_SYSTEM, enrichPrompt } from './prompts.js';
import { priceFromFact } from '../../lib/prices.js';

const STAGE = 'enrich';

export const ALLOWED_PATHS = [
  'business.type', 'business.description', 'business.contact.phone', 'business.contact.email',
  'business.contact.address', 'business.contact.hours', 'business.socialLinks', 'offerings', 'offerings.prices', 'offerings.products',
  'brand.hasIdentity', 'brand.colors', 'brand.personality', 'tone',
];
const CONTACT_PATHS = ALLOWED_PATHS.filter((p) => p.startsWith('business.contact.'));

// Which "unknowns" lines disappear once a proposal is accepted.
const UNKNOWN_PATTERN = {
  'business.type': /type|what the business/i,
  'business.description': /description|what the business/i,
  'business.contact.phone': /phone/i,
  'business.contact.email': /email/i,
  'business.contact.address': /address/i,
  'business.contact.hours': /hours/i,
  'business.socialLinks': /social|instagram|handle/i,
  offerings: /product|service|offering/i,
  'offerings.prices': /price/i,
  'offerings.products': /product|service|offering/i,
  'brand.hasIdentity': /logo/i,
  'brand.colors': /color|colour|logo/i,
  'brand.personality': /feeling|personality/i,
  tone: /tone|feeling/i,
};

// Social profile URLs are built by code from a platform and a handle the files show.
const PROFILE_URL = {
  instagram: (h) => `https://www.instagram.com/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  twitter: (h) => `https://x.com/${h}`,
  x: (h) => `https://x.com/${h}`,
};

const answerSchema = z.object({ proposals: z.array(proposalSchema.omit({ status: true })).max(14) });

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

const isEmpty = (v) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const digits = (s) => s.replace(/\D/g, '');
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');

// Keeps only proposals that follow the rules. Returns { kept, dropped: [{proposal, reason}] }.
export function filterProposals(brief, manifest, proposals) {
  const seenText = norm(manifest.assets.map((a) => `${a.description} ${a.notes}`).join(' '));
  const seenDigits = digits(seenText);
  const assetIds = new Set([...manifest.assets.map((a) => a.id), ...manifest.documents.map((d) => d.id)]);
  const documentText = norm(manifest.documents.flatMap((d) => d.facts).join(' | '));
  const kept = [];
  const dropped = [];
  for (const p of proposals) {
    const drop = (reason) => dropped.push({ proposal: p, reason });
    if (!ALLOWED_PATHS.includes(p.path)) { drop('path not allowed'); continue; }
    if (brief.siteType && brief.offerings.length && p.path.startsWith('offerings')) { drop('the owner gave the list of products on the form'); continue; } // their list is the list
    if (!isEmpty(getPath(brief, p.path)) && p.path !== 'brand.hasIdentity') { drop('owner already answered this'); continue; }
    if (p.path === 'brand.hasIdentity' && brief.brand.hasIdentity) { drop('already true'); continue; }
    if (!(p.evidence.match(/(asset|doc)-\d+/g) || []).some((id) => assetIds.has(id))) { drop('evidence names no real asset id'); continue; }
    if (p.path === 'offerings.prices') {
      // every "Name|price" must be written exactly like that in a customer document
      const bad = [].concat(p.value).filter((entry) => { const [name, price] = String(entry).split('|'); return !name || !price || !documentText.includes(norm(price)) || !documentText.includes(norm(name)); });
      if (bad.length) { drop(`price is not written in any document: ${bad.join(', ')}`); continue; }
    }
    if (p.path === 'offerings.products') {
      // every "Name|asset-id": the name must be readable text in the analysis of THAT photo, and not already a known offering
      const byId = new Map(manifest.assets.map((a) => [a.id, a]));
      const known = new Set(brief.offerings.map((o) => norm(o.name)));
      const entries = [].concat(p.value).map((e) => String(e).split('|'));
      // words, not exact text: the photo notes may separate a name with commas or line breaks ("KAY ALI, DÉJÀ VU WHITE FLOWER")
      const wordsOf = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      const readable = ([name, id]) => {
        const a = byId.get(id);
        if (!name?.trim() || !a || a.kind === 'logo') return false;
        const seen = new Set(wordsOf(`${a.description} ${a.notes}`));
        return wordsOf(name).length > 0 && wordsOf(name).every((w) => seen.has(w));
      };
      const bad = entries.filter((e) => !readable(e));
      const fresh = entries.filter((e) => readable(e) && !known.has(norm(e[0].trim())));
      if (!fresh.length) { drop(bad.length ? `product name is not readable text in its photo: ${bad.map((b) => b.join('|')).join(', ')}` : 'every product is already in the brief'); continue; }
      kept.push({ ...p, value: fresh.map(([name, id]) => `${name.trim()}|${id}`), status: 'pending' });
      continue;
    }
    if (p.path === 'business.socialLinks') {
      const handles = [].concat(p.value).map((v) => String(v).split(':')[1]?.trim().replace(/^@/, '').toLowerCase());
      if (!handles.length || handles.some((h) => !h || !seenText.includes(h))) { drop('social handle is not visible text in any file'); continue; }
    }
    if (CONTACT_PATHS.includes(p.path)) {
      const value = String(p.value);
      const visible = p.path.endsWith('phone') ? digits(value).length >= 6 && seenDigits.includes(digits(value)) : seenText.includes(norm(value));
      if (!visible) { drop('contact detail is not visible text in any file'); continue; }
    }
    kept.push({ ...p, status: 'pending' });
  }
  return { kept, dropped };
}

// Merges accepted proposals into the brief and removes the "unknowns" they answer.
export function applyProposals(brief) {
  const result = structuredClone(brief);
  const unknownsToClear = [];
  for (const p of result.proposals) {
    if (p.status !== 'accepted') continue;
    if (p.path === 'business.socialLinks') {
      for (const entry of p.value) {
        const [platform, handle] = entry.split(':').map((x) => x.trim().replace(/^@/, ''));
        const url = PROFILE_URL[platform.toLowerCase()]?.(handle);
        if (url && !result.business.socialLinks.some((l) => l.url === url)) result.business.socialLinks.push({ platform: platform.toLowerCase(), url });
      }
    } else if (p.path === 'offerings.prices') {
      for (const entry of p.value) {
        const [name, price] = entry.split('|');
        const offering = result.offerings.find((o) => o.name.toLowerCase() === name.toLowerCase());
        if (offering) { if (!offering.price) offering.price = price; } else result.offerings.push({ name, description: '', price });
      }
    } else if (p.path === 'offerings.products') {
      const have = new Set(result.offerings.map((o) => o.name.toLowerCase()));
      for (const entry of p.value) {
        const [name, assetId] = entry.split('|');
        if (!have.has(name.toLowerCase())) { result.offerings.push({ name, description: '', assetId }); have.add(name.toLowerCase()); }
      }
    } else if (p.path === 'offerings') {
      const have = new Set(result.offerings.map((o) => o.name.toLowerCase()));
      for (const name of p.value) if (!have.has(name.toLowerCase())) result.offerings.push({ name, description: '' });
    } else {
      setPath(result, p.path, p.value);
    }
    unknownsToClear.push(UNKNOWN_PATTERN[p.path]);
  }
  result.unknowns = result.unknowns.filter((u) => !unknownsToClear.some((re) => re && re.test(u)));
  return result;
}

// Phones and emails are found by code, not by the LLM: exact text in the file analysis, nothing guessed.
export function contactProposals(brief, manifest) {
  const found = [];
  for (const a of manifest.assets) {
    const text = `${a.description} ${a.notes}`;
    const phone = (text.match(/\+?\d[\d\s().-]{5,}\d/g) || []).find((m) => digits(m).length >= 7 && digits(m).length <= 15 && !/\bml\b|\bfl\b|oz/i.test(text.slice(text.indexOf(m) + m.length, text.indexOf(m) + m.length + 6)));
    if (phone && !brief.business.contact.phone && !found.some((f) => f.path.endsWith('phone')))
      found.push({ path: 'business.contact.phone', value: phone.trim(), evidence: `${a.id} (${a.file.split('/').pop()}) shows the text "${phone.trim()}"` });
    const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    if (email && !brief.business.contact.email && !found.some((f) => f.path.endsWith('email')))
      found.push({ path: 'business.contact.email', value: email[0], evidence: `${a.id} (${a.file.split('/').pop()}) shows the text "${email[0]}"` });
  }
  const social = [];
  for (const a of manifest.assets)
    for (const m of `${a.description} ${a.notes}`.matchAll(/\b(instagram|tiktok)\b\s*:?\s*@?([A-Za-z0-9_.]{3,30})/gi)) {
      const entry = `${m[1].toLowerCase()}:${m[2].replace(/\.$/, '')}`;
      if (!social.includes(entry)) social.push(entry);
    }
  if (social.length && brief.business.socialLinks.length === 0)
    found.push({ path: 'business.socialLinks', value: social, evidence: `${manifest.assets.find((a) => /instagram|tiktok/i.test(a.notes))?.id ?? 'a file'} shows these social handles: ${social.join(', ')}` });
  return found;
}

// Prices written in the customer's documents (price lists, menus) become ONE proposal "Name|price" for the owner to confirm.
// Found by code from the exact facts Stage 2 copied out of the document: nothing is guessed or rounded.
export function priceProposals(brief, manifest) {
  const entries = [];
  for (const d of manifest.documents)
    for (const fact of d.facts) {
      const found = priceFromFact(fact);
      if (found) entries.push({ ...found, doc: d.id });
    }
  const fresh = entries.filter((e) => !brief.offerings.some((o) => o.price && o.name.toLowerCase() === e.name.toLowerCase()));
  if (!fresh.length) return [];
  return [{
    path: 'offerings.prices',
    value: fresh.map((e) => `${e.name}|${e.price}`),
    evidence: `${[...new Set(fresh.map((e) => e.doc))].join(', ')} lists these prices: ${fresh.map((e) => `${e.name}: ${e.price}`).join('; ')}`,
  }];
}

export async function enrich({ projectId }) {
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const manifest = readJson(projectId, 'asset-manifest.json', assetManifestSchema);
  const { proposals } = await askJson({
    projectId, stage: STAGE, system: ENRICH_SYSTEM, prompt: enrichPrompt(brief, manifest), schema: answerSchema, maxTokens: 3000,
  });
  const fromCode = [...contactProposals(brief, manifest), ...priceProposals(brief, manifest)].filter((c) => !proposals.some((p) => p.path === c.path));
  const { kept, dropped } = filterProposals(brief, manifest, [...proposals, ...fromCode]);
  const decided = brief.proposals.filter((p) => p.status !== 'pending');
  brief.proposals = [...decided, ...kept];
  writeJson(projectId, 'site-brief.json', brief, siteBriefSchema);

  console.log(`\n${kept.length} proposals from the customer's files (pending confirmation):`);
  for (const p of kept) console.log(`  ${p.path} = ${JSON.stringify(p.value)}\n      evidence: ${p.evidence}`);
  for (const d of dropped) log.info(STAGE, `dropped "${d.proposal.path}": ${d.reason}`);
  log.info(STAGE, `Next: node src/cli.js confirm --project ${projectId}`);
}

export async function confirmProposals({ projectId, acceptAll = false }) {
  const brief = readJson(projectId, 'site-brief.json', siteBriefSchema);
  const pending = brief.proposals.filter((p) => p.status === 'pending');
  if (!pending.length) return log.info(STAGE, 'No pending proposals.');
  for (const p of pending) {
    console.log(`\n${p.path} = ${JSON.stringify(p.value)}\n  evidence: ${p.evidence}`);
    const yes = acceptAll ? true : await confirm({ message: 'Is this right?', default: true });
    p.status = yes ? 'accepted' : 'rejected';
  }
  const merged = applyProposals(brief);
  writeJson(projectId, 'site-brief.json', merged, siteBriefSchema);
  const accepted = pending.filter((p) => p.status === 'accepted').length;
  log.info(STAGE, `${accepted} accepted, ${pending.length - accepted} rejected. site-brief.json updated.`);
}
