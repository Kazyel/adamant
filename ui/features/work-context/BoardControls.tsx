import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import DialogFrame from '../workspace/DialogFrame';
import { OverlayPresence, useOverlayPresence } from '../interaction/OverlayPresence';
import { kindLabels, priorities } from './state';
import type { SourceStatus } from './useWorkContext';
import type { WorkSpace, WorkState, WorkView } from './types';
import type { BoardDialog, BoardWork } from './BoardModel';

export type BoardTab = 'board' | 'list' | 'sources';

function moveTabFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    return;
  }
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) {
    return;
  }
  event.preventDefault();
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  tabs[(current + direction + tabs.length) % tabs.length]?.focus();
}

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
  space,
  work,
  online,
  notice,
  onDismiss,
  showDialog,
  openGuide,
  openWorkspace,
}: {
  vaultName: string;
  space: WorkSpace | null;
  work: BoardWork;
  online: boolean;
  notice: string | null;
  onDismiss: () => void;
  showDialog: (dialog: BoardDialog) => void;
  openGuide: () => void;
  openWorkspace: () => void;
}) {
  const state = work.state;
  let saveStatus = 'Saved in Vault';
  let statusIcon: 'check' | 'refresh' | 'warning' = 'check';
  if (work.dirty) {
    saveStatus = 'Unsaved changes';
    statusIcon = 'warning';
  }
  if (work.status === 'loading') {
    saveStatus = 'Loading…';
    statusIcon = 'refresh';
  }
  if (work.status === 'saving') {
    saveStatus = 'Saving…';
    statusIcon = 'refresh';
  }
  return (
    <>
      <header className="work-heading">
        <div className="work-heading-identity">
          <span className="work-heading-mark" aria-hidden="true">
            <WorkspaceIcon name="board" />
          </span>
          <div>
            <h1>Work context</h1>
            <p>
              {vaultName} <span className="work-heading-separator">/</span>{' '}
              {space?.name ?? 'Project spaces'}
            </p>
          </div>
        </div>
        <div className="work-heading-actions">
          <div className="work-save-status" role="status">
            <WorkspaceIcon name={statusIcon} />
            <span>{saveStatus}</span>
            {work.status === 'saving' || work.status === 'loading' ? (
              <LoadingIndicator
                label={work.status === 'saving' ? 'Saving workspace' : 'Loading workspace'}
              />
            ) : null}
          </div>
          <button className="icon-button" aria-label="Workspace guide" onClick={openGuide}>
            <WorkspaceIcon name="help" />
          </button>
          <button className="work-settings-button" disabled={!state} onClick={openWorkspace}>
            <WorkspaceIcon name="settings" />
            <span>Workspace</span>
          </button>
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

function BoardSpaceBar({
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
    <section className="work-drawer-section" aria-labelledby="work-spaces-heading">
      <div className="work-section-heading">
        <WorkspaceIcon name="folder" />
        <div>
          <h3 id="work-spaces-heading">Project space</h3>
          <p>Keep one flow per project, client, or release.</p>
        </div>
      </div>
      <label className="work-space-picker">
        Current space
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
      <div className="work-drawer-actions">
        <button
          onClick={() => showDialog({ kind: 'space' })}
          disabled={busy || state.spaces.length >= 128}
        >
          <WorkspaceIcon name="plus" />
          New space
        </button>
        {space ? (
          <button disabled={busy} onClick={() => showDialog({ kind: 'space', rename: true })}>
            <WorkspaceIcon name="edit" />
            Rename
          </button>
        ) : null}
      </div>
      {busy ? (
        <p className="work-warning" role="status">
          Remote action in progress. Keep this item open until the result arrives.
        </p>
      ) : null}
    </section>
  );
}

export function BoardToolbar({
  space,
  work,
  activeTab,
  filtersOpen,
  changeView,
  changeTab,
  toggleFilters,
  showDialog,
  onCloseFilters,
}: {
  space: WorkSpace;
  work: BoardWork;
  activeTab: BoardTab;
  filtersOpen: boolean;
  changeView: (view: Partial<WorkView>) => void;
  changeTab: (tab: BoardTab) => void;
  toggleFilters: () => void;
  showDialog: (dialog: BoardDialog) => void;
  onCloseFilters: () => void;
}) {
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const filterCount =
    Number(Boolean(space.view.query)) +
    Number(space.view.kind !== 'all') +
    Number(space.view.priority !== 'all');
  return (
    <div className="work-toolbar">
      <div
        className="work-view-tabs"
        role="tablist"
        aria-label="Workspace view"
        tabIndex={-1}
        onKeyDown={moveTabFocus}
      >
        <button
          id="work-board-tab"
          role="tab"
          title="Board view"
          aria-label="Board view"
          aria-controls="work-items-panel"
          aria-selected={activeTab === 'board'}
          tabIndex={activeTab === 'board' ? 0 : -1}
          onClick={() => changeTab('board')}
        >
          <WorkspaceIcon name="board" />
          <span className="visually-hidden">Board</span>
        </button>
        <button
          id="work-list-tab"
          role="tab"
          title="List view"
          aria-label="List view"
          aria-controls="work-items-panel"
          aria-selected={activeTab === 'list'}
          tabIndex={activeTab === 'list' ? 0 : -1}
          onClick={() => changeTab('list')}
        >
          <WorkspaceIcon name="list" />
          <span className="visually-hidden">List</span>
        </button>
        <button
          id="work-sources-tab"
          role="tab"
          aria-controls="work-sources-panel"
          aria-selected={activeTab === 'sources'}
          tabIndex={activeTab === 'sources' ? 0 : -1}
          onClick={() => changeTab('sources')}
        >
          <WorkspaceIcon name="connections" />
          Sources
          <span className="work-tab-count">{space.sources.length}</span>
        </button>
      </div>
      {activeTab !== 'sources' ? (
        <label className="work-command-search">
          <WorkspaceIcon name="search" />
          <span className="visually-hidden">Filter work items</span>
          <input
            type="search"
            placeholder="Search work…"
            value={space.view.query}
            onChange={(event) => changeView({ query: event.target.value })}
            maxLength={4096}
          />
        </label>
      ) : null}
      <div className="work-toolbar-actions">
        {activeTab !== 'sources' ? (
          <div className="work-filter-control">
            <button
              ref={filterTrigger}
              className="work-filter-button"
              type="button"
              title={filterCount ? `${filterCount} active filters` : 'Filter work items'}
              aria-label={filterCount ? `Filters, ${filterCount} active` : 'Filters'}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              aria-controls="work-filter-drawer"
              onClick={toggleFilters}
            >
              <WorkspaceIcon name="filter" />
              Filters
              {filterCount ? <span className="work-action-count">{filterCount}</span> : null}
            </button>
            <OverlayPresence>
              {filtersOpen ? (
                <BoardFilters
                  space={space}
                  changeView={changeView}
                  onClose={onCloseFilters}
                  triggerRef={filterTrigger}
                />
              ) : null}
            </OverlayPresence>
          </div>
        ) : null}
        <button
          className="icon-button"
          type="button"
          title="Add existing work"
          aria-label="Add existing work"
          onClick={() => showDialog({ kind: 'existing' })}
        >
          <WorkspaceIcon name="import" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Follow a work URL"
          aria-label="Follow a work URL"
          onClick={() => showDialog({ kind: 'follow' })}
          disabled={!work.connections.length}
        >
          <WorkspaceIcon name="link" />
        </button>
        <button
          className="primary work-new-task-button"
          type="button"
          onClick={() => showDialog({ kind: 'task' })}
        >
          <WorkspaceIcon name="plus" />
          New task
        </button>
      </div>
    </div>
  );
}

function BoardFilters({
  space,
  changeView,
  onClose,
  triggerRef,
}: {
  space: WorkSpace;
  changeView: (view: Partial<WorkView>) => void;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const filters = useRef<HTMLElement>(null);
  const phase = useOverlayPresence();
  const initialFocus = useRef(false);
  useEffect(() => {
    if (phase === 'exiting') {
      initialFocus.current = false;
      return;
    }
    if (initialFocus.current) {
      return;
    }
    filters.current?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
    initialFocus.current = true;
  }, [phase]);
  const anyFilter = Boolean(
    space.view.query || space.view.kind !== 'all' || space.view.priority !== 'all',
  );
  useEffect(() => {
    if (phase === 'exiting') {
      return;
    }
    const element = filters.current;
    if (!element) {
      return;
    }
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !element.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  }, [onClose, phase, triggerRef]);
  return (
    <section
      ref={filters}
      className="work-filter-drawer"
      id="work-filter-drawer"
      role="dialog"
      aria-label="Board filters"
      data-overlay-presence={phase}
      aria-hidden={phase === 'exiting'}
      inert={phase === 'exiting'}
    >
      <div className="work-filter-heading">
        <div>
          <strong>Refine this view</strong>
          <span>Filters stay with {space.name}.</span>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close filters"
          onClick={() => {
            onClose();
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <WorkspaceIcon name="close" />
        </button>
      </div>
      <div className="work-filters">
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
            onChange={(event) =>
              changeView({ priority: event.target.value as WorkView['priority'] })
            }
          >
            <option value="all">All priorities</option>
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priority === 'none'
                  ? 'No priority'
                  : priority[0].toUpperCase() + priority.slice(1)}
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
          <button
            type="button"
            onClick={() => changeView({ query: '', kind: 'all', priority: 'all' })}
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </section>
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
    <section
      className="work-sources-panel"
      id="work-sources-panel"
      role="tabpanel"
      aria-labelledby="work-sources-tab"
    >
      <header className="work-panel-heading">
        <div>
          <h2>Connected work</h2>
          <p>Follow repositories and Jira projects without changing their remote workflow.</p>
        </div>
        <button
          onClick={() => showDialog({ kind: 'source' })}
          disabled={space.sources.length >= 256}
        >
          <WorkspaceIcon name="plus" />
          Add source
        </button>
      </header>
      {work.connectionError ? (
        <p className="work-error" role="alert">
          Connections unavailable: {work.connectionError}{' '}
          <button onClick={() => void work.reloadConnections()}>Retry connections</button>
        </p>
      ) : null}
      {!space.sources.length ? (
        <div className="work-source-empty">
          <span aria-hidden="true">
            <WorkspaceIcon name="connections" />
          </span>
          <h3>No sources yet</h3>
          <p>Connect a repository or Jira project to bring matching work into this space.</p>
          <div>
            <button className="primary" onClick={() => showDialog({ kind: 'source' })}>
              Add your first source
            </button>
            <button onClick={onConnections}>Manage accounts</button>
          </div>
        </div>
      ) : (
        <ul className="work-source-list">
          {space.sources.map((source) => {
            const status = work.sourceStatuses[JSON.stringify([work.vaultKey, space.id, source])];
            const connected = work.connections.some(
              (connection) => connection.id === source.connectionId,
            );
            return (
              <li key={source.id}>
                <span className="work-source-provider" aria-hidden="true">
                  <WorkspaceIcon name="connections" />
                </span>
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
                  {status?.warning ? <span className="work-warning">{status.warning}</span> : null}
                </div>
                <div className="work-source-actions">
                  <button
                    className="icon-button"
                    aria-label={`Edit ${source.scope}`}
                    onClick={() => showDialog({ kind: 'source', source })}
                  >
                    <WorkspaceIcon name="edit" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Refresh ${source.scope}`}
                    disabled={status?.loading || !connected}
                    onClick={() => void work.refreshSource(source)}
                  >
                    <WorkspaceIcon name="refresh" />
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
      <footer className="work-source-footer">
        <button onClick={onConnections}>
          <WorkspaceIcon name="connections" />
          Manage connections
        </button>
        <button onClick={() => void work.reloadConnections()}>
          <WorkspaceIcon name="refresh" />
          Refresh accounts
        </button>
      </footer>
    </section>
  );
}

export function BoardOnboarding({
  canFollow,
  showDialog,
}: {
  canFollow: boolean;
  showDialog: (dialog: BoardDialog) => void;
}) {
  return (
    <section className="work-onboarding" aria-labelledby="work-onboarding-title">
      <div>
        <h2 id="work-onboarding-title">Start with the work already in motion</h2>
        <p>Create a local task, bring in an existing item, or follow a remote project.</p>
      </div>
      <div className="work-onboarding-actions">
        <button className="primary" onClick={() => showDialog({ kind: 'task' })}>
          <WorkspaceIcon name="task" />
          New task
        </button>
        <button onClick={() => showDialog({ kind: 'existing' })}>
          <WorkspaceIcon name="import" />
          Add existing
        </button>
        <button disabled={!canFollow} onClick={() => showDialog({ kind: 'follow' })}>
          <WorkspaceIcon name="link" />
          Follow URL
        </button>
      </div>
    </section>
  );
}

export function WorkspaceDrawer({
  state,
  space,
  busy,
  onSelect,
  showDialog,
  onConnections,
  onShowSources,
  onClose,
}: {
  state: WorkState;
  space: WorkSpace | null;
  busy: boolean;
  onSelect: (id: string) => void;
  showDialog: (dialog: BoardDialog) => void;
  onConnections: () => void;
  onShowSources: () => void;
  onClose: () => void;
}) {
  return (
    <DialogFrame title="Workspace setup" cancel={onClose} className="work-drawer">
      <BoardSpaceBar
        state={state}
        space={space}
        busy={busy}
        onSelect={onSelect}
        showDialog={showDialog}
      />
      {space ? (
        <section className="work-drawer-section" aria-labelledby="work-flow-heading">
          <div className="work-section-heading">
            <WorkspaceIcon name="columns" />
            <div>
              <h3 id="work-flow-heading">Board workflow</h3>
              <p>{space.columns.length} local columns. Remote statuses stay unchanged.</p>
            </div>
          </div>
          <div className="work-drawer-actions">
            <button onClick={() => showDialog({ kind: 'columns' })}>
              <WorkspaceIcon name="columns" />
              Configure columns
            </button>
            <button onClick={onShowSources}>
              <WorkspaceIcon name="connections" />
              Sources <span className="work-action-count">{space.sources.length}</span>
            </button>
          </div>
        </section>
      ) : null}
      <section className="work-drawer-section" aria-labelledby="work-connections-heading">
        <div className="work-section-heading">
          <WorkspaceIcon name="connections" />
          <div>
            <h3 id="work-connections-heading">Accounts</h3>
            <p>GitHub and Jira connections are shared across spaces.</p>
          </div>
        </div>
        <button onClick={onConnections}>Manage connections</button>
      </section>
    </DialogFrame>
  );
}

export function WorkspaceGuide({ onClose }: { onClose: () => void }) {
  return (
    <DialogFrame
      title="How Work context fits together"
      cancel={onClose}
      className="work-guide-dialog"
    >
      <p>
        One calm surface for planning local work and watching remote work without mixing their
        states.
      </p>
      <ol className="work-guide-steps">
        <li>
          <span>
            <WorkspaceIcon name="folder" />
          </span>
          <div>
            <strong>Choose a space</strong>
            <p>Spaces separate projects. Each one remembers its board, filters, and sources.</p>
          </div>
        </li>
        <li>
          <span>
            <WorkspaceIcon name="connections" />
          </span>
          <div>
            <strong>Bring work together</strong>
            <p>
              Add local tasks or follow GitHub and Jira work. Nothing is sent remotely until you
              choose a remote action.
            </p>
          </div>
        </li>
        <li>
          <span>
            <WorkspaceIcon name="board" />
          </span>
          <div>
            <strong>Shape your local flow</strong>
            <p>Move cards and rename columns freely. Your board never rewrites remote statuses.</p>
          </div>
        </li>
      </ol>
      <div className="work-guide-tip">
        <WorkspaceIcon name="keyboard" />
        <span>
          <strong>Keyboard tip</strong> — focus a card and use Alt + arrow keys to move it.
        </span>
      </div>
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </DialogFrame>
  );
}
