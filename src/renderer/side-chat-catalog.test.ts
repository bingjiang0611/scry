import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import type { AgentRunControlCatalog } from '@shared/runtime'
import { contextKey } from './hooks/integration-model'
import { createRunControlCatalogReader } from './side-chat-catalog'

const catalog: AgentRunControlCatalog = {
  models: [{ model: { id: 'gpt' }, label: 'GPT', efforts: [] }],
  permissions: [{ id: 'default', label: '默认审批', description: '' }]
}

const envelope = (data: AgentRunControlCatalog | null, reason?: string): CapabilityEnvelope<AgentRunControlCatalog> => ({
  providerId: 'codex', mode: 'manage', state: data ? 'ready' : 'unsupported', data,
  ...(reason ? { reason } : {})
})

const deferred = () => {
  let resolve: (value: CapabilityEnvelope<AgentRunControlCatalog>) => void = () => undefined
  const promise = new Promise<CapabilityEnvelope<AgentRunControlCatalog>>(done => { resolve = done })
  return { promise, resolve }
}

const codex = { providerId: 'codex' as const, cwd: '/repo' }
const claude = { providerId: 'claude' as const, cwd: '/repo' }

describe('side chat capability reader', () => {
  it('never reads by itself', () => {
    const read = vi.fn(async () => envelope(catalog))
    createRunControlCatalogReader({ read, settle: () => undefined })
    expect(read).not.toHaveBeenCalled()
  })

  it('coalesces one open into one read even when model and effort open together', async () => {
    const read = vi.fn(async () => envelope(catalog))
    const settle = vi.fn()
    const reader = createRunControlCatalogReader({ read, settle })
    reader.request(codex)
    reader.request(codex)
    reader.request(codex)
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    expect(read).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0][0]).toMatchObject({ key: contextKey(codex), result: { status: 'ready' } })
    // A later open of the context already loaded needs no second read.
    reader.request(codex)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('drops a late answer for another Provider context', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi.fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise)
    const settle = vi.fn()
    const reader = createRunControlCatalogReader({ read, settle })
    reader.request(codex)
    reader.request(claude)
    second.resolve(envelope(catalog))
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    first.resolve(envelope(catalog))
    await Promise.resolve()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0][0].key).toBe(contextKey(claude))
  })

  it('retries after an unavailable answer and reports the reason', async () => {
    const read = vi.fn()
      .mockImplementationOnce(async () => envelope(null, 'Provider 未就绪'))
      .mockImplementationOnce(async () => envelope(catalog))
    const settle = vi.fn()
    const reader = createRunControlCatalogReader({ read, settle })
    reader.request(codex)
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    expect(settle.mock.calls[0][0].result).toEqual({ status: 'refused', reason: 'Provider 未就绪' })
    reader.request(codex)
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(2))
    expect(read).toHaveBeenCalledTimes(2)
    expect(settle.mock.calls[1][0].result).toMatchObject({ status: 'ready' })
  })

  it('skips a context already shown from the local cache', () => {
    const read = vi.fn(async () => envelope(catalog))
    const reader = createRunControlCatalogReader({ read, settle: () => undefined })
    reader.markLoaded(contextKey(codex))
    reader.request(codex)
    expect(read).not.toHaveBeenCalled()
  })

  it('cancels an in-flight read when the view goes away', async () => {
    const pending = deferred()
    const read = vi.fn(async () => pending.promise)
    const settle = vi.fn()
    const reader = createRunControlCatalogReader({ read, settle })
    reader.request(codex)
    reader.cancel()
    pending.resolve(envelope(catalog))
    await Promise.resolve()
    expect(settle).not.toHaveBeenCalled()
  })
})

describe('coalesced requests report whether they started', () => {
  it('answers false for a dropped request so the caller keeps no stale loading state', async () => {
    const read = vi.fn(async () => envelope(catalog))
    const reader = createRunControlCatalogReader({ read, settle: () => undefined })
    expect(reader.request(codex)).toBe(true)
    expect(reader.request(codex)).toBe(false)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    // After a successful load the same context never reads again.
    expect(reader.request(codex)).toBe(false)
  })
})
