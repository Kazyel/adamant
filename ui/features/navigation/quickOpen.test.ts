import assert from 'node:assert/strict';
import test from 'node:test';
import { adjacentTabId, quickOpenItems } from './quickOpen.ts';

void test('quick open keeps open buffers addressable without a Vault and distinguishes equal filenames', () => {
  const items = quickOpenItems(
    [
      { id: 'draft', source: null, document: null, dirty: true },
      {
        id: 'first',
        source: { kind: 'standalone', path: '/one/note.md', name: 'note.md' },
        document: null,
        dirty: true,
      },
      {
        id: 'second',
        source: { kind: 'standalone', path: '/two/note.md', name: 'note.md' },
        document: null,
        dirty: false,
      },
    ],
    [],
    '',
  );
  assert.deepEqual(
    items.map((item) => [item.key, item.name]),
    [
      ['tab:draft', 'Untitled'],
      ['tab:first', 'note.md'],
      ['tab:second', 'note.md'],
    ],
  );
  assert.deepEqual(quickOpenItems([], [], ''), []);
});

void test('quick open prefers the live Vault tab over an indexed path', () => {
  const items = quickOpenItems(
    [
      {
        id: 'live',
        source: {
          kind: 'vault',
          note: {
            path: 'work/note.md',
            id: 'note',
            text: '',
            revision: 'one',
            metadataError: null,
          },
        },
        document: null,
        dirty: true,
      },
    ],
    ['work/note.md', 'other.md'],
    ' NOTE ',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'tab');
  assert.equal(items[0].key, 'tab:live');
});

void test('cycling documents wraps in both directions without mutating session order', () => {
  const tabs = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  assert.equal(adjacentTabId(tabs, 'first', -1), 'third');
  assert.equal(adjacentTabId(tabs, 'third', 1), 'first');
  assert.equal(adjacentTabId(tabs, 'first', 1), 'second');
  assert.equal(adjacentTabId([], null, 1), undefined);
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ['first', 'second', 'third'],
  );
});
