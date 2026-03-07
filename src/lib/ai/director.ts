import { GoogleGenAI } from "@google/genai";
import { StoryGenerationSchema, StoryGenerationData } from "../schema/story";

// Ensure the API key exists in your environment or Next.js config
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

export async function* streamStorySequence(prompt: string) {
    const systemInstruction = `You are the Lead Creative Director for a 2D animation studio.

Your job is to take a user's raw prompt and break it down into a highly structured, cinematic storyboard sequence.

CRITICAL: Your response MUST contain TWO things:
1. A single JSON object (the storyboard data)
2. One generated IMAGE for each beat/scene — you MUST generate these comic panel images inline.

## JSON Schema (output this FIRST, then generate images)

\`\`\`json
{
  "title": "string — A generated title for the entire sequence",
  "actors_detected": [
    {
      "id": "string — unique ID like 'actor-robot-cat'",
      "name": "string — character name",
      "species": "string — e.g. 'cat', 'human', 'robot'",
      "attributes": ["string — visual traits like 'orange tabby', 'blue hat'"],
      "visual_description": "string — concise visual appearance summary"
    }
  ],
  "beats": [
    {
      "scene_number": 1,
      "narrative": "string — what happens in this scene",
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
          "motion": "string — semantic verb like 'walk', 'run', 'hide', 'idle'",
          "style": "string — adverb like 'panic', 'casual', 'frantic'",
          "duration_seconds": 2.0
        }
      ],
      "comic_panel_prompt": "string — optimized prompt describing this scene as a comic book panel"
    }
  ]
}
\`\`\`

## Rules
- Output the JSON object first as a text block.
- Then, for EACH beat, generate a vivid, colorful flat 2D style illustration based on the comic_panel_prompt. 
- STRICTLY AVOID 3D, CGI, OR PHOTOREALISTIC STYLES. 
- DO NOT include any text, speech bubbles, or onomatopoeia (e.g., "BANG!", "CRASH!") in the images. These are handled by the audio/narrative data.
- Output each image immediately after the JSON.
- Keep actions as simple semantic verbs.
- actors_detected must list ALL characters.
- Generate 3-5 beats for a typical prompt.`;

    const responseStream = await ai.models.generateContentStream({
        model: "gemini-3.1-flash-image-preview",
        contents: prompt,
        config: {
            systemInstruction
        }
    });

    let fullText = "";
    let jsonParsed = false;
    let imageIndex = 0;

    for await (const chunk of responseStream) {
        if (!chunk.candidates || chunk.candidates.length === 0 || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
            continue;
        }

        for (const part of chunk.candidates[0].content.parts) {
            if (part.text) {
                fullText += part.text;
            } else if (part.inlineData) {
                if (!jsonParsed) {
                    let jsonStr = fullText;
                    const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
                    if (jsonMatch) {
                        jsonStr = jsonMatch[1].trim();
                    } else {
                        const braceStart = fullText.indexOf("{");
                        const braceEnd = fullText.lastIndexOf("}");
                        if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
                            jsonStr = fullText.substring(braceStart, braceEnd + 1);
                        }
                    }
                    try {
                        const json = JSON.parse(jsonStr);
                        const validatedData = StoryGenerationSchema.parse(json);
                        yield { type: 'story' as const, data: validatedData };
                        jsonParsed = true;
                    } catch (error) {
                        console.error("Partial parse failed", error);
                        throw new Error("Failed to parse JSON before images");
                    }
                }

                const base64 = part.inlineData.data || "";
                yield { type: 'image' as const, index: imageIndex, data: `data:image/png;base64,${base64}` };
                imageIndex++;
            }
        }
    }

    if (!jsonParsed) {
        let jsonStr = fullText;
        const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            const braceStart = fullText.indexOf("{");
            const braceEnd = fullText.lastIndexOf("}");
            if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
                jsonStr = fullText.substring(braceStart, braceEnd + 1);
            }
        }
        try {
            const json = JSON.parse(jsonStr);
            const validatedData = StoryGenerationSchema.parse(json);
            yield { type: 'story' as const, data: validatedData };
            jsonParsed = true;
        } catch (error) {
            console.error("Final parse failed", error);
            throw new Error("Failed to parse final JSON");
        }
    }
}

export async function generateStorySequence(prompt: string): Promise<StoryGenerationData | null> {
    const systemInstruction = `You are the Lead Creative Director for a 2D animation studio.

Your job is to take a user's raw prompt and break it down into a highly structured, cinematic storyboard sequence.

CRITICAL: Your response MUST contain TWO things:
1. A single JSON object (the storyboard data)
2. One generated IMAGE for each beat/scene — you MUST generate these comic panel images inline.

## JSON Schema (output this FIRST, then generate images)

\`\`\`json
{
  "title": "string — A generated title for the entire sequence",
  "actors_detected": [
    {
      "id": "string — unique ID like 'actor-robot-cat'",
      "name": "string — character name",
      "species": "string — e.g. 'cat', 'human', 'robot'",
      "attributes": ["string — visual traits like 'orange tabby', 'blue hat'"],
      "visual_description": "string — concise visual appearance summary"
    }
  ],
  "beats": [
    {
      "scene_number": 1,
      "narrative": "string — what happens in this scene",
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
          "motion": "string — semantic verb like 'walk', 'run', 'hide', 'idle'",
          "style": "string — adverb like 'panic', 'casual', 'frantic'",
          "duration_seconds": 2.0
        }
      ],
      "comic_panel_prompt": "string — optimized prompt describing this scene as a comic book panel"
    }
  ]
}
\`\`\`

## Rules
- Output the JSON object first as a text block.
- Then, for EACH beat, generate a vivid, colorful flat 2D style illustration based on the comic_panel_prompt. 
- STRICTLY AVOID 3D, CGI, OR PHOTOREALISTIC STYLES. 
- DO NOT include any text, speech bubbles, or onomatopoeia (e.g., "BANG!", "CRASH!") in the images. These are handled by the audio/narrative data.
- Output each image immediately after the JSON.
- Keep actions as simple semantic verbs.
- actors_detected must list ALL characters.
- Generate 3-5 beats for a typical prompt.`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: prompt,
            config: {
                systemInstruction
                // NOTE: No responseMimeType or responseSchema — those block image generation!
            }
        });

        const candidates = response.candidates;
        if (!candidates || candidates.length === 0 || !candidates[0].content || !candidates[0].content.parts) {
            throw new Error("Empty or invalid response structure from Gemini");
        }

        let fullText = "";
        const base64Images: string[] = [];

        // Parse interleaved parts — text for JSON, inlineData for images
        for (const part of candidates[0].content.parts) {
            if (part.text) {
                fullText += part.text;
            } else if (part.inlineData) {
                base64Images.push(part.inlineData.data || "");
            }
        }

        if (!fullText) throw new Error("No textual JSON found in the response.");

        // Extract JSON from the text (model may wrap it in markdown code fences)
        let jsonStr = fullText;
        const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        } else {
            // Try to find a raw JSON object
            const braceStart = fullText.indexOf("{");
            const braceEnd = fullText.lastIndexOf("}");
            if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
                jsonStr = fullText.substring(braceStart, braceEnd + 1);
            }
        }

        const json = JSON.parse(jsonStr);

        // Map the gathered inline base64 images sequentially to the generated beats
        if (json.beats && Array.isArray(json.beats)) {
            for (let i = 0; i < json.beats.length; i++) {
                if (base64Images[i]) {
                    json.beats[i].image_data = `data:image/png;base64,${base64Images[i]}`;
                }
            }
        }

        console.log(`Parsed ${json.beats?.length || 0} beats, ${base64Images.length} images from interleaved response.`);

        // Final runtime validation through Zod
        const validatedData = StoryGenerationSchema.parse(json);
        return validatedData;
    } catch (error) {
        console.error("Story sequence generation failed:", error);
        throw error;
    }
}
