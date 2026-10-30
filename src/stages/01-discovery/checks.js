// Automatic quality checks for Stage 1 (no LLM). Each check returns { name, ok, details }.
// checkBrief is pure (easy to unit test); runChecks loads the files of a project.

import fs from 'node:fs';
import { exists, projectPath } from '../../lib/project.js';
import { siteBriefSchema, FEATURE_TYPES } from '../../schemas/siteBrief.js';

const digitsOf = (s) => s.replace(/\D/g, '');

// Every text value of the brief, except fields that are not business facts.
function briefTexts(brief) {
  const texts = [];
  const walk = (value, key) => {
    if (['projectId', 'schemaVersion', 'language', 'unknowns', 'type'].includes(key)) return;
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(brief, '');
  return texts;
}

// Flattens the answers (including follow-ups) into one lowercase string.
function answersText(answers) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(answers);
  return parts.join('\n').toLowerCase();
}

const SOCIAL_HOSTS = /^(www.)?(instagram|facebook|tiktok|linkedin|twitter|x|youtube).com$/;

// A URL is fine if the owner wrote it, or if it is a social profile built from a handle the owner wrote.
function urlIsGrounded(url, text) {
  const clean = url.toLowerCase().replace(/[.,;)]+$/, '');
  if (text.includes(clean)) return true;
  try {
    const u = new URL(clean);
    const handle = u.pathname.split('/').filter(Boolean).pop();
    return SOCIAL_HOSTS.test(u.hostname) && !!handle && text.includes(handle);
  } catch {
    return false;
  }
}

function inventedFacts(brief, answers) {
  const text = answersText(answers);
  const answerDigits = digitsOf(text);
  const problems = [];
  for (const t of briefTexts(brief)) {
    for (const email of t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])
      if (!text.includes(email.toLowerCase())) problems.push(`email "${email}"`);
    for (const url of t.match(/https?:\/\/\S+/g) || [])
      if (!urlIsGrounded(url, text)) problems.push(`url "${url}"`);
    for (const hex of t.match(/#[0-9a-f]{3,8}\b/gi) || [])
      if (!text.includes(hex.toLowerCase())) problems.push(`color "${hex}"`);
    const withoutColorsAndUrls = t.replace(/#[0-9a-f]{3,8}\b/gi, '').replace(/https?:\/\/\S+/g, '');
    for (const num of withoutColorsAndUrls.match(/\d[\d ()\-.,:]*\d|\d/g) || []) {
      const d = digitsOf(num);
      if (d && !answerDigits.includes(d)) problems.push(`number "${num}"`);
    }
  }
  return [...new Set(problems)];
}

// Offerings named in the answers: compare the first word of each listed item.
function missingOfferings(brief, answers) {
  const offeringText = JSON.stringify(brief.offerings).toLowerCase();
  const items = String(answers.productsAndServices || '')
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && s.split(/\s+/).length <= 6 && !/\b(don't|do not|i )/i.test(s));
  return items.filter((item) => !offeringText.includes(item.split(/\s+/)[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
}

// For each empty answer, which words the matching "unknowns" entry must contain.
const UNKNOWN_WORDS = {
  pages: /page/i,
  likedSites: /like|reference|inspiration|website/i,
  dislikedSites: /dislike|reference|website/i,
  brand: /brand|color|colour|logo|font/i,
  features: /feature/i,
  locationAndContact: /location|contact|phone|address|email|hours/i,
  productsAndServices: /product|service|offering|price|item/i,
  customers: /customer|audience|client/i,
  mainGoal: /goal|objective/i,
  brandFeeling: /feel|personality|brand|tone/i,
  whatItDoes: /business|do/i,
  anythingElse: /.*/,
  story: /story/i,
};

function missingUnknowns(brief, answers) {
  const unknowns = brief.unknowns.join('\n');
  const problems = [];
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== 'string' || value.trim() !== '') continue;
    if (key === 'anythingElse' || key === 'notFor') continue; // an empty "anything else" or "not for" is not a gap
    const pattern = UNKNOWN_WORDS[key] || new RegExp(key.replace(/([A-Z])/g, ' $1'), 'i');
    if (!pattern.test(unknowns)) problems.push(`answer "${key}" is empty but unknowns does not mention it`);
  }
  const contact = brief.business.contact;
  for (const field of ['phone', 'email', 'address', 'hours'])
    if (!contact[field] && !new RegExp(field === 'hours' ? 'hours|opening' : field, 'i').test(unknowns))
      problems.push(`contact ${field} is empty but unknowns does not mention it`);
  if (brief.brand.colors.length === 0 && !/color|colour|brand/i.test(unknowns)) problems.push('no brand colors and unknowns does not mention it');
  return problems;
}

export function checkBrief(rawBrief, answers) {
  const results = [];
  const parsed = siteBriefSchema.safeParse(rawBrief);
  results.push({ name: 'schema valid', ok: parsed.success, details: parsed.success ? '' : parsed.error.issues.map((i) => i.path.join('.')).join(', ') });
  if (!parsed.success) return results;
  const brief = parsed.data;

  const wanted = String(answers.homeWishes ?? '').trim();
  results.push({ name: 'the owner\'s wishes for the home page are kept word for word', ok: brief.wishes.home === wanted.slice(0, 1500) && brief.wishes.aiPictures === (answers.aiPictures === 'photos-only' ? 'photos-only' : 'allowed'), details: wanted ? '' : 'the owner gave no wishes (nothing to keep)' });

  results.push({ name: 'home page exists', ok: brief.pages.some((p) => p.slug === 'home'), details: '' });

  const invented = inventedFacts(brief, answers);
  results.push({ name: 'no invented facts (phones, emails, urls, numbers, colors)', ok: invented.length === 0, details: invented.join(', ') });

  const missing = missingOfferings(brief, answers);
  results.push({ name: 'every offering from the answers is in the brief', ok: missing.length === 0, details: missing.join(', ') });

  const gaps = missingUnknowns(brief, answers);
  results.push({ name: 'empty answers are listed in unknowns', ok: gaps.length === 0, details: gaps.join('; ') });

  const badFeatures = brief.features.filter((f) => !FEATURE_TYPES.includes(f.type));
  results.push({ name: 'features only from the allowed list', ok: badFeatures.length === 0, details: badFeatures.map((f) => f.type).join(', ') });
  return results;
}

export async function runChecks({ projectId }) {
  if (!exists(projectId, 'site-brief.json')) throw new Error(`Missing site-brief.json in "${projectId}". Run the brief step first.`);
  const read = (file) => JSON.parse(fs.readFileSync(projectPath(projectId, file), 'utf8'));
  return checkBrief(read('site-brief.json'), read('inputs/answers.json'));
}
