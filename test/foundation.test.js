// Unit tests for the Phase 0 tools (no API calls): JSON extraction, cost log, golden files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJson } from '../src/lib/llm.js';
import { logCall, readCostLog, summarize, totalOf } from '../src/lib/costLog.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';
import { freezeStage, loadGolden } from '../src/lib/golden.js';
import { registerStage, STAGES } from '../src/stages/index.js';
import { appendRow } from '../src/lib/evalReport.js';

test('extractJson: plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: inside code fences', () => {
  assert.deepEqual(extractJson('```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
});

test('extractJson: extra text around the JSON', () => {
  assert.deepEqual(extractJson('Sure! Here it is:\n{"a":{"b":2}}\nHope that helps.'), { a: { b: 2 } });
});

test('extractJson: arrays and failure', () => {
  assert.deepEqual(extractJson('Result: [1,2,3]'), [1, 2, 3]);
  assert.throws(() => extractJson('no json here'), /No valid JSON/);
});

function withTempRoot(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  setProjectsRoot(tmp);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('cost log: writes lines, missing price gives null, summary adds up', () =>
  withTempRoot(() => {
    logCall({ projectId: 'p', stage: 'brief', model: 'unpriced-model', inputTokens: 100, outputTokens: 50, durationMs: 1000 });
    logCall({ projectId: 'p', stage: 'brief', provider: 'stitch', model: 'stitch', durationMs: 500 });
    const entries = readCostLog('p');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].estimatedUsd, null);
    assert.equal(entries[1].inputTokens, null);
    const rows = summarize(entries);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].calls, 2);
    assert.equal(totalOf(rows).durationMs, 1500);
  }));

test('golden: freeze copies stage output, loadGolden restores it, missing golden explains what to do', () =>
  withTempRoot((tmp) => {
    const businesses = path.join(tmp, 'businesses');
    registerStage(90, { name: 'fake', dir: 'x', inputs: [], outputs: ['fake.json'] });
    try {
      fs.mkdirSync(projectPath('src-project'), { recursive: true });
      fs.writeFileSync(projectPath('src-project', 'fake.json'), '{"ok":true}');
      freezeStage(90, 'src-project', 'biz', { root: businesses });
      assert.ok(fs.existsSync(path.join(businesses, 'biz', 'golden', 'fake.json')));

      loadGolden('biz', 'new-project', 91, { root: businesses, stageNumbers: [90] });
      assert.equal(fs.readFileSync(projectPath('new-project', 'fake.json'), 'utf8'), '{"ok":true}');

      assert.throws(() => loadGolden('other', 'p3', 91, { root: businesses, stageNumbers: [90] }), /freeze 90/);
      assert.throws(() => freezeStage(90, 'nope', 'biz', { root: businesses }), /missing/);
    } finally {
      delete STAGES[90];
    }
  }));

test('evalReport: appends a table row with a header on first write', () => {
  const file = appendRow(99, { project: 'p | x', mode: 'isolated', checks: { passed: 4, total: 5 }, scores: [4, 5], comments: ['1: good'], cost: '$0.01' });
  try {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\| Date \| Project/);
    assert.match(text, /4\/5 \| 4, 5 \| 4\.5/);
    assert.ok(!text.includes('p | x'), 'pipe characters must be escaped');
  } finally {
    fs.rmSync(file);
  }
});
