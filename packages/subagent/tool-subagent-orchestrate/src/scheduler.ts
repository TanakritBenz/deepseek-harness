/**
 * Divide-and-conquer scheduling for the orchestrate tool: validation of the
 * model-authored subtask graph, then bounded-parallel execution where every
 * subtask starts as soon as its dependencies complete — no level barriers.
 * The runner is injected, so the DAG logic is unit-testable without Cordis.
 *
 * @module @deepseek-ai/dsh-tool-subagent-orchestrate/scheduler
 */

/** One model-authored piece of the divided task. */
export interface OrchestrationSubtask {
  /** Stable key other subtasks reference in `dependsOn`. */
  readonly id: string
  /** Short display label persisted as the child's delegation label. */
  readonly title: string
  /** Complete standalone instructions for the child; it sees nothing else. */
  readonly prompt: string
  /** Optional `ctx.subagents` provider override for this subtask alone. */
  readonly provider?: string
  /** Optional model-id override interpreted by the selected provider. */
  readonly model?: string
  /** Optional reasoning-effort override for this subtask alone. */
  readonly effort?: string
  /** Subtask ids that must complete before this one starts. */
  readonly dependsOn?: readonly string[]
}

/** Terminal state of one scheduled subtask. */
export type SubtaskStatus = 'completed' | 'failed' | 'skipped'

/** What the injected runner reports for one executed subtask. */
export interface SubtaskExecution {
  /** Whether the child finished its turn normally. */
  readonly status: 'completed' | 'failed'
  /** The child's final assistant text, or its preserved partial text. */
  readonly output: string
  /** Stop-reason headline carried by a `failed` execution. */
  readonly stopReason?: string
  /** Provider-authored failure detail carried by a `failed` execution. */
  readonly diagnostic?: string
}

/** One settled row of the schedule result, in input order. */
export interface SubtaskOutcome {
  readonly id: string
  readonly title: string
  readonly status: SubtaskStatus
  /** The child's final assistant text, or its preserved partial text; empty when never run. */
  readonly output: string
  /** Stop-reason headline carried by a `failed` outcome. */
  readonly stopReason?: string
  /** Provider-authored failure detail carried by a `failed` outcome. */
  readonly diagnostic?: string
  /** Why a `skipped` subtask never ran. */
  readonly skipReason?: string
}

/** Runner contract: execute one subtask to settlement, never rejecting. */
export type SubtaskRunner = (subtask: OrchestrationSubtask) => Promise<SubtaskExecution>

/** Options for {@link runSubtaskGraph}. */
export interface RunSubtaskGraphOptions {
  /** Maximum concurrently executing subtasks; every ready subtask above the cap waits. */
  readonly maxConcurrency: number
  /** Cancellation: pending subtasks are skipped; running ones settle on their own. */
  readonly signal: AbortSignal
}

/**
 * Validate the model-authored graph before any child starts: duplicate or
 * empty identities, unknown/self dependencies, size bound, and cycles are all
 * rejected loud with the offending ids, because a malformed graph must not
 * spend a single delegation.
 * @param subtasks - the submitted subtask list, in call order.
 * @param maxSubtasks - inclusive upper bound on the list length.
 * @throws when any rule is violated; the message names every violation found.
 */
export function validateSubtaskGraph(subtasks: readonly OrchestrationSubtask[], maxSubtasks: number): void {
  const problems: string[] = []
  if (subtasks.length === 0) problems.push('declare at least one subtask')
  if (subtasks.length > maxSubtasks) {
    problems.push(`${subtasks.length} subtasks exceed the limit of ${maxSubtasks}`)
  }
  const seen = new Set<string>()
  for (const subtask of subtasks) {
    if (subtask.id.length === 0) problems.push('a subtask has an empty id')
    else if (seen.has(subtask.id)) problems.push(`duplicate subtask id "${subtask.id}"`)
    else seen.add(subtask.id)
    if (subtask.title.trim().length === 0) problems.push(`subtask "${subtask.id}" has an empty title`)
    if (subtask.prompt.trim().length === 0) problems.push(`subtask "${subtask.id}" has an empty prompt`)
  }
  const ids = seen
  for (const subtask of subtasks) {
    for (const dependency of subtask.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        problems.push(`subtask "${subtask.id}" depends on unknown subtask "${dependency}"`)
      } else if (dependency === subtask.id) {
        problems.push(`subtask "${subtask.id}" depends on itself`)
      }
    }
  }
  problems.push(...cycleProblems(subtasks, ids))
  if (problems.length > 0) throw new Error(`invalid subtask graph: ${problems.join('; ')}`)
}

/** Report each node stranded by a dependency cycle, deterministically in input order. */
function cycleProblems(subtasks: readonly OrchestrationSubtask[], knownIds: ReadonlySet<string>): string[] {
  const unmet = new Map<string, number>(subtasks.map(subtask => [
    subtask.id,
    // Only resolvable edges count here: an unknown dependency is its own
    // violation and must not read as a cycle.
    new Set((subtask.dependsOn ?? []).filter(id => knownIds.has(id))).size,
  ]))
  const dependents = new Map<string, string[]>()
  for (const subtask of subtasks) {
    for (const dependency of new Set(subtask.dependsOn ?? [])) {
      if (!knownIds.has(dependency)) continue
      dependents.set(dependency, [...dependents.get(dependency) ?? [], subtask.id])
    }
  }
  const settled = new Set<string>()
  const queue = subtasks.filter(subtask => unmet.get(subtask.id) === 0).map(subtask => subtask.id)
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (settled.has(id)) continue
    settled.add(id)
    for (const dependent of dependents.get(id) ?? []) {
      unmet.set(dependent, (unmet.get(dependent) as number) - 1)
      if (unmet.get(dependent) === 0) queue.push(dependent)
    }
  }
  return subtasks
    .filter(subtask => !settled.has(subtask.id))
    .map(subtask => `subtask "${subtask.id}" participates in a dependency cycle`)
}

/**
 * Execute the validated graph: launch every subtask whose dependencies have
 * completed, up to `maxConcurrency` at once; a failed subtask transitively
 * skips its dependents; cancellation skips pending work while running
 * children settle. Resolves only after every subtask reached a terminal
 * status, in input order.
 * @param subtasks - the already-validated subtask list.
 * @param options - concurrency cap and cancellation signal.
 * @param run - the injected per-subtask execution; rejections become failures.
 * @returns one outcome per subtask, in input order.
 */
export async function runSubtaskGraph(
  subtasks: readonly OrchestrationSubtask[],
  options: RunSubtaskGraphOptions,
  run: SubtaskRunner,
): Promise<SubtaskOutcome[]> {
  const unmet = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const subtask of subtasks) {
    const dependencies = new Set(subtask.dependsOn ?? [])
    unmet.set(subtask.id, dependencies.size)
    for (const dependency of dependencies) {
      dependents.set(dependency, [...dependents.get(dependency) ?? [], subtask.id])
    }
  }

  const state = new Map<string, 'pending' | 'running' | 'settled'>()
  const outcomes = new Map<string, SubtaskOutcome>()
  for (const subtask of subtasks) state.set(subtask.id, 'pending')

  /** Record one pending subtask as skipped and cascade to its dependents. */
  const markSkipped = (id: string, skipReason: string): void => {
    state.set(id, 'settled')
    outcomes.set(id, {
      id,
      title: subtasks.find(subtask => subtask.id === id)?.title ?? id,
      status: 'skipped',
      output: '',
      skipReason,
    })
    skipDescendants(id, `dependency "${id}" was skipped`)
  }

  /** Transitively skip everything downstream of a subtask that will not complete. */
  function skipDescendants(rootId: string, skipReason: string): void {
    const queue = [rootId]
    while (queue.length > 0) {
      for (const dependent of dependents.get(queue.shift() as string) ?? []) {
        if (state.get(dependent) !== 'pending') continue
        markSkipped(dependent, skipReason)
        queue.push(dependent)
      }
    }
  }

  const launch = (subtask: OrchestrationSubtask): void => {
    state.set(subtask.id, 'running')
    running += 1
    void run(subtask)
      .catch((error: unknown) => ({
        status: 'failed',
        output: '',
        stopReason: 'orchestration infrastructure failure',
        diagnostic: String(error),
      }) satisfies SubtaskExecution)
      .then((execution) => {
        state.set(subtask.id, 'settled')
        outcomes.set(subtask.id, {
          id: subtask.id,
          title: subtask.title,
          status: execution.status,
          output: execution.output,
          ...execution.stopReason !== undefined ? { stopReason: execution.stopReason } : {},
          ...execution.diagnostic !== undefined ? { diagnostic: execution.diagnostic } : {},
        })
        if (execution.status === 'completed') {
          // Completion may satisfy dependents; a non-completed settlement
          // cascades skips instead, so every dependent reaches a terminal
          // state no matter which order the branches settle in.
          for (const dependent of dependents.get(subtask.id) ?? []) {
            unmet.set(dependent, (unmet.get(dependent) as number) - 1)
          }
        } else {
          skipDescendants(subtask.id, `dependency "${subtask.id}" ${execution.status}`)
        }
        // Settlement frees a slot and changes readiness: wake the scheduler.
        running -= 1
        wake()
      })
  }

  const runnable = (): OrchestrationSubtask[] =>
    subtasks.filter(subtask =>
      state.get(subtask.id) === 'pending' && (unmet.get(subtask.id) as number) === 0)

  let running = 0
  let wake: () => void = () => {}
  while (subtasks.some(subtask => state.get(subtask.id) !== 'settled')) {
    if (options.signal.aborted) {
      for (const subtask of runnable()) markSkipped(subtask.id, 'orchestration was cancelled')
    }
    for (const subtask of runnable()) {
      if (running >= options.maxConcurrency) break
      launch(subtask)
    }
    if (running === 0) continue
    // Park until the next completion wakes the scheduler. Completions cannot
    // fire between the launch loop and this assignment (single-threaded turn),
    // so every post-launch settlement is observed by exactly one park.
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
  return subtasks.map(subtask => outcomes.get(subtask.id) as SubtaskOutcome)
}
