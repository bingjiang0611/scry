// Pure judgements the scenarios make from what they observed. Kept apart from the
// drivers so each rule has a unit test that fails when the rule is broken.

/**
 * Reopen: what the second App shows for a run that was live across the App restart,
 * compared with what the first App had already shown for the same run (same projection,
 * so a dropped event type cannot read as a gap).
 *
 *   complete      every item the first App saw is present, each exactly once
 *   gap-flagged   something is missing, and the stream health says so
 *   gap-silent    something is missing and nothing says so (fail)
 *   duplicated    an item appears twice (fail: the cursor replayed)
 *   empty         the second App shows nothing for the run (fail)
 */
export function continuityVerdict({ before, after, health }) {
  const afterIds = (after ?? []).map((item) => item?.id).filter((id) => typeof id === 'string')
  const counts = new Map()
  for (const id of afterIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id)
  const beforeIds = [...new Set((before ?? []).map((item) => item?.id).filter((id) => typeof id === 'string'))]
  const missing = beforeIds.filter((id) => !counts.has(id))
  const flagged = Boolean(health && (health.degraded === true || health.resyncRequired === true || (health.skippedEvents ?? 0) > 0))
  const verdict = afterIds.length === 0 ? 'empty'
    : duplicates.length > 0 ? 'duplicated'
      : missing.length === 0 ? 'complete'
        : flagged ? 'gap-flagged' : 'gap-silent'
  return {
    verdict,
    pass: verdict === 'complete' || verdict === 'gap-flagged',
    beforeCount: beforeIds.length,
    afterCount: afterIds.length,
    missingCount: missing.length,
    missingSample: missing.slice(0, 5),
    duplicates: duplicates.slice(0, 5),
    flagged
  }
}

/**
 * Same profile, second start while the first is live. Classes:
 *   refused    the start call failed, or the second run ended in an error without output
 *   queued     the second run made no progress while the first was live, and finished after it
 *   parallel   the second run finished while the first was still live
 *   unknown    none of the above could be established
 */
export function classifySecondStart(observed) {
  // A start that reports an error while the daemon recorded its intent was not refused:
  // it may run later (daemon_run_not_bound). That is a finding, not an exclusion.
  if (observed.startError && observed.recordedDespiteError) {
    return { outcome: 'unknown', reason: `start reported ${observed.startError} but the daemon recorded the intent` }
  }
  if (observed.startError) return { outcome: 'refused', reason: observed.startError }
  if (observed.whileFirstLive?.done === true) {
    if (observed.whileFirstLive.error && !observed.whileFirstLive.output) return { outcome: 'refused', reason: observed.whileFirstLive.error }
    return { outcome: 'parallel', reason: observed.whileFirstLive.error ?? null }
  }
  if (observed.whileFirstLive && observed.whileFirstLive.output !== true && observed.afterFirstStopped?.done === true) {
    if (observed.afterFirstStopped.error && !observed.afterFirstStopped.output) return { outcome: 'refused', reason: observed.afterFirstStopped.error }
    return { outcome: 'queued', reason: null }
  }
  return { outcome: 'unknown', reason: null }
}

export function exclusionHolds(classified) {
  return classified.outcome === 'refused' || classified.outcome === 'queued'
}

/**
 * Trust gate: what a start against a given repo config did.
 *   settled   the run completed without error
 *   refused   the start or the run failed, and the failure names the expected cause
 *   failed    it failed for some other reason (the gate cannot be credited)
 *   unknown   no terminal state observed
 */
export function classifyTrustStart({ startError, run, expectCause }) {
  const message = startError ?? run?.error ?? null
  if (startError || (run?.done === true && run.error)) {
    const named = expectCause instanceof RegExp ? expectCause.test(String(message)) : false
    return { outcome: named ? 'refused' : 'failed', message, providerOutput: run?.output === true }
  }
  if (run?.done === true) return { outcome: 'settled', message: null, providerOutput: run.output === true }
  return { outcome: 'unknown', message: null, providerOutput: run?.output === true }
}

// The write whose reply was lost with the daemon: the App must say it does not know.
const UNKNOWN_WRITE = /daemon_(outcome_unknown|submit_unknown|stop_not_confirmed)/

export function unconfirmedWriteVerdict(settled) {
  if (!settled || settled.state === 'pending') return { pass: false, verdict: 'still-pending', detail: settled ?? null }
  if (settled.state === 'resolved') return { pass: false, verdict: 'claimed-outcome', detail: settled.value }
  const named = UNKNOWN_WRITE.exec(String(settled.error ?? ''))
  return named ? { pass: true, verdict: named[0], detail: settled.error } : { pass: false, verdict: 'other-error', detail: settled.error }
}
