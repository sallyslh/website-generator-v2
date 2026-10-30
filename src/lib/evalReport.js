// Evaluation helpers: runs a stage's automatic checks, asks the human scorecard,
// and appends one result row to evals/stage-0n.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { input, number } from '@inquirer/prompts';

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../evals');

const HEADER =
  '| Date | Project | Mode | Auto checks | Scores | Average | Comments | Cost |\n' +
  '|---|---|---|---|---|---|---|---|\n';

// Prints pass/fail per check. Returns { passed, total }.
export function printChecks(results) {
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.details ? ` - ${r.details}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${passed}/${results.length} automatic checks passed`);
  return { passed, total: results.length };
}

// Asks each question, scored 1-5 with an optional comment. Returns { scores, comments }.
export async function askScorecard(questions) {
  const scores = [];
  const comments = [];
  for (const [i, question] of questions.entries()) {
    const score = await number({ message: `${i + 1}. ${question} (1-5)`, min: 1, max: 5, step: 1, required: true });
    const comment = await input({ message: '   Comment (optional):' });
    scores.push(score);
    if (comment.trim()) comments.push(`${i + 1}: ${comment.trim()}`);
  }
  return { scores, comments };
}

export const average = (scores) => (scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0);

export function appendRow(n, { project, mode, checks, scores, comments, cost }) {
  fs.mkdirSync(EVALS_DIR, { recursive: true });
  const file = path.join(EVALS_DIR, `stage-${String(n).padStart(2, '0')}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Stage ${n} evaluations\n\n${HEADER}`);
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
  const row = [
    new Date().toISOString().slice(0, 10),
    project,
    mode,
    `${checks.passed}/${checks.total}`,
    scores.join(', '),
    average(scores).toFixed(1),
    comments.join('; '),
    cost,
  ].map(cell);
  fs.appendFileSync(file, `| ${row.join(' | ')} |\n`);
  return file;
}
