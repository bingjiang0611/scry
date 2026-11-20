import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextAdmission } from '../context-admission'
import { ProviderOperationGate } from '../provider-operation-gate'
import { mcpChannelHandlers, type McpChannelDependencies } from './mcp-channels'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mcp-early-'))
  tempDirs.push(dir)
  return dir
}

function setupCodexMcp(cwd: string): string {
  const bin = join(cwd, 'mcp-bin.sh')
  writeFileSync(bin, '#!/bin/sh\necho ok\n')
  chmodSync(bin, 0o755)
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  writeFileSync(
    join(cwd, '.codex', 'config.toml'),
    `[mcp_servers.local]\ncommand = ${JSON.stringify(bin)}\nargs = ["serve"]\n`
  )
  return bin
}

function mockColdShellEnv(cwd: string) {
  let warmed = false
  let warmPromise: Promise<Record<string, string>> | null = null
  const fallbackEnv: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: cwd }
  const loginEnv: Record<string, string> = { PATH: '/opt/custom/bin:/usr/bin:/bin', HOME: cwd }
  const warmShellEnv = vi.fn(() => {
    if (!warmPromise) {
      warmPromise = new Promise<Record<string, string>>((resolve) => {
        setTimeout(() => {
          warmed = true
          resolve(loginEnv)
        }, 15)
      })
    }
    return warmPromise
  })
  const shellEnv = vi.fn(() => {
    if (!warmed) void warmShellEnv()
    return warmed ? loginEnv : fallbackEnv
  })
  vi.doMock('../claude-locate', async () => {
    const actual = await vi.importActual<typeof import('../claude-locate')>('../claude-locate')
    return { ...actual, warmShellEnv, shellEnv }
  })
  return { warmShellEnv, shellEnv }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../claude-locate')
  vi.doUnmock('../transcript-archive')
  vi.doUnmock('../session-fork')
  vi.doUnmock('../storage-paths')
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('early-startup warmShellEnv ordering for run-fork and mcp-channels (W13 B1)', () => {
  it('prevents spurious rejection in run-fork when shellEnv warms asynchronously mid-startup', async () => {
    const cwd = makeTempDir()
    setupCodexMcp(cwd)
    vi.resetModules()
    const { warmShellEnv } = mockColdShellEnv(cwd)
    vi.doMock('../storage-paths', () => ({ storageUserDataDir: () => cwd }))
    vi.doMock('../transcript-archive', () => ({
      readTraceArchiveAsync: vi.fn(async () => ({
        turns: [{ runId: 'run-1', providerTurnId: 'pt-1', forkTurnId: 'ft-1', userText: 'hi' }]
      }))
    }))
    vi.doMock('../session-fork', () => ({
      verifyForkArchiveBoundary: vi.fn(() => ({
        source: { runId: 'run-1', userText: 'hi' },
        prefix: []
      }))
    }))

    const { createForkOperations } = await import('./run-fork')
    const forkMock = vi.fn(async (input: { mcpExecution?: { fingerprint: string } }) => {
      expect(input.mcpExecution?.fingerprint).toMatch(/^sha256:/)
      return { externalSessionId: 'forked-session-1' }
    })
    const forkHandlers = createForkOperations({
      providerRegistry: {
        get: () => ({ runtimeProvider: 'codex_cli', forkSession: { fork: forkMock } }),
        inspectHookTrust: async () => ({ hooks: [], errors: [] })
      } as never,
      providerOperationGate: new ProviderOperationGate(),
      contextAdmission: new ContextAdmission(),
      providerContextKey: (providerId, dir, profile) => `${providerId}:${profile ?? ''}:${dir}`,
      unsettledRuns: () => [],
      resolveKnownProjectDirectory: (p: string) => p,
      getCurrentCwd: () => cwd,
      getStartupManagedRecovery: async () => undefined,
      assertLegacyConversationWriteAllowed: async () => undefined,
      resetSessionContext: () => undefined,
      sessionByContext: new Map(),
      invalidateSessionHistoryLoad: () => undefined,
      appSessionStore: () => ({ record: () => undefined }) as never,
      rememberProject: () => undefined
    })

    const forkedId = await forkHandlers.forkManagedConversation({
      source: { cwd },
      binding: { providerId: 'codex', nativeSessionId: 'src-1', continuationKey: 'ck-1' },
      turn: { runId: 'run-1', archive: { sessionId: 'src-1' } },
      permissionMode: 'full_access'
    } as never)
    expect(forkedId).toBe('forked-session-1')
    expect(forkMock).toHaveBeenCalledTimes(1)
    expect(warmShellEnv).toHaveBeenCalled()
  })

  it('prevents spurious rejection in mcp-channels (live snapshot & testMcp) on cold shellEnv', async () => {
    const cwd = makeTempDir()
    setupCodexMcp(cwd)
    vi.resetModules()
    const { warmShellEnv } = mockColdShellEnv(cwd)

    const { ensureMcpExecutionAuthorized, authorizedMcpExecution } = await import('./trust')
    const mcpSnapshot = vi.fn(async (_ctx: unknown, _refresh: boolean, exec?: { fingerprint: string }) => {
      expect(exec?.fingerprint).toMatch(/^sha256:/)
      return { providerId: 'codex', mode: 'read', state: 'ready', data: null }
    })
    const testMcp = vi.fn(async (_ctx: unknown, _id: string, exec?: { fingerprint: string }) => {
      expect(exec?.fingerprint).toMatch(/^sha256:/)
      return { providerId: 'codex', mode: 'write', state: 'ready', data: { ok: true } }
    })
    const channels = mcpChannelHandlers({
      providerRegistry: { mcpSnapshot, testMcp } as unknown as McpChannelDependencies['providerRegistry'],
      withProviderOperation: async (_providerId, op) => await op(),
      ensureMcpExecutionAuthorized,
      authorizedMcpExecution,
      homeDir: cwd,
      getRuns: () => ({ activeStates: () => [] }),
      canonicalProviderCwd: (p) => p ?? cwd,
      providerOperationGate: new ProviderOperationGate(),
      openExternal: async () => undefined,
      assertOwner: () => undefined
    })

    // First call enters on genuinely cold shellEnv (warmed === false).
    await expect(channels['agent:mcpSnapshot']({ context: { providerId: 'codex', cwd }, refresh: true }))
      .resolves.toMatchObject({ state: 'ready' })
    expect(warmShellEnv).toHaveBeenCalled()
    expect(mcpSnapshot).toHaveBeenCalledTimes(1)

    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd }, 'live')
    const targetId = snapshot!.targets[0]!.targetId
    await expect(channels['agent:testMcp']({ context: { providerId: 'codex', cwd }, targetId }))
      .resolves.toMatchObject({ state: 'ready' })
    expect(testMcp).toHaveBeenCalledTimes(1)
  })

  it('succeeds on cold module load with real SHELL=/bin/bash without calling warmShellEnv beforehand', async () => {
    const cwd = makeTempDir()
    setupCodexMcp(cwd)
    const prevShell = process.env.SHELL
    process.env.SHELL = '/bin/bash'
    try {
      vi.resetModules()
      const { ensureMcpExecutionAuthorized, authorizedMcpExecution } = await import('./trust')
      const snap = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd }, 'run')
      expect(snap).not.toBeNull()
      const auth = authorizedMcpExecution(snap)
      expect(auth?.fingerprint).toBe(snap?.fingerprint)
    } finally {
      if (prevShell === undefined) delete process.env.SHELL
      else process.env.SHELL = prevShell
    }
  })
})
