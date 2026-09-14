import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptAnnotationIdentity } from './annotationNavigation.ts';

void test('first annotation preserves back navigation and favorites without adopting unrelated history', () => {
  const state = {
    recent: ['paper.pdf'],
    favorites: ['paper.pdf'],
    expanded: [],
    historyIndex: 2,
    identities: { 'paper.pdf': 'file:1:2' },
    favoriteIdentities: { 'paper.pdf': 'file:1:2' },
    history: [
      { path: 'other.pdf', identity: 'file:1:2' },
      { path: 'paper.pdf', identity: 'file:1:old' },
      { path: 'paper.pdf', identity: 'file:1:2', line: 8 },
    ],
  };
  const updated = adoptAnnotationIdentity(state, 'paper.pdf', 'file:1:2', 'uuid:document');
  assert.equal(updated.history[2].identity, 'uuid:document');
  assert.equal(updated.history[2].line, 8);
  assert.equal(updated.favoriteIdentities['paper.pdf'], 'uuid:document');
  assert.equal(updated.identities['paper.pdf'], 'uuid:document');
  assert.deepEqual(updated.history.slice(0, 2), state.history.slice(0, 2));
  assert.equal(state.history[2].identity, 'file:1:2');
  assert.deepEqual(
    adoptAnnotationIdentity(updated, 'paper.pdf', 'file:1:2', 'uuid:document'),
    updated,
  );
});
