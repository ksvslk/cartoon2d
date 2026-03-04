"""Additive Cartoon Director V1 server (baseline untouched)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import warnings
from pathlib import Path
from typing import Any
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.sessions.sqlite_session_service import SqliteSessionService
from google.genai import types
from pydantic import BaseModel, Field

# Load environment variables BEFORE importing agent/runtime modules
load_dotenv(Path(__file__).parent / ".env")

try:
    from cartoon_director_v1.agent import agent
    from cartoon_director_v1.runtime import (
        ALLOW_PROACTIVITY,
        APP_NAME,
        SESSION_BACKEND,
        SESSION_DB_PATH,
        store,
    )
except ModuleNotFoundError:  # pragma: no cover - import fallback for package mode
    from app.cartoon_director_v1.agent import agent
    from app.cartoon_director_v1.runtime import (
        ALLOW_PROACTIVITY,
        APP_NAME,
        SESSION_BACKEND,
        SESSION_DB_PATH,
        store,
    )

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

ACTIVE_WS: dict[tuple[str, str], WebSocket] = {}
ACTIVE_WS_LOCK = asyncio.Lock()


app = FastAPI(title="Cartoon Director V1")
static_dir = Path(__file__).parent / "static_cartoon_v1"
app.mount("/static_cartoon_v1", StaticFiles(directory=static_dir), name="static_cartoon_v1")


class SessionCreateRequest(BaseModel):
    session_id: str | None = Field(default=None, min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class AssetCreateRequest(BaseModel):
    asset_key: str = Field(..., min_length=1)
    asset_type: str = Field(..., min_length=1)
    svg: str = Field(..., min_length=1)
    name: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SceneCreateRequest(BaseModel):
    scene_id: str | None = Field(default=None, min_length=1)
    name: str = Field(..., min_length=1)
    start_ms: int = Field(default=0, ge=0)
    end_ms: int = Field(default=5000, ge=0)
    track_order: int = Field(default=0)


def _build_session_service() -> InMemorySessionService | SqliteSessionService:
    backend = SESSION_BACKEND
    if backend in {"memory", "inmemory", "in-memory"}:
        logger.info("Cartoon v1 using InMemorySessionService")
        return InMemorySessionService()
    db = Path(SESSION_DB_PATH)
    db.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Cartoon v1 using SqliteSessionService at %s", db)
    return SqliteSessionService(db_path=str(db))


session_service = _build_session_service()
runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)


def _max_llm_calls() -> int:
    raw = str(os.getenv("CARTOON_V1_MAX_LLM_CALLS", "12") or "").strip()
    try:
        parsed = int(raw)
    except ValueError:
        parsed = 12
    return max(4, min(500, parsed))


def _require_session(user_id: str, session_id: str) -> dict[str, Any]:
    session = store.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    return session


def _new_session_id() -> str:
    return f"session-{uuid4().hex[:12]}"


async def _ensure_adk_session(user_id: str, session_id: str) -> None:
    existing = await session_service.get_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    if existing is None:
        await session_service.create_session(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
        )


async def _delete_adk_session(user_id: str, session_id: str) -> None:
    existing = await session_service.get_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    if existing is not None:
        await session_service.delete_session(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
        )


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/cartoon/users/{user_id}/sessions")
async def list_sessions(user_id: str) -> dict[str, Any]:
    return {"sessions": store.list_sessions(app_name=APP_NAME, user_id=user_id)}


@app.post("/api/v1/cartoon/users/{user_id}/sessions")
async def create_session(user_id: str, request: SessionCreateRequest | None = None) -> dict[str, Any]:
    candidate = (request.session_id or "").strip() if request else ""
    session_id = candidate or _new_session_id()
    existing = store.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"Session already exists: {session_id}")

    await _ensure_adk_session(user_id=user_id, session_id=session_id)
    created = store.ensure_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        metadata=request.metadata if request else {},
    )
    return {"session": created}


@app.delete("/api/v1/cartoon/users/{user_id}/sessions/{session_id}")
async def delete_session(user_id: str, session_id: str) -> dict[str, Any]:
    removed = store.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    await _delete_adk_session(user_id=user_id, session_id=session_id)
    return {"deleted": True, "sessionId": session_id}


@app.get("/api/v1/cartoon/sessions/{user_id}/{session_id}/timeline")
async def timeline(user_id: str, session_id: str) -> dict[str, Any]:
    _require_session(user_id, session_id)
    return store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)


@app.get("/api/v1/cartoon/sessions/{user_id}/{session_id}/restore")
async def restore(user_id: str, session_id: str) -> dict[str, Any]:
    _require_session(user_id, session_id)
    return store.restore_bundle(app_name=APP_NAME, user_id=user_id, session_id=session_id)


@app.get("/api/v1/cartoon/sessions/{user_id}/{session_id}/playback")
async def playback(user_id: str, session_id: str, time_ms: int = 0) -> dict[str, Any]:
    _require_session(user_id, session_id)
    return store.playback(app_name=APP_NAME, user_id=user_id, session_id=session_id, time_ms=time_ms)


@app.get("/api/v1/cartoon/sessions/{user_id}/{session_id}/assets")
async def assets(user_id: str, session_id: str) -> dict[str, Any]:
    _require_session(user_id, session_id)
    return {
        "assets": store.list_assets(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            include_deleted=False,
        )
    }


@app.post("/api/v1/cartoon/sessions/{user_id}/{session_id}/assets")
async def create_asset(user_id: str, session_id: str, request: AssetCreateRequest) -> dict[str, Any]:
    _require_session(user_id, session_id)
    try:
        created = store.create_asset(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            asset_key=request.asset_key,
            asset_type=request.asset_type,
            svg=request.svg,
            name=request.name,
            metadata=request.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"asset": created}


@app.delete("/api/v1/cartoon/sessions/{user_id}/{session_id}/assets/{asset_id}")
async def delete_asset(user_id: str, session_id: str, asset_id: str) -> dict[str, Any]:
    _require_session(user_id, session_id)
    deleted = store.delete_asset_by_id(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        asset_id=asset_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    return {"deleted": True, "assetId": asset_id}


@app.post("/api/v1/cartoon/sessions/{user_id}/{session_id}/scenes")
async def create_scene(user_id: str, session_id: str, request: SceneCreateRequest) -> dict[str, Any]:
    _require_session(user_id, session_id)
    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.create",
        payload={
            "sceneId": request.scene_id or request.name,
            "name": request.name,
            "startMs": request.start_ms,
            "endMs": request.end_ms,
            "trackOrder": request.track_order,
        },
        command_id=f"api-{uuid4().hex}",
        window_id="scene-create",
    )
    return {"event": event}


@app.delete("/api/v1/cartoon/sessions/{user_id}/{session_id}/scenes/{scene_id}")
async def delete_scene(user_id: str, session_id: str, scene_id: str) -> dict[str, Any]:
    _require_session(user_id, session_id)
    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.delete",
        payload={"sceneId": scene_id},
        command_id=f"api-{uuid4().hex}",
        window_id="scene-delete",
    )
    return {"deleted": True, "sceneId": scene_id, "event": event}


@app.websocket("/ws_v1/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
    proactivity: bool = False,
    affective_dialog: bool = False,
    voice_reply: bool = False,
) -> None:
    """Canonical ADK bidi loop for Cartoon Director V1."""
    session = store.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        await websocket.accept()
        await websocket.close(code=4404, reason=f"Session not found: {session_id}")
        logger.info("Rejected websocket for missing session user_id=%s session_id=%s", user_id, session_id)
        return

    await websocket.accept()
    ws_key = (user_id, session_id)
    async with ACTIVE_WS_LOCK:
        previous = ACTIVE_WS.get(ws_key)
        if previous is not None and previous is not websocket:
            try:
                await previous.close(code=4001, reason="Replaced by newer connection")
            except Exception:
                pass
        ACTIVE_WS[ws_key] = websocket

    model_name = str(agent.model)
    is_native_audio = "native-audio" in model_name.lower()
    effective_proactivity = proactivity and ALLOW_PROACTIVITY
    max_llm_calls = _max_llm_calls()

    if is_native_audio:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            # Native audio models require AUDIO output modality.
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            session_resumption=types.SessionResumptionConfig(),
            max_llm_calls=max_llm_calls,
            proactivity=(
                types.ProactivityConfig(proactive_audio=True)
                if effective_proactivity
                else None
            ),
            enable_affective_dialog=affective_dialog if affective_dialog else None,
        )
    else:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["TEXT"],
            input_audio_transcription=None,
            output_audio_transcription=None,
            session_resumption=types.SessionResumptionConfig(),
            max_llm_calls=max_llm_calls,
        )

    await _ensure_adk_session(user_id=user_id, session_id=session_id)

    queue = LiveRequestQueue()

    async def upstream() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()

            audio_bytes = message.get("bytes")
            if audio_bytes is not None:
                queue.send_realtime(types.Blob(mime_type="audio/pcm;rate=16000", data=audio_bytes))
                continue

            text_payload = message.get("text")
            if text_payload is None:
                continue

            try:
                data = json.loads(text_payload)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            if msg_type == "text":
                text = str(data.get("text", ""))
                if text:
                    queue.send_content(types.Content(parts=[types.Part(text=text)]))
                continue

            if msg_type == "image":
                blob = data.get("data")
                if not isinstance(blob, str):
                    continue
                try:
                    image_bytes = base64.b64decode(blob)
                except Exception:
                    continue
                mime_type = str(data.get("mimeType", "image/jpeg"))
                queue.send_realtime(types.Blob(mime_type=mime_type, data=image_bytes))

    async def downstream() -> None:
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=queue,
            run_config=run_config,
        ):
            await websocket.send_text(event.model_dump_json(exclude_none=True, by_alias=True))

    try:
        await asyncio.gather(upstream(), downstream())
    except WebSocketDisconnect:
        logger.info("Client disconnected user_id=%s session_id=%s", user_id, session_id)
    except Exception:
        logger.exception("Unexpected streaming error")
    finally:
        queue.close()
        async with ACTIVE_WS_LOCK:
            if ACTIVE_WS.get(ws_key) is websocket:
                ACTIVE_WS.pop(ws_key, None)
