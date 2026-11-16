import type { RecorderOpenTurnState } from './runtime-state.js'

/**
 * Round eight H2 failed with "Provider turn id differs from the open lifecycle identity" and
 * nothing said which way: no lifecycle carried the turn id, several did, or the lifecycle came
 * from another run. Counts only, no IDs, so the error can be quoted from a public report.
 */
export function lifecycleMismatchError(
  input: { runId?: string; providerTurnId?: string },
  candidates: readonly RecorderOpenTurnState[],
  matched: number
): Error {
  const turnId = input.providerTurnId
  const withTurnId = candidates.filter((candidate) => candidate.providerTurnId).length
  const thisRun = candidates.filter((candidate) => candidate.managedRunId && candidate.managedRunId === input.runId).length
  const continuation = candidates.filter((candidate) => !!turnId && candidate.continuationProviderTurnIds?.includes(turnId)).length
  return new Error('managed recorder Provider turn id differs from the open lifecycle identity ' +
    `(commit turn id ${turnId ? 'present' : 'absent'}; ${candidates.length} lifecycles: ${withTurnId} with a turn id, ` +
    `${thisRun} from this run, ${continuation} listing it as a continuation; ${matched} matched)`)
}
