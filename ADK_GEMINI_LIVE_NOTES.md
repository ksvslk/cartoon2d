# ADK Gemini Live API Toolkit Notes (for `cartoon2d`)

Last updated: 2026-03-04
Scope: Streaming guide index + dev guide parts 1-5.

## Canonical sources

- https://google.github.io/adk-docs/streaming/
- https://github.com/google/adk-docs/raw/main/docs/streaming/dev-guide/part1.md
- https://github.com/google/adk-docs/raw/main/docs/streaming/dev-guide/part2.md
- https://github.com/google/adk-docs/raw/main/docs/streaming/dev-guide/part3.md
- https://github.com/google/adk-docs/raw/main/docs/streaming/dev-guide/part4.md
- https://github.com/google/adk-docs/raw/main/docs/streaming/dev-guide/part5.md

## Core mental model

- `run_live()` is the bidirectional session loop.
- Upstream path: client -> WebSocket -> `LiveRequestQueue` (`send_content`, `send_realtime`, optional activity signals).
- Downstream path: `runner.run_live(...)` async generator -> `Event` stream -> client.
- Session continuity is app-level ADK `Session` (persistent), while Live API session is ephemeral transport context during streaming.

## Non-negotiable implementation rules

1. Use one `LiveRequestQueue` per `run_live()` session. Never reuse across sessions.
2. Always call `live_request_queue.close()` in `finally` on disconnect/error.
3. Create `LiveRequestQueue` in async context.
4. Keep `RunConfig.response_modalities` explicit (`["AUDIO"]` or `["TEXT"]`), never both.
5. Use `StreamingMode.BIDI` for real-time audio/video; SSE is a different protocol path.

## LiveRequestQueue behavior that matters

- Send methods are sync and non-blocking (`put_nowait` pattern).
- FIFO ordering is guaranteed.
- Queue is unbounded by default, so backpressure is app responsibility.
- `close()` is a control signal to end stream gracefully; avoid abrupt transport-only disconnects.
- Use activity signals only if automatic VAD is explicitly disabled.

## Event handling truths (`run_live`)

- Handle these flags correctly:
  - `partial=True`: incremental text chunk.
  - `partial=False`: merged/complete text chunk for that response segment.
  - `interrupted=True`: stop current render/audio immediately.
  - `turn_complete=True`: model turn ended; re-enable input state.
- Author semantics:
  - agent responses use agent name as `author`.
  - transcribed user input events are authored as `"user"`.
- Persistence nuance:
  - inline audio chunks are ephemeral (not session history).
  - final transcriptions and tool/function events are persisted.
  - persisted audio history needs `save_live_blob=True` (currently audio-focused persistence).
- Serialization:
  - `event.model_dump_json(exclude_none=True, by_alias=True)` is default-safe.
  - audio-in-JSON base64 is expensive; prefer binary frames for audio payloads.

## Automatic tools and workflow behavior

- ADK auto-executes function calls from model (no manual tool loop needed).
- Tool call + tool response events still appear in stream for observability/UI.
- For sequential multi-agent workflows:
  - keep a single `run_live()` loop.
  - keep one persistent queue for whole workflow.
  - watch `event.author` for active agent transitions.

## RunConfig decisions and caveats

- `response_modalities`:
  - default behavior tends to AUDIO if not specified.
  - only one modality per session.
- `streaming_mode`:
  - BIDI -> Live API WebSocket path.
  - SSE -> standard Gemini HTTP streaming path.
- Session resumption:
  - enable for production; ADK manages reconnect handles automatically.
  - ADK reconnect management is ADK<->Live API, not browser<->our server.
- Context window compression:
  - can remove practical session duration limits and handle long contexts.
  - tradeoff is lossy compression of older context.
- `max_llm_calls`:
  - does not protect BIDI `run_live()` sessions.
- `support_cfc`:
  - experimental, Gemini 2.x only.
  - forces Live API path internally even if SSE set.

## Platform limits to design around

- Gemini Live API (AI Studio):
  - connection duration around 10 minutes (resumable if enabled).
  - session duration without compression: about 15 min audio-only, 2 min audio+video.
  - concurrent sessions are tier-based.
- Vertex AI Live API:
  - session duration without compression: about 10 min.
  - up to high concurrency with quota governance per project/region.

These values can change; verify current quota docs before release gating.

## Media specifics we must preserve in `cartoon2d`

- Input audio to model:
  - PCM16, mono, 16 kHz (`audio/pcm;rate=16000`).
- Output audio from model (native audio models):
  - PCM16, mono, 24 kHz (`audio/pcm;rate=24000`).
- Chunking:
  - low latency via small consistent chunks; do not wait for model response before sending next chunk.
- Image/video input:
  - sent as JPEG frames (`image/jpeg`), recommended ~1 FPS and ~768x768.
- Audio transcription:
  - default is enabled for input and output unless disabled in RunConfig.
  - in multi-agent (`sub_agents`) contexts, ADK may force transcription on for transfer behavior.

## Model architecture tradeoffs

- Native audio models:
  - best conversational naturalness, affective/proactive features.
  - AUDIO response modality focus.
- Half-cascade models:
  - stronger explicit text-mode workflows and predictable text/tool patterns.
  - fewer advanced native-audio-only features.

Model availability and names evolve; keep model configured via env vars.

## VAD and turn-taking policy

- Default: keep server-side automatic VAD enabled.
- Disable VAD only if using client-side/manual turn control.
- If disabled:
  - send `activity_start` before first audio chunk of user turn.
  - send `activity_end` after last chunk.

## Project-specific checklist for every streaming change

- Keep upstream/downstream tasks independent and concurrent.
- Ensure queue closure in all exit paths.
- Respect event flags in UI (`partial`, `interrupted`, `turn_complete`).
- Keep audio path binary where possible (avoid JSON base64 for heavy audio traffic).
- Track usage metadata and session counts for quota/cost observability.
- Validate `RunConfig` against chosen model/platform before deploy.

## Watchlist (likely drift points)

- Current model names and deprecations.
- Quota values and live session limits per tier/region.
- `save_live_blob` persistence scope changes.
- Experimental features (`support_cfc`, progressive SSE, native-audio feature parity on Vertex).
