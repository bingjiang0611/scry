import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import * as locate from '../claude-locate'
import { withProbeFixture } from './pi-rpc.fixture'

// Exercise a real runner timeout: the failed body may still be unwinding while
// the next test installs its shellEnv spy. The ordered pair is deliberate: run
// this file as a unit. No Provider/model is involved.
describe.sequential('Pi probe fixture timeout cleanup', () => {
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  let timeoutReason = ''
  let exited = false
  let pid: number | undefined
  let firstDirectory = ''

  it.fails('times out while its owned child is still being cleaned up', async ({ signal }) => {
    try {
      await withProbeFixture(async (_profile, cwd) => {
        firstDirectory = cwd
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        pid = child.pid
        const exit = once(child, 'exit')
        try {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => {
            timeoutReason = String(signal.reason)
            child.kill('SIGKILL')
            resolve()
          }, { once: true }))
          await exit
          exited = true
        } finally {
          child.kill('SIGKILL')
          await exit
        }
      })
    } finally { finish() }
  }, 50)

  it('keeps the next fixture mock after the timed-out body has finished', async () => {
    await withProbeFixture(async () => {
      expect(vi.isMockFunction(locate.shellEnv)).toBe(true)
      await finished
      await setImmediate()
      expect(timeoutReason).toContain('50ms')
      expect(exited).toBe(true)
      expect(firstDirectory).not.toBe('')
      expect(existsSync(firstDirectory)).toBe(false)
      expect(pid).toBeTypeOf('number')
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(vi.isMockFunction(locate.shellEnv)).toBe(true)
    })
  })
})
