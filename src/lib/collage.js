// Arranges several REAL photos into one picture (a row or a grid on a background color).
// Nothing is drawn, generated or cut out: every pixel comes from the customer's photos.

import sharp from 'sharp';

// "4:5" -> { width, height } with the long side at most `max` pixels
export function sizeFor(aspect, max = 1600) {
  const [w, h] = String(aspect || '4:3').split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 4 / 3;
  return ratio >= 1 ? { width: max, height: Math.round(max / ratio) } : { width: Math.round(max * ratio), height: max };
}

// The arrangement that suits a frame: wide frames get a row, tall frames a stack, squarish ones a grid.
export function bestLayout(n, aspect) {
  const [w, h] = String(aspect || '4:3').split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 4 / 3;
  if (ratio >= 1.3 && n <= 4) return 'row';
  if (ratio <= 0.8 && n <= 4) return 'column';
  return 'grid';
}

// Cell rectangles for n photos inside width x height, with a gap between them.
export function cells(n, layout, width, height, gap) {
  const cols = layout === 'row' ? n : layout === 'column' ? 1 : Math.ceil(Math.sqrt(n));
  const rows = layout === 'row' ? 1 : layout === 'column' ? n : Math.ceil(n / cols);
  const cw = Math.floor((width - gap * (cols + 1)) / cols);
  const ch = Math.floor((height - gap * (rows + 1)) / rows);
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols; // the last row is centered when it has fewer photos
    const col = i - row * cols;
    const offset = Math.floor(((cols - inRow) * (cw + gap)) / 2);
    return { left: gap + offset + col * (cw + gap), top: gap + row * (ch + gap), width: cw, height: ch };
  });
}

// files: absolute paths of the real photos. Returns { buffer, width, height } (a JPEG).
export async function composeCollage({ files, layout = 'row', aspect = '4:3', background = '#f4efe6', gap = 16 }) {
  if (files.length < 2) throw new Error('A collage needs at least 2 photos.');
  const { width, height } = sizeFor(aspect);
  const rects = cells(files.length, layout, width, height, gap);
  const layers = await Promise.all(files.map(async (file, i) => ({
    input: await sharp(file).rotate().resize(rects[i].width, rects[i].height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer(),
    left: rects[i].left,
    top: rects[i].top,
  })));
  const buffer = await sharp({ create: { width, height, channels: 3, background } }).composite(layers).jpeg({ quality: 88 }).toBuffer();
  return { buffer, width, height };
}
