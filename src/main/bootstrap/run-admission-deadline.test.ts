import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Only starting a run carries the admission deadline (G1/H1). The bound lives in
// admitRun, whose behaviour context-admission.test.ts covers; this pins that the run
// start goes through it, because startRun is not drivable without a Provider here.
describe('run start admission', () => {
  it('admits a run start through the bounded admitRun, not an unbounded runMany', () => {
    const source = readFileSync(new URL('./run-execution.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/admitRun\(contextAdmission, admissionKeys,/)
    expect(source).not.toMatch(/contextAdmission\.runMany\(/)
  })
})
