import type { IndexState, NoteDocument } from '../workspace/types';
export interface TagsSnapshot {
  identity: string | null;
  revision: string | null;
  tags: string[];
  suggestions: string[];
  folders: string[];
  moreSuggestions: boolean;
  moreFolders: boolean;
  indexing: IndexState;
  problem: string | null;
}
export interface TagsRequest {
  path: string;
  expectedIdentity: string;
  expectedRevision: string | null;
  tags: string[];
}
export interface TagsChange {
  identity: string;
  note: NoteDocument | null;
}
