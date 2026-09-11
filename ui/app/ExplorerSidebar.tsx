import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DragEvent, MouseEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import VaultExplorer from '../features/workspace/VaultExplorer';
import ExplorerSort from '../features/workspace/ExplorerSort';
import DialogFrame from '../features/workspace/DialogFrame';
import { errorMessage } from '../shared/errors';
import type { FileActions } from '../features/workspace/useFileActions';
import type {
  ImportSelection,
  MutationKind,
  MutationPlan,
  MutationRequest,
  MutationResult,
  TrashEntry,
} from '../features/workspace/usabilityTypes';
import { ContextMenu } from '../features/interaction/ContextMenu';
import type { UserAction } from '../features/interaction/types';
import type { VaultEntry } from '../features/workspace/types';
import type { DocumentProps, WorkspaceProps } from './workspaceView';
import type { Workspace } from '../features/workspace/workspaceTypes';
import { indexLabels, native } from './workspaceView';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import LoadingIndicator from '../shared/ui/LoadingIndicator';
import Atmosphere from './Atmosphere';

type MenuState = {
  x: number;
  y: number;
  entry?: VaultEntry;
  paths: string[];
  directory: string;
  trigger: HTMLElement | null;
};
type PlanState = { request: MutationRequest; plan: MutationPlan; refreshed?: boolean };
type ResultState = { title: string; result: MutationResult };
type DestinationState = { kind: 'move' | 'duplicate'; paths: string[]; initial: string };

function unavailableActions(workspace: Workspace, actions: FileActions) {
  if (!native) {
    return 'Available in the desktop application.';
  }
  if (!workspace.vault) {
    return 'Open a Vault first';
  }
  if (workspace.busy) {
    return 'Wait for the current operation';
  }
  if (actions.busy) {
    return 'Operation in progress';
  }
  return undefined;
}

function contextActionIds(menu: MenuState): ReadonlySet<string> {
  const single = menu.paths.length === 1;
  const directory = single && menu.entry?.kind === 'directory';
  const allowed = new Set<string>();
  if (!menu.paths.length || directory) {
    for (const id of ['new-note', 'new-folder', 'import', 'paste']) {
      allowed.add(`explorer.${id}`);
    }
  }
  if (menu.paths.length) {
    for (const id of ['cut', 'copy', 'move', 'duplicate', 'trash']) {
      allowed.add(`explorer.${id}`);
    }
  } else {
    allowed.add('explorer.trash.manage');
  }
  if (single) {
    allowed.add('explorer.rename');
    allowed.add('explorer.favorite');
    if (menu.entry?.kind === 'markdown') {
      allowed.add('explorer.copy-link');
    }
  }
  return allowed;
}

function contextTitle(menu: MenuState, vaultName: string): string {
  if (menu.paths.length > 1) {
    return `${menu.paths.length} items selected`;
  }
  return menu.entry?.path ?? (menu.directory || vaultName);
}

function ExplorerMenu({
  actions,
  menu,
  vaultName,
  onClose,
}: {
  actions: UserAction[];
  menu: MenuState | null;
  vaultName: string;
  onClose: () => void;
}) {
  if (!menu) {
    return null;
  }
  const allowed = contextActionIds(menu);
  return (
    <ContextMenu
      actions={actions.filter((action) => allowed.has(action.id))}
      position={menu}
      label={`Actions for ${contextTitle(menu, vaultName)}`}
      title={menu.paths.length > 1 ? contextTitle(menu, vaultName) : undefined}
      returnFocus={menu.trigger}
      onClose={onClose}
    />
  );
}

function TrashStatus({ entries, error }: { entries: TrashEntry[] | null; error: string | null }) {
  if (error) {
    return null;
  }
  if (entries === null) {
    return (
      <div className="explorer-dialog-empty">
        <LoadingIndicator label="Loading Trash" />
      </div>
    );
  }
  if (entries.length) {
    return null;
  }
  return (
    <div className="explorer-dialog-empty">
      <WorkspaceIcon name="trash" />
      <strong>Trash is empty</strong>
      <p>Items you delete from this Vault appear here.</p>
    </div>
  );
}

function planApproval(plan: MutationPlan) {
  return JSON.stringify({
    items: [...plan.items].sort((a, b) => a.path.localeCompare(b.path)),
    affectedPaths: [...plan.affectedPaths].sort(),
    conflicts: [...plan.conflicts].sort(),
    referrerRevisions: [...plan.referrerRevisions].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function mutationSelection(paths: ReadonlySet<string>, kind: MutationKind, result: MutationResult) {
  if (kind === 'duplicate') {
    return paths;
  }
  const completed = result.outcomes.filter((item) => item.status === 'completed');
  const next = new Set<string>();
  for (const path of paths) {
    if (
      kind === 'trash' &&
      completed.some((item) => path === item.path || path.startsWith(`${item.path}/`))
    ) {
      continue;
    }
    const mapping = result.mappings.find(
      (item) => path === item.from || path.startsWith(`${item.from}/`),
    );
    next.add(mapping ? `${mapping.to}${path.slice(mapping.from.length)}` : path);
  }
  return next;
}

function useExplorerReveal(workspace: Workspace, activePath: string | null, actions: FileActions) {
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [lastReveal, setLastReveal] = useState(workspace.revealTarget);
  const target = workspace.revealTarget;
  if (target !== lastReveal) {
    setLastReveal(target);
    setFilter('');
    setSelectedPaths(new Set(target?.path ? [target.path] : []));
  }
  const revealActive = useEffectEvent((path: string) => {
    void workspace.revealPath(path, { focus: false }).catch(actions.reportError);
  });
  useEffect(() => {
    if (activePath) {
      revealActive(activePath);
    }
  }, [activePath]);
  useEffect(() => {
    if (!target?.focus) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const selector = target.path
        ? `#explorer button[data-path="${CSS.escape(target.path)}"]`
        : '#explorer .vault-tree';
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return { selectedPaths, setSelectedPaths, filter, setFilter };
}

function CreateEntry({
  kind,
  value,
  disabled,
  directory,
  onChange,
  cancel,
  create,
}: {
  kind: 'note' | 'folder';
  value: string;
  disabled: boolean;
  directory: string;
  onChange: (value: string) => void;
  cancel: () => void;
  create: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    input.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) {
        requestAnimationFrame(() => {
          if (document.activeElement === document.body && trigger.isConnected) {
            trigger.focus({ preventScroll: true });
          }
        });
      }
    };
  }, []);
  return (
    <form
      className="explorer-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          create();
        }
      }}
    >
      <div className="explorer-create-caption">
        <label htmlFor="explorer-new-name">{kind === 'note' ? 'New Note' : 'New folder'}</label>
        <span title={directory || 'Vault root'}>{directory || 'Vault root'}</span>
      </div>
      <div className="explorer-create-field">
        <input
          ref={input}
          id="explorer-new-name"
          value={value}
          readOnly={disabled}
          placeholder={kind === 'note' ? 'Meeting.md' : 'Folder name'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              if (!disabled) {
                cancel();
              }
            }
          }}
        />
        <button
          className="icon-button"
          type="submit"
          title="Create"
          aria-label="Create"
          disabled={disabled || !value.trim()}
        >
          <WorkspaceIcon name="check" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Cancel"
          aria-label="Cancel"
          disabled={disabled}
          onClick={cancel}
        >
          <WorkspaceIcon name="close" />
        </button>
      </div>
    </form>
  );
}

function IndexDetails({
  workspace,
  detailsRef,
}: WorkspaceProps & { detailsRef: RefObject<HTMLDetailsElement | null> }) {
  const { indexing, indexAction, reconcile } = workspace;
  if (!indexing || (indexing.state !== 'partial' && indexing.state !== 'cancelled')) {
    return null;
  }
  return (
    <details className="index-status" ref={detailsRef}>
      <summary>
        <WorkspaceIcon name="warning" />
        <span>{indexLabels[indexing.state]} — files may be missing</span>
      </summary>
      <p>
        {indexing.message ??
          'Some files have not been checked. You can keep working with available files.'}
      </p>
      <button type="button" disabled={!native || indexAction !== null} onClick={reconcile}>
        {indexAction === 'reconcile' ? 'Scheduling…' : 'Reconcile index'}
      </button>
    </details>
  );
}

function VaultIssues({ vault }: { vault: NonNullable<Workspace['vault']> }) {
  if (vault.issueCount === 0) {
    return null;
  }
  return (
    <details className="vault-issues">
      <summary>
        {vault.issueCount.toLocaleString()} Vault {vault.issueCount === 1 ? 'issue' : 'issues'}
      </summary>
      {vault.issueCount > vault.issues.length ? (
        <p>
          Showing {vault.issues.length.toLocaleString()} of {vault.issueCount.toLocaleString()}{' '}
          issues. The issue list is truncated.
        </p>
      ) : null}
      <ul>
        {vault.issues.map((issue, index) => (
          <li key={`${issue.path}:${index}`}>
            <strong>{issue.path}</strong>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ResultDialog({ result, close }: { result: ResultState; close: () => void }) {
  const completed = result.result.outcomes.filter((item) => item.status === 'completed').length;
  return (
    <DialogFrame title={result.title} className="explorer-dialog" cancel={close}>
      <p className="explorer-dialog-summary" role="status">
        {completed} of {result.result.outcomes.length} item
        {result.result.outcomes.length === 1 ? '' : 's'} completed.
      </p>
      <ul className="explorer-outcomes">
        {result.result.outcomes.map((item) => (
          <li key={`${item.path}:${item.destination ?? ''}`} data-status={item.status}>
            <WorkspaceIcon name={item.status === 'completed' ? 'check' : 'warning'} />
            <div className="explorer-item-copy">
              <strong>{item.path}</strong>
              {item.destination ? (
                <span className="explorer-item-destination">→ {item.destination}</span>
              ) : null}
              <span className="explorer-outcome-status">{item.status}</span>
              {item.message ? <p>{item.message}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </DialogFrame>
  );
}

function PlanDialog({
  state,
  busy,
  cancel,
  commit,
}: {
  state: PlanState;
  busy: boolean;
  cancel: () => void;
  commit: () => void;
}) {
  const hidden = state.plan.items.reduce((sum, item) => sum + item.hiddenCount, 0);
  const files = state.plan.items.reduce((sum, item) => sum + item.fileCount, 0);
  const action = {
    rename: { title: 'Review rename', label: 'Rename' },
    move: { title: 'Review move', label: 'Move' },
    duplicate: { title: 'Review duplicate', label: 'Duplicate' },
    trash: { title: 'Move to Trash?', label: 'Move to Trash' },
  }[state.request.kind];
  return (
    <DialogFrame
      title={action.title}
      className="explorer-dialog explorer-plan-dialog"
      pending={busy}
      cancel={cancel}
    >
      {state.refreshed ? (
        <p className="explorer-warning" role="status">
          The operation scope or document revisions changed. Review this refreshed plan before
          confirming again.
        </p>
      ) : null}
      <p className="explorer-dialog-summary">
        This operation affects {state.plan.items.length} selected item
        {state.plan.items.length === 1 ? '' : 's'}, including {files} physical file
        {files === 1 ? '' : 's'}.
      </p>
      {state.request.destination !== null ? (
        <div className="explorer-target">
          <WorkspaceIcon name="forward" />
          <div className="explorer-item-copy">
            <span>{state.request.kind === 'rename' ? 'New path' : 'Destination'}</span>
            <strong>{state.request.destination || 'Vault root'}</strong>
          </div>
        </div>
      ) : (
        <p className="explorer-dialog-hint">You can restore these items from Trash.</p>
      )}
      {hidden ? (
        <p className="explorer-warning">
          <WorkspaceIcon name="warning" /> {hidden} hidden or unsupported{' '}
          {hidden === 1 ? 'descendant is' : 'descendants are'} included. The inventory cannot
          display them individually.
        </p>
      ) : null}
      {state.plan.conflicts.length ? (
        <div className="explorer-warning" role="alert">
          <strong>Cannot continue until conflicts are resolved.</strong>
          <ul>
            {state.plan.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="explorer-plan-list">
        {state.plan.items.map((item) => (
          <li key={item.path}>
            <WorkspaceIcon name={item.kind === 'directory' ? 'folder' : 'document'} />
            <div className="explorer-item-copy">
              <strong>{item.path}</strong>
              <span>
                {item.fileCount} {item.fileCount === 1 ? 'file' : 'files'} ·{' '}
                {item.bytes.toLocaleString()} bytes
                {item.hiddenCount ? ` · ${item.hiddenCount} hidden` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className={state.request.kind === 'trash' ? 'danger' : 'primary'}
          disabled={busy || !!state.plan.conflicts.length}
          onClick={commit}
        >
          {busy ? 'Applying…' : action.label}
        </button>
      </div>
    </DialogFrame>
  );
}

function DestinationDialog({
  directories,
  initial,
  title,
  busy,
  close,
  choose,
}: {
  directories: string[];
  initial: string;
  title: string;
  busy: boolean;
  close: () => void;
  choose: (directory: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DialogFrame title={title} className="explorer-dialog" pending={busy} cancel={close}>
      <form
        className="explorer-destination-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) {
            choose(value);
          }
        }}
      >
        <p className="explorer-dialog-summary">
          Choose a folder in this Vault. Existing items will not be overwritten.
        </p>
        <label className="path-label" htmlFor="explorer-destination">
          Destination folder
        </label>
        <input
          id="explorer-destination"
          value={value}
          placeholder="Vault root"
          disabled={busy}
          onChange={(event) => setValue(event.target.value.replace(/^\/+|\/+$/g, ''))}
        />
        <div className="explorer-destination-list" aria-label="Loaded folders">
          <button
            type="button"
            aria-pressed={value === ''}
            disabled={busy}
            onClick={() => setValue('')}
          >
            <WorkspaceIcon name="folder" />
            <span>Vault root</span>
          </button>
          {directories.filter(Boolean).map((directory) => (
            <button
              type="button"
              key={directory}
              aria-pressed={value === directory}
              disabled={busy}
              onClick={() => setValue(directory)}
            >
              <WorkspaceIcon name="folder" />
              <span>{directory}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Continue
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

function TrashDialog({
  actions,
  busy,
  close,
  onResult,
  directories,
}: {
  actions: FileActions;
  busy: boolean;
  close: () => void;
  onResult: (result: MutationResult, title: string) => void;
  directories: string[];
}) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [restoreDestination, setRestoreDestination] = useState<Record<string, string>>({});
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadEntries = useEffectEvent(async () => {
    try {
      setEntries(await actions.listTrash());
    } catch (cause) {
      setError(errorMessage(cause));
      setEntries([]);
    }
  });
  useEffect(() => {
    void Promise.resolve().then(loadEntries);
  }, []);
  const ids = [...selected];
  const items = entries ?? [];
  function completedEntries(result: MutationResult, candidates: TrashEntry[]) {
    const completed = result.outcomes.filter((item) => item.status === 'completed');
    if (completed.length === 1 && candidates.length === 1) {
      return new Set([candidates[0].id]);
    }
    const paths = new Set(completed.map((item) => item.path));
    return new Set(
      candidates
        .filter((entry) => paths.has(entry.path) || paths.has(entry.id))
        .map((entry) => entry.id),
    );
  }
  async function restore(entry: TrashEntry) {
    setError(null);
    try {
      const result = await actions.restoreTrash(entry.id, restoreDestination[entry.id] ?? null);
      onResult(result, 'Restore result');
      const done = completedEntries(result, [entry]);
      if (done.has(entry.id)) {
        setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? current);
      }
      const failed = result.outcomes.find((item) => item.status !== 'completed');
      if (failed) {
        setRestoreErrors((current) => ({
          ...current,
          [entry.id]: failed.message ?? 'Restore was not completed.',
        }));
      }
    } catch (cause) {
      const text = errorMessage(cause);
      setRestoreErrors((current) => ({ ...current, [entry.id]: text }));
    }
  }
  async function purge() {
    if (!purgeIds?.length) {
      return;
    }
    setPurging(true);
    setError(null);
    const targets = entries?.filter((entry) => purgeIds.includes(entry.id)) ?? [];
    try {
      const result = await actions.purgeTrash(purgeIds);
      onResult(result, 'Permanent deletion result');
      const done = completedEntries(result, targets);
      setEntries((current) => current?.filter((entry) => !done.has(entry.id)) ?? current);
      setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
      setPurgeIds(null);
      setEntries(await actions.listTrash());
    } catch (cause) {
      const text = errorMessage(cause);
      setError(text);
    } finally {
      setPurging(false);
    }
  }
  const confirmTargets = items.filter((entry) => purgeIds?.includes(entry.id));
  const blocked = busy || purging;
  return (
    <DialogFrame
      title="Trash"
      className="explorer-dialog explorer-trash-dialog"
      pending={blocked}
      cancel={close}
    >
      <p className="explorer-dialog-summary">
        Restore deleted items, or permanently remove them when you are ready.
      </p>
      {error ? (
        <div className="explorer-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <TrashStatus entries={entries} error={error} />
      {items.length ? (
        <div className="explorer-list-toolbar">
          <span>{ids.length ? `${ids.length} selected` : `${items.length} items`}</span>
          <button
            type="button"
            className="quiet danger"
            disabled={blocked || !!purgeIds}
            onClick={() => setPurgeIds(items.map((entry) => entry.id))}
          >
            Empty Trash…
          </button>
        </div>
      ) : null}
      {items.length ? (
        <ul className="explorer-trash-list">
          {items.map((entry) => (
            <li key={entry.id} data-selected={selected.has(entry.id)}>
              <div className="explorer-trash-item">
                <input
                  type="checkbox"
                  id={`trash-${entry.id}`}
                  disabled={busy || purging || !!purgeIds}
                  aria-label={`Select ${entry.path}`}
                  checked={selected.has(entry.id)}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) {
                        next.add(entry.id);
                      } else {
                        next.delete(entry.id);
                      }
                      return next;
                    })
                  }
                />
                <div className="explorer-item-copy">
                  <label className="explorer-item-title" htmlFor={`trash-${entry.id}`}>
                    {entry.path}
                  </label>
                  <small>
                    {new Date(
                      entry.deletedAt < 1_000_000_000_000
                        ? entry.deletedAt * 1000
                        : entry.deletedAt,
                    ).toLocaleString()}{' '}
                    · {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'} ·{' '}
                    {entry.bytes.toLocaleString()} bytes
                  </small>
                  {restoreErrors[entry.id] ? (
                    <span className="explorer-error" role="alert">
                      {restoreErrors[entry.id]}
                    </span>
                  ) : null}
                  {entry.kind === 'purging' ? (
                    <span className="explorer-warning">
                      Deletion was interrupted. These are the remaining files; restoration is no
                      longer safe. Confirm permanent deletion again to finish.
                    </span>
                  ) : null}
                  {restoreErrors[entry.id] ? (
                    <>
                      <input
                        aria-label={`Restore destination for ${entry.path}`}
                        value={restoreDestination[entry.id] ?? ''}
                        placeholder="Vault root or folder"
                        onChange={(event) =>
                          setRestoreDestination((current) => ({
                            ...current,
                            [entry.id]: event.target.value.replace(/^\/+|\/+$/g, ''),
                          }))
                        }
                      />
                      <div className="explorer-destination-list">
                        <button
                          type="button"
                          aria-pressed={restoreDestination[entry.id] === ''}
                          onClick={() =>
                            setRestoreDestination((current) => ({ ...current, [entry.id]: '' }))
                          }
                        >
                          <WorkspaceIcon name="folder" />
                          <span>Vault root</span>
                        </button>
                        {directories.filter(Boolean).map((directory) => (
                          <button
                            type="button"
                            key={directory}
                            aria-pressed={restoreDestination[entry.id] === directory}
                            onClick={() =>
                              setRestoreDestination((current) => ({
                                ...current,
                                [entry.id]: directory,
                              }))
                            }
                          >
                            <WorkspaceIcon name="folder" />
                            <span>{directory}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                disabled={busy || purging || !!purgeIds || entry.kind === 'purging'}
                onClick={() => void restore(entry)}
              >
                <WorkspaceIcon name="restore" />
                Restore
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {purgeIds ? (
        <section className="explorer-purge-confirmation" role="alert">
          <strong>Permanently delete these items?</strong>
          <p>This cannot be undone. Only the items listed below will be removed.</p>
          <ul>
            {confirmTargets.map((entry) => (
              <li key={entry.id}>
                {entry.path} · {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'} ·{' '}
                {entry.bytes.toLocaleString()} bytes
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button type="button" disabled={purging} onClick={() => setPurgeIds(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={purging}
              onClick={() => void purge()}
            >
              {purging ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </section>
      ) : null}
      <div className="dialog-actions">
        <button type="button" disabled={blocked} onClick={close}>
          Close
        </button>
        {ids.length && !purgeIds ? (
          <button
            type="button"
            className="danger"
            disabled={blocked}
            onClick={() => setPurgeIds(ids)}
          >
            Delete selected…
          </button>
        ) : null}
      </div>
    </DialogFrame>
  );
}

function MutationDialogs({
  plan,
  destination,
  actions,
  commitPending,
  cancelPlan,
  commitPlan,
  closeDestination,
  chooseDestination,
  directories,
}: {
  plan: PlanState | null;
  destination: DestinationState | null;
  actions: FileActions;
  commitPending: boolean;
  cancelPlan: () => void;
  commitPlan: () => void;
  closeDestination: () => void;
  chooseDestination: (directory: string) => void;
  directories: string[];
}) {
  return (
    <>
      {plan ? (
        <PlanDialog
          state={plan}
          busy={actions.busy || commitPending}
          cancel={cancelPlan}
          commit={commitPlan}
        />
      ) : null}
      {destination ? (
        <DestinationDialog
          directories={directories}
          initial={destination.initial}
          title={destination.kind === 'move' ? 'Move selected items' : 'Duplicate selected items'}
          busy={actions.busy}
          close={closeDestination}
          choose={chooseDestination}
        />
      ) : null}
    </>
  );
}
function VaultFiles({
  workspace,
  navigation,
  documentInfo,
  detailsRef,
  fileActions,
}: DocumentProps & { detailsRef: RefObject<HTMLDetailsElement | null>; fileActions: FileActions }) {
  const { vault, pages, buffer, dirty, busy } = workspace;
  const { setSection, setSidebarOpen } = navigation;
  const disabled = !native || !!busy || fileActions.busy;
  const { selectedPaths, setSelectedPaths, filter, setFilter } = useExplorerReveal(
    workspace,
    documentInfo.activeVaultPath,
    fileActions,
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [createKind, setCreateKind] = useState<'note' | 'folder' | null>(null);
  const [createDirectory, setCreateDirectory] = useState('');
  const dirtyPath = dirty && buffer.source?.kind === 'vault' ? buffer.source.note.path : null;
  const [createName, setCreateName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ mode: 'cut' | 'copy'; paths: string[] } | null>(
    null,
  );
  const [sort, setSort] = useState<'name' | 'type' | 'modified'>('name');
  const setDirectoryOptions = workspace.setDirectoryOptions;
  const [destination, setDestination] = useState<DestinationState | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const reportResult = useCallback((next: MutationResult, title: string) => {
    const needsReview =
      !!next.recoveryId || next.outcomes.some((item) => item.status !== 'completed');
    setResult(needsReview ? { title, result: next } : null);
  }, []);
  const [trashOpen, setTrashOpen] = useState(false);
  const commitRetried = useRef(false);
  const commitInFlight = useRef(false);
  const [commitPending, setCommitPending] = useState(false);
  const fileActionsRef = useRef(fileActions);
  useLayoutEffect(() => {
    fileActionsRef.current = fileActions;
  }, [fileActions]);
  const refreshPages = workspace.refreshPages;
  const revealPath = workspace.revealPath;
  const toggleDirectory = (directory: string, open: boolean) => {
    workspace.toggleDirectory(directory, open);
    workspace.finder.setState((current) => {
      if (open && current.expanded.includes(directory)) {
        return current;
      }
      return {
        ...current,
        expanded: open
          ? [...current.expanded, directory]
          : current.expanded.filter(
              (path) => path !== directory && !path.startsWith(`${directory}/`),
            ),
      };
    });
  };
  const selected = [...selectedPaths];
  const allEntries = [...pages.values()].flatMap((page) => page.entries);
  const selectedEntry = allEntries.find((entry) => entry.path === selected[0]);
  const directoryFor = (entry?: VaultEntry) => {
    const target = entry ?? selectedEntry;
    if (target?.kind === 'directory') {
      return target.path;
    }
    return target?.path.split('/').slice(0, -1).join('/') ?? '';
  };
  const currentDirectory = directoryFor();
  const copyLink = workspace.copyLink;
  const toggleFavorite = workspace.toggleFavorite;
  useEffect(() => {
    type DropDetail = { requestId: string; selections: ImportSelection[]; x: number; y: number };
    const targets = new Map<string, string | null>();
    let highlight: HTMLElement | null = null;
    function clearHighlight() {
      if (highlight) {
        delete highlight.dataset.nativeDrop;
      }
      highlight = null;
    }
    function targetAt(detail: Pick<DropDetail, 'x' | 'y'>) {
      if (!Number.isFinite(detail.x) || !Number.isFinite(detail.y)) {
        return null;
      }
      const element = document.elementFromPoint(detail.x, detail.y);
      if (!element?.closest('#explorer')) {
        return null;
      }
      const row = element.closest<HTMLElement>('[data-path]');
      const list = element.closest<HTMLElement>('[data-drop-directory]');
      if (!row && !list) {
        return null;
      }
      const directory =
        row?.dataset.directory ??
        row?.dataset.path?.split('/').slice(0, -1).join('/') ??
        list?.dataset.dropDirectory ??
        '';
      return {
        directory,
        element: row ?? list,
      };
    }
    const hover = (event: Event) => {
      clearHighlight();
      const detail = (event as CustomEvent<DropDetail | null>).detail;
      const target = detail ? targetAt(detail) : null;
      if (!target?.element) {
        return;
      }
      highlight = target.element;
      highlight.dataset.nativeDrop = fileActionsRef.current.busy ? 'invalid' : 'valid';
    };
    const start = (event: Event) => {
      const detail = (event as CustomEvent<DropDetail>).detail;
      if (targets.size >= 16) {
        targets.clear();
      }
      targets.set(
        detail.requestId,
        fileActionsRef.current.busy ? null : (targetAt(detail)?.directory ?? null),
      );
      clearHighlight();
    };
    const handleDrop = (event: Event) => {
      const detail = (event as CustomEvent<DropDetail>).detail;
      const directory = targets.get(detail.requestId);
      targets.delete(detail.requestId);
      if (directory === null || directory === undefined) {
        fileActionsRef.current.reportError(
          new Error(
            'Drop files onto a folder or Vault root in the explorer while no operation is pending. No files were imported.',
          ),
        );
        return;
      }
      const tokens = detail.selections.map((selection) => selection.token);
      if (!tokens.length) {
        return;
      }
      void fileActionsRef.current
        .importFiles(tokens, directory)
        .then((imported) => reportResult(imported, 'Import result'))
        .catch((cause) => fileActionsRef.current.reportError(cause));
    };
    const handleError = (event: Event) => {
      clearHighlight();
      fileActionsRef.current.reportError(
        (event as CustomEvent<unknown>).detail ?? new Error('Native file import failed.'),
      );
    };
    const listeners = [
      ['vault-import-start', start],
      ['vault-import-hover', hover],
      ['vault-import-dropped', handleDrop],
      ['vault-import-error', handleError],
    ] as const;
    for (const [name, listener] of listeners) {
      window.addEventListener(name, listener);
    }
    return () => {
      clearHighlight();
      for (const [name, listener] of listeners) {
        window.removeEventListener(name, listener);
      }
    };
  }, [reportResult]);
  const directories = useMemo(() => {
    const known = new Set(pages.keys());
    for (const page of pages.values()) {
      for (const entry of page.entries) {
        if (entry.kind === 'directory') {
          known.add(entry.path);
        }
      }
    }
    return [...known].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [pages]);
  function pathsFor(entry?: VaultEntry) {
    if (entry && !selectedPaths.has(entry.path)) {
      return [entry.path];
    }
    if (selected.length) {
      return selected;
    }
    return entry ? [entry.path] : [];
  }
  function openMenu(
    position: { x: number; y: number },
    entry: VaultEntry | undefined,
    trigger: HTMLElement,
    directory: string,
  ) {
    const paths = entry ? pathsFor(entry) : [];
    setSelectedPaths(new Set(paths));
    setMenu({ ...position, entry, paths, directory, trigger });
  }
  function showMenu(event: MouseEvent, entry?: VaultEntry) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : trigger;
    const directory = entry
      ? directoryFor(entry)
      : (target.closest<HTMLElement>('[data-drop-directory]')?.dataset.dropDirectory ?? '');
    openMenu({ x: event.clientX, y: event.clientY }, entry, trigger, directory);
  }
  function keyboardMenu(entry: VaultEntry | undefined, target: HTMLElement) {
    const box = target.getBoundingClientRect();
    openMenu(
      { x: box.left, y: box.bottom + 2 },
      entry,
      target,
      entry ? directoryFor(entry) : (target.dataset.dropDirectory ?? ''),
    );
  }
  const beginMutation = useCallback(
    (kind: MutationKind, paths: string[], destinationPath: string | null) => {
      if (!paths.length) {
        return;
      }
      commitRetried.current = false;
      const request = { kind, paths, destination: destinationPath };
      void fileActions
        .prepare(request)
        .then((prepared) => setPlan({ request, plan: prepared }))
        .catch(fileActions.reportError);
    },
    [fileActions],
  );
  async function retryPlan(state: PlanState, cause: unknown) {
    if (commitRetried.current || !/revision|stale|changed|conflict/i.test(errorMessage(cause))) {
      fileActions.reportError(cause);
      return;
    }
    commitRetried.current = true;
    try {
      await fileActions.cancel(state.plan.id);
      const prepared = await fileActions.prepare(state.request);
      setPlan({ request: state.request, plan: prepared });
    } catch (error) {
      fileActions.reportError(error);
    }
  }
  async function commitPlan() {
    if (!plan || commitInFlight.current) {
      return;
    }
    commitInFlight.current = true;
    setCommitPending(true);
    let state = plan;
    try {
      const guarded = await fileActions.guardPaths(
        [...new Set([...state.request.paths, ...state.plan.affectedPaths])],
        'This operation changes these open documents',
      );
      if (!guarded) {
        await fileActions.cancel(state.plan.id);
        setPlan(null);
        return;
      }
      await fileActions.cancel(state.plan.id);
      const prepared = await fileActions.prepare(state.request);
      const approvalChanged = planApproval(state.plan) !== planApproval(prepared);
      state = { request: state.request, plan: prepared, refreshed: approvalChanged };
      setPlan(state);
      if (approvalChanged) {
        return;
      }
      const applied = await fileActions.commit(prepared.id);
      if (clipboard?.mode === 'cut' && state.request.kind === 'move') {
        const completed = applied.outcomes.filter((item) => item.status === 'completed');
        const remaining = clipboard.paths.filter(
          (path) =>
            !completed.some((item) => path === item.path || path.startsWith(`${item.path}/`)),
        );
        setClipboard(remaining.length ? { ...clipboard, paths: remaining } : null);
      }
      setSelectedPaths((current) => mutationSelection(current, state.request.kind, applied));
      setPlan(null);
      reportResult(
        applied,
        `${state.request.kind[0].toUpperCase()}${state.request.kind.slice(1)} result`,
      );
    } catch (error) {
      await retryPlan(state, error);
    } finally {
      commitInFlight.current = false;
      setCommitPending(false);
    }
  }
  async function create(kind: 'note' | 'folder') {
    const name = createName.trim();
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      fileActions.reportError(
        new Error('Enter a file or folder name without slashes; "." and ".." are not names.'),
      );
      return;
    }
    const path = `${createDirectory ? `${createDirectory}/` : ''}${name}`;
    try {
      if (kind === 'folder') {
        await fileActions.createFolder(path);
        refreshPages();
      } else {
        await fileActions.createNote(path.endsWith('.md') ? path : `${path}.md`);
      }
      setCreateKind(null);
      setCreateName('');
    } catch (error) {
      fileActions.reportError(error);
    }
  }
  async function rename(entry: VaultEntry, name: string) {
    const trimmed = name.trim();
    if (!trimmed || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
      fileActions.reportError(
        new Error('Enter a name without slashes; "." and ".." are not names.'),
      );
      return;
    }
    const oldName = entry.path.split('/').at(-1) ?? entry.path;
    const oldExtension = entry.kind === 'directory' ? undefined : oldName.match(/(\.[^.]+)$/)?.[1];
    const finalName =
      oldExtension && !trimmed.toLocaleLowerCase().endsWith(oldExtension.toLocaleLowerCase())
        ? `${trimmed}${oldExtension}`
        : trimmed;
    const parent = entry.path.slice(0, entry.path.length - oldName.length);
    setRenamingPath(null);
    beginMutation('rename', [entry.path], `${parent}${finalName}`);
  }
  async function importFromPicker(directory = currentDirectory) {
    const actions = fileActionsRef.current;
    try {
      const picked = await actions.selectImports();
      if (!picked.length) {
        return;
      }
      const imported = await actions.importFiles(
        picked.map((item) => item.token),
        directory,
      );
      reportResult(imported, 'Import result');
    } catch (error) {
      actions.reportError(error);
    }
  }
  function drop(event: DragEvent, directory: string, sourcePaths: string[] | null) {
    event.preventDefault();
    if (sourcePaths?.length) {
      if (
        sourcePaths.some((source) => directory === source || directory.startsWith(`${source}/`))
      ) {
        fileActions.reportError(
          new Error('A folder cannot be moved into itself or one of its descendants.'),
        );
        return;
      }
      beginMutation('move', sourcePaths, directory);
      return;
    }
    if (!native) {
      fileActions.reportError(new Error('External file import requires the desktop application.'));
    }
    // Native drop events bind file capabilities to the target captured at drop time.
  }
  const registerExplorerActions = workspace.registerExplorerActions;
  const noActions = unavailableActions(workspace, fileActions);
  const actionEntry = menu ? menu.entry : selectedEntry;
  const actionPaths = menu ? menu.paths : selected;
  const actionDirectory = menu ? menu.directory : currentDirectory;
  const favorite = actionEntry
    ? workspace.finder.state.favorites.includes(actionEntry.path)
    : false;
  function buildExplorerActions(): UserAction[] {
    return [
      {
        id: 'explorer.new-note',
        label: 'New Note',
        icon: 'new',
        group: 'Create',
        run: () => {
          setCreateKind('note');
          setCreateName('');
          setCreateDirectory(actionDirectory);
        },
        disabled: noActions,
      },
      {
        id: 'explorer.new-folder',
        label: 'New folder',
        icon: 'folder',
        group: 'Create',
        run: () => {
          setCreateKind('folder');
          setCreateName('');
          setCreateDirectory(actionDirectory);
        },
        disabled: noActions,
      },
      {
        id: 'explorer.import',
        label: 'Import files…',
        icon: 'import',
        group: 'Create',
        run: () => importFromPicker(actionDirectory),
        disabled: noActions,
      },
      {
        id: 'explorer.paste',
        label: 'Paste here',
        icon: 'paste',
        group: 'Create',
        shortcut: 'Ctrl+V',
        run: () => {
          if (clipboard) {
            beginMutation(
              clipboard.mode === 'cut' ? 'move' : 'duplicate',
              clipboard.paths,
              actionDirectory,
            );
          }
        },
        disabled: !clipboard ? 'Nothing has been cut or copied' : noActions,
      },
      {
        id: 'explorer.open',
        label: 'Open',
        icon: 'document',
        group: 'File',
        run: () => {
          if (actionEntry && actionEntry.kind !== 'directory') {
            setSection('workbench');
            workspace.openEntry(actionEntry);
          }
        },
        disabled:
          !actionEntry || actionEntry.kind === 'directory' ? 'Select a document' : noActions,
      },
      {
        id: 'explorer.rename',
        label: 'Rename…',
        icon: 'edit',
        group: 'File',
        shortcut: 'F2',
        run: () => {
          if (actionEntry) {
            setRenamingPath(actionEntry.path);
          }
        },
        disabled: !actionEntry ? 'Select an item' : noActions,
      },
      {
        id: 'explorer.cut',
        label: 'Cut',
        icon: 'cut',
        group: 'Organize',
        shortcut: 'Ctrl+X',
        run: () => setClipboard({ mode: 'cut', paths: actionPaths }),
        disabled: !actionPaths.length ? 'Select one or more items' : noActions,
      },
      {
        id: 'explorer.copy',
        label: 'Copy',
        icon: 'copy',
        group: 'Organize',
        shortcut: 'Ctrl+C',
        run: () => setClipboard({ mode: 'copy', paths: actionPaths }),
        disabled: !actionPaths.length ? 'Select one or more items' : noActions,
      },
      {
        id: 'explorer.move',
        label: 'Move to…',
        icon: 'move',
        group: 'Organize',
        run: () => setDestination({ kind: 'move', paths: actionPaths, initial: actionDirectory }),
        disabled: !actionPaths.length ? 'Select one or more items' : noActions,
      },
      {
        id: 'explorer.duplicate',
        label: 'Duplicate…',
        icon: 'duplicate',
        group: 'Organize',
        run: () =>
          setDestination({ kind: 'duplicate', paths: actionPaths, initial: actionDirectory }),
        disabled: !actionPaths.length ? 'Select one or more items' : noActions,
      },
      {
        id: 'explorer.copy-link',
        label: 'Copy link',
        icon: 'copy',
        group: 'Links',
        run: async () => {
          if (actionEntry) {
            await copyLink(actionEntry.path);
          }
        },
        disabled:
          !actionEntry || actionEntry.kind !== 'markdown' ? 'Select a Markdown Note' : noActions,
      },
      {
        id: 'explorer.favorite',
        label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
        icon: 'star',
        group: 'Links',
        run: () => {
          if (actionEntry) {
            toggleFavorite(actionEntry.path);
          }
        },
        disabled: !actionEntry ? 'Select an item' : noActions,
      },
      {
        id: 'explorer.reveal',
        label: 'Reveal active document',
        icon: 'folder',
        group: 'Navigation',
        run: async () => {
          if (documentInfo.activeVaultPath) {
            await revealPath(documentInfo.activeVaultPath);
          }
        },
        disabled: !documentInfo.activeVaultPath ? 'No Vault document is active' : noActions,
      },
      {
        id: 'explorer.trash',
        label: 'Move to Trash',
        icon: 'trash',
        tone: 'danger',
        group: 'Trash',
        shortcut: 'Delete',
        run: () => beginMutation('trash', actionPaths, null),
        disabled: !actionPaths.length ? 'Select one or more items' : noActions,
      },
      {
        id: 'explorer.trash.manage',
        label: 'Manage Trash…',
        icon: 'trash',
        group: 'Trash',
        run: () => setTrashOpen(true),
        disabled: noActions,
      },
    ];
  }
  const explorerActions = buildExplorerActions();
  useLayoutEffect(() => {
    registerExplorerActions(explorerActions);
  });
  function runShortcut(key: 'copy' | 'cut' | 'paste' | 'delete') {
    const id = key === 'delete' ? 'explorer.trash' : `explorer.${key}`;
    const action = explorerActions.find((candidate) => candidate.id === id);
    if (action && !action.disabled) {
      void action.run();
    }
  }
  if (!vault) {
    return (
      <div className="explorer-empty">
        <p>Open a document, or organize Notes in a Vault.</p>
        <div className="explorer-start-actions">
          <button type="button" disabled={disabled} onClick={workspace.openDocument}>
            Open document…
          </button>
          <button type="button" disabled={disabled} onClick={() => workspace.chooseVault('open')}>
            Open Vault…
          </button>
          <button
            type="button"
            className="explorer-create-vault"
            disabled={disabled}
            onClick={() => workspace.chooseVault('create')}
          >
            Create Vault…
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="vault-files">
      <div className="explorer-heading vault-heading">
        <h2 title={vault.root}>{vault.name}</h2>
        <div className="explorer-tools">
          <button
            className="icon-button"
            type="button"
            title="New Note"
            aria-label="New Note"
            disabled={disabled}
            onClick={() => {
              setCreateKind('note');
              setCreateName('');
              setCreateDirectory(currentDirectory);
            }}
          >
            <WorkspaceIcon name="new" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Import files"
            aria-label="Import files"
            disabled={disabled}
            onClick={() => void importFromPicker()}
          >
            <WorkspaceIcon name="import" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="File actions"
            aria-label="File actions"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(event) => {
              const target = event.currentTarget;
              const box = target.getBoundingClientRect();
              openMenu({ x: box.left, y: box.bottom + 2 }, selectedEntry, target, currentDirectory);
            }}
          >
            <WorkspaceIcon name="more" />
          </button>
        </div>
      </div>
      {createKind ? (
        <CreateEntry
          kind={createKind}
          value={createName}
          disabled={disabled}
          directory={createDirectory}
          onChange={setCreateName}
          cancel={() => {
            setCreateKind(null);
            setCreateName('');
          }}
          create={() => void create(createKind)}
        />
      ) : null}
      <IndexDetails workspace={workspace} detailsRef={detailsRef} />
      <div className="explorer-controls">
        <label className="explorer-filter" htmlFor="explorer-filter">
          <WorkspaceIcon name="search" />
          <span className="visually-hidden">Filter files</span>
          <input
            id="explorer-filter"
            value={filter}
            placeholder="Find files…"
            onChange={(event) => {
              const value = event.target.value;
              setFilter(value);
              setDirectoryOptions({ sort, filter: value });
            }}
          />
        </label>
        <ExplorerSort
          value={sort}
          onChange={(value) => {
            setSort(value);
            setDirectoryOptions({ sort: value, filter });
          }}
        />
      </div>
      <VaultExplorer
        pages={pages}
        indexing={vault.indexing}
        activePath={documentInfo.activeVaultPath}
        dirtyPath={dirtyPath}
        disabled={disabled}
        selectedPaths={selectedPaths}
        onSelectionChange={setSelectedPaths}
        onContextMenu={showMenu}
        onKeyboardContextMenu={keyboardMenu}
        onKeyCommand={runShortcut}
        renamePath={renamingPath}
        onRename={(entry) => setRenamingPath(entry.path)}
        onRenameCommit={(entry, name) => void rename(entry, name)}
        onRenameCancel={() => setRenamingPath(null)}
        onDrop={drop}
        onToggleDirectory={toggleDirectory}
        onLoadMore={workspace.loadMore}
        onOpen={(entry) => {
          setSection('workbench');
          workspace.openEntry(entry);
          if (window.innerWidth <= 760) {
            setSidebarOpen(false);
          }
        }}
      />
      <ExplorerMenu
        actions={explorerActions}
        menu={menu}
        vaultName={vault.name}
        onClose={() => setMenu(null)}
      />
      <VaultIssues vault={vault} />
      <MutationDialogs
        plan={plan}
        destination={destination}
        actions={fileActions}
        commitPending={commitPending}
        directories={directories}
        cancelPlan={() => {
          if (!plan || fileActions.busy || commitInFlight.current) {
            return;
          }
          void fileActions.cancel(plan.plan.id).catch(fileActions.reportError);
          setPlan(null);
        }}
        commitPlan={() => void commitPlan()}
        closeDestination={() => setDestination(null)}
        chooseDestination={(path) => {
          if (!destination) {
            return;
          }
          setDestination(null);
          beginMutation(destination.kind, destination.paths, path);
        }}
      />
      {result
        ? createPortal(
            <ResultDialog result={result} close={() => setResult(null)} />,
            document.body,
          )
        : null}
      {trashOpen
        ? createPortal(
            <TrashDialog
              actions={fileActions}
              directories={directories}
              busy={fileActions.busy}
              close={() => setTrashOpen(false)}
              onResult={reportResult}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function StandaloneFiles({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, selected, dirty } = workspace;
  const { section, setSection, setView, showBuffer } = navigation;
  const { readingDocument, bufferName, bufferPath } = documentInfo;
  const standaloneOriginal = selected && !selected.vaultPath ? selected : null;
  const hasStandaloneFile = buffer.source?.kind === 'standalone' && !!buffer.source.path;
  if (!hasStandaloneFile && !standaloneOriginal) {
    return null;
  }
  return (
    <>
      {hasStandaloneFile ? (
        <button
          className="explorer-file"
          type="button"
          aria-pressed={section === 'workbench' && !readingDocument}
          title={bufferPath ?? 'Unsaved Markdown buffer'}
          onClick={showBuffer}
        >
          <WorkspaceIcon name="document" />
          <span>{bufferName}</span>
          {dirty ? <span className="buffer-dot" aria-label="Unsaved changes" /> : null}
        </button>
      ) : null}
      {standaloneOriginal ? (
        <button
          className="explorer-file"
          type="button"
          aria-pressed={section === 'workbench' && !!readingDocument}
          title={standaloneOriginal.path}
          onClick={() => {
            workspace.setShowOriginal(true);
            setView('read');
            setSection('workbench');
          }}
        >
          <WorkspaceIcon name="document" />
          <span>{standaloneOriginal.name}</span>
          <small>{standaloneOriginal.kind.toUpperCase()}</small>
        </button>
      ) : null}
    </>
  );
}

export default function ExplorerSidebar({
  workspace,
  navigation,
  documentInfo,
  detailsRef,
  fileActions,
}: DocumentProps & { detailsRef: RefObject<HTMLDetailsElement | null>; fileActions: FileActions }) {
  return (
    <aside
      className="sidebar"
      id="explorer"
      hidden={!navigation.sidebarOpen}
      inert={!navigation.sidebarOpen}
      aria-label="Document explorer"
    >
      <div className="explorer-section">
        <VaultFiles
          key={workspace.vault?.id ?? 'no-vault'}
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
          detailsRef={detailsRef}
          fileActions={fileActions}
        />
        <StandaloneFiles
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
        />
      </div>
      <Atmosphere />
    </aside>
  );
}
