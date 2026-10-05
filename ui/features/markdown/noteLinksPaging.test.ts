import assert from 'node:assert/strict';
import test from 'node:test';
import { growNoteLinkLimit, initialNoteLinkLimits, noteLinksIdentity } from './noteLinksPaging.ts';

void test('backlink refresh and revision changes preserve result identity, while sources and searches stay isolated', () => {
  const source = {
    vaultKey: '/vault:one',
    path: 'note.md',
    expectedIdentity: 'uuid:note',
    query: '',
  };
  const revision = { ...source, refreshKey: 'new-revision', refresh: 9 };
  assert.equal(noteLinksIdentity(source), noteLinksIdentity(revision));
  for (const other of [
    { ...source, vaultKey: '/vault:two' },
    { ...source, path: 'another.md' },
    { ...source, expectedIdentity: 'uuid:replacement' },
    { ...source, query: 'another' },
  ]) {
    assert.notEqual(noteLinksIdentity(source), noteLinksIdentity(other));
  }
});

void test('note link pages grow independently and stop at the native display limits', () => {
  const incoming = growNoteLinkLimit(initialNoteLinkLimits, 'incoming');
  assert.deepEqual(incoming, { incoming: 200, outgoing: 100, targets: 50 });
  const outgoing = growNoteLinkLimit(incoming, 'outgoing');
  assert.deepEqual(outgoing, { incoming: 200, outgoing: 200, targets: 50 });
  assert.deepEqual(growNoteLinkLimit(outgoing, 'targets'), {
    incoming: 200,
    outgoing: 200,
    targets: 100,
  });
  const capped = { incoming: 25_000, outgoing: 25_000, targets: 50_000 };
  assert.equal(growNoteLinkLimit(capped, 'incoming'), capped);
  assert.equal(growNoteLinkLimit(capped, 'outgoing'), capped);
  assert.equal(growNoteLinkLimit(capped, 'targets'), capped);
  assert.deepEqual(initialNoteLinkLimits, { incoming: 100, outgoing: 100, targets: 50 });
});
