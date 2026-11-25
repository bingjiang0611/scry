import { describe, expect, it, vi } from 'vitest'
import { qoderSteerCapability, steerQoderRun } from './qoder-steer'
import { steerKeptQoderSession } from './qoder-session'

// C2: Qoder's kept session takes mid-turn input. These tests prove what Scry admits and what it claims;
// whether the CLI injects it at a boundary is the SDK's documented behaviour, not something a fake says.

describe('Qoder native steer', () => {
  it('puts the message on the live session stream as next-turn input, never as a new turn', () => {
    const send = vi.fn()
    const result = steerKeptQoderSession({ send }, { messageId: 'msg-1', prompt: 'also fix the test', attachments: [] })
    expect(result).toEqual({ status: 'accepted' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      priority: 'next',
      uuid: 'msg-1',
      message: { role: 'user', content: [{ type: 'text', text: 'also fix the test' }] }
    })
  })

  it('refuses to admit anything once the turn is over, instead of claiming success', () => {
    const send = vi.fn()
    // No session at all: nothing can be admitted.
    expect(steerQoderRun(undefined, { messageId: 'm', prompt: 'p', attachments: [] }, true))
      .toEqual({ status: 'unavailable', message: '当前这一轮已结束，消息未作为 Steer 发送。' })
    expect(send).not.toHaveBeenCalled()
    // A session that exists but has settled or stopped must not take input either.
    const lease = { send } as unknown as Parameters<typeof steerQoderRun>[0]
    for (const live of [false]) {
      expect(steerQoderRun(lease, { messageId: 'm', prompt: 'p', attachments: [] }, live)).toMatchObject({ status: 'unavailable' })
    }
    expect(send).not.toHaveBeenCalled()
    // Live session: admitted.
    expect(steerQoderRun(lease, { messageId: 'm', prompt: 'p', attachments: [] }, true)).toEqual({ status: 'accepted' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('announces the capability only for a kept session, and only for text', () => {
    const event = qoderSteerCapability('run-1', 'qoder|1|2', 'evt-1', '2026-01-01T00:00:00.000Z')
    expect(event).toMatchObject({
      kind: 'harness', stage: 'runtime:steer_capability',
      steerCapability: { status: 'available', attachments: false },
      runtimeMetadata: { source: 'qoder_kept_session', sessionKey: 'qoder|1|2' }
    })
  })
})
