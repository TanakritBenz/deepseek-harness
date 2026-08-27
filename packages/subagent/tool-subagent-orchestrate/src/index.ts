/**
 * Model-facing `orchestrate` tool: divide one task into subtasks and run them
 * as parallel one-shot subagents over the configured `ctx.subagents` provider.
 * The model authors the subtask graph in the call (the divide), this plugin
 * schedules it with maximal legal parallelism over the seam's concurrent
 * starts (the conquer), and returns every settled outcome to the calling
 * agent, which owns integration and review. Per-subtask provider, model, and
 * reasoning-effort overrides ride the seam's own request fields.
 * @module @deepseek-ai/dsh-tool-subagent-orchestrate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { runSubtaskGraph, validateSubtaskGraph } from './scheduler.ts'
import type {
  OrchestrationSubtask,
  SubtaskExecution,
  SubtaskOutcome,
} from './scheduler.ts'
// Declaration merge only: makes ctx.systemPrompt visible for the section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-subagent-orchestrate'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Rendered-output ceiling per subtask, applied to the complete rendered value. */
const OUTPUT_CHAR_BUDGET = 4_000

/** Prompt order immediately after the single-delegation policy section (order 116.5). */
const ORCHESTRATE_SECTION_ORDER = 117

/** Config: default delegation route plus scheduling bounds for the fan-out. */
export interface Config {
  /** The default `ctx.subagents` provider running subtasks without an explicit `provider`. */
  provider: string
  /** Model-facing tool name (default `orchestrate`). */
  toolName?: string
  /**
   * Model id used by subtasks that do not name one; omitted fields keep the
   * child route resolution of the chosen provider (in-process backends inherit
   * the delegating parent's route).
   */
  model?: string
  /**
   * Reasoning effort pinned on every subtask that does not name one. Requires
   * a provider with the `reasoningEffort` capability (mount fails loud
   * otherwise); per-subtask values need it too.
   */
  reasoningEffort?: string
  /** Maximum concurrently executing subtasks (default `4`; minimum `1`). */
  maxConcurrency?: number
  /** Inclusive upper bound on submitted subtasks (default `8`). */
  maxSubtasks?: number
  /**
   * Maximum child depth: a non-negative safe integer (default `3`), or
   * `'provider-managed'` to send no cap. A numeric cap requires the default
   * provider's `depthLimit` capability at mount.
   */
  maxDepth?: number | 'provider-managed'
  /**
   * Whether subtasks may name their own `provider` (default true). Disabled
   * instances reject any explicit provider at execute time.
   */
  allowProviderOverride?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('orchestrate'),
  model: z.string(),
  reasoningEffort: z.string(),
  maxConcurrency: z.natural().min(1).max(32).default(4),
  maxSubtasks: z.natural().min(1).max(64).default(8),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  allowProviderOverride: z.boolean().default(true),
})

/** One validated call's subtask list shape (mirrors the tool parameter schema). */
interface SubmittedSubtask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly depends_on?: readonly string[]
}

interface OrchestrateArgs {
  readonly task: string
  readonly subtasks: readonly SubmittedSubtask[]
}

/** Canonical per-subtask result row returned to the parent for review. */
interface ResultRow {
  readonly id: string
  readonly title: string
  readonly provider: string
  readonly status: SubtaskOutcome['status']
  readonly output: string
  readonly model?: string
  readonly stopReason?: string
  readonly diagnostic?: string
  readonly skipReason?: string
}

/** Render text blocks from a canonical content-block array without trusting arbitrary values. */
function outputText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Await one started run's terminal result and always release the run, so
 * disposal can never replace an independent result failure. A rejected result
 * (infrastructure fault) propagates after best-effort disposal; a failed
 * disposal after a clean result also rejects, mirroring dsh-tool-subagent.
 * @param started - the pending `ctx.subagents.start()` promise.
 * @returns the child's terminal result.
 */
async function settleStartedRun(started: Promise<SubagentRun>): Promise<SubagentResult> {
  const run = await started
  const [result] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (result.status === 'rejected') throw result.reason
  if (disposal.status === 'rejected') throw disposal.reason
  return result.value
}

/** The pending-state card: generic, titled from the task. */
function presentOrchestrationCall(args: OrchestrateArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `orchestrate: ${args.subtasks.length} subtask${args.subtasks.length === 1 ? '' : 's'}`,
    rawInput: args.task,
  }
}

/** The completed-state card keeps the pending title; the renderer carries the outcomes. */
function presentOrchestrationResult(_args: OrchestrateArgs, _result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  return { card: 'generic' }
}

/**
 * Truncate one rendered subtask output to its display budget so the complete
 * rendered result stays bounded regardless of how much the children wrote.
 * @param text - the full collected output.
 * @param limit - inclusive character ceiling for the rendered value.
 * @returns the original text, or a visibly truncated prefix.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [truncated: ${text.length - limit} more characters]`
}

/** Structural view of the canonical value for rendering; looser than the build-side aliases. */
interface RenderableOrchestration {
  readonly task: string
  readonly counts: { readonly total: number; readonly completed: number; readonly failed: number; readonly skipped: number }
  readonly results: readonly {
    readonly id: string
    readonly title: string
    readonly provider: string
    readonly status: string
    readonly output: string
    readonly model?: string
    readonly stopReason?: string
    readonly diagnostic?: string
    readonly skipReason?: string
  }[]
}

/** Human-readable review transcript: statuses first, then each outcome body. */
function renderOutcomes(value: RenderableOrchestration, maxCharsPerOutput: number): string {
  const lines = [
    `Task "${value.task}" — ${value.counts.completed}/${value.counts.total} completed`
    + `, ${value.counts.failed} failed, ${value.counts.skipped} skipped.`,
    'Review these results, integrate what is correct, and fix or re-delegate the rest.',
  ]
  for (const row of value.results) {
    lines.push('')
    lines.push(`## ${row.status.toUpperCase()} ${row.id}: ${row.title} (${row.provider}${row.model !== undefined ? ` / ${row.model}` : ''})`)
    if (row.status === 'skipped') {
      lines.push(`Skipped: ${row.skipReason ?? 'an upstream dependency did not complete'}`)
      continue
    }
    if (row.stopReason !== undefined) lines.push(`Stop reason: ${row.stopReason}`)
    if (row.diagnostic !== undefined) lines.push(`Diagnostic: ${row.diagnostic}`)
    if (row.output.trim().length > 0) lines.push(clip(row.output, maxCharsPerOutput))
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints; mirror the loader defaults.
  const resolved = {
    provider: config.provider,
    toolName: config.toolName ?? 'orchestrate',
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxConcurrency: config.maxConcurrency ?? 4,
    maxSubtasks: config.maxSubtasks ?? 8,
    maxDepth: config.maxDepth,
    allowProviderOverride: config.allowProviderOverride ?? true,
  }
  if (resolved.maxDepth !== 'provider-managed') assertSubagentMaxDepth(resolved.maxDepth)

  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // Misconfigurations fail loud at mount (the earliest point the default
    // provider's capabilities are known), not on the first orchestration.
    if (typeof resolved.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent-orchestrate: provider "${provider.name}" cannot enforce maxDepth (no depthLimit `
        + 'capability) — set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (resolved.reasoningEffort !== undefined && !provider.capabilities.reasoningEffort) {
      throw new Error(
        `tool-subagent-orchestrate: provider "${provider.name}" cannot pin the configured reasoningEffort `
        + '(no reasoningEffort capability) — drop the config key or use an in-process provider',
      )
    }
    disposeTool = ctx.tools.register(defineTool({
      name: resolved.toolName,
      description:
        'Divide a larger task into smaller self-contained subtasks and run them as parallel subagents '
        + '(a separate agent works on each piece in its own context). Independent subtasks run at the same '
        + 'time; declare dependencies only where one subtask genuinely needs another\'s result. You orchestrate: '
        + 'each subtask gets a complete standalone prompt (paste in exactly what it needs), and you receive every '
        + 'result back for review and integration — the subagents\' intermediate steps stay theirs. Optionally pin '
        + 'a different provider/model/reasoning effort per subtask.',
      parameters: {
        task: {
          type: 'string',
          required: true,
          description: 'The overall objective, stated once here; every subtask also needs its own complete prompt.',
        },
        subtasks: {
          type: 'array',
          required: true,
          description: 'The divided pieces of the task. Make them independent and run them in parallel whenever possible.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: 'Stable key other subtasks reference in depends_on.' },
              title: { type: 'string', required: true, description: 'Short (3-5 word) description for display.' },
              prompt: {
                type: 'string',
                required: true,
                description: 'Complete standalone instructions including all material the subagent needs; it sees nothing else.',
              },
              provider: {
                type: 'string',
                description: 'Registered ctx.subagents provider to run this subtask (e.g. spawn, fork, claude-code, codex, acp); omit for the default.',
              },
              model: { type: 'string', description: 'Model-id override for this subtask.' },
              effort: {
                type: 'string',
                description: 'Reasoning-effort override (adapter-owned id). Requires an in-process provider such as spawn or fork.',
              },
              depends_on: {
                type: 'array',
                description: 'Subtask ids that must complete before this one starts; omit for immediate parallel start.',
                items: { type: 'string' },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'completed' },
            task: { type: 'string', required: true },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                total: { type: 'integer', required: true },
                completed: { type: 'integer', required: true },
                failed: { type: 'integer', required: true },
                skipped: { type: 'integer', required: true },
              },
            },
            results: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  provider: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  output: { type: 'string', required: true },
                  model: { type: 'string' },
                  stopReason: { type: 'string' },
                  diagnostic: { type: 'string' },
                  skipReason: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderOutcomes(value, OUTPUT_CHAR_BUDGET),
        }],
      },
      // Children never mutate the parent session, mirroring dsh-tool-subagent.
      isConcurrencySafe: () => true,
      presentCall: presentOrchestrationCall,
      presentResult: presentOrchestrationResult,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          throw new Error('orchestrate tool requires a calling agent (exec.agent was undefined)')
        }
        // Normalize the wire spelling (`depends_on`) into the scheduler's
        // graph vocabulary once, so validation and execution read one shape.
        const graph: OrchestrationSubtask[] = args.subtasks.map(subtask => ({
          id: subtask.id,
          title: subtask.title,
          prompt: subtask.prompt,
          ...subtask.provider !== undefined ? { provider: subtask.provider } : {},
          ...subtask.model !== undefined ? { model: subtask.model } : {},
          ...subtask.effort !== undefined ? { effort: subtask.effort } : {},
          ...subtask.depends_on !== undefined ? { dependsOn: subtask.depends_on } : {},
        }))
        validateSubtaskGraph(graph, resolved.maxSubtasks)
        if (!resolved.allowProviderOverride) {
          const overridden = graph.find(subtask => subtask.provider !== undefined)
          if (overridden !== undefined) {
            throw new Error(
              'provider overrides are disabled for this tool instance (allowProviderOverride: false); '
              + `subtask "${overridden.id}" named "${overridden.provider}"`,
            )
          }
        }

        // Resolve every route BEFORE starting anything: a misrouted graph must
        // not spend delegations it cannot finish.
        const routes = new Map<string, { provider: string; model?: string; effort?: string }>()
        for (const subtask of graph) {
          const provider = subtask.provider ?? resolved.provider
          const model = subtask.model ?? resolved.model
          const target = ctx.subagents.getProvider(provider)
          if (target === undefined) {
            throw new Error(
              `no subagent provider registered for "${provider}" (registered: ${ctx.subagents.list().join(', ') || 'none'}); `
              + `fix subtask "${subtask.id}"`,
            )
          }
          const effort = subtask.effort ?? resolved.reasoningEffort
          if (effort !== undefined && !target.capabilities.reasoningEffort) {
            throw new Error(
              `subagent provider "${provider}" cannot pin a reasoning effort (no reasoningEffort capability); `
              + `drop the effort override on subtask "${subtask.id}" or use an in-process provider`,
            )
          }
          if (typeof resolved.maxDepth === 'number' && !target.capabilities.depthLimit) {
            throw new Error(
              `subagent provider "${provider}" cannot enforce maxDepth (no depthLimit capability); `
              + `set maxDepth: 'provider-managed' or drop the override on subtask "${subtask.id}"`,
            )
          }
          routes.set(subtask.id, {
            provider,
            ...model !== undefined ? { model } : {},
            ...effort !== undefined ? { effort } : {},
          })
        }

        const run = async (subtask: OrchestrationSubtask): Promise<SubtaskExecution> => {
          const route = routes.get(subtask.id) as { provider: string; model?: string; effort?: string }
          const agentOptions: AgentOptions = {
            ...(route.model !== undefined ? { model: route.model } : {}),
          }
          const started = ctx.subagents.start(route.provider, {
            label: subtask.title,
            prompt: [{ type: 'text', text: subtask.prompt }] as ContentBlock[],
            parent,
            signal: exec.signal,
            agentOptions,
            ...(route.effort !== undefined ? { reasoningEffort: ReasoningEffortId(route.effort) } : {}),
            ...(typeof resolved.maxDepth === 'number' ? { maxDepth: resolved.maxDepth } : {}),
          })
          const settled = await settleStartedRun(started)
          return {
            status: settled.stopReason === 'completed' ? 'completed' : 'failed',
            output: outputText(settled.output),
            ...settled.stopReason !== 'completed' ? { stopReason: settled.stopReason } : {},
            ...settled.diagnostic !== undefined ? { diagnostic: settled.diagnostic } : {},
          }
        }

        const outcomes = await runSubtaskGraph(
          graph,
          { maxConcurrency: resolved.maxConcurrency, signal: exec.signal },
          run,
        )
        const rows: ResultRow[] = outcomes.map((outcome) => {
          const route = routes.get(outcome.id) as { provider: string; model?: string }
          return {
            id: outcome.id,
            title: outcome.title,
            provider: route.provider,
            status: outcome.status,
            output: outcome.output,
            ...route.model !== undefined ? { model: route.model } : {},
            ...outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {},
            ...outcome.diagnostic !== undefined ? { diagnostic: outcome.diagnostic } : {},
            ...outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {},
          }
        })
        return {
          kind: 'completed' as const,
          task: args.task,
          counts: {
            total: rows.length,
            completed: rows.filter(row => row.status === 'completed').length,
            failed: rows.filter(row => row.status === 'failed').length,
            skipped: rows.filter(row => row.status === 'skipped').length,
          },
          results: rows,
        }
      },
    }))
  }

  // Mirror provider lifecycle so a late-loading default provider still mounts
  // the tool, mirroring dsh-tool-subagent's registration timing.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === resolved.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (removedName) => {
    if (removedName !== resolved.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(resolved.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${resolved.provider}" not registered yet; the "${resolved.toolName}" tool will register when it appears`)
  }

  ctx.systemPrompt.section({
    name: `tool:${resolved.toolName}`,
    order: ORCHESTRATE_SECTION_ORDER,
    text: context => disposeTool === undefined || ctx.tools.get(resolved.toolName, context.scope) === undefined
      ? ''
      : orchestrationGuidance(resolved.toolName, ctx.subagents.list(), Boolean(resolved.reasoningEffort)),
  })
}

/** Usage policy shipped with the tool: divide, parallelize, pin only when needed, review. */
function orchestrationGuidance(toolName: string, providers: readonly string[], defaultEffortPinned: boolean): string {
  return [
    `Use ${toolName} when a task divides into three or more independent or loosely dependent pieces `
      + '(parallel research across files or topics, multi-module implementation, multi-angle review): split it '
      + 'into small self-contained subtasks, paste the exact material each needs into its prompt, and let the '
      + 'independent ones run in parallel; add depends_on edges only for real data dependencies. For one or two '
      + `delegations, prefer plain subagent calls instead. Available providers: ${providers.join(', ') || 'none'}.`
      + ' Pin a subtask\'s provider/model/effort only when the user asked for that model or the piece clearly '
      + 'needs it; every explicit effort requires an in-process provider.'
      + (defaultEffortPinned
        ? ' This instance pins a default reasoning effort on every subtask.'
        : ''),
    'After the call returns, review every result before acting on it: verify claimed changes against reality, '
      + 're-delegate failed or weak pieces with sharper prompts, and treat skipped subtasks as work still owed.',
  ].join('\n')
}
