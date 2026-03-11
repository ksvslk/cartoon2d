import { buildPoseGraph, ensureRigIK } from "../ik/graph";
import { createRestPoseState } from "../ik/pose";
import { solvePoseFromGoals } from "../ik/goal_solver";
import { DraftsmanData, RigMotionClip } from "../schema/rig";
import { resolvePlayableMotionClip } from "./compiled_ik";
import { estimateMotionClipDuration, evaluateMotionIntentAtTime } from "./intent";

export type MotionValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  debug: MotionValidationDebug;
};

export type MotionValidationDebug = {
  graph: {
    hasCanonicalIK: boolean;
    rootCount: number;
    playableViewIds: string[];
  };
  drivenChains: Array<{
    chainId: string;
    nodeIds: string[];
    continuous: boolean;
  }>;
  playableCoverage?: {
    activeView: string;
    requiredNodeIds: string[];
    boundNodeCount: number;
    missingNodeIds: string[];
  };
  samples?: {
    sampleCount: number;
    maxSegmentError: number;
    maxPinError: number;
    saturatedNodeStats: Array<{
      nodeId: string;
      count: number;
      ratio: number;
    }>;
    heavilySaturatedNodeIds: string[];
    criticalSaturationNodeIds: string[];
  };
};

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function collectDrivenNodeIds(motionClip: RigMotionClip | undefined, rootIds: string[]): string[] {
  if (!motionClip) return [...rootIds];
  return Array.from(new Set([
    ...rootIds,
    ...(motionClip.intent.leadNodes || []),
    ...(motionClip.intent.effectorGoals || []).map((goal) => goal.nodeId),
    ...(motionClip.intent.rotationTracks || []).map((track) => track.nodeId),
    ...(motionClip.intent.axialWaves || []).flatMap((wave) => wave.nodeIds),
    ...(motionClip.intent.pins || []).map((pin) => pin.nodeId),
    ...(motionClip.intent.contacts || []).map((contact) => contact.nodeId),
  ]));
}

function validateRigGraph(
  rig: ReturnType<typeof ensureRigIK>,
  errors: string[],
  debug: MotionValidationDebug,
): void {
  const ik = rig.rig_data.ik;
  debug.graph = {
    hasCanonicalIK: Boolean(ik && ik.nodes.length > 0),
    rootCount: ik?.roots.length || 0,
    playableViewIds: Object.entries(ik?.views || {})
      .filter(([, view]) => view.bindings.length > 0)
      .map(([viewId]) => viewId)
      .sort(),
  };
  if (!ik || ik.nodes.length === 0) {
    errors.push("Rig is blocked: canonical IK graph is missing.");
    return;
  }

  if (ik.roots.length === 0) {
    errors.push("Rig is blocked: canonical IK graph has no root node.");
  }

  const hasPlayableView = Object.values(ik.views || {}).some((view) => view.bindings.length > 0);
  if (!hasPlayableView) {
    errors.push("Rig is blocked: canonical IK graph has no playable view bindings.");
  }
}

function validateDrivenChains(
  rig: ReturnType<typeof ensureRigIK>,
  motionClip: RigMotionClip,
  errors: string[],
  debug: MotionValidationDebug,
): void {
  const nodeMap = new Map((rig.rig_data.ik?.nodes || []).map((node) => [node.id, node]));

  debug.drivenChains = [];
  (motionClip.intent.axialWaves || []).forEach((wave, index) => {
    const disconnectedAt = wave.nodeIds.findIndex((nodeId, index) => {
      if (index === 0) return false;
      return nodeMap.get(nodeId)?.parent !== wave.nodeIds[index - 1];
    });
    const chainId = wave.chainId || `unnamed_${index}`;

    debug.drivenChains.push({
      chainId,
      nodeIds: [...wave.nodeIds],
      continuous: disconnectedAt === -1,
    });

    if (wave.nodeIds.length < 2) {
      errors.push(`Clip is blocked: driven chain '${chainId}' has fewer than two nodes.`);
      return;
    }

    if (disconnectedAt !== -1) {
      errors.push(`Clip is blocked: driven chain '${chainId}' is not a continuous parent-child sequence.`);
    }
  });
}

function collectCriticalMotionNodeIds(motionClip: RigMotionClip): string[] {
  return Array.from(new Set([
    ...(motionClip.intent.effectorGoals || []).map((goal) => goal.nodeId),
    ...(motionClip.intent.rotationTracks || []).map((track) => track.nodeId),
    ...(motionClip.intent.axialWaves || []).flatMap((wave) => wave.nodeIds),
    ...(motionClip.intent.pins || []).map((pin) => pin.nodeId),
    ...(motionClip.intent.contacts || []).map((contact) => contact.nodeId),
  ]));
}

function validatePlayableCoverage(
  rig: ReturnType<typeof ensureRigIK>,
  motionClip: RigMotionClip,
  errors: string[],
  debug: MotionValidationDebug,
): MotionValidationDebug["playableCoverage"] | undefined {
  const ik = rig.rig_data.ik;
  if (!ik) return undefined;

  const activeView = motionClip.view || ik.defaultView || Object.keys(ik.views || {}).sort()[0];
  if (!activeView || !ik.views[activeView]) {
    errors.push("Clip is blocked: no playable rig view is available for this motion.");
    return undefined;
  }

  const bindingNodeIds = new Set(ik.views[activeView].bindings.map((binding) => binding.nodeId));
  const missingNodeIds = collectDrivenNodeIds(motionClip, ik.roots).filter((nodeId) => !bindingNodeIds.has(nodeId));
  const coverage = {
    activeView,
    requiredNodeIds: collectDrivenNodeIds(motionClip, ik.roots).sort(),
    boundNodeCount: bindingNodeIds.size,
    missingNodeIds: [...missingNodeIds].sort(),
  };
  debug.playableCoverage = coverage;
  if (missingNodeIds.length > 0) {
    errors.push(`Clip is blocked: view '${activeView}' is missing bindings for ${missingNodeIds.slice(0, 4).join(", ")}.`);
  }

  return coverage;
}

function verifySolvedMotionSamples(params: {
  rig: ReturnType<typeof ensureRigIK>;
  motionClip: RigMotionClip;
  errors: string[];
  warnings: string[];
  debug: MotionValidationDebug;
}): void {
  const coverage = validatePlayableCoverage(params.rig, params.motionClip, params.errors, params.debug);
  if (!coverage?.activeView) return;

  const graph = buildPoseGraph(params.rig, coverage.activeView);
  if (graph.nodes.length === 0 || graph.roots.length === 0) {
    params.errors.push("Clip is blocked: the canonical pose graph is incomplete.");
    return;
  }

  const restPose = createRestPoseState(graph);
  const durationSeconds = estimateMotionClipDuration(params.motionClip);
  const sampleCount = Math.max(8, Math.min(24, Math.ceil(durationSeconds * 8)));
  const saturatedCounts = new Map<string, number>();
  let maxSegmentError = 0;
  let maxPinError = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const timeSeconds = durationSeconds <= 0 ? 0 : (durationSeconds * index) / sampleCount;
    const goals = evaluateMotionIntentAtTime(params.motionClip.intent, graph, timeSeconds);
    const solved = solvePoseFromGoals(graph, goals, restPose);

    graph.nodes.forEach((node) => {
      if (!node.parentId || typeof node.restLength !== "number") return;
      const current = solved.layout.positions[node.id];
      const parent = solved.layout.positions[node.parentId];
      if (!current || !parent) return;
      maxSegmentError = Math.max(maxSegmentError, Math.abs(distance(current, parent) - node.restLength));
    });

    goals.activePins.forEach((pin) => {
      const point = solved.layout.positions[pin.nodeId];
      if (!point) return;
      maxPinError = Math.max(maxPinError, distance(point, { x: pin.x, y: pin.y }));
    });

    solved.saturatedNodeIds.forEach((nodeId) => {
      saturatedCounts.set(nodeId, (saturatedCounts.get(nodeId) || 0) + 1);
    });
  }

  if (maxSegmentError > 2.5) {
    params.errors.push(`Clip is blocked: solver stretched segment lengths by up to ${maxSegmentError.toFixed(1)}px.`);
  }
  if (maxPinError > 3) {
    params.errors.push(`Clip is blocked: animated pins drift by up to ${maxPinError.toFixed(1)}px.`);
  }

  const heavilySaturated = Array.from(saturatedCounts.entries())
    .filter(([, count]) => count / sampleCount >= 0.7)
    .map(([nodeId]) => nodeId)
    .sort();
  const saturatedNodeStats = Array.from(saturatedCounts.entries())
    .map(([nodeId, count]) => ({
      nodeId,
      count,
      ratio: Number((count / sampleCount).toFixed(2)),
    }))
    .sort((left, right) => {
      if (right.ratio !== left.ratio) return right.ratio - left.ratio;
      if (right.count !== left.count) return right.count - left.count;
      return left.nodeId.localeCompare(right.nodeId);
    });

  const criticalNodeIds = new Set(collectCriticalMotionNodeIds(params.motionClip));
  const criticalSaturation = heavilySaturated.filter((nodeId) => criticalNodeIds.has(nodeId));
  params.debug.samples = {
    sampleCount,
    maxSegmentError: Number(maxSegmentError.toFixed(2)),
    maxPinError: Number(maxPinError.toFixed(2)),
    saturatedNodeStats,
    heavilySaturatedNodeIds: heavilySaturated,
    criticalSaturationNodeIds: criticalSaturation,
  };

  if (heavilySaturated.length === 0) return;

  if (criticalSaturation.length > 0) {
    params.errors.push(`Clip is blocked: ${criticalSaturation.slice(0, 4).join(", ")} hit hard angle limits for most sampled frames.`);
    return;
  }

  params.warnings.push(`Clip repeatedly saturates angle limits on ${heavilySaturated.slice(0, 4).join(", ")}.`);
}

export function validateRigForMotion(params: {
  rig: DraftsmanData;
  motion: string;
  style?: string;
  durationSeconds?: number;
  motionClip?: RigMotionClip;
}): MotionValidationResult {
  const rig = ensureRigIK(params.rig);
  const errors: string[] = [];
  const warnings: string[] = [];
  const debug: MotionValidationDebug = {
    graph: {
      hasCanonicalIK: false,
      rootCount: 0,
      playableViewIds: [],
    },
    drivenChains: [],
  };

  validateRigGraph(rig, errors, debug);

  if (params.motionClip) {
    const hasPlayableMotion =
      (params.motionClip.intent.rotationTracks?.length || 0) > 0 ||
      (params.motionClip.intent.axialWaves?.length || 0) > 0 ||
      (params.motionClip.intent.effectorGoals?.length || 0) > 0 ||
      (params.motionClip.intent.rootMotion?.length || 0) > 0;
    const hasDisplayMotion = (params.motionClip.displayKeyframes?.length || 0) > 0;

    if (!hasPlayableMotion && !hasDisplayMotion) {
      errors.push("Clip contains no playable motion data.");
    }

    const playableClip = resolvePlayableMotionClip({
      rig,
      clipId: params.motion,
      motionClip: params.motionClip,
      style: params.style,
      durationSeconds: params.durationSeconds,
    });
    if (!playableClip) {
      errors.push("Clip could not be resolved into a playable IK motion.");
    } else {
      validateDrivenChains(rig, playableClip, errors, debug);
      verifySolvedMotionSamples({
        rig,
        motionClip: playableClip,
        errors,
        warnings,
        debug,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    debug,
  };
}
