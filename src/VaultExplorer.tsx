import type { KeyboardEvent } from 'react';
import WorkspaceIcon from './WorkspaceIcon';
import type { ExplorerPage, IndexState, VaultEntry } from './useWorkspace';

export interface ExplorerProps {
  pages: ReadonlyMap<string, ExplorerPage>;
  indexing: IndexState;
  activePath: string | null;
  dirtyPath: string | null;
  disabled: boolean;
  onOpen: (entry: VaultEntry) => void;
  onToggleDirectory: (directory: string, open: boolean) => void;
  onLoadMore: (directory: string) => void;
}

function Branches({ directory, ...props }: ExplorerProps & { directory: string }) {
  const { pages, indexing, activePath, dirtyPath, disabled, onOpen, onToggleDirectory, onLoadMore } = props;
  const page = pages.get(directory);
  if (!page) return null;
  const state = indexing.state === 'ready' ? page.indexing?.state ?? indexing.state : indexing.state;
  let emptyMessage = 'No supported files or folders yet. Create a Note or import a .md file to begin.';
  if (state !== 'ready') emptyMessage = 'No entries indexed here yet. This does not mean the folder is empty.';
  else if (directory) emptyMessage = 'No supported files or folders here.';
  let loadingMessage = 'Loading folder…';
  let retryLabel = 'folder';
  if (page.refreshing) {
    loadingMessage = 'Refreshing visible entries…';
    retryLabel = 'refresh';
  } else if (page.loaded) {
    loadingMessage = 'Loading next 100 entries…';
    retryLabel = 'next page';
  }
  return <ul className="vault-tree-list" aria-label={directory || 'Vault files'} aria-busy={page.loading}>
    {page.entries.map((entry) => <li key={entry.path}>
      {entry.kind === 'directory' ? <>
        <button className="explorer-directory" type="button" title={entry.path} data-directory={entry.path} aria-expanded={pages.has(entry.path)} onClick={() => onToggleDirectory(entry.path, !pages.has(entry.path))}>
          <WorkspaceIcon name="chevron" /><WorkspaceIcon name="folder" /><span>{entry.path.split('/').at(-1)}</span>
        </button>
        {pages.has(entry.path) ? <Branches directory={entry.path} {...props} /> : null}
      </> : <button className="explorer-file" type="button" title={entry.metadataError ? `${entry.path}\n${entry.metadataError}` : entry.path} disabled={disabled} aria-pressed={activePath === entry.path} onClick={() => onOpen(entry)}>
        <WorkspaceIcon name="document" /><span>{entry.path.split('/').at(-1)}</span>
        {dirtyPath === entry.path ? <span className="buffer-dot" aria-label="Unsaved changes" /> : null}
        {entry.metadataError ? <span className="entry-warning" aria-label="Metadata issue"><WorkspaceIcon name="warning" /></span> : null}
        {entry.kind !== 'markdown' ? <small>{entry.kind.toUpperCase()}</small> : null}
      </button>}
    </li>)}
    {!page.loaded || page.error || page.entries.length === 0 || page.hasMore ? <li className="explorer-page-status">
      {page.loading && !page.refreshing ? <p role="status">{loadingMessage}</p> : null}
      {page.error ? <div role="alert"><p>Could not load this folder: {page.error}</p><button type="button" onClick={() => onLoadMore(directory)}>Retry {retryLabel}</button></div> : null}
      {page.loaded && !page.loading && !page.error && page.entries.length === 0 ? <p>{emptyMessage}</p> : null}
      {page.loaded && !page.error && page.hasMore ? <button type="button" disabled={page.loading} onClick={() => onLoadMore(directory)}>Load next 100</button> : null}
    </li> : null}
  </ul>;
}

export default function VaultExplorer(props: ExplorerProps) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches('button')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const directory = target.dataset.directory;
      if (directory && (event.key === 'ArrowRight' || props.pages.has(directory))) {
        props.onToggleDirectory(directory, event.key === 'ArrowRight');
      } else if (event.key === 'ArrowLeft') {
        const parent = target.closest('ul')?.parentElement;
        parent?.querySelector<HTMLButtonElement>(':scope > .explorer-directory')?.focus();
      }
      event.preventDefault();
      return;
    }
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter((element) => element.getClientRects().length > 0);
    const index = controls.indexOf(target as HTMLButtonElement);
    let next = Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = controls.length - 1;
    controls[next]?.focus();
    event.preventDefault();
  }
  return <div className="vault-tree" onKeyDown={navigate}><Branches directory="" {...props} /></div>;
}
