import { describe, expect, it } from 'vitest'
import { RunWakes } from './daemon-run-wakes'

// P3f E2: a run reads when the daemon says it changed, instead of each run holding a
// long poll on the one watch lane. A wake must never be lost between a read and the
// wait after it, and no wait may be unbounded.

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => { done = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

describe('run wakes', () => {
  it('ends a wait when its run is woken, not when another run is', async () => {
    const wakes = new RunWakes()
    const waiting = wakes.wait('run-a', 10_000)
    wakes.wake('run-b')
    expect(await settled(waiting)).toBe(false)
    wakes.wake('run-a')
    expect(await settled(waiting)).toBe(true)
  })

  it('keeps a wake that arrives while the run is reading, so the next wait returns at once', async () => {
    const wakes = new RunWakes()
    wakes.consume('run-a') // the read starts
    wakes.wake('run-a') // the daemon changes the run during that read
    expect(await settled(wakes.wait('run-a', 10_000))).toBe(true)
    // Consumed by the next read: the wait after that one waits again.
    wakes.consume('run-a')
    expect(await settled(wakes.wait('run-a', 10_000))).toBe(false)
    wakes.wake('run-a')
  })

  it('bounds every wait, so a lost notice costs at most the fallback', async () => {
    const wakes = new RunWakes()
    const started = Date.now()
    await wakes.wait('run-a', 20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('wakes every waiting run when notices may have been lost or the feed went away', async () => {
    const wakes = new RunWakes()
    wakes.setLive(true)
    const a = wakes.wait('run-a', 10_000)
    const b = wakes.wait('run-b', 10_000)
    wakes.wakeAll()
    expect([await settled(a), await settled(b)]).toEqual([true, true])
    const c = wakes.wait('run-c', 10_000)
    // Without the feed a run must go back to its own long poll, not sit here.
    wakes.setLive(false)
    expect(wakes.live).toBe(false)
    expect(await settled(c)).toBe(true)
  })
})
