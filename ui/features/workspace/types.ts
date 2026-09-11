import type { SelectedDocument } from '../documents/types';

export interface VaultEntry {
  path: string;
  kind: 'directory' | 'markdown' | 'pdf' | 'docx';
  id: string | null;
  metadataError: string | null;
  modifiedAt: number | null;
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
  contentRoot: '.' | 'content';
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
  generation: number;
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
  inventoryGeneration?: number;
}

export interface NoteDocument {
  path: string;
  text: string;
  revision: string;
  id: string | null;
  metadataError: string | null;
}

export type OpenedDocument = Omit<SelectedDocument, 'bytes' | 'identity'> & {
  bytes: Uint8Array;
  revision: number;
  vaultPath: string | null;
  identity?: string | null;
};

export type WorkspacePrompt =
  | { kind: 'confirm'; title: string; description: string; confirmLabel: string }
  | { kind: 'guard'; title: string; documents?: string[] }
  | { kind: 'path'; title: string; initial: string; recovery: boolean }
  | { kind: 'vault'; title: string }
  | { kind: 'create'; title: string; complete: (vault: VaultSnapshot) => void };
