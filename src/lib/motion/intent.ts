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

function ensureLoopedRotationSamples(
  samples: Array<{ t: number; rotation: number }>,
): Array<{ t: number; rotation: number }> {
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.rotation))
    .map((sample) => ({ t: round2(clamp(sample.t, 0, 1)), rotation: round2(sample.rotation) }))
    .sort((left, right) => left.t - right.t);
  if (ordered.length === 0) return [];

  const loopStart = ordered[0].t === 0 ? ordered[0] : { ...ordered[0], t: 0 };
  const result = ordered[0].t === 0 ? [...ordered] : [loopStart, ...ordered];
  const last = result[result.length - 1];
  if (last.t < 1 || Math.abs(last.rotation - loopStart.rotation) > 0.1) {
    result.push({ ...loopStart, t: 1 });
  } else if (last.t !== 1) {
    result[result.length - 1] = { ...last, t: 1 };
  }
  return result;
}

function ensureLoopedEffectorSamples(
  samples: Array<{ t: number; x: number; y: number; weight?: number }>,
): Array<{ t: number; x: number; y: number; weight?: number }> {
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.x) && Number.isFinite(sample.y))
    .map((sample) => ({
      t: round2(clamp(sample.t, 0, 1)),
      x: round2(sample.x),
      y: round2(sample.y),
      weight: typeof sample.weight === "number" ? round2(sample.weight) : sample.weight,
    }))
    .sort((left, right) => left.t - right.t);
  if (ordered.length === 0) return [];

  const loopStart = ordered[0].t === 0 ? ordered[0] : { ...ordered[0], t: 0 };
  const result = ordered[0].t === 0 ? [...ordered] : [loopStart, ...ordered];
  const last = result[result.length - 1];
  const sameAsStart =
    Math.abs(last.x - loopStart.x) <= 0.1 &&
    Math.abs(last.y - loopStart.y) <= 0.1 &&
    Math.abs((last.weight ?? 1) - (loopStart.weight ?? 1)) <= 0.05;
  if (last.t < 1 || !sameAsStart) {
    result.push({ ...loopStart, t: 1 });
  } else if (last.t !== 1) {
    result[result.length - 1] = { ...last, t: 1 };
  }
  return result;
}

function ensureLoopedRootSamples(
  samples: Array<{ t: number; x?: number; y?: number; rotation?: number }>,
): Array<{ t: number; x?: number; y?: number; rotation?: number }> {
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.t))
    .map((sample) => ({
      t: round2(clamp(sample.t, 0, 1)),
      x: typeof sample.x === "number" ? round2(sample.x) : undefined,
      y: typeof sample.y === "number" ? round2(sample.y) : undefined,
      rotation: typeof sample.rotation === "number" ? round2(sample.rotation) : undefined,
    }))
    .sort((left, right) => left.t - right.t);
  if (ordered.length === 0) return [];

  const loopStart = ordered[0].t === 0 ? ordered[0] : { ...ordered[0], t: 0 };
  const result = ordered[0].t === 0 ? [...ordered] : [loopStart, ...ordered];
  const last = result[result.length - 1];
  const sameAsStart =
    Math.abs((last.x ?? 0) - (loopStart.x ?? 0)) <= 0.1 &&
    Math.abs((last.y ?? 0) - (loopStart.y ?? 0)) <= 0.1 &&
    Math.abs((last.rotation ?? 0) - (loopStart.rotation ?? 0)) <= 0.1;
  if (last.t < 1 || !sameAsStart) {
    result.push({ ...loopStart, t: 1 });
  } else if (last.t !== 1) {
    result[result.length - 1] = { ...last, t: 1 };
  }
  return result;
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

function locomotionEnergy(mode: MotionSpec["locomotion"]["mode"]): number {
  if (mode === "translate") return 1;
  if (mode === "arc") return 0.9;
  if (mode === "bounce_on_contact") return 1.05;
  if (mode === "slide_on_contact") return 0.85;
  if (mode === "stop_at_contact") return 0.7;
  return 0.55;
}

function baseWaveAmplitudeForSpec(
  motionSpec: Pick<MotionSpec, "amplitude" | "intensity" | "locomotion">,
): number {
  const amplitude = clamp(motionSpec.amplitude || 1, 0.02, 2);
  const intensity = clamp(motionSpec.intensity || 0.5, 0, 1);
  return 0.25 + (amplitude * 3.4) + (intensity * 1.8 * locomotionEnergy(motionSpec.locomotion.mode));
}

function waveFrequencyForSpec(
  motionSpec: Pick<MotionSpec, "tempo" | "locomotion">,
): number {
  const safeTempo = Math.max(0.35, motionSpec.tempo || 1);
  if (motionSpec.locomotion.mode === "none") return Math.max(0.2, safeTempo * 0.55);
  if (motionSpec.locomotion.mode === "arc") return Math.max(0.28, safeTempo * 0.82);
  if (motionSpec.locomotion.mode === "stop_at_contact") return Math.max(0.25, safeTempo * 0.68);
  if (motionSpec.locomotion.mode === "bounce_on_contact") return Math.max(0.45, safeTempo * 1.08);
  return safeTempo;
}

function waveFalloffForChain(
  chain: MotionTopologyChain,
  mode: MotionSpec["locomotion"]["mode"],
): "uniform" | "tip_bias" | "root_bias" {
  if (mode === "none") return chain.primary ? "root_bias" : "uniform";
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

function defaultWavePhase(
  chain: MotionTopologyChain,
  index: number,
  mode: MotionSpec["locomotion"]["mode"],
): number {
  if (mode === "none") {
    // In-place idles/breathing are mostly unified, but offset slightly
    return chain.primary ? 0 : index * 0.08;
  }
  
  // Locomotion (Walk/Run/Swim/Fly)
  // We MUST alternate phases so the character doesn't "bunny hop" with both legs swinging in sync.
  // Chain 0 (Leg A) = 0.0
  // Chain 1 (Leg B) = 0.5 (Opposite leg swings back)
  // Chain 2 (Arm A) = 0.5 (Opposite phase to Leg A, contralateral)
  // Chain 3 (Arm B) = 0.0 (Opposite phase to Arm A)
  const isOpposingPhase = index % 2 !== 0;
  
  // Arms usually swing slightly behind the legs, add a tiny drag offset (0.12)
  const drag = chain.primary ? 0 : 0.12; 
  return (isOpposingPhase ? 0.5 : 0.0) + drag;
}

function branchWaveMultiplier(mode: MotionSpec["locomotion"]["mode"]): number {
  if (mode === "none") return 0.18;
  if (mode === "arc") return 0.24;
  if (mode === "bounce_on_contact") return 0.26;
  return 0.22;
}

function defaultWavesForTopology(
  rig: ReturnType<typeof ensureRigIK>,
  topology: MotionTopology,
  motionSpec: Pick<MotionSpec, "motionFamily" | "tempo" | "amplitude" | "intensity" | "locomotion">,
): RigMotionIntent["axialWaves"] {
  const nodeMap = new Map((rig.rig_data.ik?.nodes || []).map((node) => [node.id, node]));
  const frequency = waveFrequencyForSpec(motionSpec);
  const baseAmplitude = baseWaveAmplitudeForSpec(motionSpec);
  const primarySpan = Math.max(1, topology.primaryChain?.span || 1);
  const secondaryMultiplier = branchWaveMultiplier(motionSpec.locomotion.mode);

  return topology.chains.flatMap((chain, index) => {
    if (chain.nodeIds.length < 2) return [];
    const terminalNode = nodeMap.get(chain.terminalNodeId);
    const spanRatio = Math.max(0.18, Math.min(1, chain.span / primarySpan));
    if (!chain.primary && terminalNode?.ikRole === "decorative") return [];
    if (!chain.primary && spanRatio < 0.24) return [];
    const chainAmplitude = chain.primary ? baseAmplitude : baseAmplitude * secondaryMultiplier * spanRatio;
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
      phase: defaultWavePhase(chain, index, motionSpec.locomotion.mode),
      falloff: waveFalloffForChain(chain, motionSpec.locomotion.mode),
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

  const normalizedIntent: RigMotionIntent = {
    ...intent,
    rootMotion: ensureLoopedRootSamples(intent.rootMotion || []),
    effectorGoals: (intent.effectorGoals || [])
      .filter((goal) => validNodeIds.has(goal.nodeId))
      .map((goal) => ({
        ...goal,
        samples: ensureLoopedEffectorSamples(goal.samples || []),
      }))
      .filter((goal) => goal.samples.length > 0),
    rotationTracks: (intent.rotationTracks || [])
      .filter((track) => validNodeIds.has(track.nodeId))
      .map((track) => ({
        ...track,
        samples: ensureLoopedRotationSamples((track.samples || [])
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
          })),
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
      falloff: candidate.sourceChain ? waveFalloffForChain(candidate.sourceChain, intent.locomotion.mode) : wave.falloff,
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
        locomotion: {
          mode: normalizedIntent.locomotion.mode,
          preferredDirection: normalizedIntent.locomotion.direction,
        },
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

function deriveRootMotionFromSpec(
  motionSpec: MotionSpec,
): RigMotionIntent["rootMotion"] {
  // If we are stationary, no body bobbing
  if (motionSpec.locomotion.mode === "none" || motionSpec.locomotion.mode === "slide_on_contact") {
    return [];
  }
  
  // If moving, bounce the body to simulate weight shift
  // A walk cycle operates roughly at 2x the frequency of the leg swing
  // (the body goes up when legs cross, down when legs extend)
  // We'll create a simple 2-beat sine approximation over the 0-1 phase.
  const bounceAmp = motionSpec.locomotion.mode === "bounce_on_contact" ? 18 : 
                    motionSpec.locomotion.mode === "arc" ? 6 : 10;
                    
  const scale = motionSpec.amplitude || 1;
  const h = bounceAmp * scale;

  return [
    { t: 0.00, y: 0 },
    { t: 0.25, y: h },
    { t: 0.50, y: 0 },
    { t: 0.75, y: h },
    { t: 1.00, y: 0 }
  ];
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
      mode: params.motionSpec.locomotion.mode,
      direction: params.motionSpec.locomotion.preferredDirection,
    },
    rootMotion: params.motionSpec.rootMotion && params.motionSpec.rootMotion.length > 0
      ? params.motionSpec.rootMotion
      : deriveRootMotionFromSpec(params.motionSpec),
    effectorGoals: [],
    rotationTracks: [],
    axialWaves: params.motionSpec.axialWaves && params.motionSpec.axialWaves.length > 0
      ? params.motionSpec.axialWaves
      : deriveAxialWavesFromSpec(rig, params.motionSpec),
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
