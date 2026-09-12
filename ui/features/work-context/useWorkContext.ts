import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type { VaultSnapshot } from '../workspace/types';
import { attachItems, remoteFromUrl } from './state';
import type { Connection, RemoteDetail, RemotePage, WorkSource, WorkState } from './types';

type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error';
type Session = {
  vaultId: string;
  root: string;
  state: WorkState | null;
  status: SaveStatus;
  error: string | null;
  generation: number;
  dirty: boolean;
  pending: Promise<void> | null;
  timer: number | undefined;
};
export type SourceStatus = {
  loading: boolean;
  cursor: string | null;
  fetchedAt: string | null;
  error: string | null;
  warning: string | null;
};

type SessionSnapshot = Pick<Session, 'state' | 'status' | 'error' | 'dirty'>;
const emptySession: SessionSnapshot = {
  state: null,
  status: 'saved',
  error: null,
  dirty: false,
};
const loadingSession: SessionSnapshot = { ...emptySession, status: 'loading' };
const emptySourceStatus: SourceStatus = {
  loading: false,
  cursor: null,
  fetchedAt: null,
  error: null,
  warning: null,
};

function sourceMatches(session: Session | undefined, spaceId: string, source: WorkSource) {
  const state = session?.state;
  if (state?.activeSpaceId !== spaceId) {
    return false;
  }
  const currentSource = state.spaces
    .find((space) => space.id === spaceId)
    ?.sources.find((entry) => entry.id === source.id);
  return currentSource !== undefined && JSON.stringify(currentSource) === JSON.stringify(source);
}

export default function useWorkContext(vault: VaultSnapshot | null, active: boolean) {
  const native = isTauri();
  const vaultKey = vault ? JSON.stringify([vault.id, vault.root]) : null;
  const nativeVaultId = vault?.id ?? null;
  const root = vault?.root ?? null;
  const sessions = useRef(new Map<string, Session>());
  const currentVault = useRef(vaultKey);
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({});
  const mounted = useRef(true);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sourceStatuses, setSourceStatuses] = useState<Record<string, SourceStatus>>({});
  const sourceRequests = useRef(new Set<string>());
  const context = useRef({ vaultKey, spaceId: null as string | null, active, epoch: 0 });
  const notify = useCallback((key: string, session: Session) => {
    if (!mounted.current) {
      return;
    }
    const snapshot: SessionSnapshot = {
      state: session.state,
      status: session.status,
      error: session.error,
      dirty: session.dirty,
    };
    setSnapshots((current) => ({ ...current, [key]: snapshot }));
  }, []);

  const save = useCallback(
    (key: string, session: Session): Promise<void> => {
      if (session.pending) {
        return session.pending;
      }
      if (!session.state || !session.dirty || currentVault.current !== key) {
        return Promise.resolve();
      }
      window.clearTimeout(session.timer);
      session.timer = undefined;
      session.status = 'saving';
      session.error = null;
      session.pending = (async () => {
        try {
          while (session.state && session.dirty && currentVault.current === key) {
            const snapshot = session.state;
            const generation = session.generation;
            const saved = await invoke<WorkState>('work_save', {
              vaultId: session.vaultId,
              expectedRoot: session.root,
              state: snapshot,
              expectedRevision: snapshot.revision,
            });
            if (saved.vaultId !== session.vaultId) {
              throw new Error(
                'The saved workspace belongs to a different Vault. Your changes are retained.',
              );
            }
            session.state =
              generation === session.generation
                ? saved
                : { ...session.state, revision: saved.revision };
            session.dirty = generation !== session.generation;
          }
          session.status = session.dirty ? 'unsaved' : 'saved';
        } catch (error) {
          session.status = 'error';
          session.error = errorMessage(error);
          window.clearTimeout(session.timer);
          session.timer = undefined;
        } finally {
          session.pending = null;
          notify(key, session);
        }
      })();
      notify(key, session);
      return session.pending;
    },
    [notify],
  );

  const load = useCallback(
    (key: string, session: Session) => {
      session.status = 'loading';
      session.error = null;
      return Promise.resolve()
        .then(() =>
          invoke<WorkState>('work_load', {
            vaultId: session.vaultId,
            expectedRoot: session.root,
          }),
        )
        .then((loaded) => {
          if (loaded.vaultId !== session.vaultId) {
            throw new Error('The workspace belongs to a different Vault.');
          }
          if (!session.dirty) {
            session.state = loaded;
            session.status = 'saved';
          }
        })
        .catch((error: unknown) => {
          session.status = 'error';
          session.error = errorMessage(error);
        })
        .finally(() => notify(key, session));
    },
    [notify],
  );

  useLayoutEffect(() => {
    mounted.current = true;
    const sessionMap = sessions.current;
    const mountedRef = mounted;
    const contextRef = context;
    return () => {
      mountedRef.current = false;
      contextRef.current = { ...contextRef.current, epoch: contextRef.current.epoch + 1 };
      for (const session of sessionMap.values()) {
        window.clearTimeout(session.timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!vaultKey || !nativeVaultId || !root || !native) {
      return;
    }
    let session = sessions.current.get(vaultKey);
    if (!session) {
      session = {
        vaultId: nativeVaultId,
        root,
        state: null,
        status: 'loading',
        error: null,
        generation: 0,
        dirty: false,
        pending: null,
        timer: undefined,
      };
      sessions.current.set(vaultKey, session);
      void load(vaultKey, session);
    } else if (session.dirty && session.status !== 'error') {
      const pendingSession = session;
      session.timer = window.setTimeout(() => void save(vaultKey, pendingSession), 0);
    }
    return () => {
      window.clearTimeout(session.timer);
    };
  }, [vaultKey, nativeVaultId, root, native, load, save]);

  const snapshot = vaultKey ? (snapshots[vaultKey] ?? loadingSession) : emptySession;
  const state = snapshot.state;
  const spaceId = state?.activeSpaceId ?? null;
  useLayoutEffect(() => {
    currentVault.current = vaultKey;
    const previous = context.current;
    if (
      previous.vaultKey !== vaultKey ||
      previous.spaceId !== spaceId ||
      previous.active !== active
    ) {
      context.current = { vaultKey, spaceId, active, epoch: previous.epoch + 1 };
    }
  }, [vaultKey, spaceId, active]);

  const change = useCallback(
    (update: (state: WorkState) => WorkState) => {
      if (!vaultKey || currentVault.current !== vaultKey) {
        return;
      }
      const session = sessions.current.get(vaultKey);
      if (!session?.state) {
        return;
      }
      const next = update(session.state);
      if (next === session.state) {
        return;
      }
      session.state = { ...next, vaultId: session.vaultId, revision: session.state.revision };
      session.generation++;
      session.dirty = true;
      if (session.status !== 'error') {
        session.status = session.pending ? 'saving' : 'unsaved';
        window.clearTimeout(session.timer);
        session.timer = window.setTimeout(() => void save(vaultKey, session), 250);
      }
      notify(vaultKey, session);
    },
    [vaultKey, notify, save],
  );

  const reloadConnections = useCallback(async () => {
    if (!native) {
      return;
    }
    await Promise.resolve()
      .then(() => invoke<Connection[]>('work_connections'))
      .then((found) => {
        if (!mounted.current) {
          return;
        }
        setConnections(found);
        setConnectionError(null);
      })
      .catch((error: unknown) => {
        if (mounted.current) {
          setConnectionError(errorMessage(error));
        }
      });
  }, [native]);
  useEffect(() => {
    if (active) {
      void reloadConnections();
    }
  }, [active, reloadConnections]);

  const refreshSource = useCallback(
    async (source: WorkSource, more = false) => {
      const request = context.current;
      if (!request.active || !request.vaultKey || !request.spaceId) {
        return;
      }
      const key = JSON.stringify([request.vaultKey, request.spaceId, source]);
      if (sourceRequests.current.has(key)) {
        return;
      }
      const previous = sourceStatuses[key] ?? emptySourceStatus;
      if (more && !previous.cursor) {
        return;
      }
      sourceRequests.current.add(key);
      setSourceStatuses((statuses) => ({
        ...statuses,
        [key]: {
          ...previous,
          error: null,
          loading: true,
        },
      }));
      function applyPage(page: RemotePage) {
        if (!mounted.current || context.current.epoch !== request.epoch) {
          return;
        }
        if (!sourceMatches(sessions.current.get(request.vaultKey!), request.spaceId!, source)) {
          return;
        }
        change((current) => attachItems(current, request.spaceId!, page.items));
        setSourceStatuses((statuses) => ({
          ...statuses,
          [key]: {
            loading: false,
            cursor: page.nextCursor,
            fetchedAt: new Date().toISOString(),
            error: null,
            warning: page.warning,
          },
        }));
      }
      try {
        const page = await invoke<RemotePage>('work_remote_list', {
          connectionId: source.connectionId,
          source,
          cursor: more ? previous.cursor : null,
        });
        applyPage(page);
      } catch (error) {
        if (mounted.current && context.current.epoch === request.epoch) {
          setSourceStatuses((statuses) => ({
            ...statuses,
            [key]: {
              ...previous,
              loading: false,
              error: errorMessage(error),
            },
          }));
        }
      } finally {
        sourceRequests.current.delete(key);
        if (mounted.current) {
          setSourceStatuses((statuses) =>
            statuses[key]?.loading
              ? { ...statuses, [key]: { ...statuses[key], loading: false } }
              : statuses,
          );
        }
      }
    },
    [change, sourceStatuses],
  );
  const refreshCurrentSource = useEffectEvent((source: WorkSource) => refreshSource(source));
  const sources = state?.spaces.find((space) => space.id === spaceId)?.sources;
  const sourcesKey = JSON.stringify(sources ?? []);

  useEffect(() => {
    if (!active || !native || !vaultKey || !spaceId) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        return;
      }
      const epoch = context.current.epoch;
      const currentSources =
        sessions.current.get(vaultKey)?.state?.spaces.find((space) => space.id === spaceId)
          ?.sources ?? [];
      for (const source of currentSources) {
        if (
          cancelled ||
          epoch !== context.current.epoch ||
          document.visibilityState !== 'visible' ||
          !navigator.onLine
        ) {
          break;
        }
        await refreshCurrentSource(source);
      }
    };
    void Promise.resolve().then(refresh);
    const timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, native, vaultKey, spaceId, sourcesKey]);

  const follow = useCallback(
    async (url: string, connectionId: string, signal?: AbortSignal) => {
      const request = context.current;
      if (!request.vaultKey || !request.spaceId || !request.active) {
        return null;
      }
      const connection = connections.find((entry) => entry.id === connectionId);
      if (!connection) {
        throw new Error('Select an available connection first.');
      }
      const remote = remoteFromUrl(url, connection);
      const detail = await invoke<RemoteDetail>('work_remote_detail', { connectionId, remote });
      if (!mounted.current || signal?.aborted || context.current.epoch !== request.epoch) {
        return null;
      }
      if (sessions.current.get(request.vaultKey)?.state?.activeSpaceId !== request.spaceId) {
        return null;
      }
      change((current) => attachItems(current, request.spaceId!, [detail.item]));
      return detail;
    },
    [change, connections],
  );

  const retry = useCallback(() => {
    const session = vaultKey ? sessions.current.get(vaultKey) : null;
    if (!vaultKey || !session) {
      return;
    }
    if (session.state) {
      void save(vaultKey, session);
    } else {
      void load(vaultKey, session);
      notify(vaultKey, session);
    }
  }, [vaultKey, load, save, notify]);

  const readSaved = useCallback(async () => {
    if (!vaultKey || !nativeVaultId) {
      throw new Error('Open a Vault first.');
    }
    const saved = await invoke<WorkState>('work_load', {
      vaultId: nativeVaultId,
      expectedRoot: root,
    });
    if (saved.vaultId !== nativeVaultId || currentVault.current !== vaultKey) {
      throw new Error('The active Vault changed. Your edits have been retained.');
    }
    return saved;
  }, [vaultKey, nativeVaultId, root]);

  const resolve = useCallback(
    (saved: WorkState, keepMine: boolean) => {
      if (!vaultKey || saved.vaultId !== nativeVaultId || currentVault.current !== vaultKey) {
        return;
      }
      const session = sessions.current.get(vaultKey);
      if (!session?.state || session.pending) {
        return;
      }
      session.state = keepMine ? { ...session.state, revision: saved.revision } : saved;
      session.generation++;
      session.dirty = keepMine;
      session.status = keepMine ? 'unsaved' : 'saved';
      session.error = null;
      notify(vaultKey, session);
      if (keepMine) {
        void save(vaultKey, session);
      }
    },
    [vaultKey, nativeVaultId, notify, save],
  );

  const flush = useCallback(async () => {
    // Invalidate read results before flushing so a response cannot dirty a Vault after its final save.
    context.current = { ...context.current, epoch: context.current.epoch + 1 };
    for (const [key, session] of sessions.current) {
      window.clearTimeout(session.timer);
      if (session.pending) {
        await session.pending;
      }
      if (session.dirty && session.status !== 'error') {
        await save(key, session);
      }
      if (session.dirty) {
        throw new Error(
          `Work context has unsaved changes. Return to Work context and resolve its save error before leaving this Vault. ${session.error ?? ''}`.trim(),
        );
      }
    }
  }, [save]);

  return {
    native,
    vaultKey,
    state,
    change,
    connections,
    connectionError,
    reloadConnections,
    sourceStatuses,
    refreshSource,
    follow,
    retry,
    readSaved,
    resolve,
    flush,
    status: snapshot.status,
    saveError: snapshot.error,
    dirty: snapshot.dirty,
  };
}
