// Question evidence contract of the live lane (R6.3), shared by the serialized host driver
// and the launcher's own waits.
//
// Production broadcasts `agent:questionAttention` for every run but sends the
// `agent:userQuestion` detail only to the focused run, so readiness and the held set are
// derived from the attention projection plus the session, never from the detail payload.

/**
 * The fixed question the offline `concurrency trace live` branch asks
 * (src/main/providers/smoke.ts). The id is derived from the run, so answering never depends
 * on receiving a detail payload: production broadcasts `agent:questionAttention` for every
 * run but sends the `agent:userQuestion` detail only to the focused run.
 */
export const TRACE_QUESTION = Object.freeze({
  idSuffix: ':concurrency-trace',
  header: 'Concurrency trace',
  text: 'Continue the concurrency trace fixture?',
  answer: 'continue',
  multiSelect: false
})

/**
 * Question id and answer this lane uses, taken from its own policy rather than a payload.
 * `policy` is explicit because this function is also serialized into the host renderer,
 * where module scope does not exist.
 */
export function questionPolicy(runId, policy) {
  return { questionId: `${runId}${policy.idSuffix}`, question: policy.text, answer: policy.answer }
}

const QUESTION_PENDING = 1

/**
 * Held gate for this single-question lane, evaluated before a wave is measured.
 *
 * It is a pure function of the latest event evidence, not a general post-completion state
 * machine: it keeps no history of earlier counts, and the terminal wait after answering is a
 * separate step (`waitTerminals`). A run is ready when its latest attention count is exactly
 * one pending question, its session is recorded and not pending, and it has neither a terminal
 * nor an error. A detail payload is not required and is not counted as evidence: only the
 * focused run receives one.
 */
export function assessEvidence({ runs, runIds, expectedPending = QUESTION_PENDING }) {
  const issues = []
  for (const run of runs) {
    if (run.error) { issues.push({ runId: run.runId, phase: 'error', error: run.error }); continue }
    const pendingCount = run.attention?.pendingCount
    // Exactly the expected count: this lane asks one question per run, so a different count is
    // not evidence that this lane's question is pending.
    const atExpectedPending = Number.isInteger(pendingCount) && pendingCount === expectedPending
    if (run.terminal && !atExpectedPending) {
      const observed = Number.isInteger(pendingCount) ? `pendingCount ${pendingCount}` : 'no pending attention recorded'
      issues.push({ runId: run.runId, phase: 'terminal-before-question', error: `the run reached a terminal with ${observed}, expected exactly ${expectedPending}` })
    } else if (run.terminal && run.terminal.stopped !== false) {
      issues.push({ runId: run.runId, phase: 'stopped', error: 'the run was stopped instead of completing' })
    }
  }
  const heldFor = (run) => Number.isInteger(run.attention?.pendingCount) && run.attention.pendingCount === expectedPending &&
    run.session?.pending === false && typeof run.session?.externalSessionId === 'string' && run.session.externalSessionId.length > 0 &&
    !run.terminal && !run.error
  const ready = runIds.every((runId) => {
    const run = runs.find((candidate) => candidate.runId === runId)
    return !!run && heldFor(run)
  })
  return {
    issues,
    ready,
    held: runs.filter(heldFor).map((run) => run.runId),
    pending: runs.map((run) => ({
      runId: run.runId,
      pendingCount: Number.isInteger(run.attention?.pendingCount) ? run.attention.pendingCount : null,
      attentionUpdates: run.attention?.updates ?? 0,
      detail: run.questionDetail ?? 'focused-only'
    }))
  }
}
