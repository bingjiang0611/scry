import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ now: 0, stopped: false, persistent: false }))
vi.mock('node:timers/promises', () => ({ setTimeout: async (ms) => { state.now += ms } }))
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    const started = 'Thu Oct 22 20:00:00 2026'
    if (!state.stopped) return `123 1 S ${started} test-app\n124 123 Ss+ ${started} /bin/zsh -l\n`
    return state.persistent || state.now < 200 ? `124 1 Ss+ ${started} (zsh)\n` : ''
  }
}))
import { stopOwnedApp } from './owned-app-processes.mjs'

beforeEach(() => {
  Object.assign(state, { now: 0, stopped: false, persistent: false })
  vi.spyOn(Date, 'now').mockImplementation(() => state.now)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('must not signal changed process identity') })
})
afterEach(() => vi.restoreAllMocks())

const app = () => ({ pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => { state.stopped = true }) })

describe('owned cleanup exit identity races', () => {
  it('waits for an exiting changed command without sending it a signal', async () => {
    const child = app()
    await expect(stopOwnedApp(child, { crash: true })).resolves.toEqual({ tracked: 2 })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(process.kill).not.toHaveBeenCalled()
    expect(state.now).toBe(200)
  })

  it('fails within the existing deadline when changed identity remains alive', async () => {
    state.persistent = true
    await expect(stopOwnedApp(app(), { crash: true })).rejects.toThrow('test process exit unconfirmed')
    expect(process.kill).not.toHaveBeenCalled()
    expect(state.now).toBe(3100)
  })
})
