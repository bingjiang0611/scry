import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { listRecords, readHealth, safeKey } from './store'
import { recorderSessionLock } from './runtime-state'

const faults = vi.hoisted(() => ({ finalize: false, pendingHealth: false }))
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    commitRecord: (...args: Parameters<typeof actual.commitRecord>) => {
      if (faults.finalize && args[1].sessionId === 's1') throw new Error('injected s1 finalize failure')
      return actual.commitRecord(...args)
    }
  }
})
vi.mock('./runtime-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-state')>()
  return {
    ...actual,
    recorderPendingHealth: (...args: Parameters<typeof actual.recorderPendingHealth>) => {
      if (faults.pendingHealth) throw new Error('injected recovery health failure')
      return actual.recorderPendingHealth(...args)
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.finalize = false
  faults.pendingHealth = false
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-recovery-isolation-'))
  roots.push(root)
  const capture = join(root, 'notifications.jsonl')
  const hook = join(root, 'commit-hook.sh')
  await writeFile(hook, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
  await chmod(hook, 0o700)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'recovery-fixture', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true },
    commitHook: { entry: 'commit-hook.sh', files: ['commit-hook.sh'] }
  }))
  const dataRoot = join(root, '.scry')
  const seed = async (provider: 'claude' | 'codex', sessionId: string) => {
    await handleRecorderHook({
      provider, event: 'UserPromptSubmit', workspace: root, env: {},
      payload: { session_id: sessionId, prompt: sessionId, timestamp: '2026-10-24T12:00:00.000Z' }
    })
    const path = join(dataRoot, 'runtime', provider, safeKey(sessionId), 'open.json')
    const open = JSON.parse(await readFile(path, 'utf8'))
    // Seed an observed terminal boundary; no elapsed-time inference or real Provider is involved.
    await writeFile(path, JSON.stringify({
      ...open, status: 'closing', closingAt: '2026-10-24T12:00:01.000Z',
      terminalAt: '2026-10-24T12:00:01.000Z', terminalAtSource: 'provider_terminal_event'
    }))
    return path
  }
  return { root, dataRoot, capture, seed }
}

async function notifications(path: string): Promise<Array<{ sessionId: string }>> {
  return (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
}

describe('recorder recovery session isolation', () => {
  it('continues after S1 finalize fails, commits S2 and drains its trusted callback', async () => {
    const f = await fixture()
    // runtimeSessions visits Claude before Codex, independent of filesystem entry order.
    const first = await f.seed('claude', 's1')
    await f.seed('codex', 's2')
    faults.finalize = true
    await expect.soft(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 1 })
    expect.soft((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(JSON.parse(await readFile(first, 'utf8')).status).toBe('closing')
    await expect.soft(notifications(f.capture)).resolves.toEqual([expect.objectContaining({ sessionId: 's2' })])
    expect(await readHealth(f.dataRoot)).toMatchObject({
      pendingCount: 1, droppedEvents: 0,
      lastError: { at: expect.any(String), message: expect.stringContaining('s1 finalize failure') }
    })
    expect(await readFile(join(f.dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('s1 finalize failure')
    faults.finalize = false
    await expect(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 0 })
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['s2', 's1'])
  })

  it('counts a live session lock deadline as pending and continues with S2', async () => {
    const f = await fixture()
    await f.seed('claude', 's1')
    await f.seed('codex', 's2')
    const lock = recorderSessionLock(f.dataRoot, 'claude', 's1')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'held-by-test' }))
    await expect(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 1 })
    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(await notifications(f.capture)).toEqual([expect.objectContaining({ sessionId: 's2' })])
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  }, 15_000) // The production session-lock deadline is 10 seconds; do not shorten it in this test.

  it('drains already committed notifications even when the final health refresh throws', async () => {
    const f = await fixture()
    await f.seed('codex', 's2')
    faults.pendingHealth = true
    await expect(recoverRecorder(f.root, {})).rejects.toThrow('injected recovery health failure')
    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(await notifications(f.capture)).toEqual([expect.objectContaining({ sessionId: 's2' })])
  })
})
