"use server";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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

export async function exportVideo(formData: FormData): Promise<{ data: string; fileName: string } | { error: string }> {
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "cartoon2d-export-"));

    const fileName = sanitizeFileName(String(formData.get("fileName") || "cartoon-export.mp4"));
    const fps = Number(formData.get("fps") || 24);
    const width = Number(formData.get("width") || 1920);
    const height = Number(formData.get("height") || 1080);
    const frameFiles = formData.getAll("frames").filter((value): value is File => value instanceof File);
    const audioFiles = formData.getAll("audio_files").filter((value): value is File => value instanceof File);
    const audioMetadataStr = String(formData.get("audio_metadata") || "[]");
    let audioMetadata: { filename: string; start: number }[] = [];
    try {
      audioMetadata = JSON.parse(audioMetadataStr);
    } catch (e) {
      console.warn("Failed to parse audio metadata", e);
    }

    if (frameFiles.length === 0) {
      return { error: "No PNG frames were provided for export." };
    }

    const totalFrameBytes = frameFiles.reduce((sum, f) => sum + f.size, 0);
    const totalAudioBytes = audioFiles.reduce((sum, f) => sum + f.size, 0);
    console.log(`[Export] ${frameFiles.length} frames (${(totalFrameBytes / 1024 / 1024).toFixed(1)}MB), ${audioFiles.length} audio (${(totalAudioBytes / 1024 / 1024).toFixed(1)}MB), res=${width}x${height}@${fps}fps`);

    for (const frameFile of frameFiles) {
      const bytes = Buffer.from(await frameFile.arrayBuffer());
      await writeFile(join(tempDir, frameFile.name), bytes);
    }
    for (const audioFile of audioFiles) {
      const bytes = Buffer.from(await audioFile.arrayBuffer());
      await writeFile(join(tempDir, audioFile.name), bytes);
    }

    const outputPath = join(tempDir, fileName);

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
      const mixInputs = audioMetadata.map((_, i) => `[a${i}]`).join("");
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

    await runFfmpeg(ffmpegArgs, tempDir);

    const outputBuffer = await readFile(outputPath);
    const base64 = outputBuffer.toString("base64");

    return { data: base64, fileName };
  } catch (error) {
    console.error("Export action failed", error);
    return { error: error instanceof Error ? error.message : "MP4 export failed." };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
