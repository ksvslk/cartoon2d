import { z } from "zod";
import { MotionActionSchema } from "./motion";

// Defines a single frame or moment in the comic scene
export const StoryBeatSchema = z.object({
    id: z.string(),
    // The narrative description or dialog text shown to the user on the comic view
    narrativeText: z.string(),
    // The visual description for rendering the panel image
    panelDescription: z.string(),
    // The audio/narration cues or dialog to be played
    audioCues: z.array(z.string()).optional(),

    // The semantic actions that this beat maps to for the animation layer
    actions: z.array(z.object({
        actorId: z.string(),
        motion: MotionActionSchema
    })).optional()
});

// A complete scene composed of ordered beats
export const StorySceneSchema = z.object({
    id: z.string(),
    title: z.string(),
    beats: z.array(StoryBeatSchema),
    // Environmental context like time of day or background image
    environment: z.string().optional()
});

export type StoryBeat = z.infer<typeof StoryBeatSchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
