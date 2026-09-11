import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { SearchHit, SearchMode, SearchPage } from './navigationTypes';
import './navigation.css';

export function Breadcrumbs({
  path,
  vaultName,
  onNavigate,
}: {
  path: string;
  vaultName: string;
  onNavigate: (path: string) => void;
}) {
  const parts = path.split('/').filter(Boolean);
  return (
    <nav className="navigation-breadcrumbs" aria-label="Breadcrumbs">
      <button
        type="button"
        title={vaultName}
        onClick={() => onNavigate('')}
        aria-current={!parts.length ? 'page' : undefined}
      >
        <WorkspaceIcon name="folder" />
        <span className="navigation-breadcrumb-label">{vaultName}</span>
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join('/');
        return (
          <span className="navigation-breadcrumb" key={target}>
            <WorkspaceIcon name="chevron" />
            <button
              type="button"
              title={target}
              aria-current={index === parts.length - 1 ? 'page' : undefined}
              onClick={() => onNavigate(target)}
            >
              <span className="navigation-breadcrumb-label">{part}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}

type SearchFeedbackProps = {
  query: string;
  pending?: boolean;
  status?: SearchPage['indexing'] | null;
  hasMore?: boolean;
  coverageIncomplete?: boolean;
  truncated?: boolean;
  onLoadMore?: () => void;
  onContinue?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
};

function SearchProgress({ pending, status, coverageIncomplete, truncated }: SearchFeedbackProps) {
  if (pending) {
    return (
      <p className="navigation-status" role="status">
        <WorkspaceIcon name="search" />
        Searching the local Vault…
      </p>
    );
  }
  const incomplete = coverageIncomplete || ['partial', 'indexing'].includes(status?.state ?? '');
  let message = status?.message;
  if (!message && incomplete) {
    message = 'Only part of the Vault has been searched.';
  }
  return (
    <>
      {message ? (
        <p className="navigation-status" data-state={status?.state} role="status">
          <WorkspaceIcon name="search" />
          <span>{message}</span>
        </p>
      ) : null}
      {status && incomplete ? (
        <p className="navigation-coverage">
          {status.indexedDocuments} indexed documents / {status.scannedEntries} scanned entries
        </p>
      ) : null}
      {truncated ? (
        <p className="navigation-coverage" role="status">
          Showing up to 500 results. Refine your search to narrow the list.
        </p>
      ) : null}
    </>
  );
}

function SearchContinuation({
  pending,
  status,
  coverageIncomplete,
  hasMore,
  onCancel,
  onRetry,
  onContinue,
  onLoadMore,
}: SearchFeedbackProps) {
  let action: (() => void) | undefined;
  let label = '';
  if (pending) {
    action = onCancel;
    label = 'Cancel search';
  } else if (status?.state === 'cancelled' || status?.state === 'stale') {
    action = onRetry;
    label = 'Search again';
  } else if (coverageIncomplete && onContinue) {
    action = onContinue;
    label = 'Continue searching';
  } else if (hasMore) {
    action = onLoadMore;
    label = 'Load more results';
  }
  if (!action) {
    return null;
  }
  return (
    <div className="navigation-search-actions">
      <button type="button" onClick={action}>
        {label}
      </button>
    </div>
  );
}

function SearchFeedback(props: SearchFeedbackProps) {
  if (!props.query.trim()) {
    return null;
  }
  return (
    <div className="navigation-search-feedback">
      <SearchProgress {...props} />
      <SearchContinuation {...props} />
    </div>
  );
}

function SearchEmptyState({
  query,
  status,
  coverageIncomplete,
  mode,
}: Pick<SearchFeedbackProps, 'query' | 'status' | 'coverageIncomplete'> & {
  mode: SearchMode | 'recent';
}) {
  let title = 'No matches found';
  let description = 'Try a different search.';
  if (!query.trim()) {
    title = 'Search your Vault';
    description = 'Find Markdown, PDF and DOCX documents by their name or location.';
    if (mode === 'recent') {
      title = 'No recent documents';
      description = 'Open a document from the explorer, or search this Vault above.';
    } else if (mode === 'content') {
      description =
        'Find text in Markdown documents. Search names and paths to also find PDFs and DOCX files.';
    }
  } else {
    if (status && status.state !== 'ready') {
      title = 'No results yet';
    }
    if (coverageIncomplete) {
      description = 'Continue searching the remaining documents, or try a different search.';
    }
  }
  return (
    <div className="navigation-empty" role="status">
      <WorkspaceIcon name={mode === 'recent' ? 'document' : 'search'} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function ResultPath({ path }: { path: string }) {
  return (
    <span className="navigation-result-copy">
      <span className="navigation-result-name">
        {path.split('/').filter(Boolean).at(-1) || 'Vault'}
      </span>
      <span className="navigation-result-path">{path}</span>
    </span>
  );
}

type QuickOpenProps = SearchFeedbackProps & {
  onQuery: (value: string) => void;
  recent: string[];
  onOpen: (path: string) => void;
  items?: string[];
  missing?: ReadonlySet<string>;
};

export function QuickOpen({
  query,
  onQuery,
  recent,
  onOpen,
  items,
  missing,
  ...feedback
}: QuickOpenProps) {
  const searching = !!query.trim();
  const candidates = searching ? (items ?? recent) : recent;
  const normalized = query.toLocaleLowerCase();
  const shown = candidates.filter(
    (path) => !searching || path.toLocaleLowerCase().includes(normalized),
  );
  const [selection, setSelection] = useState<{ query: string; path: string | null }>({
    query,
    path: null,
  });
  const selected = Math.max(
    0,
    shown.indexOf(selection.query === query ? (selection.path ?? '') : ''),
  );
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, selected]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!shown.length) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelection({ query, path: shown[Math.min(selected + 1, shown.length - 1)] });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelection({ query, path: shown[Math.max(selected - 1, 0)] });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!missing?.has(shown[selected])) {
        onOpen(shown[selected]);
      }
    }
  }

  return (
    <section className="navigation-panel" aria-label="Quick open">
      <label className="navigation-search-field">
        <WorkspaceIcon name="search" />
        <input
          ref={input}
          aria-label="Find a document"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find a document by name or path…"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={shown.length > 0}
          aria-activedescendant={shown[selected] ? `${listId}-${selected}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="navigation-result-summary">
        <span>{searching ? 'Matching documents' : 'Recent documents'}</span>
        <span>
          {shown.length}
          {feedback.hasMore && searching ? '+' : ''}
        </span>
      </div>
      <div
        className="navigation-results"
        id={listId}
        role="listbox"
        aria-label={searching ? 'Matching documents' : 'Recent documents'}
        aria-busy={feedback.pending}
      >
        {shown.map((path, index) => (
          <button
            className="navigation-result"
            id={`${listId}-${index}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            disabled={missing?.has(path)}
            key={path}
            title={path}
            onMouseEnter={() => setSelection({ query, path })}
            onClick={() => onOpen(path)}
          >
            <WorkspaceIcon name={missing?.has(path) ? 'warning' : 'document'} />
            <ResultPath path={path} />
            {missing?.has(path) ? (
              <span className="navigation-result-state">Unavailable</span>
            ) : null}
          </button>
        ))}
      </div>
      {!shown.length && !feedback.pending ? (
        <SearchEmptyState
          query={query}
          mode="recent"
          status={feedback.status}
          coverageIncomplete={feedback.coverageIncomplete}
        />
      ) : null}
      {shown.some((path) => missing?.has(path)) ? (
        <p className="navigation-coverage">
          Unavailable documents may have moved. Reopen them from the explorer to update their
          identity.
        </p>
      ) : null}
      <SearchFeedback query={query} {...feedback} />
      <div className="navigation-key-hints" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>Enter</kbd> Open
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </div>
    </section>
  );
}

export function SearchResults({
  query,
  mode,
  hits,
  onQuery,
  onMode,
  onOpen,
  ...feedback
}: SearchFeedbackProps & {
  mode: SearchMode;
  hits: SearchHit[];
  onQuery: (value: string) => void;
  onMode: (mode: SearchMode) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  return (
    <section
      className="navigation-panel"
      aria-label={mode === 'content' ? 'Search document content' : 'Search document names'}
    >
      <label className="navigation-search-field">
        <WorkspaceIcon name="search" />
        <input
          aria-label={mode === 'content' ? 'Search Markdown content' : 'Search names and paths'}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={
            mode === 'content'
              ? 'Search inside Markdown documents…'
              : 'Search document names and paths…'
          }
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="navigation-search-modes" role="group" aria-label="Search mode">
        <button type="button" aria-pressed={mode === 'path'} onClick={() => onMode('path')}>
          Names and paths
        </button>
        <button type="button" aria-pressed={mode === 'content'} onClick={() => onMode('content')}>
          Markdown content
        </button>
      </div>
      <div className="navigation-result-summary" role="status">
        <span>{mode === 'content' ? 'Content matches' : 'Matching documents'}</span>
        <span>
          {hits.length}
          {feedback.hasMore ? '+' : ''}
        </span>
      </div>
      <ol
        className="navigation-results navigation-search-results"
        aria-label="Search results"
        aria-busy={feedback.pending}
      >
        {hits.map((hit, index) => (
          <li key={`${hit.path}:${hit.line ?? 0}:${hit.column ?? 0}:${index}`}>
            <button
              className="navigation-result"
              type="button"
              title={hit.path}
              onClick={() => onOpen(hit)}
            >
              <WorkspaceIcon name="document" />
              <span className="navigation-result-body">
                <ResultPath path={hit.path} />
                {hit.snippet ? (
                  <span className="navigation-result-snippet">{hit.snippet}</span>
                ) : null}
              </span>
              <span className="navigation-result-location">
                {hit.line !== null
                  ? `Line ${hit.line}${hit.column !== null ? `:${hit.column}` : ''}`
                  : hit.kind.toUpperCase()}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {!hits.length && !feedback.pending ? (
        <SearchEmptyState
          query={query}
          mode={mode}
          status={feedback.status}
          coverageIncomplete={feedback.coverageIncomplete}
        />
      ) : null}
      <SearchFeedback query={query} {...feedback} />
    </section>
  );
}

export function Favorites({
  paths,
  onOpen,
  onRemove,
  missing,
}: {
  paths: string[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  missing?: ReadonlySet<string>;
}) {
  return (
    <section className="navigation-panel" aria-label="Favorites">
      <div className="navigation-result-summary">
        <span>Saved locations</span>
        <span>{paths.length}</span>
      </div>
      <ul className="navigation-results navigation-favorites">
        {paths.map((path) => {
          const unavailable = missing?.has(path) ?? false;
          return (
            <li className="navigation-favorite" key={path}>
              <button
                className="navigation-result"
                type="button"
                disabled={unavailable}
                title={path}
                aria-label={
                  unavailable ? `${path} is unavailable; re-add or reopen it` : `Open ${path}`
                }
                onClick={() => onOpen(path)}
              >
                <WorkspaceIcon name={unavailable ? 'warning' : 'star'} />
                <ResultPath path={path} />
                {unavailable ? <span className="navigation-result-state">Unavailable</span> : null}
              </button>
              <button
                className="icon-button navigation-favorite-remove"
                type="button"
                title="Remove from favorites"
                aria-label={`Remove ${path} from favorites`}
                onClick={() => onRemove(path)}
              >
                <WorkspaceIcon name="close" />
              </button>
            </li>
          );
        })}
      </ul>
      {paths.some((path) => missing?.has(path)) ? (
        <p className="navigation-coverage" role="status">
          Unavailable favorites may have moved. Reopen or re-add the target to update its identity.
        </p>
      ) : null}
      {!paths.length ? (
        <div className="navigation-empty">
          <WorkspaceIcon name="star" />
          <strong>No favorites yet</strong>
          <p>Add a document or folder from its explorer menu to keep it here.</p>
        </div>
      ) : null}
    </section>
  );
}
