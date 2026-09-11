import { invoke } from '@tauri-apps/api/core';

export interface WorkspaceTabState {
  id: string;
  kind: 'markdown' | 'pdf' | 'docx';
  path: string;
  name: string;
  sourcePath: string | null;
  sourceKind: 'vault' | 'standalone' | 'untitled';
  identity: string | null;
  baseRevision: string | null;
  view: 'edit' | 'read' | 'split';
  showOriginal: boolean;
  page: number;
  zoom: number;
  scrollTop?: number;
  line: number;
  column: number;
}
interface WorkspaceNavigationState {
  recent: string[];
  favorites: string[];
  history: { path: string; line: number | null; column: number | null; identity?: string | null }[];
  historyIndex: number;
  expanded: string[];
  identities: Record<string, string>;
  favoriteIdentities?: Record<string, string>;
}

export interface WorkspacePersistenceState {
  version: 1;
  root: string;
  vaultId: string;
  activeId: string | null;
  tabs: WorkspaceTabState[];
  navigation?: WorkspaceNavigationState;
}

export interface DraftRecord {
  id: string;
  root: string;
  vaultId: string;
  path: string;
  identity: string | null;
  baseRevision: string | null;
  text: string;
  savedAt: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TABS = 64;
const MAX_RECENTS = 100;
const MAX_DRAFTS = 64;

function encodedSize(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('State cannot be serialized.');
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function invalidState(message: string): never {
  throw new Error(`Stored workspace state is invalid: ${message}`);
}

function validateTabOrigin(tab: Record<string, unknown>) {
  if (
    tab.sourceKind !== 'vault' &&
    tab.sourceKind !== 'standalone' &&
    tab.sourceKind !== 'untitled'
  ) {
    invalidState('tab origin is missing');
  }
  if (tab.sourcePath !== null && typeof tab.sourcePath !== 'string') {
    invalidState('tab source path is invalid');
  }
  if (tab.identity !== null && typeof tab.identity !== 'string') {
    invalidState('tab identity is invalid');
  }
  if (tab.baseRevision !== null && typeof tab.baseRevision !== 'string') {
    invalidState('tab revision is invalid');
  }
}

function validateTabViewer(tab: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(tab.page) ||
    (tab.page as number) < 1 ||
    typeof tab.zoom !== 'number' ||
    !Number.isFinite(tab.zoom) ||
    tab.zoom <= 0
  ) {
    invalidState('tab viewer state is invalid');
  }
  if (
    tab.scrollTop !== undefined &&
    (typeof tab.scrollTop !== 'number' || !Number.isFinite(tab.scrollTop) || tab.scrollTop < 0)
  ) {
    invalidState('tab scroll position is invalid');
  }
}

function validateTabPresentation(tab: Record<string, unknown>) {
  if (typeof tab.showOriginal !== 'boolean') {
    invalidState('tab preview state is invalid');
  }
  validateTabViewer(tab);
  if (tab.view !== 'edit' && tab.view !== 'read' && tab.view !== 'split') {
    invalidState('tab view is invalid');
  }
  if (
    !Number.isSafeInteger(tab.line) ||
    !Number.isSafeInteger(tab.column) ||
    (tab.line as number) < 1 ||
    (tab.column as number) < 1
  ) {
    invalidState('tab location is invalid');
  }
}

function parseTab(value: unknown): WorkspaceTabState {
  if (typeof value !== 'object' || value === null) {
    invalidState('tab is not an object');
  }
  const tab = value as Record<string, unknown>;
  if (
    typeof tab.id !== 'string' ||
    !tab.id ||
    typeof tab.path !== 'string' ||
    typeof tab.name !== 'string'
  ) {
    invalidState('tab identity is missing');
  }
  if (tab.kind !== 'markdown' && tab.kind !== 'pdf' && tab.kind !== 'docx') {
    invalidState('unsupported tab kind');
  }
  validateTabOrigin(tab);
  validateTabPresentation(tab);
  return tab as unknown as WorkspaceTabState;
}
function parseIdentities(value: unknown): Record<string, string> {
  const identities = value ?? {};
  if (
    typeof identities !== 'object' ||
    identities === null ||
    Array.isArray(identities) ||
    Object.entries(identities).some(
      ([path, identity]) => !path || typeof identity !== 'string' || !identity,
    )
  ) {
    invalidState('navigation identities are invalid');
  }
  return identities as Record<string, string>;
}

function parseNavigation(value: unknown): WorkspaceNavigationState | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    invalidState('navigation is not an object');
  }
  const navigation = value as Record<string, unknown>;
  if (
    ![navigation.recent, navigation.favorites, navigation.expanded].every(
      (items) => Array.isArray(items) && items.every((item) => typeof item === 'string'),
    )
  ) {
    invalidState('navigation paths are invalid');
  }
  if (!Array.isArray(navigation.history) || !Number.isSafeInteger(navigation.historyIndex)) {
    invalidState('navigation history is invalid');
  }
  const identities = parseIdentities(navigation.identities);
  const favorites = navigation.favorites as string[];
  let favoriteIdentities: Record<string, string>;
  if (navigation.favoriteIdentities === undefined) {
    favoriteIdentities = {};
    for (const path of favorites) {
      const identity = identities[path];
      if (identity) {
        favoriteIdentities[path] = identity;
      }
    }
  } else {
    favoriteIdentities = parseIdentities(navigation.favoriteIdentities);
  }
  const history = navigation.history.map((item) => {
    if (typeof item !== 'object' || item === null) {
      invalidState('history entry is invalid');
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      (entry.line !== null && !Number.isSafeInteger(entry.line)) ||
      (entry.column !== null && !Number.isSafeInteger(entry.column))
    ) {
      invalidState('history location is invalid');
    }
    const identity =
      entry.identity === undefined ? (identities[entry.path] ?? null) : entry.identity;
    if (identity !== null && (typeof identity !== 'string' || !identity)) {
      invalidState('history identity is invalid');
    }
    return {
      path: entry.path,
      line: entry.line as number | null,
      column: entry.column as number | null,
      identity,
    };
  });
  const historyIndex = navigation.historyIndex as number;
  if (historyIndex < -1 || historyIndex >= history.length) {
    invalidState('navigation history index is out of range');
  }
  return {
    recent: navigation.recent as string[],
    favorites,
    history,
    historyIndex: navigation.historyIndex as number,
    expanded: navigation.expanded as string[],
    identities,
    favoriteIdentities,
  };
}

function parseState(value: unknown): WorkspacePersistenceState | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object') {
    invalidState('state is not an object');
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.root !== 'string' || typeof state.vaultId !== 'string') {
    invalidState('version or scope is invalid');
  }
  if (state.activeId !== null && typeof state.activeId !== 'string') {
    invalidState('active tab is invalid');
  }
  if (!Array.isArray(state.tabs) || state.tabs.length > MAX_TABS) {
    invalidState('tab limit exceeded');
  }
  const tabs = state.tabs.map(parseTab);
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    invalidState('duplicate tab ids');
  }
  if (state.activeId !== null && !tabs.some((tab) => tab.id === state.activeId)) {
    invalidState('active tab is not present');
  }
  return {
    version: 1,
    root: state.root,
    vaultId: state.vaultId,
    activeId: state.activeId,
    tabs,
    navigation: parseNavigation(state.navigation),
  };
}

export async function workspaceLoad(): Promise<WorkspacePersistenceState | null> {
  return parseState(await invoke<unknown>('workspace_load'));
}

export async function workspaceSave(state: WorkspacePersistenceState): Promise<boolean> {
  if (state.tabs.length > MAX_TABS) {
    throw new Error('Cannot save more than 64 workspace tabs.');
  }
  if (
    state.navigation &&
    [
      state.navigation.recent,
      state.navigation.favorites,
      state.navigation.history,
      state.navigation.expanded,
    ].some((items) => items.length > MAX_RECENTS)
  ) {
    throw new Error('Cannot save more than 100 workspace navigation entries.');
  }
  if (state.navigation && Object.keys(state.navigation.identities).length > MAX_RECENTS * 4) {
    throw new Error('Cannot save more than 400 navigation identities.');
  }
  if (encodedSize(state) > MAX_BYTES) {
    throw new Error('Workspace state exceeds the 2 MiB limit.');
  }
  await invoke('workspace_save', { state });
  return true;
}

function parseDraft(value: unknown): DraftRecord {
  if (typeof value !== 'object' || value === null) {
    invalidState('draft is not an object');
  }
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.id !== 'string' ||
    typeof draft.root !== 'string' ||
    typeof draft.vaultId !== 'string' ||
    typeof draft.path !== 'string' ||
    typeof draft.text !== 'string' ||
    !Number.isFinite(draft.savedAt)
  ) {
    invalidState('draft fields are invalid');
  }
  if (draft.identity !== null && typeof draft.identity !== 'string') {
    invalidState('draft identity is invalid');
  }
  if (draft.baseRevision !== null && typeof draft.baseRevision !== 'string') {
    invalidState('draft revision is invalid');
  }
  return draft as unknown as DraftRecord;
}

export async function draftsLoad(): Promise<DraftRecord[]> {
  const value = await invoke<unknown>('drafts_load');
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_DRAFTS) {
    invalidState('draft limit exceeded');
  }
  return value.map(parseDraft);
}

export async function draftSave(draft: DraftRecord): Promise<boolean> {
  parseDraft(draft);
  if (encodedSize(draft) > MAX_BYTES) {
    throw new Error('Draft exceeds the 2 MiB limit.');
  }
  await invoke('draft_save', { draft });
  return true;
}

export async function draftDelete(id: string, root: string, vaultId: string): Promise<boolean> {
  if (!id) {
    throw new Error('Draft id is required.');
  }
  await invoke('draft_delete', { id, root, vaultId });
  return true;
}

export async function preferencesLoad<T>(): Promise<T | null> {
  return (await invoke<unknown>('preferences_load')) as T | null;
}

export async function preferencesSave<T>(value: T): Promise<boolean> {
  if (encodedSize(value) > MAX_BYTES) {
    throw new Error('Preferences exceed the 2 MiB limit.');
  }
  await invoke('preferences_save', { value });
  return true;
}
