import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ConversationStore } from './conversation-store'
import { ConversationService, type ManagedConversationStart } from './conversation-service'
import { createDesktopTaskEntry } from './desktop-task-entry'

describe('cached direct submission deletion authority', () => {
  it.each(['pending', 'complete'] as const)('rejects a cached receipt after deletion becomes %s without another dispatch', async status => {
    const root = await mkdtemp(join(tmpdir(), 'scry-task-deletion-'))
    try {
      await mkdir(join(root, 'workspace'))
      const cwd = await realpath(join(root, 'workspace'))
      const store = new ConversationStore(join(root, 'user-data'))
      const conversation = await store.create(cwd)
      const reservations: ManagedConversationStart[] = []
      const resolveContinuationKey = async () => 'identity'
      const service = new ConversationService({
        store, resolveContinuationKey, supportsHistoricalInput: () => true,
        startAppRun: async (_request, { managedConversation }) => {
          reservations.push(managedConversation)
          return { runId: managedConversation.runId }
        }
      })
      const entry = createDesktopTaskEntry({
        store: () => store, service: () => service, getUserData: () => join(root, 'user-data'), resolveContinuationKey,
        discoverCommands: async () => ({ providerId: 'codex', cwd, mode: 'read', state: 'ready', data: [] })
      })
      const request = { conversationId: conversation.id, expectedRevision: conversation.revision,
        expectedContinuationKey: 'identity', commandId: 'cached-before-deletion', providerId: 'codex',
        prompt: 'synthetic isolated request', selectedItems: [], confirmFresh: true, permissionMode: 'default' }
      const result = await entry.submit(request)
      await reservations[0]!.onTerminal({ status: 'failed', finalItems: [] })
      await expect(entry.submit(request)).resolves.toEqual({ ...result, disposition: 'duplicate' })
      const current = (await store.read(conversation.id))!
      const archived = await store.updateMetadata(current.id, current.revision, { kind: 'archive', archived: true })
      const fingerprint = createHash('sha256').update('synthetic deletion').digest('hex')
      await store.beginDeletion(archived.id, archived.revision, fingerprint)
      if (status === 'complete') {
        await store.finishDeletion(archived.id, fingerprint, { ok: true, deleted: [], retained: [], failed: [] })
      }
      await expect(entry.submit(request)).rejects.toThrow('正在删除或已删除')
      expect(reservations).toHaveLength(1)
      expect((await store.read(conversation.id))?.deletion?.status).toBe(status)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
