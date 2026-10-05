import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errorMessage } from '../../shared/errors';
import type { VaultSnapshot } from '../workspace/types';
import { rememberGraph, travelGraph, type GraphHistory } from './graphHistory';
import { refreshGraph } from './graphRefresh';
import { graphRecord, type GraphSnapshot } from './graphTypes';

export default function useGraph(
  vault: VaultSnapshot | null,
  registerGuard: (guard: (() => Promise<void>) | null) => void,
) {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const current = useRef(snapshot);
  const [historyState, setHistoryState] = useState<GraphHistory>({ past: [], future: [] });
  const history = useRef(historyState);
  function updateHistory(next: GraphHistory) {
    history.current = next;
    setHistoryState(next);
  }
  const [error, setError] = useState('');
  const failure = useRef('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [referencesPaused, setReferencesPaused] = useState(false);
  const version = useRef(0);
  const saved = useRef(0);
  const writing = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefresh = useRef(false);
  const readSequence = useRef(0);
  const mounted = useRef(true);
  const scope = vault ? { root: vault.root, vaultId: vault.id } : null;

  function update(next: GraphSnapshot) {
    current.current = next;
    setSnapshot(next);
  }

  function stopRefresh() {
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    readSequence.current++;
  }

  function scheduleRefresh(round = 0) {
    stopRefresh();
    pendingRefresh.current = true;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void read(false, round);
    }, 200);
  }

  function activeRead(sequence: number) {
    return mounted.current && readSequence.current === sequence;
  }

  function acceptRead(next: GraphSnapshot, replace: boolean, round: number) {
    if (replace || !current.current) {
      updateHistory({ past: [], future: [] });
      update(next);
    } else {
      update(refreshGraph(current.current, next));
    }
    if (!failure.current) {
      setError('');
    }
    const paused = next.references.canContinue && round >= 39;
    setReferencesPaused(paused);
    setLoading(false);
    if (next.references.canContinue && !paused) {
      scheduleRefresh(round + 1);
    }
  }

  async function read(replace = false, round = 0) {
    if (!mounted.current) {
      return;
    }
    if (!scope || version.current !== saved.current || writing.current) {
      pendingRefresh.current = true;
      if (mounted.current) {
        setLoading(false);
      }
      return;
    }
    stopRefresh();
    pendingRefresh.current = false;
    const sequence = readSequence.current;
    const captured = version.current;
    try {
      const next = await invoke<GraphSnapshot>('vault_graph', scope);
      if (activeRead(sequence) && version.current === captured && !writing.current) {
        acceptRead(next, replace, round);
      }
    } catch (reason) {
      if (activeRead(sequence) && !failure.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (activeRead(sequence)) {
        setLoading(false);
      }
    }
  }

  async function persist() {
    if (!scope || !current.current) {
      return;
    }
    while (saved.current !== version.current) {
      stopRefresh();
      pendingRefresh.current = true;
      const captured = version.current;
      const data = current.current;
      const next = await invoke<GraphSnapshot>('vault_save_graph', {
        ...scope,
        expectedRevision: data.revision,
        graph: graphRecord(data),
      });
      saved.current = captured;
      if (mounted.current) {
        if (version.current === captured) {
          update(next);
        } else {
          update({ ...current.current, revision: next.revision });
        }
        setDirty(saved.current !== version.current);
      }
    }
  }

  async function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (writing.current) {
      return writing.current;
    }
    if (failure.current) {
      throw new Error(failure.current);
    }
    if (saved.current === version.current) {
      return;
    }
    setSaving(true);
    const pending = persist()
      .catch((reason: unknown) => {
        failure.current = errorMessage(reason);
        if (mounted.current) {
          setError(failure.current);
        }
        throw reason;
      })
      .finally(() => {
        writing.current = null;
        if (mounted.current) {
          setSaving(false);
          if (pendingRefresh.current && !failure.current) {
            scheduleRefresh();
          }
        }
      });
    writing.current = pending;
    return pending;
  }

  function commit(next: GraphSnapshot) {
    stopRefresh();
    pendingRefresh.current = true;
    setLoading(false);
    update(next);
    version.current++;
    setDirty(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    if (!failure.current) {
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 450);
    }
  }

  function edit(transform: (snapshot: GraphSnapshot) => GraphSnapshot) {
    if (!current.current) {
      return;
    }
    const next = transform(current.current);
    const remembered = rememberGraph(history.current, current.current, next);
    if (remembered === history.current) {
      return;
    }
    updateHistory(remembered);
    commit(next);
  }

  function travel(direction: 'undo' | 'redo') {
    if (!current.current) {
      return;
    }
    const result = travelGraph(history.current, current.current, direction);
    if (result) {
      updateHistory(result.history);
      commit(result.snapshot);
    }
  }

  const initialize = useEffectEvent(() => read());
  const changed = useEffectEvent(() => scheduleRefresh());
  const guard = useEffectEvent(flush);
  useEffect(() => {
    mounted.current = true;
    registerGuard(() => guard());
    return () => {
      mounted.current = false;
      stopRefresh();
      registerGuard(null);
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [registerGuard]);
  useEffect(() => {
    void Promise.resolve().then(initialize);
  }, [vault?.indexing.state, vault?.indexing.scannedEntries]);
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listen('vault-changed', () => {
      if (!disposed) {
        changed();
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unsubscribe = unlisten;
        }
      })
      .catch((reason: unknown) => {
        if (!disposed && !failure.current) {
          setError(errorMessage(reason));
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return {
    snapshot,
    loading,
    saving,
    dirty,
    referencesPaused,
    continueReferences: () => {
      setReferencesPaused(false);
      scheduleRefresh();
    },
    error,
    edit,
    canUndo: historyState.past.length > 0,
    canRedo: historyState.future.length > 0,
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    refresh: () => {
      setLoading(true);
      void read(true);
    },
    retry: () => {
      failure.current = '';
      setError('');
      void flush().catch(() => {});
    },
    reload: async () => {
      stopRefresh();
      if (writing.current) {
        try {
          await writing.current;
        } catch {
          /* Explicit discard follows. */
        }
      }
      saved.current = version.current;
      failure.current = '';
      setDirty(false);
      updateHistory({ past: [], future: [] });
      current.current = null;
      setSnapshot(null);
      setLoading(true);
      await read(true);
    },
  };
}
