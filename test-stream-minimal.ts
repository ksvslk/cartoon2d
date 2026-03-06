import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
    try {
        const stream = await ai.models.generateContentStream({
            model: "gemini-3.1-flash-image-preview",
            contents: "Tell me a joke and then generate a picture of a cat.",
            config: {
                systemInstruction: "You are a funny assistant."
            }
        });
        for await (const chunk of stream) {
            console.log("Chunk candidates:", chunk.candidates?.length);
        }
    } catch (e) {
        console.error("STREAM ERROR:", e);
    }
}
run();
