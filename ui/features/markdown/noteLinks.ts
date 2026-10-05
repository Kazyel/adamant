import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { IndexState } from '../workspace/types';
import { growNoteLinkLimit, initialNoteLinkLimits, noteLinksIdentity } from './noteLinksPaging';
import type { NoteLinkList } from './noteLinksPaging';
import { queueNoteLinksRequest } from './noteLinksRequests';

export interface NoteLinkTarget {
  path: string;
  title: string;
  identity: string;
}

export interface IncomingNoteLink extends NoteLinkTarget {
  line: number;
  column: number;
  snippet: string;
  revision: string | null;
}

export interface OutgoingNoteLink {
  href: string;
  targetPath: string;
  status: 'resolved' | 'missing' | 'unindexed';
  line: number;
  snippet: string;
}

export interface NoteLinksSnapshot {
  path: string;
  outgoing: OutgoingNoteLink[];
  incoming: IncomingNoteLink[];
  targets: NoteLinkTarget[];
  canContinue: boolean;
  incomingHasMore: boolean;
  outgoingHasMore: boolean;
  targetsHasMore: boolean;
  referencesTruncated: boolean;
  indexing: IndexState;
  generation: number;
}

export interface NoteLinksSource {
  path: string;
  expectedIdentity: string | null;
  vaultKey: string;
  refreshKey?: string;
}

interface LoadState {
  key: string;
  snapshot: NoteLinksSnapshot | null;
  error: string | null;
  loading: boolean;
  paused: boolean;
}

export function useNoteLinks({
  path,
  expectedIdentity,
  vaultKey,
  refreshKey,
  query = '',
}: NoteLinksSource & { query?: string }) {
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(Promise.resolve());
  const key = noteLinksIdentity({ vaultKey, path, expectedIdentity, query });
  const [paging, setPaging] = useState({ key, limits: initialNoteLinkLimits });
  const limits = paging.key === key ? paging.limits : initialNoteLinkLimits;
  const [state, setState] = useState<LoadState | null>(null);
  const [watchError, setWatchError] = useState<{ vaultKey: string; message: string } | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    void listen('vault-changed', () => {
      if (active) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setRefresh((value) => value + 1), 150);
      }
    })
      .then((stop) => {
        if (active) {
          unlisten = stop;
        } else {
          stop();
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setWatchError({ vaultKey, message: errorMessage(cause) });
        }
      });
    return () => {
      active = false;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [vaultKey]);

  useEffect(() => {
    let active = true;
    let rounds = 0;
    let timer: number;

    async function request() {
      setState((current) => ({
        key,
        snapshot: current?.key === key ? current.snapshot : null,
        error: null,
        loading: true,
        paused: false,
      }));
      try {
        const snapshot = await invoke<NoteLinksSnapshot>('vault_note_links', {
          path,
          expectedIdentity,
          query,
          limits,
        });
        if (!active) {
          return;
        }
        rounds++;
        // Bound background work in large Vaults; the user can continue another batch.
        const paused = snapshot.canContinue && rounds >= 40;
        setState({ key, snapshot, error: null, loading: snapshot.canContinue && !paused, paused });
        if (snapshot.canContinue && !paused) {
          timer = window.setTimeout(() => void load(), Math.min(rounds * 100, 800));
        }
      } catch (cause) {
        if (active) {
          setState((current) => ({
            key,
            snapshot: current?.key === key ? current.snapshot : null,
            error: errorMessage(cause),
            loading: false,
            paused: false,
          }));
        }
      }
    }

    function load() {
      pending.current = queueNoteLinksRequest(pending.current, () => active, request);
      return pending.current;
    }

    timer = window.setTimeout(() => void load(), query ? 150 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [path, expectedIdentity, query, key, refresh, refreshKey, limits]);

  const current = state?.key === key ? state : null;
  return {
    snapshot: current?.snapshot ?? null,
    error: current?.error ?? null,
    loading: current?.loading ?? true,
    paused: current?.paused ?? false,
    watchError: watchError?.vaultKey === vaultKey ? watchError.message : null,
    retry: () => setRefresh((value) => value + 1),
    loadMore: (list: NoteLinkList) => {
      setPaging({ key, limits: growNoteLinkLimit(limits, list) });
    },
    canLoadMore: (list: NoteLinkList) => growNoteLinkLimit(limits, list) !== limits,
  };
}
