import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useNavigation, type NavigationController } from '../navigation/useNavigation.ts';
import { useWorkspaceNavigation } from './workspaceNavigation.ts';
import type { NoteDocument, OpenedDocument, VaultSnapshot } from './types.ts';
import type { SessionTab } from './session/useDocumentSession.ts';

type Context = Parameters<typeof useWorkspaceNavigation>[0];
const vault: VaultSnapshot = {
  id: 'vault',
  root: '/vault',
  name: 'Notes',
  contentRoot: '.',
  issues: [],
  issueCount: 0,
  indexing: { state: 'ready', scannedEntries: 1, indexedDocuments: 1, message: null },
};
const note: NoteDocument = {
  path: 'note.md',
  text: '# Saved note\r\n',
  revision: 'current',
  id: 'note',
  metadataError: null,
};
const entry = {
  path: note.path,
  kind: 'markdown',
  id: note.id,
  metadataError: null,
  modifiedAt: null,
} as const;

function Navigation(finder?: NavigationController) {
  let pending = Promise.resolve();
  const opened: NoteDocument[] = [];
  const binaryOpened: OpenedDocument[] = [];
  const visits: string[] = [];
  const removedDocuments: string[][] = [];
  const removedNavigation: string[][] = [];
  const context: Context = {
    vault: { current: vault },
    documents: {
      tabsRef: { current: [] },
      activeIdRef: { current: null },
      openNote(value) {
        opened.push(value);
        return 'tab';
      },
      openDocument(value) {
        binaryOpened.push(value);
        return 'tab';
      },
      nextRevision: () => 1,
      updateTab(id, update) {
        const tabs = context.documents.tabsRef.current;
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index >= 0) {
          const current = tabs[index];
          tabs[index] = typeof update === 'function' ? update(current) : { ...current, ...update };
        }
      },
    },
    finder: finder ?? {
      stateRef: {
        current: {
          recent: [],
          favorites: [],
          history: [],
          historyIndex: -1,
          expanded: [],
          identities: {},
          favoriteIdentities: {},
        },
      },
      rememberTarget() {},
      markMissing() {},
      navigate(target) {
        visits.push(target.path);
      },
      setState() {},
      toggleFavorite() {},
    },
    run(action) {
      pending = action();
    },
    revealPath: async () => {},
    removePaths(paths) {
      finder?.removePaths(paths);
      removedDocuments.push([...paths]);
      removedNavigation.push([...paths]);
    },
    fail(error) {
      throw error;
    },
    notify() {},
  };
  return {
    actions: useWorkspaceNavigation(context),
    opened,
    binaryOpened,
    visits,
    removedDocuments,
    removedNavigation,
    done: () => pending,
    context,
  };
}

async function withTarget(
  run: (commands: string[]) => Promise<void>,
  response?: (command: string, args: { path?: string; includeNote?: boolean }) => unknown,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const commands: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { path?: string; includeNote?: boolean }) => {
          commands.push(command);
          if (response) {
            return response(command, args);
          }
          assert.equal(command, 'vault_navigation_target');
          assert.equal(args.includeNote, true);
          return { entry, identity: 'uuid:note', note };
        },
      },
    },
  });
  try {
    await run(commands);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'window', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

await test('opening Markdown receives its verified source in one native request', async () => {
  await withTarget(async (commands) => {
    const session = Navigation();
    session.actions.openEntry(entry);
    await session.done();
    assert.deepEqual(commands, ['vault_navigation_target']);
    assert.deepEqual(session.opened, [note]);
    assert.deepEqual(session.visits, ['note.md']);
  });
});

await test('navigation cleans certified missing paths but retains access failures and superseded Vault targets', async () => {
  for (const kind of ['missing', 'io']) {
    await withTarget(
      async () => {
        const session = Navigation();
        session.actions.openPath('note.md');
        await assert.rejects(session.done(), /Unavailable/);
        const expected = kind === 'missing' ? [['note.md']] : [];
        assert.deepEqual(session.removedDocuments, expected);
        assert.deepEqual(session.removedNavigation, expected);
      },
      () => {
        throw { kind, message: 'Unavailable', current: null };
      },
    );
  }
  await withTarget(
    async () => {
      const session = Navigation();
      session.actions.openPath('note.md');
      session.context.vault.current = { ...vault, root: '/another-vault' };
      await session.done();
      assert.deepEqual(session.removedDocuments, []);
      assert.deepEqual(session.removedNavigation, []);
    },
    () => {
      throw { kind: 'missing', message: 'Unavailable', current: null };
    },
  );
});

await test('bundled note reads retain identity, search revision and Vault scope checks', async () => {
  await withTarget(async () => {
    const session = Navigation();
    session.actions.openPath('note.md', 'uuid:replaced');
    await assert.rejects(session.done(), /no longer refers to the same item/);
    session.actions.openSearchHit({
      ...entry,
      identity: 'uuid:note',
      revision: 'old',
      line: 3,
      column: 1,
      snippet: 'Old source',
    });
    await assert.rejects(session.done(), /changed on disk/);
    session.actions.openEntry(entry);
    session.context.vault.current = { ...vault, root: '/another-vault' };
    await session.done();
    assert.deepEqual(session.opened, []);
    assert.deepEqual(session.visits, []);
  });
});

await test('PDF search verifies the extracted revision and changes the existing viewer page without resetting zoom', async () => {
  const bytes = Array.from(new TextEncoder().encode('%PDF fixture revision'));
  const revision = createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
  const pdfEntry = { ...entry, path: 'document.pdf', kind: 'pdf', id: 'pdf' } as const;
  const hit = {
    ...pdfEntry,
    identity: 'uuid:pdf',
    revision,
    line: null,
    column: null,
    page: 3,
    snippet: 'needle',
  };
  await withTarget(
    async (commands) => {
      const session = Navigation();
      const tab: SessionTab = {
        id: 'tab',
        kind: 'pdf',
        source: null,
        document: null,
        text: '',
        savedText: '',
        dirty: false,
        conflict: null,
        view: 'read',
        showOriginal: true,
        line: 1,
        column: 1,
        editorKey: 1,
        viewerState: { page: 1, zoom: 1.5, scrollTop: 1200 },
        draftId: null,
        restored: false,
      };
      session.context.documents.tabsRef.current = [tab];
      session.actions.openSearchHit(hit);
      await session.done();
      assert.deepEqual(commands, ['vault_navigation_target', 'vault_open_document']);
      assert.equal(session.binaryOpened.length, 1);
      assert.deepEqual(session.context.documents.tabsRef.current[0].viewerState, {
        page: 3,
        zoom: 1.5,
        scrollTop: 0,
      });

      session.actions.openSearchHit({ ...hit, revision: 'old-revision', page: 2 });
      await assert.rejects(session.done(), /changed on disk/);
      assert.equal(session.binaryOpened.length, 1);
      assert.equal(session.context.documents.tabsRef.current[0].viewerState.page, 3);
    },
    (command) =>
      command === 'vault_navigation_target'
        ? { entry: pdfEntry, identity: 'uuid:pdf' }
        : {
            path: '/vault/document.pdf',
            name: 'document.pdf',
            kind: 'pdf',
            identity: 'uuid:pdf',
            bytes,
          },
  );
});

await test('history skips a deleted entry without losing the surviving navigation position', async () => {
  class CaptureError extends Error {
    readonly finder: NavigationController;
    constructor(finder: NavigationController) {
      super('Captured navigation');
      this.finder = finder;
    }
  }
  function Capture(): never {
    throw new CaptureError(useNavigation());
  }
  let finder: NavigationController;
  try {
    renderToString(createElement(Capture));
    throw new Error('Navigation did not render');
  } catch (error) {
    if (!(error instanceof CaptureError)) {
      throw error;
    }
    finder = error.finder;
  }
  for (const path of ['a.md', 'deleted.md', 'c.md']) {
    finder.navigate({ path }, `uuid:${path}`);
  }
  finder.back();
  finder.back();
  await withTarget(
    async () => {
      const session = Navigation(finder);
      session.actions.navigateHistory(1);
      await session.done();
      assert.deepEqual(
        finder.stateRef.current.history.map((item) => item.path),
        ['a.md', 'c.md'],
      );
      assert.equal(finder.stateRef.current.historyIndex, 1);
      session.actions.navigateHistory(-1);
      await session.done();
      assert.equal(finder.stateRef.current.historyIndex, 0);
      assert.deepEqual(
        session.opened.map((item) => item.path),
        ['c.md', 'a.md'],
      );
    },
    (_command, args) => {
      if (args.path === 'deleted.md') {
        throw { kind: 'missing', message: 'Removed', current: null };
      }
      return {
        entry: { ...entry, path: args.path },
        identity: `uuid:${args.path}`,
        note: { ...note, path: args.path, id: args.path },
      };
    },
  );
});
