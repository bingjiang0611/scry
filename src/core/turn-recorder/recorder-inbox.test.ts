import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverRecorder } from './recorder'
import { runScryCli } from '../../cli/scry'
import { readHealth, safeKey } from './store'
import { recorderHasOpenTurn, recorderPendingHealth } from './runtime-state'

const faults = vi.hoisted(() => ({ apply: false, readPath: '', readCode: 'EACCES', attempts: 0 }))
vi.mock('./io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./io')>()
  return {
    ...actual,
    writeJsonAtomic: async (path: string, value: unknown, options?: { sync?: boolean }) => {
      if (path.endsWith('/open.json') && (value as { prompt?: string }).prompt === 'reject first') {
        faults.attempts++
        if (faults.apply) throw new Error('injected inbox apply failure')
      }
      return actual.writeJsonAtomic(path, value, options)
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === faults.readPath) {
        if (faults.readCode === 'ENOENT') await actual.rm(faults.readPath, { force: true })
        throw Object.assign(new Error(`injected ${faults.readCode} reading inbox`), { code: faults.readCode })
      }
      return actual.readFile(...args)
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.apply = false
  faults.readPath = ''
  faults.readCode = 'EACCES'
  faults.attempts = 0
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-inbox-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'inbox-fixture', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const dataRoot = join(root, '.scry')
  const sessionId = 'inbox-session'
  const sessionRoot = join(dataRoot, 'runtime', 'pi', safeKey(sessionId))
  const inbox = join(sessionRoot, 'inbox')
  const failed = join(sessionRoot, 'inbox-failed')
  await mkdir(inbox, { recursive: true })
  const queue = async (index: number, prompt: string) => {
    const name = `${String(Date.now() - 60_000 + index).padStart(15, '0')}-${index}.json`
    const source = JSON.stringify({
      schemaVersion: 1, provider: 'pi', sessionId, event: 'UserPromptSubmit',
      payload: { session_id: sessionId, prompt }, arrivedAt: new Date().toISOString()
    })
    const path = join(inbox, name)
    await writeFile(path, source)
    return { name, path, source }
  }
  return { root, dataRoot, sessionRoot, inbox, failed, queue }
}

// Use production recover/locking/storage, faulting only the specific file operation under test.
describe('recorder inbox failure isolation', () => {
  it('preserves a failed apply verbatim and still applies the next arrival', async () => {
    const f = await fixture()
    const first = await f.queue(1, 'reject first')
    const second = await f.queue(2, 'later succeeds')
    faults.apply = true
    await recoverRecorder(f.root)
    expect(JSON.parse(await readFile(join(f.sessionRoot, 'open.json'), 'utf8')).prompt).toBe('later succeeds')
    expect(await readdir(f.inbox)).not.toContain(second.name)
    expect(await readFile(join(f.failed, first.name), 'utf8')).toBe(first.source)
    expect(JSON.parse(await readFile(join(f.failed, `${first.name}.failure.json`), 'utf8'))).toMatchObject({
      attempts: 1, lastError: 'injected inbox apply failure'
    })
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  })

  it('retries a failed event on the next recover and removes it only after success', async () => {
    const f = await fixture()
    const first = await f.queue(1, 'reject first')
    faults.apply = true
    await recoverRecorder(f.root)
    faults.apply = false
    await recoverRecorder(f.root)
    expect(JSON.parse(await readFile(join(f.sessionRoot, 'open.json'), 'utf8')).prompt).toBe('reject first')
    expect(await readdir(f.failed)).not.toContain(first.name)
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  })

  it('stops after five failed attempts, counts one drop, but retains the evidence and pending warning', async () => {
    const f = await fixture()
    const first = await f.queue(1, 'reject first')
    faults.apply = true
    for (let i = 0; i < 7; i++) await recoverRecorder(f.root)
    expect(faults.attempts).toBe(5)
    expect(await readFile(join(f.failed, first.name), 'utf8')).toBe(first.source)
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(1)
    expect((await recorderPendingHealth(f.dataRoot)).pendingCount).toBe(1)
    // Exhausted evidence remains visible but must not keep an otherwise idle daemon alive forever.
    expect(await recorderHasOpenTurn(f.dataRoot)).toBe(false)
  })

  it.each(['EACCES', 'invalid JSON'] as const)('retains %s instead of deleting it, and does not block the next file', async (failure) => {
    const f = await fixture()
    const first = await f.queue(1, 'unreadable')
    const second = await f.queue(2, 'later succeeds')
    if (failure === 'EACCES') faults.readPath = first.path
    else await writeFile(first.path, '{broken JSON')
    await recoverRecorder(f.root)
    faults.readPath = ''
    expect(JSON.parse(await readFile(join(f.sessionRoot, 'open.json'), 'utf8')).prompt).toBe('later succeeds')
    expect(await readdir(f.inbox)).not.toContain(second.name)
    expect(await readFile(join(f.failed, first.name), 'utf8')).toBe(failure === 'EACCES' ? first.source : '{broken JSON')
    expect((await recorderPendingHealth(f.dataRoot)).pendingCount).toBe(1)
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  })

  it('does not delete a non-ENOENT read failure after a readable first entry', async () => {
    const f = await fixture()
    await f.queue(1, 'readable first')
    const second = await f.queue(2, 'unreadable second')
    faults.readPath = second.path
    await recoverRecorder(f.root)
    faults.readPath = ''
    expect(await readFile(join(f.failed, second.name), 'utf8')).toBe(second.source)
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  })

  it('skips ENOENT without a failure or drop when an entry has disappeared', async () => {
    const f = await fixture()
    await f.queue(1, 'readable first')
    const second = await f.queue(2, 'disappears')
    faults.readPath = second.path
    faults.readCode = 'ENOENT'
    await recoverRecorder(f.root)
    expect(await readdir(f.inbox)).toEqual([])
    expect((await recorderPendingHealth(f.dataRoot)).pendingCount).toBe(0)
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  })

  it('exposes quarantine backlog through real CLI status and doctor checks', async () => {
    const f = await fixture()
    await f.queue(1, 'reject first')
    faults.apply = true
    await recoverRecorder(f.root)
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write)
    expect(await runScryCli(['recorder', 'status', '--workspace', f.root])).toBe(0)
    expect(JSON.parse(output).health.pendingCount).toBe(1)
    output = ''
    expect(await runScryCli(['doctor', '--workspace', f.root])).toBe(5)
    expect(JSON.parse(output).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'turns.pending', status: 'warn' })
    ]))
  })

  it('keeps a quarantine-only session eligible for daemon recovery and counts its pending age', async () => {
    const f = await fixture()
    const first = await f.queue(1, 'reject first')
    faults.apply = true
    await recoverRecorder(f.root)
    expect(await readFile(join(f.failed, first.name), 'utf8')).toBe(first.source)
    expect(await recorderHasOpenTurn(f.dataRoot)).toBe(true)
    const health = await recorderPendingHealth(f.dataRoot)
    expect(health.pendingCount).toBe(1)
    expect(health.oldestPendingAgeMs).toBeGreaterThanOrEqual(60_000)
  })
})
