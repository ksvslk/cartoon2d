import { DraftsmanData } from "../schema/rig";
import {
  CompiledSceneData,
  SceneInstanceTrack,
  StoryBeatData,
  TransformKeyframe,
  SpatialTransform,
  ClipBinding,
} from "../schema/story";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "./semantics";

function resolveClipId(rig: DraftsmanData | undefined, motion: string): string {
  if (!rig?.rig_data.animation_clips) return normalizeMotionKey(motion);
  const normalized = normalizeMotionKey(motion);
  return suggestMotionAliases(normalized).find(alias => rig.rig_data.animation_clips?.[alias]) ?? normalized;
}

function resolveClipView(rig: DraftsmanData | undefined, clipId: string): string | undefined {
  const rawClip = rig?.rig_data.animation_clips?.[clipId];
  if (!rawClip || Array.isArray(rawClip)) return undefined;
  return rawClip.view;
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

export function compileBeatToScene(
  beat: StoryBeatData,
  availableRigs: Record<string, DraftsmanData>,
): CompiledSceneData {
  const instanceTracks = new Map<string, SceneInstanceTrack>();

  beat.actions.forEach((action, actionIndex) => {
    const actorId = action.actor_id;
    const rig = availableRigs[actorId];
    const motionKey = normalizeMotionKey(action.motion);
    const startTime = action.animation_overrides?.delay ?? 0;
    const duration = action.duration_seconds || 2;
    const startTransform: SpatialTransform = {
      x: action.spatial_transform?.x ?? 960,
      y: action.spatial_transform?.y ?? 950,
      scale: action.spatial_transform?.scale ?? 0.5,
      z_index: action.spatial_transform?.z_index ?? 10,
    };
    const inferredTarget = !action.target_spatial_transform
      ? inferAutoTargetTransform(motionKey, startTransform, duration)
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
    const clipId = resolveClipId(rig, motionKey);
    const clipView = resolveClipView(rig, clipId);

    const binding: ClipBinding = {
      id: `${actorId}:${actionIndex}:${clipId}`,
      actor_id: actorId,
      source_action_index: actionIndex,
      motion: action.motion,
      style: action.style,
      clip_id: clipId,
      view: clipView,
      start_time: startTime,
      duration_seconds: duration,
      amplitude: action.animation_overrides?.amplitude,
      speed: action.animation_overrides?.speed,
      start_transform: startTransform,
      end_transform: resolvedTarget,
    };

    const transformTrack: TransformKeyframe[] = [
      {
        ...startTransform,
        time: startTime,
      },
    ];

    if (resolvedTarget && motionNeedsTarget(motionKey)) {
      transformTrack.push({
        ...resolvedTarget,
        time: startTime + duration,
      });
    }

    const existing = instanceTracks.get(actorId);
    if (existing) {
      existing.clip_bindings.push(binding);
      existing.transform_track = uniqueKeyframes([...existing.transform_track, ...transformTrack]);
    } else {
      instanceTracks.set(actorId, {
        actor_id: actorId,
        clip_bindings: [binding],
        transform_track: transformTrack,
      });
    }
  });

  const tracks = Array.from(instanceTracks.values()).map(track => ({
    ...track,
    clip_bindings: [...track.clip_bindings].sort((a, b) => a.start_time - b.start_time),
    transform_track: uniqueKeyframes(track.transform_track),
  }));

  const duration_seconds = Math.max(
    0,
    ...tracks.flatMap(track =>
      track.clip_bindings.map(binding => binding.start_time + binding.duration_seconds),
    ),
  );

  return {
    duration_seconds: Math.max(duration_seconds, 0.5),
    instance_tracks: tracks,
  };
}
