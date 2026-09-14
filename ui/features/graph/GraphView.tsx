import SearchField from '../../shared/ui/SearchField';
import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { Dialog } from '../interaction/InteractionDialogs';
import { OverlayPresence } from '../interaction/OverlayPresence';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import type { Workspace } from '../workspace/workspaceTypes';
import type { GraphNode, GraphSnapshot } from './graphTypes';
import GraphCanvas from './GraphCanvas';
import { layoutGraph } from './graphLayout';
import useGraph from './useGraph';

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
            <span className="graph-file-dot" data-kind={node.kind} />
            <span>
              <strong>{name(node.path)}</strong>
              <small>{node.path}</small>
            </span>
            {node.problem ? <WorkspaceIcon name="warning" /> : null}
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
  snapshot,
  disabled,
  connecting,
  onOpen,
  onConnect,
}: {
  node: GraphNode;
  snapshot: GraphSnapshot;
  disabled: boolean;
  connecting: boolean;
  onOpen: (key: string) => void;
  onConnect: () => void;
}) {
  const count = snapshot.edges.reduce(
    (total, edge) => total + Number(edge.source === node.key || edge.target === node.key),
    0,
  );
  const folder = node.path.includes('/')
    ? node.path.slice(0, node.path.lastIndexOf('/'))
    : 'Vault root';
  return (
    <div className="graph-selection">
      <div className="graph-selection-kind">
        <span className="graph-selection-emblem" data-kind={node.kind}>
          <WorkspaceIcon name="document" />
        </span>
        {node.kind === 'markdown' ? 'Markdown note' : `${node.kind.toUpperCase()} document`}
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
      <dl className="graph-connection-total">
        <dt>Connections</dt>
        <dd>{count}</dd>
      </dl>
      <div className="graph-file-actions">
        <button
          type="button"
          disabled={!node.identity || disabled}
          onClick={() => onOpen(node.key)}
        >
          <WorkspaceIcon name="external" />
          Open file
        </button>
        <button type="button" disabled={disabled} aria-pressed={connecting} onClick={onConnect}>
          <WorkspaceIcon name="link" />
          {connecting ? 'Cancel' : 'Connect file'}
        </button>
      </div>
    </div>
  );
}

function GraphContent({
  snapshot,
  workspace,
  edit,
  onOpen,
  inspectorOpen,
  inspectorId,
}: {
  snapshot: GraphSnapshot;
  workspace: Workspace;
  inspectorOpen: boolean;
  inspectorId: string;
  edit: (transform: (snapshot: GraphSnapshot) => GraphSnapshot) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<GraphNode['kind'][]>(['markdown', 'pdf', 'docx']);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState('');
  const nodes = useMemo(() => new Map(snapshot.nodes.map((node) => [node.key, node])), [snapshot]);
  const points = useMemo(() => layoutGraph(snapshot.nodes, snapshot.edges), [snapshot]);
  const visiblePoints = useMemo(
    () => points.filter((point) => kinds.includes(point.node.kind)),
    [points, kinds],
  );
  const visibleKeys = useMemo(
    () => new Set(visiblePoints.map((point) => point.node.key)),
    [visiblePoints],
  );
  const visibleEdges = useMemo(
    () =>
      snapshot.edges.filter((edge) => visibleKeys.has(edge.source) && visibleKeys.has(edge.target)),
    [snapshot.edges, visibleKeys],
  );
  const files = useMemo(
    () =>
      snapshot.nodes.filter(
        (node) =>
          kinds.includes(node.kind) && node.path.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [snapshot.nodes, query, kinds],
  );
  const matches = useMemo(
    () => (query.trim() ? new Set(files.map((node) => node.key)) : null),
    [files, query],
  );
  const active = selected ? nodes.get(selected) : undefined;
  const disabled = !!workspace.busy;

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
      setSelected(null);
      setConnecting(false);
      setMessage('');
      return;
    }
    if (connecting && selected && key) {
      connect(selected, key);
      return;
    }
    setSelected(key || null);
    setDetailsOpen(!!key);
    setConnecting(false);
    setMessage('');
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
    setSelected(key);
    if (key !== selected) {
      setDetailsOpen(true);
    }
  }
  return (
    <>
      <div className="graph-body">
        <GraphCanvas
          points={visiblePoints}
          edges={visibleEdges}
          matches={matches}
          selected={selected}
          onSelect={select}
          onCloseDetails={() => setDetailsOpen(false)}
          onOpen={open}
          onMove={move}
          onConnect={connect}
          theme={workspace.preferences.theme ?? 'dark'}
          connecting={connecting}
          disabled={disabled}
        >
          {active && detailsOpen ? (
            <>
              <Selection
                node={active}
                snapshot={snapshot}
                disabled={disabled}
                connecting={connecting}
                onOpen={open}
                onConnect={() => {
                  setConnecting((value) => !value);
                  setMessage('');
                }}
              />
              {connecting ? (
                <p className="graph-connect-prompt" role="status">
                  Choose another node in the graph or a file in the sidebar.
                </p>
              ) : null}
              {message ? (
                <p className="graph-feedback" role="status">
                  {message}
                </p>
              ) : null}
            </>
          ) : null}
        </GraphCanvas>
        <aside
          id={inspectorId}
          hidden={!inspectorOpen}
          className="graph-inspector"
          aria-label="Graph files"
        >
          <div className="graph-tools">
            <SearchField
              aria-label="Find a graph file"
              placeholder="Find a file…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="graph-type-filters" role="group" aria-label="File types shown">
              {(['markdown', 'pdf', 'docx'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={kinds.includes(kind)}
                  onClick={() => {
                    setKinds((current) =>
                      current.includes(kind)
                        ? current.filter((value) => value !== kind)
                        : [...current, kind],
                    );
                    if (active?.kind === kind && kinds.includes(kind)) {
                      setSelected(null);
                      setConnecting(false);
                    }
                  }}
                >
                  <span className="graph-file-dot" data-kind={kind} />
                  {kind === 'markdown' ? 'Markdown' : kind.toUpperCase()}
                </button>
              ))}
            </div>
            <span className="graph-result-count" role="status">
              {files.length} of {snapshot.nodes.length} files{matches ? ' match' : ' shown'}
            </span>
            {query || kinds.length !== 3 ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setKinds(['markdown', 'pdf', 'docx']);
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <div className="graph-files">
            <FileList nodes={files} selected={selected} onSelect={select} />
          </div>
        </aside>
      </div>
    </>
  );
}

function GraphHeading({
  graph,
  inspectorOpen,
  inspectorId,
  onToggleInspector,
  disabled,
}: {
  graph: ReturnType<typeof useGraph>;
  disabled: boolean;
  inspectorOpen: boolean;
  inspectorId: string;
  onToggleInspector: () => void;
}) {
  const snapshot = graph.snapshot;
  let saveStatus = 'Saved';
  if (graph.saving) {
    saveStatus = 'Saving…';
  } else if (graph.dirty) {
    saveStatus = 'Unsaved changes';
  }
  return (
    <header className="graph-heading">
      <div>
        <h1>Graph</h1>
        <span>
          {snapshot?.nodes.length ?? 0} files · {snapshot?.edges.length ?? 0} connections
        </span>
      </div>
      <div className="graph-heading-actions">
        <span role="status">{saveStatus}</span>
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
    </header>
  );
}

export default function GraphView({
  workspace,
  onOpen,
  onRegisterPersistenceGuard,
}: {
  workspace: Workspace;
  onOpen: (node: GraphNode) => void;
  onRegisterPersistenceGuard: (guard: (() => Promise<void>) | null) => void;
}) {
  const graph = useGraph(workspace.vault, onRegisterPersistenceGuard);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const inspectorId = useId();
  const [confirmReload, setConfirmReload] = useState(false);
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
        inspectorOpen={inspectorOpen}
        inspectorId={inspectorId}
        onToggleInspector={() => setInspectorOpen((value) => !value)}
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
      {snapshot?.nodes.length ? (
        <GraphContent
          inspectorOpen={inspectorOpen}
          inspectorId={inspectorId}
          snapshot={snapshot}
          workspace={workspace}
          edit={graph.edit}
          onOpen={onOpen}
        />
      ) : (
        <div className="graph-empty">
          {graph.loading ? (
            <LoadingIndicator label="Reading file connections" />
          ) : (
            <>
              <WorkspaceIcon name="graph" />
              <h2>Your files will appear here</h2>
              <p>Add Markdown, PDF or DOCX files to this Vault.</p>
            </>
          )}
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
