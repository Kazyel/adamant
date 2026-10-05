import SearchField from '../../shared/ui/SearchField';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { SearchHit, SearchMode, SearchPage } from './navigationTypes';
import './navigation.css';
import { quickOpenItems } from './quickOpen';
import type { QuickOpenItem } from './quickOpen';

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
        data-tooltip={vaultName}
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
              data-tooltip={target}
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
  filtered?: boolean;
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
  if (!props.query.trim() && !props.filtered) {
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
  filtered,
}: Pick<SearchFeedbackProps, 'query' | 'status' | 'coverageIncomplete' | 'filtered'> & {
  mode: SearchMode | 'recent';
}) {
  let title = 'No matches found';
  let description = 'Try a different search.';
  if (!query.trim() && !filtered) {
    title = 'Search your Vault';
    description = 'Find Markdown, PDF and DOCX documents by their name or location.';
    if (mode === 'recent') {
      title = 'No recent documents';
      description = 'Open a document from the explorer, or search this Vault above.';
    } else if (mode === 'content') {
      description = 'Find text in Markdown notes and extracted PDF and DOCX content.';
    }
  } else {
    if (status && status.state !== 'ready') {
      title = 'No results yet';
    }
    if (filtered) {
      description = 'Try removing a filter or changing your search.';
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

function highlightedText(value: string, query: string) {
  const term = query.trim();
  const index = term ? value.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1;
  if (index < 0) {
    return value;
  }
  return (
    <>
      {value.slice(0, index)}
      <mark>{value.slice(index, index + term.length)}</mark>
      {value.slice(index + term.length)}
    </>
  );
}

function quickOpenStatus(item: QuickOpenItem, activeId: string | null, unavailable: boolean) {
  if (item.kind === 'path') {
    return unavailable ? 'Unavailable' : '';
  }
  if (item.dirty) {
    return 'Unsaved';
  }
  return item.tabId === activeId ? 'Active' : 'Open';
}

type QuickOpenProps = SearchFeedbackProps & {
  onQuery: (value: string) => void;
  recent: string[];
  onOpen: (item: QuickOpenItem) => void;
  openTabs: Parameters<typeof quickOpenItems>[0];
  activeId: string | null;
  items?: string[];
  missing?: ReadonlySet<string>;
};

export function QuickOpen({
  query,
  onQuery,
  recent,
  onOpen,
  openTabs,
  activeId,
  items,
  missing,
  ...feedback
}: QuickOpenProps) {
  const searching = !!query.trim();
  const candidates = searching ? (items ?? recent) : recent;
  const shown = quickOpenItems(openTabs, candidates, query);
  const [selection, setSelection] = useState<{ query: string; key: string | null }>({
    query,
    key: null,
  });
  const selected = Math.max(
    0,
    shown.findIndex((item) => item.key === (selection.query === query ? selection.key : null)),
  );
  const unavailable = (item: QuickOpenItem) => item.kind === 'path' && missing?.has(item.path);
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
      setSelection({ query, key: shown[Math.min(selected + 1, shown.length - 1)].key });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelection({ query, key: shown[Math.max(selected - 1, 0)].key });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!unavailable(shown[selected])) {
        onOpen(shown[selected]);
      }
    }
  }

  return (
    <section className="navigation-panel" aria-label="Quick open">
      <SearchField
        className="navigation-search-field"
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
      <div className="navigation-result-summary">
        <span>{searching ? 'Matching documents' : 'Open and recent documents'}</span>
        <span>
          {shown.length}
          {feedback.hasMore && searching ? '+' : ''}
        </span>
      </div>
      <div
        className="navigation-results"
        id={listId}
        role="listbox"
        aria-label={searching ? 'Matching documents' : 'Open and recent documents'}
        aria-busy={feedback.pending}
      >
        {shown.map((item, index) => (
          <button
            className="navigation-result"
            id={`${listId}-${index}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            disabled={unavailable(item)}
            key={item.key}
            data-tooltip={item.path || item.name}
            onMouseEnter={() => setSelection({ query, key: item.key })}
            onClick={() => onOpen(item)}
          >
            <WorkspaceIcon name={unavailable(item) ? 'warning' : 'document'} />
            <span className="navigation-result-copy">
              <span className="navigation-result-name">{item.name}</span>
              <span className="navigation-result-path">{item.path || 'New document'}</span>
            </span>
            <span className="navigation-result-state">
              {quickOpenStatus(item, activeId, !!unavailable(item))}
            </span>
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
      {shown.some(unavailable) ? (
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
  filters,
  onQuery,
  onMode,
  onOpen,
  ...feedback
}: SearchFeedbackProps & {
  mode: SearchMode;
  filters?: ReactNode;
  hits: SearchHit[];
  onQuery: (value: string) => void;
  onMode: (mode: SearchMode) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLOListElement>(null);

  function moveResultFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) {
      input.current?.focus();
    } else {
      results.current?.querySelectorAll<HTMLButtonElement>('.navigation-result')[next]?.focus();
    }
  }

  return (
    <section
      className="navigation-panel navigation-search-panel"
      aria-label={mode === 'content' ? 'Search document content' : 'Search document names'}
    >
      <div className="navigation-search-controls">
        <SearchField
          ref={input}
          className="navigation-search-field"
          aria-label={mode === 'content' ? 'Search document content' : 'Search names and paths'}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && hits.length) {
              event.preventDefault();
              results.current?.querySelector<HTMLButtonElement>('.navigation-result')?.focus();
            }
          }}
          placeholder={
            mode === 'content'
              ? 'Search inside Markdown, PDF and DOCX…'
              : 'Search document names and paths…'
          }
          autoComplete="off"
          spellCheck={false}
        />
        <div className="navigation-search-toolbar">
          <div className="navigation-search-modes" role="group" aria-label="Search mode">
            <button type="button" aria-pressed={mode === 'path'} onClick={() => onMode('path')}>
              Names and paths
            </button>
            <button
              type="button"
              aria-pressed={mode === 'content'}
              onClick={() => onMode('content')}
            >
              Document content
            </button>
          </div>
          {filters}
        </div>
      </div>
      <div className="navigation-result-summary" role="status">
        <strong>Results</strong>
        <span>
          {hits.length}
          {feedback.hasMore ? '+' : ''}
          {hits.length === 1 ? ' match' : ' matches'}
        </span>
      </div>
      <ol
        ref={results}
        className="navigation-results navigation-search-results"
        aria-label="Search results"
        aria-busy={feedback.pending}
      >
        {hits.map((hit, index) => (
          <li key={`${hit.path}:${hit.line ?? 0}:${hit.column ?? 0}:${index}`}>
            <button
              className="navigation-result"
              type="button"
              data-tooltip={hit.path}
              onClick={() => onOpen(hit)}
              onKeyDown={(event) => moveResultFocus(event, index)}
            >
              <span className="navigation-result-icon" data-kind={hit.kind}>
                <WorkspaceIcon name="document" />
              </span>
              <span className="navigation-result-body">
                <span className="navigation-result-heading">
                  <span className="navigation-result-name">
                    {highlightedText(hit.path.split('/').filter(Boolean).at(-1) || 'Vault', query)}
                  </span>
                  <span className="navigation-result-location">
                    {mode === 'content' && hit.kind !== 'markdown'
                      ? documentHitLocation(hit)
                      : null}
                    {hit.line !== null
                      ? `Line ${hit.line}${hit.column !== null ? `:${hit.column}` : ''}`
                      : null}
                    {mode === 'path' && hit.line === null ? hit.kind.toUpperCase() : null}
                  </span>
                </span>
                <span className="navigation-result-path">{highlightedText(hit.path, query)}</span>
                {hit.snippet ? (
                  <span className="navigation-result-snippet">
                    {highlightedText(hit.snippet, query)}
                  </span>
                ) : null}
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
          filtered={feedback.filtered}
        />
      ) : null}
      <SearchFeedback query={query} {...feedback} />
      <div className="navigation-key-hints navigation-search-key-hints" aria-hidden="true">
        {hits.length ? (
          <>
            <span>
              <kbd>↓</kbd> Results
            </span>
            <span>
              <kbd>Enter</kbd> Open
            </span>
          </>
        ) : null}
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </div>
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
                data-tooltip={path}
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
                data-tooltip="Remove from favorites"
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

function documentHitLocation(hit: SearchHit) {
  return hit.page ? `Page ${hit.page}` : 'Extracted text';
}
