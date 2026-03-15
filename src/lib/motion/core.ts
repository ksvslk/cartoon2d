import gsap from "gsap";
import { ClipBindingIKPlayback, CompiledSceneData, StoryBeatData, getStageDims } from "../schema/story";
import { DraftsmanData, RigMotionClip } from "../schema/rig";
import { normalizeMotionKey, suggestMotionAliases } from "./semantics";
import {
  OBJECT_ANIM_PATTERNS,
  addAmbientBindingToTimeline,
  detectAmbientElements,
  playAmbientLoopOnElement,
} from "./ambient";
import { createIKPlaybackActor, IKPlaybackActor, setPlaybackIntent, stagePlaybackView, syncPlaybackActors } from "../ik/playback";
import { ensureRigIK } from "../ik/graph";
import { motionClipToIKPlayback, resolvePlayableMotionClip } from "./compiled_ik";
import { estimateMotionClipDuration } from "./intent";

const BASE_OBJECT_CLIP_ID = "base_object";

/** Clamp a camera value to safe bounds */
function clampCam(v: number, fallback = 960): number { return Number.isFinite(v) ? Math.max(-3000, Math.min(3000, v)) : fallback; }
function clampZoom(v: number, fallback = 1): number { return Number.isFinite(v) ? Math.max(0.2, Math.min(3, v)) : fallback; }

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

function availableRigViewIds(rig: DraftsmanData | undefined): string[] {
  if (!rig) return [];
  return Object.keys(ensureRigIK(rig).rig_data.ik?.views || {}).sort();
}

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
  transform: { x: number; y: number; scale: number; rotation?: number; flip_x?: boolean; flip_y?: boolean },
  facingSign: number,
  verticalSign = transform.flip_y ? -1 : 1,
): gsap.TweenVars {
  const { naturalCX, naturalBottom } = getActorNaturalOrigin(container, actorId);
  return {
    x: transform.x - naturalCX,
    y: transform.y - naturalBottom,
    rotation: transform.rotation ?? 0,
    scaleX: facingSign * transform.scale,
    scaleY: verticalSign * transform.scale,
    svgOrigin: `${naturalCX} ${naturalBottom}`,
  };
}

function facingSignForDirection(direction?: string): number | undefined {
  if (!direction) return undefined;
  if (direction === "left" || direction === "backward") return -1;
  if (direction === "right" || direction === "forward") return 1;
  return undefined;
}

function addCompiledTransformTrack(
  tl: gsap.core.Timeline,
  container: HTMLElement,
  actorId: string,
  transformTrack: Array<{ time: number; x: number; y: number; scale: number; rotation?: number; flip_x?: boolean; flip_y?: boolean }>,
  initialFacingSign?: number,
) {
  const sorted = [...transformTrack].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return;

  let facingSign = initialFacingSign ?? 1;
  const keyframeFacingSigns = sorted.map((current) => {
    if (current.flip_x !== undefined) {
      facingSign = current.flip_x ? -1 : 1;
    }
    // Do NOT infer facing from deltaX movement — only use explicit flip_x
    return facingSign;
  });

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const currentFacingSign = keyframeFacingSigns[i];
    const currentVerticalSign = current.flip_y ? -1 : 1;

    tl.set(
      `#actor_group_${actorId}`,
      timelineVarsForTransform(container, actorId, current, currentFacingSign, currentVerticalSign),
      current.time,
    );

    const next = sorted[i + 1];
    if (!next) continue;

    const segmentDuration = next.time - current.time;
    if (segmentDuration <= 0) continue;

    tl.to(
      `#actor_group_${actorId}`,
      {
        ...timelineVarsForTransform(container, actorId, next, currentFacingSign, currentVerticalSign),
        duration: segmentDuration,
        ease: "none",
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

// addDirectOpacityKeyframes and displayKeyframesForClip removed.
// Bone opacity animations caused more harm than good (stale opacity values,
// body part flickering). CSS !important rule provides a permanent safety net.

function viewForClip(motionClip: StoredMotionClip | undefined): string | undefined {
  return motionClip?.view;
}

function estimateClipDuration(motionClip: StoredMotionClip | undefined): number {
  return estimateMotionClipDuration(motionClip);
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
  const stagedIntent = {
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
  };

  if (clipView) {
    stagePlaybackView(timeline, actor, clipView, startDelay);
  }
  if (startDelay <= 0) {
    if (clipView) {
      actor.renderState.currentView = clipView;
    }
    setPlaybackIntent(actor, stagedIntent);
  }

  timeline.set(actor.playbackState, {
    currentIntent: stagedIntent,
    clipTimeSeconds: 0,
    durationSeconds: stagedIntent.duration || 1,
  }, startDelay);
  timeline.to(actor.playbackState, {
    clipTimeSeconds: actionDuration * spd,
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
  // Note: Do NOT add displayKeyframes/opacity animations to ambient.
  // They can leave stale opacity values that cause actors to dissolve.

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

  const maxExplicitDuration = Math.max(
    0,
    ...compiledBindings.map(b => (b.start_time || 0) + (b.duration_seconds || 1))
  );

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
    
    // Stretch ambient loops to ensure they do not freeze before the longest actor animation
    const safeDuration = Math.max(binding.duration_seconds, maxExplicitDuration);
    addAmbientBindingToTimeline(tl, target, binding, safeDuration);
  });
  if (backgroundBindings.length > 0) {
    console.log(`[timeline]   background ambient bindings=${backgroundBindings.length}`);
  }

  if (compiledScene && compiledScene.instance_tracks.length > 0) {
    compiledScene.instance_tracks.forEach(track => {
      const id = track.actor_id;
      const rig = availableRigs[id];
      const ikActor = ensureIKActor(id, rig);
      const initialDirection = [...track.clip_bindings]
        .sort((left, right) => left.start_time - right.start_time)[0]
        ?.ik_playback?.motion_spec?.locomotion?.preferredDirection;
      const initialFacingSign = facingSignForDirection(initialDirection);

      addCompiledTransformTrack(tl, container, id, track.transform_track, initialFacingSign);

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
            availableRigViewIds(rig).forEach(v => {
              tl.set(`#actor_group_${id} #${v}`, {
                display: v === clipView ? "inline" : "none",
              }, startDelay);
            });
          }
        }

        if (isBaseObjectBinding) {
          // base_object bindings use the transform track for position, but
          // can still play IK bone animation from the compiled ik_playback
          if (binding.ik_playback && ikActor) {
            addCanonicalIKPlayback({
              timeline: tl,
              actor: ikActor,
              clipView: binding.ik_playback.view ?? binding.view,
              compiledIK: binding.ik_playback,
              amp,
              spd,
              startDelay,
              actionDuration,
            });
          }
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
      });
    });

    tl.__ikSync = () => {
      syncPlaybackActors(Array.from(ikActors.values()));
    };

    // Audio / Lipsync Visemes
    if (beat.audio && beat.audio.length > 0) {
      beat.audio.forEach((audioItem, idx) => {
        if (!audioItem.audio_data_url) return;

        const audioElId = `__audio_${audioItem.type}_${audioItem.actor_id || "scene"}_${idx}`;
        let audioEl = container.querySelector<HTMLAudioElement>(`#${audioElId}`);
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.id = audioElId;
          audioEl.src = audioItem.audio_data_url;
          audioEl.style.display = "none";
          audioEl.crossOrigin = "anonymous";
          container.appendChild(audioEl);
        }

        if (audioItem.type === 'dialogue' && audioItem.actor_id && audioItem.visemes && audioItem.visemes.length > 0) {
          // Dialogue with lip-sync visemes
          const actorId = audioItem.actor_id;
          const startTime = audioItem.start_time ?? 0;
          const lastViseme = audioItem.visemes[audioItem.visemes.length - 1];
          const audioEnd = startTime + lastViseme.time + lastViseme.duration;
          
          // Play audio naturally — don't scrub currentTime (causes garbled sound)
          // To ensure it stops when the timeline pauses, we check the global tl.isActive()
          tl.add(() => {
            if (tl.isActive() && !tl.paused()) {
              audioEl!.currentTime = 0;
              audioEl!.play().catch(() => {});
            }
          }, startTime);
          
          tl.add(() => {
            audioEl?.pause();
          }, audioEnd);
          
          // Attach audio element to timeline so external controls can pause it
          if (!(tl as any).audioElements) (tl as any).audioElements = [];
          (tl as any).audioElements.push(audioEl);

          // Build SVG Mouth Visibility Keyframes based on phoneme timings
          const mouthVisemes = ["A", "E", "I", "O", "U", "M", "idle"];
          const actorGroup = container.querySelector(actorId.startsWith("scene") ? `#${actorId}` : `#actor_group_${actorId}`);
          
          if (actorGroup) {
            // Physical jaw movement for bone rigs
            const jawNode = actorGroup.querySelector(`[id$="jaw"]`) as SVGElement | null;
            const hasExplicitVisemes = actorGroup.querySelector(`[id$="mouth_A"]`) !== null;
            const forceJawMotion = audioItem.delivery_style?.toLowerCase().includes('jaw');

            if (jawNode && (!hasExplicitVisemes || forceJawMotion)) {
              // Jaw exists: Hide ALL SVG mouths during speech
              mouthVisemes.forEach(v => {
                const el = actorGroup.querySelector(`[id$="mouth_${v}"]`) as SVGElement | null;
                // We use set for strict display toggling
                if (el) {
                    tl.set(el, { display: "none" }, startTime);
                    // Restore idle mouth after speech
                    if (v === "idle") tl.set(el, { display: "inline" }, audioEnd);
                }
              });

              // Take over jaw by feeding rotations natively into the IK engine's state
              const ikActorForJaw = ikActors.get(actorId);

              if (ikActorForJaw && jawNode.id) {
                if (!ikActorForJaw.playbackState.speechRotations) {
                  ikActorForJaw.playbackState.speechRotations = {};
                }
                ikActorForJaw.playbackState.speechRotations[jawNode.id] = 0;
                
                console.log(`[LipSync] Feeding Jaw Bone rotations to IK engine for '${actorId}': ${jawNode.id}`);

                audioItem.visemes.forEach((vKeyframe, idx) => {
                  const isOpenMouth = ["A", "E", "O", "U"].includes(vKeyframe.viseme);
                  const targetAngle = isOpenMouth ? 12 : (vKeyframe.viseme === "idle" ? 0 : 5);
                  
                  tl.to(ikActorForJaw.playbackState.speechRotations!, { 
                      [jawNode.id]: targetAngle, 
                      duration: 0.1, 
                      ease: "power1.out",
                      overwrite: false
                  }, startTime + vKeyframe.time);
                });
                
                tl.to(ikActorForJaw.playbackState.speechRotations!, { 
                    [jawNode.id]: 0, 
                    duration: 0.2, 
                    ease: "power1.out",
                    overwrite: false
                }, audioEnd);
              } else {
                 // Fallback if jaw node didn't resolve to an IK actor correctly
                 console.warn(`[LipSync] Could not resolve IK Actor for jaw bone '${jawNode.id}'. Skipping jaw animation.`);
              }

            } else {
              // No Jaw: Use SVG viseme swapping
              
              // Ensure we start from a clean state at startTime
              mouthVisemes.forEach(v => {
                const el = actorGroup.querySelector(`[id$="mouth_${v}"]`) as SVGElement | null;
                if (el) tl.set(el, { display: v === "idle" ? "inline" : "none" }, startTime);
              });

              audioItem.visemes.forEach((vKeyframe, idx) => {
                const kTime = startTime + vKeyframe.time;
                const prevViseme = idx === 0 ? "idle" : audioItem.visemes![idx-1].viseme;
                const currViseme = vKeyframe.viseme;
                
                if (prevViseme !== currViseme) {
                    const prevEl = actorGroup.querySelector(`[id$="mouth_${prevViseme}"]`) as SVGElement | null;
                    const currEl = actorGroup.querySelector(`[id$="mouth_${currViseme}"]`) as SVGElement | null;
                    
                    if (prevEl) tl.set(prevEl, { display: "none" }, kTime);
                    if (currEl) tl.set(currEl, { display: "inline" }, kTime);
                }
              });
              
              const lastViseme = audioItem.visemes![audioItem.visemes!.length - 1]?.viseme || "idle";
              if (lastViseme !== "idle") {
                 const prevEl = actorGroup.querySelector(`[id$="mouth_${lastViseme}"]`) as SVGElement | null;
                 const idleEl = actorGroup.querySelector(`[id$="mouth_idle"]`) as SVGElement | null;
                 if (prevEl) tl.set(prevEl, { display: "none" }, audioEnd);
                 if (idleEl) tl.set(idleEl, { display: "inline" }, audioEnd);
              }
            }
          }
        } else {
          // SFX / Music — play audio synced to timeline without visemes
          tl.add(() => {
            if (tl.isActive() && !tl.paused()) {
              audioEl!.currentTime = 0;
              audioEl!.play().catch(() => {});
            }
          }, 0);
          tl.add(() => {
            audioEl?.pause();
          }, tl.duration());
          
          if (!(tl as any).audioElements) (tl as any).audioElements = [];
          (tl as any).audioElements.push(audioEl);
        }
      });
    }

    if (beat.camera && (beat.camera.x !== undefined || beat.camera.y !== undefined || beat.camera.zoom !== undefined || beat.camera.target_x !== undefined || beat.camera.target_y !== undefined || beat.camera.target_zoom !== undefined)) {
      const cameraGroup = container.querySelector<SVGGElement>("#__camera_layer");
      if (cameraGroup) {
        // Assume landscape for compiled scene resolution playback logic internally inside builder
        const { width: stageW, height: stageH } = getStageDims("landscape");
        
        const startX = clampCam(beat.camera.x ?? (stageW / 2), stageW / 2);
        const startY = clampCam(beat.camera.y ?? (stageH / 2), stageH / 2);
        const startZoom = clampZoom(beat.camera.zoom ?? 1);
        const startRotation = beat.camera.rotation ?? 0;

        const tgtX = clampCam(beat.camera.target_x ?? startX, startX);
        const tgtY = clampCam(beat.camera.target_y ?? startY, startY);
        const tgtZoom = clampZoom(beat.camera.target_zoom ?? startZoom, startZoom);
        const tgtRotation = beat.camera.rotation ?? startRotation; // Assuming no target rotation for now

        // Use fixed transformOrigin at stage center — GSAP cannot interpolate transformOrigin strings
        const originX = stageW / 2;
        const originY = stageH / 2;
        tl.fromTo(cameraGroup, {
            x: originX - startX,
            y: originY - startY,
            scaleX: startZoom,
            scaleY: startZoom,
            rotation: startRotation,
            transformOrigin: `${originX}px ${originY}px`
        }, {
            x: originX - tgtX,
            y: originY - tgtY,
            scaleX: tgtZoom,
            scaleY: tgtZoom,
            rotation: tgtRotation,
            transformOrigin: `${originX}px ${originY}px`,
            duration: tl.duration(),
            ease: "power1.inOut"
        }, 0);
      }
    }

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
        availableRigViewIds(rig).forEach(v => {
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

    tl.set(`#actor_group_${id}`, {}, startDelay + actionDuration);
  });

  let lastRotations: Record<string, number> | null = null;
  tl.__ikSync = () => {
    const actorsList = Array.from(ikActors.values());
    syncPlaybackActors(actorsList);
  };

  if (beat.camera && (beat.camera.target_x !== undefined || beat.camera.target_y !== undefined || beat.camera.target_zoom !== undefined)) {
    const cameraGroup = container.querySelector<SVGGElement>("#__camera_layer");
    if (cameraGroup) {
      const { width: stageW, height: stageH } = getStageDims("landscape");
      const tgtX = clampCam(beat.camera.target_x ?? beat.camera.x ?? (stageW / 2), stageW / 2);
      const tgtY = clampCam(beat.camera.target_y ?? beat.camera.y ?? (stageH / 2), stageH / 2);
      const tgtZoom = clampZoom(beat.camera.target_zoom ?? beat.camera.zoom ?? 1);

      tl.to(cameraGroup, {
          x: (stageW / 2) - tgtX,
          y: (stageH / 2) - tgtY,
          scaleX: tgtZoom,
          scaleY: tgtZoom,
          transformOrigin: `${tgtX}px ${tgtY}px`,
          duration: tl.duration(),
          ease: "power1.inOut"
      }, 0);
    }
  }

  console.log(`[timeline] Built — duration: ${tl.duration().toFixed(2)}s, tweens: ${tl.getChildren().length}`);
  return tl;
}
