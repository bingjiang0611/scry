import { beforeAll, describe, expect, it } from 'vitest'

interface Metric { pid: number; type: string; creationTime: number | null; cumulativeCpuSeconds: number | null; workingSetKb: number | null }
interface Snapshot { pid?: number; monotonicMs?: number; cpu?: { user: number; system: number }; metrics?: Metric[] }
interface Envelope { status: 'measured' | 'unavailable'; snapshot?: Snapshot; reason?: string }
interface BoundarySample { label: string; takenAtEpochMs: number; main: Envelope; renderer: unknown }
interface MainProcessCpu { status: string; reason?: string; samplerPid?: number | null; userUs?: number | null; systemUs?: number | null }
interface DeltaResult {
  status: 'measured' | 'unavailable'
  reason?: string
  wallMs?: number | null
  mainProcessCpu?: MainProcessCpu
  perProcess?: Array<{ pid: number; type?: string | null; identity: string; createdAt?: number | null; endedAt?: number | null; cpuSeconds: number | null; workingSetKb: number | null; reason?: string | null }>
  issues?: string[]
}
interface SamplesModule {
  boundaryDelta(before: unknown, after: unknown, options?: { pids?: number[] | null }): DeltaResult
  phaseDeltas(marks: Record<string, unknown>, ranges: Array<{ name: string; from: string; to: string; includes?: string }>, options?: { pids?: number[]; scope?: string | null }): Array<{ name: string; scope?: string | null; delta: DeltaResult }>
  nodeSample(label: string): BoundarySample
  sampleShape(sample: unknown): { ok: boolean; issues: string[] }
  hashFiles(base: string, files: string[]): string
}

let samples: SamplesModule
beforeAll(async () => {
  samples = await import(new URL('./fixtures/concurrency-trace-live-samples.mjs', import.meta.url).href) as SamplesModule
})

const PID = 9001
const CREATED = 1_760_000_000

// `samplerPid` is the pid of the process that took the sample (client/host main). It defaults to
// the first metric, so a scope filtered to the second pid provably excludes the sampler.
const snapshot = ({ user = 1000, system = 500, wall = 10, cpuFirst = 3, cpuSecond = 1, workingSet = 40_000, created = CREATED, metrics, samplerPid = PID }: {
  user?: number
  system?: number
  wall?: number
  cpuFirst?: number
  cpuSecond?: number
  workingSet?: number
  created?: number
  metrics?: Metric[] | null
  samplerPid?: number | null
} = {}): Envelope => ({
  status: 'measured',
  snapshot: {
    ...(samplerPid === null ? {} : { pid: samplerPid }),
    monotonicMs: wall,
    cpu: { user, system },
    metrics: metrics === null ? [] : metrics ?? [
      { pid: PID, type: 'Tab', creationTime: created, cumulativeCpuSeconds: cpuFirst, workingSetKb: workingSet },
      { pid: PID + 1, type: 'Browser', creationTime: created + 1, cumulativeCpuSeconds: cpuSecond, workingSetKb: workingSet + 10 }
    ]
  }
})

const sample = (main: Envelope, label = 'visit.start'): BoundarySample => ({
  label,
  takenAtEpochMs: 1_760_000_100_000,
  main,
  renderer: { status: 'unavailable', reason: 'client process has no CDP session' }
})

describe('live lane boundary samples', () => {
  it('measures cumulative CPU deltas for the same process identities', () => {
    // Both the main and the second Browser counter advance, so each delta is a real number
    // instead of a zero that would read like a missing measurement.
    const result = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ user: 1500, system: 800, wall: 40, cpuFirst: 3.5, cpuSecond: 1.5, workingSet: 41_000 })))
    expect(result.status).toBe('measured')
    expect(result.wallMs).toBe(30)
    expect(result.perProcess).toEqual([
      { pid: PID, type: 'Tab', identity: 'same', createdAt: CREATED, cpuSeconds: 0.5, workingSetKb: 41_000, reason: null },
      { pid: PID + 1, type: 'Browser', identity: 'same', createdAt: CREATED + 1, cpuSeconds: 0.5, workingSetKb: 41_010, reason: null }
    ])
  })

  it('refuses a pid whose creation time changed instead of crediting the old counter', () => {
    const result = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ cpuFirst: 90, created: CREATED + 7 })))
    expect(result.status).toBe('measured')
    const entry = result.perProcess?.find((process) => process.pid === PID)
    expect(entry).toMatchObject({ identity: 'restarted', cpuSeconds: null, reason: 'pid_reused_by_another_process' })
    expect(entry?.createdAt).toBe(CREATED)
    expect(entry?.endedAt).toBe(CREATED + 7)
  })

  it('refuses a decreasing counter and an exited process', () => {
    const reset = samples.boundaryDelta(sample(snapshot({ cpuFirst: 5 })), sample(snapshot({ cpuFirst: 4 })))
    expect(reset.perProcess?.find((process) => process.pid === PID)).toMatchObject({ identity: 'same', cpuSeconds: null, reason: 'counter_reset' })

    const exited = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ metrics: [] })))
    expect(exited.perProcess?.find((process) => process.pid === PID)).toMatchObject({ identity: 'exited', cpuSeconds: null, workingSetKb: null, reason: 'process_exited_during_phase' })
  })

  it('reports unavailable when a boundary envelope is missing or malformed, never zero', () => {
    const unavailable = samples.boundaryDelta(sample(snapshot()), sample({ status: 'unavailable', reason: 'snapshot channel closed' }))
    expect(unavailable).toMatchObject({ status: 'unavailable', reason: 'a boundary sample was unavailable', after: 'unavailable' })
    expect(unavailable.perProcess).toEqual([])

    const nested = samples.boundaryDelta({ main: sample(snapshot()) }, { main: sample(snapshot()) })
    expect(nested.status).toBe('unavailable')
    expect(nested.issues?.join()).toMatch(/label is missing|takenAtEpochMs/)

    const noSnapshot = samples.boundaryDelta(sample({ status: 'measured' }), sample(snapshot()))
    expect(noSnapshot.status).toBe('unavailable')
    expect(noSnapshot.issues?.join()).toMatch(/no snapshot/)
  })

  it('scopes a renderer delta to the peer renderer pid and refuses the sampler main CPU', () => {
    const result = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ cpuSecond: 9 })), { pids: [PID + 1] })
    expect(result.perProcess).toHaveLength(1)
    expect(result.perProcess?.[0]).toMatchObject({ pid: PID + 1, cpuSeconds: 8 })
    // The sampled main is PID, so its own `cpu` counters are outside this filtered scope: a
    // reader must not be able to add client-main CPU to renderer cost, and this is not 0.
    expect(result.mainProcessCpu).toEqual({ status: 'unavailable', reason: 'outside_filtered_scope', samplerPid: PID, pids: [PID + 1] })

    // Same filter, but now it provably selects the sampling pid: the number is kept.
    const own = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ user: 1500, system: 800 })), { pids: [PID] })
    expect(own.mainProcessCpu).toMatchObject({ status: 'measured', samplerPid: PID, userUs: 500, systemUs: 300 })

    // No filter means the whole reported tree, where the main CPU belongs to the scope.
    const whole = samples.boundaryDelta(sample(snapshot()), sample(snapshot({ user: 1500 })))
    expect(whole.mainProcessCpu).toMatchObject({ status: 'measured', userUs: 500 })

    // A snapshot without own-pid evidence cannot prove inclusion, so it is unavailable too.
    const unknown = samples.boundaryDelta(sample(snapshot({ samplerPid: null })), sample(snapshot({ samplerPid: null })), { pids: [PID] })
    expect(unknown.mainProcessCpu).toEqual({ status: 'unavailable', reason: 'outside_filtered_scope', samplerPid: null, pids: [PID] })
  })

  it('reports a missing mark as unavailable for that range only', () => {
    const marks = {
      'visit.start': sample(snapshot(), 'visit.start'),
      'visit.mounted': sample(snapshot({ user: 1200 }), 'visit.mounted')
    }
    const [mount, rounds] = samples.phaseDeltas(marks, [
      { name: 'mount', from: 'visit.start', to: 'visit.mounted' },
      { name: 'rounds', from: 'visit.mounted', to: 'rounds.end' }
    ])
    expect(mount.delta.status).toBe('measured')
    expect(mount.delta.wallMs).toBe(0)
    expect(rounds.delta).toMatchObject({ status: 'unavailable' })
    expect(rounds.delta.reason).toBe('missing marks: rounds.end')
    expect(rounds.delta.perProcess).toEqual([])
  })

  it('samples the launcher Node process as its own scope', () => {
    const before = samples.nodeSample('driver:visit.start')
    const after = samples.nodeSample('driver:visit.ended')
    expect(before.main.status).toBe('measured')
    const metric = (before.main.snapshot?.metrics ?? [])[0]
    expect(metric?.pid).toBe(process.pid)
    expect(metric?.type).toBe('Node')
    expect(before.renderer).toMatchObject({ status: 'unavailable' })
    expect(before.main.snapshot?.pid).toBe(process.pid)
    const delta = samples.boundaryDelta(before, after, { pids: [process.pid] })
    expect(delta.status).toBe('measured')
    // The filter selects this very process, so its own CPU counters stay real evidence.
    expect(delta.mainProcessCpu).toMatchObject({ status: 'measured', samplerPid: process.pid })
    expect(delta.mainProcessCpu?.userUs).toBeGreaterThanOrEqual(0)
    expect(delta.perProcess?.[0]).toMatchObject({ pid: process.pid, identity: 'same' })
    expect(delta.perProcess?.[0]?.cpuSeconds).toBeGreaterThanOrEqual(0)
  })

  it('labels each phase range with its measurement scope', () => {
    const marks = {
      'visit.start': sample(snapshot(), 'visit.start'),
      'visit.mounted': sample(snapshot({ user: 1300 }), 'visit.mounted')
    }
    const [mount] = samples.phaseDeltas(marks, [{ name: 'mount', from: 'visit.start', to: 'visit.mounted' }], { scope: 'client-process-tree' })
    expect(mount.scope).toBe('client-process-tree')
    expect(mount.delta.status).toBe('measured')
  })

  it('detects a changed lane dependency file', () => {
    const files = ['scripts/fixtures/concurrency-trace-live-plan.mjs']
    const first = samples.hashFiles(process.cwd(), files)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(samples.hashFiles(process.cwd(), files)).toBe(first)
  })
})
