import type { GraphEdge } from './graphTypes';
import type { GraphConnection } from './graphConnections';
import type { GraphPoint } from './graphLayout';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}
export interface GraphSize {
  width: number;
  height: number;
}
export interface GraphDrag {
  kind: 'pan' | 'node' | 'link';
  key: string | null;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  moved: boolean;
}

export function fitGraph(points: GraphPoint[], size: GraphSize): Camera {
  if (!points.length) {
    return { x: size.width / 2, y: size.height / 2, scale: 1 };
  }
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const scale = Math.max(
    0.0001,
    Math.min(
      1.2,
      (size.width - 80) / Math.max(180, right - left + 160),
      (size.height - 100) / Math.max(180, bottom - top + 120),
    ),
  );
  return {
    x: size.width / 2 - ((left + right) / 2) * scale,
    y: size.height / 2 - ((top + bottom) / 2) * scale,
    scale,
  };
}

export function screenPoint(point: { x: number; y: number }, camera: Camera) {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export function graphNodeRadii(
  points: readonly GraphPoint[],
  edges: readonly GraphEdge[],
  selected: string | null,
) {
  const connections = new Map(points.map((point) => [point.node.key, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target) {
      continue;
    }
    const source = connections.get(edge.source);
    const target = connections.get(edge.target);
    if (source && target) {
      source.add(edge.target);
      target.add(edge.source);
    }
  }
  return new Map(
    [...connections].map(([key, neighbors]) => [
      key,
      // Square-root growth keeps hubs visible without letting them dominate the canvas.
      7 + Math.min(7, Math.sqrt(neighbors.size) * 2) + (key === selected ? 2 : 0),
    ]),
  );
}

function drawEdge(
  context: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: GraphSize,
  sourceInset = 0,
  targetInset = 0,
) {
  if (
    Math.max(a.x, b.x) < 0 ||
    Math.min(a.x, b.x) > size.width ||
    Math.max(a.y, b.y) < 0 ||
    Math.min(a.y, b.y) > size.height
  ) {
    return;
  }
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance <= sourceInset + targetInset) {
    return;
  }
  const dx = (b.x - a.x) / distance;
  const dy = (b.y - a.y) / distance;
  context.beginPath();
  context.moveTo(a.x + dx * sourceInset, a.y + dy * sourceInset);
  context.lineTo(b.x - dx * targetInset, b.y - dy * targetInset);
  context.stroke();
}

function drawNodeShape(
  context: CanvasRenderingContext2D,
  kind: GraphPoint['node']['kind'],
  x: number,
  y: number,
  radius: number,
) {
  context.beginPath();
  if (kind === 'pdf') {
    const half = radius * 0.78;
    context.roundRect(x - half, y - half, half * 2, half * 2, 3);
  } else if (kind === 'docx') {
    context.moveTo(x, y - radius - 1);
    context.lineTo(x + radius + 1, y);
    context.lineTo(x, y + radius + 1);
    context.lineTo(x - radius - 1, y);
    context.closePath();
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
}

function drawNode(
  context: CanvasRenderingContext2D,
  point: GraphPoint,
  position: { x: number; y: number },
  selected: boolean,
  color: string,
  textColor: string,
  surface: string,
  label: boolean,
  width: number,
  radius: number,
  fontFamily: string,
) {
  const { x, y } = position;
  const alpha = context.globalAlpha;

  if (selected) {
    context.beginPath();
    context.arc(x, y, radius + 3, 0, Math.PI * 2);
    context.strokeStyle = color;
    context.globalAlpha = alpha * 0.5;
    context.lineWidth = 1;
    context.stroke();
  }
  drawNodeShape(context, point.node.kind, x, y, radius);
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = selected ? 10 : 0;
  context.fill();
  context.shadowBlur = 0;

  const light = context.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  light.addColorStop(0, 'rgb(255 255 255 / 45%)');
  light.addColorStop(0.4, 'rgb(255 255 255 / 6%)');
  light.addColorStop(0.65, 'rgb(0 0 0 / 0%)');
  light.addColorStop(1, 'rgb(0 0 0 / 24%)');
  context.fillStyle = light;
  context.fill();

  const rim = context.createLinearGradient(x, y - radius, x, y + radius);
  rim.addColorStop(0, 'rgb(255 255 255 / 65%)');
  rim.addColorStop(0.5, 'rgb(255 255 255 / 12%)');
  rim.addColorStop(1, 'rgb(0 0 0 / 25%)');
  context.strokeStyle = rim;
  context.lineWidth = 1;
  context.stroke();

  if (label) {
    const name = point.node.path.split('/').at(-1) ?? point.node.path;
    const text = name.length > 32 ? `${name.slice(0, 29)}…` : name;
    context.font = `${selected ? 600 : 400} 12px ${fontFamily}`;
    const labelWidth = context.measureText(text).width + (selected ? 16 : 0);
    const offset = radius + 10;
    const labelX = x + offset + labelWidth > width - 16 ? x - offset - labelWidth : x + offset;
    if (selected) {
      context.beginPath();
      context.roundRect(labelX, y - 14, labelWidth, 28, 6);
      context.fillStyle = surface;
      context.fill();
      context.globalAlpha = alpha * 0.3;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.stroke();
      context.globalAlpha = alpha;
    }
    context.fillStyle = textColor;
    context.fillText(text, labelX + (selected ? 8 : 0), y + 4);
  }
  if (selected) {
    const handleY = y - radius - 12;
    context.fillStyle = surface;
    context.beginPath();
    context.arc(x, handleY, 8, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    context.moveTo(x - 3, handleY);
    context.lineTo(x + 3, handleY);
    context.moveTo(x, handleY - 3);
    context.lineTo(x, handleY + 3);
    context.stroke();
  }
}

function resizeCanvas(element: HTMLCanvasElement, size: GraphSize, ratio: number) {
  const width = Math.round(size.width * ratio);
  const height = Math.round(size.height * ratio);
  if (element.width !== width) {
    element.width = width;
  }
  if (element.height !== height) {
    element.height = height;
  }
}

export function drawGraph(
  element: HTMLCanvasElement,
  points: GraphPoint[],
  edges: GraphConnection[],
  camera: Camera,
  size: GraphSize,
  selected: string | null,
  neighbors: Set<string>,
  radii: ReadonlyMap<string, number>,
  drag: GraphDrag | null,
  matches: Set<string> | null = null,
) {
  const context = element.getContext('2d');
  if (!context) {
    return;
  }
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  resizeCanvas(element, size, ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, element.width / ratio, element.height / ratio);
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const colors = {
    markdown: color('--provider-blue'),
    pdf: color('--amber'),
    docx: color('--success'),
    focus: color('--focus'),
    edge: color('--control-border'),
    error: color('--error'),
    text: color('--text'),
    surface: color('--surface'),
  };
  const positions = new Map(
    points.map((point) => {
      const position = screenPoint(point, camera);
      if (drag?.kind === 'node' && drag.key === point.node.key) {
        position.x += drag.x - drag.fromX;
        position.y += drag.y - drag.fromY;
      }
      return [point.node.key, position];
    }),
  );
  for (const edge of edges) {
    const a = positions.get(edge.source),
      b = positions.get(edge.target);
    if (!a || !b) {
      continue;
    }
    const active = edge.source === selected || edge.target === selected;
    context.strokeStyle = active ? colors.focus : colors.edge;
    context.globalAlpha = edgeOpacity(edge, selected, matches);
    context.lineWidth = active ? 1.6 : 1;
    context.lineCap = 'round';
    context.setLineDash(edge.manual ? [] : [5, 4]);
    drawEdge(context, a, b, size, radii.get(edge.source)! + 2, radii.get(edge.target)! + 2);
  }
  context.setLineDash([]);
  drawNodes();
  if (drag?.kind === 'link' && drag.key) {
    const source = positions.get(drag.key);
    if (source) {
      context.globalAlpha = 1;
      context.strokeStyle = colors.focus;
      context.setLineDash([5, 4]);
      drawEdge(context, source, { x: drag.x, y: drag.y }, size);
      context.setLineDash([]);
    }
  }
  context.globalAlpha = 1;

  function drawNodes() {
    if (!context) {
      return;
    }
    for (const point of points) {
      const position = positions.get(point.node.key)!;
      if (
        position.x < -200 ||
        position.y < -40 ||
        position.x > size.width + 200 ||
        position.y > size.height + 40
      ) {
        continue;
      }
      const active = point.node.key === selected;
      const emphasis = nodeEmphasis(point.node.key, selected, neighbors, matches, camera.scale);
      const matched = emphasis.matched;
      context.globalAlpha = emphasis.alpha;
      if (matched) {
        context.beginPath();
        context.arc(position.x, position.y, radii.get(point.node.key)! + 3, 0, Math.PI * 2);
        context.strokeStyle = colors.focus;
        context.lineWidth = 2;
        context.stroke();
      }
      drawNode(
        context,
        point,
        position,
        active,
        point.node.problem ? colors.error : colors[point.node.kind],
        colors.text,
        colors.surface,
        emphasis.label,
        size.width,
        radii.get(point.node.key)!,
        style.fontFamily,
      );
    }
  }
}

function edgeOpacity(edge: GraphEdge, selected: string | null, matches: Set<string> | null) {
  if (matches && !matches.has(edge.source) && !matches.has(edge.target)) {
    return 0.08;
  }
  if (selected && edge.source !== selected && edge.target !== selected) {
    return 0.15;
  }
  return selected ? 0.85 : 0.45;
}

function nodeEmphasis(
  key: string,
  selected: string | null,
  neighbors: Set<string>,
  matches: Set<string> | null,
  scale: number,
) {
  const active = key === selected;
  if (matches) {
    const matched = matches.has(key);
    return { matched, alpha: matched || active ? 1 : 0.15, label: matched || active };
  }
  const related = neighbors.has(key);
  return {
    matched: false,
    alpha: selected && !related && !active ? 0.28 : 1,
    label: scale > 0.45 || active || related,
  };
}
