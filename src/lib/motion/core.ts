import gsap from "gsap";
import { StoryBeatData } from "../schema/story";

// Base interface for the context we pass to the animation engine
export interface AnimationContext {
  container: HTMLElement;
  beat: StoryBeatData;
}

/**
 * The Core Motion Engine
 * Parses a scene's semantic actions and dispatches them to GSAP.
 */
export function animateScene(context: AnimationContext) {
  const { container, beat } = context;

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
      
      console.log(`[Motion Engine] Dispatching '${motion}' for ${actorId}`);

      switch (motion) {
        case 'run':
        case 'walk':
          applyRunCycle(actorId, action.duration_seconds || 2);
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

function applyRunCycle(actorId: string, duration: number) {
  // 1. Switch to Side View for running
  gsap.set(`#actor_group_${actorId} #view_front`, { display: "none" });
  gsap.set(`#actor_group_${actorId} #view_side_right`, { display: "inline" });

  // 2. Animate the whole body moving across the screen
  gsap.to(`#actor_group_${actorId}`, {
    x: "+=500", // Move right
    duration: duration,
    ease: "power1.inOut"
  });

  // 3. Bob the body up and down
  gsap.to(`#actor_group_${actorId}`, {
    y: "-=20",
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    ease: "sine.inOut"
  });

  // 4. Scissor the legs (using wildcard selectors to grab the side view legs)
  gsap.to(`#actor_group_${actorId} [id$="_leg_left"]`, {
    rotation: 45,
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    transformOrigin: "top center", // Basic fallback if JSON pivot fails
    ease: "sine.inOut"
  });

  gsap.to(`#actor_group_${actorId} [id$="_leg_right"]`, {
    rotation: -45,
    duration: 0.2,
    yoyo: true,
    repeat: -1,
    transformOrigin: "top center",
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
