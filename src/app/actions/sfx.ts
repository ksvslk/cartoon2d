"use server";

import * as fs from 'fs';
import * as path from 'path';

interface SoundEffectParams {
  prompt: string;
  seconds?: number;
  steps?: number;
}

export async function executeSoundEffect({ prompt, seconds = 3.0, steps = 50 }: SoundEffectParams): Promise<{ url?: string; error?: string }> {
  // Hardcoded for now per user
  const COLAB_URL = "http://127.0.0.1:8001/generate"//"https://wei-vinous-avery.ngrok-free.dev/generate";

  console.log(`[SFX] Generating sound: '${prompt}'...`);

  try {
    const response = await fetch(COLAB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ prompt, seconds, steps }),
    });

    if (!response.ok) {
      throw new Error(`HTTP Status ${response.status}`);
    }

    // Grab the audio data and save it
    const buffer = Buffer.from(await response.arrayBuffer());
    const unixSuffix = Date.now();
    const filename = `sfx_${unixSuffix}.wav`;

    // Ensure public/audio/sfx exists
    const sfxDir = path.join(process.cwd(), 'public', 'audio', 'sfx');
    if (!fs.existsSync(sfxDir)) {
      fs.mkdirSync(sfxDir, { recursive: true });
    }

    const filePath = path.join(sfxDir, filename);
    fs.writeFileSync(filePath, buffer);
    console.log(`[SFX] Audio file saved locally to ${filePath}`);

    // The browser URL path
    const url = `/audio/sfx/${filename}`;

    return { url };

  } catch (error) {
    console.error(`[SFX] Error generating sound:`, error);
    return { error: `Error generating sound: ${error instanceof Error ? error.message : String(error)}` };
  }
}
