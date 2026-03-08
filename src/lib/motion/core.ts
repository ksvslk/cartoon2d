import gsap from "gsap";
import { StoryBeatData } from "../schema/story";
import { DraftsmanData } from "../schema/rig";

// Base interface for the context we pass to the animation engine
export interface AnimationContext {
  container: HTMLElement;
  beat: StoryBeatData;
  availableRigs: Record<string, DraftsmanData>;
}

/**
 * The Core Motion Engine
 * Parses a scene's semantic actions and dispatches them to GSAP.
 */
export function animateScene(context: AnimationContext) {
  const { container, beat, availableRigs } = context;

  // We use gsap.context to ensure all animations created here are scope-bound
  // to this specific React component, preventing memory leaks when unmounting.
  return gsap.context(() => {
    
    // 1. Initial State Setup
    // Ensure all characters default to their 'front' view, hidden otherwise.
    beat.actions.forEach(action => {
      const actorId = action.actor_id;
      // Setup the base actor group
      gsap.set(`#actor_group_${actorId} #view_front`, { display: "inline" });
      gsap.set(`#actor_group_${actorId} #view_side_right`, { display: "none" });
      gsap.set(`#actor_group_${actorId} #view_back`, { display: "none" });

      // Apply a generic 'breathing' idle animation to everyone initially
      applyIdleBreathing(actorId);
    });

    // 2. Dispatch Semantic Actions
    // Loop through the AI-generated actions and trigger specific procedural templates
    beat.actions.forEach(action => {
      const actorId = action.actor_id;
      const motion = action.motion.toLowerCase();
      const rig = availableRigs[actorId];
      
      console.log(`[Motion Engine] Dispatching '${motion}' for ${actorId}`);

      switch (motion) {
        case 'run':
        case 'walk':
          applyRunCycle(actorId, action, rig);
          break;
        case 'panic':
          applyPanicShake(actorId);
          break;
        case 'hide':
          applyHideAnimation(actorId);
          break;
        case 'stare':
        case 'idle':
        default:
          // Just let the breathing loop continue
          break;
      }
    });

  }, container);
}

// --- Procedural Animation Templates ---

function applyIdleBreathing(actorId: string) {
  // A gentle scale squash and stretch on the torso
  gsap.to(`#actor_group_${actorId} [id$="_torso"]`, {
    scaleY: 1.05,
    scaleX: 0.98,
    duration: 1.5,
    yoyo: true,
    repeat: -1,
    ease: "sine.inOut"
  });
}

function applyRunCycle(actorId: string, action: any, rig?: DraftsmanData) {
  const duration = action.duration_seconds || 2;
  const targetX = action.target_spatial_transform?.x;
  const targetY = action.target_spatial_transform?.y;
  const targetScale = action.target_spatial_transform?.scale;

  // 1. Switch to Side View for running
  gsap.set(`#actor_group_${actorId} #view_front`, { display: "none" });
  gsap.set(`#actor_group_${actorId} #view_side_right`, { display: "inline" });

  // 2. Animate the whole body moving across the screen
  const motionProps: any = { duration: duration, ease: "power1.inOut" };
  if (targetX !== undefined) motionProps.x = targetX - (action.spatial_transform?.x || 500); // Relative movement if x is mapped to translation
  else motionProps.x = "+=500"; // Fallback
  
  if (targetY !== undefined) motionProps.y = targetY - (action.spatial_transform?.y || 800);
  if (targetScale !== undefined) motionProps.scale = targetScale;
  
  // Since actorGroup is already translated to its starting position, we can animate `x` and `y` relative to that,
  // or absolute to SVG origin. GSAP animates transforms, so 'x' animates the transform translation.
  // The initial translation is set via setAttribute("transform", "translate(X, Y)"). 
  // GSAP parses this. Animating x: targetX directly works if GSAP reads the absolute translation as x.
  // Actually, GSAP maps x and y to the transform string. Let's just animate to the target coordinates!
  motionProps.x = targetX !== undefined ? targetX : "+=500";
  motionProps.y = targetY !== undefined ? targetY : undefined;
  
  gsap.to(`#actor_group_${actorId}`, motionProps);

  // 3. Bob the body up and down
  gsap.to(`#actor_group_${actorId}`, {
    y: "-=20",
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    ease: "sine.inOut"
  });

  // 4. Scissor the legs using actual mathematical pivot points if available
  
  // Find leg bones in the side view to extract precise pivot coordinates
  const leftLegBone = rig?.rig_data.bones.find(b => b.id.includes("side_") && b.id.includes("leg_l"));
  const rightLegBone = rig?.rig_data.bones.find(b => b.id.includes("side_") && b.id.includes("leg_r"));
  
  const leftPivot = leftLegBone?.pivot ? `${leftLegBone.pivot.x} ${leftLegBone.pivot.y}` : "top center";
  const rightPivot = rightLegBone?.pivot ? `${rightLegBone.pivot.x} ${rightLegBone.pivot.y}` : "top center";

  // Use the exact side view IDs if possible, or fallback to wildcard
  const leftLegSelector = leftLegBone ? `#actor_group_${actorId} #${leftLegBone.id}` : `#actor_group_${actorId} [id$="_leg_left"]`;
  const rightLegSelector = rightLegBone ? `#actor_group_${actorId} #${rightLegBone.id}` : `#actor_group_${actorId} [id$="_leg_right"]`;

  gsap.to(leftLegSelector, {
    rotation: 45,
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    svgOrigin: leftLegBone?.pivot ? leftPivot : undefined, // svgOrigin is specifically for absolute SVG coordinates
    transformOrigin: !leftLegBone?.pivot ? leftPivot : undefined, // fallback for CSS transforms
    ease: "sine.inOut"
  });

  gsap.to(rightLegSelector, {
    rotation: -45,
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    svgOrigin: rightLegBone?.pivot ? rightPivot : undefined,
    transformOrigin: !rightLegBone?.pivot ? rightPivot : undefined,
    ease: "sine.inOut"
  });
}

function applyPanicShake(actorId: string) {
  gsap.to(`#actor_group_${actorId}`, {
    x: "+=10",
    duration: 0.05,
    yoyo: true,
    repeat: 20,
    ease: "rough({ template: none.out, strength: 1, points: 20, taper: none, randomize: true, clamp: false })"
  });
}

function applyHideAnimation(actorId: string) {
  gsap.to(`#actor_group_${actorId}`, {
    y: "+=150",
    opacity: 0,
    duration: 1,
    ease: "back.in(1.7)"
  });
}
