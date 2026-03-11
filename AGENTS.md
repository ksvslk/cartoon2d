# General Animation Rules

These rules apply to any agent touching the motion, rigging, playback, or validation pipeline in this repository.

## Source Of Truth

- The canonical IK graph is the only runtime animation source of truth.
- Authored SVG groups are rest-state art, not animation state.
- Motion generation must compile into canonical node transforms and constraints, not direct per-bone art mutations.

## Generality First

- Do not write anatomy-specific or species-specific heuristics in animation code.
- Do not branch on names like `tail`, `fin`, `wing`, `arm`, `leg`, `head`, `torso`, `fish`, `bird`, or similar in runtime motion generation, validation, playback, or physics.
- Do not use regexes over node IDs or bone IDs to decide motion weights, solver behavior, damping, or validation rules.
- If metadata is missing, infer from topology, continuity, depth, branching, constraints, and bindings, not from names.

## AI Contract

- AI should return motion intent, not final keyframes.
- AI inputs should describe topology, constraints, usable limits, playable views, and requested action.
- Deterministic code must synthesize the playable loop from that structured intent.
- If intent cannot be satisfied safely, return blocked reasons instead of forcing a clip.

## Validation

- Validation errors must be structural and actionable.
- A clip must be blocked if it violates hard limits, stretches fixed lengths, drifts pins, or lacks required playable bindings.
- Do not invent fallback clip bindings when clip generation fails.
- Scene logs must say exactly what failed and why.

## Rendering

- Do not mutate original art groups to "fix" animation.
- Use wrapper groups or canonical node bindings for runtime transforms.
- Softening or attachment cleanup must use real pivots or sockets, never guessed decorative markers.

## Allowed Metadata

- Schema enums like `kind`, `side`, `contactRole`, and `massClass` may exist for authoring and inspection.
- Those labels are advisory metadata only; they must not become hardcoded behavior in the motion pipeline.

## When In Doubt

- Prefer fewer assumptions.
- Prefer topology-driven defaults.
- Prefer blocking over fake success.
