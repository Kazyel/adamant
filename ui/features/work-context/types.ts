type Provider = 'github' | 'jira';
type ItemKind = 'local' | 'github-issue' | 'github-pr' | 'jira';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface Connection {
  id: string;
  provider: Provider;
  account: string;
  host: string;
}

export interface RemoteRef {
  provider: Provider;
  host: string;
  scope: string;
  number: string;
}

export interface WorkItem {
  id: string;
  kind: ItemKind;
  title: string;
  description: string;
  remote: RemoteRef | null;
  url: string | null;
  remoteState: string | null;
  assignee: string;
  labels: string[];
  priority: Priority;
  dueDate: string;
  checklist: { id: string; text: string; done: boolean }[];
  links: { id: string; label: string; target: string }[];
  updatedAt: string;
  fetchedAt: string | null;
}

export interface WorkSource {
  id: string;
  connectionId: string;
  provider: Provider;
  host: string;
  scope: string;
  filter: string;
}

export interface WorkView {
  mode: 'list' | 'board';
  query: string;
  kind: ItemKind | 'all';
  priority: Priority | 'all';
  sort: 'manual' | 'updated' | 'priority' | 'due';
}

export interface WorkSpace {
  id: string;
  name: string;
  columns: { id: string; name: string }[];
  members: { itemId: string; columnId: string }[];
  sources: WorkSource[];
  view: WorkView;
}

export interface WorkDraft {
  itemId: string;
  kind: 'comment' | 'review';
  body: string;
  updatedAt: string;
}

export interface WorkState {
  version: 1;
  vaultId: string;
  revision: number;
  activeSpaceId: string | null;
  spaces: WorkSpace[];
  items: WorkItem[];
  drafts: WorkDraft[];
}

type RemoteActionKind = 'comment' | 'edit' | 'close' | 'reopen' | 'transition' | 'review' | 'merge';
export interface RemoteAction {
  kind: RemoteActionKind;
  body?: string;
  assignee?: string;
  labels?: string[];
  priority?: string;
  transitionId?: string;
  reviewEvent?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  expectedHeadSha?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export interface RemoteDetail {
  item: WorkItem;
  comments: { id: string; author: string; body: string; updatedAt: string }[];
  commits: { sha: string; message: string; author: string }[];
  checks: { name: string; status: string; url: string | null }[];
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }[];
  transitions: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  actions: RemoteActionKind[];
  headSha: string | null;
  partial: boolean;
  warnings: string[];
  editableFields: ('assignee' | 'labels' | 'priority')[];
  stale: boolean;
}

export interface RemotePage {
  items: WorkItem[];
  nextCursor: string | null;
  warning: string | null;
}

export interface ActionReceipt {
  message: string;
}
