import type { RestartContinueState } from '../../hooks/useHostQueue'
import { RESTART_NOTE_COPY } from '../../constants/restart-note-copy'
import { Button } from '../primitives/Button'

/**
 * C4: the explicit "继续" over the restart evidence. The automatic note reaches the next turn on its
 * own; this is the visible offer for the user who wants to continue now, and it exists once per note
 * because the host consumes it on the press.
 */
export function RestartNoteRow({ state }: { state: RestartContinueState }) {
  // "unknown" is not "nothing to do": the host has not answered, so the row stays quiet rather than
  // telling the user their background work is fine.
  if (state.offer === 'idle' || state.offer === 'none') return null
  if (state.offer === 'unknown') {
    return (
      <div className="prompt-queue" role="status">
        <div className="queue-title">
          <span className="queue-title-main">{RESTART_NOTE_COPY.title}</span>
          <span className="queue-hint">{RESTART_NOTE_COPY.hint}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="prompt-queue" role="status" aria-label={RESTART_NOTE_COPY.label}>
      <div className="queue-title">
        <span className="queue-title-main">{RESTART_NOTE_COPY.title}</span>
        <span className="queue-hint">{RESTART_NOTE_COPY.hint}</span>
      </div>
      {state.error !== null && <div className="queue-hint" role="alert">{state.error}</div>}
      <div className="queue-row">
        <Button size="sm" variant="quiet" disabled={state.pressing} onClick={state.press}>
          {state.pressing ? RESTART_NOTE_COPY.continuing : RESTART_NOTE_COPY.continue}
        </Button>
      </div>
    </div>
  )
}
