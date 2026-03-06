import { GoogleGenAI } from "@google/genai";
import { StorySceneSchema, StoryScene } from "../schema/story";

// Ensure the API key exists in your environment or Next.js config
const genai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

export async function generateStoryScene(prompt: string, actors: string[]): Promise<StoryScene | null> {
    const systemInstruction = `
You are a creative storyboard director for a comic-to-animation system.
Based on the user's prompt, generate a short scene composed of sequential beats.
Each beat should contain "narrativeText" (the story), a "panelDescription" (what the camera sees), optional "audioCues", and an array of semantic "actions" for the available actors.
The available actors in this scene are: ${actors.join(', ')}.
The scene MUST strictly adhere to the provided JSON schema.
  `;

    try {
        const response = await genai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                systemInstruction,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        id: { type: "STRING" },
                        title: { type: "STRING" },
                        environment: { type: "STRING" },
                        beats: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    id: { type: "STRING" },
                                    narrativeText: { type: "STRING" },
                                    panelDescription: { type: "STRING" },
                                    audioCues: { type: "ARRAY", items: { type: "STRING" } },
                                    actions: {
                                        type: "ARRAY",
                                        items: {
                                            type: "OBJECT",
                                            properties: {
                                                actorId: { type: "STRING" },
                                                motion: {
                                                    type: "OBJECT",
                                                    properties: {
                                                        action: { type: "STRING", enum: ["idle", "walk", "run", "jump", "sit", "reach", "lean", "look", "speak"] },
                                                        target: { type: "STRING" },
                                                        speed: { type: "NUMBER" },
                                                        intensity: { type: "NUMBER" },
                                                        duration: { type: "NUMBER" }
                                                    },
                                                    required: ["action"]
                                                }
                                            },
                                            required: ["actorId", "motion"]
                                        }
                                    }
                                },
                                required: ["id", "narrativeText", "panelDescription"]
                            }
                        }
                    },
                    required: ["id", "title", "beats"]
                }
            }
        });

        const textResponse = response.text;
        if (!textResponse) throw new Error("Empty response from Gemini");

        const json = JSON.parse(textResponse);
        // Validate output through Zod
        return StorySceneSchema.parse(json);
    } catch (error) {
        console.error("Story generation failed:", error);
        return null;
    }
}
