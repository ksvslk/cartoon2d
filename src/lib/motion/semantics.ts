export function normalizeMotionKey(motion: string): string {
  return motion
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function motionNeedsTarget(motion: string): boolean {
  const key = normalizeMotionKey(motion);
  return /walk|run|jump|swim|crawl|fly|slither|glide|drive|skate|roll|scoot|dash|march|sprint|leap|hop|drift|charge|chase|race|slide/.test(key);
}

export function inferAutoTargetTransform(
  motion: string,
  start: { x: number; y: number; scale: number },
  durationSeconds: number,
  stageW = 1920,
): { x: number; y: number; scale: number } | undefined {
  if (!motionNeedsTarget(motion)) return undefined;

  const travel = Math.max(220, Math.round(durationSeconds * 180));
  const preferredDirection = start.x <= stageW / 2 ? 1 : -1;
  const unclampedX = start.x + travel * preferredDirection;
  const clampedX = Math.max(140, Math.min(stageW - 140, unclampedX));

  return {
    x: clampedX,
    y: start.y,
    scale: start.scale,
  };
}

export function suggestMotionAliases(motion: string): string[] {
  const key = normalizeMotionKey(motion);
  const aliases = new Set<string>([key]);

  if (/stare|look|watch|glance|peek/.test(key)) aliases.add("idle");
  if (/swim|glide|drift/.test(key)) aliases.add("idle");
  if (/talk|speak|announce|narrate|say|tell|chat|present/.test(key)) aliases.add("idle");
  if (/crawl|creep|sneak|tiptoe|march/.test(key)) aliases.add("walk");
  if (/sprint|dash|charge|chase|race/.test(key)) aliases.add("run");
  if (/hop|leap|bounce/.test(key)) aliases.add("jump");
  if (/greet|hello|salute/.test(key)) aliases.add("wave");
  if (/duck|crouch|kneel/.test(key)) aliases.add("sit");
  if (/celebrate|cheer|victory/.test(key)) aliases.add("celebrate");

  return Array.from(aliases);
}
