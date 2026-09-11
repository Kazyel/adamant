import { isTauri } from '@tauri-apps/api/core';
import type { Dispatch, SetStateAction } from 'react';
import type { Workspace } from '../features/workspace/workspaceTypes';
import type { NoteDocument } from '../features/workspace/types';

export const native = isTauri();

export const indexLabels: Record<'partial' | 'cancelled', string> = {
  partial: 'Partial index',
  cancelled: 'Indexing cancelled',
};

export type View = 'edit' | 'read' | 'split';
export type Section = 'workbench' | 'connections';

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

export function getSaveStatus({ buffer, dirty, documents }: Workspace) {
  const tab = documents.activeTab;
  if (tab?.restored) {
    return tab.hydration?.state === 'error' ? 'Could not open' : 'Loading…';
  }
  if (buffer.conflict) {
    return 'File conflict — changes kept';
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
