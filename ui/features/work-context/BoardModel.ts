import type useWorkContext from './useWorkContext';
import type { WorkItem, WorkSource } from './types';

export type BoardWork = ReturnType<typeof useWorkContext>;
export type BoardDialog =
  | { kind: 'space'; rename?: boolean }
  | { kind: 'task'; columnId?: string }
  | { kind: 'source'; source?: WorkSource }
  | { kind: 'follow' }
  | { kind: 'existing' }
  | { kind: 'columns' }
  | { kind: 'conflict' };

export function itemReference(item: WorkItem): string {
  if (!item.remote) {
    return '';
  }
  if (item.kind === 'jira') {
    return item.remote.number;
  }
  return `${item.remote.scope}#${item.remote.number}`;
}
