import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import {
  clearSessionFailure,
  noteSessionFailure,
  readSessionFailures,
  SESSION_FAILURE_RETRY_MS,
  SESSION_FAILURE_SUSPEND_AFTER,
  TURN_FAILURE_MIN_AGE_MS,
  suspendedSessionKeys
} from './session-failures'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-session-failures-'))
  roots.push(root)
  await mkdir(join(root, 'locks'), { recursive: true })
  await mkdir(join(root, 'logs'), { recursive: true })
  return root
}

describe('the failure ledger suspends a reason, not a session', () => {
  it('suspends after the threshold of identical failures and names them once', async () => {
    const root = await dataRoot()
    const error = new Error('read failed for the same reason')
    for (let attempt = 0; attempt < SESSION_FAILURE_SUSPEND_AFTER; attempt++) {
      await noteSessionFailure(root, 'codex', 'session', error)
    }
    const ledger = await readSessionFailures(root)
    expect(ledger.codex__session.failures).toBe(SESSION_FAILURE_SUSPEND_AFTER)
    expect(ledger.codex__session.suspendedAt).toBeDefined()
    expect(suspendedSessionKeys(ledger).has('codex__session')).toBe(true)

    const log = await readFile(join(root, 'logs', 'recorder.log'), 'utf8')
    expect(log).toContain('session suspended after 3 identical failed passes')
    expect(log).toContain('read failed for the same reason')
    expect(log.trim().split('\n')).toHaveLength(1)
  })

  it.each(['EMFILE', 'ENFILE', 'ENOSPC', 'EAGAIN', 'EBUSY', 'EIO'])('does not count %s in either scope', async (code) => {
    const root = await dataRoot()
    const clock = vi.spyOn(Date, 'now')
    const first = Date.now()
    for (let attempt = 0; attempt < 4; attempt++) {
      clock.mockReturnValue(first + attempt * TURN_FAILURE_MIN_AGE_MS)
      const error = Object.assign(new Error('resource temporarily unavailable'), { code })
      await noteSessionFailure(root, 'codex', 'session', error, 'turn')
      await noteSessionFailure(root, 'codex', 'entry', error)
    }
    expect(await readSessionFailures(root)).toEqual({})
  })

  it('restarts the streak when the failure is a different one', async () => {
    const root = await dataRoot()
    await noteSessionFailure(root, 'codex', 'session', new Error('first reason'))
    await noteSessionFailure(root, 'codex', 'session', new Error('first reason'))
    await noteSessionFailure(root, 'codex', 'session', new Error('second reason'))

    const ledger = await readSessionFailures(root)
    expect(ledger.codex__session.failures).toBe(1)
    expect(ledger.codex__session.suspendedAt).toBeUndefined()
    expect(suspendedSessionKeys(ledger).has('codex__session')).toBe(false)
  })

  it('forgets a session after a pass that finished its work', async () => {
    const root = await dataRoot()
    await noteSessionFailure(root, 'codex', 'session', new Error('transient'))
    await clearSessionFailure(root, 'codex', 'session')
    expect(await readSessionFailures(root)).toEqual({})

    await noteSessionFailure(root, 'codex', 'session', new Error('transient'))
    expect((await readSessionFailures(root)).codex__session.failures).toBe(1)
  })

  it('retries a suspended session once the retry window has passed', async () => {
    const root = await dataRoot()
    const error = new Error('same reason')
    for (let attempt = 0; attempt < SESSION_FAILURE_SUSPEND_AFTER; attempt++) {
      await noteSessionFailure(root, 'codex', 'session', error)
    }
    const ledger = await readSessionFailures(root)
    const suspendedAt = Date.parse(ledger.codex__session.suspendedAt!)
    expect(suspendedSessionKeys(ledger, suspendedAt + SESSION_FAILURE_RETRY_MS - 1).has('codex__session')).toBe(true)
    expect(suspendedSessionKeys(ledger, suspendedAt + SESSION_FAILURE_RETRY_MS + 1).has('codex__session')).toBe(false)
  })
})

describe('a pass that keeps failing the same way stops being work', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'scry-repeated-failure-'))
    roots.push(root)
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'repeated-failure',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
    }))
    const env = { SCRY_RECORDER_SOCKET: join(root, 'r.sock') }
    // A directory is a transcript path that stats fine and can never be opened for reading, so the
    // pass fails the same way every time without depending on permissions or timing.
    const transcript = join(root, 'not-a-file.jsonl')
    await mkdir(transcript, { recursive: true })
    await handleRecorderHook({
      workspace: root,
      provider: 'claude',
      event: 'UserPromptSubmit',
      payload: { session_id: 'repeated', cwd: root, transcript_path: transcript, prompt: 'start' },
      env,
      quiet: true
    })
    return { root, env, dataRootPath: join(root, '.scry') }
  }

  it('leaves quick failures active, then suspends a five-minute streak without closing the turn', async () => {
    const { root, env, dataRootPath } = await fixture()
    const first = Date.now()
    const clock = vi.spyOn(Date, 'now')
    for (let attempt = 0; attempt < 3; attempt++) {
      clock.mockReturnValue(first + attempt * 1_000)
      await recoverRecorder(root, env)
    }
    const quick = await readSessionFailures(dataRootPath)
    const [key] = Object.keys(quick)
    expect(quick[key]).toMatchObject({ scope: 'turn', failures: 3, firstAt: new Date(first).toISOString() })
    expect(suspendedSessionKeys(quick).size).toBe(0)
    clock.mockReturnValue(first + TURN_FAILURE_MIN_AGE_MS - 1)
    await recoverRecorder(root, env)
    expect(suspendedSessionKeys(await readSessionFailures(dataRootPath)).size).toBe(0)
    clock.mockReturnValue(first + TURN_FAILURE_MIN_AGE_MS)
    await recoverRecorder(root, env)

    const ledger = await readSessionFailures(dataRootPath)
    const entry = Object.entries(ledger).find(([key]) => key.startsWith('claude__'))
    expect(entry).toBeDefined()
    expect(entry![1].failures).toBe(5)
    expect(entry![1].suspendedAt).toBeDefined()
    expect(entry![1].lastError).toContain('EISDIR')

    // Suspension is scheduling only: the marker and its open turn survive.
    const providerRoot = join(dataRootPath, 'runtime', 'claude')
    const [sessionDir] = await readdir(providerRoot)
    const open = JSON.parse(await readFile(join(providerRoot, sessionDir, 'open.json'), 'utf8'))
    expect(open.status).toBe('open')

    // A suspended session is no longer visited, so the next pass cannot repeat the same read.
    const before = await readSessionFailures(dataRootPath)
    await recoverRecorder(root, env)
    const after = await readSessionFailures(dataRootPath)
    expect(after[entry![0]].failures).toBe(before[entry![0]].failures)
  })
})
