import { z } from "zod";
import { MotionDirectionSchema, MotionFamilySchema, MotionLocomotionModeSchema } from "./motion_spec";

export const PivotPointSchema = z.object({
    x: z.number().describe("The absolute X coordinate of the pivot point within the 1000x1000 viewBox."),
    y: z.number().describe("The absolute Y coordinate of the pivot point within the 1000x1000 viewBox.")
});

export const RigBoneKindSchema = z.enum([
    "root",
    "torso",
    "body",
    "neck",
    "head",
    "jaw",
    "arm_upper",
    "arm_lower",
    "hand",
    "leg_upper",
    "leg_lower",
    "foot",
    "tail_base",
    "tail_mid",
    "tail_tip",
    "fin",
    "wing",
    "other",
]);

export const RigBoneSideSchema = z.enum(["left", "right", "center"]);
export const RigBoneContactRoleSchema = z.enum(["none", "ground", "wall", "water", "grip"]);
export const RigBoneMassClassSchema = z.enum(["light", "medium", "heavy"]);
export const RigBoneIKRoleSchema = z.enum(["root", "joint", "effector", "decorative"]);

export const RigBoneSchema = z.object({
    id: z.string().describe("The exact ID of the <g> tag in the SVG that this bone controls (e.g., 'side_leg_right')."),
    pivot: PivotPointSchema.optional().describe("The point this bone rotates around."),
    rotationLimit: z.array(z.number()).length(2).optional().describe("Min and max rotation bounds in degrees, e.g., [-45, 90]."),
    parent: z.string().optional().describe("The ID of the parent bone, for hierarchy."),
    kind: RigBoneKindSchema.optional().describe("Semantic role of the bone for deterministic motion synthesis and IK."),
    side: RigBoneSideSchema.optional().describe("Lateral side of the bone where relevant."),
    length: z.number().positive().optional().describe("Approximate bone or segment length in SVG units."),
    socket: PivotPointSchema.optional().describe("Preferred parent attachment point in SVG coordinates."),
    contactRole: RigBoneContactRoleSchema.optional().describe("Preferred contact medium for this bone when solving motion."),
    massClass: RigBoneMassClassSchema.optional().describe("Relative inertia class used by deterministic motion synthesis."),
    restRotation: z.number().optional().describe("Local rest rotation in degrees relative to the parent canonical rig."),
    ikRole: RigBoneIKRoleSchema.optional().describe("Optional legacy hint describing whether this bone acts as a root, joint, effector, or decorative node."),
});

export const RigIKArchetypeSchema = z.enum(["biped", "quadruped", "fish", "bird", "serpent", "prop", "custom"]);
export const RigIKEffectorRoleSchema = z.enum(["head", "hand", "foot", "tail_tip", "fin_tip", "wing_tip", "custom"]);

export const RigIKNodeSchema = z.object({
    id: z.string().describe("Canonical, view-independent node ID used by the runtime pose graph."),
    parent: z.string().optional().describe("Canonical parent node ID."),
    kind: RigBoneKindSchema.optional().describe("Semantic node kind carried over from the draft rig."),
    side: RigBoneSideSchema.optional().describe("Lateral side of the canonical node."),
    ikRole: RigBoneIKRoleSchema.optional().describe("How the node behaves in the solver graph."),
    restLength: z.number().nonnegative().optional().describe("Rest-space distance to the parent node."),
    restRotation: z.number().optional().describe("Rest-space local rotation in degrees."),
    rotationLimit: z.array(z.number()).length(2).optional().describe("Local angular clamp in degrees."),
    preferredBend: z.number().optional().describe("Preferred local bend angle in degrees used to avoid solver flips."),
    contactRole: RigBoneContactRoleSchema.optional().describe("Preferred contact behavior for this node."),
    massClass: RigBoneMassClassSchema.optional().describe("Relative inertia class for physics/ragdoll passes."),
    sourceBoneIds: z.array(z.string()).optional().describe("Legacy per-view bone IDs that map into this canonical node."),
});

export const RigIKConstraintSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("length"),
        nodeId: z.string(),
        value: z.number().nonnegative(),
        stiffness: z.number().min(0).max(1).default(1),
    }),
    z.object({
        type: z.literal("angle_limit"),
        nodeId: z.string(),
        min: z.number(),
        max: z.number(),
        preferred: z.number().optional(),
    }),
    z.object({
        type: z.literal("pin"),
        nodeId: z.string(),
        enabled: z.boolean().default(true),
        x: z.number(),
        y: z.number(),
        stiffness: z.number().min(0).max(1).default(1),
    }),
    z.object({
        type: z.literal("contact"),
        nodeId: z.string(),
        medium: z.enum(["ground", "wall", "water"]),
        enabled: z.boolean().default(false),
    }),
]);

export const RigIKEffectorSchema = z.object({
    nodeId: z.string(),
    role: RigIKEffectorRoleSchema,
    draggable: z.boolean().default(true),
});

export const RigIKChainSchema = z.object({
    id: z.string(),
    nodeIds: z.array(z.string()).min(2),
    effectorId: z.string(),
    priority: z.number().default(0),
});

export const RigIKViewBindingSchema = z.object({
    nodeId: z.string().describe("Canonical node ID rendered by this binding."),
    boneId: z.string().describe("Legacy SVG group ID used to render the node in this view."),
    pivot: PivotPointSchema.optional().describe("View-specific rest pivot for this binding."),
    socket: PivotPointSchema.optional().describe("View-specific parent attachment point for this binding."),
});

export const RigIKViewSchema = z.object({
    bindings: z.array(RigIKViewBindingSchema).default([]),
});

export const RigIKAIReportSchema = z.object({
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()).default([]),
    suggestedFixes: z.array(z.string()).default([]),
});

export const RigIKSchema = z.object({
    version: z.literal(1).default(1),
    archetype: RigIKArchetypeSchema.default("custom"),
    defaultView: z.string().optional(),
    roots: z.array(z.string()).default([]),
    nodes: z.array(RigIKNodeSchema).default([]),
    chains: z.array(RigIKChainSchema).default([]),
    constraints: z.array(RigIKConstraintSchema).default([]),
    effectors: z.array(RigIKEffectorSchema).default([]),
    views: z.record(z.string(), RigIKViewSchema).default({}),
    aiReport: RigIKAIReportSchema.optional(),
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

export const RigMotionIntentRootSampleSchema = z.object({
    t: z.number().min(0).max(1).describe("Normalized clip time for this root-motion sample."),
    x: z.number().optional().describe("Optional root X offset at this sample."),
    y: z.number().optional().describe("Optional root Y offset at this sample."),
    rotation: z.number().optional().describe("Optional root local rotation at this sample."),
});

export const RigMotionIntentEffectorSampleSchema = z.object({
    t: z.number().min(0).max(1).describe("Normalized clip time for this effector sample."),
    x: z.number().describe("Goal X position for the effector sample."),
    y: z.number().describe("Goal Y position for the effector sample."),
    weight: z.number().min(0).max(1).optional().describe("Optional solver weight for the sample."),
});

export const RigMotionIntentEffectorGoalSchema = z.object({
    nodeId: z.string().describe("Canonical IK node driven by this effector goal."),
    role: z.string().optional().describe("Optional semantic role for the effector goal."),
    space: z.enum(["world", "local"]).default("world").describe("Coordinate space used by the effector samples."),
    samples: z.array(RigMotionIntentEffectorSampleSchema).default([]).describe("Time-sampled positions for the effector goal."),
});

export const RigMotionIntentRotationSampleSchema = z.object({
    t: z.number().min(0).max(1).describe("Normalized clip time for this local rotation sample."),
    rotation: z.number().describe("Local node rotation in degrees at this sample."),
});

export const RigMotionIntentRotationTrackSchema = z.object({
    nodeId: z.string().describe("Canonical IK node driven by this local rotation track."),
    samples: z.array(RigMotionIntentRotationSampleSchema).default([]).describe("Time-sampled local rotations for the node."),
});

export const RigMotionIntentAxialWaveSchema = z.object({
    chainId: z.string().optional().describe("Optional canonical chain identifier for this wave."),
    nodeIds: z.array(z.string()).default([]).describe("Ordered canonical node IDs that this wave affects."),
    amplitudeDeg: z.number().describe("Peak local rotation magnitude in degrees."),
    frequency: z.number().positive().default(1).describe("Cycles per clip."),
    phase: z.number().default(0).describe("Phase offset in cycles."),
    falloff: z.enum(["uniform", "tip_bias", "root_bias"]).default("uniform").describe("How the wave amplitude is distributed along the node list."),
});

export const RigMotionIntentContactSchema = z.object({
    nodeId: z.string().describe("Canonical node that should maintain this contact."),
    target: z.enum(["ground", "wall", "water"]).describe("Contact medium for the node."),
    t0: z.number().min(0).max(1).describe("Normalized start time for the contact window."),
    t1: z.number().min(0).max(1).describe("Normalized end time for the contact window."),
});

export const RigMotionIntentPinSchema = z.object({
    nodeId: z.string().describe("Canonical node pinned during this interval."),
    x: z.number().describe("World X coordinate for the pin."),
    y: z.number().describe("World Y coordinate for the pin."),
    t0: z.number().min(0).max(1).describe("Normalized start time for the pin window."),
    t1: z.number().min(0).max(1).describe("Normalized end time for the pin window."),
});

export const RigMotionIntentSchema = z.object({
    family: MotionFamilySchema.describe("High-level motion family solved through the canonical rig."),
    duration: z.number().positive().describe("Clip duration in seconds."),
    locomotion: z.object({
        mode: MotionLocomotionModeSchema.default("none"),
        direction: MotionDirectionSchema.optional(),
    }).default({ mode: "none" }).describe("Root locomotion intent for the clip."),
    rootMotion: z.array(RigMotionIntentRootSampleSchema).default([]).describe("Optional normalized root-motion samples."),
    effectorGoals: z.array(RigMotionIntentEffectorGoalSchema).default([]).describe("Solver-native effector goals for this motion."),
    rotationTracks: z.array(RigMotionIntentRotationTrackSchema).default([]).describe("Optional sampled local rotations captured from compiled bone animation."),
    axialWaves: z.array(RigMotionIntentAxialWaveSchema).default([]).describe("Procedural axial motion applied before constraint solving."),
    contacts: z.array(RigMotionIntentContactSchema).default([]).describe("Contact windows used by the solver."),
    pins: z.array(RigMotionIntentPinSchema).default([]).describe("Temporary pins applied during the motion."),
    leadNodes: z.array(z.string()).default([]).describe("Canonical nodes that lead the motion."),
    notes: z.string().optional().describe("Optional human-readable summary of the intent."),
});

export const RigMotionDisplayKeyframeSchema = z.object({
    boneId: z.string().describe("View-specific SVG group ID affected by this display-only keyframe."),
    prop: z.literal("opacity").describe("Display-only property supported by canonical playback."),
    from: z.number().optional().describe("Optional starting display value."),
    to: z.number().describe("Target display value."),
    duration: z.number().describe("Duration of one cycle in seconds."),
    delay: z.number().optional().default(0).describe("Delay before this display keyframe starts."),
    yoyo: z.boolean().optional().default(false).describe("Whether this display keyframe reverses after reaching the target."),
    repeat: z.number().optional().default(0).describe("How many times this display keyframe repeats."),
    ease: z.string().optional().default("sine.inOut").describe("GSAP ease used for playback."),
});

export const RigMotionClipSchema = z.object({
    view: z.string().optional().describe("Preferred rig view for this reusable canonical motion clip."),
    intent: RigMotionIntentSchema.describe("Solver-native motion intent evaluated into goals at runtime."),
    displayKeyframes: z.array(RigMotionDisplayKeyframeSchema).default([]).describe("Display-only keyframes such as opacity."),
});

export const RigRepairReportSchema = z.object({
    version: z.number().default(1).describe("Deterministic rig repair algorithm version."),
    repaired: z.boolean().default(false).describe("Whether the automatic repair pass changed the generated rig."),
    fixes: z.array(z.string()).default([]).describe("Human-readable descriptions of automatic fixes that were applied."),
    warnings: z.array(z.string()).default([]).describe("Warnings that still require review after deterministic repair."),
    confidence: z.number().min(0).max(1).default(1).describe("Confidence score for the repaired rig output."),
});

export const RigSchema = z.object({
    bones: z.array(RigBoneSchema),
    interactionNulls: z.array(z.string()),
    visemes: z.array(z.string()).optional(),
    emotions: z.array(z.string()).optional(),
    ik: RigIKSchema.optional()
        .describe("Canonical view-independent IK graph used by the rig lab, runtime solver, and motion compiler."),
    animation_clips: z.record(z.string(), AnimationClipSchema).optional()
        .describe("Legacy GSAP keyframe clips generated by the Draftsman. Kept for backwards compatibility."),
    motion_clips: z.record(z.string(), RigMotionClipSchema).optional()
        .describe("Reusable canonical motion clips compiled onto IK nodes and display bindings."),
    repair_report: RigRepairReportSchema.optional()
        .describe("Optional deterministic repair metadata for this rig."),
});

export const DraftsmanSchema = z.object({
    svg_data: z.string().describe("The raw SVG string. Must use viewBox='0 0 1000 1000'."),
    rig_data: RigSchema,
});

export type RigData = z.infer<typeof RigSchema>;
export type DraftsmanData = z.infer<typeof DraftsmanSchema>;
export type RigBone = z.infer<typeof RigBoneSchema>;
export type AnimationKeyframe = z.infer<typeof AnimationKeyframeSchema>;
export type AnimationClip = z.infer<typeof AnimationClipSchema>;
export type RigMotionIntentRootSample = z.infer<typeof RigMotionIntentRootSampleSchema>;
export type RigMotionIntentEffectorSample = z.infer<typeof RigMotionIntentEffectorSampleSchema>;
export type RigMotionIntentEffectorGoal = z.infer<typeof RigMotionIntentEffectorGoalSchema>;
export type RigMotionIntentAxialWave = z.infer<typeof RigMotionIntentAxialWaveSchema>;
export type RigMotionIntentContact = z.infer<typeof RigMotionIntentContactSchema>;
export type RigMotionIntentPin = z.infer<typeof RigMotionIntentPinSchema>;
export type RigMotionIntent = z.infer<typeof RigMotionIntentSchema>;
export type RigMotionDisplayKeyframe = z.infer<typeof RigMotionDisplayKeyframeSchema>;
export type RigMotionClip = z.infer<typeof RigMotionClipSchema>;
export type RigRepairReport = z.infer<typeof RigRepairReportSchema>;
export type RigBoneKind = z.infer<typeof RigBoneKindSchema>;
export type RigBoneSide = z.infer<typeof RigBoneSideSchema>;
export type RigBoneContactRole = z.infer<typeof RigBoneContactRoleSchema>;
export type RigBoneMassClass = z.infer<typeof RigBoneMassClassSchema>;
export type RigBoneIKRole = z.infer<typeof RigBoneIKRoleSchema>;
export type RigIKData = z.infer<typeof RigIKSchema>;
export type RigIKNode = z.infer<typeof RigIKNodeSchema>;
export type RigIKConstraint = z.infer<typeof RigIKConstraintSchema>;
export type RigIKChain = z.infer<typeof RigIKChainSchema>;
export type RigIKEffector = z.infer<typeof RigIKEffectorSchema>;
export type RigIKEffectorRole = z.infer<typeof RigIKEffectorRoleSchema>;
export type RigIKView = z.infer<typeof RigIKViewSchema>;
export type RigIKViewBinding = z.infer<typeof RigIKViewBindingSchema>;
export type RigIKArchetype = z.infer<typeof RigIKArchetypeSchema>;
