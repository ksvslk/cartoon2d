import { SceneObstacle, SpatialTransform } from "../schema/story";

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Point = { x: number; y: number };
type SimpleTransform = { tx: number; ty: number; sx: number; sy: number };

export function detectSceneObstacles(svgData: string): SceneObstacle[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgData, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return [];

  const layers = [
    svg.querySelector("#bg_midground"),
    svg.querySelector("#bg_foreground"),
  ].filter(Boolean) as Element[];

  const obstacles: SceneObstacle[] = [];
  let idx = 0;

  layers.forEach((layer, layerIndex) => {
    Array.from(layer.children).forEach((child, childIndex) => {
      const box = visitElement(child, identityTransform());
      if (!box) return;

      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      const area = width * height;
      const stageArea = 1920 * 1080;
      const id = child.getAttribute("id") || `obstacle-${layerIndex}-${childIndex}`;

      if (width < 120 || height < 120) return;
      if (area < 45000 || area > stageArea * 0.6) return;
      if (box.minY > 980) return;

      obstacles.push({
        id,
        x: round2(box.minX),
        y: round2(box.minY),
        width: round2(width),
        height: round2(height),
      });
      idx += 1;
    });
  });

  return obstacles;
}

export function clampTargetAgainstObstacles(
  motion: string,
  start: SpatialTransform,
  target: SpatialTransform | undefined,
  obstacles: SceneObstacle[],
): { target: SpatialTransform | undefined; collision: SceneObstacle | null } {
  if (!target || obstacles.length === 0) {
    return { target, collision: null };
  }

  const movingRight = target.x > start.x + 8;
  const movingLeft = target.x < start.x - 8;
  if (!movingRight && !movingLeft) {
    return { target, collision: null };
  }

  const pathTop = Math.min(start.y, target.y) - 120 * start.scale;
  const pathBottom = Math.max(start.y, target.y) + 120 * start.scale;
  const margin = /swim|glide|fly|drift/.test(motion) ? 90 : 70;

  const candidates = obstacles.filter((obstacle) => {
    const obstacleTop = obstacle.y;
    const obstacleBottom = obstacle.y + obstacle.height;
    const overlapsY = pathBottom >= obstacleTop && pathTop <= obstacleBottom;
    if (!overlapsY) return false;
    if (movingRight) return obstacle.x >= start.x + 40;
    return obstacle.x + obstacle.width <= start.x - 40;
  });

  if (candidates.length === 0) {
    return { target, collision: null };
  }

  const sorted = [...candidates].sort((a, b) => {
    const aEdge = movingRight ? a.x : a.x + a.width;
    const bEdge = movingRight ? b.x : b.x + b.width;
    return movingRight ? aEdge - bEdge : bEdge - aEdge;
  });

  const obstacle = sorted[0];
  const clampX = movingRight
    ? obstacle.x - margin
    : obstacle.x + obstacle.width + margin;

  if ((movingRight && target.x <= clampX) || (movingLeft && target.x >= clampX)) {
    return { target, collision: null };
  }

  return {
    collision: obstacle,
    target: {
      ...target,
      x: round2(clampX),
    },
  };
}

function visitElement(element: Element, inherited: SimpleTransform): Box | null {
  const local = composeTransform(inherited, parseTransform(element.getAttribute("transform")));
  const tag = element.tagName.toLowerCase();

  if (tag === "g" || tag === "svg") {
    return unionBoxes(Array.from(element.children).map((child) => visitElement(child, local)));
  }

  const primitive = computePrimitiveBox(element);
  const transformed = primitive ? applyTransformToBox(primitive, local) : null;
  const childUnion = unionBoxes(Array.from(element.children).map((child) => visitElement(child, local)));
  return unionBoxes([transformed, childUnion]);
}

function computePrimitiveBox(element: Element): Box | null {
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case "rect": {
      const x = numAttr(element, "x");
      const y = numAttr(element, "y");
      const width = numAttr(element, "width");
      const height = numAttr(element, "height");
      return { minX: x, minY: y, maxX: x + width, maxY: y + height };
    }
    case "circle": {
      const cx = numAttr(element, "cx");
      const cy = numAttr(element, "cy");
      const r = numAttr(element, "r");
      return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    }
    case "ellipse": {
      const cx = numAttr(element, "cx");
      const cy = numAttr(element, "cy");
      const rx = numAttr(element, "rx");
      const ry = numAttr(element, "ry");
      return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
    }
    case "line": {
      const x1 = numAttr(element, "x1");
      const y1 = numAttr(element, "y1");
      const x2 = numAttr(element, "x2");
      const y2 = numAttr(element, "y2");
      return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
    }
    case "polygon":
    case "polyline":
      return boxFromPoints(parsePoints(element.getAttribute("points")));
    case "path": {
      const d = element.getAttribute("d");
      return d ? boxFromPoints(samplePathPoints(d)) : null;
    }
    default:
      return null;
  }
}

function parsePoints(rawPoints: string | null): Point[] {
  if (!rawPoints) return [];
  const nums = (rawPoints.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) || []).map(Number);
  const points: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push({ x: nums[i], y: nums[i + 1] });
  }
  return points;
}

function samplePathPoints(d: string): Point[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const points: Point[] = [];
  let index = 0;
  let command = "";
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };

  const nextNumber = () => Number(tokens[index++]);
  const isCommand = (token?: string) => !!token && /^[a-zA-Z]$/.test(token);

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++]!;
    if (!command) break;

    const absolute = command === command.toUpperCase();
    const type = command.toUpperCase();
    const readPoint = (): Point => {
      const x = nextNumber();
      const y = nextNumber();
      return absolute ? { x, y } : { x: current.x + x, y: current.y + y };
    };

    if (type === "M") {
      const point = readPoint();
      current = point;
      subpathStart = point;
      points.push(point);
      command = absolute ? "L" : "l";
      continue;
    }
    if (type === "L") {
      current = readPoint();
      points.push(current);
      continue;
    }
    if (type === "H") {
      const x = nextNumber();
      current = absolute ? { x, y: current.y } : { x: current.x + x, y: current.y };
      points.push(current);
      continue;
    }
    if (type === "V") {
      const y = nextNumber();
      current = absolute ? { x: current.x, y } : { x: current.x, y: current.y + y };
      points.push(current);
      continue;
    }
    if (type === "C") {
      const c1 = readPoint();
      const c2 = readPoint();
      const end = readPoint();
      points.push(c1, c2, end);
      current = end;
      continue;
    }
    if (type === "S") {
      const c2 = readPoint();
      const end = readPoint();
      points.push(c2, end);
      current = end;
      continue;
    }
    if (type === "Q") {
      const c1 = readPoint();
      const end = readPoint();
      points.push(c1, end);
      current = end;
      continue;
    }
    if (type === "T") {
      const end = readPoint();
      points.push(end);
      current = end;
      continue;
    }
    if (type === "A") {
      const rx = nextNumber();
      const ry = nextNumber();
      index += 3;
      const end = readPoint();
      points.push(
        { x: current.x - rx, y: current.y - ry },
        { x: current.x + rx, y: current.y + ry },
        { x: end.x - rx, y: end.y - ry },
        { x: end.x + rx, y: end.y + ry },
        end,
      );
      current = end;
      continue;
    }
    if (type === "Z") {
      current = subpathStart;
      points.push(subpathStart);
      continue;
    }
    break;
  }

  return points;
}

function parseTransform(transform: string | null): SimpleTransform {
  const parsed = identityTransform();
  if (!transform) return parsed;

  const matcher = /([a-zA-Z]+)\(([^)]+)\)/g;
  for (const match of transform.matchAll(matcher)) {
    const fn = match[1];
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === "translate") {
      parsed.tx += args[0] || 0;
      parsed.ty += args[1] || 0;
    } else if (fn === "scale") {
      parsed.sx *= args[0] || 1;
      parsed.sy *= args[1] ?? args[0] ?? 1;
    }
  }

  return parsed;
}

function identityTransform(): SimpleTransform {
  return { tx: 0, ty: 0, sx: 1, sy: 1 };
}

function composeTransform(parent: SimpleTransform, child: SimpleTransform): SimpleTransform {
  return {
    tx: parent.tx + child.tx * parent.sx,
    ty: parent.ty + child.ty * parent.sy,
    sx: parent.sx * child.sx,
    sy: parent.sy * child.sy,
  };
}

function applyTransformToPoint(point: Point, transform: SimpleTransform): Point {
  return {
    x: point.x * transform.sx + transform.tx,
    y: point.y * transform.sy + transform.ty,
  };
}

function applyTransformToBox(box: Box, transform: SimpleTransform): Box {
  const corners = [
    applyTransformToPoint({ x: box.minX, y: box.minY }, transform),
    applyTransformToPoint({ x: box.maxX, y: box.minY }, transform),
    applyTransformToPoint({ x: box.minX, y: box.maxY }, transform),
    applyTransformToPoint({ x: box.maxX, y: box.maxY }, transform),
  ];
  return boxFromPoints(corners)!;
}

function unionBoxes(boxes: Array<Box | null>): Box | null {
  const valid = boxes.filter((box): box is Box => !!box);
  if (valid.length === 0) return null;
  return {
    minX: Math.min(...valid.map((box) => box.minX)),
    minY: Math.min(...valid.map((box) => box.minY)),
    maxX: Math.max(...valid.map((box) => box.maxX)),
    maxY: Math.max(...valid.map((box) => box.maxY)),
  };
}

function boxFromPoints(points: Point[]): Box | null {
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function numAttr(element: Element, attr: string): number {
  const raw = element.getAttribute(attr);
  return raw ? Number(raw) || 0 : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
