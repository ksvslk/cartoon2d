import { streamStorySequence } from "./src/lib/ai/director";

async function run() {
    try {
        const stream = streamStorySequence("A robot cat runs in panic from a loud vacuum cleaner.");
        for await (const chunk of stream) {
            if (chunk.type === 'story') {
                console.log("Got story chunk!");
            } else if (chunk.type === 'image') {
                console.log(`Got image chunk ${chunk.index} with length ${chunk.data.length}`);
            } else {
                console.log("Unknown chunk", chunk);
            }
        }
    } catch (e) {
        console.error("STREAM ERROR:", e);
    }
}
run();