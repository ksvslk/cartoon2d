import { z } from "zod";

export const PivotPointSchema = z.object({
    x: z.number().describe("The absolute X coordinate of the pivot point within the 1000x1000 viewBox."),
    y: z.number().describe("The absolute Y coordinate of the pivot point within the 1000x1000 viewBox.")
});

export const RigBoneSchema = z.object({
    id: z.string().describe("The exact ID of the <g> tag in the SVG that this bone controls (e.g., 'side_leg_right')."),
    pivot: PivotPointSchema.optional().describe("The point this bone rotates around."),
    rotationLimit: z.array(z.number()).length(2).optional().describe("Min and max rotation bounds in degrees, e.g., [-45, 90]."),
    parent: z.string().optional().describe("The ID of the parent bone, for hierarchy.")
});

export const AnimationKeyframeSchema = z.object({
    bone: z.string().describe("Exact bone ID from rig_data.bones to animate."),
    prop: z.enum(["rotation", "x", "y", "scaleX", "scaleY", "opacity"])
        .describe("The GSAP property to tween."),
    from: z.number().optional()
        .describe("Start value. If omitted, tweens from the element's current value."),
    to: z.number()
        .describe("Target value."),
    duration: z.number()
        .describe("Duration of one tween cycle in seconds."),
    yoyo: z.boolean().optional().default(false)
        .describe("If true, tween reverses back after reaching 'to'. Use for oscillation."),
    repeat: z.number().optional().default(0)
        .describe("-1 = loop forever (idle/walk cycles). 0 = play once."),
    ease: z.string().optional().default("sine.inOut")
        .describe("GSAP ease string."),
    delay: z.number().optional().default(0)
        .describe("Seconds before this keyframe starts. Use to offset limb phase."),
});

/**
 * A named animation clip.
 * `view` tells the player which top-level view group to show before playing.
 * Supports legacy array format (no view switch) for backward compatibility.
 */
export const AnimationClipSchema = z.union([
    // New format: explicit view + keyframes
    z.object({
        view: z.string().optional()
            .describe("The view group to switch to, e.g. 'view_side_right', 'view_front', 'view_3q_right'."),
        keyframes: z.array(AnimationKeyframeSchema),
    }),
    // Legacy format: bare array (treated as no view switch)
    z.array(AnimationKeyframeSchema),
]);

export const RigSchema = z.object({
    bones: z.array(RigBoneSchema),
    interactionNulls: z.array(z.string()),
    visemes: z.array(z.string()).optional(),
    emotions: z.array(z.string()).optional(),
    animation_clips: z.record(z.string(), AnimationClipSchema).optional()
        .describe("Optional reusable motion clips compiled for this rig. Motion names map to { view, keyframes }."),
});

export const DraftsmanSchema = z.object({
    svg_data: z.string().describe("The raw SVG string. Must use viewBox='0 0 1000 1000'."),
    rig_data: RigSchema,
});

export type RigData = z.infer<typeof RigSchema>;
export type DraftsmanData = z.infer<typeof DraftsmanSchema>;
export type AnimationKeyframe = z.infer<typeof AnimationKeyframeSchema>;
export type AnimationClip = z.infer<typeof AnimationClipSchema>;
