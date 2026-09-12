import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import { kindLabels, priorities } from './state';
import type { SourceStatus } from './useWorkContext';
import type { WorkSpace, WorkState, WorkView } from './types';
import type { BoardDialog, BoardWork } from './BoardModel';

function sourceRefreshLabel(status: SourceStatus | undefined): string {
  if (status?.loading) {
    return 'Refreshing…';
  }
  if (status?.fetchedAt) {
    return `Last refreshed ${new Date(status.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return 'Not refreshed this session';
}

export function BoardHeader({
  vaultName,
  work,
  online,
  notice,
  onDismiss,
  showDialog,
}: {
  vaultName: string;
  work: BoardWork;
  online: boolean;
  notice: string | null;
  onDismiss: () => void;
  showDialog: (dialog: BoardDialog) => void;
}) {
  const state = work.state;
  let saveStatus = '';
  if (state) {
    saveStatus = 'Saved in Vault';
  }
  if (work.dirty) {
    saveStatus = 'Unsaved changes';
  }
  if (work.status === 'saving') {
    saveStatus = 'Saving to Vault…';
  }
  return (
    <>
      <header className="work-heading">
        <div>
          <h1>Work context</h1>
          <p>
            {vaultName} <span className="work-heading-separator">/</span> Project spaces
          </p>
        </div>
        <div className="work-save-status" role="status">
          {saveStatus}
          {work.status === 'saving' || work.status === 'loading' ? (
            <LoadingIndicator
              label={work.status === 'saving' ? 'Saving workspace' : 'Loading workspace'}
            />
          ) : null}
        </div>
      </header>
      {work.saveError ? (
        <div className="work-message error" role="alert">
          <div>
            <strong>
              {work.dirty ? 'Your changes have not been saved.' : 'Could not load this workspace.'}
            </strong>
            <p>{work.saveError}</p>
            {work.dirty ? (
              <p>
                Keep this window open. Your edits are retained in memory, including when switching
                spaces or Vaults.
              </p>
            ) : null}
          </div>
          <div className="work-message-actions">
            <button onClick={work.retry}>Retry</button>
            {state ? (
              <button onClick={() => showDialog({ kind: 'conflict' })}>Review saved version</button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!online ? (
        <div className="work-message" role="status">
          Offline. Local work still saves to the Vault. Remote cards show the last available
          information; nothing is queued to send.
        </div>
      ) : null}
      {notice ? (
        <div className="work-message" role="alert">
          <span>{notice}</span>
          <button className="icon-button" aria-label="Dismiss message" onClick={onDismiss}>
            <WorkspaceIcon name="close" />
          </button>
        </div>
      ) : null}
    </>
  );
}

export function BoardSpaceBar({
  state,
  space,
  busy,
  onSelect,
  showDialog,
}: {
  state: WorkState;
  space: WorkSpace | null;
  busy: boolean;
  onSelect: (id: string) => void;
  showDialog: (dialog: BoardDialog) => void;
}) {
  return (
    <div className="work-space-bar">
      <label className="work-space-picker">
        Space
        <select
          aria-label="Current project space"
          disabled={busy}
          value={space?.id ?? ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="" disabled>
            Select a space
          </option>
          {state.spaces.map((entry) => (
            <option value={entry.id} key={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={() => showDialog({ kind: 'space' })}
        disabled={busy || state.spaces.length >= 128}
      >
        New space
      </button>
      {space ? (
        <button disabled={busy} onClick={() => showDialog({ kind: 'space', rename: true })}>
          Rename
        </button>
      ) : null}
      {busy ? (
        <span className="work-warning" role="status">
          Remote action in progress. Keep this item open until the result arrives.
        </span>
      ) : null}
    </div>
  );
}

export function BoardToolbar({
  space,
  work,
  changeView,
  showDialog,
}: {
  space: WorkSpace;
  work: BoardWork;
  changeView: (view: Partial<WorkView>) => void;
  showDialog: (dialog: BoardDialog) => void;
}) {
  return (
    <div className="work-toolbar">
      <div className="work-view-switch" role="group" aria-label="View">
        <button
          aria-pressed={space.view.mode === 'board'}
          onClick={() => changeView({ mode: 'board' })}
        >
          Board
        </button>
        <button
          aria-pressed={space.view.mode === 'list'}
          onClick={() => changeView({ mode: 'list' })}
        >
          List
        </button>
      </div>
      <button onClick={() => showDialog({ kind: 'columns' })}>Columns</button>
      <div className="work-toolbar-actions">
        <button onClick={() => showDialog({ kind: 'existing' })}>Add existing</button>
        <button onClick={() => showDialog({ kind: 'follow' })} disabled={!work.connections.length}>
          Follow URL
        </button>
        <button className="primary" onClick={() => showDialog({ kind: 'task' })}>
          New task
        </button>
      </div>
    </div>
  );
}

export function BoardFilters({
  space,
  changeView,
}: {
  space: WorkSpace;
  changeView: (view: Partial<WorkView>) => void;
}) {
  const anyFilter = space.view.query || space.view.kind !== 'all' || space.view.priority !== 'all';
  return (
    <div className="work-filters">
      <label className="work-query">
        <span className="visually-hidden">Filter work items</span>
        <input
          type="search"
          placeholder="Filter by title, key, assignee or label…"
          value={space.view.query}
          onChange={(event) => changeView({ query: event.target.value })}
          maxLength={4096}
        />
      </label>
      <label>
        Type
        <select
          value={space.view.kind}
          onChange={(event) => changeView({ kind: event.target.value as WorkView['kind'] })}
        >
          <option value="all">All types</option>
          {Object.entries(kindLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select
          value={space.view.priority}
          onChange={(event) => changeView({ priority: event.target.value as WorkView['priority'] })}
        >
          <option value="all">All priorities</option>
          {priorities.map((priority) => (
            <option key={priority} value={priority}>
              {priority === 'none' ? 'No priority' : priority[0].toUpperCase() + priority.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sort
        <select
          value={space.view.sort}
          onChange={(event) => changeView({ sort: event.target.value as WorkView['sort'] })}
        >
          <option value="manual">Manual order</option>
          <option value="updated">Recently updated</option>
          <option value="priority">Highest priority</option>
          <option value="due">Due date</option>
        </select>
      </label>
      {anyFilter ? (
        <button onClick={() => changeView({ query: '', kind: 'all', priority: 'all' })}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

export function BoardSources({
  space,
  work,
  showDialog,
  onConnections,
}: {
  space: WorkSpace;
  work: BoardWork;
  showDialog: (dialog: BoardDialog) => void;
  onConnections: () => void;
}) {
  return (
    <details className="work-sources">
      <summary>
        Sources <span>{space.sources.length}</span>
        <span className="work-source-summary">
          {space.sources.some(
            (source) =>
              work.sourceStatuses[JSON.stringify([work.vaultKey, space.id, source])]?.loading,
          )
            ? 'Refreshing…'
            : 'Refresh every 5 minutes while visible'}
        </span>
      </summary>
      <div className="work-sources-body">
        {work.connectionError ? (
          <p className="work-error" role="alert">
            Connections unavailable: {work.connectionError}{' '}
            <button onClick={() => void work.reloadConnections()}>Retry connections</button>
          </p>
        ) : null}
        {!space.sources.length ? (
          <p>
            Follow a repository or Jira project to bring matching work into this space. Local tasks
            need no connection.
          </p>
        ) : (
          <ul>
            {space.sources.map((source) => {
              const status = work.sourceStatuses[JSON.stringify([work.vaultKey, space.id, source])];
              const connected = work.connections.some(
                (connection) => connection.id === source.connectionId,
              );
              return (
                <li key={source.id}>
                  <div className="work-source-info">
                    <strong>{source.scope}</strong>
                    <span>
                      {source.provider === 'github' ? 'GitHub' : 'Jira'} / {source.host}
                    </span>
                    {source.filter ? <code>{source.filter}</code> : null}
                    <span>{sourceRefreshLabel(status)}</span>
                    {!connected ? (
                      <span className="work-warning">
                        Connection unavailable. Cached cards remain available.
                      </span>
                    ) : null}
                    {status?.error ? (
                      <span className="work-error" role="alert">
                        Refresh failed: {status.error}. Existing cards are retained.
                      </span>
                    ) : null}
                    {status?.warning ? (
                      <span className="work-warning">{status.warning}</span>
                    ) : null}
                  </div>
                  <div className="work-source-actions">
                    <button onClick={() => showDialog({ kind: 'source', source })}>Edit</button>
                    <button
                      disabled={status?.loading || !connected}
                      onClick={() => void work.refreshSource(source)}
                    >
                      Refresh
                    </button>
                    {status?.cursor ? (
                      <button
                        disabled={status.loading || !connected}
                        onClick={() => void work.refreshSource(source, true)}
                      >
                        Load more
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="work-source-actions">
          <button
            onClick={() => showDialog({ kind: 'source' })}
            disabled={space.sources.length >= 256}
          >
            Add source
          </button>
          <button onClick={onConnections}>Manage connections</button>
          <button onClick={() => void work.reloadConnections()}>Refresh accounts</button>
        </div>
      </div>
    </details>
  );
}
