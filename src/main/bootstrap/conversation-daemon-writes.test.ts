import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { announceDaemonConversationWrites } from './conversation'

// With the switch on, the daemon writes the conversation ledger and cannot reach this
// window yet (§13.5). A write this App made must still refresh the window exactly as the
// in-process handler did: the App announces it once the daemon has answered.
describe('conversation writes in daemon mode', () => {
  let uninstall: Array<() => void> = []
  afterEach(() => { for (const undo of uninstall) undo(); uninstall = [] })

  it.each([
    ['conversation:create', ['/w'], { id: 'conv-1' }, 'conv-1'],
    ['conversation:createSideChat', [{ source: {} }], { id: 'conv-2' }, 'conv-2'],
    ['conversation:adopt', [{}, 'f'.repeat(64)], { id: 'conv-3' }, 'conv-3'],
    ['conversation:update', ['conv-4', 3, { kind: 'rename', title: 't' }], { ok: true }, 'conv-4']
  ])('announces %s for the conversation it changed', async (channel, args, answer, conversationId) => {
    const send = vi.fn()
    uninstall.push(...announceDaemonConversationWrites((event) => send('agent:dataUpdated', event)))
    uninstall.push(installDaemonChannelForwarder(async () => answer))
    const gated = gateDaemonChannel(channel, vi.fn(), { SCRY_HOST_DAEMON: '1' }) as unknown as (event: unknown, ...values: unknown[]) => Promise<unknown>
    await expect(gated({}, ...args)).resolves.toEqual(answer)
    expect(send).toHaveBeenCalledWith('agent:dataUpdated', { kind: 'conversation_changed', conversationId })
  })

  it('does not announce a change when the daemon refused the write', async () => {
    const send = vi.fn()
    uninstall.push(...announceDaemonConversationWrites((event) => send(event)))
    uninstall.push(installDaemonChannelForwarder(async () => { throw new Error('统一对话工作区无效') }))
    const gated = gateDaemonChannel('conversation:create', vi.fn(), { SCRY_HOST_DAEMON: '1' }) as unknown as (event: unknown, ...values: unknown[]) => Promise<unknown>
    await expect(gated({}, '')).rejects.toThrow('统一对话工作区无效')
    expect(send).not.toHaveBeenCalled()
  })
})
