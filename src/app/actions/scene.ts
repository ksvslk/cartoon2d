"use server";

import { generateStorySequence } from "@/lib/ai/director";
import { StoryGenerationData } from "@/lib/schema/story";

export async function processScenePrompt(prompt: string): Promise<StoryGenerationData | { error: string }> {
    if (!prompt || prompt.trim() === "") {
        return { error: "Prompt cannot be empty." };
    }

    try {
        const data = await generateStorySequence(prompt);
        if (!data) {
            return { error: "Failed to parse a valid storyboard sequence from the AI." };
        }
        return data;
    } catch (error: unknown) {
        console.error("Server Action Error:", error);
        const message = error instanceof Error ? error.message : "An unexpected error occurred during generation.";
        return { error: message };
    }
}
