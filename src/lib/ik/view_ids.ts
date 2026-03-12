export const CANONICAL_VIEW_IDS = [
  "view_front",
  "view_3q_right",
  "view_side_right",
  "view_3q_left",
  "view_side_left",
  "view_top",
  "view_back",
  "view_default",
] as const;

export const LEGACY_VIEW_PREFIXES = [
  { viewId: "view_front", prefix: "front_" },
  { viewId: "view_side_right", prefix: "side_" },
  { viewId: "view_side_right", prefix: "side_right_" },
  { viewId: "view_side_left", prefix: "side_left_" },
  { viewId: "view_3q_right", prefix: "3q_" },
  { viewId: "view_3q_right", prefix: "3q_right_" },
  { viewId: "view_3q_left", prefix: "3q_left_" },
  { viewId: "view_top", prefix: "top_" },
  { viewId: "view_back", prefix: "back_" },
] as const;

const SORTED_LEGACY_VIEW_PREFIXES = [...LEGACY_VIEW_PREFIXES].sort((left, right) => {
  const lengthDelta = right.prefix.length - left.prefix.length;
  return lengthDelta !== 0 ? lengthDelta : left.prefix.localeCompare(right.prefix);
});

const VIEW_ALIASES = new Map<string, string>([
  ["front", "view_front"],
  ["view_front", "view_front"],
  ["three_quarter_right", "view_3q_right"],
  ["three_quarters_right", "view_3q_right"],
  ["three_quarter", "view_3q_right"],
  ["three_quarters", "view_3q_right"],
  ["3q", "view_3q_right"],
  ["3q_right", "view_3q_right"],
  ["view_3q_right", "view_3q_right"],
  ["three_quarter_left", "view_3q_left"],
  ["three_quarters_left", "view_3q_left"],
  ["3q_left", "view_3q_left"],
  ["view_3q_left", "view_3q_left"],
  ["side", "view_side_right"],
  ["profile", "view_side_right"],
  ["side_right", "view_side_right"],
  ["view_side_right", "view_side_right"],
  ["side_left", "view_side_left"],
  ["view_side_left", "view_side_left"],
  ["top", "view_top"],
  ["overhead", "view_top"],
  ["view_top", "view_top"],
  ["back", "view_back"],
  ["rear", "view_back"],
  ["view_back", "view_back"],
  ["default", "view_default"],
  ["view_default", "view_default"],
]);

export function normalizeViewId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return undefined;
  return VIEW_ALIASES.get(normalized) || (normalized.startsWith("view_") ? normalized : `view_${normalized}`);
}

export function normalizeViewIds(
  values: Array<string | null | undefined>,
  fallback: string = "view_3q_right",
): string[] {
  const normalized = values
    .map((value) => normalizeViewId(value))
    .filter((value): value is string => Boolean(value));
  if (normalized.length === 0) {
    return [normalizeViewId(fallback) || "view_3q_right"];
  }
  return Array.from(new Set(normalized));
}

export function viewSlugFromId(viewId: string): string {
  const normalized = normalizeViewId(viewId) || "view_default";
  return normalized.replace(/^view_/, "");
}

export function genericViewPrefixForId(viewId: string): string {
  return `${viewSlugFromId(viewId)}__`;
}

export function prefixCandidatesForViewId(viewId: string): string[] {
  const normalized = normalizeViewId(viewId) || viewId;
  return Array.from(new Set([
    ...LEGACY_VIEW_PREFIXES
      .filter((entry) => entry.viewId === normalized)
      .map((entry) => entry.prefix),
    genericViewPrefixForId(normalized),
  ])).sort((left, right) => right.length - left.length);
}

export function matchLegacyViewPrefix(value: string): (typeof LEGACY_VIEW_PREFIXES)[number] | undefined {
  const lower = value.toLowerCase();
  return SORTED_LEGACY_VIEW_PREFIXES.find(({ prefix }) => lower.startsWith(prefix));
}
