import gsap from "gsap";
import { ClipBindingIKPlayback, CompiledSceneData, StoryBeatData } from "../schema/story";
import { DraftsmanData, RigMotionClip } from "../schema/rig";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "./semantics";
import {
  OBJECT_ANIM_PATTERNS,
  addAmbientBindingToTimeline,
  detectAmbientElements,
  playAmbientLoopOnElement,
} from "./ambient";
import { createIKPlaybackActor, IKPlaybackActor, setPlaybackIntent, stagePlaybackView, syncPlaybackActors } from "../ik/playback";
import { motionClipToIKPlayback, resolvePlayableMotionClip } from "./compiled_ik";
import { estimateMotionClipDuration } from "./intent";

const ALL_VIEWS = ["view_front", "view_side_right", "view_3q_right", "view_top", "view_back"] as const;
const BASE_OBJECT_CLIP_ID = "base_object";

export interface AnimationContext {
  container: HTMLElement;
  beat: StoryBeatData;
  compiledScene?: CompiledSceneData | null;
  availableRigs: Record<string, DraftsmanData>;
}

type StoredMotionClip = NonNullable<NonNullable<DraftsmanData["rig_data"]["motion_clips"]>[string]>;

type TimelineWithIKSync = gsap.core.Timeline & {
  __ikSync?: () => void;
};

// ── Style Modulation ──────────────────────────────────────────────────────────

/** Maps style adverbs to motion amplitude multipliers. */
function styleAmplitude(style: string): number {
  const s = style.toLowerCase();
  if (/frantic|panic|wild|manic|extreme/.test(s)) return 1.8;
  if (/fast|quick|swift|hurried|rushed/.test(s)) return 1.2;
  if (/slow|lazy|sleepy|tired|groggy/.test(s)) return 0.7;
  if (/subtle|gentle|soft|delicate/.test(s)) return 0.5;
  if (/casual|relaxed|easy|chill/.test(s)) return 0.85;
  return 1.0;
}

/** Maps style adverbs to speed multipliers (>1 = faster). */
function styleSpeed(style: string): number {
  const s = style.toLowerCase();
  if (/frantic|panic|manic|wild/.test(s)) return 1.9;
  if (/fast|quick|swift|hurried/.test(s)) return 1.5;
  if (/slow|lazy|sleepy|tired/.test(s)) return 0.5;
  if (/casual|relaxed|gentle/.test(s)) return 0.75;
  return 1.0;
}

/**
 * Convert an infinite repeat (-1) to a finite count based on available time.
 * One full cycle = tweenDuration * 2 when yoyo=true, tweenDuration otherwise.
 */
function calcRepeat(availableTime: number, tweenDuration: number, yoyo: boolean): number {
  const cycle = yoyo ? tweenDuration * 2 : tweenDuration;
  if (cycle <= 0) return 0;
  return Math.max(0, Math.ceil(availableTime / cycle) - 1);
}

/** Scale a property value by amplitude without anatomy-specific weighting. */
function propMotionWeight(prop: string): number {
  if (prop === "opacity") return 1;
  if (prop === "rotation") return 0.7;
  if (prop === "x" || prop === "y") return 0.45;
  if (prop === "scaleX" || prop === "scaleY") return 0.4;
  return 1;
}

function scaleProp(prop: string, value: number, amp: number): number {
  const scaled = value * amp * propMotionWeight(prop);
  return prop === "opacity" ? Math.min(1, scaled) : scaled;
}

function getActorNaturalOrigin(container: HTMLElement, actorId: string): {
  naturalCX: number;
  naturalBottom: number;
} {
  const group = container.querySelector<SVGGElement>(`#actor_group_${actorId}`);
  return {
    naturalCX: parseFloat(group?.dataset.naturalCx || "500"),
    naturalBottom: parseFloat(group?.dataset.naturalBottom || "1000"),
  };
}

function timelineVarsForTransform(
  container: HTMLElement,
  actorId: string,
  transform: { x: number; y: number; scale: number },
  facingSign: number,
): gsap.TweenVars {
  const { naturalCX, naturalBottom } = getActorNaturalOrigin(container, actorId);
  return {
    x: transform.x - naturalCX,
    y: transform.y - naturalBottom,
    scaleX: facingSign * transform.scale,
    scaleY: transform.scale,
    svgOrigin: `${naturalCX} ${naturalBottom}`,
  };
}

function addCompiledTransformTrack(
  tl: gsap.core.Timeline,
  container: HTMLElement,
  actorId: string,
  transformTrack: Array<{ time: number; x: number; y: number; scale: number }>,
) {
  const sorted = [...transformTrack].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return;

  let facingSign = 1;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (next) {
      const deltaX = next.x - current.x;
      if (deltaX < -10) facingSign = -1;
      else if (deltaX > 10) facingSign = 1;
    }

    tl.set(
      `#actor_group_${actorId}`,
      timelineVarsForTransform(container, actorId, current, facingSign),
      current.time,
    );

    if (!next) continue;
    const segmentDuration = next.time - current.time;
    if (segmentDuration <= 0) continue;

    const deltaX = next.x - current.x;
    if (deltaX < -10) facingSign = -1;
    else if (deltaX > 10) facingSign = 1;

    tl.to(
      `#actor_group_${actorId}`,
      {
        ...timelineVarsForTransform(container, actorId, next, facingSign),
        duration: segmentDuration,
        ease: "power1.inOut",
      },
      current.time,
    );
  }
}

export function detectObjectAnimations(container: HTMLElement): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = [];
  container.querySelectorAll("[id]").forEach(el => {
    const id = el.getAttribute("id") || "";
    for (const { regex, label } of OBJECT_ANIM_PATTERNS) {
      if (regex.test(id)) {
        result.push({ id, label });
        break;
      }
    }
  });
  return result;
}

function displayKeyframesForClip(motionClip: StoredMotionClip | undefined) {
  return motionClip?.displayKeyframes || [];
}

function viewForClip(motionClip: StoredMotionClip | undefined): string | undefined {
  return motionClip?.view;
}

function estimateClipDuration(motionClip: StoredMotionClip | undefined): number {
  return estimateMotionClipDuration(motionClip);
}

function addDirectOpacityKeyframes(params: {
  timeline: gsap.core.Timeline;
  actorId: string;
  keyframes: NonNullable<RigMotionClip["displayKeyframes"]>;
  amp: number;
  spd: number;
  startDelay: number;
  actionDuration: number;
}): void {
  const { timeline, actorId, keyframes, amp, spd, startDelay, actionDuration } = params;

  keyframes
    .forEach((keyframe) => {
      const scaledTo = scaleProp(keyframe.prop, keyframe.to, amp);
      const scaledFrom = keyframe.from !== undefined
        ? scaleProp(keyframe.prop, keyframe.from, amp)
        : undefined;
      const duration = (keyframe.duration || 0.5) / spd;
      const delay = (keyframe.delay ?? 0) / spd;
      const yoyo = keyframe.yoyo ?? false;
      const repeat = keyframe.repeat === -1
        ? calcRepeat(actionDuration - delay, duration, yoyo)
        : (keyframe.repeat ?? 0);
      const tweenVars: gsap.TweenVars = {
        opacity: scaledTo,
        duration,
        yoyo,
        repeat,
        ease: keyframe.ease ?? "sine.inOut",
        overwrite: "auto",
      };
      const target = `#actor_group_${actorId} [id="${keyframe.boneId}"]`;

      if (scaledFrom !== undefined) {
        timeline.fromTo(target, { opacity: scaledFrom }, tweenVars, startDelay + delay);
      } else {
        timeline.to(target, tweenVars, startDelay + delay);
      }
    });
}

function addCanonicalIKPlayback(params: {
  timeline: gsap.core.Timeline;
  actor: IKPlaybackActor | null;
  clipView?: string;
  compiledIK?: ClipBindingIKPlayback;
  amp: number;
  spd: number;
  startDelay: number;
  actionDuration: number;
}): boolean {
  const { timeline, actor, clipView, compiledIK, amp, spd, startDelay, actionDuration } = params;
  if (!actor || !compiledIK?.motion_intent) return false;

  if (clipView) {
    stagePlaybackView(timeline, actor, clipView, startDelay);
  }

  timeline.call(() => {
    setPlaybackIntent(actor, {
      ...compiledIK.motion_intent,
      duration: compiledIK.motion_intent.duration,
      rotationTracks: (compiledIK.motion_intent.rotationTracks || []).map((track) => ({
        ...track,
        samples: track.samples.map((sample) => ({
          ...sample,
          rotation: scaleProp("rotation", sample.rotation, amp),
        })),
      })),
      axialWaves: compiledIK.motion_intent.axialWaves.map((wave) => ({
        ...wave,
        amplitudeDeg: scaleProp("rotation", wave.amplitudeDeg, amp),
        frequency: wave.frequency,
      })),
    });
  }, undefined, startDelay);

  timeline.set(actor.playbackState, { clipTimeSeconds: 0 }, startDelay);
  timeline.to(actor.playbackState, {
    clipTimeSeconds: (compiledIK.motion_intent.duration || actionDuration) * spd,
    duration: actionDuration,
    ease: "none",
    overwrite: "auto",
  }, startDelay);

  return true;
}

function playAmbientIKClip(
  actorId: string,
  rig: DraftsmanData | undefined,
  container: HTMLElement,
): void {
  if (!rig) {
    console.warn(`[ambient] No rig found for actor "${actorId}"`);
    return;
  }

  const motionClip = rig.rig_data.motion_clips?.idle;
  if (!motionClip) {
    console.warn(`[ambient] No clip "idle" for actor "${actorId}" — skipping ambient clip playback`);
    return;
  }

  const playableClip = resolvePlayableMotionClip({
    rig,
    clipId: "idle",
    motionClip,
  });
  const compiledIK = motionClipToIKPlayback("idle", playableClip);
  const ikActor = createIKPlaybackActor(container, actorId, rig);

  if (!compiledIK || !ikActor) {
    console.warn(`[ambient] No canonical IK playback for actor "${actorId}" idle clip`);
    return;
  }

  const timeline = gsap.timeline({
    defaults: { overwrite: "auto" },
    onUpdate: () => syncPlaybackActors([ikActor]),
  });
  const clipView = compiledIK.view ?? viewForClip(playableClip);
  ikActor.renderState.currentView = clipView ?? ikActor.defaultView;
  const clipDuration = Math.max(2, estimateClipDuration(playableClip));

  addCanonicalIKPlayback({
    timeline,
    actor: ikActor,
    clipView,
    compiledIK,
    amp: 1,
    spd: 1,
    startDelay: 0,
    actionDuration: clipDuration,
  });
  addDirectOpacityKeyframes({
    timeline,
    actorId,
    keyframes: displayKeyframesForClip(playableClip),
    amp: 1,
    spd: 1,
    startDelay: 0,
    actionDuration: clipDuration,
  });

  syncPlaybackActors([ikActor]);
}

// ── Ambient Layer ─────────────────────────────────────────────────────────────

/**
 * Always-on looping animations:
 *  • Character idle clip from canonical IK playback.
 *  • Object ambient loops (fire, smoke, etc.) detected by ID pattern.
 */
export function animateAmbient(context: AnimationContext): gsap.Context {
  const { container, beat, compiledScene, availableRigs } = context;

  const actorIds = compiledScene?.instance_tracks.map(track => track.actor_id) ?? beat.actions.map(a => a.actor_id);
  console.log(`[ambient] Starting ambient for scene ${beat.scene_number} — actors: ${actorIds.join(", ")}`);

  return gsap.context(() => {
    // Object ambient — scan all SVG elements with recognised ID patterns
    const matchedObjects: string[] = [];
    detectAmbientElements(container).forEach(({ id, label, element }) => {
      playAmbientLoopOnElement(element, label);
      matchedObjects.push(`${id} (${label})`);
    });
    if (matchedObjects.length > 0) {
      console.log(`[ambient] Object loops: ${matchedObjects.join(", ")}`);
    }

    // Character idle — use the rig's idle clip
    actorIds.forEach(actorId => {
      const rig = availableRigs[actorId];
      if (!rig) {
        console.warn(`[ambient] No rig found for actor "${actorId}"`);
        return;
      }
      if (rig.rig_data.motion_clips?.idle) {
        playAmbientIKClip(actorId, rig, container);
      }
    });
  }, container);
}

// ── Timeline Layer ────────────────────────────────────────────────────────────

/**
 * Builds a scrubable, paused GSAP timeline for the beat.
 *
 * For each action:
 *   1. Spatial translation (walk/run/jump movement) added at timeline position 0.
 *   2. Canonical IK playback drivers with style modulation (amplitude + speed).
 *
 * Infinite repeat (-1) keyframes are converted to finite counts so the timeline
 * has a definite duration and can be seeked/scrubbed by the playhead.
 *
 * Returns the timeline in a paused state — call .play() to start it.
 */
export function buildTimeline(context: AnimationContext): gsap.core.Timeline {
  const { container, beat, compiledScene, availableRigs } = context;

  const compiledBindings = compiledScene?.instance_tracks.flatMap(track => track.clip_bindings) ?? [];
  console.log(`[timeline] Building timeline for scene ${beat.scene_number} — ${compiledBindings.length > 0 ? `${compiledBindings.length} compiled bindings` : `${beat.actions.length} semantic actions`}`);

  const tl = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } }) as TimelineWithIKSync;
  const ikActors = new Map<string, IKPlaybackActor>();
  const ensureIKActor = (actorId: string, rig: DraftsmanData | undefined): IKPlaybackActor | null => {
    if (!rig?.rig_data.ik?.nodes.length) return null;
    const existing = ikActors.get(actorId);
    if (existing) return existing;
    const created = createIKPlaybackActor(container, actorId, rig);
    if (!created) return null;
    ikActors.set(actorId, created);
    return created;
  };

  const backgroundBindings = compiledScene?.background_ambient ?? [];
  backgroundBindings.forEach(binding => {
    const target = [
      `#bg_sky[id="${binding.target_id}"]`,
      `#bg_midground[id="${binding.target_id}"]`,
      `#bg_foreground[id="${binding.target_id}"]`,
      `#bg_sky [id="${binding.target_id}"]`,
      `#bg_midground [id="${binding.target_id}"]`,
      `#bg_foreground [id="${binding.target_id}"]`,
    ].join(", ");
    addAmbientBindingToTimeline(tl, target, binding);
  });
  if (backgroundBindings.length > 0) {
    console.log(`[timeline]   background ambient bindings=${backgroundBindings.length}`);
  }

  if (compiledScene && compiledScene.instance_tracks.length > 0) {
    compiledScene.instance_tracks.forEach(track => {
      const id = track.actor_id;
      const rig = availableRigs[id];
      const ikActor = ensureIKActor(id, rig);

      addCompiledTransformTrack(tl, container, id, track.transform_track);

      track.clip_bindings.forEach(binding => {
        const m = normalizeMotionKey(binding.motion);
        const actionDuration = binding.duration_seconds || 2;
        const amp = binding.amplitude ?? 1.0;
        const spd = binding.speed ?? 1.0;
        const startDelay = binding.start_time ?? 0;
        const isBaseObjectBinding = binding.clip_id === BASE_OBJECT_CLIP_ID;
        const motionClip = !isBaseObjectBinding ? rig?.rig_data.motion_clips?.[binding.clip_id] : undefined;
        const playableClip = !isBaseObjectBinding && rig
          ? resolvePlayableMotionClip({
              rig,
              clipId: binding.clip_id,
              motionClip,
              style: binding.style,
              durationSeconds: actionDuration,
            })
          : motionClip;
        const compiledIK = !isBaseObjectBinding
          ? motionClipToIKPlayback(binding.clip_id, playableClip) ?? binding.ik_playback
          : undefined;
        const clipView = compiledIK?.view ?? binding.view ?? viewForClip(playableClip);

        console.log(`[timeline]   actor="${id}" clip="${binding.clip_id}" motion="${m}" → amp=${amp.toFixed(2)} spd=${spd.toFixed(2)} delay=${startDelay}`);

        if (!rig) {
          console.warn(`[timeline]   No rig found for actor "${id}" — skipping bone animation`);
          return;
        }

        if (clipView) {
          if (ikActor) {
            stagePlaybackView(tl, ikActor, clipView, startDelay);
          } else {
            ALL_VIEWS.forEach(v => {
              tl.set(`#actor_group_${id} #${v}`, {
                display: v === clipView ? "inline" : "none",
              }, startDelay);
            });
          }
        }

        if (isBaseObjectBinding) {
          return;
        }

        const availableClips = Object.keys(rig.rig_data.motion_clips ?? {});
        if (!compiledIK && !playableClip) {
          console.warn(`[timeline]   No canonical clip "${binding.clip_id}" for actor "${id}" — available: [${availableClips.join(", ")}] — skipping actor motion`);
          return;
        }

        addCanonicalIKPlayback({
          timeline: tl,
          actor: ikActor,
          clipView,
          compiledIK,
          amp,
          spd,
          startDelay,
          actionDuration,
        });
        addDirectOpacityKeyframes({
          timeline: tl,
          actorId: id,
          keyframes: displayKeyframesForClip(playableClip),
          amp,
          spd,
          startDelay,
          actionDuration,
        });
      });
    });

    tl.__ikSync = () => {
      syncPlaybackActors(Array.from(ikActors.values()));
    };

    console.log(`[timeline] Built — duration: ${tl.duration().toFixed(2)}s, tweens: ${tl.getChildren().length}`);
    return tl;
  }

  beat.actions.forEach(action => {
    const id             = action.actor_id;
    const rig            = availableRigs[id];
    const ikActor        = ensureIKActor(id, rig);
    const m              = normalizeMotionKey(action.motion);
    const actionDuration = action.duration_seconds || 2;
    const overrides      = action.animation_overrides;

    // Resolve amplitude and speed: explicit overrides > style inference > 1.0
    const amp = overrides?.amplitude ?? styleAmplitude(action.style ?? "");
    const spd = overrides?.speed     ?? styleSpeed(action.style ?? "");
    const startDelay = overrides?.delay ?? 0;

    console.log(`[timeline]   actor="${id}" motion="${m}" style="${action.style}" → amp=${amp.toFixed(2)} spd=${spd.toFixed(2)} delay=${startDelay}`);

    // ── 1. Spatial movement ─────────────────────────────────────────────────
    const startX     = action.spatial_transform?.x     ?? 960;
    const startY     = action.spatial_transform?.y     ?? 950;
    const startScale = action.spatial_transform?.scale ?? 0.5;
    const inferredTarget = !action.target_spatial_transform
      ? inferAutoTargetTransform(
          m,
          { x: startX, y: startY, scale: startScale },
          actionDuration,
        )
      : undefined;
    const resolvedTarget = action.target_spatial_transform ?? inferredTarget;
    const endX       = resolvedTarget?.x;
    const endY       = resolvedTarget?.y;
    const endScale   = resolvedTarget?.scale;

    const deltaX   = endX !== undefined ? endX - startX : 0;
    const deltaY   = endY !== undefined ? endY - startY : 0;
    const isMoving = motionNeedsTarget(m) || Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10;

    // Left-walk: flip scaleX immediately at start
    if (isMoving && deltaX < -10) {
      const group = container.querySelector<SVGGElement>(`#actor_group_${id}`);
      if (group) {
        const naturalCX     = parseFloat(group.dataset.naturalCx     || "500");
        const naturalBottom = parseFloat(group.dataset.naturalBottom  || "1000");
        tl.set(`#actor_group_${id}`, {
          scaleX: -startScale,
          svgOrigin: `${naturalCX} ${naturalBottom}`,
        }, startDelay);
      }
    }

    if (isMoving || endScale !== undefined) {
      const moveVars: gsap.TweenVars = { duration: actionDuration, ease: "power1.inOut" };
      if (Math.abs(deltaX) > 10) moveVars.x = `+=${deltaX}`;
      if (Math.abs(deltaY) > 10) moveVars.y = `+=${deltaY}`;
      if (endScale !== undefined) {
        const flipped = deltaX < -10;
        moveVars.scaleX = flipped ? -endScale : endScale;
        moveVars.scaleY = endScale;
      }
      tl.to(`#actor_group_${id}`, moveVars, startDelay);
    }

    // ── 2. Canonical IK animation from rig clip ────────────────────────────
    if (!rig) {
      console.warn(`[timeline]   No rig found for actor "${id}" — skipping bone animation`);
      return;
    }

    const availableClips = Object.keys(rig.rig_data.motion_clips ?? {});
    const resolvedClipKey = suggestMotionAliases(m).find(alias => rig.rig_data.motion_clips?.[alias]);
    const motionClip = resolvedClipKey ? rig.rig_data.motion_clips?.[resolvedClipKey] : undefined;
    const playableClip = resolvedClipKey
      ? resolvePlayableMotionClip({
          rig,
          clipId: resolvedClipKey,
          motionClip,
          style: action.style,
          durationSeconds: actionDuration,
        })
      : undefined;
    const compiledIK = resolvedClipKey ? motionClipToIKPlayback(resolvedClipKey, playableClip) : undefined;
    const clipView = compiledIK?.view ?? viewForClip(playableClip);

    if (!compiledIK && !playableClip) {
      console.warn(`[timeline]   No canonical clip "${m}" for actor "${id}" — available: [${availableClips.join(", ")}] — skipping actor motion`);
      return;
    }
    console.log(`[timeline]   Clip "${resolvedClipKey ?? m}" → view="${clipView ?? "none"}" intentFamily="${playableClip?.intent.family || "none"}"`);

    // Switch to the appropriate view at the action start
    if (clipView) {
      if (ikActor) {
        stagePlaybackView(tl, ikActor, clipView, startDelay);
      } else {
        ALL_VIEWS.forEach(v => {
          tl.set(`#actor_group_${id} #${v}`, {
            display: v === clipView ? "inline" : "none",
          }, startDelay);
        });
      }
    }

    addCanonicalIKPlayback({
      timeline: tl,
      actor: ikActor,
      clipView,
      compiledIK,
      amp,
      spd,
      startDelay,
      actionDuration,
    });
    addDirectOpacityKeyframes({
      timeline: tl,
      actorId: id,
      keyframes: displayKeyframesForClip(playableClip),
      amp,
      spd,
      startDelay,
      actionDuration,
    });
  });

  tl.__ikSync = () => {
    syncPlaybackActors(Array.from(ikActors.values()));
  };

  console.log(`[timeline] Built — duration: ${tl.duration().toFixed(2)}s, tweens: ${tl.getChildren().length}`);
  return tl;
}
