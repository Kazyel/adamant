import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { errorMessage } from '../../shared/errors';
import type { SelectedDocument } from '../documents/types';
import { conflictError, useNoteBuffer } from './buffer';
import type { Source } from './buffer';
import type { NoteDocument, OpenedDocument, VaultEntry, VaultSnapshot } from './types';
import useDirectoryPages from './useDirectoryPages';
import subscribeWorkspaceEvents from './workspaceEvents';
import useWorkspacePrompt from './useWorkspacePrompt';

const native = isTauri();

export default function useWorkspace() {
  const [vault, setVaultState] = useState<VaultSnapshot | null>(null);
  const vaultRef = useRef(vault);
  const session = useRef(0);
  const [currentSession, setCurrentSession] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const confirmedClose = useRef(false);

  const {
    buffer,
    bufferRef,
    nextRevision,
    updateBuffer,
    replaceBuffer: replaceBufferState,
    refreshBuffer,
  } = useNoteBuffer();
  const { prompt, resolver, ask, answer, selectVault } = useWorkspacePrompt();
  const { pages, resetPages, clearPageRequests, refreshPages, toggleDirectory, loadMore } =
    useDirectoryPages(vaultRef, session, mounted);

  const snapshotGeneration = useRef(0);
  const snapshotRequest = useRef<{ session: number; generation: number } | null>(null);
  const [indexAction, setIndexAction] = useState<'reconcile' | 'cancel' | null>(null);
  const indexCommand = useRef(0);

  const [selected, setSelected] = useState<OpenedDocument | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'navigate' | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  const operation = useRef<Promise<void> | null>(null);
  const refreshingNote = useRef(false);
  const noteRefreshQueued = useRef(false);
  const refreshQueued = useRef(false);
  const closing = useRef(false);
  const actions = useRef({
    refresh: () => {},
    refreshSnapshot: () => {},
    refreshNote: () => {},
    save: () => {},
    close: () => {},
  });

  function setVault(next: VaultSnapshot | null) {
    vaultRef.current = next;
    setVaultState(next);
  }

  function startVaultSession(next: VaultSnapshot | null) {
    session.current++;
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

  function replaceBuffer(text: string, source: Source | null) {
    replaceBufferState(text, source);
    setShowOriginal(false);
  }

  function showNote(note: NoteDocument) {
    replaceBuffer(note.text, { kind: 'vault', note });
  }

  function fail(error: unknown) {
    setNotice({ error: true, text: errorMessage(error) });
  }

  function run(kind: 'save' | 'navigate', action: () => Promise<void>) {
    if (operation.current || !native) {
      return;
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
      .catch(fail)
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
    setSelected(null);
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
          : defaultNotePath('Untitled.md'),
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
      showNote(note);
    } else {
      updateBuffer({
        ...latest,
        savedText: note.text,
        source: { kind: 'vault', note },
        conflict: null,
      });
    }

    setNotice({
      error: false,
      text: recovery
        ? 'Recovery copy saved. Its raw source and identity are unchanged; any duplicate identity is listed in Vault issues.'
        : 'Note saved in the Vault. The standalone original is unchanged.',
    });
    refreshQueued.current = true;
    return bufferRef.current.text === bufferRef.current.savedText;
  }

  async function saveCurrent(): Promise<boolean> {
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

      setNotice({
        error: false,
        text:
          latest.text === note.text
            ? 'Saved to disk.'
            : 'Earlier changes saved. Your newer edits are still unsaved.',
      });
      refreshQueued.current = true;
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

  async function guard(title: string): Promise<boolean> {
    const current = bufferRef.current;
    if (current.text === current.savedText && !current.conflict) {
      return true;
    }

    const choice = await ask({ kind: 'guard', title });
    if (choice === 'discard') {
      return true;
    }
    if (choice === 'save') {
      return saveCurrent();
    }
    return false;
  }

  function save() {
    run(bufferRef.current.source?.kind === 'vault' ? 'save' : 'navigate', async () => {
      await saveCurrent();
    });
  }

  function saveCopy() {
    run('navigate', async () => {
      await writeCopy(true);
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
      replaceBuffer('', null);
      setSelected(null);
    });
  }

  function closeVault() {
    run('navigate', async () => {
      if (!(await guard('Close this Vault?'))) {
        return;
      }

      await invoke('vault_close');
      startVaultSession(null);
      replaceBuffer('', null);
      setSelected(null);
    });
  }

  function newNote() {
    run('navigate', async () => {
      if (!(await guard('Create a new Note?'))) {
        return;
      }

      const path = await ask({
        kind: 'path',
        title: 'New Note (.md)',
        initial: defaultNotePath('Untitled.md'),
        recovery: false,
      });
      if (!path) {
        return;
      }

      const note = await invoke<NoteDocument>('vault_create_note', { path, text: '' });
      showNote(note);
      refreshQueued.current = true;
    });
  }

  function importNote() {
    run('navigate', async () => {
      if (!(await guard('Import a Markdown Note?'))) {
        return;
      }

      const path = await ask({
        kind: 'path',
        title: 'Import .md into this Vault',
        initial: defaultNotePath('Imported.md'),
        recovery: false,
      });
      if (!path) {
        return;
      }

      const note = await invoke<NoteDocument | null>('vault_import_note', { path });
      if (!note) {
        return;
      }
      showNote(note);
      refreshQueued.current = true;
    });
  }

  function adoptNote() {
    run('navigate', async () => {
      if (!(await guard('Adopt this Markdown as a Note?'))) {
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
        showNote(note);
        setNotice({
          error: false,
          text: 'Markdown explicitly adopted. Existing source and unknown metadata are preserved.',
        });
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

  function openEntry(entry: VaultEntry) {
    if (entry.kind !== 'markdown' && entry.kind !== 'pdf' && entry.kind !== 'docx') {
      return;
    }

    run('navigate', async () => {
      if (
        entry.kind === 'markdown' &&
        bufferRef.current.source?.kind === 'vault' &&
        bufferRef.current.source.note.path === entry.path
      ) {
        setShowOriginal(false);
        return;
      }

      if (entry.kind === 'markdown') {
        if (!(await guard(`Open ${entry.path.split('/').at(-1)}?`))) {
          return;
        }
        showNote(await invoke<NoteDocument>('vault_read_note', { path: entry.path }));
      } else {
        const doc = await invoke<SelectedDocument>('vault_open_document', { path: entry.path });
        setSelected({
          ...doc,
          bytes: Uint8Array.from(doc.bytes),
          revision: nextRevision(),
          vaultPath: entry.path,
        });
        setShowOriginal(true);
      }
    });
  }

  function openDocument() {
    run('navigate', async () => {
      const doc = await invoke<SelectedDocument | null>('pick_document');
      if (!doc) {
        return;
      }

      if (doc.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Uint8Array.from(doc.bytes),
        );
        if (!(await guard(`Open ${doc.name}?`))) {
          return;
        }
        replaceBuffer(text, { kind: 'standalone', path: doc.path, name: doc.name });
      } else {
        setSelected({
          ...doc,
          bytes: Uint8Array.from(doc.bytes),
          revision: nextRevision(),
          vaultPath: null,
        });
        setShowOriginal(true);
      }
    });
  }

  function reloadDisk() {
    run('navigate', async () => {
      if (!(await guard('Reload the disk version?'))) {
        return;
      }
      const source = bufferRef.current.source;
      if (source?.kind !== 'vault') {
        return;
      }

      const note = await invoke<NoteDocument>('vault_read_note', { path: source.note.path });
      showNote(note);
      refreshQueued.current = true;
    });
  }

  function openOriginal() {
    run('navigate', async () => {
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
        setNotice({
          error: false,
          text: 'Open request sent to the default application. Unsaved edits are not included.',
        });
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

  function reportNoteRefreshError(
    error: unknown,
    path: string,
    editorKey: number,
    startedSession: number,
    startedEpoch: number,
  ) {
    if (!mounted.current || startedSession !== session.current || startedEpoch !== epoch.current) {
      return;
    }

    const latest = bufferRef.current;
    if (conflictError(error) && latest.editorKey === editorKey) {
      updateBuffer({ ...latest, conflict: { current: error.current, message: error.message } });
    }

    setNotice({ error: true, text: `Could not refresh ${path}: ${errorMessage(error)}` });
  }

  function refreshNoteBuffer(
    note: NoteDocument,
    editorKey: number,
    startedSession: number,
    startedEpoch: number,
  ) {
    if (!mounted.current || startedSession !== session.current || startedEpoch !== epoch.current) {
      return;
    }

    if (operation.current) {
      noteRefreshQueued.current = true;
      return;
    }

    refreshBuffer(note, editorKey);
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

        const started = epoch.current;
        const startedSession = session.current;
        const captured = bufferRef.current;
        if (captured.source?.kind !== 'vault') {
          continue;
        }

        const path = captured.source.note.path;
        let note: NoteDocument;
        try {
          note = await invoke<NoteDocument>('vault_read_note', { path });
        } catch (error) {
          reportNoteRefreshError(error, path, captured.editorKey, startedSession, started);
          continue;
        }

        refreshNoteBuffer(note, captured.editorKey, startedSession, started);
      }
    } finally {
      refreshingNote.current = false;
    }
  }

  function refresh() {
    if (!native || !vaultRef.current) {
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
    if (closing.current) {
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
      refresh,
      refreshSnapshot: () => {
        void refreshSnapshot();
      },
      refreshNote: () => {
        void refreshNote();
      },
      save,
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

    return subscribeWorkspaceEvents(actions, confirmedClose, bufferRef, resolver, fail, () => {
      mounted.current = false;
      sessionRef.current++;
      epochRef.current++;
    });
  }, [bufferRef, resolver]);

  return {
    vault,
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
    changeText: (text: string) => updateBuffer({ ...bufferRef.current, text }),
    chooseVault,
    closeVault,
    newNote,
    importNote,
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
