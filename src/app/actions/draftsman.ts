"use server";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
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
import { constrainMotionSpecToRig, inferRigMotionAffordance, inferRigProfile, RigMotionAffordance } from "@/lib/motion/affordance";
import { inferMotionSpecForRig } from "@/lib/motion/spec";
import { buildMotionIntentFromSpec } from "@/lib/motion/intent";
import { MotionValidationDebug, validateRigForMotion } from "@/lib/motion/validation";
import { resolvePlayableMotionClip } from "@/lib/motion/compiled_ik";
import { ensureRigIK } from "@/lib/ik/graph";
import { CANONICAL_VIEW_IDS, genericViewPrefixForId, matchLegacyViewPrefix, normalizeViewId, normalizeViewIds } from "@/lib/ik/view_ids";
import { runGeminiRequestWithRetry } from "@/lib/ai/retry";
import { captureElementDrawOrder, reparentPreservingDrawOrder } from "@/lib/svg/assembly";

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
    };
    review?: DraftQualityReview;
}

export interface MotionClipResponse {
    clip?: NonNullable<DraftsmanData["rig_data"]["motion_clips"]>[string];
    stabilization?: MotionCompilationReport;
    blocked?: MotionCompilationBlocked;
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
    debugReport?: MotionDebugReport;
}

export interface MotionCompilationBlocked {
    message: string;
    debugReport: MotionDebugReport;
}

export interface MotionSpecResponse {
    spec: MotionSpec;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export interface SuggestedRigViewsResponse {
    views: string[];
    rationale?: string;
    usage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    }
}

export type DraftQualityReview = {
    acceptable: boolean;
    score: number;
    reasons: string[];
};

export type DraftQualityMode = "strict" | "reviewable";

export interface MotionDebugReport {
    motion: string;
    style?: string;
    durationSeconds: number;
    affordance: RigMotionAffordance;
    inferredSpec: MotionSpecDebugSummary;
    modelSpec: MotionSpecDebugSummary;
    finalSpec: MotionSpecDebugSummary;
    preflight: {
        ok: boolean;
        errors: string[];
        warnings: string[];
        debug: MotionValidationDebug;
    };
    qualityGrade: MotionQualityGrade;
    attempts: MotionDebugAttempt[];
    finalStatus: "compiled" | "blocked";
    finalMessage: string;
}

export interface MotionQualityGrade {
    profile: "rigid_root_motion" | "general";
    score: number;
    acceptable: boolean;
    reasons: string[];
    metrics: {
        rootSampleCount: number;
        interiorRootSampleCount: number;
        meaningfulInteriorRootSamples: number;
        wholeObjectAnchorCount: number;
        activeRootAxes: Array<"x" | "y" | "rotation">;
        rootShapeScore: number;
        loopClosed: boolean;
        waveCount: number;
        maxWaveAmplitudeDeg: number;
    };
}

export interface MotionSpecDebugSummary {
    motionFamily: string;
    tempo: number;
    amplitude: number;
    intensity: number;
    preferredView?: string;
    locomotionMode: MotionSpec["locomotion"]["mode"];
    preferredDirection?: MotionSpec["locomotion"]["preferredDirection"];
    leadBones: string[];
    contacts: Array<{
        boneId: string;
        target: string;
        phaseStart: number;
        phaseEnd: number;
    }>;
    blockedReasons: string[];
    wholeObjectAnchorCount: number;
    notes?: string;
}

export interface MotionDebugAttempt {
    pass: number;
    attenuationFactor: number;
    spec: MotionSpecDebugSummary;
    resolvedView?: string;
    leadNodes: string[];
    waveChains: Array<{
        chainId: string;
        nodeIds: string[];
        amplitudeDeg: number;
        frequency: number;
        falloff?: string;
    }>;
    validation: {
        ok: boolean;
        errors: string[];
        warnings: string[];
        debug: MotionValidationDebug;
    };
}

type MotionRootSample = NonNullable<MotionSpec["rootMotion"]>[number];

function isRigidRootMotionProfile(affordance: RigMotionAffordance): boolean {
    return affordance.deformationBudget <= 0.65 || affordance.primaryChainLength <= 2;
}

function applyRigProfile(data: DraftsmanData): DraftsmanData {
    const normalized = ensureRigIK(data);
    const profileReport = inferRigProfile(normalized);
    return {
        ...normalized,
        rig_data: {
            ...normalized.rig_data,
            profile: profileReport.profile,
            profile_report: profileReport,
        },
    };
}

function dedupeRootMotionSamples(samples: NonNullable<MotionSpec["rootMotion"]>): MotionRootSample[] {
    const byTime = new Map<number, MotionRootSample>();
    samples
        .filter((sample) => Number.isFinite(sample.t))
        .forEach((sample) => {
            byTime.set(round2(clamp(sample.t, 0, 1)), {
                t: round2(clamp(sample.t, 0, 1)),
                x: typeof sample.x === "number" ? round2(sample.x) : undefined,
                y: typeof sample.y === "number" ? round2(sample.y) : undefined,
                rotation: typeof sample.rotation === "number" ? normalizeDegrees(sample.rotation) : undefined,
            });
        });
    return Array.from(byTime.values()).sort((left, right) => left.t - right.t);
}

function rootAxisValue(sample: MotionRootSample, axis: "x" | "y" | "rotation"): number {
    const value = sample[axis];
    return typeof value === "number" ? value : 0;
}

function rootAxisThreshold(axis: "x" | "y" | "rotation"): number {
    return axis === "rotation" ? 6 : 0.9;
}

function normalizeDegrees(value: number): number {
    let next = value;
    while (next > 180) next -= 360;
    while (next < -180) next += 360;
    return round2(next);
}

function rootAxisLoopDelta(start: MotionRootSample, end: MotionRootSample, axis: "x" | "y" | "rotation"): number {
    const delta = rootAxisValue(end, axis) - rootAxisValue(start, axis);
    return axis === "rotation" ? Math.abs(normalizeDegrees(delta)) : Math.abs(delta);
}

function interpolateRootAxis(start: MotionRootSample, end: MotionRootSample, t: number, axis: "x" | "y" | "rotation"): number {
    const from = rootAxisValue(start, axis);
    const to = rootAxisValue(end, axis);
    if (axis === "rotation") {
        return from + (normalizeDegrees(to - from) * t);
    }
    return from + ((to - from) * t);
}

function gradeMotionQuality(params: {
    affordance: RigMotionAffordance;
    motionSpec: MotionSpec;
}): MotionQualityGrade {
    const { affordance, motionSpec } = params;
    const rigidProfile = isRigidRootMotionProfile(affordance);
    const rootSamples = dedupeRootMotionSamples(motionSpec.rootMotion || []);
    const wholeObjectAnchorCount = motionSpec.wholeObjectMotion?.anchors?.length || 0;
    const interiorSamples = rootSamples.filter((sample) => sample.t > 0 && sample.t < 1);
    const axes: Array<"x" | "y" | "rotation"> = ["x", "y", "rotation"];
    const activeRootAxes = axes.filter((axis) => {
        if (rootSamples.length === 0) return false;
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        rootSamples.forEach((sample) => {
            const value = rootAxisValue(sample, axis);
            min = Math.min(min, value);
            max = Math.max(max, value);
        });
        return Number.isFinite(min) && Number.isFinite(max) && Math.abs(max - min) >= rootAxisThreshold(axis);
    });
    const endpointsPresent = rootSamples.length >= 2 && rootSamples[0].t === 0 && rootSamples[rootSamples.length - 1].t === 1;
    const loopClosed = endpointsPresent && axes.every((axis) => rootAxisLoopDelta(rootSamples[0], rootSamples[rootSamples.length - 1], axis) <= (axis === "rotation" ? 4 : 0.75));

    let meaningfulInteriorRootSamples = 0;
    let rootShapeScore = 0;
    if (rootSamples.length >= 2) {
        const start = rootSamples[0];
        const end = rootSamples[rootSamples.length - 1];
        const span = Math.max(0.0001, end.t - start.t);
        interiorSamples.forEach((sample) => {
            let sampleShapeScore = 0;
            axes.forEach((axis) => {
                const expected = interpolateRootAxis(start, end, (sample.t - start.t) / span, axis);
                const deviation = axis === "rotation"
                    ? Math.abs(normalizeDegrees(rootAxisValue(sample, axis) - expected))
                    : Math.abs(rootAxisValue(sample, axis) - expected);
                sampleShapeScore = Math.max(sampleShapeScore, deviation / rootAxisThreshold(axis));
            });
            if (sampleShapeScore >= 1) {
                meaningfulInteriorRootSamples += 1;
            }
            rootShapeScore += sampleShapeScore;
        });
    }
    rootShapeScore = round2(rootShapeScore);

    const waveCount = (motionSpec.axialWaves || []).length;
    const maxWaveAmplitudeDeg = round2(Math.max(0, ...(motionSpec.axialWaves || []).map((wave) => Math.abs(wave.amplitudeDeg))));
    const requiresWholeObjectTiming = motionSpec.locomotion.mode !== "none" || (motionSpec.contacts || []).length > 0;
    let score = 5;
    const reasons: string[] = [];

    if (rigidProfile) {
        if (requiresWholeObjectTiming && rootSamples.length === 0) {
            score = 0;
            reasons.push("Rigid or low-deformation motion needs explicit rootMotion instead of fallback motion.");
        } else {
            if (rootSamples.length > 0 && !endpointsPresent) {
                score -= 0.75;
                reasons.push("rootMotion should include explicit samples at t=0 and t=1.");
            }
            if (rootSamples.length > 0 && !loopClosed) {
                score -= 1.5;
                reasons.push("rootMotion does not close cleanly back onto frame 0.");
            }
            if (requiresWholeObjectTiming && rootSamples.length < 4) {
                score -= 2.5;
                reasons.push("rootMotion is too sparse for believable rigid motion; expected at least 4 timed samples.");
            } else if (requiresWholeObjectTiming && rootSamples.length < 5) {
                score -= 1;
                reasons.push("rootMotion is still sparse; 5 or more samples gives cleaner anticipation and settle.");
            }
            if (requiresWholeObjectTiming && activeRootAxes.length === 0) {
                score -= 1.5;
                reasons.push("rootMotion has no meaningful x, y, or rotation variation.");
            }
            if (requiresWholeObjectTiming && meaningfulInteriorRootSamples < 2) {
                score -= 1.5;
                reasons.push("rootMotion lacks enough interior timing changes for anticipation, overshoot, or settle.");
            }
            if (requiresWholeObjectTiming && rootShapeScore < 1.6) {
                score -= 1;
                reasons.push("rootMotion stays too close to a flat linear path, so the motion will read synthetic.");
            }
            if (requiresWholeObjectTiming && wholeObjectAnchorCount === 0) {
                score -= 0.75;
                reasons.push("Rigid motion is missing wholeObjectMotion anchors, so transform-only playback loses timing nuance.");
            } else if (requiresWholeObjectTiming && wholeObjectAnchorCount < 4) {
                score -= 0.4;
                reasons.push("wholeObjectMotion is sparse; 4 or more anchors gives cleaner anticipation and settle.");
            }
        }

        if (waveCount > 0 && affordance.primaryChainLength <= 2 && maxWaveAmplitudeDeg > 12) {
            score -= 1.5;
            reasons.push("Axial waves are too strong for a topology without a meaningful continuous chain.");
        } else if (waveCount > 0 && affordance.deformationBudget <= 0.65 && maxWaveAmplitudeDeg > 18) {
            score -= 1;
            reasons.push("Axial waves are too aggressive for this rig's deformation budget.");
        }
    }

    score = round2(clamp(score, 0, 5));

    return {
        profile: rigidProfile ? "rigid_root_motion" : "general",
        score,
        acceptable: rigidProfile ? score >= 3.5 : true,
        reasons,
        metrics: {
            rootSampleCount: rootSamples.length,
            interiorRootSampleCount: interiorSamples.length,
            meaningfulInteriorRootSamples,
            wholeObjectAnchorCount,
            activeRootAxes,
            rootShapeScore,
            loopClosed,
            waveCount,
            maxWaveAmplitudeDeg,
        },
    };
}

function summarizeMotionSpec(motionSpec: MotionSpec): MotionSpecDebugSummary {
    return {
        motionFamily: motionSpec.motionFamily,
        tempo: round2(motionSpec.tempo || 1),
        amplitude: round2(motionSpec.amplitude || 1),
        intensity: round2(motionSpec.intensity || 0.5),
        preferredView: motionSpec.preferredView,
        locomotionMode: motionSpec.locomotion.mode,
        preferredDirection: motionSpec.locomotion.preferredDirection,
        leadBones: [...(motionSpec.leadBones || [])],
        contacts: (motionSpec.contacts || []).map((contact) => ({
            boneId: contact.boneId,
            target: contact.target,
            phaseStart: round2(contact.phaseStart),
            phaseEnd: round2(contact.phaseEnd),
        })),
        blockedReasons: [...(motionSpec.blockedReasons || [])],
        wholeObjectAnchorCount: motionSpec.wholeObjectMotion?.anchors?.length || 0,
        notes: motionSpec.notes,
    };
}

function buildMotionDebugAttempt(
    pass: number,
    attenuationFactor: number,
    candidateSpec: MotionSpec,
    candidateClip: RigMotionClip,
    validation: ReturnType<typeof validateRigForMotion>,
): MotionDebugAttempt {
    return {
        pass,
        attenuationFactor: round2(attenuationFactor),
        spec: summarizeMotionSpec(candidateSpec),
        resolvedView: candidateClip.view,
        leadNodes: [...(candidateClip.intent.leadNodes || [])],
        waveChains: (candidateClip.intent.axialWaves || []).map((wave) => ({
            chainId: wave.chainId || "unnamed",
            nodeIds: [...wave.nodeIds],
            amplitudeDeg: round2(wave.amplitudeDeg),
            frequency: round2(wave.frequency),
            falloff: wave.falloff,
        })),
        validation: {
            ok: validation.ok,
            errors: [...validation.errors],
            warnings: [...validation.warnings],
            debug: validation.debug,
        },
    };
}

function buildMotionDebugReport(params: {
    motion: string;
    style?: string;
    durationSeconds: number;
    affordance: RigMotionAffordance;
    inferredSpec: MotionSpec;
    modelSpec: MotionSpec;
    finalSpec: MotionSpec;
    preflight: ReturnType<typeof validateRigForMotion>;
    qualityGrade: MotionQualityGrade;
    attempts: MotionDebugAttempt[];
    finalStatus: "compiled" | "blocked";
    finalMessage: string;
}): MotionDebugReport {
    return {
        motion: params.motion,
        style: params.style,
        durationSeconds: round2(params.durationSeconds),
        affordance: params.affordance,
        inferredSpec: summarizeMotionSpec(params.inferredSpec),
        modelSpec: summarizeMotionSpec(params.modelSpec),
        finalSpec: summarizeMotionSpec(params.finalSpec),
        preflight: {
            ok: params.preflight.ok,
            errors: [...params.preflight.errors],
            warnings: [...params.preflight.warnings],
            debug: params.preflight.debug,
        },
        qualityGrade: params.qualityGrade,
        attempts: params.attempts,
        finalStatus: params.finalStatus,
        finalMessage: params.finalMessage,
    };
}

function buildCanonicalMotionClipFromSpec(params: {
    rig: DraftsmanData;
    motion: string;
    durationSeconds: number;
    motionSpec: MotionSpec;
}): RigMotionClip {
    const rawClip: RigMotionClip = {
        view: params.motionSpec.preferredView || params.rig.rig_data.ik?.defaultView || Object.keys(params.rig.rig_data.ik?.views || {}).sort()[0],
        intent: buildMotionIntentFromSpec({
            rig: params.rig,
            motion: params.motion,
            durationSeconds: params.durationSeconds,
            motionSpec: params.motionSpec,
            allowFallbackSynthesis: false,
        }),
        displayKeyframes: [] as any,
    };

    return resolvePlayableMotionClip({
        rig: params.rig,
        clipId: params.motion,
        motionClip: rawClip,
        durationSeconds: params.durationSeconds,
    }) || rawClip;
}

function enforceExplicitGeneratedMotionSpec(params: {
    motionSpec: MotionSpec;
    rigProfile: DraftsmanData["rig_data"]["profile"];
}): MotionSpec {
    const blockedReasons = [...(params.motionSpec.blockedReasons || [])];
    const hasRootMotion = (params.motionSpec.rootMotion || []).length > 0;
    const hasAxialWaves = (params.motionSpec.axialWaves || []).length > 0;
    const hasRotationTracks = (params.motionSpec.rotationTracks || []).length > 0;
    const hasEffectorGoals = (params.motionSpec.effectorGoals || []).length > 0;

    if (params.rigProfile === "rigid_object") {
        if (!hasRootMotion) {
            blockedReasons.push("Rigid-object motion spec must include explicit rootMotion. Generic fallback synthesis is disabled.");
        }
    } else if (!hasRootMotion && !hasAxialWaves && !hasRotationTracks && !hasEffectorGoals) {
        blockedReasons.push("Motion spec must include explicit rootMotion, axialWaves, rotationTracks, or effectorGoals. Generic fallback synthesis is disabled.");
    }

    return {
        ...params.motionSpec,
        blockedReasons: Array.from(new Set(blockedReasons)),
    };
}

function isRetriableMotionValidationError(error: string): boolean {
    return (
        error.includes("hit hard angle limits") ||
        error.includes("stretched segment lengths") ||
        error.includes("animated pins drift")
    );
}

function attenuateMotionSpec(motionSpec: MotionSpec, factor: number): MotionSpec {
    const safeFactor = Math.max(0.18, Math.min(1, factor));
    return {
        ...motionSpec,
        amplitude: round2(Math.max(0.02, (motionSpec.amplitude || 1) * safeFactor)),
        intensity: round2(Math.max(0, Math.min(1, (motionSpec.intensity || 0.5) * (0.45 + (safeFactor * 0.55))))),
        notes: [
            motionSpec.notes,
            `Validation attenuation applied at ${round2(safeFactor)}x.`,
        ].filter(Boolean).join(" "),
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

const SuggestedRigViewsSchema = z.object({
    views: z.array(z.string().trim().min(1)).min(1).max(6),
    rationale: z.string().trim().optional(),
});

function extractJSONObject(text: string, emptyMessage: string, missingMessage: string): string {
    if (!text) {
        throw new Error(emptyMessage);
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error(missingMessage);
    }
    return text.substring(firstBrace, lastBrace + 1);
}

function describeRequestedView(viewId: string): string {
    switch (viewId) {
        case "view_front":
            return `- \`${viewId}\` — Front-facing or most symmetrical front view.`;
        case "view_side_right":
            return `- \`${viewId}\` — Clean right-facing profile or closest rightward side view.`;
        case "view_side_left":
            return `- \`${viewId}\` — Clean left-facing profile or closest leftward side view.`;
        case "view_3q_right":
            return `- \`${viewId}\` — Natural 3/4 right-facing view with visible depth.`;
        case "view_3q_left":
            return `- \`${viewId}\` — Natural 3/4 left-facing view with visible depth.`;
        case "view_top":
            return `- \`${viewId}\` — Top-down or plan view.`;
        case "view_back":
            return `- \`${viewId}\` — Back-facing or rear view.`;
        default:
            return `- \`${viewId}\` — Exact observed subject angle from the raster reference for this request.`;
    }
}

export async function suggestRigViewsFromRaster(params: {
    base64Image: string;
    actorName?: string;
    actorDescription?: string;
    sceneNarrative?: string;
    actions?: string[];
    existingViews?: string[];
}): Promise<SuggestedRigViewsResponse> {
    const canonicalViews = CANONICAL_VIEW_IDS.filter((viewId) => viewId !== "view_default");
    const existingViews = Array.from(new Set(
        (params.existingViews || [])
            .map((viewId) => normalizeViewId(viewId))
            .filter((viewId): viewId is string => Boolean(viewId)),
    ));

    const prompt = `
You are a subject-view planner for a deterministic 2D animation rigging pipeline.

Read the raster panel image, locate the requested actor, and decide which rig view containers should exist so the subject can be rendered from the observed angle without faking the orientation.

Rules:
1. Output ONLY JSON.
2. Reuse an existing view ID when it already matches the observed angle closely enough.
3. Prefer canonical view IDs when possible: ${canonicalViews.join(", ")}.
4. If no existing or canonical view fits the observed angle, you may return one custom \`view_*\` ID using short lowercase ASCII with underscores, e.g. \`view_rear_left_low\`.
5. Return the minimum useful view set. Put the currently observed view first.
6. Default to a single currently observed view. Do NOT propose speculative future views that are merely convenient or "nice to have".
7. Keep the answer view-driven, not anatomy-driven.

Actor:
- actorName: ${params.actorName || "unknown"}
- actorDescription: ${params.actorDescription || "unknown"}
- sceneNarrative: ${params.sceneNarrative || "none"}
- actions: ${(params.actions || []).join(", ") || "none"}
- existingViews: ${existingViews.join(", ") || "none"}

JSON shape:
{
  "views": ["view_3q_left", "view_side_left"],
  "rationale": "Observed pose reads as left-facing three-quarter, with a left profile useful for lateral travel."
}
`;

    const response = await runGeminiRequestWithRetry(
        "Draftsman view planner request",
        () => ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                data: params.base64Image.replace(/^data:image\/(png|jpeg);base64,/, ""),
                                mimeType: "image/jpeg",
                            },
                        },
                    ],
                },
            ],
            config: {
                temperature: 0.1,
            },
        }),
    );

    const json = extractJSONObject(
        response.text || "",
        "Gemini returned an empty rig view response.",
        "No JSON rig view response found in Gemini output.",
    );
    const parsed = SuggestedRigViewsSchema.parse(JSON.parse(json));

    return {
        views: normalizeViewIds(parsed.views, existingViews[0] || "view_3q_right").slice(0, 1),
        rationale: parsed.rationale,
        usage: {
            promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
            candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
            totalTokenCount: response.usageMetadata?.totalTokenCount || 0,
        },
    };
}

export async function processDraftsmanPrompt(
    base64Image: string,
    entityDescription: string,
    requiredViews: string[] = ['view_3q_right'],
    reviewImages: string[] = [],
    qualityMode: DraftQualityMode = "strict",
): Promise<DraftsmanResponse> {
    const requestedViews = normalizeViewIds(requiredViews.length > 0 ? requiredViews : ['view_3q_right']);
    const requestedViewGuide = requestedViews.map((viewId) => describeRequestedView(viewId)).join("\n");
    const requestedViewPrefixGuide = requestedViews
        .map((viewId) => `   - \`${viewId}\` => \`${genericViewPrefixForId(viewId)}\``)
        .join("\n");
    const requestedViewSvgExample = requestedViews
        .map((viewId, index) => `<g id='${viewId}' display='${index === 0 ? "inline" : "none"}'>...</g>`)
        .join("");
    const requestedBoneJsonExample = requestedViews
        .flatMap((viewId) => {
            const prefix = genericViewPrefixForId(viewId);
            return [
                `      { "id": "${prefix}root", "pivot": { "x": 500, "y": 520 }, "zIndex": 10, "kind": "root", "side": "center", "massClass": "heavy" }`,
                `      { "id": "${prefix}core", "pivot": { "x": 500, "y": 520 }, "socket": { "x": 500, "y": 520 }, "parent": "${prefix}root", "zIndex": 20, "kind": "body", "side": "center", "massClass": "medium" }`,
            ];
        })
        .join(",\n");
    const requestedInteractionNullExample = requestedViews
        .map((viewId) => `"${genericViewPrefixForId(viewId)}anchor_point"`)
        .join(", ");
    const DRAFTSMAN_SYSTEM_PROMPT = `
You are the Draftsman, an expert SVG vector artist and technical rigger.
Your job is to take a raster subject image and recreate it as a clean, highly-structured, animatable SVG vector file.

CRITICAL REQUIREMENTS:
1. **Resolution Independence**: Output \`<svg viewBox="0 0 1000 1000">\`. Use clean 2D vector shapes with flat colors. No <image> tags. Fit the entire subject inside with a margin; never crop extremities.
2. **SUBJECT TURNAROUND SHEET**: Draw the subject ONLY for the requested top-level view containers.
   Requested view containers:
${requestedViewGuide}
   Generate ONLY these requested views: ${requestedViews.join(", ")}.
   Make the first requested view visible (\`display="inline"\`), all others \`display="none"\`.
   Each view's bones MUST use this prefix exact format:
${requestedViewPrefixGuide}
3. **Logical 2D Puppet Assembly (CRITICAL)**: Build a functional 2D cutout paper-craft puppet.
   - Limbs MUST physically overlap at the joints. Do NOT cut off a limb where it goes behind clothing. Draw full, rounded joints (shoulders, hips) so parts rotate smoothly without gaps!
   - Prioritize logical overlapping anatomy over perfectly cloning the 1:1 reference image silhouette.
   - Group related parts together (e.g. \`arm_lower\` visually grouped inside \`arm_upper\`).
4. **Hierarchy & Z-Index Layering (CRITICAL)**: SVG renders strictly back-to-front. 
   - Furthest background limbs MUST appear first in the \`<g>\` block. Foreground limbs MUST appear last.
   - Mirror that exact overlap ordering in the JSON rig using the \`zIndex\` field (Lower \`zIndex\` = back, higher \`zIndex\` = front).
5. **Visemes and Emotions**: If expressive, include \`<g id="mouth_visemes">\` (\`#mouth_idle\`, \`A, E, I, O, U, M\`) and \`<g id="emotions">\` (\`#emotion_neutral\`, \`happy, sad, angry, surprised\`). Leave idle/neutral visible, others hidden.
6. **The JSON Rig Metadata (CRITICAL)**: Define explicit {x, y} coordinates for EVERY \`pivot\` point allowing smooth rotation.
   - \`socket\`: EXPLICITLY specify the preferred attachment point {x,y} within the parent. Missing sockets break animation! Every bone with a parent MUST have a \`socket\`.
   - \`kind\`: Prefer \`root\`, \`body\`, or \`other\`.
   - \`side\`: \`left\`, \`right\`, or \`center\`.
   - \`length\`: segment length in SVG units.
   - \`contactRole\`: \`none\`, \`ground\`, \`wall\`, \`water\`, or \`grip\`.
   - \`massClass\`: \`light\`, \`medium\`, or \`heavy\`.
7. **Animation Clips**: Output \`rig_data.motion_clips\` as an empty object \`{}\`. Do not generate pre-authored motion.

CRITICAL SHAPE: You must output ONLY a SINGLE valid JSON object matching this exact structure:
\`\`\`json
{
  "svg_data": "<svg viewBox='0 0 1000 1000'>${requestedViewSvgExample}</svg>",
  "rig_data": {
    "bones": [
${requestedBoneJsonExample}
    ],
    "interactionNulls": [${requestedInteractionNullExample}],
    "visemes": ["mouth_idle", "mouth_A", "mouth_E", "mouth_I", "mouth_O", "mouth_U", "mouth_M"],
    "emotions": ["emotion_neutral", "emotion_happy", "emotion_sad", "emotion_angry", "emotion_surprised"],
    "motion_clips": {}
  }
}
\`\`\`
Do not write any text outside this JSON object. The \`svg_data\` property MUST contain the full vector string properly escaped for JSON.
`;

    const runDraftPass = async (description: string): Promise<DraftsmanResponse> => {
        const reviewImageParts = reviewImages.slice(0, 3).flatMap((image, index) => (
            image
                ? [
                    { text: `Review image ${index + 1}: this shows a previous rig under stress or extreme posing. Avoid the visible failures.` },
                    {
                        inlineData: {
                            data: image.replace(/^data:image\/(png|jpeg);base64,/, ""),
                            mimeType: "image/jpeg"
                        }
                    }
                ]
                : [] as any
        ));
        const response = await runGeminiRequestWithRetry(
            "Draftsman rig generation request",
            () => ai.models.generateContent({
                model: "gemini-3.1-pro-preview",
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: DRAFTSMAN_SYSTEM_PROMPT },
                            { text: `Redraw this entity as an animatable SVG rig: ${description}\nRequired views: ${requestedViews.join(", ")}` },
                            {
                                inlineData: {
                                    data: base64Image.replace(/^data:image\/(png|jpeg);base64,/, ""),
                                    mimeType: "image/jpeg"
                                }
                            },
                            ...reviewImageParts,
                        ]
                    }
                ],
                config: {
                    systemInstruction: { role: "user", parts: [{ text: DRAFTSMAN_SYSTEM_PROMPT }] },
                    temperature: 0.5
                }
            }),
        );

        const text = extractJSONObject(
            response.text || "",
            "Gemini returned an empty response.",
            "No JSON object found in Gemini response.",
        );

        const data = pruneRigToRequestedViews(JSON.parse(text) as DraftsmanData, requestedViews);
        const normalizedData = applyRigProfile(normalizeRigHierarchy(data));
        return {
            data: normalizedData,
            usage: {
                promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
                candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
                totalTokenCount: response.usageMetadata?.totalTokenCount || 0
            }
        };
    };

    const combineUsage = (...usages: DraftsmanResponse["usage"][]): DraftsmanResponse["usage"] => usages.reduce((acc, usage) => ({
        promptTokenCount: acc.promptTokenCount + usage.promptTokenCount,
        candidatesTokenCount: acc.candidatesTokenCount + usage.candidatesTokenCount,
        totalTokenCount: acc.totalTokenCount + usage.totalTokenCount,
    }), {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
    });

    try {
        const firstPass = await runDraftPass(entityDescription);
        const firstReview = reviewDraftQuality(firstPass.data, requestedViews);
        if (firstReview.acceptable) {
            return {
                ...firstPass,
                review: firstReview,
            };
        }

        const retryDescription = [
            entityDescription,
            "CRITICAL REVIEW FEEDBACK: The previous draft was rejected.",
            ...firstReview.reasons.map((reason) => `- ${reason}`),
            "Redraw from scratch. Do not patch the previous drawing.",
            "Keep the subject large and centered in the 1000x1000 frame.",
            "Preserve the subject identity and silhouette from the raster reference.",
        ].join("\n");
        const secondPass = await runDraftPass(retryDescription);
        const secondReview = reviewDraftQuality(secondPass.data, requestedViews);
        const bestPass = secondReview.score <= firstReview.score ? secondPass : firstPass;
        const bestReview = secondReview.score <= firstReview.score ? secondReview : firstReview;
        const usage = combineUsage(firstPass.usage, secondPass.usage);

        if (!bestReview.acceptable) {
            if (qualityMode === "strict") {
                throw new Error(
                    `Draft quality review failed: ${bestReview.reasons.slice(0, 3).join(" ") || "The generated rig remained structurally weak after review."}`,
                );
            }
        }

        return {
            data: bestPass.data,
            usage,
            review: bestReview,
        };

    } catch (error: unknown) {
        console.error("Draftsman Error:", error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || "Failed to generate the SVG rig. Please try again.");
    }
}

export async function repairDraftedRig(data: DraftsmanData): Promise<DraftsmanData> {
    try {
        return applyRigProfile(postProcessAndRepairSVG(data.svg_data, data.rig_data));
    } catch (error: unknown) {
        console.error("Rig repair error:", error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || "Failed to repair the rig.");
    }
}

function reviewDraftQuality(data: DraftsmanData, requestedViews: string[]): DraftQualityReview {
    const reasons: string[] = [];
    let score = 0;
    const profileReport = data.rig_data.profile_report ?? inferRigProfile(data);
    const profileMetrics = profileReport.metrics;

    const ikConfidence = data.rig_data.ik?.aiReport?.confidence ?? 1;
    const warnings = data.rig_data.ik?.aiReport?.warnings || [];
    const attachmentWarnings = warnings.filter((warning) => warning.includes("attachment gap"));
    const socketWarnings = warnings.filter((warning) => warning.includes("has no explicit attachment socket"));
    const disconnectedWarnings = warnings.filter((warning) => /detached structural islands|multiple structural roots|missing a binding|no default drawable view/i.test(warning));

    if (ikConfidence < 0.42) {
        score += 4;
        reasons.push(`IK confidence is too low (${ikConfidence.toFixed(2)}).`);
    } else if (ikConfidence < 0.55) {
        score += 2;
        reasons.push(`IK confidence is soft (${ikConfidence.toFixed(2)}).`);
    }

    if (attachmentWarnings.length >= 2) {
        score += 4;
        reasons.push(`Attachment integrity is poor: ${attachmentWarnings.slice(0, 2).join(" ")}`);
    } else if (attachmentWarnings.length === 1) {
        score += 2;
        reasons.push(attachmentWarnings[0]);
    }

    if (socketWarnings.length >= 2) {
        score += 3;
        reasons.push(`Multiple articulated parts are missing explicit attachment sockets in the active view.`);
    }

    if (disconnectedWarnings.length > 0) {
        score += 5;
        reasons.push(disconnectedWarnings[0]);
    }

    if (profileReport.profile === "rigid_object") {
        if (profileMetrics.nodeCount > 6) {
            score += 4;
            reasons.push(`Rig is over-segmented for a mostly rigid subject (${profileMetrics.nodeCount} canonical nodes).`);
        }
        if (profileMetrics.effectors > 2) {
            score += 2;
            reasons.push(`Rigid subjects should not expose many independent effectors (${profileMetrics.effectors}).`);
        }
    } else if (profileReport.profile === "limited_articulation") {
        if (profileMetrics.nodeCount > 12 && profileMetrics.primaryChainLength <= 3) {
            score += 3;
            reasons.push(`Rig complexity is high for its usable articulation (${profileMetrics.nodeCount} nodes, primary chain ${profileMetrics.primaryChainLength}).`);
        }
        if (profileMetrics.branchChainCount > 3 && profileMetrics.primaryChainLength <= 3) {
            score += 2;
            reasons.push(`Too many secondary branches are competing with a short primary chain.`);
        }
    }

    try {
        const dom = new JSDOM(data.svg_data, { contentType: "image/svg+xml" });
        const svgElement = dom.window.document.querySelector("svg");
        if (!svgElement) {
            score += 6;
            reasons.push("Generated SVG has no root <svg> element.");
        } else {
            const boxes = collectElementBoxes(svgElement);
            requestedViews.forEach((viewId) => {
                const box = boxes.get(viewId);
                if (!box) {
                    score += 5;
                    reasons.push(`${viewId} has no measurable subject drawing.`);
                    return;
                }

                const width = boxWidth(box);
                const height = boxHeight(box);
                const area = width * height;
                const centerX = (box.minX + box.maxX) * 0.5;
                const centerY = (box.minY + box.maxY) * 0.5;

                if (width < 220 || height < 150 || area < 70000) {
                    score += 3;
                    reasons.push(`${viewId} is framed too small in the 1000x1000 canvas (${Math.round(width)}x${Math.round(height)}).`);
                }

                if (box.minX < 35 || box.maxX > 965 || box.minY < 25 || box.maxY > 975) {
                    score += 3;
                    reasons.push(`${viewId} is cropped or framed too tightly; the full subject needs visible margin for clean rig extraction.`);
                }

                if (Math.abs(centerX - 500) > 240 || Math.abs(centerY - 540) > 240) {
                    score += 1;
                    reasons.push(`${viewId} is badly centered in the frame.`);
                }
            });
        }
    } catch {
        score += 2;
        reasons.push("Failed to inspect generated SVG footprint for quality review.");
    }

    return {
        acceptable: score < 5,
        score,
        reasons: Array.from(new Set(reasons)).slice(0, 6),
    };
}

function normalizeRigHierarchy(data: DraftsmanData): DraftsmanData {
    try {
        const dom = new JSDOM(data.svg_data, { contentType: "image/svg+xml" });
        const document = dom.window.document;
        const svgElement = document.querySelector("svg");
        if (!svgElement) return data;
        const drawOrder = captureElementDrawOrder(svgElement);
        const zIndexById = new Map(
            data.rig_data.bones
                .filter((bone) => typeof bone.zIndex === "number")
                .map((bone) => [bone.id, bone.zIndex as number]),
        );

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

            reparentPreservingDrawOrder(parentEl, childEl, drawOrder, zIndexById);
        });

        return {
            ...data,
            rig_data: {
                ...data.rig_data,
                bones: assignBoneZIndexFromSvgOrder(data.rig_data.bones, svgElement),
            },
            svg_data: svgElement.outerHTML,
        };
    } catch (error) {
        console.error("Rig hierarchy normalization failed:", error);
        return data;
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
    const durationSeconds = params.durationSeconds || 2;
    const motionAffordance = inferRigMotionAffordance(normalizedRig);
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
    const motionSpec = enforceExplicitGeneratedMotionSpec({
        motionSpec: constrainMotionSpecToRig(normalizedRig, MotionSpecSchema.parse(structuredSpecResult.spec)),
        rigProfile: normalizedRig.rig_data.profile,
    });
    const qualityGrade = gradeMotionQuality({
        affordance: motionAffordance,
        motionSpec,
    });
    const preflight = validateRigForMotion({
        rig: normalizedRig,
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
    });

    const attenuationPasses = [1, 0.82, 0.68, 0.56, 0.46, 0.38, 0.3, 0.24];
    let motionClip: RigMotionClip | undefined;
    let postflight = validateRigForMotion({
        rig: normalizedRig,
        motion: params.motion,
        style: params.style,
        durationSeconds: params.durationSeconds,
    });
    let resolvedMotionSpec = motionSpec;
    let appliedAttenuationFactor = 1;
    const attempts: MotionDebugAttempt[] = [];

    if (motionSpec.blockedReasons?.length) {
        const message = motionSpec.blockedReasons.join(" ");
        return {
            blocked: {
                message,
                debugReport: buildMotionDebugReport({
                    motion: params.motion,
                    style: params.style,
                    durationSeconds,
                    affordance: motionAffordance,
                    inferredSpec,
                    modelSpec: structuredSpecResult.spec,
                    finalSpec: motionSpec,
                    preflight,
                    qualityGrade,
                    attempts,
                    finalStatus: "blocked",
                    finalMessage: message,
                }),
            },
            usage: structuredSpecResult.usage,
        };
    }

    if (!preflight.ok) {
        const message = preflight.errors.join(" ");
        return {
            blocked: {
                message,
                debugReport: buildMotionDebugReport({
                    motion: params.motion,
                    style: params.style,
                    durationSeconds,
                    affordance: motionAffordance,
                    inferredSpec,
                    modelSpec: structuredSpecResult.spec,
                    finalSpec: motionSpec,
                    preflight,
                    qualityGrade,
                    attempts,
                    finalStatus: "blocked",
                    finalMessage: message,
                }),
            },
            usage: structuredSpecResult.usage,
        };
    }

    if (!qualityGrade.acceptable) {
        const message = qualityGrade.reasons.join(" ");
        return {
            blocked: {
                message,
                debugReport: buildMotionDebugReport({
                    motion: params.motion,
                    style: params.style,
                    durationSeconds,
                    affordance: motionAffordance,
                    inferredSpec,
                    modelSpec: structuredSpecResult.spec,
                    finalSpec: motionSpec,
                    preflight,
                    qualityGrade,
                    attempts,
                    finalStatus: "blocked",
                    finalMessage: message,
                }),
            },
            usage: structuredSpecResult.usage,
        };
    }

    for (const [passIndex, factor] of attenuationPasses.entries()) {
        const candidateSpec = factor === 1 ? motionSpec : attenuateMotionSpec(motionSpec, factor);
        const candidateClip = buildCanonicalMotionClipFromSpec({
            rig: normalizedRig,
            motion: params.motion,
            durationSeconds,
            motionSpec: candidateSpec,
        });
        const candidatePostflight = validateRigForMotion({
            rig: normalizedRig,
            motion: params.motion,
            style: params.style,
            durationSeconds: params.durationSeconds,
            motionClip: candidateClip,
        });
        attempts.push(buildMotionDebugAttempt(
            passIndex + 1,
            factor,
            candidateSpec,
            candidateClip,
            candidatePostflight,
        ));

        if (candidatePostflight.ok) {
            motionClip = candidateClip;
            postflight = candidatePostflight;
            resolvedMotionSpec = candidateSpec;
            appliedAttenuationFactor = factor;
            break;
        }

        motionClip = candidateClip;
        postflight = candidatePostflight;
        resolvedMotionSpec = candidateSpec;
        appliedAttenuationFactor = factor;

        if (!candidatePostflight.errors.every(isRetriableMotionValidationError)) {
            break;
        }
    }

    if (!motionClip || !postflight.ok) {
        const message = postflight.errors.join(" ");
        return {
            blocked: {
                message,
                debugReport: buildMotionDebugReport({
                    motion: params.motion,
                    style: params.style,
                    durationSeconds,
                    affordance: motionAffordance,
                    inferredSpec,
                    modelSpec: structuredSpecResult.spec,
                    finalSpec: resolvedMotionSpec,
                    preflight,
                    qualityGrade,
                    attempts,
                    finalStatus: "blocked",
                    finalMessage: message,
                }),
            },
            usage: structuredSpecResult.usage,
        };
    }

    return {
        clip: motionClip,
        stabilization: {
            validationWarnings: [
                "Canonical motion clip synthesized directly from structured motion spec.",
                ...(resolvedMotionSpec.notes ? [`Motion spec: ${resolvedMotionSpec.notes}`] : [] as any),
                ...(qualityGrade.profile === "rigid_root_motion" && qualityGrade.reasons.length > 0
                    ? [`Motion quality grade ${qualityGrade.score}/5: ${qualityGrade.reasons.join(" | ")}`]
                    : [] as any),
                ...(appliedAttenuationFactor < 1 ? [`Motion amplitude attenuated to ${round2(appliedAttenuationFactor)}x after validation backoff.`] : [] as any),
                ...preflight.warnings,
                ...postflight.warnings,
            ].filter((warning, index, all) => all.indexOf(warning) === index),
            stabilized: true,
            refinedChains: 0,
            chainIds: [] as any,
            suppressedKeyframes: 0,
            debugReport: buildMotionDebugReport({
                motion: params.motion,
                style: params.style,
                durationSeconds,
                affordance: motionAffordance,
                inferredSpec,
                modelSpec: structuredSpecResult.spec,
                finalSpec: resolvedMotionSpec,
                preflight,
                qualityGrade,
                attempts,
                finalStatus: "compiled",
                finalMessage: "Playable motion clip compiled successfully.",
            }),
        },
        usage: structuredSpecResult.usage,
    };
}

function normalizeLocomotionMode(value: unknown): MotionSpec["locomotion"]["mode"] | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
    if (!normalized) return undefined;
    if (normalized === "none" || normalized === "translate" || normalized === "arc") return normalized;
    if (normalized === "stop_at_contact" || normalized === "slide_on_contact" || normalized === "bounce_on_contact") {
        return normalized;
    }
    if (/turn|pivot|rotate|spin|orbit|curve|veer/.test(normalized)) return "arc";
    if (/slide|glide|skid/.test(normalized)) return "slide_on_contact";
    if (/bounce|collide|impact|slam|ricochet/.test(normalized)) return "bounce_on_contact";
    if (/stop|halt|freeze|brace|settle|land/.test(normalized)) return "stop_at_contact";
    if (/move|travel|cross|enter|exit|approach|advance|retreat|follow|pursue|flow|swim|fly|crawl|dash|walk|run|jump|roll|scoot|skate/.test(normalized)) {
        return "translate";
    }
    return undefined;
}

function normalizeMotionDirection(value: unknown): MotionSpec["locomotion"]["preferredDirection"] | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
    if (!normalized) return undefined;
    if (normalized.includes("left")) return "left";
    if (normalized.includes("right")) return "right";
    if (normalized.includes("up") || normalized.includes("rise") || normalized.includes("ascend")) return "up";
    if (normalized.includes("down") || normalized.includes("descend") || normalized.includes("drop")) return "down";
    if (normalized.includes("back") || normalized.includes("rear") || normalized.includes("away") || normalized.includes("retreat")) {
        return "backward";
    }
    if (normalized.includes("forward") || normalized.includes("ahead") || normalized.includes("front") || normalized.includes("toward")) {
        return "forward";
    }
    return undefined;
}

function normalizeGeneratedMotionSpecPayload(payload: unknown): unknown {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const value = payload as Record<string, unknown>;
    const locomotion = value.locomotion && typeof value.locomotion === "object" && !Array.isArray(value.locomotion)
        ? value.locomotion as Record<string, unknown>
        : {};
    const restLocomotion = { ...locomotion };
    delete restLocomotion.mode;
    delete restLocomotion.preferredDirection;
    const normalizedMode = normalizeLocomotionMode(locomotion.mode);
    const normalizedDirection = normalizeMotionDirection(locomotion.preferredDirection);

    return {
        ...value,
        locomotion: {
            ...restLocomotion,
            ...(normalizedMode ? { mode: normalizedMode } : {}),
            ...(normalizedDirection ? { preferredDirection: normalizedDirection } : {}),
        },
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
    const motionAffordance = inferRigMotionAffordance(normalizedRig);
    const rigProfileReport = normalizedRig.rig_data.profile_report ?? inferRigProfile(normalizedRig);
    const prefersRigidRootMotion = rigProfileReport.profile !== "articulated";
    const motionSpecModel = "gemini-3.1-pro-preview";
    const motionStrategyGuidance = rigProfileReport.profile === "rigid_object"
        ? "This rig is effectively rigid. Realism must come from whole-object motion timing. Provide explicit rootMotion plus a wholeObjectMotion anchor recipe with anticipation, push, travel, impact, overshoot, or settle where appropriate. Avoid internal deformation except for the smallest safe accents."
        : rigProfileReport.profile === "limited_articulation"
            ? "This rig has limited articulation. Favor rootMotion and restrained primary-chain deformation. Avoid spreading large waves across secondary branches."
            : "This rig can support internal deformation. Use axialWaves for chain motion and rootMotion for believable weight shift and travel.";

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

Rig motion affordance profile:
${JSON.stringify(motionAffordance, null, 2)}

Deterministic rig profile:
${JSON.stringify(rigProfileReport, null, 2)}

Motion strategy guidance:
${motionStrategyGuidance}

Rules:
1. FORMATTING & SCHEMAS: Output ONLY JSON. Use exact bone/node IDs for 'leadBones' and 'contacts'. All enums (view, locomotion.mode, locomotion.preferredDirection) must strictly match the available values.
2. PHYSICS & LIMITS: Stay comfortably inside 'usableRotationLimit'. Respect the 'motion affordance profile' (favor translation/root-motion for rigid/limited subjects). Make sure looping clips close cleanly onto frame 0.
3. ANIMATION STRATEGY (CRITICAL):
   - Use 'rotationTracks' to explicitly keyframe local rotation for semantic limbs (walking, running, kicking).
   - Use 'axialWaves' ONLY for procedural, flowing, or breathing motions (tails, snakes).
   - Provide explicit 'rootMotion' or 'wholeObjectMotion' anchors for weight-shifts, hopping, or travel realism, especially for rigid subjects.

JSON shape:
{
  "motionFamily": "swim",
  "tempo": 0.9,
  "amplitude": 0.8,
  "intensity": 0.5,
  "preferredView": "view_side_right",
  "locomotion": { "mode": "translate", "preferredDirection": "right" },
  "contacts": [{ "boneId": "segment_03", "target": "wall", "phaseStart": 0, "phaseEnd": 1 }],
  "leadBones": ["hip_l", "hip_r"],
  "rotationTracks": [
    {
      "nodeId": "hip_l",
      "samples": [
        { "t": 0.0, "rotation": 25 },
        { "t": 0.5, "rotation": -25 },
        { "t": 1.0, "rotation": 25 }
      ]
    },
    {
      "nodeId": "hip_r",
      "samples": [
        { "t": 0.0, "rotation": -25 },
        { "t": 0.5, "rotation": 25 },
        { "t": 1.0, "rotation": -25 }
      ]
    }
  ],
  "rootMotion": [
    { "t": 0.0, "y": 0 }, { "t": 0.25, "y": -4 }, { "t": 0.5, "y": 0 }, { "t": 0.75, "y": 4 }, { "t": 1.0, "y": 0 }
  ],
  "wholeObjectMotion": {
    "anchors": [
      { "t": 0.0, "label": "anticipation", "x": 0, "y": 0, "rotation": 0, "scale": 1.0 },
      { "t": 0.2, "label": "push", "x": -4, "y": 2, "rotation": -6, "scale": 0.98 },
      { "t": 0.55, "label": "travel", "x": 10, "y": -3, "rotation": 4, "scale": 1.0 },
      { "t": 0.82, "label": "overshoot", "x": 2, "y": 1, "rotation": -2, "scale": 1.01 },
      { "t": 1.0, "label": "settle", "x": 0, "y": 0, "rotation": 0, "scale": 1.0 }
    ]
  },
  "blockedReasons": [] as any,
  "notes": "Semantic walk cycle loop with keyframed leg wings and root bobbing."
}
`;

    const maxGenerationPasses = rigProfileReport.profile === "rigid_object" ? 2 : 1;
    const usageTotals = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
    };
    let parsed: MotionSpec | undefined;
    let rejectionFeedback = "";

    for (let pass = 1; pass <= maxGenerationPasses; pass += 1) {
        const attemptPrompt = rejectionFeedback
            ? `${prompt}

Revision feedback for the previous rejected rigid-motion spec:
${rejectionFeedback}

Return a revised JSON motion spec only.`
            : prompt;
        const response = await runGeminiRequestWithRetry(
            `Draftsman motion-spec request${maxGenerationPasses > 1 ? ` pass ${pass}` : ""}`,
            () => ai.models.generateContent({
                model: motionSpecModel,
                contents: [{ role: "user", parts: [{ text: attemptPrompt }] }],
                config: {
                    temperature: 0.2,
                }
            }),
        );
        usageTotals.promptTokenCount += response.usageMetadata?.promptTokenCount || 0;
        usageTotals.candidatesTokenCount += response.usageMetadata?.candidatesTokenCount || 0;
        usageTotals.totalTokenCount += response.usageMetadata?.totalTokenCount || 0;

        const text = extractJSONObject(
            response.text || "",
            "Gemini returned an empty motion spec response.",
            "No JSON motion spec found in Gemini response.",
        );
        let rawJson: any;
        try {
            rawJson = JSON.parse(text);
        } catch (e: any) {
            rejectionFeedback = `Invalid JSON format: ${e.message}`;
            continue;
        }

        const safeParsed = MotionSpecSchema.safeParse(normalizeGeneratedMotionSpecPayload(rawJson));
        if (!safeParsed.success) {
            rejectionFeedback = `JSON Schema violation:\n${safeParsed.error.message}`;
            continue;
        }

        parsed = constrainMotionSpecToRig(
            normalizedRig,
            safeParsed.data,
        );

        if (!prefersRigidRootMotion) {
            break;
        }

        const qualityGrade = gradeMotionQuality({
            affordance: motionAffordance,
            motionSpec: parsed,
        });
        if (qualityGrade.acceptable || pass === maxGenerationPasses) {
            break;
        }

        rejectionFeedback = [
            `The previous spec scored ${qualityGrade.score}/5 for the rigid_root_motion quality gate and was rejected.`,
            ...qualityGrade.reasons.map((reason) => `- ${reason}`),
            `Current metrics: rootSampleCount=${qualityGrade.metrics.rootSampleCount}, meaningfulInteriorRootSamples=${qualityGrade.metrics.meaningfulInteriorRootSamples}, activeRootAxes=${qualityGrade.metrics.activeRootAxes.join(", ") || "none"}, waveCount=${qualityGrade.metrics.waveCount}, maxWaveAmplitudeDeg=${qualityGrade.metrics.maxWaveAmplitudeDeg}.`,
            "Revise toward richer whole-object rootMotion timing, an explicit wholeObjectMotion anchor recipe, and less internal deformation unless the topology safely supports it.",
        ].join("\n");
    }

    if (!parsed) {
        throw new Error("Motion-spec generation did not produce a parsed result.");
    }

    return {
        spec: parsed,
        usage: usageTotals,
    };
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Point = { x: number; y: number };
type SimpleTransform = { tx: number; ty: number; sx: number; sy: number };

function assignBoneZIndexFromSvgOrder<T extends { id: string; zIndex?: number }>(
    bones: T[],
    svgElement: Element,
): T[] {
    const boneIds = new Set(bones.map((bone) => bone.id));
    const scopedOrderById = new Map<string, number>();
    const globalOrderById = new Map<string, number>();

    Array.from(svgElement.children)
        .filter((child): child is Element => child.tagName.toLowerCase() === "g" && Boolean(child.getAttribute("id")))
        .forEach((group) => {
            let localIndex = 0;
            Array.from(group.querySelectorAll("g[id]")).forEach((element) => {
                const id = element.getAttribute("id");
                if (!id || !boneIds.has(id) || scopedOrderById.has(id)) return;
                scopedOrderById.set(id, localIndex);
                localIndex += 1;
            });
        });

    Array.from(svgElement.querySelectorAll("g[id]")).forEach((element, index) => {
        const id = element.getAttribute("id");
        if (!id || !boneIds.has(id) || globalOrderById.has(id)) return;
        globalOrderById.set(id, index);
    });

    return bones.map((bone) => {
        if (typeof bone.zIndex === "number") return bone;
        const zIndex = scopedOrderById.get(bone.id) ?? globalOrderById.get(bone.id);
        return typeof zIndex === "number" ? { ...bone, zIndex } : bone;
    });
}

function inferScopedViewId(value: string): string | undefined {
    const lower = value.toLowerCase();
    const genericPrefix = lower.match(/^([a-z0-9_]+)__/);
    if (genericPrefix) {
        return normalizeViewId(`view_${genericPrefix[1]}`);
    }
    return matchLegacyViewPrefix(lower)?.viewId;
}

function pruneRigToRequestedViews(data: DraftsmanData, requestedViews: string[]): DraftsmanData {
    const keepViews = new Set(normalizeViewIds(requestedViews, "view_3q_right"));
    try {
        const dom = new JSDOM(data.svg_data, { contentType: "image/svg+xml" });
        const document = dom.window.document;
        const svgElement = document.querySelector("svg");
        if (!svgElement) return data;

        Array.from(svgElement.querySelectorAll<SVGGElement>('g[id^="view_"]')).forEach((viewGroup) => {
            const normalizedViewId = normalizeViewId(viewGroup.id);
            if (!normalizedViewId || keepViews.has(normalizedViewId)) return;
            viewGroup.remove();
        });

        const primaryView = normalizeViewIds(requestedViews, "view_3q_right")[0] || "view_3q_right";
        Array.from(svgElement.querySelectorAll<SVGGElement>('g[id^="view_"]')).forEach((viewGroup) => {
            const normalizedViewId = normalizeViewId(viewGroup.id);
            if (!normalizedViewId) return;
            viewGroup.setAttribute("display", normalizedViewId === primaryView ? "inline" : "none");
        });

        const keepScopedId = (id: string) => {
            const scopedViewId = inferScopedViewId(id);
            return !scopedViewId || keepViews.has(scopedViewId);
        };

        return {
            ...data,
            svg_data: svgElement.outerHTML,
            rig_data: {
                ...data.rig_data,
                bones: data.rig_data.bones.filter((bone) => keepScopedId(bone.id)),
                interactionNulls: data.rig_data.interactionNulls.filter((id) => keepScopedId(id)),
            },
        };
    } catch {
        return data;
    }
}

function postProcessAndRepairSVG(rawSvgString: string, rigMap: DraftsmanData["rig_data"]): { svg_data: string; rig_data: DraftsmanData["rig_data"] } {
    // 1. Parse string into a manipulatable DOM tree
    const dom = new JSDOM(rawSvgString, { contentType: "image/svg+xml" });
    const document = dom.window.document;
    const svgElement = document.querySelector("svg");

    if (!svgElement) return { svg_data: rawSvgString, rig_data: rigMap }; // Failsafe fallback

    const repairedRig = JSON.parse(JSON.stringify(rigMap)) as DraftsmanData["rig_data"];
    const fixes: string[] = [];
    const warnings: string[] = [];
    const drawOrder = captureElementDrawOrder(svgElement);
    const zIndexById = new Map(
        repairedRig.bones
            .filter((bone) => typeof bone.zIndex === "number")
            .map((bone) => [bone.id, bone.zIndex as number]),
    );

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
    const inferBoneViewId = (boneId: string): string => {
        const lower = boneId.toLowerCase();
        const genericPrefix = lower.match(/^([a-z0-9_]+)__/);
        if (genericPrefix) {
            return normalizeViewId(`view_${genericPrefix[1]}`) || "view_default";
        }
        const legacy = matchLegacyViewPrefix(lower);
        return legacy?.viewId || "view_default";
    };

    const rebuildChildrenByParent = () => {
        const next = new Map<string, string[]>();
        repairedRig.bones.forEach((bone) => {
            if (!bone.parent) return;
            const list = next.get(bone.parent) || [];
            list.push(bone.id);
            next.set(bone.parent, list);
        });
        return next;
    };

    let childrenByParent = rebuildChildrenByParent();

    const getDescendantIds = (boneId: string, index: Map<string, string[]>) => {
        const descendants: string[] = [];
        const queue = [...(index.get(boneId) || [])];
        while (queue.length > 0) {
            const next = queue.shift()!;
            descendants.push(next);
            queue.push(...(index.get(next) || []));
        }
        return descendants;
    };

    const boneMap = () => new Map(repairedRig.bones.map((bone) => [bone.id, bone]));
    let currentBoneMap = boneMap();
    let elementBoxes = collectElementBoxes(svgElement);

    const rootBonesByView = repairedRig.bones.reduce<Map<string, string[]>>((acc, bone) => {
        if (bone.parent && currentBoneMap.has(bone.parent)) return acc;
        const viewId = inferBoneViewId(bone.id);
        const list = acc.get(viewId) || [];
        list.push(bone.id);
        acc.set(viewId, list);
        return acc;
    }, new Map<string, string[]>());

    rootBonesByView.forEach((rootIds, viewId) => {
        if (rootIds.length <= 1) return;

        const primaryRootId = [...rootIds].sort((left, right) => {
            const leftDescendants = getDescendantIds(left, childrenByParent).length;
            const rightDescendants = getDescendantIds(right, childrenByParent).length;
            if (rightDescendants !== leftDescendants) return rightDescendants - leftDescendants;
            const leftBox = elementBoxes.get(left);
            const rightBox = elementBoxes.get(right);
            const leftArea = leftBox ? boxWidth(leftBox) * boxHeight(leftBox) : 0;
            const rightArea = rightBox ? boxWidth(rightBox) * boxHeight(rightBox) : 0;
            if (rightArea !== leftArea) return rightArea - leftArea;
            return left.localeCompare(right);
        })[0];

        repairedRig.bones = repairedRig.bones.map((bone) => {
            if (!rootIds.includes(bone.id) || bone.id === primaryRootId) return bone;
            const primaryRoot = currentBoneMap.get(primaryRootId);
            const box = elementBoxes.get(bone.id);
            const socket = primaryRoot?.pivot && box ? nearestPointOnBox(box, primaryRoot.pivot) : bone.socket;
            return {
                ...bone,
                parent: primaryRootId,
                socket: socket ? { x: round2(socket.x), y: round2(socket.y) } : bone.socket,
            };
        });

        rootIds
            .filter((rootId) => rootId !== primaryRootId)
            .forEach((rootId) => {
                const childEl = svgElement.querySelector(`g[id="${rootId}"]`) as Element | null;
                const parentEl = svgElement.querySelector(`g[id="${primaryRootId}"]`) as Element | null;
                if (childEl && parentEl && childEl !== parentEl) {
                    reparentPreservingDrawOrder(parentEl, childEl, drawOrder, zIndexById);
                }
            });

        fixes.push(`Collapsed ${rootIds.length} detached roots into a single structural root in ${viewId}.`);
        currentBoneMap = boneMap();
        childrenByParent = rebuildChildrenByParent();
        elementBoxes = collectElementBoxes(svgElement);
    });

    for (const bone of repairedRig.bones) {
        const element = svgElement.querySelector(`g[id="${bone.id}"]`) as Element | null;
        const box = elementBoxes.get(bone.id);
        const parent = bone.parent ? currentBoneMap.get(bone.parent) : undefined;

        if (!box) {
            warnings.push(`No measurable geometry found for #${bone.id}.`);
            continue;
        }

        // Detachment snapping logic removed: the LLM natively draws connected geometry.
        // Forcing child bounding boxes to snap to parent pivots mathematically destroys
        // extremities like hands and feet by teleporting them to elbows and knees.
    }

    currentBoneMap = boneMap();
    elementBoxes = collectElementBoxes(svgElement);

    repairedRig.bones = assignBoneZIndexFromSvgOrder(repairedRig.bones, svgElement).map((bone) => {
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

    const repairedRigWithoutIK = { ...repairedRig };
    delete repairedRigWithoutIK.ik;
    return ensureRigIK({ svg_data: svgElement.outerHTML, rig_data: repairedRigWithoutIK });
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
