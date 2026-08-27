/** Unit coverage for the pure divide-and-conquer scheduler. */

import { describe, expect, it } from 'vitest'
import { runSubtaskGraph, validateSubtaskGraph } from '../src/scheduler.ts'
import type { OrchestrationSubtask, SubtaskExecution } from '../src/scheduler.ts'

function subtask(id: string, dependsOn?: string[]): OrchestrationSubtask {
  return { id, title: `title ${id}`, prompt: `prompt ${id}`, ...(dependsOn !== undefined ? { dependsOn } : {}) }
}

function completes(output = ''): Promise<SubtaskExecution> {
  return Promise.resolve({ status: 'completed', output })
}

describe('validateSubtaskGraph', () => {
  it('rejects an empty graph', () => {
    expect(() => {
      validateSubtaskGraph([], 8)
    }).toThrow('declare at least one subtask')
  })

  it('rejects submissions above the size bound', () => {
    expect(() => {
      validateSubtaskGraph([subtask('a'), subtask('b')], 1)
    }).toThrow('exceed the limit of 1')
  })

  it('rejects duplicate ids, empty fields, unknown and self dependencies', () => {
    const problems: string[] = []
    try {
      validateSubtaskGraph([
        { id: '', title: 't', prompt: 'p' },
        { id: 'a', title: ' ', prompt: 'p' },
        { id: 'b', title: 't', prompt: ' ' },
        { id: 'c', title: 't', prompt: 'p', dependsOn: ['ghost'] },
        { id: 'd', title: 't', prompt: 'p', dependsOn: ['d'] },
        subtask('e'),
        subtask('e'),
      ], 8)
    } catch (error) {
      problems.push(...(error instanceof Error ? error.message.split('; ') : []))
    }
    const message = problems.join('\n')
    expect(message).toContain('a subtask has an empty id')
    expect(message).toContain('duplicate subtask id "e"')
    expect(message).toContain('empty title')
    expect(message).toContain('has an empty prompt')
    expect(message).toContain('depends on unknown subtask "ghost"')
    expect(message).toContain('depends on itself')
  })

  it('rejects every node stranded by a dependency cycle', () => {
    expect(() => {
      validateSubtaskGraph([
        subtask('a', ['b']),
        subtask('b', ['a']),
        subtask('c'),
      ], 8)
    }).toThrow(/subtask "a" participates in a dependency cycle; subtask "b" participates in a dependency cycle/)
  })

  it('accepts a well-formed diamond', () => {
    expect(() => {
      validateSubtaskGraph([
        subtask('a'),
        subtask('b', ['a']),
        subtask('c', ['a']),
        subtask('d', ['b', 'c']),
      ], 8)
    }).not.toThrow()
  })
})

describe('runSubtaskGraph', () => {
  it('runs independent subtasks concurrently up to the cap', async () => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const outcomes = await runSubtaskGraph(
      [subtask('a'), subtask('b'), subtask('c'), subtask('d')],
      { maxConcurrency: 2, signal: new AbortController().signal },
      async (subtask) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        order.push(subtask.id)
        active -= 1
        return { status: 'completed', output: `done ${subtask.id}` }
      },
    )
    expect(peak).toBe(2)
    expect(order).toHaveLength(4)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('starts a dependent only after its dependency settles', async () => {
    const events: string[] = []
    await runSubtaskGraph(
      [subtask('a'), subtask('b', ['a'])],
      { maxConcurrency: 4, signal: new AbortController().signal },
      async (subtask) => {
        events.push(`start ${subtask.id}`)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        events.push(`end ${subtask.id}`)
        return completes()
      },
    )
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('transitively skips dependents of a failed subtask while independent branches finish', async () => {
    const started: string[] = []
    const outcomes = await runSubtaskGraph(
      [
        subtask('fail'),
        subtask('child', ['fail']),
        subtask('grandchild', ['child']),
        subtask('side', ['fail']),
        subtask('free'),
      ],
      { maxConcurrency: 4, signal: new AbortController().signal },
      (subtask) => {
        started.push(subtask.id)
        return subtask.id === 'fail'
          ? Promise.resolve({ status: 'failed', output: 'partial work', stopReason: 'error', diagnostic: 'boom' })
          : completes()
      },
    )
    expect(started).toEqual(['fail', 'free'])
    const byId = new Map(outcomes.map(outcome => [outcome.id, outcome]))
    expect(byId.get('fail')?.status).toBe('failed')
    expect(byId.get('fail')?.output).toBe('partial work')
    expect(byId.get('child')).toMatchObject({ status: 'skipped', skipReason: 'dependency "fail" failed' })
    expect(byId.get('grandchild')?.status).toBe('skipped')
    expect(byId.get('side')?.status).toBe('skipped')
    expect(byId.get('free')?.status).toBe('completed')
  })

  it('records a runner rejection as that subtask\'s failure without losing siblings', async () => {
    const outcomes = await runSubtaskGraph(
      [subtask('boom'), subtask('ok')],
      { maxConcurrency: 4, signal: new AbortController().signal },
      subtask => subtask.id === 'boom' ? Promise.reject(new Error('infrastructure')) : completes(),
    )
    expect(outcomes[0]).toMatchObject({
      status: 'failed',
      stopReason: 'orchestration infrastructure failure',
      diagnostic: 'Error: infrastructure',
    })
    expect(outcomes[1]?.status).toBe('completed')
  })

  it('skips pending work when cancelled before launch and lets running children settle', async () => {
    const controller = new AbortController()
    const started: string[] = []
    const outcomes = await runSubtaskGraph(
      [subtask('slow'), subtask('queued'), subtask('later', ['queued'])],
      { maxConcurrency: 1, signal: controller.signal },
      async (subtask) => {
        started.push(subtask.id)
        if (subtask.id === 'slow') controller.abort()
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        return completes()
      },
    )
    expect(started).toEqual(['slow'])
    const byId = new Map(outcomes.map(outcome => [outcome.id, outcome]))
    expect(byId.get('slow')?.status).toBe('completed')
    expect(byId.get('queued')).toMatchObject({ status: 'skipped', skipReason: 'orchestration was cancelled' })
    expect(byId.get('later')?.status).toBe('skipped')
  })

  it('reports every outcome in submission order', async () => {
    const outcomes = await runSubtaskGraph(
      [subtask('z'), subtask('a', ['z'])],
      { maxConcurrency: 4, signal: new AbortController().signal },
      () => completes(),
    )
    expect(outcomes.map(outcome => outcome.id)).toEqual(['z', 'a'])
  })
})
