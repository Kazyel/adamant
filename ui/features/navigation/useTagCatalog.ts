import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { TagsSnapshot } from './tagTypes';

export function useTagCatalog(vaultKey: string | null, query = '') {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    key: string;
    snapshot: TagsSnapshot | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!vaultKey || !isTauri()) {
      return;
    }
    let active = true;
    let stop: (() => void) | undefined;
    let timer: number;
    void listen('vault-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRefresh((value) => value + 1), 180);
    })
      .then((unlisten) => {
        if (active) {
          stop = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      window.clearTimeout(timer);
      stop?.();
    };
  }, [vaultKey]);
  useEffect(() => {
    if (!vaultKey || !isTauri()) {
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void invoke<TagsSnapshot>('vault_tags', { query })
        .then((snapshot) => {
          if (active) {
            setState({ key: vaultKey, snapshot, error: null });
          }
        })
        .catch((cause: unknown) => {
          if (active) {
            setState((current) => ({
              key: vaultKey,
              snapshot: current?.key === vaultKey ? current.snapshot : null,
              error: errorMessage(cause),
            }));
          }
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [vaultKey, query, refresh]);
  return state?.key === vaultKey ? state : null;
}
