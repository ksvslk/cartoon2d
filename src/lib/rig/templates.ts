import { RigBone } from "@/lib/schema/rig";

/**
 * A flawlessly constructed biped side-profile skeletal template.
 * By removing this generation from the LLM and hardcoding the topological rules,
 * we save massive token counts and guarantee 100% solver stability.
 * 
 * The `{{prefix}}` token is replaced at rig-compile time with the actual view ID.
 */
export const BIPED_SIDE_RIG_TEMPLATE: Omit<RigBone, 'pivot'|'socket'>[] = [
    { id: "{{prefix}}root",  zIndex: 10, kind: "root", side: "center", massClass: "heavy" },
    { id: "{{prefix}}core", parent: "{{prefix}}root", rotationLimit: [-35, 35], zIndex: 20, kind: "body", side: "center", massClass: "heavy" },
    { id: "{{prefix}}neck", parent: "{{prefix}}core", rotationLimit: [-45, 45], zIndex: 18, kind: "neck", side: "center", massClass: "medium" },
    { id: "{{prefix}}head", parent: "{{prefix}}neck", rotationLimit: [-45, 45], zIndex: 45, kind: "head", side: "center", massClass: "heavy", contactRole: "none" },
    { id: "{{prefix}}jaw", parent: "{{prefix}}head", rotationLimit: [0, 45], zIndex: 46, kind: "jaw", side: "center", massClass: "light" },
    { id: "{{prefix}}eye_l", parent: "{{prefix}}head", zIndex: 47, kind: "other", side: "left", massClass: "light" },
    { id: "{{prefix}}eye_r", parent: "{{prefix}}head", zIndex: 48, kind: "other", side: "right", massClass: "light" },
    
    // Background Arm
    { id: "{{prefix}}arm_upper_l", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 5, kind: "arm_upper", side: "left", massClass: "medium" },
    { id: "{{prefix}}arm_lower_l", parent: "{{prefix}}arm_upper_l", rotationLimit: [0, 160], zIndex: 4, kind: "arm_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}hand_l", parent: "{{prefix}}arm_lower_l", rotationLimit: [-45, 45], zIndex: 3, kind: "hand", side: "left", massClass: "light", contactRole: "grip" },

    // Background Leg
    { id: "{{prefix}}leg_upper_l", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 7, kind: "leg_upper", side: "left", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_l", parent: "{{prefix}}leg_upper_l", rotationLimit: [-160, 0], zIndex: 6, kind: "leg_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}foot_l", parent: "{{prefix}}leg_lower_l", rotationLimit: [-45, 45], zIndex: 5, kind: "foot", side: "left", massClass: "medium", contactRole: "ground" },

    // Foreground Leg
    { id: "{{prefix}}leg_upper_r", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 15, kind: "leg_upper", side: "right", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_r", parent: "{{prefix}}leg_upper_r", rotationLimit: [-160, 0], zIndex: 16, kind: "leg_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}foot_r", parent: "{{prefix}}leg_lower_r", rotationLimit: [-45, 45], zIndex: 17, kind: "foot", side: "right", massClass: "medium", contactRole: "ground" },

    // Foreground Arm
    { id: "{{prefix}}arm_upper_r", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 25, kind: "arm_upper", side: "right", massClass: "medium" },
    { id: "{{prefix}}arm_lower_r", parent: "{{prefix}}arm_upper_r", rotationLimit: [0, 160], zIndex: 26, kind: "arm_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}hand_r", parent: "{{prefix}}arm_lower_r", rotationLimit: [-45, 45], zIndex: 27, kind: "hand", side: "right", massClass: "light", contactRole: "grip" },
];

/**
 * Front view template.
 * Both arms and legs are drawn IN FRONT of the core.
 */
export const BIPED_FRONT_RIG_TEMPLATE: Omit<RigBone, 'pivot'|'socket'>[] = [
    { id: "{{prefix}}root",  zIndex: 10, kind: "root", side: "center", massClass: "heavy" },
    { id: "{{prefix}}core", parent: "{{prefix}}root", rotationLimit: [-35, 35], zIndex: 20, kind: "body", side: "center", massClass: "heavy" },
    { id: "{{prefix}}neck", parent: "{{prefix}}core", rotationLimit: [-45, 45], zIndex: 18, kind: "neck", side: "center", massClass: "medium" },
    { id: "{{prefix}}head", parent: "{{prefix}}neck", rotationLimit: [-45, 45], zIndex: 45, kind: "head", side: "center", massClass: "heavy", contactRole: "none" },
    { id: "{{prefix}}jaw", parent: "{{prefix}}head", rotationLimit: [0, 45], zIndex: 46, kind: "jaw", side: "center", massClass: "light" },
    { id: "{{prefix}}eye_l", parent: "{{prefix}}head", zIndex: 47, kind: "other", side: "left", massClass: "light" },
    { id: "{{prefix}}eye_r", parent: "{{prefix}}head", zIndex: 48, kind: "other", side: "right", massClass: "light" },
    
    // Left Arm (Foreground)
    { id: "{{prefix}}arm_upper_l", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 25, kind: "arm_upper", side: "left", massClass: "medium" },
    { id: "{{prefix}}arm_lower_l", parent: "{{prefix}}arm_upper_l", rotationLimit: [0, 160], zIndex: 26, kind: "arm_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}hand_l", parent: "{{prefix}}arm_lower_l", rotationLimit: [-45, 45], zIndex: 27, kind: "hand", side: "left", massClass: "light", contactRole: "grip" },

    // Left Leg (Foreground)
    { id: "{{prefix}}leg_upper_l", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 25, kind: "leg_upper", side: "left", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_l", parent: "{{prefix}}leg_upper_l", rotationLimit: [-160, 0], zIndex: 26, kind: "leg_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}foot_l", parent: "{{prefix}}leg_lower_l", rotationLimit: [-45, 45], zIndex: 27, kind: "foot", side: "left", massClass: "medium", contactRole: "ground" },

    // Right Leg (Foreground)
    { id: "{{prefix}}leg_upper_r", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 25, kind: "leg_upper", side: "right", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_r", parent: "{{prefix}}leg_upper_r", rotationLimit: [-160, 0], zIndex: 26, kind: "leg_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}foot_r", parent: "{{prefix}}leg_lower_r", rotationLimit: [-45, 45], zIndex: 27, kind: "foot", side: "right", massClass: "medium", contactRole: "ground" },

    // Right Arm (Foreground)
    { id: "{{prefix}}arm_upper_r", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 25, kind: "arm_upper", side: "right", massClass: "medium" },
    { id: "{{prefix}}arm_lower_r", parent: "{{prefix}}arm_upper_r", rotationLimit: [0, 160], zIndex: 26, kind: "arm_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}hand_r", parent: "{{prefix}}arm_lower_r", rotationLimit: [-45, 45], zIndex: 27, kind: "hand", side: "right", massClass: "light", contactRole: "grip" },
];

/**
 * 3/4 view template.
 * Layers are staggered. Back arm is behind core, front arm is in front. 
 * Both legs might be slightly visible, but back leg is behind front leg.
 */
export const BIPED_3Q_RIG_TEMPLATE: Omit<RigBone, 'pivot'|'socket'>[] = [
    { id: "{{prefix}}root",  zIndex: 10, kind: "root", side: "center", massClass: "heavy" },
    { id: "{{prefix}}core", parent: "{{prefix}}root", rotationLimit: [-35, 35], zIndex: 20, kind: "body", side: "center", massClass: "heavy" },
    { id: "{{prefix}}neck", parent: "{{prefix}}core", rotationLimit: [-45, 45], zIndex: 18, kind: "neck", side: "center", massClass: "medium" },
    { id: "{{prefix}}head", parent: "{{prefix}}neck", rotationLimit: [-45, 45], zIndex: 45, kind: "head", side: "center", massClass: "heavy", contactRole: "none" },
    { id: "{{prefix}}jaw", parent: "{{prefix}}head", rotationLimit: [0, 45], zIndex: 46, kind: "jaw", side: "center", massClass: "light" },
    { id: "{{prefix}}eye_r", parent: "{{prefix}}head", zIndex: 48, kind: "other", side: "right", massClass: "light" },
    
    // Background Arm
    { id: "{{prefix}}arm_upper_l", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 5, kind: "arm_upper", side: "left", massClass: "medium" },
    { id: "{{prefix}}arm_lower_l", parent: "{{prefix}}arm_upper_l", rotationLimit: [0, 160], zIndex: 4, kind: "arm_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}hand_l", parent: "{{prefix}}arm_lower_l", rotationLimit: [-45, 45], zIndex: 3, kind: "hand", side: "left", massClass: "light", contactRole: "grip" },

    // Background Leg
    { id: "{{prefix}}leg_upper_l", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 7, kind: "leg_upper", side: "left", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_l", parent: "{{prefix}}leg_upper_l", rotationLimit: [-160, 0], zIndex: 6, kind: "leg_lower", side: "left", massClass: "medium" },
    { id: "{{prefix}}foot_l", parent: "{{prefix}}leg_lower_l", rotationLimit: [-45, 45], zIndex: 5, kind: "foot", side: "left", massClass: "medium", contactRole: "ground" },

    // Foreground Leg
    { id: "{{prefix}}leg_upper_r", parent: "{{prefix}}core", rotationLimit: [-120, 45], zIndex: 15, kind: "leg_upper", side: "right", massClass: "heavy" },
    { id: "{{prefix}}leg_lower_r", parent: "{{prefix}}leg_upper_r", rotationLimit: [-160, 0], zIndex: 16, kind: "leg_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}foot_r", parent: "{{prefix}}leg_lower_r", rotationLimit: [-45, 45], zIndex: 17, kind: "foot", side: "right", massClass: "medium", contactRole: "ground" },

    // Foreground Arm
    { id: "{{prefix}}arm_upper_r", parent: "{{prefix}}core", rotationLimit: [-180, 180], zIndex: 25, kind: "arm_upper", side: "right", massClass: "medium" },
    { id: "{{prefix}}arm_lower_r", parent: "{{prefix}}arm_upper_r", rotationLimit: [0, 160], zIndex: 26, kind: "arm_lower", side: "right", massClass: "medium" },
    { id: "{{prefix}}hand_r", parent: "{{prefix}}arm_lower_r", rotationLimit: [-45, 45], zIndex: 27, kind: "hand", side: "right", massClass: "light", contactRole: "grip" },
];

export const BIPED_TEMPLATE_EMOTIONS = ["emotion_neutral", "emotion_happy", "emotion_sad"];

export function selectTemplate(viewPrefix: string): Omit<RigBone, 'pivot'|'socket'>[] {
    let template = BIPED_SIDE_RIG_TEMPLATE;
    if (viewPrefix.includes("front")) template = BIPED_FRONT_RIG_TEMPLATE;
    else if (viewPrefix.includes("3q")) template = BIPED_3Q_RIG_TEMPLATE;

    const isLeftFacing = viewPrefix.includes("left");
    if (!isLeftFacing) return template;

    // The templates default to right-facing (right side is foreground/front, left is background/back).
    // If the view is left-facing, we mirror the zIndex values so the left side becomes the foreground.
    return template.map(bone => {
        let oppositeId = bone.id;
        if (bone.id.endsWith("_l")) oppositeId = bone.id.slice(0, -2) + "_r";
        else if (bone.id.endsWith("_r")) oppositeId = bone.id.slice(0, -2) + "_l";
        
        const oppositeBone = template.find(b => b.id === oppositeId);
        if (oppositeBone && oppositeBone.zIndex !== undefined) {
            return { ...bone, zIndex: oppositeBone.zIndex };
        }
        return bone;
    });
}

export function buildRigFromTemplate(viewPrefix: string, extractedData: Map<string, { pivot?: {x: number, y: number}, socket?: {x: number, y: number} }>): RigBone[] {
    const template = selectTemplate(viewPrefix);
    const result: RigBone[] = template.map(templateBone => {
        const actualId = templateBone.id.replace("{{prefix}}", viewPrefix);
        const actualParent = templateBone.parent?.replace("{{prefix}}", viewPrefix);
        
        const data = extractedData.get(actualId);

        return {
            ...templateBone,
            id: actualId,
            parent: actualParent,
            pivot: data?.pivot,
            socket: data?.socket,
        } as RigBone;
    });

    // Second pass: Fallback missing geometry to ensure 100% solver stability
    // If the AI hides a background limb (e.g. left arm on side_right), copy the foreground limb coordinates.
    for (const bone of result) {
        if (!bone.pivot || !bone.socket) {
            const oppositeSide = bone.side === 'left' ? 'right' : (bone.side === 'right' ? 'left' : null);
            if (oppositeSide) {
                const oppositeId = bone.id.replace(`_${bone.side}`, `_${oppositeSide}`);
                const oppBone = result.find(b => b.id === oppositeId);
                if (oppBone && oppBone.pivot) {
                    if (!bone.pivot) bone.pivot = { ...oppBone.pivot };
                    if (!bone.socket && oppBone.socket) bone.socket = { ...oppBone.socket };
                }
            }

            if (!bone.pivot && bone.parent) {
                const parentBone = result.find(b => b.id === bone.parent);
                if (parentBone && parentBone.pivot) {
                    bone.pivot = { ...parentBone.pivot };
                }
            }

            if (!bone.socket && bone.pivot) {
                bone.socket = { ...bone.pivot };
            }

            // Ultimate fallback to prevent NaN/crashes
            if (!bone.pivot) bone.pivot = { x: 500, y: 500 };
            if (!bone.socket) bone.socket = { x: 500, y: 500 };
        }
    }

    return result;
}
