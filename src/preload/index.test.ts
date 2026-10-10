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
  performanceDiagnosticsEnabled: 'app:performanceDiagnosticsEnabled',
  reportRendererPerformance: 'app:reportRendererPerformance',
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
  workspaceReadPage: 'workspace:readPage',
  workspaceReadKnown: 'workspace:readKnown',
  workspaceReadPageKnown: 'workspace:readPageKnown',
  workspaceOpenExternal: 'workspace:openExternal',
  workspaceOpenKnownExternal: 'workspace:openKnownExternal',
  workspaceWrite: 'workspace:write',
  workspaceCreate: 'workspace:create',
  workspaceRename: 'workspace:rename',
  workspaceMove: 'workspace:move',
  workspaceTrash: 'workspace:trash',
  terminalStart: 'terminal:start',
  terminalActive: 'terminal:active',
  terminalAttach: 'terminal:attach',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalReady: 'terminal:ready',
  terminalAck: 'terminal:ack',
  terminalClose: 'terminal:close',
  terminalRecordingList: 'terminal:recordingList',
  terminalRecordingRead: 'terminal:recordingRead',
  terminalRecordingDelete: 'terminal:recordingDelete',
  setCwd: 'agent:setCwd',
  newSession: 'agent:newSession',
  forkSession: 'agent:forkSession',
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
  llmPerformanceHistory: 'agent:llmPerformanceHistory',
  billingState: 'agent:billingState',
  syncBillingAdmin: 'agent:syncBillingAdmin',
  importBillingFixture: 'agent:importBillingFixture',
  gitDiff: 'agent:gitDiff',
  recorderContentPage: 'agent:recorderContentPage',
  loadSession: 'agent:loadSession',
  loadSessionOlder: 'agent:loadSessionOlder',
  deleteSession: 'agent:deleteSession',
  renameSession: 'agent:renameSession',
  setSessionPinned: 'agent:setSessionPinned',
  setSessionArchived: 'agent:setSessionArchived',
  deleteArchivedSessions: 'agent:deleteArchivedSessions',
  start: 'agent:start',
  activeRun: 'agent:activeRun',
  unreadSessions: 'agent:unreadSessions',
  activeRuns: 'agent:activeRuns',
  focusedRunSnapshot: 'agent:focusedRunSnapshot',
  focusRun: 'agent:focusRun',
  adoptActiveRun: 'agent:adoptActiveRun',
  answerQuestion: 'agent:answerQuestion',
  stop: 'agent:stop',
  stopBackgroundTask: 'agent:stopBackgroundTask',
  traceAck: 'agent:traceAck',
  traceResynchronized: 'agent:traceResynchronized',
  remoteStatus: 'remote:status',
  remoteBeginPairing: 'remote:pairing:begin',
  remoteConfirmPairing: 'remote:pairing:confirm',
  remoteCancelPairing: 'remote:pairing:cancel',
  remoteRevokeDevice: 'remote:device:revoke'
} as const satisfies Partial<Record<keyof ScryApi, string>>

const listenerChannels = {
  onTrace: 'agent:trace',
  onBackgroundWork: 'agent:backgroundWork',
  onTraceHealth: 'agent:traceHealth',
  onTerminalData: 'terminal:data',
  onTerminalExit: 'terminal:exit',
  onTerminalRecordingError: 'terminal:recordingError',
  onTurnDone: 'agent:turnDone',
  onUnreadSessions: 'agent:unreadSessions',
  onStopState: 'agent:stopState',
  onDataUpdated: 'agent:dataUpdated',
  onSession: 'agent:session',
  onFocusedRun: 'agent:focusedRun',
  onRemoteSessionRecorded: 'remote:sessionRecorded',
  onQuestion: 'agent:userQuestion',
  onQuestionAttention: 'agent:questionAttention',
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
    await api.terminalWrite('terminal-1', 3, 'pwd\n')
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:write', { id: 'terminal-1', ownershipEpoch: 3, data: 'pwd\n' })

    await api.terminalResize('terminal-1', 3, 120, 40)
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:resize', { id: 'terminal-1', ownershipEpoch: 3, cols: 120, rows: 40 })
    await api.terminalReady('terminal-1', 3)
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:ready', { id: 'terminal-1', ownershipEpoch: 3 })
    await api.terminalAck('terminal-1', 3, 42)
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:ack', { id: 'terminal-1', ownershipEpoch: 3, bytes: 42 })
    await api.terminalClose('terminal-1', 3)
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:close', { id: 'terminal-1', ownershipEpoch: 3 })

    await api.terminalRecordingList({ after: 'terminal-1', limit: 20 })
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:recordingList', { after: 'terminal-1', limit: 20 })
    await api.terminalRecordingRead({ id: 'terminal-1', offset: 4, limit: 65536 })
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:recordingRead', { id: 'terminal-1', offset: 4, limit: 65536 })

    const contentRef = { storage: 'recorder-content-v1' as const, sha256: 'a'.repeat(64), bytes: 7, encoding: 'utf8' as const }
    await api.recorderContentPage({ ref: contentRef, offset: 2, limit: 4 })
    expect(electron.invoke).toHaveBeenLastCalledWith('agent:recorderContentPage', { ref: contentRef, offset: 2, limit: 4 })
    await api.terminalRecordingDelete('terminal-1')
    expect(electron.invoke).toHaveBeenLastCalledWith('terminal:recordingDelete', { id: 'terminal-1' })

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
    const traceEvents = [{ id: 'one' }, { id: 'two' }]
    const receipt = { generation: 3, batchId: 9, bytes: 1024 }
    traceListener?.(null, { events: traceEvents, ...receipt })
    expect(traceCallback).toHaveBeenCalledTimes(1)
    expect(traceCallback).toHaveBeenCalledWith(traceEvents, receipt)
    // preload only delivers the receipt. Renderer returns it after the batched React commit.
    expect(electron.invoke).not.toHaveBeenCalled()
    void api.traceAck(receipt)
    expect(electron.invoke).toHaveBeenCalledWith('agent:traceAck', receipt)

    const throwingCallback = vi.fn(() => { throw new Error('renderer 处理失败') })
    api.onTrace(throwingCallback)
    const throwingListener = electron.on.mock.calls.at(-1)?.[1]
    electron.invoke.mockClear()
    const throwingBatch = [{ id: 'boom-1' }, { id: 'boom-2' }]
    expect(() => throwingListener?.(null, { events: throwingBatch, generation: 3, batchId: 10, bytes: 8 }))
      .toThrow('renderer 处理失败')
    expect(throwingCallback).toHaveBeenCalledTimes(1)
    expect(electron.invoke).toHaveBeenCalledWith('agent:traceAck', { generation: 3, batchId: 10, bytes: 8 })

    const terminalCallback = vi.fn()
    api.onTerminalData(terminalCallback)
    const terminalListener = electron.on.mock.calls.at(-1)?.[1]
    terminalListener?.(null, [{ id: 'terminal-1', data: 'a' }, { id: 'terminal-1', data: 'b' }])
    expect(terminalCallback.mock.calls.map(([event]) => event.data)).toEqual(['a', 'b'])
  })

  it('does not forward renderer-selected paths to performance history', async () => {
    await callableApi.llmPerformanceHistory('/tmp/renderer-selected-file')
    expect(electron.invoke).toHaveBeenCalledTimes(1)
    expect(electron.invoke).toHaveBeenCalledWith('agent:llmPerformanceHistory')
  })

  it('rejects malformed mcpguard reports before they reach the renderer', async () => {
    electron.invoke.mockResolvedValueOnce({ data: { summary: 'not-a-report' } })
    await expect(api.mcpGuardScan({ providerId: 'codex', cwd: '/repo' })).rejects.toThrow('无效的 mcpguard 报告')
  })
})
