import { PoseGraph, Point } from "./graph";
import { PoseLayout, PoseState, clonePoseState, computePoseLayout, clampLocalRotation } from "./pose";
import { relaxPoseGraph } from "./constraints";

export type SolveResult = {
  pose: PoseState;
  layout: PoseLayout;
  chainNodeIds: string[];
  anchorId: string;
  reached: boolean;
  saturatedNodeIds: string[];
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalizeDegrees(value: number): number {
  let next = value;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return round2(next);
}

function biasRotationTowardsPreferred(graph: PoseGraph, nodeId: string, value: number): number {
  const node = graph.nodeMap.get(nodeId);
  if (!node || typeof node.preferredBend !== "number") {
    return clampLocalRotation(graph, nodeId, value);
  }

  const preferred = clampLocalRotation(graph, nodeId, node.preferredBend);
  const limitSpan = node.rotationLimit ? Math.abs(node.rotationLimit[1] - node.rotationLimit[0]) : 180;
  const blend = limitSpan <= 170 ? 0.2 : 0.1;
  return clampLocalRotation(graph, nodeId, normalizeDegrees((value * (1 - blend)) + (preferred * blend)));
}

function enabledPinIds(graph: PoseGraph): Set<string> {
  return new Set(
    graph.constraints
      .filter((constraint) => constraint.type === "pin" && constraint.enabled)
      .map((constraint) => constraint.nodeId),
  );
}

function chainToRoot(graph: PoseGraph, nodeId: string): string[] {
  const path: string[] = [];
  let cursor = graph.nodeMap.get(nodeId);
  const seen = new Set<string>();

  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor.id);
    cursor = cursor.parentId ? graph.nodeMap.get(cursor.parentId) : undefined;
  }

  return path.reverse();
}

function solvePathForEffector(graph: PoseGraph, effectorId: string): { nodeIds: string[]; anchorId: string } {
  const path = chainToRoot(graph, effectorId);
  const pins = enabledPinIds(graph);
  const pinnedPathNode = [...path].reverse().find((nodeId) => pins.has(nodeId));
  const anchorId = pinnedPathNode || path[0] || effectorId;
  const anchorIndex = Math.max(0, path.indexOf(anchorId));
  return {
    nodeIds: path.slice(anchorIndex),
    anchorId,
  };
}

export function solveEffectorCCD(
  graph: PoseGraph,
  pose: PoseState,
  effectorId: string,
  target: Point,
  iterations = 14,
  tolerance = 6,
): SolveResult {
  const { nodeIds, anchorId } = solvePathForEffector(graph, effectorId);
  const candidate = clonePoseState(pose);
  const saturatedNodeIds = new Set<string>();
  let layout = computePoseLayout(graph, candidate);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const currentEffector = layout.positions[effectorId];
    if (!currentEffector || distance(currentEffector, target) <= tolerance) break;

    for (let index = nodeIds.length - 2; index >= 0; index -= 1) {
      const nodeId = nodeIds[index];
      const joint = layout.positions[nodeId];
      const effector = layout.positions[effectorId];
      if (!joint || !effector) continue;

      const currentToEffector = Math.atan2(effector.y - joint.y, effector.x - joint.x);
      const currentToTarget = Math.atan2(target.y - joint.y, target.x - joint.x);
      const deltaDegrees = round2(((currentToTarget - currentToEffector) * 180) / Math.PI);

      const currentRotation = candidate.localRotations[nodeId] ?? 0;
      const unclampedRotation = currentRotation + deltaDegrees;
      const clampedRotation = biasRotationTowardsPreferred(graph, nodeId, unclampedRotation);
      if (Math.abs(clampedRotation - unclampedRotation) > 0.001) {
        saturatedNodeIds.add(nodeId);
      }
      candidate.localRotations[nodeId] = clampedRotation;
      layout = computePoseLayout(graph, candidate);

      const updatedEffector = layout.positions[effectorId];
      if (updatedEffector && distance(updatedEffector, target) <= tolerance) break;
    }
  }

  const relaxed = relaxPoseGraph(graph, candidate, {
    goalNodeId: effectorId,
    goalTarget: target,
  });

  layout = relaxed.layout;
  return {
    pose: relaxed.pose,
    layout,
    chainNodeIds: nodeIds,
    anchorId,
    reached: distance(layout.positions[effectorId], target) <= tolerance,
    saturatedNodeIds: Array.from(new Set([...saturatedNodeIds, ...relaxed.saturatedNodeIds])).sort(),
  };
}

export function rootIdForNode(graph: PoseGraph, nodeId: string): string {
  let cursor = graph.nodeMap.get(nodeId);
  const seen = new Set<string>();

  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    cursor = graph.nodeMap.get(cursor.parentId);
  }

  return cursor?.id || nodeId;
}

export function localRotationForNode(graph: PoseGraph, layout: PoseLayout, nodeId: string): number {
  const node = graph.nodeMap.get(nodeId);
  if (!node) return 0;
  if (!node.parentId) return normalizeDegrees(layout.localRotations[nodeId] ?? 0);

  const parentPos = layout.positions[node.parentId];
  const currentPos = layout.positions[nodeId];
  const parentAbs = layout.absoluteRotations[node.parentId] ?? 0;
  if (!parentPos || !currentPos) return 0;

  const currentAngle = round2((Math.atan2(currentPos.y - parentPos.y, currentPos.x - parentPos.x) * 180) / Math.PI);
  const restAngle = round2((Math.atan2(node.restWorld.y - graph.nodeMap.get(node.parentId)!.restWorld.y, node.restWorld.x - graph.nodeMap.get(node.parentId)!.restWorld.x) * 180) / Math.PI);
  return clampLocalRotation(graph, nodeId, currentAngle - restAngle - parentAbs);
}
