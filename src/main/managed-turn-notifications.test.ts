import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { recoverManagedRecorderTurns } from '../core/turn-recorder/managed'
import { listRecords } from '../core/turn-recorder/store'
import { commitManagedTraceTurn, persistManagedTraceProgress, recoverManagedTraceTurns, type ManagedTraceTurnCommitInput } from './managed-turn-commit'
import { readTraceArchive } from './transcript-archive'

// Mock only the downstream delivery boundary. Locks, canonical records, archive and
// coordinator journal are real temporary files; no real callback or Provider can run.
const mock = vi.hoisted(() => ({ drain: vi.fn() }))
vi.mock('../core/turn-recorder/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/turn-recorder/store')>(), drainCommitNotifications: mock.drain
}))
const idle = { delivered: 0, pending: 0, truncated: false }
const roots: string[] = []
beforeEach(() => { mock.drain.mockReset().mockResolvedValue(idle) })
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation waited on a deliberately blocked notification')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-notification-order-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'fixture', dataDir: '.scry', repositories: { mode: 'workspace-only' } }))
  const timing = { startedAt: '2026-09-08T00:00:00.000Z', completedAt: '2026-09-08T00:00:01.000Z', durationMs: 1000 }
  const items: ManagedTraceTurnCommitInput['turn']['items'] = [
    { id: 'assistant', runId: 'run-1', ts: timing.completedAt, kind: 'model', stage: 'text_delta', text: 'fixture response' },
    { id: 'result', runId: 'run-1', ts: timing.completedAt, kind: 'harness', stage: 'result', durationMs: 1000 }
  ]
  const input: ManagedTraceTurnCommitInput = {
    userDataDir: join(root, 'userData'), cwd: root, sessionId: 'session-1', providerTurnId: 'turn-1', providerId: 'codex', runtimeProvider: 'codex_cli', timing, status: 'completed',
    turn: { runId: 'run-1', providerTurnId: 'turn-1', userText: 'fixture', items, turnEvidence: aggregateTurnEvidence({ userText: 'fixture', events: items, source: 'scry_provider_adapter' }), done: true, status: 'completed', ...timing, ts: Date.parse(timing.completedAt) }
  }
  return { root, input }
}

function blockDrain() {
  const entered = deferred<{ dataRoot: string; recordCount: number }>()
  const release = deferred<void>()
  mock.drain.mockImplementation(async (dataRoot: string) => {
    entered.resolve({ dataRoot, recordCount: (await listRecords(dataRoot)).length })
    await release.promise
    return idle
  })
  return { entered, release }
}

async function artifacts(userData: string, dir: string) {
  try { return (await readdir(join(userData, dir))).filter((name) => name.endsWith('.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

describe('notification delivery is outside App durable terminal completion', () => {
  it.each(['live', 'journal replay'] as const)('%s returns and cleans artifacts while delivery is still blocked', async (route) => {
    const { root, input } = await fixture()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', managed: true, workspace: root, env: {}, payload: { session_id: input.sessionId, turn_id: 'turn-1', prompt: 'fixture', timestamp: input.timing.startedAt } })
    await persistManagedTraceProgress(input)
    if (route === 'journal replay') {
      await expect(commitManagedTraceTurn(input, { waitMs: 0, removeArtifact: async () => { throw new Error('crash after canonical commit') } })).rejects.toThrow('crash after canonical commit')
      expect(await artifacts(input.userDataDir, 'managed-turn-commits')).toHaveLength(1)
    }
    const gate = blockDrain()
    const operation = route === 'live' ? commitManagedTraceTurn(input, { waitMs: 0 }) : recoverManagedTraceTurns(input.userDataDir, { cwd: root, waitMs: 0 })
    void operation.catch(() => undefined)
    try {
      expect(await bounded(gate.entered.promise)).toEqual({ dataRoot: join(root, '.scry'), recordCount: 1 })
      const result = await bounded<Awaited<typeof operation>>(operation)
      expect(result).toMatchObject(route === 'live' ? { recorder: 'committed' } : { recovered: 1, pending: 0, errors: [] })
      expect(await artifacts(input.userDataDir, 'managed-turn-commits')).toEqual([])
      expect(await artifacts(input.userDataDir, 'managed-turn-progress')).toEqual([])
      expect(readTraceArchive({ userDataDir: input.userDataDir, cwd: root, sessionId: input.sessionId, providerId: 'codex' })?.turns).toHaveLength(1)
      expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
      // The process-level delivery failure must not resurrect journals or erase durable evidence.
      gate.release.reject(new Error('downstream unavailable'))
      await setImmediate()
      expect(await artifacts(input.userDataDir, 'managed-turn-commits')).toEqual([])
      expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
    } finally {
      gate.release.resolve()
      await operation.catch(() => undefined)
      await setImmediate()
    }
  })

  it.each(['await', 'detach'] as const)('core recovery %s independently honors delivery policy and bounded batch options', async (delivery) => {
    const { root } = await fixture()
    const gate = blockDrain()
    const env = { SCRY_TEST_NOTIFICATION_SCOPE: 'fixture' }
    let settled = false
    const operation = recoverManagedRecorderTurns(root, env, delivery === 'detach' ? { commitNotifications: 'detach' } : {}).finally(() => { settled = true })
    void operation.catch(() => undefined)
    try {
      expect(await bounded(gate.entered.promise)).toMatchObject({ recordCount: 0 })
      expect(mock.drain).toHaveBeenLastCalledWith(join(root, '.scry'), env, { maxRecords: 8, budgetMs: 1500 })
      if (delivery === 'detach') expect(await bounded(operation)).toEqual({ recovered: 0, pending: 0 })
      else {
        await setImmediate() // Event-loop fence, not a wall-clock speed assertion.
        expect(settled).toBe(false)
      }
      gate.release.reject(new Error('delivery rejected'))
      if (delivery === 'await') await expect(operation).rejects.toThrow('delivery rejected')
      else await setImmediate() // Flush the detached rejection handler before fixture cleanup.
    } finally {
      gate.release.resolve()
      await operation.catch(() => undefined)
      await setImmediate()
    }
  })
})
