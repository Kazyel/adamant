import type { KeyboardEvent, RefObject } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import ProviderIcon from './ProviderIcon';
import { kindLabels } from './state';
import type { WorkItem } from './types';

export type DetailView = 'overview' | 'activity' | 'changes' | 'local' | 'actions';

const views = {
  overview: 'Overview',
  activity: 'Activity',
  changes: 'Changes',
  local: 'Local',
  actions: 'Actions',
} satisfies Record<DetailView, string>;

function selectAdjacentTab(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }
  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  );
  const current = tabs.indexOf(event.currentTarget);
  let next = current;
  if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = tabs.length - 1;
  } else if (event.key === 'ArrowLeft') {
    next = (current - 1 + tabs.length) % tabs.length;
  } else {
    next = (current + 1) % tabs.length;
  }
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

export function DetailNavigation({
  view,
  onChange,
  pullRequest,
  show,
  bodyId,
  activityCount,
  changeCount,
}: {
  view: DetailView;
  onChange: (view: DetailView) => void;
  pullRequest: boolean;
  show: boolean;
  bodyId: string;
  activityCount?: number;
  changeCount?: number;
}) {
  if (!show) {
    return null;
  }
  const visible: DetailView[] = pullRequest
    ? ['overview', 'activity', 'changes', 'local', 'actions']
    : ['overview', 'activity', 'local', 'actions'];
  const counts: Partial<Record<DetailView, number>> = {
    activity: activityCount,
    changes: changeCount,
  };
  return (
    <div
      className="work-detail-navigation"
      aria-label="Item views"
      role="tablist"
      data-count={visible.length}
    >
      {visible.map((entry) => (
        <button
          key={entry}
          type="button"
          id={`${bodyId}-tab-${entry}`}
          role="tab"
          aria-selected={entry === view}
          aria-controls={`${bodyId}-${entry}`}
          tabIndex={entry === view ? 0 : -1}
          data-view={entry}
          onClick={() => onChange(entry)}
          onKeyDown={selectAdjacentTab}
        >
          <span>{views[entry]}</span>
          {counts[entry] === undefined ? null : <small>{counts[entry]}</small>}
        </button>
      ))}
    </div>
  );
}

export default function DetailHeader({
  item,
  target,
  headingId,
  heading,
  bodyId,
  expanded,
  pending,
  onExpand,
  onClose,
}: {
  item: WorkItem;
  target: string;
  headingId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  bodyId: string;
  expanded: boolean;
  pending: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
  return (
    <header className="work-detail-header">
      <div className="work-detail-heading">
        <div className="work-detail-identity">
          {item.remote ? (
            <ProviderIcon provider={item.remote.provider} />
          ) : (
            <WorkspaceIcon name="task" />
          )}
          <span>{kindLabels[item.kind]}</span>
          {item.remote ? (
            <span className="work-detail-state" data-state={item.remoteState?.toLowerCase()}>
              {item.remoteState ?? 'State unavailable'}
            </span>
          ) : null}
        </div>
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className={item.remote ? undefined : 'visually-hidden'}
        >
          {item.title}
        </h2>
        {item.remote ? <p className="work-detail-target">{target}</p> : null}
      </div>
      <div className="work-detail-header-actions">
        <button
          type="button"
          className="icon-button"
          title={expanded ? 'Collapse details' : 'Expand details'}
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onExpand}
        >
          <WorkspaceIcon name={expanded ? 'minimize' : 'maximize'} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Close item details"
          aria-label="Close item details"
          disabled={pending}
          onClick={onClose}
        >
          <WorkspaceIcon name="close" />
        </button>
      </div>
    </header>
  );
}
