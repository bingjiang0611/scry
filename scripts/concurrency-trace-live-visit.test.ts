import { beforeAll, describe, expect, it } from 'vitest'

interface Sample { label: string; takenAtEpochMs: number; main: { status: string; snapshot?: unknown; reason?: string }; renderer: unknown }
interface VisitRecord {
  visitId: string
  peerIndex: number
  taskIndex: number
  runId: string
  identity: { cwd: string; providerId: string; externalSessionId: string | null }
  status: string
  marks: { client: Record<string, Sample>; host: Record<string, Sample>; node: Record<string, Sample> }
  phases: PhaseRange[]
  hostPhases: PhaseRange[]
  rendererPhases: PhaseRange[]
  driverPhases: PhaseRange[]
  rounds: unknown[]
  roundsRead?: number
  failures: Array<{ phase: string; round?: number; error: string; first?: boolean }>
  oracle: unknown
  counters: unknown
  lastState: unknown
  closedByAbandon: boolean
  summary: unknown
}
interface PhaseRange { name: string; scope?: string | null; delta: { status: string; reason?: string } }
interface VisitModule {
  VISIT_RANGES: Array<{ name: string; from: string; to: string; includes: string }>
  createVisitRecord(input: { visit: { waveIndex: number; peerIndex: number; taskIndex: number }; target: Record<string, unknown>; rendererPid: number | null }): VisitRecord
  measureVisit(input: Record<string, unknown>): Promise<VisitRecord>
}

let visit: VisitModule
beforeAll(async () => {
  visit = await import(new URL('./fixtures/concurrency-trace-live-visit.mjs', import.meta.url).href) as VisitModule
})

const TARGET = {
  visitId: 'w0-p0-t0',
  connectionId: 'conn-1',
  cwd: '/tmp/concurrency-trace-live/task-00',
  providerId: 'codex',
  nativeRunId: 'run-1',
  session: { sessionId: 'session-1', externalSessionId: 'ext-1', providerId: 'codex', cwd: '/tmp/concurrency-trace-live/task-00', label: 'session-1', ts: 1 }
}

const sample = (label: string): Sample => ({
  label,
  takenAtEpochMs: 1_760_000_100_000,
  main: { status: 'measured', snapshot: { monotonicMs: 1, cpu: { user: 10, system: 5 }, metrics: [] } },
  renderer: { status: 'unavailable', reason: 'no CDP session' }
})

function fakes({ roundsThatWork = 7, injectionThrows = true } = {}) {
  const calls: string[] = []
  let round = 0
  const client = {
    sample: async (label: string) => { calls.push(`sample:${label}`); return sample(label) },
    // The real counter reports the reads that were actually attempted, so the fake derives
    // it from the rounds that really ran instead of a hardcoded 7.
    counters: async () => { calls.push('counters'); return { attempts: { traceDelta: round }, tls: { tunnelOpens: 1 } } },
    abandon: async () => { calls.push('abandon'); return { closed: true } },
    driver: async (_peerId: number, method: string, _args: unknown[], options: { injectFailure?: boolean } = {}) => {
      calls.push(`driver:${method}`)
      if (options.injectFailure) {
        if (injectionThrows) throw new Error('concurrency_trace_live_injected_fail_after_round')
        return { round: -1 }
      }
      if (method === 'beginVisit') return { accepted: true }
      if (method === 'ready') return { ready: true }
      if (method === 'round') {
        round += 1
        if (round > roundsThatWork) throw new Error('renderer round failed')
        return { round, readMethods: ['traceDelta'] }
      }
      if (method === 'state') return { calls: { traceDelta: roundsThatWork }, held: 1 }
      if (method === 'endVisit') return { rounds: 7 }
      throw new Error(`unexpected driver method ${method}`)
    }
  }
  const host = { sample: async (label: string) => sample(label) }
  return { client, host, calls }
}

const run = async (options: Parameters<typeof fakes>[0] = {}) => {
  const { client, host, calls } = fakes(options)
  const record = visit.createVisitRecord({ visit: { waveIndex: 0, peerIndex: 0, taskIndex: 0 }, target: TARGET, rendererPid: 9001 })
  await visit.measureVisit({ record, client, host, deadlines: { driverReadyMs: 1000, roundMs: 1000 }, failAfterRound: 3 })
  return { record, calls }
}

describe('live lane visit measurement', () => {
  it('stops at the injected round, keeps the original error and never fakes a normal end', async () => {
    const { record, calls } = await run()
    expect(record.status).toBe('failed')
    expect(record.rounds).toHaveLength(3)
    expect(record.roundsRead).toBe(3)
    expect(record.failures[0]).toMatchObject({ phase: 'injected-fail-after-round', round: 4, first: true })
    expect(record.failures[0].error).toMatch(/injected_fail_after_round/)
    // The seven-round `endVisit` must not run, and the injected error must not be replaced.
    expect(calls).not.toContain('driver:endVisit')
    expect(record.failures.map((failure) => failure.error).join()).not.toMatch(/rounds_incomplete|endVisit/)
    expect(calls).toContain('abandon')
    expect(record.closedByAbandon).toBe(true)
    // Failure evidence is kept: counters, last state and an after sample.
    expect(record.counters).toMatchObject({ attempts: { traceDelta: 3 } })
    expect(record.lastState).toMatchObject({ held: 1 })
    expect(record.marks.client['failure.after']).toBeDefined()
    expect(record.marks.host['failure.after']).toBeDefined()
  })

  it('reports range-by-range phases and marks the observer range unavailable', async () => {
    const { record } = await run()
    const byName = new Map(record.phases.map((phase) => [phase.name, phase.delta]))
    expect(byName.get('mount')?.status).toBe('measured')
    expect(byName.get('rounds')?.status).toBe('measured')
    expect(byName.get('observer')).toMatchObject({ status: 'unavailable', reason: 'missing marks: visit.ended, observer.end' })
    expect(record.phases.find((phase) => phase.name === 'visit')).toBeDefined()
  })

  it('keeps the launcher, client and renderer scopes separate', async () => {
    const { record } = await run()
    const named = (phases: PhaseRange[], name: string) => phases.find((phase) => phase.name === name)
    expect(named(record.driverPhases, 'mount')?.scope).toBe('launcher-node')
    expect(named(record.rendererPhases, 'mount')?.scope).toBe('renderer')
    expect(named(record.phases, 'mount')?.scope).toBe('client-process-tree')
    expect(named(record.hostPhases, 'mount')?.scope).toBe('host-process-tree')
    // The launcher samples itself at the same marks as the host and the client.
    expect(record.marks.node['visit.start']).toBeDefined()
    expect(record.marks.node['visit.mounted']).toBeDefined()
    expect(named(record.driverPhases, 'mount')?.delta.status).toBe('measured')
    expect(named(record.phases, 'mount')?.delta.status).toBe('measured')
  })

  it('flags an injection that did not fail as a void control', async () => {
    const { client, host, calls } = fakes({ injectionThrows: false })
    const record = visit.createVisitRecord({ visit: { waveIndex: 0, peerIndex: 0, taskIndex: 0 }, target: TARGET, rendererPid: 9001 })
    await visit.measureVisit({ record, client, host, deadlines: { driverReadyMs: 1000, roundMs: 1000 }, failAfterRound: 3 })
    expect(record.status).toBe('failed')
    expect(record.failures[0]).toMatchObject({ phase: 'injected-control', round: 4 })
    expect(record.failures[0].error).toMatch(/not raised/)
    expect(calls).not.toContain('driver:endVisit')
  })

  it('records a runtime failure during the rounds with the rounds it really read', async () => {
    const { client, host, calls } = fakes({ roundsThatWork: 2 })
    const record = visit.createVisitRecord({ visit: { waveIndex: 0, peerIndex: 0, taskIndex: 0 }, target: TARGET, rendererPid: 9001 })
    await visit.measureVisit({ record, client, host, deadlines: { driverReadyMs: 1000, roundMs: 1000 }, failAfterRound: null })
    expect(record.status).toBe('failed')
    expect(record.rounds).toHaveLength(2)
    expect(record.failures[0]).toMatchObject({ phase: 'visit', error: 'renderer round failed', first: true })
    expect(calls).toContain('abandon')
    expect(calls).not.toContain('driver:endVisit')
  })

  it('marks only the renderer scope unavailable when the window never reported a pid', async () => {
    const { client, host } = fakes()
    const record = visit.createVisitRecord({ visit: { waveIndex: 0, peerIndex: 0, taskIndex: 0 }, target: TARGET, rendererPid: null })
    await visit.measureVisit({ record, client, host, deadlines: { driverReadyMs: 1000, roundMs: 1000 }, failAfterRound: 3 })
    const rendererMount = record.rendererPhases.find((phase) => phase.name === 'mount')
    expect(rendererMount?.scope).toBe('renderer')
    expect(rendererMount?.delta).toMatchObject({ status: 'unavailable' })
    expect(rendererMount?.delta.reason).toMatch(/renderer pid/)
    // The launcher's own CPU does not depend on a renderer pid, so it stays measured.
    expect(record.driverPhases.find((phase) => phase.name === 'mount')?.delta.status).toBe('measured')
  })
})
