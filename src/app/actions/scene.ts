"use server";

import { streamStorySequence, editSceneImage } from "@/lib/ai/director";
import { StoryGenerationData } from "@/lib/schema/story";

export type StreamResult =
    | { type: 'story', data: StoryGenerationData }
    | { type: 'image', index: number, data: string }
    | { type: 'usage', promptTokens: number, candidateTokens: number }
    | { type: 'error', error: string };

export async function* processScenePromptStream(prompt: string, contextBeats?: StoryGenerationData['beats'], options?: { singleBeat?: boolean }, actorReferences?: Record<string, string>): AsyncGenerator<StreamResult, void, unknown> {
    if (!prompt || prompt.trim() === "") {
        yield { type: 'error', error: "Prompt cannot be empty." };
        return;
    }

    try {
        const stream = streamStorySequence(prompt, contextBeats, options, actorReferences);
        for await (const chunk of stream) {
            yield chunk;
        }
    } catch (error: unknown) {
        console.error("Server Action Stream Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        yield { type: 'error', error: `Gemini API/Parse Error: ${message}` };
    }
}

export async function processSceneImageEdit(base64Image: string, editPrompt: string): Promise<{ data?: string, error?: string }> {
    if (!base64Image || !editPrompt || editPrompt.trim() === "") {
        return { error: "Image and edit prompt are required." };
    }

    try {
        const newImage = await editSceneImage(base64Image, editPrompt);
        return { data: newImage };
    } catch (error: unknown) {
        console.error("Server Action Image Edit Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Image Edit Failed: ${message}` };
    }
}
