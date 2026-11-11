import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetQoderTestState } from './qoder.test-support'

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

describe('Qoder provider adapter · control session refresh', () => {
  beforeEach(() => resetQoderTestState(t))

  it('refreshes live models after the TTL while another facet keeps the control alive', async () => {
    vi.useFakeTimers()
    try {
      let resolveUsage: (usage: unknown) => void = () => {}
      const usage = new Promise((resolve) => { resolveUsage = resolve })
      const getAvailableModels = vi.fn()
        .mockResolvedValueOnce([{ value: 'live-before', displayName: 'Before', efforts: [] }])
        .mockResolvedValueOnce([{ value: 'live-after', displayName: 'After', efforts: [] }])
      sdk.query.mockReturnValue({
        initializationResult: vi.fn().mockResolvedValue({
          models: [{ value: 'initialized-stale', displayName: 'Initialized Stale', efforts: [] }]
        }),
        getAvailableModels,
        getContextUsage: vi.fn().mockReturnValue(usage),
        supportedCommands: vi.fn().mockResolvedValue([]),
        close: sdk.close
      })
      const adapter = createQoderAdapter()
      const context = { providerId: 'qoder' as const, cwd: '/repo' }

      await expect(adapter.runControls!.read(context)).resolves.toMatchObject({
        data: { models: [{ model: { id: 'live-before' } }] }
      })
      const skillsRead = adapter.skills!.list(context)
      await vi.waitFor(() => expect(sdk.query.mock.calls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(adapter.runControls!.read(context)).resolves.toMatchObject({
        data: { models: [{ model: { id: 'live-after' } }] }
      })
      expect(getAvailableModels).toHaveBeenCalledTimes(2)
      resolveUsage({ skills: { count: 0, items: [] } })
      await skillsRead
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recache a successful catalog after a failed live refresh', async () => {
    vi.useFakeTimers()
    try {
      const getAvailableModels = vi.fn()
        .mockResolvedValueOnce([{ value: 'live-before', displayName: 'Before', efforts: [] }])
        .mockRejectedValueOnce(new Error('transport closed'))
        .mockResolvedValueOnce([{ value: 'live-after', displayName: 'After', efforts: [] }])
      sdk.query.mockReturnValue({
        initializationResult: vi.fn().mockResolvedValue({ models: [{ value: 'initialized-stale' }] }),
        getAvailableModels,
        close: sdk.close
      })
      const adapter = createQoderAdapter()
      const context = { providerId: 'qoder' as const, cwd: '/repo' }

      await adapter.runControls!.read(context)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(adapter.runControls!.read(context)).resolves.toMatchObject({
        state: 'degraded',
        data: { models: [] },
        reason: 'transport closed'
      })
      await expect(adapter.runControls!.read(context)).resolves.toMatchObject({
        state: 'ready',
        data: { models: [{ model: { id: 'live-after' } }] }
      })
      expect(getAvailableModels).toHaveBeenCalledTimes(3)
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a control session that never initializes and retries with a fresh session', async () => {
    vi.useFakeTimers()
    try {
      sdk.query.mockReturnValueOnce({
        initializationResult: vi.fn().mockReturnValue(new Promise(() => {})),
        close: sdk.close
      })
      const adapter = createQoderAdapter()
      const pending = adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
      await vi.advanceTimersByTimeAsync(20_000)

      await expect(pending).resolves.toMatchObject({
        state: 'degraded',
        data: { models: [] },
        reason: expect.stringContaining('未完成初始化')
      })
      expect(sdk.close).toHaveBeenCalled()

      sdk.query.mockReturnValueOnce({
        initializationResult: vi.fn().mockResolvedValue({
          models: [{ value: 'initialized-stale', displayName: 'Initialized Stale', isEnabled: true, efforts: [] }]
        }),
        getAvailableModels: vi.fn().mockResolvedValue([
          { value: 'ultimate', displayName: 'Ultimate', isEnabled: true, efforts: [] }
        ]),
        close: sdk.close
      })
      const retry = adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
      await vi.advanceTimersByTimeAsync(0)

      await expect(retry).resolves.toMatchObject({
        state: 'ready',
        data: { models: [{ model: { id: 'ultimate' } }] }
      })
      expect(sdk.query).toHaveBeenCalledTimes(2)
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
