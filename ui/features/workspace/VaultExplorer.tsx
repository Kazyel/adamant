import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { ExplorerPage, IndexState, VaultEntry } from './types';

interface ExplorerProps {
  pages: ReadonlyMap<string, ExplorerPage>;
  indexing: IndexState;
  activePath: string | null;
  dirtyPath: string | null;
  disabled: boolean;
  onOpen: (entry: VaultEntry) => void;
  onToggleDirectory: (directory: string, open: boolean) => void;
  onLoadMore: (directory: string) => void;
}

type NavigableExplorerProps = ExplorerProps & {
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

function directoryMessages(directory: string, page: ExplorerPage, indexing: IndexState) {
  const state =
    indexing.state === 'ready' ? (page.indexing?.state ?? indexing.state) : indexing.state;
  let emptyMessage =
    'No supported files or folders yet. Create a Note or import a .md file to begin.';
  if (state !== 'ready') {
    emptyMessage = 'No entries indexed here yet. This does not mean the folder is empty.';
  } else if (directory) {
    emptyMessage = 'No supported files or folders here.';
  }
  let loadingMessage = 'Loading folder…';
  let retryLabel = 'folder';
  if (page.refreshing) {
    loadingMessage = 'Refreshing visible entries…';
    retryLabel = 'refresh';
  } else if (page.loaded) {
    loadingMessage = 'Loading next 100 entries…';
    retryLabel = 'next page';
  }

  return { emptyMessage, loadingMessage, retryLabel };
}

function DirectoryStatus({
  directory,
  page,
  indexing,
  onLoadMore,
  onNavigate,
}: {
  directory: string;
  page: ExplorerPage;
  indexing: IndexState;
  onLoadMore: ExplorerProps['onLoadMore'];
  onNavigate: NavigableExplorerProps['onNavigate'];
}) {
  const { emptyMessage, loadingMessage, retryLabel } = directoryMessages(directory, page, indexing);

  if (page.loaded && !page.error && page.entries.length > 0 && !page.hasMore) {
    return null;
  }

  return (
    <li className="explorer-page-status">
      {page.loading && !page.refreshing ? <p role="status">{loadingMessage}</p> : null}
      {page.error ? (
        <div role="alert">
          <p>Could not load this folder: {page.error}</p>
          <button type="button" onKeyDown={onNavigate} onClick={() => onLoadMore(directory)}>
            Retry {retryLabel}
          </button>
        </div>
      ) : null}
      {page.loaded && !page.loading && !page.error && page.entries.length === 0 ? (
        <p>{emptyMessage}</p>
      ) : null}
      {page.loaded && !page.error && page.hasMore ? (
        <button
          type="button"
          disabled={page.loading}
          onKeyDown={onNavigate}
          onClick={() => onLoadMore(directory)}
        >
          Load next 100
        </button>
      ) : null}
    </li>
  );
}

function ExplorerEntry({ entry, ...props }: NavigableExplorerProps & { entry: VaultEntry }) {
  const { pages, activePath, dirtyPath, disabled, onOpen, onToggleDirectory, onNavigate } = props;

  if (entry.kind === 'directory') {
    const open = pages.has(entry.path);

    return (
      <>
        <button
          className="explorer-directory"
          type="button"
          title={entry.path}
          data-directory={entry.path}
          aria-expanded={open}
          onKeyDown={onNavigate}
          onClick={() => onToggleDirectory(entry.path, !open)}
        >
          <WorkspaceIcon name="chevron" />
          <WorkspaceIcon name="folder" />
          <span>{entry.path.split('/').at(-1)}</span>
        </button>
        {open ? <Branches directory={entry.path} {...props} /> : null}
      </>
    );
  }

  return (
    <button
      className="explorer-file"
      type="button"
      title={entry.metadataError ? `${entry.path}\n${entry.metadataError}` : entry.path}
      disabled={disabled}
      aria-pressed={activePath === entry.path}
      onKeyDown={onNavigate}
      onClick={() => onOpen(entry)}
    >
      <WorkspaceIcon name="document" />
      <span>{entry.path.split('/').at(-1)}</span>
      {dirtyPath === entry.path ? (
        <span className="buffer-dot" aria-label="Unsaved changes" />
      ) : null}
      {entry.metadataError ? (
        <span className="entry-warning" aria-label="Metadata issue">
          <WorkspaceIcon name="warning" />
        </span>
      ) : null}
      {entry.kind !== 'markdown' ? <small>{entry.kind.toUpperCase()}</small> : null}
    </button>
  );
}

function Branches({ directory, ...props }: NavigableExplorerProps & { directory: string }) {
  const { pages, indexing, onLoadMore, onNavigate } = props;
  const page = pages.get(directory);

  if (!page) {
    return null;
  }

  return (
    <ul
      className="vault-tree-list"
      aria-label={directory || 'Vault files'}
      aria-busy={page.loading}
    >
      {page.entries.map((entry) => (
        <li key={entry.path}>
          <ExplorerEntry entry={entry} {...props} />
        </li>
      ))}
      <DirectoryStatus
        directory={directory}
        page={page}
        indexing={indexing}
        onLoadMore={onLoadMore}
        onNavigate={onNavigate}
      />
    </ul>
  );
}

function navigateDirectory(target: HTMLElement, key: string, props: ExplorerProps) {
  const directory = target.dataset.directory;

  if (directory && (key === 'ArrowRight' || props.pages.has(directory))) {
    props.onToggleDirectory(directory, key === 'ArrowRight');
  } else if (key === 'ArrowLeft') {
    const parent = target.closest('ul')?.parentElement;

    parent?.querySelector<HTMLButtonElement>(':scope > .explorer-directory')?.focus();
  }
}

export default function VaultExplorer(props: ExplorerProps) {
  const tree = useRef<HTMLDivElement>(null);

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }
    const target = event.currentTarget;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      navigateDirectory(target, event.key, props);
      event.preventDefault();
      return;
    }
    const controls = Array.from(
      tree.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ).filter((element) => element.getClientRects().length > 0);
    const index = controls.indexOf(target as HTMLButtonElement);
    let next = Math.max(
      0,
      Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = controls.length - 1;
    }
    controls[next]?.focus();
    event.preventDefault();
  }
  return (
    <div className="vault-tree" ref={tree} role="group" aria-label="Vault explorer">
      <Branches directory="" {...props} onNavigate={navigate} />
    </div>
  );
}
