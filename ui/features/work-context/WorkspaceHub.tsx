import { useEffect, useRef, useState } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import ProviderIcon from './ProviderIcon';
import type { WorkSpace, WorkState } from './types';

const providerLabels = { github: 'GitHub', jira: 'Jira' } as const;

function columnCounts(space: WorkSpace) {
  const counts = new Map(space.columns.map((column) => [column.id, 0]));
  for (const member of space.members) {
    if (counts.has(member.columnId)) {
      counts.set(member.columnId, counts.get(member.columnId)! + 1);
    }
  }
  return counts;
}

function WorkspaceCard({ space, onOpen }: { space: WorkSpace; onOpen: (id: string) => void }) {
  const counts = columnCounts(space);
  const kanbanLabel =
    space.columns.map((column) => `${counts.get(column.id)} ${column.name}`).join(', ') ||
    'no columns';
  return (
    <button
      className="work-hub-card"
      onClick={() => onOpen(space.id)}
      aria-label={`Open workspace ${space.name}. Kanban: ${kanbanLabel}`}
    >
      <span className="work-hub-card-topline">
        <WorkspaceIcon name="board" />
        <strong className="work-hub-card-name">{space.name}</strong>
        <WorkspaceIcon name="chevron" />
      </span>
      <span className="work-hub-sources">
        {space.sources.length ? (
          space.sources.slice(0, 2).map((source) => (
            <span key={source.id}>
              <ProviderIcon provider={source.provider} />
              <span>
                {providerLabels[source.provider]} · {source.scope}
              </span>
            </span>
          ))
        ) : (
          <span>
            <WorkspaceIcon name="task" /> Local workspace
          </span>
        )}
        {space.sources.length > 2 ? (
          <span className="work-hub-more-sources">+{space.sources.length - 2} more sources</span>
        ) : null}
      </span>
      <span className="work-hub-card-columns" aria-label="Kanban column totals">
        {space.columns.map((column) => (
          <span key={column.id} data-empty={counts.get(column.id) === 0}>
            <b>{counts.get(column.id)}</b>
            <span>{column.name}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

function WorkspacePreview() {
  return (
    <div className="work-hub-preview" aria-hidden="true">
      <div className="work-hub-preview-title">
        <WorkspaceIcon name="board" />
        <span>Your next project</span>
        <WorkspaceIcon name="more" />
      </div>
      <div className="work-hub-preview-board">
        <div>
          <span>To do</span>
          <div className="work-hub-preview-task">
            <WorkspaceIcon name="task" /> A place to start
            <span />
            <span />
          </div>
          <div className="work-hub-preview-task">
            <ProviderIcon provider="github" /> An issue to explore
            <span />
          </div>
        </div>
        <div>
          <span>In progress</span>
          <div className="work-hub-preview-task">
            <WorkspaceIcon name="document" /> Ideas into action
            <span />
            <span />
          </div>
        </div>
        <div>
          <span>Done</span>
          <div className="work-hub-preview-task work-hub-preview-done">
            <WorkspaceIcon name="check" /> One step further
            <span />
          </div>
        </div>
      </div>
      <div className="work-hub-preview-caption">
        <WorkspaceIcon name="columns" /> Your columns. Your workflow.
      </div>
    </div>
  );
}

export default function WorkspaceHub({
  state,
  onOpen,
  onCreate,
}: {
  state: WorkState;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  function clearSearch() {
    setQuery('');
    searchInput.current?.focus();
  }

  const search = query.trim().toLocaleLowerCase();
  const spaces = state.spaces.filter(
    (space) =>
      space.name.toLocaleLowerCase().includes(search) ||
      space.sources.some((source) => source.scope.toLocaleLowerCase().includes(search)),
  );

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className={`work-hub ${state.spaces.length ? '' : 'work-hub-first'}`}>
      <div className="work-hub-content">
        {state.spaces.length ? null : (
          <header className="work-hub-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                Make room for your next project.
              </h2>
              <p>Give your tasks, notes and connected work a place of their own.</p>
            </div>
          </header>
        )}
        {state.spaces.length ? (
          <>
            <div className="work-hub-toolbar">
              <span role="status">
                {search ? `${spaces.length} of ${state.spaces.length}` : state.spaces.length}{' '}
                {state.spaces.length === 1 ? 'workspace' : 'workspaces'}
              </span>
              <div className="work-hub-search">
                <WorkspaceIcon name="search" />
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="Find a workspace by name or source"
                  placeholder="Find a workspace or source…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    className="icon-button"
                    aria-label="Clear workspace search"
                    onClick={clearSearch}
                  >
                    <WorkspaceIcon name="close" />
                  </button>
                ) : null}
              </div>
            </div>
            {state.spaces.length >= 128 ? (
              <p className="work-hub-limit">This Vault has reached the limit of 128 workspaces.</p>
            ) : null}
            {spaces.length ? (
              <div className="work-hub-grid">
                {spaces.map((space) => (
                  <WorkspaceCard key={space.id} space={space} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <div className="work-hub-no-results">
                <WorkspaceIcon name="search" />
                <h3>No matching workspaces</h3>
                <p>Try another project name or repository.</p>
                <button onClick={clearSearch}>Show all workspaces</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="work-hub-welcome">
              <div className="work-hub-invitation">
                <span className="work-hub-project-icon">
                  <WorkspaceIcon name="folder" />
                </span>
                <h3>
                  Start with something
                  <br />
                  you want to move forward.
                </h3>
                <p>
                  A release, a research project, a personal plan. Name your workspace, add a task
                  and shape the board around how you work.
                </p>
                <button className="primary" onClick={onCreate}>
                  <WorkspaceIcon name="plus" /> Create your first workspace
                </button>
                <span>No connected account needed.</span>
              </div>
              <WorkspacePreview />
            </div>
            <div className="work-hub-principles">
              <section>
                <WorkspaceIcon name="document" />
                <div>
                  <h3>Keep the context with the work</h3>
                  <p>
                    Link your Vault notes to tasks, so the thinking behind a decision is easy to
                    find.
                  </p>
                </div>
              </section>
              <section>
                <span className="work-hub-provider-pair">
                  <ProviderIcon provider="github" />
                  <ProviderIcon provider="jira" />
                </span>
                <div>
                  <h3>Bring your tools when you’re ready</h3>
                  <p>
                    Add GitHub repositories or Jira projects. Organize their items alongside your
                    local tasks.
                  </p>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
