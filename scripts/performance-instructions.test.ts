import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundleEntry, measureInstructions, runOperation, specs } from './performance-instructions.mjs'

const directory = mkdtempSync(join(tmpdir(), 'scry-instructions-test-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('CPU instruction probe', () => {
  it('bundles production modules and every measured operation returns a real result', async () => {
    const bundle = await bundleEntry(directory)
    // Production code is in the bundle, not a hand-written stand-in.
    expect(readFileSync(bundle, 'utf8')).toContain('function sessionHistoryPage')
    for (const operation of ['none', ...specs.map(spec => spec.scenario)]) {
      const result = runOperation(bundle, operation)
      expect(result.status, `${operation}: ${result.stderr}`).toBe(0)
    }
    expect(runOperation(bundle, 'missing').status).not.toBe(0)
  })

  it.runIf(process.platform !== 'linux')('reports unavailable instead of zero without a Linux counter', async () => {
    const observations = await measureInstructions()
    expect(observations).toHaveLength(specs.length)
    for (const observation of observations) {
      expect(observation).toMatchObject({ availability: 'unavailable', metric: 'cpu.instructions' })
      expect(observation).not.toHaveProperty('runs')
    }
  })
})
