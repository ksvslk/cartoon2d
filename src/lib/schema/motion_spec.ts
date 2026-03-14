import { z } from "zod";

export const MotionFamilySchema = z.string().trim().min(1).max(64).default("custom");

export const MotionLocomotionModeSchema = z.enum([
    "none",
    "translate",
    "arc",
    "stop_at_contact",
    "slide_on_contact",
    "bounce_on_contact",
]);

export const MotionDirectionSchema = z.enum(["left", "right", "up", "down", "forward", "backward"]);

export const MotionContactTargetSchema = z.enum(["ground", "wall", "water", "none"]);

export const MotionContactHintSchema = z.object({
    boneId: z.string(),
    target: MotionContactTargetSchema,
    phaseStart: z.number().min(0).max(1),
    phaseEnd: z.number().min(0).max(1),
});

export const RigMotionIntentRootSampleSchema = z.object({
    t: z.number().min(0).max(1).describe("Normalized clip time for this root-motion sample."),
    x: z.number().optional().describe("Optional root X offset at this sample."),
    y: z.number().optional().describe("Optional root Y offset at this sample."),
    rotation: z.number().optional().describe("Optional root local rotation at this sample."),
});

export const WholeObjectMotionPhaseSchema = z.string().describe("Optional semantic phase label for this anchor.");

export const WholeObjectMotionAnchorSchema = z.object({
    t: z.number().min(0).max(1).describe("Normalized clip time for this whole-object anchor."),
    label: WholeObjectMotionPhaseSchema.optional().describe("Optional semantic phase label for this anchor."),
    x: z.number().optional().describe("Optional whole-object local X offset at this anchor."),
    y: z.number().optional().describe("Optional whole-object local Y offset at this anchor."),
    rotation: z.number().optional().describe("Optional whole-object local rotation offset at this anchor."),
    scale: z.number().positive().optional().describe("Optional relative whole-object scale multiplier at this anchor, where 1 is neutral."),
});

export const WholeObjectMotionRecipeSchema = z.object({
    anchors: z.array(WholeObjectMotionAnchorSchema).min(2).describe("Ordered whole-object motion anchors used for transform-only playback."),
});

export const RigMotionIntentAxialWaveSchema = z.object({
    chainId: z.string().optional().describe("Optional canonical chain identifier for this wave."),
    nodeIds: z.array(z.string()).default([]).describe("Ordered canonical node IDs that this wave affects."),
    amplitudeDeg: z.number().describe("Peak local rotation magnitude in degrees."),
    frequency: z.number().positive().default(1).describe("Cycles per clip."),
    phase: z.number().default(0).describe("Phase offset in cycles."),
    falloff: z.enum(["uniform", "tip_bias", "root_bias"]).default("uniform").describe("How the wave amplitude is distributed along the node list."),
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

export const MotionSpecSchema = z.object({
    motionFamily: MotionFamilySchema,
    tempo: z.number().positive().default(1),
    amplitude: z.number().positive().default(1),
    intensity: z.number().min(0).max(1).default(0.5),
    preferredView: z.string().optional(),
    locomotion: z.object({
        mode: MotionLocomotionModeSchema.default("none"),
        preferredDirection: MotionDirectionSchema.optional(),
    }).default({ mode: "none" }),
    contacts: z.array(MotionContactHintSchema).default([]),
    leadBones: z.array(z.string()).default([]),
    blockedReasons: z.array(z.string()).default([]),
    notes: z.string().optional(),
    rootMotion: z.array(RigMotionIntentRootSampleSchema).optional(),
    wholeObjectMotion: WholeObjectMotionRecipeSchema.optional(),
    axialWaves: z.array(RigMotionIntentAxialWaveSchema).optional(),
    rotationTracks: z.array(RigMotionIntentRotationTrackSchema).optional(),
    effectorGoals: z.array(RigMotionIntentEffectorGoalSchema).optional(),
});

export type MotionFamily = z.infer<typeof MotionFamilySchema>;
export type MotionSpec = z.infer<typeof MotionSpecSchema>;
export type RigMotionIntentRootSample = z.infer<typeof RigMotionIntentRootSampleSchema>;
export type WholeObjectMotionPhase = z.infer<typeof WholeObjectMotionPhaseSchema>;
export type WholeObjectMotionAnchor = z.infer<typeof WholeObjectMotionAnchorSchema>;
export type WholeObjectMotionRecipe = z.infer<typeof WholeObjectMotionRecipeSchema>;
export type RigMotionIntentAxialWave = z.infer<typeof RigMotionIntentAxialWaveSchema>;
export type RigMotionIntentRotationTrack = z.infer<typeof RigMotionIntentRotationTrackSchema>;
export type RigMotionIntentEffectorGoal = z.infer<typeof RigMotionIntentEffectorGoalSchema>;
