import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { listRecords, readHealth, safeKey } from './store'
import { recorderHasOpenTurn, recorderPendingHealth } from './runtime-state'
import { sessionFailureLedgerPath, type SessionFailureLedger } from './session-failures'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-session-suspension-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'suspension-fixture', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const dataRoot = join(root, '.scry')
  // Grants and CLI state belong to this fixture; a real $HOME would leak the runner's own state.
  const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants') }
  /** An open turn that only needs a recovery pass to finalize: its terminal boundary is observed. */
  const seedClosableTurn = async (provider: 'claude' | 'codex', sessionId: string): Promise<string> => {
    await handleRecorderHook({
      provider, event: 'UserPromptSubmit', workspace: root, env,
      payload: { session_id: sessionId, prompt: sessionId, timestamp: '2026-10-24T12:00:00.000Z' }
    })
    const path = join(dataRoot, 'runtime', provider, safeKey(sessionId), 'open.json')
    const open = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({
      ...open, status: 'closing', closingAt: '2026-10-24T12:00:01.000Z',
      terminalAt: '2026-10-24T12:00:01.000Z', terminalAtSource: 'provider_terminal_event'
    }))
    return join(dataRoot, 'runtime', provider, safeKey(sessionId))
  }
  /**
   * A session directory a pass cannot read: a file sits where `turns/` belongs. That is the shape the
   * production workspace hit, and why one entry used to fail the whole pass.
   */
  const unreadableSession = async (key: string): Promise<string> => {
    const dir = join(dataRoot, 'runtime', 'codex', key)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'turns'), 'a file where the quarantine directory belongs')
    await mkdir(join(dataRoot, 'runtime', 'attention'), { recursive: true })
    await writeFile(join(dataRoot, 'runtime', 'attention', `codex__${key}`), '')
    return dir
  }
  return { root, dataRoot, env, seedClosableTurn, unreadableSession }
}

async function ledger(dataRoot: string): Promise<SessionFailureLedger> {
  return JSON.parse(await readFile(sessionFailureLedgerPath(dataRoot), 'utf8')) as SessionFailureLedger
}

const INCREMENTAL = { incremental: true } as const
const BROKEN = '7badf00d-0000-4000-8000-000000000000'

describe('one unreadable session does not take the recovery pass with it', () => {
  it('finishes the sessions behind the broken one and reports a nonzero recovery count', async () => {
    const f = await fixture()
    await f.seedClosableTurn('codex', 's-healthy')
    await f.unreadableSession(BROKEN)

    await expect(recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL))
      .resolves.toMatchObject({ recovered: 1 })

    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s-healthy'])
    const recorded = await ledger(f.dataRoot)
    expect(Object.keys(recorded)).toEqual([`codex__${BROKEN}`])
    expect(recorded[`codex__${BROKEN}`].failures).toBe(1)
    expect(recorded[`codex__${BROKEN}`].lastError).toContain('ENOTDIR')
  })

  it('keeps pending health readable while one session cannot be read', async () => {
    const f = await fixture()
    await f.seedClosableTurn('codex', 's-healthy')
    await f.unreadableSession(BROKEN)

    await expect(recorderPendingHealth(f.dataRoot)).resolves.toMatchObject({ openTurns: 1, pendingCount: 1 })
    await expect(recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)).resolves.toMatchObject({ recovered: 1 })
    await expect(recorderPendingHealth(f.dataRoot)).resolves.toMatchObject({ openTurns: 0 })
  })
})

describe('a session that repeats the same failure stops being retried', () => {
  it('suspends after three failed passes, logs it once and leaves the evidence alone', async () => {
    const f = await fixture()
    await f.seedClosableTurn('codex', 's-healthy')
    const dir = await f.unreadableSession(BROKEN)

    await expect(recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)).resolves.toMatchObject({ recovered: 1 })
    expect((await ledger(f.dataRoot))[`codex__${BROKEN}`].failures).toBe(1)

    await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    const suspended = (await ledger(f.dataRoot))[`codex__${BROKEN}`]
    expect(suspended.failures).toBe(3)
    expect(suspended.suspendedAt).toEqual(expect.any(String))

    await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    expect((await ledger(f.dataRoot))[`codex__${BROKEN}`]).toEqual(suspended)
    expect(await readHealth(f.dataRoot)).toMatchObject({ suspendedSessions: 1 })

    // Suspension is a report about retries: the session's own evidence is untouched.
    expect(await readFile(join(dir, 'turns'), 'utf8')).toBe('a file where the quarantine directory belongs')
    expect(await readFile(join(f.dataRoot, 'runtime', 'attention', `codex__${BROKEN}`), 'utf8')).toBe('')
    const log = await readFile(join(f.dataRoot, 'logs', 'recorder.log'), 'utf8')
    expect(log.match(/WARN session suspended after 3 failed passes/g)).toHaveLength(1)
  })

  it('retries a suspended session once the hourly window has passed', async () => {
    const f = await fixture()
    await f.seedClosableTurn('codex', 's-healthy')
    await f.unreadableSession(BROKEN)
    for (let pass = 0; pass < 3; pass++) await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    expect((await ledger(f.dataRoot))[`codex__${BROKEN}`].failures).toBe(3)

    const aged = await ledger(f.dataRoot)
    aged[`codex__${BROKEN}`].suspendedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString()
    await writeFile(sessionFailureLedgerPath(f.dataRoot), JSON.stringify(aged))

    await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    const retried = (await ledger(f.dataRoot))[`codex__${BROKEN}`]
    expect(retried.failures).toBe(4)
    expect(Date.parse(retried.suspendedAt!)).toBeGreaterThan(Date.parse(aged[`codex__${BROKEN}`].suspendedAt!))
  })

  it('lets the daemon reach its idle decision when only suspended sessions are left', async () => {
    const f = await fixture()
    await f.seedClosableTurn('codex', 's-healthy')
    await f.unreadableSession(BROKEN)
    for (let pass = 0; pass < 3; pass++) await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)

    // An unreadable session answers "unknown" until it is suspended, which is what kept the
    // recorder resident: this answer has to become `false` on its own.
    await expect(recorderHasOpenTurn(f.dataRoot)).resolves.toBe(false)
  })

  it('forgets the failure record when that session finishes a turn after all', async () => {
    const f = await fixture()
    const dir = await f.seedClosableTurn('codex', 's-heal')
    await rm(join(dir, 'turns'), { recursive: true, force: true })
    await writeFile(join(dir, 'turns'), 'a file where the quarantine directory belongs')

    await recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)
    expect((await ledger(f.dataRoot))[`codex__${safeKey('s-heal')}`].failures).toBeGreaterThanOrEqual(1)

    await rm(join(dir, 'turns'))
    await f.seedClosableTurn('codex', 's-heal')
    await expect(recoverRecorder(f.root, f.env, undefined, undefined, INCREMENTAL)).resolves.toMatchObject({ recovered: 1 })
    expect(await ledger(f.dataRoot)).toEqual({})
  })
})
