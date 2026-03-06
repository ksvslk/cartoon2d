import { streamStorySequence } from "./src/lib/ai/director";

async function run() {
    try {
        const stream = streamStorySequence("A dog chases a cat.");
        for await (const chunk of stream) {
            console.log("Got chunk of type:", chunk.type);
            if (chunk.type === 'image') {
                console.log("Image index:", chunk.index, "length:", chunk.data.length);
            }
        }
    } catch (e) {
        console.error(e);
    }
}

run();
