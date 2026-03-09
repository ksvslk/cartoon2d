import { GoogleGenAI } from "@google/genai";
import { StoryGenerationSchema, StoryGenerationData } from "../schema/story";

// Ensure the API key exists in your environment or Next.js config
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

export async function* streamStorySequence(prompt: string, contextBeats?: StoryGenerationData['beats'], options?: { singleBeat?: boolean }, actorReferences?: Record<string, string>) {
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
      "camera": {
        "zoom": 1.0,
        "pan": "static | pan_right | pan_left | pan_up | pan_down | tracking"
      },
      "audio": [
        {
          "type": "sfx | dialogue | music",
          "actor_id": "string (optional, for dialogue)",
          "text": "string (optional, exact words if dialogue)",
          "description": "string (optional, sound description if sfx/music)"
        }
      ],
      "actions": [
        {
          "actor_id": "string",
          "motion": "string - semantic verb like 'walk', 'run', 'hide', 'idle'",
          "style": "string - adverb like 'panic', 'casual', 'frantic'",
          "duration_seconds": 2.0
        }
      ],
      "comic_panel_prompt": "string - optimized prompt describing this scene as a comic book panel"
    }
  ]
}
\`\`\`

## Rules
- Output the JSON object first as a text block.
- Then, for EACH beat, generate a vivid, colorful flat 2D style illustration based on the comic_panel_prompt. 
- EXTREME 2D FLATNESS REQUIRED: The art style MUST be composed of highly abstract, minimal vector-like solid color shapes. NO shading, NO gradients, NO 3D rendering, NO photorealism.
- CLEAR SILHOUETTES: Characters should ideally be drawn in clear, distinct profile (side-view) or straight-on angles to make them easier to extract as 2D puppets.
- DO NOT include any text, speech bubbles, or onomatopoeia (e.g., "BANG!", "CRASH!") in the images. These are handled by the audio/narrative data.
- Output each image immediately after the JSON.
- Keep actions as simple semantic verbs.
- actors_detected must list ALL characters.
- ${options?.singleBeat ? "CRITICAL: Generate EXACTLY 1 beat based on the prompt." : "Generate 3-5 beats for a typical prompt."}`;

    const contentsParts: any[] = [];

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

    const responseStream = await ai.models.generateContentStream({
        model: "gemini-3.1-flash-image-preview",
        contents: contentsParts,
        config: {
            systemInstruction,
            temperature: 0.7,
            // @ts-expect-error - The outputOptions schema is supported by the REST API for gemini-3.1-flash-image but missing from the current SDK TS definitions.
            outputOptions: {
                aspectRatio: "16:9",
                mimeType: "image/jpeg",
                compressionQuality: 60,
                numberOfImages: 1,
                width: 768
            }
        }
    });

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
            const validatedData = StoryGenerationSchema.parse(json);
            if (options?.singleBeat && validatedData.beats.length > 1) {
                // Force exactly 1 beat if requested, to avoid endless loading UI for missing images
                validatedData.beats = [validatedData.beats[0]];
            }
            return { type: 'story' as const, data: validatedData };
        } catch (e: any) {
            if (isFinal) {
                console.error("[tryParseJson] Failed to parse or validate JSON:", e.message || e);
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
                if ((c as any).safetyRatings) console.warn("[Gemini] Safety ratings:", JSON.stringify((c as any).safetyRatings));
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
                const imageDataUri = `data:image/png;base64,${base64}`;

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

export async function editSceneImage(base64Image: string, editPrompt: string): Promise<string> {
    const systemInstruction = `You are a professional comic book illustrator.
You have been provided with an existing comic panel and a localized instruction from the director.
Your job is to redraw the image to satisfy the director's request.
Maintain the exact same art style, color palette, and character likenesses as the original image unless explicitly instructed to change them.
DO NOT include any text or speech bubbles.
Output ONLY the new generated image.`;

    const rawBase64 = base64Image.split(',')[1] || base64Image;

    const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: [
            {
                inlineData: {
                    data: rawBase64,
                    mimeType: "image/png"
                }
            },
            { text: `Director's Edit Request: ${editPrompt}` }
        ],
        config: {
            systemInstruction,
            temperature: 0.6,
            // @ts-expect-error
            outputOptions: {
                aspectRatio: "16:9",
                mimeType: "image/jpeg",
                compressionQuality: 60,
                numberOfImages: 1,
                width: 768
            }
        }
    });

    if (response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
        const part = response.candidates[0].content!.parts[0];
        if (part.inlineData && part.inlineData.data) {
            return `data:image/png;base64,${part.inlineData.data}`;
        }
    }

    throw new Error("Failed to generate edited image.");
}
