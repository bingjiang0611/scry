import { beforeAll, describe, expect, it } from 'vitest'

interface VisitLike { status: string; rounds: unknown[]; oracle?: { seedCount: number } | null }
interface WaveLike { visits: VisitLike[]; archive?: { runs: Array<{ ok: boolean }>; roots: string[] } | null }
interface Summary {
  waves: number
  visits: number
  completedVisits: number
  failedVisits: number
  roundsRead: number
  roundsReadNote: string
  expectedRounds: number
  seedsChecked: number
  expectedSeeds: number
  archivedRuns: number
  archiveRoots: Array<string[] | null>
}
interface SummaryModule {
  ROUNDS_READ_NOTE: string
  summarize(report: { waves: WaveLike[] }, plan: { lane: string; peers: number; rounds: number }): Summary
}

let summary: SummaryModule
beforeAll(async () => {
  summary = await import(new URL('./fixtures/concurrency-trace-live-summary.mjs', import.meta.url).href) as SummaryModule
})

const PLAN = { lane: 'concurrency-trace-live', peers: 1, rounds: 7 }
const rounds = (count: number): unknown[] => Array.from({ length: count }, (_unused, index) => ({ round: index + 1 }))
const completed = (): VisitLike => ({ status: 'completed', rounds: rounds(7), oracle: { seedCount: 1005 } })
const failed = (roundsRead: number): VisitLike => ({ status: 'failed', rounds: rounds(roundsRead), oracle: null })
const wave = (visits: VisitLike[]): WaveLike => ({
  visits,
  archive: { runs: [{ ok: true }, { ok: false }], roots: ['trace-archive-turns-v1', 'trace-archives-v2'] }
})

describe('live lane report summary', () => {
  it('counts the rounds a failed visit really returned instead of reporting zero work', () => {
    // The fail-after-rounds control returns real round replies before it fails; counting only
    // completed visits would show roundsRead 0 while three rounds had come back.
    const result = summary.summarize({ waves: [wave([completed(), failed(3)])] }, PLAN)
    expect(result.roundsRead).toBe(10)
    expect(result.visits).toBe(2)
    expect(result.completedVisits).toBe(1)
    expect(result.failedVisits).toBe(1)
    // Business success is still only credited to the completed visit.
    expect(result.seedsChecked).toBe(1005)
    expect(result.archivedRuns).toBe(1)
    expect(result.archiveRoots).toEqual([['trace-archive-turns-v1', 'trace-archives-v2']])
    // The number is labelled for what it is, and points at the per-visit failure evidence.
    expect(result.roundsReadNote).toBe(summary.ROUNDS_READ_NOTE)
    expect(result.roundsReadNote).toMatch(/round replies that returned on every visit/)
    expect(result.roundsReadNote).toMatch(/attempts and lastState/)
    // The expected count still describes the fixed lane, so a partial run stays visibly short.
    expect(result.expectedRounds).toBe(16 * 7)
    expect(result.expectedSeeds).toBe(1000 * 16)
  })

  it('counts every round of the completed visits', () => {
    // expectedRounds describes the whole fixed lane (16 tasks), so a shorter fixture stays
    // visibly below it instead of being scaled to the fixture.
    const result = summary.summarize({ waves: [wave([completed(), completed()])] }, PLAN)
    expect(result.roundsRead).toBe(14)
    expect(result.completedVisits).toBe(2)
    expect(result.seedsChecked).toBe(2010)
  })

  it('keeps a missing archive root as null instead of guessing one', () => {
    const result = summary.summarize({ waves: [{ visits: [completed()], archive: null }] }, PLAN)
    expect(result.archiveRoots).toEqual([null])
    expect(result.archivedRuns).toBe(0)
  })
})
