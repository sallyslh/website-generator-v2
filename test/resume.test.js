// "Try again" continues from the step that failed; steps already done are not run (and paid for) again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from '../src/server/customerFlow.js';
import { setProjectsRoot, projectPath } from '../src/lib/project.js';

test('retry after the drawing step failed runs only the drawing step; a failure before it starts over', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  setProjectsRoot(tmp);
  try {
    const calls = []; let failSketches = true;
    const steps = { brief: async () => calls.push('brief'), photos: async () => calls.push('photos'), findings: async () => [], direction: async () => calls.push('direction'), copy: async () => calls.push('copy'),
      sketches: async () => { calls.push('sketches'); if (failSketches) throw new Error('Request timed out'); } };
    const flow = createFlow({ steps });
    fs.mkdirSync(projectPath('c-resume-test', ''), { recursive: true });
    await flow.start('c-resume-test');
    assert.equal(flow.read('c-resume-test').phase, 'failed');
    assert.deepEqual(calls, ['brief', 'photos', 'direction', 'copy', 'sketches']);
    calls.length = 0; failSketches = false;
    await flow.retry('c-resume-test');
    assert.deepEqual(calls, ['sketches'], 'direction and copy are not paid for again');
    assert.equal(flow.read('c-resume-test').phase, 'ready');
    // a failure in the first steps: retry starts from the beginning
    flow.save('c-resume-test', { phase: 'failed', steps: flow.read('c-resume-test').steps.map((s) => ({ ...s, status: s.key === 'brief' ? 'working' : 'waiting' })) });
    calls.length = 0;
    await flow.retry('c-resume-test');
    assert.deepEqual(calls, ['brief', 'photos', 'direction', 'copy', 'sketches']);
  } finally { setProjectsRoot(path.resolve('projects')); fs.rmSync(tmp, { recursive: true, force: true }); }
});
