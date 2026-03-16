# Devpost Architecture Asset

Suggested title: `Cartoon 2D architecture`

Suggested caption:

`Gemini generates structured story beats, comic panels, rig guidance, and audio cues. Our deterministic animation runtime then compiles reusable rigs, validates motion against hard limits, assembles timeline playback, and exports MP4 scenes.`

Suggested upload placement:

- Put the diagram near the start of the image carousel.
- Also upload it in the file section so judges can zoom in.
- If space allows, pair it with one screenshot of the editor and one exported scene frame.

What this diagram emphasizes:

- Gemini is used for multimodal generation and asset planning.
- The animation itself is compiled by deterministic TypeScript runtime code.
- Project persistence is currently local browser IndexedDB, not a cloud database.
- Export is handled by the app's `/api/export` route plus FFmpeg.
