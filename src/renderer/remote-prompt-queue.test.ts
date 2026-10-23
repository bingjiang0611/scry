import { describe, expect, it } from 'vitest'
import type { DesktopRemoteIntent, DesktopRemoteSubmit } from '@shared/desktop-remote'
import { RemotePromptQueueStore, remoteQueueKey } from './remote-prompt-queue'

const request: DesktopRemoteSubmit = { context: { cwd: '/project', providerId: 'pi' }, prompt: '/skill:review', modelId: 'remote-model', effort: 'high' }
const receipt: DesktopRemoteIntent = { intentId: 'next', connectionId: 'mac2', context: request.context, createdAt: 1, status: 'recorded', runId: 'run-next' }
const key = remoteQueueKey('mac2/project/session', 'pi')

describe('remote prompt queue', () => {
  it('keeps every queue on a blocked connection paused after receipt recovery without losing prompts or attachments', () => {
    const store = new RemotePromptQueueStore()
    const otherSession = remoteQueueKey('mac2/other/session', 'claude')
    const otherHost = remoteQueueKey('mac3/project/session', 'pi')
    const image = { kind: 'image' as const, name: 'queued.png', mimeType: 'image/png' as const, dataBase64: 'aQ==', size: 1 }
    store.enqueue(key, 'mac2', { ...request, attachments: [image] }, 'unknown-intent')
    store.enqueue(otherSession, 'mac2', { ...request, prompt: 'other session' })
    store.enqueue(otherHost, 'mac3', request)
    const original = structuredClone(store.get(key).prompts)
    store.pauseConnection('mac2')
    store.settle(key, 'unknown-intent')
    expect(store.claim(key)).toBeUndefined()
    expect(store.claim(otherSession)).toBeUndefined()
    expect(store.get(key).prompts).toEqual(original)
    expect(store.claim(otherHost)?.text).toBe(request.prompt)
    store.resume(key)
    expect(store.claim(key)?.submission.attachments).toEqual([image])
    expect(store.claim(otherSession)).toBeUndefined()
  })

  it('waits for the exact receipt to reach a confirmed terminal state, then submits once', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request, 'running')
    expect(store.claim(key)).toBeUndefined()
    store.settle(key, 'another-run')
    expect(store.claim(key)).toBeUndefined()
    store.settle(key, 'running')
    expect(store.claim(key)?.submission).toEqual(request)
    expect(store.claim(key)).toBeUndefined()
  })
  it('retains image attachments while queued and copies them into the display entry', () => {
    const store = new RemotePromptQueueStore()
    const image = { kind: 'image' as const, name: 'queued.png', mimeType: 'image/png' as const, dataBase64: 'aQ==', size: 1 }
    store.enqueue(key, 'mac2', { ...request, prompt: '', attachments: [image] })
    expect(store.get(key).prompts[0]).toMatchObject({ text: '', attachments: [image], submission: { attachments: [image] } })
  })

  it('rebinds remaining entries to the newly submitted receipt', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request, 'running')
    store.enqueue(key, 'mac2', { ...request, prompt: 'second' }, 'running')
    store.settle(key, 'running')
    store.claim(key)
    store.submitted(key, receipt)
    expect(store.get(key).prompts.map(prompt => prompt.text)).toEqual(['second'])
    expect(store.claim(key)).toBeUndefined()
    store.settle(key, receipt.intentId)
    expect(store.claim(key)?.text).toBe('second')
  })
  it('keeps unknown writes and throwing submissions paused without automatic or manual resend', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request)
    store.claim(key)
    store.fail(key)
    store.resume(key)
    expect(store.claim(key)).toBeUndefined()
    expect(store.get(key).writeUnknown).toBe(true)
    expect(store.get(key).prompts).toHaveLength(1)
  })
  it('pauses on disconnect and requires explicit continuation after terminal confirmation', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request, 'running')
    store.pause(key)
    store.settle(key, 'running')
    expect(store.claim(key)).toBeUndefined()
    store.resume(key)
    expect(store.claim(key)?.text).toBe(request.prompt)
  })
  it('migrates new-session queues with the adopted native session without losing model controls', () => {
    const store = new RemotePromptQueueStore()
    const destination = remoteQueueKey('mac2/project/native', 'pi')
    store.enqueue(key, 'mac2', request, 'running')
    store.migrate(key, destination, 'native')
    expect(store.get(key).prompts).toEqual([])
    store.settle(destination, 'running')
    expect(store.claim(destination)?.submission).toEqual({ ...request, context: { ...request.context, externalSessionId: 'native' } })
  })
  it('isolates hosts, sessions and profiles; archive cancels only the chosen session', () => {
    const store = new RemotePromptQueueStore()
    const otherProfile = remoteQueueKey('mac2/project/session', 'pi:profile')
    const otherHost = remoteQueueKey('local/project/session', 'pi')
    store.enqueue(key, 'mac2', request)
    store.enqueue(otherProfile, 'mac2', request)
    store.enqueue(otherHost, 'local', request)
    store.clearSession('mac2/project/session')
    expect(store.get(key).prompts).toEqual([])
    expect(store.get(otherProfile).prompts).toEqual([])
    expect(store.get(otherHost).prompts).toHaveLength(1)
  })
  it('bounds queued work and preserves earlier entries when full', () => {
    const store = new RemotePromptQueueStore()
    for (let index = 0; index < 32; index++) store.enqueue(key, 'mac2', request)
    expect(() => store.enqueue(key, 'mac2', request)).toThrow('32')
    expect(store.get(key).prompts).toHaveLength(32)
  })
  it('pauses background queues on disconnect without resuming them on reconnect', () => {
    const store = new RemotePromptQueueStore()
    const other = remoteQueueKey('other', 'pi')
    store.enqueue(key, 'mac2', request, 'running')
    store.enqueue(other, 'mac3', request)
    store.pauseDisconnected(new Set(['mac3']))
    store.pauseDisconnected(new Set(['mac2', 'mac3']))
    store.settle(key, 'running')
    expect(store.claim(key)).toBeUndefined()
    expect(store.claim(other)?.text).toBe(request.prompt)
    store.resume(key)
    expect(store.claim(key)?.text).toBe(request.prompt)
  })
  it('cannot remove the write in flight', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request)
    const prompt = store.claim(key)!
    store.remove(key, prompt.messageId)
    expect(store.get(key).prompts).toHaveLength(1)
  })

  it('skips the row being edited and still removes the entry it actually submitted', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request)
    store.enqueue(key, 'mac2', { ...request, prompt: 'second' })
    const editing = store.get(key).prompts[0].messageId

    const claimed = store.claim(key, editing)
    expect(claimed?.text).toBe('second')
    store.submitted(key, receipt)

    // 不能因为跳行就把队首一起切掉。
    expect(store.get(key).prompts.map(prompt => prompt.messageId)).toEqual([editing])
    store.settle(key, receipt.intentId)
    expect(store.claim(key)?.messageId).toBe(editing)
  })

  it('keeps the claimed entry removable-guarded even when it is not the head', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request)
    store.enqueue(key, 'mac2', { ...request, prompt: 'second' })
    const editing = store.get(key).prompts[0].messageId
    const claimed = store.claim(key, editing)!

    store.remove(key, editing)
    expect(store.get(key).prompts.map(prompt => prompt.messageId)).toEqual([claimed.messageId])
    // 正在提交的那条即使不是队首也不能移除。
    store.remove(key, claimed.messageId)
    expect(store.get(key).prompts).toHaveLength(1)
  })

  it('re-enqueues an edited entry at the tail with a fresh id', () => {
    const store = new RemotePromptQueueStore()
    store.enqueue(key, 'mac2', request)
    store.enqueue(key, 'mac2', { ...request, prompt: 'second' })
    const editing = store.get(key).prompts[0].messageId

    const moved = store.enqueueEdited(key, 'mac2', editing, { ...request, prompt: 'edited' })
    expect(store.get(key).prompts.map(prompt => prompt.text)).toEqual(['second', 'edited'])
    expect(moved?.messageId).not.toBe(editing)
    expect(store.get(key).prompts.some(prompt => prompt.messageId === editing)).toBe(false)

    const queueLength = store.get(key).prompts.length
    // 队列里已经没有这条时不能凭空改出一份副本，交给调用方回到普通入队。
    expect(store.enqueueEdited(key, 'mac2', editing, { ...request, prompt: 'again' })).toBeNull()
    expect(store.get(key).prompts).toHaveLength(queueLength)
  })
})
