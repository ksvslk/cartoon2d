import gsap from "gsap";
import { StoryBeatData } from "../schema/story";
import { DraftsmanData } from "../schema/rig";
import type { RigBoneSchema } from "../schema/rig";
import { z } from "zod";

type Bone = z.infer<typeof RigBoneSchema>;

export interface AnimationContext {
  container: HTMLElement;
  beat: StoryBeatData;
  availableRigs: Record<string, DraftsmanData>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function boneSide(bone: Bone): "left" | "right" | "center" {
  const n = bone.id.toLowerCase();
  if (/_l(_|$)/.test(n) || n.includes("left")  || n.startsWith("l_")) return "left";
  if (/_r(_|$)/.test(n) || n.includes("right") || n.startsWith("r_")) return "right";
  if (bone.pivot) {
    if (bone.pivot.x < 450) return "left";
    if (bone.pivot.x > 550) return "right";
  }
  return "center";
}

/** GSAP origin props — prefer svgOrigin (absolute SVG coords) when a pivot exists. */
function pivotProps(bone: Bone): gsap.TweenVars {
  if (bone.pivot) return { svgOrigin: `${bone.pivot.x} ${bone.pivot.y}` };
  return { transformOrigin: "top center" };
}

// ── Object Ambient Patterns ──────────────────────────────────────────────────
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

/**
 * Scan the container's DOM for SVG elements whose IDs match ambient patterns.
 * Returns descriptors so the UI can list them per-scene.
 */
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

// ── Ambient Layer ─────────────────────────────────────────────────────────────
/**
 * Always-on looping animations:
 *  • Character idle (breathing / micro-sway) for every actor in the beat.
 *  • Object ambient loops (fire flicker, smoke rise, etc.) detected by ID pattern.
 *
 * Start this immediately after the SVG is assembled.
 * Revert it when the scene changes or the component unmounts.
 */
export function animateAmbient(context: AnimationContext): gsap.Context {
  const { container, beat, availableRigs } = context;

  return gsap.context(() => {
    // Object animations — scan all SVG elements with recognised IDs
    container.querySelectorAll("[id]").forEach(el => {
      const id = el.getAttribute("id") || "";
      for (const { regex, animate } of OBJECT_ANIM_PATTERNS) {
        if (regex.test(id)) {
          animate(el);
          break;
        }
      }
    });

    // Character idle animations
    beat.actions.forEach(action => {
      applyIdle(action.actor_id, availableRigs[action.actor_id]);
    });
  }, container);
}

// ── Timeline Layer ─────────────────────────────────────────────────────────────
/**
 * Scripted / keyframed animations driven by the play button.
 * Each action in the beat drives its actor: walk, panic, hide, etc.
 * Idle/stare motions are intentionally omitted here — ambient already handles them.
 */
export function animateTimeline(context: AnimationContext): gsap.Context {
  const { container, beat, availableRigs } = context;

  return gsap.context(() => {
    beat.actions.forEach(action => {
      const id  = action.actor_id;
      const rig = availableRigs[id];

      // Default front-facing; walk overrides to side view
      gsap.set(`#actor_group_${id} #view_front`,      { display: "inline" });
      gsap.set(`#actor_group_${id} #view_side_right`, { display: "none"   });
      gsap.set(`#actor_group_${id} #view_back`,       { display: "none"   });

      const m = action.motion.toLowerCase();
      console.log(`[Timeline] '${m}' → ${id}`);

      switch (m) {
        case "run":
        case "walk":
          applyWalkCycle(id, action, rig);
          break;
        case "panic":
          applyPanic(id, rig);
          break;
        case "hide":
          applyHide(id);
          break;
        // idle / stare: ambient covers this, nothing extra needed
      }
    });
  }, container);
}

// ── Motion Templates ──────────────────────────────────────────────────────────

/**
 * Walk / Run cycle.
 * Moves the whole group toward target_spatial_transform (if defined),
 * and drives EVERY rig bone with an alternating rotational cycle.
 */
function applyWalkCycle(actorId: string, action: any, rig?: DraftsmanData) {
  const duration = action.duration_seconds || 2;
  const startX: number = action.spatial_transform?.x ?? 500;
  const startY: number = action.spatial_transform?.y ?? 800;
  const endX: number | undefined = action.target_spatial_transform?.x;
  const endY: number | undefined = action.target_spatial_transform?.y;
  const endScale: number | undefined = action.target_spatial_transform?.scale;

  const deltaX = endX !== undefined ? endX - startX : 0;
  const deltaY = endY !== undefined ? endY - startY : 0;
  const isMoving = Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10;

  // Side view for walking
  gsap.set(`#actor_group_${actorId} #view_front`,      { display: "none"   });
  gsap.set(`#actor_group_${actorId} #view_side_right`, { display: "inline" });

  // Translate group to destination
  if (isMoving || endScale !== undefined) {
    const props: gsap.TweenVars = { duration, ease: "power1.inOut" };
    if (Math.abs(deltaX) > 10) props.x = `+=${deltaX}`;
    if (Math.abs(deltaY) > 10) props.y = `+=${deltaY}`;
    if (endScale !== undefined) { props.scaleX = endScale; props.scaleY = endScale; }
    gsap.to(`#actor_group_${actorId}`, props);
  }

  if (!rig) return;

  // Drive every bone in the rig with alternating left/right cycle
  const stepDur    = 0.2;
  const halfSwings = Math.max(1, Math.round(duration / stepDur)) - 1;

  rig.rig_data.bones.forEach(bone => {
    const side = boneSide(bone);
    const [minR, maxR] = bone.rotationLimit ?? [-35, 35];
    const amp = Math.max(Math.abs(minR), Math.abs(maxR));

    const delay     = side === "right" ? stepDur : 0;
    const direction = side === "right" ? -1 : 1;

    gsap.to(`#actor_group_${actorId} #${bone.id}`, {
      rotation: amp * direction,
      duration: stepDur,
      yoyo: true,
      repeat: halfSwings,
      delay,
      ease: "sine.inOut",
      overwrite: "auto",
      ...pivotProps(bone),
    });
  });
}

/**
 * Idle / Stare.
 * Root bones: slow breathing squash-stretch.
 * Limb bones: tiny micro-sway so they don't look frozen.
 */
function applyIdle(actorId: string, rig?: DraftsmanData) {
  if (!rig) {
    gsap.to(`#actor_group_${actorId}`, {
      scaleY: 1.02, scaleX: 0.99,
      duration: 1.8, yoyo: true, repeat: -1, ease: "sine.inOut",
      transformOrigin: "center bottom",
    });
    return;
  }

  const rootBones = rig.rig_data.bones.filter(b => !b.parent);
  const limbBones = rig.rig_data.bones.filter(b =>  b.parent);

  rootBones.forEach(bone => {
    gsap.to(`#actor_group_${actorId} #${bone.id}`, {
      scaleY: 1.03, scaleX: 0.98,
      duration: 1.6 + Math.random() * 0.4,
      yoyo: true, repeat: -1, ease: "sine.inOut",
      ...pivotProps(bone),
    });
  });

  limbBones.forEach(bone => {
    const [minR, maxR] = bone.rotationLimit ?? [-10, 10];
    const amp = Math.min(6, Math.max(Math.abs(minR), Math.abs(maxR)) * 0.15);
    gsap.to(`#actor_group_${actorId} #${bone.id}`, {
      rotation: amp,
      duration: 2 + Math.random() * 1,
      yoyo: true, repeat: -1, ease: "sine.inOut",
      ...pivotProps(bone),
    });
  });
}

/**
 * Panic.
 * Whole-body shake + every bone driven to its rotation extreme rapidly.
 */
function applyPanic(actorId: string, rig?: DraftsmanData) {
  gsap.to(`#actor_group_${actorId}`, {
    x: "+=12", duration: 0.05, yoyo: true, repeat: 20, ease: "none",
  });

  if (!rig) return;

  rig.rig_data.bones.forEach(bone => {
    const [minR, maxR] = bone.rotationLimit ?? [-40, 40];
    const amp = Math.max(Math.abs(minR), Math.abs(maxR));
    gsap.to(`#actor_group_${actorId} #${bone.id}`, {
      rotation: amp,
      duration: 0.08, yoyo: true, repeat: 12, ease: "none",
      overwrite: "auto",
      ...pivotProps(bone),
    });
  });
}

/**
 * Hide.
 * Slides the character down off-screen and fades out.
 */
function applyHide(actorId: string) {
  gsap.to(`#actor_group_${actorId}`, {
    y: "+=220", opacity: 0, duration: 0.8, ease: "back.in(1.7)",
    overwrite: "auto",
  });
}
