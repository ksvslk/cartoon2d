import { z } from "zod";
import { DraftsmanSchema } from "./rig";

export const ActorSchema = z.object({
    id: z.string().describe("A unique identifier for this actor, e.g., 'actor-john'"),
    name: z.string().describe("The character's name, e.g., 'John'"),
    species: z.string().describe("The base species or type, e.g., 'cat', 'dog', 'human'"),
    attributes: z.array(z.string()).describe("Specific visual traits, e.g., ['blue hat', 'orange tabby']"),
    personality: z.string().optional().default("neutral").describe("The core personality or demeanor of the character, e.g., 'grumpy and sarcastic', 'hyperactive and joyful'"),
    visual_description: z.string().describe("A concise paragraph summarizing the actor's visual appearance for an image prompt."),
    drafted_rig: DraftsmanSchema.optional().describe("The generated SVG and Animation JSON Rig data mapped to this character.")
});

export const AudioSchema = z.object({
    type: z.enum(["sfx", "dialogue", "music"]),
    actor_id: z.string().optional().describe("If type is dialogue, the ID of the speaking actor."),
    text: z.string().optional().describe("If type is dialogue, the exact words spoken."),
    description: z.string().optional().describe("If type is sfx or music, a description of the sound (e.g., 'birds chirping in park')")
});

export const CameraSchema = z.object({
    zoom: z.number().default(1.0).describe("Camera zoom level. 1.0 is default, >1.0 is zooming in."),
    pan: z.enum(["static", "pan_right", "pan_left", "pan_up", "pan_down", "tracking"]).default("static")
});

export const ActionSchema = z.object({
    actor_id: z.string().describe("The ID of the actor performing the action."),
    motion: z.string().describe("A semantic action verb, e.g., 'walk', 'idle', 'run', 'tip_hat'"),
    style: z.string().describe("An adverb or modifier describing how the action is performed, e.g., 'casual', 'panic', 'polite'"),
    duration_seconds: z.number().describe("The estimated duration of this specific action clip."),
    spatial_transform: z.object({
        x: z.number().default(500).describe("The starting X center coordinate on the 1000x1000 stage. E.g. 500 is center, 200 is left."),
        y: z.number().default(800).describe("The starting Y center coordinate on the 1000x1000 stage. Usually around 700-900 to be on the floor."),
        scale: z.number().default(1.0).describe("The scale of the actor. 1.0 is default size. Use smaller values if they are far away.")
    }).optional()
});

export const StoryBeatSchema = z.object({
    scene_number: z.number().describe("Sequential index of the scene."),
    narrative: z.string().describe("A human-readable summary of what happens in this scene."),
    camera: CameraSchema,
    audio: z.array(AudioSchema).describe("Expected audio cues to play during this beat."),
    actions: z.array(ActionSchema).describe("Semantic motions that actors perform during this beat."),
    comic_panel_prompt: z.string().describe("A highly optimized text prompt suitable for an Image Generation model to draw a static comic panel of this specific beat."),
    image_data: z.string().optional().describe("Base64 data URL of the generated comic panel image."),
    drafted_background: DraftsmanSchema.optional().describe("The generated structured SVG background specific to this scene panel.")
});

export const StoryGenerationSchema = z.object({
    title: z.string().describe("A generated title for the entire sequence."),
    actors_detected: z.array(ActorSchema).describe("A roster of all unique characters identified in the prompt."),
    beats: z.array(StoryBeatSchema).describe("The sequence of animated scenes/beats.")
});

export const StorySceneSchema = StoryGenerationSchema.extend({
    id: z.string()
});

export type StoryGenerationData = z.infer<typeof StoryGenerationSchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type StoryBeatData = z.infer<typeof StoryBeatSchema>;
export type ActorData = z.infer<typeof ActorSchema>;
