export type MutationKind = 'rename' | 'move' | 'duplicate' | 'trash';

export interface MutationRequest {
  kind: MutationKind;
  paths: string[];
  destination: string | null;
}

export interface MutationPlan {
  id: string;
  items: { path: string; kind: string; fileCount: number; hiddenCount: number; bytes: number }[];
  affectedPaths: string[];
  conflicts: string[];
  referrerRevisions: { path: string; revision: string }[];
}

export interface MutationResult {
  outcomes: {
    path: string;
    status: 'completed' | 'failed' | 'cancelled' | 'skipped';
    destination: string | null;
    message: string | null;
  }[];
  mappings: { from: string; to: string; id: string | null }[];
  affectedPaths: string[];
  recoveryId: string | null;
}

export interface RecoveryRecord {
  id: string;
  state: string;
  message: string;
  versions: string[];
  exportedTo: string | null;
  result: MutationResult | null;
}

export interface TrashEntry {
  id: string;
  path: string;
  deletedAt: number;
  kind: string;
  fileCount: number;
  bytes: number;
}

export interface ImportSelection {
  token: string;
  name: string;
  kind: 'markdown' | 'pdf' | 'docx';
}
