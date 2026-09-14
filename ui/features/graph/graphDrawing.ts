import type { GraphEdge } from './graphTypes';
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

function drawEdge(
  context: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: GraphSize,
) {
  if (
    Math.max(a.x, b.x) < 0 ||
    Math.min(a.x, b.x) > size.width ||
    Math.max(a.y, b.y) < 0 ||
    Math.min(a.y, b.y) > size.height
  ) {
    return;
  }
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
}

function drawNode(
  context: CanvasRenderingContext2D,
  point: GraphPoint,
  position: { x: number; y: number },
  selected: boolean,
  color: string,
  textColor: string,
  label: boolean,
) {
  const { x, y } = position;
  const radius = selected ? 9 : 6;
  context.fillStyle = color;
  context.beginPath();
  if (point.node.kind === 'pdf') {
    context.rect(x - radius, y - radius, radius * 2, radius * 2);
  } else if (point.node.kind === 'docx') {
    context.moveTo(x, y - radius - 2);
    context.lineTo(x + radius + 2, y);
    context.lineTo(x, y + radius + 2);
    context.lineTo(x - radius - 2, y);
    context.closePath();
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fill();
  if (selected) {
    context.strokeStyle = textColor;
    context.lineWidth = 2;
    context.stroke();
  }
  if (label) {
    const name = point.node.path.split('/').at(-1) ?? point.node.path;
    context.font = `${selected ? 600 : 400} 12px "Adamant Sans", sans-serif`;
    context.fillStyle = textColor;
    context.fillText(name.length > 32 ? `${name.slice(0, 29)}…` : name, x + 16, y + 5);
  }
  if (selected) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y - 28, 7, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = textColor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x - 3, y - 28);
    context.lineTo(x + 3, y - 28);
    context.moveTo(x, y - 31);
    context.lineTo(x, y - 25);
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
  edges: GraphEdge[],
  camera: Camera,
  size: GraphSize,
  selected: string | null,
  neighbors: Set<string>,
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
    context.strokeStyle = color(active ? '--focus' : '--control-border');
    context.globalAlpha = edgeOpacity(edge, selected, matches);
    context.lineWidth = active ? 1.8 : 1;
    drawEdge(context, a, b, size);
  }
  drawNodes();
  if (drag?.kind === 'link' && drag.key) {
    const source = positions.get(drag.key);
    if (source) {
      context.globalAlpha = 1;
      context.strokeStyle = color('--focus');
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
        context.arc(position.x, position.y, 14, 0, Math.PI * 2);
        context.strokeStyle = color('--focus');
        context.lineWidth = 2;
        context.stroke();
      }
      drawNode(
        context,
        point,
        position,
        active,
        point.node.problem ? color('--error') : colors[point.node.kind],
        color('--text'),
        emphasis.label,
      );
    }
  }
}

function edgeOpacity(edge: GraphEdge, selected: string | null, matches: Set<string> | null) {
  if (matches && !matches.has(edge.source) && !matches.has(edge.target)) {
    return 0.08;
  }
  return selected && edge.source !== selected && edge.target !== selected ? 0.2 : 0.6;
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
    alpha: selected && !related ? 0.35 : 1,
    label: scale > 0.45 || active || related,
  };
}
