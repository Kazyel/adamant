import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { errorMessage } from '../../shared/errors';
import type { SelectedDocument } from '../documents/types';
import { conflictError, sourceName } from './buffer';
import type { NoteDocument, VaultSnapshot } from './types';
import useDirectoryPages from './useDirectoryPages';
import subscribeWorkspaceEvents from './workspaceEvents';
import useWorkspacePrompt from './useWorkspacePrompt';
import { isEmptyDraft, tabIdentity, useDocumentSession } from './session/useDocumentSession';
import type { SessionTab } from './session/useDocumentSession';
import { validatedMarkdownPrefix } from '../markdown/markdownSource';
import { useNavigation } from '../navigation/useNavigation';
import type { MutationResult } from './usabilityTypes';
import type { UserAction } from '../interaction/types';
import { defaultEditorPreferences } from '../interaction/types';
import { useWorkspaceNavigation } from './workspaceNavigation';
import { useFileActions } from './useFileActions';
import { useWorkspacePersistence } from './session/useWorkspacePersistence';
import type { Workspace } from './workspaceTypes';

const native = isTauri();

export default function useWorkspace(): Workspace {
  const [vault, setVaultState] = useState<VaultSnapshot | null>(null);
  const vaultRef = useRef(vault);
  const session = useRef(0);
  const [currentSession, setCurrentSession] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const confirmedClose = useRef(false);

  const [preferences, setPreferences] = useState(defaultEditorPreferences);
  const documents = useDocumentSession(() => preferences.defaultView);
  const finder = useNavigation();
  const explorerActions = useRef<UserAction[]>([]);
  const {
    buffer,
    bufferRef,
    nextRevision,
    updateBuffer,
    replaceBuffer: replaceBufferState,
  } = documents;
  const { prompt, ask, answer, selectVault } = useWorkspacePrompt();
  const {
    pages,
    resetPages,
    clearPageRequests,
    refreshPages,
    toggleDirectory,
    loadMore,
    setDirectoryOptions,
    revealPath: revealDirectoryPath,
  } = useDirectoryPages(vaultRef, session, mounted);
  const revealGeneration = useRef(0);
  const [revealTarget, setRevealTarget] = useState<{ path: string; focus: boolean } | null>(null);

  async function revealPath(path: string, options?: { focus?: boolean }) {
    const generation = ++revealGeneration.current;
    try {
      await revealDirectoryPath(path);
    } catch (error) {
      if (generation === revealGeneration.current) {
        throw error;
      }
    }
    if (generation === revealGeneration.current) {
      setRevealTarget({ path: path.replace(/\/+$/g, ''), focus: options?.focus ?? true });
    }
  }

  const snapshotGeneration = useRef(0);
  const snapshotRequest = useRef<{ session: number; generation: number } | null>(null);
  const [indexAction, setIndexAction] = useState<'reconcile' | 'cancel' | null>(null);
  const indexCommand = useRef(0);

  const { selected, showOriginal, setShowOriginal } = documents;
  const [busy, setBusy] = useState<Workspace['busy']>(native ? 'navigate' : null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const fail = useCallback(
    (error: unknown) => {
      setNotice({ error: true, text: errorMessage(error) });
    },
    [setNotice],
  );

  const operation = useRef<Promise<unknown> | null>(null);
  const restoring = useRef(native);
  const restoreRequest = useRef<Promise<VaultSnapshot | null> | null>(null);
  const refreshingNote = useRef(false);
  const tabRefreshRequests = useRef(new Map<string, object>());
  const noteRefreshQueued = useRef(false);
  const refreshQueued = useRef(false);
  const closing = useRef(false);
  const actions = useRef({
    refresh: () => {},
    refreshSnapshot: () => {},
    refreshNote: () => {},
    close: () => {},
    flushDrafts: async () => {},
  });

  const persistence = useWorkspacePersistence({
    vault: vaultRef,
    documents,
    finder,
    fail,
    revealPath: revealDirectoryPath,
    setPreferences,
  });
  const {
    resetHydration,
    savePreferences,
    recoveries,
    setRecoveries,
    recoverDraft,
    discardRecovery,
    hydrateTab,
    restoreWorkspace,
    restoreLastDocument,
    persistWorkspace,
  } = persistence;
  const {
    openEntry,
    openPath,
    openSearchHit,
    navigateHistory,
    revealActive,
    copyActiveLink,
    favoriteActive,
    copyLink,
    toggleFavorite,
  } = useWorkspaceNavigation({
    vault: vaultRef,
    documents,
    finder,
    run: (action) => run('background', action),
    revealPath,
    fail,
    notify: (text) => setNotice({ error: false, text }),
  });
  const fileActions = useFileActions({
    vault,
    busy: !!busy,
    run: (action) => runOperation('navigate', action),
    guardPaths: (paths, title) => guard(title, paths),
    onMutation,
    onCreated: (note) => {
      showNote(note);
      refreshPages();
      actions.current.refreshSnapshot();
    },
    fail,
  });

  function setVault(next: VaultSnapshot | null) {
    vaultRef.current = next;
    setVaultState(next);
  }

  function startVaultSession(next: VaultSnapshot | null) {
    session.current++;
    revealGeneration.current++;
    setRevealTarget(null);
    resetHydration();
    if (vaultRef.current?.root !== next?.root || vaultRef.current?.id !== next?.id) {
      finder.resetScope();
    } else {
      finder.cancelSearch();
    }
    tabRefreshRequests.current.clear();
    epoch.current++;
    snapshotGeneration.current++;
    indexCommand.current++;
    clearPageRequests();
    snapshotRequest.current = null;
    refreshQueued.current = false;
    noteRefreshQueued.current = false;
    setIndexAction(null);
    setVault(next);
    resetPages(!!next);
    setCurrentSession(session.current);
  }

  const restoreVault = useEffectEvent(async (isLive: () => boolean) => {
    let startedSession = session.current;
    let startedEpoch = epoch.current;
    const isCurrent = () =>
      isLive() && session.current === startedSession && epoch.current === startedEpoch;
    try {
      // Keep the IPC result across effect replay, but apply it only in the live lifecycle.
      const next = await (restoreRequest.current ??= Promise.resolve().then(() =>
        invoke<VaultSnapshot | null>('vault_restore'),
      ));
      if (!isCurrent()) {
        return;
      }
      if (next) {
        startVaultSession(next);
        startedSession = session.current;
        startedEpoch = epoch.current;
        await restoreWorkspace(next);
        if (isCurrent()) {
          await fileActions.refreshRecoveries(next.id);
        }
      } else {
        await restoreLastDocument(isCurrent);
      }
    } catch (error) {
      if (isCurrent()) {
        fail(error);
      }
    }
  });

  function showNote(note: NoteDocument) {
    documents.openNote(note);
  }

  function run(kind: NonNullable<Workspace['busy']>, action: () => Promise<void>) {
    void runOperation(kind, action).catch(fail);
  }

  function runOperation<T>(
    kind: NonNullable<Workspace['busy']>,
    action: () => Promise<T>,
  ): Promise<T> {
    if (restoring.current || operation.current || !native) {
      return Promise.reject(
        new Error(
          !native
            ? 'This action requires the desktop application.'
            : 'Wait for the current operation to finish.',
        ),
      );
    }

    epoch.current++;
    if (refreshingNote.current) {
      noteRefreshQueued.current = true;
    }
    if (kind === 'navigate') {
      flushSync(() => setBusy(kind));
    } else {
      setBusy(kind);
    }
    setNotice(null);

    // Defer until the lock is installed, including synchronous event callbacks.
    const pending = Promise.resolve()
      .then(action)
      .finally(() => {
        operation.current = null;
        if (mounted.current) {
          setBusy(null);
          if (refreshQueued.current) {
            refreshQueued.current = false;
            actions.current.refresh();
          } else if (noteRefreshQueued.current) {
            actions.current.refreshNote();
          }
        }
      });
    operation.current = pending;
    return pending;
  }

  async function destinationVault(): Promise<boolean> {
    if (vaultRef.current) {
      return true;
    }

    const mode = await ask({ kind: 'vault', title: 'Choose a Vault to save your Markdown' });
    if (mode !== 'create' && mode !== 'open') {
      return false;
    }
    const next = await selectVault(mode);
    if (!next) {
      return false;
    }

    startVaultSession(next);
    await persistence.resumeStorage();
    return true;
  }

  function defaultNotePath(name: string): string {
    return vaultRef.current?.contentRoot === 'content' ? name : `notes/${name}`;
  }

  async function writeCopy(recovery: boolean): Promise<boolean> {
    if (!(await destinationVault())) {
      return false;
    }

    const current = bufferRef.current;
    const path = await ask({
      kind: 'path',
      title: recovery ? 'Save recovery copy (.md)' : 'Save Markdown as a new Note (.md)',
      initial:
        current.source?.kind === 'vault'
          ? current.source.note.path.replace(/\.md$/i, '-recovery.md')
          : defaultNotePath('New document.md'),
      recovery,
    });
    if (!path) {
      return false;
    }

    const captured = bufferRef.current;
    const note = await invoke<NoteDocument>(recovery ? 'vault_save_copy' : 'vault_create_note', {
      path,
      text: captured.text,
    });

    const latest = bufferRef.current;
    if (latest === captured) {
      updateBuffer({
        ...latest,
        text: note.text,
        savedText: note.text,
        source: { kind: 'vault', note },
        conflict: null,
      });
      const tab = documents.tabsRef.current.find(
        (item) => item.id === documents.activeIdRef.current,
      );
      if (tab) {
        const previousPrefix = validatedMarkdownPrefix(
          captured.text,
          captured.source?.kind === 'vault' ? captured.source.note.text : undefined,
        );
        const nextPrefix = validatedMarkdownPrefix(note.text, note.text);
        const delta = nextPrefix.split('\n').length - previousPrefix.split('\n').length;
        documents.updateTab(tab.id, { line: Math.max(1, tab.line + delta) });
      }
    } else {
      updateBuffer({
        ...latest,
        savedText: note.text,
        source: { kind: 'vault', note },
        conflict: null,
      });
    }

    refreshQueued.current = true;
    const savedTab = documents.tabsRef.current.find(
      (tab) => tab.id === documents.activeIdRef.current,
    );
    if (savedTab && !savedTab.dirty) {
      await documents.clearDraft(savedTab);
    }
    return bufferRef.current.text === bufferRef.current.savedText;
  }

  async function saveCurrent(): Promise<boolean> {
    if (
      documents.tabsRef.current.find((tab) => tab.id === documents.activeIdRef.current)?.kind !==
      'markdown'
    ) {
      return true;
    }
    const captured = bufferRef.current;
    if (captured.source?.kind !== 'vault') {
      return writeCopy(false);
    }
    if (captured.conflict) {
      setNotice({
        error: true,
        text: 'The disk version changed. Cancel navigation, then reload disk or save a recovery copy.',
      });
      return false;
    }
    if (captured.text === captured.savedText) {
      return true;
    }

    try {
      const note = await invoke<NoteDocument>('vault_save_note', {
        path: captured.source.note.path,
        text: captured.text,
        expectedRevision: captured.source.note.revision,
      });

      const latest = bufferRef.current;
      updateBuffer({
        ...latest,
        savedText: note.text,
        source: { kind: 'vault', note },
        conflict: null,
      });

      refreshQueued.current = true;
      const savedTab = documents.tabsRef.current.find(
        (tab) => tab.id === documents.activeIdRef.current,
      );
      if (savedTab && !savedTab.dirty) {
        await documents.clearDraft(savedTab);
      }
      return latest.text === note.text;
    } catch (error) {
      if (conflictError(error)) {
        updateBuffer({
          ...bufferRef.current,
          conflict: { current: error.current, message: error.message },
        });
      }
      fail(error);
      return false;
    }
  }

  async function guard(
    title: string,
    paths?: readonly string[],
    ids?: readonly string[],
  ): Promise<boolean> {
    const previous = documents.activeIdRef.current;
    const pending = documents.tabsRef.current.filter(
      (tab) =>
        tab.kind === 'markdown' &&
        !tab.restored &&
        (!ids || ids.includes(tab.id)) &&
        (tab.dirty || tab.conflict) &&
        (!paths ||
          paths.some((path) => {
            const source =
              tab.source?.kind === 'vault' ? tab.source.note.path : tab.document?.vaultPath;
            return source === path || source?.startsWith(`${path}/`);
          })),
    );
    const choice = pending.length
      ? await ask({
          kind: 'guard',
          title,
          documents: pending.map((tab) => {
            if (tab.source?.kind === 'vault') {
              return tab.source.note.path;
            }
            return tab.source?.path || tab.retained?.path || sourceName(tab.source);
          }),
        })
      : 'save';
    if (choice !== 'save' && choice !== 'discard') {
      return false;
    }
    for (const tab of pending) {
      if (choice === 'save') {
        documents.activate(tab.id);
        if (!(await saveCurrent())) {
          return false;
        }
      } else if (choice === 'discard') {
        await documents.clearDraft(tab);
        documents.updateTab(tab.id, {
          text: tab.savedText,
          dirty: false,
          conflict: null,
          editorState: undefined,
          editorKey: nextRevision(),
        });
      } else {
        if (previous) {
          documents.activate(previous);
        }
        return false;
      }
    }
    if (previous) {
      documents.activate(previous);
    }
    await persistWorkspace();
    await persistence.flushDrafts();
    return true;
  }

  function activateTab(id: string) {
    if (operation.current || restoring.current) {
      return;
    }
    const activate = async () => {
      documents.activate(id);
      await hydrateTab(id);
      const tab = documents.tabsRef.current.find((item) => item.id === id);
      const path = tab?.source?.kind === 'vault' ? tab.source.note.path : tab?.document?.vaultPath;
      if (path && tab) {
        finder.navigate({ path, line: tab.line, column: tab.column }, tabIdentity(tab));
      }
      await persistWorkspace();
    };
    if (native) {
      run('background', activate);
    } else {
      void activate().catch(fail);
    }
  }

  function newTab() {
    if (operation.current || restoring.current || !documents.tabsRef.current.every(isEmptyDraft)) {
      return;
    }
    try {
      const id = documents.newDraft();
      documents.updateTab(id, { view: preferences.defaultView });
      void persistWorkspace().catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  function closeTab(id: string | null) {
    if (!id) {
      return;
    }
    const close = async () => {
      if (!(await guard('Close this tab?', undefined, [id]))) {
        return;
      }
      documents.close(id);
      await persistWorkspace();
    };
    if (native) {
      run('navigate', close);
    } else {
      void close().catch(fail);
    }
  }

  function reopenTab() {
    if (operation.current || restoring.current) {
      return;
    }
    try {
      const id = documents.reopenClosed();
      if (id) {
        activateTab(id);
      }
    } catch (error) {
      fail(error);
    }
  }

  function saveAll() {
    run('navigate', async () => {
      const original = documents.activeIdRef.current;
      const pending = documents.tabsRef.current.filter(
        (tab) => tab.kind === 'markdown' && !tab.restored && (tab.dirty || tab.conflict),
      );
      const outcomes: string[] = [];
      for (const tab of pending) {
        documents.activate(tab.id);
        try {
          const saved = await saveCurrent();
          if (!saved) {
            outcomes.push(`${sourceName(tab.source)}: not saved; changes retained`);
          }
        } catch (error) {
          outcomes.push(`${sourceName(tab.source)}: ${errorMessage(error)}`);
        }
      }
      if (original) {
        documents.activate(original);
      }
      await persistWorkspace();
      if (outcomes.length) {
        setNotice({ error: true, text: outcomes.join(' · ') });
      }
    });
  }

  function applyRefreshedNote(captured: SessionTab, note: NoteDocument) {
    const current = documents.tabsRef.current.find((tab) => tab.id === captured.id);
    if (!current || current.source?.kind !== 'vault') {
      return;
    }
    if (current.source.note.revision === note.revision && current.source.note.path === note.path) {
      return;
    }
    const changedIdentity = current.source.note.id !== note.id;
    if (
      current.dirty ||
      current.conflict ||
      current.editorKey !== captured.editorKey ||
      current.text !== captured.text ||
      changedIdentity
    ) {
      documents.updateTab(current.id, {
        ...(!changedIdentity ? { source: { kind: 'vault' as const, note } } : {}),
        conflict: {
          current: note,
          message:
            'The source changed. Your current text and history are retained; reload or save a recovery copy.',
        },
      });
      return;
    }
    documents.updateTab(current.id, {
      source: { kind: 'vault', note },
      text: note.text,
      savedText: note.text,
      conflict: null,
      ...(note.text !== current.text ? { editorState: undefined, editorKey: nextRevision() } : {}),
    });
  }

  async function refreshAffectedTab(tab: SessionTab, path: string) {
    const startedSession = session.current;
    const startedEpoch = epoch.current;
    const request = {};
    tabRefreshRequests.current.set(tab.id, request);
    const isCurrent = () => {
      const current = documents.tabsRef.current.find((item) => item.id === tab.id);
      return (
        mounted.current &&
        session.current === startedSession &&
        epoch.current === startedEpoch &&
        tabRefreshRequests.current.get(tab.id) === request &&
        current?.source === tab.source &&
        current?.document === tab.document &&
        current?.retained === tab.retained &&
        current?.identity === tab.identity
      );
    };
    try {
      if (!isCurrent()) {
        return;
      }
      const expectedIdentity = tabIdentity(tab);
      if (!expectedIdentity) {
        throw new Error(
          'This tab lacks a verified document identity. Its buffer is unchanged; close it and open the current file explicitly.',
        );
      }
      if (tab.kind === 'markdown') {
        const note = await invoke<NoteDocument>('vault_read_note', { path, expectedIdentity });
        if (isCurrent()) {
          applyRefreshedNote(tab, note);
        }
      } else {
        const doc = await invoke<SelectedDocument>('vault_open_document', { path });
        if (!isCurrent()) {
          return;
        }
        if (doc.identity !== expectedIdentity) {
          throw new Error(
            'This path now refers to a different document. Close the retained tab before opening its replacement.',
          );
        }
        documents.updateTab(tab.id, {
          document: {
            ...doc,
            bytes: Uint8Array.from(doc.bytes),
            revision: nextRevision(),
            vaultPath: path,
          },
        });
      }
    } catch (error) {
      if (isCurrent()) {
        documents.updateTab(tab.id, { conflict: { current: null, message: errorMessage(error) } });
        finder.markMissing(path);
      }
    } finally {
      if (tabRefreshRequests.current.get(tab.id) === request) {
        tabRefreshRequests.current.delete(tab.id);
      }
    }
  }

  function repairLocalStorage() {
    run('navigate', async () => {
      const confirmed = await ask({
        kind: 'confirm',
        title: 'Repair local workspace storage?',
        description:
          'Only malformed workspace and draft records for this Vault will be moved to preserved backup files. Valid records, current buffers, and all Vault source files stay unchanged.',
        confirmLabel: 'Preserve damaged records and resume',
      });
      if (confirmed !== 'confirm') {
        return;
      }
      const backups = await invoke<string[]>('workspace_repair_storage');
      await persistence.resumeStorage();
      setNotice({
        error: false,
        text: backups.length
          ? `Local storage resumed. Exact backups retained at: ${backups.join(' · ')}`
          : 'Local storage is valid. Workspace persistence resumed.',
      });
    });
  }

  async function onMutation(result: MutationResult) {
    const mappings = [...result.mappings].sort(
      (left, right) => right.from.length - left.from.length,
    );
    const remap = (path: string) => {
      const mapping = mappings.find(
        (item) => path === item.from || path.startsWith(`${item.from}/`),
      );
      return mapping ? mapping.to + path.slice(mapping.from.length) : path;
    };
    finder.remapPaths(mappings);
    for (const tab of documents.tabsRef.current) {
      const path =
        tab.source?.kind === 'vault'
          ? tab.source.note.path
          : (tab.document?.vaultPath ??
            (tab.retained?.sourceKind === 'vault' ? tab.retained.path : null));
      if (!path) {
        continue;
      }
      const nextPath = remap(path);
      if (
        nextPath === path &&
        !result.affectedPaths.some(
          (affected) => path === affected || path.startsWith(`${affected}/`),
        )
      ) {
        continue;
      }
      if (tab.retained) {
        documents.updateTab(tab.id, {
          retained: { ...tab.retained, path: nextPath, sourcePath: nextPath },
        });
        continue;
      }
      await refreshAffectedTab(tab, nextPath);
    }
    refreshPages();
    actions.current.refreshSnapshot();
    try {
      await persistWorkspace();
    } catch (error) {
      fail(
        new Error(
          `Files changed on disk, but the workspace could not be saved: ${errorMessage(error)}. Keep this window open and retry saving the workspace.`,
        ),
      );
    }
  }

  function save() {
    run(bufferRef.current.source?.kind === 'vault' ? 'save' : 'navigate', async () => {
      await saveCurrent();
      await persistWorkspace();
    });
  }

  function saveCopy() {
    run('navigate', async () => {
      await writeCopy(true);
      await persistWorkspace();
    });
  }

  function chooseVault(mode: 'create' | 'open') {
    run('navigate', async () => {
      if (!(await guard(mode === 'create' ? 'Create another Vault?' : 'Open another Vault?'))) {
        return;
      }

      const next = await selectVault(mode);
      if (!next) {
        return;
      }

      startVaultSession(next);
      documents.reset();
      await restoreWorkspace(next);
      await fileActions.refreshRecoveries(next.id);
    });
  }

  function closeVault() {
    run('navigate', async () => {
      if (!(await guard('Close this Vault?'))) {
        return;
      }

      await invoke('vault_close');
      startVaultSession(null);
      documents.reset();
      finder.setState({
        recent: [],
        favorites: [],
        history: [],
        historyIndex: -1,
        expanded: [],
        identities: {},
        favoriteIdentities: {},
      });
      setRecoveries([]);
      await persistence.resumeStorage();
    });
  }

  function runExplorerAction(id: string) {
    const action = explorerActions.current.find((candidate) => candidate.id === id);
    if (!action || action.disabled) {
      fail(new Error(action?.disabled ?? 'Open a Vault and select an explorer destination first.'));
      return;
    }
    void action.run();
  }

  function newNote() {
    runExplorerAction('explorer.new-note');
  }

  function importFiles() {
    runExplorerAction('explorer.import');
  }

  function adoptNote() {
    run('navigate', async () => {
      if (
        !(await guard(
          'Adopt this Markdown as a Note?',
          undefined,
          documents.activeIdRef.current ? [documents.activeIdRef.current] : [],
        ))
      ) {
        return;
      }
      const source = bufferRef.current.source;
      if (source?.kind !== 'vault') {
        return;
      }

      try {
        const note = await invoke<NoteDocument>('vault_adopt_note', {
          path: source.note.path,
          expectedRevision: source.note.revision,
        });
        replaceBufferState(note.text, { kind: 'vault', note });
        refreshQueued.current = true;
      } catch (error) {
        if (conflictError(error)) {
          updateBuffer({
            ...bufferRef.current,
            conflict: { current: error.current, message: error.message },
          });
        }
        throw error;
      }
    });
  }

  function openDocument() {
    run('background', async () => {
      const doc = await invoke<SelectedDocument | null>('pick_document');
      if (!doc) {
        return;
      }

      documents.openDocument({
        ...doc,
        bytes: Uint8Array.from(doc.bytes),
        revision: nextRevision(),
        vaultPath: null,
      });
      await persistWorkspace();
    });
  }

  function reloadDisk() {
    run('navigate', async () => {
      if (
        !(await guard(
          'Reload the disk version?',
          undefined,
          documents.activeIdRef.current ? [documents.activeIdRef.current] : [],
        ))
      ) {
        return;
      }
      const source = bufferRef.current.source;
      if (source?.kind !== 'vault') {
        return;
      }

      const note = await invoke<NoteDocument>('vault_read_note', { path: source.note.path });
      replaceBufferState(note.text, { kind: 'vault', note });
      refreshQueued.current = true;
    });
  }

  function openOriginal() {
    run('background', async () => {
      const source = bufferRef.current.source;
      let path: string | null = null;
      let vaultPath: string | null = null;
      if (showOriginal && selected) {
        path = selected.path;
        vaultPath = selected.vaultPath;
      } else if (source?.kind === 'standalone') {
        path = source.path;
      } else if (source?.kind === 'vault') {
        vaultPath = source.note.path;
      }

      if (vaultPath) {
        path = (await invoke<SelectedDocument>('vault_open_document', { path: vaultPath })).path;
      }
      if (path) {
        await invoke('open_document', { path });
      }
    });
  }

  async function refreshSnapshot() {
    if (!native || !vaultRef.current || snapshotRequest.current) {
      return;
    }
    const request = { session: session.current, generation: snapshotGeneration.current };
    snapshotRequest.current = request;

    try {
      const snapshot = await invoke<VaultSnapshot>('vault_refresh');
      if (
        mounted.current &&
        session.current === request.session &&
        snapshotGeneration.current === request.generation
      ) {
        setVault(snapshot);
      }
    } catch (error) {
      if (
        mounted.current &&
        session.current === request.session &&
        snapshotGeneration.current === request.generation
      ) {
        fail(error);
      }
    } finally {
      if (snapshotRequest.current === request) {
        snapshotRequest.current = null;
      }
      if (
        mounted.current &&
        session.current === request.session &&
        snapshotGeneration.current !== request.generation
      ) {
        void refreshSnapshot();
      }
    }
  }

  async function refreshOpenTabs() {
    for (const tab of documents.tabsRef.current) {
      if (operation.current) {
        noteRefreshQueued.current = true;
        break;
      }
      const path = tab.source?.kind === 'vault' ? tab.source.note.path : tab.document?.vaultPath;
      if (path && !tab.restored) {
        await refreshAffectedTab(tab, path);
      }
    }
  }

  async function refreshNote() {
    noteRefreshQueued.current = true;
    if (refreshingNote.current || operation.current || !vaultRef.current || !native) {
      return;
    }

    refreshingNote.current = true;
    try {
      while (
        noteRefreshQueued.current &&
        !operation.current &&
        vaultRef.current &&
        mounted.current
      ) {
        noteRefreshQueued.current = false;

        await refreshOpenTabs();
      }
    } finally {
      refreshingNote.current = false;
    }
  }

  function refresh() {
    if (!native || !vaultRef.current) {
      return;
    }
    if (operation.current) {
      refreshQueued.current = true;
      return;
    }
    epoch.current++;
    snapshotGeneration.current++;
    refreshPages();
    void refreshSnapshot();
    void refreshNote();
  }

  async function changeIndex(action: 'reconcile' | 'cancel') {
    if (!native || !vaultRef.current) {
      return;
    }
    const startedSession = session.current;
    const command = ++indexCommand.current;
    const generation = ++snapshotGeneration.current;
    setIndexAction(action);

    try {
      const snapshot = await invoke<VaultSnapshot>(
        action === 'cancel' ? 'vault_cancel_index' : 'vault_reconcile',
      );
      if (
        !mounted.current ||
        startedSession !== session.current ||
        command !== indexCommand.current
      ) {
        return;
      }
      if (generation === snapshotGeneration.current) {
        setVault(snapshot);
      }
      refresh();
    } catch (error) {
      if (
        mounted.current &&
        startedSession === session.current &&
        command === indexCommand.current
      ) {
        fail(error);
      }
    } finally {
      if (
        mounted.current &&
        startedSession === session.current &&
        command === indexCommand.current
      ) {
        setIndexAction(null);
      }
    }
  }

  async function requestClose() {
    if (closing.current || document.querySelector('dialog[open]')) {
      return;
    }
    closing.current = true;
    try {
      await operation.current;
      if (!mounted.current) {
        return;
      }
      run('navigate', async () => {
        if (!(await guard('Close Adamant?'))) {
          return;
        }
        confirmedClose.current = true;
        try {
          await getCurrentWindow().close();
        } catch (error) {
          confirmedClose.current = false;
          throw error;
        }
      });
      await operation.current;
    } finally {
      closing.current = false;
    }
  }

  useLayoutEffect(() => {
    actions.current = {
      flushDrafts: persistence.flushDrafts,
      refresh,
      refreshSnapshot: () => {
        void refreshSnapshot();
      },
      refreshNote: () => {
        void refreshNote();
      },
      close: () => {
        void requestClose();
      },
    };
  });

  const indexingActive = vault?.indexing.state === 'indexing';
  useEffect(() => {
    if (!native || !indexingActive) {
      return;
    }
    const timer = window.setInterval(() => actions.current.refreshSnapshot(), 250);
    return () => window.clearInterval(timer);
  }, [currentSession, indexingActive]);

  useEffect(() => {
    mounted.current = true;
    const sessionRef = session;
    const epochRef = epoch;

    return subscribeWorkspaceEvents(
      actions,
      confirmedClose,
      () => documents.tabsRef.current.some((tab) => tab.dirty || !!tab.conflict),
      fail,
      () => {
        mounted.current = false;
        sessionRef.current++;
        epochRef.current++;
      },
    );
  }, [documents.tabsRef, fail]);

  useEffect(() => {
    if (!native || !restoring.current) {
      return;
    }

    let disposed = false;
    const pending: Promise<void> = restoreVault(
      () => !disposed && mounted.current && operation.current === pending,
    ).finally(() => {
      if (disposed || operation.current !== pending) {
        return;
      }
      operation.current = null;
      restoring.current = false;
      if (mounted.current) {
        setBusy(null);
      }
    });
    operation.current = pending;

    return () => {
      disposed = true;
    };
  }, []);

  return {
    vault,
    documents: { ...documents, activate: activateTab, close: closeTab, reopenClosed: reopenTab },
    finder,
    fileActions,
    preferences,
    savePreferences,
    recoveries,
    recoverDraft,
    discardRecovery,
    recovery: persistence.recovery,
    inspectRecovery: persistence.inspectRecovery,
    cancelRecovery: persistence.cancelRecovery,
    saveAll,
    closeTab,
    closeActiveTab: () => closeTab(documents.activeId),
    reopenTab,
    newTab,
    openPath,
    openSearchHit,
    navigateHistory,
    revealActive,
    copyActiveLink,
    favoriteActive,
    copyLink,
    toggleFavorite,
    refreshPages,
    repairLocalStorage,
    setDirectoryOptions,
    registerExplorerActions: (next: UserAction[]) => {
      explorerActions.current = next;
    },
    getExplorerActions: () => explorerActions.current,
    revealPath,
    revealTarget,
    pages,
    indexing: vault?.indexing ?? null,
    indexAction,
    toggleDirectory,
    loadMore,
    buffer,
    selected,
    showOriginal,
    setShowOriginal,
    busy,
    notice,
    prompt,
    answer,
    reconcile: () => {
      void changeIndex('reconcile');
    },
    cancelIndex: () => {
      void changeIndex('cancel');
    },
    dirty: buffer.text !== buffer.savedText,
    changeText: (text: string) => {
      try {
        updateBuffer({ ...bufferRef.current, text });
      } catch (error) {
        const id = documents.activeIdRef.current;
        if (id) {
          documents.updateTab(id, { editorKey: nextRevision() });
        }
        fail(error);
      }
    },
    chooseVault,
    closeVault,
    newNote,
    importFiles,
    adoptNote,
    openEntry,
    openDocument,
    save,
    saveCopy,
    reloadDisk,
    openOriginal,
    fail,
    closeWindow: () => {
      void requestClose();
    },
  };
}
