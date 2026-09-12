import { invoke, isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import { connectionHost } from './state';
import type { Connection, RemoteAction, WorkDraft, WorkItem, WorkSpace, WorkState } from './types';

export type DetailProps = {
  item: WorkItem;
  space: WorkSpace;
  state: WorkState;
  connections: Connection[];
  onChange: (update: (state: WorkState) => WorkState) => void;
  onClose: () => void;
  onOpenNote: (target: string) => void;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

export type DetailItemUpdate = (update: (current: WorkItem) => WorkItem) => void;
export type DetailConfirmation = {
  action: RemoteAction;
  title: string;
  effect: string;
  connectionId: string;
};
export type DetailConfirm = (action: RemoteAction, title: string, effect: string) => void;
export type DetailExecute = (
  action: RemoteAction,
  approvedConnectionId?: string,
) => Promise<boolean>;
export type DetailSaveDraft = (kind: WorkDraft['kind'], body: string) => void;
export type DetailOpenExternal = (url: string) => Promise<void>;

export function detailAccounts(item: WorkItem, connections: Connection[]): Connection[] {
  const remote = item.remote;
  if (!remote) {
    return [];
  }
  return connections.filter(
    (connection) =>
      connection.provider === remote.provider &&
      connectionHost(connection.host) === connectionHost(remote.host),
  );
}

export function detailConnectionId(
  item: WorkItem,
  space: WorkSpace,
  accounts: Connection[],
  selected: string,
): string {
  const remote = item.remote;
  if (!remote) {
    return '';
  }
  const preferred = space.sources.find(
    (source) =>
      source.provider === remote.provider &&
      connectionHost(source.host) === connectionHost(remote.host) &&
      source.scope === remote.scope,
  )?.connectionId;
  return (
    accounts.find((connection) => connection.id === selected)?.id ??
    accounts.find((connection) => connection.id === preferred)?.id ??
    accounts[0]?.id ??
    ''
  );
}

export function detailTarget(item: WorkItem): string {
  const remote = item.remote;
  if (!remote) {
    return item.title;
  }
  const number =
    remote.provider === 'jira' && item.url
      ? (/\/browse\/([^/?#]+)\/?$/.exec(item.url)?.[1] ?? remote.number)
      : remote.number;
  return `${remote.host}/${remote.scope} ${remote.provider === 'github' ? '#' : ''}${number}`;
}

export function externalUrl(target: string): string | null {
  try {
    const url = new URL(target);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function portableNote(target: string): boolean {
  for (const character of target) {
    if (character.charCodeAt(0) < 32) {
      return false;
    }
  }
  return (
    Boolean(target.trim()) &&
    !target.startsWith('/') &&
    !/[\\:#?]/.test(target) &&
    target.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
  );
}

export async function openDetailExternal(
  url: string,
  onError: (message: string) => void,
): Promise<void> {
  const destination = externalUrl(url);
  if (!destination) {
    onError('Only HTTP or HTTPS links without embedded credentials can be opened.');
    return;
  }
  try {
    if (isTauri()) {
      await invoke('open_link', { url: destination });
    } else {
      window.open(destination, '_blank', 'noopener,noreferrer');
    }
  } catch (error) {
    onError(errorMessage(error));
  }
}

export function timestamp(value: string | null): string {
  if (!value) {
    return 'Not refreshed yet';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown refresh time' : date.toLocaleString();
}

export function updateDetailItem(
  onChange: DetailProps['onChange'],
  itemId: string,
  update: (current: WorkItem) => WorkItem,
) {
  onChange((current) => ({
    ...current,
    items: current.items.map((entry) =>
      entry.id === itemId ? { ...update(entry), updatedAt: new Date().toISOString() } : entry,
    ),
  }));
}

export function saveDetailDraft(
  onChange: DetailProps['onChange'],
  itemId: string,
  kind: WorkDraft['kind'],
  body: string,
) {
  onChange((current) => ({
    ...current,
    drafts: [
      ...current.drafts.filter((draft) => draft.itemId !== itemId || draft.kind !== kind),
      ...(body ? [{ itemId, kind, body, updatedAt: new Date().toISOString() }] : []),
    ],
  }));
}
