import { beforeAll, describe, expect, it } from 'vitest'

interface Visit { waveIndex: number; peerIndex: number; taskIndex: number }
interface Wave { waveIndex: number; taskIndices: number[]; visits: Visit[] }
interface PlanModule {
  PROMPT: string
  TASK_COUNT: number
  SEED_COUNT: number
  ROUNDS_PER_VISIT: number
  ALLOWED_LIMITS: number[]
  ALLOWED_PEERS: number[]
  parseBenchArgs(argv: string[], options?: { cwd?: string }): {
    appRoot: string; liveOut: string; work: string; limit: number; peers: number; failAfterRound: number | null
    tasks: number; rounds: number; lane: string; reportPath: string
  }
  planWaves(limit: number): Array<{ waveIndex: number; taskIndices: number[] }>
  planVisits(input: { limit: number; peers: number }): Wave[]
  visitId(visit: Visit): string
  describePlan(plan: unknown): {
    lane: string; tasks: number; seedCount: number; roundsPerVisit: number; limit: number; peers: number
    failAfterRound: number | null; waves: number[][]; visitOrder: Array<{ visits: Array<{ visitId: string }> }>
  }
}

// Plain ESM without declarations: loaded through a computed specifier like the build test.
let plan: PlanModule
beforeAll(async () => { plan = await import(new URL('./fixtures/concurrency-trace-live-plan.mjs', import.meta.url).href) as PlanModule })

const baseArgs = (...extra: string[]): string[] => ['--work', '/tmp/live-work', '--live-out', '/tmp/live-out', ...extra]

describe('concurrency trace live plan', () => {
  it('reads the fixed lane: 16 tasks, 1k seeds, 7 rounds, limit and peers from argv', () => {
    const parsed = plan.parseBenchArgs(baseArgs('--limit', '16', '--peers', '4'), { cwd: '/repo' })
    expect(parsed).toMatchObject({ limit: 16, peers: 4, tasks: plan.TASK_COUNT, rounds: plan.ROUNDS_PER_VISIT, work: '/tmp/live-work', liveOut: '/tmp/live-out', appRoot: '/repo', reportPath: '/tmp/live-work/report.json' })
    expect(parsed.lane).toBe('concurrency-trace-live-seed-1k')
    expect(plan.SEED_COUNT).toBe(1000)
    expect(plan.PROMPT).toBe('concurrency trace live')
    // Defaults are the smallest wave with no reading peers.
    expect(plan.parseBenchArgs(baseArgs())).toMatchObject({ limit: 4, peers: 0, failAfterRound: null })
  })

  it('refuses a different workload wearing this lane name', () => {
    expect(() => plan.parseBenchArgs(baseArgs('--seed', '10000'))).toThrow(/--seed is not supported/)
    expect(() => plan.parseBenchArgs(baseArgs('--tasks', '8'))).toThrow(/--tasks is not supported/)
    expect(() => plan.parseBenchArgs(baseArgs('--rounds', '3'))).toThrow(/--rounds is not supported/)
    expect(() => plan.parseBenchArgs(baseArgs('--limit', '8'))).toThrow(/--limit must be one of/)
    expect(() => plan.parseBenchArgs(baseArgs('--peers', '2'))).toThrow(/--peers must be one of/)
    expect(() => plan.parseBenchArgs(baseArgs('--limit', '4', '--limit', '16'))).toThrow(/given twice/)
    expect(() => plan.parseBenchArgs(baseArgs('--limit'))).toThrow(/needs a value/)
    expect(() => plan.parseBenchArgs(baseArgs('--limit', 'four'))).toThrow(/must be an integer/)
    expect(() => plan.parseBenchArgs(['--work', '/tmp/live-work'])).toThrow(/--live-out/)
    expect(() => plan.parseBenchArgs(['--live-out', '/tmp/live-out'])).toThrow(/--work/)
    expect(() => plan.parseBenchArgs(baseArgs('--verbose'))).toThrow(/unknown flag/)
    expect(plan.ALLOWED_LIMITS).toEqual([4, 16])
    expect(plan.ALLOWED_PEERS).toEqual([0, 1, 4])
  })

  it('bounds the deterministic failure injection to a round in the middle of the visit', () => {
    expect(plan.parseBenchArgs(baseArgs('--peers', '1', '--fail-after-round', '3')).failAfterRound).toBe(3)
    expect(() => plan.parseBenchArgs(baseArgs('--peers', '1', '--fail-after-round', '0'))).toThrow(/must be 1..6/)
    expect(() => plan.parseBenchArgs(baseArgs('--peers', '1', '--fail-after-round', String(plan.ROUNDS_PER_VISIT)))).toThrow(/must be 1..6/)
    // The negative control needs a reading peer: with none it would prove nothing, so the
    // launcher refuses the combination instead of reporting a completed run.
    expect(() => plan.parseBenchArgs(baseArgs('--fail-after-round', '3'))).toThrow(/needs --peers 1 or 4/)
  })

  it('covers all 16 tasks exactly once, whatever the wave limit', () => {
    expect(plan.planWaves(4).map((wave) => wave.taskIndices)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]])
    expect(plan.planWaves(16).map((wave) => wave.taskIndices)).toEqual([Array.from({ length: 16 }, (_, index) => index)])
    const covered = plan.planWaves(4).flatMap((wave) => wave.taskIndices).sort((a, b) => a - b)
    expect(covered).toEqual(Array.from({ length: plan.TASK_COUNT }, (_, index) => index))
  })

  it('orders visits peer-major and run-minor, and keeps rounds inside one visit', () => {
    const waves = plan.planVisits({ limit: 4, peers: 4 })
    expect(waves).toHaveLength(4)
    expect(waves[0].visits.map((visit) => `${visit.peerIndex}:${visit.taskIndex}`)).toEqual([
      '0:0', '0:1', '0:2', '0:3',
      '1:0', '1:1', '1:2', '1:3',
      '2:0', '2:1', '2:2', '2:3',
      '3:0', '3:1', '3:2', '3:3'
    ])
    // A wave never mixes runs from another wave.
    for (const wave of waves) {
      expect(wave.visits.every((visit) => wave.taskIndices.includes(visit.taskIndex))).toBe(true)
      expect(wave.visits.every((visit) => visit.waveIndex === wave.waveIndex)).toBe(true)
    }
    expect(waves[0].visits[0]).toEqual({ waveIndex: 0, peerIndex: 0, taskIndex: 0 })
    expect(plan.visitId(waves[0].visits[5])).toBe('w0-p1-t1')
  })

  it('still plans every wave with zero peers, just no visits', () => {
    const waves = plan.planVisits({ limit: 16, peers: 0 })
    expect(waves).toHaveLength(1)
    expect(waves[0].taskIndices).toHaveLength(16)
    expect(waves[0].visits).toEqual([])
    expect(plan.planVisits({ limit: 4, peers: 1 })[0].visits).toHaveLength(4)
  })

  it('describes the plan it will run, so a reviewer can reproduce the order', () => {
    const parsed = plan.parseBenchArgs(baseArgs('--limit', '4', '--peers', '1'))
    const description = plan.describePlan(parsed)
    expect(description).toMatchObject({ lane: 'concurrency-trace-live-seed-1k', tasks: 16, seedCount: 1000, roundsPerVisit: 7, limit: 4, peers: 1, failAfterRound: null })
    expect(description.waves).toHaveLength(4)
    expect(description.visitOrder[0].visits.map((visit) => visit.visitId)).toEqual(['w0-p0-t0', 'w0-p0-t1', 'w0-p0-t2', 'w0-p0-t3'])
  })
})
