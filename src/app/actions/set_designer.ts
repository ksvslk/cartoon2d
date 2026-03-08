"use server";

import { GoogleGenAI } from "@google/genai";
import { DraftsmanData } from "@/lib/schema/rig";
import { JSDOM } from "jsdom";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SET_DESIGNER_SYSTEM_PROMPT = `
You are the Set Designer, an expert SVG vector artist and environment technical director.
Your job is to take a raster comic panel image and extract ONLY its background environment, perfectly recreating it as a clean, highly-structured, parallax-ready SVG vector file.

CRITICAL REQUIREMENTS:
1. **Resolution Independence**: The output SVG MUST use \`<svg viewBox="0 0 1000 1000">\`.
2. **Scenery Only**: Ignore all active characters/actors in the reference image. Draw ONLY the environment they are standing in (e.g., the room, the street, the forest).
3. **Flat 2D Styling**: Use clean, minimalist vector shapes with solid flat colors. DO NOT create complex gradients, noise, or photorealistic textures.
4. **Mandatory Parallax Hierarchy**: You MUST structure the entire environment into exactly three top-level container groups for depth sorting:
   - \`<g id="bg_sky">\`: Furthest elements (sky, distant mountains, solid backdrop colors)
   - \`<g id="bg_midground">\`: The main stage (buildings, walls, distant trees)
   - \`<g id="bg_foreground">\`: Elements visually closest to the camera (the floor they walk on, objects overlapping the lower camera frame)
5. **No Flat JPEGs**: Do not embed raster images using <image>. Pure vector paths only.
6. **Interaction Nulls (Props)**: If there are crucial semantic objects in the background a character might sit on or touch (e.g., a chair, a steering wheel, a door handle), you must wrap their shape in a uniquely ID'd group (e.g., \`<g id="prop_chair">\`) and log that ID in the \`interactionNulls\` array in the JSON. You MUST also provide the exact (x, y) absolute coordinates of that prop's interactive anchor point in the \`bones\` array.
7. **Complete Scene**: Ensure the background is fully drawn top-to-bottom within the 1000x1000 box. Do not leave blank white void where the characters used to stand. Fill in the missing ground/walls behind them.

CRITICAL SHAPE: You must output ONLY a SINGLE valid JSON object matching this exact structure:
\`\`\`json
{
  "svg_data": "<svg viewBox='0 0 1000 1000'>...</svg>",
  "rig_data": {
    "bones": [
      { "id": "prop_chair", "pivot": { "x": 500, "y": 800 } }
    ],
    "interactionNulls": ["prop_chair"]
  }
}
\`\`\`
Do not write any text outside this JSON object.
`;

export interface SetDesignerResponse {
    data: DraftsmanData;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export async function processSetDesignerPrompt(base64Image: string, sceneNarrative: string): Promise<SetDesignerResponse> {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: SET_DESIGNER_SYSTEM_PROMPT },
                        { text: `Redraw the background environment described here as a parallax SVG: ${sceneNarrative}` },
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
                systemInstruction: SET_DESIGNER_SYSTEM_PROMPT,
                temperature: 0.5
            }
        });

        let text = response.text;
        if (!text) {
            throw new Error("Gemini returned an empty response.");
        }

        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');

        if (firstBrace === -1 || lastBrace === -1) {
            throw new Error("No JSON object found in Gemini response.");
        }

        text = text.substring(firstBrace, lastBrace + 1);

        const data = JSON.parse(text) as DraftsmanData;

        // --- Deterministic Filter Pass ---
        try {
            data.svg_data = postProcessBackgroundSVG(data.svg_data, data.rig_data);
        } catch (postProcessErr) {
            console.error("Warning: Failed to run post-processing on SVG. Proceeding with raw data.", postProcessErr);
        }

        const usage = {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };

        return { data, usage };

    } catch (error: any) {
        console.error("Set Designer Error:", error);
        throw new Error(error.message || String(error) || "Failed to generate the background SVG. Please try again.");
    }
}

/**
 * Deterministic Background Assembler
 * Guarantees the SVG perfectly adheres to the 3-layer parallax structure,
 * rescuing any stray shapes the AI drew outside the layers by moving them
 * into the midground, ensuring z-indexing is flawless.
 */
function postProcessBackgroundSVG(rawSvgString: string, rigMap: DraftsmanData["rig_data"]): string {
    const dom = new JSDOM(rawSvgString, { contentType: "image/svg+xml" });
    const document = dom.window.document;
    const svgElement = document.querySelector("svg");

    if (!svgElement) return rawSvgString;

    // 1. Enforce ViewBox
    if (!svgElement.hasAttribute("viewBox")) {
        svgElement.setAttribute("viewBox", "0 0 1000 1000");
    }

    // 2. Identify or Create the 3 mandatory layers
    const layerIds = ["bg_sky", "bg_midground", "bg_foreground"];
    const layers: Record<string, Element> = {};

    layerIds.forEach(id => {
        // Find it anywhere in the document (even if AI nested it inside a random group)
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement("g");
            el.setAttribute("id", id);
        }
        layers[id] = el;
    });

    // 3. Gather all original direct children of SVG
    const directChildren = Array.from(svgElement.children);
    
    // 4. Clear the SVG and re-append in exact order to guarantee z-indexing
    svgElement.innerHTML = "";
    
    // Re-append defs if they exist
    directChildren.forEach(child => {
        if (child.tagName.toLowerCase() === 'defs') {
            svgElement.appendChild(child);
        }
    });

    // Append the 3 layers in correct back-to-front order
    layerIds.forEach(id => {
        svgElement.appendChild(layers[id]);
    });

    // 5. Rescue stray elements
    // Any element that was a direct child, is not a <defs>, and is not one of our 3 layers
    // gets dumped into bg_midground so it isn't lost but doesn't break the top-level structure.
    // E.g., if AI drew a <rect> background directly on the SVG, it goes to midground.
    directChildren.forEach(child => {
        const id = child.getAttribute("id");
        if (child.tagName.toLowerCase() !== 'defs' && (!id || !layerIds.includes(id))) {
            layers["bg_midground"].appendChild(child);
        }
    });

    // 6. Graceful Garbage Collection for Props
    // If the AI grouped something with "prop_" but didn't map it in rigMap,
    // we don't want to delete the drawing (it might be a nice visual tree), 
    // but we strip the ID so it isn't accidentally treated as an interactive anchor.
    const validProps = new Set([...rigMap.bones.map(b => b.id), ...rigMap.interactionNulls]);
    const allGroups = Array.from(svgElement.querySelectorAll("g[id]"));
    allGroups.forEach(g => {
        const id = g.getAttribute("id");
        if (id && id.startsWith("prop_") && !validProps.has(id)) {
            g.removeAttribute("id"); 
            console.log(`[Set Designer] Stripped unmapped prop ID: #${id}`);
        }
    });

    return svgElement.outerHTML;
}
