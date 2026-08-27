/**
 * Drives the REAL plugin body: mounts `dsh-tool-subagent-orchestrate` on a
 * real `ToolRuntime` + `SubagentRuntime`, with a package-local scripted child
 * boundary, and invokes the registered `orchestrate` tool through
 * `ctx.tools.execute`. Everything downstream of the child boundary is the
 * shipping code path.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A minimal parent Agent passed through to the provider request. */
function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

interface SetupResult {
  readonly ctx: Context
  readonly provider: ReturnType<typeof mock.mountScriptedProvider>
}

async function setup(
  toolConfig: tool.Config,
  mockConfig: Partial<mock.Config> = {},
): Promise<SetupResult> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const provider = mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return { ctx, provider }
}

let callCounter = 0

function orchestrate(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined } = {},
) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path).
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'orchestrate',
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const TWO_INDEPENDENT = {
  task: 'cover the module',
  subtasks: [
    { id: 'docs', title: 'write docs', prompt: 'document exports' },
    { id: 'tests', title: 'add tests', prompt: 'cover branches' },
  ],
}

describe('dsh-tool-subagent-orchestrate', () => {
  it('fans independent subtasks out concurrently and returns every outcome for review', async () => {
    const first = deferred()
    const second = deferred()
    let settled = 0
    const { ctx, provider } = await setup({ provider: 'mock' }, {
      onStart: (request) => {
        void (request.label === 'write docs' ? first.promise : second.promise).then(() => {
          settled += 1
        })
      },
    })
    const pending = orchestrate(ctx, TWO_INDEPENDENT)
    // Both children start before either settles: no level barrier exists.
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(provider.starts).toHaveLength(2)
    first.release()
    second.release()
    const result = await pending
    expect(result.isError).toBe(false)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(2)
    const value = result.value as {
      kind: string
      counts: Record<string, number>
      results: { id: string; status: string; output: string }[]
    }
    expect(value.kind).toBe('completed')
    expect(value.counts).toMatchObject({ total: 2, completed: 2, failed: 0, skipped: 0 })
    expect(value.results.map(row => row.id)).toEqual(['docs', 'tests'])
    expect(text(result)).toContain('COMPLETED docs')
    expect(text(result)).toContain('scripted reply: document exports')
  })

  it('passes per-subtask provider, model, effort, label, and depth to the start request', async () => {
    const { ctx, provider } = await setup({
      provider: 'mock',
      maxDepth: 5,
      model: 'fallback-model',
      reasoningEffort: 'low',
    })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [
        { id: 'a', title: 'alpha', prompt: 'do a', model: 'pinned-model', effort: 'high' },
        { id: 'b', title: 'beta', prompt: 'do b', provider: 'mock' },
      ],
    })
    expect(result.isError).toBe(false)
    const [first, second] = provider.starts
    expect(first?.label).toBe('alpha')
    expect(first?.prompt).toBe('do a')
    expect(first?.agentOptions).toMatchObject({ model: 'pinned-model' })
    expect(first?.reasoningEffort).toBe('high')
    expect(first?.maxDepth).toBe(5)
    expect(second?.agentOptions).toMatchObject({ model: 'fallback-model' })
    expect(second?.reasoningEffort).toBe('low')
  })

  it('sends the branded effort value through to the seam request', async () => {
    const { ctx, provider } = await setup({ provider: 'mock', reasoningEffort: ReasoningEffortId('medium') })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [{ id: 'a', title: 'alpha', prompt: 'do a' }],
    })
    expect(result.isError).toBe(false)
    expect(provider.starts[0]?.reasoningEffort).toBe('medium')
  })

  it('rejects a cyclic graph before starting any child', async () => {
    const { ctx, provider } = await setup({ provider: 'mock' })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [
        { id: 'a', title: 'a', prompt: 'p', depends_on: ['b'] },
        { id: 'b', title: 'b', prompt: 'p', depends_on: ['a'] },
      ],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('dependency cycle')
    expect(provider.starts).toHaveLength(0)
  })

  it('rejects an unknown explicit provider, naming the registered set', async () => {
    const { ctx, provider } = await setup({ provider: 'mock' })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [{ id: 'a', title: 'a', prompt: 'p', provider: 'ghost' }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no subagent provider registered for "ghost"')
    expect(text(result)).toContain('mock')
    expect(provider.starts).toHaveLength(0)
  })

  it('rejects an effort override on a provider without the reasoningEffort capability', async () => {
    const { ctx } = await setup({ provider: 'mock' }, { capabilities: { reasoningEffort: false } })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [{ id: 'a', title: 'a', prompt: 'p', effort: 'high' }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cannot pin a reasoning effort')
  })

  it('rejects an instance-wide default effort on a provider without the capability at load time', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    mock.mountScriptedProvider(ctx, { name: 'mock', capabilities: { reasoningEffort: false } })
    let failure: unknown
    try {
      await ctx.plugin(tool, { provider: 'mock', reasoningEffort: 'high' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
  })

  it('honors allowProviderOverride: false', async () => {
    const { ctx, provider } = await setup({ provider: 'mock', allowProviderOverride: false })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [{ id: 'a', title: 'a', prompt: 'p', provider: 'mock' }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('allowProviderOverride: false')
    expect(provider.starts).toHaveLength(0)
  })

  it('marks a failed branch failed, preserves partial output, and skips its dependents', async () => {
    const { ctx, provider } = await setup({ provider: 'mock' }, {
      perPrompt: {
        p: { reply: 'partial answer', stopReason: 'error', diagnostic: 'child exploded' },
      },
    })
    const result = await orchestrate(ctx, {
      task: 't',
      subtasks: [
        { id: 'root', title: 'root task', prompt: 'p' },
        { id: 'leaf', title: 'leaf task', prompt: 'q', depends_on: ['root'] },
        { id: 'other', title: 'other task', prompt: 'r' },
      ],
    })
    expect(result.isError).toBe(false)
    const value = result.value as {
      counts: Record<string, number>
      results: { id: string; status: string; stopReason?: string; diagnostic?: string; output?: string; skipReason?: string }[]
    }
    expect(value.counts).toMatchObject({ total: 3, completed: 1, failed: 1, skipped: 1 })
    const root = value.results.find(row => row.id === 'root')
    expect(root).toMatchObject({ status: 'failed', stopReason: 'error', diagnostic: 'child exploded', output: 'partial answer: p' })
    const leaf = value.results.find(row => row.id === 'leaf')
    expect(leaf).toMatchObject({ status: 'skipped', skipReason: 'dependency "root" failed' })
    // Only the failed root and the independent other ran; the dependent never started.
    expect(provider.starts.map(start => start.label).sort()).toEqual(['other task', 'root task'])
    expect(text(result)).toContain('FAILED root')
    expect(text(result)).toContain('SKIPPED leaf')
  })

  it('requires a calling agent', async () => {
    const { ctx } = await setup({ provider: 'mock' })
    const result = await orchestrate(ctx, TWO_INDEPENDENT, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('keeps the tool and its guidance section unmounted while the default provider is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    mock.mountScriptedProvider(ctx, { name: 'other' })
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().some(schema => schema.name === 'orchestrate')).toBe(false)
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(candidate => candidate.name === 'tool:orchestrate')
    expect(section?.text).toBe('')
  })

  it('mirrors the default provider lifecycle: disposal unmounts the tool, re-registration remounts it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    const backend = mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().some(schema => schema.name === 'orchestrate')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === 'tool:orchestrate')?.text)
      .toContain('Available providers: mock')

    await backend.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'orchestrate')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === 'tool:orchestrate')?.text)
      .toBe('')

    mock.mountScriptedProvider(ctx, { name: 'mock' })
    expect(ctx.tools.schemas().some(schema => schema.name === 'orchestrate')).toBe(true)
  })
})
