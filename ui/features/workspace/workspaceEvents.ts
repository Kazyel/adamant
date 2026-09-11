import type { RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface WorkspaceActions {
  refresh: () => void;
  close: () => void;
  flushDrafts: () => Promise<void>;
}

const native = isTauri();

export default function subscribeWorkspaceEvents(
  actions: RefObject<WorkspaceActions>,
  confirmedClose: RefObject<boolean>,
  hasUnsaved: () => boolean,
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
    for (const name of [
      'vault-import-start',
      'vault-import-hover',
      'vault-import-dropped',
      'vault-import-error',
    ]) {
      void listen(name, (event) => {
        if (!disposed) {
          window.dispatchEvent(new CustomEvent(name, { detail: event.payload }));
        }
      })
        .then(registered)
        .catch(fail);
    }
    void getCurrentWindow()
      .onFocusChanged((event) => {
        if (!disposed && !event.payload) {
          void actions.current.flushDrafts().catch(fail);
        }
      })
      .then(registered)
      .catch(fail);
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

  const unload = (event: BeforeUnloadEvent) => {
    if (!confirmedClose.current && hasUnsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };

  window.addEventListener('beforeunload', unload);
  return () => {
    disposed = true;
    onDispose();
    unlisteners.forEach((unlisten) => unlisten());
    window.removeEventListener('beforeunload', unload);
  };
}
