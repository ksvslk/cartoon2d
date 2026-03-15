import { z } from "zod";
import { DraftsmanSchema, RigMotionIntentSchema } from "./rig";
import { MotionSpecSchema, RigMotionIntentRootSampleSchema } from "./motion_spec";

export type StageOrientation = "landscape" | "portrait";

export const STAGE_DIMENSIONS = {
  landscape: { width: 1920, height: 1080 },
  portrait:  { width: 1080, height: 1920 },
} as const;

export function getStageDims(orientation: StageOrientation) {
  return STAGE_DIMENSIONS[orientation];
}

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
    actor_id: z.string().optional().describe("Required if type is dialogue, MUST exactly match the ID of the speaking actor from actors_detected."),
    text: z.string().optional().describe("If type is dialogue, the exact words spoken."),
    description: z.string().optional().describe("If type is sfx or music, a description of the sound (e.g., 'birds chirping in park')"),
    delivery_style: z.string().optional().describe("If type is dialogue, the emotional delivery or acting style (e.g. 'shouting angrily', 'whispering softly', 'cheerful')."),
    voice_id: z.string().optional().describe("Google Cloud TTS voice name, e.g. 'en-US-Standard-F'. Falls back to project default if not set."),
    start_time: z.number().default(0).describe("Timeline start time in seconds for this audio cue."),
    duration_seconds: z.number().optional().describe("Duration of the generated audio in seconds."),
    // The following fields are populated by the TTS generator, not the initial AI director
    audio_data_url: z.string().optional().describe("Base64 string of the generated audio."),
    visemes: z.array(z.object({
        viseme: z.string(), // e.g. "A", "E", "I", "O", "U", "M", "idle"
        time: z.number(),   // Start time in seconds relative to the clip
        duration: z.number(), // Duration in seconds
    })).optional().describe("Timing data for mouth shapes."),
    generation_cost: z.object({
        cost: z.number(),
        characters: z.number()
    }).optional().describe("Cloud TTS generation cost tracking.")
});
export const CameraSchema = z.object({
    start_time: z.number().default(0).describe("Timeline start time in seconds for this camera move/cut."),
    zoom: z.number().default(1.0).describe("Camera zoom level. 1.0 is default, >1.0 is zooming in."),
    x: z.number().default(960).describe("Camera focal point X in stage coordinates. Default 960 (center)."),
    y: z.number().default(540).describe("Camera focal point Y in stage coordinates. Default 540 (center)."),
    rotation: z.number().default(0).describe("Camera rotation in degrees."),
    duration: z.number().optional().describe("Camera layer duration in seconds. If not set, defaults to playing until the next camera cut or scene end."),
    target_actor_id: z.string().optional().describe("If provided, the camera will track this actor's movement over the course of the scene."),
    target_x: z.number().optional().describe("If provided, the camera will pan to this X coordinate by the end of the scene."),
    target_y: z.number().optional().describe("If provided, the camera will pan to this Y coordinate by the end of the scene."),
    target_zoom: z.number().optional().describe("If provided, the camera will smoothly zoom to this level by the end of the scene.")
});

export const AnimationOverridesSchema = z.object({
    amplitude: z.number().optional().describe("How large the motion is (1.0 = normal, 2.0 = double, 0.5 = half)."),
    speed: z.number().optional().describe("Animation speed multiplier (1.0 = normal, 2.0 = double speed, 0.5 = half speed)."),
    delay: z.number().optional().describe("Seconds to wait before this action's animation starts."),
    collision_behavior: z.enum(["halt", "slide", "bounce"]).optional().describe("How the motion should respond if it collides with a scene obstacle."),
});

export const SpatialTransformSchema = z.object({
    x: z.number().default(960).describe("The X center coordinate on the 1920x1080 stage."),
    y: z.number().default(950).describe("The Y floor contact coordinate on the 1920x1080 stage."),
    scale: z.number().default(1.0).describe("The actor scale."),
    rotation: z.number().optional().describe("Optional whole-object rotation in degrees."),
    flip_x: z.boolean().optional().describe("Whether to explicitly flip the actor horizontally."),
    flip_y: z.boolean().optional().describe("Whether to explicitly flip the actor vertically."),
    z_index: z.number().default(10).describe("The scene layer order. Higher values render in front.")
});

export const TransformKeyframeSchema = SpatialTransformSchema.extend({
    time: z.number().describe("Timeline time in seconds for this transform keyframe."),
});

export const ClipBindingIKPlaybackSchema = z.object({
    source_clip_id: z.string().describe("Original reusable rig clip ID that produced this compiled IK playback block."),
    view: z.string().optional().describe("Preferred view to display while this IK playback block is active."),
    motion_spec: MotionSpecSchema.optional().describe("Optional semantic summary associated with this playback block."),
    motion_intent: RigMotionIntentSchema.describe("Solver-native motion intent used by runtime playback."),
    sampled_root_motion: z.array(RigMotionIntentRootSampleSchema).default([]).describe("Optional cached root-motion samples for the binding."),
});

export const ClipBindingSchema = z.object({
    id: z.string().describe("Unique binding id inside the scene timeline."),
    actor_id: z.string().describe("The actor bound to this clip."),
    source_action_index: z.number().describe("Original semantic action index that produced this binding."),
    motion: z.string().describe("Original semantic motion name."),
    style: z.string().optional().describe("Original style modifier."),
    clip_id: z.string().describe("Resolved reusable clip id on the actor rig, or 'base_object' for transform-only fallback."),
    view: z.string().optional().describe("The rig view used by this clip."),
    start_time: z.number().describe("Timeline start time in seconds."),
    duration_seconds: z.number().describe("Binding duration in seconds."),
    amplitude: z.number().optional().describe("Resolved amplitude multiplier."),
    speed: z.number().optional().describe("Resolved speed multiplier."),
    collision_behavior: z.enum(["halt", "slide", "bounce"]).optional().describe("Resolved collision behavior for this clip binding."),
    start_transform: SpatialTransformSchema.describe("Transform at clip start."),
    end_transform: SpatialTransformSchema.optional().describe("Transform at clip end, if the clip moves through space."),
    collision: z.object({
        obstacle_id: z.string().describe("Obstacle id that constrained this binding."),
        stop_x: z.number().describe("Resolved X position where the actor was clamped or stopped."),
        stop_y: z.number().optional().describe("Resolved Y position where the actor was clamped or stopped."),
        stop_time: z.number().optional().describe("Timeline time in seconds when the collision stop occurred."),
    }).optional().describe("Optional collision result baked into this binding."),
    ik_playback: ClipBindingIKPlaybackSchema.optional().describe("Optional canonical IK playback data compiled from the reusable rig clip."),
});

export const SceneInstanceTrackSchema = z.object({
    actor_id: z.string().describe("The actor represented by this scene track."),
    clip_bindings: z.array(ClipBindingSchema).describe("Playable reusable clip instances bound onto this actor for the scene."),
    transform_track: z.array(TransformKeyframeSchema).describe("Explicit transform keyframes baked for this actor in scene time."),
});

export const BackgroundAmbientBindingSchema = z.object({
    id: z.string().describe("Unique background animation binding id inside the scene timeline."),
    target_id: z.string().describe("SVG element id inside the background that should animate."),
    label: z.enum(["flicker", "rise", "ripple", "sway", "wave", "drift", "pulse"]).describe("Ambient animation label applied to the background target."),
    start_time: z.number().describe("Timeline start time in seconds."),
    duration_seconds: z.number().describe("Binding duration in seconds."),
});

export const SceneObstacleSchema = z.object({
    id: z.string().describe("Unique obstacle id inside the scene."),
    x: z.number().describe("Obstacle min X in stage coordinates."),
    y: z.number().describe("Obstacle min Y in stage coordinates."),
    width: z.number().describe("Obstacle width in stage coordinates."),
    height: z.number().describe("Obstacle height in stage coordinates."),
});

export const CompiledSceneSchema = z.object({
    duration_seconds: z.number().describe("Total compiled duration of the scene timeline."),
    background_ambient: z.array(BackgroundAmbientBindingSchema).default([]).describe("Compiled background ambient bindings that play during scene playback."),
    obstacles: z.array(SceneObstacleSchema).default([]).describe("Compiled obstacle regions derived from the background for collision/clamping."),
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

export const ImageGenerationCostSchema = z.object({
    cost: z.number().describe("Estimated USD cost for the storyboard image generation."),
    tokens: z.number().describe("Image generation token count."),
});

export const ActionSchema = z.object({
    actor_id: z.string().describe("The ID of the actor performing the action."),
    motion: z.string().describe("A semantic action verb, e.g., 'walk', 'idle', 'run', 'tip_hat'"),
    style: z.string().describe("An adverb or modifier describing how the action is performed, e.g., 'casual', 'panic', 'polite'"),
    start_time: z.number().default(0).describe("Timeline start time in seconds for this action."),
    duration_seconds: z.number().describe("The estimated duration of this specific action clip."),
    spatial_transform: SpatialTransformSchema.optional(),
    target_spatial_transform: SpatialTransformSchema.pick({
        x: true,
        y: true,
        scale: true,
        rotation: true,
        flip_x: true,
        flip_y: true,
    }).extend({
        z_index: SpatialTransformSchema.shape.z_index.optional(),
    }).optional(),
    animation_overrides: AnimationOverridesSchema.optional().describe("Optional explicit overrides for animation parameters. Takes priority over style-inferred values."),
});

export const StoryBeatSchema = z.object({
    scene_number: z.number().describe("Sequential index of the scene."),
    narrative: z.string().describe("A human-readable summary of what happens in this scene."),
    cameras: z.array(CameraSchema).describe("An array of sequential camera cuts or moves. Usually just 1 item, but can be more to cut between actors."),
    audio: z.array(AudioSchema).describe("Expected audio cues to play during this beat."),
    actions: z.array(ActionSchema).describe("Semantic motions that actors perform during this beat."),
    comic_panel_prompt: z.string().describe("A highly optimized text prompt suitable for an Image Generation model to draw a static comic panel of this specific beat."),
    image_data: z.string().optional().describe("Base64 data URL of the generated comic panel image."),
    image_generation_cost: ImageGenerationCostSchema.optional().describe("Persisted image generation usage for this storyboard beat."),
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
export type ClipBindingIKPlayback = z.infer<typeof ClipBindingIKPlaybackSchema>;
export type ClipBinding = z.infer<typeof ClipBindingSchema>;
export type SceneInstanceTrack = z.infer<typeof SceneInstanceTrackSchema>;
export type BackgroundAmbientBinding = z.infer<typeof BackgroundAmbientBindingSchema>;
export type SceneObstacle = z.infer<typeof SceneObstacleSchema>;
export type CompiledSceneData = z.infer<typeof CompiledSceneSchema>;
export type CompileReportData = z.infer<typeof CompileReportSchema>;
