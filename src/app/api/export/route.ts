import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeFileName(fileName: string) {
  return fileName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "cartoon-export.mp4";
}

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

export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "cartoon2d-export-"));

    const contentType = request.headers.get("content-type") || "";
    let fileName = "cartoon-export.mp4";
    let outputPath = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      fileName = sanitizeFileName(String(formData.get("fileName") || "cartoon-export.mp4"));
      const fps = Number(formData.get("fps") || 24);
      const width = Number(formData.get("width") || 1920);
      const height = Number(formData.get("height") || 1080);
      const frameFiles = formData.getAll("frames").filter((value): value is File => value instanceof File);

      if (frameFiles.length === 0) {
        return NextResponse.json({ error: "No PNG frames were provided for export." }, { status: 400 });
      }

      for (const frameFile of frameFiles) {
        const bytes = Buffer.from(await frameFile.arrayBuffer());
        await writeFile(join(tempDir, frameFile.name), bytes);
      }

      outputPath = join(tempDir, fileName);

      await runFfmpeg(
        [
          "-y",
          "-framerate", String(fps),
          "-i", "frame-%06d.png",
          "-r", String(fps),
          "-fps_mode", "cfr",
          "-vf", `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
          "-c:v", "libx264",
          "-preset", "slow",
          "-crf", "10",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          outputPath,
        ],
        tempDir,
      );
    } else {
      return NextResponse.json(
        { error: "Unsupported export request. Expected multipart PNG frame upload." },
        { status: 400 },
      );
    }

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
    console.error("Export route failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MP4 export failed." },
      { status: 500 },
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
