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
});

export type MotionFamily = z.infer<typeof MotionFamilySchema>;
export type MotionSpec = z.infer<typeof MotionSpecSchema>;
