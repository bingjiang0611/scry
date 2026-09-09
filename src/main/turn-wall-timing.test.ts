import { describe, expect, it } from 'vitest'
import { createTurnWallTimer } from './turn-wall-timing'

describe('Scry turn wall timing', () => {
  it.each([false, true])('waits for adapter cleanup on success and failure (failed=%s)', async (failed) => {
    let now = 1000
    const finish = createTurnWallTimer('run-1', { now: () => now, monotonic: () => now })
    const runtime = async () => {
      now += 500 // SessionStart
      now += 2300 // UserPromptSubmit
      try {
        now += 6800 // model
        if (failed) throw new Error('provider failed')
      } finally {
        now += 900 // Stop
        await Promise.resolve()
        now += 40 // SessionEnd / close
      }
    }
    await runtime().catch(() => {})
    const event = finish()
    expect(event).toMatchObject({
      runId: 'run-1', kind: 'harness', stage: 'runtime:turn_wall', durationMs: 10540,
      ts: new Date(11540).toISOString(),
      input: { startedAt: new Date(1000).toISOString(), boundary: 'provider_settled' }
    })
    now += 5000 // detached uploader / archive must not extend the settled boundary
    expect(finish()).toBe(event)
  })

  it('uses monotonic elapsed time even when the system clock changes', () => {
    let wall = 10000
    let monotonic = 100
    const finish = createTurnWallTimer('run-2', { now: () => wall, monotonic: () => monotonic })
    wall = 5000
    monotonic = 3100
    expect(finish().durationMs).toBe(3000)
  })
})
