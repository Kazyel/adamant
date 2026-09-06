import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { errorMessage } from './document';
import type { SelectedDocument } from './document';

export interface VaultEntry {
  path: string;
  kind: 'directory' | 'markdown' | 'pdf' | 'docx';
  id: string | null;
  metadataError: string | null;
}
export interface IndexState {
  state: 'indexing' | 'ready' | 'partial' | 'stale' | 'cancelled';
  scannedEntries: number;
  indexedDocuments: number;
  message: string | null;
}
export interface VaultSnapshot {
  id: string;
  name: string;
  root: string;
  issues: { path: string; message: string }[];
  issueCount: number;
  indexing: IndexState;
}
export interface VaultPage {
  directory: string;
  offset: number;
  limit: number;
  entries: VaultEntry[];
  total: number;
  hasMore: boolean;
  indexing: IndexState;
}
export interface ExplorerPage {
  directory: string;
  entries: VaultEntry[];
  total: number;
  hasMore: boolean;
  indexing: IndexState | null;
  nextOffset: number;
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  generation: number;
}
export interface NoteDocument {
  path: string;
  text: string;
  revision: string;
  id: string | null;
  metadataError: string | null;
}
interface VaultError {
  kind: 'conflict' | 'invalid' | 'io';
  message: string;
  current: NoteDocument | null;
}
type Source = { kind: 'vault'; note: NoteDocument } | { kind: 'standalone'; path: string; name: string };
interface BufferState {
  text: string;
  savedText: string;
  source: Source | null;
  editorKey: number;
  conflict: { current: NoteDocument | null; message: string } | null;
}
export type OpenedDocument = Omit<SelectedDocument, 'bytes'> & {
  bytes: Uint8Array;
  revision: number;
  vaultPath: string | null;
};
export type WorkspacePrompt =
  | { kind: 'guard'; title: string }
  | { kind: 'path'; title: string; initial: string; recovery: boolean }
  | { kind: 'vault'; title: string }
  | { kind: 'create'; title: string; complete: (vault: VaultSnapshot) => void };
type Answer = string | null;
const native = isTauri();
function conflictError(error: unknown): error is VaultError {
  return typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'conflict';
}
export function sourceName(source: Source | null): string {
  return source?.kind === 'vault' ? source.note.path.split('/').at(-1)! : source?.name ?? 'Untitled';
}

export default function useWorkspace() {
  const [vault, setVaultState] = useState<VaultSnapshot | null>(null);
  const vaultRef = useRef(vault);
  const [buffer, setBufferState] = useState<BufferState>(() => ({ text: '', savedText: '', source: null, editorKey: 0, conflict: null }));
  const bufferRef = useRef(buffer);
  const [pages, setPagesState] = useState<ReadonlyMap<string, ExplorerPage>>(() => new Map());
  const pagesRef = useRef(pages);
  const session = useRef(0);
  const pageGeneration = useRef(0);
  const pageRequests = useRef(new Map<string, { session: number; generation: number }>());
  const snapshotGeneration = useRef(0);
  const snapshotRequest = useRef<{ session: number; generation: number } | null>(null);
  const [indexAction, setIndexAction] = useState<'reconcile' | 'cancel' | null>(null);
  const indexCommand = useRef(0);
  const [selected, setSelected] = useState<OpenedDocument | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'navigate' | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [prompt, setPrompt] = useState<WorkspacePrompt | null>(null);
  const resolver = useRef<((answer: Answer) => void) | null>(null);
  const operation = useRef<Promise<void> | null>(null);
  const epoch = useRef(0);
  const revision = useRef(0);
  const refreshingNote = useRef(false);
  const noteRefreshQueued = useRef(false);
  const refreshQueued = useRef(false);
  const mounted = useRef(true);
  const confirmedClose = useRef(false);
  const closing = useRef(false);
  const actions = useRef({ refresh: () => {}, refreshSnapshot: () => {}, refreshNote: () => {}, save: () => {}, close: () => {} });

  function updateBuffer(next: BufferState) {
    bufferRef.current = next;
    setBufferState(next);
  }
  function setVault(next: VaultSnapshot | null) {
    vaultRef.current = next;
    setVaultState(next);
  }
  function setPages(next: ReadonlyMap<string, ExplorerPage>) {
    pagesRef.current = next;
    setPagesState(next);
  }
  function emptyPage(directory: string): ExplorerPage {
    return { directory, entries: [], total: 0, hasMore: false, indexing: null, nextOffset: 0, loaded: false, loading: true, refreshing: false, error: null, generation: ++pageGeneration.current };
  }
  function startVaultSession(next: VaultSnapshot | null) {
    session.current++;
    epoch.current++;
    snapshotGeneration.current++;
    indexCommand.current++;
    pageRequests.current.clear();
    snapshotRequest.current = null;
    refreshQueued.current = false;
    noteRefreshQueued.current = false;
    setIndexAction(null);
    setVault(next);
    setPages(next ? new Map([['', emptyPage('')]]) : new Map());
    if (next) void fetchPage('');
  }
  function replaceBuffer(text: string, source: Source | null) {
    updateBuffer({ text, savedText: text, source, editorKey: ++revision.current, conflict: null });
    setShowOriginal(false);
  }
  function showNote(note: NoteDocument) {
    replaceBuffer(note.text, { kind: 'vault', note });
  }
  function fail(error: unknown) {
    setNotice({ error: true, text: errorMessage(error) });
  }
  function ask(next: WorkspacePrompt): Promise<Answer> {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setPrompt(next);
    });
  }
  function answer(value: Answer) {
    const resolve = resolver.current;
    resolver.current = null;
    setPrompt(null);
    resolve?.(value);
  }
  function run(kind: 'save' | 'navigate', action: () => Promise<void>) {
    if (operation.current || !native) return;
    epoch.current++;
    if (refreshingNote.current) noteRefreshQueued.current = true;
    if (kind === 'navigate') flushSync(() => setBusy(kind));
    else setBusy(kind);
    setNotice(null);
    // Defer until the lock is installed, including synchronous event callbacks.
    const pending = Promise.resolve().then(action).catch(fail).finally(() => {
      operation.current = null;
      if (mounted.current) {
        setBusy(null);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          actions.current.refresh();
        } else if (noteRefreshQueued.current) actions.current.refreshNote();
      }
    });
    operation.current = pending;
  }
  async function selectVault(mode: 'create' | 'open'): Promise<VaultSnapshot | null> {
    if (mode === 'open') return invoke<VaultSnapshot | null>('vault_open');
    // Match the ES2022 desktop target and the existing dialog resolver.
    return new Promise((resolve) => {
      resolver.current = () => resolve(null);
      setPrompt({ kind: 'create', title: 'Create Vault', complete: (snapshot) => {
        resolver.current = null;
        setPrompt(null);
        resolve(snapshot);
      } });
    });
  }
  async function destinationVault(): Promise<boolean> {
    if (vaultRef.current) return true;
    const mode = await ask({ kind: 'vault', title: 'Choose a Vault to save your Markdown' });
    if (mode !== 'create' && mode !== 'open') return false;
    const next = await selectVault(mode);
    if (!next) return false;
    startVaultSession(next);
    setSelected(null);
    return true;
  }
  async function writeCopy(recovery: boolean): Promise<boolean> {
    if (!await destinationVault()) return false;
    const current = bufferRef.current;
    const path = await ask({ kind: 'path', title: recovery ? 'Save recovery copy (.md)' : 'Save Markdown as a new Note (.md)', initial: current.source?.kind === 'vault' ? current.source.note.path.replace(/\.md$/i, '-recovery.md') : 'notes/Untitled.md', recovery });
    if (!path) return false;
    const captured = bufferRef.current;
    const note = await invoke<NoteDocument>(recovery ? 'vault_save_copy' : 'vault_create_note', { path, text: captured.text });
    const latest = bufferRef.current;
    if (latest === captured) showNote(note);
    else updateBuffer({ ...latest, savedText: note.text, source: { kind: 'vault', note }, conflict: null });
    setNotice({ error: false, text: recovery ? 'Recovery copy saved. Its raw source and identity are unchanged; any duplicate identity is listed in Vault issues.' : 'Note saved in the Vault. The standalone original is unchanged.' });
    refreshQueued.current = true;
    return bufferRef.current.text === bufferRef.current.savedText;
  }
  async function saveCurrent(): Promise<boolean> {
    const captured = bufferRef.current;
    if (captured.source?.kind !== 'vault') return writeCopy(false);
    if (captured.conflict) {
      setNotice({ error: true, text: 'The disk version changed. Cancel navigation, then reload disk or save a recovery copy.' });
      return false;
    }
    if (captured.text === captured.savedText) return true;
    try {
      const note = await invoke<NoteDocument>('vault_save_note', { path: captured.source.note.path, text: captured.text, expectedRevision: captured.source.note.revision });
      const latest = bufferRef.current;
      updateBuffer({ ...latest, savedText: note.text, source: { kind: 'vault', note }, conflict: null });
      setNotice({ error: false, text: latest.text === note.text ? 'Saved to disk.' : 'Earlier changes saved. Your newer edits are still unsaved.' });
      refreshQueued.current = true;
      return latest.text === note.text;
    } catch (error) {
      if (conflictError(error)) updateBuffer({ ...bufferRef.current, conflict: { current: error.current, message: error.message } });
      fail(error);
      return false;
    }
  }
  async function guard(title: string): Promise<boolean> {
    const current = bufferRef.current;
    if (current.text === current.savedText && !current.conflict) return true;
    const choice = await ask({ kind: 'guard', title });
    if (choice === 'discard') return true;
    if (choice === 'save') return saveCurrent();
    return false;
  }
  function save() {
    run(bufferRef.current.source?.kind === 'vault' ? 'save' : 'navigate', async () => { await saveCurrent(); });
  }
  function saveCopy() {
    run('navigate', async () => { await writeCopy(true); });
  }
  function chooseVault(mode: 'create' | 'open') {
    run('navigate', async () => {
      if (!await guard(mode === 'create' ? 'Create another Vault?' : 'Open another Vault?')) return;
      const next = await selectVault(mode);
      if (!next) return;
      startVaultSession(next);
      replaceBuffer('', null);
      setSelected(null);
    });
  }
  function closeVault() {
    run('navigate', async () => {
      if (!await guard('Close this Vault?')) return;
      await invoke('vault_close');
      startVaultSession(null);
      replaceBuffer('', null);
      setSelected(null);
    });
  }
  function newNote() {
    run('navigate', async () => {
      if (!await guard('Create a new Note?')) return;
      const path = await ask({ kind: 'path', title: 'New Note (.md)', initial: 'notes/Untitled.md', recovery: false });
      if (!path) return;
      const note = await invoke<NoteDocument>('vault_create_note', { path, text: '' });
      showNote(note);
      refreshQueued.current = true;
    });
  }
  function importNote() {
    run('navigate', async () => {
      if (!await guard('Import a Markdown Note?')) return;
      const path = await ask({ kind: 'path', title: 'Import .md into this Vault', initial: 'notes/Imported.md', recovery: false });
      if (!path) return;
      const note = await invoke<NoteDocument | null>('vault_import_note', { path });
      if (!note) return;
      showNote(note);
      refreshQueued.current = true;
    });
  }
  function adoptNote() {
    run('navigate', async () => {
      if (!await guard('Adopt this Markdown as a Note?')) return;
      const source = bufferRef.current.source;
      if (source?.kind !== 'vault') return;
      try {
        const note = await invoke<NoteDocument>('vault_adopt_note', { path: source.note.path, expectedRevision: source.note.revision });
        showNote(note);
        setNotice({ error: false, text: 'Markdown explicitly adopted. Existing source and unknown metadata are preserved.' });
        refreshQueued.current = true;
      } catch (error) {
        if (conflictError(error)) updateBuffer({ ...bufferRef.current, conflict: { current: error.current, message: error.message } });
        throw error;
      }
    });
  }
  function openEntry(entry: VaultEntry) {
    if (entry.kind !== 'markdown' && entry.kind !== 'pdf' && entry.kind !== 'docx') return;
    run('navigate', async () => {
      if (entry.kind === 'markdown' && bufferRef.current.source?.kind === 'vault' && bufferRef.current.source.note.path === entry.path) {
        setShowOriginal(false);
        return;
      }
      if (entry.kind === 'markdown') {
        if (!await guard(`Open ${entry.path.split('/').at(-1)}?`)) return;
        showNote(await invoke<NoteDocument>('vault_read_note', { path: entry.path }));
      } else {
        const doc = await invoke<SelectedDocument>('vault_open_document', { path: entry.path });
        setSelected({ ...doc, bytes: Uint8Array.from(doc.bytes), revision: ++revision.current, vaultPath: entry.path });
        setShowOriginal(true);
      }
    });
  }
  function openDocument() {
    run('navigate', async () => {
      const doc = await invoke<SelectedDocument | null>('pick_document');
      if (!doc) return;
      if (doc.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(doc.bytes));
        if (!await guard(`Open ${doc.name}?`)) return;
        replaceBuffer(text, { kind: 'standalone', path: doc.path, name: doc.name });
      } else {
        setSelected({ ...doc, bytes: Uint8Array.from(doc.bytes), revision: ++revision.current, vaultPath: null });
        setShowOriginal(true);
      }
    });
  }
  function reloadDisk() {
    run('navigate', async () => {
      if (!await guard('Reload the disk version?')) return;
      const source = bufferRef.current.source;
      if (source?.kind !== 'vault') return;
      const note = await invoke<NoteDocument>('vault_read_note', { path: source.note.path });
      showNote(note);
      refreshQueued.current = true;
    });
  }
  function openOriginal() {
    run('navigate', async () => {
      const source = bufferRef.current.source;
      let path = showOriginal && selected ? selected.path : source?.kind === 'standalone' ? source.path : null;
      const vaultPath = showOriginal && selected ? selected.vaultPath : source?.kind === 'vault' ? source.note.path : null;
      if (vaultPath) path = (await invoke<SelectedDocument>('vault_open_document', { path: vaultPath })).path;
      if (path) {
        await invoke('open_document', { path });
        setNotice({ error: false, text: 'Open request sent to the default application. Unsaved edits are not included.' });
      }
    });
  }
  async function fetchPage(directory: string) {
    const page = pagesRef.current.get(directory);
    if (!native || !vaultRef.current || !page?.loading || pageRequests.current.has(directory)) return;
    const request = { session: session.current, generation: page.generation };
    pageRequests.current.set(directory, request);
    try {
      let offset = page.refreshing ? 0 : page.nextOffset;
      const through = page.refreshing ? Math.max(100, page.nextOffset) : offset + 100;
      const entries = page.refreshing ? [] : page.entries.slice();
      const known = new Set(entries.map((entry) => entry.path));
      let result: VaultPage;
      do {
        result = await invoke<VaultPage>('vault_list_entries', { directory, offset, limit: 100 });
        if (!mounted.current || session.current !== request.session || pagesRef.current.get(directory)?.generation !== request.generation) return;
        if (result.directory !== directory || result.offset !== offset || (result.hasMore && result.entries.length === 0)) {
          throw new Error('The directory changed while loading. Retry this listing.');
        }
        for (const entry of result.entries) {
          if (!known.has(entry.path)) {
            known.add(entry.path);
            entries.push(entry);
          }
        }
        offset += result.entries.length;
      } while (result.hasMore && offset < through);
      const next = new Map(pagesRef.current);
      next.set(directory, { ...page, entries, total: result.total, hasMore: result.hasMore, indexing: result.indexing, nextOffset: offset, loaded: true, loading: false, refreshing: false, error: null });
      // Only a fully enumerated, ready parent can confirm an expanded child is gone.
      if (!result.hasMore && result.indexing.state === 'ready') {
        const directories = new Set(entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path));
        for (const child of next.keys()) {
          if (!child || child === directory) continue;
          const separator = child.lastIndexOf('/');
          const parent = separator < 0 ? '' : child.slice(0, separator);
          if (parent === directory && !directories.has(child)) {
            for (const descendant of next.keys()) {
              if (descendant === child || descendant.startsWith(`${child}/`)) next.delete(descendant);
            }
          }
        }
      }
      setPages(next);
    } catch (error) {
      if (mounted.current && session.current === request.session && pagesRef.current.get(directory)?.generation === request.generation) {
        const next = new Map(pagesRef.current);
        next.set(directory, { ...page, loading: false, error: errorMessage(error) });
        setPages(next);
      }
    } finally {
      if (pageRequests.current.get(directory) === request) pageRequests.current.delete(directory);
      // Keep visible rows while the newest generation revalidates their loaded
      // extent. An obsolete response never replaces or appends to that generation.
      if (mounted.current && session.current === request.session && pagesRef.current.get(directory)?.loading) void fetchPage(directory);
    }
  }
  function toggleDirectory(directory: string, open: boolean) {
    if (!native || !vaultRef.current) return;
    const next = new Map(pagesRef.current);
    if (open) {
      if (next.has(directory)) return;
      next.set(directory, emptyPage(directory));
    } else {
      for (const path of next.keys()) {
        if (path === directory || path.startsWith(`${directory}/`)) next.delete(path);
      }
    }
    setPages(next);
    if (open) void fetchPage(directory);
  }
  function loadMore(directory: string) {
    const page = pagesRef.current.get(directory);
    if (!page || page.loading || (page.loaded && !page.hasMore && !page.error)) return;
    const next = new Map(pagesRef.current);
    next.set(directory, { ...page, loading: true, error: null, generation: ++pageGeneration.current });
    setPages(next);
    void fetchPage(directory);
  }
  async function refreshSnapshot() {
    if (!native || !vaultRef.current || snapshotRequest.current) return;
    const request = { session: session.current, generation: snapshotGeneration.current };
    snapshotRequest.current = request;
    try {
      const snapshot = await invoke<VaultSnapshot>('vault_refresh');
      if (mounted.current && session.current === request.session && snapshotGeneration.current === request.generation) setVault(snapshot);
    } catch (error) {
      if (mounted.current && session.current === request.session && snapshotGeneration.current === request.generation) fail(error);
    } finally {
      if (snapshotRequest.current === request) snapshotRequest.current = null;
      if (mounted.current && session.current === request.session && snapshotGeneration.current !== request.generation) void refreshSnapshot();
    }
  }
  async function refreshNote() {
    noteRefreshQueued.current = true;
    if (refreshingNote.current || operation.current || !vaultRef.current || !native) return;
    refreshingNote.current = true;
    try {
      while (noteRefreshQueued.current && !operation.current && vaultRef.current && mounted.current) {
        noteRefreshQueued.current = false;
        const started = epoch.current;
        const startedSession = session.current;
        const captured = bufferRef.current;
        if (captured.source?.kind !== 'vault') continue;
        const path = captured.source.note.path;
        let note: NoteDocument;
        try { note = await invoke<NoteDocument>('vault_read_note', { path }); }
        catch (error) {
          if (mounted.current && startedSession === session.current && started === epoch.current) {
            const latest = bufferRef.current;
            if (conflictError(error) && latest.editorKey === captured.editorKey) {
              updateBuffer({ ...latest, conflict: { current: error.current, message: error.message } });
            }
            setNotice({ error: true, text: `Could not refresh ${path}: ${errorMessage(error)}` });
          }
          continue;
        }
        if (!mounted.current || startedSession !== session.current || started !== epoch.current) continue;
        if (operation.current) { noteRefreshQueued.current = true; break; }
        const latest = bufferRef.current;
        if (latest.source?.kind !== 'vault' || latest.editorKey !== captured.editorKey) continue;
        if (note.revision === latest.source.note.revision) {
          updateBuffer({ ...latest, source: { kind: 'vault', note }, conflict: null });
        } else if (latest.text === latest.savedText && !latest.conflict) {
          updateBuffer({ text: note.text, savedText: note.text, source: { kind: 'vault', note }, editorKey: ++revision.current, conflict: null });
        } else {
          updateBuffer({ ...latest, conflict: { current: note, message: 'This Note changed on disk. Your editor buffer has been kept.' } });
        }
      }
    } finally {
      refreshingNote.current = false;
    }
  }
  function refresh() {
    if (!native || !vaultRef.current) return;
    epoch.current++;
    snapshotGeneration.current++;
    // Only root and expanded branches exist in this map; unopened folders are
    // never enumerated, and collapsed subtrees release their pages.
    const next = new Map<string, ExplorerPage>();
    for (const [directory, page] of pagesRef.current) {
      next.set(directory, { ...page, loading: true, refreshing: true, error: null, generation: ++pageGeneration.current });
    }
    setPages(next);
    for (const directory of next.keys()) void fetchPage(directory);
    void refreshSnapshot();
    void refreshNote();
  }
  async function changeIndex(action: 'reconcile' | 'cancel') {
    if (!native || !vaultRef.current) return;
    const startedSession = session.current;
    const command = ++indexCommand.current;
    const generation = ++snapshotGeneration.current;
    setIndexAction(action);
    try {
      const snapshot = await invoke<VaultSnapshot>(action === 'cancel' ? 'vault_cancel_index' : 'vault_reconcile');
      if (!mounted.current || startedSession !== session.current || command !== indexCommand.current) return;
      if (generation === snapshotGeneration.current) setVault(snapshot);
      refresh();
    } catch (error) {
      if (mounted.current && startedSession === session.current && command === indexCommand.current) fail(error);
    } finally {
      if (mounted.current && startedSession === session.current && command === indexCommand.current) setIndexAction(null);
    }
  }
  async function requestClose() {
    if (closing.current) return;
    closing.current = true;
    try {
      await operation.current;
      if (!mounted.current) return;
      run('navigate', async () => {
        if (!await guard('Close Adamant?')) return;
        confirmedClose.current = true;
        try { await getCurrentWindow().close(); }
        catch (error) { confirmedClose.current = false; throw error; }
      });
      await operation.current;
    } finally {
      closing.current = false;
    }
  }
  actions.current = { refresh, refreshSnapshot: () => { void refreshSnapshot(); }, refreshNote: () => { void refreshNote(); }, save, close: () => { void requestClose(); } };
  const currentSession = session.current;
  const indexingActive = vault?.indexing.state === 'indexing';
  useEffect(() => {
    if (!native || !indexingActive) return;
    const timer = window.setInterval(() => actions.current.refreshSnapshot(), 250);
    return () => window.clearInterval(timer);
  }, [currentSession, indexingActive]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    function registered(unlisten: () => void) {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }
    if (native) {
      void listen('vault-changed', () => { if (!disposed) actions.current.refresh(); }).then(registered).catch((error: unknown) => { if (!disposed) fail(error); });
      void getCurrentWindow().onCloseRequested((event) => {
        if (disposed || confirmedClose.current) return;
        event.preventDefault();
        actions.current.close();
      }).then(registered).catch((error: unknown) => { if (!disposed) fail(error); });
    }
    const saveKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!resolver.current) actions.current.save();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      const current = bufferRef.current;
      if (!confirmedClose.current && (current.text !== current.savedText || current.conflict)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('keydown', saveKey, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      disposed = true;
      mounted.current = false;
      session.current++;
      epoch.current++;
      unlisteners.forEach((unlisten) => unlisten());
      window.removeEventListener('keydown', saveKey, true);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);

  return {
    vault, pages, indexing: vault?.indexing ?? null, indexAction, toggleDirectory, loadMore,
    buffer, selected, showOriginal, setShowOriginal, busy, notice, prompt, answer,
    reconcile: () => { void changeIndex('reconcile'); }, cancelIndex: () => { void changeIndex('cancel'); },
    dirty: buffer.text !== buffer.savedText,
    changeText: (text: string) => updateBuffer({ ...bufferRef.current, text }),
    chooseVault, closeVault, newNote, importNote, adoptNote, openEntry, openDocument,
    save, saveCopy, reloadDisk, openOriginal, fail,
    closeWindow: () => { void requestClose(); },
  };
}
