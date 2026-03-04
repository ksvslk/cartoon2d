"""ADK tools for Cartoon Director V1."""

from __future__ import annotations

import os
import re
import threading
import time
import uuid
from typing import Any

from google import genai
from google.genai import types as genai_types
from google.adk.tools import ToolContext

from .runtime import APP_NAME, SVG_GENERATION_ATTEMPTS, SVG_MODELS, store


_SVG_REFINEMENT_LOCK = threading.Lock()
_SVG_REFINEMENT_INFLIGHT: set[str] = set()
_TURN_TOOL_GUARD_LOCK = threading.Lock()
_TURN_TOOL_GUARD: dict[tuple[str, str, str, str], float] = {}
_TURN_TOOL_GUARD_MAX = 20000
_TURN_TOOL_GUARD_TTL_SEC = max(
    0.2,
    float(os.getenv("CARTOON_V1_TOOL_DEBOUNCE_SEC", "1.4") or 1.4),
)


def _slug(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", (value or "").strip().lower())
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    return cleaned or fallback


def _ids(tool_context: ToolContext) -> tuple[str, str]:
    command_id = str(getattr(tool_context, "invocation_id", "")).strip() or uuid.uuid4().hex
    window_id = str(getattr(tool_context, "function_call_id", "")).strip() or "window-1"
    return command_id, window_id


def _ctx(tool_context: ToolContext) -> tuple[str, str]:
    return tool_context.user_id, tool_context.session.id


def _turn_tool_seen(
    *,
    user_id: str,
    session_id: str,
    command_id: str,
    tool_name: str,
    scope: str,
) -> bool:
    _ = command_id  # invocation id is not stable turn identity in long-lived bidi sessions
    key = (user_id, session_id, tool_name, scope)
    now = time.monotonic()
    with _TURN_TOOL_GUARD_LOCK:
        last = _TURN_TOOL_GUARD.get(key)
        if last is None:
            return False
        return (now - float(last)) <= _TURN_TOOL_GUARD_TTL_SEC


def _mark_turn_tool(
    *,
    user_id: str,
    session_id: str,
    command_id: str,
    tool_name: str,
    scope: str,
) -> None:
    _ = command_id  # invocation id is not stable turn identity in long-lived bidi sessions
    key = (user_id, session_id, tool_name, scope)
    now = time.monotonic()
    with _TURN_TOOL_GUARD_LOCK:
        if len(_TURN_TOOL_GUARD) >= _TURN_TOOL_GUARD_MAX:
            cutoff = now - max(2.0, _TURN_TOOL_GUARD_TTL_SEC * 4)
            _TURN_TOOL_GUARD.update(
                {
                    k: ts
                    for k, ts in _TURN_TOOL_GUARD.items()
                    if float(ts) >= cutoff
                }
            )
            if len(_TURN_TOOL_GUARD) >= _TURN_TOOL_GUARD_MAX:
                _TURN_TOOL_GUARD.clear()
        _TURN_TOOL_GUARD[key] = now


def _extract_svg(raw_text: str) -> str | None:
    text = (raw_text or "").strip()
    if not text:
        return None

    # Remove markdown fences if present.
    text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text, count=1, flags=re.MULTILINE)
    text = re.sub(r"\s*```$", "", text, count=1, flags=re.MULTILINE)

    full = re.search(r"<svg\b[\s\S]*?</svg>", text, flags=re.IGNORECASE)
    if full:
        return full.group(0).strip()

    self_closing = re.search(r"<svg\b[^>]*/>", text, flags=re.IGNORECASE)
    if self_closing:
        return self_closing.group(0).strip()

    return None


def _latest_asset_for_key(*, user_id: str, session_id: str, asset_key: str) -> dict[str, Any] | None:
    key = _slug(asset_key, "asset")
    assets = store.list_assets(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        include_deleted=False,
    )
    for asset in assets:
        if str(asset.get("assetKey") or "") == key:
            return asset
    return None


def _asset_summary(asset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": asset.get("id"),
        "assetKey": asset.get("assetKey"),
        "assetType": asset.get("assetType"),
        "version": asset.get("version"),
        "name": asset.get("name"),
        "metadata": asset.get("metadata", {}),
        "deletedAt": asset.get("deletedAt"),
        "createdAt": asset.get("createdAt"),
    }


def _same_turn_generation_detected(
    *,
    user_id: str,
    session_id: str,
    command_id: str,
    asset_key: str,
) -> bool:
    key = _slug(asset_key, "asset")
    for event in reversed(store.list_events(app_name=APP_NAME, user_id=user_id, session_id=session_id)):
        if str(event.get("commandId") or "") != command_id:
            continue
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if str(payload.get("assetKey") or "") != key:
            continue
        event_type = str(event.get("eventType") or "")
        if event_type in {"asset.refinement.completed", "asset.refinement.failed"}:
            return False
        if event_type in {
            "asset.refinement.queued",
            "asset.refinement.inflight",
            "asset.refinement.generating",
        }:
            return True
    return False


def _is_refinement_inflight(*, user_id: str, session_id: str, asset_key: str) -> bool:
    queue_key = f"{user_id}:{session_id}:{_slug(asset_key, 'asset')}"
    with _SVG_REFINEMENT_LOCK:
        return queue_key in _SVG_REFINEMENT_INFLIGHT


def _build_svg_prompt(*, asset_type: str, description: str) -> str:
    return (
        "You generate production-safe SVG for a 2D cartoon timeline editor.\n\n"
        "Hard requirements:\n"
        "1) Output ONLY raw SVG markup. No markdown, no code fences, no prose.\n"
        "2) Root element must be <svg> and the output must end with </svg>.\n"
        "3) Include xmlns=\"http://www.w3.org/2000/svg\" and a valid viewBox.\n"
        "4) Use only safe static SVG elements/attributes.\n"
        "5) Do NOT use: script, foreignObject, iframe, object, embed, audio, video, canvas.\n"
        "6) Do NOT use event-handler attributes (onload, onclick, etc).\n"
        "7) Do NOT use external refs or URLs in href/xlink:href/style.\n"
        "8) Keep geometry compact and clean (minimal node count, grouped logically).\n"
        "9) Visual style: flat 2D cartoon, clear silhouette, readable at thumbnail size.\n"
        "10) Asset must match the requested type and description exactly.\n\n"
        f"Asset type: {asset_type}\n"
        f"Description: {description}\n\n"
        "Return one complete valid SVG only."
    )


def _svg_quality_check(svg: str) -> tuple[bool, str | None]:
    text = str(svg or "")
    if len(text) < 120:
        return False, "svg_too_short"
    if not re.search(r"<svg\b[^>]*\bxmlns\s*=\s*['\"]http://www\.w3\.org/2000/svg['\"]", text, flags=re.IGNORECASE):
        return False, "svg_missing_xmlns"
    if not re.search(r"<svg\b[^>]*\bviewBox\s*=\s*['\"][^'\"]+['\"]", text, flags=re.IGNORECASE):
        return False, "svg_missing_viewbox"
    primitive_count = len(
        re.findall(
            r"<(?:path|rect|circle|ellipse|polygon|polyline|line)\b",
            text,
            flags=re.IGNORECASE,
        )
    )
    if primitive_count < 2:
        return False, "svg_too_few_primitives"
    return True, None


def _classify_svg_failure(error_text: str) -> tuple[str, str]:
    text = str(error_text or "").lower()
    if any(
        token in text
        for token in (
            "404",
            "not_found",
            "model was not found",
            "publisher model",
            "does not have access",
            "valid model version",
        )
    ):
        return (
            "model_not_available",
            "I could not create this asset because the configured SVG model is not available for this project/region.",
        )
    if any(token in text for token in ("policy violation", "safety", "blocked", "harm", "disallowed")):
        return (
            "safety_blocked",
            "I could not create this asset because it violates model safety policy.",
        )
    if any(token in text for token in ("quota", "rate", "429", "resource exhausted")):
        return (
            "rate_limited",
            "I could not create this asset right now because the model is rate limited.",
        )
    if any(token in text for token in ("timeout", "deadline", "temporarily unavailable", "unavailable", "503")):
        return (
            "provider_unavailable",
            "I could not create this asset because the generation service is temporarily unavailable.",
        )
    if any(token in text for token in ("invalid", "parse", "viewbox", "xmlns", "no_svg")):
        return (
            "invalid_svg_output",
            "I could not create a valid SVG for this request after multiple attempts.",
        )
    return (
        "generation_failed",
        "I could not create this asset after multiple generation attempts.",
    )


def _is_model_not_available_error(error_text: str) -> bool:
    text = str(error_text or "").lower()
    return any(
        token in text
        for token in (
            "404",
            "not_found",
            "model was not found",
            "publisher model",
            "does not have access",
            "valid model version",
        )
    )


def _env_true(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _vertex_enabled() -> bool:
    return _env_true("GOOGLE_GENAI_USE_VERTEXAI")


def _svg_project() -> str:
    return os.getenv("CARTOON_V1_SVG_PROJECT", "").strip() or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()


def _svg_location() -> str:
    return os.getenv("CARTOON_V1_SVG_LOCATION", "").strip() or os.getenv("GOOGLE_CLOUD_LOCATION", "").strip()


def _build_svg_client(*, location_override: str | None = None) -> genai.Client:
    if not _vertex_enabled():
        return genai.Client()
    project = _svg_project()
    location = (location_override or _svg_location() or "us-central1").strip()
    if not project:
        return genai.Client()
    return genai.Client(vertexai=True, project=project, location=location)


def _repair_svg_with_model(
    *,
    client: genai.Client,
    model_name: str,
    candidate_svg: str,
    asset_type: str,
    description: str,
    validation_error: str,
) -> str | None:
    prompt = (
        "Fix the SVG below so it is valid, safe, and renderable.\n"
        "Return ONLY final SVG markup.\n"
        "No markdown. No prose.\n"
        "Must include xmlns and viewBox.\n"
        "Must not include script/foreignObject/external refs/on* handlers.\n"
        f"Asset type: {asset_type}\n"
        f"Description: {description}\n"
        f"Validation error: {validation_error}\n"
        "SVG to fix:\n"
        f"{candidate_svg}\n"
    )
    response = client.models.generate_content(
        model=model_name,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=1600,
            response_mime_type="text/plain",
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
        ),
    )
    repaired_text = str(getattr(response, "text", "") or "")
    return _extract_svg(repaired_text)


def _generate_svg_with_model(
    *,
    model_name: str,
    asset_type: str,
    description: str,
    attempts: int,
    location_override: str | None = None,
) -> tuple[str | None, str | None]:
    prompt = _build_svg_prompt(asset_type=asset_type, description=description)
    errors: list[str] = []
    try:
        client = _build_svg_client(location_override=location_override)
        for attempt in range(max(1, int(attempts))):
            temperature = 0.42 if attempt == 0 else 0.2
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    temperature=temperature,
                    max_output_tokens=1600,
                    response_mime_type="text/plain",
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                ),
            )
            text = str(getattr(response, "text", "") or "")
            svg = _extract_svg(text) or ""
            if not svg:
                text_l = text.lower()
                if "<svg" in text_l:
                    repaired = _repair_svg_with_model(
                        client=client,
                        model_name=model_name,
                        candidate_svg=text,
                        asset_type=asset_type,
                        description=description,
                        validation_error="truncated_or_incomplete_svg",
                    )
                    if repaired:
                        svg = repaired
                if any(token in text_l for token in ("cannot assist", "can't assist", "policy", "safety")):
                    errors.append(f"attempt_{attempt + 1}:blocked:{text_l[:120]}")
                    continue
                if not svg:
                    errors.append(f"attempt_{attempt + 1}:no_svg")
                    continue

            ok_svg, svg_error = store.validate_svg(svg)
            if not ok_svg:
                repaired = _repair_svg_with_model(
                    client=client,
                    model_name=model_name,
                    candidate_svg=svg,
                    asset_type=asset_type,
                    description=description,
                    validation_error=str(svg_error),
                )
                if repaired:
                    svg = repaired
                    ok_svg, svg_error = store.validate_svg(svg)
            if not ok_svg:
                errors.append(f"attempt_{attempt + 1}:invalid:{svg_error}")
                continue

            good_quality, quality_error = _svg_quality_check(svg)
            if not good_quality:
                errors.append(f"attempt_{attempt + 1}:quality:{quality_error}")
                continue
            return svg, None
    except Exception as exc:  # pragma: no cover - network/model dependent
        # Keep the user-specified model, but retry once against global endpoint
        # when Vertex regional routing cannot find/access this model.
        if (
            _is_model_not_available_error(str(exc))
            and location_override is None
            and _vertex_enabled()
            and _svg_project()
            and _svg_location().lower() != "global"
        ):
            return _generate_svg_with_model(
                model_name=model_name,
                asset_type=asset_type,
                description=description,
                attempts=attempts,
                location_override="global",
            )
        return None, f"svg_model_failed:{exc}"

    if not errors:
        return None, "svg_model_no_svg"
    return None, ";".join(errors[-6:])


def _queue_svg_refinement(
    *,
    user_id: str,
    session_id: str,
    asset_key: str,
    asset_type: str,
    description: str,
    name: str,
    model_names: list[str],
    attempts_per_model: int,
) -> bool:
    queue_key = f"{user_id}:{session_id}:{asset_key}"
    with _SVG_REFINEMENT_LOCK:
        if queue_key in _SVG_REFINEMENT_INFLIGHT:
            return False
        _SVG_REFINEMENT_INFLIGHT.add(queue_key)

    def _worker() -> None:
        def _emit(event_type: str, payload: dict[str, Any]) -> None:
            try:
                store.append_event(
                    app_name=APP_NAME,
                    user_id=user_id,
                    session_id=session_id,
                    event_type=event_type,
                    payload=payload,
                    command_id=f"bg-{uuid.uuid4().hex}",
                    window_id="svg-refinement",
                )
            except Exception:
                return

        try:
            errors: list[str] = []
            resolved_models = [m for m in model_names if isinstance(m, str) and m.strip()]
            if not resolved_models:
                resolved_models = ["gemini-2.5-flash"]

            for model_name in resolved_models:
                _emit(
                    "asset.refinement.generating",
                    {
                        "assetKey": asset_key,
                        "model": model_name,
                        "attempts": int(attempts_per_model),
                    },
                )
                svg, warning = _generate_svg_with_model(
                    model_name=model_name,
                    asset_type=asset_type,
                    description=description,
                    attempts=attempts_per_model,
                )
                if not svg:
                    if warning:
                        errors.append(f"{model_name}:{warning}")
                    continue

                created = store.create_asset(
                    app_name=APP_NAME,
                    user_id=user_id,
                    session_id=session_id,
                    asset_key=asset_key,
                    asset_type=asset_type,
                    svg=svg,
                    name=name,
                    metadata={
                        "source": "model_async",
                        "generatorModel": model_name,
                        "description": description,
                    },
                )
                _emit(
                    "asset.refinement.completed",
                    {
                        "assetKey": asset_key,
                        "assetId": created.get("id"),
                        "model": model_name,
                    },
                )
                return

            error_text = "; ".join(errors[-8:]) if errors else "no_valid_svg_generated"
            reason_code, user_message = _classify_svg_failure(error_text)
            _emit(
                "asset.refinement.failed",
                {
                    "assetKey": asset_key,
                    "models": resolved_models,
                    "reasonCode": reason_code,
                    "userMessage": user_message,
                    "error": error_text,
                },
            )
        except Exception as exc:  # pragma: no cover - background safety net
            reason_code, user_message = _classify_svg_failure(str(exc))
            _emit(
                "asset.refinement.failed",
                {
                    "assetKey": asset_key,
                    "models": model_names,
                    "reasonCode": reason_code,
                    "userMessage": user_message,
                    "error": f"background_exception:{exc}",
                },
            )
        finally:
            with _SVG_REFINEMENT_LOCK:
                _SVG_REFINEMENT_INFLIGHT.discard(queue_key)

    threading.Thread(
        target=_worker,
        name=f"svg-refine-{asset_key[:20]}",
        daemon=True,
    ).start()
    return True


def generate_svg_asset(
    *,
    asset_key: str,
    asset_type: str,
    description: str,
    name: str | None = None,
    force_regenerate: bool = False,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Queue model-based SVG generation without blocking; never return fallback SVG."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    model_names = [m for m in SVG_MODELS if isinstance(m, str) and m.strip()]
    if not model_names:
        model_names = ["gemini-2.5-flash"]
    primary_model = model_names[0]
    cleaned_key = _slug(asset_key, "asset")
    cleaned_type = _slug(asset_type, "asset")
    resolved_description = description.strip() or cleaned_key
    scope = _slug(
        f"{cleaned_key}-{cleaned_type}-force-{1 if force_regenerate else 0}-{resolved_description[:96]}",
        cleaned_key,
    )
    if _turn_tool_seen(
        user_id=user_id,
        session_id=session_id,
        command_id=command_id,
        tool_name="generate_svg_asset",
        scope=scope,
    ):
        inflight = _is_refinement_inflight(user_id=user_id, session_id=session_id, asset_key=cleaned_key)
        existing = _latest_asset_for_key(user_id=user_id, session_id=session_id, asset_key=cleaned_key)
        if inflight or bool(force_regenerate):
            return {
                "ok": True,
                "duplicateSuppressed": True,
                "assetKey": cleaned_key,
                "status": "pending",
                "message": "Generation request already started moments ago.",
            }
        if existing is not None:
            return {
                "ok": True,
                "duplicateSuppressed": True,
                "assetKey": cleaned_key,
                "status": "ready",
                "asset": _asset_summary(existing),
                "message": "This asset was already handled in this turn.",
            }
        return {
            "ok": True,
            "duplicateSuppressed": True,
            "assetKey": cleaned_key,
            "status": "pending",
            "message": "This asset generation request is already in progress in this turn.",
        }
    _mark_turn_tool(
        user_id=user_id,
        session_id=session_id,
        command_id=command_id,
        tool_name="generate_svg_asset",
        scope=scope,
    )
    latest = _latest_asset_for_key(user_id=user_id, session_id=session_id, asset_key=cleaned_key)
    if latest is not None:
        latest_meta = latest.get("metadata", {}) if isinstance(latest.get("metadata"), dict) else {}
        latest_source = str(latest_meta.get("source") or "")
        latest_desc = str(latest_meta.get("description") or "").strip()
        queue_refinement = bool(force_regenerate) or latest_source not in {"model_async", "model"} or (
            latest_desc and latest_desc != resolved_description
        )
        refinement_queued = False
        if queue_refinement:
            refinement_queued = _queue_svg_refinement(
                user_id=user_id,
                session_id=session_id,
                asset_key=cleaned_key,
                asset_type=cleaned_type,
                description=resolved_description,
                name=name or cleaned_key,
                model_names=model_names,
                attempts_per_model=SVG_GENERATION_ATTEMPTS,
            )
            if refinement_queued:
                store.append_event(
                    app_name=APP_NAME,
                    user_id=user_id,
                    session_id=session_id,
                    event_type="asset.refinement.queued",
                    payload={
                        "assetKey": cleaned_key,
                        "assetType": cleaned_type,
                        "models": model_names,
                        "attemptsPerModel": int(SVG_GENERATION_ATTEMPTS),
                    },
                    command_id=command_id,
                    window_id=window_id,
                )
        return {
            "ok": True,
            "asset": _asset_summary(latest),
            "source": latest_source or "existing",
            "reused": True,
            "forceRegenerate": bool(force_regenerate),
            "refinementQueued": refinement_queued,
            "model": primary_model,
            "models": model_names,
        }

    refinement_queued = _queue_svg_refinement(
        user_id=user_id,
        session_id=session_id,
        asset_key=cleaned_key,
        asset_type=cleaned_type,
        description=resolved_description,
        name=name or cleaned_key,
        model_names=model_names,
        attempts_per_model=SVG_GENERATION_ATTEMPTS,
    )
    if refinement_queued:
        store.append_event(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            event_type="asset.refinement.queued",
            payload={
                "assetKey": cleaned_key,
                "assetType": cleaned_type,
                "models": model_names,
                "attemptsPerModel": int(SVG_GENERATION_ATTEMPTS),
            },
            command_id=command_id,
            window_id=window_id,
        )
    else:
        store.append_event(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            event_type="asset.refinement.inflight",
            payload={
                "assetKey": cleaned_key,
                "assetType": cleaned_type,
                "models": model_names,
            },
            command_id=command_id,
            window_id=window_id,
        )

    return {
        "ok": True,
        "pending": True,
        "assetKey": cleaned_key,
        "assetType": cleaned_type,
        "source": "model_async",
        "model": primary_model,
        "models": model_names,
        "refinementQueued": refinement_queued,
    }


def _ensure_scene_for_write(
    *,
    user_id: str,
    session_id: str,
    requested_scene_id: str | None,
    command_id: str,
    window_id: str,
) -> str:
    """Ensure a target scene exists before scene mutations."""
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    state = view.get("state", {})
    active_scene = state.get("activeSceneId")
    resolved = _slug(str(requested_scene_id or active_scene or "scene-1"), "scene")
    scenes = state.get("scenes", {})
    if isinstance(scenes, dict) and resolved in scenes:
        return resolved

    scene_order = state.get("sceneOrder", [])
    store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.create",
        payload={
            "sceneId": resolved,
            "name": str(resolved).replace("-", " ").title(),
            "startMs": 0,
            "endMs": 5000,
            "trackOrder": len(scene_order) if isinstance(scene_order, list) else 0,
        },
        command_id=command_id,
        window_id=window_id,
    )
    return resolved


def get_timeline_state(*, tool_context: ToolContext) -> dict[str, Any]:
    """Read current timeline state and recent events."""
    user_id, session_id = _ctx(tool_context)
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return {
        "ok": True,
        "state": view["state"],
        "recentEvents": view["events"][-10:],
        "eventCount": view["eventCount"],
    }


def get_asset_generation_status(*, asset_key: str, tool_context: ToolContext) -> dict[str, Any]:
    """Return latest async generation status for an asset key.

    This tool is intended for explicit user-initiated checks, not polling loops.
    """
    user_id, session_id = _ctx(tool_context)
    command_id, _ = _ids(tool_context)
    key = _slug(asset_key, "asset")
    already_checked_this_turn = _turn_tool_seen(
        user_id=user_id,
        session_id=session_id,
        command_id=command_id,
        tool_name="get_asset_generation_status",
        scope=key,
    )
    events = store.list_events(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    latest: dict[str, Any] | None = None
    for event in reversed(events):
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if str(payload.get("assetKey") or "") != key:
            continue
        if event.get("eventType") in {
            "asset.refinement.queued",
            "asset.refinement.inflight",
            "asset.refinement.generating",
            "asset.refinement.completed",
            "asset.refinement.failed",
        }:
            latest = event
            break

    asset = _latest_asset_for_key(user_id=user_id, session_id=session_id, asset_key=key)
    if asset is not None:
        result = {
            "ok": True,
            "assetKey": key,
            "status": "ready",
            "asset": _asset_summary(asset),
            "latestEvent": latest,
        }
        if already_checked_this_turn:
            result["duplicateSuppressed"] = True
        else:
            _mark_turn_tool(
                user_id=user_id,
                session_id=session_id,
                command_id=command_id,
                tool_name="get_asset_generation_status",
                scope=key,
            )
        return result

    if _same_turn_generation_detected(
        user_id=user_id,
        session_id=session_id,
        command_id=command_id,
        asset_key=key,
    ):
        result = {
            "ok": True,
            "assetKey": key,
            "status": "pending",
            "sameTurnDeferred": True,
            "message": "Generation was started in this same turn; report pending and wait for user follow-up.",
        }
        if already_checked_this_turn:
            result["duplicateSuppressed"] = True
        else:
            _mark_turn_tool(
                user_id=user_id,
                session_id=session_id,
                command_id=command_id,
                tool_name="get_asset_generation_status",
                scope=key,
            )
        return result

    if latest is None:
        result = {
            "ok": True,
            "assetKey": key,
            "status": "unknown",
            "latestEvent": None,
        }
        if already_checked_this_turn:
            result["duplicateSuppressed"] = True
        else:
            _mark_turn_tool(
                user_id=user_id,
                session_id=session_id,
                command_id=command_id,
                tool_name="get_asset_generation_status",
                scope=key,
            )
        return result

    payload = latest.get("payload", {}) if isinstance(latest.get("payload"), dict) else {}
    event_type = str(latest.get("eventType") or "")
    if event_type == "asset.refinement.failed":
        result = {
            "ok": True,
            "assetKey": key,
            "status": "failed",
            "reasonCode": payload.get("reasonCode"),
            "userMessage": payload.get("userMessage"),
            "error": payload.get("error"),
            "latestEvent": latest,
        }
        if already_checked_this_turn:
            result["duplicateSuppressed"] = True
        else:
            _mark_turn_tool(
                user_id=user_id,
                session_id=session_id,
                command_id=command_id,
                tool_name="get_asset_generation_status",
                scope=key,
            )
        return result
    result = {
        "ok": True,
        "assetKey": key,
        "status": "pending",
        "latestEvent": latest,
    }
    if already_checked_this_turn:
        result["duplicateSuppressed"] = True
    else:
        _mark_turn_tool(
            user_id=user_id,
            session_id=session_id,
            command_id=command_id,
            tool_name="get_asset_generation_status",
            scope=key,
        )
    return result


def list_assets(*, include_deleted: bool = False, tool_context: ToolContext) -> dict[str, Any]:
    """List assets for reuse before creating new ones."""
    user_id, session_id = _ctx(tool_context)
    assets = store.list_assets(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        include_deleted=bool(include_deleted),
    )
    return {"ok": True, "count": len(assets), "assets": assets}


def create_svg_asset(
    *,
    asset_key: str,
    asset_type: str,
    svg: str,
    name: str | None = None,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Create or reuse an SVG asset version."""
    user_id, session_id = _ctx(tool_context)
    valid_svg, svg_error = store.validate_svg(svg)
    if not valid_svg:
        return {"ok": False, "error": f"Invalid SVG: {svg_error}"}

    try:
        created = store.create_asset(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            asset_key=_slug(asset_key, "asset"),
            asset_type=_slug(asset_type, "asset"),
            svg=svg,
            name=name,
            metadata={"source": "tool", "generated": True},
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {"ok": True, "asset": created}


def delete_asset(
    *,
    asset_id: str | None = None,
    asset_key: str | None = None,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Delete asset by id or key."""
    user_id, session_id = _ctx(tool_context)
    if isinstance(asset_id, str) and asset_id.strip():
        deleted = store.delete_asset_by_id(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            asset_id=asset_id.strip(),
        )
        return {"ok": deleted, "deletedCount": 1 if deleted else 0}

    if isinstance(asset_key, str) and asset_key.strip():
        count = store.delete_asset_by_key(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            asset_key=asset_key.strip(),
        )
        return {"ok": count > 0, "deletedCount": count}

    return {"ok": False, "error": "Provide asset_id or asset_key."}


def create_scene(
    *,
    scene_name: str,
    scene_id: str | None = None,
    start_ms: int = 0,
    end_ms: int = 5000,
    track_order: int = 0,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Create a timeline scene clip and set it active."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    resolved_id = _slug(scene_id or scene_name, "scene")
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    state = view.get("state", {})
    scenes = state.get("scenes", {}) if isinstance(state, dict) else {}
    existing = scenes.get(resolved_id) if isinstance(scenes, dict) else None
    if isinstance(existing, dict):
        clip = existing.get("clip", {}) if isinstance(existing.get("clip"), dict) else {}
        same_clip = (
            int(clip.get("startMs", 0)) == max(0, int(start_ms))
            and int(clip.get("endMs", 0)) == max(0, int(end_ms))
            and int(clip.get("trackOrder", 0)) == int(track_order)
        )
        same_name = str(existing.get("name") or resolved_id) == str(scene_name or resolved_id)
        if same_clip and same_name:
            return {"ok": True, "event": None, "mutated": False, "state": state}

    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.create",
        payload={
            "sceneId": resolved_id,
            "name": scene_name or resolved_id,
            "startMs": max(0, int(start_ms)),
            "endMs": max(0, int(end_ms)),
            "trackOrder": int(track_order),
        },
        command_id=command_id,
        window_id=window_id,
    )
    fresh = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return {"ok": True, "event": event, "mutated": True, "state": fresh["state"]}


def delete_scene(*, scene_id: str, tool_context: ToolContext) -> dict[str, Any]:
    """Delete one scene."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.delete",
        payload={"sceneId": _slug(scene_id, "scene")},
        command_id=command_id,
        window_id=window_id,
    )
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return {"ok": True, "event": event, "state": view["state"]}


def select_scene(*, scene_id: str, tool_context: ToolContext) -> dict[str, Any]:
    """Select active scene for subsequent edits."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.select",
        payload={"sceneId": _slug(scene_id, "scene")},
        command_id=command_id,
        window_id=window_id,
    )
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return {"ok": True, "event": event, "state": view["state"]}


def set_scene_background(
    *,
    asset_key: str,
    scene_id: str | None = None,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Assign background asset to a scene."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    resolved_scene = _ensure_scene_for_write(
        user_id=user_id,
        session_id=session_id,
        requested_scene_id=scene_id,
        command_id=command_id,
        window_id=window_id,
    )
    current = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    scenes = current.get("scenes", {}) if isinstance(current, dict) else {}
    scene = scenes.get(resolved_scene) if isinstance(scenes, dict) else None
    background = scene.get("background") if isinstance(scene, dict) else None
    current_key = str(background.get("assetKey") or "") if isinstance(background, dict) else ""
    desired_key = _slug(asset_key, "asset")
    if current_key == desired_key:
        return {"ok": True, "event": None, "mutated": False, "state": current}

    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.set_background",
        payload={
            "sceneId": resolved_scene,
            "assetRef": {"assetKey": desired_key},
        },
        command_id=command_id,
        window_id=window_id,
    )
    view = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    return {"ok": True, "event": event, "mutated": True, "state": view["state"]}


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:
        return default
    return parsed


def _approx(a: float, b: float, eps: float = 1e-4) -> bool:
    return abs(float(a) - float(b)) <= eps


def _resolve_entity_id(
    *,
    scene_state: dict[str, Any] | None,
    requested_entity_id: str | None,
    entity_name: str,
    asset_key: str,
) -> str:
    if requested_entity_id:
        return _slug(requested_entity_id, "entity")

    fallback = _slug(entity_name, "entity")
    if not isinstance(scene_state, dict):
        return fallback
    entities = scene_state.get("entities", {})
    if not isinstance(entities, dict):
        return fallback

    desired_key = _slug(asset_key, "asset")
    for entity_id, entity in entities.items():
        if not isinstance(entity, dict):
            continue
        asset = entity.get("asset")
        if not isinstance(asset, dict):
            continue
        if str(asset.get("assetKey") or "") == desired_key:
            return str(entity_id)

    desired_name = _slug(entity_name, "entity")
    for entity_id, entity in entities.items():
        if not isinstance(entity, dict):
            continue
        current_name = str(entity.get("name") or entity_id)
        if _slug(current_name, "entity") == desired_name:
            return str(entity_id)
    return fallback


def _scene_has_same_keyframe(
    *,
    scene_state: dict[str, Any] | None,
    entity_id: str,
    time_ms: int,
    x: float,
    y: float,
    scale_x: float,
    scale_y: float,
    rotation_deg: float,
    opacity: float,
) -> bool:
    if not isinstance(scene_state, dict):
        return False
    entities = scene_state.get("entities", {})
    if not isinstance(entities, dict):
        return False
    entity = entities.get(entity_id)
    if not isinstance(entity, dict):
        return False
    keyframes = entity.get("keyframes", [])
    if not isinstance(keyframes, list):
        return False
    target_t = max(0, int(time_ms))
    for keyframe in keyframes:
        if not isinstance(keyframe, dict):
            continue
        if int(keyframe.get("timeMs", -1)) != target_t:
            continue
        if (
            _approx(_to_float(keyframe.get("x"), 0.0), x)
            and _approx(_to_float(keyframe.get("y"), 0.0), y)
            and _approx(_to_float(keyframe.get("scaleX"), 1.0), scale_x)
            and _approx(_to_float(keyframe.get("scaleY"), 1.0), scale_y)
            and _approx(_to_float(keyframe.get("rotationDeg"), 0.0), rotation_deg)
            and _approx(_to_float(keyframe.get("opacity"), 1.0), opacity)
        ):
            return True
    return False


def add_entity(
    *,
    entity_name: str,
    asset_key: str,
    entity_id: str | None = None,
    scene_id: str | None = None,
    x: float = 640.0,
    y: float = 360.0,
    time_ms: int = 0,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    rotation_deg: float = 0.0,
    opacity: float = 1.0,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Add or update one entity track and place it with a visible keyframe."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    resolved_scene = _ensure_scene_for_write(
        user_id=user_id,
        session_id=session_id,
        requested_scene_id=scene_id,
        command_id=command_id,
        window_id=window_id,
    )
    current_state = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    scenes = current_state.get("scenes", {}) if isinstance(current_state, dict) else {}
    current_scene = scenes.get(resolved_scene) if isinstance(scenes, dict) else None
    resolved_entity = _resolve_entity_id(
        scene_state=current_scene,
        requested_entity_id=entity_id,
        entity_name=entity_name,
        asset_key=asset_key,
    )

    desired_asset_key = _slug(asset_key, "asset")
    add_event = None
    if isinstance(current_scene, dict):
        entities = current_scene.get("entities", {})
        entity_state = entities.get(resolved_entity) if isinstance(entities, dict) else None
        entity_name_current = str(entity_state.get("name") or "") if isinstance(entity_state, dict) else ""
        asset_current = entity_state.get("asset") if isinstance(entity_state, dict) else None
        asset_key_current = str(asset_current.get("assetKey") or "") if isinstance(asset_current, dict) else ""
        needs_add_or_update = (
            not isinstance(entity_state, dict)
            or asset_key_current != desired_asset_key
            or entity_name_current != entity_name
        )
    else:
        needs_add_or_update = True

    if needs_add_or_update:
        add_event = store.append_event(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            event_type="scene.entity.add",
            payload={
                "sceneId": resolved_scene,
                "entityId": resolved_entity,
                "name": entity_name,
                "assetRef": {"assetKey": desired_asset_key},
            },
            command_id=command_id,
            window_id=window_id,
        )

    keyframe_event = None
    same_keyframe = _scene_has_same_keyframe(
        scene_state=current_scene,
        entity_id=resolved_entity,
        time_ms=max(0, int(time_ms)),
        x=float(x),
        y=float(y),
        scale_x=float(scale_x),
        scale_y=float(scale_y),
        rotation_deg=float(rotation_deg),
        opacity=float(opacity),
    )
    if not same_keyframe:
        keyframe_event = store.append_event(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
            event_type="scene.entity.keyframe_set",
            payload={
                "sceneId": resolved_scene,
                "entityId": resolved_entity,
                "timeMs": max(0, int(time_ms)),
                "x": float(x),
                "y": float(y),
                "scaleX": float(scale_x),
                "scaleY": float(scale_y),
                "rotationDeg": float(rotation_deg),
                "opacity": float(opacity),
            },
            command_id=command_id,
            window_id=window_id,
        )

    state = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    return {
        "ok": True,
        "entityId": resolved_entity,
        "event": keyframe_event or add_event,
        "mutated": bool(add_event or keyframe_event),
        "state": state,
    }


def move_entity(
    *,
    entity_id: str,
    x: float,
    y: float,
    time_ms: int,
    scene_id: str | None = None,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    rotation_deg: float = 0.0,
    opacity: float = 1.0,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Set a keyframe for an existing entity."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    resolved_scene = _ensure_scene_for_write(
        user_id=user_id,
        session_id=session_id,
        requested_scene_id=scene_id,
        command_id=command_id,
        window_id=window_id,
    )
    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.entity.keyframe_set",
        payload={
            "sceneId": resolved_scene,
            "entityId": _slug(entity_id, "entity"),
            "timeMs": max(0, int(time_ms)),
            "x": float(x),
            "y": float(y),
            "scaleX": float(scale_x),
            "scaleY": float(scale_y),
            "rotationDeg": float(rotation_deg),
            "opacity": float(opacity),
        },
        command_id=command_id,
        window_id=window_id,
    )
    state = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    return {"ok": True, "event": event, "state": state}


def set_camera(
    *,
    time_ms: int,
    x: float = 0.0,
    y: float = 0.0,
    zoom: float = 1.0,
    rotation_deg: float = 0.0,
    scene_id: str | None = None,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Set scene camera keyframe."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    resolved_scene = _ensure_scene_for_write(
        user_id=user_id,
        session_id=session_id,
        requested_scene_id=scene_id,
        command_id=command_id,
        window_id=window_id,
    )

    event = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="scene.camera.keyframe_set",
        payload={
            "sceneId": resolved_scene,
            "timeMs": max(0, int(time_ms)),
            "x": float(x),
            "y": float(y),
            "zoom": float(zoom),
            "rotationDeg": float(rotation_deg),
        },
        command_id=command_id,
        window_id=window_id,
    )
    state = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    return {"ok": True, "event": event, "state": state}


def undo_last(*, tool_context: ToolContext) -> dict[str, Any]:
    """Undo last effective timeline event."""
    user_id, session_id = _ctx(tool_context)
    command_id, window_id = _ids(tool_context)
    events = store.list_events(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    candidates = [item for item in events if item.get("isEffective") and not item.get("isCorrection")]
    if not candidates:
        return {"ok": False, "error": "No event to undo."}

    target = candidates[-1]
    correction = store.append_event(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        event_type="timeline.correct",
        payload={"action": "undo_sequence", "targetSequence": target["sequence"]},
        command_id=command_id,
        window_id=window_id,
        is_correction=True,
        corrects_sequence=target["sequence"],
    )
    state = store.timeline_view(app_name=APP_NAME, user_id=user_id, session_id=session_id)["state"]
    return {"ok": True, "undone": target["sequence"], "event": correction, "state": state}


ASSET_TOOLS = [
    list_assets,
    generate_svg_asset,
    get_asset_generation_status,
    create_svg_asset,
    delete_asset,
]

TIMELINE_TOOLS = [
    create_scene,
    delete_scene,
    select_scene,
    set_scene_background,
    add_entity,
    move_entity,
    set_camera,
    undo_last,
]

VALIDATOR_TOOLS = [
    get_timeline_state,
]
