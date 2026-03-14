import { PoseGraph, Point } from "./graph";

export type PoseState = {
  rootTranslations: Record<string, Point>;
  localRotations: Record<string, number>;
};

export type PoseLayout = {
  positions: Record<string, Point>;
  absoluteRotations: Record<string, number>;
  localRotations: Record<string, number>;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeDegrees(value: number): number {
  let next = value;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function restAngleOf(graph: PoseGraph, nodeId: string): number {
  const node = graph.nodeMap.get(nodeId);
  if (!node?.parentId) return 0;
  const parent = graph.nodeMap.get(node.parentId);
  if (!parent) return 0;
  return (Math.atan2(node.restWorld.y - parent.restWorld.y, node.restWorld.x - parent.restWorld.x) * 180) / Math.PI;
}

export function createRestPoseState(graph: PoseGraph): PoseState {
  const rootTranslations = graph.roots.reduce<Record<string, Point>>((acc, rootId) => {
    acc[rootId] = { x: 0, y: 0 };
    return acc;
  }, {});

  const localRotations = graph.nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.id] = 0;
    return acc;
  }, {});

  return { rootTranslations, localRotations };
}

export function clonePoseState(state: PoseState): PoseState {
  return {
    rootTranslations: Object.fromEntries(
      Object.entries(state.rootTranslations).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
    localRotations: { ...state.localRotations },
  };
}

export function clampLocalRotation(graph: PoseGraph, nodeId: string, value: number): number {
  const node = graph.nodeMap.get(nodeId);
  const normalized = normalizeDegrees(value);
  if (!node?.rotationLimit) return normalized;

  const min = node.rotationLimit[0];
  const max = node.rotationLimit[1];

  if (min > max) {
    if (normalized >= min || normalized <= max) return normalized;
  } else {
    if (normalized >= min && normalized <= max) return normalized;
  }

  const distToMin = Math.abs(normalizeDegrees(min - normalized));
  const distToMax = Math.abs(normalizeDegrees(max - normalized));
  return distToMin < distToMax ? min : max;
}

export function computePoseLayout(graph: PoseGraph, pose: PoseState): PoseLayout {
  const positions: Record<string, Point> = {};
  const absoluteRotations: Record<string, number> = {};
  const localRotations: Record<string, number> = {};

  const visit = (nodeId: string, parentAbsoluteDelta = 0) => {
    const node = graph.nodeMap.get(nodeId);
    if (!node) return;

    const localRotation = clampLocalRotation(graph, nodeId, pose.localRotations[nodeId] ?? 0);
    localRotations[nodeId] = localRotation;

    if (!node.parentId) {
      const translation = pose.rootTranslations[nodeId] || { x: 0, y: 0 };
      positions[nodeId] = {
        x: node.restWorld.x + translation.x,
        y: node.restWorld.y + translation.y,
      };
      absoluteRotations[nodeId] = normalizeDegrees(parentAbsoluteDelta + localRotation);
    } else {
      const parentPos = positions[node.parentId];
      const restAngle = restAngleOf(graph, nodeId);
      const currentAngle = normalizeDegrees(restAngle + parentAbsoluteDelta + localRotation);
      const length = node.restLength ?? Math.hypot(node.restWorld.x - graph.nodeMap.get(node.parentId)!.restWorld.x, node.restWorld.y - graph.nodeMap.get(node.parentId)!.restWorld.y);
      positions[nodeId] = {
        x: parentPos.x + Math.cos((currentAngle * Math.PI) / 180) * length,
        y: parentPos.y + Math.sin((currentAngle * Math.PI) / 180) * length,
      };
      absoluteRotations[nodeId] = normalizeDegrees(parentAbsoluteDelta + localRotation);
    }

    node.childIds
      .slice()
      .sort((left, right) => left.localeCompare(right))
      .forEach((childId) => visit(childId, absoluteRotations[nodeId]));
  };

  graph.roots
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .forEach((rootId) => visit(rootId));

  return {
    positions,
    absoluteRotations,
    localRotations,
  };
}

export function rootLocalRotationFromLayout(graph: PoseGraph, layout: PoseLayout, rootId: string): number {
  const node = graph.nodeMap.get(rootId);
  if (!node || node.childIds.length === 0) return clampLocalRotation(graph, rootId, layout.localRotations[rootId] ?? 0);
  const rootPos = layout.positions[rootId];
  if (!rootPos) return clampLocalRotation(graph, rootId, layout.localRotations[rootId] ?? 0);

  const deltas = node.childIds
    .map((childId) => {
      const child = graph.nodeMap.get(childId);
      const childPos = layout.positions[childId];
      if (!child || !childPos) return undefined;
      const current = (Math.atan2(childPos.y - rootPos.y, childPos.x - rootPos.x) * 180) / Math.PI;
      const rest = (Math.atan2(child.restWorld.y - node.restWorld.y, child.restWorld.x - node.restWorld.x) * 180) / Math.PI;
      return current - rest;
    })
    .filter((value): value is number => typeof value === "number");

  if (deltas.length === 0) return clampLocalRotation(graph, rootId, layout.localRotations[rootId] ?? 0);
  return clampLocalRotation(
    graph,
    rootId,
    deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
  );
}

export function derivePoseStateFromLayout(
  graph: PoseGraph, 
  currentPose: PoseState, 
  layout: PoseLayout,
  options: { preserveRootRotation?: boolean; rootRotationBlend?: number } = {}
): PoseState {
  const next = clonePoseState(currentPose);

  graph.roots.forEach((rootId) => {
    const root = graph.nodeMap.get(rootId);
    const current = layout.positions[rootId];
    if (!root || !current) return;
    next.rootTranslations[rootId] = {
      x: current.x - root.restWorld.x,
      y: current.y - root.restWorld.y,
    };
    if (options.preserveRootRotation) {
      next.localRotations[rootId] = currentPose.localRotations[rootId] ?? 0;
    } else {
      const derived = rootLocalRotationFromLayout(graph, layout, rootId);
      if (typeof options.rootRotationBlend === "number") {
        const prev = currentPose.localRotations[rootId] ?? 0;
        const diff = normalizeDegrees(derived - prev);
        next.localRotations[rootId] = clampLocalRotation(graph, rootId, prev + diff * options.rootRotationBlend);
      } else {
        next.localRotations[rootId] = derived;
      }
    }
  });

  const visit = (nodeId: string, parentAbsolute = 0) => {
    const node = graph.nodeMap.get(nodeId);
    if (!node) return;

    if (node.parentId) {
      const currentPos = layout.positions[nodeId];
      const parentPos = layout.positions[node.parentId];
      if (currentPos && parentPos) {
        const currentAngle = (Math.atan2(currentPos.y - parentPos.y, currentPos.x - parentPos.x) * 180) / Math.PI;
        const restAngle = restAngleOf(graph, nodeId);
        next.localRotations[nodeId] = clampLocalRotation(graph, nodeId, currentAngle - restAngle - parentAbsolute);
      }
    }

    const absolute = normalizeDegrees(parentAbsolute + (next.localRotations[nodeId] ?? 0));
    node.childIds.forEach((childId) => visit(childId, absolute));
  };

  graph.roots.forEach((rootId) => visit(rootId, 0));
  return next;
}

export function translateRoot(state: PoseState, rootId: string, delta: Point): PoseState {
  const next = clonePoseState(state);
  const current = next.rootTranslations[rootId] || { x: 0, y: 0 };
  next.rootTranslations[rootId] = {
    x: current.x + delta.x,
    y: current.y + delta.y,
  };
  return next;
}

export function setRootPosition(graph: PoseGraph, state: PoseState, rootId: string, target: Point): PoseState {
  const root = graph.nodeMap.get(rootId);
  if (!root) return state;
  const next = clonePoseState(state);
  next.rootTranslations[rootId] = {
    x: target.x - root.restWorld.x,
    y: target.y - root.restWorld.y,
  };
  return next;
}
