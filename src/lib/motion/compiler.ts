import { DraftsmanData } from "../schema/rig";
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
import { inferRigMotionAffordance } from "./affordance";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "./semantics";
import { detectAmbientIdsFromSvg } from "./ambient";
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
  const confidence = normalizedRig.rig_data.ik?.aiReport?.confidence ?? 1;
  const attachmentWarnings = countAttachmentWarnings(normalizedRig);
  const minimalTopology = affordance.primaryChainLength <= 2 && affordance.effectors <= 1;

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
  if (clipView && availableViews.includes(clipView)) return clipView;

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

function distance(a: SpatialTransform, b: SpatialTransform): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampSpatialTransformToStage(transform: SpatialTransform, stageW = 1920, stageH = 1080): SpatialTransform {
  const safeScale = round2(clamp(transform.scale, 0.18, 2.5));
  const marginX = Math.max(110, 140 * safeScale);
  const marginY = Math.max(90, 120 * safeScale);
  return {
    x: round2(clamp(transform.x, marginX, stageW - marginX)),
    y: round2(clamp(transform.y, marginY, stageH - marginY)),
    scale: safeScale,
    z_index: Math.round(clamp(transform.z_index, 0, 100)),
  };
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
    stageW = 1920,
    stageH = 1080,
  } = params;

  const endTime = roundTime(startTime + duration);
  const transformTrack: TransformKeyframe[] = [
    { ...clampSpatialTransformToStage(startTransform, stageW, stageH), time: roundTime(startTime) },
  ];

  if (!finalTarget || !motionNeedsTarget(motionKey)) {
    return {
      transformTrack,
      endTransform: undefined,
    };
  }

  if (!collisionObstacle || !resolvedTarget) {
    transformTrack.push({
      ...clampSpatialTransformToStage(finalTarget, stageW, stageH),
      time: endTime,
    });
    return {
      transformTrack,
      endTransform: clampSpatialTransformToStage(finalTarget, stageW, stageH),
    };
  }

  const stopTransform = clampSpatialTransformToStage({
    x: finalTarget.x,
    y: finalTarget.y,
    scale: finalTarget.scale,
    z_index: finalTarget.z_index,
  }, stageW, stageH);

  if (collisionBehavior === "halt") {
    transformTrack.push({
      ...stopTransform,
      time: endTime,
    });
    return {
      transformTrack,
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
    return {
      transformTrack,
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
  return {
    transformTrack,
    endTransform: bounceTransform,
    stopTime: endTime,
  };
}

function uniqueKeyframes(track: TransformKeyframe[]): TransformKeyframe[] {
  const byKey = new Map<string, TransformKeyframe>();
  for (const keyframe of track) {
    byKey.set(
      `${keyframe.time}:${keyframe.x}:${keyframe.y}:${keyframe.scale}:${keyframe.z_index}`,
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
      z_index: latestBinding.end_transform.z_index,
    };
  }

  if (latestTransform) {
    return {
      x: latestTransform.x,
      y: latestTransform.y,
      scale: latestTransform.scale,
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
          z_index: startTransform.z_index,
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
          z_index: collisionAdjusted.target.z_index,
        }, stageW, stageH)
        : undefined;
    const collisionBehavior = inferCollisionBehavior(action, beat.narrative);
    const bakedMotion = buildTransformTrackForBinding({
      motionKey,
      startTime,
      duration,
      startTransform,
      resolvedTarget: clampedResolvedTarget,
      finalTarget,
      collisionObstacle: collisionAdjusted.collision,
      collisionBehavior,
      stageW,
      stageH,
    });
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
