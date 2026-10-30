import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitWishes } from '../src/stages/01-discovery/index.js';
import { formToAnswers, safeUploadName, looksLikeFile, validateSubmission } from '../src/server/customerFlow.js';
import { prepareAssistant, handoffOf, knowledgeFilesOf } from '../src/stages/10-assistant/index.js';
import { addChat, CHAT_JS } from '../src/stages/08-features/chat-widget.js';
import { knowledgeSchema } from '../src/lib/knowledgeFiles.js';
import { setProjectsRoot } from '../src/lib/project.js';
import { siteBriefSchema } from '../src/schemas/siteBrief.js';

const fixture = () => JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/site-brief.json'), 'utf8'));

test('the form carries the assistant choice and the owner\'s rules; only an explicit yes turns it on', () => {
  const form = { siteType: 'shop', shopKind: 'menu', businessName: 'Cafe', story: 'We make coffee the slow way, with love, every single morning.', items: [], whatsapp: '+961 71 014 463' };
  assert.deepEqual(formToAnswers({ ...form, assistant: true, assistantRules: 'Never discuss staff.' }).assistant, { enabled: true, rules: 'Never discuss staff.', model: 'standard' });
  assert.deepEqual(formToAnswers({ ...form, assistant: 'true' }).assistant, { enabled: false, rules: '', model: 'standard' }); // not a boolean: no
  assert.deepEqual(formToAnswers(form).assistant, { enabled: false, rules: '', model: 'standard' });
  const on = splitWishes(formToAnswers({ ...form, assistant: true, assistantRules: 'x'.repeat(5000) }));
  assert.equal(on.assistant.enabled, true);
  assert.equal(on.assistant.rules.length, 3000); // size-limited
  assert.equal(splitWishes(formToAnswers(form)).assistant, undefined);
  assert.equal(siteBriefSchema.parse({ ...fixture(), assistant: { enabled: true } }).assistant.rules, ''); // old briefs and new ones both load
  assert.equal(siteBriefSchema.parse(fixture()).assistant, undefined);
});

test('knowledge files: the kinds we read are accepted, kept apart from the photos, and must really be what they say', () => {
  assert.equal(safeUploadName('FAQ & policies.docx', 'knowledge'), 'FAQ-policies.docx');
  assert.equal(safeUploadName('Menu notes.PDF', 'knowledge'), 'Menu-notes.pdf');
  assert.equal(safeUploadName('prices.csv', 'knowledge'), 'prices.csv');
  assert.equal(safeUploadName('virus.exe', 'knowledge'), null);
  assert.equal(safeUploadName('sheet.xlsx', 'knowledge'), null);
  assert.equal(safeUploadName('faq.docx', 'photo'), null); // a Word file is never a website photo
  assert.equal(looksLikeFile(Buffer.from('PK\u0003\u0004rest of a zip'), '.docx'), true);
  assert.equal(looksLikeFile(Buffer.from('this is not a zip'), '.docx'), false);
  assert.equal(looksLikeFile(Buffer.from('Plain words\nand lines'), '.txt'), true);
  assert.equal(looksLikeFile(Buffer.from([0x41, 0x00, 0x42]), '.md'), false); // binary pretending to be text
  assert.equal(looksLikeFile(Buffer.from('%PDF-1.7'), '.pdf'), true);
});

test('preparing the assistant: facts by code, knowledge from the files, the owner\'s rules, and the way to reach a person', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-'));
  try {
    setProjectsRoot(root);
    const dir = path.join(root, 'c-assist-test'); fs.mkdirSync(path.join(dir, 'inputs/knowledge'), { recursive: true });
    const brief = { ...fixture(), projectId: 'c-assist-test', assistant: { enabled: true, rules: 'Never discuss staff.' } };
    brief.business.contact = { ...brief.business.contact, phone: '+961 1 234 567', whatsapp: '96171014463' };
    fs.writeFileSync(path.join(dir, 'site-brief.json'), JSON.stringify(brief));
    fs.writeFileSync(path.join(dir, 'inputs/knowledge/faq.md'), '# FAQ\nWe deliver to Hamra.');
    fs.writeFileSync(path.join(dir, 'inputs/knowledge/readme.exe'), 'x');
    assert.deepEqual(knowledgeFilesOf('c-assist-test').map((f) => path.basename(f)), ['faq.md']); // only the kinds we read

    let seen;
    const ask = async (args) => { seen = args; return knowledgeSchema.parse({ knowledge: '## Delivery\n- We deliver to Hamra.', heldBack: ['Supplier prices'], issues: ['Opening hours differ'] }); };
    const a = await prepareAssistant({ projectId: 'c-assist-test', ask, tune: false });
    assert.equal(a.enabled, true);
    assert.match(a.facts, new RegExp(`Business name: ${brief.business.name.replace(/[&()]/g, '\\$&')}`));
    assert.equal(a.knowledge, '## Delivery\n- We deliver to Hamra.');
    assert.equal(a.ownerRules, 'Never discuss staff.');
    assert.equal(a.handoff.whatsapp, '96171014463');
    assert.equal(a.persona.name, brief.business.name);
    assert.deepEqual(a.heldBack, ['Supplier prices']); assert.deepEqual(a.issues, ['Opening hours differ']);
    assert.match(seen.prompt, /Business name:/); // the model also sees the facts we already know
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'assistant.json'), 'utf8')).used, ['faq.md']);

    // not chosen: nothing is made
    fs.writeFileSync(path.join(dir, 'site-brief.json'), JSON.stringify({ ...brief, assistant: undefined }));
    fs.rmSync(path.join(dir, 'assistant.json'));
    assert.deepEqual(await prepareAssistant({ projectId: 'c-assist-test', ask, tune: false }), { enabled: false });
    assert.equal(fs.existsSync(path.join(dir, 'assistant.json')), false);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the way to a person: the owner\'s WhatsApp, else the phone, else the contact page', () => {
  const b = fixture();
  b.business.contact = { phone: '+961 1 234 567', email: '', address: '', hours: '', whatsapp: '96171014463' };
  assert.equal(handoffOf(b).whatsapp, '96171014463');
  b.business.contact.whatsapp = '';
  assert.deepEqual([handoffOf(b).whatsapp, handoffOf(b).phone], ['', '+961 1 234 567']);
  b.business.contact.phone = '';
  assert.equal(handoffOf(b).contactPath, b.pages.some((p) => p.slug === 'contact') ? '/contact/' : '');
});

test('the chat bubble is added once per page, only with a site id; its script only talks to the business\'s own server and stores nothing', () => {
  const r = addChat('<main>x</main>', { siteId: 'c-abc-123', name: 'Al "Jawad"', language: 'ar' });
  assert.ok(r.added);
  assert.match(r.html, /id="chat-config"[^>]*data-site="c-abc-123"[^>]*data-api=""[^>]*data-name="Al &quot;Jawad&quot;"[^>]*data-lang="ar"/);
  assert.match(r.html, /<link rel="stylesheet" href="\/chat\.css">/); assert.match(r.html, /<script src="\/chat\.js" defer><\/script>/);
  assert.equal(addChat(r.html, { siteId: 'c-abc-123' }).added, false);
  assert.equal(addChat('<main>x</main>', { siteId: '' }).added, false);
  assert.equal((CHAT_JS.match(/fetch\(/g) ?? []).length, 2); // the question, and (only on the owner's own page) the owner's comment
  assert.match(CHAT_JS, /fetch\(api \+ '\/api\/chat\/' \+ siteId/);
  assert.match(CHAT_JS, /fetch\(feedbackApi,/);
  assert.match(CHAT_JS, /var feedbackApi = cfg\.getAttribute\('data-feedback'\) \|\| ''/); // visitors never get a feedback link: it needs the attribute only the owner's page sets
  assert.doesNotMatch(CHAT_JS, /localStorage|XMLHttpRequest|innerHTML|document\.write|eval\(/); // the conversation stays in this tab; replies are never run as HTML
  assert.match(CHAT_JS, /sessionStorage/);
});

test('a plain website with no products can still choose the assistant (the form accepts it with an empty list)', () => {
  const form = { siteType: 'shop', shopKind: 'intro', businessName: 'Studio Noor', story: 'Noor started shooting her friends\' products on a kitchen table, years ago.', items: [], whatsapp: '+961 3 220 330', assistant: true };
  assert.equal(validateSubmission(form).ok, true);
  assert.equal(formToAnswers(form).assistant.enabled, true);
});

test('the owner chooses how the assistant works: standard or economy (the cheaper model), and every call for that business uses it', async () => {
  const form = { siteType: 'shop', shopKind: 'menu', businessName: 'Cafe', story: 'We make coffee the slow way, with love, every single morning.', items: [], whatsapp: '+961 71 014 463', assistant: true };
  assert.equal(formToAnswers({ ...form, assistantModel: 'economy' }).assistant.model, 'economy');
  assert.equal(formToAnswers({ ...form, assistantModel: 'anything else' }).assistant.model, 'standard'); // only the two known ways
  assert.equal(splitWishes(formToAnswers({ ...form, assistantModel: 'economy' })).assistant.model, 'economy');
  assert.equal(siteBriefSchema.parse({ ...fixture(), assistant: { enabled: true } }).assistant.model, 'standard'); // old briefs still load
  const { chatModelFor } = await import('../src/config.js');
  assert.equal(chatModelFor('economy'), 'claude-haiku-5-5');
  // preparing: the tuning asks the model of the owner's choice, and the choice is kept in the assistant's config
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-model-'));
  try {
    setProjectsRoot(root);
    const dir = path.join(root, 'c-model-test'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'site-brief.json'), JSON.stringify({ ...fixture(), projectId: 'c-model-test', assistant: { enabled: true, rules: '', model: 'economy' } }));
    const a = await prepareAssistant({ projectId: 'c-model-test', ask: async () => knowledgeSchema.parse({}), tune: false });
    assert.equal(a.model, 'economy');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(root, { recursive: true, force: true }); }
});
