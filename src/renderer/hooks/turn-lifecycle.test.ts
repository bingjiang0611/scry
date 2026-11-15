import { describe, expect, it } from 'vitest'
import { INTERRUPTED_TURN_NOTICE } from '@shared/turn-outcome-copy'
import type { Turn } from '../format'
import { replayRunLifecycleDeltas } from './turn-lifecycle'

const turn = (patch: Partial<Turn> = {}): Turn => ({ runId: 'r1', userText: 'hi', items: [], done: false, ...patch })

describe('terminal lifecycle on live turns', () => {
  it('marks a live turn that ended interrupted, even with no Provider evidence at all', () => {
    const [done] = replayRunLifecycleDeltas([turn()], [{ kind: 'done', event: { runId: 'r1', status: 'interrupted' } }])
    expect(done).toMatchObject({ done: true, errorHint: INTERRUPTED_TURN_NOTICE })
  })

  it('keeps an existing hint and does not repeat the notice on replay', () => {
    const delta = { kind: 'done' as const, event: { runId: 'r1', status: 'interrupted' as const } }
    const [once] = replayRunLifecycleDeltas([turn({ errorHint: '守护进程已停止' })], [delta])
    expect(once.errorHint).toBe(`${INTERRUPTED_TURN_NOTICE}\n守护进程已停止`)
    expect(replayRunLifecycleDeltas([once], [delta])[0].errorHint).toBe(once.errorHint)
  })

  it.each([undefined, 'completed', 'failed', 'cancelled'] as const)('adds no notice for status %s', (status) => {
    const [done] = replayRunLifecycleDeltas([turn()], [{ kind: 'done', event: { runId: 'r1', ...(status ? { status } : {}) } }])
    expect(done.done).toBe(true)
    expect(done.errorHint).toBeUndefined()
  })

  it('touches only the run that ended', () => {
    const other = turn({ runId: 'r2' })
    const [, untouched] = replayRunLifecycleDeltas([turn(), other], [{ kind: 'done', event: { runId: 'r1', status: 'interrupted' } }])
    expect(untouched).toBe(other)
  })
})
