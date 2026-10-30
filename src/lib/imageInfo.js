// Reads image width/height/orientation from file bytes (png, jpg, webp, svg) without a library.
// JPEG EXIF rotation is respected (phone photos taken in portrait are often stored sideways).

function exifOrientation(b, start, end) {
  try {
    const little = b.toString('latin1', start, start + 2) === 'II';
    const r16 = (o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const r32 = (o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const ifd = start + r32(start + 4);
    const count = r16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) break;
      if (r16(entry) === 0x0112) return r16(entry + 8);
    }
  } catch {
    // ignore broken EXIF
  }
  return 1;
}

function jpegSize(b) {
  let offset = 2;
  let orientation = 1;
  while (offset + 4 < b.length) {
    if (b[offset] !== 0xff) { offset++; continue; }
    const marker = b[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = b.readUInt16BE(offset + 2);
    if (marker === 0xe1 && b.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0')
      orientation = exifOrientation(b, offset + 10, offset + 2 + length);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = b.readUInt16BE(offset + 5);
      const width = b.readUInt16BE(offset + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    offset += 2 + length;
  }
  throw new Error('Could not read JPEG size');
}

function pngSize(b) {
  if (b.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG file');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('Not a WebP file');
  const format = b.toString('latin1', 12, 16);
  if (format === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (format === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  throw new Error('Unknown WebP format');
}

function svgSize(b) {
  const text = b.toString('utf8', 0, 4000);
  const viewBox = text.match(/viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  const w = text.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
  const h = text.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
  const width = Math.round(Number(w?.[1] ?? viewBox?.[1] ?? 100));
  const height = Math.round(Number(h?.[1] ?? viewBox?.[2] ?? 100));
  return { width: width || 100, height: height || 100 };
}

export function orientationOf({ width, height }) {
  if (width > height * 1.05) return 'landscape';
  if (height > width * 1.05) return 'portrait';
  return 'square';
}

// ext: ".jpg" | ".jpeg" | ".png" | ".webp" | ".svg"  ->  { width, height, orientation }
export function readImageInfo(buffer, ext) {
  const readers = { '.jpg': jpegSize, '.jpeg': jpegSize, '.png': pngSize, '.webp': webpSize, '.svg': svgSize };
  const read = readers[ext.toLowerCase()];
  if (!read) throw new Error(`Unsupported image type ${ext}`);
  const size = read(buffer);
  return { ...size, orientation: orientationOf(size) };
}
