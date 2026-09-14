import SearchField from '../../shared/ui/SearchField';
import ProviderIcon from './ProviderIcon';
import SelectField from '../interaction/SelectField';
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import MenuButton from '../interaction/MenuButton';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import DialogFrame from '../workspace/DialogFrame';
import { OverlayPresence, useOverlayPresence } from '../interaction/OverlayPresence';
import { kindLabels, priorities } from './state';
import type { SourceStatus } from './useWorkContext';
import type { WorkSpace, WorkView } from './types';
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

function BoardSaveStatus({ work }: { work: BoardWork }) {
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
      {work.dirty || work.status === 'loading' || work.status === 'saving' ? (
        <div className="work-save-status" role="status">
          <WorkspaceIcon name={statusIcon} />
          <span>{saveStatus}</span>
          {work.status === 'saving' || work.status === 'loading' ? (
            <LoadingIndicator
              label={work.status === 'saving' ? 'Saving workspace' : 'Loading workspace'}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function HubCreateButton({
  space,
  state,
  busy,
  onCreate,
}: {
  space: WorkSpace | null;
  state: BoardWork['state'];
  busy: boolean;
  onCreate: () => void;
}) {
  if (space || !state) {
    return null;
  }
  const limitReached = state.spaces.length >= 128;
  return (
    <button
      className="work-heading-create primary"
      disabled={busy || limitReached}
      data-tooltip={limitReached ? 'Workspace limit reached' : undefined}
      onClick={onCreate}
    >
      <WorkspaceIcon name="plus" /> Create workspace
    </button>
  );
}

function GitHubRefresh({
  space,
  work,
  online,
  busy,
  onSources,
}: {
  space: WorkSpace;
  work: BoardWork;
  online: boolean;
  busy: boolean;
  onSources: () => void;
}) {
  const sources = space.sources.filter((source) => source.provider === 'github');
  if (!sources.length) {
    return null;
  }
  const connected = sources.filter((source) =>
    work.connections.some((connection) => connection.id === source.connectionId),
  );
  const statuses = sources.map(
    (source) => work.sourceStatuses[JSON.stringify([work.vaultKey, space.id, source])],
  );
  const loading = statuses.some((status) => status?.loading);
  const needsAttention =
    connected.length < sources.length ||
    statuses.some((status) => status?.error || status?.warning);
  const updated = statuses.every((status) => status?.fetchedAt);
  let title = 'Refresh GitHub sources in this workspace';
  if (!connected.length) {
    title = 'Reconnect your GitHub account in Connections';
  }
  if (!online) {
    title = 'Connect to the internet to refresh GitHub';
  }
  let feedback = updated ? 'GitHub sources refreshed' : '';
  if (needsAttention) {
    feedback = 'GitHub sources need attention';
  }
  if (loading) {
    feedback = 'Refreshing GitHub…';
  }
  return (
    <div className="work-github-refresh" data-loading={loading}>
      <button
        className="icon-button"
        aria-label="Refresh GitHub"
        disabled={busy || !online || loading || !connected.length}
        data-tooltip={loading ? feedback : title}
        onClick={() => {
          void Promise.all(connected.map((source) => work.refreshSource(source)));
        }}
      >
        <WorkspaceIcon name="refresh" />
      </button>
      {needsAttention && !loading ? (
        <button
          className="icon-button work-github-refresh-warning"
          aria-label="GitHub sources need attention"
          data-tooltip="GitHub sources need attention. Open Manage sources"
          onClick={onSources}
        >
          <WorkspaceIcon name="warning" />
        </button>
      ) : null}
      <span className="visually-hidden" role="status">
        {feedback}
      </span>
    </div>
  );
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
  onHub,
  onSources,
  onConnections,
  busy,
}: {
  vaultName: string;
  space: WorkSpace | null;
  work: BoardWork;
  online: boolean;
  notice: string | null;
  onDismiss: () => void;
  showDialog: (dialog: BoardDialog) => void;
  openGuide: () => void;
  onHub: () => void;
  onSources: () => void;
  onConnections: () => void;
  busy: boolean;
}) {
  const state = work.state;
  return (
    <>
      <header className="work-heading">
        <div className="work-heading-identity">
          {space ? (
            <button className="work-hub-back" disabled={busy} onClick={onHub}>
              Workspaces
            </button>
          ) : null}
          {space ? <span className="work-heading-separator">/</span> : null}
          <h1>{space?.name ?? 'Workspaces'}</h1>
          {!space ? <span className="work-hub-vault">{vaultName}</span> : null}
        </div>
        <div className="work-heading-actions">
          <HubCreateButton
            space={space}
            state={state}
            busy={busy}
            onCreate={() => showDialog({ kind: 'space' })}
          />
          <BoardSaveStatus work={work} />
          {space ? (
            <GitHubRefresh
              space={space}
              work={work}
              online={online}
              busy={busy}
              onSources={onSources}
            />
          ) : null}
          <MenuButton
            label={space ? 'Workspace actions' : 'Workspace help'}
            disabled={busy}
            className="icon-button"
            actions={[
              ...(space
                ? [
                    {
                      id: 'rename',
                      label: 'Rename workspace',
                      icon: 'edit' as const,
                      run: () => showDialog({ kind: 'space', rename: true }),
                    },
                    {
                      id: 'columns',
                      label: 'Configure columns',
                      icon: 'columns' as const,
                      run: () => showDialog({ kind: 'columns' }),
                    },
                    {
                      id: 'sources',
                      label: 'Manage sources',
                      icon: 'import' as const,
                      run: onSources,
                    },
                  ]
                : []),
              {
                id: 'connections',
                label: 'Manage connections',
                icon: 'connections',
                run: onConnections,
              },
              { id: 'help', label: 'Workspace guide', icon: 'help', run: openGuide },
            ]}
          >
            <WorkspaceIcon name="more" />
          </MenuButton>
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

export function BoardToolbar({
  space,
  activeTab,
  filtersOpen,
  changeView,
  changeTab,
  toggleFilters,
  showDialog,
  onCloseFilters,
}: {
  space: WorkSpace;
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
          data-tooltip="Board view"
          aria-label="Board view"
          aria-controls="work-items-panel"
          aria-selected={activeTab === 'board'}
          tabIndex={activeTab !== 'list' ? 0 : -1}
          onClick={() => changeTab('board')}
        >
          <WorkspaceIcon name="board" />
          <span>Board</span>
        </button>
        <button
          id="work-list-tab"
          role="tab"
          data-tooltip="List view"
          aria-label="List view"
          aria-controls="work-items-panel"
          aria-selected={activeTab === 'list'}
          tabIndex={activeTab === 'list' ? 0 : -1}
          onClick={() => changeTab('list')}
        >
          <WorkspaceIcon name="list" />
          <span>List</span>
        </button>
      </div>
      {activeTab !== 'sources' ? (
        <SearchField
          aria-label="Filter work items"
          className="work-command-search"

          placeholder="Search work…"
          value={space.view.query}
          onChange={(event) => changeView({ query: event.target.value })}
          maxLength={4096}
        />
      ) : null}
      {activeTab !== 'sources' ? (
        <div className="work-filter-control">
          <button
            ref={filterTrigger}
            className="work-filter-button"
            type="button"
            data-tooltip={filterCount ? `${filterCount} active filters` : 'Filter work items'}
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
      <div className="work-toolbar-actions">
        <MenuButton
          label="Add work"
          actions={[
            {
              id: 'existing',
              label: 'Add existing work',
              icon: 'import',
              run: () => showDialog({ kind: 'existing' }),
            },
            {
              id: 'follow',
              label: 'Follow a work URL',
              icon: 'link',
              run: () => showDialog({ kind: 'follow' }),
            },
          ]}
        >
          Add <WorkspaceIcon name="chevron" />
        </MenuButton>
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
    filters.current
      ?.querySelector<HTMLButtonElement>('.select-field button')
      ?.focus({ preventScroll: true });
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
        !(target instanceof Element && target.closest('.interaction-context-menu')) &&
        !element.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('.interaction-context-menu:not([inert])')
      ) {
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
          <SelectField
            value={space.view.kind}
            onChange={(event) => changeView({ kind: event.target.value as WorkView['kind'] })}
          >
            <option value="all">All types</option>
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          Priority
          <SelectField
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
          </SelectField>
        </label>
        <label>
          Sort
          <SelectField
            value={space.view.sort}
            onChange={(event) => changeView({ sort: event.target.value as WorkView['sort'] })}
          >
            <option value="manual">Manual order</option>
            <option value="updated">Recently updated</option>
            <option value="priority">Highest priority</option>
            <option value="due">Due date</option>
          </SelectField>
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
    <section className="work-sources-panel" id="work-sources-panel" aria-label="Workspace sources">
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
                  <ProviderIcon provider={source.provider} />
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

export function BoardOnboarding({ showDialog }: { showDialog: (dialog: BoardDialog) => void }) {
  return (
    <section className="work-onboarding" aria-labelledby="work-onboarding-title">
      <div>
        <h2 id="work-onboarding-title">Add your first piece of work</h2>
        <p>Start with a task or connect a repository or Jira project.</p>
      </div>
      <div className="work-onboarding-actions">
        <button className="primary" onClick={() => showDialog({ kind: 'task' })}>
          <WorkspaceIcon name="task" />
          New task
        </button>
        <button onClick={() => showDialog({ kind: 'source' })}>
          <WorkspaceIcon name="connections" />
          Connect a source
        </button>
      </div>
    </section>
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
