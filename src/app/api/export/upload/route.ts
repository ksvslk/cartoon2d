import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload a single frame or audio file to a session temp directory.
 * Each request is small (<500KB) so it stays well under Next.js body limits.
 * 
 * Query params:
 *   session - unique session ID
 *   name    - filename (e.g. "frame-000001.png" or "audio-0.wav")
 */
export async function POST(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session");
  const name = request.nextUrl.searchParams.get("name");

  if (!session || !name) {
    return NextResponse.json({ error: "Missing session or name param" }, { status: 400 });
  }

  // Sanitize session ID to prevent path traversal
  const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "");

  const sessionDir = join(tmpdir(), `cartoon2d-export-${safeSession}`);
  await mkdir(sessionDir, { recursive: true });

  const data = Buffer.from(await request.arrayBuffer());
  await writeFile(join(sessionDir, safeName), data);

  return NextResponse.json({ ok: true, size: data.length });
}
