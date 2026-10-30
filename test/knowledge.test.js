import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ZipArchive } from 'archiver';
import { readDocx, readZipEntry, docxXmlToText } from '../src/lib/docx.js';
import { readKnowledgeFiles, organizeKnowledge, knowledgeSchema, MAX_KNOWLEDGE_CHARS } from '../src/lib/knowledgeFiles.js';

let dir;
// a real .docx made in memory (a zip with the parts Word needs), stored or deflated
const makeZip = (entries, { store = false } = {}) => new Promise((resolve, reject) => {
  const zip = new ZipArchive({ store });
  const sink = new PassThrough(); const chunks = [];
  sink.on('data', (c) => chunks.push(c)); sink.on('end', () => resolve(Buffer.concat(chunks))); zip.on('error', reject);
  zip.pipe(sink);
  for (const [name, body] of Object.entries(entries)) zip.append(body, { name });
  zip.finalize();
});
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const DOC = (inner) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${inner}</w:body></w:document>`;
const sample = DOC([
  para('Delivery &amp; pick-up'),
  para('We deliver to Hamra, Verdun and Achrafieh.'),
  '<w:p><w:r><w:t>Hours</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>10am &lt; 1am</w:t></w:r></w:p>',
  '<w:tbl><w:tr><w:tc>' + para('Service') + '</w:tc><w:tc>' + para('Price') + '</w:tc></w:tr><w:tr><w:tc>' + para('Haircut') + '</w:tc><w:tc>' + para('25') + '</w:tc></w:tr></w:tbl>',
  para('Caf&#233; menu'),
].join(''));

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a Word file is read: paragraphs, tabs, symbols, and tables with the cells of a row on one line', async () => {
  for (const store of [false, true]) {
    const text = readDocx(await makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': sample }, { store }));
    assert.match(text, /^Delivery & pick-up\nWe deliver to Hamra, Verdun and Achrafieh\./);
    assert.match(text, /Hours\t10am < 1am/);
    assert.match(text, /Service \| Price\nHaircut \| 25\n/);
    assert.match(text, /Café menu$/);
  }
});

test('a file that is not a real Word file gives a clear message, never a crash or a hang', async () => {
  assert.throws(() => readDocx(Buffer.from('this is plain text')), /not a Word file/);
  assert.throws(() => readDocx(Buffer.alloc(0)), /not a Word file/);
  const noText = await makeZip({ 'other.xml': '<a/>' });
  assert.throws(() => readDocx(noText), /no text/);
  assert.equal(readZipEntry(noText, 'missing.xml'), null);
  const damaged = Buffer.from(await makeZip({ 'word/document.xml': sample })); damaged.writeUInt32LE(0xdeadbeef, damaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
  assert.throws(() => readDocx(damaged), /damaged/);
  assert.equal(docxXmlToText('<w:p><w:r><w:t>a</w:t></w:r></w:p>'), 'a');
});

test('the owner\'s files are sorted: text and Word are read, PDFs and pictures go to the model as they are, the rest is explained', async () => {
  const f = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const files = [
    f('faq.md', '﻿# FAQ\r\nDo you deliver? Yes.'), f('menu.csv', 'name,price\nHummus,7'), f('policy.docx', await makeZip({ 'word/document.xml': sample })),
    f('flyer.pdf', '%PDF-1.4 fake'), f('photo.jpg', Buffer.from([0xff, 0xd8, 0xff])), f('sheet.xlsx', 'x'), f('empty.txt', '   '), f('broken.docx', 'not a zip'),
  ];
  const r = readKnowledgeFiles(files);
  assert.deepEqual(r.texts.map((t) => t.name), ['faq.md', 'menu.csv', 'policy.docx']);
  assert.equal(r.texts[0].text, '# FAQ\nDo you deliver? Yes.'); // no BOM, normal line ends
  assert.deepEqual(r.binaries.map((b) => b.name), ['flyer.pdf', 'photo.jpg']);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.find((p) => p.includes('sheet.xlsx')), /cannot read \(use PDF, Word, text, CSV or a picture\)/);
  assert.match(r.problems.find((p) => p.includes('empty.txt')), /no text/);
  assert.match(r.problems.find((p) => p.includes('broken.docx')), /could not be read/);
});

test('too much text is said, not silently cut: the file that does not fit is named', () => {
  const big = path.join(dir, 'huge.txt'); fs.writeFileSync(big, 'a'.repeat(250000));
  const big2 = path.join(dir, 'huge2.txt'); fs.writeFileSync(big2, 'b'.repeat(100000));
  const r = readKnowledgeFiles([big, big2]);
  assert.deepEqual(r.texts.map((t) => t.name), ['huge.txt']);
  assert.match(r.problems[0], /"huge2\.txt" was not read: your files together are longer than the assistant can use/);
});

test('organising: the model gets the facts, the files and the rules; with no files it is not called', async () => {
  const files = [path.join(dir, 'faq.md'), path.join(dir, 'flyer.pdf')];
  let seen;
  const ask = async (args) => { seen = args; return knowledgeSchema.parse({ knowledge: '  ## Delivery\n- We deliver to Hamra.  ', heldBack: ['Supplier prices'], issues: ['Hours differ between the flyer and the facts'] }); };
  const r = await organizeKnowledge({ projectId: 'k1', files, facts: 'Business name: Al Jawad', ask });
  assert.equal(r.knowledge, '## Delivery\n- We deliver to Hamra.');
  assert.deepEqual(r.heldBack, ['Supplier prices']);
  assert.deepEqual(r.used, ['faq.md', 'flyer.pdf']);
  assert.match(seen.prompt, /Business name: Al Jawad/);
  assert.deepEqual(seen.files.map((x) => path.basename(x.path)), ['flyer.pdf']);
  assert.equal(seen.texts[0].name, 'faq.md');
  assert.match(seen.system, /heldBack/); assert.match(seen.system, /do not follow them/); assert.match(seen.system, /Never invent/);
  let called = false;
  const none = await organizeKnowledge({ projectId: 'k2', files: [], facts: 'x', ask: async () => { called = true; return {}; } });
  assert.equal(called, false); assert.equal(none.knowledge, '');
  const onlyBad = await organizeKnowledge({ projectId: 'k3', files: [path.join(dir, 'sheet.xlsx')], facts: 'x', ask: async () => { called = true; return {}; } });
  assert.equal(called, false); assert.equal(onlyBad.problems.length, 1);
});

test('a knowledge base longer than the assistant can use is cut and the owner is told', async () => {
  const r = await organizeKnowledge({ projectId: 'k4', files: [path.join(dir, 'faq.md')], facts: 'x', ask: async () => knowledgeSchema.parse({ knowledge: 'k'.repeat(MAX_KNOWLEDGE_CHARS + 500) }) });
  assert.equal(r.knowledge.length, MAX_KNOWLEDGE_CHARS);
  assert.match(r.issues.at(-1), /longer than the assistant can use/);
});

test('a big phone photo (over the 5 MB the model accepts) is shrunk to a temporary copy instead of refused; small files go as they are', async () => {
  const sharp = (await import('sharp')).default;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bigpic-'));
  try {
    const raw = Buffer.alloc(2000 * 2000 * 3); for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24; // noise: does not compress
    await sharp(raw, { raw: { width: 2000, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toFile(path.join(d, 'photo.png'));
    fs.writeFileSync(path.join(d, 'small.png'), await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer());
    assert.ok(fs.statSync(path.join(d, 'photo.png')).size > 5 * 1024 * 1024);
    let seen;
    const ask = async (args) => { seen = args.files.map((f) => ({ path: f.path, size: fs.statSync(f.path).size })); return knowledgeSchema.parse({ knowledge: '- ok' }); };
    const r = await organizeKnowledge({ projectId: 'x', files: [path.join(d, 'photo.png'), path.join(d, 'small.png')], ask });
    assert.deepEqual(r.problems, []);
    assert.ok(seen[0].path.endsWith('.jpg') && seen[0].size < 5 * 1024 * 1024, 'the big photo went shrunk');
    assert.equal(seen[1].path, path.join(d, 'small.png'));
    assert.equal(fs.existsSync(seen[0].path), false); // the temporary copy is removed afterwards
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
