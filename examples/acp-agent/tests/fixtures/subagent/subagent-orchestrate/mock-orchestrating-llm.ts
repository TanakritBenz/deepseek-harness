import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Test adapter for the orchestrate composition smoke. One scripted decision
 * tree keeps every role deterministic without per-session state:
 *
 * 1. a request whose history already carries a tool result is the parent's
 *    wrap-up turn — stream the orchestration transcript back verbatim;
 * 2. a request whose latest user text names an `ORCH-` probe is a child turn —
 *    answer with that marker so the e2e can attribute each child session;
 * 3. otherwise this is the parent's first turn — call `orchestrate` once with
 *    two independent subtasks, exercising real concurrent fan-out.
 */
class MockOrchestratingAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const flat = options.messages.map(message => message.content).flat()
    const toolResultText = flat
      .filter(block => block.type === 'tool-result')
      .flatMap(block => block.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')

    if (toolResultText.length > 0) {
      const reply = `orchestration complete:\n${toolResultText}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: reply.length } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // A delegated child carries its probe prompt plus an injected
    // runtime-context snapshot AFTER it, so scan every user message rather
    // than only the latest one.
    const userText = options.messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .flat()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const marker = /Reply with exactly: (ORCH-[A-Z])/.exec(userText)?.[1]
    if (marker !== undefined) {
      const reply = `${marker} ok`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const args = JSON.stringify({
      task: 'parallel probe',
      subtasks: [
        { id: 'a', title: 'Probe A', prompt: 'Reply with exactly: ORCH-A ok' },
        { id: 'b', title: 'Probe B', prompt: 'Reply with exactly: ORCH-B ok' },
      ],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: CallId('call-orchestrate'), name: 'orchestrate', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-orchestrate'), name: 'orchestrate', arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/**
 * Register the orchestrating mock adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new MockOrchestratingAdapter())
}
