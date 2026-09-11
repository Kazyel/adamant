import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tabPersistence, type DocumentSession } from './useDocumentSession.ts';
import { errorMessage } from '../../../shared/errors.ts';
import type { NavigationController } from '../../navigation/useNavigation';
import type { NoteDocument, VaultSnapshot } from '../types';
import type { SelectedDocument } from '../../documents/types';
import type { EditorPreferences } from '../../interaction/types';
import {
  draftDelete,
  draftsLoad,
  preferencesLoad,
  preferencesSave,
  workspaceLoad,
  workspaceSave,
} from './persistence.ts';
import type { DraftRecord, WorkspaceTabState } from './persistence';

interface PersistenceContext {
  vault: RefObject<VaultSnapshot | null>;
  documents: DocumentSession;
  finder: NavigationController;
  fail: (error: unknown) => void;
  revealPath: (path: string) => Promise<void>;
  setPreferences: (preferences: EditorPreferences) => void;
}

type RestoredTab =
  | { type: 'note'; document: NoteDocument & { identity: string } }
  | { type: 'document'; document: SelectedDocument & { identity: string } };
export interface RecoverySelection {
  draft: DraftRecord;
  source: NoteDocument | null;
  sourceChanged: boolean;
  sourceIdentity: string | null;
}

function validPreferences(value: unknown): value is EditorPreferences {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    typeof data.fontSize === 'number' &&
    data.fontSize >= 10 &&
    data.fontSize <= 32 &&
    typeof data.wordWrap === 'boolean' &&
    Number.isInteger(data.indentSize) &&
    [2, 4, 8].includes(data.indentSize as number) &&
    ['edit', 'read', 'split'].includes(data.defaultView as string)
  );
}

function recoverableSource({
  source,
  sourceIdentity,
  draft,
}: RecoverySelection): NoteDocument | null {
  if (source !== null && draft.identity !== null && sourceIdentity === draft.identity) {
    return source;
  }
  return null;
}

export function useWorkspacePersistence({
  vault,
  documents,
  finder,
  fail,
  revealPath,
  setPreferences,
}: PersistenceContext) {
  const hydrated = useRef(false);
  const [recoveries, setRecoveries] = useState<DraftRecord[]>([]);
  const [recovery, setRecovery] = useState<RecoverySelection | null>(null);
  const scope = useRef(0);
  const pendingWrite = useRef<Promise<void>>(Promise.resolve());
  const persisted = useRef('');
  const pendingHydration = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  const lastDocumentRequest = useRef<Promise<{
    tab: WorkspaceTabState;
    document: SelectedDocument;
  } | null> | null>(null);

  function isCurrentScope(started: number, root: VaultSnapshot | null): boolean {
    return (
      mounted.current &&
      started === scope.current &&
      vault.current?.root === root?.root &&
      vault.current?.id === root?.id
    );
  }

  function resetHydration() {
    hydrated.current = false;
    scope.current++;
    persisted.current = '';
  }

  async function hydrateTab(id: string) {
    const tab = documents.tabsRef.current.find((item) => item.id === id);
    if (!tab?.restored) {
      return;
    }
    const root = vault.current;
    const started = scope.current;
    const key = JSON.stringify([started, root?.root, root?.id, id, tab.editorKey]);
    const pending = pendingHydration.current.get(key);
    if (pending) {
      return pending;
    }
    const isCurrent = () =>
      isCurrentScope(started, root) &&
      documents.tabsRef.current.some(
        (item) => item.id === id && item.editorKey === tab.editorKey && item.restored,
      );
    documents.updateTab(id, { hydration: { state: 'loading' } });
    const load = Promise.resolve()
      .then(async () => {
        if (!root) {
          throw new Error('Open the original Vault before restoring this tab.');
        }
        await persistWorkspace();
        if (!isCurrent()) {
          return;
        }
        const payload = await invoke<RestoredTab | null>('workspace_read_tab', { tabId: id });
        if (!isCurrent()) {
          return;
        }
        if (!payload) {
          throw new Error(
            'The saved document is unavailable. Its tab and any draft have been retained; reopen the file explicitly.',
          );
        }
        let loaded: boolean;
        if (payload.type === 'note') {
          loaded = documents.hydrateTab(id, payload.document, payload.document.identity);
        } else {
          loaded = documents.hydrateTab(id, {
            ...payload.document,
            bytes: Uint8Array.from(payload.document.bytes),
            revision: documents.nextRevision(),
            vaultPath: tab.retained?.sourceKind === 'vault' ? tab.retained.path : null,
          });
        }
        if (!loaded) {
          throw new Error(
            'This tab has unsaved changes or a conflict. Save or resolve them before retrying; its buffer has been kept.',
          );
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          documents.updateTab(id, { hydration: { state: 'error', message: errorMessage(error) } });
        }
      })
      .finally(() => {
        if (pendingHydration.current.get(key) === load) {
          pendingHydration.current.delete(key);
        }
      });
    pendingHydration.current.set(key, load);
    return load;
  }

  async function hydrateActiveTab() {
    const id = documents.activeIdRef.current;
    if (!id) {
      return;
    }
    await hydrateTab(id);
  }

  async function restoreExpandedDirectories(
    directories: string[],
    started: number,
    root: VaultSnapshot,
  ) {
    for (const directory of directories) {
      if (!isCurrentScope(started, root)) {
        return;
      }
      try {
        await revealPath(`${directory}/`);
      } catch (error) {
        if (isCurrentScope(started, root)) {
          fail(error);
        }
      }
    }
  }

  async function restoreRecoveries(root: VaultSnapshot, started: number): Promise<boolean> {
    const drafts = await draftsLoad();
    if (!isCurrentScope(started, root)) {
      return false;
    }
    if (drafts.some((draft) => draft.root !== root.root || draft.vaultId !== root.id)) {
      throw new Error('Saved drafts belong to a different Vault. They were not restored.');
    }
    setRecoveries(drafts);
    setRecovery(null);
    return true;
  }

  async function restoreWorkspace(next: VaultSnapshot) {
    hydrated.current = false;
    const started = ++scope.current;
    const state = await workspaceLoad();
    if (!isCurrentScope(started, next)) {
      return;
    }
    if (state && !documents.restore(state, next.root, next.id)) {
      throw new Error('Saved workspace belongs to a different Vault. It was not restored.');
    }
    const navigation = state?.navigation ?? {
      recent: [],
      favorites: [],
      history: [],
      historyIndex: -1,
      expanded: [],
      identities: {},
      favoriteIdentities: {},
    };
    finder.setState({ ...navigation, favoriteIdentities: navigation.favoriteIdentities ?? {} });
    await hydrateActiveTab();
    if (!isCurrentScope(started, next)) {
      return;
    }
    if (!(await restoreRecoveries(next, started))) {
      return;
    }
    await restoreExpandedDirectories(state?.navigation?.expanded ?? [], started, next);
    if (!isCurrentScope(started, next)) {
      return;
    }
    hydrated.current = true;
    persisted.current = '';
    await persistWorkspace();
  }

  async function restoreLastDocument(isCurrent: () => boolean) {
    hydrated.current = false;
    const started = ++scope.current;
    const current = () => isCurrent() && isCurrentScope(started, null);
    try {
      const payload = await (lastDocumentRequest.current ??= invoke<{
        tab: WorkspaceTabState;
        document: SelectedDocument;
      } | null>('last_document_load'));
      if (!current() || !payload) {
        return;
      }
      const { tab, document } = payload;
      if (
        tab.sourceKind !== 'standalone' ||
        !tab.path ||
        tab.path !== document.path ||
        tab.kind !== document.kind ||
        !tab.identity ||
        tab.identity !== document.identity
      ) {
        throw new Error(
          'The remembered file no longer refers to the same document. Open it explicitly.',
        );
      }
      // Opening decodes Markdown before changing the session; failures leave the draft intact.
      const id = documents.openDocument({
        ...document,
        bytes: Uint8Array.from(document.bytes),
        revision: documents.nextRevision(),
        vaultPath: null,
      });
      documents.updateTab(id, {
        view: tab.view,
        showOriginal: tab.showOriginal,
        line: tab.line,
        column: tab.column,
        viewerState: { page: tab.page, zoom: tab.zoom, scrollTop: tab.scrollTop ?? 0 },
      });
    } finally {
      if (current()) {
        lastDocumentRequest.current = null;
        hydrated.current = true;
        persisted.current = '';
      }
    }
    if (current()) {
      await persistWorkspace();
    }
  }

  async function resumeStorage(): Promise<void> {
    const root = vault.current;
    if (!root) {
      hydrated.current = true;
      persisted.current = '';
      await persistWorkspace();
      return;
    }
    const started = scope.current;
    if (!(await restoreRecoveries(root, started))) {
      return;
    }
    hydrated.current = true;
    persisted.current = '';
    await hydrateActiveTab();
    if (!isCurrentScope(started, root)) {
      return;
    }
    await persistWorkspace();
  }

  async function persistWorkspace() {
    const current = vault.current;
    if (!isTauri() || !hydrated.current) {
      return;
    }
    const currentNavigation = finder.stateRef.current;
    const state = current
      ? documents.persist(current.root, current.id, {
          ...currentNavigation,
          history: currentNavigation.history.map((item) => ({
            path: item.path,
            line: item.line ?? null,
            column: item.column ?? null,
            identity: item.identity ?? null,
          })),
        })
      : null;
    const active = !current
      ? documents.tabsRef.current.find((item) => item.id === documents.activeIdRef.current)
      : null;
    const candidate = active && !active.restored ? tabPersistence(active) : null;
    const tab = candidate?.sourceKind === 'standalone' && candidate.path ? candidate : null;
    const serialized = JSON.stringify(state ?? tab);
    const started = scope.current;
    const write = pendingWrite.current
      .catch(() => undefined)
      .then(async () => {
        // Compare after older writes finish, including a quick switch from A to B and back to A.
        if (!isCurrentScope(started, current) || serialized === persisted.current) {
          return;
        }
        if (state) {
          await workspaceSave(state);
        } else {
          await invoke('last_document_save', { tab });
        }
        if (isCurrentScope(started, current)) {
          persisted.current = serialized;
        }
      });
    pendingWrite.current = write;
    await write;
  }

  async function flushDrafts() {
    const current = vault.current;
    if (!isTauri()) {
      return;
    }
    if (!current) {
      await persistWorkspace();
      return;
    }
    const started = scope.current;
    const errors: unknown[] = [];
    for (const tab of documents.tabsRef.current) {
      if (!isCurrentScope(started, current)) {
        throw new Error('The Vault changed before all drafts could be retained.');
      }
      if (!tab.dirty) {
        continue;
      }
      try {
        await documents.retainDraft(tab, current.root, current.id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!isCurrentScope(started, current)) {
      throw new Error('The Vault changed before all drafts could be retained.');
    }
    try {
      await persistWorkspace();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Some drafts or workspace state could not be retained:\n${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('\n')}`,
      );
    }
  }

  async function savePreferences(next: EditorPreferences) {
    if (!validPreferences(next)) {
      throw new Error('Choose supported editor preferences.');
    }
    if (isTauri()) {
      await preferencesSave(next);
    }
    setPreferences(next);
  }

  async function readRecoverySource(draft: DraftRecord) {
    let source: NoteDocument | null = null;
    let sourceIdentity: string | null = null;
    if (draft.path && !draft.path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(draft.path)) {
      try {
        const target = await invoke<{ identity: string }>('vault_navigation_target', {
          path: draft.path,
        });
        source = await invoke<NoteDocument>('vault_read_note', {
          path: draft.path,
          expectedIdentity: target.identity,
        });
        sourceIdentity = source.id ? `uuid:${source.id}` : target.identity;
      } catch (error) {
        fail(error);
      }
    }
    return { source, sourceIdentity };
  }

  async function inspectRecovery(draft: DraftRecord) {
    const root = vault.current;
    if (!root || root.root !== draft.root || root.id !== draft.vaultId) {
      throw new Error('Open the original Vault before recovering this draft.');
    }
    const { source, sourceIdentity } = await readRecoverySource(draft);
    if (vault.current?.root !== root.root || vault.current?.id !== root.id) {
      return;
    }
    setRecovery({
      draft,
      source,
      sourceIdentity,
      sourceChanged:
        !!draft.path &&
        (!source || source.revision !== draft.baseRevision || sourceIdentity !== draft.identity),
    });
  }

  function recoverDraft() {
    if (!recovery) {
      return;
    }
    const { draft, sourceIdentity, sourceChanged } = recovery;
    if (vault.current?.root !== draft.root || vault.current?.id !== draft.vaultId) {
      throw new Error('The Vault changed. The draft was not recovered.');
    }
    const source = recoverableSource(recovery);
    const id = source ? documents.openNote(source, sourceIdentity) : documents.newDraft();
    const existing = documents.tabsRef.current.find((tab) => tab.id === id);
    if (existing?.dirty || existing?.conflict) {
      fail(
        new Error(
          'This Note already has unsaved changes. Close or save that tab before recovering another draft.',
        ),
      );
      return;
    }
    const savedText = source ? source.text : '';
    documents.updateTab(id, {
      text: draft.text,
      savedText,
      dirty: draft.text !== savedText,
      draftId: draft.id,
      draftScope: { root: draft.root, vaultId: draft.vaultId },
      editorKey: documents.nextRevision(),
      editorState: undefined,
      conflict:
        source && sourceChanged
          ? {
              current: source,
              message:
                'The source changed after this draft. Compare it or save a recovery copy; it has not been overwritten.',
            }
          : null,
    });
    setRecoveries((current) => current.filter((item) => item.id !== draft.id));
    setRecovery(null);
  }

  async function discardRecovery(id: string) {
    const draft = recoveries.find((item) => item.id === id);
    if (!draft) {
      throw new Error('This recovery draft is no longer available.');
    }
    await draftDelete(id, draft.root, draft.vaultId);
    setRecoveries((current) => current.filter((item) => item.id !== id));
    setRecovery(null);
  }

  const reportError = useEffectEvent(fail);
  const saveWorkspaceAfterChange = useEffectEvent(() => {
    void persistWorkspace().catch(fail);
  });
  const scheduleDrafts = useEffectEvent(() => {
    const current = vault.current;
    if (!isTauri() || !current || !hydrated.current) {
      return;
    }
    for (const tab of documents.tabs) {
      documents.scheduleDraft(tab, current.root, current.id, fail);
    }
  });

  useEffect(() => {
    mounted.current = true;
    const scopeRef = scope;
    return () => {
      mounted.current = false;
      scopeRef.current++;
      hydrated.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    void preferencesLoad<unknown>()
      .then((value) => {
        if (disposed || value === null) {
          return;
        }
        if (!validPreferences(value)) {
          throw new Error(
            'Saved preferences are invalid. Open Preferences to replace them explicitly.',
          );
        }
        setPreferences(value);
      })
      .catch(reportError);
    return () => {
      disposed = true;
    };
  }, [setPreferences]);

  useEffect(() => {
    const timer = setTimeout(saveWorkspaceAfterChange, 400);
    return () => clearTimeout(timer);
  }, [documents.tabs, documents.activeId, finder.state]);

  useEffect(() => {
    scheduleDrafts();
  }, [documents.tabs]);

  return {
    resetHydration,
    savePreferences,
    recoveries,
    setRecoveries,
    recovery,
    cancelRecovery: () => setRecovery(null),
    inspectRecovery,
    recoverDraft,
    discardRecovery,
    hydrateTab,
    restoreWorkspace,
    restoreLastDocument,
    resumeStorage,
    persistWorkspace,
    flushDrafts,
  };
}
