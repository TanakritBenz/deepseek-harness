/** Package-local scripted child boundary for deterministic orchestrate tests. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

const DEFAULT_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
  reasoningEffort: true,
}

/** What one scripted start recorded, for assertions on the built request. */
interface RecordedStart {
  readonly label: string | undefined
  readonly prompt: string
  readonly agentOptions: SubagentStartRequest['agentOptions']
  readonly reasoningEffort: string | undefined
  readonly maxDepth: number | undefined
}

/** Options for one scripted provider fixture. */
export interface Config {
  /** Registry name to register under. */
  name: string
  /** Final text returned by each scripted child. */
  reply?: string
  /** Terminal result reason applied to every child. */
  stopReason?: SubagentStopReason
  /** Safe non-assistant detail for a non-completed result. */
  diagnostic?: string
  /** Start-time features advertised by the provider. */
  capabilities?: Partial<SubagentCapabilities>
  /** Per-child result overrides keyed by the child's exact prompt text. */
  perPrompt?: Record<string, { reply?: string; stopReason?: SubagentStopReason; diagnostic?: string }>
  /**
   * Observes and gates each start: the child's run settles only when the
   * returned promise settles, giving tests deterministic concurrency control.
   */
  onStart?: (request: SubagentStartRequest) => Promise<void> | void
}

/** Scripted provider recording every start request for route assertions. */
class ScriptedOrchestrateProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext = false
  readonly starts: RecordedStart[] = []

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities }
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('scripted subagent start aborted before publication')
    const text = request.prompt
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    this.starts.push({
      label: request.label,
      prompt: text,
      agentOptions: request.agentOptions,
      reasoningEffort: request.reasoningEffort === undefined ? undefined : request.reasoningEffort,
      maxDepth: request.maxDepth,
    })
    await this.config.onStart?.(request)
    const scripted = this.config.perPrompt?.[text]
    const stopReason = scripted?.stopReason ?? this.config.stopReason ?? 'completed'
    const reply = scripted?.reply ?? this.config.reply ?? 'scripted reply'
    const diagnostic = scripted?.diagnostic ?? this.config.diagnostic
    const output: ContentBlock[] = [{ type: 'text', text: `${reply}: ${text}` }]
    const result: SubagentResult = {
      output,
      stopReason,
      ...(diagnostic !== undefined && stopReason !== 'completed' ? { diagnostic } : {}),
    }
    return {
      id: SessionId(`scripted-${this.starts.length}`),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: async () => {},
    }
  }
}

/**
 * Mount one scripted provider on the context's subagents registry.
 * @param ctx - context carrying `ctx.subagents`.
 * @param config - the fixture configuration.
 * @returns the mounted provider (with start records) plus its registration disposer.
 */
export function mountScriptedProvider(
  ctx: Context,
  config: Config,
): ScriptedOrchestrateProvider & { dispose(): Promise<void> } {
  const provider = new ScriptedOrchestrateProvider(config.name, config)
  const dispose = ctx.subagents.registerProvider(provider)
  return Object.assign(provider, {
    dispose: async () => {
      dispose()
    },
  })
}
