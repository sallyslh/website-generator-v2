// A page Stitch cannot finish in time is asked again with a smaller sample of its long lists; other errors are not hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScreenSmaller } from '../src/stages/05-design-stitch/index.js';

const long = 'x'.repeat(1000);
const again = (sample) => long.slice(0, 200 * sample);

test('a timeout is retried with 3 rows per list, then 2; the first answer that works is used', async () => {
  const sizes = [];
  const ask = async (p, s, prompt) => { sizes.push(prompt.length); if (prompt.length > 400) throw new Error('MCP error -32001: Request timed out'); return { screenId: 'ok' }; };
  const r = await generateScreenSmaller({ projectId: 'p', stitchProjectId: 's', prompt: long, mode: 'guided', again, ask });
  assert.equal(r.screenId, 'ok');
  assert.deepEqual(sizes, [1000, 600, 400]);
});

test('"service unavailable" on a page with nothing smaller: the same page is tried once more, then the error is reported', async () => {
  let calls = 0;
  const ask = async () => { calls++; throw new Error('Tool Call Failed [generate_screen_from_text]: The service is currently unavailable.'); };
  await assert.rejects(generateScreenSmaller({ projectId: 'p', stitchProjectId: 's', prompt: 'short', mode: 'guided', again: () => 'short', ask, wait: 0 }), /unavailable/);
  assert.equal(calls, 2);
  let n = 0;
  const flaky = async () => { if (++n === 1) throw new Error('The service is currently unavailable.'); return { screenId: 'ok' }; };
  assert.equal((await generateScreenSmaller({ projectId: 'p', stitchProjectId: 's', prompt: 'short', mode: 'guided', again: () => 'short', ask: flaky, wait: 0 })).screenId, 'ok', 'a short outage is survived');
});

test('other errors (a bad key, a refused request) are not retried or hidden', async () => {
  let calls = 0;
  const ask = async () => { calls++; throw new Error('PERMISSION_DENIED: bad API key'); };
  await assert.rejects(generateScreenSmaller({ projectId: 'p', stitchProjectId: 's', prompt: long, mode: 'guided', again, ask }), /PERMISSION_DENIED/);
  assert.equal(calls, 1);
});
