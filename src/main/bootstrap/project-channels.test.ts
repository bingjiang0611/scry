import { describe, expect, it, vi } from 'vitest'
import {
  piProfileChannelHandlers, projectStoreChannelHandlers, providerContextChannelHandlers,
  recentFolderChannelHandlers, rememberChosenFolder
} from './project-channels'

// The handler tables main registers and the daemon serves as local ops (B4-L4). Main's
// validation and order are the contract; the daemon only gets the same functions.

function stores() {
  const projectStore = { setPinned: vi.fn(() => true), rename: vi.fn(() => true), remove: vi.fn() }
  const recentStore = { remove: vi.fn((dir: string) => ['/kept'].filter((entry) => entry !== dir)) }
  return { projectStore, recentStore, handlers: { ...projectStoreChannelHandlers({ projectStore: () => projectStore, recentStore: () => recentStore }), ...recentFolderChannelHandlers({ recentStore: () => recentStore }) } }
}

describe('project store channels', () => {
  it('validates the project and its arguments before writing', () => {
    const { projectStore, recentStore, handlers } = stores()
    expect(() => handlers['agent:setProjectPinned']('/w', 'yes' as never)).toThrow('无效的项目置顶请求')
    expect(() => handlers['agent:setProjectPinned']('relative', true)).toThrow('无效的项目目录')
    expect(() => handlers['agent:renameProject']('/w', '   ')).toThrow('项目名称必须为 1–120 个字符')
    expect(() => handlers['agent:renameProject']('/w', 'x'.repeat(121))).toThrow('项目名称必须为 1–120 个字符')
    expect(() => handlers['agent:removeProject']('/'.repeat(4_097))).toThrow('无效的项目目录')
    expect(() => handlers['agent:removeRecentFolder'](7 as never)).toThrow('无效的最近目录')
    expect(projectStore.setPinned).not.toHaveBeenCalled()
    expect(projectStore.rename).not.toHaveBeenCalled()
    expect(projectStore.remove).not.toHaveBeenCalled()
    expect(recentStore.remove).not.toHaveBeenCalled()
  })

  it('trims the name, and removing a project also drops it from the recent folders', () => {
    const { projectStore, recentStore, handlers } = stores()
    expect(handlers['agent:renameProject']('/w', '  Name  ')).toBe(true)
    expect(projectStore.rename).toHaveBeenCalledWith('/w', 'Name')
    expect(handlers['agent:removeProject']('/w')).toBe(true)
    expect(projectStore.remove).toHaveBeenCalledWith('/w')
    expect(recentStore.remove).toHaveBeenCalledWith('/w')
    expect(handlers['agent:removeRecentFolder']('/kept')).toEqual([])
  })
})

describe('chosen folder', () => {
  it('remembers the canonical directory after dropping history loads, and nothing on failure', () => {
    const steps: string[] = []
    const deps = {
      canonicalExistingDirectory: (dir: string) => { if (dir === '/missing') throw new Error('gone'); return `${dir}-real` },
      invalidateSessionHistoryLoad: () => { steps.push('invalidate') },
      rememberProject: (dir: string) => { steps.push(`remember ${dir}`) }
    }
    expect(rememberChosenFolder(deps, '/picked')).toBe('/picked-real')
    expect(steps).toEqual(['invalidate', 'remember /picked-real'])
    expect(() => rememberChosenFolder(deps, '/missing')).toThrow('gone')
    expect(() => rememberChosenFolder(deps, 7)).toThrow('无效的工作目录')
    expect(steps).toHaveLength(2)
  })
})

describe('Provider context invalidation', () => {
  it('fills the current workspace, runs inside the Provider operation and always refreshes metadata', async () => {
    const steps: string[] = []
    const providerRegistry = {
      get: vi.fn((id: string) => { if (id === 'nope') throw new Error('unknown provider'); return {} }),
      invalidateContext: vi.fn(async (context: { cwd?: string }) => { steps.push(`invalidate ${context.cwd}`); if (context.cwd === '/bad') throw new Error('adapter failed') })
    }
    const handlers = providerContextChannelHandlers({
      providerRegistry,
      withProviderOperation: async (_id, operation) => { steps.push('queued'); return await operation() },
      invalidateDiscovery: (id) => { steps.push(`discovery ${id}`) },
      refreshInvalidatedMetadata: () => { steps.push('refresh') },
      currentCwd: () => '/current'
    })
    await expect(handlers['agent:invalidateProviderContext']({ providerId: 'codex' })).resolves.toBe(true)
    expect(steps).toEqual(['queued', 'discovery codex', 'invalidate /current', 'refresh'])
    await expect(handlers['agent:invalidateProviderContext']({ providerId: 'codex', cwd: '/bad' })).rejects.toThrow('adapter failed')
    expect(steps.at(-1)).toBe('refresh')
    await expect(handlers['agent:invalidateProviderContext']({ providerId: 'nope' } as never)).rejects.toThrow('unknown provider')
  })
})

describe('Pi profile removal', () => {
  it('accepts only a stored profile id and invalidates Pi metadata', () => {
    const remove = vi.fn()
    const invalidate = vi.fn()
    const handlers = piProfileChannelHandlers({ piProfileStore: () => ({ remove }), invalidateRemoteProviderMetadata: invalidate })
    expect(() => handlers['agent:removePiProfile']('pi:default')).toThrow('无效的 Pi Agent Profile')
    expect(remove).not.toHaveBeenCalled()
    expect(handlers['agent:removePiProfile']('pi:0123456789abcdef')).toBe(true)
    expect(remove).toHaveBeenCalledWith('pi:0123456789abcdef')
    expect(invalidate).toHaveBeenCalledWith('pi')
  })
})
