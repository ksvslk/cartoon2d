"use server";

import { generateStoryScene } from "@/lib/ai/director";
import { StoryScene } from "@/lib/schema/story";
import { saveScene } from "@/lib/storage/local";
import { randomUUID } from "crypto";

export async function createSceneAction(prompt: string, actors: string[]): Promise<{ success: boolean; data?: StoryScene; error?: string }> {
    try {
        if (!prompt.trim()) {
            return { success: false, error: "Prompt cannot be empty" };
        }

        if (!process.env.GEMINI_API_KEY) {
            return { success: false, error: "Missing GEMINI_API_KEY in environment" };
        }

        const sceneData = await generateStoryScene(prompt, actors);

        if (!sceneData) {
            return { success: false, error: "AI failed to generate a valid scene sequence" };
        }

        // Assign an ID if Gemini didn't provide a valid one
        if (!sceneData.id || sceneData.id.trim() === "") {
            sceneData.id = randomUUID();
        }

        // Persist to local project storage
        await saveScene(sceneData);

        return {
            success: true,
            data: sceneData
        };

    } catch (error: unknown) {
        console.error("Action error:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to generate scene";
        return { success: false, error: errorMessage };
    }
}
