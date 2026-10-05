import SearchField from '../../shared/ui/SearchField';
import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from '../interaction/InteractionDialogs';
import SelectField from '../interaction/SelectField';
import DocumentFilters from '../navigation/DocumentFilters';
import {
  emptyDocumentFilters,
  hasDocumentFilters,
  type DocumentFiltersState,
} from '../navigation/documentFilters';
import { OverlayPresence } from '../interaction/OverlayPresence';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { Workspace } from '../workspace/workspaceTypes';
import type { GraphNode, GraphSnapshot } from './graphTypes';
import GraphCanvas from './GraphCanvas';
import { layoutGraph } from './graphLayout';
import useGraph from './useGraph';
import { projectGraph, type LocalGraph } from './graphProjection';
import {
  graphConnections,
  connectionOrigins,
  removeManualConnection,
  type GraphConnection,
} from './graphConnections';

function name(path: string) {
  return path.split('/').at(-1) ?? path;
}

function FileList({
  nodes,
  selected,
  onSelect,
}: {
  nodes: GraphNode[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return nodes.length ? (
    <ul className="graph-file-list">
      {nodes.slice(0, 80).map((node) => (
        <li key={node.key}>
          <button
            type="button"
            aria-pressed={selected === node.key}
            onClick={() => onSelect(node.key)}
            data-tooltip={node.path}
          >
            <span className="graph-file-emblem" data-kind={node.kind}>
              <WorkspaceIcon name="document" />
            </span>
            <span className="graph-file-label">
              <strong>{name(node.path)}</strong>
              <small>
                {node.path.includes('/')
                  ? node.path.slice(0, node.path.lastIndexOf('/'))
                  : 'Vault root'}
              </small>
            </span>
            {node.problem ? (
              <WorkspaceIcon name="warning" />
            ) : (
              <span className="graph-file-kind">
                {node.kind === 'markdown' ? 'MD' : node.kind.toUpperCase()}
              </span>
            )}
          </button>
        </li>
      ))}
      {nodes.length > 80 ? (
        <li className="graph-list-limit">Showing 80 of {nodes.length}. Refine your search.</li>
      ) : null}
    </ul>
  ) : (
    <p className="graph-empty-list">No matching files.</p>
  );
}

function Selection({
  node,
  connections,
  inspectorId,
  inspectedNode,
  message,
  disabled,
  connecting,
  onOpen,
  onConnect,
  onShowConnections,
}: {
  node: GraphNode;
  connections: GraphConnection[];
  inspectorId: string;
  inspectedNode: GraphNode | undefined;
  message: string;
  disabled: boolean;
  connecting: boolean;
  onOpen: (key: string) => void;
  onConnect: () => void;
  onShowConnections: () => void;
}) {
  const connectionCount = connections.filter(
    (edge) => edge.source === node.key || edge.target === node.key,
  ).length;
  const folder = node.path.includes('/')
    ? node.path.slice(0, node.path.lastIndexOf('/'))
    : 'Vault root';
  return (
    <>
      <div className="graph-selection">
        <div className="graph-selection-header">
          <div className="graph-selection-kind">
            <span className="graph-selection-emblem" data-kind={node.kind}>
              <WorkspaceIcon name="document" />
            </span>
            {node.kind === 'markdown' ? 'Markdown note' : `${node.kind.toUpperCase()} document`}
          </div>
          <div className="graph-file-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="Open file"
              data-tooltip="Open file"
              disabled={!node.identity || disabled}
              onClick={() => onOpen(node.key)}
            >
              <WorkspaceIcon name="external" />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={disabled}
              aria-label={connecting ? 'Cancel connection' : 'Connect file'}
              data-tooltip={connecting ? 'Cancel connection' : 'Connect file'}
              aria-pressed={connecting}
              onClick={onConnect}
            >
              <WorkspaceIcon name={connecting ? 'close' : 'link'} />
            </button>
          </div>
        </div>
        <h2 data-tooltip={name(node.path)}>
          {name(node.path)
            .split(/(?<=[_-])/)
            .map((part, index) => (
              <Fragment key={index}>
                {part}
                <wbr />
              </Fragment>
            ))}
        </h2>
        <p className="graph-selected-path" data-tooltip={node.path}>
          {folder}
        </p>
        {node.problem ? <p className="graph-problem">{node.problem}</p> : null}
        <button
          type="button"
          className="graph-connections-trigger"
          aria-label={`Connections for ${name(node.path)} (${connectionCount})`}
          aria-expanded={inspectedNode?.key === node.key}
          aria-controls={inspectorId}
          onClick={onShowConnections}
        >
          <span>Connections</span>
          <span className="graph-connection-count">{connectionCount}</span>
          <WorkspaceIcon name="chevron" />
        </button>
      </div>
      {connecting ? (
        <p className="graph-connect-prompt" role="status">
          Choose another node in the graph or a file in the sidebar.
        </p>
      ) : null}
      {message && !inspectedNode ? (
        <p className="graph-feedback" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
}

type GraphInspector = { kind: 'files' } | { kind: 'connections'; key: string };

function ConnectionsPanel({
  node,
  nodes,
  connections,
  disabled,
  message,
  onOpen,
  onDisconnect,
}: {
  node: GraphNode;
  nodes: Map<string, GraphNode>;
  connections: GraphConnection[];
  disabled: boolean;
  message: string;
  onOpen: (key: string) => void;
  onDisconnect: (connection: GraphConnection) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [query, setQuery] = useState('');
  const [visibleConnections, setVisibleConnections] = useState(20);
  const linked = connections.filter((edge) => edge.source === node.key || edge.target === node.key);
  const search = query.trim().toLocaleLowerCase();
  const filtered = linked.filter((connection) => {
    const target = nodes.get(
      connection.source === node.key ? connection.target : connection.source,
    );
    return target?.path.toLocaleLowerCase().includes(search);
  });
  return (
    <div className="graph-connections-panel">
      <div className="graph-connections-context">
        <span className="graph-selection-emblem graph-connection-emblem" data-kind={node.kind}>
          <WorkspaceIcon name="document" />
        </span>
        <div>
          <h3 ref={heading} tabIndex={-1} data-tooltip={node.path} data-sidebar-focus>
            {name(node.path)}
          </h3>
          <p>
            {node.path.includes('/')
              ? node.path.slice(0, node.path.lastIndexOf('/'))
              : 'Vault root'}
          </p>
        </div>
      </div>
      <div className="graph-tools">
        <SearchField
          aria-label="Find a connected file"
          placeholder="Find a connection…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleConnections(20);
          }}
        />
      </div>
      <div className="graph-results-heading">
        <span className="graph-result-count" role="status">
          {search ? `${filtered.length} of ${linked.length}` : linked.length} connections
        </span>
      </div>
      {filtered.length ? (
        <ul className="graph-connection-list" aria-label="Connected files and link origins">
          {filtered.slice(0, visibleConnections).map((connection) => {
            const target = nodes.get(
              connection.source === node.key ? connection.target : connection.source,
            )!;
            return (
              <li key={connection.id} className="graph-connection-row">
                <button
                  type="button"
                  className="graph-connection-open"
                  disabled={disabled || !target.identity}
                  onClick={() => onOpen(target.key)}
                  data-tooltip={target.path}
                >
                  <span
                    className="graph-selection-emblem graph-connection-emblem"
                    data-kind={target.kind}
                  >
                    <WorkspaceIcon name="document" />
                  </span>
                  <span className="graph-connection-label">
                    <strong>{name(target.path)}</strong>
                    <small>{connectionOrigins(connection, node.key)}</small>
                  </span>
                </button>
                {connection.manual ? (
                  <button
                    type="button"
                    className="icon-button graph-connection-remove"
                    disabled={disabled}
                    aria-label={`Remove manual connection to ${target.path}`}
                    data-tooltip="Remove manual connection"
                    onClick={() => {
                      heading.current?.focus();
                      onDisconnect(connection);
                    }}
                  >
                    <WorkspaceIcon name="trash" />
                  </button>
                ) : null}
              </li>
            );
          })}
          {filtered.length > visibleConnections ? (
            <li>
              <button
                type="button"
                className="graph-connections-more"
                onClick={() => setVisibleConnections((count) => count + 20)}
              >
                Show more connections ({filtered.length - visibleConnections} remaining)
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="graph-empty-list">
          {linked.length ? 'No connections match your search.' : 'No connections yet.'}
        </p>
      )}
      {message ? (
        <p className="graph-connections-feedback graph-feedback" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function GraphSidebar({
  inspector,
  inspectorId,
  inspectedNode,
  nodes,
  connections,
  disabled,
  message,
  onOpen,
  onDisconnect,
  onClose,
  onInspect,
  children,
}: {
  inspector: GraphInspector | null;
  inspectorId: string;
  inspectedNode: GraphNode | undefined;
  nodes: Map<string, GraphNode>;
  connections: GraphConnection[];
  disabled: boolean;
  message: string;
  onOpen: (key: string) => void;
  onDisconnect: (connection: GraphConnection) => void;
  onClose: () => void;
  onInspect: (inspector: GraphInspector) => void;
  children: ReactNode;
}) {
  const sidebar = useRef<HTMLElement>(null);
  const focusTarget = inspectedNode ? `connections:${inspectedNode.key}` : inspector?.kind;
  useEffect(() => {
    if (inspector) {
      sidebar.current?.querySelector<HTMLElement>('[data-sidebar-focus]')?.focus();
    }
  }, [inspector, focusTarget]);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const element = sidebar.current;
    if (!element) {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    element.addEventListener('keydown', key);
    return () => element.removeEventListener('keydown', key);
  }, []);
  return (
    <aside
      id={inspectorId}
      ref={sidebar}
      hidden={!inspector}
      className="graph-inspector"
      aria-label={inspectedNode ? `Connections for ${name(inspectedNode.path)}` : 'Graph files'}
    >
      <header className="graph-inspector-heading">
        {inspectedNode ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Back to graph files"
            data-tooltip="Back to files"
            onClick={() => onInspect({ kind: 'files' })}
          >
            <WorkspaceIcon name="back" />
          </button>
        ) : null}
        <h2>{inspectedNode ? 'Connections' : 'Files'}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close graph sidebar"
          data-tooltip="Close sidebar"
          onClick={onClose}
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      {inspectedNode ? (
        <ConnectionsPanel
          key={inspectedNode.key}
          node={inspectedNode}
          nodes={nodes}
          connections={connections}
          disabled={disabled}
          message={message}
          onOpen={onOpen}
          onDisconnect={onDisconnect}
        />
      ) : (
        <>{children}</>
      )}
    </aside>
  );
}

function LocalGraphControls({
  local,
  root,
  selected,
  onChange,
}: {
  local: LocalGraph;
  root: GraphNode | undefined;
  selected: string | null;
  onChange: (local: LocalGraph) => void;
}) {
  return (
    <div className="graph-local-controls">
      <div className="graph-local-center">
        <span>
          <small>Centered on</small>
          <strong data-tooltip={root?.path}>
            {root?.identity ? name(root.path) : 'No document selected'}
          </strong>
        </span>
        {selected && selected !== local.root ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Center local graph on selected file"
            data-tooltip="Center local graph on selected file"
            onClick={() => {
              onChange({ ...local, root: selected });
            }}
          >
            <WorkspaceIcon name="connections" />
          </button>
        ) : null}
      </div>
      {!root?.identity ? (
        <p className="graph-local-hint">
          Open a Vault document or return to the global graph to choose a file.
        </p>
      ) : null}
      <SelectField
        aria-label="Local graph depth"
        value={local.depth}
        onChange={(event) => {
          onChange({ ...local, depth: event.target.value === '2' ? 2 : 1 });
        }}
      >
        <option value="1">Direct connections</option>
        <option value="2">Up to two connections away</option>
      </SelectField>
    </div>
  );
}

function GraphContent({
  active: visible,
  snapshot,
  connections,
  workspace,
  edit,
  onOpen,
  inspector,
  inspectorId,
  onCloseInspector,
  onInspect,
  selected,
  onSelect,
  local,
  onLocalChange,
}: {
  active: boolean;
  snapshot: GraphSnapshot;
  connections: GraphConnection[];
  workspace: Workspace;
  inspector: GraphInspector | null;
  inspectorId: string;
  onCloseInspector: () => void;
  onInspect: (inspector: GraphInspector) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  local: LocalGraph | null;
  onLocalChange: (local: LocalGraph | null) => void;
  edit: (transform: (snapshot: GraphSnapshot) => GraphSnapshot) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<DocumentFiltersState>(emptyDocumentFilters);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState('');
  const nodes = useMemo(
    () => new Map(snapshot.nodes.map((node) => [node.key, node])),
    [snapshot.nodes],
  );
  // Markdown links connect the existing layout without rearranging files after a note save.
  const points = useMemo(
    () => layoutGraph(snapshot.nodes, snapshot.edges),
    [snapshot.nodes, snapshot.edges],
  );
  const projection = useMemo(
    () => projectGraph(snapshot.nodes, connections, filters, query, local),
    [snapshot.nodes, connections, filters, query, local],
  );
  const visiblePoints = useMemo(
    () => points.filter((point) => projection.keys.has(point.node.key)),
    [points, projection.keys],
  );
  const filterOptions = useMemo(() => {
    const directories = new Set<string>();
    const tags = new Set<string>();
    for (const node of snapshot.nodes) {
      for (const tag of node.tags) {
        tags.add(tag);
      }
      const parts = node.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        directories.add(parts.slice(0, index).join('/'));
      }
    }
    return { directories: [...directories].sort(), tags: [...tags].sort() };
  }, [snapshot.nodes]);
  const inspectedNode = inspector?.kind === 'connections' ? nodes.get(inspector.key) : undefined;
  const active = projection.nodes.find((node) => node.key === selected);
  const selection = active?.key ?? null;
  const localRoot = local?.root ? nodes.get(local.root) : undefined;
  const disabled = !!workspace.busy;
  const filterCount =
    filters.tags.length + Number(!!filters.directory) + Number(filters.kinds.length > 0);

  function clearSelection() {
    onSelect(null);
    setDetailsOpen(false);
    setConnecting(false);
    setMessage('');
  }

  function updateGraph(transform: (snapshot: GraphSnapshot) => GraphSnapshot) {
    const positions = new Map(points.map((point) => [point.node.key, point]));
    edit((current) =>
      transform({
        ...current,
        nodes: current.nodes.map((node) => {
          const point = positions.get(node.key);
          return node.x === null && point ? { ...node, x: point.x, y: point.y } : node;
        }),
      }),
    );
  }

  function connect(source: string, target: string) {
    if (disabled) {
      return;
    }
    if (source === target) {
      setMessage('Choose a different file.');
      return;
    }
    if (
      snapshot.edges.some(
        (edge) =>
          (edge.source === source && edge.target === target) ||
          (edge.target === source && edge.source === target),
      )
    ) {
      setMessage('These files are already connected.');
      return;
    }
    updateGraph((current) => ({
      ...current,
      edges: [...current.edges, { id: crypto.randomUUID(), source, target }],
    }));
    setConnecting(false);
    setMessage('');
  }
  function select(key: string) {
    if (key === selected) {
      if (!detailsOpen) {
        setDetailsOpen(true);
        return;
      }
      setDetailsOpen(false);
      onSelect(null);
      setConnecting(false);
      setMessage('');
      return;
    }
    if (connecting && selection && key) {
      connect(selection, key);
      return;
    }
    onSelect(key || null);
    setDetailsOpen(!!key);
    setConnecting(false);
    setMessage('');
  }
  function disconnect(connection: GraphConnection) {
    if (disabled) {
      return;
    }
    updateGraph((current) => removeManualConnection(current, connection));
    setConnecting(false);
    setMessage(
      connection.markdown === 'none'
        ? 'Manual connection removed. Use Undo to restore it.'
        : 'Manual connection removed. The Markdown link remains.',
    );
  }
  function open(key: string) {
    const node = nodes.get(key);
    if (node?.identity && !disabled) {
      onOpen(node);
    }
  }
  function move(key: string, x: number, y: number) {
    if (disabled) {
      return;
    }
    updateGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.key === key ? { ...node, x, y } : node)),
    }));
    onSelect(key);
    if (key !== selected) {
      setDetailsOpen(true);
    }
  }
  return (
    <>
      <div className="graph-body">
        <GraphCanvas
          active={visible}
          points={visiblePoints}
          edges={projection.connections}
          matches={null}
          selected={selection}
          emptyMessage="No files in this view."
          onSelect={select}
          onCloseDetails={() => setDetailsOpen(false)}
          onOpen={open}
          onMove={move}
          onConnect={connect}
          theme={workspace.preferences.theme ?? 'dark'}
          interfaceFont={workspace.preferences.interfaceFont}
          connecting={connecting && !!selection}
          disabled={disabled}
        >
          {active && detailsOpen ? (
            <Selection
              key={active.key}
              node={active}
              connections={connections}
              inspectorId={inspectorId}
              inspectedNode={inspectedNode}
              disabled={disabled}
              connecting={connecting}
              message={message}
              onOpen={open}
              onShowConnections={() => {
                setDetailsOpen(false);
                onInspect({ kind: 'connections', key: active.key });
              }}
              onConnect={() => {
                if (!connecting && inspector?.kind === 'connections') {
                  onInspect({ kind: 'files' });
                }
                setConnecting((value) => !value);
                setMessage('');
              }}
            />
          ) : null}
        </GraphCanvas>
        <GraphSidebar
          inspector={inspector}
          inspectorId={inspectorId}
          inspectedNode={inspectedNode}
          nodes={nodes}
          connections={connections}
          disabled={disabled}
          message={message}
          onOpen={open}
          onDisconnect={disconnect}
          onClose={onCloseInspector}
          onInspect={onInspect}
        >
          <div className="graph-tools">
            <SearchField
              data-sidebar-focus
              aria-label="Find a graph file"
              placeholder="Find a file…"
              value={query}
              onChange={(event) => {
                clearSelection();
                setQuery(event.target.value);
              }}
            />
            {local ? (
              <LocalGraphControls
                local={local}
                root={localRoot}
                selected={selection}
                onChange={(next) => {
                  clearSelection();
                  onLocalChange(next);
                }}
              />
            ) : null}
            <details className="graph-filter-disclosure">
              <summary>
                <WorkspaceIcon name="filter" />
                Filters
                {filterCount > 0 ? <span className="graph-filter-count">{filterCount}</span> : null}
              </summary>
              <div className="graph-filter-content">
                <DocumentFilters
                  value={filters}
                  onChange={(next) => {
                    clearSelection();
                    setFilters(next);
                  }}
                  {...filterOptions}
                />
              </div>
            </details>
          </div>
          <div className="graph-results-heading">
            <span className="graph-result-count" role="status">
              {projection.nodes.length} of {snapshot.nodes.length} files
            </span>
            {query || hasDocumentFilters(filters) ? (
              <button
                type="button"
                className="graph-clear-filters"
                onClick={() => {
                  setQuery('');
                  setFilters(emptyDocumentFilters);
                  clearSelection();
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <div className="graph-files">
            <FileList nodes={projection.nodes} selected={selection} onSelect={select} />
          </div>
        </GraphSidebar>
      </div>
    </>
  );
}

function GraphHeading({
  graph,
  connectionCount,
  local,
  onToggleLocal,
  inspectorOpen,
  inspectorId,
  onToggleInspector,
  disabled,
}: {
  graph: ReturnType<typeof useGraph>;
  connectionCount: number;
  local: boolean;
  onToggleLocal: () => void;
  disabled: boolean;
  inspectorOpen: boolean;
  inspectorId: string;
  onToggleInspector: () => void;
}) {
  const snapshot = graph.snapshot;
  let saveStatus = 'Saved';
  let saveState = 'saved';
  if (graph.saving) {
    saveStatus = 'Saving…';
    saveState = 'saving';
  } else if (graph.dirty) {
    saveStatus = 'Unsaved changes';
    saveState = 'dirty';
  }
  return (
    <header className="graph-heading" data-tauri-drag-region>
      <div className="graph-heading-context">
        <span className="graph-heading-emblem" aria-hidden="true">
          <WorkspaceIcon name="graph" />
        </span>
        <div className="graph-heading-label">
          <h1>{local ? 'Local graph' : 'Graph'}</h1>
          {snapshot && !local ? (
            <span className="graph-heading-summary">
              {snapshot.nodes.length} files · {connectionCount} connections
            </span>
          ) : null}
        </div>
      </div>
      <div className="graph-heading-actions">
        {snapshot ? (
          <span className="graph-save-status" data-state={saveState} role="status">
            {saveStatus}
          </span>
        ) : null}
        <div className="graph-heading-group" role="group" aria-label="Graph scope">
          <button
            type="button"
            className="icon-button"
            aria-label={local ? 'Show global graph' : 'Show local graph'}
            data-tooltip={local ? 'Show global graph' : 'Show local graph'}
            aria-pressed={local}
            onClick={onToggleLocal}
          >
            <WorkspaceIcon name="connections" />
          </button>
        </div>
        <div className="graph-heading-group" role="group" aria-label="Graph history">
          <button
            type="button"
            className="icon-button"
            aria-label="Undo graph change"
            data-tooltip="Undo graph change"
            disabled={disabled || !graph.canUndo}
            onClick={graph.undo}
          >
            <WorkspaceIcon name="undo" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo graph change"
            data-tooltip="Redo graph change"
            disabled={disabled || !graph.canRedo}
            onClick={graph.redo}
          >
            <WorkspaceIcon name="redo" />
          </button>
        </div>
        <div className="graph-heading-group" role="group" aria-label="Graph view">
          <button
            type="button"
            className="icon-button"
            aria-label={inspectorOpen ? 'Collapse graph sidebar' : 'Expand graph sidebar'}
            data-tooltip={inspectorOpen ? 'Collapse graph sidebar' : 'Expand graph sidebar'}
            aria-expanded={inspectorOpen}
            aria-controls={inspectorId}
            onClick={onToggleInspector}
          >
            <WorkspaceIcon name="sidebarRight" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh graph"
            data-tooltip="Refresh graph"
            disabled={graph.loading || graph.saving || graph.dirty}
            onClick={graph.refresh}
          >
            <WorkspaceIcon name="refresh" />
          </button>
        </div>
      </div>
    </header>
  );
}

function GraphReferenceStatus({ graph }: { graph: ReturnType<typeof useGraph> }) {
  const references = graph.snapshot?.references;
  if (!references || (!references.canContinue && references.indexing.state === 'ready')) {
    return null;
  }
  return (
    <div className="workbench-notice" role="status">
      <span>
        {references.canContinue
          ? 'Reading saved Markdown links. Connections are still incomplete.'
          : (references.indexing.message ??
            'Some Markdown links could not be indexed. Connections may be incomplete.')}
      </span>
      {graph.referencesPaused ? (
        <button type="button" onClick={graph.continueReferences}>
          Continue reading links
        </button>
      ) : null}
    </div>
  );
}

function useGraphInspector(active: boolean) {
  const [inspector, setInspector] = useState<GraphInspector | null>(null);
  const [wasActive, setWasActive] = useState(active);
  // Retain the graph's layout/history while starting each visit with a clear canvas.
  if (active !== wasActive) {
    setWasActive(active);
    setInspector(null);
  }
  return [inspector, setInspector] as const;
}

export default function GraphView({
  active,
  activePath,
  workspace,
  onOpen,
  onRegisterPersistenceGuard,
}: {
  active: boolean;
  activePath?: string | null;
  workspace: Workspace;
  onOpen: (node: GraphNode) => void;
  onRegisterPersistenceGuard: (guard: (() => Promise<void>) | null) => void;
}) {
  const graph = useGraph(workspace.vault, onRegisterPersistenceGuard);
  const [inspector, setInspector] = useGraphInspector(active);
  const inspectorId = useId();
  const [confirmReload, setConfirmReload] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalGraph | null>(null);
  const root = useRef<HTMLElement>(null);
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey) ||
      event.key.toLowerCase() !== 'z'
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || !root.current?.contains(target)) {
      return;
    }
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, [contenteditable="true"], dialog')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!workspace.busy) {
      if (event.shiftKey) {
        graph.redo();
      } else {
        graph.undo();
      }
    }
  });
  useEffect(() => {
    const element = root.current;
    if (!element) {
      return;
    }
    const listener = (event: KeyboardEvent) => shortcut(event);
    element.addEventListener('keydown', listener);
    return () => element.removeEventListener('keydown', listener);
  }, [workspace.vault?.id]);
  const snapshot = graph.snapshot;
  const connections = useMemo(() => (snapshot ? graphConnections(snapshot) : []), [snapshot]);
  if (!workspace.vault) {
    return (
      <section className="graph-unavailable">
        <WorkspaceIcon name="graph" />
        <h2>Connect your files</h2>
        <p>Open a Vault to see Markdown, PDF and DOCX connections.</p>
      </section>
    );
  }
  return (
    <section className="file-graph" aria-label="File graph" ref={root}>
      <GraphHeading
        disabled={!!workspace.busy}
        graph={graph}
        connectionCount={connections.length}
        local={local !== null}
        onToggleLocal={() => {
          if (local) {
            setLocal(null);
          } else {
            const center =
              snapshot?.nodes.find((node) => node.key === selected && node.identity) ??
              snapshot?.nodes.find((node) => node.path === activePath && node.identity);
            setLocal({ root: center?.key ?? null, depth: 1 });
          }
          setSelected(null);
        }}
        inspectorOpen={inspector !== null}
        inspectorId={inspectorId}
        onToggleInspector={() => setInspector((value) => (value ? null : { kind: 'files' }))}
      />
      {graph.error ? (
        <div className="graph-save-error" role="alert">
          <span>
            {graph.error}
            {graph.dirty ? ' Your graph changes are kept in this session.' : ''}
          </span>
          <button type="button" onClick={graph.dirty ? graph.retry : graph.refresh}>
            Retry
          </button>
          {graph.dirty ? (
            <button type="button" onClick={() => setConfirmReload(true)}>
              Reload saved graph…
            </button>
          ) : null}
        </div>
      ) : null}
      {snapshot && !snapshot.complete ? (
        <div className="workbench-notice" role="status">
          The graph shows the indexed files so far.{' '}
          {snapshot.indexing.message ?? 'Reconcile the Vault for full coverage.'}
          <button type="button" disabled={!!workspace.busy} onClick={workspace.reconcile}>
            Reconcile Vault
          </button>
        </div>
      ) : null}
      <GraphReferenceStatus graph={graph} />
      {snapshot?.nodes.length ? (
        <GraphContent
          active={active}
          inspector={inspector}
          onInspect={setInspector}
          inspectorId={inspectorId}
          onCloseInspector={() => {
            const trigger =
              root.current?.querySelector<HTMLButtonElement>(
                '.graph-node-popover:not([hidden]) .graph-connections-trigger[aria-expanded="true"]',
              ) ??
              root.current?.querySelector<HTMLButtonElement>(
                '.graph-heading button[aria-controls]',
              );
            setInspector(null);
            trigger?.focus();
          }}
          snapshot={snapshot}
          connections={connections}
          selected={selected}
          onSelect={setSelected}
          local={local}
          onLocalChange={setLocal}
          workspace={workspace}
          edit={graph.edit}
          onOpen={onOpen}
        />
      ) : (
        <div className="graph-empty graph-canvas-host" aria-busy={graph.loading}>
          {snapshot && !graph.loading ? (
            <>
              <WorkspaceIcon name="graph" />
              <h2>Your files will appear here</h2>
              <p>Add Markdown, PDF or DOCX files to this Vault.</p>
            </>
          ) : null}
        </div>
      )}
      <OverlayPresence>
        {confirmReload ? (
          <Dialog open title="Reload saved graph?" onClose={() => setConfirmReload(false)}>
            <p>
              Your unsaved graph positions and connections will be discarded. Document contents stay
              unchanged.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirmReload(false)}>
                Keep changes
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmReload(false);
                  void graph.reload();
                }}
              >
                Reload saved graph
              </button>
            </div>
          </Dialog>
        ) : null}
      </OverlayPresence>
    </section>
  );
}
