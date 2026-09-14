import type { IndexState, NoteDocument } from '../workspace/types';

export interface AnnotationLink {
  id: string;
  path: string | null;
  problem: string | null;
}

export interface AnnotationSnapshot {
  identity: string;
  revision: string | null;
  links: AnnotationLink[];
  candidates: AnnotationLink[];
  moreCandidates: boolean;
  moreLinks: boolean;
  indexing: IndexState;
}

export interface AnnotationRequest {
  path: string;
  expectedIdentity: string;
  expectedRevision: string | null;
  action: { kind: 'link' | 'unlink'; id: string } | { kind: 'create'; path: string };
}

export interface AnnotationChange {
  identity: string;
  created: NoteDocument | null;
}
