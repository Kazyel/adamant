import { invoke } from '@tauri-apps/api/core';
import type { RefObject } from 'react';
import { errorMessage } from '../../shared/errors';
import type { SelectedDocument } from '../documents/types';
import type { NavigationController } from '../navigation/useNavigation';
import { markdownLink } from '../navigation/navigationTypes';
import type { SearchHit, NavigationDocument } from '../navigation/navigationTypes';
import type { DocumentSession, SessionTab } from './session/useDocumentSession';
import type { NoteDocument, VaultEntry, VaultSnapshot } from './types';

interface NavigationContext {
  vault: RefObject<VaultSnapshot | null>;
  documents: DocumentSession;
  finder: NavigationController;
  run: (action: () => Promise<void>) => void;
  revealPath: (path: string) => Promise<void>;
  fail: (error: unknown) => void;
  notify: (text: string) => void;
}

interface NavigationTarget {
  entry: VaultEntry;
  identity: string;
}

class UnavailableTargetError extends Error {}

export function useWorkspaceNavigation({
  vault,
  documents,
  finder,
  run,
  revealPath,
  fail,
  notify,
}: NavigationContext) {
  function activeSourcePath(): string | null {
    const tab = documents.tabsRef.current.find((item) => item.id === documents.activeIdRef.current);
    return tab?.source?.kind === 'vault'
      ? tab.source.note.path
      : (tab?.document?.vaultPath ??
          (tab?.retained?.sourceKind === 'vault' ? tab.retained.path : null));
  }

  async function resolve(
    path: string,
    expectedIdentity?: string | null,
  ): Promise<NavigationTarget> {
    const target = await invoke<NavigationTarget>('vault_navigation_target', { path });
    if (expectedIdentity && target.identity !== expectedIdentity) {
      throw new Error(
        `The saved navigation target "${path}" no longer refers to the same item. Re-add the favorite or reopen the document.`,
      );
    }
    return target;
  }

  function isCurrentVault(root: VaultSnapshot): boolean {
    return vault.current?.root === root.root && vault.current?.id === root.id;
  }

  async function openTarget(
    target: NavigationTarget,
    root: VaultSnapshot,
    revision?: string | null,
  ): Promise<string | null> {
    const { entry, identity } = target;
    if (entry.kind === 'directory') {
      await revealPath(`${entry.path}/`);
      return null;
    }
    if (entry.kind === 'markdown') {
      const note = await invoke<NoteDocument>('vault_read_note', {
        path: entry.path,
        expectedIdentity: identity,
      });
      if (!isCurrentVault(root)) {
        return null;
      }
      if (note.id && identity !== `uuid:${note.id}`) {
        throw new Error(
          'The Note identity changed while opening. Reopen the current file explicitly.',
        );
      }
      if (revision && note.revision !== revision) {
        throw new Error(
          'This search result changed on disk. Search again to navigate to the current occurrence.',
        );
      }
      return documents.openNote(note, identity);
    }
    const doc = await invoke<SelectedDocument>('vault_open_document', { path: entry.path });
    if (!isCurrentVault(root)) {
      return null;
    }
    if (doc.identity !== identity) {
      throw new Error(
        'The document identity changed while opening. Reopen the current file explicitly.',
      );
    }
    return documents.openDocument({
      ...doc,
      identity,
      bytes: Uint8Array.from(doc.bytes),
      revision: documents.nextRevision(),
      vaultPath: entry.path,
    });
  }

  async function open(
    target: NavigationTarget,
    location?: NavigationDocument,
    recordHistory = true,
    revision?: string | null,
    view?: SessionTab['view'],
  ) {
    const root = vault.current;
    if (!root) {
      return;
    }
    const tabId = await openTarget(target, root, revision);
    if (!isCurrentVault(root)) {
      return;
    }
    const { entry, identity } = target;
    finder.rememberTarget(entry.path, identity);
    finder.markMissing(entry.path, false);
    if (!tabId) {
      return;
    }
    if (location) {
      documents.updateTab(tabId, { line: location.line ?? 1, column: location.column ?? 1 });
    }
    if (view && entry.kind === 'markdown') {
      documents.updateTab(tabId, { view });
    }
    if (recordHistory) {
      finder.navigate(
        { path: entry.path, line: location?.line ?? null, column: location?.column ?? null },
        identity,
      );
    }
  }

  async function locate(
    path: string,
    location?: NavigationDocument,
    recordHistory = true,
    revision?: string | null,
    expectedIdentity?: string | null,
    view?: SessionTab['view'],
  ) {
    const state = finder.stateRef.current;
    const retained =
      state.favorites.includes(path) ||
      state.recent.includes(path) ||
      state.history.some((document) => document.path === path);
    const identity = expectedIdentity === undefined ? state.identities[path] : expectedIdentity;
    let target: NavigationTarget;
    try {
      if (retained && !identity) {
        throw new Error(
          'This retained target has no verified identity. Open it explicitly from the explorer.',
        );
      }
      target = await resolve(path, identity);
    } catch (error) {
      finder.markMissing(path);
      const message = errorMessage(error);
      if (identity || retained) {
        throw new UnavailableTargetError(
          `${message} Re-add the favorite or reopen the document to update its identity.`,
        );
      }
      throw new UnavailableTargetError(message);
    }
    finder.markMissing(path, false);
    await open(target, location, recordHistory, revision, view);
  }

  async function navigateHistory(direction: -1 | 1) {
    const state = finder.stateRef.current;
    const history = state.history;
    let index = state.historyIndex + direction;
    const skipped: string[] = [];
    while (index >= 0 && index < history.length) {
      const target = history[index];
      try {
        await locate(target.path, target, false, null, target.identity);
        finder.setState((current) => ({ ...current, historyIndex: index }));
        if (skipped.length) {
          notify(`Skipped unavailable history entries: ${skipped.join(', ')}`);
        }
        return;
      } catch (error) {
        if (!(error instanceof UnavailableTargetError)) {
          throw error;
        }
        skipped.push(target.path);
        index += direction;
      }
    }
    if (skipped.length) {
      fail(
        new Error(`No available history entry in that direction. Skipped: ${skipped.join(', ')}`),
      );
    }
  }

  async function copyLink(path: string): Promise<void> {
    const source = activeSourcePath();
    try {
      await navigator.clipboard.writeText(markdownLink(source, path));
    } catch (error) {
      fail(error);
    }
  }

  function toggleFavorite(path: string) {
    run(async () => {
      if (finder.stateRef.current.favorites.includes(path)) {
        finder.toggleFavorite(path);
        return;
      }
      const target = await resolve(path);
      finder.rememberTarget(path, target.identity);
      finder.toggleFavorite(path, target.identity);
    });
  }

  return {
    openEntry: (entry: VaultEntry) =>
      run(async () => {
        const target = await resolve(entry.path, entry.id ? `uuid:${entry.id}` : null);
        await open(target);
      }),
    openPath: (path: string, expectedIdentity?: string | null, view?: SessionTab['view']) =>
      run(() => locate(path, undefined, true, undefined, expectedIdentity, view)),
    openSearchHit: (hit: SearchHit) =>
      run(() =>
        locate(
          hit.path,
          { path: hit.path, line: hit.line, column: hit.column },
          true,
          hit.revision,
          hit.identity,
        ),
      ),
    navigateHistory: (direction: -1 | 1) => run(() => navigateHistory(direction)),
    revealActive: () =>
      run(async () => {
        const path = activeSourcePath();
        if (path) {
          await revealPath(path);
        }
      }),
    favoriteActive: () => {
      const path = activeSourcePath();
      if (path) {
        toggleFavorite(path);
      } else {
        fail(new Error('Open a saved Vault Note before adding it to favorites.'));
      }
    },
    toggleFavorite,
    copyLink,
    copyActiveLink: () => {
      const path = activeSourcePath();
      if (!path) {
        fail(new Error('Open a Vault document before copying its link.'));
        return Promise.resolve();
      }
      return copyLink(path);
    },
  };
}
