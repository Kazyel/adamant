import assert from 'node:assert/strict';
import test from 'node:test';
import { queueNoteLinksRequest } from './noteLinksRequests.ts';

void test('note link refreshes wait for the in-flight request and skip superseded queued queries', async () => {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let obsolete = true;
  let pending = queueNoteLinksRequest(
    Promise.resolve(),
    () => true,
    async () => {
      calls.push('first');
      await gate;
    },
  );
  await Promise.resolve();
  pending = queueNoteLinksRequest(
    pending,
    () => obsolete,
    async () => {
      calls.push('obsolete');
    },
  );
  pending = queueNoteLinksRequest(
    pending,
    () => true,
    async () => {
      calls.push('latest');
    },
  );
  obsolete = false;
  assert.deepEqual(calls, ['first']);
  assert.ok(release);
  release();
  await pending;
  assert.deepEqual(calls, ['first', 'latest']);
});
