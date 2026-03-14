import { PoseGraph, Point } from "./graph";
import { PoseLayout, PoseState, clonePoseState, computePoseLayout, derivePoseStateFromLayout, clampLocalRotation } from "./pose";

export type ConstraintProjectOptions = {
  goalNodeId?: string;
  goalTarget?: Point;
  goalTargets?: Array<{ nodeId: string; target: Point; weight?: number }>;
  dynamicPins?: Record<string, Point>;
  preserveNodeIds?: string[];
  iterations?: number;
  lengthIterations?: number;
};

export type ConstraintProjectResult = {
  positions: Record<string, Point>;
  pose: PoseState;
  layout: PoseLayout;
  saturatedNodeIds: string[];
};

// We avoid rounding inside the solver to prevent integration jitter loop.
function precise(value: number): number {
  return value;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clonePositions(positions: Record<string, Point>): Record<string, Point> {
  return Object.fromEntries(
    Object.entries(positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
  );
}

function pinTargets(graph: PoseGraph, dynamicPins: Record<string, Point> = {}): Record<string, Point> {
  const pinned = graph.constraints.reduce<Record<string, Point>>((acc, constraint) => {
    if (constraint.type === "pin" && constraint.enabled) {
      acc[constraint.nodeId] = { x: constraint.x, y: constraint.y };
    }
    return acc;
  }, {});

  Object.entries(dynamicPins).forEach(([nodeId, point]) => {
    pinned[nodeId] = { x: point.x, y: point.y };
  });

  return pinned;
}

function mobilityForNode(graph: PoseGraph, nodeId: string, pins: Record<string, Point>): number {
  if (pins[nodeId]) return 0;
  const node = graph.nodeMap.get(nodeId);
  if (!node) return 0.75;
  if (node.massClass === "heavy") return 0.4;
  if (node.massClass === "medium") return 0.65;
  return 1;
}

function applyPins(positions: Record<string, Point>, pins: Record<string, Point>): void {
  Object.entries(pins).forEach(([nodeId, point]) => {
    positions[nodeId] = { x: point.x, y: point.y };
  });
}

function applyGoals(
  positions: Record<string, Point>,
  goals: Array<{ nodeId: string; target: Point; weight?: number }>,
  pins: Record<string, Point>,
  strength = 1,
): void {
  goals.forEach((goal) => {
    if (pins[goal.nodeId]) return;
    const current = positions[goal.nodeId];
    if (!current) return;
    const appliedStrength = Math.max(0, Math.min(1, (goal.weight ?? 1) * strength));
    positions[goal.nodeId] = {
      x: (current.x * (1 - appliedStrength)) + (goal.target.x * appliedStrength),
      y: (current.y * (1 - appliedStrength)) + (goal.target.y * appliedStrength),
    };
  });
}

function projectLengths(graph: PoseGraph, positions: Record<string, Point>, pins: Record<string, Point>): void {
  const constrainNode = (node: PoseGraph["nodes"][number]) => {
    if (!node.parentId || typeof node.restLength !== "number" || node.restLength <= 0) return;
    const parent = positions[node.parentId];
    const current = positions[node.id];
    if (!parent || !current) return;

    const currentDistance = distance(parent, current) || 0.0001;
    const error = (currentDistance - node.restLength) / currentDistance;
    const delta = {
      x: (current.x - parent.x) * error,
      y: (current.y - parent.y) * error,
    };

    const parentMobility = mobilityForNode(graph, node.parentId, pins);
    const nodeMobility = mobilityForNode(graph, node.id, pins);
    const totalMobility = parentMobility + nodeMobility;
    if (totalMobility <= 0) return;

    if (parentMobility > 0) {
      positions[node.parentId] = {
        x: parent.x + delta.x * (parentMobility / totalMobility),
        y: parent.y + delta.y * (parentMobility / totalMobility),
      };
    }

    if (nodeMobility > 0) {
      positions[node.id] = {
        x: current.x - delta.x * (nodeMobility / totalMobility),
        y: current.y - delta.y * (nodeMobility / totalMobility),
      };
    }
  };

  // Backwards pass (leaves to root) propagates end-effector pins up the chain instantly
  const reversedNodes = [...graph.nodes].reverse();
  reversedNodes.forEach(constrainNode);
  
  // Forwards pass (root to leaves) propagates root inertia down the chain instantly
  graph.nodes.forEach(constrainNode);
}

function nudgeTowardsPreferred(
  graph: PoseGraph,
  pose: PoseState,
  preserveNodeIds: Set<string>,
  strength = 0.005,
): PoseState {
  const next = clonePoseState(pose);

  graph.nodes.forEach((node) => {
    if (!node.parentId) return;
    if (preserveNodeIds.has(node.id)) return;
    if (typeof node.preferredBend !== "number") return;
    const current = next.localRotations[node.id] ?? 0;
    const blended = (current * (1 - strength)) + (node.preferredBend * strength);
    next.localRotations[node.id] = clampLocalRotation(graph, node.id, blended);
  });

  return next;
}

function collectSaturatedNodeIds(graph: PoseGraph, pose: PoseState): string[] {
  return graph.nodes
    .filter((node) => {
      if (!node.rotationLimit) return false;
      const current = pose.localRotations[node.id] ?? 0;
      return (
        Math.abs(current - node.rotationLimit[0]) <= 1.5 ||
        Math.abs(current - node.rotationLimit[1]) <= 1.5
      );
    })
    .map((node) => node.id)
    .sort();
}

export function projectConstraintPositions(
  graph: PoseGraph,
  inputPositions: Record<string, Point>,
  seedPose: PoseState,
  options: ConstraintProjectOptions = {},
): ConstraintProjectResult {
  const iterations = options.iterations ?? 6;
  const lengthIterations = options.lengthIterations ?? 5;
  const goalTargets = options.goalTargets && options.goalTargets.length > 0
    ? options.goalTargets
    : (options.goalNodeId && options.goalTarget
      ? [{ nodeId: options.goalNodeId, target: options.goalTarget, weight: 1 }]
      : []);
  const pins = pinTargets(graph, options.dynamicPins);
  const preserveNodeIds = new Set(options.preserveNodeIds || []);
  goalTargets.forEach((goal) => preserveNodeIds.add(goal.nodeId));
  Object.keys(pins).forEach((nodeId) => preserveNodeIds.add(nodeId));

  let positions = clonePositions(inputPositions);
  let candidatePose = clonePoseState(seedPose);

  // Apply time-domain restorative biases ONCE per physics tick
  candidatePose = nudgeTowardsPreferred(graph, candidatePose, preserveNodeIds, 0.01);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const baseLayout = computePoseLayout(graph, candidatePose);

    // 1. Vector Length Satisfaction
    for (let lengthPass = 0; lengthPass < lengthIterations; lengthPass += 1) {
      applyGoals(positions, goalTargets, pins, 0.3);
      projectLengths(graph, positions, pins);
      applyPins(positions, pins);
    }

    // 2. Angular Limit Satisfaction
    // Distribute root blending evenly across iterations to sum to a smooth drag (e.g. 15% follow per frame)
    candidatePose = derivePoseStateFromLayout(graph, candidatePose, {
      positions,
      absoluteRotations: baseLayout.absoluteRotations,
      localRotations: baseLayout.localRotations,
    }, { 
      preserveNodeIds,
      rootRotationBlend: 0.15 / iterations,
      nodeRotationBlend: 0.5,
    });

    // 3. Update spatial layout to adhere to clipped angles
    positions = clonePositions(computePoseLayout(graph, candidatePose).positions);
  }

  let layout = computePoseLayout(graph, candidatePose);
  const saturatedNodeIds = collectSaturatedNodeIds(graph, candidatePose);

  return {
    positions: clonePositions(layout.positions),
    pose: candidatePose,
    layout,
    saturatedNodeIds,
  };
}

export function relaxPoseGraph(
  graph: PoseGraph,
  initialPose: PoseState,
  options: ConstraintProjectOptions = {},
): ConstraintProjectResult {
  const initialLayout = computePoseLayout(graph, initialPose);
  return projectConstraintPositions(graph, initialLayout.positions, initialPose, options);
}
