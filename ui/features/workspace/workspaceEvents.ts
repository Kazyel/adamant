import type { RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { BufferState } from './buffer';

interface WorkspaceActions {
  refresh: () => void;
  save: () => void;
  close: () => void;
}

const native = isTauri();

export default function subscribeWorkspaceEvents(
  actions: RefObject<WorkspaceActions>,
  confirmedClose: RefObject<boolean>,
  bufferRef: RefObject<BufferState>,
  resolver: RefObject<((answer: string | null) => void) | null>,
  fail: (error: unknown) => void,
  onDispose: () => void,
) {
  let disposed = false;
  const unlisteners: (() => void)[] = [];

  function registered(unlisten: () => void) {
    if (disposed) {
      unlisten();
    } else {
      unlisteners.push(unlisten);
    }
  }

  if (native) {
    void listen('vault-changed', () => {
      if (!disposed) {
        actions.current.refresh();
      }
    })
      .then(registered)
      .catch((error: unknown) => {
        if (!disposed) {
          fail(error);
        }
      });
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (disposed || confirmedClose.current) {
          return;
        }
        event.preventDefault();
        actions.current.close();
      })
      .then(registered)
      .catch((error: unknown) => {
        if (!disposed) {
          fail(error);
        }
      });
  }

  const saveKey = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!resolver.current) {
        actions.current.save();
      }
    }
  };
  const unload = (event: BeforeUnloadEvent) => {
    const current = bufferRef.current;
    if (!confirmedClose.current && (current.text !== current.savedText || current.conflict)) {
      event.preventDefault();
      event.returnValue = '';
    }
  };

  window.addEventListener('keydown', saveKey, true);
  window.addEventListener('beforeunload', unload);
  return () => {
    disposed = true;
    onDispose();
    unlisteners.forEach((unlisten) => unlisten());
    window.removeEventListener('keydown', saveKey, true);
    window.removeEventListener('beforeunload', unload);
  };
}
