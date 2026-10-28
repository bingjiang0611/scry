import type { IpcMainInvokeEvent } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppSessionStore } from './app-store'
import { ProviderRegistry } from './providers/registry'
import {
  invalidateSessionHistoryLoad,
  registerSessionHistoryLoadIpc,
  sessionHistoryCacheKey,
  type SessionHistoryCache,
  type SessionHistoryIpcRegister,
  type SessionHistoryState
} from './session-history-ipc'
import { registerSessionHistoryOlderIpc } from './session-history-older-ipc'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scry-history-ipc-'))
  temporary.push(directory)
  const state: SessionHistoryState = { revision: 0, abortController: null, cache: null }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const register: SessionHistoryIpcRegister = (channel, listener) => {
    handlers.set(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)
  }
  const store = createAppSessionStore(directory)
  const registry = new ProviderRegistry([])
  const providerContextKey = (provider: string, cwd: string, profile?: string) => JSON.stringify([provider, cwd, profile])
  const shared = { register, resolveKnownProjectDirectory: (cwd: string) => cwd, providerContextKey, providerRegistry: registry }
  registerSessionHistoryLoadIpc(state, {
    ...shared, appSessionStore: () => store, userDataDir: () => directory,
    providerSessionKey: (provider, cwd, session, profile) => JSON.stringify([provider, cwd, session, profile]),
    runs: () => ({ unsettledStates: () => [], get: () => undefined }),
    homeDir: directory, isShuttingDown: () => false, dockBadge: { view: () => {} },
    isWindowFocused: () => false, setCurrentCwd: () => {}, sessionByContext: new Map(),
    sessionAliasesByContext: new Map(), bumpSessionRevision: () => {}, rememberProject: () => {}
  })
  registerSessionHistoryOlderIpc(state, shared)
  const context = { providerId: 'codex' as const, cwd: directory, externalSessionId: 'owned-session' }
  const seed = (): SessionHistoryCache => ({ revision: state.revision,
    key: sessionHistoryCacheKey(context, directory, providerContextKey), turns: [], transcriptTurns: [],
    archive: null, context: { userDataDir: directory }, hookConfig: null })
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  return { state, context, seed, invoke }
}

describe('instance-owned session history IPC state', () => {
  it('invalidates only the owning registration, retaining a second empty-but-available page', async () => {
    const first = await fixture(), second = await fixture()
    first.state.cache = first.seed()
    second.state.cache = second.seed()
    const firstController = new AbortController(), secondController = new AbortController()
    first.state.abortController = firstController
    second.state.abortController = secondController
    const secondCache = second.state.cache
    await expect(second.invoke('agent:loadSessionOlder', second.context, { before: 1 })).resolves.toMatchObject({ turns: [], totalTurns: 0 })
    invalidateSessionHistoryLoad(first.state, 'workspace changed')
    expect(firstController.signal.aborted).toBe(true)
    expect(first.state).toMatchObject({ revision: 1, cache: null, abortController: null })
    expect(secondController.signal.aborted).toBe(false)
    expect(second.state.revision).toBe(0)
    expect(second.state.cache).toBe(secondCache)
    await expect(first.invoke('agent:loadSessionOlder', first.context, { before: 1 })).resolves.toBeNull()
    await expect(second.invoke('agent:loadSessionOlder', second.context, { before: 1 })).resolves.toMatchObject({ turns: [], totalTurns: 0 })
    await expect(second.invoke('agent:loadSessionOlder', first.context, { before: 1 })).resolves.toBeNull()
  })

  it('uses the production load listener and real empty catalog without leaking revision or abort state', async () => {
    const first = await fixture(), second = await fixture()
    await expect(first.invoke('agent:loadSession', first.context)).rejects.toThrow('catalog')
    expect(first.state.revision).toBe(1)
    const controller = first.state.abortController
    expect(controller).toBeInstanceOf(AbortController)
    expect(controller!.signal.aborted).toBe(false)
    expect(second.state).toEqual({ revision: 0, cache: null, abortController: null })
    await expect(first.invoke('agent:loadSession', first.context)).rejects.toThrow('catalog')
    expect(controller!.signal.aborted).toBe(true)
    await expect(second.invoke('agent:loadSession', second.context)).rejects.toThrow('catalog')
    expect(second.state.revision).toBe(1)
    expect(first.state.revision).toBe(2)
  })
})
