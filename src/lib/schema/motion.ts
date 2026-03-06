import { z } from "zod";

// A specific semantic action Gemini can command
export const MotionActionSchema = z.object({
    action: z.enum([
        "idle",
        "walk",
        "run",
        "jump",
        "sit",
        "reach",
        "lean",
        "look",
        "speak"
    ]),
    // Target coordinates or object ID the actor is interacting with
    target: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]).optional(),
    // Speed multiplier
    speed: z.number().min(0.1).max(5).default(1.0),
    // Intensity or emotional flavor
    intensity: z.number().min(0).max(1).default(0.5),
    // Duration in seconds (if not inferred by animation length)
    duration: z.number().optional()
});

export type MotionAction = z.infer<typeof MotionActionSchema>;
