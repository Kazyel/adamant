import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useState } from 'react';
import { renderToString } from 'react-dom/server';
import type { NavigationController } from '../../navigation/useNavigation.ts';
import type { SelectedDocument } from '../../documents/types.ts';
import type { VaultSnapshot } from '../types.ts';
import { MissingRevealTargetError } from '../useDirectoryPages.ts';
import { useDocumentSession, type DocumentSession } from './useDocumentSession.ts';
import { useWorkspacePersistence } from './useWorkspacePersistence.ts';
import { defaultEditorPreferences } from '../../interaction/types.ts';
import type { DraftRecord, WorkspacePersistenceState } from './persistence.ts';

interface Workspace {
  documents: DocumentSession;
  persistence: ReturnType<typeof useWorkspacePersistence>;
  finder: Pick<NavigationController, 'state' | 'stateRef' | 'setState'>;
  failures: unknown[];
}
type ReadDocument = { type: 'document'; document: SelectedDocument };

const vault: VaultSnapshot = {
  id: 'vault-id',
  name: 'Hydration fixtures',
  root: '/vault',
  contentRoot: '.',
  issues: [],
  issueCount: 0,
  indexing: { state: 'ready', scannedEntries: 0, indexedDocuments: 0, message: null },
};

class SessionCapture extends Error {
  readonly workspace: Workspace;

  constructor(workspace: Workspace) {
    super('Captured the server-rendered workspace');
    this.workspace = workspace;
  }
}

function workspaceSession(
  root: VaultSnapshot | null = vault,
  revealPath: (path: string) => Promise<void> = async () => {
    throw new Error('These fixtures do not restore expanded directories.');
  },
): Workspace {
  const failures: unknown[] = [];
  const stateRef: NavigationController['stateRef'] = {
    current: {
      recent: [],
      favorites: [],
      history: [],
      historyIndex: -1,
      expanded: [],
      identities: {},
      favoriteIdentities: {},
    },
  };
  const finder = {
    state: stateRef.current,
    stateRef,
    setState(next) {
      stateRef.current = typeof next === 'function' ? next(stateRef.current) : next;
    },
  } satisfies Pick<NavigationController, 'state' | 'stateRef' | 'setState'>;

  function Capture(): never {
    const [preferences, setPreferences] = useState(defaultEditorPreferences);
    const documents = useDocumentSession();
    const persistence = useWorkspacePersistence({
      vault: { current: root },
      documents,
      finder: finder as NavigationController,
      fail: (error) => failures.push(error),
      preferences,
      setPreferences,
      revealPath,
    });
    throw new SessionCapture({ documents, persistence, finder, failures });
  }
  try {
    renderToString(createElement(Capture));
  } catch (error) {
    if (error instanceof SessionCapture) {
      return error.workspace;
    }
    throw error;
  }
  throw new Error('The workspace harness did not render.');
}

async function withInvoke(
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  run: () => Promise<void>,
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
  try {
    await run();
  } finally {
    if (previousTauri) {
      Object.defineProperty(globalThis, 'isTauri', previousTauri);
    } else {
      Reflect.deleteProperty(globalThis, 'isTauri');
    }
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readDocument(text: string, identity = 'file:1:2'): ReadDocument {
  return {
    type: 'document',
    document: {
      path: '/selected/notes.md',
      name: 'notes.md',
      kind: 'markdown',
      bytes: Array.from(new TextEncoder().encode(text)),
      identity,
    },
  };
}

function saveDocument(documents: DocumentSession, payload: ReadDocument) {
  const id = documents.openDocument({
    ...payload.document,
    bytes: Uint8Array.from(payload.document.bytes),
    revision: documents.nextRevision(),
    vaultPath: null,
  });
  documents.updateTab(id, { view: 'split', line: 8, column: 3 });
  return { id, state: documents.persist(vault.root, vault.id) };
}

await test('workspace restoration reads the active saved note before an unrelated draft failure', async () => {
  const { documents, persistence, failures } = workspaceSession();
  const { id: backgroundId } = saveDocument(documents, readDocument('Background source'));
  const note = {
    path: 'active.md',
    text: '# Active note\nThe saved source is available.\n',
    revision: 'saved-revision',
    id: 'active-note',
    metadataError: null,
    identity: 'uuid:active-note',
  };
  const activeId = documents.openNote(note, note.identity);
  const state = documents.persist(vault.root, vault.id);
  const draftFailure = new Error('Recovery storage cannot be read.');

  await withInvoke(
    async (command, args) => {
      if (command === 'preferences_load') {
        return null;
      }
      if (command === 'workspace_load') {
        return state;
      }
      if (command === 'workspace_read_tab' && args.tabId === activeId) {
        return { type: 'note', document: note };
      }
      if (command === 'drafts_load') {
        assert.equal(documents.bufferRef.current.text, note.text);
        throw draftFailure;
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    },
    async () => {
      await assert.rejects(persistence.restoreWorkspace(vault), (error) => error === draftFailure);
      assert.equal(documents.activeIdRef.current, activeId);
      assert.equal(documents.bufferRef.current.text, note.text);
      const active = documents.tabsRef.current.find((tab) => tab.id === activeId)!;
      assert.equal(active.restored, false);
      assert.equal(active.hydration, undefined);
      assert.equal(active.source?.kind, 'vault');
      assert.equal(active.identity, note.identity);
      const background = documents.tabsRef.current.find((tab) => tab.id === backgroundId)!;
      assert.equal(background.restored, true);
      assert.equal(background.text, '');
      assert.equal(background.hydration, undefined);
      assert.deepEqual(failures, []);
    },
  );
});

await test('failed hydration retains the tab and draft, and coalesced retries load the actual bytes', async () => {
  const { documents, persistence, failures } = workspaceSession();
  const text = '\uFEFF# Saved caf\u00e9\r\nSecond line\n';
  const payload = readDocument(text);
  const { id, state } = saveDocument(documents, payload);
  assert.equal(documents.restore(state, vault.root, vault.id), true);
  documents.updateTab(id, {
    draftId: 'recovery-id',
    draftScope: { root: vault.root, vaultId: vault.id },
  });
  const draftId = documents.newDraft();
  documents.updateBuffer({ ...documents.bufferRef.current, text: 'Unrelated unsaved writing' });
  documents.activate(id);
  const tab = () => documents.tabsRef.current.find((item) => item.id === id)!;
  let response = deferred<ReadDocument>();
  let started = deferred<void>();
  let reads = 0;
  const readFailure = new Error('Permission denied reading /selected/notes.md');

  await withInvoke(
    async (command) => {
      if (command !== 'workspace_read_tab') {
        throw new Error(`Unexpected IPC command: ${command}`);
      }
      reads++;
      started.resolve();
      return response.promise;
    },
    async () => {
      const first = persistence.hydrateTab(id);
      assert.deepEqual(tab().hydration, { state: 'loading' });
      const duplicate = persistence.hydrateTab(id);
      await started.promise;
      assert.equal(reads, 1);
      response.reject(readFailure);
      await Promise.all([first, duplicate]);
      assert.deepEqual(tab().hydration, { state: 'error', message: readFailure.message });
      assert.equal(tab().restored, true);
      assert.equal(tab().text, '');
      assert.deepEqual(tab().retained, state.tabs[0]);
      assert.equal(tab().draftId, 'recovery-id');
      assert.equal(documents.bufferRef.current.conflict, null);
      assert.deepEqual(
        documents.persist(vault.root, vault.id).tabs.find((item) => item.id === id),
        state.tabs[0],
      );
      const draft = documents.tabsRef.current.find((item) => item.id === draftId)!;
      assert.equal(draft.text, 'Unrelated unsaved writing');
      assert.equal(draft.dirty, true);
      assert.equal(draft.hydration, undefined);
      assert.deepEqual(failures, []);

      response = deferred<ReadDocument>();
      started = deferred<void>();
      const retry = persistence.hydrateTab(id);
      assert.deepEqual(tab().hydration, { state: 'loading' });
      const duplicateRetry = persistence.hydrateTab(id);
      await started.promise;
      assert.equal(reads, 2);
      response.resolve(payload);
      await Promise.all([retry, duplicateRetry]);
      assert.equal(tab().restored, false);
      assert.equal(tab().hydration, undefined);
      assert.equal(tab().text, text);
      assert.equal(documents.bufferRef.current.text, text);
      assert.equal(tab().savedText, text);
      assert.equal(tab().identity, payload.document.identity);
      assert.equal(tab().draftId, 'recovery-id');
      assert.deepEqual(tab().draftScope, { root: vault.root, vaultId: vault.id });
      assert.equal(tab().view, 'split');
      assert.equal(tab().line, 8);
      assert.equal(tab().column, 3);
      assert.equal(
        documents.tabsRef.current.find((item) => item.id === draftId)!.text,
        'Unrelated unsaved writing',
      );
      assert.deepEqual(failures, []);
    },
  );
});

await test('late hydration cannot replace a new request after a scope reset or same-id tab restoration', async () => {
  for (const boundary of ['scope reset', 'same-id replacement'] as const) {
    const { documents, persistence, failures } = workspaceSession();
    const { id, state } = saveDocument(documents, readDocument('Originally saved source'));
    assert.equal(documents.restore(state, vault.root, vault.id), true);
    const tab = () => documents.tabsRef.current.find((item) => item.id === id)!;
    let response = deferred<ReadDocument>();
    const started = deferred<void>();
    let reads = 0;

    await withInvoke(
      async (command) => {
        if (command !== 'workspace_read_tab') {
          throw new Error(`Unexpected IPC command: ${command}`);
        }
        reads++;
        started.resolve();
        return response.promise;
      },
      async () => {
        const oldResponse = response;
        const oldRequest = persistence.hydrateTab(id);
        await started.promise;
        if (boundary === 'scope reset') {
          persistence.resetHydration();
        } else {
          assert.equal(documents.restore(state, vault.root, vault.id), true);
        }
        response = deferred<ReadDocument>();
        const currentRequest = persistence.hydrateTab(id);
        assert.deepEqual(tab().hydration, { state: 'loading' });
        if (boundary === 'scope reset') {
          oldResponse.reject(new Error('Failure from the previous scope'));
        } else {
          oldResponse.resolve(
            readDocument('Stale source must never become the replacement buffer'),
          );
        }
        await oldRequest;
        assert.equal(reads, 2, `${boundary} must get its own read`);
        assert.equal(tab().restored, true, boundary);
        assert.equal(tab().text, '', boundary);
        assert.deepEqual(tab().retained, state.tabs[0]);
        assert.deepEqual(tab().hydration, { state: 'loading' });
        assert.equal(documents.bufferRef.current.conflict, null);
        response.resolve(readDocument('Current source after the boundary'));
        await currentRequest;
        assert.equal(tab().restored, false);
        assert.equal(tab().hydration, undefined);
        assert.equal(documents.bufferRef.current.text, 'Current source after the boundary');
        assert.deepEqual(failures, []);
      },
    );
  }
});

await test('a restored path with a different file identity retains its original tab instead of loading the replacement', async () => {
  const { documents, persistence, failures } = workspaceSession();
  const original = readDocument('Original source');
  const { id, state } = saveDocument(documents, original);
  assert.equal(documents.restore(state, vault.root, vault.id), true);
  const replacement = readDocument('Unrelated replacement file at the same path', 'file:1:99');

  await withInvoke(
    async (command) => {
      if (command !== 'workspace_read_tab') {
        throw new Error(`Unexpected IPC command: ${command}`);
      }
      return replacement;
    },
    async () => {
      await persistence.hydrateTab(id);
      const tab = documents.tabsRef.current.find((item) => item.id === id)!;
      assert.equal(tab.hydration?.state, 'error');
      assert.equal(tab.restored, true);
      assert.equal(tab.identity, original.document.identity);
      assert.equal(tab.source, null);
      assert.equal(tab.document, null);
      assert.equal(documents.bufferRef.current.text, '');
      assert.equal(documents.bufferRef.current.conflict, null);
      assert.deepEqual(tab.retained, state.tabs[0]);
      assert.deepEqual(documents.persist(vault.root, vault.id), state);
      assert.deepEqual(failures, []);
    },
  );
});

await test('no-tabs restoration waits for preferences, retains navigation and drafts, and saves no tabs', async () => {
  const { documents, persistence, finder } = workspaceSession();
  const source = workspaceSession().documents;
  saveDocument(source, readDocument('Remembered file'));
  const navigation = {
    ...finder.stateRef.current,
    recent: ['notes.md'],
    favorites: ['notes.md'],
    history: [{ path: 'notes.md', line: 8, column: 3, page: null, identity: 'uuid:note' }],
    historyIndex: 0,
    identities: { 'notes.md': 'uuid:note' },
    favoriteIdentities: { 'notes.md': 'uuid:note' },
  };
  const state = source.persist(vault.root, vault.id, navigation);
  const draft: DraftRecord = {
    id: 'recovery',
    root: vault.root,
    vaultId: vault.id,
    path: 'notes.md',
    identity: 'uuid:note',
    baseRevision: 'original',
    text: 'Unsaved recovery',
    savedAt: 1,
  };
  const preferences = deferred<typeof defaultEditorPreferences>();
  const requested = deferred<void>();
  const saved: WorkspacePersistenceState[] = [];
  const retained: DraftRecord[] = [];
  let workspaceReads = 0;
  let draftReads = 0;

  await withInvoke(
    async (command, args) => {
      if (command === 'preferences_load') {
        requested.resolve();
        return preferences.promise;
      }
      if (command === 'workspace_load') {
        workspaceReads++;
        return state;
      }
      if (command === 'drafts_load') {
        draftReads++;
        return [draft];
      }
      if (command === 'workspace_save') {
        saved.push(args.state as WorkspacePersistenceState);
        return;
      }
      if (command === 'draft_save') {
        retained.push(args.draft as DraftRecord);
        return;
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    },
    async () => {
      const restore = persistence.restoreWorkspace(vault);
      await requested.promise;
      assert.equal(workspaceReads, 0);
      preferences.resolve({ ...defaultEditorPreferences, showDocumentTabs: false });
      await restore;
      assert.equal(draftReads, 1);
      assert.deepEqual(finder.stateRef.current, navigation);
      assert.equal(documents.tabsRef.current.length, 1);
      assert.equal(documents.tabsRef.current[0].restored, false);
      assert.equal(documents.bufferRef.current.text, '');
      assert.deepEqual(saved.at(-1), { ...state, tabs: [], activeId: null });

      documents.updateBuffer({ ...documents.bufferRef.current, text: 'Fresh unsaved writing' });
      await persistence.flushDrafts();
      assert.equal(retained.length, 1);
      assert.equal(retained[0].text, 'Fresh unsaved writing');
      assert.equal(retained[0].root, vault.root);
      assert.equal(documents.tabsRef.current[0].dirty, true);
      assert.equal(documents.bufferRef.current.text, 'Fresh unsaved writing');
      assert.deepEqual(saved.at(-1)?.tabs, []);
      assert.equal(saved.at(-1)?.activeId, null);
    },
  );
});

await test('no-tabs standalone startup never reads remembered bytes and clears its saved record', async () => {
  const { documents, persistence } = workspaceSession(null);
  const commands: string[] = [];
  await withInvoke(
    async (command, args) => {
      commands.push(command);
      if (command === 'preferences_load') {
        return { ...defaultEditorPreferences, showDocumentTabs: false };
      }
      if (command === 'last_document_save') {
        assert.equal(args.tab, null);
        return;
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    },
    async () => {
      await persistence.restoreLastDocument(() => true);
      saveDocument(documents, readDocument('Explicitly opened file'));
      await persistence.persistWorkspace();
      assert.equal(documents.bufferRef.current.text, 'Explicitly opened file');
      assert.deepEqual(commands, ['preferences_load', 'last_document_save']);
    },
  );
});

await test('changing tab preference clears saved tabs without discarding dirty buffers and can enable persistence again', async () => {
  const { documents, persistence } = workspaceSession();
  const saved: WorkspacePersistenceState[] = [];
  await withInvoke(
    async (command, args) => {
      if (command === 'drafts_load') {
        return [];
      }
      if (command === 'preferences_save') {
        return;
      }
      if (command === 'workspace_save') {
        saved.push(args.state as WorkspacePersistenceState);
        return;
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    },
    async () => {
      await persistence.resumeStorage();
      const { id } = saveDocument(documents, readDocument('Original source'));
      documents.updateBuffer({ ...documents.bufferRef.current, text: 'Dirty source' });
      await persistence.savePreferences({ ...defaultEditorPreferences, showDocumentTabs: false });
      assert.deepEqual(saved.at(-1)?.tabs, []);
      assert.equal(saved.at(-1)?.activeId, null);
      assert.equal(documents.activeIdRef.current, id);
      assert.equal(documents.bufferRef.current.text, 'Dirty source');
      assert.equal(documents.tabsRef.current[0].dirty, true);
      await persistence.savePreferences(defaultEditorPreferences);
      assert.equal(saved.at(-1)?.tabs[0].id, id);
      assert.equal(saved.at(-1)?.activeId, id);
      assert.equal(documents.bufferRef.current.text, 'Dirty source');
    },
  );
});

await test('hiding tabs loads lazy sources before deleting their records and refuses to strand unavailable tabs', async () => {
  for (const available of [true, false]) {
    const { documents, persistence } = workspaceSession();
    const payload = readDocument('Retained source');
    const { id, state } = saveDocument(documents, payload);
    let stored = state;
    let preferenceWrites = 0;
    await withInvoke(
      async (command, args) => {
        if (command === 'drafts_load') {
          return [];
        }
        if (command === 'workspace_read_tab') {
          assert.equal(
            stored.tabs.some((tab) => tab.id === args.tabId),
            true,
          );
          return available ? payload : null;
        }
        if (command === 'workspace_save') {
          stored = args.state as WorkspacePersistenceState;
          return;
        }
        if (command === 'preferences_save') {
          preferenceWrites++;
          return;
        }
        throw new Error(`Unexpected IPC command: ${command}`);
      },
      async () => {
        await persistence.resumeStorage();
        assert.equal(documents.restore(state, vault.root, vault.id), true);
        const save = persistence.savePreferences({
          ...defaultEditorPreferences,
          showDocumentTabs: false,
        });
        if (available) {
          await save;
          assert.equal(preferenceWrites, 1);
          assert.deepEqual(stored.tabs, []);
          assert.equal(documents.bufferRef.current.text, 'Retained source');
          assert.equal(documents.tabsRef.current[0].restored, false);
        } else {
          await assert.rejects(save, /unavailable restored tabs/);
          assert.equal(preferenceWrites, 0);
          assert.equal(stored.tabs[0].id, id);
          assert.equal(documents.tabsRef.current[0].restored, true);
          assert.equal(documents.tabsRef.current[0].hydration?.state, 'error');
        }
      },
    );
  }
});

await test('restoring obsolete folder expansion stays quiet without hiding actual listing failures', async () => {
  for (const inventoryReady of [true, false]) {
    const { documents, persistence, finder, failures } = workspaceSession(vault, async (path) => {
      if (path === 'gone/') {
        throw new MissingRevealTargetError('gone', inventoryReady);
      }
      if (path === 'denied/') {
        throw new Error('Permission denied');
      }
    });
    const state = documents.persist(vault.root, vault.id);
    state.navigation = {
      ...finder.stateRef.current,
      history: [],
      expanded: ['gone', 'gone/nested', 'denied', 'keep'],
    };
    let saved: WorkspacePersistenceState | undefined;
    await withInvoke(
      async (command, args) => {
        if (command === 'workspace_load') {
          return state;
        }
        if (command === 'drafts_load') {
          return [];
        }
        if (command === 'preferences_load') {
          return null;
        }
        if (command === 'workspace_save') {
          saved = args.state as WorkspacePersistenceState;
          return null;
        }
        throw new Error(`Unexpected IPC command: ${command}`);
      },
      async () => {
        await persistence.restoreWorkspace(vault);
        assert.deepEqual(
          failures.map((error) => String(error)),
          ['Error: Permission denied'],
        );
        const expected = inventoryReady
          ? ['denied', 'keep']
          : ['gone', 'gone/nested', 'denied', 'keep'];
        assert.deepEqual(finder.stateRef.current.expanded, expected);
        assert.deepEqual(saved?.navigation?.expanded, expected);
      },
    );
  }
});
