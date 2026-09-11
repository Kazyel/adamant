import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import type { MutableRefObject } from 'react';
import type { OpenedDocument, NoteDocument } from '../types';
import { sourceKey, sourceName } from '../buffer.ts';
import type { Source, BufferState } from '../buffer';
import {
  draftDelete,
  draftSave,
  type DraftRecord,
  type WorkspacePersistenceState,
  type WorkspaceTabState,
} from './persistence.ts';

interface ViewerState {
  page: number;
  zoom: number;
  scrollTop?: number;
}

export interface SessionTab {
  id: string;
  kind: 'markdown' | 'pdf' | 'docx';
  source: Source | null;
  document: OpenedDocument | null;
  text: string;
  savedText: string;
  dirty: boolean;
  conflict: BufferState['conflict'];
  view: 'edit' | 'read' | 'split';
  showOriginal: boolean;
  line: number;
  column: number;
  editorKey: number;
  editorState?: EditorState;
  viewerState: ViewerState;
  draftId: string | null;
  draftScope?: Pick<DraftRecord, 'root' | 'vaultId'>;
  restored: boolean;
  hydration?: { state: 'loading' } | { state: 'error'; message: string };
  identity?: string | null;
  retained?: WorkspaceTabState;
}

export interface DocumentSession {
  buffer: BufferState;
  bufferRef: MutableRefObject<BufferState>;
  nextRevision: () => number;
  updateBuffer: (next: BufferState) => void;
  replaceBuffer: (text: string, source: Source | null) => void;
  refreshBuffer: (note: NoteDocument, editorKey: number) => void;
  tabs: SessionTab[];
  tabsRef: MutableRefObject<SessionTab[]>;
  activeId: string | null;
  activeIdRef: MutableRefObject<string | null>;
  selected: OpenedDocument | null;
  activeTab: SessionTab | null;
  dirtyTabs: SessionTab[];
  closedTabs: SessionTab[];
  showOriginal: boolean;
  setShowOriginal: (show: boolean) => void;
  openNote: (note: NoteDocument, identity?: string | null) => string;
  openDocument: (document: OpenedDocument) => string;
  activate: (id: string) => void;
  setSelected: (id: string) => void;
  close: (id: string) => void;
  updateTab: (id: string, updater: Partial<SessionTab> | ((tab: SessionTab) => SessionTab)) => void;
  setEditorState: (id: string, state: EditorState, expectedEditorKey?: number) => void;
  reset: () => void;
  newDraft: () => string;
  persist: (
    root: string,
    vaultId: string,
    navigation?: WorkspacePersistenceState['navigation'],
  ) => WorkspacePersistenceState;
  restore: (state: WorkspacePersistenceState, root: string, vaultId: string) => boolean;
  requestClose: (
    ids: string[],
    decide: (dirty: DirtyTab[]) => Promise<CloseDecision>,
    save: (dirty: DirtyTab[]) => Promise<boolean>,
  ) => Promise<boolean>;
  reopenClosed: () => string | null;
  hydrateTab: (
    id: string,
    document: NoteDocument | OpenedDocument,
    identity?: string | null,
  ) => boolean;
  retainDraft: (tab: SessionTab, root: string, vaultId: string) => Promise<boolean>;
  scheduleDraft: (
    tab: SessionTab,
    root: string,
    vaultId: string,
    onError: (error: unknown) => void,
  ) => void;
  clearDraft: (tab: SessionTab) => Promise<boolean>;
}

type CloseDecision = 'save' | 'discard' | 'cancel';
export type DirtyTab = Pick<SessionTab, 'id' | 'kind' | 'source' | 'dirty' | 'conflict'>;
export interface SaveTabResult {
  id: string;
  ok: boolean;
  error: unknown;
}

export async function saveDirtyTabs(
  tabs: readonly DirtyTab[],
  save: (tab: DirtyTab) => Promise<void>,
): Promise<SaveTabResult[]> {
  return Promise.all(
    tabs.map(async (tab) => {
      try {
        await save(tab);
        return { id: tab.id, ok: true, error: null };
      } catch (error) {
        return { id: tab.id, ok: false, error };
      }
    }),
  );
}

const CLOSED_LIMIT = 12;
const OPEN_LIMIT = 64;
const SOURCE_BYTE_LIMIT = 256 * 1024 * 1024;
const retainedSizes = new WeakMap<SessionTab, number>();

function utf8Size(text: string): number {
  let size = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x7f) {
      size += 1;
    } else if (code <= 0x7ff) {
      size += 2;
    } else if (code <= 0xffff) {
      size += 3;
    } else {
      size += 4;
    }
  }
  return size;
}

function retainedSize(tab: SessionTab): number {
  const cached = retainedSizes.get(tab);
  if (cached !== undefined) {
    return cached;
  }
  const texts = new Set([
    tab.text,
    tab.savedText,
    tab.source?.kind === 'vault' ? tab.source.note.text : '',
    tab.conflict?.current?.text ?? '',
  ]);
  let bytes = tab.document?.bytes.byteLength ?? 0;
  for (const text of texts) {
    bytes += utf8Size(text);
  }
  retainedSizes.set(tab, bytes);
  return bytes;
}

function assertCapacity(tabs: readonly SessionTab[], closed: readonly SessionTab[]) {
  if (tabs.length > OPEN_LIMIT) {
    throw new Error(
      'The workspace supports up to 64 open tabs. Close a tab before opening or creating another; your existing tabs are unchanged.',
    );
  }
  let bytes = 0;
  for (const tab of tabs) {
    bytes += retainedSize(tab);
  }
  for (const tab of closed) {
    bytes += retainedSize(tab);
  }
  if (bytes > SOURCE_BYTE_LIMIT) {
    throw new Error(
      'The workspace retains up to 256 MiB of source data, including recently closed documents. Save your drafts, then close and reopen the Vault to release retained documents before opening another large file. Existing tabs are unchanged.',
    );
  }
}
let nextTabNumber = 0;

function makeId(): string {
  nextTabNumber += 1;
  return `tab-${Date.now().toString(36)}-${nextTabNumber.toString(36)}`;
}

function noteTab(note: NoteDocument, key: number): SessionTab {
  return {
    id: makeId(),
    kind: 'markdown',
    source: { kind: 'vault', note },
    document: null,
    text: note.text,
    savedText: note.text,
    dirty: false,
    conflict: null,
    view: 'edit',
    showOriginal: false,
    line: 1,
    column: 1,
    editorKey: key,
    viewerState: { page: 1, zoom: 1 },
    draftId: null,
    restored: false,
  };
}

function viewerTab(document: OpenedDocument, key: number): SessionTab {
  return {
    id: makeId(),
    kind: document.kind,
    source: null,
    document,
    text: '',
    savedText: '',
    dirty: false,
    conflict: null,
    view: 'read',
    showOriginal: true,
    line: 1,
    column: 1,
    editorKey: key,
    viewerState: { page: 1, zoom: 1 },
    draftId: null,
    restored: false,
  };
}

function keyFor(tab: Pick<SessionTab, 'id' | 'kind' | 'source' | 'document' | 'retained'>): string {
  if (tab.source) {
    return tab.source.kind === 'standalone' && !tab.source.path
      ? `untitled:${tab.id}`
      : `${tab.kind}:${sourceKey(tab.source)}`;
  }
  if (tab.document) {
    return `${tab.kind}:${tab.document.vaultPath ? 'vault' : 'standalone'}:${tab.document.vaultPath ?? tab.document.path}`;
  }
  if (tab.retained) {
    return `${tab.kind}:${tab.retained.sourceKind}:${tab.retained.path}`;
  }
  return `untitled:${tab.id}`;
}
function blankTab(key: number): SessionTab {
  return {
    id: makeId(),
    kind: 'markdown',
    source: { kind: 'standalone', path: '', name: sourceName(null) },
    document: null,
    text: '',
    savedText: '',
    dirty: false,
    conflict: null,
    view: 'edit',
    showOriginal: false,
    line: 1,
    column: 1,
    editorKey: key,
    viewerState: { page: 1, zoom: 1 },
    draftId: null,
    restored: false,
  };
}

export function isEmptyDraft(tab: SessionTab): boolean {
  return (
    tab.kind === 'markdown' &&
    tab.source?.kind === 'standalone' &&
    !tab.source.path &&
    !tab.document &&
    !tab.text &&
    !tab.savedText &&
    !tab.dirty &&
    !tab.conflict &&
    !tab.draftId &&
    !tab.restored
  );
}

function tabOrigin(tab: SessionTab): Pick<WorkspaceTabState, 'sourcePath' | 'sourceKind'> {
  let sourcePath: string | null = null;
  let sourceKind: WorkspaceTabState['sourceKind'] = 'untitled';
  if (tab.source?.kind === 'vault') {
    sourcePath = tab.source.note.path;
    sourceKind = 'vault';
  } else if (tab.source?.kind === 'standalone' && tab.source.path) {
    sourcePath = tab.source.path;
    sourceKind = 'standalone';
  }
  if (tab.document) {
    sourceKind = tab.document.vaultPath ? 'vault' : 'standalone';
  }
  return { sourcePath, sourceKind };
}

function tabName(tab: SessionTab): string {
  if (tab.document) {
    return tab.document.name;
  }
  return sourceName(tab.source);
}

function sourceIdentity(source: Source | null, fallback?: string | null): string | null {
  if (source?.kind === 'vault' && source.note.id) {
    return `uuid:${source.note.id}`;
  }
  return fallback ?? null;
}

function documentIdentity(document: NoteDocument | OpenedDocument): string | null | undefined {
  if ('text' in document) {
    return document.id ? `uuid:${document.id}` : null;
  }
  return document.identity;
}

export function tabIdentity(tab: SessionTab): string | null {
  return tab.restored && tab.retained
    ? (tab.retained.identity ?? null)
    : sourceIdentity(tab.source, tab.document?.identity ?? tab.identity);
}

export function tabPersistence(tab: SessionTab): WorkspaceTabState {
  if (tab.restored && tab.retained) {
    return {
      ...tab.retained,
      view: tab.view,
      showOriginal: tab.showOriginal,
      page: tab.viewerState.page,
      zoom: tab.viewerState.zoom,
      scrollTop: tab.viewerState.scrollTop ?? 0,
      line: tab.line,
      column: tab.column,
    };
  }
  const { sourcePath, sourceKind } = tabOrigin(tab);
  return {
    id: tab.id,
    kind: tab.kind,
    path: tab.document?.vaultPath ?? sourcePath ?? tab.document?.path ?? '',
    name: tabName(tab),
    sourcePath,
    sourceKind,
    identity: tabIdentity(tab),
    baseRevision: tab.source?.kind === 'vault' ? tab.source.note.revision : null,
    view: tab.view,
    showOriginal: tab.showOriginal,
    page: tab.viewerState.page,
    zoom: tab.viewerState.zoom,
    scrollTop: tab.viewerState.scrollTop ?? 0,
    line: tab.line,
    column: tab.column,
  };
}

function bufferFor(tab: SessionTab | null): BufferState {
  return tab
    ? {
        text: tab.text,
        savedText: tab.savedText,
        source: tab.source,
        editorKey: tab.editorKey,
        conflict: tab.conflict,
      }
    : { text: '', savedText: '', source: null, editorKey: 0, conflict: null };
}
export function useDocumentSession(
  defaultView: () => SessionTab['view'] = () => 'edit',
): DocumentSession {
  const [tabs, setTabs] = useState<SessionTab[]>(() => [blankTab(0)]);
  const [activeId, setActiveId] = useState<string | null>(() => tabs[0].id);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const buffer = useMemo<BufferState>(() => bufferFor(active), [active]);
  const [closed, setClosed] = useState<SessionTab[]>([]);
  const tabsRef = useRef(tabs);
  const closedRef = useRef(closed);
  const activeIdRef = useRef(activeId);
  const revision = useRef(0);
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftWrites = useRef(new Map<string, Promise<boolean>>());
  const lifecycle = useRef(0);
  const scheduledDrafts = useRef(new Map<string, string>());
  const bufferRef = useRef<BufferState>(buffer);

  const sync = useCallback((next: SessionTab[], retainedClosed = closedRef.current) => {
    assertCapacity(next, retainedClosed);
    tabsRef.current = next;
    bufferRef.current = bufferFor(next.find((tab) => tab.id === activeIdRef.current) ?? null);
    setTabs(next);
  }, []);
  const activate = useCallback((id: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    if (!tab) {
      return;
    }
    activeIdRef.current = id;
    bufferRef.current = bufferFor(tab);
    setActiveId(id);
  }, []);
  const addTab = useCallback(
    (tab: SessionTab, retainedClosed = closedRef.current) => {
      const next = tabsRef.current.filter((candidate) => !isEmptyDraft(candidate));
      next.push(tab);
      sync(next, retainedClosed);
      activate(tab.id);
      return tab.id;
    },
    [activate, sync],
  );
  const showOriginal = active?.showOriginal ?? false;

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(
    () => () => {
      draftTimers.current.forEach((timer) => clearTimeout(timer));
    },
    [],
  );

  const updateTab = useCallback(
    (id: string, updater: Partial<SessionTab> | ((tab: SessionTab) => SessionTab)) => {
      const next = tabsRef.current.map((tab) => {
        if (tab.id !== id) {
          return tab;
        }
        const updated = typeof updater === 'function' ? updater(tab) : { ...tab, ...updater };
        if (
          updated.text === tab.text &&
          updated.savedText === tab.savedText &&
          updated.source === tab.source &&
          updated.conflict === tab.conflict &&
          updated.document === tab.document
        ) {
          retainedSizes.set(updated, retainedSize(tab));
        }
        return updated;
      });
      sync(next);
    },
    [sync],
  );

  const nextRevision = useCallback(() => ++revision.current, []);
  const ensureActive = useCallback(() => {
    const existing =
      activeIdRef.current && tabsRef.current.find((tab) => tab.id === activeIdRef.current);
    if (existing) {
      return existing;
    }
    const tab = blankTab(++revision.current);
    sync([...tabsRef.current, tab]);
    activeIdRef.current = tab.id;
    setActiveId(tab.id);
    return tab;
  }, [sync]);

  const replaceBuffer = useCallback(
    (text: string, source: Source | null) => {
      const tab = ensureActive();
      updateTab(tab.id, {
        kind: 'markdown',
        source,
        document: null,
        text,
        savedText: text,
        dirty: false,
        conflict: null,
        editorKey: ++revision.current,
        editorState: undefined,
        showOriginal: false,
        view: 'edit',
      });
    },
    [ensureActive, updateTab],
  );

  const updateBuffer = useCallback(
    (next: BufferState) => {
      const tab = ensureActive();
      updateTab(tab.id, {
        kind: 'markdown',
        source: next.source,
        document: null,
        text: next.text,
        savedText: next.savedText,
        dirty: next.text !== next.savedText,
        conflict: next.conflict,
        editorKey: next.editorKey,
        ...(next.editorKey !== tab.editorKey && next.text !== tab.text
          ? { editorState: undefined }
          : {}),
      });
    },
    [ensureActive, updateTab],
  );
  const hydrateTab = useCallback(
    (id: string, document: NoteDocument | OpenedDocument, identity?: string | null) => {
      const old = tabsRef.current.find((tab) => tab.id === id);
      if (!old || old.dirty || old.conflict || !old.restored) {
        return false;
      }
      const actualIdentity = identity ?? documentIdentity(document);
      if (!old.retained?.identity || old.retained.identity !== actualIdentity) {
        throw new Error(
          'The saved tab no longer refers to the same document or lacks a verified identity. Its buffer is unchanged; close it and open the current file explicitly.',
        );
      }
      let next: SessionTab;
      if ('text' in document) {
        next = noteTab(document, ++revision.current);
      } else if (document.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          document.bytes,
        );
        const source: Source = { kind: 'standalone', path: document.path, name: document.name };
        next = {
          ...blankTab(++revision.current),
          source,
          text,
          savedText: text,
          identity: document.identity,
        };
      } else {
        next = viewerTab(document, ++revision.current);
      }
      sync(
        tabsRef.current.map((tab) =>
          tab.id === id
            ? {
                ...next,
                id,
                identity: actualIdentity,
                view: old.view,
                showOriginal: old.showOriginal,
                line: old.line,
                column: old.column,
                viewerState: old.viewerState,
                draftId: old.draftId,
                draftScope: old.draftScope,
                restored: false,
                retained: undefined,
              }
            : tab,
        ),
      );
      return true;
    },
    [sync],
  );
  const openNote = useCallback(
    (note: NoteDocument, identity?: string | null) => {
      const existing = tabsRef.current.find((tab) => keyFor(tab) === `markdown:vault:${note.path}`);
      if (existing) {
        if (existing.restored) {
          hydrateTab(existing.id, note, identity);
        } else if (existing.dirty || existing.conflict) {
          if (
            existing.source?.kind === 'vault' &&
            (existing.source.note.revision !== note.revision || existing.source.note.id !== note.id)
          ) {
            updateTab(existing.id, {
              conflict: {
                current: note,
                message: 'This Note changed on disk. Your editor buffer has been kept.',
              },
            });
          }
        } else {
          updateTab(existing.id, {
            source: { kind: 'vault', note },
            text: note.text,
            savedText: note.text,
            conflict: null,
            ...(note.text !== existing.text
              ? { editorKey: ++revision.current, editorState: undefined }
              : {}),
          });
        }
        activate(existing.id);
        return existing.id;
      }
      const tab = { ...noteTab(note, ++revision.current), identity, view: defaultView() };
      return addTab(tab);
    },
    [activate, addTab, defaultView, hydrateTab, updateTab],
  );

  const refreshBuffer = useCallback(
    (note: NoteDocument, editorKey: number) => {
      const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
      if (
        !tab ||
        tab.source?.kind !== 'vault' ||
        tab.editorKey !== editorKey ||
        tab.source.note.path !== note.path
      ) {
        return;
      }
      if (note.revision === tab.source.note.revision && note.id === tab.source.note.id) {
        updateTab(tab.id, { source: { kind: 'vault', note }, conflict: null });
      } else if (tab.dirty || tab.conflict) {
        updateTab(tab.id, {
          conflict: {
            current: note,
            message: 'This Note changed on disk. Your editor buffer has been kept.',
          },
        });
      } else {
        updateTab(tab.id, {
          source: { kind: 'vault', note },
          text: note.text,
          savedText: note.text,
          dirty: false,
          conflict: null,
          ...(note.text !== tab.text
            ? { editorKey: ++revision.current, editorState: undefined }
            : {}),
        });
      }
    },
    [updateTab],
  );

  const openDocument = useCallback(
    (document: OpenedDocument) => {
      const key = `${document.kind}:${document.vaultPath ? 'vault' : 'standalone'}:${document.vaultPath ?? document.path}`;
      const existing = tabsRef.current.find((tab) => keyFor(tab) === key);
      if (existing) {
        if (existing.restored) {
          hydrateTab(existing.id, document);
        } else if (existing.document) {
          if (existing.document.identity !== document.identity) {
            throw new Error(
              'This path now refers to a different document. Close the retained tab before opening its replacement.',
            );
          }
          updateTab(existing.id, { document });
        }
        activate(existing.id);
        return existing.id;
      }
      let tab: SessionTab;
      if (document.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          document.bytes,
        );
        tab = {
          ...blankTab(++revision.current),
          source: { kind: 'standalone', path: document.path, name: document.name },
          text,
          savedText: text,
          identity: document.identity,
          view: defaultView(),
        };
      } else {
        tab = viewerTab(document, ++revision.current);
      }
      return addTab(tab);
    },
    [activate, addTab, defaultView, hydrateTab, updateTab],
  );

  const close = useCallback(
    (id: string) => {
      const index = tabsRef.current.findIndex((tab) => tab.id === id);
      if (index < 0) {
        return;
      }
      const tab = tabsRef.current[index];
      const empty = isEmptyDraft(tab);
      if (empty && tabsRef.current.length === 1) {
        return;
      }
      const next = tabsRef.current.filter((candidate) => candidate.id !== id);
      clearTimeout(draftTimers.current.get(id));
      draftTimers.current.delete(id);
      scheduledDrafts.current.delete(id);
      if (!next.length) {
        next.push(blankTab(++revision.current));
      }
      const nextActive =
        activeIdRef.current === id
          ? next[Math.min(index, next.length - 1)].id
          : activeIdRef.current;
      const nextClosed = empty
        ? closedRef.current
        : [tab, ...closedRef.current.filter((candidate) => candidate.id !== id)].slice(
            0,
            CLOSED_LIMIT,
          );
      assertCapacity(next, nextClosed);
      activeIdRef.current = nextActive;
      sync(next, nextClosed);
      closedRef.current = nextClosed;
      setClosed(closedRef.current);
      if (activeIdRef.current !== id) {
        setActiveId(nextActive);
      }
    },
    [sync],
  );

  const requestClose = useCallback(
    async (
      ids: string[],
      decide: (dirty: DirtyTab[]) => Promise<CloseDecision>,
      save: (dirty: DirtyTab[]) => Promise<boolean>,
    ) => {
      const selected = tabsRef.current.filter((tab) => ids.includes(tab.id));
      const dirty = selected.filter((tab) => tab.dirty || !!tab.conflict);
      if (dirty.length) {
        const decision = await decide(dirty);
        if (decision === 'cancel') {
          return false;
        }
        if (decision === 'save' && !(await save(dirty))) {
          return false;
        }
      }
      selected.forEach((tab) => close(tab.id));
      return true;
    },
    [close],
  );

  const reopenClosed = useCallback(() => {
    const tab = closedRef.current[0];
    if (!tab) {
      return null;
    }
    const duplicate = tabsRef.current.find((candidate) => keyFor(candidate) === keyFor(tab));
    if (duplicate) {
      closedRef.current = closedRef.current.slice(1);
      setClosed(closedRef.current);
      activate(duplicate.id);
      return duplicate.id;
    }
    const nextClosed = closedRef.current.slice(1);
    addTab(tab, nextClosed);
    closedRef.current = nextClosed;
    setClosed(nextClosed);
    return tab.id;
  }, [activate, addTab]);

  const setShowOriginal = useCallback(
    (show: boolean) => {
      const id = activeIdRef.current;
      if (id) {
        updateTab(id, { showOriginal: show, view: show ? 'read' : 'edit' });
      }
    },
    [updateTab],
  );

  const setEditorState = useCallback(
    (id: string, state: EditorState, expectedEditorKey?: number) => {
      const tab = tabsRef.current.find((item) => item.id === id);
      if (!tab || (expectedEditorKey !== undefined && tab.editorKey !== expectedEditorKey)) {
        return;
      }
      updateTab(id, { editorState: state });
    },
    [updateTab],
  );
  const reset = useCallback(() => {
    lifecycle.current++;
    draftTimers.current.forEach((timer) => clearTimeout(timer));
    draftTimers.current.clear();
    scheduledDrafts.current.clear();
    const tab = blankTab(++revision.current);
    activeIdRef.current = tab.id;
    sync([tab], []);
    setActiveId(tab.id);
    setClosed([]);
    closedRef.current = [];
  }, [sync]);
  const newDraft = useCallback(() => {
    const existing = tabsRef.current.find(isEmptyDraft);
    if (existing) {
      activate(existing.id);
      return existing.id;
    }
    return addTab(blankTab(++revision.current));
  }, [activate, addTab]);

  const persist = useCallback(
    (root: string, vaultId: string, navigation?: WorkspacePersistenceState['navigation']) => {
      return {
        version: 1 as const,
        root,
        vaultId,
        activeId: activeIdRef.current,
        tabs: tabsRef.current.map(tabPersistence),
        navigation,
      } satisfies WorkspacePersistenceState;
    },
    [],
  );
  const restore = useCallback(
    (state: WorkspacePersistenceState, root: string, vaultId: string) => {
      if (state.version !== 1 || state.root !== root || state.vaultId !== vaultId) {
        return false;
      }
      lifecycle.current++;
      if (state.tabs.length > OPEN_LIMIT) {
        throw new Error('Saved workspace exceeds the 64-tab limit. It has not been restored.');
      }
      draftTimers.current.forEach((timer) => clearTimeout(timer));
      draftTimers.current.clear();
      scheduledDrafts.current.clear();
      const hasDocuments = state.tabs.some((tab) => tab.sourceKind !== 'untitled');
      const initialId =
        state.tabs.find((tab) => tab.id === state.activeId)?.id ?? state.tabs[0]?.id;
      const restored: SessionTab[] = state.tabs
        .filter(
          (item) => item.sourceKind !== 'untitled' || (!hasDocuments && item.id === initialId),
        )
        .map((item) => {
          const untitled = item.sourceKind === 'untitled';
          return {
            id: item.id,
            kind: item.kind,
            source: untitled
              ? { kind: 'standalone' as const, path: '', name: sourceName(null) }
              : null,
            document: null,
            text: '',
            savedText: '',
            dirty: false,
            conflict: null,
            view: item.view,
            showOriginal: item.showOriginal,
            line: item.line,
            column: item.column,
            editorKey: ++revision.current,
            viewerState: { page: item.page, zoom: item.zoom, scrollTop: item.scrollTop ?? 0 },
            draftId: null,
            restored: !untitled,
            identity: item.identity,
            retained: untitled ? { ...item, name: sourceName(null) } : item,
          } satisfies SessionTab;
        });
      if (!restored.length) {
        restored.push(blankTab(++revision.current));
      }
      activeIdRef.current =
        state.activeId && restored.some((tab) => tab.id === state.activeId)
          ? state.activeId
          : restored[0].id;
      sync(restored, []);
      closedRef.current = [];
      setClosed([]);
      setActiveId(activeIdRef.current);
      return true;
    },
    [sync],
  );

  const retainDraft = useCallback(
    async (tab: SessionTab, root: string, vaultId: string) => {
      if (!tab.dirty || tab.kind !== 'markdown') {
        return false;
      }
      const generation = lifecycle.current;
      const current = tabsRef.current.find((item) => item.id === tab.id) ?? tab;
      const id = current.draftId ?? makeId();
      const key = JSON.stringify([root, vaultId, id]);
      clearTimeout(draftTimers.current.get(tab.id));
      draftTimers.current.delete(tab.id);
      if (
        current.draftId !== id ||
        current.draftScope?.root !== root ||
        current.draftScope?.vaultId !== vaultId
      ) {
        updateTab(tab.id, { draftId: id, draftScope: { root, vaultId } });
      }
      const previous = draftWrites.current.get(key);
      const write = (previous ?? Promise.resolve(true))
        .catch(() => false)
        .then(async () => {
          const latest = tabsRef.current.find((item) => item.id === tab.id);
          if (generation !== lifecycle.current || !latest?.dirty) {
            return false;
          }
          const draft: DraftRecord = {
            id,
            root,
            vaultId,
            path:
              latest.source?.kind === 'vault'
                ? latest.source.note.path
                : (latest.source?.path ?? ''),
            identity: sourceIdentity(latest.source, latest.identity),
            baseRevision: latest.source?.kind === 'vault' ? latest.source.note.revision : null,
            text: latest.text,
            savedAt: Date.now(),
          };
          const ok = await draftSave(draft);
          if (ok && generation === lifecycle.current) {
            updateTab(tab.id, { draftId: id, draftScope: { root, vaultId } });
          }
          return ok;
        });
      draftWrites.current.set(key, write);
      try {
        return await write;
      } finally {
        if (draftWrites.current.get(key) === write) {
          draftWrites.current.delete(key);
        }
      }
    },
    [updateTab],
  );

  const canClearDraft = useCallback((tab: SessionTab, generation: number, onlyIfClean: boolean) => {
    if (generation !== lifecycle.current) {
      return false;
    }
    if (!onlyIfClean) {
      return true;
    }
    const current =
      tabsRef.current.find((item) => item.id === tab.id) ??
      closedRef.current.find((item) => item.id === tab.id);
    return !!current && !current.dirty && !current.conflict;
  }, []);

  const clearDraft = useCallback(
    async (tab: SessionTab, onlyIfClean = false) => {
      clearTimeout(draftTimers.current.get(tab.id));
      draftTimers.current.delete(tab.id);
      scheduledDrafts.current.delete(tab.id);
      const generation = lifecycle.current;
      const before = tabsRef.current.find((item) => item.id === tab.id) ?? tab;
      const id = before.draftId ?? tab.draftId ?? tab.id;
      const scope = before.draftScope ?? tab.draftScope;
      if (scope) {
        const key = JSON.stringify([scope.root, scope.vaultId, id]);
        const previous = draftWrites.current.get(key);
        const deletion = (previous ?? Promise.resolve(true))
          .catch(() => false)
          .then(() => {
            if (!canClearDraft(tab, generation, onlyIfClean)) {
              return false;
            }
            return draftDelete(id, scope.root, scope.vaultId);
          });
        draftWrites.current.set(key, deletion);
        try {
          if (!(await deletion)) {
            return false;
          }
        } finally {
          if (draftWrites.current.get(key) === deletion) {
            draftWrites.current.delete(key);
          }
        }
      } else if (before.draftId) {
        throw new Error(
          'This draft has no Vault scope. It was not deleted; reopen its recovery from the original Vault.',
        );
      }
      if (canClearDraft(tab, generation, onlyIfClean)) {
        updateTab(tab.id, { draftId: null, draftScope: undefined });
      }
      return true;
    },
    [canClearDraft, updateTab],
  );
  const clearingDrafts = useRef(new Set<string>());

  const scheduleDraft = useCallback(
    (tab: SessionTab, root: string, vaultId: string, onError: (error: unknown) => void) => {
      if (!tab.dirty) {
        clearTimeout(draftTimers.current.get(tab.id));
        draftTimers.current.delete(tab.id);
        scheduledDrafts.current.delete(tab.id);
        if ((tab.draftId || tab.draftScope) && !clearingDrafts.current.has(tab.id)) {
          clearingDrafts.current.add(tab.id);
          void clearDraft(tab, true)
            .catch(onError)
            .finally(() => clearingDrafts.current.delete(tab.id));
        }
        return;
      }
      if (scheduledDrafts.current.get(tab.id) === tab.text) {
        return;
      }
      scheduledDrafts.current.set(tab.id, tab.text);
      clearTimeout(draftTimers.current.get(tab.id) ?? 0);
      const generation = lifecycle.current;
      const timer = setTimeout(() => {
        draftTimers.current.delete(tab.id);
        const current = tabsRef.current.find((item) => item.id === tab.id);
        if (generation === lifecycle.current && current?.dirty) {
          void retainDraft(current, root, vaultId).catch((error) => {
            scheduledDrafts.current.delete(tab.id);
            onError(error);
          });
        }
      }, 750);
      draftTimers.current.set(tab.id, timer);
    },
    [clearDraft, retainDraft],
  );

  return {
    buffer,
    bufferRef,
    nextRevision,
    updateBuffer,
    replaceBuffer,
    refreshBuffer,
    tabs,
    tabsRef,
    activeId,
    activeIdRef,
    selected: active?.document ?? null,
    activeTab: active,
    dirtyTabs: tabs.filter((tab) => tab.dirty || !!tab.conflict),
    closedTabs: closed,
    showOriginal,
    setShowOriginal,
    openNote,
    openDocument,
    activate,
    setSelected: activate,
    close,
    requestClose,
    reopenClosed,
    updateTab,
    setEditorState,
    reset,
    newDraft,
    persist,
    restore,
    hydrateTab,
    retainDraft,
    scheduleDraft,
    clearDraft,
  };
}
