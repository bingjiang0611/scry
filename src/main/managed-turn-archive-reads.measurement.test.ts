import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../core/turn-recorder/recorder'

// B1 L1 collector: counts reads of the legacy monolith and the exact per-turn archive while one
// turn commits. Counting happens at the fs boundary, so it measures the real call chain on both
// sides and does not depend on which helper names the implementation uses.
const probe = vi.hoisted(() => ({
  watched: new Set<string>(),
  reads: [] as Array<{ path: string; sync: boolean; bytes: number }>,
  syncStats: 0
}))

function record(path: unknown, sync: boolean, value: unknown): void {
  const key = String(path)
  if (!probe.watched.has(key)) return
  const bytes = typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 0
  probe.reads.push({ path: key, sync, bytes })
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const value = actual.readFileSync(...args)
    record(args[0], true, value)
    return value
  }) as typeof actual.readFileSync
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    if (probe.watched.has(String(args[0]))) probe.syncStats++
    return actual.lstatSync(...args)
  }) as typeof actual.lstatSync
  return { ...actual, readFileSync, lstatSync, default: { ...actual, readFileSync, lstatSync } }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args)
    record(args[0], false, value)
    return value
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

const { canonicalTurnTiming, commitManagedTraceTurn, persistManagedTraceProgress } = await import('./managed-turn-commit')
const { persistTraceTurnProgress, recoverTraceTurnProgress } = await import('./trace-turn-progress')
const { traceArchivePath, traceArchiveTurnPath } = await import('./transcript-archive')

const roots: string[] = []
afterEach(async () => {
  probe.watched.clear()
  probe.reads.length = 0
  probe.syncStats = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const LEGACY_TURNS = 500

async function fixture(enabled: boolean): Promise<{ workspace: string; userDataDir: string; legacy: string; exact: string; legacyBytes: number }> {
  const workspace = await mkdtemp(join(tmpdir(), 'scry-b1-workspace-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'scry-b1-user-data-'))
  roots.push(workspace, userDataDir)
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled,
    workspaceId: 'b1-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  const legacy = traceArchivePath(userDataDir, workspace, 'session-1', 'codex')
  await mkdir(dirname(legacy), { recursive: true })
  const body = JSON.stringify({
    version: 3,
    cwd: workspace,
    sessionId: 'session-1',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    turns: Array.from({ length: LEGACY_TURNS }, (_, index) => ({
      runId: `legacy-${index}`,
      providerTurnId: `legacy-turn-${index}`,
      userText: `legacy ${index} ${'x'.repeat(200)}`,
      items: [],
      done: true,
      status: 'completed',
      ts: index
    }))
  })
  await writeFile(legacy, body)
  const exact = traceArchiveTurnPath(userDataDir, workspace, 'session-1', 'codex', { runId: 'run-1', providerTurnId: 'turn-1' })
  probe.watched.add(legacy)
  probe.watched.add(exact)
  return { workspace, userDataDir, legacy, exact, legacyBytes: Buffer.byteLength(body) }
}

function input(workspace: string, userDataDir: string) {
  const events: TraceEvent[] = [
    { id: 'assistant', ts: '2026-07-29T12:00:05.000Z', runId: 'run-1', kind: 'model', stage: 'text_delta', text: 'ok' },
    { id: 'result', ts: '2026-07-29T12:00:10.000Z', runId: 'run-1', kind: 'harness', stage: 'result', durationMs: 10_000, tokensIn: 1, tokensOut: 1 }
  ]
  const timing = canonicalTurnTiming(events)
  if (!timing) throw new Error('fixture timing missing')
  return {
    userDataDir,
    cwd: workspace,
    sessionId: 'session-1',
    providerTurnId: 'turn-1',
    providerId: 'codex' as const,
    runtimeProvider: 'codex_cli' as const,
    timing,
    status: 'completed' as const,
    turn: {
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      items: events,
      turnEvidence: aggregateTurnEvidence({ userText: '/rate-workflow 1', events, source: 'scry_provider_adapter' }),
      done: true,
      status: 'completed' as const,
      ...timing,
      ts: Date.parse(timing.completedAt)
    }
  }
}

async function startManaged(workspace: string): Promise<void> {
  await handleRecorderHook({
    provider: 'codex',
    event: 'UserPromptSubmit',
    workspace,
    managed: true,
    payload: { session_id: 'session-1', turn_id: 'turn-1', prompt: '1', timestamp: '2026-07-29T12:00:00.000Z' }
  })
}

function summary(scenario: string, paths: { legacy: string; exact: string; legacyBytes: number }) {
  const legacy = probe.reads.filter((read) => read.path === paths.legacy)
  const exact = probe.reads.filter((read) => read.path === paths.exact)
  const result = {
    scenario,
    legacyTurns: LEGACY_TURNS,
    legacyFileBytes: paths.legacyBytes,
    legacyReads: legacy.length,
    legacyBytesRead: legacy.reduce((total, read) => total + read.bytes, 0),
    exactReads: exact.length,
    syncArchiveReads: probe.reads.filter((read) => read.sync).length,
    syncArchiveStats: probe.syncStats
  }
  console.log('B1 archive reads', JSON.stringify(result))
  return result
}

describe('B1 archive reads per committed turn (L1 collector)', () => {
  it('managed commit after mid-turn progress', async () => {
    const paths = await fixture(true)
    const request = input(paths.workspace, paths.userDataDir)
    await startManaged(paths.workspace)
    await persistManagedTraceProgress(request)
    probe.reads.length = 0
    probe.syncStats = 0
    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    expect(summary('managed-with-progress', paths).legacyReads).toBeGreaterThan(0)
  })

  it('managed commit without progress', async () => {
    const paths = await fixture(true)
    await startManaged(paths.workspace)
    probe.reads.length = 0
    probe.syncStats = 0
    await expect(commitManagedTraceTurn(input(paths.workspace, paths.userDataDir))).resolves.toMatchObject({ recorder: 'committed' })
    expect(summary('managed-without-progress', paths).legacyReads).toBeGreaterThan(0)
  })

  it('recorder-disabled commit', async () => {
    const paths = await fixture(false)
    probe.reads.length = 0
    probe.syncStats = 0
    await expect(commitManagedTraceTurn(input(paths.workspace, paths.userDataDir))).resolves.toEqual({ recorder: 'disabled' })
    expect(summary('disabled', paths).legacyReads).toBeGreaterThan(0)
  })

  it('non-managed progress recovery', async () => {
    const paths = await fixture(false)
    const request = input(paths.workspace, paths.userDataDir)
    await persistTraceTurnProgress({
      userDataDir: paths.userDataDir,
      cwd: paths.workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      turn: request.turn
    })
    probe.reads.length = 0
    probe.syncStats = 0
    await expect(recoverTraceTurnProgress(paths.userDataDir)).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    expect(summary('trace-progress-recovery', paths).legacyReads).toBeGreaterThan(0)
  })
})
