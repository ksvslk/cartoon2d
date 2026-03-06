import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function testInterleaved() {
    console.log("Testing gemini-3.1-flash-image-preview interleaved output...");
    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: "Write a short JSON object with {name: 'John'}, then generate a picture of a red apple.",
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: { name: { type: "STRING" } }
                }
            }
        });

        // Safely stringify without dumping huge base64 strings
        const safeCandidates = response.candidates?.map(c => ({
            ...c,
            content: {
                ...c.content,
                parts: c.content?.parts?.map(p => ({
                    ...p,
                    inlineData: p.inlineData ? { ...p.inlineData, data: "[BASE64_TRUNCATED_FOR_SAFETY]" } : undefined
                }))
            }
        }));

        console.log("CANDIDATES:", JSON.stringify(safeCandidates, null, 2));
    } catch (e) {
        console.error("ERROR:", e);
    }
}

testInterleaved();
