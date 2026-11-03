import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import type { ConversationSendRequest } from '../shared/conversation-api'

/**
 * A managed runner that answered is not proof of delivery.
 *
 * `startAppRun` can return normally and still leave this attempt unsettled — here it names
 * a runId the host never recorded. The durable receipt and the page the renderer reads must
 * both stay `unknown`, so no retry replays a refusal and no second Provider start happens.
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const request = (conversationId: string, revision: number, commandId: string): ConversationSendRequest => ({
  conversationId,
  expectedRevision: revision,
  expectedContinuationKey: 'identity-a',
  commandId,
  prompt: 'hello',
  providerId: 'codex',
  selectedItems: [],
  confirmFresh: true,
  permissionMode: 'default'
})

describe('managed runner receipt settlement', () => {
  it('settles an answered runner with a different runId as unknown and never re-dispatches it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-runner-receipt-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    let dispatches = 0
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async () => {
        dispatches += 1
        return { runId: 'wrong-run-id' }
      }
    })
    const created = await service.create(cwd)
    await expect(service.send(request(created.id, created.revision, 'command-runid-1'))).rejects.toThrow('不同的 runId')

    const durable = (await store.read(created.id))?.turns[0]
    expect(durable).toMatchObject({
      runId: expect.any(String), items: [],
      delivery: { status: 'unknown', reason: '统一对话 runner 返回了不同的 runId' }
    })
    const page = await service.read(created.id)
    expect(page.turns.map(turn => turn.delivery)).toEqual([{
      status: 'unknown', reason: '统一对话 runner 返回了不同的 runId'
    }])

    // An unknown attempt offers no explicit resend and no duplicate Provider start.
    await expect(service.send(request(created.id, created.revision, 'command-runid-1')))
      .rejects.toThrow('该命令的投递结果尚未确认')
    expect(dispatches).toBe(1)
  })
})
