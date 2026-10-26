import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite16(): void {


describe('OpenCode compact lifecycle evidence', () => {
  it('把 session.next.compaction.ended 写进 CLI Turn Record', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'opencode',
      event: 'chat.message',
      workspace: root,
      payload: payload('o1', { prompt: 'continue' })
    })
    await handleRecorderHook({
      provider: 'opencode',
      event: 'session.next.compaction.ended',
      workspace: root,
      payload: payload('o1', {
        messageID: 'compact-message-1',
        reason: 'auto',
        timestamp: '2026-07-19T12:00:00.500Z'
      })
    })
    await handleRecorderHook({
      provider: 'opencode',
      event: 'session.idle',
      workspace: root,
      payload: payload('o1', { timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.compactions?.value).toEqual([
      expect.objectContaining({ trigger: 'auto' })
    ])
  })
})
}
