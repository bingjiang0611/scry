import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { deliverDaemonOAuthUrl, installMcpDaemonWindow } from './mcp-daemon'


const SAFE = 'https://auth.example.com/authorize?state=x'

describe('MCP OAuth pages in daemon mode', () => {
  const undo: Array<() => void> = []
  afterEach(() => { for (const step of undo.splice(0)) step(); vi.restoreAllMocks() })

  function wire(reply: () => Promise<unknown>) {
    const openExternal = vi.fn(async (_url: string) => undefined)
    undo.push(installMcpDaemonWindow({ openExternal }))
    undo.push(installDaemonChannelForwarder(async () => await reply()))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reauth = gateDaemonChannel('agent:reauthenticateMcp', vi.fn()) as unknown as (event: unknown, payload: unknown) => Promise<unknown>
    return { openExternal, reauth }
  }

  it('opens the page while this window waits for its re-auth, and not after', async () => {
    let finish: ((value: unknown) => void) | undefined
    const { openExternal, reauth } = wire(() => new Promise((resolve) => { finish = resolve }))
    deliverDaemonOAuthUrl(SAFE)
    expect(openExternal).not.toHaveBeenCalled()
    const call = reauth({}, { context: { providerId: 'codex', cwd: '/w' }, targetId: 'srv' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    deliverDaemonOAuthUrl(SAFE)
    expect(openExternal).toHaveBeenCalledWith(SAFE)
    finish?.({ state: 'ready' })
    await call
    deliverDaemonOAuthUrl(SAFE)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('refuses a page main would not have opened, even during a re-auth', async () => {
    let finish: ((value: unknown) => void) | undefined
    const { openExternal, reauth } = wire(() => new Promise((resolve) => { finish = resolve }))
    const call = reauth({}, { context: { providerId: 'codex', cwd: '/w' }, targetId: 'srv' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    for (const url of ['http://evil.example.com/a', 'file:///etc/passwd', 'https://user:pw@auth.example.com/', 'javascript:alert(1)']) deliverDaemonOAuthUrl(url)
    expect(openExternal).not.toHaveBeenCalled()
    finish?.({})
    await call
  })

  it('stops waiting once a re-auth fails', async () => {
    const { openExternal, reauth } = wire(async () => { throw new Error('当前 Provider 正在执行会话') })
    await expect(reauth({}, { context: { providerId: 'codex', cwd: '/w' }, targetId: 'srv' })).rejects.toThrow('当前 Provider 正在执行会话')
    deliverDaemonOAuthUrl(SAFE)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
