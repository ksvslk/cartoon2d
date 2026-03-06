"use server";

import { generateStorySequence, streamStorySequence } from "@/lib/ai/director";
import { StoryGenerationData } from "@/lib/schema/story";

export type StreamResult = 
    | { type: 'story', data: StoryGenerationData }
    | { type: 'image', index: number, data: string }
    | { type: 'error', error: string };

export async function* processScenePromptStream(prompt: string): AsyncGenerator<StreamResult, void, unknown> {
    if (!prompt || prompt.trim() === "") {
        yield { type: 'error', error: "Prompt cannot be empty." };
        return;
    }

    try {
        const stream = streamStorySequence(prompt);
        for await (const chunk of stream) {
            yield chunk;
        }
    } catch (error: unknown) {
        console.error("Server Action Stream Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        yield { type: 'error', error: `Gemini API/Parse Error: ${message}` };
    }
}

export async function processScenePrompt(prompt: string): Promise<StoryGenerationData | { error: string }> {
    if (!prompt || prompt.trim() === "") {
        return { error: "Prompt cannot be empty." };
    }

    try {
        const data = await generateStorySequence(prompt);
        return data as StoryGenerationData;
    } catch (error: unknown) {
        console.error("Server Action Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Gemini API/Parse Error: ${message}` };
    }
}
