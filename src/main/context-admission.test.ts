import { describe, expect, it, vi } from 'vitest'
import { ContextAdmission, expectedSessionMatches, waitForCompletedRuns } from './context-admission'

describe('context admission', () => {
  it('serializes the same provider workspace while allowing another context through', async () => {
    const admission = new ContextAdmission()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []

    const first = admission.run('codex\0/repo', async () => {
      order.push('first:start')
      await firstBlocked
      order.push('first:end')
    })
    const secondAction = vi.fn(async () => { order.push('second') })
    const second = admission.run('codex\0/repo', secondAction)
    const independent = admission.run('claude\0/repo', async () => { order.push('independent') })

    await independent
    expect(secondAction).not.toHaveBeenCalled()
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'independent', 'first:end', 'second'])
  })

  it('releases the queue after an action rejects', async () => {
    const admission = new ContextAdmission()
    await expect(admission.run('qoder\0/repo', async () => { throw new Error('denied') }))
      .rejects.toThrow('denied')
    await expect(admission.run('qoder\0/repo', async () => 'next')).resolves.toBe('next')
  })

  it('waits for a UI-complete run to settle before admitting the queued turn', async () => {
    let releasePipeline!: () => void
    const settled = new Promise<void>((resolve) => { releasePipeline = resolve })
    let admitted = false
    const waiting = waitForCompletedRuns([{ done: true, settled }]).then((value) => { admitted = value })
    await Promise.resolve()
    expect(admitted).toBe(false)
    releasePipeline()
    await waiting
    expect(admitted).toBe(true)
    await expect(waitForCompletedRuns([{ done: false, settled: Promise.resolve() }])).resolves.toBe(false)
  })

  it('binds a prompt to the session selected before a draining wait', () => {
    const draining = [{ runId: 'run-a', externalSessionId: 'session-a' }]
    expect(expectedSessionMatches('session-a', 'session-a', draining)).toBe(true)
    expect(expectedSessionMatches('run-a', 'session-a', draining)).toBe(true)
    expect(expectedSessionMatches('session-a', 'session-b', draining)).toBe(false)
    expect(expectedSessionMatches(null, undefined, draining)).toBe(true)
    expect(expectedSessionMatches(null, 'session-b', draining)).toBe(false)
  })
})
