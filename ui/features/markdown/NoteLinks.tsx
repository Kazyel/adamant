import { useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import SearchField from '../../shared/ui/SearchField';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { Dialog } from '../interaction/InteractionDialogs';
import { useNoteLinks } from './noteLinks';
import type { NoteLinkList } from './noteLinksPaging';
import type {
  IncomingNoteLink,
  NoteLinkTarget,
  NoteLinksSource,
  OutgoingNoteLink,
} from './noteLinks';

function LoadingStatus({ data }: { data: ReturnType<typeof useNoteLinks> }) {
  const { snapshot, error, loading, paused, retry, watchError } = data;
  return (
    <>
      {error ? (
        <div className="note-links-error" role="alert">
          <p>
            {snapshot ? 'Could not update note links.' : 'Could not load note links.'} {error}
          </p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="note-links-status" role="status">
          {snapshot ? 'Updating references…' : 'Loading notes…'}
        </p>
      ) : null}
      {paused ? (
        <div className="note-links-status" role="status">
          <p>Results are still incomplete.</p>
          <button type="button" onClick={retry}>
            Continue finding notes
          </button>
        </div>
      ) : null}
      {snapshot && !loading && !paused && snapshot.indexing.state !== 'ready' ? (
        <p className="note-links-status" role="status">
          Some notes could not be indexed. References may be incomplete.
          {snapshot.indexing.message ? ` ${snapshot.indexing.message}` : ''}
        </p>
      ) : null}
      {snapshot?.referencesTruncated ? (
        <p className="note-links-status">
          Some notes exceed the link analysis limit. Their references may be incomplete.
        </p>
      ) : null}
      {watchError ? (
        <p className="note-links-status" role="status">
          Live updates are unavailable. Close and reopen this panel to refresh. {watchError}
        </p>
      ) : null}
    </>
  );
}

function MoreLinks({
  data,
  list,
  label,
}: {
  data: ReturnType<typeof useNoteLinks>;
  list: NoteLinkList;
  label: string;
}) {
  const hasMore = data.snapshot?.[`${list}HasMore`];
  if (!hasMore) {
    return null;
  }
  return data.canLoadMore(list) ? (
    <button type="button" disabled={data.loading} onClick={() => data.loadMore(list)}>
      {label}
    </button>
  ) : (
    <p className="note-links-status">
      The display limit has been reached. Refine the search or open the source note.
    </p>
  );
}

export function NoteLinkPicker({
  onSelect,
  onClose,
  ...source
}: NoteLinksSource & {
  onSelect: (target: NoteLinkTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const data = useNoteLinks({ ...source, query });

  function navigateResults(event: KeyboardEvent<HTMLButtonElement>) {
    const buttons = Array.from(results.current?.querySelectorAll('button') ?? []);
    const current = buttons.findIndex((button) => button === document.activeElement);
    if (current < 0) {
      return;
    }
    if (event.key === 'ArrowUp' && current === 0) {
      event.preventDefault();
      input.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[current + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    }
  }

  return (
    <Dialog
      open
      title="Link to a note"
      description="Find a note in your Vault and insert a Markdown link."
      className="note-link-picker"
      onClose={onClose}
    >
      <SearchField
        ref={input}
        className="note-links-search"
        aria-label="Find a note by title or path"
        placeholder="Search by title or path…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            results.current?.querySelector('button')?.focus();
          }
        }}
      />
      <div className="note-link-picker-results" aria-busy={data.loading}>
        <LoadingStatus data={data} />
        <ul ref={results} className="note-links-list" aria-label="Available notes">
          {data.snapshot?.targets.map((target) => (
            <li key={target.path}>
              <button
                type="button"
                className="note-link-target"
                onClick={() => onSelect(target)}
                onKeyDown={navigateResults}
              >
                <WorkspaceIcon name="document" />
                <span>
                  <strong>{target.title}</strong>
                  <small>{target.path}</small>
                </span>
                <WorkspaceIcon name="link" />
              </button>
            </li>
          ))}
        </ul>
        <MoreLinks data={data} list="targets" label="Show more notes" />
        {data.snapshot && !data.snapshot.targets.length && !data.loading && !data.error ? (
          <p className="note-links-empty">
            No matching notes found. Try another title or path, or create a note to link to it.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function NoteLinksPanel({
  dirty,
  disabled,
  onOpenIncoming,
  onOpenOutgoing,
  onClose,
  ...source
}: NoteLinksSource & {
  dirty: boolean;
  disabled: boolean;
  onOpenIncoming: (link: IncomingNoteLink) => void;
  onOpenOutgoing: (path: string) => void;
  onClose: () => void;
}) {
  const data = useNoteLinks(source);
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const element = panel.current;
    element?.focus({ preventScroll: true });
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    element?.addEventListener('keydown', escape);
    return () => {
      element?.removeEventListener('keydown', escape);
      if (
        element?.contains(document.activeElement) &&
        trigger instanceof HTMLElement &&
        trigger.isConnected
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  const snapshot = data.snapshot;
  const complete =
    snapshot?.indexing.state === 'ready' && !snapshot.canContinue && !snapshot.referencesTruncated;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      id="note-links-panel"
      className="note-links-panel"
      aria-labelledby={headingId}
    >
      <header className="note-links-heading">
        <div>
          <WorkspaceIcon name="link" />
          <h2 id={headingId}>Backlinks</h2>
          {snapshot ? (
            <span className="note-links-count">
              {snapshot.incoming.length}
              {complete && !snapshot.incomingHasMore ? '' : '+'}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close backlinks panel"
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      <div className="note-links-body" aria-busy={data.loading}>
        <p className="note-links-intro">Notes that link to this note.</p>
        {dirty ? <p className="note-links-status">Save to update links from this note.</p> : null}
        <LoadingStatus data={data} />
        <ul className="note-links-list" aria-label="Incoming references">
          {snapshot?.incoming.map((link) => (
            <li key={`${link.path}:${link.line}:${link.column}`}>
              <button
                type="button"
                className="note-link-target"
                disabled={disabled}
                onClick={() => onOpenIncoming(link)}
              >
                <WorkspaceIcon name="document" />
                <span>
                  <strong>{link.title}</strong>
                  <small>
                    {link.path} · Line {link.line}
                  </small>
                  <span className="note-link-excerpt">{link.snippet}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <MoreLinks data={data} list="incoming" label="Show more backlinks" />
        {snapshot && !snapshot.incoming.length && !data.loading && !data.error ? (
          <p className="note-links-empty">
            {complete
              ? 'No backlinks yet. Link to this note from another note to see it here.'
              : 'No backlinks found in the notes checked so far.'}
          </p>
        ) : null}
        {snapshot ? (
          <OutgoingLinks
            data={data}
            links={snapshot.outgoing}
            complete={complete}
            disabled={disabled}
            onOpen={onOpenOutgoing}
          />
        ) : null}
      </div>
    </aside>
  );
}

const outgoingStatus = {
  resolved: 'Linked note',
  missing: 'Note not found',
  unindexed: 'Not checked yet',
};

function OutgoingLinks({
  data,
  links,
  complete,
  disabled,
  onOpen,
}: {
  data: ReturnType<typeof useNoteLinks>;
  links: OutgoingNoteLink[];
  complete: boolean;
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <details className="note-links-outgoing">
      <summary>
        Links from this note{' '}
        <span>
          {links.length}
          {data.snapshot?.outgoingHasMore ? '+' : ''}
        </span>
      </summary>
      {!links.length ? (
        <p className="note-links-empty">
          {complete
            ? 'This saved note has no links to other notes.'
            : 'No outgoing links found in the notes checked so far.'}
        </p>
      ) : null}
      <ul className="note-links-list" aria-label="Outgoing references">
        {links.map((link, index) => {
          const content = (
            <>
              <WorkspaceIcon name={link.status === 'resolved' ? 'document' : 'warning'} />
              <span>
                <strong>{link.targetPath}</strong>
                <small>
                  {outgoingStatus[link.status]} · Line {link.line}
                </small>
                <span className="note-link-excerpt">{link.snippet}</span>
              </span>
            </>
          );
          return (
            <li key={`${link.href}:${link.line}:${index}`}>
              {link.status === 'resolved' ? (
                <button
                  type="button"
                  className="note-link-target"
                  disabled={disabled}
                  onClick={() => onOpen(link.targetPath)}
                >
                  {content}
                </button>
              ) : (
                <div className="note-link-target note-link-unresolved">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      <MoreLinks data={data} list="outgoing" label="Show more outgoing links" />
      {links.some((link) => link.status !== 'resolved') ? (
        <p className="note-links-status">The links in your Markdown are unchanged.</p>
      ) : null}
    </details>
  );
}
