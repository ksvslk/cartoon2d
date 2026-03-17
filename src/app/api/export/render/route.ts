import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runFfmpeg(args: string[], cwd: string) {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { cwd });
    let stderr = "";

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Render MP4 from previously uploaded frames.
 * Expects JSON body with: session, fileName, fps, width, height, audioMetadata
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { session, fileName: rawFileName, fps = 24, width = 1920, height = 1080, audioMetadata = [] } = body;

  if (!session) {
    return NextResponse.json({ error: "Missing session" }, { status: 400 });
  }

  const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, "");
  const sessionDir = join(tmpdir(), `cartoon2d-export-${safeSession}`);
  const fileName = (rawFileName || "cartoon-export.mp4")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "cartoon-export.mp4";

  try {
    const files = await readdir(sessionDir);
    const frameFiles = files.filter(f => f.startsWith("frame-") && f.endsWith(".png")).sort();

    if (frameFiles.length === 0) {
      return NextResponse.json({ error: "No frames found in session." }, { status: 400 });
    }

    console.log(`[Export Render] Session ${safeSession}: ${frameFiles.length} frames, ${audioMetadata.length} audio, ${width}x${height}@${fps}fps`);

    const outputPath = join(sessionDir, fileName);

    const ffmpegArgs = [
      "-y",
      "-framerate", String(fps),
      "-i", "frame-%06d.png",
    ];

    for (const meta of audioMetadata) {
      ffmpegArgs.push("-i", meta.filename);
    }

    ffmpegArgs.push(
      "-r", String(fps),
      "-fps_mode", "cfr",
      "-vf", `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "10",
      "-pix_fmt", "yuv420p"
    );

    if (audioMetadata.length > 0) {
      const filterParts: string[] = [];
      for (let i = 0; i < audioMetadata.length; i++) {
        const meta = audioMetadata[i];
        const delayMs = Math.round(meta.start * 1000);
        filterParts.push(`[${i+1}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
      }
      const mixInputs = audioMetadata.map((_: unknown, i: number) => `[a${i}]`).join("");
      filterParts.push(`${mixInputs}amix=inputs=${audioMetadata.length}:duration=longest:dropout_transition=2[aout]`);

      ffmpegArgs.push(
        "-filter_complex", filterParts.join(";"),
        "-map", "0:v",
        "-map", "[aout]",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000"
      );
    }

    ffmpegArgs.push("-movflags", "+faststart", outputPath);

    await runFfmpeg(ffmpegArgs, sessionDir);

    const outputBuffer = await readFile(outputPath);
    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Export-Filename": fileName,
      },
    });
  } catch (error) {
    console.error("Export render failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MP4 render failed." },
      { status: 500 },
    );
  } finally {
    // Clean up session directory
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
