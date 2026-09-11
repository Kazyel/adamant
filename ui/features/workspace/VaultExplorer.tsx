import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { ExplorerPage, IndexState, VaultEntry } from './types';

export interface ExplorerProps {
  pages: ReadonlyMap<string, ExplorerPage>;
  indexing: IndexState;
  activePath: string | null;
  dirtyPath: string | null;
  disabled: boolean;
  onOpen: (entry: VaultEntry) => void;
  onToggleDirectory: (directory: string, open: boolean) => void;
  onLoadMore: (directory: string) => void;
  selectedPaths?: ReadonlySet<string>;
  onSelectionChange?: (paths: ReadonlySet<string>) => void;
  onContextMenu?: (event: MouseEvent, entry?: VaultEntry) => void;
  onKeyboardContextMenu?: (entry: VaultEntry | undefined, target: HTMLElement) => void;
  onDrop?: (event: DragEvent, directory: string, sourcePaths: string[] | null) => void;
  onKeyCommand?: (key: 'copy' | 'cut' | 'paste' | 'delete') => void;
  renamePath?: string | null;
  onRename?: (entry: VaultEntry) => void;
  onRenameCommit?: (entry: VaultEntry, name: string) => void;
  onRenameCancel?: () => void;
}

type Props = ExplorerProps & {
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void;
  selectionAnchor?: string | null;
  onSelectionAnchorChange?: (path: string) => void;
};

function visibleEntries(pages: ReadonlyMap<string, ExplorerPage>) {
  const entries: VaultEntry[] = [];
  function visit(directory: string) {
    const page = pages.get(directory);
    if (!page) {
      return;
    }
    for (const entry of page.entries) {
      entries.push(entry);
      if (entry.kind === 'directory' && pages.has(entry.path)) {
        visit(entry.path);
      }
    }
  }
  visit('');
  return entries;
}

function EmptyFolder({ page, state }: { page: ExplorerPage; state: IndexState['state'] }) {
  if (!page.loaded || page.loading || page.error || page.entries.length) {
    return null;
  }
  return (
    <p>
      {state === 'ready'
        ? 'No supported files or folders here.'
        : 'No entries indexed here yet. This does not mean the folder is empty.'}
    </p>
  );
}

function Status({
  directory,
  page,
  indexing,
  onLoadMore,
  onNavigate,
}: {
  directory: string;
  page: ExplorerPage;
  indexing: IndexState;
  onLoadMore: (directory: string) => void;
  onNavigate: Props['onNavigate'];
}) {
  if (page.loaded && !page.error && page.entries.length && !page.hasMore) {
    return null;
  }
  const state =
    indexing.state === 'ready' ? (page.indexing?.state ?? indexing.state) : indexing.state;
  return (
    <li className="explorer-page-status" role="none">
      {page.loading && !page.loaded && !page.refreshing ? (
        <p>
          <LoadingIndicator label="Loading folder" />
        </p>
      ) : null}
      {page.error ? (
        <div role="alert">
          <p>Could not load this folder: {page.error}</p>
          <button
            type="button"
            role="treeitem"
            onKeyDown={onNavigate}
            onClick={() => onLoadMore(directory)}
          >
            Retry
          </button>
        </div>
      ) : null}
      <EmptyFolder page={page} state={state} />
      {page.hasMore ? (
        <button
          type="button"
          role="treeitem"
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

function InlineName({
  entry,
  onCommit,
  onCancel,
}: {
  entry: VaultEntry;
  onCommit: (entry: VaultEntry, name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(entry.path.split('/').at(-1) ?? entry.path);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    element?.focus();
    element?.select();
    return () => {
      if (document.activeElement !== element) {
        return;
      }
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) {
          return;
        }
        document
          .querySelector<HTMLElement>(`#explorer button[data-path="${CSS.escape(entry.path)}"]`)
          ?.focus();
      });
    };
  }, [entry.path]);
  return (
    <div className="explorer-inline-edit">
      <WorkspaceIcon name={entry.kind === 'directory' ? 'folder' : 'document'} />
      <input
        ref={input}
        value={value}
        aria-label={`Rename ${entry.path}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onCommit(entry, value);
          }
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
    </div>
  );
}

function Entry({ entry, ...props }: Props & { entry: VaultEntry }) {
  const {
    pages,
    activePath,
    dirtyPath,
    disabled,
    onOpen,
    onToggleDirectory,
    onNavigate,
    selectedPaths,
    onSelectionChange,
    onContextMenu,
    onKeyboardContextMenu,
    onRename,
    renamePath,
    onRenameCommit,
    onRenameCancel,
    selectionAnchor,
    onSelectionAnchorChange,
  } = props;
  const childrenId = useId();
  const selected = selectedPaths?.has(entry.path) ?? false;
  if (renamePath === entry.path && onRenameCommit && onRenameCancel) {
    return <InlineName entry={entry} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  }
  const select = (event: MouseEvent | KeyboardEvent) => {
    if (!onSelectionChange) {
      return;
    }
    const ordered = visibleEntries(pages);
    const index = ordered.findIndex((item) => item.path === entry.path);
    const anchor = selectionAnchor
      ? ordered.findIndex((item) => item.path === selectionAnchor)
      : -1;
    if (event.shiftKey && anchor >= 0 && index >= 0) {
      const [start, end] = anchor < index ? [anchor, index] : [index, anchor];
      onSelectionChange(new Set(ordered.slice(start, end + 1).map((item) => item.path)));
      return;
    }
    onSelectionAnchorChange?.(entry.path);
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedPaths ?? []);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([entry.path]));
    }
  };
  const dragStart = (event: DragEvent<HTMLElement>) => {
    if (disabled) {
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-adamant-selection', 'adamant-selection');
  };
  const common = {
    draggable: !disabled,
    onDragStart: dragStart,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'F2') {
        event.preventDefault();
        if (!disabled) {
          onRename?.(entry);
        }
        return;
      }
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        onKeyboardContextMenu?.(entry, event.currentTarget);
        return;
      }
      if (event.key === ' ' && onSelectionChange) {
        event.preventDefault();
        select(event);
        return;
      }
      onNavigate(event);
    },
    onContextMenu: (event: MouseEvent) => {
      event.stopPropagation();
      onContextMenu?.(event, entry);
    },
    onClick: (event: MouseEvent) => select(event),
  };
  if (entry.kind === 'directory') {
    const open = pages.has(entry.path);
    return (
      <>
        <button
          className="explorer-directory"
          type="button"
          title={entry.path}
          data-directory={entry.path}
          data-path={entry.path}
          role="treeitem"
          aria-owns={open ? childrenId : undefined}
          aria-expanded={open}
          aria-selected={selected}
          {...common}
          onClick={(event) => {
            common.onClick(event);
            onToggleDirectory(entry.path, !open);
          }}
        >
          <WorkspaceIcon name="chevron" />
          <WorkspaceIcon name="folder" />
          <span>{entry.path.split('/').at(-1)}</span>
        </button>
        {open ? <Branches id={childrenId} directory={entry.path} {...props} /> : null}
      </>
    );
  }
  return (
    <button
      className="explorer-file"
      type="button"
      title={entry.metadataError ? `${entry.path}\n${entry.metadataError}` : entry.path}
      data-path={entry.path}
      disabled={disabled}
      role="treeitem"
      aria-selected={selected}
      aria-current={activePath === entry.path ? 'page' : undefined}
      {...common}
      onClick={(event) => {
        common.onClick(event);
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
          onOpen(entry);
        }
      }}
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

function Branches({ directory, id, ...props }: Props & { directory: string; id?: string }) {
  const { pages, indexing, onLoadMore, onNavigate } = props;
  const page = pages.get(directory);
  if (!page) {
    return null;
  }
  return (
    <ul
      className="vault-tree-list"
      id={id}
      role={directory ? 'group' : 'none'}
      aria-label={directory || undefined}
      aria-busy={page.loading}
      data-drop-directory={directory}
    >
      {page.entries.map((entry) => (
        <li key={entry.path} role="none">
          <Entry entry={entry} {...props} />
        </li>
      ))}
      <Status
        directory={directory}
        page={page}
        indexing={indexing}
        onLoadMore={onLoadMore}
        onNavigate={onNavigate}
      />
    </ul>
  );
}

function moveFocus(target: HTMLElement, key: string, props: ExplorerProps) {
  const directory = target.dataset.directory;
  const open = directory ? props.pages.has(directory) : false;
  if (key === 'ArrowRight') {
    if (!directory) {
      return;
    }
    if (!open) {
      props.onToggleDirectory(directory, true);
    } else {
      target.nextElementSibling
        ?.querySelector<HTMLButtonElement>('button[data-path]:not(:disabled)')
        ?.focus();
    }
    return;
  }
  if (directory && open) {
    props.onToggleDirectory(directory, false);
    return;
  }
  target
    .closest('ul')
    ?.parentElement?.querySelector<HTMLButtonElement>(':scope > .explorer-directory')
    ?.focus();
}

const navigationKeys: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  Home: true,
  End: true,
  ArrowLeft: true,
  ArrowRight: true,
};

function nextControlIndex(key: string, index: number, count: number) {
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return count - 1;
  }
  return Math.max(0, Math.min(count - 1, index + (key === 'ArrowUp' ? -1 : 1)));
}

function dropTarget(target: EventTarget, tree: HTMLElement) {
  const element = target instanceof HTMLElement ? target : tree;
  const row = element.closest<HTMLElement>('[data-path]');
  if (row) {
    return {
      element: row,
      directory: row.dataset.directory ?? row.dataset.path?.split('/').slice(0, -1).join('/') ?? '',
    };
  }
  const list = element.closest<HTMLElement>('[data-drop-directory]');
  return { element: list ?? tree, directory: list?.dataset.dropDirectory ?? '' };
}

export default function VaultExplorer(props: ExplorerProps) {
  const tree = useRef<HTMLDivElement>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const ordered = useMemo(() => visibleEntries(props.pages), [props.pages]);
  const highlight = useRef<HTMLElement | null>(null);
  function clearDropHighlight() {
    if (!highlight.current) {
      return;
    }
    delete highlight.current.dataset.dropTarget;
    delete highlight.current.dataset.dropInvalid;
    highlight.current = null;
  }
  function selectRange(target: HTMLElement, next: HTMLElement) {
    if (!target.dataset.path || !next.dataset.path) {
      return;
    }
    const storedAnchor = ordered.findIndex((entry) => entry.path === selectionAnchor);
    const start =
      storedAnchor < 0
        ? ordered.findIndex((entry) => entry.path === target.dataset.path)
        : storedAnchor;
    const end = ordered.findIndex((entry) => entry.path === next.dataset.path);
    if (start < 0 || end < 0) {
      return;
    }
    setSelectionAnchor(ordered[start].path);
    props.onSelectionChange?.(
      new Set(
        ordered.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => entry.path),
      ),
    );
  }
  function selectFocused(event: KeyboardEvent, target: Element | null) {
    if (event.ctrlKey || event.metaKey) {
      return;
    }
    if (!(target instanceof HTMLElement) || !target.dataset.path) {
      return;
    }
    setSelectionAnchor(target.dataset.path);
    props.onSelectionChange?.(new Set([target.dataset.path]));
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (!navigationKeys[event.key]) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      moveFocus(target, event.key, props);
      selectFocused(event, document.activeElement);
      return;
    }
    const controls = Array.from(
      tree.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-path]:not(:disabled), .explorer-page-status button:not(:disabled)',
      ) ?? [],
    ).filter((element) => element.getClientRects().length);
    const next = controls[nextControlIndex(event.key, controls.indexOf(target), controls.length)];
    if (!next) {
      return;
    }
    next.focus();
    if (event.shiftKey) {
      selectRange(target, next);
    } else {
      selectFocused(event, next);
    }
  }
  const dragAwareProps: Props = {
    ...props,
    onNavigate: navigate,
    selectionAnchor,
    onSelectionAnchorChange: setSelectionAnchor,
  };
  function command(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) {
      return;
    }
    if (target === event.currentTarget) {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        props.onKeyboardContextMenu?.(undefined, target);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'Home') {
        const first = event.currentTarget.querySelector<HTMLButtonElement>(
          'button[data-path]:not(:disabled)',
        );
        first?.focus();
        selectFocused(event, first);
        event.preventDefault();
        return;
      }
    }
    if (!(event.ctrlKey || event.metaKey) && event.key !== 'Delete') {
      return;
    }
    const commandKey = ({ c: 'copy', x: 'cut', v: 'paste', delete: 'delete' } as const)[
      event.key.toLowerCase() as 'c' | 'x' | 'v' | 'delete'
    ];
    if (!commandKey) {
      return;
    }
    event.preventDefault();
    props.onKeyCommand?.(commandKey);
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    clearDropHighlight();
    const internal = event.dataTransfer.types.includes('application/x-adamant-selection');
    if (!internal && !event.dataTransfer.types.includes('Files')) {
      return;
    }
    const target = dropTarget(event.target, event.currentTarget);
    const invalid =
      props.disabled ||
      !!dragPaths?.some(
        (source) => source === target.directory || target.directory.startsWith(`${source}/`),
      );
    highlight.current = target.element;
    if (invalid) {
      target.element.dataset.dropInvalid = 'true';
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    target.element.dataset.dropTarget = 'true';
    event.preventDefault();
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    clearDropHighlight();
    const target = dropTarget(event.target, event.currentTarget);
    const internal = event.dataTransfer.types.includes('application/x-adamant-selection');
    const accepted = internal || event.dataTransfer.types.includes('Files');
    if (!props.disabled && accepted) {
      props.onDrop?.(event, target.directory, internal ? dragPaths : null);
    }
    setDragPaths(null);
  }
  return (
    <div
      ref={tree}
      className="vault-tree"
      role="tree"
      tabIndex={0}
      aria-label="Vault files"
      data-drop-directory=""
      aria-multiselectable={!!props.onSelectionChange}
      onKeyDown={command}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, input')) {
          return;
        }
        setSelectionAnchor(null);
        props.onSelectionChange?.(new Set());
        event.currentTarget.focus();
      }}
      onContextMenu={(event) => {
        if (!(event.target as HTMLElement).closest('[data-path]')) {
          setSelectionAnchor(null);
          props.onContextMenu?.(event);
        }
      }}
      onDragOver={dragOver}
      onDragLeave={clearDropHighlight}
      onDrop={drop}
      onDragEnd={() => {
        clearDropHighlight();
        setDragPaths(null);
      }}
      onDragStart={(event) => {
        const path = (event.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset
          .path;
        if (!path) {
          setDragPaths(null);
        } else {
          setDragPaths(props.selectedPaths?.has(path) ? [...props.selectedPaths] : [path]);
        }
      }}
    >
      <Branches directory="" {...dragAwareProps} />
      {!ordered.length && !props.pages.get('')?.loading ? (
        <p className="explorer-empty-state">No entries loaded.</p>
      ) : null}
    </div>
  );
}
