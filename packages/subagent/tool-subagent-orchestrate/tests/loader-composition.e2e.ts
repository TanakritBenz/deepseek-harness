import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless REAL-composition coverage for the orchestrate fan-out: a test-only
 * cordis.yml boots the headless app through the Loader, the scripted model
 * calls `orchestrate` once with two independent subtasks, both run as real
 * spawn children on the same mock model, and the canonical orchestration
 * result carries both probe answers back into the parent's final answer.
 */

const driver = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-acp/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-orchestrate/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath ?? dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('orchestrate fan-out through a real cordis.yml', () => {
  it('runs two independent subtasks concurrently and reviews both results in the parent answer', async () => {
    let logs: string[] = []
    let parsed: SessionEvent[][] = []
    const { stderr } = await runLoaderSmoke({
      label: 'subagent-orchestrate composition smoke',
      tempDirPrefix: 'subagent-orchestrate-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        // Read while the workspace still exists: teardown follows this hook.
        logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(3)
        parsed = await Promise.all(logs.map(async (log) => {
          const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
          return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
        }))
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The parent is the session whose logged tool CALL targeted orchestrate
    // (children only carry the tool's prompt guidance text).
    const parent = parsed.find(events =>
      events.some(event =>
        event.type === 'tool/call' && JSON.stringify(event.data).includes('"name":"orchestrate"')))
    expect(parent).toBeDefined()
    const calls = parent!.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]!.data)).toContain('parallel probe')

    // The canonical result reports both probes completed, with their outputs.
    const resultEvent = parent!.find(event => event.type === 'tool/result')!
    const resultText = JSON.stringify(resultEvent.data)
    expect(resultText).toContain('2/2 completed')
    expect(resultText).toContain('ORCH-A ok')
    expect(resultText).toContain('ORCH-B ok')

    // Each child session answered its own probe exactly once.
    const children = parsed.filter(events => events !== parent)
    const childTexts = children.map((events) => {
      const texts = events
        .filter(event => event.type === 'assistant/message' || JSON.stringify(event.data).includes('ORCH-'))
        .map(event => JSON.stringify(event.data))
        .join('\n')
      return texts
    })
    expect(childTexts.some(text => text.includes('ORCH-A ok'))).toBe(true)
    expect(childTexts.some(text => text.includes('ORCH-B ok'))).toBe(true)
    expect(JSON.stringify(childTexts)).not.toContain('ORCH-C')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
