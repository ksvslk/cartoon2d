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

function precise(value: number): number {
  return value;
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

export function stepRagdoll(
  graph: PoseGraph,
  pose: PoseState,
  ragdoll: RagdollState,
  dtSeconds = 1 / 60,
  dragTarget?: { nodeId: string; x: number; y: number } | null,
): StepResult {
  const nextRagdoll: RagdollState = {
    positions: Object.fromEntries(
      Object.entries(ragdoll.positions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
    previousPositions: Object.fromEntries(
      Object.entries(ragdoll.previousPositions).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
  };

  const pins = pinTargets(graph);
  // Less intense gravity so lengths don't stretch as hard against rest constraints
  const gravity = 1200 * dtSeconds * dtSeconds;
  const damping = 0.82;

  graph.nodes.forEach((node) => {
    const current = nextRagdoll.positions[node.id];
    const previous = nextRagdoll.previousPositions[node.id];
    const pin = pins[node.id];

    if (pin) {
      nextRagdoll.positions[node.id] = { x: pin.x, y: pin.y };
      nextRagdoll.previousPositions[node.id] = { x: pin.x, y: pin.y };
      return;
    }

    // Constrain absolute velocity to prevent unrecoverable numeric explosions
    // when a rigid mouse drag forces multiple limbs to stretch/snap instantly.
    const maxVelocity = 35;
    const rawVx = (current.x - previous.x) * damping;
    const rawVy = (current.y - previous.y) * damping;
    const magnitude = Math.hypot(rawVx, rawVy);
    
    const velocity = magnitude > maxVelocity ? {
      x: (rawVx / magnitude) * maxVelocity,
      y: (rawVy / magnitude) * maxVelocity,
    } : {
      x: rawVx,
      y: rawVy,
    };

    // Apply a velvet sleep threshold - if velocity is microscopic, zero it.
    if (Math.abs(velocity.x) < 0.05) velocity.x = 0;
    if (Math.abs(velocity.y) < 0.05) velocity.y = 0;

    nextRagdoll.previousPositions[node.id] = { x: current.x, y: current.y };
    nextRagdoll.positions[node.id] = {
      x: current.x + velocity.x,
      y: Math.min(floorYForNode(node), current.y + velocity.y + gravity),
    };
  });

  const dynamicPins: Record<string, Point> = {};
  if (dragTarget) {
    dynamicPins[dragTarget.nodeId] = { x: dragTarget.x, y: dragTarget.y };
  }

  const projected = projectConstraintPositions(graph, nextRagdoll.positions, pose, {
    iterations: 18,
    lengthIterations: 8,
    dynamicPins,
  });
  graph.nodes.forEach((node) => {
    const projectedPoint = projected.positions[node.id];
    if (projectedPoint) {
      const diffX = projectedPoint.x - nextRagdoll.positions[node.id].x;
      const diffY = projectedPoint.y - nextRagdoll.positions[node.id].y;
      
      nextRagdoll.positions[node.id] = { x: projectedPoint.x, y: projectedPoint.y };
      const previous = nextRagdoll.previousPositions[node.id];
      if (previous) {
        // Offset the previous physics frame correctly so constraint fulfillment
        // isn't mathematically perceived as "free kinetic energy" by the Verlet integrator.
        // This makes joint limits and mouse dragging 100% solid and un-bouncy.
        nextRagdoll.previousPositions[node.id] = {
          x: previous.x + diffX,
          y: previous.y + diffY,
        };
      }
    }
  });

  return {
    ragdoll: nextRagdoll,
    pose: projected.pose,
    layout: projected.layout,
  };
}
