import { useRef, useState } from 'react';
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
  return source?.kind === 'vault'
    ? source.note.path.split('/').at(-1)!
    : (source?.name ?? 'Untitled');
}

export function useNoteBuffer() {
  const [buffer, setBufferState] = useState<BufferState>(() => ({
    text: '',
    savedText: '',
    source: null,
    editorKey: 0,
    conflict: null,
  }));
  const bufferRef = useRef(buffer);
  const revision = useRef(0);

  function updateBuffer(next: BufferState) {
    bufferRef.current = next;
    setBufferState(next);
  }

  function nextRevision() {
    return ++revision.current;
  }

  function replaceBuffer(text: string, source: Source | null) {
    updateBuffer({ text, savedText: text, source, editorKey: nextRevision(), conflict: null });
  }

  function refreshBuffer(note: NoteDocument, editorKey: number) {
    const latest = bufferRef.current;
    if (latest.source?.kind !== 'vault' || latest.editorKey !== editorKey) {
      return;
    }

    if (note.revision === latest.source.note.revision) {
      updateBuffer({ ...latest, source: { kind: 'vault', note }, conflict: null });
      return;
    }

    if (latest.text !== latest.savedText || latest.conflict) {
      updateBuffer({
        ...latest,
        conflict: {
          current: note,
          message: 'This Note changed on disk. Your editor buffer has been kept.',
        },
      });
      return;
    }

    updateBuffer({
      text: note.text,
      savedText: note.text,
      source: { kind: 'vault', note },
      editorKey: nextRevision(),
      conflict: null,
    });
  }

  return { buffer, bufferRef, nextRevision, updateBuffer, replaceBuffer, refreshBuffer };
}
