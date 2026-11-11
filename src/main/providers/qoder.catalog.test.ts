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

describe('Qoder provider adapter · Skill, command and model catalogs', () => {
  beforeEach(() => resetQoderTestState(t))

  it('reports the SDK Skill catalog as read-only rather than unsupported', async () => {
    await expect(createQoderAdapter().describe()).resolves.toMatchObject({
      id: 'qoder',
      label: 'Qoder',
      transport: 'Qoder Agent SDK',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('reads discovered Skill metadata and normalizes non-user/project sources to unknown', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 3,
          includedSkills: 3,
          skillFrontmatter: [
            { name: 'scry-e2e-audit', source: 'project', tokens: 0 },
            { name: 'browser-use', source: 'user', tokens: 0 },
            { name: 'local-helper', source: 'local', tokens: 0 }
          ]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'scry-e2e-audit', description: 'Repository audit', argumentHint: '' },
        { name: 'browser-use', description: 'Browser control', argumentHint: '' },
        { name: 'local-helper', description: 'Local helper', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.skills!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      mode: 'read',
      state: 'ready',
      data: [
        { name: 'scry-e2e-audit', scope: 'project', description: 'Repository audit', enabled: true },
        { name: 'browser-use', scope: 'user', description: 'Browser control', enabled: true },
        { name: 'local-helper', scope: 'unknown', description: 'Local helper', enabled: true }
      ]
    })
    await adapter.dispose?.()
  })

  it('enables .agents compatibility skills and reads the modern initialization catalog', async () => {
    const initialization = {
      skills: [{
        name: 'kami',
        description: 'Typeset polished documents',
        source: 'project',
        path: '/repo/.agents/skills/kami/SKILL.md'
      }]
    }
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue(initialization),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          count: 1,
          items: [{ name: 'kami', source: 'project', percentageOfContext: 0 }]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'kanban', description: 'Show kanban items', argumentHint: '' },
        { name: 'kami', description: 'Typeset polished documents', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({
      state: 'ready',
      data: [{
        name: 'kami',
        dir: '/repo/.agents/skills/kami/SKILL.md',
        scope: 'project',
        description: 'Typeset polished documents',
        enabled: true
      }]
    })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      state: 'ready',
      data: expect.arrayContaining([expect.objectContaining({ name: 'kami', source: 'skill' })])
    })
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        settings: { skills: { loadFromAgentsDirectory: true } }
      })
    }))
    await adapter.dispose?.()
  })

  it('keeps conflicting legacy and modern totals degraded instead of hiding missing Skills', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name: 'one', description: 'One Skill', source: 'project' }]
      }),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 0,
          includedSkills: 1,
          count: 3,
          items: [{ name: 'one', source: 'project' }]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'one', description: 'One Skill', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('1/3'),
      data: [expect.objectContaining({ name: 'one', dir: '', scope: 'project' })]
    })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('1/3'),
      data: [expect.objectContaining({ name: 'one', source: 'skill' })]
    })
    await adapter.dispose?.()
  })

  it('invalidates same-cwd control and catalog caches for a new session', async () => {
    const control = (name: string) => ({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name, description: `${name} description`, source: 'project' }]
      }),
      getContextUsage: vi.fn().mockResolvedValue({ skills: { count: 1, items: [{ name, source: 'project' }] } }),
      supportedCommands: vi.fn().mockResolvedValue([{ name, description: `${name} description`, argumentHint: '' }]),
      close: sdk.close
    })
    sdk.query.mockReturnValueOnce(control('old-skill')).mockReturnValueOnce(control('new-skill'))
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'old-skill' })] })
    await adapter.invalidateContext?.(context)
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'new-skill' })] })

    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(sdk.close).toHaveBeenCalled()
    await adapter.dispose?.()
  })

  it('does not let an in-flight pre-invalidation catalog read refill Qoder caches', async () => {
    let resolveOldUsage: (usage: unknown) => void = () => {}
    const oldUsage = new Promise((resolve) => { resolveOldUsage = resolve })
    const control = (name: string, usage: Promise<unknown>) => ({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name, description: `${name} description`, source: 'project' }]
      }),
      getContextUsage: vi.fn().mockReturnValue(usage),
      supportedCommands: vi.fn().mockResolvedValue([{ name, description: `${name} description`, argumentHint: '' }]),
      close: sdk.close
    })
    sdk.query
      .mockReturnValueOnce(control('stale-skill', oldUsage))
      .mockReturnValueOnce(control('fresh-skill', Promise.resolve({
        skills: { count: 1, items: [{ name: 'fresh-skill', source: 'project' }] }
      })))
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    const staleRead = adapter.commands!.list(context)
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
    const invalidation = adapter.invalidateContext?.(context)
    resolveOldUsage({ skills: { count: 1, items: [{ name: 'stale-skill', source: 'project' }] } })
    await expect(staleRead).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'stale-skill' })] })
    await invalidation
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'fresh-skill' })]
    })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'fresh-skill' })]
    })
    expect(sdk.query).toHaveBeenCalledTimes(2)
    await adapter.dispose?.()
  })

  it('classifies only catalog-backed Skill commands and leaves other command sources unknown', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'help', description: 'Help', argumentHint: '' },
        { name: 'scry-e2e-audit', description: 'Repository audit', argumentHint: '<path>' },
        { name: 'project-command', description: 'Project command', argumentHint: '' }
      ]),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 1,
          includedSkills: 1,
          skillFrontmatter: [{ name: 'scry-e2e-audit', source: 'project', tokens: 0 }]
        }
      }),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      getUsageInfo: vi.fn().mockResolvedValue(null),
      accountInfo: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.commands!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      state: 'ready',
      data: [
        { name: 'help', source: undefined },
        { name: 'scry-e2e-audit', argumentHint: '<path>', source: 'skill' },
        { name: 'project-command', source: undefined }
      ]
    })
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }) }))
    expect(sdk.close).not.toHaveBeenCalled()
    await adapter.dispose?.()
    expect(sdk.close).toHaveBeenCalledOnce()
  })

  it('keeps commands readable but their sources unknown when the Skill catalog fails', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([{ name: 'help', description: 'Help', argumentHint: '' }]),
      getContextUsage: vi.fn().mockRejectedValue(new Error('catalog unavailable')),
      close: sdk.close
    })
    const adapter = createQoderAdapter()

    await expect(adapter.commands!.list({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('catalog unavailable'),
      data: [{ name: 'help', source: undefined }]
    })
    await adapter.dispose?.()
  })

  it('reads model efforts from the live native Qoder catalog', async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([{
      value: 'performance-live',
      displayName: 'Performance Live',
      description: 'fresh',
      isDefault: true,
      isEnabled: true,
      efforts: ['low', 'high'],
      defaultEffort: 'high'
    }])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        models: [{ value: 'performance-stale', displayName: 'Performance Stale', isEnabled: true }]
      }),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await expect(adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'performance-live' },
          label: 'Performance Live',
          description: 'fresh',
          isDefault: true,
          efforts: [{ id: 'low' }, { id: 'high', isDefault: true }]
        }]
      }
    })
    expect(getAvailableModels).toHaveBeenCalledOnce()
    expect(getAvailableModels).toHaveBeenCalledWith({ fetchStrategy: 'live' })
    await adapter.dispose?.()
  })

  it('keeps a valid empty live catalog instead of falling back to initialization', async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        models: [{ value: 'performance-stale', displayName: 'Performance Stale', isEnabled: true }]
      }),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await expect(adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: { models: [] }
    })
    expect(getAvailableModels).toHaveBeenCalledWith({ fetchStrategy: 'live' })
    await adapter.dispose?.()
  })

  it('uses an ephemeral no-input discovery query and closes it on disposal', async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({ models: [{ value: 'stale' }] }),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })

    expect(sdk.query.mock.calls[0][0].options).toMatchObject({ persistSession: false })
    const prompt = sdk.query.mock.calls[0][0].prompt as AsyncIterable<unknown>
    const nextMessage = prompt[Symbol.asyncIterator]().next()
    await adapter.dispose?.()
    await expect(nextMessage).resolves.toEqual({ value: undefined, done: true })
    expect(sdk.close).toHaveBeenCalledOnce()
  })
})
