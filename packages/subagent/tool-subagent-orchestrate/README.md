# @deepseek-ai/dsh-tool-subagent-orchestrate

English | [中文](README.zh.md)

The model-facing `orchestrate` tool over `ctx.subagents`: the calling agent divides one task into subtasks inside a single call, this package runs them as parallel one-shot delegations, and every settled outcome returns to the caller for review and integration. It composes with any registered providers, so one fan-out can span in-process children (`spawn`, `fork`) and out-of-process backends (`claude-code` for Claude models, `codex` for ChatGPT models, `acp` for OpenCode and other ACP agents) in the same graph.

## Divide, schedule, review

The model authors the subtask graph as call arguments; each entry carries a complete standalone prompt plus optional `provider`, `model`, `effort`, and `depends_on` edges. Validation rejects an empty or oversized graph, duplicate or empty identities, unknown or self dependencies, and cycles before a single child starts.

Scheduling is dependency-ordered with no level barrier: every subtask whose dependencies have completed starts immediately, up to `maxConcurrency` concurrent children. A failed subtask transitively skips only its dependents; independent branches finish and report normally. Cancellation skips pending subtasks while running children settle through their own signal.

The canonical result carries one row per subtask — status, route, final text, stop reason, diagnostic, or skip reason — in submission order. The rendered transcript opens with the counts headline and gives every outcome a status-labeled section, so the parent can review, integrate correct work, fix weak pieces itself, or re-delegate with sharper prompts. Skipped rows are work still owed.

## Routing: provider, model, effort

Subtasks without explicit overrides use the instance's configured default route. An explicit `provider` names any registered `ctx.subagents` provider, which is how one fan-out mixes vendors: DeepSeek routes through the in-process providers and their LLM adapters, Claude through `claude-code`, ChatGPT through `codex`, and OpenCode through `acp`. A `model` override rides `agentOptions.model` and is honored by in-process providers; out-of-process backends keep their own deployment-configured model. An `effort` override pins the child's reasoning effort through the seam's `reasoningEffort` request field and requires that provider's capability — today only the in-process providers advertise it, so an effort on `claude-code`, `codex`, or `acp` fails loud at execute time instead of silently degrading.

The tool mounts only while its default provider exists, mirrors provider registration lifecycle, and validates the default route's capabilities at mount: a numeric `maxDepth` requires `depthLimit`, and a configured `reasoningEffort` requires `reasoningEffort`.

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Default `ctx.subagents` provider running subtasks without an explicit `provider`. |
| `toolName` | Model-facing name, default `orchestrate`; distinct for every loaded instance. |
| `model` | Default model id for subtasks that do not name one; omission keeps each provider's own route resolution. |
| `reasoningEffort` | Default effort pinned on subtasks that do not name one; requires the default provider's `reasoningEffort` capability at mount. |
| `maxConcurrency` | Concurrent-child cap, default `4`, range `1`–`32`. |
| `maxSubtasks` | Inclusive bound on submitted subtasks, default `8`, range `1`–`64`. |
| `maxDepth` | Absolute delegation-depth cap sent with every start, default `3`; `'provider-managed'` sends no cap. A numeric cap requires each targeted provider's `depthLimit` capability. |
| `allowProviderOverride` | Whether subtasks may name their own `provider`, default `true`; disabled instances reject any explicit provider at execute time. |

## Concurrency

Calls are concurrency-safe like `dsh-tool-subagent`: children never mutate the parent session, and sibling orchestration calls overlap under the loop's rolling pool. Within one call the scheduler owns fan-out parallelism under `maxConcurrency`; coordinating sibling workspace effects between subtasks remains the model's responsibility.

## Model Experience

### Tool schema

#### What the model sees

The generated [`orchestrate` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-orchestrate) under the configured name while the default provider exists: `task`, plus a `subtasks` array of `{ id, title, prompt, provider?, model?, effort?, depends_on? }`. While visible, a `tool:<toolName>` system-prompt section states when to prefer this tool over plain subagent calls, tells the model to keep independent subtasks parallel and paste in the exact material each needs, lists the currently registered providers, warns that explicit efforts require in-process providers, and instructs the parent to review every returned result before acting on it.

#### Token effect

Fixed schema cost per parent request plus one short system-prompt section per instance.

#### KV Cache effect

Prefix-stable while provider registration and configuration are unchanged; provider lifecycle changes invalidate parent reuse from the first changed assembly.

### Orchestration result

#### What the model sees

One rendered transcript: a counts headline (`completed/total`, failed, skipped), then per-subtask sections with status, route, and either the collected output (per-output display budget with an explicit truncation notice) or the stop reason, diagnostic, and skip reason. The canonical value is the full structured row set; only rendering is clipped.

#### Token effect

Every subtask's rendered output enters parent history until compaction; child working context stays in the child sessions.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Foreground only** — the call returns after the whole graph settles; long graphs cannot be parked into a background Task yet, unlike single `subagent` delegations.
- **Continuable children reject an explicit effort** — the durable descriptor format does not carry an effort pin, so `startContinuable` rejects one loud instead of silently dropping it on cold resume.
- **No structured per-subtask capture** — outcomes are collected as the child's final assistant text; schema-constrained results would need the seam's `outputSchema` capability wired through the scheduler.
