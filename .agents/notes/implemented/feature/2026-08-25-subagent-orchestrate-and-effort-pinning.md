# Agent Note: Orchestrate fan-out delegation and seam-level effort pinning

Status: implemented

English | [中文](2026-08-25-subagent-orchestrate-and-effort-pinning.zh.md)

## Problem

Two gaps in the subagent family surfaced together. First, single delegation (`dsh-tool-subagent`) starts one child per call, so a task that divides into independent pieces costs one parent round-trip per piece, and the model — not the runtime — owns whatever parallelism it can improvise across turns. Second, no surface in the harness could pin a child's reasoning effort: `AgentOptions` carries provider/model only, `LlmCallConfig.reasoningEffort` is per-request state that nothing populated for delegated children, and the workflow tool rejects effort overrides outright.

## Decision

The seam grows one start-time capability and its matching request field: `SubagentCapabilities.reasoningEffort` and `SubagentStartRequest.reasoningEffort`. The service validates presence against capability like every other flag. In-process backends honor the field through `pinChildReasoningEffort`, a scoped `agent/request` listener installed in the driver's creation window that overwrites any inherited effort for the child's whole run; out-of-process backends advertise none and reject an explicit effort at start, never accepting-then-ignoring. Continuable starts reject an explicit effort outright because the durable descriptor format does not carry an effort pin, so honoring creation-time effort would silently degrade on cold resume.

`dsh-tool-subagent-orchestrate` is a new opt-in Consumer over that seam. The model authors the divide inside one call — a list of self-contained subtasks with optional `provider`, `model`, `effort`, and `depends_on` edges — and the package schedules it with maximal legal parallelism: dependency-ordered launch, no level barriers, bounded by `maxConcurrency`. A failed subtask transitively skips only its dependents; independent branches finish and report. The canonical result returns one row per subtask (status, route, output or stop reason/diagnostic/skip reason) so the calling agent keeps the orchestration role: review every outcome, integrate correct work, fix weak pieces itself, or re-delegate with sharper prompts. Per-node routing rides existing seam fields — `agentOptions.model` for models, the new effort field for reasoning effort — so vendor coverage follows provider registration rather than tool logic: DeepSeek through the in-process providers' LLM adapters, Claude through `claude-code`, ChatGPT through `codex`, OpenCode through `acp`.

## Alternatives considered

**Bump the descriptor version and carry effort into continuable children.** Snapshotting the pin would make resume behavior uniform, but version 3 invalidates every persisted continuable child's classification for a feature no current consumer needs on a resumable conversation. Rejecting explicit effort on the continuable path is loud at the decision point instead of silent at resume.

**Let the tool compose children itself via `ctx.agents.create`.** That bypasses the seam's capability validation, lifecycle events, descriptor stamping, and policy capture, and duplicates each provider's transport work. The fan-out stays a Consumer so every backend benefits without per-provider code.

**Express dependencies as topological waves.** Wave scheduling is simpler but inserts barriers between levels: a fast branch whose dependents finished early still waits for the slowest sibling level. Event-driven readiness launches each node exactly when its last dependency settles.

**Collect structured results through the seam's `outputSchema`.** Schema-constrained rows would tighten review further, but only in-process providers advertise the capability today, and a mixed-vendor graph must not silently lose structure for some branches. Text outcomes keep every provider uniform; structured capture is deferred until the capability story spans backends.

## Consequences

`packages/subagent/subagent` exports `pinChildReasoningEffort`; the spawn/fork providers advertise `reasoningEffort: true`; `NO_START_CAPABILITIES` gains the false flag, so every out-of-process backend inherits the rejection. `dsh-tool-subagent-orchestrate` ships as an opt-in package with its own scheduler (`validateSubtaskGraph`, `runSubtaskGraph`), mount-time default-route validation, provider-lifecycle tool mounting, and a `tool:<toolName>` prompt section stating when to prefer orchestration over plain delegation. Verification: service gating and pass-through tests in `subagent/tests/service.spec.ts`, a spawn end-to-end pin test asserting the child request carries the effort while the parent's does not, scheduler unit tests for parallelism/dependencies/cancellation/cycles, scripted-provider composition tests for routing, failure cascade, lifecycle mounting, and prompt guidance, and a keyless Loader smoke (`tests/loader-composition.e2e.ts` over a test-only cordis.yml) where a scripted model fans two real spawn children out through one `orchestrate` call and the parent reviews both results.
