function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function collectErrorParts(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);

  if (typeof error === "string") return [error];
  if (typeof error === "number" || typeof error === "boolean") return [String(error)];

  if (error instanceof Error) {
    const parts = error.message ? [error.message] : [];
    const errorWithCause = error as Error & { cause?: unknown };
    if (errorWithCause.cause !== undefined) {
      parts.push(...collectErrorParts(errorWithCause.cause, seen));
    }
    const record = asRecord(error);
    if (record) {
      if (typeof record.code === "string") parts.push(record.code);
      if (typeof record.status === "number") parts.push(String(record.status));
      if (typeof record.statusText === "string") parts.push(record.statusText);
      if (record.error !== undefined) parts.push(...collectErrorParts(record.error, seen));
    }
    return parts;
  }

  const record = asRecord(error);
  if (record) {
    const parts: string[] = [];
    if (typeof record.message === "string") parts.push(record.message);
    if (typeof record.code === "string") parts.push(record.code);
    if (typeof record.status === "number") parts.push(String(record.status));
    if (typeof record.statusText === "string") parts.push(record.statusText);
    if (record.error !== undefined) parts.push(...collectErrorParts(record.error, seen));
    return parts;
  }

  return [String(error)];
}

function describeError(error: unknown): string {
  const parts = collectErrorParts(error)
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(" | ");
}

function extractStatusCode(error: unknown): number | undefined {
  const record = asRecord(error);
  if (record && typeof record.status === "number") return record.status;
  if (error instanceof Error) {
    const errorRecord = asRecord(error);
    if (errorRecord && typeof errorRecord.status === "number") return errorRecord.status;
  }
  return undefined;
}

function isTransientGeminiError(error: unknown): boolean {
  const status = extractStatusCode(error);
  if (status !== undefined && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const text = describeError(error).toLowerCase();
  if (!text) return false;

  return [
    "fetch failed",
    "network",
    "socket",
    "econnreset",
    "etimedout",
    "timed out",
    "timeout",
    "aborted",
    "connection reset",
    "connection closed",
    "temporarily unavailable",
    "temporary",
    "overloaded",
    "rate limit",
    "resource exhausted",
    "deadline exceeded",
    "try again",
    "internal error",
    "unavailable",
  ].some((token) => text.includes(token));
}

function buildRetryErrorMessage(label: string, attempts: number, error: unknown, transient: boolean): string {
  const detail = describeError(error) || "Unknown Gemini request error.";
  if (transient) {
    return `${label} failed after ${attempts} attempts. Last error: ${detail}. This usually means a temporary Gemini network issue, rate limit, or model-side timeout. Retry the action.`;
  }
  return `${label} failed: ${detail}`;
}

export async function runGeminiRequestWithRetry<T>(
  label: string,
  request: () => Promise<T>,
  options?: {
    attempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const attempts = Math.max(1, options?.attempts || 3);
  const maxDelayMs = Math.max(250, options?.maxDelayMs || 4000);
  let delayMs = Math.max(250, options?.initialDelayMs || 900);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const transient = isTransientGeminiError(error);
      const hasAttemptsLeft = attempt < attempts;

      if (!transient || !hasAttemptsLeft) {
        throw new Error(buildRetryErrorMessage(label, attempt, error, transient));
      }

      console.warn(`[Gemini:${label}] Attempt ${attempt}/${attempts} failed: ${describeError(error) || "unknown error"}. Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
      delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.8));
    }
  }

  throw new Error(buildRetryErrorMessage(label, attempts, lastError, isTransientGeminiError(lastError)));
}
