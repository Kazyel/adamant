import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type { ActionReceipt, RemoteAction, RemoteDetail, WorkItem, WorkState } from './types';
import type { DetailConfirm, DetailConfirmation, DetailExecute, DetailProps } from './DetailShared';

type RemoteSession = {
  connectionId: string;
  detail: RemoteDetail | null;
  loading: boolean;
  readError: string;
  actionError: string;
  receipt: string;
  confirmation: DetailConfirmation | null;
};

export type DetailRemoteState = RemoteSession & {
  pending: boolean;
  stale: boolean;
  actionsReady: boolean;
  supports: (kind: RemoteAction['kind']) => boolean;
  refresh: () => Promise<void>;
  confirm: DetailConfirm;
  execute: DetailExecute;
  dismissConfirmation: () => void;
};

function initialSession(connectionId: string): RemoteSession {
  return {
    connectionId,
    detail: null,
    loading: Boolean(connectionId),
    readError: '',
    actionError: '',
    receipt: '',
    confirmation: null,
  };
}

function mergeRemoteItem(current: WorkState, result: RemoteDetail): WorkState {
  return {
    ...current,
    items: current.items.map((entry) =>
      entry.id === result.item.id
        ? {
            ...result.item,
            priority: entry.priority,
            dueDate: entry.dueDate,
            checklist: entry.checklist,
            links: entry.links,
          }
        : entry,
    ),
  };
}

function clearSentDraft(current: WorkState, itemId: string, action: RemoteAction): WorkState {
  if (action.kind !== 'comment' && action.kind !== 'review') {
    return current;
  }
  return {
    ...current,
    drafts: current.drafts.filter(
      (draft) =>
        !(draft.itemId === itemId && draft.kind === action.kind && draft.body === action.body),
    ),
  };
}

export default function useDetailRemote(
  item: WorkItem,
  connectionId: string,
  onChange: DetailProps['onChange'],
  onBusyChange: DetailProps['onBusyChange'],
): DetailRemoteState {
  const [storedSession, setSession] = useState(() => initialSession(connectionId));
  const [pending, setPending] = useState(false);
  const session =
    storedSession.connectionId === connectionId ? storedSession : initialSession(connectionId);
  if (session !== storedSession) {
    setSession(session);
  }
  const live = useRef(false);
  const request = useRef(0);
  const actionInFlight = useRef(false);
  const activeConnection = useRef(connectionId);
  useLayoutEffect(() => {
    activeConnection.current = connectionId;
    request.current += 1;
  }, [connectionId]);
  const latestChange = useRef(onChange);
  useLayoutEffect(() => {
    latestChange.current = onChange;
  }, [onChange]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current += 1;
    };
  }, []);

  const provider = item.remote?.provider;
  const host = item.remote?.host;
  const scope = item.remote?.scope;
  const number = item.remote?.number;
  const itemId = item.id;
  const readRemote = useCallback(() => {
    if (!provider || !host || !scope || !number || !connectionId) {
      return Promise.resolve();
    }
    if (activeConnection.current !== connectionId) {
      return Promise.resolve();
    }
    const version = ++request.current;
    return invoke<RemoteDetail>('work_remote_detail', {
      connectionId,
      remote: { provider, host, scope, number },
    })
      .then((result) => {
        if (!live.current || version !== request.current) {
          return;
        }
        if (result.item.id !== itemId) {
          throw new Error('The provider returned a different item. No changes were applied.');
        }
        setSession((current) =>
          current.connectionId === connectionId
            ? { ...current, detail: result, loading: false, readError: '' }
            : current,
        );
        latestChange.current((current) => mergeRemoteItem(current, result));
      })
      .catch((error: unknown) => {
        if (!live.current || version !== request.current) {
          return;
        }
        setSession((current) =>
          current.connectionId === connectionId
            ? { ...current, loading: false, readError: errorMessage(error) }
            : current,
        );
      });
  }, [connectionId, host, itemId, number, provider, scope]);

  useEffect(() => {
    void readRemote();
    return () => {
      request.current += 1;
    };
  }, [readRemote]);

  async function refresh() {
    setSession((current) => ({ ...current, loading: Boolean(connectionId), readError: '' }));
    await readRemote();
  }

  const stale = !session.detail || session.detail.stale || Boolean(session.readError);
  const actionsReady = Boolean(
    connectionId && session.detail && !stale && !session.loading && !pending,
  );
  const supports = (kind: RemoteAction['kind']) => session.detail?.actions.includes(kind) ?? false;

  function confirm(action: RemoteAction, title: string, effect: string) {
    if (!actionsReady || !supports(action.kind)) {
      return;
    }
    setSession((current) => ({
      ...current,
      actionError: '',
      receipt: '',
      confirmation: { action, title, effect, connectionId },
    }));
  }

  function recordActionFailure(error: unknown) {
    if (!live.current || activeConnection.current !== connectionId) {
      return;
    }
    setSession((current) => ({
      ...current,
      confirmation: null,
      actionError: `${errorMessage(error)} Your draft has been kept. Check the provider before trying again; the request will not be retried automatically.`,
      detail: current.detail ? { ...current.detail, stale: true } : null,
    }));
  }

  async function execute(
    action: RemoteAction,
    approvedConnectionId = connectionId,
  ): Promise<boolean> {
    if (
      !item.remote ||
      actionInFlight.current ||
      !actionsReady ||
      !supports(action.kind) ||
      approvedConnectionId !== connectionId
    ) {
      return false;
    }
    if (action.kind === 'review' && !action.expectedHeadSha) {
      return false;
    }
    actionInFlight.current = true;
    onBusyChange?.(true);
    setPending(true);
    setSession((current) => ({ ...current, actionError: '', receipt: '' }));
    try {
      const result = await invoke<ActionReceipt>('work_remote_act', {
        connectionId: approvedConnectionId,
        remote: item.remote,
        action,
        expectedItemId: itemId,
      });
      latestChange.current((current) => clearSentDraft(current, itemId, action));
      if (!live.current || activeConnection.current !== approvedConnectionId) {
        return true;
      }
      setSession((current) => ({
        ...current,
        confirmation: null,
        receipt: result.message,
        detail: current.detail ? { ...current.detail, stale: true } : null,
      }));
      await refresh();
      return true;
    } catch (error) {
      recordActionFailure(error);
      return false;
    } finally {
      actionInFlight.current = false;
      onBusyChange?.(false);
      if (live.current) {
        setPending(false);
      }
    }
  }

  function dismissConfirmation() {
    if (!pending) {
      setSession((current) => ({ ...current, confirmation: null }));
    }
  }

  return {
    ...session,
    pending,
    stale,
    actionsReady,
    supports,
    refresh,
    confirm,
    execute,
    dismissConfirmation,
  };
}
