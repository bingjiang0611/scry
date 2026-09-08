import { describe, expect, it, vi } from 'vitest'
import { applySessionArchiveEffects } from './App'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  return {
    archive: vi.fn(async () => true),
    archivingActiveSession: true,
    activeSessionBusy: false,
    rememberUndo: vi.fn(),
    resetConversation: vi.fn(async (): Promise<void> => undefined),
    reloadProjects: vi.fn()
  }
}

describe('archive success refreshes the sidebar independently of conversation reset', () => {
  it('refreshes while reset/provider catalog refresh remains blocked', async () => {
    const effects = fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    effects.resetConversation.mockImplementation(() => { entered.resolve(); return release.promise })
    const operation = applySessionArchiveEffects(effects)
    try {
      await entered.promise
      expect(effects.rememberUndo).toHaveBeenCalledOnce()
      expect(effects.reloadProjects).toHaveBeenCalledOnce()
      expect(effects.reloadProjects.mock.invocationCallOrder[0]).toBeLessThan(effects.resetConversation.mock.invocationCallOrder[0])
    } finally { release.resolve(); await operation }
  })

  it('still refreshes and preserves undo when reset/provider refresh rejects', async () => {
    const effects = fixture()
    effects.resetConversation.mockRejectedValue(new Error('catalog unavailable'))
    await expect(applySessionArchiveEffects(effects)).rejects.toThrow('catalog unavailable')
    expect(effects.reloadProjects).toHaveBeenCalledOnce()
    expect(effects.rememberUndo).toHaveBeenCalledOnce()
  })

  it('does not hide a session optimistically before archive is acknowledged', async () => {
    const effects = fixture()
    const ack = deferred<boolean>()
    effects.archive.mockReturnValue(ack.promise)
    const operation = applySessionArchiveEffects(effects)
    expect(effects.reloadProjects).not.toHaveBeenCalled()
    expect(effects.resetConversation).not.toHaveBeenCalled()
    expect(effects.rememberUndo).not.toHaveBeenCalled()
    ack.resolve(true)
    await operation
    expect(effects.reloadProjects).toHaveBeenCalledOnce()
  })

  it.each(['not found', 'write rejected'] as const)('preserves the view and list if archive is %s', async (failure) => {
    const effects = fixture()
    if (failure === 'not found') effects.archive.mockResolvedValue(false)
    else effects.archive.mockRejectedValue(new Error('write rejected'))
    if (failure === 'not found') await applySessionArchiveEffects(effects)
    else await expect(applySessionArchiveEffects(effects)).rejects.toThrow('write rejected')
    expect(effects.reloadProjects).not.toHaveBeenCalled()
    expect(effects.resetConversation).not.toHaveBeenCalled()
    expect(effects.rememberUndo).not.toHaveBeenCalled()
  })

  it.each(['background session', 'running current session'] as const)('removes %s from the list without resetting the current conversation', async (scenario) => {
    const effects = fixture()
    effects.archivingActiveSession = scenario !== 'background session'
    effects.activeSessionBusy = scenario === 'running current session'
    await applySessionArchiveEffects(effects)
    expect(effects.reloadProjects).toHaveBeenCalledOnce()
    expect(effects.rememberUndo).toHaveBeenCalledOnce()
    expect(effects.resetConversation).not.toHaveBeenCalled()
  })
})
