import { GoogleGenAI } from "@google/genai";
import { StoryGenerationSchema, StoryGenerationData } from "../schema/story";

// Ensure the API key exists in your environment or Next.js config
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

export async function generateStorySequence(prompt: string): Promise<StoryGenerationData | null> {
    const systemInstruction = `You are the Lead Creative Director for a 2D animation studio.
        
Your job is to take a user's raw prompt and break it down into a highly structured, cinematic storyboard sequence.
You must adhere EXACTLY to the provided JSON schema.

For each "beat" (scene):
1. Write a highly optimized, single-paragraph text prompt for an Image Generation model (like Imagen 3) in the 'comic_panel_prompt' field. This should describe the scene visually as a comic book panel.
2. Break down the specific semantic actions happening in the scene for the animation engine. Action strings should be simple verbs like "walk", "idle", "tip_hat", "sit". 
3. Assign audio cues if applicable (music, sfx, or exact dialogue).

Ensure that 'actors_detected' contains a master list of all characters that will appear in the story so the system can build their SVG rigs.`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                systemInstruction,
                responseMimeType: "application/json",
                // Pass the Zod schema directly into the Gemini SDK to force structural compliance
                responseSchema: StoryGenerationSchema
            }
        });

        const textResponse = response.text;
        if (!textResponse) throw new Error("Empty response from Gemini");

        const json = JSON.parse(textResponse);

        // Final runtime validation through Zod to guarantee we can safely pass this to the UI and GSAP engine
        return StoryGenerationSchema.parse(json);
    } catch (error) {
        console.error("Story sequence generation failed:", error);
        return null;
    }
}
