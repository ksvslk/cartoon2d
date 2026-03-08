"use server";

import { GoogleGenAI } from "@google/genai";
import { DraftsmanSchema, DraftsmanData } from "@/lib/schema/rig";

// Initialize the Gemini client
// Note: In production, ensure process.env.GEMINI_API_KEY is securely stored
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const DRAFTSMAN_SYSTEM_PROMPT = `
You are the Draftsman, an expert SVG vector artist and technical rigger.
Your job is to take a raster character or prop image and perfectly recreate it as a clean, highly-structured, animatable SVG vector file.

CRITICAL REQUIREMENTS:
1. **Resolution Independence**: The output SVG MUST use \`<svg viewBox="0 0 1000 1000">\`. This coordinate space must be strictly adhered to.
2. **Minimalist & Clean 2D Styling**: KEEP IT EXTREMELY SIMPLE. Use clean, minimalist 2D vector shapes with solid flat colors. DO NOT create overly complex, disjointed, blocky, or 3D-like structural rigs. Prioritize visual resemblance over mechanical complexity.
3. **Multi-Angle Character Sheet (CRITICAL)**: Do NOT rig the character in the specific dynamic pose from the reference image. You MUST draw the character in generic, neutral standing poses (A-Pose or T-Pose) across exactly THREE top-level angle containers:
   - \`<g id="view_front">\`
   - \`<g id="view_side_right">\`
   - \`<g id="view_back">\`
   By default, make \`view_front\` visible, and the others \`display="none"\`.
4. **Essential Rigging Only (CRITICAL)**: DO NOT over-rig. You must ONLY group and rig the primary articulating parts of the subject for EACH view. Combine all smaller, non-moving details deeply inside their primary parent groups.
5. **No Flat JPEGs**: Do not embed raster images using <image>. You must draw the subject purely in vector paths (<path>, <circle>, <rect>, etc).
6. **Hidden Overlap Geometry (CRITICAL LAP JOINTS)**: Appendages MUST NOT be floating in the air. This applies to ALL characters. You MUST invent and draw the hidden geometry of the limb that extends *deep inside* its parent body part. NEVER draw a limb that ends abruptly at the visible edge or hovers with white space between the joints.
7. **Visemes and Emotions (CRITICAL)**: Inside the 'head' group of the \`view_front\` and \`view_side_right\` containers, you MUST generate two sub-containers: \`<g id="mouth_visemes">\` and \`<g id="emotions">\`.
   - **Visemes:** You must draw custom mouth shapes for the character: \`#mouth_idle\` (visibility="visible"), \`#mouth_A\` (visibility="hidden"), \`#mouth_E\` (hidden), \`#mouth_I\` (hidden), \`#mouth_O\` (hidden), \`#mouth_U\` (hidden), \`#mouth_M\` (hidden).
   - **Emotions:** You must draw custom eye/brow expressions: \`#emotion_neutral\` (visibility="visible"), \`#emotion_happy\` (hidden), \`#emotion_sad\` (hidden), \`#emotion_angry\` (hidden), \`#emotion_surprised\` (hidden).
   - **Personality Driven:** Explicitly style these mouths and eyes to match the character's 'Personality' string provided in the prompt.
8. **The JSON Rig**: You must define the explicit (x, y) absolute coordinates of the pivot point for *every single animatable bone* you created across ALL views. To avoid naming collisions, ensure bones within views are prefixed uniquely (e.g., \`front_arm_left\`, \`side_arm_left\`).
9. **Interaction Nulls**: Include semantic points for interaction, like "#front_grip_point" or "#side_grip_point".

CRITICAL SHAPE: You must output ONLY a SINGLE valid JSON object matching this exact structure:
\`\`\`json
{
  "svg_data": "<svg viewBox='0 0 1000 1000'>...</svg>",
  "rig_data": {
    "bones": [
      { "id": "front_head", "pivot": { "x": 500, "y": 200 }, "parent": "front_torso" },
      { "id": "side_head", "pivot": { "x": 500, "y": 200 }, "parent": "side_torso" }
    ],
    "interactionNulls": ["front_grip_point"],
    "visemes": ["mouth_idle", "mouth_A", "mouth_E", "mouth_I", "mouth_O", "mouth_U", "mouth_M"],
    "emotions": ["emotion_neutral", "emotion_happy", "emotion_sad", "emotion_angry", "emotion_surprised"]
  }
}
\`\`\`
Do not write any text outside this JSON object. The \`svg_data\` property MUST contain the full vector string properly escaped for JSON.
`;

import { JSDOM } from "jsdom";

export interface DraftsmanResponse {
    data: DraftsmanData;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export async function processDraftsmanPrompt(base64Image: string, entityDescription: string): Promise<DraftsmanResponse> {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: DRAFTSMAN_SYSTEM_PROMPT },
                        { text: `Redraw this entity as an animatable SVG rig: ${entityDescription}` },
                        {
                            inlineData: {
                                data: base64Image.replace(/^data:image\/(png|jpeg);base64,/, ""),
                                mimeType: "image/jpeg"
                            }
                        }
                    ]
                }
            ],
            config: {
                systemInstruction: DRAFTSMAN_SYSTEM_PROMPT,
                temperature: 0.5
            }
        });

        let text = response.text;
        if (!text) {
            throw new Error("Gemini returned an empty response.");
        }

        // Robust extraction: find the first { and last }
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');

        if (firstBrace === -1 || lastBrace === -1) {
            throw new Error("No JSON object found in Gemini response.");
        }

        text = text.substring(firstBrace, lastBrace + 1);

        const data = JSON.parse(text) as DraftsmanData;

        // --- Deterministic Assembler & Filter Pass ---
        try {
            data.svg_data = postProcessSVG(data.svg_data, data.rig_data);
        } catch (postProcessErr) {
            console.error("Warning: Failed to run deterministic post-processing on SVG. Proceeding with raw data.", postProcessErr);
        }

        const usage = {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };

        return { data, usage };

    } catch (error: any) {
        console.error("Draftsman Error:", error);
        throw new Error(error.message || String(error) || "Failed to generate the SVG rig. Please try again.");
    }
}

/**
 * Deterministic Garbage Collection & Snapping Algorithm
 * Runs purely on the server to clean the AI's messy SVG before it hits the database.
 */
function postProcessSVG(rawSvgString: string, rigMap: DraftsmanData["rig_data"]): string {
    // 1. Parse string into a manipulatable DOM tree
    const dom = new JSDOM(rawSvgString, { contentType: "image/svg+xml" });
    const document = dom.window.document;
    const svgElement = document.querySelector("svg");

    if (!svgElement) return rawSvgString; // Failsafe fallback

    // 2. Build explicit Allowlist of acceptable SVG IDs based on mathematical Rig structure
    const validIds = new Set<string>();

    rigMap.bones.forEach(b => validIds.add(b.id));
    rigMap.interactionNulls.forEach(id => validIds.add(id));
    if (rigMap.visemes) rigMap.visemes.forEach(v => validIds.add(v));
    if (rigMap.emotions) rigMap.emotions.forEach(e => validIds.add(e));

    // Always preserve known system buckets (if the AI mistakenly grouped them)
    validIds.add("mouth_visemes");
    validIds.add("emotions");

    // 3. Recursive Garbage Collection
    // Delete any group that is NOT part of the physical Rig structure
    const allGroups = Array.from(svgElement.querySelectorAll("g[id]")) as Element[];
    for (const g of allGroups) {
        const id = g.getAttribute("id");
        if (id && !validIds.has(id)) {
            // Check if it's a structural parent to a valid ID (preventing nested deletion)
            const containsValidChild = Array.from(g.querySelectorAll("[id]")).some((child: Element) => {
                const childId = child.getAttribute("id");
                return childId && validIds.has(childId);
            });

            if (!containsValidChild) {
                console.log(`[Deterministic assembler] Garbage collected unmapped hallucination: #${id}`);
                g.remove();
            }
        }
    }

    // [TODO: Phase 2 will implement Bounding Box transform snapping here]
    // JSDOM does not natively support getBBox() math without a headless browser renderer, 
    // so we will have to push Phase 2 Snapping to the client-side RigViewer on-mount.

    return svgElement.outerHTML;
}
