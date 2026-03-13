import gsap from "gsap";

export type AmbientLabel =
  | "flicker"
  | "rise"
  | "ripple"
  | "sway"
  | "wave"
  | "drift"
  | "pulse";

export interface AmbientPattern {
  regex: RegExp;
  label: AmbientLabel;
}

export interface BackgroundAmbientBindingData {
  id: string;
  target_id: string;
  label: AmbientLabel;
  start_time: number;
  duration_seconds: number;
}

export const OBJECT_ANIM_PATTERNS: AmbientPattern[] = [
  { regex: /fire|flame|blaze/i, label: "flicker" },
  { regex: /smoke|steam|mist|vapor/i, label: "rise" },
  { regex: /water|wave|ripple|river|ocean|sea|lake/i, label: "ripple" },
  { regex: /leaf|foliage|tree|bush|grass|plant|vine/i, label: "sway" },
  { regex: /flag|banner|cloth|curtain|drape/i, label: "wave" },
  { regex: /cloud/i, label: "drift" },
  { regex: /light|lamp|glow|blink|flash/i, label: "pulse" },
];



function getAmbientTweenSpec(label: AmbientLabel): {
  vars: gsap.TweenVars;
  duration: number;
  yoyo: boolean;
} {
  switch (label) {
    case "flicker":
      return {
        vars: {
          scaleY: 1.12,
          scaleX: 0.92,
          ease: "none",
          transformOrigin: "center bottom",
        },
        duration: 0.12,
        yoyo: true,
      };
    case "rise":
      return {
        vars: {
          y: "-=18",
          opacity: 0.3,
          ease: "sine.inOut",
        },
        duration: 2.4,
        yoyo: true,
      };
    case "ripple":
      return {
        vars: {
          x: "+=10",
          ease: "sine.inOut",
        },
        duration: 1.5,
        yoyo: true,
      };
    case "sway":
      return {
        vars: {
          rotation: 4,
          ease: "sine.inOut",
          transformOrigin: "center bottom",
        },
        duration: 2.0,
        yoyo: true,
      };
    case "wave":
      return {
        vars: {
          rotation: 6,
          ease: "sine.inOut",
          transformOrigin: "left center",
        },
        duration: 0.9,
        yoyo: true,
      };
    case "drift":
      return {
        vars: {
          x: "+=30",
          ease: "sine.inOut",
        },
        duration: 10,
        yoyo: true,
      };
    case "pulse":
      return {
        vars: {
          opacity: 0.4,
          ease: "sine.inOut",
        },
        duration: 1.2,
        yoyo: true,
      };
    default:
      return {
        vars: { opacity: 0.85, ease: "sine.inOut" },
        duration: 1.5,
        yoyo: true,
      };
  }
}

export function classifyAmbientId(id: string): AmbientLabel | null {
  for (const { regex, label } of OBJECT_ANIM_PATTERNS) {
    if (regex.test(id)) return label;
  }
  return null;
}

export function detectAmbientIdsFromSvg(svgData: string): Array<{ id: string; label: AmbientLabel }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; label: AmbientLabel }> = [];
  const idRegex = /id=(["'])(.*?)\1/g;
  let match: RegExpExecArray | null;

  while ((match = idRegex.exec(svgData)) !== null) {
    const id = match[2];
    if (!id || seen.has(id)) continue;
    const label = classifyAmbientId(id);
    if (!label) continue;
    seen.add(id);
    result.push({ id, label });
  }

  return result;
}

export function detectAmbientElements(container: HTMLElement): Array<{ id: string; label: AmbientLabel; element: Element }> {
  const result: Array<{ id: string; label: AmbientLabel; element: Element }> = [];
  container.querySelectorAll("[id]").forEach((el) => {
    const id = el.getAttribute("id") || "";
    const label = classifyAmbientId(id);
    if (!label) return;
    result.push({ id, label, element: el });
  });
  return result;
}

export function playAmbientLoopOnElement(el: Element, label: AmbientLabel) {
  const spec = getAmbientTweenSpec(label);
  gsap.to(el, {
    ...spec.vars,
    duration: spec.duration,
    yoyo: spec.yoyo,
    repeat: -1,
    overwrite: "auto",
  });
}

export function addAmbientBindingToTimeline(
  tl: gsap.core.Timeline,
  target: string,
  binding: BackgroundAmbientBindingData,
  overrideDurationSeconds?: number
) {
  const spec = getAmbientTweenSpec(binding.label);

  // Isolate infinite loop to prevent GSAP from extending the master `.duration()`
  const proxy = gsap.timeline({ paused: true });
  proxy.to(target, {
    ...spec.vars,
    duration: spec.duration,
    yoyo: spec.yoyo,
    repeat: -1,
    overwrite: "auto",
  });

  const durationToUse = overrideDurationSeconds ?? binding.duration_seconds;

  // Explicitly box the playback time into the master timeline boundaries
  tl.to(
    proxy,
    {
      time: durationToUse,
      duration: durationToUse,
      ease: "none",
      data: "ambient-loop",
    },
    binding.start_time,
  );
}
