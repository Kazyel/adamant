import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { resolveFontFamily, type FontFamily } from '../../shared/styles/fontFamilies';
import GraphNodePopover from './GraphNodePopover';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { GraphConnection } from './graphConnections';
import { graphNeighbors, type GraphPoint } from './graphLayout';
import {
  drawGraph,
  fitGraph,
  graphNodeRadii,
  screenPoint,
  type Camera,
  type GraphDrag,
} from './graphDrawing';

export default function GraphCanvas({
  active,
  points,
  children,
  matches,
  edges,
  selected,
  onSelect,
  onCloseDetails,
  onOpen,
  onMove,
  onConnect,
  theme,
  interfaceFont,
  connecting,
  disabled,
  emptyMessage = 'No files of these types.',
}: {
  active: boolean;
  points: GraphPoint[];
  children?: ReactNode;
  matches: Set<string> | null;
  edges: GraphConnection[];
  selected: string | null;
  onSelect: (key: string) => void;
  onCloseDetails: () => void;
  onOpen: (key: string) => void;
  onMove: (key: string, x: number, y: number) => void;
  onConnect: (source: string, target: string) => void;
  theme: string;
  interfaceFont?: FontFamily;
  connecting: boolean;
  disabled: boolean;
  emptyMessage?: string;
}) {
  const fontFamily = resolveFontFamily(interfaceFont ?? 'inter');
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [storedCamera, setCamera] = useState<Camera | null>(null);
  const [drag, setDrag] = useState<GraphDrag | null>(null);
  const dragRef = useRef(drag);
  const camera = storedCamera ?? fitGraph(points, size);
  const cameraRef = useRef(camera);
  useLayoutEffect(() => {
    cameraRef.current = camera;
  }, [camera]);
  const radii = useMemo(() => graphNodeRadii(points, edges, selected), [points, edges, selected]);
  const neighbors = useMemo(() => graphNeighbors(selected, edges), [selected, edges]);

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (!next.width || !next.height) {
        return;
      }
      // Fit once. Resizing the viewport must not move the graph beneath the pointer.
      setCamera((current) => current ?? fitGraph(points, next));
      setSize(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [points]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) {
      return;
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = cameraRef.current;
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const scale = Math.max(0.0001, Math.min(4, current.scale * Math.exp(-event.deltaY * 0.001)));
      const factor = scale / current.scale;
      setCamera({ x: x - (x - current.x) * factor, y: y - (y - current.y) * factor, scale });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    let disposed = false;
    const draw = () => {
      if (!disposed && canvas.current) {
        drawGraph(
          canvas.current,
          points,
          edges,
          camera,
          size,
          selected,
          neighbors,
          radii,
          drag,
          matches,
        );
      }
    };
    const frame = requestAnimationFrame(draw);
    // Canvas text must be redrawn when an offline bundled face finishes loading.
    const fontStyles = [400, 600].map((weight) => `${weight} 12px ${fontFamily}`);
    if (!fontStyles.every((style) => document.fonts.check(style))) {
      void Promise.all(fontStyles.map((style) => document.fonts.load(style))).then(
        draw,
        () => undefined,
      );
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [
    active,
    points,
    edges,
    camera,
    size,
    selected,
    neighbors,
    radii,
    drag,
    theme,
    matches,
    fontFamily,
  ]);

  function local(clientX: number, clientY: number) {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function hit(x: number, y: number) {
    let distance = Infinity;
    let nearest: GraphPoint | undefined;
    for (const point of points) {
      const at = screenPoint(point, camera);
      const next = Math.hypot(at.x - x, at.y - y);
      if (next < Math.max(18, radii.get(point.node.key)! + 4) && next < distance) {
        nearest = point;
        distance = next;
      }
    }
    return nearest;
  }
  function begin(clientX: number, clientY: number) {
    const at = local(clientX, clientY);
    const point = hit(at.x, at.y);
    const source = points.find((item) => item.node.key === selected);
    const sourcePosition = source ? screenPoint(source, camera) : null;
    const handle =
      source &&
      sourcePosition &&
      Math.hypot(
        sourcePosition.x - at.x,
        sourcePosition.y - radii.get(source.node.key)! - 12 - at.y,
      ) < 12;
    let kind: GraphDrag['kind'] = 'pan';
    let key: string | null = null;
    if (!disabled && handle) {
      kind = 'link';
      key = selected;
    } else if (point) {
      kind = 'node';
      key = point.node.key;
    }
    const next = { kind, key, x: at.x, y: at.y, fromX: at.x, fromY: at.y, moved: false };
    dragRef.current = next;
    setDrag(next);
  }
  function move(clientX: number, clientY: number) {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const at = local(clientX, clientY);
    const x = at.x - current.x,
      y = at.y - current.y;
    const next = {
      ...current,
      ...at,
      moved: current.moved || Math.hypot(at.x - current.fromX, at.y - current.fromY) > 4,
    };
    if (next.kind === 'pan') {
      setCamera({ ...camera, x: camera.x + x, y: camera.y + y });
    }
    dragRef.current = next;
    setDrag(next);
  }
  function end(clientX: number, clientY: number, shiftKey: boolean) {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) {
      return;
    }
    const at = local(clientX, clientY);
    const target = hit(at.x, at.y);
    if (current.kind === 'link' && current.key && target) {
      onConnect(current.key, target.node.key);
      return;
    }
    if (current.kind === 'node' && current.key) {
      if (current.moved && !disabled) {
        const point = points.find((item) => item.node.key === current.key)!;
        onMove(
          current.key,
          point.x + (at.x - current.fromX) / camera.scale,
          point.y + (at.y - current.fromY) / camera.scale,
        );
      } else if (!current.moved) {
        if (connecting && selected) {
          onSelect(current.key);
        } else if (shiftKey) {
          onOpen(current.key);
        } else {
          onSelect(current.key);
        }
      }
    }
  }
  function zoom(factor: number) {
    const scale = Math.min(4, Math.max(0.0001, camera.scale * factor));
    const change = scale / camera.scale;
    setCamera({
      x: size.width / 2 - (size.width / 2 - camera.x) * change,
      y: size.height / 2 - (size.height / 2 - camera.y) * change,
      scale,
    });
  }
  function focusSelected() {
    const point = points.find((item) => item.node.key === selected);
    if (point) {
      setCamera({ x: size.width / 2 - point.x, y: size.height / 2 - point.y, scale: 1 });
    }
  }

  const selectedPoint = points.find((point) => point.node.key === selected);
  const anchor = selectedPoint ? screenPoint(selectedPoint, camera) : null;

  return (
    <div className={`graph-canvas-host${connecting ? ' is-connecting' : ''}`} ref={host}>
      <canvas
        ref={canvas}
        style={{ fontFamily }}
        tabIndex={0}
        role="img"
        aria-label="Interactive file graph. Click to select or deselect a node; Shift+click to open its file. Drag nodes to arrange them. Drag the plus handle above the selected node onto another file to connect. Drag the background to pan; scroll to zoom. The file list provides keyboard access."
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          begin(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => move(event.clientX, event.clientY)}
        onPointerUp={(event) => end(event.clientX, event.clientY, event.shiftKey)}
        onPointerCancel={() => {
          dragRef.current = null;
          setDrag(null);
        }}
        onKeyDown={(event) => {
          const directions: Record<string, [number, number]> = {
            ArrowLeft: [60, 0],
            ArrowRight: [-60, 0],
            ArrowUp: [0, 60],
            ArrowDown: [0, -60],
          };
          const direction = directions[event.key];
          if (direction) {
            event.preventDefault();
            setCamera({ ...camera, x: camera.x + direction[0], y: camera.y + direction[1] });
          }
          if (event.key === '+' || event.key === '=') {
            zoom(1.3);
          }
          if (event.key === '-') {
            zoom(1 / 1.3);
          }
          if (event.key === 'Enter' && selected) {
            onOpen(selected);
          }
          if (event.key === 'Escape') {
            onSelect('');
          }
        }}
      />
      {anchor && children && !drag ? (
        <GraphNodePopover
          key={selected}
          anchor={anchor}
          size={size}
          onClose={() => {
            onCloseDetails();
            canvas.current?.focus();
          }}
        >
          {children}
        </GraphNodePopover>
      ) : null}
      {!points.length || matches?.size === 0 ? (
        <p className="graph-canvas-empty" role="status">
          {!points.length ? emptyMessage : 'No files match your search.'}
        </p>
      ) : null}
      <div className="graph-legend" aria-label="File types and connection origins">
        <span data-kind="markdown">Markdown</span>
        <span data-kind="pdf">PDF</span>
        <span data-kind="docx">DOCX</span>
        <span className="graph-edge-key" data-origin="manual">
          Manual connection
        </span>
        <span className="graph-edge-key" data-origin="markdown">
          Markdown link
        </span>
      </div>
      <div className="graph-zoom" role="group" aria-label="Graph controls">
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.3)}>
          <WorkspaceIcon name="minimize" />
        </button>
        <button type="button" onClick={() => setCamera(fitGraph(points, size))}>
          Fit graph
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1.3)}>
          <WorkspaceIcon name="plus" />
        </button>
        {selected ? (
          <button type="button" onClick={focusSelected}>
            Center file
          </button>
        ) : null}
      </div>
    </div>
  );
}
