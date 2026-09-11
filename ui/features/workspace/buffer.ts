import type { NoteDocument } from './types';

interface VaultError {
  kind: 'conflict' | 'invalid' | 'io';
  message: string;
  current: NoteDocument | null;
}

export type Source =
  | { kind: 'vault'; note: NoteDocument }
  | { kind: 'standalone'; path: string; name: string };

export interface BufferState {
  text: string;
  savedText: string;
  source: Source | null;
  editorKey: number;
  conflict: { current: NoteDocument | null; message: string } | null;
}

export function conflictError(error: unknown): error is VaultError {
  return (
    typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'conflict'
  );
}

export function sourceName(source: Source | null): string {
  if (source?.kind === 'vault') {
    return source.note.path.split('/').at(-1)!;
  }
  return source?.path ? source.name : 'New document';
}

export function sourceKey(source: Source | null): string {
  if (source?.kind === 'vault') {
    return `vault:${source.note.path}`;
  }
  if (source?.kind === 'standalone') {
    return `standalone:${source.path}`;
  }
  return 'untitled';
}
