import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONCURRENCY_SCENARIOS, parseConcurrency, selectScenario } from './session-concurrency-contract.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// The streamed prompts live in their own fixture module since the paced/long stream
// extraction; both files are the offline fixture the scenarios must select.
const smoke = [
  readFileSync(join(root, 'src/main/providers/smoke.ts'), 'utf8'),
  readFileSync(join(root, 'src/main/providers/smoke-paced-stream.ts'), 'utf8')
].join('\n')

describe('workload contract', () => {
  it('accepts only declared concurrency levels and defaults to 4', () => {
    expect(parseConcurrency(undefined)).toBe(4)
    expect(parseConcurrency('')).toBe(4)
    expect(parseConcurrency('16')).toBe(16)
    expect(() => parseConcurrency('8')).toThrow(/concurrency must be one of 4\/16/)
    expect(() => parseConcurrency('four')).toThrow(/concurrency must be one of 4\/16/)
  })

  it('names scenarios that exist in the offline fixture', () => {
    for (const [name, scenario] of Object.entries(CONCURRENCY_SCENARIOS)) {
      expect(typeof name).toBe('string')
      expect(smoke).toContain(`'${scenario.prompt}'`)
    }
    expect(() => selectScenario('nope')).toThrow(/unknown scenario/)
    expect(selectScenario('big-output').expect.toolResultPayloadBytes).toBe(12 * 1024 * 1024)
    expect(selectScenario('history-switch').switches).toBe(4)
    expect(selectScenario('quiet').quietMs).toBeGreaterThan(0)
  })
})
