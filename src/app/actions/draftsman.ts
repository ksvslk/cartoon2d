"use server";

import { GoogleGenAI } from "@google/genai";
import { AnimationKeyframeSchema, DraftsmanData } from "@/lib/schema/rig";
import { z } from "zod";

// Initialize the Gemini client
// Note: In production, ensure process.env.GEMINI_API_KEY is securely stored
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

import { JSDOM } from "jsdom";

export interface DraftsmanResponse {
    data: DraftsmanData;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

const GeneratedClipSchema = z.object({
    view: z.string().optional(),
    keyframes: z.array(AnimationKeyframeSchema).min(1),
});

export interface MotionClipResponse {
    clip: z.infer<typeof GeneratedClipSchema>;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export async function processDraftsmanPrompt(base64Image: string, entityDescription: string, requiredViews: string[] = ['view_front']): Promise<DraftsmanResponse> {
    const requestedViews = Array.from(new Set(requiredViews.length > 0 ? requiredViews : ['view_3q_right']));
    const DRAFTSMAN_SYSTEM_PROMPT = `
You are the Draftsman, an expert SVG vector artist and technical rigger.
Your job is to take a raster character or prop image and perfectly recreate it as a clean, highly-structured, animatable SVG vector file.

CRITICAL REQUIREMENTS:
1. **Resolution Independence**: The output SVG MUST use \`<svg viewBox="0 0 1000 1000">\`. This coordinate space must be strictly adhered to.
2. **Minimalist & Clean 2D Styling**: KEEP IT EXTREMELY SIMPLE. Use clean, minimalist 2D vector shapes with solid flat colors. DO NOT create overly complex, disjointed, blocky, or 3D-like structural rigs. Prioritize visual resemblance over mechanical complexity.
3. **CHARACTER TURNAROUND SHEET — Requested Views Only (CRITICAL)**: You MUST draw the character in a neutral A-Pose ONLY for the requested top-level view containers. Each is an independent, fully-rigged drawing of the same character from a different angle:
   - \`<g id="view_front">\` — Symmetrical frontal view. Both eyes visible, body straight-on. Used for direct dialogue.
   - \`<g id="view_side_right">\` — Pure profile facing RIGHT. One eye visible. Clean silhouette for walk cycles.
   - \`<g id="view_3q_right">\` — 3/4 view, body angled slightly right. Most natural conversational angle. Can be flipped for left-facing.
   - \`<g id="view_top">\` — Flat top-down view. Head at top of body. Used for navigation/spatial scenes.
   - \`<g id="view_back">\` — Symmetrical back view. No face visible. Used for walk-away shots.
   Generate ONLY these requested views: ${requestedViews.join(", ")}.
   Make the first requested view visible by default (\`display="inline"\`), all others \`display="none"\`.
   Each view's bones MUST be prefixed with the view name (e.g. \`front_head\`, \`side_leg_right\`, \`3q_torso\`, \`top_body\`, \`back_torso\`).
4. **Target Views (strict)**: The \`requiredViews\` list defines exactly which view containers you should output. Do NOT generate extra view groups.
5. **Essential Rigging Only (CRITICAL)**: DO NOT over-rig. You must ONLY group and rig the primary articulating parts of the subject for EACH view. Combine all smaller, non-moving details deeply inside their primary parent groups.
6. **No Flat JPEGs**: Do not embed raster images using <image>. You must draw the subject purely in vector paths (<path>, <circle>, <rect>, etc).
7. **Hidden Overlap Geometry (CRITICAL LAP JOINTS)**: Appendages MUST NOT be floating in the air. This applies to ALL characters. You MUST invent and draw the hidden geometry of the limb that extends *deep inside* its parent body part. NEVER draw a limb that ends abruptly at the visible edge or hovers with white space between the joints.
8. **Visemes and Emotions (CRITICAL)**: Inside the 'head' group of ANY view container, you MUST generate two sub-containers: \`<g id="mouth_visemes">\` and \`<g id="emotions">\`.
   - **Visemes:** You must draw custom mouth shapes for the character: \`#mouth_idle\` (visibility="visible"), \`#mouth_A\` (visibility="hidden"), \`#mouth_E\` (hidden), \`#mouth_I\` (hidden), \`#mouth_O\` (hidden), \`#mouth_U\` (hidden), \`#mouth_M\` (hidden).
   - **Emotions:** You must draw custom eye/brow expressions: \`#emotion_neutral\` (visibility="visible"), \`#emotion_happy\` (hidden), \`#emotion_sad\` (hidden), \`#emotion_angry\` (hidden), \`#emotion_surprised\` (hidden).
   - **Personality Driven:** Explicitly style these mouths and eyes to match the character's 'Personality' string provided in the prompt.
   - **Eye placement note:** In the flat-profile head, BOTH eyes are stacked on the right-facing side. Draw them as two separate circles/shapes, one slightly above the other.
9. **The JSON Rig**: You must define the explicit (x, y) absolute coordinates of the pivot point for *every single animatable bone* you created across ALL views. To avoid naming collisions, ensure bones within views are prefixed uniquely based on the view (e.g., \`front_arm_left\`, \`side_arm_left\`).
10. **Interaction Nulls**: Include semantic points for interaction, like "#front_grip_point" or "#side_grip_point".
11. **Animation Clips (LIGHTWEIGHT ONLY)**: Motion clips are compiled later, after the rig is approved. Do NOT spend output budget generating a full motion library here.
    - Include \`rig_data.animation_clips\` as an empty object \`{}\`, OR at most a single tiny \`idle\` clip if it is cheap to emit.
    - Do NOT generate walk/run/jump/wave/etc. in this rigging pass. Those are compiled separately on demand.
    - Prioritize clean SVG structure, correct view drawings, pivots, and bone hierarchy over pre-authored motion data.

CRITICAL SHAPE: You must output ONLY a SINGLE valid JSON object matching this exact structure:
\`\`\`json
{
  "svg_data": "<svg viewBox='0 0 1000 1000'><g id='view_3q_right' display='inline'>...</g><g id='view_front' display='none'>...</g><g id='view_side_right' display='none'>...</g><g id='view_top' display='none'>...</g><g id='view_back' display='none'>...</g></svg>",
  "rig_data": {
    "bones": [
      { "id": "3q_torso",      "pivot": { "x": 500, "y": 520 } },
      { "id": "3q_head",       "pivot": { "x": 500, "y": 290 }, "parent": "3q_torso" },
      { "id": "3q_arm_right",  "pivot": { "x": 590, "y": 340 }, "parent": "3q_torso" },
      { "id": "3q_arm_left",   "pivot": { "x": 410, "y": 340 }, "parent": "3q_torso" },
      { "id": "3q_leg_right",  "pivot": { "x": 540, "y": 660 }, "parent": "3q_torso" },
      { "id": "3q_leg_left",   "pivot": { "x": 460, "y": 660 }, "parent": "3q_torso" },
      { "id": "side_torso",    "pivot": { "x": 500, "y": 520 } },
      { "id": "side_head",     "pivot": { "x": 500, "y": 290 }, "parent": "side_torso" },
      { "id": "side_arm_rear", "pivot": { "x": 420, "y": 340 }, "parent": "side_torso" },
      { "id": "side_arm_fore", "pivot": { "x": 560, "y": 340 }, "parent": "side_torso" },
      { "id": "side_leg_rear", "pivot": { "x": 470, "y": 660 }, "parent": "side_torso" },
      { "id": "side_leg_fore", "pivot": { "x": 530, "y": 660 }, "parent": "side_torso" },
      { "id": "front_torso",   "pivot": { "x": 500, "y": 520 } },
      { "id": "front_head",    "pivot": { "x": 500, "y": 290 }, "parent": "front_torso" },
      { "id": "front_arm_r",   "pivot": { "x": 600, "y": 340 }, "parent": "front_torso" },
      { "id": "front_arm_l",   "pivot": { "x": 400, "y": 340 }, "parent": "front_torso" },
      { "id": "front_leg_r",   "pivot": { "x": 540, "y": 660 }, "parent": "front_torso" },
      { "id": "front_leg_l",   "pivot": { "x": 460, "y": 660 }, "parent": "front_torso" }
    ],
    "interactionNulls": ["3q_grip_point", "side_grip_point"],
    "visemes": ["mouth_idle", "mouth_A", "mouth_E", "mouth_I", "mouth_O", "mouth_U", "mouth_M"],
    "emotions": ["emotion_neutral", "emotion_happy", "emotion_sad", "emotion_angry", "emotion_surprised"],
    "animation_clips": {}
  }
}
\`\`\`
Do not write any text outside this JSON object. The \`svg_data\` property MUST contain the full vector string properly escaped for JSON.
`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: DRAFTSMAN_SYSTEM_PROMPT },
                        { text: `Redraw this entity as an animatable SVG rig: ${entityDescription}\nRequired views: ${requestedViews.join(", ")}` },
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

    } catch (error: unknown) {
        console.error("Draftsman Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || "Failed to generate the SVG rig. Please try again.");
    }
}

export async function generateMotionClipForRig(params: {
    rig: DraftsmanData;
    motion: string;
    style?: string;
    durationSeconds?: number;
    actorName?: string;
    actorDescription?: string;
    sceneNarrative?: string;
}): Promise<MotionClipResponse> {
    const validBoneIds = params.rig.rig_data.bones.map(b => b.id);
    const availableViews = Array.from(new Set(validBoneIds.flatMap(id => {
        if (id.startsWith("front_")) return ["view_front"];
        if (id.startsWith("side_")) return ["view_side_right"];
        if (id.startsWith("3q_")) return ["view_3q_right"];
        if (id.startsWith("top_")) return ["view_top"];
        if (id.startsWith("back_")) return ["view_back"];
        return [];
    })));

    const prompt = `
You are a motion clip compiler for a 2D SVG rig.

Create ONE animation clip JSON object for this requested motion:
- motion: ${params.motion}
- style: ${params.style || "neutral"}
- durationSeconds: ${params.durationSeconds || 2}
- actorName: ${params.actorName || "unknown"}
- actorDescription: ${params.actorDescription || "unknown"}
- sceneNarrative: ${params.sceneNarrative || "none"}

Rules:
1. Output ONLY JSON.
2. Use ONLY these exact bone IDs: ${validBoneIds.join(", ")}.
3. Choose one view from: ${availableViews.join(", ")}.
4. The motion must visually match the requested action, not degrade to generic idle unless the request is truly idle-like.
5. Prefer looping motion for locomotion or cyclic actions.
6. Use tail/body sway, fins, wings, wheels, arms, torso, head, and body squash/stretch when appropriate.
7. Keep it simple, readable, and physically plausible.
8. Do not reference bones that do not exist.

JSON shape:
{
  "view": "view_side_right",
  "keyframes": [
    { "bone": "side_torso", "prop": "rotation", "to": 8, "duration": 0.4, "yoyo": true, "repeat": -1, "ease": "sine.inOut" }
  ]
}
`;

    const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            temperature: 0.3,
        }
    });

    let text = response.text;
    if (!text) {
        throw new Error("Gemini returned an empty motion clip response.");
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error("No JSON clip object found in Gemini response.");
    }

    text = text.substring(firstBrace, lastBrace + 1);
    const parsed = GeneratedClipSchema.parse(JSON.parse(text));

    const validBones = new Set(validBoneIds);
    const sanitized = {
        view: parsed.view,
        keyframes: parsed.keyframes.filter(k => validBones.has(k.bone)),
    };

    if (sanitized.keyframes.length === 0) {
        throw new Error(`Motion clip generation for "${params.motion}" returned no valid keyframes.`);
    }

    return {
        clip: sanitized,
        usage: {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        }
    };
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
