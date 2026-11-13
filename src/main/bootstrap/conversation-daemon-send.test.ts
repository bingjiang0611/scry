import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder, installDaemonRunFollower } from '../daemon-channel-gate'
import { installDaemonConversationSend } from './conversation-daemon-send'

// Daemon mode `conversation:send` (P3-conversation-send.md): the daemon answers with the
// ledger run that carries the conversation turn. The window follows that run like one it
// submitted, then refreshes the conversation, and the renderer gets the in-process answer.
const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const TURN = '3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const request = { conversationId: 'conv-1', commandId: 'c'.repeat(32) }

function gated() {
  return gateDaemonChannel('conversation:send', vi.fn(), ON) as unknown as (event: unknown, ...values: unknown[]) => Promise<unknown>
}

describe('conversation send in daemon mode', () => {
  let uninstall: Array<() => void> = []
  afterEach(() => { for (const undo of uninstall) undo(); uninstall = [] })

  it('follows the run, then refreshes the conversation, and answers like the in-process send', async () => {
    const order: string[] = []
    const follow = vi.fn(async () => { order.push('follow'); return { runId: TURN, bound: true } })
    const publish = vi.fn(() => { order.push('publish') })
    uninstall.push(installDaemonConversationSend(publish), installDaemonRunFollower(follow))
    uninstall.push(installDaemonChannelForwarder(async () => ({ runId: TURN, disposition: 'created', ledger: { runId: 'ledger-1', seq: 41 } })))
    await expect(gated()({}, request)).resolves.toEqual({ runId: TURN, disposition: 'created' })
    expect(follow).toHaveBeenCalledWith({ runId: 'ledger-1', seq: 41 })
    expect(publish).toHaveBeenCalledWith({ kind: 'conversation_changed', conversationId: 'conv-1' })
    expect(order).toEqual(['follow', 'publish'])
  })

  it('still answers a started send when following it fails, because the run is real', async () => {
    const publish = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    uninstall.push(installDaemonConversationSend(publish), installDaemonRunFollower(async () => { throw new Error('daemon_not_running') }))
    uninstall.push(installDaemonChannelForwarder(async () => ({ runId: TURN, disposition: 'created', ledger: { runId: 'ledger-1' } })))
    await expect(gated()({}, request)).resolves.toEqual({ runId: TURN, disposition: 'created' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('answers a duplicate of a finished turn without following anything', async () => {
    const follow = vi.fn()
    const publish = vi.fn()
    uninstall.push(installDaemonConversationSend(publish), installDaemonRunFollower(follow))
    uninstall.push(installDaemonChannelForwarder(async () => ({ runId: TURN, disposition: 'duplicate' })))
    await expect(gated()({}, request)).resolves.toEqual({ runId: TURN, disposition: 'duplicate' })
    expect(follow).not.toHaveBeenCalled()
  })

  it('announces nothing when the daemon refused the send, and refuses a malformed answer', async () => {
    const follow = vi.fn()
    const publish = vi.fn()
    uninstall.push(installDaemonConversationSend(publish), installDaemonRunFollower(follow))
    const forwarder = installDaemonChannelForwarder(async () => { throw new Error('对话已变化，请重新预览') })
    await expect(gated()({}, request)).rejects.toThrow('对话已变化')
    forwarder()
    uninstall.push(installDaemonChannelForwarder(async () => ({ runId: 7 })))
    await expect(gated()({}, request)).rejects.toThrow('invalid_daemon_response')
    expect(follow).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
