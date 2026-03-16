import { GoogleGenAI } from "@google/genai";
import { StoryGenerationSchema, StoryGenerationData, StageOrientation, getStageDims } from "../schema/story";
import { runGeminiRequestWithRetry } from "./retry";
import { VOICE_POOL } from "../voices";

/** Pick a voice for an actor based on attributes, avoiding duplicates within a scene. */
function pickVoiceForActor(
    actor: { species?: string; attributes?: string[]; visual_description?: string } | undefined,
    alreadyUsed: string[],
): string {
    const attrs = (actor?.attributes ?? []).join(" ").toLowerCase()
        + " " + (actor?.visual_description ?? "").toLowerCase()
        + " " + (actor?.species ?? "").toLowerCase();

    const isFemale = /\b(female|woman|girl|lady|she|her|queen|princess|mother|sister|aunt|grandma|grandmother|wife|daughter)\b/.test(attrs);
    const isMale   = /\b(male|man|boy|guy|he|him|king|prince|father|brother|uncle|grandpa|grandfather|husband|son)\b/.test(attrs);
    const isChild  = /\b(child|kid|boy|girl|baby|toddler|young|little)\b/.test(attrs);

    // Filter to en-US voices for auto-assignment (safest default)
    let candidates = VOICE_POOL.filter(v => v.lang === "en-US");

    // Gender filter
    if (isFemale && !isMale)       candidates = candidates.filter(v => v.gender === "female");
    else if (isMale && !isFemale)  candidates = candidates.filter(v => v.gender === "male");

    // Prefer higher-pitched (Standard) for children
    if (isChild) candidates = candidates.filter(v => v.id.includes("Standard"));

    // Exclude already-used voices
    const unused = candidates.filter(v => !alreadyUsed.includes(v.id));
    if (unused.length > 0) return unused[0].id;
    if (candidates.length > 0) return candidates[0].id;
    return "en-US-Standard-F";
}

// Ensure the API key exists in your environment or Next.js config
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

type PromptContentPart =
  | { text: string }
  | { inlineData: { data: string; mimeType: string } };

export async function* streamStorySequence(prompt: string, contextBeats?: StoryGenerationData['beats'], options?: { singleBeat?: boolean; orientation?: StageOrientation }, actorReferences?: Record<string, string>) {
    const orientation = options?.orientation ?? "landscape";
    const { width: stageW, height: stageH } = getStageDims(orientation);
    const aspectRatio = orientation === "portrait" ? "9:16" : "16:9";
    const compositionInstruction = orientation === "portrait"
        ? "PORTRAIT COMPOSITION IS MANDATORY: Fill the entire 9:16 frame with a true vertical composition. Do NOT place a wide horizontal scene inside the portrait canvas. Do NOT add blurred top/bottom filler bands, duplicated scenery, soft-focus padding, inset panels, poster frames, or letterboxing. The final image must read as one full-bleed portrait illustration that uses the whole canvas intentionally."
        : "LANDSCAPE COMPOSITION IS MANDATORY: Fill the entire 16:9 frame with a true widescreen composition. Do NOT add inset panels, poster frames, blurred side padding, or letterboxing. The final image must read as one full-bleed landscape illustration.";

    const systemInstruction = `You are the Lead Creative Director for a 2D animation studio.

Your job is to take a user's raw prompt and break it down into a highly structured, cinematic storyboard sequence.

CRITICAL: Your response MUST contain TWO things:
1. A single JSON object (the storyboard data)
2. One generated IMAGE for each beat/scene - you MUST generate these comic panel images inline.

## JSON Schema (output this FIRST, then generate images)

\`\`\`json
{
  "title": "string - A generated title for the entire sequence",
  "actors_detected": [
    {
      "id": "string - unique ID like 'actor-robot-cat'",
      "name": "string - character name",
      "species": "string - e.g. 'cat', 'human', 'robot'",
      "attributes": ["string - visual traits like 'orange tabby', 'blue hat'"],
      "visual_description": "string - concise visual appearance summary"
    }
  ],
  "beats": [
    {
      "scene_number": 1,
      "narrative": "string - what happens in this scene",
      "cameras": [
        {
          "zoom": 1.0,
          "x": 960,
          "y": 540,
          "rotation": 0,
          "target_actor_id": "optional string - actor to track",
          "target_x": "optional number - pan to x",
          "target_y": "optional number - pan to y",
          "target_zoom": "optional number - zoom to"
        }
      ],
      "audio": [
        {
          "type": "sfx | dialogue | music",
          "actor_id": "string (REQUIRED for dialogue, MUST exactly match the actor's id in actors_detected)",
          "text": "string (optional, exact words if dialogue)",
          "delivery_style": "string (optional, e.g. 'shouting angrily', 'whispering', 'cheerful')",
          "description": "string (optional, sound description if sfx/music)",
          "start_time": 0.0
        }
      ],
      "actions": [
        {
          "actor_id": "string",
          "motion": "string - semantic verb like 'walk', 'run', 'hide', 'idle'",
          "style": "string - adverb like 'panic', 'casual', 'frantic'",
          "duration_seconds": 2.0,
          "spatial_transform": {
            "x": 960,
            "y": 950,
            "scale": 0.5,
            "z_index": 10
          },
          "target_spatial_transform": {
            "x": 1400,
            "y": 950,
            "scale": 0.5
          },
          "animation_overrides": {
            "amplitude": 1.0,
            "speed": 1.0,
            "delay": 0.0
          }
        }
      ],
      "comic_panel_prompt": "string - MUST begin with a character identity block that repeats each actor's FULL visual_description verbatim, then describe the scene composition and background. Example: 'Alex, a man with short brown hair wearing a blue sweater, and Sarah, a woman with long blonde hair wearing a green cardigan, are seated at a cafe table. ...'"
    }
  ]
}
\`\`\`

## Rules
- Output the JSON object first as a text block.
- Then, for EACH beat, generate a vivid, colorful flat 2D style illustration based on the comic_panel_prompt.
- CHARACTER IDENTITY LOCK (CRITICAL): Every character MUST look EXACTLY the same across ALL generated panels — same hair color, hair style, skin tone, clothing colors, body proportions, and facial features. If Alex has short brown hair and a blue sweater in beat 1, he MUST have short brown hair and a blue sweater in beats 2 and 3. Do NOT change any character's appearance between panels. Treat the visual_description from actors_detected as a binding contract.
- COMIC PANEL PROMPT MUST EMBED IDENTITY: Every comic_panel_prompt MUST begin by restating each character's full visual_description from actors_detected verbatim. Do not summarize or paraphrase — copy the exact appearance details. This is mandatory for cross-panel consistency.
- EXTREME 2D FLATNESS REQUIRED: The art style MUST be composed of highly abstract, minimal vector-like solid color shapes. NO shading, NO gradients, NO 3D rendering, NO photorealism, NO drop shadows, NO floor shadows, NO cast shadows, NO lighting effects.
- CHARACTER ANGLES: Draw characters from the most cinematically appropriate angle for the scene — front view for dialogue, side profile for walking, 3/4 view for natural depth. Keep angles consistent within a scene.
- SUBJECT/BACKGROUND CONTRAST IS CRITICAL: The active characters must remain clearly readable against the background at a glance. Use strong silhouette separation, opposing value bands, simplified backdrops behind the subject, or subtle rim separation so tails, fins, limbs, and body edges never disappear into dark scenery.
- FULL-BODY RIG REFERENCE QUALITY IS CRITICAL: Any active subject that may later be rigged must be fully visible in frame from head to toe or tip to tip. Do NOT crop feet, hands, fins, tails, hats, props, wheels, or other silhouette-defining extremities unless the user explicitly asks for a close-up.
- MAXIMIZE SUBJECT SCALE for Reference Extractions: Frame active characters AS LARGE AS POSSIBLE within the panel while retaining the head-to-toe visibility required above. If a character is introduced, fill the canvas with their design to maximize reference resolution. Do not draw tiny characters lost in massive empty landscapes.
- LEAVE CLEAN MARGINS AROUND THE SUBJECT: Keep a small amount of negative space around the full figure so later SVG extraction can clearly separate the outer silhouette.
- KEEP OVERLAPS LEGIBLE: When one part clearly sits in front of another, stage the image so that front/back overlap reads unambiguously. Avoid tangents and messy pileups that make extraction or rig layering ambiguous.
- KEEP THE DRAWING SIMPLE ENOUGH TO VECTORIZE: Prefer a limited number of large flat shapes and clear color regions over noisy texture, hatch marks, tiny fragments, or decorative micro-details.
- ${compositionInstruction}
- DO NOT include any text, speech bubbles, or onomatopoeia (e.g., "BANG!", "CRASH!") in the images. These are handled by the audio/narrative data.
- DIALOGUE REQUIREMENT (CRITICAL): If the user's prompt includes characters speaking, talking, or having a conversation, you MUST explicitly create an entry in the \`audio\` array for EVERY spoken line with \`"type": "dialogue"\`, their exact spoken \`"text"\`, their emotional \`"delivery_style"\`, and the strictly accurate \`"actor_id"\` exactly matching the ID from \`actors_detected\`. If you omit the audio array, they will have no voice! Do not skip this!
- DIALOGUE TIMING (CRITICAL): Each dialogue entry MUST have a \`start_time\` in seconds that places it sequentially in the scene timeline. Estimate ~0.07 seconds per character of text to calculate duration. The first line starts at 0.0, the next line starts after the previous one finishes (previous start_time + estimated duration + 0.3s pause). Example for a 3-line exchange: line 1 at 0.0, line 2 at 2.5, line 3 at 4.8. Music and sfx entries typically start at 0.0 and run for the whole scene.
- TIMELINE SPACING (CRITICAL): Ensure dialogue tracks naturally alternate logic. Space out long dialogue exchanges across different scenes if needed to avoid overcrowding.
- SCREENPLAY FORMAT (CRITICAL): If the prompt contains lines in the format \`CharacterName: spoken text\`, each such line MUST become its own separate \`"type": "dialogue"\` entry in the audio array. Do NOT merge, summarize, or skip any lines. The \`actor_id\` must match the character name. If the prompt has \`[Camera: ...]\` directions, split beats at those markers and translate them into \`cameras\` array entries: "zoom in" / "close-up" → target_zoom 2.0, "zoom out" / "wide shot" → target_zoom 1.0, "pan to X" → target_actor_id of X, "fade" → keep current zoom. Each \`[Camera:]\` block with its following dialogue lines should be a separate beat.
- Output each image immediately after the JSON.
- Keep actions as simple semantic verbs.
- actors_detected must list ALL characters.
- Motion choice must respect what each subject is. Infer physical affordances from the actor's name, species, attributes, and visual description before assigning actions.
- If a subject appears only lightly articulated or structurally simple, prefer transform-dominant actions, orientation changes, or restrained in-place motion instead of rich internal body mechanics.
- Do not assign gestures, locomotion patterns, or expressive deformations that require anatomy or articulation not supported by the actor description.
- THE CAMERA IS STATIC BY DEFAULT. Do NOT use target_actor_id, target_x, target_y, target_zoom or rotate unless the user's prompt explicitly requests a camera move, pan, zoom, or tracking shot.
- CAMERA FOLLOW / ZOOM (when requested): If the user asks to "follow", "track", "zoom in on", or "show X then Y", use the cameras array to describe camera moves over time. Each entry is a sequential camera cut or move. Use target_actor_id to track an actor, target_zoom for zoom transitions, and multiple camera entries with different start_time values to cut between subjects. Example: zoom into actor-A (cameras[0]: zoom 1.0, target_zoom 2.0, target_actor_id "actor-A"), then cut to actor-B (cameras[1]: start_time 3.0, zoom 1.5, target_actor_id "actor-B").

## Spatial Transform Rules (CRITICAL — always include these in every action)
- The stage is ${stageW}x${stageH} pixels. x=${stageW / 2} is center, x=${Math.round(stageW * 0.16)} is far-left, x=${Math.round(stageW * 0.83)} is far-right.
- y represents the character's floor contact point: y=${Math.round(stageH * 0.83)}-${Math.round(stageH * 0.93)} for ground level, smaller y = higher on screen.
- SPREAD characters horizontally — NEVER stack multiple actors at x=${stageW / 2}. Assign distinct x positions.
- Use scale + y together for depth perspective: far away = lower scale (0.3-0.4), higher y; close = higher scale (0.6-0.8), lower y.
- z_index: foreground characters 20-30, midground 10-15, background 5-10.
- ALWAYS include target_spatial_transform for any locomotion action: walk, run, jump, swim, crawl, fly, slither, glide, drive, skate, roll, scoot, dash, march, sprint, hop, chase, drift.
- Omit target_spatial_transform only for clearly in-place actions like idle, stare, talk, hide, wave, panic, celebrate, sit.
- target_spatial_transform.x should be meaningfully different from spatial_transform.x for horizontal locomotion (minimum 300px apart).
- For swim/fly/glide/drift motions, you may also change target_spatial_transform.y to create believable travel arcs.

## Animation Override Rules
- animation_overrides MUST be included for every action. Use it to express how the style affects the motion.
- amplitude: how big/exaggerated the movement is. frantic/panic = 1.8, fast = 1.2, neutral = 1.0, gentle/calm = 0.5.
- speed: how fast the animation cycles. frantic = 1.9, fast = 1.5, neutral = 1.0, slow/tired = 0.5.
- delay: stagger actors in a scene (e.g., 0.0 for first actor, 0.3 for second, 0.6 for third).
- ${options?.singleBeat ? "CRITICAL: Generate EXACTLY 1 beat based on the prompt." : "Generate 3-5 beats for a typical prompt. If the prompt is a screenplay with explicit dialogue lines, preserve EVERY spoken line as a separate dialogue audio entry — do NOT summarize or skip any lines. Split beats at natural camera cut points or scene transitions."}`;

    const contentsParts: PromptContentPart[] = [];

    // Inject Sliding Window Context (HYBRID APPROACH)
    // 1. Environmental Anchor: We inject ONLY the single most recent panel image to establish background/lighting continuity.
    // 2. Identity Lock: We inject the Actor Reference portraits for characters present.

    const lastBeat = contextBeats && contextBeats.length > 0 ? contextBeats[contextBeats.length - 1] : null;

    if (lastBeat) {
        contentsParts.push({ text: "Here is the final comic panel from the previous scene to establish the current environment, lighting, and placement." });

        if (lastBeat.image_data) {
            const base64Data = lastBeat.image_data.split(',')[1] || lastBeat.image_data;
            contentsParts.push({
                inlineData: { data: base64Data, mimeType: "image/jpeg" }
            });
        }
        contentsParts.push({ text: `Prior Scene Narrative: ${lastBeat.narrative}` });
    }

    // Identity Lock Injection
    if (actorReferences && Object.keys(actorReferences).length > 0) {
        contentsParts.push({ text: "CRITICAL: You MUST maintain the exact character design, facial structure, species, and color palettes from the following Reference Portraits for any returning characters." });

        for (const [actorId, base64Image] of Object.entries(actorReferences)) {
            const rawBase64 = base64Image.split(',')[1] || base64Image;
            contentsParts.push({ text: `Reference Portrait for Actor ID: ${actorId}` });
            contentsParts.push({
                inlineData: { data: rawBase64, mimeType: "image/jpeg" }
            });
        }
    }

    contentsParts.push({ text: `\n\nNow, generate the NEXT sequence of the story based on this new prompt: ${prompt}\nRemember, output JSON first, then generate the images.` });

    const responseStream = await runGeminiRequestWithRetry(
        "Storyboard generation request",
        () => ai.models.generateContentStream({
            model: "gemini-3.1-flash-image-preview",
            contents: contentsParts,
            config: {
                systemInstruction,
                temperature: 0.7,
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: {
                    imageSize: "512",
                    aspectRatio,
                },
            }
        }),
    );

    let fullText = "";
    let jsonParsed = false;
    let imageIndex = 0;
    const bufferedImages: string[] = []; // Buffer images until JSON is parsed
    let lastUsage: { promptTokenCount?: number; candidatesTokenCount?: number } = {};

    // Helper to attempt JSON extraction and parsing
    const tryParseJson = (text: string, isFinal: boolean = false): { type: 'story', data: StoryGenerationData } | null => {
        let jsonStr = text;
        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const braceStart = text.indexOf("{");
            const braceEnd = text.lastIndexOf("}");
            if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
                jsonStr = text.substring(braceStart, braceEnd + 1);
            }
        }
        try {
            const json = JSON.parse(jsonStr);

            // ── Normalize AI output before Zod validation ──
            if (json.beats && Array.isArray(json.beats)) {
                const actors: Record<string, { species?: string; attributes?: string[] }> = {};
                if (json.actors_detected && Array.isArray(json.actors_detected)) {
                    for (const actor of json.actors_detected) {
                        if (actor.id) actors[actor.id] = actor;
                    }
                }

                for (const beat of json.beats) {
                    // 1) Convert singular "camera" object → "cameras" array
                    if (beat.camera && !beat.cameras) {
                        beat.cameras = [beat.camera];
                        delete beat.camera;
                    }

                    // 2) Auto-assign voice_id & sequential start_time for dialogue
                    if (beat.audio && Array.isArray(beat.audio)) {
                        let cumulativeTime = 0;
                        const assignedVoices: Record<string, string> = {};

                        for (const entry of beat.audio) {
                            if (entry.type === 'dialogue' && entry.actor_id) {
                                // Auto-assign voice based on actor attributes
                                if (!entry.voice_id) {
                                    if (!assignedVoices[entry.actor_id]) {
                                        assignedVoices[entry.actor_id] = pickVoiceForActor(
                                            actors[entry.actor_id],
                                            Object.values(assignedVoices),
                                        );
                                    }
                                    entry.voice_id = assignedVoices[entry.actor_id];
                                }

                                // Auto-assign sequential start_time if missing
                                if (entry.start_time === undefined || entry.start_time === 0) {
                                    entry.start_time = cumulativeTime;
                                }
                                const estDuration = entry.text
                                    ? entry.text.length * 0.07
                                    : 2.0;
                                cumulativeTime = entry.start_time + estDuration + 0.3;
                            }
                        }
                    }
                }
            }

            const validatedData = StoryGenerationSchema.parse(json);
            if (options?.singleBeat && validatedData.beats.length > 1) {
                // Force exactly 1 beat if requested, to avoid endless loading UI for missing images
                validatedData.beats = [validatedData.beats[0]];
            }
            return { type: 'story' as const, data: validatedData };
        } catch (e: unknown) {
            if (isFinal) {
                const message = e instanceof Error ? e.message : String(e);
                console.error("[tryParseJson] Failed to parse or validate JSON:", message);
                console.error("RAW JSON STRING:\n", jsonStr);
            }
            return null;
        }
    };

    for await (const chunk of responseStream) {
        if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;

        if (!chunk.candidates || chunk.candidates.length === 0 || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
            // Log blocked or empty chunks for debugging
            if (chunk.candidates && chunk.candidates[0]) {
                const c = chunk.candidates[0];
                if (c.finishReason) console.warn("[Gemini] Chunk finishReason:", c.finishReason);
                const safetyRatings = (c as { safetyRatings?: unknown }).safetyRatings;
                if (safetyRatings) console.warn("[Gemini] Safety ratings:", JSON.stringify(safetyRatings));
            }
            continue;
        }

        for (const part of chunk.candidates[0].content.parts) {
            if (part.text) {
                fullText += part.text;

                // Try to parse JSON as text accumulates (model may finish JSON before sending images)
                if (!jsonParsed) {
                    const result = tryParseJson(fullText);
                    if (result) {
                        yield result;
                        jsonParsed = true;
                        // Flush any buffered images
                        for (const img of bufferedImages) {
                            yield { type: 'image' as const, index: imageIndex, data: img };
                            imageIndex++;
                        }
                        bufferedImages.length = 0;
                    }
                }
            } else if (part.inlineData) {
                const base64 = part.inlineData.data || "";
                const mime = part.inlineData.mimeType || "image/jpeg";
                const imageDataUri = `data:${mime};base64,${base64}`;

                if (!jsonParsed) {
                    // Try to parse JSON now that we hit an image
                    const result = tryParseJson(fullText);
                    if (result) {
                        yield result;
                        jsonParsed = true;
                        // Flush buffered images first
                        for (const img of bufferedImages) {
                            yield { type: 'image' as const, index: imageIndex, data: img };
                            imageIndex++;
                        }
                        bufferedImages.length = 0;
                    } else {
                        // JSON not ready yet - buffer this image for later
                        bufferedImages.push(imageDataUri);
                        continue;
                    }
                }

                yield { type: 'image' as const, index: imageIndex, data: imageDataUri };
                imageIndex++;
            }
        }
    }

    // Yield final token usage so callers can show image generation cost
    if (lastUsage.promptTokenCount !== undefined || lastUsage.candidatesTokenCount !== undefined) {
        yield {
            type: 'usage' as const,
            promptTokens: lastUsage.promptTokenCount || 0,
            candidateTokens: lastUsage.candidatesTokenCount || 0,
            imageCount: imageIndex + bufferedImages.length,
        };
    }

    // Final attempt: parse JSON if it still hasn't been parsed
    if (!jsonParsed) {
        const result = tryParseJson(fullText, true);
        if (result) {
            yield result;
            jsonParsed = true;
            // Flush any buffered images
            for (const img of bufferedImages) {
                yield { type: 'image' as const, index: imageIndex, data: img };
                imageIndex++;
            }
        } else {
            if (fullText.trim() === "") {
                console.error("[Gemini] Empty response - likely blocked by safety filters or rate limit.");
                yield { type: 'error' as const, error: "Gemini returned an empty response. This usually means the request was blocked by safety filters, you hit a rate limit, or the context images were too large. Try again with a simpler prompt." };
            } else {
                console.error("Final JSON parse failed. Full text received:", fullText.slice(0, 500));
                yield { type: 'error' as const, error: "Failed to parse storyboard JSON from Gemini response." };
            }
        }
    }
}

export async function editSceneImage(base64Image: string, editPrompt: string, orientation: StageOrientation = "landscape"): Promise<string> {
    const aspectRatio = orientation === "portrait" ? "9:16" : "16:9";
    const compositionInstruction = orientation === "portrait"
        ? "The output MUST be a full-bleed portrait illustration that uses the entire 9:16 canvas. Do NOT preserve or create blurred top/bottom filler, duplicated scenery, inset panels, or a landscape strip sitting inside a portrait frame."
        : "The output MUST be a full-bleed landscape illustration that uses the entire 16:9 canvas. Do NOT preserve or create inset panels, blurred side filler, or letterboxing.";
    const systemInstruction = `You are a professional comic book illustrator.
You have been provided with an existing comic panel and a localized instruction from the director.
Your job is to redraw the image to satisfy the director's request.
Maintain the exact same art style, color palette, and character likenesses as the original image unless explicitly instructed to change them.
${compositionInstruction}
Keep any riggable subject fully visible head-to-toe or tip-to-tip unless the edit explicitly asks for a close-up.
Do not crop silhouette-defining extremities such as feet, hands, fins, tails, hats, tools, or wheels.
Preserve clear front/back overlap readability so later SVG extraction can recover internal layering.
DO NOT include any text or speech bubbles.
Output ONLY the new generated image.`;

    const rawBase64 = base64Image.split(',')[1] || base64Image;

    const response = await runGeminiRequestWithRetry(
        "Scene image edit request",
        () => ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: [
                {
                    inlineData: {
                        data: rawBase64,
                        mimeType: "image/jpeg"
                    }
                },
                { text: `Director's Edit Request: ${editPrompt}` }
            ],
            config: {
                systemInstruction,
                temperature: 0.6,
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: {
                    imageSize: "512",
                    aspectRatio,
                },
            }
        }),
    );

    if (response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
        const part = response.candidates[0].content!.parts[0];
        if (part.inlineData && part.inlineData.data) {
            const mime = part.inlineData.mimeType || "image/jpeg";
            return `data:${mime};base64,${part.inlineData.data}`;
        }
    }

    throw new Error("Failed to generate edited image.");
}
