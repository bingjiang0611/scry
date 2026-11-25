import { describe, expect, it } from 'vitest'
import { RunWakes } from './daemon-run-wakes'

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
    wakes.consume('run-a')
    wakes.wake('run-a')
    expect(await settled(wakes.wait('run-a', 10_000))).toBe(true)
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

  it('wakes every waiting run on disposal', async () => {
    const wakes = new RunWakes()
    const a = wakes.wait('run-a', 10_000)
    const b = wakes.wait('run-b', 10_000)
    wakes.wakeAll()
    expect([await settled(a), await settled(b)]).toEqual([true, true])

  })
})
