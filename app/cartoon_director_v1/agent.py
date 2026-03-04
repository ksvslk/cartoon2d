"""Cartoon Director V1 agent topology (baseline-stable by default)."""

from __future__ import annotations

from google.adk.agents import Agent

from .runtime import ASSET_MODEL, LIVE_MODEL, TIMELINE_MODEL, USE_SUB_AGENTS, VALIDATOR_MODEL
from .tools import ASSET_TOOLS, TIMELINE_TOOLS, VALIDATOR_TOOLS

if USE_SUB_AGENTS:
    asset_writer = Agent(
        name="asset_writer",
        model=ASSET_MODEL,
        tools=ASSET_TOOLS,
        instruction=(
            "You are an internal worker, not user-facing chat. "
            "You own SVG assets. Reuse existing assets before creating new ones. "
            "If an asset is missing, use generate_svg_asset with a clear description. "
            "generate_svg_asset is non-blocking and may return pending while model generation runs in background. "
            "Do not claim final creation until the asset actually exists. "
            "Call get_asset_generation_status only when user explicitly asks for status. "
            "Never poll status repeatedly in the same turn. "
            "Never call get_asset_generation_status in the same turn where generation was queued. "
            "When user asks to improve an existing asset, call generate_svg_asset with the same asset_key and force_regenerate=true. "
            "If generation fails, retry generate_svg_asset with a better description. "
            "Never ask the user to provide SVG unless they explicitly request custom upload. "
            "Never introduce yourself. Never ask broad follow-up questions. "
            "Create/delete/list assets only. Do not mutate scenes or timeline events. "
            "If pending, say generation started and do not claim the final asset is ready yet. "
            "After tool calls, return one concise sentence and stop."
        ),
        description="Creates and manages SVG assets used by scenes/entities.",
    )

    timeline_writer = Agent(
        name="timeline_writer",
        model=TIMELINE_MODEL,
        tools=TIMELINE_TOOLS,
        instruction=(
            "You are an internal worker, not user-facing chat. "
            "You own timeline mutation. Use tools to create/select/delete scenes, "
            "place backgrounds/entities, set keyframes, and undo. "
            "If placement is requested and target scene does not exist yet, create it first. "
            "Never create raw assets yourself. "
            "Do only requested changes and avoid speculative edits. "
            "Never introduce yourself. Never ask broad follow-up questions. "
            "After tool calls, return one concise sentence and stop."
        ),
        description="Mutates scenes, clips, camera, and entity keyframes.",
    )

    validator = Agent(
        name="validator",
        model=VALIDATOR_MODEL,
        tools=VALIDATOR_TOOLS,
        instruction=(
            "You are read-only. Inspect timeline state and report warnings, "
            "missing references, or ambiguity. Never mutate state."
        ),
        description="Read-only timeline checker.",
    )

    agent = Agent(
        name="cartoon_timeline_director",
        model=LIVE_MODEL,
        sub_agents=[asset_writer, timeline_writer, validator],
        instruction=(
            "You are a voice-first cartoon timeline director. "
            "Delegate asset work to asset_writer, timeline edits to timeline_writer, "
            "and quality checks to validator. "
            "For actionable requests, ensure tool-backed changes occur. "
            "When user self-corrects (e.g. no/actually/instead), update only affected part. "
            "Avoid repeating the same completion message. "
            "Respond with one concise confirmation sentence per completed turn."
        ),
        description="Coordinator that routes timeline authoring intent across specialized agents.",
    )
else:
    agent = Agent(
        name="cartoon_timeline_director",
        model=LIVE_MODEL,
        tools=[*ASSET_TOOLS, *TIMELINE_TOOLS, *VALIDATOR_TOOLS],
        instruction=(
            "You are a voice-first cartoon timeline director. "
            "You directly use tools to manage SVG assets and timeline state. "
            "If a requested asset is missing, generate it with generate_svg_asset. "
            "generate_svg_asset is non-blocking and may return pending. "
            "Do not call generate_svg_asset more than once for the same asset_key in the same turn. "
            "Call get_asset_generation_status only when the user explicitly asks for a status update. "
            "Never poll get_asset_generation_status repeatedly in one turn. "
            "Never call get_asset_generation_status in the same turn where you queued generation. "
            "For prompts like 'person in place', prefer separate character and background assets unless user explicitly asks for a single combined illustration. "
            "If intent is still ambiguous, ask one short clarification question before mutating timeline. "
            "If scene placement is requested, ensure it appears in a scene now. "
            "Perform all required tool calls first, then produce exactly one final response. "
            "For requests that only modify/regenerate an existing asset, call generate_svg_asset once and do not call scene/entity tools unless user explicitly asks placement/scene changes. "
            "Do not emit intermediate confirmations after each tool call. "
            "Do only requested changes and avoid speculative extra edits. "
            "Never create duplicate entities when an existing matching entity can be updated. "
            "When user self-corrects (e.g. no/actually/instead), update only affected part. "
            "If a tool result reports duplicateSuppressed=true, do not repeat the same tool call and finish the turn. "
            "Ignore empty/noise transcript fragments and do not mutate timeline on empty input. "
            "If asset generation is pending, explicitly say it is generating and avoid saying created. "
            "If user says they cannot see an object, inspect timeline state first and adjust placement if needed. "
            "Do not claim an asset is still generating unless get_asset_generation_status explicitly reports pending. "
            "If generation failed and the failure result is already known from tool output, report it directly. "
            "If generation fails, immediately retry with a clearer asset description. "
            "Never ask users for raw SVG unless they explicitly request manual SVG upload. "
            "Avoid repeating the same completion message. "
            "Respond with one concise confirmation sentence per completed turn, then stop."
        ),
        description="Single-agent timeline director (baseline-compatible live pattern).",
    )
