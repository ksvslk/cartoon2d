// Shared voice pool for TTS — no HD voices.
// Used by both the director (server-side auto-assignment) and the UI dropdown (client-side).

export interface VoiceEntry {
    id: string;
    gender: "male" | "female";
    timbre: string;
    lang: string;
}

export const VOICE_POOL: readonly VoiceEntry[] = [
    // ── English (US) ──
    { id: "en-US-Standard-F", gender: "female", timbre: "Standard · clear, neutral", lang: "en-US" },
    { id: "en-US-Standard-A", gender: "male",   timbre: "Standard · calm, neutral", lang: "en-US" },
    { id: "en-US-Standard-B", gender: "male",   timbre: "Standard · warm, baritone", lang: "en-US" },
    { id: "en-US-Standard-C", gender: "female", timbre: "Standard · bright, friendly", lang: "en-US" },
    { id: "en-US-Standard-D", gender: "male",   timbre: "Standard · deep, authoritative", lang: "en-US" },
    { id: "en-US-Standard-E", gender: "female", timbre: "Standard · soft, gentle", lang: "en-US" },
    { id: "en-US-Studio-O",   gender: "female", timbre: "Studio · rich, expressive", lang: "en-US" },
    { id: "en-US-Studio-Q",   gender: "male",   timbre: "Studio · smooth, cinematic", lang: "en-US" },
    { id: "en-US-Journey-F",  gender: "female", timbre: "Journey · natural, conversational", lang: "en-US" },
    { id: "en-US-Journey-D",  gender: "male",   timbre: "Journey · natural, warm", lang: "en-US" },
    { id: "en-US-Journey-O",  gender: "female", timbre: "Journey · lively, youthful", lang: "en-US" },
    // ── English (UK) ──
    { id: "en-GB-Standard-A", gender: "female", timbre: "Standard · British, poised", lang: "en-GB" },
    { id: "en-GB-Standard-B", gender: "male",   timbre: "Standard · British, steady", lang: "en-GB" },
    { id: "en-GB-Studio-B",   gender: "male",   timbre: "Studio · British, refined", lang: "en-GB" },
    { id: "en-GB-Studio-C",   gender: "female", timbre: "Studio · British, elegant", lang: "en-GB" },
    // ── Spanish ──
    { id: "es-ES-Standard-C", gender: "female", timbre: "Standard · ES female", lang: "es-ES" },
    { id: "es-ES-Standard-B", gender: "male",   timbre: "Standard · ES male", lang: "es-ES" },
    { id: "es-US-Studio-B",   gender: "male",   timbre: "Studio · US-ES male", lang: "es-US" },
    // ── French ──
    { id: "fr-FR-Standard-A", gender: "female", timbre: "Standard · FR female", lang: "fr-FR" },
    { id: "fr-FR-Standard-D", gender: "male",   timbre: "Standard · FR male", lang: "fr-FR" },
    { id: "fr-FR-Studio-A",   gender: "female", timbre: "Studio · FR female", lang: "fr-FR" },
    { id: "fr-FR-Studio-D",   gender: "male",   timbre: "Studio · FR male", lang: "fr-FR" },
    // ── German ──
    { id: "de-DE-Standard-A", gender: "female", timbre: "Standard · DE female", lang: "de-DE" },
    { id: "de-DE-Standard-B", gender: "male",   timbre: "Standard · DE male", lang: "de-DE" },
    { id: "de-DE-Studio-B",   gender: "male",   timbre: "Studio · DE male", lang: "de-DE" },
    { id: "de-DE-Studio-C",   gender: "female", timbre: "Studio · DE female", lang: "de-DE" },
    // ── Japanese ──
    { id: "ja-JP-Standard-A", gender: "female", timbre: "Standard · JP female", lang: "ja-JP" },
    { id: "ja-JP-Standard-C", gender: "male",   timbre: "Standard · JP male", lang: "ja-JP" },
    // ── Estonian ──
    { id: "et-EE-Standard-A", gender: "male",   timbre: "Standard · ET male", lang: "et-EE" },
];
