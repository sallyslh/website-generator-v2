// Golden files: approved stage outputs, frozen in test-businesses/<name>/golden/.
// They are the fixed inputs used to test the next stage in isolation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath } from './project.js';
import { getStage } from '../stages/index.js';

export const BUSINESSES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-businesses');

export const goldenDir = (business, root = BUSINESSES_ROOT) => path.join(root, business, 'golden');

// Copies stage n's output files from a project into the business's golden folder.
export function freezeStage(n, projectId, business, { root = BUSINESSES_ROOT } = {}) {
  const { outputs } = getStage(n);
  const copied = [];
  for (const file of outputs) {
    const from = projectPath(projectId, file);
    if (!fs.existsSync(from)) throw new Error(`Cannot freeze stage ${n}: ${file} is missing in project "${projectId}".`);
    const to = path.join(goldenDir(business, root), file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    copied.push(file);
  }
  return copied;
}

// Copies the golden outputs of every registered stage before `n` into a project.
export function loadGolden(business, projectId, n, { root = BUSINESSES_ROOT, stageNumbers } = {}) {
  for (const k of stageNumbers.filter((s) => s < n)) {
    for (const file of getStage(k).outputs) {
      const from = path.join(goldenDir(business, root), file);
      if (!fs.existsSync(from))
        throw new Error(`Golden file ${file} is missing for "${business}". Run stage ${k}, then: node src/cli.js freeze ${k} --project <id>`);
      const to = projectPath(projectId, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
