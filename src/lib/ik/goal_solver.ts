import { relaxPoseGraph } from "./constraints";
import { clampLocalRotation, computePoseLayout, createRestPoseState, PoseState } from "./pose";
import { PoseGraph } from "./graph";
import { EvaluatedMotionGoals } from "../motion/intent";

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function solvePoseFromGoals(
  graph: PoseGraph,
  goals: EvaluatedMotionGoals,
  basePose: PoseState = createRestPoseState(graph),
) {
  const pose: PoseState = {
    rootTranslations: Object.fromEntries(
      Object.entries(basePose.rootTranslations).map(([nodeId, point]) => [nodeId, { x: point.x, y: point.y }]),
    ),
    localRotations: { ...basePose.localRotations },
  };

  if (graph.roots[0] && goals.rootOffset) {
    pose.rootTranslations[graph.roots[0]] = {
      x: round2(goals.rootOffset.x),
      y: round2(goals.rootOffset.y),
    };
    if (typeof goals.rootOffset.rotation === "number") {
      pose.localRotations[graph.roots[0]] = clampLocalRotation(graph, graph.roots[0], round2(goals.rootOffset.rotation));
    }
  }

  Object.entries(goals.axialRotations).forEach(([nodeId, rotation]) => {
    pose.localRotations[nodeId] = clampLocalRotation(graph, nodeId, round2(rotation));
  });

  const preConstraintLayout = computePoseLayout(graph, pose);
  const dynamicPins = Object.fromEntries(
    [
      ...goals.activePins.map((pin) => [pin.nodeId, { x: pin.x, y: pin.y }] as const),
      ...goals.activeContacts
        .map((contact) => {
          const point = preConstraintLayout.positions[contact.nodeId];
          if (!point) return null;
          return [contact.nodeId, { x: point.x, y: point.y }] as const;
        })
        .filter((entry): entry is readonly [string, { x: number; y: number }] => Boolean(entry)),
    ],
  );
  return relaxPoseGraph(graph, pose, {
    goalTargets: goals.effectorTargets.map((goal) => ({
      nodeId: goal.nodeId,
      target: goal.target,
      weight: goal.weight,
    })),
    dynamicPins,
    iterations: goals.effectorTargets.length > 0 ? 8 : 6,
  });
}
