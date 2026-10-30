// Tests for Stage 8 (features): the form, the map and the booking button (no network, no API calls).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nameFor, submitLabel, connectForm, formWithoutService, addMap, addBooking, messagesFor, DEFAULT_MESSAGES, FORM_JS, HONEYPOT } from '../src/stages/08-features/forms.js';
import { applyFeatures, formService } from '../src/stages/08-features/index.js';
import { checkFeatures, runChecks } from '../src/stages/08-features/checks.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { config } from '../src/config.js';

const FORM = `<main><section><form class="space-y-4" onsubmit="return false" action="#"><input type="text" placeholder="Your name" class="a"/><input type="email" placeholder="Email address"/><input type="tel" placeholder="Phone"/><textarea placeholder="Tell us what you need"></textarea><select><option>One</option></select><button class="btn rounded-full"><span class="material-symbols-outlined">send</span> Send message</button></form></section></main>`;
const service = { endpoint: 'https://formspree.io/f/abc123' };
const messages = { success: 'Thank you! We will reply soon.', error: 'Sorry, it did not send. Please call us.' };

test('fields get names the service understands; the button text is read without icon names', () => {
  assert.equal(nameFor('<input type="email" placeholder="Email address">', 0), 'email');
  assert.equal(nameFor('<input type="tel">', 1), 'phone');
  assert.equal(nameFor('textarea <textarea placeholder="Tell us">', 2), 'message');
  assert.equal(nameFor('<input type="text" placeholder="Your name">', 3), 'name');
  assert.equal(nameFor('<input type="text" name="custom">', 4), 'custom');
  assert.equal(nameFor('<input type="text">', 5), 'field-6');
  assert.equal(submitLabel('<button class="x"><span class="material-symbols-outlined">send</span> Send message</button>'), 'Send message');
});

test('a form is connected: posts to the service, every field named, spam trap, messages, status line, sender script', () => {
  const r = connectForm(FORM, { service, messages });
  assert.equal(r.connected, true);
  assert.deepEqual(r.fields, ['name', 'email', 'phone', 'message', 'field-5']);
  const open = r.html.match(/<form\b[^>]*>/)[0];
  assert.match(open, /action="https:\/\/formspree.io\/f\/abc123"/);
  assert.match(open, /method="POST"/);
  assert.ok(!/onsubmit/.test(open) && !/action="#"/.test(open), 'the old dead action and onsubmit are gone');
  assert.match(open, /data-success="Thank you! We will reply soon."/);
  assert.match(open, /data-error="Sorry, it did not send. Please call us."/);
  assert.ok(r.html.includes(`name="${HONEYPOT}"`) && r.html.includes('data-form-status') && r.html.includes('<script src="/form.js" defer></script>'));
  assert.match(r.html, /<button type="submit" class="btn rounded-full">/);
  assert.equal([...r.html.matchAll(/<(input|textarea|select)\b[^>]*>/g)].filter((m) => !/type="(submit|hidden)"/.test(m[0]) && !/name="/.test(m[0])).length, 0, 'no unnamed field is left');
  // the access key of services that need one is a hidden field
  assert.match(connectForm(FORM, { service: { ...service, accessKey: 'key<1>' }, messages }).html, /<input type="hidden" name="access_key" value="key&lt;1>">/);
  // running it twice changes nothing more
  const twice = connectForm(r.html, { service, messages });
  assert.equal(twice.already, true);
  assert.equal(twice.html, r.html);
  assert.deepEqual(connectForm('<main>no form</main>', { service, messages }), { html: '<main>no form</main>', connected: false, fields: [], found: false });
});

test('no form service: the form becomes an email link with the button\'s own text, or is removed when there is no email', () => {
  const withMail = formWithoutService(FORM, { email: 'hi@cafe.com' });
  assert.equal(withMail.replaced, 'email');
  assert.match(withMail.html, /<a data-features="mailto" class="btn rounded-full inline-block text-center" href="mailto:hi@cafe.com">Send message<\/a>/);
  assert.ok(!/<form/.test(withMail.html));
  const none = formWithoutService(FORM, { email: '' });
  assert.equal(none.replaced, 'removed');
  assert.ok(!/<form|<button/.test(none.html));
  assert.equal(formWithoutService('<p>x</p>', { email: 'a@b.c' }).replaced, null);
});

test('a map from the address and a booking button from the link, once each', () => {
  const map = addMap('<main><p>x</p></main>', { address: '12 Nile St, Cairo' });
  assert.equal(map.added, true);
  assert.match(map.html, /src="https:\/\/www.google.com\/maps\?q=12%20Nile%20St%2C%20Cairo&amp;output=embed"/);
  assert.match(map.html, /title="12 Nile St, Cairo"/);
  assert.equal(addMap(map.html, { address: '12 Nile St, Cairo' }).added, false, 'not twice');
  assert.equal(addMap('<main></main>', { address: '' }).added, false);
  const book = addBooking('<main></main>', { url: 'https://calendly.com/cafe', language: 'ar' });
  assert.match(book.html, /href="https:\/\/calendly.com\/cafe" target="_blank" rel="noopener noreferrer"[^>]*>احجز الآن</);
  assert.equal(addBooking(book.html, { url: 'https://calendly.com/cafe' }).added, false);
  assert.equal(addBooking('<main><a href="https://calendly.com/cafe">Book</a></main>', { url: 'https://calendly.com/cafe' }).added, false, 'the copy already links to it');
  assert.equal(addBooking('<main></main>', { url: 'javascript:alert(1)' }).added, false, 'only web links');
});

test('the sender script: sends without leaving the page, shows the copy\'s messages, drops bots, never claims success when the service refused', async () => {
  // a tiny fake page: just enough DOM for the script
  const handlers = {};
  const status = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const trap = { value: '' };
  const button = { disabled: false };
  const form = {
    action: 'https://formspree.io/f/abc', parentNode: { querySelector: () => status },
    getAttribute: (k) => ({ 'data-success': 'Thanks!', 'data-error': 'Sorry!' })[k],
    querySelector: (s) => (s.includes(HONEYPOT) ? trap : button), addEventListener: (e, fn) => { handlers[e] = fn; }, reset() { this.wasReset = true; },
  };
  let call = null; let answer = { ok: true };
  const sandbox = { document: { querySelectorAll: () => [form] }, Array, Date: { now: () => clock }, FormData: class { }, fetch: async (url, opts) => { call = { url, opts }; return answer; }, Promise };
  let clock = 1000;
  new Function(...Object.keys(sandbox), FORM_JS)(...Object.values(sandbox));
  const submit = async (t) => { clock = t; await handlers.submit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 5)); };
  await submit(3000);
  assert.equal(call.url, 'https://formspree.io/f/abc');
  assert.deepEqual([call.opts.method, call.opts.headers.Accept], ['POST', 'application/json']);
  assert.deepEqual([status.textContent, status.attrs['data-ok'], form.wasReset, button.disabled], ['Thanks!', 'true', true, false]);
  answer = { ok: false, status: 500 }; call = null;
  await submit(9000);
  assert.deepEqual([status.textContent, status.attrs['data-ok']], ['Sorry!', 'false']);
  call = null; trap.value = 'http://spam.example'; answer = { ok: true };
  await submit(15000);
  assert.equal(call, null, 'a bot that fills the hidden field sends nothing');
  trap.value = ''; await submit(1100); // sent within 1.5 s of opening the page
  assert.equal(call, null, 'a form sent faster than a person can type sends nothing');
});

function makeProject(tmp, { features, contact = {}, withForm = true } = {}) {
  const brief = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/site-brief.json'), 'utf8'));
  brief.features = features ?? [{ type: 'contact-form' }];
  brief.business.contact = { phone: '', email: 'hi@cafe.com', address: '12 Nile St, Cairo', hours: '', ...contact };
  const content = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/demo-restaurant/content-spec.json'), 'utf8'));
  content.global.formMessages = messages;
  fs.mkdirSync(projectPath('p1', 'site/src/content'), { recursive: true });
  fs.writeFileSync(projectPath('p1', 'site-brief.json'), JSON.stringify(brief));
  fs.writeFileSync(projectPath('p1', 'content-spec.json'), JSON.stringify(content));
  fs.writeFileSync(projectPath('p1', 'site/src/content/home.html'), '<main><h1>Home</h1></main>');
  fs.writeFileSync(projectPath('p1', 'site/src/content/contact.html'), withForm ? FORM : '<main><h1>Contact</h1></main>');
  fs.writeFileSync(projectPath('p1', 'site/site-report.json'), JSON.stringify({ forms: withForm ? 1 : 0, pages: [] }));
}
const page = (slug) => fs.readFileSync(projectPath('p1', `site/src/content/${slug}.html`), 'utf8');

test('the stage with a form service: the form is connected, the map and the booking button are added to the contact page, the report says so', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'));
  setProjectsRoot(tmp);
  try {
    makeProject(tmp, { features: [{ type: 'contact-form' }, { type: 'map-embed' }, { type: 'booking-embed', url: 'https://calendly.com/cafe' }] });
    const report = applyFeatures('p1', { service });
    assert.deepEqual([report.form, report.map, report.booking], ['connected', 'added on /contact/', 'added on /contact/']);
    assert.match(page('contact'), /data-features="form"/);
    assert.match(page('contact'), /data-features="map"/);
    assert.match(page('contact'), /data-features="booking"/);
    assert.ok(!page('home').includes('data-features'), 'the home page is untouched');
    assert.equal(fs.readFileSync(projectPath('p1', 'site/public/form.js'), 'utf8'), FORM_JS);
    const site = JSON.parse(fs.readFileSync(projectPath('p1', 'site/site-report.json'), 'utf8'));
    assert.deepEqual([site.forms, site.features.form], [0, 'connected']);
    const results = await runChecks({ projectId: 'p1' });
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.name), []);
    // applying it again changes nothing
    const before = page('contact');
    applyFeatures('p1', { service });
    assert.equal(page('contact'), before);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the stage without a form service: no dead form is ever left; features without their data are skipped and reported', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'));
  setProjectsRoot(tmp);
  try {
    makeProject(tmp, { features: [{ type: 'contact-form' }, { type: 'map-embed' }, { type: 'booking-embed' }], contact: { address: '' } });
    const report = applyFeatures('p1', { service: null });
    assert.deepEqual([report.form, report.map, report.booking], ['email-link', 'skipped: the owner gave no address', 'skipped: the owner gave no booking link']);
    assert.ok(!/<form/.test(page('contact')) && /href="mailto:hi@cafe.com"/.test(page('contact')));
    assert.ok(!fs.existsSync(projectPath('p1', 'site/public/form.js')), 'no sender script when there is no form');
    const results = await runChecks({ projectId: 'p1' });
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.name), [], 'an email link instead of a form is fine');
    const info = results.find((r) => r.name.includes('could not be added'));
    assert.match(info.details, /form: email-link/);
    assert.match(info.details, /map: skipped/);
    // no email either: the form disappears
    makeProject(tmp, { contact: { email: '' } });
    assert.equal(applyFeatures('p1', { service: null }).form, 'removed');
    assert.ok(!/<form|<button/.test(page('contact')));
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('where the form service comes from: the project\'s own form.json first, then .env; only https addresses are accepted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'));
  setProjectsRoot(tmp);
  try {
    fs.mkdirSync(projectPath('p1'), { recursive: true });
    config.formEndpoint = ''; config.formAccessKey = '';
    assert.equal(formService('p1'), null);
    config.formEndpoint = 'https://formspree.io/f/shared'; config.formAccessKey = 'k1';
    assert.deepEqual(formService('p1'), { endpoint: 'https://formspree.io/f/shared', accessKey: 'k1' });
    fs.writeFileSync(projectPath('p1', 'form.json'), JSON.stringify({ endpoint: 'https://formspree.io/f/own' }));
    assert.deepEqual(formService('p1'), { endpoint: 'https://formspree.io/f/own', accessKey: 'k1' });
    fs.writeFileSync(projectPath('p1', 'form.json'), JSON.stringify({ endpoint: 'http://insecure.example/f' }));
    assert.equal(formService('p1'), null, 'an http address is refused');
    fs.writeFileSync(projectPath('p1', 'form.json'), '{ broken json');
    assert.equal(formService('p1').endpoint, 'https://formspree.io/f/shared', 'a broken file falls back to .env');
  } finally { config.formEndpoint = ''; config.formAccessKey = ''; setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the checks catch a loose form, a half-connected form, and a requested map or booking button that is missing', () => {
  const brief = { features: [{ type: 'map-embed' }, { type: 'booking-embed', url: 'https://calendly.com/cafe' }], business: { contact: { address: '12 Nile St' } } };
  const failed = (r) => r.filter((x) => !x.ok).map((x) => x.name);
  const loose = checkFeatures({ pages: [{ slug: 'contact', html: FORM }], brief, report: {}, publicFiles: [] });
  assert.ok(failed(loose).some((n) => n.includes('no dead form')));
  assert.ok(failed(loose).some((n) => n.includes('map')));
  assert.ok(failed(loose).some((n) => n.includes('booking')));
  const half = '<form action="http://x.example" data-features="form" data-success="" data-error=""><input type="text"><button type="submit">Send</button></form>';
  const bad = checkFeatures({ pages: [{ slug: 'contact', html: half }], brief: { features: [], business: { contact: { address: '' } } }, report: {}, publicFiles: [] }).find((r) => r.name.startsWith('connected forms'));
  assert.equal(bad.ok, false);
  for (const part of ['https address', 'POST', 'spam trap', 'no name', 'message is missing', 'form.js']) assert.match(bad.details, new RegExp(part === 'https address' ? 'https' : part), part);
});

test('a visitor always sees a message after sending: the copy\'s own, or a default in the site\'s language', () => {
  assert.deepEqual(messagesFor({ success: 'Thanks!', error: 'Oops' }, 'en'), { success: 'Thanks!', error: 'Oops' });
  assert.deepEqual(messagesFor(undefined, 'ar'), DEFAULT_MESSAGES.ar);
  assert.deepEqual(messagesFor({ success: '  ', error: '' }, 'fr'), DEFAULT_MESSAGES.fr, 'blank messages are replaced');
  assert.deepEqual(messagesFor({ success: 'Thanks!' }, 'xx'), { success: 'Thanks!', error: DEFAULT_MESSAGES.en.error }, 'an unknown language falls back to English');
  const tmpHtml = connectForm('<form><input type="text"><button>Go</button></form>', { service, messages: messagesFor(undefined, 'ar') }).html;
  assert.match(tmpHtml, /data-success="شكرًا لك! تم إرسال رسالتك."/);
});
