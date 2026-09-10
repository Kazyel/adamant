import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { VaultSnapshot, WorkspacePrompt } from './types';

type Answer = string | null;

export default function useWorkspacePrompt() {
  const [prompt, setPrompt] = useState<WorkspacePrompt | null>(null);
  const resolver = useRef<((answer: Answer) => void) | null>(null);

  function ask(next: WorkspacePrompt): Promise<Answer> {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setPrompt(next);
    });
  }

  function answer(value: Answer) {
    const resolve = resolver.current;
    resolver.current = null;
    setPrompt(null);
    resolve?.(value);
  }

  async function selectVault(mode: 'create' | 'open'): Promise<VaultSnapshot | null> {
    if (mode === 'open') {
      return invoke<VaultSnapshot | null>('vault_open');
    }
    // Match the ES2022 desktop target and the existing dialog resolver.
    return new Promise((resolve) => {
      resolver.current = () => resolve(null);
      setPrompt({
        kind: 'create',
        title: 'Create Vault',
        complete: (snapshot) => {
          resolver.current = null;
          setPrompt(null);
          resolve(snapshot);
        },
      });
    });
  }

  return { prompt, resolver, ask, answer, selectVault };
}
