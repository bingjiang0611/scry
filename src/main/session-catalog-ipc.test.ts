import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { createAppSessionStore, createProjectStore, createRecentFoldersStore } from './app-store'
import { registerSessionCatalogIpc } from './session-catalog-ipc'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-session-catalog-'))
  roots.push(root)
  const appStore = createAppSessionStore(root), projects = createProjectStore(root), recent = createRecentFoldersStore(root)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => unknown>()
  const assertLegacyWriteAllowed = vi.fn(async () => {})
  const showItemInFolder = vi.fn(), requestRunStop = vi.fn(() => true)
  const adopting = new Set<string>()
  let recovery = Promise.resolve()
  const key = (provider: string, cwd: string, session: string, profile?: string) => JSON.stringify([provider, cwd, session, profile])
  const shared = registerSessionCatalogIpc({
    handleTrusted: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler) },
    appSessionStore: () => appStore, projectStore: () => projects, recentStore: () => recent,
    listProjectCatalog: async () => [], showItemInFolder, startupManagedRecovery: () => recovery,
    conversationStore: () => ({ assertLegacyWriteAllowed }), adoptingSessionKeys: adopting,
    providerSessionKey: key, activeRuns: () => [], requestRunStop
  })
  // Module payload/ownership tests only. Production sender/frame/origin wrappers
  // are exercised by the separate conversation ownership App fixture.
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args as never[])
  return { shared, handlers, invoke, projects, recent, appStore, assertLegacyWriteAllowed, showItemInFolder, requestRunStop,
    adopting, key, setRecovery: (promise: Promise<void>) => { recovery = promise } }
}
const ref = { providerId: 'codex' as const, agentProfileId: 'profile-one', cwd: '/synthetic/project space', externalSessionId: 'native-one' }

describe('session catalog IPC extraction', () => {
  it('registers the original eleven channels once without side-effectful startup', async () => {
    const f = await fixture()
    expect([...f.handlers.keys()].sort()).toEqual(['agent:listSessions', 'agent:listProjects', 'agent:catalogHealth',
      'agent:setProjectPinned', 'agent:renameProject', 'agent:removeProject', 'agent:revealProject',
      'agent:renameSession', 'agent:setSessionPinned', 'agent:setSessionArchived', 'agent:listArchivedSessions'].sort())
    expect(f.assertLegacyWriteAllowed).not.toHaveBeenCalled()
    expect(f.requestRunStop).not.toHaveBeenCalled()
  })

  it('keeps project name validation and the original remove-from-both-catalogs effect', async () => {
    const f = await fixture(), cwd = ref.cwd
    f.projects.remember(cwd); f.recent.push(cwd)
    expect(f.invoke('agent:renameProject', cwd, '  Visible name  ')).toBe(true)
    expect(f.projects.load()[0].name).toBe('Visible name')
    expect(f.invoke('agent:setProjectPinned', cwd, true)).toBe(true)
    expect(f.projects.load()[0].pinnedAt).toBeGreaterThan(0)
    for (const invalid of ['relative', 5, null]) expect(() => f.invoke('agent:revealProject', invalid)).toThrow()
    expect(f.showItemInFolder).not.toHaveBeenCalled()
    expect(() => f.invoke('agent:renameProject', cwd, ' ')).toThrow()
    expect(f.invoke('agent:removeProject', cwd)).toBe(true)
    expect(f.projects.load()[0].removedAt).toBeGreaterThan(0)
    expect(f.recent.load()).not.toContain(cwd)
  })

  it('reads the current recovery barrier instead of a registration-time snapshot', async () => {
    const f = await fixture(), pin = vi.spyOn(f.appStore, 'setPinned')
    let release!: () => void
    f.setRecovery(new Promise<void>(resolve => { release = resolve }))
    const pending = f.invoke('agent:setSessionPinned', ref, true)
    await Promise.resolve()
    expect(f.assertLegacyWriteAllowed).not.toHaveBeenCalled()
    expect(pin).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toBe(false) // There is no session in this temporary catalog.
    expect(f.assertLegacyWriteAllowed).toHaveBeenCalledExactlyOnceWith({ ...ref, nativeSessionId: ref.externalSessionId })
    expect(pin).toHaveBeenCalledExactlyOnceWith(ref, true)
  })

  it('shares the live ownership fence between local handlers and remote metadata calls', async () => {
    const f = await fixture(), pin = vi.spyOn(f.appStore, 'setPinned'), remoteChange = vi.fn(() => true)
    f.assertLegacyWriteAllowed.mockRejectedValue(new Error('Synthetic canonical owner fence'))
    await expect(f.invoke('agent:setSessionPinned', ref, true)).rejects.toThrow('canonical owner fence')
    await expect(f.shared.changeLegacySessionMetadata(ref, remoteChange)).rejects.toThrow('canonical owner fence')
    expect(pin).not.toHaveBeenCalled(); expect(remoteChange).not.toHaveBeenCalled()
    f.assertLegacyWriteAllowed.mockResolvedValue(undefined)
    f.adopting.add(f.key(ref.providerId, ref.cwd, ref.externalSessionId, ref.agentProfileId))
    await expect(f.invoke('agent:setSessionPinned', ref, true)).rejects.toThrow('正在迁移')
    await expect(f.shared.changeLegacySessionMetadata(ref, remoteChange)).rejects.toThrow('正在迁移')
    expect(pin).not.toHaveBeenCalled(); expect(remoteChange).not.toHaveBeenCalled()
  })

  it('retains legacy-unknown handling and rejects invalid metadata before store mutation', async () => {
    const f = await fixture(), pin = vi.spyOn(f.appStore, 'setPinned')
    expect(f.shared.sessionRefFromRequest({ ...ref, providerId: 'forged' })).toBeNull()
    for (const [channel, payload] of [['agent:setSessionPinned', 'true'], ['agent:setSessionArchived', 1]] as const) {
      expect(() => f.invoke(channel, ref, payload)).toThrow()
    }
    expect(() => f.invoke('agent:renameSession', { ...ref, cwd: undefined }, 'name')).toThrow()
    expect(pin).not.toHaveBeenCalled()
    const change = vi.fn(() => true)
    await expect(f.shared.changeLegacySessionMetadata({ ...ref, providerId: 'legacy_unknown' }, change)).resolves.toBe(true)
    expect(change).toHaveBeenCalledOnce()
    expect(f.assertLegacyWriteAllowed).not.toHaveBeenCalled()
  })
})
