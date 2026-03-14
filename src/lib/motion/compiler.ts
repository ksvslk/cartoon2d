import { DraftsmanData, RigMotionIntent } from "../schema/rig";
import {
  BackgroundAmbientBinding,
  CompiledSceneData,
  SceneInstanceTrack,
  StoryBeatData,
  TransformKeyframe,
  SpatialTransform,
  ClipBinding,
  SceneObstacle,
  StageOrientation,
  getStageDims,
} from "../schema/story";
import { ensureRigIK } from "../ik/graph";
import { inferRigMotionAffordance, inferRigProfile } from "./affordance";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "./semantics";
import { clampTargetAgainstObstacles, detectSceneObstacles } from "./collision";
import { motionClipToIKPlayback, resolvePlayableMotionClip } from "./compiled_ik";

const BASE_OBJECT_CLIP_ID = "base_object";

function resolveClipId(rig: DraftsmanData | undefined, motion: string): string | undefined {
  if (!rig?.rig_data.motion_clips) return undefined;
  const normalized = normalizeMotionKey(motion);
  return suggestMotionAliases(normalized).find(alias => rig.rig_data.motion_clips?.[alias]);
}

function resolveClipView(rig: DraftsmanData | undefined, clipId: string | undefined): string | undefined {
  if (!clipId) return undefined;
  return rig?.rig_data.motion_clips?.[clipId]?.view;
}

function countAttachmentWarnings(rig: DraftsmanData | undefined): number {
  if (!rig) return 0;
  const warnings = ensureRigIK(rig).rig_data.ik?.aiReport?.warnings || [];
  return warnings.filter((warning) => /attachment gap|no explicit attachment socket/i.test(warning)).length;
}

export function inferTransformOnlyPlaybackPolicy(
  rig: DraftsmanData | undefined,
  motion: string,
): { prefer: boolean; reason?: string } {
  if (!rig || !motionNeedsTarget(motion)) {
    return { prefer: false };
  }

  const normalizedRig = ensureRigIK(rig);
  const affordance = inferRigMotionAffordance(normalizedRig);
  const rigProfileReport = normalizedRig.rig_data.profile_report ?? inferRigProfile(normalizedRig);
  const confidence = normalizedRig.rig_data.ik?.aiReport?.confidence ?? 1;
  const attachmentWarnings = countAttachmentWarnings(normalizedRig);
  const minimalTopology = affordance.primaryChainLength <= 2 && affordance.effectors <= 1;

  if (rigProfileReport.profile === "rigid_object") {
    return {
      prefer: true,
      reason: `rig profile ${rigProfileReport.profile}`,
    };
  }

  if (affordance.deformationBudget <= 0.28) {
    return {
      prefer: true,
      reason: `low deformation budget (${affordance.deformationBudget})`,
    };
  }

  if (confidence < 0.45 && attachmentWarnings >= 2) {
    return {
      prefer: true,
      reason: `low IK confidence (${confidence.toFixed(2)}) with ${attachmentWarnings} attachment warnings`,
    };
  }

  if (rigProfileReport.profile === "limited_articulation" && confidence < 0.5 && attachmentWarnings >= 1) {
    return {
      prefer: true,
      reason: `limited articulation with soft IK confidence (${confidence.toFixed(2)})`,
    };
  }

  if (minimalTopology) {
    return {
      prefer: true,
      reason: "no long continuous chain or usable end effectors",
    };
  }

  return { prefer: false };
}

function resolveTransformOnlyView(
  rig: DraftsmanData | undefined,
  startTransform: SpatialTransform,
  finalTarget?: SpatialTransform,
  clipView?: string,
): string | undefined {
  if (!rig) return clipView;
  const normalizedRig = ensureRigIK(rig);
  const availableViews = Object.keys(normalizedRig.rig_data.ik?.views || {}).sort();
  
  // Always respect explicit clip views if they exist
  if (clipView && availableViews.includes(clipView)) return clipView;

  // Otherwise infer based on travel distance, falling back to default view
  const deltaX = (finalTarget?.x ?? startTransform.x) - startTransform.x;
  if (deltaX < -10 && availableViews.includes("view_side_left")) return "view_side_left";
  if (deltaX > 10 && availableViews.includes("view_side_right")) return "view_side_right";

  return normalizedRig.rig_data.ik?.defaultView || availableViews[0];
}

function inferCollisionBehavior(action: StoryBeatData["actions"][number], narrative: string): "halt" | "slide" | "bounce" {
  const explicit = action.animation_overrides?.collision_behavior;
  if (explicit) return explicit;

  const haystack = `${action.motion} ${action.style || ""} ${narrative}`.toLowerCase();
  if (/bounce|rebound|ricochet/.test(haystack)) return "bounce";
  if (/slide|glide|swim|drift|fly|slither|skate|cruise/.test(haystack)) return "slide";
  return "halt";
}

function shouldClampTargetAgainstObstacles(action: StoryBeatData["actions"][number]): boolean {
  if (action.animation_overrides?.collision_behavior) return true;
  return !action.target_spatial_transform;
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeDegrees(value: number): number {
  let next = value;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return round2(next);
}

type WholeObjectMotionSample = {
  t: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

function lerp(from: number, to: number, alpha: number): number {
  return round2(from + ((to - from) * alpha));
}

function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = normalizeDegrees(to - from);
  return normalizeDegrees(from + (delta * alpha));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function unwrapDegreesSequence(values: number[]): number[] {
  if (values.length === 0) return [];
  const unwrapped = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    let next = values[index];
    let delta = next - unwrapped[index - 1];
    while (delta > 180) {
      next -= 360;
      delta = next - unwrapped[index - 1];
    }
    while (delta < -180) {
      next += 360;
      delta = next - unwrapped[index - 1];
    }
    unwrapped.push(next);
  }
  return unwrapped;
}

function catmullRomInterpolate(p0: number, p1: number, p2: number, p3: number, alpha: number): number {
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const a2 = -0.5 * p0 + 0.5 * p2;
  const a3 = p1;
  return (((a0 * alpha + a1) * alpha + a2) * alpha) + a3;
}

function findSampleSegment(samples: WholeObjectMotionSample[], normalizedTime: number): number {
  for (let index = 0; index < samples.length - 1; index += 1) {
    if (normalizedTime <= samples[index + 1].t) {
      return index;
    }
  }
  return samples.length - 2;
}

function sampleWholeObjectAxis(
  samples: WholeObjectMotionSample[],
  normalizedTime: number,
  accessor: (sample: WholeObjectMotionSample) => number,
): number {
  if (samples.length === 0) return 0;
  if (normalizedTime <= samples[0].t) return accessor(samples[0]);
  if (normalizedTime >= samples[samples.length - 1].t) return accessor(samples[samples.length - 1]);

  const segmentIndex = findSampleSegment(samples, normalizedTime);
  const s0 = samples[Math.max(0, segmentIndex - 1)];
  const s1 = samples[segmentIndex];
  const s2 = samples[Math.min(samples.length - 1, segmentIndex + 1)];
  const s3 = samples[Math.min(samples.length - 1, segmentIndex + 2)];
  const span = Math.max(0.0001, s2.t - s1.t);
  const alpha = clamp((normalizedTime - s1.t) / span, 0, 1);

  return catmullRomInterpolate(accessor(s0), accessor(s1), accessor(s2), accessor(s3), alpha);
}

function normalizeWholeObjectMotionSamples(params: {
  wholeObjectMotion?: RigMotionIntent["wholeObjectMotion"];
  rootMotionSamples?: Array<{ t: number; x?: number; y?: number; rotation?: number }>;
}): WholeObjectMotionSample[] {
  const wholeObjectAnchors = params.wholeObjectMotion?.anchors || [];
  const source = wholeObjectAnchors.length >= 2
    ? wholeObjectAnchors.map((anchor) => ({
        t: anchor.t,
        x: anchor.x,
        y: anchor.y,
        rotation: anchor.rotation,
        scale: anchor.scale,
      }))
    : (params.rootMotionSamples || []).map((sample) => ({
        t: sample.t,
        x: sample.x,
        y: sample.y,
        rotation: sample.rotation,
        scale: 1,
      }));

  const byTime = new Map<number, WholeObjectMotionSample>();
  source
    .filter((sample) => Number.isFinite(sample.t))
    .forEach((sample) => {
      const t = clamp(sample.t, 0, 1);
      byTime.set(t, {
        t: roundTime(t),
        x: typeof sample.x === "number" ? round2(sample.x) : 0,
        y: typeof sample.y === "number" ? round2(sample.y) : 0,
        rotation: typeof sample.rotation === "number" ? normalizeDegrees(sample.rotation) : 0,
        scale: typeof sample.scale === "number" ? round2(sample.scale) : 1,
      });
    });

  const ordered = Array.from(byTime.values()).sort((left, right) => left.t - right.t);
  if (ordered.length < 2) return [];

  const unwrappedRotations = unwrapDegreesSequence(ordered.map((sample) => sample.rotation));
  return ordered.map((sample, index) => ({
    ...sample,
    rotation: unwrappedRotations[index],
  }));
}

function buildNormalizedBakeTimes(samples: WholeObjectMotionSample[]): number[] {
  const times = new Set<number>([0, 1]);
  samples.forEach((sample) => times.add(roundTime(sample.t)));
  const subdivisionCount = Math.max(16, Math.min(48, (samples.length - 1) * 8));
  for (let index = 0; index <= subdivisionCount; index += 1) {
    times.add(roundTime(index / subdivisionCount));
  }
  return Array.from(times).sort((left, right) => left - right);
}

function resolvePreferredTravelVector(
  startTransform: SpatialTransform,
  endTransform: SpatialTransform,
  preferredDirection?: RigMotionIntent["locomotion"]["direction"],
): { x: number; y: number } {
  const deltaX = endTransform.x - startTransform.x;
  const deltaY = endTransform.y - startTransform.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length > 0.001) {
    return { x: deltaX / length, y: deltaY / length };
  }

  switch (preferredDirection) {
    case "left":
    case "backward":
      return { x: -1, y: 0 };
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    case "right":
    case "forward":
    default:
      return { x: 1, y: 0 };
  }
}

function clampSpatialTransformToStage(transform: SpatialTransform, stageW = 1920, stageH = 1080): SpatialTransform {
  const safeScale = round2(clamp(transform.scale, 0.18, 2.5));
  const marginX = Math.max(110, 140 * safeScale);
  const marginY = Math.max(90, 120 * safeScale);
  return {
    x: round2(clamp(transform.x, marginX, stageW - marginX)),
    y: round2(clamp(transform.y, marginY, stageH - marginY)),
    scale: safeScale,
    rotation: typeof transform.rotation === "number" ? normalizeDegrees(transform.rotation) : undefined,
    flip_x: transform.flip_x,
    flip_y: transform.flip_y,
    z_index: Math.round(clamp(transform.z_index, 0, 100)),
  };
}

function interpolateTransformTrackAtTime(
  track: TransformKeyframe[],
  time: number,
): TransformKeyframe | undefined {
  if (track.length === 0) return undefined;
  const ordered = [...track].sort((left, right) => left.time - right.time);
  if (time <= ordered[0].time) return ordered[0];
  if (time >= ordered[ordered.length - 1].time) return ordered[ordered.length - 1];

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (time < current.time || time > next.time) continue;
    const span = Math.max(0.0001, next.time - current.time);
    const alpha = (time - current.time) / span;
    return {
      time: roundTime(time),
      x: lerp(current.x, next.x, alpha),
      y: lerp(current.y, next.y, alpha),
      scale: lerp(current.scale, next.scale, alpha),
      rotation: lerpAngle(current.rotation ?? 0, next.rotation ?? current.rotation ?? 0, alpha),
      flip_x: alpha < 0.5 ? current.flip_x : next.flip_x,
      flip_y: alpha < 0.5 ? current.flip_y : next.flip_y,
      z_index: alpha < 0.5 ? current.z_index : next.z_index,
    };
  }

  return ordered[ordered.length - 1];
}

function blendRootMotionIntoTransformTrack(params: {
  transformTrack: TransformKeyframe[];
  startTime: number;
  duration: number;
  rootMotionSamples?: Array<{ t: number; x?: number; y?: number; rotation?: number }>;
  wholeObjectMotion?: RigMotionIntent["wholeObjectMotion"];
  preferredDirection?: RigMotionIntent["locomotion"]["direction"];
  stageW?: number;
  stageH?: number;
}): TransformKeyframe[] {
  const {
    transformTrack,
    startTime,
    duration,
    rootMotionSamples,
    wholeObjectMotion,
    preferredDirection,
    stageW = 1920,
    stageH = 1080,
  } = params;
  const motionSamples = normalizeWholeObjectMotionSamples({
    wholeObjectMotion,
    rootMotionSamples,
  });

  if (motionSamples.length < 2 || transformTrack.length === 0) {
    return transformTrack;
  }

  const orderedTrack = uniqueKeyframes(transformTrack);
  const safeDuration = Math.max(0.0001, duration);
  const endTime = roundTime(startTime + safeDuration);
  const baseTrack = orderedTrack.length > 1
    ? orderedTrack
    : [
        orderedTrack[0],
        { ...orderedTrack[0], time: endTime },
      ];
  const reference = motionSamples[0];
  const start = baseTrack[0];
  const end = baseTrack[baseTrack.length - 1];
  const forward = resolvePreferredTravelVector(start, end, preferredDirection);
  const bakeTimes = buildNormalizedBakeTimes(motionSamples);

  const rootMotionKeyframes = bakeTimes.map((normalizedTime) => {
    const time = roundTime(startTime + (safeDuration * normalizedTime));
    const base = interpolateTransformTrackAtTime(baseTrack, time);
    if (!base) return undefined;

    const sample = {
      x: sampleWholeObjectAxis(motionSamples, normalizedTime, (motion) => motion.x),
      y: sampleWholeObjectAxis(motionSamples, normalizedTime, (motion) => motion.y),
      rotation: sampleWholeObjectAxis(motionSamples, normalizedTime, (motion) => motion.rotation),
      scale: sampleWholeObjectAxis(motionSamples, normalizedTime, (motion) => motion.scale),
    };
    const scale = Math.max(0.18, base.scale);
    const localX = sample.x - reference.x;
    const localY = sample.y - reference.y;
    const localRotation = sample.rotation - reference.rotation;
    const scaleMultiplier = Math.max(0.6, sample.scale / Math.max(0.01, reference.scale));

    return {
      ...clampSpatialTransformToStage({
        ...base,
        x: round2(base.x + (localX * scale * forward.x)),
        y: round2(base.y + (localX * scale * forward.y) + (localY * scale)),
        scale: round2(base.scale * scaleMultiplier),
        rotation: normalizeDegrees((base.rotation ?? 0) + localRotation),
      }, stageW, stageH),
      time,
    };
  }).filter((sample): sample is TransformKeyframe => Boolean(sample));

  return uniqueKeyframes([...baseTrack, ...rootMotionKeyframes]);
}

function buildTransformTrackForBinding(params: {
  motionKey: string;
  startTime: number;
  duration: number;
  startTransform: SpatialTransform;
  resolvedTarget?: SpatialTransform;
  finalTarget?: SpatialTransform;
  collisionObstacle?: SceneObstacle | null;
  collisionBehavior: "halt" | "slide" | "bounce";
  rootMotionSamples?: Array<{ t: number; x?: number; y?: number; rotation?: number }>;
  wholeObjectMotion?: RigMotionIntent["wholeObjectMotion"];
  preferredDirection?: RigMotionIntent["locomotion"]["direction"];
  stageW?: number;
  stageH?: number;
}): { transformTrack: TransformKeyframe[]; endTransform?: SpatialTransform; stopTime?: number } {
  const {
    motionKey,
    startTime,
    duration,
    startTransform,
    resolvedTarget,
    finalTarget,
    collisionObstacle,
    collisionBehavior,
    rootMotionSamples,
    wholeObjectMotion,
    preferredDirection,
    stageW = 1920,
    stageH = 1080,
  } = params;

  const endTime = roundTime(startTime + duration);
  const transformTrack: TransformKeyframe[] = [
    { ...clampSpatialTransformToStage(startTransform, stageW, stageH), time: roundTime(startTime) },
  ];

  if (!finalTarget || !motionNeedsTarget(motionKey)) {
    const enrichedTrack = blendRootMotionIntoTransformTrack({
      transformTrack,
      startTime,
      duration,
      rootMotionSamples,
      wholeObjectMotion,
      preferredDirection,
      stageW,
      stageH,
    });
    return {
      transformTrack: enrichedTrack,
      endTransform: undefined,
    };
  }

  if (!collisionObstacle || !resolvedTarget) {
    transformTrack.push({
      ...clampSpatialTransformToStage(finalTarget, stageW, stageH),
      time: endTime,
    });
    const enrichedTrack = blendRootMotionIntoTransformTrack({
      transformTrack,
      startTime,
      duration,
      rootMotionSamples,
      wholeObjectMotion,
      preferredDirection,
      stageW,
      stageH,
    });
    return {
      transformTrack: enrichedTrack,
      endTransform: clampSpatialTransformToStage(finalTarget, stageW, stageH),
    };
  }

  const stopTransform = clampSpatialTransformToStage({
    x: finalTarget.x,
    y: finalTarget.y,
    scale: finalTarget.scale,
    rotation: finalTarget.rotation,
    z_index: finalTarget.z_index,
  }, stageW, stageH);

  if (collisionBehavior === "halt") {
    transformTrack.push({
      ...stopTransform,
      time: endTime,
    });
    const enrichedTrack = blendRootMotionIntoTransformTrack({
      transformTrack,
      startTime,
      duration,
      rootMotionSamples,
      wholeObjectMotion,
      preferredDirection,
      stageW,
      stageH,
    });
    return {
      transformTrack: enrichedTrack,
      endTransform: stopTransform,
      stopTime: endTime,
    };
  }

  if (collisionBehavior === "slide") {
    const obstacleCenterY = collisionObstacle.y + collisionObstacle.height / 2;
    const driftDirection = resolvedTarget.y !== startTransform.y
      ? Math.sign(resolvedTarget.y - startTransform.y) || 1
      : (startTransform.y <= obstacleCenterY ? -1 : 1);
    const driftDistance = Math.min(
      Math.max(60, collisionObstacle.height * 0.18),
      180 * startTransform.scale,
    );
    const slideTransform: SpatialTransform = clampSpatialTransformToStage({
      ...stopTransform,
      y: round2(stopTransform.y + (driftDirection * driftDistance)),
    }, stageW, stageH);
    transformTrack.push({
      ...slideTransform,
      time: endTime,
    });
    const enrichedTrack = blendRootMotionIntoTransformTrack({
      transformTrack,
      startTime,
      duration,
      rootMotionSamples,
      wholeObjectMotion,
      preferredDirection,
      stageW,
      stageH,
    });
    return {
      transformTrack: enrichedTrack,
      endTransform: slideTransform,
      stopTime: endTime,
    };
  }

  const travelDirection = Math.sign((resolvedTarget.x - startTransform.x) || 1) || 1;
  const bounceDistance = Math.min(
    Math.max(70, Math.abs(resolvedTarget.x - stopTransform.x) * 0.65),
    180 * startTransform.scale,
  );
  const bounceTime = roundTime(startTime + (duration * 0.78));
  const bounceTransform: SpatialTransform = clampSpatialTransformToStage({
    ...stopTransform,
    x: round2(stopTransform.x - travelDirection * bounceDistance),
    y: round2(stopTransform.y - Math.min(28 * startTransform.scale, 34)),
  }, stageW, stageH);
  transformTrack.push({
    ...bounceTransform,
    time: bounceTime,
  });
  transformTrack.push({
    ...bounceTransform,
    time: endTime,
  });
  const enrichedTrack = blendRootMotionIntoTransformTrack({
    transformTrack,
    startTime,
    duration,
    rootMotionSamples,
    wholeObjectMotion,
    preferredDirection,
    stageW,
    stageH,
  });
  return {
    transformTrack: enrichedTrack,
    endTransform: bounceTransform,
    stopTime: endTime,
  };
}

function uniqueKeyframes(track: TransformKeyframe[]): TransformKeyframe[] {
  const byKey = new Map<string, TransformKeyframe>();
  for (const keyframe of track) {
    byKey.set(
      `${keyframe.time}:${keyframe.x}:${keyframe.y}:${keyframe.scale}:${keyframe.rotation ?? 0}:${keyframe.flip_x ?? ""}:${keyframe.flip_y ?? ""}:${keyframe.z_index}`,
      keyframe,
    );
  }
  return Array.from(byKey.values()).sort((a, b) => a.time - b.time);
}

function resolvePreviousTransform(
  actorId: string,
  previousScene?: CompiledSceneData | null,
): SpatialTransform | undefined {
  if (!previousScene) return undefined;

  const track = previousScene.instance_tracks.find((instanceTrack) => instanceTrack.actor_id === actorId);
  if (!track) return undefined;

  const latestTransform = [...track.transform_track].sort((a, b) => b.time - a.time)[0];
  const latestBinding = [...track.clip_bindings]
    .sort((a, b) => (b.start_time + b.duration_seconds) - (a.start_time + a.duration_seconds))[0];

  if (latestBinding?.end_transform) {
    return {
      x: latestBinding.end_transform.x,
      y: latestBinding.end_transform.y,
      scale: latestBinding.end_transform.scale,
      rotation: latestBinding.end_transform.rotation,
      flip_x: latestBinding.end_transform.flip_x,
      flip_y: latestBinding.end_transform.flip_y,
      z_index: latestBinding.end_transform.z_index,
    };
  }

  if (latestTransform) {
    return {
      x: latestTransform.x,
      y: latestTransform.y,
      scale: latestTransform.scale,
      rotation: latestTransform.rotation,
      flip_x: latestTransform.flip_x,
      flip_y: latestTransform.flip_y,
      z_index: latestTransform.z_index,
    };
  }

  return latestBinding?.start_transform;
}

export function compileBeatToScene(
  beat: StoryBeatData,
  availableRigs: Record<string, DraftsmanData>,
  previousScene?: CompiledSceneData | null,
  stageOrientation: StageOrientation = "landscape",
): CompiledSceneData {
  const { width: stageW, height: stageH } = getStageDims(stageOrientation);
  const instanceTracks = new Map<string, SceneInstanceTrack>();
  const obstacles: SceneObstacle[] = beat.drafted_background
    ? detectSceneObstacles(beat.drafted_background.svg_data)
    : [];

  beat.actions.forEach((action, actionIndex) => {
    const actorId = action.actor_id;
    const rig = availableRigs[actorId];
    const motionKey = normalizeMotionKey(action.motion);
    const startTime = action.animation_overrides?.delay ?? 0;
    const duration = action.duration_seconds || 2;
    const previousTransform = resolvePreviousTransform(actorId, previousScene);
    const startTransform: SpatialTransform = clampSpatialTransformToStage({
      x: action.spatial_transform?.x ?? previousTransform?.x ?? stageW / 2,
      y: action.spatial_transform?.y ?? previousTransform?.y ?? Math.round(stageH * 0.88),
      scale: action.spatial_transform?.scale ?? previousTransform?.scale ?? 0.5,
      rotation: action.spatial_transform?.rotation ?? previousTransform?.rotation,
      flip_x: action.spatial_transform?.flip_x ?? previousTransform?.flip_x,
      flip_y: action.spatial_transform?.flip_y ?? previousTransform?.flip_y,
      z_index: action.spatial_transform?.z_index ?? previousTransform?.z_index ?? 10,
    }, stageW, stageH);
    const inferredTarget = !action.target_spatial_transform
      ? inferAutoTargetTransform(motionKey, startTransform, duration, stageW)
      : undefined;
    const resolvedTarget = action.target_spatial_transform
      ? {
          x: action.target_spatial_transform.x,
          y: action.target_spatial_transform.y,
          scale: action.target_spatial_transform.scale,
          rotation: action.target_spatial_transform.rotation ?? startTransform.rotation,
          flip_x: action.target_spatial_transform.flip_x,
          flip_y: action.target_spatial_transform.flip_y,
          z_index: action.target_spatial_transform.z_index ?? startTransform.z_index,
        }
      : inferredTarget
        ? {
          ...inferredTarget,
          z_index: startTransform.z_index,
        }
        : undefined;
    const clampedResolvedTarget = resolvedTarget
      ? clampSpatialTransformToStage(resolvedTarget, stageW, stageH)
      : undefined;
    const collisionAdjusted = shouldClampTargetAgainstObstacles(action)
      ? clampTargetAgainstObstacles(
          motionKey,
          startTransform,
          clampedResolvedTarget
            ? {
                x: clampedResolvedTarget.x,
                y: clampedResolvedTarget.y,
                scale: clampedResolvedTarget.scale,
                flip_x: clampedResolvedTarget.flip_x,
                flip_y: clampedResolvedTarget.flip_y,
                z_index: clampedResolvedTarget.z_index,
              }
            : undefined,
          obstacles,
        )
      : {
          target: clampedResolvedTarget,
          collision: null,
        };
    const finalTarget = collisionAdjusted.target
      ? clampSpatialTransformToStage({
          x: collisionAdjusted.target.x,
          y: collisionAdjusted.target.y,
          scale: collisionAdjusted.target.scale,
          rotation: collisionAdjusted.target.rotation,
          flip_x: collisionAdjusted.target.flip_x,
          flip_y: collisionAdjusted.target.flip_y,
          z_index: collisionAdjusted.target.z_index,
        }, stageW, stageH)
        : undefined;
    const collisionBehavior = inferCollisionBehavior(action, beat.narrative);
    const resolvedClipId = resolveClipId(rig, motionKey);
    const clipView = resolvedClipId ? resolveClipView(rig, resolvedClipId) : undefined;
    const motionClip = resolvedClipId ? rig?.rig_data.motion_clips?.[resolvedClipId] : undefined;
    const playableClip = resolvedClipId && rig
      ? resolvePlayableMotionClip({
          rig,
          clipId: resolvedClipId,
          motionClip,
          style: action.style,
          durationSeconds: duration,
        })
      : motionClip;
    const ikPlayback = resolvedClipId ? motionClipToIKPlayback(resolvedClipId, playableClip) : undefined;
    const transformOnlyPolicy = inferTransformOnlyPlaybackPolicy(rig, motionKey);
    const useBaseObjectBinding = Boolean(
      rig && (
        transformOnlyPolicy.prefer ||
        (!resolvedClipId && (motionNeedsTarget(motionKey) || Boolean(finalTarget)))
      ),
    );
    const bakedMotion = buildTransformTrackForBinding({
      motionKey,
      startTime,
      duration,
      startTransform,
      resolvedTarget: clampedResolvedTarget,
      finalTarget,
      collisionObstacle: collisionAdjusted.collision,
      collisionBehavior,
      rootMotionSamples: useBaseObjectBinding ? playableClip?.intent.rootMotion : undefined,
      wholeObjectMotion: useBaseObjectBinding ? playableClip?.intent.wholeObjectMotion : undefined,
      preferredDirection: playableClip?.intent.locomotion.direction,
      stageW,
      stageH,
    });
    const binding = useBaseObjectBinding
      ? ({
          id: `${actorId}:${actionIndex}:${BASE_OBJECT_CLIP_ID}`,
          actor_id: actorId,
          source_action_index: actionIndex,
          motion: action.motion,
          style: action.style,
          clip_id: BASE_OBJECT_CLIP_ID,
          view: resolveTransformOnlyView(rig, startTransform, bakedMotion.endTransform || finalTarget, clipView),
          start_time: startTime,
          duration_seconds: duration,
          amplitude: action.animation_overrides?.amplitude,
          speed: action.animation_overrides?.speed,
          collision_behavior: collisionBehavior,
          start_transform: startTransform,
          end_transform: bakedMotion.endTransform,
          ik_playback: ikPlayback,
          collision: collisionAdjusted.collision
            ? {
                obstacle_id: collisionAdjusted.collision.id,
                stop_x: collisionAdjusted.target?.x ?? startTransform.x,
                stop_y: collisionAdjusted.target?.y,
                stop_time: bakedMotion.stopTime,
              }
            : undefined,
        } satisfies ClipBinding)
      : resolvedClipId
      ? ({
          id: `${actorId}:${actionIndex}:${resolvedClipId}`,
          actor_id: actorId,
          source_action_index: actionIndex,
          motion: action.motion,
          style: action.style,
          clip_id: resolvedClipId,
          view: ikPlayback?.view ?? playableClip?.view ?? clipView,
          start_time: startTime,
          duration_seconds: duration,
          amplitude: action.animation_overrides?.amplitude,
          speed: action.animation_overrides?.speed,
          collision_behavior: collisionBehavior,
          start_transform: startTransform,
          end_transform: bakedMotion.endTransform,
          ik_playback: ikPlayback,
          collision: collisionAdjusted.collision
            ? {
                obstacle_id: collisionAdjusted.collision.id,
                stop_x: collisionAdjusted.target?.x ?? startTransform.x,
                stop_y: collisionAdjusted.target?.y,
                stop_time: bakedMotion.stopTime,
              }
            : undefined,
        } satisfies ClipBinding)
      : null;

    const transformTrack = bakedMotion.transformTrack;

    const existing = instanceTracks.get(actorId);
    if (existing) {
      if (binding) {
        existing.clip_bindings.push(binding);
      }
      existing.transform_track = uniqueKeyframes([...existing.transform_track, ...transformTrack]);
    } else {
      instanceTracks.set(actorId, {
        actor_id: actorId,
        clip_bindings: binding ? [binding] : [],
        transform_track: transformTrack,
      });
    }
  });

  const tracks = Array.from(instanceTracks.values()).map(track => ({
    ...track,
    clip_bindings: [...track.clip_bindings].sort((a, b) => a.start_time - b.start_time),
    transform_track: uniqueKeyframes(track.transform_track),
  }));

  const actorDuration = Math.max(
    0,
    ...tracks.flatMap(track =>
      track.clip_bindings.map(binding => binding.start_time + binding.duration_seconds),
    ),
  );

  const sceneDuration = Math.max(actorDuration, beat.actions.reduce((max, action) => {
    const startTime = action.animation_overrides?.delay ?? 0;
    return Math.max(max, startTime + (action.duration_seconds || 0));
  }, 0), 3);

  const backgroundAmbient: BackgroundAmbientBinding[] = []; // Disabled by default for now, can be explicitly enabled later for objects
  /*
  const backgroundAmbient: BackgroundAmbientBinding[] = beat.drafted_background
    ? detectAmbientIdsFromSvg(beat.drafted_background.svg_data).map(({ id, label }, idx) => ({
        id: `background:${idx}:${id}`,
        target_id: id,
        label,
        start_time: 0,
        duration_seconds: sceneDuration,
      }))
    : [];
  */

  return {
    duration_seconds: Math.max(sceneDuration, 0.5),
    background_ambient: backgroundAmbient,
    obstacles,
    instance_tracks: tracks,
  };
}
