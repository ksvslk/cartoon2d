"use server";

import { GoogleGenAI } from "@google/genai";
import {
    DraftsmanData,
    RigBoneContactRole,
    RigBoneKind,
    RigBoneMassClass,
    RigMotionClip,
    RigBoneSide,
    RigRepairReport
} from "@/lib/schema/rig";
import { MotionSpec, MotionSpecSchema } from "@/lib/schema/motion_spec";
import { inferMotionSpecForRig } from "@/lib/motion/spec";
import { buildMotionIntentFromSpec } from "@/lib/motion/intent";
import { validateRigForMotion } from "@/lib/motion/validation";
import { ensureRigIK } from "@/lib/ik/graph";

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

export interface MotionClipResponse {
    clip: NonNullable<DraftsmanData["rig_data"]["motion_clips"]>[string];
    stabilization?: MotionCompilationReport;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export interface MotionCompilationReport {
    stabilized: boolean;
    refinedChains: number;
    chainIds: string[];
    suppressedKeyframes: number;
    validationWarnings: string[];
}

export interface MotionSpecResponse {
    spec: MotionSpec;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

function buildCanonicalMotionClipFromSpec(params: {
    rig: DraftsmanData;
    motion: string;
    durationSeconds: number;
    motionSpec: MotionSpec;
}): RigMotionClip {
    return {
        view: params.motionSpec.preferredView || params.rig.rig_data.ik?.defaultView || Object.keys(params.rig.rig_data.ik?.views || {}).sort()[0],
        intent: buildMotionIntentFromSpec({
            rig: params.rig,
            motion: params.motion,
            durationSeconds: params.durationSeconds,
            motionSpec: params.motionSpec,
        }),
        displayKeyframes: [],
    };
}

function inferStructuralBoneKind(parentId: string | undefined, childCount: number): RigBoneKind {
    if (!parentId) return "root";
    if (childCount > 0) return "body";
    return "other";
}

function inferStructuralBoneSide(box: Box, referenceX = 500): RigBoneSide {
    const centerX = (box.minX + box.maxX) * 0.5;
    if (centerX < referenceX - 8) return "left";
    if (centerX > referenceX + 8) return "right";
    return "center";
}

function inferStructuralContactRole(): RigBoneContactRole {
    return "none";
}

function inferStructuralMassClass(parentId: string | undefined, childCount: number): RigBoneMassClass {
    if (!parentId || childCount > 1) return "heavy";
    if (childCount > 0) return "medium";
    return "light";
}

function usableRotationLimit(limit?: [number, number], ratio = 0.8): [number, number] | undefined {
    if (!limit) return undefined;
    const mid = (limit[0] + limit[1]) * 0.5;
    const halfSpan = Math.abs(limit[1] - limit[0]) * 0.5;
    const insetHalf = Math.max(halfSpan * ratio, Math.min(halfSpan, 2));

    if (!Number.isFinite(insetHalf) || insetHalf <= 0) {
        return limit;
    }

    return [
        round2(mid - insetHalf),
        round2(mid + insetHalf),
    ];
}

function buildIKPromptContext(rig: DraftsmanData) {
    const normalizedRig = ensureRigIK(rig);
    const ik = normalizedRig.rig_data.ik;
    const childCountByNode = new Map<string, number>();
    (ik?.nodes || []).forEach((node) => childCountByNode.set(node.id, 0));
    (ik?.nodes || []).forEach((node) => {
        if (!node.parent) return;
        childCountByNode.set(node.parent, (childCountByNode.get(node.parent) || 0) + 1);
    });
    const depthByNode = new Map<string, number>();
    const computeDepth = (nodeId: string): number => {
        const cached = depthByNode.get(nodeId);
        if (cached !== undefined) return cached;
        const node = ik?.nodes.find((candidate) => candidate.id === nodeId);
        const depth = node?.parent ? computeDepth(node.parent) + 1 : 0;
        depthByNode.set(nodeId, depth);
        return depth;
    };

    const nodeLookup = new Map<string, {
        nodeId: string;
        parent?: string;
        ikRole?: string;
        rotationLimit?: [number, number];
        usableRotationLimit?: [number, number];
        preferredBend?: number;
    }>();

    ik?.nodes.forEach((node) => {
        const entry = {
            nodeId: node.id,
            parent: node.parent,
            ikRole: node.ikRole,
            rotationLimit: node.rotationLimit as [number, number] | undefined,
            usableRotationLimit: usableRotationLimit(node.rotationLimit as [number, number] | undefined),
            preferredBend: node.preferredBend,
        };

        (node.sourceBoneIds || []).forEach((boneId) => {
            nodeLookup.set(boneId, entry);
        });
    });

    Object.values(ik?.views || {}).forEach((view) => {
        view.bindings.forEach((binding) => {
            const node = ik?.nodes.find((candidate) => candidate.id === binding.nodeId);
            if (!node) return;
            nodeLookup.set(binding.boneId, {
                nodeId: node.id,
                parent: node.parent,
                ikRole: node.ikRole,
                rotationLimit: node.rotationLimit as [number, number] | undefined,
                usableRotationLimit: usableRotationLimit(node.rotationLimit as [number, number] | undefined),
                preferredBend: node.preferredBend,
            });
        });
    });

    const ikNodeSummary = (ik?.nodes || []).map((node) => ({
        id: node.id,
        parent: node.parent,
        topologyRole: !node.parent ? "root" : (childCountByNode.get(node.id) || 0) > 0 ? "internal" : "terminal",
        depth: computeDepth(node.id),
        childCount: childCountByNode.get(node.id) || 0,
        ikRole: node.ikRole,
        rotationLimit: node.rotationLimit,
        usableRotationLimit: usableRotationLimit(node.rotationLimit as [number, number] | undefined),
        contactRole: node.contactRole,
        massClass: node.massClass,
        preferredBend: node.preferredBend,
        sourceBoneIds: (node.sourceBoneIds || []).slice(0, 4),
    }));

    const ikConstraintSummary = (ik?.constraints || [])
        .filter((constraint) => constraint.type === "angle_limit" || constraint.type === "pin")
        .map((constraint) => {
            if (constraint.type === "angle_limit") {
                return {
                    type: constraint.type,
                    nodeId: constraint.nodeId,
                    min: constraint.min,
                    max: constraint.max,
                    usable: usableRotationLimit([constraint.min, constraint.max]),
                    preferred: constraint.preferred,
                };
            }
                return {
                    type: constraint.type,
                    nodeId: constraint.nodeId,
                enabled: constraint.enabled,
                x: constraint.x,
                y: constraint.y,
            };
        });

    return { normalizedRig, nodeLookup, ikNodeSummary, ikConstraintSummary };
}

function buildMotionBoneSummary(
    rig: DraftsmanData,
    nodeLookup: Map<string, {
        nodeId: string;
        parent?: string;
        ikRole?: string;
        rotationLimit?: [number, number];
        usableRotationLimit?: [number, number];
        preferredBend?: number;
    }>,
) {
    const parentByBone = new Map(rig.rig_data.bones.map((bone) => [bone.id, bone.parent]));
    const childCountByBone = new Map<string, number>();
    rig.rig_data.bones.forEach((bone) => childCountByBone.set(bone.id, 0));
    rig.rig_data.bones.forEach((bone) => {
        if (!bone.parent) return;
        childCountByBone.set(bone.parent, (childCountByBone.get(bone.parent) || 0) + 1);
    });
    const depthByBone = new Map<string, number>();
    const computeDepth = (boneId: string): number => {
        const cached = depthByBone.get(boneId);
        if (cached !== undefined) return cached;
        const parentId = parentByBone.get(boneId);
        const depth = parentId ? computeDepth(parentId) + 1 : 0;
        depthByBone.set(boneId, depth);
        return depth;
    };

    return rig.rig_data.bones.map((bone) => {
        const childCount = childCountByBone.get(bone.id) || 0;
        return {
            id: bone.id,
            parent: bone.parent,
            topologyRole: !bone.parent ? "root" : childCount > 0 ? (childCount > 1 ? "branch" : "internal") : "terminal",
            depth: computeDepth(bone.id),
            childCount,
            contactRole: bone.contactRole || "none",
            massClass: bone.massClass || "medium",
            canonicalNodeId: nodeLookup.get(bone.id)?.nodeId,
            ikRole: nodeLookup.get(bone.id)?.ikRole,
            rotationLimit: nodeLookup.get(bone.id)?.rotationLimit || bone.rotationLimit,
            usableRotationLimit: nodeLookup.get(bone.id)?.usableRotationLimit || usableRotationLimit((nodeLookup.get(bone.id)?.rotationLimit || bone.rotationLimit) as [number, number] | undefined),
            preferredBend: nodeLookup.get(bone.id)?.preferredBend,
        };
    });
}

export async function processDraftsmanPrompt(base64Image: string, entityDescription: string, requiredViews: string[] = ['view_front']): Promise<DraftsmanResponse> {
    const requestedViews = Array.from(new Set(requiredViews.length > 0 ? requiredViews : ['view_3q_right']));
    const DRAFTSMAN_SYSTEM_PROMPT = `
You are the Draftsman, an expert SVG vector artist and technical rigger.
Your job is to take a raster subject image and recreate it as a clean, highly-structured, animatable SVG vector file.

CRITICAL REQUIREMENTS:
1. **Resolution Independence**: The output SVG MUST use \`<svg viewBox="0 0 1000 1000">\`. This coordinate space must be strictly adhered to.
2. **Minimalist & Clean 2D Styling**: KEEP IT EXTREMELY SIMPLE. Use clean, minimalist 2D vector shapes with solid flat colors. DO NOT create overly complex, disjointed, blocky, or 3D-like structural rigs. Prioritize visual resemblance over mechanical complexity.
3. **SUBJECT TURNAROUND SHEET — Requested Views Only (CRITICAL)**: You MUST draw the subject in a neutral rest pose ONLY for the requested top-level view containers. Each is an independent, fully-rigged drawing of the same subject from a different angle:
   - \`<g id="view_front">\` — Front-facing or most symmetrical front view.
   - \`<g id="view_side_right">\` — Clean right-facing profile or closest rightward side view.
   - \`<g id="view_3q_right">\` — Natural 3/4 right-facing view when applicable.
   - \`<g id="view_top">\` — Top-down or plan view when applicable.
   - \`<g id="view_back">\` — Back-facing or rear view when applicable.
   Generate ONLY these requested views: ${requestedViews.join(", ")}.
   Make the first requested view visible by default (\`display="inline"\`), all others \`display="none"\`.
   Each view's bones MUST be prefixed with the view name (e.g. \`front_core\`, \`side_segment_a\`, \`3q_branch_right\`, \`top_root\`, \`back_core\`).
4. **Target Views (strict)**: The \`requiredViews\` list defines exactly which view containers you should output. Do NOT generate extra view groups.
5. **Essential Rigging Only (CRITICAL)**: DO NOT over-rig. You must ONLY group and rig the dominant articulating masses and continuous branches of the subject for EACH view. Combine smaller non-moving details deeply inside their primary parent groups.
6. **No Flat JPEGs**: Do not embed raster images using <image>. You must draw the subject purely in vector paths (<path>, <circle>, <rect>, etc).
7. **Hidden Overlap Geometry (CRITICAL JOINTS)**: Child segments MUST NOT float away from their parents. Extend hidden overlap geometry inside the parent mass so connected parts look physically attached instead of cut off at the silhouette edge.
8. **Rounded Attachment Ends (CRITICAL)**: Any child shape that joins a parent should end with rounded, tapered, or capsule-like geometry at the attachment. Avoid hard flat cutoffs. Prefer circles, ovals, and curved caps at connection points so deformation stays readable during rotation.
9. **Preserve Major Silhouette Features**: Never omit any silhouette-defining extension, branch, protrusion, or contour break visible in the reference image. If the source image clearly shows a distinct shape, it must remain readable in the SVG.
10. **Visemes and Emotions (CRITICAL)**: If the subject has a face-like or front-facing expressive region, place two sub-containers there: \`<g id="mouth_visemes">\` and \`<g id="emotions">\`. If the subject is not expressive, still include minimal placeholder groups in the most relevant front-facing parent group so downstream tools stay consistent.
   - **Visemes:** Include \`#mouth_idle\` (visibility="visible"), \`#mouth_A\` (visibility="hidden"), \`#mouth_E\` (hidden), \`#mouth_I\` (hidden), \`#mouth_O\` (hidden), \`#mouth_U\` (hidden), \`#mouth_M\` (hidden).
   - **Emotions:** Include \`#emotion_neutral\` (visibility="visible"), \`#emotion_happy\` (hidden), \`#emotion_sad\` (hidden), \`#emotion_angry\` (hidden), \`#emotion_surprised\` (hidden).
   - **Styling:** When expressive features exist, style them to match the subject personality. When they do not, keep them minimal and unobtrusive.
11. **The JSON Rig**: You must define the explicit (x, y) absolute coordinates of the pivot point for *every single animatable bone* you created across ALL views. To avoid naming collisions, ensure bones within views are prefixed uniquely based on the view (e.g., \`front_core_a\`, \`side_branch_left\`).
12. **Semantic Bone Metadata (CRITICAL)**: For each bone, include semantic metadata so deterministic motion synthesis can reason about the rig without guessing. Add these fields whenever possible:
   - \`kind\`: one of \`root\`, \`torso\`, \`body\`, \`neck\`, \`head\`, \`jaw\`, \`arm_upper\`, \`arm_lower\`, \`hand\`, \`leg_upper\`, \`leg_lower\`, \`foot\`, \`tail_base\`, \`tail_mid\`, \`tail_tip\`, \`fin\`, \`wing\`, \`other\`
   - \`side\`: \`left\`, \`right\`, or \`center\`
   - \`length\`: approximate segment length in SVG units
   - \`socket\`: preferred attachment/socket point within the parent
   - \`contactRole\`: \`none\`, \`ground\`, \`wall\`, \`water\`, or \`grip\`
   - \`massClass\`: \`light\`, \`medium\`, or \`heavy\`
13. **Interaction Nulls**: Include semantic points for interaction, like "#front_grip_point" or "#side_grip_point".
14. **Animation Clips (LIGHTWEIGHT ONLY)**: Motion clips are compiled later, after the rig is approved. Do NOT spend output budget generating a full motion library here.
    - Include \`rig_data.motion_clips\` as an empty object \`{}\`.
    - Do NOT generate walk/run/jump/wave/etc. in this rigging pass. Those are compiled separately on demand.
    - Prioritize clean SVG structure, correct view drawings, pivots, and bone hierarchy over pre-authored motion data.

CRITICAL SHAPE: You must output ONLY a SINGLE valid JSON object matching this exact structure:
\`\`\`json
{
  "svg_data": "<svg viewBox='0 0 1000 1000'><g id='view_3q_right' display='inline'>...</g><g id='view_front' display='none'>...</g><g id='view_side_right' display='none'>...</g><g id='view_top' display='none'>...</g><g id='view_back' display='none'>...</g></svg>",
  "rig_data": {
    "bones": [
      { "id": "3q_root",         "pivot": { "x": 500, "y": 520 }, "kind": "root", "side": "center", "massClass": "heavy" },
      { "id": "3q_core_front",   "pivot": { "x": 560, "y": 500 }, "parent": "3q_root", "kind": "body", "side": "right", "massClass": "medium" },
      { "id": "3q_core_rear",    "pivot": { "x": 430, "y": 540 }, "parent": "3q_root", "kind": "body", "side": "left", "massClass": "medium" },
      { "id": "3q_branch_upper", "pivot": { "x": 520, "y": 360 }, "parent": "3q_root", "kind": "other", "side": "center", "massClass": "light" },
      { "id": "3q_branch_lower", "pivot": { "x": 480, "y": 670 }, "parent": "3q_root", "kind": "other", "side": "center", "contactRole": "ground", "massClass": "light" },
      { "id": "side_root",       "pivot": { "x": 500, "y": 520 }, "kind": "root", "side": "center", "massClass": "heavy" },
      { "id": "side_core_a",     "pivot": { "x": 560, "y": 500 }, "parent": "side_root", "kind": "body", "side": "right", "massClass": "medium" },
      { "id": "side_branch_a",   "pivot": { "x": 450, "y": 360 }, "parent": "side_root", "kind": "other", "side": "left", "massClass": "light" },
      { "id": "front_root",      "pivot": { "x": 500, "y": 520 }, "kind": "root", "side": "center", "massClass": "heavy" },
      { "id": "front_branch_l",  "pivot": { "x": 420, "y": 500 }, "parent": "front_root", "kind": "other", "side": "left", "massClass": "light" },
      { "id": "front_branch_r",  "pivot": { "x": 580, "y": 500 }, "parent": "front_root", "kind": "other", "side": "right", "massClass": "light" }
    ],
    "interactionNulls": ["3q_anchor_point", "side_anchor_point"],
    "visemes": ["mouth_idle", "mouth_A", "mouth_E", "mouth_I", "mouth_O", "mouth_U", "mouth_M"],
    "emotions": ["emotion_neutral", "emotion_happy", "emotion_sad", "emotion_angry", "emotion_surprised"],
    "motion_clips": {}
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
        const normalizedData = normalizeRigHierarchy(data);

        const usage = {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };

        return { data: normalizedData, usage };

    } catch (error: unknown) {
        console.error("Draftsman Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || "Failed to generate the SVG rig. Please try again.");
    }
}

export async function repairDraftedRig(data: DraftsmanData): Promise<DraftsmanData> {
    try {
        return postProcessAndRepairSVG(data.svg_data, data.rig_data);
    } catch (error: unknown) {
        console.error("Rig repair error:", error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || "Failed to repair the rig.");
    }
}

function normalizeRigHierarchy(data: DraftsmanData): DraftsmanData {
    try {
        const dom = new JSDOM(data.svg_data, { contentType: "image/svg+xml" });
        const document = dom.window.document;
        const svgElement = document.querySelector("svg");
        if (!svgElement) return ensureRigIK(data);

        const isDescendantOf = (child: Element, parent: Element) => {
            let cursor: Element | null = child.parentElement;
            while (cursor) {
                if (cursor === parent) return true;
                cursor = cursor.parentElement;
            }
            return false;
        };

        const allBones = [...data.rig_data.bones];
        const parentMap = new Map(allBones.map((bone) => [bone.id, bone.parent]));

        const depthOf = (boneId: string, seen = new Set<string>()): number => {
            if (seen.has(boneId)) return 0;
            seen.add(boneId);
            const parentId = parentMap.get(boneId);
            if (!parentId) return 0;
            return 1 + depthOf(parentId, seen);
        };

        const bonesByDepth = [...allBones].sort((a, b) => depthOf(a.id) - depthOf(b.id));

        bonesByDepth.forEach((bone) => {
            if (!bone.parent) return;
            const childEl = svgElement.querySelector(`g[id="${bone.id}"]`) as Element | null;
            const parentEl = svgElement.querySelector(`g[id="${bone.parent}"]`) as Element | null;
            if (!childEl || !parentEl) return;
            if (childEl === parentEl) return;
            if (isDescendantOf(childEl, parentEl)) return;

            parentEl.appendChild(childEl);
        });

        return ensureRigIK({
            ...data,
            svg_data: svgElement.outerHTML,
        });
    } catch (error) {
        console.error("Rig hierarchy normalization failed:", error);
        return ensureRigIK(data);
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
    const { normalizedRig } = buildIKPromptContext(params.rig);
    const structuredSpecResult = await generateMotionSpecForRig({
        rig: normalizedRig,
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
        actorName: params.actorName,
        actorDescription: params.actorDescription,
        sceneNarrative: params.sceneNarrative,
    });
    const inferredSpec = inferMotionSpecForRig({
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
        rig: normalizedRig,
    });
    const motionSpec = MotionSpecSchema.parse({
        ...inferredSpec,
        ...structuredSpecResult.spec,
    });
    if (motionSpec.blockedReasons?.length) {
        throw new Error(motionSpec.blockedReasons.join(" "));
    }

    const preflight = validateRigForMotion({
        rig: normalizedRig,
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
    });
    if (!preflight.ok) {
        throw new Error(preflight.errors.join(" "));
    }

    const motionClip = buildCanonicalMotionClipFromSpec({
        rig: normalizedRig,
        motion: params.motion,
        durationSeconds: params.durationSeconds || 2,
        motionSpec,
    });

    const postflight = validateRigForMotion({
        rig: normalizedRig,
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
        motionClip,
    });
    if (!postflight.ok) {
        throw new Error(postflight.errors.join(" "));
    }

    return {
        clip: motionClip,
        stabilization: {
            validationWarnings: [
                "Canonical motion clip synthesized directly from structured motion spec.",
                ...(motionSpec.notes ? [`Motion spec: ${motionSpec.notes}`] : []),
                ...preflight.warnings,
                ...postflight.warnings,
            ].filter((warning, index, all) => all.indexOf(warning) === index),
            stabilized: true,
            refinedChains: 0,
            chainIds: [],
            suppressedKeyframes: 0,
        },
        usage: structuredSpecResult.usage,
    };
}

export async function generateMotionSpecForRig(params: {
    rig: DraftsmanData;
    motion: string;
    style?: string;
    durationSeconds?: number;
    actorName?: string;
    actorDescription?: string;
    sceneNarrative?: string;
}): Promise<MotionSpecResponse> {
    const { normalizedRig, nodeLookup, ikNodeSummary, ikConstraintSummary } = buildIKPromptContext(params.rig);
    const boneSummary = buildMotionBoneSummary(normalizedRig, nodeLookup);
    const availableViews = Object.keys(normalizedRig.rig_data.ik?.views || {}).sort();

    const prompt = `
You are a semantic motion planner for a deterministic 2D animation engine.

Return ONE JSON motion spec describing intent only, not final keyframes.

Motion request:
- motion: ${params.motion}
- style: ${params.style || "neutral"}
- durationSeconds: ${params.durationSeconds || 2}
- actorName: ${params.actorName || "unknown"}
- actorDescription: ${params.actorDescription || "unknown"}
- sceneNarrative: ${params.sceneNarrative || "none"}

Available rig bones and topology:
${JSON.stringify(boneSummary, null, 2)}

Canonical IK nodes and limits:
${JSON.stringify(ikNodeSummary, null, 2)}

Active hard constraints:
${JSON.stringify(ikConstraintSummary, null, 2)}

Rules:
1. Output ONLY JSON.
2. Use motionFamily values that are broad and reusable, not overly specific prose.
3. leadBones must reference exact bone IDs from the list.
4. contacts must only reference exact bone IDs from the list.
5. preferredView must be one of: ${availableViews.join(", ") || "view_default"}.
6. Choose locomotion.mode based on the requested action.
7. Keep the spec concise and physically plausible.
8. Prefer lead bones that sit on the rig's dominant continuous chains, roots, or branch endpoints.
9. Stay comfortably inside usableRotationLimit where present. Treat rotationLimit as a hard stop, not a target.
10. If the requested action cannot be satisfied safely, return blockedReasons with concise human-readable reasons instead of forcing the motion.

JSON shape:
{
  "motionFamily": "swim",
  "tempo": 0.9,
  "amplitude": 0.8,
  "intensity": 0.5,
  "preferredView": "view_side_right",
  "locomotion": { "mode": "translate", "preferredDirection": "right" },
  "contacts": [{ "boneId": "segment_03", "target": "wall", "phaseStart": 0, "phaseEnd": 1 }],
  "leadBones": ["segment_00", "segment_03"],
  "blockedReasons": [],
  "notes": "Continuous chain-led loop with modest branch motion."
}
`;

    const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            temperature: 0.2,
        }
    });

    let text = response.text;
    if (!text) {
        throw new Error("Gemini returned an empty motion spec response.");
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error("No JSON motion spec found in Gemini response.");
    }

    text = text.substring(firstBrace, lastBrace + 1);
    const parsed = MotionSpecSchema.parse(JSON.parse(text));

    return {
        spec: parsed,
        usage: {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        }
    };
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Point = { x: number; y: number };
type SimpleTransform = { tx: number; ty: number; sx: number; sy: number };

function postProcessAndRepairSVG(rawSvgString: string, rigMap: DraftsmanData["rig_data"]): { svg_data: string; rig_data: DraftsmanData["rig_data"] } {
    // 1. Parse string into a manipulatable DOM tree
    const dom = new JSDOM(rawSvgString, { contentType: "image/svg+xml" });
    const document = dom.window.document;
    const svgElement = document.querySelector("svg");

    if (!svgElement) return { svg_data: rawSvgString, rig_data: rigMap }; // Failsafe fallback

    const repairedRig = JSON.parse(JSON.stringify(rigMap)) as DraftsmanData["rig_data"];
    const fixes: string[] = [];
    const warnings: string[] = [];

    // 2. Build explicit Allowlist of acceptable SVG IDs based on mathematical Rig structure
    const validIds = new Set<string>();

    repairedRig.bones.forEach(b => validIds.add(b.id));
    repairedRig.interactionNulls.forEach(id => validIds.add(id));
    if (repairedRig.visemes) repairedRig.visemes.forEach(v => validIds.add(v));
    if (repairedRig.emotions) repairedRig.emotions.forEach(e => validIds.add(e));

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

    // 4. Deterministic geometry repair pass
    const childrenByParent = new Map<string, string[]>();
    repairedRig.bones.forEach((bone) => {
        if (!bone.parent) return;
        const list = childrenByParent.get(bone.parent) || [];
        list.push(bone.id);
        childrenByParent.set(bone.parent, list);
    });

    const getDescendantIds = (boneId: string): string[] => {
        const descendants: string[] = [];
        const queue = [...(childrenByParent.get(boneId) || [])];
        while (queue.length > 0) {
            const next = queue.shift()!;
            descendants.push(next);
            queue.push(...(childrenByParent.get(next) || []));
        }
        return descendants;
    };

    const boneMap = () => new Map(repairedRig.bones.map((bone) => [bone.id, bone]));
    let currentBoneMap = boneMap();
    let elementBoxes = collectElementBoxes(svgElement);

    for (const bone of repairedRig.bones) {
        const element = svgElement.querySelector(`g[id="${bone.id}"]`) as Element | null;
        const box = elementBoxes.get(bone.id);
        const parent = bone.parent ? currentBoneMap.get(bone.parent) : undefined;

        if (!box) {
            warnings.push(`No measurable geometry found for #${bone.id}.`);
            continue;
        }

        if (bone.parent && parent?.pivot && element) {
            const nearestSocket = nearestPointOnBox(box, parent.pivot);
            const detachment = distanceBetween(nearestSocket, parent.pivot);
            const threshold = Math.max(18, Math.min(120, Math.max(boxWidth(box), boxHeight(box)) * 0.2));

            if (detachment > threshold) {
                const dx = round2(parent.pivot.x - nearestSocket.x);
                const dy = round2(parent.pivot.y - nearestSocket.y);
                appendTranslate(element, dx, dy);

                const movedIds = [bone.id, ...getDescendantIds(bone.id)];
                repairedRig.bones = repairedRig.bones.map((candidate) => (
                    movedIds.includes(candidate.id) && candidate.pivot
                        ? { ...candidate, pivot: { x: round2(candidate.pivot.x + dx), y: round2(candidate.pivot.y + dy) } }
                        : candidate
                ));

                fixes.push(`Snapped #${bone.id} to parent socket #${bone.parent} (${Math.round(dx)}, ${Math.round(dy)}).`);
                currentBoneMap = boneMap();
                elementBoxes = collectElementBoxes(svgElement);
            }
        }
    }

    currentBoneMap = boneMap();
    elementBoxes = collectElementBoxes(svgElement);

    repairedRig.bones = repairedRig.bones.map((bone) => {
        const box = elementBoxes.get(bone.id);
        if (!box) return bone;

        const parent = bone.parent ? currentBoneMap.get(bone.parent) : undefined;
        const fallbackPivot = parent?.pivot
            ? nearestPointOnBox(box, parent.pivot)
            : defaultPivotForBox(box);

        if (!bone.pivot) {
            fixes.push(`Created missing pivot for #${bone.id}.`);
            return { ...bone, pivot: { x: round2(fallbackPivot.x), y: round2(fallbackPivot.y) } };
        }

        const margin = Math.max(16, Math.min(100, Math.max(boxWidth(box), boxHeight(box)) * 0.12));
        if (!containsPoint(box, bone.pivot, margin)) {
            fixes.push(`Relocated out-of-bounds pivot for #${bone.id}.`);
            return { ...bone, pivot: { x: round2(fallbackPivot.x), y: round2(fallbackPivot.y) } };
        }

        return bone;
    }).map((bone) => (
        bone.rotationLimit
            ? bone
            : { ...bone, rotationLimit: defaultRotationLimitForBone(bone.parent, (childrenByParent.get(bone.id) || []).length) }
    )).map((bone) => {
        const box = elementBoxes.get(bone.id);
        const childCount = (childrenByParent.get(bone.id) || []).length;
        const inferredKind = bone.kind || inferStructuralBoneKind(bone.parent, childCount);
        const inferredSocket = bone.socket || (
            box
                ? (bone.parent && currentBoneMap.get(bone.parent)?.pivot
                    ? nearestPointOnBox(box, currentBoneMap.get(bone.parent)!.pivot!)
                    : defaultPivotForBox(box))
                : bone.pivot
        );
        const inferredLength = bone.length || (box ? round2(Math.max(boxWidth(box), boxHeight(box))) : undefined);
        const sideReference = currentBoneMap.get(bone.parent || "")?.pivot?.x ?? 500;
        const inferredSide = bone.side || (box ? inferStructuralBoneSide(box, sideReference) : "center");
        const inferredContactRole = bone.contactRole || inferStructuralContactRole();
        const inferredMassClass = bone.massClass || inferStructuralMassClass(bone.parent, childCount);

        return {
            ...bone,
            kind: inferredKind,
            side: inferredSide,
            length: inferredLength,
            socket: inferredSocket ? { x: round2(inferredSocket.x), y: round2(inferredSocket.y) } : undefined,
            contactRole: inferredContactRole,
            massClass: inferredMassClass,
        };
    });

    const repairReport: RigRepairReport = {
        version: 1,
        repaired: fixes.length > 0,
        fixes,
        warnings,
        confidence: computeRepairConfidence(repairedRig.bones.length, fixes.length, warnings.length),
    };

    repairedRig.repair_report = repairReport;

    return ensureRigIK({ svg_data: svgElement.outerHTML, rig_data: repairedRig });
}

function computeRepairConfidence(boneCount: number, fixCount: number, warningCount: number): number {
    const weightedPenalty = fixCount * 0.04 + warningCount * 0.14 + Math.max(0, warningCount - fixCount) * 0.03;
    const complexityPenalty = boneCount > 0 ? Math.min(0.1, boneCount * 0.0025) : 0;
    return round2(Math.max(0.1, Math.min(1, 1 - weightedPenalty - complexityPenalty)));
}

function collectElementBoxes(root: Element): Map<string, Box> {
    const boxes = new Map<string, Box>();
    visitElement(root, identityTransform(), boxes);
    return boxes;
}

function visitElement(element: Element, inherited: SimpleTransform, boxes: Map<string, Box>): Box | null {
    const local = composeTransform(inherited, parseTransform(element.getAttribute("transform")));
    const tag = element.tagName.toLowerCase();
    let box: Box | null = null;

    if (tag === "g" || tag === "svg") {
        const childBoxes: Box[] = [];
        Array.from(element.children).forEach((child) => {
            const childBox = visitElement(child, local, boxes);
            if (childBox) childBoxes.push(childBox);
        });
        box = unionBoxes(childBoxes);
    } else {
        box = computePrimitiveBox(element);
        if (box) box = applyTransformToBox(box, local);
        Array.from(element.children).forEach((child) => {
            const childBox = visitElement(child, local, boxes);
            box = unionBoxes([box, childBox]);
        });
    }

    const id = element.getAttribute("id");
    if (id && box) {
        boxes.set(id, box);
    }

    return box;
}

function computePrimitiveBox(element: Element): Box | null {
    const tag = element.tagName.toLowerCase();
    switch (tag) {
        case "rect": {
            const x = numAttr(element, "x");
            const y = numAttr(element, "y");
            const width = numAttr(element, "width");
            const height = numAttr(element, "height");
            return { minX: x, minY: y, maxX: x + width, maxY: y + height };
        }
        case "circle": {
            const cx = numAttr(element, "cx");
            const cy = numAttr(element, "cy");
            const r = numAttr(element, "r");
            return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
        }
        case "ellipse": {
            const cx = numAttr(element, "cx");
            const cy = numAttr(element, "cy");
            const rx = numAttr(element, "rx");
            const ry = numAttr(element, "ry");
            return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
        }
        case "line": {
            const x1 = numAttr(element, "x1");
            const y1 = numAttr(element, "y1");
            const x2 = numAttr(element, "x2");
            const y2 = numAttr(element, "y2");
            return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
        }
        case "polygon":
        case "polyline": {
            const points = parsePoints(element.getAttribute("points"));
            return points.length ? boxFromPoints(points) : null;
        }
        case "path": {
            const d = element.getAttribute("d");
            return d ? boxFromPoints(samplePathPoints(d)) : null;
        }
        default:
            return null;
    }
}

function samplePathPoints(d: string): Point[] {
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const points: Point[] = [];
    let index = 0;
    let command = "";
    let current: Point = { x: 0, y: 0 };
    let subpathStart: Point = { x: 0, y: 0 };

    const nextNumber = () => Number(tokens[index++]);
    const isCommand = (token?: string) => !!token && /^[a-zA-Z]$/.test(token);

    while (index < tokens.length) {
        if (isCommand(tokens[index])) {
            command = tokens[index++]!;
        }
        if (!command) break;

        const absolute = command === command.toUpperCase();
        const type = command.toUpperCase();

        const readPoint = (): Point => {
            const x = nextNumber();
            const y = nextNumber();
            return absolute ? { x, y } : { x: current.x + x, y: current.y + y };
        };

        if (type === "M") {
            const point = readPoint();
            current = point;
            subpathStart = point;
            points.push(point);
            command = absolute ? "L" : "l";
            continue;
        }
        if (type === "L") {
            current = readPoint();
            points.push(current);
            continue;
        }
        if (type === "H") {
            const x = nextNumber();
            current = absolute ? { x, y: current.y } : { x: current.x + x, y: current.y };
            points.push(current);
            continue;
        }
        if (type === "V") {
            const y = nextNumber();
            current = absolute ? { x: current.x, y } : { x: current.x, y: current.y + y };
            points.push(current);
            continue;
        }
        if (type === "C") {
            const c1 = readPoint();
            const c2 = readPoint();
            const end = readPoint();
            points.push(c1, c2, end);
            current = end;
            continue;
        }
        if (type === "S") {
            const c2 = readPoint();
            const end = readPoint();
            points.push(c2, end);
            current = end;
            continue;
        }
        if (type === "Q") {
            const c1 = readPoint();
            const end = readPoint();
            points.push(c1, end);
            current = end;
            continue;
        }
        if (type === "T") {
            const end = readPoint();
            points.push(end);
            current = end;
            continue;
        }
        if (type === "A") {
            const rx = nextNumber();
            const ry = nextNumber();
            index += 3; // rotation, large-arc-flag, sweep-flag
            const end = readPoint();
            points.push(
                { x: current.x - rx, y: current.y - ry },
                { x: current.x + rx, y: current.y + ry },
                { x: end.x - rx, y: end.y - ry },
                { x: end.x + rx, y: end.y + ry },
                end
            );
            current = end;
            continue;
        }
        if (type === "Z") {
            current = subpathStart;
            points.push(subpathStart);
            continue;
        }
        break;
    }

    return points;
}

function parsePoints(rawPoints: string | null): Point[] {
    if (!rawPoints) return [];
    const nums = (rawPoints.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) || []).map(Number);
    const points: Point[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        points.push({ x: nums[i], y: nums[i + 1] });
    }
    return points;
}

function boxFromPoints(points: Point[]): Box | null {
    if (points.length === 0) return null;
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}

function parseTransform(transform: string | null): SimpleTransform {
    const parsed = identityTransform();
    if (!transform) return parsed;

    const matcher = /([a-zA-Z]+)\(([^)]+)\)/g;
    for (const match of transform.matchAll(matcher)) {
        const fn = match[1];
        const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
        if (fn === "translate") {
            parsed.tx += args[0] || 0;
            parsed.ty += args[1] || 0;
        } else if (fn === "scale") {
            parsed.sx *= args[0] || 1;
            parsed.sy *= args[1] ?? args[0] ?? 1;
        }
    }
    return parsed;
}

function identityTransform(): SimpleTransform {
    return { tx: 0, ty: 0, sx: 1, sy: 1 };
}

function composeTransform(parent: SimpleTransform, child: SimpleTransform): SimpleTransform {
    return {
        tx: parent.tx + child.tx * parent.sx,
        ty: parent.ty + child.ty * parent.sy,
        sx: parent.sx * child.sx,
        sy: parent.sy * child.sy,
    };
}

function applyTransformToPoint(point: Point, transform: SimpleTransform): Point {
    return {
        x: point.x * transform.sx + transform.tx,
        y: point.y * transform.sy + transform.ty,
    };
}

function applyTransformToBox(box: Box, transform: SimpleTransform): Box {
    const corners = [
        applyTransformToPoint({ x: box.minX, y: box.minY }, transform),
        applyTransformToPoint({ x: box.maxX, y: box.minY }, transform),
        applyTransformToPoint({ x: box.minX, y: box.maxY }, transform),
        applyTransformToPoint({ x: box.maxX, y: box.maxY }, transform),
    ];
    return boxFromPoints(corners)!;
}

function unionBoxes(boxes: Array<Box | null | undefined>): Box | null {
    const valid = boxes.filter((box): box is Box => !!box);
    if (valid.length === 0) return null;
    return {
        minX: Math.min(...valid.map((box) => box.minX)),
        minY: Math.min(...valid.map((box) => box.minY)),
        maxX: Math.max(...valid.map((box) => box.maxX)),
        maxY: Math.max(...valid.map((box) => box.maxY)),
    };
}

function nearestPointOnBox(box: Box, point: Point): Point {
    return {
        x: clamp(point.x, box.minX, box.maxX),
        y: clamp(point.y, box.minY, box.maxY),
    };
}

function defaultPivotForBox(box: Box): Point {
    return {
        x: round2((box.minX + box.maxX) * 0.5),
        y: round2((box.minY + box.maxY) * 0.5),
    };
}

function appendTranslate(element: Element, dx: number, dy: number) {
    const current = element.getAttribute("transform");
    const translate = `translate(${round2(dx)} ${round2(dy)})`;
    element.setAttribute("transform", current ? `${current} ${translate}` : translate);
}

function containsPoint(box: Box, point: Point, margin = 0): boolean {
    return (
        point.x >= box.minX - margin &&
        point.x <= box.maxX + margin &&
        point.y >= box.minY - margin &&
        point.y <= box.maxY + margin
    );
}

function boxWidth(box: Box): number {
    return box.maxX - box.minX;
}

function boxHeight(box: Box): number {
    return box.maxY - box.minY;
}

function distanceBetween(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function numAttr(element: Element, attr: string): number {
    const raw = element.getAttribute(attr);
    return raw ? Number(raw) || 0 : 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function defaultRotationLimitForBone(parentId: string | undefined, childCount: number): [number, number] {
    if (!parentId) return [-18, 18];
    if (childCount > 0) return [-42, 42];
    return [-60, 60];
}
