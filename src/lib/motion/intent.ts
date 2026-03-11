import { ensureRigIK } from "../ik/graph";
import { Point, PoseGraph } from "../ik/graph";
import { RigMotionClip, RigMotionIntent } from "../schema/rig";
import { MotionSpec } from "../schema/motion_spec";
import { buildMotionTopology, isContinuousNodeChain, MotionTopology, MotionTopologyChain } from "./topology";

export type EvaluatedMotionGoals = {
  normalizedTime: number;
  rootOffset?: { x: number; y: number; rotation?: number };
  effectorTargets: Array<{ nodeId: string; target: Point; weight: number }>;
  axialRotations: Record<string, number>;
  activePins: Array<{ nodeId: string; x: number; y: number }>;
  activeContacts: Array<{ nodeId: string; target: "ground" | "wall" | "water" }>;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function interpolateSamples<T extends { t: number }>(
  samples: T[],
  normalizedTime: number,
): [T, T, number] | undefined {
  if (samples.length === 0) return undefined;
  const ordered = [...samples].sort((left, right) => left.t - right.t);
  if (normalizedTime <= ordered[0].t) return [ordered[0], ordered[0], 0];
  if (normalizedTime >= ordered[ordered.length - 1].t) {
    return [ordered[ordered.length - 1], ordered[ordered.length - 1], 0];
  }

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (normalizedTime < current.t || normalizedTime > next.t) continue;
    const span = Math.max(0.0001, next.t - current.t);
    return [current, next, (normalizedTime - current.t) / span];
  }

  return [ordered[ordered.length - 1], ordered[ordered.length - 1], 0];
}

function lerpOptional(from: number | undefined, to: number | undefined, alpha: number): number | undefined {
  if (from === undefined && to === undefined) return undefined;
  const start = from ?? to ?? 0;
  const end = to ?? from ?? 0;
  return round2(start + ((end - start) * alpha));
}

function normalizedPhase(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const wrapped = ((timeSeconds % durationSeconds) + durationSeconds) % durationSeconds;
  return wrapped / durationSeconds;
}

function clampWaveAmplitude(
  rig: ReturnType<typeof ensureRigIK>,
  nodeIds: string[],
  requestedAmplitude: number,
  ratio = 0.72,
): number {
  const nodeMap = new Map((rig.rig_data.ik?.nodes || []).map((node) => [node.id, node]));
  const bounded = nodeIds
    .map((nodeId) => nodeMap.get(nodeId)?.rotationLimit)
    .filter((limit): limit is [number, number] => Boolean(limit))
    .map((limit) => Math.min(Math.abs(limit[0]), Math.abs(limit[1])) * ratio);

  if (bounded.length === 0) return round2(requestedAmplitude);
  return round2(Math.min(requestedAmplitude, ...bounded));
}

function usableRotationLimitForNode(
  node: { rotationLimit?: number[] } | undefined,
  childCount: number,
): [number, number] | undefined {
  const limit = node?.rotationLimit && node.rotationLimit.length >= 2
    ? [node.rotationLimit[0], node.rotationLimit[1]] as [number, number]
    : undefined;
  if (!limit) return undefined;

  const ratio = childCount > 0 ? 0.72 : 0.8;
  const mid = (limit[0] + limit[1]) * 0.5;
  const halfSpan = Math.abs(limit[1] - limit[0]) * 0.5;
  const insetHalf = Math.max(halfSpan * ratio, Math.min(halfSpan, 2));
  if (!Number.isFinite(insetHalf) || insetHalf <= 0) return limit;

  return [
    round2(mid - insetHalf),
    round2(mid + insetHalf),
  ];
}

function normalizeWaveNodeIds(
  wave: NonNullable<RigMotionIntent["axialWaves"]>[number],
  fallbackNodeIds: string[],
  validNodeIds: Set<string>,
): string[] {
  const preferred = wave.nodeIds.filter((nodeId) => validNodeIds.has(nodeId));
  if (preferred.length >= 2) return preferred;
  return fallbackNodeIds.filter((nodeId) => validNodeIds.has(nodeId));
}

function familySupportsDefaultWaves(family: RigMotionIntent["family"]): boolean {
  return family !== "custom";
}

function baseWaveAmplitudeForFamily(family: MotionSpec["motionFamily"]): number {
  if (family === "idle") return 2.4;
  if (family === "halt") return 3.8;
  if (family === "turn") return 5.2;
  if (family === "jump") return 5.8;
  if (family === "wave") return 6;
  if (family === "drive" || family === "retreat") return 6.4;
  if (family === "drift" || family === "hover") return 6.8;
  if (family === "walk") return 7.8;
  if (family === "glide") return 8.4;
  if (family === "run") return 9.2;
  if (family === "swim") return 10.5;
  if (family === "crash") return 11;
  return 6.5;
}

function waveFrequencyForFamily(family: MotionSpec["motionFamily"], tempo: number): number {
  const safeTempo = Math.max(0.35, tempo);
  if (family === "idle") return Math.max(0.2, safeTempo * 0.5);
  if (family === "halt") return Math.max(0.25, safeTempo * 0.65);
  if (family === "crash") return Math.max(0.45, safeTempo * 1.1);
  if (family === "turn") return Math.max(0.4, safeTempo * 0.8);
  return safeTempo;
}

function waveFalloffForChain(chain: MotionTopologyChain, family: MotionSpec["motionFamily"]): "uniform" | "tip_bias" | "root_bias" {
  if (family === "idle") return chain.primary ? "root_bias" : "uniform";
  if (chain.primary) return "tip_bias";
  return "uniform";
}

function expandWaveAcrossTopology(
  wave: NonNullable<RigMotionIntent["axialWaves"]>[number],
  topology: MotionTopology,
  validNodeIds: Set<string>,
): Array<{ nodeIds: string[]; sourceChain?: MotionTopologyChain }> {
  const preferred = wave.nodeIds.filter((nodeId) => validNodeIds.has(nodeId));
  if (preferred.length >= 2 && isContinuousNodeChain(preferred, topology.parentByNode)) {
    return [{ nodeIds: preferred }];
  }

  const matches = topology.chains
    .filter((chain) => chain.nodeIds.some((nodeId) => preferred.includes(nodeId)))
    .map((chain) => ({ nodeIds: normalizeWaveNodeIds(wave, chain.nodeIds, validNodeIds), sourceChain: chain }))
    .filter((candidate) => candidate.nodeIds.length >= 2);

  if (matches.length > 0) {
    const seen = new Set<string>();
    return matches.filter((candidate) => {
      const key = candidate.nodeIds.join(">");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (topology.primaryChain) {
    return [{ nodeIds: normalizeWaveNodeIds(wave, topology.primaryChain.nodeIds, validNodeIds), sourceChain: topology.primaryChain }]
      .filter((candidate) => candidate.nodeIds.length >= 2);
  }

  return [];
}

function defaultWavePhase(chain: MotionTopologyChain, index: number, family: MotionSpec["motionFamily"]): number {
  if (family === "idle") return index * 0.08;
  if (chain.primary) return 0;
  return 0.14 + (index * 0.1);
}

function defaultWavesForTopology(
  rig: ReturnType<typeof ensureRigIK>,
  topology: MotionTopology,
  motionSpec: Pick<MotionSpec, "motionFamily" | "tempo" | "amplitude" | "intensity">,
): RigMotionIntent["axialWaves"] {
  if (!familySupportsDefaultWaves(motionSpec.motionFamily)) return [];
  const amplitude = motionSpec.amplitude || 1;
  const intensity = motionSpec.intensity || 0.5;
  const frequency = waveFrequencyForFamily(motionSpec.motionFamily, motionSpec.tempo || 1);
  const baseAmplitude = baseWaveAmplitudeForFamily(motionSpec.motionFamily) * amplitude * (0.55 + (intensity * 0.8));

  return topology.chains.flatMap((chain, index) => {
    if (chain.nodeIds.length < 2) return [];
    const chainAmplitude = chain.primary ? baseAmplitude : baseAmplitude * 0.38;
    if (motionSpec.motionFamily === "idle" && !chain.primary) return [];
    return [{
      chainId: chain.id,
      nodeIds: chain.nodeIds,
      amplitudeDeg: clampWaveAmplitude(
        rig,
        chain.nodeIds,
        round2(chainAmplitude),
        chain.primary ? 0.72 : 0.5,
      ),
      frequency,
      phase: defaultWavePhase(chain, index, motionSpec.motionFamily),
      falloff: waveFalloffForChain(chain, motionSpec.motionFamily),
    }];
  });
}

export function sanitizeMotionIntentForRig(
  rigInput: ReturnType<typeof ensureRigIK> | Parameters<typeof ensureRigIK>[0],
  intent: RigMotionIntent | undefined,
): RigMotionIntent | undefined {
  if (!intent) return undefined;
  const rig = "svg_data" in rigInput ? ensureRigIK(rigInput) : rigInput;
  const nodeMap = new Map((rig.rig_data.ik?.nodes || []).map((node) => [node.id, node]));
  const validNodeIds = new Set((rig.rig_data.ik?.nodes || []).map((node) => node.id));
  const topology = buildMotionTopology(rig);
  const family = intent.family;

  const normalizedIntent: RigMotionIntent = {
    ...intent,
    effectorGoals: (intent.effectorGoals || []).filter((goal) => validNodeIds.has(goal.nodeId)),
    rotationTracks: (intent.rotationTracks || [])
      .filter((track) => validNodeIds.has(track.nodeId))
      .map((track) => ({
        ...track,
        samples: (track.samples || [])
          .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.rotation))
          .map((sample) => {
            const usableLimit = usableRotationLimitForNode(
              nodeMap.get(track.nodeId),
              topology.childIdsByNode.get(track.nodeId)?.length || 0,
            );
            return {
              ...sample,
              rotation: usableLimit ? round2(clamp(sample.rotation, usableLimit[0], usableLimit[1])) : sample.rotation,
            };
          }),
      }))
      .filter((track) => track.samples.length > 0),
    contacts: (intent.contacts || []).filter((contact) => validNodeIds.has(contact.nodeId)),
    pins: (intent.pins || []).filter((pin) => validNodeIds.has(pin.nodeId)),
    leadNodes: (intent.leadNodes || []).filter((nodeId) => validNodeIds.has(nodeId)),
    axialWaves: (intent.axialWaves || []).flatMap((wave) => expandWaveAcrossTopology(wave, topology, validNodeIds).map((candidate, index) => ({
      ...wave,
      chainId: candidate.sourceChain?.id || wave.chainId || `${wave.chainId || "wave"}_${index}`,
      nodeIds: candidate.nodeIds,
      amplitudeDeg: clampWaveAmplitude(
        rig,
        candidate.nodeIds,
        wave.amplitudeDeg,
        candidate.sourceChain?.primary ? 0.72 : 0.5,
      ),
      falloff: candidate.sourceChain ? waveFalloffForChain(candidate.sourceChain, family) : wave.falloff,
    }))),
  };

  const leadNodes = normalizedIntent.leadNodes.length > 0
    ? normalizedIntent.leadNodes
    : Array.from(new Set([
        ...topology.rootNodeIds,
        ...(topology.primaryChain ? topology.primaryChain.nodeIds.slice(0, 2) : []),
      ]));

  const axialWaves = normalizedIntent.rotationTracks.length > 0 || normalizedIntent.axialWaves.length > 0
    ? normalizedIntent.axialWaves
    : defaultWavesForTopology(rig, topology, {
        motionFamily: normalizedIntent.family,
        tempo: 1,
        amplitude: 1,
        intensity: 0.5,
      });

  return {
    ...normalizedIntent,
    leadNodes,
    axialWaves,
    notes: `${normalizedIntent.notes || ""} [sanitized-for-rig]`.trim(),
  };
}

function deriveAxialWavesFromSpec(
  rig: ReturnType<typeof ensureRigIK>,
  motionSpec: MotionSpec,
): RigMotionIntent["axialWaves"] {
  return defaultWavesForTopology(rig, buildMotionTopology(rig), motionSpec);
}

export function estimateMotionClipDuration(motionClip: RigMotionClip | undefined): number {
  if (!motionClip) return 2;
  const displayDuration = (motionClip.displayKeyframes || []).reduce((max, keyframe) => {
    const repeat = keyframe.repeat ?? 0;
    const cycles = repeat === -1 ? 2 : repeat + 1;
    const cycleMultiplier = keyframe.yoyo ? 2 : 1;
    const endTime = (keyframe.delay ?? 0) + (keyframe.duration || 0.5) * cycles * cycleMultiplier;
    return Math.max(max, endTime);
  }, 0);
  return Math.max(0.5, motionClip.intent?.duration || 0, displayDuration || 0);
}

export function buildMotionIntentFromSpec(params: {
  rig: ReturnType<typeof ensureRigIK> | Parameters<typeof ensureRigIK>[0];
  motion: string;
  durationSeconds: number;
  motionSpec: MotionSpec;
}): RigMotionIntent {
  const rig = "svg_data" in params.rig ? ensureRigIK(params.rig) : params.rig;
  const nodeByBoneId = new Map<string, string>();
  (rig.rig_data.ik?.nodes || []).forEach((node) => {
    (node.sourceBoneIds || []).forEach((boneId) => nodeByBoneId.set(boneId, node.id));
  });
  Object.values(rig.rig_data.ik?.views || {}).forEach((view) => {
    view.bindings.forEach((binding) => nodeByBoneId.set(binding.boneId, binding.nodeId));
  });

  const contacts = (params.motionSpec.contacts || []).flatMap((contact) => {
    const nodeId = nodeByBoneId.get(contact.boneId);
    if (!nodeId || contact.target === "none") return [];
    return [{
      nodeId,
      target: contact.target,
      t0: contact.phaseStart,
      t1: contact.phaseEnd,
    }];
  });

  const leadNodes = Array.from(new Set(
    (params.motionSpec.leadBones || [])
      .map((boneId) => nodeByBoneId.get(boneId))
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  ));

  return sanitizeMotionIntentForRig(rig, {
    family: params.motionSpec.motionFamily,
    duration: round2(params.durationSeconds),
    locomotion: {
      mode: params.motionSpec.locomotion.mode === "translate" || params.motionSpec.locomotion.mode === "arc"
        ? params.motionSpec.locomotion.mode
        : "none",
      direction: params.motionSpec.locomotion.preferredDirection,
    },
    rootMotion: [],
    effectorGoals: [],
    rotationTracks: [],
    axialWaves: deriveAxialWavesFromSpec(rig, params.motionSpec),
    contacts,
    pins: [],
    leadNodes,
    notes: params.motionSpec.notes || `Solver-native motion intent for ${params.motion}.`,
  })!;
}

export function evaluateMotionIntentAtTime(
  intent: RigMotionIntent | undefined,
  graph: PoseGraph,
  timeSeconds: number,
): EvaluatedMotionGoals {
  const durationSeconds = intent?.duration || 1;
  const normalizedTime = normalizedPhase(timeSeconds, durationSeconds);
  const rootSample = interpolateSamples(intent?.rootMotion || [], normalizedTime);
  const trackedRotations = (intent?.rotationTracks || []).reduce<Record<string, number>>((acc, track) => {
    const samples = interpolateSamples(track.samples || [], normalizedTime);
    if (!samples) return acc;
    const [from, to, alpha] = samples;
    acc[track.nodeId] = round2(from.rotation + ((to.rotation - from.rotation) * alpha));
    return acc;
  }, {});
  const effectorTargets = (intent?.effectorGoals || []).flatMap((goal) => {
    const samples = interpolateSamples(goal.samples, normalizedTime);
    if (!samples) return [];
    const [from, to, alpha] = samples;
    return [{
      nodeId: goal.nodeId,
      target: {
        x: round2((from.x + ((to.x - from.x) * alpha))),
        y: round2((from.y + ((to.y - from.y) * alpha))),
      },
      weight: from.weight ?? to.weight ?? 1,
    }];
  });

  const axialRotations = (intent?.axialWaves || []).reduce<Record<string, number>>((acc, wave) => {
    const nodeIds = wave.nodeIds.filter((nodeId) => graph.nodeMap.has(nodeId));
    if (nodeIds.length === 0) return acc;

    nodeIds.forEach((nodeId, index) => {
      const progress = nodeIds.length <= 1 ? 0 : index / (nodeIds.length - 1);
      const falloff = wave.falloff === "tip_bias"
        ? 0.4 + (progress * 0.9)
        : wave.falloff === "root_bias"
          ? 1.2 - (progress * 0.7)
          : 1;
      const phaseOffset = wave.phase + (progress * 0.16);
      const scalar = Math.sin((Math.PI * 2 * wave.frequency * normalizedTime) - (phaseOffset * Math.PI * 2));
      acc[nodeId] = round2((acc[nodeId] || 0) + (wave.amplitudeDeg * falloff * scalar));
    });

    return acc;
  }, {});

  const activePins = (intent?.pins || [])
    .filter((pin) => normalizedTime >= pin.t0 && normalizedTime <= pin.t1)
    .map((pin) => ({ nodeId: pin.nodeId, x: pin.x, y: pin.y }));

  const activeContacts = (intent?.contacts || [])
    .filter((contact) => normalizedTime >= contact.t0 && normalizedTime <= contact.t1)
    .map((contact) => ({ nodeId: contact.nodeId, target: contact.target }));

  return {
    normalizedTime,
    rootOffset: rootSample
      ? {
          x: lerpOptional(rootSample[0].x, rootSample[1].x, rootSample[2]) || 0,
          y: lerpOptional(rootSample[0].y, rootSample[1].y, rootSample[2]) || 0,
          rotation: lerpOptional(rootSample[0].rotation, rootSample[1].rotation, rootSample[2]),
        }
      : undefined,
    effectorTargets,
    axialRotations: {
      ...axialRotations,
      ...trackedRotations,
    },
    activePins,
    activeContacts,
  };
}
