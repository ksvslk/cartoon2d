import { generateStorySequence } from "./src/lib/ai/director";
async function test() {
    console.log("Testing generation...");
    try {
        const result = await generateStorySequence("A robot cat runs in panic from a loud vacuum cleaner.");
        const safeResult = result ? {
            ...result,
            beats: result.beats.map(beat => ({
                ...beat,
                image_data: beat.image_data ? "[BASE64_TRUNCATED_FOR_SAFETY]" : undefined
            }))
        } : null;
        console.log("RESULT:", JSON.stringify(safeResult, null, 2));
    } catch (e) {
        console.error("FATAL SCRIPT ERROR:", e);
    }
}

test();
