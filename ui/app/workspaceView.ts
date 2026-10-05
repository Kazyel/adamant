import { isTauri } from '@tauri-apps/api/core';
import type { Dispatch, SetStateAction } from 'react';
import type { Workspace } from '../features/workspace/workspaceTypes';
import type { NoteDocument } from '../features/workspace/types';
import { tabIdentity } from '../features/workspace/session/useDocumentSession';

export const native = isTauri();

export const indexLabels: Record<'partial' | 'cancelled', string> = {
  partial: 'Partial index',
  cancelled: 'Indexing cancelled',
};

export type View = 'edit' | 'read' | 'split';
export type Section = 'workbench' | 'work' | 'connections' | 'graph';

export interface DocumentInfo {
  note: NoteDocument | null;
  readingDocument: Workspace['selected'];
  bufferName: string;
  bufferPath: string | null;
  activeName: string;
  activePath: string | null;
  activeVaultPath: string | null;
}

export interface WorkspaceProps {
  workspace: Workspace;
}

export interface Navigation {
  section: Section;
  setSection: Dispatch<SetStateAction<Section>>;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  view: View;
  setView: (view: View) => void;
  showBuffer: () => void;
}

export interface NavigationProps extends WorkspaceProps {
  navigation: Navigation;
}

export interface DocumentProps extends NavigationProps {
  documentInfo: DocumentInfo;
}

export function noteLinkSource(workspace: Workspace) {
  const tab = workspace.documents.activeTab;
  const vault = workspace.vault;
  if (
    !vault ||
    !tab ||
    tab.restored ||
    tab.conflict?.removed ||
    tab.kind !== 'markdown' ||
    tab.source?.kind !== 'vault'
  ) {
    return undefined;
  }
  const vaultKey = `${vault.root}:${vault.id}`;
  return {
    path: tab.source.note.path,
    expectedIdentity: tabIdentity(tab),
    vaultKey,
    ownerKey: `${vaultKey}:${tab.id}`,
    refreshKey: tab.source.note.revision,
  };
}

export function getSaveStatus({ buffer, dirty, documents }: Workspace) {
  const tab = documents.activeTab;
  if (tab?.restored) {
    return tab.hydration?.state === 'error' ? 'Could not open' : 'Loading…';
  }
  if (buffer.conflict) {
    return buffer.conflict.removed ? 'File removed — changes kept' : 'File conflict — changes kept';
  }
  if (tab?.document && tab.kind !== 'markdown') {
    return 'Read-only';
  }
  const hasFile = buffer.source?.kind === 'vault' || !!buffer.source?.path;
  if (!hasFile) {
    return 'Not saved yet';
  }
  return dirty ? 'Unsaved changes' : 'Saved';
}
