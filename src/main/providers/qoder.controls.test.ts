import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindQoderTestHelpers, resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t
const { untilQueried } = bindQoderTestHelpers(t)

describe('Qoder provider adapter · control sessions', () => {
  beforeEach(() => resetQoderTestState(t))

  it('anchors Skill and command evidence to initialization completion, not late catalog completion', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      let resolveUsage: (usage: unknown) => void = () => {}
      const usage = new Promise((resolve) => { resolveUsage = resolve })
      let initializedAt = 0
      const getAvailableModels = vi.fn().mockResolvedValue([{ value: 'live', displayName: 'Live', efforts: [] }])
      const oldControl = {
        initializationResult: vi.fn().mockImplementation(async () => {
          initializedAt = Date.now()
          return {}
        }),
        getContextUsage: vi.fn().mockReturnValue(usage),
        supportedCommands: vi.fn().mockResolvedValue([{ name: 'old', description: 'Old', argumentHint: '' }]),
        getAvailableModels,
        close: sdk.close
      }
      const freshControl = {
        initializationResult: vi.fn().mockResolvedValue({}),
        getContextUsage: vi.fn().mockResolvedValue({ skills: { count: 1, items: [{ name: 'fresh', source: 'project' }] } }),
        supportedCommands: vi.fn().mockResolvedValue([{ name: 'fresh', description: 'Fresh', argumentHint: '' }]),
        close: sdk.close
      }
      sdk.query.mockReturnValueOnce(oldControl).mockReturnValueOnce(freshControl)
      const adapter = createQoderAdapter()
      const context = { providerId: 'qoder' as const, cwd: '/repo' }
      const pending = adapter.commands!.list(context)
      await untilQueried()
      expect(sdk.query).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(10_000)
      resolveUsage({ skills: { count: 1, items: [{ name: 'old', source: 'project' }] } })
      await expect(pending).resolves.toMatchObject({ data: [{ name: 'old' }], observedAt: initializedAt })
      await expect(adapter.skills!.list(context)).resolves.toMatchObject({ observedAt: initializedAt })
      await adapter.runControls!.read(context)
      await vi.advanceTimersByTimeAsync(19_999)
      await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [{ name: 'old' }] })
      await vi.advanceTimersByTimeAsync(1)
      await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [{ name: 'fresh' }] })
      expect(sdk.query).toHaveBeenCalledTimes(2)
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for active old catalog reads at expiry and coalesces replacement initialization', async () => {
    vi.useFakeTimers()
    try {
      let resolveUsage: (usage: unknown) => void = () => {}
      const oldUsage = new Promise((resolve) => { resolveUsage = resolve })
      const oldControl = {
        initializationResult: vi.fn().mockResolvedValue({}),
        getContextUsage: vi.fn().mockReturnValue(oldUsage),
        supportedCommands: vi.fn().mockResolvedValue([{ name: 'old', description: 'Old', argumentHint: '' }]),
        close: sdk.close
      }
      const freshControl = {
        initializationResult: vi.fn().mockResolvedValue({}),
        getContextUsage: vi.fn().mockResolvedValue({ skills: { count: 1, items: [{ name: 'fresh', source: 'project' }] } }),
        supportedCommands: vi.fn().mockResolvedValue([{ name: 'fresh', description: 'Fresh', argumentHint: '' }]),
        close: sdk.close
      }
      sdk.query.mockReturnValueOnce(oldControl).mockReturnValueOnce(freshControl)
      const adapter = createQoderAdapter()
      const context = { providerId: 'qoder' as const, cwd: '/repo' }
      const oldRead = adapter.commands!.list(context)
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(30_000)
      const firstFreshRead = adapter.commands!.list(context)
      const secondFreshRead = adapter.commands!.list(context)
      await Promise.resolve()
      await Promise.resolve()
      expect(sdk.close).not.toHaveBeenCalled()
      resolveUsage({ skills: { count: 1, items: [{ name: 'old', source: 'project' }] } })
      await expect(oldRead).resolves.toMatchObject({ data: [{ name: 'old' }] })
      await expect(firstFreshRead).resolves.toMatchObject({ data: [{ name: 'fresh' }] })
      await expect(secondFreshRead).resolves.toMatchObject({ data: [{ name: 'fresh' }] })
      expect(sdk.query).toHaveBeenCalledTimes(2)
      expect(sdk.close).toHaveBeenCalledOnce()
      await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [{ name: 'fresh' }] })
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, 1, 2, 3, 4, 5, 6])('honors a refresh barrier established during acquisition (microtask offset %s)', async (offset) => {
    vi.useFakeTimers()
    let releaseUsage!: (value: unknown) => void
    let releaseClose!: () => void
    const usage = new Promise((resolve) => { releaseUsage = resolve })
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    const old = {
      initializationResult: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockReturnValue(usage),
      supportedCommands: vi.fn().mockResolvedValue([]),
      getAvailableModels: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockReturnValue(closing)
    }
    sdk.query.mockReturnValueOnce(old).mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([]),
      getAvailableModels: vi.fn().mockResolvedValue([]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }
    try {
      await adapter.runControls!.read(context)
      const active = adapter.skills!.list(context)
      await vi.advanceTimersByTimeAsync(30_000)
      const refresh = adapter.commands!.list(context)
      for (let index = 0; index < offset; index++) await Promise.resolve()
      const acquisition = adapter.runControls!.read(context)
      await vi.advanceTimersByTimeAsync(0)
      expect(sdk.query).toHaveBeenCalledOnce()
      expect(old.close).not.toHaveBeenCalled()
      releaseUsage({ skills: { count: 0, items: [] } })
      await active
      await vi.advanceTimersByTimeAsync(0)
      expect(old.close).toHaveBeenCalledOnce()
      expect(sdk.query).toHaveBeenCalledOnce()
      releaseClose()
      await Promise.all([refresh, acquisition])
      expect(sdk.query).toHaveBeenCalledTimes(2)
    } finally {
      releaseUsage({ skills: { count: 0, items: [] } })
      releaseClose()
      await adapter.dispose?.()
      vi.useRealTimers()
    }
  })

  it('reports a failed SDK close through dispose instead of claiming clean disposal', async () => {
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getAvailableModels: vi.fn().mockResolvedValue([]),
      close
    })
    const adapter = createQoderAdapter()
    await adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
    expect(close).not.toHaveBeenCalled()
    await expect(adapter.dispose?.()).rejects.toThrow('close failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains a rejected close and blocks replacement queries and disposal', async () => {
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getAvailableModels: vi.fn().mockResolvedValue([]),
      close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }
    await adapter.runControls!.read(context)
    await expect(adapter.invalidateContext?.(context)).rejects.toThrow('close failed')
    expect(sdk.query).toHaveBeenCalledOnce()
    await expect(adapter.runControls!.read(context)).resolves.toMatchObject({
      state: 'degraded',
      reason: 'close failed'
    })
    expect(sdk.query).toHaveBeenCalledOnce()
    await expect(adapter.dispose?.()).rejects.toThrow('close failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('starts SDK close immediately when disposal races a pending model read', async () => {
    let resolveModels: (models: unknown[]) => void = () => {}
    const models = new Promise<unknown[]>((resolve) => { resolveModels = resolve })
    const close = vi.fn().mockResolvedValue(undefined)
    const getAvailableModels = vi.fn().mockReturnValue(models)
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getAvailableModels,
      close
    })
    const adapter = createQoderAdapter()
    const pending = adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
    const disposing = adapter.dispose?.()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    resolveModels([])
    await disposing
    await expect(pending).resolves.toMatchObject({ data: { models: [] } })
    expect(getAvailableModels).toHaveBeenCalledOnce()
  })

  it('does not dispatch a model read on a session retired during initialization', async () => {
    let resolveInitialization: (value: unknown) => void = () => {}
    const initialization = new Promise((resolve) => { resolveInitialization = resolve })
    const getAvailableModels = vi.fn().mockResolvedValue([])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockReturnValue(initialization),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }
    const pending = adapter.runControls!.read(context)
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
    await expect(adapter.invalidateContext?.(context)).resolves.toBeUndefined()
    resolveInitialization({})
    await expect(pending).resolves.toMatchObject({ state: 'degraded' })
    expect(getAvailableModels).not.toHaveBeenCalled()
  })

  it('does not create an uninvalidated replacement when refresh races invalidation', async () => {
    vi.useFakeTimers()
    try {
      let resolveUsage: (usage: unknown) => void = () => {}
      const usage = new Promise((resolve) => { resolveUsage = resolve })
      let resolveClose: () => void = () => {}
      const closeResult = new Promise<void>((resolve) => { resolveClose = resolve })
      const close = vi.fn().mockReturnValue(closeResult)
      const oldControl = {
        initializationResult: vi.fn().mockResolvedValue({}),
        getContextUsage: vi.fn()
          .mockResolvedValueOnce({ skills: { count: 1, items: [{ name: 'old', source: 'project' }] } })
          .mockReturnValue(usage),
        supportedCommands: vi.fn().mockResolvedValue([{ name: 'old', description: 'Old', argumentHint: '' }]),
        close
      }
      sdk.query.mockReturnValue(oldControl)
      const adapter = createQoderAdapter()
      const context = { providerId: 'qoder' as const, cwd: '/repo' }
      await adapter.commands!.list(context)
      await vi.advanceTimersByTimeAsync(1_000)
      const activeSkills = adapter.skills!.list(context)
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(29_000)
      const refreshing = adapter.commands!.list(context)
      const invalidation = adapter.invalidateContext?.(context)
      await Promise.resolve()
      expect(sdk.query).toHaveBeenCalledOnce()
      resolveUsage({ skills: { count: 1, items: [{ name: 'old', source: 'project' }] } })
      await activeSkills
      resolveClose()
      await invalidation
      await expect(refreshing).resolves.toMatchObject({ state: 'unknown' })
      expect(sdk.query).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
