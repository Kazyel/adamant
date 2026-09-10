import { isTauri } from '@tauri-apps/api/core';
import type { Dispatch, SetStateAction } from 'react';
import type useWorkspace from '../features/workspace/useWorkspace';
import type { IndexState, NoteDocument } from '../features/workspace/types';

export const native = isTauri();

export const indexLabels: Record<IndexState['state'], string> = {
  indexing: 'Indexing Vault',
  ready: 'Index ready',
  partial: 'Partial index',
  stale: 'Index out of date',
  cancelled: 'Indexing cancelled',
};

export type Workspace = ReturnType<typeof useWorkspace>;
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

interface Navigation {
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

export function getSaveStatus({ buffer, busy, dirty }: Workspace) {
  if (busy === 'save') {
    return 'Saving…';
  }
  if (buffer.conflict) {
    return 'Disk conflict — buffer kept';
  }
  if (dirty) {
    return 'Unsaved changes';
  }
  if (buffer.source?.kind === 'vault') {
    return 'Saved to disk';
  }
  if (buffer.source) {
    return 'Standalone original unchanged';
  }

  return 'Empty buffer';
}
