import { useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type { NoteDocument, VaultSnapshot } from './types';
import type {
  ImportSelection,
  MutationPlan,
  MutationRequest,
  MutationResult,
  RecoveryRecord,
  TrashEntry,
} from './usabilityTypes';

export interface FileActionsOptions {
  vault: VaultSnapshot | null;
  busy: boolean;
  run: <T>(operation: () => Promise<T>) => Promise<T>;
  guardPaths: (paths: string[], title: string) => Promise<boolean>;
  onMutation: (result: MutationResult) => void | Promise<void>;
  onCreated: (note: NoteDocument) => void;
  fail: (error: unknown) => void;
}

export interface FileActions {
  reportError: (error: unknown) => void;
  guardPaths: (paths: string[], title: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  createFolder: (path: string) => Promise<void>;
  createNote: (path: string, text?: string) => Promise<NoteDocument>;
  prepare: (request: MutationRequest) => Promise<MutationPlan>;
  commit: (planId: string) => Promise<MutationResult>;
  cancel: (planId: string) => Promise<void>;
  selectImports: () => Promise<ImportSelection[]>;
  importFiles: (tokens: string[], directory: string) => Promise<MutationResult>;
  listTrash: () => Promise<TrashEntry[]>;
  restoreTrash: (id: string, destination?: string | null) => Promise<MutationResult>;
  purgeTrash: (ids: string[]) => Promise<MutationResult>;
  recoveries: RecoveryRecord[];
  refreshRecoveries: (vaultId?: string) => Promise<void>;
  recoverMutation: (id: string) => Promise<RecoveryRecord>;
  exportRecovery: (id: string, destination: string) => Promise<MutationResult>;
  acknowledgeRecovery: (id: string) => Promise<RecoveryRecord>;
}

export function useFileActions(options: FileActionsOptions): FileActions {
  const latest = useRef(options);
  latest.current = options;
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryState, setRecoveryState] = useState<{
    vaultId: string;
    records: RecoveryRecord[];
  } | null>(null);

  function reportError(cause: unknown) {
    setError(errorMessage(cause));
    latest.current.fail(cause);
  }

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (!isTauri() || !latest.current.vault) {
      throw new Error('Open a desktop Vault before changing files.');
    }
    setLocalBusy(true);
    setError(null);
    try {
      return await latest.current.run(operation);
    } catch (cause) {
      let failure = cause;
      try {
        await refreshRecoveries();
      } catch (recoveryError) {
        failure = new Error(
          `${errorMessage(cause)} Recovery status could not be loaded: ${errorMessage(recoveryError)}. Keep this Vault open; retained versions have not been discarded.`,
        );
      }
      reportError(failure);
      throw failure;
    } finally {
      setLocalBusy(false);
    }
  }

  async function refreshRecoveries(vaultId = latest.current.vault?.id) {
    if (!vaultId || !isTauri()) {
      return;
    }
    const records = await invoke<RecoveryRecord[]>('vault_recovery_list');
    if (latest.current.vault?.id !== vaultId) {
      return;
    }
    for (const record of records) {
      if (record.result) {
        await latest.current.onMutation(record.result);
      }
    }
    setRecoveryState({
      vaultId,
      records: records.filter(
        (record) => !['recovered', 'acknowledged', 'ignored'].includes(record.state),
      ),
    });
  }

  async function perform(command: string, args: Record<string, unknown>): Promise<MutationResult> {
    return run(async () => {
      const result = await invoke<MutationResult>(command, args);
      await latest.current.onMutation(result);
      if (result.recoveryId) {
        await refreshRecoveries();
      }
      return result;
    });
  }

  function prepare(request: MutationRequest) {
    return run(() => invoke<MutationPlan>('vault_prepare_mutation', { request }));
  }

  async function recover(
    command: 'vault_recover_mutation' | 'vault_acknowledge_recovery',
    id: string,
  ) {
    return run(async () => {
      const record = await invoke<RecoveryRecord>(command, { id });
      if (record.result) {
        await latest.current.onMutation(record.result);
      }
      await refreshRecoveries();
      return record;
    });
  }

  return {
    reportError,
    guardPaths: (paths, title) => run(() => latest.current.guardPaths(paths, title)),
    busy: localBusy || options.busy,
    error,
    clearError: () => setError(null),
    createFolder: (path) =>
      run(async () => {
        await invoke('vault_create_folder', { path });
        await latest.current.onMutation({
          outcomes: [],
          mappings: [],
          affectedPaths: [path],
          recoveryId: null,
        });
      }),
    createNote: (path, text = '') =>
      run(async () => {
        const note = await invoke<NoteDocument>('vault_create_note', { path, text });
        latest.current.onCreated(note);
        return note;
      }),
    prepare,
    commit: (planId) => perform('vault_commit_mutation', { planId }),
    cancel: (planId) => run(() => invoke<void>('vault_cancel_mutation', { planId })),
    selectImports: () => run(() => invoke<ImportSelection[]>('vault_select_imports')),
    importFiles: (tokens, directory) => perform('vault_import_files', { tokens, directory }),
    listTrash: () => run(() => invoke<TrashEntry[]>('vault_list_trash')),
    restoreTrash: (id, destination = null) => perform('vault_restore_trash', { id, destination }),
    purgeTrash: (ids) =>
      run(async () => {
        const result: MutationResult = {
          outcomes: [],
          mappings: [],
          affectedPaths: [],
          recoveryId: null,
        };
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          try {
            const applied = await invoke<MutationResult>('vault_purge_trash', { ids: batch });
            result.outcomes.push(...applied.outcomes);
            result.affectedPaths.push(...applied.affectedPaths);
            result.recoveryId = applied.recoveryId ?? result.recoveryId;
          } catch (cause) {
            result.outcomes.push(
              ...batch.map((path) => ({
                path,
                status: 'failed' as const,
                destination: null,
                message: `No result received: ${errorMessage(cause)}. Refresh Trash to inspect remaining data; earlier completed deletions were not rolled back.`,
              })),
            );
            result.outcomes.push(
              ...ids.slice(offset + 100).map((path) => ({
                path,
                status: 'cancelled' as const,
                destination: null,
                message: 'Not attempted after the preceding batch failed.',
              })),
            );
            break;
          }
        }
        await latest.current.onMutation(result);
        return result;
      }),
    recoveries: recoveryState?.vaultId === options.vault?.id ? (recoveryState?.records ?? []) : [],
    refreshRecoveries,
    recoverMutation: (id) => recover('vault_recover_mutation', id),
    exportRecovery: (id, destination) =>
      run(async () => {
        const result = await invoke<MutationResult>('vault_export_recovery', { id, destination });
        await latest.current.onMutation(result);
        await refreshRecoveries();
        return result;
      }),
    acknowledgeRecovery: (id) => recover('vault_acknowledge_recovery', id),
  };
}
