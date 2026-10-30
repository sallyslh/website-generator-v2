// Reads the text of a Word file (.docx). A .docx is a zip with word/document.xml inside; Node can unzip but has no zip reader, so this is a
// small one (central directory + inflate), with limits against zip bombs. No dependency, no AI.

import zlib from 'node:zlib';

const MAX_ENTRIES = 5000;
const MAX_XML_BYTES = 25 * 1024 * 1024;

// The bytes of one file inside a zip, or null. Throws on a damaged or unsafe zip.
export function readZipEntry(buffer, wanted) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('This is not a Word file (it is not a zip).');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('This Word file has too many parts.');
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('This Word file is damaged.');
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28); const extraLength = buffer.readUInt16LE(pos + 30); const commentLength = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (size > MAX_XML_BYTES) throw new Error('This Word file is too large to read.');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('This Word file is damaged.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
    throw new Error('This Word file uses a compression we cannot read.');
  }
  return null;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// The text of word/document.xml: paragraphs on their own lines, table cells joined by " | ", tabs and line breaks kept.
export function docxXmlToText(xml) {
  const cells = xml.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => `${cell.replace(/<\/w:p>/g, ' ').replace(/<w:(?:br|cr)\b[^>]*\/>/g, ' ')}\u0001`); // a cell is one piece, however many paragraphs it has
  return decode(cells
    .replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]*\u0001[ \t]*/g, ' | ')
    .replace(/ \| (?=\n|$)/g, '') // the last cell of a row has no bar after it
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function readDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('This Word file has no text in it.');
  return docxXmlToText(xml.toString('utf8'));
}
