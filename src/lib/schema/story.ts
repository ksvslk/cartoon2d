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

export const AnimationOverridesSchema = z.object({
    amplitude: z.number().optional().describe("How large the motion is (1.0 = normal, 2.0 = double, 0.5 = half)."),
    speed: z.number().optional().describe("Animation speed multiplier (1.0 = normal, 2.0 = double speed, 0.5 = half speed)."),
    delay: z.number().optional().describe("Seconds to wait before this action's animation starts."),
});

export const SpatialTransformSchema = z.object({
    x: z.number().default(960).describe("The X center coordinate on the 1920x1080 stage."),
    y: z.number().default(950).describe("The Y floor contact coordinate on the 1920x1080 stage."),
    scale: z.number().default(1.0).describe("The actor scale."),
    z_index: z.number().default(10).describe("The scene layer order. Higher values render in front.")
});

export const TransformKeyframeSchema = SpatialTransformSchema.extend({
    time: z.number().describe("Timeline time in seconds for this transform keyframe."),
});

export const ClipBindingSchema = z.object({
    id: z.string().describe("Unique binding id inside the scene timeline."),
    actor_id: z.string().describe("The actor bound to this clip."),
    source_action_index: z.number().describe("Original semantic action index that produced this binding."),
    motion: z.string().describe("Original semantic motion name."),
    style: z.string().optional().describe("Original style modifier."),
    clip_id: z.string().describe("Resolved reusable clip id on the actor rig."),
    view: z.string().optional().describe("The rig view used by this clip."),
    start_time: z.number().describe("Timeline start time in seconds."),
    duration_seconds: z.number().describe("Binding duration in seconds."),
    amplitude: z.number().optional().describe("Resolved amplitude multiplier."),
    speed: z.number().optional().describe("Resolved speed multiplier."),
    start_transform: SpatialTransformSchema.describe("Transform at clip start."),
    end_transform: SpatialTransformSchema.optional().describe("Transform at clip end, if the clip moves through space."),
});

export const SceneInstanceTrackSchema = z.object({
    actor_id: z.string().describe("The actor represented by this scene track."),
    clip_bindings: z.array(ClipBindingSchema).describe("Playable reusable clip instances bound onto this actor for the scene."),
    transform_track: z.array(TransformKeyframeSchema).describe("Explicit transform keyframes baked for this actor in scene time."),
});

export const CompiledSceneSchema = z.object({
    duration_seconds: z.number().describe("Total compiled duration of the scene timeline."),
    instance_tracks: z.array(SceneInstanceTrackSchema).describe("Explicit per-actor scene timeline tracks."),
});

export const CompileReportSchema = z.object({
    status: z.enum(["success", "error"]).describe("Whether the last compile pipeline run completed successfully."),
    compiled_at: z.number().describe("Epoch milliseconds when the compile pipeline last completed."),
    logs: z.array(z.string()).describe("Persisted compile console lines for this scene."),
    api_calls: z.number().default(0).describe("Number of model/API calls used while compiling this scene."),
    total_tokens: z.number().default(0).describe("Total model tokens consumed while compiling this scene."),
    scene_cost_estimate: z.number().default(0).describe("Estimated USD cost for the compile pipeline."),
    image_generation_cost: z.object({
        cost: z.number(),
        tokens: z.number(),
    }).optional().describe("Optional image generation usage shown under the storyboard image."),
});

export const ActionSchema = z.object({
    actor_id: z.string().describe("The ID of the actor performing the action."),
    motion: z.string().describe("A semantic action verb, e.g., 'walk', 'idle', 'run', 'tip_hat'"),
    style: z.string().describe("An adverb or modifier describing how the action is performed, e.g., 'casual', 'panic', 'polite'"),
    duration_seconds: z.number().describe("The estimated duration of this specific action clip."),
    spatial_transform: SpatialTransformSchema.optional(),
    target_spatial_transform: SpatialTransformSchema.pick({
        x: true,
        y: true,
        scale: true,
    }).optional(),
    animation_overrides: AnimationOverridesSchema.optional().describe("Optional explicit overrides for animation parameters. Takes priority over style-inferred values."),
});

export const StoryBeatSchema = z.object({
    scene_number: z.number().describe("Sequential index of the scene."),
    narrative: z.string().describe("A human-readable summary of what happens in this scene."),
    camera: CameraSchema,
    audio: z.array(AudioSchema).describe("Expected audio cues to play during this beat."),
    actions: z.array(ActionSchema).describe("Semantic motions that actors perform during this beat."),
    comic_panel_prompt: z.string().describe("A highly optimized text prompt suitable for an Image Generation model to draw a static comic panel of this specific beat."),
    image_data: z.string().optional().describe("Base64 data URL of the generated comic panel image."),
    drafted_background: DraftsmanSchema.optional().describe("The generated structured SVG background specific to this scene panel."),
    compiled_scene: CompiledSceneSchema.optional().describe("Persisted compiled scene graph used for playback, editing, and timeline rendering."),
    compile_report: CompileReportSchema.optional().describe("Persisted compile console and metrics for this scene.")
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
export type AnimationOverrides = z.infer<typeof AnimationOverridesSchema>;
export type SpatialTransform = z.infer<typeof SpatialTransformSchema>;
export type TransformKeyframe = z.infer<typeof TransformKeyframeSchema>;
export type ClipBinding = z.infer<typeof ClipBindingSchema>;
export type SceneInstanceTrack = z.infer<typeof SceneInstanceTrackSchema>;
export type CompiledSceneData = z.infer<typeof CompiledSceneSchema>;
export type CompileReportData = z.infer<typeof CompileReportSchema>;
