import gsap from "gsap";
import { CompiledSceneData, StoryBeatData } from "../schema/story";
import { DraftsmanData, AnimationKeyframe } from "../schema/rig";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "./semantics";

const ALL_VIEWS = ["view_front", "view_side_right", "view_3q_right", "view_top", "view_back"] as const;

/** Show one view, hide all others for an actor group (immediate gsap.set). */
function switchView(actorId: string, targetView: string) {
  ALL_VIEWS.forEach(v => {
    gsap.set(`#actor_group_${actorId} #${v}`, {
      display: v === targetView ? "inline" : "none",
    });
  });
}

export interface AnimationContext {
  container: HTMLElement;
  beat: StoryBeatData;
  compiledScene?: CompiledSceneData | null;
  availableRigs: Record<string, DraftsmanData>;
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

/** Scale a property value by amplitude, capping opacity at 1. */
function scaleProp(prop: string, value: number, amp: number): number {
  const scaled = value * amp;
  return prop === "opacity" ? Math.min(1, scaled) : scaled;
}

// ── Object Ambient Patterns ───────────────────────────────────────────────────
// SVG element IDs matching these patterns receive looping ambient animations.

export const OBJECT_ANIM_PATTERNS: Array<{
  regex: RegExp;
  label: string;
  animate: (el: Element) => void;
}> = [
  {
    regex: /fire|flame|blaze/i,
    label: "flicker",
    animate: (el) => gsap.to(el, {
      scaleY: 1.12, scaleX: 0.92,
      duration: 0.12, yoyo: true, repeat: -1, ease: "none",
      transformOrigin: "center bottom",
    }),
  },
  {
    regex: /smoke|steam|mist|vapor/i,
    label: "rise",
    animate: (el) => gsap.to(el, {
      y: "-=18", opacity: 0.3,
      duration: 2 + Math.random() * 0.8, yoyo: true, repeat: -1, ease: "sine.inOut",
    }),
  },
  {
    regex: /water|wave|ripple|river|ocean|sea|lake/i,
    label: "ripple",
    animate: (el) => gsap.to(el, {
      x: "+=10", duration: 1.5, yoyo: true, repeat: -1, ease: "sine.inOut",
    }),
  },
  {
    regex: /leaf|foliage|tree|bush|grass|plant|vine/i,
    label: "sway",
    animate: (el) => gsap.to(el, {
      rotation: 4,
      duration: 1.8 + Math.random() * 0.6, yoyo: true, repeat: -1, ease: "sine.inOut",
      transformOrigin: "center bottom",
    }),
  },
  {
    regex: /flag|banner|cloth|curtain|drape/i,
    label: "wave",
    animate: (el) => gsap.to(el, {
      rotation: 6,
      duration: 0.9, yoyo: true, repeat: -1, ease: "sine.inOut",
      transformOrigin: "left center",
    }),
  },
  {
    regex: /cloud/i,
    label: "drift",
    animate: (el) => gsap.to(el, {
      x: "+=30",
      duration: 8 + Math.random() * 4, yoyo: true, repeat: -1, ease: "sine.inOut",
    }),
  },
  {
    regex: /light|lamp|glow|blink|flash/i,
    label: "pulse",
    animate: (el) => gsap.to(el, {
      opacity: 0.4, duration: 1.2, yoyo: true, repeat: -1, ease: "sine.inOut",
    }),
  },
];

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

// ── Generic Clip Player (ambient use only) ───────────────────────────────────

/**
 * Plays a named animation clip with repeat: -1 looping (for ambient idle).
 * Falls back to a simple whole-body pulse if the clip is missing.
 */
function playClip(
  actorId: string,
  clipName: string,
  rig: DraftsmanData | undefined,
  container: HTMLElement,
) {
  const rawClip = rig?.rig_data.animation_clips?.[clipName];

  let keyframes: AnimationKeyframe[];
  let clipView: string | undefined;

  if (!rawClip) {
    console.warn(`[ambient] No clip "${clipName}" for actor "${actorId}" — using fallback pulse`);
    gsap.to(`#actor_group_${actorId}`, {
      scaleY: 1.04, scaleX: 0.97,
      duration: 1.6, yoyo: true, repeat: -1, ease: "sine.inOut",
      transformOrigin: "center bottom",
    });
    return;
  }

  if (Array.isArray(rawClip)) {
    keyframes = rawClip;
  } else {
    keyframes = rawClip.keyframes;
    clipView  = rawClip.view;
  }

  if (keyframes.length === 0) {
    console.warn(`[ambient] Clip "${clipName}" for actor "${actorId}" has 0 keyframes`);
    return;
  }

  console.log(`[ambient] Playing clip "${clipName}" (view: ${clipView ?? "none"}) on "${actorId}" — ${keyframes.length} keyframes`);

  if (clipView) {
    switchView(actorId, clipView);
  }

  const pivotMap: Record<string, { x: number; y: number }> = {};
  rig!.rig_data.bones.forEach(b => {
    if (b.pivot) pivotMap[b.id] = b.pivot;
  });

  keyframes.forEach(k => {
    const pivot = pivotMap[k.bone];

    const tweenVars: gsap.TweenVars = {
      [k.prop]: k.to,
      duration: k.duration,
      yoyo:     k.yoyo   ?? false,
      repeat:   k.repeat ?? 0,
      ease:     k.ease   ?? "sine.inOut",
      delay:    k.delay  ?? 0,
      overwrite: "auto",
    };

    if (pivot) tweenVars.svgOrigin = `${pivot.x} ${pivot.y}`;

    // Use attribute selector — bone IDs may start with digits (e.g. "3q_torso"),
    // which makes #3q_torso an invalid CSS selector.
    const target = `#actor_group_${actorId} [id="${k.bone}"]`;

    if (k.from !== undefined) {
      gsap.fromTo(target, { [k.prop]: k.from }, tweenVars);
    } else {
      gsap.to(target, tweenVars);
    }
  });
}

// ── Ambient Layer ─────────────────────────────────────────────────────────────

/**
 * Always-on looping animations:
 *  • Character idle clip from rig (falls back to simple breathing if missing).
 *  • Object ambient loops (fire, smoke, etc.) detected by ID pattern.
 */
export function animateAmbient(context: AnimationContext): gsap.Context {
  const { container, beat, compiledScene, availableRigs } = context;

  const actorIds = compiledScene?.instance_tracks.map(track => track.actor_id) ?? beat.actions.map(a => a.actor_id);
  console.log(`[ambient] Starting ambient for scene ${beat.scene_number} — actors: ${actorIds.join(", ")}`);

  return gsap.context(() => {
    // Object ambient — scan all SVG elements with recognised ID patterns
    const matchedObjects: string[] = [];
    container.querySelectorAll("[id]").forEach(el => {
      const id = el.getAttribute("id") || "";
      for (const { regex, label, animate } of OBJECT_ANIM_PATTERNS) {
        if (regex.test(id)) {
          animate(el);
          matchedObjects.push(`${id} (${label})`);
          break;
        }
      }
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
      if (rig.rig_data.animation_clips?.idle) {
        playClip(actorId, "idle", rig, container);
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
 *   2. Bone-level animation clips with style modulation (amplitude + speed).
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

  const tl = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });

  if (compiledScene && compiledScene.instance_tracks.length > 0) {
    compiledScene.instance_tracks.forEach(track => {
      const id = track.actor_id;
      const rig = availableRigs[id];

      track.clip_bindings.forEach(binding => {
        const m = normalizeMotionKey(binding.motion);
        const actionDuration = binding.duration_seconds || 2;
        const amp = binding.amplitude ?? 1.0;
        const spd = binding.speed ?? 1.0;
        const startDelay = binding.start_time ?? 0;

        console.log(`[timeline]   actor="${id}" clip="${binding.clip_id}" motion="${m}" → amp=${amp.toFixed(2)} spd=${spd.toFixed(2)} delay=${startDelay}`);

        const startX = binding.start_transform.x;
        const startY = binding.start_transform.y;
        const startScale = binding.start_transform.scale;
        const endX = binding.end_transform?.x;
        const endY = binding.end_transform?.y;
        const endScale = binding.end_transform?.scale;
        const deltaX = endX !== undefined ? endX - startX : 0;
        const deltaY = endY !== undefined ? endY - startY : 0;
        const isMoving = motionNeedsTarget(m) || Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10;

        if (isMoving && deltaX < -10) {
          const group = container.querySelector<SVGGElement>(`#actor_group_${id}`);
          if (group) {
            const naturalCX = parseFloat(group.dataset.naturalCx || "500");
            const naturalBottom = parseFloat(group.dataset.naturalBottom || "1000");
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

        if (!rig) {
          console.warn(`[timeline]   No rig found for actor "${id}" — skipping bone animation`);
          return;
        }

        const availableClips = Object.keys(rig.rig_data.animation_clips ?? {});
        const rawClip = rig.rig_data.animation_clips?.[binding.clip_id];

        if (!rawClip) {
          console.warn(`[timeline]   No clip "${binding.clip_id}" for actor "${id}" — available: [${availableClips.join(", ")}] — using fallback pulse`);
          const tweenDur = 1.6 / spd;
          tl.to(`#actor_group_${id}`, {
            scaleY: 1 + (0.04 * amp),
            scaleX: 1 - (0.03 * amp),
            duration: tweenDur,
            yoyo: true,
            repeat: calcRepeat(actionDuration, tweenDur, true),
            ease: "sine.inOut",
            transformOrigin: "center bottom",
          }, startDelay);
          return;
        }

        let keyframes: AnimationKeyframe[];
        let clipView: string | undefined = binding.view;

        if (Array.isArray(rawClip)) {
          keyframes = rawClip;
        } else {
          keyframes = rawClip.keyframes;
          clipView = clipView ?? rawClip.view;
        }

        if (keyframes.length === 0) {
          console.warn(`[timeline]   Clip "${binding.clip_id}" for actor "${id}" has 0 keyframes`);
          return;
        }

        if (clipView) {
          ALL_VIEWS.forEach(v => {
            tl.set(`#actor_group_${id} #${v}`, {
              display: v === clipView ? "inline" : "none",
            }, startDelay);
          });
        }

        const pivotMap: Record<string, { x: number; y: number }> = {};
        rig.rig_data.bones.forEach(b => {
          if (b.pivot) pivotMap[b.id] = b.pivot;
        });

        keyframes.forEach(k => {
          const pivot = pivotMap[k.bone];
          const scaledTo = scaleProp(k.prop, k.to, amp);
          const scaledFrom = k.from !== undefined ? scaleProp(k.prop, k.from, amp) : undefined;
          const tweenDur = (k.duration || 0.5) / spd;
          const boneDelay = (k.delay ?? 0) / spd;
          const yoyo = k.yoyo ?? false;

          const repeat = k.repeat === -1
            ? calcRepeat(actionDuration - boneDelay, tweenDur, yoyo)
            : (k.repeat ?? 0);

          const tweenVars: gsap.TweenVars = {
            [k.prop]: scaledTo,
            duration: tweenDur,
            yoyo,
            repeat,
            ease: k.ease ?? "sine.inOut",
            overwrite: "auto",
          };

          if (pivot) tweenVars.svgOrigin = `${pivot.x} ${pivot.y}`;

          const target = `#actor_group_${id} [id="${k.bone}"]`;
          const position = startDelay + boneDelay;

          if (scaledFrom !== undefined) {
            tl.fromTo(target, { [k.prop]: scaledFrom }, tweenVars, position);
          } else {
            tl.to(target, tweenVars, position);
          }
        });
      });
    });

    console.log(`[timeline] Built — duration: ${tl.duration().toFixed(2)}s, tweens: ${tl.getChildren().length}`);
    return tl;
  }

  beat.actions.forEach(action => {
    const id             = action.actor_id;
    const rig            = availableRigs[id];
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

    // ── 2. Bone animation from rig clip ────────────────────────────────────
    if (!rig) {
      console.warn(`[timeline]   No rig found for actor "${id}" — skipping bone animation`);
      return;
    }

    const availableClips = Object.keys(rig.rig_data.animation_clips ?? {});
    const resolvedClipKey = suggestMotionAliases(m).find(alias => rig.rig_data.animation_clips?.[alias]);
    const rawClip = resolvedClipKey ? rig.rig_data.animation_clips?.[resolvedClipKey] : undefined;

    if (!rawClip) {
      console.warn(`[timeline]   No clip "${m}" for actor "${id}" — available: [${availableClips.join(", ")}] — using fallback pulse`);
      // Fallback: whole-body pulse scaled by amplitude/speed
      const tweenDur = 1.6 / spd;
      tl.to(`#actor_group_${id}`, {
        scaleY: 1 + (0.04 * amp),
        scaleX: 1 - (0.03 * amp),
        duration: tweenDur,
        yoyo: true,
        repeat: calcRepeat(actionDuration, tweenDur, true),
        ease: "sine.inOut",
        transformOrigin: "center bottom",
      }, startDelay);
      return;
    }

    let keyframes: AnimationKeyframe[];
    let clipView: string | undefined;

    if (Array.isArray(rawClip)) {
      keyframes = rawClip;
    } else {
      keyframes = rawClip.keyframes;
      clipView  = rawClip.view;
    }

    if (keyframes.length === 0) {
      console.warn(`[timeline]   Clip "${m}" for actor "${id}" has 0 keyframes`);
      return;
    }

    console.log(`[timeline]   Clip "${resolvedClipKey ?? m}" → view="${clipView ?? "none"}" ${keyframes.length} keyframes`);

    // Switch to the appropriate view at the action start
    if (clipView) {
      ALL_VIEWS.forEach(v => {
        tl.set(`#actor_group_${id} #${v}`, {
          display: v === clipView ? "inline" : "none",
        }, startDelay);
      });
    }

    // Build pivot lookup map
    const pivotMap: Record<string, { x: number; y: number }> = {};
    rig!.rig_data.bones.forEach(b => {
      if (b.pivot) pivotMap[b.id] = b.pivot;
    });

    keyframes.forEach(k => {
      const pivot = pivotMap[k.bone];

      // Apply amplitude (scale rotation/position) and speed
      const scaledTo   = scaleProp(k.prop, k.to, amp);
      const scaledFrom = k.from !== undefined ? scaleProp(k.prop, k.from, amp) : undefined;
      const tweenDur   = (k.duration || 0.5) / spd;
      const boneDelay  = (k.delay ?? 0) / spd;
      const yoyo       = k.yoyo ?? false;

      const repeat = k.repeat === -1
        ? calcRepeat(actionDuration - boneDelay, tweenDur, yoyo)
        : (k.repeat ?? 0);

      const tweenVars: gsap.TweenVars = {
        [k.prop]: scaledTo,
        duration: tweenDur,
        yoyo,
        repeat,
        ease: k.ease ?? "sine.inOut",
        overwrite: "auto",
      };

      if (pivot) tweenVars.svgOrigin = `${pivot.x} ${pivot.y}`;

      // Use attribute selector — bone IDs may start with digits (e.g. "3q_torso")
      const target   = `#actor_group_${id} [id="${k.bone}"]`;
      const position = startDelay + boneDelay;   // timeline insert position

      if (scaledFrom !== undefined) {
        tl.fromTo(target, { [k.prop]: scaledFrom }, tweenVars, position);
      } else {
        tl.to(target, tweenVars, position);
      }
    });
  });

  console.log(`[timeline] Built — duration: ${tl.duration().toFixed(2)}s, tweens: ${tl.getChildren().length}`);
  return tl;
}
