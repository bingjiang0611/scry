import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('../db', () => ({
  billingStateQuery: vi.fn(), importBillingFixture: vi.fn(), syncBillingAdmin: vi.fn(),
  statsQuery: vi.fn(), usageAnalyticsQuery: vi.fn(), usageAnalyticsWithCreditsQuery: vi.fn()
}))

const { handleRecorderHook } = await import('../../core/turn-recorder/recorder')
const { listRecords } = await import('../../core/turn-recorder/store')
const { writeRecorderContentCopies } = await import('../../core/turn-recorder/content-store')
const { appTraceContentRoot } = await import('../trace-tool-content')
const { providerCommandChannelHandlers, recorderContentChannelHandlers } = await import('./query-channels')
const { registerAgentRuntimeHandlers } = await import('./agent-runtime-ipc')
const { registerProviderHandlers } = await import('./provider-handlers')
const { gateDaemonChannel, installDaemonChannelForwarder } = await import('../daemon-channel-gate')

// Recorder content pages and the Provider command catalog, which main registers and the
// daemon serves as local ops (B4-L4). Recorder content is read for the window's workspace:
// main takes it from its own selection, never from a renderer argument.

type Table = Record<string, (...args: unknown[]) => Promise<unknown>>
const dirs: string[] = []
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'scry-recorder-channels-')); dirs.push(dir); return dir }
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function recordedWorkspace(): Promise<{ root: string; ref: { sha256: string; bytes: number; encoding: string } }> {
  const root = await realpath(tempDir())
  writeFileSync(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'content', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }))
  const payload = (extra: Record<string, unknown>) => ({ session_id: 'session', timestamp: '2026-01-01T00:00:00.000Z', ...extra })
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload({ prompt: 'p' }) })
  await handleRecorderHook({ provider: 'claude', event: 'PreToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'echo' } }) })
  await handleRecorderHook({ provider: 'claude', event: 'PostToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_response: 'recorded body' }) })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload({ assistant_response: 'done' }) })
  const [record] = await listRecords(join(root, '.scry'))
  return { root, ref: record.tools.value![0].outputContent!.contentRef! }
}

const text = (page: unknown): string => Buffer.from((page as { dataBase64: string }).dataBase64, 'base64').toString('utf8')

describe('recorder content channel table', () => {
  it('reads the recorded workspace body only for the workspace the deps name', async () => {
    const { root, ref } = await recordedWorkspace()
    let cwd = root
    const table = recorderContentChannelHandlers({ userDataDir: () => tempDir(), workspace: () => cwd, stillCurrent: () => true }) as Table
    expect(text(await table['agent:recorderContentPage']({ ref }))).toBe('recorded body')
    await expect(table['agent:recorderContentPage']({ ref: { ...ref, sha256: 'a'.repeat(64) } })).rejects.toThrow('recorder_content_not_authorized')
    cwd = ''
    await expect(table['agent:recorderContentPage']({ ref })).rejects.toThrow('recorder_workspace_unavailable')
  })

  it('reads app trace bodies from the bucket of that workspace, none included', async () => {
    const userData = tempDir()
    const ref = await writeRecorderContentCopies([appTraceContentRoot(userData, '/w')], 'trace body', 'utf8')
    const loose = await writeRecorderContentCopies([appTraceContentRoot(userData, '')], 'no workspace', 'utf8')
    let cwd = '/w'
    const table = recorderContentChannelHandlers({ userDataDir: () => userData, workspace: () => cwd, stillCurrent: () => true }) as Table
    expect(text(await table['agent:recorderContentPage']({ source: 'app-trace', ref }))).toBe('trace body')
    await expect(table['agent:recorderContentPage']({ source: 'other', ref })).rejects.toThrow('invalid_content_source')
    cwd = ''
    expect(text(await table['agent:recorderContentPage']({ source: 'app-trace', ref: loose }))).toBe('no workspace')
    await expect(table['agent:recorderContentPage']({ source: 'app-trace', ref })).rejects.toThrow()
  })

  it('refuses an answer for a workspace that is no longer the selection', async () => {
    const { root, ref } = await recordedWorkspace()
    const userData = tempDir()
    const traced = await writeRecorderContentCopies([appTraceContentRoot(userData, root)], 'trace body', 'utf8')
    const stillCurrent = vi.fn(() => false)
    const table = recorderContentChannelHandlers({ userDataDir: () => userData, workspace: () => root, stillCurrent }) as Table
    await expect(table['agent:recorderContentPage']({ ref })).rejects.toThrow('recorder_workspace_changed')
    await expect(table['agent:recorderContentPage']({ source: 'app-trace', ref: traced })).rejects.toThrow('recorder_workspace_changed')
    expect(stillCurrent).toHaveBeenCalledWith(root)
  })

  it('hands the extra argument to the workspace resolver, which main ignores', async () => {
    const workspace = vi.fn(() => '')
    const table = recorderContentChannelHandlers({ userDataDir: () => tempDir(), workspace, stillCurrent: () => true }) as Table
    await expect(table['agent:recorderContentPage']({ ref: { sha256: 'a'.repeat(64), bytes: 1, encoding: 'utf8' } }, '/claimed')).rejects.toThrow('recorder_workspace_unavailable')
    expect(workspace).toHaveBeenCalledWith('/claimed')
  })
})

describe('provider command channel table', () => {
  it('lists commands inside the Provider operation queue and keeps the envelope', async () => {
    const envelope = { providerId: 'pi', agentProfileId: 'pi:1', mode: 'read', state: 'unavailable', data: null, reason: 'not running', observedAt: 1 }
    const listCommands = vi.fn(async () => envelope)
    const withProviderOperation = vi.fn(async (_id: string, operation: () => unknown) => await operation())
    const table = providerCommandChannelHandlers({ providerRegistry: { listCommands } as never, withProviderOperation: withProviderOperation as never }) as Table
    const context = { providerId: 'pi', agentProfileId: 'pi:1' }
    await expect(table['agent:listCommands'](context)).resolves.toBe(envelope)
    expect(withProviderOperation).toHaveBeenCalledWith('pi', expect.any(Function), 'pi:1')
    expect(listCommands).toHaveBeenCalledWith(context)
  })
})

describe('main registers the recorder and command tables', () => {
  it('reads for its own selection and ignores a workspace the renderer names', async () => {
    const { root, ref } = await recordedWorkspace()
    state.userData = tempDir()
    let selection: string | undefined
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const handleTrusted = ((channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, listener) }) as never
    registerAgentRuntimeHandlers({
      handleTrusted, startAppRun: vi.fn(), runs: { activeStates: () => [] } as never, boundedLiveRun: (run) => run,
      dockBadge: {} as never, activeRunSessionKey: () => null, getWindow: () => null,
      getRemoteRunLedgerId: () => undefined, getRemoteHostService: () => null, userQuestionBroker: {} as never,
      resolveKnownProjectDirectory: (cwd) => cwd, getCurrentCwd: () => selection,
      traceOutput: {} as never, requestRunStop: () => true, runTraces: {} as never
    })
    const read = handlers.get('agent:recorderContentPage')!
    await expect(read({}, { ref }, root)).rejects.toThrow('recorder_workspace_unavailable')
    selection = root
    expect(text(await read({}, { ref }, '/elsewhere'))).toBe('recorded body')

    const envelope = { providerId: 'codex', mode: 'read', state: 'unsupported', data: null, reason: 'none' }
    const listCommands = vi.fn(async () => envelope)
    registerProviderHandlers({
      handleTrusted, providerRegistry: { listSkills: vi.fn(), listCommands } as never,
      withProviderOperation: async (_providerId, operation) => await operation(),
      getRemoteProviderDiscovery: () => ({ invalidate: () => undefined }), refreshInvalidatedRemoteProviderMetadata: () => undefined,
      ensureMcpExecutionAuthorized: async () => null, authorizedMcpExecution: () => undefined,
      homeDir: '/home', getCurrentCwd: () => '/w', getRuns: () => ({ activeStates: () => [] }), canonicalProviderCwd: (cwd) => cwd ?? '/w',
      providerOperationKey: () => 'k', providerOperationGate: {} as never
    })
    await expect(handlers.get('agent:listCommands')!({}, { providerId: 'codex' })).resolves.toBe(envelope)
  })

  it('appends the window selection in daemon mode, where the daemon reads', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const handleTrusted = ((channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, gateDaemonChannel(channel, listener, { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv))
    }) as never
    registerAgentRuntimeHandlers({
      handleTrusted, startAppRun: vi.fn(), runs: { activeStates: () => [] } as never, boundedLiveRun: (run) => run,
      dockBadge: {} as never, activeRunSessionKey: () => null, getWindow: () => null,
      getRemoteRunLedgerId: () => undefined, getRemoteHostService: () => null, userQuestionBroker: {} as never,
      resolveKnownProjectDirectory: (cwd) => cwd, getCurrentCwd: () => '/projects/app',
      traceOutput: {} as never, requestRunStop: () => true, runTraces: {} as never, daemon: {} as never
    })
    const forwarded = vi.fn(async () => ({ page: true }))
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      const ref = { sha256: 'a'.repeat(64), bytes: 1, encoding: 'utf8' }
      await expect(handlers.get('agent:recorderContentPage')!({}, { ref })).resolves.toEqual({ page: true })
      expect(forwarded).toHaveBeenCalledWith({ op: 'recorderContent', method: 'recorderContentPage', args: [{ ref }, '/projects/app'], read: true })
    } finally {
      uninstall()
    }
  })
})
