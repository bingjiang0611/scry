import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScryApi } from './index'

type IpcListener = (event: unknown, ...args: unknown[]) => void

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn((_name: string, _api: unknown): void => undefined),
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined),
  on: vi.fn((_channel: string, _listener: IpcListener): void => undefined),
  removeListener: vi.fn((_channel: string, _listener: IpcListener): void => undefined),
  send: vi.fn((_channel: string, ..._args: unknown[]): void => undefined)
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send
  }
}))

await import('./index')

const exposed = electron.exposeInMainWorld.mock.calls[0]
if (!exposed) throw new Error('preload did not expose an API')
const api = exposed[1] as ScryApi
const callableApi = api as unknown as Record<string, (...args: unknown[]) => unknown>

const invokeChannels = {
  setTheme: 'app:setTheme',
  detectFast: 'agent:detectFast',
  detect: 'agent:detect',
  addPiProfile: 'agent:addPiProfile',
  removePiProfile: 'agent:removePiProfile',
  providerDescriptors: 'agent:providerDescriptors',
  recentFolders: 'agent:recentFolders',
  removeRecentFolder: 'agent:removeRecentFolder',
  chooseFolder: 'agent:chooseFolder',
  clipboardImage: 'agent:clipboardImage',
  workspaceList: 'workspace:list',
  workspaceRead: 'workspace:read',
  workspaceReadKnown: 'workspace:readKnown',
  workspaceOpenExternal: 'workspace:openExternal',
  workspaceOpenKnownExternal: 'workspace:openKnownExternal',
  workspaceWrite: 'workspace:write',
  workspaceCreate: 'workspace:create',
  workspaceRename: 'workspace:rename',
  workspaceMove: 'workspace:move',
  workspaceTrash: 'workspace:trash',
  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalReady: 'terminal:ready',
  terminalAck: 'terminal:ack',
  terminalClose: 'terminal:close',
  setCwd: 'agent:setCwd',
  newSession: 'agent:newSession',
  invalidateProviderContext: 'agent:invalidateProviderContext',
  listSessions: 'agent:listSessions',
  listProjects: 'agent:listProjects',
  setProjectPinned: 'agent:setProjectPinned',
  renameProject: 'agent:renameProject',
  removeProject: 'agent:removeProject',
  revealProject: 'agent:revealProject',
  listArchivedSessions: 'agent:listArchivedSessions',
  catalogHealth: 'agent:catalogHealth',
  listSkills: 'agent:listSkills',
  mcpSnapshot: 'agent:mcpSnapshot',
  mcpGuardScan: 'agent:mcpGuardScan',
  testMcp: 'agent:testMcp',
  reauthenticateMcp: 'agent:reauthenticateMcp',
  listCommands: 'agent:listCommands',
  runControls: 'agent:runControls',
  usageStats: 'agent:usageStats',
  stats: 'agent:stats',
  usageAnalytics: 'agent:usageAnalytics',
  billingState: 'agent:billingState',
  syncBillingAdmin: 'agent:syncBillingAdmin',
  importBillingFixture: 'agent:importBillingFixture',
  gitDiff: 'agent:gitDiff',
  loadSession: 'agent:loadSession',
  loadSessionOlder: 'agent:loadSessionOlder',
  deleteSession: 'agent:deleteSession',
  setSessionPinned: 'agent:setSessionPinned',
  setSessionArchived: 'agent:setSessionArchived',
  deleteArchivedSessions: 'agent:deleteArchivedSessions',
  start: 'agent:start',
  activeRun: 'agent:activeRun',
  activeRuns: 'agent:activeRuns',
  focusedRunSnapshot: 'agent:focusedRunSnapshot',
  focusRun: 'agent:focusRun',
  adoptActiveRun: 'agent:adoptActiveRun',
  answerQuestion: 'agent:answerQuestion',
  stop: 'agent:stop',
  traceResynchronized: 'agent:traceResynchronized'
} as const satisfies Partial<Record<keyof ScryApi, string>>

const listenerChannels = {
  onTrace: 'agent:trace',
  onTraceHealth: 'agent:traceHealth',
  onTerminalData: 'terminal:data',
  onTerminalExit: 'terminal:exit',
  onTurnDone: 'agent:turnDone',
  onStopState: 'agent:stopState',
  onDataUpdated: 'agent:dataUpdated',
  onSession: 'agent:session',
  onFocusedRun: 'agent:focusedRun',
  onQuestion: 'agent:userQuestion',
  onQuestionClosed: 'agent:userQuestionClosed',
  onError: 'agent:error'
} as const satisfies Partial<Record<keyof ScryApi, string>>

beforeEach(() => {
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue({ data: null })
  electron.on.mockClear()
  electron.removeListener.mockClear()
  electron.send.mockClear()
})

describe('preload IPC boundary', () => {
  it('exposes only the reviewed narrow API and fixed IPC channels', async () => {
    expect(exposed[0]).toBe('scry')
    expect(Object.keys(api).sort()).toEqual([
      'rendererReady',
      ...Object.keys(invokeChannels),
      ...Object.keys(listenerChannels)
    ].sort())

    api.rendererReady()
    expect(electron.send).toHaveBeenCalledWith('app:rendererReady')

    for (const [method, channel] of Object.entries(invokeChannels)) {
      electron.invoke.mockClear()
      await callableApi[method]()
      expect(electron.invoke, method).toHaveBeenCalledTimes(1)
      expect(electron.invoke.mock.calls[0]?.[0], method).toBe(channel)
    }
  })

  it('keeps structured arguments on the main-process side of the bridge', async () => {
    await api.terminalWrite('terminal-1', 'pwd\n')
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:write', { id: 'terminal-1', data: 'pwd\n' })

    await api.terminalResize('terminal-1', 120, 40)
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:resize', { id: 'terminal-1', cols: 120, rows: 40 })

    const context = { providerId: 'codex' as const, cwd: '/repo' }
    await api.mcpSnapshot(context, true)
    expect(electron.invoke).toHaveBeenLastCalledWith('agent:mcpSnapshot', { context, refresh: true })

    await api.testMcp(context, 'server-1')
    expect(electron.invoke).toHaveBeenLastCalledWith('agent:testMcp', { context, targetId: 'server-1' })
  })

  it('registers removable listeners and preserves batched event delivery', () => {
    for (const [method, channel] of Object.entries(listenerChannels)) {
      electron.on.mockClear()
      electron.removeListener.mockClear()
      const cleanup = callableApi[method](vi.fn()) as () => void
      expect(electron.on, method).toHaveBeenCalledTimes(1)
      const listener = electron.on.mock.calls[0]?.[1]
      expect(electron.on.mock.calls[0]?.[0], method).toBe(channel)
      cleanup()
      expect(electron.removeListener).toHaveBeenCalledWith(channel, listener)
    }

    const traceCallback = vi.fn()
    api.onTrace(traceCallback)
    const traceListener = electron.on.mock.calls.at(-1)?.[1]
    electron.invoke.mockClear()
    traceListener?.(null, { events: [{ id: 'one' }, { id: 'two' }], bytes: 1024 })
    expect(traceCallback.mock.calls.map(([event]) => event.id)).toEqual(['one', 'two'])
    // 分发完成后必须回一次 ACK，否则 main 的有界背压会永久停在 high-water。
    expect(electron.invoke).toHaveBeenCalledWith('agent:traceAck', { bytes: 1024 })

    const throwingCallback = vi.fn(() => { throw new Error('renderer 处理失败') })
    api.onTrace(throwingCallback)
    const throwingListener = electron.on.mock.calls.at(-1)?.[1]
    electron.invoke.mockClear()
    expect(() => throwingListener?.(null, { events: [{ id: 'boom' }], bytes: 8 })).toThrow('renderer 处理失败')
    // renderer 回调抛错也要 ACK：否则一次渲染异常会让实时视图永久停更。
    expect(electron.invoke).toHaveBeenCalledWith('agent:traceAck', { bytes: 8 })

    const terminalCallback = vi.fn()
    api.onTerminalData(terminalCallback)
    const terminalListener = electron.on.mock.calls.at(-1)?.[1]
    terminalListener?.(null, [{ id: 'terminal-1', data: 'a' }, { id: 'terminal-1', data: 'b' }])
    expect(terminalCallback.mock.calls.map(([event]) => event.data)).toEqual(['a', 'b'])
  })

  it('rejects malformed mcpguard reports before they reach the renderer', async () => {
    electron.invoke.mockResolvedValueOnce({ data: { summary: 'not-a-report' } })
    await expect(api.mcpGuardScan({ providerId: 'codex', cwd: '/repo' })).rejects.toThrow('无效的 mcpguard 报告')
  })
})
