// Report summary for the live lane (R6.3).
//
// The counts are separated by what they prove. `roundsRead` counts round replies that really
// came back, over every visit including failed ones: a fail-after control returned rounds
// before it failed, so counting only completed visits would report that run as zero work.
// Business success is still only credited to completed visits (`completedVisits`,
// `seedsChecked`, `archivedRuns`). Failed attempts stay visible per visit in `attempts` and
// `lastState` and are never converted into success counts here.
import { SEED_COUNT, TASK_COUNT } from './concurrency-trace-live-plan.mjs'

export const ROUNDS_READ_NOTE =
  'roundsRead counts round replies that returned on every visit, including visits that failed afterwards; failed attempts are read per visit from attempts and lastState'

export function summarize(report, plan) {
  const visits = report.waves.flatMap((wave) => wave.visits)
  const completed = visits.filter((visit) => visit.status === 'completed')
  return {
    lane: plan.lane,
    waves: report.waves.length,
    visits: visits.length,
    completedVisits: completed.length,
    failedVisits: visits.length - completed.length,
    roundsRead: visits.reduce((total, visit) => total + (visit.rounds?.length ?? 0), 0),
    roundsReadNote: ROUNDS_READ_NOTE,
    expectedRounds: plan.peers * TASK_COUNT * plan.rounds,
    // A completed visit keeps one oracle view per round and those views share the seed prefix, so the
    // first view's seedCount is the visit's seed count; adding all seven would report 7x the seeds.
    seedsChecked: completed.reduce((total, visit) => total + visit.oracle.views[0].seedCount, 0),
    expectedSeeds: SEED_COUNT * plan.peers * TASK_COUNT,
    archivedRuns: report.waves.reduce((total, wave) => total + (wave.archive?.runs.filter((run) => run.ok).length ?? 0), 0),
    archiveRoots: report.waves.map((wave) => wave.archive?.roots ?? null),
    cpuNote: 'per-process cumulative CPU deltas over overlapping ranges; ranges are not summed'
  }
}
