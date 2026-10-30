// Read/write JSON files inside projects/<id>/ with schema validation.
// writeJson never saves invalid data and keeps the previous version as <name>.prev.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from '../schemas/index.js';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../projects');
let projectsRoot = defaultRoot;

// Lets tests and the `validate --root` option point at another folder (e.g. test/fixtures).
export function setProjectsRoot(dir) {
  projectsRoot = path.resolve(dir);
}

export function projectPath(id, ...parts) {
  return path.join(projectsRoot, id, ...parts);
}

export function exists(id, file) {
  return fs.existsSync(projectPath(id, file));
}

function formatErrors(result) {
  return result.error.issues
    .map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

export function readJson(id, file, schema) {
  const full = projectPath(id, file);
  if (!fs.existsSync(full)) {
    const creator = FILES[file]?.stage;
    throw new Error(`Missing ${file} in project "${id}".${creator ? ` It is created by ${creator}.` : ''}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (!schema) return raw;
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`${file} is invalid:\n${formatErrors(result)}`);
  return result.data;
}

export function writeJson(id, file, data, schema) {
  let toSave = data;
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) throw new Error(`Refusing to save ${file}, data is invalid:\n${formatErrors(result)}`);
    toSave = result.data;
  }
  const full = projectPath(id, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (fs.existsSync(full)) fs.copyFileSync(full, full.replace(/\.json$/, '.prev.json'));
  fs.writeFileSync(full, JSON.stringify(toSave, null, 2) + '\n');
  return full;
}
