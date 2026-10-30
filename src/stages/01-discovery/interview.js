// Stage 1, step A: the terminal interview.
// Every answer is saved at once to inputs/answers.json, so a crash loses nothing and the
// interview resumes where it stopped. Use fromAnswers to skip the interview (tests).

import fs from 'node:fs';
import path from 'node:path';
import { input, checkbox } from '@inquirer/prompts';
import { z } from 'zod';
import { askJson } from '../../lib/llm.js';
import { projectPath, exists } from '../../lib/project.js';
import { log } from '../../lib/log.js';
import { CORE_QUESTIONS, FEATURE_CHOICES } from './questions.js';
import { SUGGEST_PAGES_SYSTEM, suggestPagesPrompt, FOLLOWUP_SYSTEM, followUpPrompt } from './prompts.js';

const ANSWERS = 'inputs/answers.json';
const STAGE = 'discovery';

const pagesSchema = z.object({ pages: z.array(z.string()).min(1) });
const followUpSchema = z.object({ questions: z.array(z.string()).max(5) });

function loadAnswers(projectId) {
  return exists(projectId, ANSWERS) ? JSON.parse(fs.readFileSync(projectPath(projectId, ANSWERS), 'utf8')) : {};
}

function saveAnswers(projectId, answers) {
  const file = projectPath(projectId, ANSWERS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(answers, null, 2) + '\n');
}

// Copies an existing answers file into the project (used by tests).
export function useAnswersFile(projectId, filePath) {
  const answers = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  saveAnswers(projectId, answers);
  log.info(STAGE, `Using answers from ${filePath}`);
}

async function askContact() {
  const phone = await input({ message: '   Phone:' });
  const email = await input({ message: '   Email:' });
  const address = await input({ message: '   Address / location:' });
  const hours = await input({ message: '   Opening hours:' });
  return [`Phone: ${phone}`, `Email: ${email}`, `Address: ${address}`, `Hours: ${hours}`].join('\n');
}

async function askPages(projectId, answers) {
  const { pages } = await askJson({
    projectId, stage: 'discovery-questions', system: SUGGEST_PAGES_SYSTEM, prompt: suggestPagesPrompt(answers), schema: pagesSchema, maxTokens: 500,
  });
  return input({ message: '7. Which pages do you want? (edit, separate with commas)', default: pages.join(', ') });
}

async function askFeatures() {
  const chosen = await checkbox({ message: '8. Which features do you want? (space to select)', choices: FEATURE_CHOICES });
  const result = [...chosen];
  if (chosen.includes('booking link')) {
    const url = await input({ message: '   Booking link URL (leave empty if you do not have one yet):' });
    if (url.trim()) result[result.indexOf('booking link')] = `booking link: ${url.trim()}`;
  }
  return result.join(', ');
}

async function askCore(question, projectId, answers) {
  if (question.type === 'contact') {
    console.log(question.message);
    return askContact();
  }
  if (question.type === 'pages') return askPages(projectId, answers);
  if (question.type === 'features') return askFeatures();
  return (await input({ message: question.message })).trim();
}

export async function interview(projectId) {
  const answers = loadAnswers(projectId);

  for (const question of CORE_QUESTIONS) {
    if (answers[question.key] !== undefined) continue;
    answers[question.key] = await askCore(question, projectId, answers);
    saveAnswers(projectId, answers);
  }

  if (!answers.followUpQuestions) {
    log.info(STAGE, 'Thinking about what is still missing...');
    const { questions } = await askJson({
      projectId, stage: 'discovery-followups', system: FOLLOWUP_SYSTEM, prompt: followUpPrompt(answers), schema: followUpSchema, maxTokens: 800,
    });
    answers.followUpQuestions = questions;
    answers.followUps = [];
    saveAnswers(projectId, answers);
  }

  while (answers.followUps.length < answers.followUpQuestions.length) {
    const question = answers.followUpQuestions[answers.followUps.length];
    const answer = await input({ message: `Follow-up: ${question}` });
    answers.followUps.push({ question, answer: answer.trim() });
    saveAnswers(projectId, answers);
  }

  log.info(STAGE, `Interview complete. Next: node src/cli.js brief --project ${projectId}`);
}
