import { PoseGraph, Point } from "./graph";
import { PoseLayout, PoseState } from "./pose";
import { projectConstraintPositions } from "./constraints";

export type RagdollState = {
  positions: Record<string, Point>;
  previousPositions: Record<string, Point>;
};

type StepResult = {
  ragdoll: RagdollState;
  pose: PoseState;
  layout: PoseLayout;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pinTargets(graph: PoseGraph): Record<string, Point> {
  return graph.constraints.reduce<Record<string, Point>>((acc, constraint) => {
    if (constraint.type === "pin" && constraint.enabled) {
      acc[constraint.nodeId] = { x: constraint.x, y: constraint.y };
    }
    return acc;
  }, {});
}

function floorYForNode(node: PoseGraph["nodes"][number]): number {
  return node.contactRole && node.contactRole !== "none" ? 970 : 992;
}

export function createRagdollState(layout: PoseLayout): RagdollState {
  const positions = Object.fromEntries(
    Object.entries(layout.positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
  );
  return {
    positions,
    previousPositions: Object.fromEntries(
      Object.entries(layout.positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
  };
}

export function stepRagdoll(graph: PoseGraph, pose: PoseState, ragdoll: RagdollState, dtSeconds = 1 / 60): StepResult {
  const nextRagdoll: RagdollState = {
    positions: Object.fromEntries(
      Object.entries(ragdoll.positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
    previousPositions: Object.fromEntries(
      Object.entries(ragdoll.previousPositions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
  };

  const pins = pinTargets(graph);
  const gravity = 1800 * dtSeconds * dtSeconds;
  const damping = 0.992;

  graph.nodes.forEach((node) => {
    const current = nextRagdoll.positions[node.id];
    const previous = nextRagdoll.previousPositions[node.id];
    const pin = pins[node.id];

    if (pin) {
      nextRagdoll.positions[node.id] = { x: pin.x, y: pin.y };
      nextRagdoll.previousPositions[node.id] = { x: pin.x, y: pin.y };
      return;
    }

    const velocity = {
      x: (current.x - previous.x) * damping,
      y: (current.y - previous.y) * damping,
    };

    nextRagdoll.previousPositions[node.id] = { x: current.x, y: current.y };
    nextRagdoll.positions[node.id] = {
      x: round2(current.x + velocity.x),
      y: round2(Math.min(floorYForNode(node), current.y + velocity.y + gravity)),
    };
  });

  for (let iteration = 0; iteration < 8; iteration += 1) {
    graph.nodes.forEach((node) => {
      if (!node.parentId || typeof node.restLength !== "number" || node.restLength <= 0) return;
      const parentPos = nextRagdoll.positions[node.parentId];
      const nodePos = nextRagdoll.positions[node.id];
      const targetLength = node.restLength;
      const currentLength = distance(parentPos, nodePos) || 0.0001;
      const diff = (currentLength - targetLength) / currentLength;
      const offset = {
        x: round2((nodePos.x - parentPos.x) * 0.5 * diff),
        y: round2((nodePos.y - parentPos.y) * 0.5 * diff),
      };

      const parentPinned = Boolean(pins[node.parentId]);
      const nodePinned = Boolean(pins[node.id]);

      if (!parentPinned) {
        nextRagdoll.positions[node.parentId] = {
          x: round2(parentPos.x + (nodePinned ? offset.x * 2 : offset.x)),
          y: round2(parentPos.y + (nodePinned ? offset.y * 2 : offset.y)),
        };
      }

      if (!nodePinned) {
        nextRagdoll.positions[node.id] = {
          x: round2(nodePos.x - (parentPinned ? offset.x * 2 : offset.x)),
          y: round2(Math.min(floorYForNode(node), nodePos.y - (parentPinned ? offset.y * 2 : offset.y))),
        };
      }
    });

    Object.entries(pins).forEach(([nodeId, point]) => {
      nextRagdoll.positions[nodeId] = { x: point.x, y: point.y };
      nextRagdoll.previousPositions[nodeId] = { x: point.x, y: point.y };
    });
  }

  const projected = projectConstraintPositions(graph, nextRagdoll.positions, pose, {
    iterations: 5,
    lengthIterations: 3,
  });
  nextRagdoll.positions = Object.fromEntries(
    Object.entries(projected.positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
  );
  const nextPose = projected.pose;
  const solvedLayout = projected.layout;

  return {
    ragdoll: nextRagdoll,
    pose: nextPose,
    layout: solvedLayout,
  };
}
