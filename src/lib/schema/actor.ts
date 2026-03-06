import { z } from "zod";

// Defines the structure of a rigid part of the SVG actor
export const ActorJointSchema = z.object({
    id: z.string(),
    // The center of rotation (x, y) relative to the actor space
    pivot: z.object({ x: z.number(), y: z.number() }),
    // Hierarchical parent (for FK/IK chain)
    parent: z.string().optional(),
    // Structural limits mapping to animation constraints
    rotationLimit: z.object({ min: z.number(), max: z.number() }).optional(),
});

// A saved Actor that can be re-used in multiple story scenes
export const ActorSchema = z.object({
    id: z.string(),
    name: z.string(),
    // The raw SVG string
    svgData: z.string(),
    // Semantic layout of how the parts connect
    joints: z.array(ActorJointSchema),
    // Additional styling or color rules
    styleRules: z.record(z.string(), z.any()).optional(),
});

export type ActorJoint = z.infer<typeof ActorJointSchema>;
export type Actor = z.infer<typeof ActorSchema>;
