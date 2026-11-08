// What a lane proved about a failed request. Retry policy reads this, never the error
// text: a write that may have reached the host must not be replayed, and guessing the
// phase is how duplicate runs and duplicate answers happen.

// A send failure proves the bytes never left this process only when the channel
// already knew it was closed and refused the frame outright. A write callback
// error is ambiguous: part of the frame may have reached the host, so a write that
// fails there keeps its outcome unknown instead of being re-sent. Channels mark
// the provable case with this helper; everything else counts as possibly written.
const NOT_SENT = 'desktopLaneNotSent'

/** Bytes provably never left this process: the frame was refused before any write. */
export function laneNotSent(error: Error): Error {
  Object.defineProperty(error, NOT_SENT, { value: true, enumerable: false })
  return error
}

export function laneWasNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<string, unknown>)[NOT_SENT] === true
}

// The other provable case: the frame was written and the reply never arrived, so the
// host may have acted on it. Callers must reconcile (by intent id) instead of resending.
const OUTCOME_UNKNOWN = 'desktopLaneOutcomeUnknown'

export function laneOutcomeUnknown(error: Error): Error {
  Object.defineProperty(error, OUTCOME_UNKNOWN, { value: true, enumerable: false })
  return error
}

export function laneWasWrittenUnknown(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<string, unknown>)[OUTCOME_UNKNOWN] === true
}
