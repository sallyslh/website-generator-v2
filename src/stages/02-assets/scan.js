// Finds the customer's files in inputs/assets/ and computes hash and size info with plain code.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectPath } from '../../lib/project.js';
import { readImageInfo } from '../../lib/imageInfo.js';

export const RASTER = ['.jpg', '.jpeg', '.png', '.webp'];
export const SUPPORTED = [...RASTER, '.svg', '.pdf'];
// A PDF, or a picture of a menu or price list (uploaded as document-<name>): read for facts, never used as a photo of the website.
export const isDocument = (file) => file.ext === '.pdf' || /^document-/i.test(file.name);
const ASSETS_DIR = 'inputs/assets';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// Returns { files: [{ rel, abs, name, ext, hash, bytes, info? }], skipped: [names] } sorted by path.
export function scanAssets(projectId) {
  const root = projectPath(projectId, ASSETS_DIR);
  if (!fs.existsSync(root)) return { files: [], skipped: [] };
  const files = [];
  const skipped = [];
  for (const abs of walk(root).sort()) {
    const ext = path.extname(abs).toLowerCase();
    const name = path.basename(abs);
    if (!SUPPORTED.includes(ext)) {
      skipped.push(name);
      continue;
    }
    const buffer = fs.readFileSync(abs);
    const file = {
      abs,
      name,
      ext,
      bytes: buffer.length,
      rel: `${ASSETS_DIR}/${path.relative(root, abs).split(path.sep).join('/')}`,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
    if (ext !== '.pdf') file.info = readImageInfo(buffer, ext);
    files.push(file);
  }
  return { files, skipped };
}
