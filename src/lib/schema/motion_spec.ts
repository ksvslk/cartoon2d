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

export const RigMotionIntentAxialWaveSchema = z.object({
    chainId: z.string().optional().describe("Optional canonical chain identifier for this wave."),
    nodeIds: z.array(z.string()).default([]).describe("Ordered canonical node IDs that this wave affects."),
    amplitudeDeg: z.number().describe("Peak local rotation magnitude in degrees."),
    frequency: z.number().positive().default(1).describe("Cycles per clip."),
    phase: z.number().default(0).describe("Phase offset in cycles."),
    falloff: z.enum(["uniform", "tip_bias", "root_bias"]).default("uniform").describe("How the wave amplitude is distributed along the node list."),
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
    axialWaves: z.array(RigMotionIntentAxialWaveSchema).optional(),
});

export type MotionFamily = z.infer<typeof MotionFamilySchema>;
export type MotionSpec = z.infer<typeof MotionSpecSchema>;
export type RigMotionIntentRootSample = z.infer<typeof RigMotionIntentRootSampleSchema>;
export type RigMotionIntentAxialWave = z.infer<typeof RigMotionIntentAxialWaveSchema>;
