"use server";

export interface VisemeKeyframe {
  viseme: string;
  time: number;
  duration: number;
}

export interface TTSResponse {
  audioDataUrl: string;
  visemes: VisemeKeyframe[];
  durationSeconds: number;
  costEstimate: number;
  billedCharacters: number;
  debugTimepoints?: any[];
  debugWords?: string[];
}

// A simple rule-based phonetic map to turn strings of characters into standard SVG Visemes
// (A, E, I, O, U, M, idle)
function wordToVisemes(word: string): string[] {
  const visemes: string[] = [];
  const chars = word.toLowerCase().replace(/[^a-z]/g, "");
  
  if (chars.length === 0) return ["idle"];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (["a"].includes(char)) visemes.push("A");
    else if (["e"].includes(char)) visemes.push("E");
    else if (["i"].includes(char)) visemes.push("I");
    else if (["o"].includes(char)) visemes.push("O");
    else if (["u", "w", "q"].includes(char)) visemes.push("U");
    else if (["m", "p", "b"].includes(char)) visemes.push("M");
    else if (["f", "v"].includes(char)) visemes.push("E"); // Teeth-lip
    else if (["c", "d", "g", "k", "n", "r", "s", "t", "x", "z"].includes(char)) visemes.push("E"); // Generic open
    else if (["l", "y"].includes(char)) visemes.push("I");
    else if (["h", "j"].includes(char)) visemes.push("A");
  }

  // Deduplicate consecutive identical visemes
  const filtered = visemes.filter((v, idx) => idx === 0 || v !== visemes[idx - 1]);
  return filtered.length > 0 ? filtered : ["idle"];
}

export async function generateSpeechTTS(text: string, voiceName: string = "en-US-Standard-F", deliveryStyle?: string): Promise<TTSResponse> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_TTS_API_KEY or GEMINI_API_KEY");
  }

  // To get word-level timings from Google Cloud TTS, we inject SSML <mark> tags before every word.
  // Then the API will return a timepoints array telling us exactly when that word begins!
  const words = text.split(/\s+/).filter(w => w.length > 0);
  
  let ssml = `<speak>`;

  // Apply basic SSML prosody heuristic based on delivery_style string
  let prosodyOpen = "";
  let prosodyClose = "";
  if (deliveryStyle) {
      const styleLower = deliveryStyle.toLowerCase();
      if (styleLower.includes("fast") || styleLower.includes("frantic") || styleLower.includes("panic")) {
          prosodyOpen = `<prosody rate="fast" pitch="+1st">`;
          prosodyClose = `</prosody>`;
      } else if (styleLower.includes("slow") || styleLower.includes("sad") || styleLower.includes("tired") || styleLower.includes("whisper")) {
          prosodyOpen = `<prosody rate="slow" pitch="-1st">`;
          prosodyClose = `</prosody>`;
      } else if (styleLower.includes("angry") || styleLower.includes("shout") || styleLower.includes("yell")) {
          prosodyOpen = `<prosody rate="fast" pitch="+2st" volume="loud">`;
          prosodyClose = `</prosody>`;
      }
  }

  ssml += prosodyOpen;
  words.forEach((word, index) => {
    ssml += `<mark name="word_${index}"/>${word} `;
  });
  ssml += prosodyClose;
  ssml += `<mark name="end"/></speak>`;

  const requestBody = {
    input: {
      ssml: ssml
    },
    voice: {
      languageCode: voiceName.substring(0, 5), // e.g. "en-US"
      name: voiceName
    },
    audioConfig: {
      audioEncoding: "MP3"
    },
    enableTimePointing: ["SSML_MARK"]
  };

  const url = `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("GCP TTS Error:", errText);
    throw new Error(`Google Cloud TTS failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const base64Audio = data.audioContent;
  const timepoints = data.timepoints || []; // Array of { markName: string, timeSeconds: number }

  console.log(`[TTS Backend] Raw GCP API timepoints received:`, timepoints.length, timepoints.slice(0, 3));

  const parsedVisemes: VisemeKeyframe[] = [];
  
  // We need to know the total duration. If not provided, we just estimate based on the last mark.
  // GCP TTS doesn't give exact total length explicitly in the JSON body, just audioContent.
  let totalDuration = 0;
  const endMark = timepoints.find((t: any) => t.markName === "end");
  if (endMark) {
      totalDuration = endMark.timeSeconds;
  } else {
      // If timepoints are completely stripped (e.g. Journey or Studio voices), we MUST estimate the audio duration natively.
      // GCP TTS MP3s are typically encoded at 24kbps (3KB/s) or 32kbps (4KB/s). We can estimate from the base64 length.
      // base64 length = 4/3 * binary length. So binary bytes = base64Audio.length * 0.75.
      // At ~32kbps (4000 bytes/sec), duration in seconds is roughly bytes / 4000.
      const estimatedBinaryBytes = base64Audio.length * 0.75;
      totalDuration = timepoints.length > 0 ? timepoints[timepoints.length - 1].timeSeconds + 0.5 : Math.max(1.0, estimatedBinaryBytes / 4000.0);
  }

  const hasTimepoints = timepoints.length > 0;

  // Iterate over words to calculate the viseme timings
  for (let i = 0; i < words.length; i++) {
    let startSec = 0;
    let nextStartSec = totalDuration;

    if (hasTimepoints) {
      const currentMarkStr = `word_${i}`;
      const tpCurrent = timepoints.find((t: any) => t.markName === currentMarkStr);
      if (!tpCurrent) continue;

      startSec = tpCurrent.timeSeconds;
      
      // Find next mark (either next word or end mark)
      if (i + 1 < words.length) {
        const tpNext = timepoints.find((t: any) => t.markName === `word_${i+1}`);
        nextStartSec = tpNext ? tpNext.timeSeconds : (endMark ? endMark.timeSeconds : totalDuration);
      } else if (endMark) {
        nextStartSec = endMark.timeSeconds;
      }
    } else {
      // FALLBACK ESTIMATION: Journey voices drop SSML entirely. Distribute words evenly.
      const wordEstDuration = totalDuration / words.length;
      startSec = i * wordEstDuration;
      nextStartSec = (i + 1) * wordEstDuration;
    }

    const wordDuration = nextStartSec - startSec;
    // Cap word duration if there is a long pause after it (say, comma or period)
    const effectiveWordDuration = Math.min(wordDuration, hasTimepoints ? 0.8 : 1.5); // Max 800ms per word talking

    const wordVisemes = wordToVisemes(words[i]);
    const visemeDuration = effectiveWordDuration / wordVisemes.length;

    wordVisemes.forEach((v, vIndex) => {
        parsedVisemes.push({
            viseme: v,
            time: startSec + (vIndex * visemeDuration),
            duration: visemeDuration
        });
    });

    // If there is silence after the word (because effectiveWordDuration < wordDuration), add "M" (closed mouth) or "idle"
    if (wordDuration > effectiveWordDuration) {
        parsedVisemes.push({
            viseme: "M", // Closed mouth silence
            time: startSec + effectiveWordDuration,
            duration: wordDuration - effectiveWordDuration
        });
    }
  }

  const billedCharacters = ssml.length;
  const costEstimate = billedCharacters * 0.000016; // $0.000016 per char for GCP Journey voices

  console.log(`[TTS Backend] Generated ${parsedVisemes.length} visemes for text: "${text.substring(0, 30)}..."`);

  return {
    audioDataUrl: `data:audio/mp3;base64,${base64Audio}`,
    visemes: parsedVisemes,
    durationSeconds: totalDuration,
    costEstimate,
    billedCharacters,
    debugTimepoints: timepoints,
    debugWords: words
  };
}
