// Anthropic wrapper: askText, askJson (validated, one retry), askVision (images + JSON).
// Every call is recorded in the cost log.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config, requireKey } from '../config.js';
import { logCall } from './costLog.js';

const JSON_RULE = 'Answer with a single valid JSON value only. No explanations, no markdown, no code fences.';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic limit per image
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

let client;
// tests give the module a fake client (no API call, no cost)
export const setClientForTests = (fake) => { client = fake; };
function getClient() {
  if (!client) client = new Anthropic({ apiKey: requireKey('anthropic') });
  return client;
}

// Sends messages, logs cost and time. Returns { text, truncated }: truncated is true when the answer hit the length limit (it is cut off).
async function callModel({ projectId, stage, system, messages, maxTokens }) {
  const started = Date.now();
  const params = { model: config.anthropicModel, max_tokens: maxTokens, system, messages };
  const api = getClient().messages;
  // Streamed: a long answer (the retry after a cut-off asks for up to 32000 tokens) is refused by the SDK as a plain request. The fake client of the tests only has create().
  const response = typeof api.stream === 'function' ? await api.stream(params).finalMessage() : await api.create(params);
  logCall({
    projectId,
    stage,
    model: config.anthropicModel,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    durationMs: Date.now() - started,
  });
  return { text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), truncated: response.stop_reason === 'max_tokens' };
}

// An answer that was cut off by the limit is not asked to "fix its JSON" (it would be cut off again): it is asked again with a bigger limit.
export const MAX_TOKENS_CEILING = 32000;
async function callUntilComplete(args) {
  let answer = await callModel(args);
  if (answer.truncated && args.maxTokens < MAX_TOKENS_CEILING) answer = await callModel({ ...args, maxTokens: Math.min(args.maxTokens * 2, MAX_TOKENS_CEILING) });
  if (answer.truncated) throw new Error(`The model's answer is longer than the limit (${Math.min(args.maxTokens * 2, MAX_TOKENS_CEILING)} tokens) and was cut off. The task is too big for one answer: it must be split.`);
  return answer.text;
}

// Finds and parses JSON in a model answer: plain, inside ``` fences, or surrounded by extra text.
export function extractJson(text) {
  const t = text.trim();
  const candidates = [t];
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = t.search(/[{[]/);
  if (first >= 0) {
    const close = t[first] === '{' ? '}' : ']';
    const last = t.lastIndexOf(close);
    if (last > first) candidates.push(t.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('No valid JSON found in the model answer');
}

function describeIssues(error) {
  return error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

// One customer question of the website assistant: the stable system block (cached), the conversation, and a structured answer
// ({ category, reply }). Returns { text, usage, model, stopReason }. The model is CHAT_MODEL, or the project's ANTHROPIC_MODEL.
export async function chatComplete({ system, messages, schema, maxTokens = 700, model = config.chatModel || config.anthropicModel }) {
  const response = await getClient().messages.create({
    model, max_tokens: maxTokens, system, messages,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } }, // a chat answer is short: low effort is quick and cheap
  });
  const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: response.usage ?? {}, model, stopReason: response.stop_reason };
}

export async function askText({ projectId, stage, system = '', prompt, maxTokens = 4096 }) {
  return (await callModel({ projectId, stage, system, messages: [{ role: 'user', content: prompt }], maxTokens })).text;
}

// Parse + validate. Returns { data } or { problem }.
function parseAndValidate(text, schema) {
  let json;
  try {
    json = extractJson(text);
  } catch (err) {
    return { problem: err.message };
  }
  const result = schema.safeParse(json);
  return result.success ? { data: result.data } : { problem: describeIssues(result.error) };
}

// Shared by askJson and askVision: ask, validate, retry once with the errors, then throw.
async function jsonLoop({ projectId, stage, system, content, schema, maxTokens }) {
  const fullSystem = `${system}\n\n${JSON_RULE}`.trim();
  const messages = [{ role: 'user', content }];
  const first = await callUntilComplete({ projectId, stage, system: fullSystem, messages, maxTokens });
  const firstTry = parseAndValidate(first, schema);
  if (firstTry.data !== undefined) return firstTry.data;

  messages.push(
    { role: 'assistant', content: first },
    { role: 'user', content: `Your JSON was not valid:\n${firstTry.problem}\n\nReturn the corrected JSON only.` },
  );
  const second = await callUntilComplete({ projectId, stage, system: fullSystem, messages, maxTokens });
  const secondTry = parseAndValidate(second, schema);
  if (secondTry.data !== undefined) return secondTry.data;
  throw new Error(`Model answer is still invalid after one retry:\n${secondTry.problem}`);
}

export async function askJson({ projectId, stage, system = '', prompt, schema, maxTokens = 8000 }) {
  return jsonLoop({ projectId, stage, system, content: prompt, schema, maxTokens });
}

// Builds the image block for a picture, or a document block for a PDF.
function imageBlock(imagePath) {
  if (path.extname(imagePath).toLowerCase() === '.pdf') {
    const bytes = fs.readFileSync(imagePath);
    if (bytes.length > MAX_PDF_BYTES) throw new Error(`PDF is over the 20 MB limit: ${imagePath}`);
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } };
  }
  const mediaType = MEDIA_TYPES[path.extname(imagePath).toLowerCase()];
  if (!mediaType) throw new Error(`Vision does not support this image type: ${imagePath} (use jpg, png, webp or gif)`);
  const bytes = fs.readFileSync(imagePath);
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(`Image is over the 5 MB limit: ${imagePath}. Resizing needs an image library (not added yet).`);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } };
}

// Like askVision, but also takes text files: files are PDFs and pictures (paths), texts are { name, text } the model reads as written.
export async function askFiles({ projectId, stage, system = '', prompt, files = [], texts = [], schema, maxTokens = 4000 }) {
  const content = [
    ...files.map((f) => imageBlock(f.path)),
    ...texts.map((t) => ({ type: 'text', text: `<file name="${t.name}">\n${t.text}\n</file>` })),
    { type: 'text', text: prompt },
  ];
  return jsonLoop({ projectId, stage, system, content, schema, maxTokens });
}

export async function askVision({ projectId, stage, system = '', prompt, images, schema, maxTokens = 4000 }) {
  const content = [...images.map((img) => imageBlock(img.path)), { type: 'text', text: prompt }];
  return jsonLoop({ projectId, stage, system, content, schema, maxTokens });
}
