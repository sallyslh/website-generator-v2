// Tests for WhatsApp as the way a contact form delivers its messages (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { whatsappDigits, whatsappLink } from '../src/lib/phone.js';
import { formToAnswers } from '../src/server/customerFlow.js';
import { splitWishes } from '../src/stages/01-discovery/index.js';
import { siteBriefSchema } from '../src/schemas/siteBrief.js';
import { connectWhatsApp, FORM_JS, HONEYPOT } from '../src/stages/08-features/forms.js';
import { deliveryMode, applyFeatures } from '../src/stages/08-features/index.js';
import { checkFeatures, runChecks } from '../src/stages/08-features/checks.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const FORM = `<main><form id="contact-form" action="#"><label for="n">Your name</label><input id="n" type="text" placeholder="Name"/><input type="tel" placeholder="Phone"/><textarea placeholder="What would you like?"></textarea><button class="btn">Send</button></form></main>`;
const messages = { success: 'Opening WhatsApp...', error: 'Sorry.' };

test('a WhatsApp number counts only when it is clearly international; a local number is never guessed', () => {
  assert.equal(whatsappDigits('+961 71 014 463'), '96171014463');
  assert.equal(whatsappDigits('00961-71-014463'), '96171014463');
  assert.equal(whatsappDigits('+20 100 123 4567'), '201001234567');
  for (const bad of ['71-014463', '071014463', '961 71 014463', '', null, undefined, '+12', '+0123456789', '+1234567890123456', 'call me']) assert.equal(whatsappDigits(bad), '', String(bad));
  assert.equal(whatsappLink('96171014463', 'Name: Sara\nWhat: a gift'), 'https://wa.me/96171014463?text=Name%3A%20Sara%0AWhat%3A%20a%20gift');
  assert.equal(whatsappLink('96171014463'), 'https://wa.me/96171014463');
});

test('the form carries the WhatsApp number and the choice; Stage 1 keeps them by code, and only a valid number or an email can be the choice', () => {
  const a = formToAnswers({ businessName: 'Cafe', whatsapp: ' +961 71 014 463 ', messagesTo: 'whatsapp' });
  assert.deepEqual([a.whatsapp, a.messagesTo], ['+961 71 014 463', 'whatsapp']);
  assert.equal(formToAnswers({ businessName: 'x', messagesTo: 'carrier pigeon' }).messagesTo, '');
  assert.ok(!a.locationAndContact.includes('961 71 014 463'), 'the model never sees it: it is not a fact it may rewrite');
  const { forBrief, delivery } = splitWishes({ businessName: 'Cafe', whatsapp: '+961 71 014 463', messagesTo: 'whatsapp' });
  assert.equal('whatsapp' in forBrief || 'messagesTo' in forBrief, false);
  assert.deepEqual(delivery, { whatsapp: '96171014463', contactMethod: 'whatsapp' });
  assert.deepEqual(splitWishes({ businessName: 'x', whatsapp: '71-014463' }).delivery, { whatsapp: '', contactMethod: '' }, 'a local number is dropped');
  const old = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/site-brief.json'), 'utf8'));
  delete old.business.contact.whatsapp; delete old.contactMethod;
  const parsed = siteBriefSchema.parse(old);
  assert.deepEqual([parsed.business.contact.whatsapp, parsed.contactMethod], ['', ''], 'an old brief still loads');
});

test('how a form delivers: the owner\'s choice first, then WhatsApp, then a service, then an email link, then nothing', () => {
  const svc = { endpoint: 'https://formspree.io/f/x' };
  assert.deepEqual(deliveryMode({ whatsapp: '96171014463', email: 'a@b.co', service: svc }), { mode: 'whatsapp', digits: '96171014463' }, 'WhatsApp needs no server, so it comes first');
  assert.deepEqual(deliveryMode({ method: 'email', whatsapp: '96171014463', email: 'a@b.co', service: svc }), { mode: 'service' }, 'the owner chose email: the service');
  assert.deepEqual(deliveryMode({ method: 'email', whatsapp: '96171014463', email: 'a@b.co', service: null }), { mode: 'email' }, 'the owner chose email, no service yet: an email link');
  assert.deepEqual(deliveryMode({ method: 'email', whatsapp: '96171014463', email: '', service: null }), { mode: 'whatsapp', digits: '96171014463' }, 'the chosen way is impossible: the other one');
  assert.deepEqual(deliveryMode({ method: 'whatsapp', whatsapp: '', email: 'a@b.co', service: svc }), { mode: 'service' }, 'chose WhatsApp but has no valid number');
  assert.deepEqual(deliveryMode({ email: 'a@b.co', service: null }), { mode: 'email' });
  assert.deepEqual(deliveryMode({ email: '', service: null }), { mode: 'removed' });
  assert.deepEqual(deliveryMode({ whatsapp: '071014463', email: '', service: null }), { mode: 'removed' }, 'a local number is not enough');
});

test('a WhatsApp form posts nowhere: every field is named and headed, there is a spam trap and a status line, the script is loaded', () => {
  const r = connectWhatsApp(FORM, { digits: '96171014463', messages });
  assert.equal(r.mode, 'whatsapp');
  const open = r.html.match(/<form\b[^>]*>/)[0];
  assert.match(open, /data-features="whatsapp" data-wa="96171014463"/);
  assert.ok(!/\saction=|\smethod=/.test(open), 'no action, no method');
  assert.match(open, /data-success="Opening WhatsApp\.\.\."/);
  assert.match(r.html, /data-label="Your name"/, 'the label text heads the line');
  assert.match(r.html, /data-label="Phone"/);
  assert.match(r.html, /data-label="What would you like\?"/, 'the placeholder heads a field without a label');
  assert.ok(r.html.includes(`name="${HONEYPOT}"`) && !r.html.includes(`name="${HONEYPOT}" data-label`), 'the spam trap has no heading');
  assert.ok(r.html.includes('data-form-status') && r.html.includes('<script src="/form.js" defer></script>'));
  assert.equal(connectWhatsApp(r.html, { digits: '96171014463', messages }).already, true, 'once is enough');
});

test('the script opens the owner\'s WhatsApp with the message filled in, and keeps bots out', async () => {
  const handlers = {}; const opened = []; let clock = 1000;
  const status = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const fields = [
    { name: 'name', value: 'Sara', type: 'text', getAttribute: () => 'Your name' },
    { name: 'message', value: 'A gift box for Eid', type: 'textarea', getAttribute: () => 'What would you like?' },
    { name: 'phone', value: '', type: 'tel', getAttribute: () => 'Phone' },
    { name: HONEYPOT, value: '', type: 'text', getAttribute: () => null },
    { name: 'access_key', value: 'x', type: 'hidden', getAttribute: () => null },
  ];
  const form = { action: '', parentNode: { querySelector: () => status }, getAttribute: (k) => ({ 'data-wa': '96171014463', 'data-success': 'Opening WhatsApp...', 'data-error': 'Sorry.' })[k], querySelector: (s) => (s.includes(HONEYPOT) ? fields[3] : null), querySelectorAll: () => fields, addEventListener: (e, fn) => { handlers[e] = fn; }, reset() {} };
  const sandbox = { document: { querySelectorAll: () => [form] }, Array, Date: { now: () => clock }, FormData: class {}, fetch: async () => { throw new Error('a WhatsApp form must not send anything'); }, Promise, window: { open: (...a) => opened.push(a) } };
  new Function(...Object.keys(sandbox), FORM_JS)(...Object.values(sandbox));
  const submit = async (t) => { clock = t; await handlers.submit({ preventDefault() {} }); };
  await submit(5000);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'https://wa.me/96171014463?text=Your%20name%3A%20Sara%0AWhat%20would%20you%20like%3F%3A%20A%20gift%20box%20for%20Eid', 'the empty field, the trap and the hidden key are not in the message');
  assert.deepEqual([opened[0][1], opened[0][2]], ['_blank', 'noopener']);
  assert.deepEqual([status.textContent, status.attrs['data-ok']], ['Opening WhatsApp...', 'true']);
  fields[3].value = 'spam'; await submit(9000);
  assert.equal(opened.length, 1, 'a bot opens nothing');
  fields[3].value = ''; await submit(1200);
  assert.equal(opened.length, 1, 'too fast to be a person');
});

function makeProject(contact, extra = {}) {
  const brief = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/site-brief.json'), 'utf8'));
  brief.features = [{ type: 'contact-form' }];
  brief.business.contact = { phone: '', email: '', address: '', hours: '', whatsapp: '', ...contact };
  Object.assign(brief, extra);
  const content = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/content-spec.json'), 'utf8'));
  fs.mkdirSync(projectPath('p1', 'site/src/content'), { recursive: true });
  fs.writeFileSync(projectPath('p1', 'site-brief.json'), JSON.stringify(brief));
  fs.writeFileSync(projectPath('p1', 'content-spec.json'), JSON.stringify(content));
  fs.writeFileSync(projectPath('p1', 'site/src/content/contact.html'), FORM);
  fs.writeFileSync(projectPath('p1', 'site/site-report.json'), JSON.stringify({ forms: 1 }));
}

test('the stage with a WhatsApp number: the form opens WhatsApp, no service is needed, the checks pass; a bad number fails them', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  setProjectsRoot(tmp);
  try {
    makeProject({ whatsapp: '96171014463', email: 'hi@cafe.com' });
    const report = applyFeatures('p1', { service: null });
    assert.equal(report.form, 'whatsapp');
    const html = fs.readFileSync(projectPath('p1', 'site/src/content/contact.html'), 'utf8');
    assert.match(html, /data-features="whatsapp" data-wa="96171014463"/);
    assert.ok(fs.existsSync(projectPath('p1', 'site/public/form.js')));
    assert.deepEqual((await runChecks({ projectId: 'p1' })).filter((r) => !r.ok).map((r) => r.name), []);
    const bad = checkFeatures({ pages: [{ slug: 'contact', html: html.replace('data-wa="96171014463"', 'data-wa="12"') }], brief: { features: [], business: { contact: { address: '' } } }, report: {}, publicFiles: ['form.js'] }).find((r) => r.name.startsWith('connected forms'));
    assert.match(bad.details, /not international/);
    // the owner chose email and has a form service: the service is used even though a WhatsApp number exists
    makeProject({ whatsapp: '96171014463', email: 'hi@cafe.com' }, { contactMethod: 'email' });
    assert.equal(applyFeatures('p1', { service: { endpoint: 'https://formspree.io/f/x' } }).form, 'connected');
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
