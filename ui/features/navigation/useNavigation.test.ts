import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useNavigation, type NavigationController } from './useNavigation.ts';
import { workspaceLoad } from '../workspace/session/persistence.ts';

class NavigationCapture extends Error {
  readonly navigation: NavigationController;

  constructor(navigation: NavigationController) {
    super('Captured navigation');
    this.navigation = navigation;
  }
}

function navigation(initialState?: Parameters<typeof useNavigation>[0]): NavigationController {
  function Capture(): never {
    throw new NavigationCapture(useNavigation(initialState));
  }
  try {
    renderToString(createElement(Capture));
  } catch (error) {
    if (error instanceof NavigationCapture) {
      return error.navigation;
    }
    throw error;
  }
  throw new Error('Navigation did not render.');
}

await test('confirmed deletions remove descendants from navigation without removing prefix siblings', () => {
  const finder = navigation({ expanded: ['notes', 'notes/nested', 'notes-old'] });
  for (const path of ['keep.md', 'notes/one.md', 'notes/nested/two.pdf', 'notes-old/keep.md']) {
    finder.navigate({ path }, `uuid:${path}`);
    finder.toggleFavorite(path, `uuid:${path}`);
  }
  finder.back();
  finder.removePaths(['notes']);

  const current = finder.stateRef.current;
  assert.deepEqual(current.recent, ['notes-old/keep.md', 'keep.md']);
  assert.deepEqual(current.favorites, ['keep.md', 'notes-old/keep.md']);
  assert.deepEqual(
    current.history.map((entry) => entry.path),
    ['keep.md', 'notes-old/keep.md'],
  );
  assert.equal(current.historyIndex, 0);
  assert.deepEqual(current.expanded, ['notes-old']);
  assert.deepEqual(current.identities, {
    'keep.md': 'uuid:keep.md',
    'notes-old/keep.md': 'uuid:notes-old/keep.md',
  });
  assert.deepEqual(current.favoriteIdentities, current.identities);
  finder.forward();
  assert.equal(finder.stateRef.current.historyIndex, 1);
  finder.removePaths(['notes-old/keep.md']);
  assert.equal(finder.stateRef.current.historyIndex, 0);
  finder.removePaths(['keep.md']);
  assert.deepEqual(finder.stateRef.current.history, []);
  assert.equal(finder.stateRef.current.historyIndex, -1);
});

await test('PDF history distinguishes pages and returns to previous locations', () => {
  const finder = navigation();
  finder.navigate({ path: 'paper.pdf', page: 2 }, 'uuid:paper');
  finder.navigate({ path: 'paper.pdf', page: 5 }, 'uuid:paper');
  finder.navigate({ path: 'paper.pdf', page: 5 }, 'uuid:paper');
  assert.equal(finder.stateRef.current.history.length, 2);
  finder.back();
  assert.equal(finder.stateRef.current.history[finder.stateRef.current.historyIndex].page, 2);
  finder.forward();
  assert.equal(finder.stateRef.current.history[finder.stateRef.current.historyIndex].page, 5);
});

await test('stored PDF pages survive restoration while older history remains valid', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const history: Record<string, unknown>[] = [
    { path: 'paper.pdf', line: null, column: null, page: 3 },
    { path: 'old.md', line: 4, column: 1 },
  ];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async () => ({
          version: 1,
          root: '/vault',
          vaultId: 'vault',
          activeId: null,
          tabs: [],
          navigation: {
            recent: [],
            favorites: [],
            expanded: [],
            identities: {},
            history,
            historyIndex: 1,
          },
        }),
      },
    },
  });
  try {
    const restored = await workspaceLoad();
    assert.deepEqual(
      restored?.navigation?.history.map((entry) => entry.page),
      [3, null],
    );
    for (const invalid of [0, -1, 1.5, '3']) {
      history[0].page = invalid;
      await assert.rejects(workspaceLoad, /history page is invalid/);
    }
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'window', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

await test('filter-only searches retain filters and cancelling, resetting or deleting retires requests', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let finishSearch: (() => void) | undefined;
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === 'vault_search' && args.query === 'deleting') {
            await new Promise<void>((resolve) => {
              finishSearch = resolve;
            });
          }
          return {
            requestId: args.requestId,
            generation: 1,
            hits: [],
            hasMore: false,
            truncated: false,
            canContinue: false,
            indexing: { state: 'ready', scannedEntries: 0, indexedDocuments: 0, message: null },
          };
        },
      },
    },
  });
  try {
    const finder = navigation();
    const filters = { directory: 'notes', tags: ['work', 'focus'], kinds: ['pdf' as const] };
    await finder.search('', 'content', filters);
    assert.deepEqual(calls[0].args.filters, filters);
    assert.equal(calls[0].args.mode, 'path');
    finder.cancelSearch();
    assert.deepEqual(calls[1], {
      command: 'vault_cancel_search',
      args: { requestId: calls[0].args.requestId },
    });
    await finder.search('term', 'content', filters);
    finder.resetScope();
    assert.deepEqual(calls[3], {
      command: 'vault_cancel_search',
      args: { requestId: calls[2].args.requestId },
    });
    await finder.search('', 'path');
    assert.equal(calls.length, 4);
    const pending = finder.search('deleting', 'path');
    finder.removePaths([]);
    assert.equal(calls.length, 5);
    finder.removePaths(['notes']);
    assert.deepEqual(calls[5], {
      command: 'vault_cancel_search',
      args: { requestId: calls[4].args.requestId },
    });
    assert.ok(finishSearch);
    finishSearch();
    await pending;
    finder.cancelSearch();
    assert.equal(calls.length, 6);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (previousTauri) {
      Object.defineProperty(globalThis, 'isTauri', previousTauri);
    } else {
      Reflect.deleteProperty(globalThis, 'isTauri');
    }
  }
});
