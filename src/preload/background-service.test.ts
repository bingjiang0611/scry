import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

const { backgroundServiceApi } = await import('./background-service')
const callable = backgroundServiceApi as unknown as Record<string, (...args: unknown[]) => unknown>

beforeEach(() => {
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue({ status: 'done' })
  electron.on.mockClear()
  electron.removeListener.mockClear()
})

describe('preload backgroundServiceApi boundary', () => {
  it('strips extra renderer arguments on zero-arg and single-boolean channels', async () => {
    const zeroArg: Record<string, string> = {
      backgroundServiceStatus: 'remote:backgroundService:status',
      backgroundServiceRuntimeNotice: 'remote:backgroundService:runtimeNotice',
      restartBackgroundService: 'remote:backgroundService:restart',
      quitWithBackgroundService: 'remote:backgroundService:quit',
      reconnectBackgroundService: 'remote:backgroundService:reconnect'
    }
    for (const [method, channel] of Object.entries(zeroArg)) {
      electron.invoke.mockClear()
      await callable[method]('4242', { confirmed: true })
      expect(electron.invoke.mock.calls[0], method).toEqual([channel])
    }

    electron.invoke.mockClear()
    await callable.setBackgroundServiceLoginStart(true, '/etc/evil', { confirmed: true })
    expect(electron.invoke.mock.calls[0]).toEqual(['remote:backgroundService:setLoginStart', true])

    electron.invoke.mockClear()
    await callable.setHostCliApproval(true, '/etc/evil', { confirmed: true })
    expect(electron.invoke.mock.calls[0]).toEqual(['remote:hostAdmin:setCliApproval', true])
  })
})
