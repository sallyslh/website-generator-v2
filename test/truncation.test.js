// An answer cut off by the length limit is asked again with a bigger limit (no "invalid JSON" failure), and an impossible one says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { askJson, setClientForTests, MAX_TOKENS_CEILING } from '../src/lib/llm.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

const fake = (answers) => { const calls = []; return { calls, messages: { create: async (req) => { calls.push(req.max_tokens); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return { content: [{ type: 'text', text: a.text }], stop_reason: a.stop, usage: { input_tokens: 1, output_tokens: 1 } }; } } }; };
const schema = z.object({ items: z.array(z.string()) });

test('a cut-off answer is asked again with twice the limit; the complete answer is used', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-')); setProjectsRoot(tmp); fs.mkdirSync(projectPath('p', ''), { recursive: true });
  try {
    const client = fake([{ text: '{"items": ["a", "b', stop: 'max_tokens' }, { text: '{"items": ["a", "b", "c"]}', stop: 'end_turn' }]);
    setClientForTests(client);
    const out = await askJson({ projectId: 'p', stage: 'test', prompt: 'x', schema, maxTokens: 1000 });
    assert.deepEqual(out.items, ['a', 'b', 'c']);
    assert.deepEqual(client.calls, [1000, 2000], 'one more call, with a bigger limit, and no "fix your JSON" round');
  } finally { setClientForTests(undefined); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('an answer that is too long even for the biggest limit says so plainly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-')); setProjectsRoot(tmp); fs.mkdirSync(projectPath('p', ''), { recursive: true });
  try {
    setClientForTests(fake([{ text: '{"items": ["a', stop: 'max_tokens' }]));
    await assert.rejects(askJson({ projectId: 'p', stage: 'test', prompt: 'x', schema, maxTokens: MAX_TOKENS_CEILING / 2 }), /longer than the limit/);
  } finally { setClientForTests(undefined); setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a real client is called with streaming (long answers are refused as plain requests), a client without it with create()', async () => {
  const { askText, setClientForTests } = await import('../src/lib/llm.js');
  const usage = { input_tokens: 1, output_tokens: 1 };
  const answer = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
  let used = '';
  setClientForTests({ messages: { stream: (p) => { used = `stream ${p.max_tokens}`; return { finalMessage: async () => answer }; } } });
  assert.equal(await askText({ projectId: 'llm-stream-test', stage: 'test', prompt: 'hi', maxTokens: 30000 }), 'ok');
  assert.equal(used, 'stream 30000');
  setClientForTests({ messages: { create: async () => { used = 'create'; return answer; } } });
  assert.equal(await askText({ projectId: 'llm-stream-test', stage: 'test', prompt: 'hi' }), 'ok');
  assert.equal(used, 'create');
  setClientForTests(undefined);
});
