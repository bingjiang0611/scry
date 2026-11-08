import { describe, expect, it } from 'vitest'
import { createRemoteRunState } from './run-remote-state'
import type { ActiveRun } from '../../shared/trace'

// M2: a run the daemon owns is a ledger run, so its recording failure travels as the
// remote completion (`recording: 'failed'`) plus the run's own error text. That is what
// the App's daemon-mode view reads: switching this to in-process semantics would set a
// flag in the daemon process that no window renders, which would hide the failure.

const runState = (): ActiveRun => ({ runId: 'run-abc-1', userText: 'go', items: [], done: false })

function state(isRemoteRun: boolean) {
  const state = runState()
  const owned = createRemoteRunState({
    isRemoteRun, runId: state.runId, providerId: 'claude', runtimeProvider: 'claude_sdk',
    runState: state, getObservedSessionId: () => 'session-1', isWindowFocused: () => false,
    dockBadge: { markAttention: () => undefined },
    scopedSessionKey: (sessionId) => `claude\0session\0${sessionId}`,
    runs: { isViewed: () => false }
  })
  // `owned.state` is the terminal bookkeeping; the ActiveRun is the visible one.
  return { owned, activeRun: state, remoteResult: owned.remoteResult }
}

describe('recording failure on a ledger run', () => {
  it('reports recording: failed and keeps the error visible on the run', async () => {
    const { owned, remoteResult, activeRun } = state(true)
    owned.state.remoteRecordingFailed = true
    owned.finishRemote('completed', '已记录本轮，但精确快照失败')
    expect(activeRun.error).toBe('已记录本轮，但精确快照失败')
    // The completion is what the daemon writes to the ledger and what the App's run
    // view shows as "recording failed", so it must not claim a committed recording.
    expect(owned.state.remoteCompletion).toMatchObject({ status: 'completed', recording: 'failed', error: '已记录本轮，但精确快照失败' })
    // The promise is settled by the run's terminal path, not by finishRemote itself.
    owned.state.resolveRemoteCompletion?.(owned.state.remoteCompletion!)
    await expect(remoteResult).resolves.toMatchObject({ recording: 'failed' })
  })

  it('has no remote completion to report for an in-process run', () => {
    // The contrast: an in-process run signals recording failure through the App's own
    // error/attention path, which is why the flag is scoped to ledger runs.
    const { remoteResult } = state(false)
    expect(remoteResult).toBeUndefined()
  })

  it('never upgrades an unknown recording to committed', async () => {
    const { owned } = state(true)
    // Nothing marked the recording failed, so the completion must say committed - and
    // nothing invents the opposite either.
    owned.finishRemote('failed')
    expect(owned.state.remoteCompletion).toMatchObject({ status: 'failed', recording: 'committed' })
    expect(owned.state.remoteRecordingFailed).toBe(false)
  })
})
